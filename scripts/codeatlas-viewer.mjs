#!/usr/bin/env node
// codeatlas-viewer — start / stop / inspect the CodeAtlas viewer. One
// implementation for macOS, Linux and Windows; `codeatlas-viewer` (POSIX sh)
// and `codeatlas-viewer.cmd` are thin shims that run this file.
//
//   codeatlas-viewer start     install deps on first run, start vite on :5173, print URL + paths
//   codeatlas-viewer stop      stop the instance this launcher started (--force: skip the
//                              "is this really our process?" check)
//   codeatlas-viewer restart   stop this launcher's instance and start it again (picks up a plugin update)
//   codeatlas-viewer status    up/down, pid, URL, live dir (exit 1 when down)
//   codeatlas-viewer open      open the viewer in the default browser (starts it if needed)
//   codeatlas-viewer paths     print PLUGIN_ROOT / LIVE_DIR / VALIDATOR / THEME_CSS / URL / LOG
//   codeatlas-viewer install   only install viewer + validator dependencies
//   codeatlas-viewer publish <draft> [--to <name>]
//                              validate a draft graph (a path, or <name> for LIVE_DIR/<name>.json)
//                              and rename it over LIVE_DIR/graph.json — or LIVE_DIR/<name>.json
//                              with --to — in one step; an invalid draft is left where it is
//                              and nothing is published (exit 1)
//
// Graphs live in a DATA dir OUTSIDE the plugin so an update never deletes them:
//   CODEATLAS_DATA      default ~/.codeatlas   live/ (graphs), theme.css, viewer.log, viewer.pid
//   CODEATLAS_PORT      default 5173           --strictPort: never drifts to :5174
//   CODEATLAS_EDITOR    e.g. 'code -g {file}:{line}'   "Open in editor" command (viewer/vite.config.ts)
//   CODEATLAS_OPEN_HOME=1   let "Open in editor" open any file under the home dir, not only the roots
// Requires Node.js >= 20 and npm.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN = platform() === "win32";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.CODEATLAS_DATA || join(homedir(), ".codeatlas"));
const PORT = Number(process.env.CODEATLAS_PORT || 5173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  // Without this a typo became `http://localhost:NaN/`: vite was started on a port
  // that cannot exist and the launcher waited 20 s before a generic failure.
  console.error(`codeatlas-viewer: CODEATLAS_PORT must be an integer 1-65535, got ${JSON.stringify(process.env.CODEATLAS_PORT)}`);
  process.exit(1);
}
const LIVE = join(DATA, "live");
const LOG = join(DATA, "viewer.log");
const PIDFILE = join(DATA, "viewer.pid");
const STALE_DEPS = join(DATA, "deps-stale.json"); // set when an update failed and the old install was kept
const RUNSTATE = join(DATA, "viewer.state.json"); // what the RUNNING instance was started with
const LOCKFILE = join(DATA, "start.lock");
const LOCK_STALE_MS = 10 * 60 * 1000; // a first-run `npm ci` is minutes; a crashed start must not block forever
const LOCK_NEW_MS = 5_000; // grace for the gap between creating the lock file and writing it
const URL_ = `http://localhost:${PORT}/`;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const VITE = join(ROOT, "viewer", "node_modules", "vite", "bin", "vite.js");

function die(msg, code = 1) {
  console.error(`codeatlas-viewer: ${msg}`);
  process.exit(code);
}

function needNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= 20)) die(`Node.js >= 20 required, found ${process.version}`);
}

/** Served by viewer/index.html — proves the responder is OUR viewer, not just any server. */
const VIEWER_MARKER = "<title>CodeAtlas</title>";

/**
 * The CodeAtlas viewer answers on the URL.
 *
 * Not merely "something returned 200": 5173 is Vite's own default port, so a
 * developer with another Vite project running would otherwise be told the viewer
 * was already up — and shown someone else's app.
 */
async function up() {
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return (await r.text()).includes(VIEWER_MARKER);
  } catch {
    return false;
  }
}

/** The port is bound by some process (portable: try to listen). */
function portHeld() {
  return new Promise((done) => {
    const srv = net.createServer();
    srv.once("error", () => done(true));
    srv.listen(PORT, "127.0.0.1", () => srv.close(() => done(false)));
  });
}

function readPid() {
  try {
    const pid = Number(readFileSync(PIDFILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Command line of a pid, or null when it cannot be read (then we never kill blindly).
 *
 * Windows has no single reliable way to do this: PowerShell may be absent from
 * PATH, blocked by execution policy, or slow to start, and `wmic` is deprecated
 * and gone from recent builds. Try both — if neither answers, the caller falls
 * back to an HTTP identity check rather than refusing forever.
 */
function commandLine(pid) {
  if (!WIN) {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  }
  for (const [cmd, args] of [
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `[Console]::Out.Write((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine)`]],
    ["wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"]],
  ]) {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
    const out = (r.stdout || "").replace(/^CommandLine=/m, "").trim();
    if (r.status === 0 && out) return out;
  }
  return null;
}

/** Wait up to `ms` for a pid to disappear. */
async function waitGone(pid, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

/** True only for OUR vite: this plugin's vite entry AND this port (pids get reused after a reboot; another project's vite is not ours). */
export function isOurVite(cmdline, vitePath = VITE, port = PORT) {
  if (typeof cmdline !== "string") return false;
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  return norm(cmdline).includes(norm(vitePath)) && new RegExp(`--port[ =]${port}(\\s|$)`).test(cmdline);
}

/** The pid in the file is alive AND still our vite. */
function pidAlive() {
  const pid = readPid();
  if (!pid || !alive(pid)) return null;
  const cmd = commandLine(pid);
  if (cmd === null) return { pid, verified: false };
  return isOurVite(cmd) ? { pid, verified: true } : null;
}

/** Labels whose dependency update failed in this run (the old install was kept). */
const staleDeps = [];

function installDeps() {
  needNode();
  const run = (cwd, label, extra = []) => {
    // `npm ci` DELETES node_modules before it installs, so a failure part-way — offline
    // with a cold cache, a proxy, a registry outage — leaves nothing behind and turns a
    // working viewer into a broken one on the next `start`. Move the existing tree aside
    // first (a rename, not a copy) and put it back if the install does not complete.
    const nm = join(cwd, "node_modules");
    const bak = join(cwd, "node_modules.codeatlas-bak");
    if (existsSync(bak)) rmSync(bak, { recursive: true, force: true }); // left by an earlier crash
    let saved = false;
    if (existsSync(nm)) {
      try {
        renameSync(nm, bak);
        saved = true;
      } catch {
        /* same-filesystem rename should not fail; if it does, npm ci behaves as before */
      }
    }
    console.log(`codeatlas-viewer: installing ${label} dependencies…`);
    const args = ["ci", "--no-audit", "--no-fund", "--loglevel=error", ...extra];
    // Windows: npm is npm.cmd, which Node only spawns through a shell (CVE-2024-27980). One command
    // string keeps that shell without DEP0190 (args + shell: true); every token is a fixed literal.
    const r = WIN
      ? spawnSync("npm.cmd " + args.join(" "), { cwd, stdio: "inherit", shell: true })
      : spawnSync("npm", args, { cwd, stdio: "inherit" });
    if (r.status === 0) {
      if (saved) rmSync(bak, { recursive: true, force: true });
      return;
    }
    console.error(`codeatlas-viewer: could not update ${label} dependencies (npm ci exited ${r.status}) — keeping the working install already on disk.`);
    if (!saved) die(`npm ci failed in ${cwd}`); // nothing to fall back to
    rmSync(nm, { recursive: true, force: true }); // whatever the failed run left
    renameSync(bak, nm);
    // A slightly stale viewer beats no viewer: keep going rather than exiting. But the
    // user MUST be told — otherwise they are silently running old code, and a `start`
    // from days ago is long out of the scrollback. Record it so `status` keeps saying so.
    staleDeps.push(label);
    try {
      mkdirSync(DATA, { recursive: true });
      writeFileSync(STALE_DEPS, JSON.stringify({ at: new Date().toISOString(), failed: staleDeps, exitCode: r.status }, null, 2) + "\n");
    } catch {
      /* the warning below is still printed */
    }
  };
  for (const { dir, label, extra } of outdatedDeps()) run(dir, label, extra);
  if (staleDeps.length === 0) {
    try {
      unlinkSync(STALE_DEPS); // everything is current again
    } catch {
      /* no marker */
    }
  }
}

/** The dependency trees that no longer match the plugin's lockfiles: nothing installed yet, or an update landed. */
function outdatedDeps() {
  const newer = (a, b) => existsSync(a) && (!existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs);
  return [
    // --omit=dev on BOTH: what a user runs is vite (a `dependencies` entry here on
    // purpose), never vitest/typescript/@types. It is also what CI audits, so the gate
    // and the install are the same tree — auditing less than we ship is worse than
    // not auditing.
    { label: "viewer", dir: join(ROOT, "viewer"), installed: VITE, extra: ["--omit=dev"] },
    { label: "validator", dir: join(ROOT, "schema"), installed: join(ROOT, "schema", "node_modules", "ajv"), extra: ["--omit=dev"] },
  ]
    // `present`: is there an install here at all? "never installed" and "installed but the
    // lockfile moved" both need `npm ci`, but only the SECOND means a running viewer is
    // serving stale modules — see restartNeeded().
    .map((d) => ({ ...d, present: existsSync(d.installed) }))
    .filter((d) => !d.present || newer(join(d.dir, "package-lock.json"), join(d.dir, "node_modules", ".package-lock.json")));
}

/** The recorded "an update failed" state, or null. */
function staleDepsRecord() {
  try {
    const r = JSON.parse(readFileSync(STALE_DEPS, "utf8"));
    return Array.isArray(r.failed) && r.failed.length ? r : null;
  } catch {
    return null;
  }
}

/** Print the stale-dependency warning, if any. Called last so it is what the user sees. */
function warnStaleDeps() {
  const r = staleDepsRecord();
  if (!r) return;
  const when = String(r.at).replace("T", " ").replace(/\..*/, "");
  console.error("");
  console.error(`codeatlas-viewer: WARNING — ${r.failed.join(" and ")} dependencies are STALE.`);
  console.error(`codeatlas-viewer:   an update failed on ${when} (npm ci exited ${r.exitCode}) and the previous`);
  console.error("codeatlas-viewer:   install was kept, so the viewer is running older packages than the plugin expects.");
  console.error("codeatlas-viewer:   Re-run `codeatlas-viewer install` once the network (or npm cache) is available.");
}

/** mtimes of the lockfiles and of the installed trees: the state a restart would change. */
function depsFingerprint() {
  const stamp = (...p) => {
    try {
      return Math.round(statSync(join(ROOT, ...p)).mtimeMs);
    } catch {
      return 0;
    }
  };
  return {
    viewerLock: stamp("viewer", "package-lock.json"),
    viewerModules: stamp("viewer", "node_modules", ".package-lock.json"),
    schemaLock: stamp("schema", "package-lock.json"),
    schemaModules: stamp("schema", "node_modules", ".package-lock.json"),
  };
}

/** Record what the instance we just started is running, so a later plugin update is detectable. */
function recordRunState(pid) {
  try {
    writeFileSync(RUNSTATE, JSON.stringify({ pid, port: PORT, at: new Date().toISOString(), deps: depsFingerprint() }, null, 2) + "\n");
  } catch {
    /* advisory only */
  }
}

/**
 * The running viewer is serving dependencies the plugin no longer ships.
 *
 * vite restarts itself when its config or sources change, so a plugin update mostly
 * self-heals — but a running process never reloads node_modules, and `start` answers
 * "already up" before it ever looks at the lockfiles. Without this the viewer kept
 * serving the pre-update packages (a vite security patch included) forever.
 */
function restartNeeded() {
  // Only a tree that IS installed and has since gone stale means the running viewer holds
  // old modules. A tree that was never installed says nothing about what is running — and
  // against a viewer someone else started (tools/serve.sh never installs schema/), that
  // read produced a confident "a plugin update? run restart" for a viewer that was current.
  if (outdatedDeps().some((d) => d.present)) return true;
  try {
    const rec = JSON.parse(readFileSync(RUNSTATE, "utf8"));
    const now = depsFingerprint();
    return Object.keys(now).some((k) => rec.deps?.[k] !== now[k]);
  } catch {
    return false; // no record: started by an older build or by hand — do not nag
  }
}

function warnRestartNeeded() {
  // A failed update is a different story with different advice: warnStaleDeps() tells it.
  if (staleDepsRecord() || !restartNeeded()) return;
  console.error("");
  console.error("codeatlas-viewer: NOTE — the viewer's dependencies changed since it started (a plugin update?).");
  console.error("codeatlas-viewer:   A running instance never reloads node_modules, so it is still serving the old ones.");
  console.error("codeatlas-viewer:   Run `codeatlas-viewer restart` to pick them up.");
}

/**
 * Drop a self-contained stop script next to the pidfile.
 *
 * `/plugin uninstall` deletes this launcher, so without it a detached viewer had
 * nothing left on the machine that could stop it. The running viewer also shuts
 * itself down once the plugin has been gone a minute (see the watchdog in
 * viewer/vite.config.ts); this is the immediate, manual way.
 */
function writeStopScript() {
  try {
    const sh = join(DATA, "stop-viewer.sh");
    writeFileSync(
      sh,
      `#!/bin/sh\n` +
        `# Stops the CodeAtlas viewer this launcher started. Self-contained on purpose:\n` +
        `# it keeps working after the plugin is uninstalled.\n` +
        `pid=$(cat "${PIDFILE}" 2>/dev/null) || { echo "no pidfile at ${PIDFILE}"; exit 1; }\n` +
        `kill "$pid" 2>/dev/null && sleep 1\n` +
        `kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null\n` +
        `rm -f "${PIDFILE}"\n` +
        `echo "stopped codeatlas viewer (pid $pid)"\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(DATA, "stop-viewer.cmd"),
      `@echo off\r\n` +
        `rem Stops the CodeAtlas viewer this launcher started. Works after uninstall.\r\n` +
        `set /p PID=<"${PIDFILE}"\r\n` +
        `taskkill /PID %PID% /T /F\r\n` +
        `del "${PIDFILE}"\r\n`
    );
  } catch {
    /* best effort: the watchdog still stops an orphan on its own */
  }
}

function printPaths() {
  console.log(`PLUGIN_ROOT=${ROOT}`);
  console.log(`LIVE_DIR=${LIVE}`);
  console.log(`VALIDATOR=${join(ROOT, "schema", "validate.mjs")}`);
  console.log(`THEME_CSS=${join(DATA, "theme.css")}`);
  console.log(`URL=${URL_}`);
  console.log(`LOG=${LOG}`);
  console.log(`STOP=${join(DATA, WIN ? "stop-viewer.cmd" : "stop-viewer.sh")}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whoever owns the start lock, {pid, at} (pid 0 = unreadable), or null when free. */
function lockHolder() {
  let raw;
  try {
    raw = readFileSync(LOCKFILE, "utf8");
  } catch {
    return null; // free (or gone since we looked)
  }
  try {
    const r = JSON.parse(raw);
    if (Number.isInteger(r.pid) && r.pid > 0 && Number.isFinite(r.at)) return { pid: r.pid, at: r.at };
  } catch {
    /* half-written or corrupt — fall through to the file's own age */
  }
  // takeStartLock creates the file and writes it a moment later, so an empty lock is
  // usually one being taken RIGHT NOW, not an abandoned one. mtime dates it; without
  // that, two starts a millisecond apart both read `{pid: 0}`, both call it breakable
  // and both proceed — the exact race the lock exists to stop.
  try {
    return { pid: 0, at: statSync(LOCKFILE).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * One rule for "this lock can be taken over", used by the taker AND the waiter.
 * They disagreed before: `start` could sit for five minutes on a corrupt or long-stale
 * lock that takeStartLock() would have broken instantly.
 */
function lockIsBreakable(held) {
  if (!held) return true; // free
  if (Date.now() - held.at >= LOCK_STALE_MS) return true; // abandoned: process.exit() skips `finally`
  if (held.pid <= 0) return Date.now() - held.at >= LOCK_NEW_MS; // corrupt, and not mid-write
  return !alive(held.pid); // the owner died
}

/**
 * Serialise `start`: a release function, or null when another start owns the lock.
 *
 * Two starts at once (the codeatlas skill and the viewer skill, or two Claude sessions)
 * both cleared the port check during the minutes `npm ci` takes, then installed into the
 * same node_modules concurrently and raced for the port; the loser exited on --strictPort
 * AFTER overwriting the pidfile, leaving a viewer that `stop` then refused to touch.
 * Break a lock whose owner is gone or that is older than LOCK_STALE_MS — process.exit()
 * skips `finally`, so a failed start can leave one behind.
 */
function takeStartLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCKFILE, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n");
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only if the lock is still OURS. A start slower than LOCK_STALE_MS gets its lock
        // broken and handed on; unlinking unconditionally would then delete the NEW
        // owner's lock and let a third start in beside it.
        try {
          const held = lockHolder();
          if (held && held.pid === process.pid) unlinkSync(LOCKFILE);
        } catch {
          /* already released */
        }
      };
    } catch (err) {
      // Not "someone holds it": a read-only mount, ENOSPC, a denied EACCES. Reporting
      // those as a concurrent start sent the user looking for a process that is not there.
      if (err.code !== "EEXIST") die(`cannot create the start lock ${LOCKFILE}: ${err.message}`);
      if (!lockIsBreakable(lockHolder())) return null;
      try {
        unlinkSync(LOCKFILE);
      } catch {
        /* another start broke it first */
      }
    }
  }
  return null;
}

function reportUp(already) {
  console.log(already ? `codeatlas viewer already up at ${URL_}` : `codeatlas viewer up at ${URL_}`);
  printPaths();
  warnStaleDeps();
  warnRestartNeeded();
}

/**
 * Wait out another start that holds the lock (it may be inside a multi-minute `npm ci`).
 * True when a viewer is up as a result; false when that start ended without one.
 */
async function waitForOtherStart() {
  console.log("codeatlas-viewer: another start is already running — waiting for it…");
  for (let i = 0; i < 600; i++) {
    if (await up()) {
      reportUp(true);
      return true;
    }
    if (lockIsBreakable(lockHolder())) break; // released, killed mid-start, corrupt, or stale
    await sleep(500);
  }
  if (await up()) {
    reportUp(true);
    return true;
  }
  return false;
}

/**
 * Both dirs 0700, every time. These hold the user's graphs — which carry absolute
 * paths and the structure of private projects — and `mode` on mkdirSync only
 * applies when the directory is CREATED, so a dir made by an older build (or with
 * a permissive umask) kept its 0755 forever. chmod is a no-op on Windows.
 * Shared by `start` and `publish`: a publish before the first start must not create
 * the live dir with the umask's mode either.
 */
function ensureDataDirs() {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  mkdirSync(LIVE, { recursive: true, mode: 0o700 });
  for (const d of [DATA, LIVE]) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* not ours to change, or a filesystem without modes */
    }
  }
}

async function start() {
  ensureDataDirs();
  if (await up()) return reportUp(true);
  // Two attempts: take the lock, or wait for whoever holds it and try once more if that
  // start ended without a viewer (it was killed, or it failed).
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = takeStartLock();
    if (release) {
      process.once("exit", release); // die() / process.exit() never run `finally`
      try {
        return await startExclusive();
      } finally {
        release();
      }
    }
    if (await waitForOtherStart()) return;
  }
  die(`another \`codeatlas-viewer start\` is in progress; check ${LOG}, or remove ${LOCKFILE} and retry.`);
}

/** The real start, with the start lock held. */
async function startExclusive() {
  // Re-check under the lock: the start we queued behind may have just brought it up.
  if (await up()) return reportUp(true);
  const refusePort = async () => {
    if (await portHeld()) die(`port :${PORT} is held by another process that is not the viewer. Free it or set CODEATLAS_PORT.`);
  };
  await refusePort();
  installDeps();
  // A first-run install takes minutes; nothing about the port is still known to be true.
  if (await up()) return reportUp(true);
  await refusePort();
  try {
    if (statSync(LOG).size > MAX_LOG_BYTES) renameSync(LOG, `${LOG}.1`);
  } catch {
    /* no log yet */
  }
  const out = openSync(LOG, "a");
  writeFileSync(out, `[${new Date().toISOString()}] codeatlas-viewer: starting vite on :${PORT}, live dir ${LIVE}\n`);
  const child = spawn(process.execPath, [VITE, "--strictPort", "--port", String(PORT)], {
    cwd: join(ROOT, "viewer"),
    env: { ...process.env, CODEATLAS_LIVE_DIR: LIVE, CODEATLAS_LOG: LOG, CODEATLAS_THEME_CSS: join(DATA, "theme.css") },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  // Written before the health loop on purpose: a vite that comes up but never answers
  // must still be stoppable. It is removed again below if the child is already dead.
  writeFileSync(PIDFILE, `${child.pid}\n`);
  writeStopScript();
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await up()) {
      recordRunState(child.pid);
      return reportUp(false);
    }
    if (!alive(child.pid)) break;
    await sleep(500);
  }
  if (!alive(child.pid)) {
    // A pidfile pointing at a dead pid is worse than none: `stop` then finds nothing to
    // kill, sees the port answered by whatever won it, and exits 2 "not started by this
    // launcher" — for good.
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* never written */
    }
  }
  console.error("codeatlas-viewer: viewer did not come up; last log lines:");
  try {
    console.error(readFileSync(LOG, "utf8").split("\n").slice(-20).join("\n"));
  } catch {
    /* nothing to show */
  }
  if (alive(child.pid)) console.error(`codeatlas-viewer: pid ${child.pid} is still running but not answering — \`codeatlas-viewer stop\` ends it.`);
  process.exit(1);
}

/**
 * Stop this launcher's instance and start it again.
 *
 * The only way a node_modules change (a plugin update) reaches a running viewer. Never
 * touches a viewer this launcher did not start — that one is the user's to stop.
 */
async function restart() {
  const live = pidAlive();
  if (live) await stop();
  else if (await up()) die(`a viewer answers on :${PORT} but was not started by this launcher; stop it yourself, then run start`, 2);
  await start();
}

/** Drop the pidfile and the record of what the (now stopped) instance was running. */
function forgetRunState() {
  for (const f of [PIDFILE, RUNSTATE]) {
    try {
      unlinkSync(f);
    } catch {
      /* fine */
    }
  }
}

async function stop({ force = false } = {}) {
  const live = pidAlive();
  if (live) {
    // Unverified only means we could not READ the command line (no PowerShell,
    // execution policy, no wmic). Corroborate over HTTP instead of refusing
    // forever: if our own viewer answers on our own port, this pid is ours.
    if (!live.verified && !force && !(await up())) {
      die(
        `pid ${live.pid} is alive but could not be verified as the viewer, and nothing is answering on :${PORT}.\n` +
          `Re-run with --force to kill it anyway, or stop it by hand and delete ${PIDFILE}.`,
        2
      );
    }
    if (WIN) {
      const r = spawnSync("taskkill", ["/PID", String(live.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
      if (r.error) die(`could not run taskkill: ${r.error.message}`, 2);
      if (r.status !== 0 && alive(live.pid)) {
        die(`taskkill exited ${r.status} and pid ${live.pid} is still running: ${(r.stderr || "").trim()}`, 2);
      }
    } else {
      try {
        process.kill(live.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await sleep(300);
      if (alive(live.pid)) {
        try {
          process.kill(live.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    // Confirm before claiming success: reporting "stopped" while the process is
    // still serving is worse than reporting the failure.
    if (!(await waitGone(live.pid))) {
      die(`pid ${live.pid} is still alive after the kill; the viewer was NOT stopped`, 2);
    }
    forgetRunState();
    console.log("codeatlas viewer stopped");
    return;
  }
  forgetRunState();
  if (await up()) {
    console.log(`a viewer answers on :${PORT} but was not started by this launcher; not touching it`);
    process.exit(2);
  }
  console.log("codeatlas viewer is not running");
  process.exit(1);
}

async function status() {
  const isUp = await up();
  const live = pidAlive();
  if (isUp) console.log(live ? `up (pid ${live.pid}${live.verified ? "" : ", unverified"})` : "up (not started by this launcher)");
  else if (await portHeld()) console.log(`down (port :${PORT} is held by something that is not the viewer)`);
  else console.log("down");
  printPaths();
  warnStaleDeps();
  if (isUp) warnRestartNeeded();
  if (!isUp) process.exit(1);
}

/**
 * Hand the URL to the platform's opener, degrading to the printed URL.
 *
 * A failed spawn emits 'error' asynchronously and `.unref()` does NOT suppress it, so
 * without this listener `open` on a box with no xdg-open (headless Linux, a minimal
 * container, WSL without wslu) died with an unhandled-error stack trace and exit 1 —
 * after the viewer had already started, and with no fix named for the user to follow.
 */
function launchBrowser() {
  const [cmd, args] = WIN ? ["cmd", ["/c", "start", "", URL_]] : platform() === "darwin" ? ["open", [URL_]] : ["xdg-open", [URL_]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => console.error(`codeatlas-viewer: could not run ${cmd} — open ${URL_} in a browser yourself`));
  child.unref();
}

async function openBrowser() {
  if (!(await up())) await start();
  launchBrowser();
  console.log(URL_);
}

/**
 * Validate a draft with the plugin's own validator, then rename it over the live graph.
 *
 *   codeatlas-viewer publish <draft> [--to <name>]
 *
 * The skill used to end with `mv <draft> <LIVE_DIR>/graph.json`, and in plugin mode that
 * line can never run: the live dir is outside every project, and Claude Code's file-move
 * rule only allows `mv` inside the session's working directories ("may only move files
 * to/from the allowed working directories") — a hard block, not a prompt. The session
 * then improvised; on the 2026-09-12 Windows pass it overwrote graph.json with the Write
 * tool, which works but is not the stage → validate → rename contract. This subcommand
 * IS that contract, behind the one permission users already grant the launcher: nothing
 * reaches the live file unless the validator said VALID, and the last step is a rename
 * inside the live dir, so the viewer's 1 s poll never sees a half-written file.
 *
 * <draft> is a path, or a bare name meaning <LIVE_DIR>/<name>.json (with or without the
 * extension). --to picks the live file name (default `graph`; the viewer's `?graph=<name>`
 * reads <name>.json), restricted to the names the viewer will serve. A draft on another
 * volume is copied to a temp sibling first so the final step is still a rename.
 * Exit 0 published · 1 the draft is missing, not JSON or not valid IR (left in place,
 * nothing published) · 2 usage, or the validator's own dependency missing.
 */
export function parsePublishArgs(argv) {
  let to = "graph";
  const drafts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") {
      if (i + 1 >= argv.length) return { error: "--to needs a name" };
      to = argv[++i];
    } else if (a.startsWith("--to=")) to = a.slice("--to=".length);
    else if (a.startsWith("-")) return { error: `unknown flag: ${a}` };
    else drafts.push(a);
  }
  if (drafts.length !== 1) return { error: "usage: codeatlas-viewer publish <draft.json | name> [--to <name>]" };
  const name = to.replace(/\.json$/, "");
  // the same shape viewer/vite.config.ts `liveFilePath` serves; anything else would publish a file nothing can read
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: `--to must be a plain graph name (letters, digits, _ and -), got "${to}"` };
  return { draft: drafts[0], name };
}

async function publish(argv) {
  const parsed = parsePublishArgs(argv);
  if (parsed.error) die(parsed.error, 2);
  const { name } = parsed;
  const draft = existsSync(parsed.draft) ? resolve(parsed.draft) : join(LIVE, parsed.draft.replace(/\.json$/, "") + ".json");
  let isFile = false;
  try {
    isFile = statSync(draft).isFile();
  } catch {
    /* missing */
  }
  if (!isFile) die(`no such draft: ${parsed.draft} (looked for ${draft})`);
  const target = join(LIVE, `${name}.json`);
  if (resolve(draft).toLowerCase() === resolve(target).toLowerCase()) die(`${draft} already is the live file; stage the draft under another name`, 2);
  let doc;
  try {
    doc = JSON.parse(readFileSync(draft, "utf8"));
  } catch (e) {
    die(`${draft} is not JSON (${e.message}) — left in place, nothing published`);
  }
  let validateDocument;
  try {
    // a URL, never a bare absolute path: the ESM loader rejects `C:\…` on Windows
    ({ validateDocument } = await import(new URL("../schema/validate.mjs", import.meta.url).href));
  } catch (e) {
    die(e?.message ?? String(e), 2); // validate.mjs already names the install command when ajv is missing
  }
  const errors = validateDocument(doc);
  if (errors.length) {
    console.error(`codeatlas-viewer: ${draft} is not valid IR (${errors.length} problem(s)):`);
    for (const e of errors.slice(0, 10)) console.error(`  - ${e}`);
    if (errors.length > 10) console.error(`  … and ${errors.length - 10} more`);
    die("draft left in place, nothing published");
  }
  ensureDataDirs();
  try {
    renameSync(draft, target);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    // another volume: land it next to the target first so the swap itself is still atomic
    const tmp = join(LIVE, `.${name}.publishing-${process.pid}.json`);
    copyFileSync(draft, tmp);
    renameSync(tmp, target);
    unlinkSync(draft);
  }
  const nodes = Array.isArray(doc.nodes) ? doc.nodes.length : 0;
  const edges = Array.isArray(doc.edges) ? doc.edges.length : 0;
  console.log(`published ${target} (${nodes} nodes, ${edges} edges, VALID) from ${draft}`);
  console.log(`URL=${URL_}${name === "graph" ? "" : `?graph=${name}`}`);
}

/**
 * Are we the script that was run (vs. imported by a test)?
 *
 * Compare REALPATHS: Node resolves symlinks when it builds `import.meta.url`, so
 * comparing it against a raw `resolve(process.argv[1])` disagreed whenever any
 * component of the invocation path was a symlink — a `~/.claude` managed by
 * stow/chezmoi, a checkout under macOS `/tmp`, a Windows junction. The whole CLI
 * then silently did nothing and still exited 0, which reads as success.
 */
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // argv[1] vanished under us
  }
})();
const cmd = process.argv[2] || "start";
if (isMain) switch (cmd) {
  case "start":
    await start();
    break;
  case "stop":
    await stop({ force: process.argv.includes("--force") });
    break;
  case "restart":
    await restart();
    break;
  case "status":
    await status();
    break;
  case "open":
    await openBrowser();
    break;
  case "paths":
    printPaths();
    break;
  case "install":
    installDeps();
    if (staleDeps.length) {
      warnStaleDeps();
      process.exit(1); // an explicit `install` that could not update IS a failure
    }
    console.log("dependencies installed");
    break;
  case "publish":
    await publish(process.argv.slice(3));
    break;
  case "-h":
  case "--help":
  case "help":
    // The whole header block, however long it grows: comment lines until the first that is
    // not one, rather than a hardcoded line count that silently dropped the last line
    // ("Requires Node.js >= 20 and npm.") as soon as the block gained an entry.
    {
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1); // past the shebang
      const end = lines.findIndex((l) => !l.startsWith("//"));
      console.log(lines.slice(0, end === -1 ? lines.length : end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    }
    break;
  default:
    die(`unknown command: ${cmd} (start|stop|restart|status|open|paths|install|publish)`);
}

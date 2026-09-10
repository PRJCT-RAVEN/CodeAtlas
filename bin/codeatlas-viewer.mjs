#!/usr/bin/env node
// codeatlas-viewer — start / stop / inspect the CodeAtlas viewer. One
// implementation for macOS, Linux and Windows; `codeatlas-viewer` (POSIX sh)
// and `codeatlas-viewer.cmd` are thin shims that run this file.
//
//   codeatlas-viewer start     install deps on first run, start vite on :5173, print URL + paths
//   codeatlas-viewer stop      stop the instance this launcher started (--force: skip the
//                              "is this really our process?" check)
//   codeatlas-viewer status    up/down, pid, URL, live dir (exit 1 when down)
//   codeatlas-viewer open      open the viewer in the default browser (starts it if needed)
//   codeatlas-viewer paths     print PLUGIN_ROOT / LIVE_DIR / VALIDATOR / THEME_CSS / URL / LOG
//   codeatlas-viewer install   only install viewer + validator dependencies
//
// Graphs live in a DATA dir OUTSIDE the plugin so an update never deletes them:
//   CODEATLAS_DATA      default ~/.codeatlas   live/ (graphs), theme.css, viewer.log, viewer.pid
//   CODEATLAS_PORT      default 5173           --strictPort: never drifts to :5174
//   CODEATLAS_EDITOR    e.g. 'code -g {file}:{line}'   "Open in editor" command (viewer/vite.config.ts)
//   CODEATLAS_OPEN_HOME=1   let "Open in editor" open any file under the home dir, not only the roots
// Requires Node.js >= 20 and npm.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
    if (!saved) die(`npm ci failed in ${cwd}`); // nothing to fall back to
    rmSync(nm, { recursive: true, force: true }); // whatever the failed run left
    renameSync(bak, nm);
    // A slightly stale viewer beats no viewer: keep going rather than exiting.
    console.error(`codeatlas-viewer: could not update ${label} dependencies (npm ci exited ${r.status}) — keeping the working install already on disk.`);
    console.error(`codeatlas-viewer: the viewer may be running against slightly stale ${label} packages; re-run \`codeatlas-viewer install\` when the network is back.`);
  };
  const newer = (a, b) => existsSync(a) && (!existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs);
  const viewer = join(ROOT, "viewer");
  if (!existsSync(VITE) || newer(join(viewer, "package-lock.json"), join(viewer, "node_modules", ".package-lock.json"))) run(viewer, "viewer");
  const schema = join(ROOT, "schema");
  if (!existsSync(join(schema, "node_modules", "ajv")) || newer(join(schema, "package-lock.json"), join(schema, "node_modules", ".package-lock.json")))
    run(schema, "validator", ["--omit=dev"]);
}

function printPaths() {
  console.log(`PLUGIN_ROOT=${ROOT}`);
  console.log(`LIVE_DIR=${LIVE}`);
  console.log(`VALIDATOR=${join(ROOT, "schema", "validate.mjs")}`);
  console.log(`THEME_CSS=${join(DATA, "theme.css")}`);
  console.log(`URL=${URL_}`);
  console.log(`LOG=${LOG}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true, mode: 0o700 });
  mkdirSync(LIVE, { recursive: true });
  if (await up()) {
    console.log(`codeatlas viewer already up at ${URL_}`);
    printPaths();
    return;
  }
  if (await portHeld()) die(`port :${PORT} is held by another process that is not the viewer. Free it or set CODEATLAS_PORT.`);
  installDeps();
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
  writeFileSync(PIDFILE, `${child.pid}\n`);
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await up()) {
      console.log(`codeatlas viewer up at ${URL_}`);
      printPaths();
      return;
    }
    if (!alive(child.pid)) break;
    await sleep(500);
  }
  console.error("codeatlas-viewer: viewer did not come up; last log lines:");
  try {
    console.error(readFileSync(LOG, "utf8").split("\n").slice(-20).join("\n"));
  } catch {
    /* nothing to show */
  }
  process.exit(1);
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
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* fine */
    }
    console.log("codeatlas viewer stopped");
    return;
  }
  try {
    unlinkSync(PIDFILE);
  } catch {
    /* fine */
  }
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
  if (!isUp) process.exit(1);
}

async function openBrowser() {
  if (!(await up())) await start();
  if (WIN) spawn("cmd", ["/c", "start", "", URL_], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(platform() === "darwin" ? "open" : "xdg-open", [URL_], { detached: true, stdio: "ignore" }).unref();
  console.log(URL_);
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
    console.log("dependencies installed");
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    break;
  default:
    die(`unknown command: ${cmd} (start|stop|status|open|paths|install)`);
}

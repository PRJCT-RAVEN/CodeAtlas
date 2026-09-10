// bin/codeatlas-viewer.mjs: paths/status without a server, then a real start/stop on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, symlinkSync, cpSync, utimesSync, chmodSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(here, "../../bin/codeatlas-viewer.mjs");
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const run = (args, env) => spawnSync("node", [LAUNCHER, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

// `start` installs viewer + validator deps on first run. That is right for the product and wrong
// for a test: it mutates the repo it runs in, needs the network, and — because schema/validate.mjs
// is what fs2ir.test.mjs and schema2ir.test.mjs shell out to — it was the only thing creating
// schema/node_modules, which the rest of the suite then silently depended on winning a race
// against. Assert the preconditions rather than quietly creating them.
const ROOT = join(here, "../..");
const DEPS = [
  ["viewer/node_modules/vite", "npm ci in viewer/"],
  ["schema/node_modules/ajv", "npm ci in schema/"],
];
const missingDeps = () => DEPS.filter(([p]) => !existsSync(join(ROOT, p)));

/**
 * Serve `body` on `port` from its OWN process, and wait until it answers.
 *
 * spawnSync (how these tests drive the launcher) blocks this process's event loop, so a
 * server created here would never accept the launcher's health probe — every check would
 * pass for the wrong reason.
 */
async function serveInBackground(port, body) {
  const child = spawn(process.execPath, ["-e",
    `require("node:http").createServer((_q, res) => res.end(${JSON.stringify(body)})).listen(${port}, "127.0.0.1")`,
  ], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return child;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`background server on :${port} never answered`);
}

test("paths and status (down) with a private data dir", async () => {
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const port = await freePort();
  const env = { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  const p = run(["paths"], env);
  assert.equal(p.status, 0);
  assert.match(p.stdout, new RegExp(`LIVE_DIR=${data.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.match(p.stdout, /VALIDATOR=.*schema[\\/]validate\.mjs/);
  assert.match(p.stdout, new RegExp(`URL=http://localhost:${port}/`));
  const s = run(["status"], env);
  assert.equal(s.status, 1, "status exits 1 when down");
  assert.match(s.stdout, /^down/);
  const st = run(["stop"], env);
  assert.equal(st.status, 1);
  assert.match(st.stdout, /not running/);
  rmSync(data, { recursive: true, force: true });
});

test("start → status → stop on a free port", { timeout: 120_000 }, async (t) => {
  const missing = missingDeps();
  if (missing.length) {
    const how = missing.map(([, cmd]) => cmd).join(" and ");
    // Locally this is a convenience; in CI a missing dep is a workflow bug, so fail loudly
    // instead of shrinking the suite where nobody reads the skip list.
    assert.ok(!process.env.CI, `launcher test needs deps the workflow did not install: ${how}`);
    t.skip(`needs ${missing.map(([p]) => p).join(" and ")} — run ${how}`);
    return;
  }
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const port = await freePort();
  const env = { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  const s = run(["start"], env);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, new RegExp(`codeatlas viewer up at http://localhost:${port}/`));
  assert.ok(existsSync(join(data, "viewer.pid")));
  assert.ok(existsSync(join(data, "live")));
  // the graphs carry absolute paths and private project structure: both dirs 0700,
  // and re-applied on every start (mkdirSync's `mode` only bites on creation)
  if (process.platform !== "win32") {
    for (const d of [data, join(data, "live")])
      assert.equal(statSync(d).mode & 0o777, 0o700, `${d} must not be group/world readable`);
  }
  const r = await fetch(`http://localhost:${port}/live/nothing.json`);
  assert.equal(r.status, 404, "live dir middleware answers");
  const again = run(["start"], env);
  assert.match(again.stdout, /already up/);
  const st = run(["status"], env);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /^up \(pid \d+\)/);
  const stop = run(["stop"], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /stopped/);
  const down = run(["status"], env);
  assert.equal(down.status, 1);
  rmSync(data, { recursive: true, force: true });
});

test("pid verification accepts only this plugin's vite on this port", async () => {
  const { isOurVite } = await import("../../bin/codeatlas-viewer.mjs");
  const vite = "/plug/viewer/node_modules/vite/bin/vite.js";
  assert.equal(isOurVite(`/usr/bin/node ${vite} --strictPort --port 5173`, vite, 5173), true);
  assert.equal(isOurVite(`node C:\\plug\\viewer\\node_modules\\vite\\bin\\vite.js --strictPort --port 5173`, "C:\\plug\\viewer\\node_modules\\vite\\bin\\vite.js", 5173), true);
  assert.equal(isOurVite(`/usr/bin/node ${vite} --strictPort --port 51730`, vite, 5173), false, "other port");
  assert.equal(isOurVite(`node /other/project/node_modules/vite/bin/vite.js --port 5173`, vite, 5173), false, "another project's vite");
  assert.equal(isOurVite(`/usr/bin/some-other-tool-vite-watcher`, vite, 5173), false);
  assert.equal(isOurVite(null, vite, 5173), false);
});

// Regressions from the 2026-09-10 pre-deployment audit.

test("runs when reached through a symlinked path (was a silent no-op, exit 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeatlas-symlink-"));
  const link = join(dir, "launcher-link.mjs");
  symlinkSync(LAUNCHER, link);
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const port = await freePort();
  const r = spawnSync("node", [link, "paths"], {
    encoding: "utf8",
    env: { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`URL=http://localhost:${port}/`), "a symlinked invocation must still do the work");
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

test("a malformed CODEATLAS_PORT is rejected, not turned into localhost:NaN", () => {
  for (const bad of ["abc", "-1", "0", "70000", "5173.5", ""]) {
    const r = run(["paths"], { CODEATLAS_DATA: tmpdir(), CODEATLAS_PORT: bad });
    if (bad === "") {
      assert.equal(r.status, 0, "empty falls back to the default");
      assert.match(r.stdout, /URL=http:\/\/localhost:5173\//);
      continue;
    }
    assert.equal(r.status, 1, `${bad} should be rejected`);
    assert.match(r.stderr, /CODEATLAS_PORT must be an integer/);
    assert.doesNotMatch(r.stdout, /NaN/);
  }
});

test("a foreign server on the port is not mistaken for the viewer", { timeout: 30_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const port = await freePort();
  const env = { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  // 5173 is Vite's own default port: another project's dev server answers 200 here
  const foreign = await serveInBackground(port, "<!doctype html><title>Some Other App</title>");
  try {
    const st = run(["status"], env);
    assert.equal(st.status, 1, "a foreign 200 is not 'up'");
    assert.match(st.stdout, /^down \(port :\d+ is held by something that is not the viewer\)/);
    const start = run(["start"], env);
    assert.equal(start.status, 1, "start must refuse rather than claim success");
    assert.match(start.stderr, /held by another process/);
  } finally {
    foreign.kill();
    rmSync(data, { recursive: true, force: true });
  }
});

// A failing `npm ci` must not destroy a working install. npm ci deletes node_modules
// before installing, so offline-with-a-cold-cache used to leave the user with neither
// the old dependencies nor new ones — a plugin update turned a working viewer into a
// broken one. Verified against a real npm run pointed at an unreachable registry and
// an empty cache, in a throwaway plugin root (never the real one).
test("a failed dependency update keeps the install that was already working", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "codeatlas-fakeplugin-"));
  const marker = "codeatlas-test-marker";
  for (const part of ["viewer", "schema"]) {
    const dir = join(root, part);
    mkdirSync(join(dir, "node_modules", marker), { recursive: true });
    writeFileSync(join(dir, "node_modules", marker, "index.js"), "module.exports = 1;\n");
    // a lockfile NEWER than node_modules/.package-lock.json is what triggers a reinstall
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `fake-${part}`, version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
      name: `fake-${part}`, version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: `fake-${part}`, version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } },
        "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==" } },
    }));
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(LAUNCHER, join(root, "bin", "codeatlas-viewer.mjs"));
  const data = mkdtempSync(join(tmpdir(), "codeatlas-fakedata-"));
  const cache = mkdtempSync(join(tmpdir(), "codeatlas-emptycache-"));
  const r = spawnSync("node", [join(root, "bin", "codeatlas-viewer.mjs"), "install"], {
    encoding: "utf8",
    env: { ...process.env, CODEATLAS_DATA: data,
      npm_config_registry: "http://127.0.0.1:9", npm_config_cache: cache, npm_config_offline: "true" },
  });
  // the working install survived, in both directories
  for (const part of ["viewer", "schema"]) {
    assert.ok(existsSync(join(root, part, "node_modules", marker, "index.js")),
      `${part}: the working node_modules was destroyed by a failed update`);
    assert.ok(!existsSync(join(root, part, "node_modules.codeatlas-bak")), `${part}: backup left behind`);
  }
  assert.match(r.stderr, /keeping the working install/);
  // an explicit `install` that could not update is a FAILURE, and the warning must
  // name what is stale — not a silent success the user never notices
  assert.equal(r.status, 1, "`install` must not report success when it could not update");
  assert.match(r.stderr, /dependencies are STALE/);
  assert.match(r.stderr, /codeatlas-viewer install/);

  // and it must keep saying so afterwards: a `start` from days ago is long gone
  // from the scrollback, so the state is recorded in the data dir
  assert.ok(existsSync(join(data, "deps-stale.json")), "the stale state must be recorded");
  const later = spawnSync("node", [join(root, "bin", "codeatlas-viewer.mjs"), "status"], {
    encoding: "utf8",
    env: { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: "59999" },
  });
  assert.match(later.stderr, /dependencies are STALE/, "`status` must keep reporting stale dependencies");

  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

/** A throwaway copy of the plugin whose node_modules are symlinked to the real ones. */
function fakePluginRoot() {
  const root = mkdtempSync(join(tmpdir(), "codeatlas-uninstall-"));
  const repo = join(here, "../..");
  for (const part of ["bin", "viewer", "schema", ".claude-plugin"]) {
    cpSync(join(repo, part), join(root, part), {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes("/.git"),
    });
  }
  for (const part of ["viewer", "schema"]) symlinkSync(join(repo, part, "node_modules"), join(root, part, "node_modules"));
  return root;
}

// `/plugin uninstall` deletes the plugin — and with it the only tool that could stop
// the detached viewer, which kept serving :5173 forever with nothing on the machine
// knowing what it was. Two answers, both tested here: the daemon notices its own
// plugin is gone and exits, and a stop script in the data dir outlives the plugin.
test("an uninstalled plugin does not leave the viewer running", { timeout: 180_000 }, async () => {
  const root = fakePluginRoot();
  const data = mkdtempSync(join(tmpdir(), "codeatlas-uninstall-data-"));
  const port = await freePort();
  const env = { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: String(port), CODEATLAS_UNINSTALL_CHECK_MS: "500" };
  const started = spawnSync("node", [join(root, "bin", "codeatlas-viewer.mjs"), "start"], { encoding: "utf8", env });
  assert.equal(started.status, 0, started.stderr);
  const pid = Number(readFileSync(join(data, "viewer.pid"), "utf8").trim());
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(), "the viewer should be running");

  // the stop script must exist and be self-contained, since the launcher is about to go
  const stop = join(data, process.platform === "win32" ? "stop-viewer.cmd" : "stop-viewer.sh");
  assert.ok(existsSync(stop), "a stop script must be written where it survives uninstall");

  // Hold a connection open, as a forgotten browser tab does — that is WHY the daemon
  // is still around, and `server.close()` waits for exactly this. Without the grace
  // timeout the viewer would hang here instead of exiting.
  const held = await fetch(`http://localhost:${port}/`, { headers: { connection: "keep-alive" } });
  await held.text();

  rmSync(join(root, ".claude-plugin"), { recursive: true, force: true }); // what uninstall does
  for (let i = 0; i < 60 && alive(); i++) await sleep(500);
  assert.ok(!alive(), "the viewer must shut itself down once its plugin is gone");

  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

/**
 * A throwaway plugin root whose "vite" is a stub — `serve` answers exactly like the
 * viewer (optionally after a delay, to widen the window two starts race in), `die`
 * exits at once. Lets every start path be exercised without npm, network or real vite.
 */
function stubVitePlugin({ mode = "serve", listenDelayMs = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeatlas-stubvite-"));
  const bin = join(root, "viewer", "node_modules", "vite", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "vite.js"),
    mode === "die"
      ? "process.exit(1);\n"
      : `const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((_q, res) => res.end("<!doctype html><title>CodeAtlas</title>"));
setTimeout(() => server.listen(port, "127.0.0.1"), ${listenDelayMs});
`
  );
  mkdirSync(join(root, "schema", "node_modules", "ajv"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(LAUNCHER, join(root, "bin", "codeatlas-viewer.mjs"));
  for (const part of ["viewer", "schema"]) {
    writeFileSync(join(root, part, "package.json"), JSON.stringify({ name: `stub-${part}`, version: "1.0.0" }));
    writeFileSync(join(root, part, "package-lock.json"), "{}\n");
    writeFileSync(join(root, part, "node_modules", ".package-lock.json"), "{}\n");
  }
  touchLocks(root, { lockAgeS: 60, installedAgeS: 30 }); // installed AFTER the lockfile: nothing to do
  return root;
}

/** Age the lockfiles and the installed markers, so "an update landed" is a controlled fact. */
function touchLocks(root, { lockAgeS, installedAgeS }) {
  const at = (s) => new Date(Date.now() - s * 1000);
  for (const part of ["viewer", "schema"]) {
    utimesSync(join(root, part, "package-lock.json"), at(lockAgeS), at(lockAgeS));
    utimesSync(join(root, part, "node_modules", ".package-lock.json"), at(installedAgeS), at(installedAgeS));
  }
}

const runIn = (root, args, env) =>
  spawnSync(process.execPath, [join(root, "bin", "codeatlas-viewer.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

// `open` spawns the platform opener detached and unref'd — which does NOT suppress the
// 'error' event a failed spawn emits, so on a box with no opener (headless Linux, a
// minimal container, WSL without wslu) the command crashed with an unhandled-error stack
// trace and exit 1, right after it had successfully started the viewer.
test("`open` degrades to the printed URL when no browser opener exists", { timeout: 30_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const empty = mkdtempSync(join(tmpdir(), "codeatlas-nopath-")); // a PATH with no opener on it
  const port = await freePort();
  const viewer = await serveInBackground(port, "<!doctype html><title>CodeAtlas</title>");
  try {
    const r = spawnSync(process.execPath, [LAUNCHER, "open"], {
      encoding: "utf8",
      env: { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: String(port), PATH: empty },
    });
    assert.equal(r.status, 0, `open must not fail once the viewer is up: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`http://localhost:${port}/`), "the URL is the fallback");
    assert.doesNotMatch(r.stderr, /Unhandled 'error' event|ERR_UNHANDLED_ERROR/, "the spawn failure must be handled");
    assert.match(r.stderr, /open .* in a browser yourself/, "and named, so the user knows what to do");
  } finally {
    viewer.kill();
    rmSync(data, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

// Two `start`s at once (the codeatlas skill and the viewer skill, or two Claude sessions)
// both cleared the port check, both spawned a vite, and the loser exited on --strictPort
// AFTER overwriting the pidfile — leaving a viewer running that `stop` refused to touch.
test("two concurrent starts serialise instead of racing for the port", { timeout: 90_000 }, async () => {
  const root = stubVitePlugin({ listenDelayMs: 1500 }); // the window the second start used to walk into
  const data = mkdtempSync(join(tmpdir(), "codeatlas-race-data-"));
  const port = await freePort();
  const env = { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  const both = ["a", "b"].map(
    () =>
      new Promise((done) => {
        const p = spawn(process.execPath, [join(root, "bin", "codeatlas-viewer.mjs"), "start"], { env });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("close", (code) => done({ code, out }));
      })
  );
  const results = await Promise.all(both);
  try {
    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `start #${i} must not fail while another start runs: ${r.out}`);
      assert.match(r.out, new RegExp(`viewer (already )?up at http://localhost:${port}/`), `start #${i}: ${r.out}`);
    }
    const pid = Number(readFileSync(join(data, "viewer.pid"), "utf8").trim());
    assert.ok(!Number.isNaN(pid));
    // The launcher's own pid verification instead of `ps`: `up (pid N)` without
    // ", unverified" means commandLine() read that process and recognised THIS plugin's
    // vite — the same claim, through the code path Windows actually uses (powershell/wmic).
    const st = runIn(root, ["status"], { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) });
    assert.equal(st.status, 0, `status must report up: ${st.stdout}${st.stderr}`);
    assert.match(st.stdout, new RegExp(`^up \\(pid ${pid}\\)$`, "m"), `the pidfile must point at the vite that actually won the port: ${st.stdout}`);
    const stopped = runIn(root, ["stop"], { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) });
    assert.equal(stopped.status, 0, `the survivor must be stoppable: ${stopped.stdout}${stopped.stderr}`);
  } finally {
    runIn(root, ["stop"], { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) });
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

// A pidfile pointing at a dead pid is worse than none: `stop` then finds nothing to kill,
// sees the port answered by whatever won it and exits 2 "not started by this launcher".
test("a vite that dies at startup leaves no pidfile behind", { timeout: 60_000 }, async () => {
  const root = stubVitePlugin({ mode: "die" });
  const data = mkdtempSync(join(tmpdir(), "codeatlas-dead-data-"));
  const port = await freePort();
  const r = runIn(root, ["start"], { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) });
  assert.equal(r.status, 1, "a vite that exits immediately is a failed start");
  assert.ok(!existsSync(join(data, "viewer.pid")), "the pidfile must not survive a start that never came up");
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

// A plugin update replaces node_modules, which a RUNNING vite never reloads — and `start`
// answered "already up" before it ever looked at the lockfiles, so the user kept serving
// the pre-update packages forever. There was no `restart` command either.
test("a dependency change under a running viewer is reported, and `restart` applies it", { timeout: 90_000 }, async () => {
  const root = stubVitePlugin();
  const data = mkdtempSync(join(tmpdir(), "codeatlas-restart-data-"));
  const port = await freePort();
  const env = { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  try {
    const started = runIn(root, ["start"], env);
    assert.equal(started.status, 0, started.stderr);
    assert.ok(existsSync(join(data, "viewer.state.json")), "what the running instance was started with must be recorded");
    const firstPid = Number(readFileSync(join(data, "viewer.pid"), "utf8").trim());

    touchLocks(root, { lockAgeS: 0, installedAgeS: 30 }); // a plugin update landed under the running viewer
    const status = runIn(root, ["status"], env);
    assert.equal(status.status, 0, "still up");
    assert.match(status.stderr, /codeatlas-viewer restart/, "`status` must say a restart is due");
    const again = runIn(root, ["start"], env);
    assert.match(again.stdout, /already up/);
    assert.match(again.stderr, /codeatlas-viewer restart/, "`start` must not just say 'already up'");

    touchLocks(root, { lockAgeS: 60, installedAgeS: 30 }); // as if the restart's install ran
    const restarted = runIn(root, ["restart"], env);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, new RegExp(`viewer up at http://localhost:${port}/`));
    const secondPid = Number(readFileSync(join(data, "viewer.pid"), "utf8").trim());
    assert.notEqual(secondPid, firstPid, "restart must actually replace the process");
    assert.doesNotMatch(runIn(root, ["status"], env).stderr, /codeatlas-viewer restart/, "and clear the notice");
  } finally {
    runIn(root, ["stop"], env);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

// The shims are what the skills actually invoke (`${CLAUDE_PLUGIN_ROOT}/bin/codeatlas-viewer`),
// and nothing in the repo ever ran one: a lost exec bit or a broken line would have shipped
// green. macOS/Linux runs the sh shim for real; the .cmd is checked byte-wise everywhere.
test("the POSIX shim runs the launcher", { skip: process.platform === "win32" }, async () => {
  const data = mkdtempSync(join(tmpdir(), "codeatlas-shim-"));
  const port = await freePort();
  const r = spawnSync(join(ROOT, "bin", "codeatlas-viewer"), ["paths"], {
    encoding: "utf8",
    env: { ...process.env, CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) },
  });
  assert.equal(r.status, 0, `${r.error?.message || ""}${r.stderr}`);
  assert.match(r.stdout, new RegExp(`LIVE_DIR=${data.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  rmSync(data, { recursive: true, force: true });
});

// The shim used to PREPEND ~/.local/bin:/opt/homebrew/bin:/usr/local/bin, which demotes a
// version-managed node (nvm, fnm, volta, asdf all sit early in PATH) to whatever stale
// binary those dirs still hold — reported as "Node.js >= 20 required, found v16".
test("the POSIX shim does not demote the node already on PATH", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "codeatlas-fakehome-"));
  const shadowDir = join(home, ".local", "bin");
  mkdirSync(shadowDir, { recursive: true });
  const shadow = join(shadowDir, "node");
  writeFileSync(shadow, "#!/bin/sh\necho FAKE-NODE-SHADOW\nexit 41\n");
  chmodSync(shadow, 0o755);
  const data = mkdtempSync(join(tmpdir(), "codeatlas-shim-"));
  const port = await freePort();
  const r = spawnSync(join(ROOT, "bin", "codeatlas-viewer"), ["paths"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      CODEATLAS_DATA: data,
      CODEATLAS_PORT: String(port),
    },
  });
  assert.doesNotMatch(r.stdout, /FAKE-NODE-SHADOW/, "$HOME/.local/bin must not outrank the node the user already has");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`URL=http://localhost:${port}/`));
  rmSync(home, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

test("the shims stay executable and cmd-parsable", () => {
  const mode = spawnSync("git", ["ls-files", "-s", "bin/codeatlas-viewer", "bin/codeatlas-viewer.mjs"], { cwd: ROOT, encoding: "utf8" });
  // A silent skip when git is missing or the tree is not a checkout meant the two cases
  // this guard exists for — a lost exec bit reaching the index — passed it unexamined.
  assert.equal(mode.status, 0, `git could not report the tracked modes, so nothing here was checked: ${mode.stderr}`);
  const lines = mode.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `both shims must be tracked; git listed ${lines.length}`);
  // the working tree can fake modes; the index is what a plugin user checks out
  for (const line of lines) assert.match(line, /^100755 /, `${line.split("\t")[1]} must be committed executable`);
  const cmd = readFileSync(join(ROOT, "bin", "codeatlas-viewer.cmd"));
  assert.ok(!cmd.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "a BOM makes cmd.exe echo garbage");
  const text = cmd.toString("utf8");
  assert.match(text, /node "%~dp0codeatlas-viewer\.mjs" %\*/);
  assert.ok(text.endsWith("\r\n"), "cmd.exe needs CRLF (see .gitattributes) — a stripped CR breaks the last line");
  assert.equal(text.split("\n").length - 1, text.split("\r\n").length - 1, "every line must be CRLF-terminated");
});

/** A copy of one of the shell tools, in a throwaway tree, so running it cannot touch the real machine. */
function scriptCopy(name, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(ROOT, "tools", name), dest);
  chmodSync(dest, 0o755);
  return dest;
}

// launchd's KeepAlive relaunches serve.sh on every non-zero exit. A checkout under
// ~/Documents / ~/Desktop / ~/Downloads is unreadable to a launchd-spawned process (TCC),
// and so is one that has been moved — every path out of the script was then non-zero, i.e.
// a process spawn and a log line every ThrottleInterval, forever.
// (POSIX only: serve.sh is the launchd/nohup path, and Windows never runs it.)
test("serve.sh exits 0 when it cannot read the checkout", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "codeatlas-servehome-"));
  const script = join(home, "fake-checkout", "tools", "serve.sh");
  // there is no viewer/ next to it — the same symptom TCC produces
  scriptCopy("serve.sh", script);
  const port = await freePort();
  // pin the port off 5173 so the "already up"/"port held" branches cannot answer for the guard
  const src = readFileSync(script, "utf8").replace(/^PORT=5173$/m, `PORT=${port}`);
  assert.match(src, new RegExp(`^PORT=${port}$`, "m"), "the port pin must apply");
  writeFileSync(script, src);
  const r = spawnSync("/bin/sh", [script], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, "a non-zero exit is what makes launchd relaunch every 10 s forever");
  assert.match(r.stdout + r.stderr, /cannot read/);
  assert.match(readFileSync(join(home, "Library", "Logs", "codeatlas-viewer.log"), "utf8"), /not starting/);
  rmSync(home, { recursive: true, force: true });
});

// Installing the agent from a TCC-protected folder produced one that could never work.
// The stub PATH keeps this test away from the real launchd no matter what the script does.
test("install-launchd.sh refuses a TCC-protected checkout unless forced", { skip: process.platform !== "darwin" }, () => {
  const home = mkdtempSync(join(tmpdir(), "codeatlas-tcchome-"));
  const stubs = join(home, "stub-bin");
  mkdirSync(stubs, { recursive: true });
  for (const tool of ["launchctl", "plutil"]) {
    writeFileSync(join(stubs, tool), `#!/bin/sh\necho "stub ${tool} $*"\nexit 0\n`);
    chmodSync(join(stubs, tool), 0o755);
  }
  const script = join(home, "Documents", "CodeAtlas", "tools", "install-launchd.sh");
  scriptCopy("install-launchd.sh", script);
  cpSync(join(ROOT, "tools", "launchd"), join(dirname(script), "launchd"), { recursive: true });
  const env = { ...process.env, HOME: home, PATH: `${stubs}:/usr/bin:/bin` };
  const dest = join(home, "Library", "LaunchAgents", "com.codeatlas.viewer.plist");

  const refused = spawnSync("/bin/sh", [script], { encoding: "utf8", env });
  assert.equal(refused.status, 1, "installing an agent that can never read its own checkout is a failure");
  assert.match(refused.stderr, /TCC-protected/);
  assert.ok(!existsSync(dest), "nothing may be installed when the check fails");

  const forced = spawnSync("/bin/sh", [script, "--force"], { encoding: "utf8", env });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /--force/);
  assert.ok(existsSync(dest), "--force still installs (Full Disk Access granted)");

  // macOS volumes are case-insensitive by default, so ~/documents IS ~/Documents and TCC
  // treats them the same. A case-SENSITIVE `case` pattern installed such a checkout
  // without so much as a warning.
  const lower = join(home, "documents", "CodeAtlas", "tools", "install-launchd.sh");
  scriptCopy("install-launchd.sh", lower);
  cpSync(join(ROOT, "tools", "launchd"), join(dirname(lower), "launchd"), { recursive: true });
  const lowerRun = spawnSync("/bin/sh", [lower], { encoding: "utf8", env });
  assert.equal(lowerRun.status, 1, `a lowercase ~/documents is the same TCC folder: ${lowerRun.stderr}`);
  assert.match(lowerRun.stderr, /TCC-protected/);
  rmSync(home, { recursive: true, force: true });
});

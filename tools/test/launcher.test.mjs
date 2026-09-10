// bin/codeatlas-viewer.mjs: paths/status without a server, then a real start/stop on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, cpSync } from "node:fs";
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
  const { createServer } = await import("node:http");
  const data = mkdtempSync(join(tmpdir(), "codeatlas-launcher-"));
  const port = await freePort();
  const env = { CODEATLAS_DATA: data, CODEATLAS_PORT: String(port) };
  // 5173 is Vite's own default port: another project's dev server answers 200 here
  const foreign = createServer((_q, res) => res.end("<!doctype html><title>Some Other App</title>"));
  await new Promise((r) => foreign.listen(port, "127.0.0.1", r));
  try {
    const st = run(["status"], env);
    assert.equal(st.status, 1, "a foreign 200 is not 'up'");
    assert.match(st.stdout, /^down \(port :\d+ is held by something that is not the viewer\)/);
    const start = run(["start"], env);
    assert.equal(start.status, 1, "start must refuse rather than claim success");
    assert.match(start.stderr, /held by another process/);
  } finally {
    await new Promise((r) => foreign.close(r));
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
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

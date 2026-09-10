// fs2ir tests — run: `cd tools && npm test`  (node:test, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, openSync, ftruncateSync, closeSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const FS2IR = join(repo, "tools/fs2ir.mjs");
const VALIDATE = join(repo, "schema/validate.mjs");
const byteSort = (ids) => [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

function run(dir, ...flags) {
  return JSON.parse(execFileSync("node", [FS2IR, dir, ...flags], { encoding: "utf8" }));
}
function runRaw(...args) {
  const r = spawnSync("node", [FS2IR, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function kinds(ir) {
  const k = {};
  for (const n of ir.nodes) k[n.kind] = (k[n.kind] ?? 0) + 1;
  return k;
}
function validate(ir) {
  const dir = mkdtempSync(join(tmpdir(), "fs2ir-validate-"));
  const p = join(dir, "g.json");
  writeFileSync(p, JSON.stringify(ir));
  try {
    execFileSync("node", [VALIDATE, p], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function withTmp(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function sparseFile(path, bytes) {
  const fd = openSync(path, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}
const WIN = process.platform === "win32";

/**
 * A small nested tree: 3 dirs (root, Sources, Sources/Tiny) and 6 docs.
 * Was `fixtures/tiny` until the Swift analyzer was cut (2026-09-10); built here so
 * the tools suite owns its fixtures and depends on nothing else in the repo.
 * Returns the realpath, so `attrs.absRoot` comparisons hold where $TMPDIR is a symlink.
 */
function tinyTree(dir) {
  const root = realpathSync(dir);
  mkdirSync(join(root, "Sources", "Tiny"), { recursive: true });
  writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n");
  writeFileSync(join(root, "expected-ir.json"), "{}\n");
  writeFileSync(join(root, "expected-syntax.json"), "{}\n");
  for (const f of ["App.swift", "ConsoleGreeter.swift", "Greeter.swift"])
    writeFileSync(join(root, "Sources", "Tiny", f), `// ${f}\n`);
  return root;
}

// Make a directory unlistable for the current user: chmod 000 on POSIX; on Windows an explicit
// deny of "read data / list directory" (RD) through icacls, which needs no elevation.
const me = process.env.USERNAME || userInfo().username;
function lockDir(p) {
  if (WIN) execFileSync("icacls", [p, "/deny", me + ":(RD)"], { stdio: "ignore" });
  else chmodSync(p, 0o000);
}
function unlockDir(p) {
  if (WIN) execFileSync("icacls", [p, "/remove:d", me], { stdio: "ignore" });
  else chmodSync(p, 0o755);
}

test("nested tree → 3 dirs + 6 docs, contains-only, validates, root-relative locs", () => {
  withTmp("fs2ir-tiny-", (tmp) => {
    const dir = tinyTree(tmp);
    const ir = run(dir);
    // Package.swift + expected-ir.json + expected-syntax.json + 3 sources (.build is skipped)
    assert.deepEqual(kinds(ir), { dir: 3, doc: 6 });
    assert.equal(ir.root, "dir:.");
    assert.ok(ir.edges.every((e) => e.kind === "contains"));
    assert.equal(ir.edges.length, ir.nodes.length - 1);
    const root = ir.nodes.find((n) => n.id === "dir:.");
    assert.equal(root.parent, undefined);
    assert.equal(root.attrs.absRoot, dir);
    const app = ir.nodes.find((n) => n.id === "doc:Sources/Tiny/App.swift");
    assert.deepEqual(app.loc, { file: "Sources/Tiny/App.swift", line: 1, col: 1 });
    assert.ok(app.metrics.bytes > 0);
    assert.equal(app.attrs, undefined); // no --sizes → no scale
    // sorted by id (UTF-8 byte order)
    const ids = ir.nodes.map((n) => n.id);
    assert.deepEqual(ids, byteSort(ids));
    assert.deepEqual(ir.edges.map((e) => e.id), byteSort(ir.edges.map((e) => e.id)));
    validate(ir);
  });
});

test("--abs-locs emits absolute paths", () => {
  withTmp("fs2ir-abs-", (tmp) => {
    const dir = tinyTree(tmp);
    const ir = run(dir, "--abs-locs");
    const app = ir.nodes.find((n) => n.id === "doc:Sources/Tiny/App.swift");
    assert.equal(app.loc.file, join(dir, "Sources", "Tiny", "App.swift"));
  });
});

test("--max-children 1 truncates files AND dirs with explicit overflow nodes (root id overflow:.)", () => {
  withTmp("fs2ir-overflow-", (dir) => {
    for (const d of ["a", "b", "c"]) mkdirSync(join(dir, d));
    for (const f of ["x.txt", "y.txt"]) writeFileSync(join(dir, f), "1");
    const ir = run(dir, "--max-children", "1");
    assert.deepEqual(kinds(ir), { dir: 2, doc: 1, overflow: 1 });
    const ov = ir.nodes.find((n) => n.kind === "overflow");
    assert.equal(ov.id, "overflow:.");
    assert.equal(ov.parent, "dir:.");
    assert.deepEqual(ov.attrs, { elided: 3, reason: "max-children" }); // 2 dirs + 1 file
    assert.equal(ov.name, "… +3 more");
    assert.ok(ir.edges.some((e) => e.id === "e:contains:dir:.->overflow:."));
    validate(ir);
  });
});

test("a directory literally named _root no longer collides with the root overflow id", () => {
  withTmp("fs2ir-rootname-", (dir) => {
    mkdirSync(join(dir, "_root"));
    mkdirSync(join(dir, "b"));
    for (const f of ["x.txt", "y.txt"]) writeFileSync(join(dir, "_root", f), "1");
    const ir = run(dir, "--max-children", "1");
    const ids = ir.nodes.filter((n) => n.kind === "overflow").map((n) => n.id).sort();
    assert.deepEqual(ids, ["overflow:.", "overflow:_root"]); // root's + _root's own, distinct
    assert.equal(new Set(ir.nodes.map((n) => n.id)).size, ir.nodes.length);
    validate(ir);
  });
});

test("--depth 0 elides everything under the root with reason 'depth limit'", () => {
  withTmp("fs2ir-depth-", (dir) => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "f.txt"), "1");
    const ir = run(dir, "--depth", "0");
    assert.deepEqual(kinds(ir), { dir: 1, overflow: 1 });
    assert.deepEqual(ir.nodes.find((n) => n.kind === "overflow").attrs, { elided: 2, reason: "depth limit" });
    validate(ir);
  });
});

test("bad root: nonexistent path and plain file exit 1 with a message, no JSON", () => {
  const missing = runRaw(join(tmpdir(), "fs2ir-does-not-exist-" + process.pid));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /root does not exist/);
  assert.equal(missing.out, "");
  withTmp("fs2ir-file-root-", (dir) => {
    writeFileSync(join(dir, "plain.txt"), "x");
    const r = runRaw(join(dir, "plain.txt"));
    assert.equal(r.code, 1);
    assert.match(r.err, /root is not a directory/);
    assert.equal(r.out, "");
  });
});

test("--depth/--max-children reject NaN, negative, non-integer, missing (exit 2)", () => {
  const tiny = here; // any existing directory: flags are rejected before the walk
  for (const [flag, value] of [
    ["--depth", "abc"], ["--depth", "-1"], ["--depth", "1.5"], ["--depth", "NaN"],
    ["--max-children", "x"], ["--max-children", "-3"], ["--max-children", "2.0"],
  ]) {
    const r = runRaw(tiny, flag, value);
    assert.equal(r.code, 2, `${flag} ${value} should exit 2 (got ${r.code})`);
    assert.match(r.err, new RegExp(`${flag} expects a non-negative integer`));
  }
  const missing = runRaw(tiny, "--depth");
  assert.equal(missing.code, 2);
  assert.match(missing.err, /got nothing/);
  const unknown = runRaw(tiny, "--bogus");
  assert.equal(unknown.code, 2);
  assert.equal(runRaw(tiny, "--depth", "0").code, 0); // zero is a valid non-negative integer
});

test("--sizes sets attrs.scale = clamp(1 + log10(max(bytes,1)/1024)/2, 1, 2.6) on doc nodes", () => {
  withTmp("fs2ir-sizes-", (dir) => {
    sparseFile(join(dir, "empty.bin"), 0);
    sparseFile(join(dir, "tiny.bin"), 10);
    sparseFile(join(dir, "k1.bin"), 1024);
    sparseFile(join(dir, "k10.bin"), 10 * 1024);
    sparseFile(join(dir, "k100.bin"), 100 * 1024);
    sparseFile(join(dir, "m1.bin"), 1024 * 1024);
    sparseFile(join(dir, "m40.bin"), 40 * 1024 * 1024);
    const ir = run(dir, "--sizes");
    const scale = (name) => ir.nodes.find((n) => n.id === `doc:${name}`).attrs.scale;
    assert.equal(scale("empty.bin"), 1);
    assert.equal(scale("tiny.bin"), 1);
    assert.equal(scale("k1.bin"), 1);
    assert.equal(scale("k10.bin"), 1.5);
    assert.equal(scale("k100.bin"), 2);
    assert.equal(scale("m1.bin"), 2.51); // log10(1024) = 3.0103
    assert.equal(scale("m40.bin"), 2.6);
    assert.equal(ir.nodes.find((n) => n.id === "doc:m40.bin").metrics.bytes, 40 * 1024 * 1024);
    assert.ok(ir.nodes.filter((n) => n.kind === "dir").every((n) => n.attrs?.scale === undefined));
    validate(ir);
    const plain = run(dir);
    assert.ok(plain.nodes.every((n) => n.attrs?.scale === undefined));
  });
});

test("hidden entries are excluded by default (counted as skipped.ignored) and included with --include-hidden", () => {
  withTmp("fs2ir-hidden-", (dir) => {
    writeFileSync(join(dir, ".secret"), "s");
    mkdirSync(join(dir, ".hiddendir"));
    writeFileSync(join(dir, ".hiddendir", "inner.txt"), "i");
    writeFileSync(join(dir, "shown.txt"), "v");
    const ir = run(dir);
    assert.deepEqual(ir.nodes.map((n) => n.id), ["dir:.", "doc:shown.txt"]);
    assert.deepEqual(ir.nodes[0].attrs.skipped, { ignored: 2 });
    const all = run(dir, "--include-hidden");
    assert.deepEqual(kinds(all), { dir: 2, doc: 3 });
    assert.equal(all.nodes.find((n) => n.id === "dir:.").attrs.skipped, undefined);
  });
});

test("--ignore names and default ignores (node_modules) are counted, never silent", () => {
  withTmp("fs2ir-ignore-", (dir) => {
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "vendor"));
    writeFileSync(join(dir, "keep.txt"), "k");
    const ir = run(dir, "--ignore", "vendor");
    assert.deepEqual(kinds(ir), { dir: 1, doc: 1 });
    assert.deepEqual(ir.nodes.find((n) => n.id === "dir:.").attrs.skipped, { ignored: 2 });
    validate(ir);
  });
});

test("FIFOs are skipped and counted in attrs.skipped.fifo on the containing dir", { skip: WIN && "no FIFOs on Windows" }, () => {
  withTmp("fs2ir-fifo-", (dir) => {
    mkdirSync(join(dir, "sub"));
    execFileSync("mkfifo", [join(dir, "sub", "pipe")]);
    writeFileSync(join(dir, "sub", "f.txt"), "f");
    const ir = run(dir);
    assert.deepEqual(kinds(ir), { dir: 2, doc: 1 });
    const sub = ir.nodes.find((n) => n.id === "dir:sub");
    assert.deepEqual(sub.attrs, { skipped: { fifo: 1 } });
    assert.equal(ir.nodes.find((n) => n.id === "dir:.").attrs.skipped, undefined);
    validate(ir);
  });
});

test("unreadable directory stays a leaf and reports attrs.skipped.unreadable", { skip: !WIN && process.getuid?.() === 0 && "root can read anything" }, () => {
  withTmp("fs2ir-unreadable-", (dir) => {
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "hidden.txt"), "h");
    lockDir(join(dir, "locked"));
    try {
      const ir = run(dir);
      const locked = ir.nodes.find((n) => n.id === "dir:locked");
      assert.deepEqual(locked.attrs, { skipped: { unreadable: 1 } });
      assert.ok(!ir.nodes.some((n) => n.id === "doc:locked/hidden.txt"));
      validate(ir);
    } finally {
      unlockDir(join(dir, "locked"));
    }
  });
});

test("directory listing and ids use UTF-8 byte order (U+FF01 before U+1F600)", () => {
  withTmp("fs2ir-bytes-", (dir) => {
    writeFileSync(join(dir, "\u{1F600}.txt"), "e");
    writeFileSync(join(dir, "！.txt"), "f");
    const ir = run(dir);
    const ids = ir.nodes.map((n) => n.id);
    assert.deepEqual(ids, ["dir:.", "doc:！.txt", "doc:\u{1F600}.txt"]);
    assert.deepEqual(ids, byteSort(ids));
    validate(ir);
  });
});

test(
  "names an IR id or a relative loc cannot carry are counted, never emitted",
  { skip: WIN && "newlines and backslashes are illegal in Windows filenames" },
  () => {
    withTmp("fs2ir-badnames-", (dir) => {
      writeFileSync(join(dir, "we\nird.txt"), "1");   // a line terminator can never appear in an id
      writeFileSync(join(dir, "back\\slash.txt"), "1"); // a backslash breaks the relative-loc contract
      mkdirSync(join(dir, "sub\rdir"));
      writeFileSync(join(dir, "sub\rdir", "inner.txt"), "1");
      writeFileSync(join(dir, "fine.txt"), "1");
      const ir = run(dir);
      assert.deepEqual(ir.nodes.map((n) => n.id), ["dir:.", "doc:fine.txt"]);
      assert.deepEqual(ir.nodes[0].attrs.skipped, { unrepresentable: 3 });
      validate(ir); // used to emit an IR its own validator rejected, naming no path
    });
  }
);

test("symlinks become link nodes with attrs.target (dir and file links, not followed)", (t) => {
  withTmp("fs2ir-links-", (dir) => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "f.txt"), "f");
    try {
      symlinkSync("real", join(dir, "link"));           // dir symlink
      symlinkSync("real/f.txt", join(dir, "flink"));    // file symlink
      symlinkSync(join(dir, "real"), join(dir, "real", "loop")); // cycle bait
    } catch (e) {
      if (e.code !== "EPERM") throw e;
      return t.skip("symlink creation needs Developer Mode or elevation on Windows");
    }
    const ir = run(dir);
    assert.deepEqual(kinds(ir), { dir: 2, doc: 1, link: 3 });
    const link = ir.nodes.find((n) => n.id === "link:link");
    assert.equal(link.parent, "dir:.");
    assert.deepEqual(link.attrs, { target: "real" });
    assert.deepEqual(link.loc, { file: "link", line: 1, col: 1 });
    assert.ok(ir.nodes.some((n) => n.id === "link:real/loop"));
    assert.ok(ir.edges.some((e) => e.id === "e:contains:dir:.->link:flink"));
    validate(ir);
  });
});

test("--max-nodes caps the whole walk with an explicit overflow (never silently)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs2ir-budget-"));
  for (let d = 0; d < 6; d++) {
    mkdirSync(join(dir, `d${d}`));
    for (let f = 0; f < 6; f++) writeFileSync(join(dir, `d${d}`, `f${f}.txt`), "x");
  }
  const ir = run(dir, "--max-nodes", "12");
  const overflow = ir.nodes.filter((n) => n.kind === "overflow");
  assert.ok(overflow.length >= 1, "an overflow node is emitted");
  assert.ok(overflow.some((n) => n.attrs.reason === "node budget"));
  const elided = overflow.reduce((s, n) => s + n.attrs.elided, 0);
  const real = ir.nodes.filter((n) => n.kind !== "overflow").length;
  // budget 12: root + d0 + its 6 files + d1 + 3 of its files; an elided
  // directory counts as ONE entry (same convention as --max-children)
  assert.equal(real, 12, "stops at the budget");
  assert.equal(elided, 4 + 3, "remaining direct entries are counted, never dropped");
  rmSync(dir, { recursive: true, force: true });
});

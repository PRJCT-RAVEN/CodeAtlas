// Validator tests — run: `cd schema && npm test`  (node:test, no extra deps).
// Every fixture is generated here; each adversarial case asserts the exit code AND
// that the one-line error names the offending id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "../validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(here, "..", "validate.mjs");

const ROOT = "module:App";
const A = "type:App/A";
const B = "type:App/B";
const F = "func:App/A.run()";

function contains(from, to) {
  return { id: `e:contains:${from}->${to}`, kind: "contains", from, to };
}
const byteCmp = (x, y) => Buffer.compare(Buffer.from(x.id), Buffer.from(y.id));

/** A small, fully valid v0.2 document: root → A, B; A → run(); run() calls B. */
function base() {
  const nodes = [
    { id: ROOT, kind: "module", name: "App", loc: { file: "Sources/App/App.swift", line: 1, col: 1 } },
    { id: A, kind: "type", name: "A", parent: ROOT, loc: { file: "Sources/App/A.swift", line: 3, col: 1 }, attrs: { typeKind: "struct" } },
    { id: B, kind: "type", name: "B", parent: ROOT, loc: { file: "Sources/App/B.swift", line: 3, col: 1 } },
    { id: F, kind: "function", name: "run()", parent: A, loc: { file: "Sources/App/A.swift", line: 5, col: 5 } },
  ];
  const edges = [
    contains(ROOT, A),
    contains(ROOT, B),
    contains(A, F),
    { id: `e:calls:${F}->${B}`, kind: "calls", from: F, to: B, locs: [{ file: "Sources/App/A.swift", line: 6, col: 9 }], count: 1 },
  ];
  nodes.sort(byteCmp);
  edges.sort(byteCmp);
  return { irVersion: "0.2", generator: { tool: "test", version: "1", commit: null }, root: ROOT, nodes, edges };
}

function run(doc, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "validate-test-"));
  const files = (Array.isArray(doc) ? doc : [doc]).map((d, i) => {
    const p = join(dir, `g${i}.json`);
    writeFileSync(p, typeof d === "string" ? d : JSON.stringify(d));
    return p;
  });
  try {
    const r = spawnSync("node", [VALIDATE, ...flags, ...files], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectInvalid(doc, ...mustMention) {
  const r = run(doc);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`);
  assert.match(r.err, /^INVALID: /m);
  for (const s of mustMention)
    assert.ok(r.err.includes(s), `stderr should mention ${JSON.stringify(s)}:\n${r.err}`);
  assert.ok(!/TypeError|RangeError|at .*\.mjs:\d+/.test(r.err), `validator crashed:\n${r.err}`);
  return r;
}
function expectValid(doc, ...flags) {
  const r = run(doc, ...flags);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`);
  return r;
}
const node = (doc, id) => doc.nodes.find((n) => n.id === id);
const edge = (doc, id) => doc.edges.find((e) => e.id === id);

// --- must pass ---------------------------------------------------------------

test("base fixture is VALID", () => {
  const r = expectValid(base());
  assert.match(r.out, /^VALID: /);
});

test("count without locs passes (multiplicity of a conceptual edge)", () => {
  const d = base();
  const e = edge(d, `e:calls:${F}->${B}`);
  delete e.locs;
  e.count = 3;
  expectValid(d);
});

test("attrs.typeKind accepts any string (interface) and null", () => {
  const d = base();
  node(d, A).attrs.typeKind = "interface";
  node(d, B).attrs = { typeKind: null };
  expectValid(d);
});

test("loc.col is optional", () => {
  const d = base();
  for (const n of d.nodes) if (n.loc) delete n.loc.col;
  for (const e of d.edges) for (const l of e.locs ?? []) delete l.col;
  expectValid(d);
});

test("top-level title and description are accepted", () => {
  const d = base();
  d.title = "Auth flow";
  d.description = "Who calls whom during login; tests cut.";
  expectValid(d);
});

test("annotations: summary/importance/label/collapsedByDefault/inferred + extra keys", () => {
  const d = base();
  d.annotations = {
    [A]: { summary: "entry point", importance: 0.9, collapsedByDefault: true, custom: 1 },
    [`e:calls:${F}->${B}`]: { inferred: true, label: "dynamic dispatch" },
  };
  expectValid(d);
});

test("new attrs: absRoot, scale, isCase, skipped", () => {
  const d = base();
  node(d, ROOT).attrs = { absRoot: "/repo", skipped: { fifo: 1, ignored: 2 } };
  node(d, B).attrs = { scale: 1.75, isCase: true };
  expectValid(d);
});

test("irVersion 0.1 still accepted", () => {
  const d = base();
  d.irVersion = "0.1";
  expectValid(d);
});

test("UTF-8 byte order: U+FF01 (EF BC 81) sorts before U+1F600 (F0 9F 98 80)", () => {
  const d = base();
  const ids = ["type:App/！", "type:App/\u{1F600}"];
  for (const id of ids) {
    d.nodes.push({ id, kind: "type", name: id.slice(9), parent: ROOT });
    d.edges.push(contains(ROOT, id));
  }
  d.nodes.sort(byteCmp);
  d.edges.sort(byteCmp);
  // sanity: JS string order would put the emoji (surrogate D83D) first — byte order differs
  assert.notDeepEqual([...ids].sort(), ids.sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))));
  expectValid(d);
});

// --- must fail ---------------------------------------------------------------

test("parent cycle A -> B -> A", () => {
  const d = base();
  node(d, A).parent = B;
  node(d, B).parent = A;
  d.edges = d.edges.filter((e) => e.kind !== "contains" || ![A, B].includes(e.to));
  d.edges.push(contains(B, A), contains(A, B));
  d.edges.sort(byteCmp);
  expectInvalid(d, "parent cycle", A, B);
});

test("self-parent", () => {
  const d = base();
  node(d, B).parent = B;
  d.edges = d.edges.filter((e) => e.to !== B || e.kind !== "contains");
  d.edges.push(contains(B, B));
  d.edges.sort(byteCmp);
  expectInvalid(d, "is its own parent", B);
});

test("orphan chain: child hangs off a second root", () => {
  const d = base();
  const orphanRoot = "module:Other";
  const orphanChild = "type:Other/X";
  d.nodes.push({ id: orphanRoot, kind: "module", name: "Other" });
  d.nodes.push({ id: orphanChild, kind: "type", name: "X", parent: orphanRoot });
  d.edges.push(contains(orphanRoot, orphanChild));
  d.nodes.sort(byteCmp);
  d.edges.sort(byteCmp);
  expectInvalid(d, `parent chain of ${orphanChild} ends at ${orphanRoot}`);
});

test("two roots", () => {
  const d = base();
  delete node(d, B).parent;
  d.edges = d.edges.filter((e) => e.id !== `e:contains:${ROOT}->${B}`);
  expectInvalid(d, "exactly one node", B);
});

test("unknown parent", () => {
  const d = base();
  node(d, B).parent = "type:App/Ghost";
  expectInvalid(d, "unknown parent", "type:App/Ghost", B);
});

test("duplicate node id", () => {
  const d = base();
  d.nodes.push({ ...node(d, B) });
  d.nodes.sort(byteCmp);
  expectInvalid(d, "duplicate node id", B);
});

test("duplicate edge id", () => {
  const d = base();
  d.edges.push({ ...edge(d, `e:calls:${F}->${B}`) });
  d.edges.sort(byteCmp);
  expectInvalid(d, "duplicate edge id", `e:calls:${F}->${B}`);
});

test("wrong edge id", () => {
  const d = base();
  const e = edge(d, `e:calls:${F}->${B}`);
  e.id = `e:calls:${F}->${A}`;
  d.edges.sort(byteCmp);
  expectInvalid(d, "edge id mismatch", `e:calls:${F}->${A}`, `e:calls:${F}->${B}`);
});

test("unsorted: UTF-16 order (emoji first) is rejected in favour of UTF-8 byte order", () => {
  const d = base();
  const ids = ["type:App/！", "type:App/\u{1F600}"];
  for (const id of ids) {
    d.nodes.push({ id, kind: "type", name: id.slice(9), parent: ROOT });
    d.edges.push(contains(ROOT, id));
  }
  const utf16 = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); // JS `<` = UTF-16 code units (the old validator's mistake)
  d.nodes.sort(utf16);
  d.edges.sort(utf16);
  assert.equal(d.nodes.at(-2).id, "type:App/\u{1F600}"); // emoji before U+FF01 in UTF-16
  expectInvalid(d, "not sorted by id (UTF-8 byte order)", "type:App/\u{1F600}");
});

test("unsorted: plain ASCII swap", () => {
  const d = base();
  [d.nodes[0], d.nodes[1]] = [d.nodes[1], d.nodes[0]];
  expectInvalid(d, "nodes not sorted by id");
});

test("contains edge disagrees with the child's parent", () => {
  const d = base();
  // B.parent is root, but an extra contains edge claims A contains B
  d.edges.push(contains(A, B));
  d.edges.sort(byteCmp);
  expectInvalid(d, `contains edge e:contains:${A}->${B} but ${B}.parent is ${ROOT}`);
});

test("contains edge pointing at the root", () => {
  const d = base();
  d.edges.push(contains(A, ROOT));
  d.edges.sort(byteCmp);
  expectInvalid(d, `contains edge e:contains:${A}->${ROOT}`, "absent (root)");
});

test("missing mirrored contains edge", () => {
  const d = base();
  d.edges = d.edges.filter((e) => e.id !== `e:contains:${A}->${F}`);
  expectInvalid(d, `node ${F} has parent ${A} but no mirrored edge e:contains:${A}->${F}`);
});

test("count ≠ locs.length", () => {
  const d = base();
  edge(d, `e:calls:${F}->${B}`).count = 2;
  expectInvalid(d, `edge e:calls:${F}->${B}: count=2 but locs.length=1`);
});

test("duplicate cluster id", () => {
  const d = base();
  d.clusters = [
    { id: "cluster:core", name: "Core", members: [A], source: "agent" },
    { id: "cluster:core", name: "Core again", members: [B], source: "agent" },
  ];
  expectInvalid(d, "duplicate cluster id: cluster:core");
});

test("cluster with unknown member; annotation for unknown id", () => {
  const d = base();
  d.clusters = [{ id: "cluster:x", name: "X", members: ["type:App/Nope"], source: "mechanical" }];
  d.annotations = { "type:App/Nada": { summary: "?" } };
  expectInvalid(d, "cluster cluster:x: unknown member type:App/Nope", "annotation for unknown id: type:App/Nada");
});

test("unknown edge target and source", () => {
  const d = base();
  d.edges.push({ id: "e:calls:type:App/Q->type:App/R", kind: "calls", from: "type:App/Q", to: "type:App/R" });
  d.edges.sort(byteCmp);
  expectInvalid(d, "unknown from type:App/Q", "unknown to type:App/R");
});

test("schema violation: unknown top-level key, bad loc", () => {
  const d = base();
  d.bogus = 1;
  node(d, A).loc = { file: "x", line: 0 };
  const r = expectInvalid(d, "additional properties", "bogus");
  assert.match(r.err, /line must be >= 1/);
});

test("root missing from nodes", () => {
  const d = base();
  d.root = "module:Missing";
  expectInvalid(d, "root module:Missing not present in nodes");
});

test("non-JSON and non-object documents", () => {
  expectInvalid("{not json", "not readable/parseable JSON");
  expectInvalid("[]", "must be");
  expectInvalid("null", "must be");
});

test("relative loc.file with backslashes is rejected; absolute paths are left alone", () => {
  const d = base();
  node(d, A).loc = { file: "Sources\\App\\A.swift", line: 3 };
  // the path is JSON-quoted in the message, so a backslash shows as an escaped pair —
  // that is what keeps a loc.file with a newline in it from breaking one-error-per-line
  expectInvalid(d, `node ${A}`, '"Sources\\\\App\\\\A.swift"', "forward slashes");
  const withEdgeLoc = base();
  edge(withEdgeLoc, `e:calls:${F}->${B}`).locs = [{ file: "Sources\\App\\A.swift", line: 6 }];
  expectInvalid(withEdgeLoc, `edge e:calls:${F}->${B}`, "forward slashes");
  // The contract is about RELATIVE paths: an absolute Windows path (or a UNC one) is legal.
  const abs = base();
  node(abs, A).loc = { file: "C:\\src\\App\\A.swift", line: 3 };
  node(abs, B).loc = { file: "\\\\build\\share\\B.swift", line: 3 };
  expectValid(abs);
});

test("an edge kind outside [a-z][a-z0-9_]* is reported on the kind, not only on the id", () => {
  const d = base();
  const e = edge(d, `e:calls:${F}->${B}`);
  e.kind = "routes-to";
  e.id = `e:routes-to:${F}->${B}`;
  d.edges.sort(byteCmp);
  const r = expectInvalid(d, "must match pattern", "routes-to");
  assert.match(r.err, /\/edges\/\d+\/kind must match pattern/);
});

test("a pattern error names the offending value, quoted so it stays on one line", () => {
  const d = base();
  const bad = "doc:we\nird.txt"; // a real filename fs2ir once turned into an id
  d.nodes.push({ id: bad, kind: "doc", name: "weird", parent: ROOT });
  d.edges.push(contains(ROOT, bad));
  d.nodes.sort(byteCmp);
  d.edges.sort(byteCmp);
  const r = expectInvalid(d, "must match pattern", '"doc:we\\nird.txt"');
  assert.ok(!r.err.includes(bad), `the raw newline must not break the one-error-per-line output:\n${r.err}`);
});

test("130k schema errors are capped instead of overflowing the stack (~8 s)", () => {
  // The old code spread the whole ajv error array into push() as call arguments; past
  // ~120k V8 threw RangeError, which the CLI caught and mislabelled as a parse error.
  const nodes = [{ id: ROOT, kind: "module", name: "App" }];
  for (let i = 0; i < 130_000; i++) nodes.push(i); // every item: "must be object"
  const errors = validateDocument({
    irVersion: "0.2", generator: { tool: "test", version: "1", commit: null },
    root: ROOT, nodes, edges: [],
  });
  assert.equal(errors.length, 200); // MAX_SCHEMA_ERRORS; the rest are COUNTED, not formatted
  assert.match(errors[0], /\/nodes\/1 must be object/);
  // The count of what was dropped rides alongside as a non-enumerable property: a summary
  // string in the array itself sat at index 200, past the CLI's own 50-line cut, so it
  // never printed — and the line that did print said "and 151 more" for 130k errors.
  assert.equal(errors.dropped, 129_800);
  assert.ok(!Object.keys(errors).includes("dropped"), "dropped must not be enumerable");
  assert.ok(!errors.some((e) => /more schema errors/.test(e)), "no summary string among the messages");
});

test("the CLI's \u201c… and N more\u201d counts every problem, not just the ones it formatted", () => {
  const nodes = [{ id: ROOT, kind: "module", name: "App" }];
  for (let i = 0; i < 1_000; i++) nodes.push(i);
  const r = run(JSON.stringify({
    irVersion: "0.2", generator: { tool: "test", version: "1", commit: null },
    root: ROOT, nodes, edges: [],
  }));
  assert.equal(r.code, 1);
  // 1,000 bad nodes → ajv reports one "must be object" each (plus the parent chain checks
  // it cannot run). 50 are printed; the tail line must not claim only 151 are left.
  const m = r.err.match(/… and (\d+) more/);
  assert.ok(m, `expected a truncation line:\n${r.err}`);
  assert.ok(Number(m[1]) >= 900, `the truncation line must count real problems, got "${m[0]}"`);
});

// --- --patch -----------------------------------------------------------------

test("--patch with null does not crash (INVALID, exit 1)", () => {
  const r = run("null", "--patch");
  assert.equal(r.code, 1);
  assert.match(r.err, /INVALID/);
  assert.match(r.err, /patch must be a JSON object, got null/);
  assert.ok(!/TypeError/.test(r.err), r.err);
});

test("--patch touching nodes is rejected", () => {
  const r = run({ nodes: [], annotations: {} }, "--patch");
  assert.equal(r.code, 1);
  assert.match(r.err, /forbidden top-level key\(s\): nodes/);
});

test("--patch with clusters + annotations is VALID; duplicate cluster id rejected", () => {
  const ok = run({ clusters: [{ id: "cluster:a", name: "A", members: [A], source: "agent" }], annotations: { [A]: { summary: "s" } } }, "--patch");
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /VALID: .* \(agent patch\)/);
  const dup = run({ clusters: [
    { id: "cluster:a", name: "A", members: [A], source: "agent" },
    { id: "cluster:a", name: "A2", members: [B], source: "agent" },
  ] }, "--patch");
  assert.equal(dup.code, 1);
  assert.match(dup.err, /duplicate cluster id: cluster:a/);
});

// --- CLI ---------------------------------------------------------------------

test("--quiet prints nothing; exit code only", () => {
  const bad = base();
  bad.nodes.push({ ...node(bad, B) });
  bad.nodes.sort(byteCmp);
  const r = run(bad, "--quiet");
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.equal(r.err, "");
  const ok = run(base(), "-q");
  assert.equal(ok.code, 0);
  assert.equal(ok.out + ok.err, "");
});

test("multiple files: each reported, exit 1 if any invalid", () => {
  const bad = base();
  delete bad.root;
  const r = run([base(), bad, base()]);
  assert.equal(r.code, 1);
  assert.equal((r.out.match(/^VALID: /gm) ?? []).length, 2);
  assert.equal((r.err.match(/^INVALID: /gm) ?? []).length, 1);
  const all = run([base(), base()]);
  assert.equal(all.code, 0);
  assert.equal((all.out.match(/^VALID: /gm) ?? []).length, 2);
});

test("invoked through a symlinked path the CLI still validates (never a silent exit 0)", (t) => {
  // import.meta.url is realpath'd by the ESM loader, process.argv[1] is not, so the plain
  // href comparison is false for `node /tmp/…/validate.mjs` on macOS (/tmp -> /private/tmp):
  // main() never ran, nothing was printed and `validate && mv` published unchecked.
  const dir = mkdtempSync(join(tmpdir(), "validate-symlink-"));
  try {
    const link = join(dir, "validate.mjs");
    try {
      symlinkSync(VALIDATE, link);
    } catch (e) {
      if (e.code !== "EPERM") throw e;
      return t.skip("symlink creation needs Developer Mode or elevation on Windows");
    }
    const file = join(dir, "g.json");
    writeFileSync(file, JSON.stringify({}));
    const r = spawnSync("node", [link, file], { encoding: "utf8" });
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /^INVALID: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing ajv names the dependency and exits 2, not an ERR_MODULE_NOT_FOUND stack", () => {
  // The validator is what every publish goes through, so its own missing deps must be
  // actionable: subagents told to validate can neither install nor fix a resolver stack.
  const dir = mkdtempSync(join(tmpdir(), "validate-nodeps-"));
  try {
    for (const f of ["validate.mjs", "ir.schema.json"]) copyFileSync(join(here, "..", f), join(dir, f));
    const r = spawnSync("node", [join(dir, "validate.mjs"), join(dir, "ir.schema.json")], { encoding: "utf8" });
    assert.equal(r.status, 2, `expected exit 2\n${r.stderr}`);
    assert.match(r.stderr, /dependency "ajv" is not installed/);
    assert.match(r.stderr, /codeatlas-viewer\.mjs install/);
    assert.ok(!/ERR_MODULE_NOT_FOUND/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no files → usage, exit 2; unknown flag → exit 2", () => {
  const r = spawnSync("node", [VALIDATE], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  const u = spawnSync("node", [VALIDATE, "--wat", "x.json"], { encoding: "utf8" });
  assert.equal(u.status, 2);
});

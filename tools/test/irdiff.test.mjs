// irdiff tests — run: `cd tools && npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const IRDIFF = join(here, "../irdiff.mjs");

function ir(nodes, edges, extra = {}) {
  return { irVersion: "0.2", generator: { tool: "t", version: "1", commit: null }, root: "flow:main", nodes, edges, ...extra };
}
const OLD = ir(
  [
    { id: "flow:main", kind: "flow", name: "Main" },
    { id: "step:parse", kind: "step", name: "Parse", parent: "flow:main", attrs: { stage: 1 } },
    { id: "step:emit", kind: "step", name: "Emit", parent: "flow:main", loc: { file: "a.py", line: 3 } },
    { id: "store:cache", kind: "store", name: "Cache", parent: "flow:main" },
  ],
  [
    { id: "e:contains:flow:main->step:emit", kind: "contains", from: "flow:main", to: "step:emit" },
    { id: "e:contains:flow:main->step:parse", kind: "contains", from: "flow:main", to: "step:parse" },
    { id: "e:contains:flow:main->store:cache", kind: "contains", from: "flow:main", to: "store:cache" },
    { id: "e:sends:step:parse->step:emit", kind: "sends", from: "step:parse", to: "step:emit", count: 1, locs: [{ file: "a.py", line: 9 }] },
    { id: "e:writes:step:emit->store:cache", kind: "writes", from: "step:emit", to: "store:cache" },
  ],
  { title: "v1" }
);
const NEW = ir(
  [
    { id: "flow:main", kind: "flow", name: "Main" },
    { id: "step:parse", kind: "step", name: "Parse input", parent: "flow:main", attrs: { stage: 1 } }, // name changed
    { id: "step:emit", kind: "step", name: "Emit", parent: "flow:main", loc: { file: "a.py", line: 30 } }, // loc only → unchanged
    { id: "step:lint", kind: "step", name: "Lint", parent: "flow:main" }, // added
  ],
  [
    { id: "e:contains:flow:main->step:emit", kind: "contains", from: "flow:main", to: "step:emit" },
    { id: "e:contains:flow:main->step:lint", kind: "contains", from: "flow:main", to: "step:lint" },
    { id: "e:contains:flow:main->step:parse", kind: "contains", from: "flow:main", to: "step:parse" },
    { id: "e:sends:step:parse->step:emit", kind: "sends", from: "step:parse", to: "step:emit", count: 3, locs: [{ file: "a.py", line: 9 }, { file: "a.py", line: 12 }, { file: "a.py", line: 15 }] }, // count changed
  ],
  { title: "v2" }
);

function run(a, b, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "irdiff-"));
  try {
    const pa = join(dir, "old.json"), pb = join(dir, "new.json");
    writeFileSync(pa, typeof a === "string" ? a : JSON.stringify(a));
    writeFileSync(pb, typeof b === "string" ? b : JSON.stringify(b));
    const r = spawnSync("node", [IRDIFF, pa, pb, ...flags], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--json: added/removed/modified nodes and edges, locs ignored, exit 0", () => {
  const r = run(OLD, NEW, "--json");
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.deepEqual(d.nodes.added.map((n) => n.id), ["step:lint"]);
  assert.deepEqual(d.nodes.removed.map((n) => n.id), ["store:cache"]);
  assert.deepEqual(d.nodes.modified, [{ id: "step:parse", changes: { name: { from: "Parse", to: "Parse input" } } }]);
  assert.deepEqual(d.edges.added.map((e) => e.id), ["e:contains:flow:main->step:lint"]);
  assert.deepEqual(d.edges.removed.map((e) => e.id), ["e:contains:flow:main->store:cache", "e:writes:step:emit->store:cache"]);
  assert.deepEqual(d.edges.modified, [{ id: "e:sends:step:parse->step:emit", changes: { count: { from: 1, to: 3 } } }]);
  assert.deepEqual(d.document, { title: { from: "v1", to: "v2" } });
  assert.deepEqual(d.summary.nodes, { old: 4, new: 4, added: 1, removed: 1, modified: 1 });
  assert.deepEqual(d.summary.edges, { old: 5, new: 4, added: 1, removed: 2, modified: 1 });
  assert.equal(d.summary.changed, true);
});

test("readable report names every changed id", () => {
  const r = run(OLD, NEW);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^irdiff: .*old\.json → .*new\.json$/m);
  assert.match(r.out, /title: "v1" → "v2"/);
  assert.match(r.out, /^nodes: 4 → 4  \(\+1 added, -1 removed, ~1 modified\)$/m);
  assert.match(r.out, /^  \+ step:lint  \[step\] "Lint" in flow:main$/m);
  assert.match(r.out, /^  - store:cache  \[store\] "Cache" in flow:main$/m);
  assert.match(r.out, /^  ~ step:parse: name "Parse" → "Parse input"$/m);
  assert.match(r.out, /^  ~ e:sends:step:parse->step:emit: count 1 → 3$/m);
  assert.ok(!/^  ~ step:emit:/m.test(r.out), "loc-only change must not be reported as modified");
});

test("identical inputs → no changes, exit 0", () => {
  const r = run(OLD, OLD);
  assert.equal(r.code, 0);
  assert.match(r.out, /\(no changes\)/);
  const j = JSON.parse(run(OLD, OLD, "--json").out);
  assert.equal(j.summary.changed, false);
});

test("attrs deep-compare and parent moves count as modified; key order does not", () => {
  const a = ir([{ id: "x:r", kind: "x", name: "r" }, { id: "x:a", kind: "x", name: "a", parent: "x:r", attrs: { p: 1, q: [1, 2] } }], []);
  const b = ir([{ id: "x:r", kind: "x", name: "r" }, { id: "x:a", kind: "x", name: "a", parent: "x:r", attrs: { q: [1, 2], p: 1 } }], []);
  assert.equal(JSON.parse(run(a, b, "--json").out).summary.changed, false);
  const c = ir([{ id: "x:r", kind: "x", name: "r" }, { id: "x:a", kind: "x", name: "a", parent: "x:r", attrs: { p: 1, q: [1, 3] } }], []);
  const d = JSON.parse(run(a, c, "--json").out);
  assert.deepEqual(d.nodes.modified[0].changes, { attrs: { from: { p: 1, q: [1, 2] }, to: { p: 1, q: [1, 3] } } });
});

test("malformed shapes do not crash: missing arrays, non-object entries", () => {
  const r = run({ nodes: null }, { nodes: [1, null, { id: "k:1", kind: "k", name: "n" }], edges: "nope" }, "--json");
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.deepEqual(d.nodes.added.map((n) => n.id), ["k:1"]);
  assert.equal(d.summary.edges.new, 0);
});

test("unreadable / non-JSON file → exit 1; usage → exit 2", () => {
  const bad = run("{oops", OLD);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /cannot read/);
  const missing = spawnSync("node", [IRDIFF, "/nonexistent/a.json", "/nonexistent/b.json"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.equal(spawnSync("node", [IRDIFF, "only-one.json"], { encoding: "utf8" }).status, 2);
});

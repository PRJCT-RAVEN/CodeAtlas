import { describe, it, expect } from "vitest";
import { checkGraphShape } from "../src/ir/shape";
import { diffIR, isEmptyDelta } from "../src/ir/delta";
import { deltaCounts, displayEdgeDelta, removedByDisplayKey } from "../src/App";
import { buildDisplay } from "../src/layout/elk";
import { edgeKey } from "../src/ir/density";
import type { GraphIR } from "../src/ir/types";

const ok = (): GraphIR => ({
  irVersion: "0.2",
  generator: { tool: "test", version: "0", commit: null },
  root: "r",
  nodes: [
    { id: "r", kind: "view", name: "root" },
    { id: "a", kind: "step", name: "A", parent: "r" },
    { id: "b", kind: "step", name: "B", parent: "a" },
  ],
  edges: [{ id: "e:calls:a->b", kind: "calls", from: "a", to: "b" }],
});

describe("checkGraphShape (the viewer's last line of defence)", () => {
  it("accepts a valid graph", () => expect(checkGraphShape(ok())).toBeNull());
  it("rejects non-array nodes without throwing", () =>
    expect(checkGraphShape({ ...ok(), nodes: {} })).toMatch(/nodes is not an array/));
  it("rejects a node without kind", () => {
    const g = ok();
    delete (g.nodes[1] as Partial<(typeof g.nodes)[1]>).kind;
    expect(checkGraphShape(g)).toMatch(/node a has no kind/);
  });
  it("rejects a parent cycle", () => {
    const g = ok();
    g.nodes[1].parent = "b";
    expect(checkGraphShape(g)).toMatch(/cycle/);
  });
  it("rejects a self-parent", () => {
    const g = ok();
    g.nodes[2].parent = "b";
    expect(checkGraphShape(g)).toMatch(/cycle/);
  });
  it("rejects a ROOT that carries a parent — the cycle the walk cannot see", () => {
    // The walk pre-marks the root "ok" so every chain can stop there, which also makes a
    // cycle THROUGH the root invisible. Both of these used to return null ("renderable"):
    // `buildModel`'s `while (p && skip(p)) p = …` then spun forever on a three-node file
    // and wedged the tab, and the 2-cycle grew `depthOf`'s chain until `RangeError:
    // Invalid array length`. `checkGraphShape` is the ONLY gate in front of `setIR` →
    // `autoCollapse`, so nothing downstream needs its own bound — but it does need this.
    const self = ok();
    self.nodes[0].parent = "r";
    expect(checkGraphShape(self)).toMatch(/root r has a parent/);
    const two = ok();
    two.nodes[0].parent = "a";
    expect(checkGraphShape(two)).toMatch(/root r has a parent/);
    // and the property everything downstream relies on still holds for a good graph
    expect(checkGraphShape(ok())).toBeNull();
  });
  it("rejects a second parentless node", () => {
    const g = ok();
    delete g.nodes[1].parent;
    expect(checkGraphShape(g)).toMatch(/no parent but is not the root/);
  });
  it("rejects dangling edge endpoints and parents", () => {
    expect(checkGraphShape({ ...ok(), edges: [{ id: "x", kind: "calls", from: "a", to: "zz" }] })).toMatch(/unknown to zz/);
    const g = ok();
    g.nodes[2].parent = "nope";
    expect(checkGraphShape(g)).toMatch(/unknown parent nope/);
  });
  it("rejects a missing root and duplicate ids", () => {
    expect(checkGraphShape({ ...ok(), root: "q" })).toMatch(/root q is not a node/);
    const g = ok();
    g.nodes.push({ ...g.nodes[1] });
    expect(checkGraphShape(g)).toMatch(/duplicate node id a/);
  });
  it("rejects scalars and null", () => {
    expect(checkGraphShape(null)).toBeTruthy();
    expect(checkGraphShape("x")).toBeTruthy();
    expect(checkGraphShape([])).toBeTruthy();
  });
});

describe("diffIR", () => {
  it("is empty for a different view (root differs)", () => {
    const a = ok();
    const b = { ...ok(), root: "other", nodes: [{ id: "other", kind: "view", name: "o" }], edges: [] };
    expect(isEmptyDelta(diffIR(a, b as GraphIR))).toBe(true);
  });
  it("reports added / modified / removed nodes and edges, ignoring locs", () => {
    const a = ok();
    const b = ok();
    b.nodes[1].loc = { file: "x", line: 1 }; // loc only → unchanged
    b.nodes[2].name = "B2"; // modified
    b.nodes.push({ id: "c", kind: "step", name: "C", parent: "r" }); // added
    b.edges = [{ id: "e:calls:a->c", kind: "calls", from: "a", to: "c" }];
    const d = diffIR(a, b);
    expect([...d.added]).toEqual(["c"]);
    expect([...d.modified]).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect([...d.addedEdges]).toEqual(["e:calls:a->c"]);
    expect(d.removedEdges).toEqual(["e:calls:a->b"]);
    const c = ok();
    c.nodes.splice(2, 1);
    c.edges = [];
    expect(diffIR(b, c).removed).toEqual(["b", "c"]);
  });
});

describe("shape guard: review fixes (2026-09-05)", () => {
  const base = () => ({
    irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "r",
    nodes: [{ id: "r", kind: "view", name: "r" }], edges: [] as unknown[],
  });
  it("rejects duplicate edge ids and empty names", () => {
    const g = base();
    g.nodes.push({ id: "a", kind: "step", name: "a", parent: "r" } as never);
    g.edges.push({ id: "e:contains:r->a", kind: "contains", from: "r", to: "a" }, { id: "e:contains:r->a", kind: "contains", from: "r", to: "a" });
    expect(checkGraphShape(g)).toMatch(/duplicate edge id/);
    const h = base();
    h.nodes.push({ id: "b", kind: "step", name: "", parent: "r" } as never);
    expect(checkGraphShape(h)).toMatch(/no name/);
  });
  it("walks a 20k-deep parent chain in linear time and still catches a cycle", () => {
    const g = base();
    let prev = "r";
    for (let i = 0; i < 20000; i++) {
      g.nodes.push({ id: `n${i}`, kind: "type", name: `n${i}`, parent: prev } as never);
      prev = `n${i}`;
    }
    const t0 = performance.now();
    expect(checkGraphShape(g)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    const c = base();
    c.nodes.push({ id: "x", kind: "type", name: "x", parent: "y" } as never, { id: "y", kind: "type", name: "y", parent: "x" } as never);
    expect(checkGraphShape(c)).toMatch(/cycle/);
  });
});

describe("diffIR counts what is DRAWN", () => {
  const g = (nodes: [string, string, string?][], edges: [string, string, string][]) =>
    ({
      irVersion: "0.2",
      generator: { tool: "t", version: "0", commit: null },
      root: "r",
      nodes: nodes.map(([id, kind, parent]) => ({ id, kind, name: id, parent })),
      edges: edges.map(([kind, from, to]) => ({ id: `e:${kind}:${from}->${to}`, kind, from, to })),
    }) as unknown as GraphIR;

  it("a `contains` edge is hierarchy, not an addition of its own", () => {
    // It mirrors `parent`, so every added node brings one: counting them made the status bar
    // read "+2 added" for one new node, and the Key (which reads the DRAWN edges) disagreed.
    const before = g([["r", "view"], ["a", "step", "r"]], [["contains", "r", "a"]]);
    const after = g(
      [["r", "view"], ["a", "step", "r"], ["b", "step", "r"]],
      [["contains", "r", "a"], ["contains", "r", "b"], ["calls", "a", "b"]]
    );
    const d = diffIR(before, after);
    expect([...d.added]).toEqual(["b"]);
    expect([...d.addedEdges]).toEqual(["e:calls:a->b"]); // not the two `contains`
    expect(isEmptyDelta(diffIR(after, after))).toBe(true);
    // …and a removal of both still reports one node and one edge
    const back = diffIR(after, before);
    expect(back.removed).toEqual(["b"]);
    expect(back.removedEdges).toEqual(["e:calls:a->b"]);
  });
});

describe("the status bar's two halves count the same things", () => {
  it("nodes AND drawn edges, in both directions", () => {
    const mk = (nodes: string[], edges: [string, string, string][]) =>
      ({
        irVersion: "0.2",
        generator: { tool: "t", version: "0", commit: null },
        root: "r",
        nodes: [{ id: "r", kind: "view", name: "r" }, ...nodes.map((id) => ({ id, kind: "step", name: id, parent: "r" }))],
        edges: [
          ...nodes.map((id) => ({ id: `e:contains:r->${id}`, kind: "contains", from: "r", to: id })),
          ...edges.map(([k, f, t]) => ({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t })),
        ],
      }) as unknown as GraphIR;
    const before = mk(["a", "b"], [["calls", "a", "b"]]);
    const after = mk(["a", "b", "c"], [["calls", "a", "c"]]);
    // one node added, one edge added, one edge removed — and "−N removed" used to say
    // nothing at all for an edge, while "+N added" counted one
    expect(deltaCounts(diffIR(before, after))).toEqual({ added: 2, modified: 0, removed: 1 });
    expect(deltaCounts(diffIR(after, before))).toEqual({ added: 1, modified: 0, removed: 2 });
    expect(deltaCounts(diffIR(before, before))).toEqual({ added: 0, modified: 0, removed: 0 });
  });

  it("an edge whose count changed is a MODIFICATION, not silence", () => {
    // The edge id embeds kind/from/to, so an id-set diff can never see a `count` change:
    // the chip went from `calls ×2` to `calls ×7` on screen while the status bar, the Key
    // and the canvas all said nothing. `tools/irdiff.mjs` has diffed this field all along.
    const withCount = (n: number) =>
      ({
        irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "r",
        nodes: [
          { id: "r", kind: "view", name: "r" },
          { id: "a", kind: "step", name: "a", parent: "r" },
          { id: "b", kind: "step", name: "b", parent: "r" },
        ],
        edges: [
          { id: "e:contains:r->a", kind: "contains", from: "r", to: "a" },
          { id: "e:contains:r->b", kind: "contains", from: "r", to: "b" },
          { id: "e:calls:a->b", kind: "calls", from: "a", to: "b", count: n },
        ],
      }) as unknown as GraphIR;
    const d = diffIR(withCount(2), withCount(7));
    expect([...d.modifiedEdges]).toEqual(["e:calls:a->b"]);
    expect(d.addedEdges.size + d.removedEdges.length, "not added or removed").toBe(0);
    expect(deltaCounts(d)).toEqual({ added: 0, modified: 1, removed: 0 });
    expect(isEmptyDelta(d)).toBe(false);
    expect(isEmptyDelta(diffIR(withCount(2), withCount(2)))).toBe(true);
  });
});

describe("sameNode compares attrs by VALUE", () => {
  it("the same attrs in a different key order is not a modification", () => {
    // `JSON.stringify` on both sides is order-sensitive, so a generator that emitted
    // `{access, typeKind}` one run and `{typeKind, access}` the next lit the node amber for a
    // semantically identical graph, while `irdiff` (key-sorted deepEqual) said "no changes".
    const mk = (attrs: Record<string, unknown>) =>
      ({
        irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "r",
        nodes: [{ id: "r", kind: "view", name: "r" }, { id: "func:f", kind: "function", name: "f", parent: "r", attrs }],
        edges: [{ id: "e:contains:r->func:f", kind: "contains", from: "r", to: "func:f" }],
      }) as unknown as GraphIR;
    expect(isEmptyDelta(diffIR(mk({ access: "public", typeKind: "struct" }), mk({ typeKind: "struct", access: "public" })))).toBe(true);
    // nested objects and arrays, same rule
    expect(isEmptyDelta(diffIR(mk({ a: { x: 1, y: [1, 2] } }), mk({ a: { y: [1, 2], x: 1 } })))).toBe(true);
    // …and a real change is still a change
    expect([...diffIR(mk({ access: "public" }), mk({ access: "private" })).modified]).toEqual(["func:f"]);
    expect([...diffIR(mk({ a: [1, 2] }), mk({ a: [2, 1] })).modified], "array ORDER is meaning").toEqual(["func:f"]);
    expect([...diffIR(mk({ a: 1 }), mk({ a: 1, b: 2 })).modified]).toEqual(["func:f"]);
  });
});

describe("sameNode notices a reparent", () => {
  it("moving a node to a different container is a MODIFICATION", () => {
    // Amber highlight for "this moved". `parent` was compared but nothing asserted it: a
    // reparent otherwise arrives as no change at all.
    const mk = (parent: string) =>
      ({
        irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "r",
        nodes: [
          { id: "r", kind: "view", name: "r" },
          { id: "type:A", kind: "type", name: "A", parent: "r" },
          { id: "type:B", kind: "type", name: "B", parent: "r" },
          { id: "func:f", kind: "function", name: "f", parent },
        ],
        edges: [
          { id: "e:contains:r->type:A", kind: "contains", from: "r", to: "type:A" },
          { id: "e:contains:r->type:B", kind: "contains", from: "r", to: "type:B" },
          { id: `e:contains:${parent}->func:f`, kind: "contains", from: parent, to: "func:f" },
        ],
      }) as unknown as GraphIR;
    const d = diffIR(mk("type:A"), mk("type:B"));
    expect([...d.modified]).toEqual(["func:f"]);
    expect(d.added.size).toBe(0);
    expect(isEmptyDelta(diffIR(mk("type:A"), mk("type:A")))).toBe(true);
  });
});

// A DISPLAY edge folds several IR edges together whenever a container is collapsed — the
// normal state of any big graph — and its delta has to be decided from ITS constituents.
describe("a display edge's delta comes from its own constituents", () => {
  const prev = (counts: Record<string, number>) => ({ compared: true, prevCount: new Map(Object.entries(counts)) });

  it("grew: modified, not added; shrank: modified, not nothing", () => {
    // Lifting "some constituent was added" onto the display edge painted A→B green as NEW
    // when it had been on screen as `calls ×3` all along and merely grew to ×4 — and when
    // it shrank back, nothing at all, beside a status bar saying "−1 removed" about a
    // connection still on screen.
    const d = prev({ "e1": 1, "e2": 1, "e3": 1 });
    expect(displayEdgeDelta(["e1", "e2", "e3", "e4"], 4, d)).toBe("modified"); // grew
    // shrank: e3 is GONE from irIds, so the survivors sum to 2 = count and cannot see the
    // drop — the removed constituent's multiplicity has to arrive separately, resolved onto
    // this display edge by `removedByDisplayKey`
    expect(displayEdgeDelta(["e1", "e2"], 2, d, 1)).toBe("modified");
    expect(displayEdgeDelta(["e1", "e2"], 2, d, 0), "…and without it the drop is invisible").toBeUndefined();
    expect(displayEdgeDelta(["e1", "e2", "e3"], 3, d)).toBeUndefined(); // same
    expect(displayEdgeDelta(["e9"], 1, d)).toBe("added"); // none of me was here
    // every constituent replaced by a new id, same multiplicity: the CONNECTION was here
    expect(displayEdgeDelta(["e9"], 1, d, 1)).toBeUndefined();
    // a constituent that changed its own multiplicity changes the sum
    expect(displayEdgeDelta(["e1", "e2", "e3"], 7, d)).toBe("modified");
  });

  it("on a first load, or after a root switch, nothing is a change", () => {
    // An EMPTY previous map means two different things and only `compared` tells them
    // apart: no previous graph (nothing is new) vs a previous graph with no drawn edges
    // (everything is). Without the flag every edge on a first load came out green.
    expect(displayEdgeDelta(["e1"], 1, { compared: false, prevCount: new Map() })).toBeUndefined();
    expect(displayEdgeDelta(["e1"], 1, { compared: true, prevCount: new Map() })).toBe("added");
  });

  it("end to end: two collapsed modules, a call site removed between them", () => {
    // `module:a` and `module:b` collapsed (the normal state of any big graph), N `calls`
    // from a's functions to b's folded into one `calls ×N` display edge. v1 has 3 call
    // sites, v2 has 2: the chip goes ×3 → ×2 and the removed constituent is resolved onto
    // that display edge through the REAL resolver, so it reads "modified" — it used to read
    // nothing, beside a status bar saying "−1 removed".
    const mk = (calls: number): GraphIR => {
      const nodes: GraphIR["nodes"] = [{ id: "pkg:app", kind: "package", name: "app" }];
      const edges: GraphIR["edges"] = [];
      const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
      for (const m of ["a", "b"]) {
        nodes.push({ id: `module:${m}`, kind: "module", name: m, parent: "pkg:app" });
        add("contains", "pkg:app", `module:${m}`);
        for (let i = 0; i < 4; i++) {
          nodes.push({ id: `function:${m}/f${i}`, kind: "function", name: `f${i}`, parent: `module:${m}` });
          add("contains", `module:${m}`, `function:${m}/f${i}`);
        }
      }
      for (let i = 0; i < calls; i++) add("calls", `function:a/f${i}`, `function:b/f${i}`);
      const cmp = (x: { id: string }, y: { id: string }) => Buffer.compare(Buffer.from(x.id), Buffer.from(y.id));
      nodes.sort(cmp);
      edges.sort(cmp);
      return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "pkg:app", nodes, edges } as GraphIR;
    };
    const collapsed = new Set(["module:a", "module:b"]);
    const d = diffIR(mk(3), mk(2));
    expect(d.removedEdges).toEqual(["e:calls:function:a/f2->function:b/f2"]);
    const m = buildDisplay(mk(2), collapsed);
    const e = m.displayEdges.find((x) => x.kind === "calls")!;
    expect([e.source, e.target, e.count]).toEqual(["module:a", "module:b", 2]);
    const removedByKey = removedByDisplayKey(d.removedEdgeRecords, m.rep);
    expect(removedByKey.get(edgeKey("calls", "module:a", "module:b"))).toBe(1);
    expect(displayEdgeDelta(e.irIds, e.count, d, removedByKey.get(edgeKey(e.kind, e.source, e.target)))).toBe("modified");
    // …and the reverse (2 → 3) is a growth, also "modified", never "added"
    const g = diffIR(mk(2), mk(3));
    const m3 = buildDisplay(mk(3), collapsed);
    const e3 = m3.displayEdges.find((x) => x.kind === "calls")!;
    expect(displayEdgeDelta(e3.irIds, e3.count, g, removedByDisplayKey(g.removedEdgeRecords, m3.rep).get(edgeKey(e3.kind, e3.source, e3.target)))).toBe("modified");
  });
});

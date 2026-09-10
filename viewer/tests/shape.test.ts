import { describe, it, expect } from "vitest";
import { checkGraphShape } from "../src/ir/shape";
import { diffIR, isEmptyDelta } from "../src/ir/delta";
import { pollSources } from "../src/App";
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

describe("pollSources", () => {
  it("defaults to live then sample", () =>
    expect(pollSources("")).toEqual(["live/graph.json", "sample-graph.json"]));
  it("polls a named candidate view only", () =>
    expect(pollSources("?graph=draft-2")).toEqual(["live/draft-2.json"]));
  it("ignores unsafe names", () => expect(pollSources("?graph=../x")).toEqual(["live/graph.json", "sample-graph.json"]));
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

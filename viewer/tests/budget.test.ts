import { describe, it, expect } from "vitest";
import { autoCollapse, parseBudget, DEFAULT_BUDGET } from "../src/ir/budget";
import { checkGraphShape } from "../src/ir/shape";
import type { GraphIR } from "../src/ir/types";

export function db(schemas: number, tablesPer: number, cols: number): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "db:m", kind: "database", name: "m" }];
  const edges: GraphIR["edges"] = [];
  const add = (kind: string, from: string, to: string) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  const tables: string[] = [];
  const col = (tid: string, c: number) => `${tid.replace("table:", "column:")}.c${c}`;
  for (let s = 0; s < schemas; s++) {
    nodes.push({ id: `schema:s${s}`, kind: "schema", name: `s${s}`, parent: "db:m" });
    add("contains", "db:m", `schema:s${s}`);
    for (let t = 0; t < tablesPer; t++) {
      const tid = `table:s${s}.t${t}`;
      nodes.push({ id: tid, kind: "table", name: `t${t}`, parent: `schema:s${s}` });
      add("contains", `schema:s${s}`, tid);
      tables.push(tid);
      for (let c = 0; c < cols; c++) {
        nodes.push({ id: col(tid, c), kind: "column", name: `c${c}`, parent: tid });
        add("contains", tid, col(tid, c));
      }
    }
  }
  // two foreign keys per table to pseudo-random EARLIER tables (multiplicative
  // hash — `(i * k) % i` is always 0 and would make a star, not a schema)
  const pick = (i: number, salt: number) => (Math.imul(i + salt, 2654435761) >>> 0) % i;
  for (let i = 1; i < tables.length; i++) {
    add("references", col(tables[i], 1), col(tables[pick(i, 1)], 0));
    if (i > 1) add("references", col(tables[i], 2), col(tables[pick(i, 2)], 0));
  }
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "db:m", nodes, edges } as GraphIR;
}

describe("visibility budget", () => {
  it("does nothing when the graph fits", () => {
    const g = db(2, 5, 4); // 2 + 10 + 40 = 52 display nodes
    const r = autoCollapse(g, new Set(), { maxVisible: 100, maxEdges: 100 });
    expect(r.collapse).toEqual([]);
    expect(r.visible).toBe(52);
    expect(r.total).toBe(52);
    expect(r.hidden).toBe(0);
  });
  it("collapses whole levels, deepest first, so every table survives and every column hides", () => {
    const g = db(3, 40, 10); // 3 + 120 + 1200 = 1323
    const r = autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 });
    expect(r.collapse.every((id) => id.startsWith("table:"))).toBe(true);
    expect(r.visible).toBe(3 + 120); // every table collapsed, nothing else
    expect(r.hidden).toBe(1200);
  });
  it("moves up a level when collapsing every table is not enough", () => {
    const g = db(4, 300, 3); // 4 + 1200 + 3600
    const r = autoCollapse(g, new Set(), { maxVisible: 100, maxEdges: 10_000 });
    expect(r.collapse.filter((id) => id.startsWith("schema:")).length).toBeGreaterThan(0);
    expect(r.visible).toBeLessThanOrEqual(100);
  });
  it("respects the edge budget by collapsing further", () => {
    const g = db(2, 400, 2); // 799 FK edges between tables once columns hide
    const r = autoCollapse(g, new Set(), { maxVisible: 5000, maxEdges: 100 });
    expect(r.edges).toBeLessThanOrEqual(100);
  });
  it("never revisits the user's decisions (exclude) and is deterministic", () => {
    const g = db(3, 40, 10);
    const keep = new Set(["table:s0.t0", "table:s1.t1"]);
    const r = autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 }, keep);
    expect(r.collapse.some((id) => keep.has(id))).toBe(false);
    const again = autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 }, keep);
    expect(again.collapse).toEqual(r.collapse);
  });
  it("counts already-collapsed containers as work already done", () => {
    const g = db(3, 40, 10);
    const pre = new Set(g.nodes.filter((n) => n.kind === "table").map((n) => n.id));
    const r = autoCollapse(g, pre, { maxVisible: 200, maxEdges: 10_000 });
    expect(r.collapse).toEqual([]);
    expect(r.visible).toBe(123);
  });
  it("parses ?budget=", () => {
    expect(parseBudget("")).toBeNull();
    expect(parseBudget("?budget=300")).toEqual({ maxVisible: 300, maxEdges: DEFAULT_BUDGET.maxEdges });
    expect(parseBudget("?budget=2000")).toEqual({ maxVisible: 2000, maxEdges: 2000 });
    expect(parseBudget("?budget=300,50")).toEqual({ maxVisible: 300, maxEdges: 50 });
    expect(parseBudget("?budget=nope")).toBeNull();
  });
});

describe("uniform levels", () => {
  it("collapses a newcomer at a depth an earlier pass collapsed, even under budget", () => {
    const g = db(3, 40, 10);
    const first = autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 });
    expect(first.levels).toEqual([1]); // the table level
    const later = autoCollapse(g, new Set(first.collapse.filter((id) => id !== "table:s1.t5")), { maxVisible: 200, maxEdges: 10_000 }, new Set(), new Set(first.levels));
    expect(later.collapse).toEqual(["table:s1.t5"]);
    expect(later.levels).toEqual([1]);
  });
});

// A chain deep enough to exhaust the JS stack passes shape.ts (iterative and
// memoised), so every walk in budget.ts has to be iterative too: before this,
// depthOf/sizeOf/countVisible/visibleBelow recursed per link and threw
// "RangeError: Maximum call stack size exceeded" out of setIR, which killed the
// live poll loop for good. Cost is still quadratic in the number of DISTINCT
// depths (one budget level each): 2k deep ≈ 30 ms, 20k ≈ 5.7 s — pathological
// input only, real graphs are a handful of levels deep.
describe("pathologically deep graphs", () => {
  function deepChain(n: number): GraphIR {
    const nodes: GraphIR["nodes"] = [{ id: "n0", kind: "view", name: "root" }];
    const edges: GraphIR["edges"] = [];
    for (let i = 1; i < n; i++) {
      nodes.push({ id: `n${i}`, kind: "step", name: `s${i}`, parent: `n${i - 1}` });
      edges.push({ id: `e:contains:n${i - 1}->n${i}`, kind: "contains", from: `n${i - 1}`, to: `n${i}` });
    }
    return { irVersion: "0.2", generator: { tool: "test", version: "0", commit: null }, root: "n0", nodes, edges };
  }

  it("survives a 2,000-deep parent chain that the shape guard admits", () => {
    const g = deepChain(2000);
    expect(checkGraphShape(g)).toBeNull(); // the viewer would accept this graph
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set());
    expect(r.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
    expect(r.total).toBe(1999); // every node but the root is a display node
  });

  it("survives a wide flat container of 20,000 children", () => {
    const nodes: GraphIR["nodes"] = [{ id: "r", kind: "view", name: "root" }];
    const edges: GraphIR["edges"] = [];
    for (let i = 0; i < 20000; i++) {
      nodes.push({ id: `c${i}`, kind: "step", name: `c${i}`, parent: "r" });
      edges.push({ id: `e:contains:r->c${i}`, kind: "contains", from: "r", to: `c${i}` });
    }
    const g: GraphIR = { irVersion: "0.2", generator: { tool: "test", version: "0", commit: null }, root: "r", nodes, edges };
    expect(checkGraphShape(g)).toBeNull();
    expect(() => autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set())).not.toThrow();
  });
});

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
    // 130: the whole table level is needed to reach it (123 visible), so no level is partial
    const r = autoCollapse(g, new Set(), { maxVisible: 130, maxEdges: 10_000 });
    expect(r.collapse.every((id) => id.startsWith("table:"))).toBe(true);
    expect(r.visible).toBe(3 + 120); // every table collapsed, nothing else
    expect(r.hidden).toBe(1200);
    expect(r.levels).toEqual([1]); // a WHOLE level: the store may collapse newcomers there
  });
  it("folds only as much of the last level as the budget needs", () => {
    const g = db(3, 40, 10); // 1323 display nodes, 200 allowed
    const r = autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 });
    expect(r.visible).toBeLessThanOrEqual(200);
    expect(r.visible).toBeGreaterThan(180); // NOT 123: the whole level is not taken to save 3 nodes
    expect(r.collapse.length).toBeLessThan(120);
    expect(r.levels).toEqual([]); // partial: the store must not finish the level off next poll
  });
  it("does not fold a 600-table schema into one chip to get 3 nodes under the cap", () => {
    // The finding's case: 603 display nodes at the table level against a 600 budget,
    // and ~1,190 aggregated foreign keys against an 800 edge budget.
    const g = db(3, 200, 12); // 3 + 600 + 7200
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBeGreaterThan(200); // was 3 (both phases took a whole level)
    expect(r.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
    expect(r.edges).toBeLessThanOrEqual(DEFAULT_BUDGET.maxEdges);
    expect(r.collapse.filter((id) => id.startsWith("schema:")).length).toBe(1); // one schema, not the level
  });
  it("stays a few nodes over budget rather than folding the only container above the tables", () => {
    // One schema, 600 tables: there is nothing to fold partially, so the level is
    // refused outright — 601 chips beats one, and the layout has a tier for it.
    const g = db(1, 600, 8);
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.collapse).not.toContain("schema:s0");
    expect(r.visible).toBe(1 + 600);
    expect(r.edges).toBeGreaterThan(DEFAULT_BUDGET.maxEdges); // the edge cap yields, not the view
  });
  it("keeps the refusal across BOTH phases, not just the node phase", () => {
    // The first fix guarded only the node phase, so the edge phase folded the very level
    // the node phase had refused: the 600-table cliff moved to ~810 tables (where the
    // aggregated foreign keys pass 2x the edge budget) instead of going away. Both sizes
    // below sit above that line and must still render as tables, not as one chip.
    for (const tables of [820, 1000]) {
      const g = db(1, tables, 8);
      const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
      expect(r.collapse, `${tables} tables`).not.toContain("schema:s0");
      expect(r.visible, `${tables} tables`).toBe(1 + tables);
      // grossly over the edge cap — and still refused, because the node phase said so
      expect(r.edges, `${tables} tables`).toBeGreaterThan(2 * DEFAULT_BUDGET.maxEdges);
    }
    // …but grossly over BOTH caps there is no context worth protecting: everything folds.
    expect(autoCollapse(db(1, 1200, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1);
  });
  it("`collapse to fit` is never a silent no-op: an explicit ask overrides the guard", () => {
    // The same guard made the button do nothing between 801 and 2x the budget — the exact
    // band where the render warning offers it. `force` is what the store passes there.
    const g = db(1, 820, 8);
    const auto = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(auto.collapse).not.toContain("schema:s0"); // automatic: refused, as above
    const asked = autoCollapse(g, new Set(auto.collapse), DEFAULT_BUDGET, new Set(), new Set(), true);
    expect(asked.collapse, "the button must change something").not.toEqual([]);
    expect(asked.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
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
    const first = autoCollapse(g, new Set(), { maxVisible: 130, maxEdges: 10_000 });
    expect(first.levels).toEqual([1]); // the table level, taken whole
    const later = autoCollapse(g, new Set(first.collapse.filter((id) => id !== "table:s1.t5")), { maxVisible: 130, maxEdges: 10_000 }, new Set(), new Set(first.levels));
    expect(later.collapse).toEqual(["table:s1.t5"]);
    expect(later.levels).toEqual([1]);
  });
});

// A chain deep enough to exhaust the JS stack passes shape.ts (iterative and
// memoised), so every walk in budget.ts has to be iterative too: before this,
// depthOf/sizeOf/countVisible/visibleBelow recursed per link and threw
// "RangeError: Maximum call stack size exceeded" out of setIR, which killed the
// live poll loop for good. Every distinct depth is its own budget level, so the
// pass also has to be LINEAR in them: while it recomputed the visible count and
// the ancestor walk per level, 10k deep cost 1.5 s and 20k cost 5.7 s (measured
// 2026-09-10). With the counts kept incrementally: 19 ms and 26 ms.
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

  it("stays linear in the number of depth levels", () => {
    const g = deepChain(20000); // 19,999 levels of one container each
    const t0 = performance.now();
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set());
    const ms = performance.now() - t0;
    expect(r.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(500); // 5,700 ms when each level recounted the graph
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

// The store across polls: budget bookkeeping, pruning, lastToggle.
import { describe, it, expect, beforeEach } from "vitest";
import { useAtlas } from "../src/store";
import { db } from "./budget.test";

const s = () => useAtlas.getState();

// The store keeps per-root bookkeeping (defaulted/auto-collapsed ids) across polls,
// so each test gets its own root id — otherwise one test's "user expanded these"
// state leaks into the next as if the user had expanded every table.
let n = 0;
function fresh(g: ReturnType<typeof db>): ReturnType<typeof db> {
  const root = `db:m${++n}`;
  const sub = (id: string) => (id === "db:m" ? root : id);
  return {
    ...g,
    root,
    nodes: g.nodes.map((x) => ({ ...x, id: sub(x.id), ...(x.parent ? { parent: sub(x.parent) } : {}) })),
    edges: g.edges.map((e) => ({ ...e, id: e.id.replace("db:m", root), from: sub(e.from), to: sub(e.to) })),
  };
}

describe("store across polls", () => {
  beforeEach(() => {
    // a fresh root per test resets the module-level bookkeeping
    useAtlas.setState({ ir: null, collapsed: new Set(), selected: null, lastToggle: null, budgetInfo: null, budget: { maxVisible: 200, maxEdges: 10_000 } });
  });

  it("never re-collapses the ancestors of containers the user expanded", () => {
    const g = fresh(db(3, 40, 10)); // 1323 display nodes → tables auto-collapsed (123 visible)
    s().setIR(g, "t");
    expect(s().budgetInfo?.visible).toBe(123);
    // the user opens 50 tables: 623 visible, well over the 200 budget
    for (let t = 0; t < 50; t++) s().toggleCollapse(`table:s${t % 3}.t${Math.floor(t / 3)}`);
    // a re-emit with one extra column arrives
    const g2 = { ...g, nodes: [...g.nodes, { id: "column:s0.t0.c99", kind: "column", name: "c99", parent: "table:s0.t0" }], edges: [...g.edges, { id: "e:contains:table:s0.t0->column:s0.t0.c99", kind: "contains", from: "table:s0.t0", to: "column:s0.t0.c99" }] };
    s().setIR(g2 as typeof g, "t");
    for (const sid of ["schema:s0", "schema:s1", "schema:s2"]) expect(s().collapsed.has(sid), sid).toBe(false);
    expect(s().collapsed.has("table:s0.t0")).toBe(false); // the user's expand sticks
    expect(s().collapsed.has("table:s2.t39")).toBe(true); // untouched tables stay budgeted
    expect(s().lastToggle).toBeNull();
  });

  it("a container that leaves and comes back is budgeted again", () => {
    const g = fresh(db(3, 40, 10));
    s().setIR(g, "t");
    expect(s().collapsed.has("table:s1.t5")).toBe(true);
    const without = { ...g, nodes: g.nodes.filter((n) => !n.id.includes("s1.t5")), edges: g.edges.filter((e) => !e.from.includes("s1.t5") && !e.to.includes("s1.t5")) };
    s().setIR(without as typeof g, "t");
    expect(s().collapsed.has("table:s1.t5")).toBe(false);
    s().setIR(g, "t");
    expect(s().collapsed.has("table:s1.t5")).toBe(true); // not rendered expanded among chips
  });

  it("records the last toggle and forgets it on a new graph", () => {
    const g = fresh(db(2, 5, 3));
    s().setIR(g, "t");
    s().toggleCollapse("table:s0.t1");
    expect(s().lastToggle).toBe("table:s0.t1");
    s().setIR({ ...g }, "t");
    expect(s().lastToggle).toBeNull();
  });
});

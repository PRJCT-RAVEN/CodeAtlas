// The store across polls: budget bookkeeping, pruning, lastToggle.
import { describe, it, expect, beforeEach } from "vitest";
import { useAtlas } from "../src/store";
import { db } from "./budget.test";
import { autoCollapse, DEFAULT_BUDGET, RENDER_WARN } from "../src/ir/budget";
import type { GraphIR } from "../src/ir/types";

/** Visible display nodes under a collapsed set — autoCollapse reports it for us. */
const countVisible = (g: GraphIR, collapsed: ReadonlySet<string>) =>
  autoCollapse(g, collapsed, { maxVisible: Number.MAX_SAFE_INTEGER, maxEdges: Number.MAX_SAFE_INTEGER }).visible;

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
    // 130 nodes: exactly tight enough that the whole table level of db(3, 40, 10)
    // is needed (123 visible), so these tests see whole levels, not a partial one
    useAtlas.setState({ ir: null, collapsed: new Set(), selected: null, lastToggle: null, budgetInfo: null, budget: { maxVisible: 130, maxEdges: 10_000 } });
  });

  it("never re-collapses the ancestors of containers the user expanded", () => {
    const g = fresh(db(3, 40, 10)); // 1323 display nodes → tables auto-collapsed (123 visible)
    s().setIR(g, "t");
    expect(s().budgetInfo?.visible).toBe(123);
    // the user opens 50 tables: 623 visible, well over the 130 budget
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

  it("hands a small follow-up view back expanded, even under the root the big one used", () => {
    // CLAUDE.md asks authors to keep the root id stable across refinements. Before this,
    // the big view's remembered depths and auto-collapsed ids applied to the small graph
    // that followed, so a four-node answer arrived as chips.
    const g = fresh(db(3, 40, 10));
    s().setIR(g, "t");
    expect(s().collapsed.has("table:s0.t0")).toBe(true);
    const keep = new Set(["schema:s0", "table:s0.t0", "column:s0.t0.c0", "column:s0.t0.c1", g.root]);
    const tiny = {
      ...g,
      nodes: g.nodes.filter((n) => keep.has(n.id)),
      edges: g.edges.filter((e) => e.kind === "contains" && keep.has(e.from) && keep.has(e.to)),
    };
    s().setIR(tiny as typeof g, "t");
    expect(s().collapsed.has("table:s0.t0")).toBe(false);
    expect(s().budgetInfo?.autoCollapsed).toBe(0);
    expect(s().budgetInfo?.visible).toBe(4); // schema + table + 2 columns, all on screen
  });

  it("un-collapses a container that became a leaf, so it cannot render as an empty '+' chip", () => {
    const g = fresh(db(2, 3, 2));
    s().setIR(g, "t"); // 20 display nodes: the budget collapses nothing
    s().toggleCollapse("table:s0.t0");
    expect(s().collapsed.has("table:s0.t0")).toBe(true);
    // the next refinement folds that table's columns away — same id, now a leaf
    const leaf = {
      ...g,
      nodes: g.nodes.filter((n) => n.parent !== "table:s0.t0"),
      edges: g.edges.filter((e) => !e.from.startsWith("column:s0.t0.") && !e.to.startsWith("column:s0.t0.")),
    };
    s().setIR(leaf as typeof g, "t");
    expect(s().collapsed.has("table:s0.t0")).toBe(false);
  });

  it("does not re-apply an author `collapsedByDefault` to a node with no children", () => {
    // The un-collapse above pruned the id out of `defaulted` — which is exactly what let
    // the annotation loop put it straight back on the NEXT poll. The chip returned one
    // second after the user clicked it away, forever.
    const g = fresh(db(2, 3, 2));
    const leafId = "table:s0.t0";
    const withoutKids = {
      ...g,
      annotations: { [leafId]: { collapsedByDefault: true } },
      nodes: g.nodes.filter((n) => n.parent !== leafId),
      edges: g.edges.filter((e) => !e.from.startsWith("column:s0.t0.") && !e.to.startsWith("column:s0.t0.")),
    };
    for (let poll = 0; poll < 3; poll++) {
      s().setIR(withoutKids as typeof g, "t");
      expect(s().collapsed.has(leafId), `poll ${poll}`).toBe(false);
    }
    // …and the default still applies the moment it really is a container again
    s().setIR({ ...g, annotations: { [leafId]: { collapsedByDefault: true } } } as typeof g, "t");
    expect(s().collapsed.has(leafId)).toBe(true);
  });

  it("`collapse to fit` collapses something even when the automatic pass would refuse", () => {
    // 821 visible against a 600 budget, with only ONE container above the tables: the
    // automatic pass protects it, so the button has to be the thing that overrides.
    const g = fresh(db(1, 820, 8));
    useAtlas.setState({ budget: DEFAULT_BUDGET });
    s().setIR(g, "t");
    const before = s().budgetInfo!.visible;
    expect(before).toBeGreaterThan(RENDER_WARN); // the banner is showing, offering the button
    s().collapseToFit();
    expect(s().budgetInfo!.visible, "the button must actually shrink the view").toBeLessThan(before);
    expect(s().budgetInfo!.visible).toBeLessThanOrEqual(RENDER_WARN);
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

// PROJECT_SPEC §3(C)/N4 wanted a hard cap that force-collapses. The budget does that
// for a graph as it ARRIVES; a user can still expand past it afterwards, and undoing
// the click they just made would be hostile — so the viewer warns and offers this.
describe("collapseToFit", () => {
  it("brings an over-expanded view back under the budget, including containers the user opened", () => {
    const g = db(4, 30, 4); // schemas × tables × columns
    useAtlas.setState({ ir: null, collapsed: new Set(), budget: DEFAULT_BUDGET, budgetInfo: null });
    useAtlas.getState().setIR(g, "test");
    // the user opens everything: the automatic pass never revisits their choices
    useAtlas.setState({ collapsed: new Set() });
    const wideOpen = countVisible(g, useAtlas.getState().collapsed);
    expect(wideOpen).toBeGreaterThan(DEFAULT_BUDGET.maxVisible);

    useAtlas.getState().collapseToFit();
    const after = countVisible(g, useAtlas.getState().collapsed);
    expect(after).toBeLessThanOrEqual(Math.min(DEFAULT_BUDGET.maxVisible, RENDER_WARN));
    expect(after).toBeLessThan(wideOpen);
    expect(useAtlas.getState().budgetInfo?.visible).toBe(after);
    // a multi-container change must not be treated as one incremental toggle
    expect(useAtlas.getState().lastToggle).toBeNull();
  });

  it("survives the next poll: a fit the user asked for is not released as if the budget had made it", () => {
    const g = fresh(db(4, 50, 4)); // 1,004 display nodes, with ?budget= raised past them
    useAtlas.setState({ ir: null, collapsed: new Set(), budget: { maxVisible: 4000, maxEdges: 6000 }, budgetInfo: null });
    useAtlas.getState().setIR(g, "test");
    expect(useAtlas.getState().collapsed.size).toBe(0); // the budget wanted nothing
    useAtlas.getState().collapseToFit(); // the user asks for the render guard instead
    const fit = new Set(useAtlas.getState().collapsed);
    expect(fit.size).toBeGreaterThan(0);
    useAtlas.getState().setIR({ ...g }, "test"); // the same view, re-emitted a second later
    expect([...useAtlas.getState().collapsed].sort()).toEqual([...fit].sort());
  });

  it("is a no-op with no graph loaded", () => {
    useAtlas.setState({ ir: null, collapsed: new Set() });
    expect(() => useAtlas.getState().collapseToFit()).not.toThrow();
  });
});

it("collapseToFit still reduces when the user raised ?budget= past the render guard", () => {
  const g = db(4, 50, 4); // 4 + 200 + 800 = 1004 display nodes wide open: past the 800 guard
  useAtlas.setState({ ir: null, collapsed: new Set(), budget: { maxVisible: 4000, maxEdges: 6000 }, budgetInfo: null });
  useAtlas.getState().setIR(g, "test");
  useAtlas.setState({ collapsed: new Set() }); // the user opened everything
  const before = countVisible(g, useAtlas.getState().collapsed);
  expect(before).toBeGreaterThan(RENDER_WARN);
  useAtlas.getState().collapseToFit();
  const after = countVisible(g, useAtlas.getState().collapsed);
  expect(after, "the button must do something even with a raised budget").toBeLessThan(before);
  expect(after).toBeLessThanOrEqual(RENDER_WARN);
});

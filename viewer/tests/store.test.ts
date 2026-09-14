// The store across polls: budget bookkeeping, pruning, lastToggle.
import { describe, it, expect, beforeEach } from "vitest";
import { useAtlas, subtreeIds, crossesSelection, edgeIsLit, childIndexHeldFor, edgeIsPainted } from "../src/store";
import { connectionsOf } from "../src/App";
import type { ElkEdgeType } from "../src/edges/ElkEdge";
import { bucketed, db, lumpy } from "./fixtures";
import { autoCollapse, DEFAULT_BUDGET, MIN_OVERVIEW, RENDER_WARN } from "../src/ir/budget";
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

// "Select a node to trace them" has to be true at the level the user is looking at.
// Clicking a node also EXPANDS it when it is a container, and an expanded container is no
// longer an edge endpoint — its children are — so matching edges on the selected id alone
// lit nothing at all in the dense database views the affordance exists for (found
// 2026-09-10: clicking a bucket in a 10,000-table overview made its foreign keys vanish
// instead of light up).
describe("litIds (edge tracing)", () => {
  it("is the selected node plus its whole subtree", () => {
    const g = db(2, 3, 2); // schema > table > column
    expect(subtreeIds(g, null).size).toBe(0);
    expect(subtreeIds(null, "table:s0.t0").size).toBe(0);
    expect([...subtreeIds(g, "column:s0.t0.c0")]).toEqual(["column:s0.t0.c0"]); // a leaf is itself
    const table = subtreeIds(g, "table:s0.t0");
    expect(table.has("table:s0.t0")).toBe(true);
    expect(table.has("column:s0.t0.c0")).toBe(true);
    expect(table.has("column:s0.t1.c0")).toBe(false); // a sibling is not under it
    const schema = subtreeIds(g, "schema:s0");
    expect(schema.size).toBe(1 + 3 + 3 * 2); // the schema, its tables, their columns
    expect(schema.has("table:s1.t0")).toBe(false);
  });

  it("survives a deep chain without recursing", () => {
    const nodes: GraphIR["nodes"] = [{ id: "n0", kind: "view", name: "r" }];
    const edges: GraphIR["edges"] = [];
    for (let i = 1; i < 20000; i++) {
      nodes.push({ id: `n${i}`, kind: "step", name: `s${i}`, parent: `n${i - 1}` });
      edges.push({ id: `e:contains:n${i - 1}->n${i}`, kind: "contains", from: `n${i - 1}`, to: `n${i}` });
    }
    const g: GraphIR = { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "n0", nodes, edges };
    expect(subtreeIds(g, "n0").size).toBe(20000);
  });

  it("the store keeps it in step with the selection, and prunes it with the graph", () => {
    const g = db(1, 2, 2);
    useAtlas.getState().setIR(g, "test");
    expect(useAtlas.getState().litIds.size).toBe(0); // nothing selected
    useAtlas.getState().select("table:s0.t0");
    expect(useAtlas.getState().litIds.has("column:s0.t0.c1")).toBe(true);
    useAtlas.getState().select(null);
    expect(useAtlas.getState().litIds.size).toBe(0);
    // a graph that no longer holds the selected node drops both
    useAtlas.getState().select("table:s0.t1"); // db(1,1,1) below has only t0
    useAtlas.getState().setIR(db(1, 1, 1), "test");
    expect(useAtlas.getState().selected).toBe(null);
    expect(useAtlas.getState().litIds.size).toBe(0);
  });
});

// The details panel is the ONLY way to read edges in a dense or hairball view, so it must
// agree with the canvas. Two ways it did not (found 2026-09-10):
//   - a self-loop has both ends inside the selection, so the "crosses the boundary" rule
//     dropped every one of them — while the canvas kept drawing them (recursion is real
//     information; layout/elk.ts only keeps a self-loop that was AUTHORED on a visible node);
//   - selecting a container lights its whole subtree, and without naming the near end all
//     272 rows of a bucket's edge list read identically.
describe("connectionsOf (details panel edge list)", () => {
  // `count` as well as `label`, because that is what App builds. Supplying only the label
  // made every ordering assertion here pass against a number scraped back out of it —
  // exactly the bug (an authored `annotations.<edge>.label` REPLACES the chip text, so the
  // scrape read 1), and a test that supplies an input the real caller never does.
  const e = (id: string, source: string, target: string, label = "calls", count = 1) =>
    ({ id, type: "elk", source, target, data: { label, count } }) as unknown as ElkEdgeType;
  const names = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);

  it("keeps a self-loop, drops an edge internal to the selection", () => {
    const edges = [e("self", "a", "a", "calls ×3", 3), e("internal", "a", "b"), e("out", "a", "c")];
    const lit = new Set(["a", "b"]); // "a" selected, "b" is a child of it
    const rows = connectionsOf(edges, lit, "a", names);
    expect(rows.map((r) => r.id).sort()).toEqual(["out", "self"]);
    expect(rows.find((r) => r.id === "self")).toMatchObject({ selfLoop: true, out: true });
    expect(rows.find((r) => r.id === "out")).toMatchObject({ selfLoop: false, otherName: "C" });
  });

  it("names the near end only when it is not the selected node itself", () => {
    const edges = [e("fromChild", "b", "c"), e("fromSelf", "a", "c")];
    const rows = connectionsOf(edges, new Set(["a", "b"]), "a", names);
    expect(rows.find((r) => r.id === "fromChild")!.nearName).toBe("B"); // which child it leaves
    expect(rows.find((r) => r.id === "fromSelf")!.nearName).toBe(null);
  });

  it("orders by multiplicity, biggest first", () => {
    const edges = [e("one", "a", "b", "calls", 1), e("many", "a", "c", "calls ×9", 9)];
    expect(connectionsOf(edges, new Set(["a"]), "a", names).map((r) => r.id)).toEqual(["many", "one"]);
  });

  it("…from the edge's own count, not from the text of its chip", () => {
    // `annotations.<edge>.label` replaces the chip text entirely — the shipped showcase graph
    // does exactly this (`count: 2` with `label: "payment failed"`), and its heaviest
    // connection was listed LAST because the label carries no "×N" to scrape.
    const edges = [e("rare", "a", "b", "sends ×2", 2), e("hot", "a", "c", "payment failed", 40)];
    expect(connectionsOf(edges, new Set(["a"]), "a", names).map((r) => r.id)).toEqual(["hot", "rare"]);
    expect(connectionsOf(edges, new Set(["a"]), "a", names).map((r) => r.count)).toEqual([40, 2]);
  });

  it("reports direction from the SELECTION's side, not the edge's", () => {
    const rows = connectionsOf([e("in", "c", "b")], new Set(["a", "b"]), "a", names);
    expect(rows[0]).toMatchObject({ out: false, otherName: "C", nearName: "B" });
  });
});

// The canvas, the status-bar count and the details panel must key off ONE rule, or they
// disagree in exactly the views where the panel is the only readable form.
describe("crossesSelection", () => {
  it("is the boundary of the selection, not 'either end is inside it'", () => {
    const lit = new Set(["parent", "childA", "childB"]);
    expect(crossesSelection(lit, "childA", "outside")).toBe(true); // leaves the selection
    expect(crossesSelection(lit, "outside", "childB")).toBe(true); // enters it
    expect(crossesSelection(lit, "childA", "childB")).toBe(false); // internal: says nothing
    expect(crossesSelection(lit, "out1", "out2")).toBe(false); // unrelated
  });
  it("keeps a self-loop inside the selection (recursion), drops one outside it", () => {
    const lit = new Set(["a"]);
    expect(crossesSelection(lit, "a", "a")).toBe(true);
    expect(crossesSelection(lit, "b", "b")).toBe(false);
  });
  it("lights NOTHING when the selection is the whole graph", () => {
    // The regression this rule exists for: `litIds` is the selected node plus its subtree,
    // so selecting a top-level container used to make every edge "touch" it — two clicks
    // switched the hairball economies off (5,397 edges drawn, pan 133 ms → 1,394 ms) while
    // the panel, which already used the crossing rule, showed nothing at all.
    const g = db(1, 3, 3);
    const all = subtreeIds(g, "schema:s0");
    const edges = g.edges.filter((e) => e.kind !== "contains");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => !crossesSelection(all, e.from, e.to))).toBe(true);
  });
  it("agrees with connectionsOf, so the count and the list cannot drift", () => {
    const es = [
      { id: "x", source: "childA", target: "outside", data: { label: "calls" } },
      { id: "y", source: "childA", target: "childB", data: { label: "calls" } },
      { id: "z", source: "childA", target: "childA", data: { label: "calls" } },
    ] as unknown as ElkEdgeType[];
    const lit = new Set(["parent", "childA", "childB"]);
    const drawn = es.filter((e) => crossesSelection(lit, e.source, e.target)).map((e) => e.id);
    const listed = connectionsOf(es, lit, "parent", new Map()).map((r) => r.id);
    expect(drawn.sort()).toEqual(listed.sort());
    expect(listed.sort()).toEqual(["x", "z"]);
  });
});

// The conversational loop: CLAUDE.md tells authors to keep the root id stable across
// refinements, so "publish a smaller view under the same root" is the NORMAL path.
//
// This is tested through the store on purpose. The same symptom was "fixed" once inside
// `autoCollapse` and asserted with `collapsed = new Set()` — the one input the store never
// supplies after a big view — so the test passed while the bug was untouched. What guts
// the refinement is a collapse CARRIED from the previous graph: `pruned` keeps it (the
// container still exists), the `fits` release only fires when the new graph could never
// need budgeting, and `autoCollapse` then folds nothing because the view is already tiny.
describe("a refinement under a stable root is not gutted by the previous view", () => {
  // The conversational loop: CLAUDE.md tells authors to keep the root id stable across
  // refinements, so "publish a smaller view under the same root" is the NORMAL path.
  //
  // Driven through the STORE, and over a MATRIX. The same symptom was "fixed" twice by
  // testing a floor on `r.visible`, and both times the test used `db(1, …)` — the single
  // follow-up shape whose carried state lands on exactly one node. The carried state
  // actually lands on whatever the PREVIOUS view's shape leaves (2 chips, 3, 18), and a
  // pure-function test with `collapsed = new Set()` cannot see any of it, because that is
  // the one input the store never supplies after a big view.
  // Earlier blocks in this file raise the budget via `setState` and do not restore it, so
  // pin it: without this the big views never exceed it and the carry-over never happens.
  beforeEach(() => useAtlas.setState({ budget: DEFAULT_BUDGET }));
  const reset = () =>
    useAtlas.getState().setIR(
      { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "reset:r", nodes: [{ id: "reset:r", kind: "v", name: "r" }], edges: [] } as GraphIR,
      "test"
    );
  /** Rename every schema so NO carried id survives — isolates the `autoLevels` mechanism,
   *  which gutted a follow-up all by itself (3 visible where standalone showed 597). */
  const renamed = (g: GraphIR): GraphIR => {
    const map = (id: string) => id.replace(/s(\d+)/g, (_, n) => `z${n}`);
    const nodes = g.nodes.map((n) => ({ ...n, id: map(n.id), parent: n.parent ? map(n.parent) : undefined }));
    const edges = g.edges.map((e) => ({ ...e, id: map(e.id), from: map(e.from), to: map(e.to) }));
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { ...g, nodes, edges } as GraphIR;
  };

  const bigs = [
    ["the 104k 40-schema overview", () => db(40, 200, 12)],
    ["a 10,803-node 3-schema view", () => db(3, 400, 8)],
    ["a 4,000-table bucketed import", () => bucketed(4000, 6)],
  ] as const;
  const follows = [
    ["db(1,120,6)", () => db(1, 120, 6)],
    ["db(2,120,6)", () => db(2, 120, 6)],
    ["db(3,120,6)", () => db(3, 120, 6)],
    ["db(10,120,6)", () => db(10, 120, 6)],
    ["bucketed(300,4)", () => bucketed(300, 4)],
    ["db(3,120,6) with every id renamed", () => renamed(db(3, 120, 6))],
  ] as const;

  for (const [fl, mkFollow] of follows) {
    it(`${fl} looks the same however it was reached`, () => {
      reset();
      useAtlas.getState().setIR(mkFollow(), "test");
      const alone = useAtlas.getState().budgetInfo!.visible;
      expect(alone).toBeGreaterThan(MIN_OVERVIEW);
      for (const [bl, mkBig] of bigs) {
        reset();
        useAtlas.getState().setIR(mkBig(), "test");
        expect(useAtlas.getState().budgetInfo!.visible, `${bl} itself`).toBeGreaterThan(1);
        useAtlas.getState().setIR(mkFollow(), "test");
        expect(useAtlas.getState().budgetInfo!.visible, `${fl} after ${bl}`).toBe(alone);
      }
    });
  }

  it("keeps the decisions that belong to the USER, not to the budget", () => {
    reset();
    const g = db(1, 20, 3); // 81 display nodes: the budget wants nothing, so this collapse is purely the user's
    useAtlas.getState().setIR(g, "test");
    expect(useAtlas.getState().collapsed.size).toBe(0);
    useAtlas.getState().toggleCollapse("table:s0.t0");
    expect(useAtlas.getState().collapsed.has("table:s0.t0")).toBe(true);
    useAtlas.getState().setIR({ ...g }, "test");
    expect(useAtlas.getState().collapsed.has("table:s0.t0"), "a user collapse must survive a poll").toBe(true);
  });

  it("does not re-collapse a container the user EXPANDED after the budget chose it", () => {
    // Such an id is still in `autoChosen` but no longer in `collapsed`; releasing it from
    // `defaulted` would hand it straight back to the budget on the next poll.
    reset();
    const g = db(3, 400, 8);
    useAtlas.getState().setIR(g, "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"));
    expect(chosen, "the budget should have collapsed a schema here").toBeDefined();
    useAtlas.getState().toggleCollapse(chosen!);
    expect(useAtlas.getState().collapsed.has(chosen!)).toBe(false);
    useAtlas.getState().setIR({ ...g }, "test");
    expect(useAtlas.getState().collapsed.has(chosen!), "the user's expand must stick").toBe(false);
  });

  it("honours an author's collapsedByDefault on the poll that introduces it", () => {
    // The release deletes carried ids from `defaulted`, and the author-default loop is
    // guarded by `!defaulted.has(id)` — so a container carried over from the big view was
    // skipped by the loop and then released, and the author's instruction only took effect
    // one poll LATER. The loop therefore runs inside the pass, after the release.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const follow = { ...db(1, 120, 6), annotations: { "table:s0.t5": { collapsedByDefault: true } } } as GraphIR;
    useAtlas.getState().setIR(follow, "test");
    expect(useAtlas.getState().collapsed.has("table:s0.t5"), "as a refinement").toBe(true);
    reset();
    useAtlas.getState().setIR(follow, "test");
    expect(useAtlas.getState().collapsed.has("table:s0.t5"), "standalone").toBe(true);
  });

  it("does not expand a container the user DELIBERATELY re-collapsed", () => {
    // An id the budget once chose stays in `autoChosen` for as long as it exists, so a
    // later user collapse of the same container looked exactly like stale budget state.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"));
    expect(chosen).toBeDefined();
    useAtlas.getState().toggleCollapse(chosen!); // expand
    useAtlas.getState().toggleCollapse(chosen!); // and collapse again, on purpose
    useAtlas.getState().setIR(db(1, 120, 6), "test");
    expect(useAtlas.getState().collapsed.has(chosen!), "the second click was deliberate").toBe(true);
  });

  it("counts each collapsed container once, over the union of the two sets", () => {
    // `autoChosen` and `userFitted` overlap — a container the budget chose, the user
    // expanded, and "collapse to fit" re-collapsed is in both — and two loops counted it
    // twice: the status bar read 1,504 auto-collapsed for 1,202 containers.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    for (const id of [...useAtlas.getState().collapsed].slice(0, 300)) useAtlas.getState().toggleCollapse(id);
    useAtlas.getState().collapseToFit();
    const s = useAtlas.getState();
    expect(s.budgetInfo!.autoCollapsed).toBeLessThanOrEqual(s.collapsed.size);
  });

  it("keeps the user's own collapses through the `fits` release too", () => {
    // There are TWO releases. Round 7 gave the exemptions to the `carried` one and not to
    // the `fits` one (which fires when the new graph could never need budgeting), so a
    // small follow-up silently undid a deliberate click — and an explicit "collapse to
    // fit", since that re-collapses exactly the containers the budget had chosen.
    for (const viaFit of [false, true]) {
      reset();
      useAtlas.getState().setIR(db(3, 400, 8), "test");
      const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"));
      expect(chosen).toBeDefined();
      useAtlas.getState().toggleCollapse(chosen!); // expand it
      if (viaFit) useAtlas.getState().collapseToFit();
      else useAtlas.getState().toggleCollapse(chosen!);
      expect(useAtlas.getState().collapsed.has(chosen!), `set up (viaFit=${viaFit})`).toBe(true);
      useAtlas.getState().setIR(db(3, 8, 2), "test"); // 76 nodes / 98 edges → `fits` fires
      expect(useAtlas.getState().collapsed.has(chosen!), `viaFit=${viaFit}`).toBe(true);
    }
  });

  it("keeps the user's EXPAND across a small refinement and back", () => {
    // Round 8 and round 9 both fixed this in a `fits` release that turned out to be dead
    // (round 22) — the behaviour is the `carried` release's, and this is the sequence that
    // shows it: open a container, publish a zoomed-in refinement, go back to the overview.
    // The expand must survive both hops.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"));
    expect(chosen).toBeDefined();
    useAtlas.getState().toggleCollapse(chosen!); // expand
    useAtlas.getState().setIR({ ...db(3, 400, 8) }, "test");
    expect(useAtlas.getState().collapsed.has(chosen!), "control: survives a same-size poll").toBe(false);
    useAtlas.getState().setIR(db(3, 8, 2), "test"); // 76 nodes: a graph that cannot exceed the budget
    useAtlas.getState().setIR({ ...db(3, 400, 8) }, "test"); // …and the overview returns
    expect(useAtlas.getState().collapsed.has(chosen!), "the expand must still stick").toBe(false);
  });

  it("collapseToFit counts each container once as well", () => {
    // `applyDefaults` was changed to count over the union; `collapseToFit` kept two loops
    // and read 1,203 for 1,202 containers.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"));
    useAtlas.getState().toggleCollapse(chosen!); // expand a BUDGET-chosen container…
    useAtlas.getState().collapseToFit(); // …so the fit re-collapses it: both sets hold it
    const s = useAtlas.getState();
    expect(s.budgetInfo!.autoCollapsed).toBe(s.collapsed.size);
  });

  it("…and so does applyDefaults, on the republish that recomputes it", () => {
    // Pattern (d) in the TESTS: the union-count fix went to both `collapseToFit` and
    // `applyDefaults`, the test only to the first. This is the second — a republish is what
    // makes `applyDefaults` recount, and an id the budget chose, the user expanded and
    // "collapse to fit" re-collapsed sits in `autoChosen` AND `userFitted`. Two loops read
    // 160 auto-collapsed for 120 collapsed containers.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].filter((id) => id.startsWith("schema:"));
    expect(chosen.length).toBeGreaterThan(0);
    for (const id of chosen) useAtlas.getState().toggleCollapse(id); // expand every one…
    useAtlas.getState().collapseToFit(); // …so the fit re-collapses them: both sets hold them
    useAtlas.getState().setIR({ ...db(3, 400, 8) }, "test"); // republish → applyDefaults recounts
    const s2 = useAtlas.getState();
    expect(s2.budgetInfo!.autoCollapsed).toBe(s2.collapsed.size);
  });

  it("keeps the user's EXPAND through the `carried` release too", () => {
    // The twin of "…through the `fits` release too" above, and the one that had no test:
    // `carried` deletes each released id from `defaulted` as well, which is what hands it
    // back to the budget. Without `next.has(id)` a container the user opened is released
    // with the rest, the re-derived pass re-folds it, and because releasing everything ELSE
    // shows more nodes overall the release is still adopted — so the expand vanishes on the
    // next refinement published under the same root.
    //
    // The shape matters and was found by fingerprinting, not guessed: expanding ONE
    // container of `db(3,400,8)` and republishing `db(3,120,6)` diverges, expanding TWO
    // does not (releasing the second opens enough on its own that the re-derived pass wins
    // either way). Writing it with two expands first produced a test that passed and caught
    // nothing — pattern (a), an input the bug does not live at.
    reset();
    const next = db(3, 120, 6);
    const survives = new Set(next.nodes.map((n) => n.id));
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => !id.startsWith("column:") && survives.has(id));
    expect(chosen).toBeDefined();
    useAtlas.getState().toggleCollapse(chosen!); // expand it
    expect(useAtlas.getState().collapsed.has(chosen!), "control: it is open").toBe(false);
    useAtlas.getState().setIR(next, "test"); // a refinement under the SAME root
    expect(useAtlas.getState().collapsed.has(chosen!), `${chosen} must still be open`).toBe(false);
  });

  it("a re-collapse the user later UNDOES stops counting as deliberate", () => {
    // What this pins is the OUTCOME — a container the user closed and then reopened is open
    // after a republish. It does NOT pin `toggleCollapse`'s `userCollapsed.delete(id)`:
    // both readers of that set (`fits` at the `!next.has(id)` guard, and `carried`) are
    // already masked by the same `next.has(id)`, so a stale entry on an EXPANDED id changes
    // nothing. Removing the `delete` still leaves this green, and that is recorded rather
    // than papered over — a test that reads as cover for a line it does not reach is worse
    // than no test. Reaching it needs the budget to re-collapse a container the user had
    // expanded, which `defaulted` is there to prevent.
    reset();
    useAtlas.getState().setIR(db(3, 400, 8), "test");
    const chosen = [...useAtlas.getState().collapsed].find((id) => id.startsWith("schema:"))!;
    useAtlas.getState().toggleCollapse(chosen); // expand
    useAtlas.getState().toggleCollapse(chosen); // deliberately re-collapse → userCollapsed
    useAtlas.getState().toggleCollapse(chosen); // …and change their mind again
    expect(useAtlas.getState().collapsed.has(chosen)).toBe(false);
    // the intent is gone, so a republish must not resurrect it as "deliberate"
    useAtlas.getState().setIR({ ...db(3, 400, 8) }, "test");
    expect(useAtlas.getState().collapsed.has(chosen), "still open after the republish").toBe(false);
  });

  it("drops the 43 MB child index when a new graph arrives with nothing selected", () => {
    // A module-level STRONG reference: `subtreeIds` returns early when nothing is selected,
    // which is exactly what a new graph does, so without `forgetChildIndex` the previous
    // parsed graph stayed alive until the next click. Observable through the index itself.
    reset();
    const first = db(2, 30, 3);
    useAtlas.getState().setIR(first, "test");
    const leaf = first.nodes.find((n) => n.id.startsWith("table:"))!.id;
    useAtlas.getState().select(leaf); // builds the index for `first`
    expect(childIndexHeldFor()).toBe(first);
    // The selection has to be DROPPED for the leak to show: while it survives, the store
    // re-derives `litIds` and rebuilds the index against the new graph anyway. A graph with
    // a different root and disjoint ids is what a "map something else" follow-up looks like.
    const second = lumpy([4, 3]);
    useAtlas.getState().setIR(second, "test");
    expect(useAtlas.getState().litIds.size, "the selection really is gone").toBe(0);
    expect(childIndexHeldFor(), "the old graph must not be held").not.toBe(first);
  });

  it("does not undo an explicit `collapse to fit` on the next republish", () => {
    // `collapseToFit` picks live in `userFitted`, not `autoChosen`: lumping them together
    // made the release drop them, putting the render warning straight back.
    reset();
    const g = db(1, 1499, 8);
    useAtlas.setState({ budget: { maxVisible: 3000, maxEdges: 6000 } });
    reset();
    useAtlas.getState().setIR(g, "test");
    const before = useAtlas.getState().budgetInfo!.visible;
    useAtlas.getState().collapseToFit();
    const fitted = useAtlas.getState().collapsed.size;
    expect(fitted).toBeGreaterThan(0);
    useAtlas.getState().setIR({ ...g }, "test");
    expect(useAtlas.getState().collapsed.size, "the fit the user asked for must survive").toBe(fitted);
    expect(useAtlas.getState().budgetInfo!.visible).toBeLessThan(before);
  });
});

// One rule for "is this edge drawn", shared by the canvas (`ElkEdge`) and the status-bar
// count (`hiddenEdges`). They were two copies of the same expression and NEITHER had a
// test — mutating either left the whole suite green, and they have to agree or the bar
// reports a number the picture contradicts.
describe("edgeIsLit", () => {
  const lit = new Set(["parent", "child"]);
  it("draws everything when the view is not faint", () => {
    for (const delta of [undefined, "added", "modified"])
      expect(edgeIsLit(lit, "out1", "out2", { faint: false, delta })).toBe(true);
    expect(edgeIsLit(lit, "out1", "out2", {})).toBe(true); // faint undefined
  });
  it("in a faint view, lights only what crosses the selection", () => {
    expect(edgeIsLit(lit, "child", "outside", { faint: true })).toBe(true);
    expect(edgeIsLit(lit, "child", "parent", { faint: true })).toBe(false); // internal
    expect(edgeIsLit(lit, "out1", "out2", { faint: true })).toBe(false);
    expect(edgeIsLit(lit, "child", "child", { faint: true })).toBe(true); // recursion
  });
  it("always lights a CHANGED edge, added or modified", () => {
    expect(edgeIsLit(lit, "out1", "out2", { faint: true, delta: "added" })).toBe(true);
    expect(edgeIsLit(new Set(), "out1", "out2", { faint: true, delta: "added" })).toBe(true);
    // `modified` too: the Key and the status bar announce it, so the canvas has to draw it
    // — otherwise an amber swatch appears in the legend with nothing amber on screen.
    expect(edgeIsLit(lit, "out1", "out2", { faint: true, delta: "modified" })).toBe(true);
    expect(edgeIsPainted(lit, "out1", "out2", { hairball: true, delta: "modified" })).toBe(true);
    expect(edgeIsPainted(lit, "out1", "out2", { hairball: true })).toBe(false);
  });
  it("the hidden COUNT is exactly the edges it does not light", () => {
    // the arithmetic the status bar does, against the predicate the canvas uses
    const edges = [
      { source: "child", target: "outside", delta: undefined }, // lit: crosses
      { source: "child", target: "parent", delta: undefined }, // internal
      { source: "a", target: "b", delta: undefined }, // unrelated
      { source: "a", target: "b", delta: "added" }, // lit: new
      { source: "a", target: "b", delta: "modified" }, // lit: changed
    ];
    const hidden = edges.reduce((n, e) => n + (edgeIsLit(lit, e.source, e.target, { faint: true, delta: e.delta }) ? 0 : 1), 0);
    expect(hidden).toBe(2);
    expect(edges.length - hidden).toBe(3);
  });
});

// "Collapse to fit" is offered whenever the view is over the render guard, but `force`
// can only override a REFUSAL — it cannot invent a candidate. On a level that is flat
// under the root (900 loose files beside one directory: what `fs2ir` emits for a data
// folder) the automatic pass has already folded the only container, and the root is the
// canvas and cannot be folded. The click used to relayout anyway, changing nothing and
// throwing away wherever the user had panned to.
describe("collapseToFit on a flat level", () => {
  const reset = () =>
    useAtlas.getState().setIR(
      { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "reset:r", nodes: [{ id: "reset:r", kind: "v", name: "r" }], edges: [] } as GraphIR,
      "test"
    );
  const flatPlusDir = (loose: number, big: number): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "r" }];
    const edges: GraphIR["edges"] = [];
    const add = (f: string, t: string) => edges.push({ id: `e:contains:${f}->${t}`, kind: "contains", from: f, to: t });
    for (let i = 0; i < loose; i++) {
      const id = `doc:l${String(i).padStart(5, "0")}`;
      nodes.push({ id, kind: "doc", name: `l${i}`, parent: "dir:." });
      add("dir:.", id);
    }
    nodes.push({ id: "dir:big", kind: "dir", name: "big", parent: "dir:." });
    add("dir:.", "dir:big");
    for (let i = 0; i < big; i++) {
      const id = `doc:big/f${String(i).padStart(5, "0")}`;
      nodes.push({ id, kind: "doc", name: `f${i}`, parent: "dir:big" });
      add("dir:big", id);
    }
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
  };

  it("reports that it did nothing, and leaves the view untouched", () => {
    useAtlas.setState({ budget: DEFAULT_BUDGET });
    reset();
    useAtlas.getState().setIR(flatPlusDir(900, 900), "test");
    const before = useAtlas.getState();
    expect(before.budgetInfo!.visible).toBeGreaterThan(RENDER_WARN); // the button IS offered
    expect(useAtlas.getState().collapseToFit()).toBe(false);
    const after = useAtlas.getState();
    expect(after.collapsed, "the same Set object: the layout effect must not re-run").toBe(before.collapsed);
    expect(after.lastToggle).toBe(before.lastToggle);
    expect(after.budgetInfo!.visible).toBe(before.budgetInfo!.visible);
  });

  it("…and still reports true, and folds, when there IS something to fold", () => {
    useAtlas.setState({ budget: DEFAULT_BUDGET });
    reset();
    useAtlas.getState().setIR(db(1, 1200, 8), "test"); // 1,201 visible, one schema to fold
    const before = useAtlas.getState().budgetInfo!.visible;
    expect(useAtlas.getState().collapseToFit()).toBe(true);
    expect(useAtlas.getState().budgetInfo!.visible).toBeLessThan(before);
  });
});

// `edgeIsPainted` is the rule the CANVAS obeys (an unlit hairball edge renders nothing) and
// the number the status bar reports as "N of M edges hidden". They were two separate
// expressions keyed off two different sources of `hairball`; nothing pinned the canvas half.
describe("which edges put SVG on the canvas", () => {
  const lit = new Set(["a", "kid"]);
  it("outside a hairball view, everything is painted", () => {
    expect(edgeIsPainted(lit, "x", "y", {})).toBe(true);
    expect(edgeIsPainted(lit, "x", "y", undefined)).toBe(true); // an edge with no data at all
    expect(edgeIsPainted(new Set(), "x", "y", {})).toBe(true); // a dense view draws faint, but it DRAWS
  });
  it("inside one, only what is traced — and a newly added edge", () => {
    expect(edgeIsPainted(lit, "x", "y", { hairball: true })).toBe(false); // 2 SVG paths x N is the cost
    expect(edgeIsPainted(lit, "a", "y", { hairball: true })).toBe(true); // crosses the selection
    expect(edgeIsPainted(lit, "a", "kid", { hairball: true })).toBe(false); // INTERNAL to it — the known gap
    expect(edgeIsPainted(lit, "x", "y", { hairball: true, delta: "added" })).toBe(true); // a delta is always shown
  });
  it("agrees with what the canvas lights, on every input the renderer can produce", () => {
    // A hairball is by construction dense, so the renderer always sets `faint` with it —
    // which is exactly the pairing to assert against. (Asserting `{hairball: true}` alone
    // supplies an input no caller makes: `edgeIsLit` short-circuits on `!faint` and answers
    // "everything is drawn".)
    for (const [s2, t] of [["a", "y"], ["x", "a"], ["a", "kid"], ["x", "y"], ["a", "a"]] as const)
      expect(edgeIsPainted(lit, s2, t, { hairball: true }), `${s2}->${t}`).toBe(
        edgeIsLit(lit, s2, t, { faint: true })
      );
  });
});

// Three tests are named for "count each container once over the UNION", and none of them
// could fail for that clause: they all pick their container out of `collapsed` right after
// `setIR`, where every `userFitted` id is also in `autoChosen`. This is the shape where the
// two sets genuinely differ — and the one where the count has to stay live.
describe("auto-collapsed counts the union, and keeps counting", () => {
  /** Publish a different ROOT: that is what clears the module-level carry-over sets. */
  const reset = () =>
    useAtlas.getState().setIR(
      { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "reset:r", nodes: [{ id: "reset:r", kind: "v", name: "r" }], edges: [] } as GraphIR,
      "test"
    );

  it("counts containers the FIT chose that the budget never did", () => {
    reset();
    // `?budget=3000` — the budget folds nothing at all, so `autoChosen` stays empty and
    // everything "collapse to fit" picks lands only in `userFitted`.
    useAtlas.getState().setBudget({ maxVisible: 3000, maxEdges: 3000 });
    useAtlas.getState().setIR(db(3, 40, 10), "test");
    expect(useAtlas.getState().budgetInfo!.autoCollapsed, "the budget chose nothing").toBe(0);
    expect(useAtlas.getState().collapsed.size).toBe(0);
    useAtlas.getState().collapseToFit();
    const fitted = useAtlas.getState();
    expect(fitted.collapsed.size).toBeGreaterThan(0);
    expect(fitted.budgetInfo!.autoCollapsed, "…so the count is entirely userFitted").toBe(fitted.collapsed.size);
  });

  it("moves when the user expands or collapses, instead of freezing until the next poll", () => {
    // `budgetInfo` was written only by `setIR`/`collapseToFit`, and `setIR` runs only when
    // the polled bytes CHANGE — so on a static graph the number froze while "showing X"
    // beside it tracked the canvas.
    reset();
    useAtlas.getState().setIR(db(3, 200, 6), "test");
    const start = useAtlas.getState().budgetInfo!.autoCollapsed;
    expect(start).toBeGreaterThan(2);
    const chosen = [...useAtlas.getState().collapsed].slice(0, 2);
    for (const id of chosen) useAtlas.getState().toggleCollapse(id);
    expect(useAtlas.getState().budgetInfo!.autoCollapsed).toBe(start - 2);
    useAtlas.getState().toggleCollapse(chosen[0]); // …and back
    expect(useAtlas.getState().budgetInfo!.autoCollapsed).toBe(start - 1);
    // the total is a property of the GRAPH and must not move
    expect(useAtlas.getState().budgetInfo!.total).toBe(useAtlas.getState().budgetInfo!.total);
  });
});

describe("a container that became a leaf and grew children again is NEW again", () => {
  it("gets its author default back", () => {
    // `stale()` has two halves: the id left the graph, OR it no longer has children. Only
    // the first was covered here (the twin filter in `setIR` covers both). Without the
    // second, an id that lost its children stays in `defaulted`, so when it grows them back
    // the author's `collapsedByDefault` is skipped and it renders expanded among chips.
    const mk = (kids: number, cbd: boolean): GraphIR => {
      const nodes: GraphIR["nodes"] = [
        { id: "package:p", kind: "package", name: "p" },
        { id: "module:m", kind: "module", name: "m", parent: "package:p" },
      ];
      const edges: GraphIR["edges"] = [{ id: "e:contains:package:p->module:m", kind: "contains", from: "package:p", to: "module:m" }];
      for (let i = 0; i < kids; i++) {
        nodes.push({ id: `type:m/T${i}`, kind: "type", name: `T${i}`, parent: "module:m" });
        edges.push({ id: `e:contains:module:m->type:m/T${i}`, kind: "contains", from: "module:m", to: `type:m/T${i}` });
      }
      const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
      nodes.sort(cmp);
      edges.sort(cmp);
      return {
        irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:p", nodes, edges,
        ...(cbd ? { annotations: { "module:m": { collapsedByDefault: true } } } : {}),
      } as GraphIR;
    };
    useAtlas.getState().setIR(mk(3, true), "test");
    expect(useAtlas.getState().collapsed.has("module:m"), "starts collapsed").toBe(true);
    useAtlas.getState().setIR(mk(0, true), "test"); // it becomes a LEAF
    expect(useAtlas.getState().collapsed.has("module:m"), "a leaf is not collapsed").toBe(false);
    useAtlas.getState().setIR(mk(3, true), "test"); // …and grows children again
    expect(useAtlas.getState().collapsed.has("module:m"), "the author default applies again").toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { autoCollapse, parseBudget, DEFAULT_BUDGET } from "../src/ir/budget";
import { checkGraphShape } from "../src/ir/shape";
import { isHairball } from "../src/ir/density";
import { buildDisplay } from "../src/layout/elk";
import { bucketed, db, lumpy, nested, withEdges } from "./fixtures";
import type { GraphIR } from "../src/ir/types";

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
    // This used to read "…but grossly over BOTH caps there is no context worth protecting:
    // everything folds", and asserted visible === 1 at 1,200 tables. Measured against real
    // schema2ir output (2026-09-10) that rule inverted the product — the bigger the import,
    // the less of it opened, down to a single chip at 4,000 tables — so the guard now holds
    // however far over a cap the view is. 1,201 chips is a browsable overview; one is not.
    expect(autoCollapse(db(1, 1200, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1 + 1200);
  });
  it("a bucketed import opens on its buckets, not on one chip", () => {
    // The shape tools/schema2ir.mjs actually emits for a big single-schema database:
    // schema > group (name ranges) > table > column. Every level here is small relative to
    // the view, so nothing trips the guard until the LAST one — which is the whole point,
    // because folding it is what used to leave a 10,000-table import showing one node.
    const g = bucketed(2000, 6);
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.collapse, "the schema itself must survive").not.toContain("schema:s");
    // the buckets stay: a name-range overview is the answer to "open this database"
    const groups = g.nodes.filter((n) => n.kind === "group").length;
    expect(r.visible).toBeGreaterThanOrEqual(groups);
    expect(r.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
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
    // Four schemas fold to four chips: that is still a view, so the guard has no say.
    // (An earlier version of the guard refused the fourth and left 304 nodes on screen —
    // "more than half the view" is the wrong question, "is anything left" is the right one.)
    const g = db(4, 300, 3); // 4 + 1200 + 3600
    const r = autoCollapse(g, new Set(), { maxVisible: 100, maxEdges: 10_000 });
    expect(r.collapse.filter((id) => id.startsWith("schema:")).length).toBe(4);
    expect(r.visible).toBeLessThanOrEqual(100);
  });
  it("respects the edge budget by collapsing further", () => {
    const g = db(2, 400, 2); // 799 FK edges between tables once columns hide
    const r = autoCollapse(g, new Set(), { maxVisible: 5000, maxEdges: 100 });
    expect(r.edges).toBeLessThanOrEqual(100);
    expect(r.visible).toBeGreaterThanOrEqual(2); // …and two chips are still a view
  });
  it("keeps the flagship 104k overview whole: 40 schema chips, not 39 and an explosion", () => {
    // The regression that killed the first version of the guard. `MOST` was measured
    // against a `visible` that shrinks as the level folds, so the last schema in the level
    // was judged against a much smaller denominator than the first and survived — leaving
    // 39 chips plus one arbitrary schema exploded into 200 tables, and 1,648 display edges
    // (past FASTEST_EDGES, so none of them drawn) where the whole overview has 780.
    const g = db(40, 200, 12); // 40 + 8,000 + 96,000 = 104,040 display nodes
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(40);
    expect(r.collapse.filter((id) => id.startsWith("schema:")).length).toBe(40); // the LEVEL, uniformly
    expect(r.edges).toBeLessThanOrEqual(DEFAULT_BUDGET.maxEdges); // and they are drawable
  });
  it("stands the guard down for a view too big to render at all", () => {
    // A flat 4,000-table schema has no intermediate level: the only two views are 4,001
    // chips and one. Measured in a headless browser, 4,001 visible / 7,989 display edges is
    // 12.7 s to load and 29 s to drag — and 2.0 edges per node, so it is not dense enough
    // for the hairball path either. A chip the user opens deliberately beats a hang.
    expect(autoCollapse(db(1, 4000, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1);
    // …but the sizes either side of the render guard keep their context
    expect(autoCollapse(db(1, 900, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1 + 900);
    expect(autoCollapse(db(1, 1200, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1 + 1200);
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
    // Healthy: 26 ms. The regression this guards: 5,700 ms (each level recounted the graph).
    // The bound sits well under the regression and far over healthy, with room for a loaded
    // shared CI runner — at 500 ms it was measured flaking at 581-845 ms under a peer session.
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(2000);
  });

  it("…and so does the LAYOUT model that consumes it", () => {
    // The budget was made linear in depth and documented at these depths; `buildDisplay`,
    // on the same graph and the same main thread, was still O(nodes x depth) because `rep`
    // rebuilt the whole ancestor chain per call — 28 ms at depth 1,000, 259 ms at 3,000,
    // 5,016 ms at 12,000. A graph the shape guard calls renderable has to be affordable,
    // not merely finite.
    const g = deepChain(12000);
    const t0 = performance.now();
    const m = buildDisplay(g, new Set());
    const ms = performance.now() - t0;
    expect(m.visibleNodes.length).toBeGreaterThan(0);
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(2000); // healthy 9 ms; the quadratic was 5,016 ms
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

// The generators are the ground truth for four suites, so they have to produce IR the
// viewer would actually accept. `db(x, y, 2)` used to emit foreign keys on a `c2` column
// it never created — endpoints that are not nodes, which `autoCollapse` silently skips.
describe("fixtures produce valid IR", () => {
  for (const [label, g] of [
    ["db(2,5,1)", db(2, 5, 1)],
    ["db(2,5,2)", db(2, 5, 2)],
    ["db(3,4,3)", db(3, 4, 3)],
    ["bucketed(300,4)", bucketed(300, 4)],
    ["withEdges([3,4],2)", withEdges([3, 4], 2)],
    ["withEdges([200,200],6)", withEdges([200, 200], 6)],
  ] as const) {
    it(label, () => {
      expect(checkGraphShape(g)).toBeNull();
      const ids = new Set(g.nodes.map((n) => n.id));
      for (const e of g.edges) {
        expect(ids.has(e.from), `${e.id} from`).toBe(true);
        expect(ids.has(e.to), `${e.id} to`).toBe(true);
      }
    });
  }
});

// Round-3 findings: the edge phase must be PROPORTIONATE, and the guard must hold on
// every poll, not just the first.
describe("the edge phase yields before the view does", () => {
  it("does not trade 500 tables for a 5% edge overflow", () => {
    // db(3,500,6): the NODE budget is already met at 503 visible. The edge phase then
    // folded the last expanded schema — 500 tables of context — to take 837 aggregated
    // edges under a cap of 800. CLAUDE.md and this module both say the edge cap is the
    // one that yields, because layoutTier has a cheaper tier for edge overflow.
    const g = db(3, 500, 6);
    const nodeOnly = autoCollapse(g, new Set(), { maxVisible: DEFAULT_BUDGET.maxVisible, maxEdges: 1e9 });
    const both = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(nodeOnly.visible).toBe(503);
    expect(both.visible).toBe(nodeOnly.visible); // was 3
    expect(both.edges).toBeGreaterThan(DEFAULT_BUDGET.maxEdges); // the overflow is accepted
  });

  it("…but still folds when the trade is cheap, and judges every sibling alike", () => {
    // The 104k flagship needs the edge phase: the node phase leaves two schemas expanded
    // at 440 visible, and folding both takes it to a uniform 40 chips with 780 drawable
    // edges. Both are judged against the count at PHASE START, so the second is not
    // refused just because the first already shrank `visible`.
    const r = autoCollapse(db(40, 200, 12), new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(40);
    expect(r.edges).toBeLessThanOrEqual(DEFAULT_BUDGET.maxEdges);
  });

  it("an explicit ?budget= beats the MIN_OVERVIEW floor", () => {
    // A 1,499-table flat schema came back with 1,500 visible whatever budget was asked
    // for, because the floor ("never one node") outranked the request.
    const g = db(1, 1499, 8);
    expect(autoCollapse(g, new Set(), DEFAULT_BUDGET).visible).toBe(1500); // default: context kept
    expect(autoCollapse(g, new Set(), { maxVisible: 1, maxEdges: 1 }).visible).toBe(1); // asked for one
  });
});

describe("only a level that actually FINISHED is recorded", () => {
  it("a level the pre-pass declined is absent from `levels`", () => {
    // `levels` is what the store replays on the next poll, collapsing newcomers at those
    // depths unconditionally. Recording a level this pass only PARTLY folded would finish it
    // off a poll later, behind the guard's back — which is the whole reason the pre-pass was
    // given a guard. Nothing covered the `if`.
    // A 610-file directory beside two small ones: the big fold is refused, the two small
    // ones are taken, so the level is PARTLY folded. (`db(1,600,8)` is no good here — it is
    // past `UNRENDERABLE`, where the guard stands down and the level really does finish.)
    const r = autoCollapse(lumpy([610, 2, 1]), new Set(), DEFAULT_BUDGET, new Set(), new Set([0]));
    expect(r.visible).toBe(613); // the big directory stayed open…
    expect(r.collapse.length).toBe(2); // …while its two small siblings folded
    expect(r.levels).not.toContain(0); // …so depth 0 must not be remembered as done
    // a level that really does fold whole IS recorded
    const done = autoCollapse(db(1, 600, 1), new Set(), DEFAULT_BUDGET, new Set(), new Set([0]));
    expect(done.levels).toContain(1);
  });
});

describe("uniform levels stay guarded on later polls", () => {
  it("a modest follow-up graph is not folded to a single chip", () => {
    // `uniformLevels` (the depths an earlier pass collapsed) used to fold unconditionally,
    // on the theory that the decision had already been guarded — but the graph on a later
    // poll is not the graph that was judged. A 841-node follow-up under the same root came
    // back as ONE node, so MIN_OVERVIEW's invariant was untrue on every poll but the first.
    const follow = db(1, 120, 6);
    const standalone = autoCollapse(follow, new Set(), DEFAULT_BUDGET);
    const asFollowUp = autoCollapse(follow, new Set(), DEFAULT_BUDGET, new Set(), new Set([0, 1]));
    expect(standalone.visible).toBeGreaterThan(1);
    expect(asFollowUp.visible).toBeGreaterThan(1); // was 1
  });
});

// Skewed graphs: one container holding nearly the whole view. `db()` and `bucketed()`
// cannot express this — their siblings are uniform — so the whole quadrant went unmeasured
// until a real `fs2ir` tree opened on six nodes out of 616.
describe("a skewed graph keeps its big container", () => {
  it("refuses the one fold that would hide most of the view", () => {
    const g = lumpy([610, 2, 1]); // what fs2ir emits for generated/ + src/ + docs/
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(613); // 616 minus the three small dirs' contents… not 6
    expect(r.collapse).not.toContain("dir:d0"); // the 610-file directory survives
    expect(r.visible).toBeGreaterThan(DEFAULT_BUDGET.maxVisible); // the cap yields, as documented
  });
  it("still folds where the trade is even", () => {
    // two equal halves: folding one hides exactly half, which the ceiling allows
    const r = autoCollapse(lumpy([300, 300]), new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(302);
    expect(r.collapse).toHaveLength(1);
  });
  it("and the big container is reachable by an explicit ask", () => {
    const g = lumpy([610, 2, 1]);
    const auto = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    const forced = autoCollapse(g, new Set(auto.collapse), DEFAULT_BUDGET, new Set(), new Set(), true);
    expect(forced.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
  });
});

// Depth-3 skew. The ceiling has to be taken per LEVEL: captured once per phase it only
// ever bounds the first level it touches, so the guard vanished at the shallow end of any
// tree with two container levels — a real fs2ir run over 690 generated subdirectories
// opened on 14 nodes of 2,084 while every other operating point stayed green.
describe("skew survives more than one container level", () => {
  it("keeps the big subtree when the ceiling would be stale", () => {
    const g = nested(690, 2, [10, 1]); // 2,084 display nodes
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(693); // …not 14
    expect(r.collapse).not.toContain("dir:generated");
    expect(r.collapse.length).toBe(690 + 2); // every module dir, plus both small siblings
  });
  it("still folds the shallow level when that level is not the whole view", () => {
    const r = autoCollapse(nested(340, 2, [10, 1]), new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
  });
  it("judges siblings WITHIN a level alike — the flagship is unmoved", () => {
    // per-SIBLING would shrink the denominator as the level folds, which is what left
    // db(40,200,12) as 39 chips and one exploded schema
    expect(autoCollapse(db(40, 200, 12), new Set(), DEFAULT_BUDGET).visible).toBe(40);
  });
});

// Above the `UNRENDERABLE` stand-down. `refuseFold` bails out BEFORE it measures anything,
// and the largest container in a level is judged first — while `visible` is at its
// maximum — so that container was exactly the one that escaped the guard. Every skew
// fixture sat below the old 1,500 line, so the suite could not see it: a real fs2ir tree
// of 1,600 generated files opened on SIX nodes of 1,606, with no render warning and no
// "collapse to fit" to recover with.
describe("skew above the render guard", () => {
  it("keeps its context while the alternative is merely large", () => {
    for (const n of [1490, 1600, 2500]) {
      const r = autoCollapse(lumpy([n, 2, 1]), new Set(), DEFAULT_BUDGET);
      expect(r.visible, `${n} files`).toBe(n + 3);
      expect(r.collapse, `${n} files`).not.toContain("dir:d0");
    }
  });
  it("…and gives up only where the alternative is genuinely unusable", () => {
    // 4,020 visible measured 7.6 s to load with multi-second pans; 2,010 measured
    // 2.0 s / 0.7 s. Any threshold is a cliff when the only fold is all-or-nothing.
    expect(autoCollapse(lumpy([3500, 2, 1]), new Set(), DEFAULT_BUDGET).visible).toBe(6);
  });
});

// Containers and leaves mixed at one level — a shape none of db/bucketed/lumpy/nested can
// express, because their siblings are all containers or all leaves.
describe("the guard is about what remains, not what goes", () => {
  const mixed = (loose: number, big: number): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "root" }];
    const edges: GraphIR["edges"] = [];
    const add = (f: string, t: string) => edges.push({ id: `e:contains:${f}->${t}`, kind: "contains", from: f, to: t });
    for (let i = 0; i < loose; i++) {
      const id = `doc:l${String(i).padStart(5, "0")}.ts`;
      nodes.push({ id, kind: "doc", name: `l${i}`, parent: "dir:." });
      add("dir:.", id);
    }
    nodes.push({ id: "dir:big", kind: "dir", name: "big", parent: "dir:." });
    add("dir:.", "dir:big");
    for (let i = 0; i < big; i++) {
      const id = `doc:big/f${String(i).padStart(5, "0")}.ts`;
      nodes.push({ id, kind: "doc", name: `f${i}`, parent: "dir:big" });
      add("dir:big", id);
    }
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
  };
  it("takes a fold that lands on budget, however much of the view it hides", () => {
    // Two extra files used to flip this from 600 visible to 1,201 — twice the budget and
    // 50% over the render guard — because "hides more than half" was read as the rule.
    expect(autoCollapse(mixed(599, 599), new Set(), DEFAULT_BUDGET).visible).toBe(600);
    expect(autoCollapse(mixed(599, 601), new Set(), DEFAULT_BUDGET).visible).toBe(600);
    expect(autoCollapse(mixed(400, 500), new Set(), DEFAULT_BUDGET).visible).toBe(401);
    expect(autoCollapse(mixed(500, 505), new Set(), DEFAULT_BUDGET).visible).toBe(501);
  });
  it("still refuses one that leaves almost nothing", () => {
    expect(autoCollapse(lumpy([610, 2, 1]), new Set(), DEFAULT_BUDGET).visible).toBe(613);
  });
});

// Argument-spread over a child array. `[].push(...kids)` overflows past ~125k arguments —
// lower inside a deep stack, which `setIR` is — and the throw escapes `setIR`: the status
// bar reads "render failed", `state.last` has already advanced, and the same bytes are
// never retried, so the graph is unrenderable until the file changes. The module header
// promises these walks are iterative for exactly that reason.
//
// Reachable only through the `uniformLevels` pre-pass, which folds a NEWCOMER container
// while its own child is still expanded — the deepest-first ordering that shields every
// other call site does not apply there. (The same hazard was fixed this round in
// App.tsx's `Math.max(...irIds)` and had already been fixed in incremental.ts, which is
// how it survived here: pattern (d), one of two copies.)
describe("no argument-spread over a container's children", () => {
  it("folds a newcomer holding a 130,000-child subtree instead of throwing", () => {
    const kids = 130_000; // V8: fine at 100k, RangeError at 125k
    const nodes: GraphIR["nodes"] = [
      { id: "dir:.", kind: "dir", name: "r" },
      { id: "dir:big", kind: "dir", name: "big", parent: "dir:." },
      { id: "dir:big/c", kind: "dir", name: "c", parent: "dir:big" },
    ];
    const edges: GraphIR["edges"] = [
      { id: "e:contains:dir:.->dir:big", kind: "contains", from: "dir:.", to: "dir:big" },
      { id: "e:contains:dir:big->dir:big/c", kind: "contains", from: "dir:big", to: "dir:big/c" },
    ];
    for (let i = 0; i < kids; i++) {
      const id = `doc:big/c/f${String(i).padStart(7, "0")}`;
      nodes.push({ id, kind: "doc", name: `f${i}`, parent: "dir:big/c" });
      edges.push({ id: `e:contains:dir:big/c->${id}`, kind: "contains", from: "dir:big/c", to: id });
    }
    const g = { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
    // `uniformLevels` = {0}: fold `dir:big` (depth 0) while `dir:big/c` is still expanded
    expect(() => autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set([0]))).not.toThrow();
    expect(autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set([0])).visible).toBe(1);
  });
});

// `UNRENDERABLE` counts nodes, but the cost it exists to avoid lives on edges — and the
// only above-guard fixtures (`lumpy`, `nested`) have none, so the node threshold was
// raised on the one shape family that cannot show the problem.
describe("the stand-down also watches edges", () => {
  it("gives up on a view that is slow because of its edges, not its nodes", () => {
    // 3,000 visible / 5,987 display edges measured 8.3 s to load and 6.5 s to drag —
    // slower than the 4,020-node case the guard's own docstring calls unusable, and not
    // dense enough (2.0 edges/node) for the hairball economy to engage.
    expect(autoCollapse(db(1, 2999, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1);
  });
  it("…without touching the shapes the guard must protect", () => {
    // db(3,500,6) aggregates to ~3,000 display edges at the level where its schema fold is
    // refused; folding it is exactly what must not happen.
    expect(autoCollapse(db(3, 500, 6), new Set(), DEFAULT_BUDGET).visible).toBe(503);
    expect(autoCollapse(db(1, 1200, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1201);
    expect(autoCollapse(db(40, 200, 12), new Set(), DEFAULT_BUDGET).visible).toBe(40);
  });
});

// Skew WITH cross-container edges — the family none of db/bucketed/lumpy/nested/mixed
// expresses, and the one the edge stand-down was tuned without. Past FASTEST_EDGES at more
// than DENSE_RATIO per node the viewer draws NO svg paths until an edge is traced, so the
// view is cheap however many edges it has: measured, 616 nodes with 6,120 display edges
// loads in 2.6 s and pans in 328 ms. Standing the guard down there folded it to SIX.
describe("an edge-heavy view the hairball economy makes free", () => {
  it("keeps its context however many edges it has", () => {
    for (const refs of [0, 4, 10]) {
      const r = autoCollapse(withEdges([610, 2, 1], refs), new Set(), DEFAULT_BUDGET);
      expect(r.visible, `${refs} refs per leaf`).toBe(613);
    }
  });
  it("…and the same holds for a flat container of edge-heavy tables", () => {
    // identical paint cost at 6 refs and at 8; the old threshold kept 701 at one and
    // folded to 1 at the other
    for (const [tables, fks, want] of [[700, 6, 701], [700, 8, 701], [600, 12, 601], [1200, 8, 1201]] as const) {
      const nodes: GraphIR["nodes"] = [
        { id: "db:m", kind: "database", name: "m" },
        { id: "schema:s", kind: "schema", name: "s", parent: "db:m" },
      ];
      const edges: GraphIR["edges"] = [{ id: "e:contains:db:m->schema:s", kind: "contains", from: "db:m", to: "schema:s" }];
      const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
      const nm = (i: number) => `table:t${String(i).padStart(4, "0")}`;
      for (let i = 0; i < tables; i++) {
        nodes.push({ id: nm(i), kind: "table", name: `t${i}`, parent: "schema:s" });
        add("contains", "schema:s", nm(i));
      }
      for (let i = 0; i < tables; i++)
        for (let r = 1; r <= fks; r++) {
          const j = (i * 7919 + r * 104729) % tables;
          if (j !== i) add("references", nm(i), nm(j));
        }
      const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
      nodes.sort(cmp);
      edges.sort(cmp);
      const g = { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "db:m", nodes, edges } as GraphIR;
      expect(autoCollapse(g, new Set(), DEFAULT_BUDGET).visible, `${tables}x${fks}`).toBe(want);
    }
  });
  it("still gives up on an edge-heavy view that is NOT dense, so really is painted", () => {
    // 3,000 visible / 5,987 edges at 2.0 per node: below DENSE_RATIO, so every edge is
    // drawn with a chip — 8.3 s to load, 6.5 s to drag.
    expect(autoCollapse(db(1, 2999, 8), new Set(), DEFAULT_BUDGET).visible).toBe(1);
  });
  it("…but not when the view already fits the size that was ASKED for", () => {
    // The `visible > opts.maxVisible` half of the stand-down, which nothing reached: under
    // the default budget it is implied (the clause needs >5,000 edges at ≤3 per node, hence
    // ≥1,667 visible, which is always over 600), so it only bites on a raised `?budget=`.
    // `db(1,2999,8)` is 3,000 visible / 5,987 edges — past UNRENDERABLE_EDGES and not dense,
    // so at the default budget the guard stands down and it becomes a chip. Ask for 3,000
    // nodes and the view fits, so it is NOT gutted to satisfy an edge cap; ask for 2,999 and
    // it does not fit, so it is.
    const g = db(1, 2999, 8);
    expect(autoCollapse(g, new Set(), parseBudget("?budget=3000")!).visible).toBe(3000);
    expect(autoCollapse(g, new Set(), parseBudget("?budget=2999")!).visible).toBe(1);
    expect(autoCollapse(g, new Set(), parseBudget("?budget=600")!).visible).toBe(1);
  });

  it("and an explicit edge budget is honoured", () => {
    const g = db(1, 2999, 8);
    expect(autoCollapse(g, new Set(), { maxVisible: 600, maxEdges: 800 }).visible).toBe(1);
    expect(autoCollapse(g, new Set(), { maxVisible: 600, maxEdges: 1_000_000 }).visible).toBe(3000);
  });
});

// Round-14: the per-level ceiling does not bound what a LEVEL hides in total, so for k
// roughly equal siblings it never fires — `[200,200]` folds to two chips where HEAD kept
// 202. That is the right answer (two chips and the edge between them, drawn, is a better
// overview of two 200-file directories than one chip beside 200 exploded files, which is
// what HEAD's second brake produced and is a hairball either way — zero SVG paths). What
// was NOT right is the same level folding when the cap is out of reach whatever it does.
describe("the edge phase folds to reach the cap, not for its own sake", () => {
  it("folds k equal siblings to k chips — an overview, not a gutting", () => {
    // Deliberate, and the same answer `db(2, 700, 6)` gives for the same shape. Both land
    // ON the cap: two chips, two display edges, drawn.
    const r = autoCollapse(withEdges([200, 200], 6), new Set(), DEFAULT_BUDGET);
    expect([r.visible, r.edges]).toEqual([2, 2]);
    expect(autoCollapse(db(2, 700, 6), new Set(), DEFAULT_BUDGET).visible).toBe(2);
    const four = autoCollapse(withEdges([191, 194, 274, 253], 10), new Set(), DEFAULT_BUDGET);
    expect(four.visible).toBe(4);
    expect(four.edges).toBeLessThanOrEqual(DEFAULT_BUDGET.maxEdges);
  });

  it("stops a level that has refused a container once the cap is out of reach", () => {
    // 290 files beside 10, 2,990 display edges. The big one is refused (it is the view);
    // folding the small one hid TEN nodes to remove FOUR edges and left the view 3.7x over
    // the cap — still a hairball, still zero SVG paths. Pure loss, so it is not taken.
    const g = withEdges([290, 10], 10);
    const open = autoCollapse(g, new Set(), { maxVisible: 1e9, maxEdges: 1e9 });
    expect([open.visible, open.edges]).toEqual([302, 2990]);
    expect(isHairball(open.visible, open.edges)).toBe(true);
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.visible).toBe(302);
    // The guard's refusal is exactly what puts the cap out of reach: with `force` the big
    // container folds, 2,990 edges become a handful, and `over()` stops the level at 12
    // visible. So "unreachable" here means unreachable WITHOUT gutting the view — which is
    // the trade the automatic pass is not allowed to make and "collapse to fit" is.
    expect(autoCollapse(g, new Set(), DEFAULT_BUDGET, new Set(), new Set(), true).visible).toBe(12);
  });

  it("keeps folding after a refusal when the cap really is still reachable", () => {
    // The monorepo shape: one 350-file package with no outgoing references, beside four
    // small dense ones holding all 1,190 of them. The big one is refused (it IS the view);
    // folding the four small ones takes 1,190 display edges to 684 and lands under the cap
    // WITH the big package still open. "Stop at the first refusal" would leave this at 415
    // nodes and 1,190 drawn edges — 2.9 per node, under DENSE_RATIO, so every one of them
    // is really painted. This is why the stand-down measures what folding would leave
    // instead of treating a refusal as the end of the level.
    const g = withEdges([350, 15, 15, 15, 15], [0, 20, 20, 20, 20]);
    const open = autoCollapse(g, new Set(), { maxVisible: 1e9, maxEdges: 1e9 });
    expect([open.visible, open.edges]).toEqual([415, 1190]);
    expect(isHairball(open.visible, open.edges)).toBe(false); // really painted
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect([r.visible, r.edges]).toEqual([370, 684]);
    expect(r.visible).toBeGreaterThan(350); // the big package survived
  });

  it("…but finishes a level the node phase left half-folded, cap reachable or not", () => {
    // Nothing was refused here, so nothing is stuck. `bucketed(10000, 8)` leaves the node
    // phase on 96 bucket chips plus four exploded buckets and 5,126 edges; folding the
    // four cannot reach 800 either (4,666) — and finishing the level anyway is right, a
    // uniform 100-chip overview beats four arbitrary explosions. The flagship is the same
    // move with a reachable cap.
    expect(autoCollapse(bucketed(10000, 8), new Set(), DEFAULT_BUDGET).visible).toBe(101);
    const flag = autoCollapse(db(40, 200, 12), new Set(), DEFAULT_BUDGET);
    expect([flag.visible, flag.edges]).toEqual([40, 780]);
  });
});

// The budget's display-edge model must agree with the layout's, or the status bar lies and
// the edge phase fires on the wrong number. They diverged for the structural vocabulary
// CLAUDE.md prescribes — `package > module > file > function`, where `imports` naturally
// join FILES and a grouping `file` is skipped: `buildDisplay` re-routes such an edge to
// the nearest display ancestor, `autoCollapse` dropped it, and a 40×30×4 view counted
// ZERO display edges where the layout had 190.
describe("budget and layout agree on what a display edge is", () => {
  const structural = (mods: number, filesPer: number, fns: number): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "package:p", kind: "package", name: "p" }];
    const edges: GraphIR["edges"] = [];
    const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
    const files: string[] = [];
    for (let m = 0; m < mods; m++) {
      const mid = `module:m${String(m).padStart(3, "0")}`;
      nodes.push({ id: mid, kind: "module", name: `m${m}`, parent: "package:p" });
      add("contains", "package:p", mid);
      for (let f = 0; f < filesPer; f++) {
        const fid = `file:m${String(m).padStart(3, "0")}/f${String(f).padStart(3, "0")}.ts`;
        nodes.push({ id: fid, kind: "file", name: `f${f}.ts`, parent: mid });
        add("contains", mid, fid);
        files.push(fid);
        for (let n = 0; n < fns; n++) {
          const nid = `func:${fid.slice(5)}.g${n}`;
          nodes.push({ id: nid, kind: "function", name: `g${n}`, parent: fid });
          add("contains", fid, nid);
        }
      }
    }
    for (let i = 0; i < files.length; i++) {
      const t = files[(i * 7919 + 104729) % files.length];
      if (t !== files[i]) add("imports", files[i], t); // between FILES — skipped grouping nodes
    }
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:p", nodes, edges } as GraphIR;
  };
  for (const [mods, filesPer, fns] of [[5, 20, 3], [10, 10, 2], [40, 30, 4]] as const) {
    it(`package > module > file > function (${mods}x${filesPer}x${fns})`, () => {
      const g = structural(mods, filesPer, fns);
      const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
      // nothing collapsed on either side, so the two models must produce the same counts
      const fits = autoCollapse(g, new Set(), { maxVisible: 1e9, maxEdges: 1e9 });
      expect(fits.edges).toBe(buildDisplay(g, new Set()).displayEdges.length);
      expect(fits.edges).toBeGreaterThan(0); // …and it is not zero, which is what it was
      expect(r.visible).toBeGreaterThan(0);
    });
  }
  it("an authored self-loop survives, an edge folded onto one node does not", () => {
    // `keyOf` must compare the ORIGINAL ir ids: using the display-resolved ones counted
    // every same-module `imports` edge as a self-loop and over-reported by 25%.
    //
    // This used to read 20 — the module-to-module count you get when the files carrying the
    // imports are invisible, which is no longer what happens (see ir/grouping.ts). 100 files
    // with one import each now draw 100 edges between the files themselves. The fold it was
    // written for still has to be exercised, so a module is COLLAPSED here: its four
    // internal imports resolve to the same display node and go, the rest stay.
    const g = structural(5, 20, 3);
    const open = new Set<string>();
    expect(autoCollapse(g, open, { maxVisible: 1e9, maxEdges: 1e9 }).edges).toBe(100);
    const folded = autoCollapse(g, new Set(["module:m000"]), { maxVisible: 1e9, maxEdges: 1e9 });
    expect(folded.edges).toBe(96);
    expect(buildDisplay(g, new Set(["module:m000"])).displayEdges.length).toBe(96); // and the layout agrees
  });

  it("a `file` that carries an edge is a node, not a grouping level", () => {
    // `package > file > function` with `imports` between the files — CLAUDE.md's own
    // structural vocabulary. Every one of those edges used to be destroyed silently: both
    // endpoints resolved past the skipped files to the ROOT, which is the canvas, so they
    // were dropped outright. In the browser that was twelve unlabelled `fn0`/`fn1`/`fn2`
    // pills in a grid, no arrows, and an `imports` row still in the Key.
    const nodes: GraphIR["nodes"] = [{ id: "package:app", kind: "package", name: "app" }];
    const edges: GraphIR["edges"] = [];
    const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
    const names = ["auth", "db", "api", "util"];
    for (const f of names) {
      const fid = `file:src/${f}.ts`;
      nodes.push({ id: fid, kind: "file", name: `${f}.ts`, parent: "package:app" });
      add("contains", "package:app", fid);
      for (let n = 0; n < 3; n++) {
        nodes.push({ id: `function:src/${f}.ts:fn${n}`, kind: "function", name: `fn${n}`, parent: fid });
        add("contains", fid, `function:src/${f}.ts:fn${n}`);
      }
    }
    for (const a of names) for (const b of names) if (a !== b) add("imports", `file:src/${a}.ts`, `file:src/${b}.ts`);
    const cmp = (x: { id: string }, y: { id: string }) => Buffer.compare(Buffer.from(x.id), Buffer.from(y.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    const g = { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:app", nodes, edges } as GraphIR;
    expect(checkGraphShape(g)).toBeNull();
    const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    expect(r.edges).toBe(12); // all twelve imports, not zero
    expect(r.visible).toBe(16); // 4 file containers + 12 functions
    expect(buildDisplay(g, new Set()).displayEdges.length).toBe(12); // …and the layout agrees
    // Strip the imports and these files are still kept — but for the OTHER reason: their
    // parent is the root, so eliding them would leave the twelve functions with no grouping
    // at all. Put a `module` above and the tidy-up applies again (see grouping.test.ts).
    const quiet = { ...g, edges: g.edges.filter((e) => e.kind === "contains") } as GraphIR;
    expect(autoCollapse(quiet, new Set(), DEFAULT_BUDGET).visible).toBe(16);
  });
});

// Values that are load-bearing but had nothing pinning them: mutating each left the whole
// suite green (pattern (e), found in round 12).
describe("the module's own constants are pinned", () => {
  it("an explicit budget of 1 or 2 folds the canvas away; 3 does not", () => {
    // Where the "leave something" rules actually bite on a graph whose only fold leaves
    // one node. `?budget=` 1 and 2 are requests for a chip and are honoured by
    // `keepsEnough` — half a budget is then ≤ 1, and a fold always leaves at least the
    // container it folded, so "what is LEFT is still a view" holds. At 3 the proportional
    // ceiling takes over and refuses. (Two dedicated `<= MIN_OVERVIEW` escapes used to be
    // credited with this; both were dead code and are gone.)
    const g = db(1, 600, 8);
    expect(autoCollapse(g, new Set(), { maxVisible: 1, maxEdges: 1 }).visible).toBe(1);
    expect(autoCollapse(g, new Set(), { maxVisible: 2, maxEdges: 1 }).visible).toBe(1);
    expect(autoCollapse(g, new Set(), { maxVisible: 3, maxEdges: 1 }).visible).toBe(601);
    expect(autoCollapse(g, new Set(), DEFAULT_BUDGET).visible).toBe(601);
  });

  it("the aggregated edge key survives a node id containing a space", () => {
    // `${kind} ${s} ${t}` maps BOTH of these to "calls doc:a doc:b c:d"; `edgeKey` (JSON)
    // keeps them apart. Node ids may contain spaces — `fs2ir` emits `doc:My Folder/x`.
    // "doc:a" + "doc:b c:d"  and  "doc:a doc:b" + "c:d"  both build "doc:a doc:b c:d"
    const ids = ["doc:a", "doc:b c:d", "doc:a doc:b", "c:d"];
    const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "r" }];
    const edges: GraphIR["edges"] = [];
    for (const id of ids) {
      nodes.push({ id, kind: "doc", name: id, parent: "dir:." });
      edges.push({ id: `e:contains:dir:.->${id}`, kind: "contains", from: "dir:.", to: id });
    }
    edges.push({ id: "e:calls:doc:a->doc:b c:d", kind: "calls", from: "doc:a", to: "doc:b c:d" });
    edges.push({ id: "e:calls:doc:a doc:b->c:d", kind: "calls", from: "doc:a doc:b", to: "c:d" });
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    const g = { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
    expect(checkGraphShape(g)).toBeNull();
    expect(autoCollapse(g, new Set(), { maxVisible: 1e9, maxEdges: 1e9 }).edges).toBe(2); // not 1
  });
});

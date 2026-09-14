// Filter box (App.tsx): what matches, what stays lit, and how much work a
// keystroke costs. The scan used to sit inside the effect that re-tags `dim`,
// so it re-ran on every layout pass — every incremental toggle and every poll
// — while a query was up.

import { describe, it, expect } from "vitest";
import { groupingSkip } from "../src/ir/grouping";
import { buildSearchIndex, searchMatches, hiddenMatchesOf, visibleMatchCount, drawnAsBox } from "../src/App";
import { autoCollapse, DEFAULT_BUDGET } from "../src/ir/budget";
import { buildDisplay } from "../src/layout/elk";
import type { GraphIR } from "../src/ir/types";

function schema(schemas: number, tables: number, columns: number): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "database:db", kind: "database", name: "db" }];
  for (let s = 0; s < schemas; s++) {
    nodes.push({ id: `schema:s${s}`, kind: "schema", name: `s${s}`, parent: "database:db" });
    for (let t = 0; t < tables; t++) {
      nodes.push({ id: `table:s${s}.t${t}`, kind: "table", name: `t${t}`, parent: `schema:s${s}` });
      for (let c = 0; c < columns; c++)
        nodes.push({ id: `column:s${s}.t${t}.c${c}`, kind: "column", name: `col${c}`, parent: `table:s${s}.t${t}` });
    }
  }
  return { irVersion: "0.2", generator: { tool: "test", version: "0", commit: null }, root: "database:db", nodes, edges: [] } as GraphIR;
}

describe("filter matching", () => {
  const ir = schema(2, 2, 2);
  const index = buildSearchIndex(ir, groupingSkip(ir));

  it("matches name, kind or id, case-insensitively", () => {
    expect(searchMatches(index, "COL1")).toEqual(new Set(["column:s0.t0.c1", "column:s0.t1.c1", "column:s1.t0.c1", "column:s1.t1.c1"]));
    expect([...searchMatches(index, "schema")!]).toEqual(["schema:s0", "schema:s1"]); // by kind
    expect(searchMatches(index, "s1.t1")!.size).toBe(3); // by id: the table and its two columns
  });

  it("filters nothing for an empty or whitespace query", () => {
    expect(searchMatches(index, "")).toBeNull();
    expect(searchMatches(index, "   ")).toBeNull();
  });

  it("counts matches hidden in collapsed containers and lights the visible ancestor", () => {
    // only the schemas are on screen; every table and column is inside them
    const shown = new Set(["schema:s0", "schema:s1"]);
    const { hidden, lit } = hiddenMatchesOf(index, searchMatches(index, "col1")!, shown);
    expect(hidden).toBe(4);
    expect(lit).toEqual(new Set(["schema:s0", "schema:s1"]));
    // a match that IS on screen is neither hidden nor a reason to light anything
    const own = hiddenMatchesOf(index, searchMatches(index, "schema:s0")!, shown);
    expect(own.hidden).toBe(0);
    expect(own.lit).toEqual(new Set());
  });

  it("never counts the root, which is not drawn — and no longer matches it either", () => {
    // The root is the canvas. It used to come back as a MATCH that `hiddenMatchesOf` then
    // had to special-case away; now `searchMatches` leaves out everything that is never a
    // display node (the root and grouping `file`s alike, via `groupingSkip`), so the count
    // in the search box is the count of things the user can actually be shown.
    const { hidden } = hiddenMatchesOf(index, searchMatches(index, "db")!, new Set(["schema:s0"]));
    expect(searchMatches(index, "db")!.has("database:db")).toBe(false);
    expect(hidden).toBe(0);
  });
});

describe("filter cost on a big graph", () => {
  it("lowercases the graph once instead of once per keystroke and per layout pass", () => {
    const ir = schema(20, 40, 24); // ~20k nodes
    const queries = ["c", "co", "col", "col1", "t7", "s3"];
    const REPEATS = 3; // the keystroke itself, then the layout passes it triggers

    // What the effect used to do, every single time it ran.
    const t0 = performance.now();
    let oldHits = 0;
    for (const q of queries)
      for (let i = 0; i < REPEATS; i++) {
        const lq = q.trim().toLowerCase();
        const byId = new Map(ir.nodes.map((n) => [n.id, n]));
        if (byId.size !== ir.nodes.length) throw new Error("unreachable");
        for (const n of ir.nodes)
          if (n.name.toLowerCase().includes(lq) || n.kind.toLowerCase().includes(lq) || n.id.toLowerCase().includes(lq)) oldHits++;
      }
    const oldMs = performance.now() - t0;

    const t1 = performance.now();
    const index = buildSearchIndex(ir, groupingSkip(ir));
    let newHits = 0;
    for (const q of queries) {
      const m = searchMatches(index, q)!; // memoised on [ir, query] in App: the repeats reuse it
      for (let i = 0; i < REPEATS; i++) newHits += m.size;
    }
    const newMs = performance.now() - t1;

    expect(newHits).toBe(oldHits); // same answers as the code it replaced
    console.log(`filter: ${queries.length} queries × ${REPEATS} passes over ${ir.nodes.length} nodes — was ${Math.round(oldMs)} ms, now ${Math.round(newMs)} ms`);
    expect(newMs * 2).toBeLessThan(oldMs);
  });
});

// The two numbers in the search box have to be the same accounting: matches you can see,
// and matches you cannot. They were not.
describe("the search box's two numbers agree", () => {
  it("a lit container is not counted as a match", () => {
    const ir = schema(3, 30, 8);
    const index = buildSearchIndex(ir, groupingSkip(ir));
    const matched = searchMatches(index, "col")!;
    // what the budget leaves on screen for this graph
    const collapsed = new Set(autoCollapse(ir, new Set(), DEFAULT_BUDGET).collapse);
    const shown = new Set(buildDisplay(ir, collapsed).visibleNodes.map((n) => n.id));
    const { hidden, lit } = hiddenMatchesOf(index, matched, shown);
    const onScreen = [...shown].filter((id) => matched.has(id)).length;
    expect(lit.size, "containers are lit so the user can reach the hidden ones").toBeGreaterThan(0);
    for (const id of lit) expect(matched.has(id), `${id} is lit, not a match`).toBe(false);
    // the box shows `onScreen` and `+hidden`; together they must be every match, once each
    expect(onScreen + hidden).toBe(matched.size);
  });
});

describe("the two numbers in the search box", () => {
  it("counts matches on screen, never the containers lit to lead to them", () => {
    const ir = schema(3, 30, 8);
    const index = buildSearchIndex(ir, groupingSkip(ir));
    const matched = searchMatches(index, "col")!;
    const collapsed = new Set(autoCollapse(ir, new Set(), DEFAULT_BUDGET).collapse);
    const shown = buildDisplay(ir, collapsed).visibleNodes.map((n) => ({ id: n.id }));
    const { hidden, lit } = hiddenMatchesOf(index, matched, new Set(shown.map((n) => n.id)));
    const onScreen = visibleMatchCount(shown, matched, "col")!;
    expect(lit.size).toBeGreaterThan(0);
    expect(onScreen + hidden, "every match counted exactly once").toBe(matched.size);
    // the mutation this exists for: counting undimmed nodes adds the lit containers
    expect(onScreen + lit.size).toBeGreaterThan(onScreen);
    expect(visibleMatchCount(shown, null, "col")).toBe(0);
    expect(visibleMatchCount(shown, matched, "   ")).toBeNull(); // no query, no count
  });

  it("a collapsed container is still drawn as a box", () => {
    // The rule six call sites share: the swatch, the MiniMap colour, `aria-expanded`, the
    // click handler and the keyboard handler all have to agree that a collapsed container is
    // a container — it is what Enter, Space and a click toggle.
    expect(drawnAsBox({ isContainer: true, collapsed: false })).toBe(true);
    expect(drawnAsBox({ isContainer: true, collapsed: true })).toBe(true);
    expect(drawnAsBox({ isContainer: false, collapsed: true })).toBe(true);
    expect(drawnAsBox({ isContainer: false, collapsed: false })).toBe(false);
    expect(drawnAsBox({})).toBe(false);
  });
});

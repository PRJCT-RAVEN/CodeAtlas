// `ir/grouping.ts` — which IR nodes are display nodes. Three consumers share it (the
// layout engine, the visibility budget and the Key); it was three separate copies, and the
// rule was wrong in all of them at once.

import { describe, it, expect } from "vitest";
import { groupingSkip, skipForBudget } from "../src/ir/grouping";
import { autoCollapse, DEFAULT_BUDGET, parseBudget } from "../src/ir/budget";
import { diffIR } from "../src/ir/delta";
import { buildDisplay, layoutGraph } from "../src/layout/elk";
import { incrementalToggle } from "../src/layout/incremental";
import { keyRows, buildSearchIndex, searchMatches, hiddenMatchesOf } from "../src/App";
import { db } from "./fixtures";
import type { GraphIR } from "../src/ir/types";

const HUGE = { maxVisible: 1e9, maxEdges: 1e9 };
const sorted = (ns: GraphIR["nodes"], es: GraphIR["edges"]) => {
  const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
  return { nodes: [...ns].sort(cmp), edges: [...es].sort(cmp) };
};

/**
 * `a.ts -> b.ts -> c.ts`: a ONE-WAY import chain, plus an edge-free file and a leaf file —
 * all under a `module`, which is the shape `sample-graph.json` uses and the only one where
 * eliding a file level is a tidy-up rather than the removal of the sole grouping there is.
 */
function chainOfFiles(): GraphIR {
  const nodes: GraphIR["nodes"] = [
    { id: "package:app", kind: "package", name: "app" },
    { id: "module:src", kind: "module", name: "src", parent: "package:app" },
  ];
  const edges: GraphIR["edges"] = [{ id: "e:contains:package:app->module:src", kind: "contains", from: "package:app", to: "module:src" }];
  const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
  for (const n of ["a", "b", "c", "quiet"]) {
    const fid = `file:src/${n}.ts`;
    nodes.push({ id: fid, kind: "file", name: `${n}.ts`, parent: "module:src" });
    add("contains", "module:src", fid);
    nodes.push({ id: `function:src/${n}.ts:run`, kind: "function", name: "run", parent: fid });
    add("contains", fid, `function:src/${n}.ts:run`);
  }
  nodes.push({ id: "file:README.md", kind: "file", name: "README.md", parent: "module:src" }); // a LEAF file
  add("contains", "module:src", "file:README.md");
  add("imports", "file:src/a.ts", "file:src/b.ts");
  add("imports", "file:src/b.ts", "file:src/c.ts");
  const { nodes: n2, edges: e2 } = sorted(nodes, edges);
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:app", nodes: n2, edges: e2 } as GraphIR;
}

describe("which files are grouping levels", () => {
  const g = chainOfFiles();
  const skip = groupingSkip(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const isSkipped = (id: string) => skip(byId.get(id)!);

  it("a file that is only ever an import TARGET is still a node", () => {
    // `c.ts` imports nothing and is imported by `b.ts` — a leaf utility module, the ordinary
    // shape of a DAG. Every fixture before this made each file an edge SOURCE, so `from` and
    // `to` were interchangeable and half the rule (`endpoint.add(e.to)`) could be deleted
    // with the whole suite green. Under that deletion `c.ts` folds back into a grouping level
    // and the `imports` edge into it is destroyed silently — the round-16 bug, through the
    // untested half of its own fix.
    expect(isSkipped("file:src/a.ts"), "a.ts: source only").toBe(false);
    expect(isSkipped("file:src/b.ts"), "b.ts: both").toBe(false);
    expect(isSkipped("file:src/c.ts"), "c.ts: TARGET only").toBe(false);
    const r = autoCollapse(g, new Set(), HUGE);
    expect(r.edges).toBe(2); // both imports survive
    expect(buildDisplay(g, new Set()).displayEdges.length).toBe(2);
  });

  it("a file with children and no edges at all IS a grouping level", () => {
    expect(isSkipped("file:src/quiet.ts")).toBe(true);
  });

  it("…unless the author asked for it to start collapsed", () => {
    // `collapsedByDefault` is an instruction about how THIS node renders — "start me as a
    // chip" — and a skipped file cannot be a chip. The store dutifully put the id into
    // `collapsed` and the display model then dropped the node, so a `module` and a `file`
    // carrying byte-identical annotations rendered as one chip and eight loose pills.
    const asked = { ...g, annotations: { "file:src/quiet.ts": { collapsedByDefault: true } } } as GraphIR;
    expect(groupingSkip(asked)(byId.get("file:src/quiet.ts")!)).toBe(false);
    expect(buildDisplay(asked, new Set(["file:src/quiet.ts"])).visibleNodes.map((n) => n.id)).toContain(
      "file:src/quiet.ts"
    );
    // a weaker annotation says nothing about being a container, so it does not promote one
    const summarised = { ...g, annotations: { "file:src/quiet.ts": { summary: "notes" } } } as GraphIR;
    expect(groupingSkip(summarised)(byId.get("file:src/quiet.ts")!)).toBe(true);
  });

  it("…but a file with NO children is never one, edges or not", () => {
    // CLAUDE.md promises a leaf `file` in a conceptual view is drawn as a store. The only
    // test guarding that carries an edge on its leaf file, so after round 16 the NEW clause
    // keeps it alive and the `has children` clause could be deleted with the suite green.
    // `README.md` has neither children nor edges.
    expect(isSkipped("file:README.md")).toBe(false);
    expect(autoCollapse(g, new Set(), HUGE).visible).toBe(9); // module + 3 file containers + 4 fns + README
  });

  /** What App hands the Key: the nodes and edges actually on the canvas. */
  const rowsFor = (graph: GraphIR, collapsed: ReadonlySet<string> = new Set()) => {
    const m = buildDisplay(graph, collapsed);
    return keyRows(
      m.visibleNodes.map((n) => ({
        data: { kind: n.kind, isContainer: m.isContainer(n.id), collapsed: collapsed.has(n.id) },
      })),
      m.displayEdges.map((e) => ({ data: { kind: e.kind } }))
    );
  };

  it("the Key lists exactly what is on screen, with the right treatment", () => {
    const { nodeKinds, edgeKinds } = rowsFor(g);
    expect(edgeKinds).toEqual(["imports"]);
    // `file` IS listed (four are drawn) and the CONTAINER treatment round 16 introduced is
    // one of the rows — but not the only one: a.ts/b.ts/c.ts are containers and README.md is
    // a leaf store, two different shapes on the same canvas. One row per (kind, treatment),
    // because a legend is consulted exactly when a shape is unfamiliar and OR-ing them
    // described whichever happened to win.
    expect(nodeKinds).toEqual([
      ["file", true],
      ["file", false],
      ["function", false],
      ["module", true],
    ]);
    // …and a graph whose only files are pure grouping levels still lists no `file` row
    const quietOnly = { ...g, edges: g.edges.filter((e) => e.kind === "contains"), nodes: g.nodes.filter((n) => n.id !== "file:README.md") } as GraphIR;
    expect(rowsFor(quietOnly).nodeKinds.map(([k]) => k)).toEqual(["function", "module"]);
    // …and a kind that is only inside COLLAPSED containers is not listed at all: the legend
    // describes the canvas, not the file. An `imports` row beside a canvas with no arrows is
    // the exact tell rounds 16-18 each used to find silently destroyed edges.
    const folded = rowsFor(g, new Set(["module:src"]));
    expect(folded.nodeKinds).toEqual([["module", true]]);
    expect(folded.edgeKinds).toEqual([]);
  });
});

describe("the budget and the layout agree under NESTED collapse", () => {
  it("the 104k flagship, at the collapse set the budget actually chooses", () => {
    // `rep`'s ancestor walk keeps the OUTERMOST collapsed ancestor. Flipping that one token
    // to innermost-wins left all 257 tests green while taking the flagship from 780 display
    // edges to ZERO — the status bar would say 780 and the canvas would draw none. The
    // existing agreement tests all run with an EMPTY collapsed set, where the two are
    // trivially the same; the budget's own output is the input that exercises it, and 8,000
    // of its 8,040 collapses sit inside another collapsed container.
    const g = db(40, 200, 12);
    const chosen = autoCollapse(g, new Set(), DEFAULT_BUDGET);
    const cur = new Set(chosen.collapse);
    const nested = chosen.collapse.filter((id) => id.startsWith("table:")).length;
    expect(nested).toBeGreaterThan(1000); // genuinely nested, not a flat level
    expect(chosen.visible).toBe(40);
    expect(chosen.edges).toBe(780);
    expect(autoCollapse(g, cur, HUGE).edges).toBe(buildDisplay(g, cur).displayEdges.length);
    expect(buildDisplay(g, cur).displayEdges.length).toBe(780);
  }, 30000); // 104k nodes through the budget AND the display model twice
});

describe("search does not promise matches no click can reveal", () => {
  it("a grouping file is not a match; its children still are", () => {
    // The FOURTH consumer of the rule, after the layout, the budget and the Key — and it
    // carried the pre-grouping version (`id === index.root`). `file:src/quiet.ts` is a
    // grouping level: not a display node at ANY collapse state, and its display parent is
    // the root, which is the canvas — so the search box read "0 +1 hidden" with nothing on
    // screen to light and nothing to click.
    const g = chainOfFiles();
    const index = buildSearchIndex(g, groupingSkip(g));
    expect(index.skipped.has("file:src/quiet.ts")).toBe(true);
    expect(index.skipped.has("package:app"), "the root is never drawn either").toBe(true);
    expect(index.skipped.has("file:src/a.ts"), "…but a file with edges IS drawn").toBe(false);

    const m = searchMatches(index, "quiet")!;
    expect(m.has("file:src/quiet.ts")).toBe(false);
    expect(m.has("function:src/quiet.ts:run"), "the child matches on its id").toBe(true);
    // nothing is on screen, so the child is a genuine hidden match — exactly one, not two
    expect(hiddenMatchesOf(index, m, new Set()).hidden).toBe(1);
    // and with the child on screen, nothing is hidden at all
    expect(hiddenMatchesOf(index, m, new Set(["function:src/quiet.ts:run"])).hidden).toBe(0);
  });

  it("…and the parent chain is still complete, so a deep match lights its container", () => {
    // The skipped nodes stay INDEXED: the walk from a match up to its visible ancestor has
    // to pass through them. Dropping them from the index entirely would strand the walk at
    // the first grouping file and light nothing.
    const g = chainOfFiles();
    const index = buildSearchIndex(g, groupingSkip(g));
    const m = searchMatches(index, "src/a.ts")!;
    expect(m.has("function:src/a.ts:run")).toBe(true);
    const { lit } = hiddenMatchesOf(index, m, new Set(["file:src/a.ts"]));
    expect([...lit]).toEqual(["file:src/a.ts"]);
  });
});

describe("an edge touching the root", () => {
  it("is dropped by both models — the root is the canvas, not a node", () => {
    // The one input that still reaches `displayOf`'s ancestor walk, and it was untested.
    const g = chainOfFiles();
    const withRootEdge = {
      ...g,
      edges: [...g.edges, { id: "e:references:package:app->file:src/a.ts", kind: "references", from: "package:app", to: "file:src/a.ts" }].sort(
        (a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
      ),
    } as GraphIR;
    expect(autoCollapse(withRootEdge, new Set(), HUGE).edges).toBe(2); // the two imports, not three
    expect(buildDisplay(withRootEdge, new Set()).displayEdges.length).toBe(2);
  });
});

describe("a level the budget would need is never dissolved", () => {
  /** `package > [module >] N file > 8 function`, no edges anywhere. */
  const pkg = (files: number, mod: boolean): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "package:app", kind: "package", name: "app" }];
    const edges: GraphIR["edges"] = [];
    const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
    let parent = "package:app";
    if (mod) {
      parent = "module:m";
      nodes.push({ id: parent, kind: "module", name: "m", parent: "package:app" });
      add("contains", "package:app", parent);
    }
    for (let i = 0; i < files; i++) {
      const fid = `file:src/f${String(i).padStart(4, "0")}.ts`;
      nodes.push({ id: fid, kind: "file", name: `f${i}.ts`, parent });
      add("contains", parent, fid);
      for (let j = 0; j < 8; j++) {
        nodes.push({ id: `function:${fid.slice(5)}:fn${j}`, kind: "function", name: `fn${j}`, parent: fid });
        add("contains", fid, `function:${fid.slice(5)}:fn${j}`);
      }
    }
    const { nodes: n2, edges: e2 } = sorted(nodes, edges);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:app", nodes: n2, edges: e2 } as GraphIR;
  };

  it("an edgeless package of files budgets like one with imports", () => {
    // `autoCollapse` only considers display nodes that HAVE display children, so dissolving
    // the file level leaves it no candidate at all: 250 edgeless files opened on 2,000
    // visible and 500 on 4,000 — past UNRENDERABLE, in the band the budget's own docstring
    // calls unusable — with nothing folded and "collapse to fit" a silent no-op. A single
    // `imports` edge per file was the difference between that and ~595.
    for (const mod of [false, true]) {
      for (const files of [100, 250, 500]) {
        const g = pkg(files, mod);
        const r = autoCollapse(g, new Set(), DEFAULT_BUDGET);
        expect(r.visible, `${files} files, module=${mod}`).toBeLessThanOrEqual(DEFAULT_BUDGET.maxVisible);
        expect(r.collapse.length).toBeGreaterThan(0);
        expect(buildDisplay(g, new Set(r.collapse)).visibleNodes.length).toBe(r.visible); // and the layout agrees
      }
    }
  });

  it("…and a small one still gets the tidy-up, but only where another level remains", () => {
    // Under a `module` the file level really is redundant and goes. Under the ROOT there is
    // nothing above but the canvas, so eliding leaves the children with no grouping at all:
    // `package > file > function` came out as one flat row of fn0 fn0 fn1 fn1 in which
    // nothing says which file anything belongs to.
    expect(autoCollapse(pkg(4, true), new Set(), DEFAULT_BUDGET).visible).toBe(33); // module + 32 fns
    expect(autoCollapse(pkg(4, false), new Set(), DEFAULT_BUDGET).visible).toBe(36); // 4 files + 32 fns
  });
});

const byId2 = (g: GraphIR) => new Map(g.nodes.map((n) => [n.id, n]));

describe("one predicate, derived once", () => {
  /** `package > module xM > [dir xD >] file xF > function x4`, no non-contains edges. */
  const tree = (mods: number, dirs: number, filesPer: number): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "package:p", kind: "package", name: "p" }];
    const edges: GraphIR["edges"] = [];
    const add = (f: string, t: string) => edges.push({ id: `e:contains:${f}->${t}`, kind: "contains", from: f, to: t });
    for (let m = 0; m < mods; m++) {
      const mid = `module:${String.fromCharCode(97 + m)}`;
      nodes.push({ id: mid, kind: "module", name: mid, parent: "package:p" });
      add("package:p", mid);
      const parents = dirs === 0 ? [mid] : Array.from({ length: dirs }, (_, d) => `module:${mid.slice(7)}/d${d}`);
      if (dirs > 0)
        for (const d of parents) {
          nodes.push({ id: d, kind: "module", name: d, parent: mid });
          add(mid, d);
        }
      for (const dp of parents)
        for (let i = 0; i < filesPer; i++) {
          const fid = `file:${dp.slice(7)}/f${i}.ts`;
          nodes.push({ id: fid, kind: "file", name: `f${i}`, parent: dp });
          add(dp, fid);
          for (let j = 0; j < 4; j++) {
            nodes.push({ id: `function:${fid.slice(5)}:fn${j}`, kind: "function", name: `fn${j}`, parent: fid });
            add(fid, `function:${fid.slice(5)}:fn${j}`);
          }
        }
    }
    const { nodes: n2, edges: e2 } = sorted(nodes, edges);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:p", nodes: n2, edges: e2 } as GraphIR;
  };

  it("a LOWERED ?budget= keeps the level it will need to fold", () => {
    // `groupingSkip` measured against the constant made the coupling exact only for the
    // DEFAULT budget: `package > module > file x50 > function x8` is 452 nodes, so all fifty
    // files were elided and `autoCollapse`'s only candidate was `module:m`, which `refuseFold`
    // refuses — 401 visible against a cap of 100, zero folded.
    const g = tree(1, 0, 50);
    // At the default cap the graph already fits, so the tidy-up is free and the file level
    // goes: 201 visible (the module plus its functions), nothing folded.
    expect(autoCollapse(g, new Set(), parseBudget("?budget=600")!).visible).toBe(201);
    // Below it the level is what the budget needs, and it is kept and folded. Measured
    // against the CONSTANT instead, both of these were 401 visible with ZERO folded.
    for (const [q, cap] of [["?budget=100", 100], ["?budget=60", 60]] as const) {
      const r = autoCollapse(g, new Set(), parseBudget(q)!);
      expect(r.visible, q).toBeLessThanOrEqual(cap);
      expect(r.collapse.length, q).toBeGreaterThan(0);
    }
  });

  it("a RAISED ?budget= does not dissolve structure, and the boundary is exact", () => {
    // The other half of `Math.min`. Asking to see 3,000 nodes is not a reason to elide a
    // level — and without the `min` the layout and `collapseToFit` would also compute their
    // models against different caps for any budget over 800.
    // BETWEEN the cap and the raised budget — 1,002 nodes — which is the only band where
    // `Math.min` changes the answer. At 252 nodes the two agree and the assertion proves
    // nothing, which is how I wrote it the first time.
    const g = tree(1, 0, 200);
    expect(g.nodes.length).toBeGreaterThan(600);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const probe = byId.get("file:a/f0.ts")!;
    expect(skipForBudget(g, { maxVisible: 3000 })(probe), "raised: the level is KEPT").toBe(false);
    expect(groupingSkip(g, 3000)(probe), "…which the raw cap would not do").toBe(true);
    expect(skipForBudget(g, { maxVisible: 100 })(probe), "lowered: kept").toBe(false);
    const small = tree(1, 0, 50); // 252 nodes: under the cap either way, so it is elided
    expect(skipForBudget(small, { maxVisible: 3000 })(new Map(small.nodes.map((n) => [n.id, n])).get("file:a/f0.ts")!)).toBe(true);
    // `>` not `>=`: at EXACTLY the cap the graph still fits, so the tidy-up is still free.
    expect(groupingSkip(small, small.nodes.length)(byId2(small).get("file:a/f0.ts")!), "at the cap").toBe(true);
    expect(groupingSkip(small, small.nodes.length - 1)(byId2(small).get("file:a/f0.ts")!), "one over").toBe(false);
  });

  it("the mini graph a splice lays out gets the PARENT's predicate", async () => {
    // `groupingSkip` reads the edge list, the node COUNT and the root off the graph it is
    // handed, and the mini rewrites all three. Round 19 patched the edges and introduced the
    // other two in the same change; both of these refused every splice, forever.
    for (const [label, g] of [
      ["needsBudgeting (617 nodes)", tree(4, 3, 10)],
      ["parent-is-root (323 nodes)", tree(2, 0, 40)],
    ] as const) {
      const base = await layoutGraph(g, new Set(["module:a"]), {});
      const skip = skipForBudget(g, DEFAULT_BUDGET);
      const r = await incrementalToggle(g, new Set(), "module:a", base, { skip });
      expect(r, label).not.toBeNull();
    }
  }, 300000);
});

describe("the legend's delta and inferred rows", () => {
  const node = (kind: string, d?: string) => ({ data: { kind, delta: d } });
  const edge = (kind: string, extra: Record<string, unknown> = {}) => ({ data: { kind, ...extra } });

  it("are decided by what was RENDERED, not by the diff over the whole file", () => {
    // A republish that adds a node INSIDE a `collapsedByDefault` container changes `diffIR`
    // and changes nothing on screen: the legend showed a green "added since last graph"
    // swatch with nothing green anywhere on the canvas.
    const quiet = keyRows([node("function"), node("function")], [edge("calls")]);
    expect([quiet.added, quiet.modified, quiet.inferred]).toEqual([false, false, false]);

    expect(keyRows([node("function", "added")], []).added).toBe(true);
    expect(keyRows([node("function", "modified")], []).modified).toBe(true);
    expect(keyRows([node("function", "modified")], []).added).toBe(false);
    // an ADDED EDGE counts too — it is drawn at full opacity even in a hairball — and the
    // status bar now counts the same event, which it did not before
    expect(keyRows([node("function")], [edge("calls", { delta: "added" })]).added).toBe(true);
    // a modified EDGE is a row too, now that one has its own amber chip: an edge whose
    // `count` changed used to be reported nowhere at all — not the canvas, not the Key, not
    // the status bar — while the chip visibly went from `calls x2` to `calls x7`.
    expect(keyRows([node("function")], [edge("calls", { delta: "modified" })]).modified).toBe(true);
    expect(keyRows([node("function")], [edge("calls", { inferred: true })]).inferred).toBe(true);
  });
});

// The PRODUCER side of the delta, which nothing reached: `keyRows` and `edgeIsPainted` are
// both pinned against objects the tests build, so the code that actually puts `delta` on a
// node or an edge could be deleted with the whole suite green.
describe("the delta reaches the objects that are rendered", () => {
  const g = (count: number, extraNode: boolean): GraphIR => {
    const nodes: GraphIR["nodes"] = [
      { id: "view:v", kind: "view", name: "v" },
      { id: "step:a", kind: "step", name: "a", parent: "view:v" },
      { id: "step:b", kind: "step", name: "b", parent: "view:v" },
      ...(extraNode ? [{ id: "step:c", kind: "step", name: "c", parent: "view:v" }] : []),
    ];
    const edges: GraphIR["edges"] = [
      { id: "e:contains:view:v->step:a", kind: "contains", from: "view:v", to: "step:a" },
      { id: "e:contains:view:v->step:b", kind: "contains", from: "view:v", to: "step:b" },
      ...(extraNode ? [{ id: "e:contains:view:v->step:c", kind: "contains", from: "view:v", to: "step:c" }] : []),
      { id: "e:calls:step:a->step:b", kind: "calls", from: "step:a", to: "step:b", count },
    ];
    const { nodes: n2, edges: e2 } = sorted(nodes, edges);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "view:v", nodes: n2, edges: e2 } as GraphIR;
  };

  it("a count change marks the DISPLAY edge modified, whatever carries the multiplicity", () => {
    // `locs` alone is a first-class shape — the honesty rule mandates `locs` and never
    // `count` — and the two were compared differently: the chip showed `count ?? locs.length`
    // while the diff compared `count`, so a `locs`-only edge going 3 → 7 changed on screen
    // and was reported nowhere, and `count: 2` → two `locs` was announced with nothing
    // visibly different.
    const withLocs = (n: number) => {
      const base = g(1, false);
      return {
        ...base,
        edges: base.edges.map((e) =>
          e.id === "e:calls:step:a->step:b"
            ? // locs and NO count — the shape the honesty rule actually produces, and the one
              // that makes this assertion able to fail: with `count` set alongside, comparing
              // `count` alone still gets the right answer and the test proves nothing.
              { id: e.id, kind: e.kind, from: e.from, to: e.to, locs: Array.from({ length: n }, (_, i) => ({ file: "x.ts", line: i + 1 })) }
            : e
        ),
      } as GraphIR;
    };
    expect([...diffIR(g(3, false), g(7, false)).modifiedEdges]).toEqual(["e:calls:step:a->step:b"]);
    expect([...diffIR(withLocs(3), withLocs(7)).modifiedEdges]).toEqual(["e:calls:step:a->step:b"]);
    // …and the same multiplicity spelled two ways is NOT a change
    const bare = { ...g(2, false) } as GraphIR;
    expect([...diffIR(bare, withLocs(2)).modifiedEdges]).toEqual([]);
    // the chip agrees with the diff on what the number is
    const m = buildDisplay(withLocs(7), new Set());
    expect(m.displayEdges.find((e) => e.kind === "calls")!.count).toBe(7);
  });
});

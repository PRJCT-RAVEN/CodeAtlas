// Which IR nodes are NOT display nodes — the ONE definition, shared by the layout engine
// (`layout/elk.ts`) and the visibility budget (`ir/budget.ts`).
//
// It lived as two byte-identical copies, which is how the rule below came to be wrong in
// both at once. It sits in `ir/` because `ir/` must never import from `../layout` (see
// `density.ts`, extracted for the same reason).

import type { GraphIR, IRNode } from "./types";

/**
 * Display nodes a view is expected to hold — `DEFAULT_BUDGET.maxVisible` is THIS number, not
 * a second copy of it (the same arrangement `budget.ts` already has with `FASTEST_EDGES`).
 * It lives here because `groupingSkip` needs it and `ir/grouping.ts` is the leaf: importing
 * the budget from here would make the two modules circular.
 */
export const VIEW_NODE_CAP = 600;

/**
 * The predicate for a graph shown under `budget` — the ONE place the cap is derived, so the
 * visibility budget and the layout can never answer differently.
 *
 * `Math.min`, because a LOWERED `?budget=` still has to keep the level: a 452-node
 * `package > module > file x50 > function x8` elides all fifty files, leaving `autoCollapse`
 * a single candidate that `refuseFold` refuses — 401 visible against a cap of 100 with ZERO
 * folded. Measuring against the constant alone made the coupling exact only for the default
 * budget. A RAISED one keeps the constant: asking to see 3,000 nodes is not a reason to
 * dissolve structure.
 */
export function skipForBudget(ir: GraphIR, budget: { maxVisible: number }): (n: IRNode) => boolean {
  return groupingSkip(ir, Math.min(VIEW_NODE_CAP, budget.maxVisible));
}

/**
 * The root (it IS the canvas) and a `file` that exists only to group its children.
 *
 * …but a file that CARRIES an edge is not merely a grouping level, and that exemption is
 * the whole reason this is a function rather than a one-liner. `imports` naturally join
 * FILES — CLAUDE.md's own structural vocabulary says so — and without the exemption every
 * one of those edges was destroyed, silently, on the shape the manual prescribes:
 *
 *   package > file > function, `imports` between the files
 *
 * rendered as twelve unlabelled `fn0`/`fn1`/`fn2` pills in a grid with no arrows at all,
 * while the Key still showed an `imports` row. Both endpoints resolved to the nearest
 * un-skipped ancestor — the root, so the edge was dropped outright; with a `module` level
 * they resolved to the SAME module and were dropped as self-loops instead. Round 11 made
 * the budget and the layout agree on this number, which they did: both counted zero. Its
 * fixture put the files in 30 different modules, the one arrangement where re-routing
 * lands somewhere real.
 *
 * Losing an authored, loc-carrying edge with no trace in the Key, the status bar or the
 * details panel is the honesty contract failing in the quiet direction. A file with edges
 * is drawn as a container instead, which is where those edges were always meant to land.
 */
export function groupingSkip(ir: GraphIR, cap: number = VIEW_NODE_CAP): (n: IRNode) => boolean {
  const childCount = new Map<string, number>();
  for (const n of ir.nodes) if (n.parent) childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1);
  const endpoint = new Set<string>();
  for (const e of ir.edges) {
    if (e.kind === "contains") continue; // hierarchy, not a relation the file takes part in
    endpoint.add(e.from);
    endpoint.add(e.to);
  }
  const ann = ir.annotations ?? {};
  // Eliding is a tidy-up: it removes a nesting level that says nothing the level above does
  // not already say. Past the point where the view needs BUDGETING it stops being free,
  // because `autoCollapse` only considers display nodes with display children — dissolve the
  // file level and there is no candidate left at all. Measured on `package > N file > 8
  // function` with no edges: 250 files opened on 2,000 visible and 500 files on 4,000, past
  // `UNRENDERABLE`, with ZERO folded and "collapse to fit" a no-op, while the same graphs
  // with one `imports` per file (which exempts them below) opened on ~595. One edge must not
  // be the difference between a view that can be budgeted and one that cannot.
  const needsBudgeting = ir.nodes.length > cap;
  /**
   * …and the same argument for `collapsedByDefault`, which is an instruction about how this
   * very node renders: "start me as a chip". A skipped file cannot be a chip, so the store
   * put the id into `collapsed`, the display model dropped the node, and the annotation did
   * nothing at all — a `module` and a `file` with byte-identical annotations rendered as one
   * chip and eight loose pills. Narrow on purpose: `summary`, `importance` and `label` say
   * nothing about whether the node is a container, so they do not promote one.
   */
  const asked = (id: string) => ann[id]?.collapsedByDefault === true;
  return (n) =>
    n.id === ir.root ||
    (n.kind === "file" &&
      (childCount.get(n.id) ?? 0) > 0 &&
      !endpoint.has(n.id) &&
      !asked(n.id) &&
      !needsBudgeting &&
      // …and never the ONLY grouping level. A file whose parent is the root has the canvas
      // above it, so eliding it leaves its children with no grouping at all: `package >
      // file > function` came out as one flat row of `fn0 fn0 fn1 fn1 fn2 fn2` in which
      // nothing says which file anything belongs to. Where a `module` sits above (the shape
      // `sample-graph.json` uses, and the one this rule was written for) the level really is
      // redundant and still goes.
      n.parent !== undefined &&
      n.parent !== ir.root);
}

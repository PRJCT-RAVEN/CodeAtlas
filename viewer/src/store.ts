import { create } from "zustand";
import type { GraphIR } from "./ir/types";
import { diffIR, EMPTY_DELTA, type Delta } from "./ir/delta";
import { autoCollapse, DEFAULT_BUDGET, RENDER_WARN, type BudgetOptions } from "./ir/budget";

export interface BudgetInfo {
  /** Containers currently collapsed by the budget (not by the author or the user). */
  autoCollapsed: number;
  total: number;
  visible: number;
  edges: number;
}

export interface SourceStatus {
  /** Which URL the current graph came from (live/graph.json, sample-graph.json, …). */
  source: string | null;
  /** Last poll problem, if any — the graph on screen is the last GOOD one. */
  error: string | null;
  /** When the current graph was accepted. */
  at: number;
}

interface AtlasState {
  ir: GraphIR | null;
  /** The graph before `ir` (same view) — drives delta highlighting. */
  delta: Delta;
  collapsed: Set<string>;
  selected: string | null;
  status: SourceStatus;
  budget: BudgetOptions;
  budgetInfo: BudgetInfo | null;
  /** The container the user toggled last (null after a new graph) — lets the layout be incremental. */
  lastToggle: string | null;
  setBudget: (b: BudgetOptions) => void;
  setIR: (ir: GraphIR, source: string) => void;
  setPollError: (error: string | null) => void;
  toggleCollapse: (id: string) => void;
  /**
   * Re-apply the visibility budget to the CURRENT view (an explicit user request).
   * Returns false — and changes nothing at all — when there is no container left to fold,
   * which happens when the only level is flat under the root.
   */
  collapseToFit: () => boolean;
  /**
   * The selected node and everything under it — which edges count as "touching" it.
   *
   * A dense view says "select a node to trace them", but clicking a node also EXPANDS it
   * when it is a container, and an expanded container is no longer an edge endpoint: its
   * children are. Matching on the selected id alone therefore lit nothing at all in
   * exactly the views the affordance exists for — click a bucket in a 10,000-table
   * overview and its 200 foreign keys vanished instead of lighting up. Matching the
   * SUBTREE means selecting a schema traces every edge leaving that schema, whatever
   * level it is drawn at.
   */
  litIds: ReadonlySet<string>;
  select: (id: string | null) => void;
}

const NO_IDS: ReadonlySet<string> = new Set<string>();

/**
 * IR children by parent, cached per graph — a selection must not re-scan 90k nodes.
 *
 * `forgetChildIndex` is called from `setIR`: this is a module-level STRONG reference, and
 * `subtreeIds` returns early without touching it when nothing is selected — which is
 * exactly what happens when a new graph drops the old selection. The cache would then keep
 * a whole parsed 43 MB graph alive until the user next clicked something.
 */
let childIndexFor: GraphIR | null = null;
let childIndex = new Map<string, string[]>();
/**
 * Which graph the child index is currently holding, or null — the only way to observe a
 * RETENTION bug, which has no other behavioural symptom (the cache is correct either way;
 * it just keeps 43 MB alive). Exported for the test that pins `forgetChildIndex`.
 */
export function childIndexHeldFor(): GraphIR | null {
  return childIndexFor;
}
function forgetChildIndex(ir: GraphIR) {
  if (childIndexFor === null || childIndexFor === ir) return;
  childIndexFor = null;
  childIndex = new Map();
}
function childrenOf(ir: GraphIR): Map<string, string[]> {
  if (childIndexFor === ir) return childIndex;
  const m = new Map<string, string[]>();
  for (const n of ir.nodes) {
    if (n.parent === undefined) continue;
    const arr = m.get(n.parent);
    if (arr) arr.push(n.id);
    else m.set(n.parent, [n.id]);
  }
  childIndexFor = ir;
  childIndex = m;
  return m;
}

/**
 * Does this edge CROSS the boundary of the current selection? The one rule the canvas, the
 * status-bar count and the details panel all key off, so the three cannot disagree.
 *
 * "Touches the selection" (either end in `lit`) was wrong in the direction that matters:
 * `lit` is the selected node plus its whole subtree, so selecting a TOP-LEVEL container
 * made every edge in the graph touch it — two clicks turned the hairball guard off, drew
 * 5,397 edges, and took a pan from 133 ms to 1,394 ms, while the panel (which already used
 * the crossing rule) showed nothing at all. Crossing is also what the user means: selecting
 * a schema asks "what does this schema talk to", not "draw its insides".
 *
 * A self-loop has both ends inside by definition and is not an internal edge but recursion
 * — `layout/elk.ts` only ever keeps one that was AUTHORED on a visible node.
 */
export function crossesSelection(lit: ReadonlySet<string>, source: string, target: string): boolean {
  const from = lit.has(source);
  return source === target ? from : from !== lit.has(target);
}

/**
 * Is this edge drawn at full strength? The ONE rule the canvas and the status-bar count
 * share, so "N of M edges hidden" can never disagree with what is on screen.
 *
 * They were two copies of the same expression — the exact shape that has gone wrong
 * repeatedly here — and neither had a test: mutating either one left the whole suite green.
 */
export function edgeIsLit(
  lit: ReadonlySet<string>,
  source: string,
  target: string,
  opts: { faint?: boolean; delta?: string }
): boolean {
  if (!opts.faint) return true; // not a dense view: everything is drawn
  // A CHANGED edge is always lit — added or modified, it is the thing a delta view exists to
  // show, and rare by definition. `added` alone was not enough: the Key and the status bar
  // announce a modified edge, and in a dense or hairball view the canvas drew nothing, so an
  // amber swatch appeared in the legend with nothing amber anywhere on screen.
  return opts.delta !== undefined || crossesSelection(lit, source, target);
}

/**
 * Does this edge put any SVG on the canvas?
 *
 * The other half of `edgeIsLit`, and the one the status bar counts: in a HAIRBALL view an
 * unlit edge renders nothing at all (`ElkEdge` returns null), because every drawn edge is
 * two SVG paths and the faint cloud cost 2.6 s per pan at 9,388 of them. Those were two
 * separate expressions — the canvas keyed off the edge's own `data.hairball`, the status
 * bar off `layoutMode.hairball` — so "N of M edges hidden" and what is actually missing
 * from the canvas could disagree whenever the two sources diverged. One rule, both callers.
 */
export function edgeIsPainted(
  litIds: ReadonlySet<string>,
  source: string,
  target: string,
  /**
   * The edge's OWN data, not flags picked out of it: both callers pass `e.data` straight
   * through, so neither can forget one. The status-bar count used to map `delta === "added"`
   * by hand at its call site, which is a thing to leave out — and leaving it out makes the
   * bar count a delta edge as hidden while `ElkEdge` paints it, the precise disagreement
   * this function exists to make impossible.
   */
  d: { delta?: string; hairball?: boolean } | undefined
): boolean {
  // `crossesSelection` directly rather than `edgeIsLit`, which short-circuits on `!faint`:
  // a hairball is by construction also dense (see `isHairball`), so on every input the
  // renderer can actually produce the two agree — and this way that agreement does not
  // depend on a caller remembering to pass `faint` alongside `hairball`.
  return !d?.hairball || d.delta !== undefined || crossesSelection(litIds, source, target);
}

/** `id` plus every descendant of it. Iterative: a deep chain must not blow the stack. */
export function subtreeIds(ir: GraphIR | null, id: string | null): ReadonlySet<string> {
  if (!ir || id === null) return NO_IDS;
  const kids = childrenOf(ir);
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const cs = kids.get(cur);
    if (!cs) continue;
    for (const c of cs) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

// Ids we have already applied `collapsedByDefault` to. A refresh of the same
// view must not re-collapse a container the user opened, but a container that
// first appears in this graph should honour the author's default.
const defaulted = new Set<string>();
/** Ids the visibility budget collapsed (subset of `defaulted`). */
const autoChosen = new Set<string>();
/**
 * Ids the USER collapsed by clicking "collapse to fit" (also a subset of `defaulted`).
 *
 * Kept apart from `autoChosen` because the release below treats that set as stale budget
 * state and drops it: lumping the two together undid an explicit fit on the next
 * republish, putting the render warning straight back.
 *
 * Only the ids the BUTTON chose land here — the budget's own collapses that were already
 * in place when it was clicked are still released as stale state, so a republish can drift
 * a little (a 1,606-node tree fitted to 3 comes back at 6). The invariant this set exists
 * for holds: measured across every shape where the button is reachable, a republish never
 * returns above `RENDER_WARN`.
 */
const userFitted = new Set<string>();
/**
 * Containers the user collapsed by clicking them.
 *
 * Without this, a container the budget once chose stays in `autoChosen` for as long as it
 * exists, so a LATER deliberate collapse of that same container was indistinguishable from
 * stale budget state and the release silently expanded it again. (The reverse — a user
 * EXPANDING a budget-chosen container — is already safe: the id leaves `collapsed`, so it
 * is not in `carried`, and `defaulted` keeps the budget from re-choosing it.)
 */
const userCollapsed = new Set<string>();
const NONE_LEVELS: ReadonlySet<number> = new Set();
/** Display depths the budget collapsed for this root — newcomers at those depths are collapsed too. */
const autoLevels = new Set<number>();
let defaultedRoot: string | null = null;

/**
 * Containers collapsed because the BUDGET chose them, or because "collapse to fit" did.
 *
 * One count over the UNION: the two sets overlap (a container the budget chose, the user
 * expanded, and the fit then re-collapsed is in both), and counting them separately read
 * 1,504 auto-collapsed for 1,202 containers. One definition, because it had three call
 * sites and two of them could be reduced to `autoChosen` alone with the whole suite green —
 * every test named for this picks its container out of `collapsed` immediately after
 * `setIR`, where `userFitted` is always a subset of `autoChosen`, so none of them could fail
 * for the clause it was named after.
 */
function autoCollapsedCount(collapsed: ReadonlySet<string>): number {
  let n = 0;
  for (const id of new Set([...autoChosen, ...userFitted])) if (collapsed.has(id)) n++;
  return n;
}

function applyDefaults(ir: GraphIR, collapsed: Set<string>, budget: BudgetOptions, ids: ReadonlySet<string>, hasKids: ReadonlySet<string>): { collapsed: Set<string>; info: BudgetInfo } {
  // a different view root starts from scratch (and keeps the sets bounded)
  if (defaultedRoot !== ir.root) {
    defaulted.clear();
    autoChosen.clear();
    userFitted.clear();
    userCollapsed.clear();
    autoLevels.clear();
    defaultedRoot = ir.root;
  }
  // a container that left the graph and comes back — or that became a leaf and grew
  // children again — is new again: it must get its default/budget treatment instead
  // of rendering expanded among chips
  const stale = (id: string) => !ids.has(id) || !hasKids.has(id);
  for (const id of [...defaulted]) if (stale(id)) defaulted.delete(id);
  for (const id of [...autoChosen]) if (stale(id)) autoChosen.delete(id);
  for (const id of [...userFitted]) if (stale(id)) userFitted.delete(id);
  for (const id of [...userCollapsed]) if (stale(id)) userCollapsed.delete(id);
  const next = new Set(collapsed);
  // There used to be a second release here, for "a graph that cannot exceed the budget needs
  // none of the LAST one's decisions": a `fits` test on `ir.nodes.length`/`ir.edges.length`,
  // its own three exemptions and its own `lastFitted` edge-trigger. It was DEAD, and the
  // `carried` release below is what actually produces that behaviour — which two rounds of
  // bug-fixing in the dead copy (the user's re-collapse, then the user's expand) did not
  // reveal, because both were also fixed in the live one.
  //
  // Why it could never decide anything: `fits` requires every IR node and edge to be inside
  // the budget, and display nodes ≤ IR nodes while display edges ≤ non-`contains` IR edges —
  // so when it held, both of `autoCollapse`'s guards were already false and no phase could
  // fold. Only the `uniformLevels` pre-pass could, and the re-derived pass below runs with no
  // levels AND the carried ids released, so it folds strictly less, shows strictly more, wins
  // the comparison, and performs the same deletions. Confirmed by replaying the store over
  // ten sequences — big>small>big, an expand or a "collapse to fit" or a deliberate collapse
  // in between, `collapsedByDefault` arriving and leaving, `bucketed`/`nested`/`lumpy` —
  // byte-identical with the block and with `fits = false`. Its edge test was also at the
  // wrong granularity (`ir.edges.length` counts `contains`; `maxEdges` is a DISPLAY budget),
  // which stayed invisible for exactly the same reason.
  const ann = ir.annotations ?? {};
  /**
   * One complete pass: release the given carried ids, apply the author's defaults, budget.
   *
   * The author-default step has to run INSIDE this, after the release. It is guarded by
   * `!defaulted.has(id)` ("we have already dealt with this container"), and a container
   * carried over from the previous view is in `defaulted` — so a `collapsedByDefault`
   * that arrives on the same poll as the release was skipped here and then deleted by the
   * release, and only took effect one poll later.
   */
  const runPass = (release: ReadonlySet<string>, levels: ReadonlySet<number>) => {
    const n = new Set(next);
    const d = new Set(defaulted);
    for (const id of release) {
      n.delete(id);
      d.delete(id);
    }
    for (const [id, a] of Object.entries(ann)) {
      // `hasKids` and not just `ids`: an author default on a node that has no children
      // seeds `collapsed` with an id that renders as a "+" chip advertising children it
      // does not have. Without this the chip came BACK one poll after the user clicked it
      // away, because pruning that id out of `defaulted` is exactly what lets this loop
      // re-add it. A node that later grows children gets its default then, as intended.
      if (a?.collapsedByDefault === true && hasKids.has(id) && !d.has(id)) {
        n.add(id);
        d.add(id);
      }
    }
    // Visibility budget (ir/budget.ts): containers the author or the user have
    // already decided about are never revisited, so an expand sticks across polls.
    return { n, d, r: autoCollapse(ir, n, budget, d, levels) };
  };

  const NONE: ReadonlySet<string> = new Set();
  let pass = runPass(NONE, autoLevels);
  // The budget state carried from the previous graph is worth keeping only if it does not
  // hide MORE than a pass derived for THIS graph would. CLAUDE.md tells authors to keep
  // the root id stable across refinements, so "publish a smaller view under the same root"
  // is the normal path — and along it a collapse from the bigger view survives `pruned`
  // (the container still exists and still has children), the `fits` release above only
  // fires when the new graph could never need budgeting at all, and `autoCollapse` then
  // folds nothing because what it is handed is already tiny. An 841-node refinement after
  // a 10,803-node view rendered as ONE chip where the same graph on its own shows 595.
  //
  // This was twice "fixed" by testing `r.visible` against a floor, and twice the test used
  // the single follow-up shape that lands on exactly one node: the carried state actually
  // lands on whatever the PREVIOUS view's shape leaves — 2 chips, 3, 18 — all equally
  // wrong. Comparing against a re-derived pass is shape-independent, and `autoLevels`
  // (which gutted a follow-up all by itself, with zero id overlap) is covered too.
  //
  // What is dropped is BUDGET state only. The author's `collapsedByDefault`, the user's own
  // collapses, and the containers the user has since EXPANDED (in `autoChosen` but no
  // longer in `next`, and still excluded via `defaulted`) are all left alone — as is
  // `userFitted`, which is an explicit request, not a guess.
  const carried = new Set(
    [...autoChosen].filter((id) => next.has(id) && !userFitted.has(id) && !userCollapsed.has(id))
  );
  if (carried.size > 0 || autoLevels.size > 0) {
    const fresh = runPass(carried, NONE_LEVELS);
    if (fresh.r.visible > pass.r.visible) {
      for (const id of carried) autoChosen.delete(id);
      autoLevels.clear();
      pass = fresh;
    }
  }
  const { n: out, d: nowDefaulted, r } = pass;
  defaulted.clear();
  for (const id of nowDefaulted) defaulted.add(id);
  for (const id of r.collapse) {
    out.add(id);
    defaulted.add(id);
    autoChosen.add(id);
  }
  for (const d of r.levels) autoLevels.add(d);
  // ONE count over the union: the two sets overlap (a container the budget chose, the user
  // expanded, and "collapse to fit" then re-collapsed is in both), and two loops
  // double-counted it — the status bar read 1,504 auto-collapsed for 1,202 containers.
  return { collapsed: out, info: { autoCollapsed: autoCollapsedCount(out), total: r.total, visible: r.visible, edges: r.edges } };
}

export const useAtlas = create<AtlasState>((set) => ({
  ir: null,
  delta: EMPTY_DELTA,
  collapsed: new Set<string>(),
  selected: null,
  litIds: NO_IDS,
  status: { source: null, error: null, at: 0 },
  budget: DEFAULT_BUDGET,
  budgetInfo: null,
  lastToggle: null,
  setBudget: (budget) => set({ budget }),
  setIR: (ir, source) =>
    set((s) => {
      forgetChildIndex(ir); // never hold the PREVIOUS graph alive (see childIndexFor)
      const ids = new Set(ir.nodes.map((n) => n.id));
      // Prune state that points at nodes which no longer exist, AND at containers that
      // became leaves: both render as a "+" chip that advertises children it does not
      // have (and whose only recovery is a click that looks like an expand). Children
      // are counted from IR parents, not display ones, so a container holding nothing
      // but a hidden grouping `file` node still counts as a container.
      const hasKids = new Set<string>();
      for (const n of ir.nodes) if (n.parent !== undefined) hasKids.add(n.parent);
      const pruned = new Set([...s.collapsed].filter((id) => ids.has(id) && hasKids.has(id)));
      const { collapsed, info } = applyDefaults(ir, pruned, s.budget, ids, hasKids);
      return {
        ir,
        delta: diffIR(s.ir, ir),
        collapsed,
        budgetInfo: info,
        lastToggle: null,
        ...(() => {
          const selected = s.selected && ids.has(s.selected) ? s.selected : null;
          return { selected, litIds: subtreeIds(ir, selected) };
        })(),
        status: { source, error: null, at: Date.now() },
      };
    }),
  setPollError: (error) => set((s) => ({ status: { ...s.status, error } })),
  collapseToFit: () => {
    const s = useAtlas.getState();
    if (!s.ir) return false;
    // Nothing is excluded: unlike the automatic pass, this MAY collapse containers
    // the user opened — that is what "fit" means, and they asked for it.
    // Target the SMALLER of the budget and the render guard: someone who raised
    // ?budget= past the guard still gets a fast view when they click the button,
    // instead of it appearing to do nothing.
    // `force`: the automatic pass refuses a fold that would hide most of the view, which
    // made this button a silent no-op in the 801..2*budget band — the exact band where
    // the render warning offers it. An explicit request overrides the guard.
    const target = { maxVisible: Math.min(s.budget.maxVisible, RENDER_WARN), maxEdges: s.budget.maxEdges };
    const r = autoCollapse(s.ir, s.collapsed, target, new Set(), new Set(), true);
    // …but `force` can only override a REFUSAL; it cannot invent a candidate. When the
    // level is flat under the root — 900 loose files beside one directory, which is what
    // `fs2ir` emits for a data folder — the automatic pass has already folded the only
    // container and there is nothing left to fold: the root is the canvas and cannot be.
    // Changing no state at all is the honest answer, and it also stops a pointless
    // relayout whose AutoFit threw away wherever the user had panned to.
    const collapsed = new Set(s.collapsed);
    for (const id of r.collapse) {
      collapsed.add(id);
      defaulted.add(id);
      userFitted.add(id); // the user asked: never released as stale budget state
    }
    // the union, not two loops: the sets overlap (the button re-collapses exactly what
    // the budget had chosen) and the status bar read 1,203 for 1,202 containers
    const info = { autoCollapsed: autoCollapsedCount(collapsed), total: r.total, visible: r.visible, edges: r.edges };
    if (r.collapse.length === 0) {
      // The counts are still worth refreshing — the user may have expanded things since
      // the last pass — but `collapsed` and `lastToggle` are left ALONE, so the layout
      // effect does not re-run and nothing refits.
      set({ budgetInfo: info });
      return false;
    }
    set({
      collapsed,
      budgetInfo: info,
      lastToggle: null, // a multi-container change: the incremental path does not apply
    });
    return true;
  },
  toggleCollapse: (id) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (collapsed.has(id)) {
        collapsed.delete(id);
        userCollapsed.delete(id);
      } else {
        collapsed.add(id);
        userCollapsed.add(id); // deliberate: the release must not treat it as stale budget state
      }
      // …and the COUNT moves with it. `budgetInfo` was written only by `setIR` and
      // `collapseToFit`, and `setIR` runs only when the polled bytes change — so on a static
      // live graph "N auto-collapsed" froze at whatever the first pass decided while
      // "showing X" beside it tracked the canvas: expanding three chips left the bar reading
      // "751 auto-collapsed · showing 757/2253" with 748 containers actually collapsed, and
      // its own tooltip still saying "visible 503". It is the number the user consults to
      // decide whether to click "collapse to fit".
      const info = s.budgetInfo ? { ...s.budgetInfo, autoCollapsed: autoCollapsedCount(collapsed) } : s.budgetInfo;
      return { collapsed, lastToggle: id, budgetInfo: info };
    }),
  select: (id) => set((s) => ({ selected: id, litIds: subtreeIds(s.ir, id) })),
}));

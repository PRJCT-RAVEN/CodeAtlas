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
  /** Re-apply the visibility budget to the CURRENT view (an explicit user request). */
  collapseToFit: () => void;
  select: (id: string | null) => void;
}

// Ids we have already applied `collapsedByDefault` to. A refresh of the same
// view must not re-collapse a container the user opened, but a container that
// first appears in this graph should honour the author's default.
const defaulted = new Set<string>();
/** Ids the visibility budget collapsed (subset of `defaulted`). */
const autoChosen = new Set<string>();
/** Display depths the budget collapsed for this root — newcomers at those depths are collapsed too. */
const autoLevels = new Set<number>();
let defaultedRoot: string | null = null;

function applyDefaults(ir: GraphIR, collapsed: Set<string>, budget: BudgetOptions, ids: ReadonlySet<string>): { collapsed: Set<string>; info: BudgetInfo } {
  // a different view root starts from scratch (and keeps the sets bounded)
  if (defaultedRoot !== ir.root) {
    defaulted.clear();
    autoChosen.clear();
    autoLevels.clear();
    defaultedRoot = ir.root;
  }
  // a container that left the graph and comes back is new again: it must get
  // its default/budget treatment instead of rendering expanded among chips
  for (const id of [...defaulted]) if (!ids.has(id)) defaulted.delete(id);
  for (const id of [...autoChosen]) if (!ids.has(id)) autoChosen.delete(id);
  const next = new Set(collapsed);
  const ann = ir.annotations ?? {};
  for (const [id, a] of Object.entries(ann)) {
    if (a?.collapsedByDefault === true && !defaulted.has(id)) {
      next.add(id);
      defaulted.add(id);
    }
  }
  // Visibility budget (ir/budget.ts): containers the author or the user have
  // already decided about are never revisited, so an expand sticks across polls.
  const r = autoCollapse(ir, next, budget, defaulted, autoLevels);
  for (const id of r.collapse) {
    next.add(id);
    defaulted.add(id);
    autoChosen.add(id);
  }
  for (const d of r.levels) autoLevels.add(d);
  let autoCollapsed = 0;
  for (const id of autoChosen) if (next.has(id)) autoCollapsed++;
  return { collapsed: next, info: { autoCollapsed, total: r.total, visible: r.visible, edges: r.edges } };
}

export const useAtlas = create<AtlasState>((set) => ({
  ir: null,
  delta: EMPTY_DELTA,
  collapsed: new Set<string>(),
  selected: null,
  status: { source: null, error: null, at: 0 },
  budget: DEFAULT_BUDGET,
  budgetInfo: null,
  lastToggle: null,
  setBudget: (budget) => set({ budget }),
  setIR: (ir, source) =>
    set((s) => {
      const ids = new Set(ir.nodes.map((n) => n.id));
      // prune state that points at nodes which no longer exist (a formerly
      // collapsed container that became a leaf would otherwise render as "+")
      const pruned = new Set([...s.collapsed].filter((id) => ids.has(id)));
      const { collapsed, info } = applyDefaults(ir, pruned, s.budget, ids);
      return {
        ir,
        delta: diffIR(s.ir, ir),
        collapsed,
        budgetInfo: info,
        lastToggle: null,
        selected: s.selected && ids.has(s.selected) ? s.selected : null,
        status: { source, error: null, at: Date.now() },
      };
    }),
  setPollError: (error) => set((s) => ({ status: { ...s.status, error } })),
  collapseToFit: () =>
    set((s) => {
      if (!s.ir) return {};
      // Nothing is excluded: unlike the automatic pass, this MAY collapse containers
      // the user opened — that is what "fit" means, and they asked for it.
      // Target the SMALLER of the budget and the render guard: someone who raised
      // ?budget= past the guard still gets a fast view when they click the button,
      // instead of it appearing to do nothing.
      const target = { maxVisible: Math.min(s.budget.maxVisible, RENDER_WARN), maxEdges: s.budget.maxEdges };
      const r = autoCollapse(s.ir, s.collapsed, target, new Set(), new Set());
      const collapsed = new Set(s.collapsed);
      for (const id of r.collapse) {
        collapsed.add(id);
        defaulted.add(id);
        autoChosen.add(id);
      }
      let autoCollapsed = 0;
      for (const id of autoChosen) if (collapsed.has(id)) autoCollapsed++;
      return {
        collapsed,
        budgetInfo: { autoCollapsed, total: r.total, visible: r.visible, edges: r.edges },
        lastToggle: null, // a multi-container change: the incremental path does not apply
      };
    }),
  toggleCollapse: (id) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      return { collapsed, lastToggle: id };
    }),
  select: (id) => set({ selected: id }),
}));

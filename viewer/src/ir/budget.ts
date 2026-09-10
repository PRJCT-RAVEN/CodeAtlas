// Visibility budget for big graphs (2026-09-05, "database scale").
//
// ELK and React Flow only ever see the VISIBLE display graph, so a 100k-node
// file is fine as long as most of it starts collapsed. This module decides
// which containers to collapse on first sight so the visible node and edge
// counts stay under a budget: whole depth levels at a time, deepest first
// (every table before any schema, every type before any module -- the view
// stays uniform and the coarse structure stays on screen), largest subtree
// first within a level, ids as the tie-break, so the result is deterministic.
// The user's own expand/collapse decisions are never revisited (the store
// passes them as `exclude`), and neither are the display ancestors of a
// container the user expanded: collapsing a schema would hide the table the
// user just opened.

import type { GraphIR, IRNode } from "./types";

export interface BudgetOptions {
  /** Max visible display nodes (leaves + containers) after auto-collapse. */
  maxVisible: number;
  /** Max aggregated display edges after auto-collapse. */
  maxEdges: number;
}

/** Measured 2026-09-05: about 1 s of ELK for ~600 visible nodes/edges with cross-container edges. */
export const DEFAULT_BUDGET: BudgetOptions = { maxVisible: 600, maxEdges: 800 };

export interface BudgetResult {
  /** Container ids to collapse (in the order they were chosen). */
  collapse: string[];
  /** Display depths whose whole level this pass (or `uniformLevels`) collapsed. */
  levels: number[];
  /** Display nodes in the graph (root and grouping files excluded). */
  total: number;
  visible: number;
  edges: number;
  /** Display nodes hidden by this pass. */
  hidden: number;
}

interface Model {
  byId: Map<string, IRNode>;
  /** Display parent (root and grouping `file` nodes skipped). */
  parentOf: Map<string, string | undefined>;
  childrenOf: Map<string, string[]>;
  display: string[];
}

function buildModel(ir: GraphIR): Model {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const irChildren = new Map<string, number>();
  for (const n of ir.nodes) if (n.parent) irChildren.set(n.parent, (irChildren.get(n.parent) ?? 0) + 1);
  const skip = (n: IRNode) => n.id === ir.root || (n.kind === "file" && (irChildren.get(n.id) ?? 0) > 0);
  const parentOf = new Map<string, string | undefined>();
  const childrenOf = new Map<string, string[]>();
  const display: string[] = [];
  for (const n of ir.nodes) {
    if (skip(n)) continue;
    let p = n.parent ? byId.get(n.parent) : undefined;
    while (p && skip(p)) p = p.parent ? byId.get(p.parent) : undefined;
    parentOf.set(n.id, p?.id);
    display.push(n.id);
    if (p) {
      const arr = childrenOf.get(p.id);
      if (arr) arr.push(n.id);
      else childrenOf.set(p.id, [n.id]);
    }
  }
  return { byId, parentOf, childrenOf, display };
}

/** Highest collapsed display ancestor (what a hidden node renders at), else the id itself. */
function rep(id: string, m: Model, collapsed: ReadonlySet<string>): string {
  let top: string | undefined;
  for (let a: string | undefined = id; a !== undefined; a = m.parentOf.get(a)) if (collapsed.has(a)) top = a;
  return top ?? id;
}

// The tree walks below are iterative: a graph deep enough to exhaust the JS stack
// passes shape.ts (which is iterative and memoised), so a recursive walk here would
// throw out of setIR and — before the poll loop re-armed in a finally — kill the
// live loop for good.
function countVisible(m: Model, collapsed: ReadonlySet<string>): number {
  let n = 0;
  const stack: string[] = [];
  for (const id of m.display) if (m.parentOf.get(id) === undefined) stack.push(id);
  while (stack.length) {
    const id = stack.pop()!;
    n++;
    if (collapsed.has(id)) continue;
    const kids = m.childrenOf.get(id);
    if (kids) stack.push(...kids);
  }
  return n;
}

function countEdges(ir: GraphIR, m: Model, collapsed: ReadonlySet<string>): number {
  const seen = new Set<string>();
  for (const e of ir.edges) {
    if (e.kind === "contains" || !m.parentOf.has(e.from) || !m.parentOf.has(e.to)) continue;
    const s = rep(e.from, m, collapsed);
    const t = rep(e.to, m, collapsed);
    if (s === t && e.from !== e.to) continue;
    seen.add(`${e.kind} ${s} ${t}`);
  }
  return seen.size;
}

/** Visible display nodes strictly below `id` under the current collapsed set. */
function visibleBelow(id: string, m: Model, collapsed: ReadonlySet<string>): number {
  let n = 0;
  const stack = [...(m.childrenOf.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    if (collapsed.has(c)) continue;
    const kids = m.childrenOf.get(c);
    if (kids) stack.push(...kids);
  }
  return n;
}

export function autoCollapse(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  opts: BudgetOptions = DEFAULT_BUDGET,
  exclude: ReadonlySet<string> = new Set(),
  /** Depths collapsed by an earlier pass: a container that newly appears there is collapsed too, so the level stays uniform. */
  uniformLevels: ReadonlySet<number> = new Set()
): BudgetResult {
  const m = buildModel(ir);
  const cur = new Set(collapsed);
  const before = countVisible(m, cur);
  let visible = before;

  // depth + subtree size per display node
  const depth = new Map<string, number>();
  const size = new Map<string, number>();
  // walk UP to the first known depth, then fill the chain back down
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const chain: string[] = [];
    let cur: string | undefined = id;
    let base = 0;
    while (cur !== undefined) {
      const d = depth.get(cur);
      if (d !== undefined) {
        base = d;
        break;
      }
      chain.push(cur);
      cur = m.parentOf.get(cur);
    }
    // cur === undefined → the last id pushed is a display root at depth 0
    for (let i = chain.length - 1, d = cur === undefined ? -1 : base; i >= 0; i--) depth.set(chain[i], ++d);
    return depth.get(id)!;
  };
  // post-order over an explicit stack: children are summed before their parent
  const sizeOf = (id: string): number => {
    const known = size.get(id);
    if (known !== undefined) return known;
    const stack: Array<{ id: string; expanded: boolean }> = [{ id, expanded: false }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (size.has(top.id)) {
        stack.pop();
        continue;
      }
      const kids = m.childrenOf.get(top.id) ?? [];
      if (!top.expanded) {
        top.expanded = true;
        for (const c of kids) if (!size.has(c)) stack.push({ id: c, expanded: false });
        continue;
      }
      stack.pop();
      let v = 1;
      for (const c of kids) v += size.get(c)!;
      size.set(top.id, v);
    }
    return size.get(id)!;
  };
  // ancestors of excluded-and-expanded containers are off limits too
  const protectedIds = new Set(exclude);
  for (const id of exclude) {
    if (cur.has(id) || !m.parentOf.has(id)) continue;
    for (let a = m.parentOf.get(id); a !== undefined; a = m.parentOf.get(a)) protectedIds.add(a);
  }
  const candidates = m.display
    .filter((id) => (m.childrenOf.get(id)?.length ?? 0) > 0 && !cur.has(id) && !protectedIds.has(id))
    .sort((a, b) => depthOf(b) - depthOf(a) || sizeOf(b) - sizeOf(a) || (a < b ? -1 : a > b ? 1 : 0));

  const isVisible = (id: string) => rep(id, m, cur) === id;
  const chosen: string[] = [];
  const collapse = (id: string) => {
    const hidden = visibleBelow(id, m, cur);
    cur.add(id);
    chosen.push(id);
    visible -= hidden;
  };

  // candidates grouped by depth, deepest level first
  const levels: string[][] = [];
  for (const id of candidates) {
    const d = depthOf(id);
    const last = levels[levels.length - 1];
    if (last && depthOf(last[0]) === d) last.push(id);
    else levels.push([id]);
  }
  const collapseLevel = (level: string[]) => {
    for (const id of level) if (isVisible(id) && !cur.has(id)) collapse(id);
  };
  const done: number[] = [];
  // levels an earlier pass collapsed stay uniform for newcomers
  for (const level of levels) {
    const d = depthOf(level[0]);
    if (uniformLevels.has(d)) {
      collapseLevel(level);
      done.push(d);
    }
  }
  // node phase: whole levels until the visible count fits
  let li = 0;
  for (; li < levels.length && visible > opts.maxVisible; li++) {
    collapseLevel(levels[li]);
    done.push(depthOf(levels[li][0]));
  }
  // edge phase: aggregated display edges must fit too
  let edges = countEdges(ir, m, cur);
  for (; li < levels.length && edges > opts.maxEdges; li++) {
    collapseLevel(levels[li]);
    done.push(depthOf(levels[li][0]));
    edges = countEdges(ir, m, cur);
  }
  return { collapse: chosen, levels: [...new Set(done)], total: m.display.length, visible, edges, hidden: before - visible };
}

/** `?budget=<nodes>[,<edges>]` -> options, else null (defaults apply). */
export function parseBudget(search: string): BudgetOptions | null {
  const raw = new URLSearchParams(search).get("budget");
  if (!raw) return null;
  const [n, e] = raw.split(",").map((s) => Number(s));
  if (!Number.isFinite(n) || n < 1) return null;
  const maxEdges = Number.isFinite(e) && e >= 1 ? Math.floor(e) : Math.max(DEFAULT_BUDGET.maxEdges, Math.floor(n));
  return { maxVisible: Math.floor(n), maxEdges };
}

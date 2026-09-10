// Visibility budget for big graphs (2026-09-05, "database scale").
//
// ELK and React Flow only ever see the VISIBLE display graph, so a 100k-node
// file is fine as long as most of it starts collapsed. This module decides
// which containers to collapse on first sight so the visible node and edge
// counts stay under a budget: whole depth levels at a time, deepest first
// (every table before any schema, every type before any module -- the view
// stays uniform and the coarse structure stays on screen), largest subtree
// first within a level, ids as the tie-break, so the result is deterministic.
// The LAST level goes only as far as it has to (2026-09-10): folding it whole
// because the view was three nodes over budget cost a whole level of context --
// a 600-table Postgres import landed on one schema chip -- so there the biggest
// subtrees fold and the rest stay open, and a fold that would gut a view already
// close to its cap is refused outright (see MILD/MOST). A PARTIAL level is
// deliberately absent from `levels`: the store remembers those depths and collapses
// newcomers there unconditionally, which would finish the level off on the next poll.
// The user's own expand/collapse decisions are never revisited (the store
// passes them as `exclude`), and neither are the display ancestors of a
// container the user expanded: collapsing a schema would hide the table the
// user just opened.
//
// Both counts are maintained INCREMENTALLY as containers fold (a hidden-node set,
// and display edges bucketed by the id they render at). Recomputing them per level
// was O(levels x graph) -- 5.7 s on a 20,000-deep chain -- and the per-container
// decision above would have made that O(candidates x graph).

import type { GraphIR, IRNode } from "./types";

export interface BudgetOptions {
  /** Max visible display nodes (leaves + containers) after auto-collapse. */
  maxVisible: number;
  /** Max aggregated display edges after auto-collapse. */
  maxEdges: number;
}

/**
 * Measured 2026-09-05: about 1 s of ELK for ~600 visible nodes/edges with cross-container edges.
 * The edge cap matches `FASTEST_EDGES` in layout/elk.ts on purpose — a budgeted view
 * stays inside the tier that still routes edges orthogonally.
 */
export const DEFAULT_BUDGET: BudgetOptions = { maxVisible: 600, maxEdges: 800 };

/**
 * Above this many VISIBLE nodes the viewer says so and offers to collapse back.
 *
 * PROJECT_SPEC §3(C)/N4 asked for a hard cap that force-collapses instead of
 * rendering. The budget already does that for a graph as it ARRIVES; the gap this
 * fills is a user expanding their way past it afterwards. Forcing a collapse there
 * would undo the click the user just made, so this warns and offers the action
 * instead — the spec's protection, without fighting the person using it.
 */
export const RENDER_WARN = 800;

/**
 * When the view is within this multiple of a cap it is only MILDLY over it, and a fold
 * that would hide more than `MOST` of what is on screen is refused: hiding 600 tables to
 * get one node under the node cap — or to shave an edge overflow the layout already has a
 * cheaper tier for (`layoutTier` in layout/elk.ts) — is how a 600-table schema became a
 * single chip. Grossly over a cap there is no such trade and everything folds.
 */
const MILD = 2;
const MOST = 0.5;

export interface BudgetResult {
  /** Container ids to collapse (in the order they were chosen). */
  collapse: string[];
  /** Display depths whose WHOLE level this pass (or `uniformLevels`) collapsed. */
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

/** One aggregated display edge in flight: `s`/`t` are the ids its endpoints currently render at. */
interface DisplayEdge {
  kind: string;
  from: string;
  to: string;
  s: string;
  t: string;
  /** null once both endpoints render at the same id — an edge that folded into a node, and can never reappear. */
  key: string | null;
}

// The tree walks below are iterative: a graph deep enough to exhaust the JS stack
// passes shape.ts (which is iterative and memoised), so a recursive walk here would
// throw out of setIR and — before the poll loop re-armed in a finally — kill the
// live loop for good.
export function autoCollapse(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  opts: BudgetOptions = DEFAULT_BUDGET,
  exclude: ReadonlySet<string> = new Set(),
  /** Depths collapsed by an earlier pass: a container that newly appears there is collapsed too, so the level stays uniform. */
  uniformLevels: ReadonlySet<number> = new Set(),
  /**
   * Drop the anti-gutting guard (MILD/MOST). Only for an explicit "collapse to fit":
   * the guard exists so the AUTOMATIC pass never trades a whole level of context for a
   * handful of nodes, but someone who clicks the button has asked for exactly that, and
   * a guard that silently declines makes the button a no-op. `over()` still stops the
   * fold the moment the view fits, so gutting is the last resort, not the first move.
   */
  force = false
): BudgetResult {
  const m = buildModel(ir);
  const cur = new Set(collapsed);

  // One walk from the display roots answers both questions the pass keeps asking:
  // what is hidden under an already-collapsed container, and what each display node
  // RENDERS at (its highest collapsed ancestor, else itself).
  const hidden = new Set<string>();
  const repOf = new Map<string, string>();
  let before = 0;
  {
    const stack: Array<[string, string | null]> = [];
    for (const id of m.display) if (m.parentOf.get(id) === undefined) stack.push([id, null]);
    while (stack.length) {
      const [id, top] = stack.pop()!;
      if (top === null) before++;
      else hidden.add(id);
      repOf.set(id, top ?? id);
      const kids = m.childrenOf.get(id);
      if (kids) {
        const below = top ?? (cur.has(id) ? id : null);
        for (const c of kids) stack.push([c, below]);
      }
    }
  }
  let visible = before;

  // Display edges keyed by (kind, source rep, target rep), bucketed by the ids they
  // render at, so collapsing a container only re-keys the edges beneath it.
  const dedges: DisplayEdge[] = [];
  const incident = new Map<string, number[]>();
  const keyCount = new Map<string, number>();
  const keyOf = (d: DisplayEdge) => (d.s === d.t && d.from !== d.to ? null : `${d.kind} ${d.s} ${d.t}`);
  const addKey = (k: string | null) => {
    if (k !== null) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  };
  const dropKey = (k: string | null) => {
    if (k === null) return;
    const n = keyCount.get(k)!;
    if (n > 1) keyCount.set(k, n - 1);
    else keyCount.delete(k);
  };
  const attach = (id: string, i: number) => {
    const arr = incident.get(id);
    if (arr) arr.push(i);
    else incident.set(id, [i]);
  };
  for (const e of ir.edges) {
    if (e.kind === "contains" || !m.parentOf.has(e.from) || !m.parentOf.has(e.to)) continue;
    const d: DisplayEdge = { kind: e.kind, from: e.from, to: e.to, s: repOf.get(e.from)!, t: repOf.get(e.to)!, key: null };
    d.key = keyOf(d);
    if (d.key === null) continue; // already folded away; no further collapse can bring it back
    const i = dedges.length;
    dedges.push(d);
    addKey(d.key);
    attach(d.s, i);
    if (d.t !== d.s) attach(d.t, i);
  }
  /** Move every edge rendering at `from` onto `to` (the container `from` just folded into). */
  const rekey = (from: string, to: string) => {
    const list = incident.get(from);
    if (!list) return;
    incident.delete(from);
    const keep: number[] = [];
    for (const i of list) {
      const d = dedges[i];
      dropKey(d.key);
      if (d.s === from) d.s = to;
      if (d.t === from) d.t = to;
      d.key = keyOf(d);
      addKey(d.key);
      if (d.key !== null) keep.push(i);
    }
    const arr = incident.get(to);
    if (arr) for (const i of keep) arr.push(i);
    else incident.set(to, keep);
  };

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

  const chosen: string[] = [];
  const collapse = (id: string) => {
    // everything still visible under `id` folds into it
    const stack = [...(m.childrenOf.get(id) ?? [])];
    let n = 0;
    while (stack.length) {
      const c = stack.pop()!;
      if (hidden.has(c)) continue;
      hidden.add(c);
      n++;
      rekey(c, id);
      if (cur.has(c)) continue;
      const kids = m.childrenOf.get(c);
      if (kids) stack.push(...kids);
    }
    cur.add(id);
    chosen.push(id);
    visible -= n;
  };
  /** Would folding `id` hide most of the visible view? (`sizeOf` bounds it, so the walk is usually skipped.) */
  const gutsTheView = (id: string) => {
    const most = visible * MOST;
    if (sizeOf(id) <= most) return false;
    let n = 0;
    const stack = [...(m.childrenOf.get(id) ?? [])];
    while (stack.length && n <= most) {
      const c = stack.pop()!;
      if (hidden.has(c)) continue;
      n++;
      if (cur.has(c)) continue;
      const kids = m.childrenOf.get(c);
      if (kids) stack.push(...kids);
    }
    return n > most;
  };

  // candidates grouped by depth, deepest level first
  const levels: string[][] = [];
  for (const id of candidates) {
    const d = depthOf(id);
    const last = levels[levels.length - 1];
    if (last && depthOf(last[0]) === d) last.push(id);
    else levels.push([id]);
  }
  /** Fold this level (largest subtree first) while `over()` holds; true when the WHOLE level went. */
  /** Containers a phase declined to gut. The decision is final for this whole pass. */
  const refused = new Set<string>();
  const foldLevel = (level: string[], over: () => boolean, mild: () => boolean): boolean => {
    const open = level.filter((id) => !hidden.has(id) && !cur.has(id));
    let folded = 0;
    for (const id of open) {
      if (!over()) break;
      // A container the NODE phase protected stays protected in the EDGE phase. Without
      // this the edge phase folded exactly what the node phase had just refused a moment
      // earlier — which did not remove the "600 tables became one chip" cliff, only moved
      // it to ~810 tables, where the aggregated foreign keys pass 2x the edge budget.
      // (Left in `open`, so a level that ends here still counts as NOT wholly folded.)
      if (refused.has(id)) continue;
      if (!force && mild() && gutsTheView(id)) {
        refused.add(id);
        continue; // smaller siblings may still be worth folding
      }
      collapse(id);
      folded++;
    }
    return folded === open.length;
  };
  const always = () => true;
  const never = () => false;
  const done: number[] = [];
  // levels an earlier pass collapsed stay uniform for newcomers
  for (const level of levels) {
    const d = depthOf(level[0]);
    if (!uniformLevels.has(d)) continue;
    foldLevel(level, always, never);
    done.push(d);
  }
  // node phase: levels until the visible count fits, the last one only as far as it must
  let li = 0;
  for (; li < levels.length && visible > opts.maxVisible; li++) {
    if (!foldLevel(levels[li], () => visible > opts.maxVisible, () => visible <= MILD * opts.maxVisible)) break;
    done.push(depthOf(levels[li][0]));
  }
  // edge phase: aggregated display edges must fit too
  for (; li < levels.length && keyCount.size > opts.maxEdges; li++) {
    if (!foldLevel(levels[li], () => keyCount.size > opts.maxEdges, () => keyCount.size <= MILD * opts.maxEdges)) break;
    done.push(depthOf(levels[li][0]));
  }
  return { collapse: chosen, levels: [...new Set(done)], total: m.display.length, visible, edges: keyCount.size, hidden: before - visible };
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

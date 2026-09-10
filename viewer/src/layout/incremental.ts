// Incremental relayout for one collapse/expand (2026-09-05).
//
// A full ELK run over the visible graph costs ~1.7 s for a 240-node view of a
// 100k-node file, and every toggle used to pay it. Here only the toggled
// container's own subtree is laid out by ELK (a mini graph rooted at it); the
// result is spliced into the previous layout, neighbours are pushed just far
// enough to make room (never pulled back — gaps are harmless, overlaps are
// not), ancestors grow, and every routed edge whose endpoints did not move
// keeps its polyline. Edges touching moved or new nodes fall back to plain
// curves. "Tidy" (a full relayout) restores the routed picture on demand; the
// next graph change relays out in full anyway. Used by App only when the last
// full layout was expensive OR the view is large (INCREMENTAL_MIN_MS /
// INCREMENTAL_MIN_NODES), so small views keep their routed quality. DENSE views
// are NOT excluded: App applies the same rule to them and never consults
// `mode.dense`, so a dense view past INCREMENTAL_MIN_NODES is spliced like any
// other (measured: expanding a schema in the 40-chip overview of a 104k-node
// file, 344 ms).

import {
  buildDisplay,
  containerMinWidth,
  layoutGraph,
  type DisplayEdge,
  type DisplayNode,
  type LayoutOptions,
  type LayoutResult,
  type Point,
} from "./elk";
import type { GraphIR } from "../ir/types";

/** Must match "elk.padding" in elk.ts and the container spacing there. */
export const PAD = { top: 34, left: 20, bottom: 20, right: 20 };
export const GAP = 44;

type Abs = Map<string, { x: number; y: number; w: number; h: number }>;

function absolute(nodes: DisplayNode[]): Abs {
  const abs: Abs = new Map();
  for (const n of nodes) {
    const p = n.parentId ? abs.get(n.parentId) : undefined;
    abs.set(n.ir.id, { x: (p?.x ?? 0) + n.x, y: (p?.y ?? 0) + n.y, w: n.width, h: n.height });
  }
  return abs;
}

/**
 * IR children by parent id, in `ir.nodes` order. Appending in place matters:
 * rebuilding each sibling array (`[...(kids.get(p) ?? []), id]`) is O(k²) per
 * parent, which cost 330 ms on a 20,000-column table — on the path chosen
 * precisely because the graph is big.
 */
export function childIndex(ir: GraphIR): Map<string, string[]> {
  const kids = new Map<string, string[]>();
  for (const n of ir.nodes) {
    if (!n.parent) continue;
    const arr = kids.get(n.parent);
    if (arr) arr.push(n.id);
    else kids.set(n.parent, [n.id]);
  }
  return kids;
}

/** Ids of `id` and every display descendant in `nodes` (parentId chains). */
function subtreeOf(nodes: DisplayNode[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const n of nodes) if (n.parentId && out.has(n.parentId)) out.add(n.ir.id);
  return out;
}

/**
 * Push siblings of `c` (same parentId) so nothing overlaps its new box:
 * right neighbours that share rows move right, everything below moves down.
 * Returns whether anything moved.
 */
function makeRoom(nodes: DisplayNode[], c: DisplayNode, oldW: number, oldH: number): boolean {
  let moved = false;
  const rightSide = nodes.filter(
    (s) => s !== c && s.parentId === c.parentId && s.x >= c.x + oldW - 1 && s.y < c.y + c.height && s.y + s.height > c.y
  );
  if (rightSide.length > 0) {
    const nearest = Math.min(...rightSide.map((s) => s.x));
    const dx = c.x + c.width + GAP - nearest;
    if (dx > 0) {
      for (const s of rightSide) s.x += dx;
      moved = true;
    }
  }
  const below = nodes.filter((s) => s !== c && s.parentId === c.parentId && s.y >= c.y + oldH - 1);
  if (below.length > 0) {
    const nearest = Math.min(...below.map((s) => s.y));
    const dy = c.y + c.height + GAP - nearest;
    if (dy > 0) {
      for (const s of below) s.y += dy;
      moved = true;
    }
  }
  return moved;
}

/** Grow `p` to contain its children (never shrink), return the old size. */
function fit(nodes: DisplayNode[], p: DisplayNode): { w: number; h: number } {
  const old = { w: p.width, h: p.height };
  let maxX = 0;
  let maxY = 0;
  for (const k of nodes) {
    if (k.parentId !== p.ir.id) continue;
    maxX = Math.max(maxX, k.x + k.width);
    maxY = Math.max(maxY, k.y + k.height);
  }
  p.width = Math.max(p.width, maxX + PAD.right, containerMinWidth(p.ir));
  p.height = Math.max(p.height, maxY + PAD.bottom, 60);
  return old;
}

export interface IncrementalOptions {
  labelFor?: LayoutOptions["labelFor"];
}

/**
 * Layout after toggling `toggled`, derived from `prev` (the layout before the
 * toggle, for the same `ir`). `collapsed` is the state AFTER the toggle.
 * Returns null when the toggle cannot be applied incrementally (unknown node).
 */
export async function incrementalToggle(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  toggled: string,
  prev: LayoutResult,
  opts: IncrementalOptions = {}
): Promise<LayoutResult | null> {
  const started = performance.now();
  const prevC = prev.nodes.find((n) => n.ir.id === toggled);
  if (!prevC) return null;
  const model = buildDisplay(ir, collapsed, opts.labelFor);
  if (!model.visibleIds.has(toggled)) return null; // e.g. an ancestor is collapsed

  // --- new box + subtree for the toggled node ------------------------------
  const oldSubtree = subtreeOf(prev.nodes, toggled);
  const oldW = prevC.width;
  const oldH = prevC.height;
  let subNodes: DisplayNode[] = [];
  let subEdges: DisplayEdge[] = [];
  const c: DisplayNode = { ...prevC, isContainer: model.isContainer(toggled), collapsed: collapsed.has(toggled) };
  if (c.isContainer) {
    // mini graph rooted at the toggled node: its descendants, plus the edges among them
    const inside = new Set<string>();
    const stack = [toggled];
    const kids = childIndex(ir);
    while (stack.length) {
      const id = stack.pop()!;
      if (inside.has(id)) continue;
      inside.add(id);
      for (const k of kids.get(id) ?? []) stack.push(k);
    }
    const mini: GraphIR = {
      ...ir,
      root: toggled,
      nodes: ir.nodes.filter((n) => inside.has(n.id)),
      edges: ir.edges.filter((e) => inside.has(e.from) && inside.has(e.to)),
    };
    // The mini graph makes its OWN tier/density decision, so a subtree spliced
    // into a dense parent view can come back orthogonally routed with inline
    // chips. Harmless (the parent's mode still decides how App draws them, and
    // the subtree is small by construction) but it is why the two halves of the
    // picture can look different until "Tidy".
    const sub = await layoutGraph(mini, collapsed, { labelFor: opts.labelFor });
    let maxX = 0;
    let maxY = 0;
    for (const n of sub.nodes) {
      if (n.parentId) continue;
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    c.width = Math.max(containerMinWidth(c.ir), maxX + PAD.left + PAD.right);
    c.height = Math.max(60, maxY + PAD.top + PAD.bottom);
    subNodes = sub.nodes.map((n) =>
      n.parentId ? n : { ...n, parentId: toggled, x: n.x + PAD.left, y: n.y + PAD.top }
    );
    subEdges = sub.edges;
  } else {
    const size = model.leafSize(toggled);
    c.width = size.width;
    c.height = size.height;
  }

  // --- splice: old subtree out, new one in right after the toggled node ------
  const nodes: DisplayNode[] = [];
  for (const n of prev.nodes) {
    if (n.ir.id === toggled) {
      nodes.push(c);
      // a loop, not `push(...subNodes)`: expanding one very large container passes one
      // argument per node, which throws RangeError instead of laying out
      for (const sn of subNodes) nodes.push(sn);
    } else if (!oldSubtree.has(n.ir.id)) {
      nodes.push({ ...n });
    }
  }
  // sizes and flags of everything outside the subtree come from prev, but a
  // formerly-collapsed sibling chip etc. is unaffected; only c changed.

  // --- make room, growing ancestors as needed --------------------------------
  const byId = new Map(nodes.map((n) => [n.ir.id, n]));
  let cur: DisplayNode | undefined = c;
  let oldSize = { w: oldW, h: oldH };
  while (cur) {
    makeRoom(nodes, cur, oldSize.w, oldSize.h);
    const parent: DisplayNode | undefined = cur.parentId ? byId.get(cur.parentId) : undefined;
    if (!parent) break;
    oldSize = fit(nodes, parent);
    if (parent.width === oldSize.w && parent.height === oldSize.h) break;
    cur = parent;
  }

  // --- edges: keep routes whose endpoints did not move ------------------------
  const before = absolute(prev.nodes);
  const after = absolute(nodes);
  const prevEdge = new Map(prev.edges.map((e) => [e.id, e]));
  const subEdge = new Map(subEdges.map((e) => [e.id, e]));
  const origin = after.get(toggled)!;
  const shift = (p: Point): Point => ({ x: p.x + origin.x + PAD.left, y: p.y + origin.y + PAD.top });
  const unmoved = (id: string) => {
    const a = before.get(id);
    const b = after.get(id);
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  };
  const edges: DisplayEdge[] = model.displayEdges.map((e) => {
    const s = subEdge.get(e.id);
    if (s?.points) return { ...e, points: s.points.map(shift), labelPos: s.labelPos ? shift(s.labelPos) : undefined };
    const p = prevEdge.get(e.id);
    if (p?.points && unmoved(e.source) && unmoved(e.target)) return { ...e, points: p.points, labelPos: p.labelPos };
    return e; // plain curve between the nodes
  });

  // The base must have been exactly one toggle away: if a second toggle landed
  // while a pass was pending, the spliced node set will not match the display
  // model — refuse, and the caller runs a full layout instead of showing a
  // view with missing nodes and dangling edges.
  const expected = model.visibleIds;
  if (nodes.length !== expected.size || nodes.some((n) => !expected.has(n.ir.id))) return null;

  return { nodes, edges, mode: { ...prev.mode, incremental: true }, layoutMs: performance.now() - started };
}

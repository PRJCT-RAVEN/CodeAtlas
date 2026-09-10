// "What changed" between two consecutive live graphs (spec G3 / M3 delta
// highlighting). Only meaningful when both graphs are the same VIEW — we use
// the root id as the view identity; a different root is a different question,
// not a change.

import type { GraphIR, IRNode } from "./types";

export interface Delta {
  added: Set<string>;
  modified: Set<string>;
  /** Removed node ids (they have nothing to highlight; listed in the status bar). */
  removed: string[];
  addedEdges: Set<string>;
  removedEdges: string[];
}

export const EMPTY_DELTA: Delta = {
  added: new Set(),
  modified: new Set(),
  removed: [],
  addedEdges: new Set(),
  removedEdges: [],
};

// Semantics, not position: locs are ignored so reformatting doesn't light up
// the whole diagram (the same rule tools/irdiff.mjs applies).
function sameNode(a: IRNode, b: IRNode): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.parent === b.parent &&
    JSON.stringify(a.attrs ?? null) === JSON.stringify(b.attrs ?? null)
  );
}

export function diffIR(prev: GraphIR | null, next: GraphIR): Delta {
  if (!prev || prev.root !== next.root) return EMPTY_DELTA;
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [id, n] of after) {
    const old = before.get(id);
    if (!old) added.add(id);
    else if (!sameNode(old, n)) modified.add(id);
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const beforeE = new Set(prev.edges.map((e) => e.id));
  const afterE = new Set(next.edges.map((e) => e.id));
  const addedEdges = new Set([...afterE].filter((id) => !beforeE.has(id)));
  const removedEdges = [...beforeE].filter((id) => !afterE.has(id));
  return { added, modified, removed, addedEdges, removedEdges };
}

export function isEmptyDelta(d: Delta): boolean {
  return (
    d.added.size === 0 &&
    d.modified.size === 0 &&
    d.removed.length === 0 &&
    d.addedEdges.size === 0 &&
    d.removedEdges.length === 0
  );
}

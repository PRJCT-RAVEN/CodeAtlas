// "What changed" between two consecutive live graphs (spec G3 / M3 delta
// highlighting). Only meaningful when both graphs are the same VIEW — we use
// the root id as the view identity; a different root is a different question,
// not a change.

import type { GraphIR, IRNode } from "./types";
import { edgeCount } from "./density";

export interface Delta {
  /**
   * False when there was nothing to compare against — a first load, or a different root.
   * A display edge decides "added" from `prevCount`, and an EMPTY previous map means two
   * different things: no previous graph (nothing is a change) or a previous graph with no
   * drawn edges (everything is). Only this tells them apart.
   */
  compared: boolean;
  added: Set<string>;
  modified: Set<string>;
  /** Removed node ids (they have nothing to highlight; listed in the status bar). */
  removed: string[];
  addedEdges: Set<string>;
  /**
   * Edges whose `count` changed. The id embeds kind/from/to, so an id-set diff can never see
   * this — and the chip visibly changes from `calls ×2` to `calls ×7` while the status bar,
   * the Key and the canvas all said nothing. `tools/irdiff.mjs` has diffed the same field
   * since it was written (`EDGE_FIELDS`); this is the viewer catching up. What is compared is
   * `edgeCount` — the number the CHIP shows — not the raw `count`, because `locs` alone is a
   * first-class authoring shape. `irdiff` derives the same number (inlined there, it has no
   * dependencies), so the two tools agree on what a change is — an earlier version of this
   * comment claimed irdiff "never renders a multiplicity", which was false: it prints `×N`,
   * and for one round it printed it from the raw field while the viewer used this.
   */
  modifiedEdges: Set<string>;
  removedEdges: string[];
  /**
   * Multiplicity of every drawn edge in the PREVIOUS graph, by id — what a DISPLAY edge
   * needs to decide its own delta. Several IR edges fold into one display edge whenever a
   * container is collapsed (the normal state of any big graph), and lifting "some
   * constituent was added" onto the display edge painted an edge that merely GREW green as
   * new, while one that SHRANK — constituents removed — got nothing, beside a status bar
   * saying "−1 removed" about a connection still on screen. With the previous counts the
   * display edge can ask the right question: was ANY of me here before (else added), and if
   * so does my summed multiplicity differ (modified)?
   */
  prevCount: Map<string, number>;
  /**
   * The removed drawn edges themselves, not only their ids: a display edge that SHRANK has
   * constituents that are no longer in its `irIds`, and only their endpoints can say which
   * display edge they belonged to.
   */
  removedEdgeRecords: { kind: string; from: string; to: string; count: number }[];
}

export const EMPTY_DELTA: Delta = {
  compared: false,
  added: new Set(),
  modified: new Set(),
  modifiedEdges: new Set(),
  prevCount: new Map(),
  removedEdgeRecords: [],
  removed: [],
  addedEdges: new Set(),
  removedEdges: [],
};

// Semantics, not position: locs are ignored so reformatting doesn't light up
// the whole diagram (the same rule tools/irdiff.mjs applies).
function sameNode(a: IRNode, b: IRNode): boolean {
  return a.kind === b.kind && a.name === b.name && a.parent === b.parent && sameValue(a.attrs ?? null, b.attrs ?? null);
}

/**
 * Structural equality with KEY ORDER ignored — what `attrs` needs. `JSON.stringify` on both
 * sides is order-sensitive, so a generator that emitted `{access, typeKind}` one run and
 * `{typeKind, access}` the next lit the node amber as "modified" for a graph that is
 * semantically identical, while `irdiff` (whose `deepEqual` sorts keys) said "no changes".
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameValue(v, (b as unknown[])[i]));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
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
  // `contains` is hierarchy, not a relation anyone draws: it mirrors `parent` (the validator
  // enforces both directions), so every added node brings one and counting them made the
  // status bar read "+2 added" for one new node. The delta highlight only ever asks about
  // DISPLAY edges, which exclude `contains` by construction.
  const drawn = (e: { kind: string }) => e.kind !== "contains";
  const beforeE = new Map(prev.edges.filter(drawn).map((e) => [e.id, e]));
  const afterE = new Map(next.edges.filter(drawn).map((e) => [e.id, e]));
  const addedEdges = new Set([...afterE.keys()].filter((id) => !beforeE.has(id)));
  const removedEdges = [...beforeE.keys()].filter((id) => !afterE.has(id));
  const modifiedEdges = new Set<string>();
  for (const [id, e] of afterE) {
    const old = beforeE.get(id);
    if (old && edgeCount(old) !== edgeCount(e)) modifiedEdges.add(id);
  }
  const prevCount = new Map<string, number>();
  for (const [id, e] of beforeE) prevCount.set(id, edgeCount(e));
  const removedEdgeRecords = removedEdges.map((id) => {
    const e = beforeE.get(id)!;
    return { kind: e.kind, from: e.from, to: e.to, count: edgeCount(e) };
  });
  return { compared: true, added, modified, modifiedEdges, removed, addedEdges, removedEdges, prevCount, removedEdgeRecords };
}

export function isEmptyDelta(d: Delta): boolean {
  return (
    d.added.size === 0 &&
    d.modified.size === 0 &&
    d.removed.length === 0 &&
    d.addedEdges.size === 0 &&
    d.modifiedEdges.size === 0 &&
    d.removedEdges.length === 0
  );
}

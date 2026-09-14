// Facts about a DISPLAY graph that both the layout engine and the visibility budget need:
// how an aggregated edge is keyed, and how expensive the result is to paint.
//
// They live here rather than in layout/elk.ts so `ir/` never has to import the layout
// engine to agree with it — three copies of "is this dense?" and two of "how is an edge
// keyed" is precisely the failure this codebase keeps repeating: a definition duplicated
// instead of shared, and the copies drifting. `layout/elk.ts` re-exports all of it, so no
// call site had to change.

/** A view is "dense" when it has more than this many display edges AND more than DENSE_RATIO per visible node. */
export const DENSE_MIN_EDGES = 200;
export const DENSE_RATIO = 3;
/** Edges are the expensive part of hierarchical orthogonal routing: 1,200 cross-container edges cost 3 s to lay out and 2.4 s per pan (measured); above this many, the heavy path. */
export const FASTEST_EDGES = 800;

/** Edge-heavy: ELK is given no edges and they are drawn faint (`LayoutMode.dense`). */
export function isDense(visibleNodes: number, displayEdges: number): boolean {
  return displayEdges > DENSE_MIN_EDGES && displayEdges > DENSE_RATIO * visibleNodes;
}

/**
 * Dense AND past `FASTEST_EDGES`: nothing is drawn until an edge is traced
 * (`LayoutMode.hairball`), so the view costs ZERO SVG paths however many edges it has.
 *
 * That is why the budget consults this before giving up on an edge-heavy view: a hairball
 * is cheap to paint, and folding it away buys nothing but lost context.
 */
export function isHairball(visibleNodes: number, displayEdges: number): boolean {
  return isDense(visibleNodes, displayEdges) && displayEdges > FASTEST_EDGES;
}

/**
 * Display-edge id: unambiguous whatever characters the node ids contain.
 *
 * NOT `${kind} ${source} ${target}`: a node id may contain spaces (`fs2ir` emits
 * `doc:My Folder/x`), so two different pairs can build the same string and the aggregated
 * edge count silently merges them.
 */
export function edgeKey(kind: string, source: string, target: string): string {
  return JSON.stringify([kind, source, target]);
}

/**
 * How many source-level relations an edge stands for — the number the chip shows as `×N`.
 *
 * `count` may stand alone on a conceptual edge, and `locs` may stand alone on a structural
 * one (the honesty rule mandates `locs`, never `count`; `agents/graph-author.md` spells out
 * that either may appear). Two expressions of this existed: the layout derived the DRAWN
 * number from `count ?? locs.length` while `diffIR` compared `count` alone — so a `locs`-only
 * edge going from three call sites to seven changed the chip on screen and was reported
 * nowhere, and an edge converted from `count: 2` to two `locs` was announced as modified
 * with nothing visibly different. One definition, beside `edgeKey`, which lives here for the
 * same reason.
 */
export function edgeCount(e: { count?: number; locs?: unknown[] }): number {
  return e.count ?? e.locs?.length ?? 1;
}

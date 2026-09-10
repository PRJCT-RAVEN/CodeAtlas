// Edge-label placement, pass 2 (2026-09-05).
//
// ELK reserves room for inline labels while layering, but a chip can still land
// where an edge from ANOTHER hierarchy level crosses, on a container outline,
// or on top of a neighbouring chip. This pass keeps every chip ON its own
// routed polyline and slides it to the least-bad spot: candidates are sampled
// along the path (ELK's own position first), scored against leaf boxes,
// container outlines, already-placed chips and other edges' segments, with a
// small pull back towards ELK's choice. A uniform grid keeps it near-linear.

import type { Point } from "./elk";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelInput {
  id: string;
  /** Routed polyline in ROOT coordinates. */
  points: Point[];
  w: number;
  h: number;
  /** ELK's inline position (chip centre), if any. */
  pos?: Point;
}

export interface Obstacles {
  leaves: Box[];
  containers: Box[];
}

export const PENALTY = {
  leaf: 1000, // chip over a node pill/rect
  outline: 300, // chip across a container border
  chip: 200, // chip over another chip
  cross: 60, // another edge's segment through the chip
  drift: 12, // per unit of (distance from ELK's spot / path length)
};
const STEP = 12; // px between candidates along the path
const OUTLINE_PAD = 4;
export const CELL = 96;

type Seg = { a: Point; b: Point; owner: string };
/** A container outline is indexed as four thin border strips, not its whole area. */
type Strip = { box: Box; strip: Box };

function centreRect(c: Point, w: number, h: number): Box {
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

function rectsOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Chip touches the border band of a container (not its interior). */
function rectHitsOutline(r: Box, c: Box, pad = OUTLINE_PAD): boolean {
  const outer = { x: c.x - pad, y: c.y - pad, w: c.w + 2 * pad, h: c.h + 2 * pad };
  if (!rectsOverlap(r, outer)) return false;
  const inner = { x: c.x + pad, y: c.y + pad, w: c.w - 2 * pad, h: c.h - 2 * pad };
  const inside = r.x >= inner.x && r.y >= inner.y && r.x + r.w <= inner.x + inner.w && r.y + r.h <= inner.y + inner.h;
  return !inside;
}

/** Axis-aligned or diagonal segment vs rect (Liang–Barsky). */
export function segIntersectsRect(a: Point, b: Point, r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1
  );
}

/** Cells a box touches. Chips and leaves are small, so this stays small. */
export function boxCells(b: Box): string[] {
  const out: string[] = [];
  for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++)
    for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) out.push(`${cx},${cy}`);
  return out;
}

/**
 * Cells a segment passes through, by sampling every half cell along it —
 * O(length / CELL), whereas the bounding box of a long diagonal (polyline
 * routing) covers thousands of cells and made the pass take 11 s at 2k edges.
 */
export function segmentCells(a: Point, b: Point): string[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    seen.add(`${Math.floor((a.x + (b.x - a.x) * t) / CELL)},${Math.floor((a.y + (b.y - a.y) * t) / CELL)}`);
  }
  return [...seen];
}

class Grid<T> {
  private cells = new Map<string, T[]>();
  constructor(private cellsOf: (t: T) => Iterable<string>) {}
  add(t: T): void {
    for (const k of this.cellsOf(t)) {
      const arr = this.cells.get(k);
      if (arr) arr.push(t);
      else this.cells.set(k, [t]);
    }
  }
  near(b: Box): Set<T> {
    const out = new Set<T>();
    for (const k of boxCells(b)) for (const t of this.cells.get(k) ?? []) out.add(t);
    return out;
  }
}

function strips(c: Box, pad = OUTLINE_PAD): Strip[] {
  const t = 2 * pad;
  return [
    { box: c, strip: { x: c.x - pad, y: c.y - pad, w: c.w + t, h: t } },
    { box: c, strip: { x: c.x - pad, y: c.y + c.h - pad, w: c.w + t, h: t } },
    { box: c, strip: { x: c.x - pad, y: c.y - pad, w: t, h: c.h + t } },
    { box: c, strip: { x: c.x + c.w - pad, y: c.y - pad, w: t, h: c.h + t } },
  ];
}

const leafGrid = () => new Grid<Box>(boxCells);
const stripGrid = () => new Grid<Strip>((s) => boxCells(s.strip));
const segGrid = () => new Grid<Seg>((s) => segmentCells(s.a, s.b));

/** Points every STEP px along the polyline, plus the given preferred point. */
function candidates(points: Point[], margin: number): Point[] {
  const out: Point[] = [];
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lens.push(l);
    total += l;
  }
  if (total === 0) return [points[0]];
  const from = Math.min(margin, total / 2);
  const to = Math.max(from, total - margin);
  for (let d = from; d <= to + 1e-6; d += STEP) out.push(at(points, lens, d));
  out.push(at(points, lens, total / 2));
  return out;
}

function at(points: Point[], lens: number[], d: number): Point {
  let rem = d;
  for (let i = 0; i < lens.length; i++) {
    if (rem <= lens[i] || i === lens.length - 1) {
      const t = lens[i] === 0 ? 0 : Math.min(1, rem / lens[i]);
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    rem -= lens[i];
  }
  return points[points.length - 1];
}

export interface Placement {
  pos: Point;
  score: number;
}

/** Score one chip rect against everything except its own edge. */
export function scoreRect(
  r: Box,
  owner: string,
  leaves: Grid<Box>,
  outlines: Grid<Strip>,
  chips: Grid<Box>,
  segs: Grid<Seg>
): number {
  let s = 0;
  for (const b of leaves.near(r)) if (rectsOverlap(r, b)) s += PENALTY.leaf;
  const hit = new Set<Box>();
  for (const st of outlines.near(r)) if (!hit.has(st.box) && rectHitsOutline(r, st.box)) hit.add(st.box);
  s += hit.size * PENALTY.outline;
  for (const c of chips.near(r)) if (rectsOverlap(r, c)) s += PENALTY.chip;
  for (const g of segs.near(r)) if (g.owner !== owner && segIntersectsRect(g.a, g.b, r)) s += PENALTY.cross;
  return s;
}

/** Total collision penalty (no drift term) for given chip centres — for tests/metrics. */
export function collisionPenalty(edges: LabelInput[], obstacles: Obstacles, positions: ReadonlyMap<string, Point>): number {
  const leaves = leafGrid();
  const outlines = stripGrid();
  const segs = segGrid();
  const none = leafGrid();
  for (const b of obstacles.leaves) leaves.add(b);
  for (const c of obstacles.containers) for (const st of strips(c)) outlines.add(st);
  for (const e of edges) for (let i = 1; i < e.points.length; i++) segs.add({ a: e.points[i - 1], b: e.points[i], owner: e.id });
  const rects = edges.filter((e) => positions.has(e.id)).map((e) => ({ e, r: centreRect(positions.get(e.id)!, e.w, e.h) }));
  let total = 0;
  for (const { e, r } of rects) total += scoreRect(r, e.id, leaves, outlines, none, segs);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i].r, rects[j].r)) total += PENALTY.chip;
  return total;
}

/**
 * Best chip centre per edge id. Edges are processed longest-first (they have
 * the most freedom and block the least); a placed chip becomes an obstacle
 * for the ones after it.
 */
export function placeLabels(edges: LabelInput[], obstacles: Obstacles): Map<string, Placement> {
  const leaves = leafGrid();
  const outlines = stripGrid();
  const chips = leafGrid();
  const segs = segGrid();
  for (const b of obstacles.leaves) leaves.add(b);
  for (const c of obstacles.containers) for (const st of strips(c)) outlines.add(st);
  const lengthOf = (e: LabelInput) => {
    let l = 0;
    for (let i = 1; i < e.points.length; i++) l += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].y - e.points[i - 1].y);
    return l;
  };
  for (const e of edges) for (let i = 1; i < e.points.length; i++) segs.add({ a: e.points[i - 1], b: e.points[i], owner: e.id });

  const out = new Map<string, Placement>();
  const order = [...edges].sort((p, q) => lengthOf(q) - lengthOf(p));
  for (const e of order) {
    if (e.points.length < 2) continue;
    const len = lengthOf(e);
    const margin = Math.max(e.w, e.h) / 2 + 8;
    const cands = candidates(e.points, margin);
    if (e.pos) cands.unshift(e.pos);
    let best: Placement | null = null;
    for (const c of cands) {
      const r = centreRect(c, e.w, e.h);
      let s = scoreRect(r, e.id, leaves, outlines, chips, segs);
      if (e.pos) s += (PENALTY.drift * Math.hypot(c.x - e.pos.x, c.y - e.pos.y)) / Math.max(len, 1);
      if (!best || s < best.score - 1e-9) best = { pos: c, score: s };
      if (s === 0) break; // ELK's own spot (or the first clean one) wins
    }
    if (best) {
      out.set(e.id, best);
      chips.add(centreRect(best.pos, e.w, e.h));
    }
  }
  return out;
}

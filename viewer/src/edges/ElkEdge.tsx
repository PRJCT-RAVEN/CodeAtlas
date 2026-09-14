// Custom React Flow edge that draws the polyline ELK routed (ROOT coords ==
// flow coords) instead of a bezier between handles, with the label chip at
// the position ELK reserved for it. Falls back to a bezier when a layout has
// no routing for the edge (e.g. rectpacked graphs never have edges anyway).

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { Point } from "../layout/elk";
import { useAtlas, edgeIsLit, edgeIsPainted } from "../store";

export type ElkEdgeData = {
  /**
   * The display edge's kind — the Key lists the kinds actually DRAWN. REQUIRED on purpose:
   * a test that the object carries it can only assert against an object the test itself
   * built, which is no assertion at all (the Key's own test hand-builds one). Making it
   * required moves the guarantee to the compiler, where dropping the field is an error
   * rather than a silently empty legend.
   */
  kind: string;
  /** How many source relations this edge stands for — the details panel orders by it. */
  count: number;
  points?: Point[];
  labelPos?: Point;
  label: string;
  color: string;
  dash?: string;
  width: number;
  inferred: boolean;
  delta?: "added" | "modified";
  /** Dense view: draw faint unless this edge touches the selected node. */
  faint?: boolean;
  /** Hairball view: draw NOTHING unless this edge touches the selected node (see LayoutMode.hairball). */
  hairball?: boolean;
  [key: string]: unknown;
};
export type ElkEdgeType = Edge<ElkEdgeData, "elk">;

const CORNER = 7;

/** Orthogonal polyline with rounded corners. */
export function orthoPath(pts: Point[], r = CORNER): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const d1 = { x: p1.x - p0.x, y: p1.y - p0.y };
    const d2 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const l1 = Math.hypot(d1.x, d1.y);
    const l2 = Math.hypot(d2.x, d2.y);
    if (l1 === 0 || l2 === 0) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: p1.x - (d1.x / l1) * rr, y: p1.y - (d1.y / l1) * rr };
    const b = { x: p1.x + (d2.x / l2) * rr, y: p1.y + (d2.y / l2) * rr };
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Point at half the arc length of a polyline (label fallback). */
export function midpoint(pts: Point[]): Point {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let rem = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (rem <= seg) {
      const t = seg === 0 ? 0 : rem / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    rem -= seg;
  }
  return pts[pts.length - 1];
}

/** The stroke colour a changed edge takes, or null when it did not change. */
export function edgeDeltaColor(d: Pick<ElkEdgeData, "delta"> | undefined): string | null {
  if (d?.delta === "added") return "var(--delta-added)";
  if (d?.delta === "modified") return "var(--delta-modified)";
  return null;
}

/**
 * The chip's classes. Pure and exported because the delta half is a RULE, not decoration:
 * any delta used to paint `delta-added` green, so an edge whose `count` changed read as new.
 * Amber is what "modified" means everywhere else (CLAUDE.md: green = added, amber = modified),
 * and inside JSX nothing could assert it.
 */
export function edgeChipClass(d: Pick<ElkEdgeData, "inferred" | "delta">): string {
  return (
    "edge-chip" +
    (d.inferred ? " inferred" : "") +
    (d.delta === "added" ? " delta-added" : d.delta === "modified" ? " delta-modified" : "")
  );
}

export function ElkEdge(props: EdgeProps<ElkEdgeType>) {
  const { id, data, markerEnd, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  // The selected node AND its subtree: clicking a container also expands it, and an
  // expanded container is not an edge endpoint any more — its children are. Matching the
  // id alone lit nothing in exactly the views that tell the user to select something.
  const litIds = useAtlas((s) => s.litIds);
  // `crossesSelection`, not "either end is in the selection": selecting a container lights
  // its whole subtree, so the latter made a top-level selection light the entire graph and
  // switched the hairball economies off (see store.ts). A newly-ADDED edge is always lit —
  // it is the one thing a delta view exists to show, and rare by definition.
  const lit = edgeIsLit(litIds, source, target, { faint: data?.faint, delta: data?.delta });
  // Past a certain density the faint cloud is not texture, it is 2 SVG paths x N edges of
  // paint on every pan (9,388 edges in the 100-bucket overview of a 10,000-table import:
  // 2.6 s). Draw nothing until the edge is traced — which is exactly what the status bar
  // tells the user to do, and the details panel lists the same edges with counts.
  if (!edgeIsPainted(litIds, source, target, data)) return null;
  let path: string;
  let lx: number;
  let ly: number;
  if (data?.points && data.points.length >= 2) {
    path = orthoPath(data.points);
    const m = data.labelPos ?? midpoint(data.points);
    lx = m.x;
    ly = m.y;
  } else {
    [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  }
  // A CHANGED edge takes the delta colour on its STROKE, not only on its chip. The chip is
  // suppressed in a dense view (`!faint` below) — and a dense view is the only place the
  // delta clause in `edgeIsLit` is reachable at all, since a plain view short-circuits on
  // `!faint` and lights everything. So carrying the delta on the chip alone meant the Key
  // showed a green and an amber swatch while the canvas drew two identical blue edges:
  // round 24 made a changed edge DRAWN without making it distinguishable.
  const color = edgeDeltaColor(data) ?? data?.color ?? "var(--edge-neutral)";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={lit ? markerEnd : undefined}
        style={{ stroke: color, strokeDasharray: data?.dash, strokeWidth: data?.width ?? 1.4, opacity: lit ? 1 : 0.12 }}
      />
      {/* …and its chip is shown even there: a delta edge is rare by definition, which is the
          same argument this file already makes for drawing one at all. */}
      {data?.label && lit && (!data?.faint || data?.delta) && (
        <EdgeLabelRenderer>
          <div
            className={edgeChipClass(data)}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            title={data.inferred ? "inferred by the author — not verified in code" : undefined}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

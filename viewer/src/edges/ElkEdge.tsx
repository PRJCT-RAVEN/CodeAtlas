// Custom React Flow edge that draws the polyline ELK routed (ROOT coords ==
// flow coords) instead of a bezier between handles, with the label chip at
// the position ELK reserved for it. Falls back to a bezier when a layout has
// no routing for the edge (e.g. rectpacked graphs never have edges anyway).

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { Point } from "../layout/elk";
import { useAtlas } from "../store";

export type ElkEdgeData = {
  points?: Point[];
  labelPos?: Point;
  label: string;
  color: string;
  dash?: string;
  width: number;
  inferred: boolean;
  delta?: "added";
  /** Dense view: draw faint unless this edge touches the selected node. */
  faint?: boolean;
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

export function ElkEdge(props: EdgeProps<ElkEdgeType>) {
  const { id, data, markerEnd, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const selected = useAtlas((s) => s.selected);
  const lit = !data?.faint || (selected !== null && (selected === source || selected === target));
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
  const color = data?.color ?? "var(--edge-neutral)";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={lit ? markerEnd : undefined}
        style={{ stroke: color, strokeDasharray: data?.dash, strokeWidth: data?.width ?? 1.4, opacity: lit ? 1 : 0.12 }}
      />
      {data?.label && lit && !data?.faint && (
        <EdgeLabelRenderer>
          <div
            className={"edge-chip" + (data.inferred ? " inferred" : "") + (data.delta ? " delta-added" : "")}
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

import { describe, it, expect } from "vitest";
import { layoutGraph, type DisplayNode } from "../src/layout/elk";
import { incrementalToggle, GAP } from "../src/layout/incremental";
import { autoCollapse } from "../src/ir/budget";
import { db } from "./budget.test";

type Box = { x: number; y: number; w: number; h: number };
function absBoxes(nodes: DisplayNode[]): Map<string, Box> {
  const abs = new Map<string, Box>();
  for (const n of nodes) {
    const p = n.parentId ? abs.get(n.parentId)! : { x: 0, y: 0 };
    abs.set(n.ir.id, { x: p.x + n.x, y: p.y + n.y, w: n.width, h: n.height });
  }
  return abs;
}
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function checkInvariants(nodes: DisplayNode[]) {
  // DFS order: every parent precedes its children
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.parentId) expect(seen.has(n.parentId), `${n.parentId} before ${n.ir.id}`).toBe(true);
    seen.add(n.ir.id);
  }
  // siblings never overlap; children stay inside their parent
  const abs = absBoxes(nodes);
  const byParent = new Map<string | undefined, DisplayNode[]>();
  for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
  for (const [pid, kids] of byParent) {
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++)
        expect(overlap(abs.get(kids[i].ir.id)!, abs.get(kids[j].ir.id)!), `${kids[i].ir.id} overlaps ${kids[j].ir.id}`).toBe(false);
    if (pid) {
      const p = abs.get(pid)!;
      for (const k of kids) {
        const b = abs.get(k.ir.id)!;
        expect(b.x >= p.x && b.y >= p.y && b.x + b.w <= p.x + p.w + 0.01 && b.y + b.h <= p.y + p.h + 0.01, `${k.ir.id} inside ${pid}`).toBe(true);
      }
    }
  }
}

describe("incremental relayout", () => {
  it("expands one table in place: subtree laid out, neighbours pushed, unrelated nodes untouched, routes kept", async () => {
    const g = db(3, 40, 10);
    const collapsed = new Set(autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 }).collapse);
    const full = await layoutGraph(g, collapsed);
    const target = "table:s1.t5";
    const after = new Set(collapsed);
    after.delete(target);
    const t0 = performance.now();
    const inc = await incrementalToggle(g, after, target, full);
    const ms = performance.now() - t0;
    expect(inc).not.toBeNull();
    const r = inc!;
    checkInvariants(r.nodes);
    expect(r.mode.incremental).toBe(true);
    // the table is now a container holding its 10 columns
    const c = r.nodes.find((n) => n.ir.id === target)!;
    expect(c.isContainer).toBe(true);
    expect(r.nodes.filter((n) => n.parentId === target).length).toBe(10);
    expect(c.width).toBeGreaterThan(full.nodes.find((n) => n.ir.id === target)!.width);
    // nodes in other schemas did not move at all
    const before = absBoxes(full.nodes);
    const now = absBoxes(r.nodes);
    for (const n of full.nodes) {
      if (n.ir.id.startsWith("table:s0") || n.ir.id.startsWith("table:s2")) expect(now.get(n.ir.id), n.ir.id).toEqual(before.get(n.ir.id));
    }
    // every edge is present; kept routes only join unmoved endpoints
    expect(r.edges.length).toBeGreaterThan(0);
    for (const e of r.edges) {
      if (!e.points) continue;
      const inSub = e.source.startsWith("column:s1.t5") && e.target.startsWith("column:s1.t5");
      if (inSub) continue;
      expect(now.get(e.source), e.id).toEqual(before.get(e.source));
      expect(now.get(e.target), e.id).toEqual(before.get(e.target));
    }
    console.log(`incremental expand of one table: ${Math.round(ms)} ms (full layout of the same view: ${full.nodes.length} nodes)`);
  });

  it("collapses back to a chip and can expand a nested container afterwards", async () => {
    const g = db(3, 40, 10);
    const collapsed = new Set(autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 }).collapse);
    const full = await layoutGraph(g, collapsed);
    const t = "table:s2.t7";
    const open = new Set(collapsed);
    open.delete(t);
    const a = (await incrementalToggle(g, open, t, full))!;
    const b = (await incrementalToggle(g, collapsed, t, a))!;
    checkInvariants(b.nodes);
    const chip = b.nodes.find((n) => n.ir.id === t)!;
    expect(chip.isContainer).toBe(false);
    expect(chip.collapsed).toBe(true);
    expect(b.nodes.some((n) => n.parentId === t)).toBe(false);
    // gaps are allowed, overlaps are not: expand a different table on top of that state
    const t2 = "table:s2.t8";
    const open2 = new Set(collapsed);
    open2.delete(t2);
    const c2 = (await incrementalToggle(g, open2, t2, b))!;
    checkInvariants(c2.nodes);
  });

  it("returns null for a node that is not visible and leaves prev untouched", async () => {
    const g = db(2, 5, 3);
    const collapsed = new Set(["schema:s0"]);
    const full = await layoutGraph(g, collapsed);
    const snapshot = JSON.stringify(full.nodes);
    expect(await incrementalToggle(g, collapsed, "table:s0.t1", full)).toBeNull();
    expect(JSON.stringify(full.nodes)).toBe(snapshot);
  });

  it("is much faster than a full relayout of a routed (non-dense) view", async () => {
    // 4 schemas × 90 tables, columns hidden: ~364 nodes, ~700 routed edges — the
    // expensive case (hierarchical orthogonal routing), unlike dense views where
    // ELK gets no edges and a full pass is already cheap.
    const g = db(4, 90, 10);
    const collapsed = new Set(g.nodes.filter((n) => n.kind === "table").map((n) => n.id));
    const top = await layoutGraph(g, collapsed);
    expect(top.mode.dense).toBe(false);
    const table = "table:s2.t5";
    const open = new Set(collapsed);
    open.delete(table);
    let t0 = performance.now();
    const full = await layoutGraph(g, open, { pinned: new Map(top.nodes.map((n) => [n.ir.id, { x: n.x, y: n.y }])) });
    const fullMs = performance.now() - t0;
    t0 = performance.now();
    const inc = (await incrementalToggle(g, open, table, top))!;
    const incMs = performance.now() - t0;
    checkInvariants(inc.nodes);
    expect(inc.nodes.length).toBe(full.nodes.length);
    console.log(`expand one table in a ${top.nodes.length}-node routed view: full ${Math.round(fullMs)} ms → incremental ${Math.round(incMs)} ms`);
    expect(incMs * 3).toBeLessThan(fullMs);
    const schema = table;
    // siblings of the schema kept their positions unless they had to move
    const before = absBoxes(top.nodes);
    const now = absBoxes(inc.nodes);
    let kept = 0;
    for (const n of top.nodes) if (n.ir.id !== schema && JSON.stringify(now.get(n.ir.id)) === JSON.stringify(before.get(n.ir.id))) kept++;
    expect(kept).toBeGreaterThan(20);
    expect(GAP).toBeGreaterThan(0);
  }, 120_000);
});

describe("stale base (a second toggle landed while a pass was pending)", () => {
  it("refuses to splice one toggle onto a base that is two toggles behind", async () => {
    const g = db(3, 40, 10);
    const c0 = new Set(autoCollapse(g, new Set(), { maxVisible: 200, maxEdges: 10_000 }).collapse);
    const layout0 = await layoutGraph(g, c0);
    const c2 = new Set(c0);
    c2.delete("table:s1.t5");
    c2.delete("table:s1.t7");
    expect(await incrementalToggle(g, c2, "table:s1.t7", layout0)).toBeNull(); // App falls back to a full pass
    // and the honest one-toggle case still works
    const c1 = new Set(c0);
    c1.delete("table:s1.t7");
    expect(await incrementalToggle(g, c1, "table:s1.t7", layout0)).not.toBeNull();
  });
});

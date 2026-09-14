import { describe, it, expect } from "vitest";
import { incrementalEligible, INCREMENTAL_MIN_MS, INCREMENTAL_MIN_NODES, INCREMENTAL_MIN_VISIBLE } from "../src/App";
import { layoutGraph, type DisplayNode } from "../src/layout/elk";
import { childIndex, incrementalToggle, GAP } from "../src/layout/incremental";
import type { GraphIR } from "../src/ir/types";
import { db } from "./fixtures";

type Box = { x: number; y: number; w: number; h: number };
function absBoxes(nodes: DisplayNode[]): Map<string, Box> {
  const abs = new Map<string, Box>();
  for (const n of nodes) {
    const p = n.parentId ? abs.get(n.parentId)! : { x: 0, y: 0 };
    abs.set(n.ir.id, { x: p.x + n.x, y: p.y + n.y, w: n.width, h: n.height });
  }
  return abs;
}
/** The state these tests start from: schemas open, every table a chip. Spelled
 *  out rather than taken from the visibility budget, whose policy is free to
 *  change without invalidating what incremental relayout must do. */
const allTables = (g: GraphIR) => new Set(g.nodes.filter((n) => n.kind === "table").map((n) => n.id));

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
    const collapsed = allTables(g);
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
    const collapsed = allTables(g);
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

describe("childIndex", () => {
  const wide = (children: number): GraphIR => {
    const nodes: GraphIR["nodes"] = [
      { id: "table:t", kind: "table", name: "t" },
      { id: "table:other", kind: "table", name: "other", parent: "table:t" },
    ];
    for (let i = 0; i < children; i++) nodes.push({ id: `column:c${i}`, kind: "column", name: `c${i}`, parent: "table:t" });
    return { irVersion: "0.2", generator: { tool: "test", version: "0", commit: null }, root: "table:t", nodes, edges: [] } as GraphIR;
  };

  it("groups children by parent in ir.nodes order", () => {
    const kids = childIndex(wide(3));
    expect(kids.get("table:t")).toEqual(["table:other", "column:c0", "column:c1", "column:c2"]);
    expect(kids.get("column:c0")).toBeUndefined();
  });

  it("stays linear in a wide container instead of copying every sibling array", () => {
    const g = wide(20_000);
    // what the toggle used to do on the way to laying out a subtree
    let t0 = performance.now();
    const copied = new Map<string, string[]>();
    for (const n of g.nodes) if (n.parent) copied.set(n.parent, [...(copied.get(n.parent) ?? []), n.id]);
    const copyMs = performance.now() - t0;
    t0 = performance.now();
    const kids = childIndex(g);
    const pushMs = performance.now() - t0;
    expect(kids.get("table:t")).toEqual(copied.get("table:t"));
    console.log(`childIndex over ${g.nodes.length} nodes in one container: copying ${Math.round(copyMs)} ms → appending ${Math.round(pushMs)} ms`);
    expect(pushMs * 10).toBeLessThan(copyMs);
  });
});

describe("stale base (a second toggle landed while a pass was pending)", () => {
  it("refuses to splice one toggle onto a base that is two toggles behind", async () => {
    const g = db(3, 40, 10);
    const c0 = allTables(g);
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

// An expand that makes a view NEWLY dense must switch the paint economies on immediately,
// not at the next "Tidy". `hairball = dense && …`, so recomputing only `hairball` while
// carrying `dense` left both false: one click on a 302-node view drew 6,000 SVG paths and
// 3,000 chips and took a pan from 220 ms to 3,048 ms.
//
// This test exists because mutating BOTH recomputations out of `incremental.ts` left the
// whole suite green — no fixture could make an expand cross DENSE_RATIO, since every
// `db()` graph sits at exactly 2.0 edges per node.
describe("a splice recomputes the paint economies", () => {
  /** `dir:a` (collapsed) and `dir:b`, with `refs` cross edges per leaf of a. */
  function crossing(leaves: number, refs: number): GraphIR {
    const nodes: GraphIR["nodes"] = [
      { id: "dir:.", kind: "dir", name: "r" },
      { id: "dir:a", kind: "dir", name: "a", parent: "dir:." },
      { id: "dir:b", kind: "dir", name: "b", parent: "dir:." },
    ];
    const edges: GraphIR["edges"] = [];
    const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
    add("contains", "dir:.", "dir:a");
    add("contains", "dir:.", "dir:b");
    const A: string[] = [];
    const B: string[] = [];
    for (const [d, arr] of [["dir:a", A], ["dir:b", B]] as const)
      for (let i = 0; i < leaves; i++) {
        const id = `doc:${d.slice(4)}/f${String(i).padStart(4, "0")}`;
        nodes.push({ id, kind: "doc", name: `f${i}`, parent: d });
        add("contains", d, id);
        arr.push(id);
      }
    for (let i = 0; i < A.length; i++)
      for (let r = 1; r <= refs; r++) add("references", A[i], B[(i * 7919 + r * 104729) % B.length]);
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
  }

  it("flips dense AND hairball on, and back off on collapse", async () => {
    const g = crossing(150, 10);
    const collapsed = new Set(["dir:a"]);
    const before = await layoutGraph(g, collapsed);
    expect(before.mode.dense, "not dense while `a` is a chip").toBe(false);
    expect(before.mode.hairball).toBe(false);

    const expanded = new Set<string>();
    const spliced = await incrementalToggle(g, expanded, "dir:a", before, {});
    expect(spliced, "the splice must apply").not.toBeNull();
    const full = await layoutGraph(g, expanded);
    expect(full.mode.dense, "the expanded view really is dense").toBe(true);
    expect(full.mode.hairball).toBe(true);
    expect(spliced!.mode.dense, "the splice must agree with a full pass").toBe(true);
    expect(spliced!.mode.hairball).toBe(true);

    // …and collapsing again turns them back off
    const back = await incrementalToggle(g, collapsed, "dir:a", spliced!, {});
    expect(back, "the collapse must apply").not.toBeNull();
    expect(back!.mode.dense).toBe(false);
    expect(back!.mode.hairball).toBe(false);
  });
});

// Pattern (e): the incremental path's own gate shipped through two rounds of fixes with no
// coverage at all, because the decision lived inline in a `useEffect`. It is a pure
// function now, and these are the three thresholds it is made of.
describe("choosing the incremental path", () => {
  const ready = true;
  const big = { fullMs: 1000, visible: 500 };
  it("takes it when the last full pass was expensive AND the view is worth approximating", () => {
    expect(incrementalEligible(big, ready, null)).toBe(true);
    // slow but small: a full pass over 18 nodes is cheap by definition, and the
    // approximation costs routed edges. One cold measurement used to downgrade every
    // later toggle of that diagram until "Tidy".
    expect(incrementalEligible({ fullMs: 1000, visible: 18 }, ready, null)).toBe(false);
    expect(incrementalEligible({ fullMs: 1000, visible: INCREMENTAL_MIN_VISIBLE - 1 }, ready, null)).toBe(false);
    expect(incrementalEligible({ fullMs: 1000, visible: INCREMENTAL_MIN_VISIBLE }, ready, null)).toBe(true);
  });
  it("…or when the view alone is big enough, however fast the last pass was", () => {
    expect(incrementalEligible({ fullMs: 5, visible: INCREMENTAL_MIN_NODES + 1 }, ready, null)).toBe(true);
    expect(incrementalEligible({ fullMs: 5, visible: INCREMENTAL_MIN_NODES }, ready, null)).toBe(false);
    expect(incrementalEligible({ fullMs: INCREMENTAL_MIN_MS, visible: 200 }, ready, null)).toBe(false);
    expect(incrementalEligible({ fullMs: INCREMENTAL_MIN_MS + 1, visible: 200 }, ready, null)).toBe(true);
  });
  it("?incremental= overrides the cost thresholds but never the structural half", () => {
    expect(incrementalEligible({ fullMs: 5, visible: 3 }, ready, "1")).toBe(true);
    expect(incrementalEligible(big, ready, "0")).toBe(false);
    // nothing to splice a toggle onto: no previous layout, or not one toggle away from it
    expect(incrementalEligible(null, ready, "1")).toBe(false);
    expect(incrementalEligible(big, false, "1")).toBe(false);
  });
});

// The mini graph is built from a SUBSET of the ir, and `groupingSkip` derives its answer
// from the graph it is handed — so the subset has to preserve every input the rule reads.
describe("the mini graph gets the same answer as the parent", () => {
  /** `package > module > dir > file > function`, with the imports LEAVING module:a. */
  const deep = (dirs: number, filesPer: number, outward: boolean): GraphIR => {
    const nodes: GraphIR["nodes"] = [{ id: "package:p", kind: "package", name: "p" }];
    const edges: GraphIR["edges"] = [];
    const add = (k: string, f: string, t: string) => edges.push({ id: `e:${k}:${f}->${t}`, kind: k, from: f, to: t });
    const files: Record<string, string[]> = { "module:a": [], "module:b": [] };
    for (const m of ["module:a", "module:b"]) {
      nodes.push({ id: m, kind: "module", name: m, parent: "package:p" });
      add("contains", "package:p", m);
      for (let d = 0; d < dirs; d++) {
        const did = `module:${m.slice(7)}/d${d}`;
        nodes.push({ id: did, kind: "module", name: `d${d}`, parent: m });
        add("contains", m, did);
        for (let i = 0; i < filesPer; i++) {
          const fid = `file:${m.slice(7)}/d${d}/f${i}.ts`;
          nodes.push({ id: fid, kind: "file", name: `f${i}`, parent: did });
          add("contains", did, fid);
          files[m].push(fid);
          for (let j = 0; j < 4; j++) {
            nodes.push({ id: `function:${fid.slice(5)}:fn${j}`, kind: "function", name: `fn${j}`, parent: fid });
            add("contains", fid, `function:${fid.slice(5)}:fn${j}`);
          }
        }
      }
    }
    for (let i = 0; i < files["module:a"].length; i++)
      add("imports", files["module:a"][i], outward ? files["module:b"][i] : files["module:a"][(i + 1) % files["module:a"].length]);
    const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    nodes.sort(cmp);
    edges.sort(cmp);
    return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "package:p", nodes, edges } as GraphIR;
  };

  it("splices a subtree whose edges LEAVE it — the case the path exists for", async () => {
    // With the mini's edge list filtered by `&&`, a file whose only imports cross the
    // boundary was an endpoint in the parent and not one in the mini, so the mini elided it
    // and the count check refused the splice. Permanently, and on exactly the expensive
    // views: cross-container edges are what make a layout slow.
    for (const outward of [true, false]) {
      const g = deep(8, 10, outward);
      const base = await layoutGraph(g, new Set(["module:a"]), {});
      const r = await incrementalToggle(g, new Set(), "module:a", base, {});
      expect(r, `outward=${outward}`).not.toBeNull();
      expect(r!.nodes.length).toBeGreaterThan(base.nodes.length);
    }
  }, 300000);
});

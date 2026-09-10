// Round 3 (2026-08-27 audit): routed edges, ELK-placed labels, self-loops,
// leaf `file` nodes, collapsed-chip widths, attrs.scale, pinned stability.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutGraph, layoutTier, collapsedWidth, leafWidth, labelWidth, edgeKey, type DisplayNode } from "../src/layout/elk";
import { db } from "./budget.test";
import { placeLabels, collisionPenalty, segmentCells, CELL, PENALTY } from "../src/layout/labels";
import { orthoPath, midpoint } from "../src/edges/ElkEdge";
import type { GraphIR } from "../src/ir/types";

const here = dirname(fileURLToPath(import.meta.url));
const sample: GraphIR = JSON.parse(readFileSync(join(here, "../public/sample-graph.json"), "utf8"));
const dfd: GraphIR = JSON.parse(
  readFileSync(join(here, "../../docs/examples/order-pipeline.graph.json"), "utf8")
);

function absBoxes(nodes: DisplayNode[]) {
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    const p = n.parentId ? abs.get(n.parentId)! : { x: 0, y: 0 };
    abs.set(n.ir.id, { x: p.x + n.x, y: p.y + n.y, w: n.width, h: n.height });
  }
  return abs;
}

const near = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }, tol = 2) =>
  p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;

describe("routed edges (ELK sections in ROOT coordinates)", () => {
  it("gives every edge a polyline whose ends touch its endpoint boxes, across hierarchy levels", async () => {
    const { nodes, edges } = await layoutGraph(dfd, new Set());
    const abs = absBoxes(nodes);
    expect(edges.length).toBeGreaterThan(10);
    for (const e of edges) {
      expect(e.points, e.id).toBeDefined();
      const pts = e.points!;
      expect(pts.length).toBeGreaterThanOrEqual(2);
      // drawn order is authored order: first point on the source, last on the target
      expect(near(pts[0], abs.get(e.source)!), `${e.id} start on source`).toBe(true);
      expect(near(pts[pts.length - 1], abs.get(e.target)!), `${e.id} end on target`).toBe(true);
    }
  });

  it("routes orthogonally (every segment is axis-aligned)", async () => {
    const { edges } = await layoutGraph(sample, new Set());
    for (const e of edges) {
      const pts = e.points!;
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i].x - pts[i - 1].x);
        const dy = Math.abs(pts[i].y - pts[i - 1].y);
        expect(Math.min(dx, dy), `${e.id} segment ${i}`).toBeLessThan(0.01);
      }
    }
  });

  it("places a label for every edge close to its own path and clear of every node box", async () => {
    const { nodes, edges } = await layoutGraph(dfd, new Set());
    const abs = absBoxes(nodes);
    const leaves = nodes.filter((n) => !n.isContainer).map((n) => abs.get(n.ir.id)!);
    for (const e of edges) {
      expect(e.labelPos, e.id).toBeDefined();
      const l = e.labelPos!;
      // within a chip-height of the polyline
      const pts = e.points!;
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const t = Math.max(0, Math.min(1, ((l.x - a.x) * (b.x - a.x) + (l.y - a.y) * (b.y - a.y)) / (Math.hypot(b.x - a.x, b.y - a.y) ** 2 || 1)));
        best = Math.min(best, Math.hypot(l.x - (a.x + (b.x - a.x) * t), l.y - (a.y + (b.y - a.y) * t)));
      }
      expect(best, `${e.id} label distance`).toBeLessThan(24);
      // no leaf pill under the chip centre
      for (const box of leaves) expect(near(l, box, -1), `${e.id} label on a leaf`).toBe(false);
    }
  });

  it("keeps the arrow reader → source for read-family edges while ELK laid the source above", async () => {
    const { nodes, edges } = await layoutGraph(dfd, new Set());
    const abs = absBoxes(nodes);
    const reads = edges.filter((e) => e.reversed);
    expect(reads.length).toBeGreaterThan(0);
    for (const e of reads) {
      const s = abs.get(e.source)!; // reader
      const t = abs.get(e.target)!; // data source
      expect(t.y + t.h, `${e.id} source above reader`).toBeLessThanOrEqual(s.y + 1);
      expect(near(e.points![0], s), `${e.id} polyline starts at reader`).toBe(true);
    }
  });
});

function tiny(extra: Partial<GraphIR> = {}): GraphIR {
  return {
    irVersion: "0.2",
    generator: { tool: "test", version: "0", commit: null },
    root: "view:t",
    nodes: [
      { id: "view:t", kind: "view", name: "t" },
      { id: "step:a", kind: "step", name: "a", parent: "view:t" },
      { id: "step:b", kind: "step", name: "b", parent: "view:t" },
    ],
    edges: [
      { id: "e:contains:view:t->step:a", kind: "contains", from: "view:t", to: "step:a" },
      { id: "e:contains:view:t->step:b", kind: "contains", from: "view:t", to: "step:b" },
      { id: "e:calls:step:a->step:b", kind: "calls", from: "step:a", to: "step:b" },
    ],
    ...extra,
  } as GraphIR;
}

describe("self-loops and leaf files", () => {
  it("keeps an authored self-loop and routes it", async () => {
    const g = tiny();
    g.edges.push({ id: "e:calls:step:a->step:a", kind: "calls", from: "step:a", to: "step:a" });
    const { edges } = await layoutGraph(g, new Set());
    const loop = edges.find((e) => e.selfLoop);
    expect(loop).toBeDefined();
    expect(loop!.source).toBe("step:a");
    expect(loop!.points?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("still drops edges that collapse onto one node", async () => {
    const collapsed = new Set(["type:MediumCore/EventBus"]);
    const { edges } = await layoutGraph(sample, collapsed);
    expect(edges.some((e) => e.source === e.target)).toBe(false);
  });

  it("draws a leaf `file` node in a conceptual view but hides grouping files", async () => {
    const g = tiny();
    g.nodes.push({ id: "file:cfg", kind: "file", name: "config.json", parent: "view:t" });
    g.edges.push(
      { id: "e:contains:view:t->file:cfg", kind: "contains", from: "view:t", to: "file:cfg" },
      { id: "e:reads:step:a->file:cfg", kind: "reads", from: "step:a", to: "file:cfg" }
    );
    const { nodes, edges } = await layoutGraph(g, new Set());
    expect(nodes.some((n) => n.ir.id === "file:cfg")).toBe(true);
    expect(edges.some((e) => e.target === "file:cfg")).toBe(true);
    // structural output: files group types → hidden, types hang under the module
    const { nodes: sn } = await layoutGraph(sample, new Set());
    expect(sn.some((n) => n.ir.kind === "file")).toBe(false);
  });
});

describe("sizing", () => {
  it("sizes a collapsed container for its '+ BADGE name' chip, wider than a leaf estimate", () => {
    const n = { id: "x", kind: "type", name: "InMemoryRepository", attrs: { typeKind: "actor" } };
    expect(collapsedWidth(n)).toBeGreaterThan(leafWidth(n));
    expect(collapsedWidth(n)).toBeGreaterThanOrEqual("+ ACTOR".length * 7.4 + "InMemoryRepository".length * 7.6 + 40);
  });

  it("applies attrs.scale to leaf width and height, clamped to [1,3]", async () => {
    const g = tiny();
    g.nodes[1].attrs = { scale: 2 };
    g.nodes[2].attrs = { scale: 99 };
    const { nodes } = await layoutGraph(g, new Set());
    const a = nodes.find((n) => n.ir.id === "step:a")!;
    const b = nodes.find((n) => n.ir.id === "step:b")!;
    expect(a.height).toBe(80);
    expect(a.width).toBe(leafWidth({ ...g.nodes[1], attrs: {} }) * 2);
    expect(b.height).toBe(120);
  });

  it("never renders an expanded container narrower than its title chip", async () => {
    const g = tiny();
    g.nodes[1].name = "a very long stage name that would be clipped by a narrow container";
    g.nodes.push({ id: "step:a1", kind: "step", name: "x", parent: "step:a" });
    g.edges.push({ id: "e:contains:step:a->step:a1", kind: "contains", from: "step:a", to: "step:a1" });
    const { nodes } = await layoutGraph(g, new Set());
    const a = nodes.find((n) => n.ir.id === "step:a")!;
    expect(a.isContainer).toBe(true);
    expect(a.width).toBeGreaterThan(g.nodes[1].name.length * 7);
  });
});

describe("pinned positions (spec N3 stability)", () => {
  it("honours the pinned sibling order (permuted) when a node is added to a laid-out view", async () => {
    const g = tiny();
    // a → {b,c,d,e,f}: six leaves in one layer under a
    const leaves = ["b", "c", "d", "e", "f"];
    for (const id of ["c", "d", "e", "f"]) {
      g.nodes.push({ id: `step:${id}`, kind: "step", name: id, parent: "view:t" });
      g.edges.push({ id: `e:contains:view:t->step:${id}`, kind: "contains", from: "view:t", to: `step:${id}` });
    }
    for (const id of ["c", "d", "e", "f"])
      g.edges.push({ id: `e:calls:step:a->step:${id}`, kind: "calls", from: "step:a", to: `step:${id}` });
    const first = await layoutGraph(g, new Set());
    const byX = (ns: typeof first.nodes) =>
      ns.filter((n) => leaves.includes(n.ir.id.slice(5))).sort((p, q) => p.x - q.x).map((n) => n.ir.id);
    const natural = byX(first.nodes);
    // pin the leaves in the REVERSE of ELK's natural order (as if the user's
    // previous view had them that way); a plain relayout would restore `natural`
    const xs = first.nodes.filter((n) => leaves.includes(n.ir.id.slice(5))).map((n) => n.x).sort((p, q) => p - q);
    const pinned = new Map(first.nodes.map((n) => [n.ir.id, { x: n.x, y: n.y }]));
    natural.forEach((id, i) => pinned.set(id, { x: xs[xs.length - 1 - i], y: pinned.get(id)!.y }));

    g.nodes.push({ id: "step:z", kind: "step", name: "z", parent: "view:t" });
    g.edges.push({ id: "e:contains:view:t->step:z", kind: "contains", from: "view:t", to: "step:z" });
    g.edges.push({ id: "e:calls:step:a->step:z", kind: "calls", from: "step:a", to: "step:z" });
    const second = await layoutGraph(g, new Set(), { pinned });
    expect(byX(second.nodes)).toEqual([...natural].reverse());
    // and without pins the natural order comes back — proves the pins did it
    const third = await layoutGraph(g, new Set());
    expect(byX(third.nodes)).toEqual(natural);
  });

  it("does not switch to interactive mode when fewer than half the nodes are pinned", async () => {
    const g = tiny();
    const pinned = new Map([["step:a", { x: 5000, y: 5000 }]]);
    const { nodes } = await layoutGraph(g, new Set(), { pinned });
    // a would be dragged to 5000 only in interactive mode — layered ignores the hint
    const a = nodes.find((n) => n.ir.id === "step:a")!;
    expect(a.x).toBeLessThan(1000);
  });
});

describe("edge path helpers", () => {
  it("orthoPath rounds corners and starts/ends exactly on the endpoints", () => {
    const d = orthoPath([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 80, y: 50 },
    ]);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d.endsWith("L 80 50")).toBe(true);
    expect(d).toContain("Q 0 50");
  });
  it("midpoint is at half the arc length", () => {
    expect(midpoint([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }])).toEqual({ x: 0, y: 10 });
  });
});

describe("review fixes (2026-09-05)", () => {
  it("never merges distinct edges whose ids happen to contain '|'", async () => {
    const g = tiny();
    g.nodes.push(
      { id: "step:a|b", kind: "step", name: "ab", parent: "view:t" },
      { id: "step:b|c", kind: "step", name: "bc", parent: "view:t" },
      { id: "step:c", kind: "step", name: "c", parent: "view:t" }
    );
    for (const id of ["step:a|b", "step:b|c", "step:c"])
      g.edges.push({ id: `e:contains:view:t->${id}`, kind: "contains", from: "view:t", to: id });
    g.edges.push(
      { id: "e:calls:step:a|b->step:c", kind: "calls", from: "step:a|b", to: "step:c" },
      { id: "e:calls:step:a->step:b|c", kind: "calls", from: "step:a", to: "step:b|c" }
    );
    const { edges } = await layoutGraph(g, new Set());
    expect(edges.filter((e) => e.kind === "calls").length).toBe(3);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
    expect(edgeKey("calls", "a|b", "c")).not.toBe(edgeKey("calls", "a", "b|c"));
  });

  it("reverses the `feedback: true` edge of a cycle, keeping the mainline flowing down", async () => {
    const { nodes } = await layoutGraph(dfd, new Set());
    const abs = absBoxes(nodes);
    const intake = abs.get("stage:intake")!;
    const fulfilment = abs.get("stage:fulfilment")!;
    const notify = abs.get("stage:notify")!;
    expect(intake.y + intake.h).toBeLessThanOrEqual(fulfilment.y + 1);
    expect(fulfilment.y + fulfilment.h).toBeLessThanOrEqual(notify.y + 1);
  });
});

describe("label placement pass 2 (chips slide along their own path)", () => {
  const chipRect = (e: { labelPos?: { x: number; y: number }; label: string }) => {
    const w = labelWidth(e.label);
    return { x: e.labelPos!.x - w / 2, y: e.labelPos!.y - 9, w, h: 18 };
  };
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  for (const [name, graph] of [
    ["dfd example", dfd],
    ["sample (structural)", sample],
  ] as const) {
    it(`${name}: no chip on a node, none across a container outline, no two chips overlapping`, async () => {
      const { nodes, edges } = await layoutGraph(graph, new Set());
      const abs = absBoxes(nodes);
      const leaves = nodes.filter((n) => !n.isContainer).map((n) => abs.get(n.ir.id)!);
      const containers = nodes.filter((n) => n.isContainer).map((n) => abs.get(n.ir.id)!);
      const rects = edges.map((e) => ({ id: e.id, r: chipRect(e) }));
      for (const { id, r } of rects) {
        for (const b of leaves) expect(overlap(r, b), `${id} chip on a node`).toBe(false);
        for (const c of containers) {
          const pad = 4;
          const outer = { x: c.x - pad, y: c.y - pad, w: c.w + 2 * pad, h: c.h + 2 * pad };
          const inner = { x: c.x + pad, y: c.y + pad, w: c.w - 2 * pad, h: c.h - 2 * pad };
          const inside = r.x >= inner.x && r.y >= inner.y && r.x + r.w <= inner.x + inner.w && r.y + r.h <= inner.y + inner.h;
          expect(overlap(r, outer) && !inside, `${id} chip across a container outline`).toBe(false);
        }
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          expect(overlap(rects[i].r, rects[j].r), `${rects[i].id} overlaps ${rects[j].id}`).toBe(false);
    });
  }

  it("prefers ELK's spot when it is clean and otherwise stays on the polyline", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 200 },
      { x: 300, y: 200 },
    ];
    const clean = placeLabels([{ id: "a", points: pts, w: 40, h: 18, pos: { x: 0, y: 100 } }], { leaves: [], containers: [] });
    expect(clean.get("a")!.pos).toEqual({ x: 0, y: 100 });
    // a leaf sitting on ELK's spot pushes the chip along the same path
    const blocked = placeLabels([{ id: "a", points: pts, w: 40, h: 18, pos: { x: 0, y: 100 } }], {
      leaves: [{ x: -30, y: 80, w: 60, h: 40 }],
      containers: [],
    });
    const p = blocked.get("a")!;
    expect(p.score).toBeLessThan(PENALTY.leaf);
    const onPath = (Math.abs(p.pos.x) < 1e-6 && p.pos.y >= 0 && p.pos.y <= 200) || (Math.abs(p.pos.y - 200) < 1e-6 && p.pos.x >= 0 && p.pos.x <= 300);
    expect(onPath).toBe(true);
  });
});

describe("label pass on a dense graph", () => {
  function dense(n: number): GraphIR {
    const modules = Math.max(2, Math.round(Math.sqrt(n) / 2));
    const nodes: GraphIR["nodes"] = [{ id: "package:P", kind: "package", name: "P" }];
    const edges: GraphIR["edges"] = [];
    const add = (kind: string, from: string, to: string) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
    const types: string[] = [];
    for (let m = 0; m < modules; m++) {
      const mid = `module:M${m}`;
      nodes.push({ id: mid, kind: "module", name: `M${m}`, parent: "package:P" });
      add("contains", "package:P", mid);
      const typesHere = Math.max(1, Math.floor((n - 1 - modules) / modules / 5));
      for (let t = 0; t < typesHere; t++) {
        const tid = `type:M${m}/T${t}`;
        nodes.push({ id: tid, kind: "type", name: `T${t}`, parent: mid });
        add("contains", mid, tid);
        types.push(tid);
        for (let f = 0; f < 4; f++) {
          const fid = `func:M${m}/T${t}.f${f}()`;
          nodes.push({ id: fid, kind: "function", name: `f${f}()`, parent: tid });
          add("contains", tid, fid);
          if (f > 0) add("calls", `func:M${m}/T${t}.f${f - 1}()`, fid);
        }
      }
    }
    for (let i = 1; i < types.length; i++) {
      add("calls", `func:${types[i].slice(5)}.f3()`, `func:${types[(i * 7) % i].slice(5)}.f0()`);
      add("reads", `func:${types[i].slice(5)}.f1()`, `func:${types[(i * 3) % i].slice(5)}.f2()`);
    }
    return { irVersion: "0.2", generator: { tool: "test", version: "0", commit: null }, root: "package:P", nodes, edges } as GraphIR;
  }

  it("never increases the collision penalty and reduces it where ELK left collisions", async () => {
    const g = dense(300);
    const raw = await layoutGraph(g, new Set(), { labelPass: false });
    const fixed = await layoutGraph(g, new Set(), { labelPass: true });
    const abs = absBoxes(raw.nodes);
    const leaves = raw.nodes.filter((n) => !n.isContainer).map((n) => abs.get(n.ir.id)!);
    const containers = raw.nodes.filter((n) => n.isContainer).map((n) => abs.get(n.ir.id)!);
    const inputs = raw.edges.filter((e) => e.points).map((e) => ({ id: e.id, points: e.points!, w: labelWidth(e.label), h: 18 }));
    const before = collisionPenalty(inputs, { leaves, containers }, new Map(raw.edges.map((e) => [e.id, e.labelPos!])));
    const after = collisionPenalty(inputs, { leaves, containers }, new Map(fixed.edges.map((e) => [e.id, e.labelPos!])));
    const moved = fixed.edges.filter((e, i) => e.labelPos!.x !== raw.edges[i].labelPos!.x || e.labelPos!.y !== raw.edges[i].labelPos!.y).length;
    console.log(`dense(300): ${raw.edges.length} edges, penalty ${before} → ${after}, chips moved ${moved}`);
    // the metric itself sees collisions: every chip parked on the first leaf
    const parked = new Map(raw.edges.map((e) => [e.id, { x: leaves[0].x + leaves[0].w / 2, y: leaves[0].y + leaves[0].h / 2 }]));
    expect(collisionPenalty(inputs, { leaves, containers }, parked)).toBeGreaterThan(PENALTY.leaf * raw.edges.length);
    for (const e of raw.edges) expect(e.labelPos, e.id).toBeDefined();
    expect(after).toBeLessThanOrEqual(before);
    if (before > 0) {
      expect(after).toBeLessThan(before);
      expect(moved).toBeGreaterThan(0);
    }
  });
});

describe("label grid indexing stays linear in segment length", () => {
  it("a long diagonal segment touches O(length / CELL) cells, not its bounding box", () => {
    const cells = segmentCells({ x: 0, y: 0 }, { x: 20000, y: 3000 });
    expect(cells.length).toBeLessThan(((20000 + 3000) / (CELL / 2)) + 3);
    expect(cells).toContain("0,0");
    expect(cells).toContain(`${Math.floor(20000 / CELL)},${Math.floor(3000 / CELL)}`);
    // the bounding-box approach would have needed this many
    expect(cells.length * 10).toBeLessThan((20000 / CELL) * (3000 / CELL));
  });
});

describe("dense and heavy views", () => {
  it("reports the mode and gives ELK no edges when the view is dense", async () => {
    // 40 schema chips referencing each other every which way → dense
    const g = db(40, 6, 3);
    const collapsed = new Set(g.nodes.filter((n) => n.kind === "schema").map((n) => n.id));
    const { nodes, edges, mode } = await layoutGraph(g, collapsed);
    expect(nodes.length).toBe(40);
    expect(edges.length).toBeGreaterThan(3 * 40);
    expect(mode).toEqual({ tier: layoutTier(40, edges.length), dense: true, heavy: true });
    expect(edges.every((e) => e.points === undefined)).toBe(true); // drawn as curves by the edge component
    // and the chips fold into rows instead of a 40-deep chain
    expect(new Set(nodes.map((n) => Math.round(n.y))).size).toBeLessThan(12);
  });
  it("keeps routing and routed intra-container edges for a big but not dense view", async () => {
    const g = db(2, 60, 2); // 120 tables, ~2 edges per table
    const collapsed = new Set(g.nodes.filter((n) => n.kind === "table").map((n) => n.id));
    const { edges, mode } = await layoutGraph(g, collapsed);
    expect(mode.dense).toBe(false);
    expect(edges.some((e) => e.points && e.points.length >= 2)).toBe(true);
  });
  it("small views are untouched: quality tier, everything routed", async () => {
    const { edges, mode } = await layoutGraph(dfd, new Set());
    expect(mode).toEqual({ tier: "quality", dense: false, heavy: false });
    expect(edges.every((e) => e.points && e.points.length >= 2)).toBe(true);
  });
});

describe("wide layering applies to edge-less siblings only", () => {
  it("a hub with 15 targets stays one row below the hub; 40 isolated siblings fold into rows", async () => {
    const hub = tiny();
    for (let i = 0; i < 15; i++) {
      hub.nodes.push({ id: `step:t${i}`, kind: "step", name: `t${i}`, parent: "view:t" });
      hub.edges.push({ id: `e:contains:view:t->step:t${i}`, kind: "contains", from: "view:t", to: `step:t${i}` });
      hub.edges.push({ id: `e:calls:step:a->step:t${i}`, kind: "calls", from: "step:a", to: `step:t${i}` });
    }
    const { nodes } = await layoutGraph(hub, new Set());
    const targets = nodes.filter((n) => n.ir.id.startsWith("step:t"));
    expect(new Set(targets.map((n) => Math.round(n.y))).size).toBe(1);
    const iso = tiny();
    iso.edges = iso.edges.filter((e) => e.kind === "contains");
    for (let i = 0; i < 40; i++) {
      iso.nodes.push({ id: `step:i${i}`, kind: "step", name: `i${i}`, parent: "view:t" });
      iso.edges.push({ id: `e:contains:view:t->step:i${i}`, kind: "contains", from: "view:t", to: `step:i${i}` });
    }
    // one edge so the view is layered (an edge-free graph rectpacks anyway)
    iso.edges.push({ id: "e:calls:step:a->step:b", kind: "calls", from: "step:a", to: "step:b" });
    const laid = await layoutGraph(iso, new Set());
    const rows = new Set(laid.nodes.filter((n) => n.ir.id.startsWith("step:i")).map((n) => Math.round(n.y))).size;
    expect(rows).toBeGreaterThan(3);
  });
});

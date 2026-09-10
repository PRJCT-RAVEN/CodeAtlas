import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutGraph } from "../src/layout/elk";
import { EDGE_FAMILIES, edgeStyle, isReadFamily } from "../src/ir/families";
import type { GraphIR } from "../src/ir/types";

const here = dirname(fileURLToPath(import.meta.url));
const ir: GraphIR = JSON.parse(
  readFileSync(join(here, "../public/sample-graph.json"), "utf8")
);

describe("layoutGraph", () => {
  it("positions every visible node with finite coordinates and sizes", async () => {
    const { nodes, edges } = await layoutGraph(ir, new Set());
    // files + root package are skipped for display
    const expected = ir.nodes.filter((n) => n.kind !== "file" && n.id !== ir.root).length;
    expect(nodes.length).toBe(expected);
    for (const n of nodes) {
      expect(Number.isFinite(n.x), `${n.ir.id} x`).toBe(true);
      expect(Number.isFinite(n.y), `${n.ir.id} y`).toBe(true);
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBeGreaterThan(0);
    }
    expect(edges.length).toBeGreaterThan(0);
    // parents precede children (React Flow subflow requirement)
    const seen = new Set<string>();
    for (const n of nodes) {
      if (n.parentId) expect(seen.has(n.parentId), `${n.ir.id} parent order`).toBe(true);
      seen.add(n.ir.id);
    }
  });

  it("re-routes edges into collapsed containers and drops internal ones", async () => {
    const collapsed = new Set(["type:MediumCore/EventBus"]);
    const { nodes, edges } = await layoutGraph(ir, collapsed);
    // EventBus children hidden
    expect(nodes.some((n) => n.ir.id === "func:MediumCore/EventBus.publish(_:)")).toBe(false);
    // the collapsed container itself remains
    const bus = nodes.find((n) => n.ir.id === "type:MediumCore/EventBus");
    expect(bus?.collapsed).toBe(true);
    // register() called EventBus.publish → now re-routed to the EventBus container
    expect(
      edges.some(
        (e) =>
          e.kind === "calls" &&
          e.source === "func:MediumFeature/UserService.register(name:email:)" &&
          e.target === "type:MediumCore/EventBus"
      )
    ).toBe(true);
    // publish→handlers is fully internal to the collapsed node → dropped
    expect(edges.some((e) => e.kind === "reads")).toBe(false);
  });

  it("never emits contains edges", async () => {
    const { edges } = await layoutGraph(ir, new Set());
    expect(edges.every((e) => e.kind !== "contains")).toBe(true);
  });
});

// --- rectpacking heuristic (edge-free subtrees) ------------------------------
// Regression: a container whose DIRECT children carry no edges but whose
// descendants do must NOT be rectpacked, or ELK layered throws
// UnsupportedGraphException on the cross-hierarchy edge.

const repoRoot = join(here, "../..");

function fs2ir(dir: string): GraphIR {
  const json = execFileSync("node", [join(repoRoot, "tools/fs2ir.mjs"), dir], {
    encoding: "utf8",
  });
  return JSON.parse(json);
}

/** A small nested tree (3 dirs, 6 docs) — was `fixtures/tiny` before the Swift analyzer was cut. */
function tinyTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "layout-tree-"));
  mkdirSync(join(dir, "Sources", "Tiny"), { recursive: true });
  writeFileSync(join(dir, "Package.swift"), "// swift-tools-version: 5.9\n");
  writeFileSync(join(dir, "expected-ir.json"), "{}\n");
  writeFileSync(join(dir, "expected-syntax.json"), "{}\n");
  for (const f of ["App.swift", "ConsoleGreeter.swift", "Greeter.swift"])
    writeFileSync(join(dir, "Sources", "Tiny", f), `// ${f}\n`);
  return dir;
}

describe("rectpacking for edge-free containers", () => {
  it("lays out a pure tree (fs2ir of a nested directory) without throwing", async () => {
    const dir = tinyTree();
    try {
      const tree = fs2ir(dir);
      expect(tree.edges.every((e) => e.kind === "contains")).toBe(true);
      const { nodes, edges } = await layoutGraph(tree, new Set());
      expect(edges.length).toBe(0);
      expect(nodes.length).toBe(tree.nodes.length - 1); // root hidden
      for (const n of nodes) {
        expect(Number.isFinite(n.x), `${n.ir.id} x`).toBe(true);
        expect(Number.isFinite(n.y), `${n.ir.id} y`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("packs many edge-free siblings into a grid, not one row", async () => {
    const leaves = Array.from({ length: 12 }, (_, i) => ({
      id: `doc:box/f${String(i).padStart(2, "0")}.txt`,
      kind: "doc",
      name: `f${String(i).padStart(2, "0")}.txt`,
      parent: "dir:box",
    }));
    const tree: GraphIR = {
      irVersion: "0.2",
      generator: { tool: "test", version: "0", commit: null },
      root: "dir:.",
      nodes: [
        { id: "dir:.", kind: "dir", name: "." },
        { id: "dir:box", kind: "dir", name: "box", parent: "dir:." },
        ...leaves,
      ],
      edges: [
        { id: "e:contains:dir:.->dir:box", kind: "contains", from: "dir:.", to: "dir:box" },
        ...leaves.map((l) => ({
          id: `e:contains:dir:box->${l.id}`,
          kind: "contains" as const,
          from: "dir:box",
          to: l.id,
        })),
      ],
    } as GraphIR;
    const { nodes } = await layoutGraph(tree, new Set());
    const ys = new Set(nodes.filter((n) => n.parentId === "dir:box").map((n) => Math.round(n.y)));
    expect(ys.size).toBeGreaterThan(1);
  });

  it("keeps layered for a container whose grandchild carries a cross-hierarchy edge", async () => {
    // A > A1 > A1a --calls--> B > B1.  A's direct child (A1) is not an endpoint.
    const mixed = {
      irVersion: "0.2",
      generator: { tool: "test", version: "0", commit: null },
      root: "package:root",
      nodes: [
        { id: "package:root", kind: "package", name: "root" },
        { id: "module:A", kind: "module", name: "A", parent: "package:root" },
        { id: "type:A/A1", kind: "type", name: "A1", parent: "module:A" },
        { id: "func:A/A1.go()", kind: "function", name: "go()", parent: "type:A/A1" },
        { id: "module:B", kind: "module", name: "B", parent: "package:root" },
        { id: "func:B/b1()", kind: "function", name: "b1()", parent: "module:B" },
      ],
      edges: [
        { id: "e:contains:package:root->module:A", kind: "contains", from: "package:root", to: "module:A" },
        { id: "e:contains:package:root->module:B", kind: "contains", from: "package:root", to: "module:B" },
        { id: "e:contains:module:A->type:A/A1", kind: "contains", from: "module:A", to: "type:A/A1" },
        { id: "e:contains:type:A/A1->func:A/A1.go()", kind: "contains", from: "type:A/A1", to: "func:A/A1.go()" },
        { id: "e:contains:module:B->func:B/b1()", kind: "contains", from: "module:B", to: "func:B/b1()" },
        { id: "e:calls:func:A/A1.go()->func:B/b1()", kind: "calls", from: "func:A/A1.go()", to: "func:B/b1()" },
      ],
    } as GraphIR;
    const { nodes, edges } = await layoutGraph(mixed, new Set());
    expect(nodes.length).toBe(5);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "calls", source: "func:A/A1.go()", target: "func:B/b1()" });
    for (const n of nodes) {
      expect(Number.isFinite(n.x), `${n.ir.id} x`).toBe(true);
      expect(Number.isFinite(n.y), `${n.ir.id} y`).toBe(true);
    }
  });
});

// --- flow-down layering (round 2, convention adopted 2026-08-24) ----------------
// A read's SOURCE sits above its reader; every other edge keeps source above
// target. Only relative positions are compared — ELK coordinates are not
// part of the contract.

function pairGraph(kind: string): GraphIR {
  return {
    irVersion: "0.2",
    generator: { tool: "test", version: "0", commit: null },
    root: "package:root",
    nodes: [
      { id: "package:root", kind: "package", name: "root" },
      { id: "module:M", kind: "module", name: "M", parent: "package:root" },
      { id: "func:M/a()", kind: "function", name: "a()", parent: "module:M" },
      { id: "func:M/b()", kind: "function", name: "b()", parent: "module:M" },
    ],
    edges: [
      { id: "e:contains:package:root->module:M", kind: "contains", from: "package:root", to: "module:M" },
      { id: "e:contains:module:M->func:M/a()", kind: "contains", from: "module:M", to: "func:M/a()" },
      { id: "e:contains:module:M->func:M/b()", kind: "contains", from: "module:M", to: "func:M/b()" },
      { id: `e:${kind}:func:M/a()->func:M/b()`, kind, from: "func:M/a()", to: "func:M/b()" },
    ],
  } as GraphIR;
}

describe("flow-down layering", () => {
  it("lays the source of a `reads` edge ABOVE its reader", async () => {
    const { nodes, edges } = await layoutGraph(pairGraph("reads"), new Set());
    const a = nodes.find((n) => n.ir.id === "func:M/a()")!;
    const b = nodes.find((n) => n.ir.id === "func:M/b()")!;
    expect(a.parentId).toBe(b.parentId); // same frame → y comparable
    expect(b.y + b.height).toBeLessThanOrEqual(a.y);
    // the drawn edge keeps the authored direction
    expect(edges[0]).toMatchObject({ kind: "reads", source: "func:M/a()", target: "func:M/b()", reversed: true });
  });

  it("keeps the caller of a `calls` edge ABOVE the callee", async () => {
    const { nodes, edges } = await layoutGraph(pairGraph("calls"), new Set());
    const a = nodes.find((n) => n.ir.id === "func:M/a()")!;
    const b = nodes.find((n) => n.ir.id === "func:M/b()")!;
    expect(a.parentId).toBe(b.parentId);
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(edges[0]).toMatchObject({ kind: "calls", source: "func:M/a()", target: "func:M/b()", reversed: false });
  });

  it("sets DisplayEdge.reversed only for read-family kinds", async () => {
    for (const kind of ["reads", "read", "polls", "queries", "fetches", "loads"]) {
      const { edges } = await layoutGraph(pairGraph(kind), new Set());
      expect(edges[0].reversed, kind).toBe(true);
    }
    for (const kind of ["calls", "writes", "feeds", "triggers", "imports", "runs", "instantiates", "unknown_kind"]) {
      const { edges } = await layoutGraph(pairGraph(kind), new Set());
      expect(edges[0].reversed, kind).toBe(false);
    }
  });
});

// --- edge families: single source of truth for style + layout direction -----

describe("edge families", () => {
  it("matches every family's canonical kind with its own regex", () => {
    for (const f of EDGE_FAMILIES) {
      expect(f.re.test(f.canonical), f.name).toBe(true);
      expect(edgeStyle(f.canonical), f.name).toBe(f.style);
    }
  });

  it("treats reads/polls as read-family and nothing else in the table", () => {
    expect(isReadFamily("reads")).toBe(true);
    expect(isReadFamily("polls")).toBe(true);
    for (const f of EDGE_FAMILIES) {
      expect(isReadFamily(f.canonical), f.name).toBe(f.name === "reads");
    }
    expect(isReadFamily("feeds")).toBe(false);
  });
});

describe("layout speed tiers", () => {
  it("picks the tier from the larger of visible nodes and display edges", async () => {
    const { layoutTier, FAST_THRESHOLD, FASTEST_THRESHOLD, FASTEST_EDGES } = await import("../src/layout/elk");
    expect(layoutTier(10, 10)).toBe("quality");
    expect(layoutTier(FAST_THRESHOLD, FAST_THRESHOLD)).toBe("quality");
    expect(layoutTier(FAST_THRESHOLD + 1, 0)).toBe("fast");
    expect(layoutTier(0, FAST_THRESHOLD + 1)).toBe("fast");
    expect(layoutTier(FASTEST_THRESHOLD + 1, 0)).toBe("fastest");
    expect(layoutTier(0, FASTEST_EDGES + 1)).toBe("fastest");
  });
});

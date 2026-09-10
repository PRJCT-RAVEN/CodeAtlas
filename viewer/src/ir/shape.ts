// Client-side structural guard for a freshly polled graph.json.
//
// The schema validator (schema/validate.mjs) is the contract; this is the
// viewer's own belt-and-braces so a bad draft can never unmount the app: the
// poller keeps the last good graph and shows the reason instead. Kept cheap
// (no Ajv, O(n) — parent chains are memoised) — it only checks what the
// layout/render code would trip over.

import type { GraphIR } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns null when `g` is renderable, else a one-line reason. */
export function checkGraphShape(g: unknown): string | null {
  if (!isObj(g)) return "document is not an object";
  if (typeof g.root !== "string" || !g.root) return "missing root";
  if (!Array.isArray(g.nodes)) return "nodes is not an array";
  if (!Array.isArray(g.edges)) return "edges is not an array";

  const ids = new Set<string>();
  const parent = new Map<string, string | undefined>();
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    if (!isObj(n)) return `nodes[${i}] is not an object`;
    if (typeof n.id !== "string" || !n.id) return `nodes[${i}] has no id`;
    if (typeof n.kind !== "string" || !n.kind) return `node ${n.id} has no kind`;
    if (typeof n.name !== "string" || !n.name) return `node ${n.id} has no name`;
    if (n.parent !== undefined && typeof n.parent !== "string") return `node ${n.id} parent is not a string`;
    if (ids.has(n.id)) return `duplicate node id ${n.id}`;
    ids.add(n.id);
    parent.set(n.id, n.parent as string | undefined);
  }
  if (!ids.has(g.root)) return `root ${g.root} is not a node`;

  // Every parent exists; every chain ends at the root without cycles.
  // `status` memoises the verdict per node so a deep chain is walked once
  // (the naive per-node walk is O(n²) and a crafted file could hang the tab).
  const status = new Map<string, "ok" | "walking">();
  status.set(g.root, "ok");
  for (const [id, p] of parent) {
    if (p !== undefined && !ids.has(p)) return `node ${id} has unknown parent ${p}`;
    if (p === undefined && id !== g.root) return `node ${id} has no parent but is not the root`;
  }
  for (const start of parent.keys()) {
    if (status.has(start)) continue;
    const trail: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !status.has(cur)) {
      status.set(cur, "walking");
      trail.push(cur);
      cur = parent.get(cur);
    }
    if (cur !== undefined && status.get(cur) === "walking") return `parent cycle through ${cur}`;
    // cur is either the root ("ok") or a node already proven ok
    for (const t of trail) status.set(t, "ok");
  }

  const edgeIds = new Set<string>();
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (!isObj(e)) return `edges[${i}] is not an object`;
    if (typeof e.id !== "string") return `edges[${i}] has no id`;
    if (typeof e.kind !== "string" || !e.kind) return `edge ${e.id} has no kind`;
    if (typeof e.from !== "string" || typeof e.to !== "string") return `edge ${e.id} has no from/to`;
    if (!ids.has(e.from)) return `edge ${e.id}: unknown from ${e.from}`;
    if (!ids.has(e.to)) return `edge ${e.id}: unknown to ${e.to}`;
    if (edgeIds.has(e.id)) return `duplicate edge id ${e.id}`;
    edgeIds.add(e.id);
  }
  if (g.annotations !== undefined && !isObj(g.annotations)) return "annotations is not an object";
  return null;
}

export function asGraph(g: unknown): GraphIR {
  const err = checkGraphShape(g);
  if (err) throw new Error(err);
  return g as GraphIR;
}

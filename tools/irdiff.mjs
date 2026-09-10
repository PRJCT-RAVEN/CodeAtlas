#!/usr/bin/env node
// irdiff — compare two CodeAtlas Graph IR files (any kinds; no schema assumptions, no deps).
//
//   node tools/irdiff.mjs old.json new.json [--json]
//
// Nodes are matched by id. A node is "modified" when kind, name, parent or attrs differ
// (deep compare; locs and metrics are ignored — they move with every edit). Edges are
// matched by id and "modified" when kind, from, to or count differ (locs ignored).
// Prints a readable report, or a JSON object with --json.
// Exit codes: 0 always (a diff is not an error) · 1 a file is unreadable / not JSON · 2 usage.

import { readFileSync } from "node:fs";

const NODE_FIELDS = ["kind", "name", "parent", "attrs"];
const EDGE_FIELDS = ["kind", "from", "to", "count"];

export function diffIr(oldIr, newIr) {
  const nodes = diffItems(items(oldIr, "nodes"), items(newIr, "nodes"), NODE_FIELDS);
  const edges = diffItems(items(oldIr, "edges"), items(newIr, "edges"), EDGE_FIELDS);
  const document = {};
  for (const f of ["irVersion", "root", "title", "description"])
    if (!deepEqual(oldIr?.[f], newIr?.[f])) document[f] = { from: oldIr?.[f], to: newIr?.[f] };
  return {
    document,
    nodes,
    edges,
    summary: {
      nodes: { old: items(oldIr, "nodes").length, new: items(newIr, "nodes").length, ...counts(nodes) },
      edges: { old: items(oldIr, "edges").length, new: items(newIr, "edges").length, ...counts(edges) },
      changed: Object.keys(document).length > 0 || counts(nodes).added + counts(nodes).removed + counts(nodes).modified + counts(edges).added + counts(edges).removed + counts(edges).modified > 0,
    },
  };
}

function items(ir, key) {
  const arr = ir && typeof ir === "object" ? ir[key] : undefined;
  return Array.isArray(arr) ? arr.filter((x) => x && typeof x === "object" && typeof x.id === "string") : [];
}
function counts(d) {
  return { added: d.added.length, removed: d.removed.length, modified: d.modified.length };
}

function diffItems(oldArr, newArr, fields) {
  const oldById = new Map(oldArr.map((x) => [x.id, x]));
  const newById = new Map(newArr.map((x) => [x.id, x]));
  const added = [], removed = [], modified = [];
  for (const [id, n] of newById) if (!oldById.has(id)) added.push(pick(n, fields));
  for (const [id, o] of oldById) if (!newById.has(id)) removed.push(pick(o, fields));
  for (const [id, o] of oldById) {
    const n = newById.get(id);
    if (!n) continue;
    const changes = {};
    for (const f of fields) if (!deepEqual(o[f], n[f])) changes[f] = { from: o[f], to: n[f] };
    if (Object.keys(changes).length) modified.push({ id, changes });
  }
  const byId = (a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
  added.sort(byId); removed.sort(byId); modified.sort(byId);
  return { added, removed, modified };
}

function pick(x, fields) {
  const o = { id: x.id };
  for (const f of fields) if (x[f] !== undefined) o[f] = x[f];
  return o;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => b[k] !== undefined).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
}

export function formatReport(diff, oldName, newName) {
  const L = [];
  const show = (v) => (v === undefined ? "∅" : JSON.stringify(v));
  L.push(`irdiff: ${oldName} → ${newName}${diff.summary.changed ? "" : "  (no changes)"}`);
  for (const [f, c] of Object.entries(diff.document)) L.push(`  ${f}: ${show(c.from)} → ${show(c.to)}`);
  for (const what of ["nodes", "edges"]) {
    const s = diff.summary[what];
    L.push(`${what}: ${s.old} → ${s.new}  (+${s.added} added, -${s.removed} removed, ~${s.modified} modified)`);
    const d = diff[what];
    for (const x of d.added) L.push(`  + ${x.id}${describe(x, what)}`);
    for (const x of d.removed) L.push(`  - ${x.id}${describe(x, what)}`);
    for (const m of d.modified)
      L.push(`  ~ ${m.id}: ` + Object.entries(m.changes).map(([f, c]) => `${f} ${show(c.from)} → ${show(c.to)}`).join("; "));
  }
  return L.join("\n");
}
function describe(x, what) {
  if (what === "nodes") return `  [${x.kind ?? "?"}] ${JSON.stringify(x.name ?? "")}${x.parent ? ` in ${x.parent}` : ""}`;
  return `  [${x.kind ?? "?"}]${x.count !== undefined ? ` ×${x.count}` : ""}`;
}

function main(argv) {
  let json = false;
  const files = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") { usage(); return 2; }
    else if (a.startsWith("-") && a !== "-") { console.error(`irdiff: unknown flag ${a}`); usage(); return 2; }
    else files.push(a);
  }
  if (files.length !== 2) { usage(); return 2; }
  const docs = [];
  for (const f of files) {
    try { docs.push(JSON.parse(readFileSync(f, "utf8"))); }
    catch (e) { console.error(`irdiff: cannot read ${f}: ${e.message}`); return 1; }
  }
  const diff = diffIr(docs[0], docs[1]);
  if (json) process.stdout.write(JSON.stringify({ old: files[0], new: files[1], ...diff }, null, 2) + "\n");
  else process.stdout.write(formatReport(diff, files[0], files[1]) + "\n");
  return 0;
}
function usage() { console.error("usage: node tools/irdiff.mjs old.json new.json [--json]"); }

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

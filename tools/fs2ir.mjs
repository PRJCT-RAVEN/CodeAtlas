#!/usr/bin/env node
// fs2ir — directory tree → Graph IR v0.2 (CodeAtlas file-structure views).
//
// Usage:
//   node tools/fs2ir.mjs <root> [-o out.json] [--depth N] [--max-children M]
//                        [--ignore name]... [--include-hidden] [--abs-locs] [--sizes]
//
// Emits: `dir` nodes (containers), `doc` nodes (files), `link` nodes (symlinks,
// with attrs.target — never dropped silently), nesting via parent + mirrored
// `contains` edges. Oversized directories are truncated with an explicit
// `overflow` summary node — never silently. --max-children caps files+links AND
// subdirectories (each list separately; one overflow node carries the sum).
// Entries that cannot become nodes (FIFOs, sockets, devices, unreadable
// directories, ignored/hidden names, names the IR contract cannot carry) are COUNTED
// into the affected dir node's attrs.skipped {fifo, socket, device, unreadable,
// ignored, unrepresentable} — omitted when all zero.
//
// --sizes: every `doc` node gets attrs.scale = clamp(1 + log10(max(bytes,1)/1024)/2, 1, 2.6)
// rounded to 2 decimals (1 KB → 1.0, 100 KB → 2.0, ≥ ~1.6 MB → 2.6). The viewer multiplies
// leaf width/height by attrs.scale. metrics.bytes is always emitted.
//
// Locs: root-relative (schema: "paths are repo-root-relative"), like the code
// code graphs use. The root node carries attrs.absRoot so a viewer can
// rebuild absolute paths; pass --abs-locs to emit absolute paths instead.
//
// Exit codes: 0 ok · 1 root missing / not a directory · 2 usage (bad flag value).

import { readdirSync, statSync, readlinkSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git", "node_modules", ".build", "build", "dist", "__pycache__",
  ".venv", ".venv-tier2", ".cache", "coverage", ".DS_Store", ".idea", ".vscode",
]);
// A line terminator can never appear in an IR id (JSON-Schema `.` does not match one, so
// the id pattern rejects it) and a backslash breaks the forward-slash contract for relative
// locs. Such an entry is counted into attrs.skipped, not silently dropped and not mangled:
// its name is also its loc, and an escaped loc would no longer open the real file.
const UNREPRESENTABLE = /[\n\r\u2028\u2029\\]/;
const USAGE = "usage: fs2ir.mjs <root> [-o out.json] [--depth N] [--max-children M] [--max-nodes T] [--ignore name] [--include-hidden] [--abs-locs] [--sizes]";

// --- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
let root = null, out = null, maxDepth = 6, maxChildren = 30, maxNodes = 3000;
let includeHidden = false, absLocs = false, sizes = false;
const ignores = new Set(DEFAULT_IGNORES);

function intFlag(name, raw) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    console.error(`fs2ir: ${name} expects a non-negative integer, got ${raw === undefined ? "nothing" : JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Number(raw);
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o") out = argv[++i];
  else if (a === "--depth") maxDepth = intFlag("--depth", argv[++i]);
  else if (a === "--max-children") maxChildren = intFlag("--max-children", argv[++i]);
  else if (a === "--max-nodes") maxNodes = intFlag("--max-nodes", argv[++i]);
  else if (a === "--ignore") ignores.add(argv[++i]);
  else if (a === "--include-hidden") includeHidden = true;
  else if (a === "--abs-locs") absLocs = true;
  else if (a === "--sizes") sizes = true;
  else if (a.startsWith("-") && a !== "-") { console.error(`fs2ir: unknown flag ${a}\n${USAGE}`); process.exit(2); }
  else if (!root) root = a;
  else { console.error(`fs2ir: unexpected argument: ${a}\n${USAGE}`); process.exit(2); }
}
if (!root) { console.error(USAGE); process.exit(2); }
root = resolve(root);
{
  let st;
  try { st = statSync(root); }
  catch (e) {
    console.error(`fs2ir: root does not exist or is not accessible: ${root} (${e.code ?? e.message})`);
    process.exit(1);
  }
  if (!st.isDirectory()) { console.error(`fs2ir: root is not a directory: ${root}`); process.exit(1); }
}

// --- walk ---------------------------------------------------------------------
const nodes = [];
const edges = [];
const rootId = "dir:.";
const byteCmp = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function skipName(name) {
  if (ignores.has(name)) return true;
  if (!includeHidden && name.startsWith(".")) return true;
  return false;
}

function addEdge(from, to) {
  edges.push({ id: `e:contains:${from}->${to}`, kind: "contains", from, to });
}

function loc(rel, absPath) {
  return { file: absLocs ? absPath : rel, line: 1, col: 1 };
}

function childRel(rel, name) {
  return rel === "." ? name : `${rel}/${name}`;
}

/** attrs.scale for --sizes: clamp(1 + log10(max(bytes,1)/1024)/2, 1, 2.6), 2 decimals. */
export function sizeScale(bytes) {
  const s = 1 + Math.log10(Math.max(bytes, 1) / 1024) / 2;
  return Math.round(Math.min(2.6, Math.max(1, s)) * 100) / 100;
}

function walk(absPath, rel, parentId, depth) {
  const id = rel === "." ? rootId : `dir:${rel}`;
  const node = {
    id, kind: "dir", name: rel === "." ? basename(absPath) : basename(rel),
    loc: loc(rel, absPath),
  };
  if (parentId) { node.parent = parentId; addEdge(parentId, id); }
  else node.attrs = { absRoot: absPath };
  nodes.push(node);

  const skipped = { fifo: 0, socket: 0, device: 0, unreadable: 0, ignored: 0, unrepresentable: 0 };
  const finish = () => {
    const nonZero = Object.fromEntries(Object.entries(skipped).filter(([, v]) => v > 0));
    if (Object.keys(nonZero).length) node.attrs = { ...(node.attrs ?? {}), skipped: nonZero };
  };

  let all;
  try {
    all = readdirSync(absPath, { withFileTypes: true });
  } catch {
    skipped.unreadable = 1; // this directory's listing failed — it stays a leaf, but says so
    finish();
    return;
  }
  const entries = [];
  for (const e of all) {
    if (skipName(e.name)) { skipped.ignored++; continue; }
    if (UNREPRESENTABLE.test(e.name)) { skipped.unrepresentable++; continue; }
    if (e.isFIFO()) { skipped.fifo++; continue; }
    if (e.isSocket()) { skipped.socket++; continue; }
    if (e.isBlockDevice() || e.isCharacterDevice()) { skipped.device++; continue; }
    entries.push(e);
  }
  entries.sort((a, b) => byteCmp(a.name, b.name));

  const dirs = entries.filter((e) => e.isDirectory());
  // Symlinks (to files or dirs) are leaves that name their target; we do not
  // follow them, so cycles are impossible and nothing vanishes silently.
  const leaves = entries.filter((e) => e.isFile() || e.isSymbolicLink());

  if (depth >= maxDepth) {
    const elided = dirs.length + leaves.length;
    if (elided > 0) overflow(id, rel, elided, "depth limit");
    finish();
    return;
  }
  // Total budget (--max-nodes): a bushy tree could otherwise reach
  // maxChildren^maxDepth nodes. Everything below this directory is elided into
  // one overflow node once the budget is spent — never silently.
  if (nodes.length >= maxNodes) {
    const elided = dirs.length + leaves.length;
    if (elided > 0) overflow(id, rel, elided, "node budget");
    finish();
    return;
  }

  const keptDirs = dirs.slice(0, maxChildren);
  let walkedDirs = 0;
  for (const d of keptDirs) {
    if (nodes.length >= maxNodes) break;
    walk(join(absPath, d.name), childRel(rel, d.name), id, depth + 1);
    walkedDirs++;
  }

  const keptLeaves = leaves.slice(0, maxChildren);
  let walkedLeaves = 0;
  for (const f of keptLeaves) {
    if (nodes.length >= maxNodes) break;
    walkedLeaves++;
    const frel = childRel(rel, f.name);
    const fabs = join(absPath, f.name);
    if (f.isSymbolicLink()) {
      let target = "?";
      try { target = readlinkSync(fabs); } catch { /* dangling or unreadable — keep "?" */ }
      const lid = `link:${frel}`;
      nodes.push({ id: lid, kind: "link", name: f.name, parent: id, loc: loc(frel, fabs), attrs: { target } });
      addEdge(id, lid);
      continue;
    }
    let bytes = 0;
    try { bytes = statSync(fabs).size; } catch { /* stat race — keep 0 */ }
    const fid = `doc:${frel}`;
    const doc = { id: fid, kind: "doc", name: f.name, parent: id, loc: loc(frel, fabs), metrics: { bytes } };
    if (sizes) doc.attrs = { scale: sizeScale(bytes) };
    nodes.push(doc);
    addEdge(id, fid);
  }

  const elided = (dirs.length - walkedDirs) + (leaves.length - walkedLeaves);
  if (elided > 0) overflow(id, rel, elided, walkedDirs < keptDirs.length || walkedLeaves < keptLeaves.length ? "node budget" : "max-children");
  finish();
}

function overflow(parentId, rel, count, why) {
  // `overflow:.` for the root mirrors `dir:.` — no collision with a dir literally named "_root".
  const oid = `overflow:${rel}`;
  nodes.push({
    id: oid, kind: "overflow", name: `… +${count} more`, parent: parentId,
    attrs: { elided: count, reason: why },
  });
  addEdge(parentId, oid);
}

walk(root, ".", null, 0);

// --- emit ---------------------------------------------------------------------
const byId = (a, b) => byteCmp(a.id, b.id);
nodes.sort(byId);
edges.sort(byId);
const ir = {
  irVersion: "0.2",
  generator: { tool: "fs2ir", version: "0.2", commit: null },
  root: rootId,
  nodes,
  edges,
};
const json = JSON.stringify(ir, null, 2);
if (out) { writeFileSync(out, json); console.error(`fs2ir: ${nodes.length} nodes, ${edges.length} edges → ${out}`); }
else process.stdout.write(json);

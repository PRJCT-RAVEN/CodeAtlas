#!/usr/bin/env node
// CodeAtlas IR validator.
//   node validate.mjs [--quiet] <graph.json>...          validate full Graph IR documents
//   node validate.mjs --patch [--quiet] <patch.json>...  validate abstraction-agent patches (spec F6)
//
// Exit codes: 0 every file valid · 1 at least one file invalid · 2 usage error or missing deps.
// --quiet (-q): print nothing, exit code only.
//
// Beyond JSON Schema, full-IR mode enforces these semantic invariants (one line per error,
// always naming the offending id):
//   - node ids unique; edge ids unique; cluster ids unique
//   - root exists in nodes; exactly one node (the root) omits `parent`
//   - every node.parent / edge.from / edge.to / cluster member / annotation key resolves
//   - parent chains are acyclic (no self-parent, no cycles) and end at the root
//   - every `contains` edge agrees with the child's parent (to.parent === from)
//   - every non-root node has a mirrored `contains` edge from its parent (CLAUDE.md contract)
//   - edge id equals `e:${kind}:${from}->${to}`
//   - edge.count, when present together with locs, equals locs.length
//     (count without locs is fine: multiplicity of a conceptual edge)
//   - nodes and edges sorted by id in UTF-8 byte order (Buffer.compare) — the same
//     order every producer must use; JavaScript `<` (UTF-16 code units) differs for astral chars
//   - relative loc paths use forward slashes (absolute Windows paths are left alone)
//
// Also importable: `validateDocument(doc, { patch })` → string[] of errors.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, posix, win32 } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// "Am I the entry point?" — compared through realpath as well, because the ESM loader
// resolves symlinks in import.meta.url and argv[1] does not: invoked as
// /tmp/…/validate.mjs on macOS (/tmp -> /private/tmp) the plain comparison is false, and
// the CLI would print nothing and exit 0 — a silent pass for `validate && mv`.
const isCli = isEntryPoint();
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { return false; }
}

// Every publish goes through this file, so a missing dependency has to read as "install
// the deps": a bare ERR_MODULE_NOT_FOUND stack looks like the graph is at fault, and the
// subagents that are told to validate until VALID can neither install nor fix it.
let Ajv2020;
try {
  ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
} catch (e) {
  if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
  const msg =
    `codeatlas: the validator's dependency "ajv" is not installed — run ` +
    `\`node ${join(here, "..", "bin", "codeatlas-viewer.mjs")} install\` ` +
    `(or \`npm install\` in ${here})`;
  if (isCli) { console.error(msg); process.exit(2); }
  throw new Error(msg);
}

const schema = JSON.parse(readFileSync(join(here, "ir.schema.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validateFull = ajv.getSchema(schema.$id);
const validatePatch = ajv.getSchema(`${schema.$id}#/$defs/agentPatch`);

const MAX_REPORTED = 50;
// allErrors collects one ajv error per offending value, so a systematically broken producer
// on a 100k-node graph reaches six figures. Formatting all of them is pointless (the CLI
// prints MAX_REPORTED) and spreading them into push() as arguments overflows the stack —
// which used to surface as a bogus "not readable/parseable JSON".
const MAX_SCHEMA_ERRORS = MAX_REPORTED * 4;

export function validateDocument(doc, { patch = false } = {}) {
  const errors = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    errors.push(
      `${patch ? "patch" : "document"} must be a JSON object, got ${
        doc === null ? "null" : Array.isArray(doc) ? "array" : typeof doc
      }`
    );
    return errors;
  }
  if (patch) {
    // F6: a patch may ONLY contain `clusters` and/or `annotations`.
    const illegal = Object.keys(doc).filter((k) => !["clusters", "annotations"].includes(k));
    if (illegal.length)
      errors.push(
        `REJECTED (spec F6): patch touches forbidden top-level key(s): ${illegal.join(", ")} — ` +
          `agent patches may only modify clusters and annotations, never nodes or edges`
      );
    if (!validatePatch(doc)) pushAjv(errors, validatePatch.errors, doc);
    if (errors.length === 0) clusterChecks(doc, null, errors);
    return errors;
  }
  if (!validateFull(doc)) pushAjv(errors, validateFull.errors, doc);
  if (errors.length === 0) semanticChecks(doc, errors);
  return errors;
}

export function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function semanticChecks(ir, errors) {
  // --- nodes ------------------------------------------------------------------
  const nodeById = new Map();
  for (const n of ir.nodes) {
    if (nodeById.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    else nodeById.set(n.id, n);
  }
  if (!nodeById.has(ir.root)) errors.push(`root ${ir.root} not present in nodes`);

  const roots = ir.nodes.filter((n) => n.parent === undefined);
  if (roots.length !== 1 || roots[0]?.id !== ir.root)
    errors.push(
      `exactly one node (the root ${ir.root}) may omit parent; found ${roots.length}` +
        (roots.length ? ` (${roots.map((n) => n.id).join(", ")})` : "")
    );
  for (const n of ir.nodes)
    if (n.parent !== undefined && !nodeById.has(n.parent))
      errors.push(`node ${n.id} has unknown parent ${n.parent}`);

  // Parent-chain walk: every chain must reach ir.root without revisiting a node.
  // chainStatus: id -> { ok: true } | { ok: false, why: "cycle"|"notroot"|"unknown", at: id }
  const chainStatus = new Map();
  for (const start of ir.nodes) {
    if (chainStatus.has(start.id)) continue;
    const path = [];
    const onPath = new Set();
    let cur = start;
    let verdict = { ok: true };
    for (;;) {
      if (onPath.has(cur.id)) {
        const cycle = path.slice(path.indexOf(cur.id)).concat(cur.id);
        errors.push(
          cycle.length === 2
            ? `node ${cur.id} is its own parent`
            : `parent cycle: ${cycle.join(" -> ")}`
        );
        verdict = { ok: false, why: "cycle", at: cur.id };
        break;
      }
      const known = chainStatus.get(cur.id);
      if (known) {
        verdict = known;
        if (!known.ok && known.why === "notroot")
          errors.push(`parent chain of ${start.id} ends at ${known.at}, which is not the root ${ir.root}`);
        else if (!known.ok && known.why === "cycle")
          errors.push(`parent chain of ${start.id} enters a cycle at ${known.at}`);
        break;
      }
      path.push(cur.id);
      onPath.add(cur.id);
      if (cur.parent === undefined) {
        if (cur.id !== ir.root) {
          verdict = { ok: false, why: "notroot", at: cur.id };
          if (start.id !== cur.id) // start itself is reported by the exactly-one-root check
            errors.push(`parent chain of ${start.id} ends at ${cur.id}, which is not the root ${ir.root}`);
        }
        break;
      }
      const next = nodeById.get(cur.parent);
      if (!next) { verdict = { ok: false, why: "unknown", at: cur.id }; break; } // reported as unknown parent
      cur = next;
    }
    for (const id of path) chainStatus.set(id, verdict);
  }

  // --- edges ------------------------------------------------------------------
  const edgeIds = new Set();
  const containsKey = new Set(); // "parent|child" for mirror check
  for (const e of ir.edges) {
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id: ${e.id}`);
    edgeIds.add(e.id);
    if (!nodeById.has(e.from)) errors.push(`edge ${e.id}: unknown from ${e.from}`);
    if (!nodeById.has(e.to)) errors.push(`edge ${e.id}: unknown to ${e.to}`);
    const expected = `e:${e.kind}:${e.from}->${e.to}`;
    if (e.id !== expected) errors.push(`edge id mismatch: ${e.id} ≠ ${expected}`);
    if (e.count !== undefined && e.locs !== undefined && e.count !== e.locs.length)
      errors.push(`edge ${e.id}: count=${e.count} but locs.length=${e.locs.length}`);
    if (e.kind === "contains") {
      containsKey.add(`${e.from}|${e.to}`);
      const child = nodeById.get(e.to);
      if (child && child.parent !== e.from)
        errors.push(
          `contains edge ${e.id} but ${e.to}.parent is ${
            child.parent === undefined ? "absent (root)" : child.parent
          }`
        );
    }
  }
  for (const n of ir.nodes)
    if (n.parent !== undefined && nodeById.has(n.parent) && !containsKey.has(`${n.parent}|${n.id}`))
      errors.push(`node ${n.id} has parent ${n.parent} but no mirrored edge e:contains:${n.parent}->${n.id}`);

  // --- loc paths ---------------------------------------------------------------
  for (const n of ir.nodes) checkLocPath(n.loc, `node ${n.id}`, errors);
  for (const e of ir.edges) for (const l of e.locs ?? []) checkLocPath(l, `edge ${e.id}`, errors);

  // --- ordering (spec N2) ----------------------------------------------------
  for (const [what, arr] of [["nodes", ir.nodes], ["edges", ir.edges]]) {
    for (let i = 1; i < arr.length; i++)
      if (byteCompare(arr[i - 1].id, arr[i].id) >= 0) {
        errors.push(
          `${what} not sorted by id (UTF-8 byte order) at index ${i}: "${arr[i - 1].id}" >= "${arr[i].id}" (spec N2)`
        );
        break;
      }
  }

  clusterChecks(ir, nodeById, errors, edgeIds);
}

function clusterChecks(doc, nodeById, errors, edgeIds = new Set()) {
  const clusterIds = new Set();
  for (const c of doc.clusters ?? []) {
    if (clusterIds.has(c.id)) errors.push(`duplicate cluster id: ${c.id}`);
    clusterIds.add(c.id);
    if (nodeById)
      for (const m of c.members)
        if (!nodeById.has(m)) errors.push(`cluster ${c.id}: unknown member ${m}`);
  }
  if (nodeById && doc.annotations)
    for (const key of Object.keys(doc.annotations))
      if (!nodeById.has(key) && !edgeIds.has(key) && !clusterIds.has(key))
        errors.push(`annotation for unknown id: ${key}`);
}

/** A RELATIVE loc path uses forward slashes on every platform (schema $defs/loc), so the
 *  same repo yields the same locs everywhere and Open-in-editor can resolve them. An
 *  absolute Windows path (C:\\src\\App.ts) is legal and left alone. */
function checkLocPath(loc, where, errors) {
  const file = loc?.file;
  if (typeof file !== "string" || !file.includes("\\")) return;
  if (posix.isAbsolute(file) || win32.isAbsolute(file)) return;
  // JSON.stringify, not raw: a loc.file carrying a newline would otherwise split this
  // error across lines and could forge one that reads like the validator's own output.
  errors.push(
    `${where}: relative loc.file ${JSON.stringify(file)} uses backslashes — repo-relative paths use forward slashes`
  );
}

function pushAjv(errors, ajvErrors, doc) {
  const all = ajvErrors ?? [];
  const shown = Math.min(all.length, MAX_SCHEMA_ERRORS);
  for (let i = 0; i < shown; i++) errors.push(formatAjv(all[i], doc));
  if (all.length > shown) recordDropped(errors, all.length - shown);
}

/**
 * Errors ajv found that this array does not carry, so the CLI's "… and N more" can count
 * REAL problems: a 12,000-error document capped at MAX_SCHEMA_ERRORS used to report the
 * same "and 151 more" as a 201-error one, understating it by two orders of magnitude.
 *
 * Non-enumerable on purpose. `validateDocument` returns a plain array of strings and
 * callers iterate it, spread it and JSON.stringify it — a dropped COUNT must not appear
 * among the messages.
 */
function recordDropped(errors, n) {
  Object.defineProperty(errors, "dropped", {
    value: (errors.dropped ?? 0) + n,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function formatAjv(e, doc) {
  const extra = e.params?.additionalProperty
    ? ` (${e.params.additionalProperty})`
    : e.params?.allowedValues
      ? ` (${e.params.allowedValues.join("|")})`
      : "";
  return `${e.instancePath || "/"} ${e.message}${extra}${offendingValue(e.instancePath, doc)}`;
}

/** "/nodes/8/id must match pattern …" does not say WHICH id is at fault, and the value can
 *  be unprintable (a newline in a filename), so it is quoted through JSON.stringify. */
function offendingValue(instancePath, doc) {
  if (!instancePath) return "";
  let cur = doc;
  for (const seg of instancePath.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return "";
    cur = cur[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (cur === undefined || (cur !== null && typeof cur === "object")) return ""; // containers say nothing useful
  const shown = JSON.stringify(cur);
  // Re-quote rather than cut: slicing a JSON string literal at 119 chars leaves an opening
  // quote and no closing one, and can end mid-escape ("\u00e" ).
  if (shown.length <= 120) return ` — got ${shown}`;
  const clipped = typeof cur === "string" ? JSON.stringify(cur.slice(0, 100) + "…") : shown.slice(0, 119) + "…";
  return ` — got ${clipped}`;
}

// --- CLI ----------------------------------------------------------------------
function main(argv) {
  let patch = false, quiet = false;
  const files = [];
  for (const a of argv) {
    if (a === "--patch") patch = true;
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a === "-h" || a === "--help") { usage(); return 2; }
    else if (a.startsWith("-") && a !== "-") { console.error(`unknown flag: ${a}`); usage(); return 2; }
    else files.push(a);
  }
  if (!files.length) { usage(); return 2; }

  let anyInvalid = false;
  for (const file of files) {
    let errors, doc;
    try {
      // `-` reads stdin; a UTF-8 BOM (some macOS editors write one) is stripped.
      const text = readFileSync(file === "-" ? 0 : file, "utf8").replace(/^\uFEFF/, "");
      doc = JSON.parse(text);
    } catch (e) {
      errors = [`not readable/parseable JSON: ${e.message}`];
    }
    if (!errors) {
      try {
        errors = validateDocument(doc, { patch });
      } catch (e) {
        // A crash in here is a validator bug; reporting it as a syntax error sends the
        // user hunting for a parse error in a file that parses fine.
        errors = [`internal validator error: ${e.message}`];
      }
    }
    if (errors.length) {
      anyInvalid = true;
      if (!quiet) {
        console.error(`INVALID: ${file}`);
        for (const e of errors.slice(0, MAX_REPORTED)) console.error("  - " + e);
        // both halves: messages held back here, plus the ones pushAjv never formatted
        const hidden = Math.max(0, errors.length - MAX_REPORTED) + (errors.dropped ?? 0);
        if (hidden) console.error(`  … and ${hidden} more`);
      }
    } else if (!quiet) {
      console.log(`VALID: ${file}${patch ? " (agent patch)" : ""}`);
    }
  }
  return anyInvalid ? 1 : 0;
}

function usage() {
  console.error("usage: node validate.mjs [--patch] [--quiet] <file.json>...");
}

if (isCli) {
  process.exit(main(process.argv.slice(2)));
}

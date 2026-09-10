#!/usr/bin/env node
// schema2ir — a database's catalog as CodeAtlas Graph IR, no Claude involved.
//
//   node tools/schema2ir.mjs --sqlite app.db            [-o out.json] [--name shop] [--no-indexes]
//   node tools/schema2ir.mjs --json schema.json         [-o out.json] [--name shop] [--no-indexes]
//   node tools/schema2ir.mjs --json - < schema.json
//
// `--sqlite` reads the catalog through the `sqlite3` command-line tool (three
// queries over pragma table-valued functions, so a 10,000-table file is still
// three processes). `--json` takes the portable catalog format below, which a
// Postgres or MySQL query can emit directly (docs/schema-import.md has the
// queries):
//
//   { "name": "shop", "dialect": "postgres",
//     "tables": [ { "schema": "public", "name": "orders", "rows": 12345,
//                   "columns": [ { "name": "id", "type": "bigint", "primaryKey": true, "nullable": false, "default": null } ],
//                   "foreignKeys": [ { "name": "orders_customer_fk", "columns": ["customer_id"],
//                                      "references": { "schema": "public", "table": "customers", "columns": ["id"] } } ],
//                   "indexes": [ { "name": "orders_customer_idx", "columns": ["customer_id"], "unique": false } ] } ] }
//
// IR: `db:<name>` root (kind database) > `schema:<s>` containers (only when the
// catalog has schemas) > `table:<s.t>` containers > `column:<s.t.c>` leaves (attrs
// type/primaryKey/nullable/default) and `index:<s.t.i>` leaves; one `references`
// edge per foreign-key column pair, deduplicated with a count. Foreign keys whose
// target is not in the catalog are counted in the description and on stderr —
// never dropped silently. Output is sorted in UTF-8 byte order and validates
// with schema/validate.mjs. The viewer's visibility budget does the rest.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const USAGE = "usage: schema2ir.mjs (--sqlite <file> | --json <file|->) [-o out.json] [--name <root name>] [--no-indexes]";
const argv = process.argv.slice(2);
let sqlite = null;
let jsonPath = null;
let out = null;
let name = null;
let indexes = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--sqlite") sqlite = argv[++i];
  else if (a === "--json") jsonPath = argv[++i];
  else if (a === "-o") out = argv[++i];
  else if (a === "--name") name = argv[++i];
  else if (a === "--no-indexes") indexes = false;
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}\n${USAGE}`);
    process.exit(2);
  }
}
if ((sqlite === null) === (jsonPath === null)) {
  console.error(USAGE);
  process.exit(2);
}

// --- catalog sources ---------------------------------------------------------

/** Run one `sqlite3 -json` query; rows as objects. The path is made absolute so a name starting with `-` can never be read as an option. */
function sq(file, sql) {
  const r = spawnSync("sqlite3", ["-json", "-readonly", resolve(file), sql], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) {
    console.error(`schema2ir: cannot run sqlite3 (${r.error.message}); install the sqlite3 command-line tool or export the catalog as JSON`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`schema2ir: sqlite3 failed: ${(r.stderr || "").trim()}`);
    process.exit(1);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

export function catalogFromSqlite(file) {
  const tables = sq(file, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const cols = sq(file, "SELECT m.name AS tbl, p.name, p.type, p.\"notnull\" AS not_null, p.dflt_value AS dflt, p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid");
  const fks = sq(file, "SELECT m.name AS tbl, f.id, f.seq, f.\"table\" AS ref, f.\"from\" AS col, f.\"to\" AS refcol FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, f.id, f.seq");
  const idx = indexes
    ? sq(file, "SELECT m.name AS tbl, i.name AS idx, i.\"unique\" AS uniq, c.name AS col, c.seqno FROM sqlite_master m JOIN pragma_index_list(m.name) i JOIN pragma_index_info(i.name) c WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, i.name, c.seqno")
    : [];
  const byTable = new Map(tables.map((t) => [t.name, { name: t.name, columns: [], foreignKeys: [], indexes: [] }]));
  for (const c of cols) byTable.get(c.tbl)?.columns.push({ name: c.name, type: c.type || null, primaryKey: c.pk > 0, nullable: !c.not_null && c.pk === 0, default: c.dflt ?? null });
  const fkGroups = new Map();
  for (const f of fks) {
    const key = JSON.stringify([f.tbl, f.id]);
    if (!fkGroups.has(key)) fkGroups.set(key, { tbl: f.tbl, columns: [], references: { table: f.ref, columns: [] } });
    const g = fkGroups.get(key);
    g.columns.push(f.col);
    g.references.columns.push(f.refcol);
  }
  for (const g of fkGroups.values()) byTable.get(g.tbl)?.foreignKeys.push({ columns: g.columns, references: g.references });
  const idxGroups = new Map();
  for (const i of idx) {
    const key = JSON.stringify([i.tbl, i.idx]);
    if (!idxGroups.has(key)) idxGroups.set(key, { tbl: i.tbl, name: i.idx, unique: !!i.uniq, columns: [] });
    if (i.col) idxGroups.get(key).columns.push(i.col);
  }
  for (const g of idxGroups.values()) byTable.get(g.tbl)?.indexes.push({ name: g.name, unique: g.unique, columns: g.columns });
  return { name: basename(file).replace(/\.(db|sqlite3?|db3)$/i, ""), dialect: "sqlite", tables: [...byTable.values()] };
}

// --- IR ------------------------------------------------------------------------

const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** Catalog exporters disagree on booleans (MySQL emits 0/1): accept the usual spellings. */
const isTrue = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "YES";
const isFalse = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "NO";

/** `column`/`index` ids need a table path; a name with a dot is escaped so ids stay unambiguous. */
const seg = (s) => String(s).replace(/\\/g, "\\\\").replace(/\./g, "\\.");

export function catalogToIR(cat, opts = {}) {
  const rootName = opts.name || cat.name || "database";
  const rootId = `db:${rootName}`;
  const nodes = [];
  const edges = [];
  const annotations = {};
  const add = (kind, from, to) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  const contains = (parent, id) => add("contains", parent, id);
  nodes.push({ id: rootId, kind: "database", name: rootName, attrs: cat.dialect ? { dialect: cat.dialect } : undefined });

  const tables = cat.tables ?? [];
  const hasSchemas = tables.some((t) => t.schema);
  const schemaIds = new Map();
  const tableId = (t) => (t.schema ? `table:${seg(t.schema)}.${seg(t.name)}` : `table:${seg(t.name)}`);
  const columnId = (t, c) => `column:${tableId(t).slice(6)}.${seg(c)}`;
  // keyed by the ESCAPED id, so {name:"a.b"} and {schema:"a",name:"b"} never collide
  const tableById = new Map();
  const columnsOf = new Map();
  for (const t of tables) {
    tableById.set(tableId(t), t);
    columnsOf.set(tableId(t), new Set((t.columns ?? []).map((c) => c.name)));
  }
  /** Catalog exporters (MySQL's information_schema) list one entry per column; merge by name. */
  const mergedIndexes = (t) => {
    const byName = new Map();
    for (const ix of t.indexes ?? []) {
      const cur = byName.get(ix.name);
      if (cur) {
        cur.columns.push(...(ix.columns ?? []));
        cur.unique = cur.unique || isTrue(ix.unique);
      } else byName.set(ix.name, { name: ix.name, unique: isTrue(ix.unique), columns: [...(ix.columns ?? [])] });
    }
    return [...byName.values()];
  };

  for (const t of tables) {
    let parent = rootId;
    if (hasSchemas) {
      const s = t.schema ?? "";
      if (!schemaIds.has(s)) {
        const sid = `schema:${seg(s || "(none)")}`;
        schemaIds.set(s, sid);
        nodes.push({ id: sid, kind: "schema", name: s || "(no schema)", parent: rootId });
        contains(rootId, sid);
      }
      parent = schemaIds.get(s);
    }
    const tid = tableId(t);
    const cols = t.columns ?? [];
    const fkCount = (t.foreignKeys ?? []).length;
    const node = { id: tid, kind: "table", name: t.name, parent, metrics: { columns: cols.length, foreignKeys: fkCount } };
    if (t.rows != null && Number.isFinite(Number(t.rows)) && Number(t.rows) >= 0) node.metrics.rows = Number(t.rows);
    nodes.push(node);
    contains(parent, tid);
    for (const c of cols) {
      const cid = columnId(t, c.name);
      const attrs = {};
      if (c.type) attrs.type = c.type;
      if (isTrue(c.primaryKey)) attrs.primaryKey = true;
      if (isFalse(c.nullable)) attrs.nullable = false;
      if (c.default != null) attrs.default = String(c.default);
      nodes.push({ id: cid, kind: "column", name: c.name, parent: tid, attrs: Object.keys(attrs).length ? attrs : undefined });
      contains(tid, cid);
      const bits = [c.type, isTrue(c.primaryKey) ? "primary key" : null, isFalse(c.nullable) ? "not null" : null].filter(Boolean);
      if (bits.length) annotations[cid] = { summary: bits.join(", ") };
    }
    if (opts.indexes !== false) {
      for (const ix of mergedIndexes(t)) {
        const iid = `index:${tid.slice(6)}.${seg(ix.name)}`;
        nodes.push({ id: iid, kind: "index", name: ix.name, parent: tid, attrs: { unique: ix.unique, columns: ix.columns.join(",") } });
        contains(tid, iid);
      }
    }
  }

  // foreign keys → references edges (one per column pair, deduplicated with a count)
  const refCount = new Map();
  let skipped = 0;
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      const ref = fk.references ?? {};
      const target =
        tableById.get(tableId({ schema: ref.schema, name: ref.table })) ??
        (t.schema && !ref.schema ? tableById.get(tableId({ schema: t.schema, name: ref.table })) : undefined);
      const fromCols = fk.columns ?? [];
      const toCols = ref.columns ?? [];
      if (!target) {
        skipped += Math.max(1, fromCols.length);
        continue;
      }
      const targetCols = columnsOf.get(tableId(target));
      // SQLite omits the referenced columns when they are the primary key: i-th FK column → i-th PK column
      const pkCols = (target.columns ?? []).filter((c) => isTrue(c.primaryKey)).map((c) => c.name);
      fromCols.forEach((col, i) => {
        const toCol = toCols[i] ?? pkCols[i];
        if (!columnsOf.get(tableId(t))?.has(col) || !toCol || !targetCols?.has(toCol)) {
          skipped++;
          return;
        }
        const from = columnId(t, col);
        const to = columnId(target, toCol);
        const id = `e:references:${from}->${to}`;
        refCount.set(id, (refCount.get(id) ?? 0) + 1);
        if (fk.name && !annotations[id]) annotations[id] = { label: `references (${fk.name})` };
      });
    }
  }
  for (const [id, count] of refCount) {
    const m = /^e:references:(.+?)->(column:.+)$/.exec(id);
    edges.push({ id, kind: "references", from: m[1], to: m[2], count });
  }
  if (skipped) console.error(`schema2ir: ${skipped} foreign-key column(s) point at tables or columns not in the catalog — skipped (see description)`);

  const columns = nodes.filter((n) => n.kind === "column").length;
  nodes.sort((a, b) => byteCmp(a.id, b.id));
  edges.sort((a, b) => byteCmp(a.id, b.id));
  for (const n of nodes) if (n.attrs === undefined) delete n.attrs;
  return {
    irVersion: "0.2",
    generator: { tool: "schema2ir", version: "0.1", commit: null },
    title: `Schema of ${rootName}`,
    description:
      `${tables.length} tables, ${columns} columns, ${refCount.size} foreign-key links` +
      (hasSchemas ? ` across ${schemaIds.size} schemas` : "") +
      (skipped ? `; ${skipped} foreign-key column(s) skipped (target not in catalog)` : "") +
      (cat.dialect ? ` (${cat.dialect})` : ""),
    root: rootId,
    nodes,
    edges,
    annotations,
  };
}

// --- main ----------------------------------------------------------------------

const catalog = sqlite !== null ? catalogFromSqlite(sqlite) : JSON.parse(jsonPath === "-" ? readFileSync(0, "utf8") : readFileSync(jsonPath, "utf8"));
const ir = catalogToIR(catalog, { name, indexes });
const text = JSON.stringify(ir, null, 2) + "\n";
if (out) {
  writeFileSync(out, text);
  console.error(`schema2ir: wrote ${out} (${ir.nodes.length} nodes, ${ir.edges.length} edges)`);
} else process.stdout.write(text);

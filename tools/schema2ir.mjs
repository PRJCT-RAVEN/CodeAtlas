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
//                   "columns": [ { "name": "id", "type": "bigint", "primaryKey": true, "primaryKeyOrdinal": 1, "nullable": false, "default": null } ],
//                   "foreignKeys": [ { "name": "orders_customer_fk", "columns": ["customer_id"],
//                                      "references": { "schema": "public", "table": "customers", "columns": ["id"] } } ],
//                   "indexes": [ { "name": "orders_customer_idx", "columns": ["customer_id"], "unique": false } ] } ] }
//
// `primaryKeyOrdinal` (1-based position in the primary key) and an index entry's
// `ordinal` are optional, and only matter where order does: an implicit composite
// foreign key pairs by key order, and per-column index entries are merged by it.
//
// IR: `db:<name>` root (kind database) > `schema:<s>` containers (only when the
// catalog has schemas) > `table:<s.t>` containers > `column:<s.t.c>` leaves (attrs
// type/primaryKey/nullable/default) and `index:<s.t.i>` leaves; one `references`
// edge per foreign-key column pair, deduplicated with a count. Foreign keys whose
// target is not in the catalog are counted in the description and on stderr —
// never dropped silently. Output is sorted in UTF-8 byte order and validates
// with schema/validate.mjs. The viewer's visibility budget does the rest.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: schema2ir.mjs (--sqlite <file> | --json <file|->) [-o out.json] [--name <root name>] [--no-indexes]";
/** Parse argv. Only called from the CLI block at the bottom: importing this module
 *  must not read process.argv, print usage, or exit. */
function parseArgs(argv) {
  let sqlite = null;
  let jsonPath = null;
  let out = null;
  let name = null;
  let indexes = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A flag whose value is missing used to swallow the next flag (or undefined) and die
    // in node:path; `-o` with nothing after it silently printed the graph to stdout. A
    // leading single dash is still a legal file name (`--sqlite -odd.db`).
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        console.error(`schema2ir: ${a} needs a value\n${USAGE}`);
        process.exit(2);
      }
      return v;
    };
    if (a === "--sqlite") sqlite = value();
    else if (a === "--json") jsonPath = value();
    else if (a === "-o") out = value();
    else if (a === "--name") name = value();
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

  return { sqlite, jsonPath, out, name, indexes };
}

// --- catalog sources ---------------------------------------------------------

// sqlite3's JSON output mode arrived in 3.33 (2020); the sqlite3 that Ubuntu 20.04 and
// macOS 11 ship is older, and all it says is "unknown option: -json" — which reads like
// our bug, not like "upgrade sqlite3 or use --json".
const SQLITE_JSON_MIN = [3, 33];

function sqliteTooOld() {
  const r = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  const m = r.status === 0 && /^(\d+)\.(\d+)(?:\.\d+)?/.exec((r.stdout || "").trim());
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < SQLITE_JSON_MIN[0] || (major === SQLITE_JSON_MIN[0] && minor < SQLITE_JSON_MIN[1]) ? m[0] : null;
}

const tooOldHint = (version) =>
  `schema2ir: your sqlite3 is ${version}; \`-json\` output needs ${SQLITE_JSON_MIN.join(".")} or newer — upgrade it, or export the catalog and pass --json (docs/schema-import.md)`;

/** Run one `sqlite3 -json` query; rows as objects. The path is made absolute so a name starting with `-` can never be read as an option. */
function sq(file, sql) {
  const r = spawnSync("sqlite3", ["-json", "-readonly", resolve(file), sql], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) {
    console.error(`schema2ir: cannot run sqlite3 (${r.error.message}); install the sqlite3 command-line tool or export the catalog as JSON`);
    process.exit(1);
  }
  const hintIfTooOld = () => {
    const version = sqliteTooOld();
    if (version) console.error(tooOldHint(version));
  };
  if (r.status !== 0) {
    console.error(`schema2ir: sqlite3 failed: ${(r.stderr || "").trim()}`);
    hintIfTooOld();
    process.exit(1);
  }
  if (!r.stdout.trim()) return [];
  try {
    return JSON.parse(r.stdout);
  } catch {
    console.error("schema2ir: sqlite3 answered with something that is not JSON");
    hintIfTooOld();
    process.exit(1);
  }
}

export function catalogFromSqlite(file, { indexes = true } = {}) {
  const tables = sq(file, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const cols = sq(file, "SELECT m.name AS tbl, p.name, p.type, p.\"notnull\" AS not_null, p.dflt_value AS dflt, p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid");
  const fks = sq(file, "SELECT m.name AS tbl, f.id, f.seq, f.\"table\" AS ref, f.\"from\" AS col, f.\"to\" AS refcol FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, f.id, f.seq");
  const idx = indexes
    ? sq(file, "SELECT m.name AS tbl, i.name AS idx, i.\"unique\" AS uniq, c.name AS col, c.seqno FROM sqlite_master m JOIN pragma_index_list(m.name) i JOIN pragma_index_info(i.name) c WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, i.name, c.seqno")
    : [];
  const byTable = new Map(tables.map((t) => [t.name, { name: t.name, columns: [], foreignKeys: [], indexes: [] }]));
  // pragma_table_info.pk is the column's 1-based position IN THE KEY, not a boolean:
  // `PRIMARY KEY (b, a)` gives b=1, a=2, and that is the order an implicit foreign key
  // pairs against. Collapsing it to a boolean inverted such pairings (see catalogToIR).
  for (const c of cols)
    byTable.get(c.tbl)?.columns.push({ name: c.name, type: c.type || null, primaryKey: c.pk > 0, primaryKeyOrdinal: c.pk > 0 ? c.pk : undefined, nullable: !c.not_null && c.pk === 0, default: c.dflt ?? null });
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
  return {
    name: basename(file).replace(/\.(db|sqlite3?|db3)$/i, ""),
    dialect: "sqlite",
    defaultSchema: "main", // SQLite's schema for everything not ATTACHed
    tables: [...byTable.values()],
  };
}

// --- IR ------------------------------------------------------------------------

const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** Catalog exporters disagree on booleans (MySQL emits 0/1): accept the usual spellings. */
const isTrue = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "YES";
const isFalse = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "NO";
/** An optional number from a catalog: absent, null and "" all mean "not stated" (NaN), never 0. */
const num = (v) => (v == null || v === "" ? NaN : Number(v));

/** `column`/`index` ids need a table path; a name with a dot is escaped so ids stay unambiguous. */
/** IR node names must be strings. A catalog can carry a JSON number for a column or a
 *  table name (`{"name": 1}`), and passing it straight through produced a graph the
 *  validator rejected — a silent invalid file, where the fix is one coercion. */
const str = (v) => (typeof v === "string" ? v : String(v));
const seg = (s) => String(s).replace(/\\/g, "\\\\").replace(/\./g, "\\.");

export function catalogToIR(cat, opts = {}) {
  const rootName = opts.name || cat?.name || "database";
  const rootId = `db:${rootName}`;
  const nodes = [];
  const edges = [];
  const annotations = {};
  const add = (kind, from, to) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  const contains = (parent, id) => add("contains", parent, id);
  nodes.push({ id: rootId, kind: "database", name: rootName, attrs: cat?.dialect ? { dialect: cat.dialect } : undefined });

  const tables = Array.isArray(cat?.tables) ? cat.tables : [];
  const hasSchemas = tables.some((t) => t.schema);
  const schemaIds = new Map();
  const groupParent = new Map(); // table id -> bucket id, when a level had to be bucketed
  let groupCount = 0;
  const tableId = (t) => (t.schema ? `table:${seg(t.schema)}.${seg(t.name)}` : `table:${seg(t.name)}`);
  const columnId = (t, c) => `column:${tableId(t).slice(6)}.${seg(c)}`;
  // keyed by the ESCAPED id, so {name:"a.b"} and {schema:"a",name:"b"} never collide
  const tableById = new Map();
  const columnsOf = new Map();
  for (const t of tables) {
    tableById.set(tableId(t), t);
    columnsOf.set(tableId(t), new Set((t.columns ?? []).map((c) => c.name)));
  }
  // SQLite and MySQL identifiers are case-insensitive, so a REFERENCES clause may spell
  // its target differently from the CREATE TABLE (`REFERENCES Users(ID)` for `users(id)`)
  // — matching exactly dropped foreign keys that the database really enforces. Postgres
  // identifiers ARE case-sensitive when quoted, so a folded key claimed by two objects
  // resolves to nothing rather than to a guess.
  const foldIndex = (pairs) => {
    const m = new Map();
    for (const [k, v] of pairs) {
      // String(): `catalogToIR` is exported, and a caller that skipped checkCatalog can
      // hand us a column whose `name` is a JSON number — .toLowerCase() then threw a
      // TypeError where the old code returned a graph
      const f = String(k).toLowerCase();
      m.set(f, m.has(f) ? null : v);
    }
    return m;
  };
  const tableByFold = foldIndex([...tableById]);
  const columnFoldOf = new Map([...columnsOf].map(([tid, names]) => [tid, foldIndex([...names].map((c) => [c, c]))]));
  const findTable = (id) => tableById.get(id) ?? tableByFold.get(id.toLowerCase()) ?? undefined;
  /** The catalog's own spelling of column `name` on table `tid`, or null if it has none. */
  const findColumn = (tid, name) => {
    if (name == null) return null;
    if (columnsOf.get(tid)?.has(name)) return name;
    return columnFoldOf.get(tid)?.get(String(name).toLowerCase()) ?? null;
  };
  /** Catalog exporters (MySQL's information_schema) list one entry per column; merge by
   *  name, and put the columns back in index order — `ordinal` (MySQL's SEQ_IN_INDEX)
   *  when the export carries it, since row order out of JSON_ARRAYAGG is not promised. */
  const mergedIndexes = (t) => {
    const byName = new Map();
    for (const ix of t.indexes ?? []) {
      const cur = byName.get(ix.name) ?? { name: ix.name, unique: false, cols: [] };
      cur.unique = cur.unique || isTrue(ix.unique);
      const ord = num(ix.ordinal);
      for (const c of ix.columns ?? []) cur.cols.push({ name: c, ord: Number.isFinite(ord) ? ord : null, seq: cur.cols.length });
      byName.set(ix.name, cur);
    }
    return [...byName.values()].map((ix) => ({
      name: ix.name,
      unique: ix.unique,
      columns: ix.cols.sort((a, b) => (a.ord ?? a.seq) - (b.ord ?? b.seq) || a.seq - b.seq).map((c) => c.name),
    }));
  };

  // Every table hangs under a SCHEMA container, even when the catalog has none.
  // The root node IS the viewer's canvas, so tables parented straight to it sit at
  // the top display level, where the visibility budget has nothing left to collapse:
  // a 2,000-table import opened with 2,000 visible nodes (measured 2026-09-10).
  const schemaOf = (t) => (hasSchemas ? t.schema ?? "" : cat?.defaultSchema ?? "(default)");
  for (const t of tables) {
    const s = schemaOf(t);
    if (!schemaIds.has(s)) {
      const sid = `schema:${seg(s || "(none)")}`;
      schemaIds.set(s, sid);
      nodes.push({ id: sid, kind: "schema", name: hasSchemas ? s || "(no schema)" : s, parent: rootId });
      contains(rootId, sid);
    }
  }

  // A schema holding more tables than the viewer shows at once gets an explicit
  // bucket level, so every level stays browsable instead of dumping thousands of
  // siblings: ~sqrt(k) buckets of ~sqrt(k), the shape the viewer already uses for
  // wide containers. Buckets are an IMPORT ARTIFACT, not database structure — they
  // are named for the range they hold and the description says how many there are.
  const BUCKET_ABOVE = 200;
  for (const [s, sid] of schemaIds) {
    const mine = tables.filter((t) => schemaOf(t) === s).sort((a, b) => byteCmp(a.name, b.name));
    if (mine.length <= BUCKET_ABOVE) continue;
    const per = Math.ceil(Math.sqrt(mine.length));
    for (let i = 0; i < mine.length; i += per) {
      const slice = mine.slice(i, i + per);
      const gid = `group:${seg(s || "(none)")}.${String(i / per).padStart(4, "0")}`;
      nodes.push({
        id: gid,
        kind: "group",
        name: slice.length > 1 ? `${slice[0].name} … ${slice[slice.length - 1].name}` : slice[0].name,
        parent: sid,
        metrics: { tables: slice.length },
      });
      contains(sid, gid);
      groupCount++;
      for (const t of slice) groupParent.set(tableId(t), gid);
    }
  }

  for (const t of tables) {
    const tid = tableId(t);
    const parent = groupParent.get(tid) ?? schemaIds.get(schemaOf(t));
    const cols = t.columns ?? [];
    const fkCount = (t.foreignKeys ?? []).length;
    const node = { id: tid, kind: "table", name: str(t.name), parent, metrics: { columns: cols.length, foreignKeys: fkCount } };
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
      nodes.push({ id: cid, kind: "column", name: str(c.name), parent: tid, attrs: Object.keys(attrs).length ? attrs : undefined });
      contains(tid, cid);
      const bits = [c.type, isTrue(c.primaryKey) ? "primary key" : null, isFalse(c.nullable) ? "not null" : null].filter(Boolean);
      if (bits.length) annotations[cid] = { summary: bits.join(", ") };
    }
    if (opts.indexes !== false) {
      for (const ix of mergedIndexes(t)) {
        const iid = `index:${tid.slice(6)}.${seg(ix.name)}`;
        nodes.push({ id: iid, kind: "index", name: str(ix.name), parent: tid, attrs: { unique: ix.unique, columns: ix.columns.join(",") } });
        contains(tid, iid);
      }
    }
  }

  // foreign keys → references edges (one per column pair, deduplicated with a count)
  const refs = new Map();
  let missingTable = 0;
  let missingColumn = 0;
  for (const t of tables) {
    const tid = tableId(t);
    for (const fk of t.foreignKeys ?? []) {
      const ref = fk.references ?? {};
      const target =
        findTable(tableId({ schema: ref.schema, name: ref.table })) ??
        (t.schema && !ref.schema ? findTable(tableId({ schema: t.schema, name: ref.table })) : undefined);
      const fromCols = fk.columns ?? [];
      const toCols = ref.columns ?? [];
      if (!target) {
        missingTable += Math.max(1, fromCols.length);
        continue;
      }
      const targetId = tableId(target);
      // SQLite omits the referenced columns when they are the target's primary key and
      // pairs the i-th FK column with the i-th PK column IN KEY ORDER — for
      // `PRIMARY KEY (b, a)` that is b, a, not the declaration order. Ordinals come from
      // the SQLite reader and from both SQL exports; a catalog without them leaves the
      // pairing a guess, and a guess is marked inferred rather than drawn as fact.
      const pk = (target.columns ?? []).filter((c) => isTrue(c.primaryKey));
      const ordered = pk.every((c) => Number.isFinite(num(c.primaryKeyOrdinal)));
      const pkCols = (ordered ? [...pk].sort((a, b) => num(a.primaryKeyOrdinal) - num(b.primaryKeyOrdinal)) : pk).map((c) => c.name);
      const guessed = toCols.length === 0 && pkCols.length > 1 && !ordered;
      fromCols.forEach((col, i) => {
        const fromCol = findColumn(tid, col);
        const toCol = findColumn(targetId, toCols[i] ?? pkCols[i]);
        if (!fromCol || !toCol) {
          missingColumn++;
          return;
        }
        const from = columnId(t, fromCol);
        const to = columnId(target, toCol);
        const id = `e:references:${from}->${to}`;
        const seen = refs.get(id);
        if (seen) seen.count++;
        else refs.set(id, { id, kind: "references", from, to, count: 1 });
        if (fk.name && !annotations[id]?.label) annotations[id] = { ...annotations[id], label: `references (${fk.name})` };
        if (guessed)
          annotations[id] = {
            ...annotations[id],
            inferred: true,
            summary: `inferred: ${target.name} has a composite primary key and this foreign key names no columns, so the pairing is by position — the catalog carries no key order`,
          };
      });
    }
  }
  // a loop, not a spread: `push(...map.values())` passes one argument per edge, and a
  // 10,000-table catalog with a few keys each is already past the argument-count limit
  // that turns into "RangeError: Maximum call stack size exceeded"
  for (const e of refs.values()) edges.push(e);
  if (missingTable) console.error(`schema2ir: ${missingTable} foreign-key column(s) reference tables that are not in the catalog — skipped (see description)`);
  if (missingColumn) console.error(`schema2ir: ${missingColumn} foreign-key column(s) reference columns their target table does not have — skipped (see description)`);
  const skipped = missingTable + missingColumn;

  const columns = nodes.filter((n) => n.kind === "column").length;
  nodes.sort((a, b) => byteCmp(a.id, b.id));
  edges.sort((a, b) => byteCmp(a.id, b.id));
  for (const n of nodes) if (n.attrs === undefined) delete n.attrs;
  return {
    irVersion: "0.2",
    generator: { tool: "schema2ir", version: "0.1", commit: null },
    title: `Schema of ${rootName}`,
    description:
      `${tables.length} tables, ${columns} columns, ${refs.size} foreign-key links` +
      (hasSchemas ? ` across ${schemaIds.size} schemas` : "") +
      (groupCount ? `; tables grouped into ${groupCount} name ranges so each level stays browsable` : "") +
      (skipped ? `; ${skipped} foreign-key column(s) skipped (target table or column not in the catalog)` : "") +
      (cat?.dialect ? ` (${cat.dialect})` : ""),
    root: rootId,
    nodes,
    edges,
    annotations,
  };
}

// --- CLI ------------------------------------------------------------------------

const fail = (msg) => {
  console.error(`schema2ir: ${msg}`);
  process.exit(1);
};

/** Read a `--json` catalog. Windows PowerShell 5.1 writes UTF-16 for `>` and a BOM for
 *  `Out-File -Encoding utf8`, and JSON.parse takes neither; worse, an uncaught parse
 *  error echoes the whole file (measured: 849 KB of stderr for an 849 KB catalog). */
function readCatalog(path) {
  const what = path === "-" ? "stdin" : path;
  let buf;
  try {
    buf = readFileSync(path === "-" ? 0 : path);
  } catch (e) {
    fail(`cannot read ${what}: ${e.message}`);
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) fail(`${what} is UTF-16BE; re-export it as UTF-8`);
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le", 2) : buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(
      `${what} is not valid JSON: ${String(e.message).slice(0, 200)}\n` +
        "  exported from mysql? the client doubles backslashes unless you pass -r/--raw\n" +
        "  exported from PowerShell? `>` writes UTF-16; use `| Out-File -Encoding utf8`",
    );
  }
}

/** What is wrong with a catalog, in the catalog's own terms. Shape errors used to
 *  surface as a TypeError from somewhere inside the IR builder. */
function checkCatalog(cat) {
  if (cat === null || typeof cat !== "object" || Array.isArray(cat)) return ["the catalog must be a JSON object with a `tables` array"];
  if (!Array.isArray(cat.tables)) return [cat.tables === undefined ? "the catalog has no `tables` array" : "`tables` must be an array"];
  const problems = [];
  cat.tables.forEach((t, i) => {
    const named = t !== null && typeof t === "object" && typeof t.name === "string" && t.name;
    const where = `tables[${i}]${named ? ` (${t.name})` : ""}`;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!named) {
      problems.push(`${where} has no \`name\``);
      return;
    }
    for (const key of ["columns", "foreignKeys", "indexes"]) {
      const v = t[key];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v)) problems.push(`${where}: \`${key}\` must be an array`);
      else v.forEach((e, j) => { if (e === null || typeof e !== "object" || Array.isArray(e)) problems.push(`${where}: ${key}[${j}] is not an object`); });
    }
    if (Array.isArray(t.columns))
      t.columns.forEach((c, j) => { if (c !== null && typeof c === "object" && typeof c.name !== "string") problems.push(`${where}: columns[${j}] has no \`name\``); });
    // One level deeper. Checking only the table-level arrays left the very crash this
    // function exists to prevent reachable one nesting level down: `ix.columns.join(",")`
    // and the foreign-key column pairing both assume arrays, and a hand-written or
    // half-translated catalog is exactly where they are not.
    if (Array.isArray(t.foreignKeys))
      t.foreignKeys.forEach((fk, j) => {
        if (fk === null || typeof fk !== "object" || Array.isArray(fk)) return; // already reported
        if (fk.columns !== undefined && !Array.isArray(fk.columns)) problems.push(`${where}: foreignKeys[${j}].columns must be an array`);
        const ref = fk.references;
        if (ref === undefined) return;
        if (ref === null || typeof ref !== "object" || Array.isArray(ref)) problems.push(`${where}: foreignKeys[${j}].references must be an object`);
        else if (ref.columns !== undefined && !Array.isArray(ref.columns)) problems.push(`${where}: foreignKeys[${j}].references.columns must be an array`);
      });
    if (Array.isArray(t.indexes))
      t.indexes.forEach((ix, j) => {
        if (ix === null || typeof ix !== "object" || Array.isArray(ix)) return; // already reported
        if (ix.columns !== undefined && !Array.isArray(ix.columns)) problems.push(`${where}: indexes[${j}].columns must be an array`);
      });
  });
  return problems;
}

/** True only when this file is the program being run, not an import. Realpaths both
 *  sides: Node resolves symlinks building import.meta.url, path.resolve does not. */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Validate our own output. This graph is often published straight over the live
 *  graph, so an invalid one would surface as the viewer's problem, several steps
 *  from the cause — and the exit code used to say 0 either way. */
async function selfCheck(ir) {
  let validateDocument;
  try {
    ({ validateDocument } = await import(resolve(dirname(fileURLToPath(import.meta.url)), "../schema/validate.mjs")));
  } catch (e) {
    // the validator needs `npm ci` in schema/; do not imply we checked when we did not
    console.error(`schema2ir: could not self-check the output (${e?.message ?? e}); run \`node schema/validate.mjs\` yourself`);
    return true;
  }
  const errors = validateDocument(ir);
  if (!errors.length) return true;
  console.error(`schema2ir: BUG — the graph this build produced is not valid IR (${errors.length} problem(s)):`);
  for (const e of errors.slice(0, 10)) console.error(`  - ${e}`);
  if (errors.length > 10) console.error(`  … and ${errors.length - 10} more`);
  console.error("schema2ir: refusing to write it; please report this with the catalog that caused it");
  return false;
}

if (isMain()) {
  const { sqlite, jsonPath, out, name, indexes } = parseArgs(process.argv.slice(2));
  const catalog = sqlite !== null ? catalogFromSqlite(sqlite, { indexes }) : readCatalog(jsonPath);
  const problems = checkCatalog(catalog);
  if (problems.length) {
    console.error(`schema2ir: ${sqlite ?? (jsonPath === "-" ? "stdin" : jsonPath)} is not a catalog schema2ir understands (docs/schema-import.md):`);
    for (const p of problems.slice(0, 10)) console.error(`  - ${p}`);
    if (problems.length > 10) console.error(`  … and ${problems.length - 10} more`);
    process.exit(1);
  }
  const ir = catalogToIR(catalog, { name, indexes });
  if (!(await selfCheck(ir))) process.exit(1);
  const text = JSON.stringify(ir, null, 2) + "\n";
  if (out) {
    writeFileSync(out, text);
    console.error(`schema2ir: wrote ${out} (${ir.nodes.length} nodes, ${ir.edges.length} edges, validated)`);
  } else process.stdout.write(text);
}

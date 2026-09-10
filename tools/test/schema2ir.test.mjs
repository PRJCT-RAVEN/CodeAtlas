import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogToIR } from "../schema2ir.mjs";
import { validateDocument as validateIR } from "../../schema/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, "../schema2ir.mjs");
const VALIDATE = join(here, "../../schema/validate.mjs");
const valid = (p) => execFileSync("node", [VALIDATE, p], { encoding: "utf8" });
// A missing sqlite3 must SKIP visibly, not pass silently: --sqlite is the path the
// codeatlas skill tells Claude to use, and it would lose its only coverage unnoticed.
const NO_SQLITE = !!spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).error && "sqlite3 CLI not on PATH; the JSON path is covered above";
const sqliteDb = (dir, sql) => {
  const db = join(dir, "app.db");
  execFileSync("sqlite3", [db, sql]);
  return db;
};

test("JSON catalog → IR: schemas, tables, columns, indexes, foreign keys (validates)", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-"));
  const cat = {
    name: "shop",
    dialect: "postgres",
    tables: [
      { schema: "public", name: "customers", columns: [{ name: "id", type: "bigint", primaryKey: true, nullable: false }, { name: "email", type: "text", nullable: false }], indexes: [{ name: "customers_email_key", columns: ["email"], unique: true }] },
      { schema: "public", name: "orders", rows: 42, columns: [{ name: "id", type: "bigint", primaryKey: true }, { name: "customer_id", type: "bigint" }, { name: "total", type: "numeric(10,2)", default: "0" }],
        foreignKeys: [{ name: "orders_customer_fk", columns: ["customer_id"], references: { schema: "public", table: "customers", columns: ["id"] } }] },
      { schema: "audit", name: "log", columns: [{ name: "id", type: "bigint", primaryKey: true }, { name: "order_id", type: "bigint" }],
        foreignKeys: [{ columns: ["order_id"], references: { schema: "public", table: "orders", columns: ["id"] } }, { columns: ["id"], references: { table: "ghost", columns: ["id"] } }] },
    ],
  };
  const catPath = join(dir, "cat.json");
  const out = join(dir, "ir.json");
  writeFileSync(catPath, JSON.stringify(cat));
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /1 foreign-key column\(s\) reference tables that are not in the catalog/);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(ir.root, "db:shop");
  const kinds = {};
  for (const n of ir.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { database: 1, schema: 2, table: 3, column: 7, index: 1 });
  const refs = ir.edges.filter((e) => e.kind === "references").map((e) => e.id).sort();
  assert.deepEqual(refs, ["e:references:column:audit.log.order_id->column:public.orders.id", "e:references:column:public.orders.customer_id->column:public.customers.id"]);
  assert.equal(ir.annotations["e:references:column:public.orders.customer_id->column:public.customers.id"].label, "references (orders_customer_fk)");
  assert.equal(ir.nodes.find((n) => n.id === "table:public.orders").metrics.rows, 42);
  assert.equal(ir.nodes.find((n) => n.id === "column:public.orders.total").attrs.default, "0");
  assert.match(ir.description, /3 tables, 7 columns, 2 foreign-key links across 2 schemas; 1 foreign-key column\(s\) skipped/);
  // --no-indexes and --name
  const r2 = spawnSync("node", [TOOL, "--json", catPath, "--no-indexes", "--name", "renamed"], { encoding: "utf8" });
  const ir2 = JSON.parse(r2.stdout);
  assert.equal(ir2.root, "db:renamed");
  assert.ok(!ir2.nodes.some((n) => n.kind === "index"));
  rmSync(dir, { recursive: true, force: true });
});

test("SQLite database → IR through the sqlite3 CLI (validates; FK to a primary key resolved)", { skip: NO_SQLITE }, () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-sqlite-"));
  const db = sqliteDb(dir, `
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users, title TEXT);
    CREATE TABLE tags (post_id INTEGER REFERENCES posts(id), name TEXT, PRIMARY KEY (post_id, name));
    CREATE INDEX posts_author ON posts(author_id);
  `);
  const out = join(dir, "ir.json");
  const r = spawnSync("node", [TOOL, "--sqlite", db, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(ir.root, "db:app");
  // SQLite's schema is literally "main", and tables must NOT hang off the root: the
  // root is the viewer's canvas, so a top-level table cannot be collapsed by the
  // visibility budget (a 2,000-table import opened with 2,000 visible nodes).
  const schema = ir.nodes.find((n) => n.kind === "schema");
  assert.equal(schema?.id, "schema:main");
  assert.equal(schema.parent, ir.root);
  assert.ok(ir.nodes.filter((n) => n.kind === "table").every((t) => t.parent === "schema:main"));
  assert.ok(!ir.nodes.some((n) => n.parent === ir.root && n.kind === "table"), "no table directly under the root");
  const refs = ir.edges.filter((e) => e.kind === "references").map((e) => e.id).sort();
  assert.deepEqual(refs, ["e:references:column:posts.author_id->column:users.id", "e:references:column:tags.post_id->column:posts.id"]);
  const email = ir.nodes.find((n) => n.id === "column:users.email");
  assert.equal(email.attrs.nullable, false);
  assert.equal(ir.annotations["column:users.id"].summary, "INTEGER, primary key, not null");
  assert.ok(ir.nodes.some((n) => n.id === "index:posts.posts_author"));
  assert.ok(ir.nodes.some((n) => n.kind === "index" && n.attrs.unique === true), "the UNIQUE constraint's autoindex is listed");
  // a file name starting with "-" must not be taken for a sqlite3 option
  copyFileSync(db, join(dir, "-odd.db"));
  const odd = spawnSync("node", [TOOL, "--sqlite", "-odd.db"], { encoding: "utf8", cwd: dir });
  assert.equal(odd.status, 0, odd.stderr);
  assert.equal(JSON.parse(odd.stdout).root, "db:-odd");
  rmSync(dir, { recursive: true, force: true });
});

test("a large catalog stays linear: 10,000 tables in a few seconds, validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-big-"));
  const tables = [];
  const pick = (i, salt) => (Math.imul(i + salt, 2654435761) >>> 0) % i;
  for (let t = 0; t < 10_000; t++) {
    const fks = [];
    if (t > 0) fks.push({ columns: ["ref_a"], references: { schema: `s${pick(t, 1) % 50}`, table: `t${pick(t, 1)}`, columns: ["id"] } });
    tables.push({ schema: `s${t % 50}`, name: `t${t}`, columns: [{ name: "id", type: "bigint", primaryKey: true }, { name: "ref_a", type: "bigint" }, { name: "v", type: "text" }], foreignKeys: fks });
  }
  const catPath = join(dir, "cat.json");
  writeFileSync(catPath, JSON.stringify({ name: "big", tables }));
  const out = join(dir, "ir.json");
  const t0 = Date.now();
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", out], { encoding: "utf8", maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, r.stderr);
  const ms = Date.now() - t0;
  assert.ok(ms < 20_000, `took ${ms} ms`);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(ir.nodes.length, 1 + 50 + 10_000 + 30_000);
  assert.equal(ir.edges.filter((e) => e.kind === "references").length, 9_999);
  console.log(`schema2ir: 10,000 tables → ${ir.nodes.length} nodes in ${ms} ms`);
  rmSync(dir, { recursive: true, force: true });
});

test("MySQL-shaped catalogs: per-column index entries merge, dotted names never collide, composite implicit PK", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-mysql-"));
  const cat = {
    name: "shop",
    tables: [
      { name: "a.b", columns: [{ name: "id", type: "int", primaryKey: 1 }] },
      { schema: "a", name: "b", columns: [{ name: "id", type: "int", primaryKey: 1 }, { name: "x", type: "int" }],
        indexes: [{ name: "ab_idx", columns: ["id"], unique: 0 }, { name: "ab_idx", columns: ["x"], unique: 0 }, { name: "u", columns: ["x"], unique: 1 }] },
      { schema: "a", name: "c", columns: [{ name: "id", type: "int", primaryKey: true }, { name: "ref", type: "int", nullable: "NO" }],
        foreignKeys: [{ name: "c_b", columns: ["ref"], references: { schema: "a", table: "b", columns: ["id"] } }] },
      { schema: "a", name: "parent", columns: [{ name: "k1", type: "int", primaryKey: true }, { name: "k2", type: "int", primaryKey: true }] },
      { schema: "a", name: "child", columns: [{ name: "p1", type: "int" }, { name: "p2", type: "int" }],
        foreignKeys: [{ columns: ["p1", "p2"], references: { schema: "a", table: "parent", columns: [] } }] },
    ],
  };
  const catPath = join(dir, "cat.json");
  const out = join(dir, "ir.json");
  writeFileSync(catPath, JSON.stringify(cat));
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  const idx = ir.nodes.filter((n) => n.kind === "index");
  assert.deepEqual(idx.map((n) => [n.name, n.attrs.columns, n.attrs.unique]).sort(), [["ab_idx", "id,x", false], ["u", "x", true]]);
  assert.ok(ir.nodes.some((n) => n.id === "table:a\\.b"), "dotted table name escaped");
  assert.ok(ir.nodes.some((n) => n.id === "table:a.b"), "schema a, table b");
  const refs = ir.edges.filter((e) => e.kind === "references").map((e) => e.id).sort();
  assert.deepEqual(refs, [
    "e:references:column:a.c.ref->column:a.b.id",
    "e:references:column:a.child.p1->column:a.parent.k1",
    "e:references:column:a.child.p2->column:a.parent.k2",
  ]);
  assert.equal(ir.nodes.find((n) => n.id === "column:a.c.ref").attrs.nullable, false, "\"NO\" is a boolean too");
  // this catalog carries no primaryKeyOrdinal, so pairing p1/p2 against a two-column
  // primary key is positional guesswork — it must be drawn as a guess
  const guess = ir.annotations["e:references:column:a.child.p1->column:a.parent.k1"];
  assert.equal(guess?.inferred, true, "a composite pairing with no key order is inferred");
  assert.match(guess.summary, /composite primary key/);
  assert.ok(!ir.annotations["e:references:column:a.c.ref->column:a.b.id"]?.inferred, "an explicit column list is not a guess");
  rmSync(dir, { recursive: true, force: true });
});

// --- big imports stay browsable (2026-09-10) ------------------------------------

test("a schema with more tables than the viewer shows is split into name-range groups", () => {
  const tables = Array.from({ length: 500 }, (_, i) => ({
    name: `t${String(i).padStart(3, "0")}`,
    columns: [{ name: "id", primaryKey: true }],
  }));
  const ir = catalogToIR({ name: "big", dialect: "sqlite", defaultSchema: "main", tables });
  const groups = ir.nodes.filter((n) => n.kind === "group");
  assert.ok(groups.length > 1 && groups.length < 60, `expected ~sqrt(500) groups, got ${groups.length}`);
  assert.ok(groups.every((g) => g.parent === "schema:main"));
  // every table is in exactly one group, and no table is left on the schema
  const inGroup = ir.nodes.filter((n) => n.kind === "table" && groups.some((g) => g.id === n.parent));
  assert.equal(inGroup.length, 500);
  // the group name says what it holds, and the description admits the grouping
  assert.match(groups[0].name, / … /);
  assert.match(ir.description, /grouped into \d+ name ranges/);
  assert.deepEqual(validateIR(ir), []);
});

test("a small database is untouched: no groups, tables straight under the schema", () => {
  const tables = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, columns: [{ name: "id" }] }));
  const ir = catalogToIR({ name: "small", dialect: "sqlite", defaultSchema: "main", tables });
  assert.equal(ir.nodes.filter((n) => n.kind === "group").length, 0);
  assert.ok(ir.nodes.filter((n) => n.kind === "table").every((t) => t.parent === "schema:main"));
  assert.doesNotMatch(ir.description, /name ranges/);
});

test("a catalog that would produce invalid IR is refused, not written", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-invalid-"));
  const cat = join(dir, "dup.json");
  const outPath = join(dir, "out.json");
  // two tables with the same name -> duplicate node ids
  writeFileSync(cat, JSON.stringify({ name: "dup", tables: [{ name: "a", columns: [{ name: "x" }] }, { name: "a", columns: [{ name: "x" }] }] }));
  const r = spawnSync("node", [TOOL, "--json", cat, "-o", outPath], { encoding: "utf8" });
  assert.equal(r.status, 1, "must exit non-zero");
  assert.match(r.stderr, /not valid IR/);
  assert.match(r.stderr, /duplicate node id/);
  assert.ok(!existsSync(outPath), "must not write the invalid graph");
  rmSync(dir, { recursive: true, force: true });
});

// --- foreign keys must be the ones the database enforces (2026-09-10) ------------

test("SQLite: a REFERENCES clause in another case still resolves — identifiers are case-insensitive", { skip: NO_SQLITE }, () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-case-"));
  // the FK is real and enforced; only the SPELLING differs from CREATE TABLE
  const db = sqliteDb(dir, `
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, uid INTEGER REFERENCES Users(ID));
  `);
  const out = join(dir, "ir.json");
  const r = spawnSync("node", [TOOL, "--sqlite", db, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /skipped/, "nothing to skip: users is right there");
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(
    ir.edges.filter((e) => e.kind === "references").map((e) => e.id),
    ["e:references:column:posts.uid->column:users.id"],
    "the edge uses the catalog's spelling of the target, not the REFERENCES clause's",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("SQLite: an implicit composite foreign key pairs in KEY order, not declaration order", { skip: NO_SQLITE }, () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-pkorder-"));
  const db = sqliteDb(dir, `
    CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (b, a));
    CREATE TABLE child (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES parent);
  `);
  // ground truth from the engine itself: with parent(a=1, b=2), child(2, 1) is accepted
  // and child(1, 2) is refused — so x pairs with b and y with a
  execFileSync("sqlite3", [db, "PRAGMA foreign_keys=ON; INSERT INTO parent VALUES (1,2); INSERT INTO child VALUES (2,1);"]);
  const wrongWay = spawnSync("sqlite3", [db, "PRAGMA foreign_keys=ON; INSERT INTO child VALUES (1,2);"], { encoding: "utf8" });
  assert.notEqual(wrongWay.status, 0, "the inverted pairing must be the one the database refuses");
  const out = join(dir, "ir.json");
  const r = spawnSync("node", [TOOL, "--sqlite", db, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(ir.edges.filter((e) => e.kind === "references").map((e) => e.id).sort(), [
    "e:references:column:child.x->column:parent.b",
    "e:references:column:child.y->column:parent.a",
  ]);
  // SQLite hands us the key order, so this is knowledge, not a guess
  assert.ok(!Object.values(ir.annotations).some((a) => a.inferred), "nothing here is inferred");
  rmSync(dir, { recursive: true, force: true });
});

test("case-folded lookups: an ambiguous fold resolves to nothing, and stderr says which half is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-fold-"));
  const cat = {
    name: "folds",
    tables: [
      // quoted Postgres identifiers really are distinct, so "Users" vs "users" must not be guessed
      { schema: "s", name: "Users", columns: [{ name: "id", primaryKey: true, primaryKeyOrdinal: 1 }] },
      { schema: "s", name: "users", columns: [{ name: "id", primaryKey: true, primaryKeyOrdinal: 1 }] },
      { schema: "s", name: "ambiguous", columns: [{ name: "uid" }], foreignKeys: [{ columns: ["uid"], references: { schema: "s", table: "USERS", columns: ["id"] } }] },
      { schema: "s", name: "posts", columns: [{ name: "oid" }], foreignKeys: [{ columns: ["oid"], references: { schema: "S", table: "Orders", columns: ["ID"] } }] },
      { schema: "s", name: "orders", columns: [{ name: "Id", primaryKey: true, primaryKeyOrdinal: 1 }] },
      { schema: "s", name: "typo", columns: [{ name: "oid" }], foreignKeys: [{ columns: ["oid"], references: { schema: "s", table: "orders", columns: ["nosuch"] } }] },
    ],
  };
  const catPath = join(dir, "cat.json");
  const out = join(dir, "ir.json");
  writeFileSync(catPath, JSON.stringify(cat));
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(valid(out), /VALID/);
  const ir = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(
    ir.edges.filter((e) => e.kind === "references").map((e) => e.id),
    ["e:references:column:s.posts.oid->column:s.orders.Id"],
    "the folded match uses the catalog's own spelling; the ambiguous one is dropped",
  );
  assert.match(r.stderr, /1 foreign-key column\(s\) reference tables that are not in the catalog/);
  assert.match(r.stderr, /1 foreign-key column\(s\) reference columns their target table does not have/);
  assert.match(ir.description, /2 foreign-key column\(s\) skipped/);
  rmSync(dir, { recursive: true, force: true });
});

test("edge endpoints survive an identifier containing '->'", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-arrow-"));
  const cat = { name: "arrow", tables: [
    { name: "u", columns: [{ name: "v", primaryKey: true }] },
    { name: "q->column:r", columns: [{ name: "s" }], foreignKeys: [{ columns: ["s"], references: { table: "u", columns: ["v"] } }] },
  ] };
  const catPath = join(dir, "cat.json");
  const out = join(dir, "ir.json");
  writeFileSync(catPath, JSON.stringify(cat));
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(valid(out), /VALID/);
  const edge = JSON.parse(readFileSync(out, "utf8")).edges.find((e) => e.kind === "references");
  assert.equal(edge.from, "column:q->column:r.s");
  assert.equal(edge.to, "column:u.v");
  rmSync(dir, { recursive: true, force: true });
});

// --- what a bad input looks like (2026-09-10) -----------------------------------

test("a catalog that is not JSON is named, not dumped: no stack trace, no 849 KB of stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-badjson-"));
  const catPath = join(dir, "cat.json");
  const tables = Array.from({ length: 20_000 }, (_, i) => ({ name: `t${i}`, columns: [{ name: "c" }] }));
  writeFileSync(catPath, JSON.stringify({ name: "x", tables }).slice(0, -30)); // truncated export
  const r = spawnSync("node", [TOOL, "--json", catPath, "-o", join(dir, "out.json")], { encoding: "utf8", maxBuffer: 1 << 30 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cat\.json is not valid JSON/);
  assert.doesNotMatch(r.stderr, /node:internal|at JSON\.parse/, "no Node stack");
  assert.ok(r.stderr.length < 2_000, `stderr was ${r.stderr.length} bytes of the user's schema`);
  assert.ok(!existsSync(join(dir, "out.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("a catalog with a BOM or in UTF-16LE is read, not rejected (PowerShell redirection)", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-bom-"));
  const cat = JSON.stringify({ name: "enc", tables: [{ name: "t", columns: [{ name: "c" }] }] });
  const run = (file) => spawnSync("node", [TOOL, "--json", join(dir, file)], { encoding: "utf8" });
  writeFileSync(join(dir, "bom.json"), "﻿" + cat);
  writeFileSync(join(dir, "u16.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cat, "utf16le")]));
  for (const f of ["bom.json", "u16.json"]) {
    const r = run(f);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).root, "db:enc", f);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a mis-shaped catalog names the offending table; a flag without a value names the flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-shape-"));
  const shapes = [
    [{ tables: "nope" }, /`tables` must be an array/],
    [{ tables: [null] }, /tables\[0\] is not an object/],
    [{ tables: [{ name: "ok", columns: [{ name: "c" }] }, { columns: [] }] }, /tables\[1\] has no `name`/],
    [{ tables: [{ name: "t", columns: { a: 1 } }] }, /tables\[0\] \(t\): `columns` must be an array/],
    [{ tables: [{ name: "t", foreignKeys: [null] }] }, /tables\[0\] \(t\): foreignKeys\[0\] is not an object/],
    [{ tables: [{ name: "t", columns: [{ nam: "c" }] }] }, /tables\[0\] \(t\): columns\[0\] has no `name`/],
    // one nesting level down: the table-level arrays were checked, their contents were not,
    // so `ix.columns.join(",")` and the FK column pairing still crashed on a hand-written catalog
    [{ tables: [{ name: "t", indexes: [{ name: "i", columns: "c" }] }] }, /tables\[0\] \(t\): indexes\[0\]\.columns must be an array/],
    [{ tables: [{ name: "t", foreignKeys: [{ columns: "c", references: { table: "u" } }] }] }, /tables\[0\] \(t\): foreignKeys\[0\]\.columns must be an array/],
    [{ tables: [{ name: "t", foreignKeys: [{ columns: ["c"], references: "u" }] }] }, /tables\[0\] \(t\): foreignKeys\[0\]\.references must be an object/],
    [{ tables: [{ name: "t", foreignKeys: [{ columns: ["c"], references: { table: "u", columns: "d" } }] }] }, /foreignKeys\[0\]\.references\.columns must be an array/],
    [["not", "an", "object"], /must be a JSON object with a `tables` array/],
    [{ name: "x" }, /no `tables` array/],
  ];
  const catPath = join(dir, "cat.json");
  const outPath = join(dir, "out.json");
  for (const [cat, expected] of shapes) {
    writeFileSync(catPath, JSON.stringify(cat));
    const r = spawnSync("node", [TOOL, "--json", catPath, "-o", outPath], { encoding: "utf8" });
    assert.equal(r.status, 1, JSON.stringify(cat));
    assert.match(r.stderr, expected);
    assert.doesNotMatch(r.stderr, /node:internal|TypeError/, "a shape error is not a crash");
    assert.ok(!existsSync(outPath), "nothing written");
  }
  for (const argv of [["--sqlite"], ["--json"], ["--json", catPath, "-o"], ["--json", catPath, "--name"], ["--sqlite", "--json", catPath]]) {
    const r = spawnSync("node", [TOOL, ...argv], { encoding: "utf8" });
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /needs a value/);
    assert.match(r.stderr, /usage: schema2ir/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("an sqlite3 too old for -json says so instead of leaving the flag error unexplained", { skip: process.platform === "win32" && "needs a POSIX shell for the stub" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-old-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (version, error) => writeFileSync(join(bin, "sqlite3"), `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "${version} 2020-01-27 19:55:54"; exit 0; fi\necho "sqlite3: Error: ${error}" >&2\nexit 1\n`, { mode: 0o755 });
  const run = () => spawnSync("node", [TOOL, "--sqlite", join(dir, "any.db")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  stub("3.31.1", "unknown option: -json");
  const old = run();
  assert.equal(old.status, 1);
  assert.match(old.stderr, /unknown option: -json/);
  assert.match(old.stderr, /your sqlite3 is 3\.31\.1; .*needs 3\.33 or newer/);
  assert.match(old.stderr, /--json/, "and points at the escape hatch");

  // a current sqlite3 failing for its own reasons must not be blamed on its version
  stub("3.54.0", "no such table: x");
  const fine = run();
  assert.equal(fine.status, 1);
  assert.match(fine.stderr, /no such table: x/);
  assert.doesNotMatch(fine.stderr, /3\.33 or newer/);
  rmSync(dir, { recursive: true, force: true });
});

test("per-column index entries merge back into index order, not row order", () => {
  // MySQL emits one STATISTICS row per index column with SEQ_IN_INDEX; JSON_ARRAYAGG
  // promises no order, so the ordinal is what puts (a, b, c) back together
  const ir = catalogToIR({
    name: "ix",
    tables: [{ name: "t", columns: [{ name: "a" }, { name: "b" }, { name: "c" }], indexes: [
      { name: "abc", columns: ["c"], unique: 0, ordinal: 3 },
      { name: "abc", columns: ["a"], unique: 0, ordinal: 1 },
      { name: "abc", columns: ["b"], unique: 0, ordinal: 2 },
      { name: "noord", columns: ["b"], unique: 1 },
      { name: "noord", columns: ["a"], unique: 0 },
    ] }],
  });
  const idx = ir.nodes.filter((n) => n.kind === "index");
  assert.deepEqual(idx.map((n) => [n.name, n.attrs.columns, n.attrs.unique]), [
    ["abc", "a,b,c", false],
    ["noord", "b,a", true], // no ordinals: the export's own order stands
  ]);
  assert.deepEqual(validateIR(ir), []);
});

// `catalogToIR` is exported, so a caller can skip the CLI's checkCatalog. A column whose
// name is a JSON number then reached foldIndex, where `k.toLowerCase()` threw a TypeError
// — a crash where the old code returned a graph.
test("catalogToIR survives a non-string column name instead of throwing", () => {
  const cat = {
    tables: [
      { name: "t", columns: [{ name: 1 }, { name: "ok" }] },
      { name: "u", columns: [{ name: "fk" }], foreignKeys: [{ columns: ["fk"], references: { table: "t", columns: ["ok"] } }] },
    ],
  };
  const ir = catalogToIR(cat, { name: "m" });
  assert.equal(ir.irVersion, "0.2");
  assert.ok(ir.nodes.some((n) => n.kind === "column"));
  assert.deepEqual(validateIR(ir), [], "and the graph it returns is still valid IR");
});

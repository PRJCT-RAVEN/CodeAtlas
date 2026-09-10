import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogToIR } from "../schema2ir.mjs";
import { validateDocument as validateIR } from "../../schema/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, "../schema2ir.mjs");
const VALIDATE = join(here, "../../schema/validate.mjs");
const valid = (p) => execFileSync("node", [VALIDATE, p], { encoding: "utf8" });

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
  assert.match(r.stderr, /1 foreign-key column\(s\) point at tables or columns not in the catalog/);
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

test("SQLite database → IR through the sqlite3 CLI (validates; FK to a primary key resolved)", (t) => {
  const has = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  if (has.error) return t.skip("sqlite3 CLI not on PATH; the JSON path is covered above");
  const dir = mkdtempSync(join(tmpdir(), "schema2ir-sqlite-"));
  const db = join(dir, "app.db");
  execFileSync("sqlite3", [db, `
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users, title TEXT);
    CREATE TABLE tags (post_id INTEGER REFERENCES posts(id), name TEXT, PRIMARY KEY (post_id, name));
    CREATE INDEX posts_author ON posts(author_id);
  `]);
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

# Importing a database schema

`tools/schema2ir.mjs` turns a database catalog into Graph IR without any model in the
loop: `db` root → `schema` containers (when the catalog has schemas) → `table`
containers → `column` and `index` leaves, with one `references` edge per foreign-key
column pair. The viewer's visibility budget then shows schemas first, tables on expand,
columns on the next expand; search finds a column name inside collapsed tables.

## SQLite (read directly)

```sh
node tools/schema2ir.mjs --sqlite app.db -o ~/.codeatlas/live/graph.json
```

Needs the `sqlite3` command-line tool (macOS ships it; `apt install sqlite3`;
Windows: sqlite.org "sqlite-tools"). Three queries over pragma table-valued functions,
so a file with 10,000 tables is still three processes.

## PostgreSQL and MySQL (export the catalog as JSON)

```sh
psql -At -d mydb -f docs/schema-import/postgres.sql > schema.json
mysql -N -B -e "source docs/schema-import/mysql.sql" mydb > schema.json
node tools/schema2ir.mjs --json schema.json -o ~/.codeatlas/live/graph.json
```

The two SQL files were written against the system catalogs but are not executed in
this repository's CI (there is no server here); if one misbehaves on your version, the
JSON contract below is small enough to produce any other way.

## The catalog contract (`--json`)

```json
{
  "name": "shop",
  "dialect": "postgres",
  "tables": [
    {
      "schema": "public",
      "name": "orders",
      "rows": 12345,
      "columns": [
        { "name": "id", "type": "bigint", "primaryKey": true, "nullable": false, "default": null },
        { "name": "customer_id", "type": "bigint", "nullable": false }
      ],
      "foreignKeys": [
        { "name": "orders_customer_fk", "columns": ["customer_id"],
          "references": { "schema": "public", "table": "customers", "columns": ["id"] } }
      ],
      "indexes": [ { "name": "orders_customer_idx", "columns": ["customer_id"], "unique": false } ]
    }
  ]
}
```

Everything except `name` (table and column) is optional. Booleans may be `true`/`false`,
`1`/`0` or `"YES"`/`"NO"` (MySQL). `schema` may be omitted (SQLite); `references.schema`
defaults to the referencing table's schema. Foreign keys whose target is not in the
catalog are counted in the graph's description and reported on stderr, never dropped
silently. `--no-indexes` leaves index nodes out; `--name` sets the root name.

## Size

10,000 tables with 30,000 columns → 40,051 nodes in about 2 s; the output validates with
`schema/validate.mjs` and opens in the viewer under its budget (see CLAUDE.md, "Big
graphs"). Column-level detail for a whole database is not something to look at in one
view; it is there so that any table can be expanded and any column found.

## Shape of the result

`db:<name>` (the canvas) > `schema:<s>` > `table:<s.t>` > `column:` / `index:` leaves.

Catalogs without schemas still get one container — SQLite's is its real default schema,
`main`. This matters: the root node *is* the viewer's canvas, so tables parented straight
to it would sit at the top display level where the visibility budget has nothing to
collapse, and a 2,000-table import opened with 2,000 visible nodes.

A schema holding more than 200 tables is split into `group:` containers of roughly
√n tables each, named for the range they hold (`orders … products`). These groups are an
**import artifact, not database structure** — the description says how many were created.
They keep every level browsable: a 2,000-table import opens as 1 schema + 45 groups
(46 visible nodes) instead of 2,000, and expanding a group shows ~45 tables.

The importer validates its own output before writing and exits non-zero if it is ever
invalid, since the result is usually published straight over the live graph.

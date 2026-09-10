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

Needs the `sqlite3` command-line tool, **3.33 or newer** — that release (2020-08-14)
added the `json` output mode this reads through. macOS ships it; `apt install sqlite3`;
Windows: sqlite.org "sqlite-tools". An older one fails with `unknown option: -json`,
and schema2ir then says so and points here; the way out is `--json` below. Three
queries over pragma table-valued functions, so a file with 10,000 tables is still
three processes.

## PostgreSQL and MySQL (export the catalog as JSON)

```sh
psql -At -d mydb -f docs/schema-import/postgres.sql > schema.json
mysql -N -B -r -e "source docs/schema-import/mysql.sql" mydb > schema.json
node tools/schema2ir.mjs --json schema.json -o ~/.codeatlas/live/graph.json
```

`-r` (`--raw`) on the MySQL line is required, not decoration: in batch mode the client
escapes its own output (backslash → `\\`), which doubles every backslash inside the
JSON the query builds — a `DEFAULT 'C:\path'` arrives wrong, and a value containing a
quote breaks the parse. `psql -At` does no such escaping, so the PostgreSQL line needs
nothing extra. On Windows PowerShell, redirect with `| Out-File -Encoding utf8` rather
than `>`, which writes UTF-16 (schema2ir decodes UTF-16LE and strips a BOM anyway, and
says so when it cannot).

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
defaults to the referencing table's schema. A foreign key that names no
`references.columns` pairs positionally against the target's primary key, so where the
key order differs from the declaration order — `PRIMARY KEY (b, a)` — give each key
column a `primaryKeyOrdinal` (1-based position in the key; both shipped SQL exports and
the SQLite reader do). Without it a composite pairing is a guess, and schema2ir marks
those edges `inferred` so the viewer draws them dashed with a "?" instead of as fact.
Index entries may carry an `ordinal` (MySQL's `SEQ_IN_INDEX`) when one index is exported
as one entry per column: the merge puts the columns back in that order.

Table and column names are matched case-insensitively when an exact match fails
(SQLite's `REFERENCES Users(ID)` finds `users(id)`), except where two objects fold to
the same name — the PostgreSQL case, where quoted identifiers really are distinct — in
which case nothing is matched rather than the wrong thing. Foreign keys whose target
table or column is not in the catalog are counted in the graph's description and
reported on stderr, never dropped silently. `--no-indexes` leaves index nodes out;
`--name` sets the root name. A catalog that is not valid JSON, or not shaped like the
above, is reported as such with the offending table's index — not as a stack trace.

### IDs, and what a rename looks like

Ids are paths built from names — `db:<root>`, `schema:<s>`, `table:<s.t>`,
`column:<s.t.c>`, `index:<s.t.i>` — with `\` and `.` inside a name backslash-escaped so
`{"name": "a.b"}` and `{"schema": "a", "name": "b"}` stay distinct. A catalog carries no
durable object identity (Postgres has `oid`, SQLite has nothing, MySQL nothing in
`information_schema`), and a name *is* the identity here, so re-importing after a rename
shows the old table removed and a new one added — in `tools/irdiff.mjs` and in the
viewer's delta colours — together with all of its columns, indexes and foreign-key
edges, and the renamed subtree's saved positions reset. Everything untouched by the
rename keeps its id and its place.

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

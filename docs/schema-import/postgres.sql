-- CodeAtlas catalog export for PostgreSQL → tools/schema2ir.mjs --json
--   psql -At -d mydb -f docs/schema-import/postgres.sql > schema.json
--   node tools/schema2ir.mjs --json schema.json -o ~/.codeatlas/live/graph.json
-- Written against pg_catalog (PostgreSQL 12+); `rows` is the planner's estimate
-- (-1 before the first ANALYZE). Not executed in this repo's CI — no server here.
select json_build_object(
  'name', current_database(),
  'dialect', 'postgres',
  'tables', coalesce(json_agg(t order by t.schema, t.name), '[]'::json)
)
from (
  select n.nspname as schema, c.relname as name, c.reltuples::bigint as rows,
    (select coalesce(json_agg(json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'nullable', not a.attnotnull,
        'primaryKey', exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)),
        -- position within the primary key: an implicit composite foreign key pairs in KEY order
        'primaryKeyOrdinal', (select k.ord from pg_index i, unnest(i.indkey) with ordinality k(attnum, ord)
                              where i.indrelid = c.oid and i.indisprimary and k.attnum = a.attnum),
        'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum), '[]'::json)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
    (select coalesce(json_agg(json_build_object(
        'name', con.conname,
        'columns', (select array_agg(a.attname order by k.ord)
                    from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum),
        'references', json_build_object(
          'schema', rn.nspname, 'table', rc.relname,
          'columns', (select array_agg(a.attname order by k.ord)
                      from unnest(con.confkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)))), '[]'::json)
     from pg_constraint con
     join pg_class rc on rc.oid = con.confrelid
     join pg_namespace rn on rn.oid = rc.relnamespace
     where con.conrelid = c.oid and con.contype = 'f') as "foreignKeys",
    (select coalesce(json_agg(json_build_object(
        'name', ic.relname, 'unique', i.indisunique,
        'columns', (select array_agg(a.attname order by k.ord)
                    from unnest(i.indkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum))), '[]'::json)
     from pg_index i join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = c.oid and not i.indisprimary) as indexes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
) t;

-- CodeAtlas catalog export for MySQL 8 / MariaDB 10.5+ → tools/schema2ir.mjs --json
--   mysql -N -B -e "source docs/schema-import/mysql.sql" mydb > schema.json
--   node tools/schema2ir.mjs --json schema.json -o ~/.codeatlas/live/graph.json
-- Composite foreign keys and multi-column indexes come out as one entry per
-- column (schema2ir merges them); `rows` is the storage engine's estimate.
-- Not executed in this repo's CI — no server here.
SELECT JSON_OBJECT(
  'name', DATABASE(), 'dialect', 'mysql',
  'tables', JSON_ARRAYAGG(JSON_OBJECT(
    'name', t.TABLE_NAME,
    'rows', t.TABLE_ROWS,
    'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                  'name', c.COLUMN_NAME, 'type', c.COLUMN_TYPE,
                  'nullable', c.IS_NULLABLE, 'primaryKey', c.COLUMN_KEY = 'PRI', 'default', c.COLUMN_DEFAULT))
                FROM information_schema.COLUMNS c
                WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME),
    'foreignKeys', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                      'name', k.CONSTRAINT_NAME, 'columns', JSON_ARRAY(k.COLUMN_NAME),
                      'references', JSON_OBJECT('table', k.REFERENCED_TABLE_NAME, 'columns', JSON_ARRAY(k.REFERENCED_COLUMN_NAME))))
                    FROM information_schema.KEY_COLUMN_USAGE k
                    WHERE k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL),
    'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                  'name', s.INDEX_NAME, 'unique', s.NON_UNIQUE = 0, 'columns', JSON_ARRAY(s.COLUMN_NAME)))
                FROM information_schema.STATISTICS s
                WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME AND s.INDEX_NAME <> 'PRIMARY')
  ))
)
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE';

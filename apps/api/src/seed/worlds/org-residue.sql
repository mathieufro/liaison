-- SPDX-License-Identifier: FSL-1.1-ALv2
--
-- What is left of one org in the database after a demo reset: every base table
-- with an `org_id` column, in every schema, with the number of rows that still
-- name the org (only tables holding some are returned). Link tables, approval
-- and signature tokens and app rows are all such tables, so an empty result
-- means no row of the prior org remains for a link or a token to open.
--
-- One parameter, $1: the org's id (uuid). `kernel.organizations` is keyed by
-- `id`, not `org_id`, so the org row itself is not read here.
SELECT schema_name, table_name, n FROM (
SELECT c.table_schema AS schema_name,
       c.table_name,
       (xpath(
         '/row/n/text()',
         query_to_xml(
           format('SELECT count(*) AS n FROM %I.%I WHERE org_id = %L::uuid',
                  c.table_schema, c.table_name, $1::text),
           false, true, '')
       ))[1]::text::int AS n
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.column_name = 'org_id'
  AND t.table_type = 'BASE TABLE'
  AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
) AS counted
WHERE n > 0
ORDER BY 1, 2

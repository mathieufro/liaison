// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { DEMO_ORG_VARIANTS } from "@liaison/shared"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

/** Validate SQL identifier to prevent injection in DDL statements where parameterization is impossible. */
export function validateIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return name
}

/**
 * Partial-index / partial-unique `WHERE` clauses are interpolated verbatim into
 * DDL run by a privileged DB role — parameterization is impossible there. The
 * manifest JSON Schema (`manifest-schema.ts`) is the first gate, but this is the
 * defense-in-depth gate at the emission site: a manifest descriptor that reaches
 * the DDL generator another way (or a bypassed schema check) is still bounded to
 * a small, safe comparison grammar.
 *
 * Allowed grammar — simple boolean predicates only:
 *   `<column> IS [NOT] NULL`
 *   `<column> <op> <literal>`        op ∈ = <> != < <= > >=  (and `IS [NOT] DISTINCT FROM`)
 *   joined by `AND` / `OR`
 * where `<column>` is a bare snake_case identifier, and `<literal>` is a single-
 * quoted string, number, or boolean/NULL keyword. No parentheses, no subqueries,
 * no function calls, no comments, no statement separators.
 */
const WHERE_TERM =
  // column  IS [NOT] NULL                      | column IS [NOT] DISTINCT FROM <literal> | column <op> <literal>
  "[a-z_][a-z0-9_]*\\s+(?:IS\\s+(?:NOT\\s+)?NULL|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM\\s+(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|TRUE|FALSE|NULL)|(?:=|<>|!=|<=|>=|<|>)\\s*(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|TRUE|FALSE|NULL))"
const WHERE_GRAMMAR = new RegExp(`^\\s*${WHERE_TERM}(?:\\s+(?:AND|OR)\\s+${WHERE_TERM})*\\s*$`, "i")
// Explicit injection markers rejected up-front for a clear error, even though the
// positive grammar above would already reject them.
const WHERE_FORBIDDEN = /--|\/\*|\*\/|;|\(\s*select|\(\s*with|\bpg_sleep\b|\(/i

/**
 * Validate a partial-index `WHERE` clause against the allowlisted comparison
 * grammar. Throws on anything that smells like injection (comments, statement
 * separators, subqueries, function calls, parentheses). Returns the clause
 * unchanged when it is safe, so callers can interpolate it.
 */
export function validateWhereClause(where: string): string {
  if (WHERE_FORBIDDEN.test(where)) {
    throw new Error(`Unsafe partial-index WHERE clause (forbidden token): ${where}`)
  }
  if (!WHERE_GRAMMAR.test(where)) {
    throw new Error(
      `Unsafe partial-index WHERE clause (must be simple "column op literal" predicates joined by AND/OR): ${where}`,
    )
  }
  return where
}

const FIELD_TYPE_MAP: Record<string, string> = {
  string: "TEXT",
  text: "TEXT",
  number: "NUMERIC",
  integer: "INTEGER",
  // Phase 17 (D1) — invoicing money columns need a 64-bit integer for minor
  // units, year_of_issue fits in a 16-bit int, and `quantity` carries
  // fractional services/weights as NUMERIC(15,3). The numeric-with-precision
  // shape is rendered by emitColumnType() below; mapFieldTypeToPgDataType
  // and the bare FIELD_TYPE_MAP lookup still return plain "NUMERIC".
  bigint: "BIGINT",
  smallint: "SMALLINT",
  numeric: "NUMERIC",
  boolean: "BOOLEAN",
  date: "TIMESTAMPTZ",
  // A calendar day with no time and no time zone (a task's due or start
  // date). `date` is an instant (TIMESTAMPTZ): storing a day as one pins it
  // to midnight in the server's zone and shifts it for users west of it.
  day: "DATE",
  json: "JSONB",
  uuid: "UUID",
  // Raw ciphertext. Nullable by design (a row is only sealed once its owning
  // account is enrolled), and never defaulted.
  bytea: "BYTEA",
}

/**
 * Render the column type. For `numeric` declarations with precision/scale we
 * emit `NUMERIC(p,s)`; everything else returns the bare type from FIELD_TYPE_MAP.
 */
function renderColumnType(typeName: string, fieldDef: unknown): string {
  const base = FIELD_TYPE_MAP[typeName]
  if (!base) {
    return ""
  }
  if (typeName === "numeric" && typeof fieldDef === "object" && fieldDef !== null) {
    const def = fieldDef as { precision?: unknown; scale?: unknown }
    if (typeof def.precision === "number") {
      const scale = typeof def.scale === "number" ? def.scale : 0
      return `${base}(${def.precision},${scale})`
    }
  }
  return base
}

function snake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase()
}

function emitDefault(fieldDef: any): string {
  const d = fieldDef?.default
  if (d === undefined) return ""
  if (d === "now") return " DEFAULT now()"
  if (d === "gen_random_uuid") return " DEFAULT gen_random_uuid()"
  if (typeof d === "string") return ` DEFAULT '${d.replace(/'/g, "''")}'`
  if (typeof d === "number" || typeof d === "boolean") return ` DEFAULT ${d}`
  if (d === null) return " DEFAULT NULL"
  if (typeof d === "object") return ` DEFAULT '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`
  return ""
}

export type UniqueConstraint = string[] | { columns: string[]; where: string }
export type IndexSpec = string[] | { columns: string[]; where: string }

/**
 * Deterministic name of a runtime-owned partial-unique index. Both the CREATE
 * TABLE and ALTER paths emit it, and the runtime's schema sync uses it as the
 * reconcile key: when a new app version CHANGES a partial unique (the column
 * list moves, so the name moves), the stale predecessor must be DROPPED or it
 * keeps enforcing the old rule forever — `IF NOT EXISTS` alone never removes it.
 */
export function partialUniqueIndexName(
  schemaName: string,
  tableName: string,
  columns: string[],
): string {
  return columns.length === 0
    ? `uniq_${schemaName}_${tableName}_org`.slice(0, 63)
    : `uniq_${schemaName}_${tableName}_${columns.map(snake).join("_")}`.slice(0, 63)
}

/** Names of every partial-unique index a manifest entity declares. The runtime
 *  treats any live `uniq_<schema>_<table>_…`-prefixed index NOT in this set as
 *  drift from a prior app version and drops it. Array-form uniques become
 *  table-level UNIQUE constraints (not `uniq_`-named indexes) and are excluded. */
export function declaredPartialUniqueIndexNames(
  schemaName: string,
  tableName: string,
  constraints?: { unique?: UniqueConstraint[] },
): string[] {
  return (constraints?.unique ?? [])
    .filter((u): u is { columns: string[]; where: string } => !Array.isArray(u))
    .map((u) => partialUniqueIndexName(schemaName, tableName, u.columns))
}

/** DROP a runtime-owned index (reconcile path — identifiers validated + quoted). */
export function generateDropIndexDdl(schemaName: string, indexName: string): string {
  validateIdentifier(indexName)
  return `DROP INDEX IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(indexName)}`
}

export function generateTableDdl(
  schemaName: string,
  tableName: string,
  fields: Record<string, any>,
  constraints?: { unique?: UniqueConstraint[] },
  indexes?: IndexSpec[],
  systemColumns?: { handle?: boolean },
): string {
  const columns: string[] = [
    "id UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    "org_id UUID NOT NULL",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  ]
  if (systemColumns?.handle) columns.push(`"handle" TEXT NOT NULL`)

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const typeName = typeof fieldDef === "string" ? fieldDef.replace("?", "") : fieldDef.type
    const pgType = renderColumnType(typeName, fieldDef)
    if (!pgType) {
      throw new Error(
        `Unknown field type "${typeName}" for field "${fieldName}" in ${schemaName}.${tableName}`,
      )
    }
    const nullable =
      typeof fieldDef === "string"
        ? fieldDef.endsWith("?")
          ? ""
          : " NOT NULL"
        : fieldDef.required === false
          ? ""
          : " NOT NULL"
    const colName = snake(fieldName)
    let line = `${quoteIdent(colName)} ${pgType}${nullable}${emitDefault(fieldDef)}`

    if (typeof fieldDef === "object" && Array.isArray(fieldDef.enum)) {
      const list = fieldDef.enum.map((v: string) => `'${v.replace(/'/g, "''")}'`).join(", ")
      line += ` CHECK (${quoteIdent(colName)} IN (${list}))`
    }
    if (typeof fieldDef === "object" && fieldDef.references) {
      const onDelete = (fieldDef.references.onDelete ?? "no action").toUpperCase()
      // For cross-schema references, apply schemaRef so the worker prefix (used in
      // E2E test isolation) is honored. Same-app references already use schemaName
      // which is the prefixed schema passed by the runtime.
      const refSchemaRaw = fieldDef.references.schema
      const targetSchema = quoteIdent(refSchemaRaw ? schemaRef(refSchemaRaw) : schemaName)
      const tbl = quoteIdent(fieldDef.references.table)
      const col = quoteIdent(fieldDef.references.column)
      line += ` REFERENCES ${targetSchema}.${tbl}(${col}) ON DELETE ${onDelete}`
    }
    columns.push(line)
  }

  const partialUniqueStmts: string[] = []
  if (systemColumns?.handle) {
    columns.push(`UNIQUE (org_id, "handle")`)
  }
  if (constraints?.unique) {
    for (const u of constraints.unique) {
      if (Array.isArray(u)) {
        const snakeCols = u.map((c) => quoteIdent(snake(c)))
        columns.push(`UNIQUE (org_id, ${snakeCols.join(", ")})`)
      } else {
        const snakeCols = u.columns.map((c) => quoteIdent(snake(c)))
        const idxName = partialUniqueIndexName(schemaName, tableName, u.columns)
        const colList = snakeCols.length === 0 ? "org_id" : `org_id, ${snakeCols.join(", ")}`
        partialUniqueStmts.push(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${colList}) WHERE ${validateWhereClause(u.where)}`,
        )
      }
    }
  }

  const parts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${columns.join(", ")})`,
    ...partialUniqueStmts,
  ]

  if (indexes) {
    for (const idx of indexes) {
      const cols = Array.isArray(idx) ? idx : idx.columns
      const where = Array.isArray(idx) ? null : idx.where
      const snakeCols = cols.map(snake)
      const indexName = `idx_${schemaName}_${tableName}_${snakeCols.join("_")}`.slice(0, 63)
      const colList = ["org_id", ...snakeCols.map((c) => quoteIdent(c))].join(", ")
      parts.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${colList})${where ? ` WHERE ${validateWhereClause(where)}` : ""}`,
      )
    }
  }

  return parts.join(";\n")
}

export function generateAlterTableDdl(
  schemaName: string,
  tableName: string,
  fields: Record<string, any>,
  constraints?: { unique?: UniqueConstraint[] },
  indexes?: IndexSpec[],
): string {
  const statements: string[] = []

  const alterStatements = Object.entries(fields).map(([fieldName, fieldDef]) => {
    const typeName = typeof fieldDef === "string" ? fieldDef.replace("?", "") : fieldDef.type
    const pgType = renderColumnType(typeName, fieldDef)
    if (!pgType) throw new Error(`Unknown field type "${typeName}" for field "${fieldName}"`)
    const colName = snake(fieldName)
    // A non-nullable field carries NOT NULL here too, but only with a non-null
    // default: Postgres fills existing rows with the default, so the ADD is safe
    // on a populated table. Without one, NOT NULL would abort the registration on
    // the first existing row, so such a column stays nullable (and is reported as
    // drift). Omitting NOT NULL unconditionally left every defaulted field added
    // by a later app version nullable forever (calendar events.push_attempts).
    const notNull = !isFieldNullable(fieldDef) && hasNonNullDefault(fieldDef) ? " NOT NULL" : ""
    let clause = `ADD COLUMN IF NOT EXISTS ${quoteIdent(colName)} ${pgType}${notNull}${emitDefault(fieldDef)}`
    // Carry the enum CHECK onto ADDED columns too. Only CREATE TABLE emitted it,
    // so a new enum field landed UNCONSTRAINED on every deployment that already
    // had the table — and the runtime's enum reconciler skips new columns on the
    // stated grounds that "CREATE/ALTER emits its CHECK", which was half true.
    // An enum whose database does not enforce it is just free text with a
    // comment, and free text is what produced the 16-way team rename.
    //
    // pg names an inline column CHECK `<table>_<col>_check` — exactly the name
    // the reconciler looks for later, so widening the enum keeps working.
    if (typeof fieldDef === "object" && Array.isArray(fieldDef.enum)) {
      const list = fieldDef.enum.map((v: string) => `'${v.replace(/'/g, "''")}'`).join(", ")
      clause += ` CHECK (${quoteIdent(colName)} IN (${list}))`
    }
    return clause
  })

  if (alterStatements.length > 0) {
    statements.push(
      `ALTER TABLE ${quoteIdent(schemaName)}.${quoteIdent(tableName)} ${alterStatements.join(", ")}`,
    )
  }

  // Partial unique constraints — emitted as CREATE UNIQUE INDEX IF NOT EXISTS so
  // newly declared partial uniques on existing tables are applied without drift.
  if (constraints?.unique) {
    for (const u of constraints.unique) {
      if (Array.isArray(u)) continue // table-level UNIQUE handled at CREATE TABLE time
      const snakeCols = u.columns.map((c) => quoteIdent(snake(c)))
      const idxName = partialUniqueIndexName(schemaName, tableName, u.columns)
      const colList = snakeCols.length === 0 ? "org_id" : `org_id, ${snakeCols.join(", ")}`
      statements.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${colList}) WHERE ${validateWhereClause(u.where)}`,
      )
    }
  }

  if (indexes) {
    for (const idx of indexes) {
      const cols = Array.isArray(idx) ? idx : idx.columns
      const where = Array.isArray(idx) ? null : idx.where
      const snakeCols = cols.map(snake)
      const indexName = `idx_${schemaName}_${tableName}_${snakeCols.join("_")}`.slice(0, 63)
      const colList = ["org_id", ...snakeCols.map((c) => quoteIdent(c))].join(", ")
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${colList})${where ? ` WHERE ${validateWhereClause(where)}` : ""}`,
      )
    }
  }

  return statements.join(";\n")
}

export function generateSequenceDdl(schemaName: string, entityName: string): string {
  validateIdentifier(entityName)
  return `CREATE SEQUENCE IF NOT EXISTS ${quoteIdent(schemaName)}.${quoteIdent(`${entityName}_handle_seq`)}`
}

/**
 * A dollar-quote tag (`$tag$`) for a trigger function body that the body itself
 * cannot close. A static tag like `$TRIGGER_BODY$` is guessable: a body that
 * contains the literal `$TRIGGER_BODY$` closes the quote early and turns the
 * rest of the body into arbitrary DDL/DML executed by the privileged role that
 * runs the manifest schema sync. We (a) reject any body containing a dollar-quote
 * tag sequence (defense-in-depth + a clear error) and (b) derive the tag from a
 * sha256 of the body so it is unguessable from the manifest. `$TRG_<hex16>$`.
 */
const DOLLAR_QUOTE_TAG = /\$[A-Za-z0-9_]*\$/

export function dollarQuoteTagFor(body: string): string {
  const h = createHash("sha256").update(body).digest("hex").slice(0, 16)
  return `$TRG_${h}$`
}

export function generateTriggerDdl(
  schemaName: string,
  tableName: string,
  triggerName: string,
  def: { timing: string; event: string[]; level: string; language: string; body: string },
): string {
  validateIdentifier(triggerName)
  // Defense-in-depth: reject any body that carries a dollar-quote tag sequence.
  // Even with the content-hash-derived tag below this can never legitimately
  // appear in a plpgsql body (nested dollar-quoting is itself a tag), so its
  // presence is an injection attempt or malformed input.
  if (DOLLAR_QUOTE_TAG.test(def.body)) {
    throw new Error(
      `Trigger body for "${triggerName}" must not contain a dollar-quote tag sequence ($...$)`,
    )
  }
  const tag = dollarQuoteTagFor(def.body)
  const fnName = `${tableName}_${triggerName}_fn`
  const event = def.event.join(" OR ")
  return [
    `CREATE OR REPLACE FUNCTION ${quoteIdent(schemaName)}.${quoteIdent(fnName)}() RETURNS TRIGGER AS ${tag} ${def.body} ${tag} LANGUAGE ${def.language}`,
    `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)}`,
    `CREATE TRIGGER ${quoteIdent(triggerName)} ${def.timing} ${event} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} FOR EACH ${def.level} EXECUTE FUNCTION ${quoteIdent(schemaName)}.${quoteIdent(fnName)}()`,
  ].join(";\n")
}

/** Manifest `schema.<table>.immutable`: a legal record that is written once and retained. */
export interface ImmutableTableSpec {
  /** Rows (and the files parented to them) cannot be deleted for this many years. */
  retentionYears: number
  /** Timestamp column the retention period runs from. Default `created_at`. */
  anchor?: string
  /** When set, ONLY these columns are write-once (a ledger row whose state advances keeps its
   *  identity columns fixed); the row stays undeletable within the retention period. Default:
   *  every column is write-once. */
  writeOnceColumns?: string[]
}

export const IMMUTABLE_TRIGGER_NAME = "kernel_immutable"

/**
 * Transaction-local setting the org purge (`modules/org/purge/`) sets to the org it is
 * deleting. The immutability trigger honours it for a DELETE, run as `liaison_admin`, of a row
 * whose `org_id` equals the setting, in an org whose stored row is being deleted
 * (`deleting_at` set) or carries a demo marker (`settings.demo`). Any session can write a
 * custom setting, so the setting alone grants nothing: the role and the stored org row are the
 * checks. The value keeps its first name so the trigger bodies of two releases read the same
 * setting during a deploy.
 */
export const ORG_PURGE_SETTING = "liaison.demo_purge_org"

/** Text only the current trigger body carries: the purge checks it before deleting. */
export const IMMUTABLE_TRIGGER_DELETING_BRANCH = "o.deleting_at IS NOT NULL"

/**
 * Kernel-authored trigger for an immutable table. UPDATE may only FILL a column that is still
 * NULL (write-once, so a row inserted before its file is stored can record the file id once);
 * changing any non-null value is refused. DELETE is refused while `anchor + retentionYears` is
 * in the future. A superuser session may set `liaison.retention_override = 'on'` for an operator
 * action (whole-organisation deletion, documented in the runbook); no application role can.
 *
 * One sanctioned exception, for an org being purged (`ORG_PURGE_SETTING`): the purge may
 * DELETE the rows of the org it is deleting. It needs all three of the privileged role
 * (`liaison_admin`; a request's `liaison_rls` / `liaison_request` role and a SECURITY DEFINER
 * function's `liaison_definer` never match), the setting naming that row's org, and that org's
 * stored row saying it may go: either its deletion has started (`deleting_at` set, an
 * operator's `liaison org delete`), or it carries a demo marker (the demo reaper and the
 * nightly content reset of a disposable workspace): an object whose `variant` is one the
 * marker schema allows (`DEMO_ORG_VARIANTS`), so a hand-written `{"demo":{}}` is not a marker.
 * The org lookup is schema-qualified like every other kernel reference here; a missing kernel
 * table makes the DELETE error, never pass. UPDATE is never relaxed.
 */
export function generateImmutableTriggerDdl(
  schemaName: string,
  tableName: string,
  spec: ImmutableTableSpec,
): string {
  const years = Number(spec.retentionYears)
  if (!Number.isInteger(years) || years < 1 || years > 100) {
    throw new Error(
      `immutable.retentionYears for "${tableName}" must be an integer between 1 and 100`,
    )
  }
  const anchor = validateIdentifier(spec.anchor ?? "created_at")
  const only = spec.writeOnceColumns?.map((c) => validateIdentifier(c))
  if (only && only.length === 0)
    throw new Error(`immutable.writeOnceColumns for "${tableName}" must not be empty`)
  const columnFilter = only ? ` AND o.key IN (${only.map((c) => `'${c}'`).join(", ")})` : ""
  const body = [
    "DECLARE k text;",
    "BEGIN",
    "  IF current_setting('liaison.retention_override', true) = 'on'",
    "     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN",
    "    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;",
    "    RETURN NEW;",
    "  END IF;",
    "  IF TG_OP = 'DELETE' AND current_user = 'liaison_admin'",
    `     AND current_setting('${ORG_PURGE_SETTING}', true) = to_jsonb(OLD)->>'org_id' THEN`,
    `    IF EXISTS (SELECT 1 FROM ${quoteIdent(schemaRef("kernel"))}.organizations o WHERE o.id = (to_jsonb(OLD)->>'org_id')::uuid`,
    `               AND (${IMMUTABLE_TRIGGER_DELETING_BRANCH}`,
    "                    OR (jsonb_typeof(o.settings->'demo') = 'object'",
    `                        AND o.settings->'demo'->>'variant' IN (${DEMO_ORG_VARIANTS.map((v) => `'${v}'`).join(", ")})))) THEN`,
    "      RETURN OLD;",
    "    END IF;",
    "  END IF;",
    "  IF TG_OP = 'DELETE' THEN",
    `    IF OLD.${quoteIdent(anchor)} > now() - interval '${years} years' THEN`,
    `      RAISE EXCEPTION 'immutable_retention: a % row cannot be deleted within ${years} years of its record', TG_TABLE_NAME USING ERRCODE = 'P0001';`,
    "    END IF;",
    "    RETURN OLD;",
    "  END IF;",
    "  FOR k IN SELECT o.key FROM jsonb_each(to_jsonb(OLD)) o JOIN jsonb_each(to_jsonb(NEW)) n USING (key)",
    `           WHERE o.value <> 'null'::jsonb AND o.value IS DISTINCT FROM n.value AND o.key <> 'updated_at'${columnFilter} LOOP`,
    "    RAISE EXCEPTION 'immutable_row: %.% is immutable once set', TG_TABLE_NAME, k USING ERRCODE = 'P0001';",
    "  END LOOP;",
    "  RETURN NEW;",
    "END",
  ].join(" ") // one line: the schema sync splits statements on ";\n"
  return generateTriggerDdl(schemaName, tableName, IMMUTABLE_TRIGGER_NAME, {
    timing: "BEFORE",
    event: ["UPDATE", "DELETE"],
    level: "ROW",
    language: "plpgsql",
    body,
  })
}

/**
 * The spec an immutability trigger body was generated from, read back from the body Postgres
 * stores (`pg_proc.prosrc`), or null when the body is not one this generator wrote. The purge
 * uses it to regenerate a body an older release generated, without the app's manifest: only
 * these three values vary between bodies (`generateImmutableTriggerDdl`).
 */
export function immutableSpecFromTriggerBody(body: string): ImmutableTableSpec | null {
  const retention = /OLD\."([A-Za-z_][A-Za-z0-9_]*)" > now\(\) - interval '(\d+) years'/.exec(body)
  if (!retention?.[1] || !retention[2]) return null
  const only = /AND o\.key IN \(([^)]*)\)/.exec(body)
  const writeOnceColumns = only?.[1]
    ?.split(",")
    .map((c) => c.trim().replace(/^'|'$/g, ""))
    .filter((c) => c.length > 0)
  return {
    retentionYears: Number(retention[2]),
    anchor: retention[1],
    ...(writeOnceColumns && writeOnceColumns.length > 0 ? { writeOnceColumns } : {}),
  }
}

/** Drop the immutability trigger of a table that no longer declares `immutable`. */
export function generateDropImmutableTriggerDdl(schemaName: string, tableName: string): string {
  return `DROP TRIGGER IF EXISTS ${quoteIdent(IMMUTABLE_TRIGGER_NAME)} ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
}

const PG_DATA_TYPE_MAP: Record<string, string> = {
  TEXT: "text",
  NUMERIC: "numeric",
  INTEGER: "integer",
  BIGINT: "bigint",
  SMALLINT: "smallint",
  BOOLEAN: "boolean",
  TIMESTAMPTZ: "timestamp with time zone",
  DATE: "date",
  JSONB: "jsonb",
  UUID: "uuid",
  BYTEA: "bytea",
}

export function mapFieldTypeToPgDataType(fieldDef: any): string | undefined {
  const typeName = typeof fieldDef === "string" ? fieldDef.replace("?", "") : fieldDef.type
  const ddlType = FIELD_TYPE_MAP[typeName]
  if (!ddlType) return undefined
  return PG_DATA_TYPE_MAP[ddlType]
}

export function isFieldNullable(fieldDef: any): boolean {
  if (typeof fieldDef === "string") return fieldDef.endsWith("?")
  return fieldDef.required === false
}

function hasNonNullDefault(fieldDef: any): boolean {
  return (
    typeof fieldDef === "object" &&
    fieldDef !== null &&
    emitDefault(fieldDef) !== "" &&
    fieldDef.default !== null
  )
}

/**
 * The column list of each table-level UNIQUE a manifest declares, as CREATE TABLE
 * renders it: `org_id` first, then the declared columns in snake case.
 */
export function declaredTableUniqueColumns(constraints?: {
  unique?: UniqueConstraint[]
}): string[][] {
  return (constraints?.unique ?? [])
    .filter((u): u is string[] => Array.isArray(u))
    .map((u) => ["org_id", ...u.map(snake)])
}

/**
 * Add a table-level UNIQUE to a live table that lacks it. CREATE TABLE emits it
 * inline, so a table that predates the manifest's declaration (or was created
 * by hand) never got it, and every `ON CONFLICT` on those columns then fails.
 * Unnamed, so Postgres names it as it would have at CREATE TABLE.
 */
export function generateTableUniqueAddDdl(
  schemaName: string,
  tableName: string,
  columns: string[],
): string {
  return `ALTER TABLE ${quoteIdent(schemaName)}.${quoteIdent(tableName)} ADD UNIQUE (${columns.map(quoteIdent).join(", ")})`
}

/**
 * Statements that bring a live column an earlier app version left nullable up
 * to the manifest's NOT NULL: backfill NULLs with the declared default, then
 * SET NOT NULL. Both are safe on a populated table. Returns null when the field
 * is nullable or declares no non-null default (there is no value to backfill
 * with, so the column is left as it is and reported as drift).
 */
export function generateNotNullTightenDdl(
  schemaName: string,
  tableName: string,
  fieldName: string,
  fieldDef: any,
): string[] | null {
  if (isFieldNullable(fieldDef) || !hasNonNullDefault(fieldDef)) return null
  const table = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
  const col = quoteIdent(snake(fieldName))
  const value = emitDefault(fieldDef).replace(/^ DEFAULT /, "")
  return [
    `UPDATE ${table} SET ${col} = ${value} WHERE ${col} IS NULL`,
    `ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`,
  ]
}

/**
 * The statement that lets a live column go NULL when a later app version makes its field
 * nullable. Additive (expand-safe): code still running from the earlier version keeps writing
 * the value, and every existing row keeps its own. Metadata only, no table rewrite. Returns null
 * when the manifest still declares the field NOT NULL.
 */
export function generateNotNullLoosenDdl(
  schemaName: string,
  tableName: string,
  fieldName: string,
  fieldDef: any,
): string | null {
  if (!isFieldNullable(fieldDef)) return null
  return `ALTER TABLE ${quoteIdent(schemaName)}.${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snake(fieldName))} DROP NOT NULL`
}

function deepSortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(deepSortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

export function computeSchemaHash(schema: Record<string, any> | undefined): string {
  if (!schema) return ""
  const canonical = JSON.stringify(deepSortKeys(schema))
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

// ─────────────────────────────────────────────────────────────────────────
// Enum CHECK-constraint reconciliation.
//
// `generateTableDdl` emits enum fields as inline column CHECKs, which pg
// names `<table>_<col>_check`. The additive reconcile pass only ADDs missing
// columns, so an app version that WIDENS an enum (e.g. invoicing 0.5.0 adding
// 'credit_note' to documents.type) left the live constraint stale — every
// insert with the new value violated it. These helpers let the runtime detect
// and recreate a drifted enum CHECK on upgrade.
// ─────────────────────────────────────────────────────────────────────────

/** Extract the quoted string literals from a pg_get_constraintdef() body,
 *  e.g. `CHECK ((type = ANY (ARRAY['a'::text, 'b'::text])))` → ["a","b"]. */
export function constraintDefEnumValues(def: string): string[] {
  return [...def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

/** True when the live constraint's literal set equals the manifest enum. */
export function enumCheckMatches(def: string, enumValues: string[]): boolean {
  const current = constraintDefEnumValues(def)
  if (current.length !== enumValues.length) return false
  const set = new Set(current)
  return enumValues.every((v) => set.has(v))
}

/** DROP+ADD statements recreating `<table>_<col>_check` for the given enum.
 *  Widening always succeeds; narrowing can fail on existing rows — the caller
 *  decides how to surface that (the runtime logs and continues). */
export function generateEnumCheckReconcileDdl(
  schemaName: string,
  tableName: string,
  colName: string,
  enumValues: string[],
): string[] {
  const conName = validateIdentifier(`${tableName}_${colName}_check`)
  const list = enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")
  const rel = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
  return [
    `ALTER TABLE ${rel} DROP CONSTRAINT ${quoteIdent(conName)}`,
    `ALTER TABLE ${rel} ADD CONSTRAINT ${quoteIdent(conName)} CHECK (${quoteIdent(colName)} IN (${list}))`,
  ]
}

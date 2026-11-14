// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Build one whole-org export archive and stream it to object storage.
 *
 * Layout (format version 1, `docs` "Export an organization"):
 *   data/<schema>.<table>.ndjson   one row per line, every table of the catalog
 *                                  (catalog.ts), zero-row tables included
 *   files/<file-id>/<name>         every kernel.files object, bytes as stored
 *   files.ndjson                   one line per file: id, entry, raw filename, ...
 *   manifest.json                  written last
 *
 * Reads go through the privileged pool filtered by org (the whole org, not one
 * admin's view), keyset-paged by primary key, one short transaction per batch
 * (PgBouncer transaction mode allows no long cursor). A batch is bounded by
 * rows and by bytes (EXPORT_BATCH_ROWS, EXPORT_BATCH_BYTES: the database cuts
 * it at the byte budget, so wide rows never pile up here) and is written out
 * in slices of about EXPORT_SLICE_BYTES. The archive is therefore
 * not a snapshot: the manifest says so. Encoding: bytea base64, bigint and
 * numeric as strings, timestamps ISO-8601 UTC. Redacted columns are `null`
 * (redaction.ts); encrypted columns are written as stored, no decrypt path is
 * called, and sealed values are counted in `manifest.sealed`.
 */

import crypto from "node:crypto"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { putObjectStream } from "~/infra/storage/multipart"
import { getObjectStream } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { quoteIdent } from "~/lib/sql-utils"
import {
  columnKey,
  discoverExportTables,
  type ExportColumn,
  type ExportTable,
} from "~/modules/export/org-archive/catalog"
import {
  CIPHERTEXT_JSON_PATHS,
  decideColumn,
  isSealedColumn,
  KEPT_COLUMNS,
  mayHoldCiphertext,
  REDACTED_JSON_PATHS,
  redactCiphertext,
  redactJsonPaths,
  scrubsCiphertext,
} from "~/modules/export/org-archive/redaction"
import { WITHHELD_ROWS } from "~/modules/export/org-archive/withheld"
import {
  ExportTooLargeError,
  fileEntryName,
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  type ZipStreamOptions,
  ZipStreamWriter,
} from "~/modules/export/org-archive/zip-stream"

export const ORG_ARCHIVE_FORMAT_VERSION = 1
export const EXPORT_BATCH_ROWS = 1000
/** A batch stops once its rows' JSON reaches this many bytes (one row at least). */
export const EXPORT_BATCH_BYTES = 8 * 1024 * 1024
/** Rows are handed to the zip writer in slices of about this size. */
const EXPORT_SLICE_BYTES = 1024 * 1024

/** One object per run: a run taken over never writes the object of the run that took it. */
export function orgExportObjectKey(orgId: string, exportId: string, runId: string): string {
  return `orgs/${orgId}/exports/${exportId}-${runId}.zip`
}

export interface OrgArchiveManifest {
  formatVersion: number
  org: { id: string; name: string; slug: string }
  createdAt: string
  liaisonVersion: string
  consistency: string
  encoding: Record<string, string>
  tables: Array<{ schema: string; table: string; file: string; rows: number }>
  files: { count: number; bytes: number; missing: number; index: string }
  sealed: { count: number; note: string }
  redacted: {
    columns: Array<{ column: string; why: string }>
    jsonPaths: Array<{ column: string; path: string; why: string }>
  }
  kept: Array<{ column: string; why: string }>
  /** Tables whose rows the archive holds only in part (withheld.ts), with why. */
  withheld: Array<{ table: string; why: string }>
}

export interface BuildOrgArchiveOptions {
  orgId: string
  exportId: string
  /** The run token (store.claimOrgExport); names the object. A new one when absent. */
  runId?: string
  /** Checked between batches and between the chunks of a file. */
  signal?: AbortSignal
  /** Tests: smaller zip limits. */
  zip?: ZipStreamOptions
  /** Tests: read a file object some other way (a slow stream). */
  openObject?: (key: string) => Promise<ReadableStream<Uint8Array>>
}

/** The SQL expression one column is written as. */
function columnExpr(col: ExportColumn, redacted: boolean): string {
  const ref = `t.${quoteIdent(col.name)}`
  if (redacted) return `NULL AS ${quoteIdent(col.name)}`
  switch (col.type) {
    case "bytea":
      return `encode(${ref}, 'base64') AS ${quoteIdent(col.name)}`
    case "bigint":
    case "bigint[]":
    case "money":
      return `${ref}::text${col.type.endsWith("[]") ? "[]" : ""} AS ${quoteIdent(col.name)}`
    case "timestamp with time zone":
      return `to_char(${ref} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${quoteIdent(col.name)}`
    case "timestamp without time zone":
      return `to_char(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS ${quoteIdent(col.name)}`
    default:
      if (col.type.startsWith("numeric")) return `${ref}::text AS ${quoteIdent(col.name)}`
      return `${ref} AS ${quoteIdent(col.name)}`
  }
}

function scopeWhere(t: ExportTable, orgId: string): SQL {
  const withheld = WITHHELD_ROWS[`${t.logicalSchema}.${t.table}`]
  const org = orgScopeWhere(t, orgId)
  return withheld ? drizzleSql`${org} AND (${drizzleSql.raw(withheld.keep())})` : org
}

function orgScopeWhere(t: ExportTable, orgId: string): SQL {
  switch (t.reach.kind) {
    case "org":
      return drizzleSql`t.org_id = ${orgId}::uuid`
    case "org-row":
      return drizzleSql`t.id = ${orgId}::uuid`
    case "child": {
      const s = t.reach
      if (s.parentIsOrgRow)
        return drizzleSql`${drizzleSql.raw(`t.${quoteIdent(s.column)}`)} = ${orgId}::uuid`
      return drizzleSql`${drizzleSql.raw(`t.${quoteIdent(s.column)}`)} IN (SELECT p.${drizzleSql.raw(
        quoteIdent(s.parentColumn),
      )} FROM ${drizzleSql.raw(`${quoteIdent(s.parentSchema)}.${quoteIdent(s.parentTable)}`)} p WHERE p.org_id = ${orgId}::uuid)`
    }
  }
}

interface TablePlan {
  table: ExportTable
  select: string
  sealedPredicate: string | null
  /** Columns with redacted jsonb paths (parsed on every row). */
  pathColumns: string[]
  /** json/jsonb columns, scrubbed of ciphertext when a row may hold some. */
  jsonColumns: string[]
  pkTypes: string[]
}

function planTable(t: ExportTable, redactedOut: Map<string, string>): TablePlan {
  const exprs: string[] = []
  const sealed: string[] = []
  for (const col of t.columns) {
    const key = columnKey(t, col.name)
    const d = decideColumn(key)
    if (d.action === "redact") redactedOut.set(key, d.why)
    exprs.push(columnExpr(col, d.action === "redact"))
    if (d.action === "keep" && isSealedColumn(key))
      sealed.push(`t.${quoteIdent(col.name)} IS NOT NULL`)
  }
  const pathColumns = REDACTED_JSON_PATHS.filter((r) =>
    t.columns.some((c) => columnKey(t, c.name) === r.column),
  ).map((r) => r.column.slice(r.column.lastIndexOf(".") + 1))
  const jsonColumns = t.columns
    .filter((c) => scrubsCiphertext(c.type) && decideColumn(columnKey(t, c.name)).action === "keep")
    .map((c) => c.name)
  const pkTypes = t.primaryKey.map((k) => t.columns.find((c) => c.name === k)?.type ?? "text")
  return {
    table: t,
    select: exprs.join(", "),
    sealedPredicate: sealed.length > 0 ? sealed.join(" OR ") : null,
    pathColumns: [...new Set(pathColumns)],
    jsonColumns,
    pkTypes,
  }
}

interface Batch {
  rows: Array<Record<string, string | boolean | null>>
  lastKey: string[] | null
  sealed: number
  /** Rows the limit let through before the byte cut. */
  fetched: number
}

/** One exported line: jsonb paths redacted, server-key ciphertext nulled. */
function exportLine(plan: TablePlan, raw: string): string {
  const scrub = plan.jsonColumns.length > 0 && mayHoldCiphertext(raw)
  if (plan.pathColumns.length === 0 && !scrub) return raw
  const t = plan.table
  const obj = JSON.parse(raw) as Record<string, unknown>
  for (const c of plan.pathColumns) obj[c] = redactJsonPaths(columnKey(t, c), obj[c])
  if (scrub) for (const c of plan.jsonColumns) obj[c] = redactCiphertext(obj[c]).value
  return JSON.stringify(obj)
}

/**
 * Up to `limit` rows after `after`, cut by the database once their JSON
 * reaches EXPORT_BATCH_BYTES (the first row always comes).
 */
async function readBatch(
  plan: TablePlan,
  orgId: string,
  after: string[] | null,
  limit: number,
): Promise<Batch> {
  const t = plan.table
  const pk = t.primaryKey.map((k) => `t.${quoteIdent(k)}`)
  const keyCols = pk.map((k, i) => `${k}::text AS __k${i}`).join(", ")
  const sealedCol = plan.sealedPredicate ? `, (${plan.sealedPredicate}) AS __sealed` : ""
  const afterSql =
    after === null
      ? drizzleSql``
      : drizzleSql` AND (${drizzleSql.raw(pk.join(", "))}) > (${drizzleSql.join(
          after.map((v, i) => drizzleSql`${v}::${drizzleSql.raw(plan.pkTypes[i] ?? "text")}`),
          drizzleSql`, `,
        )})`
  const keyOut = t.primaryKey.map((_, i) => `__k${i}`).join(", ")
  const sealedOut = plan.sealedPredicate ? ", __sealed" : ""
  const rows = await withSystemDb("org-export-read", async (tx) =>
    extractRows<Record<string, string | boolean | null>>(
      await tx.execute(drizzleSql`
        SELECT ${drizzleSql.raw(keyOut)}${drizzleSql.raw(sealedOut)}, __line, __n
        FROM (
          SELECT p.*,
            sum(octet_length(p.__line)) OVER (ORDER BY p.__ord ROWS UNBOUNDED PRECEDING)
              - octet_length(p.__line) AS __before,
            count(*) OVER () AS __n
          FROM (
            SELECT row_number() OVER (ORDER BY ${drizzleSql.raw(pk.join(", "))}) AS __ord,
              ${drizzleSql.raw(keyCols)}${drizzleSql.raw(sealedCol)},
              (SELECT row_to_json(r) FROM (SELECT ${drizzleSql.raw(plan.select)}) r)::text AS __line
            FROM ${drizzleSql.raw(`${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)} t
            WHERE ${scopeWhere(t, orgId)}${afterSql}
            ORDER BY ${drizzleSql.raw(pk.join(", "))}
            LIMIT ${limit}
          ) p
        ) q
        WHERE q.__ord = 1 OR q.__before < ${EXPORT_BATCH_BYTES}
        ORDER BY q.__ord
      `),
    ),
  )
  let sealed = 0
  for (const r of rows) if (r.__sealed === true) sealed++
  const last = rows[rows.length - 1]
  return {
    rows,
    lastKey: last ? t.primaryKey.map((_, i) => String(last[`__k${i}`])) : null,
    sealed,
    fetched: Number(rows[0]?.__n ?? 0),
  }
}

/** The NDJSON of one table, in slices, reading batch after batch. */
async function* tableNdjson(
  plan: TablePlan,
  orgId: string,
  stats: { rows: number; sealed: number },
  check: () => void,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  let after: string[] | null = null
  // Grows back towards EXPORT_BATCH_ROWS while batches come whole, shrinks to
  // what the byte budget let through, so wide rows are not read twice over.
  let limit = EXPORT_BATCH_ROWS
  for (;;) {
    const b = await readBatch(plan, orgId, after, limit)
    stats.rows += b.rows.length
    stats.sealed += b.sealed
    let slice = ""
    for (let i = 0; i < b.rows.length; i++) {
      const r = b.rows[i]
      if (!r) continue
      slice += `${exportLine(plan, String(r.__line))}\n`
      b.rows[i] = {} // drop the row as soon as it is in the slice
      if (slice.length >= EXPORT_SLICE_BYTES) {
        yield encoder.encode(slice)
        slice = ""
      }
    }
    if (slice) yield encoder.encode(slice)
    // Cut by bytes: more rows follow for sure. Fewer than the limit: the end.
    const cut = b.rows.length < b.fetched
    if ((!cut && b.fetched < limit) || !b.lastKey) return
    after = b.lastKey
    limit = cut ? b.rows.length : Math.min(EXPORT_BATCH_ROWS, limit * 2)
    check()
  }
}

/** A file's chunks, the run's signal checked between them. */
async function* checkedChunks(
  stream: ReadableStream<Uint8Array>,
  check: () => void,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    check()
    yield chunk
  }
}

interface FileRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: string
  storage_key: string
  enc_version: number
}

async function fileBatch(orgId: string, afterId: string | null): Promise<FileRow[]> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("org-export-files", async (tx) =>
    extractRows<FileRow>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, filename, mime_type, size_bytes::text AS size_bytes,
               storage_key, enc_version
        FROM ${K}.files
        WHERE org_id = ${orgId}::uuid
          ${afterId === null ? drizzleSql`` : drizzleSql`AND id > ${afterId}::uuid`}
        ORDER BY id
        LIMIT ${EXPORT_BATCH_ROWS}
      `),
    ),
  )
}

async function precheck(orgId: string, tableCount: number, zip: ZipStreamOptions | undefined) {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const [row] = await withSystemDb("org-export-precheck", async (tx) =>
    extractRows<{ n: string; bytes: string }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::text AS n, COALESCE(sum(size_bytes), 0)::text AS bytes
        FROM ${K}.files WHERE org_id = ${orgId}::uuid
      `),
    ),
  )
  const entries = tableCount + Number(row?.n ?? 0) + 2
  const bytes = Number(row?.bytes ?? 0)
  const maxEntries = zip?.maxEntries ?? ZIP_MAX_ENTRIES
  const maxBytes = zip?.maxBytes ?? ZIP_MAX_BYTES
  if (entries > maxEntries || bytes > maxBytes) {
    throw new ExportTooLargeError({ maxBytes, maxEntries }, { bytes, entries })
  }
}

function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

async function loadOrg(orgId: string): Promise<{ id: string; name: string; slug: string }> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const [org] = await withSystemDb("org-export-org", async (tx) =>
    extractRows<{ id: string; name: string; slug: string }>(
      await tx.execute(
        drizzleSql`SELECT id::text AS id, name, slug FROM ${K}.organizations WHERE id = ${orgId}::uuid`,
      ),
    ),
  )
  if (!org) throw new Error(`org ${orgId} not found`)
  return org
}

/**
 * Stream the archive of `orgId` to `orgs/<org>/exports/<export>.zip`. Returns
 * the object key, its size and the manifest. On failure nothing is left: the
 * multipart upload is aborted (a single-part object is never written).
 */
export async function buildOrgArchive(
  opts: BuildOrgArchiveOptions,
): Promise<{ objectKey: string; bytes: number; manifest: OrgArchiveManifest }> {
  const { orgId, exportId } = opts
  const org = await loadOrg(orgId)
  const tables = await discoverExportTables()
  for (const t of tables) {
    if (t.primaryKey.length === 0) {
      throw new Error(`table ${t.logicalSchema}.${t.table} has no primary key; it cannot be paged`)
    }
  }
  await precheck(orgId, tables.length, opts.zip)

  const objectKey = orgExportObjectKey(orgId, exportId, opts.runId ?? crypto.randomUUID())
  const openObject = opts.openObject ?? (async (key: string) => (await getObjectStream(key)).stream)
  const writer = new ZipStreamWriter(opts.zip)
  const upload = putObjectStream({
    key: objectKey,
    contentType: "application/zip",
    body: writer.output(),
    maxBytes: (opts.zip?.maxBytes ?? ZIP_MAX_BYTES) + 1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  // Observed below; an early rejection must not be unhandled meanwhile, and
  // when the upload fails first its error is the one worth reporting.
  let uploadError: unknown = null
  upload.catch((e) => {
    uploadError = e
  })

  const redacted = new Map<string, string>()
  const tableStats: OrgArchiveManifest["tables"] = []
  let sealed = 0
  let fileCount = 0
  let fileBytes = 0
  let missing = 0
  const fileIndex: string[] = []
  const check = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted")
  }

  try {
    for (const t of tables) {
      const plan = planTable(t, redacted)
      const file = `data/${t.logicalSchema}.${t.table}.ndjson`
      const stats = { rows: 0, sealed: 0 }
      await writer.addEntry(file, tableNdjson(plan, orgId, stats, check), { deflate: true })
      sealed += stats.sealed
      tableStats.push({ schema: t.logicalSchema, table: t.table, file, rows: stats.rows })
      check()
    }

    let afterId: string | null = null
    for (;;) {
      const batch = await fileBatch(orgId, afterId)
      for (const f of batch) {
        const entry = fileEntryName(f.id, f.filename)
        const size = Number(f.size_bytes)
        const isSealed = Number(f.enc_version) > 0
        let stream: ReadableStream<Uint8Array> | null = null
        try {
          stream = await openObject(f.storage_key)
        } catch (err) {
          if (!isMissingObject(err)) throw err
        }
        if (!stream) {
          missing++
          fileIndex.push(
            JSON.stringify({ id: f.id, entry: null, filename: f.filename, missing: true }),
          )
          continue
        }
        await writer.addEntry(entry, checkedChunks(stream, check), {
          deflate: false,
          sizeHint: size,
        })
        fileCount++
        fileBytes += size
        if (isSealed) sealed++
        fileIndex.push(
          JSON.stringify({
            id: f.id,
            entry,
            filename: f.filename,
            mimeType: f.mime_type,
            sizeBytes: String(size),
            sealed: isSealed,
          }),
        )
      }
      check()
      if (batch.length < EXPORT_BATCH_ROWS) break
      afterId = batch[batch.length - 1]?.id ?? null
    }

    await writer.addEntry("files.ndjson", fileIndex.length ? `${fileIndex.join("\n")}\n` : "", {
      deflate: true,
    })

    const manifest: OrgArchiveManifest = {
      formatVersion: ORG_ARCHIVE_FORMAT_VERSION,
      org,
      createdAt: new Date().toISOString(),
      liaisonVersion: env.LIAISON_VERSION ?? "dev",
      consistency:
        "Not a point-in-time snapshot: each table is read in batches of short transactions while the workspace keeps running.",
      encoding: {
        rows: "NDJSON, one JSON object per line, keys are column names",
        bytea: "base64",
        bigint: "string",
        numeric: "string",
        timestamps: "ISO-8601, UTC",
        redacted: "null",
      },
      tables: tableStats,
      files: { count: fileCount, bytes: fileBytes, missing, index: "files.ndjson" },
      sealed: {
        count: sealed,
        note: "Encrypted content (sealed mail fields, sealed files) is exported as stored: ciphertext that only its owner's key opens. The export calls no decryption.",
      },
      redacted: {
        columns: [...redacted].map(([column, why]) => ({ column, why })).sort(byColumn),
        jsonPaths: [
          ...REDACTED_JSON_PATHS.map((r) => ({
            column: r.column,
            path: r.path.join("."),
            why: r.why,
          })),
          ...CIPHERTEXT_JSON_PATHS,
        ],
      },
      kept: Object.entries(KEPT_COLUMNS)
        .map(([column, why]) => ({ column, why }))
        .sort(byColumn),
      withheld: Object.entries(WITHHELD_ROWS)
        .map(([table, w]) => ({ table, why: w.why }))
        .sort((a, b) => a.table.localeCompare(b.table)),
    }
    await writer.addEntry("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, {
      deflate: true,
    })
    await writer.finish()
    const bytes = await upload
    return { objectKey, bytes, manifest }
  } catch (err) {
    writer.fail(err)
    await upload.catch(() => undefined)
    throw uploadError ?? err
  }
}

function byColumn(a: { column: string }, b: { column: string }): number {
  return a.column.localeCompare(b.column)
}

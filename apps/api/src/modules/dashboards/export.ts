// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard out of Liaison: a block's figures or its rows as CSV, the whole dashboard as a
// PDF, and a snapshot (every block's key figures with their change) for an agent or a routine.
// Everything is computed as the person asking, through the same service as the view
// (service.ts getBlockData / getBlockRows: cache, budgets and access unchanged).
//
// The PDF is laid out on the server by the documents module's rich-text renderer
// (documents/rich-text.ts, pdf-lib, no browser, no sandbox). Every text it prints is a record
// value read through a {{path}} placeholder, never template text, so nothing a source returns
// can change the layout.

import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboards, users } from "~/db/schema/kernel"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import { deleteObject, putObject } from "~/infra/storage/object-storage"
import { runBounded } from "~/modules/dashboards/cache"
import {
  type BlockDataOptions,
  type BlockDataResponse,
  type DashboardView,
  type DashboardViewer,
  getBlockData,
  getDashboard,
} from "~/modules/dashboards/service"
import { checkSource } from "~/modules/dashboards/sources"
import {
  type BlockSource,
  blockSourceOf,
  calcDatasets,
  type DashboardBlock,
  runnableBlocks,
} from "~/modules/dashboards/spec"
import type { BlockData } from "~/modules/dashboards/transform"
import { renderRichText } from "~/modules/documents/rich-text"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

type Scalar = string | number | boolean | null

// ── CSV ─────────────────────────────────────────────────────────────────────

/** One CSV cell: quoted when needed; a text a spreadsheet would run as a formula gets a '. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return ""
  let s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v)
  // A number sent as text (a pg numeric "-12.50") stays a number; any other text a spreadsheet
  // would run as a formula gets a quote.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return `${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`
}

/** A block's mapped data as CSV: what the chart draws, one row per label (or the table's rows). */
export function blockDataCsv(title: string, data: BlockData): string {
  switch (data.kind) {
    case "metric": {
      const header = ["metric", "value"]
      const row: unknown[] = [title, data.value]
      if (data.previous !== undefined) {
        header.push("previous")
        row.push(data.previous)
      }
      if (data.target !== undefined) {
        header.push("target")
        row.push(data.target)
      }
      return toCsv(header, [row])
    }
    case "table":
      return toCsv(
        data.columns.map((c) => c.label),
        data.rows.map((r) => data.columns.map((c) => r[c.field])),
      )
    case "text":
      return toCsv(["text"], [[data.markdown]])
    default: {
      const prev = data.previous
      const header = ["label", ...data.series.map((s) => s.name)]
      if (prev) header.push(...prev.series.map((s) => `${s.name} (previous)`))
      const rows = data.labels.map((label, i) => [
        label,
        ...data.series.map((s) => s.values[i] ?? null),
        ...(prev ? prev.series.map((s) => s.values[i] ?? null) : []),
      ])
      return toCsv(header, rows)
    }
  }
}

/** Drill-down rows as CSV, one column per drill column. */
export function rowsCsv(
  columns: { field: string; label: string }[],
  rows: Record<string, Scalar>[],
): string {
  return toCsv(
    columns.map((c) => c.label),
    rows.map((r) => columns.map((c) => r[c.field])),
  )
}

/** A file name from a title: letters, digits, - and _ only. */
export function exportFilename(title: string, ext: string): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "dashboard"
  return `${base}.${ext}`
}

// ── the whole dashboard, computed ──────────────────────────────────────────

export interface ComputedDashboard {
  view: DashboardView
  blocks: { block: DashboardBlock; out: BlockDataResponse }[]
}

/** Every block of the dashboard for `viewer`, for the range and filters given (else the default). */
export async function computeDashboard(
  viewer: DashboardViewer,
  dashboardId: string,
  opts: Omit<BlockDataOptions, "refresh"> = {},
): Promise<ComputedDashboard> {
  const view = await getDashboard(viewer, dashboardId, undefined, opts.now)
  const blocks = view.spec.blocks ?? []
  const outs = await runBounded(
    blocks.map((b) => () => getBlockData(viewer, dashboardId, b.id, opts)),
  )
  return { view, blocks: blocks.map((block, i) => ({ block, out: outs[i]! })) }
}

const PRESET_WORDS: Record<string, string> = {
  last7d: "last 7 days",
  last30d: "last 30 days",
  last90d: "last 90 days",
  mtd: "month to date",
  lastMonth: "last month",
  qtd: "quarter to date",
  lastQuarter: "last quarter",
  ytd: "year to date",
  lastYear: "last year",
  custom: "custom range",
}

/** "2026-10-13 to 2026-11-11 (last 30 days), compared with 2025-10-13 to 2025-11-11", or null. */
export function periodLine(c: ComputedDashboard): string | null {
  const shown = c.blocks.find((b) => b.out.window?.mode === "dashboard")?.out
  if (shown?.window?.mode !== "dashboard") return null
  const w = shown.window
  const cmp = shown.compareWindow
  return `${w.from} to ${w.to} (${PRESET_WORDS[w.preset] ?? w.preset})${cmp ? `, compared with ${cmp.from} to ${cmp.to}` : ""}`
}

/** Each filter and its value: "Market: FR; Channel: all". */
export function filtersLine(c: ComputedDashboard, asked?: Record<string, string[]>): string | null {
  const defs = c.view.spec.filters ?? []
  if (!defs.length) return null
  return defs
    .map((f) => {
      const v = (asked?.[f.id] ?? c.view.defaultFilters[f.id] ?? []).filter((x) => x !== "")
      return `${f.label}: ${v.length ? v.join(", ") : "all"}`
    })
    .join("; ")
}

// ── numbers in words ───────────────────────────────────────────────────────

export function formatNumber(
  n: number | null | undefined,
  meta?: { format?: string | undefined; currency?: string | undefined },
): string {
  if (n === null || n === undefined) return "no value"
  if (meta?.format === "percent")
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n)}%`
  if (meta?.format === "currency" && meta.currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: meta.currency }).format(
        n,
      )
    } catch {
      // an unknown code: the plain number below
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)
}

/** The change from `previous` to `value`, as a ratio (0.12 = +12%), or null when it has none. */
export function changeOf(value: number | null | undefined, previous: number | null | undefined) {
  if (value === null || value === undefined || previous === null || previous === undefined) {
    return null
  }
  if (previous === 0) return null
  return Math.round(((value - previous) / Math.abs(previous)) * 10_000) / 10_000
}

const changeWords = (r: number | null) =>
  r === null ? null : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)}%`

// ── snapshot (agent, routine) ──────────────────────────────────────────────

export type SnapshotBlock =
  | { id: string; title: string; type: string; error: string; message: string }
  | {
      id: string
      title: string
      type: "metric"
      value: number | null
      shown: string
      previous?: number | null
      change?: number | null
      target?: number
    }
  | {
      id: string
      title: string
      type: string
      series: {
        name: string
        total: number
        previousTotal?: number | null
        change?: number | null
      }[]
      top: { label: string; value: number }[]
      points: number
    }
  | {
      id: string
      title: string
      type: "table"
      rowCount: number
      firstRows: Record<string, Scalar>[]
    }
  | { id: string; title: string; type: "text"; text: string }

const sum = (v: (number | null)[]) => v.reduce<number>((a, b) => a + (b ?? 0), 0)

/** One block's key figures: a metric's value and change, a chart's totals per series and top labels. */
export function snapshotBlock(block: DashboardBlock, out: BlockDataResponse): SnapshotBlock {
  const base = { id: block.id, title: block.title, type: block.type }
  if (!out.ok) return { ...base, error: out.error, message: out.message }
  const d = out.data
  switch (d.kind) {
    case "metric":
      return {
        ...base,
        type: "metric",
        value: d.value,
        shown: formatNumber(d.value, d.meta),
        ...(d.previous !== undefined
          ? { previous: d.previous, change: changeOf(d.value, d.previous) }
          : {}),
        ...(d.target !== undefined ? { target: d.target } : {}),
      }
    case "table":
      return { ...base, type: "table", rowCount: d.rows.length, firstRows: d.rows.slice(0, 5) }
    case "text":
      return { ...base, type: "text", text: d.markdown.slice(0, 500) }
    default: {
      const prev = new Map((d.previous?.series ?? []).map((s) => [s.name, s.values]))
      const first = d.series[0]
      const top = first
        ? d.labels
            .map((label, i) => ({ label, value: first.values[i] ?? 0 }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5)
        : []
      return {
        ...base,
        points: d.labels.length,
        top,
        series: d.series.slice(0, 6).map((s) => {
          const total = sum(s.values)
          const pv = prev.get(s.name)
          const previousTotal = pv ? sum(pv) : undefined
          return {
            name: s.name,
            total,
            ...(previousTotal !== undefined
              ? { previousTotal, change: changeOf(total, previousTotal) }
              : {}),
          }
        }),
      }
    }
  }
}

export interface Snapshot {
  dashboard: { id: string; title: string; description: string | null; version: number }
  period: string | null
  filters: string | null
  computedAs: string
  computedAt: string
  blocks: SnapshotBlock[]
}

export function snapshotOf(
  c: ComputedDashboard,
  viewer: DashboardViewer,
  asked?: Record<string, string[]>,
): Snapshot {
  return {
    dashboard: {
      id: c.view.id,
      title: c.view.title,
      description: c.view.spec.description ?? null,
      version: c.view.version,
    },
    period: periodLine(c),
    filters: filtersLine(c, asked),
    computedAs: viewer.userId,
    computedAt: new Date().toISOString(),
    blocks: c.blocks.map(({ block, out }) => snapshotBlock(block, out)),
  }
}

// ── who may receive a snapshot ─────────────────────────────────────────────

export interface RecipientCheck {
  userId: string
  name: string | null
  mayReceive: boolean
  /** Why not, in plain words. */
  reason?: string
}

/** The access that decides which rows a person's reads return: dimension grants and roles. */
export interface RowAccess {
  dimensionGrants: Record<string, string[]>
  roles?: readonly string[] | undefined
}

/**
 * Whether `recipient` sees at least every row `caller` sees: each of the caller's dimension
 * values is granted to the recipient too (a value, that dimension's "*", or the global "*"),
 * and the recipient holds every role the caller holds (rows shared with a role). Anything
 * narrower and the caller's figures would show the recipient rows their own view never shows.
 */
export function rowAccessCovers(recipient: RowAccess, caller: RowAccess): boolean {
  const r = recipient.dimensionGrants
  if (!(r["*"] ?? []).includes("*")) {
    for (const [key, values] of Object.entries(caller.dimensionGrants)) {
      const granted = r[key] ?? []
      if (granted.includes("*")) continue
      if (!values.every((v) => granted.includes(v))) return false
    }
  }
  const roles = new Set(recipient.roles ?? [])
  return (caller.roles ?? []).every((role) => roles.has(role))
}

/**
 * Whether each recipient may receive figures computed as `caller`: an active member of the org
 * who can open the dashboard (its row policies, as them), read every source behind it (each
 * block's, each dataset's, with their own permissions), and whose row access is not narrower
 * than the caller's (rowAccessCovers). Enforced by the tools: a refused person is left out of
 * what is sent; to give someone narrower figures, a routine they own computes them as them.
 */
export async function checkRecipients(
  caller: UserContext,
  dashboardId: string,
  userIds: string[],
): Promise<RecipientCheck[]> {
  const orgId = caller.orgId
  const out: RecipientCheck[] = []
  for (const userId of [...new Set(userIds)]) {
    const found = await withPrivilegedDb(orgId, "dashboard-snapshot-recipient", async (tx) => {
      const [u] = await tx
        .select({ name: users.name, status: users.status })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
        .limit(1)
      if (!u) return null
      const perms = await loadEffectivePermissions(tx, userId, orgId)
      return { u, perms }
    })
    if (!found) {
      out.push({
        userId,
        name: null,
        mayReceive: false,
        reason: "not a member of this organization",
      })
      continue
    }
    const { u, perms } = found
    if (u.status !== "active") {
      out.push({ userId, name: u.name, mayReceive: false, reason: `the account is ${u.status}` })
      continue
    }
    const ctx: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
    const reason =
      (await recipientRefusal(ctx, dashboardId)) ??
      (userId !== caller.userId && !rowAccessCovers(ctx, caller)
        ? "sees fewer rows than the figures were computed with (narrower dimension grants or roles): give them a routine of their own"
        : null)
    out.push({ userId, name: u.name, mayReceive: reason === null, ...(reason ? { reason } : {}) })
  }
  return out
}

async function recipientRefusal(ctx: UserContext, dashboardId: string): Promise<string | null> {
  if (!hasScope("kernel:dashboards:read", ctx.scopes)) return "cannot open dashboards"
  const row = await withRlsContext(ctx, async (t) => {
    const [r] = await t.select().from(dashboards).where(eq(dashboards.id, dashboardId)).limit(1)
    return r
  })
  if (!row) return "cannot see this dashboard (it is not shared with them)"
  const spec = row.spec as unknown as {
    blocks?: DashboardBlock[]
    datasets?: Record<string, BlockSource>
  }
  const sources: BlockSource[] = []
  // A layered block's layers each read a source of their own: every one is checked.
  for (const b of runnableBlocks(spec.blocks ?? [])) {
    const s = blockSourceOf(b, spec.datasets)
    if (s) sources.push(s)
    for (const id of calcDatasets(b)) {
      const ds = spec.datasets?.[id]
      if (ds) sources.push(ds)
    }
  }
  for (const s of sources) {
    const check = await checkSource(ctx.orgId, s, ctx)
    if (!check.ok) {
      const name =
        s.kind === "tool" ? s.tool : s.kind === "store" ? `${s.app}/${s.collection}` : "a table"
      return `cannot read ${name} (${check.code})`
    }
  }
  return null
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/** The most table rows a block prints. */
const PDF_MAX_ROWS = 100
/** The most columns a printed table holds (the renderer's own bound is 12). */
const PDF_MAX_COLUMNS = 8

/**
 * The dashboard as a PDF: title, description, period and filters in the header, then each block
 * (metric: value, comparison, change, target; chart: its labels by series; table: its rows;
 * note: its text; a block that failed: why).
 */
export async function renderDashboardPdf(
  c: ComputedDashboard,
  asked?: Record<string, string[]>,
  now: Date = new Date(),
): Promise<Uint8Array> {
  const record: Record<string, unknown> = {}
  const body: Record<string, unknown>[] = []
  const text = (path: string, value: string) => {
    const parts = path.split(".")
    let cur = record
    for (const p of parts.slice(0, -1)) {
      cur[p] ??= {}
      cur = cur[p] as Record<string, unknown>
    }
    cur[parts.at(-1)!] = value
    return `{{${path} ??}}`
  }
  body.push({ type: "heading", level: 1, text: text("h.title", c.view.title) })
  if (c.view.spec.description) {
    body.push({ type: "paragraph", text: text("h.description", c.view.spec.description) })
  }
  const period = periodLine(c)
  if (period) body.push({ type: "paragraph", text: text("h.period", `Period: ${period}`) })
  const filters = filtersLine(c, asked)
  if (filters) body.push({ type: "paragraph", text: text("h.filters", `Filters: ${filters}`) })
  body.push({
    type: "paragraph",
    size: 8,
    text: text(
      "h.generated",
      `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC (${c.view.timeZone})`,
    ),
  })
  c.blocks.forEach(({ block, out }, i) => {
    const p = `b${i}`
    body.push({ type: "spacer", height: 10 })
    body.push({ type: "heading", level: 2, text: text(`${p}.title`, block.title) })
    if (!out.ok) {
      body.push({ type: "paragraph", text: text(`${p}.error`, `Not shown: ${out.message}`) })
      return
    }
    const d = out.data
    switch (d.kind) {
      case "metric": {
        body.push({
          type: "paragraph",
          size: 16,
          text: text(`${p}.value`, formatNumber(d.value, d.meta)),
        })
        const parts: string[] = []
        if (d.previous !== undefined) {
          const ch = changeWords(changeOf(d.value, d.previous))
          parts.push(`Compared: ${formatNumber(d.previous, d.meta)}${ch ? ` (${ch})` : ""}`)
        }
        if (d.target !== undefined) parts.push(`Target: ${formatNumber(d.target, d.meta)}`)
        if (parts.length)
          body.push({ type: "paragraph", text: text(`${p}.extra`, parts.join(" · ")) })
        return
      }
      case "text":
        body.push({ type: "paragraph", text: text(`${p}.text`, plainMarkdown(d.markdown)) })
        return
      case "table": {
        const cols = d.columns.slice(0, PDF_MAX_COLUMNS)
        const rows = d.rows
          .slice(0, PDF_MAX_ROWS)
          .map((r) =>
            Object.fromEntries(cols.map((col, j) => [`c${j}`, scalarWords(r[col.field])])),
          )
        if (!rows.length) {
          body.push({ type: "paragraph", text: text(`${p}.empty`, "No rows.") })
          return
        }
        record[p] = { ...(record[p] as object), rows }
        body.push({
          type: "table",
          from: `${p}.rows`,
          size: 8,
          columns: cols.map((col, j) => ({
            header: text(`${p}.h${j}`, col.label),
            text: `{{c${j} ??}}`,
          })),
        })
        return
      }
      default: {
        const series = d.series.slice(0, PDF_MAX_COLUMNS - 1)
        const prev = d.previous ? new Map(d.previous.series.map((s) => [s.name, s.values])) : null
        const rows = d.labels.slice(0, PDF_MAX_ROWS).map((label, li) => ({
          c0: label,
          ...Object.fromEntries(
            series.map((s, j) => {
              const v = s.values[li] ?? null
              const pv = prev?.get(s.name)?.[li]
              const ch = pv !== undefined ? changeWords(changeOf(v, pv)) : null
              return [`c${j + 1}`, `${formatNumber(v, d.meta)}${ch ? ` (${ch})` : ""}`]
            }),
          ),
        }))
        if (!rows.length) {
          body.push({ type: "paragraph", text: text(`${p}.empty`, "No data.") })
          return
        }
        record[p] = { ...(record[p] as object), rows }
        body.push({
          type: "table",
          from: `${p}.rows`,
          size: 8,
          columns: [
            { header: text(`${p}.h0`, "Label"), text: "{{c0 ??}}" },
            ...series.map((s, j) => ({
              header: text(`${p}.h${j + 1}`, s.name),
              text: `{{c${j + 1} ??}}`,
            })),
          ],
        })
        if (d.previous) {
          body.push({
            type: "paragraph",
            size: 8,
            text: text(`${p}.note`, "In brackets: the change from the compared period."),
          })
        }
      }
    }
  })
  const out = await renderRichText({
    body: { page: { size: "A4" }, blocks: body },
    record,
    labelOf: (path) => path,
    resolveImage: async () => null,
    title: c.view.title,
  })
  return out.bytes
}

function scalarWords(v: Scalar | undefined): string {
  if (v === null || v === undefined || v === "") return ""
  return typeof v === "string" ? v : String(v)
}

/** Markdown as plain text: marks dropped, links as their words. */
function plainMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .trim()
}

// ── a PDF staged for its caller (agent) ────────────────────────────────────

/**
 * Stores `bytes` (a PDF unless `file.mimeType` says otherwise) as a kernel file staged in an
 * upload session the viewer owns: only they can
 * read it (file_upload_sessions_owner), and it attaches to a reply like a staged upload
 * (the same path as files_merge_pdfs, pdf/merge.ts).
 */
export async function stagePdfForViewer(
  viewer: DashboardViewer,
  bytes: Uint8Array,
  filename: string,
  file: { mimeType?: string; purpose?: string } = {},
): Promise<{ fileId: string; byteSize: number; filename: string }> {
  const mimeType = file.mimeType ?? "application/pdf"
  const purpose = file.purpose ?? "dashboard_pdf"
  // The quota first: a full org stages nothing (no empty upload session left behind).
  const full = await withPrivilegedDb(viewer.orgId, "dashboard-pdf-quota", async (tx) =>
    wouldExceedOrgQuota(
      tx,
      viewer.orgId,
      await loadOrgSettings(tx, viewer.orgId),
      bytes.byteLength,
    ),
  )
  if (full) throw new StorageFullError()
  const K = sql.raw(schemaRef("kernel"))
  const sessionId = await withRlsContext(viewer, async (t) => {
    const rows = (await t.execute<{ id: string }>(
      sql`INSERT INTO ${K}.file_upload_sessions (org_id, created_by, target_app, target_entity_type)
          VALUES (${viewer.orgId}, ${viewer.userId}, 'kernel', ${purpose})
          RETURNING id::text AS id`,
    )) as unknown as { id: string }[]
    return rows[0]?.id
  })
  if (!sessionId) throw new Error("could not stage the dashboard PDF")
  const fileId = randomUUID()
  const storageKey = buildStorageKey({
    orgId: viewer.orgId,
    app: "kernel",
    entityType: "file_upload_session",
    entityId: sessionId,
    filename,
  })
  await putObject({ key: storageKey, body: bytes, contentType: mimeType })
  // A failed insert leaves no object nothing refers to.
  await withPrivilegedDb(viewer.orgId, "dashboard-pdf-insert", async (tx) => {
    await tx.insert(files).values({
      id: fileId,
      orgId: viewer.orgId,
      app: "kernel",
      entityType: "file_upload_session",
      entityId: sessionId,
      filename,
      mimeType,
      sizeBytes: bytes.byteLength,
      storageKey,
      uploadedBy: viewer.userId,
      disposition: "attachment",
    })
  }).catch(async (err: unknown) => {
    await deleteObject(storageKey).catch(() => {})
    throw err
  })
  return { fileId, byteSize: bytes.byteLength, filename }
}

export class StorageFullError extends Error {
  constructor() {
    super("the organization's storage limit is reached; the PDF was not saved")
  }
}

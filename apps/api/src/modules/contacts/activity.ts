// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A company's or a contact's timeline, read from the apps that hold it and
 * stored nowhere. Each app declares a read-only `activitySources` tool; this
 * asks every one the caller may read, as the caller, in a read-only run, under
 * one shared deadline, and merges the rows newest first.
 *
 * Every row's id is `<source>:<native id>`, so rows on one timestamp order by
 * source, then id. The page cursor is the last row's `(at, id)`: each source
 * returns only rows strictly older in that order, so rows sharing a timestamp
 * are never dropped or repeated across pages. A source that reads a window of
 * time (calendar, whose recurring events are expanded within it) says where its
 * window started; the page stops there, and the next page starts there, so
 * older rows stay reachable.
 *
 * A source the caller has no scope for, or whose app is off, is never asked and
 * never named. One that fails or misses the deadline is named as unavailable.
 *
 * The kernel answers one source itself (`company`): a company's account
 * manager changes, read from the audit log under the caller's row security,
 * for a company the caller can see, with the same cursor as the others.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { isAppUnavailableFor } from "~/modules/apps/org-apps"
import { getCompany, memberNames } from "~/modules/contacts/companies"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "activity" })

/**
 * One deadline for every source together, for a page of the timeline a person
 * opens: the panel shows what answered and offers a Retry for the rest.
 */
export const ACTIVITY_DEADLINE_MS = 800
/**
 * The deadline of an agent's read (a caller that passes none: contacts_read,
 * companies_read, company_timeline). A source the agent hears nothing from is
 * reported as "no answer", and the agent has no Retry, so the deadline covers
 * a source's first, cold read rather than a panel's latency budget. Sized from
 * that cold cost: a sandboxed app's first run in a process pays a worker spawn
 * (about 1 s, worker-pool.ts) and its bundle's first evaluation (measured 250
 * to 370 ms for the largest one, invoicing, in a freshly seeded visitor org,
 * against 30 to 60 ms for an in-process app), and one agent step runs up to
 * three such reads at once (a company, a contact, a timeline). About 1.4 s
 * cold, so 3 s: twice that, and below the 5 s a production sandbox run may
 * take at most, so a source still within its own run limit is never reported
 * as silent. 800 ms was below the cold cost: a first read heard from no app.
 */
export const AGENT_READ_DEADLINE_MS = 3_000
let defaultDeadlineMs = AGENT_READ_DEADLINE_MS
/** What each linked-records read asked, for tests (null: nobody listens). */
let linkedObserver: ((asked: LinkedRecordsAsked) => void) | null = null

/** One linked-records read: each source asked, and whether it answered. */
export interface LinkedRecordsAsked {
  target: { contactId: string } | { companyId: string }
  sources: Array<{ source: string; app: string; answered: boolean; reason?: "timeout" | "error" }>
}

/** Test seam: a run whose callers pass no deadline of their own (an agent tool's read). */
export const ActivityTestAccess = {
  /** The deadline a read without its own `deadlineMs` waits (null: the shipped one). */
  setDefaultDeadlineMs(ms: number | null): void {
    defaultDeadlineMs = ms ?? AGENT_READ_DEADLINE_MS
  },
  /** Hears every linked-records read: the sources it asked and which answered. */
  observeLinkedRecords(fn: ((asked: LinkedRecordsAsked) => void) | null): void {
    linkedObserver = fn
  },
}
/** The people of a company each source is asked about, most recently active first. */
export const ACTIVITY_CONTACT_CAP = 50
/** The deals of a company each source is asked about, most recently active first. */
export const ACTIVITY_DEAL_CAP = 200
export const ACTIVITY_LIMIT_DEFAULT = 30
export const ACTIVITY_LIMIT_MAX = 100

export interface ActivityRow {
  id: string
  at: string
  source: string
  title: string
  who: string | null
  contactId: string | null
  href: { app: string; entityType: string; entityId: string } | null
}

export interface ActivityCursor {
  at: string
  id: string
}

/** What every source is given. `before` is the page cursor; rows strictly older come back. */
export interface ActivitySourceInput {
  contactIds: string[]
  companyId: string | null
  dealIds: string[]
  before: ActivityCursor | null
  limit: number
  /** The source's own row id prefix (`<filterKey>:`), for the cursor comparison. */
  prefix: string
}

/** What a source answers: its rows (native ids), and where its window began when it read one. */
export interface ActivitySourceAnswer {
  rows: Array<Omit<ActivityRow, "source">>
  windowStart?: string | null
}

export interface ActivityUnavailable {
  source: string
  label: string
  reason: "timeout" | "error"
}

export interface ActivityResult {
  items: ActivityRow[]
  unavailable: ActivityUnavailable[]
  nextBefore: string | null
  truncatedContacts?: number
  /** The company's deals past `ACTIVITY_DEAL_CAP` that no source was asked about. */
  truncatedDeals?: number
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url")
}

/** The cursor a page handed out, or null for anything else (a bad one reads as the first page). */
export function decodeActivityCursor(value: string | null | undefined): ActivityCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [at, id] = parsed
    if (typeof at !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(at)))
      return null
    return { at: new Date(at).toISOString(), id }
  } catch {
    return null
  }
}

/** Newest first; on one timestamp, by id (source, then native id), as code units. */
export function compareActivity(a: ActivityCursor, b: ActivityCursor): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** The page's subject: one company, with its people and deals, or one contact. */
interface Subject {
  contactIds: string[]
  companyId: string | null
  dealIds: string[]
  truncatedContacts: number
  truncatedDeals: number
}

const tableRef = (schema: string, name: string) =>
  drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)

async function tableExists(tx: RlsClient, schema: string, name: string): Promise<boolean> {
  const rows = extractRows<{ present: boolean }>(
    await tx.execute(
      drizzleSql`SELECT to_regclass(${`"${schemaRef(schema)}"."${name}"`}) IS NOT NULL AS present`,
    ),
  )
  return rows[0]?.present === true
}

async function readSubject(
  tx: RlsClient,
  orgId: string,
  target: { companyId: string } | { contactId: string },
): Promise<Subject | null> {
  const hasMail = await tableExists(tx, "app_mail", "conversations")
  const hasDeals = await tableExists(tx, "app_projects", "deals")
  if ("contactId" in target) {
    if (!UUID_RE.test(target.contactId)) return null
    const seen = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${tableRef("kernel", "contacts")}
         WHERE org_id = ${orgId}::uuid AND id = ${target.contactId}::uuid`),
    )
    if (seen.length === 0) return null
    const deals = hasDeals
      ? extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT task_id::text AS id FROM ${tableRef("app_projects", "deals")}
             WHERE org_id = ${orgId}::uuid AND contact_id = ${target.contactId}::uuid`),
        )
      : []
    return {
      contactIds: [target.contactId],
      companyId: null,
      dealIds: deals.map((d) => d.id),
      truncatedContacts: 0,
      truncatedDeals: 0,
    }
  }
  if (!(await getCompany(tx, { orgId, companyId: target.companyId }))) return null
  // Most recently active first: the newest mail that reached us from them, else the record's own date.
  const lastInbound = hasMail
    ? drizzleSql`(SELECT max(cv.last_message_at) FROM ${tableRef("app_mail", "conversations")} cv
                   WHERE cv.org_id = c.org_id AND cv.contact_id = c.id)`
    : drizzleSql`NULL::timestamptz`
  const people = extractRows<{ id: string; total: number }>(
    await tx.execute(drizzleSql`
      SELECT c.id::text AS id, count(*) OVER ()::int AS total
        FROM ${tableRef("kernel", "contacts")} c
       WHERE c.org_id = ${orgId}::uuid AND c.company_id = ${target.companyId}::uuid
       ORDER BY GREATEST(COALESCE(${lastInbound}, '-infinity'::timestamptz), c.updated_at) DESC, c.id
       LIMIT ${ACTIVITY_CONTACT_CAP}`),
  )
  const deals = hasDeals
    ? extractRows<{ id: string; total: number }>(
        await tx.execute(drizzleSql`
          SELECT d.task_id::text AS id, count(*) OVER ()::int AS total
            FROM ${tableRef("app_projects", "deals")} d
            JOIN ${tableRef("app_projects", "tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
           WHERE d.org_id = ${orgId}::uuid AND d.company_id = ${target.companyId}::uuid
           ORDER BY t.updated_at DESC, d.task_id
           LIMIT ${ACTIVITY_DEAL_CAP}`),
      )
    : []
  const total = people[0]?.total ?? 0
  const dealTotal = deals[0]?.total ?? 0
  return {
    contactIds: people.map((p) => p.id),
    companyId: target.companyId,
    dealIds: deals.map((d) => d.id),
    truncatedContacts: Math.max(0, total - people.length),
    truncatedDeals: Math.max(0, dealTotal - deals.length),
  }
}

interface SourceDecl {
  app: string
  tool: string
  scope: string
  label: string
  filterKey: string
}

/** The kernel's own source, answered in process: a company's account manager changes. */
const COMPANY_SOURCE: SourceDecl = {
  app: "kernel",
  tool: "",
  scope: "kernel:companies:read",
  label: "Company",
  filterKey: "company",
}

/** The sources this caller may read, in a fixed order; an unknown `only` matches none. */
function sourcesFor(
  orgId: string,
  actor: UserContext,
  only: string | null | undefined,
  subject: Subject,
): SourceDecl[] {
  const out: SourceDecl[] = []
  if (
    subject.companyId &&
    (!only || only === COMPANY_SOURCE.filterKey) &&
    hasScope(COMPANY_SOURCE.scope, actor.scopes ?? [])
  ) {
    out.push(COMPANY_SOURCE)
  }
  for (const [[, app], manifest] of appBridgeManifestRegistry.entriesOf(orgId)) {
    for (const decl of manifest.activitySources ?? []) {
      if (only && decl.filterKey !== only) continue
      if (isAppUnavailableFor(orgId, app, actor.userId)) continue
      if (!hasScope(decl.scope, actor.scopes ?? [])) continue
      const tool = toolRegistry.get([orgId, app, decl.tool])
      if (tool?.readOnly !== true || tool.gated) continue
      out.push({ app, ...decl })
    }
  }
  return out.sort((a, b) => a.filterKey.localeCompare(b.filterKey))
}

type Asked =
  | { ok: true; decl: SourceDecl; answer: ActivitySourceAnswer }
  | { ok: false; decl: SourceDecl; reason: "timeout" | "error" }

function readAnswer(data: unknown): ActivitySourceAnswer | null {
  const value = data as { rows?: unknown; windowStart?: unknown } | null
  if (!value || !Array.isArray(value.rows)) return null
  const rows: ActivitySourceAnswer["rows"] = []
  for (const raw of value.rows as Array<Record<string, unknown>>) {
    if (
      typeof raw?.id !== "string" ||
      typeof raw.at !== "string" ||
      Number.isNaN(Date.parse(raw.at))
    )
      continue
    rows.push({
      id: raw.id,
      at: new Date(raw.at).toISOString(),
      title: typeof raw.title === "string" ? raw.title : "",
      who: typeof raw.who === "string" ? raw.who : null,
      contactId: typeof raw.contactId === "string" ? raw.contactId : null,
      href: (raw.href as ActivityRow["href"]) ?? null,
    })
  }
  const windowStart =
    typeof value.windowStart === "string" && !Number.isNaN(Date.parse(value.windowStart))
      ? new Date(value.windowStart).toISOString()
      : null
  return { rows, windowStart }
}

const AUDIT_AT = drizzleSql.raw("a.at")
const AUDIT_NID = drizzleSql.raw("a.nid")

/**
 * A company's account manager changes, newest first: each audit row of a
 * `company.update` that names the previous manager, read as the caller (the
 * audit log reads within the caller's organisation), for a company the caller
 * was just shown. The row says who it went from and to, and `who` is the
 * person who changed it.
 */
export async function companyManagerRows(
  actor: UserContext,
  orgId: string,
  companyId: string,
  input: Pick<ActivitySourceInput, "before" | "limit" | "prefix">,
): Promise<ActivitySourceAnswer> {
  const rows = await withRlsContext(actor, async (tx) =>
    extractRows<{
      nid: string
      at: string | Date
      actor_id: string | null
      owner: string | null
      previous: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT * FROM (
          SELECT l.id::text AS nid, date_trunc('milliseconds', l.timestamp) AS at,
                 l.actor_id::text AS actor_id,
                 l.changes->>'ownerUserId' AS owner, l.changes->>'previousOwnerUserId' AS previous
            FROM ${tableRef("kernel", "audit_log")} l
           WHERE l.org_id = ${orgId}::uuid AND l.entity_type = 'company'
             AND l.entity_id = ${companyId} AND l.action = 'company.update'
             AND l.changes ? 'previousOwnerUserId'
             AND (l.changes->>'ownerUserId') IS DISTINCT FROM (l.changes->>'previousOwnerUserId')
        ) a
        WHERE ${olderThanCursor(AUDIT_AT, AUDIT_NID, input)}
        ${newestFirst(AUDIT_AT, AUDIT_NID, input)}`),
    ),
  )
  const names = await memberNames(
    orgId,
    rows.flatMap((r) => [r.actor_id, r.owner, r.previous].filter((v): v is string => !!v)),
  )
  const nameOf = (id: string) => names.get(id) ?? "a former member"
  return {
    rows: rows.map((r) => ({
      id: r.nid,
      at: new Date(r.at).toISOString(),
      title: !r.owner
        ? `Account manager removed (was ${nameOf(r.previous as string)})`
        : r.previous
          ? `Account manager changed from ${nameOf(r.previous)} to ${nameOf(r.owner)}`
          : `Account manager set to ${nameOf(r.owner)}`,
      who: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
      contactId: null,
      href: null,
    })),
  }
}

async function askKernel(
  orgId: string,
  actor: UserContext,
  decl: SourceDecl,
  input: Omit<ActivitySourceInput, "prefix">,
  deadline: Promise<"timeout">,
): Promise<Asked> {
  try {
    const answer = await Promise.race([
      companyManagerRows(actor, orgId, input.companyId as string, {
        ...input,
        prefix: `${decl.filterKey}:`,
      }),
      deadline,
    ])
    if (answer === "timeout") return { ok: false, decl, reason: "timeout" }
    return { ok: true, decl, answer }
  } catch (err) {
    log.info({ err, source: decl.filterKey }, "activity source failed")
    return { ok: false, decl, reason: "error" }
  }
}

async function ask(
  orgId: string,
  actor: UserContext,
  decl: SourceDecl,
  input: Omit<ActivitySourceInput, "prefix">,
  signal: AbortSignal,
  deadline: Promise<"timeout">,
): Promise<Asked> {
  if (decl === COMPANY_SOURCE) return askKernel(orgId, actor, decl, input, deadline)
  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const outer = runContextStore.getStore()
  const runId = crypto.randomUUID()
  const call = runContextStore.run(
    {
      runId,
      parentRunId: outer?.runId ?? null,
      rootRunId: outer?.rootRunId ?? runId,
      nestingDepth: (outer?.nestingDepth ?? 0) + 1,
      background: true,
      readOnlyTools: true,
    },
    () =>
      executeToolCore({
        toolName: `${decl.app}:${decl.tool}`,
        orgId,
        actor,
        params: { ...input, prefix: `${decl.filterKey}:` },
        origin: "in-app-agent",
        signal,
        readOnlyRun: true,
      }),
  )
  try {
    const envelope = await Promise.race([call, deadline])
    if (envelope === "timeout") return { ok: false, decl, reason: "timeout" }
    if (!("data" in envelope)) {
      const code = "error" in envelope ? envelope.error.code : "blocked"
      log.info({ app: decl.app, tool: decl.tool, code }, "activity source did not answer")
      return { ok: false, decl, reason: "error" }
    }
    const answer = readAnswer(envelope.data)
    return answer ? { ok: true, decl, answer } : { ok: false, decl, reason: "error" }
  } catch (err) {
    log.info({ err, app: decl.app, tool: decl.tool }, "activity source failed")
    return { ok: false, decl, reason: "error" }
  }
}

export interface ReadActivityInput {
  orgId: string
  actor: UserContext
  target: { companyId: string } | { contactId: string }
  before?: string | null
  limit?: number
  /** One source's filter key (a Retry of that source). */
  source?: string | null
  deadlineMs?: number
}

/**
 * The page of a company's or a contact's timeline the caller may see. Null when
 * the company or contact is not visible to them: the caller answers 404.
 */
export async function readActivity(input: ReadActivityInput): Promise<ActivityResult | null> {
  const { orgId, actor } = input
  const subject = await withRlsContext(actor, (tx) => readSubject(tx, orgId, input.target))
  if (!subject) return null
  const limit = Math.min(
    ACTIVITY_LIMIT_MAX,
    Math.max(1, Math.floor(input.limit ?? ACTIVITY_LIMIT_DEFAULT)),
  )
  const before = decodeActivityCursor(input.before)
  const sources = sourcesFor(orgId, actor, input.source, subject)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("timeout")
    }, input.deadlineMs ?? defaultDeadlineMs)
  })
  const asked = await Promise.all(
    sources.map((decl) =>
      ask(
        orgId,
        actor,
        decl,
        {
          contactIds: subject.contactIds,
          companyId: subject.companyId,
          dealIds: subject.dealIds,
          before,
          limit,
        },
        controller.signal,
        deadline,
      ),
    ),
  )
  clearTimeout(timer)

  const rows: ActivityRow[] = []
  const unavailable: ActivityUnavailable[] = []
  // The newest point a windowed source stopped at: nothing older is shown on this page.
  let floor: string | null = null
  for (const a of asked) {
    if (!a.ok) {
      unavailable.push({ source: a.decl.filterKey, label: a.decl.label, reason: a.reason })
      continue
    }
    for (const row of a.answer.rows) {
      const id = `${a.decl.filterKey}:${row.id}`
      // A source that ignored the cursor cannot repeat a row.
      if (before && compareActivity({ at: row.at, id }, before) <= 0) continue
      rows.push({ ...row, id, source: a.decl.filterKey })
    }
    const start = a.answer.windowStart
    if (start && (!floor || Date.parse(start) > Date.parse(floor))) floor = start
  }
  // Rows at or under the floor come back on the next page, with the window's own.
  const kept = floor ? rows.filter((r) => Date.parse(r.at) > Date.parse(floor as string)) : rows
  kept.sort(compareActivity)
  const items = kept.slice(0, limit)
  const last = items.at(-1)
  const nextBefore =
    items.length === limit && last
      ? encodeActivityCursor({ at: last.at, id: last.id })
      : floor
        ? // Every row on the floor's own timestamp is still to come: the highest id.
          encodeActivityCursor({ at: floor, id: "￿" })
        : null
  return {
    items,
    unavailable,
    nextBefore,
    ...(subject.truncatedContacts > 0 ? { truncatedContacts: subject.truncatedContacts } : {}),
    ...(subject.truncatedDeals > 0 ? { truncatedDeals: subject.truncatedDeals } : {}),
  }
}

/**
 * A source's SQL condition for "strictly older than the cursor" on `(at, id)`,
 * with `id` compared as the full `<prefix><native id>` in code-unit order, as
 * the merge compares it.
 */
export function olderThanCursor(
  at: ReturnType<typeof drizzleSql.raw>,
  nativeId: ReturnType<typeof drizzleSql.raw>,
  input: Pick<ActivitySourceInput, "before" | "prefix">,
) {
  const c = input.before
  if (!c) return drizzleSql`TRUE`
  return drizzleSql`(${at} < ${c.at}::timestamptz
    OR (${at} = ${c.at}::timestamptz AND (${input.prefix} || ${nativeId}) COLLATE "C" < ${c.id} COLLATE "C"))`
}

/** The input a source tool was called with, made safe: ids only, caps applied. */
export function parseSourceInput(raw: unknown): ActivitySourceInput {
  const value = (raw ?? {}) as Record<string, unknown>
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)).slice(0, 200)
      : []
  const before = value.before as { at?: unknown; id?: unknown } | null | undefined
  return {
    contactIds: ids(value.contactIds).slice(0, ACTIVITY_CONTACT_CAP),
    companyId:
      typeof value.companyId === "string" && UUID_RE.test(value.companyId) ? value.companyId : null,
    dealIds: ids(value.dealIds).slice(0, ACTIVITY_DEAL_CAP),
    before:
      before && typeof before.at === "string" && typeof before.id === "string"
        ? { at: new Date(before.at).toISOString(), id: before.id }
        : null,
    limit: Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, Number(value.limit) || ACTIVITY_LIMIT_DEFAULT)),
    prefix: typeof value.prefix === "string" ? value.prefix : "",
  }
}

/** Order and cap of every source's own query. */
export function newestFirst(
  at: ReturnType<typeof drizzleSql.raw>,
  nativeId: ReturnType<typeof drizzleSql.raw>,
  input: Pick<ActivitySourceInput, "prefix" | "limit">,
) {
  return drizzleSql`ORDER BY ${at} DESC, (${input.prefix} || ${nativeId}) COLLATE "C" DESC LIMIT ${input.limit}`
}

/** The query a timeline page is asked with, by the page and the tool alike. */
export const activityQuerySchema = z.object({
  before: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_LIMIT_MAX).optional(),
  source: z.string().max(64).optional(),
})

class ReadOnlyDone<T> {
  constructor(readonly value: T) {}
}

/**
 * Runs a source's reads in a savepoint set read-only, then rolls it back: a
 * source that tries to write fails, and nothing it did stays.
 */
export async function withReadOnlySource<T>(
  db: RlsClient,
  read: (tx: RlsClient) => Promise<T>,
): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL transaction_read_only = on`)
      throw new ReadOnlyDone(await read(tx as unknown as RlsClient))
    })
  } catch (err) {
    if (err instanceof ReadOnlyDone) return err.value as T
    throw err
  }
  throw new Error("activity source: no answer")
}

/** The records one app holds for a contact, by kind, as its timeline source answers them. */
export interface LinkedRecordKind {
  kind: string
  /** Distinct records seen; with `more`, the source had more rows than it was asked for. */
  count: number
  more: boolean
  newest: { title: string; entityId: string; at: string }
  /** Up to three distinct row titles of this kind, newest first (the newest's among them). */
  recent: string[]
}

/** Distinct row titles kept per kind of linked record. */
const LINKED_RECENT = 3

export interface LinkedApp {
  app: string
  source: string
  label: string
  kinds: LinkedRecordKind[]
}

export interface LinkedRecords {
  apps: LinkedApp[]
  unavailable: ActivityUnavailable[]
}

/**
 * The records other apps hold for one contact, under the caller's own scopes:
 * the timeline's sources, each asked as the caller in a read-only run under one
 * deadline (`readActivity`'s rules), grouped by the record each row opens. A
 * source the caller has no scope for, or whose app is off, is never asked and
 * never named; a record the caller's row security hides is never returned by
 * its source. `skip` leaves out sources (by filter key) the caller shows itself.
 * With `companyId` instead, the records of the company and its people (the
 * company's timeline sources, its own account manager source left out).
 * Null when the contact or company is not visible to the caller.
 */
export async function readLinkedRecords(
  input: {
    orgId: string
    actor: UserContext
    skip?: readonly string[]
    deadlineMs?: number
  } & ({ contactId: string } | { companyId: string }),
): Promise<LinkedRecords | null> {
  const { orgId, actor } = input
  const target =
    "companyId" in input ? { companyId: input.companyId } : { contactId: input.contactId }
  const subject = await withRlsContext(actor, (tx) => readSubject(tx, orgId, target))
  if (!subject) return null
  const skip = new Set(input.skip ?? [])
  const sources = sourcesFor(orgId, actor, null, subject).filter(
    (d) => d !== COMPANY_SOURCE && !skip.has(d.filterKey),
  )
  if (sources.length === 0) return { apps: [], unavailable: [] }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("timeout")
    }, input.deadlineMs ?? defaultDeadlineMs)
  })
  const limit = ACTIVITY_LIMIT_MAX
  const asked = await Promise.all(
    sources.map((decl) =>
      ask(
        orgId,
        actor,
        decl,
        {
          contactIds: subject.contactIds,
          companyId: subject.companyId,
          dealIds: subject.dealIds,
          before: null,
          limit,
        },
        controller.signal,
        deadline,
      ),
    ),
  )
  clearTimeout(timer)
  linkedObserver?.({
    target,
    sources: asked.map((a) => ({
      source: a.decl.filterKey,
      app: a.decl.app,
      answered: a.ok,
      ...(a.ok ? {} : { reason: a.reason }),
    })),
  })

  const apps: LinkedApp[] = []
  const unavailable: ActivityUnavailable[] = []
  for (const a of asked) {
    if (!a.ok) {
      unavailable.push({ source: a.decl.filterKey, label: a.decl.label, reason: a.reason })
      continue
    }
    const rows = a.answer.rows
      .filter((r) => r.href)
      .map((r) => ({ ...r, id: `${a.decl.filterKey}:${r.id}` }))
      .sort(compareActivity)
    const kinds = new Map<
      string,
      { ids: Set<string>; newest: LinkedRecordKind["newest"]; recent: string[] }
    >()
    for (const r of rows) {
      const href = r.href as NonNullable<ActivityRow["href"]>
      const k = kinds.get(href.entityType)
      if (k) {
        k.ids.add(href.entityId)
        if (k.recent.length < LINKED_RECENT && !k.recent.includes(r.title)) k.recent.push(r.title)
      } else
        kinds.set(href.entityType, {
          ids: new Set([href.entityId]),
          newest: { title: r.title, entityId: href.entityId, at: r.at },
          recent: [r.title],
        })
    }
    if (kinds.size === 0) continue
    const more = a.answer.rows.length >= limit
    apps.push({
      app: a.decl.app,
      source: a.decl.filterKey,
      label: a.decl.label,
      kinds: [...kinds].map(([kind, k]) => ({
        kind,
        count: k.ids.size,
        more,
        newest: k.newest,
        recent: k.recent,
      })),
    })
  }
  return { apps, unavailable }
}

/**
 * One line per app of a linked-records read: how many records of each kind, the
 * newest with the id that opens it, and the other recent row titles.
 */
export function linkedAppLine(app: LinkedApp): string {
  const kinds = app.kinds.map((k) => {
    const n = `${k.count}${k.more ? "+" : ""} ${k.kind}${k.count === 1 && !k.more ? "" : "s"}`
    const also = k.recent.filter((t) => t !== k.newest.title)
    const rest = also.length > 0 ? `, also ${also.map((t) => `"${t}"`).join(", ")}` : ""
    return `${n}, newest "${k.newest.title}" (${app.app} ${k.kind} ${k.newest.entityId})${rest}`
  })
  return `${app.label}: ${kinds.join("; ")}`
}

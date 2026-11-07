// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org caps: seats, mailboxes, storage and background jobs per hour.
//
// The caps live in `organizations.caps` (migration 0237), `{seats?, mailboxes?,
// storageGb?, jobsPerHour?}`; a missing or null key is unlimited, which is how
// every org starts on a self-hosted instance. Only the operator sets them
// (`liaison org caps`, the `limits` section of `liaison config apply`); an org
// admin reads them through `GET /api/org/usage` and cannot change them (the org
// PATCH refuses `caps`, and `limits` has no agent config tool).
//
// What counts:
//  - seats: `kernel.users` of the org with status `active` (agents live in
//    `kernel.agents`; deactivated people, import placeholders and the erasure
//    sentinel are `deactivated`, so none of them count);
//  - mailboxes: the distinct addresses of the org's mailbox connections
//    (`gmail` / `imap`, for Mail or Tickets, mail-domains.ts) that are not
//    disconnected. The same address connected twice is one mailbox. This is the
//    self-hosted operator's cap: in the managed edition a plan limits storage,
//    not mailboxes, so connecting one is never refused there;
//  - storage: the bytes of the org's files (files/service.ts enforces it);
//  - jobs per hour: infra/jobs/org-job-cap.ts (delays, never refuses);
//  - custom apps: the org's own private apps (`countCustomApps`), refused at
//    the cap under the org lock like a seat (`assertCustomAppRoom`);
//  - audit days: how long audit rows are kept. In the managed edition the
//    retention is min(the admin's choice ?? the cap, the cap)
//    (`effectiveAuditRetentionDays`, org/audit-retention.ts), and an admin's
//    choice above the cap is refused (AUDIT_DAYS_LIMIT_REACHED).
//
// A seat or mailbox is added under an org advisory lock taken in the adding
// transaction, so the count and the insert are one step: two people accepting
// the last seat at once get one seat and one SEAT_LIMIT_REACHED (409, with
// `{limit, used}`). Orgs without that cap take no lock and run no count.
//
// The caps are read, and the seats or mailboxes counted, on that same
// transaction (privilegedFrom: elevated in place when its login can step into
// liaison_admin, as is when it already runs as it). A check never asks the
// privileged pool for a second connection while it holds one and the lock, so
// a burst of connects or sign-ups as large as the pool cannot convoy behind
// the lock (caps.test.ts, a burst twice the pool's size on a 2-slot pool). On a
// split request login (DATABASE_REQUEST_PASSWORD) a member's RLS transaction
// cannot elevate: its count is one short read on the privileged pool, taken
// from an RLS-pool connection, the nesting that pool exists for; the holders of
// privileged slots still never take another.
//
// Accepted: the level a successful add reaches is noted while its
// transaction is still open, as the database layer has no after-commit hook.
// A rollback after the check (an invite email taken meanwhile) leaves the
// stored level one step high until the next add or removal recounts it, and
// may have sent one notice early.
//
// Crossing 80 % and 100 % of a cap tells the org admins (holders of
// `kernel:org:admin`) through the attention pipeline (`org_cap:threshold`,
// kernel-translations.ts): one item per cap and threshold per crossing,
// re-armed once usage is back under the threshold. A crossing is recorded only
// once its notice is in the outbox, so a notice that could not be queued is
// retried by the next evaluation.

import { AsyncResource } from "node:async_hooks"
import { createHash } from "node:crypto"
import {
  ORG_CAP_KINDS,
  type OrgCapKind,
  type OrgCaps,
  type OrgUsage,
  orgCapsSchema,
  resolveLocale,
  type ShippedLocale,
} from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray, ne } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { privilegedFrom, withSystemDb } from "~/db/privileged"
import {
  appsInstalled,
  connectedAccounts,
  files,
  organizations,
  orgBillingState,
  type StorageEstimate,
  users,
} from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { MAILBOX_CONNECTIONS } from "~/modules/apps/connections/mail-domains"
import { type ServerTParams, serverT } from "~/modules/i18n/server-i18n"

const log = rootLogger.child({ service: "org-caps" })

const CAP_LIMIT_CODES = {
  seats: "SEAT_LIMIT_REACHED",
  mailboxes: "MAILBOX_LIMIT_REACHED",
  customApps: "CUSTOM_APP_LIMIT_REACHED",
  auditDays: "AUDIT_DAYS_LIMIT_REACHED",
} as const

function capLimitMessage(kind: keyof typeof CAP_LIMIT_CODES, limit: number): string {
  switch (kind) {
    // In the managed edition the plan sets the limit, so the way out is a larger
    // plan in Billing, never "whoever runs the server" (the customer does not).
    case "seats":
      return isManagedEdition()
        ? `This organization uses all of its ${limit} seats. Move to a plan with more in Billing, or an admin can deactivate someone first.`
        : `This organization uses all of its ${limit} seats. Whoever runs the server can raise the limit, or an admin can deactivate someone first.`
    case "mailboxes":
      return `This organization uses all of its ${limit} mailboxes. Whoever runs the server can raise the limit, or an admin can disconnect a mailbox first.`
    case "customApps":
      return `This organization uses all of its ${limit} custom apps. Remove one first, or move to a plan with more.`
    case "auditDays":
      return `This organization's plan keeps the audit log for up to ${limit} days. Choose ${limit} days or fewer.`
  }
}

/**
 * A seat, mailbox or custom app refused at its cap, or an audit retention
 * chosen above it (`used` is then the days asked for). Surfaces as 409 with
 * `{limit, used}`.
 */
export class CapLimitError extends Error {
  readonly status = 409
  readonly code: (typeof CAP_LIMIT_CODES)[keyof typeof CAP_LIMIT_CODES]
  readonly details: { limit: number; used: number }
  constructor(
    readonly kind: keyof typeof CAP_LIMIT_CODES,
    limit: number,
    used: number,
  ) {
    super(capLimitMessage(kind, limit))
    this.name = "CapLimitError"
    this.code = CAP_LIMIT_CODES[kind]
    this.details = { limit, used }
  }
}

/**
 * The caps as stored, tolerant of what a later release may add: an unknown key
 * is ignored and an invalid value reads as unlimited (expand/contract: never
 * throw on a shape this release does not know).
 */
export function normalizeCaps(raw: unknown): OrgCaps {
  const out: OrgCaps = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const kind of ORG_CAP_KINDS) {
    const v = (raw as Record<string, unknown>)[kind]
    // A cap is a whole number >= 1 (the column check); anything under
    // 1 reads as unlimited, never as a cap of 0.
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) out[kind] = v
  }
  return out
}

/** The cap of one kind, or null for unlimited. */
export function capOf(caps: OrgCaps, kind: OrgCapKind): number | null {
  const v = caps[kind]
  return typeof v === "number" ? v : null
}

/**
 * The caps read on the caller's own transaction (elevated in place when its
 * login can, privilegedFrom), so a cap check holding a privileged slot never
 * asks the pool for a second one.
 */
async function readOrgCapsOn(tx: RlsClient | PrivilegedDb, orgId: string): Promise<OrgCaps> {
  const [row] = await privilegedFrom(tx, orgId, "org-caps-read", (db) =>
    db
      .select({ caps: organizations.caps })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return normalizeCaps(row?.caps)
}

export async function readOrgCaps(orgId: string): Promise<OrgCaps> {
  const [row] = await withSystemDb("org-caps-read", (db) =>
    db
      .select({ caps: organizations.caps })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return normalizeCaps(row?.caps)
}

/**
 * Change an org's caps (the operator's CLI and config apply only). `set` keys
 * replace, `unset` keys go back to unlimited; others are kept. Returns the caps
 * now stored.
 */
export async function setOrgCaps(
  orgId: string,
  change: { set?: Partial<Record<OrgCapKind, number>>; unset?: readonly OrgCapKind[] },
): Promise<OrgCaps> {
  const set = orgCapsSchema.parse(change.set ?? {})
  const unset = [...(change.unset ?? [])]
  return withSystemDb("org-caps-set", async (db) => {
    const [row] = await db
      .select({ caps: organizations.caps })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update")
    if (!row) throw new Error(`org ${orgId} not found`)
    const next: Record<string, unknown> = { ...(row.caps as Record<string, unknown>) }
    for (const [k, v] of Object.entries(set)) {
      if (v === null || v === undefined) delete next[k]
      else next[k] = v
    }
    for (const k of unset) delete next[k]
    await db
      .update(organizations)
      .set({ caps: next as OrgCaps, updatedAt: new Date() })
      .where(eq(organizations.id, orgId))
    return normalizeCaps(next)
  })
}

/** One advisory lock per org and cap kind, held until the transaction ends. */
async function lockCap(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  kind: "seats" | "mailboxes" | "customApps",
): Promise<void> {
  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`org-cap:${kind}:${orgId}`}, 0))`,
  )
}

/** Active members of the org (the seats in use): a client's portal account takes no seat. */
export async function countSeats(db: RlsClient | PrivilegedDb, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.status, "active"), eq(users.userType, "member")))
  return Number(row?.n ?? 0)
}

/** The distinct addresses of the org's connected mailboxes (not disconnected). */
async function mailboxAddressesOn(db: PrivilegedDb, orgId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ identifier: connectedAccounts.identifier })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.orgId, orgId),
        inArray(connectedAccounts.connectionName, [...MAILBOX_CONNECTIONS]),
        ne(connectedAccounts.status, "disconnected"),
      ),
    )
  return new Set(rows.map((r) => r.identifier.toLowerCase()))
}

export async function mailboxAddresses(orgId: string): Promise<Set<string>> {
  return withSystemDb("org-caps-mailboxes", (db) => mailboxAddressesOn(db, orgId))
}

/**
 * Check, under the org's seats lock, that one more active person fits. Call it
 * in the transaction that then inserts (or reactivates) the person, before the
 * write: the lock is held until that transaction ends. `caps` lets a caller
 * whose transaction cannot read `organizations` (an RLS context) pass them in.
 */
export async function assertSeatRoom(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  opts: { caps?: OrgCaps } = {},
): Promise<void> {
  const limit = capOf(opts.caps ?? (await readOrgCapsOn(tx, orgId)), "seats")
  if (limit === null) return
  await lockCap(tx, orgId, "seats")
  // Counted on the same transaction, elevated in place when its RLS would hide
  // someone: never a second pool connection while the lock is held.
  const used = await privilegedFrom(tx, orgId, "org-caps-seats", (db) => countSeats(db, orgId))
  noteCapLevel(orgId, "seats", used, limit)
  if (used + 1 > limit) {
    noteCapLevel(orgId, "seats", used + 1, limit)
    throw new CapLimitError("seats", limit, used)
  }
  noteCapLevel(orgId, "seats", used + 1, limit)
}

/**
 * The invite form's early answer: refused when the org already uses every
 * seat, so the admin learns before the invitation goes out. Not a guarantee
 * (the accept is the enforcement point); takes no lock.
 */
export async function assertSeatRoomSoft(
  db: RlsClient | PrivilegedDb,
  orgId: string,
): Promise<void> {
  const limit = capOf(await readOrgCapsOn(db, orgId), "seats")
  if (limit === null) return
  const used = await privilegedFrom(db, orgId, "org-caps-seats", (pdb) => countSeats(pdb, orgId))
  if (used + 1 > limit) throw new CapLimitError("seats", limit, used)
}

/**
 * Check, under the org's mailboxes lock, that connecting `identifier` fits. An
 * address already connected (a reconnect, or the same mailbox for another
 * app) adds nothing and always passes. Call it in the transaction that then
 * writes the connection, before the write.
 *
 * Never refuses in the managed edition, whatever an older billing push left in
 * the caps: a plan limits storage, not mailboxes.
 */
export async function assertMailboxRoom(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  identifier: string,
): Promise<void> {
  if (isManagedEdition()) return
  const limit = capOf(await readOrgCapsOn(tx, orgId), "mailboxes")
  if (limit === null) return
  await lockCap(tx, orgId, "mailboxes")
  // A member's RLS context cannot see the org's other mailboxes: counted on the
  // same transaction elevated in place (privilegedFrom), never a second pool
  // connection under the lock. Read after the lock, so a concurrent connect
  // that held it has committed and is counted.
  const addresses = await privilegedFrom(tx, orgId, "org-caps-mailboxes", (db) =>
    mailboxAddressesOn(db, orgId),
  )
  if (addresses.has(identifier.toLowerCase())) return
  const used = addresses.size
  noteCapLevel(orgId, "mailboxes", used, limit)
  if (used + 1 > limit) {
    noteCapLevel(orgId, "mailboxes", used + 1, limit)
    throw new CapLimitError("mailboxes", limit, used)
  }
  noteCapLevel(orgId, "mailboxes", used + 1, limit)
}

/**
 * The org's custom apps (its own private apps, `apps_installed.org_id`, 0252):
 * distinct names, whatever number of versions each keeps.
 */
export async function countCustomApps(
  db: RlsClient | PrivilegedDb,
  orgId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: drizzleSql<number>`count(DISTINCT ${appsInstalled.name})::int` })
    .from(appsInstalled)
    .where(eq(appsInstalled.orgId, orgId))
  return Number(row?.n ?? 0)
}

type CustomAppCounter = (db: RlsClient | PrivilegedDb, orgId: string) => Promise<number>
let customAppCounter: CustomAppCounter | null = null

/** Test seams on the custom app count. */
export const OrgCapsTestAccess = {
  /** Count custom apps with `fn` (null: the real count). */
  setCustomAppCounter(fn: CustomAppCounter | null): void {
    customAppCounter = fn
  },
}

/**
 * Check, under the org's custom apps lock, that one more custom app fits. Call
 * it in the transaction that then installs the app, before the write.
 */
export async function assertCustomAppRoom(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  opts: { caps?: OrgCaps } = {},
): Promise<void> {
  const limit = capOf(opts.caps ?? (await readOrgCapsOn(tx, orgId)), "customApps")
  if (limit === null) return
  await lockCap(tx, orgId, "customApps")
  const count = customAppCounter ?? countCustomApps
  const used = await privilegedFrom(tx, orgId, "org-caps-custom-apps", (db) => count(db, orgId))
  noteCapLevel(orgId, "customApps", used, limit)
  if (used + 1 > limit) {
    noteCapLevel(orgId, "customApps", used + 1, limit)
    throw new CapLimitError("customApps", limit, used)
  }
  noteCapLevel(orgId, "customApps", used + 1, limit)
}

/** The audit retention when nothing is set (self-hosted, and an uncapped managed org). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90

function wholeDays(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null
}

/**
 * How many days of audit rows the org keeps. Managed: min(the admin's choice
 * ?? the plan's `auditDays`, `auditDays`); the 90-day settings default is not
 * read when the plan caps it. Self-hosted: `settings.auditRetentionDays`, else
 * 90, as always. Mirrors the SQL of org/audit-retention.ts.
 */
export function effectiveAuditRetentionDays(
  caps: OrgCaps,
  settings: Record<string, unknown> | null | undefined,
): number {
  const set = settings ?? {}
  const configured = wholeDays(set.auditRetentionDays)
  if (!isManagedEdition()) return configured ?? DEFAULT_AUDIT_RETENTION_DAYS
  const chosen = wholeDays(set.auditRetentionDaysChosen)
  const cap = capOf(caps, "auditDays")
  if (cap === null) return chosen ?? configured ?? DEFAULT_AUDIT_RETENTION_DAYS
  return Math.min(chosen ?? cap, cap)
}

/** Refuse an audit retention above the plan's cap (managed org settings PATCH). */
export function assertAuditDaysWithinCap(caps: OrgCaps, days: number): void {
  const cap = capOf(caps, "auditDays")
  if (cap !== null && days > cap) throw new CapLimitError("auditDays", cap, days)
}

/** True when the connection is a mailbox the mailbox cap counts. */
export function isMailboxConnection(connectionName: string): boolean {
  return MAILBOX_CONNECTIONS.has(connectionName)
}

/** Stored bytes of the org's files. */
async function storageBytes(orgId: string): Promise<number> {
  const [row] = await withSystemDb("org-caps-storage", (db) =>
    db
      .select({ total: drizzleSql<string>`COALESCE(SUM(${files.sizeBytes}), 0)::text` })
      .from(files)
      .where(eq(files.orgId, orgId)),
  )
  return Number(row?.total ?? 0)
}

const GB = 1024 ** 3

const gbUp = (bytes: number) => Math.ceil((bytes / GB) * 100) / 100

/** The last nightly estimate (cloud/storage-estimate.ts), null before one or on a self-hosted server. */
export async function storageEstimateOf(orgId: string): Promise<StorageEstimate | null> {
  const [row] = await withSystemDb("org-caps-storage-estimate", (db) =>
    db
      .select({ estimate: orgBillingState.storageEstimate })
      .from(orgBillingState)
      .where(eq(orgBillingState.orgId, orgId))
      .limit(1),
  )
  return row?.estimate ?? null
}

/** The usage block's numbers: each cap as used / limit (null = unlimited). */
export async function getOrgUsage(orgId: string): Promise<OrgUsage> {
  const caps = await readOrgCaps(orgId)
  const [seats, mailboxes, bytes, jobs, estimate] = await Promise.all([
    withSystemDb("org-caps-usage-seats", (db) => countSeats(db, orgId)),
    mailboxAddresses(orgId).then((s) => s.size),
    storageBytes(orgId),
    jobsThisHour(orgId),
    storageEstimateOf(orgId),
  ])
  const storageGb = gbUp(bytes)
  return {
    seats: { used: seats, limit: capOf(caps, "seats") },
    mailboxes: { used: mailboxes, limit: capOf(caps, "mailboxes") },
    storageGb: { used: storageGb, limit: capOf(caps, "storageGb") },
    jobsThisHour: { used: jobs, limit: capOf(caps, "jobsPerHour") },
    storageEstimate: estimate
      ? {
          usedGb: gbUp(estimate.bytes),
          limitGb: capOf(caps, "storageGb"),
          measuredAt: estimate.measuredAt,
          partial: estimate.partial,
          overCap: estimate.overCap,
        }
      : null,
  }
}

// --- Job hour buckets (shared with infra/jobs/org-job-cap.ts) ---------------

const HOUR_MS = 3_600_000

/** The hour bucket a timestamp falls in (hours since the epoch, UTC). */
export function hourBucket(ms: number): number {
  return Math.floor(ms / HOUR_MS)
}

export function hourBucketStart(bucket: number): number {
  return bucket * HOUR_MS
}

/** Redis key of one org's job count in one hour bucket. */
export function jobBucketKey(orgId: string, bucket: number): string {
  return `orgcap:jobs:${orgId}:${bucket}`
}

/** Jobs counted in the current hour (delayed jobs count in the hour they run). */
export async function jobsThisHour(orgId: string, now = Date.now()): Promise<number> {
  try {
    const v = await redis.get(jobBucketKey(orgId, hourBucket(now)))
    return Number(v ?? 0)
  } catch (err) {
    log.warn({ err, orgId }, "org caps: could not read this hour's job count")
    return 0
  }
}

// --- Threshold notices -------------------------------------------------------

export const CAP_THRESHOLDS = [80, 100] as const
type Level = 0 | 80 | 100

export function capLevel(used: number, limit: number): Level {
  if (limit <= 0) return used > 0 || limit === 0 ? 100 : 0
  const pct = (used / limit) * 100
  if (pct >= 100) return 100
  if (pct >= 80) return 80
  return 0
}

const levelKey = (orgId: string, kind: OrgCapKind) => `orgcap:level:${orgId}:${kind}`
/** How long a notice level is remembered without activity (re-armed after). */
const LEVEL_TTL_S = 90 * 24 * 3600

const CAP_LABEL_KEY: Record<OrgCapKind, string> = {
  seats: "kernel.orgUsage.seats",
  mailboxes: "kernel.orgUsage.mailboxes",
  storageGb: "kernel.orgUsage.storage",
  jobsPerHour: "kernel.orgUsage.jobs",
  customApps: "kernel.orgUsage.customApps",
  auditDays: "kernel.orgUsage.auditDays",
}

export function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * The notice text, in the org's language (its default locale): one summary
 * reaches every admin, so it is written once, the way the org reads.
 */
export function noticeSummary(
  locale: ShippedLocale,
  kind: OrgCapKind,
  level: 80 | 100,
  used: number,
  limit: number,
): string {
  const t = (key: string, params?: ServerTParams) => serverT(locale, key, params)
  const shown =
    kind === "storageGb"
      ? t("kernel.orgUsage.storageUsedOfLimit", { used, limit })
      : t("kernel.orgUsage.usedOfLimit", { used, limit })
  const label = t(CAP_LABEL_KEY[kind])
  // The managed edition's customer runs no server: the way out is the plan, in Billing.
  const managed = isManagedEdition()
  const head =
    level >= 100
      ? t("kernel.orgUsage.noticeReached", { label, shown })
      : t("kernel.orgUsage.noticeNear", { label, shown })
  const tail =
    kind === "jobsPerHour"
      ? t("kernel.orgUsage.noticeTailJobs")
      : kind === "storageGb"
        ? level >= 100
          ? t(
              managed
                ? "kernel.orgUsage.noticeTailStorageFullManaged"
                : "kernel.orgUsage.noticeTailStorageFull",
            )
          : t(
              managed
                ? "kernel.orgUsage.noticeTailStorageNearManaged"
                : "kernel.orgUsage.noticeTailStorageNear",
            )
        : t(managed ? "kernel.orgUsage.noticeTailOtherManaged" : "kernel.orgUsage.noticeTailOther")
  return `${head} ${tail}`
}

export async function orgLocale(orgId: string): Promise<ShippedLocale> {
  const [row] = await withSystemDb("org-cap-notice-locale", (db) =>
    db
      .select({ locale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return resolveLocale(row?.locale ?? null)
}

/**
 * Queue the attention event for one crossing. Never throws: true once the
 * notice is in the outbox, false when it could not be queued (the caller then
 * leaves the crossing unrecorded so a later evaluation retries it).
 */
export async function emitCapNotice(
  orgId: string,
  kind: OrgCapKind,
  level: 80 | 100,
  used: number,
  limit: number,
  periodId: string,
): Promise<boolean> {
  try {
    const summary = noticeSummary(await orgLocale(orgId), kind, level, used, limit)
    await withSystemDb("org-cap-notice", (db) =>
      db.queueEvent({
        app: "kernel",
        entity: "org_cap",
        action: "threshold",
        entityId: uuidFrom(`${orgId}|${kind}|${level}|${periodId}`),
        orgId,
        actorType: "system",
        actorId: null,
        timestamp: new Date().toISOString(),
        data: {
          cap: kind,
          threshold: level,
          used,
          limit,
          summary,
          settingsRoute: "/settings/admin/org",
        },
      }),
    )
    return true
  } catch (err) {
    log.warn({ err, orgId, kind, level }, "org caps: the threshold notice could not be queued")
    return false
  }
}

/**
 * Record a cap's usage level and tell the admins when it rises past 80 % or
 * 100 %. A level under the stored one re-arms (the next crossing notifies
 * again). A rising level is stored only once its notice is queued, so a lost
 * notice is retried by the next evaluation instead of being recorded as sent.
 * Seats, mailboxes and storage only; jobs have their own daily rule.
 */
export async function evaluateCapLevel(
  orgId: string,
  kind: Exclude<OrgCapKind, "jobsPerHour">,
  used: number,
  limit: number,
): Promise<void> {
  const level = capLevel(used, limit)
  try {
    const prev = Number((await redis.get(levelKey(orgId, kind))) ?? 0) as Level
    if (level === prev) return
    if (level > prev && level >= 80) {
      const sent = await emitCapNotice(
        orgId,
        kind,
        level as 80 | 100,
        used,
        limit,
        String(Date.now()),
      )
      if (!sent) return
    }
    await redis.set(levelKey(orgId, kind), String(level), "EX", LEVEL_TTL_S)
  } catch (err) {
    log.warn({ err, orgId, kind }, "org caps: could not evaluate the cap level")
  }
}

/**
 * The async scope the queued evaluations run in: this module's, not the
 * caller's. A promise reaction runs in the context of the code that queued it,
 * so an evaluation queued from inside a privileged transaction (a seat check
 * while a user is created) would otherwise read and write on privileged
 * connections of its own while that caller still holds one. The evaluation is
 * not part of the caller's work, so it runs outside it.
 */
const levelScope = new AsyncResource("org-cap-level")

/** Fire-and-forget `evaluateCapLevel`, in call order per process. */
let levelChain: Promise<void> = Promise.resolve()
export function noteCapLevel(
  orgId: string,
  kind: Exclude<OrgCapKind, "jobsPerHour">,
  used: number,
  limit: number,
): void {
  levelChain = levelChain.then(() =>
    levelScope.runInAsyncScope(() => evaluateCapLevel(orgId, kind, used, limit)),
  )
}

/** Waits for the queued level evaluations (tests). */
export function capLevelsSettled(): Promise<void> {
  return levelChain
}

const jobNoticeKey = (orgId: string, level: 80 | 100, day: string) =>
  `orgcap:jobnotice:${orgId}:${level}:${day}`

/**
 * The job cap's notice: when this hour's count reaches 80 % or 100 % of the
 * cap, at most once per day per threshold. Never throws.
 */
export async function noteJobHourCount(orgId: string, count: number, limit: number): Promise<void> {
  const level = capLevel(count, limit)
  if (level === 0) return
  // Only the job that makes the count reach the threshold checks Redis.
  const threshold = level === 100 ? limit : Math.ceil(limit * 0.8)
  if (count !== threshold) return
  const day = new Date().toISOString().slice(0, 10)
  try {
    const first = await redis.set(jobNoticeKey(orgId, level, day), "1", "EX", 2 * 86_400, "NX")
    if (first !== "OK") return
    // Not sent: free the day's mark so the next job at the threshold retries.
    if (!(await emitCapNotice(orgId, "jobsPerHour", level, count, limit, day))) {
      await redis.del(jobNoticeKey(orgId, level, day))
    }
  } catch (err) {
    log.warn({ err, orgId }, "org caps: could not record the job notice")
  }
}

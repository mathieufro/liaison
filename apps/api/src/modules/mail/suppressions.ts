// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Opt-outs: the addresses an organization must not send commercial mail to.
 *
 * An address is never stored, only its fingerprint (`hashEmail`), so the list can answer "has this
 * address opted out" and nothing else. The send check reads it on its privileged path
 * (`suppressedAmong`): a person who cannot read the list still never sends commercial mail to
 * someone on it. Recording one (`addSuppression`) needs only the right to write to people, because
 * an opt-out must be honoured by whoever receives it; it withdraws the waiting commercial drafts to
 * that address in the same transaction and announces `mail/suppression:added`. Removing one
 * (`removeSuppression`) lifts a person's refusal and needs `mail:suppressions:write`; row security
 * on `kernel.suppressions` enforces both. A contact's erasure leaves the list alone: the refusal
 * outlives the contact.
 */
import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withElevatableRlsFrom, withPrivilegedDb, withSystemReadReusingHeld } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  continueRoutinesAfterWithdrawal,
  withdrawCommercialDraftsOn,
} from "~/modules/approvals/withdraw-on-events"
import { isConsumerMailDomain } from "~/modules/apps/connections/api/consumer-domains"
import { asAdmin } from "~/modules/sharing/service"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** How an opt-out came in. `link` is the opt-out page only, never a caller's claim. */
export type SuppressionReason = "link" | "reply" | "person" | "import"

export interface SuppressionRecord {
  email: string
  reason: SuppressionReason
  /** A mail message id or a user id, never the address. */
  source: string | null
  createdBy: string | null
  createdAt: string
}

export interface LawfulBasisProblem {
  code: string
  label: string
  who: string
}

/** The fingerprint an address is kept as: sha256 of `<org id>:<trimmed lower address>`, hex. */
export function hashEmail(orgId: string, email: string): string {
  return createHash("sha256").update(`${orgId}:${email.trim().toLowerCase()}`).digest("hex")
}

function hashesOf(orgId: string, emails: readonly string[]): Map<string, string[]> {
  const byHash = new Map<string, string[]>()
  for (const email of emails) {
    if (typeof email !== "string" || email.trim() === "") continue
    const h = hashEmail(orgId, email)
    byHash.set(h, [...(byHash.get(h) ?? []), email])
  }
  return byHash
}

async function rowsFor(
  db: Pick<RlsClient, "execute"> | PrivilegedDb,
  orgId: string,
  hashes: readonly string[],
) {
  if (hashes.length === 0) return []
  return extractRows<{
    email_hash: string
    reason: SuppressionReason
    source: string | null
    created_by: string | null
    created_at: string | Date
  }>(
    await db.execute(drizzleSql`
      SELECT email_hash, reason, source, created_by::text AS created_by, created_at
        FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid
         AND email_hash = ANY(${`{${hashes.join(",")}}`}::text[])`),
  )
}

function toRecords(
  byHash: Map<string, string[]>,
  rows: Awaited<ReturnType<typeof rowsFor>>,
): SuppressionRecord[] {
  return rows.flatMap((r) =>
    (byHash.get(r.email_hash) ?? []).map((email) => ({
      email,
      reason: r.reason,
      source: r.source,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  )
}

/**
 * The addresses among `emails` that have opted out, as given. Read on the privileged path the
 * send check uses (on `db` when the caller already holds one of this org), so it answers whoever
 * is sending. A read that fails throws: the check then fails closed.
 */
export async function suppressedAmong(
  orgId: string,
  emails: string[],
  db?: PrivilegedDb,
): Promise<string[]> {
  const byHash = hashesOf(orgId, emails)
  if (byHash.size === 0) return []
  const read = (tx: PrivilegedDb) => rowsFor(tx, orgId, [...byHash.keys()])
  const rows = db ? await read(db) : await withPrivilegedDb(orgId, "suppressions-check", read)
  return toRecords(byHash, rows).map((r) => r.email)
}

/** Whether the address behind a fingerprint has opted out (privileged: the opt-out page has no person). */
export async function isSuppressedHash(orgId: string, emailHash: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "suppressions-check-hash", (tx) =>
    rowsFor(tx, orgId, [emailHash]),
  )
  return rows.length > 0
}

/**
 * The opt-outs of `emails`, with when and how. On `db` under the caller's row security (it then
 * needs `mail:suppressions:read`), or privileged when no client is given.
 */
export async function listSuppressions(
  orgId: string,
  emails: readonly string[],
  db?: Pick<RlsClient, "execute">,
): Promise<SuppressionRecord[]> {
  const byHash = hashesOf(orgId, emails)
  if (byHash.size === 0) return []
  const rows = db
    ? await rowsFor(db, orgId, [...byHash.keys()])
    : await withPrivilegedDb(orgId, "suppressions-list", (tx) =>
        rowsFor(tx, orgId, [...byHash.keys()]),
      )
  return toRecords(byHash, rows)
}

/** The opt-outs a person recorded, newest first: when and how, never an address (none is kept). */
export async function suppressionsAddedBy(
  db: Pick<RlsClient, "execute"> | PrivilegedDb,
  orgId: string,
  userId: string,
  limit: number,
): Promise<Array<{ reason: SuppressionReason; created_at: string | Date }>> {
  return extractRows(
    await db.execute(drizzleSql`
      SELECT reason, created_at FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid AND created_by = ${userId}::uuid
       ORDER BY created_at DESC
       LIMIT ${limit}`),
  )
}

export interface AddSuppressionResult {
  /** False when the address had already opted out: nothing new was written. */
  added: boolean
  record: SuppressionRecord
  /** The waiting commercial drafts to the address cancelled in the same transaction. */
  withdrawn: string[]
}

/**
 * Record that `email` opted out, on `db`: a person's own transaction (row security checks they
 * may write to people), a privileged one, or null for the system in its own transaction (a link
 * click, an inbound "stop").
 * An address already on the list keeps its first record. The waiting commercial drafts to it are
 * withdrawn in the same transaction, and `mail/suppression:added` is announced once.
 */
export async function addSuppression(
  db: RlsClient | PrivilegedDb | null,
  args: {
    orgId: string
    email: string
    reason: SuppressionReason
    source?: string | null
    createdBy?: string | null
    actorType?: "user" | "agent" | "system"
  },
): Promise<AddSuppressionResult> {
  const { email, ...rest } = args
  const emailHash = hashEmail(args.orgId, email)
  const out = await addSuppressionHash(db, { ...rest, emailHash })
  const [record] = out.before
    ? toRecords(new Map([[emailHash, [email]]]), [out.before])
    : [
        {
          email,
          reason: args.reason,
          source: args.source ?? null,
          createdBy: args.createdBy ?? null,
          createdAt: out.createdAt,
        },
      ]
  return { added: out.added, record: record as SuppressionRecord, withdrawn: out.withdrawn }
}

/** How many rows an INSERT wrote, from the driver's result. */
function insertedCount(result: unknown): number {
  const counted = result as { count?: unknown; rowCount?: unknown } | null
  const n = Number(counted?.count ?? counted?.rowCount ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * `addSuppression` for a caller that holds only the address's fingerprint (an opt-out link keeps
 * no address). Same rules: the first record stays, drafts are withdrawn, one event. With `db`
 * null the system records it, in a privileged transaction of its own (a link click has no
 * person and holds no transaction).
 */
export async function addSuppressionHash(
  db: RlsClient | PrivilegedDb | null,
  args: {
    orgId: string
    emailHash: string
    reason: SuppressionReason
    source?: string | null
    createdBy?: string | null
    actorType?: "user" | "agent" | "system"
  },
): Promise<{
  added: boolean
  before: Awaited<ReturnType<typeof rowsFor>>[number] | null
  createdAt: string
  withdrawn: string[]
}> {
  const { orgId, emailHash } = args
  const [before] = await withPrivilegedDb(orgId, "suppressions-add-read", (tx) =>
    rowsFor(tx, orgId, [emailHash]),
  )
  if (before) {
    return {
      added: false,
      before,
      createdAt: new Date(before.created_at).toISOString(),
      withdrawn: [],
    }
  }
  const actor = {
    actorId: args.createdBy ?? null,
    actorType: args.actorType ?? (args.createdBy ? "user" : "system"),
  } as const
  // One transaction: the row, its one event and the withdrawal of the drafts it stops commit or
  // roll back together. Only the request that inserted the row (a concurrent one finds it there
  // and inserts nothing) queues the event and withdraws.
  const record = async (
    tx: RlsClient | PrivilegedDb,
    elevated: (fn: () => Promise<string[]>) => Promise<string[]>,
  ): Promise<string[] | null> => {
    // Inserted on the caller's client, so its row security decides; no RETURNING, which would
    // also ask for the read right. The row count says whether this request inserted it.
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${K()}.suppressions (org_id, email_hash, reason, source, created_by)
      VALUES (${orgId}::uuid, ${emailHash}, ${args.reason}, ${args.source ?? null},
              ${args.createdBy ?? null})
      ON CONFLICT (org_id, email_hash) DO NOTHING`)
    if (insertedCount(result) === 0) return null
    await tx.queueEvent({
      app: "mail",
      entity: "suppression",
      action: "added",
      orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      entityId: emailHash,
      data: { emailHash },
    })
    return elevated(() => withdrawCommercialDraftsOn(tx, orgId, emailHash, actor))
  }
  const withdrawn = db
    ? await withElevatableRlsFrom(db, "suppressions-add", (tx) =>
        record(tx, (fn) => asAdmin(tx, fn)),
      )
    : await withPrivilegedDb(orgId, "suppressions-add-system", (tx) => record(tx, (fn) => fn()))
  if (withdrawn === null) {
    // Recorded meanwhile by another request: the first record stays.
    const [first] = await withPrivilegedDb(orgId, "suppressions-add-read", (tx) =>
      rowsFor(tx, orgId, [emailHash]),
    )
    return {
      added: false,
      before: first ?? null,
      createdAt: first ? new Date(first.created_at).toISOString() : new Date().toISOString(),
      withdrawn: [],
    }
  }
  await continueRoutinesAfterWithdrawal(orgId, withdrawn)
  return { added: true, before: null, createdAt: new Date().toISOString(), withdrawn }
}

/**
 * Lift `email`'s opt-out on the caller's client (row security asks for `mail:suppressions:write`).
 * Returns the record that was removed, or null when the address had not opted out or the caller
 * may not remove it.
 */
export async function removeSuppression(
  db: RlsClient,
  orgId: string,
  email: string,
): Promise<SuppressionRecord | null> {
  const emailHash = hashEmail(orgId, email)
  const removed = extractRows<{
    email_hash: string
    reason: SuppressionReason
    source: string | null
    created_by: string | null
    created_at: string | Date
  }>(
    await db.execute(drizzleSql`
      DELETE FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid AND email_hash = ${emailHash}
       RETURNING email_hash, reason, source, created_by::text AS created_by, created_at`),
  )
  const [record] = toRecords(new Map([[emailHash, [email]]]), removed)
  return record ?? null
}

/** How an opt-out came in, as a person reads it after "by". */
export function suppressionByLine(reason: SuppressionReason, who: string | null): string {
  if (reason === "link") return "the opt-out link in an earlier message"
  if (reason === "reply") return "a reply asking to stop"
  if (reason === "import") return "an imported list"
  return who ?? "a person in this organization"
}

// ─── The mail tools' answers (mail:suppression_check, _add, _remove) ─────────────────────────

/** At most this many addresses per check. */
export const SUPPRESSION_CHECK_MAX = 50

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

async function nameOf(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return null
  const [row] = await withPrivilegedDb(orgId, "suppressions-who", async (tx) =>
    extractRows<{ name: string | null; email: string | null }>(
      await tx.execute(drizzleSql`
        SELECT name, email FROM ${K()}.users WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )
  return row?.name || row?.email || null
}

/** "Opted out on 6 Nov 2026, by the opt-out link in an earlier message." */
export async function optedOutLine(orgId: string, record: SuppressionRecord): Promise<string> {
  const who = record.reason === "person" ? await nameOf(orgId, record.createdBy) : null
  return `Opted out on ${day(record.createdAt)}, by ${suppressionByLine(record.reason, who)}.`
}

/**
 * Which of `emails` opted out, and when and how, read under the caller's row security. The tool
 * requires `mail:suppressions:read`, so every caller may read the details.
 */
export async function checkSuppressions(args: {
  orgId: string
  emails: string[]
  given: number
  db: Pick<RlsClient, "execute">
}): Promise<unknown> {
  const { orgId, emails } = args
  if (args.given > SUPPRESSION_CHECK_MAX) {
    return {
      error: {
        code: "too_many_addresses",
        message: `Nothing was checked: ${args.given} addresses were given and a check takes at most ${SUPPRESSION_CHECK_MAX}. Next: check them in groups of ${SUPPRESSION_CHECK_MAX}.`,
      },
    }
  }
  if (emails.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "Nothing was checked: give emails, a list of addresses.",
      },
    }
  }
  const optedOut = await suppressedAmong(orgId, emails)
  const out = new Set(optedOut.map((e) => e.toLowerCase()))
  const details = optedOut.length > 0 ? await listSuppressions(orgId, optedOut, args.db) : []
  const results = []
  for (const email of emails) {
    const suppressed = out.has(email.toLowerCase())
    const record = details.find((d) => d.email.toLowerCase() === email.toLowerCase())
    results.push({
      email,
      optedOut: suppressed,
      ...(record
        ? { since: record.createdAt, by: record.reason, line: await optedOutLine(orgId, record) }
        : {}),
    })
  }
  const message =
    optedOut.length === 0
      ? `None of the ${emails.length} addresses opted out.`
      : `${optedOut.length} of ${emails.length} opted out: ${optedOut.join(", ")}. Send them no commercial mail; a service message (an invoice, an order) still goes.`
  return { checked: emails.length, results, message }
}

/** Record an opt-out a person or their agent received (`mail:suppression_add`). */
export async function addSuppressionTool(args: {
  orgId: string
  db: RlsClient
  userId: string | null
  actorType: "user" | "agent" | "system"
  params: Record<string, unknown>
}): Promise<unknown> {
  const { orgId, params } = args
  const email = typeof params.email === "string" ? params.email.trim() : ""
  if (!EMAIL_RE.test(email)) {
    return {
      error: {
        code: "invalid_params",
        message: "Nothing was recorded: email must be one address.",
      },
    }
  }
  const reason: SuppressionReason = params.reason === "reply" ? "reply" : "person"
  const source =
    typeof params.source === "string" && params.source.trim() !== "" ? params.source.trim() : null
  if (source?.includes("@")) {
    return {
      error: {
        code: "invalid_params",
        message:
          "Nothing was recorded: source is the id of the message they asked in, never an address.",
      },
    }
  }
  const done = await addSuppression(args.db, {
    orgId,
    email,
    reason,
    source: source ?? args.userId,
    createdBy: args.userId,
    actorType: args.actorType,
  })
  if (!done.added) {
    return {
      email,
      optedOut: true,
      alreadyOptedOut: true,
      withdrawn: 0,
      message: `${email} had already opted out (${(await optedOutLine(orgId, done.record)).replace(/\.$/, "")}). Nothing changed.`,
    }
  }
  const n = done.withdrawn.length
  return {
    email,
    optedOut: true,
    alreadyOptedOut: false,
    withdrawn: n,
    withdrawnRequestIds: done.withdrawn,
    message: `${email} is opted out of commercial mail. ${n === 0 ? "No draft to them was waiting." : `${n} waiting commercial draft${n === 1 ? " was" : "s were"} withdrawn.`} A service message (an invoice, an order) still goes.`,
  }
}

/** Lift an opt-out (`mail:suppression_remove`, approved by a mail admin). */
export async function removeSuppressionTool(args: {
  orgId: string
  db: RlsClient
  params: Record<string, unknown>
}): Promise<unknown> {
  const email = typeof args.params.email === "string" ? args.params.email.trim() : ""
  if (!EMAIL_RE.test(email)) {
    return {
      error: { code: "invalid_params", message: "Nothing was removed: email must be one address." },
    }
  }
  const removed = await removeSuppression(args.db, args.orgId, email)
  if (!removed) {
    return {
      error: {
        code: "not_found",
        message: `Nothing was removed: ${email} has not opted out, or you may not lift an opt-out (mail:suppressions:write).`,
      },
    }
  }
  return {
    email,
    optedOut: false,
    message: `${email} can receive commercial mail again. The opt-out removed: ${(await optedOutLine(args.orgId, removed)).replace(/\.$/, "")}. A new consent they gave belongs on their contact.`,
  }
}

/** The card of a request to lift an opt-out: who opted out, when and how. */
export async function suppressionRemoveCard(
  orgId: string,
  email: string,
): Promise<{ title: string; lines: string[] }> {
  const [record] = await listSuppressions(orgId, [email])
  return {
    title: `Let ${email} receive commercial mail again`,
    lines: record
      ? [
          await optedOutLine(orgId, record),
          "Approving removes the opt-out; commercial mail to them can go again.",
        ]
      : [`${email} has not opted out: approving changes nothing.`],
  }
}

/** The recorded grounds for writing commercial mail to someone (`kernel.contacts.lawful_basis`). */
export type LawfulBasis = "consent" | "customer" | "professional_interest" | "generic_address"

/** Where a contact's address came from (`kernel.contacts.data_source`); null is unknown. */
export type DataSource = "direct" | "third_party" | "enrichment"

/** The country policy when the org has set none: France allows professional interest, elsewhere consent. */
export const DEFAULT_COUNTRY_POLICY: Record<string, "optout" | "consent"> = {
  FR: "optout",
  default: "consent",
}

/** What the contacts at one address record, every contact at it taken together. */
export interface RecipientBasis {
  email: string
  contactIds: string[]
  /** The one recorded basis; null when none is recorded or two differ (`conflict`). */
  basis: LawfulBasis | null
  /** Two contacts at this address record different bases: a person chooses, nothing here does. */
  conflict: LawfulBasis[] | null
  /** True when any says consumer, else null when any is unknown, else false. */
  isConsumer: boolean | null
  /** Every recorded country, upper case; empty when none is recorded. */
  countries: string[]
  /** The first contact's recorded name, for a person to read; null when none is recorded. */
  name: string | null
}

/**
 * Who is a colleague, never a recipient of the commercial rules: an address of one of the org's
 * own people (portal accounts excluded), or any address at an active member's domain, unless that
 * domain is a shared mail provider (gmail.com and the like), where it says nothing of who the
 * address is. Anyone else on the org's user list (an import placeholder, a former member) counts
 * by their exact address only: an imported client address never makes the client's domain own.
 */
export interface Colleagues {
  addresses: ReadonlySet<string>
  domains: ReadonlySet<string>
}

export async function readColleagues(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
): Promise<Colleagues> {
  const rows = extractRows<{ email: string; active: boolean }>(
    await tx.execute(drizzleSql`
      SELECT lower(trim(email)) AS email, bool_or(status = 'active' AND user_type = 'member') AS active
        FROM ${K()}.users
       WHERE org_id = ${orgId}::uuid AND user_type <> 'external' AND email LIKE '%@%'
       GROUP BY 1`),
  )
  const addresses = new Set(rows.map((r) => r.email))
  const domains = new Set(
    rows
      .filter((r) => r.active)
      .map((r) => r.email.split("@")[1] ?? "")
      .filter((d) => d !== "" && !isConsumerMailDomain(d)),
  )
  return { addresses, domains }
}

export function isColleague(colleagues: Colleagues, address: string): boolean {
  const a = address.trim().toLowerCase()
  return colleagues.addresses.has(a) || colleagues.domains.has(a.split("@")[1] ?? "")
}

/**
 * What is recorded about each outside address among `addresses` (colleagues are
 * left out), read on the privileged path so a caller who cannot see a contact is
 * still bound by what it records. One reading only: a contact whose consumer status
 * is unset is a business (mail to professionals) only when its company's domain is a
 * business one (not a free mail provider) and the contact's own address is on it. Any
 * other unset status stays unknown, which counts as a consumer: a company link made
 * from a shared mail domain, or an address elsewhere, says nothing of who the person is.
 */
/**
 * A contact's consumer status as the send check reads it: the recorded one, else
 * business only for an address on its company's business domain (or a subdomain of
 * it), else unknown.
 */
export function consumerStatusOf(contact: {
  email: string
  is_consumer: boolean | null
  company_domain: string | null
}): boolean | null {
  if (contact.is_consumer !== null) return contact.is_consumer
  const domain = contact.company_domain?.trim().toLowerCase() ?? ""
  if (domain === "" || isConsumerMailDomain(domain)) return null
  const own = (contact.email.split("@")[1] ?? "").trim().toLowerCase()
  if (own === "" || isConsumerMailDomain(own)) return null
  return own === domain || own.endsWith(`.${domain}`) ? false : null
}

export async function lawfulBasisFacts(
  orgId: string,
  addresses: readonly string[],
  db?: PrivilegedDb,
): Promise<{ recipients: RecipientBasis[]; countryPolicy: Record<string, "optout" | "consent"> }> {
  const read = async (tx: PrivilegedDb) => {
    const colleagues = await readColleagues(tx, orgId)
    const outside = [
      ...new Set(
        addresses
          .filter((a) => typeof a === "string" && a.includes("@"))
          .map((a) => a.trim().toLowerCase())
          .filter((a) => !isColleague(colleagues, a)),
      ),
    ]
    const contacts =
      outside.length === 0
        ? []
        : extractRows<{
            id: string
            email: string
            name: string | null
            lawful_basis: LawfulBasis | null
            is_consumer: boolean | null
            company_domain: string | null
            recipient_country: string | null
          }>(
            await tx.execute(drizzleSql`
              SELECT c.id::text AS id, lower(c.email) AS email, c.name, c.lawful_basis,
                     c.is_consumer, lower(trim(co.domain)) AS company_domain,
                     -- The recorded country, else the country of the contact's first
                     -- current address that has one, in its address book's order.
                     COALESCE(NULLIF(trim(c.recipient_country), ''), (
                       SELECT trim(a.country_iso2) FROM ${K()}.contact_addresses a
                        WHERE a.org_id = c.org_id AND a.contact_id = c.id
                          AND a.archived_at IS NULL AND a.stale_at IS NULL
                          AND NULLIF(trim(a.country_iso2), '') IS NOT NULL
                        ORDER BY (a.verified_at IS NULL), a.role, a.created_at, a.id
                        LIMIT 1)) AS recipient_country
                FROM ${K()}.contacts c
                LEFT JOIN ${K()}.companies co ON co.id = c.company_id AND co.org_id = c.org_id
               WHERE c.org_id = ${orgId}::uuid
                 AND lower(c.email) = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(outside)}::jsonb)))
               ORDER BY c.id`),
          ).map((c) => ({ ...c, is_consumer: consumerStatusOf(c) }))
    const settings = extractRows<{ v: unknown }>(
      await tx.execute(drizzleSql`
        SELECT settings -> 'commercialIdentity' -> 'countryPolicy' AS v
          FROM ${K()}.organizations WHERE id = ${orgId}::uuid`),
    )[0]?.v
    return { outside, contacts, settings }
  }
  // A read only, so inside a privileged transaction (a claim) it reuses that one.
  const { outside, contacts, settings } = db
    ? await read(db)
    : await withSystemReadReusingHeld("lawful-basis-read", read)
  const recipients = outside.map((email): RecipientBasis => {
    const mine = contacts.filter((c) => c.email === email)
    const bases = [...new Set(mine.flatMap((c) => (c.lawful_basis ? [c.lawful_basis] : [])))].sort()
    const consumer = mine.some((c) => c.is_consumer === true)
      ? true
      : mine.length === 0 || mine.some((c) => c.is_consumer === null)
        ? null
        : false
    return {
      email,
      contactIds: mine.map((c) => c.id),
      basis: bases.length === 1 ? (bases[0] as LawfulBasis) : null,
      conflict: bases.length > 1 ? bases : null,
      isConsumer: consumer,
      countries: [
        ...new Set(
          mine.flatMap((c) =>
            c.recipient_country ? [c.recipient_country.trim().toUpperCase()] : [],
          ),
        ),
      ].sort(),
      name: mine.find((c) => c.name?.trim())?.name?.trim() ?? null,
    }
  })
  return { recipients, countryPolicy: countryPolicyOf(settings) }
}

function countryPolicyOf(value: unknown): Record<string, "optout" | "consent"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_COUNTRY_POLICY
  const out: Record<string, "optout" | "consent"> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === "optout" || v === "consent") out[k === "default" ? k : k.toUpperCase()] = v
  }
  return Object.keys(out).length > 0 ? out : DEFAULT_COUNTRY_POLICY
}

const BASIS_WORDS: Record<LawfulBasis, string> = {
  consent: "consent",
  customer: "existing customer",
  professional_interest: "professional interest",
  generic_address: "generic company address",
}

/**
 * Which countries the policy lets commercial mail go to without recorded
 * consent (on opt-out), and, when the recipient's country is unknown, whether
 * recording it could help.
 */
function optOutCountriesNote(
  policy: Record<string, "optout" | "consent">,
  countryUnknown: boolean,
): string {
  const optOut = Object.entries(policy)
    .filter(([k, v]) => k !== "default" && v === "optout")
    .map(([k]) => k)
    .sort()
  if (optOut.length === 0) {
    return countryUnknown
      ? "The organization's policy allows no commercial mail without recorded consent, so recording their country would not change this."
      : "The organization's policy allows no commercial mail without recorded consent."
  }
  const list =
    optOut.length === 1
      ? optOut[0]
      : `${optOut.slice(0, -1).join(", ")} and ${optOut[optOut.length - 1]}`
  const allowed = `Without recorded consent, the organization's policy allows commercial mail only to ${list}.`
  if (!countryUnknown) return allowed
  return `${allowed} Recording their country helps only if it is ${optOut.length === 1 ? list : `one of ${list}`}.`
}

/** The first rule one recipient breaks, or null. */
export function basisProblemFor(
  r: RecipientBasis,
  policy: Record<string, "optout" | "consent">,
): LawfulBasisProblem | null {
  const who = r.email
  if (r.conflict) {
    return {
      code: "basis_conflict",
      who,
      label: `Two contacts at ${who} record different lawful bases (${r.conflict.map((b) => BASIS_WORDS[b]).join(" and ")}), so no commercial mail goes to them until a person keeps one, by merging the contacts or correcting one.`,
    }
  }
  if (!r.basis) {
    return {
      code: "no_basis",
      who,
      label: `No lawful basis is recorded for ${who}, so no commercial mail goes to them until a person records one on their contact.`,
    }
  }
  // A generic company address is no person's own unless someone recorded a consumer there.
  const consumer = r.basis === "generic_address" && r.isConsumer !== true ? false : r.isConsumer
  if (consumer !== false && r.basis !== "consent") {
    return consumer === true
      ? {
          code: "consumer",
          who,
          label: `${who} is recorded as a consumer, and commercial mail to a consumer needs their recorded consent.`,
        }
      : {
          code: "consumer_unknown",
          who,
          label: `Whether ${who} is a consumer is not recorded and their address is not on the business domain of a company their contact is linked to, so they count as one: commercial mail needs their recorded consent, or a person records that they are a business.`,
        }
  }
  const countries = r.countries.length > 0 ? r.countries : ["default"]
  for (const country of countries) {
    const rule = policy[country] ?? policy.default ?? "consent"
    if (rule === "consent" && r.basis !== "consent") {
      const where =
        country === "default"
          ? "Their country is not recorded, and the rule for an unknown country"
          : `The rule for ${country}`
      return {
        code: "country_needs_consent",
        who,
        label: `${where} needs recorded consent for commercial mail, and ${who} is recorded under ${BASIS_WORDS[r.basis]}. ${optOutCountriesNote(policy, country === "default")}`,
      }
    }
  }
  return null
}

/**
 * Why the org may not write commercial mail to these people, or null when it may:
 * the first outside recipient with no recorded basis, two contacts that disagree,
 * a consumer (or someone not known to be a business) without consent, or a
 * country whose rule needs consent. `contactIds` is accepted for the guard's
 * call; the addresses decide, since they are who receives the mail.
 */
export async function lawfulBasisProblem(
  orgId: string,
  _contactIds: string[],
  addresses: string[],
  db?: PrivilegedDb,
): Promise<LawfulBasisProblem | null> {
  const { recipients, countryPolicy } = await lawfulBasisFacts(orgId, addresses, db)
  for (const r of recipients) {
    const problem = basisProblemFor(r, countryPolicy)
    if (problem) return problem
  }
  return null
}

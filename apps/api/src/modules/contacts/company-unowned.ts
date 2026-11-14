// SPDX-License-Identifier: FSL-1.1-ALv2
//
// COMPANIES WHOSE ACCOUNT MANAGER LEFT, AND HAND-OVERS.
//
// When someone who manages companies is deactivated, the admin who does it says who takes the
// companies over, or leaves them without a manager on purpose (`kernel:deactivateUser`'s
// `accountsTo`). The moves run in the deactivation's own transaction, under the same rules as
// giving a company to someone by hand: an active internal member who can already read it.
//
// Companies left without a manager raise ONE persisted Home row per person who left, for each
// holder of `kernel:users:admin` and `kernel:companies:write` ("6 companies have no account
// manager since Léa Fontaine left"), never one per company. It is a stored row, so Not now
// applies. It goes away once none of those companies is still without a manager, or when the
// person is reactivated (`refreshUnownedRows`). A company that never had a manager raises
// nothing: only the companies a departure left behind are listed on the row.
//
// A hand-over is seen: the previous manager gets one Home row naming who gave their companies
// to whom (`tellPreviousManagers`). Every move is announced as `kernel/company:update` with the
// old and the new manager, so the audit timeline has both; `handleCompanyOwnershipEvent` runs
// the follow-ups once that event is out.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { appsLogger as log } from "~/lib/logger"
import { COMPANY_RESOURCE, managerRefusal } from "~/modules/contacts/companies"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"
import { actorGrantRole } from "~/modules/sharing/service"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The unowned row: one per person left, per admin who can reassign. */
export const UNOWNED_KIND = "kernel:companies.unowned"
export const UNOWNED_ENTITY = "user"
/** The row a previous manager gets when their companies are given to someone else. */
export const HANDOVER_KIND = "kernel:companies.handed_over"
export const HANDOVER_ENTITY = "user"

/** Who sees the unowned row: they can both see who left and give a company to someone. */
export const UNOWNED_AUDIENCE_SCOPES = ["kernel:users:admin", "kernel:companies:write"] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidList(ids: readonly string[]) {
  return drizzleSql`${`{${ids.join(",")}}`}::uuid[]`
}

export interface CompanyRef {
  id: string
  name: string
}

/** The companies `userId` manages, by name. */
export async function companiesManagedBy(
  tx: PrivilegedDb,
  orgId: string,
  userId: string,
): Promise<CompanyRef[]> {
  return extractRows<CompanyRef>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, name FROM ${K}.companies
      WHERE org_id = ${orgId}::uuid AND owner_user_id = ${userId}::uuid
      ORDER BY lower(name), id`),
  )
}

async function nameOf(tx: PrivilegedDb, orgId: string, userId: string): Promise<string> {
  const [row] = extractRows<{ name: string | null; email: string }>(
    await tx.execute(drizzleSql`
      SELECT name, email FROM ${K}.users WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
  )
  return row?.name || row?.email || "Someone"
}

function namesLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ")
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
}

export interface HandOverResult {
  /** The new manager's name; null when none was named. */
  toName: string | null
  /** Given to the new manager. */
  moved: CompanyRef[]
  /** Left without a manager: on purpose (`accountsTo: null`) or because the new one could not take them. */
  unowned: CompanyRef[]
  /** Why each of `unowned` was not given to the new manager, when one was named. */
  skipped: Array<CompanyRef & { reason: string }>
}

/** Why `accountsTo` cannot take over someone's companies at all, or null. */
export async function handOverRefusal(
  orgId: string,
  fromUserId: string,
  accountsTo: string,
): Promise<{ code: string; message: string } | null> {
  if (!UUID_RE.test(accountsTo)) {
    return { code: "invalid_params", message: "accountsTo is a person's id, or null." }
  }
  if (accountsTo.toLowerCase() === fromUserId.toLowerCase()) {
    return {
      code: "invalid_params",
      message:
        "accountsTo names the person being deactivated. Name someone else, or null to leave their companies without an account manager.",
    }
  }
  const refused = await managerRefusal(orgId, accountsTo)
  return refused ? { code: refused.code, message: `${refused.reason} Nothing was changed.` } : null
}

/**
 * Move every company `fromUserId` manages to `accountsTo` (null: leave them without a manager),
 * in the caller's transaction. A company the new manager cannot read stays without one and is
 * named with why; nothing is shared as a side effect. Each move announces `company:update` with
 * the old and the new manager. Check `handOverRefusal` first.
 */
export async function handOverCompanies(
  tx: PrivilegedDb,
  args: { orgId: string; actorId: string; fromUserId: string; accountsTo: string | null },
): Promise<HandOverResult> {
  const { orgId, actorId, fromUserId, accountsTo } = args
  const managed = extractRows<
    CompanyRef & { org_access: string; created_by: string | null; acl_user_ids: string[] | null }
  >(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, name, org_access, created_by::text AS created_by, acl_user_ids
      FROM ${K}.companies
      WHERE org_id = ${orgId}::uuid AND owner_user_id = ${fromUserId}::uuid
      ORDER BY lower(name), id
      FOR UPDATE`),
  )
  const result: HandOverResult = { toName: null, moved: [], unowned: [], skipped: [] }
  if (managed.length === 0) return result

  const readable = new Set<string>()
  let newName = ""
  if (accountsTo !== null) {
    const roles = extractRows<{ role_id: string }>(
      await tx.execute(drizzleSql`
        SELECT role_id::text AS role_id FROM ${K}.user_roles
        WHERE org_id = ${orgId}::uuid AND user_id = ${accountsTo}::uuid`),
    ).map((r) => r.role_id)
    // The rule of giving a company by hand: org-visible, created by them, or shared with them.
    for (const c of managed) {
      if (
        c.org_access !== "none" ||
        c.created_by === accountsTo ||
        (await actorGrantRole(tx, COMPANY_RESOURCE, c.id, { userId: accountsTo, roles }))
      ) {
        readable.add(c.id)
      }
    }
    newName = await nameOf(tx, orgId, accountsTo)
    result.toName = newName
  }

  const toMove = managed.filter((c) => readable.has(c.id))
  const toClear = managed.filter((c) => !readable.has(c.id))
  if (toMove.length > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${K}.companies SET owner_user_id = ${accountsTo}::uuid, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidList(toMove.map((c) => c.id))})`)
  }
  if (toClear.length > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${K}.companies SET owner_user_id = NULL, updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidList(toClear.map((c) => c.id))})`)
  }
  for (const c of managed) {
    const ownerUserId = readable.has(c.id) ? accountsTo : null
    const ids = new Set<string>(c.acl_user_ids ?? [])
    if (c.created_by) ids.add(c.created_by)
    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "update",
      orgId,
      actorId,
      entityId: c.id,
      data: {
        id: c.id,
        name: c.name,
        ownerUserId,
        previousOwnerUserId: fromUserId,
        audience:
          c.org_access !== "none"
            ? { orgWide: true, userIds: [] }
            : { orgWide: false, userIds: [...ids] },
      },
    })
    const ref = { id: c.id, name: c.name }
    if (ownerUserId) result.moved.push(ref)
    else {
      result.unowned.push(ref)
      if (accountsTo !== null) {
        result.skipped.push({
          ...ref,
          reason: `${newName} cannot see ${c.name}, so it has no account manager now. Share the company with them, then give it to them.`,
        })
      }
    }
  }
  return result
}

interface UnownedRow {
  id: string
  user_id: string
  metadata: { companyIds?: unknown; leftUserId?: unknown } | null
}

async function unreadUnownedRows(
  tx: PrivilegedDb,
  orgId: string,
  leftUserId: string,
): Promise<UnownedRow[]> {
  return extractRows<UnownedRow>(
    await tx.execute(drizzleSql`
      SELECT id, user_id, metadata FROM ${K}.attention_events
      WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = ${UNOWNED_ENTITY}
        AND entity_id = ${leftUserId} AND kind = ${UNOWNED_KIND}
        AND read_at IS NULL AND email_only = false`),
  )
}

function idsOf(row: UnownedRow): string[] {
  const ids = row.metadata?.companyIds
  return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : []
}

function unownedSummary(count: number, leftName: string): string {
  return count === 1
    ? `1 company has no account manager since ${leftName} left`
    : `${count} companies have no account manager since ${leftName} left`
}

/**
 * Raise (or widen) the one unowned row for `leftUserId`, for every active holder of both
 * audience scopes but the person who left, listing `companyIds`. Rows already raised for them
 * keep the companies they listed. Returns how many people have the row.
 */
export async function raiseUnownedRows(
  tx: PrivilegedDb,
  args: { orgId: string; leftUserId: string; actorId: string; companyIds: string[] },
): Promise<number> {
  const { orgId, leftUserId, actorId } = args
  if (args.companyIds.length === 0) return 0
  const earlier = (await unreadUnownedRows(tx, orgId, leftUserId)).flatMap(idsOf)
  const companyIds = [...new Set([...earlier, ...args.companyIds])]
  const [admins, writers] = await Promise.all(
    UNOWNED_AUDIENCE_SCOPES.map((scope) => eligibleApprovers(tx, orgId, scope)),
  )
  const writerSet = new Set(writers)
  const audience = (admins ?? []).filter((id) => writerSet.has(id) && id !== leftUserId)
  if (audience.length === 0) return 0
  const leftName = await nameOf(tx, orgId, leftUserId)
  const count = await stillUnowned(tx, orgId, companyIds)
  if (count === 0) return 0
  const metadata = JSON.stringify({ leftUserId, leftName, companyIds, count })
  const summary = unownedSummary(count, leftName)
  for (const userId of audience) {
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
         actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'kernel', ${UNOWNED_ENTITY}, ${leftUserId},
              ${UNOWNED_KIND}, 40, ${summary}, ${actorId}::uuid, 'user', ${metadata}::jsonb,
              now(), false, 'not_eligible', now(), false)
      ON CONFLICT (user_id, app, entity_type, entity_id, kind)
        WHERE read_at IS NULL AND email_only = false
        DO UPDATE SET summary = EXCLUDED.summary, metadata = EXCLUDED.metadata`)
  }
  return audience.length
}

async function stillUnowned(tx: PrivilegedDb, orgId: string, companyIds: string[]) {
  const valid = companyIds.filter((i) => UUID_RE.test(i))
  if (valid.length === 0) return 0
  const [row] = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${K}.companies
      WHERE org_id = ${orgId}::uuid AND owner_user_id IS NULL AND id = ANY(${uuidList(valid)})`),
  )
  return row?.n ?? 0
}

/**
 * Bring the unowned rows of `leftUserId` up to date: gone when none of their companies is still
 * without a manager, or when the person is active again; otherwise the count and the line are
 * the current ones. Run after any change of a company's manager and on reactivation. Returns
 * the companies still without a manager (0 when the rows are gone).
 */
export async function refreshUnownedRows(
  tx: PrivilegedDb,
  orgId: string,
  leftUserId: string,
): Promise<number> {
  const rows = await unreadUnownedRows(tx, orgId, leftUserId)
  if (rows.length === 0) return 0
  const [person] = extractRows<{ status: string }>(
    await tx.execute(drizzleSql`
      SELECT status FROM ${K}.users WHERE id = ${leftUserId}::uuid AND org_id = ${orgId}::uuid`),
  )
  const companyIds = [...new Set(rows.flatMap(idsOf))]
  const count = person?.status === "active" ? 0 : await stillUnowned(tx, orgId, companyIds)
  const ids = rows.map((r) => r.id)
  if (count === 0) {
    await tx.execute(drizzleSql`
      UPDATE ${K}.attention_events SET read_at = now()
      WHERE id = ANY(${uuidList(ids)}) AND read_at IS NULL`)
    return 0
  }
  const leftName = await nameOf(tx, orgId, leftUserId)
  await tx.execute(drizzleSql`
    UPDATE ${K}.attention_events
    SET summary = ${unownedSummary(count, leftName)},
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('count', ${count}::int)
    WHERE id = ANY(${uuidList(ids)}) AND read_at IS NULL`)
  return count
}

/**
 * The people whose unowned rows list any of `companyIds`: after those companies get a manager,
 * each of them is refreshed.
 */
export async function refreshUnownedRowsFor(
  tx: PrivilegedDb,
  orgId: string,
  companyIds: string[],
): Promise<void> {
  const valid = companyIds.filter((i) => UUID_RE.test(i))
  if (valid.length === 0) return
  const left = extractRows<{ entity_id: string }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT entity_id FROM ${K}.attention_events
      WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = ${UNOWNED_ENTITY}
        AND kind = ${UNOWNED_KIND} AND read_at IS NULL AND email_only = false
        AND metadata->'companyIds' ?| ${`{${valid.join(",")}}`}::text[]`),
  )
  for (const l of left) await refreshUnownedRows(tx, orgId, l.entity_id)
}

/**
 * The hand-over is seen: each previous manager (not the one who made the change, and still an
 * active member) has ONE Home row naming who gave their companies to whom. A later hand-over
 * before they read it widens the same row, so a batch of 200 companies is one row, not 200.
 */
export async function tellPreviousManagers(
  tx: PrivilegedDb,
  args: {
    orgId: string
    actorId: string
    ownerUserId: string | null
    changes: Array<{ id: string; name: string; previousOwnerUserId: string | null }>
  },
): Promise<number> {
  const { orgId, actorId, ownerUserId } = args
  const byPrevious = new Map<string, CompanyRef[]>()
  for (const c of args.changes) {
    const prev = c.previousOwnerUserId
    if (!prev || prev === ownerUserId || prev === actorId) continue
    byPrevious.set(prev, [...(byPrevious.get(prev) ?? []), { id: c.id, name: c.name }])
  }
  if (byPrevious.size === 0) return 0
  const active = new Set(
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${K}.users
        WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_type = 'member'
          AND id = ANY(${uuidList([...byPrevious.keys()])})`),
    ).map((r) => r.id),
  )
  const actorName = await nameOf(tx, orgId, actorId)
  const toName = ownerUserId ? await nameOf(tx, orgId, ownerUserId) : null
  let told = 0
  for (const [previousId, refs] of byPrevious) {
    if (!active.has(previousId)) continue
    // Hand-overs of several companies publish one event each, handled side by side: one at a
    // time per previous manager, so each widens the row the one before it wrote.
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${`company-hand-over:${previousId}`}))`,
    )
    const [existing] = extractRows<{ metadata: { companies?: unknown } | null }>(
      await tx.execute(drizzleSql`
        SELECT metadata FROM ${K}.attention_events
        WHERE user_id = ${previousId}::uuid AND app = 'kernel' AND entity_type = ${HANDOVER_ENTITY}
          AND entity_id = ${previousId} AND kind = ${HANDOVER_KIND}
          AND read_at IS NULL AND email_only = false`),
    )
    const earlier = Array.isArray(existing?.metadata?.companies)
      ? (existing.metadata.companies as CompanyRef[]).filter(
          (c) => typeof c?.id === "string" && typeof c?.name === "string",
        )
      : []
    // By name, so the line reads the same whichever company's event was handled first.
    const all = [...new Map([...earlier, ...refs].map((c) => [c.id, c])).values()].sort((x, y) =>
      x.name.localeCompare(y.name),
    )
    const what = namesLine(all.map((r) => r.name))
    const summary = toName
      ? `${actorName} gave ${what} to ${toName}`
      : `${actorName} removed you as account manager of ${what}`
    const first = refs[0] as CompanyRef
    const metadata = JSON.stringify({
      companies: all,
      changedBy: { id: actorId, name: actorName },
      to: ownerUserId ? { id: ownerUserId, name: toName } : null,
      link: { tabType: "kernel:company", entityId: first.id },
    })
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
         actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${orgId}::uuid, ${previousId}::uuid, 'kernel', ${HANDOVER_ENTITY}, ${previousId},
              ${HANDOVER_KIND}, 30, ${summary}, ${actorId}::uuid, 'user', ${metadata}::jsonb,
              now(), false, 'not_eligible', now(), false)
      ON CONFLICT (user_id, app, entity_type, entity_id, kind)
        WHERE read_at IS NULL AND email_only = false
        DO UPDATE SET summary = EXCLUDED.summary, metadata = EXCLUDED.metadata,
                      occurred_at = EXCLUDED.occurred_at, actor_id = EXCLUDED.actor_id`)
    told++
  }
  return told
}

/**
 * After a company's manager changed (`kernel/company:update` carrying `previousOwnerUserId`):
 * the previous manager is told, and the unowned rows listing it are brought up to date. After a
 * reactivation (`kernel/user:reactivate`): that person's unowned rows go. Runs once, after the
 * change committed, privileged; a failure is logged and the change stands.
 */
export async function handleCompanyOwnershipEvent(event: AppEvent): Promise<void> {
  if (event.ephemeral || event.app !== "kernel" || !event.orgId || !event.entityId) return
  const orgId = event.orgId
  const entityId = event.entityId
  try {
    if (event.entity === "user" && event.action === "reactivate") {
      await withPrivilegedDb(orgId, "company-unowned-reactivate", (tx) =>
        refreshUnownedRows(tx, orgId, entityId),
      )
      return
    }
    if (event.entity !== "company" || event.action !== "update") return
    const data = (event.data ?? {}) as {
      name?: unknown
      ownerUserId?: unknown
      previousOwnerUserId?: unknown
    }
    if (!("previousOwnerUserId" in data)) return
    const ownerUserId = typeof data.ownerUserId === "string" ? data.ownerUserId : null
    const previousOwnerUserId =
      typeof data.previousOwnerUserId === "string" ? data.previousOwnerUserId : null
    if (ownerUserId === previousOwnerUserId) return
    await withPrivilegedDb(orgId, "company-hand-over", async (tx) => {
      if (event.actorId) {
        await tellPreviousManagers(tx, {
          orgId,
          actorId: event.actorId,
          ownerUserId,
          changes: [
            {
              id: entityId,
              name: typeof data.name === "string" ? data.name : entityId,
              previousOwnerUserId,
            },
          ],
        })
      }
      if (ownerUserId) await refreshUnownedRowsFor(tx, orgId, [entityId])
    })
  } catch (err) {
    log.error(
      { err, orgId, entity: event.entity, action: event.action, entityId },
      "account manager follow-up failed (previous manager line, unowned row); the change stands",
    )
  }
}

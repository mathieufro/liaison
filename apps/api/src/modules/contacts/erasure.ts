// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contacts a person owns, when that person is erased.
//
// kernel.contacts.owner_user_id is ON DELETE RESTRICT (migration 0117): a
// private contact is visible to its owner alone, so neither silently losing
// it (CASCADE) nor orphaning it (SET NULL, which a restricted contact cannot
// be) is right. Erasure decides explicitly:
//   - a private contact nothing in the organisation uses is the person's own
//     data: deleted (the links from their own mailbox's conversations cleared;
//     their own files on it and references from threads only they are in do
//     not count as a use);
//   - a private contact the organisation uses (a ticket, an invoice, a file,
//     another mailbox's conversation...) is handed to an org admin, the first
//     active user holding the admin role or kernel:users:admin, who can then
//     share it or merge it; the hand-over is a `contact:share` event, audited;
//   - an organisation contact the person owned simply loses its owner (it
//     stays everyone's; contact admins manage an ownerless contact).
// With no admin to hand to, a used private contact goes to the org's erased-
// user sentinel: kept, so nothing that references it breaks.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { deleteContactDiscussions } from "~/modules/contacts/discussion"
import {
  ORG_USE_REFERENCES,
  predicateSql,
  presentReferences,
  rel,
} from "~/modules/contacts/references"
import { recomputeSearchAcl } from "~/modules/sharing/service"

/** The payments connector's app name: its mirror's schema, tables and id columns carry it. */
const PAYMENTS_APP = "stripe"

export interface ErasedContactsResult {
  deleted: number
  handedOver: number
  handedTo: string | null
  unowned: number
}

/** The first active org admin other than `exceptUserId`, or null. */
export async function firstOrgAdmin(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  exceptUserId: string,
): Promise<string | null> {
  const [row] = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT u.id::text AS id
        FROM ${drizzleSql.raw(rel("kernel", "users"))} u
        JOIN ${drizzleSql.raw(rel("kernel", "user_roles"))} ur ON ur.user_id = u.id
        JOIN ${drizzleSql.raw(rel("kernel", "roles"))} r ON r.id = ur.role_id
       WHERE u.org_id = ${orgId}::uuid AND u.status = 'active' AND u.id <> ${exceptUserId}::uuid
         AND (r.name = 'admin' OR EXISTS (
               SELECT 1 FROM ${drizzleSql.raw(rel("kernel", "role_scope_grants"))} g
                WHERE g.role_id = r.id AND g.scope IN ('*', 'kernel', 'kernel:*', 'kernel:users:admin')))
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT 1`),
  )
  return row?.id ?? null
}

/**
 * A deleted or erased contact stops being a company's main contact, a deal's
 * contact, a billing customer's person (mirrored from the payment connector,
 * which keeps its own record) and the person of a recurring invoice schedule that
 * has ended, in the transaction that removes it. A schedule not ended keeps its
 * person: the delete refuses while one bills them. Privileged:
 * the remover may not see every company, deal or customer naming the person.
 * An app half is skipped where that app has no tables.
 */
export async function clearContactSoftReferences(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  contactIds: string[],
): Promise<{ companies: number; deals: number; billingCustomers: number; endedSchedules: number }> {
  if (contactIds.length === 0)
    return { companies: 0, deals: 0, billingCustomers: 0, endedSchedules: 0 }
  const ids = `{${contactIds.join(",")}}`
  const companies = extractRows(
    await tx.execute(drizzleSql`
      UPDATE ${drizzleSql.raw(rel("kernel", "companies"))} SET main_contact_id = NULL, updated_at = now()
       WHERE org_id = ${orgId}::uuid AND main_contact_id = ANY(${ids}::uuid[])
      RETURNING id`),
  ).length
  const dealsTable = rel("app_projects", "deals")
  const [present] = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${dealsTable})::text AS t`),
  )
  const deals = present?.t
    ? extractRows(
        await tx.execute(drizzleSql`
          UPDATE ${drizzleSql.raw(dealsTable)} SET contact_id = NULL, updated_at = now()
           WHERE org_id = ${orgId}::uuid AND contact_id = ANY(${ids}::uuid[])
          RETURNING task_id`),
      ).length
    : 0
  // The payments connector's mirror: its schema, table and id column are named after the app.
  const customersTable = rel(`app_${PAYMENTS_APP}`, `${PAYMENTS_APP}_customers`)
  const [mirror] = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${customersTable})::text AS t`),
  )
  const billingCustomers = mirror?.t
    ? extractRows(
        await tx.execute(drizzleSql`
          UPDATE ${drizzleSql.raw(customersTable)} SET contact_id = NULL, updated_at = now()
           WHERE org_id = ${orgId}::uuid AND contact_id = ANY(${ids}::uuid[])
          RETURNING ${drizzleSql.raw(`${PAYMENTS_APP}_id`)}`),
      ).length
    : 0
  const schedulesTable = rel("app_invoicing", "recurring_schedules")
  const [schedules] = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${schedulesTable})::text AS t`),
  )
  const endedSchedules = schedules?.t
    ? extractRows(
        await tx.execute(drizzleSql`
          UPDATE ${drizzleSql.raw(schedulesTable)} SET contact_id = NULL, updated_at = now()
           WHERE org_id = ${orgId}::uuid AND contact_id = ANY(${ids}::uuid[]) AND status = 'ended'
          RETURNING id`),
      ).length
    : 0
  return { companies, deals, billingCustomers, endedSchedules }
}

export async function releaseErasedUserContacts(
  tx: PrivilegedDb,
  params: { orgId: string; userId: string; sentinelUserId: string },
): Promise<ErasedContactsResult> {
  const { orgId } = params
  // The search ACL recompute is pinned to the transaction's org; a system
  // transaction has none, so pin it here and put it back after.
  const [prev] = extractRows<{ v: string | null }>(
    await tx.execute(drizzleSql`SELECT current_setting('app.current_org_id', true) AS v`),
  )
  await tx.execute(drizzleSql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
  const result = await release(tx, params)
  // (On an error the transaction is aborted and rolled back anyway.)
  await tx.execute(drizzleSql`SELECT set_config('app.current_org_id', ${prev?.v ?? ""}, true)`)
  return result
}

async function release(
  tx: PrivilegedDb,
  params: { orgId: string; userId: string; sentinelUserId: string },
): Promise<ErasedContactsResult> {
  const { orgId, userId } = params
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // Inlined into the reference predicates below: ids only.
  if (!UUID.test(orgId) || !UUID.test(userId)) throw new Error("erase contacts: not a uuid")
  const contacts = drizzleSql.raw(rel("kernel", "contacts"))
  const conversations = rel("app_mail", "conversations")
  const accounts = rel("app_mail", "accounts")
  const refs = await presentReferences(tx, ORG_USE_REFERENCES)
  const [mail] = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${conversations})::text AS t`),
  )
  // Used by the organisation: any org reference, or a conversation in a
  // mailbox that is not the erased person's own. The person's own traces do
  // not count: a file they attached themselves, a reference from a thread
  // nobody else takes part in.
  const own: Record<string, string> = {
    files: `r.uploaded_by IS DISTINCT FROM '${userId}'::uuid`,
    thread_references: `EXISTS (
        SELECT 1 FROM ${rel("kernel", "thread_participants")} p
         WHERE p.thread_id = r.thread_id AND p.user_id IS NOT NULL
           AND p.user_id <> '${userId}'::uuid)`,
  }
  const usedParts = refs.map((ref) => {
    const extra = ref.schema === "kernel" ? own[ref.table] : undefined
    return `EXISTS (SELECT 1 FROM ${rel(ref.schema, ref.table)} r WHERE ${predicateSql(ref)}${extra ? ` AND ${extra}` : ""})`
  })
  if (mail?.t) {
    usedParts.push(`EXISTS (
      SELECT 1 FROM ${conversations} v JOIN ${accounts} a ON a.id = v.account_id
       WHERE v.contact_id = c.id
         AND NOT (a.owner_type = 'user' AND a.owner_id = '${userId}'::uuid))`)
  }
  const used = usedParts.length > 0 ? usedParts.join(" OR ") : "false"
  const owned = extractRows<{ id: string; used: boolean }>(
    await tx.execute(
      drizzleSql.raw(`
      SELECT c.id::text AS id, (${used}) AS used
        FROM ${rel("kernel", "contacts")} c
       WHERE c.org_id = '${orgId}'::uuid AND c.owner_user_id = '${userId}'::uuid
         AND c.org_access = 'none'
       FOR UPDATE`),
    ),
  )
  const unused = owned.filter((c) => !c.used).map((c) => c.id)
  const kept = owned.filter((c) => c.used).map((c) => c.id)

  if (unused.length > 0) {
    const ids = drizzleSql.join(
      unused.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    if (mail?.t) {
      await tx.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(conversations)} SET contact_id = NULL
         WHERE org_id = ${orgId}::uuid AND contact_id IN (${ids})`)
    }
    await deleteContactDiscussions({ orgId, contactIds: unused }, tx)
    await clearContactSoftReferences(tx, orgId, unused)
    await tx.execute(
      drizzleSql`DELETE FROM ${contacts} WHERE org_id = ${orgId}::uuid AND id IN (${ids})`,
    )
    for (const id of unused) {
      await tx.queueEvent({
        app: "kernel",
        entity: "contact",
        action: "delete",
        entityId: id,
        orgId,
        actorId: null,
        actorType: "system",
        data: { id, reason: "erase-user" },
      })
    }
  }

  let handedTo: string | null = null
  if (kept.length > 0) {
    handedTo = (await firstOrgAdmin(tx, orgId, userId)) ?? params.sentinelUserId
    for (const id of kept) {
      await tx.execute(drizzleSql`
        UPDATE ${contacts} SET owner_user_id = ${handedTo}::uuid, updated_at = now()
         WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid`)
      await recomputeSearchAcl(tx, "kernel.contact", id)
      await tx.queueEvent({
        app: "kernel",
        entity: "contact",
        action: "share",
        entityId: id,
        orgId,
        actorId: null,
        actorType: "system",
        data: {
          id,
          orgAccess: "none",
          previousOwnerUserId: userId,
          ownerUserId: handedTo,
          reason: "erase-user: a contact the organisation uses goes to an admin",
        },
      })
    }
  }

  const unowned = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${contacts} SET owner_user_id = NULL
       WHERE org_id = ${orgId}::uuid AND owner_user_id = ${userId}::uuid AND org_access <> 'none'
      RETURNING id::text AS id`),
  )
  for (const { id } of unowned) await recomputeSearchAcl(tx, "kernel.contact", id)

  return { deleted: unused.length, handedOver: kept.length, handedTo, unowned: unowned.length }
}

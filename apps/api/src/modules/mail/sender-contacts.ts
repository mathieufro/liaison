// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which contact an inbound mail sender becomes, decided on the HOST, in the
// generic sharing model (modules/sharing, migration 0117).
//
// Automated discovery never adds anyone to the organisation's contacts: that
// is always an explicit share. What a sync may do depends on whose mailbox it
// is, read from the account row, never taken from the sandbox:
//
//   - a personal mailbox: the sender becomes (or links to) a contact that
//     belongs to the mailbox's owner alone (org_access 'none', owner = them);
//   - a shared mailbox: the sender becomes (or links to) that mailbox's own
//     ownerless contact (audience_key = "mail:inbox=<account id>"), shared
//     through a DIMENSION grant with exactly the people who can access that
//     mailbox, following its access as it changes. Another mailbox's contact
//     for the same address is never reused: audiences stay apart;
//   - either way, a sender who already has an org-visible contact is linked to
//     it (never duplicated privately), and a bulk or machine sender
//     (newsletter, notifier, no-reply) is only ever linked, never created;
//   - a contact created here joins the company that holds its address's
//     domain, when exactly one company of the org does, so a colleague at a
//     client who writes for the first time is that client's from the start.
//
// The writes run privileged, with every filter explicit: the sync acts as a
// system actor, who is neither the mailbox's owner nor one of its members,
// and it creates contacts ON THEIR BEHALF. The mail bundle cannot reach this:
// its generic `resolveContact` is refused, and `mail_writePage` calls this
// with the account it is writing into.
//
// Cost: one lookup for the whole page's senders; one create per new sender.

import { and, asc, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { contacts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { nextHandle } from "~/lib/handle"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { quoteIdent } from "~/lib/sql-utils"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { isConsumerMailDomain } from "~/modules/apps/connections/api/consumer-domains"
import { resolveContact } from "~/modules/contacts/service"
import { recomputeSearchAcl } from "~/modules/sharing/service"

export interface SenderInput {
  email: string
  name?: string | null
  /** From List-Unsubscribe / List-Id / Precedence / Auto-Submitted / Gmail category. */
  bulk?: boolean
}

/** Senders per call: a sync page has at most a few dozen distinct senders. */
export const SENDER_CONTACTS_MAX = 200

/**
 * Local parts that are machines, never people, whatever the headers say. Kept
 * narrow on purpose: `info@`, `support@` or `billing@` of a customer's company
 * write to a shared inbox as that company and belong in its CRM.
 */
const MACHINE_LOCAL_PART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify)([-_.+\d]|$)/i

export function isMachineAddress(email: string): boolean {
  return MACHINE_LOCAL_PART.test(email.split("@")[0] ?? "")
}

/**
 * Resolve a page of inbound senders to contact ids under the mailbox's policy.
 * Returns lowercased email -> contact id for the senders that have (or now
 * have) a contact the mailbox's readers may see. Senders absent from the map
 * stay plain addresses. With `create: false` only existing contacts are found
 * (the recipients of mail the mailbox sent: sending creates no contact).
 */
export async function resolveSenderContacts(
  orgId: string,
  actorId: string,
  account: { id: string; ownerType: string; ownerId: string | null },
  senders: SenderInput[],
  opts: { create?: boolean } = {},
): Promise<Record<string, string>> {
  const create = opts.create !== false
  if (senders.length > SENDER_CONTACTS_MAX) {
    throw new Error(`resolveSenderContacts: at most ${SENDER_CONTACTS_MAX} senders per call`)
  }
  const byEmail = new Map<string, SenderInput>()
  for (const sender of senders) {
    const email = typeof sender?.email === "string" ? sender.email.trim().toLowerCase() : ""
    if (!email.includes("@")) continue
    const seen = byEmail.get(email)
    // A sender flagged bulk once in the page is bulk for the page.
    byEmail.set(email, { ...sender, email, bulk: Boolean(seen?.bulk || sender.bulk) })
  }
  if (byEmail.size === 0) return {}
  const personal = account.ownerType === "user"
  if (personal && !account.ownerId) return {}
  const inbox = `mail:inbox=${account.id}`

  return withPrivilegedDb(orgId, "mail-sender-contacts", async (tx) => {
    const emails = [...byEmail.keys()]
    const lowered = drizzleSql<string>`LOWER(${contacts.email})`
    // What this mailbox's readers may use: org-visible contacts first, then the
    // owner's own private one (personal) or THIS mailbox's own (shared). Never
    // another mailbox's or person's: audiences stay apart, and linking across
    // them is an explicit share or merge.
    const usable = personal
      ? drizzleSql`(${contacts.orgAccess} <> 'none' OR (${contacts.ownerUserId} = ${account.ownerId}::uuid AND ${contacts.audienceKey} IS NULL))`
      : drizzleSql`(${contacts.orgAccess} <> 'none' OR (${contacts.audienceKey} = ${inbox} AND ${contacts.ownerUserId} IS NULL))`
    const found = await tx
      .select({ id: contacts.id, email: lowered, orgAccess: contacts.orgAccess })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), inArray(lowered, emails), usable))
      .orderBy(
        drizzleSql`CASE WHEN ${contacts.orgAccess} <> 'none' THEN 0 ELSE 1 END`,
        asc(contacts.createdAt),
      )
    const out: Record<string, string> = {}
    for (const row of found) {
      if (out[row.email]) continue
      out[row.email] = row.id
    }

    const created: Array<{ id: string; email: string }> = []
    if (!create) return out
    for (const [email, sender] of byEmail) {
      if (out[email] || sender.bulk || isMachineAddress(email)) continue
      // An email flood must not grow the contact list without bound: each
      // mailbox may auto-create only so many new contacts per day. Over the cap
      // the sender simply stays unlinked (the message is stored regardless).
      if (!(await mayAutoCreateContact(account.id))) break
      const name =
        typeof sender.name === "string" && sender.name.trim() ? sender.name.trim() : undefined
      if (personal) {
        const { contact, isNew } = await resolveContact(
          tx as never,
          orgId,
          actorId,
          { email, name },
          { audience: "owner", ownerUserId: account.ownerId as string },
        )
        if (contact) {
          out[email] = contact.id
          if (isNew) created.push({ id: contact.id, email })
        }
        continue
      }
      const id = await createMailboxContact(tx, orgId, actorId, inbox, email, name)
      out[email] = id
      created.push({ id, email })
    }
    await linkToCompanyByDomain(tx, orgId, created)
    return out
  })
}

/**
 * New contacts join the company that holds their address's domain, when exactly one company of
 * the org does: two companies on one domain (a group's subsidiaries) leave the choice to a person,
 * and a consumer mail domain never names a company. A contact already at a company keeps it.
 */
async function linkToCompanyByDomain(
  tx: PrivilegedDb,
  orgId: string,
  created: ReadonlyArray<{ id: string; email: string }>,
): Promise<void> {
  const linkable = created.filter((c) => !isConsumerMailDomain(c.email.split("@")[1] ?? ""))
  if (linkable.length === 0) return
  const K = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
  const ids = JSON.stringify([...new Set(linkable.map((c) => c.id))])
  await tx.execute(drizzleSql`
    UPDATE ${K}.contacts c SET company_id = x.company_id, updated_at = now()
      FROM (SELECT lower(co.domain) AS domain, (array_agg(co.id))[1] AS company_id
              FROM ${K}.companies co
             WHERE co.org_id = ${orgId}::uuid AND co.domain IS NOT NULL
             GROUP BY lower(co.domain)
            HAVING count(*) = 1) x
     WHERE c.org_id = ${orgId}::uuid AND c.company_id IS NULL
       AND c.id = ANY(ARRAY(SELECT jsonb_array_elements_text(${ids}::jsonb)::uuid))
       AND lower(split_part(c.email, '@', 2)) = x.domain`)
}

/** New contacts one mailbox may auto-create per day. */
export const AUTO_CONTACTS_PER_MAILBOX_PER_DAY = 200

async function mayAutoCreateContact(accountId: string): Promise<boolean> {
  try {
    const rl = await checkRateLimit(redis, [
      {
        identifier: `mail:auto-contacts:${accountId}:day`,
        limit: AUTO_CONTACTS_PER_MAILBOX_PER_DAY,
        windowSeconds: 86_400,
      },
    ])
    if (!rl.allowed) {
      rootLogger.warn({ accountId }, "mail sender auto-contact cap reached for this mailbox")
    }
    return rl.allowed
  } catch (err) {
    // The cap is protective, not load-bearing: never fail a sync page over it.
    rootLogger.warn({ err, accountId }, "mail auto-contact cap check failed; allowing")
    return true
  }
}

/**
 * A shared mailbox's own contact for an address (ownerless, org_access
 * 'none', audience_key = the mailbox), granted as editor to whoever can
 * access the mailbox. Idempotent per (mailbox, address).
 */
async function createMailboxContact(
  tx: PrivilegedDb,
  orgId: string,
  actorId: string,
  inbox: string,
  email: string,
  name: string | undefined,
): Promise<string> {
  const handle = await nextHandle(
    tx as never,
    `${schemaRef("kernel")}.contact_handle_seq`,
    "@contact",
  )
  const [row] = await tx
    .insert(contacts)
    .values({
      orgId,
      handle,
      email,
      name: name ?? null,
      orgAccess: "none",
      ownerUserId: null,
      audienceKey: inbox,
    })
    .onConflictDoUpdate({
      target: [contacts.orgId, contacts.audienceKey, contacts.email],
      targetWhere: drizzleSql`org_access = 'none' AND audience_key IS NOT NULL`,
      set: { updatedAt: new Date() },
    })
    .returning({ id: contacts.id })
  await tx.execute(drizzleSql`
    INSERT INTO ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.resource_grants
      (org_id, resource_type, resource_id, grantee_kind, grantee, role)
    VALUES (${orgId}::uuid, 'kernel.contact', ${row.id}::uuid, 'dimension', ${inbox}, 'editor')
    ON CONFLICT (resource_type, resource_id, grantee_kind, grantee) DO NOTHING`)
  await recomputeSearchAcl(tx, "kernel.contact", row.id)
  // Created with its grant already in place, so the index sees its final ACL.
  await tx.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "create",
    orgId,
    actorId,
    entityId: row.id,
    data: { email, name: name ?? null, handle },
  })
  return row.id
}

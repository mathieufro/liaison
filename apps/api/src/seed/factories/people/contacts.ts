// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contacts factory: the people and companies an org trades with, written
// through `resolveContact`, the kernel service the contacts route, the
// contacts tool and every inbound mail ingest use. The one contact writer
// every tier uses.
//
// No privileged write: every contact is resolved inside one RLS transaction
// as the actor, with only the scopes their role carries, and validated as the
// resolve route validates it. It dedupes on email first, so a re-run (or a
// second layer naming the same person) updates the row already there instead
// of adding a twin, and queues the same contact events the product queues.
import { resolveContactSchema } from "@liaison/shared"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { contacts } from "~/db/schema/kernel/contacts"
import { resolveContact } from "~/modules/contacts/service"
import type { SeedContext } from "~/seed/context"
import { asUser } from "./actors"

export interface ResolvedContactInput {
  /** The key the caller finds the contact under. */
  key: string
  email: string
  name: string
  company?: string
  externalId?: Record<string, string>
  tags?: string[]
  metadata?: Record<string, unknown>
  /**
   * The country the world places them in (ISO 3166 alpha-2), recorded as the
   * country the send check reads. Never replaces one already recorded.
   */
  recipientCountry?: string
}

export interface ResolvedContact {
  id: string
  name: string | null
  email: string | null
}

/**
 * Who the contacts are for: the organisation (`org`, everyone reads and
 * edits), or the actor alone (`owner`, the resolve route's default).
 */
export type ResolvedContactAudience = "org" | "owner"

/**
 * Resolve every contact, in order, in one RLS transaction as `actor`.
 * Returns each contact by key, in input order.
 */
export async function resolveContacts(
  ctx: SeedContext,
  actor: UserContext,
  inputs: readonly ResolvedContactInput[],
  audience: ResolvedContactAudience = "org",
): Promise<Array<[string, ResolvedContact]>> {
  const target =
    audience === "org"
      ? ({ audience: "org" } as const)
      : ({ audience: "owner", ownerUserId: actor.userId } as const)
  const out: Array<[string, ResolvedContact]> = []
  await asUser(actor, async (tx) => {
    // Countries are recorded in one statement for the whole batch, after every
    // contact exists: the first country named for a contact wins, and one
    // already recorded is never replaced.
    const countries: Array<{ id: string; country: string }> = []
    for (const input of inputs) {
      const fields = {
        email: input.email,
        name: input.name,
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }
      // The route's own check (an email that is one, an identifier at all);
      // tags are the contacts tool's, which the route schema does not carry.
      resolveContactSchema.parse(fields)
      const params = { ...fields, ...(input.tags !== undefined ? { tags: input.tags } : {}) }
      const { contact } = await resolveContact(tx as never, ctx.orgId, actor.userId, params, target)
      if (!contact) throw new Error(`contacts seed: contact ${input.key} was not created`)
      if (input.recipientCountry) {
        countries.push({ id: contact.id, country: input.recipientCountry.toUpperCase() })
      }
      out.push([input.key, { id: contact.id, name: contact.name, email: contact.email }])
    }
    if (countries.length > 0) {
      const byId = new Map<string, string>()
      for (const { id, country } of countries) if (!byId.has(id)) byId.set(id, country)
      const cases = [...byId].map(([id, country]) => sql`WHEN ${id}::uuid THEN ${country}`)
      await tx
        .update(contacts)
        .set({ recipientCountry: sql`CASE ${contacts.id} ${sql.join(cases, sql` `)} END` })
        .where(
          and(
            eq(contacts.orgId, ctx.orgId),
            inArray(contacts.id, [...byId.keys()]),
            isNull(contacts.recipientCountry),
          ),
        )
    }
  })
  return out
}

/** The id of the contact with this email (case-insensitive), or null. */
export async function contactIdByEmail(ctx: SeedContext, email: string): Promise<string | null> {
  const [row] = await withSystemDb("seed-contact-by-email", (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.orgId, ctx.orgId), sql`lower(${contacts.email}) = ${email.toLowerCase()}`),
      )
      .limit(1),
  )
  return row?.id ?? null
}

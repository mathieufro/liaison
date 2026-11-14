// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Commercial mail goes only to someone whose contact records a lawful basis
// (modules/mail/suppressions.ts, `lawfulBasisProblem`). A test that sends one
// to an address records it here: a contact at that address (made when none
// exists) with the basis, a business, the country and the source, every field
// overridable. Nothing is recorded that the test did not ask for.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as minimal from "~/seed/tiers/minimal"

export interface ProspectFields {
  lawfulBasis?: "consent" | "customer" | "professional_interest" | "generic_address" | null
  isConsumer?: boolean | null
  recipientCountry?: string | null
  dataSource?: "direct" | "third_party" | "enrichment" | null
}

/** Records `fields` on every contact at `email` (one is made first when none exists); returns the first id. */
export async function recordProspect(
  orgId: string,
  email: string,
  fields: ProspectFields = {},
): Promise<string> {
  const id = await minimal.contact(orgId, email)
  const f = {
    lawfulBasis: "professional_interest",
    isConsumer: false,
    recipientCountry: "FR",
    dataSource: "direct",
    ...fields,
  }
  await withSystemDb("test-record-prospect", (tx) =>
    tx.execute(drizzleSql`UPDATE ${drizzleSql.raw(schemaRef("kernel"))}.contacts
      SET lawful_basis = ${f.lawfulBasis}, lawful_basis_at = now(), is_consumer = ${f.isConsumer},
          recipient_country = ${f.recipientCountry}, data_source = ${f.dataSource}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${email.trim().toLowerCase()}`),
  )
  return id
}

/**
 * For a test about something else that sends commercial mail: every outside
 * address among `addresses` with no recorded basis gets one (consent by
 * default, which is not by itself a reason to call a mail commercial).
 * Addresses at the org's own domains are left alone.
 */
export async function ensureRecordedBasis(
  orgId: string,
  addresses: readonly unknown[],
  fields: ProspectFields = { lawfulBasis: "consent" },
): Promise<void> {
  const emails = addresses
    .map((a) => (typeof a === "string" ? a : (a as { email?: unknown } | null)?.email))
    .filter((a): a is string => typeof a === "string" && a.includes("@"))
    .map((a) => a.trim().toLowerCase())
  if (emails.length === 0) return
  const K = drizzleSql.raw(schemaRef("kernel"))
  const missing = await withSystemDb("test-ensure-basis", async (tx) => {
    const rows = extractRows<{ email: string }>(
      await tx.execute(drizzleSql`
      SELECT e AS email FROM unnest(${`{${emails.join(",")}}`}::text[]) e
       WHERE NOT EXISTS (SELECT 1 FROM ${K}.contacts c WHERE c.org_id = ${orgId}::uuid
                          AND lower(c.email) = e AND c.lawful_basis IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM ${K}.users u WHERE u.org_id = ${orgId}::uuid AND u.user_type <> 'external'
                          AND lower(split_part(u.email, '@', 2)) = split_part(e, '@', 2))`),
    )
    return rows.map((r) => r.email)
  })
  for (const email of missing) await recordProspect(orgId, email, fields)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A test org that sends commercial mail needs the identity every commercial
// mail states (modules/mail/commercial-footer.ts). Without it nothing commercial
// stages.
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

export const TEST_COMMERCIAL_IDENTITY = {
  legalName: "Org Test SAS",
  postalAddress: "1 rue de Test, 75001 Paris",
}

export async function setTestCommercialIdentity(
  orgId: string,
  identity: unknown = TEST_COMMERCIAL_IDENTITY,
): Promise<void> {
  await withSystemDb("test-commercial-identity", (tx) =>
    tx.execute(drizzleSql`UPDATE ${drizzleSql.raw(schemaRef("kernel"))}.organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{commercialIdentity}',
                               ${JSON.stringify(identity)}::jsonb, true)
      WHERE id = ${orgId}::uuid`),
  )
}

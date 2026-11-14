// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client company for a test that needs one: an external user's company_id
// points at a real kernel.companies row, so a portal account starts here.
import { withPrivilegedDb } from "~/db/privileged"
import { companies } from "~/db/schema/kernel"

/** Insert an org-wide company named `name` (on `domain`, if given) in `orgId` and return its id. */
export async function createTestCompany(
  orgId: string,
  name = "Client Co",
  domain: string | null = null,
): Promise<string> {
  const handle = `co-${crypto.randomUUID().slice(0, 8)}`
  const [row] = await withPrivilegedDb(orgId, "test-company", (tx) =>
    tx.insert(companies).values({ orgId, handle, name, domain }).returning({ id: companies.id }),
  )
  if (!row) throw new Error("createTestCompany: no row returned")
  return row.id
}

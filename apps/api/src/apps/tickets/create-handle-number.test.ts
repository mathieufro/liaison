// SPDX-License-Identifier: FSL-1.1-ALv2
// A ticket's number. A seed that tells a story with fixed ticket ids sets them;
// a ticket made later in that org never meets one of those numbers, and its
// number follows the org's highest rather than an instance-wide count below it.
import { beforeAll, describe, expect, it } from "bun:test"
import { createTicket } from "~/apps/tickets/create"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedOrgRow } from "~/seed/factories/org/rows"

let orgId: string

beforeAll(async () => {
  const slug = `ticket-number-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "TicketNumber", slug })
  await ensureAppsForOrg(orgId, {})
})

async function create(subject: string, handleNumber?: number): Promise<string> {
  const out = await withSystemDb("ticket-number", (tx) =>
    createTicket(
      tx as never,
      orgId,
      { subject, channel: "email", team: "support", contactEmail: "someone@example.test" },
      { actorType: "system", userId: null } as never,
      // Every read createTicket makes runs on this transaction, as a seed's does.
      { privilegedTx: tx as never, ...(handleNumber !== undefined ? { handleNumber } : {}) },
    ),
  )
  if ("error" in out) throw new Error(out.error.message)
  return out.ticketHandle
}

describe("a ticket's number", () => {
  it("a seed's fixed number is the ticket's, and a later ticket takes the number after the org's highest", async () => {
    const top = 900_000_000 + Math.floor(Math.random() * 1_000_000)
    expect(await create("Export of last month's rotas", top)).toBe(`ticket-${top}`)
    expect(await create("A later question")).toBe(`ticket-${top + 1}`)
    expect(await create("And another")).toBe(`ticket-${top + 2}`)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge moves the merged company's discussion messages into the
// survivor's discussion. Their search documents still name the old thread, so
// the merge event re-indexes every message of the survivor's discussion. Here
// the merge runs for real, its committed event goes through the durable
// consumers, and the live index queue is read back.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import * as jobsModule from "~/infra/jobs/jobs"
import { createCompany, mergeCompanies } from "~/modules/contacts/companies"
import { LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import {
  messageLiveIndexItem,
  registerMessageIndexerConsumer,
} from "~/modules/search/message-indexer"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"

const insert = (table: string, row: Record<string, RowValue>) => sql.unsafe(insertSql(table, row))

const ORG = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
  "kernel:threads:read",
]
const anna: UserContext = {
  actorType: "user",
  userId: ANNA,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}
const spies: Array<{ mockRestore: () => void }> = []

async function company(name: string): Promise<string> {
  const { company: row } = await withRlsContext(anna, (tx) =>
    createCompany(tx, { orgId: ORG, userId: ANNA, input: { name } }),
  )
  return row.id
}

/** The company's discussion thread with one message; returns the message id. */
async function discussionWithMessage(companyId: string, text: string): Promise<string> {
  const thread = crypto.randomUUID()
  await insert("kernel.threads", {
    id: thread,
    org_id: ORG,
    handle: `entity:kernel:company:${companyId}`,
    type: "thread",
    hidden_from_list: true,
    created_by: ANNA,
  })
  const id = crypto.randomUUID()
  await insert("kernel.messages", {
    id,
    thread_id: thread,
    org_id: ORG,
    author_id: ANNA,
    content: text,
    required_scopes: { raw: "'{}'::text[]" },
  })
  return id
}

beforeAll(async () => {
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation((() => {}) as never))
  await LiveIndexTestAccess.clear()
  await insert("kernel.organizations", {
    id: ORG,
    name: "CompanyDiscussionReindex",
    slug: `company-discussion-reindex-${tag}`,
  })
  await insert("kernel.users", {
    id: ANNA,
    org_id: ORG,
    email: `cdr-anna-${tag}@test.com`,
    name: "Anna",
    password_hash: "x",
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await LiveIndexTestAccess.clear()
  DurableConsumersTestAccess.reset()
  for (const s of spies) s.mockRestore()
})

describe("a company merge re-indexes the discussion it moved", () => {
  it("every message of the survivor's discussion, moved or its own, is queued for re-indexing", async () => {
    const source = await company("Lumen Studio")
    const target = await company("Lumen Studios")
    const moved = await discussionWithMessage(source, "Asked for the annual plan")
    const own = await discussionWithMessage(target, "Renewal due in March")

    const result = await withRlsContext(anna, (tx) =>
      mergeCompanies(tx, { orgId: ORG, userId: ANNA, sourceId: source, targetId: target }),
    )
    expect(result.discussionMoved).toBe(true)

    const [event] = await sql<{ id: string; data: unknown }[]>`
      SELECT id::text, payload -> 'data' AS data FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload ->> 'app' = 'kernel'
         AND payload ->> 'entity' = 'company' AND payload ->> 'action' = 'merge'
       ORDER BY seq DESC LIMIT 1`
    expect(event).toBeDefined()
    await LiveIndexTestAccess.clear()
    DurableConsumersTestAccess.reset()
    registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: String(event?.id),
      event: {
        app: "kernel",
        entity: "company",
        action: "merge",
        entityId: target,
        orgId: ORG,
        data: event?.data,
      },
    })

    const queued = (await LiveIndexTestAccess.pendingItems()).map((i) => i.key).sort()
    const expected = [moved, own]
      .map((messageId) => messageLiveIndexItem({ action: "upsert", orgId: ORG, messageId }).key)
      .sort()
    expect(queued).toEqual(expected)
  })
})

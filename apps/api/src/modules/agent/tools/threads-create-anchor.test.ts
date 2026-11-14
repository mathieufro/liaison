// SPDX-License-Identifier: FSL-1.1-ALv2
//
// threads_create naming the record a conversation is about (`createdFrom`).
// A record with a discussion gets its message in that discussion, never a new
// thread, posted as the agent and not as the person. A record the caller
// cannot see gets nothing, and a person listed who cannot see the record is
// left out and named, judged by their own grants, not the caller's. The post is
// never written hidden (scope-taint.ts, rule 14): a requester whose own grants do
// not cover what the session read gets nothing posted, not a post hidden from them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { handleThreadsCreate } from "~/modules/agent/tools/chat-tools"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ks = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)
const SEES_ITEMS = ["kernel:threads:read", "kernel:threads:write", "example:items:read"]

let orgId: string
let aliceId: string
let bobId: string
let danId: string
let carolId: string

async function item(text: string): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test-example-item", (tx) =>
    insertAppRow(tx, "example", "items", { id, org_id: orgId, text }),
  )
  return id
}

function create(
  params: Parameters<typeof handleThreadsCreate>[0],
  scopes = SEES_ITEMS,
  userId = aliceId,
) {
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
  }
  return withRlsContext(actor, (tx) =>
    handleThreadsCreate(params, {
      userId,
      orgId,
      db: tx,
      scopes,
      actorType: "agent",
    } as never),
  ) as Promise<Record<string, any>>
}

async function seats(threadId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "test-seats", async (tx) =>
    extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT user_id::text AS user_id FROM ${ks()}.thread_participants
         WHERE thread_id = ${threadId}::uuid AND user_id IS NOT NULL`),
    ).map((r) => r.user_id),
  )
}

describe("threads_create with createdFrom", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    aliceId = (await minimal.person(orgId, { name: "Alice Anchor" })).id
    bobId = (await minimal.person(orgId, { name: "Bob Anchor" })).id
    danId = (await minimal.person(orgId, { name: "Dan Anchor" })).id
    carolId = (await minimal.person(orgId, { name: "Carol Anchor" })).id
    // The caller holds the grant her session reads items with; Carol's agent reads
    // items past her own grants.
    await minimal.grantScope(aliceId, "example:items:read")
    await minimal.grantScope(bobId, "example:items:read")
  }, 60_000)
  afterAll(async () => {
    await releaseTestLock()
  })

  test("posts into the discussion, attributed to the agent", async () => {
    const itemId = await item("Gasket order")
    const createdFrom = { app: "example", entityType: "items", entityId: itemId }
    const first = await create({ participantIds: [], createdFrom, initialMessage: "First note" })
    expect(first.error).toBeUndefined()
    expect(first.created).toBe(true)
    const second = await create({ participantIds: [], createdFrom, initialMessage: "Second note" })
    expect(second.threadId).toBe(first.threadId)
    expect(second.created).toBe(false)
    expect(String(second.result)).toContain(first.threadId)

    const rows = await withPrivilegedDb(orgId, "test-messages", async (tx) =>
      extractRows<{ content: string; author_type: string; handle: string | null }>(
        await tx.execute(drizzleSql`
          SELECT m.content, m.author_type, t.handle FROM ${ks()}.messages m
            JOIN ${ks()}.threads t ON t.id = m.thread_id
           WHERE m.thread_id = ${first.threadId}::uuid ORDER BY m.created_at`),
      ),
    )
    expect(rows.map((r) => r.content)).toEqual(["First note", "Second note"])
    expect(rows.every((r) => r.author_type === "agent")).toBe(true)
    expect(rows[0]!.handle).toBe(`entity:example:items:${itemId}`)
  })

  test("invisible returns created_from_not_visible", async () => {
    const itemId = await item("Hidden from this caller")
    const result = await create(
      {
        participantIds: [],
        createdFrom: { app: "example", entityType: "items", entityId: itemId },
        initialMessage: "Should not land",
      },
      ["kernel:threads:read", "kernel:threads:write"],
    )
    expect(result.error?.code).toBe("created_from_not_visible")
    const threads = await withPrivilegedDb(orgId, "test-threads", async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT 1 FROM ${ks()}.threads WHERE org_id = ${orgId}::uuid
             AND handle = ${`entity:example:items:${itemId}`}`),
      ),
    )
    expect(threads).toHaveLength(0)
  })

  test("listed participant who cannot see is dropped and named", async () => {
    const itemId = await item("Shared with Bob only")
    const result = await create({
      participantIds: [bobId, danId],
      createdFrom: { app: "example", entityType: "items", entityId: itemId },
      initialMessage: "Bob, have a look",
    })
    expect(result.error).toBeUndefined()
    expect(result.added).toEqual([bobId])
    expect(result.notAdded).toEqual([danId])
    expect(String(result.result)).toContain(danId)
    const seated = await seats(result.threadId)
    expect(seated).toContain(bobId)
    expect(seated).not.toContain(danId)
  })

  test("an agent that read past its requester's own grants posts nothing", async () => {
    const itemId = await item("Read past Carol's grants")
    const result = await create(
      {
        participantIds: [],
        createdFrom: { app: "example", entityType: "items", entityId: itemId },
        initialMessage: "Carol would not see this",
      },
      SEES_ITEMS,
      carolId,
    )
    expect(result.error?.code).toBe("post_would_be_hidden")
    const posted = await withPrivilegedDb(orgId, "test-messages", async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT 1 FROM ${ks()}.messages m JOIN ${ks()}.threads t ON t.id = m.thread_id
           WHERE t.org_id = ${orgId}::uuid AND t.handle = ${`entity:example:items:${itemId}`}`),
      ),
    )
    expect(posted).toHaveLength(0)
  })
})

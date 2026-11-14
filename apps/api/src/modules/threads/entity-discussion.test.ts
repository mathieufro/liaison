// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DISCUSSION OF ANY ENTITY, under real row security. The example app
// declares one on its items (`entities.items.discussion`), the fixture for a
// kind that is neither a task nor a contact. Who reads the discussion is who
// reads the item: a person whose grants do not show the item gets nothing and
// creates nothing, and someone who loses sight of it loses the thread.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { assembleContext } from "~/modules/agent/context/context"
import { appBridgeManifestRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  DiscussionNotDeclaredError,
  enrolInEntityDiscussion,
  openEntityDiscussion,
  pruneEntityDiscussion,
} from "~/modules/threads/entity-discussion"
import { createExternalUser } from "~/modules/users/external-user"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestCompany } from "~/tests/helpers/company"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const THREAD_SCOPES = ["kernel:threads:read", "kernel:threads:write", "kernel:contacts:read"]
const SEES_ITEMS = [...THREAD_SCOPES, "example:items:read"]

let orgId: string
let aliceId: string
let bobId: string
let carolId: string

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: { "*": ["*"] },
})

async function item(org: string, text: string): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(org, "test-example-item", (tx) =>
    insertAppRow(tx, "example", "items", { id, org_id: org, text }),
  )
  return id
}

async function threadsWithHandle(handle: string): Promise<string[]> {
  const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
  return withPrivilegedDb(orgId, "test-count-threads", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${ks}.threads WHERE org_id = ${orgId}::uuid AND handle = ${handle}`),
    ).map((r) => r.id),
  )
}

/** Whether `actor` can read the thread row by id under their own RLS. */
async function canOpenThread(actor: UserContext, threadId: string): Promise<boolean> {
  const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
  const rows = await withRlsContext(actor, async (tx) =>
    extractRows(
      await tx.execute(drizzleSql`SELECT 1 FROM ${ks}.threads WHERE id = ${threadId}::uuid`),
    ),
  )
  return rows.length > 0
}

const open = (actor: UserContext, entityType: string, entityId: string, appName = "example") =>
  withRlsContext(actor, (tx) =>
    openEntityDiscussion(tx, {
      orgId,
      userId: actor.userId,
      ref: { app: appName, entityType, entityId },
    }),
  )

/** A sandbox bridge call of the example app, made as `actor` inside their own transaction. */
async function bridgeCall(
  actor: UserContext,
  method: string,
  params: Record<string, unknown>,
  before?: (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => Promise<void>,
): Promise<{ ok?: boolean; deleted?: number; dropped?: number; error?: { code: string } }> {
  const manifest = appBridgeManifestRegistry.get([orgId, "example"])
  if (!manifest) throw new Error("the example app is not registered for this org")
  return withRlsContext(actor, async (tx) => {
    if (before) await before(tx)
    const bridge = createRpcBridge(
      "example",
      actor.userId,
      orgId,
      tx,
      manifest as never,
      actor.scopes,
    )
    return JSON.parse(await bridge[method](JSON.stringify(params)))
  })
}

async function seatsOf(threadId: string): Promise<string[]> {
  const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
  return withPrivilegedDb(orgId, "test-seats", async (tx) =>
    extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT user_id::text AS user_id FROM ${ks}.thread_participants
         WHERE thread_id = ${threadId}::uuid AND user_id IS NOT NULL ORDER BY user_id`),
    ).map((r) => r.user_id),
  )
}

describe("entity discussions", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    aliceId = (await minimal.person(orgId, { name: "Alice Item" })).id
    bobId = (await minimal.person(orgId, { name: "Bob Item" })).id
    carolId = (await minimal.person(orgId, { name: "Carol Item" })).id
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("Promise.all of two first calls makes one thread", async () => {
    const itemId = await item(orgId, "Racing first open")
    const [a, b] = await Promise.all([
      open(as(aliceId, SEES_ITEMS), "items", itemId),
      open(as(bobId, SEES_ITEMS), "items", itemId),
    ])
    expect(a?.threadId).toBeDefined()
    expect(b?.threadId).toBe(a!.threadId)
    expect([a!.created, b!.created].filter(Boolean)).toHaveLength(1)
    expect(await threadsWithHandle(`entity:example:items:${itemId}`)).toEqual([a!.threadId])
  })

  test("second caller gets the same id and is enrolled", async () => {
    const itemId = await item(orgId, "Second caller")
    const first = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    expect(first?.created).toBe(true)
    expect(await canOpenThread(as(bobId, SEES_ITEMS), first!.threadId)).toBe(false)
    const second = await open(as(bobId, SEES_ITEMS), "items", itemId)
    expect(second).toEqual({ threadId: first!.threadId, created: false })
    expect(await canOpenThread(as(bobId, SEES_ITEMS), first!.threadId)).toBe(true)
  })

  test("hidden by RLS 404 creates nothing", async () => {
    const itemId = await item(orgId, "Not for Carol")
    // Without the item's read scope the app table's policy hides the row.
    expect(await open(as(carolId, THREAD_SCOPES), "items", itemId)).toBeNull()
    expect(await threadsWithHandle(`entity:example:items:${itemId}`)).toEqual([])
    // Over the route: an item of another organization reads as nothing, and nothing is made.
    const other = await minimal.secondOrg()
    const foreignItem = await item(other.orgId, "Another org's item")
    const admin = await minimal.adminSession(orgId)
    const res = await app.request("/api/threads/entity-discussion", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.bearer}` },
      body: JSON.stringify({ app: "example", entityType: "items", entityId: foreignItem }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found")
    expect(await threadsWithHandle(`entity:example:items:${foreignItem}`)).toEqual([])
  })

  test("undeclared 422 discussion_not_declared", async () => {
    await expect(
      open(as(aliceId, SEES_ITEMS), "summaries", crypto.randomUUID()),
    ).rejects.toBeInstanceOf(DiscussionNotDeclaredError)
    const admin = await minimal.adminSession(orgId)
    const res = await app.request("/api/threads/entity-discussion", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.bearer}` },
      body: JSON.stringify({ app: "example", entityType: "summaries", entityId: "x" }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "discussion_not_declared",
    )
  })

  test("task and contact return the existing thread, never a second", async () => {
    const tasker = as(aliceId, [
      ...THREAD_SCOPES,
      "projects:projects:read",
      "projects:projects:write",
      "projects:tasks:read",
      "projects:tasks:write",
    ])
    const task = await withRlsContext(tasker, async (tx) => {
      const p = await createProject({ tx, orgId, actor: tasker, input: { name: "Discussions" } })
      return createTask({
        tx,
        orgId,
        actor: tasker,
        input: { projectId: p.id, title: "Has its own thread" },
      })
    })
    expect(task.threadId).toBeTruthy()
    const bobTasks = { ...tasker, userId: bobId }
    const openedTask = await open(bobTasks, "task", task.id, "projects")
    expect(openedTask).toEqual({ threadId: task.threadId as string, created: false })
    expect(await threadsWithHandle(`entity:projects:task:${task.id}`)).toEqual([])

    const contactId = await minimal.contact(orgId, `discussion-${crypto.randomUUID()}@t.co`)
    const first = await open(as(aliceId, THREAD_SCOPES), "contact", contactId, "kernel")
    const again = await open(as(bobId, THREAD_SCOPES), "contact", contactId, "kernel")
    expect(again?.threadId).toBe(first!.threadId)
    expect(await threadsWithHandle(`contact-primary:${contactId}`)).toEqual([first!.threadId])
    expect(await threadsWithHandle(`entity:kernel:contact:${contactId}`)).toEqual([])
  })

  test("a client's portal account is never seated", async () => {
    const itemId = await item(orgId, "seat check")
    const opened = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    if (!opened) throw new Error("the item discussion did not open")
    const { threadId } = opened
    const email = `client-${crypto.randomUUID().slice(0, 8)}@client.example`
    const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
    const companyId = await createTestCompany(orgId)
    const clientId = await withPrivilegedDb(orgId, "test-portal-account", async (tx) => {
      const created = await createExternalUser(tx, {
        orgId,
        companyId,
        email,
        name: "Client Item",
      })
      if (!created.ok) throw new Error(created.code)
      await tx.execute(drizzleSql`
        UPDATE ${ks}.users SET status = 'active' WHERE id = ${created.userId}::uuid`)
      return created.userId
    })
    const result = await enrolInEntityDiscussion({
      orgId,
      threadId,
      ref: { app: "example", entityType: "items", entityId: itemId },
      userIds: [bobId, clientId],
    })
    expect(result.enrolled).not.toContain(clientId)
    expect(result.dropped).toContain(clientId)
  })

  test("a client's portal account opening a discussion is not seated and nothing is made", async () => {
    const itemId = await item(orgId, "Opened by a client")
    const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
    const companyId = await createTestCompany(orgId)
    const clientId = await withPrivilegedDb(orgId, "test-portal-opener", async (tx) => {
      const created = await createExternalUser(tx, {
        orgId,
        companyId,
        email: `opener-${crypto.randomUUID().slice(0, 8)}@client.example`,
        name: "Client Opener",
      })
      if (!created.ok) throw new Error(created.code)
      await tx.execute(drizzleSql`
        UPDATE ${ks}.users SET status = 'active' WHERE id = ${created.userId}::uuid`)
      return created.userId
    })
    expect(await open(as(clientId, SEES_ITEMS), "items", itemId)).toBeNull()
    expect(await threadsWithHandle(`entity:example:items:${itemId}`)).toEqual([])
    // On a discussion that exists already, the client is not seated either.
    const opened = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    expect(await open(as(clientId, SEES_ITEMS), "items", itemId)).toBeNull()
    expect(await seatsOf(opened!.threadId)).toEqual([aliceId])
  })

  test("the app prunes a discussion when its record narrows: the others drop out, the caller stays", async () => {
    const itemId = await item(orgId, "Narrowed by its app")
    const opened = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    await open(as(bobId, SEES_ITEMS), "items", itemId)
    expect(await seatsOf(opened!.threadId)).toEqual([aliceId, bobId].sort())
    const pruned = await bridgeCall(as(aliceId, SEES_ITEMS), "threads_pruneEntityDiscussion", {
      entityType: "items",
      entityId: itemId,
    })
    expect(pruned).toMatchObject({ ok: true, dropped: 1 })
    expect(await seatsOf(opened!.threadId)).toEqual([aliceId])
    expect(await canOpenThread(as(bobId, SEES_ITEMS), opened!.threadId)).toBe(false)
    const undeclared = await bridgeCall(as(aliceId, SEES_ITEMS), "threads_pruneEntityDiscussion", {
      entityType: "summaries",
      entityId: itemId,
    })
    expect(undeclared.error?.code).toBe("discussion_not_declared")
  })

  test("deleting the discussion of a record the caller cannot see is refused, and nothing goes", async () => {
    const itemId = await item(orgId, "Hidden from Carol")
    const opened = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    const refused = await bridgeCall(as(carolId, THREAD_SCOPES), "threads_deleteEntityDiscussion", {
      entityType: "items",
      entityId: itemId,
    })
    expect(refused.error?.code).toBe("entity_still_exists")
    expect(await threadsWithHandle(`entity:example:items:${itemId}`)).toEqual([opened!.threadId])
    expect(await seatsOf(opened!.threadId)).toEqual([aliceId])
  })

  test("a record deleted in the same call, or before it, takes its discussion with it", async () => {
    const items = drizzleSql.raw(`"${schemaRef("app_example")}".items`)
    const writer = as(aliceId, [...SEES_ITEMS, "example:items:write"])
    const sameCall = await item(orgId, "Deleted in the same call")
    await open(writer, "items", sameCall)
    const inCall = await bridgeCall(
      writer,
      "threads_deleteEntityDiscussion",
      { entityType: "items", entityId: sameCall },
      async (tx) => {
        await tx.execute(drizzleSql`DELETE FROM ${items} WHERE id = ${sameCall}::uuid`)
      },
    )
    expect(inCall).toMatchObject({ ok: true, deleted: 1 })
    expect(await threadsWithHandle(`entity:example:items:${sameCall}`)).toEqual([])

    const before = await item(orgId, "Deleted before the call")
    await open(writer, "items", before)
    await withPrivilegedDb(orgId, "test-delete-item", (tx) =>
      tx.execute(drizzleSql`DELETE FROM ${items} WHERE id = ${before}::uuid`),
    )
    const after = await bridgeCall(writer, "threads_deleteEntityDiscussion", {
      entityType: "items",
      entityId: before,
    })
    expect(after).toMatchObject({ ok: true, deleted: 1 })
  })

  test("after prune an enrolled person cannot open it", async () => {
    const itemId = await item(orgId, "Narrowed later")
    const opened = await open(as(aliceId, SEES_ITEMS), "items", itemId)
    await open(as(bobId, SEES_ITEMS), "items", itemId)
    expect(await canOpenThread(as(bobId, SEES_ITEMS), opened!.threadId)).toBe(true)
    await pruneEntityDiscussion({
      orgId,
      ref: { app: "example", entityType: "items", entityId: itemId },
      keepUserId: aliceId,
    })
    expect(await canOpenThread(as(bobId, SEES_ITEMS), opened!.threadId)).toBe(false)
    // And having lost sight of the item, opening it again does not seat him.
    expect(await open(as(bobId, THREAD_SCOPES), "items", itemId)).toBeNull()
    expect(await canOpenThread(as(bobId, SEES_ITEMS), opened!.threadId)).toBe(false)
    expect(await canOpenThread(as(aliceId, SEES_ITEMS), opened!.threadId)).toBe(true)
  })

  test("a mention in a discussion on a new kind has the tail line", async () => {
    const itemId = await item(orgId, "Quarterly gasket audit")
    const actor = as(aliceId, SEES_ITEMS)
    const opened = await open(actor, "items", itemId)
    // A mention sends no view: the thread's own origin names the item.
    const result = await assembleContext({ threadId: opened!.threadId, orgId, actor })
    const text = JSON.stringify(result)
    expect(text).toContain("This conversation is the discussion of")
    expect(text).toContain("Quarterly gasket audit")
  })
})

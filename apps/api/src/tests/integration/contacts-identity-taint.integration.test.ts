// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A system check that only needs a contact's identifiers reads them without marking the
// conversation as having read outside text, while a full contacts_read still marks it: the
// contact's mail backlinks carry text people outside the org wrote.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const world = { org: "", actor: null as unknown as UserContext, contact: "" }

async function thread(): Promise<string> {
  const id = randomUUID()
  await sql.unsafe(
    insertSql("kernel.threads", {
      id,
      org_id: world.org,
      handle: `identity-${id.slice(0, 8)}`,
      type: "agent_chat",
      created_by: world.actor.userId,
      tainted: false,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.thread_participants", {
      thread_id: id,
      user_id: world.actor.userId,
      org_id: world.org,
    }),
  )
  return id
}

async function taintedOf(threadId: string): Promise<boolean> {
  const [row] = await sql<
    { tainted: boolean }[]
  >`SELECT tainted FROM kernel.threads WHERE id = ${threadId}`
  return row?.tainted === true
}

describe("a contact's identifiers read without marking the conversation", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    world.org = org.id
    const admin = await minimal.person(world.org, { role: "admin" })
    world.actor = {
      actorType: "user",
      userId: admin.id,
      orgId: world.org,
      scopes: ["*"],
      dimensionGrants: {},
    }
    world.contact = randomUUID()
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id: world.contact,
        org_id: world.org,
        handle: `@identity-${world.contact.slice(0, 8)}`,
        name: "Claire Martin",
        email: "claire.martin@example.com",
      }),
    )
  }, 120_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("is hidden from agents and is not an outside-text source, unlike contacts_read", () => {
    const identity = toolRegistry.get([world.org, "kernel", "contacts_identity"])
    expect(identity?.agentVisible).toBe(false)
    expect(identity?.taintSource).toBeFalsy()
    expect(toolRegistry.get([world.org, "kernel", "contacts_read"])?.taintSource).toBe(true)
  })

  it("the identity read returns only the identifiers and leaves the conversation clean", async () => {
    const threadId = await thread()
    const res = await executeTool<{ contact: Record<string, unknown> }>({
      toolName: "kernel:contacts_identity",
      orgId: world.org,
      actor: world.actor,
      params: { contactId: world.contact },
      origin: "in-app-agent",
      threadId,
    })
    expect(res.data?.contact).toEqual({
      id: world.contact,
      email: "claire.martin@example.com",
      companyId: null,
    })
    expect(await taintedOf(threadId)).toBe(false)
  })

  it("a full contacts_read of the same contact still marks the conversation", async () => {
    const threadId = await thread()
    const res = await executeTool<{ contact: { id: string } }>({
      toolName: "kernel:contacts_read",
      orgId: world.org,
      actor: world.actor,
      params: { contactId: world.contact },
      origin: "in-app-agent",
      threadId,
    })
    expect(res.data?.contact.id).toBe(world.contact)
    expect(await taintedOf(threadId)).toBe(true)
  })
})

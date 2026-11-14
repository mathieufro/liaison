// SPDX-License-Identifier: FSL-1.1-ALv2
// Home: "Not now" on a persisted item, and "Today's brief" from the caller's own routine.

import { beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import { getEventAttentionItems } from "~/modules/attention/event-provider"
import { signAccessToken } from "~/modules/auth/jwt"
import { seedContext } from "~/seed/context"
import { seedAttentionEvents } from "~/seed/factories/attention/events"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"

let orgId: string
let me: { id: string; token: string }
let other: { id: string; token: string }

async function makeUser(suffix: string, name: string, timezone: string | null) {
  const id = await seedUserRow({
    orgId,
    email: `${name}-${suffix}@test.com`,
    name,
    status: "active",
    passwordHash: "hash",
    authVersion: 1,
    permissionVersion: 1,
    timezone,
  })
  await db.execute(
    drizzleSql.raw(
      insertSql("kernel.user_scope_grants", { user_id: id, org_id: orgId, scope: "*" }),
    ),
  )
  const token = await signAccessToken(
    {
      userId: id,
      orgId,
      name,
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )
  return { id, token }
}

beforeAll(async () => {
  const suffix = randomUUID()
  orgId = await seedOrgRow({ id: randomUUID(), name: "Home Org", slug: `home-${suffix}` })
  me = await makeUser(suffix, "elise", "Europe/Paris")
  other = await makeUser(suffix, "tom", "Europe/Paris")
})

async function seedEvent(userId: string): Promise<string> {
  const now = new Date()
  const [id] = await seedAttentionEvents(seedContext({ orgId, now }), [
    {
      key: randomUUID(),
      userId,
      app: "kernel",
      entityType: "notification",
      entityId: randomUUID(),
      kind: "agent_notification",
      urgency: 50,
      summary: "A deal went quiet",
      actorId: null,
      actorType: "system",
      occurredAt: now,
      readAt: null,
    },
  ])
  return id as string
}

async function feedIds(userId: string): Promise<string[]> {
  const items = await getEventAttentionItems(db as never, orgId, userId)
  return items.map((i) => i.id)
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("POST /api/attention-items/set-aside", () => {
  it("sets the event aside until next Monday 00:00 in the person's zone, and it leaves the feed", async () => {
    const id = await seedEvent(me.id)
    expect(await feedIds(me.id)).toContain(id)
    const res = await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { setAsideUntil: string; timeZone: string } }
    expect(body.data.timeZone).toBe("Europe/Paris")
    const until = new Date(body.data.setAsideUntil)
    expect(until.getTime()).toBeGreaterThan(Date.now())
    // Midnight in Paris is 22:00 or 23:00 UTC on the Sunday.
    expect(until.getUTCDay()).toBe(0)
    expect([22, 23]).toContain(until.getUTCHours())
    expect(await feedIds(me.id)).not.toContain(id)
  })

  it("comes back once the moment passes", async () => {
    const id = await seedEvent(me.id)
    await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(await feedIds(me.id)).not.toContain(id)
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET set_aside_until = now() - interval '1 minute' WHERE id = ${id}::uuid`)
    expect(await feedIds(me.id)).toContain(id)
  })

  it("set aside, then resolved elsewhere: it does not come back", async () => {
    const id = await seedEvent(me.id)
    await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events
      SET read_at = now(), set_aside_until = now() - interval '1 minute' WHERE id = ${id}::uuid`)
    expect(await feedIds(me.id)).not.toContain(id)
  })

  it("another person's event cannot be set aside", async () => {
    const id = await seedEvent(other.id)
    const res = await call("POST", "/api/attention-items/set-aside", me.token, { eventId: id })
    expect(res.status).toBe(404)
    expect(await feedIds(other.id)).toContain(id)
  })
})

async function seedBrief(ownerId: string, text: string): Promise<void> {
  const threadId = randomUUID()
  const agentId = randomUUID()
  const now = { raw: "now()" }
  for (const statement of [
    insertSql("kernel.agents", {
      id: agentId,
      org_id: orgId,
      kind: "personal",
      owner_user_id: ownerId,
      handle: `@brief-${agentId.slice(0, 8)}`,
      display_name: "Personal agent",
      scope_ceiling: { raw: `'["*"]'::jsonb` },
    }),
    insertSql("kernel.threads", {
      id: threadId,
      org_id: orgId,
      handle: `brief-${threadId.slice(0, 8)}`,
      type: "agent_chat",
      created_by: ownerId,
    }),
    insertSql("kernel.thread_participants", {
      thread_id: threadId,
      user_id: ownerId,
      org_id: orgId,
      role: "admin",
    }),
    insertSql("kernel.routines", {
      id: randomUUID(),
      org_id: orgId,
      owner_user_id: ownerId,
      owner_agent_id: agentId,
      name: "Morning brief",
      description: "brief",
      kind: "recurring",
      cron: "30 7 * * 1-5",
      timezone: "Europe/Paris",
      prompt: "brief",
      scopes: { raw: "'{}'" },
      created_by_actor_type: "user",
      template_key: "morning-brief",
      output_thread_id: threadId,
      last_run_at: now,
    }),
    insertSql("kernel.messages", {
      org_id: orgId,
      thread_id: threadId,
      author_id: ownerId,
      author_agent_id: agentId,
      author_type: "agent",
      content: text,
      required_scopes: { raw: "'{}'" },
    }),
  ]) {
    await db.execute(drizzleSql.raw(statement))
  }
}

describe("GET /api/home/brief", () => {
  it("another person's is never readable", async () => {
    await seedBrief(other.id, "Tom's brief: 3 deals open")
    const res = await call("GET", "/api/home/brief", me.token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toBeNull()
  })

  it("the caller's own brief: newest agent message with its time", async () => {
    await seedBrief(me.id, "Monthly recurring revenue is up")
    const res = await call("GET", "/api/home/brief", me.token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { routineName: string; message: { text: string; at: string } | null }
    }
    expect(body.data.routineName).toBe("Morning brief")
    expect(body.data.message?.text).toBe("Monthly recurring revenue is up")
    expect(Number.isNaN(Date.parse(body.data.message?.at ?? ""))).toBe(false)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, connectWs, createUserWithScopes } from "@liaison/test-helpers"
import { decide } from "./helpers/approvals"
import { runCronJobToCompletion, triggerCronJob } from "./helpers/run-cron"
import { seedFactory } from "./helpers/seed-factory"
import {
  backdateSlaDeadline,
  ks,
  seedConnectedAccount,
  seedTicket,
  ts,
} from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

interface TestActor {
  id: string
  email: string
  token: string
  name: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
}

async function makeActor(
  url: string,
  env: WorkerEnv,
  world: TestWorld,
  opts: {
    name: string
    scopes: string[]
    dimensions?: Record<string, string[]>
  },
): Promise<TestActor> {
  const created = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name: opts.name,
    scopes: opts.scopes,
    dimensions: opts.dimensions ?? { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })
  return {
    id: created.id,
    email: created.email,
    token: created.token,
    name: created.name,
    scopes: opts.scopes,
    dimensionGrants: opts.dimensions ?? { "*": ["*"] },
  }
}

async function runWithRlsContext<T>(
  env: WorkerEnv,
  ctx: {
    userId: string
    orgId: string
    scopes: string[]
    dimensionGrants: Record<string, string[]>
  },
  fn: (sql: any) => Promise<T>,
): Promise<T> {
  return env.db.sql.begin(async (sql) => {
    await sql.unsafe(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId])
    await sql.unsafe(`SELECT set_config('app.current_org_id', $1, true)`, [ctx.orgId])
    await sql.unsafe(`SELECT set_config('app.current_scopes', $1, true)`, [
      ctx.scopes.length > 0 ? ctx.scopes.join(",") : "__none__",
    ])
    await sql.unsafe(`SELECT set_config('app.current_dimensions', $1, true)`, [
      JSON.stringify(ctx.dimensionGrants),
    ])
    await sql.unsafe(`SET LOCAL ROLE liaison_rls`)
    return fn(sql)
  }) as T
}

describe("Tickets Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  // Wildcard team/sensitivity actor — used for setup, S2, S5..S13, S19, S20
  let writeUser: TestActor
  let euUser: TestActor
  let usUser: TestActor
  let assignee: TestActor
  let noScopeUser: TestActor
  let categoriesAdmin: TestActor
  let inboxesAdmin: TestActor

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 712,
      org: { name: "Tickets E2E" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    writeUser = await makeActor(url, env, world, {
      name: "Tickets Write",
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:sla:read",
        "tickets:messages:read",
        "tickets:messages:write",
      ],
      // Grants carry the namespaced dimension keys the tickets RLS policies read
      // (role grants made through the API are canonicalized the same way).
      dimensions: { "tickets:team": ["*"], "tickets:sensitivity": ["*"] },
    })
    euUser = await makeActor(url, env, world, {
      name: "EU Agent",
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensions: { "tickets:team": ["support-eu"], "tickets:sensitivity": ["restricted"] },
    })
    usUser = await makeActor(url, env, world, {
      name: "US Agent",
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensions: { "tickets:team": ["support-us"], "tickets:sensitivity": ["restricted"] },
    })
    assignee = await makeActor(url, env, world, {
      name: "Assignee",
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensions: { "tickets:team": ["*"], "tickets:sensitivity": ["*"] },
    })
    noScopeUser = await makeActor(url, env, world, {
      name: "No-Scope",
      scopes: ["kernel:contacts:read"],
      dimensions: { "*": ["*"] },
    })
    categoriesAdmin = await makeActor(url, env, world, {
      name: "Cat Admin",
      scopes: [
        "tickets:tickets:read",
        "tickets:categories:admin",
        "tickets:categories:read",
        "tickets:categories:write",
      ],
      dimensions: { "*": ["*"] },
    })
    inboxesAdmin = await makeActor(url, env, world, {
      name: "Inbox Admin",
      scopes: [
        "tickets:tickets:read",
        "tickets:inboxes:admin",
        "tickets:inboxes:read",
        "tickets:inboxes:write",
      ],
      dimensions: { "*": ["*"] },
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── E0d / S1: Smoke ───

  it("S1 smoke: server boots, default apps active, tickets sequence + schema present", async () => {
    const appRows = await env.db.sql.unsafe(
      `SELECT name, status FROM ${ks(env)}.apps
         WHERE name IN ('test', 'mail', 'contacts', 'tickets', 'test-bridge-a', 'test-bridge-b')
         ORDER BY name`,
    )
    expect(appRows.length).toBe(6)
    for (const row of appRows) {
      expect((row as any).status).toBe("active")
    }

    const ticketsSchemaName = env.schemaPrefix ? `${env.schemaPrefix}app_tickets` : "app_tickets"
    const schemas = await env.db.sql`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${ticketsSchemaName}`
    expect(schemas.length).toBe(1)

    const sequences = await env.db.sql`
      SELECT sequence_name FROM information_schema.sequences
        WHERE sequence_schema = ${ticketsSchemaName} AND sequence_name = 'tickets_handle_seq'`
    expect(sequences.length).toBe(1)

    const reader = await makeActor(url, env, world, {
      name: "Tickets Reader",
      scopes: ["tickets:tickets:read"],
      dimensions: { "tickets:team": ["*"], "tickets:sensitivity": ["*"] },
    })
    const res = await api(url, "/api/attention-items", { token: reader.token })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data?.items)).toBe(true)
  })

  // ─── S2: create → get → setStatus ───

  it("S2: tickets create → get → setStatus pauses SLA on awaiting_customer", async () => {
    const create = await api(url, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: writeUser.token,
      body: {
        params: {
          subject: "Login broken",
          priority: "urgent",
          channel: "manual",
          team: "support-eu",
          initialMessage: { kind: "inbound", textBody: "Cannot log in" },
        },
      },
    })
    expect(create.status).toBe(200)
    const ticketId = (create.body.data as any).ticketId as string
    const ticketHandle = (create.body.data as any).ticketHandle as string
    expect(ticketHandle).toMatch(/^ticket-\d+$/)

    const [row] = await env.db.sql.unsafe(
      `SELECT handle, priority, team, sla_target_seconds, sla_deadline, created_at
         FROM ${ts(env)}.tickets WHERE id = $1`,
      [ticketId],
    )
    expect(row.handle).toBe(ticketHandle)
    expect(row.priority).toBe("urgent")
    expect(row.team).toBe("support-eu")
    expect(Number(row.sla_target_seconds)).toBe(3600)
    expect(new Date(row.sla_deadline).getTime()).toBeGreaterThan(new Date(row.created_at).getTime())

    const get1 = await api(url, "/api/apps/tools/tickets:get", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId } },
    })
    expect(get1.status).toBe(200)
    const ticket1 = (get1.body.data as any).ticket
    const messages1 = (get1.body.data as any).messages
    expect(ticket1.priority).toBe("urgent")
    expect(ticket1.team).toBe("support-eu")
    expect(messages1.items.length).toBe(1)

    const setStatus = await api(url, "/api/apps/tools/tickets:setStatus", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId, status: "awaiting_customer" } },
    })
    expect(setStatus.status).toBe(200)
    expect((setStatus.body.data as any).status).toBe("awaiting_customer")

    const [paused] = await env.db.sql.unsafe(
      `SELECT status, sla_paused_at FROM ${ts(env)}.tickets WHERE id = $1`,
      [ticketId],
    )
    expect(paused.status).toBe("awaiting_customer")
    expect(paused.sla_paused_at).not.toBeNull()
  })

  // ─── S3: Cross-team RLS isolation via HTTP ───

  it("S3: cross-team RLS hides ticket from search/get and direct SQL", async () => {
    const created = await api(url, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: euUser.token,
      body: {
        params: {
          subject: "EU-only",
          priority: "normal",
          channel: "manual",
          team: "support-eu",
          sensitivity: "restricted",
        },
      },
    })
    expect(created.status).toBe(200)
    const ticketId = (created.body.data as any).ticketId as string

    const search = await api(url, "/api/apps/tools/tickets:search", {
      method: "POST",
      token: usUser.token,
      body: { params: {} },
    })
    expect(search.status).toBe(200)
    const items = (search.body.data as any).items as any[]
    expect(items.find((i) => i.id === ticketId)).toBeUndefined()

    const get = await api(url, "/api/apps/tools/tickets:get", {
      method: "POST",
      token: usUser.token,
      body: { params: { ticketId } },
    })
    expect(get.status).toBe(200)
    expect((get.body.data as any).ticket).toBeNull()

    const rows = await runWithRlsContext<{ id: string }[]>(
      env,
      {
        userId: usUser.id,
        orgId: world.org.id,
        scopes: ["tickets:tickets:read", "tickets:messages:read"],
        dimensionGrants: { "tickets:team": ["support-us"], "tickets:sensitivity": ["restricted"] },
      },
      (sql) => sql.unsafe(`SELECT id FROM ${ts(env)}.tickets WHERE id = $1`, [ticketId]),
    )
    expect(rows.length).toBe(0)
  })

  // ─── S4: Messages joined-dimension RLS ───

  it("S4: messages INSERT under unauthorized RLS rejected by WITH CHECK", async () => {
    const created = await api(url, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: euUser.token,
      body: {
        params: {
          subject: "EU dim ticket",
          priority: "normal",
          team: "support-eu",
          sensitivity: "restricted",
          initialMessage: { kind: "inbound", textBody: "EU msg" },
        },
      },
    })
    expect(created.status).toBe(200)
    const ticketId = (created.body.data as any).ticketId as string

    const get = await api(url, "/api/apps/tools/tickets:get", {
      method: "POST",
      token: usUser.token,
      body: { params: { ticketId } },
    })
    expect(get.status).toBe(200)
    expect((get.body.data as any).ticket).toBeNull()

    let insertError: unknown = null
    try {
      await runWithRlsContext(
        env,
        {
          userId: usUser.id,
          orgId: world.org.id,
          scopes: [
            "tickets:tickets:read",
            "tickets:tickets:write",
            "tickets:messages:read",
            "tickets:messages:write",
          ],
          dimensionGrants: {
            "tickets:team": ["support-us"],
            "tickets:sensitivity": ["restricted"],
          },
        },
        (sql) =>
          sql.unsafe(
            `INSERT INTO ${ts(env)}.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
              VALUES (gen_random_uuid(), $1, $2, 'note', 'sneaky', now(), now(), now())`,
            [world.org.id, ticketId],
          ),
      )
    } catch (err) {
      insertError = err
    }
    expect(insertError).not.toBeNull()
    const message = (insertError as Error).message
    expect(message.toLowerCase()).toMatch(/row-level security|policy/)
  })

  // ─── S5/S6: Attention items ───

  // The apps' attention lists are stored, recomputed after the app was woken
  // and on the attention minute tick. Tickets seeded straight into the table
  // wake nothing, and the tick only queues a refresh (deduplicated per minute,
  // under the org's minute budget): recompute the tickets list in place.
  const refreshStoredAttention = () =>
    seedFactory(env, world.org.id, "attention.refresh", { apps: ["tickets"] })

  it("S5: attention items returns shared contract for mixed-state tickets", async () => {
    // T1 — sla_risk: backdate deadline to within 25% of total
    const t1 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "SLA-risk",
      priority: "urgent",
      team: "support-eu",
    })
    await backdateSlaDeadline(env, { orgId: world.org.id, ticketId: t1.id, secondsAgo: -300 })

    // T2 — awaiting_agent: last_inbound_at > last_outbound_at, first_response_at set
    const t2 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Awaiting-agent",
      priority: "normal",
      firstResponseAt: new Date(Date.now() - 60_000).toISOString(),
      lastInboundAt: new Date(Date.now() - 30_000).toISOString(),
      lastOutboundAt: new Date(Date.now() - 60_000).toISOString(),
      team: "support-eu",
    })

    // T3 — unassigned: created_at > 1h ago, no assignee
    const t3 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Unassigned",
      priority: "normal",
      team: "support-eu",
      createdMinutesAgo: 120,
    })

    // T4 — followup_due
    const t4 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Followup-due",
      status: "awaiting_followup",
      team: "support-eu",
      followupAt: new Date(Date.now() - 60_000).toISOString(),
      followupReason: "ping back",
    })
    await refreshStoredAttention()

    const res = await api(url, "/api/attention-items", { token: writeUser.token })
    expect(res.status).toBe(200)
    const allItems = (res.body.data?.items ?? []) as any[]
    const items = allItems.filter((i) => i.app === "tickets")

    const byKind = (id: string) => items.filter((i) => i.entityId === id).map((i) => i.kind)
    expect(byKind(t1.id)).toContain("sla_risk")
    expect(byKind(t2.id)).toContain("awaiting_agent")
    expect(byKind(t3.id)).toContain("unassigned")
    expect(byKind(t4.id)).toContain("followup_due")

    for (const item of items) {
      expect(item.app).toBe("tickets")
      expect(item.entity).toBe("ticket")
      expect(typeof item.urgency).toBe("number")
      expect(item.urgency).toBeGreaterThanOrEqual(0)
      expect(item.urgency).toBeLessThanOrEqual(100)
      expect(item.action).toEqual({
        type: "open_entity",
        tabType: "tickets:ticket",
        entityId: item.entityId,
      })
      expect(item.id).toBe(`${item.kind}:${item.entityId}`)
    }

    const res2 = await api(url, "/api/attention-items", { token: writeUser.token })
    expect(res2.status).toBe(200)
    const items2 = (res2.body.data?.items ?? []).filter((i: any) => i.app === "tickets") as any[]
    const ids1 = items.map((i) => i.id).sort()
    const ids2 = items2.map((i) => i.id).sort()
    expect(ids2).toEqual(ids1)
  })

  it("S6: attention items returns empty for actor with no scope", async () => {
    const res = await api(url, "/api/attention-items", {
      token: noScopeUser.token,
    })
    expect(res.status).toBe(200)
    const items = (res.body.data?.items ?? []) as any[]
    expect(items.filter((i) => i.app === "tickets")).toEqual([])
  })

  // ─── S7: Default roles seeded ───

  it("S7: default roles seeded with flattened scopes", async () => {
    const roles = await env.db.sql.unsafe(
      `SELECT id, name FROM ${ks(env)}.roles
         WHERE org_id = $1 AND name IN ('tickets.support', 'tickets.support_lead', 'tickets.admin')`,
      [world.org.id],
    )
    expect(roles.length).toBe(3)
    const byName = new Map<string, string>(roles.map((r: any) => [r.name, r.id]))

    async function scopesFor(name: string): Promise<string[]> {
      const id = byName.get(name)!
      const rows = await env.db.sql.unsafe(
        `SELECT scope FROM ${ks(env)}.role_scope_grants WHERE role_id = $1 ORDER BY scope`,
        [id],
      )
      return rows.map((r: any) => r.scope)
    }

    const supportScopes = await scopesFor("tickets.support")
    expect(supportScopes.sort()).toEqual(
      [
        "tickets:approve",
        "tickets:categories:read",
        "tickets:inboxes:read",
        "tickets:tickets:read",
        "tickets:tickets:reply",
        "tickets:tickets:write",
      ].sort(),
    )

    const leadScopes = await scopesFor("tickets.support_lead")
    expect(leadScopes).toContain("tickets:tickets:close")
    expect(leadScopes).toContain("tickets:inboxes:admin")
    expect(leadScopes).toContain("tickets:categories:admin")
    expect(leadScopes).toContain("tickets:tickets:read") // inherited

    const adminScopes = await scopesFor("tickets.admin")
    expect(adminScopes).toContain("tickets:settings:admin")
    expect(adminScopes).toContain("tickets:inboxes:admin") // from support_lead
    expect(adminScopes).toContain("tickets:tickets:read") // from support
  })

  // ─── S8: Org settings auto-seed + schema round-trip ───

  it("S8: org settings auto-seeded and email template round-trips", async () => {
    const previousSchemaPrefix = process.env.SCHEMA_PREFIX
    process.env.SCHEMA_PREFIX = env.schemaPrefix
    try {
      const [seed] = await env.db.sql.unsafe(
        `SELECT settings -> 'tickets' AS s FROM ${ks(env)}.organizations WHERE id = $1`,
        [world.org.id],
      )
      const seedSettings =
        typeof seed.s === "string" ? JSON.parse(seed.s as string) : (seed.s as any)
      expect(seedSettings.sla.targets.urgent).toBe(3600)
      expect(seedSettings.sla.businessHours.timezone).toBe("Europe/Paris")
      expect(seedSettings.resend).toBeUndefined()
      expect(seedSettings.gmailPushSecret).toBeUndefined()

      const { setOrgAppSettings, getOrgAppSettings } = await import("~/lib/settings")
      const { ticketsSettingsSchema } = await import("@liaison/shared")
      const { __privileged_db__: db } = await import("~/db/connection")

      await setOrgAppSettings(db as any, world.org.id, "tickets", ticketsSettingsSchema, {
        emailTemplate: {
          headerName: "Acme Support",
          footerText: "Thanks for contacting us.",
          accentColor: "#ff0000",
        },
      } as any)

      const [stored] = await env.db.sql.unsafe(
        `SELECT settings -> 'tickets' -> 'emailTemplate' ->> 'headerName' AS header_name
           FROM ${ks(env)}.organizations WHERE id = $1`,
        [world.org.id],
      )
      expect(stored.header_name).toBe("Acme Support")

      const decrypted = await getOrgAppSettings(
        db as any,
        world.org.id,
        "tickets",
        ticketsSettingsSchema,
      )
      expect(decrypted.emailTemplate.headerName).toBe("Acme Support")
    } finally {
      if (previousSchemaPrefix === undefined) delete process.env.SCHEMA_PREFIX
      else process.env.SCHEMA_PREFIX = previousSchemaPrefix
    }
  })

  // ─── S9: Timeline ───

  it("S9: timeline records status / priority / assignment / manual_reopen with actionLabel", async () => {
    const created = await api(url, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: writeUser.token,
      body: {
        params: {
          subject: "Timeline subject",
          priority: "urgent",
          channel: "manual",
          team: "support-eu",
          initialMessage: { kind: "inbound", textBody: "init" },
        },
      },
    })
    const ticketId = (created.body.data as any).ticketId as string

    const sp = await api(url, "/api/apps/tools/tickets:setPriority", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId, priority: "high" } },
    })
    expect(sp.status).toBe(200)
    const as = await api(url, "/api/apps/tools/tickets:assign", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId, assignedTo: assignee.id } },
    })
    expect(as.status).toBe(200)

    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets SET status = 'closed', closed_reason = 'resolved' WHERE id = $1`,
      [ticketId],
    )

    const reopen = await api(url, "/api/apps/tools/tickets:reopen", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId } },
    })
    expect(reopen.status).toBe(200)

    const deadline = Date.now() + 5000
    let entries: any[] = []
    let labelMatch = false
    while (Date.now() < deadline) {
      const tlRes = await api(url, `/api/timeline/tickets/ticket/${ticketId}`, {
        token: writeUser.token,
      })
      entries = (tlRes.body.data ?? []) as any[]
      const labels = await env.db.sql.unsafe(
        `SELECT action_label FROM ${ks(env)}.timeline_entries
           WHERE app = 'tickets' AND entity_type = 'ticket' AND entity_id = $1`,
        [ticketId],
      )
      labelMatch = labels.some((l: any) => l.action_label === "manual_reopen")
      if (entries.length > 0 && labelMatch) break
      await Bun.sleep(100)
    }
    expect(entries.length).toBeGreaterThan(0)
    expect(labelMatch).toBe(true)
  }, 15_000)

  // ─── S10: Merge happy path with approval cancellation ───

  it("S10: merge HTTP — copies messages, cancels approvals, emits events", async () => {
    const wsClient = await connectWs(url, writeUser.token)

    async function createTicketWithMessage(subject: string): Promise<string> {
      const r = await api(url, "/api/apps/tools/tickets:create", {
        method: "POST",
        token: writeUser.token,
        body: {
          params: {
            subject,
            priority: "normal",
            channel: "manual",
            team: "support-eu",
            initialMessage: { kind: "inbound", textBody: subject },
          },
        },
      })
      return (r.body.data as any).ticketId as string
    }

    const target = await createTicketWithMessage("Target ticket")
    const s1 = await createTicketWithMessage("Source 1")
    const s2 = await createTicketWithMessage("Source 2")
    const s3 = await createTicketWithMessage("Source 3")

    // Plant a pending approval for s1 (matched by tickets:reply / nudge / close + ticketId).
    // postgres.js auto-stringifies string params; cast through ::text → ::jsonb so the
    // payload lands as a jsonb object (not a jsonb string).
    const approvalId = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.approval_requests (
         id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, notify_user_ids, requested_by, status, summary
       ) VALUES (
         $1, $2, $3,
         (SELECT id FROM ${ks(env)}.threads WHERE org_id = $2 LIMIT 1),
         (SELECT id FROM ${ks(env)}.threads WHERE org_id = $2 LIMIT 1),
         'tickets:reply', $4::text::jsonb, $4::text::jsonb,
         now() + interval '1 day', ARRAY[$5::uuid], $5, 'pending', $6::text::jsonb
       )`,
      [
        approvalId,
        world.org.id,
        `request-${Date.now()}`,
        JSON.stringify({ ticketId: s1 }),
        writeUser.id,
        JSON.stringify({ title: "Test approval" }),
      ],
    )

    const merge = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: {
        params: {
          targetTicketId: target,
          sourceTicketIds: [s1, s2, s3],
          note: "merged duplicates",
        },
      },
    })
    expect(merge.status).toBe(200)
    const data = merge.body.data as any
    expect(data.targetTicketId).toBe(target)
    expect(data.mergedSourceCount).toBe(3)
    expect(data.copiedMessageCount).toBe(3)

    const sources = await env.db.sql.unsafe(
      `SELECT id, status, closed_reason, merged_into_ticket_id FROM ${ts(env)}.tickets WHERE id = ANY($1)`,
      [[s1, s2, s3]],
    )
    expect(sources.length).toBe(3)
    for (const row of sources) {
      expect((row as any).status).toBe("closed")
      expect((row as any).closed_reason).toBe("merged")
      expect((row as any).merged_into_ticket_id).toBe(target)
    }

    const targetMessages = await env.db.sql.unsafe(
      `SELECT kind, text_body FROM ${ts(env)}.messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [target],
    )
    const noteRow = targetMessages.find(
      (m: any) => m.kind === "note" && m.text_body === "merged duplicates",
    )
    expect(noteRow).toBeTruthy()

    const [approval] = await env.db.sql.unsafe(
      `SELECT status, reason FROM ${ks(env)}.approval_requests WHERE id = $1`,
      [approvalId],
    )
    expect(approval.status).toBe("cancelled")
    expect(approval.reason).toBe("Cancelled: the ticket was merged into another")

    // Poll the WS for the 3 ticket:merged events instead of a single fixed-sleep
    // sample: under parallel e2e load the merge round-trip + 100ms outbox poll +
    // Redis fan-out of 3 events can land just after a fixed 1.5s window, which
    // never retries. Wait up to 8s for them to arrive.
    const isMerged = (m: any) =>
      m?.payload?.app === "tickets" &&
      m?.payload?.entity === "ticket" &&
      m?.payload?.action === "merged"
    const deadline = Date.now() + 8000
    let merged = wsClient.messages.filter(isMerged)
    while (merged.length < 3 && Date.now() < deadline) {
      await Bun.sleep(100)
      merged = wsClient.messages.filter(isMerged)
    }
    expect(merged.length).toBeGreaterThanOrEqual(3)
    wsClient.close()
  }, 15_000)

  // ─── S11: Merge typed errors ───

  it("S11: merge typed errors — self_reference / already_merged / converted / target_invalid", async () => {
    const a = (
      await api(url, "/api/apps/tools/tickets:create", {
        method: "POST",
        token: writeUser.token,
        body: {
          params: { subject: "S11-A", priority: "normal", channel: "manual", team: "support-eu" },
        },
      })
    ).body.data as any
    const b = (
      await api(url, "/api/apps/tools/tickets:create", {
        method: "POST",
        token: writeUser.token,
        body: {
          params: { subject: "S11-B", priority: "normal", channel: "manual", team: "support-eu" },
        },
      })
    ).body.data as any
    const c = (
      await api(url, "/api/apps/tools/tickets:create", {
        method: "POST",
        token: writeUser.token,
        body: {
          params: { subject: "S11-C", priority: "normal", channel: "manual", team: "support-eu" },
        },
      })
    ).body.data as any
    const d = (
      await api(url, "/api/apps/tools/tickets:create", {
        method: "POST",
        token: writeUser.token,
        body: {
          params: { subject: "S11-D", priority: "normal", channel: "manual", team: "support-eu" },
        },
      })
    ).body.data as any

    const self = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: { params: { targetTicketId: a.ticketId, sourceTicketIds: [a.ticketId, b.ticketId] } },
    })
    expect(self.body.error?.code).toBe("merge_self_reference")

    // Successful merge of b → a
    const ok = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: { params: { targetTicketId: a.ticketId, sourceTicketIds: [b.ticketId] } },
    })
    expect(ok.status).toBe(200)

    const already = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: { params: { targetTicketId: c.ticketId, sourceTicketIds: [b.ticketId] } },
    })
    expect(already.body.error?.code).toBe("ticket_already_merged")

    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets SET status = 'closed', closed_reason = 'converted_to_mail' WHERE id = $1`,
      [d.ticketId],
    )
    const converted = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: { params: { targetTicketId: c.ticketId, sourceTicketIds: [d.ticketId] } },
    })
    expect(converted.body.error?.code).toBe("converted_ticket")

    const invalid = await api(url, "/api/apps/tools/tickets:merge", {
      method: "POST",
      token: writeUser.token,
      body: {
        params: {
          targetTicketId: "00000000-0000-0000-0000-000000000000",
          sourceTicketIds: [c.ticketId],
        },
      },
    })
    expect(invalid.body.error?.code).toBe("not_found")
  })

  // ─── S12: SLA breach cron ───

  it("S12: SLA breach cron emits one event per breach, dedupes, recompute clears", async () => {
    const seed = await seedTicket(env, {
      orgId: world.org.id,
      subject: "SLA-breach",
      priority: "urgent",
      team: "support-eu",
    })
    await backdateSlaDeadline(env, { orgId: world.org.id, ticketId: seed.id, secondsAgo: 300 })

    const wsClient = await connectWs(url, writeUser.token)

    await triggerCronJob(env, "app-tickets", "slaCheck", { orgId: world.org.id })
    const breachEvent = await wsClient.waitFor(
      "event",
      (m) =>
        m?.payload?.app === "tickets" &&
        m?.payload?.entity === "sla" &&
        m?.payload?.action === "breach" &&
        m?.payload?.entityId === seed.id,
      8000,
    )
    expect(breachEvent.payload.data.priority).toBe("urgent")
    expect(breachEvent.payload.data.handle).toBe(seed.handle)

    const [r1] = await env.db.sql.unsafe(
      `SELECT sla_breached_at FROM ${ts(env)}.tickets WHERE id = $1`,
      [seed.id],
    )
    expect(r1.sla_breached_at).not.toBeNull()
    const initialBreachAt = r1.sla_breached_at

    // Dedupe: re-running the cron handler must not move sla_breached_at again.
    await runCronJobToCompletion(env, "app-tickets", "slaCheck", { orgId: world.org.id })
    const [r1Again] = await env.db.sql.unsafe(
      `SELECT sla_breached_at FROM ${ts(env)}.tickets WHERE id = $1`,
      [seed.id],
    )
    expect(new Date(r1Again.sla_breached_at).getTime()).toBe(new Date(initialBreachAt).getTime())

    // Recompute clears the breach.
    await api(url, "/api/apps/tools/tickets:setPriority", {
      method: "POST",
      token: writeUser.token,
      body: { params: { ticketId: seed.id, priority: "high" } },
    })
    const [r2] = await env.db.sql.unsafe(
      `SELECT sla_breached_at FROM ${ts(env)}.tickets WHERE id = $1`,
      [seed.id],
    )
    expect(r2.sla_breached_at).toBeNull()

    // Backdate again; the next cron tick should re-stamp sla_breached_at.
    await backdateSlaDeadline(env, { orgId: world.org.id, ticketId: seed.id, secondsAgo: 300 })
    await triggerCronJob(env, "app-tickets", "slaCheck", { orgId: world.org.id })
    const deadline = Date.now() + 8000
    let r3: any = null
    while (Date.now() < deadline) {
      const rows = await env.db.sql.unsafe(
        `SELECT sla_breached_at FROM ${ts(env)}.tickets WHERE id = $1`,
        [seed.id],
      )
      r3 = rows[0]
      if (r3?.sla_breached_at != null) break
      await Bun.sleep(100)
    }
    expect(r3?.sla_breached_at).not.toBeNull()

    wsClient.close()
  }, 30_000)

  // ─── S13: Followup cron auto-reopens ───

  it("S13: followup cron auto-reopens, emits reopened event, attention item updates", async () => {
    const seed = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Followup-cron",
      status: "awaiting_followup",
      team: "support-eu",
      followupAt: new Date(Date.now() - 60_000).toISOString(),
      followupReason: "ping back",
    })
    await refreshStoredAttention()

    const before = await api(url, "/api/attention-items", { token: writeUser.token })
    expect(
      ((before.body.data?.items ?? []) as any[]).some(
        (i) => i.entityId === seed.id && i.kind === "followup_due",
      ),
    ).toBe(true)

    await triggerCronJob(env, "app-tickets", "followupCheck", { orgId: world.org.id })
    const deadline = Date.now() + 8000
    let row: any = null
    while (Date.now() < deadline) {
      const rows = await env.db.sql.unsafe(
        `SELECT status, followup_at FROM ${ts(env)}.tickets WHERE id = $1`,
        [seed.id],
      )
      row = rows[0]
      if (row?.status === "open") break
      await Bun.sleep(100)
    }
    expect(row?.status).toBe("open")
    expect(row?.followup_at).toBeNull()

    const labels = await env.db.sql.unsafe(
      `SELECT action_label FROM ${ks(env)}.timeline_entries
         WHERE app = 'tickets' AND entity_type = 'ticket' AND entity_id = $1`,
      [seed.id],
    )
    expect(labels.some((l: any) => l.action_label === "followup_due")).toBe(true)

    // The job run woke the app: its stored list is recomputed by the refresh
    // queued for the end of the wake's interval (REFRESH_MIN_INTERVAL_MS, 15 s).
    const stillDue = async () =>
      (
        (await api(url, "/api/attention-items", { token: writeUser.token })).body.data?.items ?? []
      ).filter((i: any) => i.entityId === seed.id && i.kind === "followup_due").length > 0
    const clearBy = Date.now() + 25_000
    while ((await stillDue()) && Date.now() < clearBy) await Bun.sleep(100)
    expect(await stillDue()).toBe(false)
  }, 45_000)

  // ─── S19: Categories CRUD with depth limit ───

  it("S19: categories CRUD enforces depth and archived behavior", async () => {
    const billing = (
      await api(url, "/api/apps/tools/tickets:categories.create", {
        method: "POST",
        token: categoriesAdmin.token,
        body: { params: { name: "Billing" } },
      })
    ).body.data as any
    expect(billing.id).toBeDefined()

    const refunds = (
      await api(url, "/api/apps/tools/tickets:categories.create", {
        method: "POST",
        token: categoriesAdmin.token,
        body: { params: { name: "Refunds", parentId: billing.id } },
      })
    ).body.data as any
    expect(refunds.id).toBeDefined()

    const annual = await api(url, "/api/apps/tools/tickets:categories.create", {
      method: "POST",
      token: categoriesAdmin.token,
      body: { params: { name: "Annual", parentId: refunds.id } },
    })
    expect(annual.body.error?.code).toBe("category_depth_limit")

    await api(url, "/api/apps/tools/tickets:categories.archive", {
      method: "POST",
      token: categoriesAdmin.token,
      body: { params: { id: billing.id } },
    })

    const list = (
      await api(url, "/api/apps/tools/tickets:categories.list", {
        method: "POST",
        token: categoriesAdmin.token,
        body: { params: {} },
      })
    ).body.data as any[]
    const billingRow = list.find((c) => c.id === billing.id)
    expect(billingRow).toBeTruthy()
    expect(billingRow.archived_at ?? billingRow.archivedAt).not.toBeNull()
  })

  // ─── S20: Inboxes admin enforces unique email_address ───

  it("S20: inboxes.create enforces unique email_address", async () => {
    // The account's identifier must MATCH the inbox emailAddress (the
    // inbox_account_email_mismatch contract), and the seeded row is ORG-owned
    // (a shared mailbox) — invisible to caller RLS by policy, resolved through
    // inboxesCreate's privileged org-scoped fallback. This test therefore also
    // pins that an inboxes admin can bind a SHARED mailbox at all.
    const acct = await seedConnectedAccount(env, {
      orgId: world.org.id,
      email: "support-s20@acme.test",
      createdBy: world.admin.id,
    })

    const ok = await api(url, "/api/_test/agent-tool-call", {
      method: "POST",
      token: inboxesAdmin.token,
      body: {
        toolName: "tickets:inboxes.create",
        params: {
          name: "Support",
          emailAddress: "support-s20@acme.test",
          connectedAccountId: acct.id,
        },
      },
    })
    // Creating an inbox is a gated settings change: the inboxes admin's agent
    // proposes it (a person's own call never parks an approval; without the
    // approve scope it is refused), it parks for an approver, and the uniqueness
    // check runs when the approved call executes.
    expect(ok.status).toBe(200)
    const okRequest = ok.body?.data?.blocked?.approvalRequestId as string
    expect(okRequest).toBeTruthy()
    expect((await decide(url, world.admin.token, okRequest, { decision: "approve" })).status).toBe(
      200,
    )

    const dupe = await api(url, "/api/_test/agent-tool-call", {
      method: "POST",
      token: inboxesAdmin.token,
      body: {
        toolName: "tickets:inboxes.create",
        params: {
          name: "Support 2",
          emailAddress: "support-s20@acme.test",
          connectedAccountId: acct.id,
        },
      },
    })
    const dupeRequest = dupe.body?.data?.blocked?.approvalRequestId as string
    expect(dupeRequest).toBeTruthy()
    const dupeDecision = await decide(url, world.admin.token, dupeRequest, { decision: "approve" })
    expect(dupeDecision.status).not.toBe(200)
    expect(JSON.stringify(dupeDecision.body)).toContain("inbox_email_taken")
    const inboxes = await env.db.sql.unsafe(
      `SELECT id FROM ${ts(env)}.inboxes WHERE lower(email_address) = 'support-s20@acme.test'`,
    )
    expect(inboxes.length).toBe(1)
  })

  // ─── S21: Contact merge subscriber relinks tickets ───

  it("S21: contact merge subscriber relinks tickets and emits ticket:update", async () => {
    const contactA = await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.contacts (id, org_id, handle, email, name, external_ids, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Alice S21', '{}'::jsonb, $4)
       RETURNING id`,
      [
        world.org.id,
        `@contact-s21a-${Date.now()}`,
        `s21a-${Date.now()}@test.local`,
        world.admin.id,
      ],
    )
    const contactB = await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.contacts (id, org_id, handle, email, name, external_ids, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Bob S21', '{}'::jsonb, $4)
       RETURNING id`,
      [
        world.org.id,
        `@contact-s21b-${Date.now()}`,
        `s21b-${Date.now()}@test.local`,
        world.admin.id,
      ],
    )

    const t1 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S21-1",
      contactId: contactA[0].id,
      team: "support-eu",
    })
    const t2 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S21-2",
      contactId: contactA[0].id,
      team: "support-eu",
    })

    const merger = await makeActor(url, env, world, {
      name: "Contact Merger",
      scopes: [
        "kernel:contacts:read",
        "kernel:contacts:write",
        "tickets:tickets:read",
        "tickets:tickets:write",
      ],
      dimensions: { "*": ["*"] },
    })

    const wsClient = await connectWs(url, writeUser.token)

    const merge = await api(url, "/api/contacts/merge", {
      method: "POST",
      token: merger.token,
      body: {
        sourceId: contactA[0].id,
        targetId: contactB[0].id,
        resolvedFields: { name: "Bob S21" },
      },
    })
    expect(merge.status).toBe(200)

    const deadline = Date.now() + 5000
    let allRelinked = false
    while (Date.now() < deadline) {
      const rows = await env.db.sql.unsafe(
        `SELECT id, contact_id FROM ${ts(env)}.tickets WHERE id = ANY($1)`,
        [[t1.id, t2.id]],
      )
      if (rows.every((r: any) => r.contact_id === contactB[0].id)) {
        allRelinked = true
        break
      }
      await Bun.sleep(100)
    }
    expect(allRelinked).toBe(true)

    // Poll the WS for the 2 ticket:update events instead of a single fixed-sleep
    // sample. The relink db_update (cycle 1) that `allRelinked` observes commits
    // BEFORE the ticket:update frames are delivered: the contact-merge subscriber
    // runs fire-and-forget, its emitUpdate queues new outbox rows, and only a
    // LATER outbox poll (100ms) + Redis fan-out lands them on the WS client. Under
    // parallel e2e load that two-cycle round-trip routinely overruns a fixed 500ms
    // window, which never retries → 0 events captured. Wait up to 8s for them
    // (mirrors the S10 fix above; comfortably inside the 20s test timeout).
    const isUpdate = (m: any) =>
      m?.payload?.app === "tickets" &&
      m?.payload?.entity === "ticket" &&
      m?.payload?.action === "update" &&
      (m?.payload?.entityId === t1.id || m?.payload?.entityId === t2.id)
    const evtDeadline = Date.now() + 8000
    let updates = wsClient.messages.filter(isUpdate)
    while (updates.length < 2 && Date.now() < evtDeadline) {
      await Bun.sleep(100)
      updates = wsClient.messages.filter(isUpdate)
    }
    expect(updates.length).toBeGreaterThanOrEqual(2)

    wsClient.close()
  }, 20_000)
})

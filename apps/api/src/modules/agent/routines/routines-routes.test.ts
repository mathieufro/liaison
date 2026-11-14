// SPDX-License-Identifier: FSL-1.1-ALv2
// T4.4 — Routine CRUD routes + run-now + run-history.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Queue } from "bullmq"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { routineRuns, routines as routinesTbl } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { deleteDeclaredEmits, setDeclaredEmits } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8200-00000000b001"
const ALICE_ID = "00000000-0000-4000-8200-00000000b002"
const BOB_ID = "00000000-0000-4000-8200-00000000b003"
const ADMIN_ID = "00000000-0000-4000-8200-00000000b004"

const ALICE_SCOPES = [
  "kernel:routines:read",
  "kernel:routines:write",
  // The routine creator must already hold the scopes it declares for the routine
  // (scopesAreSubset check). We give Alice a couple of common ones.
  "kernel:threads:read",
  "kernel:threads:write",
]

const BOB_SCOPES = ALICE_SCOPES
const ADMIN_SCOPES = [...ALICE_SCOPES, "kernel:apps:admin"]
// A15's allow branch for a role/system owner: kernel:agents:admin, plus scopes
// that cover the owning agent's ceiling.
const AGENTS_ADMIN_SCOPES = [...ALICE_SCOPES, "kernel:agents:admin"]

/**
 * A session token as sign-in mints it: the scopes the test gives the person
 * plus what every member of the org holds (manifest `everyMemberScopes`, which
 * the person's personal agent ceiling also carries). A token without them
 * cannot write a routine of their own agent: the routines UPDATE policy
 * requires the actor's scopes to cover that agent's ceiling.
 */
async function tokenFor(userId: string, scopes: string[]): Promise<string> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const held = await withPrivilegedDb(ORG_ID, "rt-token-scopes", (tx) =>
    loadEffectivePermissions(tx, userId, ORG_ID),
  )
  return signAccessToken(
    {
      userId,
      orgId: ORG_ID,
      name: `User ${userId.slice(-4)}`,
      authVersion: 1,
      permissionVersion: 1,
      scopes: [...new Set([...scopes, ...held.scopes])],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

describe("routines-routes — /api/agent/routines", () => {
  let aliceToken: string
  let bobToken: string
  let adminToken: string
  let agentsAdminToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'RoutineRouteOrg', 'routine-route-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ALICE_ID}, ${ORG_ID}, 'alice-routines@test.com', 'Alice Routines') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${BOB_ID}, ${ORG_ID}, 'bob-routines@test.com', 'Bob Routines') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_ID}, ${ORG_ID}, 'admin-routines@test.com', 'Admin Routines') ON CONFLICT (id) DO NOTHING`
    // The org's apps (and so its every-member scopes) as its first request sets them up.
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(ORG_ID)
    aliceToken = await tokenFor(ALICE_ID, ALICE_SCOPES)
    bobToken = await tokenFor(BOB_ID, BOB_SCOPES)
    adminToken = await tokenFor(ADMIN_ID, ADMIN_SCOPES)
    agentsAdminToken = await tokenFor(ADMIN_ID, AGENTS_ADMIN_SCOPES)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
    // A created routine opens its owner's chat with their personal agent (where
    // it posts its runs): those conversations go before their members do.
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
  })

  // ----- POST / -------------------------------------------------------------
  describe("POST /api/agent/routines", () => {
    it("validates cron — rejects malformed cron with 400", async () => {
      const res = await app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-cron",
          description: "bad",
          cron: "not a cron expression",
          timezone: "America/Toronto",
          prompt: "say hi",
          scopes: [],
        }),
      })
      expect(res.status).toBe(400)
    })

    it("validates timezone — rejects unknown IANA tz with 400", async () => {
      const res = await app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-tz",
          description: "bad",
          cron: "* * * * *",
          timezone: "Mars/Olympus",
          prompt: "say hi",
          scopes: [],
        }),
      })
      expect(res.status).toBe(400)
    })

    it("scope-subset: OMITS a declared scope outside the caller's scopes (intersect-and-omit, no escalation)", async () => {
      // Policy (l219): a routine can never exceed its creator's scopes, but an over-request is no longer
      // hard-rejected — it is intersected to the grantable subset and the omitted scope is surfaced as a
      // scope request, so the routine is created least-privilege. The over-requested kernel:users:admin
      // is dropped (Alice does not hold it); the routine still creates (201) with the granted subset.
      const res = await app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "scope-escalation",
          description: "Try to grant the routine kernel:users:admin",
          cron: "0 9 * * *",
          timezone: "America/Toronto",
          prompt: "say hi",
          scopes: ["kernel:users:admin"],
        }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { data: { scopes: string[] } }
      // The escalating scope is NOT granted (intersected away) — no privilege escalation.
      expect(body.data.scopes).not.toContain("kernel:users:admin")
      // ...and it is surfaced to Alice as a pending scope request (the REST path too).
      const [req] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.scope_requests
         WHERE org_id = ${ORG_ID} AND requested_by = ${ALICE_ID}
           AND 'kernel:users:admin' = ANY(requested_scopes) AND status = 'pending'`
      expect(req.n).toBe(1)
    })

    it("on success: creates row + upserts a 'routine:<id>' scheduler", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "daily-digest",
            description: "Daily digest routine",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.name).toBe("daily-digest")
        expect(body.data.ownerUserId).toBe(ALICE_ID)

        expect(upsert).toHaveBeenCalledWith(
          `routine:${body.data.id}`,
          { pattern: "0 9 * * *", tz: "America/Toronto" },
          expect.objectContaining({ name: "routine-tick" }),
        )
      } finally {
        upsert.mockRestore()
      }
    })

    it("POST /agent/routines with ownerAgentId creates for that agent under A15", async () => {
      // A15's allow branch: kernel:agents:admin for a role owner, plus the
      // caller's own scopes covering that agent's ceiling (empty here). Before
      // T32b the key was dropped and the routine landed on the caller's own
      // personal agent with the same 201.
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      const [roleAgent] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@a15-routine-owner', 'A15 Routine Owner', '[]'::jsonb) RETURNING id`
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${agentsAdminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "a15-owned-routine",
            description: "Authored for the role agent",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
            ownerAgentId: roleAgent.id,
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.ownerAgentId).toBe(roleAgent.id)

        // The member without kernel:agents:admin gets the explicit refusal.
        const refused = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "a15-refused-routine",
            description: "Aimed at a role agent",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
            ownerAgentId: roleAgent.id,
          }),
        })
        expect(refused.status).toBe(403)
        const refusedBody: any = await refused.json()
        expect(refusedBody.error.code).toBe("agent_write_forbidden")
      } finally {
        await sql`DELETE FROM kernel.routines WHERE owner_agent_id = ${roleAgent.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${roleAgent.id}`
        upsert.mockRestore()
      }
    })

    it("a routine for a personal agent still needs the full ceiling", async () => {
      // P4c FX-F4. The ceiling rule survives where it belongs (spec-agents.md
      // D16): a tick executes unfloored at the owning agent's ceiling, so the
      // author must already hold every scope in it, OWNER OR NOT. Alice owns
      // this agent and still cannot schedule for it while it can reach further
      // than she can.
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      const [own] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${ORG_ID}, 'personal', '@alice-ceiling-routine', 'Alice', ${ALICE_ID},
                '["shopify:orders:read"]'::jsonb) RETURNING id`
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "fx-f4-ceiling-routine",
            description: "Scheduled beyond the author's own reach",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
            ownerAgentId: own.id,
          }),
        })
        expect(res.status).toBe(403)
        const body: any = await res.json()
        expect(body.error.code).toBe("agent_write_forbidden")

        const rows = await sql`SELECT id FROM kernel.routines WHERE name = 'fx-f4-ceiling-routine'`
        expect(rows).toHaveLength(0)
      } finally {
        await sql`DELETE FROM kernel.agents WHERE id = ${own.id}`
        upsert.mockRestore()
      }
    })

    it("the refusal names the real reason", async () => {
      // P4c FX-F4. "Only the person an agent belongs to can author its skills
      // and routines" is a lie told to the person it belongs to: an owner
      // refused on ceiling coverage was sent to find an owner they already are.
      // Two causes, two sentences, and the ceiling one names what is missing.
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      const [own] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${ORG_ID}, 'personal', '@alice-reason', 'Alice', ${ALICE_ID},
                '["shopify:orders:read"]'::jsonb) RETURNING id`
      const [someone] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@fx-f4-role', 'FX F4 Role', '[]'::jsonb) RETURNING id`
      try {
        const post = async (ownerAgentId: string, name: string) => {
          const res = await app.request("/api/agent/routines", {
            method: "POST",
            headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              description: "Refusal shape",
              cron: "0 9 * * *",
              timezone: "America/Toronto",
              prompt: "summarize today",
              scopes: [],
              ownerAgentId,
            }),
          })
          expect(res.status).toBe(403)
          const body: any = await res.json()
          expect(body.error.code).toBe("agent_write_forbidden")
          return body.error.message as string
        }

        const onCeiling = await post(own.id, "fx-f4-reason-ceiling")
        expect(onCeiling).toContain("shopify:orders:read")
        expect(onCeiling).not.toContain("Only the person an agent belongs to")

        const onOwnership = await post(someone.id, "fx-f4-reason-ownership")
        expect(onOwnership).toContain("kernel:agents:admin")
      } finally {
        await sql`DELETE FROM kernel.agents WHERE id IN (${own.id}, ${someone.id})`
        upsert.mockRestore()
      }
    })

    it("accepts + persists agentModelId + agentReasoningLevel", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "model-pinned-digest",
            description: "Digest pinned to a specific model",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
            agentModelId: "gemini-flash-latest",
            agentReasoningLevel: "medium",
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.agentModelId).toBe("gemini-flash-latest")
        expect(body.data.agentReasoningLevel).toBe("medium")
      } finally {
        upsert.mockRestore()
      }
    })

    it("S17: accepts + persists tokenBudget + hardTokenLimit (null when omitted)", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "budgeted-digest",
            description: "Digest with a token budget",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
            tokenBudget: 20000,
            hardTokenLimit: 50000,
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.tokenBudget).toBe(20000)
        expect(body.data.hardTokenLimit).toBe(50000)
        const plain = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "unbudgeted-digest",
            description: "No budget",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
          }),
        })
        const plainBody: any = await plain.json()
        expect(plainBody.data.tokenBudget).toBeNull()
        expect(plainBody.data.hardTokenLimit).toBeNull()
        // PUT null clears; a non-positive limit is refused.
        const cleared = await app.request(`/api/agent/routines/${body.data.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tokenBudget: null, hardTokenLimit: 60000 }),
        })
        expect(cleared.status).toBe(200)
        const clearedBody: any = await cleared.json()
        expect(clearedBody.data.tokenBudget).toBeNull()
        expect(clearedBody.data.hardTokenLimit).toBe(60000)
        const bad = await app.request(`/api/agent/routines/${body.data.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ hardTokenLimit: 0 }),
        })
        expect(bad.status).toBe(400)
      } finally {
        upsert.mockRestore()
      }
    })

    it("rejects an invalid agentReasoningLevel with 400", async () => {
      const res = await app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-reasoning",
          description: "bad",
          cron: "0 9 * * *",
          timezone: "America/Toronto",
          prompt: "say hi",
          scopes: [],
          agentReasoningLevel: "ultra",
        }),
      })
      expect(res.status).toBe(400)
    })

    it("defaults agentModelId + agentReasoningLevel to null when omitted", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "no-model-pin",
            description: "No pin",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "summarize today",
            scopes: [],
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.agentModelId).toBeNull()
        expect(body.data.agentReasoningLevel).toBeNull()
      } finally {
        upsert.mockRestore()
      }
    })
  })

  // ----- PUT /:id -----------------------------------------------------------
  // ----- D20: explicit routine scopes ----------------------------------------
  describe("explicit routine scopes (D20)", () => {
    it("GET /scope-options lists the scopes the caller holds, with a description, and nothing else", async () => {
      const res = await app.request("/api/agent/routines/scope-options", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: Array<{ scope: string; app: string; description?: string }>
      }
      const scopes = body.data.map((e) => e.scope)
      expect(scopes).toContain("kernel:threads:read")
      expect(scopes).toContain("kernel:threads:write")
      expect(scopes).not.toContain("kernel:users:admin")
      expect(scopes).not.toContain("kernel")
      expect(body.data.find((e) => e.scope === "kernel:threads:read")?.description).toBeTruthy()
    })

    it("a routine saved with a prompt that names returns and no scope holds no scope", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "returns-digest",
            description: "Weekly returns",
            cron: "0 9 * * 1",
            timezone: "Europe/Paris",
            prompt: "List the inbound returns and ask @sales about the late ones.",
            scopes: [],
          }),
        })
        expect(res.status).toBe(201)
        const body = (await res.json()) as { data: { scopes: string[] } }
        expect(body.data.scopes).toEqual([])
      } finally {
        upsert.mockRestore()
      }
    })

    it("PUT with scopes adds one and removes one, and the change is persisted", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-d20-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "d20-picker",
            description: "Initial",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: ["kernel:threads:read"],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const res = await app.request(`/api/agent/routines/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["kernel:threads:write"] }),
      })
      expect(res.status).toBe(200)
      const [row] = await withPrivilegedDb(ORG_ID, "rt-d20-read", (tx) =>
        tx.select().from(routinesTbl).where(eq(routinesTbl.id, id)),
      )
      expect(row.scopes).toEqual(["kernel:threads:write"])
    })
  })

  describe("PUT /api/agent/routines/:id", () => {
    it("changing cron re-upserts the scheduler with the new pattern + tz", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-put-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "to-update",
            description: "Initial",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id

      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request(`/api/agent/routines/${id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ cron: "*/15 * * * *", timezone: "UTC" }),
        })
        expect(res.status).toBe(200)
        expect(upsert).toHaveBeenCalledWith(
          `routine:${id}`,
          { pattern: "*/15 * * * *", tz: "UTC" },
          expect.objectContaining({ name: "routine-tick" }),
        )
      } finally {
        upsert.mockRestore()
      }
    })

    it("PUT accepts + persists agentModelId + agentReasoningLevel", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-put-model-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "to-pin",
            description: "Initial",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const res = await app.request(`/api/agent/routines/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agentModelId: "gemini-flash-latest",
          agentReasoningLevel: "medium",
        }),
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.agentModelId).toBe("gemini-flash-latest")
      expect(body.data.agentReasoningLevel).toBe("medium")
    })

    // P6-fix10: the web editor saves a node routine through this route, whose
    // handler context carries no RLS client; the guardrail note reads the
    // routine agent's model in the caller's own RLS transaction.
    it("PUT of a node routine owned by an agent answers 200 and persists", async () => {
      // Alice's personal agent (an earlier create may have made it already).
      await sql`INSERT INTO kernel.agents (org_id, kind, owner_user_id, handle, display_name)
        VALUES (${ORG_ID}, 'personal', ${ALICE_ID}, '@alice-routines', 'Alice agent')
        ON CONFLICT DO NOTHING`
      const [agent] = await sql<
        { id: string }[]
      >`UPDATE kernel.agents SET model_preference = 'claude-opus-5-5'
        WHERE org_id = ${ORG_ID} AND kind = 'personal' AND owner_user_id = ${ALICE_ID} RETURNING id`
      const agentId = agent!.id
      const created = await withPrivilegedDb(ORG_ID, "rt-put-node-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            ownerAgentId: agentId,
            name: "to-node",
            description: "Initial",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request(`/api/agent/routines/${id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ runsOn: "node", agentModelId: null }),
        })
        expect(res.status).toBe(200)
        const body: any = await res.json()
        expect(body.data.runsOn).toBe("node")
      } finally {
        upsert.mockRestore()
      }
    })

    it("PUT rejects an invalid agentReasoningLevel with 400", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-put-bad-reasoning-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "bad-reasoning-update",
            description: "Initial",
            cron: "0 9 * * *",
            timezone: "America/Toronto",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const res = await app.request(`/api/agent/routines/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agentReasoningLevel: "ultra" }),
      })
      expect(res.status).toBe(400)
    })

    it("PUT with only `enabled:false` does NOT touch the scheduler", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-enabled-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "no-touch",
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const res = await app.request(`/api/agent/routines/${id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
        expect(res.status).toBe(200)
        expect(upsert).not.toHaveBeenCalled()
      } finally {
        upsert.mockRestore()
      }
    })
  })

  // ----- DELETE /:id -------------------------------------------------------
  describe("DELETE /api/agent/routines/:id", () => {
    it("calls queue.removeJobScheduler and returns 204", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-del-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "del-me",
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id

      const remove = spyOn(Queue.prototype, "removeJobScheduler").mockResolvedValue(true as any)
      try {
        const res = await app.request(`/api/agent/routines/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
        expect(res.status).toBe(204)
        expect(remove).toHaveBeenCalledWith(`routine:${id}`)
      } finally {
        remove.mockRestore()
      }
    })
  })

  describe("an app-run routine (the identity an app setting acts through)", () => {
    it("is neither handed to an agent nor deleted on its own", async () => {
      const [created] = await withPrivilegedDb(ORG_ID, "rt-app-run-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "app-run",
            description: "x",
            cron: "17 * * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            enabled: false,
            sourceKind: "kernel",
            templateKey: "app-run:test-job",
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created!.id
      const reassign = await app.request(`/api/agent/routines/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAgentId: crypto.randomUUID() }),
      })
      expect(reassign.status).toBe(409)
      expect(JSON.stringify(await reassign.json())).toContain("run by an app setting")
      const del = await app.request(`/api/agent/routines/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(del.status).toBe(409)
      const [still] = await withPrivilegedDb(ORG_ID, "rt-app-run-check", (tx) =>
        tx
          .select({ owner: routinesTbl.ownerUserId, agent: routinesTbl.ownerAgentId })
          .from(routinesTbl)
          .where(eq(routinesTbl.id, id)),
      )
      expect(still).toEqual({ owner: ALICE_ID, agent: null })
    })
  })

  // ----- POST /:id/run-now -------------------------------------------------
  describe("POST /api/agent/routines/:id/run-now", () => {
    it("404 when the routine doesn't exist", async () => {
      const res = await app.request(
        "/api/agent/routines/00000000-0000-0000-0000-000000000099/run-now",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}` },
        },
      )
      expect(res.status).toBe(404)
    })

    it("enqueues with an idempotent jobId and returns 202", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-runnow-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "run-now",
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id

      // Pre-register the worker so enqueueAppJob's M-13 handler check passes.
      const { registerJobWorker } = await import("~/infra/jobs/jobs")
      registerJobWorker("kernel", "routine-tick", async () => {})

      const addSpy = spyOn(Queue.prototype, "addBulk").mockImplementation(
        // Every enqueue is one addBulk (infra/jobs/fairness.ts fairEnqueue).
        async (jobs) =>
          jobs.map((j, i) => ({
            id: j.opts?.jobId ?? `stub-${i}`,
            name: j.name,
            data: j.data,
          })) as never,
      )
      try {
        const res = await app.request(`/api/agent/routines/${id}/run-now`, {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
        expect(res.status).toBe(202)
        const body: any = await res.json()
        expect(body.data.queued).toBe(true)
        expect(addSpy).toHaveBeenCalled()
        // One addBulk with one entry: { name, data, opts }.
        const entry = addSpy.mock.calls[0]![0][0]!
        expect(entry.name).toBe("routine-tick")
        expect((entry.data as any).routineId).toBe(id)
        expect(entry.opts?.jobId).toBeDefined()
      } finally {
        addSpy.mockRestore()
      }
    })
  })

  describe("POST /api/agent/routines/:id/run-now on a routine that cannot run (walk D20)", () => {
    for (const [label, values, words] of [
      ["switched off", { enabled: false }, "switched off"],
      ["paused by its owner", { status: "paused_user" }, "paused"],
    ] as const) {
      it(`refuses in words when the routine is ${label}, and enqueues nothing`, async () => {
        const created = await withPrivilegedDb(ORG_ID, "rt-runnow-off-seed", (tx) =>
          tx
            .insert(routinesTbl)
            .values({
              orgId: ORG_ID,
              ownerUserId: ALICE_ID,
              name: `run-now-${label}`,
              description: "x",
              cron: "0 9 * * *",
              timezone: "UTC",
              prompt: "p",
              scopes: [],
              createdByUserId: ALICE_ID,
              createdByActorType: "user",
              ...values,
            })
            .returning(),
        )
        const addSpy = spyOn(Queue.prototype, "addBulk").mockImplementation(
          // Every enqueue is one addBulk (infra/jobs/fairness.ts fairEnqueue).
          async (jobs) =>
            jobs.map((j, i) => ({
              id: j.opts?.jobId ?? `stub-${i}`,
              name: j.name,
              data: j.data,
            })) as never,
        )
        try {
          const res = await app.request(`/api/agent/routines/${created[0].id}/run-now`, {
            method: "POST",
            headers: { Authorization: `Bearer ${aliceToken}` },
          })
          expect(res.status).toBe(409)
          expect(await res.text()).toContain(words)
          expect(addSpy).not.toHaveBeenCalled()
        } finally {
          addSpy.mockRestore()
        }
      })
    }
  })

  // ----- GET /:id/runs -----------------------------------------------------
  describe("GET /api/agent/routines/:id/runs", () => {
    it("whoever may read a shared routine may read its runs; a private one stays 404 (walk)", async () => {
      // The agent's page lists a role agent's routines to anyone holding the read scope, then
      // asked for the runs of the row it showed and got "Routine not found" on every visit.
      const [{ id: agentId }] = await sql<{ id: string }[]>`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@runs-role', 'Runs Role', '["*"]'::jsonb) RETURNING id`
      const [shared, personal] = await withPrivilegedDb(ORG_ID, "rt-runs-visible-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values(
            (["shared", "personal"] as const).map((visibility) => ({
              orgId: ORG_ID,
              ownerUserId: ALICE_ID,
              ownerAgentId: visibility === "shared" ? agentId : null,
              name: `runs-${visibility}`,
              description: "x",
              cron: "0 9 * * *",
              timezone: "UTC",
              prompt: "p",
              scopes: [],
              visibility,
              createdByUserId: ALICE_ID,
              createdByActorType: "user" as const,
            })),
          )
          .returning(),
      )
      await withPrivilegedDb(ORG_ID, "rt-runs-visible-rows", (tx) =>
        tx.insert(routineRuns).values({
          orgId: ORG_ID,
          routineId: shared.id,
          ranAt: new Date(),
          status: "succeeded",
        }),
      )
      const headers = { Authorization: `Bearer ${bobToken}` }

      const res = await app.request(`/api/agent/routines/${shared.id}/runs`, { headers })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1)

      const hidden = await app.request(`/api/agent/routines/${personal.id}/runs`, { headers })
      expect(hidden.status).toBe(404)
    })

    it("returns up to 50 rows ordered by ranAt DESC", async () => {
      const created = await withPrivilegedDb(ORG_ID, "rt-runs-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "runs",
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id

      // Seed three runs.
      await withPrivilegedDb(ORG_ID, "rt-runs-seed-rows", (tx) =>
        tx.insert(routineRuns).values([
          {
            orgId: ORG_ID,
            routineId: id,
            ranAt: new Date(Date.now() - 3000),
            status: "succeeded",
            durationMs: 100,
          },
          {
            orgId: ORG_ID,
            routineId: id,
            ranAt: new Date(Date.now() - 2000),
            status: "failed",
            error: "boom",
          },
          {
            orgId: ORG_ID,
            routineId: id,
            ranAt: new Date(Date.now() - 1000),
            status: "succeeded",
            durationMs: 200,
          },
        ]),
      )

      const res = await app.request(`/api/agent/routines/${id}/runs`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.length).toBe(3)
      // Newest first.
      const times = body.data.map((r: any) => new Date(r.ranAt).getTime())
      expect(times[0]).toBeGreaterThan(times[1])
      expect(times[1]).toBeGreaterThan(times[2])
    })

    it("pages newest first: limit caps a page, before returns the runs older than a run", async () => {
      const [created] = await withPrivilegedDb(ORG_ID, "rt-runs-page-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId: ALICE_ID,
            name: "paged",
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const now = Date.now()
      await withPrivilegedDb(ORG_ID, "rt-runs-page-rows", (tx) =>
        tx.insert(routineRuns).values(
          [5, 4, 3].map((s) => ({
            orgId: ORG_ID,
            routineId: created.id,
            ranAt: new Date(now - s * 1000),
            status: "succeeded",
            durationMs: s * 100,
          })),
        ),
      )
      const headers = { Authorization: `Bearer ${aliceToken}` }
      const page = async (q: string) => {
        const res = await app.request(`/api/agent/routines/${created.id}/runs${q}`, { headers })
        expect(res.status).toBe(200)
        return ((await res.json()) as any).data as Array<{ id: string; durationMs: number }>
      }
      const first = await page("?limit=2")
      expect(first.map((r) => r.durationMs)).toEqual([300, 400])
      const older = await page(`?limit=2&before=${first[1].id}`)
      expect(older.map((r) => r.durationMs)).toEqual([500])
      const bad = await app.request(`/api/agent/routines/${created.id}/runs?before=nope`, {
        headers,
      })
      expect(bad.status).toBe(400)
    })
  })

  // ----- GET /latest-brief (D21) ---------------------------------------------
  // Home's Agents > "Morning brief": the caller's own morning-brief routine and
  // where its last output is. Someone else's brief never answers.
  describe("GET /api/agent/routines/latest-brief", () => {
    const brief = (ownerUserId: string, name: string, lastRunAt: Date | null) =>
      withPrivilegedDb(ORG_ID, "rt-brief-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId,
            name,
            description: "x",
            cron: "0 8 * * 1-5",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            templateKey: "morning-brief",
            sourceKind: "kernel",
            lastRunAt,
            lastRunStatus: lastRunAt ? "succeeded" : null,
            createdByUserId: ownerUserId,
            createdByActorType: "user",
          })
          .returning(),
      )

    it("answers null when the caller has no morning brief", async () => {
      await brief(BOB_ID, "bob-brief", new Date())
      const res = await app.request("/api/agent/routines/latest-brief", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).data).toBeNull()
    })

    it("answers the caller's brief with its last run", async () => {
      const ranAt = new Date(Date.now() - 60_000)
      const [row] = await brief(ALICE_ID, "alice-brief", ranAt)
      const res = await app.request("/api/agent/routines/latest-brief", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const data = ((await res.json()) as any).data
      expect(data).toMatchObject({
        routineId: row?.id,
        name: "alice-brief",
        lastRunStatus: "succeeded",
        outputThreadId: null,
        messageId: null,
        // No brief written yet: no brief time, whatever the last run.
        messageAt: null,
      })
      expect(new Date(data.lastRunAt).getTime()).toBe(ranAt.getTime())
    })
  })

  // ----- GET /api/agent/routines ------------------------------------------
  describe("GET /api/agent/routines", () => {
    it("returns only the caller's routines", async () => {
      await withPrivilegedDb(ORG_ID, "rt-list-seed", (tx) =>
        tx.insert(routinesTbl).values({
          orgId: ORG_ID,
          ownerUserId: ALICE_ID,
          name: "alice-only",
          description: "x",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "p",
          scopes: [],
          createdByUserId: ALICE_ID,
          createdByActorType: "user",
        }),
      )
      const res = await app.request("/api/agent/routines", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.some((r: any) => r.name === "alice-only")).toBe(true)
    })
  })

  describe("GET /api/agent/routines?includeLastRun=1", () => {
    it("adds each routine's latest run with its steps' states only, in one read; off by default", async () => {
      const [ran, never] = await withPrivilegedDb(ORG_ID, "rt-last-run-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values(
            ["last-run-ran", "last-run-never"].map((name) => ({
              orgId: ORG_ID,
              ownerUserId: ALICE_ID,
              name,
              description: "x",
              cron: "0 9 * * *",
              timezone: "UTC",
              prompt: "p",
              scopes: [],
              createdByUserId: ALICE_ID,
              createdByActorType: "user" as const,
            })),
          )
          .returning(),
      )
      await withPrivilegedDb(ORG_ID, "rt-last-run-rows", (tx) =>
        tx.insert(routineRuns).values([
          {
            orgId: ORG_ID,
            routineId: ran!.id,
            ranAt: new Date(Date.now() - 5000),
            status: "failed",
            error: "older",
          },
          {
            orgId: ORG_ID,
            routineId: ran!.id,
            ranAt: new Date(Date.now() - 1000),
            status: "waiting",
            error: "secret detail",
            steps: [
              {
                id: "a",
                type: "action",
                state: "done",
                startedAt: null,
                endedAt: "2026-11-13T09:00:00.000Z",
                note: "private note",
                output: { x: 1 },
              },
              {
                id: "b",
                type: "wait",
                state: "waiting",
                startedAt: null,
                endedAt: null,
                note: null,
              },
            ],
          },
        ]),
      )
      const headers = { Authorization: `Bearer ${aliceToken}` }
      const plain: any = await (await app.request("/api/agent/routines", { headers })).json()
      expect(plain.data.find((r: any) => r.id === ran!.id)).not.toHaveProperty("lastRun")

      const res = await app.request("/api/agent/routines?includeLastRun=1", { headers })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      const row = body.data.find((r: any) => r.id === ran!.id)
      expect(row.lastRun.status).toBe("waiting")
      expect(row.lastRun.steps).toEqual([
        {
          id: "a",
          type: "action",
          state: "done",
          startedAt: null,
          endedAt: "2026-11-13T09:00:00.000Z",
        },
        { id: "b", type: "wait", state: "waiting", startedAt: null, endedAt: null },
      ])
      expect(JSON.stringify(row.lastRun)).not.toContain("secret detail")
      expect(JSON.stringify(row.lastRun)).not.toContain("private note")
      expect(body.data.find((r: any) => r.id === never!.id).lastRun).toBeNull()
    })
  })

  // ----- PUT /:id/node-placement (P2-T04, L26) -------------------------------
  describe("PUT /api/agent/routines/:id/node-placement", () => {
    async function seedNodeRoutine(ownerUserId: string): Promise<string> {
      const [agent] = await sql<{ id: string }[]>`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
        VALUES (${ORG_ID}, 'personal', ${`@np-${crypto.randomUUID().slice(0, 8)}`}, 'Personal',
                '[]'::jsonb, ${ownerUserId})
        RETURNING id`
      const [row] = await withPrivilegedDb(ORG_ID, "rt-placement-seed", (tx) =>
        tx
          .insert(routinesTbl)
          .values({
            orgId: ORG_ID,
            ownerUserId,
            ownerAgentId: agent.id,
            name: `node-${crypto.randomUUID().slice(0, 8)}`,
            description: "x",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            scopes: [],
            runsOn: "node",
            createdByUserId: ownerUserId,
            createdByActorType: "user",
          })
          .returning({ id: routinesTbl.id }),
      )
      return row.id
    }

    const put = (id: string, token: string, body: unknown) =>
      app.request(`/api/agent/routines/${id}/node-placement`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

    async function listed(id: string) {
      const res = await app.request("/api/agent/routines", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      const body: any = await res.json()
      return body.data.find((r: any) => r.id === id)
    }

    it("the owner sets folder and model and GET returns them", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      const res = await put(id, aliceToken, { folder: "my-repo", model: "claude-haiku-4-5" })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data).toMatchObject({
        id,
        folder: "my-repo",
        repo: null,
        model: "claude-haiku-4-5",
      })
      expect(await listed(id)).toMatchObject({
        folder: "my-repo",
        repo: null,
        model: "claude-haiku-4-5",
      })
    })

    it("a repo that is not https or ssh is 400; an ssh or https one is kept and clears the folder", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      for (const repo of [
        "/Users/someone/code",
        "file:///tmp/x",
        "ext::sh -c x",
        "--upload-pack=x",
        "http://h/r.git",
      ]) {
        expect((await put(id, aliceToken, { repo })).status).toBe(400)
      }
      expect((await put(id, aliceToken, { folder: "notes" })).status).toBe(200)
      expect((await put(id, aliceToken, { repo: "git@gitlab.com:team/app.git" })).status).toBe(200)
      expect(await listed(id)).toMatchObject({ folder: null, repo: "git@gitlab.com:team/app.git" })
      expect((await put(id, aliceToken, { repo: "https://github.com/team/app.git" })).status).toBe(
        200,
      )
      expect((await put(id, aliceToken, { repo: "ssh://git@host/team/app.git" })).status).toBe(200)
    })

    it("folder and repo together are 422", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      const res = await put(id, aliceToken, {
        folder: "notes",
        repo: "https://github.com/team/app.git",
      })
      expect(res.status).toBe(422)
      const body: any = await res.json()
      expect(body.error.code).toBe("folder_and_repo")
    })

    it("another member's routine is 404", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      expect((await put(id, bobToken, { model: "claude-haiku-4-5" })).status).toBe(404)
      expect((await put(crypto.randomUUID(), aliceToken, { model: "x" })).status).toBe(404)
      expect((await put("not-a-uuid", aliceToken, { model: "x" })).status).toBe(404)
      expect(await listed(id)).toMatchObject({ model: null })
    })

    // m7: the placement travels with the save, so a refused placement saves nothing.
    const post = (token: string, body: unknown) =>
      app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    const putRoutine = (id: string, token: string, body: unknown) =>
      app.request(`/api/agent/routines/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    const routineBody = (name: string) => ({
      name,
      description: "node placement",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "say hi",
      scopes: [],
      runsOn: "node",
    })
    async function countNamed(name: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.routines WHERE org_id = ${ORG_ID} AND name = ${name}`
      return row.n
    }

    it("POST saves the routine and its placement in one request (m7)", async () => {
      const name = `np-create-${crypto.randomUUID().slice(0, 8)}`
      const res = await post(aliceToken, {
        ...routineBody(name),
        nodePlacement: { folder: "my-repo", model: "claude-haiku-4-5" },
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data).toMatchObject({
        name,
        folder: "my-repo",
        repo: null,
        model: "claude-haiku-4-5",
      })
      expect(await listed(body.data.id)).toMatchObject({
        folder: "my-repo",
        model: "claude-haiku-4-5",
      })
    })

    it("POST with a refused placement creates nothing, so a retry makes no duplicate (m7)", async () => {
      const name = `np-bad-${crypto.randomUUID().slice(0, 8)}`
      const bad = await post(aliceToken, {
        ...routineBody(name),
        nodePlacement: { repo: "/Users/someone/code" },
      })
      expect(bad.status).toBe(400)
      const both = await post(aliceToken, {
        ...routineBody(name),
        nodePlacement: { folder: "notes", repo: "https://github.com/team/app.git" },
      })
      expect(both.status).toBe(422)
      expect(await countNamed(name)).toBe(0)
      const ok = await post(aliceToken, {
        ...routineBody(name),
        nodePlacement: { folder: "notes" },
      })
      expect(ok.status).toBe(201)
      expect(await countNamed(name)).toBe(1)
    })

    it("PUT saves the edit and the placement together; a refused placement saves neither (m7)", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      const bad = await putRoutine(id, aliceToken, {
        description: "changed",
        nodePlacement: { repo: "file:///tmp/x" },
      })
      expect(bad.status).toBe(400)
      expect(await listed(id)).toMatchObject({ description: "x", repo: null })
      const ok = await putRoutine(id, aliceToken, {
        description: "changed",
        nodePlacement: { folder: "notes", model: "claude-haiku-4-5" },
      })
      expect(ok.status).toBe(200)
      expect(await listed(id)).toMatchObject({
        description: "changed",
        folder: "notes",
        model: "claude-haiku-4-5",
      })
    })

    it("an admin editing another member's routine is told the placement is the owner's, and nothing is saved (m7)", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      // A shared routine: the one kind an admin may edit (loadEditableRoutine).
      await sql`UPDATE kernel.routines SET visibility = 'shared' WHERE id = ${id}`
      const res = await putRoutine(id, adminToken, {
        description: "admin edit",
        nodePlacement: { folder: "admin-folder" },
      })
      expect(res.status).toBe(403)
      const body: any = await res.json()
      expect(body.error.code).toBe("placement_owner_only")
      expect(await listed(id)).toMatchObject({ description: "x", folder: null })
      // Without a placement the admin's edit still goes through.
      expect((await putRoutine(id, adminToken, { description: "admin edit" })).status).toBe(200)
    })

    it("null clears a field; an omitted field is kept", async () => {
      const id = await seedNodeRoutine(ALICE_ID)
      await put(id, aliceToken, { folder: "notes", model: "claude-haiku-4-5" })
      expect((await put(id, aliceToken, { model: null })).status).toBe(200)
      expect(await listed(id)).toMatchObject({ folder: "notes", model: null })
      expect((await put(id, aliceToken, { folder: null })).status).toBe(200)
      expect(await listed(id)).toMatchObject({ folder: null, repo: null, model: null })
      expect((await put(id, aliceToken, { unknown: 1 })).status).toBe(400)
    })
  })

  // ----- GET /events ----------------------------------------------------------
  describe("GET /api/agent/routines/events", () => {
    const EVENT_APPS = ["rt-tickets", "rt-monitoring"]

    afterEach(() => {
      for (const app of EVENT_APPS) deleteDeclaredEmits(ORG_ID, app)
    })

    it("returns the declared event catalog split into app, entity and action", async () => {
      setDeclaredEmits(ORG_ID, "rt-tickets", new Set(["ticket:replied", "ticket:created"]))
      const res = await app.request("/api/agent/routines/events", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data).toContainEqual({
        event: "rt-tickets:ticket:replied",
        app: "rt-tickets",
        entity: "ticket",
        action: "replied",
      })
      expect(body.data.some((e: any) => e.event === "rt-tickets:ticket:created")).toBe(true)
    })

    it("narrows to one app with ?app=", async () => {
      setDeclaredEmits(ORG_ID, "rt-tickets", new Set(["ticket:replied"]))
      setDeclaredEmits(ORG_ID, "rt-monitoring", new Set(["incident:opened"]))
      const res = await app.request("/api/agent/routines/events?app=rt-monitoring", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.map((e: any) => e.event)).toEqual(["rt-monitoring:incident:opened"])
    })

    it("narrows by entity substring with ?entity=", async () => {
      setDeclaredEmits(ORG_ID, "rt-tickets", new Set(["ticket:replied", "sla:breach"]))
      const res = await app.request("/api/agent/routines/events?app=rt-tickets&entity=sla", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.map((e: any) => e.event)).toEqual(["rt-tickets:sla:breach"])
    })
  })

  // ----- P4c-T32 GET /?ownerAgentId -------------------------------------------
  describe("GET /api/agent/routines?ownerAgentId", () => {
    it("GET /agent/routines?ownerAgentId lists only that agent's routines", async () => {
      const [ownerA] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@routines-owner-a', 'Owner A', '["*"]'::jsonb) RETURNING id`
      const [ownerB] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@routines-owner-b', 'Owner B', '["*"]'::jsonb) RETURNING id`
      try {
        // `visibility = 'shared'` is what makes a role agent's routine
        // readable by anyone but its owner (routines_select, 0048).
        await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
          VALUES (${ORG_ID}, ${ADMIN_ID}, ${ownerA.id}, 'owner-a-routine', 'A routine', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC')`
        await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
          VALUES (${ORG_ID}, ${ADMIN_ID}, ${ownerB.id}, 'owner-b-routine', 'B routine', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC')`

        const res = await app.request(`/api/agent/routines?ownerAgentId=${ownerA.id}`, {
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
        expect(res.status).toBe(200)
        const body: any = await res.json()
        expect(body.data.map((r: any) => r.name)).toEqual(["owner-a-routine"])
        expect(body.data[0].ownerAgentId).toBe(ownerA.id)

        // An unknown/invisible owner id is an empty list, never an error.
        const empty = await app.request(
          "/api/agent/routines?ownerAgentId=00000000-0000-0000-0000-000000000999",
          { headers: { Authorization: `Bearer ${aliceToken}` } },
        )
        expect(empty.status).toBe(200)
        const emptyBody: any = await empty.json()
        expect(emptyBody.data).toEqual([])
      } finally {
        // Routines reference these agents (owner_agent_id FK): clear them
        // first, or the agent delete below fails the FK — afterEach's own
        // `DELETE FROM kernel.routines` runs AFTER this block.
        await sql`DELETE FROM kernel.routines WHERE owner_agent_id IN (${ownerA.id}, ${ownerB.id})`
        await sql`DELETE FROM kernel.agents WHERE id IN (${ownerA.id}, ${ownerB.id})`
      }
    })

    // Walk N12: a person who made a personal routine on a ROLE agent's page
    // never saw it again on that page (the select policy shows personal
    // routines of the caller's own personal agent only), so nothing could
    // open it to run or edit it.
    it("lists the caller's own personal routine on a role agent, and only to them", async () => {
      const [owner] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@routines-own-personal', 'Own', '[]'::jsonb) RETURNING id`
      try {
        await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
          VALUES (${ORG_ID}, ${ALICE_ID}, ${owner.id}, 'alice-personal-on-role', 'A routine', 'do it', '{}'::text[], 'personal', 'user', 'recurring', '0 9 * * *', 'UTC')`
        const names = async (token: string) => {
          const res = await app.request(`/api/agent/routines?ownerAgentId=${owner.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          expect(res.status).toBe(200)
          return ((await res.json()) as any).data.map((r: any) => r.name)
        }
        expect(await names(aliceToken)).toEqual(["alice-personal-on-role"])
        expect(await names(bobToken)).toEqual([])
      } finally {
        await sql`DELETE FROM kernel.routines WHERE owner_agent_id = ${owner.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${owner.id}`
      }
    })

    it("each listed skill and routine row carries canWrite for the viewer", async () => {
      // The tab reads `canWrite` rather than recomputing A15 client-side, so
      // the same row answers differently for the admin who may author for this
      // role agent and the member who may not.
      const [owner] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@routines-canwrite', 'CanWrite', '[]'::jsonb) RETURNING id`
      try {
        await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
          VALUES (${ORG_ID}, ${ADMIN_ID}, ${owner.id}, 'canwrite-routine', 'A routine', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC')`
        const read = async (token: string) => {
          const res = await app.request(`/api/agent/routines?ownerAgentId=${owner.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          expect(res.status).toBe(200)
          const body: any = await res.json()
          expect(body.data).toHaveLength(1)
          return body.data[0].canWrite
        }
        expect(await read(agentsAdminToken)).toBe(true)
        expect(await read(aliceToken)).toBe(false)
      } finally {
        await sql`DELETE FROM kernel.routines WHERE owner_agent_id = ${owner.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${owner.id}`
      }
    })
  })

  // ----- one-shot / visibility / edit rights --------------------------------
  describe("kind, visibility, shared listing, edit rights", () => {
    it("creates a one-shot routine with runAt and no cron", async () => {
      // The one-shot path enqueues a delayed `routine-tick` job — enqueueAppJob
      // requires the worker handler to be registered.
      const { registerJobWorker } = await import("~/infra/jobs/jobs")
      registerJobWorker("kernel", "routine-tick", async () => {})
      const add = spyOn(Queue.prototype, "addBulk").mockImplementation(
        // Every enqueue is one addBulk (infra/jobs/fairness.ts fairEnqueue).
        async (jobs) =>
          jobs.map((j, i) => ({
            id: j.opts?.jobId ?? `stub-${i}`,
            name: j.name,
            data: j.data,
          })) as never,
      )
      try {
        const res = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "one-shot-a",
            description: "ping me",
            kind: "scheduled",
            runAt: new Date(Date.now() + 86_400_000).toISOString(),
            prompt: "Remind me to call the dentist",
            visibility: "personal",
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.kind).toBe("scheduled")
        expect(body.data.cron).toBeNull()
      } finally {
        add.mockRestore()
      }
    })

    it("rejects a recurring routine missing cron", async () => {
      const res = await app.request("/api/agent/routines", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-rec",
          description: "d",
          kind: "recurring",
          prompt: "p",
          visibility: "personal",
        }),
      })
      expect(res.status).toBe(400)
    })

    it("lists shared routines from other owners under ?visibility=shared", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "bob-shared",
            description: "d",
            kind: "recurring",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            visibility: "shared",
          }),
        })
      } finally {
        upsert.mockRestore()
      }
      const res = await app.request("/api/agent/routines?visibility=shared", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.some((r: any) => r.name === "bob-shared")).toBe(true)
    })

    it("does not list another owner's personal routine under ?visibility=mine", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "bob-personal",
            description: "d",
            kind: "recurring",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            visibility: "personal",
          }),
        })
      } finally {
        upsert.mockRestore()
      }
      const res = await app.request("/api/agent/routines?visibility=mine", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      const body: any = await res.json()
      expect(body.data.some((r: any) => r.name === "bob-personal")).toBe(false)
    })

    it("lets an org admin edit a shared routine they do not own", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const created = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "bob-shared-2",
            description: "d",
            kind: "recurring",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            visibility: "shared",
          }),
        })
        const createdBody: any = await created.json()
        const res = await app.request(`/api/agent/routines/${createdBody.data.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ description: "edited by admin" }),
        })
        expect(res.status).toBe(200)
      } finally {
        upsert.mockRestore()
      }
    })

    it("rejects a non-owner non-admin editing a shared routine", async () => {
      const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
      try {
        const created = await app.request("/api/agent/routines", {
          method: "POST",
          headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "bob-shared-3",
            description: "d",
            kind: "recurring",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "p",
            visibility: "shared",
          }),
        })
        const createdBody: any = await created.json()
        const res = await app.request(`/api/agent/routines/${createdBody.data.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ description: "should fail" }),
        })
        expect(res.status).toBe(403)
      } finally {
        upsert.mockRestore()
      }
    })
  })

  // ----- An agent's routines and their run history ---------------------------
  // A routine's run log belongs on the page of the agent that runs it, never
  // in the chat lists: the agent page lists the routine, its run history names
  // each run, and a run opens the slice of the output thread it wrote.
  describe("an agent's routine run history", () => {
    async function seedThread(type: string, handle: string, title: string): Promise<string> {
      const [t] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
        VALUES (${ORG_ID}, ${handle}, ${title}, ${type}, ${ALICE_ID}) RETURNING id`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${t.id}, ${ALICE_ID}, ${ORG_ID}, 'admin')`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${ALICE_ID}, ${t.id}, ${ORG_ID})`
      return t.id
    }

    async function post(
      threadId: string,
      authorType: "user" | "agent",
      content: string,
      at: string,
      agentId: string | null = null,
    ): Promise<string> {
      const [m] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
        VALUES (${threadId}, ${ORG_ID}, ${BOB_ID}, ${authorType}, ${agentId}, ${content}, '{}'::text[], ${at}::timestamptz)
        RETURNING id`
      return m.id
    }

    async function cleanup(threadIds: string[], agentId: string | null) {
      for (const id of threadIds) {
        await sql`DELETE FROM kernel.messages WHERE thread_id = ${id}`
        await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${id}`
        await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${id}`
      }
      await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
      for (const id of threadIds) await sql`DELETE FROM kernel.threads WHERE id = ${id}`
      if (agentId) await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }

    it("lists the routine under its agent, and a run opens its own transcript only", async () => {
      const [support] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@routines-support', 'Support', '["*"]'::jsonb) RETURNING id`
      const logId = await seedThread("routine", "routine-history-log", "on-message")
      const channelId = await seedThread("thread", "routine-history-channel", "general")
      try {
        const [routine] = await sql<{ id: string }[]>`
          INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone, output_thread_id)
          VALUES (${ORG_ID}, ${ALICE_ID}, ${support.id}, 'on-message', 'triage', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC', ${logId})
          RETURNING id`
        const now = Date.now()
        const at = (s: number) => new Date(now - s * 1000).toISOString()
        const first = [
          await post(logId, "user", "Triage the new ticket", at(58)),
          await post(logId, "agent", "Triaged **2** tickets", at(55), support.id),
        ]
        await post(logId, "user", "Triage the new ticket", at(18))
        await post(logId, "agent", "Nothing new", at(15), support.id)
        await post(channelId, "user", "hello", at(5))
        const [run1] = await sql<{ id: string }[]>`
          INSERT INTO kernel.routine_runs (org_id, routine_id, status, started_at, ran_at, duration_ms, "trigger")
          VALUES (${ORG_ID}, ${routine.id}, 'succeeded', ${at(60)}::timestamptz, ${at(50)}::timestamptz, 10000, 'schedule') RETURNING id`
        await sql`
          INSERT INTO kernel.routine_runs (org_id, routine_id, status, started_at, ran_at, duration_ms, "trigger", trigger_label)
          VALUES (${ORG_ID}, ${routine.id}, 'succeeded', ${at(20)}::timestamptz, ${at(10)}::timestamptz, 10000, 'event', 'tickets.ticket.create')`

        const headers = { Authorization: `Bearer ${aliceToken}` }
        const listed = await app.request(`/api/agent/routines?ownerAgentId=${support.id}`, {
          headers,
        })
        const listedBody: any = await listed.json()
        expect(listedBody.data.map((r: any) => [r.name, r.outputThreadId])).toEqual([
          ["on-message", logId],
        ])

        const runs = await app.request(`/api/agent/routines/${routine.id}/runs`, { headers })
        expect(runs.status).toBe(200)
        const runsBody: any = await runs.json()
        expect(
          runsBody.data.map((r: any) => ({
            trigger: r.trigger,
            triggerLabel: r.triggerLabel,
            summary: r.summary,
            messageCount: r.messageCount,
            hasTranscript: r.hasTranscript,
            outputThreadId: r.outputThreadId,
          })),
        ).toEqual([
          {
            trigger: "event",
            triggerLabel: "tickets.ticket.create",
            summary: "Nothing new",
            messageCount: 2,
            hasTranscript: true,
            outputThreadId: logId,
          },
          {
            trigger: "schedule",
            triggerLabel: null,
            summary: "Triaged 2 tickets",
            messageCount: 2,
            hasTranscript: true,
            outputThreadId: logId,
          },
        ])

        const transcript = await app.request(
          `/api/agent/routines/${routine.id}/runs/${run1.id}/messages`,
          { headers },
        )
        expect(transcript.status).toBe(200)
        const transcriptBody: any = await transcript.json()
        expect(transcriptBody.data.messages.map((m: any) => m.id)).toEqual(first)

        // Somebody else's routine: its history is not theirs to read.
        const bobs = await app.request(
          `/api/agent/routines/${routine.id}/runs/${run1.id}/messages`,
          {
            headers: { Authorization: `Bearer ${bobToken}` },
          },
        )
        expect(bobs.status).toBe(404)

        // And the run log is no chat row: the list shows the channel only, and
        // the unread count is the channel's one message.
        const threads = await app.request("/api/threads?limit=50", { headers })
        const threadIds = ((await threads.json()) as any).data.map((t: any) => t.id)
        expect(threadIds).toContain(channelId)
        expect(threadIds).not.toContain(logId)
        const unread = await app.request("/api/threads/unread-count", { headers })
        expect(((await unread.json()) as any).data.count).toBe(1)
      } finally {
        await cleanup([logId, channelId], support.id)
      }
    })

    it("a routine with no agent lists under its owner's personal agent, and only for them", async () => {
      const [personal] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
        VALUES (${ORG_ID}, 'personal', '@routines-alice-personal', 'Alice agent', '["*"]'::jsonb, ${ALICE_ID}) RETURNING id`
      try {
        await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
          VALUES (${ORG_ID}, ${ALICE_ID}, NULL, 'legacy-digest', 'old', 'do it', '{}'::text[], 'personal', 'user', 'recurring', '0 9 * * *', 'UTC')`
        const names = async (token: string) => {
          const res = await app.request(`/api/agent/routines?ownerAgentId=${personal.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          expect(res.status).toBe(200)
          return ((await res.json()) as any).data.map((r: any) => r.name)
        }
        expect(await names(aliceToken)).toEqual(["legacy-digest"])
        expect(await names(bobToken)).toEqual([])
      } finally {
        await cleanup([], personal.id)
      }
    })
  })
})

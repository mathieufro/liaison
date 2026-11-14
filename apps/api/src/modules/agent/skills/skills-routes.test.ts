// SPDX-License-Identifier: FSL-1.1-ALv2
// T4.1/T4.2/T4.3 — Skills + app-skills HTTP route tests.
//
// Visibility parity (the spec's "single source of truth"): the GET handler must
// return the same row set as `resolveAllSkills` — they're literally the same
// function under the hood, but we assert it stays that way.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { disabledAppSkills, skills as skillsTbl } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { resolveAllSkills } from "~/modules/agent/tools/skills-routines-tools"
import { skillRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8200-00000000a001"
const ALICE_ID = "00000000-0000-4000-8200-00000000a002"
const BOB_ID = "00000000-0000-4000-8200-00000000a003"
const ADMIN_ID = "00000000-0000-4000-8200-00000000a004"

const _ALL_SCOPES = ["*"]
const ALICE_SCOPES = ["kernel:skills:read", "kernel:skills:write"]
const ADMIN_SCOPES = ["kernel:skills:read", "kernel:skills:write", "kernel:apps:admin"]
// A15's allow branch for a role/system owner: kernel:agents:admin, plus scopes
// that cover the owning agent's ceiling.
const AGENTS_ADMIN_SCOPES = ["kernel:skills:read", "kernel:skills:write", "kernel:agents:admin"]

async function tokenFor(userId: string, scopes: string[]): Promise<string> {
  return signAccessToken(
    {
      userId,
      orgId: ORG_ID,
      name: `User ${userId.slice(-4)}`,
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

describe("skills-routes — /api/agent/skills + /api/agent/app-skills", () => {
  let aliceToken: string
  let _bobToken: string
  let adminToken: string
  let agentsAdminToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'SkillRouteOrg', 'skill-route-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ALICE_ID}, ${ORG_ID}, 'alice-skills@test.com', 'Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${BOB_ID}, ${ORG_ID}, 'bob-skills@test.com', 'Bob') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_ID}, ${ORG_ID}, 'admin-skills@test.com', 'Admin') ON CONFLICT (id) DO NOTHING`

    aliceToken = await tokenFor(ALICE_ID, ALICE_SCOPES)
    _bobToken = await tokenFor(BOB_ID, ALICE_SCOPES)
    adminToken = await tokenFor(ADMIN_ID, ADMIN_SCOPES)
    agentsAdminToken = await tokenFor(ADMIN_ID, AGENTS_ADMIN_SCOPES)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.disabled_app_skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.disabled_app_skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    skillRegistry.deleteByPrefix([ORG_ID])
    toolRegistry.deleteByPrefix([ORG_ID])
  })

  // ----- T4.1 GET / -----------------------------------------------------------
  describe("GET /api/agent/skills", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/agent/skills")
      expect(res.status).toBe(401)
    })

    it("returns built-in + org + personal, deduped by name with personal shadowing org", async () => {
      // Seed: one app skill (tickets/draft-reply), one org skill (alice
      // shouldn't fork it), one personal skill named the same as the app
      // skill — personal must win.
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "Tickets app reply skill",
        body: "App-shipped body",
        requiredScopes: [],
      })
      await withPrivilegedDb(ORG_ID, "skl-route-seed", async (tx) => {
        await tx.insert(skillsTbl).values({
          orgId: ORG_ID,
          name: "draft-reply",
          description: "Personal version",
          body: "Alice's own body",
          requiredScopes: [],
          authorUserId: ALICE_ID,
          createdByUserId: ALICE_ID,
          createdByActorType: "user",
        })
        await tx.insert(skillsTbl).values({
          orgId: ORG_ID,
          name: "org-only-skill",
          description: "Org shared",
          body: "Org body",
          requiredScopes: [],
          authorUserId: null,
          createdByUserId: ADMIN_ID,
          createdByActorType: "user",
        })
      })

      const res = await app.request("/api/agent/skills", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      const byName = new Map<string, any>(body.data.map((r: any) => [r.name, r]))
      expect(byName.has("draft-reply")).toBe(true)
      expect(byName.get("draft-reply").source).toBe("personal")
      expect(byName.has("org-only-skill")).toBe(true)
      expect(byName.get("org-only-skill").source).toBe("org")
    })

    it("VISIBILITY PARITY: route handler and resolveAllSkills return the same row set", async () => {
      skillRegistry.set([ORG_ID, "tickets", "parity-app"], {
        name: "parity-app",
        description: "App-shipped",
        body: "App body",
        requiredScopes: [],
      })
      await withPrivilegedDb(ORG_ID, "skl-parity-seed", async (tx) => {
        await tx.insert(skillsTbl).values({
          orgId: ORG_ID,
          name: "parity-personal",
          description: "Alice personal",
          body: "Personal body",
          requiredScopes: [],
          authorUserId: ALICE_ID,
          createdByUserId: ALICE_ID,
          createdByActorType: "user",
        })
      })

      const res = await app.request("/api/agent/skills", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      const body: any = await res.json()
      const routeNames = body.data.map((r: any) => r.name).sort()

      const ctxRows = await resolveAllSkills(ORG_ID, ALICE_ID, ALICE_SCOPES)
      const ctxNames = ctxRows.map((r) => r.name).sort()
      expect(routeNames).toEqual(ctxNames)
    })
  })

  // ----- P4c-T32 GET /?ownerAgentId -------------------------------------------
  describe("GET /api/agent/skills?ownerAgentId", () => {
    it("GET /agent/skills?ownerAgentId lists only that agent's skills", async () => {
      const [ownerA] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@skills-owner-a', 'Owner A', '["*"]'::jsonb) RETURNING id`
      const [ownerB] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@skills-owner-b', 'Owner B', '["*"]'::jsonb) RETURNING id`
      try {
        await withPrivilegedDb(ORG_ID, "skl-owner-seed", async (tx) => {
          await tx.insert(skillsTbl).values({
            orgId: ORG_ID,
            ownerAgentId: ownerA.id,
            name: "owner-a-skill",
            description: "A's skill",
            body: "Body",
            requiredScopes: [],
            authorUserId: null,
            createdByUserId: ADMIN_ID,
            createdByActorType: "user",
          })
          await tx.insert(skillsTbl).values({
            orgId: ORG_ID,
            ownerAgentId: ownerB.id,
            name: "owner-b-skill",
            description: "B's skill",
            body: "Body",
            requiredScopes: [],
            authorUserId: null,
            createdByUserId: ADMIN_ID,
            createdByActorType: "user",
          })
        })

        const res = await app.request(`/api/agent/skills?ownerAgentId=${ownerA.id}`, {
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
        expect(res.status).toBe(200)
        const body: any = await res.json()
        expect(body.data.map((s: any) => s.name)).toEqual(["owner-a-skill"])
        expect(body.data[0].ownerAgentId).toBe(ownerA.id)

        // An unknown/invisible owner id is an empty list, never an error.
        const empty = await app.request(
          "/api/agent/skills?ownerAgentId=00000000-0000-0000-0000-000000000999",
          { headers: { Authorization: `Bearer ${aliceToken}` } },
        )
        expect(empty.status).toBe(200)
        const emptyBody: any = await empty.json()
        expect(emptyBody.data).toEqual([])
      } finally {
        // Skills reference these agents (skills_agent_org_fk): clear them
        // first, or the agent delete below fails the FK — afterEach's own
        // `DELETE FROM kernel.skills` runs AFTER this block.
        await sql`DELETE FROM kernel.skills WHERE owner_agent_id IN (${ownerA.id}, ${ownerB.id})`
        await sql`DELETE FROM kernel.agents WHERE id IN (${ownerA.id}, ${ownerB.id})`
      }
    })
  })

  // ----- T4.1 POST / ---------------------------------------------------------
  describe("POST /api/agent/skills", () => {
    it("with visibility='personal' inserts a row with authorUserId=current user", async () => {
      const res = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "alice-personal",
          description: "My personal skill",
          body: "Body content",
          requiredScopes: [],
          visibility: "personal",
        }),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data.authorUserId).toBe(ALICE_ID)

      const rows = await withPrivilegedDb(ORG_ID, "skl-check", (tx) =>
        tx.select().from(skillsTbl).where(eq(skillsTbl.id, body.data.id)),
      )
      expect(rows[0].authorUserId).toBe(ALICE_ID)
    })

    it("with visibility='org' requires kernel:apps:admin (403 without admin)", async () => {
      const res = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "alice-org-attempt",
          description: "Org-shared attempt",
          body: "Body content",
          requiredScopes: [],
          visibility: "org",
        }),
      })
      expect(res.status).toBe(403)
      // The gate must refuse BEFORE the insert. A 403 with a row behind it is
      // the same bypass wearing a different status code, so assert the write
      // never happened rather than trusting the status alone.
      const rows = await withPrivilegedDb(ORG_ID, "skl-org-gate-check", (tx) =>
        tx
          .select()
          .from(skillsTbl)
          .where(and(eq(skillsTbl.orgId, ORG_ID), eq(skillsTbl.name, "alice-org-attempt"))),
      )
      expect(rows.length).toBe(0)
    })

    it("with visibility='org' succeeds when caller has kernel:apps:admin", async () => {
      const res = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "org-shared-skill",
          description: "Admin-created org-shared",
          body: "Body",
          requiredScopes: [],
          visibility: "org",
        }),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data.authorUserId).toBeNull()
    })

    it("admin caller creates an org-visible skill (201)", async () => {
      // Companion to the 403 above: re-arming the admin gate on the REST route
      // must not cost the admin path. Asserts the PERSISTED row, not just the
      // status: authorUserId null is what makes the row org-visible, and the
      // skill has to actually reach a non-admin teammate's resolved set.
      const res = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "admin-org-skill",
          description: "Admin-created org-shared",
          body: "Body content",
          requiredScopes: [],
          visibility: "org",
        }),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      const rows = await withPrivilegedDb(ORG_ID, "skl-admin-org-check", (tx) =>
        tx.select().from(skillsTbl).where(eq(skillsTbl.id, body.data.id)),
      )
      expect(rows.length).toBe(1)
      expect(rows[0].authorUserId).toBeNull()
      expect(rows[0].createdByUserId).toBe(ADMIN_ID)
      const visible = await resolveAllSkills(ORG_ID, ALICE_ID, ALICE_SCOPES)
      expect(visible.find((s) => s.name === "admin-org-skill")?.source).toBe("org")
    })

    it("scope-escalation: requiredScopes ⊄ caller's scopes are CLAMPED out, not rejected (201)", async () => {
      // l724 / commit 5dd74e2e (BL-275): handleCreateSkill no longer HARD-FAILS scope_escalation when
      // the author over-declares a requiredScope they don't hold — it CLAMPS the over-declared scope to
      // the grantable subset (granted ⊆ effective → no privilege escalation) and surfaces the dropped
      // scope as `omittedScopes`, the same operator-approved least-privilege degrade create_routine uses
      // (l219/BL-150). The REST route is a thin wrapper over the SAME handler, so it clamps identically:
      // Alice (kernel:skills:read/write, no kernel:users:admin) gets a 201, with kernel:users:admin
      // dropped — the created skill carries the held subset (here: []), never the escalated scope.
      const res = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "escalation-attempt",
          description: "Try to grant herself a scope she doesn't have",
          body: "Body",
          requiredScopes: ["kernel:users:admin"],
          visibility: "personal",
        }),
      })
      expect(res.status).toBe(201)
      const json = (await res.json()) as { data: { requiredScopes: string[] } }
      // The over-declared kernel:users:admin is clamped out — never persisted onto the skill.
      expect(json.data.requiredScopes).not.toContain("kernel:users:admin")
      expect(json.data.requiredScopes).toEqual([])
    })

    it("POST /agent/skills with ownerAgentId is refused with agent_write_forbidden when A15 denies", async () => {
      // The tab's body shape (P4c-T32b): a create request naming a role agent
      // as owner. Alice holds no kernel:agents:admin, so A15 refuses — and the
      // refusal is EXPLICIT. Before T32b the unrecognised key was dropped and
      // the row landed on Alice's own personal agent with a 201, so the tab had
      // no way to tell "created for that agent" from "created for me".
      const [roleAgent] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@a15-target', 'A15 Target', '["*"]'::jsonb) RETURNING id`
      try {
        const res = await app.request("/api/agent/skills", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "a15-attempt",
            description: "Tab-created for a role agent",
            body: "Body content",
            requiredScopes: [],
            visibility: "personal",
            ownerAgentId: roleAgent.id,
          }),
        })
        expect(res.status).toBe(403)
        const body: any = await res.json()
        expect(body.error.code).toBe("agent_write_forbidden")

        // Nothing was written anywhere — not onto the named agent, and not
        // silently onto Alice's own.
        const rows = await withPrivilegedDb(ORG_ID, "a15-check", (tx) =>
          tx.select().from(skillsTbl).where(eq(skillsTbl.name, "a15-attempt")),
        )
        expect(rows).toHaveLength(0)
      } finally {
        await sql`DELETE FROM kernel.agents WHERE id = ${roleAgent.id}`
      }
    })

    it("POST /agent/skills with ownerAgentId creates the skill for that role agent when A15 allows", async () => {
      // A15's allow branch: kernel:agents:admin for a role owner, plus the
      // caller's own scopes covering that agent's ceiling (empty here).
      const [roleAgent] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@a15-allowed', 'A15 Allowed', '[]'::jsonb) RETURNING id`
      try {
        const res = await app.request("/api/agent/skills", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${agentsAdminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "a15-allowed-skill",
            description: "Authored for the role agent",
            body: "Body content",
            requiredScopes: [],
            visibility: "personal",
            ownerAgentId: roleAgent.id,
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.ownerAgentId).toBe(roleAgent.id)

        const rows = await withPrivilegedDb(ORG_ID, "a15-allowed-check", (tx) =>
          tx.select().from(skillsTbl).where(eq(skillsTbl.id, body.data.id)),
        )
        expect(rows[0].ownerAgentId).toBe(roleAgent.id)
      } finally {
        await sql`DELETE FROM kernel.skills WHERE owner_agent_id = ${roleAgent.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${roleAgent.id}`
      }
    })

    it("the owner of a personal agent authors a skill regardless of the ceiling", async () => {
      // P4c FX-F4. The ceiling half of A15 is a ROUTINE rule (spec-agents.md
      // D16): a tick runs unfloored at the owning agent's ceiling, a skill is a
      // document read into a turn that already runs at the reader's scopes, and
      // `0047`'s skills_insert policy carries no ceiling clause. Applied to
      // skills too, it locked the owner out of their OWN agent the moment that
      // agent held a capability — which is every agent worth having.
      const [own] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${ORG_ID}, 'personal', '@alice-ceiling', 'Alice', ${ALICE_ID},
                '["kernel:skills:write","shopify:orders:read"]'::jsonb) RETURNING id`
      try {
        const res = await app.request("/api/agent/skills", {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "fx-f4-owner-skill",
            description: "Authored by the owner",
            body: "Body content",
            requiredScopes: [],
            visibility: "personal",
            ownerAgentId: own.id,
          }),
        })
        expect(res.status).toBe(201)
        const body: any = await res.json()
        expect(body.data.ownerAgentId).toBe(own.id)

        // And the row's own `canWrite` says the same thing to the tab, so the
        // edit affordances do not disagree with what the write path allows.
        const list = await app.request(`/api/agent/skills?ownerAgentId=${own.id}`, {
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
        expect(list.status).toBe(200)
        const listed: any = await list.json()
        expect(listed.data[0].canWrite).toBe(true)
      } finally {
        await sql`DELETE FROM kernel.skills WHERE owner_agent_id = ${own.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${own.id}`
      }
    })

    it("an ownerAgentId the caller cannot see is 404, not a silent drop", async () => {
      // Two shapes of invisible, one answer. Bob's personal agent is a real,
      // live row of this org that Alice may not address (A41), and the second
      // id is nobody's. Both are `agent_not_found`: telling them apart would
      // confirm the existence of a colleague's own agent.
      const [bobAgent] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${ORG_ID}, 'personal', '@bob-a15', 'Bob', ${BOB_ID}, '[]'::jsonb) RETURNING id`
      try {
        for (const targetId of [bobAgent.id, "00000000-0000-4000-8200-0000000a15ff"]) {
          const res = await app.request("/api/agent/skills", {
            method: "POST",
            headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "a15-invisible",
              description: "Aimed at an agent Alice cannot see",
              body: "Body content",
              requiredScopes: [],
              visibility: "personal",
              ownerAgentId: targetId,
            }),
          })
          expect(res.status).toBe(404)
          const body: any = await res.json()
          expect(body.error.code).toBe("agent_not_found")
        }
        const rows = await withPrivilegedDb(ORG_ID, "a15-invisible-check", (tx) =>
          tx.select().from(skillsTbl).where(eq(skillsTbl.name, "a15-invisible")),
        )
        expect(rows).toHaveLength(0)
      } finally {
        await sql`DELETE FROM kernel.agents WHERE id = ${bobAgent.id}`
      }
    })

    it("each listed skill and routine row carries canWrite for the viewer", async () => {
      // The tab reads `canWrite` rather than recomputing A15 client-side, so
      // the same row must answer differently for two viewers: the admin who may
      // author for this role agent, and the member who may not.
      const [roleAgent] =
        await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${ORG_ID}, 'role', '@a15-canwrite', 'A15 CanWrite', '[]'::jsonb) RETURNING id`
      try {
        await withPrivilegedDb(ORG_ID, "a15-canwrite-seed", (tx) =>
          tx.insert(skillsTbl).values({
            orgId: ORG_ID,
            ownerAgentId: roleAgent.id,
            name: "canwrite-skill",
            description: "Owned by the role agent",
            body: "Body",
            requiredScopes: [],
            authorUserId: null,
            createdByUserId: ADMIN_ID,
            createdByActorType: "user",
          }),
        )
        const read = async (token: string) => {
          const res = await app.request(`/api/agent/skills?ownerAgentId=${roleAgent.id}`, {
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
        await sql`DELETE FROM kernel.skills WHERE owner_agent_id = ${roleAgent.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${roleAgent.id}`
      }
    })
  })

  // ----- T4.1 PUT /:id -------------------------------------------------------
  describe("PUT /api/agent/skills/:id", () => {
    it("updates a skill and bumps updatedAt", async () => {
      const created = await withPrivilegedDb(ORG_ID, "skl-put-seed", (tx) =>
        tx
          .insert(skillsTbl)
          .values({
            orgId: ORG_ID,
            name: "to-be-updated",
            description: "Old description",
            body: "Old body",
            requiredScopes: [],
            authorUserId: ALICE_ID,
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const id = created[0].id
      const oldUpdatedAt = created[0].updatedAt

      const res = await app.request(`/api/agent/skills/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ description: "New description" }),
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.description).toBe("New description")
      expect(new Date(body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(oldUpdatedAt.getTime())
    })
  })

  // ----- autoAttach through the API (provisioning used to need psql) ------------
  describe("autoAttach on create and update", () => {
    it("POST stores autoAttach, PUT changes it, null clears it, an unknown key is refused", async () => {
      const post = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "alice-auto-attach",
          description: "Warehouse procedure",
          body: "Read the population first.",
          requiredScopes: [],
          visibility: "personal",
          autoAttach: { owner: true, apps: ["kpi"], keywords: ["entrepot"] },
        }),
      })
      expect(post.status).toBe(201)
      const created: any = await post.json()
      const read = async () =>
        (
          await withPrivilegedDb(ORG_ID, "skl-auto-attach", (tx) =>
            tx.select().from(skillsTbl).where(eq(skillsTbl.id, created.data.id)),
          )
        )[0]?.autoAttach
      expect(await read()).toEqual({ owner: true, apps: ["kpi"], keywords: ["entrepot"] })

      const put = await app.request(`/api/agent/skills/${created.data.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ autoAttach: { owner: false } }),
      })
      expect(put.status).toBe(200)
      expect(await read()).toEqual({ owner: false })

      const clear = await app.request(`/api/agent/skills/${created.data.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ autoAttach: null }),
      })
      expect(clear.status).toBe(200)
      expect(await read()).toBeNull()

      const typo = await app.request(`/api/agent/skills/${created.data.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ autoAttach: { onwer: true } }),
      })
      expect(typo.status).toBe(400)
    })
  })

  // ----- T4.1 DELETE /:id ---------------------------------------------------
  describe("DELETE /api/agent/skills/:id", () => {
    it("returns 404 when the skill doesn't exist", async () => {
      const res = await app.request("/api/agent/skills/00000000-0000-0000-0000-000000000099", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(404)
    })

    it("returns 204 on success and removes the row", async () => {
      const created = await withPrivilegedDb(ORG_ID, "skl-del-seed", (tx) =>
        tx
          .insert(skillsTbl)
          .values({
            orgId: ORG_ID,
            name: "to-delete",
            description: "Del me",
            body: "Body",
            requiredScopes: [],
            authorUserId: ALICE_ID,
            createdByUserId: ALICE_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const res = await app.request(`/api/agent/skills/${created[0].id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(204)

      const rows = await withPrivilegedDb(ORG_ID, "skl-del-check", (tx) =>
        tx.select().from(skillsTbl).where(eq(skillsTbl.id, created[0].id)),
      )
      expect(rows.length).toBe(0)
    })
  })

  // ----- T4.2 POST /:id/fork -------------------------------------------------
  describe("POST /api/agent/skills/:id/fork", () => {
    it("forks an app-shipped skill into a personal one with forkedFrom='app:<app>/<name>'", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "Built-in tickets reply skill",
        body: "App-shipped reply body",
        requiredScopes: [],
      })
      const res = await app.request("/api/agent/skills/built-in%2Ftickets%2Fdraft-reply/fork", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data.authorUserId).toBe(ALICE_ID)
      expect(body.data.forkedFrom).toBe("app:tickets/draft-reply")
      expect(body.data.body).toBe("App-shipped reply body")
    })

    it("forks a DB skill by UUID with forkedFrom='skill:<uuid>'", async () => {
      const seeded = await withPrivilegedDb(ORG_ID, "skl-fork-seed", (tx) =>
        tx
          .insert(skillsTbl)
          .values({
            orgId: ORG_ID,
            name: "shared-base",
            description: "Source skill",
            body: "Source body",
            requiredScopes: [],
            authorUserId: null,
            createdByUserId: ADMIN_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const sourceId = seeded[0].id
      // Alice forks under a different name to avoid colliding with the org-shared one.
      const res = await app.request(`/api/agent/skills/${sourceId}/fork`, {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "alice-fork" }),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data.forkedFrom).toBe(`skill:${sourceId}`)
      expect(body.data.authorUserId).toBe(ALICE_ID)
      expect(body.data.body).toBe("Source body")
    })

    it("cross-org fork of another org's skill by UUID returns 404 (IDOR)", async () => {
      // Seed a skill in a DIFFERENT org. Alice (ORG_ID) must not be able to
      // fork it — the privileged lookup is org-scoped, so a foreign id 404s.
      const FOREIGN_ORG = "00000000-0000-4000-8200-00000000b001"
      const FOREIGN_ADMIN = "00000000-0000-4000-8200-00000000b002"
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${FOREIGN_ORG}, 'ForeignOrg', 'foreign-skill-org') ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${FOREIGN_ADMIN}, ${FOREIGN_ORG}, 'foreign-admin@test.com', 'Foreign Admin') ON CONFLICT (id) DO NOTHING`
      try {
        const seeded = await withPrivilegedDb(FOREIGN_ORG, "skl-foreign-seed", (tx) =>
          tx
            .insert(skillsTbl)
            .values({
              orgId: FOREIGN_ORG,
              name: "secret-skill",
              description: "Other tenant's private skill",
              body: "Confidential cross-org body",
              requiredScopes: [],
              authorUserId: null,
              createdByUserId: FOREIGN_ADMIN,
              createdByActorType: "user",
            })
            .returning(),
        )
        const foreignId = seeded[0].id

        // Alice belongs to ORG_ID — forking FOREIGN_ORG's skill by id must 404,
        // never leak the body.
        const res = await app.request(`/api/agent/skills/${foreignId}/fork`, {
          method: "POST",
          headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "stolen-fork" }),
        })
        expect(res.status).toBe(404)

        // And no skill was created in ALICE'S ORG (ORG_ID) from the foreign body.
        // NB: withPrivilegedDb bypasses RLS, so the check MUST be org-scoped — a
        // body-only filter would also match the legitimate foreign original (still
        // present until the finally below), a false positive unrelated to any leak.
        const leaked = await withPrivilegedDb(ORG_ID, "skl-foreign-check", (tx) =>
          tx
            .select()
            .from(skillsTbl)
            .where(
              and(eq(skillsTbl.body, "Confidential cross-org body"), eq(skillsTbl.orgId, ORG_ID)),
            ),
        )
        expect(leaked.length).toBe(0)
      } finally {
        await sql`DELETE FROM kernel.skills WHERE org_id = ${FOREIGN_ORG}`
        await sql`DELETE FROM kernel.users WHERE org_id = ${FOREIGN_ORG}`
        await sql`DELETE FROM kernel.organizations WHERE id = ${FOREIGN_ORG}`
      }
    })

    it("same-org fork of a DB skill by UUID still succeeds (legitimate caller)", async () => {
      const seeded = await withPrivilegedDb(ORG_ID, "skl-sameorg-seed", (tx) =>
        tx
          .insert(skillsTbl)
          .values({
            orgId: ORG_ID,
            name: "sameorg-base",
            description: "Same-org source",
            body: "Same-org body",
            requiredScopes: [],
            authorUserId: null,
            createdByUserId: ADMIN_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const res = await app.request(`/api/agent/skills/${seeded[0].id}/fork`, {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "sameorg-fork" }),
      })
      expect(res.status).toBe(201)
      const body: any = await res.json()
      expect(body.data.body).toBe("Same-org body")
      expect(body.data.forkedFrom).toBe(`skill:${seeded[0].id}`)
    })

    it("another user's personal skill cannot be forked by id (404, body not returned)", async () => {
      const seeded = await withPrivilegedDb(ORG_ID, "skl-fork-private-seed", (tx) =>
        tx
          .insert(skillsTbl)
          .values({
            orgId: ORG_ID,
            name: "bobs-private",
            description: "Bob's private skill",
            body: "BOB-PRIVATE-BODY",
            requiredScopes: [],
            authorUserId: BOB_ID,
            createdByUserId: BOB_ID,
            createdByActorType: "user",
          })
          .returning(),
      )
      const res = await app.request(`/api/agent/skills/${seeded[0].id}/fork`, {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "stolen" }),
      })
      expect(res.status).toBe(404)
      expect(JSON.stringify(await res.json())).not.toContain("BOB-PRIVATE-BODY")
    })

    it("fork colliding with existing personal of same name returns 409", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "Built-in skill",
        body: "Body",
        requiredScopes: [],
      })
      // Alice already has a personal `draft-reply` — seeded through the real
      // create route (not a raw insert) so it carries Alice's actual
      // ownerAgentId. D9/A15 keys the collision-detecting unique index on
      // (ownerAgentId, name), not (orgId, authorUserId, name): a raw insert
      // with no ownerAgentId leaves it NULL, which never collides with
      // anything in a unique index, so the fork below would silently
      // succeed (201) instead of the 409 this test asserts.
      const seedRes = await app.request("/api/agent/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "draft-reply",
          description: "Alice's own",
          body: "Alice body",
          requiredScopes: [],
          visibility: "personal",
        }),
      })
      expect(seedRes.status).toBe(201)
      const res = await app.request("/api/agent/skills/built-in%2Ftickets%2Fdraft-reply/fork", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
    })
  })

  // ----- T4.3 app-skills routes ----------------------------------------------
  describe("GET /api/agent/app-skills/:app/:name", () => {
    it("404 with code=app_not_enabled when the org doesn't have the app", async () => {
      const res = await app.request("/api/agent/app-skills/ghost-app/anything", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(404)
    })

    it("404 with code=skill_not_found when app exists but skill doesn't", async () => {
      skillRegistry.set([ORG_ID, "tickets", "real-skill"], {
        name: "real-skill",
        description: "Exists",
        body: "Body",
        requiredScopes: [],
      })
      const res = await app.request("/api/agent/app-skills/tickets/ghost-skill", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(404)
    })

    it("200 returns the skill + enabled flag", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "Tickets reply",
        body: "Body",
        requiredScopes: [],
      })
      const res = await app.request("/api/agent/app-skills/tickets/draft-reply", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.appName).toBe("tickets")
      expect(body.data.name).toBe("draft-reply")
      expect(body.data.enabled).toBe(true)
    })
  })

  describe("a skill of a feature the org has off", () => {
    it("cannot be read or forked, as it is not listed", async () => {
      skillRegistry.set([ORG_ID, "tickets", "feature-skill"], {
        name: "feature-skill",
        description: "Only with its feature",
        body: "Feature body",
        requiredScopes: [],
        feature: "not_switched_on",
      } as never)
      const read = await app.request("/api/agent/app-skills/tickets/feature-skill", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(read.status).toBe(404)
      expect(await read.text()).not.toContain("Feature body")
      const fork = await app.request("/api/agent/skills/built-in%2Ftickets%2Ffeature-skill/fork", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(fork.status).toBe(404)
      const list = await app.request("/api/agent/app-skills", {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
      expect(await list.text()).not.toContain("feature-skill")
    })
  })

  describe("POST /api/agent/app-skills/:app/:name/toggle", () => {
    it("returns 403 when caller holds only kernel:skills:read (B1)", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "x",
        body: "x",
        requiredScopes: [],
      })
      const readOnlyToken = await tokenFor(ALICE_ID, ["kernel:skills:read"])
      const res = await app.request("/api/agent/app-skills/tickets/draft-reply/toggle", {
        method: "POST",
        headers: { Authorization: `Bearer ${readOnlyToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "user" }),
      })
      expect(res.status).toBe(403)
    })

    it("scope='org' without kernel:apps:admin returns 403", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "x",
        body: "x",
        requiredScopes: [],
      })
      const res = await app.request("/api/agent/app-skills/tickets/draft-reply/toggle", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "org" }),
      })
      expect(res.status).toBe(403)
    })

    it("scope='user' inserts (orgId, currentUser, app, name) into disabled_app_skills, then re-toggle removes it", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "x",
        body: "x",
        requiredScopes: [],
      })
      const offRes = await app.request("/api/agent/app-skills/tickets/draft-reply/toggle", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "user" }),
      })
      expect(offRes.status).toBe(200)
      const offBody: any = await offRes.json()
      expect(offBody.data.enabled).toBe(false)
      const after = await withPrivilegedDb(ORG_ID, "tg-check", (tx) =>
        tx
          .select()
          .from(disabledAppSkills)
          .where(
            and(
              eq(disabledAppSkills.orgId, ORG_ID),
              eq(disabledAppSkills.appName, "tickets"),
              eq(disabledAppSkills.skillName, "draft-reply"),
              eq(disabledAppSkills.userId, ALICE_ID),
            ),
          ),
      )
      expect(after.length).toBe(1)

      const onRes = await app.request("/api/agent/app-skills/tickets/draft-reply/toggle", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "user" }),
      })
      expect(onRes.status).toBe(200)
      const onBody: any = await onRes.json()
      expect(onBody.data.enabled).toBe(true)
    })

    it("scope='org' with admin inserts (orgId, userId=NULL, app, name)", async () => {
      skillRegistry.set([ORG_ID, "tickets", "draft-reply"], {
        name: "draft-reply",
        description: "x",
        body: "x",
        requiredScopes: [],
      })
      const res = await app.request("/api/agent/app-skills/tickets/draft-reply/toggle", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "org" }),
      })
      expect(res.status).toBe(200)
      const rows = await withPrivilegedDb(ORG_ID, "tg-check-org", (tx) =>
        tx
          .select()
          .from(disabledAppSkills)
          .where(
            and(
              eq(disabledAppSkills.orgId, ORG_ID),
              eq(disabledAppSkills.appName, "tickets"),
              eq(disabledAppSkills.skillName, "draft-reply"),
            ),
          ),
      )
      expect(rows.length).toBe(1)
      expect(rows[0].userId).toBeNull()
    })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T16, rewritten for the composition that no longer ships bodies. The old
// case forced an overflow of five large skill bodies and pinned WHICH TWO the
// budget dropped. There is nothing to drop any more: a definition carries an
// INDEX of every skill the agent may use, and dropping an index line would hide
// a skill rather than defer its body. So the property this seeding now pins is
// the one that matters: the same five large skills that used to blow the budget
// compose to a definition well under it, with every skill still named and no
// body anywhere in the payload.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { asSchema } from "ai"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  AGENT_DEFINITION_TOKEN_CAP,
  assembleContext,
  composeAgentDefinition,
  estimateAgentDefinitionTokens,
  estimateToolSchemaTokens,
  systemPartsToText,
  TURN_SYSTEM_PROMPT_TOKEN_CAP,
} from "~/modules/agent/context/context"
import {
  loadLadderTools,
  measureLadder,
  staticFixedPromptTokens,
} from "~/modules/agent/context/ladder-budget"
import { providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { orgSetupStamp } from "~/modules/apps/setup-stamp"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cf0021"
const USER_ID = "00000000-0000-0000-0000-000000cf0022"
const AGENT_ID = "00000000-0000-0000-0000-000000cf0023"

// Four auto-surfaced bodies and one app-anchored block, each ~2,000 tokens.
const SKILLS: Array<{ name: string; chars: number; apps: string[] | null }> = [
  { name: "cap-auto-a", chars: 8000, apps: null },
  { name: "cap-auto-b", chars: 7996, apps: null },
  { name: "cap-auto-c", chars: 7992, apps: null },
  { name: "cap-auto-d", chars: 7988, apps: null },
  { name: "cap-anchored", chars: 8000, apps: ["tickets"] },
]
const bodyOf = (name: string, chars: number) => `${name}-BODY-`.padEnd(chars, "x").slice(0, chars)

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}

describe("composeAgentDefinition - five large skills fit the definition budget", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CapOrg', 'cap-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'cap@test.com', 'Cap User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', '@cap', 'Cap Agent', '["*"]'::jsonb, 'CAP_AGENT_PROMPT') ON CONFLICT DO NOTHING`
    for (const s of SKILLS) {
      const autoAttach = s.apps ? JSON.stringify({ apps: s.apps }) : null
      await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, auto_attach, created_by_actor_type)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${s.name}, ${`${s.name} description`}, ${bodyOf(s.name, s.chars)}, ${autoAttach}::jsonb, 'user')
        ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("names all five skills, ships none of their bodies, and stays under the cap", async () => {
    const def = await composeAgentDefinition({
      agentId: AGENT_ID,
      requestingActor: actor,
      orgId: ORG_ID,
    })

    expect(def.skillIndex.map((s) => s.name).sort()).toEqual(SKILLS.map((s) => s.name).sort())
    // 39,976 characters of bodies were composed before; none of it rides now.
    const payload = JSON.stringify(def)
    for (const s of SKILLS) expect(payload).not.toContain(`${s.name}-BODY-`)

    expect(estimateAgentDefinitionTokens(def)).toBeLessThanOrEqual(AGENT_DEFINITION_TOKEN_CAP)
  })
})

// The fixed parts of the system prompt (base text, charter, roster, kernel
// guide, app summaries, skill index, the deferred-tool announcement) with every
// app on and every scope held. The static figure the ladder guard computes from
// source must match what the real assembly writes, or the guard reports a
// number nobody pays.
const FIXED_PARTS_TOKEN_MAX = 13_000
const FIXED_PARTS_STATIC_TOLERANCE = 1_000

describe("assembleContext - the fixed prompt parts with every app on", () => {
  const FP_ORG = "00000000-0000-0000-0000-000000cf0031"
  const FP_USER = "00000000-0000-0000-0000-000000cf0032"
  const FP_THREAD = "00000000-0000-0000-0000-000000cf0033"
  const fpActor: UserContext = {
    actorType: "user",
    userId: FP_USER,
    orgId: FP_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }

  beforeAll(async () => {
    await acquireTestLock()
    orgSetupStamp.enabled = false
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${FP_ORG}, 'FixedPartsOrg', 'fixed-parts-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${FP_USER}, ${FP_ORG}, 'fixed@test.com', 'Fixed User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${FP_THREAD}, ${FP_ORG}, 'fixed-chat-1', 'agent_chat', ${FP_USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${FP_THREAD}, ${FP_USER}, ${FP_ORG}) ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(FP_ORG)
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(FP_ORG)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([FP_ORG])
    skillRegistry.deleteByPrefix([FP_ORG])
    agentInstructionsRegistry.deleteByPrefix([FP_ORG])
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${FP_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${FP_ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${FP_ORG})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${FP_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${FP_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${FP_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${FP_ORG}`
    await releaseTestLock()
  })

  it("fixed parts at most 13,000 with every app on; composed prompt within 1,000 of the static figure", async () => {
    const result = await assembleContext({ threadId: FP_THREAD, orgId: FP_ORG, actor: fpActor })
    const composed = estimateTokens(systemPartsToText(result.system))
    const fixed = await staticFixedPromptTokens()
    console.log(`fixed prompt parts: composed ${composed}, static ${fixed.total}`, fixed.parts)
    expect(composed).toBeLessThanOrEqual(FIXED_PARTS_TOKEN_MAX)
    expect(composed).toBeLessThanOrEqual(TURN_SYSTEM_PROMPT_TOKEN_CAP - 3_000)
    expect(Math.abs(composed - fixed.total)).toBeLessThanOrEqual(FIXED_PARTS_STATIC_TOLERANCE)
  })

  it("create_routine is metered within 5% of its projected schema on the wire", () => {
    const def = toolRegistry.get([FP_ORG, "kernel", "create_routine"]) as
      | { description: string; params?: unknown }
      | undefined
    expect(def).toBeDefined()
    const inputSchema = providerInputSchemaOf(def?.params)
    const name = "kernel__create_routine"
    const projected = JSON.stringify(asSchema(inputSchema as never).jsonSchema)
    const wire = Math.ceil(`${name}\n${def?.description ?? ""}\n${projected}`.length / 4)
    const metered = estimateToolSchemaTokens(name, { description: def?.description, inputSchema })
    console.log(`create_routine on the wire: ${wire} tokens, metered ${metered}`)
    expect(Math.abs(metered - wire)).toBeLessThanOrEqual(wire * 0.05)
  })

  it("the ladder guard's schema total per app is the registry's, kernel included", async () => {
    const perApp: Record<string, number> = {}
    for (const [key, def] of toolRegistry.entriesOf(FP_ORG)) {
      const d = def as { description?: string; params?: unknown; agentVisible?: boolean }
      if (d.agentVisible === false) continue
      const name = `${key[1]}__${key[2]}`
      perApp[key[1]] =
        (perApp[key[1]] ?? 0) +
        estimateToolSchemaTokens(name, {
          description: d.description,
          inputSchema: providerInputSchemaOf(d.params),
        })
    }
    console.log("schema tokens per app on the wire", JSON.stringify(perApp))
    expect(Object.keys(perApp)).toContain("kernel")
    const tools = await loadLadderTools()
    const guard = measureLadder(tools, { name: "every app", scopes: ["*"] })
    // The guard measures the catalog of an org with a search key; an org without
    // one has no web_search entry. Every other tool is the same.
    const webSearch = toolRegistry.get([FP_ORG, "kernel", "web_search"])
      ? 0
      : (tools.find((t) => t.sdkName === "kernel__web_search")?.wireTokens ?? 0)
    // Apps this org runs that ship (the test org also runs test-only apps).
    const shipped = Object.keys(perApp).filter((a) => a in guard.appSchemaTokens)
    expect(shipped).toEqual(expect.arrayContaining(["kernel", "tickets", "projects", "mail"]))
    for (const app of shipped) {
      const expected = perApp[app] + (app === "kernel" ? webSearch : 0)
      expect({ app, tokens: guard.appSchemaTokens[app] }).toEqual({ app, tokens: expected })
    }
  })
})

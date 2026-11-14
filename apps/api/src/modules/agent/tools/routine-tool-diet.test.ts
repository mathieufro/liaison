// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CREATE_ROUTINE ON A DIET, NOTHING LOST. create_routine's arguments carried
// every authoring rule learnt from routines that failed (trigger choice, cron
// shapes, event mappings, digest shapes, watching, follow-ups, scopes, team
// visibility, run-as): about 13,000 tokens on every tools/list, paid by every
// conversation and every MCP client that never authors a routine. Each
// argument now keeps one line; the rules moved, word for word, to the kernel
// guide `prompts/kernel/routines.md`, which names create_routine and
// update_routine. Pinned here:
//
//   1. the tool's size on the wire, against its budget;
//   2. every sentence that left the tool is on the moves list, and is found at
//      the destination the list names;
//   3. the guide is not a skill: an org that forked the routine-authoring skill,
//      or disabled it, still gets the rules with the tool;
//   4. over MCP, a call missing what a trigger needs is answered with the rule,
//      and the guide rides on the first result of a call to either tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { asSchema } from "ai"
import { withSystemDb } from "~/db/privileged"
import { disabledAppSkills, skills, users } from "~/db/schema/kernel"
import { normalizeAppGuide } from "~/modules/agent/context/app-guide"
import { buildAppInstructionBlock, coveringGuideKeys } from "~/modules/agent/context/context"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  registerSkillRoutineTools,
  resolveAllSkills,
} from "~/modules/agent/tools/skills-routines-tools"
import { providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import { agentInstructionsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { appGuideSurfacedKey, selectAppGuideToSurface } from "~/modules/mcp/app-guide-surfacing"
import { seedMcpConnection } from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const GUIDE_KEY = "kernel-routines"
const ROUTINE_TOOLS = ["create_routine", "update_routine"] as const

/** The budget create_routine's schema must fit on tools/list, in wire tokens. */
const CREATE_ROUTINE_WIRE_BUDGET = 2_000
const overBudget = (tokens: number) => tokens > CREATE_ROUTINE_WIRE_BUDGET

interface MoveLine {
  tool: string
  field: string
  sentence: string
  to: string
}
const MOVES = JSON.parse(
  readFileSync(path.join(import.meta.dir, "tool-text-moves.json"), "utf8"),
) as { v: number; moves: MoveLine[] }

const fold = (s: string) => s.replace(/\s+/g, " ").trim()
/**
 * A moved sentence as its destination holds it. A guide is copy the model
 * quotes to people, held to the no-dash rule (scripts/lint-copy-dashes.ts), so
 * a spaced dash in a sentence taken off the tool arrives as a colon.
 */
const asGuideCopy = (s: string) => s.replace(/\s+[\u2013\u2014]\s+/g, ": ")

/** What a tool costs on tools/list: its name, description and projected input schema, chars / 4. */
function wireTokens(orgId: string, name: string): number {
  const def = toolRegistry.get([orgId, "kernel", name]) as
    | { description?: string; params?: unknown }
    | undefined
  if (!def) throw new Error(`kernel:${name} is not registered`)
  const projected = JSON.stringify(asSchema(providerInputSchemaOf(def.params) as never).jsonSchema)
  return Math.ceil(`kernel__${name}\n${def.description ?? ""}\n${projected}`.length / 4)
}

/** The tool's own text as the provider receives it: description plus each argument's. */
function toolText(orgId: string, name: string): string {
  const def = toolRegistry.get([orgId, "kernel", name]) as
    | { description?: string; params?: unknown }
    | undefined
  const js = asSchema(providerInputSchemaOf(def?.params) as never).jsonSchema as {
    properties?: Record<string, { description?: string }>
  }
  return fold(
    [
      def?.description ?? "",
      ...Object.values(js.properties ?? {}).map((p) => p.description ?? ""),
    ].join("\n"),
  )
}

/** The guide text the agent loop's note carries when `sdkName` is loaded. */
function guideNoteFor(orgId: string, sdkName: string): string {
  return fold(
    coveringGuideKeys(orgId, [sdkName])
      .map((key) => {
        const guide = agentInstructionsRegistry.get([orgId, key])
        return guide === undefined ? "" : buildAppInstructionBlock(key, guide)
      })
      .join("\n"),
  )
}

async function orgWithUser(): Promise<{ orgId: string; userId: string }> {
  const org = await createTestOrg()
  const userId = await withSystemDb("routine-diet-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `routine-diet-${crypto.randomUUID()}@example.test`,
        name: "Routine Author",
        passwordHash: "x",
      })
      .returning({ id: users.id })
    return u!.id
  })
  await registerKernelAgentTools(org.id)
  await registerSkillRoutineTools(org.id)
  return { orgId: org.id, userId }
}

describe("create_routine diet", () => {
  it("tools/list size of create_routine is at most 2,000 wire tokens", async () => {
    expect(overBudget(1_999)).toBe(false)
    expect(overBudget(2_000)).toBe(false)
    expect(overBudget(2_001)).toBe(true)
    const { orgId } = await orgWithUser()
    const create = wireTokens(orgId, "create_routine")
    const update = wireTokens(orgId, "update_routine")
    console.log(`create_routine on the wire: ${create} tokens; update_routine: ${update}`)
    expect(overBudget(create)).toBe(false)
  })

  it("tools/list size of update_routine is at most 2,000 wire tokens", async () => {
    const { orgId } = await orgWithUser()
    expect(overBudget(wireTokens(orgId, "update_routine"))).toBe(false)
  })

  it("update_routine takes flow and eventFilter as checked objects, the full shape only on a refusal", async () => {
    const { orgId } = await orgWithUser()
    const def = toolRegistry.get([orgId, "kernel", "update_routine"]) as {
      params: {
        safeParse: (v: unknown) => {
          success: boolean
          error?: { issues: Array<{ message: string }> }
        }
      }
    }
    const id = "00000000-0000-4000-8000-000000000001"
    const projected = JSON.stringify(
      asSchema(providerInputSchemaOf(def.params) as never).jsonSchema,
    )
    expect(projected).not.toContain('"steps"')
    for (const bad of [{ flow: { version: 2 } }, { eventFilter: { nope: [1] } }]) {
      const out = def.params.safeParse({ id, ...bad })
      expect(out.success).toBe(false)
      expect(out.error?.issues[0]?.message).toContain("has this shape")
    }
    expect(def.params.safeParse({ id, flow: null }).success).toBe(true)
    expect(def.params.safeParse({ id, prompt: "Summarise the week." }).success).toBe(true)
  })

  it("each argument of create_routine keeps one line of its own", async () => {
    const { orgId } = await orgWithUser()
    const def = toolRegistry.get([orgId, "kernel", "create_routine"]) as { params?: unknown }
    const js = asSchema(providerInputSchemaOf(def.params) as never).jsonSchema as {
      properties: Record<string, { description?: string }>
    }
    for (const field of [
      "kind",
      "cron",
      "event",
      "prompt",
      "scopes",
      "visibility",
      "ownerUserId",
    ]) {
      const line = js.properties[field]?.description ?? ""
      expect(`${field}: ${line.length > 0}`).toBe(`${field}: true`)
      expect(`${field}: ${line.includes("\n")}`).toBe(`${field}: false`)
    }
  })

  it("every sentence removed from the tool has a line in the moves list and is found at its destination", async () => {
    const { orgId } = await orgWithUser()
    const moved = MOVES.moves.filter((m) => ROUTINE_TOOLS.some((t) => m.tool === `kernel:${t}`))
    // The moves list is generated from the tool's text before and after the move; an empty list
    // for create_routine means the move was not recorded.
    expect(moved.filter((m) => m.tool === "kernel:create_routine").length).toBeGreaterThan(100)
    const guide = fold(
      normalizeAppGuide(agentInstructionsRegistry.get([orgId, GUIDE_KEY]) ?? "").core,
    )
    expect(guide.length).toBeGreaterThan(0)
    const notAtDestination: string[] = []
    const stillOnTool: string[] = []
    for (const m of moved) {
      const name = m.tool.split(":")[1]!
      if (toolText(orgId, name).includes(m.sentence)) stillOnTool.push(m.sentence)
      if (m.to !== `guide:${GUIDE_KEY}` || !guide.includes(asGuideCopy(m.sentence)))
        notAtDestination.push(`${m.to}: ${m.sentence}`)
    }
    expect(notAtDestination).toEqual([])
    expect(stillOnTool).toEqual([])
  })

  it("the routines guide is delivered with create_routine and with update_routine", async () => {
    const { orgId } = await orgWithUser()
    for (const name of ROUTINE_TOOLS) {
      expect(coveringGuideKeys(orgId, [`kernel__${name}`])).toContain(GUIDE_KEY)
    }
    // Not with another kernel tool: the rules cost nothing to a conversation that authors no routine.
    expect(coveringGuideKeys(orgId, ["kernel__list_routines"])).not.toContain(GUIDE_KEY)
  })
})

describe("the moved rules are not a skill", () => {
  const moved = MOVES.moves.filter((m) => m.tool === "kernel:create_routine")

  it("with a fork and with the skill disabled, the tool's guide note still delivers the moved rules", async () => {
    // An org that forked the routine-authoring skill with its own body.
    const forked = await orgWithUser()
    await withSystemDb("routine-diet-fork", async (db) => {
      await db.insert(skills).values({
        orgId: forked.orgId,
        authorUserId: null,
        name: "author-routine",
        description: "Our own routine playbook",
        body: "Ask the operations lead before creating any routine.",
        requiredScopes: [],
        forkedFrom: "kernel/author-routine",
        createdByUserId: forked.userId,
        createdByActorType: "user",
      })
    })
    // Each org is checked before the next is made (a test org starts from empty org tables).
    const noteMissing = (orgId: string) => {
      const note = guideNoteFor(orgId, "kernel__create_routine")
      return moved.filter((m) => !note.includes(asGuideCopy(m.sentence))).map((m) => m.sentence)
    }
    const forkSkills = await resolveAllSkills(forked.orgId, forked.userId, ["*"])
    const forkBody = forkSkills.find((s) => s.name === "author-routine")?.body ?? ""
    expect(forkBody).toBe("Ask the operations lead before creating any routine.")
    expect(noteMissing(forked.orgId)).toEqual([])

    // An org that turned the shipped skill off.
    const disabled = await orgWithUser()
    await withSystemDb("routine-diet-disable", async (db) => {
      await db.insert(disabledAppSkills).values({
        orgId: disabled.orgId,
        userId: null,
        appName: "kernel",
        skillName: "author-routine",
      })
    })
    const disabledSkills = await resolveAllSkills(disabled.orgId, disabled.userId, ["*"])
    expect(disabledSkills.some((s) => s.name === "author-routine")).toBe(false)
    expect(noteMissing(disabled.orgId)).toEqual([])
  })
})

describe("the moved rules over MCP", () => {
  async function mcpCtx(): Promise<ToolCallCtx> {
    const { orgId, userId } = await orgWithUser()
    const connection = await seedMcpConnection({
      orgId,
      userId,
      clientId: "routine-diet-client",
      label: "Routine diet",
    })
    return {
      orgId,
      actor: {
        actorType: "user",
        userId,
        orgId,
        scopes: ["kernel:routines:write", "kernel:routines:read"],
        dimensionGrants: {},
      },
      connectionId: connection.id,
      ownerUserId: userId,
      connectionThreadId: null,
      discovered: new Set(),
      surfacedSkills: new Set(),
    } as ToolCallCtx
  }
  const errorText = (r: unknown) =>
    ((r as { content?: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? "")
      .join("\n")
  const base = {
    name: "weekly-digest",
    description: "A weekly digest",
    prompt: "Read the open tickets and compose a digest.",
  }

  it("tools/call of create_routine over MCP without the required shape answers with the rule", async () => {
    const ctx = await mcpCtx()
    // A scheduled routine given a local wall-clock time instead of an absolute UTC instant.
    const local = await handleToolCall(ctx, "kernel__create_routine", {
      ...base,
      kind: "scheduled",
      runAt: "2026-05-08 07:00",
    })
    expect((local as { isError?: boolean }).isError).toBe(true)
    expect(errorText(local)).toContain("absolute UTC datetime such as '2026-05-08T05:00:00Z'")
    // An event routine with no event names the catalog to read.
    const noEvent = await handleToolCall(ctx, "kernel__create_routine", { ...base, kind: "event" })
    expect((noEvent as { isError?: boolean }).isError).toBe(true)
    expect(errorText(noEvent)).toContain("kind:'event' needs `event`")
    expect(errorText(noEvent)).toContain("kernel__list_routine_events")
    // A recurring routine (the default) with a cron and no timezone.
    const noZone = await handleToolCall(ctx, "kernel__create_routine", {
      ...base,
      cron: "0 8 * * 1",
    })
    expect(errorText(noZone)).toContain("needs `cron` (5 fields) and `timezone`")
  })

  it("the guide rides on the first MCP result of the tool", async () => {
    const ctx = await mcpCtx()
    for (const name of ROUTINE_TOOLS) {
      const first = selectAppGuideToSurface(ctx.orgId, `kernel:${name}`, new Set())
      expect(first?.keys).toContain(appGuideSurfacedKey(GUIDE_KEY))
      const text = fold(first?.text ?? "")
      for (const m of MOVES.moves.filter((x) => x.tool === "kernel:create_routine").slice(0, 25))
        expect(text).toContain(m.sentence)
      // Once delivered on the connection, it does not ride again.
      const again = selectAppGuideToSurface(ctx.orgId, `kernel:${name}`, new Set(first?.keys ?? []))
      expect(again?.keys ?? []).not.toContain(appGuideSurfacedKey(GUIDE_KEY))
    }
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SUB-AGENT RUN GETS THE GUIDES OF THE TOOLS IT LOADS.
//
// A thread delivers a tool's guides with its first load: its app's guide, and
// a kernel guide that names it (the routines guide names create_routine and
// update_routine). A sub-agent run used to get none of them, so a sub-agent
// that loaded create_routine authored routines without their rules. It now
// gets them the same way, in a note right after the step that loaded the
// tool; a run that never loads a covered tool never gets its guide. Real
// Anthropic provider, canned SSE at the fetch layer (no paid call).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { creditBalances, threads as kernelThreads, modelPricing } from "~/db/schema/kernel"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Part = { type: string; text?: string; content?: unknown; tool_use_id?: string }
type Body = { system: Part[]; messages: Array<{ role: string; content: Part[] | string }> }

const MODEL_ID = `claude-subrun-guide-${crypto.randomUUID().slice(0, 6)}`
const PAYLOAD = { draft: "d", confidence: 1 }
const SCOPES = [
  "kernel:threads:read",
  "kernel:routines:read",
  "kernel:routines:write",
  "kernel:users:admin",
]
/** A sentence only the routines guide carries. */
const ROUTINES_GUIDE_MARK = "Choosing the trigger"
/** Phrases only the kernel guide's sections about two kernel tools carry. */
const ACCESS_SECTION_MARK = "DETERMINISTIC SCOPE CHECK"
const ROLE_SECTION_MARK = "A vague 'created with the requested scopes' is INCOMPLETE"
/** A sentence of the kernel guide's core (the main agent's system prompt). */
const KERNEL_CORE_MARK = "Entity tagging: link every entity you mention"
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const realFetch = globalThis.fetch
let calls: Array<{ name: string; input: unknown }> = []
let bodies: Body[] = []

function toolUseResponse(step: number): Response {
  const call = calls[step] ?? calls[calls.length - 1]
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_guide_${step}`,
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: `toolu_guide_${step}`, name: call?.name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call?.input) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  return new Response(
    events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function textsOf(body: Body): string[] {
  return body.messages.flatMap((m) =>
    typeof m.content === "string"
      ? [m.content]
      : m.content.flatMap((p) => (typeof p.text === "string" ? [p.text] : [])),
  )
}

const isGuideNote = (text: string) => text.startsWith('<runtime-context note="app guides')

describe("the guides a sub-agent run receives", () => {
  let orgId: string
  let userId: string
  let threadId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-subrun-guide"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    for (const scope of SCOPES) await minimal.grantScope(userId, scope)
    await withSystemDb("subrun-guide-seed", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: MODEL_ID,
          displayName: "Subrun guide test",
          inputCostPerM: "0.0000001",
          outputCostPerM: "0.0000001",
          contextWindow: 200000,
          autoEligible: true,
          tierMinimum: "starter",
        })
        .onConflictDoNothing()
      await db
        .insert(creditBalances)
        .values({ orgId, includedBalance: "10.00000000", purchasedBalance: "0", currency: "EUR" })
        .onConflictDoNothing()
    })
    const [thread] = await withPrivilegedDb(orgId, "subrun-guide-thread", async (tx) =>
      tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `sg-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id }),
    )
    threadId = thread!.id
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
      const step = bodies.length
      bodies.push(JSON.parse(String(init?.body)) as Body)
      return toolUseResponse(step)
    }) as typeof fetch
    await startSubrunWorker()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await withSystemDb("subrun-guide-cleanup", async (db) => {
      const { eq } = await import("drizzle-orm")
      await db.delete(modelPricing).where(eq(modelPricing.modelId, MODEL_ID))
    })
    await releaseTestLock()
  })

  /** Runs a discovering sub-agent that loads `toolName` with tool_search, then finalizes. */
  async function runLoading(toolName: string): Promise<Body[]> {
    calls = [
      { name: "kernel__tool_search", input: { query: `select:${toolName}` } },
      { name: "finalize", input: PAYLOAD },
    ]
    bodies = []
    const agentType = `guide-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      agentType,
      whenToUse: "test",
      scopeCeiling: SCOPES,
      creatorScopes: SCOPES,
      systemPrompt: "You set up the routine you are asked for.",
    })
    const actor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    const handle = await spawnAgent({
      parentRun: { id: null, threadId, actor, nestingDepth: 0 },
      subagentType: agentType,
      description: "routine guide",
      prompt: "Every Monday at 8, summarise last week's tickets.",
      input: {},
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: { draft: { type: "string" }, confidence: { type: "number" } },
      },
    })
    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 20_000 })
    expect(result.ok).toBe(true)
    expect(bodies.length).toBeGreaterThanOrEqual(calls.length)
    return bodies
  }

  it("a sub-agent run that loads create_routine receives the routines guide after the load", async () => {
    const sent = await runLoading("kernel__create_routine")
    // Not before the load: the first request carries no guide note.
    expect(textsOf(sent[0] as Body).some(isGuideNote)).toBe(false)
    const notes = textsOf(sent[1] as Body).filter(isGuideNote)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("kernel-routines")
    expect(notes[0]).toContain(ROUTINES_GUIDE_MARK)
    // The kernel's own guide is the main agent's system prompt, not a sub-agent's.
    expect(notes[0]).not.toMatch(/parts="[^"]*\bkernel\b(?!-)/)
  }, 40_000)

  it("a sub-agent run that does not load create_routine does not receive the routines guide", async () => {
    const sent = await runLoading("kernel__list_routines")
    for (const body of sent) {
      expect(JSON.stringify(body.system)).not.toContain(ROUTINES_GUIDE_MARK)
      expect(textsOf(body).some((t) => t.includes(ROUTINES_GUIDE_MARK))).toBe(false)
    }
  }, 40_000)

  it("a sub-agent run that loads a kernel tool receives that tool's kernel guide section, not another's", async () => {
    const sent = await runLoading("kernel__describe_user_access")
    expect(textsOf(sent[0] as Body).some((t) => t.includes(ACCESS_SECTION_MARK))).toBe(false)
    const notes = textsOf(sent[1] as Body).filter(isGuideNote)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(ACCESS_SECTION_MARK)
    expect(notes[0]).not.toContain(ROLE_SECTION_MARK)
    // The section rides without the kernel guide's core, which a sub-agent never gets.
    expect(notes[0]).not.toContain(KERNEL_CORE_MARK)
  }, 40_000)

  it("a sub-agent run that loads no such kernel tool receives no kernel guide section", async () => {
    const sent = await runLoading("kernel__list_routines")
    for (const body of sent) {
      const all = `${JSON.stringify(body.system)}\n${textsOf(body).join("\n")}`
      expect(all).not.toContain(ACCESS_SECTION_MARK)
      expect(all).not.toContain(ROLE_SECTION_MARK)
    }
  }, 40_000)
})

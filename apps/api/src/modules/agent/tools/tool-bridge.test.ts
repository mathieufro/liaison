// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { asSchema } from "ai"
import { z } from "zod"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { MAX_MEMORY_CALLS_PER_TURN } from "~/modules/agent/context/cold-resume"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import {
  toScopeTaintBlockedError,
  UNDECLARED_WRITE_TARGET,
} from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listLockedCapabilities,
  MEMORY_CALL_CAP_CODE,
} from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cb0001"

describe("tool-bridge", () => {
  beforeAll(async () => {
    await acquireTestLock()
    // Register test tools
    toolRegistry.set([ORG_ID, "test", "listItems"], {
      appName: "test",
      name: "listItems",
      description: "List test items",
      requiredScopes: ["test:items:read"],
      handler: async () => [{ id: "1", title: "Item 1" }],
      params: z.object({ status: z.string().optional() }),
    })
    toolRegistry.set([ORG_ID, "test", "createItem"], {
      appName: "test",
      name: "createItem",
      description: "Create a test item",
      requiredScopes: ["test:items:write"],
      handler: async () => ({ id: "2", title: "New" }),
      params: z.object({ title: z.string() }),
    })
    toolRegistry.set([ORG_ID, "test", "riskyAction"], {
      appName: "test",
      name: "riskyAction",
      description: "A gated action",
      requiredScopes: ["test:items:write"],
      gated: true,
      handler: async () => ({ ok: true }),
      params: z.object({ action: z.string() }),
    })
    toolRegistry.set([ORG_ID, "test", "fieldMapTool"], {
      appName: "test",
      name: "fieldMapTool",
      description: "Tool with field-map params",
      requiredScopes: ["test:items:read"],
      handler: async (params: any) => ({ echo: params }),
      params: { name: "string", count: "number" } as any,
    })
    // JSON-Schema-format (manifest tool) params with an `integer` field —
    // mirrors `knowledge:update`'s `revision` param (DEFECT 2, 2026-07-15).
    toolRegistry.set([ORG_ID, "test", "revisionTool"], {
      appName: "test",
      name: "revisionTool",
      description: "Tool with a JSON-Schema integer param",
      requiredScopes: ["test:items:read"],
      handler: async (params: any) => ({ echo: params }),
      params: {
        type: "object",
        properties: { id: { type: "string" }, revision: { type: "integer" } },
        required: ["id", "revision"],
      } as any,
    })
    toolRegistry.set([ORG_ID, "test", "noParamsTool"], {
      appName: "test",
      name: "noParamsTool",
      description: "Tool with no params",
      requiredScopes: ["test:items:read"],
      handler: async () => ({ ok: true }),
    })
    // Tool for different org — should not appear
    toolRegistry.set(["other-org", "test", "otherOrgTool"], {
      appName: "test",
      name: "otherOrgTool",
      description: "Other org tool",
      requiredScopes: ["test:items:read"],
      handler: async () => ({}),
    })
    // Routine-only tool (mirrors web_watch / watch_state): callable ONLY when the run frame is a
    // routine tick (runFrame.routineId set). Used to pin the routineId-admission plumbing.
    toolRegistry.set([ORG_ID, "test", "routineOnlyTool"], {
      appName: "test",
      name: "routineOnlyTool",
      description: "A routine-only tool",
      requiredScopes: ["test:items:read"],
      routineOnly: true,
      handler: async () => ({ ok: true }),
      params: z.object({ key: z.string() }),
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    toolRegistry.deleteByPrefix(["other-org"])
    await releaseTestLock()
  })

  it("includes tools user has scope for and excludes others", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect("test__listItems" in tools).toBe(true)
    expect("test__fieldMapTool" in tools).toBe(true)
    expect("test__noParamsTool" in tools).toBe(true)
    // User lacks test:items:write
    expect("test__createItem" in tools).toBe(false)
    expect("test__riskyAction" in tools).toBe(false)
  })

  it("includes gated tools when user has scope", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read", "test:items:write"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect("test__riskyAction" in tools).toBe(true)
  })

  it("EXCLUDES a routine-only tool when there is no routine run frame (interactive chat / sub-run)", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read"],
      dimensionGrants: {},
    }
    // No runFrame.routineId → routine-only tools are invisible (the interactive-chat case).
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect("test__routineOnlyTool" in tools).toBe(false)
    // …and still excluded when a runFrame exists but carries NO routineId.
    const toolsNoRoutine = buildToolSet(
      ORG_ID,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      {
        runId: "r1",
        parentRunId: null,
        rootRunId: "r1",
        nestingDepth: 0,
        background: true,
      } as never,
    )
    expect("test__routineOnlyTool" in toolsNoRoutine).toBe(false)
  })

  it("ADMITS a routine-only tool when the run frame is a routine tick (runFrame.routineId set)", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read"],
      dimensionGrants: {},
    }
    // A routine tick stamps routineId on the frame (the kernel-jobs → invokeAgentForThread →
    // runAgentChat plumbing) → buildToolSet admits the routine-only tool. This is the fix that lets a
    // web_watch routine's tick actually call web_watch instead of reporting it "unavailable".
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", {
      runId: "r1",
      parentRunId: null,
      rootRunId: "r1",
      nestingDepth: 0,
      background: true,
      routineId: "routine-123",
    } as never)
    expect("test__routineOnlyTool" in tools).toBe(true)
  })

  it("returns empty object when user has no matching scopes", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["unrelated:scope"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(Object.keys(tools).length).toBe(0)
  })

  it("excludes tools from other orgs", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect("test__otherOrgTool" in tools).toBe(false)
  })

  it("each tool has description and input schema", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const listTool = tools.test__listItems
    expect(listTool).toBeDefined()
    expect(listTool.description).toBe("List test items")
    expect((listTool as any).inputSchema).toBeDefined()
  })

  // DEFECT 2 (2026-07-15) — a JSON-Schema `{ type: "integer" }` param (e.g.
  // knowledge:update's `revision`) was silently dropped to `z.any()` by
  // `convertParams`'s FIELD_TYPE_MAP, which had no "integer" entry — so the
  // MCP-projected schema for that field lost its type entirely (surfaced as
  // `{}`), and the underlying zod field accepted anything. Assert the
  // projected Zod field is a real number/integer schema, and that both a
  // number and a numeric STRING (MCP transport can round-trip either) parse
  // successfully.
  it("projects a JSON-Schema `integer` param as a coercing integer Zod field, not z.any()", async () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "gateway")
    const revisionTool = tools.test__revisionTool
    expect(revisionTool).toBeDefined()
    // A model's tool set validates the same way, through the SDK's schema.
    const forModel = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const validate = asSchema(forModel.test__revisionTool.inputSchema).validate
    expect((await validate?.({ id: "a", revision: "not-a-number" }))?.success).toBe(false)
    expect(await validate?.({ id: "a", revision: "2" })).toEqual({
      success: true,
      value: { id: "a", revision: 2 },
    })
    const shape = (revisionTool as any).inputSchema.shape as Record<string, z.ZodTypeAny>
    // A dropped-to-z.any() field would happily parse a non-numeric string too —
    // the real regression signature. Assert it rejects one.
    expect(shape.revision.safeParse("not-a-number").success).toBe(false)
    // Both a number and a numeric STRING (revision: "2") must parse — MCP
    // transport can round-trip either depending on the client.
    expect(shape.revision.safeParse(2).success).toBe(true)
    expect(shape.revision.safeParse("2").success).toBe(true)
    expect(shape.revision.safeParse("2.0").success).toBe(true)
    // Coerced to an actual number, not left as a string.
    const parsed = shape.revision.safeParse("2")
    expect(parsed.success && parsed.data).toBe(2)
  })

  it("generated tool execute wrapper calls the registered handler and returns its result", async () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const listTool = tools.test__listItems
    expect(listTool).toBeDefined()

    // Execute the generated AI SDK tool wrapper directly
    const result = await (listTool as any).execute({ status: "active" }, {})
    // The handler returns [{ id: "1", title: "Item 1" }]
    expect(Array.isArray(result)).toBe(true)
    expect((result as any[])[0].id).toBe("1")
  }, 15_000)

  it("strips a model-supplied host-only __mailbox* parameter before the tool runs", async () => {
    const seen: unknown[] = []
    toolRegistry.set([ORG_ID, "test", "hostOnlyEcho"], {
      appName: "test",
      name: "hostOnlyEcho",
      description: "Echo what reached the handler",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async (params: unknown) => {
        seen.push(params)
        return { ok: true }
      },
      params: z.object({
        fileId: z.string(),
        __mailboxAttachments: z.record(z.string(), z.string()).optional(),
      }),
    })
    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["test:items:read"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const echo = tools.test__hostOnlyEcho as unknown as {
      execute: (args: unknown, opts: object) => Promise<unknown>
    }
    await echo.execute({ fileId: "f1", __mailboxAttachments: { f1: "SU5KRUNURUQ=" } }, {})
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ fileId: "f1" })
  }, 15_000)

  it("execute wrapper catches handler errors and returns error object instead of throwing", async () => {
    toolRegistry.set([ORG_ID, "test", "failingTool"], {
      appName: "test",
      name: "failingTool",
      description: "A tool that always fails",
      requiredScopes: ["test:items:read"],
      handler: async () => {
        throw new Error("handler exploded")
      },
      params: z.object({}),
    })

    try {
      const actor: UserContext = {
        actorType: "user",
        userId: "user1",
        orgId: ORG_ID,
        scopes: ["test:items:read"],
        dimensionGrants: {},
      }
      const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
      const failTool = tools.test__failingTool
      expect(failTool).toBeDefined()

      // Should return an error object, not throw
      const result = await (failTool as any).execute({}, {})
      expect(result).toHaveProperty("error")
    } finally {
      toolRegistry.deleteByPrefix([ORG_ID, "test", "failingTool"])
    }
  })

  it("scope-denied tool error becomes an actionable, request-aware message", async () => {
    // Simulate the exact shape executeTool throws on a scope denial: a plain
    // Error with status:403 + code:"forbidden" + message "missing scope: <scope>".
    toolRegistry.set([ORG_ID, "test", "scopeDeniedTool"], {
      appName: "test",
      name: "scopeDeniedTool",
      description: "A tool whose execution is scope-denied",
      requiredScopes: ["test:items:read"],
      handler: async () => {
        throw Object.assign(new Error("missing scope: test:locked:thing"), {
          status: 403,
          code: "forbidden",
        })
      },
      params: z.object({}),
    })

    try {
      const actor: UserContext = {
        actorType: "user",
        userId: "user1",
        orgId: ORG_ID,
        scopes: ["test:items:read"],
        dimensionGrants: {},
      }
      const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
      const t = tools.test__scopeDeniedTool
      expect(t).toBeDefined()

      const result = (await (t as any).execute({}, {})) as { error?: string }
      expect(result.error).toBeDefined()
      // Names the exact missing scope...
      expect(result.error).toContain("test:locked:thing")
      // ...and points at the request affordance.
      expect(result.error).toContain("request_scope")
      // Not the generic degraded message.
      expect(result.error).not.toBe("Tool execution failed")
    } finally {
      toolRegistry.deleteByPrefix([ORG_ID, "test", "scopeDeniedTool"])
    }
  })

  it("non-scope handler error surfaces full diagnostic detail (tool · status · message), never a bare swallow", async () => {
    // Error reporting & field observability convention (docs/conventions.md): a tool that
    // fails upstream must surface the REAL signal — tool name + HTTP status + message — to the
    // agent (and the log), never a detail-less "Tool execution failed" that makes the agent loop.
    toolRegistry.set([ORG_ID, "test", "upstreamErrTool"], {
      appName: "test",
      name: "upstreamErrTool",
      description: "A tool whose upstream call fails with a status",
      requiredScopes: ["test:items:read"],
      handler: async () => {
        throw Object.assign(new Error("invalid email domain"), {
          status: 422,
          code: "unprocessable_entity",
          body: { errors: ["email: domain not deliverable"] },
        })
      },
      params: z.object({}),
    })

    try {
      const actor: UserContext = {
        actorType: "user",
        userId: "user1",
        orgId: ORG_ID,
        scopes: ["test:items:read"],
        dimensionGrants: {},
      }
      const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
      const t = tools.test__upstreamErrTool
      expect(t).toBeDefined()

      const result = (await (t as any).execute({}, {})) as { error?: string }
      expect(result.error).toBeDefined()
      // Carries the REAL diagnostic end-to-end — tool name + the handler's PRECISE upstream status
      // (422, NOT a flattened 500) + its code + message + the upstream body — never a bare swallow
      // (docs/conventions.md "Error reporting & field observability").
      expect(result.error).toContain("upstreamErrTool")
      expect(result.error).toContain("422")
      expect(result.error).toContain("unprocessable_entity")
      expect(result.error).toContain("invalid email domain")
      expect(result.error).toContain("domain not deliverable")
      expect(result.error).not.toBe("Tool execution failed")
    } finally {
      toolRegistry.deleteByPrefix([ORG_ID, "test", "upstreamErrTool"])
    }
  })
})

describe("tool bridge — threadId and approvalRequestId passthrough", () => {
  const BRIDGE_ORG = "00000000-0000-0000-0000-000000d40001"
  const BRIDGE_USER = "00000000-0000-0000-0000-000000d40002"
  const BRIDGE_THREAD = "00000000-0000-0000-0000-000000d40003"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${BRIDGE_ORG}, 'BridgeOrg', 'bridge-org', '{"webContentProtection":"hardened"}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${BRIDGE_USER}, ${BRIDGE_ORG}, 'br@test.com', 'Bridge User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${BRIDGE_THREAD}, ${BRIDGE_ORG}, 'bridge-tainted', 'agent_chat', ${BRIDGE_USER}, true) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${BRIDGE_THREAD}, ${BRIDGE_USER}, ${BRIDGE_ORG}) ON CONFLICT DO NOTHING`

    toolRegistry.set([BRIDGE_ORG, "test_br", "risky_action"], {
      appName: "test_br",
      name: "risky_action",
      description: "A gated action with no thread to anchor its approval",
      requiredScopes: ["test_br:risky"],
      gated: true,
      handler: async () => ({ ok: true }),
    })

    toolRegistry.set([BRIDGE_ORG, "test_br", "noted_tool"], {
      appName: "test_br",
      name: "noted_tool",
      description: "Gated tool whose gate has the agent relay a note",
      requiredScopes: ["test_br:trust"],
      trustBoundary: "user",
      gated: true,
      handler: async () => ({ ok: true }),
      params: z.object({ what: z.string() }),
      gatedAgentNotes: async (params: unknown) => ({
        nodeGuardrails: {
          riskNote: `note for ${(params as { what?: string }).what}`,
          relay: "Before you confirm this to the user, tell them this risk note.",
        },
      }),
    })

    toolRegistry.set([BRIDGE_ORG, "test_br", "trust_tool"], {
      appName: "test_br",
      name: "trust_tool",
      description: "Trust boundary tool",
      requiredScopes: ["test_br:trust"],
      trustBoundary: "user",
      handler: async () => ({ ok: true }),
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([BRIDGE_ORG])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${BRIDGE_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${BRIDGE_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${BRIDGE_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${BRIDGE_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${BRIDGE_ORG}`
  })

  const actor = {
    actorType: "user" as const,
    userId: BRIDGE_USER,
    orgId: BRIDGE_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }

  // A gated call with NO thread used to be refused outright ("threadId
  // required"). It now parks a reviewable approval on a surface thread created
  // for that request, because refusing wedged the OUTER approval back to
  // pending whenever a gated cross-app call was made from inside an approved
  // handler. What must stay true is that the call never EXECUTES: it blocks.
  it("a gated tool with no threadId parks an approval instead of refusing", async () => {
    const tools = buildToolSet(BRIDGE_ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const risky = tools.test_br__risky_action
    expect(risky).toBeDefined()

    const result = (await (risky as any).execute({ action: "delete-everything" }, {})) as {
      error?: string
      blocked?: boolean
      approvalRequestId?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.blocked).toBe(true)
    expect(typeof result.approvalRequestId).toBe("string")
    const [row] = await sql`
      SELECT thread_id FROM kernel.approval_requests WHERE id = ${result.approvalRequestId!}::uuid`
    expect(row.thread_id).toBeTruthy()
  })

  it("blocked result includes approvalRequestId", async () => {
    const tools = buildToolSet(BRIDGE_ORG, actor, BRIDGE_THREAD, ALL_DEFERRED_TOOLS_UNLOCKED)
    const t = tools.test_br__trust_tool
    expect(t).toBeDefined()

    const result = await (t as any).execute({})
    expect(result).toHaveProperty("blocked", true)
    expect(result).toHaveProperty("approvalRequestId")
    expect(typeof result.approvalRequestId).toBe("string")
    // The `request-N` label the approval card prints, so the agent can cite a
    // reference the reviewer can actually see (the uuid is hover-only).
    expect(result.approvalHandle).toMatch(/^request-\d+$/)
    expect(String(result.message)).toContain("approvalHandle")
    // LOAD-BEARING gated-status return (l505): since gating language is stripped from all prompts,
    // this message is the SOLE source of truth and must carry the full status-honesty signal.
    expect(result.status).toBe("pending_approval")
    const msg = String(result.message)
    expect(msg).toMatch(/pending|approval/i) // it is pending approval
    expect(msg).toMatch(/has not executed|did not execute|not.{0,4}execut/i) // the action did NOT run
    expect(msg).toMatch(/nothing was created|does not exist yet|do not (say|claim)/i) // anti-overclaim
    expect(msg).toMatch(/do not call this tool again|do not retry/i) // no duplicate requests
    expect(msg).toMatch(/approvalRequestId|@ref|chain/i) // the pause-or-chain affordance
    // WHO unblocks it — the half that was missing. Reporting "pending" without
    // naming the human decision leaves the approver un-asked and the user
    // believing the platform is broken (2026-09-11 Elevator Sound session).
    expect(msg).toContain("WHO MUST ACT")
    // This actor holds "*", so it is in the decision audience.
    expect(msg).toContain("IS an eligible approver")
    // The complaint route: read the queue, never silently re-stage the action.
    expect(msg).toContain("kernel__approvals_list")
    // Parity with the MCP seam's field of the same name.
    expect(result.selfApproveEligible).toBe(true)
  }, 15_000)

  // D18 (walk 2026-10-12, N14): a gated node routine never showed the agent its
  // guardrail risk note; the gate now adds the tool's notes and their relay order.
  it("a gated tool's agent notes ride on the pending result and its message", async () => {
    // Both gates: the untrusted-content one (this thread is tainted) and the
    // plain one (no thread: the approval parks on a surface thread).
    for (const thread of [BRIDGE_THREAD, undefined]) {
      const tools = buildToolSet(BRIDGE_ORG, actor, thread, ALL_DEFERRED_TOOLS_UNLOCKED)
      const result = await (tools.test_br__noted_tool as any).execute({ what: "routine" }, {})
      expect(result).toHaveProperty("blocked", true)
      expect(result.reason).toBe(thread ? "taint_escalation" : "gated")
      expect(result.nodeGuardrails?.riskNote).toBe("note for routine")
      expect(String(result.message)).toContain(
        "This result carries `nodeGuardrails`: Before you confirm this to the user, tell them this risk note.",
      )
    }
  }, 15_000)

  it("a turn without kernel:approvals:read is never told to call kernel__approvals_list", async () => {
    // An agent told to call a tool it does not hold calls it anyway, and the SDK
    // fails the call as an unavailable tool instead of the agent answering.
    const narrowActor = { ...actor, scopes: ["test_br:trust"] }
    const tools = buildToolSet(BRIDGE_ORG, narrowActor, BRIDGE_THREAD, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(tools.kernel__approvals_list).toBeUndefined()
    const result = await (tools.test_br__trust_tool as any).execute({})
    expect(result).toHaveProperty("blocked", true)
    const msg = String(result.message)
    expect(msg).toContain("WHO MUST ACT")
    expect(msg).not.toContain("kernel__approvals_list")
    expect(msg).toContain("approvals queue")
  }, 15_000)
})

describe("tool bridge: fail-closed catalog on declared required scopes", () => {
  const SCOPE_ORG = "00000000-0000-0000-0000-000000d50001"

  const actorWith = (scopes: string[]): UserContext => ({
    actorType: "user",
    userId: "00000000-0000-0000-0000-000000d50002",
    orgId: SCOPE_ORG,
    scopes,
    dimensionGrants: {},
  })

  beforeAll(async () => {
    await acquireTestLock()
    // A tool declaring no `requiredScopes`. Registration refuses that shape, so
    // the fixture writes the map entry past the registry's validator to model
    // a definition that slipped through.
    toolRegistry.set([SCOPE_ORG, "fc", "noScopeTool"], {
      appName: "fc",
      name: "noScopeTool",
      description: "Declares no scope at all",
      requiredScopes: ["fc:placeholder"],
      handler: async () => ({ ok: true }),
    })
    const slipped = toolRegistry.get([SCOPE_ORG, "fc", "noScopeTool"]) as {
      requiredScopes?: string[]
    }
    delete slipped.requiredScopes
    // A kernel registration needing two distinct grants.
    toolRegistry.set([SCOPE_ORG, "fc", "multiScopeTool"], {
      appName: "fc",
      name: "multiScopeTool",
      description: "Needs two distinct grants",
      requiredScopes: ["a:b:read", "a:c:write"],
      handler: async () => ({ ok: true }),
    })
    // The same need registered the way the manifest projection does.
    toolRegistry.set([SCOPE_ORG, "fc", "requiredOnlyTool"], {
      appName: "fc",
      name: "requiredOnlyTool",
      description: "Needs two distinct grants, declared as a manifest tool",
      requiredScopes: ["a:b:read", "a:c:write"],
      handler: async () => ({ ok: true }),
    })
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(SCOPE_ORG)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([SCOPE_ORG])
    skillRegistry.deleteByPrefix([SCOPE_ORG])
    agentInstructionsRegistry.deleteByPrefix([SCOPE_ORG])
    await releaseTestLock()
  })

  it("buildToolSet still excludes a tool that declares no scope at all, as a regression guard on the new resolveRequiredScopes path", () => {
    for (const audience of ["agent", "gateway"] as const) {
      const tools = buildToolSet(
        SCOPE_ORG,
        actorWith(["*"]),
        undefined,
        ALL_DEFERRED_TOOLS_UNLOCKED,
        audience,
      )
      expect(Object.keys(tools)).not.toContain("fc__noScopeTool")
      // The wildcard actor still sees scoped tools, so the absence above is the
      // fail-closed gate and not an empty catalog.
      expect(Object.keys(tools)).toContain("fc__multiScopeTool")
    }
  })

  it("buildToolSet requires ALL scopes in requiredScopes, not just one", () => {
    const catalog = (scopes: string[]) =>
      Object.keys(
        buildToolSet(SCOPE_ORG, actorWith(scopes), undefined, ALL_DEFERRED_TOOLS_UNLOCKED),
      )
    for (const sdkName of ["fc__multiScopeTool", "fc__requiredOnlyTool"]) {
      expect(catalog(["a:b:read"])).not.toContain(sdkName)
      expect(catalog(["a:c:write"])).not.toContain(sdkName)
      expect(catalog(["a:b:read", "a:c:write"])).toContain(sdkName)
    }
  })

  it("listDeferredTools locks a multi-scope tool until the actor holds every resolved scope", () => {
    for (const sdkName of ["fc__multiScopeTool", "fc__requiredOnlyTool"]) {
      const find = (scopes: string[], includeLocked: boolean) =>
        listDeferredTools(SCOPE_ORG, actorWith(scopes), "agent", includeLocked).find(
          (t) => t.sdkName === sdkName,
        )
      const partial = find(["a:b:read"], true)
      expect(partial?.locked).toBe(true)
      expect(partial?.requiredScope).toBe("a:c:write")
      expect(find([], true)?.requiredScope).toBe("a:b:read, a:c:write")
      expect(find(["a:b:read"], false)).toBeUndefined()

      const both = find(["a:b:read", "a:c:write"], false)
      expect(both).toBeDefined()
      expect(both?.locked).toBeUndefined()
    }
  })

  it("listLockedCapabilities names every missing scope of a multi-scope tool", () => {
    for (const name of ["fc__multiScopeTool", "fc__requiredOnlyTool"]) {
      const entry = (scopes: string[]) =>
        listLockedCapabilities(scopes, SCOPE_ORG).find((t) => t.name === name)
      expect(entry(["a:b:read"])?.scope).toBe("a:c:write")
      expect(entry([])?.scope).toBe("a:b:read, a:c:write")
      expect(entry(["a:b:read", "a:c:write"])).toBeUndefined()
    }
  })

  it("a tool that declares no scope is never offered as locked, since no grant unlocks it", () => {
    for (const scopes of [[], ["*"]]) {
      const deferred = listDeferredTools(SCOPE_ORG, actorWith(scopes), "agent", true)
      expect(deferred.map((t) => t.sdkName)).not.toContain("fc__noScopeTool")
    }
    const locked = listLockedCapabilities([], SCOPE_ORG)
    expect(locked.map((t) => t.name)).not.toContain("fc__noScopeTool")
  })

  it("buildToolSet admits a kernel tool declaring a single required scope", () => {
    const def = toolRegistry.get([SCOPE_ORG, "kernel", "memory_view"])
    expect(def?.requiredScopes).toEqual(["kernel:agent:memory"])

    const granted = buildToolSet(
      SCOPE_ORG,
      actorWith(["kernel:agent:memory"]),
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    expect(Object.keys(granted)).toContain("kernel__memory_view")

    const denied = buildToolSet(
      SCOPE_ORG,
      actorWith(["a:b:read"]),
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    expect(Object.keys(denied)).not.toContain("kernel__memory_view")
  })
})

describe("tool bridge: scope taint in the execute path", () => {
  const TAINT_ORG = "00000000-0000-0000-0000-000000d60001"
  const TAINT_USER = "00000000-0000-0000-0000-000000d60002"

  const actor: UserContext = {
    actorType: "user",
    userId: TAINT_USER,
    orgId: TAINT_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }

  // Every tool below records the names of the handlers that actually ran.
  const ran: string[] = []
  const spy = (name: string) => async () => {
    ran.push(name)
    return { ok: true, ran: name }
  }
  const anyParams = z.object({}).passthrough()

  // The taint-relevant metadata of a real kernel registration (T18's annotated
  // tools), with only the handler and params swapped for a spy.
  const kernelSpy = (name: string) => {
    const real = toolRegistry.get([TAINT_ORG, "kernel", name])
    if (!real) throw new Error(`kernel tool ${name} is not registered`)
    toolRegistry.set([TAINT_ORG, "kernel", name], {
      appName: "kernel",
      name,
      description: real.description,
      requiredScopes: real.requiredScopes,
      ...(real.writesToTable !== undefined ? { writesToTable: real.writesToTable } : {}),
      ...(real.readOnly !== undefined ? { readOnly: real.readOnly } : {}),
      params: anyParams,
      handler: spy(name),
    })
  }

  const frameWith = (seed: string[] = []): RunContext => {
    const accumulator = createTurnScopeAccumulator()
    for (const scope of seed) accumulator.record({ requiredScopes: [scope] })
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      turnScopeAccumulator: accumulator,
    } as RunContext
  }

  // Rule 8 (scope-taint.ts): the bridge defers every write to the dispatch, which parks what
  // taint would refuse for an approver holding the taint. The acting user holds `*`, so they
  // may approve it themselves: the call parks, unrun, instead of being refused.
  const expectParkedUnrun = (result: unknown) => {
    const r = result as { blocked?: unknown; status?: unknown }
    expect(JSON.stringify(result)).not.toContain("E_SCOPE_TAINT_BLOCKED")
    expect(r.blocked).toBe(true)
    expect(r.status).toBe("pending_approval")
  }

  const call = (frame: RunContext | undefined, sdkName: string, args: unknown = {}) => {
    const tools = buildToolSet(
      TAINT_ORG,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame,
    )
    const t = tools[sdkName]
    if (!t) throw new Error(`${sdkName} is not in the catalog`)
    return (t as any).execute(args)
  }

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TAINT_ORG}, 'TaintOrg', 'taint-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${TAINT_USER}, ${TAINT_ORG}, 'taint@test.com', 'Taint User', 'x') ON CONFLICT DO NOTHING`
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(TAINT_ORG)
    for (const name of ["contacts_write", "threads_reply", "user_memory_set"]) kernelSpy(name)

    const testTool = (name: string, extra: Record<string, unknown>) =>
      toolRegistry.set([TAINT_ORG, "taint_t", name], {
        appName: "taint_t",
        name,
        description: `taint test tool ${name}`,
        requiredScopes: [`taint_t:${name.replace(/_/g, "-")}:run`],
        params: anyParams,
        handler: spy(name),
        ...extra,
      })
    // Reads scoped data into the turn: the prior call that taints it.
    testTool("scoped_read", { readOnly: true })
    toolRegistry.set([TAINT_ORG, "taint_t", "strict_read"], {
      appName: "taint_t",
      name: "strict_read",
      description: "A read with a required argument",
      requiredScopes: ["taint_t:strict-read:run"],
      readOnly: true,
      params: z.object({ id: z.string() }).strict(),
      handler: spy("strict_read"),
    })
    testTool("undeclared_write", {})
    testTool("declared_other", { writesToTable: "app_taint_t.items" })
    // Taint-free but a write: it must not taint the turn, and its own write is still checked.
    testTool("taint_free_write", { taintFree: true })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([TAINT_ORG])
    skillRegistry.deleteByPrefix([TAINT_ORG])
    agentInstructionsRegistry.deleteByPrefix([TAINT_ORG])
    // Parked calls (rule 8) leave approvals and their hidden surface threads behind.
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TAINT_ORG}`
    await releaseTestLock()
  })

  it("a tool call writing to a non-enforcing sink parks for approval instead of running once the turn has accumulated scoped data", async () => {
    ran.length = 0
    const frame = frameWith()
    // A prior call in the same turn reads scoped data.
    await call(frame, "taint_t__scoped_read")
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual(["taint_t:scoped-read:run"])
    const result = await call(frame, "kernel__contacts_write")
    expectParkedUnrun(result)
    expect(ran).toEqual(["scoped_read"])
  })

  it("the same tool succeeds normally when the turn has touched no scoped data", async () => {
    ran.length = 0
    const result = await call(frameWith(), "kernel__contacts_write")
    expect(result).not.toEqual(
      toScopeTaintBlockedError("kernel.contacts", ["taint_t:scoped-read:run"]),
    )
    expect(ran).toEqual(["contacts_write"])
  })

  it("a tool writing to an enforcing sink (messages/agent_memory) always succeeds regardless of accumulated scope", async () => {
    ran.length = 0
    const frame = frameWith(["a:b:read"])
    for (const sdkName of ["kernel__threads_reply", "kernel__user_memory_set"]) {
      const result = await call(frame, sdkName)
      expect((result as { code?: string }).code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    }
    expect(ran).toEqual(["threads_reply", "user_memory_set"])
  })

  it("a tainted turn parks an undeclared, non-read-only tool without invoking it", async () => {
    ran.length = 0
    const result = await call(frameWith(["a:b:read"]), "taint_t__undeclared_write")
    expectParkedUnrun(result)
    expect(ran).toEqual([])
  })

  it("a tainted turn allows a read-only tool", async () => {
    ran.length = 0
    await call(frameWith(["a:b:read"]), "taint_t__scoped_read")
    expect(ran).toEqual(["scoped_read"])
  })

  it("a tainted turn parks a write to a declared non-enforcing table without invoking it", async () => {
    ran.length = 0
    const result = await call(frameWith(["a:b:read"]), "taint_t__declared_other")
    expectParkedUnrun(result)
    expect(ran).toEqual([])
  })

  it("an untainted turn allows everything", async () => {
    ran.length = 0
    const names = [
      "taint_t__undeclared_write",
      "taint_t__declared_other",
      "taint_t__scoped_read",
      "kernel__contacts_write",
      "kernel__threads_reply",
    ]
    // A fresh turn per call: each call's own scope must not taint that same call.
    for (const sdkName of names) await call(frameWith(), sdkName)
    expect(ran).toEqual([
      "undeclared_write",
      "declared_other",
      "scoped_read",
      "contacts_write",
      "threads_reply",
    ])
  })

  it("a call parked by the taint (rule 8) never ran, so it adds nothing to the turn's scope set", async () => {
    const frame = frameWith(["a:b:read"])
    await call(frame, "taint_t__undeclared_write")
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual(["a:b:read"])
  })

  // Walk N5. The turn's scopes stamp its reply, so a refused call's scopes would outlive the turn.
  it("a call refused for bad arguments read nothing, so the turn records nothing", async () => {
    ran.length = 0
    const frame = frameWith()
    const refused = (await call(frame, "taint_t__strict_read", { nope: 1 })) as { error?: string }
    expect(refused.error).toContain("strict_read")
    expect(ran).toEqual([])
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
    await call(frame, "taint_t__strict_read", { id: "a" })
    expect(ran).toEqual(["strict_read"])
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual(["taint_t:strict-read:run"])
  })

  it("tool_search then an app write: discovery does not taint the turn, so the write runs", async () => {
    ran.length = 0
    const frame = frameWith()
    // The real kernel tool_search handler, not a spy: the model discovers the tool first.
    const found = (await call(frame, "kernel__tool_search", {
      query: "select:taint_t__undeclared_write",
    })) as { matches?: Array<{ name: string }> }
    expect(found.matches?.map((m) => m.name)).toEqual(["taint_t__undeclared_write"])
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
    const result = await call(frame, "taint_t__undeclared_write")
    expect(result).not.toEqual(
      toScopeTaintBlockedError(UNDECLARED_WRITE_TARGET, ["taint_t:scoped-read:run"]),
    )
    expect(ran).toEqual(["undeclared_write"])
  })

  it("open_app, list_locked_capabilities and list_scopes leave the turn untainted, so a later app write runs", async () => {
    const calls: Array<[string, unknown]> = [
      ["kernel__open_app", { app: "tickets" }],
      ["kernel__list_locked_capabilities", {}],
      ["kernel__list_scopes", {}],
    ]
    for (const [sdkName, args] of calls) {
      ran.length = 0
      const frame = frameWith()
      const out = (await call(frame, sdkName, args)) as { error?: unknown }
      expect(out?.error).toBeUndefined()
      expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
      await call(frame, "taint_t__undeclared_write")
      expect(ran).toEqual(["undeclared_write"])
    }
  })

  it("an app read followed by an app write still never runs inline, discovery or not", async () => {
    ran.length = 0
    const frame = frameWith()
    await call(frame, "kernel__tool_search", { query: "select:taint_t__scoped_read" })
    await call(frame, "taint_t__scoped_read")
    const result = await call(frame, "taint_t__undeclared_write")
    expectParkedUnrun(result)
    expect(ran).toEqual(["scoped_read"])
  })

  it("a taint-free tool does not record its scope, but its own write is still checked", async () => {
    ran.length = 0
    const clean = frameWith()
    await call(clean, "taint_t__taint_free_write")
    expect(clean.turnScopeAccumulator?.snapshot()).toEqual([])
    expect(ran).toEqual(["taint_free_write"])

    ran.length = 0
    const result = await call(frameWith(["a:b:read"]), "taint_t__taint_free_write")
    expectParkedUnrun(result)
    expect(ran).toEqual([])
  })

  it("rule 8: a parked ungated write keeps the proposing turn's scopes and its approval audience on the row", async () => {
    ran.length = 0
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${TAINT_USER}, ${TAINT_ORG}, '*') ON CONFLICT DO NOTHING`
    try {
      for (const sdkName of ["taint_t__declared_other", "taint_t__undeclared_write"]) {
        const result = (await call(frameWith(["a:b:read"]), sdkName)) as Record<string, unknown>
        expect(JSON.stringify(result)).not.toContain("E_SCOPE_TAINT_BLOCKED")
        expect(result.blocked).toBe(true)
        expect(result.status).toBe("pending_approval")
        const [row] = (await sql`SELECT status, proposing_turn_scopes, metadata
          FROM kernel.approval_requests WHERE id = ${result.approvalRequestId as string}`) as Array<{
          status: string
          proposing_turn_scopes: string[] | null
          metadata: { taintAudienceMustHold?: string[] }
        }>
        expect(row?.status).toBe("pending")
        expect(row?.proposing_turn_scopes).toContain("a:b:read")
        expect(row?.metadata.taintAudienceMustHold).toEqual(["a:b:read"])
      }
      expect(ran).toEqual([])
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${TAINT_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${TAINT_ORG}`
    }
  })

  it("a frame without an accumulator is refused downstream, while no frame at all still runs", async () => {
    // This closure evaluates nothing for a bare frame: it has no accumulator to
    // read. The call still reaches executeToolCore, which treats a turn whose
    // taint is unknowable as the worst case and refuses the write, so the two
    // layers agree on the outcome even though only the deeper one decides it.
    // No frame AT ALL is the other case, and genuinely untainted: no turn ran,
    // so nothing was read.
    ran.length = 0
    const bare = { ...frameWith(), turnScopeAccumulator: undefined } as RunContext
    const refused = await call(bare, "taint_t__undeclared_write")
    expect(JSON.stringify(refused)).toContain("E_SCOPE_TAINT_BLOCKED")
    await call(undefined, "taint_t__declared_other")
    expect(ran).toEqual(["declared_other"])
  })
})

// P4c-T25: the per turn memory call cap. Three retrieval calls a turn; the
// fourth comes back as a refusal the model can read, not as a throw, so the
// turn still answers with what the first three found.
describe("the per turn memory call cap", () => {
  const CAP_ORG = "00000000-0000-0000-0000-000000d70001"
  const CAP_USER = "00000000-0000-0000-0000-000000d70002"
  const CAP_THREAD = "00000000-0000-0000-0000-000000d70003"
  const CAP_AGENT = "00000000-0000-0000-0000-000000d70004"
  const ran: string[] = []

  const actor: UserContext = {
    actorType: "user",
    userId: CAP_USER,
    orgId: CAP_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }

  const frame = (): RunContext => {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId: CAP_AGENT,
      turnScopeAccumulator: createTurnScopeAccumulator(),
    } as RunContext
  }

  const call = (runFrame: RunContext | undefined, sdkName: string) => {
    const tools = buildToolSet(
      CAP_ORG,
      actor,
      CAP_THREAD,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      runFrame,
    )
    const t = tools[sdkName]
    if (!t) throw new Error(`${sdkName} is not in the catalog`)
    return (t as any).execute({})
  }

  beforeAll(async () => {
    await acquireTestLock()
    for (const name of ["memory_search", "memory_open", "memory_episode", "contacts_search"]) {
      toolRegistry.set([CAP_ORG, "kernel", name], {
        appName: "kernel",
        name,
        description: `Fake ${name}`,
        requiredScopes: ["kernel:agent:memory"],
        readOnly: true,
        handler: async () => {
          ran.push(name)
          return { ok: true, name }
        },
      })
    }
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([CAP_ORG])
    await releaseTestLock()
  })

  it("a fourth memory call in one turn is refused and logged", async () => {
    ran.length = 0
    const warnSpy = spyOn(rootLogger, "warn")
    const turn = frame()
    try {
      for (const name of ["memory_search", "memory_open", "memory_episode"]) {
        const ok = (await call(turn, `kernel__${name}`)) as { ok?: boolean }
        expect(ok.ok).toBe(true)
      }
      const refused = (await call(turn, "kernel__memory_search")) as {
        ok?: boolean
        code?: string
        reason?: string
        error?: string
      }
      // A RESULT, not a throw, and the handler never ran a fourth time.
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe(MEMORY_CALL_CAP_CODE)
      expect(refused.reason).toBe("memory_call_cap")
      expect(refused.error).toContain(String(MAX_MEMORY_CALLS_PER_TURN))
      // Demo 2026-10-12 (rv2-long-turn): 16 searches asked for at once, 13 refused,
      // and the reply listed "limit reached" as if it were each word's result.
      // The refusal says this call was NOT run and to report the limit once.
      expect(refused.error).toContain("was not run")
      expect(refused.error).toContain("once")
      expect(ran).toEqual(["memory_search", "memory_open", "memory_episode"])

      const logged = warnSpy.mock.calls.find(
        (args) => typeof args[1] === "string" && args[1] === "memory_call_cap",
      )
      expect(logged).toBeDefined()
      const line = logged?.[0] as Record<string, unknown>
      expect(line.threadId).toBe(CAP_THREAD)
      expect(line.agentId).toBe(CAP_AGENT)
      expect(line.toolName).toBe("kernel:memory_search")

      // A non-retrieval tool is untouched by the cap, and the NEXT turn starts
      // over: the budget is per turn, not per thread.
      const business = (await call(turn, "kernel__contacts_search")) as { ok?: boolean }
      expect(business.ok).toBe(true)
      const nextTurn = (await call(frame(), "kernel__memory_search")) as { ok?: boolean }
      expect(nextTurn.ok).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { sandboxCancelledError } from "~/lib/failure-severity"
import { appsLogger } from "~/lib/logger"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  appCrossAppCallsRegistry,
  approvalDedupeKeyRegistry,
  approvalSummarizerRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import {
  executeApprovedToolHandlerInternal,
  executeTool,
  executeToolCore,
} from "~/modules/apps/execute-tool"
import {
  AGENT_DELEGATION_UNAVAILABLE,
  AgentDelegationUnavailableError,
} from "~/modules/threads/agent-dispatch-guard"
import { DuplicateThreadError } from "~/modules/threads/thread"

const TEST_ORG = "00000000-0000-0000-0000-000000000001"
const TEST_THREAD = "00000000-0000-0000-0000-000000000010"

// Register a test tool for this test suite
const testTool = {
  appName: "test_et",
  name: "get_item",
  description: "Get a test item",
  requiredScopes: ["test_et:items:read"],
  gated: false,
  handler: async () => ({ id: "1", name: "Test Item" }),
  returns: { schema: { id: "string", name: "string" } },
}

let gatedHandlerCalls = 0

const gatedTool = {
  appName: "test_et",
  name: "create_item",
  description: "Create a test item",
  requiredScopes: ["test_et:items:write"],
  gated: true,
  handler: async () => {
    gatedHandlerCalls += 1
    return { id: "1" }
  },
}

const actor: UserContext = {
  actorType: "user",
  userId: "00000000-0000-0000-0000-000000000002",
  orgId: TEST_ORG,
  scopes: ["test_et:items:read"],
  dimensionGrants: {},
}

function getStatus(err: any): number | undefined {
  return err?.status ?? err?.getResponse?.().status ?? err?.res?.status
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${TEST_ORG}, 'Execute Tool Org', 'execute-tool-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${actor.userId}, ${TEST_ORG}, 'execute-tool@test.com', 'Execute Tool User') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${TEST_THREAD}, ${TEST_ORG}, 'execute-tool-thread', 'thread', ${actor.userId}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${TEST_THREAD}, ${actor.userId}, ${TEST_ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${actor.userId}, ${TEST_THREAD}, ${TEST_ORG}) ON CONFLICT DO NOTHING`
  toolRegistry.set([TEST_ORG, "test_et", "get_item"], testTool as any)
  toolRegistry.set([TEST_ORG, "test_et", "create_item"], gatedTool as any)
})

afterEach(async () => {
  gatedHandlerCalls = 0
  approvalSummarizerRegistry.clear()
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval')`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval')`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval'`
})

afterAll(async () => {
  toolRegistry.delete([TEST_ORG, "test_et", "get_item"])
  toolRegistry.delete([TEST_ORG, "test_et", "create_item"])
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval')`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval')`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG} AND type = 'approval'`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${TEST_THREAD}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${TEST_THREAD}`
  await sql`DELETE FROM kernel.threads WHERE id = ${TEST_THREAD}`
  await sql`DELETE FROM kernel.users WHERE id = ${actor.userId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("executeTool", () => {
  it("throws 403 when user lacks scope", async () => {
    const noScopeActor = { ...actor, scopes: [] as string[] }
    try {
      await executeTool({
        toolName: "test_et:get_item",
        orgId: TEST_ORG,
        actor: noScopeActor,
        params: {},
      })
      expect(true).toBe(false) // should not reach
    } catch (err: any) {
      expect(getStatus(err)).toBe(403)
    }
  })

  it("returns blocked for gated tools when called by an agent (origin set)", async () => {
    const writeActor = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(gatedHandlerCalls).toBe(0)
  })

  it("direct human UI call with approve scope auto-executes past the gate", async () => {
    // origin:"human-ui" ⇒ direct UI call. actorType:"user" + has approve scope ⇒
    // the user click IS the approval. The gated tool runs immediately and
    // no approval_requests row is created.
    const writeActor = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      origin: "human-ui",
    })
    expect(result.blocked).toBeUndefined()
    expect(gatedHandlerCalls).toBe(1)
  })

  it("direct human UI call holding the tool's scope but NOT the approve scope runs and parks nothing", async () => {
    // Approvals are for agents, not persons: a person's own click is decided by
    // the tool's OWN permission. Holding `test_et:items:write` it runs; the
    // `<app>:approve` scope plays no part.
    const writeActor = { ...actor, scopes: ["test_et:items:write"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      origin: "human-ui",
    })
    expect(result.blocked).toBeUndefined()
    expect(gatedHandlerCalls).toBe(1)
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'test_et:create_item'`
    expect(rows.length).toBe(0)
  })

  it("direct human UI call WITHOUT the tool's own scope is refused (403) and parks nothing, approve scope or not", async () => {
    const approverOnly = { ...actor, scopes: ["test_et:approve"] }
    let caught: any = null
    try {
      await executeTool({
        toolName: "test_et:create_item",
        orgId: TEST_ORG,
        actor: approverOnly,
        threadId: TEST_THREAD,
        params: {},
        origin: "human-ui",
      })
    } catch (err) {
      caught = err
    }
    expect(getStatus(caught)).toBe(403)
    expect(String(caught?.message)).toContain("test_et:items:write")
    expect(gatedHandlerCalls).toBe(0)
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'test_et:create_item'`
    expect(rows.length).toBe(0)
  })

  it("direct human UI call WITHOUT the tool's scope and WITHOUT a threadId is refused and creates no thread", async () => {
    // The threadless case used to auto-create a hidden approval thread and park
    // there; a refused person's call creates nothing at all.
    const writeActor = { ...actor, scopes: ["test_et:approve"] }
    const threadsBefore =
      await sql`SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${TEST_ORG}`
    let caught: any = null
    try {
      await executeTool({
        toolName: "test_et:create_item",
        orgId: TEST_ORG,
        actor: writeActor,
        params: {},
        origin: "human-ui",
      })
    } catch (err) {
      caught = err
    }
    expect(getStatus(caught)).toBe(403)
    expect(gatedHandlerCalls).toBe(0)
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'test_et:create_item'`
    expect(rows.length).toBe(0)
    const threadsAfter =
      await sql`SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${TEST_ORG}`
    expect(threadsAfter[0].n).toBe(threadsBefore[0].n)
  })

  it("an auto-approve policy never answers a person's own click: it runs on their scope, no synthetic approval", async () => {
    const { autoApprovePolicies } = await import("~/db/schema/kernel")
    const { withSystemDb } = await import("~/db/privileged")
    const policyRow = await withSystemDb("t", (db) =>
      db
        .insert(autoApprovePolicies)
        .values({
          orgId: TEST_ORG,
          toolName: "test_et:create_item",
          enabled: true,
          conditions: [],
          limits: { windowSeconds: 86400, windowMax: 100 },
          createdBy: actor.userId,
        })
        .returning({ id: autoApprovePolicies.id }),
    )
    try {
      const writeActor = { ...actor, scopes: ["test_et:items:write"] }
      const result = await executeTool({
        toolName: "test_et:create_item",
        orgId: TEST_ORG,
        actor: writeActor,
        threadId: TEST_THREAD,
        params: {},
        origin: "human-ui",
      })
      expect(result.blocked).toBeUndefined()
      expect(gatedHandlerCalls).toBe(1)
      const rows =
        await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'test_et:create_item'`
      expect(rows.length).toBe(0)
    } finally {
      await sql`DELETE FROM kernel.auto_approve_policies WHERE id = ${policyRow[0].id}`
    }
  })

  it("direct human UI call, origin in-app-agent (not a real human click), still gates", async () => {
    // Same actor, same gated tool, but a re-entrant/agent-attributed origin —
    // the bypass must not fire just because the actor happens to hold no
    // approve scope difference; it fires ONLY on origin:"human-ui" +
    // actorType:"user".
    const writeActor = { ...actor, scopes: ["test_et:items:write"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(gatedHandlerCalls).toBe(0)
  })

  it("origin mcp (an MCP-originated call, not a human UI click) still gates", async () => {
    // "mcp" is real, attributable re-entrant provenance, not a human click —
    // the bypass must never fire for it even with the requesterCanApprove
    // conjunct dropped.
    const writeActor = { ...actor, scopes: ["test_et:items:write"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      origin: "mcp",
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(gatedHandlerCalls).toBe(0)
  })

  it("direct human UI call parks with the person's own sign-off when an org policy demands N-eyes (min_approvers 2)", async () => {
    // A second distinct human is required, which one person's own click can
    // never satisfy: the one case a person's call parks. An approve-scope
    // holder's click is recorded as the first sign-off.
    const { approvalPolicies } = await import("~/db/schema/kernel")
    const { withSystemDb } = await import("~/db/privileged")
    const policyRow = await withSystemDb("t", (db) =>
      db
        .insert(approvalPolicies)
        .values({
          orgId: TEST_ORG,
          toolName: "test_et:create_item",
          enabled: true,
          conditions: [],
          requireApproval: true,
          minApprovers: 2,
          createdBy: actor.userId,
        })
        .returning({ id: approvalPolicies.id }),
    )
    // Two people may approve create_item, so two distinct sign-offs can exist.
    const peer = "00000000-0000-0000-0000-0000000000e2"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${peer}, ${TEST_ORG}, 'execute-tool-peer@test.com', 'Peer') ON CONFLICT DO NOTHING`
    for (const u of [actor.userId, peer]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${u}, ${TEST_ORG}, 'test_et:approve') ON CONFLICT DO NOTHING`
    }
    try {
      const writeActor = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }
      const result = await executeTool({
        toolName: "test_et:create_item",
        orgId: TEST_ORG,
        actor: writeActor,
        threadId: TEST_THREAD,
        params: {},
        origin: "human-ui",
      })
      expect(result.blocked?.approvalRequestId).toBeTruthy()
      expect(gatedHandlerCalls).toBe(0)
      const rows =
        await sql`SELECT id, status, metadata FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'test_et:create_item'`
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
      expect(rows[0].metadata.minApprovers).toBe(2)
      expect(rows[0].metadata.approvedBy).toEqual([actor.userId])
    } finally {
      // Raw SQL: the drizzle delete above took a postgres.js fragment as its
      // WHERE and never removed the policy, which leaked into later tests.
      await sql`DELETE FROM kernel.approval_policies WHERE id = ${policyRow[0].id}`
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${TEST_ORG} AND scope = 'test_et:approve'`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND requested_by = ${peer}`
      await sql`DELETE FROM kernel.users WHERE id = ${peer}`
    }
  })

  it("a call site that omits origin is gated, never treated as a human UI click", async () => {
    // Regression test for the discriminator bug: absence of origin must never
    // be read as proof of a human clicked the approve button. Even though this
    // actor holds the approve scope (which would auto-execute a genuine
    // origin:"human-ui" call, see the test above), omitting origin entirely
    // must still gate the call.
    const writeActor = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }
    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: {},
      // origin intentionally omitted
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(gatedHandlerCalls).toBe(0)
    expect(result.blocked?.approvalRequestId).toBeDefined()
  })

  it("throws 400 on invalid tool name format", async () => {
    try {
      await executeTool({ toolName: "no-colon", orgId: TEST_ORG, actor, params: {} })
      expect(true).toBe(false) // should not reach
    } catch (err: any) {
      expect(getStatus(err)).toBe(400)
    }
  })

  it("throws 404 for unknown tool", async () => {
    try {
      await executeTool({ toolName: "test_et:nonexistent", orgId: TEST_ORG, actor, params: {} })
      expect(true).toBe(false) // should not reach
    } catch (err: any) {
      expect(getStatus(err)).toBe(404)
    }
  })

  it("throws 404 for cross-org tool invocation", async () => {
    const OTHER_ORG = "00000000-0000-0000-0000-000000000099"
    try {
      await executeTool({
        toolName: "test_et:get_item",
        orgId: OTHER_ORG,
        actor: { ...actor, orgId: OTHER_ORG },
        params: {},
      })
      expect(true).toBe(false) // should not reach
    } catch (err: any) {
      expect(getStatus(err)).toBe(404)
    }
  })

  it("forbids system actors from calling internal tools without a declared caller dependency", async () => {
    toolRegistry.set([TEST_ORG, "test_et", "internal_helper"], {
      appName: "test_et",
      name: "internal_helper",
      description: "Internal helper",
      requiredScopes: ["test_et:items:write"],
      trustBoundary: "internal",
      deferLoading: true,
      handler: async () => ({ ok: true }),
    })

    const result = await executeToolCore({
      toolName: "test_et:internal_helper",
      orgId: TEST_ORG,
      actor: {
        actorType: "system",
        orgId: TEST_ORG,
        purpose: "job",
        scopes: ["test_et:items:write"],
      },
      params: {},
      origin: "in-app-agent",
    })

    expect("error" in result ? result.error.code : undefined).toBe("forbidden")
    toolRegistry.delete([TEST_ORG, "test_et", "internal_helper"])
  })

  it("an internal tool runs when its own app's code calls it, and for no person, agent or client directly", async () => {
    let ran = 0
    toolRegistry.set([TEST_ORG, "test_et", "own_internal"], {
      appName: "test_et",
      name: "own_internal",
      description: "Own internal step",
      requiredScopes: ["test_et:items:write"],
      trustBoundary: "internal",
      agentVisible: false,
      handler: async () => {
        ran++
        return { ok: true }
      },
    })
    const job = {
      actorType: "system" as const,
      orgId: TEST_ORG,
      purpose: "job" as const,
      scopes: ["test_et:*"],
    }
    const person: UserContext = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }
    type CoreOptions = Parameters<typeof executeToolCore>[0]
    const call = (o: Omit<Partial<CoreOptions>, "origin"> & { origin: CoreOptions["origin"] }) =>
      executeToolCore({
        toolName: "test_et:own_internal",
        orgId: TEST_ORG,
        actor: job,
        params: {},
        ...o,
      })
    try {
      // Its own job, and one of its own tools a person clicked (the hop is "in-app-agent").
      const job_ = await call({ origin: "system", internalCall: { callerApp: "test_et" } })
      expect("data" in job_ ? job_.data : job_).toEqual({ ok: true })
      const hop = await call({
        actor: person,
        origin: "in-app-agent",
        internalCall: { callerApp: "test_et" },
      })
      expect("data" in hop ? hop.data : hop).toEqual({ ok: true })
      const agent: UserContext & { actorType: "agent" } = { ...person, actorType: "agent" } as never
      const refused = [
        await call({ actor: person, origin: "human-ui" }),
        await call({ actor: person, origin: "mcp" }),
        await call({ actor: agent, origin: "in-app-agent" }),
        await call({ origin: "system" }),
        await call({ origin: "system", internalCall: { callerApp: "other_et" } }),
      ]
      for (const r of refused) expect("error" in r ? r.error.code : r).toBe("forbidden")
      expect(ran).toBe(2)
    } finally {
      toolRegistry.delete([TEST_ORG, "test_et", "own_internal"])
    }
  })

  // Phase 16 code-review I8 — per-user enforcement (success criterion #3):
  // a denied user must produce ZERO downstream calls (no fetcher invocation,
  // no handler execution). The scope-check must short-circuit before any
  // external I/O leaves Liaison.
  it("scope-denied user: handler is never invoked (zero side-effects)", async () => {
    let handlerCalls = 0
    let fetcherCalls = 0
    toolRegistry.set([TEST_ORG, "test_et", "denied_tool"], {
      appName: "test_et",
      name: "denied_tool",
      description: "Tool requiring an unheld scope",
      requiredScopes: ["test_et:items:admin"],
      gated: false,
      // Track invocation — if scope-check is wrong, this fires and `handlerCalls > 0`.
      handler: async () => {
        handlerCalls += 1
        // Simulate an outbound API call (e.g. Shopify mutation).
        fetcherCalls += 1
        return { ok: true }
      },
    } as any)

    const denied: UserContext = {
      ...actor,
      scopes: ["test_et:items:read"], // missing :admin
    }

    const result = await executeToolCore({
      toolName: "test_et:denied_tool",
      orgId: TEST_ORG,
      actor: denied,
      params: {},
      origin: "in-app-agent",
    })

    expect("error" in result ? result.error.code : undefined).toBe("forbidden")
    expect("error" in result ? result.error.message : undefined).toContain("test_et:items:admin")
    expect(handlerCalls).toBe(0)
    expect(fetcherCalls).toBe(0)

    toolRegistry.delete([TEST_ORG, "test_et", "denied_tool"])
  })

  // D20: inside a routine tick, the refusal says which scope the routine lacks and how to add it,
  // so the tick's reply (what the owner reads in the routine's thread) is actionable.
  it("a routine tick refused for a scope names it and says how to add it to the routine", async () => {
    toolRegistry.set([TEST_ORG, "test_et", "routine_denied_tool"], {
      appName: "test_et",
      name: "routine_denied_tool",
      description: "Tool requiring a scope the routine lacks",
      requiredScopes: ["test_et:items:admin"],
      gated: false,
      // A read: the tick frame carries no taint accumulator, which blocks undeclared writes first.
      readOnly: true,
      handler: async () => ({ ok: true }),
    } as any)
    try {
      const { runContextStore } = await import("~/modules/agent/runtime/run-context")
      const call = () =>
        executeToolCore({
          toolName: "test_et:routine_denied_tool",
          orgId: TEST_ORG,
          actor: { ...actor, scopes: ["test_et:items:read"] },
          params: {},
          origin: "in-app-agent",
        })
      const inTick = await runContextStore.run(
        {
          runId: "r1",
          parentRunId: null,
          rootRunId: "r1",
          nestingDepth: 0,
          background: true,
          routineId: "00000000-0000-4000-8000-0000000000d2",
        },
        call,
      )
      const message = "error" in inTick ? inTick.error.message : ""
      expect(message).toContain("test_et:items:admin")
      expect(message).toContain("Edit > Scopes")
      expect(message).toContain("kernel__update_routine")
      // Outside a routine the message stays the plain one.
      const plain = await call()
      expect("error" in plain ? plain.error.message : "").not.toContain("Edit > Scopes")
    } finally {
      toolRegistry.delete([TEST_ORG, "test_et", "routine_denied_tool"])
    }
  })

  it("refuses a tool when the actor holds its scope but not every requiredScopes entry", async () => {
    let handlerCalls = 0
    toolRegistry.set([TEST_ORG, "test_et", "multi_scope_tool"], {
      appName: "test_et",
      name: "multi_scope_tool",
      description: "Needs two distinct grants",
      requiredScopes: ["a:b:read", "a:c:write"],
      gated: false,
      handler: async () => {
        handlerCalls += 1
        return { ok: true }
      },
    } as any)
    try {
      const partial = await executeToolCore({
        toolName: "test_et:multi_scope_tool",
        orgId: TEST_ORG,
        actor: { ...actor, scopes: ["a:b:read"] },
        params: {},
        origin: "mcp",
      })
      expect("error" in partial ? partial.error.code : undefined).toBe("forbidden")
      expect("error" in partial ? partial.error.message : "").toBe("missing scope: a:c:write")
      expect(handlerCalls).toBe(0)

      const granted = await executeToolCore({
        toolName: "test_et:multi_scope_tool",
        orgId: TEST_ORG,
        actor: { ...actor, scopes: ["a:b:read", "a:c:write"] },
        params: {},
        origin: "mcp",
      })
      expect("data" in granted ? granted.data : granted).toEqual({ ok: true })
      expect(handlerCalls).toBe(1)
    } finally {
      toolRegistry.delete([TEST_ORG, "test_et", "multi_scope_tool"])
    }
  })

  it("refuses a tool that declares no scope at all, even for a full wildcard actor", async () => {
    let handlerCalls = 0
    toolRegistry.set([TEST_ORG, "test_et", "no_scope_tool"], {
      appName: "test_et",
      name: "no_scope_tool",
      description: "Declares no scope",
      requiredScopes: ["test_et:placeholder"],
      gated: false,
      handler: async () => {
        handlerCalls += 1
        return { ok: true }
      },
    })
    // Registration refuses a tool with no requiredScopes, so the fixture strips
    // the list after the fact to model a definition that slipped through.
    delete (
      toolRegistry.get([TEST_ORG, "test_et", "no_scope_tool"]) as { requiredScopes?: string[] }
    ).requiredScopes
    try {
      const result = await executeToolCore({
        toolName: "test_et:no_scope_tool",
        orgId: TEST_ORG,
        actor: { ...actor, scopes: ["*"] },
        params: {},
        origin: "mcp",
      })
      expect("error" in result ? result.error.code : undefined).toBe("forbidden")
      expect("error" in result ? result.error.message : "").toContain("missing scope")
      expect(handlerCalls).toBe(0)
    } finally {
      toolRegistry.delete([TEST_ORG, "test_et", "no_scope_tool"])
    }
  })

  // TODO: "full pipeline with correct scope returns data" — requires a real DB
  // connection since executeTool calls withRlsContext internally. The scope/gated/
  // validation tests above are pure logic and don't need DB.
})

// App↔app capability authorization (manifest `cross_app_calls`). An app-to-app
// (`internalCall`) dispatch to a tool the CALLER declared in `cross_app_calls`
// is authorized by that operator-approved capability — independent of the
// caller app-actor's RBAC scopes. This is what lets event-driven handlers
// (bare `${app}:*` system actor) call another app's tools (customs fetch,
// product sync, order enrichment, auto-email).
describe("executeToolCore — cross-app capability authorization", () => {
  const CALLER = "caller_et"
  const systemNoScope = {
    actorType: "system" as const,
    orgId: TEST_ORG,
    purpose: "job" as const,
    scopes: [] as string[],
  }

  afterEach(() => {
    appCrossAppCallsRegistry.deleteByPrefix([TEST_ORG, CALLER])
    appCrossAppCallsRegistry.deleteByPrefix([TEST_ORG, "undeclared_et"])
  })

  it("authorizes a declared cross_app_call past the RBAC scope check (no caller scope)", async () => {
    appCrossAppCallsRegistry.set([TEST_ORG, CALLER], { targets: ["test_et:get_item"] })
    const result = await executeToolCore({
      toolName: "test_et:get_item",
      orgId: TEST_ORG,
      actor: systemNoScope,
      params: {},
      origin: "in-app-agent",
      internalCall: { callerApp: CALLER },
    })
    // The capability grant authorizes the call — it must NOT be rejected for a
    // missing scope (the bug this fixes). It proceeds to the handler.
    const msg = "error" in result ? result.error.message : ""
    expect(msg).not.toContain("missing scope")
    expect("data" in result ? (result.data as { id?: string }).id : undefined).toBe("1")
  })

  it("forbids an UNDECLARED cross-app target (least privilege preserved)", async () => {
    // caller declares a DIFFERENT tool, not get_item.
    appCrossAppCallsRegistry.set([TEST_ORG, "undeclared_et"], { targets: ["test_et:other"] })
    const result = await executeToolCore({
      toolName: "test_et:get_item",
      orgId: TEST_ORG,
      actor: systemNoScope,
      params: {},
      origin: "in-app-agent",
      internalCall: { callerApp: "undeclared_et" },
    })
    expect("error" in result ? result.error.code : undefined).toBe("forbidden")
    expect("error" in result ? result.error.message : "").toContain("missing scope")
  })
})

describe("executeTool gated → summary path", () => {
  // Agent-origin actor: the gated flow runs verbatim. Human UI callers
  // with approve scope bypass the gate (see the executeTool basic suite),
  // so each test here passes `origin: "in-app-agent"` explicitly.
  const writeActor: UserContext = { ...actor, scopes: ["test_et:items:write", "test_et:approve"] }

  it("blocked result includes the summary inlined", async () => {
    registerApprovalSummarizer(TEST_ORG, "test_et", "create_item", async () => ({
      kind: "test.create",
      title: "Create item X",
      lines: ["A line"],
    }))

    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      params: { name: "X" },
      threadId: TEST_THREAD,
      origin: "in-app-agent",
    })

    expect(result.blocked?.reason).toBe("gated")
    expect(result.blocked?.summary?.title).toBe("Create item X")
    expect(result.blocked?.summary?.kind).toBe("test.create")
  })

  it("persists the same summary on the approval_requests row", async () => {
    registerApprovalSummarizer(TEST_ORG, "test_et", "create_item", async () => ({
      kind: "test.create",
      title: "Persisted title",
      lines: ["L1"],
    }))

    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      params: { name: "Persisted" },
      threadId: TEST_THREAD,
      origin: "in-app-agent",
    })
    const [row] =
      await sql`SELECT summary FROM kernel.approval_requests WHERE id = ${result.blocked!.approvalRequestId!}`

    expect(row.summary.title).toBe("Persisted title")
    expect(row.summary.kind).toBe("test.create")
  })

  it("falls back to default summary when no summarizer is registered", async () => {
    approvalSummarizerRegistry.clear()

    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      params: { name: "Fallback" },
      threadId: TEST_THREAD,
      origin: "in-app-agent",
    })

    expect(result.blocked?.summary?.kind).toBe("test_et:create_item")
    expect(result.blocked?.summary?.subtitle).toBe("Pending approval")
  })

  it("queues kernel:approval_request:create with the same summary", async () => {
    registerApprovalSummarizer(TEST_ORG, "test_et", "create_item", async () => ({
      kind: "test.create",
      title: "Event title",
      lines: ["L1"],
    }))

    const result = await executeTool({
      toolName: "test_et:create_item",
      orgId: TEST_ORG,
      actor: writeActor,
      params: { name: "Event" },
      threadId: TEST_THREAD,
      origin: "in-app-agent",
    })
    const events = await sql`SELECT payload FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`

    expect(events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        app: "kernel",
        entity: "approval_request",
        action: "create",
        entityId: result.blocked!.approvalRequestId,
        data: expect.objectContaining({
          id: result.blocked!.approvalRequestId,
          toolName: "test_et:create_item",
          summary: result.blocked!.summary,
        }),
      }),
    )
  })

  it("agent tool bridge preserves blocked.summary in the flattened result", async () => {
    registerApprovalSummarizer(TEST_ORG, "test_et", "create_item", async () => ({
      kind: "test.create",
      title: "Create item X",
      lines: ["A line"],
    }))

    // App tools are deferred by default for the agent audience; this test
    // exercises the EXECUTABLE (gated-blocking) path, not the discovery gate,
    // so unlock all deferred tools exactly as the real chat agent does (the
    // full toolset stays executable; only per-step provider visibility is
    // gated via activeTools).
    const toolSet = buildToolSet(TEST_ORG, writeActor, TEST_THREAD, ALL_DEFERRED_TOOLS_UNLOCKED)
    const result = await toolSet.test_et__create_item.execute({ name: "X" })

    expect(result).toMatchObject({
      blocked: true,
      reason: "gated",
      approvalRequestId: expect.any(String),
      summary: { kind: "test.create", title: "Create item X" },
    })
  })

  it("agent tool bridge returns a blocked approval envelope when requester cannot self-approve", async () => {
    const toolSet = buildToolSet(
      TEST_ORG,
      { ...writeActor, scopes: ["test_et:items:write"] },
      TEST_THREAD,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    const result = await toolSet.test_et__create_item.execute({ name: "X" })

    expect(result).toMatchObject({
      blocked: true,
      reason: "gated",
      approvalRequestId: expect.any(String),
    })
  })
})

// --- Test data for taint + approval ---
const TAINT_ORG = "00000000-0000-0000-0000-000000d30001"
const TAINT_USER = "00000000-0000-0000-0000-000000d30002"
const TAINT_THREAD = "00000000-0000-0000-0000-000000d30003"
const CLEAN_THREAD_ET = "00000000-0000-0000-0000-000000d30004"

describe("approval request creation", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${TAINT_ORG}, 'TaintExecOrg', 'taint-exec-org', '{"webContentProtection":"hardened"}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${TAINT_USER}, ${TAINT_ORG}, 'te@test.com', 'TE User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${TAINT_THREAD}, ${TAINT_ORG}, 'tainted-et', 'agent_chat', ${TAINT_USER}, true) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${CLEAN_THREAD_ET}, ${TAINT_ORG}, 'clean-et', 'agent_chat', ${TAINT_USER}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${TAINT_THREAD}, ${TAINT_USER}, ${TAINT_ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${CLEAN_THREAD_ET}, ${TAINT_USER}, ${TAINT_ORG}) ON CONFLICT DO NOTHING`

    toolRegistry.set([TAINT_ORG, "test_et", "gated_action"], {
      appName: "test_et",
      name: "gated_action",
      description: "Gated action",
      requiredScopes: ["test_et:gated"],
      gated: true,
      handler: async () => ({ done: true }),
    })
    toolRegistry.set([TAINT_ORG, "test_et", "trust_action"], {
      appName: "test_et",
      name: "trust_action",
      description: "Trust boundary action",
      requiredScopes: ["test_et:trust"],
      trustBoundary: "user",
      handler: async () => ({ done: true }),
    })
    toolRegistry.set([TAINT_ORG, "test_et", "taint_source"], {
      appName: "test_et",
      name: "taint_source",
      description: "Taint source tool",
      requiredScopes: ["test_et:taint"],
      taintSource: true,
      handler: async () => ({ results: [] }),
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([TAINT_ORG])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TAINT_ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TAINT_ORG}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${TAINT_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TAINT_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${TAINT_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TAINT_ORG} AND type = 'approval'`
  })

  const actor = {
    actorType: "user" as const,
    userId: TAINT_USER,
    orgId: TAINT_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }

  it("creates approval_requests row for gated tool with correct shape", async () => {
    const result = await executeTool({
      toolName: "test_et:gated_action",
      orgId: TAINT_ORG,
      actor,
      params: { foo: "bar" },
      threadId: TAINT_THREAD,
      origin: "in-app-agent",
    })
    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe("gated")
    expect(result.blocked!.approvalRequestId).toBeDefined()

    const [row] = await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    expect(row.tool_name).toBe("test_et:gated_action")
    expect(row.status).toBe("pending")
    expect(row.reason).toBe("gated")
    expect(row.requested_by).toBe(TAINT_USER)
    expect(row.thread_id).toBe(TAINT_THREAD)
    expect(row.originating_thread_id).toBe(TAINT_THREAD)
    expect(row.tool_params).toEqual({ foo: "bar" })
    expect(row.current_payload).toEqual({ foo: "bar" })
    expect(row.notify_user_ids).toEqual([TAINT_USER])
    const expiryMs = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()
    expect(expiryMs).toBeGreaterThan(167 * 60 * 60 * 1000)
    expect(expiryMs).toBeLessThan(169 * 60 * 60 * 1000)

    const [event] = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE payload->>'entityId' = ${result.blocked!.approvalRequestId!}
    `
    expect(event.payload.data.currentPayload).toEqual({ foo: "bar" })
    expect(event.payload.data.editableFields).toEqual([])

    const execRows = await sql`
      SELECT id FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${result.blocked!.approvalRequestId!}
    `
    expect(execRows.length).toBe(0)
  })

  it("surfaces on the originating thread when requester lacks <app>:approve scope (no auto-created discussion thread)", async () => {
    const result = await executeTool({
      toolName: "test_et:gated_action",
      orgId: TAINT_ORG,
      actor: { ...actor, scopes: ["test_et:gated"] },
      params: { foo: "bar" },
      threadId: TAINT_THREAD,
      origin: "in-app-agent",
    })

    const requestId = result.blocked?.approvalRequestId
    expect(typeof requestId).toBe("string")
    expect(result.blocked).toMatchObject({
      reason: "gated",
    })
    const [row] = await sql`
      SELECT thread_id, originating_thread_id, notify_user_ids
      FROM kernel.approval_requests
      WHERE id = ${requestId!}
    `
    expect(row.originating_thread_id).toBe(TAINT_THREAD)
    // No discussion thread is auto-created any more — the approval stays on
    // its originating thread until someone explicitly creates one.
    expect(row.thread_id).toBe(TAINT_THREAD)
    expect(row.notify_user_ids).toEqual([TAINT_USER])

    // No extra "approval" thread was created for this request.
    const discussionThreads = await sql`
      SELECT id FROM kernel.threads
      WHERE org_id = ${TAINT_ORG}
        AND type = 'approval'
        AND created_from->>'entityId' = ${requestId!}
    `
    expect(discussionThreads).toHaveLength(0)
  })

  it("creates approval_requests row for taint-escalated tool", async () => {
    const result = await executeTool({
      toolName: "test_et:trust_action",
      orgId: TAINT_ORG,
      actor,
      params: {},
      threadId: TAINT_THREAD,
    })
    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe("taint_escalation")
    expect(result.blocked!.approvalRequestId).toBeDefined()

    const [row] = await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    expect(row.reason).toBe("taint_escalation")
  })

  it("allows trust-boundary tool in clean thread (hardened mode)", async () => {
    const result = await executeTool({
      toolName: "test_et:trust_action",
      orgId: TAINT_ORG,
      actor,
      params: {},
      threadId: CLEAN_THREAD_ET,
    })
    expect(result.blocked).toBeUndefined()
    expect(result.data).toEqual({ done: true })
  })

  it("sets tainted flag after taintSource tool executes", async () => {
    await executeTool({
      toolName: "test_et:taint_source",
      orgId: TAINT_ORG,
      actor,
      params: {},
      threadId: CLEAN_THREAD_ET,
    })
    const [row] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${CLEAN_THREAD_ET}`
    expect(row.tainted).toBe(true)
    // Reset for other tests
    await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${CLEAN_THREAD_ET}`
  })

  it("withholds a taintSource result when the thread cannot be marked tainted", async () => {
    const taintModule = await import("~/modules/agent/scopes/taint")
    const spy = spyOn(taintModule, "setTaintFlag").mockRejectedValueOnce(new Error("db down"))
    try {
      const err = await executeTool({
        toolName: "test_et:taint_source",
        orgId: TAINT_ORG,
        actor,
        params: {},
        threadId: CLEAN_THREAD_ET,
      }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      )
      expect(err?.code).toBe("taint_record_failed")
    } finally {
      spy.mockRestore()
    }
  })

  it("a threadless gated call auto-creates a dedicated thread so the approval still anchors to a real thread", async () => {
    // R1: a threadless gated call must park a reviewable approval instead of
    // erroring "threadId required" - it still anchors to a REAL thread, just
    // one created on the fly for this request.
    const result = await executeTool({
      toolName: "test_et:gated_action",
      orgId: TAINT_ORG,
      actor,
      params: {},
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    const [row] = await sql`
      SELECT thread_id FROM kernel.approval_requests WHERE id = ${
        result.blocked?.approvalRequestId as string
      }
    `
    expect(row?.thread_id).toBeTruthy()
  })

  it("the auto-created anchor thread is hidden from every sidebar list", async () => {
    // The anchor exists only because approval_requests.thread_id is NOT NULL.
    // It is not a conversation: discussing an approval means pasting its URL
    // into the DM or thread where that conversation belongs. So the row must
    // never surface in listThreads (which filters NOT t.hidden_from_list), and
    // its title must carry no dash punctuation.
    const result = await executeTool({
      toolName: "test_et:gated_action",
      orgId: TAINT_ORG,
      actor,
      params: { anchor: "hidden" },
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    const [row] = await sql`
      SELECT t.id, t.hidden_from_list, t.title, t.type
        FROM kernel.approval_requests ar
        JOIN kernel.threads t ON t.id = ar.thread_id
       WHERE ar.id = ${result.blocked?.approvalRequestId as string}
    `
    expect(row?.type).toBe("approval")
    expect(row?.hidden_from_list).toBe(true)
    expect(row?.title).toBe("Approval: test_et:gated_action")
    expect(row?.title).not.toContain("\u2014")
    expect(row?.title).not.toContain("\u2013")
  })

  it("taint check runs before gated check — no double approval request", async () => {
    toolRegistry.set([TAINT_ORG, "test_et", "both"], {
      appName: "test_et",
      name: "both",
      description: "Both gated and trust-boundary",
      requiredScopes: ["test_et:both"],
      gated: true,
      trustBoundary: "user",
      handler: async () => ({ done: true }),
    })

    const result = await executeTool({
      toolName: "test_et:both",
      orgId: TAINT_ORG,
      actor,
      params: {},
      threadId: TAINT_THREAD,
    })
    // Taint escalation fires first
    expect(result.blocked!.reason).toBe("taint_escalation")

    // Only one approval request created
    const rows = await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${TAINT_ORG}`
    expect(rows.length).toBe(1)
    expect(rows[0].reason).toBe("taint_escalation")

    toolRegistry.delete([TAINT_ORG, "test_et", "both"])
  })

  it("taint stays above auto-approve: a tainted thread + matching policy still gates with taint_escalation", async () => {
    toolRegistry.set([TAINT_ORG, "test_et", "both_aa"], {
      appName: "test_et",
      name: "both_aa",
      description: "Both gated and trust-boundary, with a matching auto-approve policy",
      requiredScopes: ["test_et:both_aa"],
      gated: true,
      trustBoundary: "user",
      handler: async () => ({ done: true }),
    })
    // A policy that WOULD auto-approve (requires_scope NULL, no conditions) — so only
    // the taint-above ordering keeps the call gated. Sharp test.
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled, conditions, limits, requires_scope, created_by)
      VALUES (${TAINT_ORG}, 'test_et:both_aa', true, '[]'::jsonb, '{}'::jsonb, NULL, ${TAINT_USER})`

    const result = await executeTool({
      toolName: "test_et:both_aa",
      orgId: TAINT_ORG,
      actor,
      params: {},
      threadId: TAINT_THREAD,
    })
    // Taint gate returns BEFORE computeSkipGate runs — auto-approve never gets a chance.
    expect(result.blocked!.reason).toBe("taint_escalation")

    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${TAINT_ORG}`
    toolRegistry.delete([TAINT_ORG, "test_et", "both_aa"])
  })
})

describe("executeApprovedToolHandlerInternal — execution actor (dimension-grant) propagation [BL-186]", () => {
  // Regression for BL-186: a GATED tool approved + executed (e.g. invoicing
  // `documents_send_to_customer`) calls another app cross-app (`mail:compose`).
  // The approved-execution path used to forward ONLY scopes to the handler
  // bridge, dropping the requester's dimension grants — so the nested cross-app
  // call's `inheritedActor` fell back to `dimensionGrants: {}` and the
  // dimension-gated org mailbox was invisible (NOT_FOUND). The fix forwards the
  // app-aliased execution actor (with its dimension grants) into the bridge,
  // mirroring the direct (non-gated) path. A handler's `ctx.dimensionGrants`
  // (populated from the bridge actor) is the observable proxy for that actor.
  const DIMS = { "mail:inbox": ["*"], "mail:sensitivity": ["internal"] }

  it("forwards the requester's dimension grants into the approved handler's context", async () => {
    let captured: Record<string, string[]> | undefined
    const dimsTool = {
      appName: "test_et",
      name: "send_doc",
      description: "Gated send that records the dimension grants it executes under",
      requiredScopes: ["test_et:docs:send"],
      gated: true,
      handler: async (_params: unknown, ctx: { dimensionGrants?: Record<string, string[]> }) => {
        captured = ctx.dimensionGrants
        return { sent: true }
      },
    }
    const executionActor: UserContext = {
      actorType: "user",
      userId: "00000000-0000-0000-0000-000000000002",
      orgId: TEST_ORG,
      scopes: ["test_et:docs:send"],
      dimensionGrants: DIMS,
    }

    await executeApprovedToolHandlerInternal({
      tool: dimsTool as any,
      orgId: TEST_ORG,
      userId: executionActor.userId,
      actorScopes: executionActor.scopes,
      tx: {} as any,
      payload: {},
      approvalContext: {
        approvalRequestId: "00000000-0000-0000-0000-0000000000a1",
        approvalDeciderId: "00000000-0000-0000-0000-0000000000d1",
        toolName: "test_et:send_doc",
      },
      actor: executionActor,
    })

    // Without the fix the actor is not forwarded → ctx.dimensionGrants is {} → the
    // org mailbox would be invisible to a nested cross-app mail:compose.
    expect(captured).toEqual(DIMS)
  })

  it("defaults to empty dimension grants when no execution actor is forwarded (documents the gap the fix closes)", async () => {
    let captured: Record<string, string[]> | undefined
    const noActorTool = {
      appName: "test_et",
      name: "send_doc_noactor",
      description: "Gated send executed without an execution actor",
      requiredScopes: ["test_et:docs:send"],
      gated: true,
      handler: async (_params: unknown, ctx: { dimensionGrants?: Record<string, string[]> }) => {
        captured = ctx.dimensionGrants
        return { sent: true }
      },
    }

    await executeApprovedToolHandlerInternal({
      tool: noActorTool as any,
      orgId: TEST_ORG,
      userId: "00000000-0000-0000-0000-000000000002",
      actorScopes: ["test_et:docs:send"],
      tx: {} as any,
      payload: {},
      approvalContext: {
        approvalRequestId: "00000000-0000-0000-0000-0000000000a2",
        approvalDeciderId: "00000000-0000-0000-0000-0000000000d1",
        toolName: "test_et:send_doc_noactor",
      },
      // actor intentionally omitted
    })

    expect(captured).toEqual({})
  })

  it("tells the approved handler which approval it executes", async () => {
    let captured: string | undefined
    const reportingTool = {
      appName: "test_et",
      name: "dispatch_doc",
      description: "Gated call that reports back through its approval",
      requiredScopes: ["test_et:docs:send"],
      gated: true,
      handler: async (_params: unknown, ctx: { approvalRequestId?: string }) => {
        captured = ctx.approvalRequestId
        return { ok: true }
      },
    }
    await executeApprovedToolHandlerInternal({
      tool: reportingTool as any,
      orgId: TEST_ORG,
      userId: "00000000-0000-0000-0000-000000000002",
      actorScopes: ["test_et:docs:send"],
      tx: {} as any,
      payload: {},
      approvalContext: {
        approvalRequestId: "00000000-0000-0000-0000-0000000000a3",
        approvalDeciderId: "00000000-0000-0000-0000-0000000000d1",
        toolName: "test_et:dispatch_doc",
      },
    })
    expect(captured).toBe("00000000-0000-0000-0000-0000000000a3")
  })
})

// ── Opt-in gated-approval IDEMPOTENCY (approvalDedupeKeyParam) ──────────────────────────────────────
// Root fix for the black-friday-fulfillment-surge-batch-ship duplicate-staging defect: re-staging a
// gated create_shipment for the SAME draft (a carrier correction, a transient retry) used to STACK a
// second pending approval — the human saw two pending labels for one order and approving both
// double-shipped it. With a manifest-declared `approvalDedupeKeyParam`, a re-stage for the same
// (org, tool, key-value) while a prior approval is still PENDING returns that SAME approvalRequestId
// instead of creating a duplicate (one pending approval per keyed action). Fails-without/passes-with.
describe("executeTool gated-approval idempotency (approvalDedupeKeyParam)", () => {
  const DEDUPE_APP = "test_dedupe"
  const writeActor: UserContext = {
    ...actor,
    scopes: [`${DEDUPE_APP}:items:write`, `${DEDUPE_APP}:approve`],
  }
  let dedupeHandlerCalls = 0

  beforeAll(() => {
    toolRegistry.set([TEST_ORG, DEDUPE_APP, "stage_item"], {
      appName: DEDUPE_APP,
      name: "stage_item",
      description: "Stage a keyed item (gated, dedupe on item_id)",
      requiredScopes: [`${DEDUPE_APP}:items:write`],
      gated: true,
      handler: async () => {
        dedupeHandlerCalls += 1
        return { ok: true }
      },
    } as any)
    // Opt this tool in to dedupe on `item_id` (mirrors boxtal create_shipment's draft_id).
    approvalDedupeKeyRegistry.set([TEST_ORG, DEDUPE_APP, "stage_item"], "item_id")
  })
  afterAll(async () => {
    toolRegistry.delete([TEST_ORG, DEDUPE_APP, "stage_item"])
    approvalDedupeKeyRegistry.delete([TEST_ORG, DEDUPE_APP, "stage_item"])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
  })
  afterEach(async () => {
    dedupeHandlerCalls = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
  })

  it("re-staging the SAME keyed action returns the SAME pending approval (no duplicate row)", async () => {
    const stage = () =>
      executeTool({
        toolName: `${DEDUPE_APP}:stage_item`,
        orgId: TEST_ORG,
        actor: writeActor,
        threadId: TEST_THREAD,
        params: { item_id: "draft-abc", offer: "UPS" },
        origin: "in-app-agent",
      })
    const first = await stage()
    // A re-stage of the same draft on a corrected carrier — different non-key param, same item_id.
    const second = await executeTool({
      toolName: `${DEDUPE_APP}:stage_item`,
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: { item_id: "draft-abc", offer: "Colissimo" },
      origin: "in-app-agent",
    })
    expect(first.blocked?.reason).toBe("gated")
    expect(second.blocked?.reason).toBe("gated")
    // The decisive assertion: the second stage REUSES the first approval id, not a new one.
    expect(second.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    // And only ONE pending approval row exists for that draft (not two).
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = ${`${DEDUPE_APP}:stage_item`} AND status = 'pending' AND tool_params->>'item_id' = 'draft-abc'`
    expect(rows.length).toBe(1)
    // Neither stage executed the handler — both are still gated/pending.
    expect(dedupeHandlerCalls).toBe(0)
  })

  // RESTAGE-IN-PLACE (the chrono2shop divergence): a dedupe hit whose params DIFFER from the
  // stored payload must UPDATE the pending approval (tool_params + current_payload) — otherwise
  // the agent's blocked envelope reports the NEW action ("staged via FedEx") while the human's
  // card and the post-approval execution still carry the OLD one (Chronopost). Fails-without.
  it("re-staging with DIFFERENT params updates the stored payload in place (agent report == human card == execution)", async () => {
    const first = await executeTool({
      toolName: `${DEDUPE_APP}:stage_item`,
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: { item_id: "draft-abc", offer: "Chronopost-relay" },
      origin: "in-app-agent",
    })
    const second = await executeTool({
      toolName: `${DEDUPE_APP}:stage_item`,
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: { item_id: "draft-abc", offer: "FedEx-door-to-door" },
      origin: "in-app-agent",
    })
    expect(second.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    // The stored payload — what the human reviews AND what executes on approval — is the NEW one.
    const [row] =
      await sql`SELECT tool_params, current_payload FROM kernel.approval_requests WHERE id = ${first.blocked!.approvalRequestId!}`
    expect((row.tool_params as { offer: string }).offer).toBe("FedEx-door-to-door")
    expect((row.current_payload as { offer: string }).offer).toBe("FedEx-door-to-door")
    expect(dedupeHandlerCalls).toBe(0)
  })

  it("re-staging with IDENTICAL params leaves the approval untouched (pure re-surface, no edit noise)", async () => {
    const stage = () =>
      executeTool({
        toolName: `${DEDUPE_APP}:stage_item`,
        orgId: TEST_ORG,
        actor: writeActor,
        threadId: TEST_THREAD,
        params: { item_id: "draft-abc", offer: "UPS" },
        origin: "in-app-agent",
      })
    const first = await stage()
    const before =
      await sql`SELECT count(*) AS n FROM kernel.messages WHERE org_id = ${TEST_ORG} AND metadata->>'type' = 'payload-edit'`
    const second = await stage()
    expect(second.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    // No payload-edit audit message was added for a no-op restage.
    const after =
      await sql`SELECT count(*) AS n FROM kernel.messages WHERE org_id = ${TEST_ORG} AND metadata->>'type' = 'payload-edit'`
    expect(Number(after[0].n)).toBe(Number(before[0].n))
  })

  // ORPHAN-THREAD REGRESSION: a THREADLESS gated call by an agent (here an MCP
  // client) auto-creates a dedicated surface thread for its approval. That creation used to happen BEFORE
  // the dedupe lookup, so a re-stage that merely re-surfaced an existing
  // pending approval still left an empty thread behind, carrying a
  // `created_from` pointing at an approval id that was never inserted. The
  // thread is now created only by the arm that really inserts a new approval.
  it("a threadless re-stage that dedupes onto an existing pending approval creates NO new thread", async () => {
    // An MCP call (agent-originated) WITHOUT the app's approve scope parks an
    // approval and, having no thread, auto-creates one. (A person's own click
    // never parks: it is refused, see the human-UI tests above.)
    const noApproveActor: UserContext = {
      ...actor,
      scopes: [`${DEDUPE_APP}:items:write`],
    }
    const stageThreadless = () =>
      executeTool({
        toolName: `${DEDUPE_APP}:stage_item`,
        orgId: TEST_ORG,
        actor: noApproveActor,
        params: { item_id: "draft-threadless" },
        origin: "mcp",
      })

    const threadIds = async (): Promise<string[]> =>
      (await sql`SELECT id FROM kernel.threads WHERE org_id = ${TEST_ORG}`).map(
        (r) => (r as { id: string }).id,
      )
    const before = await threadIds()

    const first = await stageThreadless()
    expect(first.blocked?.reason).toBe("gated")
    const afterFirst = await threadIds()
    // The threadless call really did auto-create its surface thread.
    expect(afterFirst.length).toBe(before.length + 1)

    const second = await stageThreadless()
    // Dedupe hit: the SAME approval is re-surfaced.
    expect(second.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    // The decisive assertion: the dedupe hit created no second, empty thread.
    const afterSecond = await threadIds()
    expect(afterSecond.length).toBe(afterFirst.length)

    // And every thread this test created anchors to an approval that EXISTS.
    const created = afterSecond.filter((id) => !before.includes(id))
    const orphans = await sql`
      SELECT t.id FROM kernel.threads t
      WHERE t.id = ANY(${created}::uuid[])
        AND t.created_from->>'entityType' = 'approval_request'
        AND NOT EXISTS (
          SELECT 1 FROM kernel.approval_requests a
          WHERE a.id = (t.created_from->>'entityId')::uuid
        )`
    expect(orphans.length).toBe(0)

    // Approvals first: kernel.approval_requests.thread_id FKs the thread.
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.threads WHERE id = ANY(${created}::uuid[])`
  })

  it("a DIFFERENT keyed action stages its own distinct pending approval", async () => {
    const a = await executeTool({
      toolName: `${DEDUPE_APP}:stage_item`,
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: { item_id: "draft-one" },
      origin: "in-app-agent",
    })
    const b = await executeTool({
      toolName: `${DEDUPE_APP}:stage_item`,
      orgId: TEST_ORG,
      actor: writeActor,
      threadId: TEST_THREAD,
      params: { item_id: "draft-two" },
      origin: "in-app-agent",
    })
    expect(a.blocked!.approvalRequestId).not.toBe(b.blocked!.approvalRequestId)
    const rows =
      await sql`SELECT DISTINCT tool_params->>'item_id' AS item FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = ${`${DEDUPE_APP}:stage_item`} AND status = 'pending'`
    expect(rows.length).toBe(2)
  })
})

// ─── meta-ads gating integration (Task 12) ────────────────────────────────────
//
// Proves BOTH gating paths for a meta-ads gated fixture registered via the same
// synthetic toolRegistry pattern used above (test_et). The gate logic
// (computeSkipGate) is app-agnostic — it keys off gated:true + scopes, not app
// name — so this proves meta-ads gating BY CONSTRUCTION without requiring a live
// bundle install.
//
// The manifest's own gated:true + trustBoundary:"user" correctness is pinned
// separately by the Task 6 manifest.test per-write-tool assertions.

const META_ADS_ORG = "00000000-0000-0000-0000-000000000011"
const META_ADS_THREAD = "00000000-0000-0000-0000-000000000012"
const META_ADS_USER_ID = "00000000-0000-0000-0000-000000000013"

let metaAdsHandlerCalls = 0

const metaAdsGatedTool = {
  appName: "meta-ads",
  name: "create_campaign",
  description: "Create a Meta Ads campaign (gated — raises approval for agent calls)",
  requiredScopes: ["meta-ads:campaigns:write"],
  gated: true,
  handler: async () => {
    metaAdsHandlerCalls += 1
    return { id: "camp_test_1" }
  },
}

const metaAdsActor: UserContext = {
  actorType: "user",
  userId: META_ADS_USER_ID,
  orgId: META_ADS_ORG,
  scopes: ["meta-ads:campaigns:write", "meta-ads:approve"],
  dimensionGrants: {},
}

describe("meta-ads gating integration (Task 12)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${META_ADS_ORG}, 'Meta Ads Org', 'meta-ads-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${META_ADS_USER_ID}, ${META_ADS_ORG}, 'meta-ads@test.com', 'Meta Ads User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${META_ADS_THREAD}, ${META_ADS_ORG}, 'meta-ads-thread', 'thread', ${META_ADS_USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${META_ADS_THREAD}, ${META_ADS_USER_ID}, ${META_ADS_ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${META_ADS_USER_ID}, ${META_ADS_THREAD}, ${META_ADS_ORG}) ON CONFLICT DO NOTHING`
    toolRegistry.set([META_ADS_ORG, "meta-ads", "create_campaign"], metaAdsGatedTool as any)
  })

  afterEach(async () => {
    metaAdsHandlerCalls = 0
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval'`
  })

  afterAll(async () => {
    toolRegistry.delete([META_ADS_ORG, "meta-ads", "create_campaign"])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${META_ADS_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval')`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${META_ADS_ORG} AND type = 'approval'`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${META_ADS_THREAD}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${META_ADS_THREAD}`
    await sql`DELETE FROM kernel.threads WHERE id = ${META_ADS_THREAD}`
    await sql`DELETE FROM kernel.users WHERE id = ${META_ADS_USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${META_ADS_ORG}`
  })

  it("agent call to meta-ads:create_campaign → blocked (gated), zero handler calls", async () => {
    const result = await executeTool({
      toolName: "meta-ads:create_campaign",
      orgId: META_ADS_ORG,
      actor: metaAdsActor,
      threadId: META_ADS_THREAD,
      params: { name: "Test Campaign", objective: "OUTCOME_SALES", special_ad_categories: [] },
      origin: "in-app-agent", // agent call → must gate
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(metaAdsHandlerCalls).toBe(0) // zero mutations before approval
  })

  it("agent gated call creates an approval_requests row", async () => {
    await executeTool({
      toolName: "meta-ads:create_campaign",
      orgId: META_ADS_ORG,
      actor: metaAdsActor,
      threadId: META_ADS_THREAD,
      params: { name: "Test Campaign", objective: "OUTCOME_SALES", special_ad_categories: [] },
      origin: "in-app-agent",
    })
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${META_ADS_ORG} AND status = 'pending'`
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it("approve-holder direct call (origin human-ui) → gate skipped, handler executes", async () => {
    // origin:"human-ui" ⇒ direct UI call. actorType:user + has meta-ads:approve
    // ⇒ the user click IS the approval. Tool runs immediately.
    const result = await executeTool({
      toolName: "meta-ads:create_campaign",
      orgId: META_ADS_ORG,
      actor: metaAdsActor, // holds meta-ads:approve
      threadId: META_ADS_THREAD,
      params: { name: "Direct Campaign", objective: "OUTCOME_LEADS", special_ad_categories: [] },
      origin: "human-ui",
    })
    expect(result.blocked).toBeUndefined()
    expect(metaAdsHandlerCalls).toBe(1) // handler executed
  })

  it("a call that omits origin is gated even though the actor holds approve scope", async () => {
    // Regression test for the discriminator bug: absence of origin must never
    // be read as proof of a human clicked the approve button. Same actor and
    // tool as the human-ui test above (which DOES bypass); omitting origin
    // entirely must still gate the call instead of defaulting to a bypass.
    const result = await executeTool({
      toolName: "meta-ads:create_campaign",
      orgId: META_ADS_ORG,
      actor: metaAdsActor, // holds meta-ads:approve
      threadId: META_ADS_THREAD,
      params: { name: "No Origin Campaign", objective: "OUTCOME_LEADS", special_ad_categories: [] },
      // origin intentionally omitted
    })
    expect(result.blocked?.reason).toBe("gated")
    expect(metaAdsHandlerCalls).toBe(0)
  })

  it("direct human-UI call WITHOUT the tool's own scope is refused (403) and parks nothing", async () => {
    // A person's own click runs on the tool's own `meta-ads:campaigns:write`;
    // without it the call is refused (the approve scope does not rescue it),
    // never parked for someone else.
    const noApproveActor = { ...metaAdsActor, scopes: ["meta-ads:approve"] }
    let caught: any = null
    try {
      await executeTool({
        toolName: "meta-ads:create_campaign",
        orgId: META_ADS_ORG,
        actor: noApproveActor,
        threadId: META_ADS_THREAD,
        params: {
          name: "No Approve Campaign",
          objective: "OUTCOME_SALES",
          special_ad_categories: [],
        },
        origin: "human-ui",
      })
    } catch (err) {
      caught = err
    }
    expect(getStatus(caught)).toBe(403)
    expect(metaAdsHandlerCalls).toBe(0)
    const rows =
      await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${META_ADS_ORG} AND tool_name = 'meta-ads:create_campaign'`
    expect(rows.length).toBe(0)
  })
})

describe("executeTool — thrown-error log severity follows HTTP class", () => {
  // A deliberate typed 4xx (validation/not-found/forbidden the agent can correct)
  // must NOT log at error level: the prod watchdog turns every new error-level
  // signature into a CRITICAL and forwards it to the ops attention feed as noise.
  // 5xx / unclassified throws stay at error so real faults still page.
  const throwStatus = (status: number | undefined | (() => Error)) => ({
    appName: "test_et",
    name: "throw_item",
    description: "Throws a typed error",
    requiredScopes: ["test_et:items:read"],
    gated: false,
    handler: async () => {
      throw typeof status === "function"
        ? status()
        : status === undefined
          ? new Error("plain boom")
          : Object.assign(new Error(`boom ${status}`), { status })
    },
  })

  afterEach(() => {
    toolRegistry.delete([TEST_ORG, "test_et", "throw_item"])
  })

  async function runThrow(status: number | undefined | (() => Error)) {
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], throwStatus(status) as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      // executeToolCore returns the error envelope (the public executeTool
      // wrapper re-throws it); the "Tool handler threw" log fires inside core.
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      // Agent-facing envelope is unchanged regardless of log level.
      expect("error" in result).toBe(true)
      const handlerThrew = (fn: ReturnType<typeof spyOn>) =>
        fn.mock.calls.some((c: unknown[]) => c[1] === "Tool handler threw")
      const warned = warnSpy.mock.calls.find((c: unknown[]) => c[1] === "Tool handler threw")
      return {
        warnedThrow: handlerThrew(warnSpy),
        erroredThrow: handlerThrew(errorSpy),
        reason: (warned?.[0] as { reason?: string } | undefined)?.reason,
      }
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  }

  it("logs a deliberate 4xx tool throw at warn (not error)", async () => {
    const { warnedThrow, erroredThrow } = await runThrow(422)
    expect(warnedThrow).toBe(true)
    expect(erroredThrow).toBe(false)
  })

  it("logs a 5xx tool throw at error", async () => {
    const { warnedThrow, erroredThrow } = await runThrow(500)
    expect(erroredThrow).toBe(true)
    expect(warnedThrow).toBe(false)
  })

  // Production: an upstream's 503 page, a "not supported for this file" 501 and a
  // caller that hung up mid-call each paged as a new error signature.
  it.each([
    [422, "invalid_request"],
    [404, "not_found"],
    [429, "rate_limited"],
    [501, "unsupported"],
    [503, "upstream_unavailable"],
  ] as const)("logs a %d tool throw at warn with reason %s", async (status, reason) => {
    const r = await runThrow(status)
    expect(r).toEqual({ warnedThrow: true, erroredThrow: false, reason })
  })

  it("logs a cancelled caller at warn, reason caller_cancelled", async () => {
    const r = await runThrow(() => sandboxCancelledError())
    expect(r).toEqual({ warnedThrow: true, erroredThrow: false, reason: "caller_cancelled" })
  })

  it("logs an unknown statusless throw, a 502 and a 504 at error", async () => {
    for (const status of [undefined, 502, 504]) {
      const r = await runThrow(status)
      expect(r.erroredThrow).toBe(true)
      expect(r.warnedThrow).toBe(false)
    }
  })

  it("logs a fail closed agent delegation refusal at warn, never at error", async () => {
    // The callee stopped being a live agent between the guard and the hand off,
    // so the ask refuses rather than running the turn at the callee's own
    // ceiling. That is the guard working: it must not page the watchdog.
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
      ...throwStatus(undefined),
      handler: async () => {
        throw new AgentDelegationUnavailableError("the agent that was asked is not available")
      },
    } as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      expect("error" in result).toBe(true)
      expect((result as { error: { code: string } }).error.code).toBe(AGENT_DELEGATION_UNAVAILABLE)
      const said = (fn: ReturnType<typeof spyOn>, message: string) =>
        fn.mock.calls.some((c: unknown[]) => c[1] === message)
      expect(said(warnSpy, "Tool handler threw an expected caller-context error")).toBe(true)
      expect(said(errorSpy, "Tool handler threw")).toBe(false)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("logs an unclassified (statusless) tool throw at error", async () => {
    const { warnedThrow, erroredThrow } = await runThrow(undefined)
    expect(erroredThrow).toBe(true)
    expect(warnedThrow).toBe(false)
  })

  it("surfaces a DB bad-input error (22P02) as typed invalid_params at warn", async () => {
    // An agent passing a title where a uuid id is expected makes postgres throw
    // 22P02 through the postgres.js "Failed query" wrapper — a caller error,
    // not a server fault. Must become invalid_params (agent-correctable), not
    // an error-level tool_error that pages the watchdog.
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
      ...throwStatus(undefined),
      handler: async () => {
        throw Object.assign(new Error("Failed query: SELECT * FROM app_knowledge.documents"), {
          cause: Object.assign(new Error('invalid input syntax for type uuid: "04-projects.md"'), {
            code: "22P02",
          }),
        })
      },
    } as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      expect("error" in result && result.error.code).toBe("invalid_params")
      expect(errorSpy.mock.calls.some((c) => c[1] === "Tool handler threw")).toBe(false)
      expect(
        warnSpy.mock.calls.some(
          (c) => c[1] === "Tool handler DB bad-input error — surfaced as invalid_params",
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("classifies a rewrapped 22P02 (withPgCause shape) as invalid_params at warn", async () => {
    // withPgCause (sandbox/rpc-bridge.ts) inlines the pg cause into a plain Error's
    // message because `.cause` cannot survive the sandbox worker IPC boundary —
    // "tickets_markRead failed — pg: invalid input syntax for type uuid: \"\" (22P02)".
    // No `.cause` object at all reaches this boundary; only the SQLSTATE text does.
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
      ...throwStatus(undefined),
      handler: async () => {
        throw new Error(
          'tickets_markRead failed - pg: invalid input syntax for type uuid: "" (22P02)',
        )
      },
    } as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      expect("error" in result && result.error.code).toBe("invalid_params")
      expect(errorSpy.mock.calls.some((c) => c[1] === "Tool handler threw")).toBe(false)
      const rewrapWarnCall = warnSpy.mock.calls.find(
        (c) => c[1] === "Tool handler DB bad-input error — surfaced as invalid_params",
      )
      expect(rewrapWarnCall).toBeDefined()
      // The rewrapped-error class (RLS bugs like the empty-GUC 22P02 fixed in migration 0044)
      // gets downgraded to warn by this classifier, so the SQLSTATE must stay visible as a
      // structured field on the payload — otherwise a genuine server-side defect of this
      // class is invisible in prod, not just quiet.
      expect((rewrapWarnCall?.[0] as Record<string, unknown> | undefined)?.dbCode).toBe("22P02")
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  describe("DB errors never leak SQL or bound params to the caller", () => {
    // Live QA 2026-09-23: a failed knowledge:create handed the agent
    // `Failed query: SELECT * FROM app_knowledge.collections WHERE id = $1::uuid
    // AND org_id = $2::uuid … params: none,<org uuid> — pg: …`. Knowledge is a
    // TRUSTED app, so its raw message reached the caller verbatim.
    const ORG_UUID = "892c3d01-78e3-4811-8c9a-17ac8cbf9c49"
    const SQL = `Failed query: SELECT * FROM app_knowledge.collections\n      WHERE id = $1::uuid AND org_id = $2::uuid\n      LIMIT 1\nparams: none,${ORG_UUID}`

    async function callThrowing(thrown: unknown) {
      toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
        ...throwStatus(undefined),
        handler: async () => {
          throw thrown
        },
      } as any)
      const warnSpy = spyOn(appsLogger, "warn")
      const errorSpy = spyOn(appsLogger, "error")
      try {
        const result = await executeToolCore({
          toolName: "test_et:throw_item",
          orgId: TEST_ORG,
          actor,
          params: {},
          threadId: TEST_THREAD,
          origin: "mcp",
        })
        if (!("error" in result)) throw new Error("expected an error envelope")
        const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
          (c) => c[0] as Record<string, unknown>,
        )
        return { error: result.error, logged }
      } finally {
        warnSpy.mockRestore()
        errorSpy.mockRestore()
      }
    }

    function expectNoLeak(message: string) {
      expect(message).not.toContain("Failed query")
      expect(message).not.toContain("app_knowledge")
      expect(message).not.toContain("params:")
      expect(message).not.toContain(ORG_UUID)
    }

    it("the rewrapped 22P02 from the live walk keeps only the server's message", async () => {
      const { error, logged } = await callThrowing(
        new Error(`${SQL} — pg: invalid input syntax for type uuid: "none" (22P02)`),
      )
      expect(error.code).toBe("invalid_params")
      expectNoLeak(error.message)
      expect(error.message).toContain('invalid input syntax for type uuid: "none"')
      // The detail stays server-side.
      expect(
        logged.some((l) => String(l.dbMessage ?? "").includes("app_knowledge.collections")),
      ).toBe(true)
    })

    it("a constraint violation becomes a typed error with no SQL", async () => {
      const { error, logged } = await callThrowing(
        Object.assign(new Error(SQL), {
          cause: Object.assign(
            new Error('new row for relation "documents" violates check constraint "x"'),
            { code: "23514", constraint_name: "knowledge_documents_org_sensitivity_check" },
          ),
        }),
      )
      expect(error.code).toBe("invalid_params")
      expectNoLeak(error.message)
      expect(error.message).toContain("knowledge_documents_org_sensitivity_check")
      expect(logged.some((l) => l.dbCode === "23514")).toBe(true)
    })

    it("a unique violation becomes conflict", async () => {
      const { error } = await callThrowing(
        Object.assign(new Error(SQL), {
          cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint_name: "documents_title_uq",
          }),
        }),
      )
      expect(error.code).toBe("conflict")
      expectNoLeak(error.message)
    })

    it("any other DB error becomes an opaque db_error, logged at error with the detail", async () => {
      const { error, logged } = await callThrowing(
        Object.assign(new Error(SQL), {
          cause: Object.assign(new Error('column "nope" does not exist'), { code: "42703" }),
        }),
      )
      expect(error.code).toBe("db_error")
      expectNoLeak(error.message)
      expect(
        logged.some((l) => l.dbCode === "42703" && String(l.innerMessage).includes(ORG_UUID)),
      ).toBe(true)
    })

    it("a bare Failed query message with no cause is still withheld", async () => {
      const { error } = await callThrowing(new Error(SQL))
      expect(error.code).toBe("db_error")
      expectNoLeak(error.message)
    })
  })

  it("a session bridge method outside the four hand-wrapped ones keeps its 22P02 across IPC", async () => {
    // Prod 2026-09-21: a tool given the slug "acmesound" where a uuid id is expected made
    // postgres throw 22P02, but the SQLSTATE lives on `.cause` and only `message` survives the
    // sandbox worker IPC, so the classifier above found nothing and a caller mistake escaped
    // as an error-level log plus HTTP 500. withPgCause covered only db_update / db_updateMany /
    // db_delete / tickets_markRead; createSessionRpcBridge now applies it to EVERY method.
    // db_count is one of the uncovered ones: without the central wrap the message that crosses
    // the boundary is the bare "Failed query" SQL and this test gets a 500-shaped tool_error.
    const { createSessionRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
    const pgError = Object.assign(
      new Error("Failed query: SELECT count(*)::int AS count FROM app_bridge22p02.items"),
      {
        cause: Object.assign(new Error('invalid input syntax for type uuid: "acmesound"'), {
          code: "22P02",
        }),
      },
    )
    const throwingTx = {
      execute: async () => {
        throw pgError
      },
    }
    const bridge = createSessionRpcBridge(
      "bridge22p02",
      actor.userId,
      TEST_ORG,
      {
        ctx: actor,
        run: async <T>(fn: (tx: any) => Promise<T>) => fn(throwingTx),
      } as any,
      {
        name: "bridge22p02",
        schema: { items: { fields: { title: "string" } } },
        connections: {},
        network: { allowedDomains: [] },
      } as any,
    )
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
      ...throwStatus(undefined),
      handler: async () => {
        try {
          await bridge.db_count("items", JSON.stringify({ where: { title: "acmesound" } }))
        } catch (err) {
          // What the worker IPC does: only `message` crosses back, never `.cause`.
          throw new Error((err as Error).message)
        }
        throw new Error("db_count should have thrown")
      },
    } as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      expect("error" in result && result.error.code).toBe("invalid_params")
      expect(errorSpy.mock.calls.some((c) => c[1] === "Tool handler threw")).toBe(false)
      const warnCall = warnSpy.mock.calls.find(
        (c) => c[1] === "Tool handler DB bad-input error — surfaced as invalid_params",
      )
      expect((warnCall?.[0] as Record<string, unknown> | undefined)?.dbCode).toBe("22P02")
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("logs a duplicate-thread create at warn, not error", async () => {
    // "Reply in that thread ... otherwise ask the user" is pure caller guidance —
    // paging the watchdog on it is noise. DuplicateThreadError carries status 409
    // so it takes the typed-4xx path instead of the statusless generic path.
    toolRegistry.set([TEST_ORG, "test_et", "throw_item"], {
      ...throwStatus(undefined),
      handler: async () => {
        throw new DuplicateThreadError({ id: "thread-1", handle: "alice-bob", title: null })
      },
    } as any)
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    try {
      const result = await executeToolCore({
        toolName: "test_et:throw_item",
        orgId: TEST_ORG,
        actor,
        params: {},
        threadId: TEST_THREAD,
        origin: "mcp",
      })
      expect("error" in result).toBe(true)
      const handlerThrew = (fn: ReturnType<typeof spyOn>) =>
        fn.mock.calls.some((c: unknown[]) => c[1] === "Tool handler threw")
      expect(handlerThrew(warnSpy)).toBe(true)
      expect(handlerThrew(errorSpy)).toBe(false)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

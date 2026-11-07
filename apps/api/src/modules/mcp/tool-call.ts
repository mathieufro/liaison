// SPDX-License-Identifier: FSL-1.1-ALv2

import { randomUUID } from "node:crypto"
import { APP_DISABLED_CODE, APP_DISABLED_MESSAGE, findRefTokens } from "@liaison/shared"
import { HTTPException } from "hono/http-exception"
import type { UserContext } from "~/db/rls"
import { EXTERNAL_CONTENT_NOTICE } from "~/lib/external-content"
import { rootLogger } from "~/lib/logger"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import {
  type GatewayTurn,
  resolveGatewayTurn,
} from "~/modules/agent/local-sessions/turn-credential"
import { readMailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { checkToolScopes, resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import {
  checkToolScopeTaint,
  isPlatformTaintRefusal,
  wasRefusedBeforeRun,
} from "~/modules/agent/scopes/scope-taint"
import { watchTaintMarks } from "~/modules/agent/scopes/taint"
import { hostMayTaint } from "~/modules/agent/scopes/taint-exemptions"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import {
  createTurnScopeAccumulator,
  type TurnScopeAccumulator,
} from "~/modules/agent/scopes/turn-scope-accumulator"
import { stripHostOnlyParams } from "~/modules/agent/tools/host-only-params"
import {
  canonicalToolName,
  type DiscoveredTools,
  isParkedForApproval,
  listGatewayTools,
} from "~/modules/agent/tools/tool-bridge"
import { compactToolSearchResult, scoreDeferredTools } from "~/modules/agent/tools/tool-search"
import { approvalActionRequiredClause, gatedNotesRelay } from "~/modules/approvals/agent-guidance"
import { evaluateApprovalPolicy } from "~/modules/approvals/approval-policy"
import { resolveApprovalRef } from "~/modules/approvals/resolve-ref"
import { appCrossAppCallsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool, validateParamsForTool } from "~/modules/apps/execute-tool"
import { isAppOffForOrg, isFeatureOffForTool, primeOrgApps } from "~/modules/apps/org-apps"
import { featureOffAnswer } from "~/modules/apps/org-features"
import { isToolAllowedByAgentPolicy, loadAgentToolPolicy } from "~/modules/mcp/agent-tool-policy"
import { selectAppGuideToSurface } from "~/modules/mcp/app-guide-surfacing"
import { getApprovalStatus } from "~/modules/mcp/approval-status"
import {
  addDiscoveredTools,
  addSurfacedSkills,
  loadConnectionTurnTaint,
  loadConnectionTurnTaintOrigins,
  loadLiveAgent,
  recordConnectionTaintLedger,
  recordConnectionTaintMarks,
  saveConnectionTurnTaint,
  saveConnectionTurnTaintOrigins,
  touchConnectionTaintScopes,
} from "~/modules/mcp/connection-service"
import {
  connectionThreadTurnMessageId,
  ensureConnectionThread,
} from "~/modules/mcp/connection-thread"
import { fulfilMcpMailboxMarker } from "~/modules/mcp/mcp-mailbox-plaintext"
import {
  connectionRunsNodeSessions,
  NOT_FROM_A_SESSION,
  nodeJobSourceScopes,
} from "~/modules/mcp/node-session-connection"
import {
  formatSurfacedSkill,
  type SurfaceableSkill,
  selectSkillsToSurface,
} from "~/modules/mcp/skill-surfacing"
import {
  LIAISON_APPROVAL_STATUS,
  LIAISON_CALL_TOOL,
  LIAISON_META_TOOLS,
  LIAISON_TOOL_SEARCH,
  listMcpTools,
} from "~/modules/mcp/tool-projection"
import { recordNodeJobTaint } from "~/modules/nodes/job-taint-store"

const log = rootLogger.child({ module: "mcp-tool-call" })

/** Relayed with every approval link an MCP client receives. */
export const APPROVAL_URL_NOTE =
  "The link opens this approval in Liaison. A browser that is not signed in to Liaison (for example the browser built into Claude) shows the sign-in page first, then returns to this approval; the Liaison app or the user's usual browser, where they are already signed in, opens it directly."

/** Relayed when the approval is a send from an end-to-end encrypted mailbox. */
export const MAILBOX_SEALED_APPROVAL_NOTE =
  "This email comes from the user's end-to-end encrypted mailbox, so only a Liaison window where that mailbox is unlocked can send it: tell the user to approve it in the Liaison app or a browser where they have unlocked their mailbox (Liaison asks for the mailbox password or passkey when it is locked). Approving it from a browser that has never unlocked this mailbox cannot send it."

export interface ToolCallCtx {
  orgId: string
  actor: UserContext
  connectionId: string
  ownerUserId: string
  /** The kernel.agents row this connection is BOUND to (the auth middleware's
   *  `mcpAgentId`). Absent for a legacy connection: no agent acts on it. */
  agentId?: string
  /** lazily resolved connection thread id (null until first gated call) */
  connectionThreadId: string | null
  discovered: DiscoveredTools
  /** The caller's resolved skills, loaded once per request by the transport. */
  skills?: readonly SurfaceableSkill[]
  /** Names already pushed to this connection; MUTATED as bodies go out. */
  surfacedSkills?: Set<string>
  /**
   * THE TURN FRAME for an agent-bound connection (X6). The gateway used to call
   * `executeTool` with no run frame at all, so its calls were judged as coming
   * from no turn: nothing was accumulated and no scope taint was ever evaluated,
   * while the identical call through the in-app tool bridge was refused.
   *
   * The frame is THIS ctx object's lifetime, which is the natural per-connection
   * frame the code already has (it is the object that carries the lazily
   * provisioned connection thread id and the mutated surfaced-skill set, built
   * once per authenticated transport request in `createMcpServer`). Under
   * today's stateless streamable-HTTP transport that is exactly ONE `tools/call`,
   * and it stays correct if a future transport carries several.
   *
   * Created lazily on the first agent-bound call, and never for a legacy
   * connection: no agent acts on one, so it keeps today's behaviour unchanged.
   */
  turnScopeAccumulator?: TurnScopeAccumulator
  /** This turn frame's run id, stable for the life of the ctx. */
  turnRunId?: string
  /**
   * The desktop local turn's credential as presented (`x-liaison-turn`, S59).
   * Raw: judged once per ctx by `resolveGatewayTurn`, never logged.
   */
  turnCredential?: string | null
  /** What that credential proved for this ctx: undefined until judged, null when nothing. */
  gatewayTurn?: GatewayTurn | null
}

interface McpResult {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

// Per the MCP spec, `structuredContent` in a tools/call result MUST be a
// plain object (record) — never an array or scalar. Tool handlers are free
// to return arrays (e.g. list endpoints like tickets `inboxesList` /
// `categoriesList`, or the test app's `listItems`), so only promote `data`
// into `structuredContent` when it is actually a plain object; otherwise
// omit `structuredContent` entirely and rely on the `content` text block
// (which always carries the full JSON payload, array or not) so behavior
// for existing clients/UI is unchanged.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function mcpToolResult(data: unknown): McpResult {
  const result: McpResult = {
    content: [{ type: "text", text: JSON.stringify(data ?? null) }],
  }
  if (isPlainObject(data)) {
    result.structuredContent = data
  }
  return result
}

function mcpStructuredResult(payload: Record<string, unknown>): McpResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

/**
 * APP-ANCHORED SKILL SURFACING — the MCP port of the in-app context assembler's
 * `selectAppAnchoredSkills`. An MCP client has no per-turn system prompt, so a
 * tool RESULT is the only channel that can carry a playbook to it mid-session.
 * The first time a connection calls a tool of an app a skill anchors to, that
 * skill's body rides back on the result; exactly-once per skill per connection.
 *
 * The body goes out as an ADDITIONAL `content` text block — never merged into
 * the tool's own payload. Injecting a `_skill` key into `data` would collide
 * with real fields, corrupt array-returning tools, and violate the tool's
 * declared output schema; an extra content block is legal MCP and leaves
 * `structuredContent` and `content[0]` byte-identical to what the client
 * already parses.
 */
async function appendAnchoredSkills(
  ctx: ToolCallCtx,
  canonical: string,
  result: McpResult,
): Promise<McpResult> {
  const skills = ctx.skills ?? []
  const surfaced = ctx.surfacedSkills
  if (!surfaced) return result
  const appName = canonical.slice(0, Math.max(canonical.indexOf(":"), 0))
  if (!appName) return result

  // The app's own guide first (app-guide-surfacing.ts): the rules the in-app
  // agent holds in its prompt for this app, then any org skill anchored to it.
  const guide = selectAppGuideToSurface(ctx.orgId, canonical, surfaced)
  const toSurface = skills.length > 0 ? selectSkillsToSurface(skills, appName, surfaced) : []
  if (!guide && toSurface.length === 0) return result

  if (guide) {
    for (const key of guide.keys) surfaced.add(key)
    result.content.push({ type: "text", text: guide.text })
  }
  for (const s of toSurface) {
    surfaced.add(s.name)
    const framed = formatSurfacedSkill(s)
    result.content.push({ type: "text", text: `${framed.reason}\n\n${framed.body}` })
  }

  // Best-effort persistence: if this write fails the skill simply surfaces again
  // on a later call (redundant, not wrong), so it must never fail the tool call
  // the user actually asked for.
  try {
    await addSurfacedSkills(ctx.connectionId, [
      ...(guide?.keys ?? []),
      ...toSurface.map((s) => s.name),
    ])
  } catch (err) {
    log.warn(
      { err, connectionId: ctx.connectionId, skills: toSurface.map((s) => s.name) },
      "failed to persist surfaced skills — will re-surface on a later call",
    )
  }
  return result
}

/** The key a result that carried outside text is flagged under, beside the notice block. */
export const OUTSIDE_TEXT_KEY = "liaison/outsideText"

/**
 * Flags a result as carrying text written outside the organisation: the notice
 * as its own text block (the part of a result every client is sure to see; the
 * desktop's local session reads it), and the same answer in `structuredContent`
 * and `_meta` for a client that reads those. The tool's own payload stays the
 * first block, byte for byte.
 */
function noticeOutsideText(result: McpResult): McpResult {
  result.content.push({ type: "text", text: EXTERNAL_CONTENT_NOTICE })
  if (result.structuredContent) {
    result.structuredContent = { ...result.structuredContent, [OUTSIDE_TEXT_KEY]: true }
  }
  result._meta = { ...(result._meta ?? {}), [OUTSIDE_TEXT_KEY]: true }
  return result
}

function mcpErrorResult(err: {
  code: string
  message: string
  retryable: boolean
  feature?: string
  next?: string
}): McpResult {
  return {
    content: [{ type: "text", text: JSON.stringify(err) }],
    structuredContent: { ...err },
    isError: true,
  }
}

// Reverse the tool-bridge sdkName sanitization (`app__tool` with disallowed
// chars replaced) back to the canonical `app:tool` via the SAME registry the
// agent uses — never a naive split.
type RegisteredTool = NonNullable<ReturnType<typeof toolRegistry.get>>

function resolveCanonical(
  orgId: string,
  sdkName: string,
): {
  canonical: string
  gated: boolean
  taintSource: boolean
  /** The tool's registry entry ITSELF, the very object the in-app tool bridge
   *  hands to `checkToolScopeTaint` and the turn accumulator. It used to be a
   *  field-by-field copy, and a declaration added later (`sinkReadScope`,
   *  `resultRowPath`) never reached the gateway: an agent-bound MCP client got
   *  E_SCOPE_TAINT_BLOCKED on a declared sink write the in-app agent was
   *  allowed. Passing the entry means the two paths cannot read different
   *  declarations. */
  toolDef: RegisteredTool
} | null {
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    const candidate = `${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`
    if (candidate === sdkName) {
      return {
        canonical: `${key[1]}:${key[2]}`,
        gated: !!def.gated,
        taintSource: !!def.taintSource,
        toolDef: def,
      }
    }
  }
  return null
}

// Resolve the thread the approval actually lives in (+ its human handle).
// createApprovalRequest creates no separate thread: approval_requests.thread_id
// is always the originating (connection) thread. Still resolve from the DB row
// rather than re-deriving, so this stays correct if that routing ever changes
// again. The handle rides along because it is the label the approval
// card prints: an agent citing only the uuid sends the reviewer hunting.
export async function handleToolCall(
  ctx: ToolCallCtx,
  toolName: string,
  clientArgs: Record<string, unknown>,
): Promise<McpResult> {
  // A client never sets a host-only parameter: those come from the mailbox retry below only
  // (host-only-params.ts).
  const args = stripHostOnlyParams(clientArgs)
  // THE INVOKE PATH APPLIES THE SAME SECOND FILTER STAGE AS tools/list.
  // The scope half already agrees by construction: `ctx.actor.scopes` IS the
  // intersected set the middleware recomputed, and both the catalog and
  // `executeToolCore`'s own scope check read it. The agent's allow/deny lists
  // are not on the actor, so without this a tool hidden from `tools/list`
  // stayed callable by name, and `liaison_tool_search` still named it.
  // Loaded once per call, never cached, exactly as the catalog loads it.
  const agentPolicy = ctx.agentId ? await loadAgentToolPolicy(ctx.orgId, ctx.agentId) : null
  // The search catalog and the call below both leave out Off apps (S19).
  await primeOrgApps(ctx.orgId)

  if (toolName === LIAISON_TOOL_SEARCH) {
    const query = String(args.query ?? "")
    // Rank the FULL gateway catalog, not a deferred subset. The gateway defers
    // nothing, so the caller already holds every one of these in its tools/list:
    // this is a finder for a big catalog, not an unlock step. (Scoring a
    // deferred-only list here would return zero hits for every query and read as
    // "that tool does not exist" — the exact false negative this search exists
    // to prevent.)
    const deferred = listGatewayTools(ctx.orgId, ctx.actor).filter(
      // A tool the bound agent's policy hides is not in the caller's
      // tools/list, so naming it here would advertise a capability the very
      // next call refuses.
      (t) =>
        !agentPolicy ||
        isToolAllowedByAgentPolicy(agentPolicy, [
          t.sdkName,
          canonicalToolName(t.appName, t.toolName),
        ]),
    )
    // Same tokenized scorer as the in-agent tool_search: "create skill" must
    // find create_skill; a naive whole-query substring match returned nothing.
    const scored = scoreDeferredTools(deferred, query)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
    // The RESULT is a compact index (name + one-line description + score),
    // count- and byte-capped: a broad query used to dump every match's full
    // description (~100KB) and blow the client's tool-result cap.
    const compact = compactToolSearchResult(scored)
    const discoveredNames = compact.tools.map((t) => t.name)
    // The discovered set no longer gates gateway visibility (tools/list is
    // complete from the first call), so this now only records which tools a
    // connection searched for. Its one former consumer was that visibility
    // gate: transport-routes still rehydrates it per connection and nothing
    // reads the result. Left in place rather than ripped out in the same change
    // as the visibility fix — retiring the column and its load/store path is a
    // separate, purely-subtractive cleanup.
    for (const name of discoveredNames) ctx.discovered.add(name)
    if (discoveredNames.length > 0) {
      await addDiscoveredTools(ctx.connectionId, discoveredNames)
    }
    return mcpStructuredResult({ ...compact })
  }

  if (toolName === LIAISON_CALL_TOOL) {
    // An MCP client keeps the tools/list it loaded when the session started and
    // most ignore list_changed, so a scope granted mid-session never reaches its
    // list. This dispatcher is in every list and resolves the name against the
    // actor's CURRENT scopes, so a new grant is usable without a restart.
    const target = String(args.name ?? "")
    if (LIAISON_META_TOOLS.has(target)) {
      return mcpErrorResult({
        code: "invalid_params",
        message: `${target} is a gateway tool: call it directly, not through ${LIAISON_CALL_TOOL}.`,
        retryable: false,
      })
    }
    const inner = args.arguments
    if (inner === undefined || inner === null) {
      // Describe mode, over the SAME projection tools/list serves, so a tool
      // the scopes or the bound agent's policy hide is described as not found.
      // W3-D4: an agent-bound-only tool stays in it, because the call below
      // resolves one by name on any connection (and liaison_tool_search lists
      // it): "omit arguments to get its schema" must never answer not found
      // for a tool the call reaches.
      const tools = await listMcpTools({
        orgId: ctx.orgId,
        actor: ctx.actor,
        threadId: ctx.connectionThreadId ?? undefined,
        agentId: ctx.agentId,
        connectionId: ctx.connectionId,
        keepAgentBoundOnly: true,
      })
      const def = tools.find((t) => t.name === target)
      if (!def) {
        return mcpErrorResult({
          code: "tool_not_found",
          message: `tool ${target} not found for your current permissions. Call liaison_tool_search with task keywords to get the exact name; if it comes back empty the capability needs a scope you do not hold (kernel__describe_user_access names it).`,
          retryable: false,
        })
      }
      return mcpStructuredResult({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        next: `Call ${LIAISON_CALL_TOOL} again with { name: "${def.name}", arguments: { ... } } matching inputSchema.`,
      })
    }
    if (typeof inner !== "object" || Array.isArray(inner)) {
      return mcpErrorResult({
        code: "invalid_params",
        message: "`arguments` must be an object of the tool's parameters.",
        retryable: false,
      })
    }
    return handleToolCall(ctx, target, inner as Record<string, unknown>)
  }

  if (toolName === LIAISON_APPROVAL_STATUS) {
    const status = await getApprovalStatus(ctx.orgId, String(args.approvalRequestId ?? ""))
    return mcpStructuredResult(status as Record<string, unknown>)
  }

  const resolved = resolveCanonical(ctx.orgId, toolName)
  // Refused the SAME way an unknown name is refused: the withheld-capability
  // contract for the gateway is silent omission (D2), so a denied tool must
  // not be distinguishable from one that does not exist.
  if (
    resolved &&
    agentPolicy &&
    !isToolAllowedByAgentPolicy(agentPolicy, [toolName, resolved.canonical])
  ) {
    return mcpErrorResult({
      code: "tool_not_found",
      message: `tool ${toolName} not found. Your tools/list is the full catalog for your scopes, so this name is either misspelled or outside your access: call liaison_tool_search with task keywords to get the exact name, and if it comes back empty the capability needs a scope you do not hold (kernel__describe_user_access names it).`,
      retryable: false,
    })
  }
  // A tool of an app turned Off for the workspace (S19) is not in tools/list.
  // A client that still holds its name (a snapshot taken before) is told why,
  // in words, rather than "not found": the admin can turn it back On.
  if (resolved && isAppOffForOrg(ctx.orgId, resolved.canonical.split(":")[0] ?? "")) {
    return mcpErrorResult({
      code: APP_DISABLED_CODE,
      message: APP_DISABLED_MESSAGE,
      retryable: false,
    })
  }
  // A tool whose feature is off left tools/list too. The client that still holds
  // its name reads why when it holds the scope; anyone else, that there is no such tool.
  if (
    resolved &&
    isFeatureOffForTool(ctx.orgId, resolved.toolDef) &&
    checkToolScopes(resolved.toolDef, ctx.actor.scopes ?? []).authorized
  ) {
    return mcpErrorResult(featureOffAnswer(ctx.orgId, resolved.toolDef))
  }
  if (!resolved || isFeatureOffForTool(ctx.orgId, resolved.toolDef)) {
    return mcpErrorResult({
      code: "tool_not_found",
      message: `tool ${toolName} not found. Your tools/list is the full catalog for your scopes, so this name is either misspelled or outside your access: call liaison_tool_search with task keywords to get the exact name, and if it comes back empty the capability needs a scope you do not hold (kernel__describe_user_access names it).`,
      retryable: false,
    })
  }
  const { canonical, gated, taintSource, toolDef } = resolved

  // Not the session's to do: a node session's connection never runs these (m7).
  if (
    toolDef.notForNodeSessions &&
    (await connectionRunsNodeSessions(ctx.orgId, ctx.connectionId))
  ) {
    return mcpErrorResult({
      code: "not_from_a_session",
      message: NOT_FROM_A_SESSION,
      retryable: false,
    })
  }

  // SCOPE TAINT ON THE GATEWAY (X6). An agent-bound turn accumulates the scopes
  // of every tool it calls and is judged by the SAME `checkToolScopeTaint` the
  // in-app tool bridge runs, returning the SAME `E_SCOPE_TAINT_BLOCKED` shape as
  // the tool's RESULT rather than throwing, so the caller can say what happened.
  // The frame below also carries the accumulator into `executeToolCore`, whose
  // own taint boundary was blind here: with no frame it read "no turn called
  // this" and evaluated nothing.
  //
  // WHERE THE ACCUMULATED SET LIVES ACROSS REQUESTS (the orchestrator's binding
  // decision, recorded verbatim): "the persisted MCP turn taint is keyed
  // `mcp:turn-taint:<orgId>:<agentId>`, because two connections bound to one
  // agent are the same external runtime as far as laundering goes and turn
  // boundaries are unknowable. Consequence: revoking ONE connection no longer
  // deletes the key (another connection for the agent may be live); the sliding
  // 15-minute expiry is the only clearing." The window is
  // `MCP_ACCESS_TOKEN_TTL_SECONDS` (15 min), refreshed on every tools/call, and
  // re-minting does not clear it.
  //
  // The in-memory `ctx.turnScopeAccumulator` stays: it is the intra-request
  // path, and this ctx's own nested dispatches must see what this request has
  // already touched without a round trip per call.
  let frame: RunContext | undefined
  // What the agent's persisted window brought into this request, as opposed
  // to what this request's own calls touch (the node job taint keeps only
  // the latter, see below).
  let injectedScopes: ReadonlySet<string> = new Set()
  // The scopes only a node job brought (not the agent's window): they judge
  // THIS call and are never written back into the agent's shared window, or
  // every connection of the agent would stay tainted by one session for good.
  let jobOnlyScopes: ReadonlySet<string> = new Set()
  if (ctx.agentId) {
    ctx.turnScopeAccumulator ??= createTurnScopeAccumulator({ orgId: ctx.orgId })
    ctx.turnRunId ??= randomUUID()
    // The persisted set is unioned in BEFORE the pre-call snapshot, so a scoped
    // read in an earlier POST taints a write in this one exactly as it would
    // inside a single in-app turn.
    // A node session's connection also carries what its jobs were handed
    // from Liaison (node-session-connection.ts `nodeJobSourceScopes`).
    const windowScopes = await loadConnectionTurnTaint(ctx.orgId, ctx.agentId, {
      dropIdleScopes: true,
    })
    // Projected as the accumulator projects them (a write scope lands on its
    // read sibling), so the set compared below is the set the snapshot holds:
    // a raw write scope would match nothing and its read sibling would reach
    // the window with no read time.
    const jobScopes = projectTaintScopesForOrg(
      await nodeJobSourceScopes(ctx.orgId, ctx.connectionId),
      ctx.orgId,
    )
    const fromWindow = new Set(projectTaintScopesForOrg(windowScopes, ctx.orgId))
    jobOnlyScopes = new Set(jobScopes.filter((s) => !fromWindow.has(s)))
    const injected = [...new Set([...windowScopes, ...jobScopes])]
    injectedScopes = new Set(injected)
    ctx.turnScopeAccumulator.recordInjected(injected)
    // THE OTHER HALF OF THE SAME RULE (P6d-FX10). The scopes above say the turn
    // is tainted; these say WHICH ROWS the taint came from, which is what the
    // same-resource allowance (A46) is judged against. Persisted beside the
    // scopes because they cross the same stateless hop: without them a runtime
    // that read ticket A in one POST and replies to ticket A in the next is
    // judged against no origins at all, and the reply is refused before it can
    // stage its approval.
    for (const [table, rowIds] of Object.entries(
      await loadConnectionTurnTaintOrigins(ctx.orgId, ctx.agentId),
    )) {
      ctx.turnScopeAccumulator.recordOriginRows(table, rowIds)
    }
    // `agentId` and `agentCeiling` are documented on RunContext as both present
    // or both absent: a frame naming an agent while unable to say how far that
    // agent reaches is a frame no reader can judge against. An agent that has
    // gone away between the auth middleware and here yields an empty ceiling,
    // which admits nothing rather than everything.
    const actingAgent = await loadLiveAgent(ctx.orgId, ctx.agentId)
    // The connection's EFFECTIVE scope, not a second computation of one:
    // `resolveConnectionFromToken` already intersects the grantor's current
    // grants with the agent's current ceiling on every request, and that set is
    // exactly what `ctx.actor.scopes` carries. Without it on the frame, an ask
    // made over MCP delegated nothing and the callee ran at its OWN ceiling.
    const connectionScopes = (ctx.actor.scopes ?? []) as unknown as string[]
    // The turn this request's writes hang under, when the connection thread
    // holds one. Absent, a question posted now is the root of its own chain,
    // exactly as it was.
    const connectionTurnMessageId = ctx.connectionThreadId
      ? await connectionThreadTurnMessageId(ctx.orgId, ctx.connectionThreadId)
      : undefined
    // A GATEWAY TURN (S59, D37, A34): the desktop's local turn proved, with
    // the credential minted for the person's message, that this call answers
    // that message. Anything short of every check reads as no credential.
    if (ctx.gatewayTurn === undefined) {
      ctx.gatewayTurn = ctx.turnCredential
        ? await resolveGatewayTurn({
            raw: ctx.turnCredential,
            orgId: ctx.orgId,
            userId: ctx.ownerUserId,
            agentId: ctx.agentId,
            connectionId: ctx.connectionId,
          })
        : null
      if (ctx.turnCredential && !ctx.gatewayTurn) {
        log.debug(
          { connectionId: ctx.connectionId, agentId: ctx.agentId },
          "turn credential not honoured: the call runs as a plain gateway call",
        )
      }
    }
    const gatewayTurn = ctx.gatewayTurn
    const turnMessageId = gatewayTurn ? gatewayTurn.messageId : connectionTurnMessageId
    frame = {
      runId: ctx.turnRunId,
      parentRunId: null,
      rootRunId: ctx.turnRunId,
      nestingDepth: 0,
      // No person is proven behind a gateway call (run-context.ts).
      mcpGateway: true,
      agentId: ctx.agentId,
      agentCeiling: actingAgent?.scopeCeiling ?? [],
      effectiveScope: connectionScopes,
      turnScopeAccumulator: ctx.turnScopeAccumulator,
      ...(turnMessageId ? { turnMessageId } : {}),
      // Never `humanTurn` (D37): the local CLI's own reads never reach server taint.
      ...(gatewayTurn
        ? {
            gatewayTurn: { threadId: gatewayTurn.threadId, messageId: gatewayTurn.messageId },
            ...(gatewayTurn.replyRootId
              ? {
                  replyRoot: {
                    threadId: gatewayTurn.threadId,
                    rootMessageId: gatewayTurn.replyRootId,
                  },
                }
              : {}),
            ...(gatewayTurn.restricted ? { sessionRestricted: true } : {}),
          }
        : {}),
    }
  }
  // Where a gateway turn's approvals land and its taint is judged: the person's
  // conversation, with the connection thread consulted as well (A34).
  const personThreadId = frame?.gatewayTurn?.threadId
  const accumulator = ctx.turnScopeAccumulator
  // Taint reads what EARLIER calls brought into the turn, so the snapshot is
  // taken before this call records its own scopes; otherwise every scoped write
  // would taint itself.
  const touchedBefore = accumulator?.snapshot()
  // Recorded for a call that throws too: it may have read something before it
  // failed, so it still counts toward the turn's scope set. A taint-free kernel
  // tool (catalog, capability listing, navigation) reads no org data and records
  // nothing. Three calls record NOTHING because they never ran at all
  // (`persistWindowOnly` / `persistRefusedByPlatform` below): a gated call parked
  // for approval, a call the PLATFORM refused by scope taint, before the
  // dispatch or at it (a handler returning the same code is not a refusal), and a
  // call it refused for a missing scope or bad parameters. Recording a refused
  // write's own scope renewed the per-agent window on every retry, so the block
  // renewed itself; the in-app bridge still counts it, but its turn ends with the
  // reply. Every path still writes the set back, which refreshes the sliding
  // idle window.
  let turnScopesSettled = false
  /** What this call itself read: a job-only scope it read again is the window's too. */
  let readByThisCall: ReadonlySet<string> = new Set()
  const persistTurnScopes = async (all: string[]): Promise<void> => {
    if (!accumulator || !ctx.agentId) return
    const snapshot = all.filter((s) => !jobOnlyScopes.has(s) || readByThisCall.has(s))
    await saveConnectionTurnTaint(ctx.orgId, ctx.agentId, snapshot)
    // The same set, stamped with WHEN each scope first arrived, so a tagger
    // that knows its turn's start can fold in this turn's scopes and not the
    // window's (see `mcpTurnTaintMarksKey`). Nothing refuses on these.
    await recordConnectionTaintMarks(ctx.orgId, ctx.agentId, snapshot)
  }
  const recordTurnScopes = async (): Promise<void> => {
    if (turnScopesSettled) return
    turnScopesSettled = true
    if (accumulator && toolDef.taintFree !== true) {
      accumulator.record(toolDef)
      // What THIS call read, stamped so the scope ages out a window after its last read.
      if (ctx.agentId) {
        const own = resolveRequiredScopes(toolDef)
        // Its own declared scopes, projected like the snapshot. A nested read
        // of a scope already in the set leaves no trace in the accumulator (a
        // set), so only the call's own declaration is counted here.
        readByThisCall = new Set(projectTaintScopesForOrg(own, ctx.orgId))
        await touchConnectionTaintScopes(ctx.orgId, ctx.agentId, own)
        // A NODE JOB running on this connection keeps what its calls touched
        // for its whole life (A18, A50/F6): this call's scopes and whatever it
        // read nested, never the agent window's older scopes. No-op for a
        // connection that runs no node job.
        const readHere = [
          ...new Set([...own, ...accumulator.snapshot().filter((s) => !injectedScopes.has(s))]),
        ]
        await recordNodeJobTaint(ctx.connectionId, readHere)
        // Kept a day for tagging a long local turn's reply (`mcpTurnTaintLedgerKey`).
        await recordConnectionTaintLedger(ctx.orgId, ctx.agentId, readHere)
      }
    }
    if (accumulator) await persistTurnScopes(accumulator.snapshot())
  }
  /** The parked-call answer: nothing new is recorded, and the set that was
   *  already there is written back so the sliding window still refreshes. */
  const persistWindowOnly = async (): Promise<void> => {
    if (turnScopesSettled) return
    turnScopesSettled = true
    await persistTurnScopes(touchedBefore ?? [])
  }
  /** The platform refused this call by scope taint, so the call itself never ran: its own
   *  scopes are not recorded, but anything this request already recorded (a nested read) is
   *  written back with the rest of the set. */
  const persistRefusedByPlatform = async (): Promise<void> => {
    if (turnScopesSettled) return
    turnScopesSettled = true
    if (accumulator) await persistTurnScopes(accumulator.snapshot())
  }
  if (touchedBefore) {
    const refused = checkToolScopeTaint(touchedBefore, toolDef, {
      args,
      originRows: accumulator?.originRows(),
      // Every write is judged at the dispatch, which parks what taint would refuse.
      deferGatedToDispatch: true,
    })
    if (refused) {
      await persistRefusedByPlatform()
      log.warn(
        { toolName: canonical, writeTargetTable: refused.writeTargetTable },
        "MCP tool call refused by scope taint",
      )
      return mcpErrorResult({
        code: refused.code,
        message: `tool ${canonical}: ${refused.message}`,
        retryable: false,
      })
    }
  }

  // executeTool requires a threadId UPFRONT to create a gated tool's approval
  // request (it errors otherwise). So a gated tool's connection thread must be
  // provisioned BEFORE the call, not after — still lazy (a connection whose
  // calls are all read-only and ungated never gets a threadId).
  //
  // A taint-SOURCE tool (e.g. web_search/web_fetch) also needs the thread
  // upfront: executeTool's `setTaintFlag` no-ops without `opts.threadId`, so an
  // MCP session that calls ONLY taint sources (and never a gated tool) would
  // otherwise never be provisioned a connection thread and silently bypass
  // taint tracking. Provisioning here marks that connection's thread so a later
  // trust-boundary tool sees the taint. Still lazy: a read-only connection that
  // touches neither a gated nor a taint-source tool never gets a threadId.
  // An @ref-bearing call must be SEQUENCED into the approval bundle even when the
  // tool is NON-gated (execute-tool defers it to cascade time); creating that
  // deferred bundle step needs a threadId. MCP dispatch is stateless per request,
  // so a non-gated sequenced step (e.g. boxtal import_label_document mid-chain)
  // would otherwise reach execute-tool with threadId=undefined and error
  // "threadId required". Provision the connection thread for @ref calls too.
  const hasRefTokens = findRefTokens(args).length > 0
  // A tool that is NOT itself gated can still reach a gated tool in ANOTHER app
  // through a declared cross_app_calls target, and that nested call needs a
  // threadId to park its approval. Without this, the nested call is refused with
  // "threadId required" and the calling app usually rewrites that into its own
  // message, so the real cause never surfaces: boxtal:prep_add_shipment reported
  // missing invoicing rights for an operator who held every scope.
  // From the CANONICAL name: `toolName` is the SDK spelling (`app__tool`), which
  // carries no colon, so splitting that on ":" hands back the whole tool name
  // and the registry lookup below never matches.
  const appName = canonical.slice(0, Math.max(canonical.indexOf(":"), 0))
  // The declaration is the APP's, but reading it at the app level made every
  // tool of boxtal, invoicing, shopify, ads and calls provision a thread, reads
  // included, before the policy was ever asked: the eager opposite of the
  // laziness the paragraph above promises. A tool that writes nothing cannot
  // reach another app's gated tool and needs no surface for its approval, so the
  // declaration only counts for a tool that is not read-only.
  const appDeclaresCrossAppTargets =
    (appCrossAppCallsRegistry.get([ctx.orgId, appName])?.targets ?? []).length > 0
  const declaresCrossAppCalls = appDeclaresCrossAppTargets && toolDef.readOnly !== true
  // A tool that is not statically gated can still be gated at RUNTIME by the
  // org's approval-tightening policy (execute-tool's `effectiveGated`). The
  // retry below used to cover that, keyed on executeTool throwing
  // "threadId required"; executeTool no longer throws for a plain gated call
  // (it lazily auto-creates a per-approval surface thread instead), so without
  // this the approval lands on that fallback thread and the MCP connection's
  // own thread is never provisioned: the agent then has no conversation to
  // watch the request in.
  //
  // So ASK the authority execute-tool asks, with the same inputs, instead of
  // standing in a guess for it: "anything that is not read-only might be gated"
  // provisioned a thread for every MCP connection that ever wrote anything,
  // which is the opposite of lazy. A connection that only calls ungated writes
  // still provisions nothing.
  // The SAME inputs execute-tool will judge. Asked about the raw MCP arguments,
  // a policy condition on a field the schema defaults (or coerces from a
  // stringified value) read as absent at the prefilter and as present a moment
  // later inside execute-tool: the call was gated after all, and its approval
  // landed on an auto-created surface the agent never sees, because the
  // prefilter had already concluded no connection thread was needed.
  // Invalid arguments are not this function's to report: execute-tool answers
  // them with the real message, so the policy is asked about what came in.
  const policyParams = (): unknown => {
    const toolKey = canonical.slice(appName.length + 1)
    const tool = toolRegistry.get([ctx.orgId, appName, toolKey])
    if (!tool) return args
    try {
      return validateParamsForTool(tool, ctx.orgId, appName, toolKey, args)
    } catch {
      return args
    }
  }

  let gatedByPolicy = false
  // An externalEffect / requiresHumanTurn tool may park as a taint escalation, which needs the thread.
  // So may ANY write on a turn that already carries scoped reads: a tainted write parks for
  // approval instead of being refused (scope taint rule 8), and without the connection thread
  // its approval landed on an auto-created surface the MCP agent never watches.
  const turnCarriesTaint = (ctx.turnScopeAccumulator?.snapshot().length ?? 0) > 0
  const mayParkOnTaint =
    (turnCarriesTaint && toolDef.readOnly !== true) ||
    toolDef.externalEffect === true ||
    (typeof toolDef.requiresHumanTurn === "function"
      ? toolDef.requiresHumanTurn(policyParams())
      : toolDef.requiresHumanTurn === true)
  // A read that taints only for some results (knowledge of an outside source) needs the thread too.
  const mayTaint = taintSource || hostMayTaint(canonical)
  const provisionForOtherReason =
    gated || mayTaint || mayParkOnTaint || hasRefTokens || declaresCrossAppCalls
  if (!provisionForOtherReason && !ctx.connectionThreadId) {
    try {
      const decision = await evaluateApprovalPolicy({
        orgId: ctx.orgId,
        toolName: canonical,
        appName,
        params: policyParams(),
      })
      gatedByPolicy = decision.requireApproval
    } catch (err) {
      // The policy is the only thing that can answer "no thread needed" here.
      // When it cannot answer, provision: an extra thread costs a row, a missing
      // one costs the agent the surface its approval lands on.
      log.warn(
        { err, toolName: canonical },
        "approval policy unavailable — provisioning the MCP connection thread anyway",
      )
      gatedByPolicy = true
    }
  }
  if ((provisionForOtherReason || gatedByPolicy) && !ctx.connectionThreadId) {
    try {
      ctx.connectionThreadId = await ensureConnectionThread(
        ctx.connectionId,
        ctx.orgId,
        ctx.ownerUserId,
      )
    } catch (err) {
      await recordTurnScopes()
      throw err
    }
  }

  // The prefilter above provisions a connection thread only for STATICALLY
  // gated / taint / @ref calls. A tool whose static `gated` is false can still be
  // escalated to gated at RUNTIME by the org approval-tightening policy
  // (execute-tool's `effectiveGated`) — e.g. knowledge:update, whose manifest
  // declares no `gated` flag but which an org policy requires approval for. That
  // call reaches executeTool with no threadId and it throws "threadId required"
  // BEFORE creating any approval (and after clearing idempotency). Retry ONCE with
  // a freshly provisioned thread, keyed on executeTool's OWN gate decision, so this
  // covers every static-prefilter/runtime-gate divergence, not just policy
  // tightening. Still lazy: a read-only connection never provisions a thread.
  // WHETHER THIS CALL BROUGHT OUTSIDE TEXT IN, decided per call: the mark this
  // call's own run sets on the thread it runs under (execute-tool.ts, the
  // knowledge bridge), not the thread's standing mark, which an earlier read
  // set and every later result would otherwise inherit. A taint source that
  // runs with no thread to mark is counted as outside text: fail closed.
  let broughtOutsideText = false
  const runExecuteTool = async (params: Record<string, unknown> = args) => {
    const threadIds = [personThreadId, ctx.connectionThreadId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
    if (threadIds.length === 0 && taintSource) broughtOutsideText = true
    const watches = threadIds.map((id) => watchTaintMarks(id))
    try {
      return await runUnwatched(params)
    } finally {
      if (watches.some((watch) => watch.marked)) broughtOutsideText = true
      for (const watch of watches) watch.stop()
    }
  }
  const runUnwatched = (params: Record<string, unknown>) => {
    const run = () =>
      executeTool({
        toolName: canonical,
        orgId: ctx.orgId,
        actor: ctx.actor,
        params,
        threadId: personThreadId ?? ctx.connectionThreadId ?? undefined,
        ...(personThreadId && ctx.connectionThreadId && ctx.connectionThreadId !== personThreadId
          ? { alsoJudgeTaintOnThreadId: ctx.connectionThreadId }
          : {}),
        origin: "mcp",
        // WHICH AGENT is calling. Passed explicitly as well as carried by the
        // frame below, so the identity every audit and approval row stamps is
        // the same value on both paths (A11).
        agentId: ctx.agentId,
      })
    if (!frame) return run()
    // Inside the turn frame, with the pre-call snapshot bound exactly as the
    // tool bridge binds it: a nested dispatch or a sandbox hop inherits THIS
    // turn's taint rather than starting from nothing.
    return runContextStore.run(frame, () => runWithToolCallScopesBefore(touchedBefore ?? [], run))
  }

  try {
    let result: Awaited<ReturnType<typeof runExecuteTool>>
    try {
      result = await runExecuteTool()
    } catch (err) {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === "string" && msg.includes("threadId required") && !ctx.connectionThreadId) {
        ctx.connectionThreadId = await ensureConnectionThread(
          ctx.connectionId,
          ctx.orgId,
          ctx.ownerUserId,
        )
        result = await runExecuteTool()
      } else {
        // Only the dispatch's own refusal skips the record: a handler that returns the
        // same code has run, and records like any other call.
        // Nor does a call the platform refused before its handler ran: it read nothing.
        if (isPlatformTaintRefusal(err) || wasRefusedBeforeRun(err, canonical)) {
          await persistRefusedByPlatform()
        } else await recordTurnScopes()
        throw err
      }
    }

    // A GATED CALL PARKED FOR APPROVAL BRINGS NOTHING INTO THE TURN. Its handler
    // never ran: the result is an approval handle and a summary built from the
    // caller's own arguments, no org data at all. Recording its scope would
    // taint the turn (and, here, the connection's 15-minute window) on a call
    // that read nothing, and the next gated call would then be refused as a
    // write from a tainted turn instead of joining the bundle. That is exactly
    // the compound bundle an MCP client stages ("reply plus proforma plus
    // label" under one human decision). The write itself is still judged: the
    // approval row carries `proposing_turn_scopes` and the approved re-entry
    // writes with them.
    if (isParkedForApproval(result)) await persistWindowOnly()
    else await recordTurnScopes()

    // A read that just filed an origin only filed it into THIS request's
    // accumulator (`execute-tool.ts`, A46b). Written back here, after the call
    // settled, so the next POST judges its write against the rows this one
    // actually read. Nothing is written for a call that filed nothing.
    if (accumulator && ctx.agentId) {
      const origins = accumulator.originRows()
      if (Object.keys(origins).length > 0) {
        await saveConnectionTurnTaintOrigins(ctx.orgId, ctx.agentId, origins)
      }
    }

    if (result.blocked) {
      // Use the SAME decision-audience value executeTool computed and passed to
      // createApprovalRequest (spec C7) — never a divergent re-derivation.
      const selfApproveEligible = result.blocked.requesterCanApprove === true
      const approvalRequestId = result.blocked.approvalRequestId ?? null
      // Deep-link to the thread the approval actually lives in: the
      // originating (connection) thread. Fall back to the connection thread
      // only if the approval row can't be resolved.
      const approvalRef = approvalRequestId
        ? await resolveApprovalRef(ctx.orgId, approvalRequestId)
        : null
      const approvalThreadId = approvalRef?.threadId ?? personThreadId ?? ctx.connectionThreadId
      const approvalHandle = approvalRef?.handle ?? null
      // WHO has to act. Without it the agent reports "pending" and stops, the
      // approver is never told to decide, and the user reads the silence as a
      // broken platform (the 2026-09-11 Elevator Sound session, where three
      // correct requests sat undecided while the user re-asked and stacked
      // duplicates). Built from the SAME selfApproveEligible bit reported below.
      // D18: the gated tool's notes for the agent (a node routine's risk note)
      // ride on the result, and their relay order on the message.
      const agentNotes = result.blocked.agentNotes
      const actionRequired =
        approvalActionRequiredClause(selfApproveEligible) + gatedNotesRelay(agentNotes)
      // Sequencing parity with the in-app agent (execute-tool's BlockedEnvelope):
      // when this gated tool declares referenceableOutputs, executeTool minted
      // `@ref:<approvalId>:<key>` tokens in `blocked.outputs` + a self-teaching
      // `hint`. The in-app agent gets these via tool-bridge; MCP clients used to
      // never see them, so an external agent could only ever stage ORPHAN
      // approvals — it had no way to say "this shipment depends on the proforma I
      // just staged". Passing them through gives MCP the SAME one-approval @ref
      // chaining power: copy a token from `outputs` verbatim into a later gated
      // call's param and executeTool's resolveBundleForRefs links both into one
      // compound approval (the connection thread is stable across MCP calls, so
      // the bundle resolves even though each call is a separate request).
      const seq = result.blocked.outputs
        ? {
            // The chaining instruction is the agent's ONLY channel over MCP; make
            // the "don't blindly retry" message coexist with "you MAY chain now".
            message:
              "This action did NOT execute: it is PENDING human approval (see approvalRequestId/approvalUrl). Report it to the user as proposed/pending, never as done, sent, created, or in progress, and refer to it by `approvalHandle` (the request-N label shown on the approval card); keep the uuid for tool calls. This tool exposes `outputs` (@ref tokens): to stage a dependent action that consumes this one's result, copy the matching token from `outputs` VERBATIM into a later gated call's parameter now, do not wait for this approval to resolve, and do not re-run THIS call. Chained steps bundle into a single approval the human decides at once. To fix a mistake in THIS pending request: if only its CONTENT is wrong, edit it with kernel__approval_update_payload; if the request should not exist at all, withdraw it with kernel__approval_withdraw and then create the corrected request; never retry the original call to try to fix it, that only creates a duplicate pending approval. " +
              actionRequired,
            outputs: result.blocked.outputs,
            hint: result.blocked.hint ?? null,
            sequenced: result.blocked.sequenced ?? false,
          }
        : {
            // Behavioral contract delivered AT the relevant moment — MCP parity with the
            // in-app agent's gated-result message in tool-bridge's executeWrapper (the
            // single source of truth for gating semantics; external clients never see
            // the in-app chat system prompt, so this field is their only channel).
            message:
              "This action did NOT execute: it is PENDING human approval (see approvalRequestId/approvalUrl). Report it to the user as proposed/pending, never as done, sent, created, or in progress, and refer to it by `approvalHandle` (the request-N label shown on the approval card); keep the uuid for tool calls. Do NOT retry the same call: that only creates duplicate pending approvals. If `summary` warns the action is irreversible or destructive, relay that warning to the user explicitly before they approve. To fix a mistake in THIS pending request: if only its CONTENT is wrong, edit it with kernel__approval_update_payload; if the request should not exist at all, withdraw it with kernel__approval_withdraw and then create the corrected request; never retry the original call to try to fix it. " +
              actionRequired,
          }
      // Surface on the gated path too: staging a gated action is exactly when
      // the playbook matters most (the 2026-08-04 session staged five label
      // purchases without it).
      return await appendAnchoredSkills(
        ctx,
        canonical,
        mcpStructuredResult({
          gated: true,
          executed: false,
          ...seq,
          approvalRequestId,
          // The `request-N` label printed on the approval card and feed row.
          // Cite THIS to the user — it is the reference they can see and
          // search for; the uuid is for tool calls (approval_status, @ref).
          approvalHandle,
          approvalUrl: approvalThreadId
            ? `${await orgPublicBaseUrl(ctx.orgId)}/threads/${approvalThreadId}`
            : null,
          // What opening that link does, so the agent can tell the user before
          // they click: a browser with no Liaison session (Claude's built-in
          // one) shows the sign-in page first and comes back here after.
          approvalUrlNote: APPROVAL_URL_NOTE,
          ...(approvalRef?.mailboxSealed
            ? { mailboxSealed: true, mailboxSealedNote: MAILBOX_SEALED_APPROVAL_NOTE }
            : {}),
          reason: result.blocked.reason,
          summary: result.blocked.summary ?? null,
          selfApproveEligible,
          ...(agentNotes ?? {}),
        }),
      )
    }

    // An end-to-end encrypted mailbox answers with an envelope and a marker:
    // the plaintext can only come from the same user's unlocked Liaison window.
    let data: unknown = result.data
    if (readMailboxMarker(data)) {
      if (!ctx.connectionThreadId) {
        ctx.connectionThreadId = await ensureConnectionThread(
          ctx.connectionId,
          ctx.orgId,
          ctx.ownerUserId,
        )
      }
      const fulfilment = await fulfilMcpMailboxMarker({
        result: data,
        orgId: ctx.orgId,
        userId: ctx.actor.userId ?? ctx.ownerUserId,
        connectionId: ctx.connectionId,
        threadId: ctx.connectionThreadId,
        toolName: canonical,
        ...(typeof args.conversationId === "string" ? { conversationId: args.conversationId } : {}),
      })
      if (fulfilment.retryArgs) {
        // The search ran its free-text half in the user's window; the retry
        // carries the ids it matched, exactly as the in-app tool bridge does.
        data = (await runExecuteTool({ ...args, ...fulfilment.retryArgs })).data
      } else {
        data = fulfilment.result
      }
    }

    const shaped = mcpToolResult(data)
    return await appendAnchoredSkills(
      ctx,
      canonical,
      broughtOutsideText ? noticeOutsideText(shaped) : shaped,
    )
  } catch (err: unknown) {
    await recordTurnScopes()
    const e = err as {
      code?: unknown
      message?: unknown
      status?: number
      details?: { retryable?: boolean }
    }
    let code = typeof e.code === "string" ? e.code : "tool_error"
    if (err instanceof HTTPException) {
      if (err.status === 403) code = "forbidden"
      else if (err.status === 404) code = "tool_not_found"
    }
    const failed = mcpErrorResult({
      code,
      message: typeof e.message === "string" ? e.message : "Tool execution failed",
      retryable: !!e.details?.retryable,
    })
    // A handler that had outside text in hand before it failed may have put
    // some of it in its message.
    return broughtOutsideText ? noticeOutsideText(failed) : failed
  }
}

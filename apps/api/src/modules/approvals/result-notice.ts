// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APPROVED CALL'S RESULT, HANDED BACK TO THE AGENT THAT ASKED FOR IT.
//
// A gated tool call does not run in the turn that makes it: the agent gets
// `pending_approval`, a person approves later, and the handler runs on the
// approved re-entry, outside any turn. Its output was stored
// (`approved_handler_executions.result`) and nothing more: the thread got the
// fixed "Approved by X. Tool executed successfully." notice, and no agent tool
// reads an approval's result. Asked to go on, an agent that had a gated search
// approved had nothing to go on, and said the search "returned nothing".
//
// So the approved re-entry posts one more platform row in the conversation
// that proposed the call: the result itself, replayed to the agent as a fact
// (system-event-replay.ts). The row is tagged with what the result may reveal:
// the proposing turn's scopes (what the call's arguments came from, the same
// set the re-entry's own writes carry) plus the tool's own scopes (what its
// output reads), so a person who could not have run the call cannot read its
// output off the thread.
//
// The output is a tool result like any other, so it gets the same trust
// treatment: a `taintSource` tool (every MCP tool, any reader of outside text)
// marks the conversation as having read outside text through the helper the
// live call uses, and the transcript fences the output as untrusted data
// (system-event-replay.ts). The scope taint rides on the row's required scopes,
// which the history loader records on every turn that replays it.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { UUID_RE } from "~/lib/uuid"
import { failureContextRequiredScopes } from "~/modules/agent/runtime/reinvoke"
import { markThreadsForTaintSourceResult } from "~/modules/agent/scopes/taint"
import {
  approvalReentryWriteScopes,
  normalizeRequiredScopes,
} from "~/modules/agent/scopes/write-required-scopes"
import { postDualSystemMessages } from "~/modules/approvals/event-data"
import { type RequiredStep, requiredStepOf } from "~/modules/approvals/required-step"
import { splitToolName } from "~/modules/approvals/tool-name"
import { toolRegistry } from "~/modules/apps/app-registries"

/** The most result text one notice carries; a longer result is clipped, and says so. */
export const APPROVAL_RESULT_MAX_CHARS = 12_000

/** The result as the agent reads it: JSON, clipped with an explicit marker. */
export function formatApprovalResult(result: unknown): string {
  if (result === null || result === undefined) return "(the tool returned no output)"
  let text: string
  try {
    text = typeof result === "string" ? result : JSON.stringify(result)
  } catch {
    text = String(result)
  }
  if (text.length <= APPROVAL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, APPROVAL_RESULT_MAX_CHARS)} …[clipped: ${text.length} characters in all]`
}

/**
 * The secure card an approved `kernel:request_secret` call filed, or null.
 *
 * In the turn, the web draws the card under the tool call from its result's
 * `requestId`. A call parked for approval has no such result in its turn: it
 * ran on the approved re-entry, and only this notice reaches the conversation.
 * So the notice carries the card's id as a field of its own (never read out of
 * the fenced text), and the web draws the card under it, live and after a
 * reload, exactly as under a call that ran in the turn (2026-10-27: an approved
 * Connect card never appeared). Only the host's own kernel tool names it: no
 * manifest app registers under `kernel`.
 */
export interface ApprovedSecretCard {
  secretRequestId: string
  /** `already_posted`: the same pending card was already in the conversation. */
  card: "posted" | "already_posted"
}

export function approvedSecretCardOf(toolName: string, result: unknown): ApprovedSecretCard | null {
  const { appName, toolShortName } = splitToolName(toolName.replace("__", ":"))
  if (appName !== "kernel" || toolShortName !== "request_secret") return null
  let doc: unknown = result
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc)
    } catch {
      return null
    }
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null
  const r = doc as { requestId?: unknown; card?: unknown }
  if (typeof r.requestId !== "string" || !UUID_RE.test(r.requestId)) return null
  return {
    secretRequestId: r.requestId,
    card: r.card === "already_posted" ? "already_posted" : "posted",
  }
}

/** The scopes the result notice requires of a reader (see the header). */
export function approvalResultRequiredScopes(args: {
  orgId: string
  toolName: string
  proposingTurnScopes: unknown
  requesterScopes: string[]
}): string[] {
  const { appName, toolShortName } = splitToolName(args.toolName)
  const tool = toolRegistry.get([args.orgId, appName, toolShortName]) as
    | { requiredScopes?: unknown }
    | undefined
  const toolScopes = Array.isArray(tool?.requiredScopes)
    ? (tool.requiredScopes as unknown[]).filter((s): s is string => typeof s === "string")
    : // The tool is gone from the registry: nothing says what its output reads,
      // so fail closed to everything the requester holds.
      args.requesterScopes
  return normalizeRequiredScopes([
    ...approvalReentryWriteScopes(args.proposingTurnScopes, args.requesterScopes),
    ...toolScopes,
  ])
}

/**
 * The scopes a notice about a FAILED approved call requires of a reader. It can
 * quote the handler's error, which holds at most what the call's result could:
 * so the same set as the result notice, what the proposing turn read plus what
 * the tool reads.
 *
 * Stamping the requester's whole scope set here instead tainted the conversation:
 * the next turn read the notice as history, and its taint became everything the
 * person may read. A gated write in that thread was then refused for good, on a
 * scope the turn's actor did not hold, when it was only a date the handler had
 * turned down. The whole set is the answer only when nothing says what the call
 * read: a proposal with no record of its turn's scopes, or a tool no longer
 * registered.
 */
export function approvalFailureRequiredScopes(args: {
  orgId: string
  toolName: string
  proposingTurnScopes: unknown
  requesterScopes: string[]
}): string[] {
  const { appName, toolShortName } = splitToolName(args.toolName)
  const tool = toolRegistry.get([args.orgId, appName, toolShortName]) as
    | { requiredScopes?: unknown }
    | undefined
  if (!Array.isArray(args.proposingTurnScopes) || !Array.isArray(tool?.requiredScopes)) {
    return failureContextRequiredScopes(args.requesterScopes, args.orgId)
  }
  return approvalResultRequiredScopes(args)
}

/**
 * {@link approvalFailureRequiredScopes} for a notice that describes a whole
 * bundle (the failed step and what its siblings returned): the union over its steps.
 */
export async function bundleFailureRequiredScopes(
  tx: Pick<PrivilegedDb, "execute">,
  args: { orgId: string; bundleId: string; failedStepId?: string; requesterScopes: string[] },
): Promise<string[]> {
  const steps = extractRows<{ tool_name: string; proposing_turn_scopes: unknown }>(
    await tx.execute(drizzleSql`
      SELECT tool_name, proposing_turn_scopes FROM ${drizzleSql.raw(schemaRef("kernel"))}.approval_requests
      WHERE org_id = ${args.orgId}::uuid
        AND (id = ${args.failedStepId ?? args.bundleId}::uuid OR bundle_id = ${args.bundleId}::uuid)`),
  )
  if (steps.length === 0) return failureContextRequiredScopes(args.requesterScopes, args.orgId)
  return normalizeRequiredScopes(
    steps.flatMap((step) =>
      approvalFailureRequiredScopes({
        orgId: args.orgId,
        toolName: step.tool_name,
        proposingTurnScopes: step.proposing_turn_scopes,
        requesterScopes: args.requesterScopes,
      }),
    ),
  )
}

/**
 * Mark the proposing conversation as the live call would have (before the
 * notice is written), and return the result text the notice may carry. When the
 * mark cannot be recorded the result is withheld, as the live call withholds it.
 */
export async function approvalResultForConversation(args: {
  orgId: string
  toolName: string
  payload: unknown
  originatingThreadId: string
  result: unknown
}): Promise<{
  text: string
  outsideText: boolean
  requiredStep: RequiredStep | null
  secretCard: ApprovedSecretCard | null
}> {
  const { appName, toolShortName } = splitToolName(args.toolName)
  const tool = toolRegistry.get([args.orgId, appName, toolShortName]) as
    | Parameters<typeof markThreadsForTaintSourceResult>[0]
    | undefined
  try {
    // A tool no longer registered cannot say what it read: count it as outside text.
    const outsideText = await markThreadsForTaintSourceResult(
      tool ?? { taintSource: true },
      args.payload,
      args.orgId,
      [args.originatingThreadId],
      args.toolName,
      { result: args.result },
    )
    return {
      text: formatApprovalResult(args.result),
      outsideText,
      // A step the platform states outside the fence: an enumerated code a
      // registered host tool entry named, never text from the result (required-step.ts).
      requiredStep: requiredStepOf({ tool, result: args.result, outsideText }),
      secretCard: approvedSecretCardOf(args.toolName, args.result),
    }
  } catch (err) {
    log.error(
      { err, toolName: args.toolName, threadId: args.originatingThreadId },
      "Failed to mark the conversation for an approved call's result: result withheld",
    )
    return {
      text: `(the result was withheld because this conversation could not be marked as having read outside content: ${err instanceof Error ? err.message : String(err)})`,
      outsideText: true,
      requiredStep: null,
      secretCard: null,
    }
  }
}

/** Post the approved call's result into the conversation that proposed it. */
export async function postApprovalResultNotice(
  tx: PrivilegedDb,
  args: {
    orgId: string
    requestId: string
    requestHandle: string
    toolName: string
    originatingThreadId: string
    requesterId: string
    requiredScopes: string[]
    /** From `approvalResultForConversation`. */
    result: {
      text: string
      outsideText: boolean
      requiredStep?: RequiredStep | null
      secretCard?: ApprovedSecretCard | null
    }
  },
): Promise<void> {
  await postDualSystemMessages(tx, {
    requiredScopes: args.requiredScopes,
    orgId: args.orgId,
    // The proposing conversation only: that is where the agent's turn reads it.
    threadId: args.originatingThreadId,
    originatingThreadId: args.originatingThreadId,
    requesterId: args.requesterId,
    actorUserId: args.requesterId,
    content: `${args.requestHandle} ran; its result was passed to the agent.`,
    metadata: {
      type: "approval-result",
      requestId: args.requestId,
      requestHandle: args.requestHandle,
      toolName: args.toolName,
      result: args.result.text,
      // What a turn replaying this row reads to re-mark itself (replayed-outside-text.ts).
      tainted: args.result.outsideText,
      // The required step as a code, replayed as a platform line outside the
      // untrusted fence from a fixed template (required-step.ts).
      ...(args.result.requiredStep ? { requiredStep: args.result.requiredStep } : {}),
      // The card the call filed: drawn under this line (web), and stated to the
      // agent as a platform line outside the fence (system-event-replay.ts).
      ...(args.result.secretCard
        ? {
            secretRequestId: args.result.secretCard.secretRequestId,
            secretCard: args.result.secretCard.card,
          }
        : {}),
    },
    // A platform row about a person's decision, not an agent's speech (A11).
    agentId: null,
  })
}

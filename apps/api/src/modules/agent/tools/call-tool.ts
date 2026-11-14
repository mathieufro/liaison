// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel__call_tool: THE STABLE ENTRY FOR A TOOL LOADED OUTSIDE THE TOOL LIST.
//
// A thread's tool list is fixed (providers/fixed-tool-list.ts). A tool loaded
// later arrives with its schema in the conversation and is called through
// this tool: {"name": <tool>, "arguments": {...}}. A well-formed call to a
// loaded tool never reaches this handler: the model middleware turns it into
// a call to the tool itself, so the tool runs under its own name (approvals,
// records, the tool's own errors). What reaches here is everything else, and
// each answer says exactly what to do next:
//   - arguments that do not fit the tool: the tool's name, what is wrong and
//     its expected parameters, so the next call can be right;
//   - a tool the turn has not loaded: it is loaded now, and called next step;
//   - a tool that left with its feature, for a caller holding its scope: `feature_off`;
//   - a name no tool has: the closest names.

import { ToolError } from "@liaison/app-sdk"
import { CALL_TOOL_SDK_NAME } from "~/modules/agent/providers/fixed-tool-list"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  featureOffAnswerForCall,
  resolveHeldToolName,
} from "~/modules/agent/tools/tool-name-resolve"
import { loadToolsForNextStep } from "~/modules/agent/tools/tool-search"

interface CallToolContext {
  orgId: string
  userId?: string
  scopes?: string[]
}

/** How a correct call through the entry reads, for `name`. */
function callForm(name: string): string {
  return `${CALL_TOOL_SDK_NAME} with {"name": "${name}", "arguments": {...}}`
}

/**
 * A call this entry refuses: the model's to correct, never a server fault. So it answers as a 4xx
 * the model may retry with what the message tells it to change, and logs at warn. Thrown as a
 * plain Error it read "HTTP 500 tool_error", logged at error, and counted as a terminal failure.
 */
function refusal(message: string): ToolError {
  return new ToolError(message, { code: "invalid_params", retryable: true })
}

/** The argument names the tool does not take, with what it does take: the usual wrong call passes
 *  `document_id` to a tool whose parameter is `id`. */
function unknownArguments(args: unknown, parameters: unknown): string {
  const known = (parameters as { properties?: Record<string, unknown> } | null)?.properties
  if (!known || !args || typeof args !== "object") return ""
  const unknown = Object.keys(args).filter((k) => !Object.hasOwn(known, k))
  if (unknown.length === 0) return ""
  return ` It does not take ${unknown.join(", ")}; it takes ${Object.keys(known).join(", ")}.`
}

/** The answer to an argument error: the tool, what is wrong, and the parameters it expects. */
export function invalidArgumentsMessage(
  name: string,
  error: string,
  parameters: unknown,
  args?: unknown,
): string {
  return (
    `Invalid arguments for ${name}: ${error}. It did not run.${unknownArguments(args, parameters)} ` +
    `Its parameters (JSON Schema): ${JSON.stringify(parameters)}. ` +
    `Call ${callForm(name)} again with arguments that match them.`
  )
}

export async function handleCallTool(
  params: { name: string; arguments?: unknown },
  ctx: CallToolContext,
): Promise<unknown> {
  const frame = currentRunContext()
  const fixed = frame?.fixedToolList
  if (!fixed) {
    throw refusal(
      `${CALL_TOOL_SDK_NAME} is not needed here: every loaded tool is in your tool list. Call ${params.name} directly by its exact name.`,
    )
  }
  const held = [...(frame?.turnToolNames ?? [])]
  const resolution = resolveHeldToolName(params.name, held)
  if (resolution.kind !== "exact" && resolution.kind !== "resolved") {
    // Returned, not thrown: the refusal is about that tool, and a throw would count
    // against this entry, which every other loaded tool still needs.
    const off = featureOffAnswerForCall(ctx.orgId, params.name, ctx.scopes ?? [])
    if (off) return { ran: false, ...off }
    if (resolution.kind === "ambiguous") {
      throw refusal(
        `No tool is named "${params.name}", and several tools you hold match it: ${resolution.candidates.join(", ")}. Call the one you mean by its exact name through ${CALL_TOOL_SDK_NAME}.`,
      )
    }
    const close =
      resolution.suggestions.length > 0
        ? ` Closest names you hold, which may not do the same job: ${resolution.suggestions.join(", ")}.`
        : ""
    throw refusal(
      `No tool named "${params.name}" is available to you; it may have been renamed or replaced by another tool.${close} ` +
        `To find the tool for the job, describe the job in words with kernel__tool_search (for example "mail sync status"), then call what it returns through ${CALL_TOOL_SDK_NAME}. ` +
        `"select:<exact name>" only works for a name that search has returned.`,
    )
  }
  const name = resolution.name
  if (name === CALL_TOOL_SDK_NAME) {
    throw refusal(`Name the tool to call in "name", not ${CALL_TOOL_SDK_NAME} itself.`)
  }
  if (!fixed.isLoaded(name)) {
    const note = await loadToolsForNextStep(ctx, [name])
    if (!fixed.isLoaded(name)) {
      throw refusal(note ?? `${name} is not available to you in this turn.`)
    }
    return {
      ran: false,
      note: `${name} was not loaded yet, so it did not run. It is loaded now: its description and parameters follow in the next note. Call ${callForm(name)}.`,
    }
  }
  // A call is the model asking for the tool: one it knew by name only gets
  // its schema in the next note too, so its later calls are informed.
  fixed.requestSchemas?.([name])
  const schema = fixed.describe(name)
  const args = params.arguments ?? {}
  const checked = await fixed.validate(name, args)
  if (!checked.ok) {
    throw refusal(invalidArgumentsMessage(name, checked.error, schema?.parameters ?? {}, args))
  }
  // A well-formed call is run as the tool itself before it reaches here; one
  // that still arrives (an unusual input shape) is not run twice by guessing.
  if (fixed.listed.has(name)) {
    return { ran: false, note: `${name} is in your tool list: call it directly by its name.` }
  }
  return {
    ran: false,
    note: `${name} did not run: call ${callForm(name)} again, with its arguments object in "arguments".`,
  }
}

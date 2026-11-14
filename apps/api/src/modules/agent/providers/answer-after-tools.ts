// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A step that follows tool results and says NOTHING.
 *
 * Gemini now and then ends a turn right after a large tool result with an empty
 * step: no text, no tool call, a clean `stop` (live Oracle walk, 2026-09-23,
 * after a 38 KB kpi_list_metrics result). The SDK sees a step without tool
 * calls, ends the loop, and the person gets no answer at all, only the
 * platform's "ended with no text" notice.
 *
 * This middleware notices that shape on the way out of the provider and asks
 * the model ONCE to answer: when a step whose prompt ends in tool results comes
 * back with no text and no tool call, the same call is re-issued with one
 * extra user line asking for the answer, and the second stream stands in for
 * the first. The usage of both calls is summed on the finish part, and so is
 * a cost the provider reported (OpenRouter), so credits stay honest. Bounded: one continuation per wrapped model, and a wrapped
 * model lives for one turn (`runAgentStream` wraps per call).
 *
 * The summed input is the step's COST, not its context: the context the model
 * saw is one request's input. The finish part carries the answering request's
 * own input under ANSWER_AFTER_TOOLS_METADATA_KEY, and `stepContextInputTokens`
 * is what the agent loop reads as a step's context size (the compaction
 * trigger). Without it a re-issued step reported twice its context (demo
 * 2026-10-12: 66,356 for a context of about 33,000).
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai"
import { rootLogger } from "~/lib/logger"
import { readProviderCostUsd } from "./step-usage"
import { isWrappableModel } from "./wrappable-model"

const log = rootLogger.child({ module: "answer-after-tools" })

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type StreamResult = Awaited<ReturnType<WrapStream>>
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never
type CallOptions = Parameters<WrapStream>[0]["params"]
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]

/** The line the continuation adds. Plain words, no tool names. */
export const ANSWER_AFTER_TOOLS_NUDGE =
  "Your last step returned no answer. Using the tool results above, write your answer to the question now. If the results do not answer it, say so plainly."

/** The provider-metadata key the re-issued step's own input rides under. */
export const ANSWER_AFTER_TOOLS_METADATA_KEY = "liaisonAnswerAfterTools"

/**
 * A step's context size in input tokens: the answering request's own input
 * when the step was re-issued, else the step's input. `inputTokens` is the
 * step's (summed) usage, `providerMetadata` its finish-step metadata.
 */
export function stepContextInputTokens(
  inputTokens: number | undefined,
  providerMetadata: unknown,
): number | undefined {
  const own = (providerMetadata as Record<string, { requestInputTokens?: unknown }> | undefined)?.[
    ANSWER_AFTER_TOOLS_METADATA_KEY
  ]?.requestInputTokens
  return typeof own === "number" ? own : inputTokens
}

/** Total input of a provider-level usage object (`{ inputTokens: { total } }`). */
function requestInputTotal(usage: unknown): number | undefined {
  const total = (usage as { inputTokens?: { total?: unknown } } | undefined)?.inputTokens?.total
  return typeof total === "number" ? total : undefined
}

/** Finish reasons that are not a silent stop: never continued. */
const NOT_SILENT = new Set(["length", "content-filter", "error"])

/** Add numeric leaves of two usage objects (nested `{ total, ... }` included). */
function sumUsage(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a + b
  if (typeof a === "number" && b == null) return a
  if (a == null && typeof b === "number") return b
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out: Record<string, unknown> = { ...(b as Record<string, unknown>) }
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      out[k] = sumUsage(v, (b as Record<string, unknown>)[k])
    }
    return out
  }
  return b ?? a
}

type FinishPart = Extract<StreamPart, { type: "finish" }>
type ProviderMetadata = FinishPart["providerMetadata"]

/**
 * The re-issued step's provider metadata: the answering call's, with OpenRouter's reported
 * cost (`openrouter.usage.cost`, step-usage.ts) covering BOTH calls, since both are billed.
 * When either call reported no cost the sum is unknown, so the cost is dropped and the meter
 * prices the step from its (summed) tokens instead. Unchanged for any other provider.
 */
type JsonValue = Exclude<NonNullable<ProviderMetadata>[string][string], undefined>
type JsonObject = { readonly [key: string]: JsonValue | undefined }

function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v)
}

function withBothCallsCost(first: ProviderMetadata, second: ProviderMetadata): ProviderMetadata {
  const router = second?.openrouter
  if (!router) return second
  const usage = router.usage
  if (!isJsonObject(usage)) return second
  const a = readProviderCostUsd(first)
  const b = readProviderCostUsd(second)
  const rest: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(usage)) if (k !== "cost" && v !== undefined) rest[k] = v
  return {
    ...second,
    openrouter: {
      ...router,
      usage: a === undefined || b === undefined ? rest : { ...rest, cost: a + b },
    },
  }
}

function endsInToolResults(params: CallOptions): boolean {
  const prompt = params.prompt as Array<{ role: string }>
  return prompt.length > 0 && prompt[prompt.length - 1]?.role === "tool"
}

/**
 * Tools that close a reply instead of gathering for it: chips drawn under an
 * answer already written. A model that writes its answer, calls one of these
 * and then says nothing more has finished, and must not be asked to answer
 * again (that wrote the same answer twice into one reply).
 */
export const REPLY_CLOSING_TOOLS: ReadonlySet<string> = new Set(["kernel__suggest_next_steps"])

type PromptPart = { type?: string; text?: unknown; toolName?: unknown }
type PromptMessage = { role: string; content: unknown }

/**
 * True when the turn's steps since its last tool that gathered something wrote
 * text, and every call after that closed the reply: the silent step is the end
 * of an answer already given. Text in a step that also called a gathering tool
 * is a note before that tool ("I'll check"), not an answer.
 */
function answeredBeforeClosing(params: CallOptions): boolean {
  const prompt = params.prompt as PromptMessage[]
  let wrote = false
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]
    if (message?.role === "tool") continue
    if (message?.role !== "assistant") break
    const parts = Array.isArray(message.content) ? (message.content as PromptPart[]) : []
    const gathers = parts.some(
      (p) => p.type === "tool-call" && !REPLY_CLOSING_TOOLS.has(String(p.toolName)),
    )
    if (gathers) break
    if (typeof message.content === "string" && message.content.trim().length > 0) wrote = true
    if (
      parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "")
    ) {
      wrote = true
    }
  }
  return wrote
}

function createAnswerAfterToolsMiddleware(): LanguageModelMiddleware {
  let used = false
  return {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params, model }) => {
      const result = await doStream()
      if (used || !endsInToolResults(params) || answeredBeforeClosing(params)) return result

      let said = false
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          async transform(part, controller) {
            if (part.type === "text-delta" && part.delta.trim().length > 0) said = true
            if (part.type === "tool-call" || part.type === "tool-input-start") said = true
            if (part.type !== "finish") {
              controller.enqueue(part)
              return
            }
            const reason = (part.finishReason as { unified?: string } | string | undefined) ?? ""
            const unified = typeof reason === "string" ? reason : (reason.unified ?? "")
            if (said || used || NOT_SILENT.has(unified)) {
              controller.enqueue(part)
              return
            }
            used = true
            log.warn(
              { finishReason: unified },
              "Step after tool results ended with no text and no call; asking the model once to answer",
            )
            const retry = await model.doStream({
              ...params,
              prompt: [
                ...params.prompt,
                { role: "user", content: [{ type: "text", text: ANSWER_AFTER_TOOLS_NUDGE }] },
              ] as CallOptions["prompt"],
            })
            const reader = retry.stream.getReader()
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              // One stream, one start: the first call already opened it.
              if (value.type === "stream-start") continue
              if (value.type === "finish") {
                const own = requestInputTotal(value.usage)
                const providerMetadata = withBothCallsCost(
                  part.providerMetadata,
                  value.providerMetadata,
                )
                controller.enqueue({
                  ...value,
                  usage: sumUsage(part.usage, value.usage) as typeof value.usage,
                  ...(own === undefined && providerMetadata === value.providerMetadata
                    ? {}
                    : {
                        providerMetadata: {
                          ...(providerMetadata ?? {}),
                          ...(own === undefined
                            ? {}
                            : { [ANSWER_AFTER_TOOLS_METADATA_KEY]: { requestInputTokens: own } }),
                        },
                      }),
                })
                continue
              }
              controller.enqueue(value)
            }
          },
        }),
      )
      return { ...result, stream }
    },
  }
}

/** Wrap a model object for one turn; a model given by id string is left to the SDK. */
export function withAnswerAfterTools<M>(model: M): M {
  if (isWrappableModel(model)) {
    return wrapLanguageModel({
      model: model as unknown as WrappableModel,
      middleware: createAnswerAfterToolsMiddleware(),
    }) as unknown as M
  }
  return model
}

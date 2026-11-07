// SPDX-License-Identifier: FSL-1.1-ALv2
import { agentNoticeStoredText, clientSurfaceSchema, reasoningLevelSchema } from "@liaison/shared"
import { eq, sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { messages } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { rootLogger } from "~/lib/logger"
import { refusesNewWork } from "~/lib/readiness"
import { redis } from "~/lib/redis"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { zValidator } from "~/lib/validate"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { attachedFilesNote } from "~/modules/agent/context/context"
import {
  redactMailToolArgs,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { forwardMailboxAnswer } from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import {
  type MailboxAnswerInput,
  type MailboxRequestResponse,
  ownsMailboxRequestId,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import { stepContextInputTokens } from "~/modules/agent/providers/answer-after-tools"
import { addProviderCostUsd, readStepUsage } from "~/modules/agent/providers/step-usage"
import { type AcceptedTurn, acceptTurn } from "~/modules/agent/runtime/active-turns"
import {
  FENCED_REASON,
  HANDOFF_FINISH_REASON,
  runAgentChat,
  serializeStreamError,
  type TurnTimelineEntry,
} from "~/modules/agent/runtime/agent-service"
import { autoTitleAgentChat } from "~/modules/agent/runtime/auto-title"
import { createLiveTextGate } from "~/modules/agent/runtime/shared-thread-reply"
import {
  type LiveAgentStreamSnapshot,
  listLiveAgentStreams,
  markAgentStreamStepBoundary,
  type RecordedFrame,
  recordAgentStreamEvent,
} from "~/modules/agent/runtime/stream-registry"
import {
  type ToolCallPresentation,
  type ToolCardFields,
  toolCallPresentation,
  toolCardFieldsForResult,
} from "~/modules/agent/runtime/tool-card-store"
import { turnStatus } from "~/modules/agent/runtime/turn-ledger"
import { takeStreamSlot } from "~/modules/agent/stream-slots"
import { uiEffectRequester } from "~/modules/agent/tools/open-targets"
import { PaymentRequiredError } from "~/modules/cloud/suspension"
import { FileServiceError, moveFilesToParent } from "~/modules/files/service"
import { getThread } from "~/modules/threads/thread"
import { isMessageVisible } from "~/services/security/visibility"

const log = rootLogger.child({ module: "agent-routes" })

// The SAME text finalize() persists for an errored turn (agent-service.ts): the fixed
// English line naming the failure's class, then the failure's own detail made safe to
// show (no stack, secret-shaped tokens masked, bounded). Each surface renders the class
// in its reader's language; the conversation shows the detail under it.
function userFacingAgentError(detail: string | null): string {
  return agentNoticeStoredText(detail)
}

// 10 rpm and 2 concurrent streams are production-safe defaults. The k6 A3
// profile drives a single user at much higher rates from one IP and would
// otherwise see ~100% 429 — gate both on the same flag that exposes
// /api/__loadtest/*. Production images leave the flag off.
const LOADTEST_MODE = envFlag("ENABLE_LOAD_TEST_ENDPOINT")
// In test mode we use an effectively-unbounded budget so a long scenario file
// hitting the same user across many tests in a single minute can't be
// rate-limited by the per-user agent-chat limiter. The e2e suite already
// enforces sequencing; cross-test bleed of HTTP 429 caused S8+ cascades.
const AGENT_CHAT_RPM = process.env.NODE_ENV === "test" ? 1_000_000 : LOADTEST_MODE ? 1_000_000 : 10
// Concurrent stream cap, counted across the cell (stream-slots.ts). Unset, it is
// also too low in test mode: a previous test's stream teardown is not
// instantaneous on the server side, and the next test can initiate before its
// slot is released, surfacing as a spurious 429. An explicit
// AGENT_MAX_CONCURRENT_STREAMS wins in every mode.
const MAX_CONCURRENT_STREAMS =
  env.AGENT_MAX_CONCURRENT_STREAMS ??
  (process.env.NODE_ENV === "test" || LOADTEST_MODE ? 10_000 : 2)

// null is allowed for Auto mode (explicit null = "pick for me")
const chatRequestSchema = z
  .object({
    threadId: z.string().uuid(),
    // Empty content is allowed ONLY when fileIds carry the message (an
    // attachment-only send) — enforced by the refine below.
    content: z.string(),
    modelId: z.string().nullable().optional(),
    // Per-turn reasoning level; the panel resolves it from its per-model map.
    // Backend clamps to "off" for models that don't support reasoning.
    reasoningLevel: reasoningLevelSchema.nullable().optional(),
    // Files staged in a kernel file_upload_session by the composer. They are
    // reparented onto the persisted user message and surfaced to the agent as
    // an attachment note so it can files_read / analyze_media them.
    fileIds: z.array(z.string().uuid()).min(1).max(10).optional(),
    currentView: z
      .object({
        tabType: z.string(),
        entityId: z.string(),
      })
      .optional(),
    // The client mints this when the user submits the turn (blueprint Task 9.2).
    // It binds any mailbox decrypt request the turn makes to a turn this browser
    // started and still has open; the browser refuses anything else.
    turnNonce: z.string().min(8).max(128).optional(),
    // Where the sender is (desktop app, browser, mobile app). Absent: unknown.
    clientSurface: clientSurfaceSchema.optional(),
  })
  .refine((v) => v.content.trim().length > 0 || (v.fileIds?.length ?? 0) > 0, {
    message: "content is required unless fileIds are provided",
    path: ["content"],
  })

type StepToolCall = { toolCallId: string; toolName: string; args: unknown } & ToolCallPresentation
type StepToolResult = { toolCallId: string; result: unknown } & ToolCardFields

export const agentRoutes = new Hono<AppEnv>()

// TRANSPORT ROUTE, NOT A SURFACE (P4c-T47, 2026-09-15). The right-rail panel
// this SSE endpoint was written for retired with P4c-T17 and the web client
// streams a turn over the websocket now. The route stays because the mailbox
// job-turn transport (apps/web/src/modules/mailbox/job-turn-transport.ts, T17)
// is still its caller. RETIRE IT with that transport; do not build a new
// conversation surface on it.
agentRoutes.post("/chat", zValidator("json", chatRequestSchema), async (c) => {
  // Past its edge grace a process shutting down starts no turn (S9 step 5).
  // Answered before anything is written, so the client's retry on a live
  // process persists the message exactly once. Within the grace the edge may
  // still route here: the turn is taken, and drains or hands off like any
  // other (refusesNewWork).
  if (refusesNewWork()) {
    c.header("Retry-After", "1")
    return c.json(
      { error: { message: "The server is restarting. Retry in a second.", code: "RESTARTING" } },
      503,
    )
  }
  const body = c.req.valid("json")
  // Taken now, before anything is awaited: from here a drain waits for this
  // turn, through its preparation (rate limit, message write, org app setup,
  // ledger row) and its run. Every exit before the stream ends it.
  const accepted = acceptTurn(`chat:${body.threadId}`)
  try {
    return await chatTurn(c, body, accepted)
  } catch (err) {
    accepted.end()
    throw err
  }
})

async function chatTurn(
  c: Context<AppEnv>,
  body: z.infer<typeof chatRequestSchema>,
  accepted: AcceptedTurn,
): Promise<Response> {
  const {
    threadId,
    content,
    modelId,
    reasoningLevel,
    currentView,
    fileIds,
    turnNonce,
    clientSurface,
  } = body
  const actor = extractRlsContext(c)
  const orgId = c.get("orgId")

  // Per-user rate limit: 10 requests per minute
  const rateLimitKey = `agent-chat:${actor.userId}`
  const rateLimitResult = await checkRateLimit(redis, rateLimitKey, AGENT_CHAT_RPM)
  if (!rateLimitResult.allowed) {
    c.header("Retry-After", String(rateLimitResult.failed.retryAfterSeconds))
    throw new HTTPException(429, {
      message: "Too many agent chat requests. Please wait before sending another message.",
    })
  }

  // Concurrent stream guard: the user's streams on every live instance count.
  const slot = await takeStreamSlot(actor.userId, MAX_CONCURRENT_STREAMS)
  if (!slot.ok) {
    throw new HTTPException(429, {
      message: "Too many concurrent agent streams. Please wait for an existing stream to complete.",
    })
  }
  // The single release, on every exit path (idempotent).
  const releaseStreamSlot = () => {
    void slot.release()
  }

  // Resolve staged attachments BEFORE the turn starts: every requested file
  // must still be parented to a kernel file_upload_session the caller can read
  // (owner-RLS), otherwise the request is rejected up-front. The filenames feed
  // an attachment note appended to the user content so the model knows the
  // files exist and can inspect them via files_read / analyze_media.
  let stagedFiles: Array<{ id: string; filename: string; sessionId: string }> = []
  if (fileIds && fileIds.length > 0) {
    const K = sql.raw(schemaRef("kernel"))
    const idList = sql.join(
      fileIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await withRequestRls(c, (tx) =>
      tx.execute<{ id: string; filename: string; session_id: string }>(
        sql`SELECT id::text AS id, filename, entity_id AS session_id FROM ${K}.files
            WHERE app = 'kernel' AND entity_type = 'file_upload_session'
              AND id::text IN (${idList})`,
      ),
    ).catch((err: unknown) => {
      releaseStreamSlot()
      throw err
    })) as unknown as Array<{ id: string; filename: string; session_id: string }>
    if (rows.length !== fileIds.length) {
      // Release: we bail before the stream ever starts.
      releaseStreamSlot()
      throw new HTTPException(403, {
        message: "Some attached files are not visible or no longer staged for upload",
      })
    }
    stagedFiles = rows.map((r) => ({ id: r.id, filename: r.filename, sessionId: r.session_id }))
  }

  const attachmentNote = attachedFilesNote(stagedFiles, { fenced: false })
  const effectiveContent = `${content}${attachmentNote}`.trim()

  // With attachments, persist the user message OURSELVES and reparent the
  // staged files onto it BEFORE the model turn starts. runAgentChat kicks off
  // the provider stream eagerly, so a post-hoc reparent races the model's tool
  // calls — files_read / analyze_media resolve the attachment through its
  // message parent under RLS and must find it there from the first step.
  // runAgentChat is then invoked with skipUserPersist + the persisted id (the
  // same seam invokeAgentForThread uses).
  let preUserMessageId: string | undefined
  if (stagedFiles.length > 0) {
    const { publishMessageAttachments, sendMessage } = await import("~/modules/threads/message")
    let msg: { id: string } | null = null
    try {
      msg = (await withPrivilegedDb(orgId, "agent-user-msg", async (tx) =>
        sendMessage(tx as unknown as RlsClient, {
          requiredScopes: [],
          orgId,
          userId: actor.userId,
          threadId,
          content: effectiveContent,
          authorType: "user",
        }),
      )) as { id: string } | null
    } catch (err) {
      releaseStreamSlot()
      throw err
    }
    if (!msg) {
      releaseStreamSlot()
      throw new HTTPException(403, { message: "Not a participant of this thread" })
    }
    const persistedMsgId = msg.id
    preUserMessageId = persistedMsgId

    const bySession = new Map<string, string[]>()
    for (const f of stagedFiles) {
      const list = bySession.get(f.sessionId) ?? []
      list.push(f.id)
      bySession.set(f.sessionId, list)
    }
    try {
      const scopes = c.get("scopes") as unknown as string[]
      await withRequestRls(c, async (rlsTx) => {
        for (const [sessionId, sessionFileIds] of bySession) {
          await moveFilesToParent(
            {
              orgId,
              userId: actor.userId,
              scopes,
              sourceSessionId: sessionId,
              target: { app: "kernel", entityType: "message", entityId: persistedMsgId },
              fileIds: sessionFileIds,
            },
            {
              rlsTx,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            },
          )
        }
      })
    } catch (err) {
      releaseStreamSlot()
      if (err instanceof FileServiceError) {
        // The message was persisted but its attachments are still staged on
        // the session — surface the failure so the client can retry the send.
        throw new HTTPException(err.code === "FORBIDDEN" ? 403 : 409, { message: err.message })
      }
      throw err
    }

    // Broadcast the now-reparented attachments — the `message:create` event was
    // queued inside the insert transaction, before the files had this message
    // as their parent, so it carries none. Without this update event the same
    // thread open elsewhere (another tab, the threads surface) renders the user
    // message bare until a reload.
    try {
      await withRequestRls(c, (rlsTx) =>
        publishMessageAttachments(rlsTx, {
          orgId,
          userId: actor.userId,
          threadId,
          messageId: persistedMsgId,
        }),
      )
    } catch (err) {
      // The attachments ARE persisted on the message; only the live broadcast
      // failed. Never fail the turn for a cosmetic refresh other clients get
      // on their next load.
      log.warn({ err, threadId }, "attachment broadcast failed")
    }
  }

  // Run orchestrator — pre-LLM failures throw HTTPException (400/402/403/500)
  let chatResult: Awaited<ReturnType<typeof runAgentChat>>
  try {
    chatResult = await runAgentChat({
      threadId,
      content: effectiveContent,
      modelId,
      reasoningLevel,
      currentView,
      ...(clientSurface ? { clientSurface } : {}),
      actor,
      orgId,
      // DETACHED FROM THE REQUEST (S10, A8): a client that goes away stops
      // reading, not the turn. It finishes, and the reply is stored whole.
      origin: "chat",
      ...(turnNonce ? { mailboxTurnNonce: turnNonce } : {}),
      ...(c.get("sessionRestricted") === true ? { sessionRestricted: true } : {}),
      ...(preUserMessageId ? { skipUserPersist: true, userMessageId: preUserMessageId } : {}),
    })
  } catch (err) {
    // Decrement concurrent stream counter on init failure
    releaseStreamSlot()

    if (err instanceof HTTPException) throw err
    // An unpaid renewal is a 402 `payment_required` the client offers
    // Billing for, never a 500 (errorHandler keeps its status and code).
    if (err instanceof PaymentRequiredError) throw err
    log.error({ err }, "Agent chat initialization failed")
    throw new HTTPException(500, { message: "Agent service error" })
  }

  const { userMessageId, fullStream, finalize } = chatResult

  // Mirror the SSE chunks as ephemeral `agent_stream` WS events keyed on the
  // thread, exactly like invokeAgentForThread does for @-mentions. The side
  // panel consumes the SSE stream directly; a THREAD view of the same thread
  // (an agent chat promoted to a thread mid-run, or a teammate with the thread
  // tab open) renders the live thinking/tool activity from these WS events.
  // Without them, a promoted chat's in-flight run is invisible in the thread.
  // The last frame's broadcast: the stream ends once it has gone out.
  let streamSent: Promise<void> = Promise.resolve()
  const emitStreamEvent = (action: string, data: Record<string, unknown> = {}) => {
    // A fenced runner's frames would interleave with the new owner's (M1).
    if (chatResult.turnFenced()) return
    // A2: same per-chunk tag as invokeAgentForThread's mirror. Read inside the
    // closure, once per chunk, because the turn's set grows as its tool calls
    // are recorded; hoisting it would freeze every chunk at the empty set the
    // turn started with and publish post-tool-call content to the whole room.
    const accumulatedScopes = chatResult.turnAccumulatedScopes()
    // Registry first: late-joining thread views (a chat promoted to a thread
    // mid-run) seed from GET /api/agent/stream-state/:threadId. It takes the
    // SAME tag as the broadcast below, because that replay is gated on the tag
    // exactly as each live chunk is; an untagged registry would hand the
    // stream-state route content the socket had correctly withheld.
    // WHICH agent is speaking, and in which reply thread, as on the
    // @-mention mirror: without the id a client keys the run on the null slot
    // and heads the live and failure blocks "Personal agent" whatever the
    // acting agent is called.
    const streamAgentId = chatResult.actingAgentId ?? null
    // The frame carries the `seq` and item the record allocated (S28); the
    // registry records one turn's events in call order, so the frames leave in
    // `seq` order. A record Redis fails is broadcast all the same, without
    // `seq` (open: only the replay loses it), and its gating is unchanged.
    streamSent = recordAgentStreamEvent(threadId, orgId, action, data, {
      requesterId: actor.userId,
      agentId: streamAgentId,
      accumulatedScopes,
    })
      .catch((err: unknown): RecordedFrame | null => {
        log.warn({ err, threadId, action }, "Could not record an agent_stream frame")
        return null
      })
      .then((frame) =>
        broadcastEphemeral({
          app: "kernel",
          entity: "agent_stream",
          action,
          entityId: threadId,
          orgId,
          actorId: actor.userId,
          actorType: "agent",
          data: {
            threadId,
            agentId: streamAgentId,
            replyRootId: chatResult.replyRootId ?? null,
            ...data,
            ...frame,
            accumulatedScopes,
          },
        }),
      )
      .catch((err) =>
        log.error({ err, threadId, action }, "Failed to broadcast agent_stream event"),
      )
  }

  // The mirror's text frames: in a thread other people read, only the answer
  // reaches their sockets, never a step's notes before its tools
  // (shared-thread-reply.ts). The asker's own SSE stream below is unchanged.
  const liveText = createLiveTextGate(chatResult.sharedThread, (delta) =>
    emitStreamEvent("delta", { delta }),
  )

  // Stream SSE response
  // Tracked until finalize, so a shutdown waits for this turn (active-turns.ts).
  // The durable turn is registered: a drain past its cap can hand it off now.
  accepted.prepared()
  return streamSSE(c, (stream) =>
    accepted.run(`chat:${threadId}:${userMessageId}`, () => runStream(stream)),
  )

  async function runStream(stream: SSEStreamingApi): Promise<void> {
    let clientConnected = !c.req.raw.signal.aborted
    c.req.raw.signal.addEventListener(
      "abort",
      () => {
        clientConnected = false
      },
      { once: true },
    )

    async function writeEvent(event: string, data: unknown): Promise<void> {
      if (!clientConnected) return
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
      } catch {
        clientConnected = false
      }
    }

    // Send an SSE comment every 15 s so the TCP connection stays alive across
    // tool-call pauses and the Bun idleTimeout window is never exceeded.
    // SSE comment format: lines starting with ': ' are ignored by EventSource clients.
    const keepAliveInterval = setInterval(() => {
      if (!clientConnected) return
      stream.write(": keep-alive\n\n").catch(() => {
        clientConnected = false
      })
    }, 15_000)

    // message-start event
    // Carries the turn id so a client whose stream stops without its end (the
    // process died: no `restart` frame) can still follow the turn (M1).
    await writeEvent("message-start", { userMessageId, threadId, turnId: chatResult.turnId })
    emitStreamEvent("start")
    // Where each step's frames end, so a resume drops a cut step's (M1).
    const markStep = (n: number) =>
      void markAgentStreamStepBoundary(threadId, chatResult.actingAgentId ?? null, null, n).catch(
        (err: unknown) => log.warn({ err, threadId }, "Could not mark a step boundary"),
      )
    markStep(0)

    let finalText = ""
    let finalReasoning = ""
    // Chronological reasoning/tool interleave (see TurnTimelineEntry) so the
    // persisted message can render each tool call at the point in the thinking
    // where it was invoked. Reasoning deltas coalesce into the trailing entry; a
    // tool call is anchored at its true position between reasoning runs.
    const finalTimeline: TurnTimelineEntry[] = []
    const finalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      // Provider-reported prompt-cache hits (subset of promptTokens on
      // google/openai/mistral) — cache-effectiveness telemetry + cached-rate
      // billing. This route loop is SEPARATE from invokeAgentForThread's; a
      // field added there must be accumulated here too or chat turns persist
      // it as zero (which is exactly what shipped the day prompt caching was
      // instrumented: prod WAS hitting the Gemini cache, the chat path just
      // dropped the count).
      cachedInputTokens: 0,
      // Cache WRITE tokens (Anthropic), priced at the write premium; null
      // until a provider reports one (absent is not a measured zero).
      cacheWriteTokens: null as number | null,
      cacheWrite5mTokens: null as number | null,
      // The USD cost the provider reported (OpenRouter), summed over the steps.
      providerCostUsd: undefined as number | null | undefined,
      // Final step's input tokens — the real context size the compaction
      // trigger reads (usage.promptTokens is the per-turn billing SUM).
      lastStepInputTokens: 0,
    }
    let finalFinishReason = "stop"
    let stepNumber = 0
    const allSteps: Array<{
      toolCalls?: StepToolCall[]
      toolResults?: StepToolResult[]
    }> = []
    let currentStepToolCalls: StepToolCall[] = []
    let currentStepToolResults: StepToolResult[] = []

    // Track whether the stream yielded an error event so we skip the success
    // done event. `finalized` guards against double-finalize; the `finally`
    // safety net finalizes any terminal path that did not already do so (mirrors
    // `invokeAgentForThread`'s finalizeOnce contract — finalize runs at least
    // once on every terminal path, including an empty-text error turn).
    let streamError: { message: string; code: string } | null = null
    let finalized = false
    // Raw provider/tool error detail captured from an in-band `error` chunk (or a
    // thrown stream) so the terminal finalize SURFACES the cause in the persisted
    // agent message (metadata.error + a user-facing content line) instead of
    // leaving a dangling user turn with no reply.
    let streamErrorDetail: string | null = null

    try {
      for await (const part of fullStream) {
        switch (part.type) {
          case "text-delta": {
            finalText += part.text
            const lastText = finalTimeline[finalTimeline.length - 1]
            if (lastText?.kind === "text") lastText.text += part.text
            else finalTimeline.push({ kind: "text", text: part.text })
            await writeEvent("text-delta", { delta: part.text })
            liveText.text(part.text)
            break
          }

          // Reasoning lifecycle. Providers differ (Anthropic streams full thinking,
          // OpenAI/Google stream a summary, some emit nothing) — we forward whatever
          // text arrives and let the thinking-block UI degrade. reasoning-delta carries
          // `.text` on the fullStream TextStreamPart, same as text-delta.
          case "reasoning-start":
            await writeEvent("reasoning-start", {})
            break

          case "reasoning-delta": {
            finalReasoning += part.text
            const lastEntry = finalTimeline[finalTimeline.length - 1]
            if (lastEntry?.kind === "reasoning") lastEntry.text += part.text
            else finalTimeline.push({ kind: "reasoning", text: part.text })
            await writeEvent("reasoning-delta", { delta: part.text })
            emitStreamEvent("reasoning", { delta: part.text })
            break
          }

          case "reasoning-end":
            await writeEvent("reasoning-end", {})
            break

          case "tool-call": {
            // Invariant K: redacted once, for the row, the SSE body and the frames
            // alike, as the thread path does (agent-service.ts). The model is
            // unaffected: the SDK keeps its own copy of the call for this turn.
            const call = {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: await redactMailToolArgs(orgId, part.toolName, part.input),
              ...toolCallPresentation(orgId, part.toolName),
            }
            currentStepToolCalls.push(call)
            finalTimeline.push({ kind: "tool", toolCallId: part.toolCallId })
            liveText.toolCall()
            await writeEvent("tool-call", call)
            emitStreamEvent("tool_call", {
              ...call,
              ...uiEffectRequester(part.toolName, actor.userId),
            })
            break
          }

          case "tool-result": {
            // The name from the call when the chunk has none: an unnamed result
            // would skip the mail branch and pass through whole.
            const toolName =
              (part as { toolName?: string }).toolName ??
              currentStepToolCalls.find((tc) => tc.toolCallId === part.toolCallId)?.toolName ??
              ""
            const result = await redactMailToolResult(orgId, toolName, part.output)
            const entry = {
              toolCallId: part.toolCallId,
              result,
              ...(await toolCardFieldsForResult(orgId, toolName, result, part.output)),
            }
            currentStepToolResults.push(entry)
            await writeEvent("tool-result", entry)
            emitStreamEvent("tool_result", entry)
            break
          }

          case "finish-step": {
            stepNumber++
            markStep(stepNumber)
            allSteps.push({
              toolCalls: currentStepToolCalls.length > 0 ? [...currentStepToolCalls] : undefined,
              toolResults:
                currentStepToolResults.length > 0 ? [...currentStepToolResults] : undefined,
            })
            currentStepToolCalls = []
            currentStepToolResults = []
            liveText.stepFinished()

            // Accumulate usage from each step.
            const stepUsage = readStepUsage(part.usage)
            const stepPrompt = stepUsage.inputTokens ?? 0
            const stepCompletion = stepUsage.outputTokens ?? 0
            finalUsage.promptTokens += stepPrompt
            finalUsage.completionTokens += stepCompletion
            finalUsage.reasoningTokens += stepUsage.reasoningTokens
            finalUsage.cachedInputTokens += stepUsage.cacheReadTokens
            if (stepUsage.cacheWriteTokens !== undefined) {
              finalUsage.cacheWriteTokens =
                (finalUsage.cacheWriteTokens ?? 0) + stepUsage.cacheWriteTokens
            }
            if (stepUsage.cacheWrite5mTokens !== undefined) {
              finalUsage.cacheWrite5mTokens =
                (finalUsage.cacheWrite5mTokens ?? 0) + stepUsage.cacheWrite5mTokens
            }
            finalUsage.providerCostUsd = addProviderCostUsd(
              finalUsage.providerCostUsd,
              (part as { providerMetadata?: unknown }).providerMetadata,
            )
            // A re-issued step bills both calls; its context is the answering request's.
            const stepContext =
              stepContextInputTokens(
                stepPrompt,
                (part as { providerMetadata?: unknown }).providerMetadata,
              ) ?? 0
            if (stepContext > 0) finalUsage.lastStepInputTokens = stepContext
            if (part.finishReason) finalFinishReason = part.finishReason

            await writeEvent("step-finish", {
              stepNumber,
              usage: {
                promptTokens: stepPrompt,
                completionTokens: stepCompletion,
              },
            })
            break
          }

          case "finish":
            // In AI SDK v6, fullStream may not emit finish with usage; usage is accumulated from finish-step above
            if (part.finishReason) finalFinishReason = part.finishReason
            break

          case "error": {
            const errObj = part.error
            const errMsg =
              errObj instanceof Error
                ? errObj.message
                : typeof errObj === "object" && errObj !== null && "message" in errObj
                  ? String((errObj as any).message)
                  : JSON.stringify(errObj)
            const code = errMsg.includes("credits_exhausted")
              ? "credits_exhausted"
              : errMsg.includes("timeout")
                ? "timeout"
                : "provider_error"
            // Capture the raw cause for the terminal finalize so the errored turn
            // is persisted (with the detail in metadata.error) instead of leaving
            // a dangling user message — mirrors invokeAgentForThread.streamErrorDetail.
            streamErrorDetail = errMsg
            // A visitor turn the demo spend gate stopped says why in demo
            // words (its budget, the step limit), never "purchase credits".
            const demoStop =
              code === "credits_exhausted" ? ((await chatResult.demoRefusal?.()) ?? null) : null
            // Persist partial text on credit exhaustion before reporting error.
            if (code === "credits_exhausted" && finalText) {
              finalized = true
              try {
                await finalize({
                  usage: finalUsage,
                  finishReason: "credits_exhausted",
                  text: demoStop
                    ? `${finalText}\n\n---\n*${demoStop.text}*`
                    : finalText +
                      "\n\n---\n*Credits depleted mid-conversation. Purchase more credits to continue.*",
                  reasoning: finalReasoning,
                  timeline: finalTimeline,
                  steps: allSteps,
                })
              } catch (finalizeErr) {
                log.error(
                  { err: finalizeErr },
                  "Failed to persist partial text on credit exhaustion",
                )
              }
            }
            // For every other in-band error (incl. an empty-text provider error /
            // timeout before any output), do NOT finalize here — the `finally`
            // safety net finalizes once with finishReason "error" + errorDetail, so
            // finalize() renders userFacingAgentError() as the message content and
            // clears runAgentChat's internal timeout. Setting `streamError` only
            // suppresses the success `done` event.
            streamError = { message: errMsg, code: demoStop?.code ?? code }
            // The client only sees the sanitized line below, so the raw provider error must
            // reach the log here or it is lost (a bad key read as an opaque provider_error).
            log.error(
              { threadId, code, inbandError: serializeStreamError(errObj) },
              "Agent chat stream in-band error",
            )
            // Sanitize before the client sees it — no raw upstream text/secrets.
            const shown = demoStop
              ? { message: demoStop.text, code: demoStop.code }
              : { message: userFacingAgentError(errMsg), code }
            await writeEvent("error", shown)
            liveText.flush()
            emitStreamEvent("error", shown)
            break
          }
        }

        // Exit the stream loop immediately after an error event
        if (streamError) break
      }

      // Only persist and emit done when the stream completed without error
      if (!streamError) {
        finalized = true
        liveText.flush()
        const result = await finalize({
          usage: finalUsage,
          finishReason: finalFinishReason,
          text: finalText,
          reasoning: finalReasoning,
          timeline: finalTimeline,
          steps: allSteps,
        })

        if (
          result.finishReason === HANDOFF_FINISH_REASON ||
          result.finishReason === FENCED_REASON
        ) {
          // The turn goes on elsewhere (a resume on another process): the
          // client re-attaches to it (GET /api/agent/turns/:turnId/events).
          await writeEvent("restart", { turnId: chatResult.turnId, threadId })
          return
        }
        await writeEvent("done", {
          messageId: result.messageId,
          totalUsage: finalUsage,
          creditCost: result.creditCost,
          finishReason: result.finishReason,
        })
        emitStreamEvent("done", { finishReason: result.finishReason })

        // Auto-generate title for untitled agent chats (fire-and-forget)
        // The agent is handed over EXPLICITLY: this call is fire-and-forget
        // after the turn, outside every run frame, so the identity has to
        // travel as an argument or the title's audit row is anonymous (A11).
        autoTitleAgentChat({
          threadId,
          userMessage: content,
          agentReply: finalText,
          orgId,
          agentId: chatResult.actingAgentId,
        }).catch((err) => log.error({ err, orgId, threadId }, "Auto-title failed"))
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Internal error"
      const code = errMsg.includes("credits_exhausted") ? "credits_exhausted" : "internal_error"
      log.error({ err }, "Error during agent stream")
      // Capture for the terminal finalize and mark this an errored turn so the
      // `finally` safety net persists a finalized agent message (not a dangling
      // user turn). Sanitize before the client sees it.
      streamErrorDetail = streamErrorDetail ?? errMsg
      streamError = streamError ?? { message: errMsg, code }
      await writeEvent("error", { message: userFacingAgentError(errMsg), code })
      liveText.flush()
      emitStreamEvent("error", { message: userFacingAgentError(errMsg), code })
    } finally {
      clearInterval(keepAliveInterval)
      // Safety net: if no branch above finalized this turn, finalize exactly once
      // here so EVERY terminal path records a finalized agent message and clears
      // runAgentChat's internal timeout (finalize() owns the clearTimeout). This
      // mirrors invokeAgentForThread's finalizeOnce contract.
      //
      //  - An errored turn (in-band `error` chunk or a thrown stream) before any
      //    text was previously left as a dangling user message with no reply and a
      //    leaked timer. Now finalize() runs with finishReason "error" + the raw
      //    detail, so it renders userFacingAgentError() as the message content and
      //    persists metadata.error.
      //  - A non-error interruption (e.g. client disconnect mid-stream) persists
      //    whatever partial text accumulated, exactly as before.
      const erroredTurn = streamError !== null
      // An errored turn ALWAYS finalizes (even with empty text) so the failure is
      // recorded as a finalized agent message instead of a dangling user turn.
      // A turn that ended with neither a finish nor an error was stopped by its
      // record (a drain handoff, a fence): finalize hands it off or writes
      // nothing. A client that went away is never the reason: the turn runs on
      // to its finish, and partial text is never stored as a "stop" (S10, A8).
      if (!finalized && (erroredTurn || chatResult.turnFenced() || chatResult.turnHandoff())) {
        liveText.flush()
        try {
          const ended = await finalize({
            usage: finalUsage,
            finishReason: erroredTurn ? "error" : "stop",
            text: finalText,
            reasoning: finalReasoning,
            timeline: finalTimeline,
            errorDetail: erroredTurn ? (streamErrorDetail ?? undefined) : undefined,
            steps: allSteps,
          })
          if (ended.finishReason === HANDOFF_FINISH_REASON) {
            await writeEvent("restart", { turnId: chatResult.turnId, threadId })
          }
        } catch (finalizeErr) {
          log.error({ err: finalizeErr }, "Failed to finalize after stream interruption")
        }
        finalized = true
      } else if (!finalized) {
        // Nothing persisted (client disconnected before any output) — reset any
        // live thread view and drop the registry snapshot. A visitor turn's
        // spend is closed all the same: a request already sent is billed.
        emitStreamEvent("clear")
        await chatResult.abandon?.().catch((err) => log.warn({ err }, "Failed to close the turn"))
      }
      await streamSent
      // Broadcast typing:stop on all paths (success, stream error, exception)
      broadcastEphemeral({
        app: "kernel",
        entity: "typing",
        action: "stop",
        entityId: threadId,
        orgId,
        actorId: actor.userId,
        actorType: "agent",
        // H6: the agent that was typing, not just the human it acted for.
        data: {
          authorType: "agent",
          userId: actor.userId,
          agentId: chatResult.actingAgentId ?? null,
          ...(chatResult.replyRootId ? { replyRootId: chatResult.replyRootId } : {}),
        },
      }).catch((err) => log.error({ err }, "Failed to broadcast typing:stop"))

      // Release the concurrent stream slot
      releaseStreamSlot()
    }
  }
}

// Snapshot of the IN-FLIGHT run for a thread, so a view that opens mid-run
// (an agent chat promoted to a thread, a teammate opening the thread tab, a
// fresh page load) can seed the live block — accumulated thinking, tool calls
// and text so far, plus the "working" state — and then follow the ongoing
// `agent_stream` WS deltas. Returns { active: false } when nothing is running.
//
// Visibility is TWO gates, not one. The thread's own RLS read decides who is in
// the room; the room is not the audience. This is a REPLAY of the very chunks
// the socket fanned out, so it is gated on the turn's accumulated scopes the
// same way `hasStreamChunkAccess` gates each chunk: same predicate
// (isMessageVisible), same requester exemption, same fail-closed default.
// Without the second gate a room member lacking the scope could fetch here
// exactly the in-flight content the socket had correctly withheld.
agentRoutes.get("/stream-state/:threadId", async (c) => {
  const threadId = c.req.param("threadId")
  const orgId = c.get("orgId")
  const viewerId = c.get("userId")
  // EVERY live run in the room, not one. Two agents mentioned in one breath
  // both take a turn (A29/A30), and a view that opened mid-run used to seed
  // whichever of them the thread key happened to hold.
  // A registry Redis does not answer serves no run (closed): the view seeds
  // nothing and follows the live frames.
  let snapshots: LiveAgentStreamSnapshot[]
  try {
    snapshots = (await listLiveAgentStreams(threadId)).filter((s) => s.orgId === orgId)
  } catch (err) {
    log.warn({ err, threadId }, "Could not read the live turn registry for stream-state")
    return c.json({ data: { active: false } })
  }
  const snapshot = snapshots[snapshots.length - 1]
  if (!snapshot) {
    return c.json({ data: { active: false } })
  }
  const thread = await withRequestRls(c, async (tx) => {
    return getThread(tx, { orgId, userId: viewerId, threadId })
  })
  if (!thread) throw new HTTPException(404, { message: "Thread not found" })

  // The two gates, PER RUN. The requester of a turn always sees their own: it
  // runs under their own floored effective scope, so it can only read what they
  // can read. The exemption is that stream's alone and, as in T24, does not
  // extend to the persisted message. For anyone else the turn's accumulated
  // scopes decide, failing closed on an unknown set: `[]` is never assumed,
  // because it would assert the turn read nothing scoped. A reader allowed to
  // seed one agent's turn is not thereby allowed the other's.
  const servable = snapshots.filter((snap) => {
    if (snap.requesterId !== "" && snap.requesterId === viewerId) return true
    const accumulated = snap.accumulatedScopes
    return (
      accumulated !== null &&
      isMessageVisible(
        // A stream carries no disclosure list: disclosure is a property of a
        // persisted message, and inventing one here could only widen.
        { requiredScopes: accumulated, disclosureList: null },
        { userId: viewerId, grants: c.get("scopes") as unknown as string[] },
      )
    )
  })
  // Indistinguishable from "no run in flight": the existence of a scoped turn
  // is itself withheld, and the client simply seeds nothing.
  if (servable.length === 0) return c.json({ data: { active: false } })
  const asPayload = (snap: (typeof snapshots)[number]) => ({
    agentId: snap.agentId,
    turnId: snap.turnId,
    // The person's message the turn answers; differs from turnId on the turn
    // an approved call handed back.
    askId: snap.askId,
    state: snap.state,
    content: snap.content,
    reasoning: snap.reasoning,
    reasoningStreaming: snap.reasoningStreaming,
    toolCalls: snap.toolCalls,
    timeline: snap.timeline,
    startedAt: snap.startedAt,
    // The last frame folded in (S28): the client drops a live frame at or below it.
    seq: snap.seq,
  })
  const newest = servable[servable.length - 1] as (typeof snapshots)[number]
  return c.json({
    data: {
      active: true,
      // The newest run, flat, exactly as this route has always answered.
      ...asPayload(newest),
      // Every run the reader may seed, newest last.
      streams: servable.map(asPayload),
    },
  })
})

// ── Re-attach to a turn that moved (S10, M10) ──────────────────────────────
//
// A turn handed off by a draining process, or resumed after its process died,
// runs on another process; the `/chat` stream that started it ended with a
// `restart` frame naming the turn. This follows it there: `text-delta` frames
// as the live entry grows, `rewind` (the whole text so far) when a resume
// dropped a cut step's text, then `done` with the stored reply or `error`.
// The gates are /chat's: the person the turn answers, in a thread they can
// read. Anyone else gets the same 404 as a turn that does not exist. Exempt
// from the global request timeout (app.ts), like /chat; bounded by its own
// lifetime instead. Every stream ends with a terminal frame the client can act
// on: `done`, `error` (also `reattach_timeout` at the deadline) or `restart`
// when this process starts draining, so the client follows the turn elsewhere.
// The poll backs off from `pollMs` to `maxPollMs` while nothing changes (L2).
// Mutable for tests only.
export const reattachTiming = { pollMs: 500, maxPollMs: 2_000, maxMs: 30 * 60_000 }

agentRoutes.get("/turns/:turnId/events", async (c) => {
  const turnId = c.req.param("turnId")
  if (!z.string().uuid().safeParse(turnId).success) {
    throw new HTTPException(404, { message: "Turn not found" })
  }
  const orgId = c.get("orgId")
  const viewerId = c.get("userId")
  const first = await turnStatus(orgId, turnId)
  if (!first || first.requesterId === null || first.requesterId !== viewerId) {
    throw new HTTPException(404, { message: "Turn not found" })
  }
  const thread = await withRequestRls(c, (tx) =>
    getThread(tx, { orgId, userId: viewerId, threadId: first.threadId }),
  )
  if (!thread) throw new HTTPException(404, { message: "Turn not found" })
  const threadId = first.threadId

  return streamSSE(c, async (stream) => {
    const signal = c.req.raw.signal
    let open = !signal.aborted
    signal.addEventListener("abort", () => (open = false), { once: true })
    const write = async (event: string, data: unknown) => {
      if (!open) return
      await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => (open = false))
    }
    let sent = ""
    let lastKeepAlive = Date.now()
    const deadline = Date.now() + reattachTiming.maxMs
    let pollMs = reattachTiming.pollMs
    let lastState: string | null = null
    await write("attached", { turnId, threadId })
    while (open) {
      if (Date.now() >= deadline) {
        await write("error", { message: "The answer took too long.", code: "reattach_timeout" })
        return
      }
      if (refusesNewWork()) {
        // This process is past its edge grace: the client re-attaches to another one.
        await write("restart", { turnId, threadId })
        return
      }
      const status = await turnStatus(orgId, turnId).catch(() => null)
      if (!status) {
        await write("error", { message: "The turn is gone.", code: "turn_gone" })
        return
      }
      const live = await listLiveAgentStreams(threadId).catch(() => [])
      const snap = live.find(
        (s) =>
          s.orgId === orgId &&
          (s.agentId ?? null) === status.liveAgentId &&
          (s.turnId ?? null) === status.liveTurnKey,
      )
      const changed = status.state !== lastState || (snap !== undefined && snap.content !== sent)
      lastState = status.state
      if (snap) {
        if (snap.content.startsWith(sent)) {
          if (snap.content.length > sent.length) {
            await write("text-delta", { delta: snap.content.slice(sent.length) })
          }
        } else {
          await write("rewind", { text: snap.content })
        }
        sent = snap.content
      }
      if (status.state === "done") {
        const replyId = status.agentMessageId
        const reply = replyId
          ? await withRequestRls(c, (tx) =>
              tx
                .select({
                  content: messages.content,
                  requiredScopes: messages.requiredScopes,
                  disclosureList: messages.disclosureList,
                })
                .from(messages)
                .where(eq(messages.id, replyId))
                .limit(1),
            )
          : []
        const row = reply[0]
        // The requester exemption covers the live stream, never the persisted
        // reply: it is served only when the viewer may read it (L1). A stored
        // reply RLS withholds is as hidden as one the check refuses.
        const grants: unknown = c.get("scopes")
        const viewerGrants = Array.isArray(grants)
          ? grants.filter((g): g is string => typeof g === "string")
          : []
        if (
          (replyId && !row) ||
          (row &&
            !isMessageVisible(
              { requiredScopes: row.requiredScopes, disclosureList: row.disclosureList },
              { userId: viewerId, grants: viewerGrants },
            ))
        ) {
          await write("error", {
            message: "The answer is not visible to you.",
            code: "reply_hidden",
          })
          return
        }
        await write("done", { messageId: replyId, text: row?.content ?? sent })
        return
      }
      if (status.state === "failed" || status.state === "interrupted") {
        await write("error", {
          message: "The answer could not be finished.",
          code: status.errorCode ?? status.state,
        })
        return
      }
      if (Date.now() - lastKeepAlive >= 15_000) {
        lastKeepAlive = Date.now()
        await stream.write(": keep-alive\n\n").catch(() => (open = false))
      }
      pollMs = changed ? reattachTiming.pollMs : Math.min(pollMs * 2, reattachTiming.maxPollMs)
      await stream.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    }
  })
})

// ── The client's half of the two-phase mailbox read protocol ────────────────
//
// Blueprint Task 9.3, spec sections 6.2 and 15 A5. The REQUEST goes out over the
// existing ephemeral `agent_stream` broadcast and carries ids only; the RESPONSE
// comes back here, over authenticated HTTP, because the inbound socket handler
// accepts four message types, closes on frames over 16 KiB and rate-limits to
// 120 frames a minute, and a decrypted mail body routinely exceeds 16 KiB.
//
// Side benefit, and the reason not to "fix" the socket instead: nothing carrying
// plaintext ever enters Redis or the replay buffer. Nothing about a pending
// request is written to Redis, to the outbox or to the database either. The
// resolver is a promise in this process, and that is the whole mechanism.

/**
 * How an answer proves it belongs to its request: the turn's nonce (the window
 * that started the turn), or the request's answer token, which every one of the
 * user's own connections received with it (mailbox-plaintext-registry.ts).
 */
const mailboxAnswerProof = {
  turnNonce: z.string().min(1).max(128).optional(),
  answerToken: z.string().min(1).max(128).optional(),
}
const hasAnswerProof = (body: { turnNonce?: string; answerToken?: string }) =>
  body.turnNonce !== undefined || body.answerToken !== undefined

const mailboxPlaintextSchema = z
  .object({
    ...mailboxAnswerProof,
    items: z
      .array(
        z.object({
          messageId: z.string().min(1).max(200),
          subject: z.string().nullable().optional(),
          textBody: z.string().nullable().optional(),
          htmlBody: z.string().nullable().optional(),
          quotedBody: z.string().nullable().optional(),
          resolvedSubject: z.string().nullable().optional(),
          bytesBase64: z.string().nullable().optional(),
        }),
      )
      .max(25)
      // Absent on a refusal, which carries `denied` and nothing else.
      .optional(),
    undecryptable: z.array(z.string().max(200)).max(200).optional(),
    /** A client refusal is a real, named condition, not a silent non-answer. */
    denied: z
      .object({ reason: z.string().max(500), code: z.enum(["locked"]).optional() })
      .optional(),
    /**
     * The answering client started this turn (it answers with the turn's nonce).
     * A deliberate refusal from it settles the request at once; a locked or
     * empty answer waits for the user's other unlocked apps
     * (mailbox-plaintext-registry.ts).
     */
    turnOwner: z.boolean().optional(),
    /**
     * `mail.convert` only (blueprint Task 9.7). The mailbox owner confirmed, in
     * their own browser, that this content may become readable by everyone with
     * access to the target inbox. Absent means NOT confirmed, and the handler
     * creates no ticket: a missing confirmation is never a default yes.
     */
    consented: z.boolean().optional(),
  })
  .refine(hasAnswerProof, { message: "turnNonce or answerToken is required" })

const mailboxSearchSchema = z
  .object({
    ...mailboxAnswerProof,
    messageIds: z.array(z.string().max(200)).max(500),
    indexComplete: z.boolean().optional(),
    turnOwner: z.boolean().optional(),
  })
  .refine(hasAnswerProof, { message: "turnNonce or answerToken is required" })

/** The proof fields of an answer body, as the registry reads them. */
function answerProofOf(body: {
  turnNonce?: string
  answerToken?: string
  turnOwner?: boolean
}): Pick<MailboxAnswerInput, "turnNonce" | "answerToken" | "turnOwner"> {
  return {
    ...(body.turnNonce !== undefined ? { turnNonce: body.turnNonce } : {}),
    ...(body.answerToken !== undefined ? { answerToken: body.answerToken } : {}),
    ...(body.turnOwner === true ? { turnOwner: true } : {}),
  }
}

/** Shared refusal handling: one place decides what each outcome costs. */
async function mailboxResponseResult(
  c: { json: (body: unknown, status?: never) => Response },
  requestId: string,
  answer: MailboxAnswerInput,
): Promise<Response> {
  // A request minted by another process is forwarded to it over its signed
  // internal listener (mailbox-forward.ts, never through Redis), and the owner
  // re-runs the user, org, nonce and token checks. A dead owner (or this
  // process before a restart) names a resolver that no longer exists: say so,
  // so the client retries rather than believing it answered.
  const outcome = ownsMailboxRequestId(requestId)
    ? resolveMailboxRequest(requestId, answer)
    : await forwardMailboxAnswer(requestId, answer)
  if (outcome === "wrong_instance") {
    throw new HTTPException(409, { message: "WRONG_INSTANCE" })
  }
  if (outcome === "nonce_mismatch") {
    throw new HTTPException(403, { message: "TURN_NONCE_MISMATCH" })
  }
  if (outcome === "not_found") {
    throw new HTTPException(404, { message: "NO_SUCH_REQUEST" })
  }
  // With several clients open, every one but the first useful answer is late.
  // That is the protocol working, not an error: say so without a 4xx.
  if (outcome === "already_settled") {
    return c.json({ data: { accepted: false, alreadyAnswered: true } })
  }
  return c.json({ data: { accepted: true } })
}

agentRoutes.post(
  "/mailbox-plaintext/:requestId",
  zValidator("json", mailboxPlaintextSchema),
  async (c) => {
    const requestId = c.req.param("requestId")
    const body = c.req.valid("json")
    const response: MailboxRequestResponse = body.denied
      ? {
          kind: "denied",
          reason: body.denied.reason,
          ...(body.denied.code ? { code: body.denied.code } : {}),
        }
      : {
          kind: "plaintext",
          items: body.items ?? [],
          undecryptable: body.undecryptable ?? [],
          ...(body.consented !== undefined ? { consented: body.consented } : {}),
        }
    return await mailboxResponseResult(c, requestId, {
      userId: c.get("userId"),
      orgId: c.get("orgId"),
      ...answerProofOf(body),
      response,
    })
  },
)

agentRoutes.post(
  "/mailbox-search/:requestId",
  zValidator("json", mailboxSearchSchema),
  async (c) => {
    const requestId = c.req.param("requestId")
    const body = c.req.valid("json")
    return await mailboxResponseResult(c, requestId, {
      userId: c.get("userId"),
      orgId: c.get("orgId"),
      ...answerProofOf(body),
      response: {
        kind: "search",
        messageIds: body.messageIds,
        indexComplete: body.indexComplete,
      },
    })
  },
)

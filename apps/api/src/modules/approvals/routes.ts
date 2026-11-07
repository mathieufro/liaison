// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { getApproval, listApprovals } from "~/modules/approvals/list"
import {
  type MailboxFulfilment,
  MailboxFulfilmentError,
  parseMailboxFulfilment,
} from "~/modules/approvals/mailbox-fulfilment"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"

const decideBodySchema = z.discriminatedUnion("decision", [
  // `mailboxFulfilment` (blueprint Task 9.8 and 9.9): the mailbox owner's
  // browser sends the plaintext a gated send from an encrypted personal mailbox
  // needs in order to execute. Typed as `unknown` here on purpose: the shape is
  // validated by `parseMailboxFulfilment`, which REFUSES an unknown field rather
  // than stripping it, so a client whose fulfilment would not take effect learns
  // that instead of the send going out with a blank body.
  z.object({
    decision: z.literal("approve"),
    mailboxFulfilment: z.unknown().optional(),
    // Fingerprint of the payload the decider reviewed (`payloadHash` on the approval): required, so
    // an edit made after the card was shown cannot be approved unseen (decide.ts).
    payloadHash: z.string().min(1).max(128).optional(),
    // For a bundle: the fingerprint of every later step the decider was shown, by step id.
    stepPayloadHashes: z.record(z.string().uuid(), z.string().min(1).max(128)).optional(),
    // "Send now" on a mail draft held by an automatic reply (decide.ts, 422 when not held).
    sendGuardOverride: z.literal("auto_reply").optional(),
  }),
  z.object({ decision: z.literal("deny"), reason: z.string().optional() }),
])

const idParam = z.object({ id: z.string().uuid() })

const payloadBody = z.object({ fields: z.record(z.string(), z.unknown()) })

// Four mutually-exclusive modes: the decidable-feed (status+decidableByMe),
// the bundle-members fetch (bundleId), the per-thread fetch (threadId), and
// the per-ticket fetch (ticketId). The threadId mode serves threads that
// host MANY approvals over their life (an MCP connection's single approval
// thread) where created_from points at the connection, not one
// approval_request. The ticketId mode serves a ticket whose gated
// tickets:reply/nudge/close was raised by a ROUTINE — the approval_request
// lives on the routine's output thread, not the ticket's internalThreadId,
// so threadId alone misses it; matched via `tool_params.ticketId` instead.
// The conversationId mode is the mail twin of ticketId: gated
// mail:reply/forward drafts matched via `tool_params.conversationId`.
// A union keeps the modes from colliding.
const listQuerySchema = z.union([
  z
    .object({
      status: z.literal("pending"),
      decidableByMe: z.union([z.literal("true"), z.literal(true)]).transform(() => true),
      // Scope the feed to ONE app's gated tools, so a surface (the shipping grid) shows and
      // decides only its own approvals and a bulk decision there can never reach another app's.
      app: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
        .optional(),
    })
    .strict(),
  // Home's "Waiting on others" (D21): the caller's OWN pending requests,
  // whoever decides them. Exclusive with decidableByMe (strict branches).
  z
    .object({
      status: z.literal("pending"),
      requestedByMe: z.union([z.literal("true"), z.literal(true)]).transform(() => true),
    })
    .strict(),
  z.object({ bundleId: z.string().uuid() }).strict(),
  z.object({ threadId: z.string().uuid() }).strict(),
  z.object({ ticketId: z.string().uuid() }).strict(),
  z.object({ conversationId: z.string().uuid() }).strict(),
])

export const approvals = new Hono<AppEnv>()

approvals.get("/", zValidator("query", listQuerySchema), async (c) => {
  const query = c.req.valid("query")
  const actor = extractRlsContext(c)
  const data = await withRequestRls(c, (tx) =>
    listApprovals(tx, {
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
      ...("bundleId" in query ? { bundleId: query.bundleId } : {}),
      ...("threadId" in query ? { threadId: query.threadId } : {}),
      ...("ticketId" in query ? { ticketId: query.ticketId } : {}),
      ...("conversationId" in query ? { conversationId: query.conversationId } : {}),
      ...("requestedByMe" in query ? { requestedByMe: true } : {}),
      ...("app" in query && query.app ? { app: query.app } : {}),
      sendGuards: true,
    }),
  )
  return success(c, data)
})

approvals.get("/:id", zValidator("param", idParam), async (c) => {
  const { id } = c.req.valid("param")
  const actor = extractRlsContext(c)
  const data = await withRequestRls(c, (tx) =>
    getApproval(tx, { orgId: actor.orgId, userId: actor.userId, requestId: id, sendGuards: true }),
  )
  if (!data) throw new HTTPException(404, { message: "Not found" })
  return success(c, data)
})

// The decided result of a gated tool — the executed handler's output (e.g. a
// created draftOrder {id}). The `/decide` response carries only approval
// metadata; this lets a non-agent HTTP caller observe what a gated tool produced
// (and chain on it). Access-controlled the same way as the detail route
// (`getApproval` is RLS/user-scoped → 404 if the caller can't see it); `result`
// is null unless the approval is approved AND the execution succeeded.
approvals.get("/:id/result", zValidator("param", idParam), async (c) => {
  const { id } = c.req.valid("param")
  const actor = extractRlsContext(c)
  const data = await withRequestRls(c, (tx) =>
    getApproval(tx, { orgId: actor.orgId, userId: actor.userId, requestId: id }),
  )
  if (!data) throw new HTTPException(404, { message: "Not found" })
  const result = data.status === "approved" ? await readDecidedResult(actor.orgId, id) : null
  return success(c, { status: data.status, result })
})

approvals.post(
  "/:id/decide",
  zValidator("param", idParam),
  zValidator("json", decideBodySchema),
  async (c) => {
    // A decision is authorized on the decider's STORED grants (decide.ts), and
    // the resource-owner branch needs no scope at all: a restricted
    // (device-flow) session would act beyond its ceiling. Same rule as every
    // credential mint (auth/session-ceiling.ts): refused.
    assertUnrestrictedSession(c, "decide an approval")
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")
    const actor = extractRlsContext(c)
    let mailboxFulfilment: MailboxFulfilment | undefined
    if (body.decision === "approve" && !body.payloadHash) {
      // A person approves what they were shown: the request must say which version that was.
      throw new HTTPException(400, {
        message:
          "payload_hash_required: approve needs payloadHash (from the approval you reviewed)",
      })
    }
    if (body.decision === "approve") {
      try {
        mailboxFulfilment = parseMailboxFulfilment(body.mailboxFulfilment)
      } catch (err) {
        if (err instanceof MailboxFulfilmentError) {
          throw new HTTPException(400, { message: err.message })
        }
        throw err
      }
    }
    const result = await decideApproval({
      orgId: actor.orgId,
      requestId: id,
      actor,
      decision: body.decision,
      reason: body.decision === "deny" ? body.reason : undefined,
      ...(mailboxFulfilment ? { mailboxFulfilment } : {}),
      ...(body.decision === "approve" && body.payloadHash ? { payloadHash: body.payloadHash } : {}),
      ...(body.decision === "approve" && body.stepPayloadHashes
        ? { stepPayloadHashes: body.stepPayloadHashes }
        : {}),
      ...(body.decision === "approve" && body.sendGuardOverride
        ? { sendGuardOverride: body.sendGuardOverride }
        : {}),
    })
    return success(c, result)
  },
)

approvals.post(
  "/:id/payload",
  zValidator("param", idParam),
  zValidator("json", payloadBody),
  async (c) => {
    // Editing a pending payload is authorized on stored grants too (edit.ts).
    assertUnrestrictedSession(c, "edit an approval")
    const { id } = c.req.valid("param")
    const { fields } = c.req.valid("json")
    const actor = extractRlsContext(c)
    // A11: a PERSON is editing through the HTTP surface, so the acting agent is
    // positively none. Without this the edit inherits whatever turn is live.
    const result = await updatePayload({
      orgId: actor.orgId,
      requestId: id,
      fields,
      actor,
      actingAgentId: null,
    })
    return success(c, result)
  },
)

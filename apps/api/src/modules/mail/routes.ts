// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { searchMailConversations } from "~/apps/mail/search"
import { fetchWithRedirectValidation, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { withRequestRls } from "~/lib/request-rls"
import { paginated, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import { requireScope } from "~/middleware/require-scope"
import { type MailCategory, parseMailCategory } from "~/modules/mail/category"
import { enqueueGmailWriteBack } from "~/modules/mail/gmail-write-back"
import * as providerSettings from "~/modules/mail/provider-settings"
import { checkPersonCompose, recipientFacts, recipientsOf } from "~/modules/mail/send-guard"
import * as mailService from "~/modules/mail/service"
import { withAway } from "~/modules/users/away-today"

/** Recipients per field (to, cc, bcc) of one draft: far above any real send. */
const MAX_RECIPIENTS = 500

const draftAddress = z.object({ name: z.string().optional(), email: z.string().email() })

// A reply draft is created with the recipients and subject its send will use,
// so a draft that got an attachment before any text still reads as that reply
// in Drafts instead of "(No recipients) / (No subject)".
const createDraftBody = z.object({
  accountId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  replyToMessageId: z.string().uuid().optional(),
  to: z.array(draftAddress).max(MAX_RECIPIENTS).optional(),
  cc: z.array(draftAddress).max(MAX_RECIPIENTS).optional(),
  subject: z.string().optional(),
})

// A draft on an end-to-end encrypted mailbox arrives ALREADY SEALED: the
// browser seals before the request leaves it, so an unsent draft is never
// plaintext at rest. The plaintext fields stay on the schema because non-ready
// mailboxes still use them; `updateDraft` refuses a non-empty plaintext field
// for a `ready` account with MAILBOX_PLAINTEXT_DRAFT_REFUSED.
const updateDraftBody = z.object({
  to: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  cc: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  bcc: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  subject: z.string().optional(),
  htmlBody: z.string().optional(),
  textBody: z.string().optional(),
  bodyCiphertext: z.string().base64().optional(),
  subjectCiphertext: z.string().base64().optional(),
  contentKeyWrapped: z.string().base64().optional(),
  contentKeyEpk: z.string().base64().optional(),
  encKeyId: z.number().int().min(0).max(255).optional(),
})

export const sendDraftBody = z.object({
  to: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  cc: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  bcc: z
    .array(z.object({ name: z.string().optional(), email: z.string().email() }))
    .max(MAX_RECIPIENTS)
    .optional(),
  subject: z.string().optional(),
  htmlBody: z.string(),
  textBody: z.string(),
  // Send again a draft whose earlier send may already have been delivered
  // (it answered 409 mail_send_outcome_unknown): the person said so.
  confirmResend: z.boolean().optional(),
})

const CONVERSATION_STATUSES = ["open", "archived", "trashed", "escalated"] as const

const updateConversationBody = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
})

const imagePreferenceBody = z.object({
  senderDomain: z.string().trim().min(1),
})

const updateProviderBody = z.object({
  enabled: z.boolean(),
})

export const mailRoutes = new Hono<AppEnv>()

mailRoutes.get("/providers", requireScope("mail:accounts:read"), async (c) => {
  const result = await providerSettings.listMailProviders(c.get("orgId"))
  return success(c, result)
})

mailRoutes.patch(
  "/providers/:providerId",
  requireScope("mail:accounts:admin"),
  zValidator("json", updateProviderBody),
  async (c) => {
    const body = c.req.valid("json")
    await providerSettings.setMailProviderEnabled(
      c.get("orgId"),
      c.req.param("providerId"),
      body.enabled,
    )
    const provider = await providerSettings.getMailProvider(
      c.get("orgId"),
      c.req.param("providerId"),
    )
    return success(c, provider)
  },
)

const conversationIdsQuery = z.array(z.string().uuid()).max(100)

/** `?ids=a,b,c`: the rows a realtime event named, fetched through the list projection. */
function parseConversationIds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const parsed = conversationIdsQuery.safeParse(raw.split(",").filter(Boolean))
  if (!parsed.success) throw new HTTPException(400, { message: "ids must be conversation ids" })
  return parsed.data.length > 0 ? parsed.data : undefined
}

/** `?category=primary|other|all`: Gmail's Primary / Other split (A40). */
function parseCategoryQuery(raw: string | undefined): MailCategory | undefined {
  try {
    return parseMailCategory(raw)
  } catch (error) {
    throw new HTTPException(400, { message: (error as Error).message })
  }
}

mailRoutes.get("/conversations", requireScope("mail:conversations:read"), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100)
  const result = await withRequestRls(c, (tx) =>
    mailService.listConversations(tx, {
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      accountId: c.req.query("accountId") || undefined,
      ownership: c.req.query("ownership") === "personal" ? "personal" : undefined,
      status: c.req.query("status") || undefined,
      isRead: c.req.query("isRead") !== undefined ? c.req.query("isRead") === "true" : undefined,
      isStarred:
        c.req.query("isStarred") !== undefined ? c.req.query("isStarred") === "true" : undefined,
      assignedTo: c.req.query("assignedTo") || undefined,
      contactId: c.req.query("contactId") || undefined,
      ids: parseConversationIds(c.req.query("ids")),
      category: parseCategoryQuery(c.req.query("category")),
      cursor: c.req.query("cursor") || undefined,
      limit,
    }),
  )
  return paginated(c, result.data, {
    limit,
    total: result.meta.total,
    nextCursor: result.meta.nextCursor,
  })
})

// The inbox search box over the WHOLE view, not only the pages the list has
// loaded. POST so the text stays out of URLs and access logs. A request carries
// `query` (accounts the server can read) or `messageIds` (what the browser's own
// index matched over a private mailbox, whose text never leaves it), never both.
const searchConversationsBody = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    messageIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    accountIds: z.array(z.string().uuid()).min(1).max(100),
    status: z.string().max(32).optional(),
    ownership: z.literal("personal").optional(),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    assignedTo: z.string().uuid().optional(),
    category: z.enum(["primary", "other", "all"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .refine((body) => (body.query === undefined) !== (body.messageIds === undefined), {
    message: "send either query or messageIds",
  })

mailRoutes.post(
  "/conversations/search",
  requireScope("mail:conversations:read"),
  zValidator("json", searchConversationsBody),
  async (c) => {
    const body = c.req.valid("json")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const status = body.status ?? "open"
    const data = await withRequestRls(c, async (tx) => {
      const matches = await searchMailConversations(
        tx,
        orgId,
        {
          query: body.query,
          messageIds: body.messageIds,
          accountIds: body.accountIds,
          status,
          unreadOnly: body.isRead === false,
          isStarred: body.isStarred,
          assignedTo: body.assignedTo,
          category: body.category,
          limit: body.limit ?? 50,
        },
        {
          userId,
          scopes: c.get("scopes"),
          dimensionGrants: c.get("dimensionGrants") ?? {},
          roleIds: c.get("roles") ?? [],
        },
      )
      const ids = matches.items.map((row) => row.id)
      if (ids.length === 0) return []
      // The rows in the list's own projection, so the browser handles them
      // like any loaded row (a sealed one opens the same way).
      const page = await mailService.listConversations(tx, {
        orgId,
        userId,
        ownership: body.ownership,
        status,
        isRead: body.isRead,
        isStarred: body.isStarred,
        assignedTo: body.assignedTo,
        category: body.category,
        ids,
        limit: ids.length,
      })
      return page.data
    })
    return success(c, data)
  },
)

mailRoutes.get(
  "/conversations/:id",
  requireScope("mail:conversations:read"),
  zValidator("param", idParam),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.getConversation(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        conversationId: c.req.param("id"),
        messageCursor: c.req.query("messageCursor") || undefined,
        messageLimit: c.req.query("messageLimit") ? Number(c.req.query("messageLimit")) : undefined,
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Conversation not found" })
    return success(c, result)
  },
)

mailRoutes.patch(
  "/conversations/:id",
  requireScope("mail:conversations:write"),
  zValidator("param", idParam),
  zValidator("json", updateConversationBody),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.updateConversation(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        conversationId: c.req.param("id"),
        changes: c.req.valid("json"),
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Conversation not found" })
    // Committed: a Gmail-backed mailbox gets the change written back to Gmail.
    await enqueueGmailWriteBack({
      orgId: c.get("orgId"),
      accountId: String(result.account_id),
      conversationIds: [c.req.param("id")],
      changes: c.req.valid("json"),
    })
    return success(c, result)
  },
)

mailRoutes.post(
  "/accounts/:id/sync",
  requireScope("mail:accounts:write"),
  zValidator("param", idParam),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.triggerSync(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        accountId: c.req.param("id"),
        scopes: c.get("scopes"),
      }),
    )
    return success(c, result)
  },
)

mailRoutes.get(
  "/accounts/:id/sync-status",
  requireScope("mail:accounts:read"),
  zValidator("param", idParam),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.getSyncStatus(tx, {
        orgId: c.get("orgId"),
        accountId: c.req.param("id"),
      }),
    )
    return success(c, result)
  },
)

const accountVisibilityBody = z.object({
  visibility: z.enum(["personal", "shared"]),
})

// Per-inbox privacy configuration (admin-configurable, not hardcoded): flips
// an account between personal (owner-only conversations + owner-routed
// approvals) and shared (team behavior). RLS makes a personal account
// writable only by its owner, so this cannot be used to expose someone
// else's mailbox.
mailRoutes.patch(
  "/accounts/:id",
  requireScope("mail:accounts:write"),
  zValidator("param", idParam),
  zValidator("json", accountVisibilityBody),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.setAccountVisibility(tx, {
        orgId: c.get("orgId"),
        accountId: c.req.param("id"),
        visibility: c.req.valid("json").visibility,
      }),
    )
    return success(c, result)
  },
)

mailRoutes.get("/accounts", requireScope("mail:accounts:read"), async (c) => {
  const result = await withRequestRls(c, (tx) =>
    mailService.listAccounts(tx, { orgId: c.get("orgId"), userId: c.get("userId") }),
  )
  return success(c, result)
})

mailRoutes.get(
  "/accounts/:id/assignees",
  requireScope("mail:conversations:read"),
  zValidator("param", idParam),
  async (c) => {
    // A colleague away today says until when; who can be picked does not change.
    const result = await withRequestRls(c, async (tx) =>
      withAway(
        tx,
        c.get("orgId"),
        await mailService.listAssignableUsersForAccount(tx, {
          orgId: c.get("orgId"),
          requesterId: c.get("userId"),
          accountId: c.req.param("id"),
        }),
      ),
    )
    return success(c, result)
  },
)

mailRoutes.post(
  "/accounts/:id/image-preferences",
  requireScope("mail:accounts:write"),
  zValidator("param", idParam),
  zValidator("json", imagePreferenceBody),
  async (c) => {
    const body = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      mailService.allowSenderImageDomain(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        accountId: c.req.param("id"),
        senderDomain: body.senderDomain,
      }),
    )
    return success(c, result)
  },
)

mailRoutes.get("/drafts", requireScope("mail:conversations:read"), async (c) => {
  const result = await withRequestRls(c, (tx) =>
    mailService.listDrafts(tx, { orgId: c.get("orgId"), userId: c.get("userId") }),
  )
  return success(c, result)
})

mailRoutes.get(
  "/drafts/:id",
  requireScope("mail:conversations:read"),
  zValidator("param", idParam),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.getDraft(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        draftId: c.req.param("id"),
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Draft not found" })
    return success(c, result)
  },
)

mailRoutes.post(
  "/drafts",
  requireScope("mail:conversations:write"),
  zValidator("json", createDraftBody),
  async (c) => {
    const body = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      mailService.createDraft(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        accountId: body.accountId,
        conversationId: body.conversationId,
        replyToMessageId: body.replyToMessageId,
        to: body.to,
        cc: body.cc,
        subject: body.subject,
      }),
    )
    return success(c, result)
  },
)

mailRoutes.patch(
  "/drafts/:id",
  requireScope("mail:conversations:write"),
  zValidator("param", idParam),
  zValidator("json", updateDraftBody),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.updateDraft(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        draftId: c.req.param("id"),
        changes: c.req.valid("json"),
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Draft not found" })
    return success(c, result)
  },
)

mailRoutes.delete(
  "/drafts/:id",
  requireScope("mail:conversations:write"),
  zValidator("param", idParam),
  async (c) => {
    await withRequestRls(c, (tx) =>
      mailService.deleteDraft(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        draftId: c.req.param("id"),
      }),
    )
    return success(c, { deleted: true })
  },
)

mailRoutes.post(
  "/drafts/:id/send",
  requireScope("mail:conversations:write"),
  zValidator("param", idParam),
  zValidator("json", sendDraftBody),
  async (c) => {
    const result = await withRequestRls(c, (tx) =>
      mailService.sendDraft(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        draftId: c.req.param("id"),
        ...c.req.valid("json"),
      }),
    )
    return success(c, result)
  },
)

const composeCheckBody = z.object({
  to: z.array(z.string().max(320)).max(MAX_RECIPIENTS).default([]),
  cc: z.array(z.string().max(320)).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(z.string().max(320)).max(MAX_RECIPIENTS).default([]),
})

/**
 * What a new message to these recipients will carry, for the composer: the
 * commercial footer when the data marks a recipient as a prospect (fixed, added
 * at send), or why it cannot go, or the opted-out line of a person's own mail.
 * `missingBasis` names the prospect with no recorded lawful basis: the person
 * is told, and may still send. `recipients` is what is recorded about each
 * recipient who is a contact (basis, consumer or business, opted out), the
 * same facts an agent mail's approval card shows.
 */
mailRoutes.post(
  "/compose-check",
  requireScope("mail:conversations:write"),
  zValidator("json", composeCheckBody),
  async (c) => {
    const body = c.req.valid("json")
    const addresses = recipientsOf(body.to, body.cc, body.bcc)
    const [own, recipients] = await Promise.all([
      checkPersonCompose(c.get("orgId"), addresses),
      recipientFacts(c.get("orgId"), addresses),
    ])
    if (!own.commercial) {
      return success(c, {
        recipients,
        commercial: false,
        footerLines: null,
        refusal: null,
        line: own.line,
        missingBasis: null,
      })
    }
    if ("refused" in own) {
      return success(c, {
        recipients,
        commercial: true,
        footerLines: null,
        // Asked before any send: the reason it cannot go, without the send
        // refusal's "Nothing was sent." (it reads as a failed send).
        refusal: own.refused.message.replace(/^Nothing was sent\. /, ""),
        line: null,
        missingBasis: null,
      })
    }
    return success(c, {
      recipients,
      commercial: true,
      footerLines: own.footerLines,
      refusal: null,
      line: null,
      missingBasis: own.missingBasis,
    })
  },
)

mailRoutes.get("/image-proxy", requireScope("mail:conversations:read"), async (c) => {
  const url = c.req.query("url")
  if (!url) throw new HTTPException(400, { message: "Missing url parameter" })

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HTTPException(400, { message: "Invalid URL" })
  }
  if (parsed.protocol !== "https:")
    throw new HTTPException(400, { message: "Only HTTPS URLs are allowed" })

  let upstream: Response
  try {
    upstream = await fetchWithRedirectValidation(
      url,
      {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "image/*" },
      },
      { requireHttps: true },
    )
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new HTTPException(400, { message: "URL not allowed" })
    }
    throw new HTTPException(502, { message: "Failed to fetch image" })
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (!contentType.startsWith("image/")) {
    throw new HTTPException(400, { message: "URL does not point to an image" })
  }

  const MAX_SIZE = 5 * 1024 * 1024
  // Reject early when Content-Length is known and already over budget.
  // A missing or zero Content-Length is treated as unknown and enforced below.
  const contentLengthHeader = Number(upstream.headers.get("content-length") ?? "0")
  if (contentLengthHeader > 0 && contentLengthHeader > MAX_SIZE) {
    throw new HTTPException(413, { message: "Image too large" })
  }

  // Stream upstream.body and enforce the byte cap during transfer. This
  // prevents the proxy from buffering an unbounded response in memory when
  // the upstream omits or lies about Content-Length.
  const reader = upstream.body?.getReader()
  if (!reader) {
    throw new HTTPException(502, { message: "Failed to read image response" })
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > MAX_SIZE) {
        reader.cancel().catch(() => undefined)
        throw new HTTPException(413, { message: "Image too large" })
      }
      chunks.push(value)
    }
  }
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c)))

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "Content-Length": String(body.byteLength),
    },
  })
})

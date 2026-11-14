// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  addParticipantSchema,
  addReactionSchema,
  addReferenceSchema,
  clientSurfaceSchema,
  createThreadSchema,
  editMessageSchema,
  isReactionEmoji,
  markReadSchema,
  sendMessageSchema,
  updateThreadSchema,
  updateThreadStateSchema,
} from "@liaison/shared"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  files as filesTable,
  messageReactions as messageReactionsTable,
  messages as messagesTable,
  threadParticipants as threadParticipantsTable,
  threads as threadsTable,
  users as usersTable,
} from "~/db/schema/kernel"
import { idempotencyContentHash, withIdempotency } from "~/lib/idempotency"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { UUID_RE } from "~/lib/uuid"
import { zValidator } from "~/lib/validate"
import { threadIdParam, threadMessageParam, threadUserParam } from "~/lib/validators"
import { requireScope } from "~/middleware/require-scope"
import { listAvailableModels } from "~/modules/agent/credits/credit-meter"
import { isModelSelectable } from "~/modules/agent/runtime/model-override"
import { clearOutsideTextMarkNow } from "~/modules/agent/scopes/taint"
import type { WithheldMessageMetadata } from "~/modules/agent/scopes/withheld-capability"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { FileServiceError, moveFilesToParent } from "~/modules/files/service"
import { hasScope } from "~/modules/permissions/permissions"
import { computeUnreadMessageCount } from "~/modules/push/badge-count"
import { entityDiscussionRoutes } from "~/modules/threads/entity-discussion-routes"
import {
  deleteMessage,
  editMessage,
  inheritVisibility,
  listFollowedReplies,
  listMessages,
  listReplies,
  markRepliesRead,
  publishMessageAttachments,
  ReplyThreadError,
  resolveQuote,
  sendMessage,
} from "~/modules/threads/message"
import {
  addAgentParticipant,
  addParticipant,
  joinDiscoverableChannel,
  removeParticipant,
  resolveLiveAgentIds,
} from "~/modules/threads/participant"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { addReaction, removeReaction } from "~/modules/threads/reaction"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"
import { addReference, listRecentReferences } from "~/modules/threads/reference"
import {
  createOrGetAgentDm,
  createThread,
  DuplicateThreadError,
  getDiscoverableChannelProjection,
  getThread,
  listDiscoverableChannels,
  listThreads,
  readAgentContextBoundary,
  resolvePersonalAgentId,
  updateThread,
} from "~/modules/threads/thread"
import {
  CreatedFromNotVisibleError,
  canReadThreadAnchorEntity,
  resolveThreadAnchor,
  threadAnchorIds,
  threadAnchorRef,
} from "~/modules/threads/thread-anchor"
import {
  countThreadUnread,
  HiddenReplyReadError,
  markThreadRead,
  updateThreadState,
} from "~/modules/threads/thread-state"
import { ShareAnywayError } from "~/services/security/disclosure-list"
import { SCOPE_TAINT_BLOCKED_CODE, wouldRevealHiddenHistory } from "~/services/security/visibility"

export const threads = new Hono<AppEnv>()

// An entity's discussion (entity-discussion-routes.ts), before the `/:threadId` routes.
threads.route("/entity-discussion", entityDiscussionRoutes)

/**
 * "Continue in a DM" carries which agent to talk to. `agentId` is optional
 * (P4c-T04): absent, it resolves to the caller's own personal agent, so
 * "open my chat with Liaison" needs no agent id lookup first.
 */
const createAgentDmSchema = z.object({ agentId: z.string().uuid().optional() })

// --- Thread CRUD ---

threads.post(
  "/",
  requireScope("kernel:threads:write"),
  zValidator("json", createThreadSchema),
  async (c) => {
    const body = c.req.valid("json")
    const userId = c.get("userId")
    const orgId = c.get("orgId")

    // Creating org-wide pinned threads requires admin scope
    if (body.isPinned && !hasScope("kernel:threads:admin", c.get("scopes"))) {
      throw new HTTPException(403, { message: "Forbidden" })
    }

    // P4c-T04: `agent_chat` creation through the generic route is retired in
    // favor of `POST /threads/dm`, which resolves the right agent seat
    // instead of trusting the caller to build the row by hand.
    // The enum value itself stays — existing rows keep their type — this
    // only closes the creation path.
    if (body.type === "agent_chat") {
      return c.json(
        {
          error: {
            message: "Creating an agent_chat thread directly is retired; use POST /threads/dm",
            code: "agent_chat_retired",
            hint: "POST /threads/dm",
          },
        },
        400,
      )
    }

    // An entity's thread names its entity in every notification and opens on
    // it, so a `createdFrom` must be an entity its creator may see: checked
    // under the creator's own RLS, in the transaction that creates the thread.
    // The kernel's own writers (a task's discussion, an approval's thread) set
    // it in-process and never come through here.
    const createdFrom = body.createdFrom ? threadAnchorIds(body.createdFrom) : null
    if (body.createdFrom && !createdFrom) {
      return c.json(
        { error: { message: "createdFrom does not name an entity", code: "created_from_invalid" } },
        400,
      )
    }

    try {
      const result = await withRequestRls(c, async (tx) => {
        if (createdFrom && !(await canReadThreadAnchorEntity(tx, orgId, createdFrom))) {
          throw new CreatedFromNotVisibleError()
        }
        return createThread(tx, {
          orgId,
          userId,
          participantIds: body.participantIds,
          title: body.title,
          isPinned: body.isPinned,
          // A35: a channel can be born public. The Zod already refused the flag
          // without a title, so this never publishes a DM.
          discoverable: body.discoverable,
          createdFrom: body.createdFrom,
          references: body.references,
          // A person's own first message: nothing scoped is quoted into it.
          initialMessage: body.initialMessage
            ? { ...body.initialMessage, requiredScopes: [] }
            : undefined,
          type: body.type,
          forceCreate: body.forceCreate,
        })
      })
      return success(c, result)
    } catch (err) {
      if (err instanceof CreatedFromNotVisibleError) {
        return c.json({ error: { message: err.message, code: err.code } }, 403)
      }
      // A duplicate is a client-correctable conflict, not a server fault: 409
      // with the existing thread so the caller can post there instead.
      if (err instanceof DuplicateThreadError) {
        return c.json(
          { error: { message: err.message, code: err.code, existingThread: err.existing } },
          409,
        )
      }
      throw err
    }
  },
)

threads.get("/", requireScope("kernel:threads:read"), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100)
  const cursor = c.req.query("cursor") || undefined
  const archived = c.req.query("archived") === "true"

  const result = await withRequestRls(c, async (tx) => {
    return listThreads(tx, { orgId, userId, limit, cursor, archived })
  })
  return success(c, result.threads, { cursor: result.cursor, hasMore: result.hasMore })
})

/**
 * P4b-D8, "Continue in a DM": the requester's 1:1 chat with one agent.
 *
 * Idempotent by design, so the card's button can be pressed twice without
 * splitting the conversation: an existing chat comes back untouched and
 * `created` says which happened. Registered before `/:threadId` for the same
 * reason `/discoverable` is.
 *
 * Payload: `{ agentId? }`. Answers `{ id, handle, created }`. An archived or
 * foreign agent is 404. Omitting `agentId` resolves the caller's own
 * personal agent (P4c-T04); a caller with none yet is 404
 * `personal_agent_missing`, never a 500.
 */
threads.post(
  "/dm",
  requireScope("kernel:threads:write"),
  zValidator("json", createAgentDmSchema),
  async (c) => {
    const { agentId: requestedAgentId } = c.req.valid("json")
    const orgId = c.get("orgId")
    const userId = c.get("userId")

    const outcome = await withRequestRls(c, async (tx) => {
      const agentId = requestedAgentId ?? (await resolvePersonalAgentId(tx, { orgId, userId }))
      if (!agentId) return { kind: "no_personal_agent" as const }
      const dm = await createOrGetAgentDm(tx, { orgId, userId, agentId })
      return { kind: "dm" as const, dm }
    })

    if (outcome.kind === "no_personal_agent") {
      return c.json(
        {
          error: {
            message: "You have no personal agent yet",
            code: "personal_agent_missing",
          },
        },
        404,
      )
    }
    if (!outcome.dm) throw new HTTPException(404, { message: "Not found" })
    return success(c, outcome.dm, undefined, outcome.dm.created ? 201 : 200)
  },
)

// BEFORE `/:threadId`, or Hono matches "discoverable" as a thread id.
threads.get("/discoverable", requireScope("kernel:threads:read"), async (c) => {
  const result = await withRequestRls(c, async (tx) =>
    listDiscoverableChannels(tx, { orgId: c.get("orgId"), userId: c.get("userId") }),
  )
  return success(c, result)
})

/**
 * S7: the reply threads the caller follows, unread first, then by last reply.
 * Each row is `{ rootMessage, channel: { id, name }, replyCount, lastReplyAt,
 * unreadCount }`. Read under the caller's RLS, so a root they can no longer
 * read, or a channel they left, is simply absent. Registered before
 * `/:threadId` for the same reason `/discoverable` is (A20).
 */
threads.get("/followed-replies", requireScope("kernel:threads:read"), async (c) => {
  const limit = Number(c.req.query("limit") ?? 50)
  const result = await withRequestRls(c, (tx) =>
    listFollowedReplies(tx, {
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  )
  return success(c, result)
})

/**
 * S8, A14: the caller's unread total across every thread, for the Messages
 * entry's badge. The client's own sum covers only the 50 threads its list
 * holds. It is the Messages list's own number (`computeUnreadMessageCount`),
 * not the app badge (`GET /notifications/badge`); it runs under the caller's
 * RLS and skips muted and archived threads.
 * Registered before `/:threadId` like `/discoverable`.
 */
threads.get("/unread-count", requireScope("kernel:threads:read"), async (c) => {
  const count = await computeUnreadMessageCount(c.get("userId"), c.get("orgId"))
  return success(c, { count })
})

threads.get(
  "/:threadId",
  requireScope("kernel:threads:read"),
  zValidator("param", threadIdParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const scope = { orgId: c.get("orgId"), userId: c.get("userId"), threadId }
    const thread = await withRequestRls(c, (tx) => getThread(tx, scope))
    if (thread) {
      // The entity the thread belongs to (a task's comments), in the reader's
      // own visibility: the view says whose conversation this is and opens it.
      const ref = threadAnchorRef(thread.createdFrom, scope.orgId)
      const anchor = ref
        ? await withRequestRls(c, (tx) => resolveThreadAnchor(tx, scope.orgId, ref))
        : null
      return success(c, { ...thread, anchor })
    }
    // Not a member. A DISCOVERABLE channel is still openable by id, because a
    // channel has to be judged before it is joined, but only as the listing row:
    // roster, creator, model and per-user state stay behind membership. Anything
    // else is a private thread and answers 404 exactly as before.
    const projection = await withRequestRls(c, (tx) => getDiscoverableChannelProjection(tx, scope))
    if (!projection) throw new HTTPException(404, { message: "Thread not found" })
    return success(c, projection)
  },
)

threads.patch(
  "/:threadId",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", updateThreadSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const changes = c.req.valid("json")

    // Pinning a CONVERSATION to a model is permission gated by the same rule
    // that gates the picker: the org must be able to call it. Without this the
    // endpoint took any string, so a conversation could be pinned to a model
    // whose provider has no key and every turn after it failed at send time.
    // Clearing the pin (null) asks for less and is always allowed.
    if (changes.agentModelId !== undefined && changes.agentModelId !== null) {
      const available = await listAvailableModels(c.get("orgId"))
      if (
        !isModelSelectable(
          changes.agentModelId,
          available.map((m) => m.modelId),
        )
      ) {
        throw new HTTPException(403, {
          message: `Model not available for this organization: ${changes.agentModelId}`,
        })
      }
    }

    const result = await withRequestRls(c, async (tx) => {
      return updateThread(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        scopes: c.get("scopes"),
        changes,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Thread not found" })
    return success(c, result)
  },
)

/**
 * How far the first page may stretch to put the agent context boundary on it.
 * Past this the boundary is genuinely far back and paging reaches it.
 */
const FIRST_PAGE_BOUNDARY_CEILING = 200

// --- Messages ---

threads.get(
  "/:threadId/messages",
  requireScope("kernel:threads:read"),
  zValidator("param", threadIdParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const requestedLimit = Math.min(Number(c.req.query("limit") ?? 50), 100)
    const before = c.req.query("before") || undefined
    const after = c.req.query("after") || undefined

    if (before && after) {
      throw new HTTPException(400, { message: "Cannot specify both 'before' and 'after' cursors" })
    }

    const result = await withRequestRls(c, async (tx) => {
      let limit = requestedLimit
      // THE FIRST PAGE REACHES THE AGENT CONTEXT BOUNDARY. The row is drawn
      // after the message the agent's checkpoint covers, and that message sat
      // 73 rows back on the live box while the first page loaded 50: the reader
      // had to scroll into older history before the room admitted the agent was
      // reading a summary. The first page (no cursor either way) is sized to
      // include the boundary, up to a ceiling so a boundary thousands of rows
      // back never loads the whole thread.
      if (!before && !after) {
        const boundary = await readAgentContextBoundary(tx, {
          threadId,
          orgId: c.get("orgId"),
        }).catch(() => null)
        if (boundary) {
          limit = Math.min(Math.max(limit, boundary.messagesAfter + 1), FIRST_PAGE_BOUNDARY_CEILING)
        }
      }
      return listMessages(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        limit,
        before,
        after,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    // `hiddenRuns` says WHERE the viewer's hidden messages sit and how many,
    // never what they are (P2b-T12): without it on the meta the client cannot
    // draw the marker at all, which is what D3 fixes.
    return success(c, result.messages, {
      cursor: result.cursor,
      hasMore: result.hasMore,
      hiddenRuns: result.hiddenRuns,
    })
  },
)

// --- The outside-text mark (the globe beside a marked conversation) ---

/**
 * What marked this conversation (agent/scopes/taint.ts): the same list the agent's
 * `outside_text_sources` reads, from the history as the caller may read it. A conversation the
 * caller cannot read answers 404, exactly like GET /:threadId.
 */
threads.get(
  "/:threadId/outside-text",
  requireScope("kernel:threads:read"),
  zValidator("param", threadIdParam),
  async (c) => {
    const { threadId } = c.req.valid("param")
    const scope = { orgId: c.get("orgId"), userId: c.get("userId"), threadId }
    const thread = await withRequestRls(c, (tx) => getThread(tx, scope))
    if (!thread) throw new HTTPException(404, { message: "Thread not found" })
    const { outsideTextMarkForPerson } = await import("~/modules/agent/tools/outside-text-tools")
    return success(c, await outsideTextMarkForPerson(threadId, extractRlsContext(c)))
  },
)

/**
 * The globe's "Clear the mark": the person in the conversation lifts the mark at once, with the
 * effect of an approved kernel:outside_text_clear (taint.ts `clearOutsideTextMarkNow`). No card is
 * raised: the person clicking is exactly who would decide it. Who may, mirroring who decides that
 * card: a HUMAN seated in the conversation (an agent seat, a non-member and an admin who is not
 * seated are refused alike, 404, so the route is no existence oracle), holding the card's deciding
 * scope (`kernel:threads:read`), on an unrestricted session (a device-flow or CLI token decides no
 * approval, auth/session-ceiling.ts). MCP connection tokens, the only credential an agent carries
 * outside its own turn, never authenticate this surface (middleware/auth.ts).
 */
threads.post(
  "/:threadId/outside-text/clear",
  requireScope("kernel:threads:read"),
  zValidator("param", threadIdParam),
  async (c) => {
    const { threadId } = c.req.valid("param")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    assertUnrestrictedSession(c, "clear a conversation's outside-text mark")
    const seat = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({ id: threadParticipantsTable.id })
        .from(threadParticipantsTable)
        .where(
          and(
            eq(threadParticipantsTable.threadId, threadId),
            eq(threadParticipantsTable.orgId, orgId),
            eq(threadParticipantsTable.userId, userId),
            eq(threadParticipantsTable.participantType, "user"),
            isNull(threadParticipantsTable.agentId),
          ),
        )
        .limit(1)
      return row
    })
    if (!seat) throw new HTTPException(404, { message: "Thread not found" })
    const cleared = await clearOutsideTextMarkNow(threadId, orgId, userId)
    if (!cleared) throw new HTTPException(404, { message: "Thread not found" })
    return success(c, { cleared: true, marked: false })
  },
)

/**
 * P4b-D2, the withheld card's "Share anyway".
 *
 * The card is private to the ONE member whose turn withheld, so this route is
 * too: the reply's own `metadata.withheld` block names that requester, and
 * anybody else is refused. The rerun (services/security/share-anyway.ts) runs
 * at `agent ceiling INTERSECT requester grants` with write tools disabled, and
 * writes the disclosure's audit row in the same transaction as the messages.
 *
 * A scope-taint item is refused HERE rather than rerun: a turn that read
 * scope-tainted context is refused the same way on a rerun, so offering it
 * would cost a model call to produce the identical refusal.
 *
 * Payload: {} (the message ids identify the turn). Answers
 * `{ messageIds: string[] }`.
 */
threads.post(
  "/:threadId/messages/:messageId/share-anyway",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  async (c) => {
    const { threadId, messageId } = c.req.valid("param")
    const orgId = c.get("orgId")
    const userId = c.get("userId")

    const reply = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({
          metadata: messagesTable.metadata,
          authorAgentId: messagesTable.authorAgentId,
          threadId: messagesTable.threadId,
        })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.id, messageId),
            eq(messagesTable.threadId, threadId),
            eq(messagesTable.orgId, orgId),
          ),
        )
        .limit(1)
      return row
    })
    // A message the caller cannot read is the same answer as one that is not
    // there: the route is never an existence oracle on somebody else's room.
    if (!reply) throw new HTTPException(404, { message: "Not found" })

    const withheld = (reply.metadata as { withheld?: WithheldMessageMetadata } | null)?.withheld
    // No card was ever shown on this message, so there is nothing to share.
    if (!withheld) throw new HTTPException(404, { message: "Nothing was withheld on that message" })
    if (withheld.requesterId !== userId) {
      throw new HTTPException(403, {
        message: "only the member whose turn withheld can share it",
      })
    }
    if (withheld.items.some((item) => item.scopeTainted)) {
      throw new HTTPException(409, {
        message: `${SCOPE_TAINT_BLOCKED_CODE}: that turn read scoped data, so a rerun is refused the same way`,
      })
    }
    if (!withheld.turnId) {
      throw new HTTPException(409, { message: "that turn can no longer be rerun" })
    }
    const agentId = reply.authorAgentId
    if (!agentId) {
      throw new HTTPException(409, { message: "that turn names no agent to rerun" })
    }

    try {
      const { shareAnyway } = await import("~/services/security/share-anyway")
      const result = await shareAnyway(extractRlsContext(c), {
        turnId: withheld.turnId,
        requesterId: userId,
        roomId: threadId,
        agentId,
        // The card, not the turn: one user message fires every agent it
        // mentions, so the turn id is shared by all their cards.
        withheldMessageId: messageId,
      })
      return success(c, result)
    } catch (err) {
      if (err instanceof ShareAnywayError) {
        const status =
          err.code === "E_SHARE_ANYWAY_NOT_REQUESTER"
            ? 403
            : err.code === "E_SHARE_ANYWAY_TURN_NOT_FOUND"
              ? 404
              : 409
        // `err.message` already begins with the code, and no ShareAnywayError
        // carries anything the requester may not read: the one that used to
        // name raw scopes (E_SCOPE_NOT_DISCLOSABLE) now logs them server-side
        // instead. Prefixing the code a second time only doubled it.
        throw new HTTPException(status, { message: err.message })
      }
      throw err
    }
  },
)

/**
 * Parity with the agent panel's /agent/chat body (P4c-T10). The thread surface
 * is the only one left once the panel retires, so a message posted here must be
 * able to carry the same two things a panel turn carried: the app the user is
 * actually looking at, and the mailbox turn nonce that lets the turn ask THIS
 * browser to decrypt the user's mail. Same shapes as the agent route's schema.
 */
const messageTurnContextSchema = z.object({
  currentView: z
    .object({
      tabType: z.string(),
      entityId: z.string(),
    })
    .optional(),
  turnNonce: z.string().min(8).max(128).optional(),
  /**
   * THIS AGENT'S TURN RUNS ON THE SENDER'S MACHINE. The desktop sends it for a
   * conversation whose runtime is "This machine", once its local session is
   * running; the server then never starts that agent's turn for this message,
   * whether or not the session's claim is live when the message lands. It
   * suppresses nothing else: other agents the message names are dispatched as
   * usual.
   */
  localAgentId: z.string().uuid().optional(),
  /** Where the sender is (desktop app, browser, mobile app), so a server turn
   *  gives the right steps to computer mode. Absent means unknown. */
  clientSurface: clientSurfaceSchema.optional(),
})

/** The message a post wrote, as `sendMessage` answers it. */
type PostedMessageRow = NonNullable<Awaited<ReturnType<typeof sendMessage>>>

/** What a keyed post keeps for its retries (A27): the answer's status and the message. */
interface PostedMessageRecord {
  status: 200
  messageId: string
}

/**
 * A retried post's answer: the message it already wrote, re-read under the
 * caller's RLS, in the first answer's shape. Read only, so the replay runs no
 * side effect (no event, no dispatch). Null when the caller can no longer read it.
 */
async function readPostedMessage(
  tx: RlsClient,
  params: { orgId: string; threadId: string; messageId: string },
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ msg: messagesTable, authorName: usersTable.name, threadType: threadsTable.type })
    .from(messagesTable)
    .leftJoin(usersTable, eq(usersTable.id, messagesTable.authorId))
    .leftJoin(threadsTable, eq(threadsTable.id, messagesTable.threadId))
    .where(
      and(
        eq(messagesTable.id, params.messageId),
        eq(messagesTable.threadId, params.threadId),
        eq(messagesTable.orgId, params.orgId),
      ),
    )
    .limit(1)
  if (!row) return null
  const files = await tx
    .select({
      id: filesTable.id,
      filename: filesTable.filename,
      mimeType: filesTable.mimeType,
      sizeBytes: filesTable.sizeBytes,
      thumbnailKey: filesTable.thumbnailKey,
      disposition: filesTable.disposition,
      contentId: filesTable.contentId,
      ordinal: filesTable.ordinal,
      createdAt: filesTable.createdAt,
    })
    .from(filesTable)
    .where(
      and(
        eq(filesTable.app, "kernel"),
        eq(filesTable.entityType, "message"),
        eq(filesTable.entityId, params.messageId),
      ),
    )
    .orderBy(asc(filesTable.ordinal), asc(filesTable.createdAt), asc(filesTable.id))
  const { msg } = row
  return {
    id: msg.id,
    threadId: msg.threadId,
    authorId: msg.authorId,
    authorName: row.authorName ?? "Unknown",
    authorAvatarUrl: null,
    authorType: msg.authorType,
    authorAgentId: msg.authorAgentId ?? null,
    parentMessageId: msg.parentMessageId ?? null,
    replyRootId: msg.replyRootId ?? null,
    alsoInChannel: msg.alsoInChannel,
    content: msg.content,
    mentions: msg.mentions,
    metadata: msg.metadata ?? null,
    reactions: [],
    editedAt: msg.editedAt,
    deletedAt: msg.deletedAt,
    createdAt: msg.createdAt,
    threadType: row.threadType ?? "thread",
    attachments: files,
  }
}

threads.post(
  "/:threadId/messages",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", z.intersection(sendMessageSchema, messageTurnContextSchema)),
  async (c) => {
    const threadId = c.req.param("threadId")
    const {
      content,
      correlationId,
      attachmentSessionId,
      parentMessageId,
      replyRootId,
      alsoSendToChannel,
      quote,
      currentView,
      turnNonce,
      localAgentId,
      clientSurface,
    } = c.req.valid("json")
    const orgId = c.get("orgId")
    const userId = c.get("userId")

    // THE WRITE, up to its commit. A refusal throws, so a keyed post frees its
    // idempotency key: nothing was written.
    const commitPost = async () => {
      const posted = await insertPost()
      if (!posted) throw new HTTPException(404, { message: "Not found" })
      return posted
    }
    const insertPost = () =>
      withRequestRls(c, async (tx) => {
        // A REPLY names a root of THIS thread (S2, A15). Not found, another
        // thread's or hidden from the sender: 404, the parent rule below. A root
        // that is itself a reply, or is deleted, is a mistake the client can
        // correct: 400.
        if (replyRootId) {
          const [root] = await tx
            .select({
              replyRootId: messagesTable.replyRootId,
              deletedAt: messagesTable.deletedAt,
            })
            .from(messagesTable)
            .where(
              and(
                eq(messagesTable.id, replyRootId),
                eq(messagesTable.threadId, threadId),
                eq(messagesTable.orgId, c.get("orgId")),
              ),
            )
            .limit(1)
          if (!root) return null
          if (root.replyRootId) {
            throw new ReplyThreadError(
              400,
              "reply_root_is_reply",
              "A reply cannot be a thread root",
            )
          }
          if (root.deletedAt) {
            throw new ReplyThreadError(400, "reply_root_deleted", "That message was deleted")
          }
        }
        // A QUOTE is resolved here, under the sender's RLS (A1): the server
        // names the quoted author and the quoting message takes the quoted one's
        // scope tag, so a quote never republishes what the room may not read.
        let visibility: { requiredScopes: string[]; disclosureList: string[] | null } = {
          requiredScopes: [],
          disclosureList: null,
        }
        let metadata: Record<string, unknown> | undefined
        if (quote) {
          const resolved = await resolveQuote(tx, {
            orgId: c.get("orgId"),
            threadId,
            messageId: quote.messageId,
            excerpt: quote.excerpt,
          })
          visibility = inheritVisibility(visibility, resolved)
          metadata = { quote: resolved.quote }
        }
        // A nested post names a message of THIS thread. Anything else reads as
        // not found: the route is never an existence oracle on another room's
        // messages, and a cross thread parent would break the chain every
        // dispatch guard walks.
        if (parentMessageId) {
          const [parent] = await tx
            .select({ id: messagesTable.id })
            .from(messagesTable)
            .where(
              and(
                eq(messagesTable.id, parentMessageId),
                eq(messagesTable.threadId, threadId),
                eq(messagesTable.orgId, c.get("orgId")),
              ),
            )
            .limit(1)
          if (!parent) return null
        }
        return sendMessage(tx, {
          requiredScopes: visibility.requiredScopes,
          disclosureList: visibility.disclosureList,
          orgId: c.get("orgId"),
          userId: c.get("userId"),
          threadId,
          content,
          correlationId,
          parentMessageId: parentMessageId ?? null,
          replyRootId: replyRootId ?? null,
          alsoInChannel: alsoSendToChannel === true,
          ...(metadata ? { metadata } : {}),
        })
      })

    // EVERYTHING AFTER THE COMMIT: attachments, the agent dispatch, the answer.
    const afterPost = async (msg: PostedMessageRow) => {
      // Reparent any staged files from the upload session onto the new message.
      // We do this after the message is persisted because the message id is the
      // final parent — the session held the files until now.
      if (attachmentSessionId) {
        try {
          const userId = c.get("userId")
          const orgId = c.get("orgId")
          const scopes = c.get("scopes") as unknown as string[]
          await withRequestRls(c, async (rlsTx) => {
            // First load file ids parented to this session so we know what to move.
            const { sql: dsql } = await import("drizzle-orm")
            const { schemaRef: sr } = await import("~/db/schema-ref")
            const K2 = dsql.raw(sr("kernel"))
            const rows = (await rlsTx.execute<{ id: string }>(
              dsql`SELECT id::text AS id FROM ${K2}.files
                 WHERE app = 'kernel' AND entity_type = 'file_upload_session'
                   AND entity_id = ${attachmentSessionId}`,
            )) as unknown as Array<{ id: string }>
            const fileIds = rows.map((r) => r.id)
            if (fileIds.length === 0) return
            await moveFilesToParent(
              {
                orgId,
                userId,
                scopes,
                sourceSessionId: attachmentSessionId,
                target: { app: "kernel", entityType: "message", entityId: msg.id },
                fileIds,
              },
              {
                rlsTx,
                privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
              },
            )
          })
        } catch (err) {
          if (err instanceof FileServiceError) {
            // Surface the reparent failure to the client — the message was
            // persisted, but the attachments are still on the session and can be
            // retried by re-sending with the same session id.
            throw new HTTPException(err.code === "FORBIDDEN" ? 403 : 409, {
              message: err.message,
            })
          }
          throw err
        }
      }

      // Fire-and-forget agent invocation. Two triggers:
      //  1. An explicit @Liaison mention (shared threads — the agent stays quiet
      //     otherwise so it does not reply to every human-to-human message).
      //  2. A 1:1 agent chat (`agent_chat`): there is no one else to address, so
      //     every user message is directed at the agent — no mention required.
      //     The mailbox job-turn transport still posts such a thread's turn to
      //     /agent/chat; this covers the same thread opened in the dock or the
      //     thread view, where posts go through this route instead.
      // The user message is ALREADY persisted above — invokeAgentForThread does NOT re-persist it.
      // Both triggers live in `dispatchForPostedMessage`, which the MCP gateway's
      // threads_reply runs too: what a posted message triggers is a property of
      // the message, not of the surface that wrote it.
      //
      // What the panel's turn carried, carried here too. Absent fields are left
      // out entirely: "no view" and "no mailbox session" are the ordinary case,
      // and the run frame must not tell them from a forgotten value.
      const sessionRestricted = c.get("sessionRestricted") === true
      const turnContext =
        currentView || turnNonce || clientSurface || sessionRestricted
          ? {
              ...(currentView ? { currentView } : {}),
              ...(turnNonce ? { mailboxTurnNonce: turnNonce } : {}),
              ...(clientSurface ? { clientSurface } : {}),
              ...(sessionRestricted ? { sessionRestricted: true } : {}),
            }
          : undefined
      await dispatchForPostedMessage((fn) => withRequestRls(c, fn), {
        orgId: c.get("orgId"),
        threadId,
        message: msg,
        actor: {
          userId: c.get("userId"),
          orgId: c.get("orgId"),
          scopes: c.get("scopes") as string[],
          dimensionGrants: c.get("dimensionGrants"),
          roles: c.get("roles"),
        },
        // NO ceiling: an in-app turn runs the agent at its own, exactly as before.
        ...(turnContext ? { turnContext } : {}),
        ...(localAgentId ? { localAgentId } : {}),
      })

      // Enrich the response with the message's attachments (if any) so the
      // optimistic insert in the web message store can render the strip
      // immediately — without an extra round-trip to listMessages. The same call
      // broadcasts a `message:update` carrying those attachments, which is what
      // makes them appear live for every OTHER participant (the `message:create`
      // event was queued before the reparent, so it carries none).
      let attachments: unknown[] = []
      if (attachmentSessionId) {
        attachments = await withRequestRls(c, (rlsTx) =>
          publishMessageAttachments(rlsTx, {
            orgId: c.get("orgId"),
            userId: c.get("userId"),
            threadId,
            messageId: msg.id,
          }),
        )
      }

      return { ...(msg as Record<string, unknown>), attachments }
    }

    if (!correlationId) return success(c, await afterPost(await commitPost()))

    // A RETRIED POST IS APPLIED ONCE (A27). The same correlationId in this
    // thread answers the message already written, re-read, and runs no side
    // effect again; the same id with another payload is refused (422). The key
    // is marked done right after the commit, so a failure in the steps after it
    // never writes the message twice. Redis failing lets the post through
    // without dedup (`withIdempotency`). The key names the sender: a
    // correlationId is minted by one client, so another person's post with the
    // same id is their own message, never a replay of (or a 422 against) this one.
    let posted: PostedMessageRow | undefined
    const { status, body } = await withIdempotency(
      `idem:msg:${orgId}:${threadId}:${userId}:${correlationId}`,
      idempotencyContentHash({
        userId,
        content,
        attachmentSessionId: attachmentSessionId ?? null,
        parentMessageId: parentMessageId ?? null,
        replyRootId: replyRootId ?? null,
        alsoSendToChannel: alsoSendToChannel === true,
        quote: quote ?? null,
      }),
      {
        commit: async (): Promise<PostedMessageRecord> => {
          posted = await commitPost()
          return { status: 200, messageId: posted.id }
        },
        after: async (record) => {
          if (!posted) throw new Error("message post: committed without a message")
          return { status: record.status, body: await afterPost(posted) }
        },
        replay: async (record) => {
          const replayed = await withRequestRls(c, (tx) =>
            readPostedMessage(tx, { orgId, threadId, messageId: record.messageId }),
          )
          if (!replayed) throw new HTTPException(404, { message: "Not found" })
          return { status: record.status, body: replayed }
        },
      },
    )
    return success(c, body, undefined, status)
  },
)

/**
 * S4: one reply thread, `{ root, replies }` with the replies oldest first and
 * the channel list's paging (`limit`, `before`, `after`; meta `cursor`,
 * `hasMore`, `hiddenRuns`). 404 when the caller cannot read the root (A2).
 */
threads.get(
  "/:threadId/messages/:messageId/replies",
  requireScope("kernel:threads:read"),
  zValidator("param", threadMessageParam),
  async (c) => {
    const { threadId, messageId } = c.req.valid("param")
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 100)
    const before = c.req.query("before") || undefined
    const after = c.req.query("after") || undefined
    if (before && after) {
      throw new HTTPException(400, { message: "Cannot specify both 'before' and 'after' cursors" })
    }
    const result = await withRequestRls(c, (tx) =>
      listReplies(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        rootId: messageId,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        before,
        after,
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(
      c,
      { root: result.root, replies: result.replies },
      { cursor: result.cursor, hasMore: result.hasMore, hiddenRuns: result.hiddenRuns },
    )
  },
)

/** S7: the caller has read this reply thread up to now. 404 on a root they cannot read. */
threads.post(
  "/:threadId/messages/:messageId/replies/read",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  async (c) => {
    const { threadId, messageId } = c.req.valid("param")
    const result = await withRequestRls(c, (tx) =>
      markRepliesRead(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        rootId: messageId,
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    // Committed: the reader's other devices drop this reply thread's badge now.
    await broadcastReadState(c.get("orgId"), c.get("userId"), {
      kind: "reply_thread",
      threadId,
      rootId: messageId,
    })
    return success(c, result)
  },
)

threads.patch(
  "/:threadId/messages/:messageId",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  zValidator("json", editMessageSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const messageId = c.req.param("messageId")
    const { content } = c.req.valid("json")
    const isAdmin = hasScope("kernel:threads:admin", c.get("scopes"))
    const result = await withRequestRls(c, async (tx) => {
      return editMessage(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        messageId,
        content,
        isAdmin,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

threads.delete(
  "/:threadId/messages/:messageId",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const messageId = c.req.param("messageId")
    const isAdmin = hasScope("kernel:threads:admin", c.get("scopes"))
    const result = await withRequestRls(c, (tx) =>
      deleteMessage(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        messageId,
        isAdmin,
      }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

// --- Reactions ---

threads.post(
  "/:threadId/messages/:messageId/reactions",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  zValidator("json", addReactionSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const messageId = c.req.param("messageId")
    const { emoji } = c.req.valid("json")
    const result = await withRequestRls(c, async (tx) => {
      return addReaction(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        messageId,
        emoji,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

threads.delete(
  "/:threadId/messages/:messageId/reactions/:emoji",
  requireScope("kernel:threads:write"),
  zValidator("param", threadMessageParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const messageId = c.req.param("messageId")
    const rawEmoji = decodeURIComponent(c.req.param("emoji"))
    // The same rule as addReactionSchema (S17): a single emoji, never text.
    // EXCEPT for a value already stored on this message: a reaction written
    // before the strict rule ("❤" without FE0F, plain text) must stay
    // removable, so any value of at most 32 UTF-16 units that exists as a
    // reaction on the message is accepted. One that exists nowhere is still
    // refused, as before.
    const strict = isReactionEmoji(rawEmoji)
    if (!strict && (rawEmoji.length === 0 || rawEmoji.length > 32)) {
      throw new HTTPException(400, { message: "Invalid emoji" })
    }
    const result = await withRequestRls(c, async (tx) => {
      if (!strict) {
        const [stored] = await tx
          .select({ id: messageReactionsTable.id })
          .from(messageReactionsTable)
          .where(
            and(
              eq(messageReactionsTable.messageId, messageId),
              eq(messageReactionsTable.orgId, c.get("orgId")),
              eq(messageReactionsTable.emoji, rawEmoji),
            ),
          )
          .limit(1)
        if (!stored) throw new HTTPException(400, { message: "Invalid emoji" })
      }
      return removeReaction(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        messageId,
        emoji: rawEmoji,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

// --- Participants ---

/**
 * P4b-D4: would adding this person land them on history they cannot read?
 *
 * The add dialog asks before it adds, so the gate is the ADD's gate: the
 * caller holds `kernel:threads:write` and is a member of the room, and the
 * candidate is an active user of the same org. Anything else is 404 and never
 * 403, so the route is not an existence oracle on a room the caller is not in,
 * nor a directory of who exists elsewhere.
 *
 * The answer is `{ wouldHideHistory: boolean }` and nothing more: not how
 * much, not under what scope, not from whom (A14).
 */
threads.get(
  "/:threadId/hidden-history-check",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const candidateId = c.req.query("userId")
    if (!candidateId || !UUID_RE.test(candidateId)) {
      throw new HTTPException(400, { message: "userId must be a uuid" })
    }
    const orgId = c.get("orgId")
    const userId = c.get("userId")

    const answer = await withRequestRls(c, async (tx) => {
      const [caller] = await tx
        .select({ id: threadParticipantsTable.id })
        .from(threadParticipantsTable)
        .where(
          and(
            eq(threadParticipantsTable.threadId, threadId),
            eq(threadParticipantsTable.userId, userId),
            eq(threadParticipantsTable.orgId, orgId),
          ),
        )
        .limit(1)
      if (!caller) return null
      const [candidate] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, candidateId),
            eq(usersTable.orgId, orgId),
            eq(usersTable.status, "active"),
          ),
        )
        .limit(1)
      if (!candidate) return null
      return wouldRevealHiddenHistory(tx, threadId, candidateId)
    })
    if (answer === null) throw new HTTPException(404, { message: "Not found" })
    return success(c, { wouldHideHistory: answer })
  },
)

threads.post(
  "/:threadId/participants",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", addParticipantSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const orgId = c.get("orgId")
    const { userId: targetUserId, agentId } = c.req.valid("json")

    // An AGENT seat, the same row a mention's auto-add writes. Its own branch
    // because `addParticipant` resolves a USER, and an agent id handed to it
    // resolves to nobody.
    if (agentId) {
      const seated = await withRequestRls(c, (tx) =>
        addAgentParticipant(tx, {
          orgId,
          threadId,
          agentId,
          actorUserId: c.get("userId"),
        }),
      )
      if (seated) return success(c, seated)
      // `addAgentParticipant` returns null for "already seated" AND for "no
      // such live agent". Only the second is a 404: seating an agent twice is
      // the same request answered twice, not a failure.
      const live = await withRequestRls(c, (tx) =>
        resolveLiveAgentIds(tx, { orgId, agentIds: [agentId] }),
      )
      if (live.length === 0) throw new HTTPException(404, { message: "Not found" })
      return success(c, { added: false })
    }

    const result = await withRequestRls(c, async (tx) => {
      return addParticipant(tx, {
        orgId,
        userId: c.get("userId"),
        threadId,
        targetUserId: targetUserId as string,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

// Joining a channel is the ONE membership write that needs no existing member
// to grant it: a discoverable thread is open to every member of the org.
threads.post(
  "/:threadId/join",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  async (c) => {
    const result = await withRequestRls(c, async (tx) =>
      joinDiscoverableChannel(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId: c.req.param("threadId"),
      }),
    )
    // Not a discoverable channel of this org: the same answer as a thread that
    // does not exist, so the route never confirms a private thread's id.
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

threads.delete(
  "/:threadId/participants/:userId",
  requireScope("kernel:threads:write"),
  zValidator("param", threadUserParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const targetUserId = c.req.param("userId")
    const scopes = c.get("scopes")
    const isAdmin = hasScope("kernel:threads:admin", scopes)
    const result = await withRequestRls(c, async (tx) => {
      return removeParticipant(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        targetUserId,
        isAdmin,
      })
    })
    if (!result.removed) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

// --- References ---

threads.post(
  "/:threadId/references",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", addReferenceSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const body = c.req.valid("json")
    const result = await withRequestRls(c, async (tx) => {
      return addReference(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        ...body,
      })
    })
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

threads.get(
  "/:threadId/references",
  requireScope("kernel:threads:read"),
  zValidator("param", threadIdParam),
  async (c) => {
    const threadId = c.req.param("threadId")
    const items = await withRequestRls(c, (tx) =>
      listRecentReferences(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
      }),
    )
    return success(c, { items })
  },
)

// --- User Thread State ---

threads.patch(
  "/:threadId/state",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", updateThreadStateSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const body = c.req.valid("json")
    const result = await withRequestRls(c, async (tx) => {
      const thread = await getThread(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
      })
      if (!thread) return { notFound: true as const }
      return updateThreadState(tx, {
        orgId: c.get("orgId"),
        userId: c.get("userId"),
        threadId,
        ...body,
      })
    })
    if (result && "notFound" in result)
      throw new HTTPException(404, { message: "Thread not found" })
    if (!result) throw new HTTPException(403, { message: "Not a participant of this thread" })
    // Committed: the caller's other devices apply the same flags now (a thread
    // muted or archived on one device must stop showing as live on the others).
    if (result.state) {
      await broadcastReadState(c.get("orgId"), c.get("userId"), {
        kind: "thread_state",
        threadId,
        ...result.state,
      })
    }
    return success(c, { ok: true })
  },
)

threads.patch(
  "/:threadId/read",
  requireScope("kernel:threads:write"),
  zValidator("param", threadIdParam),
  zValidator("json", markReadSchema),
  async (c) => {
    const threadId = c.req.param("threadId")
    const { lastReadMessageId } = c.req.valid("json")
    const userId = c.get("userId")
    let unreadCount: number | null
    try {
      unreadCount = await withRequestRls(c, async (tx) => {
        const marked = await markThreadRead(tx, {
          orgId: c.get("orgId"),
          userId,
          threadId,
          lastReadMessageId,
        })
        return marked ? countThreadUnread(tx, { userId, threadId }) : null
      })
    } catch (err) {
      if (err instanceof HiddenReplyReadError) {
        return c.json({ error: { message: err.message, code: err.code } }, 400)
      }
      throw err
    }
    if (unreadCount === null) {
      throw new HTTPException(403, { message: "Not a participant of this thread" })
    }
    // Committed: every OTHER device of this reader drops the pill now, with
    // the server's own count (a message that landed mid-read stays unread).
    await broadcastReadState(c.get("orgId"), userId, { kind: "thread", threadId, unreadCount })
    return success(c, { ok: true, unreadCount })
  },
)

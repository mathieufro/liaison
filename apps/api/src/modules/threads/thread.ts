// SPDX-License-Identifier: FSL-1.1-ALv2
import { MENTION_SEAT_ORIGIN, maskWithNote, normalizeChannelTitle } from "@liaison/shared"
import { and, asc, desc, sql as drizzleSql, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import { extractRows } from "~/db"
import { advisoryXactLock, assertTransactionScoped } from "~/db/advisory-lock"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agents,
  agentThreadCheckpoints,
  messages,
  threadParticipants,
  threadReferences,
  threads,
  users,
  userThreadState,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { usableDefaultModel } from "~/modules/agent/credits/credit-meter"
import { expandWildcardStamp } from "~/modules/agent/scopes/taint-read-scopes"
import { reservedDemoModelId } from "~/modules/demo/demo-spend"
import { hasScope } from "~/modules/permissions/permissions"
import { isPlainThreadShape } from "~/modules/threads/dm-shape"
import {
  agentAuthorDisplayName,
  agentPostMetadata,
  assertExplicitRequiredScopes,
  resolveActingAgentIdForWrite,
  resolveAgentAuthorName,
  sendMessage as sendMsg,
} from "~/modules/threads/message"
import { AGENT_GUEST_SEAT_ROLE, addAgentParticipant } from "~/modules/threads/participant"
import { addReference } from "~/modules/threads/reference"
import { notStatusLine } from "~/modules/threads/status-line-sql"
import { allocateThreadHandle, handleForRetitle } from "~/modules/threads/thread-handle"
import { messageVisibilityFacts } from "~/services/security/visibility"

/**
 * A new thread's first message. `requiredScopes` is mandatory for the same
 * reason as on sendMessage: an agent passes its turn's scopes, `[]` asserts the
 * content carries no scoped data.
 */
interface InitialMessageInput {
  content: string
  authorType?: "user" | "agent"
  agentAuthorLabel?: string
  requiredScopes: string[]
  /** People who read it whatever they hold: an agent post whose disclosure the requester
   *  approved (scope-taint.ts, rule 11). Null or absent: none. */
  disclosureList?: string[] | null
  /** Extra row metadata (the approval an approved disclosure came from, rule 14). */
  metadata?: Record<string, unknown>
  /** The speaking agent (A8), when the caller knows it. See
   *  `resolveActingAgentIdForWrite`: an agent-authored row always names one. */
  agentId?: string | null
}

interface CreateThreadParams {
  orgId: string
  userId: string
  participantIds: string[]
  title?: string
  isPinned?: boolean
  /** A35: create the room already public. Only meaningful with a `title`; the
   *  public Zod refuses the pair without one. */
  discoverable?: boolean
  createdFrom?: { app: string; entityType: string; entityId: string; actorId?: string }
  references?: Array<{ app: string; entityType: string; entityId: string }>
  initialMessage?: InitialMessageInput
  type?: "thread" | "agent_chat" | "approval"
  /** Escape hatch for the duplicate-thread guard: create a SECOND plain thread
   *  for a participant set that already has one. A person's own "new
   *  conversation" action passes it; an agent's call that carries it is gated
   *  (a person approves the new conversation, `agentCreateOpensNewConversation`). */
  forceCreate?: boolean
}

/**
 * Raised when a plain thread is requested for a participant set that already has
 * one. Carries the existing thread so the caller can post there instead — which
 * is nearly always what was actually wanted.
 *
 * Why this exists: an UNTITLED thread already deduped to the existing one, but
 * passing a `title` skipped the check entirely and silently opened a second
 * conversation with the same person. That split a teammate's history across two
 * threads and buried the message where they do not look (prod, 2026-08-02). A
 * duplicate is now refused unless the caller explicitly asks for one.
 */
export class DuplicateThreadError extends Error {
  readonly code = "duplicate_thread"
  readonly status = 409
  constructor(readonly existing: { id: string; handle: string; title: string | null }) {
    super(
      `These participants already have a thread (${existing.handle}${
        existing.title ? `: "${existing.title}"` : ""
      }). Reply in that thread (id ${existing.id}) if your message fits there; otherwise ` +
        "ask the user where to post it (that thread, another existing one, or a new " +
        "conversation). Never retry with forceCreate on your own judgement: only the user " +
        "can ask for a new conversation.",
    )
    this.name = "DuplicateThreadError"
  }
}

interface ListThreadsParams {
  orgId: string
  userId: string
  limit: number
  cursor?: string
  archived?: boolean
  unreadOnly?: boolean
}

interface GetThreadParams {
  orgId: string
  userId: string
  threadId: string
}

interface UpdateThreadParams {
  orgId: string
  userId: string
  threadId: string
  scopes: string[]
  changes: {
    title?: string
    isPinned?: boolean
    /** A35: publish (true) or unpublish (false) a titled channel. Refused on a
     *  room with no title — a DM is never discoverable. */
    discoverable?: boolean
    /** The one line beside the channel name. `null` clears it. Refused on a
     *  room with no title, exactly as `discoverable` is: a DM has no topic. */
    topic?: string | null
    /** The standing "what is this channel", shown in the channel details.
     *  `null` clears it. Same titled-channel rule as `topic`. */
    description?: string | null
    type?: "thread" | "agent_chat" | "approval"
    agentModelId?: string | null
    agentReasoningLevels?: Record<string, string>
    /**
     * Promote (false) or demote (true) the thread in the global thread list.
     * Used by entity-embedded threads (task discussion, etc.) — flipping to
     * `false` surfaces the thread in the user's sidebar; flipping back to
     * `true` returns it to entity-only visibility.
     */
    hiddenFromList?: boolean
  }
}

/**
 * `discoverable` asked for on a room that is not a titled channel (A35). A 400
 * rather than a silent drop: the caller asked to publish a DM and has to learn
 * that a DM cannot be published.
 */
export class DiscoverableRequiresTitleError extends Error {
  status = 400
  code = "discoverable_requires_title"
  constructor(message = "Only a titled channel can be discoverable") {
    super(message)
  }
}

/**
 * `topic` or `description` asked for on a room that is not a titled channel. A
 * 400 rather than a silent drop, the reading `DiscoverableRequiresTitleError`
 * above already applies: the caller asked to describe a DM, and a DM is not a
 * thing that has a topic.
 */
export class ChannelDetailsRequireTitleError extends Error {
  status = 400
  code = "channel_details_require_title"
  constructor(message = "Only a titled channel can carry a topic or a description") {
    super(message)
  }
}

export class InvalidThreadTypeError extends Error {
  status = 400
  code = "invalid_thread_type"
  constructor(message = "Cannot modify approval thread type") {
    super(message)
  }
}

import { type Mention, parseMentions } from "~/lib/mentions"

/** Queue thread.create, participant.add, and message.create events in the transactional outbox. */
async function publishThreadCreatedEvents(
  db: RlsClient | RlsTx | PrivilegedDb,
  params: {
    thread: typeof threads.$inferSelect
    parts: Array<{ id: string; name: string | null; avatarUrl: string | null }>
    initialMsg?: typeof messages.$inferSelect
    mentionsList: Mention[]
    allParticipantIds: string[]
    orgId: string
    userId: string
  },
) {
  const { thread, parts, initialMsg, mentionsList, allParticipantIds, orgId, userId } = params

  await db.queueEvent({
    app: "kernel",
    entity: "thread",
    action: "create",
    entityId: thread.id,
    orgId,
    actorId: userId,
    data: {
      id: thread.id,
      type: thread.type,
      title: thread.title,
      handle: thread.handle,
      isPinned: thread.isPinned,
      createdFrom: thread.createdFrom,
      participantIds: allParticipantIds,
      participants: parts.map((p) => ({ id: p.id, name: p.name, avatarUrl: p.avatarUrl })),
    },
  })

  for (const p of parts) {
    await db.queueEvent({
      app: "kernel",
      entity: "participant",
      action: "add",
      entityId: thread.id,
      orgId,
      actorId: userId,
      data: { threadId: thread.id, userId: p.id, userName: p.name },
    })
  }

  if (initialMsg) {
    const agentLabel = (initialMsg.metadata as { agentAuthorLabel?: string } | null)
      ?.agentAuthorLabel
    const authorName =
      initialMsg.authorType === "agent"
        ? await resolveAgentAuthorName(db, {
            orgId,
            authorAgentId: initialMsg.authorAgentId,
            agentAuthorLabel: agentLabel,
          })
        : (parts.find((p) => p.id === userId)?.name ?? "Unknown")
    await db.queueEvent({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: initialMsg.id,
      orgId,
      actorId: userId,
      data: {
        id: initialMsg.id,
        threadId: thread.id,
        authorId: userId,
        authorName,
        authorType: initialMsg.authorType,
        content: initialMsg.content,
        mentions: mentionsList.length > 0 ? mentionsList : null,
        metadata: initialMsg.metadata ?? null,
        // Both facts come off the row itself, which is in hand here as a full
        // select. The insert above sets no disclosure list, so it is null today
        // and a null is correct rather than missing; taking it from the row
        // means this event stays right without depending on that staying true.
        ...messageVisibilityFacts(initialMsg),
        createdAt: initialMsg.createdAt.toISOString(),
      },
    })
  }
}

interface InsertThreadWithParticipantsParams {
  /** A caller-derived id, for a thread that exists at most once per key. Default: a random one. */
  id?: string
  orgId: string
  userId: string
  participantIds: string[]
  title: string | null
  isPinned: boolean
  discoverable?: boolean
  createdFrom: { app: string; entityType: string; entityId: string; actorId?: string } | null
  references?: Array<{ app: string; entityType: string; entityId: string }>
  initialMessage?: InitialMessageInput
  type?: "thread" | "agent_chat" | "approval"
  /** Keep the row out of every sidebar list (`listThreads` filters on
   *  `NOT t.hidden_from_list`). Used by anchors that exist only so a row has
   *  somewhere to point: the approval anchors, the MCP connection anchor. */
  hiddenFromList?: boolean
}

/** Shared helper: validate participants, insert thread + participants + state + initial message, queue events.
 *  Accepts `RlsTx` from RLS-scoped callers and `PrivilegedDb` from `withPrivilegedDb` callers. */
export async function insertThreadWithParticipants(
  tx: RlsTx | PrivilegedDb,
  params: InsertThreadWithParticipantsParams,
) {
  const {
    orgId,
    userId,
    participantIds,
    title,
    isPinned,
    createdFrom,
    references,
    initialMessage,
  } = params

  // Checked before anything is written, so a missing value leaves no thread behind.
  if (initialMessage) assertExplicitRequiredScopes(initialMessage.requiredScopes)

  // A35: a titled room is a channel and a channel's handle is its name. A row
  // hidden from every list (an approval or MCP connection anchor) is no room
  // anyone links to, and its fixed title would make concurrent creators race
  // for one slug: it draws from the sequence, which is atomic.
  const handle = await allocateThreadHandle(tx, {
    orgId,
    title: params.hiddenFromList ? null : title,
  })

  // Verify all participants belong to this org and are active
  const validUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(inArray(users.id, participantIds), eq(users.orgId, orgId), eq(users.status, "active")),
    )
  if (validUsers.length !== participantIds.length) {
    throw new HTTPException(400, {
      message: "One or more participants are invalid or belong to a different organization",
    })
  }

  // Insert thread without RETURNING — RLS SELECT policy requires participant
  // membership, but participants don't exist yet (chicken-and-egg).
  // Generate ID in JS, insert participants, then SELECT the thread back.
  const threadId = params.id ?? crypto.randomUUID()
  await tx.insert(threads).values({
    id: threadId,
    orgId,
    handle,
    title,
    isPinned,
    // Never on an untitled row: a DM the whole workspace can find is the one
    // thing `discoverable` must not be able to produce.
    discoverable: title ? (params.discoverable ?? false) : false,
    createdFrom,
    createdBy: userId,
    type: params.type ?? "thread",
    hiddenFromList: params.hiddenFromList ?? false,
  })

  // Insert creator first (self-insert allowed by tp_insert RLS policy),
  // then other participants (existing-participant check passes after creator is inserted)
  await tx.insert(threadParticipants).values({ threadId, userId, orgId, role: "admin" })
  const otherIds = participantIds.filter((uid) => uid !== userId)
  if (otherIds.length > 0) {
    await tx
      .insert(threadParticipants)
      .values(otherIds.map((uid) => ({ threadId, userId: uid, orgId, role: "member" as const })))
  }

  // Initialize user_thread_state for all participants
  await tx.insert(userThreadState).values(
    participantIds.map((uid) => ({
      userId: uid,
      threadId,
      orgId,
    })),
  )

  // SELECT thread back — works under RLS now that creator is a participant
  const [thread] = await tx.select().from(threads).where(eq(threads.id, threadId))

  // Insert references if any
  if (references?.length) {
    await tx.insert(threadReferences).values(
      references.map((ref) => ({
        threadId: thread.id,
        orgId,
        app: ref.app,
        entityType: ref.entityType,
        entityId: ref.entityId,
        addedBy: userId,
      })),
    )
  }

  // Get participant details
  const parts = await tx
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, participantIds))

  // Insert initial message if provided
  let initialMsg: typeof messages.$inferSelect | undefined
  let mentionsList: Mention[] = []
  if (initialMessage) {
    mentionsList = parseMentions(initialMessage.content)
    const initialAuthorType = initialMessage.authorType ?? "user"
    const initialAuthorAgentId = await resolveActingAgentIdForWrite(tx, {
      orgId,
      userId,
      authorType: initialAuthorType,
      agentId: initialMessage.agentId,
    })
    const [msg] = await tx
      .insert(messages)
      .values({
        threadId: thread.id,
        orgId,
        authorId: userId,
        authorType: initialAuthorType,
        authorAgentId: initialAuthorType === "agent" ? initialAuthorAgentId : null,
        // Masked before the row and the thread-created event read it.
        content: maskWithNote(initialMessage.content).text,
        mentions: mentionsList.length > 0 ? mentionsList : null,
        metadata: agentPostMetadata(
          initialAuthorType,
          initialMessage.agentAuthorLabel,
          initialMessage.metadata,
        ),
        // Never a grant wildcard (scope-taint.ts, rule 10b), as sendMessage stamps.
        requiredScopes: expandWildcardStamp(initialMessage.requiredScopes, orgId),
        disclosureList: initialMessage.disclosureList ?? null,
      })
      .returning()
    initialMsg = msg
  }

  // Queue events inside the transaction — they commit atomically with the data
  await publishThreadCreatedEvents(tx, {
    thread,
    parts,
    initialMsg,
    mentionsList,
    allParticipantIds: participantIds,
    orgId,
    userId,
  })

  return { thread, parts, initialMsg }
}

function formatNewThread({
  thread,
  parts,
  initialMsg,
}: {
  thread: typeof threads.$inferSelect
  parts: Array<{ id: string; name: string | null; avatarUrl: string | null }>
  initialMsg?: typeof messages.$inferSelect
}) {
  return {
    id: thread.id,
    handle: thread.handle,
    title: thread.title,
    isPinned: thread.isPinned,
    discoverable: thread.discoverable,
    createdFrom: thread.createdFrom,
    participants: parts.map((p) => ({ id: p.id, name: p.name, avatarUrl: p.avatarUrl })),
    initialMessageId: initialMsg?.id,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    deduplicated: false,
  }
}

/**
 * The existing PLAIN thread for an exact participant set (titled or not), or
 * null. Mirrors the dedup query below, minus the `title IS NULL` clause and the
 * D23 no-agent-seat clause (a titled duplicate is refused on its PEOPLE) — the
 * point is precisely to see a titled thread the dedup path would miss.
 */
async function findPlainThreadForParticipants(
  db: RlsClient,
  params: { orgId: string; userId: string; participantIds: string[] },
): Promise<{ id: string; handle: string; title: string | null } | null> {
  const allIds = Array.from(new Set([params.userId, ...params.participantIds])).sort()
  const sch = drizzleSql.raw(schemaRef("kernel"))
  const idList = drizzleSql.join(
    allIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  const rows = await db.execute(drizzleSql`
    SELECT t.id, t.handle, t.title
    FROM ${sch}.threads t
    WHERE t.org_id = ${params.orgId}
      AND t.type = 'thread'
      AND t.created_from IS NULL
      AND t.is_pinned = false
      AND (
        -- HUMANS: an agent seat is a member, never a party to the conversation
        -- this guard is about (P4b H2).
        SELECT COUNT(*) FROM ${sch}.thread_participants tp
        WHERE tp.thread_id = t.id AND tp.participant_type = 'user'
      ) = ${allIds.length}
      AND (
        SELECT COUNT(*) FROM ${sch}.thread_participants tp
        WHERE tp.thread_id = t.id AND tp.user_id IN (${idList})
      ) = ${allIds.length}
    ORDER BY t.updated_at DESC
    LIMIT 1
  `)
  const row = rows[0] as { id: string; handle: string; title: string | null } | undefined
  return row ?? null
}

/**
 * The untitled DM between exactly these people (the requester included in
 * `allIds`, sorted): what an untitled plain create lands in instead of opening
 * a new thread. Shared by createThread's dedup and the agent gate.
 */
/** The untitled plain thread of exactly these people (an untitled create lands in it). */
export function untitledDmQuery(orgId: string, allIds: string[]) {
  const sch = drizzleSql.raw(schemaRef("kernel"))
  const idList = drizzleSql.join(
    allIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  return drizzleSql`
    SELECT t.id, t.handle, t.title, t.is_pinned, t.created_from, t.created_at, t.updated_at
    FROM ${sch}.threads t
    WHERE t.org_id = ${orgId}
      AND t.type = 'thread'
      AND t.title IS NULL
      AND t.created_from IS NULL
      AND t.is_pinned = false
      -- A discoverable room is no direct message, whoever sits in it (scope-taint.ts, 14c).
      AND t.discoverable = false
      AND (
        SELECT COUNT(*) FROM ${sch}.thread_participants tp
        WHERE tp.thread_id = t.id AND tp.participant_type = 'user'
      ) = ${allIds.length}
      -- D23a (2026-10-12, refines D23): the DM between these people is
      -- identified by THEM. An agent added on purpose (a person added to
      -- someone's agent chat, an agent added with "Add people") makes the
      -- room a group conversation, so "message this person" opens a fresh
      -- 1:1 instead. An agent an @mention seated does not (the people
      -- were talking in their DM and asked it something), nor does a
      -- GUEST seat (a turn in flight, never announced to the room). The
      -- same rule as seatMakesGroupOfDm in @liaison/shared, which the web
      -- applies to its own copy of the rooms (dm-dedupe.ts).
      AND NOT EXISTS (
        SELECT 1 FROM ${sch}.thread_participants tp
        WHERE tp.thread_id = t.id AND tp.participant_type = 'agent'
          AND tp.role <> ${AGENT_GUEST_SEAT_ROLE}
          AND tp.seat_origin IS DISTINCT FROM ${MENTION_SEAT_ORIGIN}
      )
      AND (
        SELECT COUNT(*) FROM ${sch}.thread_participants tp
        WHERE tp.thread_id = t.id AND tp.user_id IN (${idList})
      ) = ${allIds.length}
    -- Twins (an old room and a fresh one): the one last active, as the web picks.
    ORDER BY t.updated_at DESC, t.id
    LIMIT 1
  `
}

/**
 * Whether an AGENT's threads_create call would open a NEW conversation the user
 * did not necessarily ask for, and so needs a person's approval (kernel-tools
 * `gatedWhen`): any `forceCreate`; a titled create, unless it would be refused
 * as a duplicate anyway (the duplicate_thread error then points at the
 * existing thread); an untitled create with two or more other people that
 * finds no existing conversation between exactly them. An untitled create that
 * lands in an existing thread, or opens a 1:1 DM, is not a new conversation.
 */
export async function agentCreateOpensNewConversation(
  db: RlsClient | PrivilegedDb,
  params: {
    orgId: string
    userId: string
    participantIds: string[]
    title?: string
    forceCreate?: boolean
    references?: ReadonlyArray<unknown>
  },
): Promise<boolean> {
  if (params.forceCreate === true) return true
  const others = Array.from(new Set(params.participantIds)).filter((id) => id !== params.userId)
  const title = typeof params.title === "string" ? params.title.trim() : ""
  if (title !== "") {
    // A titled plain create for people who already share a thread is refused
    // (DuplicateThreadError) before anything is created: let that answer reach
    // the agent instead of asking a person to approve a call that would fail.
    if ((params.references?.length ?? 0) > 0 || others.length === 0) return true
    const existing = await findPlainThreadForParticipants(db as RlsClient, {
      orgId: params.orgId,
      userId: params.userId,
      participantIds: others,
    })
    return existing === null
  }
  if (others.length < 2) return false
  const allIds = Array.from(new Set([params.userId, ...others])).sort()
  const rows = await db.execute(untitledDmQuery(params.orgId, allIds))
  return rows.length === 0
}

/** The channel name rule (`normalizeChannelTitle`), for every caller: the route,
 *  agent tools, internal creators. Only a CHANNEL's title is a channel name: an
 *  agent chat titled "#1 priority" and a room anchored to an entity keep their
 *  title as written. A 400 when a channel name collapses to nothing. */
function normalizedTitleOrThrow<T extends string | undefined>(raw: T, isChannel: boolean): T {
  if (raw === undefined || raw === "" || !isChannel) return raw
  const name = normalizeChannelTitle(raw)
  if (name === "") {
    throw new HTTPException(400, {
      message: "A channel name needs at least one character besides # and spaces",
    })
  }
  return name as T
}

export async function createThread(db: RlsClient, params: CreateThreadParams) {
  const {
    orgId,
    userId,
    participantIds,
    isPinned,
    discoverable,
    createdFrom,
    references,
    initialMessage,
  } = params
  const title = normalizedTitleOrThrow(
    params.title,
    (params.type ?? "thread") === "thread" && !createdFrom && (references?.length ?? 0) === 0,
  )

  // A PLAIN thread: one between people, not anchored to an entity. Entity-anchored
  // threads (createdFrom: ticket, approval, mail conversations) are legitimately
  // one-per-entity and are never deduped or guarded. References do not anchor:
  // an untitled create that carries them is still the DM between these people.
  // The predicate itself lives in dm-shape.ts because the push fanout has to
  // read the same shape off a stored row.
  const isPlainThread = isPlainThreadShape({
    type: params.type ?? "thread",
    isPinned: isPinned === true,
    createdFrom: createdFrom ?? null,
    humanCount: participantIds.length,
  })

  // Untitled plain thread → dedupe silently (the UI's "message this person"
  // affordance relies on landing in the existing DM).
  const isDmCandidate = isPlainThread && !title

  // TITLED plain thread → the same participants already having a thread is a
  // mistake, not a new conversation: refuse it and point at the existing one.
  // `forceCreate` is the deliberate override. A titled room about entities
  // (references) is a topic room and stays allowed beside the DM.
  if (isPlainThread && title && (references?.length ?? 0) === 0 && !params.forceCreate) {
    const existing = await findPlainThreadForParticipants(db, {
      orgId,
      userId,
      participantIds,
    })
    if (existing) throw new DuplicateThreadError(existing)
  }

  if (isDmCandidate) {
    const allIds = Array.from(new Set([userId, ...participantIds])).sort()

    // One lock namespace for the whole kernel (db/advisory-lock.ts): concurrent
    // requests for the same participant set serialize, different sets proceed
    // in parallel, and the key cannot collide with another purpose's.
    const lockName = `thread-participants:${allIds.join(",")}`

    // Wrap dedup check + creation in a single Drizzle transaction with an advisory lock.
    // pg_advisory_xact_lock serializes concurrent requests for the same participant set
    // and auto-releases on commit/rollback.
    const txResult = await db.transaction(async (tx) => {
      // Serialize on the participant-set hash
      await tx.execute(advisoryXactLock(lockName))

      // Exact participant-set match: thread has exactly N participants AND all N are in our set.
      // The advisory lock on the same connection ensures atomicity: the lock was
      // acquired on this transaction's connection.
      const existing = await tx.execute(untitledDmQuery(orgId, allIds))

      if (existing.length > 0) {
        const row = existing[0] as {
          id: string
          handle: string
          title: string | null
          is_pinned: boolean
          created_from: unknown
          created_at: Date
          updated_at: Date
        }
        const parts = await tx
          .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
          .from(threadParticipants)
          .innerJoin(users, eq(users.id, threadParticipants.userId))
          .where(eq(threadParticipants.threadId, row.id))

        // Forward the initial message into the existing thread.
        // sendMessage runs its own transaction, so commit the lock first by returning,
        // then send the message outside.
        return {
          existingThread: {
            id: row.id,
            handle: row.handle,
            title: row.title,
            isPinned: row.is_pinned,
            createdFrom: row.created_from,
            participants: parts,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          deduplicated: true as const,
        }
      }

      // No existing thread — create one under the same advisory lock.
      // This prevents a concurrent request from also seeing "no match" and creating a duplicate.
      const { thread, parts, initialMsg } = await insertThreadWithParticipants(tx, {
        orgId,
        userId,
        participantIds: allIds,
        title: title ?? null,
        isPinned: false,
        createdFrom: null,
        references,
        initialMessage,
        type: params.type,
      })

      return {
        thread,
        parts,
        initialMsg,
        allParticipantIds: allIds,
        deduplicated: false as const,
      }
    })

    // Deduplicated path — attach the references, forward the message, return early
    if (txResult.deduplicated) {
      // Idempotent per (thread, entity): a reference the DM already carries is
      // only revisited.
      for (const ref of references ?? []) {
        await addReference(db, {
          orgId,
          userId,
          threadId: txResult.existingThread.id,
          app: ref.app,
          entityType: ref.entityType,
          entityId: ref.entityId,
        })
      }
      if (initialMessage?.content) {
        await sendMsg(db, {
          orgId,
          userId,
          threadId: txResult.existingThread.id,
          content: initialMessage.content,
          authorType: initialMessage.authorType ?? "user",
          agentAuthorLabel: initialMessage.agentAuthorLabel,
          agentId: initialMessage.agentId,
          requiredScopes: initialMessage.requiredScopes,
          disclosureList: initialMessage.disclosureList ?? null,
          ...(initialMessage.metadata ? { metadata: initialMessage.metadata } : {}),
        })
      }

      return {
        ...txResult.existingThread,
        deduplicated: true,
      }
    }

    // Events were queued inside the transaction above
    return formatNewThread(txResult)
  }

  // Non-DM path: no dedup needed, create directly
  const allParticipantIds = Array.from(new Set([userId, ...participantIds]))

  const result = await db.transaction(async (tx) => {
    return insertThreadWithParticipants(tx, {
      orgId,
      userId,
      participantIds: allParticipantIds,
      title: title ?? null,
      isPinned: isPinned ?? false,
      discoverable,
      createdFrom: createdFrom ?? null,
      references,
      initialMessage,
      type: params.type,
    })
  })

  return formatNewThread(result)
}

/**
 * THE ROWS THE MESSAGES LIST SHOWS, as a predicate on a thread aliased `t`.
 * One definition for the list (`listThreads`) and every count that badges it
 * (`computeUnreadMessageCount`: the Messages entry and `GET /threads/unread-count`; `computeBadgeCount`:
 * the app icon). A badge counting a thread the list never shows is a number
 * nobody can clear: routine output threads (type `routine`, read from the
 * agent's Routines tab), approval anchors and subruns are not Messages rows,
 * and their unread lit the badge for good (demo walk, 2026-10-12: 28 of 29).
 */
export function messagesListShows(k: ReturnType<typeof drizzleSql.raw>) {
  return drizzleSql`(
    -- An agent DM (P4b-D8) is a room like any other and belongs under Direct
    -- Messages, so agent_chat is in the list too, but only when it carries a
    -- real AGENT SEAT. A seatless agent_chat is the legacy 1:1 assistant
    -- chat, retired with the panel (P4c-T17, T47), and is a DM with
    -- nobody; keeping it out is what stops the old assistant history from
    -- appearing twice.
    (
      t.type = 'thread'
      OR (
        t.type = 'agent_chat'
        AND EXISTS (
          SELECT 1 FROM ${k}.thread_participants tps
          WHERE tps.thread_id = t.id AND tps.agent_id IS NOT NULL
        )
      )
    )
    AND NOT t.hidden_from_list
    AND NOT (
      t.created_from IS NOT NULL
      AND (
        -- HUMANS: an entity thread nobody but its agent sits in is still the
        -- solo thread this filter hides.
        SELECT COUNT(*)::int FROM ${k}.thread_participants tp3
        WHERE tp3.thread_id = t.id AND tp3.participant_type = 'user'
      ) <= 1
    )
  )`
}

// Complex query with json_agg, subqueries, unread counts — kept as raw SQL
// Uses db.execute() (Drizzle) so the query runs within the RLS transaction context.
export async function listThreads(db: RlsClient, params: ListThreadsParams) {
  const { orgId, userId, limit, cursor, archived, unreadOnly } = params
  const k = drizzleSql.raw(schemaRef("kernel"))

  const unreadOnlyFilter = unreadOnly
    ? drizzleSql`
      AND (
        SELECT COUNT(*)::int
        FROM ${k}.messages m
        WHERE m.thread_id = t.id
          AND m.deleted_at IS NULL
          -- A4: a reply the channel does not show is not channel news.
          AND (m.reply_root_id IS NULL OR m.also_in_channel)
          -- The reader's own words are never unread to them. Agent rows carry
          -- the same author_id (the person whose turn it is), so only a row
          -- the person wrote, or a system line their own action wrote (a
          -- compaction summary, a participant they added), is left out. Without this, a DM opened from "+"
          -- with its first message (no read mark yet) showed an unread pill
          -- for that message on the author's own sidebar.
          AND NOT (m.author_id = ${userId} AND m.author_type IN ('user', 'system'))
          AND ${notStatusLine()}
          AND m.created_at > COALESCE(
            (SELECT m2.created_at FROM ${k}.messages m2 WHERE m2.id = uts.last_read_message_id),
            '1970-01-01'::timestamptz
          )
      ) > 0
    `
    : drizzleSql``

  let baseQuery = drizzleSql`
    SELECT
      t.id, t.handle, t.title, t.type, t.is_pinned, t.tainted, t.discoverable,
      t.topic, t.description,
      t.created_from, t.created_at, t.updated_at,
      COALESCE(uts.is_muted, false) AS is_muted,
      COALESCE(uts.notify_all_posts, false) AS notify_all_posts,
      COALESCE(uts.is_pinned, false) AS is_pinned_by_user,
      (
        SELECT json_agg(p) FROM (
          SELECT json_build_object(
            'id', u.id, 'name', u.name, 'avatarUrl', u.avatar_url,
            'participantType', 'user', 'agentId', NULL
          ) AS p
          FROM ${k}.thread_participants tp2
          JOIN ${k}.users u ON u.id = tp2.user_id
          WHERE tp2.thread_id = t.id
          UNION ALL
          -- Agent seats read the same shape: the front end resolves the
          -- speaker from the row, never from a client-side sentinel.
          SELECT json_build_object(
            'id', a.id, 'name', a.display_name, 'avatarUrl', NULL,
            'participantType', 'agent', 'agentId', a.id,
            'role', tp2.role, 'seatOrigin', tp2.seat_origin
          ) AS p
          FROM ${k}.thread_participants tp2
          JOIN ${k}.agents a ON a.id = tp2.agent_id
          WHERE tp2.thread_id = t.id
        ) AS parts
      ) AS participants,
      (
        SELECT json_build_object(
          'content', m.content,
          'authorId', m.author_id,
          'authorName', u.name,
          'authorType', m.author_type,
          'authorAgentId', m.author_agent_id,
          'authorAgentName', lag.display_name,
          'authorAgentKind', lag.kind,
          'authorAgentOwnerName', lago.name,
          'agentAuthorLabel', m.metadata->>'agentAuthorLabel',
          'agentNotice', m.metadata->>'agentNotice',
          'systemType', CASE WHEN m.author_type = 'system' THEN m.metadata->>'type' END,
          'decision', CASE WHEN m.author_type = 'system' THEN m.metadata->>'decision' END,
          'reason', CASE WHEN m.author_type = 'system' THEN m.metadata->>'reason' END,
          'createdAt', m.created_at
        )
        FROM ${k}.messages m
        LEFT JOIN ${k}.users u ON u.id = m.author_id
        LEFT JOIN ${k}.agents lag ON lag.id = m.author_agent_id AND lag.org_id = m.org_id
        LEFT JOIN ${k}.users lago ON lago.id = lag.owner_user_id
        WHERE m.thread_id = t.id AND m.deleted_at IS NULL
          -- A4: the preview is the channel's last line, never a thread reply.
          AND (m.reply_root_id IS NULL OR m.also_in_channel)
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT COUNT(*)::int
        FROM ${k}.messages m
        WHERE m.thread_id = t.id
          AND m.deleted_at IS NULL
          -- A4: a reply the channel does not show is not channel news.
          AND (m.reply_root_id IS NULL OR m.also_in_channel)
          -- The reader's own words are never unread to them. Agent rows carry
          -- the same author_id (the person whose turn it is), so only a row
          -- the person wrote, or a system line their own action wrote (a
          -- compaction summary, a participant they added), is left out. Without this, a DM opened from "+"
          -- with its first message (no read mark yet) showed an unread pill
          -- for that message on the author's own sidebar.
          AND NOT (m.author_id = ${userId} AND m.author_type IN ('user', 'system'))
          AND ${notStatusLine()}
          AND m.created_at > COALESCE(
            (SELECT m2.created_at FROM ${k}.messages m2 WHERE m2.id = uts.last_read_message_id),
            '1970-01-01'::timestamptz
          )
      ) AS unread_count
    FROM ${k}.threads t
    JOIN ${k}.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${userId}
    LEFT JOIN ${k}.user_thread_state uts ON uts.thread_id = t.id AND uts.user_id = ${userId}
    WHERE t.org_id = ${orgId}
      AND ${messagesListShows(k)}
      AND COALESCE(uts.is_archived, false) = ${archived ?? false}
      ${unreadOnlyFilter}
  `

  if (cursor) {
    // Cursor format: "orgPinned|userPinned|timestamp|uuid"
    // Also supports legacy 3-part "0|timestamp|uuid" and 2-part "timestamp|uuid"
    const parts = cursor.split("|")
    let cursorOrgPinned: boolean
    let cursorUserPinned: boolean
    let cursorTime: string
    let cursorId: string
    if (parts.length === 4) {
      cursorOrgPinned = parts[0] === "1"
      cursorUserPinned = parts[1] === "1"
      cursorTime = parts[2]
      cursorId = parts[3]
    } else if (parts.length === 3) {
      cursorOrgPinned = parts[0] === "1"
      cursorUserPinned = false
      cursorTime = parts[1]
      cursorId = parts[2]
    } else if (parts.length === 2) {
      cursorOrgPinned = false
      cursorUserPinned = false
      cursorTime = parts[0]
      cursorId = parts[1]
    } else {
      throw new HTTPException(400, { message: "Invalid cursor format" })
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(cursorTime)) {
      throw new HTTPException(400, { message: "Invalid cursor format" })
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursorId)) {
      throw new HTTPException(400, { message: "Invalid cursor format" })
    }
    if (Number.isNaN(new Date(cursorTime).getTime())) {
      throw new HTTPException(400, { message: "Invalid cursor timestamp" })
    }
    // Sort is (is_pinned DESC, user_pinned DESC, updated_at DESC, id DESC).
    // Composite comparison across all four columns for correct page boundaries.
    baseQuery = drizzleSql`${baseQuery} AND (
      (t.is_pinned < ${cursorOrgPinned})
      OR (t.is_pinned = ${cursorOrgPinned} AND COALESCE(uts.is_pinned, false) < ${cursorUserPinned})
      OR (t.is_pinned = ${cursorOrgPinned} AND COALESCE(uts.is_pinned, false) = ${cursorUserPinned} AND t.updated_at < ${cursorTime}::timestamptz)
      OR (t.is_pinned = ${cursorOrgPinned} AND COALESCE(uts.is_pinned, false) = ${cursorUserPinned} AND t.updated_at = ${cursorTime}::timestamptz AND t.id < ${cursorId}::uuid)
    )`
  }

  baseQuery = drizzleSql`${baseQuery} ORDER BY t.is_pinned DESC, COALESCE(uts.is_pinned, false) DESC, t.updated_at DESC, t.id DESC LIMIT ${limit + 1}`

  const result = await db.execute(baseQuery)
  const rows = extractRows(result)

  const hasMore = rows.length > limit
  const threadRows = hasMore ? rows.slice(0, limit) : rows

  return {
    threads: threadRows.map((r: any) => ({
      id: r.id,
      handle: r.handle,
      title: r.title,
      // A35 (amended 2026-10-12): a titled row is a channel unless it is an
      // `agent_chat`, so the client cannot classify a row without its type.
      type: r.type,
      isPinned: r.is_pinned,
      isPinnedByUser: r.is_pinned_by_user ?? false,
      isMuted: r.is_muted ?? false,
      notifyAllPosts: r.notify_all_posts === true,
      tainted: r.tainted ?? false,
      // A channel: the sidebar groups Channels against Direct Messages on it.
      discoverable: r.discoverable ?? false,
      // Carried on the LIST row so the sidebar and the header agree the moment
      // the list loads, rather than after the thread read resolves.
      topic: r.topic ?? null,
      description: r.description ?? null,
      createdFrom: r.created_from,
      participants: r.participants ?? [],
      lastMessage: toLastMessage(r.last_message),
      unreadCount: r.unread_count ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    cursor: hasMore
      ? (() => {
          const last = threadRows[threadRows.length - 1] as any
          return `${last.is_pinned ? "1" : "0"}|${last.is_pinned_by_user ? "1" : "0"}|${new Date(last.updated_at).toISOString()}|${last.id}`
        })()
      : null,
    hasMore,
  }
}

/**
 * Every seat in a thread, human and agent, in one shape: `participantType`
 * names the kind and `agentId` names the agent behind an agent seat, so no
 * reader has to guess from an id (P4b H2). An agent seat carries the agent's
 * own id as `id` (agents have no avatar of their own, hence null).
 */
export async function readThreadParticipants(db: RlsClient, threadId: string) {
  const humans = await db
    .select({
      id: threadParticipants.userId,
      role: threadParticipants.role,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(threadParticipants)
    .innerJoin(users, eq(users.id, threadParticipants.userId))
    .where(eq(threadParticipants.threadId, threadId))
  const seats = await db
    .select({
      id: agents.id,
      role: threadParticipants.role,
      seatOrigin: threadParticipants.seatOrigin,
      name: agents.displayName,
      avatarColor: agents.avatarColor,
    })
    .from(threadParticipants)
    .innerJoin(agents, eq(agents.id, threadParticipants.agentId))
    .where(eq(threadParticipants.threadId, threadId))
  return [
    ...humans.map((h) => ({ ...h, participantType: "user" as const, agentId: null })),
    ...seats.map((a) => ({
      id: a.id,
      role: a.role,
      seatOrigin: a.seatOrigin,
      name: a.name,
      avatarUrl: null,
      // The disc's colour slot (0221), for an agent the viewer's directory
      // does not list (a colleague's personal agent seated in the room).
      avatarColor: a.avatarColor ?? null,
      participantType: "agent" as const,
      agentId: a.id,
    })),
  ]
}

/**
 * Every seat in a thread as the system sees it, including the ones hidden from
 * the caller: a check like "is this conversation private to the caller" must
 * count a participant the caller cannot see (nodes/import-tools.ts). Same
 * shape as `readThreadParticipants`; never returned to a client as is. Bound
 * to the org: a thread of another org (or none) has no seats here.
 */
export async function readThreadParticipantsAsSystem(
  orgId: string,
  threadId: string,
  reason: string,
) {
  return withPrivilegedDb(orgId, reason, async (tx) => {
    const [own] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1)
    if (!own) return []
    return readThreadParticipants(tx as never, threadId)
  })
}

/**
 * The caller's own personal agent (kind='personal', ownerUserId=userId),
 * for P4c-T04: `POST /threads/dm` without an explicit `agentId` falls back
 * to "my own Liaison assistant" instead of requiring the caller to look up
 * their own agent id first.
 *
 * Read-only and org/owner scoped, unlike `getOrCreatePersonalAgentId`
 * (modules/agent/directory/personal-agent.ts): a caller with no personal agent yet
 * (a legacy or test-seeded user whose bootstrap/invite flow never produced
 * one) is a 404 for this route, not a silent provisioning side effect of
 * opening a DM.
 */
export async function resolvePersonalAgentId(
  db: RlsClient,
  params: { orgId: string; userId: string },
): Promise<string | null> {
  const { orgId, userId } = params
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, orgId),
        eq(agents.ownerUserId, userId),
        eq(agents.kind, "personal"),
        isNull(agents.archivedAt),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/**
 * The requester's 1:1 chat with one agent: the existing one, or a new one
 * (P4b-D8, "Continue in a DM").
 *
 * IDEMPOTENT, and that is the whole point: the withheld card offers to move a
 * question out of a room, and pressing it twice must land in the same
 * conversation rather than scatter the history across a pile of empty DMs. So
 * an existing chat is RETURNED, never duplicated, and the answer says which of
 * the two happened.
 *
 * "1:1 with that agent" is read strictly: an `agent_chat` whose only human is
 * the requester and whose agent seat is this agent. A room with a second human
 * is not a DM however it started (adding a participant promotes an agent_chat
 * to a thread anyway), and a chat with a different agent is a different
 * conversation.
 *
 * Both seats are written: the human as the thread's admin, the agent as an
 * `agent` participant, so the DM looks like every other room to the read side
 * (participantType, agentId) instead of being a special case.
 */
export async function createOrGetAgentDm(
  db: RlsClient,
  params: { orgId: string; userId: string; agentId: string },
): Promise<{ id: string; handle: string; created: boolean } | null> {
  const { orgId, userId, agentId } = params
  // The lock below is transaction scoped, and outside a transaction block it is
  // released the instant it is taken: assert rather than trust the comment.
  assertTransactionScoped(db, "createOrGetAgentDm")
  const k = drizzleSql.raw(schemaRef("kernel"))

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  if (!agent) return null

  // Read-then-create is a race, and this is the one button in the product a
  // user double-clicks: two requests both found no DM and both made one, so the
  // idempotence promised above held only for a leisurely second press. The lock
  // is transaction-scoped (every RlsClient call runs inside one), keyed on the
  // exact triple that identifies this conversation, so two presses queue behind
  // each other and the second one reads the first one's row. It costs nothing
  // when there is no contention, and no migration: a partial unique index could
  // not express "exactly one human, and that human is this one".
  await db.execute(advisoryXactLock(`agent-dm:${orgId}:${userId}:${agentId}`))

  const existing = extractRows(
    await db.execute(drizzleSql`
      SELECT t.id, t.handle
      FROM ${k}.threads t
      JOIN ${k}.thread_participants me
        ON me.thread_id = t.id AND me.user_id = ${userId} AND me.org_id = ${orgId}
      JOIN ${k}.thread_participants seat
        ON seat.thread_id = t.id AND seat.agent_id = ${agentId} AND seat.org_id = ${orgId}
      WHERE t.org_id = ${orgId}
        AND t.type = 'agent_chat'
        AND (
          SELECT count(*) FROM ${k}.thread_participants tp
          WHERE tp.thread_id = t.id AND tp.org_id = ${orgId} AND tp.user_id IS NOT NULL
        ) = 1
        -- And exactly ONE agent, which the join above has already pinned to
        -- this one. Without it a room that grew a second agent seat (the
        -- viewer plus Liaison plus Support) still answered as "my DM with
        -- Liaison", so "Discuss this" posted into a group room the user never
        -- chose. A DM is 1:1 in both directions or it is not this DM.
        AND (
          SELECT count(*) FROM ${k}.thread_participants tp
          WHERE tp.thread_id = t.id AND tp.org_id = ${orgId} AND tp.agent_id IS NOT NULL
        ) = 1
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT 1
    `),
  ) as Array<{ id: string; handle: string }>
  if (existing[0]) return { ...existing[0], created: false }

  const thread = await seatAgentConversation(db, { orgId, userId, agentId })
  return { ...thread, created: true }
}

/** A new `agent_chat` between the requester and one agent, both seats written. */
async function seatAgentConversation(
  db: RlsClient,
  params: { orgId: string; userId: string; agentId: string },
): Promise<{ id: string; handle: string }> {
  const { orgId, userId, agentId } = params
  const thread = await createThread(db, {
    orgId,
    userId,
    participantIds: [userId],
    type: "agent_chat",
  })
  await addAgentParticipant(db, { orgId, threadId: thread.id, agentId, actorUserId: userId })
  return { id: thread.id, handle: thread.handle }
}

/**
 * The metadata of every DISCOVERABLE channel the user has not joined
 * (spec-home.md "Discoverable channels and read access"). Row metadata only:
 * handle, title and how many seats are taken. No `lastMessage`, no unread
 * count, no message content of any kind, because a channel has to be listable
 * before it can be joined and nothing else about it is readable until then.
 *
 * `participantCount` counts PEOPLE; `agentCount` counts agent seats
 * separately, so a reader never has to guess which the number means.
 *
 * `listThreads` is untouched: this is a second, narrower branch, not a widening
 * of the membership-gated list.
 */
export async function listDiscoverableChannels(
  db: RlsClient,
  params: { orgId: string; userId: string },
): Promise<
  Array<{
    id: string
    handle: string
    title: string | null
    /** The one line the unjoined row shows under the handle: on a channel
     *  nobody has joined yet, it is the only thing that says what it is for. */
    topic: string | null
    description: string | null
    participantCount: number
    agentCount: number
    agents: Array<{ id: string; handle: string; displayName: string }>
  }>
> {
  const { orgId, userId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows(
    await db.execute(drizzleSql`
      SELECT t.id, t.handle, t.title, t.topic, t.description
      FROM ${k}.threads t
      WHERE t.org_id = ${orgId}
        AND t.discoverable = true
        AND NOT t.hidden_from_list
        AND NOT EXISTS (
          SELECT 1 FROM ${k}.thread_participants tp
          WHERE tp.thread_id = t.id AND tp.user_id = ${userId} AND tp.org_id = ${orgId}
        )
      ORDER BY t.handle ASC
    `),
  ) as Array<{
    id: string
    handle: string
    title: string | null
    topic: string | null
    description: string | null
  }>
  if (rows.length === 0) return []

  // The seat COUNTS only, read with a privileged handle: thread_participants is
  // membership-gated (tp_select), and by definition the caller is not a member
  // of any thread in this list. Nothing but the two integers leaves this query,
  // and only for threads the caller's own RLS already returned above.
  const idList = drizzleSql.join(
    rows.map((r) => drizzleSql`${r.id}::uuid`),
    drizzleSql`, `,
  )
  const countRows = (await withPrivilegedDb(orgId, "discoverable-channel-seats", (tx) =>
    tx.execute(drizzleSql`
      SELECT tp.thread_id,
             COUNT(*) FILTER (WHERE tp.participant_type = 'user')::int AS humans,
             COUNT(*) FILTER (WHERE tp.participant_type = 'agent')::int AS agent_seats
      FROM ${k}.thread_participants tp
      WHERE tp.org_id = ${orgId} AND tp.thread_id IN (${idList})
      GROUP BY tp.thread_id
    `),
  )) as unknown as Array<{ thread_id: string; humans: number; agent_seats: number }>
  const counts = new Map(countRows.map((c) => [c.thread_id, c]))

  // The agents seated in each channel, by the same privileged handle and for
  // the same reason as the counts: the caller is not a member, so their own
  // RLS cannot see a seat row. IDENTITIES only, the three fields a channel row
  // renders (P4b-D7) -- an unjoined channel has to be able to say who runs it,
  // which a bare count never could. No message, no human roster, no ceiling.
  const agentRows = (await withPrivilegedDb(orgId, "discoverable-channel-agents", (tx) =>
    tx.execute(drizzleSql`
      SELECT tp.thread_id, a.id, a.handle, a.display_name
      FROM ${k}.thread_participants tp
      JOIN ${k}.agents a ON a.id = tp.agent_id AND a.org_id = tp.org_id
      WHERE tp.org_id = ${orgId} AND tp.thread_id IN (${idList})
        AND tp.participant_type = 'agent'
      ORDER BY a.handle ASC
    `),
  )) as unknown as Array<{
    thread_id: string
    id: string
    handle: string
    display_name: string
  }>
  const agentsByThread = new Map<
    string,
    Array<{ id: string; handle: string; displayName: string }>
  >()
  for (const row of agentRows) {
    const list = agentsByThread.get(row.thread_id) ?? []
    list.push({ id: row.id, handle: row.handle, displayName: row.display_name })
    agentsByThread.set(row.thread_id, list)
  }

  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    title: r.title,
    topic: r.topic ?? null,
    description: r.description ?? null,
    participantCount: counts.get(r.id)?.humans ?? 0,
    agentCount: counts.get(r.id)?.agent_seats ?? 0,
    // Always a list, never a missing key: "no agent in here" is an answer the
    // row must be able to give.
    agents: agentsByThread.get(r.id) ?? [],
  }))
}

/**
 * What a NON-member may know about a DISCOVERABLE channel it opened by id: the
 * same row `listDiscoverableChannels` hands out and not one field more. 0077
 * made the thread ROW readable org-wide so a channel can be listed and judged
 * before it is joined; the roster, who created it, which model it runs and
 * every per-user state flag are member facts, and none of them belong in an
 * answer to somebody who has not joined. Null when the thread is not a
 * discoverable channel of this org (the route answers 404, exactly as it does
 * for a private thread, so the endpoint never becomes an existence oracle).
 *
 * Callers MUST have established that the user is not a participant: a member
 * gets the full `getThread` shape.
 */
export async function getDiscoverableChannelProjection(
  db: RlsClient,
  params: GetThreadParams,
): Promise<{
  id: string
  handle: string
  title: string | null
  /** Carried here as well as on the list row: opening a channel by id must not
   *  answer with less than the list it was opened from. */
  topic: string | null
  description: string | null
  discoverable: true
  participantCount: number
  agentCount: number
  agents: Array<{ id: string; handle: string; displayName: string }>
} | null> {
  const { orgId, threadId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows(
    await db.execute(drizzleSql`
      SELECT t.id, t.handle, t.title, t.topic, t.description
      FROM ${k}.threads t
      WHERE t.id = ${threadId} AND t.org_id = ${orgId} AND t.discoverable = true
      LIMIT 1
    `),
  ) as Array<{
    id: string
    handle: string
    title: string | null
    topic: string | null
    description: string | null
  }>
  const row = rows[0]
  if (!row) return null

  // The seat COUNTS only, read with a privileged handle for the same reason
  // listDiscoverableChannels needs one: thread_participants is membership-gated
  // and the caller is, by construction, not a member. Two integers leave this
  // query, for a thread the caller's own RLS already returned above.
  const countRows = (await withPrivilegedDb(orgId, "discoverable-channel-seats", (tx) =>
    tx.execute(drizzleSql`
      SELECT COUNT(*) FILTER (WHERE tp.participant_type = 'user')::int AS humans,
             COUNT(*) FILTER (WHERE tp.participant_type = 'agent')::int AS agent_seats
      FROM ${k}.thread_participants tp
      WHERE tp.org_id = ${orgId} AND tp.thread_id = ${threadId}
    `),
  )) as unknown as Array<{ humans: number; agent_seats: number }>

  // The seated agents, by the same privileged handle and for the same reason
  // as the counts. The LIST row carries them (D7) so an unjoined channel can
  // say who runs it; opening that same channel by id has to answer with the
  // same fields, or the detail view is a downgrade of the list it came from.
  const agentRows = (await withPrivilegedDb(orgId, "discoverable-channel-agents", (tx) =>
    tx.execute(drizzleSql`
      SELECT a.id, a.handle, a.display_name
      FROM ${k}.thread_participants tp
      JOIN ${k}.agents a ON a.id = tp.agent_id AND a.org_id = tp.org_id
      WHERE tp.org_id = ${orgId} AND tp.thread_id = ${threadId}
        AND tp.participant_type = 'agent'
      ORDER BY a.handle ASC
    `),
  )) as unknown as Array<{ id: string; handle: string; display_name: string }>

  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    topic: row.topic ?? null,
    description: row.description ?? null,
    discoverable: true,
    participantCount: countRows[0]?.humans ?? 0,
    agentCount: countRows[0]?.agent_seats ?? 0,
    agents: agentRows.map((a) => ({
      id: a.id,
      handle: a.handle,
      displayName: a.display_name,
    })),
  }
}

/**
 * Where the agent's fed context resumes, for the reader (P4c-T51, A50).
 *
 * After a cold resume the chat still shows the whole conversation while the
 * agent is fed the brief plus the tail. This is the message that divergence
 * starts after: the `uptoMessageId` of the sole agent counterpart's current
 * checkpoint.
 *
 * Null on anything but a DM with exactly one agent: a channel seating several
 * agents has one checkpoint per agent and therefore no single boundary to
 * draw. Null too when that agent has no checkpoint yet, and when RLS refuses
 * the row, which is deliberate: a checkpoint this reader may not see is not a
 * boundary this reader is told about.
 */
export interface AgentContextBoundary {
  /** The last message the agent's checkpoint covers; the row sits after it. */
  uptoMessageId: string
  agentId: string
  agentName: string
  /** Messages after the boundary, so a first page can be sized to reach it. */
  messagesAfter: number
}

/**
 * The agent context boundary this thread draws, or null.
 *
 * IT IS NOT A DM-ONLY ROW. It used to require a SOLE agent counterpart
 * (`soleAgentCounterpart`), so a DM that had picked up a second agent by
 * mention could never draw it at all, and neither could a channel. Any thread
 * with a seated agent that has checkpointed has a boundary; when several agents
 * are seated the row names the one it belongs to, which is why the name travels
 * with the position instead of being re-derived by the view.
 *
 * The agent chosen is the one whose checkpoint is NEWEST: it is the agent whose
 * view of the conversation diverged most recently, and it is the only choice
 * that does not silently pick a boundary nobody is near.
 */
export async function readAgentContextBoundary(
  db: RlsClient,
  params: { threadId: string; orgId: string },
): Promise<AgentContextBoundary | null> {
  const { threadId, orgId } = params
  const rows = await db
    .select({
      uptoMessageId: agentThreadCheckpoints.uptoMessageId,
      agentId: agentThreadCheckpoints.agentId,
      agentName: agents.displayName,
    })
    .from(agentThreadCheckpoints)
    .innerJoin(agents, eq(agents.id, agentThreadCheckpoints.agentId))
    .innerJoin(
      threadParticipants,
      and(
        eq(threadParticipants.threadId, agentThreadCheckpoints.threadId),
        eq(threadParticipants.agentId, agentThreadCheckpoints.agentId),
      ),
    )
    .where(
      and(
        eq(agentThreadCheckpoints.orgId, orgId),
        eq(agentThreadCheckpoints.threadId, threadId),
        isNotNull(agentThreadCheckpoints.uptoMessageId),
      ),
    )
    .orderBy(desc(agentThreadCheckpoints.createdAt), desc(agentThreadCheckpoints.version))
    .limit(1)
  const row = rows[0]
  if (!row?.uptoMessageId) return null

  const k = drizzleSql.raw(schemaRef("kernel"))
  const countRows = extractRows(
    await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${k}.messages m
      WHERE m.thread_id = ${threadId} AND m.org_id = ${orgId} AND m.deleted_at IS NULL
        AND (m.created_at, m.id) > (
          (SELECT created_at FROM ${k}.messages WHERE id = ${row.uptoMessageId}),
          ${row.uptoMessageId}::uuid)`),
  )
  return {
    uptoMessageId: row.uptoMessageId,
    agentId: row.agentId,
    agentName: row.agentName,
    messagesAfter: Number((countRows[0] as { n?: number })?.n ?? 0),
  }
}

export async function getThread(db: RlsClient, params: GetThreadParams) {
  const { orgId, userId, threadId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))

  // Verify access: user must be participant. Also fetch per-user thread state.
  // Uses db.execute() so the query runs within the RLS transaction context.
  const result = await db.execute(drizzleSql`
    SELECT
      t.id, t.handle, t.title, t.type, t.is_pinned, t.tainted, t.discoverable, t.hidden_from_list,
      t.topic, t.description,
      t.agent_model_id, t.agent_reasoning_levels, t.created_from, t.created_by,
      t.created_at, t.updated_at,
      COALESCE(uts.is_muted, false) AS is_muted,
      COALESCE(uts.is_archived, false) AS is_archived,
      COALESCE(uts.is_pinned, false) AS is_pinned_by_user,
      COALESCE(uts.notify_all_posts, false) AS notify_all_posts
    FROM ${k}.threads t
    JOIN ${k}.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${userId}
    LEFT JOIN ${k}.user_thread_state uts ON uts.thread_id = t.id AND uts.user_id = ${userId}
    WHERE t.id = ${threadId} AND t.org_id = ${orgId}
    LIMIT 1
  `)
  const threadWithState = extractRows(result)

  if (threadWithState.length === 0) return null
  const row = threadWithState[0]

  const participants = await readThreadParticipants(db, threadId)

  // The seated agent's OWN default model. The composer's model chip needs it to
  // say what "Default" resolves to and to show which model is actually
  // answering when this conversation pins nothing.
  const agentSeatIds = participants
    .filter((p) => p.participantType === "agent")
    .map((p) => String(p.id))
  // On the demo's reserved App Review org every paid call runs on one pinned
  // model whatever the agent prefers (demo-spend.ts), so that is what
  // "Default" resolves to there; the chip said "Claude Haiku 4.5" while Gemini
  // answered (walk 2026-10-12). Null without a query on every other box.
  const pinnedModelId = agentSeatIds.length > 0 ? await reservedDemoModelId(orgId) : null
  // A default this org has no usable key for is not what answers: the turn
  // runner drops it to auto (usableDefaultModel), so "Default" says Auto too.
  const agentDefaultModelId =
    pinnedModelId ??
    (agentSeatIds.length > 0
      ? await usableDefaultModel(
          orgId,
          (
            await db
              .select({ modelPreference: agents.modelPreference })
              .from(agents)
              .where(and(eq(agents.id, agentSeatIds[0]), eq(agents.orgId, orgId)))
              .limit(1)
          )[0]?.modelPreference ?? null,
        )
      : null)

  const boundary = await readAgentContextBoundary(db, { threadId, orgId })
  const agentContextFrom = boundary?.uptoMessageId ?? null

  const refs = await db
    .select({
      id: threadReferences.id,
      app: threadReferences.app,
      entityType: threadReferences.entityType,
      entityId: threadReferences.entityId,
      addedBy: threadReferences.addedBy,
      createdAt: threadReferences.createdAt,
    })
    .from(threadReferences)
    .where(eq(threadReferences.threadId, threadId))
    .orderBy(asc(threadReferences.createdAt))

  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    type: row.type ?? "thread",
    isPinned: row.is_pinned,
    tainted: row.tainted ?? false,
    // A channel: org-wide listable and joinable, as opposed to a private
    // thread or a DM. The sidebar groups on this.
    discoverable: row.discoverable ?? false,
    // The Slack/Buzz pair. Null, never "", when the channel has not set one:
    // the header renders the line only when there is a line to render.
    topic: row.topic ?? null,
    description: row.description ?? null,
    hiddenFromList: row.hidden_from_list ?? false,
    agentModelId: row.agent_model_id ?? null,
    // The override's FALLBACK, not the effective model: the client shows
    // "Default (x)" with it and resolves the effective model as
    // `agentModelId ?? agentDefaultModelId`, exactly as the turn runner does.
    agentDefaultModelId,
    agentReasoningLevels: row.agent_reasoning_levels ?? {},
    // P4c-T51: the boundary the thread view draws, or null when there is no
    // single one to draw. Absent from the LISTING on purpose: it costs a query
    // per row and the sidebar has nowhere to put it.
    agentContextFrom,
    // The agent the boundary belongs to. It travels with the position: with
    // several agents seated the view cannot derive it, and deriving it from a
    // sole counterpart is what kept the row off every multi-agent thread.
    agentContextAgentId: boundary?.agentId ?? null,
    agentContextAgentName: boundary?.agentName ?? null,
    isPinnedByUser: row.is_pinned_by_user ?? false,
    createdFrom: row.created_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMuted: row.is_muted,
    isArchived: row.is_archived,
    // The reader's opt-in to be interrupted by every post of this channel.
    notifyAllPosts: row.notify_all_posts === true,
    participants,
    references: refs,
  }
}

export async function updateThread(db: RlsClient, params: UpdateThreadParams) {
  const { orgId, userId, threadId, scopes } = params
  const requested = params.changes

  // Org-wide pin/unpin requires admin scope — enforced here so both route and internal callers are guarded
  if (requested.isPinned !== undefined && !hasScope("kernel:threads:admin", scopes)) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  // Verify participant
  const [participant] = await db
    .select({ role: threadParticipants.role })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  // Title changes require thread-level admin role (creator or promoted participant).
  // Publishing the room is the same class of decision as naming it — it changes
  // what the room IS for the whole org — so it rides the same gate rather than a
  // weaker one.
  // The topic and the description ride the SAME gate as the rename and the
  // publish, for the same reason: all four change what the room presents itself
  // as to everyone in it, so none of them is a weaker decision than the others.
  if (
    (requested.title !== undefined ||
      requested.discoverable !== undefined ||
      requested.topic !== undefined ||
      requested.description !== undefined) &&
    participant.role !== "admin"
  ) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  // Shared-row settings (`type`, `hiddenFromList`, `agentModelId`) affect every
  // participant's view of the thread — `listThreads` filters on these columns, so
  // a plain member flipping `hiddenFromList` would hide the conversation for
  // everyone. Gate them behind thread-level admin role (creator or promoted
  // participant) or the org-wide `kernel:threads:admin` scope. Per-user hiding
  // belongs in `user_thread_state`, not these shared columns.
  const mutatesSharedSettings =
    requested.type !== undefined ||
    requested.hiddenFromList !== undefined ||
    requested.agentModelId !== undefined ||
    requested.agentReasoningLevels !== undefined
  if (
    mutatesSharedSettings &&
    participant.role !== "admin" &&
    !hasScope("kernel:threads:admin", scopes)
  ) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  // Approval threads are immutable from any path. Reject either a transition into 'approval'
  // (defense in depth — the public Zod also rejects this) or any change to an existing
  // approval thread.
  const [existing] = await db
    .select({
      type: threads.type,
      handle: threads.handle,
      title: threads.title,
      createdFrom: threads.createdFrom,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    .limit(1)
  if (!existing) return null
  if (existing.type === "approval" || requested.type === "approval") {
    throw new InvalidThreadTypeError()
  }
  // The channel name rule applies to a channel only: a room of type `thread`
  // (the type this request lands on) that no entity anchors.
  const changes = {
    ...requested,
    title: normalizedTitleOrThrow(
      requested.title,
      (requested.type ?? existing.type) === "thread" && existing.createdFrom == null,
    ),
  }

  // A35, the "channels only" half of the rule. A room is a channel when it has
  // a TITLE, so the check reads the title this request lands on (a rename and a
  // publish can arrive together) rather than the one on disk. An agent DM
  // (`agent_chat`) is a DM whatever its title carries (`classifyConversation`
  // rule 1), so it is refused here too.
  if (changes.discoverable !== undefined) {
    const nextTitle = changes.title !== undefined ? changes.title : existing.title
    if (existing.type !== "thread" || !nextTitle?.trim()) {
      throw new DiscoverableRequiresTitleError()
    }
  }

  // The same "channels only" rule for the Slack/Buzz pair, read off the title
  // this request LANDS on so a rename and a topic can arrive together. A `null`
  // counts: clearing the topic of a DM is still a claim that a DM has one.
  if (changes.topic !== undefined || changes.description !== undefined) {
    const nextTitle = changes.title !== undefined ? changes.title : existing.title
    if (existing.type !== "thread" || !nextTitle?.trim()) {
      throw new ChannelDetailsRequireTitleError()
    }
  }

  const setValues: Partial<typeof threads.$inferInsert> = { updatedAt: new Date() }
  if (changes.title !== undefined) {
    setValues.title = changes.title
    // A35: the handle of a room nobody hand-named follows its name, so
    // renaming #growth-experiments to "Growth lab" moves the handle with it.
    const renamed = await handleForRetitle({
      orgId,
      currentHandle: existing.handle,
      currentTitle: existing.title,
      nextTitle: changes.title,
    })
    if (renamed) setValues.handle = renamed
  }
  if (changes.isPinned !== undefined) setValues.isPinned = changes.isPinned
  if (changes.discoverable !== undefined) setValues.discoverable = changes.discoverable
  if (changes.topic !== undefined) setValues.topic = changes.topic
  if (changes.description !== undefined) setValues.description = changes.description
  if (changes.type !== undefined) setValues.type = changes.type
  if (changes.agentModelId !== undefined) setValues.agentModelId = changes.agentModelId
  if (changes.agentReasoningLevels !== undefined)
    setValues.agentReasoningLevels = changes.agentReasoningLevels
  if (changes.hiddenFromList !== undefined) setValues.hiddenFromList = changes.hiddenFromList

  const [updated] = await db
    .update(threads)
    .set(setValues)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    .returning({
      id: threads.id,
      handle: threads.handle,
      title: threads.title,
      isPinned: threads.isPinned,
      discoverable: threads.discoverable,
      topic: threads.topic,
      description: threads.description,
      agentModelId: threads.agentModelId,
      agentReasoningLevels: threads.agentReasoningLevels,
      createdFrom: threads.createdFrom,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
    })

  if (!updated) return null

  await db.queueEvent({
    app: "kernel",
    entity: "thread",
    action: "update",
    entityId: threadId,
    orgId,
    actorId: userId,
    data: { id: threadId, changes },
  })

  return updated
}

/**
 * The list row's last-message preview, labelled as the message list labels it. The SQL used
 * to name the author from `author_id` alone, and an agent reply keeps the REQUESTER there
 * (sendMessage), so the Home unread preview read "<the user's own name>: <the agent's
 * failure line>" (third QA walk). An agent row is named by the rule the thread view uses
 * (`agentAuthorDisplayName`), and the failure code (or, on a platform-written line, the
 * decision) it carries rides along so the preview renders it in the reader's language.
 */
function toLastMessage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as {
    content?: string | null
    authorId?: string
    authorName?: string | null
    authorType?: string
    authorAgentId?: string | null
    authorAgentName?: string | null
    authorAgentKind?: string | null
    authorAgentOwnerName?: string | null
    agentAuthorLabel?: string | null
    agentNotice?: string | null
    systemType?: string | null
    decision?: string | null
    reason?: string | null
    createdAt?: string
  }
  const isAgent = m.authorType === "agent"
  return {
    content: m.content ?? null,
    authorId: m.authorId,
    authorName: isAgent
      ? agentAuthorDisplayName({
          persistedLabel: m.agentAuthorLabel,
          liveAgentName: m.authorAgentName,
          liveAgentKind: m.authorAgentKind,
          liveAgentOwnerName: m.authorAgentOwnerName,
        })
      : (m.authorName ?? null),
    authorType: m.authorType ?? "user",
    authorAgentId: m.authorAgentId ?? null,
    ...(m.agentNotice ? { metadata: { agentNotice: m.agentNotice } } : {}),
    // A platform-written line (an approval withdrawn by its requester) is rebuilt in the
    // reader's language from these, as the thread view rebuilds it.
    ...(m.systemType === "approval-decision"
      ? {
          metadata: {
            type: m.systemType,
            decision: m.decision ?? null,
            reason: m.reason ?? null,
          },
        }
      : {}),
    createdAt: m.createdAt,
  }
}

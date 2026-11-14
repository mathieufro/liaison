// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `saas-knowledge-asks`: the software world's company knowledge scenario
// event. Clémence Roy, who joined support last month, asks Support Desk in
// #support about the refund policy the visitor just asked their own agent
// about. Her message is written and dispatched exactly as her own post would
// be (her RLS context, the one mention dispatch), so Support Desk's turn runs
// AS CLÉMENCE: her user id, her scopes, her roles and her grants. The refund
// policy is restricted to finance and admins, so the database gives the agent
// nothing about it, and its answer says so. Nothing in that answer is written
// here.
//
// The channel is created once per org (when the seed has no #support); the
// question is asked once per run of the scenario, so Start again asks again,
// in the same channel. The turn spends on the box key: the registry holds the
// beat until the visitor confirmed their email (`spends`).
import { SAAS_KNOWLEDGE_ASKS_INJECTOR } from "@liaison/shared"
import { and, eq, gte, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { sendMessage } from "~/modules/threads/message"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { createThread } from "~/modules/threads/thread"
import { worldActor, worldPersonId } from "~/seed/world/people"

/** The support teammate who asks (a seeded person of the demo company, support role). */
export const SAAS_KNOWLEDGE_ASKER = "Clémence Roy"
/** The seeded support agent he asks. */
export const SAAS_KNOWLEDGE_AGENT = "Support Desk"
/** The channel he asks in (shown as #support). */
export const SAAS_KNOWLEDGE_CHANNEL = "Support"
export const SAAS_KNOWLEDGE_QUESTION =
  "can a customer get a refund on a yearly plan, and who approves it?"

/** The message as Clémence writes it: the agent mention names Support Desk by id. */
export function saasKnowledgeMessage(agentId: string): string {
  return `@[${SAAS_KNOWLEDGE_AGENT}](agent:${agentId}) ${SAAS_KNOWLEDGE_QUESTION}`
}

async function supportDeskId(orgId: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-saas-knowledge-agent", (tx) =>
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.displayName, SAAS_KNOWLEDGE_AGENT),
          isNull(agents.archivedAt),
        ),
      )
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no ${SAAS_KNOWLEDGE_AGENT} agent in this org`)
  return row.id
}

async function findChannel(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-saas-knowledge-channel", (tx) =>
    tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.orgId, orgId), eq(threads.title, SAAS_KNOWLEDGE_CHANNEL)))
      .limit(1),
  )
  return row?.id ?? null
}

export const saasKnowledgeAsksInjector: WorldInjector = {
  id: SAAS_KNOWLEDGE_ASKS_INJECTOR,
  world: "saas",
  // Support Desk's turn runs on the box's model key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, runStartedAt }) {
    const askerId = await worldPersonId(orgId, SAAS_KNOWLEDGE_ASKER)
    const agentId = await supportDeskId(orgId)
    const asker = await worldActor(orgId, askerId)

    // The channel, once per org: Clémence opens it with the visitor in it.
    let channelId = await findChannel(orgId)
    if (!channelId) {
      channelId = await withRlsContext(asker, async (tx) => {
        const created = await createThread(tx, {
          orgId,
          userId: askerId,
          participantIds: [ownerUserId],
          title: SAAS_KNOWLEDGE_CHANNEL,
          discoverable: true,
          forceCreate: true,
        })
        return created.id
      })
    }

    const state = await withPrivilegedDb(orgId, "demo-world-saas-knowledge-read", async (tx) => {
      const [asked] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, channelId),
            eq(messages.authorId, askerId),
            gte(messages.createdAt, runStartedAt),
          ),
        )
        .limit(1)
      const seats = await tx
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(eq(threadParticipants.threadId, channelId))
      return {
        asked: Boolean(asked),
        seated: new Set(seats.map((s) => s.userId)),
      }
    })
    // Asked already in this run (a reload, a second pass): nothing more.
    if (state.asked) return
    // The channel predates this visitor's seat (another scenario left it): seat both.
    if (!state.seated.has(askerId) || !state.seated.has(ownerUserId)) {
      await withPrivilegedDb(orgId, "demo-world-saas-knowledge-seat", async (tx) => {
        for (const userId of [askerId, ownerUserId]) {
          if (state.seated.has(userId)) continue
          await tx
            .insert(threadParticipants)
            .values({ threadId: channelId, userId, orgId })
            .onConflictDoNothing()
        }
      })
    }

    // Clémence's own post, then the one mention dispatch, both as Clémence.
    const message = await withRlsContext(asker, (tx) =>
      sendMessage(tx, {
        orgId,
        userId: askerId,
        threadId: channelId,
        content: saasKnowledgeMessage(agentId),
        requiredScopes: [],
      }),
    )
    if (!message) throw new Error("demo world: Clémence could not post in #support")
    const { dispatchedAgentIds } = await dispatchForPostedMessage(
      (fn) => withRlsContext(asker, fn),
      {
        orgId,
        threadId: channelId,
        message,
        actor: {
          userId: askerId,
          orgId,
          scopes: asker.scopes,
          dimensionGrants: asker.dimensionGrants,
        },
      },
    )
    if (!dispatchedAgentIds.includes(agentId)) {
      throw new Error(`demo world: ${SAAS_KNOWLEDGE_AGENT} was not dispatched for Clémence`)
    }
  },
  // #support: the next beat opens it and waits for Support Desk's answer there.
  async entityOf({ orgId }) {
    return findChannel(orgId)
  },
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a conversation IS, in one place: a channel or a direct message.
//
// A35: "DM = between people, channels = named." (Amended 2026-10-12: a titled
// room is a channel whatever its membership; only an `agent_chat` keeps a
// title and stays a DM. See `classifyConversation`.) Before this module the Home
// sidebar grouped on `discoverable` alone, so a titled group thread that
// nobody could discover ("Q2 Marketing Plan") sat under DIRECT MESSAGES next
// to a two person chat. The rule the product now states, and the rule the DM
// shape used for push fanout states, have to be the SAME rule or the sidebar
// and the notification layer disagree about the same row.
//
// The facts are passed in because the callers hold them differently: the web
// sidebar has a store row and the signed in user's id, the API has create
// parameters or a database row. Nothing is read from anywhere here.
//
// Divergence worth naming: `apps/api/.../dm-shape.ts` answers a NARROWER
// question (is this row a dedupe target / a fanout-to-everyone room), so it
// excludes `agent_chat` and entity anchored rooms on purpose. This module
// answers a presentation question. Where the two overlap, a plain untitled
// human room and a titled human room, they must agree; that overlap is pinned
// by `dm-shape.agreement.test.ts`.

/** One seat, reduced to the two facts the rule needs. */
export interface ConversationSeat {
  id: string
  participantType: "user" | "agent"
}

export interface ConversationFacts {
  /** `kernel.threads.title`. A title makes a channel, except on an `agent_chat`. */
  title: string | null
  /** `kernel.threads.type`. `agent_chat` is people shaped whatever its title. */
  type: string
  /** True for a channel any org member can find and join. */
  discoverable: boolean
  participants: ConversationSeat[]
  /** The signed in user, so "the OTHER participants" can be computed. */
  currentUserId: string
}

export type ConversationKind =
  | { group: "channel"; visibility: "public" | "private" }
  | { group: "dm"; namedBy: "agent" | "people" }

/** Everyone in the room but the viewer. A room the viewer is not seated in
 *  (a discoverable channel read from the listing) yields all of its seats. */
export function otherSeats(facts: ConversationFacts): ConversationSeat[] {
  return facts.participants.filter((p) => p.id !== facts.currentUserId)
}

/** The single agent that NAMES a DM, or null when the room is not a 1:1 with
 *  an agent. Two agents in an untitled room is a people shaped room named by
 *  its people, not an agent DM with an arbitrary winner. A routine's output
 *  thread is never one: a hand-off (agents_ask) seats the asked agent beside
 *  the owner, and the routine's feed must keep its own name, not become a
 *  second "DM" with that agent that hides the real one. */
export function soleAgentCounterpart(facts: ConversationFacts): ConversationSeat | null {
  if (facts.type === "routine") return null
  const others = otherSeats(facts)
  const [only] = others
  if (others.length !== 1 || !only) return null
  return only.participantType === "agent" ? only : null
}

/**
 * The rule, in order.
 *
 *   1. an `agent_chat` (a room created as a DM with an agent, by
 *      `POST /threads/dm`) is a DM, named by its agent; its auto-title is
 *      never a channel name
 *   2. a titled room is a channel: public when discoverable, private otherwise,
 *      WHATEVER ITS MEMBERSHIP
 *   3. an untitled room is a DM, named by its agent when its only other seat
 *      is one, by its other participants otherwise
 *
 * 2026-10-12, A35 amended. Rule 1 used to read "a title makes a channel unless
 * the only other participant is an agent" (the mock's "Local session walk"
 * row). On demo that turned a channel the user created ("s11-cloud-walk") and
 * then seated their Personal agent in into a second "Personal agent" DM, which,
 * deduped by counterpart, took the real DM's slot and hid it. A channel never
 * takes a DM's slot: how a room was created, not who sits in it now, decides.
 */
export function classifyConversation(facts: ConversationFacts): ConversationKind {
  const agentSeat = soleAgentCounterpart(facts)
  if (facts.type === "agent_chat") {
    return { group: "dm", namedBy: agentSeat ? "agent" : "people" }
  }
  if (facts.title) {
    return { group: "channel", visibility: facts.discoverable ? "public" : "private" }
  }
  return { group: "dm", namedBy: agentSeat ? "agent" : "people" }
}

export function isChannelShape(facts: ConversationFacts): boolean {
  return classifyConversation(facts).group === "channel"
}

export function isDirectMessageShape(facts: ConversationFacts): boolean {
  return classifyConversation(facts).group === "dm"
}

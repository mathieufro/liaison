// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "chat" (pattern: ask your own agent beside what you are
 * reading, and read its sourced answer). A teammate asks the visitor a
 * question in a channel that needs fresh information from the web; the
 * visitor opens the channel and reads it, then asks their agent in their
 * conversation with it, opened from Chats in the dock beside the channel (the
 * agent reads the channel behind the dock), and it searches and answers with
 * its sources. The follow-up turns the answer into a task, and the agent then
 * answers Tobias in the channel with what it found and the task (only where
 * projects is installed).
 */
import { askAgentInRunConversation } from "../agent-steps"
import type { Tour, TourEventBinding } from "../schema"
import {
  approveHeldWrite,
  dockToRunConversation,
  hop,
  lastHop,
  PRODUCTS_CFG,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  taskCreatedBy,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

/** The channel Tobias asks in (what the question beat recorded). */
const CHANNEL_ROUTE = "/threads/{question}"

/**
 * The agent's own message in the channel Tobias asked in, written by the turn
 * answering `askBeat`'s message: a post by the person, by another turn or into
 * another thread does not count. A post held for approval (the conversation
 * read outside text, or data a reader of the channel cannot see) completes the
 * step once the person approved it: the approved call's message names the same
 * ask (`metadata.turnMessageId`).
 */
function channelPostBy(askBeat: string): TourEventBinding {
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    match: { threadId: "{question}", authorType: "agent" },
    actor: "user-or-agent",
    causedBy: askBeat,
  }
}

export function buildChatTour(cfg: ScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy ?? "chat")
  /** From Chats in the dock, beside the channel, to the person's conversation with their agent. */
  const toAgent = (last: string) => dockToRunConversation(k("askAgent.way1"), last)
  return scenarioTour("chat", cfg, {
    app: "kernel",
    demoOnly: true,
    // Every run asks the person's agent in their one conversation with it.
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    beats: [
      {
        id: "channels",
        kind: "show",
        title: k("channels.title"),
        body: k("channels.body"),
        role: k("channels.role"),
        anchor: "activity-messages",
        // The rail is desktop only: on a phone, the Chats tab (its screen is the list).
        anchorPhone: "phone-tab-chats",
        path: [railHop("Chats")],
        route: "/chats",
      },
      {
        id: "question",
        kind: "world",
        title: k("question.title"),
        body: k("question.body"),
        role: k("question.role"),
        // Records the channel, so the beats below open it.
        injector: cfg.injector ?? "chat-question",
        // Where it lands: that stays bright while the rest dims.
        anchor: "activity-messages",
        anchorPhone: "phone-tab-chats",
        route: "/chats",
      },
      {
        // His message, read in the channel before the visitor asks anyone.
        id: "read-question",
        kind: "show",
        title: k("readQuestion.title"),
        body: k("readQuestion.body"),
        role: k("readQuestion.role"),
        // The channel's first message is the one Tobias opened it with.
        anchor: "message-row[data-thread-id={question}]",
        path: [
          railHop("Chats"),
          hop(
            k("readQuestion.way2"),
            // The channel in the desktop sidebar; on a phone, its row on the Chats tab.
            "thread-item[data-thread-id={question}]",
            "chat-row[data-thread-id={question}]",
          ),
          lastHop(k("readQuestion.way3")),
        ],
        route: CHANNEL_ROUTE,
      },
      {
        id: "ask-agent",
        kind: "do",
        title: k("askAgent.title"),
        body: k("askAgent.body"),
        role: k("askAgent.role"),
        // The person's conversation with their agent, opened from the dock's
        // Chats beside the channel (the agent reads the channel behind the
        // dock); a phone opens it from the Chats tab. Already open in the dock,
        // its composer is ringed at once.
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("askAgent.say"), text: k("askAgent.text") },
        route: CHANNEL_ROUTE,
        // The visitor's own message to their agent, in their conversation with
        // it: a reply to the teammate in the channel does not complete it.
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askAgent.text")),
      },
      {
        id: "searching",
        kind: "show",
        title: k("searching.title"),
        body: k("searching.body"),
        role: k("searching.role"),
        // The agent's answer to this run's question, in the dock beside the
        // channel: its steps while it works, its web searches among them (a web
        // read runs at once, never waiting for an approval), then its reply.
        anchor: "agent-answer[data-turn-id={ask-agent}]",
        path: toAgent(k("searching.way3")),
        route: CHANNEL_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // The agent's turn shows its first tool once the model answered.
        waitsOn: "agent",
      },
      {
        id: "sources",
        kind: "show",
        title: k("sources.title"),
        body: k("sources.body"),
        role: k("sources.role"),
        // The links under this turn's answer: the web pages it cites.
        anchor: "message-citations[data-turn-id={ask-agent}]",
        path: toAgent(k("sources.way3")),
        route: CHANNEL_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // The sourced answer ends the research turn (about 100 s on a visitor's
        // model): Next stays off until its citations are on screen.
        waitsOn: "agent",
      },
      {
        // Typed or dictated (the mic beside Send): a separate "try the mic" step
        // made the dictated try-out count as this request, and the agent then
        // answered the try-out instead of creating the task.
        id: "follow-up",
        kind: "do",
        title: k("followUp.title"),
        body: k("followUp.body"),
        role: k("followUp.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("followUp.say"), text: k("followUp.text") },
        route: CHANNEL_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("followUp.text")),
        optional: { whenApp: "projects" },
      },
      {
        id: "task",
        kind: "do",
        title: k("task.title"),
        body: k("task.body"),
        role: k("task.role"),
        // The turn answering the follow-up, its tool calls, in the dock.
        anchor: "tool-call-row[data-turn-id={follow-up}]",
        path: toAgent(k("searching.way3")),
        route: CHANNEL_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // The task the agent's answer to that follow-up created: a task another
        // turn or another scenario's agent creates meanwhile does not count.
        // Its write may park for approval instead (a task, or a new project
        // holding it, which always asks first): the next step approves it.
        event: {
          ...taskCreatedBy("follow-up"),
          heldAs: ["projects:create", "projects:createProject"],
        },
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
        optional: { whenApp: "projects" },
      },
      // Only when the task's write asked first; a task created at once skips it.
      {
        ...approveHeldWrite("approve-task", "task", CHANNEL_ROUTE),
        optional: { whenApp: "projects" },
      },
      {
        // The agent answers Tobias where he asked, with its sources and the task.
        id: "reply-tobias",
        kind: "do",
        title: k("replyTobias.title"),
        body: k("replyTobias.body"),
        role: k("replyTobias.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("replyTobias.say"), text: k("replyTobias.text") },
        route: CHANNEL_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("replyTobias.text")),
        optional: { whenApp: "projects" },
      },
      {
        id: "posting",
        kind: "do",
        title: k("posting.title"),
        body: k("posting.body"),
        role: k("posting.role"),
        // The turn answering that request, its tool calls, in the dock.
        anchor: "tool-call-row[data-turn-id={reply-tobias}]",
        path: toAgent(k("searching.way3")),
        route: CHANNEL_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // Its message in #battery-passport, from that turn: recorded, so the
        // next step rings that very row.
        event: channelPostBy("reply-tobias"),
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
        optional: { whenApp: "projects" },
      },
      {
        id: "reply-in-channel",
        kind: "show",
        title: k("replyInChannel.title"),
        body: k("replyInChannel.body"),
        role: k("replyInChannel.role"),
        anchor: "message-row[data-message-id={posting}]",
        path: [
          railHop("Chats"),
          hop(
            k("readQuestion.way2"),
            "thread-item[data-thread-id={question}]",
            "chat-row[data-thread-id={question}]",
          ),
          lastHop(k("replyInChannel.way3")),
        ],
        route: CHANNEL_ROUTE,
        optional: { whenApp: "projects" },
      },
      {
        id: "done",
        kind: "show",
        title: k("done.title"),
        body: k("done.body"),
        role: k("done.role"),
      },
    ],
  })
}

export const scenarioChatTour = buildChatTour(PRODUCTS_CFG)

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "support" (pattern: an event routine per inbound ticket, then
 * an internal note plus one gated reply draft, then the person edits and
 * approves). A customer's ticket arrives live; the support routine reads it
 * and posts an internal note (verdict, sources, what a person must do) and a
 * reply draft in the customer's language; the visitor reviews the draft and
 * approves it (delivered to the fictional customer), then asks their agent
 * about the customer's history from the ticket: the ticket has no composer of
 * its own for that, so the chat dock opens beside it (the agent reads the
 * ticket behind the dock), and a phone asks from the Chats tab, naming the
 * customer.
 */
import { askAgentFromChatsTab, askAgentInDock } from "../agent-steps"
import type { Tour } from "../schema"
import {
  AGENT_CONVERSATION_EVENT,
  APPROVED_EVENT,
  approvedProposal,
  approveProposalSteps,
  hop,
  lastHop,
  PRODUCTS_CFG,
  RUN_CONVERSATION_ROW,
  RUN_CONVERSATION_ROW_PHONE,
  railHop,
  routineWorkOn,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  undoWindow,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

export function buildSupportTour(cfg: ScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy ?? "support")
  return scenarioTour("support", cfg, {
    app: "kernel",
    demoOnly: true,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["tickets"] },
    beats: [
      {
        id: "inbox",
        kind: "show",
        title: k("inbox.title"),
        body: k("inbox.body"),
        role: k("inbox.role"),
        anchor: "tickets-inbox",
        path: [railHop("Tickets")],
        route: "/tickets",
      },
      {
        id: "live-ticket",
        kind: "world",
        title: k("liveTicket.title"),
        body: k("liveTicket.body"),
        role: k("liveTicket.role"),
        injector: cfg.injector ?? "support-ticket",
        // Where the ticket lands: the list stays bright while the rest dims.
        anchor: "tickets-list",
        route: "/tickets",
      },
      {
        // The very ticket the live beat brought in, opened: not passed with
        // Next before it is open (walk D51). "Take me there" opens it; on the
        // list, its row is ringed, the way the person opens it themselves.
        id: "open",
        kind: "show",
        title: k("open.title"),
        body: k("open.body"),
        role: k("open.role"),
        anchor: "tickets-detail[data-ticket-id={live-ticket}]",
        path: [
          railHop("Tickets"),
          hop(k("open.way2"), "tickets-list-row-{live-ticket}", "tickets-card-{live-ticket}"),
        ],
        route: "/tickets/{live-ticket}",
      },
      {
        // The routine's note on this run's ticket: the beat waits for it, never
        // moving on while the ticket shows no note (it may come before the
        // person gets here, and is remembered then).
        id: "routine-note",
        kind: "do",
        title: k("routineNote.title"),
        body: k("routineNote.body"),
        role: k("routineNote.role"),
        // The routine's note itself, once it lands (it completes the step as it arrives).
        anchor: "tickets-message-*[data-kind=note]",
        route: "/tickets/{live-ticket}",
        event: routineWorkOn("tickets", "note", "create", { ticketId: "{live-ticket}" }),
        autoplay: WAIT_FOR_AGENT_STEPS,
      },
      {
        // The reply the routine drafted for this run's ticket, waiting for approval.
        id: "routine-draft",
        kind: "do",
        title: k("routineDraft.title"),
        body: k("routineDraft.body"),
        role: k("routineDraft.role"),
        // The reply's draft card, never another approval card on the page (the
        // note may have parked as one).
        anchor: "tickets-detail-approval-card[data-tool-name=tickets:reply]",
        route: "/tickets/{live-ticket}",
        event: routineWorkOn("kernel", "approval_request", "create", {
          toolName: "tickets:reply",
          "currentPayload.ticketId": "{live-ticket}",
        }),
        autoplay: WAIT_FOR_AGENT_STEPS,
      },
      {
        id: "approve",
        kind: "do",
        title: k("approve.title"),
        body: k("approve.body"),
        role: k("approve.role"),
        // The very draft the routine-draft beat saw proposed, by its id.
        anchor: "tickets-detail-approval-card[data-approval-id={routine-draft}]",
        route: "/tickets/{live-ticket}",
        // The very draft the routine-draft beat saw proposed, on this run's ticket.
        event: {
          ...approvedProposal("routine-draft"),
          match: {
            ...APPROVED_EVENT.match,
            toolName: "tickets:reply",
            "currentPayload.ticketId": "{live-ticket}",
          },
        },
        // The routine's draft card lands while its run still writes.
        waitsOn: "routine",
        autoplay: approveProposalSteps("routine-draft"),
        undo: undoWindow(k("approve.undo")),
      },
      {
        id: "sent",
        kind: "show",
        title: k("sent.title"),
        body: k("sent.body"),
        role: k("sent.role"),
        anchor: "tickets-conversation",
        route: "/tickets/{live-ticket}",
      },
      {
        id: "ask-agent",
        kind: "do",
        title: k("askAgent.title"),
        body: k("askAgent.body"),
        role: k("askAgent.role"),
        // The conversation with the person's own agent, reached from Chats
        // beside the ticket: each place on the way is ringed in turn.
        anchor: "compose-field[data-personal-agent=true]",
        path: [
          hop(k("askAgent.way1"), "dock-chats", "phone-tab-chats"),
          hop(k("askAgent.way2"), RUN_CONVERSATION_ROW, RUN_CONVERSATION_ROW_PHONE),
          lastHop("tours.scenarios.common.sendBelow"),
        ],
        say: { lead: k("askAgent.say"), text: k("askAgent.text") },
        route: "/tickets/{live-ticket}",
        event: AGENT_CONVERSATION_EVENT,
        autoplay: askAgentInDock(k("askAgent.text")),
        autoplayPhone: askAgentFromChatsTab(k("askAgent.text")),
      },
      {
        id: "answer",
        kind: "show",
        title: k("answer.title"),
        body: k("answer.body"),
        role: k("answer.role"),
        // The answer of the turn this run's question started, in the dock
        // beside the ticket: the scenario does not end before it is read.
        anchor: "agent-answer[data-turn-id={ask-agent}]",
        path: [
          hop(k("askAgent.way1"), "dock-chats", "phone-tab-chats"),
          hop(k("askAgent.way2"), RUN_CONVERSATION_ROW, RUN_CONVERSATION_ROW_PHONE),
          lastHop(k("answer.way3")),
        ],
        route: "/tickets/{live-ticket}",
        // Next stays off while the agent is still answering.
        waitsOn: "agent",
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

export const scenarioSupportTour = buildSupportTour(PRODUCTS_CFG)

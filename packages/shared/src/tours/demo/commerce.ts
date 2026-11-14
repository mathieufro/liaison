// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "commerce" (pattern: business events stay deterministic, the
 * agent takes the judgement steps around them as approvals). The shop's
 * orders, an order arriving live with a gift note, its invoice issued by the
 * order event itself (never by an agent), then the visitor asking the
 * Operations Desk (the org's agent holding the shipping, shop and invoicing
 * tools), from Chats in the dock beside the shop's orders, where the order
 * stands, and the desk preparing its shipment as an approval there.
 */
import { askAgentInRunConversation } from "../agent-steps"
import type { Tour } from "../schema"
import {
  approvedProposal,
  approveProposalSteps,
  hop,
  lastHop,
  PRODUCTS_CFG,
  proposedBy,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  undoWindow,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

const k = scenarioKey("commerce")

/** The shop's orders: the agent reads them behind the dock. */
const ORDERS_ROUTE = "/shopify/orders"

/**
 * From anywhere to the shop's orders: Shopify on the rail opens its home, so
 * the way goes on to Orders in its sidebar (a beat ringing an order row or
 * the list is otherwise stuck on the home, with no way shown).
 */
const toOrders = () => [railHop("Shopify"), hop(k("orders.way2"), "shopify-sidebar-link-orders")]

/** The org agent the scenario asks: it holds the shipping, shop and invoicing tools. */
const OPERATIONS_DESK = "@operations"

/** Its row in Agents (the dock's chats list, a phone's Chats tab), its DM started or not. */
const OPERATIONS_DESK_ROW = "chats-agent-row[data-agent-name=Operations Desk]"

/** From Chats in the dock, beside the orders, to the person's conversation with the Operations Desk. */
const toAgent = (last: string) => [
  hop(k("askAgent.way1"), "dock-chats", "phone-tab-chats"),
  hop(k("askAgent.way2"), OPERATIONS_DESK_ROW),
  lastHop(last),
]

export function buildCommerceTour(cfg: ScenarioCfg): Tour {
  return scenarioTour("commerce", cfg, {
    app: "kernel",
    demoOnly: true,
    // Every run asks the Operations Desk in the person's one conversation with it.
    talksToAgent: true,
    agent: OPERATIONS_DESK,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["shopify"] },
    beats: [
      {
        id: "orders",
        kind: "show",
        title: k("orders.title"),
        body: k("orders.body"),
        role: k("orders.role"),
        anchor: "shopify-orders-list",
        path: toOrders(),
        route: ORDERS_ROUTE,
      },
      {
        id: "live-order",
        kind: "world",
        title: k("liveOrder.title"),
        body: k("liveOrder.body"),
        role: k("liveOrder.role"),
        injector: "commerce-order",
        // Where the order lands: the list stays bright while the rest dims.
        anchor: "shopify-orders-list",
        path: toOrders(),
        route: ORDERS_ROUTE,
      },
      {
        // The order that just came in, ringed in the list before its invoice.
        id: "new-order",
        kind: "show",
        title: k("newOrder.title"),
        body: k("newOrder.body"),
        role: k("newOrder.role"),
        anchor: "shopify-orders-row-{live-order}",
        path: toOrders(),
        route: ORDERS_ROUTE,
      },
      {
        id: "invoice",
        kind: "show",
        title: k("invoice.title"),
        body: k("invoice.body"),
        role: k("invoice.role"),
        // The live order's own invoice row, once the invoicing app issued it
        // (seconds after the order lands): Next waits for it, so the desk is
        // never asked about an order whose invoice does not exist yet.
        anchor: "invoicing-documents-row[data-shopify-order-id={live-order}]",
        path: [railHop("Invoicing"), hop(k("invoice.way2"), "invoicing-sidebar-link-invoices")],
        route: "/invoicing/documents/invoices",
        optional: { whenApp: "invoicing" },
      },
      {
        id: "ask-agent",
        kind: "do",
        title: k("askAgent.title"),
        body: k("askAgent.body"),
        role: k("askAgent.role"),
        // The person's conversation with the Operations Desk, opened from the
        // dock's Chats beside the shop's orders (back from Invoices first); a
        // phone opens it from the Chats tab.
        anchor: RUN_COMPOSER_ANCHOR,
        path: [railHop("Shopify"), ...toAgent("tours.scenarios.common.sendBelow")],
        say: { lead: k("askAgent.say"), text: k("askAgent.text") },
        route: ORDERS_ROUTE,
        // The visitor's own message to the desk, in their conversation with it:
        // what the desk's next turn answers, and what the proposal below must
        // come from.
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askAgent.text")),
      },
      {
        id: "prepare",
        kind: "do",
        title: k("prepare.title"),
        body: k("prepare.body"),
        role: k("prepare.role"),
        // The card the turn answering this run's request raised, in the dock
        // beside the orders (the conversation holds earlier turns' cards too).
        anchor: "approval-card[data-turn-id={ask-agent}]",
        path: toAgent(k("prepare.way3")),
        route: ORDERS_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // The approval the agent's answer to that message proposed, nothing else.
        event: proposedBy("ask-agent", "boxtal:create_shipment"),
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
      },
      {
        id: "approve",
        kind: "do",
        title: k("approve.title"),
        body: k("approve.body"),
        role: k("approve.role"),
        // The very approval the prepare beat saw proposed, by its id.
        anchor: "approval-card[data-request-id={prepare}]",
        path: toAgent("tours.scenarios.common.held.way3"),
        route: ORDERS_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        event: approvedProposal("prepare"),
        // Its card comes with the agent's message, which may still be writing.
        waitsOn: "agent",
        autoplay: [{ openRunConversation: true }, ...approveProposalSteps("prepare")],
        undo: undoWindow(k("approve.undo")),
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

export const scenarioCommerceTour = buildCommerceTour(PRODUCTS_CFG)

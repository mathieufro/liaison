// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "money" (pattern: the payments app notices, the agent reads
 * across apps, the person approves, the outside world answers). A customer's
 * card failed and a reminder to them waits on Home for the visitor, who stands
 * in for the customer's away account manager. The visitor asks their agent
 * where the company stands with that customer (one card from the payments,
 * invoices, tickets and deals), opens the company, approves the reminder, then
 * the customer adds a new card (a world beat, no model spend) and the payments
 * home shows the figures moved, read from the same MRR query the page reads.
 *
 * Played once (`singleRun`): the recovered card cannot be undone, so the
 * scenario offers Start over, never Start again.
 */
import { askAgentInRunConversation } from "../agent-steps"
import type { Tour, TourStep } from "../schema"
import {
  APPROVED_EVENT,
  dockToRunConversation,
  hop,
  PAYMENTS_RAIL_APP,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  undoWindow,
} from "./shared"

/** What a world gives the money scenario on top of its world: its copy and its customer. */
export interface MoneyScenarioCfg extends ScenarioCfg {
  /** The copy namespace under `tours.scenarios` (`saasMoney`). */
  copy: string
  /** Where the reminder the visitor approves goes: the customer whose card failed. */
  reminderTo: string
  /** The world beat's injector: the customer adds a new card. */
  injector: string
}

/** Home, where the reminder waits. */
const HOME_ROUTE = "/"

/** The payments app's home, where the figures are. */
const PAYMENTS_ROUTE = "/stripe"

/**
 * The reminder's row on Home: the one decision the visitor holds for someone
 * away (`placement: standing_in`), the account manager of the customer.
 */
const STANDING_IN = { attr: "data-placement", value: "standing_in" } as const
export const MONEY_REMINDER_ROW = "attention-row-*[data-placement=standing_in]"
const MONEY_REMINDER_APPROVE = "approval-card-action-approve[data-placement=standing_in]"

/** "Do it for me": the reminder's row on Home, expanded, then Approve on its card. */
function approveReminderInHome(): TourStep[] {
  const row = { testid: "attention-row-*", where: STANDING_IN }
  const approve = { testid: "approval-card-action-approve", where: STANDING_IN }
  return [
    { waitFor: row },
    { click: row, unlessVisible: approve },
    { waitFor: approve },
    { click: approve },
    { waitEvent: true },
  ]
}

/** The tool the payments home reads its figures from: the last beat's copy names the same. */
export const MONEY_FIGURES_TOOL = "stripe:mrr_query"

export function buildMoneyTour(cfg: MoneyScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy)
  return scenarioTour("money", cfg, {
    app: "kernel",
    demoOnly: true,
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["stripe", "invoicing"] },
    beats: [
      {
        id: "card-failed",
        kind: "show",
        title: k("cardFailed.title"),
        body: k("cardFailed.body"),
        role: k("cardFailed.role"),
        anchor: MONEY_REMINDER_ROW,
        path: [railHop("Home")],
        route: HOME_ROUTE,
      },
      {
        id: "ask-standing",
        kind: "do",
        title: k("askStanding.title"),
        body: k("askStanding.body"),
        role: k("askStanding.role"),
        // The person's conversation with their agent, from Chats in the dock
        // beside Home; a phone opens it from the Chats tab.
        anchor: RUN_COMPOSER_ANCHOR,
        path: dockToRunConversation(k("askStanding.way1"), "tours.scenarios.common.sendBelow"),
        say: { lead: k("askStanding.say"), text: k("askStanding.text") },
        route: HOME_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askStanding.text")),
      },
      {
        // The answer of the turn this run's question started: one card, whose
        // Open goes to the company. Next stays off while the agent answers.
        id: "open-company",
        kind: "show",
        title: k("openCompany.title"),
        body: k("openCompany.body"),
        role: k("openCompany.role"),
        anchor: "agent-answer[data-turn-id={ask-standing}]",
        path: dockToRunConversation(k("askStanding.way1"), k("openCompany.way3")),
        route: HOME_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        waitsOn: "agent",
      },
      {
        // The reminder to the customer, approved on Home. Any reminder to the
        // same customer about a payments invoice completes it: one the visitor
        // rejected does not, and a new draft the agent writes after it does.
        id: "approve-note",
        kind: "do",
        title: k("approveNote.title"),
        body: k("approveNote.body"),
        role: k("approveNote.role"),
        anchor: MONEY_REMINDER_APPROVE,
        path: [railHop("Home"), hop(k("approveNote.way2"), MONEY_REMINDER_ROW)],
        route: HOME_ROUTE,
        event: {
          ...APPROVED_EVENT,
          match: {
            ...APPROVED_EVENT.match,
            toolName: "mail:compose",
            "currentPayload.to.0": cfg.reminderTo,
            "currentPayload.followUp.refs.0.kind": "stripe:invoice",
          },
        },
        autoplay: approveReminderInHome(),
        undo: undoWindow(k("approveNote.undo")),
      },
      {
        // The customer adds a new card: the payments app hears it as it would
        // from the processor. Nothing here spends on a model.
        id: "card-updated",
        kind: "world",
        title: k("cardUpdated.title"),
        body: k("cardUpdated.body"),
        role: k("cardUpdated.role"),
        injector: cfg.injector,
        anchor: "stripe-home",
        path: [railHop(PAYMENTS_RAIL_APP)],
        route: PAYMENTS_ROUTE,
      },
      {
        // The figures moved: its copy names them as the MRR query reads them now.
        id: "figures-moved",
        kind: "show",
        title: k("figuresMoved.title"),
        body: k("figuresMoved.body"),
        role: k("figuresMoved.role"),
        anchor: "stripe-mrr",
        path: [railHop(PAYMENTS_RAIL_APP)],
        route: PAYMENTS_ROUTE,
        figures: {
          tool: MONEY_FIGURES_TOOL,
          vars: {
            pastDue: { kind: "money", path: "lines.0.pastDueMinor", currency: "lines.0.currency" },
            mrr: { kind: "money", path: "lines.0.mrrMinor", currency: "lines.0.currency" },
          },
        },
      },
    ],
  })
}

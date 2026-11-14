// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "sales": the customer card on a conversation, a routine that
 * researches interested prospects, switched on by the visitor, then a
 * prospect's email arriving live. The routine works in order, in one run: it
 * checks the CRM, reads the sender's company site when they are new (a web
 * read runs without an approval), then prepares ONE request in Home, three
 * steps chained by @ref tokens: the CRM record, a quote that carries the
 * record's id, and the reply with the quote's PDF attached. The visitor opens
 * it, sees the three steps in order and approves once; the steps run in that
 * order, and the resumed run posts its summary in the visitor's chat with
 * their personal agent.
 */
import { RUN_CONVERSATION, type Tour, type TourStep } from "../schema"
import {
  APPROVED_EVENT,
  dockToRunConversation,
  hop,
  PRODUCTS_CFG,
  RUN_CONVERSATION_ROUTE,
  railHop,
  routineWorkOn,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  undoWindow,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

/** What the sales scenario takes from its world besides the base configuration. */
export interface SalesScenarioCfg extends ScenarioCfg {
  /** The seeded routine the scenario switches on (demo seed, prospect routine). */
  prospectRoutineName: string
  /**
   * The tools the one request's first step can run (its row on Home is found
   * by them). Default: the CRM record or the quote.
   */
  bundleHeadTools?: readonly string[]
}

export const PRODUCTS_SALES_CFG: SalesScenarioCfg = {
  ...PRODUCTS_CFG,
  prospectRoutineName: "Research interested prospects",
}

export const PROSPECT_ROUTINE_NAME = PRODUCTS_SALES_CFG.prospectRoutineName

/** The CRM write the routine proposes for a new prospect (its record, or a note on one). */
export const CRM_WRITE_TOOL = "api-connector:connector_write"

/** The quote, the request's first step when the prospect is already in the CRM. */
export const QUOTE_TOOL = "invoicing:quote_create_and_issue"

/** The tools the request's first step can run: the record, or the quote when no record is needed. */
const BUNDLE_HEAD_TOOLS = [CRM_WRITE_TOOL, QUOTE_TOOL] as const

/** The routine's reply draft: the request's last step. */
export const REPLY_TOOL = "mail:reply"

/**
 * WHERE THE ROUTINE'S REQUESTS ARE DECIDED: Home, where they wait together.
 * Approving them one by one in the chat (where each is a card too) was the
 * slow way (owner's walk 2026-10-27). Each step rings its request's row by the
 * tool it runs (`data-tool-name`, a list in order of preference), expands it
 * and presses Approve on that request's card, never on another one (walk
 * 2026-10-26: a bare Approve pressed the first card on screen).
 */
export const HOME_ROUTE = "/"

const homeRow = (tools: string | readonly string[]) =>
  `attention-row-*[data-tool-name=${typeof tools === "string" ? tools : tools.join("|")}]`

/** Wait for the request's row in Home, then open it unless its card is open already. */
const openInHome = (tools: readonly string[]): TourStep[] => {
  const value = [...tools]
  const row = { testid: "attention-row-*", where: { attr: "data-tool-name", value } }
  const card = { testid: "approval-card", where: { attr: "data-tool-name", value } }
  return [{ waitFor: row }, { click: row, unlessVisible: card }]
}

/** "Do it for me": the request's row in Home, expanded, then Approve on its card. */
const approveInHome = (tools: readonly string[]): TourStep[] => {
  const value = [...tools]
  const row = { testid: "attention-row-*", where: { attr: "data-tool-name", value } }
  const approve = {
    testid: "approval-card-action-approve",
    where: { attr: "data-tool-name", value },
  }
  return [
    { waitFor: row },
    { click: row, unlessVisible: approve },
    { waitFor: approve },
    { click: approve },
    { waitEvent: true },
  ]
}

export function buildSalesTour(cfg: SalesScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy ?? "sales")
  const routineName = cfg.prospectRoutineName
  const head = cfg.bundleHeadTools ?? BUNDLE_HEAD_TOOLS
  /** The request's expanded card in Home, and its Approve button. */
  const headCard = `approval-card[data-tool-name=${head.join("|")}]`
  const headApprove = `approval-card-action-approve[data-tool-name=${head.join("|")}]`
  /** From the Agents app to the person's own agent's Routines tab, each hop ringed. */
  const toOwnRoutines = (beat: string) => [
    railHop("Agents"),
    hop(k(`${beat}.way2`), "agent-sidebar-row-*[data-agent-mine=true]"),
    hop(k(`${beat}.way3`), "agent-page-tab-routines"),
  ]
  return scenarioTour("sales", cfg, {
    app: "kernel",
    demoOnly: true,
    // The routine's run lands in the person's one conversation with their agent
    // (its report conversation, routine-report.ts): the tour opens that chat.
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["mail"] },
    beats: [
      {
        id: "crm",
        kind: "show",
        title: k("crm.title"),
        body: k("crm.body"),
        role: k("crm.role"),
        anchor: "customer-card",
        path: [railHop("Mail"), hop(k("crm.way2"), "conversation-row")],
        route: "/mail",
        // The card shows next to an open conversation: open the first one.
        reach: [{ click: "conversation-row", unlessVisible: "customer-card" }],
      },
      {
        id: "routine",
        kind: "show",
        title: k("routine.title"),
        body: k("routine.body"),
        role: k("routine.role"),
        anchor: "routines-list",
        path: toOwnRoutines("routine"),
        route: "/agents/self/routines",
      },
      {
        id: "enable",
        kind: "do",
        title: k("enable.title"),
        body: k("enable.body"),
        role: k("enable.role"),
        anchor: "routines-list",
        route: "/agents/self/routines",
        // Switching on THIS routine, never another one: Next is no way past it.
        event: {
          app: "kernel",
          entity: "routine",
          action: "update",
          match: { enabled: true, name: routineName },
        },
        autoplay: [
          { waitFor: `routine-enable-toggle-${routineName}` },
          { click: `routine-enable-toggle-${routineName}`, unlessActive: true },
          { waitEvent: true },
        ],
      },
      {
        id: "live-email",
        kind: "world",
        title: k("liveEmail.title"),
        body: k("liveEmail.body"),
        role: k("liveEmail.role"),
        injector: cfg.injector ?? "sales-email",
        // Where it lands: that stays bright while the rest dims.
        anchor: "mail-inbox",
        path: [railHop("Mail")],
        route: "/mail",
      },
      {
        // The routine at work on the prospect's email: it checks the CRM, reads
        // the sender's site when they are new, then prepares its one request,
        // step by step. The step moves on when the request's LAST step (the
        // reply) is proposed by the routine this run switched on: the request is
        // then complete. A spinner shows meanwhile (`waitsOn`).
        id: "researching",
        kind: "do",
        title: k("researching.title"),
        body: k("researching.body"),
        role: k("researching.role"),
        event: routineWorkOn("kernel", "approval_request", "create", {
          toolName: REPLY_TOOL,
          "metadata.originRoutineId": "{enable}",
        }),
        waitsOn: "routine",
        autoplay: WAIT_FOR_AGENT_STEPS,
      },
      {
        // The one request, its row in Home. While the routine still works on it
        // (or works again on a corrected one after a failed step) the step shows
        // the spinner rather than an invitation to a row that is not there yet.
        id: "bundle",
        kind: "show",
        title: k("bundle.title"),
        body: k("bundle.body"),
        role: k("bundle.role"),
        anchor: homeRow(head),
        path: [railHop("Home")],
        route: HOME_ROUTE,
        waitsOn: "routine",
      },
      {
        // Opened: its three steps, in the order they run. Next waits for the open card.
        id: "bundle-steps",
        kind: "show",
        title: k("bundleSteps.title"),
        body: k("bundleSteps.body"),
        role: k("bundleSteps.role"),
        anchor: headCard,
        path: [railHop("Home"), hop(k("bundleSteps.way2"), homeRow(head))],
        route: HOME_ROUTE,
        reach: openInHome(head),
        waitsOn: "routine",
      },
      {
        // Approved once; the step completes when the LAST step, the reply on
        // the prospect's conversation this run injected, has run. A failed step
        // sends the run back to work (its spinner) and a corrected request comes
        // back to this row.
        id: "approve",
        kind: "do",
        title: k("approve.title"),
        body: k("approve.body"),
        role: k("approve.role"),
        anchor: headApprove,
        path: [railHop("Home"), hop(k("approve.way2"), homeRow(head))],
        route: HOME_ROUTE,
        event: {
          ...APPROVED_EVENT,
          match: {
            ...APPROVED_EVENT.match,
            toolName: REPLY_TOOL,
            "currentPayload.conversationId": "{live-email}",
          },
        },
        waitsOn: "routine",
        autoplay: approveInHome(head),
        undo: undoWindow(k("approve.undo")),
      },
      {
        // The routine's summary, posted at the end of its run in the person's
        // chat with their agent. Next waits until it is there.
        id: "brief",
        kind: "show",
        title: k("brief.title"),
        body: k("brief.body"),
        role: k("brief.role"),
        // The summary itself, the whole message, in the conversation it was posted to.
        anchor: `message-row[data-routine-report-thread={${RUN_CONVERSATION}}]`,
        path: dockToRunConversation(k("brief.way1"), k("brief.way3")),
        route: HOME_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        reach: [{ openRunConversation: true }],
        waitsOn: "routine",
      },
      {
        id: "card",
        kind: "show",
        title: k("card.title"),
        body: k("card.body"),
        role: k("card.role"),
        anchor: "customer-card",
        path: [
          railHop("Mail"),
          hop(k("card.way2"), "conversation-row[data-conversation-id={live-email}]"),
        ],
        route: "/mail/{live-email}",
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

export const scenarioSalesTour = buildSalesTour(PRODUCTS_SALES_CFG)

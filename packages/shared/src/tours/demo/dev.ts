// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "dev" (pattern: your agent sends coding work to a computer).
 * How Liaison codes for you, the visitor's connected computers (the recorded
 * "Demo laptop (recorded)", created when the scenario starts), the visitor
 * asking their agent for the recent bugs (the seeded "Firmware bugs" room),
 * then asking it to run the battery fix on that computer: the agent's own
 * `run_on_my_computer` call starts the recorded session there (the API's
 * modules/demo/replay). The visitor watches it, allows its one command, reads
 * the pull request and the agent's report, and is shown how to connect a
 * computer of their own.
 */
import { askAgentInRunConversation } from "../agent-steps"
import { RUN_CONVERSATION, type Tour } from "../schema"
import {
  approveHeldWrite,
  dockToRunConversation,
  hop,
  PRODUCTS_CFG,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

/** What the developer scenario takes from its world besides the base configuration. */
export interface DevScenarioCfg extends ScenarioCfg {
  /** The seeded team room the agent reads the recent bugs from (the seed reads it too). */
  bugsChannelTitle: string
}

/** The products world's developer scenario (apps/api/src/seed/tiers/demo/support-specs.ts seeds the room). */
export const PRODUCTS_DEV_CFG: DevScenarioCfg = {
  ...PRODUCTS_CFG,
  bugsChannelTitle: "Firmware bugs",
}

export const DEV_BUGS_CHANNEL_TITLE = PRODUCTS_DEV_CFG.bugsChannelTitle

/** Where the scenario stays: the person's sessions, the conversation beside them in the dock. */
const SESSIONS_ROUTE = "/sessions"

/** This run's session: where its permission request and result are, after a reload too. */
const THIS_RUN_SESSION_ROUTE = "/sessions/{dispatch}"

/** The session the agent's dispatch started for this run, in the sessions list. */
const THIS_RUN_SESSION = {
  testid: "session-row",
  created: { beat: "dispatch", attr: "data-id" },
} as const

/** The tool the agent hands the request to the computer with. */
const DISPATCH_TOOL = "kernel:run_on_my_computer"

export function buildDevTour(cfg: DevScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy ?? "dev")
  /** From Chats in the dock, beside Sessions, to the person's conversation with their agent. */
  const toAgent = (last: string) => dockToRunConversation(k("askBugs.way1"), last)
  return scenarioTour("dev", cfg, {
    app: "kernel",
    demoOnly: true,
    // Every run asks the person's agent in their one conversation with it.
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    beats: [
      {
        id: "intro",
        kind: "show",
        title: k("intro.title"),
        body: k("intro.body"),
        role: k("intro.role"),
      },
      {
        // The recorded laptop exists from the scenario's start (the API creates
        // it then), so it is listed before anything is sent to it.
        id: "computers",
        kind: "show",
        title: k("computers.title"),
        body: k("computers.body"),
        role: k("computers.role"),
        anchor: "node-line",
        path: [railHop("Sessions")],
        route: SESSIONS_ROUTE,
      },
      {
        id: "ask-bugs",
        kind: "do",
        title: k("askBugs.title"),
        body: k("askBugs.body"),
        role: k("askBugs.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("askBugs.say"), text: k("askBugs.text") },
        route: SESSIONS_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askBugs.text")),
      },
      {
        // The agent's answer to this run's question: the bugs, the battery one among them.
        id: "bugs",
        kind: "show",
        title: k("bugs.title"),
        body: k("bugs.body"),
        role: k("bugs.role"),
        anchor: "agent-answer[data-turn-id={ask-bugs}]",
        path: toAgent(k("bugs.way3")),
        route: SESSIONS_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        waitsOn: "agent",
      },
      {
        id: "ask-dispatch",
        kind: "do",
        title: k("askDispatch.title"),
        body: k("askDispatch.body"),
        role: k("askDispatch.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("askDispatch.say"), text: k("askDispatch.text") },
        route: SESSIONS_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askDispatch.text")),
      },
      {
        // The session the agent's answer to that request started on the
        // recorded laptop: recorded as {dispatch}, which the beats below open.
        // Should the call ask first (the turn read outside text), its approval
        // completes this beat and the next one approves it.
        id: "dispatch",
        kind: "do",
        title: k("dispatch.title"),
        body: k("dispatch.body"),
        role: k("dispatch.role"),
        anchor: "agent-answer[data-turn-id={ask-dispatch}]",
        path: toAgent(k("dispatch.way3")),
        route: SESSIONS_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        event: {
          app: "kernel",
          entity: "node_session",
          action: "create",
          match: { source: "dispatch" },
          actor: "user-or-agent",
          causedBy: "ask-dispatch",
          heldAs: DISPATCH_TOOL,
        },
        waitsOn: "agent",
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
      },
      // Only when the dispatch asked first. Approved, it starts the session in
      // this conversation, which this beat records on the dispatch beat, so the
      // beats below open that session either way.
      {
        ...approveHeldWrite("approve-dispatch", "dispatch", SESSIONS_ROUTE, DISPATCH_TOOL),
        event: {
          app: "kernel",
          entity: "node_session",
          action: "create",
          match: { source: "dispatch", sourceThreadId: `{${RUN_CONVERSATION}}` },
          actor: "user-or-agent",
        },
      },
      {
        id: "stream",
        kind: "do",
        title: k("stream.title"),
        body: k("stream.body"),
        role: k("stream.role"),
        anchor: "session-row",
        path: [railHop("Sessions")],
        route: SESSIONS_ROUTE,
        // The replay's own event: THIS run's session reached its recorded
        // permission request. The replay acts for the visitor unasked, so any
        // actor; the session the dispatch recorded keeps it to this run.
        event: {
          app: "kernel",
          entity: "node_session",
          action: "replay_step",
          match: { replayStep: "asked", sessionId: "{dispatch}" },
          actor: "any",
        },
        waitsOn: "replay",
        autoplay: [{ click: THIS_RUN_SESSION }, { waitEvent: true }],
      },
      {
        id: "permission",
        kind: "do",
        title: k("permission.title"),
        body: k("permission.body"),
        role: k("permission.role"),
        anchor: "request-card",
        path: [hop(k("permission.way1"), "session-row[data-id={dispatch}]")],
        route: THIS_RUN_SESSION_ROUTE,
        event: {
          app: "kernel",
          entity: "node_session",
          action: "replay_step",
          match: { replayStep: "approved", sessionId: "{dispatch}" },
        },
        // Open the recorded session (the stream beat may have been read from the list).
        autoplay: [
          { click: THIS_RUN_SESSION, unlessVisible: "node-permission-allow" },
          { waitFor: "node-permission-allow" },
          { click: "node-permission-allow" },
          { waitEvent: true },
        ],
      },
      {
        id: "result",
        kind: "show",
        title: k("result.title"),
        body: k("result.body"),
        role: k("result.role"),
        anchor: "result-card",
        route: THIS_RUN_SESSION_ROUTE,
        // After the allow, the replay plays the rest of the recording.
        waitsOn: "replay",
      },
      {
        // The finished session reports back in the conversation it came from.
        id: "report",
        kind: "show",
        title: k("report.title"),
        body: k("report.body"),
        role: k("report.role"),
        anchor: "message-row[data-session-result={dispatch}]",
        path: toAgent(k("report.way3")),
        route: THIS_RUN_SESSION_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        waitsOn: "replay",
        // The session page put the chat windows away: Play all and Take me there
        // open the conversation the report lands in.
        reach: [{ openRunConversation: true }],
      },
      {
        id: "pair",
        kind: "show",
        title: k("pair.title"),
        body: k("pair.body"),
        role: k("pair.role"),
        anchor: "demo-pair-computer",
        path: [railHop("Sessions")],
        route: SESSIONS_ROUTE,
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

export const scenarioDevTour = buildDevTour(PRODUCTS_DEV_CFG)

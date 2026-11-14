// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "projects" (pattern: the agent does the task work, the person
 * reviews it). The visitor's task, a teammate commenting on it live, then the
 * visitor asking their own agent, in their conversation with it (opened from
 * Chats in the dock, beside the task), to break the task down and answer the
 * teammate in the task's discussion: what a person would do in practice,
 * rather than tagging an agent in the task. Then
 * the visitor reviews the subtasks and the reply.
 */
import { askAgentInRunConversation } from "../agent-steps"
import type { Tour, TourEventBinding } from "../schema"
import {
  approveHeldWrite,
  hop,
  lastHop,
  PRODUCTS_CFG,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  RUN_CONVERSATION_ROW,
  RUN_CONVERSATION_ROW_PHONE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
  taskCreatedBy,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

/** The agent's reply in the task's discussion, written by the turn answering `askBeat`. */
function taskCommentBy(askBeat: string): TourEventBinding {
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    match: { threadOrigin: "projects:task" },
    actor: "user-or-agent",
    causedBy: askBeat,
  }
}

/** What the projects scenario takes from its world besides the base configuration. */
export interface ProjectsScenarioCfg extends ScenarioCfg {
  /** The project the visitor's task sits in, by its name on the Projects home. */
  projectName?: string
}

/** The products world's project (the default). */
export const PRODUCTS_PROJECT_NAME = "Kestrel Field Preamp launch"

export function buildProjectsTour(cfg: ProjectsScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy ?? "projects")
  const projectName = cfg.projectName ?? PRODUCTS_PROJECT_NAME
  /** From the rail to the visitor's task: the project, then the task. */
  const toTask = (last: string) => [
    railHop("Projects"),
    hop(k("myTask.way2"), `projects-home-row-*[data-project-name=${projectName}]`),
    hop(k("myTask.way3"), "project-list-view.row[data-task-id={teammate}]"),
    lastHop(last),
  ]
  /** From Chats in the dock (a phone's Chats tab) to the person's conversation with their agent. */
  const toRunConversation = (last: string) => [
    hop(k("askAgent.way1"), "dock-chats", "phone-tab-chats"),
    hop(
      "tours.scenarios.common.openRunConversation",
      RUN_CONVERSATION_ROW,
      RUN_CONVERSATION_ROW_PHONE,
    ),
    lastHop(last),
  ]
  return scenarioTour("projects", cfg, {
    app: "kernel",
    demoOnly: true,
    // Every run asks the person's agent in their one conversation with it.
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["projects"] },
    beats: [
      {
        id: "home",
        kind: "show",
        title: k("home.title"),
        body: k("home.body"),
        role: k("home.role"),
        anchor: "projects-home",
        path: [railHop("Projects")],
        route: "/projects",
      },
      {
        id: "teammate",
        kind: "world",
        title: k("teammate.title"),
        body: k("teammate.body"),
        role: k("teammate.role"),
        // Records the visitor's task, so the beats below open that task.
        injector: cfg.injector ?? "projects-comment",
        // Where it lands: that stays bright while the rest dims.
        anchor: "projects-home",
        route: "/projects",
      },
      {
        id: "my-task",
        kind: "show",
        title: k("myTask.title"),
        body: k("myTask.body"),
        role: k("myTask.role"),
        anchor: "task-detail.thread",
        path: toTask(k("myTask.way4")),
        route: "/projects/tasks/{teammate}",
      },
      {
        id: "ask-agent",
        kind: "do",
        title: k("askAgent.title"),
        body: k("askAgent.body"),
        role: k("askAgent.role"),
        // The person's conversation with their agent, opened from the dock's
        // Chats beside the task (the agent reads the task behind the dock); a
        // phone opens it from the Chats tab. Already open in the dock, its
        // composer is ringed at once.
        anchor: RUN_COMPOSER_ANCHOR,
        path: toRunConversation("tours.scenarios.common.sendBelow"),
        say: { lead: k("askAgent.say"), text: k("askAgent.text") },
        route: "/projects/tasks/{teammate}",
        // The visitor's own message to their agent in their conversation with it:
        // a comment in the task's discussion does not complete it.
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askAgent.text")),
      },
      {
        id: "subtasks",
        kind: "do",
        title: k("subtasks.title"),
        body: k("subtasks.body"),
        role: k("subtasks.role"),
        // The agent's answer to this request, in the conversation it was asked
        // in: the live turn while it works, then the summary it ends on (in the
        // dock beside the task, full screen on a phone).
        anchor: "agent-answer[data-turn-id={ask-agent}]",
        path: toRunConversation(k("subtasks.way3")),
        route: "/projects/tasks/{teammate}",
        routePhone: RUN_CONVERSATION_ROUTE,
        // A task another turn or another scenario's agent creates does not count.
        // It may park for approval instead (heldAs): approve-subtasks approves it.
        event: { ...taskCreatedBy("ask-agent"), heldAs: "projects:create" },
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
      },
      {
        id: "reply",
        kind: "do",
        title: k("reply.title"),
        body: k("reply.body"),
        role: k("reply.role"),
        // Its answer to Tobias lands in the task's discussion, not in the chat.
        anchor: "task-detail.thread",
        path: toTask(k("reply.way3")),
        route: "/projects/tasks/{teammate}",
        // It may park for approval instead (heldAs): approve-reply approves it.
        event: { ...taskCommentBy("ask-agent"), heldAs: "projects:comment" },
        autoplay: WAIT_FOR_AGENT_STEPS,
      },
      // One turn makes both writes, so both approvals come after it: a write
      // that ran at once passes its approve beat.
      approveHeldWrite("approve-subtasks", "subtasks", "/projects/tasks/{teammate}"),
      approveHeldWrite("approve-reply", "reply", "/projects/tasks/{teammate}"),
      {
        id: "review",
        kind: "show",
        title: k("review.title"),
        body: k("review.body"),
        role: k("review.role"),
        anchor: "task-detail",
        // Back from approving in the agent conversation, when a write asked first.
        path: toTask(k("review.way3")),
        route: "/projects/tasks/{teammate}",
      },
      {
        id: "board",
        kind: "show",
        title: k("board.title"),
        body: k("board.body"),
        role: k("board.role"),
        // Every subtask of the visitor's task, ringed together: the seed gives
        // that task none, so they are the ones the agent just made.
        anchor: "project-list-view.row[data-parent-task-id={teammate}]",
        anchorAll: true,
        path: [hop(k("board.way1"), "task-detail.breadcrumb-project"), lastHop(k("board.way2"))],
        route: "/projects/tasks/{teammate}",
        reach: [
          { click: "task-detail.breadcrumb-project", unlessVisible: "project-workspace.toolbar" },
          // The rows are the list's: a project left on its board opens on it.
          { click: "project-view-list", unlessActive: true },
        ],
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

export const scenarioProjectsTour = buildProjectsTour(PRODUCTS_CFG)

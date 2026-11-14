// SPDX-License-Identifier: FSL-1.1-ALv2
// The demo scenarios: one demoOnly tour per need, never offered to a regular
// org, each world beat naming its injector, every copy key present in en and fr.
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { DEMO_WORLD_NEEDS, demoScenarioTourId } from "../../demo/worlds"
import en from "../../i18n/locales/en/tours.json"
import fr from "../../i18n/locales/fr/tours.json"
import { findTour, TOURS, tourCatalogue } from "../index"
import {
  beatWaitsOn,
  defineTour,
  effectiveBeats,
  isTourAvailable,
  matchEntityRef,
  RUN_CONVERSATION,
  resolveBeatAnchor,
  resolveBeatRoute,
  type Tour,
  type TourEventBinding,
  type TourPathHop,
  TourSchema,
  type TourStep,
  tourCopyKeys,
} from "../schema"
import { buildChatTour } from "./chat"
import { buildCommerceTour } from "./commerce"
import { buildDevTour, PRODUCTS_DEV_CFG } from "./dev"
import { DEMO_SCENARIO_TOURS, SCENARIO_TOURS } from "./index"
import { buildKnowledgeTour, PRODUCTS_KNOWLEDGE_CFG } from "./knowledge"
import productsSnapshot from "./products-tours.snapshot.json"
import { buildProjectsTour } from "./projects"
import { buildSalesTour, PRODUCTS_SALES_CFG, PROSPECT_ROUTINE_NAME } from "./sales"
import { PRODUCTS_CFG } from "./shared"
import { buildSupportTour } from "./support"

/** Each scenario's live event; the developer scenario has none (its agent dispatches for real). */
const INJECTORS: Record<string, string | undefined> = {
  "kernel.scenario-support": "support-ticket",
  "kernel.scenario-projects": "projects-comment",
  "kernel.scenario-chat": "chat-question",
  "kernel.scenario-sales": "sales-email",
  "kernel.scenario-commerce": "commerce-order",
  "kernel.scenario-dev": undefined,
  "kernel.scenario-knowledge": "knowledge-lucas-asks",
  "kernel.scenario-saas-support": "saas-support-ticket",
  "kernel.scenario-saas-projects": "saas-projects-comment",
  "kernel.scenario-saas-chat": "saas-chat-question",
  "kernel.scenario-saas-sales": "saas-sales-email",
  "kernel.scenario-saas-money": "saas-payment-recovered",
  "kernel.scenario-saas-dev": undefined,
  "kernel.scenario-saas-knowledge": "saas-knowledge-asks",
}

function lookup(dict: unknown, key: string): unknown {
  return key
    .replace(/^tours\./, "")
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dict,
    )
}

describe("demo scenarios", () => {
  it("one per need, in need order, each the need's scenario tour", () => {
    expect(SCENARIO_TOURS.map((t) => t.id)).toEqual(
      DEMO_WORLD_NEEDS.products.map((n) => demoScenarioTourId("products", n)),
    )
    for (const tour of SCENARIO_TOURS) expect(findTour(tour.id)).toBe(tour)
  })

  it("are demoOnly: a regular org is never offered one, a demo org is", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      expect(tour.demoOnly).toBe(true)
      const apps = tour.requires?.apps ?? []
      const worldId = tour.world
      expect(isTourAvailable(tour, { installedApps: apps, scopes: ["*"], worldId })).toBe(false)
      expect(
        isTourAvailable(tour, { installedApps: apps, scopes: ["*"], isDemo: false, worldId }),
      ).toBe(false)
      expect(
        isTourAvailable(tour, { installedApps: apps, scopes: ["*"], isDemo: true, worldId }),
      ).toBe(true)
    }
    // "Show me how" lists TOURS; the scenarios are only in the catalogue.
    for (const tour of TOURS) expect(tour.demoOnly).toBeUndefined()
    expect(tourCatalogue().filter((t) => t.demoOnly)).toHaveLength(DEMO_SCENARIO_TOURS.length)
  })

  it("each has at most one world beat, naming its injector, played in a demo org only", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      const world = tour.beats.filter((b) => b.kind === "world")
      const injector = INJECTORS[tour.id]
      if (injector === undefined) {
        expect(world, tour.id).toEqual([])
        continue
      }
      expect(world.map((b) => b.injector)).toEqual([injector])
      const apps = [...(tour.requires?.apps ?? []), "projects", "invoicing"]
      const worldId = tour.world
      expect(
        effectiveBeats(tour, { installedApps: apps, isDemo: true, worldId }).some(
          (b) => b.kind === "world",
        ),
      ).toBe(true)
      expect(
        effectiveBeats(tour, { installedApps: apps, isDemo: false, worldId }).some(
          (b) => b.kind === "world",
        ),
      ).toBe(false)
    }
  })

  it("every do beat's autoplay ends waiting for its event", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      for (const beat of tour.beats.filter((b) => b.kind === "do")) {
        expect(beat.autoplay?.at(-1)).toEqual({ waitEvent: true })
      }
    }
  })

  it("every copy key, typed text included, exists in en and fr", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      for (const key of tourCopyKeys(tour)) {
        expect({ key, en: typeof lookup(en, key) }).toEqual({ key, en: "string" })
        expect({ key, fr: typeof lookup(fr, key) }).toEqual({ key, fr: "string" })
      }
    }
  })

  it("sales: the enable beat completes on the durable routine update, switched on", () => {
    const enable = findTour("kernel.scenario-sales")?.beats.find((b) => b.id === "enable")
    expect(enable?.event).toEqual({
      app: "kernel",
      entity: "routine",
      action: "update",
      // That routine only: switching any other one on is no way past the beat.
      match: { enabled: true, name: PROSPECT_ROUTINE_NAME },
    })
  })

  // A show beat moves on with Next or after a few seconds of play-all: one
  // that presented a routine's work would claim it before it exists. Each beat
  // about that work waits for the event that produces it, on this run's own
  // ticket, email or routine.
  it("support and sales wait for the routine's work on their own run's entity before showing it", () => {
    const beat = (tourId: string, id: string) => findTour(tourId)?.beats.find((b) => b.id === id)
    const note = beat("kernel.scenario-support", "routine-note")
    expect(note?.kind).toBe("do")
    expect(note?.event).toEqual({
      app: "tickets",
      entity: "note",
      action: "create",
      match: { ticketId: "{live-ticket}" },
      actor: "any",
    })
    const draft = beat("kernel.scenario-support", "routine-draft")
    expect(draft?.kind).toBe("do")
    expect(draft?.event).toEqual({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      match: { toolName: "tickets:reply", "currentPayload.ticketId": "{live-ticket}" },
      actor: "any",
    })
    // Approve presses only that draft's Approve.
    const approve = beat("kernel.scenario-support", "approve")
    expect(approve?.event?.sameEntityAs).toBe("routine-draft")
    const researching = beat("kernel.scenario-sales", "researching")
    expect(researching?.kind).toBe("do")
    // The routine works until its one request is complete: the step moves on
    // when its run proposes the request's last step, the reply.
    expect(researching?.event).toEqual({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      match: {
        toolName: "mail:reply",
        "metadata.originRoutineId": "{enable}",
      },
      actor: "any",
    })
    expect(researching?.anchor).toBeUndefined()
    expect(researching?.path).toBeUndefined()
    // The brief is shown at the end of the run, in the person's chat with their
    // agent (where the routine reports), opened from Chats in the dock: never
    // from the routine's own run thread. Next waits until it is there.
    const brief = beat("kernel.scenario-sales", "brief")
    expect(brief?.waitsOn).toBe("routine")
    expect(brief?.anchor).toBe(`message-row[data-routine-report-thread={${RUN_CONVERSATION}}]`)
    expect(brief?.path?.[0]).toMatchObject({ anchor: "dock-chats", anchorPhone: "phone-tab-chats" })
    expect(brief?.reach).toEqual([{ openRunConversation: true }])
  })

  it("a beat any actor completes must name its own run's entity", () => {
    const tour = (match: Record<string, string>) => () =>
      defineTour({
        id: "kernel.any-actor",
        app: "kernel",
        title: "tours.kernel.x.title",
        summary: "tours.kernel.x.summary",
        beats: [
          {
            id: "wait",
            kind: "do",
            title: "tours.kernel.x.a",
            body: "tours.kernel.x.b",
            event: { app: "tickets", entity: "note", action: "create", match, actor: "any" },
            autoplay: [{ waitEvent: true }],
          },
        ],
      })
    expect(tour({ kind: "note" })).toThrow(/must name an earlier beat's entity/)
  })

  it("the API connector tour adds a connection only where the page allows it", () => {
    const add = findTour("api-connector.settings")?.beats.find((b) => b.id === "add")
    expect(add?.optional).toEqual({ whenFeature: "connector-add" })
  })

  // A do beat that an agent completes, or that approves something, is bound to
  // this run's own entity: an agent working for another scenario, or an
  // approval some other turn left in the org, never completes it.
  it("every agent-completed or approving do beat is bound to its own run's entity", () => {
    const scoped = (e: TourEventBinding | undefined) =>
      e?.causedBy !== undefined ||
      e?.sameEntityAs !== undefined ||
      Object.values(e?.match ?? {}).some((v) => typeof v === "string" && /^\{.+\}$/.test(v))
    // A scenario played once may approve what its world seeded for it: one
    // request, named by its recipient and what it is about.
    const seededForRun = (tour: Tour, e: TourEventBinding | undefined) =>
      tour.singleRun === true &&
      typeof e?.match?.["currentPayload.to.0"] === "string" &&
      typeof e?.match?.["currentPayload.followUp.refs.0.kind"] === "string"
    for (const tour of DEMO_SCENARIO_TOURS) {
      for (const beat of tour.beats.filter((b) => b.kind === "do")) {
        const e = beat.event
        const agentDone = e?.actor === "user-or-agent"
        const approves = e?.entity === "approval_request"
        if (agentDone || approves)
          expect({
            beat: `${tour.id}/${beat.id}`,
            scoped: scoped(e) || seededForRun(tour, e),
          }).toEqual({
            beat: `${tour.id}/${beat.id}`,
            scoped: true,
          })
      }
    }
  })

  it("commerce: approves only the approval the agent proposed when asked", () => {
    const beats = findTour("kernel.scenario-commerce")?.beats ?? []
    const ids = beats.map((b) => b.id)
    expect(ids.indexOf("ask-agent")).toBeLessThan(ids.indexOf("prepare"))
    expect(ids.indexOf("prepare")).toBeLessThan(ids.indexOf("approve"))
    const prepare = beats.find((b) => b.id === "prepare")
    expect(prepare?.event).toMatchObject({
      entity: "approval_request",
      action: "create",
      causedBy: "ask-agent",
      // Only the shipment: a web search the same turn parks is an approval too.
      match: { toolName: "boxtal:create_shipment" },
    })
    const approve = beats.find((b) => b.id === "approve")
    expect(approve?.event).toMatchObject({ sameEntityAs: "prepare", match: { status: "approved" } })
    // The script presses Approve on that approval only.
    expect(approve?.autoplay).toContainEqual({
      click: {
        testid: "approval-card-action-approve",
        created: { beat: "prepare", attr: "data-entity-id" },
      },
    })
  })

  // Walk 2026-10-26: the person's own agent stalled on the booking. The
  // Operations Desk holds the shipping, shop and invoicing tools: the run's
  // conversation is the person's DM with it, and each hop there is ringed.
  it("commerce: asks the Operations Desk, its row ringed on the way to its conversation", () => {
    const tour = findTour("kernel.scenario-commerce")
    expect(tour?.agent).toBe("@operations")
    for (const id of ["ask-agent", "prepare", "approve"]) {
      // The ask comes back from Invoices first: the way's last three hops.
      const path = tour?.beats.find((b) => b.id === id)?.path ?? []
      const anchors = path.slice(-3).map((h) => h.anchor)
      expect({ id, anchors }).toEqual({
        id,
        anchors: ["dock-chats", "chats-agent-row[data-agent-name=Operations Desk]", undefined],
      })
    }
    expect(() =>
      defineTour({ ...(tour as Tour), id: "kernel.no-talk", talksToAgent: undefined }),
    ).toThrow(/names an agent but does not talk to it/)
  })

  it("projects: the agent is asked in the run's conversation; its subtasks and its reply in the task come from that turn", () => {
    const tour = findTour("kernel.scenario-projects")
    const beats = tour?.beats ?? []
    const ids = beats.map((b) => b.id)
    // The comment lands first: it records the visitor's task, which the next beats open.
    expect(ids).toEqual([
      "home",
      "teammate",
      "my-task",
      "ask-agent",
      "subtasks",
      "reply",
      "approve-subtasks",
      "approve-reply",
      "review",
      "board",
      "done",
    ])
    expect(tour?.talksToAgent).toBe(true)
    const myTask = beats.find((b) => b.id === "my-task")
    expect(myTask?.route).toBe("/projects/tasks/{teammate}")
    expect(resolveBeatRoute(myTask?.route, { teammate: "t-1" })).toBe("/projects/tasks/t-1")
    expect(resolveBeatRoute(myTask?.route, {})).toBeNull()
    // The request goes to the person's own agent, in their conversation with it.
    expect(beats.find((b) => b.id === "ask-agent")?.event).toMatchObject({
      entity: "message",
      action: "create",
      match: { threadType: "agent_chat", threadId: `{${RUN_CONVERSATION}}` },
    })
    expect(beats.find((b) => b.id === "subtasks")?.event).toMatchObject({
      app: "projects",
      entity: "task",
      action: "created",
      causedBy: "ask-agent",
      heldAs: "projects:create",
    })
    // Its answer to the teammate lands in the task's own discussion, from that same turn.
    expect(beats.find((b) => b.id === "reply")?.event).toMatchObject({
      app: "kernel",
      entity: "message",
      action: "create",
      match: { threadOrigin: "projects:task" },
      causedBy: "ask-agent",
      heldAs: "projects:comment",
    })
    expect(beats.find((b) => b.id === "reply")?.route).toBe("/projects/tasks/{teammate}")
    // Either write may ask first: each has its own approve beat, after the turn making both.
    for (const [approve, held] of [
      ["approve-subtasks", "subtasks"],
      ["approve-reply", "reply"],
    ]) {
      const beat = beats.find((b) => b.id === approve)
      expect(beat?.whenHeld).toBe(held)
      expect(beat?.event).toMatchObject({ entity: "approval_request", sameEntityAs: held })
    }
    // Asked from Chats in the dock, beside the task: the person never leaves it on a desktop.
    const ask = beats.find((b) => b.id === "ask-agent")
    expect(ask?.route).toBe("/projects/tasks/{teammate}")
    expect(ask?.path?.[0]).toMatchObject({ anchor: "dock-chats", anchorPhone: "phone-tab-chats" })
    expect(ask?.autoplay?.[0]).toEqual({ openRunConversation: true })
    // Back on the project, every subtask of the visitor's task is ringed together
    // (the seed gives it none: they are the ones the agent just made).
    const board = effectiveBeats(tour!, { installedApps: ["projects"], isDemo: true }).find(
      (b) => b.id === "board",
    )
    expect(board).toMatchObject({ anchorAll: true, anchorPinned: true })
    expect(resolveBeatAnchor(board?.anchor, { teammate: "t-1", subtasks: "t-2" })).toBe(
      "project-list-view.row[data-parent-task-id=t-1]",
    )
    expect(beats.find((b) => b.id === "board")?.reach?.at(-1)).toEqual({
      click: "project-view-list",
      unlessActive: true,
    })
  })

  it("chat: the visitor reads Tobias's message in the channel, then asks the agent in the dock beside it", () => {
    const beats = findTour("kernel.scenario-chat")?.beats ?? []
    const ids = beats.map((b) => b.id)
    expect(ids).toEqual([
      "channels",
      "question",
      "read-question",
      "ask-agent",
      "searching",
      "sources",
      "follow-up",
      "task",
      "approve-task",
      "reply-tobias",
      "posting",
      "reply-in-channel",
      "done",
    ])
    // The question beat records the channel; the read beat opens it from Chats.
    const read = beats.find((b) => b.id === "read-question")
    expect(read?.kind).toBe("show")
    expect(read?.route).toBe("/threads/{question}")
    expect(read?.anchor).toBe("message-row[data-thread-id={question}]")
    // The channel's row in the desktop sidebar, and on a phone its row on the Chats tab.
    expect(read?.path?.map((hop) => hop.anchor)).toEqual([
      undefined,
      "thread-item[data-thread-id={question}]",
      undefined,
    ])
    expect(read?.path?.[1]?.anchorPhone).toBe("chat-row[data-thread-id={question}]")
    expect(resolveBeatRoute(read?.route, { question: "ch-1" })).toBe("/threads/ch-1")
    // The ask stays on the channel: Chats in the dock, the agent's row, its composer.
    const ask = beats.find((b) => b.id === "ask-agent")
    expect(ask?.route).toBe("/threads/{question}")
    expect(ask?.path?.map((hop) => hop.anchor)).toEqual([
      "dock-chats",
      "chats-personal-agent-row[data-in-dock=true]",
      undefined,
    ])
    expect(ask?.path?.[0]?.anchorPhone).toBe("phone-tab-chats")
    // The dock's row, not the Chats screen's own list beside the channel; a phone's Chats tab.
    expect(ask?.path?.[1]?.anchorPhone).toBe("chats-personal-agent-row")
    expect(ask?.anchor).toBe(`compose-field[data-thread-id={${RUN_CONVERSATION}}]`)
    expect(ask?.autoplay?.[0]).toEqual({ openRunConversation: true })
    // What follows is watched in the dock beside the channel (full screen on a phone).
    for (const id of [
      "searching",
      "sources",
      "follow-up",
      "task",
      "approve-task",
      "reply-tobias",
      "posting",
    ]) {
      const beat = beats.find((b) => b.id === id)
      expect({ id, route: beat?.route }).toEqual({ id, route: "/threads/{question}" })
      if (beat?.kind === "show" || ["task", "approve-task", "posting"].includes(id)) {
        expect({ id, phone: beat?.routePhone }).toEqual({
          id,
          phone: `/threads/{${RUN_CONVERSATION}}`,
        })
      }
    }
    // The agent answers Tobias in the channel: the person asks in the dock, the
    // turn's post in the channel completes the next step, which is then shown
    // in the channel itself (the very message that turn posted).
    const reply = beats.find((b) => b.id === "reply-tobias")
    expect(reply?.kind === "do" && reply.event?.match?.threadType).toBe("agent_chat")
    const posting = beats.find((b) => b.id === "posting")
    expect(posting?.kind === "do" && posting.event).toEqual({
      app: "kernel",
      entity: "message",
      action: "create",
      match: { threadId: "{question}", authorType: "agent" },
      actor: "user-or-agent",
      causedBy: "reply-tobias",
    })
    const shown = beats.find((b) => b.id === "reply-in-channel")
    expect(shown?.kind).toBe("show")
    expect(shown?.route).toBe("/threads/{question}")
    expect(shown?.anchor).toBe("message-row[data-message-id={posting}]")
    for (const id of ["reply-tobias", "posting", "reply-in-channel"]) {
      expect({ id, optional: beats.find((b) => b.id === id)?.optional }).toEqual({
        id,
        optional: { whenApp: "projects" },
      })
    }
  })

  // The person's conversation with their agent holds earlier turns (another
  // scenario's question, a tour's draft): a step pointing at the agent's work
  // rings only the turn answering this run's request.
  it("every step pointing inside the agent conversation is pinned to this run's turn or request", () => {
    const TURN_CONTENT = [
      "tool-call-row",
      "message-citations",
      "approval-card",
      "agent-answer",
      "message-row-routine-approval",
    ]
    const wrong: string[] = []
    for (const tour of DEMO_SCENARIO_TOURS.filter((t) => t.talksToAgent)) {
      for (const beat of tour.beats) {
        const testid = beat.anchor?.replace(/\[.*$/, "")
        if (!testid || !TURN_CONTENT.includes(testid)) continue
        // Only a step whose way goes into that conversation (Chats in the
        // dock, or its own screen): an approval on the approvals screen or
        // on a mail is not inside it.
        const inConversation =
          beat.path?.some((hop) => hop.anchor === "dock-chats") ||
          beat.route === `/threads/{${RUN_CONVERSATION}}`
        if (!inConversation) continue
        // Pinned to this run's turn or request, or (a routine's ask, posted
        // where the routine reports) to the routine this run switched on.
        if (!/\[data-(turn|request|routine)-id=\{[a-z-]+\}\]$/.test(beat.anchor ?? "")) {
          wrong.push(`${tour.id}/${beat.id}: ${beat.anchor}`)
        }
      }
    }
    expect(wrong).toEqual([])
    const anchor = (tourId: string, beatId: string) =>
      findTour(tourId)?.beats.find((b) => b.id === beatId)?.anchor
    expect(anchor("kernel.scenario-chat", "searching")).toBe(
      "agent-answer[data-turn-id={ask-agent}]",
    )
    expect(anchor("kernel.scenario-chat", "sources")).toBe(
      "message-citations[data-turn-id={ask-agent}]",
    )
    expect(anchor("kernel.scenario-chat", "task")).toBe("tool-call-row[data-turn-id={follow-up}]")
    // The breakdown step follows the agent's answer to the end: its summary.
    expect(anchor("kernel.scenario-projects", "subtasks")).toBe(
      "agent-answer[data-turn-id={ask-agent}]",
    )
    expect(anchor("kernel.scenario-commerce", "prepare")).toBe(
      "approval-card[data-turn-id={ask-agent}]",
    )
  })

  it("chat, commerce and knowledge talk to the person's agent in their one conversation with it, in the dock", () => {
    for (const id of [
      "kernel.scenario-chat",
      "kernel.scenario-commerce",
      "kernel.scenario-knowledge",
    ]) {
      const tour = findTour(id)
      expect({ id, talksToAgent: tour?.talksToAgent }).toEqual({
        id,
        talksToAgent: true,
      })
      const asks = (tour?.beats ?? []).filter(
        (b) => b.event?.entity === "message" && b.event.match?.threadType === "agent_chat",
      )
      expect(asks.length).toBeGreaterThan(0)
      for (const beat of asks) {
        // Only a message in the person's conversation with their agent
        // completes it, and the way there and the typing both go to it.
        expect(beat.event?.match?.threadId).toBe(`{${RUN_CONVERSATION}}`)
        // Asked from Chats in the dock, beside the screen the scenario is on.
        expect(beat.route).not.toBe(`/threads/{${RUN_CONVERSATION}}`)
        expect(beat.path?.some((hop) => hop.anchor === "dock-chats")).toBe(true)
        expect(beat.autoplay?.[0]).toEqual({ openRunConversation: true })
        expect(beat.autoplay).toContainEqual({
          type: expect.objectContaining({
            testid: "compose-field",
            created: { beat: RUN_CONVERSATION, attr: "data-thread-id" },
          }),
        })
        expect(JSON.stringify(beat.autoplay)).not.toContain("agent-page-message")
      }
    }
  })

  it("the run's conversation is named only by a tour that talks to the agent, and never by a beat", () => {
    const tour = (over: Record<string, unknown>, beats: unknown[]) => () =>
      defineTour({
        id: "kernel.conv",
        app: "kernel",
        title: "tours.x.t",
        summary: "tours.x.s",
        beats: beats as never,
        ...over,
      })
    const ask = {
      id: "ask",
      kind: "do",
      title: "tours.x.a.t",
      body: "tours.x.a.b",
      route: "/threads/{conversation}",
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        match: { threadId: "{conversation}" },
      },
      autoplay: [
        {
          type: {
            testid: "compose-field",
            text: "tours.x.a.text",
            created: { beat: "conversation", attr: "data-thread-id" },
          },
        },
        { waitEvent: true },
      ],
    }
    expect(tour({ talksToAgent: true }, [ask])).not.toThrow()
    expect(tour({}, [ask])).toThrow(/routes to conversation/)
    expect(
      tour({ talksToAgent: true }, [{ ...ask, id: "conversation", route: undefined }]),
    ).toThrow(/reserved/)
  })

  it("chat: the follow-up task comes from the agent's answer to the follow-up", () => {
    const beats = findTour("kernel.scenario-chat")?.beats ?? []
    expect(beats.find((b) => b.id === "task")?.event).toMatchObject({
      entity: "task",
      causedBy: "follow-up",
    })
  })

  it("support asks the agent from the ticket through the chat dock, never a composer the ticket lacks (walk D23)", () => {
    const ask = findTour("kernel.scenario-support")?.beats.find((b) => b.id === "ask-agent")
    expect(ask?.route).toBe("/tickets/{live-ticket}")
    // The step points at the conversation with the person's own agent; the
    // way there starts at Chats beside the ticket, then that agent's row.
    expect(ask?.anchor).toBe("compose-field[data-personal-agent=true]")
    expect(ask?.path?.map((hop) => hop.anchor)).toEqual([
      "dock-chats",
      "chats-personal-agent-row[data-in-dock=true]",
      undefined,
    ])
    // The person's own message to their agent completes it.
    expect(ask?.event).toMatchObject({ entity: "message", match: { threadType: "agent_chat" } })
    const steps = JSON.stringify(ask?.autoplay)
    expect(steps).toContain('"click":"dock-chats"')
    expect(steps).not.toContain("mention-result-agent")
  })

  // Walk D31 residual: at 390 the Tickets ask clicked list rows the phone list
  // does not render (it renders cards), and the approve beats waited for a
  // draft on the screen the person had left for the Chats tab.
  it("the tickets and mail app tours have phone paths that work at 390 (walk D31)", () => {
    const phone = (id: string) =>
      effectiveBeats(findTour(id)!, {
        installedApps: ["tickets", "mail"],
        isDemo: false,
        phone: true,
      })
    const desk = (id: string) =>
      effectiveBeats(findTour(id)!, { installedApps: ["tickets", "mail"], isDemo: false })
    const clicks = (b: { autoplay?: unknown[] }) =>
      JSON.stringify(b.autoplay ?? []).match(/tickets-[a-z]+-\*/g) ?? []
    for (const b of phone("tickets.basics")) expect(clicks(b)).not.toContain("tickets-list-row-*")
    expect(clicks(phone("tickets.basics").find((b) => b.id === "ask-draft")!)).toContain(
      "tickets-card-*",
    )
    for (const [tour, beat] of [
      ["tickets.basics", "review"],
      ["mail.basics", "approve"],
    ] as const) {
      const p = phone(tour).find((b) => b.id === beat)!
      expect(p.route).toBe("/approvals")
      expect(p.anchor).toBe("approvals-screen")
      // The desktop keeps the draft beside the dock: no detour.
      expect(desk(tour).find((b) => b.id === beat)!.route).toBeUndefined()
    }
    // After approving on the approvals screen, the phone note goes back to the
    // tickets to open one (it stopped there, "could not find" the ticket card).
    const note = phone("tickets.basics").find((b) => b.id === "note")!
    expect(note.route).toBe("/tickets")
    expect(desk("tickets.basics").find((b) => b.id === "note")!.route).toBeUndefined()
  })

  it("every ask beat that opens the chat dock has a phone path without it (walk D31)", () => {
    const tours = tourCatalogue({ includeTestTours: false })
    const opensDock = (steps: unknown) => JSON.stringify(steps ?? []).includes('"dock-chats"')
    const asks = tours.flatMap((t) =>
      t.beats.filter((b) => b.kind === "do" && opensDock(b.autoplay)).map((b) => ({ t, b })),
    )
    // The app tours ask in the person's conversation with their agent (opened full screen on
    // a phone); support still opens the dock.
    expect(asks.length).toBeGreaterThanOrEqual(1)
    for (const { t, b } of asks) {
      const phone = JSON.stringify(b.autoplayPhone ?? null)
      expect({
        beat: `${t.id}/${b.id}`,
        phone: phone !== "null" && !phone.includes("dock-chats"),
      }).toEqual({ beat: `${t.id}/${b.id}`, phone: true })
      // The beat's phone autoplay is what a 390 px visitor plays.
      const played = effectiveBeats(t, {
        installedApps: t.beats.flatMap((x) => (x.optional?.whenApp ? [x.optional.whenApp] : [])),
        isDemo: true,
        features: ["customer-card", "connector-add"],
        phone: true,
        worldId: t.world,
      }).find((x) => x.id === b.id)
      // What a 390 px visitor plays never needs the dock (the Chats tab, or
      // the screen's own composer, as the tickets note does).
      expect(JSON.stringify(played?.autoplay)).not.toContain('"dock-chats"')
    }
  })

  it("knowledge shows the agent's answer to this run's question before Lucas asks", () => {
    const beats = findTour("kernel.scenario-knowledge")?.beats ?? []
    const ids = beats.map((b) => b.id)
    expect(ids.indexOf("answer")).toBe(ids.indexOf("ask-agent") + 1)
    expect(ids.indexOf("lucas-asks")).toBe(ids.indexOf("answer") + 1)
    const answer = beats.find((b) => b.id === "answer")
    expect(answer?.anchor).toBe("agent-answer[data-turn-id={ask-agent}]")
    expect(answer?.waitsOn).toBe("agent")
  })

  it("knowledge's Lucas beat completes on Support Desk's answer to him, not on an ask between agents", () => {
    const beat = findTour("kernel.scenario-knowledge")?.beats.find((b) => b.id === "lucas-answer")
    // An agent asking a colleague (and the colleague's answer) nests under the
    // turn that asked: only the reply to the person who asked has no parent.
    expect(beat?.event?.match).toEqual({
      threadId: "{lucas-asks}",
      authorType: "agent",
      parentMessageId: null,
    })
    // Support Desk's reply while an agent it asked is still answering is not
    // the last word: the step completes once every turn in #support ended.
    expect(beat?.event?.turnsEnded).toBe(true)
    expect(beat?.waitsOn).toBe("agent")
  })

  it("support shows the agent's answer to this run's question before it ends", () => {
    const beats = findTour("kernel.scenario-support")?.beats ?? []
    const ids = beats.map((b) => b.id)
    expect(ids.indexOf("answer")).toBe(ids.indexOf("ask-agent") + 1)
    expect(ids.indexOf("done")).toBe(ids.indexOf("answer") + 1)
    const answer = beats.find((b) => b.id === "answer")
    // Pinned to the turn this run's question started, and Next waits for it.
    expect(answer?.anchor).toBe("agent-answer[data-turn-id={ask-agent}]")
    expect(answer?.waitsOn).toBe("agent")
  })

  it("support and sales approve the reply to the ticket or email their run injected", () => {
    const support = findTour("kernel.scenario-support")?.beats.find((b) => b.id === "approve")
    expect(support?.event?.match).toEqual({
      status: "approved",
      toolName: "tickets:reply",
      "currentPayload.ticketId": "{live-ticket}",
    })
    const sales = findTour("kernel.scenario-sales")?.beats.find((b) => b.id === "approve")
    expect(sales?.event?.match).toEqual({
      status: "approved",
      toolName: "mail:reply",
      "currentPayload.conversationId": "{live-email}",
    })
  })

  /**
   * Owner's walk 2026-10-27: the routine's requests (the web lookup, the CRM
   * record, the reply, and more) are decided in Home, where they wait together,
   * not one by one in the chat. Each sales approve step goes there on the rail,
   * rings its request's row by tool, and Do it for me expands that row and
   * presses Approve on that request's card only.
   */
  function homeApproval(tools: string | string[]): {
    anchor: string
    route: string
    rail: TourPathHop
    autoplay: TourStep[]
  } {
    const value = tools
    const row = { testid: "attention-row-*", where: { attr: "data-tool-name", value } }
    const approve = {
      testid: "approval-card-action-approve",
      where: { attr: "data-tool-name", value },
    }
    return {
      anchor: `attention-row-*[data-tool-name=${typeof tools === "string" ? tools : tools.join("|")}]`,
      route: "/",
      rail: { label: "tours.scenarios.common.railHome", rail: true },
      autoplay: [
        { waitFor: row },
        { click: row, unlessVisible: approve },
        { waitFor: approve },
        { click: approve },
        { waitEvent: true },
      ],
    }
  }

  // Owner 2026-10-29: the routine prepares ONE request (the CRM record, a quote
  // carrying its id, the reply with the quote attached), approved once in Home.
  it("sales: the visitor approves the routine's one request once, in Home", () => {
    const beats = findTour("kernel.scenario-sales")?.beats ?? []
    const approve = beats.find((b) => b.id === "approve")
    const heads = ["api-connector:connector_write", "invoicing:quote_create_and_issue"]
    const home = homeApproval(heads)
    // Rings and Do it for me approves the request's head row (the record, or
    // the quote when the prospect is already in the CRM), never a seeded request.
    expect(approve?.anchor).toBe(`approval-card-action-approve[data-tool-name=${heads.join("|")}]`)
    expect(approve?.path?.[1]?.anchor).toBe(home.anchor)
    expect(approve?.route).toBe(home.route)
    expect(approve?.path?.[0]).toEqual(home.rail)
    expect(approve?.autoplay).toEqual(home.autoplay)
    // Done once the LAST step (the reply on this run's email) ran.
    expect(approve?.waitsOn).toBe("routine")
    expect(approve?.undo).toBeDefined()
  })

  it("a whenRaised step must approve a routine's request: approval_request, toolName, its routine", () => {
    const tour = (match: Record<string, string>) => () =>
      defineTour({
        id: "kernel.when-raised",
        app: "kernel",
        title: "tours.kernel.x.title",
        summary: "tours.kernel.x.summary",
        beats: [
          {
            id: "on",
            kind: "do",
            title: "tours.kernel.x.a",
            body: "tours.kernel.x.b",
            event: { app: "kernel", entity: "routine", action: "update" },
            autoplay: [{ waitEvent: true }],
          },
          {
            id: "approve",
            kind: "do",
            title: "tours.kernel.x.a",
            body: "tours.kernel.x.b",
            whenRaised: true,
            event: { app: "kernel", entity: "approval_request", action: "update", match },
            autoplay: [{ waitEvent: true }],
          },
        ],
      })
    expect(tour({ toolName: "a:b", "metadata.originRoutineId": "{on}" })).not.toThrow()
    expect(tour({ toolName: "a:b" })).toThrow(/whenRaised/)
    expect(tour({ "metadata.originRoutineId": "{on}" })).toThrow(/whenRaised/)
  })

  it("sales: the routine prepares its request, the visitor opens it, approves once, then its brief", () => {
    const beats = findTour("kernel.scenario-sales")?.beats ?? []
    const ids = beats.map((b) => b.id)
    expect(ids.slice(ids.indexOf("researching"))).toEqual([
      "researching",
      "bundle",
      "bundle-steps",
      "approve",
      "brief",
      "card",
      "done",
    ])
    for (const b of beats) expect(b.event?.match?.toolName).not.toBe("kernel:web_fetch")
    // No step sends the person back to the routine's page while it works.
    const researching = beats.find((b) => b.id === "researching")
    expect(researching?.route).toBeUndefined()
    // The request is complete once its last step, the reply, is proposed by this run's routine.
    expect(researching?.event).toMatchObject({
      entity: "approval_request",
      action: "create",
      match: { toolName: "mail:reply", "metadata.originRoutineId": "{enable}" },
    })
    // Every step from the wait to the approval shows the routine at work while it works.
    for (const id of ["researching", "bundle", "bundle-steps", "approve"]) {
      expect({ id, waitsOn: beats.find((b) => b.id === id)?.waitsOn }).toEqual({
        id,
        waitsOn: "routine",
      })
    }
  })

  it("sales: the visitor opens the request in Home and sees its steps before approving", () => {
    const beats = findTour("kernel.scenario-sales")?.beats ?? []
    const heads = ["api-connector:connector_write", "invoicing:quote_create_and_issue"]
    const home = homeApproval(heads)
    const bundle = beats.find((b) => b.id === "bundle")
    expect(bundle?.kind).toBe("show")
    expect(bundle?.anchor).toBe(home.anchor)
    expect(bundle?.route).toBe(home.route)
    const steps = beats.find((b) => b.id === "bundle-steps")
    expect(steps?.kind).toBe("show")
    expect(steps?.anchor).toBe(`approval-card[data-tool-name=${heads.join("|")}]`)
    expect(steps?.path?.[0]).toEqual(home.rail)
    expect(steps?.path?.[1]?.anchor).toBe(home.anchor)
    const row = { testid: "attention-row-*", where: { attr: "data-tool-name", value: heads } }
    expect(steps?.reach).toEqual([
      { waitFor: row },
      {
        click: row,
        unlessVisible: { testid: "approval-card", where: { attr: "data-tool-name", value: heads } },
      },
    ])
  })

  it("show beats that point at another screen name the way there", () => {
    const route = (tourId: string, beatId: string) =>
      findTour(tourId)?.beats.find((b) => b.id === beatId)?.route
    expect(route("kernel.scenario-commerce", "orders")).toBe("/shopify/orders")
    expect(route("kernel.scenario-commerce", "invoice")).toBe("/invoicing/documents/invoices")
    const crm = findTour("kernel.scenario-sales")?.beats.find((b) => b.id === "crm")
    expect(crm?.route).toBe("/mail")
    expect(crm?.reach).toEqual([{ click: "conversation-row", unlessVisible: "customer-card" }])
  })

  // Walk D38: "It asks first" gave up 5 s in, 37 s before the recorded
  // permission request arrived. The step before waits on the replay's own
  // event on this run's session, sized for a replay; the steps after open and
  // answer that session only.
  it("dev: the stream waits on this run's session reaching its permission request (walk D38)", () => {
    const dev = SCENARIO_TOURS.find((t) => t.id === "kernel.scenario-dev")!
    const beats = effectiveBeats(dev, { installedApps: [], isDemo: true })
    const stream = beats.find((b) => b.id === "stream")!
    expect(stream.kind).toBe("do")
    expect(stream.event).toMatchObject({
      app: "kernel",
      entity: "node_session",
      action: "replay_step",
      match: { replayStep: "asked", sessionId: "{dispatch}" },
      actor: "any",
    })
    expect(beatWaitsOn(stream)).toBe("replay")
    const permission = beats.find((b) => b.id === "permission")!
    expect(permission.event?.match).toEqual({ replayStep: "approved", sessionId: "{dispatch}" })
    const pinned = (b: typeof stream) =>
      (b.autoplay ?? []).filter((st) => "click" in st && typeof st.click !== "string")
    expect(pinned(stream)).toHaveLength(1)
    expect(pinned(permission)).toHaveLength(1)
    expect(beatWaitsOn(beats.find((b) => b.id === "result")!)).toBe("replay")
  })

  // Walk D35: "With its sources" gave up after 60 s; the answer came 38 s later.
  it("chat: the steps showing the agent's answer wait on the agent (walk D35)", () => {
    const chat = SCENARIO_TOURS.find((t) => t.id === "kernel.scenario-chat")!
    const beats = effectiveBeats(chat, { installedApps: ["projects"], isDemo: true })
    for (const id of ["searching", "sources", "task"]) {
      expect(beatWaitsOn(beats.find((b) => b.id === id)!), id).toBe("agent")
    }
  })

  // Walk 5: after a reload or a resumed run, chat's "With its sources" and
  // dev's "It asks first" could not find their screen again (the page was on
  // Home). A beat that waits on what the run recorded always has a way back.
  it("every beat waiting on what the run recorded has a route back to it", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      for (const beat of tour.beats) {
        if (!beat.anchor) continue
        const refs = [
          beat.event?.causedBy,
          beat.event?.sameEntityAs,
          ...Object.values(beat.event?.match ?? {}).map((v) =>
            typeof v === "string" ? matchEntityRef(v) : null,
          ),
        ].filter((r) => r)
        if (!beatWaitsOn(beat) && refs.length === 0) continue
        expect(beat.route, `${tour.id} ${beat.id}`).toBeDefined()
      }
    }
    const route = (tourId: string, beatId: string) =>
      findTour(tourId)?.beats.find((b) => b.id === beatId)?.route
    const created = {
      [RUN_CONVERSATION]: "c-1",
      dispatch: "s-1",
      teammate: "t-1",
      question: "ch-1",
    }
    const phoneRoute = (tourId: string, beatId: string) =>
      findTour(tourId)?.beats.find((b) => b.id === beatId)?.routePhone
    // Watched in the dock beside the channel; full screen in the conversation on a phone.
    for (const id of ["searching", "sources", "task"]) {
      expect(resolveBeatRoute(route("kernel.scenario-chat", id), created), id).toBe("/threads/ch-1")
      expect(resolveBeatRoute(phoneRoute("kernel.scenario-chat", id), created), id).toBe(
        "/threads/c-1",
      )
    }
    for (const id of ["prepare", "approve"]) {
      expect(resolveBeatRoute(route("kernel.scenario-commerce", id), created), id).toBe(
        "/shopify/orders",
      )
      expect(resolveBeatRoute(phoneRoute("kernel.scenario-commerce", id), created), id).toBe(
        "/threads/c-1",
      )
    }
    for (const id of ["permission", "result"]) {
      expect(resolveBeatRoute(route("kernel.scenario-dev", id), created), id).toBe("/sessions/s-1")
    }
    expect(resolveBeatRoute(route("kernel.scenario-projects", "subtasks"), created)).toBe(
      "/projects/tasks/t-1",
    )
    expect(resolveBeatRoute(route("kernel.scenario-projects", "reply"), created)).toBe(
      "/projects/tasks/t-1",
    )
  })

  // Walk D48: after a reload, chat's "Or just talk" pointed at the run's
  // composer with no way back to it. Every beat that points at something in a
  // scenario names where it is.
  it("every beat pointing at something names its way back to it", () => {
    for (const tour of DEMO_SCENARIO_TOURS) {
      for (const beat of tour.beats) {
        if (!beat.anchor) continue
        // The dev end card points at the pairing button on the same screen.
        if (tour.id === "kernel.scenario-dev" && beat.id === "pair") continue
        expect({ beat: `${tour.id}/${beat.id}`, route: beat.route !== undefined }).toEqual({
          beat: `${tour.id}/${beat.id}`,
          route: true,
        })
      }
    }
    const sources = findTour("kernel.scenario-chat")?.beats.find((b) => b.id === "sources")
    expect(resolveBeatRoute(sources?.routePhone, { [RUN_CONVERSATION]: "c-1" })).toBe(
      "/threads/c-1",
    )
  })

  // Walk D51: in manual mode the visitor passed the live ticket with Next
  // before it existed, and "Her ticket is here" showed a list without it.
  // The step after a live arrival points at the very entity it recorded, so
  // it cannot be passed before that is on screen.
  it("support: the step after the live ticket spotlights the ticket it recorded, on both widths", () => {
    const support = findTour("kernel.scenario-support")!
    const open = (phone: boolean) =>
      effectiveBeats(support, { installedApps: ["tickets"], isDemo: true, phone }).find(
        (b) => b.id === "open",
      )!
    // "Take me there" opens that very ticket, never the list (owner, 2026-10-25).
    expect(resolveBeatRoute(open(false).route, { "live-ticket": "t-1" })).toBe("/tickets/t-1")
    expect(open(false).anchorPinned).toBe(true)
    // The step is about the ticket opened: it is done once that ticket is open.
    for (const phone of [false, true]) {
      expect(resolveBeatAnchor(open(phone).anchor, { "live-ticket": "t-1" })).toBe(
        "tickets-detail[data-ticket-id=t-1]",
      )
    }
    // On the list, its row (its card on a phone) is the way there.
    const row = (phone: boolean) => open(phone).path?.find((hop) => hop.anchor)?.anchor
    expect(resolveBeatAnchor(row(false), { "live-ticket": "t-1" })).toBe("tickets-list-row-t-1")
    expect(resolveBeatAnchor(row(true), { "live-ticket": "t-1" })).toBe("tickets-card-t-1")
    // Nothing recorded yet: nothing to point at, never some other row.
    expect(resolveBeatAnchor(open(false).anchor, {})).toBeNull()
  })

  // Walk D53: support's note step ringed the reply draft and its approve step
  // the note's card, the first one on the page. Every step about something
  // the run recorded points at that very entity, by its id.
  it("each step about what the run recorded spotlights that entity, by its id", () => {
    const created = {
      "live-ticket": "t-1",
      "routine-draft": "a-1",
      prepare: "a-2",
      "ask-draft": "a-3",
      note: "a-4",
      "summarise-draft": "a-5",
      "ask-plan": "a-6",
    }
    const anchorOf = (tourId: string, beatId: string, phone = false) =>
      resolveBeatAnchor(
        effectiveBeats(findTour(tourId)!, {
          installedApps: ["tickets", "mail", "projects", "invoicing", "shopify"],
          isDemo: true,
          features: ["customer-card"],
          phone,
        }).find((b) => b.id === beatId)?.anchor,
        created,
      )
    // The note step rings the note, the draft step the reply's own card, never
    // another approval card on the page (the note may have parked as one).
    expect(anchorOf("kernel.scenario-support", "routine-note")).toBe(
      "tickets-message-*[data-kind=note]",
    )
    expect(anchorOf("kernel.scenario-support", "routine-draft")).toBe(
      "tickets-detail-approval-card[data-tool-name=tickets:reply]",
    )
    // Approving it: that very draft's card, by the id the draft step recorded.
    expect(anchorOf("kernel.scenario-support", "approve")).toBe(
      "tickets-detail-approval-card[data-approval-id=a-1]",
    )
    expect(anchorOf("kernel.scenario-commerce", "approve")).toBe(
      "approval-card[data-request-id=a-2]",
    )
    expect(anchorOf("tickets.basics", "review")).toBe("approval-card[data-request-id=a-3]")
    expect(anchorOf("tickets.basics", "approve-note")).toBe("approval-card[data-request-id=a-4]")
    expect(anchorOf("mail.basics", "approve")).toBe("approval-card[data-request-id=a-5]")
    expect(anchorOf("projects.basics", "approve-plan")).toBe("approval-card[data-request-id=a-6]")
  })

  // Owner feedback (walk 6): a live arrival spotlights where it lands, so
  // the rest of the page dims and the arrival stays bright.
  it("every live arrival that lands on a screen points at where it lands", () => {
    for (const [tourId, beatId] of [
      ["kernel.scenario-support", "live-ticket"],
      ["kernel.scenario-sales", "live-email"],
      ["kernel.scenario-chat", "question"],
      ["kernel.scenario-projects", "teammate"],
      ["kernel.scenario-commerce", "live-order"],
    ] as const) {
      const beat = findTour(tourId)?.beats.find((b) => b.id === beatId)
      expect({
        beat: `${tourId}/${beatId}`,
        anchor: Boolean(beat?.anchor),
        route: Boolean(beat?.route),
      }).toEqual({
        beat: `${tourId}/${beatId}`,
        anchor: true,
        route: true,
      })
    }
  })

  it("dev: the recorded laptop is shown before the agent is asked to send it the fix", () => {
    const ids = findTour("kernel.scenario-dev")?.beats.map((b) => b.id) ?? []
    expect(ids.slice(0, 6)).toEqual([
      "intro",
      "computers",
      "ask-bugs",
      "bugs",
      "ask-dispatch",
      "dispatch",
    ])
    expect(ids.indexOf("computers")).toBeLessThan(ids.indexOf("dispatch"))
  })

  // Option A: the agent's own run_on_my_computer call starts the session; no
  // world beat dispatches behind the visitor's back.
  it("dev: the dispatch completes on the session this run's request started, held or not", () => {
    const dev = findTour("kernel.scenario-dev")!
    expect(dev.talksToAgent).toBe(true)
    expect(dev.beats.some((b) => b.kind === "world")).toBe(false)
    const dispatch = dev.beats.find((b) => b.id === "dispatch")!
    expect(dispatch.event).toEqual({
      app: "kernel",
      entity: "node_session",
      action: "create",
      match: { source: "dispatch" },
      actor: "user-or-agent",
      causedBy: "ask-dispatch",
      heldAs: "kernel:run_on_my_computer",
    })
    // Held: the approval card is ringed and approved, and the session that
    // approval starts in this conversation is recorded on the dispatch beat.
    const approve = dev.beats.find((b) => b.id === "approve-dispatch")!
    expect(approve.whenHeld).toBe("dispatch")
    // Its own card: a conversation shows a held dispatch as the dispatch card.
    expect(approve.anchor).toBe("node-dispatch-approval[data-request-id={dispatch}]")
    expect(approve.event).toEqual({
      app: "kernel",
      entity: "node_session",
      action: "create",
      match: { source: "dispatch", sourceThreadId: `{${RUN_CONVERSATION}}` },
      actor: "user-or-agent",
    })
    // Play all presses the dispatch card's own Approve: the conversation shows a
    // held dispatch as that card, never the generic approval card.
    const press = {
      testid: "node-dispatch-approval-approve",
      created: { beat: "dispatch", attr: "data-entity-id" },
    }
    expect(approve.autoplay).toEqual([
      { openRunConversation: true },
      { waitFor: press },
      { click: press },
      { waitEvent: true },
    ])
    // The asks go into the person's own conversation, Auto model (no pin).
    for (const id of ["ask-bugs", "ask-dispatch"]) {
      const ask = dev.beats.find((b) => b.id === id)!
      expect(ask.autoplay?.some((st) => "type" in st)).toBe(true)
    }
    const report = dev.beats.find((b) => b.id === "report")!
    expect(report.anchor).toBe("message-row[data-session-result={dispatch}]")
    expect(beatWaitsOn(report)).toBe("replay")
  })

  it("a binding, a match or a route can only name an earlier recording beat", () => {
    const beat = (over: Record<string, unknown>) => ({
      title: "tours.x.a.t",
      body: "tours.x.a.b",
      ...over,
    })
    const bad = (beats: unknown[]) => () =>
      defineTour({
        id: "kernel.bad",
        app: "kernel",
        title: "tours.x.t",
        summary: "tours.x.s",
        beats: beats as never,
      })
    const ev = { app: "kernel", entity: "message", action: "create" }
    expect(
      bad([
        beat({
          id: "a",
          kind: "do",
          event: { ...ev, causedBy: "b" },
          autoplay: [{ waitEvent: true }],
        }),
        beat({ id: "b", kind: "do", event: ev, autoplay: [{ waitEvent: true }] }),
      ]),
    ).toThrow(/binds to b/)
    expect(bad([beat({ id: "a", kind: "show", anchor: "x", route: "/t/{w}" })])).toThrow(
      /routes to w/,
    )
    expect(
      bad([
        beat({
          id: "a",
          kind: "do",
          event: { ...ev, match: { id: "{zz}" } },
          autoplay: [{ waitEvent: true }],
        }),
      ]),
    ).toThrow(/matches on zz/)
    expect(
      bad([
        beat({
          id: "a",
          kind: "do",
          event: ev,
          autoplay: [{ waitEvent: true }],
          reach: [{ waitFor: "x" }],
        }),
      ]),
    ).toThrow(/only a show beat carries reach/)
  })
})

describe("scenario builders", () => {
  /** Each need's tour built for the products world, with that need's own values. */
  const BUILT: Record<string, () => Tour> = {
    support: () => buildSupportTour(PRODUCTS_CFG),
    projects: () => buildProjectsTour(PRODUCTS_CFG),
    chat: () => buildChatTour(PRODUCTS_CFG),
    sales: () => buildSalesTour(PRODUCTS_SALES_CFG),
    commerce: () => buildCommerceTour(PRODUCTS_CFG),
    dev: () => buildDevTour(PRODUCTS_DEV_CFG),
    knowledge: () => buildKnowledgeTour(PRODUCTS_KNOWLEDGE_CFG),
  }

  it("each products tour built from its builder equals today's tour beat by beat", () => {
    const before = z.array(TourSchema).parse(productsSnapshot)
    expect(before).toHaveLength(Object.keys(BUILT).length)
    for (const [need, build] of Object.entries(BUILT)) {
      const built = build()
      const expected = before.find((t) => t.id === `kernel.scenario-${need}`)
      if (!expected) throw new Error(`no snapshot of ${need}`)
      expect(built.beats.map((b) => b.id)).toEqual(expected.beats.map((b) => b.id))
      for (const [i, beat] of built.beats.entries()) expect(beat).toEqual(expected.beats[i])
      const { world, ...rest } = built
      expect(world).toBe("products")
      expect(rest).toEqual(expected)
    }
  })

  it("a world's extra beats are spliced after the beat they name and an unknown beat throws", () => {
    const extra = {
      id: "extra-look",
      kind: "show",
      title: "tours.scenarios.support.inbox.title",
      body: "tours.scenarios.support.inbox.body",
    } as const
    const tour = buildSupportTour({
      world: "saas",
      singleRun: true,
      extraBeats: [{ after: "inbox", beat: extra }],
    })
    expect(tour.id).toBe(demoScenarioTourId("saas", "support"))
    expect(tour.world).toBe("saas")
    expect(tour.singleRun).toBe(true)
    expect(tour.beats.slice(0, 2).map((b) => b.id)).toEqual(["inbox", "extra-look"])
    expect(tour.beats).toHaveLength(buildSupportTour(PRODUCTS_CFG).beats.length + 1)
    expect(() =>
      buildSupportTour({ world: "saas", extraBeats: [{ after: "nowhere", beat: extra }] }),
    ).toThrow("nowhere")
  })

  it("a software world tour is unavailable, 404s its beats and is offered only in its own world", () => {
    const saas = buildSupportTour({ world: "saas" })
    const apps = saas.requires?.apps ?? []
    const base = { installedApps: apps, scopes: ["*"], isDemo: true }
    expect(isTourAvailable(saas, { ...base, worldId: "saas" })).toBe(true)
    expect(isTourAvailable(saas, { ...base, worldId: "products" })).toBe(false)
    expect(isTourAvailable(saas, base)).toBe(false)
    expect(effectiveBeats(saas, { installedApps: apps, isDemo: true })).toEqual([])
    expect(
      effectiveBeats(saas, { installedApps: apps, isDemo: true, worldId: "saas" }).length,
    ).toBeGreaterThan(0)
    // The products scenarios keep playing where no world is named.
    for (const tour of SCENARIO_TOURS) {
      expect(tour.world).toBe("products")
      expect(
        isTourAvailable(tour, {
          installedApps: tour.requires?.apps ?? [],
          scopes: ["*"],
          isDemo: true,
        }),
      ).toBe(true)
    }
  })
})

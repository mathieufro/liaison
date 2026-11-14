// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SERVER TURN KNOWS IT HAS NO SHELL, AND WHERE ONE IS.
//
// The defect: asked for work that needed the person's computer, a server turn
// pasted shell commands and bearer tokens for the person to run by hand. It
// was never told it runs on the Liaison server, nor how the person reaches
// computer mode (the desktop app's local session). Pinned here:
//   - every server turn carries the "Work on the person's computer" section,
//     in the STABLE prefix, byte identical whatever the surface;
//   - the per turn surface (desktop app in cloud mode, web browser, mobile
//     app, unknown) is a line of the ephemeral runtime-context tail;
//   - a desktop local session, which composes through composeAgentDefinition
//     and has a real shell, never gets the section.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { ClientSurface } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  assembleContext,
  COMPUTER_MODE_SECTION,
  composeAgentDefinition,
  LOCAL_MODE_SECTION,
  NODE_MODE_SECTION,
  personHasNoComputer,
  RUNTIME_CONTEXT_MARKER,
  renderAgentDefinitionText,
  renderClientSurfaceLine,
  resetSystemPromptCache,
  systemPartsToText,
} from "~/modules/agent/context/context"
import { toolRegistry } from "~/modules/apps/app-registries"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HEADING = "## Work on the person's computer"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** The runtime-context tail of an assembled turn, or "" when it has none. */
function tailOf(messages: Array<{ role: string; content: unknown }>): string {
  const last = messages.filter(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.startsWith(RUNTIME_CONTEXT_MARKER),
  )
  return (last.at(-1)?.content as string | undefined) ?? ""
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Computer Mode Org', ${`cm-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`cm-${tag}@test.com`}, 'Computer Mode User')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${AGENT}, ${ORG}, 'role', '@data', 'Data', 'You produce the monthly reports.')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`cm-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.nodes WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("computer mode in a server turn", () => {
  it("the stable prefix carries the section, once, with no commands or tokens offered", async () => {
    const turn = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: AGENT })
    const parts = turn.system.filter((p) => p.content.startsWith(HEADING))
    expect(parts).toHaveLength(1)
    expect(parts[0].content).toBe(COMPUTER_MODE_SECTION)
    // What the person is told, and what the agent must never hand over.
    expect(COMPUTER_MODE_SECTION).toContain("only on their computer")
    expect(COMPUTER_MODE_SECTION).toContain("Never give them commands, scripts or tokens")
    // The product's own labels, in both languages.
    for (const label of [
      '"Get the desktop app" / "Obtenir l\'application de bureau"',
      '"Where turns run" / "Où l\'agent travaille"',
      '"This machine" / "Cet ordinateur"',
      '"Choose a folder" / "Choisir un dossier"',
    ]) {
      expect(COMPUTER_MODE_SECTION).toContain(label)
    }
    // Nothing in the section is per turn: it is the tail's job to name the surface.
    expect(systemPartsToText(turn.system)).not.toContain("The person is using")
  })

  it("the stable prefix is byte identical whatever the surface", async () => {
    const texts = await Promise.all(
      (["desktop", "web", "mobile", undefined] as Array<ClientSurface | undefined>).map(
        async (clientSurface) =>
          systemPartsToText(
            (
              await assembleContext({
                threadId: THREAD,
                orgId: ORG,
                actor,
                agentId: AGENT,
                ...(clientSurface ? { clientSurface } : {}),
              })
            ).system,
          ),
      ),
    )
    for (const text of texts) expect(text).toBe(texts[0])
  })

  const cases: Array<[ClientSurface | undefined, string]> = [
    [
      "desktop",
      "The person is using the Liaison desktop app, and this turn runs on the Liaison server (cloud mode).",
    ],
    ["web", "The person is using Liaison in a web browser."],
    ["mobile", "The person is using the Liaison mobile app."],
    [undefined, "Where the person is using Liaison from is unknown for this turn."],
  ]
  for (const [clientSurface, expected] of cases) {
    it(`the runtime-context tail names the surface: ${clientSurface ?? "unknown"}`, async () => {
      const turn = await assembleContext({
        threadId: THREAD,
        orgId: ORG,
        actor,
        agentId: AGENT,
        ...(clientSurface ? { clientSurface } : {}),
      })
      const tail = tailOf(turn.messages)
      expect(tail).toContain(expected)
      expect(tail).toContain(renderClientSurfaceLine(clientSurface))
      // Exactly one surface line, never a stale second one.
      expect(tail.split("The person is using").length - 1).toBe(clientSurface ? 1 : 0)
    })
  }

  // The owner asked from a browser for work "on my local node", whose node
  // was online, and got the desktop app download steps: the tail named the
  // surface only. With a node, the tail points at run_on_my_computer.
  it("a person with a node is pointed at run_on_my_computer, not at the surface steps", async () => {
    await sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
      VALUES (${ORG}, ${USER}, ${`d.${tag}`}, 'Test Mac')`
    try {
      const turn = await assembleContext({
        threadId: THREAD,
        orgId: ORG,
        actor,
        agentId: AGENT,
        clientSurface: "web",
      })
      const tail = tailOf(turn.messages)
      // No live connection in the test: the node reads as offline.
      expect(tail).toContain(renderClientSurfaceLine("web", "offline"))
      expect(tail).toContain("They have a computer set up for Liaison, offline right now")
      expect(tail).toContain("call kernel__run_on_my_computer as soon as they ask for it")
      expect(tail).not.toContain("give the web browser steps")
      // The stable prefix does not move with the node.
      expect(COMPUTER_MODE_SECTION).toContain(
        "When the runtime context says the person has a computer set up, that is the way",
      )
    } finally {
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${ORG}`
    }
  })

  // The developer scenario asks the agent to send the fix to the recorded
  // laptop: in a visitor demo org the tail names it as an available computer,
  // never as offline (a weak model refused to dispatch to an offline one).
  it("a visitor demo org's recorded laptop reads as an available computer, by name", async () => {
    const turn = async () =>
      tailOf(
        (
          await assembleContext({
            threadId: THREAD,
            orgId: ORG,
            actor,
            agentId: AGENT,
            clientSurface: "web",
          })
        ).messages,
      )
    DemoModeTestAccess.set(true)
    try {
      // A simulated node exists only in a demo org (0193). In the reserved
      // review org (not a visitor's) it reads as presence says, unnamed.
      await markOrgAsDemo(ORG, reservedMarker())
      invalidateDemoMarker(ORG)
      await sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name, simulated)
        VALUES (${ORG}, ${USER}, 'demo-replay', 'Demo laptop (recorded)', true)`
      const reserved = await turn()
      expect(reserved).toContain(renderClientSurfaceLine("web", "online"))
      expect(reserved).not.toContain("Demo laptop (recorded)")

      // A visitor's demo org: available, by name, never offline.
      await markOrgAsDemo(ORG, visitorMarker(24))
      invalidateDemoMarker(ORG)
      const demo = await turn()
      expect(demo).toContain(renderClientSurfaceLine("web", "online", "Demo laptop (recorded)"))
      expect(demo).toContain(
        'They have a computer set up for Liaison, "Demo laptop (recorded)", available now',
      )
      expect(demo).toContain("call kernel__run_on_my_computer as soon as they ask for it")
      expect(demo).not.toContain("offline")
    } finally {
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${ORG}`
      await sql`UPDATE kernel.organizations SET settings = settings - 'demo' WHERE id = ${ORG}`
      invalidateDemoMarker(ORG)
      DemoModeTestAccess.set(null)
    }
  })

  it("the node line names the surface and the node's state", () => {
    expect(renderClientSurfaceLine("web", "online")).toBe(
      "The person is using Liaison in a web browser. They have a computer set up for Liaison, online now. For a task that needs their computer, call kernel__run_on_my_computer as soon as they ask for it; do not give them setup or switching steps.",
    )
    expect(renderClientSurfaceLine(undefined, "online")).toStartWith(
      "They have a computer set up for Liaison, online now.",
    )
  })

  it("a desktop local session's composed definition never carries the section", async () => {
    // The contrast: the same agent's server turn does carry it.
    const turn = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: AGENT })
    expect(systemPartsToText(turn.system)).toContain(HEADING)
    const definition = await composeAgentDefinition({
      agentId: AGENT,
      requestingActor: actor,
      orgId: ORG,
    })
    expect(definition.systemPrompt.length).toBeGreaterThan(0)
    expect(renderAgentDefinitionText(definition)).not.toContain(HEADING)
    expect(renderAgentDefinitionText(definition)).not.toContain("only on their computer")
  })
})

// P3-T3 (S18, A30): each mode explains itself. The cloud turn says what
// computer mode adds and that it is the same agent; the local session says
// where it runs, what it can do there, and how to go back. Node mode is P4.
describe("mode explanations, per mode", () => {
  const LOCAL_HEADING = "## You run on this computer"

  it("cloud: the server turn explains the difference and how to switch", async () => {
    const turn = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: AGENT })
    const text = systemPartsToText(turn.system)
    for (const sentence of [
      "Computer mode is you, the same agent, with the same memory and the same conversations",
      "in computer mode you run on the person's computer, on their own Claude account, and can read and write files in the folder they pick, run scripts and make PDFs",
      "Here you can only do what your Liaison tools do.",
      'choose "This machine" / "Cet ordinateur"',
    ]) {
      expect(text).toContain(sentence)
    }
    // The cloud turn never claims to be on the computer.
    expect(text).not.toContain(LOCAL_HEADING)
  })

  it("local: the composed definition says it runs on this computer, what it can do, and how to go back", async () => {
    const definition = await composeAgentDefinition({
      agentId: AGENT,
      requestingActor: actor,
      orgId: ORG,
    })
    const parts = definition.systemPrompt.split("\n\n").filter((p) => p.startsWith(LOCAL_HEADING))
    expect(parts).toHaveLength(1)
    expect(definition.systemPrompt).toContain(LOCAL_MODE_SECTION)
    for (const sentence of [
      "This session runs on the person's computer, in the Liaison desktop app (computer mode), on their own Claude account.",
      "you can read and write files in the folder they chose, run scripts and commands",
      "make files such as PDFs",
      "the same memory and the same conversations",
      "Conversations in channels or groups run on the Liaison server, and so do routines, unless a routine's \"Runs on\" names the person's computer.",
      'chooses "Liaison"',
    ]) {
      expect(LOCAL_MODE_SECTION).toContain(sentence)
    }
    // L31: routines can run on the person's node; the section no longer says
    // they run only on the server.
    expect(LOCAL_MODE_SECTION).not.toContain("run only on the Liaison server")
    // Byte stable: no per turn or per machine data in it.
    const again = await composeAgentDefinition({
      agentId: AGENT,
      requestingActor: actor,
      orgId: ORG,
    })
    expect(again.systemPrompt).toBe(definition.systemPrompt)
  })
})

// P4 N-D T6 (S18 node, S21, S24, A30): the cloud section no longer claims
// computer work is desktop-only or DM-only (a node is reachable from the web,
// the phone, a routine and `run_on_my_computer`), and a node job's definition
// says where it runs, under which rules, and how to go back.
describe("node mode (P4, A30)", () => {
  const NODE_HEADING = "## You run on the person's computer"

  it("cloud: the section names My computer and never claims desktop-only or DM-only", () => {
    expect(COMPUTER_MODE_SECTION).not.toContain("exists only in a direct conversation")
    expect(COMPUTER_MODE_SECTION).not.toContain("only in computer mode")
    for (const sentence of [
      '"My computer" / "Mon ordinateur"',
      "run_on_my_computer",
      '"Runs on" / "S\'exécute sur"',
      "from the web, the phone or the desktop app",
      "they choose that computer by its name",
      "lists the Claude models that computer offers",
    ]) {
      expect(COMPUTER_MODE_SECTION).toContain(sentence)
    }
  })

  it("node: the composed definition carries the node section instead of the local one", async () => {
    const definition = await composeAgentDefinition({
      agentId: AGENT,
      requestingActor: actor,
      orgId: ORG,
      runtime: "node",
    })
    expect(definition.systemPrompt).toContain(NODE_MODE_SECTION)
    expect(definition.systemPrompt).not.toContain(LOCAL_MODE_SECTION)
    expect(
      definition.systemPrompt.split("\n\n").filter((p) => p.startsWith(NODE_HEADING)),
    ).toHaveLength(1)
    // The local definition is unchanged by it.
    const local = await composeAgentDefinition({
      agentId: AGENT,
      requestingActor: actor,
      orgId: ORG,
    })
    expect(local.systemPrompt).toContain(LOCAL_MODE_SECTION)
    expect(local.systemPrompt).not.toContain(NODE_HEADING)
  })

  it("node: the section snapshot", () => {
    expect(NODE_MODE_SECTION).toMatchSnapshot()
    for (const sentence of [
      "on their own Claude account",
      "the profile the owner set for you on that computer",
      "refused without asking and listed with your result",
      "never ask a question and never wait for an answer",
      "Allow / Deny card",
      "after 10 minutes it is denied",
      "Bypass is not available",
      "never merges and never pushes the default branch",
      "the owner reviews",
      'chooses "Liaison"',
    ]) {
      expect(NODE_MODE_SECTION).toContain(sentence)
    }
  })
})

// A person with no computer was offered kernel__list_my_remote_repos, whose
// description ("the repositories the person's own computer can reach with its
// signed-in GitHub CLI") the agent then told her as a fact. The tools that read
// the person's own computer are in the announced catalog only for a person who
// has one, and the turn's frame is told so for tool_search.
describe("tools that read the person's own computer", () => {
  const TOOL = "list_my_remote_repos"
  const announced = async () => {
    const turn = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: AGENT })
    const tail = turn.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n")
    return `${systemPartsToText(turn.system)}\n${tail}`
  }
  beforeAll(() => {
    // The catalog is announced only to a turn that can search tools.
    toolRegistry.set([ORG, "kernel", "tool_search"], {
      appName: "kernel",
      name: "tool_search",
      description: "kernel tool_search",
      requiredScopes: ["kernel:threads:read"],
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as unknown as Parameters<typeof toolRegistry.set>[1])
    toolRegistry.set([ORG, "kernel", "threads_search"], {
      appName: "kernel",
      name: "threads_search",
      description: "kernel threads_search",
      requiredScopes: ["kernel:threads:read"],
      deferLoading: true,
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as unknown as Parameters<typeof toolRegistry.set>[1])
    toolRegistry.set([ORG, "kernel", TOOL], {
      appName: "kernel",
      name: TOOL,
      description: "kernel list_my_remote_repos",
      requiredScopes: ["kernel:threads:read"],
      deferLoading: true,
      needsOwnComputer: true,
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as unknown as Parameters<typeof toolRegistry.set>[1])
  })
  afterAll(() => toolRegistry.deleteByPrefix([ORG]))

  it("are not announced to a person with no computer", async () => {
    expect(await personHasNoComputer(ORG, actor)).toBe(true)
    const text = await announced()
    // Discriminator: the catalog is there, with the tool that needs no computer.
    expect(text).toContain("threads_search")
    expect(text).not.toContain(TOOL)
  })

  it("are announced to a person with a computer set up", async () => {
    await sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
      VALUES (${ORG}, ${USER}, ${`d2.${tag}`}, 'Test Mac')`
    try {
      expect(await personHasNoComputer(ORG, actor)).toBe(false)
      expect(await announced()).toContain(TOOL)
    } finally {
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${ORG}`
    }
  })
})

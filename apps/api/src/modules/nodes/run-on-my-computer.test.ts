// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T20 (S1, S2, S3, S11, D24, D28, D45, D49, K9, K24, L31): one ask, one
// session. `run_on_my_computer({task, folder?, repo?, model?})` resolves the
// folder among the shared folders (or refuses with candidates and tells the
// agent to ask), picks the node that shares it, checks the model against what
// that node offers, runs at the agent's profile level whatever the request
// says, and posts exactly one session card in the conversation, never more
// visible than the conversation itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  normalizeAppGuide,
  parseGuideMarkdown,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "~/modules/agent/context/app-guide"
import { COMPUTER_MODE_SECTION } from "~/modules/agent/context/context"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { parseSkillFile } from "~/modules/agent/skills/skill-loader"
import { PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import { pushNodeSessionWaiting } from "~/modules/push/node-session-push"
import type { PushPayload } from "~/modules/push/types"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  handleRunOnMyComputer,
  RUN_ON_MY_COMPUTER_DESCRIPTION,
  summarizeRunOnMyComputer,
} from "./run-on-my-computer"

/**
 * What the model reads about the tool once it is loaded: its description, and
 * the section of the kernel guide about it, which arrives with the load.
 */
const TOOL_TEXT_LOADED = (() => {
  const file = parseSkillFile(
    readFileSync(path.join(import.meta.dir, "../agent/prompts/kernel/overview.md"), "utf8"),
  )
  const guide = normalizeAppGuide(parseGuideMarkdown(file.content, file.meta.tools))
  const { sections } = selectAppGuideParts("kernel", guide, new Set(["kernel__run_on_my_computer"]))
  return `${RUN_ON_MY_COMPUTER_DESCRIPTION}\n${renderAppGuideBlock("kernel", { sections })}`
})()

const HAIKU = "claude-haiku-4-5-20251001"
const OPUS = "claude-opus-5-5"

describe("run_on_my_computer starts a session (P1-T20)", () => {
  let owner: minimal.Session
  let agentId: string
  let threadId: string

  const actor = (): UserContext => ({
    actorType: "user",
    userId: owner.userId,
    orgId: owner.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  function frame(readScopes: string[] = []): RunContext {
    const runId = crypto.randomUUID()
    const turnScopeAccumulator = createTurnScopeAccumulator()
    turnScopeAccumulator.recordInjected(readScopes)
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator,
    }
  }

  function run(
    params: Record<string, unknown>,
    readScopes: string[] = [],
    extra: { retry?: boolean; approvalRequestId?: string } = {},
  ) {
    return withRlsContext(actor(), (tx) =>
      runContextStore.run(frame(readScopes), () =>
        handleRunOnMyComputer(
          { task: "Fix the flaky test", model: HAIKU, ...params } as Parameters<
            typeof handleRunOnMyComputer
          >[0],
          {
            userId: owner.userId,
            orgId: owner.orgId,
            db: tx,
            agentExecutionThreadId: threadId,
            scopes: ["*"],
            actingAgentId: agentId,
            ...extra,
          },
        ),
      ),
    )
  }

  async function node(
    name: string,
    folders: Array<{ name: string; path: string; kind?: string }>,
    lastSeenMinutesAgo = 1,
  ) {
    const [n] = await sql<{ id: string }[]>`
      INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name, last_seen_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${`d.${crypto.randomUUID()}`}, ${name},
              now() - make_interval(mins => ${lastSeenMinutesAgo}))
      RETURNING id`
    await sql`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, shared_folders, models)
      VALUES (${n.id}, ${owner.orgId}, ${owner.userId},
              ${JSON.stringify(folders.map((f) => ({ kind: "root", ...f })))}::jsonb,
              ${JSON.stringify([
                { id: HAIKU, label: "Haiku 4.5" },
                { id: OPUS, label: "Opus 5.5" },
              ])}::jsonb)`
    return n.id
  }

  const sessions = () =>
    sql<
      Array<{
        id: string
        job_id: string
        source: string
        config_kind: string
        folder_name: string | null
        folder_path: string | null
        repo: string | null
        model: string
        level: string
        source_thread_id: string | null
        source_message_id: string | null
      }>
    >`SELECT id, job_id, source, config_kind, folder_name, folder_path, repo, model, level,
             source_thread_id, source_message_id
        FROM kernel.node_sessions WHERE org_id = ${owner.orgId} ORDER BY created_at`

  const jobs = () =>
    sql<Array<{ id: string; source: string; thread_id: string; target_node_id: string | null }>>`
      SELECT id, source, thread_id, target_node_id FROM kernel.node_jobs
       WHERE org_id = ${owner.orgId} ORDER BY created_at`

  const cards = () =>
    sql<
      Array<{
        id: string
        content: string
        metadata: Record<string, unknown>
        required_scopes: string[]
      }>
    >`SELECT id, content, metadata, required_scopes FROM kernel.messages
       WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@rc-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    threadId = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    }
    await releaseTestLock()
  })

  it("one call with folder and model creates one job, one session and exactly one card message", async () => {
    await node("Olive's Mac", [{ name: "liaison-monorepo", path: "/Users/olive/liaison-monorepo" }])
    const res = await run({ folder: "liaison-monorepo", model: OPUS })
    expect(res).toMatchObject({
      status: "started",
      on: "Olive's Mac",
      nodeOnline: false,
      folder: "liaison-monorepo",
      model: OPUS,
      level: "strict",
    })
    expect(res.instruction).toContain("A live session card is already in this conversation")
    // Walk D17: the agent's one line beside the card never speaks of output,
    // progress or a result, which the card shows and which a line goes stale on.
    expect(res.say).toBe("Started on Olive's Mac. Follow it in the card above.")
    expect(res.instruction).toContain("reply with exactly the `say` sentence")
    expect(res.instruction).toContain("never say whether any output has returned")
    expect(TOOL_TEXT_LOADED).toContain(
      "on the card it posts in this conversation, which shows its progress and result",
    )
    expect(TOOL_TEXT_LOADED).not.toContain("the card is the only place")
    const [session] = await sessions()
    const allJobs = await jobs()
    expect(allJobs).toHaveLength(1)
    expect(await sessions()).toHaveLength(1)
    expect(res.sessionId).toBe(session.id)
    expect(allJobs[0]).toMatchObject({
      id: session.job_id,
      source: "dispatch",
      thread_id: threadId,
    })
    expect(session).toMatchObject({
      source: "dispatch",
      config_kind: "owner",
      folder_name: "liaison-monorepo",
      folder_path: "/Users/olive/liaison-monorepo",
      model: OPUS,
      level: "strict",
      source_thread_id: threadId,
    })
    const posted = await cards()
    expect(posted).toHaveLength(1)
    expect(posted[0].content).toBe("Started on Olive's Mac: Fix the flaky test")
    expect(session.source_message_id).toBe(posted[0].id)
    // The card is the middle of the turn, not its end: it notifies nobody
    // who asked for it (notification etiquette, rule 1).
    const [event] = await sql<{ ends: unknown }[]>`
      SELECT payload->'data'->'endsTurn' AS ends FROM kernel.pending_events
       WHERE org_id = ${owner.orgId} AND payload->>'entity' = 'message'
         AND payload->'data'->>'id' = ${posted[0].id}`
    expect(event).toBeDefined()
    expect(event.ends).not.toBe(true)
  })

  it("the session runs at the profile level even when the params carry level: open", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const id = await node("Mac", [{ name: "code", path: "/tmp/code" }])
    await pin(id, "standard")
    const res = await run({ folder: "code", level: "open" })
    expect(res).toMatchObject({ status: "started", level: "standard" })
    expect((await sessions())[0].level).toBe("standard")
  })

  /** The level this node published for the agent (D42). */
  const pin = (nodeId: string, level: string) =>
    sql`UPDATE kernel.node_capabilities
           SET level_pins = ${JSON.stringify([{ agentId, level }])}::jsonb
         WHERE node_id = ${nodeId}`

  // P1-walk D5: the node refused the run (level_unconfirmed) after the tool
  // had answered "started", so the agent never relayed the recovery sentence.
  it("a profile level above the node's pin, with no confirmation, is refused level_unconfirmed with the recovery sentence (D5)", async () => {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const id = await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const refused = await run({ folder: "code" })
    expect(refused).toMatchObject({ status: "refused", reason: "level_unconfirmed" })
    expect(refused.instruction).toContain("Settings > Computers > Agents")
    expect(await jobs()).toHaveLength(0)
    expect(await sessions()).toHaveLength(0)
    expect(await cards()).toHaveLength(0)

    // An attached, unconsumed raise the node will consume at claim: it starts.
    await sql`INSERT INTO kernel.node_level_confirmations
                (org_id, owner_user_id, node_id, agent_id, level, purpose, expires_at, attached_at)
              VALUES (${owner.orgId}, ${owner.userId}, ${id}, ${agentId}, 'standard',
                      'profile_raise', now() + interval '1 hour', now())`
    expect(await run({ folder: "code" })).toMatchObject({ status: "started", level: "standard" })
  })

  it("the four S2 names behave as specified at tool level", async () => {
    await node("Mac", [
      { name: "liaison-monorepo", path: "/tmp/a" },
      { name: "liaison-site", path: "/tmp/b" },
    ])
    for (const name of ["liaison-monorepo", "Liaison-Monorepo", "liaison-mono"]) {
      const res = await run({ folder: name })
      expect(res).toMatchObject({ status: "started", folder: "liaison-monorepo" })
    }
    const before = (await jobs()).length
    const ambiguous = await run({ folder: "liaison" })
    expect(ambiguous).toMatchObject({
      status: "refused",
      reason: "folder_unresolved",
      candidates: ["liaison-monorepo", "liaison-site"],
    })
    expect(ambiguous.instruction).toContain("Ask the person which folder they mean; never guess")
    expect(await jobs()).toHaveLength(before)
  })

  it("S23: run_on_my_computer stores the effort the agent passed; an effort the model does not offer is refused with the list", async () => {
    const id = await node("Mac", [{ name: "code", path: "/tmp/code" }])
    await sql`UPDATE kernel.node_capabilities SET models = ${JSON.stringify([
      { id: HAIKU, label: "Haiku 4.5" },
      { id: OPUS, label: "Opus 5.5", efforts: ["low", "high"] },
    ])}::jsonb WHERE node_id = ${id}`
    const refused = await run({ folder: "code", model: OPUS, effort: "max" })
    expect(refused).toMatchObject({
      status: "refused",
      reason: "effort_unavailable",
      efforts: ["low", "high"],
    })
    expect(refused.instruction).toContain("low, high")
    expect(await jobs()).toHaveLength(0)

    const ok = await run({ folder: "code", model: OPUS, effort: "high" })
    expect(ok).toMatchObject({ status: "started", effort: "high" })
    const [stored] = await sql<Array<{ effort: string | null }>>`
      SELECT effort FROM kernel.node_sessions WHERE id = ${ok.sessionId!}`
    expect(stored.effort).toBe("high")

    // A model that published no efforts: the level is not known to be refused.
    const haiku = await run({ folder: "code", model: HAIKU, effort: "low" })
    expect(haiku).toMatchObject({ status: "started" })
    // No effort passed: the model's default.
    const plain = await run({ folder: "code", model: OPUS })
    const [none] = await sql<Array<{ effort: string | null }>>`
      SELECT effort FROM kernel.node_sessions WHERE id = ${plain.sessionId!}`
    expect(none.effort).toBeNull()
    expect(TOOL_TEXT_LOADED).toContain("reasoning level")
  })

  it("S30: run_on_my_computer stores autonomy and finishWith the agent passed; absent → guided and null", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const stored = async (sessionId: string) =>
      (
        await sql<Array<{ autonomy: string; finish_with: string | null }>>`
          SELECT autonomy, finish_with FROM kernel.node_sessions WHERE id = ${sessionId}`
      )[0]
    const asked = await run({ folder: "code", autonomy: "autonomous", finishWith: "commit" })
    expect(asked).toMatchObject({
      status: "started",
      autonomy: "autonomous",
      finishWith: "commit",
    })
    expect(await stored(asked.sessionId!)).toEqual({
      autonomy: "autonomous",
      finish_with: "commit",
    })
    const plain = await run({ folder: "code" })
    expect(plain).toMatchObject({ status: "started" })
    expect(await stored(plain.sessionId!)).toEqual({ autonomy: "guided", finish_with: null })
    expect(TOOL_TEXT_LOADED).toContain("autonomy")
  })

  it("an unknown model is refused with the offered list", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ folder: "code", model: "claude-opus-9" })
    expect(res).toMatchObject({
      status: "refused",
      reason: "model_unavailable",
      offered: [HAIKU, OPUS],
      models: [
        { id: HAIKU, label: "Haiku 4.5" },
        { id: OPUS, label: "Opus 5.5" },
      ],
    })
    expect(res.instruction).toContain("tell them which models their computer offers")
    expect(res.instruction).toContain("never pick one for them")
    expect(await jobs()).toHaveLength(0)
  })

  // P1-walk D4: Flash Lite wrote "I have started a session" before the call,
  // and the call was then refused.
  it("the description forbids announcing a session before the tool answers; a refusal says to correct one (D4)", async () => {
    expect(RUN_ON_MY_COMPUTER_DESCRIPTION).toContain(
      "Call it BEFORE saying anything about a session",
    )
    expect(RUN_ON_MY_COMPUTER_DESCRIPTION).toContain('status "started"')
    const refused = await run({ folder: "nowhere" })
    expect(refused.status).toBe("refused")
    expect(refused.instruction).toContain("say plainly that it did not start")
  })

  // Production 2026-10-14: the agent passed `claude-opus-4-6`, an id the
  // person never named and no tool had listed, from its own knowledge. The
  // model is the person's choice: the agent asks, offering the computer's
  // models by name, and never fills one in from memory or an older request.
  it("the description and the context make the model and the folder the person's choice", () => {
    for (const sentence of [
      "Where it works and which model runs it are the person's choice, never yours",
      "When the person said them for this request in this conversation, pass them as they said them and never ask again",
      "When they did not say one, leave it out: the tool then answers what to ask and the choices to offer",
      "Never pick a model yourself, never reuse one from memory, an earlier request or another conversation",
      "never write a model id from your own knowledge",
      "read it with kernel__computer_session_read",
    ]) {
      expect(TOOL_TEXT_LOADED).toContain(sentence)
    }
    expect(COMPUTER_MODE_SECTION).toContain(
      "Never choose a model yourself, and never reuse one from memory, an earlier request or another conversation.",
    )
    // The steering half: the agent acts on the session itself.
    expect(TOOL_TEXT_LOADED).toContain("The answer carries the session's `sessionId`")
    expect(COMPUTER_MODE_SECTION).toContain("never send them to the card for that")
    expect(COMPUTER_MODE_SECTION).toContain("pass them as they said them and never ask again")
  })

  // The person says a model by its name; the agent passes it as said.
  it("a model named as the person says it starts on that model's id", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ folder: "code", model: "Opus 5.5" })
    expect(res).toMatchObject({ status: "started", model: OPUS })
    expect((await sessions())[0]).toMatchObject({ model: OPUS })
    const claude = await run({ folder: "code", model: "claude opus 5.5" })
    expect(claude).toMatchObject({ status: "started", model: OPUS })
  })

  // The REST start refuses a restricted (device-flow) session; so does the tool.
  it("a turn from a restricted device session starts nothing", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await withRlsContext(actor(), (tx) =>
      runContextStore.run({ ...frame(), sessionRestricted: true }, () =>
        handleRunOnMyComputer(
          { task: "Fix the flaky test", folder: "code", model: HAIKU },
          {
            userId: owner.userId,
            orgId: owner.orgId,
            db: tx,
            agentExecutionThreadId: threadId,
            scopes: ["*"],
            actingAgentId: agentId,
          },
        ),
      ),
    )
    expect(res).toMatchObject({ status: "refused", reason: "restricted_session" })
    expect(res.instruction).toContain("restricted device sign-in")
    expect(await jobs()).toHaveLength(0)
    expect(await sessions()).toHaveLength(0)
    expect(await cards()).toHaveLength(0)
  })

  // With #63: the person is offered each family's current model.
  // Production 2026-10-14/15: the agent passed `claude-opus-4-6` (an id it
  // wrote itself, then copied from its own earlier calls) and #63 started it,
  // because a named model was resolved among everything the node runs. The
  // agent's own call is held to the current models: an older one is asked
  // again (needs_choice) and nothing starts, by id or by name.
  async function macWithLegacyOpus() {
    const mac = await node("Mac", [{ name: "code", path: "/tmp/code" }])
    await sql`UPDATE kernel.node_capabilities SET models = ${JSON.stringify([
      { id: HAIKU, label: "Haiku 4.5" },
      { id: OPUS, label: "Opus 5.5" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    ])}::jsonb WHERE node_id = ${mac}`
    return mac
  }

  it("offers the current models by name; an older id the agent passes is asked again, nothing starts", async () => {
    await macWithLegacyOpus()
    const asked = await run({ folder: "code", model: undefined })
    expect(asked.models?.map((m) => m.label)).toEqual(["Haiku 4.5", "Opus 5.5"])
    for (const model of ["claude-opus-4-6", "Opus 4.6"]) {
      const res = await run({ folder: "code", model })
      expect(res).toMatchObject({
        status: "refused",
        reason: "needs_choice",
        missing: ["model"],
        models: [
          { id: HAIKU, label: "Haiku 4.5" },
          { id: OPUS, label: "Opus 5.5" },
        ],
      })
      expect(res.instruction).toContain("Never pass it again")
    }
    expect(await jobs()).toHaveLength(0)
    expect(await sessions()).toHaveLength(0)
    expect(await cards()).toHaveLength(0)
  })

  // Asked before the folder: a folder not shared would otherwise post a card
  // carrying the older id, which "Start again" then replays as the person's.
  it("an older id with a folder not shared is asked again before any card is posted", async () => {
    await macWithLegacyOpus()
    const res = await run({ folder: "liaison-monorepo", model: "claude-opus-4-6" })
    expect(res).toMatchObject({ status: "refused", reason: "needs_choice", missing: ["model"] })
    expect(await cards()).toHaveLength(0)
  })

  // The person's own replay ("Start again" from a card) keeps an older version.
  it("Start again (retry) still runs an older version the node runs", async () => {
    await macWithLegacyOpus()
    const res = await run({ folder: "code", model: "claude-opus-4-6" }, [], { retry: true })
    expect(res).toMatchObject({ status: "started", model: "claude-opus-4-6" })
  })

  it("no node is refused no_node", async () => {
    const res = await run({})
    expect(res).toMatchObject({ status: "refused", reason: "no_node" })
    expect(await jobs()).toHaveLength(0)
    expect(await cards()).toHaveLength(0)
  })

  // A dispatch carrying only the task ran a repository job in the agent's
  // empty node folder, on a model nobody chose: nothing starts until the
  // person chose both, and the agent is told what to ask.
  it("no folder and no model: refused needs_choice, nothing started", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ model: undefined })
    expect(res).toMatchObject({
      status: "refused",
      reason: "needs_choice",
      missing: ["folder", "model"],
      sharedFolders: ["code"],
      offered: [HAIKU, OPUS],
      // The person is offered the models by the names they know them by.
      models: [
        { id: HAIKU, label: "Haiku 4.5" },
        { id: OPUS, label: "Opus 5.5" },
      ],
    })
    expect(res.instruction).toContain("ONE short message")
    expect(res.instruction).toContain("offer the `models` by their `label`")
    expect(res.instruction).toContain("do not reuse a model from memory or an earlier request")
    expect(res.instruction).toContain("never ask again what the person already said")
    expect(await jobs()).toHaveLength(0)
    expect(await sessions()).toHaveLength(0)
    expect(await cards()).toHaveLength(0)
  })

  it("a folder without a model asks for the model only", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ folder: "code", model: undefined })
    expect(res).toMatchObject({ status: "refused", reason: "needs_choice", missing: ["model"] })
    expect(await jobs()).toHaveLength(0)
  })

  it("noFolder: true with a model starts with no folder", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const asked = await run({})
    expect(asked).toMatchObject({ status: "refused", reason: "needs_choice", missing: ["folder"] })
    const res = await run({ noFolder: true, model: OPUS })
    expect(res).toMatchObject({ status: "started", folder: null, model: OPUS })
    expect((await sessions())[0]).toMatchObject({ folder_name: null, model: OPUS })
  })

  it("folder and repo together are refused", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ folder: "code", repo: "https://github.com/acme/app.git" })
    expect(res).toMatchObject({ status: "refused", reason: "folder_and_repo" })
    expect(await jobs()).toHaveLength(0)
  })

  it("a repo URL is stored on the session; a repo name resolves to a shared repo folder", async () => {
    await node("Mac", [{ name: "app", path: "/Users/olive/app", kind: "repo" }])
    const url = await run({ repo: "git@github.com:acme/app.git" })
    expect(url).toMatchObject({ status: "started" })
    const named = await run({ repo: "app" })
    expect(named).toMatchObject({ status: "started", folder: "app" })
    const [byUrl, byName] = await sessions()
    expect(byUrl).toMatchObject({
      repo: "git@github.com:acme/app.git",
      folder_name: null,
      folder_path: null,
    })
    expect(byName).toMatchObject({
      repo: "app",
      folder_name: "app",
      folder_path: "/Users/olive/app",
    })
  })

  it("the card message metadata is kind node_session with the session id, and its requiredScopes equal the turn's", async () => {
    await node("Mac", [{ name: "code", path: "/tmp/code" }])
    const res = await run({ folder: "code" }, ["kernel:threads:read"])
    expect(res.status).toBe("started")
    const [card] = await cards()
    expect(card.metadata).toMatchObject({
      kind: "node_session",
      sessionId: res.sessionId,
      nodeName: "Mac",
    })
    expect(card.required_scopes).toEqual(["kernel:threads:read"])
  })

  // The dispatch parked for the person's approval: its card in the conversation is the approval
  // card, which becomes the session card once approved. So the approved run posts no second card
  // and names the session on the approval, which is how that card finds it, also after a reload.
  describe("approved from its card in the conversation", () => {
    async function approval(requestedBy: string, toolName = "kernel:run_on_my_computer") {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.approval_requests (org_id, handle, thread_id, originating_thread_id,
          tool_name, tool_params, current_payload, expires_at, requested_by, status, metadata)
        VALUES (${owner.orgId}, ${`request-${crypto.randomUUID().slice(0, 8)}`}, ${threadId},
          ${threadId}, ${toolName}, '{}'::jsonb, '{}'::jsonb, now() + interval '1 day',
          ${requestedBy}, 'approving', '{"origin":"in-app-agent"}'::jsonb)
        RETURNING id`
      return row.id
    }
    const metadataOf = async (id: string) =>
      (
        await sql<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
      )[0].metadata

    it("names the session on the approval and posts no separate card", async () => {
      await node("Minimac", [{ name: "code", path: "/tmp/code" }])
      const approvalRequestId = await approval(owner.userId)
      const res = await run({ folder: "code" }, [], { approvalRequestId })
      expect(res.status).toBe("started")
      expect(await cards()).toHaveLength(0)
      expect(await metadataOf(approvalRequestId)).toEqual({
        origin: "in-app-agent",
        nodeSessionId: res.sessionId,
        nodeName: "Minimac",
      })
      expect(res.say).toBe("Started on Minimac.")
    })

    it("an approval that is not this person's dispatch is left alone, and the usual card is posted", async () => {
      await node("Minimac", [{ name: "code", path: "/tmp/code" }])
      const other = await minimal.session(owner.orgId)
      const notTheirs = await approval(other.userId)
      const otherTool = await approval(owner.userId, "mail:reply")
      for (const approvalRequestId of [notTheirs, otherTool]) {
        const res = await run({ folder: "code" }, [], { approvalRequestId })
        expect(res.status).toBe("started")
        expect(await metadataOf(approvalRequestId)).toEqual({ origin: "in-app-agent" })
      }
      expect(await cards()).toHaveLength(2)
    })

    it("its card says what runs, on which computer, where and with which model", async () => {
      await node("Minimac", [{ name: "code", path: "/tmp/code" }])
      const summary = await summarizeRunOnMyComputer(
        { task: "Fix the flaky test", folder: "code", model: HAIKU },
        { orgId: owner.orgId, userId: owner.userId },
      )
      expect(summary).toEqual({
        kind: "node_dispatch",
        title: "Run on Minimac",
        subtitle: "Minimac",
        lines: ["Task: Fix the flaky test", "Folder: code", `Model: ${HAIKU}`],
      })
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      expect(
        await summarizeRunOnMyComputer(
          { task: "Tidy up", noFolder: true },
          { orgId: owner.orgId, userId: owner.userId },
        ),
      ).toEqual({
        kind: "node_dispatch",
        title: "Run on your computer",
        lines: ["Task: Tidy up", "No folder"],
      })
    })
  })

  // Final walk F4: the session push shows its title exactly when the card in
  // the conversation would show its text (push/redact.ts on the card's
  // requiredScopes, which are what the turn read), so a dispatch from a turn
  // that read nothing scoped is told apart on the lock screen; a turn that
  // read something scoped stays generic.
  describe("the session push names the session only when the dispatching turn read nothing scoped (F4)", () => {
    async function pushFor(sessionId: string): Promise<PushPayload> {
      const [s] = await sql<
        Array<{
          title: string
          source: "dispatch"
          job_id: string
          folder_name: string | null
          repo: string | null
        }>
      >`SELECT title, source, job_id, folder_name, repo FROM kernel.node_sessions
         WHERE id = ${sessionId}`
      PushFanoutTestAccess.resetDedupe()
      const sent: PushPayload[] = []
      await pushNodeSessionWaiting(
        {
          id: sessionId,
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          title: s.title,
          source: s.source,
          jobId: s.job_id,
          folderName: s.folder_name,
          repo: s.repo,
        },
        { requestId: "q1", eventSeq: 3, type: "question", tool: null },
        {
          badgeCount: async () => 0,
          send: async (_token, payload) => {
            sent.push(payload)
            return { kind: "sent" }
          },
        },
      )
      expect(sent).toHaveLength(1)
      return sent[0]
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${owner.orgId}, ${owner.userId}, 'ios', ${`f4-${crypto.randomUUID()}`})`
    })
    afterAll(async () => {
      await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${owner.userId}`
    })

    it("an owner dispatch whose turn read nothing scoped: the card is untagged and the push names the session", async () => {
      await node("Mac", [{ name: "code", path: "/tmp/code" }])
      const res = await run({ folder: "code", task: "Trim the name in greet" })
      expect(res.status).toBe("started")
      const [card] = await cards()
      expect(card.required_scopes).toEqual([])
      const payload = await pushFor(res.sessionId as string)
      expect(payload.body).toContain("Trim the name in greet")
    })

    it("an owner dispatch whose turn read scoped data: the card is tagged and the push is generic", async () => {
      await node("Mac", [{ name: "code", path: "/tmp/code" }])
      const res = await run({ folder: "code", task: "Trim the name in greet" }, [
        "kernel:threads:read",
      ])
      expect(res.status).toBe("started")
      const [card] = await cards()
      expect(card.required_scopes).toEqual(["kernel:threads:read"])
      const payload = await pushFor(res.sessionId as string)
      expect(JSON.stringify(payload)).not.toContain("Trim the name")
    })
  })

  it("the job targets the node that advertises the folder, so another node never claims it", async () => {
    await node("Recent", [{ name: "notes", path: "/tmp/notes" }], 1)
    const older = await node("Older", [{ name: "code", path: "/Users/olive/code" }], 60)
    const res = await run({ folder: "code" })
    expect(res).toMatchObject({ status: "started", on: "Older" })
    expect((await jobs())[0].target_node_id).toBe(older)
    expect((await sessions())[0].folder_path).toBe("/Users/olive/code")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 (A18): the person's agent finds the repositories on their computer
// (the node's scan) and the ones its signed-in gh and glab reach (remotes),
// read-only, only in the person's own live turn in their private
// conversation. Rows that can be shared carry a candidateId the gated
// kernel__share_folder_on_my_computer takes; no token and no path outside `~`
// reaches the agent. The `computers` playbook loads as a kernel skill.
// Every call goes through the real registry and dispatch (executeTool).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { skillRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { createNodeJob } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import {
  connectImportNode,
  enableImportNode,
  type FakeNode,
  type FakeWs,
  IMPORT_HAIKU,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { shareFolderPreflight } from "./folder-tools"

const FIND = "find_repos_on_my_computer"
const REMOTES = "list_my_remote_repos"
const TOK = (c: string) => c.repeat(32)

const SCAN = {
  searchRoots: 2,
  partial: true,
  candidates: [
    {
      name: "app",
      path: "/Users/o/code/app",
      token: TOK("a"),
      display: "~/code/app",
      shared: false,
      shareable: true,
      refusal: null,
    },
    {
      name: "data",
      path: "/srv/data",
      token: TOK("b"),
      // A display that is no `~/` path is said by its name only.
      display: "/srv/data",
      shared: false,
      shareable: true,
      refusal: null,
    },
    {
      name: "code",
      path: "/Users/o/code",
      token: null,
      display: "~/code",
      shared: true,
      shareable: false,
      refusal: null,
    },
    {
      name: ".hidden",
      path: "/Users/o/.hidden",
      token: null,
      display: "~/.hidden",
      shared: false,
      shareable: false,
      refusal: "hidden",
    },
  ],
}

const REMOTE_LIST = {
  repos: [
    {
      source: "github",
      fullName: "acme/app",
      host: "github.com",
      cloneUrl: "git@github.com:acme/app.git",
      private: true,
      pushedAt: 1_760_000_000_000,
      local: { display: "~/code/app", shared: false, token: TOK("c") },
    },
    {
      source: "github",
      fullName: "acme/site",
      host: "github.com",
      cloneUrl: "https://github.com/acme/site.git",
      private: false,
      pushedAt: null,
      local: null,
    },
  ],
  sources: [
    { tool: "gh", state: "ok" },
    { tool: "glab", state: "signed_out" },
  ],
  dropped: 0,
}

describe("the agent's repository discovery tools (S19)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string
  let dm: string
  let shared: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const actorOf = (s: minimal.Session): UserContext => ({
    actorType: "user",
    userId: s.userId,
    orgId: s.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  function turn(extra: Partial<RunContext> = {}): RunContext {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      humanTurn: true,
      ...extra,
    }
  }

  async function call(
    name: string,
    params: Record<string, unknown> = {},
    frame: RunContext = turn(),
    thread: string = dm,
  ): Promise<any> {
    return runContextStore.run(frame, () =>
      executeTool({
        toolName: `kernel:${name}`,
        orgId: owner.orgId,
        actor: actorOf(owner),
        origin: "in-app-agent",
        params,
        threadId: thread,
      }),
    )
  }

  async function online(who = owner): Promise<FakeNode> {
    const node = await enableImportNode(who)
    sockets.push(await connectImportNode(manager, node))
    return node
  }

  const folderFrames = (node: FakeNode) =>
    (node.ws?.frames ?? []).filter((f) => f.type === "node_folder_request").length

  /** The node answers its folder requests from Redis directly, as its pull would. */
  function answering(node: FakeNode, answer: (op: any) => unknown) {
    const seen = new Set<string>()
    const ops: any[] = []
    let stop = false
    const loop = (async () => {
      while (!stop) {
        for (const f of node.ws?.frames ?? []) {
          if (f.type !== "node_folder_request" || seen.has(f.requestId)) continue
          seen.add(f.requestId)
          const key = `nfr:${f.requestId}`
          const row = JSON.parse((await redis.get(key)) as string)
          ops.push(row.op)
          await redis.set(key, JSON.stringify({ ...row, result: answer(row.op) }), "EX", 60)
        }
        await Bun.sleep(15)
      }
    })()
    return {
      ops,
      async done() {
        stop = true
        await loop
      },
    }
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    const limits = await redis.keys("nfdr:*")
    if (limits.length > 0) await redis.del(...limits)
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`UPDATE kernel.threads SET tainted = false WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    agentId = await withPrivilegedDb(owner.orgId, "test", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: owner.orgId, userId: owner.userId }),
    )
    dm = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
              VALUES (${dm}, ${agentId}, ${owner.orgId}, 'agent')`
    shared = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${shared}, ${other.userId}, ${owner.orgId})`
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    await registerKernelAgentTools(owner.orgId)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (owner) await cleanup()
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("find_repos_on_my_computer: the scan's repositories by candidateId, no token, no path outside ~; the id shares like a lookup's", async () => {
    const node = await online()
    const nodeSide = answering(node, () => ({ ok: true, data: SCAN }))
    const res = await call(FIND)
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([{ kind: "scan" }])
    expect(res.error).toBeUndefined()
    const out = res.data
    const text = JSON.stringify(out)
    for (const leak of [TOK("a"), TOK("b"), "/Users/", "/srv/", '"token"', '"path"']) {
      expect(text).not.toContain(leak)
    }
    expect(out).toMatchObject({ status: "found", partial: true })
    expect(out.node.nodeId).toBe(node.nodeId)
    expect(out.settingsLink).toContain(`/settings/computers/${node.nodeId}`)
    const [app, data, code, hidden] = out.repos
    expect(app).toMatchObject({ name: "app", display: "~/code/app", shared: false, refusal: null })
    expect(app.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data).toMatchObject({ name: "data", display: "data" })
    expect(code).toMatchObject({ candidateId: null, shared: true })
    expect(hidden).toMatchObject({ candidateId: null, refusal: "hidden" })
    const ctx = { orgId: owner.orgId, userId: owner.userId }
    expect(await shareFolderPreflight({ candidateId: app.candidateId }, ctx)).toEqual({ ok: true })
    // The names came from the computer: the turn has read untrusted text.
    const [thread] = await sql<Array<{ tainted: boolean }>>`
      SELECT tainted FROM kernel.threads WHERE id = ${dm}`
    expect(thread.tainted).toBe(true)
  })

  it("list_my_remote_repos: local clones by candidateId, the login command for a signed-out tool, no token", async () => {
    const node = await online()
    const nodeSide = answering(node, () => ({ ok: true, data: REMOTE_LIST }))
    const res = await call(REMOTES)
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([{ kind: "remotes" }])
    const out = res.data
    const text = JSON.stringify(out)
    expect(text).not.toContain(TOK("c"))
    expect(text).not.toContain('"token"')
    expect(text).not.toContain("/Users/")
    expect(out.status).toBe("listed")
    const [app, site] = out.repos
    expect(app).toMatchObject({
      fullName: "acme/app",
      cloneUrl: "git@github.com:acme/app.git",
      pushedAt: new Date(1_760_000_000_000).toISOString(),
    })
    expect(app.local).toMatchObject({ display: "~/code/app", shared: false })
    expect(app.local.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(site.local).toBeNull()
    expect(out.sources).toEqual([
      { tool: "gh", state: "ok" },
      { tool: "glab", state: "signed_out", loginCommand: "glab auth login" },
    ])
    const ctx = { orgId: owner.orgId, userId: owner.userId }
    expect(await shareFolderPreflight({ candidateId: app.local.candidateId }, ctx)).toEqual({
      ok: true,
    })
  })

  it("with neither tool usable, says which and the command to run", async () => {
    const node = await online()
    const nodeSide = answering(node, () => ({
      ok: true,
      data: {
        repos: [],
        sources: [
          { tool: "gh", state: "missing" },
          { tool: "glab", state: "signed_out" },
        ],
        dropped: 0,
      },
    }))
    const res = await call(REMOTES)
    await nodeSide.done()
    expect(res.data.status).toBe("no_source")
    expect(res.data.sources[0]).toMatchObject({ tool: "gh", loginCommand: "gh auth login" })
    expect(res.data.sources[0].howToInstall).toContain("gh auth login")
    expect(res.data.instruction).toContain("loginCommand")
  })

  it("an older computer that does not know the op: told to update Liaison there", async () => {
    const node = await online()
    const nodeSide = answering(node, () => ({ ok: false, code: "failed" }))
    const res = await call(FIND)
    await nodeSide.done()
    expect(res.data).toMatchObject({ status: "refused", reason: "failed" })
    expect(res.data.instruction).toContain("update Liaison")
  })

  it("refused for another person's computer, a shared conversation, a routine, and a session on the computer; never asks the node", async () => {
    const node = await online()
    const theirs = await online(other)
    for (const name of [FIND, REMOTES]) {
      const notMine = await call(name, { nodeId: theirs.nodeId })
      expect(notMine.data).toMatchObject({ status: "refused", reason: "no_node" })
      const inShared = await call(name, {}, turn(), shared)
      expect(inShared.data).toMatchObject({ status: "refused", reason: "E_IMPORT_PRIVATE_THREAD" })
      const routine = await call(
        name,
        {},
        turn({ routineId: crypto.randomUUID(), humanTurn: false }),
      )
      expect(routine.data).toMatchObject({ status: "refused", reason: "interactive_only" })
    }
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: dm,
      source: "dispatch",
      prompt: "x",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: { source: "dispatch", configKind: "owner", model: IMPORT_HAIKU, level: "strict" },
    })
    const connectionId = crypto.randomUUID()
    await sql`UPDATE kernel.node_jobs SET mcp_connection_id = ${connectionId} WHERE id = ${job.id}`
    for (const name of [FIND, REMOTES]) {
      const res = await handleToolCall(
        {
          orgId: owner.orgId,
          actor: actorOf(owner),
          connectionId,
          ownerUserId: owner.userId,
          agentId,
          connectionThreadId: null,
          discovered: new Set(),
        },
        `kernel__${name}`,
        {},
      )
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain("not_from_a_session")
    }
    expect(folderFrames(node)).toBe(0)
    expect(folderFrames(theirs)).toBe(0)
    // Read-only, so never an approval card; the share they lead to stays gated.
    for (const name of [FIND, REMOTES]) {
      const def = toolRegistry.get([owner.orgId, "kernel", name])
      // A person with no computer is not offered them (tool-bridge.own-computer.test.ts).
      expect(def).toMatchObject({
        readOnly: true,
        notForNodeSessions: true,
        needsOwnComputer: true,
      })
      expect(def?.gated).toBeFalsy()
    }
    expect(toolRegistry.get([owner.orgId, "kernel", "share_folder_on_my_computer"])?.gated).toBe(
      true,
    )
  })

  it("the computers playbook loads as a kernel skill and names the tools", () => {
    const skill = skillRegistry.get([owner.orgId, "kernel", "computers"])
    expect(skill).toBeDefined()
    expect(skill!.description.length).toBeGreaterThan(0)
    for (const word of [
      "kernel__computer_session_import_list",
      "kernel__find_repos_on_my_computer",
      "kernel__list_my_remote_repos",
      "kernel__share_folder_on_my_computer",
      "kernel__clone_repo_on_my_computer",
      "node_outdated",
      "gh auth login",
      "Scan for repos",
      "Find repos I can access",
      "Import sessions",
    ]) {
      expect(skill!.body).toContain(word)
    }
  })
})

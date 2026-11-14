// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `kernel__run_on_my_computer` (S1, S2, S3, S11, D24, D28, spec-node.md
 * "Routing"): the cloud agent hands the current request to the person's own
 * node as a session (`dispatch`) of this agent, in one call.
 *
 * - `folder` resolves among the folders the person's nodes share (exact,
 *   case-insensitive, unique prefix); otherwise refused with up to 10
 *   candidates and the instruction to ask the person (D28). `repo` instead is
 *   a git URL or a shared repo folder's name.
 * - The node is the one sharing that folder (online first, then the most
 *   recently seen); the job targets it, so no other node claims it (K9).
 * - `model` must be one of that node's CURRENT models (D45, resolveAgentModel):
 *   an older id the agent passes is answered needs_choice. Only "Start again"
 *   (`retry`), the person's own replay, still runs an older version.
 * - The level is the agent's profile level, whatever the request says: the
 *   tool has no level (D24).
 * - `effort` (S23), only when the person stated a reasoning level: checked
 *   against the levels the chosen model published, when it published any.
 * - `autonomy` (S30) only when the person asked for the session to run on its
 *   own; `finishWith` (S57) only when they said how it should end (absent: a
 *   pull request for a repository). Both stored on the session, echoed back.
 *
 * One agent message, the session card (`metadata.kind: "node_session"`), is
 * posted in this conversation, never more visible than the conversation
 * (K24). The result is the session's; no transcript reaches the chat (S11).
 *
 * It never routes silently: the description tells the model to call it only
 * when the person asked for their computer or agreed to it.
 */
import {
  type Autonomy,
  cleanFolderName,
  type EffortLevel,
  type FinishWith,
  levelRank,
  type NodeLevel,
  sessionTitle,
} from "@liaison/shared"
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agents,
  approvalRequests,
  nodeCapabilities,
  nodeLevelConfirmations,
} from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { agentPostRequiredScopes } from "~/modules/agent/tools/chat-tools"
import { recordedLaptopOf, recordingOf, startReplay } from "~/modules/demo/replay/replay"
import {
  type FolderRef,
  loadNodeCandidates,
  modelIdForName,
  pickNode,
  resolveAgentModel,
  resolveFolder,
  resolveFolderOnNode,
  resolveModel,
  resolveRepo,
} from "~/modules/node-sessions/resolve"
import { setSessionSourceMessage } from "~/modules/node-sessions/store"
import { type FolderHelp, folderHelp } from "./folder-tools"
import { createNodeJob, loadNodeProfile, NodeJobRefusedError } from "./jobs"

const log = rootLogger.child({ module: "run-on-my-computer" })

export const RUN_ON_MY_COMPUTER_DESCRIPTION =
  "Hand this request to the person's own computer (one of their computers running Liaison), where it runs as a session with their own Claude sign-in, local files and tools, and no cloud token budget. Call it BEFORE saying anything about a session: never write that a session started, is starting or will start until this tool has answered status \"started\"; a refused call starts nothing. Call it ONLY when the person asked for it ('on my computer', 'on my Mac', 'run it locally') or said yes after you suggested it; never call it on your own initiative and never move work there silently."

export interface RunOnMyComputerContext {
  userId: string
  orgId: string
  db: RlsClient
  agentExecutionThreadId?: string
  scopes?: string[]
  actingAgentId?: string | null
  /** "Start again" from a blocked card: a folder still not shared is refused plainly (no lookup, no new card). */
  retry?: boolean
  /**
   * The approval this run executes, when the call parked for the person's approval. Its card in the
   * conversation then becomes the session card, so no second card is posted.
   */
  approvalRequestId?: string
}

export interface RunOnMyComputerParams {
  task: string
  folder?: string
  repo?: string
  /** The person said the task needs no folder: it runs in the agent's own node folder. */
  noFolder?: boolean
  model?: string
  /** S23: the reasoning level the person stated; absent: the model's default. */
  effort?: EffortLevel
  /** S30: only when the person asked for the session to run on its own. */
  autonomy?: "autonomous"
  /** S57: only when the person said how the work should end; absent: the default. */
  finishWith?: FinishWith
}

export interface RunOnMyComputerResult {
  status: "started" | "refused"
  sessionId?: string
  on?: string
  nodeOnline?: boolean
  folder?: string | null
  model?: string
  level?: string
  effort?: EffortLevel
  autonomy?: Autonomy
  finishWith?: FinishWith
  /** effort_unavailable: the levels the chosen model offers. */
  efforts?: EffortLevel[]
  reason?:
    | "no_node"
    | "no_conversation"
    | "no_agent"
    | "scope_unknown"
    | "source_scope"
    | "folder_and_repo"
    | "needs_choice"
    | "folder_unresolved"
    | "model_unavailable"
    | "effort_unavailable"
    | "level_unconfirmed"
    | "restricted_session"
  candidates?: string[]
  /** folder_unresolved, not shared at all: the names shared today. */
  sharedFolders?: FolderHelp["sharedFolders"]
  /** folder_unresolved: the folder looked up on the person's node. */
  lookup?: FolderHelp["lookup"]
  /** folder_unresolved: the exact way to share it in the app, with a link. */
  howToShare?: FolderHelp["howToShare"]
  /** folder_unresolved: clone it instead (ask first). */
  cloneOffer?: FolderHelp["cloneOffer"]
  offered?: string[]
  /** needs_choice, model_unavailable: the computer's models, each with the name to offer it by. */
  models?: Array<{ id: string; label: string }>
  /** needs_choice: what the person still has to choose before anything starts. */
  missing?: Array<"folder" | "model">
  /** Walk D17: the one sentence the agent says beside the card (it never goes stale). */
  say?: string
  instruction: string
}

const STARTED =
  "A live session card is already in this conversation, and it shows the session's progress and result as they happen. Unless the person asked something else too, reply with exactly the `say` sentence (in the person's language) and end your turn. Do not repeat the card, never say whether any output has returned, and never describe or invent a progress or a result: that line would stay beside the card, out of date."
const REFUSED =
  "The request was NOT handed to the person's computer. Tell them why in plain words, and do not claim it is running. If you already wrote that it started, say plainly that it did not start."
const RESTRICTED = `${REFUSED} This conversation comes from a restricted device sign-in, which cannot start a session on the person's computer: tell them to ask from the Liaison app, or to sign in fully.`
const NO_NODE = `${REFUSED} They have no computer set up yet: in the desktop app on that computer, Settings > Computers > "Turn on".`
const ASK_FOLDER =
  "The request was NOT started: that folder name matches no shared folder, or several. Ask the person which folder they mean; never guess. The candidates are the shared folders closest to what they said. If you already wrote that it started, say plainly that it did not start."
/** The node's own refusal sentence (runner.ts), relayed before any session exists (D5). */
const LEVEL_UNCONFIRMED = `${REFUSED} Tell them, in these words: "This agent's level is above what this computer has confirmed. Confirm it in Settings > Computers > Agents, then run it again."`
const NAME_MODELS = `${REFUSED} That model is not one their computer offers. If the model the person named for this request matches exactly one of the \`models\` by its \`label\`, call again with its \`id\` without asking them again. Otherwise tell them which models their computer offers (by \`label\`) and ask which one to use; never pick one for them.`
/** needs_choice for a model the agent passed that is not a current one (resolveAgentModel). */
const NOT_CURRENT_MODEL =
  "The `model` you passed is an older one, not among the current `models`: the person did not choose it, so it was not used. Never pass it again, whether it came from your own knowledge, an earlier call or an earlier session."
const NEEDS_CHOICE =
  "Nothing was started yet. In ONE short message, ask the person what `missing` lists: for `folder`, which folder or repository it works in (offer the `sharedFolders` names; a repository they name that is not shared is fine, pass it as `folder` or its git URL as `repo` and follow that result), or whether it needs none; for `model`, which model runs it (offer the `models` by their `label`, never ids). Ask only what `missing` lists: never ask again what the person already said for this request. Do not choose for them and do not reuse a model from memory or an earlier request. Then call this tool again with their answers (as `model`, the name they said or its `id`). Do not say it started."

export async function handleRunOnMyComputer(
  params: RunOnMyComputerParams,
  ctx: RunOnMyComputerContext,
): Promise<RunOnMyComputerResult> {
  // The REST start (POST /api/me/node-sessions) refuses a restricted
  // (device-flow) session (assertUnrestrictedSession): its turn is refused too.
  if (currentRunContext()?.sessionRestricted) {
    return { status: "refused", reason: "restricted_session", instruction: RESTRICTED }
  }
  const agentId = ctx.actingAgentId ?? currentRunContext()?.agentId ?? null
  if (!agentId) return { status: "refused", reason: "no_agent", instruction: REFUSED }
  const threadId = ctx.agentExecutionThreadId
  if (!threadId) return { status: "refused", reason: "no_conversation", instruction: REFUSED }
  if (params.folder !== undefined && params.repo !== undefined) {
    return {
      status: "refused",
      reason: "folder_and_repo",
      instruction: `${REFUSED} Give either a folder or a repo, not both.`,
    }
  }

  // The person's own nodes (folder names, no paths) and their presence.
  const candidates = await loadNodeCandidates(ctx.orgId, ctx.userId)
  if (candidates.length === 0) {
    // A demo workspace's recorded laptop, when the person has no computer of
    // their own: it takes the request and plays its recorded session.
    const recorded = await runOnRecordedLaptop(ctx, agentId, threadId)
    if (recorded) return recorded
    return { status: "refused", reason: "no_node", instruction: NO_NODE }
  }
  const shared = new Map<string, FolderRef>()
  for (const c of candidates) for (const f of c.folders) shared.set(f.name, f)
  const folders = [...shared.values()]

  // The person chooses where it works and which model runs it, never a
  // default: a dispatch with neither ran a repository task in the agent's
  // empty node folder on the cheapest model. "Start again" replays a choice
  // already made (and older cards carry no model), so it is not asked twice.
  if (!ctx.retry) {
    const missing: Array<"folder" | "model"> = []
    if (params.folder === undefined && params.repo === undefined && params.noFolder !== true) {
      missing.push("folder")
    }
    if (!params.model?.trim()) missing.push("model")
    if (missing.length > 0) {
      const pick = pickNode(candidates, null)
      return {
        status: "refused",
        reason: "needs_choice",
        missing,
        sharedFolders: folders.map((f) => f.name).sort(),
        offered: pick.ok ? pick.node.models.map((m) => m.id) : [],
        models: pick.ok ? namedModels(pick.node.models) : [],
        instruction: NEEDS_CHOICE,
      }
    }
    // The agent is offered the current models only: an older id it passes is
    // not the person's choice (it copied an earlier call, or wrote one from
    // its own knowledge). Asked before anything else, so no card ever carries
    // it for "Start again" to replay.
    const model = params.model as string
    const answers = candidates.map((c) => resolveAgentModel(c, model))
    if (!answers.some((a) => a.ok) && answers.some((a) => !a.ok && a.legacy)) {
      return needsModelChoice(candidates, folders)
    }
  }

  let folderName: string | null = null
  let repo: string | null = null
  if (params.folder !== undefined) {
    const resolved = resolveFolder(folders, params.folder)
    if (!resolved.ok) {
      return await notShared(params, ctx, agentId, threadId, candidates, folders, {
        name: params.folder,
        candidates: resolved.candidates,
      })
    }
    folderName = resolved.folder.name
  } else if (params.repo !== undefined) {
    const resolved = resolveRepo(params.repo, folders)
    if (!resolved.ok) {
      return await notShared(params, ctx, agentId, threadId, candidates, folders, {
        name: params.repo,
        candidates: resolved.candidates,
      })
    }
    if ("url" in resolved) {
      repo = resolved.url
    } else {
      folderName = resolved.folderName
      repo = resolved.folderName
    }
  }

  const pick = pickNode(candidates, folderName)
  if (!pick.ok) return { status: "refused", reason: "no_node", instruction: NO_NODE }
  const node = pick.node

  const [agent] = await ctx.db
    .select({ displayName: agents.displayName, modelPreference: agents.modelPreference })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)))
    .limit(1)
  // "Start again" replays the person's own earlier choice: it may name an
  // older version the node still runs. The agent's own call never does.
  const model =
    params.model && !ctx.retry
      ? resolveAgentModel(node, params.model)
      : resolveModel(node, {
          requested: params.model ? modelIdForName(node.runs, params.model) : null,
          agentPreference: agent?.modelPreference ?? null,
        })
  if (!model.ok && "legacy" in model && model.legacy) {
    return needsModelChoice([node], folders)
  }
  if (!model.ok) {
    return {
      status: "refused",
      reason: "model_unavailable",
      offered: model.offered,
      models: namedModels(node.models),
      instruction: NAME_MODELS,
    }
  }

  // S23: a level the chosen model does not offer is refused with the ones it does.
  if (params.effort !== undefined) {
    const efforts = await modelEfforts(ctx, node.nodeId, model.model)
    if (efforts && !efforts.includes(params.effort)) {
      return {
        status: "refused",
        reason: "effort_unavailable",
        efforts,
        instruction: `${REFUSED} The model ${model.model} does not offer the reasoning level "${params.effort}". It offers: ${efforts.length > 0 ? efforts.join(", ") : "none (it runs at its default)"}. Tell the person and ask which level to use, or call again without \`effort\` for the model's default; never pick one for them.`,
      }
    }
  }

  // A18, K24: the job and its card carry what this turn has already read,
  // so neither is ever readable more widely than the conversation that asked.
  const sourceRequiredScopes = agentPostRequiredScopes(ctx)
  if (sourceRequiredScopes === null) {
    return { status: "refused", reason: "scope_unknown", instruction: REFUSED }
  }

  // D24: the agent's profile level, whatever the request said.
  const { level } = await loadNodeProfile(ctx.orgId, ctx.userId, agentId)
  // P1-walk D5: a level above what this node pinned, with no confirmation the
  // node will consume at claim, would fail there after this tool answered
  // "started". It is refused here, where the agent can say why.
  if (!(await nodeAdmitsLevel(ctx, node.nodeId, agentId, level))) {
    return { status: "refused", reason: "level_unconfirmed", instruction: LEVEL_UNCONFIRMED }
  }
  const folderPath = folderName
    ? await resolveFolderOnNode(ctx.orgId, node.nodeId, { folderName })
    : null
  const title = sessionTitle(params.task) || "Session"
  let sessionId: string
  try {
    const job = await createNodeJob({
      orgId: ctx.orgId,
      ownerUserId: ctx.userId,
      agentId,
      threadId,
      source: "dispatch",
      sourceRef: currentRunContext()?.turnMessageId ?? null,
      runsOn: "node",
      prompt: params.task,
      sourceRequiredScopes,
      targetNodeId: node.nodeId,
      session: {
        source: "dispatch",
        configKind: "owner",
        folderName,
        folderPath,
        repo,
        model: model.model,
        level,
        effort: params.effort ?? null,
        autonomy: params.autonomy ?? "guided",
        finishWith: params.finishWith ?? null,
        title,
        sourceThreadId: threadId,
      },
    })
    sessionId = job.sessionId as string
  } catch (err) {
    if (err instanceof NodeJobRefusedError) {
      return { status: "refused", reason: "source_scope", instruction: REFUSED }
    }
    throw err
  }

  // Approved from its card: that card turns into this session's card, so the approval names the
  // session and nothing else is posted. Should that fail, the usual card is posted instead.
  if (ctx.approvalRequestId && (await nameApprovedSession(ctx, sessionId, node.name))) {
    return {
      status: "started",
      sessionId,
      on: node.name,
      nodeOnline: node.online,
      folder: folderName,
      model: model.model,
      level,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.autonomy ? { autonomy: params.autonomy } : {}),
      ...(params.finishWith ? { finishWith: params.finishWith } : {}),
      say: `Started on ${node.name}.`,
      instruction: STARTED,
    }
  }

  // S11: the one card in this conversation, through the turn's own write.
  const card = await persistAgentTurn({
    // A card in the middle of the turn, not its end: it notifies nobody.
    endsTurn: false,
    write: (fn) => fn(ctx.db),
    orgId: ctx.orgId,
    userId: ctx.userId,
    threadId,
    content: `Started on ${node.name}: ${title}`,
    agentId,
    ...(agent?.displayName ? { agentAuthorLabel: agent.displayName } : {}),
    requiredScopes: sourceRequiredScopes,
    metadata: { kind: "node_session", sessionId, nodeName: node.name },
  })
  if (card) {
    await setSessionSourceMessage(ctx.orgId, sessionId, { threadId, messageId: card.id })
  }

  return {
    status: "started",
    sessionId,
    on: node.name,
    nodeOnline: node.online,
    folder: folderName,
    model: model.model,
    level,
    ...(params.effort ? { effort: params.effort } : {}),
    ...(params.autonomy ? { autonomy: params.autonomy } : {}),
    ...(params.finishWith ? { finishWith: params.finishWith } : {}),
    say: `Started on ${node.name}. Follow it in the card above.`,
    instruction: STARTED,
  }
}

/**
 * The demo's recorded laptop (`nodes.simulated`, only in a demo org, created
 * when the developer scenario starts): the request is handed to it as a real
 * dispatch, from this agent and this conversation, and it plays its recorded
 * session (modules/demo/replay) instead of running anything. Its folder,
 * model and level are the recording's, so nothing is asked first. The card
 * and the answer are the ones a real computer's dispatch gives. Null when the
 * person has no recorded laptop: the usual refusal follows.
 */
async function runOnRecordedLaptop(
  ctx: RunOnMyComputerContext,
  agentId: string,
  threadId: string,
): Promise<RunOnMyComputerResult | null> {
  const laptop = await recordedLaptopOf(ctx.orgId, ctx.userId)
  if (!laptop) return null
  const sourceRequiredScopes = agentPostRequiredScopes(ctx)
  if (sourceRequiredScopes === null) {
    return { status: "refused", reason: "scope_unknown", instruction: REFUSED }
  }
  const started = await startReplay({
    orgId: ctx.orgId,
    ownerUserId: ctx.userId,
    dispatch: { agentId, threadId, sourceRequiredScopes },
  })
  const recording = await recordingOf(ctx.orgId)
  const answer: RunOnMyComputerResult = {
    status: "started",
    sessionId: started.sessionId,
    on: laptop.name,
    nodeOnline: true,
    folder: recording.repo,
    model: recording.model,
    level: "strict",
    say: `Started on ${laptop.name}. Follow it in the card above.`,
    instruction: STARTED,
  }
  if (ctx.approvalRequestId && (await nameApprovedSession(ctx, started.sessionId, laptop.name))) {
    return { ...answer, say: `Started on ${laptop.name}.` }
  }
  const [agent] = await ctx.db
    .select({ displayName: agents.displayName })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)))
    .limit(1)
  const card = await persistAgentTurn({
    // A card in the middle of the turn, not its end: it notifies nobody.
    endsTurn: false,
    write: (fn) => fn(ctx.db),
    orgId: ctx.orgId,
    userId: ctx.userId,
    threadId,
    content: `Started on ${laptop.name}: ${recording.title}`,
    agentId,
    ...(agent?.displayName ? { agentAuthorLabel: agent.displayName } : {}),
    requiredScopes: sourceRequiredScopes,
    metadata: { kind: "node_session", sessionId: started.sessionId, nodeName: laptop.name },
  })
  if (card) {
    await setSessionSourceMessage(ctx.orgId, started.sessionId, { threadId, messageId: card.id })
  }
  return answer
}

/** needs_choice for the model only, listing the current models: nothing started. */
function needsModelChoice(
  nodes: Awaited<ReturnType<typeof loadNodeCandidates>>,
  folders: FolderRef[],
): RunOnMyComputerResult {
  const pick = pickNode(nodes, null)
  return {
    status: "refused",
    reason: "needs_choice",
    missing: ["model"],
    sharedFolders: folders.map((f) => f.name).sort(),
    offered: pick.ok ? pick.node.models.map((m) => m.id) : [],
    models: pick.ok ? namedModels(pick.node.models) : [],
    instruction: `${NOT_CURRENT_MODEL} ${NEEDS_CHOICE}`,
  }
}

/** The offered models as the agent offers them to the person: by name, the id beside it. */
function namedModels(models: ReadonlyArray<{ id: string; label?: string }>) {
  return models.map((m) => ({ id: m.id, label: m.label?.trim() || m.id }))
}

/**
 * Record on the approval that started it which session it started (`metadata.nodeSessionId`), so
 * its card in the conversation opens that session. Only the requester's own approval of this tool.
 */
async function nameApprovedSession(
  ctx: RunOnMyComputerContext,
  sessionId: string,
  nodeName: string,
): Promise<boolean> {
  const approvalId = ctx.approvalRequestId as string
  try {
    const updated = await withPrivilegedDb(ctx.orgId, "nodes:approved-dispatch-session", (tx) =>
      tx
        .update(approvalRequests)
        .set({
          metadata: sql`${approvalRequests.metadata} || ${JSON.stringify({
            nodeSessionId: sessionId,
            nodeName,
          })}::jsonb`,
        })
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.orgId, ctx.orgId),
            eq(approvalRequests.requestedBy, ctx.userId),
            eq(approvalRequests.toolName, "kernel:run_on_my_computer"),
          ),
        )
        .returning({ id: approvalRequests.id }),
    )
    return updated.length === 1
  } catch (err) {
    log.error(
      { err, approvalRequestId: approvalId, sessionId, orgId: ctx.orgId },
      "run_on_my_computer: could not name the session on its approval; posting the session card",
    )
    return false
  }
}

/**
 * The approval card of a dispatch: what runs, on which computer, where and with which model.
 * `subtitle` is the computer's name (the card shows it as such), absent when none can take it.
 */
export async function summarizeRunOnMyComputer(
  params: unknown,
  ctx: { orgId: string; userId: string },
): Promise<{ kind: string; title: string; subtitle?: string; lines: string[] }> {
  const p = (params ?? {}) as Partial<RunOnMyComputerParams>
  const candidates = await loadNodeCandidates(ctx.orgId, ctx.userId)
  const folders = candidates.flatMap((c) => c.folders)
  let folderName: string | null = null
  if (typeof p.folder === "string") {
    const resolved = resolveFolder(folders, p.folder)
    if (resolved.ok) folderName = resolved.folder.name
  } else if (typeof p.repo === "string") {
    const resolved = resolveRepo(p.repo, folders)
    if (resolved.ok && "folderName" in resolved) folderName = resolved.folderName
  }
  const pick = pickNode(candidates, folderName)
  // No computer of their own: a demo workspace's recorded laptop takes it.
  const recorded = candidates.length === 0 ? await recordedLaptopOf(ctx.orgId, ctx.userId) : null
  const nodeName = pick.ok ? pick.node.name : (recorded?.name ?? null)
  const where =
    typeof p.folder === "string"
      ? `Folder: ${p.folder}`
      : typeof p.repo === "string"
        ? `Repository: ${p.repo}`
        : "No folder"
  return {
    kind: "node_dispatch",
    title: nodeName ? `Run on ${nodeName}` : "Run on your computer",
    ...(nodeName ? { subtitle: nodeName } : {}),
    lines: [
      `Task: ${typeof p.task === "string" ? p.task : ""}`,
      where,
      ...(typeof p.model === "string" && p.model ? [`Model: ${p.model}`] : []),
    ],
  }
}

/**
 * A folder (or repo name) the person's computers do not share. Several shared
 * names close to it: ask which (the agent never guesses). None: look it up on
 * the person's node and answer how to share it, or to clone it (FolderHelp),
 * and post one card in the conversation, from which the person fixes it and
 * starts the same request again, from any device.
 */
async function notShared(
  params: RunOnMyComputerParams,
  ctx: RunOnMyComputerContext,
  agentId: string,
  threadId: string,
  nodes: Awaited<ReturnType<typeof loadNodeCandidates>>,
  folders: FolderRef[],
  raw: { name: string; candidates: string[] },
): Promise<RunOnMyComputerResult> {
  // Shown on the card and to the agent: never a control or bidi character.
  const asked = { ...raw, name: cleanFolderName(raw.name) }
  const lower = asked.name.trim().toLowerCase()
  const near = lower.length > 0 && folders.some((f) => f.name.toLowerCase().includes(lower))
  if (near || ctx.retry) {
    return {
      status: "refused",
      reason: "folder_unresolved",
      candidates: asked.candidates,
      instruction: ASK_FOLDER,
    }
  }
  const help = await folderHelp({
    orgId: ctx.orgId,
    ownerUserId: ctx.userId,
    nodes,
    name: asked.name,
  })
  const node = nodes.find((n) => n.name === help.lookup.node) ?? nodes[0]
  const sourceRequiredScopes = agentPostRequiredScopes(ctx)
  let card = false
  if (sourceRequiredScopes !== null && node) {
    const [agent] = await ctx.db
      .select({ displayName: agents.displayName })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)))
      .limit(1)
    const posted = await persistAgentTurn({
      // A card in the middle of the turn, not its end: it notifies nobody.
      endsTurn: false,
      write: (fn) => fn(ctx.db),
      orgId: ctx.orgId,
      userId: ctx.userId,
      threadId,
      content: `Not started on ${node.name}: "${asked.name}" is not shared with Liaison yet.`,
      agentId,
      ...(agent?.displayName ? { agentAuthorLabel: agent.displayName } : {}),
      requiredScopes: sourceRequiredScopes,
      metadata: {
        kind: "node_dispatch_blocked",
        ownerUserId: ctx.userId,
        nodeId: node.nodeId,
        nodeName: node.name,
        name: asked.name,
        field: params.folder !== undefined ? "folder" : "repo",
        task: params.task,
        ...(params.model ? { model: params.model } : {}),
        agentId,
      },
    })
    card = posted !== null && posted !== undefined
  }
  return {
    status: "refused",
    reason: "folder_unresolved",
    candidates: [],
    sharedFolders: help.sharedFolders,
    lookup: help.lookup,
    howToShare: help.howToShare,
    ...(help.cloneOffer ? { cloneOffer: help.cloneOffer } : {}),
    instruction: card
      ? `${help.instruction} A card in this conversation also lets the person open the Folders section ("Fix it") and start this same request again ("Start again") once it is shared, from any device.`
      : help.instruction,
  }
}

/**
 * The reasoning levels a node published for a model (S25), or null when it
 * published none for it (an older desktop): then no level is refused here.
 */
async function modelEfforts(
  ctx: RunOnMyComputerContext,
  nodeId: string,
  modelId: string,
): Promise<EffortLevel[] | null> {
  const [caps] = await ctx.db
    .select({ models: nodeCapabilities.models })
    .from(nodeCapabilities)
    .where(and(eq(nodeCapabilities.nodeId, nodeId), eq(nodeCapabilities.orgId, ctx.orgId)))
    .limit(1)
  const entry = ((caps?.models ?? []) as Array<{ id?: unknown; efforts?: unknown }>).find(
    (m) => m && m.id === modelId,
  )
  return Array.isArray(entry?.efforts) ? (entry.efforts as EffortLevel[]) : null
}

/**
 * Whether the node will start this agent at `level` (D41, D42): at or below
 * the level it published as pinned for the agent (Strict when none), or above
 * it with an attached, unconsumed, unexpired `profile_raise` for that level,
 * which the claim hands the node to consume.
 */
async function nodeAdmitsLevel(
  ctx: RunOnMyComputerContext,
  nodeId: string,
  agentId: string,
  level: NodeLevel,
): Promise<boolean> {
  if (level === "strict") return true
  const [caps] = await ctx.db
    .select({ levelPins: nodeCapabilities.levelPins })
    .from(nodeCapabilities)
    .where(and(eq(nodeCapabilities.nodeId, nodeId), eq(nodeCapabilities.orgId, ctx.orgId)))
    .limit(1)
  const pinned = (caps?.levelPins ?? []).find((p) => p.agentId === agentId)?.level ?? "strict"
  if (levelRank(level) <= levelRank(pinned)) return true
  const [raise] = await ctx.db
    .select({ id: nodeLevelConfirmations.id })
    .from(nodeLevelConfirmations)
    .where(
      and(
        eq(nodeLevelConfirmations.orgId, ctx.orgId),
        eq(nodeLevelConfirmations.ownerUserId, ctx.userId),
        eq(nodeLevelConfirmations.nodeId, nodeId),
        eq(nodeLevelConfirmations.agentId, agentId),
        eq(nodeLevelConfirmations.purpose, "profile_raise"),
        eq(nodeLevelConfirmations.level, level),
        isNull(nodeLevelConfirmations.consumedAt),
        isNotNull(nodeLevelConfirmations.attachedAt),
        gt(nodeLevelConfirmations.expiresAt, sql`now()`),
      ),
    )
    .limit(1)
  return raise !== undefined
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Context providers: an app declares a read-only tool (manifest
 * `contextProviders: [{on, tool, scope, loadTools?}]`) that adds a few lines
 * about the entity a turn is about. The subject is the record in view, plus
 * the record the conversation was made for when that is another one.
 *
 * Each provider passes five gates in order; a failure leaves its lines out and
 * the turn goes on:
 *   1. the turn's effective scopes (agent ceiling and person) hold its scope;
 *   2. the subject reads under the actor's row security;
 *   3. its tool runs as the actor through `executeToolCore`, in a read-only run,
 *      so a write it attempts through its bridge is refused;
 *   4. one deadline over every provider of the turn (no retry);
 *   5. what it returned is fenced as outside text, and all providers together
 *      contribute at most `CONTEXT_PROVIDER_MAX_BYTES`, in manifest order, then
 *      app name.
 *
 * The lines are a read of app data: the turn records each provider's scope and
 * the thread is marked tainted, as the customer block does. Providers are found
 * in the in-memory manifest registry, so an org where no provider matches the
 * subject runs no query at all. `CONTEXT_PROVIDERS_DISABLED=1` turns the fan-out
 * off for an instance in trouble.
 */

import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { wrapExternalContent } from "~/lib/external-content"
import { rootLogger } from "~/lib/logger"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import type { TurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { isAppUnavailableFor } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"
import { canReadThreadAnchorEntity } from "~/modules/threads/thread-anchor"

const log = rootLogger.child({ module: "context-providers" })

export const CONTEXT_PROVIDER_BUDGET_MS = 1_500
export const CONTEXT_PROVIDER_MAX_BYTES = 2_048
export const CONTEXT_PROVIDER_MAX_LINES = 10

export interface ContextProviderDecl {
  on: string[]
  tool: string
  scope: string
  loadTools?: string[]
}

export interface ContextSubject {
  app: string
  entityType: string
  entityId: string
}

export interface ContextProviderInput {
  orgId: string
  actor: UserContext
  /** The turn's effective scopes (agent ceiling and person). */
  grants: readonly string[]
  currentView?: { tabType: string; entityId: string }
  /** The record the conversation was made for (`threads.created_from`). */
  createdFrom?: { app?: string | null; entityType?: string | null; entityId?: string | null } | null
  /**
   * Of a provider's `loadTools`, the ones this turn may call, as SDK names.
   * Absent: the block names no tool and loads none.
   */
  callableTools?: (app: string, toolNames: readonly string[]) => ReadonlySet<string>
  budgetMs?: number
}

export interface ContextProviderBlocks {
  /** The tail text: one fenced part per provider that answered. */
  block: string
  /** Each answering provider's scope, recorded on the turn. */
  scopes: string[]
  /** SDK names of the tools the block names, to load for the turn. */
  loadTools: string[]
}

interface Candidate {
  app: string
  decl: ContextProviderDecl
  subject: ContextSubject
}

interface Answer {
  candidate: Candidate
  lines: string[]
  sourceLabel: string
  syncedAt?: string
  /** Every scope the provider's tool requires, with the declared one: what the lines were read under. */
  scopes: string[]
}

function subjectOf(tabType: string, entityId: string): ContextSubject | null {
  const sep = tabType.indexOf(":")
  if (sep <= 0 || sep === tabType.length - 1 || !entityId) return null
  return { app: tabType.slice(0, sep), entityType: tabType.slice(sep + 1), entityId }
}

/** The view, then the conversation's origin when it is another record. */
function subjectsOf(input: ContextProviderInput): ContextSubject[] {
  const out: ContextSubject[] = []
  const view = input.currentView
    ? subjectOf(input.currentView.tabType, input.currentView.entityId)
    : null
  if (view) out.push(view)
  const origin = input.createdFrom
  if (origin?.app && origin.entityType && origin.entityId) {
    const same =
      view &&
      view.app === origin.app &&
      view.entityType === origin.entityType &&
      view.entityId === origin.entityId
    if (!same)
      out.push({ app: origin.app, entityType: origin.entityType, entityId: origin.entityId })
  }
  return out
}

/** Every declared provider for these subjects, in manifest order, then app name. No query. */
function candidatesFor(input: ContextProviderInput, subjects: ContextSubject[]): Candidate[] {
  const byApp: [string, ContextProviderDecl[]][] = []
  for (const [[, app], manifest] of appBridgeManifestRegistry.entriesOf(input.orgId)) {
    const decls = manifest.contextProviders
    if (decls && decls.length > 0) byApp.push([app, decls])
  }
  if (byApp.length === 0) return []
  byApp.sort(([a], [b]) => a.localeCompare(b))
  const out: Candidate[] = []
  for (const subject of subjects) {
    const kind = `${subject.app}:${subject.entityType}`
    for (const [app, decls] of byApp) {
      if (isAppUnavailableFor(input.orgId, app, input.actor.userId)) continue
      for (const decl of decls) {
        if (decl.on.includes(kind)) out.push({ app, decl, subject })
      }
    }
  }
  return out
}

/** The provider result contract: `{lines: string[], source: {label, syncedAt?}} | null`. */
function readAnswer(candidate: Candidate, data: unknown, scopes: string[]): Answer | null {
  if (!data || typeof data !== "object") return null
  const { lines, source } = data as { lines?: unknown; source?: unknown }
  if (!Array.isArray(lines)) return null
  const kept = lines
    .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    .slice(0, CONTEXT_PROVIDER_MAX_LINES)
  if (kept.length === 0) return null
  const src = (source ?? {}) as { label?: unknown; syncedAt?: unknown }
  const sourceLabel =
    typeof src.label === "string" && src.label.trim() ? src.label.trim() : candidate.app
  return {
    candidate,
    lines: kept,
    sourceLabel,
    ...(typeof src.syncedAt === "string" ? { syncedAt: src.syncedAt } : {}),
    scopes,
  }
}

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a character. */
export function clipToUtf8Bytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).byteLength <= maxBytes) return text
  if (maxBytes <= 3) return ""
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(text.slice(0, mid)).byteLength <= maxBytes - 3) lo = mid
    else hi = mid - 1
  }
  // A lone high surrogate at the cut would encode as a replacement character.
  const code = text.charCodeAt(lo - 1)
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo -= 1
  return `${text.slice(0, lo)}…`
}

async function ask(
  input: ContextProviderInput,
  candidate: Candidate,
  signal: AbortSignal,
  visible: (subject: ContextSubject) => Promise<boolean>,
): Promise<Answer | null> {
  const { app, decl, subject } = candidate
  // Gate 1: no scope, no query.
  if (!hasScope(decl.scope, [...input.grants])) return null
  const tool = toolRegistry.get([input.orgId, app, decl.tool])
  if (tool?.readOnly !== true || tool.gated) return null
  // Gate 2: the subject reads under the actor's row security.
  if (!(await visible(subject)) || signal.aborted) return null
  // Gate 3: as the actor, in a read-only run, under the shared deadline.
  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const outer = runContextStore.getStore()
  const runId = crypto.randomUUID()
  const envelope = await runContextStore.run(
    {
      runId,
      parentRunId: outer?.runId ?? null,
      rootRunId: outer?.rootRunId ?? runId,
      nestingDepth: (outer?.nestingDepth ?? 0) + 1,
      background: true,
      readOnlyTools: true,
    },
    () =>
      executeToolCore({
        toolName: `${app}:${decl.tool}`,
        orgId: input.orgId,
        actor: { ...input.actor, scopes: [...input.grants] },
        params: { subject },
        origin: "in-app-agent",
        signal,
        readOnlyRun: true,
      }),
  )
  if (!("data" in envelope)) {
    const code = "error" in envelope ? envelope.error.code : "blocked"
    log.info({ app, tool: decl.tool, code }, "context provider left out")
    return null
  }
  // The lines are stamped with all the tool may read, not only the scope the declaration names.
  return readAnswer(candidate, envelope.data, [
    ...new Set([decl.scope, ...resolveRequiredScopes(tool)]),
  ])
}

function render(
  answers: Answer[],
  callableTools: ContextProviderInput["callableTools"],
): ContextProviderBlocks | null {
  let room = CONTEXT_PROVIDER_MAX_BYTES
  const parts: string[] = []
  const scopes = new Set<string>()
  const loadTools: string[] = []
  const enc = new TextEncoder()
  for (const answer of answers) {
    if (room <= 0) break
    const body = clipToUtf8Bytes(answer.lines.join("\n"), room)
    if (!body) break
    room -= enc.encode(body).byteLength
    const { app, decl, subject } = answer.candidate
    const named =
      callableTools && decl.loadTools?.length ? [...callableTools(app, decl.loadTools)] : []
    loadTools.push(...named)
    const synced = answer.syncedAt ? `, synced ${answer.syncedAt}` : ""
    parts.push(
      [
        `From ${answer.sourceLabel} (app ${app}${synced}), about ${subject.app}:${subject.entityType} ${subject.entityId}:`,
        wrapExternalContent(body),
        ...(named.length > 0 ? [`Loaded for this: ${named.join(", ")}`] : []),
      ].join("\n"),
    )
    for (const scope of answer.scopes) scopes.add(scope)
  }
  if (parts.length === 0) return null
  return { block: parts.join("\n\n"), scopes: [...scopes], loadTools }
}

/**
 * The provider lines for this turn, or null. Never throws, and never outlasts
 * its budget: providers that have not answered by then are left out.
 */
export async function loadContextProviderBlocks(
  input: ContextProviderInput,
): Promise<ContextProviderBlocks | null> {
  if (process.env.CONTEXT_PROVIDERS_DISABLED === "1") return null
  const subjects = subjectsOf(input)
  if (subjects.length === 0) return null
  const candidates = candidatesFor(input, subjects)
  if (candidates.length === 0) return null

  const visibility = new Map<string, Promise<boolean>>()
  const visible = (subject: ContextSubject): Promise<boolean> => {
    const key = `${subject.app}:${subject.entityType}:${subject.entityId}`
    let seen = visibility.get(key)
    if (!seen) {
      seen = withRlsContext(input.actor, (tx) =>
        canReadThreadAnchorEntity(tx, input.orgId, subject),
      ).catch(() => false)
      visibility.set(key, seen)
    }
    return seen
  }

  const controller = new AbortController()
  const settled: (Answer | null)[] = candidates.map(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("context provider budget exceeded"))
      resolve()
    }, input.budgetMs ?? CONTEXT_PROVIDER_BUDGET_MS)
  })
  const work = Promise.all(
    candidates.map((candidate, i) =>
      ask(input, candidate, controller.signal, visible)
        .then((answer) => {
          if (!controller.signal.aborted) settled[i] = answer
        })
        .catch((err: unknown) => {
          log.warn(
            { err, app: candidate.app, tool: candidate.decl.tool },
            "context provider failed",
          )
        }),
    ),
  )
  try {
    await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
  const answers = settled.filter((a): a is Answer => a !== null)
  return render(answers, input.callableTools)
}

/**
 * Append the provider lines to the turn's tail, record each provider's scope
 * on the turn and mark the thread tainted. Returns true when lines were added.
 */
export async function applyContextProviderBlocks(input: {
  blocks: ContextProviderBlocks | null
  tailLines: string[]
  turnScopeAccumulator?: TurnScopeAccumulator
  markTainted: () => Promise<void>
}): Promise<boolean> {
  if (!input.blocks) return false
  input.tailLines.push(input.blocks.block)
  input.turnScopeAccumulator?.recordInjected(input.blocks.scopes)
  await input.markTainted().catch((err) => log.warn({ err }, "could not mark the thread tainted"))
  return true
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionFeedResponse, AttentionItem, AttentionProviderError } from "@liaison/shared"
import type { RlsClient } from "~/db"
import type { ActorContext } from "~/db/rls"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { appsLogger as log } from "~/lib/logger"
import { readStandingInFor } from "~/modules/approvals/route-world"
import { appBridgeManifest, attentionItemsRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { isAppOffForOrg, isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { isBundleLoadError, loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { exportOnlyBundle, useFullBundle } from "~/modules/apps/sandbox/bundle-shake"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { attentionSourceApp } from "~/modules/attention/attention-source-app"
import { hasScope } from "~/modules/permissions/permissions"

const PROVIDER_TIMEOUT_MS = 2000
const PROVIDER_ITEM_CAP = 200
const TIMEOUT_SENTINEL = "__attention_aggregator_timeout__"

interface RegistryEntry {
  handler: string
  scope?: string
  bundlePath: string
  trusted: boolean
  /** Declared `passesOn`: also returns the items of the people the viewer stands in for. */
  passesOn?: boolean
}

function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  if (b.urgency !== a.urgency) return b.urgency - a.urgency
  return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
}

/**
 * Collapse items that target the same entity into one row. Providers emit one
 * item per matching rule, so a single ticket can surface as awaiting_agent AND
 * unassigned AND sla_risk — three feed rows for one thing to do. The input is
 * already sorted, so the first occurrence is the highest-urgency one; the
 * merged-away kinds land in `alsoKinds` for the UI to badge.
 */
function dedupeByEntity(sorted: AttentionItem[]): AttentionItem[] {
  const byEntity = new Map<string, AttentionItem>()
  const out: AttentionItem[] = []
  for (const item of sorted) {
    const key = `${item.app}\u0000${item.entity}\u0000${item.entityId}`
    const existing = byEntity.get(key)
    if (!existing) {
      byEntity.set(key, item)
      out.push(item)
      continue
    }
    if (item.kind !== existing.kind && !existing.alsoKinds?.includes(item.kind)) {
      existing.alsoKinds = [...(existing.alsoKinds ?? []), item.kind]
    }
  }
  return out
}

/**
 * One row per approval. The kernel's approvals provider lists every pending
 * request the caller may decide, with its real deadline and the record of a
 * failed execution. An app may ALSO surface its own view of the same request
 * (social lists the finding a drafted reply is waiting on, routed to
 * `decide_approval` for that request): two cards for one decision, the app's
 * copy without the request's expiry, so it read "1h left" on a reply with a
 * week to go. Items routed to the same approval collapse onto the kernel's
 * item when there is one, else onto the first; a merged-away kind is noted in
 * `alsoKinds` as in `dedupeByEntity`.
 */
export function dedupeByApproval(sorted: AttentionItem[]): AttentionItem[] {
  const keeper = new Map<string, AttentionItem>()
  for (const item of sorted) {
    if (item.action?.type !== "decide_approval") continue
    const id = item.action.approvalId
    const current = keeper.get(id)
    const isKernel = item.app === "kernel" && item.entity === "approval_request"
    if (!current || (isKernel && current.app !== "kernel")) keeper.set(id, item)
  }
  const out: AttentionItem[] = []
  for (const item of sorted) {
    if (item.action?.type !== "decide_approval") {
      out.push(item)
      continue
    }
    const kept = keeper.get(item.action.approvalId)
    if (kept === item) {
      out.push(item)
      continue
    }
    if (kept && item.kind !== kept.kind && !kept.alsoKinds?.includes(item.kind)) {
      kept.alsoKinds = [...(kept.alsoKinds ?? []), item.kind]
    }
  }
  return out
}

type KernelHandler = (
  tx: RlsClient,
  orgId: string,
  userId: string,
  forUserIds?: readonly string[],
) => Promise<AttentionItem[]>

/**
 * One trusted in-process kernel provider (no sandbox), in its own savepoint of
 * the feed's shared RLS transaction: same role, same verified context, and a
 * failure on the database rolls back this provider only.
 */
async function invokeKernelProvider(
  tx: RlsClient,
  reg: RegistryEntry,
  orgId: string,
  userId: string,
  forUserIds: readonly string[],
): Promise<AttentionItem[]> {
  const mod = await import(reg.bundlePath)
  const handler = mod[reg.handler] as KernelHandler | undefined
  if (typeof handler !== "function") {
    throw new Error(`Kernel attention handler "${reg.handler}" not exported from ${reg.bundlePath}`)
  }
  // Only a provider that declared `passesOn` hears of anyone but the viewer.
  const passOn = reg.passesOn === true && forUserIds.length > 0 ? [forUserIds] : []
  return tx.transaction((sp) => handler(sp as unknown as RlsClient, orgId, userId, ...passOn))
}

async function invokeManifestProvider(
  reg: RegistryEntry,
  appName: string,
  actor: ActorContext,
  orgId: string,
  forUserIds: readonly string[],
): Promise<AttentionItem[]> {
  const source = await loadBundle(reg.bundlePath)
  // Only a provider that declared `passesOn` hears of anyone but the viewer.
  const passOn =
    reg.passesOn === true && forUserIds.length > 0 ? { forUserIds: [...forUserIds] } : {}
  const aliasedActor = withAppDimensionAliases(actor, appName)
  const userId = aliasedActor.actorType === "user" ? aliasedActor.userId : "system"
  // The bridge must carry the app's REAL manifest: db_findMany validates every
  // entity/orderBy key against `manifest.schema`, so an empty stub makes every
  // provider db read fail ("Entity not found in app schema").
  const bridgeManifest = appBridgeManifest(orgId, appName)
  if (!bridgeManifest) {
    throw new Error(`No bridge manifest registered for app "${appName}" (org ${orgId})`)
  }
  // Bridge-owned transactions: the attention feed fans out one provider per
  // app on every poll — with an ambient wrap each provider pinned a request-
  // pool connection for its whole sandbox run, a top contributor to the
  // 2026-07-10 interactive pool exhaustion. The session bridge acquires per
  // bridge db call instead.
  const session = createRlsSession(aliasedActor)
  const bridge = createSessionRpcBridge(
    appName,
    userId,
    orgId,
    session,
    bridgeManifest,
    aliasedActor.scopes,
    aliasedActor.actorType,
    undefined,
    { actor: aliasedActor },
  )
  // A sandboxed (untrusted) app's provider runs in the isolated worker pool,
  // like its tools; only trusted code runs on the host's in-process pool.
  if (!reg.trusted) {
    const { getWorkerPool, initWorkerPool } = await import("~/modules/apps/sandbox/worker-pool")
    await initWorkerPool()
    return getWorkerPool().execute({
      bundleSource: source,
      exportName: reg.handler,
      params: { actor: aliasedActor, ...passOn },
      bridge,
      appId: appName,
    }) as Promise<AttentionItem[]>
  }
  // A trusted provider runs the part of its bundle the provider needs (the
  // whole bundle until that is built): QuickJS compiles all of a bundle on
  // every evaluation, and the feed calls each provider on every poll. Still a
  // fresh context per call; see bundle-shake.ts.
  const bundleSource = exportOnlyBundle(source, reg.handler)
  try {
    return (await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: reg.handler,
      params: { actor: aliasedActor, ...passOn },
      bridge,
    })) as AttentionItem[]
  } catch (err) {
    // The export-only bundle failed to load: the next poll runs the full one.
    if (bundleSource !== source && isBundleLoadError(err)) useFullBundle(source, reg.handler)
    throw err
  }
}

export async function aggregateAttentionItems(args: {
  orgId: string
  actor: ActorContext
}): Promise<AttentionFeedResponse> {
  const items: AttentionItem[] = []
  const errors: AttentionProviderError[] = []
  await ensureAppsForOrg(args.orgId)
  // Off apps produce no attention (S19), nor do apps restricted away from the
  // person reading the feed (S20, MGT-11): their own providers are skipped and
  // the kernel providers' items about them (a connection's health, a pending
  // approval of one of their tools) are dropped. Fail-closed on a load error.
  await primeOrgApps(args.orgId)
  const viewerId = args.actor.actorType === "user" ? args.actor.userId : null
  const unavailable = (app: string): boolean =>
    viewerId ? isAppUnavailableFor(args.orgId, app, viewerId) : isAppOffForOrg(args.orgId, app)

  // Build a per-app entry list, preferring per-org entries over wildcard entries
  // when both target the same appName.
  const byApp = new Map<string, { entryOrgId: string; reg: RegistryEntry }>()
  // The kernel's wildcard entries, then this org's: never another org's.
  const candidates = [
    ...attentionItemsRegistry.entriesOf("*"),
    ...attentionItemsRegistry.entriesOf(args.orgId),
  ]
  for (const [[entryOrgId, appName], reg] of candidates) {
    if (entryOrgId !== args.orgId && entryOrgId !== "*") continue
    if (entryOrgId !== "*" && unavailable(appName)) continue
    const existing = byApp.get(appName)
    if (existing && existing.entryOrgId === args.orgId) continue
    byApp.set(appName, { entryOrgId, reg: reg as RegistryEntry })
  }

  const callerScopes = args.actor.actorType === "user" ? args.actor.scopes : ["*"]

  // The people away today who name the viewer next in line, read once and only when a provider
  // passes items on. Unreadable means nobody: the viewer's own feed never waits on it.
  let forUserIds: string[] = []
  if (viewerId && [...byApp.values()].some(({ reg }) => reg.passesOn === true)) {
    forUserIds = await withRlsContext(args.actor, (tx) =>
      readStandingInFor(tx, args.orgId, viewerId),
    ).catch((err: unknown) => {
      log.warn({ err, orgId: args.orgId }, "could not read whom the viewer stands in for")
      return []
    })
  }

  // App providers are independent (each acquires per bridge call) and run in
  // parallel: sequential per-app awaits added N×DB-round-trip latency to
  // every feed fetch (k6 A4 measured 770ms p95 at 50 VUs against the spec'd
  // 300ms). The kernel providers share ONE RLS transaction, one after the
  // other, each in its own savepoint: a transaction each held up to eight
  // request-pool connections per feed poll and paid eight transaction
  // setups, so under a launch's walking visitors the feed alone exhausted
  // the pool and other requests timed out waiting for a connection. A
  // failing provider rolls back its own savepoint only.
  const tasks: Promise<void>[] = []
  const kernelProviders: Array<{ appName: string; reg: RegistryEntry }> = []
  const runProvider = async (
    appName: string,
    providerPromise: Promise<AttentionItem[]>,
  ): Promise<void> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const providerItems = await Promise.race<AttentionItem[]>([
        providerPromise,
        new Promise<AttentionItem[]>((_, rej) => {
          timeoutHandle = setTimeout(() => rej(new Error(TIMEOUT_SENTINEL)), PROVIDER_TIMEOUT_MS)
        }),
      ])
      if (timeoutHandle) clearTimeout(timeoutHandle)

      if (!Array.isArray(providerItems)) {
        errors.push({
          app: appName,
          reason: "error",
          message: "Provider returned non-array attention items",
        })
        return
      }
      // Contract enforcement: a provider emitting malformed items (missing
      // action/summary/id) must degrade to a provider error, never crash
      // the feed UI. The knowledge provider shipped its domestic shape for
      // months undetected because its queue was empty on every deploy.
      const wellFormed = providerItems.filter(
        (i) =>
          i &&
          typeof i === "object" &&
          typeof i.id === "string" &&
          typeof i.entityId === "string" &&
          typeof i.kind === "string" &&
          typeof i.summary === "string" &&
          typeof i.urgency === "number" &&
          i.action &&
          typeof (i.action as { type?: unknown }).type === "string",
      )
      if (wellFormed.length < providerItems.length) {
        errors.push({
          app: appName,
          reason: "error",
          message: `Dropped ${providerItems.length - wellFormed.length} malformed attention item(s)`,
        })
      }
      const sorted = [...wellFormed].sort(compareAttentionItems)
      const sliced = sorted.length > PROVIDER_ITEM_CAP ? sorted.slice(0, PROVIDER_ITEM_CAP) : sorted
      if (sliced.length < providerItems.length) {
        errors.push({
          app: appName,
          reason: "error",
          message: `Provider returned ${providerItems.length} items; truncated to ${PROVIDER_ITEM_CAP}`,
        })
      }
      items.push(...sliced.filter((i) => !unavailable(attentionSourceApp(i))))
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const isTimeout = err instanceof Error && err.message === TIMEOUT_SENTINEL
      const reason: AttentionProviderError["reason"] = isTimeout ? "timeout" : "error"
      const message = isTimeout
        ? "Provider exceeded 2s"
        : err instanceof Error
          ? err.message
          : "unknown"
      log.warn({ app: appName, reason, message }, "Attention provider failed")
      errors.push({ app: appName, reason, message })
    }
  }
  for (const [appName, { entryOrgId, reg }] of byApp.entries()) {
    if (reg.scope) {
      const aliasedScopes = withAppDimensionAliases(args.actor, appName).scopes
      if (!hasScope(reg.scope, aliasedScopes ?? callerScopes)) continue
    }
    if (entryOrgId === "*") kernelProviders.push({ appName, reg })
    else
      tasks.push(
        runProvider(
          appName,
          invokeManifestProvider(reg, appName, args.actor, args.orgId, forUserIds),
        ),
      )
  }
  if (kernelProviders.length > 0) {
    const userId = args.actor.actorType === "user" ? args.actor.userId : ""
    const orgId = args.orgId
    const shared = withRlsContext(args.actor, async (tx) => {
      for (const { appName, reg } of kernelProviders) {
        const run = invokeKernelProvider(tx, reg, orgId, userId, forUserIds)
        await runProvider(appName, run)
        // A provider that timed out may still be running on this connection:
        // the next savepoint starts only once it has settled.
        await run.catch(() => {})
      }
    })
    tasks.push(
      shared.catch((err: unknown) => {
        // No transaction at all (say the pool is full): every kernel provider failed.
        const message = err instanceof Error ? err.message : "unknown"
        log.warn({ reason: "error", message }, "Attention kernel providers failed")
        for (const { appName } of kernelProviders) {
          errors.push({ app: appName, reason: "error", message })
        }
      }),
    )
  }
  await Promise.all(tasks)
  // A calendar question shows its event's title, read now under the viewer's own access.
  const { withLiveCalendarTitles } = await import("~/apps/calendar/away-from-calendar")
  await withLiveCalendarTitles(args.actor, items)

  items.sort(compareAttentionItems)
  return { items: dedupeByEntity(dedupeByApproval(items)), errors }
}

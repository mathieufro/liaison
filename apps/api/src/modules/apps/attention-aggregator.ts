// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionFeedResponse, AttentionItem, AttentionProviderError } from "@liaison/shared"
import type { RlsClient } from "~/db"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { appsLogger as log } from "~/lib/logger"
import { readStandingInFor } from "~/modules/approvals/route-world"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import {
  compareAttentionItems,
  dedupeByEntity,
  normalizeProviderItems,
  readStoredAttention,
} from "~/modules/apps/attention-store"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { isAppOffForOrg, isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { attentionSourceApp } from "~/modules/attention/attention-source-app"
import { hasScope } from "~/modules/permissions/permissions"

// The kernel's own providers (plain server code reading the database) run on
// each feed read, bounded by this; apps' providers never do (attention-store.ts).
const PROVIDER_TIMEOUT_MS = 2000
const TIMEOUT_SENTINEL = "__attention_aggregator_timeout__"

interface RegistryEntry {
  handler: string
  scope?: string
  bundlePath: string
  core: boolean
  /** Declared `passesOn`: also returns the items of the people the viewer stands in for. */
  passesOn?: boolean
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

/**
 * The attention feed. The kernel's providers (approvals, connection health,
 * persisted attention events, ...) are server code and are read live. An app's
 * provider is app code: the feed reads the list stored for the reader the last
 * time the app was woken (attention-store.ts) and runs nothing of the app.
 */
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

  // The people away today who name the viewer next in line, read once and only when a kernel
  // provider passes items on (an app's stored list was built with them, attention-store.ts).
  // Unreadable means nobody: the viewer's own feed never waits on it.
  let forUserIds: string[] = []
  if (
    viewerId &&
    [...byApp.values()].some(({ entryOrgId, reg }) => entryOrgId === "*" && reg.passesOn === true)
  ) {
    forUserIds = await withRlsContext(args.actor, (tx) =>
      readStandingInFor(tx, args.orgId, viewerId),
    ).catch((err: unknown) => {
      log.warn({ err, orgId: args.orgId }, "could not read whom the viewer stands in for")
      return []
    })
  }

  // The kernel providers share ONE RLS transaction, one after the other, each
  // in its own savepoint: a transaction each held up to eight request-pool
  // connections per feed poll and paid eight transaction setups, so under a
  // launch's walking visitors the feed alone exhausted the pool and other
  // requests timed out waiting for a connection. A failing provider rolls
  // back its own savepoint only. The apps' stored lists are read first, in
  // the same transaction.
  const kernelProviders: Array<{ appName: string; reg: RegistryEntry }> = []
  const storedApps: string[] = []
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
      // Contract enforcement: a provider emitting malformed items (missing
      // action/summary/id) must degrade to a provider error, never crash
      // the feed UI. The knowledge provider shipped its domestic shape for
      // months undetected because its queue was empty on every deploy.
      const { items: sliced, error } = normalizeProviderItems(providerItems)
      if (error) errors.push({ app: appName, ...error })
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
    else storedApps.push(appName)
  }
  if (kernelProviders.length > 0 || storedApps.length > 0) {
    const userId = args.actor.actorType === "user" ? args.actor.userId : ""
    const orgId = args.orgId
    try {
      await withRlsContext(args.actor, async (tx) => {
        if (storedApps.length > 0) {
          try {
            const stored = await tx.transaction((sp) =>
              readStoredAttention(sp as unknown as RlsClient, orgId, userId, storedApps),
            )
            for (const [appName, list] of stored) {
              if (list.error) errors.push({ app: appName, ...list.error })
              items.push(...list.items.filter((i) => !unavailable(attentionSourceApp(i))))
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "unknown"
            log.warn({ reason: "error", message }, "Stored app attention unreadable")
            for (const appName of storedApps)
              errors.push({ app: appName, reason: "error", message })
          }
        }
        for (const { appName, reg } of kernelProviders) {
          const run = invokeKernelProvider(tx, reg, orgId, userId, forUserIds)
          await runProvider(appName, run)
          // A provider that timed out may still be running on this connection:
          // the next savepoint starts only once it has settled.
          await run.catch(() => {})
        }
      })
    } catch (err) {
      // No transaction at all (say the pool is full): every provider failed.
      const message = err instanceof Error ? err.message : "unknown"
      log.warn({ reason: "error", message }, "Attention kernel providers failed")
      for (const appName of [...kernelProviders.map((p) => p.appName), ...storedApps]) {
        if (!errors.some((e) => e.app === appName))
          errors.push({ app: appName, reason: "error", message })
      }
    }
  }

  // A calendar question shows its event's title, read now under the viewer's own access.
  const { withLiveCalendarTitles } = await import("~/apps/calendar/away-from-calendar")
  await withLiveCalendarTitles(args.actor, items)

  items.sort(compareAttentionItems)
  return { items: dedupeByEntity(dedupeByApproval(items)), errors }
}

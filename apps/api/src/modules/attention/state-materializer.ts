// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

import { fanOutEpoch } from "~/infra/jobs/fanout-runtime"
import { type JobRunContext, registerJobWorker, registerScheduledJob } from "~/infra/jobs/jobs"
import { KERNEL_QUEUE_CLASSES, kernelJobSpec } from "~/infra/jobs/queue-classes"
import { boundedBy } from "~/lib/bounded"
import { rootLogger } from "~/lib/logger"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { isAppOffForOrg, primeOrgApps } from "~/modules/apps/org-apps"
import { attentionSourceApp } from "~/modules/attention/attention-source-app"
import { clearOrgsChanged, heartbeatDue, readOrgsChanged } from "~/modules/attention/org-changes"
import {
  type AttentionLiveItem,
  dispatchAttentionLive,
  emailEnqueue,
} from "~/modules/notifications/dispatch"
import {
  type RouterDecision,
  type RouterItem,
  type RouterRecipient,
  resolveChannels,
} from "~/modules/notifications/router"
import { isSeededWrite } from "~/modules/notifications/seeded"
import { movingOrgIds } from "~/modules/org/transfer-state/state"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "attention-state-materializer" })

export const STATE_MATERIALIZER_JOB = "attention-state-email-materialize"

export interface EmailOnlyRowInsert {
  orgId: string
  userId: string
  app: string
  entityType: string
  entityId: string
  kind: string
  urgency: number
  summary: string
  occurredAt: Date
  sourceKey: string
  /** The stored `is_urgent`: urgency >= 70, as the translator stores it. */
  isUrgent: boolean
  /** From the router's email decision (first sighting only; an upsert keeps the stored state). */
  digestState: "pending" | "suppressed"
  digestEligibleAt: Date
}

export interface StateMaterializerDeps {
  listOrgsWithActiveUsers: () => Promise<string[]>
  listActiveUsers: (orgId: string) => Promise<string[]>
  invokeProvider: (args: {
    orgId: string
    userId: string
    appName: string
    handler: string
    bundlePath: string
    /** The user's effective permissions, loaded once per run and shared by every provider. */
    permissions?: () => Promise<UserPermissions>
    /**
     * Aborted when the pass runs past PROVIDER_TIMEOUT_MS: the provider stops
     * its database work and gives its connection back, then settles.
     */
    signal?: AbortSignal
  }) => Promise<AttentionItem[]>
  /** Returns true when the row is new (first sighting); void counts as new (test doubles). */
  // biome-ignore lint/suspicious/noConfusingVoidType: an injected double that returns nothing counts as a new row
  upsertEmailOnlyRow: (row: EmailOnlyRowInsert) => Promise<void | boolean>
  /** The source keys this user already has a row for (only unseen items are routed). */
  listKnownSourceKeys: (orgId: string, userId: string, keys: string[]) => Promise<Set<string>>
  route: (recipient: RouterRecipient, item: RouterItem, now: Date) => Promise<RouterDecision>
  dispatchLive: (decision: RouterDecision, item: AttentionLiveItem) => Promise<void>
  now: () => Date
  /** Set the org up in this process when it is not registered here (S3). */
  ensureOrgApps: (orgId: string) => Promise<void>
}

async function defaultListOrgsWithActiveUsers(): Promise<string[]> {
  return withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "state-materializer:list-orgs",
    async (tx: PrivilegedDb) => {
      const rows = (await tx.execute(
        sql`SELECT DISTINCT org_id FROM ${K}.users WHERE status = 'active'`,
      )) as unknown as Array<{ org_id: string }>
      return rows.map((r) => r.org_id)
    },
  )
}

// Exported for the test that pins which users this fan-out selects. Every
// active user: the materializer routes computed items on push and desktop too
// (P2), so a user whose digest cadence is 'off' still gets their first-seen
// approvals on the phone; the router suppresses their email (S9).
export async function defaultListActiveUsers(orgId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "state-materializer:list-users", async (tx: PrivilegedDb) => {
    const rows = (await tx.execute(
      sql`SELECT u.id FROM ${K}.users u
          WHERE u.org_id = ${orgId} AND u.status = 'active'`,
    )) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  })
}

async function defaultListKnownSourceKeys(
  orgId: string,
  userId: string,
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  return withPrivilegedDb(orgId, "state-materializer:known-keys", async (tx: PrivilegedDb) => {
    const list = sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `,
    )
    const rows = (await tx.execute(
      sql`SELECT source_key FROM ${K}.attention_events
          WHERE user_id = ${userId} AND email_only = true AND source_key IN (${list})`,
    )) as unknown as Array<{ source_key: string }>
    return new Set(rows.map((r) => r.source_key))
  })
}

/** How long one provider pass may run for one user. */
export const PROVIDER_TIMEOUT_MS = 2_000

type UserPermissions = Awaited<ReturnType<typeof loadEffectivePermissions>>

function loadUserPermissions(orgId: string, userId: string): Promise<UserPermissions> {
  return withPrivilegedDb(orgId, "state-materializer:load-scopes", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
}

async function defaultInvokeProvider(args: {
  orgId: string
  userId: string
  appName: string
  handler: string
  bundlePath: string
  permissions?: () => Promise<UserPermissions>
  signal?: AbortSignal
}): Promise<AttentionItem[]> {
  const mod = await import(args.bundlePath)
  const fn = mod[args.handler] as
    | ((tx: unknown, orgId: string, userId: string) => Promise<AttentionItem[]>)
    | undefined
  if (typeof fn !== "function") {
    throw new Error(`Kernel handler "${args.handler}" not exported from ${args.bundlePath}`)
  }
  // Load the user's effective scopes so the provider runs with an RLS context
  // that carries real scope grants. Without this, providers that check
  // `app.current_scopes` (e.g. the approval provider's scope guard) see an
  // empty set and silently drop every item they would normally surface.
  const { scopes, dimensionGrants } = await (args.permissions
    ? args.permissions()
    : loadUserPermissions(args.orgId, args.userId))
  return withRlsContext(
    {
      actorType: "user",
      userId: args.userId,
      orgId: args.orgId,
      scopes,
      dimensionGrants,
    },
    (tx) => fn(tx, args.orgId, args.userId),
    // A pass past its time is rolled back and its connection returned, even
    // while the provider is still running; a statement it already sent is
    // bounded by the same limit.
    { signal: args.signal, statementTimeoutMs: PROVIDER_TIMEOUT_MS },
  )
}

async function defaultUpsertEmailOnlyRow(row: EmailOnlyRowInsert): Promise<boolean> {
  return withPrivilegedDb(row.orgId, "state-materializer:upsert", async (tx: PrivilegedDb) => {
    const out = (await tx.execute(
      sql`INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
         actor_type, occurred_at, is_urgent, digest_state, digest_eligible_at,
         email_only, source_key)
        VALUES (${row.orgId}, ${row.userId}, ${row.app}, ${row.entityType},
                ${row.entityId}, ${row.kind}, ${row.urgency}, ${row.summary},
                'system', ${row.occurredAt.toISOString()}, ${row.isUrgent},
                ${row.digestState}, ${row.digestEligibleAt.toISOString()}, true, ${row.sourceKey})
        ON CONFLICT (user_id, source_key) WHERE email_only = true AND source_key IS NOT NULL
          DO UPDATE SET
            urgency = GREATEST(EXCLUDED.urgency, ${K}.attention_events.urgency),
            summary = EXCLUDED.summary,
            occurred_at = EXCLUDED.occurred_at
        RETURNING (xmax = 0) AS inserted`,
    )) as unknown as Array<{ inserted: boolean }>
    return out[0]?.inserted === true
  })
}

function sourceKeyFor(item: AttentionItem): string {
  return `state:${item.app}:${item.kind}:${item.entity}:${item.entityId}`
}

/**
 * A computed item first seen long after it appeared (the first run after this
 * code ships, or a provider that was down) is recorded and emailed per the
 * grid, but never pushed or raised on the desktop: live channels are for news,
 * and held-back live items are never replayed (S4).
 */
export const LIVE_FRESHNESS_MS = 24 * 60 * 60 * 1000

/** The router presence of an approval: its originating conversation, while on screen. */
function approvalPresence(
  item: AttentionItem,
): { presenceKey: string; presenceViewingOnly: true } | Record<string, never> {
  if (item.kind !== "approval_pending") return {}
  const origin = item.metadata?.originatingThreadId
  return typeof origin === "string" && origin.length > 0
    ? { presenceKey: origin, presenceViewingOnly: true }
    : {}
}

function threadOf(item: AttentionItem): string | null {
  if (item.entity === "thread") return item.entityId
  const t = item.metadata?.threadId
  return typeof t === "string" ? t : null
}

/**
 * Materialize computed items from kernel-trusted state-derived attention
 * providers into `${K}.attention_events` as `email_only = true` rows (the feed
 * reads the provider live), at any urgency. An item seen for the first time
 * for a user (new `sourceKey`) is routed: its email state comes from the
 * router, and push and desktop go out if their cells are on. An item already
 * seen only refreshes its urgency and summary. Latency is this job's cadence:
 * the next minute after an org's state changed, at most HEARTBEAT_MINUTES for
 * an org where nothing happened (org-changes.ts).
 */
export async function runStateMaterializeOnce(
  args: { orgId: string },
  partial: Partial<StateMaterializerDeps> = {},
): Promise<void> {
  const deps: StateMaterializerDeps = {
    listOrgsWithActiveUsers: partial.listOrgsWithActiveUsers ?? defaultListOrgsWithActiveUsers,
    listActiveUsers: partial.listActiveUsers ?? defaultListActiveUsers,
    invokeProvider: partial.invokeProvider ?? defaultInvokeProvider,
    upsertEmailOnlyRow: partial.upsertEmailOnlyRow ?? defaultUpsertEmailOnlyRow,
    listKnownSourceKeys: partial.listKnownSourceKeys ?? defaultListKnownSourceKeys,
    route: partial.route ?? ((r, i, now) => resolveChannels(r, i, { now })),
    dispatchLive: partial.dispatchLive ?? ((d, i) => dispatchAttentionLive(d, i)),
    now: partial.now ?? (() => new Date()),
    ensureOrgApps: partial.ensureOrgApps ?? awaitOrgApps,
  }
  const users = await deps.listActiveUsers(args.orgId)
  // Each user's permissions, read once for this run whatever the number of
  // providers (a transaction per user, not one per user and provider). A
  // failed read is not kept: the next provider asks again.
  const permissionsByUser = new Map<string, Promise<UserPermissions>>()
  const permissionsOf = (userId: string) => () => {
    let p = permissionsByUser.get(userId)
    if (!p) {
      p = loadUserPermissions(args.orgId, userId)
      p.catch(() => permissionsByUser.delete(userId))
      permissionsByUser.set(userId, p)
    }
    return p
  }
  // Items about an app turned Off for the org (S19) reach no digest or push.
  await primeOrgApps(args.orgId)
  for (const [[entryOrg, appName], reg] of attentionItemsRegistry.entriesOf("*")) {
    if (entryOrg !== "*") continue
    if (!reg.trusted) continue
    // The event-provider surfaces already-persisted attention_events rows: it
    // does not derive new state but reads what the event pipeline already wrote.
    // Running it here would duplicate those rows as email_only inserts.
    if (appName === "kernel.attention_events") continue
    for (const userId of users) {
      let items: AttentionItem[]
      const abort = new AbortController()
      const pass = deps.invokeProvider({
        orgId: args.orgId,
        userId,
        appName,
        handler: reg.handler,
        bundlePath: reg.bundlePath,
        permissions: permissionsOf(userId),
        signal: abort.signal,
      })
      try {
        items = await boundedBy(pass, PROVIDER_TIMEOUT_MS, () => new Error("provider timeout"))
      } catch (err) {
        // A pass past its time is stopped, not just abandoned: it rolls back
        // and gives its connection back before the next pass starts, so slow
        // providers cannot pile up and drain the pool.
        abort.abort(err)
        await waitForRelease(pass, appName, userId)
        log.warn({ err, appName, userId }, "state-materializer provider failed — skipping user")
        continue
      }
      let known: Set<string>
      try {
        known = await deps.listKnownSourceKeys(args.orgId, userId, items.map(sourceKeyFor))
      } catch (err) {
        log.warn({ err, userId }, "state-materializer known-keys load failed — skipping user")
        continue
      }
      for (const item of items) {
        // A seeded row (a demo world's pending approval) is nobody's news: no
        // digest row, no push (notifications/seeded.ts).
        if (isSeededWrite(item.metadata)) continue
        if (isAppOffForOrg(args.orgId, attentionSourceApp(item))) continue
        try {
          const now = deps.now()
          const occurredAt = new Date(item.occurredAt)
          const isUrgent = item.urgency >= 70
          const sourceKey = sourceKeyFor(item)
          const base = {
            orgId: args.orgId,
            userId,
            app: item.app,
            entityType: item.entity,
            entityId: item.entityId,
            kind: item.kind,
            urgency: item.urgency,
            summary: item.summary,
            occurredAt,
            sourceKey,
            isUrgent,
          }
          if (known.has(sourceKey)) {
            // Already seen: refresh only (the conflict branch keeps the stored digest state).
            await deps.upsertEmailOnlyRow({
              ...base,
              digestState: "pending",
              digestEligibleAt: now,
            })
            continue
          }
          const decision = await deps.route(
            { userId, orgId: args.orgId },
            {
              kind: item.kind,
              app: item.app,
              entityType: item.entity,
              entityId: item.entityId,
              threadId: threadOf(item),
              isUrgent,
              // The provider ran as this user: an approval it lists is one they are asked to decide.
              ...(item.kind === "approval_pending" ? { approverIds: [userId] } : {}),
              ...approvalPlacement(item),
              // An approval raised in a chat the person is reading right now
              // (their own agent asking, the card on their screen) does not
              // interrupt them: they have seen it (etiquette rule 1).
              ...approvalPresence(item),
            },
            now,
          )
          if (!decision.channels.in_app.deliver) continue
          // Home folds away another person's request they could approve
          // themselves (approvals/attention.ts `peerSelfApprovable`, read by the
          // web's partitionPeerRequests). It stays in the feed behind the
          // filter, so its row is kept, but it is nobody else's news: no push,
          // no desktop banner, no digest line.
          // A request that reached this person only because someone went away is not news
          // either: it is on their Home from the next read, with no push for it.
          const peerNoise = isPeerSelfApprovableItem(item)
          const handedOver = isHandedOverItem(item, now)
          const inserted = await deps.upsertEmailOnlyRow({
            ...base,
            ...(peerNoise || handedOver
              ? { digestState: "suppressed" as const, digestEligibleAt: now }
              : emailEnqueue(decision, now)),
          })
          if (inserted === false) continue
          if (peerNoise || handedOver) continue
          if (now.getTime() - occurredAt.getTime() > LIVE_FRESHNESS_MS) continue
          await deps.dispatchLive(decision, {
            notifyId: `attention:${sourceKey}`,
            summary: item.summary,
            app: item.app,
            entityType: item.entity,
            entityId: item.entityId,
            threadId: threadOf(item),
          })
        } catch (err) {
          log.warn({ err, userId, item: item.id }, "email-only upsert failed — skipping item")
        }
      }
    }
  }
}

/**
 * How long a request waits before the person standing in for someone who went away stops
 * counting it as news: a request proposed since the last tick or two is theirs to hear about,
 * one that was already waiting when they were named is only on their Home.
 */
const HANDED_OVER_AFTER_MS = 15 * 60 * 1000

function isHandedOverItem(item: AttentionItem, now: Date): boolean {
  return (
    item.kind === "approval_pending" &&
    item.metadata?.placement === "standing_in" &&
    now.getTime() - new Date(item.occurredAt).getTime() > HANDED_OVER_AFTER_MS
  )
}

/** The router's `placement` of an approval row, when the server marked one. */
function approvalPlacement(item: AttentionItem): Pick<RouterItem, "placement"> {
  if (item.kind !== "approval_pending") return {}
  const placement = item.metadata?.placement
  return placement === "mine" || placement === "standing_in" || placement === "others"
    ? { placement }
    : {}
}

/**
 * Wait for an aborted pass to settle (its transaction rolled back, its
 * connection back in the pool). A provider that ignores the signal is waited
 * for at most PROVIDER_TIMEOUT_MS more, and logged.
 */
async function waitForRelease(
  pass: Promise<unknown>,
  appName: string,
  userId: string,
): Promise<void> {
  try {
    await boundedBy(
      pass.then(
        () => undefined,
        () => undefined,
      ),
      PROVIDER_TIMEOUT_MS,
      () => new Error("aborted provider did not stop"),
    )
  } catch (err) {
    log.error(
      { err, appName, userId },
      "state-materializer: an aborted provider pass is still running",
    )
  }
}

/** The same mine-vs-peer rule as Home's approvals partition: only rows the server marked. */
function isPeerSelfApprovableItem(item: AttentionItem): boolean {
  if (item.kind !== "approval_pending") return false
  // A row for someone else is quiet the same way: it is theirs, this person can also approve it.
  return item.metadata?.peerSelfApprovable === true || item.metadata?.placement === "others"
}

/** One org's materializer run, fanned out by the minute tick (one job per org). */
export const STATE_MATERIALIZER_ORG_JOB = "attention-state-email-materialize-org"
const STATE_MATERIALIZER_GAP_MS = 60_000

/**
 * The minute tick: one `attention-state-email-materialize-org` job per org with
 * active users that changed since the last tick, or whose heartbeat minute this
 * is (org-changes.ts), spread over the minute (infra/jobs/fanout.ts), so a slow
 * org holds up no other and an idle org costs one run in HEARTBEAT_MINUTES. The
 * ids name the org and the tick's fire time: a tick run twice (retry, two
 * processes) adds each org's job once.
 */
export async function runStateMaterializeTick(
  ctx: JobRunContext | undefined,
  partial: Partial<
    Pick<StateMaterializerDeps, "listOrgsWithActiveUsers"> & {
      readOrgsChanged: (upTo: number) => Promise<Set<string>>
    }
  > = {},
): Promise<{ enqueued: number; deduped: number; coalesced: number; idle: number }> {
  const epoch = ctx?.firedAt
  if (epoch === undefined) throw new Error("state materializer tick has no scheduled fire time")
  // An org being moved keeps its attention state as it is until the move ends.
  const moving = new Set(await movingOrgIds())
  const orgIds = (
    await (partial.listOrgsWithActiveUsers ?? defaultListOrgsWithActiveUsers)()
  ).filter((orgId) => !moving.has(orgId))
  // Marks up to now are this tick's; later ones wait for the next tick.
  const readUpTo = Date.now()
  let changed: Set<string> | null
  try {
    changed = await (partial.readOrgsChanged ?? readOrgsChanged)(readUpTo)
  } catch (err) {
    log.warn({ err }, "state materializer: changed orgs unreadable, every org runs this tick")
    changed = null
  }
  const changedSet = changed
  const due =
    changedSet === null
      ? orgIds
      : orgIds.filter((orgId) => changedSet.has(orgId) || heartbeatDue(orgId, epoch))
  const counts = await fanOutEpoch({
    queueName: KERNEL_QUEUE_CLASSES[kernelJobSpec(STATE_MATERIALIZER_ORG_JOB).queueClass].queueName,
    idApp: "kernel",
    idJob: STATE_MATERIALIZER_ORG_JOB,
    jobName: STATE_MATERIALIZER_ORG_JOB,
    epoch,
    gapMs: STATE_MATERIALIZER_GAP_MS,
    orgIds: due,
    // The next minute's tick is the retry.
    attempts: 1,
    backoff: { type: "fixed", delay: 1000 },
    signal: ctx?.signal,
  })
  // Only once the jobs are added: a tick that failed before leaves the marks
  // for its retry or the next tick.
  if (changed !== null && changed.size > 0) {
    try {
      await clearOrgsChanged(readUpTo)
    } catch (err) {
      log.warn({ err }, "state materializer: could not clear changed orgs (they run again)")
    }
  }
  return { ...counts, idle: orgIds.length - due.length }
}

/**
 * One org's run. The dispatcher already set the org up in this process (an org
 * created after boot or by another process is registered first, S3).
 */
export async function runStateMaterializeForOrg(
  orgId: string,
  partial: Partial<StateMaterializerDeps> = {},
): Promise<void> {
  if (partial.ensureOrgApps) await partial.ensureOrgApps(orgId)
  await runStateMaterializeOnce({ orgId }, partial)
}

export async function registerStateMaterializerScheduledJob(): Promise<void> {
  registerJobWorker<{ orgId: string }>("kernel", STATE_MATERIALIZER_ORG_JOB, async (payload) => {
    await runStateMaterializeForOrg(payload.orgId)
  })
  await registerScheduledJob(
    "kernel",
    STATE_MATERIALIZER_JOB,
    "*/1 * * * *",
    async (_payload: unknown, ctx?: JobRunContext) => {
      await runStateMaterializeTick(ctx)
    },
  )
}

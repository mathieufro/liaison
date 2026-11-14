// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's attention items are stored state (attention-store.ts): the feed
// reads them and runs no app code; a woken run of the app recomputes and
// stores them, and a list the provider no longer returns is cleared.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { redis } from "~/lib/redis"
import { attentionItemsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import {
  type AttentionRefreshJob,
  AttentionStoreTestAccess,
  attentionAudience,
  attentionRefreshesSettled,
  markAttentionReader,
  ORG_PROVIDER_RUNS_PER_MINUTE,
  ORG_REFRESHES_PER_MINUTE,
  processAttentionRefreshJob,
  REFRESH_MIN_INTERVAL_MS,
  readStoredAttention,
  refreshAllAppAttention,
  refreshAppAttention,
  STORED_LIST_MAX_AGE_MS,
  wireAttentionRefreshWakes,
} from "~/modules/apps/attention-store"
import * as executor from "~/modules/apps/sandbox/executor"
import * as runAppModule from "~/modules/apps/sandbox/run-app"
import { emitRunSettled } from "~/modules/apps/workers/run-settled"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "attnstore"

function item(id: string, urgency = 50): AttentionItem {
  return {
    id,
    app: APP,
    entity: "thing",
    entityId: id,
    kind: "admin_action",
    summary: `thing ${id}`,
    urgency,
    occurredAt: new Date().toISOString(),
    action: { type: "open_entity", tabType: `${APP}:thing`, entityId: id },
  }
}

describe("stored app attention", () => {
  let orgId = ""
  let userId = ""
  // What the app's provider would list now; the double stands in for the sandbox run.
  let listed: AttentionItem[] = []
  let providerRuns = 0
  const notified: string[] = []
  const deps = {
    listActiveUsers: async () => [userId],
    loadPersonActor: async (o: string, u: string): Promise<UserContext> => ({
      actorType: "user",
      userId: u,
      orgId: o,
      scopes: ["*"],
      dimensionGrants: {},
    }),
    // The org's other apps (tickets, projects, ...) are refreshed too when the
    // feed finds no stored list for them: they list nothing here.
    invoke: async (_reg: unknown, appName: string) => {
      if (appName !== APP) return []
      providerRuns++
      return listed
    },
    notify: async (_o: string, u: string, appName: string) => {
      if (appName === APP) notified.push(u)
    },
  }
  const feed = () =>
    aggregateAttentionItems({
      orgId,
      actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
    })

  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    attentionItemsRegistry.set([orgId, APP], {
      handler: "computeAttention",
      bundlePath: "/nonexistent/attention-store-test-bundle.js",
      trusted: false,
    } as never)
    // A woken refresh is a job on the attention queue; here it runs at once.
    AttentionStoreTestAccess.setWakeDeps({
      ...deps,
      ensureOrgApps: async () => {},
      enqueue: (job) => processAttentionRefreshJob(job.payload),
      // The reader is around already: a read wakes only a missing list.
      markReader: async () => false,
    })
    wireAttentionRefreshWakes()
  })
  afterEach(() => {
    listed = []
    providerRuns = 0
    notified.length = 0
  })
  afterAll(async () => {
    attentionItemsRegistry.delete([orgId, APP])
    AttentionStoreTestAccess.reset()
    await releaseTestLock()
  })

  it("a pass over every app reads the people and each one's permissions once, not once per app", async () => {
    const SECOND = `${APP}2`
    attentionItemsRegistry.set([orgId, SECOND], {
      handler: "computeAttention",
      bundlePath: "/nonexistent/attention-store-test-bundle.js",
      trusted: false,
    } as never)
    let listings = 0
    let loads = 0
    const ran: string[] = []
    try {
      await refreshAllAppAttention(orgId, {
        ...deps,
        listActiveUsers: async () => {
          listings++
          return [userId]
        },
        loadPersonActor: async (o, u) => {
          loads++
          return deps.loadPersonActor(o, u)
        },
        invoke: async (_reg, appName) => {
          ran.push(appName)
          return []
        },
      })
      expect(ran).toContain(APP)
      expect(ran).toContain(SECOND)
      expect([listings, loads]).toEqual([1, 1])
    } finally {
      attentionItemsRegistry.delete([orgId, SECOND])
    }
  })

  it("a pass over every app runs for every active member, also one who is not around", async () => {
    // Nobody is around in a workspace just seeded: its lists must still be stored.
    const ranFor: string[] = []
    await refreshAllAppAttention(orgId, {
      loadPersonActor: deps.loadPersonActor,
      notify: deps.notify,
      invoke: async (_reg, appName, actor) => {
        if (appName === APP && actor.actorType === "user") ranFor.push(actor.userId)
        return []
      },
    })
    expect(ranFor).toEqual([userId])
  })

  it("a feed poll runs no app code: it reads the stored list", async () => {
    listed = [item("a", 70), item("b", 30)]
    await refreshAppAttention(orgId, APP, deps)
    expect(providerRuns).toBe(1)
    expect(notified).toEqual([userId])

    const runApp = spyOn(runAppModule, "runApp")
    const inSandbox = spyOn(executor, "executeInSandbox")
    try {
      const first = await feed()
      const second = await feed()
      expect(runApp).not.toHaveBeenCalled()
      expect(inSandbox).not.toHaveBeenCalled()
      expect(providerRuns).toBe(1)
      for (const res of [first, second]) {
        const ours = res.items.filter((i) => i.app === APP).map((i) => i.id)
        expect(ours).toEqual(["a", "b"])
        expect(res.errors.filter((e) => e.app === APP)).toEqual([])
      }
    } finally {
      runApp.mockRestore()
      inSandbox.mockRestore()
    }
  })

  it("items appear and clear after a woken run of the app", async () => {
    listed = [item("x")]
    // A tool run of the app settles: the platform recomputes its list.
    emitRunSettled({
      app: APP,
      orgId,
      entry: "tool:do_something",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect((await feed()).items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["x"])

    // The provider no longer lists it after the next run: the stored item clears.
    listed = []
    emitRunSettled({
      app: APP,
      orgId,
      entry: "job:sync",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect((await feed()).items.filter((i) => i.app === APP)).toEqual([])
    expect(notified).toEqual([userId, userId])
  })

  it("an attention run does not wake another refresh", async () => {
    emitRunSettled({
      app: APP,
      orgId,
      entry: "attention:computeAttention",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect(providerRuns).toBe(0)
  })

  it("a failed run keeps the last good list and reports the failure", async () => {
    listed = [item("kept")]
    await refreshAppAttention(orgId, APP, deps)
    await refreshAppAttention(orgId, APP, {
      ...deps,
      invoke: async () => {
        throw new Error("provider broke")
      },
    })
    const res = await feed()
    expect(res.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["kept"])
    expect(res.errors).toContainEqual({ app: APP, reason: "error", message: "provider broke" })
  })

  it("a list computed while its person was away is not served: it is recomputed, and the feed reloads", async () => {
    // A dated line (a period's last day) stored three days ago, the person away since.
    listed = [item("period-last-day")]
    await refreshAppAttention(orgId, APP, deps)
    const age = async (ms: number) =>
      withPrivilegedDb(orgId, "test:age-attention-list", (tx) =>
        tx.execute(
          sql`UPDATE kernel.app_attention_items SET computed_at = now() - make_interval(secs => ${ms / 1000})
              WHERE org_id = ${orgId}::uuid AND app = ${APP}`,
        ),
      )
    await age(3 * 24 * 60 * 60_000)
    providerRuns = 0
    notified.length = 0
    // The provider no longer lists it: the day is past.
    listed = []
    const first = await feed()
    expect(first.items.filter((i) => i.app === APP)).toEqual([])
    await attentionRefreshesSettled()
    expect(providerRuns).toBe(1)
    // Recomputed and stored: the person's devices reload the feed.
    expect(notified).toEqual([userId])
    expect((await feed()).items.filter((i) => i.app === APP)).toEqual([])

    // A stale list whose items are still true comes back on the reload.
    listed = [item("still-true")]
    await refreshAppAttention(orgId, APP, deps)
    await age(STORED_LIST_MAX_AGE_MS + 60_000)
    notified.length = 0
    expect((await feed()).items.filter((i) => i.app === APP)).toEqual([])
    await attentionRefreshesSettled()
    expect(notified).toEqual([userId])
    expect((await feed()).items.filter((i) => i.app === APP).map((i) => i.id)).toEqual([
      "still-true",
    ])

    // A list within its age is served as stored.
    await age(STORED_LIST_MAX_AGE_MS - 60_000)
    providerRuns = 0
    expect((await feed()).items.filter((i) => i.app === APP).map((i) => i.id)).toEqual([
      "still-true",
    ])
    await attentionRefreshesSettled()
    expect(providerRuns).toBe(0)
  })

  it("drops malformed items and caps nothing it should not", async () => {
    listed = [item("ok"), { id: "bad" } as unknown as AttentionItem]
    await refreshAppAttention(orgId, APP, deps)
    const res = await feed()
    expect(res.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["ok"])
    expect(res.errors.find((e) => e.app === APP)?.message).toContain("malformed")
  })

  it("read-only runs wake no refresh; a 50-person org's 100 writes in a minute wake the debounced few", async () => {
    // A 50-person org, measured: what the refresh costs per wake is people x provider runs.
    const people = Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    )
    let clock = Date.UTC(2026, 0, 1, 12, 0, 0)
    const queued = new Map<string, AttentionRefreshJob>()
    const enqueued: string[] = []
    let personRuns = 0
    toolRegistry.set([orgId, APP, "list_things"], {
      appName: APP,
      name: "list_things",
      description: "reads",
      requiredScopes: ["attnstore:read"],
      readOnly: true,
    } as never)
    AttentionStoreTestAccess.setWakeDeps({
      ...deps,
      ensureOrgApps: async () => {},
      now: () => clock,
      // BullMQ deduplication: an id still waiting adds nothing.
      enqueue: async (job) => {
        enqueued.push(job.jobId)
        if (!queued.has(job.jobId)) queued.set(job.jobId, job)
      },
    })
    const settle = (entry: string) =>
      emitRunSettled({
        app: APP,
        orgId,
        entry,
        executor: "quickjs",
        nested: false,
        ms: 1,
        ok: true,
        at: clock,
      })
    try {
      // 100 read-only tool runs, plus the read-only entry kinds: nothing to recompute.
      for (let i = 0; i < 100; i++) {
        clock += 600
        settle("tool:list_things")
      }
      for (const kind of ["search", "export", "preview", "summarizer", "preflight", "attention"]) {
        settle(`${kind}:x`)
      }
      await attentionRefreshesSettled()
      expect(enqueued).toEqual([])
      expect(providerRuns).toBe(0)

      // 100 writing runs within one minute: one refresh per minimum interval at most.
      const start = clock
      for (let i = 0; i < 100; i++) {
        clock = start + i * 600
        settle(i % 2 === 0 ? "tool:do_something" : "job:sync")
      }
      await attentionRefreshesSettled()
      // Nothing ran in the waking path: the refresh is a queued job.
      expect(providerRuns).toBe(0)
      const debounced = Math.ceil(60_000 / REFRESH_MIN_INTERVAL_MS) + 1
      expect(queued.size).toBeGreaterThanOrEqual(1)
      expect(queued.size).toBeLessThanOrEqual(debounced)
      // Each queued refresh fires at the end of its interval, after the writes it covers.
      for (const job of queued.values()) {
        expect(job.delay).toBeGreaterThan(0)
        expect(job.delay).toBeLessThanOrEqual(REFRESH_MIN_INTERVAL_MS)
      }
      for (const job of queued.values()) {
        await processAttentionRefreshJob(job.payload, {
          ...deps,
          ensureOrgApps: async () => {},
          now: () => clock,
          takeOrgBudget: async () => true,
          listActiveUsers: async () => people,
          invoke: async (_reg: unknown, appName: string) => {
            if (appName === APP) personRuns++
            return []
          },
        })
      }
      expect(personRuns).toBeLessThanOrEqual(debounced * people.length)
      expect(personRuns).toBeLessThan(100 * people.length)
    } finally {
      toolRegistry.delete([orgId, APP, "list_things"])
      AttentionStoreTestAccess.setWakeDeps({
        ...deps,
        ensureOrgApps: async () => {},
        enqueue: (job) => processAttentionRefreshJob(job.payload),
        markReader: async () => false,
      })
    }
  })

  const fiftyPeople = () =>
    Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`)

  it("a refresh runs the provider only for the people around: 50 members, 3 runs", async () => {
    const people = fiftyPeople()
    const [online, away, offline, reader] = people as [string, string, string, string]
    const keys = people.map((u) => `presence:${orgId}:${u}`)
    try {
      await redis.set(`presence:${orgId}:${online}`, "online", "EX", 60)
      await redis.set(`presence:${orgId}:${away}`, "away", "EX", 60)
      await redis.set(`presence:${orgId}:${offline}`, "offline", "EX", 60)
      // Read their feed a minute ago, not online now.
      await markAttentionReader(orgId, reader, Date.now() - 60_000)
      expect((await attentionAudience(orgId, people)).sort()).toEqual([online, away, reader].sort())
      let runs = 0
      await processAttentionRefreshJob(
        { org: orgId, app: APP },
        {
          ...deps,
          ensureOrgApps: async () => {},
          takeOrgBudget: async () => true,
          listActiveUsers: (o) => attentionAudience(o, people),
          invoke: async (_reg: unknown, appName: string) => {
            if (appName === APP) runs++
            return []
          },
        },
      )
      expect(runs).toBe(3)
    } finally {
      await redis.del(...keys, `attention:seen:${orgId}`)
    }
  })

  it("a reader back from away has every app recomputed on their feed read; a reader around does not", async () => {
    const queued: string[] = []
    AttentionStoreTestAccess.setWakeDeps({
      ...deps,
      ensureOrgApps: async () => {},
      now: () => Date.UTC(2026, 0, 1, 12, 0, 1),
      enqueue: async (job) => {
        queued.push(job.payload.app)
      },
    })
    try {
      await redis.del(`attention:seen:${orgId}`)
      await refreshAppAttention(orgId, APP, { ...deps, userIds: [userId] })
      const read = () =>
        withRlsContext(
          { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
          (tx) => readStoredAttention(tx, orgId, userId, [APP]),
        )
      // Their list is stored, but they were away: it is recomputed.
      expect((await read()).has(APP)).toBe(true)
      await attentionRefreshesSettled()
      expect(queued).toEqual([APP])
      // Around now: the stored list is read as it is.
      AttentionStoreTestAccess.setWakeDeps({
        ...deps,
        ensureOrgApps: async () => {},
        now: () => Date.UTC(2026, 0, 1, 12, 0, 31),
        enqueue: async (job) => {
          queued.push(job.payload.app)
        },
      })
      await read()
      await attentionRefreshesSettled()
      expect(queued).toEqual([APP])
    } finally {
      await redis.del(`attention:seen:${orgId}`)
      AttentionStoreTestAccess.setWakeDeps({
        ...deps,
        ensureOrgApps: async () => {},
        enqueue: (job) => processAttentionRefreshJob(job.payload),
        markReader: async () => false,
      })
    }
  })

  it("an org runs at most its per-minute cap of provider runs; the rest move to the next minute", async () => {
    const people = fiftyPeople()
    const now = Date.UTC(2026, 0, 1, 13, 45, 10)
    const deferred: AttentionRefreshJob[] = []
    let runs = 0
    const jobDeps = {
      ...deps,
      ensureOrgApps: async () => {},
      now: () => now,
      takeOrgBudget: async () => true,
      listActiveUsers: async () => people,
      invoke: async (_reg: unknown, appName: string) => {
        if (appName === APP) runs++
        return []
      },
      enqueue: async (job: AttentionRefreshJob) => {
        deferred.push(job)
      },
    }
    const fits = Math.floor(ORG_PROVIDER_RUNS_PER_MINUTE / people.length)
    for (let i = 0; i < fits + 2; i++) {
      await processAttentionRefreshJob({ org: orgId, app: APP }, jobDeps)
    }
    expect(runs).toBe(fits * people.length)
    expect(deferred.length).toBe(2)
    expect(deferred[0]?.delay).toBe(Math.ceil(now / 60_000) * 60_000 - now)
  })

  it("an org runs at most its per-minute cap of refreshes; the rest move to the next minute", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 30, 10)
    const deferred: AttentionRefreshJob[] = []
    const jobDeps = {
      ...deps,
      ensureOrgApps: async () => {},
      now: () => now,
      enqueue: async (job: AttentionRefreshJob) => {
        deferred.push(job)
      },
    }
    for (let i = 0; i < ORG_REFRESHES_PER_MINUTE + 3; i++) {
      await processAttentionRefreshJob({ org: orgId, app: APP }, jobDeps)
    }
    expect(providerRuns).toBe(ORG_REFRESHES_PER_MINUTE)
    expect(deferred.length).toBe(3)
    for (const job of deferred) {
      expect(job.payload).toEqual({ org: orgId, app: APP })
      expect(job.delay).toBe(Math.ceil(now / 60_000) * 60_000 - now)
    }
  })

  it("a person reads only their own stored list (API read, feed and RLS)", async () => {
    const other = await minimal.person(orgId)
    // A read that finds no list queues a refresh: queued here, never run.
    AttentionStoreTestAccess.setWakeDeps({
      ...deps,
      ensureOrgApps: async () => {},
      enqueue: async () => {},
    })
    const actorOf = (u: string): UserContext => ({
      actorType: "user",
      userId: u,
      orgId,
      scopes: ["*"],
      dimensionGrants: {},
    })
    await refreshAppAttention(orgId, APP, {
      ...deps,
      listActiveUsers: async () => [userId, other.id],
      // Each person's provider run lists something only that person may see.
      invoke: async (_reg: unknown, appName: string, actor) => {
        if (appName !== APP) return []
        return [item(`for-${actor.actorType === "user" ? actor.userId : "none"}`)]
      },
    })
    for (const [me, them] of [
      [userId, other.id],
      [other.id, userId],
    ] as const) {
      const read = await withRlsContext(actorOf(me), (tx) =>
        readStoredAttention(tx, orgId, me, [APP]),
      )
      expect(read.get(APP)?.items.map((i) => i.id)).toEqual([`for-${me}`])
      // Asking for the other person's list under my RLS context returns nothing.
      const asked = await withRlsContext(actorOf(me), (tx) =>
        readStoredAttention(tx, orgId, them, [APP]),
      )
      expect(asked.get(APP)).toBeUndefined()
      const raw = await withRlsContext(actorOf(me), async (tx) =>
        extractRows<{ user_id: string }>(
          await tx.execute(
            sql`SELECT user_id::text AS user_id FROM kernel.app_attention_items WHERE org_id = ${orgId}::uuid AND app = ${APP}`,
          ),
        ),
      )
      expect(raw.map((r) => r.user_id)).toEqual([me])
      const fed = await aggregateAttentionItems({ orgId, actor: actorOf(me) })
      expect(fed.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual([`for-${me}`])
    }
    AttentionStoreTestAccess.setWakeDeps({
      ...deps,
      ensureOrgApps: async () => {},
      enqueue: (job) => processAttentionRefreshJob(job.payload),
    })
  })

  it("a refresh that started earlier never overwrites a newer stored list", async () => {
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r
    })
    const slow = refreshAppAttention(orgId, APP, {
      ...deps,
      invoke: async (_reg: unknown, appName: string) => {
        if (appName !== APP) return []
        await slowGate
        return [item("stale")]
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    notified.length = 0
    await refreshAppAttention(orgId, APP, {
      ...deps,
      invoke: async (_reg: unknown, appName: string) => (appName === APP ? [item("fresh")] : []),
    })
    releaseSlow()
    await slow
    const res = await feed()
    expect(res.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["fresh"])
    // The refused late write tells nobody to reload.
    expect(notified).toEqual([userId])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { attentionItemsRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { HEARTBEAT_MINUTES, heartbeatDue } from "./org-changes"

type Mod = typeof import("./state-materializer")
let mod: Mod

const ORG = "00000000-0000-0000-0000-000000000111"
const USER = "00000000-0000-0000-0000-000000000aaa"
const USER_B = "00000000-0000-0000-0000-000000000bbb"

beforeEach(async () => {
  resetAppRegistries()
  mod = await import("./state-materializer")
})

afterEach(() => {
  resetAppRegistries()
})

function item(overrides: Partial<AttentionItem> & { urgency: number }): AttentionItem {
  return {
    id: overrides.id ?? `i-${overrides.urgency}`,
    app: "kernel",
    entity: "sla",
    entityId: "e-1",
    kind: "sla_risk",
    summary: "breach",
    occurredAt: "2026-05-12T12:00:00.000Z",
    action: { type: "open_entity", tabType: "ticket", entityId: "e-1" },
    ...overrides,
  } as AttentionItem
}

function makeDeps(items: AttentionItem[]) {
  const upserted: any[] = []
  const invokeProvider = mock(async () => items)
  return {
    upserted,
    invokeProvider,
    deps: {
      listOrgsWithActiveUsers: async () => [ORG],
      listActiveUsers: async () => [USER],
      invokeProvider,
      upsertEmailOnlyRow: async (row: any) => {
        upserted.push(row)
      },
    },
  }
}

describe("runStateMaterializeOnce", () => {
  // P2-TD (spec Components 3): computed items are materialized at ANY urgency;
  // `is_urgent` keeps the >= 70 threshold the translator stores.
  it("emits email_only rows for items at any urgency, urgent from 70", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
    const { upserted, deps } = makeDeps([
      item({ urgency: 60, id: "low" }),
      item({ urgency: 80, id: "high" }),
    ])
    await mod.runStateMaterializeOnce({ orgId: ORG }, deps)
    expect(upserted).toHaveLength(2)
    expect(upserted.map((r) => [r.urgency, r.isUrgent])).toEqual([
      [60, false],
      [80, true],
    ])
    expect(upserted[1].sourceKey).toBe("state:kernel:sla_risk:sla:e-1")
  })

  it("skips entries where trusted is false", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: false,
    })
    const { upserted, deps } = makeDeps([item({ urgency: 90 })])
    await mod.runStateMaterializeOnce({ orgId: ORG }, deps)
    expect(upserted).toHaveLength(0)
  })

  it("skips per-org (non-wildcard) provider entries", async () => {
    attentionItemsRegistry.set([ORG, "tickets"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
    const { upserted, deps } = makeDeps([item({ urgency: 90 })])
    await mod.runStateMaterializeOnce({ orgId: ORG }, deps)
    expect(upserted).toHaveLength(0)
  })

  // One approval is one notification. An app may list its own item for a
  // kernel approval (social's "drafted reply is awaiting your approval", routed
  // to decide_approval on the same request); the feed collapses it onto the
  // kernel's row (attention-aggregator dedupeByApproval). The notification path
  // never sees it: only the kernel's own wildcard providers are materialized,
  // never an app's per-org provider, so the approval routes once, from the
  // kernel's item.
  it("routes a kernel approval once when an app also lists its own item for it", async () => {
    const approvalId = "00000000-0000-4000-8000-0000000000a1"
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "computeApprovalAttentionItems",
      bundlePath: "/fake/approvals",
      core: true,
    })
    attentionItemsRegistry.set([ORG, "social"], {
      handler: "computeSocialAttentionItems",
      bundlePath: "/fake/social",
      core: true,
    })
    const kernelItem = item({
      id: `kernel:approval_pending:${approvalId}`,
      app: "kernel",
      entity: "approval_request",
      entityId: approvalId,
      kind: "approval_pending",
      urgency: 60,
      action: { type: "decide_approval", approvalId },
    })
    const socialItem = item({
      id: "social-approval-finding-1",
      app: "social",
      entity: "finding",
      entityId: "finding-1",
      kind: "approval_pending",
      urgency: 70,
      action: { type: "decide_approval", approvalId },
    })
    const upserted: any[] = []
    const invokeProvider = mock(async (args: { appName: string }) =>
      args.appName === "social" ? [socialItem] : [kernelItem],
    )
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER],
        invokeProvider: invokeProvider as never,
        upsertEmailOnlyRow: async (row: any) => {
          upserted.push(row)
        },
      },
    )
    expect(invokeProvider.mock.calls.map((c) => (c[0] as { appName: string }).appName)).toEqual([
      "kernel",
    ])
    expect(upserted.map((r) => [r.app, r.entityType, r.entityId])).toEqual([
      ["kernel", "approval_request", approvalId],
    ])
  })

  // Home's mine-vs-peer partition (web shell/approval-facets.ts
  // partitionPeerRequests) folds away another person's request they could
  // approve themselves. Push, desktop and the digest follow the same rule: the
  // requester is told, the peers are not.
  it("a peer self-approvable approval notifies its requester only", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "computeApprovalAttentionItems",
      bundlePath: "/fake/approvals",
      core: true,
    })
    const approvalId = "00000000-0000-4000-8000-0000000000a2"
    const occurredAt = "2026-09-28T10:00:00.000Z"
    const forUser = (userId: string) =>
      item({
        id: `kernel:approval_pending:${approvalId}`,
        entity: "approval_request",
        entityId: approvalId,
        kind: "approval_pending",
        urgency: 60,
        occurredAt,
        action: { type: "decide_approval", approvalId },
        metadata: { requestedById: USER, peerSelfApprovable: userId !== USER },
      })
    const { resolveChannels } = await import("~/modules/notifications/router")
    const { effectiveGrid } = await import("@liaison/shared")
    const upserted: any[] = []
    const live: string[] = []
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER, USER_B],
        invokeProvider: (async (args: { userId: string }) => [forUser(args.userId)]) as never,
        listKnownSourceKeys: async () => new Set<string>(),
        upsertEmailOnlyRow: async (row: any) => {
          upserted.push(row)
          return true
        },
        route: (r, i, now) =>
          resolveChannels(r, i, {
            now,
            loadContext: async () => ({
              grid: effectiveGrid(null),
              digestCadence: "immediate",
              workHours: {
                workHoursStart: "09:00",
                workHoursEnd: "17:00",
                workDays: [1, 2, 3, 4, 5],
                timezone: "UTC",
              },
              workHoursExplicit: false,
              appRules: [],
              threadMuted: false,
              hasPushDevice: true,
            }),
          }),
        dispatchLive: async (d) => {
          live.push(d.userId)
        },
        now: () => new Date(occurredAt),
        ensureOrgApps: async () => {},
      },
    )
    expect(live).toEqual([USER])
    expect(upserted.map((r) => [r.userId, r.digestState])).toEqual([
      [USER, "pending"],
      [USER_B, "suppressed"],
    ])
  })

  it("an approval for someone else is quiet for the others: digest suppressed, no live push", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "computeApprovalAttentionItems",
      bundlePath: "/fake/approvals",
      core: true,
    })
    const approvalId = "00000000-0000-4000-8000-0000000000a3"
    const occurredAt = "2026-09-28T10:00:00.000Z"
    const forUser = (userId: string) =>
      item({
        id: `kernel:approval_pending:${approvalId}`,
        entity: "approval_request",
        entityId: approvalId,
        kind: "approval_pending",
        urgency: 60,
        occurredAt,
        action: { type: "decide_approval", approvalId },
        // Nobody's own request: the row is USER's (the person on the item), USER_B can also approve.
        metadata: {
          requestedById: "00000000-0000-0000-0000-000000000ccc",
          peerSelfApprovable: false,
          placement: userId === USER ? "mine" : "others",
        },
      })
    const { resolveChannels } = await import("~/modules/notifications/router")
    const { effectiveGrid } = await import("@liaison/shared")
    const upserted: any[] = []
    const live: string[] = []
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER, USER_B],
        invokeProvider: (async (args: { userId: string }) => [forUser(args.userId)]) as never,
        listKnownSourceKeys: async () => new Set<string>(),
        upsertEmailOnlyRow: async (row: any) => {
          upserted.push(row)
          return true
        },
        route: (r, i, now) =>
          resolveChannels(r, i, {
            now,
            loadContext: async () => ({
              grid: effectiveGrid(null),
              digestCadence: "immediate",
              workHours: {
                workHoursStart: "09:00",
                workHoursEnd: "17:00",
                workDays: [1, 2, 3, 4, 5],
                timezone: "UTC",
              },
              workHoursExplicit: false,
              appRules: [],
              threadMuted: false,
              hasPushDevice: true,
            }),
          }),
        dispatchLive: async (d) => {
          live.push(d.userId)
        },
        now: () => new Date(occurredAt),
        ensureOrgApps: async () => {},
      },
    )
    expect(live).toEqual([USER])
    expect(upserted.map((r) => [r.userId, r.digestState])).toEqual([
      [USER, "pending"],
      [USER_B, "suppressed"],
    ])
  })

  it("going away raises no burst: rows already waiting reach the stand-in without a push, a new one does", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "computeApprovalAttentionItems",
      bundlePath: "/fake/approvals",
      core: true,
    })
    const now = new Date("2026-09-28T10:00:00.000Z")
    const standingIn = (id: string, ageMinutes: number) =>
      item({
        id: `kernel:approval_pending:${id}`,
        entity: "approval_request",
        entityId: id,
        kind: "approval_pending",
        urgency: 60,
        occurredAt: new Date(now.getTime() - ageMinutes * 60_000).toISOString(),
        action: { type: "decide_approval", approvalId: id },
        metadata: { peerSelfApprovable: false, placement: "standing_in" },
      })
    const waiting = Array.from({ length: 12 }, (_, i) =>
      standingIn(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, 600 + i),
    )
    const proposed = standingIn("00000000-0000-4000-8000-000000000200", 1)
    const { resolveChannels } = await import("~/modules/notifications/router")
    const { effectiveGrid } = await import("@liaison/shared")
    const upserted: any[] = []
    const live: string[] = []
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER],
        invokeProvider: (async () => [...waiting, proposed]) as never,
        listKnownSourceKeys: async () => new Set<string>(),
        upsertEmailOnlyRow: async (row: any) => {
          upserted.push(row)
          return true
        },
        route: (r, i, at) =>
          resolveChannels(r, i, {
            now: at,
            loadContext: async () => ({
              grid: effectiveGrid(null),
              digestCadence: "immediate",
              workHours: {
                workHoursStart: "09:00",
                workHoursEnd: "17:00",
                workDays: [1, 2, 3, 4, 5],
                timezone: "UTC",
              },
              workHoursExplicit: false,
              appRules: [],
              threadMuted: false,
              hasPushDevice: true,
            }),
          }),
        dispatchLive: async (_d, payload) => {
          live.push(payload.entityId as string)
        },
        now: () => now,
        ensureOrgApps: async () => {},
      },
    )
    // Every row is on the stand-in's Home; only the one proposed a minute ago is news.
    expect(upserted).toHaveLength(13)
    expect(live).toEqual([proposed.entityId])
    for (const row of upserted.filter((r) => r.entityId !== proposed.entityId)) {
      expect(row.digestState).toBe("suppressed")
    }
  })

  // Etiquette rule 1: an approval the person's agent raised in the chat they
  // are reading is on their screen already. The router is asked with the
  // conversation as a viewing-only presence key, so it holds the interrupt
  // back only while that chat is on a focused screen.
  it("an approval is routed with its originating chat as a viewing-only presence key", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "computeApprovalAttentionItems",
      bundlePath: "/fake/approvals",
      core: true,
    })
    const approvalId = "00000000-0000-4000-8000-0000000000a3"
    const chat = "00000000-0000-4000-8000-0000000000c3"
    const occurredAt = "2026-09-28T10:00:00.000Z"
    const asked: Array<{ presenceKey?: string; presenceViewingOnly?: true }> = []
    const { resolveChannels } = await import("~/modules/notifications/router")
    const { effectiveGrid } = await import("@liaison/shared")
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER],
        invokeProvider: (async () => [
          item({
            id: `kernel:approval_pending:${approvalId}`,
            entity: "approval_request",
            entityId: approvalId,
            kind: "approval_pending",
            urgency: 60,
            occurredAt,
            action: { type: "decide_approval", approvalId },
            metadata: { requestedById: USER, originatingThreadId: chat },
          }),
        ]) as never,
        listKnownSourceKeys: async () => new Set<string>(),
        upsertEmailOnlyRow: async () => true,
        route: (r, i, now) => {
          asked.push({ presenceKey: i.presenceKey, presenceViewingOnly: i.presenceViewingOnly })
          return resolveChannels(r, i, {
            now,
            loadContext: async () => ({
              grid: effectiveGrid(null),
              digestCadence: "immediate",
              workHours: {
                workHoursStart: "09:00",
                workHoursEnd: "17:00",
                workDays: [1, 2, 3, 4, 5],
                timezone: "UTC",
              },
              workHoursExplicit: false,
              appRules: [],
              threadMuted: false,
              hasPushDevice: true,
              activeInThread: true,
            }),
          })
        },
        dispatchLive: async (d) => {
          expect(d.channels.push).toEqual({ deliver: false, reason: "active_in_thread" })
          expect(d.channels.desktop).toEqual({ deliver: false, reason: "active_in_thread" })
        },
        now: () => new Date(occurredAt),
        ensureOrgApps: async () => {},
      },
    )
    expect(asked).toEqual([{ presenceKey: chat, presenceViewingOnly: true }])
  })

  it("each user's permissions are read once per run, shared by every provider", async () => {
    for (const app of ["kernel", "kernel.connection_health", "kernel.mailbox_enrollment"]) {
      attentionItemsRegistry.set(["*", app], {
        handler: "providerFn",
        bundlePath: "/fake/bundle",
        core: true,
      })
    }
    const reads: Array<{ userId: string; read: Promise<unknown> }> = []
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER, USER_B],
        invokeProvider: (async (args: { userId: string; permissions?: () => Promise<unknown> }) => {
          const read = args.permissions?.() ?? Promise.reject(new Error("no shared read"))
          read.catch(() => {})
          reads.push({ userId: args.userId, read })
          return []
        }) as never,
        upsertEmailOnlyRow: async () => {},
      },
    )
    expect(reads).toHaveLength(6)
    for (const u of [USER, USER_B]) {
      const mine = new Set(reads.filter((r) => r.userId === u).map((r) => r.read))
      expect(mine.size).toBe(1)
    }
    expect(reads.find((r) => r.userId === USER)?.read).not.toBe(
      reads.find((r) => r.userId === USER_B)?.read,
    )
    await Promise.allSettled(reads.map((r) => r.read))
  })

  it("provider failure for one user does not block others", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
    const upserted: any[] = []
    let calls = 0
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER, USER_B],
        invokeProvider: async () => {
          calls += 1
          if (calls === 1) throw new Error("boom")
          return [item({ urgency: 80 })]
        },
        upsertEmailOnlyRow: async (row: any) => {
          upserted.push(row)
        },
      },
    )
    expect(upserted).toHaveLength(1)
    expect(upserted[0].userId).toBe(USER_B)
  })

  it("upsert failure is logged and other items continue", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
    const upserted: any[] = []
    let first = true
    await mod.runStateMaterializeOnce(
      { orgId: ORG },
      {
        listOrgsWithActiveUsers: async () => [ORG],
        listActiveUsers: async () => [USER],
        invokeProvider: async () => [
          item({ urgency: 80, id: "a", entityId: "a" }),
          item({ urgency: 90, id: "b", entityId: "b" }),
        ],
        upsertEmailOnlyRow: async (row: any) => {
          if (first) {
            first = false
            throw new Error("conflict")
          }
          upserted.push(row)
        },
      },
    )
    expect(upserted).toHaveLength(1)
    expect(upserted[0].entityId).toBe("b")
  })
})

// The minute tick fans out: one job per org with active users that changed
// since the last tick or whose heartbeat minute it is (P4, S16, org-changes.ts),
// so a slow org holds up no other and a re-run tick adds nothing.
describe("state materializer fan-out", () => {
  const ORG_B = "00000000-0000-0000-0000-000000000222"
  const futureMinute = () => (Math.floor(Date.now() / 60_000) + 2) * 60_000
  const ctx = (firedAt: number) => ({ signal: new AbortController().signal, firedAt })
  const added: string[] = []
  const kernelCron = async () => (await import("~/infra/jobs/jobs")).getPhysicalQueue("kernel-cron")
  const idOf = async (orgId: string, epoch: number) =>
    (await import("~/infra/jobs/fanout")).fanoutJobId(
      "kernel",
      mod.STATE_MATERIALIZER_ORG_JOB,
      orgId,
      epoch,
    )

  afterAll(async () => {
    const q = await kernelCron()
    for (const id of added) await q.remove(id)
    await (await import("~/infra/jobs/jobs")).closeAllQueues()
  })

  // Fresh orgs per test: an org's job still delayed from an earlier test (or an
  // earlier run of this file on the same queue) would coalesce this tick's job
  // into it (by design). Job ids are recorded before any assertion, so a failed
  // assertion still cleans up.
  it("one tick enqueues one per-org job per changed org with active users, and runs none itself", async () => {
    const epoch = futureMinute()
    const orgs = [randomUUID(), randomUUID()]
    for (const org of orgs) added.push(await idOf(org, epoch))
    const res = await mod.runStateMaterializeTick(ctx(epoch), {
      listOrgsWithActiveUsers: async () => orgs,
      readOrgsChanged: async () => new Set(orgs),
    })
    expect(res.enqueued).toBe(2)
    const q = await kernelCron()
    for (const org of orgs) {
      const id = await idOf(org, epoch)
      const job = await q.getJob(id)
      expect(job?.name).toBe(mod.STATE_MATERIALIZER_ORG_JOB)
      expect(job?.data.orgId).toBe(org)
    }
  })

  it("a re-run of the same tick enqueues nothing new", async () => {
    const epoch = futureMinute()
    const orgs = [randomUUID(), randomUUID()]
    for (const org of orgs) added.push(await idOf(org, epoch))
    const list = {
      listOrgsWithActiveUsers: async () => orgs,
      readOrgsChanged: async () => new Set(orgs),
    }
    expect((await mod.runStateMaterializeTick(ctx(epoch), list)).enqueued).toBe(2)
    const again = await mod.runStateMaterializeTick(ctx(epoch), list)
    expect(again.enqueued).toBe(0)
    expect(again.deduped).toBe(2)
  })

  it("a slow org does not delay another org's run (each is its own job)", async () => {
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
    const t0 = Date.now()
    const started: Record<string, number> = {}
    const deps = {
      listActiveUsers: async () => [USER],
      invokeProvider: async (args: { orgId: string }) => {
        started[args.orgId] = Date.now() - t0
        if (args.orgId === ORG) await new Promise((r) => setTimeout(r, 2000))
        return []
      },
      upsertEmailOnlyRow: async () => {},
    }
    // Two workers pick the two orgs' jobs: org B starts while org A is slow.
    await Promise.all([
      mod.runStateMaterializeForOrg(ORG, deps),
      mod.runStateMaterializeForOrg(ORG_B, deps),
    ])
    expect(started[ORG_B]).toBeLessThan(1000)
  })

  it("every org with active users is enqueued, registered in this process or not", async () => {
    // Boot registers no org: the org job's dispatch sets an unregistered org up.
    const [unregistered, other] = [randomUUID(), randomUUID()]
    const epoch = futureMinute()
    for (const org of [unregistered, other]) added.push(await idOf(org, epoch))
    const res = await mod.runStateMaterializeTick(ctx(epoch), {
      listOrgsWithActiveUsers: async () => [unregistered, other],
      readOrgsChanged: async () => new Set([unregistered, other]),
    })
    expect(res.enqueued).toBe(2)
  })

  // The idle skip (org-changes.ts): an org where nothing changed costs one run
  // in HEARTBEAT_MINUTES, on a minute fixed by its id.
  const minuteWhere = (org: string, due: boolean) => {
    let m = futureMinute()
    while (heartbeatDue(org, m) !== due) m += 60_000
    return m
  }

  it("an org with no change is skipped, except on its heartbeat minute", async () => {
    const org = randomUUID()
    const deps = {
      listOrgsWithActiveUsers: async () => [org],
      readOrgsChanged: async () => new Set<string>(),
    }
    const quiet = await mod.runStateMaterializeTick(ctx(minuteWhere(org, false)), deps)
    expect(quiet).toMatchObject({ enqueued: 0, idle: 1 })
    const beat = minuteWhere(org, true)
    const res = await mod.runStateMaterializeTick(ctx(beat), deps)
    added.push(await idOf(org, beat))
    expect(res).toMatchObject({ enqueued: 1, idle: 0 })
  })

  it("an org's heartbeat comes once in HEARTBEAT_MINUTES consecutive minutes", () => {
    const org = randomUUID()
    const start = futureMinute()
    let due = 0
    for (let i = 0; i < HEARTBEAT_MINUTES; i++) if (heartbeatDue(org, start + i * 60_000)) due++
    expect(due).toBe(1)
  })

  it("unreadable changes run every org (fail-safe)", async () => {
    const org = randomUUID()
    const epoch = minuteWhere(org, false)
    const res = await mod.runStateMaterializeTick(ctx(epoch), {
      listOrgsWithActiveUsers: async () => [org],
      readOrgsChanged: async () => {
        throw new Error("redis down")
      },
    })
    added.push(await idOf(org, epoch))
    expect(res.enqueued).toBe(1)
  })

  it("an org marked changed runs at the next tick, and its mark is spent once the job is added", async () => {
    const changes = await import("./org-changes")
    const org = randomUUID()
    const list = { listOrgsWithActiveUsers: async () => [org] }
    await changes.markOrgsChanged([org])
    const first = minuteWhere(org, false)
    expect((await mod.runStateMaterializeTick(ctx(first), list)).enqueued).toBe(1)
    added.push(await idOf(org, first))
    expect((await changes.readOrgsChanged(Date.now())).has(org)).toBe(false)
  })

  it("a tick spends only the marks written up to its read: a later one waits for the next tick", async () => {
    const changes = await import("./org-changes")
    const [early, late] = [randomUUID(), randomUUID()]
    const t = Date.now()
    await changes.markOrgsChanged([early], t - 1000)
    await changes.markOrgsChanged([late], t + 60_000)
    expect((await changes.readOrgsChanged(t)).has(late)).toBe(false)
    await changes.clearOrgsChanged(t)
    const left = await changes.readOrgsChanged(t + 120_000)
    expect(left.has(early)).toBe(false)
    expect(left.has(late)).toBe(true)
    await changes.clearOrgsChanged(t + 120_000)
  })

  it("a tick without a scheduled fire time throws", async () => {
    await expect(mod.runStateMaterializeTick(undefined)).rejects.toThrow()
  })
})

// Pins WHICH users the real `defaultListActiveUsers` selects. P2-TD widened it
// to every active user: the materializer routes push and desktop too, so a
// digest cadence of 'off' (email only, S9) no longer drops a user from it.
describe("defaultListActiveUsers (real DB, post-default-flip)", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
  })

  afterAll(releaseTestLock)

  it("includes a row-less user, an explicit non-off cadence and an explicit 'off'", async () => {
    const rowlessId = randomUUID()
    const hourlyId = randomUUID()
    const offId = randomUUID()
    await withSystemDb("state-materializer-list-active-users-seed", async (tx) => {
      for (const [id, label] of [
        [rowlessId, "rowless"],
        [hourlyId, "hourly"],
        [offId, "off"],
      ] as const) {
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (${id}::uuid, ${orgId}, ${`sm-${label}-${id}@t.co`}, ${label}, 'active', 'hash', 1, 1)
        `)
      }
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, digest_cadence)
        VALUES (${hourlyId}::uuid, 'hourly')
      `)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, digest_cadence)
        VALUES (${offId}::uuid, 'off')
      `)
    })

    const { defaultListActiveUsers } = await import("./state-materializer")
    const ids = await defaultListActiveUsers(orgId)
    expect(ids).toContain(rowlessId)
    expect(ids).toContain(hourlyId)
    expect(ids).toContain(offId)
  })
})

// A provider pass past PROVIDER_TIMEOUT_MS is stopped, not abandoned: its
// transaction rolls back and its connection is back in the pool before the
// run moves on, and the work it left running can no longer reach the database.
describe("a provider pass past its time (real DB)", () => {
  let orgId: string
  let userId: string
  const fixture = new URL("./fixtures/hanging-providers.ts", import.meta.url).pathname

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    userId = await withSystemDb("state-materializer-timeout-user", async (tx) => {
      const rows = (await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`,
      )) as unknown as Array<{ id: string }>
      return rows[0]!.id
    })
  })

  afterAll(releaseTestLock)

  const register = (appName: string, handler: string) =>
    attentionItemsRegistry.set(["*", appName], { handler, bundlePath: fixture, core: true })

  const held = async () => (await import("~/db/pool-diag")).getPoolGauges().request.held

  function runDeps(seenKeys: string[][]) {
    return {
      listActiveUsers: async () => [userId],
      listKnownSourceKeys: async (_o: string, _u: string, keys: string[]) => {
        seenKeys.push(keys)
        return new Set<string>()
      },
      upsertEmailOnlyRow: async () => true,
      route: async () => ({ channels: { in_app: { deliver: false } } }) as never,
      dispatchLive: async () => {},
    }
  }

  it("a provider blocked in a statement releases its connection and the next provider runs", async () => {
    const before = await held()
    register("timeout-sleeps", "sleepsInDatabase")
    register("timeout-answers", "answers")
    const seen: string[][] = []
    const t0 = Date.now()
    await mod.runStateMaterializeOnce({ orgId }, runDeps(seen))
    const elapsed = Date.now() - t0
    expect(await held()).toBe(before)
    expect(elapsed).toBeLessThan(mod.PROVIDER_TIMEOUT_MS * 3)
    // The next pass ran and its item reached the routing step.
    expect(seen.flat()).toContain("state:kernel:sla_risk:sla:e-fast")
  })

  it("a provider hung outside any statement is rolled back and its later query is refused", async () => {
    const { lateQuery } = await import("./fixtures/hanging-providers")
    const before = await held()
    register("timeout-hangs", "hangsThenQueries")
    await mod.runStateMaterializeOnce({ orgId }, runDeps([]))
    expect(await held()).toBe(before)
    // The provider wakes after the pass was stopped and tries one more query.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(lateQuery.attempted).toBe(true)
    expect(lateQuery.ran).toBe(false)
    expect(lateQuery.error).toContain("aborted")
  })
})

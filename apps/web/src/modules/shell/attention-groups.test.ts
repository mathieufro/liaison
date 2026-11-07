// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AttentionItem } from "@liaison/shared"
import enKernel from "@liaison/shared/src/i18n/locales/en/kernel.json"
import frKernel from "@liaison/shared/src/i18n/locales/fr/kernel.json"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerManifestAppData, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import {
  type AttentionGroup,
  alertClusterLabel,
  clusterAlerts,
  groupLabel,
  groupLabelForApp,
  groupLabelKeyForApp,
  isNowItem,
  kindCountLabel,
  kindShortLabel,
  newestPromptPerChat,
  splitFeed,
  urgentStripItems,
} from "./attention-groups"

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    id: over.id ?? `item-${Math.random().toString(36).slice(2)}`,
    app: over.app ?? "tickets",
    entity: over.entity ?? "ticket",
    entityId: over.entityId ?? "t-1",
    kind: over.kind ?? "awaiting_agent",
    summary: over.summary ?? "Awaiting agent reply on TCK-1",
    urgency: over.urgency ?? 60,
    occurredAt: over.occurredAt ?? "2026-07-01T12:00:00.000Z",
    action: over.action ?? { type: "open_entity", tabType: "tickets:ticket", entityId: "t-1" },
    ...(over.metadata ? { metadata: over.metadata } : {}),
    ...(over.persisted ? { persisted: over.persisted } : {}),
    ...(over.alsoKinds ? { alsoKinds: over.alsoKinds } : {}),
  }
}

beforeEach(() => {
  resetRegistry()
  resetBootstrap()
  // The six manifests as shipped; the kernel registers its own at bootstrap.
  for (const [app, file] of Object.entries(MANIFEST_FILES)) {
    const manifest = JSON.parse(readFileSync(join(ROOT, file), "utf8"))
    registerManifestAppData(app, { attention: manifest.attention })
  }
  bootstrapKernelApps()
})
afterEach(() => resetBootstrap())

describe("attention-groups.split", () => {
  it("routes decision kinds to NOW regardless of urgency", () => {
    const feed = splitFeed([
      item({ kind: "approval_pending", urgency: 40, app: "kernel" }),
      item({ kind: "mention", urgency: 60, app: "kernel" }),
      item({ kind: "unassigned", urgency: 60 }),
    ])
    expect(feed.now.map((i) => i.kind).sort()).toEqual(["approval_pending", "mention"])
    expect(feed.groups.length).toBe(1)
    expect(feed.groups[0]!.app).toBe("tickets")
    expect(feed.total).toBe(3)
  })

  // the NOW rule (urgency >= 70) is unchanged; this pins its effect now that
  // critical incidents carry urgency 90 and warnings stay at 60.
  it("a critical monitoring incident (urgency 90) is a now item, a warning (60) is not", () => {
    const critical = item({
      app: "monitoring",
      entity: "incident",
      kind: "monitoring:incident.critical" as never,
      urgency: 90,
    })
    const warning = item({
      app: "monitoring",
      entity: "incident",
      kind: "monitoring:incident.warning" as never,
      urgency: 60,
    })
    expect(isNowItem(critical)).toBe(true)
    expect(isNowItem(warning)).toBe(false)
    const feed = splitFeed([critical, warning])
    expect(feed.now).toEqual([critical])
    expect(feed.groups.flatMap((g) => g.items)).toEqual([warning])
  })

  it("a ticket awaiting the agent lands in the now strip", () => {
    const feed = splitFeed([item({ kind: "awaiting_agent", urgency: 10 })])
    expect(isNowItem(item({ kind: "awaiting_agent", urgency: 0 }))).toBe(true)
    expect(feed.now.map((i) => i.kind)).toEqual(["awaiting_agent"])
    expect(feed.groups.length).toBe(0)
  })

  it("routes high-urgency volume kinds to NOW at >= 70", () => {
    const feed = splitFeed([
      item({ kind: "task_overdue", urgency: 85, app: "projects" }),
      item({ kind: "task_overdue", urgency: 60, app: "projects" }),
    ])
    expect(feed.now.length).toBe(1)
    expect(feed.groups[0]!.items.length).toBe(1)
  })

  it("groups by app with kind counts ordered by frequency", () => {
    const feed = splitFeed([
      item({ kind: "unassigned", entityId: "a" }),
      item({ kind: "unassigned", entityId: "b" }),
      item({ kind: "nudge_due", urgency: 30, entityId: "c" }),
    ])
    expect(feed.groups.length).toBe(1)
    const g = feed.groups[0]!
    expect(g.label).toBe("Support")
    expect(g.kindCounts).toEqual([
      { kind: "unassigned", count: 2 },
      { kind: "nudge_due", count: 1 },
    ])
  })

  it("orders groups by max urgency, then size", () => {
    const feed = splitFeed([
      item({ kind: "nudge_due", urgency: 30, app: "tickets" }),
      item({ kind: "task_due_this_week", urgency: 45, app: "projects" }),
      item({ kind: "file_shared", urgency: 20, app: "kernel", entityId: "f1" }),
      item({ kind: "file_shared", urgency: 20, app: "kernel", entityId: "f2" }),
    ])
    expect(feed.groups.map((g) => g.app)).toEqual(["projects", "tickets", "kernel"])
  })

  it("marks a group markable only when every item is persisted", () => {
    const persisted = splitFeed([
      item({
        app: "shopify",
        kind: "shopify:order.created" as never,
        urgency: 20,
        persisted: true,
      }),
    ])
    expect(persisted.groups[0]!.markable).toBe(true)
    const mixed = splitFeed([
      item({ app: "tickets", kind: "unassigned", urgency: 60 }),
      item({ app: "tickets", kind: "thread_reply", urgency: 25, persisted: true }),
    ])
    expect(mixed.groups[0]!.markable).toBe(false)
  })
})

describe("attention-groups.notifications-section", () => {
  // Informational agent notifications ("Routine X finished/failed") must NOT
  // squat in "needs you now" — they get their own collapsible group at the
  // bottom, bulk-markable, split out from the app's real work queue.
  it("routes sub-70 agent_notification items to a dedicated Notifications group", () => {
    const feed = splitFeed([
      item({
        kind: "agent_notification",
        urgency: 60,
        app: "kernel",
        summary: 'Routine "tessera-support-on-message" run failed',
        persisted: true,
      }),
      item({ kind: "unassigned", urgency: 60 }),
    ])
    expect(feed.now.length).toBe(0)
    const notif = feed.groups.find((g) => g.key === "kernel::notifications")
    expect(notif).toBeDefined()
    expect(notif!.app).toBe("kernel")
    expect(notif!.label).toBe("Notifications")
    expect(notif!.markable).toBe(true)
  })

  it("keeps urgency >= 70 agent_notification items in NOW", () => {
    expect(isNowItem(item({ kind: "agent_notification", urgency: 80, app: "kernel" }))).toBe(true)
    expect(isNowItem(item({ kind: "agent_notification", urgency: 60, app: "kernel" }))).toBe(false)
  })

  it("sinks notifications groups below work-item groups regardless of urgency", () => {
    const feed = splitFeed([
      item({ kind: "agent_notification", urgency: 60, app: "kernel", persisted: true }),
      item({ kind: "nudge_due", urgency: 30, app: "tickets" }),
    ])
    expect(feed.groups.map((g) => g.key)).toEqual(["tickets", "kernel::notifications"])
  })

  it("counts notifications with correct grammatical number", () => {
    expect(kindCountLabel("agent_notification", 1)).toBe("1 notification")
    expect(kindCountLabel("agent_notification", 3)).toBe("3 notifications")
  })
})

describe("attention-groups.now-predicate", () => {
  it("sla_risk is always NOW", () => {
    expect(isNowItem(item({ kind: "sla_risk", urgency: 50 }))).toBe(true)
  })
  it("thread_reply below 70 is not NOW", () => {
    expect(isNowItem(item({ kind: "thread_reply", urgency: 30 }))).toBe(false)
  })
})

describe("attention-groups.labels", () => {
  it("a manifest label names the group with no edit in the file", () => {
    expect(groupLabelForApp("orbit")).toBe("Orbit")
    registerManifestAppData("orbit", {
      attention: { groupLabel: { label: "Launches", labelKey: "orbit.groupLaunches" } },
    })
    expect(groupLabelForApp("orbit")).toBe("Launches")
    expect(groupLabelKeyForApp("orbit")).toBe("orbit.groupLaunches")
    const [group] = splitFeed([
      item({ app: "orbit", kind: "task_due_this_week", urgency: 10 }),
    ]).groups
    expect(group?.label).toBe("Launches")
    expect(groupLabel((key) => (key === "orbit.groupLaunches" ? "Lancements" : key), group!)).toBe(
      "Lancements",
    )
  })

  it("third-party without one gets the capitalised fallback", () => {
    expect(groupLabelForApp("boxtal")).toBe("Boxtal")
    expect(groupLabelKeyForApp("boxtal")).toBeUndefined()
  })

  it("kindShortLabel humanizes known kinds and manifest kinds", () => {
    expect(kindShortLabel("awaiting_agent")).toBe("awaiting reply")
    expect(kindShortLabel("shopify:orders.unfulfilled")).toBe("unfulfilled")
    expect(kindShortLabel("invoicing:document.overdue")).toBe("overdue")
    expect(kindShortLabel("some_custom_kind")).toBe("some custom kind")
  })

  // Regression B4: a single item read "1 replies" on the Home team tile.
  it("kindCountLabel uses the singular noun for a count of one", () => {
    expect(kindCountLabel("thread_reply", 1)).toBe("1 reply")
    expect(kindCountLabel("thread_reply", 3)).toBe("3 replies")
    expect(kindCountLabel("mention", 1)).toBe("1 mention")
    expect(kindCountLabel("mention", 2)).toBe("2 mentions")
    expect(kindCountLabel("file_shared", 1)).toBe("1 file shared")
    expect(kindCountLabel("file_shared", 4)).toBe("4 files shared")
  })

  it("kindCountLabel leaves state phrases unchanged at any count", () => {
    expect(kindCountLabel("awaiting_agent", 1)).toBe("1 awaiting reply")
    expect(kindCountLabel("unassigned", 1)).toBe("1 unassigned")
    expect(kindCountLabel("sla_risk", 1)).toBe("1 SLA risk")
  })
})

describe("attention-groups.urgentStripItems", () => {
  it("drops approval_pending, mention and access requests, keeping every other NOW kind", () => {
    const now = [
      item({ kind: "approval_pending", app: "kernel" }),
      item({ kind: "mention", app: "kernel" }),
      item({ kind: "scope_request", app: "kernel" }),
      item({ kind: "sla_risk" }),
      item({ kind: "system_alert" }),
      item({ kind: "admin_action" }),
    ]
    const strip = urgentStripItems(now)
    // An access request is a row of the approvals list, never an alert.
    expect(strip.map((i) => i.kind).sort()).toEqual(
      ["admin_action", "sla_risk", "system_alert"].sort(),
    )
  })

  it("is a no-op when there is nothing carded in the NOW list", () => {
    const now = [item({ kind: "sla_risk" }), item({ kind: "system_alert" })]
    expect(urgentStripItems(now)).toEqual(now)
  })

  it("drops app === mail items even when their kind/urgency routes them into NOW (Mail card renders them instead)", () => {
    // splitFeed puts a mail item in `now` when its kind is a NOW_KIND or its
    // urgency >= 70; the Mail card independently renders every app === "mail"
    // attention item, so such an item must never also appear in the strip.
    const now = [
      item({ kind: "sla_risk", app: "mail" }),
      item({ kind: "unassigned", app: "mail", urgency: 90 }),
      item({ kind: "sla_risk", app: "tickets" }),
    ]
    const strip = urgentStripItems(now)
    expect(strip.map((i) => i.app)).toEqual(["tickets"])
  })
})

describe("attention-groups.split -- carded kinds/apps excluded from Activity", () => {
  it("thread_reply items never surface in the grouped Activity ledger (carded by the Messages card instead)", () => {
    const feed = splitFeed([
      item({ kind: "thread_reply", app: "kernel", urgency: 30 }),
      item({ kind: "unassigned", app: "tickets" }),
    ])
    expect(feed.now.length).toBe(0)
    expect(feed.groups.map((g) => g.app)).toEqual(["tickets"])
    // thread_reply is dropped entirely from the visible split, but `total`
    // still counts it (it drives the client's aggregate unread badge math
    // via the attention feed independently of how Home renders it).
    expect(feed.total).toBe(2)
  })

  it("app === mail items never surface in the grouped Activity ledger (carded by the Mail card instead)", () => {
    const feed = splitFeed([
      item({ kind: "unassigned", app: "mail", urgency: 40 }),
      item({ kind: "unassigned", app: "tickets" }),
    ])
    expect(feed.groups.map((g) => g.app)).toEqual(["tickets"])
  })

  it("approval_pending and mention never appear in Activity groups (they are NOW items, routed to the strip's source list)", () => {
    const feed = splitFeed([
      item({ kind: "approval_pending", app: "kernel" }),
      item({ kind: "mention", app: "kernel" }),
    ])
    expect(feed.groups.length).toBe(0)
    expect(feed.now.length).toBe(2)
  })
})

describe("clusterAlerts", () => {
  const alert = (over: Partial<AttentionItem>): AttentionItem =>
    ({
      id: over.id ?? "a1",
      app: over.app ?? "tickets",
      entity: "ticket",
      entityId: over.entityId ?? "t1",
      kind: over.kind ?? "sla_risk",
      summary: "x",
      urgency: over.urgency ?? 80,
      occurredAt: over.occurredAt ?? "2026-09-11T10:00:00.000Z",
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: over.entityId ?? "t1" },
    }) as AttentionItem

  it("leaves a lone alert as an individual row", () => {
    const entries = clusterAlerts([alert({ id: "a1" })])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("item")
  })

  it("collapses 2+ alerts of the same app+kind into one cluster", () => {
    const entries = clusterAlerts([
      alert({ id: "a1", entityId: "t1" }),
      alert({ id: "a2", entityId: "t2" }),
      alert({ id: "a3", entityId: "t3" }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("cluster")
    const entry = entries[0]!
    if (entry.type !== "cluster") throw new Error("expected a cluster")
    expect(entry.cluster.items).toHaveLength(3)
    expect(entry.cluster.key).toBe("tickets::sla_risk")
  })

  it("never merges different kinds or different apps", () => {
    const entries = clusterAlerts([
      alert({ id: "a1", kind: "sla_risk" }),
      alert({ id: "a2", kind: "system_alert" }),
      alert({ id: "a3", app: "projects", kind: "sla_risk" }),
    ])
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.type === "item")).toBe(true)
  })

  it("keeps first-occurrence order, so the most urgent alert keeps the top slot", () => {
    const entries = clusterAlerts([
      alert({ id: "a1", kind: "system_alert" }),
      alert({ id: "a2", kind: "sla_risk" }),
      alert({ id: "a3", kind: "sla_risk" }),
    ])
    expect(entries.map((e) => e.key)).toEqual(["a1", "tickets::sla_risk"])
  })

  it("carries the cluster's highest urgency", () => {
    const entries = clusterAlerts([
      alert({ id: "a1", urgency: 70 }),
      alert({ id: "a2", urgency: 95 }),
    ])
    const entry = entries[0]!
    if (entry.type !== "cluster") throw new Error("expected a cluster")
    expect(entry.cluster.maxUrgency).toBe(95)
  })

  // P6-fix9 (rewalk 2026-10-08): a node permission prompt (auto-denied after
  // 10 min) is a kernel agent_notification at urgency 80, so it clustered with
  // any other urgent agent notification into a collapsed "2 notifications"
  // row. A time-limited decision must never sit behind a disclosure.
  const NOW = Date.parse("2026-10-08T10:00:00.000Z")
  const nodePrompt = (id: string, expiresAt: string | null): AttentionItem =>
    ({
      ...alert({ id, app: "kernel", kind: "agent_notification", entityId: id }),
      metadata: {
        nodePermissionPromptId: `p-${id}`,
        nodePermission: { promptId: `p-${id}`, toolName: "Bash", summary: "ls", expiresAt },
      },
    }) as AttentionItem

  it("never clusters a node permission prompt, and lifts it to the top", () => {
    const entries = clusterAlerts(
      [
        alert({ id: "n1", app: "kernel", kind: "agent_notification", entityId: "n1" }),
        alert({ id: "s1", kind: "sla_risk" }),
        nodePrompt("np", "2026-10-08T10:10:00.000Z"),
        alert({ id: "n2", app: "kernel", kind: "agent_notification", entityId: "n2" }),
      ],
      NOW,
    )
    expect(entries[0]).toMatchObject({ type: "item", key: "np" })
    // The other two agent notifications still cluster together.
    const cluster = entries.find((e) => e.type === "cluster")
    if (cluster?.type !== "cluster") throw new Error("expected a cluster")
    expect(cluster.cluster.items.map((i) => i.id)).toEqual(["n1", "n2"])
  })

  it("shows one needs-your-OK row per chat, its newest prompt", () => {
    const inChat = (id: string, chat: string, at: string): AttentionItem =>
      ({
        ...nodePrompt(id, "2026-10-08T10:10:00.000Z"),
        occurredAt: at,
        metadata: {
          ...nodePrompt(id, "2026-10-08T10:10:00.000Z").metadata,
          link: { tabType: "thread", entityId: chat },
        },
      }) as AttentionItem
    const kept = newestPromptPerChat([
      inChat("old", "t-1", "2026-10-08T09:00:00.000Z"),
      alert({ id: "s1", kind: "sla_risk" }),
      inChat("new", "t-1", "2026-10-08T09:05:00.000Z"),
      inChat("other", "t-2", "2026-10-08T09:01:00.000Z"),
    ])
    expect(kept.map((i) => i.id)).toEqual(["s1", "new", "other"])
    expect(
      clusterAlerts(
        [
          inChat("old", "t-1", "2026-10-08T09:00:00.000Z"),
          inChat("new", "t-1", "2026-10-08T09:05:00.000Z"),
        ],
        NOW,
      ).map((e) => (e.type === "item" ? e.key : "cluster")),
    ).toEqual(["new"])
  })

  it("keeps a node prompt unclustered even when its row carries no expiry", () => {
    const entries = clusterAlerts([nodePrompt("a", null), nodePrompt("b", null)], NOW)
    expect(entries.map((e) => e.type)).toEqual(["item", "item"])
  })

  it("never clusters an item that expires within the hour; a far expiry still clusters", () => {
    const soon = (id: string) =>
      ({
        ...alert({ id, kind: "admin_action", app: "kernel" }),
        metadata: { expiresAt: "2026-10-08T10:45:00.000Z" },
      }) as AttentionItem
    const later = (id: string) =>
      ({
        ...alert({ id, kind: "admin_action", app: "kernel" }),
        metadata: { expiresAt: "2026-10-11T10:00:00.000Z" },
      }) as AttentionItem
    const entries = clusterAlerts([later("l1"), soon("s1"), later("l2"), soon("s2")], NOW)
    expect(entries.map((e) => e.key)).toEqual(["s1", "s2", "kernel::admin_action"])
  })
})

describe("alertClusterLabel", () => {
  it("reads as a countable phrase for the kinds that actually pile up", () => {
    expect(alertClusterLabel("sla_risk", 24)).toBe("24 tickets approaching SLA")
    expect(alertClusterLabel("system_alert", 3)).toBe("3 system alerts")
  })

  it("falls back to the group-summary phrasing for an unmapped kind", () => {
    expect(alertClusterLabel("shopify:orders.unfulfilled", 4)).toBe("4 unfulfilled")
  })
})

// The words a reader sees over each app's group, taken from the shipped
// catalogs before the labels moved into the manifests.
const SEVEN_GROUP_WORDS: Array<[app: string, en: string, fr: string]> = [
  ["tickets", "Support", "Assistance"],
  ["shopify", "Orders", "Commandes"],
  ["invoicing", "Invoicing", "Facturation"],
  ["projects", "Tasks", "Tâches"],
  ["knowledge", "Knowledge", "Connaissances"],
  ["kernel", "Team", "Équipe"],
  ["mail", "Mail", "Mail"],
]

const ROOT = join(import.meta.dirname, "../../../../..")
const MANIFEST_FILES: Record<string, string> = {
  tickets: "apps/api/src/apps/tickets/app.manifest.json",
  shopify: "bundled-apps/shopify/app.manifest.json",
  invoicing: "bundled-apps/invoicing/app.manifest.json",
  projects: "apps/api/src/apps/projects/app.manifest.json",
  knowledge: "apps/api/src/apps/knowledge/app.manifest.json",
  mail: "apps/api/src/apps/mail/app.manifest.json",
}

describe("attention-groups.seven-apps", () => {
  const tIn = (catalog: Record<string, unknown>) => (key: string) => {
    const word = catalog[key.replace(/^kernel\./, "")]
    return typeof word === "string" ? word : key
  }
  it("the seven read the same words, en and fr", () => {
    for (const [app, en, fr] of SEVEN_GROUP_WORDS) {
      const group = {
        label: groupLabelForApp(app),
        labelKey: groupLabelKeyForApp(app),
      } as AttentionGroup
      expect(groupLabel(tIn(enKernel), group), app).toBe(en)
      expect(groupLabel(tIn(frKernel), group), app).toBe(fr)
    }
  })
})

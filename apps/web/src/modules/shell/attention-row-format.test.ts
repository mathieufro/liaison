// SPDX-License-Identifier: FSL-1.1-ALv2

import { dictionariesFor } from "@liaison/shared"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { CircleAlert } from "lucide-solid"
import { describe, expect, test } from "vitest"
import {
  getAppLabel,
  getKindIcon,
  getMetric,
  kernelAttentionTitle,
  type RowLocale,
} from "./attention-row-format"

describe("attention row format — dm_window_closing (A9)", () => {
  test("getKindIcon('dm_window_closing') resolves a real glyph (not the unknown-kind fallback)", () => {
    const entry = getKindIcon("dm_window_closing")
    expect(entry).toBeDefined()
    expect(entry.icon).toBeDefined()
    // Must be a deliberate mapping, not the CircleAlert fallback for an
    // unmapped kind — a forgotten KIND_ICON entry is red here.
    expect(entry.icon).not.toBe(CircleAlert)
    expect(entry.tone).toBeDefined()
  })
})

describe("attention row format — thread_followup (A6)", () => {
  test("a reply in a followed thread reads with the reply glyph, not the unknown-kind fallback", () => {
    const entry = getKindIcon("thread_followup")
    expect(entry.icon).not.toBe(CircleAlert)
    expect(entry.icon).toBe(getKindIcon("thread_reply").icon)
  })
})

describe("attention row format — sla_risk metric", () => {
  const slaItem = (metadata?: Record<string, unknown>) =>
    ({
      id: "a1",
      app: "tickets",
      entity: "ticket",
      entityId: "t1",
      kind: "sla_risk",
      summary: "SLA approaching for ticket-10431",
      urgency: 80,
      occurredAt: "2026-09-11T10:00:00.000Z",
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: "t1" },
      metadata,
    }) as never

  test("states the remaining time when the provider gave one", () => {
    expect(getMetric(slaItem({ slaSecondsLeft: 1800 })).text).toContain("sla")
    expect(getMetric(slaItem({ slaSecondsLeft: 1800 })).text).not.toBe("0s sla")
  })

  test("states NOTHING when slaSecondsLeft is missing, rather than a false '0s sla'", () => {
    // A gestalt walk caught this on a row with no metadata: "0s sla" reads as
    // an SLA already blown, on a row whose point is that it is approaching.
    expect(getMetric(slaItem()).text).toBe("")
    expect(getMetric(slaItem({})).text).toBe("")
    expect(getMetric(slaItem({ slaSecondsLeft: "soon" })).text).toBe("")
  })
})

describe("attention row format — approval countdown", () => {
  const approval = (metadata?: Record<string, unknown>) =>
    ({
      id: "kernel:approval_pending:r3",
      app: "kernel",
      entity: "approval_request",
      entityId: "r3",
      kind: "approval_pending",
      summary: "Stalled: Remediation: delete rgpd customer",
      urgency: 95,
      occurredAt: "2026-07-07T10:00:00.000Z",
      action: { type: "decide_approval", approvalId: "r3" },
      metadata,
    }) as never

  test("a wedged (already approved) row has no countdown", () => {
    // The walk: "0 s restant" on a request approved 77 days earlier.
    expect(getMetric(approval({ wedged: true, expiresInSeconds: 0 })).text).toBe("")
  })

  test("a deadline already past states nothing rather than '0s left'", () => {
    expect(getMetric(approval({ expiresInSeconds: 0 })).text).toBe("")
  })

  test("a live deadline still reads", () => {
    expect(getMetric(approval({ expiresInSeconds: 1500 })).text).not.toBe("")
  })
})

describe("attention row format — kernel source label", () => {
  test("kernel rows take their source from the kind, not a blanket 'Approvals'", () => {
    // A gestalt walk found "Outbox worker fell behind · Approvals · 3h ago"
    // rendered right under the real Approvals card.
    expect(getAppLabel("kernel", "system_alert")).toBe("System")
    expect(getAppLabel("kernel", "admin_action")).toBe("System")
    expect(getAppLabel("kernel", "scope_request")).toBe("Access")
    expect(getAppLabel("kernel", "approval_pending")).toBe("Approvals")
  })

  test("a non-kernel app is unaffected, and a kindless call keeps the old label", () => {
    expect(getAppLabel("tickets", "sla_risk")).toBe("Tickets")
    expect(getAppLabel("kernel")).toBe("Approvals")
  })
})

// Every row in the feed carries a metric chip, and every one of them was an
// English literal built in `getMetric`: a French reader saw "blocked",
// "unassigned", "follow-up", "3d over" and "45m sla" on rows whose summary,
// source and time had all been translated around them. The chip is the most
// space constrained string on the row, so French keeps the abbreviations
// ("j", "h", "min") rather than spelling the unit out.
describe("attention row format — metric chip follows the reader's language", () => {
  const item = (kind: string, metadata?: Record<string, unknown>) =>
    ({
      id: "m1",
      app: "tickets",
      entity: "ticket",
      entityId: "t1",
      kind,
      summary: "s",
      urgency: 50,
      occurredAt: new Date().toISOString(),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: "t1" },
      metadata,
    }) as never

  function localeFor(locale: "en" | "fr"): RowLocale {
    const flat: Record<string, unknown> = {}
    for (const [ns, dict] of Object.entries(dictionariesFor(locale))) {
      for (const [k, v] of Object.entries(flatten(dict as Record<string, unknown>))) {
        flat[`${ns}.${k}`] = v
      }
    }
    return {
      locale,
      t: (key, params) => {
        const raw = flat[key]
        if (typeof raw !== "string") return key
        return params ? resolveTemplate(raw, params) : raw
      },
    }
  }

  const fr = localeFor("fr")
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

  const CASES: Array<[string, ReturnType<typeof item>, string, string]> = [
    ["task_overdue", item("task_overdue", { daysOver: 3 }), "3d over", "3 j de retard"],
    [
      "task_overdue today",
      item("task_overdue", { daysOver: 0 }),
      "due today",
      "échéance aujourd'hui",
    ],
    ["task_due_this_week", item("task_due_this_week", { daysRemaining: 4 }), "in 4d", "dans 4 j"],
    ["task_blocked", item("task_blocked"), "blocked", "bloqué"],
    ["sla_risk", item("sla_risk", { slaSecondsLeft: 1800 }), "30m sla", "30 min SLA"],
    [
      "awaiting_agent",
      item("awaiting_agent", { lastInboundAt: hoursAgo(2) }),
      "2h waiting",
      "2 h d'attente",
    ],
    ["unassigned", item("unassigned"), "unassigned", "non attribué"],
    ["followup_due", item("followup_due"), "follow-up", "relance"],
    ["nudge_due", item("nudge_due"), "nudge", "à relancer"],
    [
      "approval_pending",
      item("approval_pending", { expiresInSeconds: 1500 }),
      // What runs out, said (cold walk 2026-11-08): never "25m left".
      "Expires in 25 minutes",
      "Expire dans 25 minutes",
    ],
    ["admin_action", item("admin_action"), "admin", "admin"],
    [
      "dm_window_closing",
      item("dm_window_closing", { windowSecondsLeft: 10_800 }),
      "3h to close",
      "3 h avant clôture",
    ],
  ]

  for (const [name, row, english, french] of CASES) {
    test(`${name}: French reads French, English is unchanged`, () => {
      expect(getMetric(row, fr).text).toBe(french)
      expect(getMetric(row).text).toBe(english)
    })
  }

  test("no metric chip is left in English under the French locale", () => {
    const leftovers = CASES.filter(
      ([, row, english]) => english !== "admin" && getMetric(row, fr).text === english,
    ).map(([name]) => name)
    expect(leftovers).toEqual([])
  })

  test("the tone is the reader's language's business too: it does not move", () => {
    expect(getMetric(item("task_overdue", { daysOver: 3 }), fr).tone).toBe("warning")
    expect(getMetric(item("task_blocked"), fr).tone).toBe("tertiary")
  })
})

describe("attention row format — a routed request waiting a day", () => {
  const flat = (locale: "en" | "fr") => {
    const out: Record<string, unknown> = {}
    for (const [ns, dict] of Object.entries(dictionariesFor(locale))) {
      for (const [k, v] of Object.entries(flatten(dict as Record<string, unknown>))) {
        out[`${ns}.${k}`] = v
      }
    }
    return (key: string, params?: Record<string, string | number | boolean>) => {
      const raw = out[key]
      if (typeof raw !== "string") return key
      return params ? resolveTemplate(raw, params) : raw
    }
  }
  const reminder = {
    app: "kernel",
    kind: "agent_notification",
    summary: "Waiting more than 24 hours for a decision: Pay supplier",
    metadata: { routedReminder: { approvalId: "a1", hours: 24 } },
  }

  test("reads in English as written and in French from the catalog", () => {
    expect(kernelAttentionTitle(reminder, flat("en"))).toBe(reminder.summary)
    expect(kernelAttentionTitle(reminder, flat("fr"))).toBe(
      "En attente d'une décision depuis plus de 24 heures : Pay supplier",
    )
  })
})

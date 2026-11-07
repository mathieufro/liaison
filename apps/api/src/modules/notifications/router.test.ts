// SPDX-License-Identifier: FSL-1.1-ALv2
// S1: the router decides, per channel, deliver or suppress with a reason. Each
// test below fails when its rule is removed from `decide` in router.ts
// (mutation: delete the rule's branch, the named test goes red).
import { describe, expect, it } from "bun:test"
import { DEFAULT_GRID, effectiveGrid } from "@liaison/shared"
import {
  mutedSessionDecision,
  type RecipientContext,
  type RouterDecision,
  type RouterItem,
  resolveChannels,
  routerDegradedCount,
} from "./router"

const recipient = { userId: "u1", orgId: "o1" }

// Monday 2026-09-28 10:00 UTC (inside 09-17 Mon-Fri) and 20:00 UTC (outside).
const INSIDE = new Date("2026-09-28T10:00:00.000Z")
const OUTSIDE = new Date("2026-09-28T20:00:00.000Z")

function ctx(over: Partial<RecipientContext> = {}): RecipientContext {
  return {
    grid: effectiveGrid(null),
    digestCadence: "daily",
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
    // Rule 8 as shipped (the env default is off under NODE_ENV=test), with a
    // known clock: the person's UTC, set explicitly.
    defaultQuietHours: true,
    timezoneSet: true,
    ...over,
  }
}

const directMessage: RouterItem = {
  kind: "message",
  app: "kernel",
  threadId: "t1",
  isUrgent: false,
  chatMessage: { direct: true },
}
const threadReply: RouterItem = {
  kind: "thread_reply",
  app: "kernel",
  threadId: "t1",
  isUrgent: false,
}
const slaRisk: RouterItem = { kind: "sla_risk", app: "tickets", isUrgent: false }
const agentAlert: RouterItem = { kind: "agent_notification", app: "kernel", isUrgent: false }

function run(item: RouterItem, c: RecipientContext, now = INSIDE): Promise<RouterDecision> {
  return resolveChannels(recipient, item, { now, loadContext: async () => c })
}

describe("resolveChannels", () => {
  it("active_in_thread: a message in a thread the recipient is in is not pushed or raised", async () => {
    const message: RouterItem = { ...directMessage, presenceKey: "t1" }
    const d = await run(message, ctx({ activeInThread: true }))
    expect(d.channels.push).toEqual({ deliver: false, reason: "active_in_thread" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "active_in_thread" })
    // The in-app record and the email digest are not device interruptions.
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.email.deliver).toBe(true)
    // Urgency does not break through: the recipient is looking at it.
    const urgent = await run({ ...message, isUrgent: true }, ctx({ activeInThread: true }))
    expect(urgent.channels.push.reason).toBe("active_in_thread")

    const away = await run(message, ctx({ activeInThread: false }))
    expect(away.channels.push.deliver).toBe(true)
    expect(away.channels.desktop.deliver).toBe(true)
  })

  it("active_in_thread applies to thread messages only", async () => {
    const d = await run(directMessage, ctx({ activeInThread: true }))
    expect(d.channels.push.deliver).toBe(true)
  })

  it("delivers a direct message on every channel with the default grid", async () => {
    const d = await run(directMessage, ctx())
    expect(d.group).toBe("direct")
    for (const ch of ["in_app", "desktop", "push", "email"] as const) {
      expect(d.channels[ch].deliver).toBe(true)
    }
  })

  it("grid_off: a cell switched off suppresses that channel only", async () => {
    // Defaults: work push and desktop are off.
    const d = await run(slaRisk, ctx())
    expect(d.group).toBe("work")
    expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "grid_off" })
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.email.deliver).toBe(true)

    const grid = effectiveGrid({ direct: { push: false } })
    const off = await run(directMessage, ctx({ grid }))
    expect(off.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect(off.channels.desktop.deliver).toBe(true)
  })

  // Etiquette rule 2: interrupt only for a direct ask. A channel post goes to
  // the inbox quietly unless the member opted that channel into every post.
  it("a channel post is inbox-only by default; a channel opted into every post interrupts", async () => {
    const channelPost: RouterItem = { ...directMessage, chatMessage: { direct: false } }
    const d = await run(channelPost, ctx())
    expect(d.group).toBe("replies")
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "grid_off" })
    expect(d.channels.email.deliver).toBe(true)

    const all = await run(channelPost, ctx({ threadNotifyAll: true }))
    expect(all.group).toBe("replies")
    expect(all.channels.push.deliver).toBe(true)
    expect(all.channels.desktop.deliver).toBe(true)
    // The direct row still rules the live cells of an opted-in channel.
    const directOff = effectiveGrid({ direct: { push: false } })
    const muted = await run(channelPost, ctx({ threadNotifyAll: true, grid: directOff }))
    expect(muted.channels.push).toEqual({ deliver: false, reason: "grid_off" })
  })

  it("rule 9: new email and a decision on your own request are inbox-only by default", async () => {
    for (const kind of ["new_email", "approval_decision", "scope_request_decided"]) {
      const d = await run({ kind, app: "kernel", isUrgent: false }, ctx())
      expect(d.channels.in_app.deliver, kind).toBe(true)
      expect(d.channels.push.deliver, kind).toBe(false)
      expect(d.channels.desktop.deliver, kind).toBe(false)
    }
    // An approval only you can decide is still a direct ask.
    const ask = await run({ kind: "approval_pending", app: "kernel", isUrgent: false }, ctx())
    expect(ask.channels.push.deliver).toBe(true)
  })

  it("grid_off: digest cadence off reads as every email cell off", async () => {
    const d = await run(directMessage, ctx({ digestCadence: "off" }))
    expect(d.channels.email).toEqual({ deliver: false, reason: "grid_off" })
    expect(d.channels.push.deliver).toBe(true)
  })

  it("app_rule: a switched-off app suppresses every channel, in_app included", async () => {
    const rules = [{ source: "tickets", kinds: ["*"], filters: {}, enabled: false }]
    const d = await run(
      slaRisk,
      ctx({ appRules: rules, grid: effectiveGrid({ work: { push: true } }) }),
    )
    for (const ch of ["in_app", "desktop", "push", "email"] as const) {
      expect(d.channels[ch]).toEqual({ deliver: false, reason: "app_rule" })
    }
  })

  it("app_rule: an unticked kind suppresses it, a ticked one passes", async () => {
    const rules = [{ source: "tickets", kinds: ["unassigned"], filters: {}, enabled: true }]
    const d = await run(slaRisk, ctx({ appRules: rules }))
    expect(d.channels.in_app).toEqual({ deliver: false, reason: "app_rule" })
    const ok = await run({ ...slaRisk, kind: "unassigned" }, ctx({ appRules: rules }))
    expect(ok.channels.in_app.deliver).toBe(true)
  })

  it("app_rule: a mention and a system alert are never narrowed by a rule, as today", async () => {
    const rules = [{ source: "kernel", kinds: ["thread_reply"], filters: {}, enabled: true }]
    const mention = await run(
      { kind: "mention", app: "kernel", isUrgent: false },
      ctx({ appRules: rules }),
    )
    expect(mention.channels.in_app.deliver).toBe(true)
    const sys = await run(
      { kind: "system_alert", app: "kernel", isUrgent: false },
      ctx({ appRules: rules }),
    )
    expect(sys.channels.in_app.deliver).toBe(true)
  })

  it("thread_muted: a muted (or archived) thread silences a reply on push, desktop and email, and keeps it quietly in the inbox", async () => {
    const d = await run(threadReply, ctx({ threadMuted: true }))
    expect(d.group).toBe("replies")
    for (const ch of ["desktop", "push", "email"] as const) {
      expect(d.channels[ch]).toEqual({ deliver: false, reason: "thread_muted" })
    }
    // Rule 7: still in the inbox list, quietly (recorded read, so not badged).
    expect(d.channels.in_app).toEqual({ deliver: true, quiet: true })
  })

  it("rule 7: mute means mute: a muted direct conversation, a mention and an urgent item are silenced too", async () => {
    const dm = await run(directMessage, ctx({ threadMuted: true }))
    expect(dm.group).toBe("direct")
    expect(dm.channels.push).toEqual({ deliver: false, reason: "thread_muted" })
    expect(dm.channels.desktop).toEqual({ deliver: false, reason: "thread_muted" })
    expect(dm.channels.email).toEqual({ deliver: false, reason: "thread_muted" })
    const mention = await run(
      { ...directMessage, chatMessage: { direct: false }, isMention: true },
      ctx({ threadMuted: true }),
    )
    expect(mention.channels.push).toEqual({ deliver: false, reason: "thread_muted" })
    const mentionRow = await run(
      { kind: "mention", app: "kernel", threadId: "t1", isUrgent: false, isMention: true },
      ctx({ threadMuted: true }),
    )
    expect(mentionRow.channels.in_app).toEqual({ deliver: true, quiet: true })
    expect(mentionRow.channels.email.deliver).toBe(false)
    const urgent = await run(
      { ...agentAlert, threadId: "t1", isUrgent: true },
      ctx({ threadMuted: true }),
    )
    expect(urgent.channels.push.reason).toBe("thread_muted")
  })

  it("rule 7: a kind set to off is silenced on push, desktop and email, kept quietly in the inbox", async () => {
    const d = await run(agentAlert, ctx({ mutedGroups: ["agent"] }))
    expect(d.group).toBe("agent")
    for (const ch of ["desktop", "push", "email"] as const) {
      expect(d.channels[ch]).toEqual({ deliver: false, reason: "kind_muted" })
    }
    expect(d.channels.in_app).toEqual({ deliver: true, quiet: true })
    // An urgent item of a muted kind (an approval for its approver) stays silent too.
    const approval = await run(
      { kind: "approval_pending", app: "kernel", isUrgent: false, approverIds: ["u1"] },
      ctx({ mutedGroups: ["approvals"] }),
    )
    expect(approval.urgent).toBe(true)
    expect(approval.channels.email).toEqual({ deliver: false, reason: "kind_muted" })
    // Other kinds are untouched.
    expect((await run(directMessage, ctx({ mutedGroups: ["agent"] }))).channels.push.deliver).toBe(
      true,
    )
  })

  it("quiet_time: explicit work hours hold back push and desktop outside hours; email is deferred", async () => {
    const d = await run(directMessage, ctx({ workHoursExplicit: true }), OUTSIDE)
    expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.email.deliver).toBe(true)
    // Next window: Tuesday 09:00 UTC.
    expect(d.channels.email.eligibleAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z")
  })

  it("quiet_time: inside work hours nothing is held back", async () => {
    const d = await run(directMessage, ctx({ workHoursExplicit: true }), INSIDE)
    expect(d.channels.push.deliver).toBe(true)
    expect(d.channels.email.eligibleAt?.toISOString()).toBe(INSIDE.toISOString())
  })

  it("rule 8: quiet hours are on by default: 20:00-08:00 on weekdays and all weekend", async () => {
    // Monday 20:00 UTC: quiet by default, though the person never set hours.
    const d = await run(directMessage, ctx({ workHoursExplicit: false }), OUTSIDE)
    expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.in_app.deliver).toBe(true)
    // Email waits for the default window: Tuesday 08:00 UTC.
    expect(d.channels.email.eligibleAt?.toISOString()).toBe("2026-09-29T08:00:00.000Z")
    // Monday 19:00 is inside the default window; 07:30 is not.
    const evening = await run(directMessage, ctx(), new Date("2026-09-28T19:00:00.000Z"))
    expect(evening.channels.push.deliver).toBe(true)
    const early = await run(directMessage, ctx(), new Date("2026-09-28T07:30:00.000Z"))
    expect(early.channels.push.reason).toBe("quiet_time")
    // Saturday noon: quiet all day.
    const saturday = await run(directMessage, ctx(), new Date("2026-10-03T12:00:00.000Z"))
    expect(saturday.channels.push.reason).toBe("quiet_time")
  })

  it("rule 8: default quiet hours read the user's time zone, else the org's, else UTC", async () => {
    // Monday 20:00 UTC is 22:00 in Paris (quiet) and 16:00 in New York (not quiet).
    const user = await run(
      directMessage,
      ctx({
        workHours: {
          workHoursStart: "09:00",
          workHoursEnd: "17:00",
          workDays: [1, 2, 3, 4, 5],
          timezone: "America/New_York",
        },
        orgTimezone: "Europe/Paris",
      }),
      OUTSIDE,
    )
    expect(user.channels.push.deliver).toBe(true)
    // The person's zone never set: the org's set New York clock applies.
    const org = await run(
      directMessage,
      ctx({ timezoneSet: false, orgTimezone: "America/New_York", orgTimezoneSet: true }),
      OUTSIDE,
    )
    expect(org.channels.push.deliver).toBe(true)
    // A profile zone counts as the person's own.
    const profile = await run(
      directMessage,
      ctx({ timezoneSet: false, profileTimezone: "Europe/Paris" }),
      OUTSIDE,
    )
    expect(profile.channels.push.reason).toBe("quiet_time")
  })

  it("rule 8: with no known time zone the default quiet hours do not apply (never guess UTC)", async () => {
    // The person's UTC is the column default, the org's too: unknown.
    const d = await run(
      directMessage,
      ctx({ timezoneSet: false, orgTimezone: "UTC", orgTimezoneSet: false }),
      OUTSIDE,
    )
    expect(d.channels.push.deliver).toBe(true)
    expect(d.channels.desktop.deliver).toBe(true)
    // The org's UTC chosen explicitly is a known clock.
    const known = await run(
      directMessage,
      ctx({ timezoneSet: false, orgTimezone: "UTC", orgTimezoneSet: true }),
      OUTSIDE,
    )
    expect(known.channels.push.reason).toBe("quiet_time")
    // Hours the person set apply in their zone, known or not.
    const own = await run(
      directMessage,
      ctx({ timezoneSet: false, workHoursExplicit: true }),
      OUTSIDE,
    )
    expect(own.channels.push.reason).toBe("quiet_time")
  })

  it("rule 8: an urgent item that is not an on-call incident waits for the morning", async () => {
    const d = await run(
      { ...agentAlert, isUrgent: true },
      ctx({ workHoursExplicit: true }),
      OUTSIDE,
    )
    expect(d.urgent).toBe(true)
    expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "quiet_time" })
    expect(d.channels.email.eligibleAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z")
    // Inside the window it is emailed at once.
    const day = await run({ ...agentAlert, isUrgent: true }, ctx({ workHoursExplicit: true }))
    expect(day.channels.push.deliver).toBe(true)
    expect(day.channels.email.eligibleAt?.toISOString()).toBe(INSIDE.toISOString())
  })

  it("urgent: an approval pending on this user is urgent, on someone else it is not", async () => {
    const item: RouterItem = {
      kind: "approval_pending",
      app: "kernel",
      isUrgent: false,
      approverIds: ["u1"],
    }
    const mine = await run(item, ctx({ workHoursExplicit: true }), OUTSIDE)
    expect(mine.urgent).toBe(true)
    // Quiet hours hold it back (rule 8): only on-call incidents cross them.
    expect(mine.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    expect((await run(item, ctx({ workHoursExplicit: true }))).channels.push.deliver).toBe(true)
    const theirs = await run(
      { ...item, approverIds: ["u2"] },
      ctx({ workHoursExplicit: true }),
      OUTSIDE,
    )
    expect(theirs.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
  })

  it("urgent does not override a cell switched off, a mute or an app rule", async () => {
    const urgentWork = { ...slaRisk, isUrgent: true }
    expect((await run(urgentWork, ctx())).channels.push).toEqual({
      deliver: false,
      reason: "grid_off",
    })
    const urgentReply = { ...threadReply, isUrgent: true }
    expect((await run(urgentReply, ctx({ threadMuted: true }))).channels.push).toEqual({
      deliver: false,
      reason: "thread_muted",
    })
    const rules = [{ source: "tickets", kinds: ["*"], filters: {}, enabled: false }]
    expect((await run(urgentWork, ctx({ appRules: rules }))).channels.in_app).toEqual({
      deliver: false,
      reason: "app_rule",
    })
  })

  it("no_device: push is suppressed when the user has no registered token", async () => {
    const d = await run(directMessage, ctx({ hasPushDevice: false }))
    expect(d.channels.push).toEqual({ deliver: false, reason: "no_device" })
    expect(d.channels.desktop.deliver).toBe(true)
  })

  it("a load failure keeps in_app, leaves email to the digest, suppresses push/desktop and counts it", async () => {
    const before = routerDegradedCount()
    const d = await resolveChannels(recipient, directMessage, {
      now: INSIDE,
      loadContext: async () => {
        throw new Error("db down")
      },
    })
    expect(d.degraded).toBe(true)
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.email).toEqual({ deliver: true, recheck: true })
    expect(d.channels.push).toEqual({ deliver: false, reason: "router_error" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "router_error" })
    expect(routerDegradedCount()).toBe(before + 1)
  })

  it("groups an app-namespaced kind under work", async () => {
    const d = await run({ kind: "shopify:order.created", app: "shopify", isUrgent: false }, ctx())
    expect(d.group).toBe("work")
    expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect(DEFAULT_GRID.work.push).toBe(false)
  })

  describe("monitoring incidents group", () => {
    const critical: RouterItem = {
      kind: "monitoring:incident.critical",
      app: "monitoring",
      isUrgent: true,
    }
    const warning: RouterItem = {
      kind: "monitoring:incident.warning",
      app: "monitoring",
      isUrgent: false,
    }
    // Explicit even though they equal the defaults: the preconditions of the criterion.
    const pushOnForIncidents = effectiveGrid({ monitoring: { push: true }, work: { push: false } })

    it("an urgent critical incident pushes outside explicit work hours", async () => {
      const d = await run(
        critical,
        ctx({ grid: pushOnForIncidents, workHoursExplicit: true }),
        OUTSIDE,
      )
      expect(d.group).toBe("monitoring")
      expect(d.urgent).toBe(true)
      expect(d.channels.push.deliver).toBe(true)
      expect(d.channels.desktop.deliver).toBe(true)
    })

    it("a warning is suppressed on push and desktop in quiet time, and never replayed", async () => {
      const d = await run(
        warning,
        ctx({ grid: pushOnForIncidents, workHoursExplicit: true }),
        OUTSIDE,
      )
      expect(d.group).toBe("monitoring")
      expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
      expect(d.channels.desktop).toEqual({ deliver: false, reason: "quiet_time" })
      // Still in the feed. Nothing replays push when the window opens, so no later delivery is asserted.
      expect(d.channels.in_app.deliver).toBe(true)
      // Monitoring email is off by default.
      expect(d.channels.email).toEqual({ deliver: false, reason: "grid_off" })
    })

    it("a work kind stays on its own group: work push off beats quiet time", async () => {
      // The work fallback is unchanged: work push off wins over quiet time.
      const d = await run(
        { kind: "task_overdue", app: "projects", isUrgent: false },
        ctx({ grid: pushOnForIncidents, workHoursExplicit: true }),
        OUTSIDE,
      )
      expect(d.group).toBe("work")
      expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    })

    it("urgency never overrides a switched-off monitoring push, inside or outside work hours", async () => {
      for (const now of [INSIDE, OUTSIDE]) {
        const d = await run(
          critical,
          ctx({ grid: effectiveGrid({ monitoring: { push: false } }), workHoursExplicit: true }),
          now,
        )
        expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
        expect(d.channels.desktop.deliver).toBe(true)
      }
    })

    it("rule 8: without explicit work hours a warning is held in the default quiet hours", async () => {
      const d = await run(warning, ctx({ workHoursExplicit: false }), OUTSIDE)
      expect(d.group).toBe("monitoring")
      expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
      // A critical incident for someone on call crosses the default quiet hours.
      const c = await run(critical, ctx({ workHoursExplicit: false, onCall: true }), OUTSIDE)
      expect(c.channels.push.deliver).toBe(true)
      expect(c.channels.desktop.deliver).toBe(true)
    })

    it("rule 9: an incident interrupts only the people on call; the others get it in the inbox", async () => {
      for (const now of [INSIDE, OUTSIDE]) {
        const d = await run(critical, ctx({ onCall: false }), now)
        expect(d.channels.push).toEqual({ deliver: false, reason: "not_on_call" })
        expect(d.channels.desktop).toEqual({ deliver: false, reason: "not_on_call" })
        expect(d.channels.in_app).toEqual({ deliver: true })
      }
      // Not on call, the urgent email path is closed too: the row is not urgent
      // for them and waits for their digest window.
      const emailOn = effectiveGrid({ monitoring: { email: true } })
      const notOnCall = await run(
        critical,
        ctx({ grid: emailOn, onCall: false, workHoursExplicit: true }),
        OUTSIDE,
      )
      expect(notOnCall.urgent).toBe(false)
      expect(notOnCall.channels.email.eligibleAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z")
      const onCallMail = await run(
        critical,
        ctx({ grid: emailOn, onCall: true, workHoursExplicit: true }),
        OUTSIDE,
      )
      expect(onCallMail.channels.email.eligibleAt?.toISOString()).toBe(OUTSIDE.toISOString())
      const onCall = await run(warning, ctx({ onCall: true }), INSIDE)
      expect(onCall.channels.push.deliver).toBe(true)
      // On-call status touches incidents only.
      expect((await run(directMessage, ctx({ onCall: false }))).channels.push.deliver).toBe(true)
    })
  })

  it("S11: a session notice routes to its own group, held back on push and desktop while on screen", async () => {
    const notice: RouterItem = {
      kind: "node_session_done",
      app: "kernel",
      entityType: "node_session",
      entityId: "s1",
      isUrgent: false,
      presenceKey: "s1",
      sessionPresence: true,
    }
    const away = await run(notice, ctx())
    expect(away.group).toBe("session_done")
    expect(away.channels.push).toEqual({ deliver: true })
    expect(away.channels.desktop).toEqual({ deliver: true })
    expect(away.channels.email).toEqual({ deliver: false, reason: "grid_off" })
    const here = await run(notice, ctx({ activeInThread: true }))
    expect(here.channels.in_app).toEqual({ deliver: true })
    expect(here.channels.push).toEqual({ deliver: false, reason: "active_in_thread" })
    expect(here.channels.desktop).toEqual({ deliver: false, reason: "active_in_thread" })
    const off = await run(notice, ctx({ grid: effectiveGrid({ session_done: { push: false } }) }))
    expect(off.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect((await run({ ...notice, kind: "node_session_needs_you" }, ctx())).group).toBe(
      "session_needs_you",
    )
    expect((await run({ ...notice, kind: "node_session_failed" }, ctx())).group).toBe(
      "session_failed",
    )
  })

  it("S14: a muted session's decision keeps in_app and turns push, desktop and email off", async () => {
    const notice: RouterItem = {
      kind: "node_session_needs_you",
      app: "kernel",
      isUrgent: true,
    }
    const routed = await run(
      notice,
      ctx({ grid: effectiveGrid({ session_needs_you: { email: true } }) }),
    )
    expect(routed.channels.email.deliver).toBe(true)
    const muted = mutedSessionDecision(routed)
    expect(muted.channels).toEqual({
      in_app: { deliver: true },
      desktop: { deliver: false, reason: "session_muted" },
      push: { deliver: false, reason: "session_muted" },
      email: { deliver: false, reason: "session_muted" },
    })
    expect(muted.group).toBe("session_needs_you")
    expect(muted.userId).toBe(recipient.userId)
  })
})

describe("approvals routed to a person", () => {
  const ask = (placement?: "mine" | "standing_in" | "others"): RouterItem => ({
    kind: "approval_pending",
    app: "kernel",
    isUrgent: false,
    approverIds: ["u1"],
    ...(placement ? { placement } : {}),
  })

  it("approval_pending to route and stand-in: the person it is for and the one standing in are asked at once", async () => {
    for (const placement of ["mine", "standing_in"] as const) {
      const d = await run(ask(placement), ctx())
      expect(d.urgent, placement).toBe(true)
      expect(d.channels.in_app.deliver, placement).toBe(true)
      expect(d.channels.push.deliver, placement).toBe(true)
      expect(d.channels.desktop.deliver, placement).toBe(true)
      expect(d.channels.email.deliver, placement).toBe(true)
    }
  })

  it("usual to all deciders: a row with no placement asks every decider the same way", async () => {
    for (const userId of ["u1", "u2", "u3"]) {
      const d = await resolveChannels(
        { userId, orgId: "o1" },
        { ...ask(), approverIds: [userId] },
        { now: INSIDE, loadContext: async () => ctx() },
      )
      expect(d.urgent, userId).toBe(true)
      expect(d.channels.push.deliver, userId).toBe(true)
    }
  })

  it("an others row sends no push: it stays in the feed and is nobody else's news", async () => {
    const d = await run(ask("others"), ctx())
    expect(d.urgent).toBe(false)
    expect(d.channels.in_app.deliver).toBe(true)
    for (const ch of ["push", "desktop", "email"] as const) {
      expect(d.channels[ch], ch).toEqual({ deliver: false, reason: "not_for_you" })
    }
  })

  it("an away person's non-urgent email waits for the first work window after the range", async () => {
    // Away through Friday 2026-10-02, asked on Monday 2026-09-28 at 10:00 UTC.
    const away = ctx({ awayUntil: "2026-10-02", workHoursExplicit: true })
    const d = await run(directMessage, away)
    expect(d.channels.push).toEqual({ deliver: false, reason: "away" })
    expect(d.channels.desktop).toEqual({ deliver: false, reason: "away" })
    expect(d.channels.in_app.deliver).toBe(true)
    expect(d.channels.email.deliver).toBe(true)
    // Saturday and Sunday are no work days: Monday 2026-10-05 at 09:00.
    expect(d.channels.email.eligibleAt?.toISOString()).toBe("2026-10-05T09:00:00.000Z")

    // The same item for someone who is not away is unchanged.
    const home = await run(directMessage, ctx({ workHoursExplicit: true }))
    expect(home.channels.email.eligibleAt?.toISOString()).toBe(INSIDE.toISOString())
  })

  it("an away person is still asked for what only they decide, and an urgent item still reaches them", async () => {
    const away = ctx({ awayUntil: "2026-10-02", workHoursExplicit: true })
    const d = await run(ask("mine"), away)
    expect(d.channels.push.deliver).toBe(true)
    expect(d.channels.email.eligibleAt?.toISOString()).toBe(INSIDE.toISOString())
    const urgent = await run({ ...directMessage, isUrgent: true }, away)
    expect(urgent.channels.push.deliver).toBe(true)
  })

  it("the last away day counts in the person's own zone", async () => {
    const tokyo = ctx({
      awayUntil: "2026-10-02",
      workHoursExplicit: true,
      workHours: {
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: [1, 2, 3, 4, 5],
        timezone: "Asia/Tokyo",
      },
    })
    const d = await run(directMessage, tokyo)
    // Monday 2026-10-05 09:00 in Tokyo is Monday 00:00 UTC.
    expect(d.channels.email.eligibleAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z")
  })
})

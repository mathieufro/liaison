// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner alert, and visitor spend failing closed without it.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Drop the SET NX once-mark: "crossing 80% mails exactly once" mails twice.
//  * Drop the alert email or mail check from demoVisitorSpendState: the state
//    reads "on" with nothing to alert through.
//  * Drop the down flag after 3 failures: the state stays "on".
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { isLeader, LeadershipTestAccess, startLeadership, stopLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { preCheck } from "~/modules/agent/credits/credit-meter"
import { OPENROUTER_WEB_SEARCH_MODEL } from "~/modules/agent/tools/web-search-openrouter"
import {
  checkDemoPriceDrift,
  DemoAlertsTestAccess,
  demoVisitorSpendState,
  notifyDemoSpendSettled,
  registerDemoAlertMailer,
  registerDemoPriceCheckSingleton,
} from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess, reserveStep, settleStep } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import {
  RESERVED_MODEL_DEFAULT,
  VISITOR_MODEL_UPSTREAM_DEFAULT,
} from "~/modules/demo/demo-spend-ceiling"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

type EnvKey = keyof typeof env
function setEnv<K extends EnvKey>(key: K, value: (typeof env)[K]): () => void {
  const target = env as Record<K, (typeof env)[K]>
  const saved = target[key]
  target[key] = value
  return () => {
    target[key] = saved
  }
}

describe("the demo owner alert", () => {
  const restores: Array<() => void> = []
  const mails: Array<{ to: string; subject: string; text: string }> = []
  let failSends = 0
  let reservedOrg: string

  beforeAll(async () => {
    await acquireTestLock()
    // The spend ledger and the demo Redis keys are shared by every demo test
    // in the database: start from none of another file's leftovers, since the
    // 80% mark is computed from the day's whole ledger.
    await sql`DELETE FROM kernel.demo_spend`
    await clearRedisPatterns(["demo:*"])
    reservedOrg = (await ensureOrg({ slug: "alerts-reserved", name: "Reserved" })).orgId
    await markOrgAsDemo(reservedOrg, reservedMarker())
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${RESERVED_MODEL_DEFAULT}, 'google', 'Gemini Flash-Lite', '0.09', '0.35',
              1048576, 'starter', true)
      ON CONFLICT DO NOTHING`
  })
  afterAll(async () => {
    DemoModeTestAccess.set(null)
    registerDemoAlertMailer(null)
    await releaseTestLock()
  })

  function mailOn(): void {
    DemoModeTestAccess.set(true)
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    restores.push(setEnv("LIAISON_DEMO_MAIL_CAPTURE", true))
    registerDemoAlertMailer(async (m) => {
      if (failSends > 0) {
        failSends -= 1
        throw new Error("provider 503")
      }
      mails.push(m)
    })
  }

  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.()
    registerDemoAlertMailer(null)
    DemoBudgetTestAccess.setNow(null)
    DemoAlertsTestAccess.setCatalogueFetch(null)
    DemoAlertsTestAccess.resetLogged()
    invalidateDemoMarker()
    failSends = 0
    mails.length = 0
    await sql`DELETE FROM kernel.demo_spend`
    await clearRedisPatterns(["demo:*"])
  })

  it("mails exactly once when box spend crosses 80% of the day, and not again that day", async () => {
    mailOn()
    restores.push(setEnv("LIAISON_DEMO_BOX_DAILY_EUR", 1))
    restores.push(setEnv("LIAISON_DEMO_BOX_HOURLY_EUR", 5))
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", 5))
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_NETWORK_EUR", 5))
    const who = { emailNormalized: "alerts@example.com", network: "192.0.2.0/24" }
    await settleStep(await reserveStep(who, VISITOR_MODEL_UPSTREAM_DEFAULT, 799_999, "o"), 799_999)
    expect(mails).toHaveLength(0)
    await settleStep(await reserveStep(who, VISITOR_MODEL_UPSTREAM_DEFAULT, 1, "o"), 1)
    expect(mails).toHaveLength(1)
    expect(mails[0]?.to).toBe("owner@example.com")
    await settleStep(await reserveStep(who, VISITOR_MODEL_UPSTREAM_DEFAULT, 10, "o"), 10)
    expect(mails).toHaveLength(1)
  })

  it("mails once when an hour reaches the hourly cap", async () => {
    mailOn()
    const caps = { box: 20_000_000, hour: 2_500_000 }
    await notifyDemoSpendSettled({
      day: "2026-10-23",
      boxDayMicroEur: 0,
      boxHourMicroEur: 2_500_000,
      caps,
    })
    await notifyDemoSpendSettled({
      day: "2026-10-23",
      boxDayMicroEur: 0,
      boxHourMicroEur: 2_600_000,
      caps,
    })
    expect(mails.map((m) => m.subject)).toEqual(["Demo spend reached the hourly cap"])
  })

  it("keeps visitor spend off without an alert address, and without a mail channel", async () => {
    DemoModeTestAccess.set(true)
    expect(await demoVisitorSpendState()).toBe("no_alert_email")
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    expect(await demoVisitorSpendState()).toBe("no_mail")
    restores.push(setEnv("LIAISON_DEMO_MAIL_CAPTURE", true))
    expect(await demoVisitorSpendState()).toBe("no_mail") // no sender registered
    registerDemoAlertMailer(async () => {})
    expect(await demoVisitorSpendState()).toBe("on")
  })

  it("says once, as a warning, that a box with no mail channel keeps visitor spend off", async () => {
    DemoModeTestAccess.set(true)
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    DemoAlertsTestAccess.resetLogged()
    const proto = Object.getPrototypeOf(rootLogger.child({ module: "spy" }))
    const warn = spyOn(proto, "warn")
    const error = spyOn(proto, "error")
    try {
      for (let i = 0; i < 4; i++) expect(await demoVisitorSpendState()).toBe("no_mail")
      const said = (calls: unknown[][]) =>
        calls.filter((c) => (c[0] as { alert?: string })?.alert === "demo_spend_disabled")
      expect(said(error.mock.calls)).toHaveLength(0)
      expect(said(warn.mock.calls)).toHaveLength(1)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it("switches visitor spend off after 3 failed sends, and back on once an alert lands", async () => {
    mailOn()
    // Three attempts fail at the threshold, three more on the first retry.
    failSends = 6
    await notifyDemoSpendSettled({
      day: "2026-10-23",
      boxDayMicroEur: 20_000_000,
      boxHourMicroEur: 0,
      caps: { box: 20_000_000, hour: 2_500_000 },
    })
    expect(mails).toHaveLength(0)
    expect(await demoVisitorSpendState()).toBe("alert_down")
    // The channel recovers; the next retry window delivers and spend resumes.
    await clearRedisPatterns(["demo:b:alert:retry"])
    expect(await demoVisitorSpendState()).toBe("on")
    expect(mails).toHaveLength(1)
  })

  /** A catalogue at today's prices: the pin, the web-search model, one ASR model. */
  function catalogue(over: Record<string, Record<string, string>> = {}) {
    const rows: Record<string, Record<string, string>> = {
      [VISITOR_MODEL_UPSTREAM_DEFAULT]: {
        prompt: "0.0000003",
        completion: "0.0000012",
        request: "0",
        web_search: "0",
      },
      [OPENROUTER_WEB_SEARCH_MODEL]: {
        prompt: "0.00000025",
        completion: "0.0000015",
        request: "0",
        web_search: "0.014",
      },
      "qwen/qwen3-asr-1.7b": { prompt: "0", completion: "0", request: "0" },
    }
    for (const [id, pricing] of Object.entries(over)) rows[id] = { ...rows[id], ...pricing }
    return { data: Object.entries(rows).map(([id, pricing]) => ({ id, pricing })) }
  }

  it("fails closed on a pinned price drift, and alerts", async () => {
    mailOn()
    DemoAlertsTestAccess.setCatalogueFetch(async () =>
      catalogue({ [VISITOR_MODEL_UPSTREAM_DEFAULT]: { prompt: "0.0000006" } }),
    )
    expect(await checkDemoPriceDrift(VISITOR_MODEL_UPSTREAM_DEFAULT)).toBe("drift")
    expect(await demoVisitorSpendState()).toBe("price_drift")
    expect(mails.map((m) => m.subject)).toEqual(["Demo pinned model price drift"])
    DemoAlertsTestAccess.setCatalogueFetch(async () => catalogue())
    expect(await checkDemoPriceDrift(VISITOR_MODEL_UPSTREAM_DEFAULT)).toBe("ok")
    expect(await demoVisitorSpendState()).toBe("on")
  })

  it("watches every model the box key reaches, and the fees max_price does not bound", async () => {
    mailOn()
    const drifted = async (over: Record<string, Record<string, string>>) => {
      DemoAlertsTestAccess.setCatalogueFetch(async () => catalogue(over))
      return checkDemoPriceDrift(VISITOR_MODEL_UPSTREAM_DEFAULT)
    }
    // The web-search model, dearer by tokens or by its per-search fee.
    expect(await drifted({ [OPENROUTER_WEB_SEARCH_MODEL]: { completion: "0.000003" } })).toBe(
      "drift",
    )
    expect(await drifted({ [OPENROUTER_WEB_SEARCH_MODEL]: { web_search: "0.05" } })).toBe("drift")
    // The pin starts charging per request or per search.
    expect(await drifted({ [VISITOR_MODEL_UPSTREAM_DEFAULT]: { request: "0.001" } })).toBe("drift")
    expect(await drifted({ [VISITOR_MODEL_UPSTREAM_DEFAULT]: { web_search: "0.01" } })).toBe(
      "drift",
    )
    // A transcription model with a per-request fee.
    expect(await drifted({ "qwen/qwen3-asr-1.7b": { request: "0.01" } })).toBe("drift")
    // The web-search model gone from the catalogue.
    DemoAlertsTestAccess.setCatalogueFetch(async () => ({
      data: catalogue().data.filter((r) => r.id !== OPENROUTER_WEB_SEARCH_MODEL),
    }))
    expect(await checkDemoPriceDrift(VISITOR_MODEL_UPSTREAM_DEFAULT)).toBe("drift")
    // Back to today's prices (a transcription row absent is not drift).
    DemoAlertsTestAccess.setCatalogueFetch(async () => ({
      data: catalogue().data.filter((r) => r.id !== "qwen/qwen3-asr-1.7b"),
    }))
    expect(await checkDemoPriceDrift(VISITOR_MODEL_UPSTREAM_DEFAULT)).toBe("ok")
    expect(await demoVisitorSpendState()).toBe("on")
  })

  it("the 6 h price check runs only in the leader", async () => {
    mailOn()
    let fetches = 0
    DemoAlertsTestAccess.setCatalogueFetch(async () => {
      fetches++
      return catalogue()
    })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const key = `demo-price-check-test:${crypto.randomUUID()}`
    try {
      // Registered while this process does not lead: no check, no interval.
      registerDemoPriceCheckSingleton(VISITOR_MODEL_UPSTREAM_DEFAULT, 50)
      await sleep(200)
      expect(fetches).toBe(0)

      // Taking the lease checks at once, then on every period.
      await startLeadership({
        role: "all",
        lease: { key, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
      })
      expect(isLeader()).toBe(true)
      const deadline = Date.now() + 3_000
      while (fetches < 3 && Date.now() < deadline) await sleep(25)
      expect(fetches).toBeGreaterThanOrEqual(3)

      // Losing it stops the interval.
      await stopLeadership()
      await sleep(100)
      const atLoss = fetches
      await sleep(300)
      expect(fetches).toBe(atLoss)
    } finally {
      await LeadershipTestAccess.reset()
      await redis.del(key)
    }
  })

  it("leaves the reserved org's turns alone in every one of those states", async () => {
    DemoModeTestAccess.set(true)
    // No alert address, no mail: the reserved org still runs on its pin.
    const turn = await preCheck(reservedOrg, null)
    expect(turn.allowed && turn.model.modelId).toBe(RESERVED_MODEL_DEFAULT)
  })
})

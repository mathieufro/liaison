// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tailored demo's door, end to end through the real middleware: needs,
// Turnstile first, the address rules, the client network, the code and the
// link, and the budget page's endpoints.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware } from "~/app"
import { sql } from "~/db"
import {
  capturedDemoMail,
  ResendEmailProvider,
  registerDemoAlertChannel,
  setDemoSystemMailProvider,
} from "~/infra/email"
import { sinkDetail, sinkLog } from "~/lib/effect-sink"
import { env, envSchema } from "~/lib/env"
import {
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  isLoadOrg,
  LoadHarnessTestAccess,
  signHarnessRequest,
} from "~/lib/load-harness"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createSession } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { registerDemoAlertMailer, sendDemoAlertOnce } from "~/modules/demo/demo-alerts"
import {
  enableDemoDoorForTest,
  lastCapturedCode,
  passingTurnstileToken,
  restoreDemoDoorEnv,
  siteverifyCalls,
} from "~/modules/demo/demo-door.test-fixtures"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  loadDemoMarker,
  markOrgAsDemo,
  reservedMarker,
} from "~/modules/demo/demo-org"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { TURNSTILE_TEST_SECRETS } from "~/modules/demo/demo-turnstile"
import {
  DemoVerificationTestAccess,
  demoBudgetEmailKey,
  demoVerifiedIdentity,
} from "~/modules/demo/demo-verification"
import { DemoWorldsTestAccess } from "~/modules/demo/demo-worlds"
import { mountDemoRoutes, useDemoRateLimit } from "~/modules/demo/routes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const demoApp = new Hono<AppEnv>()
demoApp.use("/api/*", apiBodyLimitMiddleware)
useDemoRateLimit(demoApp, redis)
demoApp.use("/api/*", apiRequestTimeoutMiddleware)
demoApp.onError(errorHandler)
mountDemoRoutes(demoApp)

let n = 0
/** A fresh client address, in a network of its own, per call. */
function nextIp(): string {
  n += 1
  return `${11 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}.9`
}
/** A unique address on a reserved domain. */
function addr(local: string, domain = "example.com"): string {
  n += 1
  return `${local}${n}@${domain}`
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return demoApp.request(`/api/demo${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": nextIp(), ...headers },
    body: JSON.stringify(body),
  })
}

interface Started {
  orgId: string
  userId: string
  accessToken: string
  needs: string[]
  verification: { sent: boolean; emailMasked: string }
}

async function start(
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { data?: Started; error?: { code?: string } } }> {
  const res = await post(
    "/orgs",
    {
      name: "Visitor",
      email: addr("visitor"),
      needs: ["support", "sales"],
      turnstileToken: passingTurnstileToken("demo_start"),
      ...over,
    },
    headers,
  )
  return { status: res.status, body: (await res.json()) as { data?: Started } }
}

async function startOk(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await start(over, headers)
  expect(r.status).toBe(201)
  return r.body.data as Started
}

function authed(token: string, ip = nextIp()) {
  return { Authorization: `Bearer ${token}`, "x-bun-socket-ip": ip }
}

const savedOrgCap = env.LIAISON_DEMO_MAX_VISITOR_ORGS

/** Every request the live seed was handed, with the org it seeded. */
const seedRequests: Array<{ orgId: string; req: Record<string, unknown> }> = []

/** The live seed's request for `orgId`, once the seed behind the response has run. */
async function seedRequestOf(orgId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const found = seedRequests.find((r) => r.orgId === orgId)
    if (found) return found.req
    await Bun.sleep(50)
  }
  throw new Error(`no seed ran for ${orgId}`)
}

beforeAll(async () => {
  await acquireTestLock()
  // The namespace database outlives a run; its visitor orgs must not trip the
  // live-workspace cap this file is not about.
  env.LIAISON_DEMO_MAX_VISITOR_ORGS = 100000
  DemoModeTestAccess.set(true)
  enableDemoDoorForTest()
  setDemoSeeder(async (req) => {
    const { orgId } = await ensureOrg({ slug: req.orgSlug, name: req.orgName, locale: req.locale })
    seedRequests.push({ orgId, req: JSON.parse(JSON.stringify(req)) })
    return { ok: true, orgId }
  })
})

afterAll(async () => {
  env.LIAISON_DEMO_MAX_VISITOR_ORGS = savedOrgCap
  DemoModeTestAccess.set(null)
  restoreDemoDoorEnv()
  DemoSeederTestAccess.reset()
  DemoVerificationTestAccess.reset()
  await releaseTestLock()
})

afterEach(async () => {
  await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
  invalidateDemoMarker()
  DemoVerificationTestAccess.reset()
  env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.pass
  // Verification caps count verified leads; keep each test's world its own.
  await sql`UPDATE kernel.demo_leads SET verified_at = NULL WHERE verified_at IS NOT NULL`
})

describe("A1 needs", () => {
  it("rejects empty, unknown and repeated needs with 400", async () => {
    for (const needs of [[], ["support", "crm"], ["chat", "chat"], undefined]) {
      expect((await start({ needs })).status).toBe(400)
    }
  })

  it("keeps the pick order on the lead and the marker", async () => {
    const s = await startOk({ needs: ["dev", "support", "chat"] })
    expect(s.needs).toEqual(["dev", "support", "chat"])
    const [lead] = await sql<{ needs: string[] }[]>`
      SELECT needs FROM kernel.demo_leads WHERE demo_org_id = ${s.orgId}::uuid`
    expect(lead.needs).toEqual(["dev", "support", "chat"])
    invalidateDemoMarker(s.orgId)
    const marker = (await loadDemoMarker(s.orgId)) as { needs?: string[] } | null
    expect(marker?.needs).toEqual(["dev", "support", "chat"])
  })
})

describe("the company question", () => {
  const entryOnMarker = async (orgId: string) => {
    invalidateDemoMarker(orgId)
    const marker = (await loadDemoMarker(orgId)) as { entry?: unknown } | null
    return marker?.entry
  }

  it("records the answer on the marker, the free text with it", async () => {
    const s = await startOk({ entry: { id: "other", text: "  A bakery\n<b>chain</b>  " } })
    expect(await entryOnMarker(s.orgId)).toEqual({ id: "other", text: "A bakery <b>chain</b>" })
  })

  it("records an entry without text, and drops text sent with one", async () => {
    const s = await startOk({ entry: { id: "software", text: "ignored" } })
    expect(await entryOnMarker(s.orgId)).toEqual({ id: "software" })
  })

  it("is skippable: no answer starts the demo and records nothing", async () => {
    const s = await startOk({})
    expect(s.needs).toEqual(["support", "sales"])
    expect(await entryOnMarker(s.orgId)).toBeUndefined()
  })

  it("refuses an unknown entry and over-long text with 400", async () => {
    for (const entry of [{ id: "crm" }, { id: "other", text: "x".repeat(121) }, "products"]) {
      expect((await start({ entry })).status).toBe(400)
    }
  })

  it("leaves the demo marker itself intact", async () => {
    const s = await startOk({ needs: ["dev"], entry: { id: "software" } })
    invalidateDemoMarker(s.orgId)
    const marker = await loadDemoMarker(s.orgId)
    expect(marker?.variant).toBe("visitor")
    expect(Date.parse(marker?.expiresAt ?? "")).toBeGreaterThan(Date.now())
    expect((marker as { needs?: string[] } | null)?.needs).toEqual(["dev"])
  })
})

describe("A3 Turnstile first", () => {
  async function counters(ip: string) {
    const keys = await redis.keys(`${REDIS_PREFIX}ratelimit*demo-signup*`)
    const ipKeys = keys.filter((k) => k.includes(ip))
    return {
      global: keys.filter((k) => k.endsWith("demo-signup-global")).length,
      ip: ipKeys.length,
    }
  }

  it("refuses a failing, duplicate, wrong-action, wrong-host or unreachable token with 400", async () => {
    const before = siteverifyCalls.length
    env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.fail
    expect((await start()).body.error?.code).toBe("turnstile_failed")
    env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.duplicate
    expect((await start()).body.error?.code).toBe("turnstile_failed")
    env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.pass
    expect((await start({ turnstileToken: passingTurnstileToken("demo_code") })).status).toBe(400)
    expect((await start({ turnstileToken: "XXXX:demo_start:wrong-host" })).status).toBe(400)
    expect((await start({ turnstileToken: "network-error" })).status).toBe(400)
    expect(siteverifyCalls.length).toBe(before + 5)
  })

  it("spends no signup budget and records no failed attempt for a bad token", async () => {
    const ip = "203.0.113.77"
    const email = addr("victim")
    env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.fail
    for (let i = 0; i < 5; i++) {
      expect((await start({ email }, { "x-bun-socket-ip": ip })).status).toBe(400)
    }
    const c = await counters(ip)
    expect(c.global).toBe(0)
    expect(c.ip).toBe(0)
    expect((await redis.keys(`*bruteforce*${email}*`)).length).toBe(0)
  })

  it("refuses Start with 503 when no secret is configured, in every environment", async () => {
    env.TURNSTILE_SECRET_KEY = undefined
    const r = await start()
    expect(r.status).toBe(503)
  })
})

describe("A4 address rules", () => {
  it("refuses a disposable inbox with 422, recording no failed attempt", async () => {
    const email = addr("throwaway", "mailinator.com")
    const r = await start({ email })
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe("disposable_email")
    expect((await redis.keys(`*bruteforce*${email}*`)).length).toBe(0)
  })

  async function verifyOne(email: string, ip = nextIp()): Promise<number> {
    const r = await start({ email }, { "x-bun-socket-ip": ip })
    if (r.status !== 201) return r.status
    const s = r.body.data as Started
    const code = lastCapturedCode(email)?.code ?? ""
    const res = await demoApp.request("/api/demo/verify", {
      method: "POST",
      headers: { ...authed(s.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
    return res.status
  }

  it("caps a registrable domain at 3 verified a day, across its subdomains", async () => {
    expect(await verifyOne(addr("a", "one.capped-co.example"))).toBe(200)
    expect(await verifyOne(addr("b", "two.capped-co.example"))).toBe(200)
    expect(await verifyOne(addr("c", "capped-co.example"))).toBe(200)
    // The fourth address on that registrable domain cannot even start.
    const fourth = await start({ email: addr("d", "three.capped-co.example") })
    expect(fourth.status).toBe(422)
    expect(fourth.body.error?.code).toBe("domain_cap")
  })

  it("caps an alias relay like a small domain, even under a major parent", async () => {
    for (let i = 0; i < 3; i++) expect(await verifyOne(addr("r", "duck.com"))).toBe(200)
    expect((await start({ email: addr("r", "duck.com") })).body.error?.code).toBe("domain_cap")
  })

  it("never caps a major provider by domain", async () => {
    for (let i = 0; i < 4; i++) expect(await verifyOne(addr("g", "gmail.com"))).toBe(200)
  })

  it("caps verifications per network at 2 an hour (the network of the Start)", async () => {
    const ip = (i: number) => `192.0.2.${10 + i}`
    expect(await verifyOne(addr("n", "gmail.com"), ip(1))).toBe(200)
    expect(await verifyOne(addr("n", "gmail.com"), ip(2))).toBe(200)
    expect(await verifyOne(addr("n", "gmail.com"), ip(3))).toBe(429)
  })

  it("caps the box at 12 verified addresses an hour", async () => {
    const saved = env.LIAISON_DEMO_VERIFIED_PER_HOUR
    try {
      for (let i = 0; i < 12; i++) expect(await verifyOne(addr("box", "gmail.com"))).toBe(200)
      expect(await verifyOne(addr("box", "gmail.com"))).toBe(429)
    } finally {
      env.LIAISON_DEMO_VERIFIED_PER_HOUR = saved
    }
  }, 30_000)
})

describe("A2 client network", () => {
  it("records the Start's network and never the verifying request's", async () => {
    const saved = env.LIAISON_DEMO_EDGE_OVERWRITES_XFF
    env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = true
    try {
      const email = addr("net", "gmail.com")
      const r = await start(
        { email },
        { "x-bun-socket-ip": "127.0.0.1", "x-forwarded-for": "198.51.100.200" },
      )
      expect(r.status).toBe(201)
      const s = r.body.data as Started
      const code = lastCapturedCode(email)?.code ?? ""
      const res = await demoApp.request("/api/demo/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.accessToken}`,
          "Content-Type": "application/json",
          "x-bun-socket-ip": "127.0.0.1",
          "x-forwarded-for": "2001:db8:99::1",
        },
        body: JSON.stringify({ code }),
      })
      expect(res.status).toBe(200)
      const [lead] = await sql<{ signup_network: string }[]>`
        SELECT signup_network FROM kernel.demo_leads WHERE demo_org_id = ${s.orgId}::uuid`
      expect(lead.signup_network).toBe("198.51.100.0/24")
      expect((await demoVerifiedIdentity(s.orgId))?.network).toBe("198.51.100.0/24")
    } finally {
      env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = saved
    }
  })

  it("refuses a comma X-Forwarded-For behind the declared edge with 400", async () => {
    const saved = env.LIAISON_DEMO_EDGE_OVERWRITES_XFF
    env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = true
    try {
      const r = await start(
        {},
        { "x-bun-socket-ip": "127.0.0.1", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      )
      expect(r.status).toBe(400)
    } finally {
      env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = saved
    }
  })
})

describe("A5 code and link", () => {
  function verifyCode(token: string, code: string, extra: Record<string, unknown> = {}) {
    return demoApp.request("/api/demo/verify", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify({ code, ...extra }),
    })
  }
  function verifyLink(token: string, turnstileToken?: string) {
    return post("/verify", { token, ...(turnstileToken ? { turnstileToken } : {}) })
  }

  it("mails the code at Start, with no visitor-supplied text", async () => {
    const email = addr("mailed")
    const s = await startOk({ email, name: "<b>Evil</b> Name" })
    expect(s.verification.sent).toBe(true)
    expect(s.verification.emailMasked).toMatch(/^m•••@example\.com$/)
    const mail = [...capturedDemoMail().sent].reverse().find((m) => m.to === email)
    expect(mail).toBeDefined()
    expect(`${mail?.html}${mail?.text}${mail?.subject}`).not.toContain("Evil")
    expect(lastCapturedCode(email)?.code).toMatch(/^\d{6}$/)
  })

  it("verifies by code; another org's code never verifies this org", async () => {
    const a = addr("a")
    const b = addr("b")
    const sa = await startOk({ email: a })
    const sb = await startOk({ email: b })
    const codeB = lastCapturedCode(b)?.code ?? ""
    const codeA = lastCapturedCode(a)?.code ?? ""
    if (codeA !== codeB) expect((await verifyCode(sa.accessToken, codeB)).status).toBe(400)
    expect(await demoVerifiedIdentity(sa.orgId)).toBeNull()
    expect((await verifyCode(sa.accessToken, codeA)).status).toBe(200)
    // The budgets charge a keyed hash of the address, never the address itself.
    expect((await demoVerifiedIdentity(sa.orgId))?.emailNormalized).toBe(demoBudgetEmailKey(a))
    expect(await demoVerifiedIdentity(sb.orgId)).toBeNull()
  })

  // A fresh workspace is seeded behind the start, and the seed's app
  // registrations raise the visitor's permission version. The start's token is
  // then stale: verify answers 401 (the designed answer to a stale token), and a
  // refreshed session verifies. The launch load test counted that 401 once per
  // fresh visitor; it was never a verify that failed after the refresh.
  it("a start's token made stale by the seed's grants answers 401; a fresh session verifies", async () => {
    const email = addr("stale")
    const s = await startOk({ email })
    await sql`UPDATE kernel.users SET permission_version = permission_version + 1 WHERE id = ${s.userId}`
    invalidateAuthCache(s.userId)
    const code = lastCapturedCode(email)?.code ?? ""
    expect((await verifyCode(s.accessToken, code)).status).toBe(401)
    const fresh = await createSession(s.userId, s.orgId)
    expect((await verifyCode(fresh.accessToken, code)).status).toBe(200)
    expect((await demoVerifiedIdentity(s.orgId))?.emailNormalized).toBe(demoBudgetEmailKey(email))
  })

  // The org's tools are registered when its workspace is built, BEFORE its
  // visitor confirms the address, so `web_search` (box key, verified visitors
  // only) is absent then. Verifying must advertise it without a restart, or the
  // agent tells the visitor search is not available in this workspace.
  it("advertises web_search on the box key once the visitor verifies", async () => {
    const savedAlertEmail = env.LIAISON_DEMO_ALERT_EMAIL
    const savedOpenRouter = process.env.OPENROUTER_API_KEY
    const savedExa = process.env.EXA_API_KEY
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    process.env.OPENROUTER_API_KEY = "sk-or-box-key-for-test"
    delete process.env.EXA_API_KEY
    try {
      registerDemoAlertChannel()
      const email = addr("search")
      const s = await startOk({ email })
      await registerKernelAgentTools(s.orgId)
      expect(toolRegistry.get([s.orgId, "kernel", "web_search"])).toBeUndefined()
      const res = await verifyCode(s.accessToken, lastCapturedCode(email)?.code ?? "")
      expect(res.status).toBe(200)
      expect(toolRegistry.get([s.orgId, "kernel", "web_search"])).toBeDefined()
    } finally {
      registerDemoAlertMailer(null)
      env.LIAISON_DEMO_ALERT_EMAIL = savedAlertEmail
      if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = savedOpenRouter
      if (savedExa === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = savedExa
    }
  })

  it("counts wrong guesses down and refuses the sixth with 429", async () => {
    const email = addr("guess")
    const s = await startOk({ email })
    const right = lastCapturedCode(email)?.code ?? ""
    const wrong = right === "000000" ? "111111" : "000000"
    for (let left = 4; left >= 0; left--) {
      const res = await verifyCode(s.accessToken, wrong)
      expect(res.status).toBe(400)
      const body = (await res.json()) as {
        error: { code: string; details?: { attemptsLeft: number } }
      }
      expect(body.error.code).toBe("code_invalid")
      expect(body.error.details?.attemptsLeft).toBe(left)
    }
    expect((await verifyCode(s.accessToken, right)).status).toBe(429)
  })

  it("checks at most 5 of 50 parallel wrong guesses", async () => {
    const email = addr("parallel")
    const s = await startOk({ email })
    const right = lastCapturedCode(email)?.code ?? ""
    const wrong = right === "000000" ? "111111" : "000000"
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const res = await verifyCode(s.accessToken, wrong)
        return ((await res.json()) as { error: { code: string } }).error.code
      }),
    )
    const tally = results.reduce<Record<string, number>>((acc, c) => {
      acc[c] = (acc[c] ?? 0) + 1
      return acc
    }, {})
    expect(tally).toEqual({ code_invalid: 5, code_attempts_exhausted: 45 })
    // The right code is refused too once the allowance is spent.
    expect((await verifyCode(s.accessToken, right)).status).toBe(429)
    expect(await demoVerifiedIdentity(s.orgId)).toBeNull()
  })

  it("accepts the code at 9:59 and expires it at 10:01", async () => {
    const t0 = Date.now()
    DemoVerificationTestAccess.setNow(() => t0)
    const e1 = addr("ttl")
    const s1 = await startOk({ email: e1 })
    DemoVerificationTestAccess.setNow(() => t0 + 9 * 60_000 + 59_000)
    expect((await verifyCode(s1.accessToken, lastCapturedCode(e1)?.code ?? "")).status).toBe(200)

    DemoVerificationTestAccess.setNow(() => t0)
    const e2 = addr("ttl")
    const s2 = await startOk({ email: e2 })
    DemoVerificationTestAccess.setNow(() => t0 + 10 * 60_000 + 1_000)
    const late = await verifyCode(s2.accessToken, lastCapturedCode(e2)?.code ?? "")
    expect(late.status).toBe(410)
  })

  it("refuses the code form without a session, and any org id in the body", async () => {
    const email = addr("nosession")
    const s = await startOk({ email })
    const code = lastCapturedCode(email)?.code ?? ""
    expect((await post("/verify", { code })).status).toBe(401)
    expect((await verifyCode(s.accessToken, code, { orgId: s.orgId })).status).toBe(400)
    expect(await demoVerifiedIdentity(s.orgId)).toBeNull()
  })

  it("verifies by link only with a Turnstile token, and only once", async () => {
    const email = addr("link")
    const s = await startOk({ email })
    const token = lastCapturedCode(email)?.token ?? ""
    expect((await verifyLink(token)).status).toBe(400)
    expect(await demoVerifiedIdentity(s.orgId)).toBeNull()
    expect((await verifyLink(token, passingTurnstileToken("demo_verify"))).status).toBe(200)
    expect(await demoVerifiedIdentity(s.orgId)).not.toBeNull()
    expect((await verifyLink(token, passingTurnstileToken("demo_verify"))).status).toBe(410)
  })

  it("verifies nothing on a GET of the link, whatever it carries", async () => {
    const email = addr("scanner")
    const s = await startOk({ email })
    const token = lastCapturedCode(email)?.token ?? ""
    for (const path of [`/api/demo/verify?t=${encodeURIComponent(token)}`, "/api/demo/verify"]) {
      const res = await demoApp.request(path, { headers: { "x-bun-socket-ip": nextIp() } })
      expect(res.status).toBe(404)
    }
    expect(await demoVerifiedIdentity(s.orgId)).toBeNull()
    // The link still works for the real press afterwards: a GET consumed nothing.
    expect((await verifyLink(token, passingTurnstileToken("demo_verify"))).status).toBe(200)
  })

  it("consumes the link on first use even when the Turnstile check passes later", async () => {
    const email = addr("link2")
    const s = await startOk({ email })
    const token = lastCapturedCode(email)?.token ?? ""
    // A forged MAC names no org and verifies nothing.
    const forged = `${token.split(".").slice(0, 2).join(".")}.AAAA`
    expect((await verifyLink(forged, passingTurnstileToken("demo_verify"))).status).toBe(410)
    expect(await demoVerifiedIdentity(s.orgId)).toBeNull()
  })

  it("re-sends with a fresh Turnstile token, 3 sends per org at most", async () => {
    const email = addr("resend")
    const s = await startOk({ email })
    const resend = () =>
      demoApp.request("/api/demo/verify/send", {
        method: "POST",
        headers: { ...authed(s.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: passingTurnstileToken("demo_code") }),
      })
    // The Start send was the first of three.
    expect((await resend()).status).toBe(200)
    expect((await resend()).status).toBe(200)
    const fourth = await resend()
    expect(fourth.status).toBe(429)
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe(
      "code_send_limited",
    )
  })

  it("limits code sends to 3 per IP per hour", async () => {
    const ip = "203.0.113.5"
    for (let i = 0; i < 3; i++) {
      const s = await startOk({}, { "x-bun-socket-ip": `203.0.113.${50 + i}` })
      const res = await demoApp.request("/api/demo/verify/send", {
        method: "POST",
        headers: { ...authed(s.accessToken, ip), "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: passingTurnstileToken("demo_code") }),
      })
      expect(res.status).toBe(200)
    }
    const s = await startOk()
    const res = await demoApp.request("/api/demo/verify/send", {
      method: "POST",
      headers: { ...authed(s.accessToken, ip), "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: passingTurnstileToken("demo_code") }),
    })
    expect(res.status).toBe(429)
  })

  it("answers 503 demo_mail_unavailable with no mail channel, the org still created", async () => {
    env.LIAISON_DEMO_MAIL_CAPTURE = false
    try {
      const s = await startOk()
      expect(s.verification.sent).toBe(false)
      const res = await demoApp.request("/api/demo/verify/send", {
        method: "POST",
        headers: { ...authed(s.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: passingTurnstileToken("demo_code") }),
      })
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "demo_mail_unavailable",
      )
      // The budget read says no code is waiting, so the page never claims one was sent.
      const budget = await demoApp.request("/api/demo/budget", { headers: authed(s.accessToken) })
      expect(((await budget.json()) as { data: { codeSent: boolean } }).data.codeSent).toBe(false)
    } finally {
      env.LIAISON_DEMO_MAIL_CAPTURE = true
    }
  })
})

describe("the door's mail channel and the spend engine's owner alert", () => {
  it("counts a code send the provider refuses toward the owner's failure alert", async () => {
    const s = await startOk()
    setDemoSystemMailProvider({
      send: async () => {
        throw new Error("provider refused")
      },
      verify: async () => true,
    })
    try {
      const res = await demoApp.request("/api/demo/verify/send", {
        method: "POST",
        headers: { ...authed(s.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ turnstileToken: passingTurnstileToken("demo_code") }),
      })
      expect(res.status).toBe(503)
      const hour = Math.floor(Date.now() / 3_600_000)
      expect(Number(await redis.get(`demo:b:alert:code-fail:${hour}`))).toBe(1)
    } finally {
      setDemoSystemMailProvider(undefined)
    }
  })

  it("a Start whose code mail the provider refuses says not sent, and no code is on record", async () => {
    // Walk D: the provider refused the mail (an unverified sending domain),
    // the Start said sent:false, yet the budget read said a code was waiting,
    // so the band claimed "We sent a 6-digit code".
    setDemoSystemMailProvider({
      send: async () => {
        throw new Error("provider refused")
      },
      verify: async () => true,
    })
    try {
      const s = await startOk()
      expect(s.verification.sent).toBe(false)
      const budget = await demoApp.request("/api/demo/budget", { headers: authed(s.accessToken) })
      expect(((await budget.json()) as { data: { codeSent: boolean } }).data.codeSent).toBe(false)
      expect(await redis.exists(`demo:code:${s.orgId}`)).toBe(0)
    } finally {
      setDemoSystemMailProvider(undefined)
    }
  })

  // Live walk 2026-10-24: the box logged "Email sent (resend)" with the code mail's subject,
  // "NNNNNN is your Liaison demo code", at info on every send: whoever reads the logs held
  // live codes. A code send logs the template and the recipient's domain, nothing else.
  it("no log line of a code send carries the code, the link or the address", async () => {
    const sent: Array<{ subject: string; text?: string }> = []
    setDemoSystemMailProvider(
      new ResendEmailProvider({
        apiKey: "re_test_demo_door",
        from: "Liaison demo <noreply@example.com>",
        fetch: async (_url, init) => {
          sent.push(JSON.parse(String(init.body)))
          return new Response(JSON.stringify({ id: "m1" }), { status: 200 })
        },
      }),
    )
    const { rootLogger } = await import("~/lib/logger")
    const proto = Object.getPrototypeOf(rootLogger.child({ service: "email" }))
    const lines: string[] = []
    const spies = (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => {
      const spy = spyOn(proto, level)
      spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
        lines.push(JSON.stringify(args))
      })
      return spy
    })
    const email = addr("logged")
    try {
      const s = await startOk({ email })
      expect(s.verification.sent).toBe(true)
    } finally {
      for (const spy of spies) spy.mockRestore()
      setDemoSystemMailProvider(undefined)
    }
    const mail = sent.at(-1)
    const code = mail?.subject.match(/\d{6}/)?.[0] ?? ""
    const link = mail?.text?.match(/https?:\/\/\S+/)?.[0] ?? ""
    expect(code).toMatch(/^\d{6}$/)
    expect(link).not.toBe("")
    const sendLines = lines.filter((l) => l.includes("Email sent (resend)"))
    expect(sendLines.length).toBe(1)
    expect(sendLines[0]).toContain('"template":"demo.verification-code"')
    expect(sendLines[0]).toContain('"toDomain":"example.com"')
    for (const line of lines) {
      expect(line).not.toContain(code)
      expect(line).not.toContain(link)
      expect(line).not.toContain(email)
    }
  })

  it("sends the owner alert through the demo mail channel once it is registered", async () => {
    const savedAlertEmail = env.LIAISON_DEMO_ALERT_EMAIL
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    try {
      registerDemoAlertChannel()
      await sendDemoAlertOnce("integration_wiring", { subject: "Wiring alert", text: "EUR 1 < 2" })
      const sent = capturedDemoMail().sent.filter((m) => m.subject === "Wiring alert")
      expect(sent.map((m) => m.to)).toEqual(["owner@example.com"])
      expect(sent[0]?.html).toBe("<p>EUR 1 &lt; 2</p>")
    } finally {
      registerDemoAlertMailer(null)
      env.LIAISON_DEMO_ALERT_EMAIL = savedAlertEmail
    }
  })

  it("registers no alert sender on a box with no demo mail channel", async () => {
    env.LIAISON_DEMO_MAIL_CAPTURE = false
    const savedKeys = [env.LIAISON_DEMO_MAIL_RESEND_API_KEY, env.SYSTEM_RESEND_API_KEY] as const
    env.LIAISON_DEMO_MAIL_RESEND_API_KEY = undefined
    env.SYSTEM_RESEND_API_KEY = ""
    const savedAlertEmail = env.LIAISON_DEMO_ALERT_EMAIL
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    try {
      registerDemoAlertChannel()
      const before = capturedDemoMail().sent.length
      await sendDemoAlertOnce("integration_no_channel", { subject: "Nobody", text: "x" })
      expect(capturedDemoMail().sent.length).toBe(before)
    } finally {
      registerDemoAlertMailer(null)
      env.LIAISON_DEMO_MAIL_CAPTURE = true
      env.LIAISON_DEMO_MAIL_RESEND_API_KEY = savedKeys[0]
      env.SYSTEM_RESEND_API_KEY = savedKeys[1]
      env.LIAISON_DEMO_ALERT_EMAIL = savedAlertEmail
    }
  })
})

describe("the visitor's scenarios", () => {
  it("needs a session: 401 without one, the picked scenarios with one", async () => {
    const s = await startOk({ needs: ["sales", "support"] })
    expect((await demoApp.request("/api/demo/scenarios")).status).toBe(401)
    expect(
      (await demoApp.request("/api/demo/scenarios/kernel.scenario-sales/retry", { method: "POST" }))
        .status,
    ).toBe(401)
    const res = await demoApp.request("/api/demo/scenarios", { headers: authed(s.accessToken) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ need: string; tourId: string; status: string; beatCount: number }>
    }
    expect(body.data.map((i) => i.need)).toEqual(["sales", "support"])
    expect(body.data.map((i) => i.tourId)).toEqual([
      "kernel.scenario-sales",
      "kernel.scenario-support",
    ])
    expect(body.data.every((i) => i.status === "new" && i.beatCount > 0)).toBe(true)
  })

  it("lists the scenarios of the workspace's own world, never another world's", async () => {
    const s = await startOk({ needs: ["sales", "support"] })
    const marker = await loadDemoMarker(s.orgId)
    expect(marker).not.toBeNull()
    if (!marker) return
    await markOrgAsDemo(s.orgId, { ...marker, worldId: "saas" })
    invalidateDemoMarker(s.orgId)
    const res = await demoApp.request("/api/demo/scenarios", { headers: authed(s.accessToken) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ tourId: string }> }
    expect(body.data.map((i) => i.tourId)).not.toContain("kernel.scenario-sales")
    expect(body.data.map((i) => i.tourId)).not.toContain("kernel.scenario-support")
  })

  it("answers 404 for a regular org and for the reserved review org", async () => {
    const regular = await minimal.session((await createTestOrg()).id)
    const h = authed(regular.bearer)
    expect((await demoApp.request("/api/demo/scenarios", { headers: h })).status).toBe(404)
    const reviewer = await minimal.session((await createTestOrg()).id)
    await markOrgAsDemo(reviewer.orgId, reservedMarker())
    invalidateDemoMarker()
    const r = authed(reviewer.bearer)
    expect((await demoApp.request("/api/demo/scenarios", { headers: r })).status).toBe(404)
    expect(
      (
        await demoApp.request("/api/demo/scenarios/kernel.scenario-sales/retry", {
          method: "POST",
          headers: r,
        })
      ).status,
    ).toBe(404)
  })
})

describe("the welcome popup's answer", () => {
  function welcome(token: string, choice?: unknown) {
    return demoApp.request("/api/demo/scenarios/welcome", {
      method: choice === undefined ? "GET" : "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      ...(choice === undefined ? {} : { body: JSON.stringify({ choice }) }),
    })
  }

  it("is none at first, then the recorded choice, read back from the database", async () => {
    const s = await startOk({ needs: ["support"] })
    expect((await demoApp.request("/api/demo/scenarios/welcome")).status).toBe(401)
    const first = await welcome(s.accessToken)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { data: unknown }).data).toEqual({ choice: null })
    expect((await welcome(s.accessToken, "browse")).status).toBe(200)
    // Not the process cache: what a reload on any process reads.
    invalidateDemoMarker()
    const after = await welcome(s.accessToken)
    expect(((await after.json()) as { data: unknown }).data).toEqual({ choice: "browse" })
    // The rest of the marker is untouched (the expiry still binds).
    const marker = await loadDemoMarker(s.orgId)
    expect(marker?.variant).toBe("visitor")
    expect(typeof marker?.expiresAt).toBe("string")
    expect(marker?.needs).toEqual(["support"])
  })

  it("refuses a choice it does not know, and answers 404 outside a visitor org", async () => {
    const s = await startOk({ needs: ["support"] })
    expect((await welcome(s.accessToken, "later")).status).toBe(400)
    const regular = await minimal.session((await createTestOrg()).id)
    expect((await welcome(regular.bearer)).status).toBe(404)
    expect((await welcome(regular.bearer, "browse")).status).toBe(404)
  })
})

describe("A7 budget and notify-managed", () => {
  it("reports the budget and refuses notify-managed until verified, then is idempotent", async () => {
    const email = addr("notify")
    const s = await startOk({ email })
    const budget = await demoApp.request("/api/demo/budget", { headers: authed(s.accessToken) })
    expect(budget.status).toBe(200)
    const b = (await budget.json()) as {
      data: { verified: boolean; budget: { capMicroEur: number }; byok: string[] }
    }
    expect(b.data.verified).toBe(false)
    // The Start mailed a code, and the read says so (a reload keeps the truth).
    expect((b.data as { codeSent?: boolean }).codeSent).toBe(true)
    expect(b.data.budget.capMicroEur).toBe(Math.round(env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR * 1e6))
    expect(b.data.byok).toEqual([])

    const notify = () => post("/notify-managed", {}, authed(s.accessToken))
    const refused = await notify()
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not_verified")

    const code = lastCapturedCode(email)?.code ?? ""
    await demoApp.request("/api/demo/verify", {
      method: "POST",
      headers: { ...authed(s.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
    expect((await notify()).status).toBe(200)
    const [first] = await sql<{ notify_managed_at: string }[]>`
      SELECT notify_managed_at FROM kernel.demo_leads WHERE demo_org_id = ${s.orgId}::uuid`
    expect((await notify()).status).toBe(200)
    const [second] = await sql<{ notify_managed_at: string }[]>`
      SELECT notify_managed_at FROM kernel.demo_leads WHERE demo_org_id = ${s.orgId}::uuid`
    expect(first.notify_managed_at).toBeTruthy()
    expect(String(second.notify_managed_at)).toBe(String(first.notify_managed_at))
  })

  it("404s every visitor endpoint for a regular (non-demo) org", async () => {
    const regular = await minimal.session((await createTestOrg()).id)
    const h = authed(regular.bearer)
    expect((await demoApp.request("/api/demo/budget", { headers: h })).status).toBe(404)
    expect((await post("/notify-managed", {}, h)).status).toBe(404)
    expect(
      (await post("/verify/send", { turnstileToken: passingTurnstileToken("demo_code") }, h))
        .status,
    ).toBe(404)
    expect((await post("/verify", { code: "123456" }, h)).status).toBe(404)
    expect(await demoVerifiedIdentity(regular.orgId)).toBeNull()
  })
})

describe("the next steps dialog: recap and once-only opening", () => {
  it("counts the visitor's agent actions and decisions since the workspace started", async () => {
    const s = await startOk({ needs: ["support"] })
    const h = authed(s.accessToken)
    const marker = await loadDemoMarker(s.orgId)
    const startedAt = marker?.createdAt ?? ""
    const empty = await demoApp.request("/api/demo/recap", { headers: h })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { data: unknown }).data).toEqual({
      startedAt,
      agentActions: 0,
      approvalsDecided: 0,
    })

    const agentId = crypto.randomUUID()
    const tag = agentId.slice(0, 8)
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${agentId}, ${s.orgId}, 'personal', ${`@recap-${tag}`}, 'Recap', ${s.userId})`
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${s.orgId}, ${`recap-${tag}`}, 'thread', ${s.userId}) RETURNING id`
    const insert = (meta: unknown, at: string) => sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, created_at, required_scopes)
      VALUES (${thread!.id}, ${s.orgId}, ${s.userId}, 'agent', ${agentId}, 'x', ${JSON.stringify(meta)}::jsonb, ${at}::timestamptz, '{}')`
    const now = new Date().toISOString()
    await insert({ toolCalls: [{ toolName: "a" }, { toolName: "b" }] }, now)
    await insert({ toolCalls: [{ toolName: "c" }] }, now)
    await insert({ other: true }, now)
    // Before the workspace was the visitor's (a pooled seed): not theirs.
    await insert({ toolCalls: [{ toolName: "seed" }] }, "2000-01-01T00:00:00Z")
    const approval = (decidedBy: string | null, decidedAt: string | null) => sql`
      INSERT INTO kernel.approval_requests (
        org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
        current_payload, expires_at, requested_by, status, reason, summary, decided_by, decided_at
      ) VALUES (
        ${s.orgId}, ${`recap-${crypto.randomUUID().slice(0, 8)}`}, ${thread!.id}, ${thread!.id},
        'test:echo', '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour', ${s.userId},
        ${decidedBy ? "approved" : "pending"}, 'gated', '{"kind":"decide","title":"t","lines":[]}'::jsonb,
        ${decidedBy}, ${decidedAt}::timestamptz
      )`
    await approval(s.userId, now)
    await approval(null, null)
    await approval(s.userId, "2000-01-01T00:00:00Z")

    const read = await demoApp.request("/api/demo/recap", { headers: h })
    expect(((await read.json()) as { data: unknown }).data).toEqual({
      startedAt,
      agentActions: 3,
      approvalsDecided: 1,
    })
  })

  it("remembers on the marker that the dialog opened by itself, and hands back the address", async () => {
    const email = addr("nextsteps")
    const s = await startOk({ email })
    const h = authed(s.accessToken)
    const read = async () =>
      (
        (await (await demoApp.request("/api/demo/budget", { headers: h })).json()) as {
          data: { nextStepsShown: boolean; email: string | null }
        }
      ).data
    expect(await read()).toMatchObject({ nextStepsShown: false, email })
    expect((await post("/next-steps/shown", {}, h)).status).toBe(200)
    // What a reload on any process reads, not this process's cache.
    invalidateDemoMarker()
    expect((await read()).nextStepsShown).toBe(true)
    expect((await loadDemoMarker(s.orgId))?.expiresAt).toBeTruthy()
  })

  it("404s both routes outside a visitor org", async () => {
    const regular = await minimal.session((await createTestOrg()).id)
    const h = authed(regular.bearer)
    expect((await demoApp.request("/api/demo/recap", { headers: h })).status).toBe(404)
    expect((await post("/next-steps/shown", {}, h)).status).toBe(404)
  })
})

describe("A9 the load harness's signed start", () => {
  const KEY = "k".repeat(48)

  /** A start whose exact bytes are signed with `key` (as the harness client does). */
  async function signedStart(
    body: Record<string, unknown>,
    opts: { key?: string; nonce?: string; tamper?: boolean; ip?: string } = {},
  ) {
    const raw = JSON.stringify({ name: "Load", needs: ["support"], turnstileToken: "-", ...body })
    const timestamp = Date.now()
    const nonce = opts.nonce ?? `n${crypto.randomUUID().replaceAll("-", "")}`
    const signature = signHarnessRequest(
      { method: "POST", path: "/api/demo/orgs", timestamp, nonce, body: raw },
      opts.key ?? KEY,
    )
    const res = await demoApp.request("/api/demo/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bun-socket-ip": opts.ip ?? nextIp(),
        [HARNESS_HEADER_TIMESTAMP]: String(timestamp),
        [HARNESS_HEADER_NONCE]: nonce,
        [HARNESS_HEADER_SIGNATURE]: signature,
      },
      body: opts.tamper ? raw.replace('"Load"', '"Lode"') : raw,
    })
    return {
      status: res.status,
      body: (await res.json()) as { data?: Started; error?: { code?: string } },
    }
  }

  afterEach(() => LoadHarnessTestAccess.setKey(undefined))

  it("a box without the key answers a harness header 404, as if the route were not there, and creates nothing", async () => {
    LoadHarnessTestAccess.setKey(null)
    const email = addr("load", "load.invalid")
    const r = await signedStart({ email })
    expect(r.status).toBe(404)
    expect((await sql`SELECT 1 FROM kernel.demo_leads WHERE email = ${email}`).length).toBe(0)
  })

  it("a signed start skips Turnstile, makes a load org, and its code goes to the sink, never to a mailbox", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.fail
    const calls = siteverifyCalls.length
    const since = Date.now()
    const email = addr("load", "load.invalid")
    const r = await signedStart({ email })
    expect(r.status).toBe(201)
    expect(siteverifyCalls.length).toBe(calls)
    const orgId = r.body.data!.orgId
    expect(await isLoadOrg(orgId)).toBe(true)
    expect((await loadDemoMarker(orgId))?.synthetic).toBe(true)
    expect(r.body.data!.verification.sent).toBe(true)
    expect(capturedDemoMail().sent.some((m) => m.to === email)).toBe(false)
    const entry = (await sinkLog(since)).find((e) => e.orgId === orgId && e.kind === "demo-code")
    expect(entry).toBeDefined()
    expect(await sinkDetail(orgId, "demo-code", entry!.key)).toMatch(/^\d{6}$/)
  })

  it("a replayed, tampered or wrongly keyed signature is refused as a 404, like an absent key (never a 403)", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const nonce = `n${crypto.randomUUID().replaceAll("-", "")}`
    expect((await signedStart({ email: addr("load", "load.invalid") }, { nonce })).status).toBe(201)
    expect((await signedStart({ email: addr("load", "load.invalid") }, { nonce })).status).toBe(404)
    expect(
      (await signedStart({ email: addr("load", "load.invalid") }, { tamper: true })).status,
    ).toBe(404)
    expect(
      (await signedStart({ email: addr("load", "load.invalid") }, { key: "w".repeat(48) })).status,
    ).toBe(404)
    LoadHarnessTestAccess.setKey(null)
    expect((await signedStart({ email: addr("load", "load.invalid") })).status).toBe(404)
  })

  it("the harness address and the signature go together: unsigned .invalid and a signed real address are both refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const unsigned = await start({ email: addr("load", "load.invalid") })
    expect(unsigned.status).toBe(422)
    const signedReal = await signedStart({ email: addr("person") })
    expect(signedReal.status).toBe(422)
  })

  // The launch-day load run must not starve real visitors: signed starts have
  // their own lane (LIAISON_DEMO_SYNTHETIC_*), and unsigned starts keep every
  // visitor limit, which no signed start spends.
  describe("the load lane has its own budget, apart from visitors'", () => {
    const saved = {
      signups: env.LIAISON_DEMO_SIGNUPS_PER_HOUR,
      maxOrgs: env.LIAISON_DEMO_MAX_VISITOR_ORGS,
      verified: env.LIAISON_DEMO_VERIFIED_PER_HOUR,
      codes: env.LIAISON_DEMO_CODE_SENDS_PER_HOUR,
      synthPerHour: env.LIAISON_DEMO_SYNTHETIC_PER_HOUR,
      synthMaxOrgs: env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS,
    }
    afterEach(() => {
      env.LIAISON_DEMO_SIGNUPS_PER_HOUR = saved.signups
      env.LIAISON_DEMO_MAX_VISITOR_ORGS = saved.maxOrgs
      env.LIAISON_DEMO_VERIFIED_PER_HOUR = saved.verified
      env.LIAISON_DEMO_CODE_SENDS_PER_HOUR = saved.codes
      env.LIAISON_DEMO_SYNTHETIC_PER_HOUR = saved.synthPerHour
      env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS = saved.synthMaxOrgs
    })

    /** Verify a signed start's workspace with the code the sink holds. */
    async function verifySynthetic(started: Started, since: number): Promise<number> {
      const entry = (await sinkLog(since)).find(
        (e) => e.orgId === started.orgId && e.kind === "demo-code",
      )
      const code = entry ? await sinkDetail(started.orgId, "demo-code", entry.key) : null
      const res = await demoApp.request("/api/demo/verify", {
        method: "POST",
        headers: { ...authed(started.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ code: code ?? "" }),
      })
      return res.status
    }

    it("signed starts spend their own hourly signups, never the visitors': a full load lane leaves the visitor door open, and the visitor ceiling still holds", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      env.LIAISON_DEMO_SIGNUPS_PER_HOUR = 1
      env.LIAISON_DEMO_SYNTHETIC_PER_HOUR = 3
      for (let i = 0; i < 3; i++) {
        expect((await signedStart({ email: addr("load", "load.invalid") })).status).toBe(201)
      }
      expect((await signedStart({ email: addr("load", "load.invalid") })).status).toBe(429)
      expect((await start()).status).toBe(201)
      expect((await start()).status).toBe(429)
    })

    it("synthetic workspaces have their own cap and never count against the visitors'", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const { countVisitorOrgs } = await import("~/modules/demo/demo-expiry")
      const before = await countVisitorOrgs()
      env.LIAISON_DEMO_MAX_VISITOR_ORGS = before.total + 1
      env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS = before.synthetic + 1
      expect((await signedStart({ email: addr("load", "load.invalid") })).status).toBe(201)
      expect((await signedStart({ email: addr("load", "load.invalid") })).status).toBe(503)
      expect((await start()).status).toBe(201)
      expect((await start()).status).toBe(503)
    })

    it("synthetic code sends and verifications are counted apart: the visitor ceilings still hold for visitors alone", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      env.LIAISON_DEMO_CODE_SENDS_PER_HOUR = 1
      env.LIAISON_DEMO_VERIFIED_PER_HOUR = 1
      env.LIAISON_DEMO_SYNTHETIC_PER_HOUR = 2
      const since = Date.now()
      // Two synthetic visitors from one network: the per-network caps are a
      // visitor's, the lane's own hourly count is the load run's.
      const ip = "198.18.0.7"
      const a = await signedStart({ email: addr("load", "load.invalid") }, { ip })
      const b = await signedStart({ email: addr("load", "load.invalid") }, { ip })
      expect(a.body.data!.verification.sent).toBe(true)
      expect(b.body.data!.verification.sent).toBe(true)
      expect(await verifySynthetic(a.body.data!, since)).toBe(200)
      expect(await verifySynthetic(b.body.data!, since)).toBe(200)
      // A visitor still gets the box's one code and one verification this hour.
      const email = addr("person", "gmail.com")
      const v = await startOk({ email })
      expect(v.verification.sent).toBe(true)
      const res = await demoApp.request("/api/demo/verify", {
        method: "POST",
        headers: { ...authed(v.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ code: lastCapturedCode(email)?.code ?? "" }),
      })
      expect(res.status).toBe(200)
      // And the visitor ceiling holds for the next visitor.
      expect((await startOk()).verification.sent).toBe(false)
    })
  })

  // L2: the harness reads a load org's sunk code back over a signed route.
  describe("the signed sink read", () => {
    /** A signed GET of `path` (the exact empty body is signed). */
    async function signedGet(
      path: string,
      opts: { key?: string; unsigned?: boolean; ip?: string } = {},
    ) {
      const timestamp = Date.now()
      const nonce = `n${crypto.randomUUID().replaceAll("-", "")}`
      const headers: Record<string, string> = { "x-bun-socket-ip": opts.ip ?? nextIp() }
      if (!opts.unsigned) {
        headers[HARNESS_HEADER_TIMESTAMP] = String(timestamp)
        headers[HARNESS_HEADER_NONCE] = nonce
        headers[HARNESS_HEADER_SIGNATURE] = signHarnessRequest(
          { method: "GET", path, timestamp, nonce, body: "" },
          opts.key ?? KEY,
        )
      }
      const res = await demoApp.request(path, { method: "GET", headers })
      return {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as {
          data?: {
            orgId: string
            demoCode: string | null
            effects: Array<{ kind: string; key: string; count: number }>
          }
          error?: { code?: string }
        },
      }
    }
    const sinkPath = (orgId: string) => `/api/demo/harness/orgs/${orgId}/sink`

    it("a load org's sunk code reads back signed, and verifies the workspace; its effects carry their counts", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const started = await signedStart({ email: addr("load", "load.invalid") })
      expect(started.status).toBe(201)
      const org = started.body.data!
      const read = await signedGet(sinkPath(org.orgId))
      expect(read.status).toBe(200)
      expect(read.body.data!.demoCode).toMatch(/^\d{6}$/)
      const codes = read.body.data!.effects.filter((e) => e.kind === "demo-code")
      expect(codes.length).toBe(1)
      expect(codes[0]!.count).toBe(1)
      const res = await demoApp.request("/api/demo/verify", {
        method: "POST",
        headers: { ...authed(org.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ code: read.body.data!.demoCode }),
      })
      expect(res.status).toBe(200)
    })

    it("only a valid signature skips the per-peer 600/h poll budget; a refused one still spends it", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const missing = sinkPath(crypto.randomUUID())
      // 650 signed reads from one peer: every one is answered by the route
      // (404 for an org that is not there), none is a 429.
      const signedIp = "198.18.5.1"
      const statuses = new Set<number>()
      for (let i = 0; i < 650; i++)
        statuses.add((await signedGet(missing, { ip: signedIp })).status)
      expect([...statuses]).toEqual([404])
      // 650 reads with a wrong key from another peer: the 601st is a 429.
      const badIp = "198.18.5.2"
      let last = 0
      for (let i = 0; i < 601; i++) {
        last = (await signedGet(missing, { ip: badIp, key: "w".repeat(48) })).status
      }
      expect(last).toBe(429)
    }, 60_000)

    it("an org's sink read is its own log: a doubled effect is found whatever else the box logged", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const started = await signedStart({ email: addr("load", "load.invalid") })
      const orgId = started.body.data!.orgId
      const { recordSinkEffect } = await import("~/lib/effect-sink")
      await recordSinkEffect(orgId, "mail", "twice")
      await recordSinkEffect(orgId, "mail", "twice")
      await recordSinkEffect(orgId, "mail", "once")
      const other = crypto.randomUUID()
      for (let i = 0; i < 50; i++) await recordSinkEffect(other, "mail", `noise-${i}`)
      const read = await signedGet(sinkPath(orgId))
      expect(read.status).toBe(200)
      const byKey = Object.fromEntries(read.body.data!.effects.map((e) => [e.key, e.count]))
      expect(byKey.twice).toBe(2)
      expect(byKey.once).toBe(1)
      expect(read.body.data!.effects.every((e) => !e.key.startsWith("noise-"))).toBe(true)
    })

    it("never a real visitor's code: an ordinary org is a 404 even signed, with a code on record", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const email = addr("person", "gmail.com")
      const visitor = await startOk({ email })
      const code = lastCapturedCode(email)?.code
      expect(code).toMatch(/^\d{6}$/)
      const read = await signedGet(sinkPath(visitor.orgId))
      expect(read.status).toBe(404)
      expect(JSON.stringify(read.body)).not.toContain(code!)
      expect((await signedGet(sinkPath("not-a-uuid"))).status).toBe(404)
    })

    it("without the key, without a signature or with a wrong one it is the same 404 (never a 403 that says the harness is on)", async () => {
      LoadHarnessTestAccess.setKey(KEY)
      const started = await signedStart({ email: addr("load", "load.invalid") })
      const orgId = started.body.data!.orgId
      expect((await signedGet(sinkPath(orgId), { unsigned: true })).status).toBe(404)
      const wrong = await signedGet(sinkPath(orgId), { key: "w".repeat(48) })
      expect(wrong.status).toBe(404)
      expect(wrong.body.error?.code).not.toBe("harness_refused")
      LoadHarnessTestAccess.setKey(null)
      expect((await signedGet(sinkPath(orgId))).status).toBe(404)
    })
  })

  it("an ordinary start on a box with the key is untouched: Turnstile runs, the org is not a load org", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const calls = siteverifyCalls.length
    const s = await startOk()
    expect(siteverifyCalls.length).toBeGreaterThan(calls)
    expect(await isLoadOrg(s.orgId)).toBe(false)
    expect((await loadDemoMarker(s.orgId))?.synthetic).toBeUndefined()
  })
})

describe("the demo world", () => {
  const savedWorlds = env.LIAISON_DEMO_WORLDS

  /** What the worlds variable reads as when the box does not set it. */
  const unsetWorlds = () => envSchema.shape.LIAISON_DEMO_WORLDS.parse(undefined)

  /** Run these worlds, as if each had its seed pack. */
  function runWorlds(worlds: string): void {
    DemoWorldsTestAccess.setSeedable(["products", "saas", "studio"])
    env.LIAISON_DEMO_WORLDS = worlds
  }

  afterEach(() => {
    env.LIAISON_DEMO_WORLDS = savedWorlds
    DemoWorldsTestAccess.setSeedable(null)
    DemoModeTestAccess.set(true)
  })

  const markerOf = async (orgId: string) => {
    invalidateDemoMarker(orgId)
    return (await loadDemoMarker(orgId)) as Record<string, unknown> | null
  }

  it("a signup body naming a world is ignored and the marker holds the world derived from the entry", async () => {
    runWorlds("products,saas")
    const s = await startOk({
      entry: { id: "software" },
      worldId: "studio",
      world: "studio",
      needs: ["money", "support"],
    })
    const marker = await markerOf(s.orgId)
    expect(marker?.worldId).toBe("saas")
    expect(marker?.worldMonth).toMatch(/^\d{4}-\d{2}$/)
    expect(marker?.needs).toEqual(["money", "support"])
    const seeded = await seedRequestOf(s.orgId)
    expect(seeded.worldId).toBe("saas")

    // A body naming a world with no entry still opens the default world.
    const plain = await startOk({ worldId: "saas", needs: ["support"] })
    expect((await markerOf(plain.orgId))?.worldId).toBe("products")
    expect((await seedRequestOf(plain.orgId)).worldId).toBe("products")
  })

  it("an entry whose world this box does not run opens the products world", async () => {
    runWorlds("products")
    const s = await startOk({ entry: { id: "software" }, needs: ["support", "dev"] })
    const marker = await markerOf(s.orgId)
    expect(marker?.worldId).toBe("products")
    expect("worldMonth" in (marker ?? {})).toBe(false)
    expect(s.needs).toEqual(["support", "dev"])
  })

  it("with the worlds variable unset every entry opens the products world", async () => {
    env.LIAISON_DEMO_WORLDS = unsetWorlds()
    for (const id of ["products", "software", "expertise", "other"]) {
      const s = await startOk({ entry: { id }, needs: ["support"] })
      expect((await markerOf(s.orgId))?.worldId).toBe("products")
    }
  })

  it("a software signup asking only for commerce answers 422 and creates nothing", async () => {
    runWorlds("products,saas")
    const email = addr(`stale-tab-${Date.now()}-`)
    const before = seedRequests.length
    const r = await start({ email, entry: { id: "software" }, needs: ["commerce"] })
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe("needs_not_in_world")
    expect((r.body.error as { message?: string }).message).toBeTruthy()
    const leads = await sql`SELECT 1 FROM kernel.demo_leads WHERE email = ${email}`
    expect(leads.length).toBe(0)
    await Bun.sleep(100)
    expect(seedRequests.length).toBe(before)

    // A need of another world beside one of its own is dropped, not refused.
    const mixed = await startOk({ entry: { id: "software" }, needs: ["commerce", "support"] })
    expect(mixed.needs).toEqual(["support"])
    expect((await markerOf(mixed.orgId))?.needs).toEqual(["support"])
    // The products world refuses the software world's need the same way.
    const other = await start({ entry: { id: "products" }, needs: ["money"] })
    expect(other.status).toBe(422)
  })

  it("the door route answers only the enabled worlds, needs no session and is absent off demo", async () => {
    const door = async () => {
      const res = await demoApp.request("/api/demo/door", {
        headers: { "x-bun-socket-ip": nextIp() },
      })
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown }
    }
    env.LIAISON_DEMO_WORLDS = unsetWorlds()
    expect(await door()).toEqual({ status: 200, body: { data: { worlds: ["products"] } } })
    runWorlds("saas,products")
    expect(await door()).toEqual({ status: 200, body: { data: { worlds: ["products", "saas"] } } })
    // A world named in the env with no seed pack is not offered.
    DemoWorldsTestAccess.setSeedable(["products", "saas"])
    env.LIAISON_DEMO_WORLDS = "products,saas,studio"
    expect((await door()).body).toEqual({ data: { worlds: ["products", "saas"] } })
    DemoModeTestAccess.set(false)
    expect((await door()).status).toBe(404)
  })

  it("a member of a visitor org reads its world, a non-demo org gets 404", async () => {
    runWorlds("products,saas")
    const world = (token?: string) =>
      demoApp.request("/api/demo/world", {
        headers: token ? authed(token) : { "x-bun-socket-ip": nextIp() },
      })
    const saas = await startOk({ entry: { id: "software" }, needs: ["money"] })
    const res = await world(saas.accessToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { worldId: "saas" } })
    const products = await startOk({ needs: ["support"] })
    expect(await (await world(products.accessToken)).json()).toEqual({
      data: { worldId: "products" },
    })

    const regular = await minimal.session((await createTestOrg()).id)
    expect((await world(regular.bearer)).status).toBe(404)
    const reserved = await minimal.adminSession((await createTestOrg()).id)
    await markOrgAsDemo(reserved.orgId, reservedMarker())
    expect((await world(reserved.bearer)).status).toBe(404)
    expect((await world()).status).toBe(401)
  })

  it("the free text of an other answer reaches no log line, no prompt and no seed dump", async () => {
    const { rootLogger } = await import("~/lib/logger")
    const proto = Object.getPrototypeOf(rootLogger.child({ module: "demo-signup" }))
    const lines: unknown[][] = []
    const spies = (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => {
      const spy = spyOn(proto, level)
      spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
        lines.push(args)
      })
      return spy
    })
    const email = addr(`free-text-${Date.now()}-`)
    let orgId = ""
    try {
      const s = await startOk({
        email,
        entry: { id: "other", text: "ZZFREE bakery chain" },
        needs: ["support"],
      })
      orgId = s.orgId
      await seedRequestOf(orgId)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    for (const line of lines) expect(JSON.stringify(line)).not.toContain("ZZFREE")
    const entryLines = lines.filter((l) => l[1] === "demo door entry")
    expect(entryLines).toEqual([[{ demoEntry: "other" }, "demo door entry"]])
    // The seed is handed nothing of the answer, so nothing it writes can hold it.
    expect(JSON.stringify(await seedRequestOf(orgId))).not.toContain("ZZFREE")
    // No table but the marker: the lead row holds none of it.
    const leads = await sql<{ row: unknown }[]>`
      SELECT to_jsonb(l) AS row FROM kernel.demo_leads l WHERE email = ${email}`
    expect(leads.length).toBe(1)
    expect(JSON.stringify(leads[0]?.row)).not.toContain("ZZFREE")
    expect(JSON.stringify((await markerOf(orgId))?.entry)).toContain("ZZFREE")
    // No prompt: the answer is read back only by the door's own routes, never
    // by the agent's context or any other server code.
    const readers: string[] = []
    const root = new URL("../..", import.meta.url).pathname
    for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
      if (rel.includes(".test.")) continue
      const text = await Bun.file(`${root}${rel}`).text()
      if (/demoEntryOf\(|marker\??\.entry\b/.test(text)) readers.push(rel)
    }
    expect(readers.sort()).toEqual(["modules/demo/demo-org.ts", "modules/demo/routes.ts"])
  })
})

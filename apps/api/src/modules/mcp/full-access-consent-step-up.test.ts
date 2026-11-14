// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approving an MCP connection that carries the person's WHOLE access (one bound
// to no agent) takes a fresh step-up, on both paths that mint one: the OAuth
// authorize consent and the MCP device-grant approval. A signed-in session
// alone is not enough. A connection bound to an agent (narrowed to that
// agent's ceiling) needs none, and neither does a silent re-consent of a client
// the person already approved.
//
// `./_device-grant-test-env` MUST be the first import (DEVICE_FLOW_CLIENTS
// before `~/lib/env` parses the environment).
import "./_device-grant-test-env"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { Hono } from "hono"
import { sql } from "~/db"
import { ConsoleEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { hashPassword, hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  stepUpCodeKey,
  stepUpPasswordFailKey,
  stepUpResendCooldownKey,
} from "~/modules/auth/step-up"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"
const PLACEHOLDER_ORG_ID = "00000000-0000-0000-0000-000000000000"
const ORG = "00000000-0000-4000-8000-00000005c001"
const USER = "00000000-0000-4000-8000-00000005c002"
const ROLE = "00000000-0000-4000-8000-00000005c003"
const AGENT = "00000000-0000-4000-8000-00000005c010"
const PASSWORD = "correct horse battery staple"
const EMAIL = "mcp-step-up@test.com"
const mailbox = new ConsoleEmailProvider()

/** The step-up emails this user got for connecting an AI tool. */
function connectCodeEmails() {
  return mailbox.sent.filter((m) => m.to === EMAIL && m.subject.includes("connect an AI tool"))
}

/** Every Redis key the step-up of this user touches. */
const stepUpKeys = () => [
  stepUpCodeKey(USER, "mcp_connect"),
  stepUpPasswordFailKey(USER),
  stepUpResendCooldownKey(USER, "mcp_connect"),
  `totp-stepup-rate:${USER}`,
]

async function createTestApp() {
  const { mcpOAuth } = await import("~/modules/mcp/oauth-server-routes")
  const { mcpDeviceGrant } = await import("~/modules/mcp/device-grant-routes")
  const { deviceFlow } = await import("~/modules/auth/device-flow-routes")
  const { auth } = await import("~/modules/auth/routes")
  const { authMiddleware } = await import("~/middleware/auth")
  const { errorHandler } = await import("~/middleware/error-handler")
  const app = new Hono()
  app.onError(errorHandler)
  app.use("/mcp/oauth/authorize/consent", authMiddleware(TEST_SECRET))
  app.use("/api/auth/device-flow/approve/*", authMiddleware(TEST_SECRET))
  app.use("/api/auth/totp/step-up", authMiddleware(TEST_SECRET))
  app.route("/mcp/oauth", mcpOAuth)
  app.route("/api/auth/device-flow", deviceFlow)
  app.route("/api/auth", auth)
  app.route("/mcp/device", mcpDeviceGrant)
  return app
}

/** A valid emailed code for connecting an AI tool, as `/api/auth/totp/step-up` stores it. */
async function emailedCode(): Promise<string> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(USER, "mcp_connect"), hashToken(code), "EX", 600)
  return code
}

describe("full-access MCP approval takes a fresh step-up", () => {
  let app: Hono
  let token: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${PLACEHOLDER_ORG_ID}, 'Placeholder Org', 'placeholder') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MCP Step-up Org', 'mcp-step-up') ON CONFLICT (id) DO NOTHING`
    const passwordHash = await hashPassword(PASSWORD)
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version, password_hash)
      VALUES (${USER}, ${ORG}, ${EMAIL}, 'Step-up User', 'active', 1, ${passwordHash})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE}, ${ORG}, 'su-admin', 'mcp step-up admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${ROLE}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@mcp-step-up-agent', 'Step-up Agent', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    setSystemEmailProvider(mailbox)
    app = await createTestApp()
    token = await signAccessToken(
      { userId: USER, orgId: ORG, name: "Step-up User", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.device_flow_requests WHERE client_id = 'mcp:step-up-client'`
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await redis.del(...stepUpKeys())
    mailbox.sent.length = 0
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.device_flow_requests WHERE client_id = 'mcp:step-up-client'`
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.mcp_oauth_clients WHERE client_name = 'StepUpTest Client'`
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE id = ${ROLE}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await redis.del(...stepUpKeys())
    setSystemEmailProvider(null)
  })

  describe("OAuth authorize consent", () => {
    async function registerClient(): Promise<string> {
      const res = await app.request("/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "StepUpTest Client",
          redirect_uris: ["https://client.example/cb"],
        }),
      })
      expect(res.status).toBe(201)
      return ((await res.json()) as { client_id: string }).client_id
    }

    function consentQuery(clientId: string, extra = ""): string {
      const challenge = createHash("sha256")
        .update(randomBytes(32).toString("hex"))
        .digest("base64url")
      return new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "st",
      })
        .toString()
        .concat(extra)
    }

    function consent(clientId: string, extra: string, body?: unknown) {
      return app.request(`/mcp/oauth/authorize/consent?${consentQuery(clientId, extra)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }

    it("refuses a full-access approval without a step-up, with a typed error and no code", async () => {
      const clientId = await registerClient()
      const res = await consent(clientId, "&consent=approve&ack=full")
      const body = (await res.json()) as { redirect?: string; error?: { code?: string } }
      console.log("oauth full access, no step-up ->", res.status, JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(body.redirect).toBeUndefined()
      expect(body.error?.code).toBe("STEP_UP_REQUIRED")
    })

    it("refuses a wrong code", async () => {
      const clientId = await registerClient()
      await emailedCode()
      const res = await consent(clientId, "&consent=approve&ack=full", { stepUpCode: "000000" })
      expect(res.status).toBe(422)
    })

    it("approves with a fresh emailed code, which is then spent", async () => {
      const clientId = await registerClient()
      const code = await emailedCode()
      const res = await consent(clientId, "&consent=approve&ack=full", { stepUpCode: code })
      const body = (await res.json()) as { redirect?: string }
      console.log("oauth full access, emailed code ->", res.status)
      expect(res.status).toBe(200)
      expect(new URL(body.redirect!).searchParams.get("code")).toBeTruthy()
      const again = await consent(clientId, "&consent=approve&ack=full", { stepUpCode: code })
      expect(again.status).toBe(422)
    })

    it("refuses the current password: the emailed code is the only proof", async () => {
      const clientId = await registerClient()
      const res = await consent(clientId, "&consent=approve&ack=full", {
        currentPassword: PASSWORD,
      })
      const body = (await res.json()) as { redirect?: string; error?: { code?: string } }
      console.log("oauth full access, password ->", res.status, JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(body.redirect).toBeUndefined()
      expect(body.error?.code).toBe("STEP_UP_REQUIRED")
    })

    function authorizeUrl(clientId: string): string {
      return `/mcp/oauth/authorize?${consentQuery(clientId)}`
    }

    it("the consent page asks for an emailed code only: no password field, no form", async () => {
      const clientId = await registerClient()
      const html = await (await app.request(authorizeUrl(clientId))).text()
      expect(html).toContain('id="stepup"')
      expect(html).toContain("Full access needs one more confirmation: a code we email you.")
      expect(html).not.toMatch(/type=["']?password/i)
      expect(html).not.toContain("current-password")
      expect(html).not.toMatch(/autocomplete=["']?username/i)
      expect(html).not.toMatch(/<form\b/i)
      const codeInput = html.match(/<input[^>]*id="code"[^>]*>/)?.[0] ?? ""
      expect(codeInput).toContain('name="code"')
      expect(codeInput).toContain('inputmode="numeric"')
      expect(codeInput).toContain('autocomplete="one-time-code"')
      // The page's only text inputs: the code (the other input is the checkbox).
      const inputs = html.match(/<input[^>]*>/g) ?? []
      expect(inputs.filter((i) => !i.includes('type="checkbox"'))).toEqual([codeInput])
    })

    /**
     * One view of the consent page, as a browser runs it: the page's own script
     * with the page's elements, its requests answered by the real routes.
     */
    async function viewConsentPage(clientId: string) {
      const html = await (await app.request(authorizeUrl(clientId))).text()
      const js = await (await app.request("/mcp/oauth/authorize.js")).text()
      const card = html.match(/<div class="card" id="consent"([^>]*)>/)?.[1] ?? ""
      const dataset: Record<string, string> = {}
      for (const [, k, v] of card.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
        dataset[k!.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v!
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
      }
      type El = {
        id: string
        onclick: null | (() => void)
        onchange: null | (() => void)
        disabled: boolean
        style: Record<string, string>
        dataset: Record<string, string>
        value: string
        textContent: string
        checked: boolean
        focused: boolean
        focus: () => void
      }
      const nodes: Record<string, El> = {}
      for (const [, id] of html.matchAll(/id="([a-z]+)"/g)) {
        const node: El = {
          id: id!,
          onclick: null,
          onchange: null,
          disabled: false,
          style: {},
          dataset: id === "consent" ? dataset : {},
          value: "",
          textContent: "",
          checked: false,
          focused: false,
          focus: () => {
            node.focused = true
          },
        }
        nodes[id!] = node
      }
      const requests: string[] = []
      const fetchStub = (url: string, init?: RequestInit) => {
        requests.push(url.split("?")[0]!)
        if (url.startsWith("/api/auth/refresh")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { accessToken: token } }), { status: 200 }),
          )
        }
        return app.request(url, init)
      }
      // The page's clock: each pending timer runs when the test lets a second pass.
      let timers: Array<() => void> = []
      const elapseSecond = () => {
        const due = timers
        timers = []
        for (const cb of due) cb()
      }
      new Function("document", "fetch", "window", "setTimeout", js)(
        { getElementById: (id: string) => nodes[id] ?? null },
        fetchStub,
        { location: { href: "" } },
        (cb: () => void) => {
          timers.push(cb)
        },
      )
      return { nodes, requests, elapseSecond }
    }

    async function settled(check: () => boolean) {
      for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10)
    }

    it("a page view emails the code once, a reload within the cooldown sends none, a resend after it sends one", async () => {
      const clientId = await registerClient()
      const first = await viewConsentPage(clientId)
      await settled(() => first.nodes.sent?.style.display === "block")
      expect(first.requests).toContain("/api/auth/totp/step-up")
      expect(connectCodeEmails()).toHaveLength(1)
      expect(first.nodes.sent?.style.display).toBe("block")
      expect(first.nodes.code?.focused).toBe(true)
      expect(first.nodes.resend?.disabled).toBe(true)
      expect(first.nodes.wait?.textContent).toMatch(/^You can send a new one in \d+ seconds\.$/)

      // A reload: the page asks again, the server sends nothing, the first code stands.
      const reload = await viewConsentPage(clientId)
      await settled(() => reload.nodes.sent?.style.display === "block")
      expect(reload.requests).toContain("/api/auth/totp/step-up")
      expect(connectCodeEmails()).toHaveLength(1)
      expect(reload.nodes.sent?.style.display).toBe("block")
      expect(reload.nodes.senderr?.style.display).not.toBe("block")

      // The cooldown is over (its key gone): the resend sends a new code.
      await redis.del(stepUpResendCooldownKey(USER, "mcp_connect"))
      const later = await viewConsentPage(clientId)
      await settled(() => connectCodeEmails().length === 2)
      expect(connectCodeEmails()).toHaveLength(2)
      // The email goes out before the page reads the answer: wait for the page to take it
      // (it shows the code was sent and starts its countdown) before running the clock.
      await settled(() => later.nodes.sent?.style.display === "block")
      expect(later.nodes.sent?.style.display).toBe("block")
      // On the page, the resend opens once its countdown has run out.
      expect(later.nodes.resend?.disabled).toBe(true)
      for (let i = 0; i < 61; i++) later.elapseSecond()
      expect(later.nodes.resend?.disabled).toBe(false)
      expect(later.nodes.wait?.style.display).toBe("none")
      await redis.del(stepUpResendCooldownKey(USER, "mcp_connect"))
      const resendClick = later.nodes.resend?.onclick
      if (!resendClick) throw new Error("the page wired no resend")
      resendClick()
      await settled(() => connectCodeEmails().length === 3)
      expect(connectCodeEmails()).toHaveLength(3)

      // The code in the last email approves.
      const lastCode = connectCodeEmails()[2]!.subject.match(/^(\d{6}) /)?.[1]
      expect(lastCode).toBeTruthy()
      const res = await consent(clientId, "&consent=approve&ack=full", { stepUpCode: lastCode })
      expect(res.status).toBe(200)
    })

    it("an agent-bound consent page emails nothing", async () => {
      const clientId = await registerClient()
      const html = await (
        await app.request(`/mcp/oauth/authorize?${consentQuery(clientId, `&agent_id=${AGENT}`)}`)
      ).text()
      expect(html).not.toContain('id="stepup"')
      const js = await (await app.request("/mcp/oauth/authorize.js")).text()
      const requests: string[] = []
      const el = () => ({ style: {}, dataset: {}, value: "", disabled: false, focus: () => {} })
      const nodes: Record<string, ReturnType<typeof el>> = {
        consent: el(),
        deny: el(),
        approve: el(),
        err: el(),
      }
      new Function("document", "fetch", "window", "setTimeout", js)(
        { getElementById: (id: string) => nodes[id] ?? null },
        (url: string) => {
          requests.push(url.split("?")[0]!)
          return Promise.resolve(new Response(JSON.stringify({ error: "x" }), { status: 403 }))
        },
        { location: { href: "" } },
        () => {},
      )
      await Bun.sleep(50)
      expect(requests).not.toContain("/api/auth/totp/step-up")
      expect(connectCodeEmails()).toHaveLength(0)
    })

    it("an agent-bound approval needs no step-up", async () => {
      const clientId = await registerClient()
      const res = await consent(clientId, `&consent=approve&agent_id=${AGENT}`)
      console.log("oauth agent-bound, no step-up ->", res.status)
      expect(res.status).toBe(200)
    })

    it("silent re-consent of a client already approved needs no step-up", async () => {
      const clientId = await registerClient()
      await sql`INSERT INTO kernel.mcp_connections (org_id, user_id, client_id, label, refresh_token_hash)
        VALUES (${ORG}, ${USER}, ${clientId}, 'prior', ${hashToken(randomBytes(16).toString("hex"))})`
      const res = await consent(clientId, "&consent=auto")
      expect(res.status).toBe(200)
    })
  })

  describe("MCP device-grant approval", () => {
    async function initiate(agentId?: string): Promise<string> {
      const res = await app.request("/mcp/device/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "step-up-client", ...(agentId ? { agentId } : {}) }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: { userCode: string } }).data.userCode
    }

    function approve(userCode: string, body: Record<string, unknown>) {
      return app.request(`/api/auth/device-flow/approve/${userCode}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    }

    async function state(userCode: string): Promise<string | undefined> {
      const [row] = await sql<{ state: string }[]>`
        SELECT state FROM kernel.device_flow_requests WHERE user_code = ${userCode}`
      return row?.state
    }

    it("refuses a full-access approval without a step-up and leaves the grant pending", async () => {
      const userCode = await initiate()
      const res = await approve(userCode, { confirmFullAccess: true })
      const body = (await res.json()) as { error?: { code?: string } }
      console.log("device full access, no step-up ->", res.status, JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(body.error?.code).toBe("STEP_UP_REQUIRED")
      expect(await state(userCode)).toBe("pending")
    })

    it("approves with a fresh emailed code", async () => {
      const userCode = await initiate()
      const res = await approve(userCode, {
        confirmFullAccess: true,
        stepUpCode: await emailedCode(),
      })
      console.log("device full access, emailed code ->", res.status)
      expect(res.status).toBe(200)
      expect(await state(userCode)).toBe("approved")
    })

    it("refuses the current password for a full-access grant and leaves it pending", async () => {
      const userCode = await initiate()
      const res = await approve(userCode, { confirmFullAccess: true, currentPassword: PASSWORD })
      const body = (await res.json()) as { error?: { code?: string } }
      expect(res.status).toBe(400)
      expect(body.error?.code).toBe("STEP_UP_REQUIRED")
      expect(await state(userCode)).toBe("pending")
    })

    it("an agent-bound grant needs no step-up", async () => {
      const userCode = await initiate(AGENT)
      const res = await approve(userCode, {})
      console.log("device agent-bound, no step-up ->", res.status)
      expect(res.status).toBe(200)
      expect(await state(userCode)).toBe("approved")
    })
  })
})

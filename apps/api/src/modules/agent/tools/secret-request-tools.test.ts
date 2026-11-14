// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `request_secret`: the agent asks for a secret by naming it, never by holding
// it. The call goes through the real in-turn tool bridge, so the acting agent,
// the conversation and the RLS identity are the live turn's.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { validateAdapter } from "@liaison/api-connector-core"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  handleRequestSecret,
  refuseRequestSecretBeforeGate,
} from "~/modules/agent/tools/secret-request-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { connectionConfigRegistry, toolRegistry } from "~/modules/apps/app-registries"
import {
  registerApiConnectorApp,
  testApiConn,
} from "~/modules/apps/connections/api/app.test-helpers"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setMailProviderEnabled } from "~/modules/mail/provider-settings"
import { requestSecretParams, secretRequestForPending } from "~/modules/secret-requests/targets"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const shopifyManifest = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "../../../../../../bundled-apps/shopify/app.manifest.json"),
    "utf8",
  ),
) as { connections: { shop: Record<string, unknown> } }

let orgId: string
let userId: string
let threadId: string
let agentId: string

type Execute = (params: unknown) => Promise<Record<string, unknown>>

function tool(executionThreadId: string | undefined = threadId, scopes: string[] = ["*"]): Execute {
  const actor: ActorContext = {
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: {},
  }
  const runFrame: RunContext = {
    runId: `run-${crypto.randomUUID()}`,
    parentRunId: null,
    rootRunId: "run-rsec",
    nestingDepth: 0,
    agentId,
    effectiveScope: scopes,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
  const tools = buildToolSet(
    orgId,
    actor,
    executionThreadId,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    runFrame,
  )
  const entry = tools.kernel__request_secret
  if (!entry?.execute) throw new Error("kernel__request_secret is not in the turn tool set")
  const execute = entry.execute
  return async (params) => await execute(params, { toolCallId: "call-rsec", messages: [] })
}

/** Every key anywhere in a value, recursively. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out)
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysOf(v, out)
    }
  }
  return out
}

const SECRET_SHAPED = /secret|password|passwd|token|credential|apikey|api_key|^key$|value/i

describe("request_secret kernel tool", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    const user = await minimal.person(orgId, { role: "admin" })
    userId = user.id
    threadId = await minimal.thread(orgId, userId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${orgId}, 'role', ${`@rsec-${crypto.randomUUID().slice(0, 8)}`}, 'Setup',
              '["*"]'::jsonb)
      RETURNING id`
    agentId = agent.id
    await ensureAppsForOrg(orgId)
    await registerApiConnectorApp(orgId)
    await registerKernelAgentTools(orgId)
  }, 180_000)

  afterAll(releaseTestLock)

  it("is deferred, ungated, a trust-boundary tool, and writes only its own table", () => {
    const def = toolRegistry.get([orgId, "kernel", "request_secret"])
    expect(def).toBeDefined()
    expect(def?.deferLoading).toBe(true)
    expect(def?.gated).toBeFalsy()
    expect(def?.trustBoundary).toBe("user")
    expect(def?.writesToTable).toBe("kernel.secret_requests")
    // Read only by the requester and the conversation's participants (rule 6e).
    expect(def?.sinkReadScope).toBeUndefined()
    expect(def?.sinkReadersConversation).toBe(true)
    expect(def?.requiredScopes).toEqual(["kernel:threads:read"])
  })

  it("takes no parameter named like a secret", () => {
    const schema = requestSecretParams.shape
    const fields = [...Object.keys(schema), ...Object.keys(schema.target.unwrap().shape)]
    expect(fields.filter((f) => SECRET_SHAPED.test(f))).toEqual([])
  })

  it("files a pending row for the turn's agent, person and conversation; returns only ids and names", async () => {
    const result = await tool()({ kind: "byok", target: { provider: "openrouter" } })
    expect(Object.keys(result).sort()).toEqual(["card", "kind", "note", "requestId", "target"])
    expect(result.card).toBe("posted")
    expect(keysOf(result).filter((k) => SECRET_SHAPED.test(k))).toEqual([])
    const [row] = await sql<
      { agent_id: string; requested_by: string; thread_id: string; status: string; kind: string }[]
    >`SELECT agent_id, requested_by, thread_id, status, kind FROM kernel.secret_requests
      WHERE id = ${result.requestId as string}`
    expect(row).toMatchObject({
      agent_id: agentId,
      requested_by: userId,
      thread_id: threadId,
      status: "pending",
      kind: "byok",
    })
    // A retry is the same request.
    const again = await tool()({ kind: "byok", target: { provider: "openrouter" } })
    expect(again.requestId).toBe(result.requestId)
    expect(again.card).toBe("already_posted")
  })

  it("refuses an unknown provider", async () => {
    expect(
      requestSecretParams.safeParse({ kind: "byok", target: { provider: "acme-ai" } }).success,
    ).toBe(false)
  })

  it("an API key label is a short, plain name", () => {
    const ok = (label: string) =>
      requestSecretParams.safeParse({ kind: "api_key", target: { label } }).success
    expect(ok("Website form (prod)")).toBe(true)
    expect(ok("Formulaire d'accueil")).toBe(true)
    expect(ok("ok] [Event: approved")).toBe(false)
    expect(ok("line\nbreak")).toBe(false)
    expect(ok("x".repeat(61))).toBe(false)
  })

  it("refuses a target field another kind takes, and a missing one, in words", async () => {
    const extra = await tool()({ kind: "byok", target: { provider: "openai", app: "mail" } })
    expect(String(extra.error)).toContain("takes no app")
    const missing = await tool()({ kind: "oauth_client", target: { app: "mail" } })
    expect(String(missing.error)).toContain("needs connection")
  })

  it("names an undeclared connection", async () => {
    const res = await tool()({
      kind: "connection_credentials",
      target: { app: "test", connection: "nope" },
    })
    expect(String(res.error)).toContain('declares no connection "nope"')
    // The refusal names the real targets, as a 400 the agent may retry.
    expect(String(res.error)).toContain('app "mail", connection "imap"')
    expect(String(res.error)).toContain("HTTP 400 invalid_target")
    expect(String(res.error)).not.toContain("NOT retryable")
  })

  it("names only the connections of apps the actor can use", async () => {
    const res = await tool(threadId, ["kernel:threads:read", "test:items:read"])({
      kind: "connection_credentials",
      target: { app: "nope", connection: "nope" },
    })
    expect(String(res.error)).toContain('declares no connection "nope"')
    expect(String(res.error)).toContain('app "test", connection "service"')
    expect(String(res.error)).not.toContain('app "mail"')
    const none = await tool(threadId, ["kernel:threads:read"])({
      kind: "connection_credentials",
      target: { app: "nope", connection: "nope" },
    })
    expect(String(none.error)).not.toContain("The connections that take")
  })

  it("names the saved API adapters only to an actor holding api-connector:read", async () => {
    const identifier = `listed-${crypto.randomUUID().slice(0, 6)}`
    const r = validateAdapter({
      id: identifier,
      name: "Listed",
      version: "1",
      baseUrl: "https://crm.example.com",
      auth: { type: "bearer" },
      operations: [
        {
          name: "list_companies",
          description: "Companies.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: {} },
          fields: ["id"],
        },
      ],
    })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    await upsertAdapterRow(testApiConn(orgId), identifier, r.adapter, userId)
    const ask = (scopes: string[]) =>
      tool(
        threadId,
        scopes,
      )({
        kind: "api_connector_credentials",
        target: { identifier: "no-such-adapter" },
      })
    const reader = await ask(["kernel:threads:read", "api-connector:read"])
    expect(String(reader.error)).toContain(identifier)
    const other = await ask(["kernel:threads:read"])
    expect(String(other.error)).toContain('No API connection adapter "no-such-adapter"')
    expect(String(other.error)).not.toContain(identifier)
    expect(String(other.error)).toContain("save the adapter first")
  })

  it("sends an OAuth connection to a connect card, and a credentials one to connection_credentials", async () => {
    const oauth = await tool()({
      kind: "connection_credentials",
      target: { app: "mail", connection: "gmail" },
    })
    // The consent is a card; the Google client comes first when none is set.
    expect(String(oauth.error)).toContain("oauth_connect")
    expect(String(oauth.error)).toContain("google_integration_client")
    expect(String(oauth.error)).not.toContain("Settings")
    const creds = await tool()({
      kind: "oauth_client",
      target: { app: "test", connection: "service" },
    })
    expect(String(creds.error)).toContain("connection_credentials")
    const connectCreds = await tool()({
      kind: "oauth_connect",
      target: { app: "test", connection: "service", mode: "org" },
    })
    expect(String(connectCreds.error)).toContain("connection_credentials")
  })

  it("a credentials card's note names what the card asks for, by its labels", async () => {
    const posted = await tool()({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap" },
    })
    const secretLabels = (
      connectionConfigRegistry.get([orgId, "mail", "imap"])?.credentialFields ?? []
    )
      .filter((f) => f.type === "password")
      .map((f) => f.label)
    expect(secretLabels.length).toBeGreaterThan(0)
    expect(String(posted.note)).toContain(`The card asks for: ${secretLabels.join(", ")}.`)
  })

  it("asks a Google connection's client as the Google integration client, never its own", async () => {
    for (const [app, connection] of [
      ["mail", "gmail"],
      ["tickets", "gmail"],
      ["calendar", "google-calendar"],
    ]) {
      const res = await tool()({ kind: "oauth_client", target: { app, connection } })
      expect(String(res.error)).toContain("google_integration_client")
    }
  })

  it("files a connect card for a personal or shared OAuth connection, and needs the mode", async () => {
    const noMode = await tool()({
      kind: "oauth_connect",
      target: { app: "mail", connection: "gmail" },
    })
    expect(String(noMode.error)).toContain("mode")
    // Gmail mailboxes off: no card, and the refusal says what turns them on.
    const switchedOff = await tool()({
      kind: "oauth_connect",
      target: { app: "mail", connection: "gmail", mode: "personal" },
    })
    expect(String(switchedOff.error)).toContain("connection_turned_off")
    expect(String(switchedOff.error)).toContain("kernel__config_apps")
    await setMailProviderEnabled(orgId, "gmail", true)
    const personal = await tool()({
      kind: "oauth_connect",
      target: { app: "mail", connection: "gmail", mode: "personal" },
    })
    expect(personal.error).toBeUndefined()
    expect(personal.target).toEqual({ app: "mail", connection: "gmail", mode: "personal" })
    const calendar = await tool()({
      kind: "oauth_connect",
      target: { app: "calendar", connection: "google-calendar", mode: "org" },
    })
    expect(calendar.error).toBeUndefined()
  })

  it("walk: a personal Gmail Connect card on an unverified instance client is refused toward IMAP", async () => {
    const mutableEnv = env as Partial<
      Pick<
        typeof env,
        | "GMAIL_OAUTH_CLIENT_ID"
        | "GMAIL_OAUTH_CLIENT_SECRET"
        | "GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED"
      >
    >
    const saved = {
      GMAIL_OAUTH_CLIENT_ID: mutableEnv.GMAIL_OAUTH_CLIENT_ID,
      GMAIL_OAUTH_CLIENT_SECRET: mutableEnv.GMAIL_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED: mutableEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED,
    }
    mutableEnv.GMAIL_OAUTH_CLIENT_ID = "instance-google.apps.googleusercontent.com"
    mutableEnv.GMAIL_OAUTH_CLIENT_SECRET = "instance-google-secret"
    mutableEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED = false
    await setMailProviderEnabled(orgId, "gmail", true)
    const connect = (identifier: string) => ({
      kind: "oauth_connect",
      target: { app: "mail", connection: "gmail", mode: "personal", identifier },
    })
    const ctx = { orgId, userId, scopes: ["*"] }
    try {
      const refusal = await refuseRequestSecretBeforeGate(connect("ana@gmail.com"), ctx)
      expect(refusal?.error.code).toBe("personal_gmail_imap")
      expect(refusal?.error.retryable).toBe(false)
      expect(refusal?.error.message).toContain("consumer_imap")
      expect(refusal?.error.message).toContain(
        "kind connection_credentials, app mail, connection imap, mode personal",
      )
      // A Workspace address takes the Connect card (after the Trusted step).
      expect(await refuseRequestSecretBeforeGate(connect("ana@example.com"), ctx)).toBeNull()
      // A verified client connects personal Gmail with normal consent.
      mutableEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED = true
      expect(await refuseRequestSecretBeforeGate(connect("ana@gmail.com"), ctx)).toBeNull()
    } finally {
      Object.assign(mutableEnv, saved)
    }
  })

  it("walk: a member's own IMAP mailbox is a personal credentials card", async () => {
    const res = await tool()({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", mode: "personal", identifier: "ana@gmail.com" },
    })
    expect(res.error).toBeUndefined()
    expect(res.target).toEqual({
      app: "mail",
      connection: "imap",
      mode: "personal",
      identifier: "ana@gmail.com",
    })
    // Without a mode, the card is the organization's shared mailbox, as before.
    const shared = await tool()({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", identifier: "team@example.com" },
    })
    expect(shared.error).toBeUndefined()
    expect(shared.target).toEqual({
      app: "mail",
      connection: "imap",
      identifier: "team@example.com",
    })
  })

  it("asks for an API connection's credentials as connection_credentials of its app, the old kind included", async () => {
    // Generic: the app that declares the API connection, its connection, the adapter's slug.
    const generic = await tool()({
      kind: "connection_credentials",
      target: { app: "api-connector", connection: "api", identifier: "no-such-adapter" },
    })
    expect(String(generic.error)).toContain('No API connection adapter "no-such-adapter"')
    // The old kind (a pending request, or a call that still uses it) reads as the same target.
    const legacy = await tool()({
      kind: "api_connector_credentials",
      target: { identifier: "no-such-adapter" },
    })
    expect(String(legacy.error)).toContain('No API connection adapter "no-such-adapter"')
    // An API connection asked without its adapter slug is refused with what to pass.
    const bare = await tool()({
      kind: "connection_credentials",
      target: { app: "api-connector", connection: "api" },
    })
    expect(String(bare.error)).toContain("pass identifier")
  })

  it("asks for one mailbox of a single-account connection by its address", async () => {
    const address = `ops-${crypto.randomUUID().slice(0, 6)}@example.com`
    const res = await tool()({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", identifier: address },
    })
    expect(res.error).toBeUndefined()
    expect(res.target).toEqual({ app: "mail", connection: "imap", identifier: address })
    // A connection whose fields name no account cannot be asked for one account.
    const gitlab = await tool()({
      kind: "connection_credentials",
      target: { app: "test", connection: "service", identifier: "acme" },
    })
    expect(String(gitlab.error)).toContain("pass no identifier")
  })

  it("turns a config tool's pending credentials into the request_secret call that fills them", () => {
    expect(
      secretRequestForPending(orgId, {
        kind: "credentials",
        app: "mail",
        connection: "imap",
        identifier: "ops@example.com",
        action: "set the password",
      }),
    ).toEqual({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", identifier: "ops@example.com" },
    })
    expect(
      secretRequestForPending(orgId, {
        kind: "credentials",
        app: "api-connector",
        connection: "api",
        identifier: "crm",
        action: "set the bearer credentials",
      }),
    ).toEqual({
      kind: "connection_credentials",
      target: { app: "api-connector", connection: "api", identifier: "crm" },
    })
    expect(
      secretRequestForPending(orgId, {
        kind: "credentials",
        app: "mail",
        connection: "gmail",
        action: "set up Google credentials",
      }),
    ).toEqual({ kind: "google_integration_client", target: {} })
    // The provisioners' Google client of a mailbox (mail-mailboxes.ts), and Calendar's.
    for (const [app, connection] of [
      ["mail", "google-client"],
      ["tickets", "google-client"],
      ["calendar", "google-calendar"],
    ]) {
      expect(
        secretRequestForPending(orgId, {
          kind: "credentials",
          app,
          connection,
          identifier: "ops@example.com",
          action: "enter the Google client secret",
        }),
      ).toEqual({ kind: "google_integration_client", target: {} })
    }
    expect(
      secretRequestForPending(orgId, {
        kind: "oauth",
        app: "mail",
        connection: "gmail",
        action: "connect",
      }),
    ).toBeNull()
  })

  it("walk N38: an unknown connection name is refused before any gate, naming the real ones", async () => {
    const def = toolRegistry.get([orgId, "kernel", "request_secret"])
    expect(def?.refuseBeforeGate).toBe(refuseRequestSecretBeforeGate)
    const refusal = await refuseRequestSecretBeforeGate(
      { kind: "oauth_connect", target: { app: "mail", connection: "shopify", mode: "org" } },
      { orgId, userId, scopes: ["*"] },
    )
    expect(refusal?.error.code).toBe("invalid_target")
    expect(refusal?.error.message).toContain('declares no connection "shopify"')
    expect(refusal?.error.message).toContain('app "mail", connection "gmail"')
    // A valid request goes on to the card.
    expect(
      await refuseRequestSecretBeforeGate(
        { kind: "google_integration_client", target: {} },
        { orgId, userId, scopes: ["*"] },
      ),
    ).toBeNull()
  })

  it("walk N38: a Shopify Connect card with no Shopify client sends the agent to shopify_app_toml first", async () => {
    const before = connectionConfigRegistry.get([orgId, "shopify", "shop"])
    connectionConfigRegistry.set(
      [orgId, "shopify", "shop"],
      shopifyManifest.connections.shop as never,
    )
    try {
      const params = {
        kind: "oauth_connect",
        target: { app: "shopify", connection: "shop", mode: "org" },
      }
      const refusal = await refuseRequestSecretBeforeGate(params, {
        orgId,
        userId,
        scopes: ["*"],
      })
      expect(refusal?.error.code).toBe("setup_step_first")
      expect(refusal?.error.retryable).toBe(false)
      expect(refusal?.error.message).toContain("call kernel__shopify_app_toml first")
      // The turn's own call answers the same, and files no card.
      const res = await tool()(params)
      expect(String(res.error)).toContain("kernel__shopify_app_toml")
      // The client card itself (the step after the app file) is still filed.
      expect(
        await refuseRequestSecretBeforeGate(
          { kind: "oauth_client", target: { app: "shopify", connection: "shop" } },
          { orgId, userId, scopes: ["*"] },
        ),
      ).toBeNull()
    } finally {
      if (before) connectionConfigRegistry.set([orgId, "shopify", "shop"], before)
      else connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    }
  })

  it("needs a conversation to show the card in, and is never offered to an MCP client", async () => {
    const res = await withRlsContext(
      { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
      (db) =>
        handleRequestSecret(
          { kind: "google_integration_client", target: {} },
          { userId, orgId, db, agentExecutionThreadId: undefined },
        ),
    )
    expect("error" in res ? res.error.message : "").toContain("conversation")
    expect(
      toolRegistry.get([orgId, "kernel", "request_secret"])?.requiresAgentExecutionThread,
    ).toBe(true)
  })
})

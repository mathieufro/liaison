// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { onConnectionDisconnected, onConnectionEstablished } from "./connection"
import { createMockDb } from "./test-db"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

interface FetchCall {
  url: string
  method: string
  body?: string
}

function makeCtx(opts: {
  configSecret?: string | null
  tokenStatus?: number
  subStatus?: number
}) {
  const db = createMockDb()
  const calls: FetchCall[] = []
  // Emulates the host's ctx.fetch: the bearer exchange (whose failure answers the
  // call with the token endpoint's status) and the configSecrets write-in.
  const fetch = async (
    url: string,
    o?: {
      method?: string
      body?: string
      auth?: { exchange?: unknown }
      configSecrets?: Record<string, string>
    },
  ) => {
    const method = o?.method ?? "GET"
    if (o?.auth?.exchange && (opts.tokenStatus ?? 200) !== 200) {
      return { status: opts.tokenStatus!, headers: {}, body: "bad" }
    }
    let body = o?.body
    for (const placeholder of Object.keys(o?.configSecrets ?? {})) {
      body = body?.split(placeholder).join(String(opts.configSecret === undefined ? "whsecret" : opts.configSecret))
    }
    calls.push({ url, method, body })
    if (url.includes("/subscription")) {
      const status = opts.subStatus ?? 200
      return {
        status,
        headers: {},
        body: status < 400 ? JSON.stringify({ status: 200, timestamp: "t", content: { id: `sub-${calls.length}` } }) : "err",
      }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
    config: { get: async (_k: string) => (opts.configSecret === undefined ? "whsecret" : opts.configSecret), has: async (_k: string) => Boolean(opts.configSecret === undefined ? "whsecret" : opts.configSecret) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as any
  return { ctx, db, calls }
}

const event = (over?: Record<string, unknown>) => ({
  app: "kernel" as const,
  entity: "connected_account" as const,
  action: "create" as const,
  orgId: "org-1",
  data: {
    id: "acc-1",
    appName: "boxtal",
    connectionName: "boxtal",
    identifier: "boxtal-acct",
    kernelPublicBaseUrl: "https://kernel.example.com",
    ...over,
  },
})

describe("onConnectionEstablished", () => {
  it("validates creds, reads the kernel-minted secret, registers two subscriptions, persists active", async () => {
    const { ctx, db, calls } = makeCtx({})
    await onConnectionEstablished(event() as any, ctx)
    // two subscription POSTs (tracking-changed + document-created)
    const subPosts = calls.filter((c) => c.url.includes("/subscription") && c.method === "POST")
    expect(subPosts).toHaveLength(2)
    // both carry the kernel-minted secret and a /webhooks/ callback (no /api)
    for (const p of subPosts) {
      const body = JSON.parse(p.body!)
      expect(body.webhookSecret).toBe("whsecret")
      expect(body.callbackUrl.startsWith("https://kernel.example.com/webhooks/org-1/boxtal/")).toBe(true)
      expect(body.callbackUrl.includes("/api/")).toBe(false)
    }
    const urls = subPosts.map((p) => JSON.parse(p.body!).callbackUrl)
    expect(urls.some((u) => u.endsWith("/tracking-changed"))).toBe(true)
    expect(urls.some((u) => u.endsWith("/document-created"))).toBe(true)
    // subscription rows + webhook_status active persisted
    expect(db.__all("subscription")).toHaveLength(2)
    const cfg = db.__all("app_config").find((r) => r.key === "webhook_status")
    expect(cfg!.value).toBe("active")
  })

  it("token 401 rejects with a credentials-invalid message; no subscriptions", async () => {
    const { ctx, calls } = makeCtx({ tokenStatus: 401 })
    await expect(onConnectionEstablished(event() as any, ctx)).rejects.toThrow(
      "Boxtal credentials invalid for sandbox",
    )
    expect(calls.some((c) => c.url.includes("/subscription"))).toBe(false)
  })

  it("no kernelPublicBaseUrl → degrades (no subscription POST, webhook_status degraded)", async () => {
    const { ctx, db, calls } = makeCtx({})
    await onConnectionEstablished(event({ kernelPublicBaseUrl: "" }) as any, ctx)
    expect(calls.some((c) => c.url.includes("/subscription"))).toBe(false)
    const cfg = db.__all("app_config").find((r) => r.key === "webhook_status")
    expect(cfg!.value).toBe("degraded")
  })

  it("missing webhook secret (config.get null) → degrades", async () => {
    const { ctx, db, calls } = makeCtx({ configSecret: null })
    await onConnectionEstablished(event() as any, ctx)
    expect(calls.some((c) => c.url.includes("/subscription") && c.method === "POST")).toBe(false)
    const cfg = db.__all("app_config").find((r) => r.key === "webhook_status")
    expect(cfg!.value).toBe("degraded")
  })

  it("subscription create 5xx → connection succeeds but webhook_status degraded", async () => {
    const { ctx, db } = makeCtx({ subStatus: 503 })
    await onConnectionEstablished(event() as any, ctx)
    const cfg = db.__all("app_config").find((r) => r.key === "webhook_status")
    expect(cfg!.value).toBe("degraded")
  })

  it("re-connect is idempotent — subscription rows upsert on event_type", async () => {
    const { ctx, db } = makeCtx({})
    await onConnectionEstablished(event() as any, ctx)
    await onConnectionEstablished(event() as any, ctx)
    // still exactly two subscription rows (one per event_type)
    expect(db.__all("subscription")).toHaveLength(2)
  })
})

describe("onConnectionDisconnected", () => {
  it("DELETEs each subscription and clears rows + webhook_status", async () => {
    const { ctx, db, calls } = makeCtx({})
    await onConnectionEstablished(event() as any, ctx)
    const before = calls.length
    await onConnectionDisconnected(
      { app: "kernel", entity: "connected_account", action: "disconnect", orgId: "org-1", data: { id: "acc-1", appName: "boxtal" } } as any,
      ctx,
    )
    const deletes = calls.slice(before).filter((c) => c.method === "DELETE" && c.url.includes("/subscription"))
    expect(deletes).toHaveLength(2)
    expect(db.__all("subscription")).toHaveLength(0)
    expect(db.__all("app_config").find((r) => r.key === "webhook_status")).toBeUndefined()
  })
})

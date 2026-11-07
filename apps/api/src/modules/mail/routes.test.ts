// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { errorHandler } from "~/middleware/error-handler"
import * as gmailWriteBack from "~/modules/mail/gmail-write-back"
import * as providerSettings from "~/modules/mail/provider-settings"
import { mailRoutes } from "~/modules/mail/routes"
import * as mailService from "~/modules/mail/service"

// Eager snapshot of the real service. `mailService` is a LIVE namespace view
// that mock.module patches IN PLACE, so every factory below that spread it was
// spreading whatever the PREVIOUS case had installed: the stubs accumulated
// across this file and rode out of it into every later file in the process.
const realMailService = { ...mailService }
const realGmailWriteBack = { ...gmailWriteBack }

const PUBLIC_IMAGE_URL = "https://93.184.216.34/image.png"

describe("mail routes", () => {
  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    c.set("userId", "test-user")
    c.set("orgId", "test-org")
    c.set("scopes", [
      "mail:accounts:write",
      "mail:accounts:read",
      "mail:conversations:read",
      "mail:conversations:write",
      "mail:*",
    ] as any)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mail", mailRoutes)

  afterEach(() => mock.restore())
  // mock.restore() does NOT undo mock.module: put the real service back so the
  // stubs above cannot outlive this file.
  afterAll(() => {
    mock.module("~/modules/mail/service", () => realMailService)
    mock.module("~/modules/mail/gmail-write-back", () => realGmailWriteBack)
  })

  it("GET /api/mail/conversations returns the service payload", async () => {
    const listConversations = mock(async () => ({ data: [], meta: { nextCursor: null, total: 0 } }))
    mock.module("~/modules/mail/service", () => ({
      ...realMailService,
      listConversations,
    }))
    const res = await app.request("/api/mail/conversations")
    expect(res.status).toBe(200)
    expect(listConversations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        isRead: undefined,
        isStarred: undefined,
      }),
    )
  })

  it("GET /api/mail/conversations?ids= narrows the list projection to the rows an event named", async () => {
    const listConversations = mock(async () => ({ data: [], meta: { nextCursor: null, total: 0 } }))
    mock.module("~/modules/mail/service", () => ({
      ...realMailService,
      listConversations,
    }))
    const a = "11111111-1111-4111-8111-111111111111"
    const b = "22222222-2222-4222-8222-222222222222"
    const res = await app.request(`/api/mail/conversations?ids=${a},${b}`)
    expect(res.status).toBe(200)
    expect(listConversations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: [a, b] }),
    )

    const bad = await app.request("/api/mail/conversations?ids=not-a-uuid")
    expect(bad.status).toBe(400)
  })

  it("GET /api/mail/conversations?category= passes primary|other|all and refuses anything else", async () => {
    const listConversations = mock(async () => ({ data: [], meta: { nextCursor: null, total: 0 } }))
    mock.module("~/modules/mail/service", () => ({
      ...realMailService,
      listConversations,
    }))
    for (const category of ["primary", "other", "all"]) {
      const res = await app.request(`/api/mail/conversations?category=${category}`)
      expect(res.status).toBe(200)
      expect(listConversations).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ category }),
      )
    }
    const bad = await app.request("/api/mail/conversations?category=newsletters")
    expect(bad.status).toBe(400)
  })

  it("POST /api/mail/accounts/:id/sync rejects callers without account scope", async () => {
    const scoped = new Hono<AppEnv>()
    scoped.use("*", async (c, next) => {
      c.set("userId", "test-user")
      c.set("orgId", "test-org")
      c.set("scopes", ["mail:conversations:read"] as any)
      c.set("dimensionGrants", {})
      await next()
    })
    scoped.route("/api/mail", mailRoutes)
    scoped.onError(errorHandler)

    const res = await scoped.request(
      "/api/mail/accounts/00000000-0000-0000-0000-000000000000/sync",
      {
        method: "POST",
      },
    )
    expect(res.status).toBe(403)
  })

  it("GET /api/mail/providers returns provider policy without mailbox data", async () => {
    const spy = spyOn(providerSettings, "listMailProviders").mockResolvedValueOnce([
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: false,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ] as any)

    const res = await app.request("/api/mail/providers")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          id: "gmail",
          label: "Gmail",
          kind: "oauth2",
          enabled: false,
          integrationConfigured: true,
          configurationSource: "org",
          supportedOwnerTypes: ["user", "org"],
        },
      ],
    })
    spy.mockRestore()
  })

  it("PATCH /api/mail/providers/:providerId rejects callers without mail admin scope", async () => {
    const scoped = new Hono<AppEnv>()
    scoped.use("*", async (c, next) => {
      c.set("userId", "test-user")
      c.set("orgId", "test-org")
      c.set("scopes", ["mail:accounts:read"] as any)
      c.set("dimensionGrants", {})
      await next()
    })
    scoped.route("/api/mail", mailRoutes)
    scoped.onError(errorHandler)

    const res = await scoped.request("/api/mail/providers/gmail", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(403)
  })

  it("POST /api/mail/accounts/:id/image-preferences stores the sender-domain preference", async () => {
    const allowSenderImageDomain = mock(async () => ({
      allowedImageSenderDomains: ["example.com"],
    }))
    mock.module("~/modules/mail/service", () => ({ ...realMailService, allowSenderImageDomain }))

    const res = await app.request(
      "/api/mail/accounts/00000000-0000-0000-0000-000000000000/image-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderDomain: "example.com" }),
      },
    )

    expect(res.status).toBe(200)
    expect(allowSenderImageDomain).toHaveBeenCalled()
  })

  it("GET /api/mail/accounts/:id/assignees returns eligible assignees", async () => {
    const listAssignableUsersForAccount = mock(async () => [
      { id: "user-1", name: "User One", avatarUrl: null },
    ])
    mock.module("~/modules/mail/service", () => ({
      ...realMailService,
      listAssignableUsersForAccount,
    }))

    const res = await app.request(
      "/api/mail/accounts/00000000-0000-4000-8000-000000000001/assignees",
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      // `away` is null for someone not away today.
      data: [{ id: "user-1", name: "User One", avatarUrl: null, away: null }],
    })
    expect(listAssignableUsersForAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requesterId: "test-user",
        accountId: "00000000-0000-4000-8000-000000000001",
      }),
    )
  })

  it("GET /api/mail/drafts returns list via mailService.listDrafts", async () => {
    const listDrafts = mock(async () => [])
    mock.module("~/modules/mail/service", () => ({ ...realMailService, listDrafts }))
    const res = await app.request("/api/mail/drafts")
    expect(res.status).toBe(200)
    expect(listDrafts).toHaveBeenCalled()
  })

  it("POST /api/mail/drafts creates a draft", async () => {
    const createDraft = mock(async () => ({
      id: "d1",
      accountId: "acc-1",
      conversationId: null,
      replyToMessageId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      htmlBody: "",
      textBody: "",
      updatedAt: new Date().toISOString(),
    }))
    mock.module("~/modules/mail/service", () => ({ ...realMailService, createDraft }))
    const res = await app.request("/api/mail/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "00000000-0000-4000-8000-000000000001" }),
    })
    expect(res.status).toBe(200)
    expect(createDraft).toHaveBeenCalled()
  })

  // A reply draft that got a file before any text sat in Drafts as
  // "(No recipients) / (No subject)": the create dropped both.
  it("POST /api/mail/drafts hands a reply draft's recipients and subject to the service", async () => {
    const createDraft = mock(async () => ({ id: "d1" }))
    mock.module("~/modules/mail/service", () => ({ ...realMailService, createDraft }))
    const res = await app.request("/api/mail/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "00000000-0000-4000-8000-000000000001",
        conversationId: "00000000-0000-4000-8000-000000000002",
        to: [{ email: "sender@example.com" }],
        cc: [{ email: "copy@example.com" }],
        subject: "Re: Invoice",
      }),
    })
    expect(res.status).toBe(200)
    expect(createDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: [{ email: "sender@example.com" }],
        cc: [{ email: "copy@example.com" }],
        subject: "Re: Invoice",
      }),
    )
  })

  it("PATCH /api/mail/conversations/:id hands the committed change to the Gmail write-back", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000002"
    const updateConversation = mock(async () => ({
      id: conversationId,
      account_id: "00000000-0000-4000-8000-0000000000aa",
      status: "archived",
    }))
    const enqueueGmailWriteBack = mock(async () => true)
    mock.module("~/modules/mail/service", () => ({ ...realMailService, updateConversation }))
    mock.module("~/modules/mail/gmail-write-back", () => ({
      ...realGmailWriteBack,
      enqueueGmailWriteBack,
    }))
    const res = await app.request(`/api/mail/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived", isRead: true }),
    })
    expect(res.status).toBe(200)
    expect(enqueueGmailWriteBack).toHaveBeenCalledWith({
      orgId: "test-org",
      accountId: "00000000-0000-4000-8000-0000000000aa",
      conversationIds: [conversationId],
      changes: { status: "archived", isRead: true },
    })
    // Write-back runs after the update, never instead of it.
    expect(updateConversation).toHaveBeenCalled()
  })

  it("PATCH /api/mail/drafts/:id updates a draft", async () => {
    const updateDraft = mock(async () => ({ id: "d1", subject: "Updated" }))
    mock.module("~/modules/mail/service", () => ({ ...realMailService, updateDraft }))
    const res = await app.request("/api/mail/drafts/00000000-0000-4000-8000-000000000001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Updated" }),
    })
    expect(res.status).toBe(200)
    expect(updateDraft).toHaveBeenCalled()
  })

  it("DELETE /api/mail/drafts/:id deletes a draft", async () => {
    const deleteDraft = mock(async () => {})
    mock.module("~/modules/mail/service", () => ({ ...realMailService, deleteDraft }))
    const res = await app.request("/api/mail/drafts/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
    expect(deleteDraft).toHaveBeenCalled()
  })

  it("POST /api/mail/drafts/:id/send sends a draft", async () => {
    const sendDraft = mock(async () => ({ conversationId: "c1", messageId: "m1" }))
    mock.module("~/modules/mail/service", () => ({ ...realMailService, sendDraft }))
    const res = await app.request("/api/mail/drafts/00000000-0000-4000-8000-000000000001/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ htmlBody: "<p>Hello</p>", textBody: "Hello" }),
    })
    expect(res.status).toBe(200)
    expect(sendDraft).toHaveBeenCalled()
  })

  it("DELETE /api/mail/drafts/:id rejects callers without write scope", async () => {
    const scoped = new Hono<AppEnv>()
    scoped.use("*", async (c, next) => {
      c.set("userId", "test-user")
      c.set("orgId", "test-org")
      c.set("scopes", ["mail:conversations:read"] as any)
      c.set("dimensionGrants", {})
      await next()
    })
    scoped.route("/api/mail", mailRoutes)
    scoped.onError(errorHandler)
    const res = await scoped.request("/api/mail/drafts/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
    })
    expect(res.status).toBe(403)
  })

  it("GET /api/mail/image-proxy rejects non-HTTPS URLs", async () => {
    const res = await app.request(
      `/api/mail/image-proxy?url=${encodeURIComponent("http://93.184.216.34/image.png")}`,
    )
    expect(res.status).toBe(400)
  })

  it("GET /api/mail/image-proxy rejects private IP addresses", async () => {
    const res = await app.request(
      `/api/mail/image-proxy?url=${encodeURIComponent("https://127.0.0.1/image.png")}`,
    )
    expect(res.status).toBe(400)
  })

  it("GET /api/mail/image-proxy rejects non-image responses", async () => {
    const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
    OutboundFetchTestAccess.setFetch(
      mock(
        async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      ) as unknown as typeof fetch,
    )
    try {
      const res = await app.request(
        `/api/mail/image-proxy?url=${encodeURIComponent(PUBLIC_IMAGE_URL)}`,
      )
      expect(res.status).toBe(400)
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
  })

  it("GET /api/mail/image-proxy enforces the 5 MB size cap", async () => {
    const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
    OutboundFetchTestAccess.setFetch(
      mock(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(6 * 1024 * 1024),
            },
          }),
      ) as unknown as typeof fetch,
    )
    try {
      const res = await app.request(
        `/api/mail/image-proxy?url=${encodeURIComponent(PUBLIC_IMAGE_URL)}`,
      )
      expect(res.status).toBe(413)
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
  })

  it("GET /api/mail/image-proxy proxies valid images with the spec TTL", async () => {
    const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
    OutboundFetchTestAccess.setFetch(
      mock(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": "3",
            },
          }),
      ) as unknown as typeof fetch,
    )
    try {
      const res = await app.request(
        `/api/mail/image-proxy?url=${encodeURIComponent(PUBLIC_IMAGE_URL)}`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600")
      expect(res.headers.get("Content-Type")).toBe("image/png")
      expect(res.headers.get("Content-Length")).toBe("3")
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
  })
})

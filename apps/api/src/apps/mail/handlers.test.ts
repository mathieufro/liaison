// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { simpleParser } from "mailparser"
import { normalizeGmailMessage } from "~/apps/mail/handlers"
import { mailPageRunner } from "~/apps/mail/test-page-write-bridge"

const runMail = mailPageRunner({
  __test_normalizeGmailMessage: (params) => normalizeGmailMessage(params.message),
})

describe("mail handler helpers", () => {
  function base64UrlUtf8(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url")
  }

  it("normalizes multipart Gmail payloads and threading metadata", async () => {
    const result = (await runMail({
      exportName: "__test_normalizeGmailMessage",
      params: {
        message: {
          id: "gmail-1",
          threadId: "thread-1",
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            headers: [
              { name: "From", value: '"Alice" <alice@example.com>' },
              { name: "To", value: '"Bob" <bob@example.com>' },
              { name: "Cc", value: "copy@example.com" },
              { name: "Subject", value: "Hello" },
              { name: "Date", value: "Mon, 15 Jan 2026 10:00:00 +0000" },
              { name: "Message-ID", value: "<gmail-1@example.com>" },
              { name: "In-Reply-To", value: "<parent@example.com>" },
              { name: "References", value: "<root@example.com> <parent@example.com>" },
            ],
            parts: [
              { mimeType: "text/plain", body: { data: btoa("Plain text body") } },
              { mimeType: "text/html", body: { data: btoa("<p>HTML body</p>") } },
            ],
          },
          internalDate: "1737018000000",
        },
      },
      bridge: {},
    })) as any

    expect(result.externalMessageId).toBe("<gmail-1@example.com>")
    expect(result.from).toEqual({ name: "Alice", email: "alice@example.com" })
    expect(result.to).toEqual([{ name: "Bob", email: "bob@example.com" }])
    expect(result.cc).toEqual([{ email: "copy@example.com" }])
    expect(result.textBody).toBe("Plain text body")
    expect(result.htmlBody).toBe("<p>HTML body</p>")
    expect(result.isRead).toBe(false)
    expect(result.direction).toBe("inbound")
    expect(result.references).toEqual(["<root@example.com>", "<parent@example.com>"])
  })

  it("falls back when Gmail headers are missing and truncates snippets", async () => {
    const longSnippet = "A".repeat(250)
    const result = (await runMail({
      exportName: "__test_normalizeGmailMessage",
      params: {
        message: {
          id: "gmail-2",
          threadId: "thread-2",
          labelIds: ["SENT"],
          payload: {
            headers: [],
            parts: [{ mimeType: "text/plain", body: { data: btoa(longSnippet) } }],
          },
          internalDate: "1737018000000",
        },
      },
      bridge: {},
    })) as any

    expect(result.externalMessageId).toBe("<gmail-2@mail.gmail.com>")
    expect(result.direction).toBe("outbound")
    expect(result.isRead).toBe(true)
    expect(result.sentAt).toBeTruthy()
    expect(result.snippet).toHaveLength(200)
  })

  it("decodes Gmail body bytes as UTF-8 instead of mojibake", async () => {
    const result = (await runMail({
      exportName: "__test_normalizeGmailMessage",
      params: {
        message: {
          id: "gmail-unicode",
          threadId: "thread-unicode",
          labelIds: ["INBOX"],
          payload: {
            headers: [],
            parts: [
              {
                mimeType: "text/html",
                headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
                body: { data: base64UrlUtf8("<p>Vérifiez et répondre</p>") },
              },
            ],
          },
        },
      },
      bridge: {},
    })) as any

    expect(result.htmlBody).toBe("<p>Vérifiez et répondre</p>")
    expect(result.htmlBody).not.toContain("VÃ")
  })
})

describe("mail send handlers", () => {
  function makeBridge(overrides: Record<string, any> = {}) {
    return {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findMany: async () => "[]",
      db_findOne: async () => "null",
      db_insert: async () => '{"id":"x"}',
      db_update: async () => {},
      db_updateMany: async () => '{"count":0}',
      db_delete: async () => {},
      db_count: async () => "0",
      kernel_findOne: async () => "null",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "gmail-token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => '{"id":"contact-1"}',
      fetch: async () =>
        JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "gmail-msg-1", threadId: "thread-1" }),
        }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<smtp-msg-1@example.com>" }),
      hasOnlineUsers: async () => "true",
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      ...overrides,
    }
  }

  it("sendReply builds a threaded Gmail raw message", async () => {
    const requests: any[] = []
    const bridge = makeBridge({
      fetch: async (_url: string, optsJson: string) => {
        requests.push(JSON.parse(optsJson))
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "gmail-msg-1", threadId: "thread-1" }),
        })
      },
    })

    const result = (await runMail({
      exportName: "sendReply",
      params: {
        provider: "gmail",
        accountEmail: "sender@example.com",
        externalThreadId: "thread-1",
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Re: Hello",
        htmlBody: "<p>Reply</p>",
        textBody: "Reply",
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>"],
      },
      bridge,
    })) as any

    const requestBody = JSON.parse(requests[0].body)
    const decodedRaw = Buffer.from(requestBody.raw, "base64url").toString("utf8")

    expect(result).toEqual({ messageId: "gmail-msg-1", externalThreadId: "thread-1" })
    expect(requestBody.threadId).toBe("thread-1")
    expect(decodedRaw).toContain("Subject: Re: Hello")
    expect(decodedRaw).toContain("In-Reply-To: <parent@example.com>")
    expect(decodedRaw).toContain("References: <root@example.com> <parent@example.com>")
    expect(decodedRaw).toContain("To: recipient@example.com")
    expect(decodedRaw).toContain("Cc: copy@example.com")
    expect(decodedRaw).toContain("Bcc: hidden@example.com")
    expect(decodedRaw).not.toMatch(/^X-Liaison/im)
    expect(decodedRaw).not.toContain("user-1")
  })

  it("sendCompose builds a Gmail raw message", async () => {
    const requests: any[] = []
    const bridge = makeBridge({
      fetch: async (_url: string, optsJson: string) => {
        requests.push(JSON.parse(optsJson))
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "gmail-msg-2", threadId: "thread-2" }),
        })
      },
    })

    const result = (await runMail({
      exportName: "sendCompose",
      params: {
        provider: "gmail",
        accountEmail: "sender@example.com",
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Compose",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      },
      bridge,
    })) as any

    const requestBody = JSON.parse(requests[0].body)
    const decodedRaw = Buffer.from(requestBody.raw, "base64url").toString("utf8")

    expect(result).toEqual({ messageId: "gmail-msg-2", externalThreadId: "thread-2" })
    expect(decodedRaw).toContain("Subject: Compose")
    expect(decodedRaw).toContain("To: recipient@example.com")
    expect(decodedRaw).toContain("Cc: copy@example.com")
  })

  // Regression: a non-ASCII subject went out as raw 8-bit header bytes and was
  // read as Latin-1 downstream ("accès" arrived as "accÃ¨s").
  it("sendCompose RFC 2047-encodes a non-ASCII subject and display name", async () => {
    const requests: any[] = []
    const bridge = makeBridge({
      fetch: async (_url: string, optsJson: string) => {
        requests.push(JSON.parse(optsJson))
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "gmail-msg-3", threadId: "thread-3" }),
        })
      },
    })
    const subject = "Liaison : accès aux stats Instagram de @shop"
    await runMail({
      exportName: "sendCompose",
      params: {
        provider: "gmail",
        accountEmail: "sender@example.com",
        to: [{ name: "Zoë Dupré", email: "zoe@example.com" }],
        subject,
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      },
      bridge,
    })
    const raw = Buffer.from(JSON.parse(requests[0].body).raw, "base64url").toString("utf8")
    const headerBlock = raw.slice(0, raw.indexOf("\r\n\r\n"))
    expect(headerBlock).toMatch(/^[\x20-\x7e\r\n]+$/)
    expect(headerBlock).toContain("Subject: =?UTF-8?B?")
    const parsed = await simpleParser(raw)
    expect(parsed.subject).toBe(subject)
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to
    expect(to?.value[0]).toEqual({ name: "Zoë Dupré", address: "zoe@example.com" })
  })

  // Regression (Fabrikam, 2026-10-01): the compose tool accepts {name,email}
  // recipients; they reached the To header as "[object Object]" and Gmail
  // rejected every such send with 400 "Invalid To header".
  it("sendCompose formats {name,email} recipients into valid Gmail headers", async () => {
    const requests: any[] = []
    const bridge = makeBridge({
      fetch: async (_url: string, optsJson: string) => {
        requests.push(JSON.parse(optsJson))
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "gmail-msg-3", threadId: "thread-3" }),
        })
      },
    })

    await runMail({
      exportName: "sendCompose",
      params: {
        provider: "gmail",
        accountEmail: "sender@example.com",
        to: [{ name: "Pierre Martin", email: "pierre@example.com" }],
        cc: [{ email: "copy@example.com" }, "plain@example.com"],
        subject: "Compose",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      },
      bridge,
    })

    const decodedRaw = Buffer.from(JSON.parse(requests[0].body).raw, "base64url").toString("utf8")
    expect(decodedRaw).toContain("To: Pierre Martin <pierre@example.com>")
    expect(decodedRaw).toContain("Cc: copy@example.com, plain@example.com")
    expect(decodedRaw).not.toContain("[object Object]")
  })

  it("sendReply forwards threaded SMTP parameters for IMAP accounts", async () => {
    const smtpCalls: any[] = []
    const bridge = makeBridge({
      smtp_send: async (_connection: string, _identifier: string, messageJson: string) => {
        smtpCalls.push(JSON.parse(messageJson))
        return JSON.stringify({ messageId: "<smtp-msg-1@example.com>" })
      },
    })

    const result = (await runMail({
      exportName: "sendReply",
      params: {
        provider: "imap",
        accountEmail: "sender@example.com",
        externalThreadId: "thread-1",
        to: ["recipient@example.com"],
        subject: "Re: Hello",
        htmlBody: "<p>Reply</p>",
        textBody: "Reply",
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>"],
      },
      bridge,
    })) as any

    expect(result).toEqual({ messageId: "<smtp-msg-1@example.com>", externalThreadId: "thread-1" })
    expect(smtpCalls[0].references).toEqual(["<root@example.com>", "<parent@example.com>"])
    expect(smtpCalls[0].inReplyTo).toBe("<parent@example.com>")
    expect(smtpCalls[0].headers ?? {}).toEqual({})
  })

  it("sendCompose forwards SMTP parameters for IMAP accounts", async () => {
    const smtpCalls: any[] = []
    const bridge = makeBridge({
      smtp_send: async (_connection: string, _identifier: string, messageJson: string) => {
        smtpCalls.push(JSON.parse(messageJson))
        return JSON.stringify({ messageId: "<smtp-msg-2@example.com>" })
      },
    })

    const result = (await runMail({
      exportName: "sendCompose",
      params: {
        provider: "imap",
        accountEmail: "sender@example.com",
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Compose",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      },
      bridge,
    })) as any

    expect(result).toEqual({
      messageId: "<smtp-msg-2@example.com>",
      externalThreadId: "<smtp-msg-2@example.com>",
    })
    expect(smtpCalls[0].to).toEqual(["recipient@example.com"])
    expect(smtpCalls[0].cc).toEqual(["copy@example.com"])
    expect(smtpCalls[0].bcc).toEqual(["hidden@example.com"])
  })

  it("onAccountDisconnected deletes the mailbox's imported content, then marks it disconnected", async () => {
    const calls: string[] = []
    const bridge = makeBridge({
      db_findMany: async () =>
        JSON.stringify([{ id: "acct-1", connected_account_id: "ca-1", provider: "gmail" }]),
      mail_purgeDisconnectedAccount: async (accountId: string) => {
        calls.push(`purge:${accountId}`)
        return JSON.stringify({ kept: false, conversations: 1, messages: 2, drafts: 0, files: 1 })
      },
      db_update: async (_entity: string, id: string, dataJson: string) => {
        calls.push(`update:${id}:${JSON.parse(dataJson).syncStatus}`)
      },
    })
    await runMail({
      exportName: "onAccountDisconnected",
      params: { data: { id: "ca-1", appName: "mail", identifier: "box@example.com" } },
      bridge,
    })
    expect(calls).toEqual(["purge:acct-1", "update:acct-1:disconnected"])
  })

  it("onAccountDisconnected leaves a mailbox reconnected meanwhile alone", async () => {
    const calls: string[] = []
    const bridge = makeBridge({
      db_findMany: async () =>
        JSON.stringify([{ id: "acct-1", connected_account_id: "ca-1", provider: "gmail" }]),
      mail_purgeDisconnectedAccount: async () => JSON.stringify({ kept: true }),
      db_update: async (_entity: string, id: string) => {
        calls.push(`update:${id}`)
      },
    })
    await runMail({
      exportName: "onAccountDisconnected",
      params: { data: { id: "ca-1", appName: "mail", identifier: "box@example.com" } },
      bridge,
    })
    expect(calls).toEqual([])
  })
})

describe("mail agent handlers", () => {
  function makeAgentBridge(overrides: Record<string, any> = {}) {
    const calls: any = { db_findMany: [], db_findOne: [], kernel_findOne: [] }
    const accounts: Record<string, any> = {
      "account-1": { id: "account-1", email_address: "support@acme.com" },
    }
    const conversations: Record<string, any> = {
      "conv-1": {
        id: "conv-1",
        account_id: "account-1",
        subject: "Pricing",
        snippet: "Hello",
        contact_id: "contact-1",
        assigned_to: "user-1",
        status: "open",
        is_read: false,
        is_starred: false,
        last_message_at: "2026-01-01T00:00:00Z",
        message_count: 2,
        from_address: { name: "Hans", email: "hans@example.com" },
      },
    }
    const messages: Record<string, any> = {
      "msg-1": {
        id: "msg-1",
        conversation_id: "conv-1",
        from_address: { name: "Hans", email: "hans@example.com" },
        to_addresses: [{ email: "support@acme.com" }],
        sent_at: "2026-01-01T00:00:00Z",
        direction: "inbound",
        sent_by_user_id: null,
        snippet: "Inbound snippet",
        text_body: "Inbound body",
        html_body: "<p>Inbound body</p>",
      },
      "msg-2": {
        id: "msg-2",
        conversation_id: "conv-1",
        from_address: { email: "support@acme.com" },
        to_addresses: [{ email: "hans@example.com" }],
        sent_at: "2026-01-01T00:01:00Z",
        direction: "outbound",
        sent_by_user_id: "user-1",
        snippet: "Outbound snippet",
        text_body: "x".repeat(5000),
        html_body: "<p>Outbound body</p>",
      },
    }
    const bridge = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        calls.db_findMany.push({ entity, opts })
        if (entity === "conversations") {
          const rows = Object.values(conversations).filter((conversation) => {
            const query = opts.search?.query?.toLowerCase()
            if (!query) return true
            return `${conversation.subject ?? ""} ${conversation.snippet ?? ""}`
              .toLowerCase()
              .includes(query)
          })
          return JSON.stringify(rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit))
        }
        if (entity === "messages") {
          const rows = Object.values(messages).filter(
            (msg) => msg.conversation_id === opts.where?.conversationId,
          )
          if (opts.orderBy?.sentAt === "desc") return JSON.stringify(rows.reverse())
          return JSON.stringify(rows)
        }
        return "[]"
      },
      db_findOne: async (entity: string, id: string) => {
        calls.db_findOne.push({ entity, id })
        const byEntity: Record<string, Record<string, any>> = { accounts, conversations, messages }
        return JSON.stringify(byEntity[entity]?.[id] ?? null)
      },
      db_count: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity !== "conversations") return "0"
        const query = opts.search?.query?.toLowerCase()
        const count = Object.values(conversations).filter((conversation) => {
          if (!query) return true
          return `${conversation.subject ?? ""} ${conversation.snippet ?? ""}`
            .toLowerCase()
            .includes(query)
        }).length
        return String(count)
      },
      kernel_findOne: async (entity: string, id: string) => {
        calls.kernel_findOne.push({ entity, id })
        if (entity === "contacts")
          return JSON.stringify({ id, name: "Hans Weber", email: "hans@example.com" })
        if (entity === "users") return JSON.stringify({ id, name: "Alice Agent" })
        return "null"
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      _calls: calls,
      ...overrides,
    }
    return bridge
  }

  // agentMailSearch is a thin wrapper around the host-bridge `mail_search` RPC
  // (apps/mail/search.ts): it validates since/until, forwards the params, and
  // maps the returned rows to the documented projection. Scan/paging/filter
  // semantics live host-side and are covered by search.test.ts + the e2e
  // mail-filters-analytics.scenario.test.ts C-module.
  function makeSearchRpcBridge(overrides: Record<string, any> = {}) {
    const calls: any = { mail_search: [] }
    const bridge = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      mail_search: async (paramsJson: string) => {
        calls.mail_search.push(JSON.parse(paramsJson))
        return JSON.stringify({
          items: [
            {
              id: "conv-1",
              subject: "Pricing",
              snippet: "Hello",
              from_email: "hans@example.com",
              from_address: { name: "Hans", email: "hans@example.com" },
              account_email: "support@acme.com",
              contact_id: "contact-1",
              assigned_to: "user-1",
              status: "open",
              is_read: false,
              is_starred: false,
              last_message_at: "2026-01-01T00:00:00Z",
              message_count: 2,
            },
          ],
          totalCount: 1,
          nextOffset: null,
        })
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      _calls: calls,
      ...overrides,
    }
    return bridge
  }

  const runSearch = async (params: Record<string, unknown>, bridge: any) =>
    (await runMail({
      exportName: "agentMailSearch",
      params,
      bridge,
    })) as any

  it("listAccounts says why an account is in error and when it is tried again", async () => {
    const bridge = makeAgentBridge({
      db_findMany: async (entity: string) =>
        entity === "accounts"
          ? JSON.stringify([
              {
                id: "account-1",
                connected_account_id: "ca-1",
                owner_type: "org",
                provider: "imap",
                email_address: "support@acme.com",
                display_name: "Support",
                sync_status: "error",
                sync_state: { failedAttempts: 1, nextRetryAt: "2026-10-26T19:32:00.000Z" },
                last_sync_at: null,
                last_sync_error: "getaddrinfo ENOTFOUND imap.acme.invalid",
              },
            ])
          : "[]",
      connections_getAccounts: async () => "[]",
    })
    const listed = (await runMail({
      exportName: "listAccounts",
      params: {},
      bridge,
    })) as { accounts: Array<Record<string, unknown>>; note: string }
    expect(listed.accounts[0]).toMatchObject({
      syncStatus: "error",
      lastSyncError: "getaddrinfo ENOTFOUND imap.acme.invalid",
      nextRetryAt: "2026-10-26T19:32:00.000Z",
    })
  })

  it("listAccounts says an empty list is what this person can use, not the organization's", async () => {
    // "No mailbox is connected to the organisation at all", to a person whose org had five.
    const bridge = makeAgentBridge({
      db_findMany: async () => "[]",
      connections_getAccounts: async () => "[]",
    })
    const listed = (await runMail({
      exportName: "listAccounts",
      params: {},
      bridge,
    })) as { accounts: unknown[]; note: string }
    expect(listed.accounts).toEqual([])
    expect(listed.note).toContain("the organization may have others")
  })

  it("agentMailSearch returns conversations with documented projection", async () => {
    const bridge = makeSearchRpcBridge()

    const result = (await runMail({
      exportName: "agentMailSearch",
      params: { query: "Pricing", limit: 20 },
      bridge,
    })) as any

    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe("conv-1")
    expect(result.items[0].accountEmail).toBe("support@acme.com")
    expect(result.items[0].fromEmail).toBe("hans@example.com")
    expect(result.totalCount).toBe(1)
    expect(result.nextCursor).toBeUndefined()
  })

  it("agentMailSearch caps limit at 50", async () => {
    const bridge = makeSearchRpcBridge()

    await runMail({
      exportName: "agentMailSearch",
      params: { limit: 200 },
      bridge,
    })

    expect(bridge._calls.mail_search[0].limit).toBe(50)
  })

  it("agentMailSearch passes query/from/since/until/body/cursor through to mail_search", async () => {
    const bridge = makeSearchRpcBridge()

    await runMail({
      exportName: "agentMailSearch",
      params: {
        query: "Pricing",
        from: "hans@example.com",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        body: "invoice",
        cursor: "20",
        limit: 10,
      },
      bridge,
    })

    expect(bridge._calls.mail_search[0]).toMatchObject({
      query: "Pricing",
      from: "hans@example.com",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
      body: "invoice",
      offset: 20,
      limit: 10,
    })
  })

  it("agentMailSearch defaults to Primary on personal Gmail mailboxes only when category is absent", async () => {
    const bridge = makeSearchRpcBridge()
    await runSearch({ from: "hans@example.com" }, bridge)
    expect(bridge._calls.mail_search[0]).toMatchObject({
      category: "primary",
      categoryScope: "personal-gmail",
    })
  })

  it("agentMailSearch passes an explicit category through, applied to every mailbox", async () => {
    for (const category of ["all", "other", "primary"]) {
      const bridge = makeSearchRpcBridge()
      await runSearch({ category }, bridge)
      expect(bridge._calls.mail_search[0].category).toBe(category)
      expect(bridge._calls.mail_search[0].categoryScope).toBeUndefined()
    }
  })

  it("agentMailSearch returns the raw error envelope from mail_search verbatim", async () => {
    const bridge = makeSearchRpcBridge({
      mail_search: async () =>
        JSON.stringify({ error: { code: "SEARCH_UNAVAILABLE", message: "index down" } }),
    })

    const result = await runSearch({ query: "Pricing" }, bridge)

    expect(result).toEqual({ error: { code: "SEARCH_UNAVAILABLE", message: "index down" } })
  })

  it("agentMailSearch rejects an invalid `since` without calling mail_search", async () => {
    const bridge = makeSearchRpcBridge()

    const result = await runSearch({ since: "not-a-date" }, bridge)

    expect(result.error?.code).toBe("invalid_params")
    expect(bridge._calls.mail_search).toHaveLength(0)
  })

  it("agentMailRead returns conversation and snippets by default", async () => {
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1" },
      bridge: makeAgentBridge(),
    })) as any

    expect(result.conversation.contact).toEqual({
      id: "contact-1",
      name: "Hans Weber",
      email: "hans@example.com",
    })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].sentByUser).toEqual({ id: "user-1", name: "Alice Agent" })
    expect(result.messages[0].textBody).toBeUndefined()
    expect(Object.keys(result.messages[0]).filter((key) => /html/i.test(key))).toEqual([])
    // With no files_listAttachments bridge, every message degrades to an empty
    // attachments array (never undefined) so the agent can reason over it.
    expect(result.messages[0].attachments).toEqual([])
    expect(result.messages[1].attachments).toEqual([])
  })

  it("agentMailRead surfaces a message's attachment file ids (find+pull the PDF)", async () => {
    const listAttachmentsCalls: Array<{ app: string; entityType: string; entityId: string }> = []
    const bridge = makeAgentBridge({
      files_listAttachments: async (parentJson: string) => {
        const p = JSON.parse(parentJson)
        listAttachmentsCalls.push(p)
        // Only msg-1 (the inbound carrier invoice) carries a PDF attachment.
        if (p.entityId === "msg-1") {
          return JSON.stringify([
            {
              id: "file-boxtal-pdf",
              filename: "Facture-Boxtal-Mai-2026.pdf",
              mimeType: "application/pdf",
              sizeBytes: 84213,
              disposition: "attachment",
              contentId: null,
              ordinal: 0,
            },
          ])
        }
        return "[]"
      },
    })

    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1" },
      bridge,
    })) as any

    // The handler asks the kernel files store for each message's attachments
    // under the (mail, message, <id>) parent — no guessing required by the agent.
    expect(listAttachmentsCalls).toContainEqual({
      app: "mail",
      entityType: "message",
      entityId: "msg-1",
    })
    const inbound = result.messages.find((m: any) => m.id === "msg-1")
    // Media-analysis (commit 7f1d7451) surfaces each attachment's analysisStatus/analysisSummary
    // inline on mail:read so the agent sees a diagnostic summary without a separate fetch. The bridge
    // here returns rows WITHOUT analysis fields (un-analyzed PDF), so the handler defaults both to null.
    expect(inbound.attachments).toEqual([
      {
        id: "file-boxtal-pdf",
        filename: "Facture-Boxtal-Mai-2026.pdf",
        mimeType: "application/pdf",
        sizeBytes: 84213,
        disposition: "attachment",
        contentId: null,
        analysisStatus: null,
        analysisSummary: null,
      },
    ])
    const outbound = result.messages.find((m: any) => m.id === "msg-2")
    expect(outbound.attachments).toEqual([])
  })

  it("agentMailRead returns truncated text bodies when requested", async () => {
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1", includeBody: true },
      bridge: makeAgentBridge(),
    })) as any

    expect(result.messages[1].textBody).toHaveLength(4000)
    expect(result.messages[1].bodyTruncated).toBe(true)
    expect(Object.keys(result.messages[1]).filter((key) => /html/i.test(key))).toEqual([])
  })

  it("agentMailRead fences inbound message body + snippet as untrusted, leaves outbound unwrapped (taint defense)", async () => {
    const FENCE_OPEN = '<external-content source="untrusted">'
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1", includeBody: true },
      bridge: makeAgentBridge(),
    })) as any

    // messages[0] = msg-1 (inbound, customer-authored) → fenced.
    expect(result.messages[0].direction).toBe("inbound")
    expect(result.messages[0].snippet).toContain(FENCE_OPEN)
    expect(result.messages[0].snippet).toContain("Inbound snippet")
    expect(result.messages[0].textBody).toContain(FENCE_OPEN)
    expect(result.messages[0].textBody).toContain("Inbound body")
    // messages[1] = msg-2 (outbound, our own reply) → NOT fenced.
    expect(result.messages[1].direction).toBe("outbound")
    expect(result.messages[1].snippet).not.toContain(FENCE_OPEN)
    expect(result.messages[1].textBody).not.toContain(FENCE_OPEN)
  })

  it("agentMailSearch fences the conversation snippet as untrusted external content", async () => {
    const FENCE_OPEN = '<external-content source="untrusted">'
    const result = (await runMail({
      exportName: "agentMailSearch",
      params: { query: "Pricing", limit: 20 },
      bridge: makeSearchRpcBridge(),
    })) as any
    expect(result.items[0].snippet).toContain(FENCE_OPEN)
    expect(result.items[0].snippet).toContain("Hello")
    // Routing metadata stays unwrapped.
    expect(result.items[0].fromEmail).toBe("hans@example.com")
    expect(result.items[0].subject).toBe("Pricing")
  })

  it("agentMailRead returns one message with a larger cap", async () => {
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1", messageId: "msg-2" },
      bridge: makeAgentBridge(),
    })) as any

    expect(result.conversation.contact).toEqual({
      id: "contact-1",
      name: "Hans Weber",
      email: "hans@example.com",
    })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe("msg-2")
    expect(result.messages[0].textBody).toHaveLength(5000)
    expect(result.messages[0].attachments).toEqual([])
    expect(Object.keys(result.messages[0]).filter((key) => /html/i.test(key))).toEqual([])
  })

  it("agentMailRead lists the reply drafts waiting on this conversation, oldest first", async () => {
    const pendingForCalls: Array<[string, string | undefined]> = []
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1" },
      bridge: makeAgentBridge({
        approvals_pendingFor: async (key: string, toolNamesJson?: string) => {
          pendingForCalls.push([key, toolNamesJson])
          // Newest first, as the bridge returns them; one row is another conversation's.
          return JSON.stringify([
            {
              id: "appr-2",
              tool_name: "mail:reply",
              target_id: "conv-1",
              payload: { conversationId: "conv-1", textBody: "Second", cc: ["c@x.test"] },
              created_at: "2026-10-20T10:00:00.000Z",
            },
            {
              id: "appr-other",
              tool_name: "mail:reply",
              target_id: "conv-2",
              payload: { conversationId: "conv-2", textBody: "Elsewhere" },
              created_at: "2026-10-20T09:30:00.000Z",
            },
            {
              id: "appr-1",
              tool_name: "mail:reply",
              target_id: "conv-1",
              payload: { conversationId: "conv-1", textBody: "First", to: ["hans@example.com"] },
              created_at: "2026-10-20T09:00:00.000Z",
            },
          ])
        },
      }),
    })) as any

    expect(pendingForCalls).toEqual([["conversationId", JSON.stringify(["mail:reply"])]])
    expect(result.pendingReplyDrafts).toEqual([
      {
        approvalId: "appr-1",
        textBody: "First",
        to: ["hans@example.com"],
        cc: null,
        createdAt: "2026-10-20T09:00:00.000Z",
      },
      {
        approvalId: "appr-2",
        textBody: "Second",
        to: null,
        cc: ["c@x.test"],
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    ])
  })

  it("agentMailRead returns an empty pendingReplyDrafts when none is waiting", async () => {
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "conv-1" },
      bridge: makeAgentBridge({ approvals_pendingFor: async () => "[]" }),
    })) as any
    expect(result.pendingReplyDrafts).toEqual([])
  })

  it("agentMailRead returns NOT_FOUND for missing conversations", async () => {
    const result = (await runMail({
      exportName: "agentMailRead",
      params: { conversationId: "missing" },
      bridge: makeAgentBridge(),
    })) as any

    expect(result.error).toEqual({
      code: "NOT_FOUND",
      message: "Conversation not found or inaccessible",
    })
  })

  it("agentMailReply persists sent mail into the conversation after SMTP succeeds", async () => {
    const calls: any = { inserted: [], updated: [], emitted: [], approval: [] }
    const account = {
      id: "account-1",
      owner_type: "org",
      owner_id: null,
      provider: "imap",
      email_address: "support@acme.com",
    }
    const conversation = {
      id: "conv-1",
      account_id: "account-1",
      owner_type: "org",
      owner_id: null,
      external_thread_id: "thread-1",
      subject: "Pricing",
      snippet: "Inbound body",
      labels: ["INBOX"],
      is_read: false,
      is_starred: false,
      message_count: 1,
    }
    const inbound = {
      id: "msg-1",
      conversation_id: "conv-1",
      account_id: "account-1",
      external_message_id: "<inbound@example.com>",
      message_references: ["<root@example.com>"],
      from_address: { name: "Hans", email: "hans@example.com" },
      direction: "inbound",
      sent_at: "2026-01-01T00:00:00Z",
    }

    const bridge = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts" && id === "account-1") return JSON.stringify(account)
        if (entity === "conversations" && id === "conv-1") return JSON.stringify(conversation)
        return "null"
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.conversationId === "conv-1") {
          return JSON.stringify(opts.where?.direction === "inbound" ? [inbound] : [])
        }
        if (entity === "messages" && opts.where?.externalMessageId) return "[]"
        if (entity === "conversations" && opts.where?.externalThreadId === "thread-1") {
          return JSON.stringify([conversation])
        }
        return "[]"
      },
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        calls.inserted.push({ entity, data })
        return JSON.stringify({ id: "sent-1", ...data })
      },
      db_update: async (entity: string, id: string, dataJson: string) => {
        calls.updated.push({ entity, id, data: JSON.parse(dataJson) })
      },
      emit: async (eventJson: string) => {
        calls.emitted.push(JSON.parse(eventJson))
      },
      smtp_send: async () => JSON.stringify({ messageId: "<sent@example.com>" }),
      approval_recordStarted: async (toolName: string) =>
        calls.approval.push(["started", toolName]),
      approval_recordSucceeded: async (toolName: string, payload?: string) =>
        calls.approval.push(["succeeded", toolName, payload ? JSON.parse(payload) : null]),
      approval_recordFailedNoEffect: async (toolName: string, payload: string) =>
        calls.approval.push(["failed", toolName, JSON.parse(payload)]),
      approval_recordAmbiguous: async (toolName: string, payload: string) =>
        calls.approval.push(["ambiguous", toolName, JSON.parse(payload)]),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    const result = (await runMail({
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Reply body" },
      bridge,
    })) as any

    expect(result.messageId).toBe("<sent@example.com>")
    expect(calls.inserted[0]).toMatchObject({
      entity: "messages",
      data: {
        conversationId: "conv-1",
        accountId: "account-1",
        direction: "outbound",
        sentByUserId: "user-1",
        textBody: "Reply body",
        externalMessageId: "<sent@example.com>",
      },
    })
    expect(calls.updated[0]).toMatchObject({
      entity: "conversations",
      id: "conv-1",
      // The reply reads what it answered (the host marks the earlier messages
      // read too, so a later label recompute agrees: see page-write.test.ts).
      data: { messageCount: 2, snippet: "Reply body", isRead: true },
    })
    expect(calls.emitted.some((event: any) => event.entity === "message")).toBe(true)
    expect(calls.approval.some((call: any[]) => call[0] === "succeeded")).toBe(true)
  })

  // Regression: from_address is stored as a JSON object ({name,email}); interpolating
  // it into the To header sent "[object Object]" and Gmail rejected the send with
  // 400 "Invalid To header" (prod, 2026-07-24). The reply must format it as an
  // RFC 5322 mailbox, and an explicit `to` must override the default target.
  it("agentMailReply formats the stored sender object into a valid To mailbox", async () => {
    const smtpCalls: any[] = []
    const bridge = makeReplyBridge({
      onSmtp: (message: any) => smtpCalls.push(message),
    })
    const result = (await runMail({
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Reply body" },
      bridge,
    })) as any
    expect(result.messageId).toBe("<sent@example.com>")
    expect(smtpCalls[0].to).toEqual(["Hans <hans@example.com>"])
  })

  it("a reply the demo captured says it was captured and not delivered, never that it was sent", async () => {
    const bridge = {
      ...makeReplyBridge({ onSmtp: () => {} }),
      smtp_send: async () =>
        JSON.stringify({
          messageId: "<captured@demo>",
          deliveryState: "delivered",
          captured: true,
        }),
    }
    const result = (await runMail({
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Reply body" },
      bridge,
    })) as any
    expect(result.captured).toBe(true)
    expect(result.delivered).toBe(false)
    expect(result.note).toStartWith("Captured, not delivered: this is a demo workspace")
    expect(result.note).toContain("Nobody received it.")
    expect(result.note).not.toMatch(/^Sent to/)
  })

  it("a reply that went out says it was sent, with no captured mark", async () => {
    const result = (await runMail({
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Reply body" },
      bridge: makeReplyBridge({ onSmtp: () => {} }),
    })) as any
    expect(result.captured).toBeUndefined()
    expect(result.note).toStartWith(
      "Sent to hans@example.com from support@acme.com, in conversation conv-1.",
    )
  })

  it("a new mail the demo captured says it was captured and not delivered", async () => {
    const bridge = {
      ...makeReplyBridge({ onSmtp: () => {} }),
      smtp_send: async () =>
        JSON.stringify({
          messageId: "<captured@demo>",
          deliveryState: "delivered",
          captured: true,
        }),
    }
    const result = (await runMail({
      exportName: "agentMailCompose",
      params: {
        accountId: "account-1",
        to: ["noor@brasserie.example"],
        subject: "A question",
        textBody: "Why are you leaving?",
      },
      bridge,
    })) as any
    expect(result.captured).toBe(true)
    expect(result.note).toStartWith(
      "Captured, not delivered: this is a demo workspace, so the mail to noor@brasserie.example from support@acme.com",
    )
  })

  it("agentMailReply records the landed send before post-send work, so a cut-off run still names it", async () => {
    const recorded: any[] = []
    const bridge = {
      ...makeReplyBridge({ onSmtp: () => {} }),
      approval_recordStarted: async (toolName: string) => recorded.push(["started", toolName]),
      approval_recordEffectLanded: async (toolName: string, refJson: string) =>
        recorded.push(["landed", toolName, JSON.parse(refJson)]),
      mail_writePage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return '{"entries":[]}'
      },
    }
    const err = await runMail({
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Reply body" },
      bridge,
      timeoutMs: 400,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("timed out")
    expect(recorded.map((c) => c[0])).toEqual(["started", "landed"])
    expect(recorded[1][1]).toBe("mail:reply")
    expect(recorded[1][2]).toMatchObject({ messageId: "<sent@example.com>" })
  })

  it("agentMailReply sends a markdown body as formatted email, plain text as typed", async () => {
    const smtpCalls: any[] = []
    const bridge = makeReplyBridge({ onSmtp: (message: any) => smtpCalls.push(message) })
    const send = (textBody: string) =>
      runMail({
        exportName: "agentMailReply",
        params: { conversationId: "conv-1", textBody },
        bridge,
      })
    await send("Merci **beaucoup**,\n\n- un\n- deux")
    expect(smtpCalls[0].htmlBody).toContain("<strong>beaucoup</strong>")
    expect(smtpCalls[0].htmlBody).toContain("<ul")
    expect(smtpCalls[0].textBody).toBe("Merci beaucoup,\n\n- un\n- deux")
    await send("Bonjour,\n5*3 = 15")
    expect(smtpCalls[1].textBody).toBe("Bonjour,\n5*3 = 15")
    expect(smtpCalls[1].htmlBody).toBe("<p>Bonjour,<br>5*3 = 15</p>")
  })

  it("agentMailReply honors an explicit `to` override (gmail-style recipient edit)", async () => {
    const smtpCalls: any[] = []
    const bridge = makeReplyBridge({
      onSmtp: (message: any) => smtpCalls.push(message),
    })
    const result = (await runMail({
      exportName: "agentMailReply",
      params: {
        conversationId: "conv-1",
        textBody: "Reply body",
        to: ["pm.studio@klangwerk.example"],
        cc: ["morgan@fabrikam.example"],
      },
      bridge,
    })) as any
    expect(result.messageId).toBe("<sent@example.com>")
    expect(smtpCalls[0].to).toEqual(["pm.studio@klangwerk.example"])
    expect(smtpCalls[0].cc).toEqual(["morgan@fabrikam.example"])
  })

  it("agentMailReply stages agent attachments into the sent MIME and relinks them", async () => {
    const calls: any = { staged: [], reparented: [] }
    const account = {
      id: "account-1",
      owner_type: "org",
      owner_id: null,
      provider: "imap",
      email_address: "support@acme.com",
    }
    const conversation = {
      id: "conv-1",
      account_id: "account-1",
      owner_type: "org",
      owner_id: null,
      external_thread_id: "thread-1",
      subject: "Pricing",
      snippet: "Inbound body",
      labels: ["INBOX"],
      is_read: false,
      is_starred: false,
      message_count: 1,
    }
    const inbound = {
      id: "msg-1",
      conversation_id: "conv-1",
      account_id: "account-1",
      external_message_id: "<inbound@example.com>",
      message_references: [],
      from_address: { name: "Hans", email: "hans@example.com" },
      direction: "inbound",
      sent_at: "2026-01-01T00:00:00Z",
    }
    let sentMime: any = null

    const bridge = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts" && id === "account-1") return JSON.stringify(account)
        if (entity === "conversations" && id === "conv-1") return JSON.stringify(conversation)
        return "null"
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.conversationId === "conv-1") {
          return JSON.stringify(opts.where?.direction === "inbound" ? [inbound] : [])
        }
        if (entity === "messages" && opts.where?.externalMessageId) {
          return JSON.stringify([{ id: "persisted-msg-1" }])
        }
        if (entity === "conversations" && opts.where?.externalThreadId === "thread-1") {
          return JSON.stringify([conversation])
        }
        return "[]"
      },
      db_insert: async (_entity: string, dataJson: string) =>
        JSON.stringify({ id: "sent-1", ...JSON.parse(dataJson) }),
      db_update: async () => {},
      emit: async () => {},
      smtp_send: async (_connection: string, _identifier: string, messageJson: string) => {
        sentMime = JSON.parse(messageJson)
        return JSON.stringify({ messageId: "<sent@example.com>" })
      },
      files_attachToParent: async (argsJson: string) => {
        calls.staged.push(JSON.parse(argsJson))
        return JSON.stringify({
          id: "copied-1",
          filename: "return-label.pdf",
          mimeType: "application/pdf",
        })
      },
      files_getAttachmentBytes: async () =>
        JSON.stringify({
          filename: "return-label.pdf",
          mimeType: "application/pdf",
          bytesBase64: Buffer.from("PDF-BYTES").toString("base64"),
        }),
      files_reparent: async (argsJson: string) => {
        calls.reparented.push(JSON.parse(argsJson))
        return JSON.stringify({ moved: 1 })
      },
      approval_recordStarted: async () => {},
      approval_recordSucceeded: async () => {},
      approval_recordFailedNoEffect: async () => {},
      approval_recordAmbiguous: async () => {},
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    const result = (await runMail({
      exportName: "agentMailReply",
      params: {
        conversationId: "conv-1",
        textBody: "Here is your label.",
        attachments: ["src-file-1"],
      },
      bridge,
    })) as any

    expect(result.messageId).toBe("<sent@example.com>")
    expect(calls.staged[0]).toMatchObject({
      sourceFileId: "src-file-1",
      targetApp: "mail",
      targetEntityType: "outbound_staging",
    })
    expect(sentMime.attachments).toHaveLength(1)
    expect(sentMime.attachments[0].filename).toBe("return-label.pdf")
    expect(calls.reparented[0]).toMatchObject({
      targetEntityType: "message",
      targetEntityId: "persisted-msg-1",
    })
  })
})

describe("mail:forward — faithful forward carrying the original body + attachments", () => {
  // A mail world: priya's mailbox holds a Westcoast quote-request conversation with
  // an inbound message carrying a requirements PDF attachment, plus a prior outbound
  // reply (so "forward the email" must pick the INBOUND customer message, not ours).
  function makeForwardBridge(overrides: Record<string, any> = {}) {
    const calls: any = { staged: [], sent: [], approval: [], listAttachments: [] }
    const account = {
      id: "account-priya",
      owner_type: "user",
      owner_id: "user-priya",
      provider: "imap",
      email_address: "priya@resonantaudio.example",
    }
    const conversation = {
      id: "conv-wc",
      account_id: "account-priya",
      subject: "Bulk quote request — 40x Kestrel 6",
    }
    const inbound = {
      id: "msg-inbound",
      conversation_id: "conv-wc",
      account_id: "account-priya",
      external_message_id: "<wc-inbound@westcoast.example>",
      from_address: { name: "Westcoast Pro Audio", email: "buyer@westcoast-pro-audio.example" },
      to_addresses: [{ name: "Priya Support", email: "priya@resonantaudio.example" }],
      subject: "Bulk quote request — 40x Kestrel 6",
      text_body:
        "Hi Priya — please see the attached requirements PDF for a bulk order. — Westcoast",
      direction: "inbound",
      sent_at: "2026-06-10T09:00:00Z",
    }
    const outbound = {
      id: "msg-outbound",
      conversation_id: "conv-wc",
      account_id: "account-priya",
      from_address: { email: "priya@resonantaudio.example" },
      to_addresses: [{ email: "buyer@westcoast-pro-audio.example" }],
      subject: "Re: Bulk quote request — 40x Kestrel 6",
      text_body: "Thanks, I'll forward this to our sales team.",
      direction: "outbound",
      sent_at: "2026-06-10T10:00:00Z",
    }
    const bridge = {
      getUserId: () => "user-priya",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts" && id === "account-priya") return JSON.stringify(account)
        if (entity === "conversations" && id === "conv-wc") return JSON.stringify(conversation)
        if (entity === "messages" && id === "msg-inbound") return JSON.stringify(inbound)
        if (entity === "messages" && id === "msg-outbound") return JSON.stringify(outbound)
        return "null"
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.conversationId === "conv-wc") {
          if (opts.where?.direction === "inbound") return JSON.stringify([inbound])
          return JSON.stringify([outbound, inbound])
        }
        if (entity === "messages" && opts.where?.externalMessageId) {
          return JSON.stringify([{ id: "persisted-fwd-1" }])
        }
        return "[]"
      },
      db_insert: async (_entity: string, dataJson: string) =>
        JSON.stringify({ id: "sent-fwd-1", ...JSON.parse(dataJson) }),
      db_update: async () => {},
      emit: async () => {},
      kernel_findOne: async () => "null",
      smtp_send: async (_c: string, _i: string, messageJson: string) => {
        calls.sent.push(JSON.parse(messageJson))
        return JSON.stringify({ messageId: "<fwd@resonantaudio.example>" })
      },
      files_listAttachments: async (parentJson: string) => {
        const p = JSON.parse(parentJson)
        calls.listAttachments.push(p)
        if (p.entityId === "msg-inbound") {
          return JSON.stringify([
            {
              id: "file-wc-requirements-pdf",
              filename: "Westcoast-Requirements.pdf",
              mimeType: "application/pdf",
              sizeBytes: 51200,
              disposition: "attachment",
              contentId: null,
              ordinal: 0,
            },
          ])
        }
        return "[]"
      },
      files_attachToParent: async (argsJson: string) => {
        calls.staged.push(JSON.parse(argsJson))
        return JSON.stringify({
          id: "copied-wc-pdf",
          filename: "Westcoast-Requirements.pdf",
          mimeType: "application/pdf",
        })
      },
      files_getAttachmentBytes: async () =>
        JSON.stringify({
          filename: "Westcoast-Requirements.pdf",
          mimeType: "application/pdf",
          bytesBase64: Buffer.from("PDF-BYTES").toString("base64"),
        }),
      files_reparent: async () => JSON.stringify({ moved: 1 }),
      approval_recordStarted: async (tool: string) => calls.approval.push(["started", tool]),
      approval_recordSucceeded: async (tool: string) => calls.approval.push(["succeeded", tool]),
      approval_recordFailedNoEffect: async (tool: string, err: string) =>
        calls.approval.push(["failed", tool, err]),
      approval_recordAmbiguous: async (tool: string) => calls.approval.push(["ambiguous", tool]),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      _calls: calls,
      ...overrides,
    }
    return bridge
  }

  const runForward = async (params: Record<string, unknown>, bridge: any) =>
    (await runMail({
      exportName: "agentMailForward",
      params,
      bridge,
    })) as any

  it("re-sends the ORIGINAL inbound body + RE-ATTACHES the original PDF (faithful forward)", async () => {
    const bridge = makeForwardBridge()
    const result = await runForward(
      {
        conversationId: "conv-wc",
        to: ["sales@resonantaudio.example"],
        note: "Theo — can you quote this?",
      },
      bridge,
    )

    expect(result.messageId).toBe("<fwd@resonantaudio.example>")
    // The original PDF is carried: forward listed the source message's attachments
    // and staged the SAME file id into the outbound MIME — the PDF is NOT dropped.
    expect(bridge._calls.listAttachments).toContainEqual({
      app: "mail",
      entityType: "message",
      entityId: "msg-inbound",
    })
    expect(bridge._calls.staged[0]).toMatchObject({ sourceFileId: "file-wc-requirements-pdf" })
    const sent = bridge._calls.sent[0]
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].filename).toBe("Westcoast-Requirements.pdf")
    // Fwd: subject prefix, sent to the resolved recipient.
    expect(sent.subject).toBe("Fwd: Bulk quote request — 40x Kestrel 6")
    expect(sent.to).toEqual(["sales@resonantaudio.example"])
    // The original customer body is quoted under a Forwarded-message header; the
    // lead-in note sits above it.
    expect(sent.textBody).toContain("Theo — can you quote this?")
    expect(sent.textBody).toContain("Forwarded message")
    expect(sent.textBody).toContain("buyer@westcoast-pro-audio.example")
    expect(sent.textBody).toContain("> Hi Priya — please see the attached requirements PDF")
  })

  it("attaches EXTRA file ids (a local upload) on top of the original's, each once", async () => {
    const bridge = makeForwardBridge()
    await runForward(
      {
        conversationId: "conv-wc",
        to: ["sales@resonantaudio.example"],
        // The original's own id repeated must not attach twice.
        attachments: ["file-local-upload", "file-wc-requirements-pdf"],
      },
      bridge,
    )
    expect(bridge._calls.staged.map((s: any) => s.sourceFileId)).toEqual([
      "file-wc-requirements-pdf",
      "file-local-upload",
    ])
  })

  it("does NOT throw when the source message's to_addresses is not an array (the chaos `not a function` bug)", async () => {
    // The post-approval execution of mail:forward quotes the original message's
    // To: line. If `message.to_addresses` comes back as a non-array (a stray
    // string/null from the store), `.map` threw a bare "not a function" that
    // surfaced to the approval-decide path as handler_outcome_unknown → a false
    // non-green. Forward must tolerate it (quote with an empty To: line) and still
    // send, carrying the body + attachment.
    const bridge = makeForwardBridge({
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.conversationId === "conv-wc") {
          if (opts.where?.direction === "inbound") {
            return JSON.stringify([
              {
                id: "msg-inbound",
                conversation_id: "conv-wc",
                account_id: "account-priya",
                external_message_id: "<wc-inbound@westcoast.example>",
                from_address: { email: "buyer@westcoast-pro-audio.example" },
                // The defect trigger: a non-array to_addresses.
                to_addresses: "priya@resonantaudio.example",
                subject: "Bulk quote request",
                text_body: "Please see attached.",
                direction: "inbound",
                sent_at: "2026-06-10T09:00:00Z",
              },
            ])
          }
          return JSON.stringify([])
        }
        if (entity === "messages" && opts.where?.externalMessageId) {
          return JSON.stringify([{ id: "persisted-fwd-1" }])
        }
        return "[]"
      },
    })
    const result = await runForward(
      { conversationId: "conv-wc", to: ["sales@resonantaudio.example"] },
      bridge,
    )
    expect(result.messageId).toBe("<fwd@resonantaudio.example>")
    const sent = bridge._calls.sent[0]
    expect(sent.subject).toBe("Fwd: Bulk quote request")
    expect(sent.textBody).toContain("Forwarded message")
    expect(sent.attachments).toHaveLength(1)
  })

  it("forwards the INBOUND customer message by default, never our own outbound reply", async () => {
    const bridge = makeForwardBridge()
    await runForward({ conversationId: "conv-wc", to: ["sales@resonantaudio.example"] }, bridge)
    const sent = bridge._calls.sent[0]
    // The quoted body is the CUSTOMER's, not our outbound "I'll forward this" reply.
    expect(sent.textBody).toContain("> Hi Priya — please see the attached requirements PDF")
    expect(sent.textBody).not.toContain("I'll forward this to our sales team")
  })

  it("fails closed with a real reason when the conversation has no inbound message", async () => {
    const bridge = makeForwardBridge({
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.direction === "inbound") return "[]"
        return "[]"
      },
    })
    await expect(
      runForward({ conversationId: "conv-wc", to: ["sales@resonantaudio.example"] }, bridge),
    ).rejects.toThrow(/no inbound message/i)
    // A clean failed-no-effect was recorded under mail:forward — never a bare throw.
    expect(bridge._calls.approval).toContainEqual(["started", "mail:forward"])
    expect(
      bridge._calls.approval.some((a: any[]) => a[0] === "failed" && a[1] === "mail:forward"),
    ).toBe(true)
    expect(bridge._calls.sent).toHaveLength(0)
  })

  it("returns NOT_FOUND when the conversation does not exist", async () => {
    const bridge = makeForwardBridge()
    await expect(
      runForward({ conversationId: "missing", to: ["sales@resonantaudio.example"] }, bridge),
    ).rejects.toThrow(/not found/i)
    expect(bridge._calls.sent).toHaveLength(0)
  })

  it("agentMailForwardPreflight resolves the source, NOT_FOUND when absent", async () => {
    const ok = (await runMail({
      exportName: "agentMailForwardPreflight",
      params: { conversationId: "conv-wc" },
      bridge: makeForwardBridge(),
    })) as any
    expect(ok).toEqual({ ok: true })

    const missing = (await runMail({
      exportName: "agentMailForwardPreflight",
      params: { conversationId: "missing" },
      bridge: makeForwardBridge(),
    })) as any
    expect(missing.error?.code).toBe("NOT_FOUND")
  })
})

describe("mail:composeForApp (B8) — internal companion tool", () => {
  function makeComposeBridge(overrides: Record<string, any> = {}) {
    const account = {
      id: "account-1",
      owner_type: "org",
      owner_id: null,
      provider: "imap",
      email_address: "support@acme.com",
    }
    const calls: any = {
      approval: [],
      staged: [],
      reparented: [],
      smtp: [],
      inserted: [],
    }
    let sentMime: any = null

    const bridge = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts" && id === "account-1") return JSON.stringify(account)
        return "null"
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "messages" && opts.where?.externalMessageId) {
          return JSON.stringify([{ id: "persisted-msg-1" }])
        }
        return "[]"
      },
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        calls.inserted.push({ entity, data })
        return JSON.stringify({ id: "sent-1", ...data })
      },
      db_update: async () => {},
      db_updateMany: async () => '{"count":0}',
      emit: async () => {},
      smtp_send: async (_conn: string, _id: string, messageJson: string) => {
        sentMime = JSON.parse(messageJson)
        calls.smtp.push(sentMime)
        return JSON.stringify({ messageId: "<composed@example.com>" })
      },
      files_attachToParent: async (argsJson: string) => {
        const args = JSON.parse(argsJson)
        calls.staged.push(args)
        return JSON.stringify({
          id: "copied-1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
        })
      },
      files_getAttachmentBytes: async () =>
        JSON.stringify({
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          bytesBase64: Buffer.from("INVOICE-PDF-BYTES").toString("base64"),
        }),
      files_reparent: async (argsJson: string) => {
        calls.reparented.push(JSON.parse(argsJson))
        return JSON.stringify({ moved: 1 })
      },
      approval_recordStarted: async (toolName: string) => {
        calls.approval.push(["started", toolName])
      },
      approval_recordSucceeded: async (toolName: string, payload?: string) => {
        calls.approval.push(["succeeded", toolName, payload ? JSON.parse(payload) : null])
      },
      approval_recordFailedNoEffect: async (toolName: string, payload: string) => {
        calls.approval.push(["failed", toolName, JSON.parse(payload)])
      },
      approval_recordAmbiguous: async (toolName: string, payload: string) => {
        calls.approval.push(["ambiguous", toolName, JSON.parse(payload)])
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      _calls: calls,
      _getSentMime: () => sentMime,
      ...overrides,
    }
    return bridge
  }

  it("sends and records audit under the mail:composeForApp tool name", async () => {
    const bridge = makeComposeBridge()
    const result = (await runMail({
      exportName: "agentMailComposeForApp",
      params: {
        accountId: "account-1",
        to: ["customer@example.com"],
        subject: "Invoice INV-2026-0001",
        textBody: "See attached.",
        originating_approval_id: "approval-abc",
      },
      bridge,
    })) as any

    expect(result.messageId).toBe("<composed@example.com>")
    // Audit calls are scoped to the composeForApp tool name (not mail:compose).
    const toolNames = bridge._calls.approval.map((c: any[]) => c[1])
    expect(toolNames.every((n: string) => n === "mail:composeForApp")).toBe(true)
    expect(bridge._calls.approval.some((c: any[]) => c[0] === "started")).toBe(true)
    expect(bridge._calls.approval.some((c: any[]) => c[0] === "succeeded")).toBe(true)
    // The success payload threads the originating_approval_id for the audit chain.
    const succeeded = bridge._calls.approval.find((c: any[]) => c[0] === "succeeded")
    expect(succeeded[2]).toMatchObject({ originating_approval_id: "approval-abc" })
  })

  it("records the landed send before post-send work, so a run cut off there still names the sent message", async () => {
    // The sandbox ceiling interrupts the handler while it persists the sent copy
    // (the post-send write outlasts the budget). The landed record must already be
    // on the protocol row by then: it is the only trace that the provider accepted
    // the message, and what keeps the approval from being parked or re-sent.
    const bridge = makeComposeBridge({
      approval_recordEffectLanded: async (toolName: string, refJson: string) => {
        bridge._calls.approval.push(["landed", toolName, JSON.parse(refJson)])
      },
      mail_writePage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return '{"entries":[]}'
      },
    })
    const err = await runMail({
      exportName: "agentMailComposeForApp",
      params: {
        accountId: "account-1",
        to: ["customer@example.com"],
        subject: "Invoice INV-2026-0001",
        textBody: "See attached.",
      },
      bridge,
      timeoutMs: 400,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("timed out")
    expect(bridge._calls.smtp).toHaveLength(1)
    const kinds = bridge._calls.approval.map((c: any[]) => c[0])
    expect(kinds).toEqual(["started", "landed"])
    expect(bridge._calls.approval[1]).toEqual([
      "landed",
      "mail:composeForApp",
      {
        provider: "imap",
        messageId: "<composed@example.com>",
        externalThreadId: "<composed@example.com>",
      },
    ])
  })

  it("materializes cross-app PDF attachments via files_attachToParent (review M2)", async () => {
    const bridge = makeComposeBridge()
    await runMail({
      exportName: "agentMailComposeForApp",
      params: {
        accountId: "account-1",
        to: ["customer@example.com"],
        subject: "Invoice INV-2026-0001",
        textBody: "See attached.",
        attachments: ["invoicing-pdf-id"],
        originating_approval_id: "approval-abc",
      },
      bridge,
    })

    // The PDF passed through files_attachToParent → Mail-owned copy parented on
    // outbound_staging. Same code path as agentMailCompose; verifies _doCompose
    // is the shared call site.
    expect(bridge._calls.staged).toHaveLength(1)
    expect(bridge._calls.staged[0]).toMatchObject({
      sourceFileId: "invoicing-pdf-id",
      targetApp: "mail",
      targetEntityType: "outbound_staging",
      targetEntityId: "account-1",
    })
    const mime = bridge._getSentMime()
    expect(mime.attachments).toHaveLength(1)
    expect(mime.attachments[0].filename).toBe("invoice.pdf")
  })

  it("agentMailCompose and agentMailComposeForApp share _doCompose (refactor invariant)", async () => {
    // Static-source assertion: both wrappers route through the shared helper.
    // If a future change re-inlines either body, this fails and forces the
    // refactor to be redone (resolves review I8).
    const source = await Bun.file(path.resolve(import.meta.dir, "handlers.ts")).text()
    expect(source).toMatch(/(async\s+)?function\s+_doCompose\s*\(/)
    // Both public handlers must reference _doCompose.
    const composeBody = source.split(/async\s+function\s+agentMailCompose\s*\(/)[1] ?? ""
    const composeFnBody = composeBody.split(/\n}\s*\n/)[0] ?? ""
    expect(composeFnBody).toMatch(/_doCompose\s*\(/)
    const forAppBody = source.split(/async\s+function\s+agentMailComposeForApp\s*\(/)[1] ?? ""
    const forAppFnBody = forAppBody.split(/\n}\s*\n/)[0] ?? ""
    expect(forAppFnBody).toMatch(/_doCompose\s*\(/)
  })

  it("manifest declares composeForApp as internal, agent-invisible, deferLoading", async () => {
    const manifest = (await import("./app.manifest.json")).default as any
    const tool = manifest.tools?.composeForApp
    expect(tool).toBeDefined()
    expect(tool.trustBoundary).toBe("internal")
    expect(tool.agentVisible).toBe(false)
    expect(tool.deferLoading).toBe(true)
    expect(tool.handler).toBe("agentMailComposeForApp")
    expect(tool.params.required).toEqual(
      expect.arrayContaining(["accountId", "to", "subject", "textBody", "originating_approval_id"]),
    )
  })

  // The compose PREFLIGHT refuses a missing or unknown accountId with an envelope (never a throw, which
  // surfaces as a bare "Tool execution failed" and makes the agent loop). There is no fallback to the
  // org's shared mailbox: that silently sent a user's personal mail from contact@.
  const orgMailboxBridge = () =>
    makeComposeBridge({
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts" && id === "account-1") return JSON.stringify({ id: "account-1" })
        // the real sandbox/DB throws on an invalid-uuid id rather than returning null
        throw new Error(`invalid input syntax for type uuid: "${id}"`)
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (entity === "accounts" && opts.where?.ownerType === "org") {
          return JSON.stringify([{ id: "org-mailbox-1" }])
        }
        return "[]"
      },
    })

  it("preflight refuses an OMITTED accountId even when an org mailbox exists (no shared-box fallback)", async () => {
    const result = (await runMail({
      exportName: "agentMailComposePreflight",
      params: { to: ["dealer@example.com"], subject: "Overdue reminder", textBody: "Please pay." },
      bridge: orgMailboxBridge(),
    })) as any
    expect(result.error?.code).toBe("invalid_params")
    expect(result.error?.message).toMatch(/listAccounts/)
  })

  it("preflight refuses a non-uuid placeholder accountId with NOT_FOUND (db_findOne throws, never crashes)", async () => {
    const result = (await runMail({
      exportName: "agentMailComposePreflight",
      params: {
        accountId: "default-account-id",
        to: ["dealer@example.com"],
        subject: "R",
        textBody: "b",
      },
      bridge: orgMailboxBridge(),
    })) as any
    expect(result.error?.code).toBe("NOT_FOUND")
  })

  it("preflight accepts a real accountId", async () => {
    const result = (await runMail({
      exportName: "agentMailComposePreflight",
      params: { accountId: "account-1", to: ["dealer@example.com"], subject: "R", textBody: "b" },
      bridge: orgMailboxBridge(),
    })) as any
    expect(result).toEqual({ ok: true })
  })

  // claire-day-finance sales-handoff root: a mail:reply to a conversation with NO INBOUND message has no
  // recipient (mail:reply renders `To:` from the latest inbound message), so the execute handler throws
  // `No inbound message to reply to` (handler_no_effect/422) at decide time → an UNVERIFIABLE approved
  // gated execution → force-fails the run. The PREFLIGHT must catch it at propose with `no_inbound` so the
  // agent self-corrects to mail:compose / documents_send_to_customer instead of staging a doomed approval.
  function makeReplyPreflightBridge(inboundRows: unknown[]) {
    return {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string, id: string) => {
        if (entity === "conversations" && id === "conv-1")
          return JSON.stringify({ id: "conv-1", account_id: "account-1", subject: "Final demand" })
        if (entity === "accounts" && id === "account-1")
          return JSON.stringify({ id: "account-1", email_address: "billing@acme.com" })
        return "null"
      },
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson || "{}")
        if (
          entity === "messages" &&
          opts.where?.conversationId === "conv-1" &&
          opts.where?.direction === "inbound"
        ) {
          return JSON.stringify(inboundRows)
        }
        return "[]"
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }
  }

  it("reply preflight: an OUTBOUND-only conversation (no inbound message) is rejected with no_inbound at propose", async () => {
    const result = (await runMail({
      exportName: "agentMailReplyPreflight",
      params: { conversationId: "conv-1" },
      bridge: makeReplyPreflightBridge([]), // no inbound message to reply to
    })) as any
    expect(result.error?.code).toBe("no_inbound")
    expect(result.error?.message).toMatch(/documents_send_to_customer|mail:compose/)
  })

  it("reply preflight: a conversation WITH an inbound message passes (ok) — a real reply is not blocked", async () => {
    const result = (await runMail({
      exportName: "agentMailReplyPreflight",
      params: { conversationId: "conv-1" },
      bridge: makeReplyPreflightBridge([
        { id: "msg-1", from_address: { email: "hans@example.com" } },
      ]),
    })) as any
    expect(result).toEqual({ ok: true })
  })

  // Scan/paging/from-filter/date-range/body-filter/sender-fallback behavior now
  // lives host-side in apps/mail/search.ts and is covered by search.test.ts plus
  // the e2e mail-filters-analytics.scenario.test.ts C-module.
})

describe("mail:export_conversations — scoped correspondence → kernel.files artifact (BL-264)", () => {
  // A bridge that honors the equality `where` (contactId/accountId/status) the
  // way the live conversations table does, resolves contacts via kernel_findOne,
  // and CAPTURES files_importAttachment so the test can decode the written bytes
  // and assert the real artifact content (not just that a call was made).
  function makeExportBridge(
    convs: Array<{
      id: string
      account_id?: string
      contact_id?: string | null
      subject?: string
      snippet?: string
      from_email?: string | null
      from_address?: { name?: string | null; email?: string | null } | null
      status?: string
      last_message_at?: string
      message_count?: number
      is_read?: boolean
    }>,
    contacts: Record<string, { id: string; name: string }> = {},
    opts: { failImport?: boolean; omitImportBridge?: boolean } = {},
  ) {
    const imports: Array<{ params: any; decoded: string }> = []
    const accounts: Record<string, any> = {
      "account-1": {
        id: "account-1",
        owner_type: "org",
        email_address: "billing@resonantaudio.example",
      },
    }
    const snakeCase = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase()
    const matchSearch = (
      row: Record<string, unknown>,
      search?: { fields: string[]; query: string },
    ) => {
      if (!search?.query) return true
      const q = search.query.toLowerCase()
      return search.fields.some((f) =>
        String(row[snakeCase(f)] ?? "")
          .toLowerCase()
          .includes(q),
      )
    }
    const matchWhere = (c: any, where: any = {}) => {
      if (where.accountId !== undefined && c.account_id !== where.accountId) return false
      if (where.contactId !== undefined && c.contact_id !== where.contactId) return false
      if (where.status !== undefined && c.status !== where.status) return false
      if (where.isRead !== undefined && (c.is_read ?? false) !== where.isRead) return false
      if (where.assignedTo !== undefined && c.assigned_to !== where.assignedTo) return false
      return true
    }
    const bridge: any = {
      getUserId: () => "11111111-1111-1111-1111-111111111111",
      getOrgId: () => "org-1",
      db_findMany: async (entity: string, optsJson: string) => {
        const o = JSON.parse(optsJson || "{}")
        if (entity === "conversations") {
          const rows = convs.filter((c) => matchWhere(c, o.where) && matchSearch(c, o.search))
          return JSON.stringify(rows.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 200)))
        }
        if (entity === "messages") return "[]"
        if (entity === "accounts") {
          const rows = Object.values(accounts).filter((a) =>
            o.where?.ownerType ? a.owner_type === o.where.ownerType : true,
          )
          return JSON.stringify(rows.slice(0, o.limit ?? 50))
        }
        return "[]"
      },
      db_findOne: async (entity: string, id: string) => {
        if (entity === "accounts") return JSON.stringify(accounts[id] ?? null)
        const conv = convs.find((c) => c.id === id)
        return JSON.stringify(conv ?? null)
      },
      db_count: async () => "0",
      kernel_findOne: async (entity: string, id: string) => {
        if (entity === "contacts") return JSON.stringify(contacts[id] ?? null)
        return "null"
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      _imports: imports,
    }
    if (!opts.omitImportBridge) {
      bridge.files_importAttachment = async (paramsJson: string) => {
        const p = JSON.parse(paramsJson)
        if (opts.failImport) throw new Error("storage write failed")
        const decoded = Buffer.from(p.bytesBase64, "base64").toString("utf-8")
        imports.push({ params: p, decoded })
        return JSON.stringify({
          id: `file-${imports.length}`,
          filename: p.filename,
          mimeType: p.mimeType,
          sizeBytes: Buffer.byteLength(decoded, "utf-8"),
        })
      }
    }
    return bridge
  }

  const runExport = async (params: Record<string, unknown>, bridge: any) =>
    (await runMail({
      exportName: "exportConversations",
      params,
      bridge,
    })) as any

  it("compiles the contactId+since/until-scoped set into a CSV kernel.files artifact (real rows, not fabricated)", async () => {
    // Two THIS-QUARTER conversations for one dealer + one OLD one outside the
    // window — a correct quarter scope must bundle ONLY the two recent ones.
    const bridge = makeExportBridge(
      [
        {
          id: "c-recent-1",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: "Q reorder — 20x units",
          snippet: "Reorder for spring",
          from_email: "lena@klangwerk.example",
          from_address: { name: "Lena Bauer", email: "lena@klangwerk.example" },
          status: "open",
          last_message_at: "2026-06-10T00:00:00Z",
          message_count: 1,
        },
        {
          id: "c-recent-2",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: 'Display unit, comma, and "quotes"',
          snippet: "Showroom loan",
          from_email: "lena@klangwerk.example",
          from_address: { name: "Lena Bauer", email: "lena@klangwerk.example" },
          status: "open",
          last_message_at: "2026-05-20T00:00:00Z",
          message_count: 2,
        },
        {
          id: "c-old",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: "Last year invoice",
          snippet: "old",
          from_email: "lena@klangwerk.example",
          status: "open",
          last_message_at: "2025-09-01T00:00:00Z",
          message_count: 1,
        },
      ],
      { "dealer-1": { id: "dealer-1", name: "Klangwerk GmbH" } },
    )
    const res = await runExport(
      {
        contactId: "dealer-1",
        since: "2026-04-01T00:00:00Z",
        until: "2026-06-30T23:59:59Z",
        format: "csv",
      },
      bridge,
    )
    expect(res.error).toBeUndefined()
    expect(res.fileId).toBe("file-1")
    expect(res.format).toBe("csv")
    expect(res.conversationCount).toBe(2)
    expect(res.mimeType).toBe("text/csv")
    // The artifact was actually written via the files bridge, parented to the account.
    expect(bridge._imports).toHaveLength(1)
    const written = bridge._imports[0]
    expect(written.params.targetApp).toBe("mail")
    expect(written.params.targetEntityType).toBe("outbound_staging")
    expect(written.params.targetEntityId).toBe("account-1")
    // Real rows: only the two in-window conversations, never the old one.
    const csv = written.decoded
    expect(csv).toContain("c-recent-1")
    expect(csv).toContain("c-recent-2")
    expect(csv).not.toContain("c-old")
    // The linked contact name is resolved + present.
    expect(csv).toContain("Klangwerk GmbH")
    // RFC-4180: header row + CRLF line endings.
    const lines = csv.split("\r\n")
    expect(lines[0]).toBe(
      "conversationId,contact,accountEmail,subject,fromName,fromEmail,lastMessageAt,status,messageCount,snippet",
    )
    // A subject containing a comma AND embedded quotes must be quoted with the
    // quote doubled per RFC-4180.
    expect(csv).toContain('"Display unit, comma, and ""quotes"""')
  })

  it("honors a scope that returns nothing by writing a header-only CSV (empty scope is NOT an error)", async () => {
    const bridge = makeExportBridge([
      {
        id: "c1",
        account_id: "account-1",
        contact_id: "other",
        subject: "X",
        last_message_at: "2026-06-10T00:00:00Z",
      },
    ])
    const res = await runExport({ contactId: "no-such-dealer", format: "csv" }, bridge)
    expect(res.error).toBeUndefined()
    expect(res.conversationCount).toBe(0)
    expect(bridge._imports[0].decoded).toBe(
      "conversationId,contact,accountEmail,subject,fromName,fromEmail,lastMessageAt,status,messageCount,snippet\r\n",
    )
  })

  it("produces a markdown bundle when format='markdown'", async () => {
    const bridge = makeExportBridge(
      [
        {
          id: "c1",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: "Reorder",
          snippet: "hi",
          from_email: "lena@klangwerk.example",
          from_address: { name: "Lena Bauer", email: "lena@klangwerk.example" },
          status: "open",
          last_message_at: "2026-06-10T00:00:00Z",
          message_count: 1,
        },
      ],
      { "dealer-1": { id: "dealer-1", name: "Klangwerk GmbH" } },
    )
    const res = await runExport({ contactId: "dealer-1", format: "markdown" }, bridge)
    expect(res.format).toBe("markdown")
    expect(res.mimeType).toBe("text/markdown")
    const md = bridge._imports[0].decoded
    expect(md).toContain("# Mail correspondence export")
    expect(md).toContain("## Reorder")
    expect(md).toContain("Klangwerk GmbH")
  })

  it("surfaces a typed error (not all-rows, not a 500) for a malformed since date", async () => {
    const bridge = makeExportBridge([])
    const res = await runExport({ contactId: "dealer-1", since: "not-a-date" }, bridge)
    expect(res.error?.code).toBe("invalid_params")
    expect(bridge._imports).toHaveLength(0)
  })

  it("fails loudly (typed error) when the files bridge is unavailable rather than silently succeeding with no file", async () => {
    const bridge = makeExportBridge(
      [
        {
          id: "c1",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: "X",
          last_message_at: "2026-06-10T00:00:00Z",
        },
      ],
      { "dealer-1": { id: "dealer-1", name: "Klangwerk GmbH" } },
      { omitImportBridge: true },
    )
    const res = await runExport({ contactId: "dealer-1" }, bridge)
    expect(res.error?.code).toBe("unsupported")
  })

  it("falls back to the org default mailbox as the artifact parent when no accountId is scoped", async () => {
    const bridge = makeExportBridge(
      [
        {
          id: "c1",
          account_id: "account-1",
          contact_id: "dealer-1",
          subject: "X",
          snippet: "y",
          from_email: "lena@klangwerk.example",
          status: "open",
          last_message_at: "2026-06-10T00:00:00Z",
          message_count: 1,
        },
      ],
      { "dealer-1": { id: "dealer-1", name: "Klangwerk GmbH" } },
    )
    const res = await runExport({ contactId: "dealer-1" }, bridge)
    expect(res.error).toBeUndefined()
    expect(res.accountId).toBe("account-1")
    expect(bridge._imports[0].params.targetEntityId).toBe("account-1")
  })
})

// Shared minimal bridge for the agentMailReply To-header tests: one inbound
// message whose from_address is the stored {name,email} JSON object.
function makeReplyBridge(opts: { onSmtp: (message: any) => void }) {
  const account = {
    id: "account-1",
    owner_type: "org",
    owner_id: null,
    provider: "imap",
    email_address: "support@acme.com",
  }
  const conversation = {
    id: "conv-1",
    account_id: "account-1",
    owner_type: "org",
    owner_id: null,
    external_thread_id: "thread-1",
    subject: "Pricing",
    snippet: "Inbound body",
    labels: ["INBOX"],
    is_read: false,
    is_starred: false,
    message_count: 1,
  }
  const inbound = {
    id: "msg-1",
    conversation_id: "conv-1",
    account_id: "account-1",
    external_message_id: "<inbound@example.com>",
    message_references: ["<root@example.com>"],
    from_address: { name: "Hans", email: "hans@example.com" },
    direction: "inbound",
    sent_at: "2026-01-01T00:00:00Z",
  }
  return {
    getUserId: () => "user-1",
    getOrgId: () => "org-1",
    db_findOne: async (entity: string, id: string) => {
      if (entity === "accounts" && id === "account-1") return JSON.stringify(account)
      if (entity === "conversations" && id === "conv-1") return JSON.stringify(conversation)
      return "null"
    },
    db_findMany: async (entity: string, optsJson: string) => {
      const o = JSON.parse(optsJson || "{}")
      if (entity === "messages" && o.where?.conversationId === "conv-1") {
        return JSON.stringify(o.where?.direction === "inbound" ? [inbound] : [])
      }
      if (entity === "messages" && o.where?.externalMessageId) return "[]"
      if (entity === "conversations" && o.where?.externalThreadId === "thread-1") {
        return JSON.stringify([conversation])
      }
      return "[]"
    },
    db_insert: async (_entity: string, dataJson: string) =>
      JSON.stringify({ id: "sent-1", ...JSON.parse(dataJson) }),
    db_update: async () => {},
    emit: async () => {},
    smtp_send: async (_conn: string, _identifier: string, messageJson: string) => {
      opts.onSmtp(JSON.parse(messageJson))
      return JSON.stringify({ messageId: "<sent@example.com>" })
    },
    approval_recordStarted: async () => {},
    approval_recordSucceeded: async () => {},
    approval_recordFailedNoEffect: async () => {},
    approval_recordAmbiguous: async () => {},
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: () => {},
  }
}

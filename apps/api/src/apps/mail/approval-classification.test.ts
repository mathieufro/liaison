// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const bundlePath = new URL("./handlers.ts", import.meta.url).pathname

function bridgeFor(status: number) {
  const calls: Array<{ method: string; toolName: string; payload?: any }> = []
  return {
    calls,
    bridge: {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findOne: async (entity: string) => {
        if (entity === "conversations") {
          return JSON.stringify({
            id: "conv-1",
            account_id: "acct-1",
            subject: "Subject",
            external_thread_id: "gmail-thread",
          })
        }
        if (entity === "accounts") {
          return JSON.stringify({
            id: "acct-1",
            provider: "gmail",
            email_address: "support@example.com",
          })
        }
        return JSON.stringify(null)
      },
      db_findMany: async () =>
        JSON.stringify([
          {
            id: "msg-1",
            external_message_id: "<msg-1>",
            message_references: [],
            from_address: "customer@example.com",
          },
        ]),
      connections_getToken: async () => "token",
      fetch: async () =>
        JSON.stringify({
          status,
          headers: {},
          body: JSON.stringify({ error: { message: `status ${status}` } }),
        }),
      approval_recordStarted: async (toolName: string) => {
        calls.push({ method: "started", toolName })
      },
      approval_recordSucceeded: async (toolName: string, payload?: string) => {
        calls.push({
          method: "succeeded",
          toolName,
          payload: payload ? JSON.parse(payload) : undefined,
        })
      },
      mail_checkSendGuard: async () => JSON.stringify({ applies: false }),
      approval_recordFailedNoEffect: async (toolName: string, payload: string) => {
        calls.push({ method: "failed_no_effect", toolName, payload: JSON.parse(payload) })
      },
      approval_recordAmbiguous: async (toolName: string, payload: string) => {
        calls.push({ method: "ambiguous", toolName, payload: JSON.parse(payload) })
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    },
  }
}

async function runReply(status: number) {
  const bundleSource = await loadBundle(bundlePath)
  const { bridge, calls } = bridgeFor(status)
  await expect(
    executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "agentMailReply",
      params: { conversationId: "conv-1", textBody: "Hello", htmlBody: "" },
      bridge,
    }),
  ).rejects.toThrow()
  return calls
}

describe("mail approved handler provider classification", () => {
  beforeAll(async () => {
    await initSandboxPool()
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("classifies clear Gmail 4xx send failures as failed_no_effect", async () => {
    const calls = await runReply(400)
    expect(calls).toContainEqual({ method: "started", toolName: "mail:reply" })
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "failed_no_effect",
        toolName: "mail:reply",
        payload: expect.objectContaining({ code: "GMAIL_SEND_FAILED", status: 400 }),
      }),
    )
  })

  it("classifies Gmail 5xx send failures as ambiguous", async () => {
    const calls = await runReply(503)
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "ambiguous",
        toolName: "mail:reply",
        payload: expect.objectContaining({ code: "GMAIL_SEND_FAILED", status: 503 }),
      }),
    )
  })
})

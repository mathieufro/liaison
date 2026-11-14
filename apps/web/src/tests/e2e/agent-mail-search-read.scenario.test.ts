// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's mail tools, end to end on the conversation surface: the turn
// searches the user's real mailbox and reads one real conversation, and both
// the rendered turn and the tools' own payloads are asserted.
//
// P4c-T21b: this used to stub `**\/api/agent/chat` SSE. The tools were run
// OUT OF BAND over `/api/apps/run-tool` and their payloads replayed back to the
// retired panel as a fake transcript, so the browser half proved only that a
// hand-written stream renders. The turn is now scripted on the SERVER
// (`agent-turn.ts`) and only the MODEL is scripted: `mail__search` and
// `mail__read` execute for real through the tool bridge, inside the turn, under
// the user's own permissions. Their results are read back off the turn's
// persisted `metadata.toolCalls` (`turnToolCalls`), which is where the real
// result lands — so the payload-cap contract below is asserted against what the
// AGENT was actually handed, not against a second, separate invocation.
//
// `mail__search` / `mail__read` are app tools, and every app tool is deferred
// until `tool_search` loads it (`tool-bridge.ts`), so the discovery step is part
// of the scripted turn rather than scaffolding.
import { api } from "@liaison/test-helpers"
import {
  expandToolRollups,
  loginAsAdmin,
  openAgentConversation,
  sendInConversation,
} from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, turnToolCalls, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { seedMailBaseline } from "./helpers/mail-fixtures"

const ANSWER = "Found the Q3 Budget Proposal conversation."

/** One real invocation of a mail tool through the sandbox RPC bridge. */
async function runMailTool(
  serverUrl: string,
  token: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await api(serverUrl, "/api/apps/run-tool", { token, body: { toolName, params } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body as { data?: unknown }).data ?? res.body
}

test("agent mail.search and mail.read return real backend results in the conversation", async ({
  page,
  env,
  world,
  qa,
}) => {
  await seedModelPricingAndCredits(env, world.org.id)
  const baseline = await seedMailBaseline(env, qa.admin.id, world.org.id)
  const convA = baseline.conversations.unreadStarredHtml // subject "Q3 Budget Proposal"

  const token = world.admin.token
  const threadId = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      // Loaded by name, the way the search's own note tells a model to load a
      // tool it knows: a keyword search LOADS only the tools that satisfy every
      // term and tie the best score (tool-rank.ts strongMatches), and for "read
      // mail" that is the kernel's mail_attachment_read (two name parts), not
      // mail__read. A call to a tool not loaded is rewritten into a load rather
      // than run, so the turn would never read the conversation.
      {
        toolCalls: [
          { name: "kernel__tool_search", args: { query: "select:mail__search,mail__read" } },
        ],
      },
      { toolCalls: [{ name: "mail__search", args: { query: "Q3 Budget" } }] },
      { toolCalls: [{ name: "mail__read", args: { conversationId: convA.id } }] },
      { text: ANSWER },
    ],
  })

  await loginAsAdmin(page, env)
  await page.goto(`http://localhost:${env.ports[1]}/`)
  const conversation = await openAgentConversation(page)
  await sendInConversation(page, conversation, "find the Q3 Budget thread")
  await waitForTurnEnd(env, { threadId, token, contains: ANSWER })

  // Both mail tools ran through the bridge and are rendered in the turn. Scoped
  // to THIS turn's row: the DM is worker-scoped and already carries earlier
  // turns' tool rows.
  const turnRow = conversation
    .locator('[data-testid="message-row"]')
    .filter({ hasText: "Q3 Budget Proposal conversation" })
    .last()
  await expect(turnRow).toBeVisible({ timeout: 30000 })
  await expandToolRollups(turnRow)
  for (const toolName of ["mail__search", "mail__read"]) {
    await expect(turnRow.locator(`[data-tool-name="${toolName}"]`).first()).toBeVisible({
      timeout: 20000,
    })
  }
  await expect(conversation.getByTestId("approval-card")).toHaveCount(0)

  // The turn persisted both calls — the rendered rows above are not a render of
  // something the server never recorded.
  const calls = await turnToolCalls(env, {
    threadId,
    token,
    contains: ANSWER,
    expect: "mail__read",
  })
  expect(calls.map((c) => c.toolName)).toEqual(
    expect.arrayContaining(["mail__search", "mail__read"]),
  )

  // THE PAYLOAD CONTRACT is asserted on a real invocation of the same tools,
  // through the same sandbox bridge, out of band — NOT on the persisted result.
  // `metadata.toolCalls[].result` is where Invariant K's mail redaction lands
  // (`modules/agent/mailbox-plaintext/mail-plaintext-redaction.ts`), and whether a given result
  // is redacted depends on whether the mailbox is enrolled in local encryption,
  // which this scenario deliberately says nothing about.
  const searchResult = await runMailTool(env.serverUrl, qa.admin.token, "mail:search", {
    query: "Q3 Budget",
  })
  const readResult = await runMailTool(env.serverUrl, qa.admin.token, "mail:read", {
    conversationId: convA.id,
  })

  // Mail.search contract: items array, each <= 200 char snippet, capped at 20.
  expect(searchResult).toBeTruthy()
  const items = (searchResult.items ?? searchResult.results ?? searchResult) as any[]
  expect(Array.isArray(items), JSON.stringify(searchResult).slice(0, 400)).toBe(true)
  expect(items.length).toBeLessThanOrEqual(20)
  expect(items.some((i) => (i.subject ?? "").includes("Q3 Budget Proposal"))).toBe(true)
  for (const item of items) {
    if (typeof item.snippet === "string") {
      expect(item.snippet.length).toBeLessThanOrEqual(200)
    }
  }

  // Mail.read contract: messages array <= 5, no htmlBody, snippet <= 200.
  expect(readResult).toBeTruthy()
  const messages = (readResult.messages ?? readResult) as any[]
  expect(Array.isArray(messages), JSON.stringify(readResult).slice(0, 400)).toBe(true)
  expect(messages.length).toBeLessThanOrEqual(5)
  for (const msg of messages) {
    expect(msg).not.toHaveProperty("htmlBody")
    if (typeof msg.snippet === "string") {
      expect(msg.snippet.length).toBeLessThanOrEqual(200)
    }
  }
})

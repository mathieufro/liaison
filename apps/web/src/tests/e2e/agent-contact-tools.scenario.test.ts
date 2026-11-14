// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent contact tools, end to end in the browser: the agent discovers the merge
// tool, searches the registry, reads the duplicate and proposes the merge; the
// user confirms; the merge is staged for approval and, once approved, the
// duplicate really is gone from the contacts list.
//
// P4c-T21b: this used to stub `**\/api/agent/chat` SSE, perform the merge
// out-of-band over the API, and replay a fake tool-call transcript back to the
// retired panel — nothing about the tools was actually exercised. The turn is
// now scripted on the SERVER (`agent-turn.ts`) and only the MODEL is scripted:
// every tool call below executes for real through the tool bridge. Which is why
// the shape of the scenario had to follow the real rules:
//
//   - `contacts_merge` is a DEFERRED tool, absent from the turn's active tool
//     set until `tool_search` loads it, so the discovery step is part of the
//     behaviour under test, not scaffolding.
//   - `contacts_merge` is GATED (irreversible), so it stages a pending approval
//     instead of running; the scenario approves it the way a human does.
//   - the merge is a SECOND turn. Scope taint (`modules/agent/scopes/scope-taint.ts`)
//     refuses a write to a non-enforcing sink once a turn has made scoped reads,
//     and `contacts_merge` declares no `writesToTable`, so a turn that has
//     already read contacts cannot also merge them (E_SCOPE_TAINT_BLOCKED). A
//     real agent hits the same wall, and a real user confirms before an
//     irreversible merge anyway.
import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import { expandToolRollups, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { decideApproval, listPendingApprovals } from "./helpers/approvals"

const PROPOSAL = "S. Rossi looks like a duplicate of Sofia Rossi. Shall I merge them?"
const ANSWER = "Merged S. Rossi into Sofia Rossi."

async function resolveContact(
  serverUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string | null; email: string | null }> {
  const res = await api(serverUrl, "/api/contacts/resolve", { token, body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as { id: string; name: string | null; email: string | null }
}

test("agent contact tools merge Sofia duplicate pair", async ({ page, env, world, qa }) => {
  await seedModelPricingAndCredits(env, world.org.id)
  const token = qa.admin.token
  const sofia = await resolveContact(env.serverUrl, token, {
    email: "sofia.rossi@studio.test",
    name: "Sofia Rossi",
    company: "Rossi Studio",
    externalId: { phase5: `sofia-primary-${randomUUID()}` },
  })
  const duplicate = await resolveContact(env.serverUrl, token, {
    email: "s.rossi@studio.test",
    name: "S. Rossi",
    company: "Rossi Studio",
    externalId: { phase5: `sofia-duplicate-${randomUUID()}` },
  })

  const threadId = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      // Turn 1: discover, search, read, propose.
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "merge duplicate contacts" } }] },
      { toolCalls: [{ name: "kernel__contacts_search", args: { query: "Rossi" } }] },
      { toolCalls: [{ name: "kernel__contacts_read", args: { contactId: duplicate.id } }] },
      { text: PROPOSAL },
      // Turn 2: the merge itself, on a turn with no scoped read behind it.
      {
        toolCalls: [
          {
            name: "kernel__contacts_merge",
            args: {
              sourceId: duplicate.id,
              targetId: sofia.id,
              resolvedFields: { name: "Sofia Rossi", email: sofia.email, company: "Rossi Studio" },
            },
          },
        ],
      },
      { text: ANSWER },
    ],
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  const conversation = await openAgentConversation(page)
  await sendInConversation(page, conversation, "is S. Rossi a duplicate of Sofia Rossi?")
  await waitForTurnEnd(env, { threadId, token, contains: PROPOSAL })

  // The read tools ran through the bridge and are rendered in the turn.
  await expect(conversation.getByText(PROPOSAL).first()).toBeVisible({ timeout: 30_000 })
  await expandToolRollups(conversation)
  for (const toolName of [
    "kernel__tool_search",
    "kernel__contacts_search",
    "kernel__contacts_read",
  ]) {
    await expect(conversation.locator(`[data-tool-name="${toolName}"]`).first()).toBeVisible({
      timeout: 20000,
    })
  }

  await sendInConversation(page, conversation, "yes, merge them")
  await waitForTurnEnd(env, { threadId, token, contains: ANSWER })
  await expect(
    conversation.locator('[data-tool-name="kernel__contacts_merge"]').first(),
  ).toBeVisible({ timeout: 20000 })

  // GATED: the real bridge staged the merge instead of running it. Nothing is
  // merged until a human approves — which is what happens now.
  const pending = await listPendingApprovals({ serverUrl: env.serverUrl, token })
  const mergeRequest = pending.find((p) => p.toolName.includes("contacts_merge"))
  expect(mergeRequest, `no pending contacts_merge in ${JSON.stringify(pending)}`).toBeTruthy()
  const decided = await decideApproval({
    serverUrl: env.serverUrl,
    token,
    requestId: (mergeRequest as { id: string }).id,
    decision: "approve",
  })
  expect(decided.status, JSON.stringify(decided.body)).toBe(200)

  // The survivor stays, the duplicate is gone — from the real contacts list.
  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 20000 })
  await page.getByTestId("contacts-search").fill("Sofia")
  await expect(page.getByTestId(`contact-row-${sofia.id}`)).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId(`contact-row-${duplicate.id}`)).toHaveCount(0)
})

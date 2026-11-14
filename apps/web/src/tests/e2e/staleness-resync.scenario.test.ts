// SPDX-License-Identifier: FSL-1.1-ALv2
// staleness.resync-ws-and-activation-revalidation — mutate server state
// directly (a ticket row with NO WS event of its own) and verify Home's
// attention feed converges to it either via an UNRELATED WS resync trigger
// (A2/A3: ANY kernel WS event with a registered handler that calls
// attentionStore.markStaleAndReload bumps the shared feed and refetches the
// WHOLE thing in place — including rows that never had their own push) or
// via tab activation-revalidation once STALE_AFTER_MS has elapsed (A1/A3),
// with zero ticket-specific interaction in either case.
//
// The unrelated trigger here is an approval-request WS create event (the
// same deterministic mechanism home-needs-decision.scenario.test.ts and
// attention-feed.scenario.test.ts rely on). A mail-conversation WS event was
// tried first and instrumented directly (request/response/frame listeners) —
// it never arrived at all in this harness (zero "conversation" WS frames
// observed across repeated runs), matching the documented flake note in
// mail-conversations.scenario.test.ts ("Realtime delivery depends on outbox worker
// processing events in the worker-prefixed schema... may not be picked up").
// The approval path is not subject to that flake and is what the existing
// suite already leans on for deterministic live-WS assertions.
//
// Home's empty-state testid is not a reliable pre-condition here — this
// worker's QA seed already carries other queued attention items (thread
// replies, knowledge reviews) — so both tests assert on the SPECIFIC new row
// appearing rather than empty -> non-empty.
import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"
import { seedGatedApproval } from "./helpers/approvals-seed"
import {
  grantPhase8AttentionScopes,
  refreshStoredAttention,
  resetAttentionForUser,
} from "./helpers/projects-seed"
import { seedInbox } from "./helpers/seed"

async function seedAwaitingAgentTicket(
  env: { db: { sql: any }; schemaPrefix: string },
  orgId: string,
  inboxId: string,
  subject: string,
): Promise<string> {
  const ticketId = randomUUID()
  const ts = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await env.db.sql.unsafe(
    `INSERT INTO ${ts}.tickets (
       id, org_id, handle, subject, status, priority, channel, sensitivity,
       reply_token, sla_target_seconds, sla_deadline,
       sla_active_started_at, sla_elapsed_seconds, message_count,
       source_inbox_id, last_inbound_at, last_message_at,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'open', 'normal', 'manual', 'internal',
       $5, 3600, now() + interval '1 hour',
       now() - interval '5 minutes', 300, 1,
       $6, now() - interval '5 minutes', now() - interval '5 minutes',
       now() - interval '5 minutes', now() - interval '5 minutes'
     )`,
    [ticketId, orgId, `stale-${ticketId.slice(0, 8)}`, subject, replyToken, inboxId],
  )
  await env.db.sql.unsafe(
    `INSERT INTO ${ts}.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'inbound', 'staleness seed', now() - interval '5 minutes', now(), now())`,
    [orgId, ticketId],
  )
  return ticketId
}

test("staleness.ws-resync-updates-home-without-tab-click", async ({ page, env, qa, world }) => {
  await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
  await resetAttentionForUser(env, world.org.id, qa.admin.token)
  const inbox = await seedInbox(env, world.org.id, {
    name: `StaleWs-${Date.now()}`,
    emailAddress: `stalews-${Date.now()}@e2e.test`,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home")).toBeVisible()

  // Mutate server state directly: a ticket row with no WS event of its own
  // (tickets attention has no dedicated push — see bootstrap.ts's wsMessages
  // handlers, which cover approval_request/scope_request/mail:conversation
  // only). This is the row the resync bus must surface.
  const ticketId = await seedAwaitingAgentTicket(
    env,
    world.org.id,
    inbox.id,
    "WS resync journey ticket",
  )
  const ticketRow = page.locator(`[data-testid="attention-row-tickets-ticket-${ticketId}"]`)
  await expect(ticketRow).toHaveCount(0)
  // Home reads the stored attention lists, and a row written straight into the
  // table wakes no refresh: recompute them as the minute tick would. The
  // refresh is queued (one interval at most), so the wait below covers it.
  await refreshStoredAttention(env, world.org.id)

  // Fire an UNRELATED kernel WS event: an approval request naming Elodie as
  // a notify target, queued via the real outbox pipeline (pending_events ->
  // outbox worker -> Redis -> WS). bootstrap.ts's approval_request handler
  // calls attentionStore.markStaleAndReload on `create`, which refetches the
  // WHOLE feed in place — surfacing the ticket row above too, even though
  // the ticket mutation itself never touched a WS event.
  await seedGatedApproval(env, world.org.id, {
    requesterUserId: qa.amina.id,
    participantUserIds: [qa.admin.id],
    approverUserIds: [qa.admin.id],
    title: "Staleness journey approval",
  })

  // No click anywhere: the WS resync path alone must surface the ticket row.
  await expect(ticketRow).toBeVisible({ timeout: 30_000 })
})

test("staleness.activation-revalidation-past-threshold", async ({ page, env, qa, world }) => {
  // The OTHER half of A3: a mutation with NO WS coverage AND no unrelated WS
  // event to piggyback on either — the only way it can surface is tab
  // activation revalidation once STALE_AFTER_MS has elapsed (A1
  // createStaleResource / A3's Home activation effect). STALE_AFTER_MS has no
  // test-env override (createStaleResource.ts / Home.tsx both hardcode the
  // 60s constant), so this genuinely waits past it in real time rather than
  // faking the clock — a documented deviation in favor of not adding a
  // production backdating hook just for this test.
  const STALE_AFTER_MS = 60_000
  test.setTimeout(120_000)
  await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
  await resetAttentionForUser(env, world.org.id, qa.admin.token)
  const inbox = await seedInbox(env, world.org.id, {
    name: `StaleAct-${Date.now()}`,
    emailAddress: `staleact-${Date.now()}@e2e.test`,
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home")).toBeVisible()

  const ticketId = await seedAwaitingAgentTicket(
    env,
    world.org.id,
    inbox.id,
    "Activation revalidation journey ticket",
  )
  const ticketRow = page.locator(`[data-testid="attention-row-tickets-ticket-${ticketId}"]`)
  await expect(ticketRow).toHaveCount(0)

  // Navigate Home out of view (Settings is always reachable regardless of
  // scopes) so the Home tab becomes inactive while attentionStore.lastFetchedAt
  // stays frozen at its initial-mount value. Keep-alive keeps Home mounted
  // (display:none), so it must be checked as hidden, not absent.
  await page.getByTestId("activity-settings").click()
  await expect(page.getByTestId("home")).toBeHidden()

  await page.waitForTimeout(STALE_AFTER_MS + 1_000)

  // Reactivate Home: createStaleResource/Home's activation effect sees
  // elapsed > STALE_AFTER_MS and reloads — the new ticket row must appear
  // without ever having clicked anything ticket-related, and with no WS
  // event ever queued for it.
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home")).toBeVisible()
  await expect(ticketRow).toBeVisible({ timeout: 15000 })
})

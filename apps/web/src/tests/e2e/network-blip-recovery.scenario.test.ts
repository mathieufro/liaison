// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S26: a network blip while a routine writes a ticket note.
//
// The case this reproduces: a ticket is open, the connection drops without the
// socket closing (Wi-Fi gone, a VPN cut, a laptop lid), a routine adds a note
// to that ticket during the gap, and the note never shows: the client keeps
// trusting a dead socket for a minute or more, and when it finally resyncs the
// reload joins a ticket load the blip left hanging, which never settles.
//
// Two cases:
//   1. Half-open socket plus a hung load. The routed socket stops forwarding in
//      both directions without closing, the network refuses new connections
//      until the routine has written, and a ticket load started BEFORE the gap
//      is held forever. The client must notice the dead socket within 10 s,
//      reconnect once the network is back, and show the note within 5 s of
//      that reconnect through a NEW load (the held one is never released).
//   2. Offline for 20 s. The browser goes offline and the routed socket goes
//      silent for the same 20 s while the routine writes. The note shows
//      within 5 s of the socket being connected again.
//
// The routine's turn is scripted on the server (`scriptRoutineRun`): the model
// waits 3 s, then calls the REAL `tickets__addNote` tool, so the note is a real
// row written by a real routine run, announced over the real outbox.
import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import type { Page, Route, WebSocketRoute } from "@playwright/test"
import { scriptRoutineRun } from "./agent-turn"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { pollUntil } from "./helpers/agent-test-fixtures"
import { freshAccessToken } from "./helpers/fresh-token"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import { queueTicketMessageCreated } from "./helpers/tickets-events"

/** One routed socket: forwards both ways until the test blackholes it. */
interface RoutedSocket {
  connectedAt: number
  dead: boolean
}

/**
 * Route every `/ws` socket through the test so it can go silent on demand.
 * `blackhole()` stops forwarding on every socket open now, in both directions,
 * WITHOUT closing anything: what a dropped network looks like to a browser.
 * A close from the page still reaches the server (the client giving up on a
 * dead socket is a real close).
 */
async function routeSockets(page: Page) {
  const sockets: RoutedSocket[] = []
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws"),
    (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      const entry: RoutedSocket = { connectedAt: Date.now(), dead: false }
      sockets.push(entry)
      ws.onMessage((m) => {
        if (!entry.dead) server.send(m)
      })
      server.onMessage((m) => {
        if (!entry.dead) ws.send(m)
      })
      ws.onClose(() => void server.close())
      server.onClose((code, reason) => {
        if (!entry.dead) void ws.close({ code, reason })
      })
    },
  )
  return {
    count: () => sockets.length,
    blackhole: () => {
      for (const s of sockets) s.dead = true
    },
    lastConnectedAt: () => sockets[sockets.length - 1]?.connectedAt ?? 0,
  }
}

/** The socket's status as the page shows it. The activity bar draws a status
 *  indicator only while the socket is NOT connected, so its absence is the
 *  page's own "connected" (the stack serves a production build, which keeps
 *  no test attribute on the document). Read in ONE step: the indicator goes
 *  away the moment the socket reconnects, so a count followed by a separate
 *  attribute read can find it, then wait 10 s for an element that is gone. */
async function wsStatus(page: Page): Promise<string> {
  return page
    .getByTestId("activity-bar")
    .getByTestId("ws-status-indicator")
    .evaluateAll((els) =>
      els.length === 0 ? "connected" : (els[0]?.getAttribute("data-ws-status") ?? "unknown"),
    )
}

function tq(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

/** The routine that writes the note, scripted: 3 s of "thinking", then the
 *  real add-note tool on `ticketId`, then a closing line. */
async function createNoteRoutine(
  env: Parameters<typeof scriptRoutineRun>[0],
  token: string,
  ticketId: string,
  noteText: string,
): Promise<string> {
  const created = await api(env.serverUrl, "/api/agent/routines", {
    method: "POST",
    token,
    body: {
      name: `blip-note-${randomUUID().slice(0, 8)}`,
      description: "adds a note to a ticket",
      kind: "recurring",
      cron: "0 8 * * *",
      timezone: "UTC",
      visibility: "personal",
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      prompt: `Add the note "${noteText}" to ticket ${ticketId}.`,
    },
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const routineId = (created.body as { data: { id: string } }).data.id
  await scriptRoutineRun(env, {
    routineId,
    steps: [
      {
        delayMs: 3000,
        toolCalls: [{ name: "tickets__addNote", args: { ticketId, text: noteText } }],
      },
      { text: "Note added." },
    ],
  })
  return routineId
}

async function runNow(
  env: Parameters<typeof scriptRoutineRun>[0],
  email: string,
  routineId: string,
): Promise<void> {
  // A fresh token: the browser login and the scope grant both move the
  // admin's session on, which retires the fixture's token.
  const token = await freshAccessToken(env.serverUrl, email, "12345678")
  const run = await api(env.serverUrl, `/api/agent/routines/${routineId}/run-now`, {
    method: "POST",
    token,
  })
  expect(run.status, JSON.stringify(run.body)).toBe(202)
}

/** Poll until the routine's note row exists; returns its message id. */
async function waitForNoteRow(
  env: Parameters<typeof scriptRoutineRun>[0],
  ticketId: string,
  noteText: string,
): Promise<string> {
  return pollUntil(
    async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT id FROM ${tq(env)}.messages WHERE ticket_id = $1 AND kind = 'note'
           AND text_body LIKE $2`,
        [ticketId, `%${noteText}%`],
      )) as unknown as Array<{ id: string }>
      return rows[0]?.id ?? null
    },
    { timeout: 45_000, interval: 250, label: "routine-note-row" },
  )
}

test.describe("Network blip recovery", () => {
  test.beforeEach(async ({ env, world, qa }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await grantTicketsScopes(env, world.org.id, qa.admin.id)
  })

  test("a half-open socket and a hung ticket load still show the routine's note", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    const orgId = world.org.id
    const stamp = Date.now()
    const inbox = await seedInbox(env, orgId, {
      name: `Blip inbox ${stamp}`,
      emailAddress: `blip-${stamp}@e2e.test`,
      isDefault: true,
    })
    const ticket = await seedTicket(env, orgId, {
      subject: `Blip ticket ${stamp}`,
      sourceInboxId: inbox.id,
    })
    const noteText = `Blip note ${stamp}`
    const routineId = await createNoteRoutine(
      env,
      await freshAccessToken(env.serverUrl, qa.admin.email, "12345678"),
      ticket.id,
      noteText,
    )

    const sockets = await routeSockets(page)

    // Every message load of THIS ticket goes through here. While `holdLoads`
    // is on, a load is held forever: never fulfilled, never released.
    let holdLoads = false
    const held: Route[] = []
    let loadsAfterHold = 0
    await page.route("**/api/apps/run-tool", async (route) => {
      const body = route.request().postDataJSON() as {
        toolName?: string
        params?: { ticketId?: string; includeHtml?: boolean }
      } | null
      const isMessageLoad =
        body?.toolName === "tickets:get" &&
        body.params?.ticketId === ticket.id &&
        body.params.includeHtml === true
      if (isMessageLoad && holdLoads) {
        held.push(route)
        return
      }
      if (isMessageLoad && held.length > 0) loadsAfterHold += 1
      await route.continue()
    })

    // The network itself: while down, the socket's ticket exchange fails like
    // any request on a dead network, so no new socket can open.
    let networkDown = false
    await page.route("**/api/auth/ws-ticket", async (route) => {
      if (networkDown) await route.abort("internetdisconnected")
      else await route.continue()
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("tickets-conversation")).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => wsStatus(page), { timeout: 20_000 }).toBe("connected")
    // Settle: the open's own loads are done before the hold arms.
    await page.waitForLoadState("networkidle")

    // A ticket load starts BEFORE the gap (a customer reply announced without
    // its body reloads the open thread) and hangs: the blip swallowed it.
    holdLoads = true
    await queueTicketMessageCreated(env, orgId, ticket.id, {
      id: randomUUID(),
      kind: "inbound",
      textBody: null,
    })
    await expect.poll(() => held.length, { timeout: 15_000 }).toBeGreaterThan(0)
    holdLoads = false

    // The gap: the socket goes half-open and the network refuses new ones.
    const socketsBefore = sockets.count()
    const tBlackhole = Date.now()
    networkDown = true
    sockets.blackhole()
    await runNow(env, qa.admin.email, routineId)

    // Detection: the client stops trusting the silent socket within 10 s.
    await expect
      .poll(() => wsStatus(page), { timeout: 10_000, intervals: [100] })
      .not.toBe("connected")
    const tDetect = Date.now()

    // The routine writes its note during the gap.
    const noteId = await waitForNoteRow(env, ticket.id, noteText)
    const tNoteRow = Date.now()
    await expect(page.getByTestId(`tickets-message-${noteId}`)).toHaveCount(0)

    // The network is back: a new routed socket connects.
    networkDown = false
    const tRestore = Date.now()
    await expect.poll(() => sockets.count(), { timeout: 45_000 }).toBeGreaterThan(socketsBefore)
    await expect.poll(() => wsStatus(page), { timeout: 15_000, intervals: [100] }).toBe("connected")
    const tReconnect = Date.now()

    // Catch-up: the note shows within 5 s of the reconnect, through a NEW load.
    await expect(page.getByTestId(`tickets-message-${noteId}`)).toBeVisible({ timeout: 5_000 })
    const tVisible = Date.now()
    // The reconnect's own resync starts that new load (loadTicket restart,
    // ticket-detail-store.ts) a beat after the transition, while the server's
    // replay of the missed note event can paint the note first: wait for the
    // load instead of reading the count at once.
    await expect
      .poll(() => loadsAfterHold, {
        timeout: 5_000,
        message: "no new ticket load started after the reconnect",
      })
      .toBeGreaterThan(0)

    console.log(
      `[S26 case 1] detection ${tDetect - tBlackhole} ms after blackhole; note row ` +
        `${tNoteRow - tBlackhole} ms; reconnect ${tReconnect - tRestore} ms after restore; ` +
        `note visible ${tVisible - tReconnect} ms after reconnect; held loads ${held.length}`,
    )
  })

  test("twenty seconds offline while the routine writes, the note shows on reconnect", async ({
    page,
    context,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    const orgId = world.org.id
    const stamp = Date.now()
    const inbox = await seedInbox(env, orgId, {
      name: `Offline inbox ${stamp}`,
      emailAddress: `offline-${stamp}@e2e.test`,
      isDefault: true,
    })
    const ticket = await seedTicket(env, orgId, {
      subject: `Offline ticket ${stamp}`,
      sourceInboxId: inbox.id,
    })
    const noteText = `Offline note ${stamp}`
    const routineId = await createNoteRoutine(
      env,
      await freshAccessToken(env.serverUrl, qa.admin.email, "12345678"),
      ticket.id,
      noteText,
    )

    const sockets = await routeSockets(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(page.getByTestId("tickets-conversation")).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => wsStatus(page), { timeout: 20_000 }).toBe("connected")

    // 20 s offline; the routed socket goes silent for the same 20 s (the route
    // runs outside the browser, so going offline alone would not cut it).
    const socketsBefore = sockets.count()
    const tOffline = Date.now()
    await context.setOffline(true)
    sockets.blackhole()
    await runNow(env, qa.admin.email, routineId)

    await expect
      .poll(() => wsStatus(page), { timeout: 10_000, intervals: [100] })
      .not.toBe("connected")
    const tDetect = Date.now()

    const noteId = await waitForNoteRow(env, ticket.id, noteText)
    const tNoteRow = Date.now()
    const remaining = 20_000 - (Date.now() - tOffline)
    if (remaining > 0) await page.waitForTimeout(remaining)
    await context.setOffline(false)
    const tOnline = Date.now()

    await expect.poll(() => sockets.count(), { timeout: 30_000 }).toBeGreaterThan(socketsBefore)
    await expect.poll(() => wsStatus(page), { timeout: 15_000, intervals: [100] }).toBe("connected")
    const tReconnect = Date.now()
    await expect(page.getByTestId(`tickets-message-${noteId}`)).toBeVisible({ timeout: 5_000 })
    const tVisible = Date.now()

    console.log(
      `[S26 case 2] detection ${tDetect - tOffline} ms after going offline; note row ` +
        `${tNoteRow - tOffline} ms; reconnect ${tReconnect - tOnline} ms after online; ` +
        `note visible ${tVisible - tReconnect} ms after reconnect`,
    )
  })
})

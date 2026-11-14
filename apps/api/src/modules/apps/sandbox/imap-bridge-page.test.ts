// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import {
  attachImapErrorHandler,
  fetchImapPage,
  findImapTextParts,
  type ImapCredentials,
  withImapClient,
} from "~/modules/apps/sandbox/imap-bridge"
import { fakeImapServer as fakeServer } from "./__test-helpers__/fake-imap-server"

const CREDS: ImapCredentials = {
  host: "imap.example.test",
  port: 993,
  username: "u",
  password: "p",
}

// A years-old mailbox: 50 000 sparse UIDs.
const BIG = Array.from({ length: 50_000 }, (_, i) => 14_000 + i * 3)
const TOP = BIG[BIG.length - 1]

describe("fetchImapPage on a 50 000-message folder", () => {
  it("the first page of a newest-first walk reads only the newest batch, read-only", async () => {
    const { client, stats } = fakeServer({ uids: BIG })
    const page = await fetchImapPage(client, { mode: "full", order: "newest", batchSize: 25 })

    expect(page.messages.map((m) => Number(m.externalProviderId))).toEqual(BIG.slice(-25).reverse())
    expect(page.highest).toBe(String(TOP))
    expect(page.cursor).toBe(String(TOP))
    expect(page.done).toBe(false)
    expect(page.nextBefore).toBe(String(BIG[BIG.length - 25]))
    // Bounded: one SEARCH, one FETCH of 25 envelopes, 25 downloads.
    expect(stats.searches).toHaveLength(1)
    expect(stats.fetchRanges).toHaveLength(1)
    expect(stats.fetchedRows).toBe(25)
    expect(stats.downloads).toHaveLength(25)
    expect(stats.lockedReadOnly).toEqual([true])
    expect(page.messages[0]?.subject).toBe(`S${TOP}`)
    expect(page.messages[0]?.textBody).toContain(`Body of ${TOP}`)
  })

  it("stores the headers that tell a newsletter from a reply", async () => {
    const { client } = fakeServer({ uids: [1, 2] })
    const page = await fetchImapPage(client, { mode: "full", order: "newest", batchSize: 25 })
    expect(page.messages[0]?.headers).toEqual({
      "list-id": "<news.example.test>",
      precedence: "bulk",
    })
  })

  it("a later page reads the next batch below `before`, and the last one says done", async () => {
    const { client, stats } = fakeServer({ uids: BIG })
    const before = String(BIG[100])
    const page = await fetchImapPage(client, {
      mode: "full",
      order: "newest",
      batchSize: 25,
      before,
    })
    expect(page.messages.map((m) => Number(m.externalProviderId))).toEqual(
      BIG.slice(75, 100).reverse(),
    )
    expect(page.nextBefore).toBe(String(BIG[75]))
    expect(page.highest).toBeUndefined()
    expect(stats.searches).toEqual([{ uid: `1:${BIG[100] - 1}` }])
    expect(stats.fetchedRows).toBe(25)

    const last = await fetchImapPage(client, {
      mode: "full",
      order: "newest",
      batchSize: 25,
      before: String(BIG[10]),
    })
    expect(last.messages).toHaveLength(10)
    expect(last.done).toBe(true)
    expect(last.nextBefore).toBeNull()
  })

  it("an incremental page reads only the oldest batch above the cursor", async () => {
    const { client, stats } = fakeServer({ uids: BIG })
    const cursor = String(BIG[BIG.length - 100])
    const page = await fetchImapPage(client, { mode: "incremental", batchSize: 25, cursor })
    expect(page.messages.map((m) => Number(m.externalProviderId))).toEqual(BIG.slice(-99, -74))
    expect(page.done).toBe(false)
    expect(page.nextCursor).toBe(String(BIG[BIG.length - 75]))
    expect(stats.fetchedRows).toBe(25)
  })

  it("nothing new: `n:*` matching the top message imports nothing", async () => {
    const { client } = fakeServer({ uids: BIG })
    const page = await fetchImapPage(client, {
      mode: "incremental",
      batchSize: 25,
      cursor: String(TOP),
    })
    expect(page.messages).toEqual([])
    expect(page.done).toBe(true)
    expect(page.cursor).toBe(String(TOP))
  })

  it("stops starting messages once the page's time budget is spent", async () => {
    const { client, stats } = fakeServer({ uids: BIG })
    let clock = 0
    const page = await fetchImapPage(
      client,
      { mode: "full", order: "newest", batchSize: 25 },
      {
        softBudgetMs: 10_000,
        // Each look at the clock is 3 s later: a slow server.
        now: () => {
          clock += 3_000
          return clock
        },
      },
    )
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(25)
    expect(stats.downloads.length).toBe(page.messages.length)
    // The next page starts right below the last message imported.
    const lastUid = Number(page.messages[page.messages.length - 1]?.externalProviderId)
    expect(page.nextBefore).toBe(String(lastUid))
    expect(page.done).toBe(false)
  })

  it("a message over the body cap is read as its text part only, never downloaded whole", async () => {
    const { client, stats } = fakeServer({ uids: BIG, sizes: { [TOP]: 26_000_000 } })
    const page = await fetchImapPage(client, { mode: "full", order: "newest", batchSize: 2 })
    const big = stats.downloads.filter((d) => d.uid === TOP)
    expect(big).toEqual([{ uid: TOP, part: "1", maxBytes: 256 * 1024 }])
    expect(page.messages[0]?.textBody).toBe(`Text part 1 of ${TOP}`)
    expect(page.messages[0]?.attachments).toBeUndefined()
  })

  it("a page stops once its 10 MB of bodies are spent; the rest is the next page's", async () => {
    const sizes: Record<number, number> = {}
    for (const uid of BIG.slice(-25)) sizes[uid] = 900_000
    const { client, stats } = fakeServer({ uids: BIG, sizes })
    const page = await fetchImapPage(client, { mode: "full", order: "newest", batchSize: 25 })
    // 11 bodies of ~0.9 MB fit in 10 MB; the 12th would not, and is not downloaded.
    expect(page.messages).toHaveLength(11)
    expect(stats.downloads).toHaveLength(11)
    expect(page.done).toBe(false)
    expect(page.nextBefore).toBe(String(BIG[BIG.length - 11]))
  })

  it("a lost connection ends the page with what it has; the rest is the next page's", async () => {
    const { client } = fakeServer({
      uids: BIG,
      failDownload: (uid) => {
        if (uid !== BIG[BIG.length - 3]) return null
        client.usable = false
        return new Error("Connection closed")
      },
    })
    const page = await fetchImapPage(client, { mode: "full", order: "newest", batchSize: 25 })
    expect(page.messages).toHaveLength(2)
    expect(page.nextBefore).toBe(String(BIG[BIG.length - 2]))
  })

  it("a lost connection before any message fails the page (retried later)", async () => {
    const { client } = fakeServer({
      uids: BIG,
      failDownload: () => {
        client.usable = false
        return new Error("Connection closed")
      },
    })
    await expect(
      fetchImapPage(client, { mode: "full", order: "newest", batchSize: 25 }),
    ).rejects.toThrow("IMAP connection lost")
  })
})

describe("findImapTextParts", () => {
  it("finds the text parts of a multipart message and skips attachments", () => {
    expect(
      findImapTextParts({
        childNodes: [
          {
            childNodes: [
              { part: "1.1", type: "text/plain" },
              { part: "1.2", type: "text/html" },
            ],
          },
          { part: "2", type: "text/plain", disposition: "attachment" },
        ],
      }),
    ).toEqual({ plain: "1.1", html: "1.2" })
  })

  it("a single-part message's body is part 1", () => {
    expect(findImapTextParts({ type: "text/html" })).toEqual({ html: "1" })
  })
})

describe("an IMAP connection error never ends the process", () => {
  it("an 'error' emitted later on the client is logged and closes it", async () => {
    const client = Object.assign(new EventEmitter(), { closed: 0, close() {} })
    client.close = () => {
      client.closed++
    }
    attachImapErrorHandler(client)
    // An EventEmitter without an 'error' listener throws the error: the crash.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(() => client.emit("error", new Error("Socket timeout"))).not.toThrow()
        resolve()
      }, 5),
    )
    expect(client.closed).toBe(1)
  })

  it("a call past its bound is closed (not logged out) and fails, instead of holding the job", async () => {
    let closed = 0
    let loggedOut = 0
    const stalled = {
      ...fakeServer({ uids: [1] }).client,
      async list(): Promise<never> {
        return new Promise(() => {})
      },
      close() {
        closed++
      },
      async logout() {
        loggedOut++
      },
    }
    const started = Date.now()
    await expect(
      withImapClient(
        CREDS,
        async () => "never",
        50,
        async () => stalled,
      ),
    ).rejects.toThrow("IMAP timeout")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(closed).toBe(1)
    expect(loggedOut).toBe(0)
  })
})

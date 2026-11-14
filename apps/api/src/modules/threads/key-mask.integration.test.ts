// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A payment key or a card number that reaches the server anyway (an API call
// that never went through the composer) is masked on the way in. Masking runs
// on the value before it is inserted, queued or indexed, so the stored row, the
// queued event, the search document and the next model request all hold the
// masked text and none holds the original.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import pino from "pino"
import { app } from "~/app"
import { sql } from "~/db"
import * as searchClientModule from "~/infra/search/client"
import { rootLogger } from "~/lib/logger"
import { assembleContext, resetSystemPromptCache } from "~/modules/agent/context/context"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import * as minimal from "~/seed/tiers/minimal"
import { buildUserContext } from "~/tests/helpers/agent-ctx"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Full-length key shapes, live and test, and a Luhn-valid Visa number.
const LIVE_SECRET = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQ"}`
const TEST_SECRET = `sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}`
const LIVE_RESTRICTED = `rk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQrS"}`
const TEST_RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`
const SIGNING = `whsec_${"Kx8pYQ2mZ7cV3nB6vR1tW9aS4dF0gH5j"}`
const KEYS = [LIVE_SECRET, TEST_SECRET, LIVE_RESTRICTED, TEST_RESTRICTED, SIGNING]
const PAN = "4917484589897107"
const PAN_SPACED = "4917 4845 8989 7107"

const INDEX_NAME = `test_paymask_${crypto.randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
/** Every document the indexer sends to the search engine. */
const indexed: unknown[] = []
const spies: Array<{ mockRestore: () => void }> = []

let orgId = ""
let userId = ""
let threadId = ""
let token = ""

/** No full card number in `value`, whatever separators it was written with. */
function holdsPan(value: unknown): boolean {
  const text = JSON.stringify(value)
  return text.includes(PAN) || text.includes(PAN_SPACED) || text.replace(/\D/g, "").includes(PAN)
}

async function post(content: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  const body = (await res.json()) as { data: Record<string, unknown> }
  return { status: res.status, data: body.data }
}

/** Every line any logger of the process writes while `fn` runs (they share one stream). */
async function captureLogLines(fn: () => Promise<void>): Promise<string[]> {
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => unknown }>)[
    pino.symbols.streamSym
  ]
  const lines: string[] = []
  const original = stream.write.bind(stream)
  const spy = spyOn(stream, "write").mockImplementation((line: string) => {
    lines.push(String(line))
    return original(line)
  })
  const level = rootLogger.level
  rootLogger.level = "trace"
  try {
    await fn()
  } finally {
    rootLogger.level = level
    spy.mockRestore()
  }
  return lines
}

async function storedContent(messageId: string): Promise<string> {
  const [row] = await sql<{ content: string }[]>`
    SELECT content FROM kernel.messages WHERE id = ${messageId}`
  return row?.content ?? ""
}

beforeAll(async () => {
  await acquireTestLock()
  ExternalSearchHandlersTestAccess.reset()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: (name: string) => {
        const real = meili.index(name)
        return {
          addDocuments: (docs: unknown[]) => {
            indexed.push(...docs)
            return real.addDocuments(docs as never)
          },
          deleteDocument: (id: string) => real.deleteDocument(id),
          deleteDocuments: (ids: unknown) => real.deleteDocuments(ids as never),
          getDocuments: (args: unknown) => real.getDocuments(args as never),
          updateSettings: (s: unknown) => real.updateSettings(s as never),
          search: (q: string, o: unknown) => real.search(q, o as never),
          getSettings: () => real.getSettings(),
        }
      },
      tasks: meili.tasks,
      httpRequest: (meili as unknown as { httpRequest: unknown }).httpRequest,
    } as unknown as ReturnType<typeof searchClientModule.getMeili>),
  )
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)

  const org = await minimal.secondOrg({ name: "Payment Mask Org" })
  orgId = org.orgId
  userId = org.adminUserId
  threadId = await minimal.thread(orgId, userId)
  token = await minimal.token(userId)
})

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  await meili.deleteIndex(INDEX_NAME).catch(() => {})
  await releaseTestLock()
})

describe("thread messages: payment keys and card numbers masked on the server", () => {
  it("a key-shaped value posted past the composer is stored masked", async () => {
    for (const key of KEYS) {
      const { status, data } = await post(`our key is ${key} please set it up`)
      expect(status).toBe(200)
      const id = String(data.id)
      const stored = await storedContent(id)
      for (const text of [stored, String(data.content)]) {
        expect(text).not.toContain(key)
        expect(text).toContain(`${key.slice(0, key.indexOf("_", 3) + 1)}••••••••`)
        expect(text).toContain("[A key was hidden.]")
      }
    }
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE org_id = ${orgId} AND (content LIKE '%sk\\_live\\_51%' OR content LIKE '%whsec\\_Kx%'
         OR content LIKE '%rk\\_test\\_51%' OR content LIKE '%sk\\_test\\_4e%' OR content LIKE '%rk\\_live\\_51%')`
    expect(n).toBe(0)
  })

  it("a card number posted to a thread reaches the model request, the event payload and the search index as bullets", async () => {
    const { status, data } = await post(`Card ${PAN_SPACED} exp 12/27 CVC 737, can you charge it?`)
    expect(status).toBe(200)
    const messageId = String(data.id)

    // The row and the answer the poster gets back.
    const stored = await storedContent(messageId)
    expect(stored).toContain("•••• •••• •••• 7107")
    expect(stored).toContain("CVC •••")
    expect(stored).toContain("[A card number was hidden.]")
    expect(holdsPan(stored)).toBe(false)
    expect(holdsPan(data)).toBe(false)

    // The event queued with the row (live fan-out, consumers, notifications).
    const events = await sql<{ payload: unknown }[]>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${orgId} AND payload->>'entityId' = ${messageId}`
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) expect(holdsPan(e.payload)).toBe(false)
    expect(JSON.stringify(events[0]?.payload)).toContain("•••• •••• •••• 7107")

    // The search document the indexer writes for it.
    const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
    await processMessageIndexerJob({ action: "upsert", orgId, messageId })
    const docs = indexed.filter((d) => JSON.stringify(d).includes(messageId))
    expect(docs.length).toBeGreaterThan(0)
    for (const d of docs) expect(holdsPan(d)).toBe(false)
    expect(JSON.stringify(docs)).toContain("7107")

    // The next model request: the conversation the agent's turn is built from.
    resetSystemPromptCache()
    const actor = await buildUserContext(userId, orgId)
    const context = await assembleContext({ threadId, orgId, actor })
    const request = JSON.stringify(context.messages)
    expect(request).toContain("•••• •••• •••• 7107")
    expect(holdsPan(context.messages)).toBe(false)
    expect(holdsPan(context.system)).toBe(false)
  })

  it("an edited message is masked the same way", async () => {
    const { data } = await post("I will send the details in a moment")
    const res = await app.request(`/api/threads/${threadId}/messages/${String(data.id)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: `here: ${PAN} and ${LIVE_SECRET}` }),
    })
    expect(res.status).toBe(200)
    const stored = await storedContent(String(data.id))
    expect(holdsPan(stored)).toBe(false)
    expect(stored).not.toContain(LIVE_SECRET)
    expect(stored).toContain("[A card number and a key were hidden.]")
  })

  it("no log line written while a card number and a key are posted, read, indexed and delivered holds either", async () => {
    let messageId = ""
    const lines = await captureLogLines(async () => {
      const { data } = await post(`card ${PAN_SPACED} cvc 737 and key ${LIVE_RESTRICTED}`)
      messageId = String(data.id)
      const res = await app.request(`/api/threads/${threadId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const listed = JSON.stringify(await res.json())
      expect(listed).toContain(messageId)
      expect(holdsPan(listed)).toBe(false)
      expect(listed).not.toContain(LIVE_RESTRICTED)
      const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
      await processMessageIndexerJob({ action: "upsert", orgId, messageId })
      await drainOutbox()
    })
    // Positive control: the capture saw this request's own log lines.
    expect(lines.some((l) => l.includes(`/api/threads/${threadId}/messages`))).toBe(true)
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.filter((l) => holdsPan(l))).toEqual([])
    expect(lines.filter((l) => l.includes(LIVE_RESTRICTED))).toEqual([])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing's rows on a company's or a contact's timeline: issued, paid and
// credited, never a draft, read live, paged by (time, id) even when hundreds of
// documents share one issue day. The store below answers findMany as the app
// database does: equality and `in` only (any other operator is refused), order
// by the given keys with nulls first when descending, offset, at most 1 000 rows.

import { describe, expect, test } from "bun:test"
import { activityRead } from "./activity"
import { documentsSearch, type ReadsCtx } from "./reads"

type Doc = Record<string, unknown>

const MAX_ROWS = 1000

function store(docs: Doc[]) {
  const calls: Array<{ limit?: number; offset?: number }> = []
  const matches = (doc: Doc, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, cond]) => {
      const v = doc[k]
      if (cond && typeof cond === "object") {
        const keys = Object.keys(cond as object)
        if (keys.length !== 1 || keys[0] !== "in") throw new Error(`unsupported operator on ${k}`)
        return ((cond as { in: unknown[] }).in ?? []).includes(v)
      }
      return v === cond
    })
  const order = (keys: Array<[string, string]>) => (a: Doc, b: Doc) => {
    for (const [k, dir] of keys) {
      const x = a[k] ?? null
      const y = b[k] ?? null
      if (x === y) continue
      // Postgres: nulls sort as larger than any value, so first when descending.
      const c = x === null ? 1 : y === null ? -1 : String(x) < String(y) ? -1 : 1
      return dir === "desc" ? -c : c
    }
    return 0
  }
  return {
    docs,
    calls,
    findMany: async (
      _entity: string,
      o: {
        where?: Record<string, unknown>
        orderBy?: Record<string, string>
        limit?: number
        offset?: number
      } = {},
    ) => {
      calls.push({ limit: o.limit, offset: o.offset })
      const rows = docs.filter((d) => matches(d, o.where ?? {}))
      rows.sort(
        o.orderBy
          ? order(Object.entries(o.orderBy))
          : (a, b) => String(b.issued_at).localeCompare(String(a.issued_at)),
      )
      const offset = o.offset ?? 0
      return rows.slice(offset, offset + Math.min(o.limit ?? MAX_ROWS, MAX_ROWS))
    },
    findOne: async () => null,
    count: async () => 0,
  }
}

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
let n = 0
function doc(extra: Doc): Doc {
  n += 1
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "invoice",
    status: "issued",
    number: `F-2026-${String(n).padStart(4, "0")}`,
    number_int: n,
    counterparty_contact_id: ALICE,
    counterparty_name: "Nordlicht Studio",
    grand_total_minor: 174000,
    currency: "EUR",
    issued_at: "2026-03-02 00:00:00+00",
    paid_at: null,
    ...extra,
  }
}

const input = (before: { at: string; id: string } | null = null, limit = 30) => ({
  contactIds: [ALICE, BOB],
  companyId: null,
  dealIds: [],
  before,
  limit,
  prefix: "invoicing:",
})

describe("invoicing timeline source", () => {
  test("rows are issued, paid and credited, never a draft", async () => {
    const paid = doc({ paid_at: "2026-03-10T09:30:00.000Z" })
    const draft = doc({ status: "draft" })
    const credit = doc({
      type: "credit_note",
      number: "CN-2026-0001",
      issued_at: "2026-03-05 00:00:00+00",
    })
    const db = store([paid, draft, credit])
    const out = await activityRead({ db }, input())
    expect(out.rows.map((r) => r.title)).toEqual([
      `Invoice ${paid.number} paid`,
      "Credit note CN-2026-0001 credited, 1740.00 EUR",
      `Invoice ${paid.number} issued, 1740.00 EUR`,
    ])
    expect(out.rows.some((r) => r.id.startsWith(String(draft.id)))).toBe(false)
  })

  test("a recurring schedule billing the person is a row opening the schedule, with its cadence and amount", async () => {
    const schedule = {
      id: "55555555-5555-4555-8555-555555555555",
      contact_id: BOB,
      status: "active",
      repeats: "month",
      lines: JSON.stringify([{ description: "Retainer", qty: 1, unit_price_minor: 65000 }]),
      created_at: "2026-02-01T08:00:00.000Z",
    }
    const paused = {
      ...schedule,
      id: "66666666-6666-4666-8666-666666666666",
      status: "paused",
      repeats: "quarter",
      lines: [],
      created_at: "2026-01-01T08:00:00.000Z",
    }
    const out = await activityRead({ db: store([doc({}), schedule, paused]) }, input())
    const rows = out.rows.filter((r) => r.href?.entityType === "schedule")
    expect(rows.map((r) => [r.title, r.href?.entityId, r.contactId])).toEqual([
      ["Recurring schedule, monthly, 650.00 before VAT", schedule.id, BOB],
      ["Recurring schedule, quarterly (paused)", paused.id, BOB],
    ])
  })

  test("a deleted invoice is gone on the next call", async () => {
    const kept = doc({})
    const gone = doc({})
    const db = store([kept, gone])
    expect((await activityRead({ db }, input())).rows).toHaveLength(2)
    db.docs.splice(db.docs.indexOf(gone), 1)
    expect((await activityRead({ db }, input())).rows.map((r) => r.id)).toEqual([
      `${kept.id}:issued`,
    ])
  })

  /** Every page, as the kernel pages: by the last row of a full page. */
  async function pages(db: ReturnType<typeof store>, page?: number) {
    const seen: string[] = []
    let before: { at: string; id: string } | null = null
    for (let n = 0; n < 200; n++) {
      const out = await activityRead({ db }, input(before, 100), page)
      seen.push(...out.rows.map((r) => `invoicing:${r.id}`))
      const last = out.rows.at(-1)
      if (out.rows.length < 100 || !last) break
      before = { at: last.at, id: `invoicing:${last.id}` }
    }
    return seen
  }

  test("1 500 documents of one day page with no duplicate and no gap", async () => {
    const day = Array.from({ length: 1500 }, () => doc({ issued_at: "2026-04-01" }))
    const older = Array.from({ length: 20 }, (_, i) =>
      doc({ issued_at: `2026-03-${String(10 + i).padStart(2, "0")}` }),
    )
    const seen = await pages(store([...day, ...older]))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(1520)
  })

  test("past the database's 1 000 rows a call, every document of the day and every payment still comes back", async () => {
    // 2 600 documents on one day, more than two database pages, and payments
    // made long after documents read last.
    const day = Array.from({ length: 2600 }, () => doc({ issued_at: "2026-04-01" }))
    const lateLast = doc({ issued_at: "2025-01-02", paid_at: "2026-06-01" })
    const docs = [...day, lateLast]
    const db = store(docs)
    const seen = await pages(db)
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(seen)).toEqual(
      new Set([...docs.map((d) => `invoicing:${d.id}:issued`), `invoicing:${lateLast.id}:paid`]),
    )
    expect(seen[0]).toBe(`invoicing:${lateLast.id}:paid`)
    // Each call asks for at most what the database gives, and pages by offset.
    expect(db.calls.every((c) => (c.limit ?? 0) <= 1000)).toBe(true)
    expect(db.calls.some((c) => (c.offset ?? 0) >= 2000)).toBe(true)
  })

  test("a small page size reads every document across many calls", async () => {
    const docs = Array.from({ length: 30 }, (_, d) =>
      Array.from({ length: 50 }, () =>
        doc({ issued_at: `2026-05-${String(d + 1).padStart(2, "0")}` }),
      ),
    ).flat()
    const seen = await pages(store(docs), 120)
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(seen)).toEqual(new Set(docs.map((d) => `invoicing:${d.id}:issued`)))
  })

  test("documents search by company lists the documents made out to its people", async () => {
    const mine = doc({ counterparty_contact_id: BOB })
    const other = doc({ counterparty_contact_id: "33333333-3333-4333-8333-333333333333" })
    const db = store([mine, other])
    const calls: Array<[string, unknown]> = []
    const ctx = {
      db,
      kernel: {},
      executeTool: async (tool: string, params: unknown) => {
        calls.push([tool, params])
        return { status: "completed", result: { people: [{ id: BOB }] } }
      },
    } as unknown as ReadsCtx
    const rows = await documentsSearch(ctx, { company_id: "44444444-4444-4444-8444-444444444444" })
    expect(rows.map((r) => r.id)).toEqual([String(mine.id)])
    expect(calls).toEqual([
      ["kernel:companies_read", { companyId: "44444444-4444-4444-8444-444444444444" }],
    ])
  })
})

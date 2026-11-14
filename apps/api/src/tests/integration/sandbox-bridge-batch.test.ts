// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.db.batch` (sandbox/bridge/batch.ts) against a real database, on the
// session bridge a sandboxed run gets (each bridge call its own transaction,
// nothing held across the run):
//
//   - a numbered row and the rows that reference it commit in one call, the
//     number allocated inside it and formatted from the batch's own result;
//   - a batch whose later op fails writes nothing and consumes no number, so
//     the next batch takes the number the failed one would have had;
//   - the allocator steps past numbers rows written another way already hold;
//   - batches running at the same time never share a number and, with some of
//     them failing, still leave no gap: the committed numbers are exactly 1..n;
//   - `append` / `merge` add to json fields of the row as it is at commit, so a
//     write made between the app's read and the batch is kept;
//   - named `sequences` number two rows of two series in one commit, and a
//     failing op consumes neither number;
//   - an op's `expect` guard: a batch whose guarded op matched a row count
//     outside it writes nothing, consumes no number and rejects with a typed
//     `precondition_failed` (409) naming the op.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedOrgRow } from "~/seed/factories/org/rows"

const TEST_ORG = "00000000-0000-0000-0000-000000000b71"
const APP = "batch-bridge"
const SCHEMA = "app_batch_bridge"

const manifest = {
  name: APP,
  version: "1.0.0",
  _format: "manifest",
  capabilities: ["sequences.allocate"],
  // A scope reaches each table, so registration accepts the schema (only administrators could
  // read a table no declared scope reaches).
  scopes: ["batch-bridge:docs:read", "batch-bridge:doc_lines:read"],
  schema: {
    docs: {
      fields: {
        series: "string",
        number: "string?",
        number_int: "integer?",
        log: { type: "json", required: false },
        refs: { type: "json", required: false },
      },
      constraints: {
        unique: [{ columns: ["series", "number_int"], where: "number_int IS NOT NULL" }],
      },
    },
    doc_lines: {
      fields: {
        doc_id: { type: "uuid", references: { table: "docs", column: "id", onDelete: "cascade" } },
        label: "string",
      },
    },
  },
}

function bridge(): Record<string, any> {
  return createSessionRpcBridge(
    APP,
    "system:batch-bridge:test",
    TEST_ORG,
    // Each call its own committed transaction, as a sandboxed run's session gives it.
    { run: (fn) => withPrivilegedDb(TEST_ORG, "test", (tx) => fn(tx as unknown as RlsClient)) },
    manifest as never,
    undefined,
    "system",
  )
}

/** One numbered doc of `series` with two lines; `failLine` makes the second line invalid. */
function issueSpec(series: string, failLine = false) {
  return JSON.stringify({
    sequence: {
      key: `${APP}:${series}`,
      format: { prefix: `${series}-`, pad: 4 },
      unique: { entity: "docs", field: "number_int", where: { series } },
    },
    ops: [
      {
        insert: "docs",
        as: "doc",
        data: { series, number: { $seq: "formatted" }, number_int: { $seq: "value" } },
      },
      { insert: "doc_lines", data: { doc_id: { $ref: "doc" }, label: "first" } },
      {
        insert: "doc_lines",
        data: failLine
          ? { doc_id: { $ref: "doc" }, label: "second", undeclared_field: 1 }
          : { doc_id: { $ref: "doc" }, label: "second" },
      },
    ],
  })
}

async function numbers(series: string): Promise<number[]> {
  const rows = await sql.unsafe(
    `SELECT number_int FROM "${SCHEMA}".docs WHERE org_id = $1 AND series = $2 ORDER BY number_int`,
    [TEST_ORG, series],
  )
  return rows.map((r) => Number(r.number_int))
}

beforeAll(async () => {
  await seedOrgRow(
    { id: TEST_ORG, name: "Batch Bridge Org", slug: "batch-bridge-org" },
    { onConflict: "skip" },
  )
  await registerApps([manifest as never], TEST_ORG)
})

afterAll(async () => {
  resetAppRegistries()
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql`DELETE FROM kernel.app_sequences WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("ctx.db.batch", () => {
  it("commits a numbered row with the rows that reference it, in one call", async () => {
    const result = JSON.parse(await bridge().db_batch(issueSpec("A"))) as {
      sequence: { value: number; formatted: string }
      rows: { doc: { id: string; number: string } }
    }
    expect(result.sequence).toEqual({ value: 1, formatted: "A-0001" })
    expect(result.rows.doc.number).toBe("A-0001")
    const lines = await sql.unsafe(
      `SELECT label FROM "${SCHEMA}".doc_lines WHERE doc_id = $1 ORDER BY label`,
      [result.rows.doc.id],
    )
    expect(lines.map((r) => r.label)).toEqual(["first", "second"])
  })

  it("a failing op undoes the whole batch and consumes no number", async () => {
    await bridge().db_batch(issueSpec("B"))
    await expect(bridge().db_batch(issueSpec("B", true))).rejects.toThrow()
    const third = JSON.parse(await bridge().db_batch(issueSpec("B"))) as {
      sequence: { value: number }
    }
    expect(third.sequence.value).toBe(2)
    expect(await numbers("B")).toEqual([1, 2])
    const lines = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".doc_lines l JOIN "${SCHEMA}".docs d ON d.id = l.doc_id WHERE d.series = 'B'`,
    )
    expect(lines[0]?.n).toBe(4)
  })

  it("steps past numbers rows written another way already hold", async () => {
    // Numbers written by hand, without the allocator (e.g. an imported history).
    await bridge().db_batch(
      JSON.stringify({
        ops: [
          { insert: "docs", data: { series: "C", number: "C-0001", number_int: 1 } },
          { insert: "docs", data: { series: "C", number: "C-0002", number_int: 2 } },
        ],
      }),
    )
    const r = JSON.parse(await bridge().db_batch(issueSpec("C"))) as { sequence: { value: number } }
    expect(r.sequence.value).toBe(3)
  })

  it("concurrent batches never share a number and leave no gap when some fail", async () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      bridge()
        .db_batch(issueSpec("D", i % 3 === 2))
        .then(
          () => "ok",
          () => "failed",
        ),
    )
    const outcomes = await Promise.all(runs)
    const ok = outcomes.filter((o) => o === "ok").length
    expect(ok).toBe(8)
    expect(await numbers("D")).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("refuses a $seq without a sequence and a $ref to nothing, writing nothing", async () => {
    await expect(
      bridge().db_batch(
        JSON.stringify({
          ops: [{ insert: "docs", data: { series: "E", number_int: { $seq: "value" } } }],
        }),
      ),
    ).rejects.toThrow("$seq without a sequence")
    await expect(
      bridge().db_batch(
        JSON.stringify({
          ops: [
            { insert: "docs", data: { series: "E" } },
            { insert: "doc_lines", data: { doc_id: { $ref: "nope" }, label: "x" } },
          ],
        }),
      ),
    ).rejects.toThrow("$ref names no earlier insert")
    expect(await numbers("E")).toEqual([])
    const all = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".docs WHERE series = 'E'`,
    )
    expect(all[0]?.n).toBe(0)
  })

  it("named sequences number two series in one commit; a failing op consumes neither", async () => {
    const twoSeries = (fail: boolean) =>
      JSON.stringify({
        sequences: {
          credit: { key: `${APP}:G`, format: { prefix: "G-", pad: 3 } },
          invoice: { key: `${APP}:H`, format: { prefix: "H-", pad: 3 } },
        },
        ops: [
          {
            insert: "docs",
            as: "credit",
            data: {
              series: "G",
              number: { $seq: "credit.formatted" },
              number_int: { $seq: "credit.value" },
            },
          },
          {
            insert: "docs",
            as: "invoice",
            data: {
              series: "H",
              number: { $seq: "invoice.formatted" },
              number_int: { $seq: "invoice.value" },
            },
          },
          {
            insert: "doc_lines",
            data: fail
              ? { doc_id: { $ref: "invoice" }, label: "x", undeclared_field: 1 }
              : { doc_id: { $ref: "invoice" }, label: "x" },
          },
        ],
      })
    const first = JSON.parse(await bridge().db_batch(twoSeries(false))) as {
      sequences: Record<string, { value: number; formatted: string }>
      rows: Record<string, { number: string }>
    }
    expect(first.sequences).toEqual({
      credit: { value: 1, formatted: "G-001" },
      invoice: { value: 1, formatted: "H-001" },
    })
    expect([first.rows.credit?.number, first.rows.invoice?.number]).toEqual(["G-001", "H-001"])
    await expect(bridge().db_batch(twoSeries(true))).rejects.toThrow()
    const third = JSON.parse(await bridge().db_batch(twoSeries(false))) as {
      sequences: Record<string, { value: number }>
    }
    expect([third.sequences.credit?.value, third.sequences.invoice?.value]).toEqual([2, 2])
    expect(await numbers("G")).toEqual([1, 2])
    expect(await numbers("H")).toEqual([1, 2])
    await expect(
      bridge().db_batch(
        JSON.stringify({
          sequences: { a: { key: `${APP}:I` } },
          ops: [{ insert: "docs", data: { series: "I", number_int: { $seq: "b.value" } } }],
        }),
      ),
    ).rejects.toThrow('names no sequence "b"')
  })

  it("append and merge keep what another writer added between the read and the batch", async () => {
    const created = JSON.parse(
      await bridge().db_batch(
        JSON.stringify({
          ops: [
            {
              insert: "docs",
              as: "d",
              data: { series: "F", log: [{ e: "issued" }], refs: { a: 1 } },
            },
          ],
        }),
      ),
    ) as { rows: { d: { id: string } } }
    const id = created.rows.d.id
    // Another writer appends after our read.
    await bridge().db_update(
      "docs",
      id,
      JSON.stringify({ log: [{ e: "issued" }, { e: "refunded" }] }),
    )
    await bridge().db_batch(
      JSON.stringify({
        ops: [
          { update: "docs", id, append: { log: [{ e: "linked" }] }, merge: { refs: { b: 2 } } },
        ],
      }),
    )
    const rows = await sql.unsafe(`SELECT log, refs FROM "${SCHEMA}".docs WHERE id = $1`, [id])
    expect(rows[0]?.log).toEqual([{ e: "issued" }, { e: "refunded" }, { e: "linked" }])
    expect(rows[0]?.refs).toEqual({ a: 1, b: 2 })
    // A null column starts empty.
    const bare = JSON.parse(
      await bridge().db_batch(
        JSON.stringify({ ops: [{ insert: "docs", as: "d", data: { series: "F" } }] }),
      ),
    ) as { rows: { d: { id: string } } }
    await bridge().db_batch(
      JSON.stringify({ ops: [{ update: "docs", id: bare.rows.d.id, append: { log: [1] } }] }),
    )
    const b = await sql.unsafe(`SELECT log FROM "${SCHEMA}".docs WHERE id = $1`, [bare.rows.d.id])
    expect(b[0]?.log).toEqual([1])
  })

  describe("expect: a per-op row-count guard", () => {
    /** One doc of `series`; returns its id. */
    async function seedDoc(series: string): Promise<string> {
      const r = JSON.parse(
        await bridge().db_batch(
          JSON.stringify({ ops: [{ insert: "docs", as: "d", data: { series } }] }),
        ),
      ) as { rows: { d: { id: string } } }
      return r.rows.d.id
    }
    const MISSING_ID = "00000000-0000-0000-0000-00000000dead"

    async function rejection(
      p: Promise<unknown>,
    ): Promise<Error & { code?: string; status?: number }> {
      try {
        await p
      } catch (err) {
        return err as Error & { code?: string; status?: number }
      }
      throw new Error("the batch did not reject")
    }

    async function count(series: string): Promise<number> {
      const rows = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${SCHEMA}".docs WHERE org_id = $1 AND series = $2`,
        [TEST_ORG, series],
      )
      return Number(rows[0]?.n)
    }

    it("a guard that holds lets the batch commit", async () => {
      const id = await seedDoc("J")
      await bridge().db_batch(
        JSON.stringify({
          ops: [
            { update: "docs", id, data: { number: "J-1" }, expect: { minRows: 1, maxRows: 1 } },
            {
              updateMany: "docs",
              where: { series: "J" },
              data: { number: "J-2" },
              expect: { minRows: 1 },
            },
            { insert: "doc_lines", data: { doc_id: id, label: "after" } },
            { delete: "doc_lines", id: MISSING_ID, expect: { maxRows: 0 } },
          ],
        }),
      )
      const rows = await sql.unsafe(`SELECT number FROM "${SCHEMA}".docs WHERE id = $1`, [id])
      expect(rows[0]?.number).toBe("J-2")
    })

    it("an update that matched nothing rolls back every op and the sequence, with a typed error", async () => {
      const guarded = (id: string) =>
        JSON.stringify({
          sequence: { key: `${APP}:K`, format: { prefix: "K-", pad: 2 } },
          ops: [
            {
              insert: "docs",
              as: "doc",
              data: { series: "K", number: { $seq: "formatted" }, number_int: { $seq: "value" } },
            },
            { insert: "doc_lines", data: { doc_id: { $ref: "doc" }, label: "line" } },
            { update: "docs", id, data: { number: "touched" }, expect: { minRows: 1 } },
          ],
        })
      const err = await rejection(bridge().db_batch(guarded(MISSING_ID)))
      expect(err.code).toBe("precondition_failed")
      expect(err.status).toBe(409)
      expect(err.message).toContain("precondition_failed at ops[2] (update docs)")
      expect(err.message).toContain("matched 0")
      expect(await count("K")).toBe(0)
      const lines = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${SCHEMA}".doc_lines WHERE org_id = $1 AND label = 'line'`,
        [TEST_ORG],
      )
      expect(lines[0]?.n).toBe(0)
      // The failed batch burned no number: the next one takes K-01.
      const target = await seedDoc("K-target")
      const ok = JSON.parse(await bridge().db_batch(guarded(target))) as {
        sequence: { value: number; formatted: string }
      }
      expect(ok.sequence).toEqual({ value: 1, formatted: "K-01" })
      expect(await numbers("K")).toEqual([1])
    })

    it("append/merge-only updates, deletes and updateMany are guarded the same way", async () => {
      const id = await seedDoc("L")
      await seedDoc("L")
      const appendMissing = await rejection(
        bridge().db_batch(
          JSON.stringify({
            ops: [
              { update: "docs", id, data: { number: "L-x" } },
              { update: "docs", id: MISSING_ID, append: { log: [1] }, expect: { minRows: 1 } },
            ],
          }),
        ),
      )
      expect(appendMissing.code).toBe("precondition_failed")
      expect(appendMissing.message).toContain("ops[1] (update docs)")
      const deleteMissing = await rejection(
        bridge().db_batch(
          JSON.stringify({
            ops: [
              { update: "docs", id, data: { number: "L-y" } },
              { delete: "docs", id: MISSING_ID, expect: { minRows: 1 } },
            ],
          }),
        ),
      )
      expect(deleteMissing.message).toContain("ops[1] (delete docs)")
      const tooMany = await rejection(
        bridge().db_batch(
          JSON.stringify({
            ops: [
              { update: "docs", id, data: { number: "L-z" } },
              {
                updateMany: "docs",
                where: { series: "L" },
                data: { number: "L-all" },
                expect: { maxRows: 1 },
              },
            ],
          }),
        ),
      )
      expect(tooMany.code).toBe("precondition_failed")
      expect(tooMany.message).toContain("ops[1] (updateMany docs)")
      expect(tooMany.message).toContain("matched 2")
      // None of the three batches changed the row.
      const rows = await sql.unsafe(
        `SELECT number FROM "${SCHEMA}".docs WHERE org_id = $1 AND series = 'L' AND number IS NOT NULL`,
        [TEST_ORG],
      )
      expect(rows.length).toBe(0)
    })

    it("refuses a malformed guard, and a guard on an insert, before writing", async () => {
      const id = await seedDoc("M")
      for (const expectValue of [
        {},
        { minRows: -1 },
        { minRows: 2, maxRows: 1 },
        { rows: 1 },
        "exactlyOne",
      ]) {
        const err = await rejection(
          bridge().db_batch(
            JSON.stringify({
              ops: [
                { insert: "docs", data: { series: "M" } },
                { update: "docs", id, data: { number: "M-1" }, expect: expectValue },
              ],
            }),
          ),
        )
        expect(err.message).toContain("ops[1].expect")
      }
      const onInsert = await rejection(
        bridge().db_batch(
          JSON.stringify({
            ops: [{ insert: "docs", data: { series: "M" }, expect: { minRows: 1 } }],
          }),
        ),
      )
      expect(onInsert.message).toContain("ops[0].expect")
      expect(await count("M")).toBe(1)
    })
  })
})

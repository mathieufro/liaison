// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The payment reminder guard for an invoice issued by Liaison: read from the document at the
// moment the reminder would leave. Paid, fully credited or voided stops it for good.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { documentSendState } from "./send-state"
import { createMockDb } from "./test-db"

const ID = "00000000-0000-4000-8000-000000000201"
const ref = (id: string) => ({ ref: { kind: "invoicing:document", id } })

function dbWith(over: Record<string, unknown>, extra: Array<Record<string, unknown>> = []) {
  return createMockDb({
    seed: {
      documents: [
        {
          id: ID,
          type: "invoice",
          status: "issued",
          number: "FA-2026-0201",
          grand_total_minor: "12000",
          payment_status: "unpaid",
          lifecycle_log: [],
          external_refs: {},
          ...over,
        },
        ...extra,
      ],
    },
  })
}

describe("the payment reminder guard for a Liaison invoice", () => {
  it("a reminder on a paid, credited or voided invoice does not send", async () => {
    expect(await documentSendState(ref(ID), { db: dbWith({}) as never })).toEqual({ stop: false })
    expect(
      await documentSendState(ref(ID), {
        db: dbWith({ status: "paid", payment_status: "paid" }) as never,
      }),
    ).toEqual({
      stop: true,
      code: "invoice_paid",
      label: "Invoice FA-2026-0201 is paid",
    })
    for (const status of ["voided", "cancelled"]) {
      expect(await documentSendState(ref(ID), { db: dbWith({ status }) as never })).toMatchObject({
        stop: true,
        code: "invoice_voided",
      })
    }
    const credit = {
      id: "00000000-0000-4000-8000-000000000202",
      type: "credit_note",
      status: "issued",
      grand_total_minor: "-12000",
      external_refs: { original_document_id: ID },
      lifecycle_log: [],
    }
    const credited = dbWith(
      { lifecycle_log: [{ event: "credit_note_issued", credit_note_id: credit.id }] },
      [credit],
    )
    expect(await documentSendState(ref(ID), { db: credited as never })).toMatchObject({
      stop: true,
      code: "invoice_credited",
    })
  })

  it("an unknown document holds the reminder", async () => {
    const out = (await documentSendState(ref("00000000-0000-4000-8000-000000000299"), {
      db: dbWith({}) as never,
    })) as { error?: { code: string } }
    expect(out.error?.code).toBe("send_guard_unavailable")
  })

  it("the guard is declared for invoicing documents as a service message with its pill", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    expect(m.sendGuardProviders).toEqual({
      "invoicing:document": {
        tool: "document_send_state",
        serviceMessage: true,
        pill: { label: "Invoicing: payment reminder" },
      },
    })
    expect(m.tools.document_send_state).toMatchObject({ readOnly: true, agentVisible: false })
  })
})

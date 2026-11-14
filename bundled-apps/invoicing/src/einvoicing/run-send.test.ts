// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A month-end run a person approved carries its e-invoice sends: the approval of the run's card
// mints one dispatch grant per approved row, bound to that row, and once the row's invoice is
// issued its send is prepared under that grant with no further card. The kernel's own grant code
// mints and checks every grant here (no stand-in): the row's grant covers its own invoice's send
// and no other row's.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import {
  mintContractGrant,
  verifyContractGrant,
} from "../../../../apps/api/src/modules/apps/provider-contracts/grant"
import { mintRunSendGrants, prepareItemSend } from "./run-send"
import { type EinvCtx, stageSendAfterIssue, transmitTick } from "./transmit"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
) as {
  schema: ManifestSchema
  tools: Record<string, { gated?: boolean; noAutoApprove?: boolean }>
}
const ORG = "00000000-0000-4000-8000-0000000000f1"
const CONTRACT = "einvoicing-pa@1"
const SIREN = "900000001"
const CONTACT = "00000000-0000-4000-8000-00000000c001"
const RUN = "00000000-0000-4000-8000-0000000000b1"
type Row = Record<string, unknown>

function world() {
  const db = createMockDb(
    {},
    {
      ids: "uuid",
      stampCreatedAt: true,
      bridgeWhereOperators: true,
      orderByManifestSchema: MANIFEST.schema,
    },
  )
  const approvals: Row[] = []
  const sent: Array<{ op: string; params: Row }> = []
  const refused: string[] = []
  let n = 0
  const base: EinvCtx = {
    db: db as unknown as EinvCtx["db"],
    getUserId: async () => "00000000-0000-4000-8000-0000000000u1",
    approval: null,
    contracts: {
      call: async (contract, op, params, opts) => {
        if (op === "list_status_changes")
          return {
            status: "completed",
            result: { items: [] },
            provider: "pennylane",
          } as ContractEnvelope<unknown>
        const check = verifyContractGrant(opts?.grant, {
          orgId: ORG,
          callerApp: "invoicing",
          contract,
          op,
          params,
        })
        if (!check.ok) {
          refused.push(check.code)
          return {
            status: "error",
            error: { code: check.code, message: check.message },
          } as ContractEnvelope<unknown>
        }
        sent.push({ op, params })
        return {
          status: "completed",
          result: { provider_ref: `pa-${sent.length}`, state: "imported" },
          provider: "pennylane",
        } as ContractEnvelope<unknown>
      },
      grant: async () =>
        JSON.stringify({
          status: "error",
          error: { code: "contract_grant_refused", message: "not inside a person's approval" },
        }),
    },
    files_getAttachmentBytes: async () => JSON.stringify({ bytesBase64: btoa("<xml/>") }),
    requestApproval: async (input) => {
      approvals.push(input as unknown as Row)
      return { approval_id: `appr-${approvals.length}` }
    },
  }
  const approved = (tool = "invoicing:recurring_run_issue"): EinvCtx => ({
    ...base,
    approval: {
      approvalRequestId: "appr-run",
      approvalDeciderId: "00000000-0000-4000-8000-0000000000d1",
      toolName: tool,
    },
    contracts: {
      ...base.contracts!,
      grant: async (contract, ops, subject) => {
        const t = MANIFEST.tools[tool.replace(/^invoicing:/, "")]
        if (!(t?.gated === true && t.noAutoApprove === true))
          return JSON.stringify({
            status: "error",
            error: { code: "contract_grant_refused", message: "no" },
          })
        return JSON.stringify({
          grant: mintContractGrant({
            org: ORG,
            caller: "invoicing",
            contract,
            ops,
            subject,
            via: "appr-run",
            provider: "pennylane",
          }),
        })
      },
    },
  })
  async function issued(): Promise<Row> {
    n += 1
    const sha = n.toString(16).padStart(64, "c")
    const d = (await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number: `FA-2026-${String(n).padStart(4, "0")}`,
      issued_at: "2026-11-30",
      currency: "EUR",
      grand_total_minor: 12000,
      regime: "e_invoice",
      customer_kind: "business",
      counterparty_contact_id: CONTACT,
      counterparty_name: "Client Exemple",
      buyer_siren: SIREN,
      buyer_routing_address: SIREN,
      billing_country_code: "FR",
      billing_postcode: "69002",
      pdf_status: "ready",
      legal_original_sha256: sha,
    })) as Row
    const lo = (await db.insert("legal_originals", {
      document_id: d.id,
      kind: "facturx",
      file_id: `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`,
      sha256: sha,
    })) as Row
    await db.update("documents", String(d.id), { legal_original_id: lo.id })
    await db.insert("facturx_files", {
      document_id: d.id,
      file_id: `00000000-0000-4000-8000-${String(5000 + n).padStart(12, "0")}`,
      sha256: "x",
      generated_at: "2026-11-30",
    })
    return { ...d, legal_original_sha256: sha }
  }
  const rows = async (entity: string, where: Row = {}) =>
    (await db.findMany(entity, { where, limit: 1000 })) as Row[]
  return { db, base, approved, approvals, sent, refused, issued, rows }
}

let w: ReturnType<typeof world>
beforeEach(async () => {
  w = world()
  await w.db.insert("einvoicing_settings", {
    provider_app: "pennylane",
    cutover_date: "2026-11-01",
    send_enabled: true,
    book_enabled: false,
  })
  await w.db.insert("counterparty_identities", {
    contact_id: CONTACT,
    customer_kind: "business",
    siren: SIREN,
    routing_address: SIREN,
    registry_name: "CLIENT EXEMPLE",
    registry_status: "A",
    source: "registry",
    confirmed_via: "auto",
  })
})

async function item(state = "approved"): Promise<Row> {
  return (await w.db.insert("recurring_run_items", {
    run_id: RUN,
    source: "schedule",
    period_key: "2026-11",
    document_id: "00000000-0000-4000-8000-00000000dd01",
    position: 1,
    state,
  })) as Row
}

describe("a month-end run approved by a person carries its sends", () => {
  it("an approved run mints one grant per item's document, the send is prepared with no further approval, and a wrong document is refused", async () => {
    const a = await item()
    const b = await item()
    const left = await item("needs_fix")
    // Outside the person's approval nothing is minted.
    expect(await mintRunSendGrants(w.base, [String(a.id), String(b.id)])).toBe(0)
    expect(await mintRunSendGrants(w.approved(), [String(a.id), String(b.id)])).toBe(2)
    const itemRow = async (id: unknown): Promise<Row> =>
      ((await w.rows("recurring_run_items", { id }))[0] ?? {}) as Row
    const [ia, ib, il] = [await itemRow(a.id), await itemRow(b.id), await itemRow(left.id)]
    expect(typeof ia.send_grant).toBe("string")
    expect(typeof ib.send_grant).toBe("string")
    expect(il.send_grant ?? null).toBeNull()
    // Issue day: each row's invoice is issued, held from its own card, and prepared under its grant.
    const da = await w.issued()
    const db_ = await w.issued()
    await w.db.update("recurring_run_items", String(a.id), { document_id: da.id, state: "issued" })
    await w.db.update("recurring_run_items", String(b.id), { document_id: db_.id, state: "issued" })
    expect(await stageSendAfterIssue(w.base, String(da.id), { send: "held" })).toBeNull()
    expect(await prepareItemSend(w.base, String(a.id))).toMatchObject({ prepared: true })
    expect(await prepareItemSend(w.base, String(b.id))).toMatchObject({ prepared: true })
    expect(w.approvals).toHaveLength(0)
    const [tx] = await w.rows("einvoice_transmissions", { document_id: da.id })
    expect(tx).toMatchObject({ state: "prepared", approval_method: "approval", run_item_ref: a.id })
    await transmitTick(w.base)
    expect(w.sent.map((s) => [s.op, s.params.run_item_ref])).toEqual([
      ["submit_einvoice", a.id],
      ["submit_einvoice", b.id],
    ])
    expect(w.refused).toHaveLength(0)
    // Row A's grant does not cover row B's invoice.
    const params = {
      document_ref: String(db_.id),
      invoice_number: String(db_.number),
      legal_original_sha256: String(db_.legal_original_sha256),
      run_item_ref: String(b.id),
    }
    const wrong = verifyContractGrant(String(ia.send_grant), {
      orgId: ORG,
      callerApp: "invoicing",
      contract: CONTRACT,
      op: "submit_einvoice",
      params,
    })
    expect(wrong).toMatchObject({ ok: false, code: "contract_grant_mismatch" })
  })

  it("a send prepared for a row whose invoice is no longer that row's is refused before the platform", async () => {
    const a = await item()
    await mintRunSendGrants(w.approved(), [String(a.id)])
    const da = await w.issued()
    const other = await w.issued()
    await w.db.update("recurring_run_items", String(a.id), { document_id: da.id, state: "issued" })
    await prepareItemSend(w.base, String(a.id))
    // The row now names another invoice: the prepared send is not that row's any more.
    await w.db.update("recurring_run_items", String(a.id), { document_id: other.id })
    await transmitTick(w.base)
    const [tx] = await w.rows("einvoice_transmissions", { document_id: da.id })
    expect((tx?.last_error as Row | undefined)?.code).toBe("run_item_mismatch")
    expect(w.sent).toHaveLength(0)
  })
})

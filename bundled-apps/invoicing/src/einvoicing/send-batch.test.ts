// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily send batch: e-invoices issued with no person (a month-end run issuing by itself) are
// not staged one by one. Once a day, one card per organisation lists every one of them; its
// approval mints one dispatch grant per document, bound to that document and its legal original,
// and the kernel's own grant check (not a stand-in) accepts each document's send and refuses any
// other document's. A rejected or expired card keeps the documents for the next day's card.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import {
  mintContractGrant,
  verifyContractGrant,
} from "../../../../apps/api/src/modules/apps/provider-contracts/grant"
import { einvoiceSendBatch, einvoiceSendDailyJob, WAITING_ALERT_MS } from "./send-batch"
import { type EinvCtx, stageSendAfterIssue, transmitTick } from "./transmit"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
) as {
  schema: ManifestSchema
  tools: Record<string, { gated?: boolean; noAutoApprove?: boolean }>
}
const ORG = "00000000-0000-4000-8000-0000000000f1"
const SIREN = "900000001"
const CONTACT = "00000000-0000-4000-8000-00000000c001"
const CONTRACT = "einvoicing-pa@1"
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
  const status = new Map<string, { status: string; expired: boolean }>()
  const sent: Array<{ op: string; params: Row }> = []
  const events: Array<{ action: string; data: Row }> = []
  let n = 0
  const ctx: EinvCtx = {
    db: db as unknown as EinvCtx["db"],
    contracts: {
      // The kernel's dispatch: an outbound op runs only under a grant its own check accepts.
      call: async (contract, op, params, opts) => {
        const check = verifyContractGrant(opts?.grant, {
          orgId: ORG,
          callerApp: "invoicing",
          contract,
          op,
          params,
        })
        if (!check.ok)
          return {
            status: "error",
            error: { code: check.code, message: check.message },
          } as ContractEnvelope<unknown>
        sent.push({ op, params })
        return {
          status: "completed",
          result: { provider_ref: `pl-${sent.length}`, state: "imported" },
          provider: "pennylane",
        } as ContractEnvelope<unknown>
      },
      grant: async () =>
        JSON.stringify({
          status: "error",
          error: { code: "contract_grant_refused", message: "not inside a person's approval" },
        }),
    },
    getUserId: async () => "00000000-0000-4000-8000-0000000000u1",
    approval: null,
    requestApproval: async (input) => {
      approvals.push(input as unknown as Row)
      status.set(`appr-${approvals.length}`, { status: "pending", expired: false })
      return { approval_id: `appr-${approvals.length}` }
    },
    approvals: { statusOf: async (id) => JSON.stringify(status.get(id) ?? { status: null }) },
    emit: async (e) => {
      events.push({ action: e.action, data: e.data as Row })
    },
  }
  /** The same ctx inside a person's approval of `tool`: the kernel mints only for this app's gated, never-auto-approved tools. */
  const approved = (tool: string): EinvCtx => ({
    ...ctx,
    approval: {
      approvalRequestId: "appr-decided",
      approvalDeciderId: "00000000-0000-4000-8000-0000000000d1",
      toolName: tool,
    },
    contracts: {
      ...ctx.contracts!,
      grant: async (contract, ops, subject) => {
        const t = MANIFEST.tools[tool.replace(/^invoicing:/, "")]
        if (!(t?.gated === true && t.noAutoApprove === true))
          return JSON.stringify({
            status: "error",
            error: { code: "contract_grant_refused", message: "not a person's decision" },
          })
        return JSON.stringify({
          grant: mintContractGrant({
            org: ORG,
            caller: "invoicing",
            contract,
            ops,
            subject,
            via: "appr-decided",
            provider: "pennylane",
          }),
        })
      },
    },
  })
  async function doc(over: Row = {}): Promise<Row> {
    n += 1
    const number = `FA-2026-${String(n).padStart(4, "0")}`
    const sha = n.toString(16).padStart(64, "c")
    const d = (await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number,
      issued_at: "2026-11-03",
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
      ...over,
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
      generated_at: "2026-11-03",
    })
    return { ...d, legal_original_id: lo.id, number, legal_original_sha256: sha }
  }
  const rows = async (entity: string, where: Row = {}) =>
    (await db.findMany(entity, { where, limit: 1000 })) as Row[]
  return { db, ctx, approved, approvals, status, sent, events, doc, rows }
}

let w: ReturnType<typeof world>
beforeEach(async () => {
  w = world()
  await w.db.insert("einvoicing_settings", {
    provider_app: "pennylane",
    cutover_date: "2026-11-01",
    send_enabled: true,
    book_enabled: false,
    changed_by: "00000000-0000-4000-8000-0000000000a1",
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

const submitParams = (d: Row) => ({
  document_ref: String(d.id),
  invoice_number: String(d.number),
  legal_original_sha256: String(d.legal_original_sha256),
  issue_date: "2026-11-03",
})

describe("the daily send batch", () => {
  it("an e-invoice issued with no person waits for the batch and gets no card of its own", async () => {
    const d = await w.doc()
    expect(await stageSendAfterIssue(w.ctx, String(d.id), { send: "batch" })).toBeNull()
    expect(w.approvals).toHaveLength(0)
    expect((await w.rows("documents", { id: d.id }))[0]).toMatchObject({
      einvoice_state: "awaiting_send_batch",
    })
    // The e-invoicing job's catch-up does not stage it one by one either.
    await transmitTick(w.ctx)
    expect(w.approvals).toHaveLength(0)
  })

  it("documents issued with no person wait for one daily card listing all; reject keeps them for the next day", async () => {
    const a = await w.doc({ einvoice_state: "awaiting_send_batch" })
    const b = await w.doc({ einvoice_state: "awaiting_send_batch" })
    await w.doc({ einvoice_state: "awaiting_send_approval" })
    const first = await einvoiceSendDailyJob(w.ctx)
    expect(first).toMatchObject({ status: "batch_requested", documents: 2 })
    expect(w.approvals).toHaveLength(1)
    expect(w.approvals[0]).toMatchObject({
      tool_name: "invoicing:einvoice_send_batch",
      approve_scope: "invoicing:documents:write",
    })
    expect(JSON.stringify(w.approvals[0]?.summary_detail)).toContain(String(a.number))
    expect(JSON.stringify(w.approvals[0]?.summary_detail)).toContain(String(b.number))
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
    // The same day again: the card still waits, nothing is added.
    expect(await einvoiceSendDailyJob(w.ctx)).toMatchObject({ status: "batch_pending" })
    expect(w.approvals).toHaveLength(1)
    // Rejected: the documents stay, and the next day's card lists them again.
    w.status.set("appr-1", { status: "denied", expired: false })
    expect(await einvoiceSendDailyJob(w.ctx)).toMatchObject({
      status: "batch_requested",
      documents: 2,
    })
    expect(w.approvals).toHaveLength(2)
    expect(
      (await w.rows("documents", { einvoice_state: "awaiting_send_batch" }))
        .map((d) => d.id)
        .sort(),
    ).toEqual([a.id, b.id].sort())
    // Expired the same way.
    w.status.set("appr-2", { status: "pending", expired: true })
    expect(await einvoiceSendDailyJob(w.ctx)).toMatchObject({
      status: "batch_requested",
      documents: 2,
    })
  })

  it("approving the card mints one grant per document: each send is prepared, the kernel accepts it, and a wrong document is refused", async () => {
    const a = await w.doc({ einvoice_state: "awaiting_send_batch" })
    const b = await w.doc({ einvoice_state: "awaiting_send_batch" })
    await einvoiceSendDailyJob(w.ctx)
    const [batch] = await w.rows("einvoice_send_batches")
    // Outside a person's approval no grant is minted and nothing is prepared.
    expect(await einvoiceSendBatch(w.ctx, { batch_id: String(batch?.id) })).toMatchObject({
      status: "error",
      error: { code: "contract_grant_refused" },
    })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(0)
    const res = await einvoiceSendBatch(w.approved("invoicing:einvoice_send_batch"), {
      batch_id: String(batch?.id),
    })
    expect(res).toMatchObject({ status: "ok", prepared: 2 })
    const tx = await w.rows("einvoice_transmissions")
    expect(tx.map((t) => t.state)).toEqual(["prepared", "prepared"])
    expect((await w.rows("documents", { id: a.id }))[0]).toMatchObject({
      einvoice_state: "prepared",
    })
    const grantOf = (d: Row) => String(tx.find((t) => t.document_id === d.id)?.dispatch_grant)
    const want = (d: Row) => ({
      orgId: ORG,
      callerApp: "invoicing",
      contract: CONTRACT,
      op: "submit_einvoice",
      params: submitParams(d),
    })
    expect(verifyContractGrant(grantOf(a), want(a)).ok).toBe(true)
    expect(verifyContractGrant(grantOf(b), want(b)).ok).toBe(true)
    const wrong = verifyContractGrant(grantOf(a), want(b))
    expect(wrong).toMatchObject({ ok: false, code: "contract_grant_mismatch" })
    // A replayed approval prepares nothing more.
    expect(
      await einvoiceSendBatch(w.approved("invoicing:einvoice_send_batch"), {
        batch_id: String(batch?.id),
      }),
    ).toMatchObject({ replay: true })
    expect(await w.rows("einvoice_transmissions")).toHaveLength(2)
  })

  it("three rejected batches raise the waiting line naming the oldest document", async () => {
    const old = new Date(Date.now() - WAITING_ALERT_MS - 3600_000).toISOString()
    const a = await w.doc({
      einvoice_state: "awaiting_send_batch",
      einvoice_send_requested_at: old,
    })
    await w.doc({
      einvoice_state: "awaiting_send_batch",
      einvoice_send_requested_at: new Date().toISOString(),
    })
    for (let i = 1; i <= 3; i++) {
      await einvoiceSendDailyJob(w.ctx)
      w.status.set(`appr-${i}`, { status: "denied", expired: false })
    }
    await einvoiceSendDailyJob(w.ctx)
    // The card names the oldest wait.
    expect(JSON.stringify(w.approvals.at(-1)?.summary_detail)).toContain(
      `Oldest waiting: ${String(a.number)}`,
    )
    // One attention line, raised once, naming the oldest document.
    const waiting = w.events.filter((e) => e.action === "send_waiting")
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.data).toMatchObject({ document_id: a.id, number: a.number })
  })
})

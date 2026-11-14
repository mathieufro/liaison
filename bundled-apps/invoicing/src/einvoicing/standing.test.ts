// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standing e-invoice authorization of a stream: off by default. Only a person's approval of
// `issuer_stream_set {einvoiceStanding: true}` turns it on, and that approval mints ONE grant
// bound to the stream (`stream_ref`). On that stream an e-invoice issued with no person is
// prepared at issue under that grant, with no card; other streams keep the daily batch. The
// grant lasts 90 days: a renewal card asks a week before, and on lapse the stream goes back to
// the batch with one Home line. Turning it off runs at once. The kernel's own grant code mints
// and checks every grant here (no stand-in).
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import {
  mintContractGrant,
  verifyContractGrant,
} from "../../../../apps/api/src/modules/apps/provider-contracts/grant"
import { issuerStreamSet } from "../streams"
import { einvoiceStandingDailyJob, einvoiceStandingOff, standingOf } from "./standing"
import { type EinvCtx, stageSendAfterIssue, transmitTick } from "./transmit"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
) as {
  schema: ManifestSchema
  tools: Record<string, { gated?: boolean; noAutoApprove?: boolean }>
}
const ORG = "00000000-0000-4000-8000-0000000000f1"
const ISSUER = "00000000-0000-4000-8000-0000000000e1"
const PERSON = "00000000-0000-4000-8000-0000000000d1"
const SIREN = "900000001"
const CONTACT = "00000000-0000-4000-8000-00000000c001"
const DAY = 24 * 3600 * 1000
const T0 = new Date("2026-11-03T09:00:00Z").getTime()
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
  const refused: Array<{ op: string; code: string }> = []
  const events: Array<{ action: string; data: Row }> = []
  let n = 0
  const base = {
    db: db as never,
    getUserId: async () => PERSON,
    approval: null,
    contracts: {
      call: async (
        contract: string,
        op: string,
        params: Record<string, unknown>,
        opts?: { grant?: string | null },
      ) => {
        if (op === "submit_einvoice" || op === "advance_einvoice") {
          const check = verifyContractGrant(opts?.grant, {
            orgId: ORG,
            callerApp: "invoicing",
            contract,
            op,
            params,
          })
          if (!check.ok) {
            refused.push({ op, code: check.code })
            return {
              status: "error",
              error: { code: check.code, message: check.message },
            } as ContractEnvelope<unknown>
          }
          sent.push({ op, params })
        }
        if (op === "list_status_changes")
          return {
            status: "completed",
            result: { items: [] },
            provider: "pennylane",
          } as ContractEnvelope<unknown>
        if (op === "submit_einvoice")
          return {
            status: "completed",
            result: { provider_ref: `pa-${sent.length}`, state: "imported" },
            provider: "pennylane",
          } as ContractEnvelope<unknown>
        return {
          status: "completed",
          result: { state: "sent", provider_ref: params.provider_ref },
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
    requestApproval: async (input: Row) => {
      approvals.push(input)
      return { approval_id: `appr-${approvals.length}` }
    },
    approvals: { statusOf: async () => JSON.stringify({ status: "pending" }) },
    emit: async (e: { action: string; data?: unknown }) => {
      events.push({ action: e.action, data: e.data as Row })
    },
    turn: { get: async () => null },
  }
  const ctx = base as unknown as EinvCtx & Parameters<typeof issuerStreamSet>[0]
  /** Inside a person's approval of `tool`: the kernel mints only for this app's gated, never-auto-approved tools. */
  const approved = (tool = "invoicing:issuer_stream_set") =>
    ({
      ...base,
      approval: { approvalRequestId: "appr-decided", approvalDeciderId: PERSON, toolName: tool },
      contracts: {
        ...base.contracts,
        grant: async (contract: string, ops: string[], subject: Record<string, string>) => {
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
              via: "appr-decided",
              provider: "pennylane",
            }),
          })
        },
      },
    }) as unknown as EinvCtx & Parameters<typeof issuerStreamSet>[0]
  async function doc(over: Row = {}): Promise<Row> {
    n += 1
    const number = `FA-2026-${String(n).padStart(4, "0")}`
    const sha = n.toString(16).padStart(64, "c")
    const d = (await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number,
      issued_at: new Date(Date.now()).toISOString(),
      issuer_profile_id: ISSUER,
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
      external_ref: `recurring:sched-${n}:2026-11`,
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
    return { ...d, legal_original_id: lo.id }
  }
  const rows = async (entity: string, where: Row = {}) =>
    (await db.findMany(entity, { where, limit: 1000 })) as Row[]
  const one = async (id: unknown) => (await rows("documents", { id }))[0] as Row
  return { db, ctx, approved, approvals, sent, refused, events, doc, rows, one }
}

let w: ReturnType<typeof world>
beforeEach(async () => {
  setSystemTime(new Date(T0))
  w = world()
  await w.db.insert("issuer_profiles", {
    id: ISSUER,
    legal_name: "Maison Nord SARL",
    country: "FR",
  })
  await w.db.insert("einvoicing_settings", {
    provider_app: "pennylane",
    cutover_date: "2026-11-01",
    send_enabled: true,
    book_enabled: false,
    changed_by: PERSON,
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
afterEach(() => setSystemTime())

/** Issue with no person, then let the e-invoicing job run its steps. */
async function issueWithNoPerson(over: Row = {}): Promise<Row> {
  const d = await w.doc(over)
  await stageSendAfterIssue(w.ctx, String(d.id), { send: "batch" })
  await transmitTick(w.ctx)
  return w.one(d.id)
}

describe("the standing e-invoice authorization", () => {
  it("off by default on every stream", async () => {
    expect(await standingOf(w.ctx, ISSUER, "transfer")).toBeNull()
    expect(await standingOf(w.ctx, ISSUER, "card")).toBeNull()
    expect((await issueWithNoPerson()).einvoice_state).toBe("awaiting_send_batch")
  })

  it("an agent's call parks and cannot approve itself", async () => {
    // The tool is gated and never auto-approved, so the kernel parks an agent's call for a person.
    expect(MANIFEST.tools.issuer_stream_set).toMatchObject({ gated: true, noAutoApprove: true })
    // Run outside a person's decision (no approval), nothing is minted or recorded.
    const out = await issuerStreamSet(w.ctx, {
      issuerProfileId: ISSUER,
      stream: "transfer",
      einvoiceStanding: true,
    })
    expect(out).toMatchObject({ status: "error", error: { code: "contract_grant_refused" } })
    expect(await w.rows("einvoice_standing")).toHaveLength(0)
  })

  it("with no platform bound, the refusal names the setting, never the contract's id", async () => {
    const noPlatform = {
      ...(w.approved() as unknown as Row),
      contracts: {
        grant: async () =>
          JSON.stringify({
            status: "error",
            error: {
              code: "contract_provider_not_configured",
              message: "No provider is bound for einvoicing-pa@1",
            },
          }),
      },
    } as unknown as Parameters<typeof issuerStreamSet>[0]
    const out = await issuerStreamSet(noPlatform, {
      issuerProfileId: ISSUER,
      stream: "transfer",
      einvoiceStanding: true,
    })
    expect(out).toMatchObject({ status: "error", error: { code: "einvoicing_platform_not_set" } })
    expect(JSON.stringify(out)).not.toContain("einvoicing-pa@1")
    expect(await w.rows("einvoice_standing")).toHaveLength(0)
  })

  it("on and recorded: a no-person issue on that stream sends with no card and other streams keep the batch", async () => {
    const on = await issuerStreamSet(w.approved(), {
      issuerProfileId: ISSUER,
      stream: "transfer",
      einvoiceStanding: true,
    })
    expect(on).toMatchObject({
      status: "completed",
      einvoiceStanding: true,
      standingUntil: "2027-02-01",
    })
    const [row] = await w.rows("einvoice_standing")
    expect(row).toMatchObject({
      issuer_profile_id: ISSUER,
      stream: "transfer",
      turned_on_by: PERSON,
    })
    expect(typeof row?.grant_ref).toBe("string")
    const sent = await issueWithNoPerson()
    expect(w.approvals).toHaveLength(0)
    expect(sent.einvoice_state).toBe("validation_pending")
    expect(w.sent.map((s) => s.op)).toEqual(["submit_einvoice"])
    expect(w.sent[0]?.params.stream_ref).toBe(`${ISSUER}:transfer`)
    const log = (sent.lifecycle_log ?? []) as Row[]
    expect(
      log.some((e) => e.event === "einvoice_send_standing" && e.authorized_by === PERSON),
    ).toBe(true)
    // A card-stream document issued with no person still waits for the batch.
    expect((await issueWithNoPerson({ external_ref: "stripe:in_FIXTURE01" })).einvoice_state).toBe(
      "awaiting_send_batch",
    )
  })

  it("a transfer-stream document sent under the card stream's standing grant is refused", async () => {
    await issuerStreamSet(w.approved(), {
      issuerProfileId: ISSUER,
      stream: "card",
      einvoiceStanding: true,
    })
    const d = await w.doc({ external_ref: "stripe:in_FIXTURE02" })
    await stageSendAfterIssue(w.ctx, String(d.id), { send: "batch" })
    // The document moves to another stream after its send was prepared.
    await w.db.update("documents", String(d.id), { external_ref: "recurring:sched-x:2026-11" })
    await transmitTick(w.ctx)
    const [tx] = await w.rows("einvoice_transmissions", { document_id: d.id })
    expect((tx?.last_error as Row | undefined)?.code).toBe("stream_mismatch")
    expect(w.sent).toHaveLength(0)
  })

  it("revoke sends the next document to the batch", async () => {
    await issuerStreamSet(w.approved(), {
      issuerProfileId: ISSUER,
      stream: "transfer",
      einvoiceStanding: true,
    })
    const off = await einvoiceStandingOff(w.ctx, { issuerProfileId: ISSUER, stream: "transfer" })
    expect(off).toMatchObject({ status: "completed", einvoiceStanding: false })
    expect((await w.rows("einvoice_standing"))[0]).toMatchObject({ ended_by: PERSON })
    expect(typeof (await w.rows("einvoice_standing"))[0]?.ended_at).toBe("string")
    expect((await issueWithNoPerson()).einvoice_state).toBe("awaiting_send_batch")
  })

  it("day 89 sends and day 91 batches", async () => {
    await issuerStreamSet(w.approved(), {
      issuerProfileId: ISSUER,
      stream: "transfer",
      einvoiceStanding: true,
    })
    // Day 83: one renewal card, to the person who turned it on.
    setSystemTime(new Date(T0 + 83 * DAY))
    await einvoiceStandingDailyJob(w.ctx)
    await einvoiceStandingDailyJob(w.ctx)
    expect(w.approvals).toHaveLength(1)
    expect(w.approvals[0]).toMatchObject({
      tool_name: "invoicing:issuer_stream_set",
      current_payload: { issuerProfileId: ISSUER, stream: "transfer", einvoiceStanding: true },
      on_behalf_of: PERSON,
      approve_scope: "invoicing:settings:write",
    })
    setSystemTime(new Date(T0 + 89 * DAY))
    expect((await issueWithNoPerson()).einvoice_state).toBe("validation_pending")
    expect(w.refused).toHaveLength(0)
    // Not renewed: on day 91 the stream is back on the batch, said once on Home.
    setSystemTime(new Date(T0 + 91 * DAY))
    // Past its end the grant no longer counts, even before the daily job records the lapse.
    expect(await standingOf(w.ctx, ISSUER, "transfer")).toBeNull()
    await einvoiceStandingDailyJob(w.ctx)
    await einvoiceStandingDailyJob(w.ctx)
    expect(w.events.filter((e) => e.action === "standing_lapsed")).toHaveLength(1)
    expect((await issueWithNoPerson()).einvoice_state).toBe("awaiting_send_batch")
  })
})

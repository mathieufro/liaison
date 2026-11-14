// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who issues what: the card stream appears when Stripe connects and asks a person who issues its
// invoices; a switch applies from its confirmation; Stripe's own emails are never said to be off
// until a person states it, and only a person can.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  issuerAt,
  issuerEmailsConfirm,
  issuerStreamGet,
  issuerStreamSet,
  onStripeConnectionChanged,
  suggestedIssuer,
} from "./streams"
import { createMockDb } from "./test-db"

type Obj = Record<string, any>
const FR = "11111111-1111-4111-8111-111111111111"
const DE = "22222222-2222-4222-8222-222222222222"
const manifest = () =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))

function world(opts: { agent?: boolean; approved?: string; streams?: Obj[] } = {}) {
  const db = createMockDb({
    bridgeWhereOperators: true,
    seed: {
      issuer_profiles: [
        { id: FR, legal_name: "Maree Logiciel SAS", country: "FR", vat_id: "FR40902000009" },
        { id: DE, legal_name: "Nordwerk GmbH", country: "DE", vat_id: "DE123456789" },
      ],
      ...(opts.streams ? { stripe_streams: opts.streams } : {}),
    },
  })
  const approvals: Obj[] = []
  const events: Obj[] = []
  const ctx: Obj = {
    db,
    approval: opts.approved
      ? {
          approvalRequestId: "req-1",
          approvalDeciderId: opts.approved,
          toolName: "invoicing:issuer_stream_set",
        }
      : null,
    getUserId: async () => "person-1",
    turn: {
      get: async () => ({ agentId: opts.agent ? "agent-1" : null, hasPerson: opts.agent === true }),
    },
    emit: async (e: Obj) => {
      events.push(e)
    },
    requestApproval: async (input: Obj) => {
      approvals.push(input)
      return { approval_id: `appr-${approvals.length}`, auto_approved: false }
    },
  }
  return { db, ctx, approvals, events }
}

const rowOf = async (db: Obj, profile: string): Promise<Obj> =>
  ((await db.findMany("stripe_streams", { where: { issuer_profile_id: profile } })) as Obj[])[0] ??
  {}

describe("who issues what", () => {
  test("the issuer card parks; a French profile pre-selects Liaison and says why, another pre-selects nothing; nothing issues before it is decided", async () => {
    const { db, ctx, approvals } = world()
    await onStripeConnectionChanged(ctx as never, {
      data: { from: "key_stored", to: "waiting_first_event" },
    })
    expect(approvals.map((a) => a.tool_name)).toEqual([
      "invoicing:issuer_stream_set",
      "invoicing:issuer_stream_set",
    ])
    const fr = approvals.find((a) => a.current_payload.issuerProfileId === FR) as Obj
    const de = approvals.find((a) => a.current_payload.issuerProfileId === DE) as Obj
    expect(fr.current_payload).toEqual({ issuerProfileId: FR, issuer: "liaison" })
    expect(fr.summary_detail.lines.join(" ")).toContain("Why Liaison: French e-invoicing")
    expect(de.current_payload).toEqual({ issuerProfileId: DE })
    expect(de.summary_detail.subtitle).toContain("Nothing is pre-selected")
    expect(fr.editable_fields).toEqual(["issuer"])
    // Until decided the card stream is undecided, and a second delivery asks nothing again.
    expect(await rowOf(db, FR)).toMatchObject({
      issuer: "undecided",
      stripe_connected: true,
      approval_request_id: "appr-1",
    })
    await onStripeConnectionChanged(ctx as never, {
      data: { from: "waiting_first_event", to: "importing" },
    })
    expect(approvals).toHaveLength(2)
    // Approved without a pick, it refuses; a pick decides it and names who.
    expect(
      (
        (await issuerStreamSet(world({ approved: "person-9", streams: [] }).ctx as never, {
          issuerProfileId: DE,
        })) as Obj
      ).error.code,
    ).toBe("issuer_required")
    const decided = {
      ...ctx,
      approval: {
        approvalRequestId: "appr-2",
        approvalDeciderId: "person-9",
        toolName: "invoicing:issuer_stream_set",
      },
    }
    expect(
      (await issuerStreamSet(decided as never, { issuerProfileId: DE, issuer: "stripe" })) as Obj,
    ).toMatchObject({ status: "completed", issuer: "stripe" })
    expect(await rowOf(db, DE)).toMatchObject({ issuer: "stripe", decided_by: "person-9" })
    // The tool is gated and never auto-approved, so a person decides it.
    const t = manifest().tools.issuer_stream_set
    expect(t).toMatchObject({
      gated: true,
      noAutoApprove: true,
      editableFields: [{ field: "issuer" }],
    })
    expect(suggestedIssuer({ country: "BE", vat_id: "FR40902000009" })?.issuer).toBe("liaison")
    expect(suggestedIssuer({ country: "BE", vat_id: "BE0123456789" })).toBeNull()
  })

  test("a stream has exactly one issuer and both is refused by the schema", async () => {
    const field = manifest().schema.stripe_streams.fields.issuer
    expect(field.enum).toEqual(["liaison", "stripe", "undecided"])
    expect(field.enum).not.toContain("both")
    expect(manifest().schema.stripe_streams.constraints.unique).toEqual([["issuer_profile_id"]])
    expect(manifest().tools.issuer_stream_set.params.properties.issuer.enum).toEqual([
      "liaison",
      "stripe",
    ])
    // The two other streams have no choice.
    const { ctx } = world({
      streams: [{ issuer_profile_id: FR, issuer: "liaison", stripe_connected: true }],
    })
    expect(
      (
        (await issuerStreamSet(ctx as never, {
          issuerProfileId: FR,
          stream: "transfer",
          issuer: "stripe",
        })) as Obj
      ).error.code,
    ).toBe("stream_not_choosable")
  })

  test("a switch applies to invoices finalized after confirmation and alerts on unpaid ones", async () => {
    const { db, ctx, events } = world({
      streams: [
        {
          issuer_profile_id: FR,
          issuer: "liaison",
          stripe_connected: true,
          decided_by: "p0",
          decided_at: "2026-10-01T09:30:00.000Z",
        },
      ],
    })
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      issuer_profile_id: FR,
      number: "F-2026-0101",
      payment_status: "unpaid",
      external_ref: "stripe:in_a",
    })
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      issuer_profile_id: FR,
      number: "F-2026-0102",
      payment_status: "paid",
      external_ref: "stripe:in_b",
    })
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      issuer_profile_id: FR,
      number: "F-2026-0103",
      payment_status: "unpaid",
      external_ref: null,
    })
    const r = (await issuerStreamSet(
      {
        ...ctx,
        approval: { approvalRequestId: "r", approvalDeciderId: "person-2", toolName: "x" },
      } as never,
      { issuerProfileId: FR, issuer: "stripe" },
    )) as Obj
    expect(r.summary).toContain("keep their issuer and numbers")
    expect(r.summary).toContain("accountant")
    const row = await rowOf(db, FR)
    expect(row).toMatchObject({
      issuer: "stripe",
      previous_issuer: "liaison",
      decided_by: "person-2",
    })
    const at = String(r.effectiveAt)
    // One minute before the confirmation: still Liaison's. At and after it: Stripe's.
    expect(issuerAt(row, new Date(Date.parse(at) - 60_000).toISOString())).toBe("liaison")
    expect(issuerAt(row, at)).toBe("stripe")
    expect(issuerAt(row, new Date(Date.parse(at) + 60_000).toISOString())).toBe("stripe")
    // Issued invoices are untouched; the unpaid one made from Stripe raises one alert.
    expect(
      ((await db.findMany("documents", { where: { number: "F-2026-0101" } })) as Obj[])[0],
    ).toMatchObject({ status: "issued", issuer_profile_id: FR })
    expect(events).toEqual([
      expect.objectContaining({
        entity: "stripe_stream",
        action: "switched",
        data: expect.objectContaining({ unpaid: 1, issuer: "stripe" }),
      }),
    ])
    expect(JSON.stringify(manifest().attention)).toContain('"event":"stripe_stream:switched"')
  })

  test("no path says checked until a person confirms, and the confirmation records who and when", async () => {
    const { db, ctx } = world({
      streams: [{ issuer_profile_id: FR, issuer: "liaison", stripe_connected: true }],
    })
    const before = (await issuerStreamGet(ctx as never)) as Obj
    const fr = before.issuers.find((i: Obj) => i.issuerProfileId === FR)
    expect(fr.stripe_emails).toEqual({ state: "unknown", confirmedBy: null, confirmedAt: null })
    expect(JSON.stringify(before)).not.toMatch(/checked/i)
    const r = (await issuerEmailsConfirm(ctx as never, { issuerProfileId: FR })) as Obj
    expect(r).toMatchObject({ status: "completed", confirmedBy: "person-1" })
    const after = ((await issuerStreamGet(ctx as never)) as Obj).issuers.find(
      (i: Obj) => i.issuerProfileId === FR,
    )
    expect(after.stripe_emails).toEqual({
      state: "confirmed",
      confirmedBy: "person-1",
      confirmedAt: r.confirmedAt,
    })
    expect(await rowOf(db, FR)).toMatchObject({ emails_confirmed_by: "person-1" })
  })

  test("confirming the emails removes the please-check line", async () => {
    const { ctx } = world({
      streams: [{ issuer_profile_id: FR, issuer: "liaison", stripe_connected: true }],
    })
    const state = async () =>
      ((await issuerStreamGet(ctx as never)) as Obj).issuers[0].stripe_emails.state
    expect(await state()).toBe("unknown")
    await issuerEmailsConfirm(ctx as never, { issuerProfileId: FR })
    expect(await state()).toBe("confirmed")
  })

  test("an agent's confirmation parks and the line stays", async () => {
    const { db, ctx, approvals } = world({
      agent: true,
      streams: [{ issuer_profile_id: FR, issuer: "liaison", stripe_connected: true }],
    })
    const r = (await issuerEmailsConfirm(ctx as never, { issuerProfileId: FR })) as Obj
    expect(r.status).toBe("pending_approval")
    expect(approvals[0]?.tool_name).toBe("invoicing:issuer_emails_confirm")
    expect((await rowOf(db, FR)).emails_confirmed_by ?? null).toBeNull()
    expect(((await issuerStreamGet(ctx as never)) as Obj).issuers[0].stripe_emails.state).toBe(
      "unknown",
    )
    // The person's approval of that card records it, under the decider's name.
    const approved = {
      ...ctx,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "person-7",
        toolName: "invoicing:issuer_emails_confirm",
      },
    }
    expect(
      (await issuerEmailsConfirm(approved as never, { issuerProfileId: FR })) as Obj,
    ).toMatchObject({ confirmedBy: "person-7" })
    expect(manifest().tools.issuer_emails_confirm).toMatchObject({
      conditionalGate: true,
      externalEffect: true,
    })
  })

  test("without Stripe only the two other streams exist, each always not billed from Stripe", async () => {
    const { ctx } = world()
    const r = (await issuerStreamGet(ctx as never)) as Obj
    expect(r.stripeConnected).toBe(false)
    for (const i of r.issuers) {
      expect(i.streams).toEqual([
        {
          stream: "transfer",
          issuer: "liaison",
          notBilledFromStripe: true,
          // The standing e-invoice authorization is off by default, said with no person or date.
          standing: { on: false, turnedOnBy: null, turnedOnAt: null, until: null },
        },
        { stream: "one_off", issuer: "liaison", notBilledFromStripe: true },
      ])
      expect(i.stripe_emails).toBeNull()
    }
    // A disconnect hides the card stream again and keeps the decision.
    const w = world({
      streams: [{ issuer_profile_id: FR, issuer: "liaison", stripe_connected: true }],
    })
    await onStripeConnectionChanged(w.ctx as never, {
      data: { from: "connected", to: "not_connected" },
    })
    expect(await rowOf(w.db, FR)).toMatchObject({ issuer: "liaison", stripe_connected: false })
  })

  test("erasing a user anonymizes their id in the new tables", () => {
    const f = manifest().schema.stripe_streams.fields
    for (const col of ["decided_by", "emails_confirmed_by"])
      expect(f[col]).toMatchObject({ userRef: true, onErase: "anonymize" })
    expect(manifest().schema.stripe_streams.rlsScope).toBe("settings")
  })
})

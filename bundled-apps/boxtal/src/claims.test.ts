// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Module J — Task J4: boxtal claim_open (gated) + RECORD-AND-DEGRADE
 * registration. Pure bundled-app suite (no env).
 */
import { describe, expect, it } from "bun:test"
import { claimOpen, claimOpenPreflight, registeredBoxtalTools } from "./claims"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { createMockDb } from "./test-db"

function makeCtx(opts: {
  seed?: Record<string, Array<Record<string, unknown>>>
  claimsApiAvailable?: boolean
}): BoxtalToolCtx & { claimsApiAvailable?: boolean } {
  const db = createMockDb({ seed: opts.seed ?? {} })
  const executeTool = async (): Promise<CrossAppEnvelope> => ({ status: "error", error: { code: "unmocked", message: "x" } })
  return {
    orgId: "org_1",
    db,
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as BoxtalToolCtx["executeTool"],
    claimsApiAvailable: opts.claimsApiAvailable,
  }
}

const SEED = {
  shipment: [
    { id: "S2", tracking_status: "INCIDENT", recipient_summary: "Acme", offer_code: "CHRP" },
    { id: "S_DELIVERED", tracking_status: "DELIVERED", recipient_summary: "Globex" },
  ],
}

describe("boxtal claim_open (gated)", () => {
  it("persists a claim row linked to a shipment with status 'open'", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: true })
    const r = await claimOpen(ctx, {
      shipment_id: "S2",
      type: "lost",
      amount: 800,
      evidence_file_ids: ["f1"],
    })
    expect(r.claim_id).toBeTruthy()
    expect(r.status).toBe("open")
    const row = (await ctx.db.findOne("claim", r.claim_id)) as {
      shipment_id: string
      amount: number
    } | null
    expect(row?.shipment_id).toBe("S2")
    expect(row?.amount).toBe(800)
  })

  it("rejects a claim against a shipment not in an exception state", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: true })
    await expect(
      claimOpen(ctx, { shipment_id: "S_DELIVERED", type: "lost", amount: 100, evidence_file_ids: [] }),
    ).rejects.toThrow(/exception|not eligible/i)
  })

  it("RECORD-AND-DEGRADE: when the claims API is unavailable, claim_open is absent and exceptions_list still ships", () => {
    const tools = registeredBoxtalTools({ claimsApiAvailable: false })
    expect(tools).toContain("exceptions_list")
    expect(tools).not.toContain("claim_open")
  })

  it("when the claims API IS available, claim_open is registered", () => {
    const tools = registeredBoxtalTools({ claimsApiAvailable: true })
    expect(tools).toContain("claim_open")
    expect(tools).toContain("exceptions_list")
  })

  it("when claims API is unavailable but claim_open is invoked directly, it records locally and reports submitted_to_carrier:false", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: false })
    const r = await claimOpen(ctx, { shipment_id: "S2", type: "lost", amount: 800, evidence_file_ids: [] })
    expect(r.submitted_to_carrier).toBe(false)
    expect(r.status).toBe("open")
  })
})

// STAGE-TIME preflight (manifest `preflight: claimOpenPreflightHandler`). claim_open is gated, so before
// this existed a claim against an unknown or non-claimable shipment still parked a pending approval, and
// the handler only threw once a human clicked approve: an error only the agent could have fixed. A gated
// call must not be parked for a human when the data it needs is missing. Both the preflight and the
// handler run the SAME eligibility function, so they cannot drift.
describe("boxtal claim_open stage-time preflight", () => {
  it("refuses a claim against an unknown shipment, writing no claim row", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: true })
    const res = await claimOpenPreflight(ctx, { shipment_id: "S_NOPE" })
    expect(res).toMatchObject({ error: { code: "shipment_not_found" } })
    expect(await ctx.db.findMany("claim", {})).toHaveLength(0)
  })

  it("refuses a claim against a shipment that is not in an exception state", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: true })
    const res = await claimOpenPreflight(ctx, { shipment_id: "S_DELIVERED" })
    expect(res).toMatchObject({ error: { code: "not_claimable" } })
    expect(await ctx.db.findMany("claim", {})).toHaveLength(0)
  })

  it("lets a genuinely claimable shipment through to the gate", async () => {
    const ctx = makeCtx({ seed: SEED, claimsApiAvailable: true })
    expect(await claimOpenPreflight(ctx, { shipment_id: "S2" })).toEqual({ ok: true })
    expect(await ctx.db.findMany("claim", {})).toHaveLength(0)
  })
})

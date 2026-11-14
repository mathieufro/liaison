// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly reconcile housekeeping on the real database: an idle proposal goes with the cards it
// drew, a card past proposed stays, and claims follow their document.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { orgTransferView } from "~/modules/org/transfer-state/state"
import {
  seedBareProject,
  seedBillingClaim,
  seedReconciliation,
} from "~/seed/factories/projects/reconcile"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  IDLE_PROPOSAL_DAYS,
  idleCutoff,
  sweepClaims,
  sweepIdleProposals,
  sweepOrgIdleProposals,
} from "./reconcile-sweep"

let orgId = ""
let owner: minimal.Session
let projectId = ""
let threadId = ""

async function card(
  state: "proposed" | "drafted",
  idleDays: number,
  month: string,
): Promise<string> {
  return seedReconciliation(orgId, {
    now: new Date(),
    projectId,
    createdBy: owner.userId,
    threadId,
    state,
    month,
    idleDays,
  })
}

async function storeCard(
  id: string,
  inThread = threadId,
  inOrg = orgId,
  by = owner.userId,
): Promise<void> {
  const call = {
    toolCallId: `call-${id.slice(0, 8)}`,
    toolName: "projects__reconcile_propose",
    args: {},
    result: { reconciliationId: id, lines: [{ proofs: [{ label: "Demo, 15 Oct" }] }] },
    card: { kind: "groups", pill: { label: "Projects: reconcile" }, latestKey: `reconcile:${id}` },
  }
  await minimal.postUserMessage(inOrg, inThread, by, "A card.", { toolCalls: [call] })
}

async function stillStored(id: string): Promise<{ row: boolean; card: boolean }> {
  const row = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM app_projects.reconciliations WHERE id = ${id}::uuid`,
    ),
  )[0]?.n
  const cards = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE metadata::text LIKE ${`%"latestKey": "reconcile:${id}"%`}`),
  )[0]?.n
  return { row: row === 1, card: (cards ?? 0) > 0 }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  projectId = await seedBareProject(orgId, {
    name: "Maison Delorme platform",
    key: "ATLAS",
    ownerId: owner.userId,
  })
  threadId = await minimal.agentDm(orgId, owner.userId)
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("the hourly reconcile housekeeping", () => {
  it("a proposal idle thirty days is deleted with its stored cards", async () => {
    const idle = await card("proposed", IDLE_PROPOSAL_DAYS + 1, "2026-08")
    const recent = await card("proposed", IDLE_PROPOSAL_DAYS - 1, "2026-09")
    const drafted = await card("drafted", IDLE_PROPOSAL_DAYS + 10, "2026-07")
    for (const id of [idle, recent, drafted]) await storeCard(id)

    const out = await sweepIdleProposals()
    expect(out.deleted).toBeGreaterThanOrEqual(1)
    expect(await stillStored(idle)).toEqual({ row: false, card: false })
    // Twenty-nine days idle, or a card that left proposed: both stay, cards and all.
    expect(await stillStored(recent)).toEqual({ row: true, card: true })
    expect(await stillStored(drafted)).toEqual({ row: true, card: true })
    // The cleared row keeps its call, with no card and no result left to show a proof label.
    const text = extractRows<{ m: string }>(
      await db.execute(drizzleSql`
        SELECT metadata::text AS m FROM kernel.messages WHERE thread_id = ${threadId}::uuid`),
    )
      .map((r) => r.m)
      .join("\n")
    expect(text.match(/Demo, 15 Oct/g)).toHaveLength(2)
  })

  it("an idle proposal drawn in two threads loses its cards in both", async () => {
    const idle = await card("proposed", IDLE_PROPOSAL_DAYS + 1, "2026-06")
    const other = await minimal.thread(orgId, owner.userId, { title: "Delorme billing" })
    await storeCard(idle)
    await storeCard(idle, other)
    await sweepIdleProposals()
    expect(await stillStored(idle)).toEqual({ row: false, card: false })
  })

  it("an org that starts moving keeps its idle proposal and its cards until a later sweep", async () => {
    const idle = await card("proposed", IDLE_PROPOSAL_DAYS + 1, "2026-05")
    await storeCard(idle)
    await db.execute(drizzleSql`
      UPDATE kernel.organizations
         SET transfer_state = 'frozen', transfer_id = ${crypto.randomUUID()}, transfer_at = now()
       WHERE id = ${orgId}::uuid`)
    try {
      await orgTransferView.refresh()
      // The org's own step, as the sweep runs it after its first read: skipped whole.
      expect(await sweepOrgIdleProposals(orgId, idleCutoff(new Date()))).toBe("skipped")
      expect(await stillStored(idle)).toEqual({ row: true, card: true })
    } finally {
      await db.execute(drizzleSql`
        UPDATE kernel.organizations
           SET transfer_state = NULL, transfer_id = NULL, transfer_at = NULL
         WHERE id = ${orgId}::uuid`)
      await orgTransferView.refresh()
    }
    await sweepIdleProposals()
    expect(await stillStored(idle)).toEqual({ row: false, card: false })
  })

  it("one org whose cards cannot be cleared keeps its proposal, and the next org is still swept", async () => {
    const second = await minimal.secondOrg({ name: "Maison Ferrand" })
    const otherOrg = second.orgId
    const otherOwner = { userId: second.adminUserId }
    const otherProject = await seedBareProject(otherOrg, {
      name: "Maison Ferrand site",
      key: "FERR",
      ownerId: otherOwner.userId,
    })
    const otherThread = await minimal.agentDm(otherOrg, otherOwner.userId)
    const broken = await card("proposed", IDLE_PROPOSAL_DAYS + 1, "2026-04")
    await storeCard(broken)
    const fine = await seedReconciliation(otherOrg, {
      now: new Date(),
      projectId: otherProject,
      createdBy: otherOwner.userId,
      threadId: otherThread,
      state: "proposed",
      month: "2026-04",
      idleDays: IDLE_PROPOSAL_DAYS + 1,
    })
    await storeCard(fine, otherThread, otherOrg, otherOwner.userId)
    const out = await sweepIdleProposals(new Date(), {
      beforeClear: (o) => {
        if (o === orgId) throw new Error("card store unavailable")
      },
    })
    expect(out.failedOrgs).toBe(1)
    expect(await stillStored(broken)).toEqual({ row: true, card: true })
    expect(await stillStored(fine)).toEqual({ row: false, card: false })
    await sweepIdleProposals()
    expect(await stillStored(broken)).toEqual({ row: false, card: false })
  })

  it("a reservation with no document an hour on is released, and the sweep runs on empty claims", async () => {
    expect(await sweepClaims()).toEqual(expect.objectContaining({ billed: 0 }))
    const claim = (sourceRef: string, ageMinutes: number) =>
      seedBillingClaim(orgId, {
        now: new Date(),
        projectId,
        sourceRef,
        periodKey: "2026-10",
        state: "reserved",
        ageMinutes,
      })
    const old = [await claim("ATLAS-1", 120), await claim("ATLAS-2", 0)]
    await sweepClaims()
    const states = extractRows<{ state: string }>(
      await db.execute(drizzleSql`
        SELECT state FROM app_projects.billing_claims
         WHERE id IN (${old[0]}::uuid, ${old[1]}::uuid) ORDER BY source_ref`),
    ).map((r) => r.state)
    expect(states).toEqual(["released", "reserved"])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editing a month-end run on the real kernel, sandbox and Postgres. A row is a draft, changed only
// through the draft tools; every change is checked server-side, names who made it and what changed,
// moves the card's hash, and after the decision waits for a second card. An edit never touches an
// issued invoice or a taken number.
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { ObjectStorageTestAccess } from "~/infra/storage/object-storage"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import {
  approvalEditableFieldsRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTemplate } from "~/modules/pdf/registry"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  approvalOf,
  approve,
  asRead,
  call,
  docOf,
  drafted,
  itemsOf,
  pendingApprovals,
  type Row,
  registerInvoicing,
  reject,
  runJob,
  runOf,
  SCOPES,
  scheduleOf,
  world,
} from "./run-edit-fixture"

async function registerInvoiceTemplate(): Promise<void> {
  const { join } = await import("node:path")
  const root = join(import.meta.dir, "..", "..", "..", "..", "..")
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(root, "bundled-apps", "invoicing", "templates", "invoice.ts"),
      "--target",
      "bun",
      "--external",
      "node:*",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (build.exitCode !== 0) throw new Error(`template build failed: ${build.stderr.toString()}`)
  let js = build.stdout.toString()
  const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
  const local = block?.[1]
    ?.split(",")
    .map((x) => x.trim())
    .map((x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null))
    .find((x) => x)
  if (!block || !local) throw new Error("template exports no renderTemplate")
  js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
  registerTemplate("invoicing", "invoicing:invoice_v1", js)
}

async function cardHash(approvalId: string): Promise<string> {
  const a = await approvalOf(approvalId)
  return approvalPayloadHash(String(a.tool_name), a.current_payload)
}

function cardRows(a: Row): Array<{ item_id: string; content_hash: string; total_minor: string }> {
  return ((a.current_payload as { items?: unknown[] }).items ?? []) as Array<{
    item_id: string
    content_hash: string
    total_minor: string
  }>
}

async function sequenceOf(issuer: string): Promise<number> {
  const [row] = await sql<Array<{ value: number | string }>>`
    SELECT value FROM kernel.app_sequences WHERE org_id = ${world.org} AND key = ${`invoicing:doc_number:${issuer}:invoice:2026`}`
  return Number(row?.value ?? 0)
}

const LINES = (price: number) => [
  {
    description: "Retainer November 2026",
    quantity: "1",
    unit_price_minor: String(price),
    tax_rate_bp: 2000,
    line_kind: "service",
  },
]

describe("editing a month-end run on the real kernel", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    world.org = org.id
    const admin = await minimal.person(world.org, { role: "admin" })
    world.actor = {
      actorType: "user",
      userId: admin.id,
      orgId: world.org,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    world.agentId = randomUUID()
    await initSandboxPool()
    await initWorkerPool()
    await registerInvoicing()
    await registerInvoiceTemplate()
  }, 120_000)

  afterEach(() => {
    setSystemTime()
    ObjectStorageTestAccess.resetClient()
  })

  afterAll(async () => {
    setSystemTime()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("no run item tool exists, the run card declares no editable fields, and editing the card's payload is refused naming the draft tools", async () => {
    const names = [...toolRegistry.entriesOf(world.org)]
      .filter(([k]) => k[1] === "invoicing")
      .map(([k]) => k[2])
    expect(names).toContain("drafts_update")
    expect(names.some((n) => n.startsWith("recurring_run_item_"))).toBe(false)
    const card = toolRegistry.get([world.org, "invoicing", "recurring_run_issue"])
    expect(
      approvalEditableFieldsRegistry.get([world.org, "invoicing", "recurring_run_issue"]) ?? [],
    ).toEqual([])
    expect(card?.editWith).toEqual(["drafts_update", "drafts_create", "drafts_discard"])
    const fx = await drafted(1)
    const before = await cardHash(fx.card)
    let message = ""
    try {
      await updatePayload({
        orgId: world.org,
        requestId: fx.card,
        fields: { items: [] },
        actor: world.actor,
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("drafts_update")
    expect(message).toContain("drafts_create")
    expect(message).toContain("drafts_discard")
    expect(await cardHash(fx.card)).toBe(before)
  }, 120_000)

  it("an added row is held by the re-ask card and a repeated add is refused already_in_run", async () => {
    const fx = await drafted(1)
    await approve(fx.card)
    const add = {
      type: "invoice",
      run_id: fx.runId,
      counterparty_name: "Sauvan",
      counterparty_address: "3 rue Neuve, 69001 Lyon",
      counterparty_email: "sauvan@example.com",
      counterparty_country: "FR",
      customer_kind: "individual",
      items: [
        { description: "2 days", quantity: "2", unit_price_minor: "65000", tax_rate_bp: 2000 },
      ],
    }
    const added = await call("drafts_create", add, "agent")
    expect(added.error).toBeUndefined()
    const items = await itemsOf(fx.runId)
    const row = items.find((i) => i.source === "added")
    expect(row?.state).toBe("waiting_reapproval")
    expect(row?.schedule_id).toBeNull()
    expect((await docOf(String(row?.document_id))).external_ref).toBe(`recurring:added:${row?.id}`)
    // The original card was decided; one new card asks for the added row only.
    const reask = (await pendingApprovals()).filter(
      (a) =>
        a.tool_name === "invoicing:recurring_run_issue" &&
        (a.current_payload as Row).run_id === fx.runId,
    )
    expect(reask).toHaveLength(1)
    expect(cardRows(reask[0] as Row).map((r) => r.item_id)).toEqual([String(row?.id)])
    const again = await call("drafts_create", add, "agent")
    expect(again.error).toContain("already_in_run")
    expect((await itemsOf(fx.runId)).filter((i) => i.source === "added")).toHaveLength(1)
    const forced = await call("drafts_create", { ...add, allow_duplicate: true }, "person")
    expect(forced.error).toBeUndefined()
  }, 120_000)

  it("taking a scheduled row out asks how far; this month keeps the draft for put back; next month is unchanged", async () => {
    const fx = await drafted(2)
    const [first] = await itemsOf(fx.runId)
    const asked = await call("drafts_discard", { draft_id: String(first?.document_id) })
    expect(asked.error).toContain("applies_required")
    expect(asked.error).toContain("this month only, or end the schedule?")
    const out = await call("drafts_discard", {
      draft_id: String(first?.document_id),
      applies: "this_month",
    })
    expect(out.data).toMatchObject({ ok: true, itemState: "left_out" })
    expect((await docOf(String(first?.document_id))).status).toBe("draft")
    expect(cardRows(await approvalOf(fx.card)).map((r) => r.item_id)).not.toContain(
      String(first?.id),
    )
    const s = await scheduleOf(fx.schedules[0] as string)
    expect(s.next_issue_on).toBe("2026-12-31")
    // Put back until the run closes.
    const back = await call("drafts_update", {
      ...(await asRead(String(first?.document_id))),
      put_back: true,
    })
    expect(back.error).toBeUndefined()
    expect((await itemsOf(fx.runId))[0]?.state).toBe("ready")
    // Take it out again: December still drafts it.
    await call("drafts_discard", { draft_id: String(first?.document_id), applies: "this_month" })
    setSystemTime(new Date("2026-12-29T09:00:00Z"))
    await runJob("recurring-draft")
    const [dec] = await sql<Row[]>`
      SELECT i.state FROM app_invoicing.recurring_run_items i JOIN app_invoicing.recurring_runs r ON r.id = i.run_id
      WHERE i.schedule_id = ${fx.schedules[0] as string} AND i.period_key = '2026-12'`
    expect(dec?.state).toBe("ready")
  }, 120_000)

  it("ending the schedule sets ends_on at once and put back restores it", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const noDate = await call("drafts_discard", {
      draft_id: String(item?.document_id),
      applies: "end_schedule",
    })
    expect(noDate.error).toContain("ends_on_required")
    const ended = await call("drafts_discard", {
      draft_id: String(item?.document_id),
      applies: "end_schedule",
      ends_on: "2026-10-31",
    })
    expect(ended.data).toMatchObject({ ok: true, itemState: "left_out" })
    expect((await scheduleOf(fx.schedules[0] as string)).ends_on).toBe("2026-10-31")
    const back = await call("drafts_update", {
      ...(await asRead(String(item?.document_id))),
      put_back: true,
    })
    expect(back.error).toBeUndefined()
    expect((await scheduleOf(fx.schedules[0] as string)).ends_on).toBeNull()
    expect((await itemsOf(fx.runId))[0]?.state).toBe("ready")
    // Ending inside the period keeps the row as the last invoice.
    const last = await call("drafts_discard", {
      draft_id: String(item?.document_id),
      applies: "end_schedule",
      ends_on: "2026-11-30",
    })
    expect(last.data).toMatchObject({ ok: true, itemState: "ready" })
    expect(String((await itemsOf(fx.runId))[0]?.note)).toContain("Last invoice")
  }, 120_000)

  it("ending names what it does not stop and writes nothing to the payment connector or an agreement", async () => {
    const fx = await drafted(1, { paidBy: "card_link", numbered: true })
    const [item] = await itemsOf(fx.runId)
    const pendingBefore = (await pendingApprovals()).length
    const ended = await call("drafts_discard", {
      draft_id: String(item?.document_id),
      applies: "end_schedule",
      ends_on: "2026-11-30",
    })
    const notes = (ended.data?.notes ?? []) as string[]
    expect(notes.join(" ")).toContain("card payment link keeps working")
    expect(notes.join(" ")).toContain("https://pay.example.test/l/abc")
    expect(notes.join(" ")).toContain("F-2026-0411 stays as issued")
    expect(notes.join(" ")).toContain("Nothing else changes")
    // No other request was staged, and the payment connector's subscriptions,
    // when its table exists, hold no row for this org.
    expect((await pendingApprovals()).length).toBe(pendingBefore)
    const [connector] = await sql<
      Array<{ present: boolean }>
    >`SELECT to_regclass('app_stripe.stripe_subscriptions') IS NOT NULL AS present`
    if (connector?.present) {
      const [writes] = await sql<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM app_stripe.stripe_subscriptions WHERE org_id = ${world.org}`
      expect(writes?.n).toBe(0)
    }
  }, 120_000)

  it("a lines change without applies is refused applies_required, a note or PO change never asks", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const asked = await call("drafts_update", {
      ...(await asRead(draft)),
      patch: { lines: LINES(65000) },
    })
    expect(asked.error).toContain("applies_required")
    const note = await call("drafts_update", {
      ...(await asRead(draft)),
      patch: { notes: "Contract C-12" },
    })
    expect(note.error).toBeUndefined()
    const po = await call("drafts_update", {
      ...(await asRead(draft)),
      patch: { po_number: "PO-778" },
    })
    expect(po.error).toBeUndefined()
    const d = await docOf(draft)
    expect(d).toMatchObject({ notes: "Contract C-12", po_number: "PO-778" })
    const currency = await call("drafts_update", {
      ...(await asRead(draft)),
      patch: { currency: "USD" },
      applies: "from_now_on",
    })
    expect(currency.error).toContain("schedule_has_no_currency")
  }, 120_000)

  it("a run row's draft without its back reference is still the row's: a lines change asks how far and writes nothing", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    await sql`UPDATE app_invoicing.documents SET external_refs = '{}'::jsonb WHERE id = ${draft}::uuid`
    const before = await docOf(draft)
    const asked = await call(
      "drafts_update",
      { ...(await asRead(draft)), patch: { lines: LINES(65000) } },
      "agent",
    )
    expect(asked.error).toContain("applies_required")
    expect((await docOf(draft)).subtotal_minor).toBe(before.subtotal_minor)
  }, 120_000)

  it("from now on is written to the schedule at approval and not when the run is rejected", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    await call("drafts_update", {
      ...(await asRead(draft)),
      patch: { lines: LINES(65000) },
      applies: "from_now_on",
    })
    expect((await itemsOf(fx.runId))[0]?.schedule_patch).toMatchObject({ applies: "from_now_on" })
    expect((await scheduleOf(fx.schedules[0] as string)).version).toBe(1)
    await approve(fx.card)
    const s = await scheduleOf(fx.schedules[0] as string)
    expect(s.version).toBe(2)
    expect((s.lines as Array<{ unit_price_minor: number; description: string }>)[0]).toMatchObject({
      unit_price_minor: 65000,
      description: "Retainer {period}",
    })

    const other = await drafted(1)
    const [row] = await itemsOf(other.runId)
    await call("drafts_update", {
      ...(await asRead(String(row?.document_id))),
      patch: { lines: LINES(65000) },
      applies: "from_now_on",
    })
    await reject(other.card)
    const kept = await scheduleOf(other.schedules[0] as string)
    expect(kept.version).toBe(1)
    expect((kept.lines as Array<{ unit_price_minor: number }>)[0]?.unit_price_minor).toBe(10000)
  }, 120_000)

  it("an agent's change reads as the agent's and a person's Save has no agent id while an agent runs elsewhere", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const byAgent = await call(
      "drafts_update",
      { ...(await asRead(draft)), patch: { notes: "From the agent" } },
      "agent",
    )
    expect(byAgent.error).toBeUndefined()
    // A person saves while an agent turn is running in another frame.
    const asPerson = asRead(draft).then((r) =>
      call("drafts_update", { ...r, patch: { notes: "From the person" } }, "person"),
    )
    const elsewhere = call("recurring_run_get", { run_id: fx.runId }, "agent")
    const [mine] = await Promise.all([asPerson, elsewhere])
    expect(mine.error).toBeUndefined()
    const log = ((await docOf(draft)).lifecycle_log as Row[]).filter((e) => e.event === "run_edit")
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ agent_id: world.agentId, actor_user_id: world.actor.userId })
    expect(log[0]?.fields).toEqual([{ field: "notes", from: null, to: "From the agent" }])
    expect(log[1]).toMatchObject({ agent_id: null, actor_user_id: world.actor.userId })
  }, 120_000)

  it("each of the five write kinds changes the payload hash, switching applies alone changes it, a no-op does not", async () => {
    const fx = await drafted(3)
    const items = await itemsOf(fx.runId)
    const [a, b, c] = items.map((i) => String(i.document_id))
    const hashes: string[] = [await cardHash(fx.card)]
    const step = async (fn: () => Promise<unknown>) => {
      await fn()
      hashes.push(await cardHash(fx.card))
    }
    // 1. a field change, 2. a lines change, 3. an added row, 4. a take out, 5. a put back
    await step(async () =>
      call("drafts_update", { ...(await asRead(a as string)), patch: { notes: "Note" } }),
    )
    await step(async () =>
      call("drafts_update", {
        ...(await asRead(b as string)),
        patch: { lines: LINES(42000) },
        applies: "this_month",
      }),
    )
    await step(() =>
      call("drafts_create", {
        type: "invoice",
        run_id: fx.runId,
        counterparty_name: "Added",
        counterparty_address: "1 Main St",
        counterparty_email: "added@example.com",
        counterparty_country: "DE",
        customer_kind: "individual",
        items: [{ description: "x", quantity: "1", unit_price_minor: "100", tax_rate_bp: 2000 }],
      }),
    )
    await step(() => call("drafts_discard", { draft_id: c as string, applies: "this_month" }))
    await step(async () =>
      call("drafts_update", { ...(await asRead(c as string)), put_back: true }),
    )
    // Switching how far with an identical draft.
    await step(async () =>
      call("drafts_update", {
        ...(await asRead(b as string)),
        patch: { lines: LINES(42000) },
        applies: "from_now_on",
      }),
    )
    // Every write moved the card from where the previous one left it.
    for (let i = 1; i < hashes.length; i++) expect(hashes[i]).not.toBe(hashes[i - 1])
    // A write that changes nothing.
    const still = await cardHash(fx.card)
    await call("drafts_update", { ...(await asRead(a as string)), patch: { notes: "Note" } })
    expect(await cardHash(fx.card)).toBe(still)
  }, 120_000)

  it("a write with a stale updated_at is refused draft_changed naming who", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const stale = await asRead(draft)
    await new Promise((r) => setTimeout(r, 5))
    await call("drafts_update", { ...(await asRead(draft)), patch: { notes: "First" } }, "agent")
    const second = await call("drafts_update", { ...stale, patch: { notes: "Second" } })
    expect(second.error).toContain("draft_changed")
    expect(second.error).toContain(`agent ${world.agentId}`)
    expect((await docOf(draft)).notes).toBe("First")
    const none = await call("drafts_update", { draft_id: draft, patch: { notes: "Third" } })
    expect(none.error).toContain("if_unchanged_since_required")
  }, 120_000)

  it("a fixed, added or put-back row after the decision joins one re-ask card and issues after its approve", async () => {
    const fx = await drafted(3)
    const items = await itemsOf(fx.runId)
    // Before the decision: one row needs a fix (no address), one is taken out.
    const [fixme, out] = [String(items[0]?.document_id), String(items[1]?.document_id)]
    await sql`UPDATE app_invoicing.documents SET counterparty_address = NULL, billing_line1 = NULL WHERE id = ${fixme}`
    await call("drafts_update", { ...(await asRead(fixme)), patch: { notes: "Needs address" } })
    expect((await itemsOf(fx.runId))[0]?.state).toBe("needs_fix")
    await call("drafts_discard", { draft_id: out, applies: "this_month" })
    expect(cardRows(await approvalOf(fx.card))).toHaveLength(1)
    await approve(fx.card)
    // After it: fix, put back, add.
    await call("drafts_update", {
      ...(await asRead(fixme)),
      patch: { counterparty_address: "Hauptstrasse 1, 10115 Berlin" },
      applies: "this_month",
    })
    await call("drafts_update", { ...(await asRead(out)), put_back: true })
    await call("drafts_create", {
      type: "invoice",
      run_id: fx.runId,
      counterparty_name: "Late add",
      counterparty_address: "1 Main St",
      counterparty_email: "late@example.com",
      counterparty_country: "DE",
      customer_kind: "individual",
      items: [{ description: "x", quantity: "1", unit_price_minor: "5000", tax_rate_bp: 2000 }],
    })
    const waiting = (await itemsOf(fx.runId)).filter((i) => i.state === "waiting_reapproval")
    expect(waiting).toHaveLength(3)
    // A person's own edits never approve: the card they owe is staged by the run's job.
    await runJob("recurring-issue")
    const reask = (await pendingApprovals()).filter(
      (a) =>
        a.tool_name === "invoicing:recurring_run_issue" &&
        (a.current_payload as Row).run_id === fx.runId,
    )
    expect(reask).toHaveLength(1)
    expect(cardRows(reask[0] as Row)).toHaveLength(3)
    await approve(String(reask[0]?.id))
    setSystemTime(new Date("2026-11-30T07:30:00Z"))
    await runJob("recurring-issue")
    const after = await itemsOf(fx.runId)
    expect(after.map((i) => [i.state, i.failure])).toEqual(
      ["issued", "issued", "issued", "issued"].map((s) => [s, null]),
    )
    expect(after.map((i) => i.state)).toEqual(["issued", "issued", "issued", "issued"])
    expect(await sequenceOf(fx.issuer)).toBe(4)
    // An issued row refuses any change and names its number.
    const issuedDoc = String(after[0]?.document_id)
    const refused = await call("drafts_update", {
      draft_id: issuedDoc,
      if_unchanged_since: "x",
      patch: { notes: "late" },
    })
    expect(refused.error).toContain("already_issued")
    expect(refused.error).toContain(String(after[0]?.issued_number))
  }, 120_000)

  it("undo keeps every edit and the written patches", async () => {
    const fx = await drafted(2)
    const rows = await itemsOf(fx.runId)
    const [a, b] = rows.map((i) => String(i.document_id))
    // The schedule behind row b: the run lists its rows in its own order, not the fixture's.
    const bSchedule = String(rows[1]?.schedule_id)
    expect(
      (await call("drafts_update", { ...(await asRead(a as string)), patch: { notes: "Kept" } }))
        .error,
    ).toBeUndefined()
    expect(
      (
        await call("drafts_update", {
          ...(await asRead(b as string)),
          patch: { lines: LINES(77000) },
          applies: "from_now_on",
        })
      ).error,
    ).toBeUndefined()
    expect((await itemsOf(fx.runId)).map((i) => i.state)).toEqual(["ready", "ready"])
    await approve(fx.card)
    expect((await itemsOf(fx.runId)).map((i) => i.state)).toEqual(["approved", "approved"])
    expect((await scheduleOf(bSchedule)).version).toBe(2)
    const undo = await call("recurring_run_unapprove", { run_id: fx.runId })
    const pending = (await pendingApprovals()).find(
      (p) => p.tool_name === "invoicing:recurring_run_unapprove",
    )
    if (pending) await approve(String(pending.id))
    expect(undo.error ?? "").not.toContain("refused")
    expect((await runOf(fx.issuer)).status).toBe("drafted")
    expect((await docOf(a as string)).notes).toBe("Kept")
    expect((await scheduleOf(bSchedule)).version).toBe(2)
    const items = await itemsOf(fx.runId)
    expect(items.every((i) => i.state === "ready" && i.approved_hash === null)).toBe(true)
    await runJob("recurring-issue")
    // The card is back with the current rows; approving again writes nothing twice.
    const card = (await pendingApprovals()).filter(
      (p) =>
        p.tool_name === "invoicing:recurring_run_issue" &&
        (p.current_payload as Row).run_id === fx.runId,
    )
    expect(card).toHaveLength(1)
    await approve(String(card[0]?.id))
    expect((await scheduleOf(bSchedule)).version).toBe(2)
  }, 120_000)

  it("a zero total is nothing to bill and a negative total is a credit note, both outside Approve N", async () => {
    const fx = await drafted(3)
    const [z, n] = (await itemsOf(fx.runId)).map((i) => String(i.document_id))
    await call("drafts_update", {
      ...(await asRead(z as string)),
      patch: { lines: LINES(0) },
      applies: "this_month",
    })
    const neg = await call("drafts_update", {
      ...(await asRead(n as string)),
      patch: { lines: LINES(-5000) },
      applies: "this_month",
    })
    const items = await itemsOf(fx.runId)
    expect(items[0]).toMatchObject({ state: "needs_fix" })
    expect(String(items[0]?.note)).toContain("Nothing to bill")
    expect(items[1]).toMatchObject({ state: "needs_fix" })
    expect(String(items[1]?.note)).toContain("A negative total is a credit note")
    expect(JSON.stringify(neg.data)).toContain("credit_note_create_and_issue")
    expect(cardRows(await approvalOf(fx.card))).toHaveLength(1)
    await approve(fx.card)
    expect((await itemsOf(fx.runId)).map((i) => i.state)).toEqual([
      "needs_fix",
      "needs_fix",
      "approved",
    ])
  }, 120_000)

  it("use it writes the address on the contact and the draft, and an agent's found address changes nothing but the suggestion", async () => {
    const fx = await drafted(2, { withAddress: false })
    const [a, b] = await itemsOf(fx.runId)
    expect(a?.state).toBe("needs_fix")
    const before = await docOf(String(a?.document_id))
    const found = await call(
      "drafts_update",
      {
        ...(await asRead(String(a?.document_id))),
        patch: { counterparty_address: "Rue 9, 1000 Bruxelles", notes: "x" },
        applies: "this_month",
      },
      "agent",
    )
    expect(found.error).toBeUndefined()
    const after = await docOf(String(a?.document_id))
    expect(after.counterparty_address).toBeNull()
    expect(after.notes).toBe(before.notes)
    expect((await itemsOf(fx.runId))[0]?.fix_suggestion).toMatchObject({
      counterparty_address: "Rue 9, 1000 Bruxelles",
    })
    // A person's Use it: the draft has it, the row is ready, the contact's billing address follows.
    const used = await call("drafts_update", {
      ...(await asRead(String(b?.document_id))),
      patch: {
        counterparty_address: "Hauptstrasse 2, 10115 Berlin",
        billing_line1: "Hauptstrasse 2",
        billing_postcode: "10115",
        billing_city: "Berlin",
        billing_country_code: "DE",
      },
      applies: "this_month",
    })
    expect(used.error).toBeUndefined()
    expect((await docOf(String(b?.document_id))).counterparty_address).toBe(
      "Hauptstrasse 2, 10115 Berlin",
    )
    expect((await itemsOf(fx.runId))[1]?.state).toBe("ready")
    const notes = JSON.stringify(
      (used.data as { run_row?: { notes?: string[] } }).run_row?.notes ?? [],
    )
    expect(notes).toMatch(/billing address/)
    expect(notes).not.toContain("was not saved")
    expect(notes).toMatch(
      /also the contact's billing address now|contact's billing address waits for approval/,
    )
  }, 120_000)

  it("a schedule edit after approve leaves the old amount to issue and notes the change; an IBAN change since approval leaves every item unissued with one new card", async () => {
    const fx = await drafted(1)
    await approve(fx.card)
    const [item] = await itemsOf(fx.runId)
    const hash = item?.approved_hash
    const newLines = JSON.stringify([
      {
        description: "Retainer 1 {period}",
        qty: 1,
        unit_price_minor: 99900,
        vat_bp: 2000,
        line_kind: "service",
      },
    ])
    await sql`UPDATE app_invoicing.recurring_schedules SET lines = ${newLines}::jsonb, version = version + 1 WHERE id = ${fx.schedules[0] as string}`
    const got = await call("recurring_run_get", { run_id: fx.runId })
    expect(JSON.stringify(got.data)).toContain("The schedule changed after this draft")
    expect((await itemsOf(fx.runId))[0]?.approved_hash).toBe(hash)
    setSystemTime(new Date("2026-11-30T07:30:00Z"))
    await runJob("recurring-issue")
    const [issued] = await sql<
      Row[]
    >`SELECT grand_total_minor::text AS t FROM app_invoicing.documents WHERE id = ${String((await itemsOf(fx.runId))[0]?.document_id)}`
    expect(issued?.t).toBe("12000")
    setSystemTime(new Date("2026-12-29T09:00:00Z"))
    await runJob("recurring-draft")
    const [dec] = await sql<Row[]>`
      SELECT l.unit_price_minor::text AS p FROM app_invoicing.recurring_run_items i JOIN app_invoicing.document_lines l ON l.document_id = i.document_id
      WHERE i.schedule_id = ${fx.schedules[0] as string} AND i.period_key = '2026-12'`
    expect(dec?.p).toBe("99900")

    const iban = await drafted(3)
    await approve(iban.card)
    await sql`UPDATE app_invoicing.issuer_profiles SET iban = 'FR7612345000019876543210111' WHERE id = ${iban.issuer}`
    setSystemTime(new Date("2026-11-30T07:30:00Z"))
    await runJob("recurring-issue")
    expect((await itemsOf(iban.runId)).map((i) => i.state)).toEqual([
      "waiting_reapproval",
      "waiting_reapproval",
      "waiting_reapproval",
    ])
    expect(await sequenceOf(iban.issuer)).toBe(0)
    const cards = (await pendingApprovals()).filter(
      (a) =>
        a.tool_name === "invoicing:recurring_run_issue" &&
        (a.current_payload as Row).run_id === iban.runId,
    )
    expect(cards).toHaveLength(1)
    expect(cardRows(cards[0] as Row)).toHaveLength(3)
  }, 120_000)

  it("an edit between the first check and the claim is refused by the second", async () => {
    const fx = await drafted(1)
    const shown = await cardHash(fx.card)
    const [item] = await itemsOf(fx.runId)
    await call("drafts_update", {
      ...(await asRead(String(item?.document_id))),
      patch: { po_number: "PO-1" },
    })
    let code = ""
    try {
      await decideApproval({
        orgId: world.org,
        requestId: fx.card,
        actor: world.actor,
        decision: "approve",
        payloadHash: shown,
      })
    } catch (err) {
      code = String(
        (err as { code?: string; details?: { code?: string } }).code ?? (err as Error).message,
      )
    }
    expect(code).toContain("payload_changed")
    expect((await itemsOf(fx.runId))[0]?.approved_hash).toBeNull()
  }, 120_000)

  it('a note "New bank details" added before approve refuses with the note shown', async () => {
    const fx = await drafted(1)
    const shown = await cardHash(fx.card)
    const [item] = await itemsOf(fx.runId)
    await call(
      "drafts_update",
      {
        ...(await asRead(String(item?.document_id))),
        patch: { notes: "New bank details: FR76 9999" },
      },
      "agent",
    )
    let refused = ""
    try {
      await decideApproval({
        orgId: world.org,
        requestId: fx.card,
        actor: world.actor,
        decision: "approve",
        payloadHash: shown,
      })
    } catch (err) {
      refused = String((err as { code?: string }).code ?? (err as Error).message)
    }
    expect(refused).toContain("payload_changed")
    const log = ((await docOf(String(item?.document_id))).lifecycle_log as Row[]).filter(
      (e) => e.event === "run_edit",
    )
    expect(JSON.stringify(log.at(-1)?.fields)).toContain("New bank details")
    expect((await runOf(fx.issuer)).status).toBe("drafted")
  }, 120_000)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A month-end run on the real kernel, sandbox and Postgres, for the tests that edit its rows: an
// issuer in Paris, monthly schedules drafted on Friday 27 November 2026, the run's card, and calls
// made as a person (no agent), as a person's agent in a turn they typed, or as a routine.
import { setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import { registerApps } from "~/modules/apps/runtime"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"

/** The kernel schema under the run namespace's prefix. */
const KERNEL = () => sql(schemaRef("kernel"))

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

export type Row = Record<string, unknown>

export function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

export const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
  "kernel:contacts:read",
  "kernel:contacts:write",
]

export const world: { org: string; actor: UserContext; agentId: string } = {
  org: "",
  actor: null as unknown as UserContext,
  agentId: "",
}

export async function registerInvoicing(): Promise<void> {
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  await registerApps([invoicingDescriptor() as never], world.org)
}

/** A frame for a turn: the person's own (they typed it) or a routine's (nobody behind it). */
export function turnFrame(kind: "person" | "routine"): RunContext {
  const runId = randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: world.agentId,
    turnScopeAccumulator: createTurnScopeAccumulator(),
    ...(kind === "person" ? { humanTurn: true } : { routineId: randomUUID(), background: true }),
  }
}

/**
 * A tool call. `as: "person"` is a click (the REST tool route, no agent); `as: "agent"` is the
 * person's agent in a clean turn they typed; `as: "routine"` an agent with nobody behind it.
 */
export async function call(
  toolName: string,
  params: Row,
  as: "person" | "agent" | "routine" = "person",
  opts: { threadId?: string; turnRead?: string[] } = {},
): Promise<{ data?: Row; error?: string; code?: string; blocked?: Row }> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  const run = async () => {
    try {
      const res = await executeTool<Row>({
        toolName: `invoicing:${toolName}`,
        orgId: world.org,
        actor: world.actor,
        params,
        origin: as === "person" ? "human-ui" : "in-app-agent",
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      })
      return {
        data: res.data as Row,
        ...(res.blocked ? { blocked: res.blocked as unknown as Row } : {}),
      }
    } catch (err) {
      const e = err as { message?: string; details?: { code?: string }; code?: string }
      return {
        error: `${e.details?.code ?? e.code ?? ""} ${e.message ?? String(err)}`,
        code: e.details?.code ?? e.code,
      }
    }
  }
  if (as === "person") return run()
  const frame = turnFrame(as === "agent" ? "person" : "routine")
  // What the turn read before this call (its scope taint).
  if (opts.turnRead) frame.turnScopeAccumulator?.recordInjected(opts.turnRead)
  return runContextStore.run(frame, run)
}

export async function runJob(name: string): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", name)
  if (!handler) throw new Error(`${name} not registered`)
  await dispatchAppJobWithContext(
    handler,
    { orgId: world.org },
    { actorType: "system", orgId: world.org, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

export interface MonthEnd {
  issuer: string
  schedules: string[]
  contacts: string[]
  previous: string[]
}

/**
 * An issuer in Paris with `n` monthly schedules due for their draft on Friday 27 November 2026.
 * `withAddress: false` leaves the customers with no billing address (nor their last invoices).
 */
export async function monthEnd(
  n: number,
  opts: { withAddress?: boolean; paidBy?: "transfer" | "card_link"; numbered?: boolean } = {},
): Promise<MonthEnd> {
  const issuer = randomUUID()
  await sql.unsafe(
    insertSql("app_invoicing.issuer_profiles", {
      id: issuer,
      org_id: world.org,
      legal_name: `Studio ${issuer.slice(0, 8)}`,
      country: "FR",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      iban: "FR7630006000011234567890189",
      default_currency: "EUR",
      default_language: "en",
      timezone: "Europe/Paris",
    }),
  )
  const schedules: string[] = []
  const contacts: string[] = []
  const previous: string[] = []
  for (let i = 1; i <= n; i++) {
    // A real contact: a person's billing address on the row is saved on it.
    const contact = await minimal.contact(
      world.org,
      `client-${randomUUID().slice(0, 8)}@example.com`,
      { name: `Client ${i}` },
    )
    // Each draft is made out to the contact as it reads on the draft day.
    if (opts.withAddress !== false) {
      await minimal.contactAddress(world.org, contact, {
        role: "billing",
        street1: `Hauptstrasse ${i}`,
        postalCode: "10115",
        city: "Berlin",
        countryIso2: "DE",
      })
    }
    const prev = randomUUID()
    const id = randomUUID()
    await sql.unsafe(
      insertSql("app_invoicing.documents", {
        id: prev,
        org_id: world.org,
        type: "invoice",
        status: "issued",
        ...(opts.numbered
          ? { number: `F-2026-04${10 + i}`, number_int: 410 + i, year_of_issue: 2026 }
          : {}),
        issuer_profile_id: issuer,
        counterparty_contact_id: contact,
        counterparty_name: `Client ${i}`,
        counterparty_address: opts.withAddress === false ? null : `Hauptstrasse ${i}, 10115 Berlin`,
        counterparty_country: "DE",
        customer_kind: "individual",
        counterparty_email: `client${i}@example.com`,
        currency: "EUR",
        external_refs: { raw: "'{}'::jsonb" },
        lifecycle_log: { raw: "'[]'::jsonb" },
      }),
    )
    await sql.unsafe(
      insertSql("app_invoicing.recurring_schedules", {
        id,
        org_id: world.org,
        issuer_profile_id: issuer,
        contact_id: contact,
        status: "active",
        repeats: "month",
        billing_day: "last",
        paid_by: opts.paidBy ?? "transfer",
        ...(opts.paidBy === "card_link" ? { card_link_url: "https://pay.example.test/l/abc" } : {}),
        lines: {
          raw: `'${JSON.stringify([{ description: `Retainer ${i} {period}`, qty: 1, unit_price_minor: 10000 * i, vat_bp: 2000, line_kind: "service" }])}'::jsonb`,
        },
        next_issue_on: "2026-11-30",
        next_draft_on: "2026-11-27",
        last_document_id: prev,
        created_by: world.actor.userId,
      }),
    )
    schedules.push(id)
    contacts.push(contact)
    previous.push(prev)
  }
  return { issuer, schedules, contacts, previous }
}

export async function runOf(issuer: string): Promise<Row> {
  const [run] = await sql<Row[]>`
    SELECT id::text, status, approval_request_id, approved_by::text
    FROM app_invoicing.recurring_runs WHERE issuer_profile_id = ${issuer} ORDER BY issue_on LIMIT 1`
  if (!run) throw new Error("no run")
  return run
}

export async function itemsOf(runId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT id::text, state, source, document_id::text, schedule_id::text, issued_number, note, schedule_patch,
           fix_suggestion, ends_on_before::text, approved_hash, failure
    FROM app_invoicing.recurring_run_items WHERE run_id = ${runId} ORDER BY position`
}

export async function docOf(id: string): Promise<Row> {
  const [d] = await sql<Row[]>`
    SELECT id::text, status, number, notes, po_number, counterparty_address, lifecycle_log, external_ref,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM app_invoicing.documents WHERE id = ${id}`
  if (!d) throw new Error(`no document ${id}`)
  return d
}

export async function scheduleOf(id: string): Promise<Row> {
  const [s] = await sql<Row[]>`
    SELECT id::text, version, lines, ends_on::text, contact_id::text, next_issue_on::text
    FROM app_invoicing.recurring_schedules WHERE id = ${id}`
  if (!s) throw new Error(`no schedule ${id}`)
  return s
}

/** The pending approvals of the org, and the run card's payload. */
export async function pendingApprovals(): Promise<Row[]> {
  return sql<Row[]>`
    SELECT id::text, tool_name, status, current_payload
    FROM ${KERNEL()}.approval_requests WHERE org_id = ${world.org} AND status = 'pending' ORDER BY created_at`
}

export async function approvalOf(id: string): Promise<Row> {
  const [a] = await sql<Row[]>`
    SELECT id::text, tool_name, status, current_payload FROM ${KERNEL()}.approval_requests WHERE id = ${id}`
  if (!a) throw new Error(`no approval ${id}`)
  return a
}

/** Draft on Friday 27 November 09:00 UTC; the card waits. */
export async function drafted(
  n: number,
  opts: Parameters<typeof monthEnd>[1] = {},
): Promise<MonthEnd & { runId: string; card: string }> {
  const fx = await monthEnd(n, opts)
  setSystemTime(new Date("2026-11-27T09:00:00Z"))
  await runJob("recurring-draft")
  const run = await runOf(fx.issuer)
  return { ...fx, runId: String(run.id), card: String(run.approval_request_id) }
}

export async function approve(approvalId: string): Promise<void> {
  await decideApproval({
    orgId: world.org,
    requestId: approvalId,
    actor: world.actor,
    decision: "approve",
  })
}

export async function reject(approvalId: string): Promise<void> {
  await decideApproval({
    orgId: world.org,
    requestId: approvalId,
    actor: world.actor,
    decision: "deny",
  })
}

/** The fields a write to a run row needs: the draft, and the version it was read at. */
export async function asRead(
  draftId: string,
): Promise<{ draft_id: string; if_unchanged_since: string }> {
  return { draft_id: draftId, if_unchanged_since: String((await docOf(draftId)).updated_at) }
}

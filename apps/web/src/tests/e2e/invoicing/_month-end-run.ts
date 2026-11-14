// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A real month-end run for browser tests: a fresh issuer, `count` customers (a contact with a
// billing address, which the draft reads on the draft day), each with a monthly schedule and a
// paid previous invoice billing the same line, and the app's own draft job run once, which drafts
// the rows and stages the run's one approval card. The schedules and their previous invoices are
// written as rows, as the run's integration test does; everything after that is the app's code.
import { randomUUID } from "node:crypto"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "../helpers/seed"

export interface MonthEndRun {
  issuerId: string
  runId: string
  approvalId: string
  /** The month the run bills (`November`). */
  month: string
}

/** Today's date and the last day of this month, as plain `YYYY-MM-DD` days in UTC. */
function days(): { today: string; monthEnd: string } {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10)
  return { today, monthEnd }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

export async function draftMonthEndRun(
  env: WorkerEnv,
  opts: {
    orgId: string
    adminToken: string
    accountManagerId: string
    count: number
    customer?: (i: number) => string
  },
): Promise<MonthEndRun> {
  const created = await api(
    env.serverUrl,
    "/api/apps/invoicing/tools/settings_issuer_profile_create",
    {
      method: "POST",
      token: opts.adminToken,
      body: {
        params: {
          legal_name: `Maison Studio ${randomUUID().slice(0, 6)}`,
          country: "FR",
          vat_id: "FR40902000009",
          address: "1 rue de Test, 75011 Paris",
          default_currency: "EUR",
          default_language: "en",
        },
      },
    },
  )
  const body = created.body as { data?: { id?: string; data?: { id?: string } } }
  const issuerId = String(body.data?.id ?? body.data?.data?.id ?? "")
  if (!issuerId)
    throw new Error(`issuer not created: ${created.status} ${JSON.stringify(created.body)}`)
  const inv = env.schemaPrefix ? `"${env.schemaPrefix}app_invoicing"` : "app_invoicing"
  await env.db.sql.unsafe(`UPDATE ${inv}.issuer_profiles SET timezone = 'UTC' WHERE id = $1`, [
    issuerId,
  ])
  const { today, monthEnd } = days()
  const name = opts.customer ?? ((i: number) => `Maison Client ${i}`)
  // Contacts are deduped on email: each run's customers are its own.
  const tag = randomUUID().slice(0, 8)
  for (let i = 1; i <= opts.count; i++) {
    const prev = randomUUID()
    const price = 49000
    await seedFactory(env, opts.orgId, "invoicing.monthEndClient", {
      issuerId,
      previousDocumentId: prev,
      scheduleKey: prev,
      name: name(i),
      street: `${i} rue des Tests`,
      postalCode: "75011",
      city: "Paris",
      email: `client${i}-${tag}@e2e.test`,
      priceMinor: price,
      taxRateBp: 2000,
      nextIssueOn: monthEnd,
      nextDraftOn: today,
      createdBy: opts.accountManagerId,
    })
  }
  const ran = await api(env.serverUrl, "/api/_test/apps/invoicing/jobs/recurring-draft/run", {
    method: "POST",
    body: { orgId: opts.orgId },
  })
  const outcome = (ran.body as { data?: { ok?: boolean; error?: string } }).data
  if (!outcome?.ok) throw new Error(`draft job failed: ${ran.status} ${JSON.stringify(ran.body)}`)
  const [run] = (await env.db.sql.unsafe(
    `SELECT id::text AS id, approval_request_id::text AS approval FROM ${inv}.recurring_runs WHERE issuer_profile_id = $1`,
    [issuerId],
  )) as Array<{ id: string; approval: string | null }>
  if (!run?.approval) throw new Error(`no run card for issuer ${issuerId}`)
  return {
    issuerId,
    runId: run.id,
    approvalId: run.approval,
    month: MONTHS[Number(monthEnd.slice(5, 7)) - 1] ?? "",
  }
}

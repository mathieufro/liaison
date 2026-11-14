// SPDX-License-Identifier: FSL-1.1-ALv2
// The whole-org archive applies the admin's own read rule to people's time: a
// person's private time rows, a proposed reconciliation and per-person cost
// rates stay out; the rows on a dated sheet are in.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { unzipSync } from "fflate"
import { sql } from "~/db"
import { deleteObject, getObjectBuffer } from "~/infra/storage/object-storage"
import { buildOrgArchive } from "~/modules/export/org-archive/writer"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = () => crypto.randomUUID().slice(0, 8)
const createdKeys: string[] = []
const AT = "2026-09-01T09:00:00.000Z"

let orgId = ""
let personId = ""
const DATED = crypto.randomUUID()
const PLAIN = crypto.randomUUID()
const SHEET_ROW = crypto.randomUUID()
const BEFORE_ROW = crypto.randomUUID()
const PRIVATE_ROW = crypto.randomUUID()
const PROPOSED = crypto.randomUUID()
const DRAFTED = crypto.randomUUID()
const PROPOSED_LINE = crypto.randomUUID()
const DRAFTED_LINE = crypto.randomUUID()

function ndjson(files: Record<string, Uint8Array>, name: string): Record<string, unknown>[] {
  const raw = files[name]
  if (!raw) throw new Error(`no ${name} in the archive`)
  return new TextDecoder()
    .decode(raw)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `oexp-time-${tag()}`, name: "Export Time" })).orgId
  personId = (
    await ensureUser({
      orgId,
      email: `person-${tag()}@fabrikam.example`,
      name: "Person",
      password: "pw-export-3!",
      role: "member",
    })
  ).userId
  const thread = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.threads", {
      id: thread,
      org_id: orgId,
      handle: `time-export-${thread.slice(0, 8)}`,
      created_by: personId,
      created_at: AT,
      updated_at: AT,
    }),
  )
  const tasks: Record<string, string> = {}
  for (const [id, key] of [
    [DATED, "DAT"],
    [PLAIN, "PLN"],
  ] as const) {
    await sql.unsafe(
      insertSql("app_projects.projects", {
        id,
        org_id: orgId,
        name: `Board ${key}`,
        key,
        owner_id: personId,
        time_budgets_on: true,
        created_at: AT,
        updated_at: AT,
      }),
    )
    const status = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_projects.project_statuses", {
        id: status,
        org_id: orgId,
        project_id: id,
        label: "To do",
        '"order"': 1,
        terminal: false,
        created_at: AT,
        updated_at: AT,
      }),
    )
    tasks[id] = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_projects.tasks", {
        id: tasks[id]!,
        org_id: orgId,
        project_id: id,
        status_id: status,
        title: "Task",
        number: 1,
        thread_id: thread,
        created_by: personId,
        created_at: AT,
        updated_at: AT,
      }),
    )
  }
  await sql.unsafe(
    insertSql("app_projects.project_time_plan", {
      project_id: DATED,
      org_id: orgId,
      basis: "hourly",
      dated_hours: true,
      dated_hours_changed_at: "2026-10-01T08:00:00.000Z",
    }),
  )
  const time = (
    id: string,
    projectId: string,
    day: string,
    createdAt: string,
    enteredDated: boolean,
  ) => ({
    id,
    org_id: orgId,
    task_id: tasks[projectId]!,
    project_id: projectId,
    user_id: personId,
    work_date: day,
    minutes: 60,
    entered_via: "field",
    entered_dated: enteredDated,
    cost_minor: 5000,
    created_at: createdAt,
  })
  await sql.unsafe(
    insertSql("app_projects.task_time", [
      time(SHEET_ROW, DATED, "2026-10-02", "2026-10-02T09:00:00.000Z", true),
      time(BEFORE_ROW, DATED, "2026-10-01", "2026-10-01T07:00:00.000Z", true),
      time(PRIVATE_ROW, PLAIN, "2026-10-02", "2026-10-02T09:00:00.000Z", false),
    ]),
  )
  await sql.unsafe(
    insertSql("app_projects.cost_rates", {
      org_id: orgId,
      user_id: personId,
      rate_minor: 6000,
      currency: "EUR",
      effective_from: "2026-01-01",
    }),
  )
  for (const [id, state, line] of [
    [PROPOSED, "proposed", PROPOSED_LINE],
    [DRAFTED, "drafted", DRAFTED_LINE],
  ] as const) {
    await sql.unsafe(
      insertSql("app_projects.reconciliations", {
        id,
        org_id: orgId,
        project_id: DATED,
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        basis: "hourly",
        state,
        created_by: personId,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.reconciliation_lines", {
        id: line,
        org_id: orgId,
        reconciliation_id: id,
        position: 1,
        name: "Design",
        kind: "planned",
        bill_minutes: 60,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.reconciliation_proofs", {
        org_id: orgId,
        line_id: line,
        kind: "task",
        ref: crypto.randomUUID(),
        label: "Task 1",
      }),
    )
  }
}, 60_000)

afterAll(async () => {
  for (const k of createdKeys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

describe("people's time in the whole-org archive", () => {
  it("holds the dated sheet's rows only, no proposed reconciliation and no cost rate", async () => {
    const res = await buildOrgArchive({ orgId, exportId: crypto.randomUUID() })
    createdKeys.push(res.objectKey)
    const files = unzipSync(new Uint8Array(await getObjectBuffer(res.objectKey)))
    const time = ndjson(files, "data/app_projects.task_time.ndjson")
    expect(time.map((r) => r.id)).toEqual([SHEET_ROW])
    expect(time[0]?.cost_minor).toBeNull()
    expect(ndjson(files, "data/app_projects.cost_rates.ndjson")).toEqual([])
    expect(ndjson(files, "data/app_projects.reconciliations.ndjson").map((r) => r.id)).toEqual([
      DRAFTED,
    ])
    expect(ndjson(files, "data/app_projects.reconciliation_lines.ndjson").map((r) => r.id)).toEqual(
      [DRAFTED_LINE],
    )
    expect(
      ndjson(files, "data/app_projects.reconciliation_proofs.ndjson").map((r) => r.line_id),
    ).toEqual([DRAFTED_LINE])
    expect(res.manifest.withheld).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "app_projects.task_time" }),
        expect.objectContaining({ table: "app_projects.cost_rates" }),
      ]),
    )
  })
})

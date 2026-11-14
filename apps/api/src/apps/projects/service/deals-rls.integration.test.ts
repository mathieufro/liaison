// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deals and their amounts under the real liaison_rls role. A deal is read like
// its task; its amount sits alone in deal_values, behind projects:deals:read.
// A task writer without deal access gets the empty value row of a new deal
// through app_projects.ensure_deal_value, which takes no amount and refuses
// anything that is not a root task of a pipeline in the caller's org.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"
import { loadProjectDetail } from "./create-project"
import { loadTaskDetails } from "./task-detail"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()

const READER = ["projects:projects:read", "projects:tasks:read"]
const WRITER = [...READER, "projects:tasks:write"]
const DEALER = [...WRITER, "projects:deals:read", "projects:deals:write"]

function ctx(scopes: string[], orgId: string = ORG_ID, userId: string = OWNER): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

/** Fixed ids and times, so a project's answer can be compared byte for byte. */
const WORK = "0c000000-0000-4000-8000-000000000001"
const PIPELINE = "0c000000-0000-4000-8000-000000000002"
const OTHER_PIPELINE = crypto.randomUUID()
const WORK_OPEN = "0c000000-0000-4000-8000-000000000011"
const PIPE_OPEN = crypto.randomUUID()
const PIPE_WON = crypto.randomUUID()
const OTHER_OPEN = crypto.randomUUID()
const WORK_TASK = "0c000000-0000-4000-8000-000000000021"
const DEAL = crypto.randomUUID() // has an amount
const NEW_DEAL = crypto.randomUUID() // has a deals row, no value row yet
const SUBTASK = crypto.randomUUID()
const ON_WORK = crypto.randomUUID() // a deals row on a work project's task
const OTHER_DEAL = crypto.randomUUID()
const THREAD = "0c000000-0000-4000-8000-000000000031"
const AT = "2026-03-02T09:00:00.000Z"

function pgError(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = e?.cause?.code ?? e?.code ?? "unknown"
  const message = e?.cause?.message ?? e?.message ?? ""
  const named = /deal_value_refused|status_outcome_terminal/.exec(message)?.[0]
  return named ? `${code} ${named}` : code
}

async function attempt(tx: Pick<RlsClient, "transaction">, statement: string): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(drizzleSql.raw(statement))
    })
    return "allowed"
  } catch (err) {
    return pgError(err)
  }
}

const ensure = (id: string) => `SELECT app_projects.ensure_deal_value('${id}'::uuid)`

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", { id, name: "Deals", slug: `deals-${id.slice(0, 8)}` }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.users", [
      { id: OWNER, org_id: ORG_ID, email: `owner-${OWNER.slice(0, 8)}@example.com`, name: "Owner" },
      {
        id: OUTSIDER,
        org_id: OTHER_ORG_ID,
        email: `out-${OUTSIDER.slice(0, 8)}@example.com`,
        name: "Outsider",
      },
    ]),
  )
  for (const [id, org] of [
    [THREAD, ORG_ID],
    [crypto.randomUUID(), OTHER_ORG_ID],
  ] as const) {
    await sql.unsafe(
      insertSql("kernel.threads", {
        id,
        org_id: org,
        handle: `deal-thread-${id.slice(0, 8)}`,
        created_by: org === ORG_ID ? OWNER : OUTSIDER,
        created_at: AT,
        updated_at: AT,
      }),
    )
  }
  const [otherThread] = await sql<{ id: string }[]>`
    SELECT id FROM kernel.threads WHERE org_id = ${OTHER_ORG_ID} LIMIT 1`
  const project = (id: string, org: string, key: string, kind: string | null) => ({
    id,
    org_id: org,
    name: `Board ${key}`,
    key,
    owner_id: org === ORG_ID ? OWNER : OUTSIDER,
    created_at: AT,
    updated_at: AT,
    ...(kind ? { kind } : {}),
  })
  // The work project is written as the previous release writes one: no kind.
  await sql.unsafe(insertSql("app_projects.projects", project(WORK, ORG_ID, "WRK", null)))
  await sql.unsafe(
    insertSql("app_projects.projects", [
      project(PIPELINE, ORG_ID, "PIP", "pipeline"),
      project(OTHER_PIPELINE, OTHER_ORG_ID, "OTH", "pipeline"),
    ]),
  )
  const statuses: [string, string, string, string, boolean][] = [
    [WORK_OPEN, WORK, ORG_ID, "To do", false],
    [PIPE_OPEN, PIPELINE, ORG_ID, "Qualified", false],
    [PIPE_WON, PIPELINE, ORG_ID, "Won", true],
    [OTHER_OPEN, OTHER_PIPELINE, OTHER_ORG_ID, "Qualified", false],
  ]
  for (const [id, projectId, org, label, terminal] of statuses) {
    await sql.unsafe(
      insertSql("app_projects.project_statuses", {
        id,
        org_id: org,
        project_id: projectId,
        label,
        '"order"': terminal ? 2 : 1,
        terminal,
        created_at: AT,
        updated_at: AT,
      }),
    )
  }
  const task = (
    id: string,
    projectId: string,
    statusId: string,
    number: number,
    extra: Record<string, unknown> = {},
    org: string = ORG_ID,
  ) => ({
    id,
    org_id: org,
    project_id: projectId,
    status_id: statusId,
    title: `Task ${number}`,
    number,
    thread_id: org === ORG_ID ? THREAD : otherThread!.id,
    created_by: org === ORG_ID ? OWNER : OUTSIDER,
    parent_task_id: null,
    created_at: AT,
    updated_at: AT,
    ...extra,
  })
  await sql.unsafe(
    insertSql("app_projects.tasks", [
      task(WORK_TASK, WORK, WORK_OPEN, 1),
      task(ON_WORK, WORK, WORK_OPEN, 2),
      task(DEAL, PIPELINE, PIPE_OPEN, 1),
      task(NEW_DEAL, PIPELINE, PIPE_OPEN, 2),
    ]),
  )
  await sql.unsafe(
    insertSql("app_projects.tasks", [
      task(SUBTASK, PIPELINE, PIPE_OPEN, 3, { parent_task_id: DEAL }),
    ]),
  )
  await sql.unsafe(
    insertSql("app_projects.tasks", [
      task(OTHER_DEAL, OTHER_PIPELINE, OTHER_OPEN, 1, {}, OTHER_ORG_ID),
    ]),
  )
  await sql.unsafe(
    insertSql("app_projects.deals", [
      { task_id: DEAL, org_id: ORG_ID },
      { task_id: NEW_DEAL, org_id: ORG_ID },
      { task_id: SUBTASK, org_id: ORG_ID },
      { task_id: ON_WORK, org_id: ORG_ID },
      { task_id: OTHER_DEAL, org_id: OTHER_ORG_ID },
    ]),
  )
  await sql.unsafe(
    insertSql("app_projects.deal_values", {
      task_id: DEAL,
      org_id: ORG_ID,
      amount_minor: 1_250_000,
      currency: "EUR",
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM app_projects.deal_values WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM app_projects.deals WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM app_projects.tasks WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID}) AND parent_task_id IS NOT NULL`
  await sql`DELETE FROM app_projects.tasks WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM app_projects.project_statuses WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM app_projects.projects WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.threads WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

async function read(scopes: string[], query: string): Promise<string[]> {
  return withRlsContext(ctx(scopes), async (tx) =>
    extractRows<{ task_id: string }>(await tx.execute(drizzleSql.raw(query))).map((r) => r.task_id),
  )
}

describe("deals and their amounts", () => {
  it("a reader without deal access sees the deal and no amount row", async () => {
    expect(
      await read(READER, `SELECT task_id FROM app_projects.deals WHERE task_id = '${DEAL}'`),
    ).toEqual([DEAL])
    expect(
      await read(READER, `SELECT task_id FROM app_projects.deal_values WHERE task_id = '${DEAL}'`),
    ).toEqual([])
    expect(
      await read(DEALER, `SELECT task_id FROM app_projects.deal_values WHERE task_id = '${DEAL}'`),
    ).toEqual([DEAL])
  })

  it("a task writer without deal access cannot write an amount", async () => {
    const outcome = await withRlsContext(ctx(WRITER), async (tx) => ({
      insert: await attempt(
        tx,
        insertSql("app_projects.deal_values", {
          task_id: NEW_DEAL,
          org_id: ORG_ID,
          amount_minor: 100,
          currency: "EUR",
        }),
      ),
      update: extractRows<{ task_id: string }>(
        await tx.execute(
          drizzleSql`UPDATE app_projects.deal_values SET amount_minor = 1 WHERE task_id = ${DEAL}::uuid RETURNING task_id`,
        ),
      ).length,
    }))
    expect(outcome).toEqual({ insert: "42501", update: 0 })
  })

  it("another org reads none of the deals", async () => {
    const rows = await withRlsContext(ctx(DEALER, OTHER_ORG_ID, OUTSIDER), async (tx) =>
      extractRows<{ task_id: string }>(
        await tx.execute(
          drizzleSql`SELECT task_id FROM app_projects.deals WHERE org_id = ${ORG_ID}::uuid`,
        ),
      ),
    )
    expect(rows).toEqual([])
  })

  it("a won or lost outcome sits only on a terminal status", async () => {
    await expect(
      sql`UPDATE app_projects.project_statuses SET deal_outcome = 'won' WHERE id = ${PIPE_OPEN}`,
    ).rejects.toThrow("status_outcome_terminal")
    await sql`UPDATE app_projects.project_statuses SET deal_outcome = 'won' WHERE id = ${PIPE_WON}`
    await sql`UPDATE app_projects.project_statuses SET deal_outcome = NULL WHERE id = ${PIPE_WON}`
  })
})

describe("app_projects.ensure_deal_value", () => {
  it("ensure_deal_value refuses a task of another org, a subtask and a task outside a pipeline", async () => {
    const outcome = await withRlsContext(ctx(WRITER), async (tx) => ({
      otherOrg: await attempt(tx, ensure(OTHER_DEAL)),
      subtask: await attempt(tx, ensure(SUBTASK)),
      workProject: await attempt(tx, ensure(ON_WORK)),
      noDealRow: await attempt(tx, ensure(WORK_TASK)),
      unknown: await attempt(tx, ensure(crypto.randomUUID())),
    }))
    expect(outcome).toEqual({
      otherOrg: "42501 deal_value_refused",
      subtask: "42501 deal_value_refused",
      workProject: "42501 deal_value_refused",
      noDealRow: "42501 deal_value_refused",
      unknown: "42501 deal_value_refused",
    })
    const readerOnly = await withRlsContext(ctx(READER), async (tx) =>
      attempt(tx, ensure(NEW_DEAL)),
    )
    expect(readerOnly).toBe("42501 deal_value_refused")
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_projects.deal_values
       WHERE task_id IN (${OTHER_DEAL}, ${SUBTASK}, ${ON_WORK}, ${WORK_TASK})`
    expect(left?.n).toBe(0)
  })

  it("ensure_deal_value never writes an amount", async () => {
    const created = await withRlsContext(ctx(WRITER), async (tx) => {
      const first = extractRows<{ ok: boolean }>(
        await tx.execute(
          drizzleSql`SELECT app_projects.ensure_deal_value(${NEW_DEAL}::uuid) AS ok`,
        ),
      )
      const again = extractRows<{ ok: boolean }>(
        await tx.execute(drizzleSql`SELECT app_projects.ensure_deal_value(${DEAL}::uuid) AS ok`),
      )
      return { first: first[0]?.ok, again: again[0]?.ok }
    })
    // A new row for the deal without one; the deal that has an amount keeps it.
    expect(created).toEqual({ first: true, again: false })
    const rows = await sql<
      { task_id: string; amount_minor: string | null; currency: string | null }[]
    >`SELECT task_id, amount_minor, currency FROM app_projects.deal_values
       WHERE task_id IN (${NEW_DEAL}, ${DEAL}) ORDER BY amount_minor NULLS FIRST`
    expect(rows.map((r) => [r.task_id, r.amount_minor, r.currency])).toEqual([
      [NEW_DEAL, null, null],
      [DEAL, "1250000", "EUR"],
    ])
    // Its only argument is the task: there is no way to hand it an amount.
    const [fn] = await sql<{ args: string }[]>`
      SELECT pg_get_function_arguments('app_projects.ensure_deal_value(uuid)'::regprocedure) AS args`
    expect(fn?.args).toBe("_task uuid")
  })

  it("is closed to PUBLIC, runs as the definer role and pins its search path", async () => {
    const [fn] = await sql<
      { owner: string; definer: boolean; config: string[] | null; public_exec: boolean }[]
    >`
      SELECT p.proowner::regrole::text AS owner, p.prosecdef AS definer, p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
        FROM pg_proc p WHERE p.oid = 'app_projects.ensure_deal_value(uuid)'::regprocedure`
    expect(fn?.owner).toBe("liaison_definer")
    expect(fn?.definer).toBe(true)
    expect(fn?.public_exec).toBe(false)
    expect(fn?.config).toEqual(["search_path=pg_catalog, pg_temp"])
    const [rights] = await sql<{ rls: boolean; portal: boolean; amount: boolean }[]>`
      SELECT has_function_privilege('liaison_rls', 'app_projects.ensure_deal_value(uuid)', 'EXECUTE') AS rls,
             has_function_privilege('liaison_portal', 'app_projects.ensure_deal_value(uuid)', 'EXECUTE') AS portal,
             has_column_privilege('liaison_definer', 'app_projects.deal_values', 'amount_minor', 'INSERT') AS amount`
    expect(rights).toEqual({ rls: true, portal: false, amount: false })
  })
})

describe("existing projects", () => {
  it("existing projects read kind work and their board answer is byte-equal", async () => {
    const [row] = await sql<{ kind: string; company_id: string | null }[]>`
      SELECT kind, company_id FROM app_projects.projects WHERE id = ${WORK}`
    expect(row).toEqual({ kind: "work", company_id: null })
    const answer = await withRlsContext(ctx(READER), async (tx) => ({
      project: await loadProjectDetail(tx, ORG_ID, WORK),
      tasks: await loadTaskDetails(tx, ORG_ID, [WORK_TASK], { projectId: WORK }),
    }))
    // Recorded when the pipeline columns arrived, with no change to how a
    // project or a task is answered: any later change to the answer of a work
    // project fails here. Ids, names and times are fixed, save when a task entered its status
    // (the column's default, the time the fixture was written).
    const stable = JSON.parse(
      JSON.stringify(answer)
        .replaceAll(ORG_ID, "<org>")
        .replaceAll(OWNER, "<owner>")
        .replaceAll(`owner-${OWNER.slice(0, 8)}`, "<owner-email>")
        .replace(/"statusEnteredAt":"[^"]*"/g, '"statusEnteredAt":"<entered>"'),
    )
    expect(JSON.stringify(stable)).toMatchSnapshot()
  })
})

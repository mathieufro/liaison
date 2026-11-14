// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Time and budgets under the real liaison_rls role. A person's time is theirs:
// nobody else reads or writes a row, whatever they hold, except on a project
// with dated hours on, where the project's owner and an exact holder of
// projects:timesheet:read read and correct the rows entered on that sheet
// since dated hours were turned on. Totals come without a person; cost needs the exact margin
// scope. A proposed reconciliation is its creator's alone. Nothing crosses orgs.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { resolveEffectivePermissions } from "~/modules/permissions/permissions"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const ANNA = crypto.randomUUID() // has time on both projects
const BRUNO = crypto.randomUUID() // a colleague with time too
const OWNER = crypto.randomUUID() // owns both projects
const ADMIN = crypto.randomUUID() // the admin role only
const ADMIN_FINANCE = crypto.randomUUID() // the admin role and the finance role
const OUTSIDER = crypto.randomUUID() // another org

const ADMIN_ROLE = crypto.randomUUID()
const FINANCE_ROLE = crypto.randomUUID()

const MEMBER = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]
const SETTINGS_ADMIN = [...MEMBER, "projects:settings:admin", "projects:projects:write"]
const MARGIN = [...MEMBER, "projects:margin:read"]
const FINANCE = [
  ...MEMBER,
  "projects:timesheet:read",
  "projects:margin:read",
  "projects:reconcile:read",
]

const PLAIN = crypto.randomUUID() // time and budgets on, dated hours off
const DATED = crypto.randomUUID() // dated hours on since 1 October 2026
const PIPELINE = crypto.randomUUID()
const OTHER_PROJECT = crypto.randomUUID()
const PLAIN_TASK = crypto.randomUUID()
const DATED_TASK = crypto.randomUUID()
const IDLE_TASK = crypto.randomUUID() // no time on it
const OTHER_TASK = crypto.randomUUID()

const ANNA_PLAIN = crypto.randomUUID()
const BRUNO_PLAIN = crypto.randomUUID()
const ANNA_DATED_BEFORE = crypto.randomUUID() // work date before dated hours
const ANNA_DATED_AFTER = crypto.randomUUID()
const OTHER_TIME = crypto.randomUUID()

const PROPOSED = crypto.randomUUID()
const DRAFTED = crypto.randomUUID()
const AT = "2026-09-01T09:00:00.000Z"

const NEW_TABLES = [
  "time_settings",
  "person_capacity",
  "project_time_plan",
  "project_billing_terms",
  "project_timeboxes",
  "task_time",
  "cost_rates",
  "days_off",
  "reconciliations",
  "reconciliation_lines",
  "reconciliation_proofs",
  "billing_claims",
] as const

function ctx(scopes: string[], userId: string, orgId: string = ORG): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function scopesOf(userId: string): Promise<string[]> {
  const perms = await withPrivilegedDb(ORG, "time-rls-test-scopes", (tx) =>
    resolveEffectivePermissions(tx, userId, ORG),
  )
  return perms.scopes
}

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.cause?.code ?? e?.code ?? "unknown"
}

async function attempt(tx: Pick<RlsClient, "transaction">, statement: string): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(drizzleSql.raw(statement))
    })
    return "allowed"
  } catch (err) {
    return pgCode(err)
  }
}

async function ids(c: UserContext, query: string): Promise<string[]> {
  return withRlsContext(c, async (tx) =>
    extractRows<{ id: string }>(await tx.execute(drizzleSql.raw(query)))
      .map((r) => r.id)
      .sort(),
  )
}

const annaTime = `SELECT id FROM app_projects.task_time WHERE user_id = '${ANNA}'`

beforeAll(async () => {
  for (const id of [ORG, OTHER_ORG]) {
    await sql.unsafe(
      insertSql("kernel.organizations", { id, name: "Time", slug: `time-${id.slice(0, 8)}` }),
    )
  }
  const person = (id: string, org: string, name: string) => ({
    id,
    org_id: org,
    email: `${name.toLowerCase()}-${id.slice(0, 8)}@example.com`,
    name,
    status: "active",
  })
  await sql.unsafe(
    insertSql("kernel.users", [
      person(ANNA, ORG, "Anna"),
      person(BRUNO, ORG, "Bruno"),
      person(OWNER, ORG, "Owner"),
      person(ADMIN, ORG, "Admin"),
      person(ADMIN_FINANCE, ORG, "Founder"),
      person(OUTSIDER, OTHER_ORG, "Outsider"),
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.roles", [
      { id: ADMIN_ROLE, org_id: ORG, name: `admin-${ADMIN_ROLE.slice(0, 8)}` },
      { id: FINANCE_ROLE, org_id: ORG, name: `finance-${FINANCE_ROLE.slice(0, 8)}` },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.role_scope_grants", [
      { role_id: ADMIN_ROLE, scope: "*" },
      { role_id: FINANCE_ROLE, scope: "projects:timesheet:read" },
      { role_id: FINANCE_ROLE, scope: "projects:margin:read" },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.user_roles", [
      { user_id: ADMIN, role_id: ADMIN_ROLE, org_id: ORG },
      { user_id: ADMIN_FINANCE, role_id: ADMIN_ROLE, org_id: ORG },
      { user_id: ADMIN_FINANCE, role_id: FINANCE_ROLE, org_id: ORG },
    ]),
  )
  const threads: Record<string, string> = {
    [ORG]: crypto.randomUUID(),
    [OTHER_ORG]: crypto.randomUUID(),
  }
  for (const [org, id] of Object.entries(threads)) {
    await sql.unsafe(
      insertSql("kernel.threads", {
        id,
        org_id: org,
        handle: `time-thread-${id.slice(0, 8)}`,
        created_by: org === ORG ? OWNER : OUTSIDER,
        created_at: AT,
        updated_at: AT,
      }),
    )
  }
  const project = (id: string, org: string, key: string, extra: Record<string, unknown> = {}) => ({
    id,
    org_id: org,
    name: `Board ${key}`,
    key,
    owner_id: org === ORG ? OWNER : OUTSIDER,
    created_at: AT,
    updated_at: AT,
    ...extra,
  })
  // One statement per row: the rows differ in their columns.
  for (const row of [
    project(PLAIN, ORG, "PLN", { time_budgets_on: true }),
    project(DATED, ORG, "DAT", { time_budgets_on: true }),
    project(PIPELINE, ORG, "PIP", { kind: "pipeline" }),
    project(OTHER_PROJECT, OTHER_ORG, "OTH", { time_budgets_on: true }),
  ]) {
    await sql.unsafe(insertSql("app_projects.projects", row))
  }
  const status: Record<string, string> = {}
  for (const [projectId, org] of [
    [PLAIN, ORG],
    [DATED, ORG],
    [OTHER_PROJECT, OTHER_ORG],
  ] as const) {
    status[projectId] = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_projects.project_statuses", {
        id: status[projectId]!,
        org_id: org,
        project_id: projectId,
        label: "To do",
        '"order"': 1,
        terminal: false,
        created_at: AT,
        updated_at: AT,
      }),
    )
  }
  const task = (id: string, projectId: string, org: string, number: number) => ({
    id,
    org_id: org,
    project_id: projectId,
    status_id: status[projectId]!,
    title: `Task ${number}`,
    number,
    thread_id: threads[org]!,
    created_by: org === ORG ? OWNER : OUTSIDER,
    created_at: AT,
    updated_at: AT,
  })
  await sql.unsafe(
    insertSql("app_projects.tasks", [
      task(PLAIN_TASK, PLAIN, ORG, 1),
      task(IDLE_TASK, PLAIN, ORG, 2),
      task(DATED_TASK, DATED, ORG, 1),
      task(OTHER_TASK, OTHER_PROJECT, OTHER_ORG, 1),
    ]),
  )
  for (const row of [
    { project_id: PLAIN, org_id: ORG, basis: "hourly" } as Record<string, string | boolean>,
    {
      project_id: DATED,
      org_id: ORG,
      basis: "hourly",
      dated_hours: true,
      dated_hours_changed_by: OWNER,
      dated_hours_changed_at: "2026-10-01T08:00:00.000Z",
    },
    {
      project_id: OTHER_PROJECT,
      org_id: OTHER_ORG,
      basis: "hourly",
      dated_hours: true,
      dated_hours_changed_at: "2026-01-01T08:00:00.000Z",
    },
  ]) {
    await sql.unsafe(insertSql("app_projects.project_time_plan", row))
  }
  const time = (
    id: string,
    taskId: string,
    projectId: string,
    userId: string,
    day: string,
    minutes: number,
    entered: { at: string; dated: boolean },
    org: string = ORG,
  ) => ({
    id,
    org_id: org,
    task_id: taskId,
    project_id: projectId,
    user_id: userId,
    work_date: day,
    minutes,
    entered_via: "field",
    entered_dated: entered.dated,
    created_at: entered.at,
  })
  // When each row was entered, and whether its project used dated hours then.
  const plain = (at: string) => ({ at, dated: false })
  const onSheet = (at: string) => ({ at, dated: true })
  await sql.unsafe(
    insertSql("app_projects.task_time", [
      time(ANNA_PLAIN, PLAIN_TASK, PLAIN, ANNA, "2026-10-05", 60, plain("2026-10-05T17:00:00Z")),
      time(BRUNO_PLAIN, PLAIN_TASK, PLAIN, BRUNO, "2026-10-06", 90, plain("2026-10-06T17:00:00Z")),
      time(
        ANNA_DATED_BEFORE,
        DATED_TASK,
        DATED,
        ANNA,
        "2026-09-30",
        30,
        plain("2026-09-30T17:00:00Z"),
      ),
      time(
        ANNA_DATED_AFTER,
        DATED_TASK,
        DATED,
        ANNA,
        "2026-10-01",
        45,
        onSheet("2026-10-01T17:00:00Z"),
      ),
      time(
        OTHER_TIME,
        OTHER_TASK,
        OTHER_PROJECT,
        OUTSIDER,
        "2026-10-01",
        20,
        onSheet("2026-10-01T17:00:00Z"),
        OTHER_ORG,
      ),
    ]),
  )
  for (const [org, who, projectId] of [
    [ORG, ANNA, PLAIN],
    [OTHER_ORG, OUTSIDER, OTHER_PROJECT],
  ] as const) {
    await sql.unsafe(insertSql("app_projects.time_settings", { org_id: org }))
    await sql.unsafe(
      insertSql("app_projects.person_capacity", { org_id: org, user_id: who, days_per_week: 4 }),
    )
    await sql.unsafe(
      insertSql("app_projects.project_billing_terms", {
        project_id: projectId,
        org_id: org,
        rate_minor: 9000,
        currency: "EUR",
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.project_timeboxes", {
        org_id: org,
        project_id: projectId,
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        minutes: 6000,
        source: "manual",
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.cost_rates", {
        org_id: org,
        user_id: who,
        rate_minor: 6000,
        currency: "EUR",
        effective_from: "2026-01-01",
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.days_off", {
        org_id: org,
        starts_on: "2026-12-25",
        ends_on: "2026-12-25",
        recurs_yearly: true,
        label: "Christmas",
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.billing_claims", {
        org_id: org,
        project_id: projectId,
        source_kind: "task",
        source_ref: crypto.randomUUID(),
        period_key: "all",
        state: "reserved",
      }),
    )
  }
  const recon = (id: string, org: string, projectId: string, who: string, state: string) => ({
    id,
    org_id: org,
    project_id: projectId,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    basis: "hourly",
    state,
    created_by: who,
  })
  const otherRecon = crypto.randomUUID()
  await sql.unsafe(
    insertSql("app_projects.reconciliations", [
      recon(PROPOSED, ORG, PLAIN, ANNA, "proposed"),
      recon(DRAFTED, ORG, DATED, ANNA, "drafted"),
      recon(otherRecon, OTHER_ORG, OTHER_PROJECT, OUTSIDER, "drafted"),
    ]),
  )
  for (const [org, reconId] of [
    [ORG, DRAFTED],
    [OTHER_ORG, otherRecon],
  ] as const) {
    const lineId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_projects.reconciliation_lines", {
        id: lineId,
        org_id: org,
        reconciliation_id: reconId,
        position: 1,
        name: "Design",
        kind: "planned",
        bill_minutes: 60,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.reconciliation_proofs", {
        org_id: org,
        line_id: lineId,
        kind: "task",
        ref: crypto.randomUUID(),
        label: "Task 1",
      }),
    )
  }
})

afterAll(async () => {
  const orgs = [ORG, OTHER_ORG]
  for (const table of [...NEW_TABLES].reverse()) {
    await sql.unsafe(`DELETE FROM app_projects.${table} WHERE org_id IN ('${ORG}', '${OTHER_ORG}')`)
  }
  await sql`DELETE FROM app_projects.tasks WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM app_projects.project_statuses WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM app_projects.projects WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM kernel.threads WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ADMIN_ROLE}, ${FINANCE_ROLE})`
  await sql`DELETE FROM kernel.roles WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM kernel.users WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM kernel.organizations WHERE id IN ${sql(orgs)}`
})

describe("a person's time", () => {
  it("a person cannot write another person's time, even with settings admin", async () => {
    const someoneElse = (c: UserContext) =>
      withRlsContext(c, async (tx) => ({
        insert: await attempt(
          tx,
          insertSql("app_projects.task_time", {
            org_id: ORG,
            task_id: IDLE_TASK,
            project_id: PLAIN,
            user_id: ANNA,
            work_date: "2026-10-07",
            minutes: 30,
            entered_via: "field",
          }),
        ),
        update: extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`UPDATE app_projects.task_time SET minutes = 1 WHERE id = ${ANNA_PLAIN}::uuid RETURNING id`,
          ),
        ).length,
        remove: extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`DELETE FROM app_projects.task_time WHERE id = ${ANNA_PLAIN}::uuid RETURNING id`,
          ),
        ).length,
      }))
    expect(await someoneElse(ctx(SETTINGS_ADMIN, BRUNO))).toEqual({
      insert: "42501",
      update: 0,
      remove: 0,
    })
    expect(await someoneElse(ctx(await scopesOf(ADMIN), ADMIN))).toEqual({
      insert: "42501",
      update: 0,
      remove: 0,
    })
    // The person writes their own row.
    const own = await withRlsContext(
      ctx(MEMBER, ANNA),
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`UPDATE app_projects.task_time SET minutes = 60 WHERE id = ${ANNA_PLAIN}::uuid RETURNING id`,
          ),
        ).length,
    )
    expect(own).toBe(1)
    const [row] = await sql<{ minutes: number }[]>`
      SELECT minutes FROM app_projects.task_time WHERE id = ${ANNA_PLAIN}`
    expect(row?.minutes).toBe(60)
  })

  it("a colleague, an admin holding everything, a margin reader and the project owner read no one else's time on a project without dated hours", async () => {
    const onPlain = `${annaTime} AND project_id = '${PLAIN}'`
    expect(await ids(ctx(MEMBER, BRUNO), onPlain)).toEqual([])
    expect(await ids(ctx(await scopesOf(ADMIN), ADMIN), onPlain)).toEqual([])
    expect(await ids(ctx(await scopesOf(ADMIN_FINANCE), ADMIN_FINANCE), onPlain)).toEqual([])
    expect(await ids(ctx(MARGIN, BRUNO), onPlain)).toEqual([])
    expect(await ids(ctx(MEMBER, OWNER), onPlain)).toEqual([])
    expect(await ids(ctx(MEMBER, ANNA), onPlain)).toEqual([ANNA_PLAIN])
  })

  it("task totals carry no person column", async () => {
    const [fn] = await sql<{ result: string }[]>`
      SELECT pg_get_function_result('app_projects.task_time_totals(uuid, date, date)'::regprocedure) AS result`
    expect(fn?.result).toBe("TABLE(task_id uuid, minutes bigint, has_entries boolean)")
    const totals = await withRlsContext(ctx(MEMBER, BRUNO), async (tx) =>
      extractRows<{ task_id: string; minutes: string; has_entries: boolean }>(
        await tx.execute(
          drizzleSql`SELECT * FROM app_projects.task_time_totals(${PLAIN}::uuid, NULL, NULL) ORDER BY minutes DESC`,
        ),
      ),
    )
    expect(totals.map((t) => Object.keys(t).sort())).toEqual([
      ["has_entries", "minutes", "task_id"],
      ["has_entries", "minutes", "task_id"],
    ])
    expect(totals.map((t) => [t.task_id, Number(t.minutes), t.has_entries])).toEqual([
      [PLAIN_TASK, 150, true],
      [IDLE_TASK, 0, false],
    ])
    const ranged = await withRlsContext(ctx(MEMBER, BRUNO), async (tx) =>
      extractRows<{ minutes: string }>(
        await tx.execute(
          drizzleSql`SELECT minutes FROM app_projects.task_time_totals(${PLAIN}::uuid, '2026-10-06', '2026-10-31') WHERE task_id = ${PLAIN_TASK}::uuid`,
        ),
      ),
    )
    expect(ranged.map((r) => Number(r.minutes))).toEqual([90])
    // Another org's project has no totals here, and no projects read means no call.
    const elsewhere = await withRlsContext(ctx(MEMBER, BRUNO), async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`SELECT * FROM app_projects.task_time_totals(${OTHER_PROJECT}::uuid, NULL, NULL)`,
        ),
      ),
    )
    expect(elsewhere).toEqual([])
    const refused = await withRlsContext(ctx(["tickets:tickets:read"], BRUNO), async (tx) =>
      attempt(tx, `SELECT * FROM app_projects.task_time_totals('${PLAIN}'::uuid, NULL, NULL)`),
    )
    expect(refused).toBe("42501")
  })

  it("exact scope does not expand a wildcard", async () => {
    const exact = (scopes: string[]) =>
      withRlsContext(ctx(scopes, BRUNO), async (tx) =>
        extractRows<{ ok: boolean }>(
          await tx.execute(
            drizzleSql`SELECT app_projects.app_has_exact_scope('projects:timesheet:read') AS ok`,
          ),
        ).map((r) => r.ok),
      )
    expect(await exact(["*"])).toEqual([false])
    expect(await exact(["projects:*"])).toEqual([false])
    expect(await exact(["projects"])).toEqual([false])
    expect(await exact(["projects:timesheet"])).toEqual([false])
    expect(await exact(["projects:timesheet:*"])).toEqual([false])
    expect(await exact(["*", "projects:timesheet:read"])).toEqual([true])
  })
})

describe("dated hours", () => {
  const onDated = `${annaTime} AND project_id = '${DATED}'`

  it("an admin who also holds the finance role reads the dated sheet", async () => {
    const scopes = await scopesOf(ADMIN_FINANCE)
    expect(scopes).toContain("*")
    expect(scopes).toContain("projects:timesheet:read")
    expect(await ids(ctx(scopes, ADMIN_FINANCE), onDated)).toEqual([ANNA_DATED_AFTER])
  })

  it("an admin without it does not", async () => {
    expect(await ids(ctx(await scopesOf(ADMIN), ADMIN), onDated)).toEqual([])
    expect(await ids(ctx(MARGIN, BRUNO), onDated)).toEqual([])
  })

  it("the owner and finance read and correct rows entered after dated hours were turned on, never earlier ones", async () => {
    for (const c of [ctx(MEMBER, OWNER), ctx(FINANCE, BRUNO)]) {
      expect(await ids(c, onDated)).toEqual([ANNA_DATED_AFTER])
      const corrected = await withRlsContext(c, async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`UPDATE app_projects.task_time SET minutes = 45, changed_by = ${c.userId}::uuid
                        WHERE project_id = ${DATED}::uuid AND user_id = ${ANNA}::uuid RETURNING id`,
          ),
        ).map((r) => r.id),
      )
      expect(corrected).toEqual([ANNA_DATED_AFTER])
    }
    // Turning dated hours off and on again moves the moment forward: the row
    // that was readable stays hidden, whatever its work date.
    await sql`UPDATE app_projects.project_time_plan SET dated_hours = false WHERE project_id = ${DATED}`
    expect(await ids(ctx(MEMBER, OWNER), onDated)).toEqual([])
    await sql`UPDATE app_projects.project_time_plan
                 SET dated_hours = true, dated_hours_changed_at = '2026-10-02T08:00:00Z'
               WHERE project_id = ${DATED}`
    expect(await ids(ctx(MEMBER, OWNER), onDated)).toEqual([])
    await sql`UPDATE app_projects.project_time_plan
                 SET dated_hours_changed_at = '2026-10-01T08:00:00Z'
               WHERE project_id = ${DATED}`
  })

  it("dated hours open nothing while the project has time and budgets off", async () => {
    await sql`UPDATE app_projects.projects SET time_budgets_on = false WHERE id = ${DATED}`
    try {
      expect(await ids(ctx(MEMBER, OWNER), onDated)).toEqual([])
    } finally {
      await sql`UPDATE app_projects.projects SET time_budgets_on = true WHERE id = ${DATED}`
    }
  })
})

describe("cost", () => {
  it("project cost applies the rate in force on the work date and needs the exact margin scope", async () => {
    const cost = (c: UserContext, projectId: string) =>
      withRlsContext(c, async (tx) =>
        extractRows<{ cost: string }>(
          await tx.execute(
            drizzleSql`SELECT app_projects.project_time_cost(${projectId}::uuid, NULL, NULL) AS cost`,
          ),
        ).map((r) => Number(r.cost)),
      )
    // Anna 60 min at 6000 an hour; Bruno has no rate and counts 0.
    expect(await cost(ctx(FINANCE, BRUNO), PLAIN)).toEqual([6000])
    expect(await cost(ctx(FINANCE, BRUNO), OTHER_PROJECT)).toEqual([0])
    const refused = await withRlsContext(ctx(await scopesOf(ADMIN), ADMIN), async (tx) =>
      attempt(tx, `SELECT app_projects.project_time_cost('${PLAIN}'::uuid, NULL, NULL)`),
    )
    expect(refused).toBe("42501")
    expect(
      await ids(ctx(await scopesOf(ADMIN), ADMIN), "SELECT id FROM app_projects.cost_rates"),
    ).toEqual([])
  })

  it("the totals and cost functions are closed to PUBLIC, run as the definer role and pin an empty search path", async () => {
    const rows = await sql<
      {
        name: string
        owner: string
        definer: boolean
        config: string[] | null
        public_exec: boolean
      }[]
    >`
      SELECT p.proname AS name, p.proowner::regrole::text AS owner, p.prosecdef AS definer,
             p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app_projects' AND p.proname IN ('task_time_totals', 'project_time_cost')
       ORDER BY p.proname`
    expect([...rows]).toEqual([
      {
        name: "project_time_cost",
        owner: "liaison_definer",
        definer: true,
        config: ['search_path=""'],
        public_exec: false,
      },
      {
        name: "task_time_totals",
        owner: "liaison_definer",
        definer: true,
        config: ['search_path=""'],
        public_exec: false,
      },
    ])
  })
})

describe("reconciliations", () => {
  it("a proposed reconciliation is visible to its creator only", async () => {
    const query = `SELECT id FROM app_projects.reconciliations WHERE org_id = '${ORG}'`
    expect(await ids(ctx(await scopesOf(ADMIN), ADMIN), query)).toEqual([DRAFTED])
    expect(await ids(ctx(FINANCE, BRUNO), query)).toEqual([DRAFTED])
    expect(await ids(ctx(MEMBER, ANNA), query)).toEqual([DRAFTED, PROPOSED].sort())
    // The creator alone edits it while proposed.
    const edited = await withRlsContext(
      ctx(await scopesOf(ADMIN), ADMIN),
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`UPDATE app_projects.reconciliations SET revision = 2 WHERE id = ${PROPOSED}::uuid RETURNING id`,
          ),
        ).length,
    )
    expect(edited).toBe(0)
  })

  it("a second live claim on the same source and period fails", async () => {
    const ref = crypto.randomUUID()
    const claim = (state: string) =>
      insertSql("app_projects.billing_claims", {
        org_id: ORG,
        project_id: PLAIN,
        source_kind: "task",
        source_ref: ref,
        period_key: "2026-10",
        state,
      })
    await sql.unsafe(claim("reserved"))
    await expect(sql.unsafe(claim("billed"))).rejects.toThrow("billing_claims_live_uidx")
    await sql.unsafe(claim("released"))
  })
})

describe("the read-only role and other orgs", () => {
  it("the read-only role cannot read time, cost rates or days off", async () => {
    const [role] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'liaison_readonly'`
    // The role exists where the database connector was set up (a fresh CI database has none,
    // and then nothing can read through it); where it exists it holds no right on these tables.
    for (const table of role?.n === 1 ? NEW_TABLES : []) {
      const [rights] = await sql<{ whole: boolean; anyColumn: boolean }[]>`
        SELECT has_table_privilege('liaison_readonly', ${`app_projects.${table}`}, 'SELECT') AS whole,
               has_any_column_privilege('liaison_readonly', ${`app_projects.${table}`}, 'SELECT') AS "anyColumn"`
      expect({ table, ...rights }).toEqual({ table, whole: false, anyColumn: false })
    }
    const grants = readFileSync(
      resolve(
        import.meta.dir,
        "../../../modules/apps/connections/sql/generated/readonly-grants.sql",
      ),
      "utf8",
    )
    expect(grants).toContain("TO liaison_readonly;")
    for (const table of NEW_TABLES) expect(grants).not.toContain(`app_projects.${table}`)
  })

  it("two orgs see none of each other's rows in every new table", async () => {
    const everything = [
      "*",
      "projects:timesheet:read",
      "projects:margin:read",
      "projects:cost_rates:write",
    ]
    for (const table of NEW_TABLES) {
      const [mine] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql("app_projects")}.${sql(table)} WHERE org_id = ${ORG}`
      expect({ table, seeded: (mine?.n ?? 0) > 0 }).toEqual({ table, seeded: true })
      const theirs = await withRlsContext(ctx(everything, OUTSIDER, OTHER_ORG), async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql.raw(
              `SELECT count(*)::int AS n FROM app_projects.${table} WHERE org_id = '${ORG}'`,
            ),
          ),
        ),
      )
      expect({ table, rows: theirs[0]?.n }).toEqual({ table, rows: 0 })
    }
    // Their own org's rows stay readable to them: the filter is the org, not the table.
    const own = await withRlsContext(ctx(everything, OUTSIDER, OTHER_ORG), async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM app_projects.task_time WHERE org_id = ${OTHER_ORG}::uuid`,
        ),
      ),
    )
    expect(own[0]?.n).toBe(1)
  })
})

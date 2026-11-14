// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two kernel tables a member reads and never writes: who is away, and which of
// an app's features an org has on. Under the real liaison_rls role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const BEN = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()

function ctx(userId: string, orgId: string = ORG_ID): UserContext {
  return { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
}

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
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

async function awayStatuses(reader: UserContext): Promise<string[]> {
  return withRlsContext(reader, async (tx) =>
    extractRows<{ status: string }>(
      await tx.execute(drizzleSql`SELECT status FROM kernel.away_ranges ORDER BY status`),
    ).map((r) => r.status),
  )
}

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id,
        name: "Away and features",
        slug: `away-${id.slice(0, 8)}`,
      }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.users", [
      { id: ANNA, org_id: ORG_ID, email: `anna-${ANNA.slice(0, 8)}@example.com`, name: "Anna" },
      { id: BEN, org_id: ORG_ID, email: `ben-${BEN.slice(0, 8)}@example.com`, name: "Ben" },
      {
        id: OUTSIDER,
        org_id: OTHER_ORG_ID,
        email: `out-${OUTSIDER.slice(0, 8)}@example.com`,
        name: "Outsider",
      },
    ]),
  )
  const away = { org_id: ORG_ID, user_id: ANNA }
  await sql.unsafe(
    insertSql("kernel.away_ranges", [
      {
        ...away,
        starts_on: "2026-12-01",
        ends_on: "2026-12-05",
        source: "said",
        status: "active",
        source_event_ref: null,
      },
      {
        ...away,
        starts_on: "2026-12-10",
        ends_on: "2026-12-11",
        source: "calendar",
        status: "asked",
        source_event_ref: "cal:1",
      },
      {
        ...away,
        starts_on: "2026-12-20",
        ends_on: "2026-12-21",
        source: "calendar",
        status: "declined",
        source_event_ref: "cal:2",
      },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.org_app_features", {
      org_id: ORG_ID,
      app_name: "projects",
      feature: "time_budgets",
      enabled: true,
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.away_ranges WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.org_app_features WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe("kernel.away_ranges", () => {
  it("column list of away_ranges holds no title or reason", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'away_ranges'
       ORDER BY column_name`
    // A closed list: an added free-text column would carry what must stay private.
    expect(rows.map((r) => r.column_name)).toEqual(
      [
        "created_at",
        "ended_early_on",
        "ends_on",
        "id",
        "next_in_line_id",
        "org_id",
        "set_by",
        "source",
        "source_event_ref",
        "starts_on",
        "status",
        "updated_at",
        "user_id",
        "weekdays",
      ].sort(),
    )
  })

  it("asked and declined rows read 0 by a second member under liaison_rls", async () => {
    expect(await awayStatuses(ctx(BEN))).toEqual(["active"])
  })

  it("the person reads their own asked and declined rows", async () => {
    expect(await awayStatuses(ctx(ANNA))).toEqual(["active", "asked", "declined"])
  })

  it("a member of another org reads none of them", async () => {
    expect(await awayStatuses(ctx(OUTSIDER, OTHER_ORG_ID))).toEqual([])
  })

  it("a member has no write path, not on their own row either", async () => {
    const outcome = await withRlsContext(ctx(ANNA), async (tx) => ({
      insert: await attempt(
        tx,
        insertSql("kernel.away_ranges", {
          org_id: ORG_ID,
          user_id: ANNA,
          starts_on: "2027-01-01",
          ends_on: "2027-01-02",
          source: "said",
        }),
      ),
      update: await attempt(
        tx,
        `UPDATE kernel.away_ranges SET ends_on = '2028-01-01' WHERE user_id = '${ANNA}'`,
      ),
      remove: await attempt(tx, `DELETE FROM kernel.away_ranges WHERE user_id = '${ANNA}'`),
    }))
    expect(outcome).toEqual({ insert: "42501", update: "42501", remove: "42501" })
  })

  it("a range with neither an end nor weekdays violates the check", async () => {
    await expect(
      sql.unsafe(
        insertSql("kernel.away_ranges", {
          org_id: ORG_ID,
          user_id: ANNA,
          starts_on: "2027-02-01",
          source: "said",
        }),
      ),
    ).rejects.toThrow("check")
  })

  it("a calendar range needs its event reference, and only a calendar range may be asked", async () => {
    await expect(
      sql.unsafe(
        insertSql("kernel.away_ranges", {
          org_id: ORG_ID,
          user_id: ANNA,
          starts_on: "2027-02-01",
          ends_on: "2027-02-02",
          source: "calendar",
        }),
      ),
    ).rejects.toThrow("check")
    await expect(
      sql.unsafe(
        insertSql("kernel.away_ranges", {
          org_id: ORG_ID,
          user_id: ANNA,
          starts_on: "2027-02-01",
          ends_on: "2027-02-02",
          source: "said",
          status: "asked",
        }),
      ),
    ).rejects.toThrow("check")
  })
})

describe("kernel.org_app_features", () => {
  const read = (reader: UserContext) =>
    withRlsContext(reader, async (tx) =>
      extractRows<{ feature: string; enabled: boolean }>(
        await tx.execute(drizzleSql`SELECT feature, enabled FROM kernel.org_app_features`),
      ),
    )

  it("a member reads own org's org_app_features, INSERT refused", async () => {
    expect(await read(ctx(BEN))).toEqual([{ feature: "time_budgets", enabled: true }])
    const refused = await withRlsContext(ctx(BEN), (tx) =>
      attempt(
        tx,
        insertSql("kernel.org_app_features", {
          org_id: ORG_ID,
          app_name: "projects",
          feature: "another",
          enabled: true,
        }),
      ),
    )
    expect(refused).toBe("42501")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.org_app_features
       WHERE org_id = ${ORG_ID} AND feature = 'another'`
    expect(row?.n).toBe(0)
  })

  it("a member cannot update or delete a feature row", async () => {
    const outcome = await withRlsContext(ctx(BEN), async (tx) => ({
      update: await attempt(tx, "UPDATE kernel.org_app_features SET enabled = false"),
      remove: await attempt(tx, "DELETE FROM kernel.org_app_features"),
    }))
    expect(outcome).toEqual({ update: "42501", remove: "42501" })
  })

  it("a member of another org reads none of it", async () => {
    expect(await read(ctx(OUTSIDER, OTHER_ORG_ID))).toEqual([])
  })

  it("deleting a user who changed a feature leaves changed_by null", async () => {
    const changer = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.users", {
        id: changer,
        org_id: ORG_ID,
        email: `changer-${changer.slice(0, 8)}@example.com`,
        name: "Changer",
      }),
    )
    await sql.unsafe(
      insertSql("kernel.org_app_features", {
        org_id: ORG_ID,
        app_name: "projects",
        feature: "changed",
        enabled: true,
        changed_by: changer,
        changed_at: { raw: "now()" },
      }),
    )
    await sql`DELETE FROM kernel.users WHERE id = ${changer}`
    const [row] = await sql<{ changed_by: string | null; enabled: boolean }[]>`
      SELECT changed_by, enabled FROM kernel.org_app_features
       WHERE org_id = ${ORG_ID} AND feature = 'changed'`
    expect(row).toEqual({ changed_by: null, enabled: true })
  })
})

describe("kernel.approval_requests route_person_id", () => {
  it("the user-delete lookup on route_person_id uses the partial index, not a scan", async () => {
    const plan = await sql.begin(async (tx) => {
      // On a small table the planner prefers a scan for its own reasons; with
      // scans priced out it picks the index only if one can serve the lookup.
      await tx`SELECT set_config('enable_seqscan', 'off', true)`
      const rows = await tx.unsafe(
        `EXPLAIN SELECT 1 FROM kernel.approval_requests WHERE route_person_id = '${ANNA}'`,
      )
      return rows.map((r) => String(r["QUERY PLAN"])).join("\n")
    })
    expect(plan).toContain("approval_requests_route_person_idx")
    expect(plan).not.toContain("Seq Scan")
  })
})

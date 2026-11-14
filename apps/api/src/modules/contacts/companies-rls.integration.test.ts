// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.companies under the real liaison_rls role: who reads a company, who
// may change its sharing, and that its account manager is a label that grants
// nothing. The sharing trigger mirrors contacts' (0117 contacts_sharing_guard):
// the UPDATE policy checks only the org, so the trigger is what keeps an
// org-wide editor from taking a company over.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID() // creates companies
const BEN = crypto.randomUUID() // an org member, editor through org access
const CARL = crypto.randomUUID() // named account manager, holds no grant
const DORA = crypto.randomUUID() // granted viewer on one company
const ELI = crypto.randomUUID() // contacts admin
const GONE = crypto.randomUUID() // a creator who left
const OUTSIDER = crypto.randomUUID()

const OPEN = crypto.randomUUID() // org-wide editor, created by Anna
const PRIVATE = crypto.randomUUID() // shared with nobody, created by Anna, managed by Carl
const ORPHAN = crypto.randomUUID() // shared with nobody, its creator deactivated

function ctx(userId: string, scopes: string[] = [], orgId: string = ORG_ID): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

function pgError(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = e?.cause?.code ?? e?.code ?? "unknown"
  const message = e?.cause?.message ?? e?.message ?? ""
  const named = /company_[a-z_]+/.exec(message)?.[0]
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

async function visibleIds(reader: UserContext): Promise<string[]> {
  return withRlsContext(reader, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.companies WHERE org_id IN (${ORG_ID}::uuid, ${OTHER_ORG_ID}::uuid)`,
      ),
    )
      .map((r) => r.id)
      .sort(),
  )
}

const company = (id: string, extra: Record<string, unknown>) => ({
  id,
  org_id: ORG_ID,
  handle: `co-${id.slice(0, 8)}`,
  name: `Company ${id.slice(0, 4)}`,
  ...extra,
})

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", { id, name: "Companies", slug: `co-${id.slice(0, 8)}` }),
    )
  }
  const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    org_id: ORG_ID,
    email: `${name.toLowerCase()}-${id.slice(0, 8)}@example.com`,
    name,
    status: "active",
    ...extra,
  })
  await sql.unsafe(
    insertSql("kernel.users", [
      person(ANNA, "Anna"),
      person(BEN, "Ben"),
      person(CARL, "Carl"),
      person(DORA, "Dora"),
      person(ELI, "Eli"),
      person(GONE, "Gone", { status: "deactivated" }),
      { ...person(OUTSIDER, "Outsider"), org_id: OTHER_ORG_ID },
    ]),
  )
  // Written by the privileged login, which the trigger leaves alone. Every row
  // names the same columns: a multi-row insert takes them from the first.
  await sql.unsafe(
    insertSql("kernel.companies", [
      company(OPEN, { created_by: ANNA, owner_user_id: null, org_access: "editor" }),
      company(PRIVATE, { created_by: ANNA, owner_user_id: CARL, org_access: "none" }),
      company(ORPHAN, { created_by: GONE, owner_user_id: null, org_access: "none" }),
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.resource_grants", {
      org_id: ORG_ID,
      resource_type: "kernel.company",
      resource_id: PRIVATE,
      grantee_kind: "user",
      grantee: DORA,
      role: "viewer",
      created_by: ANNA,
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.resource_grants WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.companies WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe("companies sharing trigger", () => {
  it("an editor cannot take over or hide a company by changing its creator or its sharing", async () => {
    const outcome = await withRlsContext(ctx(BEN), async (tx) => ({
      creator: await attempt(
        tx,
        `UPDATE kernel.companies SET created_by = '${BEN}' WHERE id = '${OPEN}'`,
      ),
      hide: await attempt(
        tx,
        `UPDATE kernel.companies SET org_access = 'none' WHERE id = '${OPEN}'`,
      ),
      rename: await attempt(
        tx,
        `UPDATE kernel.companies SET name = 'Renamed' WHERE id = '${OPEN}'`,
      ),
    }))
    expect(outcome).toEqual({
      creator: "42501 company_creator_immutable",
      hide: "42501 company_sharing_forbidden",
      rename: "allowed",
    })
    const [row] = await sql<{ created_by: string; org_access: string }[]>`
      SELECT created_by, org_access FROM kernel.companies WHERE id = ${OPEN}`
    expect(row).toEqual({ created_by: ANNA, org_access: "editor" })
  })

  it("the creator changes the sharing of their own company", async () => {
    const outcome = await withRlsContext(ctx(ANNA), async (tx) => ({
      viewer: await attempt(
        tx,
        `UPDATE kernel.companies SET org_access = 'viewer' WHERE id = '${OPEN}'`,
      ),
      back: await attempt(
        tx,
        `UPDATE kernel.companies SET org_access = 'editor' WHERE id = '${OPEN}'`,
      ),
    }))
    expect(outcome).toEqual({ viewer: "allowed", back: "allowed" })
  })

  it("ACL columns written by a person are refused", async () => {
    const id = crypto.randomUUID()
    const outcome = await withRlsContext(ctx(BEN), async (tx) => ({
      update: await attempt(
        tx,
        `UPDATE kernel.companies SET acl_user_ids = '["${BEN}"]'::jsonb WHERE id = '${OPEN}'`,
      ),
      roles: await attempt(
        tx,
        `UPDATE kernel.companies SET acl_role_ids = '["dim:*"]'::jsonb WHERE id = '${OPEN}'`,
      ),
      insert: await attempt(
        tx,
        insertSql("kernel.companies", {
          ...company(id, { org_access: "editor" }),
          acl_user_ids: JSON.stringify([BEN]),
          acl_role_ids: JSON.stringify(["dim:*"]),
        }),
      ),
    }))
    expect(outcome).toEqual({
      update: "42501 company_acl_derived",
      roles: "42501 company_acl_derived",
      insert: "allowed",
    })
    const [row] = await sql<{ acl_user_ids: unknown; acl_role_ids: unknown }[]>`
      SELECT acl_user_ids, acl_role_ids FROM kernel.companies WHERE id = ${id}`
    expect(row).toEqual({ acl_user_ids: [], acl_role_ids: [] })
  })

  it("a member cannot create a company in someone else's name", async () => {
    const id = crypto.randomUUID()
    const outcome = await withRlsContext(ctx(BEN), async (tx) =>
      attempt(
        tx,
        insertSql("kernel.companies", company(id, { created_by: ANNA, org_access: "none" })),
      ),
    )
    expect(outcome).toBe("allowed")
    const [row] = await sql<{ created_by: string }[]>`
      SELECT created_by FROM kernel.companies WHERE id = ${id}`
    // Filed as the person who wrote it: Anna never sees it, Ben does.
    expect(row?.created_by).toBe(BEN)
    expect(await visibleIds(ctx(ANNA))).not.toContain(id)
    expect(await visibleIds(ctx(BEN))).toContain(id)
  })

  it("deleting a company removes its grants", async () => {
    const id = crypto.randomUUID()
    await sql.unsafe(insertSql("kernel.companies", company(id, { created_by: ANNA })))
    await sql.unsafe(
      insertSql("kernel.resource_grants", {
        org_id: ORG_ID,
        resource_type: "kernel.company",
        resource_id: id,
        grantee_kind: "user",
        grantee: DORA,
        role: "editor",
        created_by: ANNA,
      }),
    )
    const outcome = await withRlsContext(ctx(ANNA), async (tx) =>
      attempt(tx, `DELETE FROM kernel.companies WHERE id = '${id}'`),
    )
    expect(outcome).toBe("allowed")
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.resource_grants
       WHERE resource_type = 'kernel.company' AND resource_id = ${id}`
    expect(left?.n).toBe(0)
  })
})

describe("who reads a company", () => {
  it("a company shared with nobody is invisible to a member with no grant, visible to its creator and a grantee", async () => {
    expect(await visibleIds(ctx(BEN))).not.toContain(PRIVATE)
    expect(await visibleIds(ctx(ANNA))).toContain(PRIVATE)
    expect(await visibleIds(ctx(DORA))).toContain(PRIVATE)
    // The grantee is a viewer: they read it, they cannot edit it.
    const edit = await withRlsContext(ctx(DORA), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`UPDATE kernel.companies SET name = 'Dora was here' WHERE id = ${PRIVATE}::uuid RETURNING id`,
        ),
      ),
    )
    expect(edit).toEqual([])
  })

  it("another org reads no company", async () => {
    expect(await visibleIds(ctx(OUTSIDER, [], OTHER_ORG_ID))).toEqual([])
  })
})

describe("the account manager routes and never grants", () => {
  it("the account manager of a company shared with nobody reads no row", async () => {
    const [label] = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM kernel.companies WHERE id = ${PRIVATE}`
    expect(label?.owner_user_id).toBe(CARL)
    expect(await visibleIds(ctx(CARL))).not.toContain(PRIVATE)
    const write = await withRlsContext(ctx(CARL), async (tx) => ({
      update: extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`UPDATE kernel.companies SET name = 'Carl' WHERE id = ${PRIVATE}::uuid RETURNING id`,
        ),
      ),
      remove: extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`DELETE FROM kernel.companies WHERE id = ${PRIVATE}::uuid RETURNING id`,
        ),
      ),
    }))
    expect(write).toEqual({ update: [], remove: [] })
  })

  it("naming a manager at creation needs no grant of theirs", async () => {
    const id = crypto.randomUUID()
    const outcome = await withRlsContext(ctx(ANNA), async (tx) =>
      attempt(
        tx,
        insertSql("kernel.companies", company(id, { owner_user_id: CARL, org_access: "none" })),
      ),
    )
    expect(outcome).toBe("allowed")
    expect(await visibleIds(ctx(CARL))).not.toContain(id)
    expect(await visibleIds(ctx(ANNA))).toContain(id)
  })

  it("no policy or function on companies reads owner_user_id", async () => {
    const policies = await sql<{ text: string }[]>`
      SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text
        FROM pg_policies WHERE schemaname = 'kernel' AND tablename = 'companies'`
    expect(policies.length).toBe(4)
    const functions = await sql<{ text: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'kernel'
         AND (p.proname LIKE '%compan%'
              OR p.oid IN (SELECT t.tgfoid FROM pg_trigger t
                            WHERE t.tgrelid = 'kernel.companies'::regclass AND NOT t.tgisinternal))`
    expect(functions.length).toBeGreaterThanOrEqual(2)
    for (const row of [...policies, ...functions]) {
      expect(row.text).not.toContain("owner_user_id")
    }
  })
})

describe("kernel.can_manage_company_sharing", () => {
  async function canManage(reader: UserContext, id: string): Promise<boolean> {
    return withRlsContext(reader, async (tx) => {
      const [row] = extractRows<{ ok: boolean }>(
        await tx.execute(
          drizzleSql`SELECT kernel.can_manage_sharing('kernel.company', ${id}::uuid) AS ok`,
        ),
      )
      return row?.ok === true
    })
  }

  it("is the creator's, and a contacts admin's only once the creator is gone", async () => {
    expect(await canManage(ctx(ANNA), PRIVATE)).toBe(true)
    expect(await canManage(ctx(BEN), OPEN)).toBe(false)
    expect(await canManage(ctx(CARL), PRIVATE)).toBe(false)
    expect(await canManage(ctx(DORA), PRIVATE)).toBe(false)
    expect(await canManage(ctx(ELI, ["kernel:contacts:admin"]), PRIVATE)).toBe(false)
    expect(await canManage(ctx(ELI, ["kernel:contacts:admin"]), ORPHAN)).toBe(true)
    expect(await canManage(ctx(ELI), ORPHAN)).toBe(false)
    expect(await canManage(ctx(OUTSIDER, ["kernel:contacts:admin"], OTHER_ORG_ID), ORPHAN)).toBe(
      false,
    )
  })

  it("is closed to PUBLIC, runs as the definer role and pins its search path", async () => {
    const [fn] = await sql<
      { owner: string; definer: boolean; config: string[] | null; public_exec: boolean }[]
    >`
      SELECT p.proowner::regrole::text AS owner, p.prosecdef AS definer, p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
        FROM pg_proc p WHERE p.oid = 'kernel.can_manage_company_sharing(uuid)'::regprocedure`
    expect(fn?.owner).toBe("liaison_definer")
    expect(fn?.definer).toBe(true)
    expect(fn?.public_exec).toBe(false)
    expect(fn?.config).toEqual(["search_path=pg_catalog, pg_temp"])
    const [rights] = await sql<{ rls: boolean; app: boolean; portal: boolean }[]>`
      SELECT has_function_privilege('liaison_rls', 'kernel.can_manage_company_sharing(uuid)', 'EXECUTE') AS rls,
             has_function_privilege('liaison_app', 'kernel.can_manage_company_sharing(uuid)', 'EXECUTE') AS app,
             has_function_privilege('liaison_portal', 'kernel.can_manage_company_sharing(uuid)', 'EXECUTE') AS portal`
    expect(rights).toEqual({ rls: true, app: true, portal: false })
  })

  it("the search projection of a company names its creator and its grantees", async () => {
    await withRlsContext(ctx(ANNA), async (tx) => {
      await tx.execute(
        drizzleSql`SELECT kernel.recompute_search_acl('kernel.company', ${PRIVATE}::uuid)`,
      )
    })
    const [row] = await sql<{ acl_user_ids: string[] }[]>`
      SELECT acl_user_ids FROM kernel.companies WHERE id = ${PRIVATE}`
    expect([...(row?.acl_user_ids ?? [])].sort()).toEqual([ANNA, DORA].sort())
    expect(row?.acl_user_ids).not.toContain(CARL)
  })
})

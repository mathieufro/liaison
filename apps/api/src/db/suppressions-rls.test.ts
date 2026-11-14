// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Suppressions under the real liaison_rls role: an opt-out is read with
// mail:suppressions:read (or by a system actor, the send path), added by
// anyone who writes mail (mail:conversations:write) or holds
// mail:suppressions:write, removed only with mail:suppressions:write, never
// edited. Their links are out of the request role's reach. Neither table can hold an address.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const MEMBER = crypto.randomUUID()

const hash = (org: string, email: string) =>
  createHash("sha256").update(`${org}:${email.trim().toLowerCase()}`).digest("hex")
const OPTED_OUT = hash(ORG_ID, "lea@example.com")

function person(scopes: string[], orgId: string = ORG_ID): ActorContext {
  return { actorType: "user", userId: MEMBER, orgId, scopes, dimensionGrants: {} }
}
const system: ActorContext = { actorType: "system", orgId: ORG_ID, purpose: "job", scopes: [] }

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? "unknown"
}

async function attempt(tx: Pick<RlsClient, "transaction">, statement: string): Promise<string> {
  try {
    const n = await tx.transaction(async (sp) => {
      const rows = extractRows(await sp.execute(drizzleSql.raw(`${statement} RETURNING 1 AS one`)))
      return rows.length
    })
    return n > 0 ? "allowed" : "no row"
  } catch (err) {
    return pgCode(err)
  }
}

async function visible(actor: ActorContext): Promise<number> {
  return withRlsContext(actor, async (tx) => {
    const [row] = extractRows<{ n: number }>(
      await tx.execute(drizzleSql`SELECT count(*)::int AS n FROM kernel.suppressions`),
    )
    return row?.n ?? -1
  })
}

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", { id, name: "Opt-outs", slug: `optout-${id.slice(0, 8)}` }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.users", {
      id: MEMBER,
      org_id: ORG_ID,
      email: `m-${MEMBER.slice(0, 8)}@example.com`,
      name: "Member",
    }),
  )
  await sql.unsafe(
    insertSql("kernel.suppressions", { org_id: ORG_ID, email_hash: OPTED_OUT, reason: "link" }),
  )
  await sql.unsafe(
    insertSql("kernel.suppression_links", {
      token_hash: hash(ORG_ID, "token"),
      org_id: ORG_ID,
      email_hash: OPTED_OUT,
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.suppression_links WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.suppressions WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe("kernel.suppressions", () => {
  it("suppressions holds no column that can store an address", async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name IN ('suppressions', 'suppression_links')
       ORDER BY table_name, column_name`
    // A closed list: a new free-text column could carry the address.
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "suppression_links.created_at",
      "suppression_links.email_hash",
      "suppression_links.org_id",
      "suppression_links.token_hash",
      "suppressions.created_at",
      "suppressions.created_by",
      "suppressions.email_hash",
      "suppressions.id",
      "suppressions.org_id",
      "suppressions.reason",
      "suppressions.source",
    ])
    // The fingerprint column takes a sha256 hex, never an address.
    await expect(
      sql.unsafe(
        insertSql("kernel.suppressions", {
          org_id: ORG_ID,
          email_hash: "lea@example.com",
          reason: "person",
        }),
      ),
    ).rejects.toThrow("check")
  })

  it("an opt-out is read with the suppressions read scope or by a system actor, by nobody else", async () => {
    expect(await visible(person(["mail:suppressions:read"]))).toBe(1)
    expect(await visible(person(["mail:*"]))).toBe(1)
    expect(await visible(system)).toBe(1)
    expect(await visible(person(["mail:conversations:read"]))).toBe(0)
    expect(await visible(person(["mail:suppressions:read"], OTHER_ORG_ID))).toBe(0)
  })

  it("an opt-out is added and removed with the write scope and never edited", async () => {
    const fresh = hash(ORG_ID, "noe@example.com")
    const add = insertSql("kernel.suppressions", {
      org_id: ORG_ID,
      email_hash: fresh,
      reason: "person",
    })
    const outcome = await withRlsContext(
      person(["mail:suppressions:read", "mail:suppressions:write"]),
      async (tx) => ({
        add: await attempt(tx, add),
        edit: await attempt(
          tx,
          `UPDATE kernel.suppressions SET reason = 'import' WHERE email_hash = '${OPTED_OUT}'`,
        ),
        remove: await attempt(tx, `DELETE FROM kernel.suppressions WHERE email_hash = '${fresh}'`),
      }),
    )
    expect(outcome).toEqual({ add: "allowed", edit: "42501", remove: "allowed" })
    const readerOnly = await withRlsContext(person(["mail:suppressions:read"]), async (tx) => ({
      add: await attempt(tx, add),
      remove: await attempt(
        tx,
        `DELETE FROM kernel.suppressions WHERE email_hash = '${OPTED_OUT}'`,
      ),
    }))
    expect(readerOnly).toEqual({ add: "42501", remove: "no row" })
  })

  it("anyone who writes mail records an opt-out, and only the suppressions write scope removes one", async () => {
    const fresh = hash(ORG_ID, "ines@example.com")
    const add = insertSql("kernel.suppressions", {
      org_id: ORG_ID,
      email_hash: fresh,
      reason: "person",
    })
    const writer = await withRlsContext(
      person(["mail:conversations:read", "mail:conversations:write", "mail:suppressions:read"]),
      async (tx) => ({
        add: await attempt(tx, add),
        remove: await attempt(
          tx,
          `DELETE FROM kernel.suppressions WHERE email_hash = '${OPTED_OUT}'`,
        ),
      }),
    )
    expect(writer).toEqual({ add: "allowed", remove: "no row" })
    const [kept] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.suppressions
       WHERE org_id = ${ORG_ID} AND email_hash IN (${fresh}, ${OPTED_OUT})`
    expect(kept?.n).toBe(2)
    await sql`DELETE FROM kernel.suppressions WHERE email_hash = ${fresh}`
  })

  it("the request role cannot read or write opt-out links at all", async () => {
    const outcome = await withRlsContext(person(["*"]), async (tx) => ({
      read: await attempt(tx, `DELETE FROM kernel.suppression_links WHERE org_id = '${ORG_ID}'`),
    }))
    expect(outcome).toEqual({ read: "42501" })
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.suppression_links WHERE org_id = ${ORG_ID}`
    expect(left?.n).toBe(1)
  })
})

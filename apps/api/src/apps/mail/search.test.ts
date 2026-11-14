// SPDX-License-Identifier: FSL-1.1-ALv2
// Unit-tier coverage for the host-side mail conversation search
// (apps/mail/search.ts) — the Meili-id-join + real-SQL-filter replacement for
// the old in-sandbox equality-where + JS post-filter scan. Runs against real
// Postgres with the `MailSearchTestAccess.setMatchResolver` injection seam standing in
// for Meili (no live index at this tier — mirrors tickets'
// search.freetext.test.ts convention). Each test is falsifiable against a
// specific property of the new implementation:
//   - structured from/since/until predicates are REAL SQL (not post-filters)
//   - free text is UNION semantics: SQL ILIKE ground truth OR the Meili id
//     set — so a just-synced (not yet indexed) conversation still matches,
//     and a Meili-only (token/enrichment) match is widened in
//   - a resolver failure degrades to ILIKE-only and flags `degraded`
//   - paging math (totalCount + nextOffset) is exact
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  type MailSearchActor,
  MailSearchTestAccess,
  searchMailConversations,
} from "~/apps/mail/search"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let accountId: string

const actor: MailSearchActor = {
  userId: "00000000-0000-0000-0000-000000000001",
  scopes: ["mail:conversations:read"],
  dimensionGrants: {},
  roleIds: [],
}

async function seedConv(opts: {
  subject: string
  snippet?: string
  fromEmail?: string
  lastMessageAt?: string
  textBody?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("mail-search-test-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, external_thread_id, subject, snippet,
        from_email, status, is_read, is_starred, last_message_at, message_count,
        created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${accountId}, 'org', ${`ext-${id}`}, ${opts.subject},
        ${opts.snippet ?? ""}, ${opts.fromEmail ?? "someone@example.test"}, 'open',
        false, false, ${opts.lastMessageAt ?? new Date().toISOString()}::timestamptz, 1,
        now(), now()
      )
    `)
    if (opts.textBody) {
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, owner_type, subject, text_body,
          direction, is_read, is_starred, sent_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${id}, ${accountId}, 'org', ${opts.subject},
          ${opts.textBody}, 'inbound', false, false, now(), now(), now()
        )
      `)
    }
  })
  return id
}

beforeAll(async () => {
  orgId = crypto.randomUUID()
  await withSystemDb("mail-search-test-org", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug, created_at, updated_at)
      VALUES (${orgId}, 'mail-search-test-org', ${`mail-search-test-${orgId.slice(0, 8)}`}, now(), now())
    `)
  })
  await ensureAppsForOrg(orgId)
  accountId = crypto.randomUUID()
  await withSystemDb("mail-search-test-account", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, provider, email_address,
        sync_status, created_at, updated_at
      ) VALUES (
        ${accountId}, ${orgId}, ${crypto.randomUUID()}, 'org', 'gmail',
        'inbox@mail-search-test.example', 'active', now(), now()
      )
    `)
  })
})

afterEach(() => {
  MailSearchTestAccess.setMatchResolver(null)
})

function run(params: Parameters<typeof searchMailConversations>[2]) {
  return withSystemDb("mail-search-test-run", (tx) =>
    searchMailConversations(tx, orgId, params, actor),
  )
}

describe("searchMailConversations", () => {
  it("from filter is a case-insensitive SQL predicate with exact totalCount", async () => {
    const hit = await seedConv({ subject: "A", fromEmail: "sales@NORTHWIND-audio.test" })
    await seedConv({ subject: "B", fromEmail: "orders@cascade.test" })
    MailSearchTestAccess.setMatchResolver(async () => {
      throw new Error("from-only search must not consult the text resolver")
    })
    const res = await run({ from: "@northwind-audio.test" })
    expect(res.items.map((r) => r.id)).toEqual([hit])
    expect(res.totalCount).toBe(1)
    expect(res.degraded).toBe(false)
  })

  it("since/until bound last_message_at in SQL", async () => {
    const inWindow = await seedConv({
      subject: "windowed",
      lastMessageAt: "2026-05-15T12:00:00Z",
      fromEmail: "w@window.test",
    })
    await seedConv({
      subject: "outside",
      lastMessageAt: "2026-06-15T12:00:00Z",
      fromEmail: "w@window.test",
    })
    const res = await run({
      from: "@window.test",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-31T23:59:59Z",
    })
    expect(res.items.map((r) => r.id)).toEqual([inWindow])
    expect(res.totalCount).toBe(1)
  })

  it("free text UNION: a subject substring match returns even when the index has no doc yet", async () => {
    const fresh = await seedConv({
      subject: "Chronopost pickup for Klangwerk",
      fromEmail: "x@u1.test",
    })
    // Meili knows nothing about this conversation (indexing lag) — resolver
    // returns an empty id set. Without the union clause this returned [].
    MailSearchTestAccess.setMatchResolver(async () => [])
    const res = await run({ query: "Chronopost", from: "@u1.test" })
    expect(res.items.map((r) => r.id)).toEqual([fresh])
    expect(res.degraded).toBe(false)
  })

  it("free text UNION: a Meili-only (enrichment/token) match is widened into the result", async () => {
    const tokenHit = await seedConv({ subject: "unrelated subject", fromEmail: "x@u2.test" })
    MailSearchTestAccess.setMatchResolver(async ({ q }) => {
      expect(q).toBe("pressure sensitivity")
      return [tokenHit]
    })
    const res = await run({ query: "pressure sensitivity", from: "@u2.test" })
    expect(res.items.map((r) => r.id)).toEqual([tokenHit])
  })

  it("body param matches synced message text through the SQL fallback branch", async () => {
    const bodyHit = await seedConv({
      subject: "see attached",
      fromEmail: "x@u3.test",
      textBody: "the purchase order is enclosed",
    })
    await seedConv({ subject: "see attached too", fromEmail: "x@u3.test", textBody: "nothing" })
    MailSearchTestAccess.setMatchResolver(async () => [])
    const res = await run({ body: "purchase order", from: "@u3.test" })
    expect(res.items.map((r) => r.id)).toEqual([bodyHit])
  })

  it("resolver failure degrades to ILIKE-only and flags degraded", async () => {
    const hit = await seedConv({
      subject: "Meili is down but I still match",
      fromEmail: "x@u4.test",
    })
    MailSearchTestAccess.setMatchResolver(async () => {
      throw new Error("meili down")
    })
    const res = await run({ query: "still match", from: "@u4.test" })
    expect(res.items.map((r) => r.id)).toEqual([hit])
    expect(res.degraded).toBe(true)
  })

  it("paging: exact totalCount and correct nextOffset", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedConv({
          subject: `page-fixture ${i}`,
          fromEmail: "p@paging.test",
          lastMessageAt: `2026-04-0${i + 1}T00:00:00Z`,
        }),
      )
    }
    const p1 = await run({ from: "@paging.test", limit: 2 })
    expect(p1.items.length).toBe(2)
    expect(p1.totalCount).toBe(5)
    expect(p1.nextOffset).toBe(2)
    const p3 = await run({ from: "@paging.test", limit: 2, offset: 4 })
    expect(p3.items.length).toBe(1)
    expect(p3.nextOffset).toBe(null)
    // newest-first ordering across pages, no overlap
    const all = [
      ...p1.items,
      ...(await run({ from: "@paging.test", limit: 2, offset: 2 })).items,
      ...p3.items,
    ].map((r) => r.id)
    expect(new Set(all).size).toBe(5)
    expect(all[0]).toBe(ids[4])
  })

  it("invalid since date throws a typed message (never silently returns all rows)", async () => {
    await expect(run({ since: "not-a-date" })).rejects.toThrow("since is not a valid ISO date")
  })
})

// S13 / A40: Gmail Primary. Primary = CATEGORY_PERSONAL, or no CATEGORY_* at
// all; Other = categorized without CATEGORY_PERSONAL; all = both.
describe("searchMailConversations category", () => {
  async function seedAccount(ownerType: "user" | "org", provider: "gmail" | "imap") {
    const id = crypto.randomUUID()
    await withSystemDb("mail-search-test-category-account", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts (
          id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
          sync_status, created_at, updated_at
        ) VALUES (
          ${id}, ${orgId}, ${crypto.randomUUID()}, ${ownerType},
          ${ownerType === "user" ? actor.userId : null}::uuid, ${provider},
          ${`${id.slice(0, 8)}@category-test.example`}, 'active', now(), now()
        )
      `)
    })
    return id
  }

  /** The four shapes of the plan's fixture, on one account. */
  async function seedFour(account: string) {
    const byLabels: Record<string, string[]> = {
      personal: ["INBOX", "CATEGORY_PERSONAL"],
      promotions: ["INBOX", "CATEGORY_PROMOTIONS"],
      none: ["INBOX"],
      updatesPersonal: ["INBOX", "CATEGORY_UPDATES", "CATEGORY_PERSONAL"],
    }
    const ids: Record<string, string> = {}
    for (const [key, labels] of Object.entries(byLabels)) {
      const id = crypto.randomUUID()
      await withSystemDb("mail-search-test-category-seed", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO app_mail.conversations (
            id, org_id, account_id, owner_type, external_thread_id, subject, snippet,
            from_email, status, labels, is_read, is_starred, last_message_at, message_count,
            created_at, updated_at
          ) VALUES (
            ${id}, ${orgId}, ${account}, 'org', ${`ext-${id}`}, ${key}, '',
            'someone@example.test', 'open', ${JSON.stringify(labels)}::jsonb, false, false,
            now(), 1, now(), now()
          )
        `)
      })
      ids[key] = id
    }
    return ids
  }

  const sorted = (xs: string[]) => [...xs].sort()

  it("primary gives 3, other gives 1, all gives 4", async () => {
    const account = await seedAccount("org", "gmail")
    const ids = await seedFour(account)
    const primary = await run({ accountId: account, category: "primary" })
    const other = await run({ accountId: account, category: "other" })
    const all = await run({ accountId: account, category: "all" })
    expect(sorted(primary.items.map((r) => r.id))).toEqual(
      sorted([ids.personal, ids.none, ids.updatesPersonal]),
    )
    expect(primary.totalCount).toBe(3)
    expect(other.items.map((r) => r.id)).toEqual([ids.promotions])
    expect(all.totalCount).toBe(4)
    // No category is "all": the parameter never narrows unless asked.
    expect((await run({ accountId: account })).totalCount).toBe(4)
  })

  it("the agent default (primary on personal Gmail only) leaves shared and non-Gmail mailboxes whole", async () => {
    const personalGmail = await seedAccount("user", "gmail")
    const sharedGmail = await seedAccount("org", "gmail")
    const personalImap = await seedAccount("user", "imap")
    const personal = await seedFour(personalGmail)
    await seedFour(sharedGmail)
    await seedFour(personalImap)
    const agentDefault = { category: "primary", categoryScope: "personal-gmail" } as const

    const onPersonal = await run({ accountId: personalGmail, ...agentDefault })
    expect(sorted(onPersonal.items.map((r) => r.id))).toEqual(
      sorted([personal.personal, personal.none, personal.updatesPersonal]),
    )
    expect((await run({ accountId: sharedGmail, ...agentDefault })).totalCount).toBe(4)
    expect((await run({ accountId: personalImap, ...agentDefault })).totalCount).toBe(4)
  })

  it("an unknown category is refused, never silently ignored", async () => {
    await expect(run({ category: "newsletters" as never })).rejects.toThrow(
      "category must be primary, other or all",
    )
  })
})

describe("searchMailConversations lastInboundAt", () => {
  it("lastInboundAt ignores our outbound", async () => {
    const subject = `last-inbound-${crypto.randomUUID()}`
    const id = await seedConv({ subject, textBody: "Their question." })
    const inboundAt = "2026-03-02T09:00:00.000Z"
    await withSystemDb("mail-search-test-outbound", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_mail.messages SET sent_at = ${inboundAt}::timestamptz WHERE conversation_id = ${id}`)
      // Our answer, later: it moves the conversation's last message, never its last inbound.
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, owner_type, subject, text_body,
          direction, is_read, is_starred, sent_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${id}, ${accountId}, 'org', ${subject},
          'Our answer.', 'outbound', true, false, '2026-03-05T09:00:00Z'::timestamptz, now(), now()
        )`)
    })
    const res = await run({ query: subject })
    const row = res.items.find((item) => item.id === id)
    expect(row).toBeDefined()
    expect(new Date(row?.last_inbound_at ?? 0).toISOString()).toBe(inboundAt)
  })

  it("a conversation with only our outbound has no lastInboundAt", async () => {
    const subject = `outbound-only-${crypto.randomUUID()}`
    const id = await seedConv({ subject })
    await withSystemDb("mail-search-test-outbound-only", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, owner_type, subject, text_body,
          direction, is_read, is_starred, sent_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${id}, ${accountId}, 'org', ${subject},
          'Our first mail.', 'outbound', true, false, now(), now(), now()
        )`)
    })
    const row = (await run({ query: subject })).items.find((item) => item.id === id)
    expect(row?.last_inbound_at).toBeNull()
  })
})

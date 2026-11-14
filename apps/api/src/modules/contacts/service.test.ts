// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { listContacts, resolveContact } from "~/modules/contacts/service"
import { releaseAppSchema, takeOverAppSchema } from "~/tests/helpers/app-schema-fixture"
import { acquireAppSchemaLock, releaseAppSchemaLock } from "~/tests/helpers/app-schema-lock"

const ORG_ID = "00000000-0000-0000-0000-000000008001"
const USER_ID = "00000000-0000-0000-0000-000000008002"

// Brand db as RlsClient (same pattern as roles.test.ts)
const events: any[] = []
const rlsDb = db as unknown as RlsClient
const origTx = (rlsDb as any).transaction.bind(rlsDb)
const origQueueEvent = (rlsDb as any).queueEvent

beforeEach(() => {
  ;(rlsDb as any).queueEvent = async (event: any) => {
    events.push(event)
  }
  ;(rlsDb as any).transaction = async (fn: any) =>
    origTx(async (tx: any) => {
      tx.queueEvent = async (event: any) => {
        events.push(event)
      }
      return fn(tx)
    })
})

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ContactSvcOrg', 'contact-svc-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'contact-svc@test.com', 'Svc User') ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  events.length = 0
  ;(rlsDb as any).queueEvent = origQueueEvent
  ;(rlsDb as any).transaction = origTx
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
})

describe("resolveContact — spurious update event", () => {
  it("does not emit update event when nothing changed", async () => {
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      { email: "test@test.com", name: "Test" },
      { audience: "org" },
    )
    events.length = 0 // clear create event

    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      { email: "test@test.com", name: "Test" },
      { audience: "org" },
    )
    const updateEvent = events.find((e) => e.action === "update" && e.entity === "contact")
    expect(updateEvent).toBeUndefined()
  })

  it("does not emit update event when the same external id and metadata are resolved again", async () => {
    const params = {
      email: "test3@test.com",
      name: "Same",
      externalId: { shopify: "gid://shopify/Customer/7" },
      metadata: { tier: "gold" },
    }
    await resolveContact(rlsDb, ORG_ID, USER_ID, params, { audience: "org" })
    events.length = 0 // clear create event

    await resolveContact(rlsDb, ORG_ID, USER_ID, params, { audience: "org" })
    expect(events.find((e) => e.action === "update" && e.entity === "contact")).toBeUndefined()

    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      { ...params, metadata: { tier: "platinum" } },
      { audience: "org" },
    )
    expect(events.find((e) => e.action === "update" && e.entity === "contact")).toBeDefined()
  })

  it("does emit update event when name is merged for the first time", async () => {
    await resolveContact(rlsDb, ORG_ID, USER_ID, { email: "test2@test.com" }, { audience: "org" })
    events.length = 0 // clear create event

    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      { email: "test2@test.com", name: "NewName" },
      { audience: "org" },
    )
    const updateEvent = events.find((e) => e.action === "update" && e.entity === "contact")
    expect(updateEvent).toBeDefined()
  })
})

// Phase 16 Task A0 — `resolveContact` accepts a per-app-keyed externalId map and
// writes / merges into `kernel.contacts.external_ids[<app>]`. The bridge layer is
// what forces the key from `appName`; here we pin the service-level contract
// directly so the multi-app shape is regression-proof.
describe("resolveContact — app-keyed external_ids", () => {
  it("writes external_ids[<app>] on first resolution", async () => {
    const { contact } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "key-marie@x.com",
        name: "Marie",
        externalId: { shopify: "gid://shopify/Customer/1" },
      },
      { audience: "org" },
    )
    const row = await sql`SELECT external_ids FROM kernel.contacts WHERE id = ${contact!.id}`
    expect(row[0].external_ids).toEqual({ shopify: "gid://shopify/Customer/1" })
  })

  it("merges external_ids across apps without clobbering existing keys", async () => {
    const first = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "key-merge@x.com",
        externalId: { mail: "<msg-1@x>" },
      },
      { audience: "org" },
    )
    const second = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "key-merge@x.com",
        externalId: { shopify: "gid://shopify/Customer/2" },
      },
      { audience: "org" },
    )
    expect(second.contact!.id).toBe(first.contact!.id)
    const row = await sql`SELECT external_ids FROM kernel.contacts WHERE id = ${second.contact!.id}`
    expect(row[0].external_ids).toEqual({
      mail: "<msg-1@x>",
      shopify: "gid://shopify/Customer/2",
    })
  })

  it("looks up an existing contact by external_ids[<app>] (email-change but stable shopify id)", async () => {
    const first = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "old@x.com",
        externalId: { shopify: "gid://shopify/Customer/3" },
      },
      { audience: "org" },
    )
    const second = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        // email lookup takes precedence today; pass only the external id so the
        // external-id path runs and finds the same contact.
        externalId: { shopify: "gid://shopify/Customer/3" },
      },
      { audience: "org" },
    )
    expect(second.contact!.id).toBe(first.contact!.id)
  })

  it("legacy call (no externalId) leaves external_ids empty", async () => {
    const { contact } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "legacy@x.com",
        name: "Legacy",
      },
      { audience: "org" },
    )
    const row = await sql`SELECT external_ids FROM kernel.contacts WHERE id = ${contact!.id}`
    expect(row[0].external_ids ?? {}).toEqual({})
  })
})

// Pin the phone-upsert concurrent-conflict behavior: two concurrent resolveContact
// calls with the same phone and no email must produce exactly ONE contact row via the
// ON CONFLICT / unique partial index path (`contacts_org_phone_unique_idx`), never two.
describe("resolveContact — phone concurrent upsert", () => {
  it("two concurrent calls with the same phone create exactly one contact row", async () => {
    const phone = "+15550000001"

    // Fire both resolutions simultaneously — neither sees the other's SELECT result
    // because they race before either INSERT commits. The second INSERT hits
    // ON CONFLICT DO UPDATE on `contacts_org_phone_unique_idx` and merges instead
    // of inserting a duplicate row.
    const [result1, result2] = await Promise.all([
      resolveContact(rlsDb, ORG_ID, USER_ID, { phone, name: "Concurrent A" }, { audience: "org" }),
      resolveContact(rlsDb, ORG_ID, USER_ID, { phone, name: "Concurrent B" }, { audience: "org" }),
    ])

    // Both calls must resolve successfully
    expect(result1.contact).toBeDefined()
    expect(result2.contact).toBeDefined()

    // Exactly one row must exist in the database for this phone + org combination
    const rows =
      await sql`SELECT id FROM kernel.contacts WHERE org_id = ${ORG_ID} AND phone = ${phone}`
    expect(rows.length).toBe(1)
  })
})

// BL-03 — contacts_search must also match the stored VAT number and country (external_ids jsonb).
// A counterparty an agent only knows by VAT (an intra-EU dealer) or by country code was previously
// unfindable (name/email/company-only ILIKE), forcing a redundant re-create.
describe("listContacts — search by VAT / country (external_ids, BL-03)", () => {
  beforeEach(async () => {
    await sql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, company, email, external_ids)
      VALUES (gen_random_uuid(), ${ORG_ID}, 'bl03-dealer', 'Sonora Strumenti', 'Sonora Strumenti SRL',
              'acquisti@sonora.example.it', ${JSON.stringify({ vat_id: "IT12345678901", country: "IT" })}::jsonb)`
    await sql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, company, email, external_ids)
      VALUES (gen_random_uuid(), ${ORG_ID}, 'bl03-other', 'Klangwerk GmbH', 'Klangwerk GmbH',
              'ar@klangwerk.example', ${JSON.stringify({ vat_id: "DE000000000", country: "DE" })}::jsonb)`
  })

  it("finds a contact by its exact VAT number (previously unfindable)", async () => {
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 20,
      query: "IT12345678901",
    })
    expect(res.rows.map((c) => c.handle)).toEqual(["bl03-dealer"])
  })

  it("finds contacts by country code", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 20, query: "DE" })
    expect(res.rows.some((c) => c.handle === "bl03-other")).toBe(true)
  })

  it("still matches by name (no regression) and excludes non-matches", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 20, query: "Sonora" })
    expect(res.rows.map((c) => c.handle)).toEqual(["bl03-dealer"])
  })
})

describe("listContacts — notContactedSince recency filter + surfaced lastContactedAt (BL-258)", () => {
  // find-inactive-dealers-followup: the agent must list dealers we haven't emailed in over 90 days.
  // listContacts already COMPUTES lastContactedAt (MAX last_message_at over the contact's linked mail
  // conversations) and the UI sorts by it; this filter lets the agent SELECT the stale set directly
  // (tag:dealer + notContactedSince:<today−90d>) instead of paging + screening, and the handler now
  // surfaces lastContactedAt so the agent can report how long each has been silent. A never-contacted
  // contact (no conversation → lastContactedAt null) also counts as "haven't emailed them".
  const STALE_ID = "00000000-0000-0000-0000-0000000058a1"
  const RECENT_ID = "00000000-0000-0000-0000-0000000058a2"
  const NEVER_ID = "00000000-0000-0000-0000-0000000058a3"
  const ACCOUNT_ID = "00000000-0000-0000-0000-0000000058ff"
  const ACCOUNT_EMAIL = "bl258-desk@example.test"

  beforeEach(async () => {
    // The conversations below need a real app_mail.accounts row: the mail app's
    // BEFORE INSERT plaintext-invariant trigger resolves NEW.account_id and
    // raises `mailbox_account_unresolved` for an account it cannot find, so a
    // bare account_id literal cannot reach the table at all. `encryption_state`
    // stays 'none' (invariant disarmed), which is what keeps the plaintext
    // `subject` values below legal.
    await sql`INSERT INTO app_mail.accounts
      (id, org_id, connected_account_id, owner_type, provider, email_address, sync_status, encryption_state)
      VALUES (${ACCOUNT_ID}, ${ORG_ID}, gen_random_uuid(), 'org', 'imap', ${ACCOUNT_EMAIL}, 'idle', 'none')
      ON CONFLICT (id) DO NOTHING`
    // Three dealer contacts, all tagged 'dealer'.
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, email, tags)
      VALUES (${STALE_ID}, ${ORG_ID}, 'bl258-stale', 'Northwind Audio', 'Northwind Audio',
              'buyer@northwind-audio.example', ARRAY['dealer']::text[])`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, email, tags)
      VALUES (${RECENT_ID}, ${ORG_ID}, 'bl258-recent', 'Tidewater Pro Audio', 'Tidewater Pro Audio',
              'purchasing@tidewater-pro.example', ARRAY['dealer']::text[])`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, email, tags)
      VALUES (${NEVER_ID}, ${ORG_ID}, 'bl258-never', 'Pinegrove Audio', 'Pinegrove Audio',
              'buyer@pinegrove-audio.example', ARRAY['dealer']::text[])`
    // STALE: one conversation last touched 140 days ago. RECENT: one 5 days ago. NEVER: none.
    await sql`INSERT INTO app_mail.conversations
      (id, org_id, account_id, owner_type, external_thread_id, subject, status, last_message_at, contact_id)
      VALUES (gen_random_uuid(), ${ORG_ID}, ${ACCOUNT_ID}, 'org', 'bl258-conv-stale', 'Old dealer enquiry',
              'open', now() - interval '140 days', ${STALE_ID})`
    await sql`INSERT INTO app_mail.conversations
      (id, org_id, account_id, owner_type, external_thread_id, subject, status, last_message_at, contact_id)
      VALUES (gen_random_uuid(), ${ORG_ID}, ${ACCOUNT_ID}, 'org', 'bl258-conv-recent', 'Recent dealer note',
              'open', now() - interval '5 days', ${RECENT_ID})`
  })

  afterEach(async () => {
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_mail.accounts WHERE id = ${ACCOUNT_ID}`
  })

  const cutoff90 = () => new Date(Date.now() - 90 * 86_400_000).toISOString()

  it("returns the stale + never-contacted dealers and EXCLUDES the recently-contacted one", async () => {
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      tag: "dealer",
      notContactedSince: cutoff90(),
    })
    const handles = res.rows.map((c) => c.handle).sort()
    expect(handles).toEqual(["bl258-never", "bl258-stale"])
  })

  it("WITHOUT the filter all three dealers come back (fails-without proof the filter is load-bearing)", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, tag: "dealer" })
    const handles = res.rows.map((c) => c.handle).sort()
    expect(handles).toEqual(["bl258-never", "bl258-recent", "bl258-stale"])
  })

  it("surfaces the server-computed lastContactedAt (null for never-contacted)", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, tag: "dealer" })
    const byHandle = new Map(res.rows.map((c) => [c.handle, c]))
    expect(byHandle.get("bl258-never")?.lastContactedAt).toBeNull()
    expect(byHandle.get("bl258-stale")?.lastContactedAt).not.toBeNull()
    expect(byHandle.get("bl258-recent")?.lastContactedAt).not.toBeNull()
    // The stale dealer's last contact is genuinely older than the recent dealer's.
    const staleAt = new Date(byHandle.get("bl258-stale")!.lastContactedAt as string).getTime()
    const recentAt = new Date(byHandle.get("bl258-recent")!.lastContactedAt as string).getTime()
    expect(staleAt).toBeLessThan(recentAt)
  })
})

describe("listContacts — last activity folds in invoicing, not mail alone", () => {
  // A customer with an invoice issued yesterday but NO mail thread previously
  // read "never" because lastContactedAt only counted app_mail.conversations.
  // The column means last ACTIVITY, so it must also reflect invoicing documents.
  // The invoicing app is optional, so this file OWNS `app_invoicing` for its
  // lifetime: `takeOverAppSchema` renames whatever is there aside and leaves an
  // empty schema for the minimal documents table below (only the columns the
  // last-activity subquery reads), and `releaseAppSchema` drops that fixture and
  // renames the original back. Branching on which shape the database happened to
  // have meant seeding rows INTO the registered app, and which branch ran
  // depended on whether another file had registered it first, which is not a
  // property a test may have.
  const INV_ONLY_ID = "00000000-0000-0000-0000-0000000058b1"
  const NO_ACTIVITY_ID = "00000000-0000-0000-0000-0000000058b2"
  // Closed-world seam: contacts carrying BOTH a mail conversation AND an invoice,
  // to prove the projection folds EVERY source via GREATEST (not just whichever
  // branch happens to run). BOTH_INV_NEWER's invoice is more recent than its
  // mail; BOTH_MAIL_NEWER's mail is more recent than its invoice.
  const BOTH_INV_NEWER_ID = "00000000-0000-0000-0000-0000000058b3"
  const BOTH_MAIL_NEWER_ID = "00000000-0000-0000-0000-0000000058b4"
  const ACCOUNT_ID = "00000000-0000-0000-0000-0000000058bf"
  const ACCOUNT_EMAIL = "last-activity-desk@example.test"

  beforeAll(async () => {
    // The lock is held for the whole file: the original is invisible under its
    // real name while the fixture holds it, so peers must be serialized exactly
    // as they are around a registration or a drop.
    const invoicingLock = await acquireAppSchemaLock("app_invoicing")
    // The handle proves the holder is this file, so the take-over re-enters the
    // lock instead of queueing behind it.
    await takeOverAppSchema("app_invoicing", { lock: invoicingLock })
    await sql.unsafe(`GRANT ALL ON SCHEMA app_invoicing TO liaison_rls, liaison_app, liaison_admin`)
    await sql`
      CREATE TABLE app_invoicing.documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        counterparty_contact_id uuid,
        issued_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_invoicing.documents TO liaison_rls, liaison_app, liaison_admin`,
    )
  })

  afterAll(async () => {
    await releaseAppSchema("app_invoicing")
    await releaseAppSchemaLock("app_invoicing")
  })

  // One invoice for `contactId`, issued `daysAgo` days back.
  async function seedDocument(contactId: string, daysAgo: number) {
    await sql`INSERT INTO app_invoicing.documents (id, org_id, counterparty_contact_id, issued_at)
      VALUES (gen_random_uuid(), ${ORG_ID}, ${contactId}, now() - make_interval(days => ${daysAgo}))`
  }

  beforeEach(async () => {
    // The conversations below need a real app_mail.accounts row: the mail app's
    // BEFORE INSERT plaintext-invariant trigger resolves NEW.account_id and
    // raises `mailbox_account_unresolved` for an account it cannot find, so a
    // bare account_id literal cannot reach the table at all. `encryption_state`
    // stays 'none' (invariant disarmed), which is what keeps the plaintext
    // `subject` values below legal.
    await sql`INSERT INTO app_mail.accounts
      (id, org_id, connected_account_id, owner_type, provider, email_address, sync_status, encryption_state)
      VALUES (${ACCOUNT_ID}, ${ORG_ID}, gen_random_uuid(), 'org', 'imap', ${ACCOUNT_EMAIL}, 'idle', 'none')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES (${INV_ONLY_ID}, ${ORG_ID}, 'inv-only', 'Stanley Fortson', 'stanley@example.com')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES (${NO_ACTIVITY_ID}, ${ORG_ID}, 'no-activity', 'Idle Contact', 'idle@example.com')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES (${BOTH_INV_NEWER_ID}, ${ORG_ID}, 'both-inv-newer', 'Dual Alpha', 'dual-a@example.com')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES (${BOTH_MAIL_NEWER_ID}, ${ORG_ID}, 'both-mail-newer', 'Dual Beta', 'dual-b@example.com')`
    // Stanley has an invoice issued yesterday, no mail thread at all.
    await seedDocument(INV_ONLY_ID, 1)
    // both-inv-newer: mail 30 days ago, invoice 2 days ago -> GREATEST = invoice.
    await sql`INSERT INTO app_mail.conversations
      (id, org_id, account_id, owner_type, external_thread_id, subject, status, last_message_at, contact_id)
      VALUES (gen_random_uuid(), ${ORG_ID}, ${ACCOUNT_ID}, 'org', 'both-inv-newer-conv', 'Old note',
              'open', now() - interval '30 days', ${BOTH_INV_NEWER_ID})`
    await seedDocument(BOTH_INV_NEWER_ID, 2)
    // both-mail-newer: mail 3 days ago, invoice 45 days ago -> GREATEST = mail.
    await sql`INSERT INTO app_mail.conversations
      (id, org_id, account_id, owner_type, external_thread_id, subject, status, last_message_at, contact_id)
      VALUES (gen_random_uuid(), ${ORG_ID}, ${ACCOUNT_ID}, 'org', 'both-mail-newer-conv', 'Fresh note',
              'open', now() - interval '3 days', ${BOTH_MAIL_NEWER_ID})`
    await seedDocument(BOTH_MAIL_NEWER_ID, 45)
  })

  afterEach(async () => {
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_mail.accounts WHERE id = ${ACCOUNT_ID}`
  })

  it("a contact with an invoice but no mail reads its invoice date, NOT 'never'", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50 })
    const byHandle = new Map(res.rows.map((c) => [c.handle, c]))
    // The whole bug: this was null. Now it reflects the invoice's issued_at.
    expect(byHandle.get("inv-only")?.lastContactedAt).not.toBeNull()
    // A contact with neither mail nor an invoice genuinely reads "never" (null).
    expect(byHandle.get("no-activity")?.lastContactedAt).toBeNull()
  })

  it("notContactedSince respects invoicing activity (a fresh invoice is NOT stale)", async () => {
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      notContactedSince: cutoff,
    })
    const handles = res.rows.map((c) => c.handle)
    // inv-only had activity yesterday -> not stale, excluded.
    expect(handles).not.toContain("inv-only")
    // no-activity never -> stale, included.
    expect(handles).toContain("no-activity")
  })

  // Closed-world fold: lastContactedAt must be the GREATEST across EVERY activity
  // source (mail AND invoicing), not whichever branch happens to run first. A
  // contact carrying both signals must resolve to the MORE RECENT of the two --
  // in either direction -- so dropping either union arm from the GREATEST is
  // caught here.
  //
  // red: in service.ts listContacts, drop the invoicing union arm (set
  //   const invoicingActivity = drizzleSql``  -- i.e. fold mail alone)
  // -> both-inv-newer regresses to its 30-day-old mail date, so it no longer
  //    equals its 2-day-old invoice and this test fails. (Symmetrically, dropping
  //    the mail arm regresses both-mail-newer.)
  it("a contact with BOTH mail and invoicing folds to the GREATEST of the two, in either direction", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50 })
    const byHandle = new Map(res.rows.map((c) => [c.handle, c]))

    const invNewer = byHandle.get("both-inv-newer")
    const mailNewer = byHandle.get("both-mail-newer")
    expect(
      invNewer?.lastContactedAt,
      "both-inv-newer must have a last-activity date",
    ).not.toBeNull()
    expect(
      mailNewer?.lastContactedAt,
      "both-mail-newer must have a last-activity date",
    ).not.toBeNull()

    const now = Date.now()
    const invNewerAt = new Date(invNewer!.lastContactedAt as string).getTime()
    const mailNewerAt = new Date(mailNewer!.lastContactedAt as string).getTime()

    // both-inv-newer: mail=30d ago, invoice=2d ago -> folded date is the 2d-ago
    // invoice (recent), NOT the 30d-ago mail. Assert it sits within the last week,
    // which only the invoice branch can satisfy.
    expect(
      now - invNewerAt,
      "both-inv-newer folded to mail (30d) instead of the newer invoice (2d) -- invoicing arm dropped from GREATEST",
    ).toBeLessThan(7 * 86_400_000)

    // both-mail-newer: mail=3d ago, invoice=45d ago -> folded date is the 3d-ago
    // mail (recent), NOT the 45d-ago invoice. Only the mail branch can satisfy
    // the within-a-week window.
    expect(
      now - mailNewerAt,
      "both-mail-newer folded to invoice (45d) instead of the newer mail (3d) -- mail arm dropped from GREATEST",
    ).toBeLessThan(7 * 86_400_000)
  })
})

describe("listContacts — createdAfter + hasNoCompany/hasNoPhone bare-recent filters (BL-FIRST, weekly-enrich-new-contacts-routine)", () => {
  // weekly-enrich-new-contacts-routine: the run-now tick must RENDER the bare, recently-created contact
  // set (created in the past week, missing company AND/OR phone) instead of paging the whole set and
  // screening each in-context (the unreliable flash-lite in-context discrimination the l710/l711/l713/
  // l714 doctrine moves server-side). These filters select that set directly + the handler surfaces the
  // per-row isBare/missingCompany/missingPhone flags + phone/createdAt so the tick reports honestly.
  const BARE_ID = "00000000-0000-0000-0000-0000000059a1" // recent + no company + no phone (the target)
  const OLD_BARE_ID = "00000000-0000-0000-0000-0000000059a2" // bare but created long ago (excluded by createdAfter)
  const RECENT_FULL_ID = "00000000-0000-0000-0000-0000000059a3" // recent but already complete (control)
  const NO_PHONE_ID = "00000000-0000-0000-0000-0000000059a4" // recent, has company, no phone

  beforeEach(async () => {
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, phone, email, created_at)
      VALUES (${BARE_ID}, ${ORG_ID}, 'blfirst-bare', 'Jordan Reese', NULL, NULL,
              'jordan.reese@novachord-audio.example', now() - interval '2 days')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, phone, email, created_at)
      VALUES (${OLD_BARE_ID}, ${ORG_ID}, 'blfirst-old-bare', 'Mara Holt', NULL, NULL,
              'mara.holt@fenwick-instruments.example', now() - interval '40 days')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, phone, email, created_at)
      VALUES (${RECENT_FULL_ID}, ${ORG_ID}, 'blfirst-full', 'Theo Vance', 'Brightline Studios', '+1 512 555 0192',
              'theo.vance@brightline-studios.example', now() - interval '1 days')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company, phone, email, created_at)
      VALUES (${NO_PHONE_ID}, ${ORG_ID}, 'blfirst-no-phone', 'Owen Drake', 'Soundforge Labs', NULL,
              'owen.drake@soundforge-labs.example', now() - interval '3 days')`
  })

  const cutoff7 = () => new Date(Date.now() - 7 * 86_400_000).toISOString()

  it("createdAfter + hasNoCompany + hasNoPhone selects ONLY the recent strictly-bare contact", async () => {
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdAfter: cutoff7(),
      hasNoCompany: true,
      hasNoPhone: true,
    })
    const handles = res.rows.map((c) => c.handle).sort()
    // BARE is recent + no company + no phone. OLD_BARE is bare but too old (createdAfter excludes).
    // RECENT_FULL has both. NO_PHONE has a company (hasNoCompany excludes).
    expect(handles).toEqual(["blfirst-bare"])
    expect(res.total).toBe(1)
  })

  it("hasNoPhone alone (recent) returns the bare AND the company-but-no-phone contact", async () => {
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdAfter: cutoff7(),
      hasNoPhone: true,
    })
    const handles = res.rows.map((c) => c.handle).sort()
    expect(handles).toEqual(["blfirst-bare", "blfirst-no-phone"])
  })

  it("createdAfter alone EXCLUDES the old bare contact (fails-without proof the date filter is load-bearing)", async () => {
    const recent = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdAfter: cutoff7(),
    })
    expect(recent.rows.map((c) => c.handle)).not.toContain("blfirst-old-bare")
    // Without createdAfter, the old bare contact IS returned — proving the filter is what excludes it.
    const all = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50, hasNoCompany: true })
    expect(all.rows.map((c) => c.handle).sort()).toEqual(["blfirst-bare", "blfirst-old-bare"])
  })

  it("WITHOUT any filter all four come back (proves the filters are load-bearing)", async () => {
    const res = await listContacts(rlsDb, { orgId: ORG_ID, page: 1, limit: 50 })
    const handles = res.rows
      .map((c) => c.handle)
      .filter((h) => h.startsWith("blfirst-"))
      .sort()
    expect(handles).toEqual([
      "blfirst-bare",
      "blfirst-full",
      "blfirst-no-phone",
      "blfirst-old-bare",
    ])
  })

  it("createdWithinDays:7 is a ROLLING window (now−7d) — selects the recent bare contact, EXCLUDES the 40-day-old one", async () => {
    // The rolling sibling of createdAfter: resolved at QUERY time so a recurring routine's look-back
    // rolls each tick (vs a frozen ISO date). 7-day window includes BARE (2d) + NO_PHONE (3d) but not
    // OLD_BARE (40d). Combined with hasNoCompany+hasNoPhone it isolates the recent strictly-bare set.
    const res = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdWithinDays: 7,
      hasNoCompany: true,
      hasNoPhone: true,
    })
    expect(res.rows.map((c) => c.handle)).toEqual(["blfirst-bare"])

    // A 7-day rolling window over hasNoCompany returns ONLY the recent bare one, not the 40-day-old bare.
    const recentBare = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdWithinDays: 7,
      hasNoCompany: true,
    })
    expect(recentBare.rows.map((c) => c.handle)).toEqual(["blfirst-bare"])
    // Widen to 60 days and the old bare contact reappears — proving the window is what excludes it.
    const wide = await listContacts(rlsDb, {
      orgId: ORG_ID,
      page: 1,
      limit: 50,
      createdWithinDays: 60,
      hasNoCompany: true,
    })
    expect(wide.rows.map((c) => c.handle).sort()).toEqual(["blfirst-bare", "blfirst-old-bare"])
  })
})

describe("resolveContact — metadata persists on CREATE (dropped-on-create regression)", () => {
  // build-dealer-records-from-research: the agent web-researches a dealer and creates a contact WITH a
  // postal address in metadata. The create path used to drop metadata entirely (only the update path
  // persisted it), so the freshly-created contact came back metadata:null and the address was lost.
  it("round-trips metadata on a brand-new contact created with an email", async () => {
    const { contact, isNew } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "shop@lunar-synth.example",
        name: "Lunar Synth",
        company: "Lunar Synth",
        metadata: {
          address: "Rue de la Roquette 58, 75011 Paris, France",
          website: "https://lunar-synth.example",
        },
      },
      { audience: "org" },
    )
    expect(isNew).toBe(true)
    // The bug: this came back null. The fix: the create insert persists the metadata jsonb.
    expect(contact!.metadata).toEqual({
      address: "Rue de la Roquette 58, 75011 Paris, France",
      website: "https://lunar-synth.example",
    })
    // Confirm it is durable in the DB, not just on the returned row.
    const [row] = await sql<{ metadata: Record<string, unknown> | null }[]>`
      SELECT metadata FROM kernel.contacts WHERE id = ${contact!.id}`
    expect(row?.metadata).toEqual({
      address: "Rue de la Roquette 58, 75011 Paris, France",
      website: "https://lunar-synth.example",
    })
  })

  it("round-trips metadata on a name-only create (no email/phone)", async () => {
    const { contact, isNew } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        name: "Modular Plaza",
        company: "Modular Plaza",
        metadata: { address: "Plantage Middenlaan 22, 1018 DD Amsterdam, Netherlands" },
      },
      { audience: "org" },
    )
    expect(isNew).toBe(true)
    expect(contact!.metadata).toEqual({
      address: "Plantage Middenlaan 22, 1018 DD Amsterdam, Netherlands",
    })
  })

  it("merges new metadata onto an existing contact resolved during a create call (incoming keys win)", async () => {
    // First create with a website only.
    await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "kontakt@tonwerk-audio.example",
        name: "Tonwerk Audio",
        metadata: { website: "https://tonwerk-audio.example" },
      },
      { audience: "org" },
    )
    // A second create-shaped call (same email → resolves the existing) adds the address.
    const { contact, isNew } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "kontakt@tonwerk-audio.example",
        metadata: { address: "Skalitzer Strasse 134, 10999 Berlin, Germany" },
      },
      { audience: "org" },
    )
    expect(isNew).toBe(false)
    expect(contact!.metadata).toEqual({
      website: "https://tonwerk-audio.example",
      address: "Skalitzer Strasse 134, 10999 Berlin, Germany",
    })
  })

  it("leaves metadata null when none is supplied on create (no spurious default)", async () => {
    const { contact } = await resolveContact(
      rlsDb,
      ORG_ID,
      USER_ID,
      {
        email: "plain@example.com",
        name: "Plain Contact",
      },
      { audience: "org" },
    )
    expect(contact!.metadata).toBeNull()
  })
})

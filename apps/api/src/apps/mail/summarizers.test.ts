// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import {
  summarizeMailCompose,
  summarizeMailForward,
  summarizeMailReply,
} from "~/apps/mail/summarizers"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"

let orgId: string
let userId: string
let accountId: string
let conversationId: string
let inboundMessageId: string

describe("mail approval summarizers", () => {
  beforeAll(async () => {
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Mail Summarizer Org', ${`mail-summarizer-${Date.now()}`})
      RETURNING id
    `),
    )
    orgId = org.id

    const [user] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`mail-summarizer-${Date.now()}@test.com`}, 'Mail Summarizer User', 'active', 'hash')
      RETURNING id
    `),
    )
    userId = user.id

    resetAppRegistries()
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect", "contact:merge"]),
    )
    const mailOnlyManifest = {
      ...mailAppManifest,
      dependencies: { ...(mailAppManifest as any).dependencies, tools: [] },
    }
    await registerApps([mailOnlyManifest as any, ticketsAppManifest as any], orgId)
    // The `kernel.files` SELECT policy ships as a placeholder `USING (false)` and is
    // rebuilt from manifest `fileParent` declarations only during full app init
    // (`rebuildFilesSelectPolicy`, normally invoked by boot). `registerApps` populates
    // the fileParent registry but does NOT rebuild the policy, so without this call the
    // attachment-resolution tests below (which read `kernel.files` under RLS via
    // `describeFileOrigin`) see zero rows and the 📎/⚠ lines never render. l621.
    await rebuildFilesSelectPolicy()

    const [account] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status
      )
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'user', ${userId}, 'gmail', 'support@acme.com', 'active')
      RETURNING id
    `),
    )
    accountId = account.id

    const [conversation] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
        status, labels, is_read, is_starred, last_message_at, message_count
      )
      VALUES (
        gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-summarizer-1',
        'Pricing question', 'Can you send pricing?', 'open', '[]'::jsonb, false, false, now(), 1
      )
      RETURNING id
    `),
    )
    conversationId = conversation.id

    const [inboundMsg] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
          is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers
        )
        VALUES (
          gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<summarizer-msg@test>', 'gmail-summarizer-1',
          '{"email":"hans@acme.de","name":"Hans Weber"}'::jsonb, '[{"email":"support@acme.com"}]'::jsonb,
          '[]'::jsonb, '[]'::jsonb, 'Pricing question', 'Can you send pricing?', 'Can you send pricing?',
          false, false, '[]'::jsonb, 'inbound', now(), 'user', ${userId}, '[]'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `),
    )
    inboundMessageId = inboundMsg.id
  })

  afterAll(async () => {
    if (!orgId) return
    await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
    await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
  })

  describe("summarizeMailReply", () => {
    it("uses the conversation subject as title", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read", "mail:messages:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) => summarizeMailReply({ conversationId, textBody: "Hi Hans" }, { tx, orgId, userId }),
      )

      expect(result.title).toBe("Pricing question")
      expect(result.subtitle).toContain("Hans Weber")
      expect(result.subtitle).toContain("support@acme.com")
      expect(result.lines[0]).toContain("hans@acme.de")
      // No body-preview line — the full reply text is rendered by the approval
      // card's own Message block (sourced from the payload), not duplicated here.
      expect(result.lines.some((l) => l.includes("Hi Hans"))).toBe(false)
      expect(result.links?.[0]).toEqual({
        label: "Open conversation",
        app: "mail",
        entityType: "conversation",
        entityId: conversationId,
      })
    })

    it("recovers from_address even when stored as a JSON-encoded string (legacy seed)", async () => {
      // Seed a separate conversation whose latest message has a string-shaped
      // jsonb value — mirrors the corrupt-payload path that the QA seed produced
      // before sql.json() was used.
      const [legacyConv] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO app_mail.conversations (
            id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
            status, labels, is_read, is_starred, last_message_at, message_count
          )
          VALUES (
            gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-summarizer-legacy',
            'Legacy payload', 'msg', 'open', '[]'::jsonb, false, false, now(), 1
          )
          RETURNING id
        `),
      )
      // Double-encoded: the column holds a JSON string literal, not an object.
      await db.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
          is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers
        )
        VALUES (
          gen_random_uuid(), ${orgId}, ${legacyConv.id}, ${accountId}, '<legacy@test>', 'gmail-legacy-1',
          to_jsonb('{"email":"legacy@acme.de","name":"Legacy Lou"}'::text),
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Legacy', 'body', 'body', false, false,
          '[]'::jsonb, 'inbound', now(), 'user', ${userId}, '[]'::jsonb, '{}'::jsonb
        )
      `)

      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read", "mail:messages:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailReply(
            { conversationId: legacyConv.id, textBody: "ack" },
            { tx, orgId, userId },
          ),
      )

      expect(result.subtitle).toContain("Legacy Lou")
      expect(result.lines[0]).toBe("To: legacy@acme.de")
    })

    it("does not include a body-preview line even for a long body (Message block owns the text)", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read", "mail:messages:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailReply({ conversationId, textBody: "x".repeat(500) }, { tx, orgId, userId }),
      )

      expect(result.lines.some((l) => l.includes("x".repeat(50)))).toBe(false)
    })
  })

  describe("summarizeMailReply attachments", () => {
    const replyScopes = [
      "mail:conversations:read",
      "mail:accounts:read",
      "mail:messages:read",
      "kernel:files:read",
    ]

    it("lists an attachment from the same conversation with 📎 and no ⚠", async () => {
      const [file] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO kernel.files
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, disposition)
          VALUES (
            gen_random_uuid(), ${orgId}, 'mail', 'message', ${inboundMessageId},
            'same-thread.pdf', 'application/pdf', 1024,
            ${`orgs/${orgId}/mail/message/${inboundMessageId}/same/same-thread.pdf`}, 'attachment'
          )
          RETURNING id
        `),
      )
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: replyScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailReply(
            { conversationId, textBody: "Here you go", attachments: [file.id] },
            { tx, orgId, userId },
          ),
      )
      const line = result.lines.find((l) => l.includes("same-thread.pdf"))
      expect(line).toBeDefined()
      expect(line).toContain("📎")
      expect(line).not.toContain("⚠")
    })

    it("flags an attachment from a DIFFERENT conversation with ⚠", async () => {
      const [otherConv] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO app_mail.conversations (
            id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
            status, labels, is_read, is_starred, last_message_at, message_count
          )
          VALUES (
            gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-other-customer',
            'Other customer', 'msg', 'open', '[]'::jsonb, false, false, now(), 1
          )
          RETURNING id
        `),
      )
      const [otherMsg] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO app_mail.messages (
            id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
            from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
            is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers
          )
          VALUES (
            gen_random_uuid(), ${orgId}, ${otherConv.id}, ${accountId}, '<other@test>', 'gmail-other-1',
            '{"email":"other@acme.de"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            'Other', 'body', 'body', false, false, '[]'::jsonb, 'inbound', now(), 'user', ${userId},
            '[]'::jsonb, '{}'::jsonb
          )
          RETURNING id
        `),
      )
      const [file] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO kernel.files
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, disposition)
          VALUES (
            gen_random_uuid(), ${orgId}, 'mail', 'message', ${otherMsg.id},
            'other-customer.pdf', 'application/pdf', 1024,
            ${`orgs/${orgId}/mail/message/${otherMsg.id}/x/other-customer.pdf`}, 'attachment'
          )
          RETURNING id
        `),
      )
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: replyScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailReply(
            { conversationId, textBody: "x", attachments: [file.id] },
            { tx, orgId, userId },
          ),
      )
      const line = result.lines.find((l) => l.includes("other-customer.pdf"))
      expect(line).toBeDefined()
      expect(line).toContain("⚠")
    })

    it("renders an unresolved @ref attachment as a placeholder", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: replyScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailReply(
            {
              conversationId,
              textBody: "x",
              attachments: ["@ref:11111111-1111-4111-8111-111111111111:label_pdf"],
            },
            { tx, orgId, userId },
          ),
      )
      expect(result.lines.some((l) => l.includes("📎") && /step|earlier/i.test(l))).toBe(true)
    })
  })

  describe("summarizeMailForward", () => {
    const forwardScopes = [
      "mail:conversations:read",
      "mail:accounts:read",
      "mail:messages:read",
      "kernel:files:read",
    ]

    it("derives the Fwd: subject from the source message, shows recipient + lead-in note", async () => {
      // The forward summary resolves the SOURCE message (via the conversation) to
      // build the real Fwd:-prefixed subject + which mailbox it forwards via, and
      // surfaces the recipient and the lead-in note above the quoted original. The
      // carried attachment is listed via buildAttachmentSummaryLines (the same
      // file-origin mechanism the reply/compose summaries use); the faithful
      // attachment CARRYING is proven end-to-end by the handler test
      // (handlers.test.ts "re-sends the ORIGINAL inbound body + RE-ATTACHES …").
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: forwardScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailForward(
            {
              conversationId,
              to: ["sales@resonantaudio.example"],
              note: "Theo — can you quote this?",
            },
            { tx, orgId, userId },
          ),
      )
      expect(result.kind).toBe("mail.forward")
      // The latest inbound source subject is "Pricing question" → prefixed Fwd:.
      expect(result.title).toBe("Fwd: Pricing question")
      expect(result.subtitle).toContain("sales@resonantaudio.example")
      expect(result.lines.some((l) => l.includes("sales@resonantaudio.example"))).toBe(true)
      expect(result.lines.some((l) => l.includes("Theo — can you quote this?"))).toBe(true)
      // A "Forwarding: <original subject>" anchor line orients the reviewer.
      expect(result.lines.some((l) => l.includes("Forwarding: Pricing question"))).toBe(true)
      // Links back to the source conversation for review.
      expect(result.links?.[0]).toMatchObject({
        app: "mail",
        entityType: "conversation",
        entityId: conversationId,
      })
    })

    it("lists EXTRA attachments the caller added, not only the original's", async () => {
      const [extraMsg] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          WITH c AS (
            INSERT INTO app_mail.conversations (
              id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
              status, labels, is_read, is_starred, last_message_at, message_count
            )
            VALUES (
              gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-fwd-extra',
              'Extra source', 'x', 'open', '[]'::jsonb, false, false, now(), 1
            )
            RETURNING id
          )
          INSERT INTO app_mail.messages (
            id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
            from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
            is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers
          )
          SELECT
            gen_random_uuid(), ${orgId}, c.id, ${accountId}, '<fwd-extra@test>', 'gmail-fwd-extra',
            '{"email":"x@acme.de"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            'Extra source', 'body', 'body', false, false, '[]'::jsonb, 'inbound', now(),
            'user', ${userId}, '[]'::jsonb, '{}'::jsonb
          FROM c
          RETURNING id
        `),
      )
      const [file] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO kernel.files
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, disposition)
          VALUES (
            gen_random_uuid(), ${orgId}, 'mail', 'message', ${extraMsg.id},
            'forward-extra.png', 'image/png', 1024,
            ${`orgs/${orgId}/mail/message/${extraMsg.id}/x/forward-extra.png`}, 'attachment'
          )
          RETURNING id
        `),
      )
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: forwardScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailForward(
            { conversationId, to: ["sales@resonantaudio.example"], attachments: [file.id] },
            { tx, orgId, userId },
          ),
      )
      expect(result.lines.some((l) => l.includes("forward-extra.png"))).toBe(true)
    })

    it("prefixes Fwd: only once when the source subject already starts with Fwd:", async () => {
      // Forward a message whose subject is already a Fwd: — must not double-prefix.
      const [fwdMsg] = extractRows<{ id: string; conversationId: string }>(
        await db.execute(drizzleSql`
          WITH c AS (
            INSERT INTO app_mail.conversations (
              id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
              status, labels, is_read, is_starred, last_message_at, message_count
            )
            VALUES (
              gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-already-fwd',
              'Fwd: Already forwarded', 'fwd', 'open', '[]'::jsonb, false, false, now(), 1
            )
            RETURNING id
          )
          INSERT INTO app_mail.messages (
            id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
            from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
            is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers
          )
          SELECT
            gen_random_uuid(), ${orgId}, c.id, ${accountId}, '<already-fwd@test>', 'gmail-already-fwd',
            '{"email":"x@acme.de"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            'Fwd: Already forwarded', 'body', 'body', false, false, '[]'::jsonb, 'inbound', now(),
            'user', ${userId}, '[]'::jsonb, '{}'::jsonb
          FROM c
          RETURNING id, conversation_id AS "conversationId"
        `),
      )
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: forwardScopes,
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailForward(
            { conversationId: fwdMsg.conversationId, to: ["sales@resonantaudio.example"] },
            { tx, orgId, userId },
          ),
      )
      expect(result.title).toBe("Fwd: Already forwarded")
    })
  })

  describe("summarizeMailCompose", () => {
    it("links the To recipients' contacts, so the request is about them and their company", async () => {
      const [contact] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
        INSERT INTO kernel.contacts (org_id, handle, name, email, org_access)
        VALUES (${orgId}, 'tomoko-arai', 'Tomoko Arai', 'tomoko.arai@hanabi.example', 'editor')
        RETURNING id
      `),
      )
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read", "kernel:contacts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            {
              accountId,
              to: ["Tomoko.Arai@hanabi.example", "nobody@unknown.example"],
              subject: "Hello",
              textBody: "Hi Tomoko",
            },
            { tx, orgId, userId },
          ),
      )
      expect(result.links).toEqual([
        { label: "Tomoko Arai", app: "kernel", entityType: "contact", entityId: contact.id },
      ])
    })

    it("uses the subject as title and to-list as line[0]", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            { accountId, to: ["a@b.com", "c@d.com"], subject: "Hi", textBody: "Hello" },
            { tx, orgId, userId },
          ),
      )

      expect(result.title).toBe("Hi")
      expect(result.subtitle).toContain("support@acme.com")
      expect(result.lines[0]).toBe("To: a@b.com, c@d.com")
      // No body-preview line — the full message is rendered by the approval
      // card's own Message block (sourced from the payload), not duplicated here.
      expect(result.lines.length).toBe(1)
    })

    // BL-219 regression: accountId is OPTIONAL for compose (the tool tells the agent to omit it to send
    // from the org default), so a weak agent may omit it OR pass a hallucinated NON-UUID placeholder.
    // Pre-fix the summarizer ran a raw `WHERE id = ${accountId}` which threw Postgres "invalid input
    // syntax for type uuid" — and because the summarizer runs at the gated PROPOSE stage (before the
    // approval request), that surfaced to the agent as a bare "Tool execution failed" with NO draft,
    // sending a weak model into a give-up spiral. The summary must now degrade gracefully, never throw.
    it("does NOT throw on a non-uuid (hallucinated) accountId — degrades to the org mailbox", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            { accountId: "default-account-id", to: ["x@y.com"], subject: "Hey", textBody: "Body" },
            { tx, orgId, userId },
          ),
      )
      expect(result.kind).toBe("mail.compose")
      expect(result.title).toBe("Hey")
      expect(result.lines[0]).toBe("To: x@y.com")
      expect(result.lines.length).toBe(1)
    })

    // Regression (compose-modular-expo-followups-bcc): a "BCC me on every one so I have a record" compose
    // must SURFACE the BCC recipient in the approval summary — the reviewer (and the chaos judge) can only
    // confirm "Theo on BCC" if it is rendered. Pre-fix summarizeMailCompose dropped bcc entirely (only
    // To/Cc were shown), so the gated approval gave the judge no evidence of the BCC and the rubric clause
    // was unverifiable. The bcc lands on its OWN line, BEFORE the body.
    it("renders the bcc recipient on its own line when bcc is set", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            {
              accountId,
              to: ["dealer@tonwerk.example"],
              bcc: ["theo@resonant.example"],
              subject: "Following up after Modular Expo",
              textBody: "Great to meet you at the booth.",
            },
            { tx, orgId, userId },
          ),
      )
      expect(result.title).toBe("Following up after Modular Expo")
      expect(result.lines[0]).toBe("To: dealer@tonwerk.example")
      expect(result.lines[1]).toBe("Bcc: theo@resonant.example")
      // No body-preview line — see the identical note in the "to-list as line[0]" test above.
      expect(result.lines.length).toBe(2)
    })

    it("omits the bcc line entirely when no bcc is set", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            { accountId, to: ["a@b.com"], subject: "No bcc", textBody: "Body text" },
            { tx, orgId, userId },
          ),
      )
      expect(result.lines[0]).toBe("To: a@b.com")
      expect(result.lines.some((l) => l.startsWith("Bcc:"))).toBe(false)
      expect(result.lines.some((l) => l.includes("Body text"))).toBe(false)
    })

    it("does NOT throw when accountId is omitted entirely", async () => {
      const result = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read"],
          dimensionGrants: { "mail:inbox": [accountId] },
        },
        (tx) =>
          summarizeMailCompose(
            { to: ["x@y.com"], subject: "NoAcct", textBody: "Body" },
            { tx, orgId, userId },
          ),
      )
      expect(result.kind).toBe("mail.compose")
      expect(result.title).toBe("NoAcct")
      expect(result.lines[0]).toBe("To: x@y.com")
    })

    // Regression (compose-dealer-email-with-drive-spec-attachment): a NEW outbound email
    // that attaches a Drive-IMPORTED spec PDF must SURFACE the attachment's filename AND
    // its Drive ORIGIN ("from Google Drive") in the gated approval summary — the chaos
    // judge verifies the rubric clause "the attached 'Kestrel 6 Dealer Spec Sheet.pdf'
    // (filename + Drive origin in the attachment summary)" from THIS card, not the
    // transcript. A Drive import lands the bytes in a kernel.files row whose parent is a
    // `file_upload_session` with target_app='google-drive'; describeFileOrigin labels it
    // "Google Drive" (kind=source, so NEVER ⚠-flagged as a cross-conversation leak).
    //
    // The file-read uses a STUBBED tx (the `rlsWith` shape attach.test.ts uses): the
    // real kernel.files SELECT policy is rebuilt by DDL after manifest registration and
    // is not reconstructed in this isolated unit DB, so a live RLS read would see
    // nothing. Stubbing the single describeFileOrigin row keeps this an honest test of
    // summarizeMailCompose's attachment-line routing (filename + Drive-origin label +
    // no cross-conversation ⚠), the exact thing the rubric reads off the approval card.
    it("surfaces a Drive-imported attachment's filename + 'from Google Drive' origin (no ⚠)", async () => {
      const driveFileId = "11111111-2222-4333-8444-555555555555"
      const stubTx = {
        execute: async (..._args: unknown[]) => [
          {
            filename: "Kestrel 6 Dealer Spec Sheet.pdf",
            app: "kernel",
            entityType: "file_upload_session",
            entityId: "drive-import-session-1",
            sessionApp: "google-drive",
          },
        ],
      } as never

      const result = await summarizeMailCompose(
        {
          accountId,
          to: ["orders@emerald-city-audio.example"],
          subject: "Kestrel 6 dealer spec sheet",
          textBody: "Hi — great to connect. Attaching the Kestrel 6 dealer spec sheet.",
          attachments: [driveFileId],
        },
        { tx: stubTx, orgId, userId },
      )

      const line = result.lines.find((l) => l.includes("Kestrel 6 Dealer Spec Sheet.pdf"))
      expect(line).toBeDefined()
      expect(line).toContain("📎")
      expect(line).toContain("from Google Drive")
      expect(line).not.toContain("⚠")
    })
  })

  // ── Invariant K, Task 6.5: content-free approval summaries ─────────────────
  //
  // The approval `summary` is persisted in `kernel.approval_requests.summary`
  // AND embedded into a durable `kernel.pending_events` row by the approval
  // create path. For a compose or a forward the subject is user-typed plaintext,
  // so unlike an ingested subject this leak does NOT self-heal after the purge.
  // The approver still needs something actionable, so the title names the
  // mailbox, the correspondent and a short id, and never the content.
  describe("encrypted mailbox summaries", () => {
    let readyAccountId: string
    let readyConversationId: string
    let readyMessageId: string

    beforeAll(async () => {
      const [account] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
        INSERT INTO app_mail.accounts (
          id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
          sync_status, encryption_state
        )
        VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'user', ${userId}, 'gmail',
                'private@acme.com', 'active', 'ready')
        RETURNING id`),
      )
      readyAccountId = account.id
      const [conv] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
        INSERT INTO app_mail.conversations (
          id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
          status, labels, is_read, is_starred, last_message_at, message_count
        )
        VALUES (gen_random_uuid(), ${orgId}, ${readyAccountId}, 'user', ${userId},
                'thread-ready-1', 'ORACLENONCE pricing', 'ORACLENONCE preview', 'open',
                '[]'::jsonb, false, false, now(), 1)
        RETURNING id`),
      )
      readyConversationId = conv.id
      const [msg] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
          is_read, is_starred, labels, direction, sent_at, owner_type, owner_id,
          message_references, raw_headers
        )
        VALUES (gen_random_uuid(), ${orgId}, ${readyConversationId}, ${readyAccountId},
                '<ready-msg@test>', 'gmail-ready-1',
                '{"email":"nadia@example.test","name":"Nadia"}'::jsonb,
                '[{"email":"private@acme.com"}]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                'ORACLENONCE pricing', 'ORACLENONCE body', 'ORACLENONCE body',
                false, false, '[]'::jsonb, 'inbound', now(), 'user', ${userId},
                '[]'::jsonb, '{}'::jsonb)
        RETURNING id`),
      )
      readyMessageId = msg.id
    })

    const rls = <T>(fn: (tx: never) => Promise<T>) =>
      withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["mail:conversations:read", "mail:accounts:read", "mail:messages:read"],
          dimensionGrants: { "mail:inbox": ["*"] },
        },
        fn as never,
      ) as Promise<T>

    it("gives a reply on an encrypted mailbox a content-free title", async () => {
      const result = await rls((tx) =>
        summarizeMailReply(
          { conversationId: readyConversationId, textBody: "REPLYNONCE draft body" },
          { tx, orgId, userId } as never,
        ),
      )
      // Non-vacuity: the summary must still be actionable, or "no content" is
      // satisfied by an empty card the approver cannot act on.
      expect(result.title.length).toBeGreaterThan(0)
      expect(result.title).toContain("nadia@example.test")
      expect(result.title).toContain(readyConversationId.slice(0, 8))
      expect(JSON.stringify(result)).not.toContain("ORACLENONCE")
      expect(JSON.stringify(result)).not.toContain("REPLYNONCE")
    })

    it("gives a forward on an encrypted mailbox a content-free title and no note line", async () => {
      const result = await rls((tx) =>
        summarizeMailForward(
          {
            conversationId: readyConversationId,
            messageId: readyMessageId,
            to: [{ email: "carol@example.test" }],
            note: "FORWARDNOTENONCE please see below",
          },
          { tx, orgId, userId } as never,
        ),
      )
      expect(result.title.length).toBeGreaterThan(0)
      expect(result.subtitle).toContain("carol@example.test")
      expect(JSON.stringify(result)).not.toContain("ORACLENONCE")
      expect(JSON.stringify(result)).not.toContain("FORWARDNOTENONCE")
    })

    it("gives a compose from an encrypted mailbox a content-free title", async () => {
      const result = await rls((tx) =>
        summarizeMailCompose(
          {
            accountId: readyAccountId,
            to: [{ email: "dave@example.test" }],
            subject: "COMPOSESUBJECTNONCE quarterly plan",
            textBody: "COMPOSEBODYNONCE",
          },
          { tx, orgId, userId } as never,
        ),
      )
      expect(result.title.length).toBeGreaterThan(0)
      expect(result.title).toContain("dave@example.test")
      expect(JSON.stringify(result)).not.toContain("COMPOSESUBJECTNONCE")
      expect(JSON.stringify(result)).not.toContain("COMPOSEBODYNONCE")
    })

    it("still shows the subject for a mailbox that is not encrypted", async () => {
      // The discriminating half. A summariser that dropped every title would
      // pass all three assertions above and be wrong.
      const result = await rls((tx) =>
        summarizeMailReply({ conversationId, textBody: "Hi Hans" }, { tx, orgId, userId } as never),
      )
      expect(result.title).toBe("Pricing question")
    })
  })
})

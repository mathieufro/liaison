// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"
import { resolveToolTimeoutMs } from "~/modules/apps/run-limits"
import mailManifest from "./app.manifest.json"

// The app guide is a short core plus sections keyed by the tools they are
// about (app-guide.ts); these assertions read the whole guide.
type ManifestGuide = string | { core: string; sections?: Array<{ tools: string[]; text: string }> }
const guideText = (m: { agentInstructions?: unknown }): string => {
  const g = m.agentInstructions as ManifestGuide | undefined
  if (!g) return ""
  return typeof g === "string" ? g : [g.core, ...(g.sections ?? []).map((s) => s.text)].join("\n\n")
}

describe("mail app manifest validation", () => {
  it("declares the heading over its attention items, in the words and catalog key Home shows", () => {
    expect(mailManifest.attention.groupLabel).toEqual({
      label: "Mail",
      labelKey: "kernel.homeGroupMail",
    })
  })

  it("keeps the stopped-send attention item beside the heading in its one attention block", () => {
    const kinds = mailManifest.attention.translations.map((t) => t.kind)
    expect(kinds).toContain("mail:send_guard.stopped")
  })

  it("gives the sending tools a send sized budget, not the 5 s production default", () => {
    // A send with attachments (copy each file onto the message, MIME build,
    // provider round trip) passes 5 s; under the default an approved compose
    // was cut off mid send and parked as ambiguous.
    const tools = mailManifest.tools as unknown as Record<string, { timeoutMs?: number }>
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv
    for (const name of ["compose", "reply", "forward"]) {
      expect(resolveToolTimeoutMs(tools[name]!.timeoutMs, prod) ?? 5_000).toBeGreaterThanOrEqual(
        60_000,
      )
    }
  })

  it("keeps one pending reply draft per conversation, edited in place rather than stacked", () => {
    // Two replies staged on one conversation stacked two competing approvals. Keyed on the
    // conversation like tickets:reply on its ticket: the same requester's call restages its
    // waiting draft, anyone else's is refused naming the waiting one so the agent edits it.
    const reply = (mailManifest.tools as unknown as Record<string, Record<string, unknown>>).reply!
    expect(reply.approvalDedupeKeyParam).toBe("conversationId")
    expect(reply.approvalDedupeSameRequester).toBe(true)
    expect(String(reply.description)).toContain("kernel__approval_update_payload")
    expect(String(reply.description)).toContain("even when a colleague drafted it")
    const section = (
      mailManifest.agentInstructions as { sections: Array<{ tools: string[]; text: string }> }
    ).sections.find((s) => s.text.startsWith("ONE REPLY DRAFT PER CONVERSATION"))
    expect(section?.tools).toEqual(expect.arrayContaining(["reply", "read"]))
    expect(section?.text).toContain("kernel__approval_update_payload (requestId = its approvalId")
    expect(section?.text).toContain("Rewriting a colleague's draft is normal")
  })

  it("marks only the IMAP/SMTP servers, ports and username readable for the edit form, never the password", () => {
    const fields = (
      mailManifest as unknown as {
        connections: { imap: { credentialFields: Array<{ name: string; readable?: boolean }> } }
      }
    ).connections.imap.credentialFields
    expect(fields.filter((f) => f.readable === true).map((f) => f.name)).toEqual([
      "imapHost",
      "imapPort",
      "smtpHost",
      "smtpPort",
      "username",
    ])
    expect(mailManifest.version).toBe("1.13.3")
  })

  it("passes manifest validation", () => {
    const result = validateAppManifest(mailManifest)
    expect(result.success).toBe(true)
  })

  it("steers contactId-scoped mail (not blind free-text) for a named person/company's full picture, and that an empty name query is NOT proof of no email", () => {
    // Affordance for the dealer-360 / complaint-lookup class (angry-vip-dealer-tonwerk-escalation):
    // a weak model free-text-searched a dealer name, got empty, and concluded "I could not find their
    // email" — missing the seeded complaint. The instruction must (a) cover the complaint/360/full-picture
    // trigger, not just "thread history", and (b) say plainly that an empty name query does NOT prove
    // absence — resolve the contact and re-search by contactId first.
    const ai = guideText(mailManifest)
    expect(ai).toMatch(/full picture.{0,12}360/i)
    expect(ai).toMatch(/complaint/i)
    expect(ai).toMatch(/contactId/)
    expect(ai).toMatch(/EMPTY result from a free-text NAME query does NOT prove/i)
  })

  it("the send check's value is the server's on compose and reply, and a chained step builds it at execute", () => {
    const tools = mailManifest.tools as Record<string, Record<string, any>>
    for (const name of ["compose", "reply"]) {
      expect(tools[name]?.pinnedParams).toEqual(["sendGuard", "guardKey"])
      expect(tools[name]?.pinnedOptionalOnRefs).toBe(true)
      expect(Object.keys(tools[name]?.params.properties)).toEqual(
        expect.arrayContaining(["followUp", "sendGuard", "guardKey"]),
      )
    }
    expect(tools.compose?.approvalDedupeKeyParam).toBe("guardKey")
    expect(tools.compose?.approvalDedupeSameRequester).toBe(true)
    // No editable field reaches the check's value.
    for (const name of ["compose", "reply"]) {
      for (const field of tools[name]?.editableFields ?? []) {
        expect(String(field.field)).not.toMatch(/^(?:sendGuard|guardKey)/)
      }
    }
  })

  it("listAccounts says it lists what this person can use, not what the org has", () => {
    // "No mailbox is connected to the organisation", to a person whose org has five.
    const desc = (mailManifest.tools as any).listAccounts.description as string
    expect(desc).toContain("this person can use")
    expect(desc).not.toContain("connected to this org")
  })

  it("requires compose accountId (no shared-box default) and steers a user writing as themselves to their own mailbox", () => {
    // A user's agent omitted accountId on a personal email and it went out from contact@.
    const params = (mailManifest.tools as any).compose.params
    expect(params.required).toContain("accountId")
    const desc = params.properties.accountId.description as string
    expect(desc).toMatch(/there is no default/)
    expect(desc).toMatch(/listAccounts/)
    expect(desc).toMatch(/ownerType is 'user'/)
  })

  it("teaches that compose is NOT a broadcast/mass-send/segment primitive (no per-recipient templating)", () => {
    // Affordance for the recall-comms / mass-outreach class (crisis-bricked-firmware-recall-end-to-end-
    // recovery-partial, backorder-comms-on-confirmed-oversell): a weak model read compose's `to: [array]`
    // as a broadcast tool and collapsed "send the recall to all affected customers" into ONE multi-
    // recipient compose with un-interpolated {{firstName}} placeholders — leaking recipients to each other
    // and skipping the honest "there is no mass-send primitive" arm the rubric requires. The compose tool
    // description must state plainly that it sends ONE shared message to the literal envelope (no per-
    // recipient personalization / mail-merge / segment), so a multi-customer personalized outreach is N
    // separate gated per-recipient sends — OR flagged as not batch-sendable when it exceeds the budget.
    const desc = (mailManifest.tools as Record<string, { description: string }>).compose.description
    expect(desc).toMatch(/NOT A BROADCAST|mass-send|segment/i)
    expect(desc).toMatch(/per-recipient/i)
    // Names the verbatim-template-variable failure (the {{…}} placeholder is sent uninterpolated).
    expect(desc).toMatch(/\{\{firstName\}\}|interpolat/i)
    // Prescribes the correct shape: N separate gated sends, or flag as not batch-sendable.
    expect(desc).toMatch(
      /N separate|one .*per (customer|recipient)|out of reach for a single blast/i,
    )
    // ALSO in agentInstructions (always-on orientation, not behind skill discovery — a weak model that
    // never loads a skill still reads this when mail is active): the no-mass-send honesty must be here too.
    const ai = guideText(mailManifest)
    expect(ai).toMatch(/NO MASS-SEND|no broadcast|no .*segment/i)
    expect(ai).toMatch(/per-recipient/i)
    expect(ai).toMatch(
      /out of reach for a single blast|one compose or reply per customer|N separate/i,
    )
  })

  it("teaches the compose attachments param: import a Drive file to a fileId, then pass it in attachments (compose-dealer-email-with-drive-spec-attachment)", () => {
    // compose-dealer-email-with-drive-spec-attachment: the weak model imported the Drive spec PDF (got a
    // real kernel fileId), then called mail__compose with ONLY {to, subject, textBody} — OMITTING the
    // attachments array — and fabricated "attached" in chat. The gated approval card then showed no
    // attachment, so the rubric's "attached filename + Drive origin" clause failed. The fix is an
    // affordance one: the compose `attachments` param description must make the import→fileId→attachments
    // wiring explicit (with the imported-fileId example) and forbid claiming a file is attached unless its
    // id is in this array. Without this the model drops the attachment; with it, it wires the fileId.
    const attachParam = (
      mailManifest.tools as unknown as Record<
        string,
        { params: { properties: { attachments: { description: string } } } }
      >
    ).compose.params.properties.attachments
    expect(attachParam.description).toMatch(/google-drive__import/)
    // Names the import-first requirement (a raw Drive id/URL is not a kernel fileId).
    expect(attachParam.description).toMatch(
      /import first|materialize|raw Drive file id\/URL is NOT/i,
    )
    // Shows the wiring example: attachments:["<fileId from google-drive__import>"].
    expect(attachParam.description).toMatch(/attachments:\["<fileId from google-drive__import>"\]/)
    // Forbids claiming an attachment that is not in the array (the fabrication guard).
    expect(attachParam.description).toMatch(
      /never claim a file is attached unless its id is in THIS array/i,
    )
  })

  it("teaches the reply attachments param: source a prepared return label via files_list on the boxtal shipment (draft-rma-reply-with-return-label-attach)", () => {
    // draft-rma-reply-with-return-label-attach: the weak model located Mason's return shipment but never
    // resolved the label's kernel fileId — it called mail__reply with ONLY {conversationId, textBody}, no
    // attachments, then falsely told the customer it "attached the return shipping label" (run 5bddfdab).
    // The fix is an affordance one: the reply `attachments` param must teach the cross-app label-attach
    // path (find the shipment → files_list(boxtal, shipment, id) → pass that fileId) and forbid claiming
    // an attachment unless its id is in this array.
    const attachParam = (
      mailManifest.tools as unknown as Record<
        string,
        { params: { properties: { attachments: { description: string } } } }
      >
    ).reply.params.properties.attachments
    // Names files_list as the source for an existing kernel file (incl. a prepared shipping label).
    expect(attachParam.description).toMatch(/files_list/)
    expect(attachParam.description).toMatch(/return label|shipping.*label|RETURN LABEL/i)
    // The cross-app path: the label is parented to its Boxtal shipment; files_list(boxtal, shipment, id).
    expect(attachParam.description).toMatch(/entityType='shipment'/)
    expect(attachParam.description).toMatch(/boxtal/)
    // Anti-fabrication: never claim attached unless its id is in THIS array.
    expect(attachParam.description).toMatch(
      /never tell the user you 'attached' a file unless its id is in this `attachments` array/i,
    )
  })

  it("teaches the convertToTicket note param to gather a looked-up data finding FIRST and capture the real figure in the note, not only in chat (priya-dealer-stock-leadtime-route-to-sales)", () => {
    // priya-dealer-stock-leadtime-route-to-sales: "convert the dealer email to a ticket, check current
    // RAL-44 inventory in Shopify, and add a note routing the 25-unit quote to Theo." A baseline run
    // (45057a6f) FAILED because the agent converted the email with a note that ONLY routed to Theo and
    // was written BEFORE the inventory lookup ran — so the verified on-hand figure landed only in the
    // ephemeral chat reply, never on the ticket the rubric requires ("a note contains the real RAL-44
    // on-hand quantity from Shopify AND routes the 25-unit quote to Theo"). The note guidance was
    // warranty-RMA-specific (order# + purchase date + eligibility) and did NOT generalize the principle:
    // when the user asked you to CAPTURE A LOOKED-UP DATA FINDING (a stock level, a status, an amount)
    // into the note, gather the finding FIRST then put the actual figure in the note (or add it via a
    // follow-up tickets__addNote if you already converted). This regression pins that generalized
    // guidance so a future edit cannot silently drop it back to warranty-only.
    const noteParam = (
      mailManifest.tools as unknown as Record<
        string,
        { params: { properties: { note: { description: string } } } }
      >
    ).convertToTicket.params.properties.note
    // Generalizes beyond warranty to ANY looked-up data finding the user asked to capture.
    expect(noteParam.description).toMatch(
      /CAPTURE A LOOKED-UP DATA FINDING|on-hand\/inventory STOCK level/i,
    )
    // Names the gather-FIRST ordering (run the lookup before writing the note).
    expect(noteParam.description).toMatch(/GATHER THAT FINDING FIRST/i)
    // The note must contain the real figure, not just the routing line.
    expect(noteParam.description).toMatch(
      /note must contain the real figure, not just the routing line/i,
    )
    // The follow-up-addNote fallback when the convert preceded the lookup.
    expect(noteParam.description).toMatch(
      /ALREADY converted before you had the figure[\s\S]*follow-up tickets__addNote/i,
    )
    // Anti-only-in-chat: the figure stated only in chat does not count as recorded.
    expect(noteParam.description).toMatch(/never only in chat/i)
  })

  it("teaches the multi-touch outreach / follow-up sequence honest decomposition (dealer-outreach-sequence-impossible)", () => {
    // dealer-outreach-sequence-impossible: "send touch-1 today, and if they don't reply auto-send touch-2
    // in 3 days, touch-3 in 7 days". At baseline the weak model OVER-CORRECTED to the STALE answer
    // ("I cannot perform automated reply-detection / there is no outreach campaign primitive") and dropped
    // the follow-up entirely — exactly the FAIL the rubric forbids (mail__search now supports from:+since:,
    // so reply detection by sender IS doable). The always-on agentInstructions must teach the split: no
    // drip engine + nothing auto-sends, BUT reply detection by sender is doable via mail__search(from/since)
    // inside a day-3/day-7 routine that drafts the next touch as a GATED compose, plus the 4 disclosures.
    const ai = guideText(mailManifest)
    expect(ai).toMatch(/MULTI-TOUCH OUTREACH/)
    expect(ai).toMatch(/HONEST-DECOMPOSITION/)
    // No drip engine + nothing auto-sends (the over-claim guard).
    expect(ai).toMatch(/no outreach-sequence\/drip engine/)
    expect(ai).toMatch(/NEVER tell the user 'the drip is scheduled/)
    // Reply detection by sender IS doable — never assert it is impossible (the stale-answer guard).
    expect(ai).toMatch(/REPLY DETECTION BY SENDER IS DOABLE[,:] DO NOT assert it is impossible/)
    expect(ai).toMatch(/mail__search supports `from:<prospect-email>` \+ `since:<touch-1 date>`/)
    // The correct build: gated touch-1 now + day-3/day-7 reply-check routines drafting the next gated touch.
    expect(ai).toMatch(/draft touch-1 NOW as a SINGLE GATED mail__compose/)
    expect(ai).toMatch(/mail__search\(from:<that prospect>, since:<touch-1 date>\)/)
    expect(ai).toMatch(
      /ONLY IF no reply is found drafts the next touch as ANOTHER GATED mail__compose/,
    )
    // The 4 disclosures.
    expect(ai).toMatch(/reply-AWARE REMINDER APPROXIMATION/)
    expect(ai).toMatch(/SCHEDULE'S CADENCE.*NOT a real-time/)
    expect(ai).toMatch(/BOUNDED mail__search by sender\+date \(scan-capped\)/)
  })

  it("declares gmail oauth2 connection with extraParams", () => {
    expect(mailManifest.connections.gmail.type).toBe("oauth2")
    expect(mailManifest.connections.gmail.extraParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    })
  })

  it("declares ONE settings page (accounts, mailbox types, Google client) and no views.settings", () => {
    const m = mailManifest as unknown as {
      kind?: string
      settings: {
        sections: Array<{ id: string; scope: string; adminScope?: string; blocks: any[] }>
      }
      views: Record<string, unknown>
      tools: Record<string, any>
    }
    expect(m.kind).toBe("app")
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => [s.id, s.scope, s.adminScope ?? null])).toEqual([
      ["accounts", "user", null],
      ["providers", "org", "mail:accounts:admin"],
      // The Google client is the kernel integration: kernel:org:admin, never widened.
      ["google-client", "org", "kernel:org:admin"],
    ])
    const toggle = m.settings.sections[1].blocks[0]
    expect(toggle).toMatchObject({
      block: "field",
      key: "gmail",
      type: "toggle",
      source: { tool: { get: "providers.get", set: "providers.set" } },
    })
    // The pair mirrors GET/PATCH /api/mail/providers, for the page only.
    expect(m.tools["providers.get"]).toMatchObject({
      readOnly: true,
      agentVisible: false,
      requiredScopes: ["mail:accounts:read"],
    })
    expect(m.tools["providers.get"].gated).toBeUndefined()
    expect(m.tools["providers.set"]).toMatchObject({
      agentVisible: false,
      requiredScopes: ["mail:accounts:admin"],
    })
    expect(m.settings.sections[2].blocks[0]).toMatchObject({
      block: "custom",
      component: "GoogleClientCard",
    })
  })

  it("declares imap credentials connection with empty allowedDomains", () => {
    expect(mailManifest.connections.imap.type).toBe("credentials")
    expect(mailManifest.connections.imap.allowedDomains).toEqual([])
  })

  it("declares accounts schema with constraints and indexes", () => {
    expect(mailManifest.schema.accounts.constraints.unique).toEqual([["emailAddress"]])
    expect(mailManifest.schema.accounts.indexes).toEqual([["syncStatus"], ["connectedAccountId"]])
  })

  it("declares inbox dimension as plain membership (no selfRef or ownership keys)", () => {
    expect(mailManifest.schema.accounts.dimensions.inbox.type).toBe("membership")
    expect((mailManifest.schema.accounts.dimensions.inbox as any).selfRef).toBeUndefined()
    expect((mailManifest.schema.accounts.dimensions.inbox as any).ownership).toBeUndefined()
  })

  it("declares on-demand jobs", () => {
    expect(mailManifest.jobs["gmail-initial-sync"].onDemand).toBe(true)
    expect(mailManifest.jobs["gmail-initial-sync"].handler).toBe("gmailInitialSync")
    expect(mailManifest.jobs["gmail-write-back"].onDemand).toBe(true)
    expect(mailManifest.jobs["gmail-write-back"].handler).toBe("gmailWriteBack")
  })

  it("subscribes to kernel connected_account events", () => {
    expect(mailManifest.events.subscribes["kernel/connected_account:create"]).toBe(
      "onAccountConnected",
    )
    expect(mailManifest.events.subscribes["kernel/connected_account:disconnect"]).toBe(
      "onAccountDisconnected",
    )
  })

  // Mail access is the inbox membership alone. A "sensitivity" level was
  // declared here but no mail row carries one and no policy or code read it,
  // so the access screen offered a setting that did nothing (removed with
  // migration 0119, which deletes the grants it left).
  it("declares the inbox dimension and nothing else", () => {
    expect(Object.keys(mailManifest.schema.accounts.dimensions)).toEqual(["inbox"])
  })
})

describe("mail manifest: sync state and conversation entity additions", () => {
  it("declares syncState field on accounts", () => {
    expect(mailManifest.schema.accounts.fields.syncState).toBe("json?")
  })

  it("declares conversations entity with required fields", () => {
    const conv = mailManifest.schema.conversations
    expect(conv).toBeDefined()
    expect(conv.fields.accountId).toBe("uuid")
    expect(conv.fields.ownerType).toBe("string")
    expect(conv.fields.ownerId).toMatchObject({
      type: "uuid",
      userRef: true,
      onErase: "delete",
    })
    expect(conv.fields.externalThreadId).toBe("string")
    expect(conv.fields.subject).toBe("string?")
    expect(conv.fields.snippet).toBe("string?")
    expect(conv.fields.contactId).toBe("uuid?")
    expect(conv.fields.assignedTo).toBe("uuid?")
    expect(conv.fields.status).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["open", "trashed", "escalated"]),
    })
    expect(conv.fields.labels).toBe("json")
    expect(conv.fields.isRead).toBe("boolean")
    expect(conv.fields.isStarred).toBe("boolean")
    expect(conv.fields.internalThreadId).toBe("uuid?")
    expect(conv.fields.lastMessageAt).toBe("date?")
    expect(conv.fields.messageCount).toBe("integer")
  })

  it("declares conversations unique constraint on accountId + externalThreadId", () => {
    expect(mailManifest.schema.conversations.constraints.unique).toContainEqual([
      "accountId",
      "externalThreadId",
    ])
  })

  it("declares conversations inbox dimension", () => {
    expect(mailManifest.schema.conversations.dimensions.inbox.type).toBe("membership")
  })

  it("declares messages entity with required fields", () => {
    const msg = mailManifest.schema.messages
    expect(msg).toBeDefined()
    expect(msg.fields.conversationId).toBe("uuid")
    expect(msg.fields.accountId).toBe("uuid")
    expect(msg.fields.externalMessageId).toBe("string?")
    expect(msg.fields.externalProviderId).toBe("string?")
    expect(msg.fields.ownerType).toBe("string")
    expect(msg.fields.ownerId).toMatchObject({
      type: "uuid",
      userRef: true,
      onErase: "delete",
    })
    expect(msg.fields.fromAddress).toBe("json")
    expect(msg.fields.toAddresses).toBe("json")
    expect(msg.fields.direction).toBe("string")
    expect(msg.fields.sentAt).toBe("date?")
  })

  it("declares messages unique constraint on accountId + externalMessageId", () => {
    expect(mailManifest.schema.messages.constraints.unique).toContainEqual([
      "accountId",
      "externalMessageId",
    ])
  })

  it("declares gmail-watch-renewal job", () => {
    expect(mailManifest.jobs["gmail-watch-renewal"]).toBeDefined()
    expect(mailManifest.jobs["gmail-watch-renewal"].schedule).toBeTruthy()
  })

  it("declares new emitted events", () => {
    expect(mailManifest.events.emits).toContain("conversation:create")
    expect(mailManifest.events.emits).toContain("conversation:update")
    expect(mailManifest.events.emits).toContain("conversation:delete")
    expect(mailManifest.events.emits).toContain("message:create")
  })

  it("subscribes to kernel/contact:merge", () => {
    expect(mailManifest.events.subscribes["kernel/contact:merge"]).toBe("onContactMerge")
  })

  it("declares timeline for conversations, and never the subject", () => {
    expect(mailManifest.schema.conversations.timeline).toContain("status")
    // `subject` was removed in Task 4.1. That array is the SOURCE of the
    // timeline entry that would otherwise render "changed subject from X to Y",
    // which is mail content in a control-plane table (Invariant K). The renderer
    // side is the second line of defence, not the first.
    expect(mailManifest.schema.conversations.timeline).not.toContain("subject")
  })

  it("declares timeline for accounts", () => {
    expect(mailManifest.schema.accounts.timeline).toContain("syncStatus")
  })
})

describe("mail manifest — entities.conversation", () => {
  it("declares the conversation entity as searchable with the expected read scope + index/permission fields", () => {
    const conv = (mailManifest.entities as any).conversation
    expect(conv.searchable).toBe(true)
    expect(conv.tableName).toBe("conversations")
    expect(conv.readScope).toBe("mail:conversations:read")
    expect(conv.indexFields).toEqual({ title: "subject", labelSecondary: "from_email" })
    expect(conv.permissionFields.participantIdsField).toBe("owner_id")
  })
})

describe("mail manifest — sidebar assignment", () => {
  it("all tab types reference MailSidebar", () => {
    const tabTypes = mailManifest.views.tabTypes as Record<string, { sidebar?: string }>
    for (const [type, reg] of Object.entries(tabTypes)) {
      expect(reg.sidebar, `${type} should have sidebar`).toBe("MailSidebar")
    }
  })
})

describe("mail manifest 5D additions", () => {
  it("messages schema declares sentByUserId field", () => {
    const messages = (mailManifest.schema as any).messages
    expect(messages.fields.sentByUserId).toMatchObject({
      type: "uuid",
      userRef: true,
      onErase: "anonymize",
    })
  })

  it("drafts schema declares sentByUserId field", () => {
    const drafts = (mailManifest.schema as any).drafts
    expect(drafts.fields.sentByUserId).toMatchObject({
      type: "uuid",
      userRef: true,
      onErase: "anonymize",
    })
  })

  it.each([
    ["search", "mail:conversations:read", false],
    ["read", "mail:conversations:read", false],
    ["reply", "mail:conversations:write", true],
    ["compose", "mail:conversations:write", true],
    ["forward", "mail:conversations:write", true],
  ])("declares tool %s with scope %s gated=%s", (name, scope, gated) => {
    const tool = (mailManifest.tools as any)[name]
    expect(tool).toBeDefined()
    expect(tool.requiredScopes).toEqual([scope])
    expect(tool.gated ?? false).toBe(gated)
    expect(typeof tool.handler).toBe("string")
    expect(tool.description.length).toBeGreaterThan(20)
    expect(tool.params).toBeDefined()
  })

  it("declares mail:message:create event with sentByUserId payload", () => {
    expect((mailManifest.events as any).emits).toContain("message:create")
  })

  it("declares summarizers for gated send tools", () => {
    expect((mailManifest.tools as any).reply.summarizer).toBe("summarizeMailReply")
    expect((mailManifest.tools as any).compose.summarizer).toBe("summarizeMailCompose")
    expect((mailManifest.tools as any).forward.summarizer).toBe("summarizeMailForward")
  })

  it("the forward tool teaches it carries the original body + attachments (BL forward primitive)", () => {
    // forward-dealer-quote-email-attachment: a weak model otherwise invents a fake
    // mail__forward, or composes WITHOUT re-attaching the PDF (dropping it). The
    // forward description must promise it re-sends the ORIGINAL body AND attachments
    // automatically (so the agent does NOT hunt the file id), prefixes Fwd:, is
    // gated (queued, not sent), and forwards by conversationId + a real `to`.
    const tool = (mailManifest.tools as any).forward
    expect(tool.description).toMatch(/attachment/i)
    expect(tool.description).toMatch(/Fwd:/)
    expect(tool.description).toMatch(/QUEUED for approval/i)
    expect(tool.description).toMatch(/never that it was sent/i)
    expect(tool.params.required).toEqual(["conversationId", "to"])
    // The original's attachments are carried automatically, so the agent cannot
    // drop them by forgetting a param. The optional `attachments` only ADDS files
    // (a local upload, a Drive import) and says so; the handler merges, never replaces.
    expect(tool.params.required).not.toContain("attachments")
    expect(tool.params.properties.attachments.description).toMatch(/on top of the original/i)
    expect(tool.params.properties.attachments.description).toMatch(/always carry over/i)
  })

  it("declares export_conversations as an UNGATED read-to-file tool scoped mail:conversations:read (BL-264)", () => {
    // BL-264: the audit-bundle export-to-file capability the quarterly dealer-
    // correspondence ask needs. It compiles a SCOPED conversation set into ONE
    // kernel.files artifact and returns a fileId. It is a read-to-file — it sends
    // nothing and mutates no business state — so it must be UNGATED and scoped
    // mail:conversations:read (exactly like search/read), and its scope params
    // must mirror search so the bundle == what search would return.
    const tool = (mailManifest.tools as any).export_conversations
    expect(tool).toBeDefined()
    expect(tool.requiredScopes).toEqual(["mail:conversations:read"])
    expect(tool.gated ?? false).toBe(false)
    expect(tool.handler).toBe("exportConversations")
    // Scope params mirror mail__search (the integrity contract: same scope → same set).
    for (const p of [
      "contactId",
      "accountId",
      "status",
      "from",
      "since",
      "until",
      "body",
      "query",
    ]) {
      expect(tool.params.properties[p], `export_conversations must accept ${p}`).toBeDefined()
    }
    // format enum offers a deterministic CSV (default) and a markdown digest.
    expect(tool.params.properties.format.enum).toEqual(["csv", "markdown"])
    // The description must teach the export-to-file affordance (so a weak model
    // stops saying 'no export tool exists') and the per-contactId quarter shape.
    expect(tool.description).toMatch(/downloadable file|fileId/i)
    expect(tool.description).toMatch(/since.*until|quarter/i)
    // It must NOT be marked a taint source (it writes a file; it returns no
    // externally-authored body for the model to act on).
    expect(tool.taintSource ?? false).toBe(false)
  })

  it("agentInstructions teach the export-to-file audit-bundle path (BL-264)", () => {
    const ai = guideText(mailManifest)
    expect(ai).toContain("mail__export_conversations")
    // The quarter-scope shape: per dealer contactId + since/until.
    expect(ai).toMatch(/contactId, since=<quarter-start ISO>, until=<quarter-end ISO>/)
    // And the anti-stale steer: do NOT say there is no export tool.
    expect(ai).toMatch(/do NOT say 'there is no export tool'/i)
  })

  it("inbound-content read tools (search/read) declare taintSource; send tools do not", () => {
    // mail__search/mail__read return externally-authored inbound message bodies +
    // snippets — reading them must mark the thread tainted (containment story).
    // The gated send tools and account-status reads return no external content.
    const tools = mailManifest.tools as Record<string, { taintSource?: boolean }>
    expect(tools.search.taintSource).toBe(true)
    expect(tools.read.taintSource).toBe(true)
    for (const id of ["reply", "compose", "listAccounts", "getSyncStatus"]) {
      expect(tools[id]?.taintSource ?? false, `${id} must NOT declare taintSource`).toBe(false)
    }
  })
})

describe("mail manifest — gated-reply affordance (BL-52 paste-and-ask + BL-54 wrong-tool)", () => {
  it("agentInstructions steer mail-conversation replies to mail__reply, not tickets__reply", () => {
    const ai = guideText(mailManifest)
    // BL-54: a weak model replied to a mail conversation via tickets__reply (ticketId = a mail
    // conversation id) → 'ticket not found'. The instruction must name mail__reply as the reply path
    // and warn off tickets__reply for mail conversations.
    expect(ai).toContain("mail__reply")
    expect(ai).toContain("tickets__reply")
    expect(ai.toLowerCase()).toContain("ticket not found")
    // BL-52: must say to CALL the tool to propose, not paste-and-ask. The manifest phrases this
    // mid-sentence ("…with your drafted body; never paste a draft into chat and ask whether to
    // send."), so match the actual lowercase prose rather than a capitalized variant that never
    // existed in the manifest.
    expect(ai).toContain("never paste a draft into chat")
  })

  it("agentInstructions steer the cross-mailbox VIP/dealer SEGMENT sweep (BL-253)", () => {
    const ai = guideText(mailManifest)
    const lower = ai.toLowerCase()
    // multi-account-unified-vip-sweep: the agent must (1) enumerate accounts, (2) resolve the segment
    // via contacts_search by name/company AND tag (vip/dealer), (3) per-contact mail__search(status=open)
    // across all mailboxes, (4) MERGE + ATTRIBUTE each thread to its source mailbox. Without this steer a
    // weak model dribbled a fragmented, unattributed, single-account list (the parked floor).
    expect(lower).toContain("vip/dealer sweep")
    expect(ai).toContain("mail__listAccounts")
    expect(ai).toContain("contacts_search(tag:'vip')")
    expect(ai).toContain("contacts_search(tag:'dealer')")
    expect(ai).toContain("mail__search(contactId, status:'open')")
    // It must demand a merged, source-attributed list (not a generic "all open conversations" pile).
    expect(lower).toContain("attribute each conversation to its source mailbox")
    expect(lower).toContain("both mailboxes must be represented")
  })

  it("ships the draft-mail-reply skill that forces calling the gated mail__reply", () => {
    const skill = (mailManifest.skills as any)["draft-mail-reply"]
    expect(skill).toBeDefined()
    expect(skill.enabledByDefault).toBe(true)
    // The procedure must require CALLING mail__reply (the gated propose step), warn off paste-and-ask,
    // and warn off tickets__reply for a mail conversation.
    expect(skill.body).toContain("CALLING `mail__reply`")
    expect(skill.body.toLowerCase()).toContain("does not send")
    expect(skill.body).toContain("tickets__reply")
  })
})

describe("mail manifest: Gmail Primary on search (S13)", () => {
  it("search takes category primary|other|all and says it defaults to primary on personal Gmail", () => {
    const search = (mailManifest as any).tools.search
    expect(search.params.properties.category.enum).toEqual(["primary", "other", "all"])
    expect(search.description).toMatch(/category.*defaults to `?primary`? on personal Gmail/i)
    expect(search.description).toMatch(/`?all`? to include newsletters/i)
  })
})

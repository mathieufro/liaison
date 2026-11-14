// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"
import { generateSequenceDdl, generateTableDdl } from "~/modules/apps/ddl"
import { resolveToolTimeoutMs } from "~/modules/apps/run-limits"
import ticketsManifest from "./app.manifest.json"

// The app guide is a short core plus sections keyed by the tools they are
// about (app-guide.ts); these assertions read the whole guide.
type ManifestGuide = string | { core: string; sections?: Array<{ tools: string[]; text: string }> }
/** A tool's description, then every guide section naming it: what the model reads while the tool
 *  is loaded. A description's text past its first 600 characters reads from such a section. */
const toolText = (m: { tools?: unknown; agentInstructions?: unknown }, tool: string): string => {
  const def = (m.tools as Record<string, { description?: string }> | undefined)?.[tool]
  const g = m.agentInstructions as
    | { sections?: Array<{ tools: string[]; text: string }> }
    | string
    | undefined
  const sections =
    g && typeof g === "object" ? (g.sections ?? []).filter((s) => s.tools.includes(tool)) : []
  return [def?.description ?? "", ...sections.map((s) => s.text)].join("\n\n")
}

const guideText = (m: { agentInstructions?: unknown }): string => {
  const g = m.agentInstructions as ManifestGuide | undefined
  if (!g) return ""
  return typeof g === "string" ? g : [g.core, ...(g.sections ?? []).map((s) => s.text)].join("\n\n")
}

describe("tickets manifest", () => {
  it("draws a ticket as an entity card and the open backlog as a number card, from fields the tools return", () => {
    const tools = ticketsManifest.tools as unknown as Record<
      string,
      {
        returns?: { schema?: Record<string, string> }
        resultCard?: { kind?: string }
        runningLabel?: string
        runningLabelKey?: string
      }
    >
    expect(tools.get?.resultCard?.kind).toBe("entity")
    expect(tools.backlogHealth?.resultCard?.kind).toBe("number")
    expect(Object.keys(tools.get?.returns?.schema ?? {})).toEqual(["ticket", "messages"])
    expect(Object.keys(tools.backlogHealth?.returns?.schema ?? {})).toContain("byStatus")
    expect(tools.get?.runningLabelKey).toBe("tickets.card.runningGet")
    expect(tools.backlogHealth?.runningLabelKey).toBe("tickets.card.runningBacklog")
    // 1.2.11: ticket and backlog results draw as cards.
    expect(ticketsManifest.version).toBe("1.4.0")
    expect(validateAppManifest(ticketsManifest).success).toBe(true)
  })

  it("declares the heading over its attention items, in the words and catalog key Home shows", () => {
    expect(ticketsManifest.attention.groupLabel).toEqual({
      label: "Support",
      labelKey: "kernel.homeGroupSupport",
    })
  })

  it("gives the email sending tools a send sized budget, not the 5 s production default", () => {
    // A reply with a PDF (fetch from storage, MIME build, SMTP round trip)
    // routinely passes 5 s. Under the default the sandbox reported "App
    // execution timed out" while the host send went on and delivered.
    const tools = ticketsManifest.tools as unknown as Record<string, { timeoutMs?: number }>
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv
    for (const name of ["reply", "nudge", "close"]) {
      expect(resolveToolTimeoutMs(tools[name]!.timeoutMs, prod) ?? 5_000).toBeGreaterThanOrEqual(
        60_000,
      )
    }
  })

  it("declares cc on the reply tool", () => {
    const reply = (
      ticketsManifest.tools as unknown as Record<
        string,
        { params: { properties: Record<string, { type: string }> } }
      >
    ).reply!
    expect(reply.params.properties.cc?.type).toBe("array")
  })

  it("teaches addNote to capture a looked-up data finding (stock/status/amount) + routing into the note, not only in chat (priya-dealer-stock-leadtime-route-to-sales)", () => {
    // priya-dealer-stock-leadtime-route-to-sales: the durable-record fallback when a convert preceded
    // the inventory lookup. A baseline run left the verified RAL-44 on-hand figure only in chat. The
    // addNote description (previously the bare "Append an internal note") must teach the capture-finding
    // pattern so the agent records the real figure + routing on the ticket the teammate (Theo/sales)
    // reads. Pins the guidance so it cannot regress back to the bare one-liner.
    const addNote = (ticketsManifest.tools as unknown as Record<string, { description: string }>)
      .addNote
    expect(addNote.description).toMatch(/CAPTURE A LOOKED-UP DATA FINDING|inventory STOCK level/i)
    // Names the gather-FIRST-then-write ordering and the figure-in-the-note requirement.
    expect(addNote.description).toMatch(/gather the finding FIRST/i)
    // Anti-only-in-chat: a figure in chat alone is not "recorded" on the ticket.
    expect(addNote.description).toMatch(
      /stated only in your chat reply does NOT reach the teammate/i,
    )
  })

  it("[SC1] validates manifest tab types, sidebar, and activity-bar registration", () => {
    const result = validateAppManifest(ticketsManifest)
    if (!result.success) {
      throw new Error(`tickets manifest invalid: ${result.error}`)
    }
    expect(result.success).toBe(true)
    expect(ticketsManifest.views.activityBar).toMatchObject({
      order: 12,
      tabAction: { type: "inbox" },
    })
    expect(ticketsManifest.views.tabTypes.inbox).toMatchObject({
      urlPattern: "/tickets",
      sidebar: "TicketsSidebar",
      singleton: true,
    })
    expect(ticketsManifest.views.tabTypes.ticket).toMatchObject({
      urlPattern: "/tickets/:entityId",
      sidebar: "TicketsSidebar",
    })
  })

  it("renders DDL for the tickets table including handle column and partial unique on externalRef", () => {
    const tickets = ticketsManifest.schema.tickets
    const seqDdl = generateSequenceDdl("app_tickets", "tickets")
    expect(seqDdl).toContain("tickets_handle_seq")
    const tableDdl = generateTableDdl(
      "app_tickets",
      "tickets",
      tickets.fields,
      tickets.constraints as never,
      tickets.indexes as never,
      { handle: true },
    )
    expect(tableDdl).toContain('"handle" TEXT NOT NULL')
    expect(tableDdl).toMatch(/CREATE UNIQUE INDEX[^;]*WHERE external_ref IS NOT NULL/)
    expect(tableDdl).toMatch(/CREATE INDEX[^;]*WHERE merged_into_ticket_id IS NOT NULL/)
  })

  it("declares is_default_for_create on inboxes with org-only partial unique", () => {
    const inboxes = ticketsManifest.schema.inboxes
    expect(inboxes.fields.isDefaultForCreate).toEqual({ type: "boolean", default: false })
    const partial = (inboxes.constraints?.unique ?? []).find((u: unknown) => !Array.isArray(u)) as
      | { columns: string[]; where: string }
      | undefined
    expect(partial).toEqual({ columns: [], where: "is_default_for_create = true" })
  })

  it("declares partial unique on (org_id, external_message_id) for messages", () => {
    const uniques = (ticketsManifest.schema.messages.constraints?.unique ?? []) as unknown[]
    expect(uniques).toContainEqual({
      columns: ["externalMessageId"],
      where: "external_message_id IS NOT NULL",
    })
  })

  it("declares the ticket_reads schema descriptor with read-position indexes", () => {
    const ticketReads = ticketsManifest.schema.ticket_reads
    expect(ticketReads.fields.ticketId.references).toMatchObject({
      table: "tickets",
      column: "id",
      onDelete: "cascade",
    })
    expect(ticketReads.fields.userId.references).toMatchObject({
      schema: "kernel",
      table: "users",
      column: "id",
      onDelete: "cascade",
    })
    expect(ticketReads.fields.lastReadMessageId.references).toMatchObject({
      table: "messages",
      column: "id",
      onDelete: "set null",
    })
    expect(ticketReads.constraints.unique).toContainEqual(["ticketId", "userId"])
    expect(ticketReads.indexes).toEqual(
      expect.arrayContaining([
        ["ticketId", "readAt"],
        ["userId", "readAt"],
      ]),
    )
  })

  it("renders org-only partial unique DDL for inboxes default flag", () => {
    const inboxes = ticketsManifest.schema.inboxes
    const ddl = generateTableDdl(
      "app_tickets",
      "inboxes",
      inboxes.fields,
      inboxes.constraints as never,
      undefined,
    )
    expect(ddl).toMatch(
      /CREATE UNIQUE INDEX[^;]*"app_tickets"\."inboxes" \(org_id\) WHERE is_default_for_create = true/,
    )
  })

  it("customer-content read tools (search/get) declare taintSource; write tools do not", () => {
    // tickets__search/tickets__get return the customer-authored ticket subject +
    // message bodies — reading them must mark the thread tainted so the
    // containment story holds. (The body itself flows through the generic
    // host/sandbox bridge projection (apps/tickets/projection.ts), so the
    // taintSource flag is the in-scope guarantee here; per-field wrapping of the
    // ticket body lives with that projection, out of this change's scope.)
    const tools = ticketsManifest.tools as Record<string, { taintSource?: boolean }>
    expect(tools.search.taintSource).toBe(true)
    expect(tools.get.taintSource).toBe(true)
    // The aggregates and per-contact list name their tickets by subject, which
    // the customer wrote, so they mark the thread as the search does.
    for (const id of ["backlogHealth", "slaReport", "listForContact", "csat.list"]) {
      expect(tools[id]?.taintSource, `${id} must declare taintSource`).toBe(true)
    }
    for (const id of [
      "reply",
      "create",
      "addNote",
      "setStatus",
      // teams.list returns operator-authored routing labels and counts, never
      // customer-authored content — tainting a thread for reading it would
      // contain the agent for no gain.
      "teams.list",
      "setTeam",
    ]) {
      expect(tools[id]?.taintSource ?? false, `${id} must NOT declare taintSource`).toBe(false)
    }
  })

  it("every UI-facing team tool is manifest-registered, and the bulk action points at a real tool", () => {
    // The filter bar calls tickets:teams.list directly (ticket-team-store), so
    // it must exist in the manifest or the menu 404s at runtime. Same closure
    // rule the ui-tool-closure oracles apply to bundled apps.
    const tools = ticketsManifest.tools as Record<string, Record<string, unknown>>
    expect(tools["teams.list"]).toBeTruthy()
    expect(tools["teams.list"].requiredScopes).toEqual(["tickets:tickets:read"])
    expect(tools["teams.rename"]).toBeTruthy()
    expect(tools["teams.rename"].requiredScopes).toEqual(["tickets:tickets:write"])
    expect(tools.setTeam).toBeTruthy()

    const bulk = ticketsManifest.bulk as Record<string, Record<string, unknown>>
    expect(bulk.setTeam).toBeDefined()
    expect(bulk.setTeam?.underlyingTool).toBe("setTeam")
    expect(tools[bulk.setTeam?.underlyingTool as string]).toBeTruthy()
    // perItem dispatch needs the per-item param to be a real param of the tool.
    const params = (tools.setTeam.params as { properties: Record<string, unknown> }).properties
    expect(params[bulk.setTeam?.perItemParam as string]).toBeTruthy()
    for (const f of bulk.setTeam!.sharedFields as string[]) {
      expect(params[f], `bulk sharedField ${f} is not a setTeam param`).toBeTruthy()
    }
  })

  it("declares the team:rename event it emits, and a ws handler to receive it", () => {
    // An org-wide rename moves every ticket of a team at once. Without the
    // event + handler, an open inbox keeps offering a label that now matches
    // nothing until someone reloads.
    const events = ticketsManifest.events as { emits: string[] }
    expect(events.emits).toContain("team:rename")
    const ws = (ticketsManifest.views as { wsHandlers: Record<string, unknown> }).wsHandlers
    expect(ws.team).toBe("handleTeamEvent")
  })

  it("search description steers 'open'/backlog scope to the NON-CLOSED set (all-open), not status='open' alone", () => {
    // Regression: liam-weekly-eu-language-backlog-routine (BL-275 runtime gate) — the agent authored a
    // routine whose plan searched status='open' ONLY, silently dropping awaiting_customer +
    // awaiting_followup. That gutted the awaiting-customer nudge section and collapsed the status-grouped
    // digest to one group (and dropped the DE tickets that lived in those statuses). The fix is a search-
    // description steer teaching that a backlog / status-grouped / awaiting-customer-section request means
    // the whole non-closed set via smartFilter:'all-open'. Pin it so the steer can't silently regress.
    const desc = toolText(ticketsManifest, "search")
    expect(desc).toContain("all-open")
    // The steer must name the non-closed-set semantics AND warn that status='open' drops the other two.
    expect(desc).toMatch(
      /awaiting_customer\s+AND\s+awaiting_followup|open AND awaiting_customer AND awaiting_followup/,
    )
    expect(desc.toLowerCase()).toContain("nudge")
    expect(desc).toMatch(/status='open'|status: \['open','awaiting_customer','awaiting_followup'\]/)
    // The aging steer: the SERVER does the discrimination — pass agingThresholdDays and RENDER the
    // per-row `aging` boolean (do NOT recompute the comparison in-context), a DISCRIMINATION (the
    // flagged set is exactly the over-threshold rows, never everything/nothing). This is the BL-275
    // fix that moved the per-ticket comparison server-side off the flash-lite tick.
    expect(desc.toLowerCase()).toContain("aging")
    expect(desc).toContain("agingThresholdDays")
    expect(desc).toContain("`aging` BOOLEAN")
    expect(desc).toMatch(/RENDER each row's `aging` flag|RENDER it/)
    expect(desc).toMatch(/never the whole set, never none|do NOT recompute/i)
  })

  it("idempotent READ tools opt into transient-DB auto-retry (a connection blip mid-read must not return a partial/empty backlog)", () => {
    // Regression (liam-weekly-eu-language-backlog 3x gate): a routine tick's tickets__search occasionally
    // returned a PARTIAL result (2 of 7 Liam tickets) — a transient DB blip mid-read that the agent then
    // rendered as a near-empty digest. The idempotent reads must opt into the same tool-level transient
    // retry projects' reads use (retryOnTransientDbError), so a serialization/deadlock/connection blip
    // self-heals instead of surfacing a half-read backlog. Reads are idempotent SELECTs → safe to retry.
    const tools = ticketsManifest.tools as Record<string, { retryOnTransientDbError?: boolean }>
    for (const id of [
      "search",
      "get",
      "backlogHealth",
      "slaReport",
      "listForContact",
      "teams.list",
    ]) {
      expect(tools[id]?.retryOnTransientDbError, `${id} must opt into transient-DB retry`).toBe(
        true,
      )
    }
    // WRITE tools must NOT auto-retry here (they carry their own per-tool idempotency / gating).
    expect(tools.create?.retryOnTransientDbError ?? false).toBe(false)
  })

  it("declares gated reply/nudge/close tools with summarizers and editable fields", () => {
    const tools = ticketsManifest.tools as Record<string, Record<string, unknown>>
    for (const name of ["reply", "nudge", "close"]) {
      const t = tools[name]
      expect(t).toBeDefined()
      expect(t.gated).toBe(true)
      expect(t.summarizer).toBeDefined()
      expect(Array.isArray(t.editableFields)).toBe(true)
    }
    expect(tools.reply.handler).toBe("ticketsReply")
    expect(tools.nudge.handler).toBe("ticketsNudge")
    expect(tools.close.handler).toBe("ticketsClose")
    // reply declares a PROPOSE-time preflight so an un-attachable attachmentSessionId / missing
    // recipient fails at call time (before the approval is queued), not as a post-approval non-2xx
    // that the chaos runner verdict-overrides to fail.
    expect(tools.reply.preflight).toBe("ticketsReplyPreflight")
    // nudge and close declare one for the same reason: gated, so without it a wrong_status /
    // nudge_already_sent / not_found / merged_ticket only surfaced AFTER a human clicked approve.
    expect(tools.nudge.preflight).toBe("ticketsNudgePreflight")
    expect(tools.close.preflight).toBe("ticketsClosePreflight")
    // close must work without a reason (defaults to resolved server-side) so a
    // bulk close from a list view never fails on a missing closedReason.
    const closeParams = tools.close.params as { required?: string[] }
    expect(closeParams.required).toEqual(["ticketId"])
  })

  it("every declared tool preflight is defined in the sandbox handler bundle", () => {
    // Preflights are resolved by export NAME, exactly like handlers. A typo here silently disables the
    // staging refusal: the gate parks an approval and the validation only runs post-approval again.
    const src = readFileSync(join(import.meta.dir, "handlers.ts"), "utf8")
    const tools = ticketsManifest.tools as Record<string, { preflight?: string }>
    const declared = Object.values(tools)
      .map((t) => t.preflight)
      .filter((n): n is string => Boolean(n))
    expect(declared.length).toBeGreaterThanOrEqual(5)
    for (const name of declared) {
      expect(
        new RegExp(`function ${name}\\b`).test(src),
        `${name} must be defined in handlers.ts`,
      ).toBe(true)
    }
  })

  it("declares gmail/imap sync jobs and gmail-watch-renewal", () => {
    const jobs = ticketsManifest.jobs as Record<string, Record<string, unknown>>
    expect(jobs["gmail-incremental-sync"].handler).toBe("ticketsGmailIncrementalSync")
    expect(jobs["gmail-initial-sync"].handler).toBe("ticketsGmailInitialSync")
    expect(jobs["gmail-watch-renewal"].handler).toBe("ticketsGmailWatchRenewal")
    expect(jobs["imap-incremental-sync"].handler).toBe("ticketsImapIncrementalSync")
    expect(jobs["imap-initial-sync"].handler).toBe("ticketsImapInitialSync")
  })

  it("declares gmail-push webhook with verifier", () => {
    const webhooks = ticketsManifest.webhooks as Record<string, Record<string, unknown>>
    expect(webhooks["gmail-push"]).toBeDefined()
    expect(webhooks["gmail-push"].handler).toBe("ticketsOnGmailPush")
    expect(webhooks["gmail-push"].verify).toBe("ticketsVerifyGmailPush")
  })

  it("declares slots and Mail conversation contributions at top level", () => {
    expect(ticketsManifest.views).not.toHaveProperty("slots")
    expect(ticketsManifest.views).not.toHaveProperty("contributions")
    expect(ticketsManifest.slots).toMatchObject({
      "ticket:detail:actions": { position: "toolbar" },
    })
    expect(ticketsManifest.contributions).toMatchObject({
      "mail:conversation:banner": {
        label: "Ticket banner",
        component: "MailConvertToTicketBanner",
      },
      "mail:conversation:actions": {
        label: "Convert to ticket",
        component: "MailConvertToTicketAction",
      },
    })
  })

  it("[SC14] declares manifest WS handler keys for Tickets stores", () => {
    expect(ticketsManifest.views.wsHandlers).toEqual({
      ticket: "handleTicketEvent",
      message: "handleTicketMessageEvent",
      // An internal note is its own event (tickets/note:create), shown live like a message.
      note: "handleTicketNoteEvent",
      inbox: "handleInboxEvent",
      category: "handleCategoryEvent",
      // An org-wide teams.rename moves every ticket of a desk at once; without
      // this the open filter menu keeps offering the retired label.
      team: "handleTeamEvent",
      connectedAccount: {
        key: "kernel:connected_account",
        handler: "handleConnectedAccountEvent",
      },
      mailConversation: { key: "mail:conversation", handler: "handleMailConversationEvent" },
      sla: { key: "tickets:sla", handler: "handleSlaEvent" },
    })
  })

  it("preserves inbox tab query-string filters in the tab route", () => {
    expect(ticketsManifest.views.tabTypes.inbox).toMatchObject({
      singleton: true,
      preserveSubRoutes: true,
      urlPattern: "/tickets",
    })
  })

  it("declares ONE settings page (signature, inboxes, categories, response times, ID prefixes, API keys) and no views.settings", () => {
    const m = ticketsManifest as unknown as {
      kind?: string
      settings: {
        sections: Array<{ id: string; scope: string; adminScope?: string; blocks: any[] }>
      }
      views: Record<string, unknown>
      tools: Record<string, unknown>
    }
    expect(m.kind).toBe("app")
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => [s.id, s.scope, s.adminScope ?? null])).toEqual([
      ["signature", "user", null],
      ["inboxes", "org", "tickets:inboxes:admin"],
      ["categories", "org", "tickets:categories:admin"],
      ["response-times", "org", "tickets:settings:admin"],
      ["id-segments", "org", "tickets:settings:admin"],
      ["api-keys", "org", "tickets:settings:admin"],
    ])
    // Every tool a block binds is a tool of the app.
    const bound: string[] = []
    for (const s of m.settings.sections) {
      for (const b of s.blocks) {
        if (b.ops) bound.push(...Object.values(b.ops as Record<string, string>))
        if (b.source?.tool) bound.push(b.source.tool.get, b.source.tool.set)
      }
    }
    expect(bound.length).toBeGreaterThan(0)
    for (const t of bound) expect(Object.keys(m.tools)).toContain(t)
    const tree = m.settings.sections[2].blocks[0]
    expect(tree).toMatchObject({ block: "tree", maxDepth: 2 })
    expect(tree.ops.reorder).toBe("categories.reorder")
  })

  it("categories carry no row trigger: the two-level rule is migration 0189's deferred check", () => {
    expect((ticketsManifest.schema.categories as { triggers?: unknown }).triggers).toBeUndefined()
    const sql = readFileSync(
      new URL("../../db/migrations/0189_ticket_category_depth_deferred.sql", import.meta.url),
      "utf8",
    )
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER categories_depth_final")
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED")
    expect(sql).toContain("DROP TRIGGER IF EXISTS enforce_category_depth")
    expect(sql).toContain("category_depth_limit")
  })

  it("reply description repels the BL-54 wrong-tool choice (mail conversation → mail__reply)", () => {
    // BL-54: a weak model called tickets__reply with ticketId = a mail conversation id → 'ticket not
    // found'. The description must take a ticketId, warn off mail conversations, and point to mail__reply.
    const desc = (ticketsManifest.tools as any).reply.description as string
    expect(desc).toContain("ticketId")
    expect(desc).toContain("mail__reply")
    expect(desc.toLowerCase()).toContain("ticket not found")
  })

  it("ships the draft-ticket-reply skill + agentInstructions for the multi-reply path (BL-59)", () => {
    // BL-59: on a two-ticket two-language two-gated-reply task the weak model flailed, hallucinated a
    // tool failure, asked for ticketIds it already had, and pasted drafts instead of calling
    // tickets__reply per ticket. The skill + instructions must guide: call tickets__reply per ticket,
    // the ticketId comes from tickets__get, never claim a tool failure after a read succeeded.
    const skill = (ticketsManifest as any).skills["draft-ticket-reply"]
    expect(skill).toBeDefined()
    expect(skill.body).toContain("CALLING `tickets__reply`")
    expect(skill.body).toContain("once PER ticket")
    expect(skill.body.toLowerCase()).toContain("returns the ticketid")
    const ai = guideText(ticketsManifest)
    expect(ai).toContain("once per ticket")
    expect(ai).toContain("never ask the human for a ticket id")
  })

  it("draft-ticket-reply yields to 'leave the ticket alone': draft in chat, writes only as proposals", () => {
    // Walk 2026-09-23: asked to triage and draft with "ne poste rien sur le ticket", the support
    // agent set the ticket's category. A hands-off instruction must win over "call tickets__reply".
    const body = (ticketsManifest as any).skills["draft-ticket-reply"].body as string
    expect(body).toContain("ne poste rien")
    expect(body).toContain("that instruction wins over step 4")
    expect(body).toMatch(
      /triage: propose the category, status and owner, do not set them unless asked/,
    )
  })

  it("teaches that templates.create is NOT a send/broadcast and there is NO mass-send primitive (recall comms)", () => {
    // crisis-bricked-firmware-recall-end-to-end-recovery-partial arm (d): on the recall war-room the
    // model saved a "Recall Notice" reply TEMPLATE and told the user "you can use this for customer
    // communication" — implying an easy mass send — but NEVER disclosed there is no mass-send/broadcast/
    // segment primitive, an automatic-FAIL rubric clause. The fix lands the no-mass-send fact on the
    // exact surfaces the model touches (read-path-independent of whether it loads the crisis-recovery
    // skill): the templates.create tool description AND the always-on tickets agentInstructions.
    const tmpl = (ticketsManifest.tools as Record<string, { description: string }>)[
      "templates.create"
    ]
    expect(tmpl, "templates.create tool must exist").toBeDefined()
    // A saved reply template sends nothing — it is an internal macro, not a broadcast.
    expect(tmpl.description).toMatch(
      /NOT A SEND|contacts NO customer|notifies NO ONE|internal macro/i,
    )
    expect(tmpl.description).toMatch(/no mass-send|broadcast|segment/i)
    expect(tmpl.description).toMatch(/per-recipient|one approved send per recipient/i)
    // Always-on agentInstructions carry the same disclosure (read even if the skill is never loaded).
    const ai = guideText(ticketsManifest)
    expect(ai).toMatch(/NO MASS-SEND|no broadcast|no .*segment/i)
    expect(ai).toMatch(/per-recipient/i)
    expect(ai).toMatch(
      /cannot go out as a single blast|approved one send per recipient|out of reach for a single blast/i,
    )
    // Names the exact failure: saving a recall template and implying it is ready to mass-send.
    expect(ai).toMatch(/saving a recall template|imply.*mass send|ready to .*send to all/i)
  })

  it("teaches morning shared-inbox triage: claim-by-language, contention discipline, no fake unassigned/language filter (liam-morning-eu-triage-shared-inbox)", () => {
    // liam-morning-eu-triage-shared-inbox: Liam claims the unassigned FR/DE/IT threads in the shared inbox
    // (assign to himself + language/topic category), SKIPS the EN ones, and must NEVER re-assign a ticket
    // already owned by Sofia/Priya. tickets__search has NO 'unassigned' and NO 'language' filter, so the
    // agent must READ assignedTo (null=claimable, non-null=owned→skip) and detect language from content.
    // The always-on agentInstructions must teach all four: enumerate-by-inbox, contention (skip owned),
    // detect-language-from-body (no language param), and assign:'me' + setCategory (both language + topic).
    const ai = guideText(ticketsManifest)
    // (a) Don't invent an unassigned search filter, and don't rely on the language: filter at TRIAGE
    // time (fresh inbound tickets are untagged until setLanguage) — read the fields / detect from body.
    expect(ai).toMatch(/NO 'unassigned' filter in search/i)
    expect(ai).toMatch(/do NOT pass a made-up assignedTo:null/i)
    expect(ai).toMatch(/language: filter only matches tickets ALREADY LANGUAGE-TAGGED/i)
    // (b) Contention: a ticket already owned by a teammate is off-limits.
    expect(ai).toMatch(/already owned by Sofia, Priya, or anyone else.*OFF-LIMITS/i)
    expect(ai).toMatch(/NEVER re-assign it to yourself/i)
    // (c) Detect language from content, not a filter.
    expect(ai).toMatch(/DETECT LANGUAGE FROM CONTENT/i)
    // (d) Claim with assign:'me' AND tag language (setLanguage) + topic (setCategory) as SEPARATE fields.
    expect(ai).toMatch(/tickets__assign with assignedTo:'me'/i)
    expect(ai).toMatch(/tickets__setLanguage with the detected language/i)
    expect(ai).toMatch(/LANGUAGE and TOPIC are SEPARATE fields/i)
    // The single-category overwrite hazard is called out so the agent doesn't double-setCategory.
    expect(ai).toMatch(/a second setCategory overwrites the first/i)
    // (e) HARD GATE: two-pass detect-then-claim; never touch an English ticket; summary matches reality.
    expect(ai).toMatch(/WORK IT IN TWO PASSES/i)
    expect(ai).toMatch(/PASS A \(detect only, NO assign\)/i)
    expect(ai).toMatch(/PASS B \(claim only the in-scope ones\)/i)
    expect(ai).toMatch(
      /an English ticket .* is NOT in Pass B at all[,:] you make ZERO tool calls on it/i,
    )
    expect(ai).toMatch(/An English ticket must end this turn with assignedTo still null/i)
    expect(ai).toMatch(/Your summary MUST agree with your real assign calls/i)
    expect(ai).toMatch(/Do NOT claim every unassigned ticket regardless of language/i)
  })

  it("teaches the EU-language backlog DIGEST to wire the server-side language:['fr','de','it'] + agingThresholdDays filters (esp. when authoring a routine) (liam-weekly-eu-language-backlog-routine)", () => {
    // liam-weekly-eu-language-backlog-routine (journey liam_week_support S1, journey 17/20): the weekly
    // EU-backlog-health digest tick reads Liam's assigned FR/DE/IT tickets, groups by status + topic, and
    // FLAGS the >3d-aging ones. A baseline routine-authoring run left BOTH server-side affordances OFF the
    // authored prompt — it detected language by eyeballing bodies (risking an English leak / an empty
    // queue) and never wired agingThresholdDays (leaving the per-row `aging` boolean at an unconfigured
    // threshold). The search tool exposes BOTH (language: ISO array, agingThresholdDays with the per-row
    // `aging` boolean), so the fix teaches the agent — at authoring time — to wire them into the routine
    // prompt. Pins the guidance so the tick stays reliable across the 3× journey gate.
    const ai = guideText(ticketsManifest)
    // (a) The per-language backlog is a SERVER-SIDE language filter (ISO array), not in-context detection.
    expect(ai).toMatch(/EU-LANGUAGE \/ PER-LANGUAGE BACKLOG DIGEST/i)
    expect(ai).toMatch(/language:\['fr','de','it'\]/i)
    expect(ai).toMatch(/NOT in-context language detection per body/i)
    // (b) The aging flag is a SERVER-SIDE agingThresholdDays boolean, rendered not recomputed.
    expect(ai).toMatch(/AGING-FLAG DIGEST/i)
    expect(ai).toMatch(/agingThresholdDays:N/i)
    expect(ai).toMatch(/RENDER the aging boolean, do NOT recompute it/i)
    // (c) The digest must cover the WHOLE non-closed backlog (all-open), not a single status group —
    // a bare status='open' drops the awaiting_customer/awaiting_followup aging tickets (l766 run B: the
    // tick read only the open group and missed 2 of the 4 seeded aging tickets → runtime-gate override).
    expect(ai).toMatch(/COVER THE WHOLE NON-CLOSED BACKLOG/i)
    expect(ai).toMatch(/pass smartFilter:'all-open'/i)
    expect(ai).toMatch(/DROPS the awaiting_customer \/ awaiting_followup tickets/i)
    // (d) When AUTHORING a routine, the prompt MUST wire ALL THREE (all-open + language + aging).
    expect(ai).toMatch(/When you AUTHOR A ROUTINE for a per-language aging-backlog digest/i)
    expect(ai).toMatch(/routine PROMPT MUST wire ALL THREE/i)
    expect(ai).toMatch(
      /smartFilter:'all-open' \(so the tick covers open \+ awaiting_customer \+ awaiting_followup/i,
    )
    // (e) RENDERING: the digest must emit a section for EVERY non-closed status (the Open group is the
    // one flash-lite drops), never collapsing to only the awaiting_* groups (l766 runs B/5 tick floor).
    expect(ai).toMatch(/RENDER EVERY STATUS GROUP/i)
    expect(ai).toMatch(/dropping the Open section entirely/i)
    expect(ai).toMatch(
      /Every open-status row the search returned MUST appear under the Open section/i,
    )
  })

  it("the assign tool description carries a triage gate (claim only criterion-passing tickets) (l583)", () => {
    // l583 run 2: the agent self-assigned 3 English tickets in an FR/DE/IT-only claim. Reinforce the gate
    // on the exact surface the agent touches at the moment of the mistake — the assign tool description.
    const assign = { description: toolText(ticketsManifest, "assign") }
    expect(assign.description).toMatch(/TRIAGE GATE/i)
    expect(assign.description).toMatch(/ONLY on tickets that PASS the criterion/i)
    expect(assign.description).toMatch(/Tagging a ticket's language is NOT a reason to claim it/i)
  })

  it("ships a dedicated setLanguage tool + setCategory description warns it REPLACES the single category (l583 root fix)", () => {
    // l583 root cause: a ticket holds ONE scalar categoryId and setCategory REPLACES it, so an agent
    // tagging both language AND topic via setCategory silently clobbered the language. Fix: a dedicated
    // `language` field + a `tickets__setLanguage` tool that coexists with the topic category, plus a
    // setCategory description that signals the single-category-overwrite hazard.
    const tools = ticketsManifest.tools as Record<
      string,
      { description: string; requiredScopes?: string[]; handler?: string }
    >
    const setLanguage = tools.setLanguage
    expect(setLanguage, "setLanguage tool must exist").toBeDefined()
    expect(setLanguage.requiredScopes).toEqual(["tickets:tickets:write"])
    expect(setLanguage.handler).toBe("setLanguage")
    expect(setLanguage.description).toMatch(/dedicated field separate from the topic category/i)
    expect(setLanguage.description).toMatch(/BOTH a language tag AND a topic category/i)
    // The setCategory description now warns it REPLACES (does not stack) and points to setLanguage.
    expect(tools.setCategory.description).toMatch(/REPLACES/i)
    expect(tools.setCategory.description).toMatch(/does NOT stack/i)
    expect(tools.setCategory.description).toMatch(/setLanguage/)
    // The ticket schema carries the language field.
    expect((ticketsManifest.schema as any).tickets.fields.language).toBeDefined()
  })
})

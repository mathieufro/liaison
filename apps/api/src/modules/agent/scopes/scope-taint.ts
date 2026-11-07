// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint on writes. A turn that has touched scoped data (its accumulated requiredScopes is
// non-empty) may write only into a sink whose reads enforce requiredScopes. Writing anywhere else
// (projects, tickets, contacts, files, mail, skills, routines, ...) would launder scoped data past
// the visibility gate, so the write is refused and surfaced through the withheld-capability
// mechanism, never silently allowed.
//
// The call site is the `execute:` closure in tool-bridge.ts, which runs checkToolScopeTaint
// before the tool is invoked. It fails CLOSED: on a tainted turn a tool passes only when it
// declares a write target that checkScopeTaint allows, or when it is marked readOnly. A tool
// with neither counts as a write to an unknown table and is refused.
//
// WHAT THE RULE PROTECTS, AND AGAINST WHOM (2026-09-22). Data read under scope S must not
// flow into a sink readable by someone who lacks S. The audience that matters is the SINK's,
// never the room's: a ticket, a project task or a contact is readable by everyone in the org
// who holds that app's read scope, whoever sat in the conversation, and a message (the
// enforcing sink) is filtered per reader by its own requiredScopes. So the room never makes
// a domain write safe, and a room member lacking S is already handled by the message sink.
// Three consequences, each pinned by a test:
//
//   1. A READ is never a sink. A tool that only reads is `readOnly`, even when the platform
//      writes bookkeeping around the call that carries none of the turn's data: the audit row
//      of the call itself (the database connector's rows hold the read's name, a row count and
//      a SQL hash), the viewer's own participant row on a thread they may already read (what
//      opening a task in the UI does), a usage counter (memory_search's recall counter), a
//      result cache. Refusing those refused every read after the first one: from the second
//      scoped read of a turn, and from the first read of every later turn of the same thread
//      (its history carries the earlier reply's requiredScopes), kpi_run, db_read and
//      projects.get all came back E_SCOPE_TAINT_BLOCKED, even in a DM with an admin.
//   2. A GATED write is not refused here (rule 8 widens this): the tool bridge and the MCP
//      gateway pass it to the dispatch (`executeToolCore`), which parks it for a human when
//      everyone the approval will be shown to holds the turn's scopes (the requester, every
//      human member of the conversation it surfaces in; the notify audience is narrowed to
//      approvers holding them), and refuses it with this same error otherwise. It never executes inline from a
//      tainted turn: auto-approval is off for it. Approving it is a disclosure decided by a
//      person who holds S, the same principle as "Share anyway" (spec-security.md D4). A
//      shared-surface draft (a ticket or mail reply) is judged by its draft readers (rule 6b);
//      a sequenced @ref step is judged by its bundle head's audience (rule 8f).
//   3. The refusal names what the turn read and where it would have gone, never "room
//      members", because room members are not what it checks.
//   4. An ungated write to a table whose readers are BOUNDED is judged by those readers
//      (2026-09-23). A tool may declare, next to its `writesToTable`, the `sinkReadScope`
//      every reader of that table must hold (the kpi app's comment feed is read only under
//      kpi:comments:read). The tool bridge and the MCP gateway pass it to the dispatch, which
//      lets it run when every user of the org who can read the table (hasScope on the read
//      scope or its write sibling, which the generated RLS also lets SELECT; any account
//      status, since a reactivated account reads the table as it then stands) also holds
//      every scope the turn read, and refuses it otherwise. An unknown taint is held by
//      nobody. The judgement is POINT IN TIME, like an approval's audience: a later grant of
//      the read scope, a new member or an accepted invitation exposes rows written earlier,
//      which is an admin's disclosure decision as granting any read scope is. Dimension
//      grants are ignored (latent: the kpi app has none); see sinkReadersHoldTaint. The Oracle's everyday flow
//      (read a metric, then record the argument on its feed) was refused without it.
//
// TAINT IS A DATA CLASSIFICATION, AND ONE AUDIENCE RULE JUDGES EVERY WRITE (2026-10-07).
// Rules 5 to 7 supersede the "unbounded" refusal of consequence 2 and generalize consequence 4.
// What the rule protects is unchanged: data read under S never reaches a person lacking S.
//
//   5. The taint holds no write or action scope. Every scope entering a taint or a record's
//      requiredScopes stamp is classified by its ACTION, failing closed (taint-read-scopes.ts):
//      a `:read` scope is kept; a scope whose action is a write or action verb
//      (WRITE_ACTION_VERBS: write, create, update, delete, close, reply, forward, send, nudge,
//      merge, set, assign, archive, approve, decide) is projected onto its read sibling
//      `<app>:<resource>:read` when the registered scope catalog has it, and dropped otherwise
//      (the inverse of the one read/write sibling rule the readers check uses); every other
//      scope is kept as it is (an app tool's `:run` scope, an `:admin` or `:spawn` scope gating
//      a read-only tool, an unknown action; a grant wildcard is expanded onto the read scopes it
//      covers, rule 10b). It applies wherever a scope enters: a
//      tool call, history injection, the lost-record fallback of a turn's end stamp (rule 12),
//      compaction
//      summaries, caller and sub-run taint, approved re-entries, the MCP connection window, the
//      write-scope fallbacks, and the stamp of a reply produced on a machine (local session or
//      node job), which is what Liaison handed that turn (its tool calls, the agent's definition,
//      the conversation: local-context-scopes.ts), never the turn's whole effective scope, which
//      is `*` for an admin whose agent's ceiling is `*` (2026-10-08). Without it one abnormal turn stamped its reply with the
//      requester's whole effective scope, every later turn re-read it as history, and the
//      conversation's taint could only grow.
//   6. A write on a tainted turn proceeds when EVERY human who will be able to read what it
//      writes holds every taint scope (holdsEveryScope), and is refused otherwise
//      (taint-approval-audience.ts, readersTaintGap):
//      a. an app-schema table with no declared sinkReadScope defaults to the readers its
//         generated RLS admits, `<app>:<rlsScope entity>:read` (derivedSinkReadScope, vouched
//         like a declared one); readers are judged on their grants widened by the app's own
//         runtime scope aliases. A table whose readers cannot be derived (outside the app's
//         schema, undeclared in its manifest, RLS owned by a migration, UNDECLARED) is refused;
//      b. a gated shared-surface draft (ticket or mail reply, nudge, close, forward) is judged
//         by every holder of the surface's draft read scope and of its deciding scope; it may
//         park for approval only then, and never auto-approves. A sequenced @ref step is
//         judged by its bundle head's audience (rule 8f);
//      c. requester, member and participants audiences keep their checks (a shared-surface
//         draft meets them too, since its card surfaces in the conversation);
//      d. a write whose only reader is the acting user (`sinkReadersSelf`: notify_user, an
//         attention item and a push for that user alone) is judged by that user's own grants
//         (2026-10-07, S28: a routine's brief notifying its owner). The routine tick's taint
//         always carries its whole effective scope (the tick prompt's stamp), so without this
//         no routine could ever notify its owner.
//      e. a write whose only readers are the requester and the participants of the conversation
//         it is made in (`sinkReadersConversation`: request_secret, whose row the secret_requests
//         RLS policy shows to exactly them) is judged by those people, the audience rule 6c
//         already applies to a card in that conversation (2026-10-27: every Connect card in an
//         org with members parked, because the old declaration counted every member who reads
//         threads as a reader).
//      f. a write that carries the turn's data ONLY through declared free-text parameters
//         (`contentParams`) and is called with every one of them absent or blank writes none
//         of the turn: a status change on the caller's own row (approval_withdraw with no
//         reason: the requester retracts the request they raised). It is not judged at all
//         (2026-10-13: the demo cleanup's second withdraw on one MCP connection was refused,
//         because the first withdraw's own scope had tainted the connection window). Called
//         with one of them filled, the write is judged as before, and the refusal says the
//         same call without them runs. approval_withdraw now declares none (2026-10-24): its
//         reason is posted only in the approval's threads, stamped with the turn's taint, and
//         kept off the row on a tainted turn, so withdrawing one's own request never parks.
//      g. a call to a tool of MCP connection S, on a turn whose EVERY taint scope lies in S's
//         own namespace (`mcp:S` or `mcp:S:<tool>`), is not judged (returnsToOwnMcpServer,
//         2026-10-25): what the turn read came from S, and the call sends it back to S alone,
//         so nothing Liaison holds is disclosed. A fetch of a page a search on the same server
//         returned parked as an approval. Any other taint (another server, knowledge, a ticket,
//         the unknown sentinel) leaves the call judged exactly as before.
//      h. The outside-content hold (taint.ts) is lifted for a READ on MCP server S when every
//         source of the thread's outside text is S itself (mcpReadOfOwnServer, 2026-10-25, owner
//         ruling that MCP reads are not gated). A read is what the server annotates readOnlyHint
//         and not destructiveHint, by the connection policy's own function (isAnnotatedReadOnly),
//         never a per-tool "Allowed" override. An injected page can then at most make the agent
//         read more of the same server, and the results land only in the same thread. A write or
//         destructive tool still parks under every policy, "Allow everything" included, and so
//         does any read once the thread also holds text from elsewhere (web, mail, knowledge,
//         another server) or from an unnamed source (`tainted_sources` NULL, every mark set
//         before migration 0199).
//      i. (Superseded 2026-10-29 by rule 9: a web read is never judged here, whatever the turn
//         read.)
//      Unknown taint stays held by nobody; every judgement is point in time.
//   7. The refusal names the missing scope(s) and HOW MANY of the people who would see the
//      write lack them, never who. It names the only remedies (a person holding the scopes
//      acts in the app, or an admin adjusts scopes) and says a new conversation is not
//      possible and must never be suggested: a model left to guess invented that remedy.
//
// NOTHING IS IMPOSSIBLE: A WRITE THE AUDIENCE RULE WOULD REFUSE PARKS FOR APPROVAL (2026-10-20,
// owner decision). A support agent that read a ticket, the customer's order and its shipments
// could not draft the ticket's reply: some ticket reader lacked a shipping scope, so rule 6b
// refused `tickets:reply`, an approval-gated tool that cannot reach anyone before a person
// approves it. Every action that touches the outside world is approval gated, so a tainted turn
// can do no harm through one; the approval IS the disclosure decision (the "Share anyway"
// principle, spec-security.md D4). Rule 8 supersedes the readers refusals of rules 6a, 6b, 6d
// and the undeclared and unknown-readers refusals, wherever the call reaches the
// dispatch (the chat tool bridge and the MCP gateway now defer every write to it):
//
//   8. a. A gated write on a tainted turn ALWAYS parks for a person: never inline, never
//         auto-approved (rule 2 already; an auto-approve policy or capability grant does not
//         answer it), whatever its readers hold.
//      b. An UNGATED write the taint would refuse is gated for that call (computeSkipGate sees it
//         as gated) and parks exactly like one: same card, same `proposing_turn_scopes`, same
//         approved re-entry, which runs the tool's own handler under the proposing turn's scopes.
//         A write its readers all hold (6a, 6d) or the same-resource allowance passes runs
//         inline as before.
//      c. The approval is narrowed to people holding every taint scope: the notified approvers
//         (createApprovalRequest), and, for a shared-surface draft whose row every reader of the
//         ticket or conversation could otherwise read, the row itself (`metadata.
//         taintAudienceMustHold`, enforced by RLS from migration 0167, which decide, edit, the
//         ticket's pending drafts and the ticket-mode list all read through). A reader lacking
//         the taint does not see the pending body; once approved, the sent reply is theirs to read.
//      d. It is refused only when NOBODY may decide it: no holder of the deciding scope (and its
//         dimension) also holds the taint, or the routed owner lacks it. The refusal names the
//         deciding scope and the remedy (an admin adjusts scopes), never who.
//      e. The card says why, in one plain line, when readers of the target lack the taint:
//         "Drafted after reading <apps> data that some people who can read <surface> cannot see:
//         approving shares it with them" (taintDisclosureLine).
//      f. Kept as they were: the requester and the conversation's members are still judged (rule
//         6c: the card shows the payload to them before anyone decides), a sequenced @ref step
//         parks only within its bundle head's audience: every head it cites is the same
//         requester's pending request whose `taintAudienceMustHold` already holds everything the
//         step's turn read, and the requester and the conversation's members hold it too; the
//         step then shows to the head's audience and carries its demand (2026-10-30: a routine's
//         CRM record, quote and reply could never form one request, since a routine tick is
//         always tainted). Otherwise it is refused. Reads into the messages sink and the
//         per-reader message filtering are unchanged (an AGENT POST some other reader could
//         not see parks since 2026-11-03, rule 11, as does a new thread's title or references),
//         and the human-typed-turn and untrusted-content rules (taint.ts) are untouched.
//      g. Rewriting a PENDING approval is not itself a disclosure: the edited payload stays
//         pending and is decided by that same approval. So `kernel__approval_update_payload`
//         (`taintEditsPendingApproval`) is not judged at the dispatch, and a tainted gated call
//         whose dedupe key matches the SAME requester's pending row restages it; both update the
//         row IN PLACE, never a second approval (approvals/taint-narrow.ts): the turn's taint
//         unions into `proposing_turn_scopes` and `taintAudienceMustHold`, the notified audience
//         is re-narrowed to holders of the union, the card line is rebuilt, and the edit-diff
//         message is stamped with the union, never unscoped. Refused (the no-decider message)
//         only when the requester lacks the union or nobody who may decide the row holds it.
//         Another requester's pending row is still never restaged (approval_already_pending).
//      h. An UNGATED write parked ONLY by the taint (8b: no host or per-param gate, no outside-content
//         hold, no org approval policy, no @ref step, not a routine's request) is a disclosure
//         decision and nothing more: it would have run inline on a clean turn. It is decided by
//         holding every taint scope, never by `<app>:approve` (2026-10-27: a support analyst's
//         memory note and bug report parked as `kernel:approve`, the admin-grade scope of role
//         edits, so she could not decide her own card and it landed in every admin's feed). The row
//         persists the first taint scope as `approve_scope` and all of them in `metadata.
//         taintAudienceMustHold` (approvals/authority.ts, taintDisclosureAuthority), with no
//         dimension constraint; the notified audience is narrowed to holders of all of them, and
//         decide and edit re-check all of them. The requester holds the taint (6c), so they may
//         decide it, and the feed folds it out of other approvers' default view as peer noise. A
//         gated write keeps its own deciding scope plus 8c.
//
// A WEB READ NEVER PARKS; GUARDRAILS BOUND WHAT IT CARRIES (2026-10-29, owner ruling: "web search
// is a SEARCH, so it's 100% a read"). Rule 6i held web_fetch and web_search once the turn read org
// data, so a support routine that read the ticket parked its very first search.
//
//   9. a. A web read (web_search, web_fetch: `outboundWebRead`) is neither judged by the scope
//         taint nor held by the outside-content rule (taint.ts), on every surface (chat, routines,
//         sub-runs, the MCP gateway) and whatever the turn read (execute-tool.ts, `isWebRead`).
//         Nothing about it parks; there is no org setting that gates it (none existed, so none is
//         added). The org fetch allowlist and blocklist, the SSRF guard, the demo egress rules and
//         the web-search spend counters still apply, before any of this.
//      b. Taint MARKING is unchanged: web content is outside, untrusted text, the thread is marked
//         by it, and every write after it (gated, ungated outward, or refused by the taint) is
//         judged and parked exactly as before. The approval of a write remains the disclosure
//         decision; a read discloses only through its request.
//      c. That request is bounded in code, refused inline with the limit it hit, never parked
//         (web-read-guardrails.ts, at the dispatch, so every surface gets it). SHAPE, always: a
//         query of 200 characters at most, a URL of 512 with a query string of 150, no userinfo.
//         PAYLOAD, on a turn that read org data (`readInternalData`), or whose reads are unknown
//         because the live frame was lost on a hop (fail closed): no long opaque run (32+
//         characters of base64, hex or digits, raw or decoded), no run of 11+ escaped ASCII
//         characters, no email address, IBAN, card-like (Luhn) or "+"-prefixed phone number, no
//         secret-shaped token, and in a query no run of 9+ digits. RATE, always: 20 web reads per
//         turn, 12 in a row with no other tool call between, 10 distinct fetched hosts per turn
//         (per turn, in the turn's accumulator), 60 per conversation per rolling hour (Redis, so
//         a sub-run, a resumed run or an MCP client is bounded too). Every limit is an env var.
//      d. Why this is enough, adversarially. An injected page can make the agent compose a URL or
//         a query, but a URL cannot carry an address, an account number, a token or an encoded
//         blob, and the rate caps bound what slips through in plain words to a few hundred
//         characters per read and a few dozen reads an hour. Payload checks are not applied on a
//         turn that read no org data: it holds nothing to leak (rule 6i's argument), and
//         content-addressed pages (a commit, a shared document) are legitimately opaque. A fetch
//         of exactly one of this turn's own search results skips SHAPE and PAYLOAD (the provider
//         produced it; claimSearchResultFetch keeps its old bounds: once per URL, three per
//         search, nothing new read since), and counts toward RATE. Residual risk, accepted by
//         the ruling: plain-word paraphrase of org data inside the caps.
//      e. Removed with it, as redundant: the sender's-home-page exemption (a mail-started run's
//         fetch of the sender's bare https root) and the org-allowlist hold exemption
//         (`taintExempt`): a web fetch is never held, so neither had anything left to exempt.
//
// A WRITE ON THE CALLER'S OWN RESOURCE PARKS FOR THE CALLER; NO STAMP HOLDS A WILDCARD
// (2026-11-03). A personal agent read its owner's mail, invoicing documents, orders and the
// database, staged a proforma (it parked), then replied from its owner's own mailbox with the
// proforma's PDF as a sequenced @ref step. The reply was refused as "unbounded": the turn had
// read more after staging the head than the head demanded, so rule 8f's "every head already
// demands it" failed, and nothing narrowed the head. The same turn's taint held `*`: an earlier
// abnormal turn's widening to its `*` ceiling, re-read as history, re-stamped every later reply,
// and a teammate holding `clevel` but not `*` could not see a reply addressed to them.
//
//  10. a. A sequenced @ref step whose turn read more than its heads demand WIDENS those heads in
//         place, when each is the same requester's pending request (widenSequencedStepHeads,
//         execute-tool.ts): exactly a restage under rule 8g (narrowPendingApprovalForTaint): the
//         union becomes `taintAudienceMustHold`, the notified audience is re-narrowed to holders
//         of it, never widened, and the requester and somebody who may decide the head must hold
//         it. The step then parks within its heads' audience (8f). An owner-routed head (the
//         caller's own mailbox) is decided by its owner alone, who is the requester here. Refused
//         only when nobody could decide the widened head (the no-decider message, 8d), or when a
//         cited head is not the requester's own pending request; that refusal says the @ref cites
//         someone else's action, never that "everyone who may decide it" would see it.
//      b. Rule 5, amended: a grant wildcard (`*`, `<app>:*`, any scope with a `*` segment) is a
//         pattern over grants, never a data classification, so it never enters a taint or a
//         requiredScopes stamp. It is EXPANDED onto the catalogued read scopes it covers
//         (taint-read-scopes.ts, readScopesCoveredByWildcard, hasScope's rule), which keeps an
//         over-approximation as wide in what it classifies and never fails open; sendMessage
//         expands any wildcard it is handed (a requester's own grant set, an effective scope).
//         A stored stamp that already holds `*` is expanded when it is re-read as history, so it
//         no longer re-stamps `*`; an approval failure notice's requester-scope stamp
//         (failureContextRequiredScopes) is expanded the same way. Rows stored before are repaired
//         by migration 0252 only where that can never widen who reads them: an agent turn's
//         reply (not an external client's post) in an org whose every wildcard-bearing message is
//         such a reply loses its wildcard entries and keeps the explicit ones, which by
//         induction over the org's turns cover every read. System rows (failure notices quote
//         handler errors under the requester's whole grant set) and every row of an org holding
//         one stay as they were, hidden (fail closed), as does a row that would be left empty.
//      c. (Superseded the same day by rule 11: a post some participant cannot read parks.)
//
// AN AGENT POST NOBODY TOLD THE ROOM ABOUT IS NEVER WRITTEN HIDDEN (2026-11-03, owner decision).
// The agent's reply to a teammate's DM carried the turn's taint, the teammate lacked one scope of
// it, and the message was silently invisible to the very person it was addressed to. Rule 8f
// kept writes into the messages sink unjudged, since the sink filters per reader; that left the
// requester no say in whether the data reached the room. Superseded, for agent posts:
//
//  11. a. An agent post into a kernel thread (threads_reply into a thread, threads_create's first
//         message, title or references: a tool's `taintPostAudience`) on a tainted turn, read by
//         someone OTHER than the requester who lacks a scope the turn read, parks for approval
//         (rule 8b) instead of landing hidden. It is a disclosure decision only (rule 8h): the
//         requester, who holds the taint, decides it; nobody else is notified of the pending body.
//         The card says "<N> people in this conversation cannot see <apps> data this conversation
//         read: approving shares this message with them" (taintPostDisclosureLine).
//      b. Approved, the post is written with the turn's stamp AND the people it would have
//         reached when it parked (`metadata.taintDisclosureAudience`, the snapshot the card
//         counted), still in the thread at approval, on its disclosure list: the approval is the
//         disclosure decision, as for every other rule-8 write, and those people read it whatever
//         they hold. Someone who joined after the park, or joins later, and lacks the taint does
//         not see it.
//      c. A post every other reader can read runs inline exactly as before. A requester who lacks
//         the taint cannot decide it: the post is then refused with the room audience message.
//         A gap that cannot be counted (an id that is no account, an unknown taint, a failed
//         lookup) is left to the handler's own checks, which refuse it. A contact discussion
//         (threads_reply with contactId) is not judged here: its readers are the contact's.
//
//  12. A turn's end stamp is what the turn READ (2026-11-03, owner decision; supersedes the
//      spec-security A2 widening). An abnormal end used to be stamped with the agent's whole
//      effective scope, which put the ceiling (and `*`) on any turn that ended without text; the
//      next turns re-read it as history and every later reply carried it. The accumulator records
//      each tool call before it runs, so it is the faithful record: the stamp is its snapshot,
//      abnormal end or not. Only when no record survived (no accumulator) does it fall back to the
//      effective scope, else the requester's scopes, projected (wildcards expanded, rule 10b).
//
// EVERY APPROVAL A TAINTED TURN PARKS IS NARROWED; A WRITE TO ONE'S OWN RESOURCE IS ONE'S OWN TO
// DECIDE (2026-11-03). A personal agent read its owner's mail, invoicing documents, orders and
// the database, then wrote a memory note about a customer. Memory is an enforcing sink, so the
// taint let the write through and set no audience; the outside-content hold then parked it with
// the tool's own deciding scope (`kernel:agent:memory`, held by every Full Member) and no
// `taintAudienceMustHold`, so six teammates were notified of, and could read and decide, a body
// made of invoicing and Shopify data. The proforma staged in the same turn was narrowed: only
// taint-forced approvals (rule 8b) carried the audience.
//
//  13. a. Every approval a judged tainted turn parks is narrowed to holders of every scope the
//         turn read (rule 8c), whatever parked it: the taint (8b), the outside-content hold, a
//         host or per-param gate, a gated tool, an org policy. The dispatch carries the turn's
//         taint as `audienceMustHold` (the notified approvers, `metadata.taintAudienceMustHold`
//         for decide and edit), restages only the same requester's pending row, and refuses the
//         call now, naming the remedy, when nobody who may decide it holds the taint (8d).
//         `createApprovalRequest` applies the same narrowing to a caller that names no audience
//         (a handler asking for approval itself), from the proposing turn's known scopes. The
//         deciding scope is unchanged: only rule 8h replaces it.
//      b. A write to the requester's own resource is decided by its owner alone, notified to
//         nobody else, and its pending body is readable by nobody else (`resource_owner_id`, the
//         owner-routed approval: RLS, decide, edit, list). Declared per tool in
//         `approvalResourceOwnerRegistry`: `actingAgentTree` for the memory writes (the acting
//         agent's tree: a personal agent's owner, the requester when no agent acts; a role or
//         system agent's memory, read by everyone who uses it, keeps the org's deciders, narrowed
//         by 13a), `requesterAlways` for the user's own notification settings and thread mutes.
//         Skills are not one's own resource in this sense: a personal skill is still decided by
//         `kernel:skills:approve` (a governance decision), narrowed by 13a.

// Sink identifiers are the real table, schema-qualified, with the UNPREFIXED base schema name:
//   kernel.messages          (db/schema/kernel/threads.ts)
//   kernel.agent_memory      (db/schema/kernel/agent-memory.ts)
//   app_knowledge.documents  (apps/knowledge, via schemaRef("app_knowledge"))
// SCHEMA_PREFIX is applied to schema names at runtime only; it is never part of the identifier,
// so the answer does not depend on it. P2a-T18, which adds the `writesToTable` annotation to the
// tool registry entry type (modules/apps/app-registries.ts), must annotate every tool with
// exactly this form: an enforcing-sink tool with one of the three strings above, character for
// character, and every other write tool with its own `schema.table`.
//
// SAME-RESOURCE ALLOWANCE (A46). The taint also records WHERE it came from: per table, the row
// ids the turn's scoped reads RETURNED (A46b: filed after the read succeeded, never from its
// arguments alone, so a failed, refused, empty or scope-free read files nothing). A write outside the enforcing sinks is allowed when the
// tool declares its target table AND its target row, and every target row is among that table's
// origin rows. A different row, a different table, a declared table with no target row, or an
// undeclared target is refused through the same withheld-capability path as before.
//
// The match is exact and literal. No schema stripping, prefix stripping, case folding, trimming
// or prefix matching: app_mail.messages shares the base name "messages" with the kernel table,
// so any normalization would let a mail write pass as an enforcing sink. A bare, prefixed,
// unknown or differently spelled name is therefore non-enforcing (fail closed).

import { isAnnotatedReadOnly } from "~/apps/mcp-manager/default-policy"
import type { McpToolAnnotations } from "~/apps/mcp-manager/types"
import { resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import { approvalResourceOwnerRegistry, entityRegistry } from "~/modules/apps/app-registries"
import { connectionToolNamespace, isValidSlug } from "~/modules/mcp-client/naming"

// The three enforcing sinks, named so a tool registration's `writesToTable` imports the exact
// string instead of retyping it.
export const SINK_KERNEL_MESSAGES = "kernel.messages"
export const SINK_KERNEL_AGENT_MEMORY = "kernel.agent_memory"
export const SINK_APP_KNOWLEDGE_DOCUMENTS = "app_knowledge.documents"

// The closed list of requiredScopes-enforcing sinks. Extending it is a spec change, not an
// implementation choice.
export const TAINT_ENFORCING_SINKS: ReadonlySet<string> = new Set([
  SINK_KERNEL_MESSAGES,
  SINK_KERNEL_AGENT_MEMORY,
  SINK_APP_KNOWLEDGE_DOCUMENTS,
])

// KERNEL CONTROL-PLANE SINKS. spec-security.md "Scope taint on writes" names what the rule
// protects: record types with no `requiredScopes`-aware read predicate, "projects, tickets,
// contacts, files, mail, skills, routines". The kernel's own control-plane rows are not of that
// kind. They carry no business record and are never read back as one:
//
//   kernel.agent_runs             a sub-run dispatched by `spawn_agent`. The child is not an
//                                 escape hatch: `spawnAgent` hands it `parentTaintScopes` and
//                                 `subrun-worker` seeds the child accumulator with them, so the
//                                 child starts AT LEAST as tainted as its parent and every write
//                                 it attempts meets this same rule.
//   kernel.sub_agent_definitions  a reusable ROLE (slug, whenToUse, scope ceiling, tool lists).
//                                 A role definition is configuration; its ceiling is already
//                                 bounded by the author's own grantable scopes.
//   kernel.scope_requests         a request for access, readable only by the admins who decide
//                                 it, and the whole point of the row is to be shown to them.
//
// Refusing these three made the rule self-defeating: a tainted turn could neither delegate the
// work to a narrower-scoped sub-agent nor ASK for the scope it was missing, which is exactly the
// pressure A46 identified as pushing people to widen scopes instead. Allowing them changes no
// domain-write answer: a ticket, contact or file write from the same tainted turn is refused
// exactly as before. Extending this list, like extending TAINT_ENFORCING_SINKS, is a spec change.
export const SINK_KERNEL_AGENT_RUNS = "kernel.agent_runs"
export const SINK_KERNEL_SUB_AGENT_DEFINITIONS = "kernel.sub_agent_definitions"
export const SINK_KERNEL_SCOPE_REQUESTS = "kernel.scope_requests"
//
// A person's own notification settings (spec S17/S18, 2026-09-28): the grid and work hours
// (kernel.user_preferences), per-app rules (kernel.attention_subscriptions) and thread mutes
// (kernel.user_thread_state). Each row belongs to the person whose turn it is and is read back
// only by them, and the tools that write them (notifications_set, notification_rules_set,
// thread_mute_set) take enums, booleans, ids and an IANA zone, no free text. Nothing scoped can
// be carried to anyone else through them. Refusing them meant an agent whose turn had recalled a
// memory could not honour "don't notify me on my phone for tickets".
export const SINK_KERNEL_USER_PREFERENCES = "kernel.user_preferences"
export const SINK_KERNEL_ATTENTION_SUBSCRIPTIONS = "kernel.attention_subscriptions"
export const SINK_KERNEL_USER_THREAD_STATE = "kernel.user_thread_state"
//
// Away days (kernel.away_ranges, `set_away`): dates, weekdays and member ids, no free text and
// never a reason, so nothing scoped a turn read can be carried in one. Who may write which
// person's range is the tool's own rule (outside text and non-person turns park it).
export const SINK_KERNEL_AWAY_RANGES = "kernel.away_ranges"

export const TAINT_CONTROL_PLANE_SINKS: ReadonlySet<string> = new Set([
  SINK_KERNEL_AGENT_RUNS,
  SINK_KERNEL_SUB_AGENT_DEFINITIONS,
  SINK_KERNEL_SCOPE_REQUESTS,
  SINK_KERNEL_USER_PREFERENCES,
  SINK_KERNEL_ATTENTION_SUBSCRIPTIONS,
  SINK_KERNEL_USER_THREAD_STATE,
  SINK_KERNEL_AWAY_RANGES,
])

// LOW-SENSITIVITY SINKS (owner decision, 2026-09-30). Project tasks, their checklist items and
// their dependencies are work tracking: a tainted turn may create or change them, and what the
// agent writes there on the user's instruction is the user's responsibility. Refusing them meant
// that after any ordinary scoped read in a conversation nobody could file a task or tick a
// checklist item. The list is narrow on purpose: a project itself, its statuses and every other
// app table keep the rule, and extending it is a product decision, like the lists above.
export const SINK_APP_PROJECTS_TASKS = "app_projects.tasks"
export const SINK_APP_PROJECTS_TASK_CHECKLIST_ITEMS = "app_projects.task_checklist_items"
export const SINK_APP_PROJECTS_TASK_DEPENDENCIES = "app_projects.task_dependencies"

export const TAINT_LOW_SENSITIVITY_SINKS: ReadonlySet<string> = new Set([
  SINK_APP_PROJECTS_TASKS,
  SINK_APP_PROJECTS_TASK_CHECKLIST_ITEMS,
  SINK_APP_PROJECTS_TASK_DEPENDENCIES,
])

// What a tool call refused by scope taint returns in place of the tool's normal result. The
// call was admitted to the catalog and refused mid-execution, so it is a runtime error shape of
// its own, distinct from the spawn-time subset codes.
export type ScopeTaintBlockedError = {
  ok: false
  code: "E_SCOPE_TAINT_BLOCKED"
  writeTargetTable: string
  reason: "scope_taint_blocked"
  /** What the model must tell the user: the refusal rides on the result, where it is read. */
  message: string
}

/**
 * Who the refused write would have exposed the turn's data to.
 *   sink       the target table, readable by people not required to hold the scopes
 *   requester  the approval a gated write would create: the person asking lacks them
 *   member     the same approval: a human member of the conversation it surfaces in lacks them
 *   unbounded  a sequenced @ref step citing an action that is not the requester's own pending
 *              request, so the bundle's audience cannot be narrowed by this turn (rule 8f)
 *   readers    the target table's declared readers (`sinkReadScope`): one of them lacks them
 *   participants  a new thread's title or references, read by its participants: one lacks them
 */
export type ScopeTaintAudience =
  | "sink"
  | "requester"
  | "member"
  | "unbounded"
  | "readers"
  | "participants"

function describeTaintScopes(taintScopes: readonly string[]): string {
  const real = taintScopes.filter((s) => !UNKNOWN_TURN_TAINT.includes(s))
  if (real.length === 0) return "data whose required scopes could not be determined"
  return `data that requires ${real.join(", ")}`
}

/** Who lacks what, counted, never named (the refusal must not reveal who holds what). */
export type ScopeTaintGap = { missingScopes: readonly string[]; lacking: number | null }

function describeAudience(
  writeTargetTable: string,
  audience: ScopeTaintAudience,
  sinkReadScope?: string,
): string {
  switch (audience) {
    case "readers":
      return `${writeTargetTable} can be read by everyone holding ${sinkReadScope ?? "its read scope"} or write access to it, whatever their account status, and at least one of them does not hold all of those scopes`
    case "requester":
      return "the approval this gated action would create would be shown to you, the requester, and you do not hold all of those scopes"
    case "member":
      return "the approval this gated action would create would surface in this conversation, and at least one human member of it does not hold all of those scopes"
    case "participants":
      return "the title and references of the new thread are shown to every participant (you and the people you added), and at least one of them does not hold all of those scopes"
    case "unbounded":
      return "this gated action cites an earlier action (@ref) that is not your own pending request, so its approval cannot be limited to people who hold those scopes"
    default:
      return writeTargetTable === UNDECLARED_WRITE_TARGET
        ? "this tool does not declare what it writes, so its target counts as readable by people who are not required to hold those scopes"
        : `${writeTargetTable} is readable by people who are not required to hold those scopes`
  }
}

/** Who the counted people are, per audience, for "N <who> lack ...". */
function lackingNoun(audience: ScopeTaintAudience, n: number): string {
  const one = n === 1
  switch (audience) {
    case "requester":
      return one ? "person (you)" : "people"
    case "member":
      return one ? "member of this conversation" : "members of this conversation"
    case "participants":
      return one ? "participant" : "participants"
    default:
      return one ? "reader" : "readers"
  }
}

function describeGap(
  taintScopes: readonly string[],
  audience: ScopeTaintAudience,
  gap?: ScopeTaintGap,
): string {
  const real = taintScopes.filter((s) => !UNKNOWN_TURN_TAINT.includes(s))
  const missing = gap && gap.missingScopes.length > 0 ? gap.missingScopes : real
  const named = missing.length > 0 ? missing.join(", ") : "scopes that could not be determined"
  if (gap && typeof gap.lacking === "number" && gap.lacking > 0) {
    const verb = gap.lacking === 1 ? "lacks" : "lack"
    return `Missing scope(s): ${named}; ${gap.lacking} ${lackingNoun(audience, gap.lacking)} who would see what it writes ${verb} them.`
  }
  return `Missing scope(s): ${named}; how many of the people who would see what it writes lack them could not be counted.`
}

/**
 * The refusal the model reads. A bare `{ ok: false, code }` was answered with
 * "I have replied to the ticket" on the Flash Lite bench: nothing in the result
 * said the write did not happen. The rule lives here, at the moment it applies.
 *
 * It names WHAT the turn read and WHERE the write would have taken it. It used to
 * say "some room members lack" the scopes, which the check never looked at, so the
 * one DM where every member held everything read as a platform bug.
 *
 * It names the MISSING scopes and HOW MANY of the people who would see the write lack
 * them, never who (rule 7). And it states the only real remedies, because a model
 * left to guess invented one the product does not have ("open a fresh direct
 * conversation"): a person holding the scopes acts in the app, or an admin adjusts
 * scopes. A new conversation is not a remedy and must never be suggested.
 */
export const SCOPE_TAINT_BLOCKED_MESSAGE = (
  writeTargetTable: string,
  taintScopes: readonly string[],
  audience: ScopeTaintAudience = "sink",
  sinkReadScope?: string,
  gap?: ScopeTaintGap,
): string =>
  `NOT EXECUTED: this conversation has read ${describeTaintScopes(taintScopes)}, and ${describeAudience(writeTargetTable, audience, sinkReadScope)}, so the write to ${writeTargetTable} could disclose it. ${describeGap(taintScopes, audience, gap)} Reads are not affected. Nothing was sent, created or changed. Tell the user the action was blocked by scope taint and why, in the past tense of the attempt ("my attempt to reply was blocked"), never as done; do not retry it this turn. The only remedies are: a person who holds the missing scope(s) performs the action themselves in the app, or an admin adjusts scopes (grants the missing scope(s) to the people lacking them, or removes their access to where this would be written). Starting a new conversation is NOT possible: it does not clear this, so never suggest a new, fresh or separate conversation.`

/**
 * The one refusal left for a tainted gated write's audience (rule 8): nobody who may decide it
 * holds what the turn read. Same remedies as rule 7; it names the deciding scope, never who.
 */
export const SCOPE_TAINT_NO_DECIDER_MESSAGE = (
  taintScopes: readonly string[],
  approveScope: string,
): string =>
  `NOT EXECUTED: this conversation has read ${describeTaintScopes(taintScopes)}, so this action needs the approval of someone who holds those scopes, and nobody holding ${approveScope} (who may approve it) holds all of them. No approval was created. Nothing was sent, created or changed. Tell the user the action was blocked by scope taint and why, in the past tense of the attempt, never as done; do not retry it this turn. The only remedy is that an admin adjusts scopes: grants those scopes to an approver, or ${approveScope} to someone who holds them. Starting a new conversation is NOT possible: it does not clear this, so never suggest a new, fresh or separate conversation.`

/** The apps a taint's data came from, in plain words ("shopify, boxtal, contacts"). */
export function taintSourceApps(taintScopes: readonly string[]): string[] {
  const apps = new Set<string>()
  for (const scope of taintScopes) {
    if (UNKNOWN_TURN_TAINT.includes(scope)) continue
    const [app, resource] = scope.split(":")
    // A kernel scope names its resource (contacts, agent memory), which is what a person reads.
    const name = app === "kernel" ? resource : app
    if (name && name !== "*") apps.add(name)
  }
  return [...apps].sort()
}

/** A manifest entity, as the surface label reads it: its name and its physical table. */
export interface TaintSurfaceEntity {
  name: string
  tableName?: string
}

/**
 * What a tainted proposal's card calls the place it writes to (rule 8): the app entity whose
 * table the write lands in ("this ticket", "this conversation"), read from the app's own
 * manifest entities, else the write target's table name. `targetTables` are the tables the
 * tool declares it writes to or acts on (writesToTable, resourceOwner table), schema-qualified
 * or bare.
 */
export function taintSurfaceLabel(
  targetTables: ReadonlyArray<string | undefined>,
  entities: readonly TaintSurfaceEntity[],
): string {
  for (const target of targetTables) {
    if (!target) continue
    const bare = target.includes(".") ? target.slice(target.lastIndexOf(".") + 1) : target
    const entity = entities.find((e) => e.tableName === bare)
    if (entity) return `this ${entity.name.replace(/_/g, " ")}`
  }
  return targetTables.find((t): t is string => !!t) ?? "where it is written"
}

/** {@link taintSurfaceLabel} for a registered tool, from the live registry of its org. */
export function taintSurfaceLabelForTool(
  orgId: string,
  toolName: string,
  writesToTable?: string,
): string {
  const sep = toolName.indexOf(":")
  const appName = sep === -1 ? toolName : toolName.slice(0, sep)
  const shortName = sep === -1 ? "" : toolName.slice(sep + 1)
  const entities: TaintSurfaceEntity[] = []
  for (const [[, regApp, name], decl] of entityRegistry.entriesOf(orgId)) {
    if (regApp === appName) entities.push({ name, tableName: decl.tableName })
  }
  const owner = approvalResourceOwnerRegistry.get([orgId, appName, shortName])
  const ownerTable = owner && "table" in owner ? owner.table : undefined
  return taintSurfaceLabel([writesToTable, ownerTable], entities)
}

/**
 * The card line of a tainted proposal some readers of its target cannot see (rule 8): approving
 * it is the disclosure, so the card says so, briefly, naming apps and never people or data.
 */
export function taintDisclosureLine(taintScopes: readonly string[], surface: string): string {
  const apps = taintSourceApps(taintScopes)
  const from = apps.length > 0 ? `${apps.join(", ")} data` : "data"
  const line = `Drafted after reading ${from} that some people who can read ${surface} cannot see: approving shares it with them.`
  return line.length <= 200
    ? line
    : `Drafted after reading data some people who can read ${surface} cannot see: approving shares it with them.`
}

/**
 * The card line of an agent post that some people of the conversation it goes to cannot read
 * (rule 11): approving it shares the message with them. `hidden` null: not countable.
 */
export function taintPostDisclosureLine(
  taintScopes: readonly string[],
  hidden: number | null,
): string {
  const apps = taintSourceApps(taintScopes)
  const from = apps.length > 0 ? `${apps.join(", ")} data` : "data"
  const who = hidden === null ? "Some people" : hidden === 1 ? "1 person" : `${hidden} people`
  const line = `${who} in this conversation cannot see ${from} this conversation read: approving shares this message with them.`
  return line.length <= 200
    ? line
    : `${who} in this conversation cannot see data this conversation read: approving shares this message with them.`
}

export function toScopeTaintBlockedError(
  writeTargetTable: string,
  taintScopes: readonly string[],
  audience: ScopeTaintAudience = "sink",
  gap?: ScopeTaintGap,
): ScopeTaintBlockedError {
  return {
    ok: false,
    code: "E_SCOPE_TAINT_BLOCKED",
    writeTargetTable,
    reason: "scope_taint_blocked",
    message: SCOPE_TAINT_BLOCKED_MESSAGE(writeTargetTable, taintScopes, audience, undefined, gap),
  }
}

/**
 * THE PLATFORM'S OWN TAINT REFUSAL, told apart from a handler that merely says so.
 *
 * A call the platform refused by scope taint never ran, so the MCP gateway records nothing of
 * its own scopes into the per-(org, agent) window (recording the refused write's `:write` scope
 * renewed the block on every retry). The code alone cannot say who refused: any handler,
 * sandboxed ones included, can return `{ error: { code: "E_SCOPE_TAINT_BLOCKED" } }` after
 * reading, and matching the code let such a read escape the taint (security review, PoC 5).
 * The dispatch's own refusal is marked with this module-private symbol, which a handler cannot
 * produce: a sandboxed result crosses a serialisation boundary, and `normalizeToolErrorResult`
 * rebuilds every handler error object field by field.
 */
const PLATFORM_TAINT_REFUSAL: unique symbol = Symbol("liaison.platformTaintRefusal")

/** Mark an error object (or a thrown Error) as the platform's own taint refusal. */
export function markPlatformTaintRefusal<T extends object>(value: T): T {
  Object.defineProperty(value, PLATFORM_TAINT_REFUSAL, { value: true, enumerable: false })
  return value
}

/** True only for a refusal marked by `markPlatformTaintRefusal`. */
export function isPlatformTaintRefusal(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [PLATFORM_TAINT_REFUSAL]?: unknown })[PLATFORM_TAINT_REFUSAL] === true
  )
}

/**
 * A CALL THE PLATFORM TURNED DOWN BEFORE ITS HANDLER RAN read nothing, so it adds nothing to a
 * turn's taint. A person without the scope, or arguments that fail the schema: recording the
 * tool's scopes for those tainted the session with what the person may not read, and every later
 * write was refused for scopes nobody had touched.
 *
 * Marked as the taint refusal above is, so a handler cannot claim it. The mark names the tool
 * refused: a handler that ran and lets a nested call's refusal reach its caller carries the
 * nested tool's name, and its own read still counts.
 */
const REFUSED_BEFORE_RUN: unique symbol = Symbol("liaison.refusedBeforeRun")

/** Mark an error object (or a thrown Error) as `toolName`'s refusal before its handler ran. */
export function markRefusedBeforeRun<T extends object>(value: T, toolName: string): T {
  Object.defineProperty(value, REFUSED_BEFORE_RUN, { value: toolName, enumerable: false })
  return value
}

/** True only when `toolName` itself was marked by `markRefusedBeforeRun`. */
export function wasRefusedBeforeRun(value: unknown, toolName: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [REFUSED_BEFORE_RUN]?: unknown })[REFUSED_BEFORE_RUN] === toolName
  )
}

/**
 * Where a turn's scoped reads came from: for each table, the row ids the turn read out of it.
 * The same-resource allowance (A46) is decided against this map and nothing else.
 */
export type TaintOriginRows = Readonly<Record<string, readonly string[]>>

/**
 * The turn's live origin store: what it has filed so far, and the way a read files more. The
 * per-turn accumulator is the implementation; the type exists so a caller that has crossed a
 * hop losing the run frame (the sandbox bridge) can forward the STORE rather than a snapshot
 * of it, which is what lets an in-sandbox read file an origin at all.
 */
export type TaintOriginStore = {
  originRows: () => TaintOriginRows
  recordOriginRows: (table: string, rowIds: readonly string[]) => void
}

/**
 * The SAME-RESOURCE ALLOWANCE (A46, an amendment to A3). A tainted turn that read ticket A and
 * replies to ticket A is the everyday support routine, and refusing it pushed people towards
 * widening scopes to dodge the taint, which is worse than a narrow allowance. So a write is also
 * allowed when it stays on the rows the taint itself came from: the tool must declare its target
 * TABLE and the target ROW, the table must be one the turn read, and every target row must be
 * among that table's origin rows. A different row, a different table, an empty target row list or
 * an undeclared target is refused exactly as before.
 */
function isSameResourceWrite(
  writeTargetTable: string,
  writeTargetRowIds: readonly string[] | undefined,
  originRows: TaintOriginRows | undefined,
): boolean {
  if (!originRows || !writeTargetRowIds || writeTargetRowIds.length === 0) return false
  const origins = originRows[writeTargetTable]
  if (!origins || origins.length === 0) return false
  const allowed = new Set(origins)
  return writeTargetRowIds.every((id) => allowed.has(id))
}

export function checkScopeTaint(
  accumulatedRequiredScopes: string[],
  writeTargetTable: string,
  sameResource?: { rowIds?: readonly string[]; originRows?: TaintOriginRows },
): { allowed: boolean; reason?: string } {
  if (
    accumulatedRequiredScopes.length === 0 ||
    TAINT_ENFORCING_SINKS.has(writeTargetTable) ||
    TAINT_CONTROL_PLANE_SINKS.has(writeTargetTable) ||
    TAINT_LOW_SENSITIVITY_SINKS.has(writeTargetTable)
  ) {
    return { allowed: true }
  }
  if (isSameResourceWrite(writeTargetTable, sameResource?.rowIds, sameResource?.originRows)) {
    return { allowed: true }
  }
  return { allowed: false, reason: "scope_taint_blocked" }
}

// The write target reported for a refused tool that declares none. Not a `schema.table`, so it
// can never be mistaken for a real table.
export const UNDECLARED_WRITE_TARGET = "undeclared"

/**
 * The stand-in for a turn whose accumulated scope set could not be determined:
 * a frame with no accumulator, a persisted set that would not parse. Non-empty,
 * so every check below reads it as a TAINTED turn and an undeclared write is
 * refused; not a real scope string, so it can never be mistaken for one. An
 * empty array is the opposite claim -- "this turn touched no scoped data" --
 * which is precisely what an unreadable value cannot assert.
 *
 * Unknown taint blocks LAUNDERING, it does not stop a turn answering: the three
 * enforcing sinks and a readOnly tool still pass.
 */
export const UNKNOWN_TURN_TAINT: readonly string[] = ["scope_taint:unknown"]

export type ToolTaintDeclaration = {
  readOnly?: boolean
  /** A statically gated tool: judged at the dispatch, where the approval's audience is known
   *  (see the header, consequence 2). */
  gated?: boolean
  writesToTable?: string
  /** The scope every reader of `writesToTable` must hold (consequence 4): the write is judged
   *  at the dispatch against that audience instead of refused here. */
  sinkReadScope?: string
  /** The acting user is the write's only reader (rule 6d): judged at the dispatch by that
   *  user's grants instead of refused here. */
  sinkReadersSelf?: boolean
  /** The requester and the conversation's participants are the write's only readers (rule 6e):
   *  judged at the dispatch by their grants instead of refused here. */
  sinkReadersConversation?: boolean
  /** The table this READ tool reads its rows from, schema-qualified like `writesToTable`. It is
   *  what makes the read an origin for the same-resource allowance; it never authorizes a write
   *  (a tool declaring it and no `writesToTable` is still judged by `readOnly`). */
  readsFromTable?: string
  /** The parameter naming the row this call targets, in the table the tool declares
   *  (`writesToTable` for a write, `readsFromTable` for a read). The value may be a single id or
   *  an array of ids. Without it a write has no row to compare and the allowance cannot apply. */
  targetRowParam?: string
  /** Where the row ids live in this READ tool's RESULT (A46b): a dot path, walked through arrays,
   *  ending either on the ids themselves or on objects carrying an `id`. Absent, the default path
   *  applies: a top-level `id`, or an array of objects each carrying one. */
  resultRowPath?: string
  /** The tool's own scope declarations, read through the single resolver: a read that declares
   *  none, or that is marked taint free, contributes nothing to the turn and so files no origin. */
  requiredScopes?: string[]
  taintFree?: boolean
  /** The ONLY parameters through which this write carries anything of the turn (rule 6f): free
   *  text an audience will read. Called with every one absent or blank, the write carries none
   *  of the turn and taint does not judge it. Declare it only on a write whose every other
   *  parameter is an id or enum naming a row the caller alone may change. */
  contentParams?: readonly string[]
}

/**
 * True when this call writes none of the turn's data (rule 6f): the tool declares the parameters
 * that carry content and every one of them is absent, null or a blank string (a declared empty
 * list: none does). Anything else (an undeclared tool, a filled parameter, a non-string value)
 * is false: fail closed.
 */
export function carriesNoTurnContent(toolDef: ToolTaintDeclaration, args: unknown): boolean {
  const params = toolDef.contentParams
  // An explicit empty list: no parameter carries content (a flag flip on the caller's own row).
  if (!Array.isArray(params)) return false
  if (args !== undefined && args !== null && typeof args !== "object") return false
  const record = (args ?? {}) as Record<string, unknown>
  return params.every((p) => {
    const v = record[p]
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "")
  })
}

/**
 * True when this call goes back to the MCP server the turn's every taint came from (rule 6g).
 * `toolName` is the dispatched `mcp:<slug>:<tool>`: only the tool projector registers under the
 * `mcp` app, and a slug is unique within an org whether the connection is the org's or a
 * person's (uq_mcp_connections_org_slug), so the slug names exactly one server. The call's
 * arguments can carry only what that server returned (and what the person typed), and they go to
 * that same server, so no reader is added. Every taint scope must lie in the server's own
 * namespace: one scope from anywhere else (another server, knowledge, tickets, the unknown
 * sentinel) and the call is judged as any other write, since its arguments could carry that data
 * out. An empty, missing or unreadable taint is false: fail closed. It answers only the scope
 * taint; an untrusted-content hold and the connection's own approval policy still apply.
 */
export function returnsToOwnMcpServer(toolName: string, turnTaintScopes: unknown): boolean {
  const parts = toolName.split(":")
  if (parts.length < 3 || parts[0] !== "mcp") return false
  const slug = parts[1] ?? ""
  if (!isValidSlug(slug) || (parts[2] ?? "") === "") return false
  if (!Array.isArray(turnTaintScopes) || turnTaintScopes.length === 0) return false
  const namespace = connectionToolNamespace(slug)
  return turnTaintScopes.every(
    (s) => typeof s === "string" && (s === namespace || s.startsWith(`${namespace}:`)),
  )
}

/**
 * The server namespace (`mcp:<slug>`) when this call is a READ on that MCP server (rule 6h), else
 * null. A read is decided by the server's annotations through the same function as the connection
 * default policy (readOnlyHint true, destructiveHint not true), so the two cannot drift; an admin's
 * per-tool "Allowed" does not make a write a read. The caller lifts the outside-content hold only
 * when every source of the thread's outside text is this namespace (taint.ts, outsideTextOnlyFrom).
 */
export function mcpReadOfOwnServer(
  toolName: string,
  annotations: McpToolAnnotations | undefined,
): string | null {
  const parts = toolName.split(":")
  if (parts.length < 3 || parts[0] !== "mcp") return null
  const slug = parts[1] ?? ""
  if (!isValidSlug(slug) || (parts[2] ?? "") === "") return null
  return isAnnotatedReadOnly(annotations) ? connectionToolNamespace(slug) : null
}

/**
 * Appended to a taint refusal of a tool declaring `contentParams` (rule 6f): the same call
 * without them writes none of the turn and runs, which is the one retry that is not refused.
 */
export function contentParamsRetryHint(toolDef: ToolTaintDeclaration): string {
  const params = toolDef.contentParams
  if (!Array.isArray(params) || params.length === 0) return ""
  const named = params.join(", ")
  return ` Exception to "do not retry": this tool carries the conversation's data only through ${named}, which would be shown to other people. The same call WITHOUT ${named} writes none of it and is allowed: retry it once without ${named} if the user still wants it.`
}

/**
 * The row ids one call targets, read out of its arguments at the parameter the tool declares.
 * Accepts a single id or an array of them; anything else yields no rows, which is the closed
 * answer (no rows means no same-resource allowance).
 */
export function targetRowIds(toolDef: ToolTaintDeclaration, args: unknown): string[] {
  const param = toolDef.targetRowParam
  if (typeof param !== "string" || param === "") return []
  if (args === null || typeof args !== "object") return []
  const raw = (args as Record<string, unknown>)[param]
  if (typeof raw === "string") return raw === "" ? [] : [raw]
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v !== "")
  return []
}

/**
 * The row ids one call RETURNED, read out of its result at the path the tool declares (A46b).
 * Arrays are walked, so `items.id` over `{items: [{id: a}, {id: b}]}` yields both. Without a
 * declared path the default shape applies: a top-level `id`, or an array of objects carrying one.
 * Anything else yields no rows, which is the closed answer.
 */
export function resultRowIds(toolDef: ToolTaintDeclaration, result: unknown): string[] {
  const path = toolDef.resultRowPath
  let values: unknown[] = [result]
  const segments =
    typeof path === "string" && path !== "" ? path.split(".").filter((s) => s !== "") : ["id"]
  for (const segment of segments) {
    const next: unknown[] = []
    for (const value of values) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === null || typeof item !== "object") continue
        const child = (item as Record<string, unknown>)[segment]
        if (child !== undefined) next.push(child)
      }
    }
    values = next
  }
  const ids: string[] = []
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && item !== "") ids.push(item)
    }
  }
  return ids
}

/**
 * The table and rows this call should record as an origin, or null when it files none (A46b).
 *
 * An origin is filed only for a read that DECLARES the table it reads and the row it was asked
 * for, that CONTRIBUTED requiredScopes to the turn (a scope-free or taint-free read taints
 * nothing, so it can widen nothing either), and only for the rows the call actually RETURNED.
 * A read that failed, was refused, saw nothing, or named a row it did not return files nothing:
 * the caller passes the successful result and this intersects it with what the arguments named.
 */
export function taintOriginOf(
  toolDef: ToolTaintDeclaration,
  args: unknown,
  result: unknown,
): { table: string; rowIds: string[] } | null {
  const table = toolDef.readsFromTable
  if (typeof table !== "string" || table === "") return null
  if (toolDef.taintFree === true) return null
  if (resolveRequiredScopes(toolDef).length === 0) return null
  const named = new Set(targetRowIds(toolDef, args))
  if (named.size === 0) return null
  const returned = new Set(resultRowIds(toolDef, result))
  const rowIds = [...named].filter((id) => returned.has(id))
  return rowIds.length > 0 ? { table, rowIds } : null
}

/**
 * The scope-taint decision for one tool call. Returns null when the call may run, else the
 * error to return in place of the tool's result. An untainted turn allows everything. On a
 * tainted turn a declared write target is checked against the enforcing sinks (it wins over a
 * contradictory readOnly), a readOnly tool passes, and any other tool is refused.
 *
 * `deferGatedToDispatch`: any write that would be refused here is passed on instead (rule 8,
 * 2026-10-20; until then only a gated write and one declaring its readers were). The tool bridge
 * and the MCP gateway set it, because they hand every call to `executeToolCore`, whose own taint
 * boundary judges the write against who will read it and against its approval's audience, and
 * either runs it, parks it for a person who holds the scopes, or refuses it with this same
 * error. Unset, this is the plain rule.
 */
export function checkToolScopeTaint(
  accumulatedRequiredScopes: string[],
  toolDef: ToolTaintDeclaration,
  call?: { args?: unknown; originRows?: TaintOriginRows; deferGatedToDispatch?: boolean },
): ScopeTaintBlockedError | null {
  if (accumulatedRequiredScopes.length === 0) return null
  if (carriesNoTurnContent(toolDef, call?.args)) return null
  let target: string | null
  if (typeof toolDef.writesToTable === "string") {
    target = checkScopeTaint(accumulatedRequiredScopes, toolDef.writesToTable, {
      rowIds: targetRowIds(toolDef, call?.args),
      originRows: call?.originRows,
    }).allowed
      ? null
      : toolDef.writesToTable
  } else {
    target = toolDef.readOnly === true ? null : UNDECLARED_WRITE_TARGET
  }
  if (target === null) return null
  // Every write is judged at the dispatch, which parks what this would refuse (rule 8).
  if (call?.deferGatedToDispatch === true) return null
  const refused = toScopeTaintBlockedError(target, accumulatedRequiredScopes)
  refused.message += contentParamsRetryHint(toolDef)
  return refused
}

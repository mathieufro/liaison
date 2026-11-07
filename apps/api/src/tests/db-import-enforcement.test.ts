// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const srcDir = path.resolve(__dirname, "..")

function findTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...findTsFiles(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(full)
    }
  }
  return results
}

describe("db import enforcement", () => {
  // Allowlist: only these files may import from ~/db/connection or ./connection
  const connectionAllowlist = new Set([
    "db/rls.ts",
    "db/privileged.ts",
    "db/portal-rls.ts", // withPortalContext: the portal role on the request pool, as db/rls.ts does for liaison_rls
    "db/index.ts",
    "infra/events/outbox-worker.ts",
    "modules/health/routes.ts",
    "modules/healthz/index.ts", // Phase 14 — production /healthz dependency probe
    "apps/tickets/read-state.test-fixtures.ts",
    "modules/mcp/test-helpers.ts",
    // Throughput bench harness, run by hand and never by a production build or
    // a test suite: it drives the raw pool to measure mail sync writes.
    "tests/bench/mail-sync-throughput.ts",
  ])

  // Allowlist: only these files may import from ~/db/privileged
  const privilegedAllowlist = new Set([
    // Provisioning CLI: the connection's stored credentials are read in a privileged
    // transaction of the org being provisioned, after the plan's org-less precheck.
    "cli/provisioners/connector.ts",
    // Knowledge sync of a connected database run by a job (no request transaction):
    // the org-owned connection's credentials are read in a short privileged
    // transaction of the source's own org; the database read itself holds no slot.
    "apps/database/knowledge-read-runner.ts",
    "modules/security/security-events.ts", // security signals: the org comes from the event the auth path raised; writes the outbox event and reads the account it names
    // Magic-wand proofread/polish assist service — reads org model config + agent
    // keys via system-db (no per-request RLS context), like other host services.
    "modules/assist/proofread-service.ts",
    // Dictation: the route reads the caller's own "clean up automatically"
    // preference by user id, as proofread-service reads the wand instructions;
    // the transcription model resolver reads the org's settings row and keys.
    "modules/assist/routes.ts",
    "modules/assist/transcription-models.ts",
    // AI models (admin, kernel:org:admin): reads and writes the org's own settings row
    // (`ai.models`, provider keys) under the row lock, and the global model catalogue.
    "modules/settings/ai-models-admin.ts",
    "modules/agent/credits/ai-models-store.ts",
    // Daily refresh of every org's added OpenRouter prices: a cross-org system job.
    "modules/agent/credits/openrouter-price-job.ts",
    // OpenRouter's default made Auto for an org whose only key is OpenRouter's:
    // reads the org's own settings row before writing it under the row lock.
    "modules/agent/credits/openrouter-default.ts",
    "modules/auth/auth.ts",
    "modules/auth/auth-state.ts",
    // First use of a session's access token, stamped on its row before RLS
    // context exists (the auth middleware): a refresh reads it to tell a lost
    // response from a replayed token.
    "modules/auth/session-use.ts",
    "modules/auth/routes.ts",
    "modules/auth/oauth-routes.ts",
    "modules/auth/device-flow-routes.ts",
    "modules/apps/runtime.ts",
    // A stored tool card: a person's card action changes one field of an agent's row (whose write the RLS policy leaves to its author), after the caller's read was checked under their own context.
    "modules/agent/runtime/tool-card-store.ts",
    // Package store: instance-wide apps_installed rows (no org), read and written by the
    // install, boot repair and peer materialise paths, which run outside any request.
    "modules/apps/package-store.ts",
    "modules/apps/bulk-dispatch.ts",
    // A restricted session's hidden thread: its session family (kernel.sessions has no RLS
    // path for this read) and the thread, created for the token's own org and user.
    "modules/apps/rest-tool-call.ts",
    "modules/apps/kernel-bulk.ts",
    "modules/apps/execute-tool.ts",
    // Background and pre-session paths with no request RLS context, each scoped
    // by org id in its own queries:
    // the dispatch session an approved run on the owner's computer starts;
    "modules/nodes/run-on-my-computer.ts",
    // the agent binding of a pending device-flow request, read before a session exists;
    "modules/auth/device-flow-request.ts",
    // inbound mail matching senders against the org's trusted list on the ingest path;
    "modules/contacts/trusted-senders.ts",
    // the org's known guest addresses a taint decision reads;
    "modules/agent/scopes/known-guests.ts",
    // the instance operator org and the install trust record are instance-wide;
    "modules/apps/operator-org.ts",
    "modules/apps/install-trust.ts",
    // the approval row a cross-app caller names as the origin of a send;
    "modules/apps/originating-approval.ts",
    // the acting person's own timezone, read for a placeholder refusal on any dispatch path;
    "modules/apps/outbound-placeholder-refusal.ts",
    // node workers: the owner's nodes for a broadcast, dispatch retries, the MCP
    // connection of a node session and the session push's job scopes.
    "modules/nodes/node-broadcast.ts",
    "modules/nodes/dispatch-retry.ts",
    "modules/mcp/node-session-connection.ts",
    "modules/push/node-session-push.ts",
    "modules/apps/routes.ts",
    // Runtime app install/upgrade/uninstall — instance-wide `apps_installed`
    // writes run outside any per-request RLS context (system-db transactions).
    "modules/apps/install-service.ts",
    "modules/apps/install-routes.ts",
    // App version activation: the instance-wide active-version pointer, the
    // activation events log and the per-app lock (outside any request context).
    "modules/apps/activation.ts",
    // Org runtime release: which of the orgs set up in this process still have
    // an organization row (a system read across orgs, from a timer).
    "modules/apps/org-runtime-release.ts",
    // Phase 16.5 — UI bundle serving route reads kernel.apps_active_version to
    // pin the active version (system-wide; not per-request RLS context).
    "modules/apps/ui-bundle-routes.ts",
    "modules/apps/run-approved-handler.ts",
    // The sandbox rpc-bridge's per-capability factories (composed by rpc-bridge.ts).
    "modules/apps/sandbox/bridge/approvals.ts",
    // calendar_listAccounts ensure-on-read: repairs the CALLER's own account
    // rows (bound to the caller's userId and org) that may be invisible to the
    // caller under RLS, which is exactly the fault being repaired, and purges the
    // org's accounts whose kernel connection was disconnected.
    "modules/apps/sandbox/bridge/calendar.ts",
    // App config write path (PUT /api/apps/:app/config/:key, config apply):
    // instance `kernel.apps.config` rows, written after the route's
    // kernel:apps:admin check and the manifest configKeys allowlist.
    "modules/apps/app-config.ts",
    // The one writer of kernel.org_app_features: a member has no write path on the
    // table, so the row is written privileged after the feature's adminScope is checked.
    "modules/apps/org-features.ts",
    // Declarative app settings (GET/PATCH /api/apps/:app/settings/org):
    // kernel.organizations is deny-all under RLS, so org-scope values are read
    // and written privileged after the route checks the section's adminScope;
    // plus the app_setting:updated event for config and tool writes.
    "modules/apps/settings-routes.ts",
    "modules/apps/sandbox/bridge/conversion.ts",
    "modules/apps/sandbox/bridge/files.ts",
    "modules/apps/sandbox/bridge/knowledge-curation.ts",
    "modules/apps/sandbox/bridge/knowledge.ts",
    "modules/apps/sandbox/bridge/mail.ts",
    "modules/apps/sandbox/bridge/platform.ts",
    "modules/apps/sandbox/bridge/tickets.ts",
    // Provider contracts (kernel dispatch of an app's declared contract op):
    // the binding is kernel org settings no app can write, read per call and
    // written by contracts_setBinding only for a kernel:org:admin acting in
    // person, with an audit row; the caller's mirror column is read from its
    // own schema bound to the org. Every statement binds org_id.
    "modules/apps/provider-contracts/binding.ts",
    "modules/apps/provider-contracts/resolve.ts",
    "modules/apps/sandbox/bridge/contracts.ts",
    // A contract op's provider runs with its own data scopes only: the
    // caller's file the op names is read org-scoped, and only when
    // contracts.call granted it for this call after checking the CALLER
    // could read it under its own RLS context.
    "modules/apps/sandbox/bridge/multipart.ts",
    // The agent runtime's card-claim check: whether the turn's own conversation
    // holds a pending secret request (org- and thread-bound read).
    "modules/agent/runtime/open-cards.ts",
    // An agent's config_invoicing call: the conversation's person messages and
    // attached files, org- and thread-bound, read to check where its legal
    // identifiers came from; and the org's own issuer identifiers.
    "modules/provisioning/legal-identity-grounding.ts",
    "modules/approvals/decide.ts",
    "modules/approvals/edit.ts",
    // Shared approval helpers (loadRequesterContext, emitApprovalStateChange,
    // lockedUpdateApproval, etc.) — extracted from the per-flow files (decide,
    // cascade, expiry) which were already on this allowlist.
    "modules/approvals/event-data.ts",
    // Approval routing: reads away ranges and preferences of the people in one org, and moves
    // the pending requests linked to an item that changed hands, all pinned to that org.
    "modules/approvals/route-world.ts",
    // Away days: the one writer of kernel.away_ranges (no member write path), its daily prune,
    // and the next-in-line column a colleague's read needs, all pinned to one org but the prune.
    "modules/users/away.ts",
    // Away days from a person's own calendar: the daily refresh lists every personal primary
    // calendar and reads each one's stored events in a system transaction of that org.
    "apps/calendar/away-from-calendar.ts",
    "modules/approvals/expiry.ts",
    "modules/approvals/approving-reaper.ts",
    "modules/approvals/cancel.ts",
    "modules/approvals/handler-protocol.ts",
    "modules/approvals/read-decided-result.ts",
    // A sealed sequence step's @ref tokens: inside the decide flow, the earlier
    // approved steps of the same org and sequence are read to check which results
    // the owner's draft may fill in.
    "modules/approvals/fulfilment-refs.ts",
    // Approval reminders: the hourly sweep finds people with stale requests of their
    // own across orgs (one bounded, paged scan), then reads one person's requests,
    // agent and permissions by org id before any request actor exists.
    "modules/approvals/reminders.ts",
    // Routed reminders: the hourly sweep scans pending requests of every org (one bounded,
    // paged read), then reads one org's routes, deciders and people by org id before any
    // request actor exists.
    "modules/approvals/routed-reminders.ts",
    // Phase 13 — compound/sequenced gated operations. The cascade engine, its
    // failure path, and the async-output poll job all run outside any
    // per-request RLS context (decide flow, BullMQ-driven poll/reinvoke).
    "modules/approvals/cascade.ts",
    "modules/approvals/cascade-fail.ts",
    "modules/approvals/poll-output.ts",
    "modules/mcp/connection-service.ts",
    "modules/mcp/connection-thread.ts",
    "modules/mcp/oauth-server-routes.ts",
    "modules/mcp/device-grant-routes.ts",
    "modules/mcp/approval-status.ts",
    "modules/apps/connections/service.ts",
    "modules/apps/connections/routes.ts",
    // An edit form's prefill: the account row is read privileged so an org
    // account's admin guard can run (as the disconnect route does), then only
    // its non-password fields leave.
    "modules/apps/connections/settings.ts",
    "modules/contacts/service.ts",
    // A contact's team references are counted privileged (privilegedFrom): the
    // actor cannot read every referencing table, and the answer is a count.
    "modules/contacts/references.ts",
    // asAdmin asks the transaction whether its login can elevate (transactionRole).
    "modules/sharing/service.ts",
    "modules/mail/service.ts",
    "modules/users/routes.ts",
    "modules/threads/routes.ts",
    // ultrareview: sub-run thread drill-down. listMessages reads a sub-run's
    // output thread under withPrivilegedDb THEN applies app-level authz (the run
    // belongs to the caller's org/approval) — a deliberate privileged read with
    // its own authorization, not an RLS bypass.
    "modules/threads/message.ts",
    // ultrareview: scope-request "attention" — resolves the set of users who
    // hold a given scope (role grants + direct grants) org-wide, with no
    // per-request RLS context; system-db read.
    "modules/permissions/scope-holders.ts",
    // auto-approve policy load — reads instance/org-wide auto-approve policy
    // rows via withSystemDb (system-wide config, outside any per-request RLS).
    "modules/approvals/auto-approve.ts",
    // the summary stored on approval rows a seed wrote outside executeTool: the
    // seed runs with no session, so the load and the write bind org_id and the
    // row ids themselves, and the summarizer itself runs as the requester.
    "modules/approvals/served-summary.ts",
    // the earlier steps a sequenced step's @ref tokens cite (step number, tool,
    // arguments), read to word the step's summary: bound to org_id, the
    // requester and the cited ids; called from executeTool staging and the edit
    // summary rebuild, both already privileged paths.
    "modules/approvals/ref-provenance.ts",
    "modules/org/routes.ts",
    "modules/saved-views/backfill.ts",
    "modules/webhooks/routes.ts",
    "modules/webhooks/tickets-public.ts",
    // Durable event subscribers. Three privileged reads live here, and the
    // third is why this entry stopped being a bare string: it deliberately
    // reads ACROSS orgs, so the containment the slice 2b entries below cite
    // ("it binds org_id") is the one claim it cannot make.
    //   1. mail WS fan-out scope enrichment and 2. the role-member lookup that
    //      closes sockets after a permission change. Both run off the outbox
    //      with no per-request RLS context to borrow (no actor, no session),
    //      and both bind org_id from the event on top of withPrivilegedDb.
    //   3. the audit agent-FK diagnosis. When 0070's COMPOSITE key refuses an
    //      agent id, the constraint name alone cannot say whether the agent was
    //      DELETED or lives in ANOTHER org, and those mean opposite things
    //      (ordinary lifecycle, versus an upstream integrity anomaly that has
    //      to page). An org-scoped handle cannot tell them apart BY
    //      CONSTRUCTION: it sees no row either way and so reports the foreign
    //      agent as deleted, which is the wrong answer at the wrong level.
    //      Contained not by org binding, which would defeat the question, but
    //      by how little the probe can do: it runs on the ERROR PATH only,
    //      selects ONE column (org_id) for ONE id the refused row already
    //      carried, with LIMIT 1; the foreign org's id never enters the audit
    //      row (the id is kept only when the probe proves it is this org's
    //      own); the logs carry that agent id, the two org ids and the action,
    //      never a handle, name or payload; and all four causes end the same
    //      way from outside (the row lands, the consumer succeeds), so nothing
    //      observable distinguishes "no such agent" from "someone else's
    //      agent" and the probe is not an enumeration oracle.
    "infra/events/event-subscribers.ts",
    "infra/jobs/jobs.ts",
    "infra/jobs/kernel-jobs.ts",
    "infra/jobs/sync-model-pricing.ts",
    "modules/agent/credits/credit-service.ts",
    "modules/agent/credits/credit-meter.ts",
    "modules/agent/context/context.ts",
    // Customer auto-context: the org's own mailbox addresses, read org-scoped
    // only to EXCLUDE them when picking a conversation's external sender (the
    // messages themselves are read under the actor's RLS).
    "modules/agent/context/customer-context.ts",
    // Who else reads a reply: the display names of a thread's human
    // participants and its discoverable flag, read by thread id in the turn's
    // own org after the caller checked the asker's participation (the names
    // every participant already sees in the thread header).
    "modules/agent/context/shared-thread-audience.ts",
    "modules/agent/runtime/agent-service.ts",
    // The turn's focus: which app the thread belongs to, read by thread id in
    // the turn's own org (one row, no content), to preload that app's tools.
    "modules/agent/runtime/turn-focus.ts",
    // A visitor's background turn checks whether the same person has since
    // asked the same agent again in that thread (org-bound ids, no content).
    "modules/agent/runtime/superseded-turn.ts",
    // The turn ledger: kernel.agent_turns / agent_turn_events are deny-all to
    // the request roles (they hold tool results), so every read and fenced
    // write goes through the privileged pool, matched on the turn's org.
    "modules/agent/runtime/turn-ledger.ts",
    // The effect ledger: kernel.effect_ledger is deny-all to the request roles;
    // claims and results are written through the privileged pool for the
    // org whose effect it is.
    "lib/effect-once.ts",
    // The load harness: reads (and, for its own signed paths, sets) one org's
    // `settings.loadHarness` flag, matched on that org's id.
    "lib/load-harness.ts",
    // Resuming a turn (S10): the resume job and the orphan sweep read the
    // turn ledger across orgs (the sweep) or for the turn's own org (the
    // actor re-check reads users.status and the person's permissions in it).
    "modules/agent/runtime/turn-resume.ts",
    "modules/agent/context/compaction.ts",
    "modules/agent/tools/web-tools.ts",
    "modules/agent/tools/approval-tools.ts",
    // Phase 13 — chat-tools resolves the agent's attributed author label
    // ("Routine {name}") via a privileged `kernel.routines` lookup, since the
    // routines table is privileged-access only.
    "modules/agent/tools/chat-tools.ts",
    // Phase 13 — skill + routine read/list/search tools touch `kernel.skills`,
    // `kernel.disabled_app_skills`, `kernel.routines` outside any per-request
    // RLS context (cross-source resolution merges DB + in-process registry).
    "modules/agent/tools/skills-routines-tools.ts",
    // Phase 13 — routine worker reads/writes kernel.routines + routine_runs
    // outside any user request context (BullMQ-driven). System-level.
    "modules/agent/routines/routine-worker.ts",
    // A tick's report to the conversation it was asked in: reads the routine's
    // own output thread and the report thread's seats from the BullMQ worker,
    // outside any request context. Reads only; the post goes through the owner's RLS.
    "modules/agent/routines/routine-report.ts",
    // A run paused on a held call resumes from the decision job, outside any
    // request context: reads the run's approvals and its own messages, and
    // writes its own routine_runs row. Org-scoped; the resumed turn runs as the owner.
    "modules/agent/routines/routine-run-resume.ts",
    // A run waiting for its owner's private mailbox: the worker parks it (its own
    // routine_runs row, the owner's Home item), the 24 h expiry sweep runs from a
    // cron job, and Run now re-checks ownership itself (owner = signed-in user)
    // before claiming the row. Ids and times only, never mail content.
    "modules/agent/routines/routine-mailbox-wait.ts",
    // The decision job reads the decided approval's origin (thread, requester,
    // routine) to wake the chat turn or the paused routine run that asked for it.
    "modules/approvals/approval-result-turn.ts",
    // A scope-request decision reads the target user's live grants and the
    // org's installed app scopes (both privileged-access tables) to grant only
    // what each side lacks; the grants themselves run under the approver's RLS.
    "modules/scope-requests/service.ts",
    // After the decision commits, the announcement reads the decider's name and
    // the requesting agent's label to write the conversation's system row.
    "modules/scope-requests/announce.ts",
    // Secret requests (the agent's request_secret card): what the target's
    // store holds is read from org settings, oauth_providers, connected_accounts
    // and the tickets API keys (fingerprints of ciphertext, never a secret), org
    // from the row; status changes (save, cancel, expiry sweep) and the claim of
    // the agent's follow-up turn are privileged so no RLS role can set them.
    "modules/secret-requests/stored.ts",
    "modules/secret-requests/service.ts",
    // After a save commits, the announcement reads the saver's name to word the
    // conversation's line, and the follow-up turn reads whether the
    // conversation moved on and the requester's grants.
    "modules/secret-requests/announce.ts",
    // A connect card is settled by the OAuth grant that stored its account:
    // the person who finished the grant's grants are read to run the same
    // completion check the card's own Save runs.
    "modules/secret-requests/connect-settle.ts",
    // The IMAP credentials card shows the hosts, ports and username of the
    // mailbox from the APPROVED config_mail / config_tickets call: a read of
    // approval_requests by org, tool and status, whatever the viewer's
    // approval visibility, and only for a viewer who may submit the card.
    "modules/secret-requests/approved-settings.ts",
    "modules/agent/scopes/taint.ts",
    "modules/agent/runtime/auto-title.ts",
    "modules/agent/credits/credit-routes.ts",
    // Phase 13 — skills + routines REST routes resolve cross-author skill
    // visibility (personal vs org-shared vs app-shipped) outside any single
    // per-request RLS context, mirroring the underlying tool handlers.
    "modules/agent/skills/skills-routes.ts",
    "modules/agent/routines/routines-routes.ts",
    "modules/settings/ai-keys-routes.ts",
    "modules/settings/google-integration.ts",
    "modules/mail/provider-settings.ts",
    // API connector: org-owned adapter rows, credentials and the audit row,
    // each scoped to the org explicitly (the routes check the app scopes).
    "apps/api-connector/store.ts",
    "apps/api-connector/service.ts",
    // The customer resolver's domain fallback excludes the org's own mailbox
    // and inbox domains: configuration, read org-scoped, only ever to exclude.
    "apps/api-connector/customer.ts",
    // Database connector report access: the org's domainAccess setting (one
    // jsonb key, org-scoped by id) and the caller's own role memberships, read
    // for the per-domain read check; written only after the route checks
    // kernel:apps:admin and every named role and person belongs to the org.
    "apps/database/domain-access-store.ts",
    "modules/database/routes.ts",
    "apps/tickets/admin.ts",
    // Close silent tickets: the per-org scan of inboxes with the option on, the
    // acting person's active row and permissions, and the cancel of a pending
    // nudge or no-response close when the customer replies. Org-scoped.
    "apps/tickets/close-silent.ts",
    "apps/tickets/create.ts",
    "apps/tickets/jobs.ts",
    // The ticket participant rule excludes the org's own inbox addresses:
    // configuration, read org-scoped, only ever to exclude, never to reveal.
    "apps/tickets/participants.ts",
    // The tickets helpers' privileged reads (SLA settings, category, assignee,
    // ID segment): on the caller's privileged transaction when it passes one,
    // else on their own, org-scoped either way.
    "apps/tickets/privileged-read.ts",
    "apps/tickets/tools.ts",
    "apps/tickets/read-state.test-fixtures.ts",
    // Google Drive connector — `driveImport` materialises a downloaded Drive
    // file into a `kernel.files` row (privileged INSERT + upload session)
    // outside any per-request RLS context, like the tickets host tool logic.
    "apps/google-drive/tools.ts",
    // Drive disconnect purge: deletes the Knowledge content synced on the
    // disconnected connection. The rows belong to the disconnected user, not to
    // whoever triggered the kernel event, so it runs privileged, org-scoped in SQL,
    // after verifying the connection is disconnected.
    "apps/google-drive/disconnect.ts",
    // Drive picker (picked mode): reads the caller's Drive accounts (their own, or the
    // org's for a connection admin, checked in code) and writes the picked items into
    // the account's metadata; the sync job loads the picks with no request context.
    // Org-scoped in SQL.
    "apps/google-drive/picker.ts",
    // The one-time Picker page has no session: it resolves the ticket owner's Drive
    // token from the ticket (bound to org, person and account) through a system read.
    "apps/google-drive/picker-page.ts",
    // Pick lines of an agent's card: reads the picker's display name for the line,
    // and the ids the person picked through one card (their own system lines on
    // that thread, by the card's origin). Org-, thread- and author-scoped in SQL.
    "apps/google-drive/picker-announce.ts",
    // An org Drive connection's shared drives: org-owned connected accounts are
    // invisible to RLS (only kernel rows are), so the listing, the choice (admin
    // scope checked in code) and the admins' attention item read them privileged.
    // Org-scoped in SQL.
    "apps/google-drive/shared-drives.ts",
    // What an org Drive connection already put in Knowledge: the org's Drive folders
    // and their documents are hidden (archived) or, outside the chosen drives, deleted
    // by the sync job and the org's setup, with no request context; the account the
    // folder syncs through is resolved through a system read. Org-scoped in SQL.
    "apps/google-drive/org-drive-content.ts",
    // Mail disconnect purge: deletes a disconnected mailbox's imported mail and
    // its attachment file rows (kernel.files) outside any request RLS context;
    // org-scoped in SQL.
    "modules/mail/purge-account.ts",
    // OAuth grant revocation: after a disconnect commits, checks whether another
    // active connection on the instance holds the same provider account (a
    // system read answering only a boolean) before revoking at the provider.
    "modules/apps/connections/revoke.ts",
    // Google setup guide: reads which OAuth client minted each connected account
    // (a system read of the org's own rows, client ids only) to decide which
    // Google APIs and scopes still need enabling; org-scoped in SQL.
    "modules/connection-guides/google.ts",
    // Shopify setup guide: reads which protected scopes the org opted in to (its
    // own app settings row, scope names only) so the generated shopify.app.toml
    // lists them; org-scoped in SQL.
    "modules/connection-guides/plan.ts",
    // Before-disconnect hooks: loads the connection row (route, after the caller's
    // own access check) or the org's active connections (org purge) to run the
    // owning app's cleanup while the token is still valid; org-scoped in SQL.
    "modules/apps/connections/before-disconnect.ts",
    // Knowledge synced-sources: the reconciler and CRUD service write under
    // withPrivilegedDb because they materialize collections + documents
    // outside any per-request RLS scope (system-trusted sync flow).
    "apps/knowledge/synced-sources.ts",
    "apps/knowledge/sync-reconciler.ts",
    "apps/knowledge/knowledge-jobs.ts",
    "lib/server.ts",
    // Phase 10 — search indexer/reindex, file storage workers, attention
    // translation + digest workers, and the Phase 10 boot orchestrator all
    // legitimately use the privileged DB role (system-level reads and writes
    // outside any user RLS context).
    "infra/boot-phase10.ts",
    "modules/attention/translator.ts",
    "modules/attention/state-materializer.ts",
    "modules/attention/digest-jobs.ts",
    // Cron fan-out: the tick lists every org with the app's per-org state (a
    // system read, no org yet) and the reconcile reads active app versions.
    "infra/jobs/fanout-runtime.ts",
    "modules/search/indexer.ts",
    "modules/search/service.ts",
    "modules/search/reindex.ts",
    // Mail search documents are built host-side from the mail rows (the
    // conversation's envelope, one fragment per message), like the ticket and
    // mail enrichment hooks: org-scoped reads under BYPASSRLS, gated at query
    // time by the search permission filter.
    "apps/mail/search-enrichment.ts",
    "modules/files/routes.ts",
    "modules/files/thumbnail-job.ts",
    "modules/files/orphan-gc.ts",
    // Import uploads: org-scoped reads and writes of the caller's own upload
    // rows (orgId and userId from the authenticated request), the quota sum
    // across the org's open uploads, and the cross-org reaper.
    "modules/imports/uploads/routes.ts",
    "modules/imports/uploads/service.ts",
    // Import runs: run rows and the undo ledger (privileged only, FORCE RLS
    // deny-all), batch writes pinned to the run row's org after the runner
    // checked the person's scopes, and the job rebuilding that person's
    // permissions from started_by (authority.ts)...
    "modules/imports/runner.ts",
    "modules/imports/runs.ts",
    "modules/imports/undo.ts",
    // ...the person's live permissions for cancel and undo, the ledger
    // recovery sweep, and the stale-run sweep (lists stalled runs of every
    // org on the system pool, then fails each in its own org).
    "modules/imports/authority.ts",
    "modules/imports/recover.ts",
    "modules/imports/sweep.ts",
    // Transform sources: the run's pinned transform version read by id in the
    // run's org, and the org's own storage quota before a download is staged.
    "modules/imports/transform-run.ts",
    // Whole-org export (org-archive): the archive reads the whole org through
    // the privileged pool filtered by org_id, after the route's
    // kernel:org:admin check or the operator's CLI (catalog discovery, batch
    // reads, the org_exports rows and their expiry sweep across orgs).
    "modules/export/org-archive/catalog.ts",
    "modules/export/org-archive/store.ts",
    "modules/export/org-archive/writer.ts",
    // `liaison org export`: the operator resolves an org by id (system pool).
    "cli/org-export.ts",
    // Per-org caps: the caps live on `organizations` (unreadable under RLS),
    // and seats / mailboxes / storage are counted for the whole org whatever
    // the acting person may see (counts only, never rows). The job cap reads
    // an org's cap from the job dispatch, outside any request. `liaison org
    // caps` resolves an org by id (system pool).
    "modules/org/caps.ts",
    "infra/jobs/org-job-cap.ts",
    "cli/org-caps.ts",
    "modules/permissions/default-roles.ts",
    // Org-config tools, multi-app export, GDPR erasure, and
    // the full-instance export CLI are privileged, cross-org, system-level
    // operations (no user RLS context). Test helpers bootstrap orgs/contexts
    // outside any request.
    "modules/apps/enabled-apps.ts",
    // `open_app`: a shop domain for a record whose only page is elsewhere, as the references route.
    "modules/agent/tools/navigation-tool.ts",
    "modules/agent/tools/org-config-tools.ts",
    // Agent config tools (the section runner's tool path): org-scoped reads the
    // runner and its checks need regardless of the actor's own row visibility
    // (the org's identity, its stored role scopes and memberships for the
    // scope and admin lock-out checks, the config export's readers). Every
    // write still goes through the provisioners as the approving person.
    "modules/agent/tools/config-tools.ts",
    "modules/provisioning/config-admin-guard.ts",
    "modules/provisioning/config-export.ts",
    "modules/provisioning/config-section-scopes.ts",
    // The first run: the setup checklist counts the org's own rows (users,
    // invitations, mailboxes, roles, imports, documents, connector credentials)
    // whatever the reader may see, and returns counts only; the kickoff
    // re-checks "is this workspace new" and loads the admin's grants and
    // personal agent before posting as that admin under RLS; the tool loads
    // the caller's own grants to say whether they can configure.
    "modules/provisioning/setup-state.ts",
    "modules/provisioning/setup-kickoff.ts",
    "modules/agent/tools/setup-state-tool.ts",
    // Guided provider setup: reads the caller's own language (their row and the
    // org default) to render the guide, and attaches the generated Shopify app
    // file to the message it posts, the same privileged attach threads_reply uses.
    "modules/agent/tools/setup-guide-tools.ts",
    // Sub-agent dispatch primitive — the kernel spawnAgent() path runs
    // outside any per-request RLS context (BullMQ-driven subrun worker,
    // hidden-thread creation, and the agent_runs row insertion are all
    // system-level). The CRUD service writes `sub_agent_definitions` from
    // routine + kernel-tool handlers that already hold the orgId scope.
    "modules/agent/subruns/spawn-agent.ts",
    "modules/agent/subruns/sub-agent-definitions.ts",
    "modules/agent/subruns/subrun-await.ts",
    "modules/agent/subruns/subrun-worker.ts",
    "modules/erasure/erase-user.ts",
    "cli/export-full.ts",
    "cli/keys-rotate.ts", // operator key rotation: re-encrypts every org's stored secrets in one system transaction
    "tests/helpers/org.ts",
    "tests/helpers/agent-ctx.ts",
    "tests/helpers/import-files.ts",
    // The security suite's seeds: the few rows no product path writes (a file on
    // a thread, an undeclared dimension grant, a participant removed). Not
    // loaded by a production build.
    "tests/security/seeds.ts",
    // Test fixture: deactivates the instance-wide active app versions a test seeded.
    "tests/helpers/seeded-app-rows.ts",
    // S19 boot-flat seed: sets up hundreds of orgs through the seed factories, outside any request context.
    "tests/e2e/cell/boot-flat-seed.ts",
    // Phase 14 — integration test for the permissionVersion-bump contract reads
    // the bumped column directly (no request context). System-level read.
    "tests/permission-version-bump.test.ts",
    // Phase 14 — version-check reads org.update_checks_enabled cross-org via
    // privileged db (no per-request RLS context; runs on Redis-cached schedule).
    "modules/admin/version-check.ts",
    // Phase 15 — inbound MCP / aggregator. Connection bootstrap, runtime state,
    // and resource notifications run outside any per-request RLS context.
    "modules/mcp-client/index.ts",
    "modules/mcp-client/env-bootstrapper.ts",
    "modules/mcp-client/resource-notifier.ts",
    // MCP OAuth token refresh: runs at dial time (no request context), the refresh under
    // an advisory lock on the system pool, the token write-back on the org's privileged one.
    "modules/mcp-client/oauth-tokens.ts",
    // Phase 15 — mcp-manager app: cross-org repo, OAuth callback handler, and
    // its routes operate against kernel.mcp_* tables outside per-request RLS.
    "apps/mcp-manager/routes.ts",
    "apps/mcp-manager/oauth-routes.ts",
    "apps/mcp-manager/repo.ts",
    "apps/mcp-manager/test-helpers/world.ts",
    // PDF rendering runs in a job/system context: render writes under a
    // per-org privileged tx (`pdf:render`) and reads template files via
    // system-db; registry-rehydrate reads kernel.apps_active_version system-wide.
    "modules/pdf/render.ts",
    // Document templates: a PDF form template's row, its sanitized file row and
    // the link between them land in one transaction pinned to the caller's org
    // (as pdf/render.ts stores a rendered PDF), after the route's admin check.
    "modules/documents/service.ts",
    // A template preview is staged for the caller like a merged PDF (pdf/merge.ts): the quota
    // check and the file row run under a privileged tx pinned to the caller's org.
    "modules/documents/preview.ts",
    "modules/pdf/registry-rehydrate.ts",
    // Message post exposes a `privileged` capability to handlers — system-level
    // writes scoped by org via withPrivilegedDb.
    "modules/messages/post.ts",
    // Contact-primary thread bootstrap finds-or-creates the shared thread and
    // upserts the caller as a participant under a privileged, org-scoped tx so a
    // non-creator caller is visible under threads_select before posting.
    "modules/threads/contact-primary.ts",
    // An entity's discussion (a contact's, or any app entity declaring one) is
    // found or created and the caller seated only after their own RLS proved
    // they see the entity; it drops its enrolled people when the entity's
    // sharing changes (they re-enrol by opening it), and is deleted with the
    // entity: removing other people's participant rows and messages needs the
    // privileged, org-scoped tx.
    "modules/threads/entity-discussion.ts",
    // Knowledge content-cache downgrade invalidates cache entries under a
    // privileged, org-scoped tx (the curator role lacks knowledge:cache:manage).
    "apps/knowledge/sources.ts",
    // Test helper: runs assertions through the real liaison_rls role boundary
    // and seeds actor/role data via privileged setup.
    "tests/helpers/rls-boundary.ts",
    // Component A — app-provided agent-assets reconciler. Seeds default-disabled
    // app skills, sub-agent definitions, and pause/resume of instantiated app
    // routines via withPrivilegedDb: the inserts target kernel.disabled_app_skills
    // / sub_agent_definitions / routines whose RLS WITH CHECK requires the
    // kernel:* write role the request context does not hold (install/activate
    // runs outside any per-request RLS scope).
    "modules/apps/reconcile-assets.ts",
    // --- Regularized when this suite first reached CI --------------------
    // `apps/api/src/tests/**` had never been part of any test-run suite, so this
    // guard ran for the first time against a tree that already held the
    // importers below (all of them fail identically on origin/main). They are
    // listed so the ratchet works again for NEW code. Every one is a
    // system-level path with no per-request RLS context to borrow: operator
    // CLIs, auth and bootstrap before a session exists, mailbox key material
    // and plaintext invariants, approval/export machinery, background jobs and
    // test harnesses - the same category as the reviewed entries above.
    // Appending here is NOT a licence to skip the public API for new code.
    "apps/tickets/link-ingest-job.ts",
    // Operator CLI that asks a named agent from the terminal (#19): resolves the
    // org and the agent before any request actor exists.
    "cli/agent/ask.ts",
    "cli/connect/index.ts",
    // Operator CLI that prints a connection guide: reads the org's default locale
    // before any request actor exists (one bound SELECT by org id).
    "cli/guide/index.ts",
    "cli/invoicing/import.ts",
    "cli/lib/resolve-org-id.ts",
    // Operator CLI that reports what is left to set up: reads the org's active
    // connected accounts before any request actor exists (one SELECT by org id).
    "cli/setup/state.ts",
    // Guided tours: the operator CLI resolves the member and starts/polls their
    // progress row before any request actor exists; the tour-progress durable
    // consumer advances the event actor's own rows (every statement binds org_id).
    "cli/lib/resolve-member.ts",
    // Operator CLI that reminds one member of their waiting requests: resolves a
    // member given by uuid (one SELECT bound to the org) before any actor exists.
    "cli/approval-reminders.ts",
    "cli/tour/run.ts",
    "modules/tours/consumer.ts",
    // A tour run that asks the agent finds (or makes) the person's DM with their
    // personal agent at start, from the route and from the CLI (no request actor
    // there); it reads only that person's own agent and permissions in that org.
    "modules/tours/conversation.ts",
    // A tour step's status (beat-status.ts) is read for the person whose run
    // it is, from rows their RLS context may not reach on its own (a routine's
    // runs, the approvals their agent's turn parked, the org's active runs to
    // nudge): every statement binds org_id, and the reads are narrowed to that
    // run's own entities, conversations and user.
    "modules/tours/beat-status.ts",
    "cli/mailbox-purge.ts",
    "cli/mailbox-verify-attachment.ts",
    // Operator import of another tracker's history, run by hand with no
    // request actor: it creates deactivated users for unknown people, writes
    // backdated task rows, and inserts the historical comments into
    // kernel.messages with NO event (a live post would notify everyone), as
    // the Slack importer does. Every statement binds the resolved org_id.
    "cli/projects/import.ts",
    "cli/provisioners/types.ts",
    "cli/search/reindex.ts",
    // `liaison app status | rollback`: the operator reads every org's persisted
    // app problems (kernel.apps problem columns, joined to the org slug) and,
    // for a rollback, the orgs that have the app On so it is registered there
    // before the health gate; no request actor, org ids from the database only.
    "cli/app/manage.ts",
    "cli/slack/import.ts",
    "cli/tickets/backfill-attachments.ts",
    "cli/tickets/import.ts",
    "cli/tickets/inbox.ts",
    "infra/seed-model-pricing.ts",
    "modules/agent/routes.ts",
    "modules/approvals/approval-policy.ts",
    // The Home feed's approval rows: reads the last handler failure (the same
    // approved_handler_executions read list.ts does for the card) and the org's
    // tickets setting; both read-only, both bound to the feed's org_id.
    "modules/approvals/attention.ts",
    "modules/approvals/list.ts",
    "modules/approvals/resolve-ref.ts",
    "modules/approvals/resource-owner.ts",
    "modules/approvals/restage.ts",
    "modules/approvals/withdraw.ts",
    "modules/apps/catalog.ts",
    "modules/apps/connections/attention.ts",
    // One-time connect links: the target member by address in the given org, and
    // the mint/redeem audit rows (connect-links.ts header).
    "modules/apps/connections/connect-links.ts",
    // Disconnect by address: the org's connections of that address (owners of
    // every kind, the decision is made after), then the Settings disconnect
    // path for org AND personal rows (an org row is invisible to liaison_rls).
    "modules/apps/connections/disconnect-account.ts",
    "modules/apps/connections/oauth-client-provisioning.ts",
    // The one OAuth client resolver: reads the org's own client (oauth_providers
    // row, or its Google client setting) for the org it is asked about.
    "modules/apps/connections/oauth-client.ts",
    "modules/auth/google-login-provider.ts",
    "modules/auth/magic-link.ts",
    "modules/files/media-analysis-job.ts",
    "modules/mailbox-crypto/approval-payload.ts",
    "modules/mailbox-crypto/attachment-derivatives.ts",
    "modules/mailbox-crypto/backfill-job.ts",
    "modules/mailbox-crypto/identity-resolver.ts",
    // Server-managed mailbox keys: kernel.mailbox_server_keys is invisible to
    // liaison_rls (RLS forced, no policy). The opener reads the key and the
    // account's owner privileged, then refuses anyone but that owner (or a host
    // job for them), and audits every read; the agent's server-side reader
    // resolves which mailbox a marker names before handing it to the opener.
    "modules/mailbox-crypto/managed-keys.ts",
    "modules/mailbox-crypto/managed-open.ts",
    // The mailbox encryption mode (the deployment default reads every org; the
    // org switch and a person's pick are read for that org and person), the
    // owner-only switches between modes, and the owner's own mailbox list for
    // the setup card: every query is bound to the caller's org and user.
    "modules/mailbox-crypto/encryption-mode.ts",
    // Sharing with the Liaison team: instance-wide switches, identity and the
    // outbox (kernel.instance_settings, kernel.control_plane_outbox), RLS
    // forced with no policy, so only the privileged pool reaches them. No org
    // or person data is read except the instance-wide active user count.
    // Forwarding a bug report: reads the switches and identity, queues the
    // report and its attachment rows (no org data beyond what the reporter approved).
    "modules/liaison-team/bug-report-payload.ts",
    "modules/liaison-team/heartbeat.ts",
    // lead-forwarding.ts queues the demo server's own leads (kernel.demo_leads,
    // privileged-only) and reads the played tour ids of a demo workspace.
    "modules/liaison-team/lead-forwarding.ts",
    "modules/liaison-team/outbox.ts",
    // Managed edition boot check: reads the instance-wide liaison team identity
    // (kernel.instance_settings, privileged only) before any request.
    "lib/managed-boot.ts",
    // Mints and installs a provisioned identity (kernel.instance_settings)
    // under the liaison team lock, from the CLI; no org data.
    "modules/liaison-team/provisioned-identity.ts",
    // An org's link base: reads only the org's slug by id, before any actor.
    "lib/org-public-url.ts",
    // Host binding: the org id a request's host names, read by slug before any
    // actor exists (the auth middleware, refresh, WebSocket and MCP checks).
    "lib/org-host.ts",
    // The signed Control→cell API (managed edition): its idempotency store
    // (kernel.cloud_request_outcomes, RLS forced with no policy) and the
    // instance key read before any org is known; creating an org and reading
    // its owner for a handoff are pre-actor writes and reads bound to that org.
    // Money (no actor either): the billing push and the state served from it,
    // credit grants, the instance-wide credit rate, the workspace lookup by
    // email across orgs, and the admins' auto top-up attention item.
    "modules/cloud/attention.ts",
    // The managed Billing page (admins only, scope checked by the mount): the
    // instance key that signs its calls to the control plane, and the org's
    // usage counts a plan change sends (seats, org mailboxes, storage, apps),
    // read for the caller's own org only.
    "modules/billing-managed/control-client.ts",
    "modules/billing-managed/usage.ts",
    "modules/cloud/billing.ts",
    "modules/cloud/create-org.ts",
    "modules/cloud/credit-rate.ts",
    "modules/cloud/credits.ts",
    "modules/cloud/lookup.ts",
    "modules/cloud/handoff.ts",
    "modules/cloud/outcomes.ts",
    "modules/cloud/verify.ts",
    // Managed money without an actor: the daily usage report sums every org's
    // billed rows from a job, the auto top-up check reads the org's pushed
    // setting after a deduction, and the managed AI-usage view reads the org's
    // own balance and billing state by id (credits_balance is privileged only).
    "modules/cloud/storage-estimate.ts",
    "modules/cloud/usage-report.ts",
    "modules/cloud/auto-topup-trigger.ts",
    // The billing status the control plane pushed (kernel.org_billing_state,
    // privileged only), read by id on every request, job and paid call before
    // or outside any actor; the side-call gate's attribution user (a job has no
    // actor) read by the org's id.
    "modules/cloud/billing-status.ts",
    "modules/agent/credits/managed-side-call.ts",
    // Signed Control→cell pushes bound to the org they name (no actor): the
    // org's verified mail sender, the operator's custom-app kill switch, and the
    // delete timer's org load before the shared deletion core.
    "modules/cloud/mail-sender.ts",
    "modules/cloud/custom-app-disable.ts",
    "modules/cloud/delete-org.ts",
    // The server's own inbound callbacks (Gmail push, Meta): one per provider for
    // the whole server, resolved to the orgs a delivery concerns before any
    // actor exists.
    "modules/cloud/cell-webhooks.ts",
    // The cell's org header for a move between instances: the org's frozen
    // state, read per request before any actor exists.
    "modules/cloud/cell-header.ts",
    // An org transfer between cells runs outside any person's request: the
    // transfer state an org's sweeps and writers consult, the after-commit
    // steps (credential revocation, outbox) and the purge of a copy no longer
    // needed, each bound to the one org being moved.
    "modules/org/transfer-state/state.ts",
    "modules/org/transfer/after-commit.ts",
    "modules/org/transfer/purge.ts",
    // Which orgs may see an org-private custom app: the instance-wide app
    // registry's tenant boundary, read before any request context.
    "modules/apps/app-org-scope.ts",
    // The daily audit-log retention job: one DELETE over every org from a job.
    "modules/org/audit-retention.ts",
    "modules/agent/credits/managed-money.ts",
    "modules/liaison-team/settings.ts",
    // team-only.ts stages a team-only report's ticked files as kernel.files rows
    // no user can read (no fileParent) and sweeps them with their outbox rows;
    // it tells the reporter's org admins of a report that was never delivered.
    "modules/liaison-team/team-only.ts",
    "modules/mailbox-crypto/mode-switch.ts",
    // A transparent mailbox's gated-send draft: sealed under the mailbox key,
    // opened for the mailbox owner only (card and send).
    "modules/mailbox-crypto/managed-approval.ts",
    "modules/mailbox-keys/encryption-mode-routes.ts",
    "modules/agent/tools/mailbox-setup-tool.ts",
    // Connect-link sender's display name (one bound SELECT by user id in the org).
    "modules/agent/tools/connection-tools.ts",
    "modules/agent/mailbox-plaintext/mailbox-managed-reader.ts",
    "modules/mailbox-crypto/purge.ts",
    "modules/monitor/index.ts",
    "modules/org/email-from.ts",
    "modules/pdf/merge.ts",
    "modules/search/doc-builder.ts",
    "modules/search/enrichment.ts",
    "modules/provisioning/ensure-org.ts",
    "modules/provisioning/ensure-user.ts",
    // The demo instance. Every one of these reads or writes ACROSS the request's
    // RLS context by construction: the marker on `organizations.settings` has to
    // be readable before any tenant context exists (a pre-auth signup, an
    // egress check on a sandbox call), the spend ledger is billing state a
    // tenant role cannot see, and the signup and the nightly reset create and
    // collect whole orgs. All of it is dead on a normal deployment: the first
    // line of each is the demo-mode gate.
    "modules/demo/routes.ts",
    "modules/demo/demo-org.ts",
    "modules/demo/demo-reset.ts",
    "modules/demo/demo-expiry.ts",
    "modules/demo/demo-spend.ts",
    // The visitor's recap counts every agent message and approval of their own
    // workspace, rooms they are not in included (a routine's run): one org,
    // pinned by the route's requireVisitorOrg, counts only.
    "modules/demo/demo-recap.ts",
    // The org purge core (deleting an org in every store): the demo reaper's
    // collection of an expired workspace and an operator's org deletion. It
    // reads and deletes one org's rows by catalog (FORCE RLS would hide them
    // from any request role), marks the org deleting, checks the kernel
    // immutability triggers and counts the residue. Every destructive entry is
    // guarded on the stored org row (deleting_at, or the demo guard).
    "modules/org/purge/rows.ts",
    "modules/org/purge/purge-org.ts",
    "modules/org/purge/residue.ts",
    "modules/org/purge/deleting.ts",
    "modules/org/purge/immutable-triggers.ts",
    // An operator's org deletion (modules/org/delete): the deletion ledger and
    // the legal archive index (instance tables, privileged pool only, FORCE RLS
    // with no policy), the legal archive's catalog-driven read of one org's
    // legal rows, files and audit log before the purge, and the CLI's gates
    // (the org row, its exports). Every write is pinned to the org the operator
    // named, after the gates.
    "modules/org/delete/start.ts",
    "modules/org/delete/ledger.ts",
    "modules/org/delete/legal-archive.ts",
    "cli/org-delete.ts",
    // Same demo family: extends a visitor org's marker expiry after a real
    // connection, from an outbox consumer and the MCP health tracker (no
    // request context), and reads the MCP connection's org to find it.
    "modules/demo/demo-connected-ttl.ts",
    "modules/demo/shopify/connection.ts",
    // The demo org's API connection: an org-owned connected_accounts row (the
    // RLS role cannot insert one) holding only the fixture sentinel.
    "modules/demo/api-connector/connection.ts",
    // The demo org's Boxtal connection: the same org-owned row, holding only
    // the sentinel keys (its carrier is answered in-process, never reached).
    "modules/demo/boxtal/connection.ts",
    // Same demo family: the seeder writes the demo org's fixtures with no actor
    // yet, and the warehouse connection row is org-owned, which the
    // connected_accounts policies refuse to insert under the RLS role.
    "modules/demo/demo-seeder.ts",
    "modules/demo/warehouse/connection.ts",
    // Same demo family: the warm pool picks the oldest ready org ACROSS orgs
    // (`FOR UPDATE SKIP LOCKED` on kernel.organizations) and renames its owner
    // before any visitor or tenant context exists. Demo mode only.
    "modules/demo/demo-pool.ts",
    // Same demo family: the signup's lead row lives in kernel.demo_leads, an
    // instance table with no org_id (the lead outlives the visitor org), so no
    // tenant context can read or write it. Reached only from demo routes.ts,
    // behind its demo-mode gate.
    "modules/demo/demo-leads.ts",
    // Same demo family: email verification marks that same kernel.demo_leads
    // row verified (and counts verified leads per domain and network for the
    // caps), and finds the visitor's own account when a link is opened with no
    // session. Reached from demo routes.ts behind its demo-mode gate, and from
    // the spend gate, which reads it only for an org carrying the demo marker.
    "modules/demo/demo-verification.ts",
    // Same demo family: the recorded coding session plays on a simulated node
    // off a timer and resumes on the leader at boot, so no request context of
    // the visitor's org exists to borrow; it writes that org's node, session
    // and session events the way the node WS handler does. It refuses a
    // non-demo org before it reads anything.
    "modules/demo/replay/replay.ts",
    // Same demo family: a demo scenario's world beat runs off the outbox (the
    // demo-world consumer) or a retry, with no request context of the owner's
    // org to borrow. The registry reads and moves the owner's tour row and
    // keeps its once-per-beat mark in kernel.demo_world_marks (an instance
    // table liaison_rls cannot reach); the injectors write their fixed live
    // event (a ticket, an inbound mail) the way the inbound channels do,
    // system-side, and find the seeded teammate a comment is written as. Every
    // one is refused outside a demo org before it reads anything.
    "modules/demo/world/registry.ts",
    "seed/world/people.ts",
    "modules/demo/world/support-ticket.ts",
    "modules/demo/world/chat-question.ts",
    "modules/demo/world/sales-email.ts",
    "modules/demo/world/projects-comment.ts",
    // The knowledge world beat posts the seeded support teammate's question in
    // the demo org's #support channel and dispatches the mentioned agent with
    // that teammate's own permissions; reached only through the registry,
    // which refuses it outside a visitor demo org.
    "modules/demo/world/knowledge-lucas-asks.ts",
    // The commerce world beat's live order is held in the demo store's memory;
    // after a restart it is re-derived from the beat's succeeded mark in
    // kernel.demo_world_marks (an instance table liaison_rls cannot reach),
    // scoped to the demo org the store is answering for.
    "modules/demo/world/commerce-order.ts",
    // The demo tier of the seed engine creates a demo org and fills it with the
    // whole world through the product's services, as its bootstrap register
    // and system jobs are privileged; every entry refuses an org that is not a
    // demo org (seed-org.ts demoMarkRefusal) before it writes.
    "seed/tiers/demo/seed-demo.ts",
    "seed/tiers/demo/seed-org.ts",
    // The seed engine's factories write a seeded org the way the product does:
    // the org's bootstrap register through the provisioning CLI, account-level
    // writes on kernel.users, agents (privileged-write by design), the database
    // domain access setting and the saved-view defaults a first registration
    // writes. Each takes the org its tier created or adopted.
    "seed/factories/agent/agents.ts",
    "seed/factories/org/apps.ts",
    "seed/factories/org/org.ts",
    "seed/factories/people/people.ts",
    "seed/factories/people/role-grants.ts",
    // Bare rows for tests (an org, a user, a role, an audit entry; a connected
    // account, an MCP connection, a pending event; an org's billing state and
    // credit rows) written over the system connection as the provisioning and
    // billing paths write them, each bound to the org the test names.
    "seed/factories/org/rows.ts",
    "seed/factories/org/platform-rows.ts",
    "seed/factories/billing/billing.ts",
    // A kernel.files row with no object behind it, written as the upload and mail import
    // paths write it (privileged), for tests that fake the storage read.
    "seed/factories/files/file-row.ts",
    // The minimal tier (one row per call, for tests): privileged reads only, of
    // the org's admin, a role id by name and the permissions a minted token
    // carries; every write goes through the product service as a person.
    "seed/tiers/minimal.ts",
    // The support, knowledge, project, calendar, mail, thread and approval
    // factories: each writes through the product's own services where one
    // exists (tickets admin ops and createTicket run privileged in the product
    // too; the knowledge sync reconciler runs in the sync worker), and writes
    // privileged only the history no request path produces on demand (a
    // ticket thread's later messages and answered survey, a sync that ran a
    // while ago, decided approvals) or the unarmed plaintext mail the mailbox
    // invariant allows. Reads (a person's effective permissions, a room's
    // message count, role and skill ids) are the privileged reads the auth
    // middleware and workers make. Each takes the org its tier created or
    // adopted through its SeedContext.
    "seed/factories/approvals/requests.ts",
    "seed/factories/knowledge/synced-sources.ts",
    "seed/factories/mail/conversations.ts",
    "seed/factories/people/actors.ts",
    "seed/factories/support/inboxes.ts",
    "seed/factories/support/ticket.ts",
    "seed/factories/support/tickets.ts",
    "seed/factories/threads/threads.ts",
    // The commerce and agent factories write the history a seeded
    // org would have accrued over time, which no request path can produce on
    // demand: a bundled app's own tables (written by its handlers in the
    // sandbox, no host session), skills and routines (the kernel's tools write
    // them privileged after their scope check; here the clamp against the
    // owner's effective permissions), audit and memory rows of turns, jobs and
    // approvals that never ran. Each takes the org its tier created or adopted
    // through its SeedContext.
    "seed/factories/agent/activity.ts",
    "seed/factories/agent/memory.ts",
    "seed/factories/agent/presence.ts",
    "seed/factories/agent/routines.ts",
    "seed/factories/agent/skills.ts",
    "seed/factories/commerce/accounting.ts",
    "seed/factories/commerce/invoicing.ts",
    "seed/factories/commerce/monitoring.ts",
    "seed/factories/commerce/shipping.ts",
    "seed/factories/commerce/social.ts",
    "seed/factories/people/contacts.ts",
    "seed/factories/people/membership.ts",
    "seed/factories/people/read-state.ts",
    // The lively tier's activity factories: the history two weeks of a desk at
    // work leaves (finished agent turns, routine and sub runs, attention and its
    // delivery log, ticket timelines, messages placed at their instant), which
    // only time produces. Each writes into the org its SeedContext names.
    "seed/factories/agent/routine-runs.ts",
    "seed/factories/agent/sub-runs.ts",
    "seed/factories/agent/turns.ts",
    "seed/factories/attention/events.ts",
    "seed/factories/threads/history.ts",
    "seed/factories/timeline/entries.ts",
    "seed/tiers/lively/seed-lively.ts",
    // The standard tier (the test-lane world) seeds its fixed QA people,
    // knowledge and resting rows into the org it created or adopted: named
    // privileged writers for rows the product only reaches through time or
    // review, every instant an offset from the seed context's clock.
    "seed/tiers/standard/knowledge.ts",
    "seed/tiers/standard/people.ts",
    "seed/tiers/standard/rows.ts",
    "seed/tiers/standard/seed-standard.ts",
    // The load tier's bulk volume writer: thousands of rows per org in one
    // statement per kind, into the org its SeedContext names (the one raw-SQL
    // writer the seed rules allow), then counted and read back under RLS.
    "seed/bulk/volume.ts",
    "modules/threads/reference-display.ts",
    "modules/threads/references-routes.ts",
    "modules/agent/mailbox-plaintext/mail-plaintext-redaction.ts",
    "modules/agent/media/media-analysis-tool.ts",
    // Whether a mail attachment's mailbox is private is read privileged and fails closed:
    // the no-persist decision must not depend on what the caller can see.
    "modules/agent/media/mail-attachment-read.ts",
    // A file's origin (inside the org or from outside) is read privileged: what
    // decides the analysis taint and the attachment allowance must not depend on
    // what the caller can see.
    "modules/files/origin.ts",
    "modules/agent/tools/watch-tools.ts",
    "tests/e2e/helpers/mailbox-harness.ts",
    // --- The agent kernel (epic slice 1a/1b) -----------------------------
    // kernel.agents and the agent-asset tables are privileged-write BY DESIGN
    // (1a-A13/A15: their RLS policies grant SELECT only, so every write goes
    // over the privileged connection), and ceiling recompute/offboard/archive
    // run outside any one request's RLS scope.
    "modules/agent/directory/archive.ts",
    "modules/agent/directory/base-agent.ts",
    "modules/agent/skills/effective-skills.ts",
    "modules/agent/directory/offboard.ts",
    "modules/agent/directory/personal-agent.ts",
    "modules/agent/directory/routing.ts",
    // --- Slice 2b security services --------------------------------------
    // Each of these was reviewed against "can it use the RLS-scoped handle
    // instead", and each needs the privileged one for a reason recorded here.
    //
    // Reactive visibility, DELIVERY side. Runs off the outbox / Redis ws-fanout
    // with no per-request RLS context at all (no actor, no session), and the
    // rows it needs are ANOTHER user's role membership and that user's own
    // participated thread ids, so there is no caller context to borrow and a
    // synthetic one would itself need a privileged permissions read. Contained
    // by: orgId comes from the event, both queries bind org_id in the predicate
    // on top of withPrivilegedDb(orgId), targets are narrowed to users this
    // process has connected, each payload carries that user's own thread ids
    // and never any content, and delivery is org-scoped: the WebSocket manager
    // sends a resolved payload on the affected user's sockets in the EVENT'S
    // OWN org (`listOrgConnections`), so a person with a tab open in two orgs
    // never sees org A's thread ids arrive on their org B socket. That last
    // step used to match on the user id alone, which made this entry's
    // containment claim wider than the code.
    "services/security/grant-invalidation.ts",
    // Add-member visibility warning (`wouldRevealHiddenHistory`). The question
    // is what is hidden from the CANDIDATE, so a read as the ASKER returns the
    // wrong row set by construction, and loadEffectivePermissions (the
    // production permissions path) takes a privileged client because a
    // cross-user grant lookup is not the actor's own row. Contained by: the
    // caller's own RLS client authorises the question first (a non-participant
    // gets a flat false and never learns the thread exists), orgId comes from
    // that RLS-visible thread row and is bound in the message predicate, the
    // privileged read selects only the id and the two visibility columns
    // (never content, author or timestamps), and the answer is a bare boolean.
    "services/security/visibility.ts",
    // Share anyway: one short block resolves the acting agent's scope_ceiling
    // from kernel.agents (privileged-access by design, 1a-A13/A15) and the
    // requester's LIVE effective grants. The live read is why the block needs
    // the privileged handle, but the live set is never used on its own: the
    // disclosure runs at the live grants INTERSECTED with the scopes the
    // requester's own session carries, which refuses a scope revoked since the
    // token was minted (a stale token would otherwise disclose it) and equally
    // refuses one granted since (every other route refuses it until the
    // requester re-authenticates). Contained by: orgId is requester.orgId after
    // asserting the caller IS the requester, both reads bind orgId, the result
    // is narrowed by the caller's own session scopes, the block returns only
    // scope strings and an agent id, and every message read, the disclosure
    // write and the audit row run on the requester's own RLS client.
    "services/security/share-anyway.ts",
    // Message search indexer: a BullMQ job off the durable outbox consumer with
    // no user context. It must read a message that no single user may be able
    // to read, because the scope filter is applied at QUERY time (T26) from the
    // indexed required_scopes, not at index time - the same category as the
    // already-listed search indexer/service/reindex entries. Contained by: the
    // read binds org_id as well as the id, so a stale or forged event id cannot
    // pull another tenant's row into this org's documents; the Meili document
    // id is namespaced by org; and the document carries no disclosure list,
    // author, mentions, metadata or thread id.
    "modules/search/message-indexer.ts",
    // --- Slice 3b / 4m / 6b / 6d / 7: the agent runtime ------------------
    // Each line says what has no per-request RLS context to borrow, so a
    // reviewer can check the claim by opening the file and looking at the
    // withPrivilegedDb/withSystemDb call it names. None of them is a request
    // reading the caller's own rows through a privileged handle.
    //
    // kernel.agents and the agent-asset tables are privileged-write BY DESIGN
    // (1a-A13/A15: their RLS policies grant SELECT only), so every route that
    // writes one needs the privileged handle whatever context it runs in.
    "modules/agent/directory/definition-routes.ts",
    "modules/agent/memory/memory-routes.ts",
    "modules/agent/local-sessions/local-session-routes.ts",
    // The claim sweep runs outside any request actor: a BullMQ tick walks
    // every org's lapsed local claims and dispatches the turns the departed
    // machine owed, so there is no session to borrow a context from.
    "modules/agent/local-sessions/local-claim-lapse.ts",
    // The turn credential of a desktop local turn, checked on the MCP gateway
    // before any person's context exists (the call carries the agent's
    // connection token): the live local claim and the desktop connection row
    // (kernel.mcp_connections is privileged-access), bound to org, user and
    // agent.
    "modules/agent/local-sessions/turn-credential.ts",
    // Same tick, one table along: the reaper deletes the hidden side threads a
    // finished sub-run left behind, cross-org, on a schedule.
    "infra/jobs/agent-side-thread-reaper.ts",
    // Outbox consumer bookkeeping. kernel.durable_consumer_marks grants
    // liaison_admin and nobody else (0089), so the RLS handle cannot read it.
    "infra/events/consumer-marks.ts",
    // The PUBLIC branding read, served before anyone has logged in: the login
    // screen needs the org's name and logo and there is no session yet.
    "modules/branding/routes.ts",
    // Which tools an agent may reach: kernel.agents again, read by the MCP
    // projection on behalf of a connection rather than a user.
    "modules/mcp/agent-tool-policy.ts",
    // Push fan-out and the badge count run off the outbox with no actor at
    // all: they resolve ANOTHER user's tokens, grants and participation, which
    // is by construction not a read the recipient's own context could perform.
    // The registration routes are NOT here: kernel.push_tokens (0088) carries
    // full row level security on (org_id, user_id) granted to liaison_rls and
    // the routes write only the caller's own row, so they run on the request
    // RLS handle like any other self-owned write.
    "modules/push/fanout-consumer.ts",
    "modules/push/badge-count.ts",
    // The dispatch guard asks whether SOMEBODY ELSE'S machine holds the local
    // claim on this thread; a context scoped to the poster sees no such row and
    // would answer no, which is the double-reply the claim exists to prevent.
    "modules/threads/agent-dispatch-guard.ts",
    // Discoverable-channel seat counts: how many people and which agents are in
    // a channel the caller has NOT joined, so the caller's own context cannot
    // see the participant rows being counted. Also the system view of one
    // thread's seats (`readThreadParticipantsAsSystem`) for a check that must
    // count a participant hidden from the caller (the import tools' "private
    // to the caller" test); the seats never go back to a client.
    "modules/threads/thread.ts",
    // Agent memory and its consolidation. The episodes, checkpoints and region
    // summaries live on the agent-asset tables (privileged-write by design),
    // and consolidation plus checkpoint advance run on a job tick, not a
    // request. memory-search and memory-recall re-check the taint of a thread
    // the agent may reach but the asking user may not, which is the whole point
    // of the re-check.
    "modules/agent/memory/memory-search.ts",
    "modules/agent/memory/memory-recall.ts",
    "modules/agent/memory/consolidation.ts",
    "modules/agent/context/checkpoint.ts",
    // The org's conversation history settings (`settings.ai.history`): read on
    // every bounded history load and written by the admin settings route.
    "modules/agent/context/history-settings.ts",
    // The org's OpenRouter blocked hosts (`settings.ai.models.blockedHosts`): read
    // (cached) by every OpenRouter chat request to keep those hosts out of its routing.
    "modules/agent/providers/openrouter-blocked-hosts.ts",
    // Idle compaction job: checks the org and thread still exist before it summarizes.
    "modules/agent/context/warm-compaction.ts",
    // The roster the agent picker shows: every agent in the org, read off
    // kernel.agents.
    "modules/agent/context/agent-roster.ts",
    // The acting agent's tool discoveries: the column on the thread and the
    // rows after the agent's own checkpoint, read for the agent, not for the
    // user who happened to mention it. A withheld or hidden row still carries
    // the tool the agent unlocked on it, and the asking user may not see it.
    "modules/agent/context/discovery-window.ts",
    // Knowledge pointers are an agent-asset table (privileged-write by design,
    // migration 0050), stamped after the knowledge write already passed RLS.
    "modules/agent/knowledge/knowledge-pointers.ts",
    // Mention picker secondary labels: one fact per exact id the picker already
    // resolved; the rows themselves are not one actor's own.
    "modules/search/mention-secondary.ts",
    // Channel handle collisions: a handle is unique org wide but a caller sees
    // only the rooms they sit in. Handles only leave the query.
    "modules/threads/thread-handle.ts",
    // The entity a thread belongs to, named in its notifications: the push
    // and inbox fanout read the entity's label for the thread's own members,
    // who see the entity it was created from. Labels only leave the query.
    "modules/threads/thread-anchor.ts",
    // --- Reached through `await import("~/db/privileged")` -----------------
    // These three were invisible to this guard until the detector learned the
    // dynamic form; each is the same shape as the static entries above.
    //
    // GDPR data-subject export: the memory half walks the agent-asset tables
    // (privileged by design) for every agent that holds an episode about the
    // subject, which is by construction not one actor's own rows, and the
    // bundle is written to object storage under the same handle.
    "modules/export/data-subject-export-tool.ts",
    // Boot-time app discovery: which installs are first-party is read off the
    // instance-wide kernel.apps_installed before any request exists.
    "modules/apps/init.ts",
    // An org's setup stamp is read and written by the org setup itself, before
    // and outside any request, under the cell-wide org-setup advisory lock.
    "modules/apps/setup-stamp.ts",
    // Agent re-invocation off a BullMQ job. The idempotency guard reads the
    // thread's messages with no session to borrow a context from; the reply
    // itself goes back through withRlsContext.
    "modules/agent/runtime/reinvoke.ts",
    // --- Search vectors: offline per-org jobs ------------------------------
    // Both run as BullMQ jobs over one org at a time with no actor to borrow a
    // context from, the same category as the side-thread reaper above. Each
    // binds org_id in every statement it issues: the backfill walks the org's
    // messages to embed them (a message no single user may read still needs its
    // vector, because scope filtering happens at query time), and the clusterer
    // reads the org's kernel settings and writes kernel.search_document_clusters.
    "infra/jobs/embedding-backfill.ts",
    "infra/jobs/near-duplicate-clusters.ts",
    // Memory verbs `memory_episode` / `memory_open`: episodes and brief rows live
    // on the agent-asset tables (privileged by design, like memory-search and
    // memory-recall above). Contained by: org_id bound on every read, and the
    // artefact is returned only after the caller's own thread membership is
    // checked (the privileged copy of the row's RLS policy).
    "modules/agent/tools/kernel-tools.ts",
    // Stage-time preflights for gated admin and contact tools. Existence-only,
    // org-scoped probes that return a boolean or the missing ids: a preflight
    // runs as the REQUESTER and must never refuse on visibility (that is the
    // approver's RLS decision at execution), only on a row genuinely absent from
    // the org. No row content crosses back to the caller.
    "modules/agent/tools/admin-tools.ts",
    "modules/agent/tools/contact-tools.ts",
    // --- Local nodes (S20-S24) ------------------------------------------------
    // node_jobs, node_sessions and node_permission_prompts grant liaison_rls
    // SELECT only (0127, 0130): every job, lease, session and prompt write is
    // privileged by design, and each statement binds org_id. Reads of the
    // caller's own nodes go through the caller's RLS (nodes_owner).
    // Job lifecycle: dispatch, node-credential claim/heartbeat/result, and the
    // lease sweep (a BullMQ tick across every org, by construction), and
    // whether a node published the import protocol (import-requests.ts).
    "modules/nodes/jobs.ts",
    // Node-credential routes: job results persist under the owner's own RLS;
    // the privileged reads are the requester's live grants (another user) for
    // the link-back and the owner's SDK session on a node-written row.
    "modules/nodes/job-routes.ts",
    // Credential hash lookup before any tenant is known (a pre-auth read).
    "modules/nodes/credentials.ts",
    // Connected-interval bookkeeping off the WebSocket lifecycle and its sweep.
    "modules/nodes/presence.ts",
    // A node asks its owner: the job is fenced by lease holder, and the prompt
    // row has no INSERT grant for liaison_rls.
    "modules/nodes/permission-prompts.ts",
    // A node reports its chat turn's steps: node credential, no user context;
    // the job is read fenced by org, lease holder and generation.
    "modules/nodes/turn-progress-routes.ts",
    // Routes a poster's request to ANOTHER user's node: the owner's grants and
    // DM are not the poster's to read.
    "modules/nodes/routing.ts",
    // The allow step is taken by an admin or the agent owner, not the node
    // owner whom attachments_owner admits; route lookup reads every owner's
    // attachments of the org; display names cover users and agents.
    "modules/nodes/attachments.ts",
    // The room shows every member's node runtime, and a PUT must see another
    // owner's row to refuse it (409); RLS admits only the caller's own.
    "modules/nodes/thread-settings.ts",
    // A node job's reply scope: the room floor spans every participant's grants.
    "modules/nodes/job-taint.ts",
    // A node publishes its capabilities (shared folders with paths, models,
    // level pins): kernel.node_capabilities grants SELECT only (0140, D37); the
    // row is keyed by the credential's own node, owner and org. The level pins
    // of the owner's nodes are read for a profile save (D42), owner-bound.
    "modules/nodes/routes.ts",
    // --- Node sessions (P1) ----------------------------------------------------
    // node_sessions, node_session_events, node_level_confirmations and
    // node_capabilities grant liaison_rls SELECT only (0140): every write is
    // privileged by design and binds org_id; client reads go through RLS.
    // The session store: create, server-numbered append fenced by node and
    // lease generation (D33), projection; the owner's mute and import delete
    // (routes-me.ts checks ownership through RLS first) and the owner-bound
    // lookup of sessions holding a CLI id (the import start, import.ts).
    "modules/node-sessions/store.ts",
    // Session start resolution: the owner's nodes with their capabilities
    // (folder names only, owner-bound) and one node's folder path for its own
    // session row; node_capabilities is written privileged and read here
    // without a request context (dispatch, routine claim).
    "modules/node-sessions/resolve.ts",
    // Level confirmations (D24, D41): the one insert (after the owner's own
    // session, node and agent were checked through RLS), the attach of a save
    // or start, the claim lookup, and the node's consume bound to its own
    // node id; every statement binds org_id and the owner.
    "modules/node-sessions/confirmations.ts",
    // The app start (P1-T19) and the import start (import.ts): the owner's
    // personal agent is created on first use (agents is written privileged by
    // design), bound to org and owner.
    "modules/node-sessions/create.ts",
    // The owner's commands (P3, D36): the per-session seq and the command row
    // (node_session_commands grants INSERT through RLS, but the seq comes
    // from node_sessions, written privileged), the server's state machine
    // under the row lock, bound to org and owner.
    "modules/node-sessions/commands.ts",
    // A session's life across runs (P3, D36): pause on presence, the node's
    // report (fenced to its own runs), dead runs, resume runs and the lease
    // sweep's session part (a system sweep across orgs, like jobs.ts').
    "modules/node-sessions/lifecycle.ts",
    // The post-back (S60) runs off the session status hook with no actor: the
    // job's reply scope, the once-per-end claim on node_sessions (SELECT only
    // for the app role), the card, agent and node names and the owner's live
    // grants, each bound to the session's org. The post itself is written as
    // the owner under their own RLS context.
    "modules/node-sessions/post-back.ts",
    // --- Scope taint and local context -----------------------------------------
    // Readers' gaps and room floors: every org member's (or participant's)
    // effective grants, which no single caller's context can read.
    "modules/agent/scopes/taint-approval-audience.ts",
    // The holder's live grants, the agent's checkpoints (agent-asset table,
    // privileged by design) and the recall audit rows kept for the thread.
    "modules/agent/local-sessions/local-context-scopes.ts",
    // Event routines run off the dispatcher with no actor: the owner's grants,
    // and an existence probe that tells "hidden from the owner" from "deleted".
    "infra/jobs/event-routine-gate.ts",
    // Each process's event-bus subscriptions for event routines, kept in step
    // with the routines table cell-wide (boot, reconnect, leader takeover, a
    // timer): it reads every org's enabled event routines (id, org, event,
    // filter) with no actor. Read-only; the org id it reads binds each handler.
    "infra/jobs/event-routine-subscriber.ts",
    // The event routines' delivery guarantee, a scheduled kernel job with no
    // actor: it walks every org's event routines, reads their events back from
    // the audit log and their runs, and checks a ticket message still needs
    // triage. Every per-org read binds org_id.
    "modules/agent/routines/routine-event-reconciler.ts",
    // The routine worker's judge of a finished tick (BullMQ, no actor): the
    // routine agent's own messages in its output thread since the tick began,
    // bound to org and thread.
    "modules/agent/routines/routine-tick-outcome.ts",
    // --- Notifications and push (no actor: outbox, BullMQ, WebSocket hello) ----
    // Durable consumer: the approval's notify audience, bound to org and id.
    "modules/approvals/prompt-materialize.ts",
    // The per-workspace app state cache and its writes (kernel.apps rows of
    // every app, the org's grant tables for restricted apps, permission_version
    // of every member): read and written for the org with no request actor.
    "modules/apps/org-apps.ts",
    "modules/apps/org-app-service.ts",
    // The admin's app list (installed registry + this org's rows) and the
    // uninstall guard, which counts the other workspaces that still have an app.
    "modules/apps/org-app-admin.ts",
    // notification_deliveries grants liaison_rls SELECT only; the 30-day
    // retention purge runs across every org on a schedule.
    "modules/notifications/delivery-log.ts",
    // The 10 s desktop fallback (BullMQ) and the reconnect replay read the
    // recipient's deliveries and receipts with no request actor.
    "modules/notifications/desktop-emitter.ts",
    // Device credentials are privileged-only (0128 USING false); an endpoint
    // re-registered by another user is taken off every other row on purpose
    // (fix2-F1); receipts have no INSERT grant for liaison_rls.
    "modules/notifications/devices.ts",
    // The router loads the RECIPIENT's preferences, rules and devices for a
    // fan-out decision, never the poster's.
    "modules/notifications/router.ts",
    // Settings › Notifications: the caller's org time zone (the quiet-hours
    // fallback) is in kernel.organizations, deny-all to liaison_rls.
    "modules/notifications/settings.ts",
    // On call: the org's on-call list (kernel.organizations.settings, deny-all
    // to liaison_rls) and its active members, read for c.get("orgId"); written
    // only by a kernel:org:admin of that org.
    "modules/notifications/routes.ts",
    // Web Push for the fan-out (no actor). A caller with its own RLS client
    // passes it and the read runs there (test-send does).
    "modules/push/web-push.ts",
    // The name a push is signed with: kernel.organizations (deny-all to
    // liaison_rls), read for the fan-out with no actor, one column by org id.
    "modules/push/org-label.ts",
    // Computer session notices off the status hook (no actor): marks the
    // owner's earlier notice rows read, bound to org, owner and session.
    "modules/push/node-session-notify.ts",
    // --- Regularized: importers that predate this branch -------------------------
    // Operator CLIs, run by hand against one org or the instance.
    "cli/config/verify.ts",
    "cli/contacts/apply-provenance.ts",
    "cli/contacts/privatize-mailbox-senders.ts",
    "cli/files-purge-deleted-message-attachments.ts",
    // Attaches historical files to imported tasks as backdated kernel.files
    // rows under their original uploader (or an import placeholder), which no
    // caller's RLS context can write; every statement binds the resolved org.
    "cli/projects/attach-files.ts",
    // Test fixture, never loaded by a production build.
    "modules/threads/__fixtures__/reply-thread-fixture.ts",
    // The ticket id segment lives on kernel.organizations (deny-all to RLS).
    "apps/tickets/display-handle.ts",
    // The allowed mail domains live on kernel.organizations (deny-all to RLS).
    "modules/apps/connections/mail-domains.ts",
    // Owner-attached skills for context composition: skills_select needs a
    // kernel scope members lack; bound to org, author and the visibility filter.
    "modules/agent/skills/owner-skills.ts",
    // The agent copy of the web files routes (listed above): upload quota and
    // the kernel.files row a confirm creates, bound to the token's org.
    "modules/agent/tools/file-tools.ts",
    // Counts of org-owned app connections, which connected_accounts_select
    // hides from every user; counts only leave the query.
    "modules/apps/connection-overview.ts",
    // Bug reports are open to every member, most of whom hold no tickets
    // scope: the ticket is created privileged, like the public tickets webhook.
    "modules/bug-reports/service.ts",
    // Only the operator purge (cli/files-purge-deleted-message-attachments) of
    // attachments whose message is already deleted; a user's own message
    // delete runs inside the caller's transaction, not through this handle.
    "modules/files/message-attachments.ts",
    // The per-object storage lock: an object key's fate is decided against any
    // row that references it, and the relay recheck binds org_id.
    "modules/files/service.ts",
    // Sender contacts resolved during mail sync (no actor), bound to the org
    // and the mailbox's audience.
    "modules/mail/sender-contacts.ts",
    // The send check reads other mailboxes' envelopes on purpose: a reply in a
    // colleague's mailbox still stops a send. Reads only, and it names no text.
    "modules/mail/send-guard.ts",
    // The new-mail producer off the outbox (no actor): the account, the
    // recipient's locale (kernel.organizations) and the replay check.
    "modules/notifications/mail-producer.ts",
    // Mailbox key material, the same category as modules/mailbox-crypto above:
    // the enrollment attention provider runs for the materializer job too, and
    // a reset deletes the owner's mailbox across tables under one lock.
    "modules/mailbox-keys/attention.ts",
    "modules/mailbox-keys/reset.ts",
    // The MCP connection's label for the plaintext consent prompt
    // (kernel.mcp_connections is privileged-access), bound to org and id.
    "modules/mcp/mcp-mailbox-plaintext.ts",
    // Admin merge of an import placeholder: both ids are proven to be this
    // org's first, then every table that references a user is rewritten,
    // many of which carry no org_id to bind.
    "modules/users/merge-placeholder.ts",
  ])

  // Allowlist: only these files may import { sql } from ~/db
  const sqlAllowlist = new Set([
    "index.ts", // Server startup (RLS role check)
    "lib/shutdown-phases.ts", // graceful shutdown closes the pool (sql.end())
    "tests/route-test-setup.ts", // Test infrastructure (TRUNCATE)
    "tests/helpers/app-schema-lock.ts", // Test infrastructure (sql.reserve for advisory locks)
    // Test infrastructure, the same category as its app_schema-lock sibling: it
    // renames an app schema aside so a fixture can own the name, then renames it
    // back. `ALTER SCHEMA ... RENAME TO` and `CREATE SCHEMA` are DDL on the
    // CLUSTER, outside any org, so there is nothing for an RLS handle to bind and
    // no query builder that expresses them. Not loaded by a production build.
    "tests/helpers/app-schema-fixture.ts",
    // Test template build (scripts/lib/test-template.ts): inserts and then deletes
    // the throwaway org the app schema registration runs for, on a database no
    // request ever reaches, outside any org's RLS context. Not loaded by a server.
    "db/apply-app-schemas.ts",
    // Test infrastructure, the same category as its app-schema siblings: it
    // counts lock waiters in pg_locks / pg_stat_activity, cluster catalogs
    // outside any org, on a connection other than the blocked test
    // transaction's. Not loaded by a production build.
    "tests/helpers/pg-lock-waiters.ts",
    // E2E world seeding, the same category as tests/route-test-setup.ts above:
    // both build an org, its users, roles, grants, agents and threads from
    // nothing before a server exists to ask, so there is no API to seed
    // through. Neither is loaded by a production build.
    "tests/e2e/agent-coordination/harness.ts",
    "tests/e2e/agent-memory/helpers/long-memory.ts",
    // Test infrastructure, the same category as its app-schema siblings above:
    // it borrows `kernel.files`'s SELECT policy for the length of one test file.
    // DROP POLICY / CREATE POLICY is DDL on the CLUSTER, outside any org, so
    // there is nothing for an RLS handle to bind and no query builder that
    // expresses it. Not loaded by a production build.
    "tests/helpers/files-select-policy.ts",
    // Test fixture: writes the cell's pushed credit pricing, an instance-wide
    // setting outside any org. Not loaded by a production build.
    "tests/helpers/credit-pricing.ts",
    // Test fixture, the same category: seeds a managed org with its billing
    // state, balance and user (privileged-only tables) for the side-call tests.
    // Not loaded by a production build.
    "tests/helpers/managed-openrouter.ts",
    // Test fixture, the same category as tests/helpers/org.ts: it seeds a
    // thread with replies before any API exists to seed through. Not loaded by
    // a production build.
    "modules/threads/__fixtures__/reply-thread-fixture.ts",
  ])

  // Allowlist: only these files may reference _publishEventInternal
  const publishEventAllowlist = new Set([
    "infra/events/event-bus.ts", // Definition
    "infra/events/outbox-worker.ts", // Outbox worker consumes from outbox
    // The B9 security seed synthesizes audit-rowing events outside any
    // production code path; it is not loaded by production builds.
    "tests/security/seeds.ts",
    // Phase 15 — inbound MCP aggregator publishes events (tool-call audit,
    // resource notifications) outside any per-request RLS context.
    "modules/mcp-client/index.ts",
  ])

  const allFiles = findTsFiles(srcDir)

  /** Source with `//` line comments and block comments removed. The checks
   *  below match identifiers textually, and a file that only NAMES a forbidden
   *  symbol in prose (e.g. attention/translator.ts explains in a comment which
   *  publish path an insert failure blocks) is not a caller of it.
   *
   *  A block comment is only recognised where one OPENS A LINE, or where it
   *  opens and closes on the same line. A bare `[\s\S]*?` sweep from any `/*`
   *  swallowed a real import in `tests/e2e/helpers/mailbox-harness.ts`, whose
   *  `/*` lives inside a string: everything up to the next `*\/` several
   *  hundred lines later went with it, which reads to the scan as "this file
   *  imports nothing". */
  function code(src: string): string {
    return src
      .replace(/\/\*[^\n]*?\*\//g, "")
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
  }

  it("_publishEventInternal only imported by allowlisted infrastructure files", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      if (USES_PUBLISH_INTERNAL.test(src) && !publishEventAllowlist.has(rel)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  it("no production file imports publishEvent (old name) from event-bus", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      // Match imports of the old publishEvent name (not the renamed _publishEventInternal)
      if (
        /import\s*\{[^}]*\bpublishEvent\b[^}]*\}\s*from\s*["']~\/infra\/events\/event-bus["']/.test(
          src,
        )
      ) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  it("no production file imports { db } from ~/db", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      if (/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']~\/db["']/.test(src)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  it("~/db/connection only imported by allowlisted infrastructure files", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      const relative = rel.startsWith("db/") && IMPORTS_CONNECTION_RELATIVE.test(src)
      if ((IMPORTS_CONNECTION.test(src) || relative) && !connectionAllowlist.has(rel)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  it("~/db/privileged only imported by allowlisted files", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      if (IMPORTS_PRIVILEGED.test(src) && !privilegedAllowlist.has(rel)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })

  // STALENESS, the half every allowlist guard needs and this one lacked: a
  // guard that only checks "no file outside the list" cannot tell a reviewed
  // exception from a line nobody has touched since the import it named was
  // deleted. A stale entry is a silent hole, because the day that path starts
  // importing the privileged handle again the list waves it through. The
  // sibling oracles (approvals/authority-closure, threads/message-writes-
  // tagged) both assert it; so does this one now.
  // DETECTORS, shared by the violation scan and the staleness scan below, so
  // the two halves of every allowlist can never answer differently. Each one
  // matches the STATIC form and the dynamic `await import(...)` form: the
  // sandbox rpc-bridge and the app runtime both reach the privileged handle
  // through `await import("~/db/privileged")` and were invisible to a
  // `from "..."`-only pattern, which is a hole in the guard, not an absence of
  // the import.
  const IMPORTS_PRIVILEGED = /(?:from|import\s*\()\s*["']~\/db\/privileged["']/
  const IMPORTS_CONNECTION = /(?:from|import\s*\()\s*["']~\/db\/connection["']/
  /**
   * The RELATIVE spelling is the same import, but only from inside `db/`, where
   * `./connection` IS `~/db/connection`. Matching it everywhere made any module
   * with a `connection.ts` of its own a violation for re-exporting it
   * (`modules/demo/shopify/index.ts` re-exports its Shopify connection helper),
   * which is a false positive: that file imports no database handle at all.
   */
  const IMPORTS_CONNECTION_RELATIVE = /(?:from|import\s*\()\s*["']\.\/connection["']/
  // `sql` off `~/db` in every form it is actually written. The dynamic
  // dereference shapes below were invisible to the `{ sql } = await import(...)`
  // pattern: a namespace binding (`const db = await import("~/db"); db.sql`),
  // an immediate dereference (`(await import("~/db")).sql`), a binding that is
  // destructured a line later (`const { sql } = db`), a binding declared before
  // it is assigned (`let db; db = await import("~/db")`) and a `.then` callback
  // (`import("~/db").then((m) => m.sql)`) all reach the same handle without
  // ever destructuring the import expression itself.
  const SQL_STATIC_IMPORT = /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*["']~\/db["']/
  const SQL_DYNAMIC_DESTRUCTURE =
    /\{[^}]*\bsql\b[^}]*\}\s*=\s*await\s+import\(\s*["']~\/db["']\s*\)/
  const SQL_IMMEDIATE_DEREF = /\(\s*await\s+import\(\s*["']~\/db["']\s*\)\s*\)\s*\.\s*sql\b/
  // The declarator is OPTIONAL: `let db` on one line and `db = await import(...)`
  // on the next binds the module just as firmly as `const db = await import(...)`.
  const SQL_NAMESPACE_BINDING =
    /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']~\/db["']\s*\)/g
  const SQL_THEN_CALLBACK =
    /import\(\s*["']~\/db["']\s*\)\s*\.\s*then\s*\(\s*(?:async\s*)?\(?\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*\)?\s*=>/g
  /** True where `name` is dereferenced as `.sql`, or destructured for `sql`. */
  const takesSqlOff = (src: string, name: string): boolean =>
    new RegExp(`\\b${name}\\s*\\.\\s*sql\\b`).test(src) ||
    new RegExp(`\\{[^}]*\\bsql\\b[^}]*\\}\\s*=\\s*${name}\\b`).test(src)
  const IMPORTS_SQL = {
    test(src: string): boolean {
      if (SQL_STATIC_IMPORT.test(src)) return true
      if (SQL_DYNAMIC_DESTRUCTURE.test(src)) return true
      if (SQL_IMMEDIATE_DEREF.test(src)) return true
      for (const m of src.matchAll(SQL_NAMESPACE_BINDING)) {
        // A file that only asks WHICH exports the module has (`"sql" in mod`)
        // never takes the handle, so the binding alone is not a use: it counts
        // only where the binding is dereferenced as `.sql` or destructured for it.
        if (takesSqlOff(src, m[1])) return true
      }
      for (const m of src.matchAll(SQL_THEN_CALLBACK)) {
        const param = m[1]
        // A destructuring parameter names `sql` outright; a plain parameter has
        // to be dereferenced somewhere in the file.
        if (param.startsWith("{")) {
          if (/\bsql\b/.test(param)) return true
        } else if (takesSqlOff(src, param)) return true
      }
      return false
    },
  }
  const USES_PUBLISH_INTERNAL = /\b_publishEventInternal\b/

  const allowlists: Array<{
    what: string
    entries: Set<string>
    imports: { test(src: string): boolean }
  }> = [
    {
      what: "~/db/connection",
      entries: connectionAllowlist,
      // Inside `db/` the relative spelling IS this import, and the three files
      // that live there write it that way. One predicate for both cases, so the
      // staleness half and the violation half above can never disagree.
      imports: {
        test: (src: string) =>
          IMPORTS_CONNECTION.test(src) || IMPORTS_CONNECTION_RELATIVE.test(src),
      },
    },
    { what: "~/db/privileged", entries: privilegedAllowlist, imports: IMPORTS_PRIVILEGED },
    {
      what: "{ sql } from ~/db",
      entries: sqlAllowlist,
      imports: IMPORTS_SQL,
    },
    {
      what: "_publishEventInternal",
      entries: publishEventAllowlist,
      imports: USES_PUBLISH_INTERNAL,
    },
  ]

  it("every allowlisted file still exists", () => {
    const missing: string[] = []
    for (const { what, entries } of allowlists) {
      for (const rel of entries) {
        if (!fs.existsSync(path.join(srcDir, rel))) missing.push(`${rel} [${what}]`)
      }
    }
    expect(missing).toEqual([])
  })

  it("every allowlisted file still does the exempted thing (no stale exemptions)", () => {
    const stale: string[] = []
    for (const { what, entries, imports } of allowlists) {
      for (const rel of entries) {
        const full = path.join(srcDir, rel)
        if (!fs.existsSync(full)) continue
        // Comments stripped: a file that only NAMES the symbol in prose is not
        // a caller of it, which is exactly the rot this case is looking for.
        if (!imports.test(code(fs.readFileSync(full, "utf-8")))) stale.push(`${rel} [${what}]`)
      }
    }
    expect(stale).toEqual([])
  })

  it("the sql detector sees every form the handle is reached through", () => {
    const forms: Array<[string, string]> = [
      ["static named import", `import { sql } from "~/db"`],
      ["dynamic destructure", `const { sql } = await import("~/db")`],
      ["immediate dereference", `const rows = await (await import("~/db")).sql\`select 1\``],
      ["namespace binding", `const db = await import("~/db")\nawait db.sql\`select 1\``],
      [
        "binding then destructure",
        `const db = await import("~/db")\nconst { sql } = db\nawait sql\`select 1\``,
      ],
      [
        "declared then assigned",
        `let db: any\ndb = await import("~/db")\nawait db.sql\`select 1\``,
      ],
      ["then callback dereference", `await import("~/db").then((m) => m.sql\`select 1\`)`],
      ["then callback destructure", `await import("~/db").then(({ sql }) => sql\`select 1\`)`],
    ]
    const missed = forms.filter(([, src]) => !IMPORTS_SQL.test(src)).map(([name]) => name)
    expect(missed).toEqual([])
    // Asking which exports the module HAS is not taking the handle. This is the
    // shape db/connection.test.ts uses, which is why it needs no exemption.
    expect(
      IMPORTS_SQL.test(
        `const dbModule = await import("~/db")\nexpect("sql" in dbModule).toBe(true)`,
      ),
    ).toBe(false)
  })

  it("{ sql } from ~/db only imported by allowlisted files", () => {
    const violations: string[] = []
    for (const file of allFiles) {
      const src = code(fs.readFileSync(file, "utf-8"))
      const rel = path.relative(srcDir, file)
      if (IMPORTS_SQL.test(src) && !sqlAllowlist.has(rel)) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })
})

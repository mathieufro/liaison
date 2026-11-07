// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reviewed org-id sources of privileged database sites outside route
// handlers, read by src/db/privileged-org-source.test.ts. Each entry says why
// the org id at that point is one the code may act for; the test fails on a
// new site the caller trace cannot follow to one of them, and on an entry no
// site needs any more.
import type { OrgTraceReviews } from "./enumerate"

/**
 * Calls whose result carries an org id the code may act for, reviewed once here so the
 * caller trace can stop at them: name → why.
 */
export const TRUSTED_SOURCES: Record<string, string> = {
  requireNodeCredential:
    "the node credential's row, refused unless node.orgId === c.get('orgId') and its owner is the caller (nodes/credentials.ts:51-59)",
  claimTeardowns:
    "rows of kernel.connection_teardowns, which only the removal's own transaction writes (stageConnectionTeardown): source_org_id is the org of the connection removed, and the work done for it is that connection's provider teardown",
  listAllOrgIds: "operator CLI sweep: every id in kernel.organizations (cli/search/reindex.ts:49)",
  listOrgsWithAppOn:
    "operator CLI sweep: the orgs whose kernel.apps row has the app active, read from the database before a rollback registers it there (cli/app/manage.ts)",
  staleRuns:
    "the stale-run sweep's own rows: kernel.import_runs ids with the org each belongs to, each failed and recovered only in that org (modules/imports/sweep.ts)",
  resolveOrgId:
    "operator CLI: the org the operator names by slug, or the only org (cli/lib/resolve-org-id.ts)",
  resolveExportOrgId:
    "operator CLI (liaison org export): the org the operator names by id (checked to exist in kernel.organizations) or by slug through resolveOrgId (cli/org-export.ts)",
  moving:
    "the freeze resolver's own rows: OrgTransferView's snapshot of the kernel.organizations rows whose transfer_state is set (readMovingOrgs, org/transfer-state/state.ts), each org id the row's own id and each action bound to that org and its transfer id (resolver.ts resolveOverdueMoves)",
  parseOrgTransferArgs:
    "operator CLI (liaison org transfer): the org id (a uuid) the operator passes on the box; purge-source then refuses unless that org's row is `moved` under the same transfer id (cli/org-transfer.ts, modules/org/transfer/purge.ts)",
  loadOrgToDelete:
    "operator CLI (liaison org delete): the kernel.organizations row the operator names by id or slug on the box; null when there is none (cli/org-delete.ts)",
  resolveMember:
    "operator CLI: the org from resolveOrgId (the slug the operator passes, or the only org) and the active member with the operator-given email in that org (cli/lib/resolve-member.ts)",
  scanCandidates:
    "the approval reminder sweep's own rows: each (org_id, requested_by) pair read off kernel.approval_requests, and every read and write for that person is bound to the org the request belongs to (modules/approvals/reminders.ts)",
  resolveReminderMember:
    "operator CLI (liaison approval-reminders run): resolveMember for an email, or for a uuid the org from resolveOrgId and the active member with that id in that org (cli/approval-reminders.ts)",
  buildProvisionContext:
    "provisioning CLI context: orgId starts empty and is set from resolveOrgId, the operator's chosen org (cli/config/apply.ts)",
  verifyOrgExportDownloadToken:
    "the org id inside an org export download token, accepted only when its HS256 signature (JWT_SECRET, audience org-export-download) and 5-minute expiry verify; minted only by GET /api/org/export/:id/download for a kernel:org:admin of c.get('orgId') (export/org-archive/routes.ts), and the relay re-reads that org's export row before streaming",
  parseLinkToken:
    "the org id inside a demo verification link, accepted only when its HMAC verifies (demo-verification.ts parseLinkToken); verifyDemoLink then consumes it once and matches it to that org's stored, unexpired code",
  loadRoutineOwnerContext:
    "the routine owner's context in the org it is called with (event-routine-gate.ts): orgId is that argument, which the caller trace follows at loadRoutineOwnerContext's own withPrivilegedDb site; null when the routine is not in that org",
  consumeOAuthState:
    "the OAuth state record the server stored under a random single-use key (startOAuthFlow, service.ts:1523-1540) when an authenticated route (connections/routes.ts POST /:appName/:connectionName/authorize: c.get('orgId')) or the operator CLI (cli/connect, resolveOrgId) started the flow; getdel'd once, so its org is the starter's, never the callback request's",
  claimConnectHandoff:
    "a parked shell connect grant (shell-connect.ts claimConnectHandoff): getdel'd once by its 64-hex code, refused unless the shell's PKCE verifier matches and the parked record's org and user equal the redeeming session's (input.orgId / input.userId, c.get('orgId') / c.get('userId') at connections/routes.ts POST /oauth-handoff)",
  buildActorProvisionContext:
    "agent tool path of config apply: ctx.orgId is the orgId its only callers pass, the kernel tool context's own org (modules/agent/tools/config-tools.ts, buildActorProvisionContext({ orgId: ctx.orgId, actor }))",
  resolvePlanOrgId:
    "the provisioning context's org (set from the tool context on the tool path, which refuses an empty one) or, from the operator CLI only, the org of the slug in the operator's own config file (cli/provisioners/types.ts resolvePlanOrgId)",
  ensureOrg:
    "the org the caller just created or found by the slug it chose: the operator CLI's config or the demo pool's own generated visitor slug (modules/provisioning/ensure-org.ts)",
  createVisitorOrgShell:
    "the visitor org the demo pool itself just created (ensureOrg on a slug the pool generated, demo-pool.ts createVisitorOrgShell)",
  createPooledShell:
    "the pooled org the demo pool's refill itself just created (createVisitorOrgShell on a slug the pool generated, demo-pool.ts createPooledShell)",
  acquireVisitorWorkspace:
    "the workspace this request just made the visitor's (demo/routes.ts acquireVisitorWorkspace): a ready pooled org claimPooledOrg handed over in one locked transaction, or the shell createVisitorOrgShell just created; reached from a signup and from POST /start-over, whose own org is requireVisitorOrg's",
  pooledRows:
    "the demo pool's own visitor orgs: kernel.organizations rows its marker names as pooled (demo-pool.ts pooledRows)",
  provisionOrgShell:
    "the org the seed engine's org factory just created, or found under the slug its caller chose, through the provisioning CLI's org provisioner (seed/factories/org/org.ts); the demo tier writes into it only once it carries the demo marker or this run created it (seed/tiers/demo/seed-org.ts demoMarkRefusal)",
  requireVisitorOrg:
    "the authenticated session's own org (c.get('orgId')), refused with a 404 unless its marker says visitor demo org (demo/routes.ts requireVisitorOrg)",
}

/**
 * Functions handed on as values to a dispatcher the trace cannot follow by name, whose
 * dispatcher was reviewed: name → what calls it and with which org.
 */
export const REVIEWED_DISPATCH: Record<string, string> = {
  bridgeExtension:
    "a manifest's bridge extension factory, kept in appBridgeExtensionRegistry per [org, app] (runtime.ts:3279); createRpcBridge calls it with the run's bridge context",
  _bridgeExtension:
    "a manifest's bridge extension factory, carried into the RPC bridge (runtime.ts:2098), which calls it with the run's bridge context (the org the kernel runs the app for)",
  exportName:
    "a string (the sandbox export to run, sandbox-worker.ts), never a function: a property-name collision in the alias graph",
  handlerName:
    "a string (the search handler's export name, runtime.ts:3088), never a function: a property-name collision",
}

/**
 * Privileged sites outside route handlers whose org id is a parameter the trace could not
 * follow to a trusted source, could not be traced, or is a literal: `file#enclosing` → why.
 */
export const REVIEWED_OUTSIDE_ROUTES: Record<string, string> = {
  "apps/api/src/modules/agent/runtime/tool-card-store.ts#clearToolCardsByKey":
    "no product caller yet (an app's own retention will call it, tests only today): the org of the thread the caller names, matched again on every message row it reads and writes (messages.org_id = orgId)",
  "apps/api/src/modules/apps/org-features.ts#setOrgAppFeature":
    "no product caller yet (the settings door that switches a feature will call it with the org of the admin's session, tests only today): writes only the (orgId, app, feature) row it is given",
  "apps/api/src/seed/factories/support/inboxes.ts#ensureTicketMailboxInbox":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/inboxes.ts#ensureTicketMailboxAccount":
    "test-only factory (no product caller): the org a test seeded itself, writing the mail account its seeded mailbox inbox sends through",
  "apps/api/src/seed/factories/support/ticket.ts#createOneTicket":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/ticket.ts#appendTicketMessages":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/ticket.ts#createTicketApiKey":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/ticket.ts#closeTickets":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/ticket.ts#shiftTicketClock":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/tiers/minimal.ts#person":
    "the minimal seed tier (tests only, no product caller): a privileged read of the org a test names, the org it just created or provisioned",
  "apps/api/src/seed/tiers/minimal.ts#revokeRole":
    "the minimal seed tier (tests only, no product caller): a privileged read of the org a test names, the org it just created or provisioned",
  "apps/api/src/seed/tiers/minimal.ts#privilegedAssignRole":
    "the minimal seed tier (tests only, no product caller): a privileged read and its one named privileged write, a role row restored in the org a test names, the org it just created or provisioned",
  "apps/api/src/seed/tiers/demo/seed-demo.ts#fitPooledWorldToNeeds":
    "turns the support routine Off in the org it is given: loaded by demo-seeder.ts (loadFitPooledWorld) and called only from fitPooledDemoWorld, which demo/routes.ts calls with pooled.orgId, the pooled visitor demo org claimPooledOrg just handed over in one locked transaction",
  "apps/api/src/modules/agent/routines/routine-mailbox-wait.ts#expireMailboxWaits":
    "marks lapsed waiting routine runs of the org it is asked about expired (status and a fixed sentence, no read): a tick's own org, Run now's signed-in org, or the expiry sweep's loop over the orgs that own waiting_mailbox rows, each updated only in its own org",
  "apps/api/src/modules/agent/routines/routine-mailbox-wait.ts#resolveMailboxWaitItems":
    "marks read the waiting run's own attention row (the owner's, matched on org, owner and the run's entity id) in the org whose run it is: a tick's own org, Run now's or Dismiss's signed-in org, or the expiry sweep's loop over the orgs that own waiting_mailbox rows; no read returns data",
  "apps/api/src/cli/connect/index.ts#orgLocale":
    "operator CLI: reads only the default locale of the org chosen with resolveOrgId (runConnect); the trace stops at a `locale` name collision in cli/guide/index.ts",
  "apps/api/src/lib/load-harness.ts#isLoadOrg":
    "reads one boolean (settings.loadHarness) of the org it is asked about, and answers false unless the box's LOAD_HARNESS_KEY is set; callers pass the org of the effect or turn they are about to run (a mail's, a push's, preCheck's own orgId carried on its result as loadOrgId), and a wrong org could only route that org's own effect to the sink, never read another org's data",
  "apps/api/src/modules/secret-requests/service.ts#announceConnectFailure":
    "a connect card's failed OAuth callback: the org is the flow state's own (peekOAuthStateApp reads the server-held state the card's authorize stored, keyed by the unguessable state), and the row is matched on that org AND the card's request id from the same state; only a reason code is queued",
  "apps/api/src/modules/apps/connections/oauth-client.ts#loadOrgGoogleOAuthClient":
    "the one OAuth client resolver reads the org's own Google client for the org it is asked about: an OAuth flow's org (the authenticated route's, or the flow state's), the org a setup guide or setup state runs for, or the org of a webhook registration found under the URL key; the secret only reaches that org's token exchange or webhook verifier",
  "apps/api/src/modules/apps/connections/oauth-client.ts#loadOrgConnectionClientRow":
    "the one OAuth client resolver reads the org's own oauth_providers row for the org it is asked about: an OAuth flow's org (the authenticated route's, or the flow state's), the org a setup guide or setup state runs for, or the org of a webhook registration found under the URL key; the secret only reaches that org's token exchange or webhook verifier",
  "apps/api/src/modules/tours/beat-status.ts#nudgeActiveTours":
    "tour status nudge: the org of the agent turn that started or ended (the stream registry's snapshot.orgId, set by the turn's own run), of the routine run (routine-worker opts.orgId) or of the approval event (event.orgId)",
  "apps/api/src/modules/mcp-client/oauth-tokens.ts#attemptRefresh":
    "MCP token refresh: the org of the connection row it refreshes (head.orgId, read by connection id)",
  "apps/api/src/modules/agent/providers/openrouter-blocked-hosts.ts#readFromDb":
    "reads one string list (settings.ai.models.blockedHosts) of the org it is asked about; callers pass the org of the OpenRouter call they are about to send (preCheck's own orgId carried on its credit, the idle-compaction job's org, the web search's ctx.orgId, the admin route's signed-in org), and a wrong org could only change which OpenRouter hosts that request avoids, never return another org's data; the trace stops at a `get` name collision",
  "apps/api/src/modules/approvals/route-world.ts#updateItemRoutePerson":
    "an item changed hands: every caller (the ticket and task assign, claim and update paths) passes the org of the item it just wrote, and the UPDATE is further pinned to that org_id",
  "apps/api/src/modules/approvals/resource-owner.ts#loadRoutineApproverSetting":
    "name collision in the trace (CredentialStore.get is not a settings getter): callers pass the approval's own org",
  "apps/api/src/apps/mail/search-enrichment.ts#streamFragmentsForRebuild":
    "index source registered with registerIndexSource: the reindex sweep calls it with each org from listOrgIds",
  "apps/api/src/apps/tickets/link-ingest-job.ts#processLinkIngestJob":
    "link ingest job: the privileged default runs in the job payload's org",
  "apps/api/src/cli/provisioners/types.ts#buildProvisionContext.priv":
    "provisioning CLI: ctx.orgId starts empty and is set from resolveOrgId before any write",
  "apps/api/src/db/privileged.ts#withPrivilegedDb":
    "the privileged helper's own SET ROLE: every call site of it is enumerated and classified here",
  "apps/api/src/db/privileged.ts#privilegedFrom":
    "the privileged helper's own SET LOCAL ROLE liaison_admin on the caller's transaction, restored to the caller role checked against /^liaison_[a-z_]+$/ (privileged.ts:197-205). Its withPrivilegedDb fallback takes the org the caller's own RLS transaction runs in: countTeamReferences (setContactSharing, after loadVisible in params.orgId), sameOwnerNoWiderGrants (authorizeMerge, after the merged rows were read FOR UPDATE in params.orgId) and ensureBaseAgentOnTx (sendMessage's params.orgId, the thread write's org)",
  "apps/api/src/modules/apps/activation.ts#withActivationLockTx":
    "the nil org on purpose: the transaction only holds an app's activation advisory lock (app-activate:<name>, server-wide, no org) and reads no org data; everything it guards runs in transactions of its own",
  "apps/api/src/db/privileged.ts#runOnPrivilegedPool":
    "the privileged pool's own SET LOCAL ROLE, shared by withPrivilegedDb's default pool, withSystemDb and withSchemaAdmin (migrations and app DDL): it is module-private, its org id is theirs (null for withSystemDb and withSchemaAdmin), and every call site of those helpers is enumerated and classified here",
  "apps/api/src/infra/events/outbox-worker.ts#adminExec":
    "outbox worker's own role switch for fixed outbox statements",
  "apps/api/src/lib/server.ts#message":
    "websocket frame handler: conn.orgId was set from the ticket verified at upgrade",
  "apps/api/src/modules/agent/context/checkpoint.ts#loadFrozenCore":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/agent/directory/routing.ts#resolveRoute":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/agent/routines/routine-report.ts#readTickFinalReply":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-report.ts#deliverRoutineReport":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-run-resume.ts#approvalsOfRun":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-run-resume.ts#decisionPayload":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-run-resume.ts#endWaitingRun":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-worker.ts#writeRunRow":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-worker.ts#settleRunRow":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-worker.ts#emitRoutineEvent":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-worker.ts#finishRun":
    "routine run end: the run's own org on every path (a tick passes opts.orgId, a resume the decided approval's org from its job; the waiting-run sweep sweepWaitingRoutineRuns passes each routine_runs row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/approvals/approval-result-turn.ts#enqueueRoutineDecisionTurn":
    "approval decision job: the approval's own org on every path (a decision, a withdraw, a cancel or the reapers pass the org of the approval row they just moved, the deferred-step reaper each stale row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/approvals/event-data.ts#approvedSiblingOwedTurn":
    "approval decision job: the refused approval's own org on every path (a decision, a withdraw, a cancel or the reapers pass the org of the approval row they just moved, the deferred-step reaper each stale row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/approvals/event-data.ts#hasDeferredDependent":
    "approval decision job: the approval's own org on every path (a decision, a withdraw, a cancel or the reapers pass the org of the approval row they just moved, the deferred-step reaper each stale row's own org_id read by the system pool), and every query is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-report.ts#settleRunLines":
    "routine run line settle: the routine's own org on every path (postRunStarted and settleRunStarted get the tick's opts.orgId from routine-worker or the node job row's org; the stale sweep settleStaleRunLines passes each routines row's own org_id read by the system pool), and the UPDATE is further pinned to that org_id",
  "apps/api/src/modules/agent/routines/routine-event-reconciler.ts#ticketMessageStillNeedsTriage":
    "reconciler predicate (routine-event-reconciler.ts:143): called with the routine row's own org",
  "apps/api/src/modules/agent/subruns/spawn-agent.ts#getAgentRunById":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/approvals/attention.ts#computeApprovalAttentionItems":
    "attention computer registered by name (app.ts:180): the attention pipeline calls it for the org it is computing",
  "apps/api/src/modules/apps/connections/attention.ts#computeConnectionHealthAttentionItems":
    "attention computer registered by name: called for the org being computed",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultFetchCadencePending":
    "cross-org digest read with the zero sentinel org: the privileged pool reads every org's pending rows (system job)",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultFetchUrgent":
    "cross-org digest read with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultLoadUser":
    "digest job lookup by user id with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultMarkRowsSent":
    "digest job update by row id with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultMarkRowsSuppressed":
    "digest job update by row id with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultSetLastDailySent":
    "digest job update by user id with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/state-materializer.ts#defaultListOrgsWithActiveUsers":
    "cross-org listing with the zero sentinel org (system job)",
  "apps/api/src/modules/attention/translator.ts#defaultInsertAttentionRowsBatch":
    "batch insert in the org of its rows (one org per batch, set by the caller)",
  "apps/api/src/modules/files/media-analysis-job.ts#processMediaAnalysisJob":
    "media analysis job: the privileged default runs in the job payload's org",
  "apps/api/src/modules/files/orphan-gc.ts#registerOrphanGcScheduledJob":
    "orphan file sweep with the zero sentinel org (system job over every org's files)",
  "apps/api/src/modules/mailbox-crypto/backfill-job.ts#runPrivileged":
    "backfill job's privileged default: called with the org of the user being backfilled",
  "apps/api/src/modules/mailbox-crypto/purge.ts#runPrivileged":
    "purge job's privileged default: called with the org being purged",
  "apps/api/src/modules/cloud/attention.ts#computeCloudBillingAttentionItems":
    "attention computer registered by name: called for the org being computed",
  "apps/api/src/modules/cloud/billing-status.ts#orgBillingStatus":
    "the billing status the control plane pushed for one org (managed edition), read by every gate that must refuse a suspended org (requests, jobs, inbound webhooks, the cell callbacks, a private app bundle, the delete timer's fence): it returns that org's status word and period end only, and each caller passes the org it is about to act for",
  "apps/api/src/modules/agent/credits/managed-side-call.ts#systemWorkUserId":
    "the user a managed side call's usage row is attributed to: called through a dynamic import by message-indexer.ts (managedOrgEmbedder) with the org whose content it indexes; reads one user id of that org",
  "apps/api/src/modules/cloud/billing.ts#applyBillingPush":
    "signed control plane push: the org is the one the verified request names (path and body must agree, modules/cloud/verify.ts)",
  "apps/api/src/modules/cloud/billing.ts#rerunMissedOneShots":
    "payment resumed on a signed control plane push: applyBillingPush passes the org that push names (path and body must agree), and the query reads only that org's routines",
  "apps/api/src/modules/mailbox-keys/attention.ts#computeMailboxEnrollmentAttentionItems":
    "attention computer registered by name: called for the org being computed",
  "apps/api/src/modules/mailbox-keys/reset.ts#resetMailbox":
    "mailbox reset's privileged default: run in the org of the mailbox being reset (its caller's)",
  "apps/api/src/modules/notifications/delivery-log.ts#recordDeliveries":
    "deliveries grouped by each row's own org (delivery-log.ts:50-60)",
  "apps/api/src/modules/search/message-indexer.ts#streamTranscriptForRebuild":
    "index source registered with registerIndexSource: the reindex sweep calls it with each org from listOrgIds",
  "apps/api/src/modules/search/reindex.ts#listOrgIds":
    "reindex listing of every org id, under a placeholder org (system sweep)",
  "apps/api/src/modules/sharing/service.ts#asAdmin":
    "elevates for one sharing statement, then restores the quoted caller role (sharing/service.ts:340-348)",
  "apps/api/src/modules/webhooks/tickets-public.ts#handleAttachmentUpload":
    "public ticket intake: the URL org only scopes the lookup; an API key of that org (classifyTier) is the authority, behind the pre-auth throttle",
  "apps/api/src/modules/webhooks/tickets-public.ts#handleTicketCreate":
    "public ticket intake: the URL org only scopes the lookup; an API key of that org (classifyTier) or the org's enabled public form is the authority, behind the pre-auth throttle",
}

/**
 * Entries above reviewed for having no product caller: the product files that use each function,
 * pinned (none today). src/db/privileged-org-source.test.ts fails on a new caller, so the first
 * one cannot pass unreviewed: rewrite the entry for that caller's org id, then add it here.
 */
export const REVIEWED_CALLERS: Record<string, readonly string[]> = {
  "apps/api/src/modules/agent/runtime/tool-card-store.ts#clearToolCardsByKey": [],
  "apps/api/src/modules/apps/org-features.ts#setOrgAppFeature": [],
}

/**
 * Functions whose calls hand on an org id that was reviewed here (a boot or job sweep over
 * every org, an operator command, a row the function just claimed): `file#enclosing` → why.
 * The caller trace stops at a call made from one of them.
 */
export const REVIEWED_ORIGINS: Record<string, string> = {
  "apps/api/src/modules/apps/org-features.ts#setOrgAppFeature":
    "no product caller yet (the settings door that switches a feature will call it with the org of the admin's session, tests only today); what it hands on is the org id it was given, for that one org's cache and broadcast",
  "apps/api/src/modules/apps/connections/revoke.ts#isAccountUsedElsewhere":
    "the org of an active connection on the same provider account, read by this function: its apps are loaded only to learn which provider endpoints that connection declares; nothing of that org is written or returned, the answer is one boolean",
  "apps/api/src/modules/org/transfer/import.ts#importOrg":
    "an org transfer import: the org named by the bundle header the source agent streams over the operator's private channel (a uuid); the purge runs only on this instance's own copy of that org, `incoming` under the header's transfer id (or a `moved` copy the header's arrivedVia proves), and purgeTransferCopy re-checks that row",
  "apps/api/src/modules/org/transfer/agent-target.ts#TargetAgent.run":
    "the org transfer target agent, reached only over the operator's private ssh channel (its stdin): the org is the uuid of the session's one `hello` (a second is refused), and `abort` purges only while that org's row is `incoming` under the session's own transfer id",
  "apps/api/src/modules/cloud/credits.ts#applyCreditGrant":
    "signed control plane credit grant: the org is the one the verified request names (path and body must agree, modules/cloud/verify.ts), checked to exist before any credit",
  "apps/api/src/seed/factories/support/ticket.ts#createOneTicket":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/support/ticket.ts#closeTickets":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/people/scoped-role.ts#createRoleWithGrants":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/people/scoped-role.ts#assignRoleTo":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/factories/threads/referencing.ts#seedReferencingThreads":
    "the /api/_test/seed route's factories (test-support/seed/factories.ts, mounted only in test builds; no product caller): the org a browser test names in its request, the one its lane seeded",
  "apps/api/src/seed/tiers/minimal.ts#person":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#thread":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#grantScope":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#revokeScope":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#assignRole":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#revokeRole":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#privilegedAssignRole":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and its one write (the admin role a test took from every admin, restored when no admin is left to act) is the tier's only privileged write",
  "apps/api/src/seed/tiers/minimal.ts#adminActor":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/seed/tiers/minimal.ts#adminSession":
    "the minimal seed tier's per-test entry point: no product code calls it; its only callers are test files, each on the org the test itself just created (createTestOrg) or provisioned (minimal.secondOrg), and every write goes through the product service as that org's admin or person",
  "apps/api/src/db/apply-app-schemas.ts#applyAppSchemas":
    "the test template build (scripts/lib/test-template.ts) only: registers the in-tree apps for APPLY_APP_SCHEMAS_ORG_ID, a fixed throwaway org it inserts first and deletes after, on a template database no request reaches; skipOrgRows writes no row for it",
  "apps/api/src/seed/tiers/demo/seed-demo.ts#seedDemoWorldLayers":
    "the demo tier's world entry: every layer writes into org.orgId, the org seedDemoOrg (a reviewed origin) just provisioned or adopted under the caller's slug and stamped with the demo marker",
  "apps/api/src/seed/tiers/demo/seed-demo.ts#fitPooledWorldToNeeds":
    "loaded by demo-seeder.ts (loadFitPooledWorld) and called only from fitPooledDemoWorld, which demo/routes.ts calls with pooled.orgId, the pooled visitor demo org claimPooledOrg just handed over in one locked transaction",
  "apps/api/src/seed/tiers/demo/seed-demo.ts#seedScenarioStart":
    "loaded by demo-seeder.ts (loadScenarioStart) and called only from prepareDemoScenario, which tours/routes.ts calls for the session's own org (c.get('orgId')) after isVisitorDemoOrgId confirms it is a visitor demo org",
  "apps/api/src/seed/tiers/demo/seed-commerce.ts#seedDemoCommerce":
    "the demo tier's commerce layer: every write goes to opts.org.orgId, the org seedDemoOrg (a reviewed origin) returned after provisioning it and stamping its demo marker; the commerce factories receive it through the layer's SeedContext",
  "apps/api/src/seed/tiers/demo/seed-org.ts#seedDemoOrg":
    "the demo tier's org entry: an org already under the caller's slug is only read (its demo marker, fresh) to refuse it unless it is a demo org (demoMarkRefusal); every write uses the org the org factory's provisioning pass returns (provisionOrgShell), stamped with the demo marker before any account exists",
  "apps/api/src/seed/tiers/lively/seed-lively.ts#replaceLivelyOrg":
    "an operator's `liaison seed --tier lively --replace` (a private box, refused in demo mode): the org under the slug the operator named is purged only when its row carries the demo marker, re-read fresh before the purge and again by purgeOrg's assertAllowed before every destructive step",
  "apps/api/src/seed/tiers/lively/seed-lively.ts#seedLivelyLayers":
    "the lively tier's entry: every activity write goes to world.orgId, the org seedDemoWorld (whose seedDemoOrg is a reviewed origin) just provisioned or adopted under the caller's slug and stamped with the demo marker",
  "apps/api/src/seed/tiers/standard/seed-standard.ts#seedStandardWorld":
    "the standard tier's entry (test lanes and `bun run dev`, `liaison seed --tier standard --admin <email>`): every write goes to ctx.orgId, the org findAdmin reads off the operator-named admin's own kernel.users row (exactly one account with that email, else it refuses), and it refuses an org that already holds any QA member, so it only fills that admin's own org while the admin is its only account",
  "apps/api/src/seed/tiers/standard/seed-standard.ts#seedStandardAgentApp":
    "the standard tier's agent-app refill: every write goes to ctx.orgId, the org findAdmin reads off the operator-named admin's own kernel.users row (exactly one account with that email, else it refuses), and it refuses unless every QA member of the standard world is already in that org",
  "apps/api/src/seed/tiers/load/seed-load.ts#seedOneLoadOrg":
    "the load tier's per-org entry: every write (the synthetic marker, the bulk volume and its read-back) goes to world.orgId, the org seedDemoWorld (whose seedDemoOrg is a reviewed origin) just provisioned or adopted under the slug `<prefix><i>` and stamped with the demo marker",
  "apps/api/src/seed/tiers/demo/seed-org.ts#clearInterruptedOrg":
    "the org under the slug the seeder itself claimed (claimOrgSlug) before creating it, still unmarked: purged only while the claim is there and no demo marker is, re-checked by purgeOrg's assertAllowed before every destructive step",
  "apps/api/src/cli/provisioners/liaison-team.ts#verifyRequest":
    "asks whether the org of the config run may decide the server-wide Liaison team switches (canManageInstanceApps): the CLI's org (resolved by the operator's own command) or the org of the agent tool call (ctx.orgId from the kernel); the answer is one boolean about that same org",
  "apps/api/src/app.ts#GET /api/connections/callback":
    "the connection OAuth callback: the org is the flow state's own (peekOAuthStateApp reads the server-held state an authenticated connect start stored, keyed by the unguessable state); before the grant it asks only whether that org's deletion has started (isOrgDeletingAsync, a boolean that refuses the callback with 410), and everything after it runs on the same state",
  "apps/api/src/apps/google-drive/picker-page.ts#drivePickerPage":
    "the Picker page's one-time ticket: a 256-bit random id (createPickerTicket) under a Redis key only this server writes, taken once (getdel), minted by POST /api/google-drive/picker/ticket from the authenticated caller's own org, user and scopes; pickerAccount re-checks the account is that person's and in picked mode before any token is read",
  "apps/api/src/apps/google-drive/picker-page.ts#drivePickerPageSave":
    "the Picker page's save id: a 256-bit random id under a Redis key only this server writes, minted by drivePickerPage from a ticket that POST /api/google-drive/picker/ticket made from the authenticated caller's own org, user, scopes and an account pickerAccount checked they may pick on; updatePickedItems re-checks the account against that org and user",
  "apps/api/src/modules/tours/consumer.ts#registerTourProgressConsumer":
    "an agent turn ended: settleTurnsEndedBeats runs for the org of that turn (the stream registry's snapshot.orgId, set by the turn's own run), and reads and moves only that org's tour rows",
  "apps/api/src/modules/imports/runner.ts#checkBundledBatch":
    "a preview's check bridge: the org and user are the run's own (opts.orgId, opts.actor), exactly as writeBundledBatch passes them, from the authenticated preview or the run row's job; its options ({ readOnlyRunOverride }) carry no actor, so the bridge builds it from those ids (bridge/context.ts inheritedActor), which the tracer cannot follow past the options literal",
  "apps/api/src/modules/agent/tools/config-tools.ts#configSectionSummarizer":
    "the config_* tools' approval summarizer, registered per [orgId, kernel, tool] with registerApprovalSummarizer (config-tools.ts); the approval pipeline calls it for an approval of that org and it reads ctx.orgId only",
  "apps/api/src/apps/api-connector/transport.ts#boundFetchToStream":
    "bound egress for import transforms (downloadToFile): no production caller yet; its org is BoundRequestInput.orgId, which the transform host fills from the import run row's org",
  "apps/api/src/apps/api-connector/transport.ts#boundGet":
    "bound egress for import transforms (apiGet): no production caller yet; its org is BoundRequestInput.orgId, which the transform host fills from the import run row's org",
  "apps/api/src/modules/demo/replay/replay.ts#resumeRunningReplays":
    "boot resume: open replay sessions on simulated nodes read by the system pool; each replay resumed in its own row's org",
  "apps/api/src/modules/agent/credits/credit-meter.ts#DemoStepMeter.stepFinished":
    "this.orgId: the org preCheck built the meter for (the turn's own org), fixed at construction",
  "apps/api/src/modules/agent/credits/credit-meter.ts#DemoStepMeter.requestLeaving":
    "this.orgId: the org preCheck built the meter for (the turn's own org), fixed at construction",
  "apps/api/src/modules/nodes/routes.ts#PATCH /:id":
    "node.orgId: the row this request updated under its own RLS context (withRequestRls, owner = the caller)",
  "apps/api/src/modules/apps/activation.ts#switchAndJudge":
    "an app version switch: every org in initializedOrgRuntimes, the orgs this process already registered (init.ts initAppsForOrg adds each after registering it), or, in a process with none, one probe org read by the system pool (an org whose kernel.apps row has the app active, else resolveOperatorOrgId); each org's registration of the app switched in that org only",
  "apps/api/src/modules/apps/ready-warm.ts#warmLiveOrgsBeforeReady":
    "boot, before /readyz answers 200: the orgs of the live WebSocket connections this cell's processes recorded in Redis (websocket-state/redis.ts liveOrgIds), each the org of an authenticated socket; each org's apps registered on their own (awaitOrgApps, a no-op for an org that does not exist)",
  "apps/api/src/modules/agent/local-sessions/local-claim-lapse.ts#sweepLapsedLocalClaims":
    "sweep: lapsed claim rows read by the system pool; each claim acted on in its own row's org",
  "apps/api/src/modules/agent/credits/openrouter-price-job.ts#refreshOpenRouterPrices":
    "job sweep: every org row; each org's model list updated in that org",
  "apps/api/src/modules/agent/routines/routine-event-reconciler.ts#reconcileEventRoutines":
    "sweep: event routines read by the system pool; each reconciled in its own row's org",
  "apps/api/src/modules/agent/subruns/subrun-worker.ts#sweepStuckSubRuns":
    "sweep: stuck agent_runs rows; each failed in its own row's org",
  "apps/api/src/modules/nodes/presence.ts#sweepStaleNodeSessions":
    "sweep: stale node rows; each closed in its own row's org and owner",
  "apps/api/src/modules/approvals/approving-reaper.ts#runApprovingReaper":
    "sweep: approval rows stuck in approving; each reaped in its own row's org",
  "apps/api/src/modules/approvals/routed-reminders.ts#runRoutedReminderSweep":
    "sweep: pending approval rows a day old; each org's rows are reminded in that org",
  "apps/api/src/modules/search/reindex.ts#runReindex":
    "reindex sweep: every org id (listOrgIds); each org's documents streamed in that org",
  "apps/api/src/modules/search/reindex.ts#setUpOrgsOf":
    "rebuild replay: the org each noted live index write carries, recorded by the index writer from the write's own org (replayTouched)",
  "apps/api/src/apps/mail/search-enrichment.ts#<module>":
    "index batch grouped by each item's own payload org (search-enrichment.ts:300-308)",
  "apps/api/src/cli/agent/ask.ts#runAgentAsk": "operator CLI: the org chosen with resolveOrgId",
  "apps/api/src/cli/contacts/apply-provenance.ts#runProvenanceCli":
    "operator CLI: the org named by --org on the command line",
  "apps/api/src/cli/contacts/privatize-mailbox-senders.ts#runPrivatizeMailboxSendersCli":
    "operator CLI: the org named by --org on the command line",
  "apps/api/src/cli/files-purge-deleted-message-attachments.ts#runPurgeDeletedMessageAttachmentsCli":
    "operator CLI: --org, or every org (listOrgIds)",
  "apps/api/src/cli/projects/import.ts#runProjectsImport": "operator CLI: the import's target org",
  "apps/api/src/cli/slack/import.ts#runSlackImport": "operator CLI: the import's target org",
  "apps/api/src/cli/setup/crawl-site.ts#pageTitle":
    "setup CLI: no org involved (a regex match of the crawled page title reached the name-based trace)",
  "apps/api/src/modules/mail/routes.ts#POST /drafts/:id/send":
    "orgId is c.get('orgId'); the spread body (sendDraftBody, mail/routes.ts:49) declares no orgId and zod drops unknown keys",
  "apps/api/src/modules/node-sessions/routes-me.ts#POST /":
    "orgId is c.get('orgId'); the spread body (startSchema, routes-me.ts:439) declares no orgId and zod drops unknown keys",
  "apps/api/src/modules/webhooks/tickets-public.ts#handleTicketCreate":
    "public ticket intake: the URL org only scopes the lookup; an API key of that org (classifyTier) or the org's enabled public form is the authority, behind the pre-auth throttle",
  "apps/api/src/modules/webhooks/tickets-public.ts#handleAttachmentUpload":
    "public ticket intake: the URL org only scopes the lookup; an API key of that org (classifyTier) is the authority, behind the pre-auth throttle",
  "apps/api/src/modules/cloud/create-org.ts#createCloudOrg":
    "signed control plane org creation (modules/cloud/verify.ts): the org is the one this request just created or found by its own requested slug (an idempotent retry), and every write after it (plan, mail provider, default models) is pinned to that org",
  "apps/api/src/modules/cloud/routes.ts#PUT /orgs/:id/mail-sender":
    "signed control plane push (modules/cloud/verify.ts): the body's org must equal the path's or the route answers 400 before any read",
  "apps/api/src/modules/cloud/routes.ts#PUT /orgs/:id/custom-apps/:name/state":
    "signed control plane push (modules/cloud/verify.ts): the body's org and app must equal the path's or the route answers 400 before any read",
  "apps/api/src/modules/agent/credits/managed-side-call.ts#managedSideCallGate":
    "the managed side-call gate, handed on as a value: media-analysis-tool.ts calls it (deps.managedSideCallGate) with ctx.orgId, the run's org, and message-indexer.ts (managedOrgEmbedder, dynamic import) with the org whose content it indexes",
  "apps/api/src/modules/webhooks/routes.ts#dispatchVerifiedWebhook":
    "an inbound delivery already verified (by the app's verifier on POST /:orgId/:appName/:endpointName, or by the kernel on the server's own Meta callback): the handler runs for the registration's own org, found under [orgId, app, endpoint], and the payload is the provider's body, which names no org the dispatch uses",
  "apps/api/src/modules/webhooks/routes.ts#runDelivery":
    "the delivery closure inside dispatchVerifiedWebhook, called only there: its org is appOrgId, registration.orgId, so the handler runs for the registration's own org as the entry above says",
  "apps/api/src/modules/webhooks/org-setup.ts#setUpOrgForInboundWebhook":
    "unauthenticated /webhooks/:orgId/* first touch (app.ts): the path org only picks which org gets the setup any first touch runs; awaitOrgApps skips a non-UUID or an id no organization row carries, returns at once for a registered org, and writes only that org's own idempotent, stamp-gated setup; nothing is returned, and each route's own capability check (signature, verify token, API key or public form) still guards everything after it",
  "apps/api/src/modules/apps/org-apps.ts#pathOrgAppState":
    "unauthenticated routes keyed by an org id in their path (webhooks/routes.ts dropIfAppOff, tickets-public.ts refuseWhenTicketsOff): the path org only scopes a read of that org's deleting flag and on/off state for one app (a non-UUID answers on) and the answer (on, off or deleting) picks a drop or refusal; no org data is returned, and each route's own capability check (signature, verify token, API key or public form) still guards everything after it",
  "apps/api/src/modules/apps/org-apps.ts#initOrgAppsInvalidation":
    "peer invalidation on the server's internal Redis channel (ORG_APPS_INVALIDATE_CHANNEL), published only by this server's own writers with the org they wrote; reloadOrgAppsAfterPeerWrite re-reads only an org this process already caches, and the read is that org's own app state, kept in this process",
  "apps/api/src/modules/demo/demo-connected-ttl.ts#extendDemoOrgOnMcpConnected":
    "the org of the MCP connection row found by its id (mcp_connections.org_id), a connection that just reached connected in this process (mcp-client/health.ts markConnected); only a visitor demo org's expiry moves, never shortened",
  "apps/api/src/modules/auth/routes.ts#POST /logout":
    "the session being ended, found by the caller's own refresh token (logout())",
  "apps/api/src/modules/auth/auth.ts#bootstrapRegister": "the org this bootstrap just created",
  "apps/api/src/modules/auth/magic-link.ts#requestMagicLink":
    "the user the sign-in address resolves to in the named org; the code is mailed to that user only",
  "apps/api/src/modules/demo/routes.ts#createVisitorOrg": "the demo org this request just created",
  "apps/api/src/modules/demo/routes.ts#resumeSignup":
    "the demo org an earlier signup recorded under the caller's own random signup key, stored only as a SHA-256 over the start's network and the key (demo/routes.ts SIGNUP_KEY), re-checked to still carry an unexpired visitor demo marker",
  "apps/api/src/modules/demo/demo-reset.ts#probeSeederFromScratch":
    "the probe org found by its reserved slug, checked to be a visitor demo org",
  "apps/api/src/modules/nodes/job-routes.ts#POST /jobs/:id/claim":
    "the job the node credential claimed (claimNodeJob filters by the credential's org and owner)",
  "apps/api/src/modules/nodes/routing.ts#routeAgentTag":
    "the node route row found for the calling agent, in the agent's org",
  "apps/api/src/modules/notifications/device-routes.ts#POST /receipts":
    "the device credential's own row (verifyDeviceCredential); refused when absent",
  "apps/api/src/modules/notifications/qa-routes.ts#POST /inject":
    "QA-only route, mounted only with the QA flag (refused in production, env-production-flags.test.ts)",
  "apps/api/src/apps/api-connector/bridge.ts#call":
    "sandbox bridge extension: ctx is the run's bridge context (createBridgeContext in rpc-bridge.ts, the org the kernel runs the app for)",
  "apps/api/src/apps/api-connector/bridge.ts#createApiConnectorBridgeExtension.connector_list_operations":
    "sandbox bridge extension: ctx.orgId is the run's bridge context org (rpc-bridge.ts)",
  "apps/api/src/apps/api-connector/bridge.ts#createApiConnectorBridgeExtension.connector_write_validate":
    "sandbox bridge extension: ctx.orgId is the run's bridge context org (rpc-bridge.ts)",
  "apps/api/src/apps/google-drive/bridge.ts#createGoogleDriveBridgeExtension.drive_import":
    "sandbox bridge extension: orgId is the run's bridge context org (rpc-bridge.ts)",
  "apps/api/src/apps/knowledge/knowledge-jobs.ts#runSyncWorker":
    "knowledge sync job: the synced_sources row the job names, loaded in the job's org",
  "apps/api/src/apps/mail/manifest-descriptor.ts#gmail":
    "OAuth client resolver: the connection flow calls it with the org starting the flow (the authenticated route's org)",
  "apps/api/src/apps/mail/search-enrichment.ts#streamFragmentsForRebuild":
    "reindex source: called by the reindex sweep with each org from listOrgIds",
  "apps/api/src/apps/tickets/admin.ts#runAdminOp":
    "tickets admin op from the sandbox bridge: the run's bridge context org",
  "apps/api/src/cli/contacts/apply-provenance.ts#applyProvenance":
    "operator CLI: the org named by --org on the command line",
  "apps/api/src/cli/mailbox-purge.ts#runMailboxPurgeCli":
    "operator CLI: the org named on the command line",
  "apps/api/src/cli/projects/attach-files.ts#runProjectsAttachFiles":
    "operator CLI: the import's target org",
  "apps/api/src/infra/events/durable-consumers.ts#runDurableConsumerLanes":
    "durable event consumer: each event of the batch carries the org it was emitted in",
  "apps/api/src/infra/jobs/event-routine-subscriber.ts#routeEvent":
    "shared handler of one event type: the routes are looked up by the event's own org (evt.orgId), and each route's org is that of the routines row it was registered from (boot load, cell sync re-read by id, resync sweep, create/enable), so the owner gate and ticks run in the event's org only",
  "apps/api/src/modules/agent/subruns/subrun-worker.ts#runSubRun":
    "sub-run worker: the agent_runs row it claimed, in that row's org",
  "apps/api/src/modules/approvals/attention.ts#computeApprovalAttentionItems":
    "attention computer registered by name (app.ts:180): the attention pipeline calls it for the org it is computing",
  "apps/api/src/modules/approvals/payload-title.ts#deriveDetail":
    "name collision: the call reaches the local string helper clean() (payload-title.ts:48), no org involved",
  "apps/api/src/modules/apps/connections/service.ts#getTokenForConnection":
    "the account row the connection query found inside the caller's org (service.ts:1292)",
  "apps/api/src/modules/apps/connections/service.ts#resolveConnectionAccount":
    "the account row the connection query found inside the caller's org, as getTokenForConnection",
  "apps/api/src/modules/apps/execute-tool.ts#createApprovalRequestInBundle":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/apps/execute-tool.ts#executeToolCore":
    "the tool dispatch: opts.orgId is the run's org (executeTool callers: the agent runtime, the REST tool route with c.get('orgId'), the approval cascade with the approval row's org)",
  "apps/api/src/modules/apps/routes.ts#GET /export/:appName":
    "name collision: invokeAppExport calls an app's export handler (ctx, format, filters), not a tool handler; its ctx is createAppContext(c.get('orgId'))",
  "apps/api/src/modules/apps/runtime.ts#runPoll":
    "app poll job: the poll is scheduled per installed org and runs in that org",
  "apps/api/src/modules/attention/digest-jobs.ts#defaultEmitDigestFailureAlert":
    "digest job: the failing user's row and org",
  "apps/api/src/modules/attention/digest-jobs.ts#runDigestUrgentOnce":
    "digest sweep: each pending row's user, loaded with that row's org",
  "apps/api/src/modules/attention/state-materializer.ts#runStateMaterializeOnce":
    "state materializer: run per org by the materializer sweep",
  "apps/api/src/modules/auth/auth.ts#inviteRegister":
    "the user and org the invite registration just created",
  "apps/api/src/modules/auth/routes.ts#POST /password-reset/request":
    "the user the reset address resolves to in the named org; the mail goes to that user only",
  "apps/api/src/modules/demo/api-connector/connection.ts#installDemoApiConnectorConnection":
    "demo seeding: called for the demo org being seeded",
  "apps/api/src/modules/contacts/erasure.ts#release":
    "name collision: erasure.ts's own release() is called by releaseErasedUserContacts with the erasing org (erase-user.ts), never the api-connector transport's release value; it passes that org to deleteContactDiscussions",
  "apps/api/src/modules/erasure/erase-user.ts#eraseUser":
    "erasure: the user row read inside the erasing org (erase-user.ts)",
  "apps/api/src/modules/node-sessions/lifecycle.ts#endDeadRun":
    "node session lifecycle: the session row it locked, in that row's org",
  "apps/api/src/modules/node-sessions/lifecycle.ts#sweepSessionLeases":
    "sweep: node sessions whose lease lapsed; each moved in its own row's org",
  "apps/api/src/modules/node-sessions/lifecycle.ts#unpauseHeldSession":
    "node session lifecycle: the session row it locked, in that row's org",
  "apps/api/src/modules/node-sessions/post-back.ts#registerNodeSessionPostBack":
    "session status listener: the session row whose status changed, in its own org",
  "apps/api/src/modules/provisioning/ensure-org.ts#ensureOrg":
    "provisioning: the org this function found or just created",
  "apps/api/src/modules/push/fanout-consumer.ts#handleMessageCreate":
    "push fan-out: the message-created event's org and its recipients' decisions",
  "apps/api/src/modules/notifications/burst.ts#runBurstFlush":
    "burst summary job: the org of the BurstFlushJob that admitBurst armed for a decision the router built in that org (decision.orgId); its Redis keys and its summary decision are that org's and that recipient's",
  "apps/api/src/modules/search/message-indexer.ts#streamTranscriptForRebuild":
    "reindex source: called by the reindex sweep with each org from listOrgIds",
  "apps/api/src/modules/users/merge-placeholder-tools.ts#run":
    "admin tool: ctx is the run's tool context (refuseWithoutAdmin first)",
  "apps/api/src/modules/users/merge-placeholder.ts#mergePlaceholderIntoUser":
    "the org the merge runs in (its caller's org), passed to the re-index",
  "apps/api/src/modules/apps/sandbox/worker-pool.ts#SandboxWorkerPool.execute":
    "sandbox worker pool: each request's bridge was built by createRpcBridge for the org its caller runs the app for (getWorkerPool().execute in invoke-export, manifest-execution, attention-aggregator, runtime jobs, execute-tool)",
  "apps/api/src/modules/export/routes.ts#GET /":
    "orgId is c.get('orgId') (export/routes.ts:74); the trace reached a literal format argument through a name collision",
  "apps/api/src/infra/events/outbox-worker.ts#ensureOrgRuntimes":
    "outbox worker: org ids read back from kernel.organizations (outbox-worker.ts:113)",
  "apps/api/src/modules/attention/translator.ts#processTranslationEvent":
    "attention translator: the event's own org and the routed user's decision",
  "apps/api/src/modules/search/message-indexer.ts#<module>":
    "index batch grouped by each item's own payload org",
  "apps/api/src/modules/apps/sandbox/bridge/multipart.ts#buildMultipartBody":
    "name collision: a PDF byte buffer, no org involved",
  "apps/api/src/modules/apps/sandbox/bridge/knowledge-curation.ts#createKnowledgeCurationMethods.knowledge_addFolderSource":
    "sandbox bridge method: the run's bridge context org (ctx.orgId)",
  "apps/api/src/modules/node-sessions/lifecycle.ts#afterRunEnded":
    "node session lifecycle: the session row it locked, in that row's org",
  "apps/api/src/modules/apps/run-approved-handler.ts#runApprovedToolHandler":
    "approval execution: the approval row's org (claimed by the cascade inside that org)",
  "apps/api/src/modules/push/node-session-push.ts#pushNodeSessionWaiting":
    "push for a node session: the session row's own org",
  "apps/api/src/modules/org/email-from.ts#getOrgEmailFrom":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/notifications/agent-tools.ts#handleNotificationsSet":
    "agent tool handler: the run's tool context (dispatched by executeToolHandler)",
  "apps/api/src/modules/notifications/agent-tools.ts#handleNotificationsGet":
    "agent tool handler: the run's tool context (dispatched by executeToolHandler); reads only that org's time zone",
  "apps/api/src/modules/demo/shopify/writes.ts#currentTags":
    "name collision: writes.ts's own entityOf(raw gid) classifies a Shopify id, no org involved; the world injectors' entityOf is called by runWorldBeatOnce (world/registry.ts:330) with the org it checked to be a visitor demo org, from the authenticated retry route (c.get('orgId')) or the tour progress hook",
  "apps/api/src/modules/demo/shopify/writes.ts#writeTags":
    "name collision: writes.ts's own entityOf(raw gid), as in currentTags; no org involved",
  "apps/api/src/modules/demo/shopify/search.ts#matchesShopifySearch":
    "name collision: a search-expression parser, no org involved",
  "apps/api/src/modules/demo/demo-reset.ts#runDemoReset":
    "demo reset sweep: the reserved demo orgs found by their reserved slugs",
  "apps/api/src/modules/auth/auth.ts#login":
    "the user row the credentials matched (auth.ts:356), session created in that user's org",
  "apps/api/src/modules/attention/digest-jobs.ts#runCadenceOnce":
    "digest sweep: each pending row's user, loaded with that row's org",
  "apps/api/src/modules/apps/attention-aggregator.ts#invokeKernelProvider":
    "attention aggregator: the org whose attention items are being aggregated (the authenticated caller's)",
  "apps/api/src/apps/tickets/attention.ts#computeAttentionItems":
    "attention computer registered by the tickets app: called for the org being computed",
  "apps/api/src/apps/mail/search-enrichment.ts#planMailFragments":
    "index source registered by the mail app: called by the indexer with each item's own org",
  "apps/api/src/modules/apps/execute-tool.ts#executeApprovedToolHandlerInternal":
    "approval execution: the approval row's org (claimed by the cascade inside that org)",
  "apps/api/src/modules/apps/sandbox/worker-pool.ts#SandboxWorkerPool.executeNested":
    "sandbox worker pool: a nested dispatch from a running handler, for the org of that run",
  "apps/api/src/modules/attention/translator.ts#route":
    "attention translator: the event's own org (event.orgId) and the routed user",
  "apps/api/src/modules/auth/auth.ts#refreshSessionUnder":
    "the session row the refresh token named, in that session's org",
  "apps/api/src/modules/demo/demo-reset.ts#reapExpiredDemoOrgs":
    "demo sweep: expired demo org rows found by the reaper",
  "apps/api/src/modules/export/routes.ts#POST /":
    "orgId is c.get('orgId') (export/routes.ts:39); the trace reached the body's format through a name collision",
  "apps/api/src/modules/notifications/agent-tools.ts#handleNotificationRulesSet":
    "agent tool handler: the run's tool context (dispatched by executeToolHandler)",
  "apps/api/src/modules/notifications/mail-producer.ts#processNewEmailEvent":
    "mail event consumer: the event's own org",
  "apps/api/src/modules/org/purge/deleting.ts#markOrgDeleting":
    "the start of an operator's org deletion: the org the operator named on the box (cli/org-delete.ts, loadOrgToDelete) or the org of the deletion ledger row the org-delete job claimed (modules/org/delete/job.ts); the read is that org's own app state after its own write",
  "apps/api/src/modules/org/email-from.ts#getOrgEmailReplyTo":
    "exported, never called in the server sources (no production path)",
  "apps/api/src/modules/search/message-indexer.ts#TranscriptAccumulator.push":
    "indexer: the accumulator was built for the org being indexed",
  "apps/api/src/modules/agent/routines/routine-worker.ts#runRoutineTick":
    "routine tick job: the routine row the job names, in that row's org",
  "apps/api/src/modules/apps/runtime.ts#buildJobBridge":
    "app job bridge: built for the org the job was enqueued in",
  "apps/api/src/modules/auth/device-flow-routes.ts#GET /poll/:deviceCode":
    "device flow: the request row the device code (the capability) names, approved by its user in that org",
  "apps/api/src/modules/nodes/folder-routes.ts#POST /:id/folders/scan":
    "the node owned by the caller in the caller's org (ownerOf(c))",
  "apps/api/src/modules/notifications/agent-tools.ts#handleThreadMuteSet":
    "agent tool handler: the run's tool context (dispatched by executeToolHandler)",
  "apps/api/src/modules/push/node-session-notify.ts#notifyNodeSessionStatus":
    "node session status: the session row's own org and owner (row.orgId, row.ownerUserId)",
  "apps/api/src/modules/threads/posted-message-dispatch.ts#dispatchForPostedMessage":
    "posted message dispatch: the org of the thread the message was posted in",
  "apps/api/src/modules/apps/sandbox/event-handler-bridge.ts#createEventHandlerBridge":
    "event handler bridge: built for the org the event was emitted in",
  "apps/api/src/modules/apps/sandbox/worker-pool.ts#SandboxWorkerPool.drainQueue":
    "sandbox worker pool: a queued request, carrying the org its caller runs the app for",
  "apps/api/src/modules/auth/magic-link.ts#verifyMagicLink":
    "the user the verified single-use code was issued to, in that user's org",
  "apps/api/src/modules/nodes/folder-routes.ts#POST /:id/folders/remotes":
    "the node owned by the caller in the caller's org (ownerOf(c))",
  "apps/api/src/modules/pdf/render.ts#renderPdf": "PDF render: the calling app run's org",
  "apps/api/src/modules/apps/catalog.ts#reconcileCatalogAppsUnbatched":
    "catalog reconcile sweep: each installed app's own org (orgForApp, read from apps_installed)",
  "apps/api/src/modules/auth/oauth-routes.ts#completeCallback":
    "OAuth sign-in: the org of the provider row the server-side state names",
  "apps/api/src/modules/nodes/folder-routes.ts#askOwn":
    "the node owned by the caller in the caller's org (ownerOf(c))",
  "apps/api/src/apps/tickets/jobs.ts#runFollowupCheck":
    "tickets cron sweep: the orgId of the run's bridge context (sandbox/bridge/tickets.ts tickets_runJob), one org per fan-out run",
  "apps/api/src/cli/provisioners/apps.ts#plan":
    "provisioning plan: ctx.orgId, the kernel tool context's own org on the tool path (buildActorProvisionContext) or the org chosen with resolveOrgId from the operator CLI; `plan` read as a value in apply-provenance.ts is a name collision",
  "apps/api/src/cli/provisioners/api-connectors.ts#plan":
    "provisioning CLI: ctx.orgId, the org chosen with resolveOrgId",
  "apps/api/src/modules/approvals/served-summary.ts#storeApprovalSummaries":
    "demo seed only (served-summary.ts:11): called for the demo org it seeded",
  "apps/api/src/modules/apps/connections/attention.ts#computeConnectionHealthAttentionItems":
    "attention computer registered by name: called for the org being computed",
  "apps/api/src/modules/apps/runtime.ts#unregisterAppEverywhere":
    "app teardown sweep: each org the app is registered in",
  "apps/api/src/modules/apps/sandbox/worker-pool.ts#SandboxWorkerPool.acquire":
    "sandbox worker pool: the request's own org (the caller runs the app for it)",
  "apps/api/src/modules/auth/routes.ts#POST /totp/verify":
    "the user the single-use challenge token names (verified first), in that user's org",
  "apps/api/src/modules/mailbox-crypto/backfill-job.ts#runMailboxBackfillSweep":
    "backfill sweep: users needing a backfill, each in its own row's org",
  "apps/api/src/apps/database/bridge.ts#createDatabaseBridgeExtension.resolveCredentials":
    "sandbox bridge extension: the run's bridge context org (rpc-bridge.ts)",
  "apps/api/src/apps/tickets/jobs.ts#runSlaCheck":
    "tickets cron sweep: the orgId of the run's bridge context (sandbox/bridge/tickets.ts tickets_runJob), one org per fan-out run",
  "apps/api/src/modules/api-connector/routes.ts#<module>":
    "credential check registered for the API connector: the connection route calls it with the authenticated request's org",
  "apps/api/src/modules/apps/runtime.ts#registerInOrder":
    "app registration: the orgId parameter of registerApps (each org initialised by initAppsForOrg); the descriptor carries no org",
  "apps/api/src/modules/mailbox-crypto/mail-writer.ts#applyMailSealToRow":
    "destructured under a new name from a dynamic import (sandbox/bridge/conversion.ts:303); the bridge calls it with the run's bridge context org",
  "apps/api/src/apps/gitlab/bridge.ts#resolveGitlabCreds":
    "sandbox bridge extension: the run's bridge context org (rpc-bridge.ts)",
  "apps/api/src/apps/tickets/search-enrichment.ts#registerTicketsSearchEnrichment":
    "index source registered by the tickets app: called by the indexer with each item's own org",
  "apps/api/src/lib/server.ts#message":
    "websocket frame handler: conn.orgId was set from the ticket verified at upgrade",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketReply":
    "approval summarizer registered by name: the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/mcp/connection-service.ts#mintAccessToken":
    "the MCP connection row found by its id (connection-service.ts:120), refused when revoked; its own org and user",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketNudge":
    "approval summarizer registered by name: the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/mcp/connection-service.ts#resolveConnectionFromToken":
    "the MCP access token's verified payload and its connection row (connection-service.ts:199-230)",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketNoteEdit":
    "approval summarizer registered by name: the approval pipeline calls it inside the approval's org",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketNoteDelete":
    "approval summarizer kept in the summarizer registry (registerApprovalSummarizer): the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/agent/tools/kernel-summarizers.ts#summarizeSubagentCreate":
    "approval summarizer kept in the summarizer registry (registerApprovalSummarizer): the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/nodes/folder-tools.ts#summarizeCloneRepo":
    "approval summarizer kept in the summarizer registry (registerApprovalSummarizer): the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/users/merge-placeholder-tools.ts#summarizeMergeImportedUser":
    "approval summarizer kept in the summarizer registry (registerApprovalSummarizer): the approval pipeline calls it inside the approval's org",
  "apps/api/src/modules/demo/api-connector/responder.ts#maybeDemoApiConnectorResponse":
    "demo responder kept in a registry (registerDemoApiConnectorResponder, api-connector/routes.ts:198): the API connector transport calls it with the request of the org whose connection it is",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketClose":
    "approval summarizer named in the tickets manifest (its summarizer field): registered per org and called for an approval of that org",
  "apps/api/src/modules/mcp/connection-service.ts#refreshAccessToken":
    "the MCP connection row the refresh token names (connection-service.ts:184-195): refused when revoked, its secret compared before any token is minted",
  "apps/api/src/apps/tickets/summarizers.ts#summarizeTicketIdSegmentSet":
    "approval summarizer named in the tickets manifest (its summarizer field): registered per org and called for an approval of that org",
  "apps/api/src/modules/demo/routes.ts#GET /orgs/:orgId/status":
    "public demo status by design (demo/routes.ts:315-345): the URL org id is the v4 uuid the visitor was handed, a non-demo org is a 404, the body is a state word and timestamps",
}

/**
 * Registries that keep a function and call it later (summarizers, responders, index sources),
 * `file#name` → who calls what they keep, with which org.
 */
export const REVIEWED_REGISTRIES: Record<string, string> = {
  "apps/api/src/modules/org/transfer-state/resolver.ts#setIncomingOrgPurge":
    "keeps the one incoming-copy purge (org/transfer/purge.ts); resolveOverdueMoves calls it with the org and transfer id of an `incoming` transfer-state row past its freeze deadline that the control plane reports aborted (resolver.ts), and the purge re-checks that row first",
  "apps/api/src/modules/apps/approval-summarizers.ts#registerApprovalSummarizer":
    "kept per [orgId, app, tool] (approval-summarizers.ts:42-48); the approval pipeline calls it for an approval of that org",
}

export const REVIEWS: OrgTraceReviews = {
  trustedSources: TRUSTED_SOURCES,
  reviewedEscapes: REVIEWED_DISPATCH,
  reviewedOrigins: REVIEWED_ORIGINS,
  reviewedRegistries: REVIEWED_REGISTRIES,
}

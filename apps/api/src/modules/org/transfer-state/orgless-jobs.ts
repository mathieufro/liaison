// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Audit of every background job and worker that is not keyed on an org.
 *
 * The transfer hold (jobs.ts) keys on `job.data.orgId`, so a job without an org
 * in its payload is never held: left alone it would write into a frozen,
 * incoming or moved org (the move's fingerprint check then aborts, or after
 * verify the write is lost). Every such job has an entry here with what it does
 * about moving orgs:
 *
 * - `skips-moving`: it leaves the orgs of `movingOrgIds()` alone. `sources` are
 *   the files that read the moving set (directly, or through `sweepSkippingMoving` or
 *   `writeUnlessMoving` in skip-moving.ts); `orgless-jobs.test.ts` fails when one does not.
 * - `audited`: it writes no per-org rows, or only rows of orgs that are never
 *   moved, or its payload carries `orgId` (so the hold keys on it); `reason`
 *   says which.
 *
 * There is no "not yet audited" state: a scheduled job or a worker registered
 * without an entry fails the test, so whoever adds one chooses.
 */
export type OrglessJobEntry =
  | { status: "skips-moving"; sources: readonly string[] }
  | { status: "audited"; reason: string }

const skips = (...sources: string[]): OrglessJobEntry => ({ status: "skips-moving", sources })
const audited = (reason: string): OrglessJobEntry => ({ status: "audited", reason })

/** The scheduled jobs without an org in their payload, by `app:job`. */
export const ORGLESS_JOB_AUDIT: Readonly<Record<string, OrglessJobEntry>> = {
  "kernel:imports-stale-sweep": skips("modules/imports/sweep.ts"),
  "kernel:secret-request-expiry": skips("modules/secret-requests/service.ts"),
  "kernel:check-device-flow-expiry": skips("infra/jobs/kernel-jobs.ts"),
  "kernel:org-export-sweep": skips("modules/export/org-archive/store.ts"),
  "kernel:cleanup-expired-sessions": skips("infra/jobs/kernel-jobs.ts"),
  "kernel:audit-log-retention": skips("modules/org/audit-retention.ts"),
  "kernel:agent-side-thread-reaper": skips("infra/jobs/agent-side-thread-reaper.ts"),
  "kernel:routine-event-reconcile": skips(
    "modules/agent/routines/routine-event-reconciler.ts",
    "modules/agent/routines/routine-report.ts",
    "modules/agent/routines/routine-run-resume.ts",
  ),
  "kernel:attention-events-retention": skips("infra/jobs/kernel-jobs.ts"),
  "kernel:notification-deliveries-retention": skips("modules/notifications/delivery-log.ts"),
  "kernel:effect-ledger-retention": skips("lib/effect-once.ts"),
  "kernel:away-ranges-prune": skips("modules/users/away.ts"),
  "kernel:calendar-away-refresh": skips("apps/calendar/away-from-calendar.ts"),
  "kernel:agent-turn-retention": skips("modules/agent/runtime/turn-ledger.ts"),
  "kernel:approval-expiry-sweep": skips("modules/approvals/expiry.ts"),
  "kernel:approval-reminder-sweep": skips("modules/approvals/reminders.ts"),
  "kernel:approval-routed-reminder-sweep": skips("modules/approvals/routed-reminders.ts"),
  "kernel:approval-approving-reaper": skips("modules/approvals/approving-reaper.ts"),
  "kernel:approval-deferred-step-reaper": skips("modules/approvals/approving-reaper.ts"),
  "kernel:subrun-stuck-sweep": skips("modules/agent/subruns/subrun-worker.ts"),
  "kernel:routine-mailbox-wait-expiry": skips("modules/agent/routines/routine-mailbox-wait.ts"),
  "kernel:local-claim-lapse-sweep": skips("modules/agent/local-sessions/local-claim-lapse.ts"),
  "kernel:node-lease-sweep": skips(
    "modules/nodes/jobs.ts",
    "modules/nodes/presence.ts",
    "modules/node-sessions/lifecycle.ts",
  ),
  "kernel:control-plane-outbox": skips("modules/liaison-team/team-only.ts"),
  "kernel:attention-state-email-materialize": skips("modules/attention/state-materializer.ts"),
  "kernel:attention-digest-urgent": skips("modules/attention/digest-jobs.ts"),
  "kernel:attention-digest-cadence": skips("modules/attention/digest-jobs.ts"),
  "kernel:attention-digest-hourly": skips("modules/attention/digest-jobs.ts"),
  "kernel:attention-digest-daily": skips("modules/attention/digest-jobs.ts"),
  "kernel:import-uploads-reaper": skips("modules/imports/uploads/service.ts"),
  "kernel:files-orphan-gc": skips("modules/files/orphan-gc.ts"),
  "knowledge:synced-sources-tick": skips("apps/knowledge/knowledge-jobs.ts"),
  "knowledge:stale-running-reclaim": skips("apps/knowledge/knowledge-jobs.ts"),
  "kernel:mailbox-backfill": skips("modules/mailbox-crypto/backfill-job.ts"),
  "kernel:sync-model-pricing": audited("writes the global model price table only; no per-org rows"),
  "kernel:sync-openrouter-prices": audited("writes the global price table only; no per-org rows"),
  "kernel:control-plane-heartbeat": audited(
    "sends instance facts to the control plane and writes the instance-level outbox; no per-org rows",
  ),
  "kernel:cloud-usage-report": audited(
    "reads credit usage and queues reports in the instance-level outbox (idempotent per org and day); writes no per-org rows",
  ),
  "kernel:org-storage-estimate": audited(
    "writes each org's estimate on its own billing row and queues its warnings; a frozen org keeps a stale estimate until the next night's measure on its cell",
  ),
  "kernel:demo-reset": audited(
    "touches demo workspaces only; a demo workspace is never moved (the export refuses it)",
  ),
  "kernel:demo-reap": audited(
    "deletes expired demo workspaces and demo leads only; a demo workspace is never moved (the export refuses it)",
  ),
  "kernel:demo-pool-refill": audited(
    "seeds pooled demo workspaces only; a demo workspace is never moved (the export refuses it)",
  ),
}

const PAYLOAD_HOLD = "its jobs carry orgId in the payload, so the transfer hold keys on them"

/**
 * Every source file (under apps/api/src, tests excluded) that registers a job
 * worker, a scheduled job, a scheduler or a leader singleton, other than the
 * job infrastructure itself. The scheduled jobs inside are audited per key in
 * `ORGLESS_JOB_AUDIT`; the workers and singletons are audited here.
 */
export const ORGLESS_WORKER_AUDIT: Readonly<Record<string, OrglessJobEntry>> = {
  "apps/knowledge/knowledge-jobs.ts": skips("apps/knowledge/knowledge-jobs.ts"),
  "apps/tickets/link-ingest-job.ts": audited(PAYLOAD_HOLD),
  "modules/apps/connections/revoke.ts": audited(
    "the leader works off removed connections' provider calls from an instance-level table; it writes no org's rows",
  ),
  "infra/boot-phase10.ts": audited(
    "the leader's files-policy check changes the catalog's policy, not per-org rows",
  ),
  "infra/events/outbox-worker.ts": skips("infra/events/outbox-worker.ts"),
  "infra/instance-registry.ts": audited("sweeps the instance registry, an instance-level table"),
  "infra/jobs/embedding-backfill.ts": audited(PAYLOAD_HOLD),
  "infra/jobs/event-routine-subscriber.ts": audited(
    "keeps this process's in-memory event subscriptions; writes no rows",
  ),
  "infra/jobs/fanout-runtime.ts": audited(
    "reads the org list and enqueues one job per org, each carrying orgId (held per org); writes no org rows",
  ),
  "infra/jobs/kernel-jobs.ts": skips(
    "infra/jobs/kernel-jobs.ts",
    "modules/agent/runtime/turn-resume.ts",
  ),
  "infra/jobs/legacy-kernel-queue.ts": audited(
    "moves queue entries between queues; writes no rows",
  ),
  "infra/jobs/load-synthetic.ts": audited(PAYLOAD_HOLD),
  "infra/jobs/near-duplicate-clusters.ts": audited(PAYLOAD_HOLD),
  "infra/jobs/webhook-worker.ts": audited(PAYLOAD_HOLD),
  "modules/agent/context/warm-compaction.ts": audited(PAYLOAD_HOLD),
  "modules/agent/memory/consolidation.ts": audited(PAYLOAD_HOLD),
  "modules/agent/subruns/spawn-agent.ts": audited(PAYLOAD_HOLD),
  "modules/agent/subruns/subrun-worker.ts": skips("modules/agent/subruns/subrun-worker.ts"),
  "modules/agent/tools/skills-routines-tools.ts": audited(
    "schedules a routine's tick from a user action; the scheduler carries orgId",
  ),
  "modules/apps/runtime.ts": audited(
    "app jobs run per org through the cron fan-out, each job carrying orgId",
  ),
  "modules/attention/digest-jobs.ts": skips("modules/attention/digest-jobs.ts"),
  "modules/attention/state-materializer.ts": skips("modules/attention/state-materializer.ts"),
  "modules/demo/demo-alerts.ts": audited(
    "checks model price drift on a demo box; writes no per-org rows",
  ),
  "modules/demo/replay/resume.ts": audited("resumes demo replays; a demo workspace is never moved"),
  "modules/export/org-archive/job.ts": audited(PAYLOAD_HOLD),
  "modules/files/delete-object-job.ts": audited(PAYLOAD_HOLD),
  "modules/files/media-analysis-job.ts": audited(PAYLOAD_HOLD),
  "modules/files/orphan-gc.ts": skips("modules/files/orphan-gc.ts"),
  "modules/files/thumbnail-job.ts": audited(PAYLOAD_HOLD),
  "modules/imports/job.ts": audited(PAYLOAD_HOLD),
  "modules/imports/uploads/reaper.ts": skips("modules/imports/uploads/service.ts"),
  "modules/mailbox-crypto/backfill-job.ts": skips("modules/mailbox-crypto/backfill-job.ts"),
  "modules/mcp-client/index.ts": skips("modules/mcp-client/env-bootstrapper.ts"),
  "modules/org/delete/job.ts": audited(
    "started by an admin's request, which the freeze refuses; a deleting org is never exported",
  ),
  "modules/org/delete/legal-archive.ts": audited(
    "prunes the archives of orgs that were already deleted; a moving org is not one",
  ),
  "modules/org/transfer-state/resolver.ts": audited("the move's own resolver"),
  "modules/search/drift.ts": audited(
    "the full search rebuild reads org rows and writes only the derived search index; a moved org's documents are re-indexed and purged by the move itself",
  ),
  "modules/search/indexer.ts": audited(PAYLOAD_HOLD),
  "modules/search/live-index-queue.ts": audited(
    "the live-index flush and sweep write only the derived search index; flushing a moving org's queued documents is how its index catches up, and the move purges it",
  ),
  "modules/search/message-indexer.ts": audited(PAYLOAD_HOLD),
}

/** Source files that are the job infrastructure itself, not jobs. */
export const JOB_INFRASTRUCTURE_FILES: readonly string[] = [
  "infra/jobs/jobs.ts",
  "infra/leadership.ts",
]

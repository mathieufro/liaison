// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison app run-job <app> <job> [--org <slug|id>] [--params-json <json>] [--wait] [--timeout <seconds>]`:
 * run one app job for one org now, as an operator.
 *
 * The job goes through the production on-demand path: the org's apps are set
 * up in this process (so the job's registration is known and checked),
 * `enqueueAppJob` puts `{ ...params, orgId }` on the job's queue with its
 * gates (the app must be On for the org), and the SERVER's job worker runs it
 * (`runtime.ts`, the manifest job branches: org checks, bridge, sandbox). The
 * CLI never hosts a job (cli-never-hosts-jobs.test.ts). One attempt: an
 * operator's run that fails is reported, never retried behind their back.
 *
 * Without `--wait` it prints `{ jobId }`. With `--wait` it polls the job until
 * it finishes and prints `{ jobId, ok, ms, error? }` (`ms`: the run, from the
 * worker's start to its end), exit 1 when the job failed or the wait ran out.
 * STDOUT carries the JSON report; a refusal's message goes to STDERR.
 */
import type { Job } from "bullmq"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"

export const APP_RUN_JOB_USAGE =
  "usage: liaison app run-job <app> <job> [--org <slug|id>] [--params-json <json>] [--wait] [--timeout <seconds>]"

export interface AppRunJobResult {
  exitCode: number
  report: unknown
  message?: string
}

/** What a finished (or unfinished) job looks like to the wait. */
export interface JobSnapshot {
  state: string
  processedOn?: number
  finishedOn?: number
  failedReason?: string
}

/** The services the command calls; a test passes its own. */
export interface AppRunJobDeps {
  resolveOrg(
    org: string | undefined,
  ): Promise<{ ok: true; orgId: string } | { ok: false; message: string }>
  ensureAppsForOrg(orgId: string): Promise<void>
  enqueue(appName: string, jobName: string, payload: Record<string, unknown>): Promise<string>
  readJob(appName: string, jobName: string, jobId: string): Promise<JobSnapshot | null>
  sleep(ms: number): Promise<void>
  pollIntervalMs: number
}

export async function defaultAppRunJobDeps(): Promise<AppRunJobDeps> {
  const jobs = await import("~/infra/jobs/jobs")
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  return {
    resolveOrg: (org) =>
      resolveOrgId(org, "multiple orgs exist — pass --org <slug|id> to say which one"),
    ensureAppsForOrg,
    enqueue: (appName, jobName, payload) =>
      jobs.enqueueAppJob(appName, jobName, payload, { attempts: 1 }),
    readJob: async (appName, jobName, jobId) => {
      const job: Job | undefined = await jobs.getJobQueue(appName, jobName).getJob(jobId)
      if (!job) return null
      return {
        state: await job.getState(),
        ...(job.processedOn !== undefined ? { processedOn: job.processedOn } : {}),
        ...(job.finishedOn !== undefined ? { finishedOn: job.finishedOn } : {}),
        ...(job.failedReason ? { failedReason: job.failedReason } : {}),
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 500,
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The job's params: a JSON object, without `orgId` or the host's own `_` handles. */
function parseParams(raw: string | undefined): Record<string, unknown> | string {
  if (raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "--params-json is not valid JSON"
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "--params-json must be a JSON object"
  }
  const keys = Object.keys(parsed)
  if (keys.some((k) => k === "orgId" || k.startsWith("_"))) {
    return "--params-json may not set orgId or keys starting with _ (the job host's own)"
  }
  return parsed as Record<string, unknown>
}

/** `argv` is what follows `app run-job`. */
export async function runAppRunJob(
  argv: readonly string[],
  deps: AppRunJobDeps,
): Promise<AppRunJobResult> {
  const valued = new Set(["--org", "--params-json", "--timeout"])
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""))
  const [appName, jobName] = positional
  const timeoutRaw = flag(argv, "--timeout")
  const timeoutSeconds = timeoutRaw !== undefined ? Number(timeoutRaw) : 600
  if (
    !appName ||
    !jobName ||
    positional.length > 2 ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return { exitCode: 2, report: null, message: APP_RUN_JOB_USAGE }
  }
  const params = parseParams(flag(argv, "--params-json"))
  if (typeof params === "string") {
    return { exitCode: 2, report: null, message: `run-job: ${params}` }
  }
  const resolved = await deps.resolveOrg(flag(argv, "--org"))
  if (!resolved.ok) return { exitCode: 2, report: null, message: `run-job: ${resolved.message}` }
  const orgId = resolved.orgId

  // The org's apps set up here, so the job's registration is known: an unknown
  // job is refused before anything is queued.
  await deps.ensureAppsForOrg(orgId)
  let jobId: string
  try {
    jobId = await deps.enqueue(appName, jobName, { ...params, orgId })
  } catch (err) {
    return {
      exitCode: 1,
      report: null,
      message: `run-job: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!argv.includes("--wait")) return { exitCode: 0, report: { jobId } }

  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    const job = await deps.readJob(appName, jobName, jobId)
    if (job && (job.state === "completed" || job.state === "failed")) {
      const ms =
        job.processedOn !== undefined && job.finishedOn !== undefined
          ? job.finishedOn - job.processedOn
          : null
      const ok = job.state === "completed"
      return {
        exitCode: ok ? 0 : 1,
        report: { jobId, ok, ms, ...(ok ? {} : { error: job.failedReason ?? "failed" }) },
      }
    }
    if (Date.now() >= deadline) {
      return {
        exitCode: 1,
        report: { jobId, ok: false, ms: null, error: `not finished after ${timeoutSeconds}s` },
        message: `run-job: ${appName}:${jobName} is still ${job?.state ?? "unknown"}; it keeps its place on the queue`,
      }
    }
    await deps.sleep(deps.pollIntervalMs)
  }
}

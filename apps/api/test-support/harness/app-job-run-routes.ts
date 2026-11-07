// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: run one app job for one org NOW and answer when it has finished.
//
//   POST /api/_test/apps/:app/jobs/:job/run   { orgId, params? }
//     200 { data: { ok: true, ms } }        the job ran to completion
//     200 { data: { ok: false, ms, error } } the job threw (message only)
//
// The run goes through the job worker's own dispatch (`JobsTestAccess.processJob`:
// org gates, org setup, the injected `_tx` / `_session`, the registered handler),
// so a manifest app's job reaches the sandbox through the same runtime path an
// enqueued on-demand job takes (runtime.ts, `jobDef.onDemand`). Unlike `/run-job`
// (apps-install-routes.ts), which enqueues and returns at once, this waits, so a
// harness can time a run and read its outcome.
//
// Mounted by qa-seed-routes.ts only when `qaSeedRoutesEnabled`; each request
// checks the flag again, so a stale build never serves it.

import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { qaSeedRoutesEnabled } from "~/lib/env"

const runBody = z.object({
  orgId: z.string().uuid(),
  // The job's payload beside `orgId`. Underscore keys are the job host's own
  // handles (`_tx`, `_session`, `_userId`, `_callerScopes`): never from a caller.
  params: z
    .record(z.string(), z.unknown())
    .refine((p) => Object.keys(p).every((k) => !k.startsWith("_") && k !== "orgId"), {
      message: "params may not set orgId or underscore keys",
    })
    .optional(),
})

type RunJob = (appName: string, jobName: string, data: unknown, queueName: string) => Promise<void>

export function createAppJobRunRoutes(
  opts: { enabled?: () => boolean; runJob?: RunJob } = {},
): Hono<AppEnv> {
  const enabled = opts.enabled ?? (() => qaSeedRoutesEnabled)
  const runJob: RunJob =
    opts.runJob ??
    ((appName, jobName, data, queueName) =>
      JobsTestAccess.processJob(appName, jobName, data, queueName))
  return new Hono<AppEnv>().post("/:app/jobs/:job/run", async (c) => {
    if (!enabled()) throw new HTTPException(404, { message: "Not found" })
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw new HTTPException(400, { message: "Body must be JSON" })
    }
    const parsed = runBody.safeParse(raw)
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Bad body" })
    }
    const appName = c.req.param("app")
    const jobName = c.req.param("job")
    const data = { ...(parsed.data.params ?? {}), orgId: parsed.data.orgId }
    const started = performance.now()
    try {
      await runJob(appName, jobName, data, `app-${appName}`)
      return c.json({ data: { ok: true, ms: Math.round(performance.now() - started) } })
    } catch (err) {
      return c.json({
        data: {
          ok: false,
          ms: Math.round(performance.now() - started),
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  })
}

export const appJobRunTestRoutes = createAppJobRunRoutes()

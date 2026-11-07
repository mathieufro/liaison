// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison app run-job`: the production enqueue (`enqueueAppJob`) and the real
 * queue read of `defaultAppRunJobDeps`, with a job worker registered in this
 * (test, job-hosting) process standing in for the server's. Proves the handler
 * ran for the resolved org with the given params, a failed job reports
 * `ok: false` and its error, and an unknown job or bad params queue nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { type AppRunJobDeps, defaultAppRunJobDeps, runAppRunJob } from "~/cli/app/run-job"
import { closeAllQueues, registerJobWorker } from "~/infra/jobs/jobs"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = `runjobprobe${crypto.randomUUID().slice(0, 6)}`
const ran: Array<Record<string, unknown>> = []
let orgId: string
let orgSlug: string
let deps: AppRunJobDeps
const ensured: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  orgSlug = `cli-runjob-${crypto.randomUUID().slice(0, 12)}`
  orgId = (await ensureOrg({ slug: orgSlug, name: "RunJobOrg" })).orgId
  registerJobWorker(APP, "probe", async (payload: Record<string, unknown>) => {
    const { _tx, _session, ...rest } = payload
    ran.push(rest)
  })
  registerJobWorker(APP, "boom", async () => {
    throw new Error("probe failure")
  })
  const real = await defaultAppRunJobDeps()
  deps = {
    ...real,
    ensureAppsForOrg: async (id) => {
      ensured.push(id)
    },
    pollIntervalMs: 50,
  }
})

afterAll(async () => {
  await Promise.race([closeAllQueues(), Bun.sleep(2000)])
  const keys = await redisBullMQ.keys(`${bullPrefix}:app-${APP}*`)
  if (keys.length > 0) await redisBullMQ.del(...keys)
  await releaseTestLock()
})

describe("app run-job", () => {
  test("--wait: the job ran for that org with its params, and reports ok and ms", async () => {
    const res = await runAppRunJob(
      [APP, "probe", "--org", orgSlug, "--params-json", '{"days":3}', "--wait", "--timeout", "30"],
      deps,
    )
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)
    expect(res.report).toMatchObject({ ok: true })
    expect(typeof (res.report as { ms: unknown }).ms).toBe("number")
    expect(ensured).toContain(orgId)
    expect(ran).toEqual([{ days: 3, orgId }])
  }, 40_000)

  test("--wait on a failing job: ok false with its error, exit 1", async () => {
    const res = await runAppRunJob([APP, "boom", "--org", orgId, "--wait", "--timeout", "30"], deps)
    expect(res.exitCode).toBe(1)
    expect(res.report).toMatchObject({ ok: false, error: "probe failure" })
  }, 40_000)

  test("without --wait: prints the job id", async () => {
    const res = await runAppRunJob([APP, "probe", "--org", orgSlug], deps)
    expect(res.exitCode).toBe(0)
    expect(typeof (res.report as { jobId: unknown }).jobId).toBe("string")
  })

  test("an unknown job, bad params or a missing job name queue nothing", async () => {
    const before = ran.length
    const unknown = await runAppRunJob([APP, "nope", "--org", orgSlug, "--wait"], deps)
    expect(unknown.exitCode).toBe(1)
    expect(unknown.message).toContain("No handler registered")
    expect(
      (await runAppRunJob([APP, "probe", "--org", orgSlug, "--params-json", '{"orgId":"x"}'], deps))
        .exitCode,
    ).toBe(2)
    expect(
      (await runAppRunJob([APP, "probe", "--org", orgSlug, "--params-json", "[1]"], deps)).exitCode,
    ).toBe(2)
    expect((await runAppRunJob([APP], deps)).exitCode).toBe(2)
    expect((await runAppRunJob([APP, "probe", "--org", "no-such-org"], deps)).exitCode).toBe(2)
    await Bun.sleep(300)
    expect(ran.length).toBeLessThanOrEqual(before + 1) // only the no-wait run above may land
  })
})

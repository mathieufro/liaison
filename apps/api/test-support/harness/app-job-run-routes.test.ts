// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { createAppJobRunRoutes } from "./app-job-run-routes"

const ORG = crypto.randomUUID()

const post = (routes: ReturnType<typeof createAppJobRunRoutes>, path: string, body: unknown) =>
  routes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("POST /api/_test/apps/:app/jobs/:job/run", () => {
  it("is 404 without the QA flag, and runs nothing", async () => {
    let ran = 0
    const routes = createAppJobRunRoutes({ enabled: () => false, runJob: async () => void ran++ })
    const res = await post(routes, "/kpi/jobs/refresh/run", { orgId: ORG })
    expect(res.status).toBe(404)
    expect(ran).toBe(0)
  })

  it("hands the job worker's dispatch the app, job, payload and app queue", async () => {
    const calls: unknown[][] = []
    const routes = createAppJobRunRoutes({
      enabled: () => true,
      runJob: async (...args) => void calls.push(args),
    })
    const res = await post(routes, "/kpi/jobs/refresh/run", { orgId: ORG, params: { day: 3 } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true)
    expect(calls).toEqual([["kpi", "refresh", { day: 3, orgId: ORG }, "app-kpi"]])
  })

  it("refuses host handles and a second orgId in params", async () => {
    const routes = createAppJobRunRoutes({ enabled: () => true, runJob: async () => {} })
    for (const params of [{ _tx: 1 }, { _userId: "u" }, { orgId: crypto.randomUUID() }]) {
      expect((await post(routes, "/kpi/jobs/refresh/run", { orgId: ORG, params })).status).toBe(400)
    }
  })

  it("answers a job's failure in the body", async () => {
    const routes = createAppJobRunRoutes({
      enabled: () => true,
      runJob: async () => {
        throw new Error("boom")
      },
    })
    const body = (await (await post(routes, "/kpi/jobs/refresh/run", { orgId: ORG })).json()) as {
      data: { ok: boolean; error: string }
    }
    expect(body.data).toMatchObject({ ok: false, error: "boom" })
  })

  describe("through the real job dispatch", () => {
    beforeAll(async () => {
      await seedOrgRow({ id: ORG, name: "Job run route org", slug: `job-run-${ORG.slice(0, 8)}` })
    })
    afterAll(async () => {
      forgetOrgApps(ORG)
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    })

    it("runs the registered handler for the org and waits for it", async () => {
      const seen: unknown[] = []
      registerJobWorker(
        "jobrun-probe",
        "tick",
        async (payload) => {
          await Bun.sleep(20)
          seen.push(payload)
        },
        { txMode: "session" },
      )
      const routes = createAppJobRunRoutes({ enabled: () => true })
      const res = await post(routes, "/jobrun-probe/jobs/tick/run", {
        orgId: ORG,
        params: { n: 1 },
      })
      const body = (await res.json()) as { data: { ok: boolean; ms: number; error?: string } }
      expect(body.data.error).toBeUndefined()
      expect(body.data.ok).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ orgId: ORG, n: 1 })
      // The job host injected its session handle; the caller could not.
      expect((seen[0] as { _session?: unknown })._session).toBeDefined()
    })
  })
})

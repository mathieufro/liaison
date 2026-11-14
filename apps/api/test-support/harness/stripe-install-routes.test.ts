// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The test server's payments-connector routes: one call installs the built app
// for an org and connects it with a restricted key (an inert one unless a body
// supplies another), and the mock-control routes seed, fail, list and reset the
// API mock the server's sandbox fetch goes through.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { manifestRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { resolveStripeInstallCredentials, stripeTestInstallRoutes } from "./stripe-install-routes"
import { makeStripeMockFetch, stripeMockReset } from "./stripe-mock-fetch"

const app = new Hono().route("/api/_test/stripe", stripeTestInstallRoutes)
let installRoot: string
let orgId: string

async function post(path: string, body: unknown = {}): Promise<Response> {
  return app.request(`/api/_test/stripe${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function removeInstall(): Promise<void> {
  await withSystemDb("stripe-install-routes-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, "stripe"))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "stripe"))
  })
}

beforeAll(async () => {
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "stripe-install-routes-"))
  process.env.LIAISON_APPS_DIR = installRoot
  await removeInstall()
  ensureBundledAppBuilt("stripe")
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
}, 240_000)

afterAll(async () => {
  await removeInstall()
  resetAppRegistries()
  stripeMockReset()
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await releaseTestLock()
})

describe("resolveStripeInstallCredentials", () => {
  it("uses an inert restricted key unless the body supplies one", () => {
    expect(resolveStripeInstallCredentials()).toEqual({ restrictedKey: "rk_test_mock" })
    expect(resolveStripeInstallCredentials({ restrictedKey: "rk_test_other" })).toEqual({
      restrictedKey: "rk_test_other",
    })
  })
})

describe("the payments connector's test install route", () => {
  it("installs the app for the org, registers it and stores its connection", async () => {
    const res = await post("/install-for-test", { orgId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { appName: string; connectionId: string }
    expect(body.appName).toBe("stripe")
    expect(manifestRegistry.get([orgId, "stripe"])).toBeDefined()
    const rows = await sql<{ id: string; app_name: string }[]>`
      SELECT id, app_name FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND app_name = 'stripe'`
    expect(rows.map((r) => r.id)).toEqual([body.connectionId])
  }, 120_000)

  it("a second install replaces the connection instead of adding one", async () => {
    const res = await post("/install-for-test", { orgId })
    expect(res.status).toBe(200)
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND app_name = 'stripe'`
    expect(row?.n).toBe(1)
  }, 120_000)
})

describe("the payments connector's mock-control routes", () => {
  const mock = makeStripeMockFetch(async () => new Response("real", { status: 599 }))
  const call = (path: string) =>
    mock(`https://api.stripe.com${path}`, {
      headers: { "Stripe-Version": "2026-10-28.endive", Authorization: "Bearer rk_test_mock" },
    })

  it("seeds an object the mock then serves, and lists the calls it saw", async () => {
    expect((await post("/mock/reset")).status).toBe(200)
    const seeded = await post("/mock/seed", {
      resource: "customers",
      object: { id: "cus_seeded", email: "seeded@client.example" },
    })
    expect(seeded.status).toBe(200)
    const got = (await (await call("/v1/customers/cus_seeded")).json()) as { email: string }
    expect(got.email).toBe("seeded@client.example")
    const listed = (await (await app.request("/api/_test/stripe/mock/requests")).json()) as {
      requests: Array<{ path: string }>
    }
    expect(listed.requests.map((r) => r.path)).toEqual(["/v1/customers/cus_seeded"])
  })

  it("fails the next call to a path once with the chosen status", async () => {
    expect((await post("/mock/fail-next", { path: "/v1/disputes", status: 403 })).status).toBe(200)
    expect((await call("/v1/disputes")).status).toBe(403)
    expect((await call("/v1/disputes")).status).toBe(200)
  })

  it("reset forgets seeded objects and recorded calls", async () => {
    expect((await post("/mock/reset")).status).toBe(200)
    expect((await call("/v1/customers/cus_seeded")).status).toBe(404)
    const listed = (await (await app.request("/api/_test/stripe/mock/requests")).json()) as {
      requests: unknown[]
    }
    expect(listed.requests).toHaveLength(1)
  })
})

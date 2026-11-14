// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel company reads feed dashboards: each one saves as a block's source and runs as the
// viewer through the dashboard path (createDashboard judges the source at save,
// getBlockData runs it read-only). Real tools, a real company, no stand-in handler.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { type UserContext, withRlsContext } from "~/db/rls"
import { createCompanies } from "~/modules/contacts/companies"
import { type BlockCacheStore, BlockCacheTestAccess } from "~/modules/dashboards/cache"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "kernel:dashboards:read",
  "kernel:dashboards:write",
  "kernel:companies:read",
  "kernel:contacts:read",
]

let orgId = ""
let owner = ""
let companyId = ""

const as = (): UserContext => ({
  actorType: "user",
  userId: owner,
  orgId,
  scopes: SCOPES,
  dimensionGrants: {},
})

function memoryStore(): BlockCacheStore {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
    },
    async increment(k) {
      const n = Number(data.get(k) ?? 0) + 1
      data.set(k, String(n))
      return n
    },
    async setIfAbsent(k) {
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Company Sources Org" })).orgId
  owner = (await minimal.orgAdmin(orgId)).id
  const [company] = await withRlsContext(as(), (tx) =>
    createCompanies(tx as never, {
      orgId,
      userId: owner,
      inputs: [{ name: "Maison Verdier", domain: "verdier.example" }],
    }),
  )
  companyId = company?.id ?? ""
})

afterAll(async () => {
  await releaseTestLock()
})

afterEach(() => BlockCacheTestAccess.setStore(null))

/** Saves a one-block personal dashboard on `tool` and runs that block as the owner. */
async function saveAndRun(tool: string, params: Record<string, unknown>, rowsPath?: string) {
  BlockCacheTestAccess.setStore(memoryStore())
  const block = {
    id: "b",
    type: "metric",
    title: tool,
    source: { kind: "tool", tool, params, ...(rowsPath ? { rowsPath } : {}) },
    map: { agg: "count" },
  }
  const d = await createDashboard(as(), {
    title: `On ${tool}`,
    visibility: "personal",
    spec: { v: 1, blocks: [block] },
  })
  return getBlockData(as(), d.id, "b")
}

describe("company reads feed a dashboard block", () => {
  it("kernel companies_search: the block counts the companies", async () => {
    const out = await saveAndRun("kernel:companies_search", {})
    expect(out).toMatchObject({ ok: true, data: { kind: "metric", value: 1 } })
  })

  it("kernel companies_read: the block counts the company's people (rowsPath people)", async () => {
    const out = await saveAndRun("kernel:companies_read", { companyId }, "people")
    expect(out).toMatchObject({ ok: true, data: { kind: "metric", value: 0 } })
  })

  it("kernel company_timeline: the block runs on the company's timeline rows", async () => {
    const out = await saveAndRun("kernel:company_timeline", { companyId })
    expect(out).toMatchObject({ ok: true, data: { kind: "metric", value: 0 } })
  })

  it("kernel companies_find_duplicates: the block counts the likely pairs", async () => {
    const out = await saveAndRun("kernel:companies_find_duplicates", {})
    expect(out).toMatchObject({ ok: true, data: { kind: "metric", value: 0 } })
  })

  it("kernel companies_propose_from_contacts: the block counts the proposed groups", async () => {
    const out = await saveAndRun("kernel:companies_propose_from_contacts", {})
    expect(out).toMatchObject({ ok: true, data: { kind: "metric", value: 0 } })
  })
})

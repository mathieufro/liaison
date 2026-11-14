// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo marker cache across processes. A deployment runs several processes
// and the marker is written on one (a pool claim, the welcome answer, an
// extended expiry): another process must not keep answering from the marker it
// cached before. Regression: a replica held a claimed pool org's old marker for
// up to 30 seconds.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import {
  DemoOrgTestAccess,
  invalidateDemoMarker,
  loadDemoMarker,
  markOrgAsDemo,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: "demo-org-cache", name: "Demo Org Cache" })).orgId
})

afterAll(async () => {
  await invalidateDemoMarker()
  await releaseTestLock()
})

describe("the demo marker cache", () => {
  it("re-reads the marker another process wrote, at once", async () => {
    const first = visitorMarker(24)
    await markOrgAsDemo(orgId, first)
    expect((await loadDemoMarker(orgId))?.expiresAt).toBe(first.expiresAt)

    // Another process writes the row and bumps the version; this process's
    // cache still holds the old marker.
    const later = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    await sql`UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', to_jsonb(${later}::text), false)
      WHERE id = ${orgId}`
    await DemoOrgTestAccess.bumpVersionAsAnotherProcess(orgId)

    expect((await loadDemoMarker(orgId))?.expiresAt).toBe(later)
  })

  it("drops a marker read while the org was being purged once the purge ends", async () => {
    await markOrgAsDemo(orgId, visitorMarker(24))
    // The purge sweeps the org's Redis keys, its version counter among them,
    // before it deletes the row: a read in between caches the marker.
    await redis.del(`demo:marker-version:${orgId}`)
    expect(await loadDemoMarker(orgId)).not.toBeNull()
    // Then the row goes (here: its marker), and the purging process says so.
    await sql`UPDATE kernel.organizations SET settings = settings - 'demo' WHERE id = ${orgId}`
    await DemoOrgTestAccess.endPurgeAsAnotherProcess(orgId)

    expect(await loadDemoMarker(orgId)).toBeNull()
  })

  it("keeps answering from the cache while nothing changed", async () => {
    await markOrgAsDemo(orgId, visitorMarker(24))
    const cached = await loadDemoMarker(orgId)
    // A row change nobody announced is not seen before the TTL: the cache hit.
    await sql`UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', to_jsonb('2099-01-01T00:00:00.000Z'::text), false)
      WHERE id = ${orgId}`
    expect((await loadDemoMarker(orgId))?.expiresAt).toBe(cached?.expiresAt)
  })
})

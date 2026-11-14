// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connecting the payments connector leaks no key: the REAL built app is
// installed on a spawned server, a full-length restricted key is saved through
// the credential path, and the key check runs over the tool route into the
// QuickJS sandbox, whose requests reach the API mock with the key added by the
// host. Afterwards no thread message, tool result, approval, event, audit row or
// log line holds a restricted key, a secret key or a signing secret, and the
// logs hold no card detail beyond brand, last 4 and expiry.
//
// Positive controls first, so the greps cannot pass vacuously: the mock proves
// it received the key (by its hash), and the captured logs hold a line the
// check is known to write.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isCardNumber } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { setupScenario, teardownScenario } from "./setup"

// Full length, so a mask that needs 10 key characters would find them.
const RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`
const SECRET = `sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}`
const KEY_SHAPE = /(rk|sk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/
const PAN = "4917484589897107"
// A live-mode key of the same length, refused while the connection holds test-mode data.
const LIVE_RESTRICTED = `rk_live_${"9ZyXwVuTsRqPoNmLkJiHgFeD"}`
const sha = (v: string) => createHash("sha256").update(v).digest("hex")

function buildBundle(): void {
  const r = spawnSync("bash", ["scripts/build-bundled-app.sh", "stripe", "--skip-sign"], {
    cwd: `${import.meta.dir}/../../../../..`,
    stdio: "pipe",
    encoding: "utf8",
  })
  if (r.status !== 0) throw new Error(`build failed (${r.status}): ${r.stderr || r.stdout}`)
}

/** Every 13 to 19 digit run that is a card number. */
function cardNumbersIn(text: string): string[] {
  return (text.match(/\d[\d -]{11,22}\d/g) ?? [])
    .map((m) => m.replace(/\D/g, ""))
    .filter((d) => isCardNumber(d))
}

describe("payments connector: connecting holds no key anywhere", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let schema: string
  let threadId: string
  const results: string[] = []
  let refusal = ""

  beforeAll(async () => {
    const r = await setupScenario({
      seed: 83,
      org: { name: "Payments Connect Org" },
      populate: { users: { count: 2 } },
      serverEnv: { LOG_LEVEL: "debug" },
      ownServer: true,
    })
    env = r.env
    world = r.world
    url = env.serverUrl
    schema = `${env.schemaPrefix ?? ""}kernel`
    buildBundle()
    const thread = await world.threads.create(world.users[0], {
      participantIds: [world.users[1].id],
      initialMessage: { content: "Connect the payments account" },
    })
    threadId = thread.id
    await api(url, "/api/_test/stripe/mock/reset", { method: "POST", token: world.admin.token })
    // A charge whose card shows only brand, last 4 and expiry, as Stripe returns it.
    await api(url, "/api/_test/stripe/mock/seed", {
      method: "POST",
      token: world.admin.token,
      body: { resource: "charges", object: { id: "ch_CONNECT0001", description: "Plan" } },
    })

    // The connect: the key through the credential path, a secret key refused, the check.
    const install = await api(url, "/api/_test/stripe/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id, credentials: { restrictedKey: RESTRICTED } },
    })
    if (install.status !== 200) throw new Error(`install failed: ${JSON.stringify(install.body)}`)
    const refused = await api(url, "/api/connections/stripe/stripe/credentials", {
      method: "POST",
      token: world.admin.token,
      body: { mode: "org", credentials: { restrictedKey: SECRET } },
    })
    refusal = JSON.stringify(refused.body)
    for (const tool of ["connection_check", "settings_load"]) {
      const res = await api(url, `/api/apps/tools/stripe:${tool}`, {
        method: "POST",
        token: world.admin.token,
        body: { params: {}, threadId },
      })
      results.push(JSON.stringify({ status: res.status, body: res.body }))
    }
  })

  afterAll(async () => {
    await teardownScenario(env, world)
  })

  it("after a connect no message, tool result or log line holds a restricted key, secret key or signing secret", async () => {
    // Positive control 1: the stored key reached the API, added by the host.
    const listed = await api(url, "/api/_test/stripe/mock/requests", { token: world.admin.token })
    const requests = (
      listed.body as { requests: Array<{ path: string; authorizationSha256: string | null }> }
    ).requests
    const want = createHash("sha256").update(RESTRICTED).digest("hex")
    expect(requests.length).toBeGreaterThanOrEqual(10)
    expect(requests.every((r) => r.authorizationSha256 === want)).toBe(true)
    // Positive control 2: the logs were captured, and hold the check's own tool call.
    const logs = `${env.getStdout()}\n${env.getStderr()}`
    expect(logs).toContain("stripe:connection_check")

    // The check ran and answered its rows.
    expect(results[0]).toContain('"checks"')
    expect(refusal).toContain("secret_key_refused")

    const rows = await env.db.sql.unsafe(
      `SELECT 'messages' AS t, content::text AS v FROM ${schema}.messages WHERE org_id = $1
       UNION ALL SELECT 'events', payload::text FROM ${schema}.pending_events WHERE org_id = $1
       UNION ALL SELECT 'audit', coalesce(changes::text, '') || coalesce(metadata::text, '') FROM ${schema}.audit_log WHERE org_id = $1
       UNION ALL SELECT 'approvals', current_payload::text FROM ${schema}.approval_requests WHERE org_id = $1
       UNION ALL SELECT 'credentials', coalesce(credentials_encrypted, '') FROM ${schema}.connected_accounts
         WHERE org_id = $1 AND app_name = 'stripe'`,
      [world.org.id],
    )
    const stored = (rows as unknown as Array<{ t: string; v: string | null }>).map(
      (r) => `${r.t}:${r.v ?? ""}`,
    )
    expect(stored.some((s) => s.startsWith("credentials:"))).toBe(true)

    for (const [where, text] of [
      ["logs", logs],
      ["tool results", results.join("\n")],
      ["refusal", refusal],
      ["database", stored.join("\n")],
    ] as const) {
      expect({ where, hit: text.match(KEY_SHAPE)?.[0] ?? null }).toEqual({ where, hit: null })
      expect({ where, key: text.includes(RESTRICTED.slice(8)) }).toEqual({ where, key: false })
    }
  })

  it("logs hold no payment detail beyond brand, last 4 and expiry", () => {
    const logs = `${env.getStdout()}\n${env.getStderr()}`
    // Positive control: the scan finds a card number when one is there.
    expect(cardNumbersIn(`card ${PAN}`)).toEqual([PAN])
    expect(cardNumbersIn(logs)).toEqual([])
    expect(logs).not.toMatch(/"(cvc|cvv|number)"\s*:\s*"\d/)
  })

  it("a key of the other mode is refused before it is stored, and the stored key stays the one a sync uses", async () => {
    const token = world.admin.token
    // The stored key's check records the connection's mode (test).
    const first = await api(url, "/api/apps/tools/stripe:connection_check", {
      method: "POST",
      token,
      body: { params: {}, threadId },
    })
    expect(JSON.stringify(first.body)).toContain('"mode":"test"')
    await api(url, "/api/_test/stripe/mock/reset", { method: "POST", token })

    const refused = await api(url, "/api/connections/stripe/stripe/credentials", {
      method: "POST",
      token,
      body: { mode: "org", credentials: { restrictedKey: LIVE_RESTRICTED } },
    })
    expect(refused.status).toBe(422)
    expect((refused.body as { error: { code: string } }).error.code).toBe("mode_changed")
    expect(JSON.stringify(refused.body)).not.toContain(LIVE_RESTRICTED)
    // The check did run with the new key (positive control)...
    const during = await api(url, "/api/_test/stripe/mock/requests", { token })
    const sent = (during.body as { requests: Array<{ authorizationSha256: string | null }> })
      .requests
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((r) => r.authorizationSha256 === sha(LIVE_RESTRICTED))).toBe(true)

    // ...and the stored credential still decrypts to the first key.
    const rows = (await env.db.sql.unsafe(
      `SELECT credentials_encrypted AS c FROM ${schema}.connected_accounts
       WHERE org_id = $1 AND app_name = 'stripe' AND status = 'active'`,
      [world.org.id],
    )) as unknown as Array<{ c: string }>
    expect(rows).toHaveLength(1)
    const stored = JSON.parse(
      decryptSecret(rows[0]?.c ?? "", env.encryptionKey, CryptoContext.connectedAccountCredentials),
    ) as { restrictedKey: string }
    expect(stored.restrictedKey === RESTRICTED).toBe(true)

    // A sync after the refusal reaches Stripe with the first key.
    await api(url, "/api/_test/stripe/mock/reset", { method: "POST", token })
    const after = await api(url, "/api/apps/tools/stripe:connection_check", {
      method: "POST",
      token,
      body: { params: {}, threadId },
    })
    expect(after.status).toBe(200)
    const synced = await api(url, "/api/_test/stripe/mock/requests", { token })
    const used = (synced.body as { requests: Array<{ authorizationSha256: string | null }> })
      .requests
    expect(used.length).toBeGreaterThanOrEqual(10)
    expect(used.every((r) => r.authorizationSha256 === sha(RESTRICTED))).toBe(true)
  })
})

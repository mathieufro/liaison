// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A credential field that declares `refusePattern` refuses the wrong kind of
// secret before anything is encrypted or stored: the payments connector's
// restricted-key field refuses a full secret key, live or test. The person
// reads why in their language, the response never echoes the value, and the
// connected-account rows are unchanged.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MANIFEST = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../../../../bundled-apps/stripe/app.manifest.json"),
    "utf8",
  ),
)
const SECRET_KEYS = [
  `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7l"}`,
  `sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
]
const RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`

const APP = "stripe"
let orgId = ""
let token = ""

async function save(restrictedKey: string, lang = "en") {
  const res = await app.request(`/api/connections/${APP}/${APP}/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": lang,
    },
    body: JSON.stringify({ credentials: { restrictedKey } }),
  })
  return { status: res.status, text: await res.text() }
}

async function storedRows(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.connected_accounts
    WHERE org_id = ${orgId} AND app_name = ${APP}`
  return row?.n ?? 0
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Credential Refuse Org" })
  orgId = org.orgId
  token = await minimal.token(org.adminUserId)
  // The field's own rule only: the app's check before storage is not installed here.
  connectionConfigRegistry.set([orgId, APP, APP], {
    ...MANIFEST.connections[APP],
    checkBeforeStore: undefined,
  })
})

afterAll(async () => {
  connectionConfigRegistry.delete([orgId, APP, APP])
  await releaseTestLock()
})

describe("a credential field's refusePattern", () => {
  it("a secret key is refused, nothing is stored and the card says why", async () => {
    const before = await storedRows()
    for (const key of SECRET_KEYS) {
      const { status, text } = await save(key)
      expect(status).toBe(422)
      const body = JSON.parse(text) as {
        error: { code: string; message: string; details: unknown }
      }
      expect(body.error.code).toBe("secret_key_refused")
      expect(body.error.message).toStartWith("That is your secret key, so I did not keep it.")
      expect(body.error.details).toEqual({ field: "restrictedKey", stored: false })
      expect(text).not.toContain(key)
      expect(text).not.toContain(key.slice(8))
    }
    expect(await storedRows()).toBe(before)
  })

  it("the refusal reads in French for a French person", async () => {
    const { status, text } = await save(SECRET_KEYS[1] as string, "fr-FR,fr;q=0.9")
    expect(status).toBe(422)
    expect((JSON.parse(text) as { error: { message: string } }).error.message).toStartWith(
      "C’est votre clé secrète",
    )
  })

  it("a restricted key is kept", async () => {
    const before = await storedRows()
    const { status, text } = await save(RESTRICTED)
    expect(status).toBe(201)
    expect(text).not.toContain(RESTRICTED)
    expect(await storedRows()).toBe(before + 1)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the generic manifest-driven connector (Task 11).
 *
 * The connector reads the connection's manifest declaration from
 * `connectionConfigRegistry` (warmed by `ensureAppsForOrg`, which `ensureOrg`
 * runs post-commit) and drives it generically:
 *  - `type:credentials` (the test app's `service`: fields token+group, NO identifierVar) → validate
 *    supplied creds, derive identifier from `connection.identifier`, 4-key
 *    precheck, `createCredentialConnection` (ownerType:'org'). Re-run → NO new
 *    row. Missing a required field → clean error, no row. Creds-changed →
 *    disconnect + reinsert (active count stays 1).
 *  - `type:oauth2` (shopify/shop) → `pending`, NO write.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import {
  checkConnectionHealth,
  describeConnectionDrift,
  planConnection,
  provisionConnection,
} from "~/cli/provisioners/connector"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectionConfigRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { getCredentialsForConnection } from "~/modules/apps/connections/service"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshOrgWithAdmin(): Promise<{
  ctx: ProvisionContext
  orgId: string
  adminId: string
}> {
  const { orgId } = await ensureOrg({
    slug: `cli-conn-${crypto.randomUUID().slice(0, 12)}`,
    name: "ConnectorTestOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-conn-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId, adminId: userId }
}

async function countActive(
  orgId: string,
  app: string,
  conn: string,
  identifier: string,
): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("connected_accounts")}
      WHERE org_id = ${orgId}::uuid AND app_name = ${app} AND connection_name = ${conn}
        AND identifier = ${identifier} AND status = 'active'
    `),
  )
  return extractRows(rows).length
}

describe("generic connector (Task 11)", () => {
  test("credentials connector (test/service): valid creds → org-owned row + derived identifier; re-run no dup", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const spec = {
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { token: "glpat-secret-1", group },
    }

    const r1 = await provisionConnection(ctx, "test", spec)
    expect(r1.connected).toBe(true)
    expect(await countActive(orgId, "test", "service", group)).toBe(1)

    // ownerType:'org' on the stored row.
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT owner_type, identifier FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = 'test' AND connection_name = 'service'
          AND identifier = ${group} AND status = 'active'
      `),
    )
    const row = extractRows<{ owner_type: string; identifier: string }>(rows)[0]
    expect(row.owner_type).toBe("org")
    expect(row.identifier).toBe(group)

    // Re-run with identical creds → unchanged, NO new row (count==1).
    const r2 = await provisionConnection(ctx, "test", spec)
    expect(r2.connected).toBe(true)
    expect(await countActive(orgId, "test", "service", group)).toBe(1)
  })

  test("no acting person (no admin section, no active admin) → clean error naming `admin`, no row", async () => {
    const { orgId } = await ensureOrg({
      slug: `cli-conn-noadmin-${crypto.randomUUID().slice(0, 12)}`,
      name: "ConnectorNoAdminOrg",
    })
    // As `liaison config apply` builds it when the file has no admin section
    // and the org has no active admin: the actor stays empty.
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const spec = {
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { token: "glpat-secret-1", group },
    }

    const err = await provisionConnection(ctx, "test", spec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(String(err)).toContain("`admin` section")
    expect(await countActive(orgId, "test", "service", group)).toBe(0)
  })

  test("missing required credentialField → clean error, no row", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    // the connection requires `token` — omit it.
    const spec = {
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { group },
    }

    await expect(provisionConnection(ctx, "test", spec)).rejects.toBeInstanceOf(ConfigError)
    expect(await countActive(orgId, "test", "service", group)).toBe(0)
  })

  test("ALL-empty credentials (secrets not pasted yet) → pending skip, no error, no row", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    // `${GITLAB_TOKEN:-}` / `${GITLAB_GROUP:-}` interpolate to "" before the
    // config is listed with every app — the connector must SKIP (pending), not
    // hard-fail, so the file can be applied incrementally (oauth convention).
    const spec = {
      name: "service",
      identifier: "",
      ownerType: "org" as const,
      credentials: { token: "", group: "" },
    }

    const r = await provisionConnection(ctx, "test", spec)
    expect(r.connected).toBeFalsy()
    expect(r.pending?.kind).toBe("credentials")
    expect(r.pending?.app).toBe("test")
    expect(r.pending?.connection).toBe("service")
    expect(await countActive(orgId, "test", "service", "")).toBe(0)
  })

  test("oauth2 connector (calendar/google-calendar) → pending, no write", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const spec = {
      name: "google-calendar",
      identifier: "calendar-account",
      ownerType: "org" as const,
    }

    const r = await provisionConnection(ctx, "calendar", spec)
    expect(r.connected).toBeFalsy()
    expect(r.pending).toBeDefined()
    expect(r.pending?.app).toBe("calendar")
    expect(r.pending?.connection).toBe("google-calendar")

    // No connected_account written for an oauth2 connection.
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = 'calendar'
      `),
    )
    expect(extractRows(rows).length).toBe(0)
  })

  test("oauth2 with oauthClient → provisions the OAuth client (oauth_providers row) + pending", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const spec = {
      name: "google-calendar",
      identifier: "calendar-account",
      ownerType: "org" as const,
      oauthClient: { clientId: "gcal-client-id", clientSecret: "gcal-secret" },
    }

    const r = await provisionConnection(ctx, "calendar", spec)
    expect(r.connected).toBeFalsy()
    expect(r.pending).toBeDefined()
    expect(r.changed ?? []).toContain("apps.calendar.google-calendar.oauthClient")

    // The per-connection OAuth client row was written under `<app>:<connection>`.
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT client_id FROM ${kernelRel("oauth_providers")}
        WHERE org_id = ${orgId}::uuid AND name = 'calendar:google-calendar'
      `),
    )
    const providerRows = extractRows<{ client_id: string }>(rows)
    expect(providerRows.length).toBe(1)
    expect(providerRows[0].client_id).toBe("gcal-client-id")
  })

  test("oauth2 with EMPTY oauthClient → skip client provisioning, pending, no oauth_providers row", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    // An unset `${ENV:-}` ref interpolates to "" -- a declared-but-unconfigured
    // client. The connector must SKIP it (not throw) and still report pending.
    const spec = {
      name: "google-calendar",
      identifier: "calendar-account",
      ownerType: "org" as const,
      oauthClient: { clientId: "", clientSecret: "" },
    }

    const r = await provisionConnection(ctx, "calendar", spec)
    expect(r.connected).toBeFalsy()
    expect(r.pending).toBeDefined()
    // No client change recorded, and no oauth_providers row written.
    expect(r.changed ?? []).not.toContain("apps.calendar.google-calendar.oauthClient")

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT client_id FROM ${kernelRel("oauth_providers")}
        WHERE org_id = ${orgId}::uuid AND name = 'calendar:google-calendar'
      `),
    )
    expect(extractRows(rows).length).toBe(0)
  })

  test("creds-changed → disconnect + reinsert (active count stays 1, new creds stored)", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const spec1 = {
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { token: "glpat-OLD", group },
    }
    await provisionConnection(ctx, "test", spec1)
    expect(await countActive(orgId, "test", "service", group)).toBe(1)

    const spec2 = {
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { token: "glpat-NEW", group },
    }
    const r2 = await provisionConnection(ctx, "test", spec2)
    expect(r2.connected).toBe(true)

    // Still exactly one ACTIVE row by the 4-key.
    expect(await countActive(orgId, "test", "service", group)).toBe(1)

    // The active row carries the NEW token.
    const creds = await withPrivilegedDb(orgId, "t", (tx) =>
      getCredentialsForConnection(tx, orgId, ctx.actor.userId, "test", "service", group, {
        actorType: "system",
      }),
    )
    expect(creds.token).toBe("glpat-NEW")
  })

  test("a key the connection's own check refuses is not stored, and the stored key stays", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const spec = (token: string) => ({
      name: "service",
      identifier: group,
      ownerType: "org" as const,
      credentials: { token, group },
    })
    await provisionConnection(ctx, "test", spec("glpat-GOOD"))
    // The connection checks a key before keeping it, as the credentials route does.
    const config = connectionConfigRegistry.get([orgId, "test", "service"])
    const checked: string[] = []
    connectionConfigRegistry.set([orgId, "test", "service"], {
      ...config,
      checkBeforeStore: "key_check",
    } as never)
    toolRegistry.set([orgId, "test", "key_check"], {
      appName: "test",
      name: "key_check",
      description: "Check a key",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async () => {
        checked.push("ran")
        throw Object.assign(new Error("The service refused the token"), {
          code: "key_rejected",
          status: 401,
        })
      },
    } as never)
    try {
      const err = await provisionConnection(ctx, "test", spec("glpat-BAD")).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ConfigError)
      expect(String(err)).toContain("key_rejected")
      expect(String(err)).toContain("stored key was kept")
      expect(checked).toEqual(["ran"])
      expect(await countActive(orgId, "test", "service", group)).toBe(1)
      const creds = await withPrivilegedDb(orgId, "t", (tx) =>
        getCredentialsForConnection(tx, orgId, ctx.actor.userId, "test", "service", group, {
          actorType: "system",
        }),
      )
      expect(creds.token).toBe("glpat-GOOD")
    } finally {
      connectionConfigRegistry.set([orgId, "test", "service"], config as never)
      toolRegistry.delete([orgId, "test", "key_check"])
    }
  })

  // No explicit identifier and no manifest identifierVar: the account is keyed
  // the way the settings form keys it (an `email`/`identifier` field, else the
  // org for an org-owned connection), so config and UI meet on one account.
  test("no identifier and no identifierVar: an org connection is keyed on the org; re-run unchanged", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const spec = {
      name: "service",
      ownerType: "org" as const,
      credentials: { token: "glpat-noid-1", group },
    }
    const r1 = await provisionConnection(ctx, "test", spec)
    expect(r1.connected).toBe(true)
    expect(r1.identifier).toBe(orgId)
    expect(await countActive(orgId, "test", "service", orgId)).toBe(1)
    const r2 = await provisionConnection(ctx, "test", spec)
    expect(r2.unchanged ?? []).toContain("apps.test.connection")
    expect(await countActive(orgId, "test", "service", orgId)).toBe(1)
    // The read-only plan resolves the same account.
    expect(await planConnection(ctx, orgId, "test", spec)).toEqual([
      "app 'test' connection 'service' unchanged",
    ])
  })

  // A multiInstance connection is one account per admin-chosen slug: there is
  // no sensible default, so the error names the missing field.
  test("multiInstance connection without identifier → ConfigError naming 'identifier', no row", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const key = [orgId, "test", "service"] as const
    const decl = connectionConfigRegistry.get([...key])
    expect(decl).toBeDefined()
    try {
      connectionConfigRegistry.set([...key], { ...decl!, multiInstance: true })
      const err = await provisionConnection(ctx, "test", {
        name: "service",
        ownerType: "org" as const,
        credentials: { token: "glpat-mi", group: "g" },
      }).catch((e) => e)
      expect(err).toBeInstanceOf(ConfigError)
      expect(String(err.message)).toContain("'identifier'")
      expect(await countActive(orgId, "test", "service", orgId)).toBe(0)
    } finally {
      connectionConfigRegistry.set([...key], decl!)
    }
  })

  // A manifest that later declares an identifierVar (ads/google-config: the
  // customer id) must not fork an existing account: a config that names its
  // identifier explicitly keeps updating the account stored under it.
  test("an explicit identifier wins over a newly declared identifierVar: one account, updated", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const key = [orgId, "test", "service"] as const
    const decl = connectionConfigRegistry.get([...key])
    expect(decl).toBeDefined()
    const spec = (token: string) => ({
      name: "service",
      identifier: "default",
      ownerType: "org" as const,
      credentials: { token, group },
    })
    // Stored before the manifest derived its identifier.
    await provisionConnection(ctx, "test", spec("glpat-OLD"))
    expect(await countActive(orgId, "test", "service", "default")).toBe(1)
    try {
      connectionConfigRegistry.set([...key], { ...decl!, identifierVar: "group" })
      const r = await provisionConnection(ctx, "test", spec("glpat-NEW"))
      expect(r.connected).toBe(true)
      expect(await countActive(orgId, "test", "service", group)).toBe(0)
      expect(await countActive(orgId, "test", "service", "default")).toBe(1)
      const creds = await withPrivilegedDb(orgId, "t", (tx) =>
        getCredentialsForConnection(tx, orgId, ctx.actor.userId, "test", "service", "default", {
          actorType: "system",
        }),
      )
      expect(creds.token).toBe("glpat-NEW")
      // With no explicit identifier, the declared field still names the account.
      const derived = await provisionConnection(ctx, "test", {
        name: "service",
        ownerType: "org" as const,
        credentials: { token: "glpat-NEW", group },
      })
      expect(derived.connected).toBe(true)
      expect(await countActive(orgId, "test", "service", group)).toBe(1)
    } finally {
      connectionConfigRegistry.set([...key], decl!)
    }
  })
  // A connection declaring a setting beside its secret (the test app's `service`:
  // `group` is a text field, `token` a password field). A rename
  // changes only the group: apply must write it and say WHICH fields moved, naming
  // the secret fields without ever printing a value.
  test("a changed non-secret setting (the URL) is written and reported by field name", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const logs: string[] = []
    ctx.log = (line: string) => logs.push(line)
    const identifier = `gate-${crypto.randomUUID().slice(0, 8)}`
    const base = { name: "service", identifier, ownerType: "org" as const }
    await provisionConnection(ctx, "test", {
      ...base,
      credentials: { group: "team-old", token: "tok-SECRET-1" },
    })

    const same = await provisionConnection(ctx, "test", {
      ...base,
      credentials: { group: "team-old", token: "tok-SECRET-1" },
    })
    expect(same.unchanged).toEqual(["apps.test.connection"])
    expect(same.changed).toBeUndefined()

    const moved = await provisionConnection(ctx, "test", {
      ...base,
      credentials: { group: "team-new", token: "tok-SECRET-1" },
    })
    expect(moved.connected).toBe(true)
    expect(moved.unchanged).toBeUndefined()
    expect(moved.changed).toEqual(["apps.test.connection.group"])
    expect(await countActive(orgId, "test", "service", identifier)).toBe(1)
    const stored = await withPrivilegedDb(orgId, "t", (tx) =>
      getCredentialsForConnection(tx, orgId, ctx.actor.userId, "test", "service", identifier, {
        actorType: "system",
      }),
    )
    expect(stored.group).toBe("team-new")
    expect(stored.token).toBe("tok-SECRET-1")
    expect(logs.join("\n")).toContain("group")

    const rotated = await provisionConnection(ctx, "test", {
      ...base,
      credentials: { group: "team-new", token: "tok-SECRET-2" },
    })
    expect(rotated.changed).toEqual(["apps.test.connection.token"])
    // The non-secret setting shows old -> new; the secret is named only.
    expect(moved.fieldChanges).toEqual([
      {
        field: "group",
        secret: false,
        from: "team-old",
        to: "team-new",
      },
    ])
    expect(logs.join("\n")).toContain('group "team-old" -> "team-new"')
    expect(rotated.fieldChanges).toEqual([{ field: "token", secret: true }])
    expect(logs.join("\n")).toContain("token (secret)")
    // Field names only for secrets: no secret value in the report or the log.
    const everything = JSON.stringify([moved, rotated]) + logs.join("\n")
    expect(everything).not.toContain("tok-SECRET")
  })

  // `--dry-run` runs plans only: the drift is reported (values for the
  // non-secret setting, the secret by name) and nothing is written.
  test("planConnection reports drift of an existing connection without writing", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const identifier = `gate-${crypto.randomUUID().slice(0, 8)}`
    const base = { name: "service", identifier, ownerType: "org" as const }
    await provisionConnection(ctx, "test", {
      ...base,
      credentials: { group: "team-old", token: "tok-SECRET-1" },
    })

    expect(
      await planConnection(ctx, orgId, "test", {
        ...base,
        credentials: { group: "team-old", token: "tok-SECRET-1" },
      }),
    ).toEqual(["app 'test' connection 'service' unchanged"])

    const lines = await planConnection(ctx, orgId, "test", {
      ...base,
      credentials: { group: "team-new", token: "tok-SECRET-2" },
    })
    expect(lines).toEqual([
      `update app 'test' connection 'service': group "team-old" -> "team-new", token (secret)`,
    ])
    expect(lines.join("\n")).not.toContain("tok-SECRET")

    // Nothing written: the stored row still holds the old values.
    const stored = await withPrivilegedDb(orgId, "t", (tx) =>
      getCredentialsForConnection(tx, orgId, ctx.actor.userId, "test", "service", identifier, {
        actorType: "system",
      }),
    )
    expect(stored).toEqual({ group: "team-old", token: "tok-SECRET-1" })
    // A new org (none yet) or a new connection plans nothing beyond "connect".
    expect(await planConnection(ctx, "", "test", base)).toEqual([])
  })

  test("checkConnectionHealth runs the app's verify check; an app without one is SKIPPED", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const identifier = `gate-${crypto.randomUUID().slice(0, 8)}`
    await provisionConnection(ctx, "test", {
      name: "service",
      identifier,
      ownerType: "org",
      credentials: { group: "team", token: "tok-SECRET-1" },
    })
    const seen: unknown[] = []
    const pass = await checkConnectionHealth(
      ctx,
      async (input) => {
        seen.push(input)
        return { identity: "gate ok" }
      },
      "test",
      "service",
    )
    expect(pass).toEqual({ status: "PASS", identity: "gate ok" })
    // The check gets the app and the org, never the stored credential.
    expect(seen).toEqual([{ orgId, appName: "test" }])

    const fail = await checkConnectionHealth(
      ctx,
      async () => {
        throw new Error("HTTP 404 from gate.example.com")
      },
      "test",
      "service",
    )
    expect(fail).toEqual({ status: "FAIL", error: "HTTP 404 from gate.example.com" })

    const skipped = await checkConnectionHealth(ctx, async () => null, "test", "service")
    expect(skipped.status).toBe("SKIPPED")
  })
})

describe("describeConnectionDrift", () => {
  const fields = [
    { name: "baseUrl", type: "text" },
    { name: "apiKey", type: "password" },
  ]
  test("values for declared non-secret fields, names only for passwords and undeclared fields", () => {
    expect(
      describeConnectionDrift(
        { baseUrl: "https://old.example.com", apiKey: "k1", extra: "x" },
        { baseUrl: "https://new.example.com", apiKey: "k2" },
        fields,
      ),
    ).toEqual([
      { field: "apiKey", secret: true },
      {
        field: "baseUrl",
        secret: false,
        from: "https://old.example.com",
        to: "https://new.example.com",
      },
      { field: "extra", secret: true },
    ])
  })
  test("a field set on one side only has no value on the other", () => {
    expect(describeConnectionDrift({}, { baseUrl: "https://new.example.com" }, fields)).toEqual([
      { field: "baseUrl", secret: false, to: "https://new.example.com" },
    ])
    expect(describeConnectionDrift({ baseUrl: "a" }, { baseUrl: "a" }, fields)).toEqual([])
  })
})

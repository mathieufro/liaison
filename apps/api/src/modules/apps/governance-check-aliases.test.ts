// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The startup governance check ("App declares governed tables no grantable
// scope can reach") judged a table on the app's declared grantable scopes
// alone. But every handler call runs under the app-aliased RLS context
// (`withAppDimensionAliases` applies the app's entry in
// `appScopeAliasProviders`), so a table that a scope alias makes reachable
// was still reported. The check now applies the app's aliases, one grantable
// scope at a time; a table no alias reaches is still reported, and refuses the
// registration (outside production it throws).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { AppRegistrationFatalError, registerApps } from "~/modules/apps/runtime"
import {
  appScopeAliasProviders,
  grantableScopesWithAppAliases,
} from "~/modules/apps/runtime-helpers"
import { tablesUnreachableByGrantableScopes } from "~/modules/permissions/rls-generator"

describe("grantableScopesWithAppAliases (real tickets alias)", () => {
  it("counts the alias toward reachability and still reports a table no alias reaches", () => {
    // tickets aliases `tickets:tickets:read` to `tickets:messages:read`.
    const schema = { messages: {}, unrelated: {} }
    const declared = ["tickets:tickets:read"]
    expect(tablesUnreachableByGrantableScopes("tickets", schema, declared)).toEqual([
      "messages",
      "unrelated",
    ])
    expect(
      tablesUnreachableByGrantableScopes(
        "tickets",
        schema,
        grantableScopesWithAppAliases("tickets", declared),
      ),
    ).toEqual(["unrelated"])
  })

  it("leaves an app without an alias provider unchanged", () => {
    expect(grantableScopesWithAppAliases("no-such-app", ["a:b:read"])).toEqual(["a:b:read"])
  })
})

describe("the registration's governance check applies the app's scope aliases", () => {
  const APP = "alias-check-app"
  const SCHEMA = "app_alias_check_app"
  const ORG = "00000000-0000-0000-0000-0000000a11a5"
  const manifest = {
    name: APP,
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: "/apps/alias-check-app/handlers.js",
    scopes: [`${APP}:notes:read`],
    schema: {
      notes: { fields: { title: "string" } },
      infra: { fields: { title: "string" } },
      orphan: { fields: { title: "string" } },
    },
  }

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Alias Check Org', 'alias-check-org')
      ON CONFLICT (id) DO NOTHING`
    // `notes:read` holders also read the app's `infra` table; nothing reaches `orphan`.
    appScopeAliasProviders.set(APP, (scopes) =>
      scopes.includes(`${APP}:notes:read`) ? [...scopes, `${APP}:infra:read`] : scopes,
    )
  })

  afterAll(async () => {
    appScopeAliasProviders.delete(APP)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("refuses the registration naming only the table no grantable scope or alias reaches", async () => {
    let caught: unknown
    try {
      await registerApps([manifest as never], ORG)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppRegistrationFatalError)
    expect((caught as AppRegistrationFatalError).details.tables).toEqual(["orphan"])
  })
})

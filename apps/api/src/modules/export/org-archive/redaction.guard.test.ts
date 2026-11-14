// SPDX-License-Identifier: FSL-1.1-ALv2
// A17: the export's redaction is an explicit deny list, and this guard keeps it
// honest. Every column of an exported table whose name looks sensitive must be
// either denied (written as null) or kept with a reviewed reason. A new column
// fails here until someone decides; at run time it is redacted meanwhile.
import { beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { COLUMNS, JSON_COLUMNS } from "~/cli/keys-rotate"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { columnKey, discoverExportTables } from "~/modules/export/org-archive/catalog"
import {
  decideColumn,
  KEPT_COLUMNS,
  REDACTED_COLUMNS,
  redactCiphertext,
  redactJsonPaths,
  SENSITIVE_COLUMN_NAME,
  scrubsCiphertext,
} from "~/modules/export/org-archive/redaction"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
  // Register the bundled apps so their schemas are in the catalog.
  const { orgId } = await ensureOrg({
    slug: `oexp-guard-${crypto.randomUUID().slice(0, 8)}`,
    name: "Export Guard",
  })
  await ensureAppsForOrg(orgId)
  await releaseTestLock()
}, 60_000)

describe("export redaction guard", () => {
  it("every sensitive-looking column of the live catalog is denied or reviewed", async () => {
    const tables = await discoverExportTables()
    expect(tables.some((t) => t.logicalSchema.startsWith("app_"))).toBe(true)
    const unreviewed: string[] = []
    for (const t of tables) {
      for (const c of t.columns) {
        if (!SENSITIVE_COLUMN_NAME.test(c.name)) continue
        const key = columnKey(t, c.name)
        if (!REDACTED_COLUMNS[key] && !KEPT_COLUMNS[key]) unreviewed.push(key)
      }
    }
    expect(unreviewed).toEqual([])
  })

  it("names the secrets the spec lists among the denied columns", () => {
    for (const key of [
      "kernel.connected_accounts.access_token_encrypted",
      "kernel.connected_accounts.refresh_token_encrypted",
      "kernel.user_key_wraps.wrapped_account_key",
      "app_tickets.api_keys.key_hash",
      "kernel.users.password_hash",
      "kernel.users.totp_secret",
      "kernel.users.recovery_codes",
      "kernel.mailbox_client_jobs.result_ciphertext",
      // Names outside the first regex that still grant something (K2).
      "kernel.browser_push_subscriptions.auth",
      "kernel.browser_push_subscriptions.endpoint",
      "kernel.browser_push_subscriptions.p256dh",
      "kernel.device_flow_requests.device_code",
      "kernel.device_flow_requests.user_code",
      "kernel.user_key_wraps.verifier",
    ]) {
      expect(decideColumn(key).action).toBe("redact")
    }
  })

  it("leaves out the dispatch grants that let an e-invoice go out without a new approval", () => {
    for (const key of [
      "app_invoicing.recurring_run_items.send_grant",
      "app_invoicing.einvoice_standing.grant_ref",
    ]) {
      expect(decideColumn(key).action, key).toBe("redact")
    }
  })

  it("redacts an unreviewed sensitive name by default and keeps an ordinary column", () => {
    expect(decideColumn("app_new.things.api_token").action).toBe("redact")
    // The class of the K2 miss: verifiers, auth values, one-time codes, push endpoints.
    for (const name of ["email_verifier", "auth", "device_code", "user_code", "push_endpoint"])
      expect(decideColumn(`app_new.things.${name}`).action, name).toBe("redact")
    expect(decideColumn("kernel.users.name").action).toBe("keep")
    expect(decideColumn("kernel.files.storage_key").action).toBe("keep")
  })

  it("nulls jsonb paths, wildcards included, and leaves the rest", () => {
    const out = redactJsonPaths("kernel.organizations.settings", {
      providerKeys: { a: { encrypted: "x" } },
      integrations: { google: { oauthClient: { clientSecretEncrypted: "y" }, other: 1 } },
      timezone: "UTC",
    }) as Record<string, unknown>
    expect(out.providerKeys).toBeNull()
    expect(out.integrations).toEqual({ google: { oauthClient: null, other: 1 } })
    expect(out.timezone).toBe("UTC")
  })

  it("every column keys-rotate re-keys is redacted, every JSON one scrubbed, all in the catalog", async () => {
    // keys-rotate.ts is the catalog of where ENCRYPTION_KEY ciphertext lives:
    // the export must leave out every value it lists.
    const tables = await discoverExportTables()
    const find = (schema: string, table: string, column: string) =>
      tables
        .find((t) => t.logicalSchema === schema && t.table === table)
        ?.columns.find((c) => c.name === column)
    for (const c of COLUMNS) {
      const key = `${c.schema}.${c.table}.${c.column}`
      expect(decideColumn(key).action, key).toBe("redact")
    }
    for (const c of JSON_COLUMNS) {
      const key = `${c.schema}.${c.table}.${c.column}`
      const col = find(c.schema, c.table, c.column)
      expect(col, key).toBeDefined()
      expect(scrubsCiphertext(col?.type ?? ""), key).toBe(true)
    }
    // Per-person app settings carry encrypted schema paths too (lib/settings.ts).
    expect(JSON_COLUMNS.map((c) => `${c.schema}.${c.table}.${c.column}`)).toContain(
      "kernel.users.settings",
    )
  })

  it("nulls every ciphertext leaf of a JSON value, nested and in arrays, and keeps the rest", () => {
    const enc = (s: string) => encryptSecret(s, env.ENCRYPTION_KEY, CryptoContext.orgSettingsSecret)
    const out = redactCiphertext({
      a: enc("one"),
      b: { c: [enc("two"), "plain"], d: 3 },
      label: "kept",
    })
    expect(out.value).toEqual({ a: null, b: { c: [null, "plain"], d: 3 }, label: "kept" })
    expect(out.count).toBe(2)
    expect(redactCiphertext("plain").value).toBe("plain")
  })
})

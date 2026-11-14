// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only install and mock-control routes for the payments connector, mounted
// at `/api/_test/stripe` when `qaSeedRoutesEnabled` (NODE_ENV=test, or
// ENABLE_QA_SEED_ROUTES). Modeled on pennylane-install-routes.ts.
//
// `POST /install-for-test` installs the built app for one org from a single call:
//   1. the installer is the org's first user;
//   2. clean slate: the app's connection, install row, approvals and mirror rows go;
//   3. installAppFromTarball (through the test catalog, as a first-party app) and
//      reloadInstalledApps;
//   4. createCredentialConnection with a restricted key (an inert one unless the
//      body supplies one); the API mock in index.e2e.ts answers its calls.
//
// The mock-control routes seed, fail, list and reset stripe-mock-fetch.ts.

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import {
  type StripeMockResource,
  stripeMockFailNext,
  stripeMockRequests,
  stripeMockReset,
  stripeMockSeed,
} from "./stripe-mock-fetch"

const APP = "stripe"

export type StripeInstallCredentials = { restrictedKey: string }

/** The key the connection stores: the body's, else an inert one the mock accepts. */
export function resolveStripeInstallCredentials(
  override?: StripeInstallCredentials,
): StripeInstallCredentials {
  return override ?? { restrictedKey: "rk_test_mock" }
}

export const stripeTestInstallRoutes = new Hono<AppEnv>()

const installBodySchema = z.object({
  orgId: z.string().uuid(),
  bundlePath: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
  credentials: z.object({ restrictedKey: z.string().min(1) }).optional(),
})

function refuseUnlessEnabled(): void {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
}

stripeTestInstallRoutes.post(
  "/install-for-test",
  zValidator("json", installBodySchema),
  async (c) => {
    refuseUnlessEnabled()
    const body = c.req.valid("json")
    const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()
    const manifest = peekManifestFromTarball(bundlePath)
    const grantedScopes = body.grantedScopes ?? manifest.scopes

    // 1. The installer: the org's first user.
    const installedBy = await withSystemDb("stripe-test-install:resolve-installer", async (db) => {
      const r = await db.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.users WHERE org_id = ${body.orgId}
            ORDER BY created_at ASC LIMIT 1`,
      )
      const rows =
        (r as unknown as { rows?: Array<{ id: string }> }).rows ??
        (r as unknown as Array<{ id: string }>)
      const userId = rows?.[0]?.id
      if (!userId) {
        throw new HTTPException(500, {
          message: `stripe install-for-test: org ${body.orgId} has no users; seed the org first`,
        })
      }
      return userId
    })

    // 2. Clean slate.
    const appSchema = schemaRef(`app_${APP}`)
    const kernel = schemaRef("kernel")
    await withSystemDb("stripe-test-install:reset", async (db) => {
      await db.execute(
        sql`DELETE FROM ${sql.raw(kernel)}.connected_accounts
            WHERE org_id = ${body.orgId} AND app_name = ${APP}`,
      )
      await db.execute(sql`DELETE FROM ${sql.raw(kernel)}.apps_installed WHERE name = ${APP}`)
      await db.execute(
        sql.raw(`DELETE FROM ${kernel}.approved_handler_executions
                 WHERE approval_request_id IN (
                   SELECT id FROM ${kernel}.approval_requests WHERE tool_name LIKE '${APP}:%')`),
      )
      await db.execute(
        sql.raw(`DELETE FROM ${kernel}.approval_requests WHERE tool_name LIKE '${APP}:%'`),
      )
      await db.execute(
        sql.raw(`DO $$
          DECLARE r RECORD;
          BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${appSchema}') THEN
              FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${appSchema}' LOOP
                EXECUTE 'TRUNCATE TABLE ${appSchema}.' || quote_ident(r.tablename) || ' CASCADE';
              END LOOP;
            END IF;
          END $$;`),
      )
    })

    // 3. Install and register.
    await installAppFromTarball({
      // Test harness: stands in for the admin approving the interface at install.
      approveUiFullAccess: true,
      tarballPath: bakeIntoTestCatalog(bundlePath),
      installedBy,
      grantedScopes,
      grantedConnections: [APP],
    })
    await reloadInstalledApps(body.orgId)

    // 4. The credentials connection.
    const credentials = resolveStripeInstallCredentials(body.credentials)
    const connection = await withPrivilegedDb(
      body.orgId,
      "stripe-test-install:create-credential-connection",
      (tx) =>
        // Privileged (BYPASSRLS) tx, as the production org-connection path.
        // biome-ignore lint/suspicious/noExplicitAny: privileged-tx bridge (prod parity)
        createCredentialConnection(tx as any, body.orgId, installedBy, APP, APP, {
          identifier: "stripe-test",
          credentials,
          displayName: "Stripe (test)",
          ownerType: "org",
        }),
    )

    return c.json({ appName: APP, connectionId: connection.id })
  },
)

// — mock-control sub-routes —

const RESOURCES = [
  "customers",
  "subscriptions",
  "invoices",
  "charges",
  "refunds",
  "disputes",
  "events",
] as const satisfies readonly StripeMockResource[]

const seedSchema = z.object({
  resource: z.enum(RESOURCES),
  object: z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1) })),
})

stripeTestInstallRoutes.post("/mock/seed", zValidator("json", seedSchema), (c) => {
  refuseUnlessEnabled()
  const body = c.req.valid("json")
  const object = stripeMockSeed(body.resource, body.object)
  return c.json({ object })
})

const failSchema = z.object({
  path: z.string().startsWith("/v1/"),
  status: z.union([z.literal(401), z.literal(403), z.literal(404), z.literal(429), z.literal(500)]),
})

stripeTestInstallRoutes.post("/mock/fail-next", zValidator("json", failSchema), (c) => {
  refuseUnlessEnabled()
  const body = c.req.valid("json")
  stripeMockFailNext(body.path, body.status)
  return c.json({ ok: true })
})

stripeTestInstallRoutes.post("/mock/reset", (c) => {
  refuseUnlessEnabled()
  stripeMockReset()
  return c.json({ ok: true })
})

stripeTestInstallRoutes.get("/mock/requests", (c) => {
  refuseUnlessEnabled()
  return c.json({ requests: stripeMockRequests() })
})

// — helpers —

function resolveDefaultBundlePath(): string {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  // The version comes from the manifest: build-bundled-app.sh writes
  // `stripe-<manifest version>.liaisonapp`.
  const manifestPath = join(liaisonRoot, "bundled-apps", APP, "app.manifest.json")
  const { version } = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }
  return join(liaisonRoot, "bundled-apps", APP, "dist", `${APP}-${version}.liaisonapp`)
}

function peekManifestFromTarball(tarballPath: string): { scopes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "stripe-bundle-peek-"))
  try {
    const r = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "app.manifest.json"], {
      stdio: "pipe",
    })
    if (r.status !== 0) {
      throw new Error(
        `reading ${tarballPath} failed (build it with scripts/build-bundled-app.sh ${APP}): ${r.stderr?.toString() ?? "<no stderr>"}`,
      )
    }
    return JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8")) as { scopes: string[] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

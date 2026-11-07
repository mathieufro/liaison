// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: register a probe run in the Workers run registry, so a live
// isolation check can drive /api/app-bridge/:runId over HTTP (another run's
// token, an expired run, a settled run, a second execution nonce).
//
//   POST /api/_test/apps/workers/probe-run
//     { orgId, app, timeoutMs?, settle?, expire? }
//     200 { data: { runId, runToken, bridgeUrl, methods, nonceHint, configured } }
//
// The probe's bridge has two harmless methods: `probe_echo(value)` answers
// `{echo: value}` and `probe_org()` answers the probe's orgId. `settle: true`
// settles the run before answering (its token then gets 410); `expire: true`
// registers it with no time left (401 `expired`). `nonceHint` is a fresh
// random nonce a caller may present; the registry pins whichever nonce the
// first call presents. `configured` says whether the bridge route serves
// anything at all (it answers 404 unless the Workers executor is configured).
//
// Mounted by qa-seed-routes.ts only when `qaSeedRoutesEnabled`; each request
// checks the flag again, so a stale build never serves it.

import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { bridgeUrlFor, readWorkersConfig } from "~/modules/apps/workers/config"
import { type RunRegistry, runRegistry } from "~/modules/apps/workers/run-registry"

const probeBody = z.object({
  orgId: z.string().uuid(),
  app: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  settle: z.boolean().optional(),
  expire: z.boolean().optional(),
})

export function createWorkersProbeRoutes(
  opts: { enabled?: () => boolean; registry?: RunRegistry } = {},
): Hono<AppEnv> {
  const enabled = opts.enabled ?? (() => qaSeedRoutesEnabled)
  const registry = opts.registry ?? runRegistry
  return new Hono<AppEnv>().post("/probe-run", async (c) => {
    if (!enabled()) throw new HTTPException(404, { message: "Not found" })
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw new HTTPException(400, { message: "Body must be JSON" })
    }
    const parsed = probeBody.safeParse(raw)
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Bad body" })
    }
    const { orgId, app, settle, expire } = parsed.data
    const bridge = {
      probe_echo: async (value: unknown) => ({ echo: value ?? null }),
      probe_org: async () => orgId,
    }
    const run = registry.registerRun({
      bridge,
      bridgeMethods: Object.keys(bridge),
      orgId,
      appName: app,
      version: "probe",
      timeoutMs: expire ? 0 : (parsed.data.timeoutMs ?? 60_000),
      ...(expire ? { graceMs: 0 } : {}),
    })
    if (settle) run.settle()
    if (expire) await new Promise((r) => setTimeout(r, 5))
    const config = readWorkersConfig()
    return c.json({
      data: {
        runId: run.runId,
        runToken: run.runToken,
        bridgeUrl: config ? bridgeUrlFor(config, run.runId) : `/api/app-bridge/${run.runId}`,
        methods: Object.keys(bridge),
        nonceHint: randomBytes(16).toString("base64url"),
        configured: config !== null,
      },
    })
  })
}

export const workersProbeTestRoutes = createWorkersProbeRoutes()

// SPDX-License-Identifier: FSL-1.1-ALv2
import { HTTPException } from "hono/http-exception"
import type { ActorContext } from "~/db/rls"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { appsLogger as log } from "~/lib/logger"
import {
  dimensionDefRegistry,
  exportRegistry,
  isManifestHandler,
} from "~/modules/apps/app-registries"
import { createAppContext } from "~/modules/apps/context"
import { validateToolResult } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { runApp } from "~/modules/apps/sandbox/run-app"
import { hasScope } from "~/modules/permissions/permissions"
import { filterResponse } from "~/modules/permissions/response-filter"

export class ExportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ExportError"
  }
}

function resolveUserId(actor: ActorContext): string {
  if (actor.actorType === "user") return actor.userId
  return "system"
}

function resolveScopes(actor: ActorContext): string[] {
  if (actor.actorType === "user") return actor.scopes ?? []
  return actor.scopes ?? ["*"]
}

function resolveDimensionGrants(actor: ActorContext): Record<string, string[]> {
  if (actor.actorType === "user") return actor.dimensionGrants ?? {}
  return {}
}

/**
 * Invoke a single app's declared export handler under the supplied actor's RLS
 * context. Factored out of `appRoutes.get("/export/:appName")` so the HTTP
 * route, the Task 14 multi-app orchestrator, and the `kernel.export` agent tool
 * all share exactly one invocation path (same scope check, same sandbox
 * `params:{format}` shape, same schema validation, same dimension filtering).
 *
 * Returns the (possibly dimension-filtered) export result. Throws
 * `ExportError` with an HTTP-ish status for the route to translate; the
 * orchestrator catches it to record a per-app skip reason.
 */
export interface ExportFilters {
  dateRange?: { from?: string; to?: string }
}

export async function invokeAppExport(
  orgId: string,
  appName: string,
  format: string,
  actor: ActorContext,
  filters?: ExportFilters,
): Promise<unknown> {
  await ensureAppsForOrg(orgId)

  const entry = exportRegistry.get([orgId, appName])
  if (!entry) throw new ExportError(404, "No export handler for this app")

  // Scope check — exports require at least one scope under the app namespace.
  // If the export declares a specific scope, check that; otherwise require any
  // app-level scope.
  const actorScopes = resolveScopes(actor)
  const declaredScope = (entry as unknown as { scope?: string }).scope
  if (declaredScope) {
    if (!hasScope(declaredScope, actorScopes)) {
      throw new ExportError(403, "Forbidden")
    }
  } else {
    const hasAppAccess = actorScopes.some((s) => s === "*" || s.startsWith(`${appName}:`))
    if (!hasAppAccess) {
      throw new ExportError(403, "Forbidden")
    }
  }

  if (!entry.formats.includes(format)) {
    throw new ExportError(
      400,
      `Unsupported format: ${format}. Supported: ${entry.formats.join(", ")}`,
    )
  }

  const userId = resolveUserId(actor)

  // Bridge-owned transactions: an export paginates the full RLS set and can
  // run long — the sandbox path must not pin a request-pool connection for its
  // whole duration. The session bridge acquires per bridge db call instead.
  // Host-side (non-manifest) export handlers keep the whole-run ambient
  // transaction (in-process, tx-driven contract).
  const result = await (async () => {
    if (isManifestHandler(entry.handler)) {
      const manifest = (entry as unknown as { _manifest?: Record<string, unknown> })._manifest
      const session = createRlsSession(actor)
      const bridge = createSessionRpcBridge(
        appName,
        userId,
        orgId,
        session,
        (manifest ?? { name: appName }) as never,
      )
      const source = await loadBundle(entry.handler.bundlePath)
      // Only trusted code runs on the host's in-process pool; a sandboxed app's
      // export runs in the isolated worker pool, like its tools.
      return runApp({
        trusted: entry.handler.trusted === true,
        appName,
        orgId,
        bundlePath: entry.handler.bundlePath,
        bundleSource: source,
        exportName: entry.handler.exportName,
        entry: `export:${entry.handler.exportName}`,
        // Date-range threads into the handler via params (the only sandbox
        // input channel); the handler applies it + paginates the full RLS set.
        params: { format, dateRange: filters?.dateRange },
        bridge,
        holdsTx: false,
        // Worker pool only.
        priority: "background",
        appId: appName,
      })
    }
    return withRlsContext(actor, async (tx) => {
      const ctx = createAppContext(appName, userId, orgId, tx)
      return (
        entry.handler as (ctx: unknown, format: string, filters?: ExportFilters) => Promise<unknown>
      )(ctx, format, filters)
    })
  })()

  // Validate export output against declared schema (JSON rows only — a CSV
  // string export is opaque to the row-shape validator).
  if (entry.schema && result && typeof result !== "string") {
    if (!validateToolResult(result, entry.schema)) {
      log.error({ app: appName }, "Export output validation failed")
      throw new ExportError(500, "Export failed")
    }
  }

  // Apply response filtering if export declares dimensions.
  if (entry.dimensions) {
    if (typeof result === "string") {
      // A CSV string is already serialised — dimension field-masking cannot be
      // applied after the fact. Reject the export so a misconfigured handler
      // cannot bypass dimension grants by returning pre-serialised CSV.
      log.error(
        { app: appName },
        "Export with dimension grants returned CSV — field-masking cannot be applied",
      )
      throw new ExportError(500, "Export failed: dimension-filtered exports must return JSON")
    }
    if (result) {
      const defs: Record<string, unknown> = {}
      for (const [_field, dimKey] of Object.entries(entry.dimensions)) {
        const def = dimensionDefRegistry.get([orgId, appName, dimKey])
        if (def) defs[dimKey] = def
      }
      return filterResponse(result, entry.dimensions, resolveDimensionGrants(actor), defs as never)
    }
  }

  return result
}

/** Translate an {@link ExportError} into a Hono HTTPException. */
export function toHttpException(err: unknown): HTTPException {
  if (err instanceof ExportError) {
    return new HTTPException(err.status as 400 | 403 | 404 | 500, { message: err.message })
  }
  if (err instanceof HTTPException) return err
  return new HTTPException(500, { message: "Export failed" })
}

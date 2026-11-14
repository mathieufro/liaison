// SPDX-License-Identifier: FSL-1.1-ALv2
import { SUPPORTED_HOST_API_MAJORS } from "@liaison/host"
import { sql as drizzleSql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appFrameOriginsEnabled } from "~/lib/app-frame-host"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { quoteIdent } from "~/lib/sql-utils"
import { getRequestSignal } from "~/middleware/request-timeout"
import { requireScope } from "~/middleware/require-scope"
import {
  claimToolCard,
  currentToolCard,
  type OpenedToolCardRef,
  openToolCardRef,
  parseToolCardRef,
  releaseToolCard,
  replaceToolCard,
  type ToolCardRef,
} from "~/modules/agent/runtime/tool-card-store"
import {
  checkAppConfigWriteForOrg,
  declaredAppConfigKeys,
  readAppConfig,
  writeAppConfigKey,
} from "~/modules/apps/app-config"
import {
  framesOnOwnOrigin,
  grantedDeclaredHosts,
  mintAppFrameUrl,
} from "~/modules/apps/app-frame-host-route"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import {
  dimensionDefRegistry,
  entityRegistry,
  manifestRegistry,
} from "~/modules/apps/app-registries"
import { appVisibilityFor } from "~/modules/apps/app-visibility"
import { catalogStatement } from "~/modules/apps/catalog"
import { listAppConnectionViews } from "~/modules/apps/connection-overview"
import { getDetailExternalLink } from "~/modules/apps/detail-external-link"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { getInstallTrust } from "~/modules/apps/install-trust"
import {
  enabledFeaturesFor,
  isAppUnavailableFor,
  primeOrgApps,
  unavailableAppsFor,
} from "~/modules/apps/org-apps"
import { restToolCall } from "~/modules/apps/rest-tool-call"
import { boundHost, signUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { invokeAppExport, toHttpException } from "~/modules/export/invoke-export"
import { hasScope } from "~/modules/permissions/permissions"
import { listSlotPanels } from "~/modules/slots/registry"

export const appRoutes = new Hono<AppEnv>()

/**
 * `GET /api/apps/host-api` (S3): the host API majors this server answers, so a
 * client or an app author can check before installing. Public and mounted
 * ahead of the `/api/apps` session middleware; the per-IP limiter on `/api/*`
 * covers it. Majors only: the exact server version is not published.
 */
export const hostApiRoutes = new Hono<AppEnv>()
hostApiRoutes.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=300")
  return success(c, { majors: [...SUPPORTED_HOST_API_MAJORS] })
})

const KNOWN_VALUE_SOURCES: Record<string, { kind: string }> = {
  "mail:inbox": { kind: "mail_accounts" },
}

const KNOWN_LABELS: Record<string, string> = {
  "mail:inbox": "Inbox access",
}

// Tool execution endpoint — delegates to the executeTool pipeline.
// `:toolName` here is the fully-qualified `<appName>:<toolName>` form
// the kernel uses internally.
appRoutes.post("/tools/:toolName", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  // The REST entry point a browser UI action calls directly: there the click IS
  // the approval, and a restricted session's call is no click.
  const call = await restToolCall(c, body.threadId)
  const result = await executeTool({
    toolName: c.req.param("toolName"),
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
    threadId: call.threadId,
    params: body.params ?? body,
    origin: call.origin,
    // Propagate the incoming request's cancellation so an abandoned caller
    // (e.g. after the request timeout middleware responds 504) never later
    // occupies a sandbox worker for a caller that is already gone.
    signal: getRequestSignal(c),
  })
  if (result.blocked) {
    return success(c, { blocked: result.blocked })
  }
  return success(c, result.data)
})

/** Why a `cardRef` stopped the call. On each of these nothing ran and no card changed. */
function cardRefRefused(c: Context<AppEnv>, opened: OpenedToolCardRef & { ok: false }) {
  if (opened.refusal === "not_readable") {
    const message = "This card's conversation cannot be read here. Nothing ran."
    return c.json({ error: { message, code: "card_not_found" } }, 404)
  }
  if (opened.refusal === "other_app") {
    const message = "This card came from another app's tool. Nothing ran."
    return c.json({ error: { message, code: "card_other_app" } }, 422)
  }
  if (opened.refusal === "not_an_action") {
    const message =
      "This card does not offer that call with these values. Nothing ran and the card is unchanged. Use one of the card's own actions."
    return c.json({ error: { message, code: "card_action_unknown" } }, 422)
  }
  const message = opened.card
    ? "This card changed since it was drawn. Nothing was saved. The latest card is attached."
    : "This card is no longer there. Nothing was saved."
  return c.json(
    {
      error: {
        message,
        code: "card_changed",
        card: opened.card,
        cardRevision: opened.cardRevision,
        // The web client's error reader keeps `details` only: the latest card rides there too.
        details: { card: opened.card, cardRevision: opened.cardRevision },
      },
    },
    409,
  )
}

// Phase 16.6 — Plugin-friendly form: `/api/apps/<appName>/tools/<toolName>`.
// Built so plugin UIs can call `host.invokeTool(appName, toolName, args)`
// without composing the namespaced `<appName>:<toolName>` themselves. The
// server reassembles the canonical key before dispatching to executeTool.
appRoutes.post("/:appName/tools/:toolName", async (c) => {
  const appName = c.req.param("appName")
  const toolName = c.req.param("toolName")
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  // K1b — `kernel:slots.list` shim. A bundle calling
  // `app.invokeTool("kernel:slots.list", { slot })` resolves to
  // `POST /api/apps/<appName>/tools/kernel:slots.list`. Intercept the literal
  // `kernel:slots.list` toolName (which is NOT a real registered tool) and
  // dispatch to `listSlotPanels` instead, returning `{ panels }` — the shape the
  // host expects. Any other `kernel:`-prefixed toolName falls through to the
  // normal executeTool path so future kernel shims aren't pre-empted.
  if (toolName === "kernel:slots.list") {
    await primeOrgApps(c.get("orgId"))
    const params = (body.params ?? body) as Record<string, unknown>
    const slot = typeof params.slot === "string" ? params.slot : ""
    const panels = slot
      ? listSlotPanels({
          orgId: c.get("orgId"),
          scopes: (c.get("scopes") as unknown as string[]) ?? [],
          slot,
          userId: c.get("userId"),
        })
      : []
    return success(c, { panels })
  }

  // A call from a stored card names that card. It is no parameter of the tool.
  const { cardRef: rawCardRef, ...toolBody } = body
  const cardRef = parseToolCardRef(rawCardRef)
  if (cardRef === "invalid") {
    throw new HTTPException(422, { message: "cardRef needs a messageId and a toolCallId" })
  }
  const orgId = c.get("orgId")
  const actor = extractRlsContext(c)
  if (!cardRef) {
    const params = toolBody.params ?? toolBody
    return runAppTool(c, { appName, toolName, params, threadId: toolBody.threadId })
  }
  // What the card is asked to do: the flat form carries the thread beside the params. The tool
  // gets exactly the params the card check matched, and runs in the card's own thread: a thread
  // the request names must be that one.
  const { threadId: requestThread, ...flatParams } = toolBody
  const request = { toolName, params: toolBody.params ?? flatParams, threadId: requestThread }

  const first = await openToolCardRef(actor, orgId, appName, cardRef, request)
  if (!first.ok) return cardRefRefused(c, first)
  // One action at a time per card: the revision is checked again once the claim is held, so of
  // two clicks on the same revision one runs and the other is told the card changed.
  const claim = await claimToolCard(cardRef)
  if (!claim) {
    const current = await currentToolCard(actor, orgId, appName, cardRef)
    return cardRefRefused(
      c,
      current.ok ? { ok: false, refusal: "changed", card: null, cardRevision: null } : current,
    )
  }
  try {
    const opened = await openToolCardRef(actor, orgId, appName, cardRef, request)
    if (!opened.ok) return cardRefRefused(c, opened)
    return await runAppTool(c, {
      appName,
      toolName,
      params: request.params,
      threadId: opened.threadId,
      cardRef,
    })
  } finally {
    await releaseToolCard(cardRef, claim)
  }
})

/** Run an app tool from the REST form, and replace the card it was clicked from, if any. */
async function runAppTool(
  c: Context<AppEnv>,
  args: {
    appName: string
    toolName: string
    params: unknown
    threadId: unknown
    cardRef?: ToolCardRef
  },
) {
  const { appName, toolName, cardRef } = args
  const orgId = c.get("orgId")
  const actor = extractRlsContext(c)
  // Plugin-friendly REST form: same direct browser UI call as /tools/:toolName.
  const call = await restToolCall(c, args.threadId)
  let result: Awaited<ReturnType<typeof executeTool>>
  try {
    result = await executeTool({
      toolName: `${appName}:${toolName}`,
      orgId,
      actor,
      threadId: call.threadId,
      params: args.params,
      origin: call.origin,
      signal: getRequestSignal(c),
    })
  } catch (err) {
    // The tool's own revision moved: it refused, so draw what is stored now.
    if (cardRef && (err as { code?: unknown } | null)?.code === "card_changed") {
      const current = await currentToolCard(actor, orgId, appName, cardRef)
      if (!current.ok) return cardRefRefused(c, current)
    }
    throw err
  }
  if (result.blocked) {
    return success(c, { blocked: result.blocked })
  }
  if (!cardRef) return success(c, result.data)
  const { card, cardRevision, stored, why } = await replaceToolCard(cardRef, {
    orgId,
    actorId: c.get("userId"),
    appName,
    toolName,
    result: result.data,
  })
  return success(c, result.data, {
    card,
    cardRevision,
    cardStored: stored,
    ...(why ? { why } : {}),
  })
}

appRoutes.post("/run-tool", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof body.toolName !== "string") {
    throw new HTTPException(400, { message: "toolName is required" })
  }
  // Direct browser UI call, same as /tools/:toolName.
  const call = await restToolCall(c, body.threadId)
  const result = await executeTool({
    toolName: body.toolName,
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
    threadId: call.threadId,
    params: body.params ?? {},
    origin: call.origin,
    signal: getRequestSignal(c),
  })
  return success(c, result.blocked ? { blocked: result.blocked } : result.data)
})

// Export endpoint — delegates to the shared invokeAppExport path so the HTTP
// route, the multi-app orchestrator, and the kernel.export agent tool share
// exactly one invocation path.
//
// Admin-gated to match the canonical multi-app export route (`/api/export`,
// see app.ts) — both surface bulk org data and must require the same
// `kernel:users:admin` scope. Without this gate any member holding a single
// `<app>:*` scope could export that app's full dataset (invokeAppExport's
// internal check only requires "some app-level scope"), bypassing the admin
// gate that protects the equivalent multi-app endpoint.
appRoutes.get("/export/:appName", requireScope("kernel:users:admin"), async (c) => {
  const appName = c.req.param("appName")
  const format = c.req.query("format") ?? "json"
  const exportOrgId = c.get("orgId")
  const from = c.req.query("from")
  const to = c.req.query("to")
  const dateRange = from || to ? { from, to } : undefined

  try {
    const result = await invokeAppExport(exportOrgId, appName, format, extractRlsContext(c), {
      dateRange,
    })
    return success(c, result)
  } catch (err) {
    throw toHttpException(err)
  }
})

appRoutes.get("/dimensions", requireScope("kernel:users:admin"), async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)

  const data: Array<{
    app: string
    key: string
    localKey: string
    label: string
    type: string
    order?: string[]
    values?: string[]
    valueSource?: { kind: string }
  }> = []
  for (const [[entryOrgId, app, localKey], def] of dimensionDefRegistry.entries()) {
    if (entryOrgId !== orgId && entryOrgId !== "*") continue
    const key = `${app}:${localKey}`
    data.push({
      app,
      key,
      localKey,
      label: KNOWN_LABELS[key] ?? localKey,
      type: def.type,
      order: def.order,
      values: def.values,
      valueSource: KNOWN_VALUE_SOURCES[key],
    })
  }

  data.sort((a, b) => a.key.localeCompare(b.key))
  return success(c, data)
})

appRoutes.get("/dimensions/:dimensionKey/values", requireScope("kernel:users:admin"), async (c) => {
  const orgId = c.get("orgId")
  const dimensionKey = c.req.param("dimensionKey")

  if (dimensionKey === "mail:inbox") {
    const mailAccountsTable = drizzleSql.raw(`${quoteIdent(schemaRef("app_mail"))}.accounts`)
    const rows = await withPrivilegedDb(orgId, "dimension-values-mail-inbox", async (tx) =>
      extractRows<{ id: string; email_address: string; display_name: string | null }>(
        await tx.execute(drizzleSql`
        SELECT id, email_address, display_name
        FROM ${mailAccountsTable}
        WHERE org_id = ${orgId} AND owner_type = 'org' AND disconnected_at IS NULL
        ORDER BY email_address ASC
      `),
      ),
    )

    return success(
      c,
      rows.map((row) => ({
        value: row.id,
        label: row.display_name ?? row.email_address,
        sublabel: row.email_address,
      })),
    )
  }

  throw new HTTPException(404, { message: "Unknown dimension or no value source" })
})

// GET /api/apps/manifests — returns installed manifest-format apps' UI metadata for frontend bootstrap.
//
// SURFACE VISIBILITY (per-user): an app's manifest is returned only if the
// requesting user holds at least one scope the app declares. The frontend
// bootstrap (`loadManifestApps`) registers an app — and thus its activity-bar
// icon, settings section, and tab types — solely from this response, so
// filtering here is the single chokepoint that hides an app a user has no
// access to (no icon, no nav, and the UI bundle is never even shipped). This
// complements the request-path scope enforcement on tool execution: that fails
// a call closed, this removes the surface so the user never sees it. App
// enablement (`organizations.settings.enabledApps`) remains org-level curation;
// this filter is the per-USER layer.
//
// Apps that declare NO scopes stay visible to everyone (fail-open — there is
// nothing to gate on, and historically every app was visible to every member);
// a full-wildcard (`*`) admin holder sees every app via `hasScope`.
// The features switched on in this workspace, read with the shell's app list. What
// is not listed is off: the shell hides a settings section or tab type that names it.
// Fail-closed: an unreadable app state fails the request.
appRoutes.get("/features", async (c) => {
  const orgId = c.get("orgId")
  await primeOrgApps(orgId)
  return c.json({ data: enabledFeaturesFor(orgId) })
})

appRoutes.get("/manifests", async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  // An app turned Off or removed for the workspace (S19), or restricted away
  // from this person (S20), is omitted for EVERY user (admins manage it from
  // GET /api/org/apps). `unavailableApps` names them so the shell also drops
  // the navigation of in-tree apps it registers itself and renders their open
  // tabs as unavailable. Fail-closed: an unreadable state fails the request.
  await primeOrgApps(orgId)
  const userId = c.get("userId") ?? null

  const isVisible = appVisibilityFor(orgId, (c.get("scopes") as string[] | undefined) ?? [])

  const data: Array<{
    name: string
    firstParty?: true
    signed?: true
    manifest: Record<string, any>
    uiBundleUrl: string | null
    /** The app's frame on an origin of its own (LIAISON_APP_FRAME_ORIGIN_TEMPLATE), when it has one. */
    frameUrl?: string
  }> = []
  for (const [, entry] of manifestRegistry.entriesOf(orgId)) {
    if (entry.name === "kernel") continue // kernel is not a manifest app; its data is hardcoded on the frontend
    if (isAppUnavailableFor(orgId, entry.name, userId)) continue // Off, removed or restricted away
    if (!(await appVisibleToOrg(entry.name, orgId))) continue // another org's custom app
    if (!isVisible(entry.name)) continue // per-user surface visibility — see header comment
    // An installed app's interface is JS that runs in this page's origin with the
    // user's session. It is listed only when the platform (first-party), the
    // operator (trusted-publisher signature) or an admin (recorded approval)
    // vouched for it; otherwise it is as absent as an app without a `ui.js`.
    let uiBundleUrl = entry.uiBundleUrl
    // A first-party interface runs in a browser tab's page; any other one runs
    // there in the sandboxed frame (apps/web framework/bootstrap.ts, S16).
    let firstParty = false
    if (uiBundleUrl) {
      const trust = await getInstallTrust(entry.name)
      firstParty = trust.uiTrust === "first-party"
      if (trust.uiTrust === null) {
        uiBundleUrl = null
      } else if (trust.uiTrust !== "first-party") {
        // A non-first-party bundle is fetched with a token bound to this app and version.
        const version = /\/([^/]+)\/ui\.js$/.exec(uiBundleUrl)?.[1]
        if (version) {
          const t = await signUiBundleToken(entry.name, version, boundHost(c))
          uiBundleUrl = `${uiBundleUrl}?t=${encodeURIComponent(t)}`
        }
      }
    }
    // App screens on origins of their own: every framed app, and each first-party app
    // named in LIAISON_FRAMED_APPS, gets its frame URL on `<app>--<org>`, minted for
    // THIS request's org (app-frame-host-route.ts). A framed first-party app is then
    // not first-party for the page or a shell: both frame it.
    let frameUrl: string | null = null
    const servedVersion = uiBundleUrl
      ? /\/([^/]+)\/ui\.js(?:\?|$)/.exec(uiBundleUrl)?.[1]
      : undefined
    if (uiBundleUrl && servedVersion && appFrameOriginsEnabled()) {
      if (framesOnOwnOrigin(entry.name, firstParty)) {
        frameUrl = await mintAppFrameUrl(orgId, entry.name, servedVersion)
        if (frameUrl) firstParty = false
      }
    }
    // A first-party app built from the signed release artifact: its statement is
    // served beside ui.js, and a shell verifies it before running the UI in-page.
    const signed =
      firstParty &&
      typeof entry.version === "string" &&
      catalogStatement(entry.name, entry.version) !== null
    data.push({
      name: entry.name,
      ...(firstParty ? { firstParty: true } : {}),
      ...(signed ? { signed: true } : {}),
      manifest: {
        name: entry.name,
        views: entry.views,
        slots: entry.slots,
        contributions: entry.contributions,
        bulk: entry.bulk,
        savedViews: entry.savedViews,
        entities: entry.entities,
        tools: entry.tools,
        // Declarative settings page and listing fields (settings-overhaul A22).
        kind: entry.kind ?? "app",
        settings: entry.settings,
        description: entry.description,
        displayName: entry.displayName,
        version: entry.version,
        license: entry.license,
        // The page header's "by …" line: the store listing's publisher, which
        // every first-party manifest sets, before the free-form author.
        author: entry.publisher ?? entry.author,
        homepage: entry.homepage,
        // The icon as data (S1): the client shows iconSvg only as an <img>
        // source after its own check, never as markup in the page.
        iconSvg: entry.iconSvg,
        iconName: entry.iconName,
      },
      uiBundleUrl,
      ...(frameUrl ? { frameUrl } : {}),
      ...(uiBundleUrl && servedVersion
        ? { externalHosts: (await grantedDeclaredHosts(entry.name, servedVersion)).linkHosts }
        : {}),
    })
  }
  return c.json({ data, unavailableApps: unavailableAppsFor(orgId, userId) })
})

// GET /api/apps/connections
// Every app's connection views in ONE request, for Settings > Apps (which used
// to fetch each app's config separately). Same public-safe whitelist and
// account counts as the per-app route below (connection-overview.ts). Keyed by
// app name; apps with no declared connection are absent.
appRoutes.get("/connections", async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  return c.json({ data: await listAppConnectionViews(orgId, c.get("userId")) })
})

// GET /api/apps/:appName/connections
// Public-safe connection config for the connect UI. Returns, per declared
// connection, only what a connect form + its `?` setup-guide popover needs:
// `name`, `type`, `description`, `credentialFields`, `setupGuide`, plus
// `optional`, `purpose` and the active/error `accounts` counts. This is a
// strict WHITELIST (connection-overview.ts) — secret-config keys
// (`clientSecretConfigKey`, `webhookSecretConfigKey`), OAuth endpoints,
// `allowedDomains`, and template internals are never serialized to the
// browser. Any authenticated org member may read it (gated by the
// `/api/apps/*` auth middleware). 404 when the app is not installed for this
// org; a known app with zero connections returns `[]`.
appRoutes.get("/:appName/connections", async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  const appName = c.req.param("appName")

  if (!manifestRegistry.get([orgId, appName])) {
    throw new HTTPException(404, { message: `App "${appName}" not found` })
  }
  const views = await listAppConnectionViews(orgId, c.get("userId"), appName)
  return c.json({ data: views[appName] ?? [] })
})

// GET /api/apps/:appName/config
// The app's declared, non-secret config keys (manifest `configKeys`) with their
// stored values. Admin only, like the write below. Secret keys are never
// declared (the manifest validator refuses them), so none can be listed.
appRoutes.get("/:appName/config", requireScope("kernel:apps:admin"), async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  const appName = c.req.param("appName")
  const declared = declaredAppConfigKeys(orgId, appName)
  if (declared === null) throw new HTTPException(404, { message: `App "${appName}" not found` })
  const stored = await withPrivilegedDb(orgId, "app-config-read", (tx) =>
    readAppConfig(tx, orgId, appName),
  )
  return success(
    c,
    declared.map((d) => ({ ...d, value: stored[d.key] ?? null })),
  )
})

// PUT /api/apps/:appName/config/:key  body { value }
// Allowlisted write of one non-secret config key into `kernel.apps.config`, the
// store bundled apps read with `ctx.config.get`. Only keys the installed app's
// manifest declares in `configKeys`; connection secret keys are refused; the
// value is checked against the declared type (url: http/https only). `null`
// clears the key. Audit-logged; an unchanged value writes nothing.
appRoutes.put("/:appName/config/:key", requireScope("kernel:apps:admin"), async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  const { appName, key } = c.req.param()
  const body = (await c.req.json().catch(() => null)) as unknown
  if (!body || typeof body !== "object" || !("value" in body)) {
    throw new HTTPException(400, { message: "Body must be { value }" })
  }
  const check = checkAppConfigWriteForOrg(orgId, appName, key, body.value)
  if (!check.ok) {
    throw new HTTPException(check.code === "unknown_app" ? 404 : 400, { message: check.message })
  }
  const result = await writeAppConfigKey({
    orgId,
    appName,
    key,
    value: check.value,
    actorId: c.get("userId") ?? null,
    actorType: "user",
    source: "api",
  })
  return success(c, { key, value: result.value, changed: result.changed })
})

// GET /api/apps/:appName/views/detail/:entity/:id/external-link
// Phase 16 / Code-review I1 — uniform kernel-side resolver for the deep-link
// declared in `manifest.views.detail.<entity>.externalLink`. The frontend
// shell uses this so the "Open in <app> ↗" affordance renders identically
// across third-party apps without each one re-implementing template
// substitution. Returns 404 when the externalLink is not declared.
appRoutes.get("/:appName/views/detail/:entity/:id/external-link", async (c) => {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  const appName = c.req.param("appName")
  const entity = c.req.param("entity")
  const id = c.req.param("id")

  // Read-scope gate — the external link reveals that the entity exists (and
  // its provider-side id), so the caller must hold the entity's declared read
  // scope. Resolve from the entity registry (org-scoped, then "*"), checking
  // both the top-level `readScope` and `permissionFields.readScope`. When the
  // entity declares no read scope there is nothing to gate on, so the link is
  // returned (the deep link only resolves an in-app URL, not entity data).
  const callerScopes = (c.get("scopes") as string[] | undefined) ?? []
  const entityDef =
    entityRegistry.get([orgId, appName, entity]) ?? entityRegistry.get(["*", appName, entity])
  const requiredReadScope = entityDef?.readScope ?? entityDef?.permissionFields?.readScope
  if (requiredReadScope && !hasScope(requiredReadScope, callerScopes)) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  const url = new URL(c.req.url)
  const extraVars: Record<string, string> = {}
  for (const [k, v] of url.searchParams.entries()) {
    // Only allow lowercase alphanumeric + underscore keys; matches the
    // template variable pattern in detail-external-link.ts.
    if (/^[a-z0-9_]+$/i.test(k)) extraVars[k] = v
  }
  const link = getDetailExternalLink(orgId, appName, entity, id, extraVars)
  if (!link) {
    throw new HTTPException(404, { message: "No externalLink declared" })
  }
  return success(c, link)
})

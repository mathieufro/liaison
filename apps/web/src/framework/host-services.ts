// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.6 — buildHostServices() factory. Builds the HostServices value
// the kernel assigns to window.__liaisonHost at boot. Uses the existing
// createApiClient + auth-store so plugin requests share the same auth
// refresh + unauthorized handling the kernel already wires for first-party
// API calls.

import type { HostServices } from "@liaison/host"
import { createComponent, createRoot, getOwner, runWithOwner } from "solid-js"
import { insert, render } from "solid-js/web"
import { getContributions } from "~/framework/app-registry"
import { onEntityChange } from "~/framework/entity-changes"
import {
  assertNotPersonOnly,
  PersonOnlyActionError,
  personOnlyTool,
} from "~/framework/person-only-actions"
import { pagePath } from "~/framework/spa-navigate"
import { type ApiClient, assertKernelRelativePath, createApiClient } from "~/lib/api-client"
import type { EnsureFreshToken, PendingRefresh } from "~/lib/auth-refresh"
import { env, serverAddressOverride } from "~/lib/env"
import { socketReconnecting } from "~/lib/socket-state"
import { canOpenDownloadedFile, openDownloadedFile } from "~/modules/desktop/desktop-store"
import { currentLocale } from "~/modules/i18n/i18n-context"
import { openConnectDialog } from "~/modules/settings/connect-dialog-host"
import { connectWithOAuth } from "~/modules/settings/oauth-connect"
import { trackOpenRecord } from "~/modules/shell/open-record"
import { EntityDiscussionPanel } from "~/modules/threads/EntityDiscussionPanel"
import { createStaleResource } from "~/primitives/createStaleResource"

/** 3-part `<host>.<slot>.<kind>` → 2-part registry key `<host>.<slot>`
 *  (matches define-app's `effectiveSlot`). Other arities pass through. */
function normalizeSlotKey(slot: string): string {
  const parts = slot.split(".")
  return parts.length === 3 ? `${parts[0]}.${parts[1]}` : slot
}

export interface BuildHostServicesOptions {
  getAccessToken: () => string | null
  onUnauthorized: () => void
  onError: (status: number, message: string) => void
  /** Optional ensure-fresh-token hook from the kernel's authManager. */
  ensureFreshToken?: EnsureFreshToken
  /** The kernel authManager's refresh in flight, which a request waits for. */
  pendingRefresh?: PendingRefresh
  /** Optional navigate (defaults to `window.location.href = url`). */
  navigate?: (url: string) => void
  /**
   * Optional in-app SPA navigation for plugins (kernel-relative path, no reload).
   * Defaults to `window.location.assign(path)` when not provided.
   */
  inAppNavigate?: (path: string) => void
  /** Optional baseUrl (defaults to env.API_BASE). */
  baseUrl?: string
  /**
   * Optional resolver for an app's connection-flow authorize route.
   * Defaults to `/api/apps/<appName>/connect` — kernel side mounts a generic
   * connect-initiator that reads the first connection in the manifest registry.
   */
  resolveAuthorizeRoute?: (appName: string) => string | undefined
}

export function buildHostServices(opts: BuildHostServicesOptions): HostServices {
  const navigate =
    opts.navigate ??
    ((url: string) => {
      if (typeof window !== "undefined") window.location.href = url
    })

  // THE SERVER'S ORIGIN AND NOTHING MORE: apiClient does NOT auto-prefix
  // `/api`. The plugin contract is "paths are full kernel routes" (e.g.
  // `/api/me`, `/api/apps/<n>/tools/<t>`), and `invokeTool` / `openConnect`
  // already build full `/api/apps/...` paths. With a bare "" here,
  // host.fetch("/api/me") → /api/api/me (404) was avoided, but under the
  // desktop shell the page origin is not the server, and every plugin call
  // went to the shell's asset protocol (index.html, 200) instead.
  const hostBase = opts.baseUrl ?? serverAddressOverride() ?? ""
  const apiClient: ApiClient = createApiClient({
    getAccessToken: opts.getAccessToken,
    onUnauthorized: opts.onUnauthorized,
    onError: opts.onError,
    ensureFreshToken: opts.ensureFreshToken,
    pendingRefresh: opts.pendingRefresh,
    baseUrl: hostBase,
    // A read that fails while the shell's socket reconnects raises no toast (S26).
    isReconnecting: socketReconnecting,
  })

  // `invokeTool` is a PROGRAMMATIC call — the calling app UI handles its own
  // failures (empty state, inline retry; e.g. boxtal Shipments `fetchShipments`
  // catches → []). A tool-call failure must therefore NOT fire the GLOBAL error
  // toast (a transient 504/timeout on a background list-load would otherwise
  // surface a spurious "Something went wrong"). This client omits `onError`, so
  // the promise still rejects (callers react) but nothing toasts globally.
  // `onUnauthorized` is kept so token refresh still works.
  const toolClient: ApiClient = createApiClient({
    getAccessToken: opts.getAccessToken,
    onUnauthorized: opts.onUnauthorized,
    ensureFreshToken: opts.ensureFreshToken,
    pendingRefresh: opts.pendingRefresh,
    baseUrl: hostBase,
  })

  // The kernel's own stores (apps-store) speak bare `/apps/...` paths under the
  // API base, like the Shell's client; this one serves them for the connect
  // dialog. No global toast: a failure is the calling app's to show.
  const kernelClient: ApiClient = createApiClient({
    getAccessToken: opts.getAccessToken,
    onUnauthorized: opts.onUnauthorized,
    ensureFreshToken: opts.ensureFreshToken,
    pendingRefresh: opts.pendingRefresh,
    baseUrl: `${hostBase}${env.API_BASE}`,
  })

  // Legacy hook: when a host override is provided it wins verbatim. The
  // DEFAULT path resolves the app's declared connection and posts to the real
  // kernel authorize route (the old `/api/apps/<app>/connect` default pointed
  // at a route that never existed — every plugin-initiated connect 404'd).
  const resolveAuthorizeRoute = opts.resolveAuthorizeRoute

  return {
    accessToken: () => opts.getAccessToken(),

    // The reader's language, reactive, so app UIs translate their own copy.
    locale: () => currentLocale(),

    // The page's path and query. In the page, an app's own location is the
    // page's, so this reads the window (an app's own pushState included); it
    // tracks the router's route for a reactive reader.
    currentPath: (): string => {
      const routed = pagePath()
      return typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : routed
    },

    // The record this page has open in a pane (shell/open-record.ts). The app is
    // the one the SDK bound the call to, so it can only name its own entities.
    trackOpenRecord,

    navigate: (path: string): void => {
      if (opts.inAppNavigate) {
        opts.inAppNavigate(path)
      } else if (typeof window !== "undefined") {
        window.location.assign(path)
      }
    },

    fetch: async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      // SECURITY: a sandboxed plugin controls `path`. Because the underlying
      // apiClient is built with baseUrl "" (paths used verbatim) AND attaches
      // the user's bearer token, an absolute/protocol-relative path here would
      // send that token to an attacker origin → account takeover. Reject any
      // non-kernel-relative path BEFORE the token is read or apiClient is
      // dispatched. Legit plugin calls are all `/api/...`, so they pass.
      assertKernelRelativePath(path)
      const method = (init?.method ?? "GET").toUpperCase()
      const signalOpts = init?.signal ? { signal: init.signal } : undefined
      // An app UI acts with the person's token, so the acts only a person may
      // take (framework/person-only-actions.ts) are refused here, before any
      // request leaves. The kernel's own pages use their own client.
      if (method === "GET") {
        assertNotPersonOnly(method, path)
        return apiClient.get<T>(path, signalOpts)
      }
      const body = parseJsonBodyOrThrow(init?.body, path)
      assertNotPersonOnly(method, path, body)
      switch (method) {
        case "POST":
          return apiClient.post<T>(path, body, signalOpts)
        case "PUT":
          return apiClient.put<T>(path, body, signalOpts)
        case "PATCH":
          return apiClient.patch<T>(path, body, signalOpts)
        case "DELETE":
          return apiClient.delete<T>(path, body, signalOpts)
        default:
          throw new Error(`@liaison/host fetch: unsupported method ${method}`)
      }
    },

    // Binary GET for app UIs (PDF download, logo thumbnail, label print).
    // Apps used to `window.fetch("/api/files/…/inline")` themselves: in a
    // browser that lands on the API, but under the desktop or mobile shell the
    // page origin is the shell's bundle, whose SPA fallback answers any unknown
    // path with its own index.html and a 200. The app then blobbed that HTML
    // as application/pdf and the user got an empty PDF. Going through
    // apiClient puts the request on the bound server (same base as every
    // other plugin call) with the bearer and the refresh-on-401 path; an HTML
    // answer is refused so no web page is ever saved under a file's name.
    fetchBlob: async (path: string): Promise<Blob> => {
      assertKernelRelativePath(path)
      // The calling UI owns the failure (inline fallback, its own message).
      const response = await apiClient.rawGet(path, { suppressGlobalError: true })
      const contentType = response.headers.get("Content-Type") ?? ""
      if (/^\s*text\/html\b/i.test(contentType)) {
        throw new Error(
          `@liaison/host fetchBlob(${path}): the server answered a web page, not a file`,
        )
      }
      return await response.blob()
    },

    // A fetched file shown to the user. In a browser the app opens a `blob:`
    // tab itself (false here). The desktop webview opens no tab and its shell
    // refuses `blob:` links, so the button did nothing: the shell saves the
    // bytes and opens them in the default application instead.
    openFile: async (file: Blob, filename: string): Promise<boolean> => {
      if (!canOpenDownloadedFile()) return false
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (await openDownloadedFile(bytes, filename)) return true
      throw new Error(`@liaison/host openFile: the desktop app could not open ${filename}`)
    },

    invokeTool: async <T = unknown>(
      appName: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<T> => {
      // A direct tool run counts as the person's click: never for a person-only act.
      const personOnly = personOnlyTool(`${appName}:${toolName}`)
      if (personOnly) throw new PersonOnlyActionError(personOnly.action)
      return toolClient.post<T>(`/api/apps/${appName}/tools/${toolName}`, args)
    },

    // Resource factory for plugins (app.createResource). Delegates to the
    // kernel's createStaleResource so bundled-app tabs revalidate on resync +
    // stale activation. Called synchronously from the plugin's component body,
    // so it runs under the caller's reactive owner — its subscriptions dispose
    // with the component. `runWithOwner` guards the case where the caller's owner
    // is present (it always is inside a component body); if absent the resource
    // is still created (behaves as always-active).
    createResource: <T = unknown>(
      fetcher: () => T | Promise<T>,
      resourceOpts?: { staleAfterMs?: number },
    ) => {
      const owner = getOwner()
      const make = () => createStaleResource<T>(fetcher, resourceOpts)
      // runWithOwner returns the callback value; make() never returns undefined,
      // so the non-null assertion is safe.
      const res = (owner ? runWithOwner(owner, make) : make())!
      // Return the createResource-shaped tuple so the plugin swap is one line.
      return [res, { refetch: res.refetch, mutate: res.mutate }] as never
    },

    openConnect: async (
      appName: string,
      connectOpts?: { connectionName?: string; params?: Record<string, string> },
    ): Promise<void> => {
      let route = resolveAuthorizeRoute?.(appName)
      if (!route) {
        // Resolve the connection to authorize: caller-specified, else the app's
        // first declared connection (the common single-connection case).
        let connectionName = connectOpts?.connectionName
        if (!connectionName) {
          const conns = await apiClient.get<Array<{ name: string }> | null>(
            `/api/apps/${appName}/connections`,
          )
          connectionName = conns?.[0]?.name
        }
        if (!connectionName) {
          throw new Error(
            `@liaison/host openConnect("${appName}"): app declares no connection to authorize`,
          )
        }
        route = `/api/connections/${appName}/${connectionName}/authorize`
      }
      // The OAuth authorize URL is an EXTERNAL origin (provider consent page) —
      // `navigate` here is the full-page default (or the test seam), NOT the
      // SPA router. A desktop or mobile shell runs the flow in the system
      // browser instead (settings/oauth-connect.ts).
      const outcome = await connectWithOAuth(apiClient, route, connectOpts?.params ?? {}, {
        navigate,
      })
      if (outcome === "no-redirect") {
        throw new Error(
          `@liaison/host openConnect("${appName}"): server at ${route} returned no redirectUrl`,
        )
      }
    },

    // The kernel connect dialog over the current page, for one of the calling
    // app's own connections (connect-dialog-host checks the name against the
    // app's declared connections after loading them).
    openConnectDialog: (appName, dialogOpts) =>
      openConnectDialog(kernelClient, appName, dialogOpts),

    // Live entity changes for app UIs. The caller filter is hygiene, not a
    // security boundary (the WS gate already decides what reaches this
    // session): an app watches its own entities and kernel ones, so a typo or
    // a copy-paste from another app shows up as a warning instead of silently
    // coupling two apps.
    onEntityChange: (callerApp, keys, cb, changeOpts) => {
      const kept = filterAppEntityKeys(callerApp, Array.isArray(keys) ? keys : [keys])
      if (kept.length === 0) return () => {}
      return onEntityChange(kept, cb, changeOpts)
    },

    mountSlot: (_callerApp, anchor, descriptor) => {
      const entry = getContributions(normalizeSlotKey(descriptor.slot)).find(
        (c) => c.appId === descriptor.app && c.id === descriptor.id,
      )
      if (!entry) return { resolved: false, dispose: () => {} }
      // The bridge types `anchor` as the DOM-lib-free structural `SlotAnchor`
      // (host-sdk carries no DOM lib). At runtime the kernel always receives a
      // real DOM element here (the bundled app passes a `ref`), so narrow to the
      // concrete mount node Solid's `render` requires. `Element` is the precise
      // runtime type — not a blanket `any` widening.
      const mountNode = anchor as unknown as Element
      // `entityId` is a snapshot captured at mount time, not a reactive accessor:
      // the mounted component's `createResource(() => props.entityId, …)` will NOT
      // re-fetch if entityId later changes. The descriptor is intentionally
      // serializable/static (future iframe boundary), so callers that need a new
      // entityId must dispose and re-mount. Invoicing does exactly this — its
      // createEffect disposes + re-mounts on props.documentId change.
      const dispose = render(
        () => createComponent(entry.component, { entityId: descriptor.entityId }),
        mountNode,
      )
      return { resolved: true, dispose }
    },

    // A bundle's discussion of one of its records. Rendered under the caller's
    // owner, so the kernel component finds the page's api, language and socket.
    mountEntityDiscussion: (callerApp, anchor, descriptor) => {
      const owner = getOwner()
      if (!owner) return { resolved: false, dispose: () => {} }
      const mountNode = anchor as unknown as Element
      const dispose = createRoot((disposeRoot) => {
        insert(mountNode, () =>
          createComponent(EntityDiscussionPanel, {
            app: descriptor.app ?? callerApp,
            entityType: descriptor.entityType,
            entityId: descriptor.entityId,
            testId: descriptor.testId,
            emptyText: descriptor.emptyText,
            placeholder: descriptor.placeholder,
            sendLabel: descriptor.sendLabel,
          }),
        )
        return disposeRoot
      }, owner)
      return {
        resolved: true,
        dispose: () => {
          dispose()
          mountNode.textContent = ""
        },
      }
    },
  }
}

/** Keys an app may watch: `<callerApp>:…` or `kernel:…`; the rest is dropped
 *  with a console warning. Exported for tests. */
export function filterAppEntityKeys(callerApp: string, keys: string[]): string[] {
  const kept: string[] = []
  for (const key of keys) {
    if (key.startsWith(`${callerApp}:`) || key.startsWith("kernel:")) {
      kept.push(key)
    } else {
      console.warn(
        `@liaison/host onEntityChange("${callerApp}"): ignoring "${key}", an app may watch only its own keys ("${callerApp}:…") or kernel ones ("kernel:…")`,
      )
    }
  }
  return kept
}

/** Plugin must JSON.stringify the body itself (or pass an object via shared `host.fetch`). */
function parseJsonBodyOrThrow(body: BodyInit | null | undefined, path: string): unknown {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") {
    try {
      return JSON.parse(body)
    } catch {
      throw new Error(
        `@liaison/host fetch(${path}): body string is not JSON — only JSON requests supported`,
      )
    }
  }
  throw new Error(
    `@liaison/host fetch(${path}): unsupported body type (${
      (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body
    }); only JSON-stringified bodies supported in Phase 16.6`,
  )
}

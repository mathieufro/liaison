// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.6 — Plugin host-services bridge.
//
// Plugin UI bundles consume this package to reach kernel-provided services
// (auth-aware fetch, tool invocation, connection-flow) WITHOUT importing
// from `apps/web/` internals. The freeze tool bundles this package into the
// plugin's `ui.js` (NOT externalized — module-caching would force a single
// shim instance across all plugins, breaking per-app binding). esbuild's
// `define:` substitutes `__LIAISON_APP_NAME__` at freeze time so the `app`
// namespace exposes pre-bound `invokeTool` / `openConnect` calls — plugins
// never hardcode their own name.
//
// Runtime services live on `window.__liaisonHost`, assigned by the kernel
// in `apps/web/src/index.tsx` before any `loadManifestApps()` dynamic import.

// Ambient: substituted at freeze time via esbuild `define:`; undefined at
// unit-test time (the test global fallback below handles that).
declare const __LIAISON_APP_NAME__: string | undefined

// ─────────────────────────────────────────────────────────────────────────
// Public types — plugins `import type { HostServices } from "@liaison/host"`.
// ─────────────────────────────────────────────────────────────────────────

/** A pending approval after an edit: its payload as it now stands and its fingerprint. */
export interface HostApprovalEdit {
  currentPayload?: Record<string, unknown>
  payloadHash?: string
}

/** Generic auth-aware fetch. Path is kernel-relative ("/api/..."). */
export type HostFetch = <T = unknown>(path: string, init?: RequestInit) => Promise<T>

/** Tool invoker (un-bound — the kernel writes the un-bound shape; the `app` namespace below pre-binds appName). */
export type ToolInvoker = <T = unknown>(
  appName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<T>

/** Connection-flow opener. `opts` targets a specific declared connection and
 *  forwards provider params to the authorize route (e.g. Shopify's `shop`
 *  template var + `mode: "org"` for an org-owned store connection) — the
 *  RECONNECT path re-runs the same grant in place with them. Optional so
 *  pre-existing host shims/mocks stay valid. */
export type OpenConnect = (
  appName: string,
  opts?: { connectionName?: string; params?: Record<string, string> },
) => Promise<void>

/** What `openConnectDialog` resolves with once the dialog closes. */
export interface ConnectDialogResult {
  /** True when the app has a connected account for the connection afterwards. */
  connected: boolean
  /** True when the user started an OAuth sign-in: the page is about to leave
   *  for the provider, so `connected` is still false at this point. */
  redirected?: boolean
}

/**
 * Open the kernel's connect dialog for `appName` over the current page: the
 * credential form (token, API key, database URL) or the OAuth sign-in, as the
 * app's manifest `connections` declare it. `connectionName` must be one of
 * the app's own connections; without it the host picks the app's primary
 * connection. Resolves when the dialog closes. An OAuth connection resolves
 * `{ connected: false, redirected: true }` just before the browser leaves for
 * the provider.
 */
/**
 * `identifier` and `fields`: one org account of a multiInstance credentials
 * connection (its slug) and the declared credential fields to ask for (all of
 * them when absent), for an app whose accounts each need a different subset.
 */
export interface ConnectDialogOptions {
  connectionName?: string
  identifier?: string
  fields?: string[]
}

export type OpenConnectDialog = (
  appName: string,
  opts?: ConnectDialogOptions,
) => Promise<ConnectDialogResult>

/** Reactive accessor for the current auth token. */
export type AccessTokenAccessor = () => string | null

/**
 * Fetch a kernel file's BYTES (a PDF, an image, any binary) by its
 * kernel-relative path, e.g. `/api/files/<id>/inline`. The host sends it to
 * the server the page is bound to, with the bearer token, and rejects a
 * non-2xx answer or an HTML page. Never `window.fetch` a relative `/api` path
 * from an app UI: under the desktop or mobile shell the page origin is the
 * shell's own bundle, which answers every unknown path with its index.html
 * (200), so the "file" saved is a web page wearing a .pdf name.
 */
export type HostFetchBlob = (path: string) => Promise<Blob>

/**
 * Show the user a file the app fetched (a PDF label, an invoice) when the host
 * opens files itself. Under the desktop shell the webview opens no tab, so a
 * `blob:` tab or `window.open` shows nothing: the host saves the bytes under
 * `filename` and opens them in the system's default application, and answers
 * true. In a browser it answers false at once, and the app opens its `blob:`
 * tab as it always did. Rejects when the shell exists but could not open it.
 */
export type HostOpenFile = (file: Blob, filename: string) => Promise<boolean>

/**
 * In-app SPA navigation to a kernel-relative path (e.g. `/invoicing/document/123`),
 * without a full page reload. Plugins must use this instead of `window.location`
 * so navigation stays within the single-page app and preserves client state.
 */
export type HostNavigate = (path: string) => void

/**
 * Minimal mount-node shape for `mountSlot`. This package is deliberately
 * DOM-lib-free (`lib: ["ESNext"]`, see the `navigate` fallback's structural
 * `location` access), so we model the anchor structurally rather than depend
 * on the global `HTMLElement`. A real DOM `HTMLElement` (what every Solid
 * plugin passes via a `ref`) is assignable to this — the host never calls
 * methods on it; it only forwards the node to the kernel's `render()`.
 */
export interface SlotAnchor {
  readonly nodeType: number
  readonly childNodes: { readonly length: number }
}

/** Serializable descriptor for a cross-app slot body. JSON-safe so it survives
 *  the future iframe boundary — never put functions/refs here. */
export interface SlotMountDescriptor {
  /** Slot id as enumerated server-side (e.g. "invoicing.document_detail.tabs").
   *  The host normalizes a 3-part `<host>.<slot>.<kind>` to its 2-part
   *  registry key. */
  slot: string
  /** Contributing app whose component to mount. */
  app: string
  /** Panel/tab id within the slot. */
  id: string
  /** Entity ref forwarded to the mounted component as `entityId`. */
  entityId?: string
}

export interface SlotMountHandle {
  /** True when a contributed component was resolved and mounted; false →
   *  the caller renders its own fallback. */
  resolved: boolean
  /** Tear down the mounted component. Always safe to call (no-op when unresolved). */
  dispose: () => void
}

/** Host-driven slot mount. `callerApp` is the bound consuming app (reserved for
 *  future iframe routing/telemetry; resolution uses the descriptor). */
/** Serializable descriptor for an entity's discussion mounted by a bundle. */
export interface EntityDiscussionMountDescriptor {
  /** The app whose entity it is; absent means the calling app. */
  app?: string
  /** The entity kind, as the app's manifest declares it (`entities.<type>.discussion`). */
  entityType: string
  entityId: string
  /** The root data-testid (default `entity-discussion`). */
  testId?: string
  /** Shown while the discussion has no message. */
  emptyText?: string
  placeholder?: string
  sendLabel?: string
  /** Text put in the box when it opens, for the person to finish and send (never sent by itself). */
  prefill?: string
}

export type EntityDiscussionMounter = (
  callerApp: string,
  anchor: SlotAnchor,
  descriptor: EntityDiscussionMountDescriptor,
) => SlotMountHandle

export type SlotMounter = (
  callerApp: string,
  anchor: SlotAnchor,
  descriptor: SlotMountDescriptor,
) => SlotMountHandle

/**
 * A resource accessor returned by `app.createResource`. Structurally the shape
 * of a SolidJS `Resource<T>` accessor plus its metadata — modeled here so this
 * package stays solid-free. The real implementation lives in apps/web
 * (`createStaleResource`) and rides the shared `__liaisonSolid` runtime, so the
 * accessor IS a live Solid resource at runtime.
 */
export interface HostResource<T> {
  (): T | undefined
  readonly loading: boolean
  // `any` mirrors SolidJS's `Resource.error` typing so existing `.error?.message`
  // access in plugin code keeps compiling after the createResource swap.
  readonly error: any
}

/** Handle for a `HostResource` — mirrors createResource's second tuple slot. */
export interface HostResourceActions<T> {
  refetch: (info?: unknown) => T | Promise<T | undefined> | null | undefined
  mutate: (value: T | undefined) => T | undefined
}

/**
 * Host-provided resource factory. Returns the SAME `[resource, { refetch,
 * mutate }]` tuple shape as SolidJS `createResource`, so migrating a plugin is a
 * one-line swap. The resource revalidates on the global resync bus (WS sync /
 * reconnect) and on stale tab activation. MUST be invoked synchronously inside
 * the calling component's reactive owner so its subscriptions dispose with it.
 */
export type HostResourceFactory = <T>(
  fetcher: () => T | Promise<T>,
  opts?: { staleAfterMs?: number },
) => [HostResource<T>, HostResourceActions<T>]

/**
 * One entity change seen by the kernel (a WS event, or the synthetic resync).
 * Mirrors the kernel's `EntityChangeEvent`; structural so this package stays
 * free of `apps/web` imports.
 */
export interface HostEntityChangeEvent {
  /** `<app>:<entity>` (kernel entities: `kernel:<entity>`); `*` on resync. */
  key: string
  app: string
  entity: string
  action: string
  data: unknown
  actorId?: string | null
  /** True on the synthetic event delivered after a WS resync/reconnect. */
  resync?: boolean
}

export interface HostEntityChangeOptions {
  /** Quiet period before the batch is delivered (default 150 ms, max-wait 1 s).
   *  0 delivers each event alone. */
  debounceMs?: number
}

/**
 * Host side of `onEntityChange`. `callerApp` is the bound app; the kernel keeps
 * only keys under `<callerApp>:` or `kernel:` and drops the rest with a console
 * warning. That filter is hygiene (apps watch their own data), not a security
 * boundary: the WS gate decides which events reach this session at all.
 */
export type HostEntityChangeSubscriber = (
  callerApp: string,
  keys: string | string[],
  cb: (events: HostEntityChangeEvent[]) => void,
  opts?: HostEntityChangeOptions,
) => () => void

/** Who and where the app's screen is (host API 1.3). Never a token. */
export interface HostContext {
  orgId: string
  orgName: string
  locale: string
  user: { id: string; name: string; locale: string }
}

/** One of the org's document templates for a record type (`listDocumentTemplates`). */
export interface HostDocumentTemplate {
  id: string
  name: string
  [key: string]: unknown
}

/** What to print (`printDocuments`): one of the app's own records, with these templates. */
export interface HostPrintRequest {
  entity: string
  id: string
  templateIds: string[]
  merge?: boolean
}

/** A printed file, as the kernel answers `POST /api/documents/print`. */
export interface HostPrintedFile {
  fileId: string
  filename: string
  [key: string]: unknown
}

export interface HostPrintResult {
  files: HostPrintedFile[]
  merged?: HostPrintedFile | null
  [key: string]: unknown
}

export interface HostServices {
  fetch: HostFetch
  invokeTool: ToolInvoker
  openConnect: OpenConnect
  /** The kernel connect dialog (see `OpenConnectDialog`). Optional so older
   *  shims stay valid; the kernel's buildHostServices() always provides it. */
  openConnectDialog?: OpenConnectDialog
  accessToken: AccessTokenAccessor
  /** Optional so pre-existing host shims/mocks stay valid; the kernel's
   *  buildHostServices() always provides it at runtime. */
  createResource?: HostResourceFactory
  /**
   * In-app SPA navigation. Optional so pre-existing host shims/test mocks remain
   * valid; the kernel's `buildHostServices()` always provides it at runtime.
   */
  navigate?: HostNavigate
  /** Host-driven cross-app slot-body mount. The kernel's buildHostServices()
   *  always provides it; pre-existing shims may not. */
  mountSlot?: SlotMounter
  /** Host-driven mount of an entity's discussion (who may read it is the
   *  server's, from who may see the entity). Optional so older shims stay valid. */
  mountEntityDiscussion?: EntityDiscussionMounter
  /**
   * The reader's UI language ("en", "fr"). A reactive accessor on the kernel
   * (reading it inside a render tracks a language switch). Optional so older
   * shims stay valid; absent means English.
   */
  locale?: () => string
  /** Binary GET through the host (see `HostFetchBlob`). Optional so older
   *  shims stay valid; the kernel's buildHostServices() always provides it. */
  fetchBlob?: HostFetchBlob
  /** Native file opening (see `HostOpenFile`). Optional so older shims stay
   *  valid; absent means "not handled", the browser path. */
  openFile?: HostOpenFile
  /** Live entity changes (see `onEntityChange`). Optional so older shims stay
   *  valid; the kernel's buildHostServices() always provides it. */
  onEntityChange?: HostEntityChangeSubscriber
  /** The page's path and query (see `currentPath`). Host API 1.1; optional so
   *  older shims stay valid. */
  currentPath?: () => string
  /** The record a page has open in a pane (see `app.trackOpenRecord`). Host API
   *  1.2; optional so older shims stay valid. */
  trackOpenRecord?: (
    appName: string,
    entityType: string,
    id: () => string | null | undefined,
  ) => void
  /** Name the page's tab after the record it shows (see `app.tabLabel`). Optional:
   *  a host without it keeps the view's label. */
  tabLabel?: (appName: string, label: () => string | null | undefined) => void
  // Host API 1.3: typed calls instead of kernel routes, so a screen framed on an
  // origin of its own (no network, no session) still works. Each is bound to the
  // calling app and limited by the host; optional so older shims stay valid.
  /**
   * True inside a frame (the app's screen runs outside the page, which answers
   * every call): file opening, approval decisions and outside links then go
   * through the host's typed calls; in the page they keep the direct path.
   */
  framed?: boolean
  /** Org and person (ids, names, locale), never a token. */
  context?: () => HostContext | null
  /** The host fetches a file (an id from this app's own results or records) and opens it. */
  openFileById?: (appName: string, fileId: string, filename: string) => Promise<void>
  listDocumentTemplates?: (appName: string, entity: string) => Promise<HostDocumentTemplate[]>
  printDocuments?: (appName: string, request: HostPrintRequest) => Promise<HostPrintResult>
  /** Pending approvals of this app's own tools that the person may decide. */
  listMyApprovals?: (appName: string) => Promise<unknown[]>
  /** The host asks the person in its own dialog, then decides; rejects when cancelled. */
  decideApproval?: (
    appName: string,
    approvalId: string,
    decision: "approve" | "deny",
    payloadHash?: string,
  ) => Promise<unknown>
  /** Change the fields of one of this app's pending approvals that its tool lets a person
   *  edit; answers the payload as it now stands, with its new fingerprint. */
  editApproval?: (
    appName: string,
    approvalId: string,
    fields: Record<string, unknown>,
  ) => Promise<HostApprovalEdit>
  /** Open an https page of a host the app's manifest declares, in a new tab. */
  openExternal?: (appName: string, url: string) => Promise<void>
  /** Open another app's record in its own tab. */
  openRecord?: (appName: string, app: string, entity: string, id: string) => void
  /** Open the approvals queue. */
  openApprovals?: () => void
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime resolvers.
// ─────────────────────────────────────────────────────────────────────────

function getHost(): HostServices {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  const host = (globalThis as any).__liaisonHost as HostServices | undefined
  if (!host) {
    throw new Error(
      "@liaison/host: window.__liaisonHost is not set — kernel must call buildHostServices() at boot before any plugin dynamic-import",
    )
  }
  return host
}

function getAppName(): string {
  if (typeof __LIAISON_APP_NAME__ !== "undefined" && __LIAISON_APP_NAME__) {
    return __LIAISON_APP_NAME__
  }
  // biome-ignore lint/suspicious/noExplicitAny: test-time override
  const testName = (globalThis as any).__LIAISON_TEST_APP_NAME as string | undefined
  if (testName) return testName
  throw new Error(
    "@liaison/host: app name not available — freeze-app must substitute __LIAISON_APP_NAME__, or tests must set globalThis.__LIAISON_TEST_APP_NAME",
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Un-bound services (plugin can still call invokeTool/openConnect with an
// explicit appName if it needs to operate on another app's behalf — rare).
// ─────────────────────────────────────────────────────────────────────────

export const fetch: HostFetch = <T = unknown>(path: string, init?: RequestInit): Promise<T> =>
  getHost().fetch<T>(path, init)
export const accessToken: AccessTokenAccessor = () => getHost().accessToken()

/** Fetch a kernel file's bytes (see `HostFetchBlob`). Throws when the host
 *  predates it rather than falling back to a page-relative fetch, which is
 *  exactly the bug this exists to prevent. */
export const fetchBlob: HostFetchBlob = (path: string): Promise<Blob> => {
  const host = getHost()
  if (!host.fetchBlob) {
    return Promise.reject(new Error("@liaison/host: host.fetchBlob is not available"))
  }
  return host.fetchBlob(path)
}

/** Open a fetched file natively when the host can (see `HostOpenFile`).
 *  False when the host does not (a browser, an older host, no host): the
 *  caller then uses its browser path. */
export const openFile: HostOpenFile = async (file: Blob, filename: string): Promise<boolean> => {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  const host = (globalThis as any).__liaisonHost as HostServices | undefined
  if (!host?.openFile) return false
  return host.openFile(file, filename)
}

/**
 * In-app SPA navigation to a kernel-relative path. Falls back to a full-page
 * assign only if the host shim predates the navigate primitive.
 */
export const navigate: HostNavigate = (path: string): void => {
  const host = getHost()
  if (host.navigate) {
    host.navigate(path)
  } else {
    // No host navigate provided (host shim predates the primitive): fall back to
    // a full-page assign. Accessed structurally off globalThis so this package
    // need not depend on the DOM lib.
    const loc = (globalThis as { location?: { assign(url: string): void } }).location
    if (loc) loc.assign(path)
  }
}

/**
 * The page's path and query (`/<app>/orders?status=open`), for a view that
 * marks where the reader is (a sidebar's active row) or reads its state from
 * the route. Read it instead of `window.location`: an app whose UI runs in a
 * sandboxed frame has its frame document's location, never the page's. Read it
 * again on `popstate`, which the host fires on every route change (framed too).
 * Falls back to the window's location on a host that predates it (or none).
 */
export function currentPath(): string {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  const host = (globalThis as any).__liaisonHost as HostServices | undefined
  if (host?.currentPath) return host.currentPath()
  const loc = (globalThis as { location?: { pathname?: string; search?: string } }).location
  return loc ? `${loc.pathname ?? ""}${loc.search ?? ""}` : ""
}

// ─────────────────────────────────────────────────────────────────────────
// `app` namespace: pre-bound for the calling plugin's own name. Preferred
// shape for plugin code.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The reader's UI language, "en" when the host predates it or no host is
 * mounted (unit tests). App UIs translate their own copy against it.
 */
export function hostLocale(): string {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  const host = (globalThis as any).__liaisonHost as HostServices | undefined
  try {
    return host?.locale?.() || "en"
  } catch {
    return "en"
  }
}

/**
 * Subscribe to changes of this app's entities (`"<app>:<entity>"`, `"<app>:*"`)
 * or kernel ones (`"kernel:<entity>"`), to refetch or patch a view that loaded
 * once. The callback receives the batch of the debounce window; after a WS
 * resync it receives `[{ key: "*", action: "resync", resync: true }]` once.
 * Call it synchronously in a component body and it is disposed with the
 * component; otherwise call the returned disposer. A host without the
 * primitive (or no host, in unit tests) makes this a no-op.
 */
export function onEntityChange(
  keys: string | string[],
  cb: (events: HostEntityChangeEvent[]) => void,
  opts?: HostEntityChangeOptions,
): () => void {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  const host = (globalThis as any).__liaisonHost as HostServices | undefined
  if (!host?.onEntityChange) return () => {}
  return host.onEntityChange(getAppName(), keys, cb, opts)
}

// ─────────────────────────────────────────────────────────────────────────
// Host API 1.3: typed host calls. Each one uses the host's call when it has it
// (always in a frame, where `fetch` reaches only the app's own routes) and the
// older path otherwise, so the same app code works on every host.
// ─────────────────────────────────────────────────────────────────────────

function optionalHost(): HostServices | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: window-global lookup
  return (globalThis as any).__liaisonHost as HostServices | undefined
}

/** The org id an access token names, read without verifying it (the server does). */
function orgIdOfToken(token: string | null): string | null {
  if (!token) return null
  try {
    const part = token.split(".")[1] ?? ""
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"))
    const orgId = (JSON.parse(json) as { orgId?: unknown }).orgId
    return typeof orgId === "string" && orgId !== "" ? orgId : null
  } catch {
    return null
  }
}

/**
 * Who and where this screen is: the org (id, name, locale) and the person. Null
 * with no host or no session. On an older host only `orgId` is known (read from
 * the session token); the names are empty then.
 */
export function getContext(): HostContext | null {
  const host = optionalHost()
  if (!host) return null
  if (host.context) return host.context()
  const orgId = orgIdOfToken(host.accessToken?.() ?? null)
  if (!orgId) return null
  const locale = hostLocale()
  return { orgId, orgName: "", locale, user: { id: "", name: "", locale } }
}

export const app = {
  invokeTool: async <T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T> =>
    getHost().invokeTool<T>(getAppName(), toolName, args),
  openConnect: async (opts?: {
    connectionName?: string
    params?: Record<string, string>
  }): Promise<void> => getHost().openConnect(getAppName(), opts),
  /**
   * Open the kernel connect dialog for one of this app's connections over the
   * current page (credential form or OAuth sign-in), without leaving the
   * page. Resolves `{ connected }` when it closes, so the caller can re-probe;
   * `{ connected: false, redirected: true }` when an OAuth sign-in leaves the
   * page. Rejects when the host predates the primitive.
   */
  openConnectDialog: async (opts?: ConnectDialogOptions): Promise<ConnectDialogResult> => {
    const host = getHost()
    if (!host.openConnectDialog) {
      throw new Error("@liaison/host: host.openConnectDialog is not available")
    }
    return host.openConnectDialog(getAppName(), opts)
  },
  /**
   * Create a data resource that revalidates on the global resync bus (WS sync /
   * reconnect) and on stale tab activation — a one-line drop-in for a plain
   * `createResource(() => app.invokeTool(...))`. Invoke it synchronously inside
   * the component body so its subscriptions are owned (and disposed) by that
   * component. Delegates to the host factory (implementation lives in apps/web
   * where Solid + the tab context exist; the shared `__liaisonSolid` runtime
   * makes them one and the same at runtime).
   */
  createResource: <T = unknown>(
    fetcher: () => T | Promise<T>,
    opts?: { staleAfterMs?: number },
  ): [HostResource<T>, HostResourceActions<T>] => {
    const host = getHost()
    if (!host.createResource) {
      throw new Error(
        "@liaison/host: host.createResource is not available — kernel must provide it in buildHostServices()",
      )
    }
    return host.createResource<T>(fetcher, opts)
  },
  /**
   * Say which record this page has open in a pane, for a page that keeps one tab
   * for many records (a list beside a detail, an expanded row, a drawer). A turn
   * the person sends from the tab then names that record, so the agent knows what
   * "this" is; the tab's own id says nothing about it. `entityType` is an entity in
   * this app's manifest, and `id` returns the open record's id, or null when none
   * is on screen (mind a phone layout that hides the pane). Call it synchronously
   * in the component body: it stops with the component. A no-op on an older host.
   */
  /**
   * Open a kernel file (an id from this app's own tool results or prints, or a
   * file attached to one of its records): the host fetches it and shows it (the
   * desktop viewer, a browser tab or a download). Resolves true when the host
   * did; false on an older host, where the caller uses its own browser path.
   */
  openFile: async (fileId: string, filename: string): Promise<boolean> => {
    const host = optionalHost()
    if (!host?.framed || !host.openFileById) return false
    await host.openFileById(getAppName(), fileId, filename)
    return true
  },
  /** Whether the host opens files by id itself (`app.openFile`): inside a frame. */
  opensFiles: (): boolean => {
    const host = optionalHost()
    return Boolean(host?.framed && host.openFileById)
  },
  /** The org's document templates for one of this app's record types. */
  listDocumentTemplates: <T = HostDocumentTemplate>(entity: string): Promise<T[]> => {
    const host = getHost()
    if (host.listDocumentTemplates) {
      return host.listDocumentTemplates(getAppName(), entity) as Promise<T[]>
    }
    return host.fetch<T[]>(
      `/api/documents/templates?app=${encodeURIComponent(getAppName())}&entity=${encodeURIComponent(entity)}`,
    )
  },
  /** Print one of this app's records with these templates. */
  printDocuments: <T = HostPrintResult>(request: HostPrintRequest): Promise<T> => {
    const host = getHost()
    if (host.printDocuments) return host.printDocuments(getAppName(), request) as Promise<T>
    return host.fetch<T>("/api/documents/print", {
      method: "POST",
      body: JSON.stringify({
        app: getAppName(),
        entity: request.entity,
        recordId: request.id,
        templateIds: request.templateIds,
        ...(request.merge ? { merge: true } : {}),
      }),
    })
  },
  /** Pending approvals of this app's own tools that the person may decide. */
  listMyApprovals: async (): Promise<unknown[]> => {
    const host = getHost()
    const name = getAppName()
    if (host.listMyApprovals) return host.listMyApprovals(name)
    const rows = await host.fetch<unknown>(
      `/api/approvals?status=pending&decidableByMe=true&app=${encodeURIComponent(name)}`,
    )
    return (Array.isArray(rows) ? rows : []).filter(
      (r) =>
        typeof (r as { toolName?: unknown })?.toolName === "string" &&
        ((r as { toolName: string }).toolName as string).startsWith(`${name}:`),
    )
  },
  /**
   * Decide one of this app's pending approvals. In a frame the host asks the
   * person in its own dialog first (and rejects when they cancel); in the page,
   * or on an older host, it decides at once, as before.
   */
  decideApproval: (
    approvalId: string,
    decision: "approve" | "deny",
    payloadHash?: string,
  ): Promise<unknown> => {
    const host = getHost()
    if (host.framed && host.decideApproval) {
      return host.decideApproval(getAppName(), approvalId, decision, payloadHash)
    }
    return host.fetch(`/api/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: "POST",
      body: JSON.stringify(
        decision === "approve" && payloadHash ? { decision, payloadHash } : { decision },
      ),
    })
  },
  /**
   * Edit one of this app's pending approvals: only the fields its tool declares editable
   * change (the server refuses any other). Answers the new payload fingerprint, the one a
   * following `decideApproval(id, "approve", payloadHash)` approves.
   */
  editApproval: (
    approvalId: string,
    fields: Record<string, unknown>,
  ): Promise<HostApprovalEdit> => {
    const host = getHost()
    if (host.framed && host.editApproval) return host.editApproval(getAppName(), approvalId, fields)
    return host.fetch<HostApprovalEdit>(
      `/api/approvals/${encodeURIComponent(approvalId)}/payload`,
      {
        method: "POST",
        body: JSON.stringify({ fields }),
      },
    )
  },
  /** Whether the host confirms approval decisions itself (the app need not ask again). */
  confirmsApprovals: (): boolean => {
    const host = optionalHost()
    return Boolean(host?.framed && host.decideApproval)
  },
  /**
   * Open an https page on a host this app's manifest declares, in a new tab with
   * no opener and no referrer. Rejects when the host refuses it.
   */
  openExternal: async (url: string): Promise<void> => {
    const host = optionalHost()
    if (host?.framed && host.openExternal) return host.openExternal(getAppName(), url)
    const open = (globalThis as { open?: (u: string, t: string, f: string) => unknown }).open
    open?.(url, "_blank", "noopener,noreferrer")
  },
  /** Open another app's record (`invoicing`, `document`, id) in its own tab. */
  openRecord: (targetApp: string, entity: string, id: string): void => {
    const host = getHost()
    if (host.openRecord) {
      host.openRecord(getAppName(), targetApp, entity, id)
      return
    }
    navigate(
      `/detail/${encodeURIComponent(targetApp)}/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
    )
  },
  /** Open the approvals queue. */
  openApprovals: (): void => {
    const host = getHost()
    if (host.openApprovals) host.openApprovals()
    else navigate("/approvals")
  },
  trackOpenRecord: (entityType: string, id: () => string | null | undefined): void => {
    getHost().trackOpenRecord?.(getAppName(), entityType, id)
  },
  /** From a page's component body: the tab's label follows `label()` (null keeps the view's). */
  tabLabel: (label: () => string | null | undefined): void => {
    // A host without it (an older one, a test with no host) keeps the view's label.
    const host = optionalHost()
    if (host?.tabLabel) host.tabLabel(getAppName(), label)
  },
  /**
   * Host-driven cross-app slot-body mount. Renders another app's contributed
   * component into the caller-supplied `anchor`. The caller never receives the
   * contributor's component reference — the host owns resolution + lifecycle —
   * so this survives unchanged when iframe isolation later lands. Returns
   * `{ resolved: false, dispose: no-op }` gracefully when the host predates the
   * primitive, so callers can render their own fallback.
   */
  mountSlot: (anchor: SlotAnchor, descriptor: SlotMountDescriptor): SlotMountHandle => {
    const host = getHost()
    if (!host.mountSlot) return { resolved: false, dispose: () => {} }
    return host.mountSlot(getAppName(), anchor, descriptor)
  },
  /**
   * Mount the discussion of one of the app's records into `anchor`: one
   * conversation per record, read and written by whoever can see the record.
   * A bundle cannot import the kernel's component, so the host renders it.
   * Returns `{ resolved: false }` when the host predates it.
   */
  mountEntityDiscussion: (
    anchor: SlotAnchor,
    descriptor: EntityDiscussionMountDescriptor,
  ): SlotMountHandle => {
    const host = getHost()
    if (!host.mountEntityDiscussion) return { resolved: false, dispose: () => {} }
    return host.mountEntityDiscussion(getAppName(), anchor, descriptor)
  },
}

export {
  DEFAULT_HOST_API_RANGE,
  HOST_API_VERSION,
  SUPPORTED_HOST_API_MAJORS,
} from "./host-api-version"
export type { HostProps } from "./host-props"

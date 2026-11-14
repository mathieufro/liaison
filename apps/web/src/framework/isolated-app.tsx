// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN INSTALLED APP'S UI, IN A SANDBOXED FRAME (D11).
//
// THE RULE. Inside the desktop shell the page holds the shell's bridge, so the
// page runs only code that shipped with the client build or that the SHELL
// verified:
//
// - in-tree modules (`trustedAppExports`) render in the page as before;
// - a first-party app the server lists as signed renders in the page only from
//   the bytes the desktop shell verified against its compiled keys, served on
//   its `liaison-app:` scheme by hash, registered from the signed manifest
//   (verified-app.ts, S13); the phone verifies nothing and frames it (D7);
// - every other UI bundle the server hands out renders in a sandboxed iframe
//   (`sandbox="allow-scripts allow-forms"`: an opaque origin that reaches no
//   window of the page, and no shell bridge, whose scripts are main-frame only).
//   The frame document is the shell's own (`liaison-frame:`, app_frame.rs, its
//   own CSP: no network, no script but its runtime and the bundle); the page
//   fetches the bundle, hands it to the frame with the component to draw
//   and its plain-data props, and answers the frame's calls with the host
//   services an in-page bundle used (`@liaison/host`), bound to this app.
//
// The mobile shell holds a bridge too (Capacitor's, and the session's refresh
// token behind it), so it follows the same rule: its frame document is a file
// of the native build beside the page (`app-frame.html`, the same runtime
// under a policy of its own), and the sandbox gives it an opaque origin. The
// iOS shell answers native calls from the main frame only
// (MainViewController.swift); Android's bridge already does.
//
// In a browser tab (no shell) the page holds the user's session, so the same
// rule holds for every app that is not first-party (S16): a first-party app's
// bundle is imported into the page from the server's own origin, and any other
// one renders in the same sandboxed frame, its document served by the server
// beside the app's bundle (`/api/apps/<name>/<version>/frame`, the shells'
// document and policy, the policy as a response header). The sandbox still gives
// it an opaque origin: no session cookie, no storage, no API of its own.
//
// What an isolated app cannot do that an in-page one could: draw into the
// page itself (its icons are drawn by the host from its manifest's icon data,
// else a tile with its initial; entity previews and app hooks are not registered), mount another app's slot, open a file through the shell,
// or read the user's token.

import { appIconSvgDataUrl, isAppIconName, isReservedWebRouteSegment } from "@liaison/shared"
import {
  type Component,
  createEffect,
  createSignal,
  getOwner,
  type JSX,
  onCleanup,
  runWithOwner,
  Show,
} from "solid-js"
import { getTabType, urlToTabInfo } from "~/framework/app-registry"
import { MissingExportNotice } from "~/framework/MissingExportNotice"
import { pagePath } from "~/framework/spa-navigate"
import { APP_ICON_SET } from "~/lib/app-icon-set"
import { isNativeShell } from "~/lib/native-bridge"
import { currentLocale } from "~/modules/i18n/i18n-context"
import {
  appSettingsPath,
  SETTINGS_APPS_ROOT,
  SETTINGS_CONNECTORS_PATH,
} from "~/modules/settings/settings-aliases"
import { setOpenRecord } from "~/modules/shell/open-record"
import { useTabId } from "~/modules/shell/TabVisibilityContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import {
  appFrameUrl,
  type FrameContext,
  type FrameToHost,
  frameProps,
  type HostToFrame,
  parseAppUiBridgeMessage,
  parseFrameMessage,
} from "../app-frame/protocol"

/**
 * The mobile shell's frame document, written beside the page by the native
 * build (scripts/build-app-frame.ts `--native`, under its own policy).
 */
export const MOBILE_APP_FRAME_PATH = "/app-frame.html"

/** Exactly the sandbox an isolated app gets: scripts and forms, nothing else. */
export const ISOLATED_APP_SANDBOX = "allow-scripts allow-forms"

/**
 * The sandbox of a frame served on the app's own origin: the same, plus that
 * origin (its storage). Never for any other frame: on the page's origin or a
 * shell's, `allow-same-origin` would give the app the page.
 */
export const ORIGIN_BOUND_APP_SANDBOX = `${ISOLATED_APP_SANDBOX} allow-same-origin`

/** The origin of a frame URL served on an app's own origin, or null when it is not one. */
export function originBoundFrameOrigin(frameUrl: string, pageOrigin: string): string | null {
  try {
    const url = new URL(frameUrl)
    if (!/^https?:$/.test(url.protocol) || url.origin === pageOrigin) return null
    return url.origin
  } catch {
    return null
  }
}

/** The host services the frame's calls are answered with. */
export interface IsolatedHost {
  fetch: (path: string, init?: RequestInit) => Promise<unknown>
  invokeTool: (app: string, tool: string, args: Record<string, unknown>) => Promise<unknown>
  openConnect: (
    app: string,
    opts?: { connectionName?: string; params?: Record<string, string> },
  ) => Promise<void>
  openConnectDialog?: (
    app: string,
    opts?: { connectionName?: string; identifier?: string; fields?: string[] },
  ) => Promise<{ connected: boolean; redirected?: boolean }>
  fetchBlob?: (path: string) => Promise<Blob>
  navigate?: (path: string) => void
  onEntityChange?: (
    app: string,
    keys: string[],
    cb: (events: unknown[]) => void,
    opts?: { debounceMs?: number },
  ) => () => void
  // Host API 1.3 (framework/host-app-calls.ts).
  context?: () => FrameContext | null
  openFileById?: (app: string, fileId: string, filename: string) => Promise<void>
  listDocumentTemplates?: (app: string, entity: string) => Promise<unknown>
  printDocuments?: (
    app: string,
    request: { entity: string; id: string; templateIds: string[]; merge?: boolean },
  ) => Promise<unknown>
  listMyApprovals?: (app: string) => Promise<unknown[]>
  decideApproval?: (
    app: string,
    id: string,
    decision: "approve" | "deny",
    payloadHash?: string,
  ) => Promise<unknown>
  editApproval?: (app: string, id: string, fields: Record<string, unknown>) => Promise<unknown>
  openExternal?: (app: string, url: string) => Promise<void>
  openRecord?: (caller: string, app: string, entity: string, id: string) => void
  openApprovals?: () => void
}

/**
 * What the page knows about one frame, for the limits of its typed calls: the
 * file ids its own tool results and prints showed it (the only files it may ask
 * the host to open, besides files attached to its own records), and its
 * manifest's record types.
 */
export interface FrameCallState {
  seenFiles: Set<string>
  entities: ReadonlySet<string>
  /** Reads a file's metadata (`/api/files/<id>/metadata`): its owning app. Seam for tests. */
  fileApp?: (fileId: string) => Promise<string | null>
}

/** A fresh state for one frame. */
export function frameCallState(entities: Iterable<string> = []): FrameCallState {
  return { seenFiles: new Set(), entities: new Set(entities) }
}

const MAX_SEEN_FILES = 2_000
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

/** Remember every id-shaped string of a result (bounded), as files this frame was shown. */
export function noteSeenIds(state: FrameCallState, value: unknown, depth = 0): void {
  if (depth > 8 || state.seenFiles.size >= MAX_SEEN_FILES) return
  if (typeof value === "string") {
    if (FILE_ID.test(value)) state.seenFiles.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) noteSeenIds(state, item, depth + 1)
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value).slice(0, 200)) noteSeenIds(state, item, depth + 1)
  }
}

function kernelHost(): IsolatedHost | null {
  return ((globalThis as { __liaisonHost?: IsolatedHost }).__liaisonHost ??
    null) as IsolatedHost | null
}

/**
 * The text of every stylesheet the page can read, for the frame. Font faces
 * stay out: their files are the page's (`/assets/...`), which the frame's
 * policy (`font-src data:`) refuses, so each one only logged a violation in the
 * frame and its text fell back to the system font anyway.
 */
function pageCss(): string {
  if (typeof document === "undefined") return ""
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSFontFaceRule) continue
        parts.push(rule.cssText)
      }
    } catch {
      // A sheet from another origin keeps its rules to itself: skipped.
    }
  }
  return parts.join("\n")
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The frame's request path, when it is one of its own app's API routes (`/api/apps/<app>` and
 * below), normalized the way the browser would send it; null otherwise. An absolute URL, another
 * host, a dot segment or an encoded slash or backslash (which a server could decode into one) is
 * refused, so `../` cannot climb out of the app's routes.
 */
export function appOwnRoute(app: string, path: string): string | null {
  const url = plainInAppPath(path)
  if (!url) return null
  const own = `/api/apps/${encodeURIComponent(app)}`
  if (!isAtOrUnder(url.pathname, own)) return null
  return `${url.pathname}${url.search}`
}

/**
 * The path, parsed, when it is a plain path on this page's origin: an absolute URL, another
 * host, a dot segment or an encoded slash, backslash or dot is refused.
 */
function plainInAppPath(path: string): URL | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null
  if (/%(2f|5c|2e)/i.test(path)) return null
  let url: URL
  try {
    url = new URL(path, "http://frame.invalid")
  } catch {
    return null
  }
  if (url.origin !== "http://frame.invalid") return null
  const raw = path.split(/[?#]/, 1)[0] ?? ""
  if (raw.split("/").some((segment) => segment === "." || segment === "..")) return null
  return url
}

function isAtOrUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * The page path a frame may navigate to, or null. Only the app's own routes (`/<app>` and below,
 * and the paths of the tab types its own manifest declares elsewhere, never on a Liaison page
 * route), the detail pages of its own entities
 * (`/detail/<app>/...`), its own settings page (the bare apps settings root
 * means that page) and the connectors page;
 * never another app, another settings page or a route that acts on load. The target is the normalized path;
 * a query or hash is kept only under `/<app>`.
 */
export function frameNavigationTarget(app: string, path: string): string | null {
  const url = plainInAppPath(path)
  if (!url) return null
  const { pathname } = url
  const name = encodeURIComponent(app)
  // An app named after a Liaison page route would own that page through its prefix
  // (`/login/magic` signs in on load); the install refuses such a name, and so does this.
  if (!isReservedWebRouteSegment(app) && isAtOrUnder(pathname, `/${name}`)) {
    return `${pathname}${url.search}${url.hash}`
  }
  // A tab its manifest declares outside `/<app>` (`/kpi-catalogue/...`): the path must open one
  // of this app's own tab types, and never sit on a Liaison page route.
  const first = pathname.split("/")[1] ?? ""
  if (
    first &&
    !isReservedWebRouteSegment(first) &&
    getTabType(urlToTabInfo(pathname)?.type ?? "")?.appId === app
  ) {
    return `${pathname}${url.search}${url.hash}`
  }
  // The detail page of one of its own entities (`/detail/<app>/<entity>/<id>`).
  if (!isReservedWebRouteSegment(app) && pathname.startsWith(`/detail/${name}/`)) {
    return `${pathname}${url.search}`
  }
  // A Liaison page gets the normalized path alone: no query or hash a frame chose.
  if (isAtOrUnder(pathname, appSettingsPath(name)) || pathname === SETTINGS_CONNECTORS_PATH) {
    return pathname
  }
  // An app asking for the apps settings (an "Edit credentials" button) gets its own page,
  // never the list of every app.
  if (pathname === SETTINGS_APPS_ROOT) return appSettingsPath(name)
  return null
}

/**
 * The page path a frame is told: the whole path and query while the page is on one of this
 * app's own routes (`/<app>` and below, its own tab types, the detail pages of its entities and
 * its settings page), else "". A frame kept alive in a background tab never learns which other
 * app's page, entity or query the person is on.
 */
export function frameVisiblePath(app: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return ""
  let pathname: string
  try {
    pathname = new URL(path, "http://page.invalid").pathname
  } catch {
    return ""
  }
  const name = encodeURIComponent(app)
  const own =
    (!isReservedWebRouteSegment(app) &&
      (isAtOrUnder(pathname, `/${name}`) || pathname.startsWith(`/detail/${name}/`))) ||
    isAtOrUnder(pathname, `/settings/apps/${name}`) ||
    (!isReservedWebRouteSegment(pathname.split("/")[1] ?? "") &&
      getTabType(urlToTabInfo(pathname)?.type ?? "")?.appId === app)
  return own ? path : ""
}

/** An entity name as manifests spell them. */
const ENTITY_NAME = /^[a-zA-Z][\w-]*$/

/** The app a file is attached to, read with the person's session; null when unreadable. */
function fileAppFrom(host: IsolatedHost): (fileId: string) => Promise<string | null> {
  return async (fileId) => {
    try {
      const meta = asRecord(await host.fetch(`/api/files/${encodeURIComponent(fileId)}/metadata`))
      return typeof meta.app === "string" ? meta.app : null
    } catch {
      return null
    }
  }
}

export async function answerFrameCall(
  app: string,
  method: string,
  args: unknown[],
  host: IsolatedHost,
  /** The tab this frame sits in, the one its page's open record belongs to. */
  tabId?: string,
  /** This frame's limits for the typed calls; a fresh, empty one when absent. */
  state: FrameCallState = frameCallState(),
): Promise<unknown> {
  switch (method) {
    case "setOpenRecord": {
      const [entityType, id] = args
      if (typeof entityType !== "string" || !ENTITY_NAME.test(entityType)) {
        throw new Error("setOpenRecord: an entity name of this app is required")
      }
      if (id !== null && typeof id !== "string")
        throw new Error("setOpenRecord: id must be a string")
      if (tabId) setOpenRecord(tabId, id ? { tabType: `${app}:${entityType}`, entityId: id } : null)
      return null
    }
    case "fetch": {
      const [path, init] = args
      if (typeof path !== "string") throw new Error("fetch: a path is required")
      // The frame reaches its own app's routes only, never the rest of the API the person's
      // session could reach.
      const own = appOwnRoute(app, path)
      if (!own) throw new Error(`fetch: only this app's own routes (/api/apps/${app}/...)`)
      const options = asRecord(init)
      return host.fetch(own, {
        ...(typeof options.method === "string" ? { method: options.method } : {}),
        ...(typeof options.body === "string" ? { body: options.body } : {}),
      })
    }
    case "invokeTool": {
      const [tool, toolArgs] = args
      if (typeof tool !== "string") throw new Error("invokeTool: a tool name is required")
      const result = await host.invokeTool(app, tool, asRecord(toolArgs))
      noteSeenIds(state, result)
      return result
    }
    case "openFile": {
      const [fileId, filename] = args
      if (typeof fileId !== "string" || !FILE_ID.test(fileId) || !host.openFileById) {
        throw new Error("openFile: a file id is required")
      }
      // Only a file this frame was shown, or one attached to this app's own records.
      if (!state.seenFiles.has(fileId)) {
        const owner = await (state.fileApp ?? fileAppFrom(host))(fileId)
        if (owner !== app) throw new Error("openFile: not a file of this app")
      }
      await host.openFileById(app, fileId, typeof filename === "string" ? filename : "document")
      return null
    }
    case "listDocumentTemplates": {
      const [entity] = args
      if (
        typeof entity !== "string" ||
        !state.entities.has(entity) ||
        !host.listDocumentTemplates
      ) {
        throw new Error("listDocumentTemplates: one of this app's record types is required")
      }
      return host.listDocumentTemplates(app, entity)
    }
    case "printDocuments": {
      const request = asRecord(args[0])
      const { entity, id, templateIds, merge } = request
      if (
        typeof entity !== "string" ||
        !state.entities.has(entity) ||
        typeof id !== "string" ||
        !Array.isArray(templateIds) ||
        !templateIds.every((t) => typeof t === "string") ||
        !host.printDocuments
      ) {
        throw new Error("printDocuments: one of this app's records and template ids are required")
      }
      const result = await host.printDocuments(app, {
        entity,
        id,
        templateIds: templateIds as string[],
        ...(merge === true ? { merge: true } : {}),
      })
      // The printed files are this frame's to open.
      noteSeenIds(state, result)
      return result
    }
    case "listMyApprovals": {
      if (!host.listMyApprovals) throw new Error("listMyApprovals unavailable")
      const rows = await host.listMyApprovals(app)
      return rows.filter(
        (row) =>
          typeof (row as { toolName?: unknown })?.toolName === "string" &&
          (row as { toolName: string }).toolName.startsWith(`${app}:`),
      )
    }
    case "decideApproval": {
      const [id, decision, payloadHash] = args
      if (
        typeof id !== "string" ||
        (decision !== "approve" && decision !== "deny") ||
        !host.decideApproval
      ) {
        throw new Error("decideApproval: an approval id and approve or deny are required")
      }
      // The host checks the approval is this app's and asks the person itself.
      return host.decideApproval(
        app,
        id,
        decision,
        typeof payloadHash === "string" ? payloadHash : undefined,
      )
    }
    case "editApproval": {
      const [id, fields] = args
      if (
        typeof id !== "string" ||
        !fields ||
        typeof fields !== "object" ||
        Array.isArray(fields) ||
        !host.editApproval
      ) {
        throw new Error("editApproval: an approval id and the fields to change are required")
      }
      // The host checks the approval is this app's; the server checks each field is editable.
      return host.editApproval(app, id, fields as Record<string, unknown>)
    }
    case "openExternal": {
      const [url] = args
      if (typeof url !== "string" || !host.openExternal)
        throw new Error("openExternal: a URL is required")
      await host.openExternal(app, url)
      return null
    }
    case "openRecord": {
      const [target, entity, id] = args
      if (
        typeof target !== "string" ||
        typeof entity !== "string" ||
        typeof id !== "string" ||
        !host.openRecord
      ) {
        throw new Error("openRecord: an app, an entity and a record id are required")
      }
      host.openRecord(app, target, entity, id)
      return null
    }
    case "openApprovals": {
      host.openApprovals?.()
      return null
    }
    case "openConnect": {
      const options = asRecord(args[0])
      const params = asRecord(options.params)
      return host.openConnect(app, {
        ...(typeof options.connectionName === "string"
          ? { connectionName: options.connectionName }
          : {}),
        params: Object.fromEntries(
          Object.entries(params).filter((entry): entry is [string, string] => {
            return typeof entry[1] === "string"
          }),
        ),
      })
    }
    case "openConnectDialog": {
      const options = asRecord(args[0])
      const { connectionName, identifier, fields } = options
      if (connectionName !== undefined && typeof connectionName !== "string") {
        throw new Error("openConnectDialog: connectionName must be a string")
      }
      if (identifier !== undefined && typeof identifier !== "string") {
        throw new Error("openConnectDialog: identifier must be a string")
      }
      if (
        fields !== undefined &&
        !(Array.isArray(fields) && fields.every((f) => typeof f === "string"))
      ) {
        throw new Error("openConnectDialog: fields must be a list of field names")
      }
      if (!host.openConnectDialog) throw new Error("openConnectDialog unavailable")
      return host.openConnectDialog(app, {
        ...(connectionName === undefined ? {} : { connectionName }),
        ...(identifier === undefined ? {} : { identifier }),
        ...(fields === undefined ? {} : { fields: fields as string[] }),
      })
    }
    case "fetchBlob": {
      const [path] = args
      if (typeof path !== "string" || !host.fetchBlob) throw new Error("fetchBlob unavailable")
      const own = appOwnRoute(app, path)
      if (!own) throw new Error(`fetchBlob: only this app's own routes (/api/apps/${app}/...)`)
      return host.fetchBlob(own)
    }
    case "navigate": {
      const [path] = args
      const target = typeof path === "string" ? frameNavigationTarget(app, path) : null
      if (!target) {
        throw new Error(
          `navigate: not allowed (only /${app}/..., this app's tabs, /detail/${app}/..., /settings/apps/${app}, /settings/connectors)`,
        )
      }
      host.navigate?.(target)
      return null
    }
    case "openTab": {
      const [type, entityId, label] = args
      if (typeof type !== "string" || typeof entityId !== "string" || !getTabType(type)) {
        throw new Error("openTab: a registered tab type and an entity are required")
      }
      openTab({ type, entityId, label: typeof label === "string" ? label : entityId })
      return null
    }
    case "toast": {
      const [message, variant] = args
      if (typeof message !== "string") return null
      const type = variant === "success" || variant === "error" ? variant : "info"
      addToast({ type, message: message.slice(0, 500) })
      return null
    }
    default:
      throw new Error("unsupported")
  }
}

export interface IsolatedViewOptions {
  app: string
  exportName: string
  /** The bundle's absolute URL on the bound server (already origin-checked). */
  bundleUrl: string
  /** The shell's frame document (`appFrameUrl()`). */
  frameUrl: string
  /**
   * The frame is served on the app's own origin (LIAISON_APP_FRAME_ORIGIN_TEMPLATE):
   * the iframe keeps that origin (`allow-same-origin`, emitted only then), the page
   * posts to exactly that origin and hears only it.
   */
  originBound?: boolean
  /** The app manifest's record types, for its typed calls' limits. */
  entities?: readonly string[]
  /**
   * Fresh bundle and frame URLs (new tokens, from a new app list), asked for at
   * mount when the bundle URL's token is about to expire: the URLs are fixed
   * when the app registers, and a tab opened an hour later would 404.
   */
  freshUrls?: () => Promise<{ bundleUrl: string; frameUrl: string } | null>
  /** Seams for tests. */
  host?: () => IsolatedHost | null
  loadSource?: (url: string) => Promise<string>
}

/** How much life a bundle token must have left to be used as is. */
const TOKEN_MARGIN_MS = 5 * 60_000

/**
 * Whether the URL's bundle token (`?t=`, a JWT the app list issued) expires
 * within the margin. Read only to decide whether to ask for a new one: the
 * server verifies it. A URL without a token (a first-party bundle) never does.
 */
export function bundleTokenExpiresSoon(url: string, now = Date.now()): boolean {
  let token: string | null
  try {
    token = new URL(url).searchParams.get("t")
  } catch {
    return false
  }
  if (!token) return false
  try {
    const payload = token.split(".")[1] ?? ""
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    const exp = (JSON.parse(json) as { exp?: unknown }).exp
    return typeof exp === "number" && exp * 1000 - now < TOKEN_MARGIN_MS
  } catch {
    // Not a token this page can read: used as is, the server decides.
    return false
  }
}

async function fetchBundleSource(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the app's UI bundle answered ${response.status}`)
  return response.text()
}

/** The component the registry gets for one declared export of an isolated app. */
export function isolatedView(options: IsolatedViewOptions) {
  return function IsolatedAppView(props: Record<string, unknown>): JSX.Element {
    const [height, setHeight] = createSignal<number | null>(null)
    const [missing, setMissing] = createSignal(false)
    const [stopped, setStopped] = createSignal(false)
    const host = options.host ?? kernelHost
    const tabId = useTabId()
    let frame: HTMLIFrameElement | undefined
    const subscriptions = new Map<number, () => void>()
    const callState = frameCallState(options.entities ?? [])
    // A frame on the app's own origin: that exact origin, both ways.
    const boundOrigin = options.originBound
      ? originBoundFrameOrigin(options.frameUrl, window.location.origin)
      : null
    const given = { bundleUrl: options.bundleUrl, frameUrl: options.frameUrl }
    // The URLs as registered, or fresh ones when their token is about to expire.
    // (A frame on the app's own origin carries a token of its own, which counts too.)
    const stale =
      options.freshUrls !== undefined &&
      (bundleTokenExpiresSoon(options.bundleUrl) ||
        (options.originBound === true && bundleTokenExpiresSoon(options.frameUrl)))
    const [urls, setUrls] = createSignal<{ bundleUrl: string; frameUrl: string } | null>(
      stale ? null : given,
    )
    const resolved = stale
      ? (options.freshUrls as NonNullable<IsolatedViewOptions["freshUrls"]>)().then(
          (fresh) => fresh ?? given,
          () => given,
        )
      : Promise.resolve(given)
    if (stale) void resolved.then(setUrls)
    const source = resolved.then((u) => (options.loadSource ?? fetchBundleSource)(u.bundleUrl))
    const owner = getOwner()

    const post = (message: HostToFrame) => {
      if (stopped()) return
      // A frame on the app's own origin gets exactly that origin. An opaque
      // frame's origin ("null") cannot be named; what it receives is its own
      // app's data, and only on its own calls, and only while the frame still
      // holds the document it was given (below).
      frame?.contentWindow?.postMessage(message, boundOrigin ?? "*")
    }

    // The frame's first load is its own document. A second one means the app
    // sent its window elsewhere (`location.href = ...`): whatever is there now
    // is not this app, and a post to it would carry the app's data out. The
    // frame is torn down for good.
    let loads = 0
    const onLoad = () => {
      loads += 1
      if (loads < 2 || stopped()) return
      setStopped(true)
      window.removeEventListener("message", onMessage)
      for (const stop of subscriptions.values()) stop()
      subscriptions.clear()
      console.error(
        `Isolated app "${options.app}": its frame navigated away from its document; the app was stopped`,
      )
    }

    const onMessage = (event: MessageEvent) => {
      // Only this frame's own window is heard: another frame, the page itself
      // or a window this one opened is not this app.
      if (stopped() || !frame || event.source !== frame.contentWindow) return
      if (boundOrigin !== null && event.origin !== boundOrigin) return
      const services = host()
      const bridged = parseAppUiBridgeMessage(event.data)
      if (bridged) {
        if (services) {
          answerFrameCall(
            options.app,
            bridged.method,
            bridged.args,
            services,
            tabId,
            callState,
          ).catch(() => {})
        }
        return
      }
      const message: FrameToHost | null = parseFrameMessage(event.data)
      if (!message) return
      switch (message.kind) {
        case "ready":
          void source.then(
            (text) =>
              post({
                kind: "init",
                app: options.app,
                exportName: options.exportName,
                source: text,
                props: frameProps(props),
                locale: currentLocale(),
                theme: document.documentElement.getAttribute("data-theme"),
                css: pageCss(),
                hostOrigin: window.location.origin,
                path: frameVisiblePath(options.app, pagePath()),
                context: services?.context?.() ?? null,
              }),
            (error: unknown) =>
              console.warn(`Isolated app "${options.app}": its UI bundle did not load`, error),
          )
          return
        case "unsupported":
          post({
            kind: "result",
            id: message.id,
            ok: false,
            error: "unsupported",
            method: message.method,
          })
          return
        case "call": {
          const { id } = message
          if (!services) {
            post({ kind: "result", id, ok: false, error: "no host services" })
            return
          }
          answerFrameCall(
            options.app,
            message.method,
            message.args,
            services,
            tabId,
            callState,
          ).then(
            (value) => post({ kind: "result", id, ok: true, value }),
            (error: unknown) =>
              post({
                kind: "result",
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          )
          return
        }
        case "subscribe": {
          if (!services?.onEntityChange || subscriptions.has(message.subscription)) return
          const subscription = message.subscription
          const stop = services.onEntityChange(
            options.app,
            message.keys,
            (events) => post({ kind: "entityChange", subscription, events }),
            message.debounceMs !== undefined ? { debounceMs: message.debounceMs } : undefined,
          )
          subscriptions.set(subscription, stop)
          return
        }
        case "unsubscribe":
          subscriptions.get(message.subscription)?.()
          subscriptions.delete(message.subscription)
          return
        case "height":
          setHeight(Math.max(0, Math.min(message.height, 20_000)))
          return
        case "missingExport":
          console.error(
            `Isolated app "${options.app}": its UI bundle does not export "${options.exportName}"`,
          )
          setMissing(true)
          return
      }
    }

    window.addEventListener("message", onMessage)
    onCleanup(() => {
      if (tabId) setOpenRecord(tabId, null)
      window.removeEventListener("message", onMessage)
      for (const stop of subscriptions.values()) stop()
      subscriptions.clear()
    })
    // Props and language follow the page after the first draw.
    if (owner) {
      runWithOwner(owner, () => {
        createEffect(() => post({ kind: "props", props: frameProps(props) }))
        createEffect(() => post({ kind: "locale", locale: currentLocale() }))
        // The frame's own location is its document's: it learns the page's from here, and
        // only while the page is on one of this app's own routes.
        createEffect(() => post({ kind: "path", path: frameVisiblePath(options.app, pagePath()) }))
      })
    }

    return (
      <Show when={!missing()} fallback={<MissingExportNotice name={options.exportName} />}>
        <Show
          when={!stopped() && urls()}
          fallback={
            <div data-testid={stopped() ? "isolated-app-stopped" : "isolated-app-pending"} />
          }
        >
          {(current) => (
            <iframe
              ref={(el) => {
                frame = el
              }}
              data-testid="isolated-app-frame"
              data-app={options.app}
              title={options.app}
              src={current().frameUrl}
              sandbox={boundOrigin !== null ? ORIGIN_BOUND_APP_SANDBOX : ISOLATED_APP_SANDBOX}
              referrerpolicy="no-referrer"
              onLoad={onLoad}
              style={{
                border: "0",
                width: "100%",
                height: "100%",
                ...(height() !== null ? { "min-height": `${height()}px` } : {}),
              }}
            />
          )}
        </Show>
      </Show>
    )
  }
}

/** The name an isolated app is known by: its rail label, display name, else its name. */
export function isolatedAppName(manifest: any): string {
  for (const candidate of [
    manifest?.views?.activityBar?.label,
    manifest?.displayName,
    manifest?.name,
  ]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return "App"
}

/**
 * The icon of an isolated app. Its own icon component is code of the app's,
 * which never runs in the page, so the host draws it from the manifest's data
 * (S1): `iconSvg`, once it passes the same allowlist the server applied, is
 * shown only as an `<img>` source, never put in the page as markup; else
 * `iconName` is drawn from Liaison's icon set; else a rounded tile carrying the
 * app's initial. Each at the size the caller asks for, named for screen readers.
 */
/** Does the manifest declare its icon as data (`iconSvg` or `iconName`) the host can draw? */
export function declaresAppIcon(manifest: any): boolean {
  return appIconSvgDataUrl(manifest?.iconSvg) !== null || isAppIconName(manifest?.iconName)
}

export function isolatedAppIcon(manifest: any): Component<{ size?: number }> {
  const name = isolatedAppName(manifest)
  const svgSrc = appIconSvgDataUrl(manifest?.iconSvg)
  // An icon drawn in `currentColor` asks for the text colour around it (the rail tints each
  // app). An `<img>` cannot inherit it, so such a drawing is the mask of a box painted in it.
  if (svgSrc && /currentColor/i.test(manifest.iconSvg)) {
    return (props) => {
      const size = () => `${props.size ?? 16}px`
      return (
        <span
          role="img"
          aria-label={name}
          data-testid="isolated-app-icon"
          style={{
            display: "inline-block",
            "flex-shrink": "0",
            width: size(),
            height: size(),
            "background-color": "currentColor",
            "mask-image": `url("${svgSrc}")`,
            "-webkit-mask-image": `url("${svgSrc}")`,
            "mask-size": "contain",
            "-webkit-mask-size": "contain",
            "mask-repeat": "no-repeat",
            "-webkit-mask-repeat": "no-repeat",
            "mask-position": "center",
            "-webkit-mask-position": "center",
          }}
        />
      )
    }
  }
  if (svgSrc) {
    return (props) => (
      <img
        src={svgSrc}
        width={props.size ?? 16}
        height={props.size ?? 16}
        alt={name}
        draggable={false}
        data-testid="isolated-app-icon"
      />
    )
  }
  const iconName = manifest?.iconName
  if (isAppIconName(iconName)) {
    const Named = APP_ICON_SET[iconName]
    return (props) => (
      <Named
        size={props.size ?? 16}
        role="img"
        aria-label={name}
        data-icon-name={iconName}
        data-testid="isolated-app-icon"
      />
    )
  }
  const initial = (Array.from(name)[0] ?? "A").toLocaleUpperCase()
  return (props) => {
    const size = () => props.size ?? 16
    return (
      <svg
        viewBox="0 0 24 24"
        width={size()}
        height={size()}
        role="img"
        aria-label={name}
        data-testid="isolated-app-icon"
      >
        <rect
          x="2.75"
          y="2.75"
          width="18.5"
          height="18.5"
          rx="5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <text
          x="12"
          y="12"
          dy="0.36em"
          text-anchor="middle"
          font-size="11"
          font-weight="600"
          fill="currentColor"
          font-family="inherit"
        >
          {initial}
        </text>
      </svg>
    )
  }
}

/** Every name the manifest uses as an icon. */
export function iconNames(manifest: any): Set<string> {
  const names = new Set<string>()
  const views = manifest?.views ?? {}
  if (typeof views.activityBar?.icon === "string") names.add(views.activityBar.icon)
  for (const group of [views.tabTypes, views.panels, views.detail]) {
    for (const reg of Object.values<any>(group ?? {})) {
      if (typeof reg?.icon === "string") names.add(reg.icon)
    }
  }
  return names
}

/** Every name the manifest uses as a tab label resolver (a function, not a view). */
function labelResolverNames(manifest: any): Set<string> {
  const names = new Set<string>()
  for (const reg of Object.values<any>(manifest?.views?.tabTypes ?? {})) {
    if (typeof reg?.resolveLabel === "string") names.add(reg.resolveLabel)
  }
  return names
}

/**
 * The export bag the registry reads for an isolated app: every view it names
 * is the frame, every icon the one drawn from its manifest (isolatedAppIcon), every label resolver one that
 * keeps the manifest's label. No code of the app's runs in the page.
 */
export function isolatedAppExports(
  manifest: any,
  options: Omit<IsolatedViewOptions, "exportName">,
): Record<string, unknown> {
  const icons = iconNames(manifest)
  const icon = isolatedAppIcon(manifest)
  const resolvers = labelResolverNames(manifest)
  const views = new Map<string, unknown>()
  return new Proxy({} as Record<string, unknown>, {
    has: (_target, name) => typeof name === "string",
    get: (_target, name) => {
      if (typeof name !== "string") return undefined
      // Not a promise: the bag is awaited as a module would never be.
      if (name === "then") return undefined
      if (icons.has(name)) return icon
      if (resolvers.has(name)) return () => undefined
      if (name === "registerEntityPreviews" || name === "registerAppHooks") return undefined
      let view = views.get(name)
      if (!view) {
        view = isolatedView({ ...options, exportName: name })
        views.set(name, view)
      }
      return view
    },
  })
}

/**
 * A browser tab's frame document for one outside app: the server serves it
 * beside the app's bundle (`.../<name>/<version>/frame`), under the bundle URL's
 * token. Null for a bundle URL of any other shape.
 */
export function browserAppFrameUrl(bundleUrl: URL): string | null {
  const dir = /^(\/api\/apps\/[a-z][a-z0-9-]*\/[^/]+\/)ui\.js$/.exec(bundleUrl.pathname)?.[1]
  if (!dir) return null
  const frame = new URL(bundleUrl.href)
  frame.pathname = `${dir}frame`
  frame.hash = ""
  return frame.href
}

/** The shell's frame document, or null where apps are not isolated. */
export function isolatedFrameUrl(): string | null {
  const shellFrame = appFrameUrl()
  if (shellFrame) return shellFrame
  // The mobile shell ships the frame document beside the page; the sandbox
  // still gives the frame an opaque origin of its own.
  if (isNativeShell() && typeof window !== "undefined") {
    return new URL(MOBILE_APP_FRAME_PATH, window.location.href).href
  }
  return null
}

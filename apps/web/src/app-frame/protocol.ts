// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MESSAGES BETWEEN AN ISOLATED APP'S FRAME AND THE PAGE.
//
// A frame served on an app's own origin (LIAISON_APP_FRAME_ORIGIN_TEMPLATE) and its
// page talk with exact target origins both ways: the page posts to the frame's
// origin and hears only it; the frame posts to the parent origin its server
// baked into the document and drops any other.
//
// Inside the desktop shell the page holds the shell's bridge (local sessions,
// files, the node). An installed app's UI bundle that did not ship with the
// client build therefore never runs in the page: it runs in a sandboxed iframe (`sandbox="allow-scripts allow-forms"`, an opaque origin,
// no shell bridge), and reaches Liaison only through these messages, which the
// page answers with the same host services a bundle in the page used
// (`@liaison/host`): the API under the user's session, the app's own tools,
// connection flows, in-app navigation, entity changes, a toast.
//
// Every message is a plain object (structured clone), checked by shape on
// arrival; anything else is dropped. A call to a method this page does not
// offer (a frame built against a newer host) keeps its id and is answered
// `{ ok: false, error: "unsupported", method }`, so the frame never waits.

/** The services an isolated app may call, and nothing else. */
export const FRAME_METHODS = [
  "fetch",
  "invokeTool",
  "openConnect",
  "openConnectDialog",
  "fetchBlob",
  "navigate",
  "openTab",
  "toast",
  "setOpenRecord",
  // Host API 1.3: typed calls answered by the page for this app only
  // (framework/host-app-calls.ts), so the frame never needs a kernel route.
  "openFile",
  "listDocumentTemplates",
  "printDocuments",
  "listMyApprovals",
  "decideApproval",
  "editApproval",
  "openExternal",
  "openRecord",
  "openApprovals",
] as const
export type FrameMethod = (typeof FRAME_METHODS)[number]

/**
 * The global a shell that isolates installed apps publishes before the page
 * loads: the URL of its frame document (the desktop shell's own
 * `liaison-frame:` scheme, src-tauri/src/app_frame.rs). Absent, there is no
 * frame to run an app in, and the page behaves as before.
 */
export const APP_FRAME_URL_GLOBAL = "__LIAISON_APP_FRAME_URL__"

/** The frame document's URL, or null when this shell publishes none. */
export function appFrameUrl(): string | null {
  const raw = (globalThis as Record<string, unknown>)[APP_FRAME_URL_GLOBAL]
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    // The shell's own frame scheme, never a web origin.
    return url.protocol === "liaison-frame:" || url.hostname === "liaison-frame.localhost"
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Page -> frame. */
export type HostToFrame =
  | {
      kind: "init"
      app: string
      exportName: string
      /** The UI bundle's source, fetched by the page from the bound server. */
      source: string
      props: Record<string, FrameProp>
      locale: string
      theme: string | null
      /** The page's stylesheets, so the app looks like the rest of Liaison. */
      css: string
      /** The page's origin, for an app that posts to it with a concrete
       *  target origin (`@liaison/app-ui` `createIframeBridge`). */
      hostOrigin: string
      /** The page's path and query (`/<app>/orders?status=open`), for an app that
       *  marks where the reader is (host API 1.1). Absent from an older page. */
      path?: string
      /** Org and person, never a token (host API 1.3, `getContext()`). */
      context?: FrameContext | null
    }
  | { kind: "props"; props: Record<string, FrameProp> }
  /** The page moved to another route (host API 1.1). */
  | { kind: "path"; path: string }
  | { kind: "locale"; locale: string }
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: string; method?: string }
  | { kind: "entityChange"; subscription: number; events: unknown[] }

/** Frame -> page. */
export type FrameToHost =
  | { kind: "ready" }
  | { kind: "call"; id: number; method: FrameMethod; args: unknown[] }
  /** A call to a method outside `FRAME_METHODS`: answered as unsupported, never run. */
  | { kind: "unsupported"; id: number; method: string }
  | { kind: "subscribe"; subscription: number; keys: string[]; debounceMs?: number }
  | { kind: "unsubscribe"; subscription: number }
  | { kind: "height"; height: number }
  /** The bundle has no such export: the page shows its own notice instead of the frame. */
  | { kind: "missingExport" }

/** Who and where the frame's app is (host API 1.3): ids, names, locale; never a token. */
export interface FrameContext {
  orgId: string
  orgName: string
  locale: string
  user: { id: string; name: string; locale: string }
}

/** A prop that crosses the frame: plain data only, never a function. */
export type FrameProp = string | number | boolean | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The frame's message, or null when it is not one of ours. */
export function parseFrameMessage(data: unknown): FrameToHost | null {
  if (!isRecord(data) || typeof data.kind !== "string") return null
  switch (data.kind) {
    case "ready":
      return { kind: "ready" }
    case "missingExport":
      return { kind: "missingExport" }
    case "call": {
      if (
        typeof data.id !== "number" ||
        !Number.isSafeInteger(data.id) ||
        typeof data.method !== "string" ||
        !Array.isArray(data.args)
      ) {
        return null
      }
      if (!(FRAME_METHODS as readonly string[]).includes(data.method)) {
        return { kind: "unsupported", id: data.id, method: data.method.slice(0, 100) }
      }
      return { kind: "call", id: data.id, method: data.method as FrameMethod, args: data.args }
    }
    case "subscribe":
      if (
        typeof data.subscription === "number" &&
        Array.isArray(data.keys) &&
        data.keys.every((k) => typeof k === "string")
      ) {
        return {
          kind: "subscribe",
          subscription: data.subscription,
          keys: data.keys as string[],
          ...(typeof data.debounceMs === "number" ? { debounceMs: data.debounceMs } : {}),
        }
      }
      return null
    case "unsubscribe":
      return typeof data.subscription === "number"
        ? { kind: "unsubscribe", subscription: data.subscription }
        : null
    case "height":
      return typeof data.height === "number" && Number.isFinite(data.height)
        ? { kind: "height", height: data.height }
        : null
    default:
      return null
  }
}

/**
 * The `@liaison/app-ui` iframe bridge's own message (`ctx-iframe.ts`): a JSON
 * string `{ type, payload }`, answered by nothing. Read as the matching call.
 */
export function parseAppUiBridgeMessage(
  data: unknown,
): { method: FrameMethod; args: unknown[] } | null {
  if (typeof data !== "string" || data.length > 10_000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return null
  const payload = parsed.payload
  if (parsed.type === "toast") return { method: "toast", args: [payload.message, payload.variant] }
  if (parsed.type === "openTab") {
    return { method: "openTab", args: [payload.tabType, payload.entityId, payload.label] }
  }
  return null
}

/** The plain-data props of a component, for the frame. */
export function frameProps(props: Record<string, unknown>): Record<string, FrameProp> {
  const out: Record<string, FrameProp> = {}
  for (const key of Object.keys(props)) {
    const value = props[key]
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value
    }
  }
  return out
}

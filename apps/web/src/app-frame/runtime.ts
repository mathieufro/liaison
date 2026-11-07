// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RUNTIME INSIDE AN ISOLATED APP'S FRAME (`framework/isolated-app.tsx`).
//
// Built into one classic script (`scripts/build-app-frame.ts`,
// `dist/app-frame-runtime.js`) that the desktop shell inlines, under a
// per-response nonce, into the frame document it serves on its own scheme
// (apps/desktop/src-tauri/src/app_frame.rs). It gives the app's UI bundle what an in-page bundle
// had, without the page:
//
// - its own Solid runtime, behind the bare specifiers `solid-js`,
//   `solid-js/web`, `solid-js/store` (an import map onto blob shims, the frame's
//   counterpart of apps/web/public/_app-runtime/);
// - `globalThis.__liaisonHost`, the `@liaison/host` services, each one a
//   message to the page, which answers it for this app only (`protocol.ts`);
// - the component the page asked for, drawn with the props it sent;
// - the page's path (`currentPath`), and in-app links that move the page, not
//   the frame: a plain click on `<a href="/...">` and an app's own
//   `history.pushState("/...")` become the host's `navigate`, so the frame never
//   leaves its document (the page stops a frame that does).
//
// The frame has no token, no network of its own (`connect-src 'none'`) and no
// shell bridge: everything goes through the page's answer.

import * as solid from "solid-js"
import { createComponent, createEffect, createResource, createSignal } from "solid-js"
import * as solidStore from "solid-js/store"
import { createStore, reconcile } from "solid-js/store"
import * as solidWeb from "solid-js/web"
import { render } from "solid-js/web"
import type { FrameMethod, FrameProp, FrameToHost, HostToFrame } from "./protocol"

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** A module that re-exports one namespace from a global, as a blob URL. */
function shimUrl(global: string, namespace: Record<string, unknown>): string {
  const lines = [`const m = globalThis.${global};`]
  for (const key of Object.keys(namespace)) {
    if (key !== "default" && IDENTIFIER.test(key)) lines.push(`export const ${key} = m.${key};`)
  }
  return URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/javascript" }))
}

/** A path on the page's own origin: `/...`, never `//host/...`. */
function isPagePath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//")
}

/**
 * The page path a click follows, or null: the nearest link around the click
 * target, opening in this browsing context, not a download, its `href` a page path.
 */
function pageLinkOf(event: MouseEvent): string | null {
  for (const node of event.composedPath()) {
    const el = node as Element
    if (typeof el.getAttribute !== "function" || el.localName !== "a") continue
    if (!el.hasAttribute("href")) return null
    const target = el.getAttribute("target")
    if ((target && target !== "_self") || el.hasAttribute("download")) return null
    const href = el.getAttribute("href")
    return isPagePath(href) ? href : null
  }
  return null
}

export function startFrameRuntime(win: Window & typeof globalThis = window): void {
  const parent = win.parent
  const send = (message: FrameToHost) => parent.postMessage(message, "*")
  const pending = new Map<number, Pending>()
  const changeListeners = new Map<number, (events: unknown[]) => void>()
  let nextId = 1
  const [locale, setLocale] = createSignal("en")
  // The page's path and query, which the page sends on init and on each route change.
  const [path, setPath] = createSignal("")
  const [props, setProps] = createStore<Record<string, FrameProp>>({})

  const call = (method: FrameMethod, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ kind: "call", id, method, args })
    })

  const host = {
    fetch: (path: string, init?: { method?: string; body?: unknown }) =>
      call("fetch", [
        path,
        init
          ? {
              ...(init.method ? { method: init.method } : {}),
              ...(typeof init.body === "string" ? { body: init.body } : {}),
            }
          : undefined,
      ]),
    invokeTool: (_app: string, tool: string, args: Record<string, unknown>) =>
      call("invokeTool", [tool, args]),
    openConnect: async (
      _app: string,
      opts?: { connectionName?: string; params?: Record<string, string> },
    ) => {
      await call("openConnect", [opts ?? {}])
    },
    openConnectDialog: (_app: string, opts?: { connectionName?: string }) =>
      call("openConnectDialog", [opts ?? {}]),
    // The frame never holds the user's token.
    accessToken: () => null,
    fetchBlob: (path: string) => call("fetchBlob", [path]),
    navigate: (target: string) => {
      void call("navigate", [target]).catch(() => {})
    },
    currentPath: () => path(),
    locale: () => locale(),
    // The page keeps the record for the tab this frame sits in, and drops it when
    // the frame goes away with its tab.
    trackOpenRecord: (_app: string, entityType: string, id: () => string | null | undefined) => {
      createEffect(() => {
        void call("setOpenRecord", [entityType, id() ?? null]).catch(() => {})
      })
    },
    createResource: <T>(fetcher: () => T | Promise<T>) => createResource(fetcher),
    mountSlot: () => ({ resolved: false, dispose: () => {} }),
    // An isolated frame has no kernel tree to render the discussion in: the caller's fallback shows.
    mountEntityDiscussion: () => ({ resolved: false, dispose: () => {} }),
    // A browser path, not the shell's: an isolated app opens no file natively.
    openFile: async () => false,
    onEntityChange: (
      _app: string,
      keys: string | string[],
      cb: (events: unknown[]) => void,
      opts?: { debounceMs?: number },
    ) => {
      const subscription = nextId++
      changeListeners.set(subscription, cb)
      send({
        kind: "subscribe",
        subscription,
        keys: Array.isArray(keys) ? keys : [keys],
        ...(opts?.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
      })
      return () => {
        changeListeners.delete(subscription)
        send({ kind: "unsubscribe", subscription })
      }
    },
  }

  // An in-app link moves the page. Followed in the frame it would load the
  // frame's own origin at that path (not this app's document), and the page
  // stops a frame that loads a second document. Heard on the window, after the
  // app's own handlers (delegated on the document): a click the app handled
  // itself is left to it, and so is anything a plain left click on a page path is not.
  win.addEventListener("click", (event: Event) => {
    const click = event as MouseEvent
    if (click.defaultPrevented || click.button !== 0) return
    if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return
    const href = pageLinkOf(click)
    if (href === null) return
    click.preventDefault()
    host.navigate(href)
  })

  // An app that moves the URL itself (`history.pushState(state, "", "/<app>/...")`,
  // as a filter does in the page) moves the page too; the frame's own document URL
  // never changes. Anything but a page path is the frame's own history.
  const history = win.history as History | undefined
  if (history) {
    for (const name of ["pushState", "replaceState"] as const) {
      const original = history[name].bind(history)
      history[name] = (...args: Parameters<History["pushState"]>) => {
        const url = args[2]
        if (isPagePath(url)) {
          host.navigate(url)
          return
        }
        original(...args)
      }
    }
  }

  const g = win as unknown as Record<string, unknown>
  g.__liaisonSolid = solid
  g.__liaisonSolidWeb = solidWeb
  g.__liaisonSolidStore = solidStore
  g.__liaisonHost = host

  // The import map goes in before any module is imported, under the nonce the
  // server gave this document's own script.
  const nonce = (win.document.currentScript as HTMLScriptElement | null)?.nonce ?? ""
  const map = win.document.createElement("script")
  map.type = "importmap"
  if (nonce) map.nonce = nonce
  map.textContent = JSON.stringify({
    imports: {
      "solid-js": shimUrl("__liaisonSolid", solid as unknown as Record<string, unknown>),
      "solid-js/web": shimUrl("__liaisonSolidWeb", solidWeb as unknown as Record<string, unknown>),
      "solid-js/store": shimUrl(
        "__liaisonSolidStore",
        solidStore as unknown as Record<string, unknown>,
      ),
    },
  })
  win.document.head.appendChild(map)

  let started = false
  const start = async (message: Extract<HostToFrame, { kind: "init" }>) => {
    if (started) return
    started = true
    g.__LIAISON_HOST_ORIGIN__ = message.hostOrigin
    setLocale(message.locale)
    if (typeof message.path === "string") setPath(message.path)
    setProps(reconcile(message.props))
    if (message.theme) win.document.documentElement.setAttribute("data-theme", message.theme)
    const style = win.document.createElement("style")
    style.textContent = message.css
    win.document.head.appendChild(style)
    const url = URL.createObjectURL(new Blob([message.source], { type: "text/javascript" }))
    const exports = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
    const component = exports[message.exportName]
    const root = win.document.getElementById("app") ?? win.document.body
    if (typeof component !== "function") {
      root.textContent = `This app does not provide ${message.exportName}.`
      send({ kind: "missingExport" })
      return
    }
    render(
      () => createComponent(component as solid.Component<Record<string, FrameProp>>, props),
      root,
    )
    const report = () => send({ kind: "height", height: win.document.documentElement.scrollHeight })
    new win.ResizeObserver(report).observe(win.document.documentElement)
    report()
  }

  win.addEventListener("message", (event: MessageEvent) => {
    // Only the page that holds this frame speaks to it.
    if (event.source !== parent) return
    const message = event.data as HostToFrame | null
    if (!message || typeof message !== "object" || typeof message.kind !== "string") return
    switch (message.kind) {
      case "init":
        void start(message).catch((error: unknown) => {
          const root = win.document.getElementById("app") ?? win.document.body
          root.textContent = "This app could not be shown."
          console.error(error)
        })
        return
      case "props":
        setProps(reconcile(message.props))
        return
      case "locale":
        setLocale(message.locale)
        return
      case "path":
        if (typeof message.path !== "string") return
        setPath(message.path)
        // Apps follow the URL on popstate (a sidebar's active row): tell them.
        if (typeof win.dispatchEvent === "function" && typeof win.PopStateEvent === "function") {
          win.dispatchEvent(new win.PopStateEvent("popstate", { state: null }))
        }
        return
      case "result": {
        const waiting = pending.get(message.id)
        if (!waiting) return
        pending.delete(message.id)
        if (message.ok) waiting.resolve(message.value)
        else {
          // An unsupported method names itself, for an app that falls back.
          const error = new Error(message.error) as Error & { method?: string }
          if (message.method !== undefined) error.method = message.method
          waiting.reject(error)
        }
        return
      }
      case "entityChange":
        changeListeners.get(message.subscription)?.(message.events)
        return
    }
  })
  send({ kind: "ready" })
}

if (typeof window !== "undefined" && window.parent !== window) startFrameRuntime()

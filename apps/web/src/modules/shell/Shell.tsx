// SPDX-License-Identifier: FSL-1.1-ALv2
import { useLocation, useNavigate } from "@solidjs/router"
import type { JSX } from "solid-js"
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  areManifestAppsSettled,
  dispatchKeybinding,
  dispatchWsEventMessage,
  dispatchWsMessage,
  getPanel,
  getTabType,
  namespaceRegistryKey,
  registerCommand,
  registerKeybinding,
  resolveRegisteredTabType,
  tabTypeRegistryVersion,
  unregisterCommand,
  unregisterKeybinding,
  urlToTabInfo,
} from "~/framework/app-registry"
import { loadManifestApps, reloadManifestApps } from "~/framework/bootstrap"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"
import { installReconnectResync, installResumeResync, requestResync } from "~/framework/resync"
import { isAppUnavailable } from "~/framework/unavailable-apps"
import { createAppLock } from "~/lib/app-lock"
import { apiUrl } from "~/lib/env"
import { nativeBridge } from "~/lib/native-bridge"
import { noteSocketStatus } from "~/lib/socket-state"
import { installReloadGuard } from "~/lib/unsaved-work"
import { insideAppShell } from "~/lib/web-build"
import { accessToken, userFromToken } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { createSessionApiClient } from "~/modules/auth/session-api-client"
import ClaudeSignInDialog from "~/modules/desktop/ClaudeSignInDialog"
import DesktopConnectDialog from "~/modules/desktop/DesktopConnectDialog"
import DesktopDeviceApprovalDialog from "~/modules/desktop/DesktopDeviceApprovalDialog"
import { installDesktopNotices } from "~/modules/desktop/desktop-notices"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MailboxAgentHost } from "~/modules/mailbox/MailboxAgentHost"
import { MailboxUnlockHost } from "~/modules/mailbox/MailboxUnlockHost"
import {
  forwardNodeFolderRequest,
  forwardNodeFullOutput,
  forwardNodeImportRequest,
  forwardNodeJobOffer,
  forwardNodeSessionCommand,
  nodeReconnectEdge,
  startNodeJobsIfNode,
} from "~/modules/nodes/node-jobs"
import {
  nodeCredentialForHello,
  onNodeSessionChange,
  restoreNodeSession,
  verifyNodeSession,
} from "~/modules/nodes/node-session"
import { nodesSocketConnected } from "~/modules/nodes/nodes-store"
import { ensureBrowserDevice } from "~/modules/notifications/browser-push"
import * as desktopNotifications from "~/modules/notifications/desktop"
import {
  desktopDeviceId,
  ensureDesktopDevice,
  installDesktopPermissionReporting,
  refreshReportedPermission,
  reportedPermission,
} from "~/modules/notifications/desktop-device"
import { installNotificationRoutes } from "~/modules/notifications/open-route"
import {
  installThreadOnScreenReport,
  installViewingReport,
  threadsBeingRead,
  viewingReport,
} from "~/modules/notifications/thread-on-screen"
import { ConnectDialogHost } from "~/modules/settings/connect-dialog-host"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { ApiProvider, useApi } from "~/modules/shell/ApiContext"
import { agentReferenceStore } from "~/modules/shell/agent-reference-store"
import { AppApprovalConfirmHost } from "~/modules/shell/app-approval-confirm"
import { attentionStore, getAttentionApi, setAttentionApi } from "~/modules/shell/attention-store"
import { ChatDock } from "~/modules/shell/ChatDock"
import { ChatsSheet } from "~/modules/shell/ChatsSheet"
import { ChatsTab } from "~/modules/shell/ChatsTab"
import CommandPalette from "~/modules/shell/CommandPalette"
import ConversationTab from "~/modules/shell/ConversationTab"
import {
  DOCK_STRIP_HEIGHT,
  activeThreadId as dockActiveThreadId,
  dockAvailable,
  dockWindowClearance,
  dockWindowOpen,
  toggleChats,
} from "~/modules/shell/dock-store"
import KeyboardShortcutsOverlay from "~/modules/shell/KeyboardShortcutsOverlay"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { PhoneTabBar } from "~/modules/shell/PhoneTabBar"
import { activePanel, panelOpen, syncPanelForTier, togglePanel } from "~/modules/shell/panel-store"
import { RouteNotFound } from "~/modules/shell/RouteNotFound"
import { Sidebar } from "~/modules/shell/Sidebar"
import { ACTIVITY_RAIL_WIDTH, shellTier, syncShellTier } from "~/modules/shell/shell-tier"
import { ToastContainer } from "~/modules/shell/Toast"
import {
  activateTab,
  canonicalEntityId,
  canonicalTabRoute,
  closeTab,
  isHomeTab,
  makeTabId,
  openTab,
  reopenLastClosed,
  tabNavigationVersion,
  tabStore,
  tabToUrl,
  updateTabRoutePath,
  validateTabs,
} from "~/modules/shell/tab-store"
import { closeTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import { UnsavedWorkConfirm } from "~/modules/shell/UnsavedWorkConfirm"
import { WsProvider } from "~/modules/shell/WsContext"
import { WsStatusContext } from "~/modules/shell/ws-status-context"
import {
  canonicalAgentPageEntityId,
  loadAgentDirectory,
  personalAgentPageEntityId,
  registerAgentDirectoryLoader,
} from "~/modules/threads/agent-directory"
import { cleanupPendingMessages } from "~/modules/threads/message-store"
import NewChannelDialog from "~/modules/threads/NewChannelDialog"
import NewMessageDialog from "~/modules/threads/NewMessageDialog"
import {
  closeNewConversationDialog,
  newConversationDialog,
  openNewChannelDialog,
  openNewMessageDialog,
} from "~/modules/threads/new-conversation-store"
import { togglePersonalAgentChat } from "~/modules/threads/personal-dm-store"
import { TourHost } from "~/modules/tours/TourHost"
import { createWebSocket, notificationDeviceId } from "~/primitives/createWebSocket"
import { keyboardOpen } from "~/primitives/keyboardInset"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { AppLockOverlay } from "~/ui/AppLockOverlay"
import { Button } from "~/ui/Button"
import { OverlaySheet } from "~/ui/OverlaySheet"

const AttentionLifecycle: Component = () => {
  const api = useApi()
  onMount(() => {
    setAttentionApi(api)
    attentionStore.start(api)
    // LIF-18: a notification click (desktop, browser, service worker, phone)
    // opens its item from here on, the ones that arrived before the shell too.
    onCleanup(installNotificationRoutes(api))
  })
  onCleanup(() => {
    attentionStore.stop()
    setAttentionApi(null)
  })
  return null
}

/** The client the legacy redirects use to find the agent that OWNS a skill or
 *  a routine when nothing in the session has loaded that row yet. A deep link
 *  can be the first thing a session does, so this cannot wait for a provider
 *  mounted further down the tree. */
const legacyLookupApi = createSessionApiClient({ onUnauthorized: () => {} })

/** Asks the server, at start, whether this computer's node still exists
 *  (walk N13); it runs before any provider below the shell is mounted. */
const nodeCheckApi = createSessionApiClient({ onUnauthorized: () => {} })

// A surface can need the org's agents before anything has fetched them: the
// Home sidebar's agent row is clickable on a cold load, and it knows only the
// agent's uuid. The directory owns the fetch; the shell owns the client, so it
// hands one over here (the tab opened under the uuid is re-keyed onto the
// handle the moment the listing lands).
registerAgentDirectoryLoader(() => loadAgentDirectory(legacyLookupApi))

/** The flat `/agent/<screen>` screens, each now a tab of an agent's page. */
const LEGACY_SCREEN_TABS: Record<string, string> = {
  "/agent/skills": "skills",
  "/agent/routines": "routines",
  "/agent/memories": "memory",
}

/** The viewer's own agent page, addressed by the personal agent's HANDLE
 *  whenever the directory can name it. `self` is only the fallback spelling
 *  for the window before that, and the tab store treats the two as one agent
 *  so a redirect that had to use it never opens a second tab (P4c FX-F3). */
function personalAgentPath(): string {
  return `/agents/${personalAgentPageEntityId()}`
}

/**
 * The same path, but asked only once the directory CAN answer.
 *
 * A redirect is the first navigation of a session as often as not, and the
 * directory has not loaded then, so the sync spelling above emits `self` for
 * every retired list-screen bookmark. `self` is a legitimate address (the page
 * resolves it to the viewer's personal row), but it is a SECOND name for an
 * agent that already has one, and a tab opened under it is re-keyed onto the
 * handle the moment the directory lands. A redirect can afford the roundtrip
 * `legacyRedirectFor` is already allowed to make, so it takes it and emits the
 * canonical spelling from the start (P4c FX-F4).
 */
async function personalAgentPathResolved(): Promise<string> {
  await loadAgentDirectory(legacyLookupApi)
  return personalAgentPath()
}

/** Which agent owns this skill / routine, from the row itself: the session's
 *  cache if it holds the row, otherwise the listing. An unknown owner falls
 *  back to the viewer's own agent rather than to nothing. */
async function ownerAgentPath(listPath: string, id: string): Promise<string> {
  try {
    const res = await legacyLookupApi.get<any>(listPath)
    const rows = Array.isArray(res) ? res : (res?.data ?? [])
    const row = (Array.isArray(rows) ? rows : []).find((r: any) => r?.id === id || r?.name === id)
    const owner = typeof row?.ownerAgentId === "string" ? row.ownerAgentId : null
    // The directory names the owner's handle; without it the path would carry
    // a raw uuid, which the page accepts but nobody recognizes.
    await loadAgentDirectory(legacyLookupApi)
    if (owner) return `/agents/${canonicalAgentPageEntityId(owner)}`
  } catch {
    // An unreachable listing is not a reason to strand the link.
  }
  return personalAgentPathResolved()
}

/** The original link's own query survives the rewrite, whether or not the
 *  replacement already carries one of its own. */
function joinLegacyQuery(target: string, search: string): string {
  if (!search) return target
  return target.includes("?") ? `${target}&${search.slice(1)}` : `${target}${search}`
}

/**
 * Legacy route redirects: paths a shipped link may still carry that no
 * registered tab type answers any more. Returns the replacement path (which
 * may carry its own query string), a promise of one, or null when the
 * pathname is not legacy.
 *
 * `/agent/chat/:id` was the Agent app's chat tab. The agent app is no longer a
 * chat surface and the row behind that id is the personal DM thread, so the
 * link resolves to the thread view. The placeholder "new" id had no thread
 * behind it: it lands on Home, where the dock opens the personal agent chat.
 *
 * P4c-T39: the flat skills / routines / memory screens and their detail tabs
 * are gone, folded into the agent page's own tabs. A list screen was always
 * the VIEWER'S own, so it redirects to the viewer's personal agent page on
 * that tab. A detail link names one item, so it redirects to the page of the
 * agent that OWNS the item, with the item named in `?selected=`.
 */
export function legacyRedirectFor(pathname: string): string | Promise<string | null> | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname

  const chat = /^\/agent\/chat\/([^/]+)$/.exec(path)
  if (chat) {
    const entityId = decodeURIComponent(chat[1]!)
    return entityId.startsWith("new") ? "/" : `/threads/${chat[1]!}`
  }

  // `/agents` is not a screen any more: the sidebar is the roster, so the bare
  // path opens the viewer's own agent. Shipped links, the activity bar's old
  // tab action and every bookmark keep working; none of them lands on nothing.
  if (path === "/agents") return personalAgentPathResolved()

  const screen = LEGACY_SCREEN_TABS[path]
  if (screen) return personalAgentPathResolved().then((base) => `${base}/${screen}`)

  const profile = /^\/agent\/profile\/(.+)$/.exec(path)
  if (profile) return `/agents/${canonicalAgentPageEntityId(decodeURIComponent(profile[1]!))}`

  // `<type>/<name>` addresses a typed memory; the memory tab reads the same
  // rows as the file its path renders to (`<type>/<name>.md`).
  const memory = /^\/agent\/memory\/(.+)$/.exec(path)
  if (memory) {
    const entityId = decodeURIComponent(memory[1]!)
    return personalAgentPathResolved().then((path) => {
      const base = `${path}/memory`
      if (entityId.startsWith("new")) return base
      return `${base}?selected=${encodeURIComponent(`${entityId}.md`)}`
    })
  }

  const skill = /^\/agent\/skill\/(.+)$/.exec(path)
  if (skill) {
    const id = decodeURIComponent(skill[1]!)
    return ownerAgentPath("/agent/skills", id).then(
      (base) => `${base}/skills?selected=${encodeURIComponent(id)}`,
    )
  }

  const routine = /^\/agent\/routine\/(.+)$/.exec(path)
  if (routine) {
    const id = decodeURIComponent(routine[1]!)
    return ownerAgentPath("/agent/routines", id).then(
      (base) => `${base}/routines?selected=${encodeURIComponent(id)}`,
    )
  }

  return null
}

export const Shell: Component = () => {
  const i18n = useI18n()
  // Created here rather than inside the overlay: the lock is the shell's
  // state, and a controller owned by a component that only renders while
  // locked could never be the thing that decides to lock (lib/app-lock.ts).
  const appLock = createAppLock()
  const location = useLocation()
  const navigate = useNavigate()

  // P6d-T13: the desktop shell's notices go through this app's own toasts.
  // Once, here, rather than once per surface that happens to be mounted; a
  // browser has no bridge and this raises nothing at all.
  installDesktopNotices()

  // The drawer belongs to the tablet tier only. Without this reset its open
  // state leaks across a tier change: open at tablet, widen to desktop, narrow
  // back, and the drawer is sitting over the content again with nothing having
  // asked for it.
  createEffect(() => {
    if (shellTier() !== "tablet") closeTabletSidebar()
  })

  // The side panel is a docked column at desktop but a viewport-covering
  // sheet at tablet and phone. Left open on a tier change it sits over every
  // screen with the shell unreachable underneath, so the sheet tiers start
  // closed and only the user opens them.
  createEffect(() => {
    syncPanelForTier(shellTier())
  })

  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false)
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false)
  // Flips true once `onMount` has registered keybindings + the keydown
  // listener. `[data-shell]` paints before `onMount` runs, so a keypress sent
  // in that window is silently dropped — `data-shell-ready` is the signal that
  // shortcuts are actually live (consumed by E2E tests, harmless otherwise).
  const [shellReady, setShellReady] = createSignal(false)

  const auth = authManager

  const ws = createWebSocket({
    getToken: accessToken,
    ensureFreshToken: auth.ensureFreshToken,
    // Sync-frame path: the server told us the replay buffer expired, so force a
    // resync of every loaded store (refetch-in-place). Distinct from the
    // reconnect-transition path below.
    onSyncRequired: () => requestResync("ws-sync"),
    getScope: () => {
      const u = userFromToken()
      return u ? `${u.orgId}:${u.userId}` : null
    },
    getClientKind: desktopNotifications.clientKind,
    getLastActiveAt: desktopNotifications.lastActiveAt,
    // P1-T6: the desktop app is its INSTALL (the id the shell published),
    // and reports the system's real notification permission (A6).
    getDeviceId: () => desktopDeviceId() ?? notificationDeviceId(),
    getNotificationPermission: reportedPermission,
    // P4 N-D T4: a computer that is the user's node presents its credential.
    getNodeCredential: nodeCredentialForHello,
    // What this window shows and whether it is focused: the server holds a
    // device push back while the user is reading that thread here.
    getViewing: viewingReport,
    // The phone app back in the foreground probes the socket (S26). The
    // connectivity source (the shell's reachability, else the browser's) is
    // the socket's default.
    onForeground: (handler) => {
      const bridge = nativeBridge()
      const subscribe = bridge?.onForeground
      return typeof subscribe === "function" ? subscribe.call(bridge, handler) : () => {}
    },
  })

  // Desktop notifications (S5, S6): the server picks this window or not; the
  // frame only needs the OS permission to be raised. Coming back to the window
  // tells the server at once, so the "most recently active tab" is current.
  // Never for the conversation the user is reading: on screen in the focused
  // window (a window behind other apps still notifies).
  ws.on("notify", (msg: any) => {
    void desktopNotifications.handleNotifyFrame(msg, threadsBeingRead)
  })
  // P4 N-D T5: a job offered to this computer as the owner's node; the shell
  // claims and runs it. "Review" on the backlog prompt opens the queue.
  ws.on("node_job_offer", (msg: unknown) => forwardNodeJobOffer(msg))
  // P3 (C5, D36): a steering command waits for one of this node's sessions;
  // and each reconnect after the first makes the shell report its live runs.
  ws.on("node_session_command", (msg: unknown) => forwardNodeSessionCommand(msg))
  // P3-T22 (S7): the owner asked for a cut output's full text from this computer.
  ws.on("node_session_full_output", (msg: unknown) => forwardNodeFullOutput(msg))
  ws.on("node_folder_request", (msg: unknown) => forwardNodeFolderRequest(msg))
  ws.on("node_import_request", (msg: unknown) => forwardNodeImportRequest(msg))
  const nodeReconnected = nodeReconnectEdge()
  createEffect(() => nodeReconnected(ws.status()))
  // The API clients skip their connection toast while the socket reconnects (S26).
  createEffect(() => noteSocketStatus(ws.status()))
  // The first connect: a node change sent before the socket was up is lost,
  // so the computers are read again (nodes-store.ts).
  let socketConnectedOnce = false
  createEffect(() => {
    if (socketConnectedOnce || ws.status() !== "connected") return
    socketConnectedOnce = true
    nodesSocketConnected()
  })
  // In the desktop or phone app, a reconnect after the server restarted (a
  // deploy) reads the app feed again, so an app whose settings page moved past
  // this build shows as running in compatibility mode (framework/compat-mode.ts).
  const manifestsOnReconnect = nodeReconnectEdge(() => {
    if (insideAppShell()) void reloadManifestApps()
  })
  createEffect(() => manifestsOnReconnect(ws.status()))
  const reviewNodeQueue = () => navigate("/settings/computers")
  // The phone shell raises its own notice for a push that lands while the app
  // is open; it asks the same question through the bridge.
  onCleanup(installThreadOnScreenReport())
  // The desktop shell's Reload asks this page first: a draft or a staged file
  // would be lost (lib/unsaved-work.ts).
  onCleanup(installReloadGuard())
  onCleanup(installViewingReport(() => ws.sendPresence()))
  onCleanup(desktopNotifications.installActivityTracking(() => ws.sendPresence()))
  // A change of the system's notification setting reaches the server at once
  // (the presence frame carries the new word) and re-registers the device.
  onCleanup(installDesktopPermissionReporting(() => ws.sendPresence()))
  // Settings > This computer turned the node on or off: the next hello says so.
  onCleanup(
    onNodeSessionChange(() => {
      if (!accessToken()) return
      ws.disconnect()
      ws.connect()
      startNodeJobsIfNode(reviewNodeQueue)
    }),
  )

  let refreshInterval: ReturnType<typeof setInterval> | undefined

  function getWsContext() {
    return {
      currentUserId: userFromToken()?.userId ?? "",
      activeTabId: tabStore.activeTabId,
      isDocumentVisible: document.visibilityState === "visible",
      isOwnAction: false,
    }
  }

  // WebSocket event dispatch — registry-driven
  ws.on("event", (msg: any) => {
    dispatchWsEventMessage(msg, getWsContext())
  })

  ws.on("presence_sync", (msg: any) => {
    dispatchWsMessage("presence_sync", msg, getWsContext())
  })

  ws.on("sync", (msg: any) => {
    dispatchWsMessage("sync", msg, getWsContext())
  })

  // Reconnect-transition path: see installReconnectResync in ~/framework/resync
  // for the semantics (transition-edge, not level; seeded to skip the initial
  // connecting->connected edge). Distinct from the sync-frame path above.
  installReconnectResync(ws.status)
  // Resume path: a page back from hidden refetches too, since a socket that
  // slept through the gap may never report a reconnect (see installResumeResync).
  onCleanup(installResumeResync())

  // URL -> Tab sync: when URL changes (back/forward, deep link), map to tab
  let lastSyncedPath = ""
  // A path no page answers (an app that is not installed, a mistyped link),
  // once every app has registered: the panel says so instead of leaving the
  // previous tab on screen under the new address.
  const [unmatchedRoute, setUnmatchedRoute] = createSignal<string | null>(null)
  // The socket belongs to the session it was opened for (org and user). A
  // session that changes without a sign-out in between (the demo's Start over
  // moves the visitor into a new workspace in place) reconnects it, or this
  // window keeps receiving the old workspace's events and none of the new one's.
  createEffect((prevScope: string | null) => {
    const token = accessToken()
    if (!token) {
      if (prevScope !== null) ws.disconnect()
      return null
    }
    const user = userFromToken()
    const scope = user ? `${user.orgId}:${user.userId}` : ""

    if (prevScope !== null && scope !== prevScope) {
      ws.disconnect()
      ws.connect()
      validateTabs()
      return scope
    }

    if (prevScope === null) {
      // The desktop app's FIRST hello must carry its permission: the server
      // replays missed notifications on that hello only to a `granted` app.
      // One local read through the shell, then connect.
      if (desktopDeviceId()) {
        void Promise.allSettled([
          refreshReportedPermission(),
          restoreNodeSession().then(() => verifyNodeSession(nodeCheckApi)),
        ]).finally(() => {
          if (accessToken()) ws.connect()
          startNodeJobsIfNode(reviewNodeQueue)
        })
      } else {
        ws.connect()
      }
      validateTabs()
    }

    return scope
  }, null)

  createEffect(() => {
    tabTypeRegistryVersion()
    const pathname = location.pathname
    const search = location.search
    const fullPath = `${pathname}${search}`
    if (fullPath === lastSyncedPath) return

    // A retired route never opens a tab: rewrite the URL and let this same
    // effect re-run on the replacement path. A replacement that has to ask the
    // server who owns the item arrives later, and only still applies if the
    // user has not navigated away in the meantime.
    const legacy = legacyRedirectFor(pathname)
    if (legacy) {
      if (typeof legacy === "string") {
        navigate(joinLegacyQuery(legacy, search), { replace: true })
      } else {
        void legacy.then((target) => {
          if (!target || location.pathname !== pathname) return
          navigate(joinLegacyQuery(target, search), { replace: true })
        })
      }
      return
    }

    const info = urlToTabInfo(pathname)
    if (!info) {
      // Until the manifests settle, a plugin app's page may still be on its way.
      setUnmatchedRoute(areManifestAppsSettled() ? pathname : null)
      return
    }
    setUnmatchedRoute(null)
    lastSyncedPath = fullPath
    // Under an alias (`/agents/self/routines`) the route is the canonical tab's.
    const tabRoute = canonicalTabRoute(info.type, info.entityId, fullPath)

    const tabId = makeTabId(info.type, info.entityId)
    const reg = getTabType(info.type)

    if (reg?.preserveSubRoutes) {
      updateTabRoutePath(tabId, tabRoute)
    } else if (search) {
      updateTabRoutePath(tabId, tabRoute)
    }

    if (untrack(() => tabStore.activeTabId) === tabId) return

    const existingExactTab = untrack(() => tabStore.tabs.find((t) => t.id === tabId))
    if (existingExactTab) {
      if (search) updateTabRoutePath(existingExactTab.id, tabRoute)
      activateTab(existingExactTab.id)
      return
    }

    // Singleton tabs — activate existing if present. A path naming another entity of the
    // same singleton (`/kpi-catalogue/metric/<id>` from a sidebar click) goes through
    // openTab below, which moves the one tab onto it: activating it alone left its old
    // entityId, so a view that reads its selection from the route never saw the click.
    if (reg?.singleton) {
      const tabType = resolveRegisteredTabType(info.type) ?? info.type
      const existing = untrack(() =>
        tabStore.tabs.find((t) => (resolveRegisteredTabType(t.type) ?? t.type) === tabType),
      )
      if (existing && existing.entityId === canonicalEntityId(info.type, info.entityId)) {
        if (reg.preserveSubRoutes || search) {
          updateTabRoutePath(existing.id, tabRoute)
        }
        activateTab(existing.id)
        return
      }
    }

    // Resolve label via registry callback (e.g. thread title from store)
    if (reg?.resolveLabel) {
      const resolved = reg.resolveLabel(info.entityId)
      if (resolved) info.label = resolved
    }

    openTab({ type: info.type, entityId: info.entityId, label: info.label, routePath: fullPath })

    // URL-driven tab opens skip the standard "load the doc → server returns
    // 404/403 → tab evicted" path because the URL→tab effect fires before the
    // tab content mounts. Run a one-shot validation in the background so an
    // unauthorized direct navigation (shared bookmark, etc.) bounces back to
    // the parent singleton instead of leaving a phantom tab + URL.
    if (reg?.validateEntity && !reg.singleton) {
      void (async () => {
        try {
          const valid = await reg.validateEntity!(info.entityId)
          if (!valid) await validateTabs()
        } catch {
          // Network/transient — leave the tab; the next WS sync revalidates.
        }
      })()
    }
  })

  // Tab -> URL sync: when active tab changes or its routePath updates, navigate.
  // Tracks activeTabId and the active tab's routePath reactively so settings
  // sub-page navigation updates the browser URL.
  // location.pathname must be untracked to avoid fighting with sidebar <A> links
  // that change the URL within the same tab.
  let lastUrlSyncNavigationVersion = tabNavigationVersion()
  createEffect(() => {
    const navigationVersion = tabNavigationVersion()
    const activeId = tabStore.activeTabId
    if (!activeId) return
    const tab = tabStore.tabs.find((t) => t.id === activeId)
    if (!tab) return
    const currentPath = untrack(() => location.pathname)
    const tabNavigationChanged = navigationVersion !== lastUrlSyncNavigationVersion
    lastUrlSyncNavigationVersion = navigationVersion
    const currentInfo = urlToTabInfo(currentPath)
    if (currentInfo) {
      const currentTabId = makeTabId(currentInfo.type, currentInfo.entityId)
      if (currentTabId !== activeId && isHomeTab(tab) && !tabNavigationChanged) return
      if (currentTabId !== activeId && !tabNavigationChanged) return
    }
    if (currentPath !== "/" && !currentInfo && !tabNavigationChanged) {
      // The URL doesn't resolve to any registered tab type YET. On a cold load
      // this is a deep link into a plugin app whose manifest hasn't registered
      // (the registry-version bump re-runs the URL→tab effect and opens it) —
      // navigating to the rehydrated active tab's URL here would CLOBBER the
      // deep link before the plugin loads (seen with a persisted non-home
      // active tab + /monitoring/incident/:id). Hold the URL for any passive
      // re-run; an explicit user navigation (tab click/eviction bumps
      // tabNavigationVersion) still syncs the URL away.
      return
    }
    // Track routePath reactively for the active tab
    const _routePath = tab.routePath
    const url = tabToUrl(tab)
    if (currentPath !== url) {
      lastSyncedPath = url
      navigate(url)
    }
  })

  let lastAgentReferenceKey: string | null = null
  let referencePendingTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    // The conversation the user is actually in: the dock's active tab. It used
    // to be the agent panel's `activeAgentChatId`, retired with the panel
    // (P4c-T17) along with the per-session chat it pointed at.
    const agentChatId = dockActiveThreadId()
    const activeTabId = tabStore.activeTabId
    const token = accessToken()
    if (referencePendingTimer) {
      clearTimeout(referencePendingTimer)
      referencePendingTimer = undefined
    }
    if (!agentChatId || !activeTabId || !token) return
    // Client-only placeholder ids — the server doesn't know about them yet, so
    // posting `/references` 400s. Skip until the row is a real UUID.
    if (agentChatId.startsWith("optimistic-") || agentChatId.startsWith("pending-")) return

    const activeTab = tabStore.tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab?.entityId) return
    const reg = getTabType(activeTab.type)
    if (!reg?.referenceable) return

    const [app, entityType] = activeTab.type.includes(":")
      ? activeTab.type.split(":", 2)
      : ["kernel", activeTab.type]
    if (!app || !entityType) return

    const referenceKey = `${agentChatId}:${app}:${entityType}:${activeTab.entityId}`
    if (referenceKey === lastAgentReferenceKey) return
    referencePendingTimer = setTimeout(() => {
      lastAgentReferenceKey = referenceKey
      void fetch(apiUrl(`/threads/${agentChatId}/references`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ app, entityType, entityId: activeTab.entityId }),
      })
        .then(() => {
          const api = getAttentionApi()
          if (api) agentReferenceStore.markStaleAndReload(api)
        })
        .catch(() => {
          // Best-effort context enrichment.
        })
    }, 250)
  })
  onCleanup(() => {
    if (referencePendingTimer) clearTimeout(referencePendingTimer)
  })

  // Live-reconcile the app surface when the user's SCOPE SET changes mid-session
  // (e.g. an admin edits their role to grant/revoke an app). The token refresh
  // (the 60s `ensureFreshToken` interval below, or the 401-on-permission-bump
  // path) re-mints with the new scopes, updating the `accessToken` signal; we
  // re-fetch the per-user manifest list and add/remove app icons in place. The
  // initial scope set and plain token rotation (same scopes) do NOT trigger a
  // reload — only an actual change does.
  createEffect<string | undefined>((prevScopeKey) => {
    const payload = userFromToken() // tracks accessToken()
    const scopeKey = payload ? [...payload.scopes].sort().join("\u0000") : undefined
    if (scopeKey !== undefined && prevScopeKey !== undefined && scopeKey !== prevScopeKey) {
      void reloadManifestApps()
    }
    return scopeKey
  }, undefined)

  onMount(() => {
    // Load manifest apps on shell mount — the token is now available post-login.
    // The startup call may have run without a token (on the login page), so retry here.
    void loadManifestApps()

    // The tier signal and its listeners live in `shell-tier`; the shell only
    // asks it to re-read on mount, because a module evaluated before the
    // document had its final width would have resolved against nothing.
    syncShellTier()

    refreshInterval = setInterval(() => {
      void auth.ensureFreshToken().catch(() => {})
    }, 60_000)
    void auth
      .ensureFreshToken()
      .catch(() => {})
      .then(() => {
        // T4: in a real browser this profile is a notification device (in-tab
        // receipts, and Web Push once allowed). A no-op in the shells.
        const userId = userFromToken()?.userId
        if (userId) void ensureBrowserDevice(legacyLookupApi, userId)
        // T6: in the desktop app this install is the notification device
        // (receipts after each OS notification). A no-op elsewhere.
        if (userId) void ensureDesktopDevice(legacyLookupApi, userId)
      })

    // Register Shell-specific keybindings (these close over local state)
    const shellBindingIds: string[] = []
    function registerShellBinding(binding: Parameters<typeof registerKeybinding>[0]) {
      registerKeybinding(binding)
      shellBindingIds.push(binding.id)
    }
    registerShellBinding({
      id: "toggle-agent",
      key: "mod+.",
      label: i18n.t("kernel.shellUi.toggleChat"),
      activeInInput: true,
      // Brings the personal agent DM up as a dock tab, puts it away when it is
      // already the expanded tab in front of the user, and on a Home surface
      // (where the conversation is already on screen) focuses its composer.
      handler: () => {
        void togglePersonalAgentChat().catch(() => {
          /* no personal agent yet: the gesture is a no-op */
        })
      },
    })
    registerShellBinding({
      id: "command-palette",
      key: "mod+p",
      label: i18n.t("kernel.shellUi.commandPalette"),
      activeInInput: true,
      handler: () => setCommandPaletteOpen((v) => !v),
    })
    registerShellBinding({
      id: "close-tab",
      key: "mod+w",
      label: i18n.t("kernel.shellUi.closeTab"),
      activeInInput: true,
      handler: () => {
        if (tabStore.activeTabId) closeTab(tabStore.activeTabId)
      },
    })
    registerShellBinding({
      id: "reopen-tab",
      key: "mod+shift+t",
      label: i18n.t("kernel.shellUi.reopenClosedTab"),
      activeInInput: true,
      handler: () => reopenLastClosed(),
    })
    registerShellBinding({
      id: "escape",
      key: "escape",
      label: i18n.t("kernel.shellUi.closeOverlay"),
      activeInInput: true,
      handler: () => {
        if (commandPaletteOpen()) setCommandPaletteOpen(false)
        else if (newConversationDialog()) closeNewConversationDialog()
      },
    })
    registerShellBinding({
      id: "new-message",
      key: "n",
      label: i18n.t("kernel.shellUi.newMessage"),
      handler: () => openNewMessageDialog(),
    })
    registerShellBinding({
      id: "shortcuts-overlay",
      key: "mod+?",
      label: i18n.t("kernel.shellUi.keyboardShortcuts"),
      activeInInput: true,
      handler: () => setShortcutsOpen(true),
    })
    registerShellBinding({
      id: "focus-search",
      key: "/",
      label: i18n.t("kernel.shellUi.focusSearch"),
      handler: () => {
        const searchInput = document.querySelector(
          "[data-shell] input[type='text'][placeholder*='Search']",
        ) as HTMLInputElement | null
        searchInput?.focus()
      },
    })

    // Registry-driven keybinding dispatch
    const handleKey = (e: KeyboardEvent) => {
      dispatchKeybinding(e)
    }
    window.addEventListener("keydown", handleKey)

    // Register commands that close over Shell-local state
    const shellCommandIds = [
      "kernel:new-message",
      "kernel:new-channel",
      "kernel:shortcuts",
      "kernel:command-palette",
    ]
    registerCommand({
      id: "kernel:new-message",
      label: i18n.t("kernel.shellUi.newMessage"),
      shortcut: "n",
      execute: () => openNewMessageDialog(),
    })
    registerCommand({
      id: "kernel:new-channel",
      label: i18n.t("kernel.shellUi.newChannel"),
      execute: () => openNewChannelDialog(),
    })
    registerCommand({
      id: "kernel:shortcuts",
      label: i18n.t("kernel.shellUi.keyboardShortcuts"),
      shortcut: "mod+?",
      execute: () => setShortcutsOpen(true),
    })
    registerCommand({
      id: "kernel:command-palette",
      label: i18n.t("kernel.shellUi.commandPalette"),
      shortcut: "mod+p",
      execute: () => setCommandPaletteOpen((v) => !v),
    })

    setShellReady(true)

    onCleanup(() => {
      window.removeEventListener("keydown", handleKey)
      for (const id of shellBindingIds) unregisterKeybinding(id)
      for (const id of shellCommandIds) unregisterCommand(id)
    })
  })

  // Periodically clean up stale pending messages (MED-4)
  const pendingCleanupInterval = setInterval(() => cleanupPendingMessages(), 60_000)

  onCleanup(() => {
    if (refreshInterval) clearInterval(refreshInterval)
    clearInterval(pendingCleanupInterval)
    ws.disconnect()
  })

  async function handleLogout() {
    await auth.logout()
    ws.clearLastEventId()
    ws.disconnect()
  }

  // Tracks the registry version so Layout updates whenever a tab type's
  // sidebar declaration changes (e.g., manifest reload during dev).
  const hasSidebar = () => {
    tabTypeRegistryVersion()
    const activeTab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    if (!activeTab) return true
    const reg = getTabType(activeTab.type)
    if (isAppUnavailable(reg?.appId)) return false
    return Boolean(reg?.sidebar)
  }

  // The tablet Chats opener's footprint from the panel's bottom edge: its
  // `bottom-4` (16px) plus its 44px height, plus 4px of air.
  const CHATS_OPENER_CLEARANCE = 16 + 44 + 4

  // What a viewport-fixed overlay anchored to the bottom (the bulk action
  // toolbar) must clear, published as custom properties on the shell root so
  // overlays below it never hardcode the shell's geometry: the phone tab bar
  // row, and the floating Chats opener (bottom-4 plus its 44px height) on the
  // tiers that show it. The safe-area inset is added by the consumer.
  const shellOverlayInsets = () => ({
    "--shell-bottom-bar": shellTier() === "phone" && !keyboardOpen() ? "56px" : "0px",
    "--shell-fab-clearance": dockAvailable() ? "0px" : "60px",
    // What a bottom-anchored control in the main panel keeps clear of what
    // floats over the panel's bottom right corner (the chat composer's card,
    // ComposeBar.tsx): the round Chats opener at tablet (it sat on the
    // composer's send button). Nothing at desktop, where the dock's bar is
    // anchored flush to the corner and every page keeps its full height, and
    // nothing on the phone.
    "--shell-dock-clearance": dockAvailable()
      ? "0px"
      : shellTier() === "phone"
        ? "0px"
        : `${CHATS_OPENER_CLEARANCE}px`,
    // A message pane's reserve (pb-dock-window-clearance, index.css): the
    // strip's clearance, or the open dock window's full height when one is up
    // over the panel's bottom right corner (LIF-3).
    "--shell-dock-window-clearance": dockWindowOpen()
      ? `${dockWindowClearance()}px`
      : "var(--shell-dock-clearance)",
    // The dock's bar itself, where it lies over the panel's bottom right
    // corner (it reserves no band): for a control pinned to a pane's bottom
    // there (the task discussion's comment box) that must sit above it.
    "--shell-dock-strip": dockAvailable() ? `${DOCK_STRIP_HEIGHT}px` : "0px",
  })

  const shellLayoutStyle = () => ({
    ...shellGridStyle(),
    ...shellOverlayInsets(),
    height: "calc(100dvh - var(--keyboard-inset, 0px))",
    "padding-bottom":
      "max(0px, calc(env(safe-area-inset-bottom, 0px) - var(--keyboard-inset, 0px)))",
  })

  const shellGridStyle = () => {
    // Phone: one column, one content row plus the bottom tab bar row. The
    // row folds while the native keyboard is up, as a native tab bar does:
    // otherwise the bar sits between the composer and the keyboard.
    if (shellTier() === "phone") {
      return {
        "grid-template-columns": "minmax(0, 1fr)",
        "grid-template-rows": keyboardOpen() ? "minmax(0, 1fr) 0px" : "minmax(0, 1fr) 56px",
      }
    }

    // Tablet: activity rail, then the content. The sidebar has no inline
    // column here (48px cannot hold one without overflowing it): it opens as a
    // drawer over the content, so its track stays collapsed.
    if (shellTier() === "tablet") {
      return {
        "grid-template-columns": `${ACTIVITY_RAIL_WIDTH} 0px minmax(0, 1fr)`,
        "grid-template-rows": "minmax(0, 1fr)",
      }
    }

    // Collapse the sidebar column to 0 when the active tab type has no sidebar
    // (e.g., the contact list — it's already a full-width list, no value in
    // showing an empty rail next to it).
    const sidebarColumn = hasSidebar() ? "clamp(220px, 22vw, 260px)" : "0px"
    // The fourth track is the app panel's and nothing else's: the agent column
    // is gone (chats are a dock over the main panel now), so with no app panel
    // open the grid is three columns wide.
    const panelColumn =
      panelOpen() && activePanel()?.type === "app-panel" ? "clamp(280px, 26vw, 320px)" : "0px"
    return {
      "grid-template-columns": `${ACTIVITY_RAIL_WIDTH} ${sidebarColumn} minmax(0, 1fr) ${panelColumn}`,
      "grid-template-rows": "minmax(0, 1fr)",
    }
  }

  return (
    <ApiProvider>
      {/* COVERS the shell, never replaces it: the tree underneath stays
          mounted, so five minutes in a pocket costs a glance and not every
          open tab, scroll position and unsent draft (ui/AppLockOverlay.tsx).
          Renders nothing at all in a browser. */}
      <AppLockOverlay
        locked={appLock.locked()}
        onUnlock={() => appLock.unlock(i18n.t("kernel.appLockTitle"))}
        title={i18n.t("kernel.appLockTitle")}
        unlockLabel={i18n.t("kernel.appLockUnlock")}
        failedLabel={i18n.t("kernel.appLockFailed")}
      />
      <AttentionLifecycle />
      <WsProvider send={ws.send} status={ws.status} unstable={ws.unstable}>
        <WsStatusContext.Provider value={ws.status}>
          <PanelProvider>
            <div
              data-shell
              data-shell-ready={shellReady() ? "true" : "false"}
              data-shell-tier={shellTier()}
              // Semantic, animation-independent signal of the chat dock state.
              // A dock tab animates open and never reaches zero size, so the
              // layout itself can't be observed reliably — this attribute flips
              // synchronously with the dock's active conversation.
              data-chat-dock-open={dockActiveThreadId() !== null ? "true" : "false"}
              // THE SAFE AREA IS THE SHELL'S, not each route's. index.html opts
              // the app into `viewport-fit=cover`, so inside a native shell
              // this root is drawn under the status bar and the home
              // indicator: without these insets the activity bar sat under the
              // clock and the phone tab bar under the home indicator. Padding
              // the root rather than the routes means every route inherits it
              // (Login keeps its own: it renders outside this tree).
              // The height is the DYNAMIC viewport's (h-dvh), not 100vh: in a
              // mobile browser 100vh is the height with the toolbars hidden,
              // which put the phone tab bar under Safari's bottom toolbar.
              // In the native app it also stops at the top of the software
              // keyboard (`--keyboard-inset`, primitives/keyboardInset.ts),
              // which is what lifts every route above it at once. The bottom
              // safe area is then under the keyboard, so it is only padded
              // for as far as the keyboard leaves it uncovered.
              class="grid w-full max-w-full overflow-hidden transition-[grid-template-columns,grid-template-rows] duration-200 ease-out pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
              style={shellLayoutStyle()}
            >
              {/* Phone is five FIXED seats of its own, not a squeezed rail:
                  the registry-driven bar reshuffled under the thumb as apps
                  registered. Tablet and desktop keep the rail untouched. */}
              <Show
                when={shellTier() !== "phone"}
                fallback={
                  <PhoneTabBar
                    style={{
                      "grid-column": "1",
                      "grid-row": "2",
                      display: keyboardOpen() ? "none" : undefined,
                    }}
                  />
                }
              >
                <ActivityBar
                  onLogout={handleLogout}
                  tier={shellTier()}
                  style={{ "grid-column": "1", "grid-row": "1" }}
                />
              </Show>
              <Sidebar tier={shellTier()} style={{ "grid-column": "2", "grid-row": "1" }} />
              <MainPanel
                tier={shellTier()}
                style={{
                  "grid-column": shellTier() === "phone" ? "1" : "3",
                  "grid-row": "1",
                }}
              >
                {/* The dock floats over the main panel's own cell (which is
                    `position: relative`), anchored bottom right. It is the
                    desktop affordance only; the compact tiers get a Chats
                    sheet instead.

                    IT IS ON EVERY SURFACE, Home and a thread tab included.
                    The strip used to disappear there on the argument that the
                    conversation was already the screen, which meant the bar a
                    user keeps their chats in vanished as they walked Home and
                    came back on the next click. A conversation showing twice
                    is cheap; a bar that comes and goes is not. */}
                <Show when={unmatchedRoute()}>
                  <RouteNotFound onHome={() => navigate("/")} />
                </Show>
                <Show when={dockAvailable()}>
                  <ChatDock
                    chatsTab={<ChatsTab />}
                    renderTab={(tab) => <ConversationTab tab={tab} />}
                  />
                </Show>
                {/* TABLET only: the same affordance, opening the Chats sheet
                    instead of the dock strip that has no room there. The phone
                    seats Chats in the tab bar (F2), so the floating button was
                    a second, rounder entry to the same place, parked over the
                    Work list's bottom right corner. */}
                <Show when={!dockAvailable() && shellTier() !== "phone"}>
                  <Button
                    variant="outline"
                    size="sm"
                    class="absolute bottom-4 right-4 z-40 flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 shadow-popover"
                    aria-label={i18n.t("kernel.shellUi.chats")}
                    data-testid="chats-sheet-opener"
                    onClick={() => toggleChats()}
                  >
                    <AgentGlyph class="text-accent" />
                  </Button>
                </Show>
              </MainPanel>
              {(() => {
                // Desktop docks the panel in its own grid column. Tablet and
                // phone render it as an overlay sheet instead, so it takes no
                // grid track there.
                const panelGridStyle = () =>
                  shellTier() === "desktop"
                    ? { "grid-column": "4", "grid-row": "1" }
                    : ({} as JSX.CSSProperties)

                const isAppPanel = () => activePanel()?.type === "app-panel"

                const panelContent = () => (
                  <>
                    <Show when={isAppPanel()}>
                      <div class="flex flex-col h-full overflow-hidden" style={panelGridStyle()}>
                        <PluginMountBoundary appName={activePanel()?.appName ?? "unknown"}>
                          <Dynamic
                            component={(() => {
                              const panel = activePanel()
                              if (panel?.type !== "app-panel") return undefined
                              return (
                                getPanel(namespaceRegistryKey(panel.appName, panel.panelType))
                                  ?.component ?? undefined
                              )
                            })()}
                            context={activePanel()?.context}
                          />
                        </PluginMountBoundary>
                      </div>
                    </Show>
                  </>
                )

                // Tablet and phone float the panel over the content as a
                // full-screen sheet driven by the same `panelOpen()` signal;
                // desktop keeps the docked grid column.
                return (
                  <Show
                    when={shellTier() === "desktop"}
                    fallback={
                      <OverlaySheet
                        open={panelOpen()}
                        onClose={() => togglePanel()}
                        variant="full"
                        closeLabel={i18n.t("kernel.close")}
                      >
                        {panelContent()}
                      </OverlaySheet>
                    }
                  >
                    {panelContent()}
                  </Show>
                )
              })()}
            </div>
            {/*
              P4c-T14: the Chats sheet is the tablet/phone counterpart of the
              desktop dock, so it hangs off the SHELL, not off the app panel.
              It used to be mounted inside `panelContent()`, which at tablet
              and phone only renders inside the app-panel OverlaySheet: with no
              app panel open the sheet was not in the DOM at all and every
              conversation was unreachable below 1024px.
            */}
            <Show when={!dockAvailable()}>
              <ChatsSheet />
            </Show>
            <CommandPalette
              isOpen={commandPaletteOpen()}
              onClose={() => setCommandPaletteOpen(false)}
            />
            {/*
              The mailbox unlock modal lives at the SHELL, not inside the mail
              inbox. Tabs are keep-alive: an inactive tab stays mounted with
              `display: none`, so a host mounted inside the inbox renders the
              modal into a hidden subtree whenever the reader is in a
              CONVERSATION tab, which is exactly where the locked placeholder
              offers "Unlock mailbox". Mounted there, that button appeared to do
              nothing and a locked mailbox could not be opened at all from a
              conversation.
            */}
            <MailboxUnlockHost userId={userFromToken()?.userId ?? null} />
            {/*
              The two-phase agent read protocol (the unlock assertion on the
              socket, the turn nonce, the responder for the server's decrypt and
              search requests), at the shell for the same reason: a chat turn
              from any tab and a routine's Run now on Home need it, with no Mail
              tab open. Without it every private-mailbox read reads as locked.
            */}
            <MailboxAgentHost />
            {/*
              The connect dialog (credential form or OAuth sign-in) an app's
              settings pane opens with `app.openConnectDialog`, and Settings >
              Apps with its rows and its connect deep link: at the shell for the
              same reason, it belongs over whichever tab asked for it.
            */}
            <ConnectDialogHost />
            <AppApprovalConfirmHost />
            {/*
              P6d-FX5 (W5): a device grant raised while the user is signed in.
              At the SHELL for the same reason the unlock modal is: the grant
              is raised by the shell starting a session, and the surface that
              asked for it (a runtime control in a header, in a tab that may be
              hidden) is not where a question blocking everything belongs. A
              browser has no bridge and this renders nothing at all.
            */}
            <DesktopDeviceApprovalDialog />
            <DesktopConnectDialog />
            <ClaudeSignInDialog />
            <NewChannelDialog />
            <NewMessageDialog />
            {/*
              Guided tours: the panel, its spotlight and the resume chip float
              over the app without blocking it, so they hang off the shell,
              not off a tab (an inactive tab is display:none).
            */}
            <TourHost />
            <KeyboardShortcutsOverlay
              isOpen={shortcutsOpen()}
              onClose={() => setShortcutsOpen(false)}
            />
            <ToastContainer />
            <UnsavedWorkConfirm />
          </PanelProvider>
        </WsStatusContext.Provider>
      </WsProvider>
    </ApiProvider>
  )
}

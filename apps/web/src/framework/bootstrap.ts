// SPDX-License-Identifier: FSL-1.1-ALv2
// Kernel app registrations — imports from domain stores live HERE, not in app-registry.
// bootstrap.ts is a leaf module: it imports from stores, but no store imports from it.

import { Home, LayoutGrid, MessageSquare, Search, Settings, Terminal } from "lucide-solid"
import { createRoot, lazy } from "solid-js"
import {
  getConnectorApps,
  namespaceRegistryKey,
  registerActivityBarEntry,
  registerEntityOpener,
  registerManifestAppData,
  setManifestAppsSettled,
  unregisterTabTypes,
} from "~/framework/app-registry"
import { clearCompatMode, noteCompatMode } from "~/framework/compat-mode"
import {
  registerApp,
  registerAppFromManifest,
  registerAppSettingsRoute,
  unregisterApp,
} from "~/framework/define-app"
import {
  collectDeclaredComponentNames,
  collectSettingsBlockComponentNames,
} from "~/framework/manifest-exports"
import { loadOrgFeatures, setEnabledOrgFeatures } from "~/framework/org-features"
import { subscribeResync } from "~/framework/resync"
import { isAppUnavailable, onAppsChanged, setUnavailableApps } from "~/framework/unavailable-apps"
import { onApiReady } from "~/lib/api-ready"
import { registerAppDisplayName } from "~/lib/capability-copy"
import { apiUrl, serverAddressOverride } from "~/lib/env"
import { onSessionStart, onSessionTeardown } from "~/lib/session-lifecycle"
import { scopeRequestsStore } from "~/modules/admin-scope-requests/scope-requests-store"
import { registerAgentApp } from "~/modules/agent/agent-app"
import {
  ensureLoaded as ensureApprovalLoaded,
  handleWsCreate as handleApprovalWsCreate,
  handleWsUpdate as handleApprovalWsUpdate,
} from "~/modules/approvals/approvals-store"
import { installDecisionFlush, resendStoredDecisions } from "~/modules/approvals/decision-queue"
import { registerEntityPreviews as registerApprovalPreviews } from "~/modules/approvals/entity-preview-renderers"
import HomeIconWithDot from "~/modules/approvals/HomeIconWithDot"
import {
  accessToken,
  canAccessScope,
  inWrappedShell,
  userFromToken,
} from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { registerEntityPreviews as registerUserPreviews } from "~/modules/auth/entity-preview-renderers"
import { subscribeContactDetailResync } from "~/modules/contacts/contact-detail-store"
import { subscribeContactsResync } from "~/modules/contacts/contact-list-store"
import { handleFileEvent } from "~/modules/files/file-events"
import { tNow } from "~/modules/i18n/i18n-context"
import { importRunStore } from "~/modules/imports/import-run-store"
import { subscribeKnowledgeResync } from "~/modules/knowledge/knowledge-store"
import { subscribeMailResync } from "~/modules/mail/mail-conversation-store"
import {
  evictConversationMessages,
  handleMailApprovalWs,
  subscribeMailMessageResync,
} from "~/modules/mail/mail-message-store"
import { applyRemoteAgentMailAccess } from "~/modules/mailbox/agent-mail-access"
import { agentMailAccessSyncDeps } from "~/modules/mailbox/mailbox-store"
import {
  applyNodeFrame,
  installNodesStoreSync,
  loadNodes,
  setNodesStoreApi,
} from "~/modules/nodes/nodes-store"
import { startDesktopBadge } from "~/modules/notifications/desktop-badge"
import { startTabBadge } from "~/modules/notifications/tab-badge"
import { subscribeProjectResync } from "~/modules/projects/project-store"
import { subscribeProjectsResync } from "~/modules/projects/projects-store"
import { secretRequestStore } from "~/modules/secret-request/secret-request-store"
import { registerSessionCacheLifecycle } from "~/modules/sessions/session-cache-lifecycle"
import { ensureListLoaded, needsYouCount, setSessionListApi } from "~/modules/sessions/session-list"
import {
  applyEvent,
  applyRow,
  installSessionStoreSync,
  setSessionStoreApi,
} from "~/modules/sessions/session-store"
import { startOrgAppRows } from "~/modules/settings/app-management/org-app-rows"
import {
  type OrgAppUpdateEvent,
  orgAppsStore,
} from "~/modules/settings/app-management/org-apps-store"
import {
  registerAppSettingsPage,
  unregisterAppSettingsPage,
} from "~/modules/settings/app-page/app-settings-pages"
import { hasUnsupportedSettings } from "~/modules/settings/app-page/supported"
import { billingMode } from "~/modules/settings/BillingState"
import { notifyCreditUpdate } from "~/modules/settings/credit-store"
import { appSettingsPath, SETTINGS_CONNECTORS_PATH } from "~/modules/settings/settings-aliases"
import { canSeePageSection } from "~/modules/settings/visible-settings-sections"
import { attentionStore, getAttentionApi } from "~/modules/shell/attention-store"
import { surfaceIncoming } from "~/modules/shell/dock-store"
import {
  closeTab,
  makeTabId,
  registerTabEvictor,
  tabStore,
  updateTabLabel,
  validateTabs,
} from "~/modules/shell/tab-store"
import { conversationDisplayName, isChannel } from "~/modules/threads/conversation-display"
import { registerEntityPreviews as registerThreadPreviews } from "~/modules/threads/entity-preview-renderers"
import { handleFollowedRepliesMessageEvent } from "~/modules/threads/followed-replies-store"
import {
  evictThreadMessages,
  handleVisibilityInvalidate,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  handleWsReactionEvent,
  handleWsSubRunUpdate,
  refetchThreadMessages,
  subscribeMessageResync,
} from "~/modules/threads/message-store"
import { handleOutsideTextApprovalCreate } from "~/modules/threads/outside-text-pulse"
import { togglePersonalAgentChat } from "~/modules/threads/personal-dm-store"
import {
  handlePresenceSync,
  handlePresenceUpdate,
  handleTypingStart,
} from "~/modules/threads/presence-store"
import { handleReadStateEvent } from "~/modules/threads/read-state-sync"
import { userIsLookingAtWindow } from "~/modules/threads/reading-focus"
import { ThreadTabIcon } from "~/modules/threads/ThreadTabIcon"
// Domain store imports — safe here because bootstrap.ts is a leaf module
import {
  getThread,
  handleMessageEvent,
  handleParticipantEvent,
  handleThreadEvent,
  handleTypingEvent,
  markThreadRead,
  removeThread,
  requestThreadReload,
  subscribeThreadResync,
  subscribeThreadsKnown,
} from "~/modules/threads/thread-store"
import { noteThreadChangedForTabs, threadTabLabel } from "~/modules/threads/thread-tab-names"
import { messagesUnreadCount } from "~/modules/threads/unread-count-store"
import {
  evictTicketDetail,
  subscribeTicketDetailResync,
} from "~/modules/tickets/ticket-detail-store"
import {
  handleTicketApprovalCreate,
  handleTicketApprovalUpdate,
} from "~/modules/tickets/ticket-message-store"
import { browserAppFrameUrl, isolatedAppExports, isolatedFrameUrl } from "./isolated-app"
import { importAppModule, verifiedFirstPartyApp } from "./verified-app"

// --- Chat dock surfacing ---
//
// WHAT COUNTS AS AN INCOMING MESSAGE, judged by the message's AUTHOR and never
// by the event's actor. `ctx.isOwnAction` compares the event's actorId with the
// viewer, and an agent's reply carries the HUMAN WHO TRIGGERED IT as the actor:
// judged by the actor, an agent answering in your own DM looks like something
// you said, and the one reply you are actually waiting for is the one that
// never surfaces.
//
// Only a person other than the viewer, or a routine's unprompted post, is worth surfacing. System
// and MCP authored rows are bookkeeping ("X joined", a tool trace) and must
// never pop a window. This is the same pair of rules, in the same order, that
// the server applies before it sends a desktop `notify` frame.
function isIncomingMessage(data: any, currentUserId: string): boolean {
  const authorType = data?.authorType ?? "user"
  if (authorType !== "user" && authorType !== "agent") return false
  // A routine's post (its summary, an approval it asks for) carries its owner
  // as author like every agent row of theirs, but nobody asked for it there:
  // it is news to them (`unprompted`, routine-report.ts).
  if (authorType === "agent" && data?.unprompted === true) return true
  return data?.authorId !== currentUserId
}

// Conversations whose first message arrived before their thread row did, with
// the viewer they arrived for. Bounded: a burst on threads that never load
// (no longer a participant, archived) must not grow without limit.
/** One component for every computer page, so a tab change never remounts it. */
const ComputerPage = lazy(() => import("~/modules/settings/computers/ComputerPage"))

// The declarative settings pages: every app's page (`/settings/apps/<app>`),
// the Connectors page and one MCP server's page on it. The page registry is a
// small store loaded with the shell; the pages themselves load on first visit.
const AppSettingsPage = lazy(() =>
  import("~/modules/settings/app-page").then((m) => ({ default: m.AppSettingsPage })),
)
const ConnectorsPage = lazy(() =>
  import("~/modules/settings/connectors").then((m) => ({ default: m.ConnectorsPage })),
)
const McpServerDetailPage = lazy(() =>
  import("~/modules/settings/connectors").then((m) => ({ default: m.McpServerDetailPage })),
)
const MCP_SERVER_PATH = /^\/settings\/connectors\/mcp\/[^/]+\/?$/
const AppStorePage = lazy(() =>
  import("~/modules/settings/app-store").then((m) => ({ default: m.AppStorePage })),
)
const AppStoreDetail = lazy(() =>
  import("~/modules/settings/app-store").then((m) => ({ default: m.AppStoreDetail })),
)
const STORE_DETAIL_PATH = /^\/settings\/store\/[^/]+\/?$/

const MAX_PENDING_DOCK_SURFACING = 32
const pendingDockSurfacing = new Map<string, string>()

function rememberPendingDockSurfacing(threadId: string, currentUserId: string): void {
  if (pendingDockSurfacing.size >= MAX_PENDING_DOCK_SURFACING) {
    const oldest = pendingDockSurfacing.keys().next()
    if (!oldest.done) pendingDockSurfacing.delete(oldest.value)
  }
  pendingDockSurfacing.set(threadId, currentUserId)
}

// Runs on every row-adding write to the thread store. A parked id is spent the
// first time its row is present, whatever the verdict: a refusal here is a
// permanent fact about the conversation, so a refused thread is dropped rather
// than re-judged on every later write.
//
// The refusals are RE-CHECKED at drain time, not inherited from parking time,
// because the row can arrive precisely BECAUSE the user opened that
// conversation (a deep link fetches it): popping a floating copy of the
// conversation they are looking at is exactly what the visible-active-tab rule
// exists to prevent. The viewer is re-checked for the same reason in reverse:
// a parked id belongs to the session that received it, and a teardown plus a
// different sign-in must not pop one person's DM into another's dock.
function drainPendingDockSurfacing(): void {
  if (pendingDockSurfacing.size === 0) return
  const viewer = userFromToken()?.userId ?? null
  const documentVisible =
    typeof document === "undefined" ? true : document.visibilityState !== "hidden"
  for (const [threadId, parkedFor] of [...pendingDockSurfacing]) {
    if (parkedFor !== viewer) {
      pendingDockSurfacing.delete(threadId)
      continue
    }
    const thread = getThread(threadId)
    if (!thread) continue
    pendingDockSurfacing.delete(threadId)
    if (tabStore.activeTabId === makeTabId("thread", threadId) && documentVisible) continue
    if (isChannel(thread, parkedFor)) continue
    surfaceIncoming(threadId)
  }
}

let dockSurfacingSubscribed = false

function subscribeDockSurfacing(): void {
  if (dockSurfacingSubscribed) return
  dockSurfacingSubscribed = true
  subscribeThreadsKnown(drainPendingDockSurfacing)
}

let bootstrapped = false

function loadNodesOnApi(): void {
  void loadNodes()
}

export function bootstrapKernelApps(): void {
  if (bootstrapped) return
  bootstrapped = true

  // Every app's declarative settings page renders through this component.
  registerAppSettingsRoute({
    page: AppSettingsPage,
    registerPage: registerAppSettingsPage,
    unregisterPage: unregisterAppSettingsPage,
  })

  // Module-lifetime, registered once: the drain has to keep working across a
  // registry reset, and a second subscription would double every surfacing.
  subscribeDockSurfacing()

  // Admins' Apps rows for apps the manifests feed omits (an app turned Off).
  createRoot(() => startOrgAppRows())

  // The apps this person can use changed (a request refused because they lost
  // an app, or this admin's own add, remove, On or Off): resync the feed so the
  // entry comes or goes now, not at the next reload.
  onAppsChanged(() => {
    void reloadManifestApps().catch(() => {})
    reloadAttentionForAppChange()
  })

  const HomeSidebar = lazy(() => import("~/modules/threads/HomeSidebar"))
  // D21: Home's own sidebar (what is asked of you), not the Messages list.
  const HomeAttentionSidebar = lazy(() => import("~/modules/shell/HomeAttentionSidebar"))
  const SettingsSidebar = lazy(() =>
    import("~/modules/settings/SettingsSidebar").then((m) => ({ default: m.SettingsSidebar })),
  )

  // P1-T23 (C4, D40): node session rows and events, kept live and healed by
  // pull through the kernel API client the attention store already holds.
  setSessionStoreApi(getAttentionApi)
  installSessionStoreSync()
  // S58 (batch-5 F3): the session events disk cache is the signed-in user's
  // on this server, and it ends with every end of the login.
  registerSessionCacheLifecycle()
  // P2-T16: the Sessions list loads at sign-in, so the rail badge is right
  // before the app is opened (idempotent; a restored token starts it too).
  setSessionListApi(getAttentionApi)
  void ensureListLoaded()
  onSessionStart(() => void ensureListLoaded())
  // P2-T05 (S18, L27): the owner's nodes, live through `kernel:node` frames.
  // F3: the first read waits for the client. On a reload or a sign-in the
  // session starts BEFORE the client is registered (the nodes store's own
  // session-start hook ran with none), so the list read "No node" until New
  // was opened. Load whenever a client is registered; `loadNodes` is once.
  setNodesStoreApi(getAttentionApi)
  installNodesStoreSync()
  void loadNodes()
  onApiReady(loadNodesOnApi)
  // S15: approve and reject wait out an Undo window (decision-queue.ts). They
  // are flushed as the page goes away, and what a closed page left queued is
  // sent at the next boot, once a client is registered and the session it
  // belongs to has started (a decision is resent only to the account and the
  // server that made it).
  installDecisionFlush()
  const resendDecisions = (): void => {
    const api = getAttentionApi()
    if (api) void resendStoredDecisions(api)
  }
  onApiReady(resendDecisions)
  onSessionStart(resendDecisions)

  // --- Kernel app ---
  registerApp({
    name: "kernel",
    tabTypes: {
      home: {
        component: lazy(() => import("~/modules/shell/Home")),
        sidebar: HomeAttentionSidebar,
        icon: Home,
        urlPattern: "/",
        defaultLabel: "Home",
        defaultLabelKey: "kernel.nav.home",
        singleton: true,
        referenceable: false,
      },
      thread: {
        component: lazy(() => import("~/modules/threads/ThreadView")),
        // F4 — the phone top bar is this conversation's nav bar: title, agent
        // state, actions. Off the phone tier nothing renders it.
        phoneHeader: lazy(() => import("~/modules/threads/ThreadPhoneHeader")),
        sidebar: HomeSidebar,
        icon: MessageSquare,
        entityIcon: ThreadTabIcon,
        urlPattern: "/threads/:entityId",
        defaultLabel: "Thread",
        // The list's copy, else the conversation read by id: a tab whose
        // conversation left the list (archived, or beyond the 50 most recent)
        // still carries its current name (thread-tab-names.ts).
        resolveLabel: (entityId) => threadTabLabel(entityId, userFromToken()?.userId ?? ""),
        validateEntity: async (entityId) => {
          try {
            // Ensure fresh token before validating — stale tokens produce 401
            // which we'd misinterpret as "entity still valid"
            await authManager.ensureFreshToken().catch(() => {})
            const token = accessToken()
            const res = await fetch(apiUrl(`/threads/${entityId}`), {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
            // Only evict on definitive "gone" or "forbidden" — not on transient server errors
            if (res.status === 404 || res.status === 403) return false
            return true
          } catch {
            return true // Network error — don't evict
          }
        },
        referenceable: false,
      },
      // P2-T16 (S8): one node session in the Sessions app, the list as its
      // sidebar. The route keeps its query (`?request=`, the chat card's
      // Review and P4's push land on that request card).
      session: {
        component: lazy(() => import("~/modules/sessions/SessionView")),
        // P4-T10: the phone top bar is back to the list, the title and Stop.
        phoneHeader: lazy(() => import("~/modules/sessions/SessionPhoneHeader")),
        sidebar: lazy(() => import("~/modules/sessions/SessionList")),
        icon: Terminal,
        urlPattern: "/sessions/:entityId",
        defaultLabel: "Session",
        defaultLabelKey: "kernel.nodeSessions.view.title",
        preserveSubRoutes: true,
        referenceable: false,
      },
      // The Sessions app with no session picked (`/sessions`).
      sessions: {
        component: lazy(() => import("~/modules/sessions/SessionsHome")),
        sidebar: lazy(() => import("~/modules/sessions/SessionList")),
        icon: Terminal,
        urlPattern: "/sessions",
        defaultLabel: "Sessions",
        defaultLabelKey: "kernel.nodeSessions.app.title",
        singleton: true,
        referenceable: false,
      },
      // S8: the owner's Claude Code sessions on a computer, to Follow or
      // Take over (`/import-sessions`, the Sessions list as its sidebar).
      "session-import": {
        component: lazy(() => import("~/modules/sessions/ImportSessionsView")),
        sidebar: lazy(() => import("~/modules/sessions/SessionList")),
        icon: Terminal,
        urlPattern: "/import-sessions",
        defaultLabel: "Import sessions",
        defaultLabelKey: "kernel.nodeSessions.import.tabTitle",
        singleton: true,
        referenceable: false,
      },
      // The phone ROOT of this tab is the You screen, which owns a large title
      // of its own, so the shell's generic bar above it was a second header
      // saying the same thing. Like `work`, `chats` and `approvals` it hides
      // the bar entirely: the You rows ARE the navigation, and a section
      // pushed on top of them carries its own `settings-phone-back` header.
      settings: {
        component: lazy(() => import("~/modules/settings/SettingsLayout")),
        hidePhoneTopBar: true,
        sidebar: SettingsSidebar,
        icon: Settings,
        urlPattern: "/settings",
        defaultLabel: "Settings",
        defaultLabelKey: "kernel.nav.settings",
        singleton: true,
        preserveSubRoutes: true,
        referenceable: false,
      },
      // M1-A T3 — the phone Work screen: one grouped list of every module and
      // installed app the user can reach. It registers NO activity-bar entry,
      // so the desktop rail never shows it; the phone bar seats it directly.
      // F3: it owns a large title of its own now, so it hides the top bar
      // entirely instead of showing "Work" in the bar (the previous layout
      // showed BOTH the bar's small "Work" title and the org name, while
      // Chats — before this fix — showed neither its own title nor a
      // consistently placed org name).
      work: {
        component: lazy(() => import("~/modules/shell/Work")),
        hidePhoneTopBar: true,
        sidebar: null,
        icon: LayoutGrid,
        urlPattern: "/work",
        defaultLabel: "Work",
        defaultLabelKey: "kernel.phoneTabWork",
        singleton: true,
        referenceable: false,
      },
      // F3 — the phone Chats ROOT. Like `work` it registers no activity-bar
      // entry, so the desktop rail is untouched and only the phone bar's own
      // seat lands on it. Picking a row pushes `/threads/:id` on top of it.
      // The screen's own large title (HomeSidebar's phone-dock "Chats" h1)
      // hides the bar entirely rather than sharing it with a `phoneHeader`.
      chats: {
        component: lazy(() => import("~/modules/shell/ChatsScreen")),
        hidePhoneTopBar: true,
        // The Messages app's conversation list is a real sidebar at desktop
        // and tablet width (the same one a conversation tab shows), so it
        // takes the shell's sidebar column and tablet drawer like every other
        // app's. The phone never shows it: its Chats root IS the list.
        sidebar: HomeSidebar,
        icon: MessageSquare,
        urlPattern: "/chats",
        defaultLabel: "Chats",
        defaultLabelKey: "kernel.dock.chats",
        singleton: true,
        referenceable: false,
      },
      // M2-1 T12 — the approvals queue as a screen. Like `work` and `chats` it
      // registers no activity-bar entry, so the desktop rail is untouched; it
      // is the phone surface for deciding a pile of approvals in a row.
      // K2: it owns a large title of its own (like `work`/`chats`), so it
      // hides the phone top bar entirely too — it used to show the shell's
      // generic bar ABOVE its own title, doubling the header.
      approvals: {
        component: lazy(() => import("~/modules/approvals/ApprovalsScreen")),
        hidePhoneTopBar: true,
        sidebar: null,
        icon: HomeIconWithDot,
        urlPattern: "/approvals",
        defaultLabel: "Approvals",
        defaultLabelKey: "kernel.nav.approvals",
        singleton: true,
        referenceable: false,
      },
      search: {
        component: lazy(() => import("~/modules/search/SearchTab")),
        sidebar: HomeSidebar,
        icon: Search,
        urlPattern: "/search",
        defaultLabel: "Search",
        defaultLabelKey: "kernel.nav.search",
        singleton: true,
        referenceable: false,
      },
      // Phase 16.6 — Generic detail tab. `entityId` is "<appName>/<entity>/<id>".
      // DetailTab resolves the matching plugin panel from the registry and
      // mounts it inside <PluginMountBoundary>. Plugins register their panels
      // automatically via `views.detail.<entity>` (consumed by define-app.ts).
      detail: {
        component: lazy(() => import("~/framework/DetailTab")),
        sidebar: HomeSidebar,
        icon: Search,
        urlPattern: "/detail/:entityId+",
        defaultLabel: "Detail",
        defaultLabelKey: "kernel.nav.detail",
        referenceable: false,
      },
    },
    activityBar: {
      icon: HomeIconWithDot,
      label: "Home",
      labelKey: "kernel.nav.home",
      order: 0,
      tabAction: { type: "home", entityId: "home", label: "Home" },
    },
    // The settings column (settings overhaul S12, S16): You, AI, Workspace,
    // then every app's one page and the Connectors page. Former paths of the
    // pages merged here live in modules/settings/settings-aliases.ts.
    settings: [
      {
        id: "profile",
        label: "Profile",
        labelKey: "kernel.nav.section.profile",
        href: "/settings",
        component: lazy(() => import("~/modules/settings/ProfileSettings")),
        group: "user",
        order: 0,
      },
      {
        // Security: the viewer's own sign-in, then (org admins) the
        // organisation's sign-in methods: the email link, SSO providers, the
        // Google client and the admin second-factor rule.
        id: "security",
        label: "Security",
        labelKey: "kernel.nav.section.security",
        href: "/settings/security",
        component: lazy(() => import("~/modules/settings/SecuritySettings")),
        group: "user",
        order: 10,
      },
      {
        // Settings -> Notifications (S8): the grid, the digest, work hours, the
        // per-app rules and this device, on one screen.
        id: "notifications",
        label: "Notifications",
        labelKey: "kernel.nav.section.notifications",
        href: "/settings/notifications",
        component: lazy(() => import("~/modules/settings/NotificationSettings")),
        group: "user",
        order: 15,
      },
      {
        // Settings > Computers: every computer of the viewer's, this
        // computer's setup in the desktop app, and each computer's page
        // (/settings/computers/:id[/agents|/settings]) with its Folders,
        // Agents and Settings tabs. It replaced "This computer" and "Nodes".
        id: "computers",
        label: "Computers",
        labelKey: "kernel.nav.section.computers",
        href: "/settings/computers",
        component: lazy(() => import("~/modules/settings/computers/ComputersSettings")),
        group: "user",
        order: 16,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) =>
          /^\/settings\/computers\/[^/]+(\/(folders|agents|settings))?\/?$/.test(pathname)
            ? ComputerPage
            : null,
      },
      {
        // The former "Nodes" page; its links (with `?node=&folder=`) land on Computers.
        id: "nodes",
        label: "Computers",
        labelKey: "kernel.nav.section.computers",
        href: "/settings/nodes",
        component: lazy(() =>
          import("~/modules/settings/computers/ComputerRedirects").then((m) => ({
            default: m.NodesRedirect,
          })),
        ),
        group: "user",
        order: 16.1,
        hidden: true,
      },
      {
        // The former "This computer" page: this computer's page, or the list.
        id: "this-computer",
        label: "Computers",
        labelKey: "kernel.nav.section.computers",
        href: "/settings/this-computer",
        component: lazy(() =>
          import("~/modules/settings/computers/ComputerRedirects").then((m) => ({
            default: m.ThisComputerRedirect,
          })),
        ),
        group: "user",
        order: 16.2,
        hidden: true,
      },
      {
        // Connected tools: Liaison used from Claude, Cursor and other AI tools
        // over MCP, then the viewer's own MCP servers.
        id: "connected-tools",
        label: "Connected tools",
        labelKey: "kernel.nav.section.connectedTools",
        href: "/settings/connected-tools",
        component: lazy(() => import("~/modules/settings/ConnectionsSettings")),
        group: "user",
        order: 18,
      },
      {
        // AI > Models (S9): Auto, provider keys, which models the org's
        // pickers offer, OpenRouter and own-server models.
        id: "ai-models",
        label: "Models",
        labelKey: "kernel.nav.section.models",
        href: "/settings/ai-models",
        component: lazy(() => import("~/modules/settings/AiModelsSettings")),
        group: "ai",
        adminScope: "kernel:org:admin",
        order: 24.5,
      },
      {
        // AI > Agent behavior: outside content and media analysis.
        id: "agent-behavior",
        label: "Agent behavior",
        labelKey: "kernel.nav.section.agentBehavior",
        href: "/settings/ai/agent-behavior",
        component: lazy(() => import("~/modules/settings/AgentBehaviorSettings")),
        group: "ai",
        adminScope: "kernel:org:admin",
        order: 25,
      },
      {
        id: "usage",
        label: "Usage",
        labelKey: "kernel.nav.section.usage",
        href: "/settings/usage",
        component: lazy(() => import("~/modules/settings/UsageSettings")),
        group: "ai",
        adminScope: "kernel:billing:read",
        order: 102,
      },
      {
        id: "plan",
        label: "Plan",
        labelKey: "kernel.nav.section.plan",
        href: "/settings/plan",
        component: lazy(() => import("~/modules/settings/PlanSettings")),
        group: "ai",
        adminScope: "kernel:org:admin",
        order: 103,
        visibleWhen: () => billingMode() === "managed",
      },
      {
        // Workspace > Billing (managed edition, S17): plan, card, invoices,
        // credits, top-ups; payments run in the payment frame.
        id: "billing",
        label: "Billing",
        labelKey: "kernel.nav.section.billing",
        href: "/settings/billing",
        component: lazy(() => import("~/modules/settings/BillingSettings")),
        group: "admin",
        adminScope: "kernel:org:admin",
        order: 19.5,
        visibleWhen: () => billingMode() === "managed",
      },
      {
        // Workspace > Organization: details, then the data export.
        id: "org",
        label: "Organization",
        labelKey: "kernel.nav.section.org",
        href: "/settings/admin/org",
        component: lazy(() => import("~/modules/settings/OrganizationSettings")),
        group: "admin",
        adminScope: "kernel:org:admin",
        order: 19,
      },
      {
        // Workspace > Documents: the organisation's document templates; one
        // template's page at /settings/admin/documents/<id>.
        id: "documents",
        label: "Documents",
        labelKey: "kernel.nav.section.documents",
        href: "/settings/admin/documents",
        component: lazy(() => import("~/modules/settings/documents/DocumentsSettings")),
        group: "admin",
        adminScope: "kernel:org:admin",
        order: 19.5,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) => {
          if (/^\/settings\/admin\/documents\/[^/]+$/.test(pathname)) {
            return lazy(() => import("~/modules/settings/documents/DocumentTemplateDetail"))
          }
          return null
        },
      },
      {
        id: "users",
        label: "Users",
        labelKey: "kernel.nav.section.users",
        href: "/settings/admin/users",
        component: lazy(() => import("~/modules/settings/AdminUsers")),
        group: "admin",
        adminScope: "kernel:users:admin",
        order: 20,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) => {
          if (/^\/settings\/admin\/users\/[^/]+$/.test(pathname)) {
            return lazy(() => import("~/modules/settings/AdminUserDetail"))
          }
          return null
        },
      },
      {
        // Workspace > Roles & access: roles, access requests and data access;
        // a role's own page at /settings/admin/roles/<id>.
        id: "roles",
        label: "Roles & access",
        labelKey: "kernel.nav.section.rolesAccess",
        href: "/settings/admin/roles",
        component: lazy(() => import("~/modules/settings/RolesAccessSettings")),
        group: "admin",
        adminScope: "kernel:users:admin",
        order: 22,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) => {
          if (/^\/settings\/admin\/roles\/[^/]+$/.test(pathname)) {
            return lazy(() => import("~/modules/settings/AdminRoleDetail"))
          }
          return null
        },
      },
      {
        // Workspace > App store (S21): the list, and one app's listing at
        // `/settings/store/<app>`.
        id: "store",
        label: "App store",
        labelKey: "kernel.nav.section.appStore",
        href: "/settings/store",
        component: AppStorePage,
        group: "admin",
        adminScope: "kernel:apps:admin",
        order: 30.5,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) => (STORE_DETAIL_PATH.test(pathname) ? AppStoreDetail : null),
      },
      {
        id: "system",
        label: "System",
        labelKey: "kernel.nav.section.system",
        href: "/settings/system",
        component: lazy(() => import("~/modules/settings/SystemSettings")),
        group: "admin",
        adminScope: "kernel:org:admin",
        order: 60,
      },
      {
        // Connectors: one card per connector the viewer administers, and the
        // organisation's MCP servers (org admins). Its group heading is the
        // link (D26); `/settings/connectors/mcp/<id>` is one MCP server.
        id: "connectors",
        label: "Connectors",
        labelKey: "kernel.nav.section.connectors",
        href: "/settings/connectors",
        component: ConnectorsPage,
        group: "connectors",
        order: 200,
        preserveActiveOnSubpaths: true,
        resolveRoute: (pathname) => (MCP_SERVER_PATH.test(pathname) ? McpServerDetailPage : null),
        visibleWhen: () =>
          canAccessScope("kernel:org:admin") ||
          getConnectorApps().some((c) => c.sections.some(canSeePageSection)),
      },
    ],
    commands: [
      {
        id: "toggle-chat",
        label: "Toggle chat",
        // Same spec the Shell keybinding registers, so the palette names the
        // keystroke the reader actually presses.
        shortcut: "mod+.",
        execute: () => {
          void togglePersonalAgentChat().catch(() => {
            /* no personal agent yet: the command is a no-op */
          })
        },
      },
      {
        // Alias kept for one release so a muscle-memory palette entry and any
        // recorded command id still work. REMOVAL DATE: the first release
        // after the one that ships the chat dock (P4c); confirmed still
        // wanted at the P4c remnant audit (T47, 2026-09-15).
        id: "toggle-agent-panel",
        label: "Toggle chat",
        alias: true,
        execute: () => {
          void togglePersonalAgentChat().catch(() => {
            /* no personal agent yet: the command is a no-op */
          })
        },
      },
    ],
    wsHandlers: {
      // Owner-only frames (the server filters them, C4): the session row with
      // its lastSeq, and each new event (D40).
      node_session: (_action, data) => applyRow(data),
      node_session_event: (_action, data) => applyEvent(data),
      // Owner-only too (S18): a node change; the nodes store refetches.
      node: (_action, data) => applyNodeFrame(data),
      // A file landed on (or left) a record: the shelf showing that record refetches.
      file: (action, data) => handleFileEvent(action, data),
      thread: (action, data) => {
        // A DM with an agent is a thread row like any other since the panel
        // retired (P4c-T17): its events go to the thread store, which is what
        // the Home list and the dock both read. They used to be diverted to
        // the panel's private chat list and dropped here.
        //
        // A thread promoted out of a DM has changes.type = "thread" but is not
        // in the store yet — treat that update as a create.
        // but the thread isn't in the store yet — treat it as a create
        if (action === "update" && data?.changes?.type === "thread" && !getThread(data.id)) {
          handleThreadEvent("create", { ...data, ...data.changes })
        } else {
          handleThreadEvent(action, data)
        }
        // Sync tab labels when thread data changes (e.g. title update, participant change)
        if (action === "update" || action === "create") {
          noteThreadChangedForTabs(data?.id, data?.changes)
          const tabId = makeTabId("thread", data?.id)
          const tab = tabStore.tabs.find((t) => t.id === tabId)
          if (tab) {
            const thread = getThread(data?.id)
            if (thread) {
              const label = conversationDisplayName(thread, userFromToken()?.userId ?? "")
              if (label !== tab.label) updateTabLabel(tabId, label)
            }
          }
        }
      },
      // Another device of this reader moved a read mark: drop the unread
      // state here too, live (the frame reaches the reader's sockets only).
      read_state: (action, data) => {
        handleReadStateEvent(action, data, {
          reloadAttention: () => {
            const api = getAttentionApi()
            if (api) attentionStore.markStaleAndReload(api)
          },
          applyAgentMailAccess: (record) => {
            void applyRemoteAgentMailAccess(record, agentMailAccessSyncDeps())
          },
        })
      },
      message: [
        {
          owner: "thread-projection",
          priority: 10,
          handler: (action, data, ctx) => {
            handleMessageEvent(action, data, {
              // Read as it arrives only when the user is looking: a visible
              // page in a window behind other apps is not being read, and its
              // read mark would clear the pill on the reader's other devices.
              isVisibleActiveThread:
                ctx.activeTabId === makeTabId("thread", data?.threadId) &&
                ctx.isDocumentVisible &&
                userIsLookingAtWindow(),
              isOwnAction: ctx.isOwnAction,
              onReadWhileVisible: (threadId) => {
                const api = getAttentionApi()
                if (api) markThreadRead(api, threadId)
              },
            })
          },
        },
        {
          // An incoming message POPS ITS CONVERSATION INTO THE DOCK, the way a
          // chat bar does: a collapsed pill, quietly, so the message is one
          // click away instead of only a number in the sidebar. The dock's own
          // rules (desktop tier, never a second tab for the same thread) live
          // in `surfaceIncoming`; the product rules live here.
          //
          // NOT surfaced: the viewer's own message; a channel (the same
          // `isChannel` classifier the sidebar groups by, so a room can never
          // start piling pills up); a thread the store has not loaded yet
          // (it cannot be classified, and the self-heal handler below reloads
          // it anyway); and the conversation that is already the visible
          // active tab, which needs no floating copy of itself.
          owner: "dock-surfacing",
          priority: 15,
          handler: (action, data, ctx) => {
            if (action !== "create") return
            const threadId = data?.threadId
            if (!threadId) return
            if (!isIncomingMessage(data, ctx.currentUserId)) return
            if (ctx.activeTabId === makeTabId("thread", threadId) && ctx.isDocumentVisible) return
            const thread = getThread(threadId)
            if (!thread) {
              // A brand new conversation: its first message arrives BEFORE the
              // thread row does (the projection handler above returns early for
              // an unknown thread, and the self-heal below reloads the list
              // asynchronously with nothing to re-dispatch the message). Park
              // the id; `drainPendingDockSurfacing` picks it up the moment the
              // row lands, which is exactly when it can finally be classified.
              rememberPendingDockSurfacing(threadId, ctx.currentUserId)
              return
            }
            if (isChannel(thread, ctx.currentUserId)) return
            surfaceIncoming(threadId)
          },
        },
        {
          owner: "message-projection",
          priority: 20,
          handler: (action, data) => {
            handleWsMessageEvent(action, data)
          },
        },
        {
          // S11: a reply in a thread this user follows (or now follows, by
          // replying) refreshes the sidebar's "Followed threads".
          owner: "followed-replies",
          priority: 22,
          handler: (action, data, ctx) => {
            handleFollowedRepliesMessageEvent(action, data, ctx.currentUserId)
          },
        },
        {
          // Self-heal (Task 3, liaison-messaging-visibility): `loadThreads`
          // caps at the 50 most recently active threads, so a message on a
          // thread the store doesn't know about yet — newly created, newly
          // joined, or simply outside the cap — would otherwise never count
          // toward totalUnreadCount(). Trigger a full reload so the store
          // catches up; the thread-store's own reload merges in place (no
          // flash-empty).
          owner: "thread-unread-self-heal",
          priority: 25,
          handler: (action, data) => {
            if (action !== "create") return
            if (data?.threadId && !getThread(data.threadId)) requestThreadReload()
          },
        },
        {
          // Home WS invalidation (Task 5, liaison-messaging-visibility): a
          // new thread message should surface on Home within seconds, not
          // after the safety-net poll (ATTENTION_POLL_MS). Mirrors the approval_request /
          // scope_request / mail-conversation handlers below — same
          // markStaleAndReload debounce absorbs a burst into one reload.
          owner: "attention-invalidation",
          priority: 30,
          handler: (action) => {
            if (action !== "create") return
            const api = getAttentionApi()
            if (api) attentionStore.markStaleAndReload(api)
          },
        },
      ],
      reaction: (action, data, ctx) => {
        handleWsReactionEvent(action, data, ctx.currentUserId)
      },
      participant: [
        {
          owner: "membership-cleanup",
          priority: 10,
          handler: (action, data, ctx) => {
            // Checks data.userId (the TARGET of removal), not ctx.isOwnAction (the ACTOR).
            // "Was I the one removed?" — not "Did I do the removing?"
            if (action !== "remove" || data?.userId !== ctx.currentUserId) return
            removeThread(data.threadId)
            closeTab(makeTabId("thread", data.threadId))
          },
        },
        {
          owner: "thread-projection",
          priority: 20,
          handler: (action, data, ctx) => {
            if (action === "remove" && data?.userId === ctx.currentUserId) return
            handleParticipantEvent(action, data)
            noteThreadChangedForTabs(data?.threadId)
            // Sync tab label — unnamed threads derive display name from participants
            const tabId = makeTabId("thread", data?.threadId)
            const tab = tabStore.tabs.find((t) => t.id === tabId)
            if (tab) {
              const thread = getThread(data?.threadId)
              if (thread) {
                const label = conversationDisplayName(thread, ctx.currentUserId)
                if (label !== tab.label) updateTabLabel(tabId, label)
              }
            }
          },
        },
      ],
      typing: (_action, data, ctx) => {
        // AN AGENT'S TURN IS NEVER THE VIEWER'S OWN ACTION. The frame is
        // stamped with the REQUESTER's actorId, because the turn is dispatched
        // in their name, so the own-action guard dropped it for the one person
        // who is waiting on it: the sender never saw the turn announced and
        // never saw Queued, which is why that label never appeared in a live
        // run. The guard belongs to a HUMAN's typing frame, which is the one
        // an echo of your own keystrokes would come back on.
        if (data?.authorType === "agent") {
          handleTypingEvent({
            type: _action === "stop" ? "typing:stop" : "typing:start",
            threadId: data?.threadId,
            userId: data?.userId ?? "agent-system",
            agentId: data?.agentId ?? null,
            replyRootId: typeof data?.replyRootId === "string" ? data.replyRootId : null,
            authorType: "agent",
          })
          return
        }
        if (ctx.isOwnAction) return
        handleTypingStart(data?.threadId, data?.userId, data?.userName ?? "")
      },
      // An admin turned an app On/Off, removed it or changed who may use it
      // (S18–S20): resync the manifest feed now, so an open session (a desktop
      // app stays up for days) drops or regains the app without a reload.
      org_app: (_action, data) => {
        // Admins: the badge, the page and its controls follow at once.
        orgAppsStore.applyUpdate(data as OrgAppUpdateEvent | undefined)
        void reloadManifestApps().catch(() => {})
        reloadAttentionForAppChange()
      },
      credit: (_action, _data) => {
        notifyCreditUpdate()
      },
      agent_stream: (action, data) => {
        handleWsAgentStreamEvent(action, data)
      },
      presence: (_action, data) => {
        handlePresenceUpdate(data?.userId, data?.status)
      },
      sub_run: (action, data) => {
        // §1.4.5 — the kernel emits ephemeral `kernel:sub_run:update` events on
        // every state transition (queued → running → done|failed). The handler
        // patches `metadata.subRun.{status,summary,usage}` on the parent
        // thread's card message in place so the renderer re-flows.
        if (action !== "update" || !data?.runId) return
        handleWsSubRunUpdate(data)
      },
      approval_request: (action, data, ctx) => {
        if (action === "create") {
          handleApprovalWsCreate(data, ctx.currentUserId)
          handleOutsideTextApprovalCreate(data)
          handleTicketApprovalCreate(data)
          handleMailApprovalWs(data)
        } else if (action === "update") {
          handleApprovalWsUpdate(data)
          handleTicketApprovalUpdate(data, ctx.currentUserId)
          handleMailApprovalWs(data)
        }
        const api = getAttentionApi()
        if (api) attentionStore.markStaleAndReload(api)
      },
      // An agent's notification to this person (a node chat's permission
      // prompt, a routine alert): the feed re-reads now, so the chat's
      // Allow / Deny card appears at once (the frame reaches only the people
      // it names, websocket.ts `hasNotificationRecipientAccess`).
      agent_notification: (_action, _data) => {
        const api = getAttentionApi()
        if (api) attentionStore.markStaleAndReload(api)
      },
      // A secret card changed (saved, cancelled, expired): the card on screen
      // re-reads its row. The frame carries the id and status only.
      secret_request: (_action, data) => {
        const api = getAttentionApi()
        if (api) secretRequestStore.handleEvent(api, data)
      },
      // An import run changed or progressed: a progress card on screen re-reads
      // it. The frame carries the id and status only.
      import_run: (_action, data) => {
        const api = getAttentionApi()
        if (api) importRunStore.handleEvent(api, data)
      },
      scope_request: (_action, _data) => {
        // The broadcast payload (event `data`) carries only the attention summary,
        // not the full row + id, so an incremental store merge can't work. Re-fetch
        // the inbox + attention feed instead — both re-pull full rows immediately,
        // so a new/decided request appears in real time (no wait on the safety-net poll).
        const api = getAttentionApi()
        if (api) {
          scopeRequestsStore.markStaleAndReload(api)
          attentionStore.markStaleAndReload(api)
        }
      },
      // Mail events are dispatched under the `mail:conversation` key. A new
      // inbound (or updated) conversation should refresh the Home attention feed
      // immediately instead of waiting on the safety-net poll — closing the "new mail
      // invisible on Home" hole. Kernel-owned via __explicitKey since the events
      // live in the mail namespace, not the kernel app name.
      conversation: {
        __explicitKey: "mail:conversation",
        handler: ((action: string) => {
          if (action !== "create" && action !== "update") return
          const api = getAttentionApi()
          if (api) attentionStore.markStaleAndReload(api)
        }) as never,
      },
      // A ticket reopened by an inbound customer message (or a manual reopen)
      // must surface on Home right away instead of waiting on the 60s poll —
      // same rationale as the mail conversation handler above. Kernel-owned
      // via __explicitKey since the events live in the tickets namespace.
      ticket: {
        __explicitKey: "tickets:ticket",
        handler: ((action: string) => {
          if (action !== "reopened") return
          const api = getAttentionApi()
          if (api) attentionStore.markStaleAndReload(api)
        }) as never,
      },
    },
    wsMessages: {
      sync: {
        owner: "tab-validation",
        handler: () => {
          // The resync bump for this frame is triggered once, by Shell's
          // onSyncRequired callback (createWebSocket calls it synchronously
          // before this dispatched handler runs) — see
          // installReconnectResync/requestResync("ws-sync") in Shell.tsx.
          // Do not call requestResync() here too; it would double-bump the
          // resync bus for a single sync frame. This handler only owns
          // tab validation.
          validateTabs()
        },
      },
      presence_sync: {
        owner: "presence-snapshot",
        handler: (message) => {
          if (message.users) handlePresenceSync(message.users)
        },
      },
      "visibility:invalidate": {
        owner: "thread-visibility",
        handler: (message) => {
          // What this user may read in these threads changed. The frame names
          // the threads and nothing else, so the only correct response is to
          // read them again.
          void handleVisibilityInvalidate(message as never, refetchThreadMessages)
        },
      },
    },
  })

  registerEntityOpener("knowledge", "document", (_api, id) => ({
    tabType: "knowledge:document",
    entityId: id,
  }))
  registerEntityOpener("knowledge", "source_link", (_api, id) => ({
    tabType: "knowledge:source_link",
    entityId: id,
  }))

  // --- Agent app ---
  // Registers tab types for chat / skills / routines and the lightning-bolt
  // activity-bar entry. The agent's WS handlers (skill:updated,
  // routine:status, routine:run_completed) are wired by the registration
  // itself; the store layer dispatches updates into the active session.
  // Registered synchronously (not behind a lazy import) so the activity-bar
  // entry is present the instant the shell paints — `agent-app.ts` is a
  // lightweight pure-registration module and every heavy tab component it
  // names is already individually `lazy()`-split.
  registerAgentApp()

  // Search — top position, order 1 (below Home).
  registerActivityBarEntry({
    id: "search",
    icon: Search,
    label: "Search",
    labelKey: "kernel.nav.search",
    order: 1,
    appId: "kernel",
    position: "top",
    tabAction: {
      type: namespaceRegistryKey("kernel", "search"),
      entityId: "search",
      label: "Search",
    },
  })

  // S8: Messages, right under Home. It opens the same chats list the phone's
  // Chats seat lands on, and its badge is the server's unread total (A14), not
  // the sum over the 50 threads the client list holds. The phone has its own
  // Chats seat and lists no row for it (Work.tsx seats `kernel:chats`).
  registerActivityBarEntry({
    id: "messages",
    icon: MessageSquare,
    label: "Messages",
    labelKey: "kernel.nav.messages",
    order: 0.5,
    appId: "kernel",
    position: "top",
    badge: messagesUnreadCount,
    // A conversation picked in its sidebar is still inside Messages.
    activeForTabTypes: [namespaceRegistryKey("kernel", "thread")],
    tabAction: {
      type: namespaceRegistryKey("kernel", "chats"),
      entityId: "chats",
      label: "Messages",
    },
  })

  // P2-T16 (S8, S10, P2-D7): Sessions, last of the top entries. Its badge is
  // the Needs-you count (S9), in the warning tone (never the danger red).
  registerActivityBarEntry({
    id: "sessions",
    icon: Terminal,
    label: "Sessions",
    labelKey: "kernel.nodeSessions.app.title",
    order: 950,
    appId: "kernel",
    position: "top",
    badge: needsYouCount,
    badgeTone: "warning",
    activeForTabTypes: [
      namespaceRegistryKey("kernel", "session"),
      namespaceRegistryKey("kernel", "session-import"),
    ],
    tabAction: {
      type: namespaceRegistryKey("kernel", "sessions"),
      entityId: "sessions",
      label: "Sessions",
    },
  })

  // A-4: Settings in activity bar — bottom position (tracked inside bootstrap)
  registerActivityBarEntry({
    id: "settings",
    icon: Settings,
    label: "Settings",
    labelKey: "kernel.nav.settings",
    order: 1000,
    appId: "kernel",
    position: "bottom",
    tabAction: {
      type: namespaceRegistryKey("kernel", "settings"),
      entityId: "settings",
      label: "Settings",
    },
  })

  // Entity openers — replace ad-hoc tab-type aliasing in ApprovalCard / MessageList.
  registerEntityOpener("kernel", "thread", (_api, id) => ({
    tabType: "thread",
    entityId: id,
  }))
  registerEntityOpener("kernel", "approval_request", async (api, id) => {
    const row = await ensureApprovalLoaded(api, id)
    return { tabType: "thread", entityId: row.threadId, label: row.handle }
  })
  registerEntityOpener("kernel", "contact", (_api, id) => ({
    tabType: "contacts:contact-detail",
    entityId: id,
  }))
  // Connection-health attention items ("reconnect X") deep-link into Settings.
  // The tab type MUST be fully qualified: bare "settings" is an ambiguous alias
  // (the invoicing app registers its own local `settings` type), so it resolves
  // to no component and the tab renders "Unknown tab type". The attention item
  // carries the app-specific reconnect route in metadata.settingsRoute (see
  // apps/api connections/attention.ts); callers pass it through via
  // OpenEntityOptions.routePath, and the Connectors page is the fallback.
  registerEntityOpener("kernel", "connected_account", (_api, id) => ({
    tabType: "kernel:settings",
    entityId: id,
    label: "Settings",
    routePath: SETTINGS_CONNECTORS_PATH,
  }))
  // An auto top-up failure's attention row (modules/cloud/attention.ts) lands on Billing.
  registerEntityOpener("kernel", "billing", (_api, id) => ({
    tabType: "kernel:settings",
    entityId: id,
    label: "Settings",
    routePath: "/settings/billing",
  }))
  // Attention-only entity types: rows keyed on something no component renders.
  // A row that carries `metadata.link` opens the link (AttentionRow); these cover
  // rows without one, including rows stored before their producer wrote a link.
  // A new-email burst (or a message with no conversation yet) opens the inbox.
  registerEntityOpener("mail", "new_email", () => ({
    tabType: "mail:inbox",
    entityId: "inbox",
    label: tNow("mail.mail2"),
  }))
  // A file shared in a thread opens the thread it was added to.
  // A file deleted since (or no longer readable) falls back to Home, so the click
  // still lands somewhere and openEntity still clears the card.
  registerEntityOpener("kernel", "file", async (api, id) => {
    const meta = await api
      .get<{ app?: string; entityType?: string; entityId?: string }>(
        `/files/${encodeURIComponent(id)}/metadata`,
      )
      .catch(() => null)
    if (meta?.app === "kernel" && meta.entityType === "thread" && meta.entityId) {
      return { tabType: "thread", entityId: meta.entityId }
    }
    return { tabType: "kernel:home", entityId: "home" }
  })
  // A failing email digest is an email provider problem: the mail setup page.
  registerEntityOpener("kernel", "digest", () => ({
    tabType: "kernel:settings",
    entityId: "settings",
    routePath: appSettingsPath("mail"),
  }))
  // A finished whole-org export: Settings → Organization, where the download is.
  registerEntityOpener("kernel", "org_export", () => ({
    tabType: "kernel:settings",
    entityId: "settings",
    routePath: "/settings/admin/org",
  }))
  // An org cap crossed 80 % or 100 %: Settings → Organization, Usage and limits.
  registerEntityOpener("kernel", "org_cap", () => ({
    tabType: "kernel:settings",
    entityId: "settings",
    routePath: "/settings/admin/org",
  }))
  // A bug report sent only to the Liaison team never arrived: Settings → System.
  registerEntityOpener("kernel", "liaison_team_forward", () => ({
    tabType: "kernel:settings",
    entityId: "settings",
    routePath: "/settings/system",
  }))
  // An agent notification with no link has nothing to open: stay on Home.
  registerEntityOpener("kernel", "agent_notification", () => ({
    tabType: "kernel:home",
    entityId: "home",
  }))
  registerEntityOpener("mail", "conversation", (_api, id) => ({
    tabType: "mail:conversation",
    entityId: id,
  }))
  registerEntityOpener("projects", "project", (_api, id) => ({
    tabType: "projects:project",
    entityId: id,
  }))
  registerEntityOpener("projects", "task", (_api, id) => ({
    tabType: "projects:task",
    entityId: id,
  }))

  // Kernel entity-preview renderers (auth/user, threads/thread, approvals/approval_request).
  // Manifest apps register their own previews in loadManifestApps().
  registerUserPreviews()
  registerThreadPreviews()
  registerApprovalPreviews()

  // Kernel is not a manifest app, but it exposes bulk actions through the same
  // runtime — register the bulk decl on the frontend so <BulkActionToolbar app="kernel">
  // can read it from the manifest cache.
  registerManifestAppData("kernel", {
    attention: { groupLabel: { label: "Team", labelKey: "kernel.homeGroupTeam" } },
    bulk: {
      deactivateUsers: {
        label: "Deactivate users",
        underlyingTool: "deactivateUser",
        dispatchMode: "perItem",
        perItemParam: "userId",
        agentTool: "bulkDeactivateUsers",
      },
    },
  })

  // --- Resync subscriptions ---
  // On a WS `sync` frame or any reconnect, requestResync() bumps the bus. Each
  // kernel store's subscription refetches ONLY what is loaded, in place (never
  // wipes). Idempotent — safe across bootstrap re-entry.
  // Tab title + favicon unread badge (Task 4). Reactive on totalUnreadCount(),
  // so it needs no wiring into the message handlers above — it just works
  // once the thread store updates.
  startTabBadge()
  // The desktop app icon's badge: unread direct messages and mentions only.
  startDesktopBadge()
  subscribeThreadResync()
  subscribeMessageResync()
  subscribeTicketDetailResync()
  subscribeMailResync()
  subscribeMailMessageResync()
  subscribeContactsResync()
  subscribeContactDetailResync()
  subscribeKnowledgeResync()
  subscribeProjectsResync()
  subscribeProjectResync()
  subscribeResync(() => {
    const api = getAttentionApi()
    if (api) {
      attentionStore.markStaleAndReload(api)
      scopeRequestsStore.markStaleAndReload(api)
    }
  })

  // --- Tab-close eviction ---
  // When the last open tab for an entity closes, drop its per-entity detail
  // payload so session memory stays proportional to open tabs, not to
  // everything ever opened. List/sidebar surfaces are separate records and
  // are never touched by these evictors.
  registerTabEvictor("thread", evictThreadMessages)
  registerTabEvictor("tickets:ticket", evictTicketDetail)
  registerTabEvictor("mail:conversation", evictConversationMessages)
}

/**
 * The apps this person can use changed: Home's attention feed is read again,
 * so the queue of an app turned Off or restricted away leaves Home at once
 * (the server no longer lists it, MGT-11) and a regained app's comes back.
 */
function reloadAttentionForAppChange(): void {
  const api = getAttentionApi()
  if (api) attentionStore.markStaleAndReload(api)
}

export function resetBootstrap(): void {
  bootstrapped = false
  pendingDockSurfacing.clear()
  manifestAppsLoaded = false
  clearManifestRetry()
  manifestResyncQueued = false
  setManifestAppsSettled(false)
  registeredManifestApps.clear()
  heldTabTypes.clear()
  clearCompatMode()
}

export const trustedAppExports: Record<string, () => Promise<Record<string, unknown>>> = {
  mail: () => import("~/modules/mail/exports"),
  contacts: () => import("~/modules/contacts/exports"),
  tickets: () => import("~/modules/tickets/exports"),
  projects: () => import("~/modules/projects/exports"),
  knowledge: () => import("~/modules/knowledge/exports"),
  calendar: () => import("~/modules/calendar/exports"),
  "api-connector": () => import("~/modules/api-connector/exports"),
  database: () => import("~/modules/database/exports"),
  test: () => import("~/modules/test/exports"),
}

let manifestAppsLoaded = false
/**
 * Names of manifest apps currently registered on this client. The set is the
 * reconciliation baseline for `reloadManifestApps` — what to keep, add, or tear
 * down when the user's accessible app set changes mid-session.
 */
const registeredManifestApps = new Set<string>()
/**
 * Tab types of manifest apps the viewer lost access to (an admin turned the app
 * Off or restricted it to other people, S19, S20) that are kept registered, so
 * an open tab of the app stays and shows the unavailable notice instead of
 * closing silently. Released when the app is removed outright; replaced when
 * access comes back and the app registers again.
 */
const heldTabTypes = new Map<string, string[]>()
/** Serialize manifest syncs; coalesce a reload requested while one is running. */
let manifestSyncInFlight = false
let manifestResyncQueued = false
/**
 * A signed-in first read that failed (a 5xx, a timeout, the network) is read
 * again on a backoff: nothing else asks for it, so without this the session
 * kept no apps (blank settings pages, an empty App store) until a reload.
 */
const MANIFEST_RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const
let manifestRetryTimer: ReturnType<typeof setTimeout> | null = null
let manifestRetryAttempt = 0

function clearManifestRetry(): void {
  if (manifestRetryTimer) clearTimeout(manifestRetryTimer)
  manifestRetryTimer = null
  manifestRetryAttempt = 0
}

function scheduleManifestRetry(): void {
  if (manifestRetryTimer) return
  const delay =
    MANIFEST_RETRY_MS[Math.min(manifestRetryAttempt, MANIFEST_RETRY_MS.length - 1)] ?? 30_000
  manifestRetryAttempt += 1
  manifestRetryTimer = setTimeout(() => {
    manifestRetryTimer = null
    if (!manifestAppsLoaded && accessToken()) void runManifestSync(false)
  }, delay)
}

/** The manifest's own version string, or null. */
function manifestVersion(manifest: unknown): string | null {
  const v = (manifest as { version?: unknown } | null)?.version
  return typeof v === "string" ? v : null
}

/**
 * Notes, afresh, whether this app runs in compatibility mode in a desktop or
 * phone app (compat-mode.ts): its settings page uses a block or field type
 * this build cannot draw. A browser runs the server's own build and notes
 * nothing.
 */
function noteCompatFor(name: string, manifest: unknown): void {
  clearCompatMode(name)
  if (!inWrappedShell()) return
  if (hasUnsupportedSettings(manifest)) {
    noteCompatMode({ app: name, reason: "settings", serverVersion: manifestVersion(manifest) })
  }
}

type ManifestEntry = {
  name: string
  manifest: any
  uiBundleUrl: string | null
  /** A first-party app built from the signed release artifact (statement served beside ui.js). */
  signed?: boolean
  /** The image's own catalog artifact: a browser tab runs it in the page, every other app framed. */
  firstParty?: boolean
}

/** Fetch the per-user manifest list (already scope-filtered server-side). */
async function fetchManifestEntries(): Promise<ManifestEntry[] | null> {
  const token = accessToken()
  // No session yet (e.g. on the login page) — skip the call entirely so we
  // don't surface a 401 in the browser console. Shell.onMount calls the loader
  // again post-login when the token is available.
  if (!token) return null
  try {
    const read = (bearer: string) =>
      fetch(apiUrl("/apps/manifests"), {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
      })
    let res = await read(token)
    // An admin's app change bumps every member's permission version, so the
    // token this session holds is refused until refreshed (A24-5). Refresh it
    // once and read again: a resync that gave up here left the old nav in
    // place until a reload (MGT-11, MGT-14).
    if (res.status === 401) {
      // Names the token it was refused with: a refresh that already replaced
      // it is joined, not repeated.
      await authManager.ensureFreshToken({ force: true, rejected: token })
      const fresh = accessToken()
      if (!fresh) return null
      res = await read(fresh)
    }
    if (!res.ok) return null // Non-fatal: manifest apps simply won't be available
    const json = await res.json()
    // Apps Off, removed or restricted away for this person (S19, S20): absent
    // from `data`; the nav of in-tree apps the shell registers reads this set.
    const unavailable = (json as { unavailableApps?: unknown }).unavailableApps
    setUnavailableApps(
      Array.isArray(unavailable)
        ? unavailable.filter((n): n is string => typeof n === "string")
        : [],
    )
    await loadOrgFeatures(apiUrl("/apps/features"), accessToken() ?? token)
    return (json.data ?? []) as ManifestEntry[]
  } catch {
    // Network failure — non-fatal, manifest apps won't be registered
    return null
  }
}

/**
 * The app list, fetched again for fresh bundle tokens. Frames mounting together
 * share one request.
 */
let freshEntries: Promise<ManifestEntry[] | null> | null = null
function freshManifestEntries(): Promise<ManifestEntry[] | null> {
  if (!freshEntries) {
    freshEntries = fetchManifestEntries().finally(() => {
      freshEntries = null
    })
  }
  return freshEntries
}

/** Register one manifest app's UI surface; records it in `registeredManifestApps`. */
async function registerManifestAppEntry(
  entry: ManifestEntry,
  listed: readonly ManifestEntry[],
): Promise<void> {
  const { name, uiBundleUrl, signed } = entry
  let manifest = entry.manifest
  try {
    let uiExports: Record<string, unknown>
    if (uiBundleUrl) {
      // Only load UI bundles that originate from the host this client talks
      // to. Third-party URLs (cross-origin JS) would execute arbitrary code in
      // the user's session — block them before the dynamic import.
      //
      // In a browser that host IS the page's own origin: the app is served by
      // its API. Wrapped in a native shell it is not — the page comes from the
      // bundle's own scheme (tauri://localhost) and the API, including every
      // installed app's `/api/apps/<name>/<version>/ui.js`, lives on the bound
      // server the user entered at first launch. So the shell resolves a
      // relative bundle path against THAT server (resolving it against the
      // page would point at the bundle, which holds no API) and permits
      // exactly that one origin. Any other origin is refused on both.
      const boundServerOrigin = inWrappedShell() ? serverAddressOverride() : null
      const permittedOrigin = boundServerOrigin ?? window.location.origin
      let bundleUrl: URL
      try {
        bundleUrl = new URL(uiBundleUrl, boundServerOrigin ?? window.location.href)
      } catch {
        console.warn(`Manifest app "${name}": invalid UI bundle URL "${uiBundleUrl}" — skipped`)
        return
      }
      if (bundleUrl.origin !== permittedOrigin) {
        console.warn(
          `Manifest app "${name}": UI bundle at ${uiBundleUrl} is cross-origin (${bundleUrl.origin}) — only bundles from ${permittedOrigin} are permitted`,
        )
        return
      }
      const bundleHref = bundleUrl.href
      // D11, S13. Code the server chose never runs in a shell's main frame on
      // the server's word. In the DESKTOP shell a first-party app the server
      // lists as signed is verified by the shell itself (keys compiled into
      // it), and the verified bytes are imported from the shell's
      // `liaison-app:` scheme, registered from the signed manifest
      // (verified-app.ts). Every other UI in a shell (unsigned, refused,
      // phone: D7) runs in the sandboxed frame (isolated-app.tsx), and a shell
      // with no frame does not load it at all.
      // S16. A browser tab is the server's own origin with the user's session:
      // a first-party app is imported into the page from that origin, and every
      // other app runs in the same sandboxed frame, whose document the server
      // serves beside its bundle. An outside app's code never runs in the page.
      const inPage = !boundServerOrigin && entry.firstParty === true
      const frameUrl = inPage
        ? null
        : boundServerOrigin
          ? isolatedFrameUrl()
          : browserAppFrameUrl(bundleUrl)
      const servedVersion = /\/([^/]+)\/ui\.js$/.exec(bundleUrl.pathname)?.[1] ?? null
      const verified =
        boundServerOrigin && signed && servedVersion
          ? await verifiedFirstPartyApp(name, servedVersion, manifest)
          : null
      if (!inPage && !verified && !frameUrl) {
        console.warn(
          `Manifest app "${name}": not loaded: ${boundServerOrigin ? "this shell has no app frame" : "its bundle URL names no app frame"}, and an installed app's UI never runs in its main page`,
        )
        return
      }
      // The URLs carry a short-lived token fixed now; a frame mounted after it
      // has nearly run out asks the app list again for this app's fresh ones.
      const freshUrls = async (): Promise<{ bundleUrl: string; frameUrl: string } | null> => {
        const fresh = (await freshManifestEntries())?.find((e) => e.name === name)?.uiBundleUrl
        if (!fresh) return null
        let url: URL
        try {
          url = new URL(fresh, boundServerOrigin ?? window.location.href)
        } catch {
          return null
        }
        // The same origin and the same app version, or nothing.
        if (url.origin !== permittedOrigin || url.pathname !== bundleUrl.pathname) return null
        const nextFrame = boundServerOrigin ? frameUrl : browserAppFrameUrl(url)
        return nextFrame ? { bundleUrl: url.href, frameUrl: nextFrame } : null
      }
      const framed = (): Record<string, unknown> =>
        isolatedAppExports(manifest, {
          app: name,
          bundleUrl: bundleHref,
          frameUrl: frameUrl ?? "",
          freshUrls,
        })
      try {
        if (verified) {
          try {
            uiExports = await importAppModule(verified.url)
            manifest = verified.manifest
          } catch (err) {
            // A verified bundle the webview could not load still renders: framed.
            if (!frameUrl) throw err
            console.warn(
              `Manifest app "${name}": verified UI did not load in the page; runs in the frame`,
              err,
            )
            uiExports = framed()
          }
        } else if (frameUrl) {
          uiExports = framed()
        } else {
          uiExports = await importAppModule(bundleHref)
        }
      } catch (err) {
        // Phase 16.5 — explicit error surface: name the app + URL so the
        // operator knows which install is broken without grepping.
        console.warn(`Manifest app "${name}": failed to load UI bundle at ${bundleHref}`, err)
        return
      }
    } else if (trustedAppExports[name]) {
      uiExports = await trustedAppExports[name]()
    } else {
      uiExports = {}
    }

    // Phase 16.5 — every component the manifest declares MUST be exported
    // by the loaded UI bundle. Without this, a typo'd export name 404s
    // the settings route silently; here we surface it as a warning that
    // names the missing exports so the plugin author can fix the bundle.
    // In-tree apps (no uiBundleUrl) are exempt — their export bag is
    // always the live module so a missing export is a build-time TS error.
    if (uiBundleUrl) {
      const declared = collectDeclaredComponentNames(manifest)
      const missing = declared.filter((n) => !(n in uiExports))
      if (missing.length > 0) {
        console.warn(
          `Manifest app "${name}": UI bundle at ${uiBundleUrl} is missing declared exports: ${missing.join(", ")}`,
        )
        return
      }
      // A settings page's custom block whose export is missing costs that
      // block only (the page shows an error card in its place), not the app.
      const missingBlocks = collectSettingsBlockComponentNames(manifest).filter(
        (n) => !(n in uiExports),
      )
      if (missingBlocks.length > 0) {
        console.warn(
          `Manifest app "${name}": UI bundle at ${uiBundleUrl} is missing settings block exports: ${missingBlocks.join(", ")}`,
        )
      }
    }

    noteCompatFor(name, manifest)

    // `uiBundleUrl` is exactly the "installed app" test: an in-tree module
    // (mail, tickets, knowledge, ...) resolves its exports from
    // `trustedAppExports` and has no bundle URL.
    registerAppFromManifest(manifest, uiExports, {
      external: Boolean(uiBundleUrl),
      routeOwners: listed,
    })
    registeredManifestApps.add(name)
    // The app's own display name, so every surface that has only an app SLUG
    // to show (agent capability chips, permission labels) can print the name
    // the operator knows instead of the identifier.
    registerAppDisplayName(name, manifest?.displayName)

    const previewExports = uiExports as {
      registerEntityPreviews?: () => void
      registerAppHooks?: () => void
    }
    previewExports.registerEntityPreviews?.()
    previewExports.registerAppHooks?.()
  } catch (err) {
    console.warn(`Failed to load manifest app "${name}":`, err)
  }
}

/**
 * Sync the registered manifest-app surface to the server's per-user list.
 * `reconcile: false` is the first load (register everything). `reconcile: true`
 * (a mid-session refresh) additionally TEARS DOWN apps the user can no longer
 * see — the activity-bar icon, nav, settings, tabs — and adds newly-granted
 * ones. Calls are serialized; a reload requested while one runs is coalesced.
 */
async function runManifestSync(reconcile: boolean): Promise<void> {
  if (manifestSyncInFlight) {
    if (reconcile) manifestResyncQueued = true
    return
  }
  manifestSyncInFlight = true
  try {
    const apps = await fetchManifestEntries()
    if (!apps) {
      // A signed-in first sync that failed still settles, so a settings path
      // no section claims falls back to Profile instead of waiting forever,
      // and is read again until it succeeds.
      if (!manifestAppsLoaded && accessToken()) {
        if (!reconcile) setManifestAppsSettled(true)
        scheduleManifestRetry()
      }
      return
    }

    if (reconcile) {
      const nextNames = new Set(apps.map((a) => a.name))
      // Revoked access → tear the app's surface down. An app the viewer can no
      // longer use (Off or restricted, listed in `unavailableApps`) keeps its
      // tab types, so an open tab stays and says why (MGT-11); any other loss
      // (scope revoked, app gone) closes its open tabs.
      for (const name of [...registeredManifestApps]) {
        if (!nextNames.has(name)) {
          if (isAppUnavailable(name)) {
            const kept = unregisterApp(name, { keepTabTypes: true })
            if (kept.length > 0) heldTabTypes.set(name, kept)
          } else {
            unregisterApp(name, { notifyTabRemoval: true })
          }
          registeredManifestApps.delete(name)
          clearCompatMode(name)
        }
      }
      for (const [name, types] of [...heldTabTypes]) {
        if (nextNames.has(name)) {
          heldTabTypes.delete(name) // access is back: the registration below replaces them
        } else if (!isAppUnavailable(name)) {
          unregisterTabTypes(types, { notifyRemoval: true })
          heldTabTypes.delete(name)
        }
      }
    }

    // Register apps not yet registered (all of them on first load; only the
    // newly-granted ones on a reconcile — already-registered apps are left
    // mounted so their open tabs and scroll state are preserved).
    // Register apps not yet registered IN PARALLEL — each entry already
    // error-isolates internally (registerManifestAppEntry catches and warns
    // rather than throwing), and registrations are independent of each other
    // (distinct app names, distinct tab-type/activity-bar keys), so there is
    // no ordering requirement between them. This is what makes the manifest
    // bundles for N apps download concurrently instead of one at a time (B1).
    // An app already mounted keeps its UI, but a deploy may have changed its
    // settings page: its compatibility note is read again.
    for (const entry of apps) {
      if (registeredManifestApps.has(entry.name)) noteCompatFor(entry.name, entry.manifest)
    }
    await Promise.all(
      apps
        .filter((entry) => !registeredManifestApps.has(entry.name))
        .map((entry) => registerManifestAppEntry(entry, apps)),
    )
    manifestAppsLoaded = true
    clearManifestRetry()
    setManifestAppsSettled(true)
  } finally {
    manifestSyncInFlight = false
    if (manifestResyncQueued) {
      manifestResyncQueued = false
      void runManifestSync(true)
    }
  }
}

export async function loadManifestApps(): Promise<void> {
  if (manifestAppsLoaded) return
  await runManifestSync(false)
}

/**
 * Re-fetch the per-user manifest list and reconcile the app surface in place —
 * add icons for newly-granted apps, remove them for revoked ones — without a
 * page reload. Driven by Shell when the access token's scope set changes (an
 * admin edited the user's role; the next token refresh carries the new scopes).
 */
export async function reloadManifestApps(): Promise<void> {
  if (!manifestAppsLoaded) {
    // The first read is on the wire, maybe with the token this reload exists
    // to replace: read again once it lands instead of dropping the request.
    if (manifestSyncInFlight) {
      manifestResyncQueued = true
      return
    }
    // Initial load hasn't happened yet (or was torn down) — do that instead;
    // there is no prior surface to reconcile against.
    await loadManifestApps()
    return
  }
  await runManifestSync(true)
}

onSessionTeardown(() => {
  setUnavailableApps([])
  setEnabledOrgFeatures([])
  clearCompatMode()
  clearManifestRetry()
  manifestAppsLoaded = false
  setManifestAppsSettled(false)
  registeredManifestApps.clear()
  for (const types of heldTabTypes.values()) unregisterTabTypes(types, { notifyRemoval: false })
  heldTabTypes.clear()
  // Parked conversations belong to the session that received their messages.
  // `resetBootstrap` is a test-only reset, so without this line the map was
  // never emptied in production and a thread parked before a sign-out could
  // still land in the NEXT person's dock on this machine.
  pendingDockSurfacing.clear()
})

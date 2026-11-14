// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT `open_app` CAN OPEN, AND HOW. One list per app, read from the same declarations
// the web app registers its tabs from, so a new app's tab is reachable the day it ships:
// `views.tabTypes` (a tab of its own), `views.detail` (a panel in the kernel's generic
// detail tab). The kernel's own tabs have no manifest, so they are declared here.
// `open-targets.test.ts` walks every manifest and the kernel's tab list and fails on a
// tab the agent cannot reach.
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { viewRegistry } from "~/modules/apps/app-registries"
import { lookupEntityDecl, tabEntity } from "~/modules/threads/reference-display"

/** A routine's tick or a background run: nobody is watching a screen this could move. */
export function runHasNoViewer(): boolean {
  const run = currentRunContext()
  return Boolean(run?.routineId || run?.routineRunId || run?.background)
}

/**
 * WHOSE SCREEN `open_app` WITH ONLY AN APP MAY MOVE, on its stream frame: the person whose request
 * started the turn. A run with nobody watching (a routine's) names nobody and moves
 * nothing. Other tools' frames carry nothing extra.
 */
export function uiEffectRequester(
  sdkToolName: string,
  requesterId: string,
): { requesterId?: string } {
  if (sdkToolName !== "kernel__open_app") return {}
  return runHasNoViewer() ? {} : { requesterId }
}

/** What the web app opens. Comes from the server, never from the model's arguments. */
export interface OpenTab {
  type: string
  entityId: string
  routePath?: string
}

export interface OpenRecord {
  app: string
  entityType: string
}

export type OpenTarget =
  | { kind: "tab"; type: string }
  | { kind: "detail"; app: string; entity: string }
  /** Routines and skills are panes of the page of the agent that owns them. */
  | { kind: "agent-item"; pane: "routines" | "skills" }
  /** An event is the calendar tab's own dialog: the tab has no route per event. */
  | { kind: "calendar-event" }
  /** The record's only page is in another system: no tab here. */
  | { kind: "outside"; entity: string }

export interface OpenView {
  view: string
  label: string
  needsId: boolean
  /** The record `id` names. Null when the view takes no id, or its id is a name, not a row. */
  record: OpenRecord | null
  target: OpenTarget
  /** The page a mention of the record opens (`referenceable`), when several views show it. */
  primary?: boolean
}

/** Tabs with a `:param` that is not a record, and why. */
export const TABS_WHOSE_ID_IS_NOT_A_RECORD: ReadonlySet<string> = new Set([
  "boxtal:queue", // a work queue's name
  "invoicing:dashboard", // a dashboard's name
  "invoicing:documents", // a list's filter
  "monitoring:source", // a configured monitoring source, not a row of the app
  "monitoring:status", // a list's filter
])

/**
 * Panels no single id can address. A refund's panel takes its parent order's id as well, and
 * a person only reaches one from that order.
 */
export const DETAIL_PANELS_WITH_NO_SINGLE_ID: ReadonlySet<string> = new Set(["shopify:refund"])

const kernelTab = (view: string, label: string): OpenView => ({
  view,
  label,
  needsId: false,
  record: null,
  target: { kind: "tab", type: `kernel:${view}` },
})

const kernelRecord = (view: string, label: string, target: OpenTarget): OpenView => ({
  view,
  label,
  needsId: true,
  record: { app: "kernel", entityType: view },
  target,
})

/** The kernel's own tabs, and the agent pages' panes that a person opens as a record. */
export const KERNEL_OPEN_VIEWS: readonly OpenView[] = [
  kernelRecord("thread", "Conversation", { kind: "tab", type: "kernel:thread" }),
  kernelRecord("agent", "Agent", { kind: "tab", type: "agents:agent" }),
  kernelRecord("routine", "Routine", { kind: "agent-item", pane: "routines" }),
  kernelRecord("skill", "Skill", { kind: "agent-item", pane: "skills" }),
  kernelRecord("session", "Session", { kind: "tab", type: "kernel:session" }),
  kernelRecord("dashboard", "Dashboard", { kind: "tab", type: "kernel:dashboard" }),
  kernelRecord("dashboard-table", "Dashboard table", {
    kind: "tab",
    type: "kernel:dashboard-table",
  }),
  kernelRecord("app-builder", "App builder", { kind: "tab", type: "kernel:app-builder" }),
  kernelTab("home", "Home"),
  kernelTab("work", "Work"),
  kernelTab("chats", "Chats"),
  kernelTab("approvals", "Approvals"),
  kernelTab("search", "Search"),
  kernelTab("dashboards", "Dashboards"),
  kernelTab("sessions", "Sessions"),
  kernelTab("session-import", "Import sessions"),
  kernelTab("settings", "Settings"),
  kernelTab("help", "Help"),
]

/** Records that open inside a tab without having a tab type or a detail panel of their own. */
const RECORDS_INSIDE_A_TAB: Readonly<Record<string, readonly OpenView[]>> = {
  calendar: [
    {
      view: "event",
      label: "Event",
      needsId: true,
      record: { app: "calendar", entityType: "event" },
      target: { kind: "calendar-event" },
    },
  ],
}

/** The kernel's reading scope of a kernel record; anything else is gated by RLS alone. */
const KERNEL_READ_SCOPES: Readonly<Record<string, string>> = {
  thread: "kernel:threads:read",
  contact: "kernel:contacts:read",
  company: "kernel:companies:read",
  routine: "kernel:routines:read",
  skill: "kernel:skills:read",
}

interface ManifestViews {
  tabTypes?: Record<string, { label?: string; urlPattern?: string; referenceable?: boolean }>
  detail?: Record<string, { component?: string; externalLink?: { urlTemplate?: string } }>
}

function manifestViews(orgId: string, app: string): ManifestViews | null {
  for (const id of orgId ? [orgId, "*"] : ["*"]) {
    const views = viewRegistry.get([id, app]) as ManifestViews | undefined
    if (views) return views
  }
  return null
}

function tabView(
  orgId: string,
  app: string,
  view: string,
  tab: { label?: string; urlPattern?: string; referenceable?: boolean },
): OpenView {
  const needsId = tab.urlPattern?.includes(":") === true
  const named = tabEntity(orgId, app, view)
  const own = lookupEntityDecl(orgId, app, view) ? { app, entityType: view } : null
  const notARecord = TABS_WHOSE_ID_IS_NOT_A_RECORD.has(`${app}:${view}`)
  return {
    view,
    label: tab.label ?? view,
    needsId,
    record: needsId && !notARecord ? (named ?? own) : null,
    target: { kind: "tab", type: `${app}:${view}` },
    ...(tab.referenceable === true ? { primary: true } : {}),
  }
}

/** Every view of `app`, or null for an app this org has no views of. */
export function openViewsOf(orgId: string, app: string): OpenView[] | null {
  if (app === "kernel") return [...KERNEL_OPEN_VIEWS]
  const views = manifestViews(orgId, app)
  if (!views) return null
  const out = new Map<string, OpenView>()
  for (const inside of RECORDS_INSIDE_A_TAB[app] ?? []) out.set(inside.view, inside)
  for (const [entity, panel] of Object.entries(views.detail ?? {})) {
    if (DETAIL_PANELS_WITH_NO_SINGLE_ID.has(`${app}:${entity}`)) continue
    out.set(entity, {
      view: entity,
      label: entity,
      needsId: true,
      record: { app, entityType: entity },
      target: panel.component ? { kind: "detail", app, entity } : { kind: "outside", entity },
    })
  }
  // A tab of its own wins over a panel of the same name.
  for (const [view, tab] of Object.entries(views.tabTypes ?? {})) {
    out.set(view, tabView(orgId, app, view, tab))
  }
  return [...out.values()]
}

/** The scope that reads this record, when one is declared. */
export function readScopeOf(orgId: string, record: OpenRecord): string | null {
  if (record.app === "kernel") return KERNEL_READ_SCOPES[record.entityType] ?? null
  return lookupEntityDecl(orgId, record.app, record.entityType)?.readScope ?? null
}

/** The tab an id opens, for targets that need nothing but the id. */
export function tabForId(target: OpenTarget, id: string): OpenTab | null {
  if (target.kind === "tab") return { type: target.type, entityId: id }
  if (target.kind === "detail") {
    return {
      type: "kernel:detail",
      entityId: `${target.app}/${target.entity}/${encodeURIComponent(id)}`,
    }
  }
  return null
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Tickets app exports — resolved by bootstrap trusted-app registry.
// Activity-bar registration + tab-type wiring comes from the manifest's
// `views.tabTypes` and `views.activityBar` declarations consumed by
// `registerAppFromManifest`. Components and WS handlers referenced from
// `apps/api/src/apps/tickets/app.manifest.json` must be exported here (or via
// lazy() so the manifest reference resolves).
import { lazy } from "solid-js"
import {
  registerBulkUiCustomForm,
  registerBulkUiSelection,
  registerSavedViewsHandler,
} from "~/framework/app-registry"
import { registerAppPhoneHeader, registerAppPhoneTopBarHidden } from "~/framework/define-app"
import { MergeTicketsForm } from "~/modules/tickets/MergeTicketsForm"
import { MoveTicketsToInboxForm } from "~/modules/tickets/MoveTicketsToInboxForm"
import { TicketsIcon } from "~/modules/tickets/TicketsIcon"
import { handleCategoryEvent } from "~/modules/tickets/ticket-category-store"
import { handleTicketEvent, ticketDetailStore } from "~/modules/tickets/ticket-detail-store"
import { handleInboxEvent } from "~/modules/tickets/ticket-inbox-store"
import {
  applyParams as applyTicketListParams,
  clearSelection,
  replaceSelection,
  currentParams as ticketListCurrentParams,
  ticketListStore,
  selectedIds as ticketSelectedIds,
} from "~/modules/tickets/ticket-list-store"
import {
  handleTicketMessageEvent,
  handleTicketNoteEvent,
} from "~/modules/tickets/ticket-message-store"
import { handleTeamEvent } from "~/modules/tickets/ticket-team-store"
import {
  handleConnectedAccountEvent,
  handleMailConversationEvent,
  handleSlaEvent,
} from "~/modules/tickets/ticket-ws-handlers"

// Lazy components for code splitting
export const TicketsInbox = lazy(() =>
  import("~/modules/tickets/TicketsInbox").then((m) => ({ default: m.TicketsInbox })),
)
export const TicketDetail = lazy(() =>
  import("~/modules/tickets/TicketDetail").then((m) => ({ default: m.TicketDetail })),
)
export const TicketsSidebar = lazy(() =>
  import("~/modules/tickets/TicketsSidebar").then((m) => ({ default: m.TicketsSidebar })),
)
export const TicketCard = lazy(() =>
  import("~/modules/tickets/TicketCard").then((m) => ({ default: m.TicketCard })),
)
// G1 — the phone top bar's registered header for the ticket detail tab type
// (see registerAppHooks below and TicketPhoneHeader's own comment).
const TicketPhoneHeader = lazy(() => import("~/modules/tickets/TicketPhoneHeader"))

// Custom blocks of the Tickets settings page (manifest `settings`).
export const TicketsInboxRouting = lazy(() =>
  import("~/modules/tickets/TicketsInboxRouting").then((m) => ({
    default: m.TicketsInboxRouting,
  })),
)
export const TicketsIdSegments = lazy(() =>
  import("~/modules/tickets/TicketsIdSegments").then((m) => ({
    default: m.TicketsIdSegments,
  })),
)

// Mail conversation slot hosts — registered via manifest `slots` entries.
export const MailConvertToTicketBanner = lazy(() =>
  import("~/modules/tickets/MailConvertToTicketDialog").then((m) => ({
    default: m.MailConvertToTicketBanner,
  })),
)
export const MailConvertToTicketAction = lazy(() =>
  import("~/modules/tickets/MailConvertToTicketDialog").then((m) => ({
    default: m.MailConvertToTicketAction,
  })),
)

// Called by the tab framework with a bare entityId so an open ticket tab shows
// the human ticket id (handle, e.g. "T-1042") instead of the generic "Ticket"
// default — mirrors contacts' resolveContactTabLabel. Reads the reactive detail
// store, so the tab label updates as soon as the ticket finishes loading.
export function resolveTicketTabLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  return ticketDetailStore.byId[entityId]?.handle ?? undefined
}

export { registerEntityPreviews } from "./entity-preview-renderers"

/**
 * Register the tickets-app UI hooks needed by the kernel saved-views and
 * bulk-action toolbar. Called from `loadManifestApps()` after the manifest
 * registration so the hooks see a registered app.
 */
export function registerAppHooks(): void {
  registerSavedViewsHandler("tickets", "inbox", {
    capture: () => ticketListCurrentParams(),
    apply: (payload) => applyTicketListParams(payload as Record<string, unknown>),
  })
  registerBulkUiSelection("tickets", "inbox", {
    accessor: () => ticketSelectedIds(),
    clear: () => clearSelection(),
    replace: (ids) => replaceSelection(ids),
    all: () => Object.keys(ticketListStore.byId),
  })
  registerBulkUiCustomForm("tickets", "merge", MergeTicketsForm)
  registerBulkUiCustomForm("tickets", "move", MoveTicketsToInboxForm)
  // G1 — the detail tab gets a custom phone header (back / handle / ⋯); the
  // inbox tab owns its own large title (the "Tickets" h1 + Select toggle it
  // already renders at phone tier), so it hides the shared bar entirely,
  // following the exact ChatsScreen/Work convention for a root screen with a
  // large title of its own.
  registerAppPhoneHeader("tickets", "ticket", TicketPhoneHeader)
  registerAppPhoneTopBarHidden("tickets", "inbox")
}
export {
  handleCategoryEvent,
  handleConnectedAccountEvent,
  handleInboxEvent,
  handleMailConversationEvent,
  handleSlaEvent,
  handleTeamEvent,
  handleTicketEvent,
  handleTicketMessageEvent,
  handleTicketNoteEvent,
  TicketsIcon,
}

// The Support section of a company's page — registered via manifest `slots.company_detail`.
export const CompanySupportPanel = lazy(() =>
  import("~/modules/tickets/CompanySupportPanel").then((m) => ({
    default: m.CompanySupportPanel,
  })),
)

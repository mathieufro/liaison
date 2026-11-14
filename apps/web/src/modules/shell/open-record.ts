// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RECORD OPEN INSIDE A TAB. A master and detail page keeps one tab for many
// records (`boxtal:shipments`), so the tab's own id says nothing about the parcel
// on screen. The agent was asked about "this" parcel, had no record to go on, and
// answered about another one with full confidence. So a page that opens a record
// in a pane says which (`app.trackOpenRecord` in an app, `trackOpenRecord` here in
// a kernel page), and a turn sent while that tab is active names the record
// instead of the page (`currentViewForTurn`).
//
// A record is open when the person opened it (a click, a deep link) and the pane
// showing it is on screen. A list that fills its detail pane with the first row
// has opened nothing: an agent told that row was open answered "what is this
// agent for?" about a routine nobody had looked at. So `id()` is the person's
// pick, never the display default, and a pane in a hidden tab reports null.

import { type Accessor, createEffect, getOwner, onCleanup } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { useTabId } from "~/modules/shell/TabVisibilityContext"
import { tabStore, updateTabLabel } from "~/modules/shell/tab-store"

export interface OpenRecord {
  /** `<app>:<entity>`, the shape a turn's `currentView.tabType` takes. */
  tabType: string
  entityId: string
}

const openByTab = new Map<string, OpenRecord>()

/** Say what is open in a tab, or null for nothing. */
export function setOpenRecord(tabId: string, record: OpenRecord | null): void {
  if (record) openByTab.set(tabId, record)
  else openByTab.delete(tabId)
}

/** The record open in a tab, if its page said so. */
export function openRecordOf(tabId: string): OpenRecord | undefined {
  return openByTab.get(tabId)
}

onSessionTeardown(() => openByTab.clear())

/**
 * From a page's component body: keep its tab's open record equal to `id()`, until
 * the page goes away. Outside a tab (a dock, a slot in no tab) it does nothing:
 * there is no page to speak for.
 */
export function trackOpenRecord(
  app: string,
  entityType: string,
  id: Accessor<string | null | undefined>,
): void {
  const tabId = useTabId()
  if (!tabId || !getOwner()) return
  const tabType = `${app}:${entityType}`
  // A page can hold several trackers, one per pane, with one tab between them.
  // Each clears only what it set, or a pane closing would wipe the next one's
  // record, depending on the order their effects ran.
  const clearOwn = () => {
    if (openByTab.get(tabId)?.tabType === tabType) setOpenRecord(tabId, null)
  }
  createEffect(() => {
    const entityId = id()
    if (entityId) setOpenRecord(tabId, { tabType, entityId })
    else clearOwn()
  })
  onCleanup(clearOwn)
}

/**
 * From a page's component body: name its tab after the record it shows (a schedule's customer
 * rather than "Recurring schedule"), following `label()`. A null label keeps the tab's own.
 * Outside a tab it does nothing.
 */
export function trackTabLabel(label: Accessor<string | null | undefined>): void {
  const tabId = useTabId()
  if (!tabId || !getOwner()) return
  createEffect(() => {
    const next = label()?.trim()
    if (!next) return
    const tab = tabStore.tabs.find((t) => t.id === tabId)
    if (tab && tab.label !== next) updateTabLabel(tabId, next)
  })
}

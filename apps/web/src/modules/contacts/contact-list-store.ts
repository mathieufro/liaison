// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type ContactListMode = "people" | "all"

export interface Contact {
  id: string
  handle: string
  name: string | null
  email: string | null
  phone: string | null
  company: string | null
  externalIds: Record<string, string>
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  // Server-derived. `isAutomated` = noreply/notification/etc. local-part heuristic.
  // `lastContactedAt` = MAX(app_mail.conversations.last_message_at) for this contact.
  isAutomated?: boolean
  lastContactedAt?: string | null
  // Sharing (api modules/sharing): 'none' = private to its owner (or shared
  // only with specific people / a mailbox's members), else the organisation's.
  orgAccess?: "none" | "viewer" | "editor"
  ownerUserId?: string | null
  /** What commercial mail to them rests on, when recorded. */
  lawfulBasis?: "consent" | "customer" | "professional_interest" | "generic_address" | null
  /** When the basis was recorded. */
  lawfulBasisAt?: string | null
  /** The company the contact belongs to, when it has one. */
  companyId?: string | null
}

interface ContactListState {
  byId: Record<string, Contact>
  ids: string[]
}

interface ContactsApi {
  getEnvelope: <T>(
    path: string,
  ) => Promise<{ data: T; meta?: { page?: number; limit?: number; total?: number } }>
}

const DEFAULT_LIMIT = 50

const [contactListStore, setContactListStore] = createStore<ContactListState>({ byId: {}, ids: [] })
const [query, setQuerySignal] = createSignal("")
const [mode, setModeSignal] = createSignal<ContactListMode>("people")
/** The contact group the list is filtered to (S15), or null for every contact. */
const [groupFilter, setGroupFilterSignal] = createSignal<string | null>(null)
const [page, setPage] = createSignal(1)
const [currentLimit, setCurrentLimit] = createSignal(DEFAULT_LIMIT)
const [total, setTotal] = createSignal(0)
const [loading, setLoading] = createSignal(false)
const [loadingMore, setLoadingMore] = createSignal(false)

export const hasMore = () => page() * currentLimit() < total()

function buildPath(nextPage: number, limit: number): string {
  const params = new URLSearchParams()
  const q = query().trim()
  if (q) params.set("query", q)
  if (mode() === "all") params.set("mode", "all")
  const groupId = groupFilter()
  if (groupId) params.set("groupId", groupId)
  params.set("page", String(nextPage))
  params.set("limit", String(limit))
  return `/contacts?${params.toString()}`
}

export function setQuery(nextQuery: string): void {
  setQuerySignal(nextQuery)
  setPage(1)
  setContactListStore({ byId: {}, ids: [] })
}

export function setMode(nextMode: ContactListMode): void {
  if (mode() === nextMode) return
  setModeSignal(nextMode)
  setPage(1)
  setContactListStore({ byId: {}, ids: [] })
}

export function setGroupFilter(groupId: string | null): void {
  if (groupFilter() === groupId) return
  setGroupFilterSignal(groupId)
  setPage(1)
  setContactListStore({ byId: {}, ids: [] })
}

// Last API client seen — captured so the resync subscription can refetch the
// current contact-list query without a component context.
let _contactsApi: ContactsApi | null = null

export async function loadContacts(api: ContactsApi, limit = DEFAULT_LIMIT): Promise<void> {
  _contactsApi = api
  setLoading(true)
  try {
    setPage(1)
    setCurrentLimit(limit)
    const res = await api.getEnvelope<Contact[]>(buildPath(1, limit))
    setContactListStore(
      produce((state) => {
        state.byId = {}
        state.ids = []
        for (const contact of res.data ?? []) {
          state.byId[contact.id] = contact
          state.ids.push(contact.id)
        }
      }),
    )
    setTotal(res.meta?.total ?? 0)
  } finally {
    setLoading(false)
  }
}

// --- Resync subscription ---
// On a resync bump, if a list is currently loaded, refetch page 1 of the
// current query/mode in place (loadContacts rebuilds byId/ids inside one
// produce — atomic, no wipe). Idempotent.
let _contactsResyncSubscribed = false

export function subscribeContactsResync(): void {
  if (_contactsResyncSubscribed) return
  _contactsResyncSubscribed = true
  subscribeResync(() => {
    const api = _contactsApi
    if (api && contactListStore.ids.length > 0) void loadContacts(api, currentLimit())
  })
}

export async function loadMoreContacts(api: ContactsApi, limit = DEFAULT_LIMIT): Promise<void> {
  if (!hasMore() || loadingMore()) return
  setLoadingMore(true)
  try {
    const nextPage = page() + 1
    setCurrentLimit(limit)
    const res = await api.getEnvelope<Contact[]>(buildPath(nextPage, limit))
    setContactListStore(
      produce((state) => {
        for (const contact of res.data ?? []) {
          state.byId[contact.id] = contact
          if (!state.ids.includes(contact.id)) state.ids.push(contact.id)
        }
      }),
    )
    setPage(nextPage)
    setTotal(res.meta?.total ?? total())
  } finally {
    setLoadingMore(false)
  }
}

type ContactEventData = Partial<Contact> & { id: string }

export function handleContactEvent(action: string, data: ContactEventData): void {
  // Defensive: drop events without a valid contact id. Without this, a
  // malformed payload (e.g. `{}` on a contact:merge) would push `undefined`
  // into `state.ids`, and the corresponding `<For>` row would later render
  // a ContactAvatar with `id={undefined}` and crash the tab.
  if (!data || typeof data.id !== "string" || data.id.length === 0) return
  if (action === "create") {
    setContactListStore(
      produce((state) => {
        if (state.byId[data.id]) return
        state.byId[data.id] = data as Contact
        state.ids.unshift(data.id)
      }),
    )
    setTotal(total() + 1)
  } else if (action === "update" || action === "merge") {
    setContactListStore(
      produce((state) => {
        if (state.byId[data.id]) state.byId[data.id] = { ...state.byId[data.id], ...data }
      }),
    )
  } else if (action === "delete") {
    setContactListStore(
      produce((state) => {
        delete state.byId[data.id]
        state.ids = state.ids.filter((id) => id !== data.id)
      }),
    )
    setTotal(Math.max(0, total() - 1))
  }
}

export function resetContactListStore(): void {
  setContactListStore({ byId: {}, ids: [] })
  setQuerySignal("")
  setModeSignal("people")
  setGroupFilterSignal(null)
  setPage(1)
  setCurrentLimit(DEFAULT_LIMIT)
  setTotal(0)
  setLoading(false)
  setLoadingMore(false)
}

onSessionTeardown(resetContactListStore)

export { contactListStore, groupFilter, loading, loadingMore, mode, page, query, total }

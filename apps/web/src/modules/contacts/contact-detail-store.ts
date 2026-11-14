// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { Contact } from "./contact-list-store"

interface DetailApi {
  get: <T>(path: string) => Promise<T>
  getEnvelope: <T>(path: string) => Promise<{ data: T; meta?: { nextCursor?: string | null } }>
  post?: <T>(path: string, body?: unknown) => Promise<T>
  patch: <T>(path: string, body?: unknown) => Promise<T>
  delete: <T>(path: string) => Promise<T>
}

/** Whether commercial mail to the contact's address is allowed to go, read from the opt-out list. */
export type OptOutState =
  | { state: "allowed" }
  | { state: "unavailable" }
  /** `since` and `by` only come back to readers of the opt-out list. */
  | { state: "opted_out"; since?: string; by?: "link" | "reply" | "person" | "import" }

interface ContactDetailState {
  contacts: Record<string, Contact>
  /** The opt-out answer per contact id, once asked. */
  optOuts: Record<string, OptOutState>
  /** The contact's discussion thread, once opened (POST /contacts/:id/discussion). */
  discussions: Record<string, string>
}

const [contactDetailStore, setContactDetailStore] = createStore<ContactDetailState>({
  contacts: {},
  optOuts: {},
  discussions: {},
})
const [, setLoading] = createSignal(false)

function unwrapData<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in result
    ? (result as { data: T }).data
    : (result as T)
}

// Last API client seen — captured so the resync subscription can refetch
// loaded contacts without a component context.
let _contactDetailApi: DetailApi | null = null

/**
 * Load one contact into the store. Null when there is none to show (404: another org's id, a
 * deleted contact, one not shared with the reader): the page renders its not-found state from the
 * empty store entry, and nothing is thrown at a caller that fires and forgets.
 */
export async function loadContact(api: DetailApi, id: string): Promise<Contact | null> {
  _contactDetailApi = api
  setLoading(true)
  try {
    const contact = unwrapData<Contact | null>(await api.get(`/contacts/${id}`))
    if (!contact) {
      setContactDetailStore("contacts", id, undefined as unknown as Contact)
      return null
    }
    setContactDetailStore("contacts", id, contact)
    return contact
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      setContactDetailStore("contacts", id, undefined as unknown as Contact)
      return null
    }
    throw err
  } finally {
    setLoading(false)
  }
}

// --- Resync subscription ---
// On a resync bump, refetch every loaded contact in place (setContactDetailStore
// swaps the per-id record atomically — no wipe). Idempotent.
let _contactDetailResyncSubscribed = false

export function subscribeContactDetailResync(): void {
  if (_contactDetailResyncSubscribed) return
  _contactDetailResyncSubscribed = true
  subscribeResync(() => {
    const api = _contactDetailApi
    if (!api) return
    for (const id of Object.keys(contactDetailStore.contacts)) {
      // A failed refresh keeps what the page shows; the next resync tries again.
      loadContact(api, id)
        .then((c) => (c ? loadOptOut(api, id, c.email) : undefined))
        .catch(() => {})
    }
  })
}

/**
 * Ask the opt-out list about the contact's address (`mail:suppression_check`), as the reader. A
 * contact with no address is allowed by default: there is nothing to look up. A check the reader
 * may not run, or that failed, is "unavailable": the page never says Allowed for it.
 */
export async function loadOptOut(api: DetailApi, id: string, email: string | null): Promise<void> {
  if (!email) {
    setContactDetailStore("optOuts", id, { state: "allowed" })
    return
  }
  if (!api.post) throw new Error("this api client cannot post")
  try {
    const res = unwrapData<{
      results?: {
        optedOut?: boolean
        since?: string
        by?: "link" | "reply" | "person" | "import"
      }[]
      error?: unknown
    }>(await api.post("/apps/mail/tools/suppression_check", { params: { emails: [email] } }))
    const hit = res?.results?.[0]
    if (!hit || typeof hit.optedOut !== "boolean") {
      setContactDetailStore("optOuts", id, { state: "unavailable" })
      return
    }
    setContactDetailStore(
      "optOuts",
      id,
      hit.optedOut
        ? {
            state: "opted_out",
            ...(hit.since ? { since: hit.since } : {}),
            ...(hit.by ? { by: hit.by } : {}),
          }
        : { state: "allowed" },
    )
  } catch {
    setContactDetailStore("optOuts", id, { state: "unavailable" })
  }
}

/**
 * Open the contact's discussion: its thread, created the first time, with the
 * reader enrolled (the server proves they see the contact). Throws when it
 * could not be opened; the page says so and the rest of it stands.
 */
export async function openContactDiscussion(api: DetailApi, id: string): Promise<string> {
  const known = contactDetailStore.discussions[id]
  if (known) return known
  if (!api.post) throw new Error("this api client cannot post")
  const opened = unwrapData<{ threadId: string }>(await api.post(`/contacts/${id}/discussion`))
  setContactDetailStore("discussions", id, opened.threadId)
  return opened.threadId
}

export async function updateContact(
  api: DetailApi,
  id: string,
  patch: Partial<Contact>,
): Promise<Contact> {
  const updated = unwrapData<Contact>(await api.patch(`/contacts/${id}`, patch))
  setContactDetailStore("contacts", id, updated)
  return updated
}

export async function deleteContact(api: DetailApi, id: string): Promise<void> {
  await api.delete(`/contacts/${id}`)
  setContactDetailStore(
    produce((state) => {
      delete state.contacts[id]
      delete state.optOuts[id]
    }),
  )
}

type ContactEventData = Partial<Contact> & { id: string }

export function handleContactEvent(action: string, data: ContactEventData): void {
  if (action === "update" || action === "merge") {
    setContactDetailStore(
      produce((state) => {
        state.contacts[data.id] = state.contacts[data.id]
          ? { ...state.contacts[data.id], ...data }
          : (data as Contact)
      }),
    )
  } else if (action === "delete") {
    setContactDetailStore(
      produce((state) => {
        delete state.contacts[data.id]
        delete state.optOuts[data.id]
      }),
    )
  } else if (action === "share") {
    // Its sharing changed, and with it who is in its discussion: the page opens it again.
    setContactDetailStore(
      produce((state) => {
        delete state.discussions[data.id]
      }),
    )
  }
}

export function resetContactDetailStore(): void {
  setContactDetailStore({ contacts: {}, optOuts: {}, discussions: {} })
  setLoading(false)
}

onSessionTeardown(resetContactDetailStore)

export { contactDetailStore }

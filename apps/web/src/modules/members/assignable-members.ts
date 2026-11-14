// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The teammates a ticket or a project task can be assigned to, for the
// assignee pickers (ticket header menu, phone assign sheet, task assignee
// chip). Read from the member directory (`GET /mentions/members`, the users
// table), NOT the people search: the
// search answer is 503 while the index is not ready, clamped to ten rows, and
// any failure there used to leave the menu holding nothing but "Assign to me".
// A failure here is a visible state with a retry, never a silent empty list.
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"
import type { ApiClient } from "~/lib/api-client"

export interface AssignableMember {
  id: string
  name: string
  email: string
  /** Away today: until when. Who can be picked does not change. */
  away?: { until: string | null } | null
}

export type AssignableMembersStatus = "idle" | "loading" | "ready" | "error"

export const ASSIGNABLE_MEMBERS_PAGE = 50
const SEARCH_DEBOUNCE_MS = 150

export async function fetchAssignableMembers(
  api: Pick<ApiClient, "getEnvelope">,
  q: string,
  limit = ASSIGNABLE_MEMBERS_PAGE,
): Promise<{ items: AssignableMember[]; total: number }> {
  const qs = new URLSearchParams({ limit: String(limit) })
  const trimmed = q.trim()
  if (trimmed) qs.set("q", trimmed)
  const res = await api.getEnvelope<AssignableMember[]>(`/mentions/members?${qs.toString()}`)
  const items = Array.isArray(res?.data) ? res.data : []
  const total = typeof res?.meta?.total === "number" ? res.meta.total : items.length
  return { items, total }
}

/**
 * Loads while `active()` is true (the menu or sheet is open), reloads as the
 * query changes (debounced), and drops answers to a superseded query.
 */
export function createAssignableMembers(
  api: Pick<ApiClient, "getEnvelope">,
  active: Accessor<boolean>,
) {
  const [query, setQuery] = createSignal("")
  const [members, setMembers] = createSignal<AssignableMember[]>([])
  const [total, setTotal] = createSignal(0)
  const [status, setStatus] = createSignal<AssignableMembersStatus>("idle")
  let seq = 0
  let loadedFor: string | null = null

  async function load(q: string): Promise<void> {
    const mine = ++seq
    setStatus("loading")
    try {
      const res = await fetchAssignableMembers(api, q)
      if (mine !== seq) return
      setMembers(res.items)
      setTotal(res.total)
      setStatus("ready")
      loadedFor = q
    } catch {
      if (mine !== seq) return
      loadedFor = null
      setStatus("error")
    }
  }

  createEffect(
    on([active, query], ([isActive, q]) => {
      if (!isActive) return
      // Reopening the menu on the same query keeps the list it already has.
      if (loadedFor === q && status() === "ready") return
      if (!q.trim()) {
        void load(q)
        return
      }
      const timer = setTimeout(() => void load(q), SEARCH_DEBOUNCE_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )

  return {
    query,
    setQuery,
    members,
    total,
    status,
    retry: () => void load(query()),
  }
}

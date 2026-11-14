// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { Contact } from "./contact-list-store"

type MergeStep = "search" | "compare" | "confirm"

interface MergeApi {
  getEnvelope: <T>(path: string) => Promise<{ data: T }>
  post: <T>(path: string, body?: unknown) => Promise<T>
}

interface MergeState {
  open: boolean
  step: MergeStep
  sourceId: string | null
  targetId: string | null
  targetCandidates: Contact[]
  resolvedFields: Record<string, string>
  /** The source contact's mail conversations the merge moves to the target (first 100). */
  sourceConversations: number
  loading: boolean
  error: string | null
}

const initialState: MergeState = {
  open: false,
  step: "search",
  sourceId: null,
  targetId: null,
  targetCandidates: [],
  resolvedFields: {},
  sourceConversations: 0,
  loading: false,
  error: null,
}

const [mergeStore, setMergeStore] = createStore<MergeState>({ ...initialState })

function resetMergeState(): void {
  setMergeStore({ ...initialState, targetCandidates: [], resolvedFields: {} })
}

export function openMerge(sourceId: string): void {
  setMergeStore({ ...initialState, open: true, sourceId, targetCandidates: [], resolvedFields: {} })
}

export function closeMerge(): void {
  resetMergeState()
}

export async function searchTargets(api: MergeApi, query: string): Promise<void> {
  setMergeStore("loading", true)
  try {
    const params = new URLSearchParams()
    if (query.trim()) params.set("query", query.trim())
    params.set("page", "1")
    params.set("limit", "20")
    const res = await api.getEnvelope<Contact[]>(`/contacts?${params.toString()}`)
    setMergeStore(
      "targetCandidates",
      (res.data ?? []).filter((contact) => contact.id !== mergeStore.sourceId),
    )
  } finally {
    setMergeStore("loading", false)
  }
}

/** Count the source contact's mail conversations; none when the reader cannot read mail. */
export async function loadSourceConversations(api: MergeApi): Promise<void> {
  const sourceId = mergeStore.sourceId
  if (!sourceId) return
  const params = new URLSearchParams({ contactId: sourceId, limit: "100" })
  let count = 0
  try {
    const res = await api.getEnvelope<unknown[]>(`/mail/conversations?${params.toString()}`)
    count = Array.isArray(res.data) ? res.data.length : 0
  } catch {
    count = 0
  }
  if (mergeStore.sourceId === sourceId) setMergeStore("sourceConversations", count)
}

export function selectTarget(targetId: string): void {
  if (targetId === mergeStore.sourceId) {
    setMergeStore("error", "Cannot merge a contact with itself")
    return
  }
  setMergeStore("error", null)
  setMergeStore({ targetId, step: "compare" })
}

export function setFieldChoice(field: string, value: string): void {
  setMergeStore("resolvedFields", field, value)
}

export function setStep(step: MergeStep): void {
  setMergeStore("step", step)
}

export async function confirmMerge(api: MergeApi): Promise<any> {
  if (!mergeStore.sourceId || !mergeStore.targetId)
    throw new Error("Select source and target contacts before merging")
  if (mergeStore.sourceId === mergeStore.targetId)
    throw new Error("Cannot merge a contact with itself")
  setMergeStore("loading", true)
  setMergeStore("error", null)
  try {
    const result = await api.post("/contacts/merge", {
      sourceId: mergeStore.sourceId,
      targetId: mergeStore.targetId,
      resolvedFields: mergeStore.resolvedFields,
    })
    resetMergeState()
    return result && typeof result === "object" && "data" in result ? (result as any).data : result
  } catch (err) {
    setMergeStore("error", err instanceof Error ? err.message : "Failed to merge contacts")
    throw err
  } finally {
    setMergeStore("loading", false)
  }
}

export function resetContactMergeStore(): void {
  resetMergeState()
}

onSessionTeardown(resetContactMergeStore)

export { mergeStore }

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Companies on the web: the list page's rows and the company page's record,
// people, account manager and waiting approvals. Everything is read as the
// viewer: a company they cannot see is "no access", never an error.
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface CompanyApi {
  get: <T>(path: string) => Promise<T>
  getEnvelope: <T>(
    path: string,
  ) => Promise<{ data: T; meta?: { total?: number; nextCursor?: string | null } }>
  post?: <T>(path: string, body?: unknown) => Promise<T>
}

export interface CompanyDeal {
  taskId: string
  /** The deal's title and its board; absent from an older server. */
  title?: string
  projectId?: string
  stage: string | null
  /** Null without deal access, or when the deal has no amount. */
  amountMinor: number | null
  currency: string | null
}

export interface Company {
  id: string
  name: string
  handle?: string
  domain: string | null
  description: string | null
  tags?: string[]
  closedAt?: string | null
  ownerUserId?: string | null
  createdBy?: string | null
  orgAccess?: "none" | "viewer" | "editor"
  createdAt?: string
  updatedAt?: string
  peopleCount: number
  openDeal: CompanyDeal | null
}

export interface CompanyPerson {
  id: string
  name: string | null
  role: string | null
  email: string | null
  isMain: boolean
  lastInboundAt: string | null
}

export interface CompanyManager {
  id: string
  name: string
  away: { until: string; nextInLine: { id: string; name: string } | null } | null
}

interface CompanyState {
  /** A loaded company, or null once the server said the viewer cannot see it. */
  companies: Record<string, Company | null>
  people: Record<string, CompanyPerson[]>
  managers: Record<string, CompanyManager | null>
  /** Ids of the pending approvals linked to the company, its people or its deals. */
  waiting: Record<string, string[]>
  discussions: Record<string, string>
  /** The companies that look like this one, as the duplicate finder pairs them. */
  duplicates: Record<string, CompanyDuplicate[]>
}

export interface CompanyDuplicate {
  /** The other company of the pair. */
  id: string
  name: string
  signal: "same_domain" | "same_name" | "same_name_and_domain"
}

interface DuplicateCluster {
  ids: string[]
  names: string[]
  signal: CompanyDuplicate["signal"]
}

const [companyStore, setCompanyStore] = createStore<CompanyState>({
  companies: {},
  people: {},
  managers: {},
  waiting: {},
  discussions: {},
  duplicates: {},
})

export { companyStore }

function unwrap<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

function hidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 403)
}

/** Run a kernel tool as the viewer's own call (reads only). */
async function runKernelTool<T>(api: CompanyApi, tool: string, params: unknown): Promise<T> {
  if (!api.post) throw new Error("this api client cannot post")
  return unwrap(
    await api.post<T | { data: T }>("/apps/run-tool", { toolName: `kernel:${tool}`, params }),
  ) as T
}

/** Load one company; null when the viewer cannot see it (the page shows no access). */
export async function loadCompany(api: CompanyApi, id: string): Promise<Company | null> {
  try {
    const company = unwrap(await api.get<Company | { data: Company }>(`/contacts/companies/${id}`))
    setCompanyStore("companies", id, company ?? null)
    return company ?? null
  } catch (err) {
    if (hidden(err)) {
      setCompanyStore("companies", id, null)
      return null
    }
    throw err
  }
}

/** The company's people (most recent mail first) and its account manager. */
export async function loadCompanyPeople(api: CompanyApi, id: string): Promise<void> {
  const res = await runKernelTool<{
    people?: CompanyPerson[]
    accountManager?: CompanyManager | null
  }>(api, "companies_read", { companyId: id })
  const people = [...(res?.people ?? [])].sort((a, b) =>
    (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? ""),
  )
  setCompanyStore("people", id, people)
  setCompanyStore("managers", id, res?.accountManager ?? null)
}

/** Ids of the pending approvals the viewer sees that link this company. */
export async function loadCompanyWaiting(api: CompanyApi, id: string): Promise<void> {
  try {
    const res = unwrap(
      await api.get<{ approvalIds: string[] } | { data: { approvalIds: string[] } }>(
        `/contacts/companies/${id}/waiting`,
      ),
    )
    setCompanyStore("waiting", id, res?.approvalIds ?? [])
  } catch {
    // Waiting is shown only when it has rows: a failed read shows none.
    setCompanyStore("waiting", id, [])
  }
}

/** Link people to the company: their company and company name change together. */
export async function linkCompanyPeople(
  api: CompanyApi,
  id: string,
  contactIds: string[],
): Promise<void> {
  if (!api.post) throw new Error("this api client cannot post")
  await api.post(`/contacts/companies/${id}/contacts`, { contactIds })
}

/** The company's discussion thread, created the first time it is opened. */
export async function openCompanyDiscussion(api: CompanyApi, id: string): Promise<string> {
  const known = companyStore.discussions[id]
  if (known) return known
  if (!api.post) throw new Error("this api client cannot post")
  const opened = unwrap(
    await api.post<{ threadId: string } | { data: { threadId: string } }>(
      `/contacts/companies/${id}/discussion`,
    ),
  )
  setCompanyStore("discussions", id, opened.threadId)
  return opened.threadId
}

/**
 * Set the company's account manager (null: none). The person's click is the
 * decision; a policy may still hold it for approval, which the answer says.
 */
export async function setCompanyManager(
  api: CompanyApi,
  id: string,
  ownerUserId: string | null,
): Promise<"changed" | "pending" | "skipped"> {
  const res = await runKernelTool<{
    blocked?: unknown
    accountManager?: CompanyManager | null
    moved?: unknown[]
  }>(api, "companies_write", { companyId: id, ownerUserId })
  if (res?.blocked) return "pending"
  if (!res?.moved || res.moved.length === 0) return "skipped"
  // Replace the manager, never merge into the previous one (a store merge
  // would write the new name into the old manager's object).
  setCompanyStore("managers", { [id]: res.accountManager ?? null })
  return "changed"
}

function applyDuplicateClusters(clusters: DuplicateCluster[]): void {
  setDuplicateIds(new Set(clusters.flatMap((c) => c.ids)))
  const byCompany: Record<string, CompanyDuplicate[]> = {}
  for (const c of clusters) {
    const [a, b] = c.ids
    const [an, bn] = c.names
    if (!a || !b) continue
    byCompany[a] = [...(byCompany[a] ?? []), { id: b, name: bn ?? "", signal: c.signal }]
    byCompany[b] = [...(byCompany[b] ?? []), { id: a, name: an ?? "", signal: c.signal }]
  }
  setCompanyStore("duplicates", byCompany)
}

/** The pairs that look like one company; the list's badges and the page's panel follow them. */
export async function loadCompanyDuplicates(api: CompanyApi): Promise<void> {
  const res = await runKernelTool<{ clusters?: DuplicateCluster[] }>(
    api,
    "companies_find_duplicates",
    {},
  )
  applyDuplicateClusters(res?.clusters ?? [])
}

/** Drop one pair from what the page and the list show (after "Keep them separate" or a merge). */
function forgetPair(a: string, b: string): void {
  const without = (id: string, other: string) =>
    (companyStore.duplicates[id] ?? []).filter((d) => d.id !== other)
  setCompanyStore("duplicates", a, without(a, b))
  setCompanyStore("duplicates", b, without(b, a))
  const still = new Set<string>()
  for (const [id, list] of Object.entries(companyStore.duplicates)) {
    if (list.length > 0) {
      still.add(id)
      for (const d of list) still.add(d.id)
    }
  }
  setDuplicateIds(still)
}

/** "Keep them separate": the pair is no longer suggested; `undo` takes it back. */
export async function markCompaniesNotSame(
  api: CompanyApi,
  a: CompanyDuplicate & { self: string },
  undo = false,
): Promise<void> {
  await runKernelTool(api, "companies_mark_not_same", { aId: a.self, bId: a.id, undo })
  if (!undo) {
    forgetPair(a.self, a.id)
    return
  }
  const back = (id: string, other: CompanyDuplicate) => [
    ...(companyStore.duplicates[id] ?? []).filter((d) => d.id !== other.id),
    other,
  ]
  const selfName = companyStore.companies[a.self]?.name ?? ""
  setCompanyStore("duplicates", a.self, back(a.self, { id: a.id, name: a.name, signal: a.signal }))
  setCompanyStore("duplicates", a.id, back(a.id, { id: a.self, name: selfName, signal: a.signal }))
  setDuplicateIds(new Set([...duplicateIds(), a.self, a.id]))
}

/** Merge `sourceId` into `targetId` (the page's company): the source is deleted. */
export async function mergeCompanyInto(
  api: CompanyApi,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const res = await runKernelTool<{ blocked?: unknown }>(api, "companies_merge", {
    sourceId,
    targetId,
  })
  if (res?.blocked) throw new Error("the merge was held for approval")
  forgetPair(sourceId, targetId)
}

// ── The list ─────────────────────────────────────────────────────────────

const LIST_LIMIT = 50

interface ListState {
  byId: Record<string, Company>
  ids: string[]
}

const [companyListStore, setCompanyListStore] = createStore<ListState>({ byId: {}, ids: [] })
const [listQuery, setListQuery] = createSignal("")
const [listTotal, setListTotal] = createSignal(0)
const [listLoading, setListLoading] = createSignal(false)
const [listError, setListError] = createSignal(false)
const [listLoaded, setListLoaded] = createSignal(false)
/** People whose company text names a company not created yet (0 hides the hint). */
const [proposalCount, setProposalCount] = createSignal(0)
/** Companies that look like another one. */
const [duplicateIds, setDuplicateIds] = createSignal<ReadonlySet<string>>(new Set())

export {
  companyListStore,
  duplicateIds,
  listError,
  listLoaded,
  listLoading,
  listQuery,
  listTotal,
  proposalCount,
}

export function setCompanyListQuery(value: string): void {
  setListQuery(value)
}

let listRequest = 0

export async function loadCompanies(api: CompanyApi): Promise<void> {
  const mine = ++listRequest
  setListLoading(true)
  setListError(false)
  const params = new URLSearchParams({ limit: String(LIST_LIMIT) })
  const q = listQuery().trim()
  if (q) params.set("query", q)
  try {
    const res = await api.getEnvelope<Company[]>(`/contacts/companies?${params.toString()}`)
    if (mine !== listRequest) return
    setCompanyListStore(
      produce((state) => {
        state.byId = {}
        state.ids = []
        for (const company of res.data ?? []) {
          state.byId[company.id] = company
          state.ids.push(company.id)
        }
      }),
    )
    setListTotal(res.meta?.total ?? res.data?.length ?? 0)
    setListLoaded(true)
  } catch {
    if (mine === listRequest) setListError(true)
  } finally {
    if (mine === listRequest) setListLoading(false)
  }
}

/** The empty state's "Your contacts already name N companies" and the duplicate badges. */
export async function loadCompanyHints(api: CompanyApi): Promise<void> {
  try {
    const proposal = await runKernelTool<{
      groups?: Array<{ existingCompanyId?: string | null }>
    }>(api, "companies_propose_from_contacts", {})
    setProposalCount((proposal?.groups ?? []).filter((g) => !g.existingCompanyId).length)
  } catch {
    setProposalCount(0)
  }
  try {
    await loadCompanyDuplicates(api)
  } catch {
    setDuplicateIds(new Set<string>())
  }
}

/** A company event from the socket: the list and an open page follow it. */
export function handleCompanyEvent(action: string, data: Partial<Company> & { id: string }): void {
  if (!data?.id) return
  if (action === "delete" || action === "merge") {
    setCompanyListStore(
      produce((state) => {
        delete state.byId[data.id]
        state.ids = state.ids.filter((id) => id !== data.id)
      }),
    )
    if (companyStore.companies[data.id]) setCompanyStore("companies", data.id, null)
    return
  }
  if (companyListStore.byId[data.id]) {
    setCompanyListStore("byId", data.id, (prev) => ({ ...prev, ...data }))
  }
  const open = companyStore.companies[data.id]
  if (open) setCompanyStore("companies", data.id, { ...open, ...data })
}

/** Clears every company state, and drops any list read still in flight. */
export function resetCompanyStores(): void {
  listRequest += 1
  setCompanyStore({
    companies: {},
    people: {},
    managers: {},
    waiting: {},
    discussions: {},
    duplicates: {},
  })
  setCompanyListStore({ byId: {}, ids: [] })
  setListQuery("")
  setListTotal(0)
  setListLoading(false)
  setListError(false)
  setListLoaded(false)
  setProposalCount(0)
  setDuplicateIds(new Set<string>())
}

// A sign-out, or another person signing in, never sees the last person's companies.
onSessionTeardown(resetCompanyStores)

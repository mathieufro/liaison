// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the deal board and the deal panel read and write. The board is the
// pipeline's read model (`GET /projects/:id/deals/board`): stages with their
// deals, a sum per currency only for a reader with deal access, and quiet
// days only for a reader who can read mail. The panel reads one deal through
// `deals_search` and writes through `deals_update`, as the person's own click.

import type { ApiClient } from "~/lib/api-client"

export interface BoardDealAmount {
  amountMinor: number | null
  currency: string | null
  amountPeriod: string
}

export interface BoardDeal {
  taskId: string
  key: string
  title: string
  assigneeId: string | null
  companyId: string | null
  companyName: string | null
  contactId: string | null
  nextStep: string | null
  closedAt: string | null
  /** Null when the reader cannot read mail: the card shows no quiet line. */
  quietDays: number | null
  /** Absent for a reader without deal access. */
  amount?: BoardDealAmount
}

export interface CurrencySum {
  currency: string
  sum_minor: number
}

export interface BoardColumn {
  statusId: string
  label: string
  dealOutcome: "won" | "lost" | null
  count: number
  /** Absent for a reader without deal access. */
  sums?: CurrencySum[]
  deals: BoardDeal[]
}

export interface DealBoard {
  projectId: string
  timeZone: string
  closedMonth: string
  columns: BoardColumn[]
}

export interface DealRead {
  task: {
    id: string
    key: string
    title: string
    projectId: string
    stage: string | null
    ownerId: string | null
  }
  deal: {
    companyId: string | null
    companyName: string | null
    contactId: string | null
    outcome: "open" | "won" | "lost"
    nextStep: string | null
    lostReason: string | null
    closedAt: string | null
    closedBy: string | null
  }
  /** Absent for a reader without deal access. */
  values?: {
    amountMinor: number | null
    currency: string | null
    amountPeriod: "once" | "month" | "year"
    probability: number | null
  }
}

export interface DealUpdate {
  taskId: string
  outcome?: "won" | "lost" | "open"
  reason?: string | null
}

type DealApi = Pick<ApiClient, "get" | "post">

function unwrap<T>(result: unknown): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

export async function loadDealBoard(api: DealApi, projectId: string): Promise<DealBoard> {
  return unwrap<DealBoard>(await api.get(`/projects/${projectId}/deals/board`))
}

async function runProjectsTool<T>(api: DealApi, tool: string, params: object): Promise<T> {
  return unwrap<T>(await api.post("/apps/run-tool", { toolName: `projects:${tool}`, params }))
}

/** The deal of a task, or null when the task is not a deal the reader can see. */
export async function readDeal(api: DealApi, taskId: string): Promise<DealRead | null> {
  const res = await runProjectsTool<{ items?: DealRead[]; error?: unknown }>(api, "deals_search", {
    taskId,
    limit: 1,
  })
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error("deal_read_failed")
  }
  return res?.items?.[0] ?? null
}

/** Mark won, mark lost (with an optional reason), reopen, or save the lost reason. */
export async function updateDeal(api: DealApi, update: DealUpdate): Promise<void> {
  const res = await runProjectsTool<{ error?: unknown }>(api, "deals_update", update)
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error("deal_update_failed")
  }
}

/** Open deals and their sum per currency, from the board's open columns. */
export function openTotals(board: DealBoard): { count: number; sums: CurrencySum[] | null } {
  const open = board.columns.filter((c) => c.dealOutcome === null)
  const count = open.reduce((n, c) => n + c.count, 0)
  if (open.some((c) => c.sums === undefined)) return { count, sums: null }
  const by = new Map<string, number>()
  for (const c of open) {
    for (const s of c.sums ?? []) by.set(s.currency, (by.get(s.currency) ?? 0) + s.sum_minor)
  }
  const sums = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sum_minor]) => ({ currency, sum_minor }))
  return { count, sums }
}

/** "€17,400", or "€17,400 · $2,000": currencies are never added together. */
export function formatSums(
  sums: readonly CurrencySum[],
  fmt: (amount: number, currency: string) => string,
): string {
  return sums.map((s) => fmt(s.sum_minor / 100, s.currency)).join(" · ")
}

/** "TR" for "Tom Reyes", "É" for "Élise". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
}

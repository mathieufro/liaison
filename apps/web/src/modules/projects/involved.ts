// SPDX-License-Identifier: FSL-1.1-ALv2
// "Recently involved": the tasks the signed-in person commented on, was
// mentioned in, changed, created or was assigned in the last N days, as the
// API computes them (GET /projects/involved). Shared by the projects home
// (cross-project list) and a project workspace (filtered to that project).
import { relativeTime } from "~/lib/relative-time"

export const INVOLVED_DEFAULT_DAYS = 14
export const INVOLVED_MAX_DAYS = 90

export type InvolvementKind =
  | "commented"
  | "mentioned"
  | "status_changed"
  | "assigned_self"
  | "assigned_other"
  | "unassigned"
  | "moved_project"
  | "edited"
  | "assigned_by"
  | "created"
  | "assignee"

export interface Involvement {
  kind: InvolvementKind
  at: string
  viaAgent: boolean
  actorName: string | null
  statusLabel: string | null
  assigneeName: string | null
  projectName: string | null
  fields: string[]
  summary: string
}

export interface InvolvedTask {
  id: string
  key: string | null
  title: string
  projectId: string
  projectName: string
  statusId: string
  statusLabel: string | null
  statusTerminal: boolean
  assigneeId: string | null
  dueDate: string | null
  /** The task's timebox: present only on a task of a project using time and budgets. */
  timeboxMinutes?: number | null
  involvement: Involvement
}

interface ApiLike {
  get: <T>(path: string) => Promise<T>
}

/** A saved-view or stored value as a window in days (1..90), or null for "off". */
export function parseInvolvedDays(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null
  return Math.min(INVOLVED_MAX_DAYS, Math.max(1, Math.round(raw)))
}

/** The involved tasks, newest involvement first (at most 200). */
export async function fetchInvolvedTasks(
  api: ApiLike,
  opts: {
    days: number
    projectId?: string
    release?: string | null
    labels?: Record<string, string>
  },
): Promise<InvolvedTask[]> {
  const params = new URLSearchParams({ days: String(opts.days), limit: "200" })
  if (opts.projectId) params.set("projectId", opts.projectId)
  if (opts.release) params.set("release", opts.release)
  if (opts.labels && Object.keys(opts.labels).length > 0) {
    params.set("labels", JSON.stringify(opts.labels))
  }
  const res = await api.get<{ items: InvolvedTask[] }>(`/projects/involved?${params.toString()}`)
  return res.items ?? []
}

type T = (key: string, vars?: Record<string, string | number>) => string

/** Why the task is on the list, in the reader's language ("You commented"). */
export function involvementReason(inv: Involvement, t: T): string {
  const base = (() => {
    switch (inv.kind) {
      case "commented":
        return t("projects.involvedCommented")
      case "mentioned":
        return inv.actorName
          ? t("projects.involvedMentioned", { name: inv.actorName })
          : t("projects.involvedMentionedAnon")
      case "status_changed":
        return inv.statusLabel
          ? t("projects.involvedStatusChanged", { status: inv.statusLabel })
          : t("projects.involvedStatusChangedAnon")
      case "assigned_self":
        return t("projects.involvedAssignedSelf")
      case "assigned_other":
        return t("projects.involvedAssignedOther", { name: inv.assigneeName ?? "" })
      case "unassigned":
        return t("projects.involvedUnassigned")
      case "moved_project":
        return t("projects.involvedMovedProject", { project: inv.projectName ?? "" })
      case "edited":
        return t("projects.involvedEdited")
      case "assigned_by":
        return inv.actorName
          ? t("projects.involvedAssignedBy", { name: inv.actorName })
          : t("projects.involvedAssignedByAnon")
      case "created":
        return t("projects.involvedCreated")
      case "assignee":
        return t("projects.involvedAssignee")
      default:
        return inv.summary
    }
  })()
  const agentDid = inv.viaAgent && inv.kind !== "mentioned" && inv.kind !== "assigned_by"
  return agentDid ? `${base} (${t("projects.involvedViaAgent")})` : base
}

/** "You commented · 2 hours ago". */
export function involvementLine(inv: Involvement, t: T, locale: string): string {
  return `${involvementReason(inv, t)} · ${relativeTime(inv.at, locale, { style: "long" })}`
}

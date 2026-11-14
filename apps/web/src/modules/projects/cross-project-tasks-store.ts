// SPDX-License-Identifier: FSL-1.1-ALv2
// Cross-project task list backing the projects-home filtered view.
//
// Lifted out of ProjectsHome (which owns the fetch) so ProjectsSidebar can
// read the SAME rows to compute Due/status chip counts on the home screen
// (PRJ-5) — without this, the sidebar had no cross-project task data at all
// and rendered every chip with no count when no single project was active.
import { createSignal } from "solid-js"
import type { Involvement } from "~/modules/projects/involved"

export interface CrossProjectTaskSummary {
  id: string
  key?: string
  title: string
  statusLabel: string
  terminal: boolean
  projectId: string
  projectName: string
  assigneeId: string | null
  dueDate: string | null
  /** The task's timebox: present only on a task of a project using time and budgets. */
  timeboxMinutes?: number | null
  /** Why it is listed, when "Recently involved" is on (rows then come newest involvement first). */
  involvement?: Involvement
}

const [items, setItems] = createSignal<CrossProjectTaskSummary[]>([])

export const crossProjectTasksStore = {
  items,
  setItems,
}

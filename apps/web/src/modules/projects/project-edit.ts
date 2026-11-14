// SPDX-License-Identifier: FSL-1.1-ALv2
// Edit a project's own fields through PATCH /projects/:id, then reflect the
// saved project in both stores (the open workspace and the project list), as
// archive and restore do (project-archive.ts).

import type { ApiClient } from "~/lib/api-client"
import { summaryFrom } from "~/modules/projects/project-archive"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { projectsStore } from "~/modules/projects/projects-store"

export interface ProjectEditPatch {
  name?: string
  key?: string
  description?: string | null
  icon?: string | null
  color?: string | null
  group?: string | null
  /** The client company; null clears it. */
  companyId?: string | null
  /** Time and budgets on this project. */
  timeBudgets?: boolean
}

export async function updateProjectFields(
  api: ApiClient,
  projectId: string,
  patch: ProjectEditPatch,
): Promise<ProjectDetail> {
  const saved = await api.patch<ProjectDetail>(`/projects/${projectId}`, patch)
  // The server leaves out a cleared client; say so, or the merge keeps the old one.
  const detail = "companyId" in patch && !saved.companyId ? { ...saved, companyId: null } : saved
  projectStore.handleProjectEvent("updated", detail)
  const summary = summaryFrom(detail, projectId)
  if (summary) projectsStore.upsert(summary)
  return detail
}

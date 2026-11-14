// SPDX-License-Identifier: FSL-1.1-ALv2
// The one guard of time and budgets: a project plans time and money only when
// the org uses it, the project is a work project and its switch is on. Every
// tool that plans or bills from hours asks `assertPlanningOn` first and, when
// the project does not use it, answers `planning_off` and writes nothing.
import { isFeatureOffForTool } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"
import { ProjectsServiceError } from "./statuses"

export const TIME_FEATURE = "time_budgets"

/** Sync read of this process's cache: does any project of the org use time and budgets? */
export function orgUsesTimeBudgets(orgId: string): boolean {
  return !isFeatureOffForTool(orgId, { appName: "projects", feature: TIME_FEATURE })
}

/** The scope that edits a project, and so turns its time and budgets on. */
export const TURN_ON_SCOPE = "projects:projects:write"

export interface PlanningProject {
  id: string
  key: string | null
  name: string
  kind: "work" | "pipeline"
  timeBudgetsOn: boolean
  /** The project's lead (its owner), named when the asker cannot turn it on. */
  leadName: string | null
}

export function planningOn(
  project: Pick<PlanningProject, "kind" | "timeBudgetsOn">,
  orgInUse: boolean,
): boolean {
  return orgInUse && project.kind === "work" && project.timeBudgetsOn
}

export interface PlanningOffBody {
  project: { id: string; key: string | null; name: string } | null
  message: string
  canTurnOn: boolean
  lead?: { name: string }
  next: string
}

/**
 * The body of the refusal, worded for the asker. `project` null is an ask that names no
 * project: time and budgets are per project, so the agent asks which one.
 */
export function planningOffBody(
  project: PlanningProject | null,
  askerScopes: readonly string[],
): PlanningOffBody {
  if (!project) {
    return {
      project: null,
      message: "Time and budgets are per project, and no project was named, so nothing was read.",
      canTurnOn: false,
      next: "Ask which project the person means, then repeat the request for that project.",
    }
  }
  const ref = { id: project.id, key: project.key, name: project.name }
  if (project.kind === "pipeline") {
    return {
      project: ref,
      message: `${project.name} tracks deals, so it has no planned time or budget.`,
      canTurnOn: false,
      next: "Say so. Do not offer to turn it on.",
    }
  }
  const message = `${project.name} does not use time and budgets, so it has no planned time or budget.`
  const lead = project.leadName ? { lead: { name: project.leadName } } : {}
  if (hasScope(TURN_ON_SCOPE, [...askerScopes])) {
    return {
      project: ref,
      message,
      canTurnOn: true,
      ...lead,
      next: "Offer to turn it on. If the person agrees, call update_project with timeBudgets:true, then repeat the request. Never work out a figure another way.",
    }
  }
  const who = project.leadName
    ? `${project.leadName}, its lead, or an admin`
    : "Its lead or an admin"
  return {
    project: ref,
    message,
    canTurnOn: false,
    ...lead,
    next: `Say that ${who} can turn it on.`,
  }
}

/** Throws `planning_off` (409) unless the project plans time and money. */
export function assertPlanningOn(
  project: PlanningProject | null,
  orgInUse: boolean,
  askerScopes: readonly string[],
): void {
  if (project && planningOn(project, orgInUse)) return
  const body = planningOffBody(project, askerScopes)
  throw new ProjectsServiceError(409, "planning_off", body.message, body)
}

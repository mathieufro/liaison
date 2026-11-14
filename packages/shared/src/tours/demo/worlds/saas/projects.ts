// SPDX-License-Identifier: FSL-1.1-ALv2
/** The software world's projects scenario: a developer asks for help on a task of the product project. */
import { buildProjectsTour, type ProjectsScenarioCfg } from "../../projects"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/projects-comment.ts`). */
export const SAAS_PROJECTS_COMMENT_INJECTOR = "saas-projects-comment"

/** The product project the visitor's task sits in. */
export const SAAS_PROJECT_NAME = "Product"

export const SAAS_PROJECTS_CFG: ProjectsScenarioCfg = {
  world: "saas",
  copy: "saasProjects",
  injector: SAAS_PROJECTS_COMMENT_INJECTOR,
  projectName: SAAS_PROJECT_NAME,
}

export const scenarioSaasProjectsTour = buildProjectsTour(SAAS_PROJECTS_CFG)

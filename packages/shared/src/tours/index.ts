// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tour registry. Shipped tours are grouped by owning app (`./kernel/`,
 * `./tickets/`, …) and listed in TOURS. TEST_TOURS are fixtures for tests: the
 * API serves them only under NODE_ENV=test and the web resolves them only in a
 * non-production build (`findTour(id, { includeTestTours })`).
 */
import { apiConnectorSettingsTour } from "./api-connector/settings"
import { DEMO_SCENARIO_TOURS, SCENARIO_TOURS, WORLD_SCENARIO_TOURS } from "./demo"
import { kernelAgentsTour } from "./kernel/agents"
import { kernelAutoplayFixtureTour } from "./kernel/autoplay-fixture"
import { kernelRoutinesTour } from "./kernel/routines"
import { kernelSampleTour } from "./kernel/sample"
import { kernelSessionsTour } from "./kernel/sessions"
import { kernelThreadsTour } from "./kernel/threads"
import { kernelWorldFixtureTour } from "./kernel/world-fixture"
import { knowledgeBasicsTour } from "./knowledge/basics"
import { mailBasicsTour } from "./mail/basics"
import { projectsBasicsTour } from "./projects/basics"
import type { Tour } from "./schema"
import { ticketsBasicsTour } from "./tickets/basics"

/** Shipped tours, in the order "Show me how" lists them. */
export const TOURS: readonly Tour[] = [
  kernelThreadsTour,
  kernelAgentsTour,
  mailBasicsTour,
  ticketsBasicsTour,
  knowledgeBasicsTour,
  projectsBasicsTour,
  kernelRoutinesTour,
  kernelSessionsTour,
  apiConnectorSettingsTour,
]

/** The seeded routine the sales scenario switches on. */
export { heldRequestCard } from "./agent-steps"
export {
  SAAS_BUGS_CHANNEL_TITLE,
  SAAS_CHAT_QUESTION_INJECTOR,
  SAAS_KNOWLEDGE_ASKS_INJECTOR,
  SAAS_KNOWLEDGE_DOC_TITLE,
  SAAS_PROJECT_NAME,
  SAAS_PROJECTS_COMMENT_INJECTOR,
  SAAS_PROSPECT_ROUTINE_NAME,
  SAAS_SALES_EMAIL_INJECTOR,
  SAAS_SUPPORT_TICKET_INJECTOR,
} from "./demo"
export { DEV_BUGS_CHANNEL_TITLE } from "./demo/dev"
export { KNOWLEDGE_SCENARIO_PL_TITLE } from "./demo/knowledge"
export { MONEY_FIGURES_TOOL, MONEY_REMINDER_ROW } from "./demo/money"
export { PROSPECT_ROUTINE_NAME } from "./demo/sales"
export { SAAS_PAYMENT_RECOVERED_INJECTOR } from "./demo/worlds/saas/money"
/** The demo scenarios (`demoOnly`: offered in demo orgs only), the products world's and the others'. */
export { DEMO_SCENARIO_TOURS, SCENARIO_TOURS, WORLD_SCENARIO_TOURS }

export const TEST_TOURS: readonly Tour[] = [
  kernelSampleTour,
  kernelAutoplayFixtureTour,
  kernelWorldFixtureTour,
]

export interface FindTourOptions {
  includeTestTours?: boolean
}

/** The catalogue a caller sees: shipped tours and demo scenarios, plus fixtures when asked. */
export function tourCatalogue(opts: FindTourOptions = {}): readonly Tour[] {
  const shipped = [...TOURS, ...DEMO_SCENARIO_TOURS]
  return opts.includeTestTours ? [...shipped, ...TEST_TOURS] : shipped
}

export function findTour(id: string, opts: FindTourOptions = {}): Tour | undefined {
  return tourCatalogue(opts).find((t) => t.id === id)
}

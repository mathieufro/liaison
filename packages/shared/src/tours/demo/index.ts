// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The demo scenarios: one guided tour per need a demo visitor can pick
 * (`DEMO_NEED_SPECS[need].scenarioTourId`), each `demoOnly`, so a regular
 * org's "Show me how" never lists them and their routes answer 404 there.
 */
import { scenarioChatTour } from "./chat"
import { scenarioCommerceTour } from "./commerce"
import { scenarioDevTour } from "./dev"
import { scenarioKnowledgeTour } from "./knowledge"
import { scenarioProjectsTour } from "./projects"
import { scenarioSalesTour } from "./sales"
import { scenarioSupportTour } from "./support"
import { scenarioSaasChatTour } from "./worlds/saas/chat"
import { scenarioSaasDevTour } from "./worlds/saas/dev"
import { scenarioSaasKnowledgeTour } from "./worlds/saas/knowledge"
import { scenarioSaasMoneyTour } from "./worlds/saas/money"
import { scenarioSaasProjectsTour } from "./worlds/saas/projects"
import { scenarioSaasSalesTour } from "./worlds/saas/sales"
import { scenarioSaasSupportTour } from "./worlds/saas/support"

/** In `DEMO_NEEDS` order (support, projects, chat, sales, commerce, dev, knowledge). */
export const SCENARIO_TOURS = [
  scenarioSupportTour,
  scenarioProjectsTour,
  scenarioChatTour,
  scenarioSalesTour,
  scenarioCommerceTour,
  scenarioDevTour,
  scenarioKnowledgeTour,
] as const

/**
 * The scenarios of the other demo worlds (`kernel.scenario-<world>-<need>`),
 * each offered only in a workspace of its own world.
 */
export const WORLD_SCENARIO_TOURS = [
  scenarioSaasSupportTour,
  scenarioSaasProjectsTour,
  scenarioSaasChatTour,
  scenarioSaasSalesTour,
  scenarioSaasMoneyTour,
  scenarioSaasDevTour,
  scenarioSaasKnowledgeTour,
] as const

/** Every demo scenario, of every world. */
export const DEMO_SCENARIO_TOURS = [...SCENARIO_TOURS, ...WORLD_SCENARIO_TOURS] as const

/** The builders a world's configuration is built on (`PRODUCTS_CFG` is the products world's). */
export { buildChatTour } from "./chat"
export { buildCommerceTour } from "./commerce"
export { buildDevTour, type DevScenarioCfg, PRODUCTS_DEV_CFG } from "./dev"
export {
  buildKnowledgeTour,
  type KnowledgeScenarioCfg,
  PRODUCTS_KNOWLEDGE_CFG,
} from "./knowledge"
export {
  buildMoneyTour,
  MONEY_FIGURES_TOOL,
  MONEY_REMINDER_ROW,
  type MoneyScenarioCfg,
} from "./money"
export { buildProjectsTour, PRODUCTS_PROJECT_NAME, type ProjectsScenarioCfg } from "./projects"
export { buildSalesTour, PRODUCTS_SALES_CFG, type SalesScenarioCfg } from "./sales"
export { PRODUCTS_CFG, type ScenarioCfg, type ScenarioExtraBeat } from "./shared"
export { buildSupportTour } from "./support"
export {
  SAAS_CHAT_CFG,
  SAAS_CHAT_QUESTION_INJECTOR,
  scenarioSaasChatTour,
} from "./worlds/saas/chat"
export {
  SAAS_BUGS_CHANNEL_TITLE,
  SAAS_DEV_CFG,
  SAAS_TELL_TOOL,
  scenarioSaasDevTour,
} from "./worlds/saas/dev"
export {
  SAAS_KNOWLEDGE_ASKS_INJECTOR,
  SAAS_KNOWLEDGE_CFG,
  SAAS_KNOWLEDGE_DOC_TITLE,
  scenarioSaasKnowledgeTour,
} from "./worlds/saas/knowledge"
export {
  SAAS_MONEY_CFG,
  SAAS_PAYMENT_RECOVERED_INJECTOR,
  scenarioSaasMoneyTour,
} from "./worlds/saas/money"
export {
  SAAS_PROJECT_NAME,
  SAAS_PROJECTS_CFG,
  SAAS_PROJECTS_COMMENT_INJECTOR,
  scenarioSaasProjectsTour,
} from "./worlds/saas/projects"
export {
  SAAS_COMPANY_WRITE_TOOL,
  SAAS_PROSPECT_ROUTINE_NAME,
  SAAS_SALES_CFG,
  SAAS_SALES_EMAIL_INJECTOR,
  scenarioSaasSalesTour,
} from "./worlds/saas/sales"
export {
  SAAS_SUPPORT_CFG,
  SAAS_SUPPORT_TICKET_INJECTOR,
  scenarioSaasSupportTour,
} from "./worlds/saas/support"

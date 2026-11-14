// SPDX-License-Identifier: FSL-1.1-ALv2
/** The software world's support scenario: a customer reports a broken export, with a linked task. */

import type { ScenarioCfg } from "../../shared"
import { buildSupportTour } from "../../support"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/support-ticket.ts`). */
export const SAAS_SUPPORT_TICKET_INJECTOR = "saas-support-ticket"

export const SAAS_SUPPORT_CFG: ScenarioCfg = {
  world: "saas",
  copy: "saasSupport",
  injector: SAAS_SUPPORT_TICKET_INJECTOR,
}

export const scenarioSaasSupportTour = buildSupportTour(SAAS_SUPPORT_CFG)

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The software world's money scenario: Maison Arlon's card failed, the
 * reminder to Claire Vidal waits on Home, and Claire adds a new card.
 */
import { buildMoneyTour, type MoneyScenarioCfg } from "../../money"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/payment-recovered.ts`). */
export const SAAS_PAYMENT_RECOVERED_INJECTOR = "saas-payment-recovered"

export const SAAS_MONEY_CFG: MoneyScenarioCfg = {
  world: "saas",
  singleRun: true,
  copy: "saasMoney",
  reminderTo: "claire@maison-arlon.example",
  injector: SAAS_PAYMENT_RECOVERED_INJECTOR,
}

export const scenarioSaasMoneyTour = buildMoneyTour(SAAS_MONEY_CFG)

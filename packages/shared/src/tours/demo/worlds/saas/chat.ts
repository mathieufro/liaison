// SPDX-License-Identifier: FSL-1.1-ALv2
/** The software world's chat scenario: a teammate asks a question that needs fresh information from the web. */
import { buildChatTour } from "../../chat"
import type { ScenarioCfg } from "../../shared"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/chat-question.ts`). */
export const SAAS_CHAT_QUESTION_INJECTOR = "saas-chat-question"

export const SAAS_CHAT_CFG: ScenarioCfg = {
  world: "saas",
  copy: "saasChat",
  injector: SAAS_CHAT_QUESTION_INJECTOR,
}

export const scenarioSaasChatTour = buildChatTour(SAAS_CHAT_CFG)

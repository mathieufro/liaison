// SPDX-License-Identifier: FSL-1.1-ALv2
/** The software world's knowledge scenario: the refund policy, restricted to finance, asked about by support. */
import { buildKnowledgeTour, type KnowledgeScenarioCfg } from "../../knowledge"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/knowledge-asks.ts`). */
export const SAAS_KNOWLEDGE_ASKS_INJECTOR = "saas-knowledge-asks"

/** The seeded document the visitor opens: shared with finance and admins only. */
export const SAAS_KNOWLEDGE_DOC_TITLE = "Refund policy"

export const SAAS_KNOWLEDGE_CFG: KnowledgeScenarioCfg = {
  world: "saas",
  copy: "saasKnowledge",
  injector: SAAS_KNOWLEDGE_ASKS_INJECTOR,
  plTitle: SAAS_KNOWLEDGE_DOC_TITLE,
}

export const scenarioSaasKnowledgeTour = buildKnowledgeTour(SAAS_KNOWLEDGE_CFG)

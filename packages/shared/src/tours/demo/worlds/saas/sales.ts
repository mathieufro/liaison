// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The software world's sales scenario: a hotel group asks for a quote, and one
 * request writes the company, the contact and the quote natively, with the
 * reply, behind one approval. No CRM connector is involved.
 */
import { buildSalesTour, QUOTE_TOOL, type SalesScenarioCfg } from "../../sales"

/** The injector of the scenario's world beat (`modules/demo/worlds/saas/sales-email.ts`). */
export const SAAS_SALES_EMAIL_INJECTOR = "saas-sales-email"

/** The routine the visitor switches on: it prepares the request for a new group. */
export const SAAS_PROSPECT_ROUTINE_NAME = "Prepare quotes for group requests"

/** The company the request creates first: the kernel's own, gated, internal. */
export const SAAS_COMPANY_WRITE_TOOL = "kernel:companies_write"

export const SAAS_SALES_CFG: SalesScenarioCfg = {
  world: "saas",
  copy: "saasSales",
  injector: SAAS_SALES_EMAIL_INJECTOR,
  prospectRoutineName: SAAS_PROSPECT_ROUTINE_NAME,
  bundleHeadTools: [SAAS_COMPANY_WRITE_TOOL, QUOTE_TOOL],
}

export const scenarioSaasSalesTour = buildSalesTour(SAAS_SALES_CFG)

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared words and navigation of the company list and page.
import type { I18nValue } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import type { Company, CompanyDeal } from "./company-store"

type Words = Pick<I18nValue, "t" | "fmtCurrency">

export function openCompanyTab(id: string, name?: string): void {
  openTab({ type: "company-detail", entityId: id, label: name ?? "" })
}

export function openCompanyList(): void {
  openTab({ type: "company-list", entityId: "list", label: "Companies" })
}

export function openPeopleList(): void {
  openTab({ type: "contact-list", entityId: "list", label: "Contacts" })
}

export function peopleCountText(count: number, i18n: Words): string {
  return count === 1
    ? i18n.t("contacts.companies.personOne")
    : i18n.t("contacts.companies.personMany", { count })
}

/** "Deal in Proposal, €17,400", or without an amount when the reader has no deal access. */
export function dealText(deal: CompanyDeal, i18n: Words): string {
  const stage = deal.stage ?? i18n.t("contacts.companies.openDeal")
  if (deal.amountMinor === null || !deal.currency) {
    return i18n.t("contacts.companies.dealIn", { stage })
  }
  return i18n.t("contacts.companies.dealInAmount", {
    stage,
    amount: i18n.fmtCurrency(deal.amountMinor / 100, deal.currency),
  })
}

/** The row's one line: domain, newest open deal, people. */
export function companySummaryLine(company: Company, i18n: Words): string {
  const parts: string[] = []
  if (company.domain) parts.push(company.domain)
  parts.push(
    company.openDeal ? dealText(company.openDeal, i18n) : i18n.t("contacts.companies.noDeal"),
  )
  parts.push(peopleCountText(company.peopleCount ?? 0, i18n))
  return parts.join(" · ")
}

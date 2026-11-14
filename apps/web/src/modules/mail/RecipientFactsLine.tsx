// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What is recorded about each recipient who is a contact: the lawful basis,
// consumer or business, and whether they opted out. One line per recipient,
// calm text. The composer shows it for a person's own mail, and an agent
// mail's approval card shows the same, since approving makes it the
// approver's send.
import type { RecipientFact } from "@liaison/shared"
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

const BASIS_KEYS = {
  consent: "mail.commercialFooter.basisConsent",
  customer: "mail.commercialFooter.basisCustomer",
  professional_interest: "mail.commercialFooter.basisProfessionalInterest",
  generic_address: "mail.commercialFooter.basisGenericAddress",
} as const

export const RecipientFactsLine: Component<{
  facts: readonly RecipientFact[] | null | undefined
  testId: string
}> = (props) => {
  const i18n = useI18n()
  const day = (iso: string) =>
    i18n.fmtDate(new Date(iso), { day: "numeric", month: "short", year: "numeric" })
  const line = (f: RecipientFact): string =>
    [
      f.name?.trim() || f.email,
      f.basis
        ? i18n.t("mail.recipientFacts.basis", { basis: i18n.t(BASIS_KEYS[f.basis]) })
        : i18n.t("mail.recipientFacts.noBasis"),
      f.isConsumer === true
        ? i18n.t("mail.recipientFacts.consumer")
        : f.isConsumer === false
          ? i18n.t("mail.recipientFacts.business")
          : i18n.t("mail.recipientFacts.consumerUnknown"),
      f.optedOutAt
        ? i18n.t("mail.recipientFacts.optedOut", { date: day(f.optedOutAt) })
        : i18n.t("mail.recipientFacts.notOptedOut"),
    ].join(" · ")
  return (
    <Show when={props.facts && props.facts.length > 0}>
      <div data-testid={props.testId} class="text-xs text-text-secondary">
        <For each={props.facts}>
          {(f) => (
            <p data-testid={`${props.testId}-row`} data-email={f.email}>
              {line(f)}
            </p>
          )}
        </For>
      </div>
    </Show>
  )
}

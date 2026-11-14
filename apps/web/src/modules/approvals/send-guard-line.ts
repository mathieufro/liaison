// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSendGuard } from "@liaison/shared"

type T = (key: string, params?: Record<string, string>) => string

/** A hold's day as "17 Nov": day first, no weekday, no year, in the viewer's language. */
export function guardDay(iso: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).formatToParts(
    new Date(iso),
  )
  const day = parts.find((p) => p.type === "day")?.value ?? ""
  const month = parts.find((p) => p.type === "month")?.value ?? ""
  return `${day} ${month}`.trim()
}

/**
 * What the send check says about a mail draft, in one line: the same words on the card and on
 * its Home row. Null when there is nothing to say (a clear check, or none).
 */
export function sendGuardLine(
  g: ApprovalSendGuard | null | undefined,
  t: T,
  locale: string,
): string | null {
  if (!g) return null
  const who = g.who ?? t("kernel.approvalsUi.sendGuard.theOtherSide")
  switch (g.state) {
    case "held":
      return t("kernel.approvalsUi.sendGuard.held", {
        who,
        until: g.holdUntil ? guardDay(g.holdUntil, locale) : "",
      })
    case "replied":
      if (g.record || g.quote) return t("kernel.approvalsUi.sendGuard.replied", { who })
      return g.source === "ticket"
        ? t("kernel.approvalsUi.sendGuard.repliedOnTicket")
        : t("kernel.approvalsUi.sendGuard.repliedElsewhere")
    case "bounced":
      return t("kernel.approvalsUi.sendGuard.bounced")
    case "opted_out":
      return t("kernel.approvalsUi.sendGuard.optedOut", {
        who: (g.optedOut ?? []).join(", ") || who,
      })
    case "ref_stop":
      return g.label
        ? t("kernel.approvalsUi.sendGuard.refStopLabel", { label: g.label })
        : t("kernel.approvalsUi.sendGuard.refStop")
    case "unavailable":
      return t("kernel.approvalsUi.sendGuard.unavailable")
    default:
      return null
  }
}

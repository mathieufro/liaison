// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSendGuard } from "@liaison/shared"

type T = (key: string, params?: Record<string, string>) => string

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
        until: g.holdUntil
          ? new Date(g.holdUntil).toLocaleDateString(locale, { day: "numeric", month: "short" })
          : "",
      })
    case "replied":
      return g.record || g.quote
        ? t("kernel.approvalsUi.sendGuard.replied", { who })
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

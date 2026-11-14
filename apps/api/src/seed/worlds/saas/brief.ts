// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner's Morning brief as the routine last wrote it, computed from the
// world's plan at the anchor: every figure is a sum over the seeded rows, the
// month's start comes from the story clock's formatter, and no sentence names
// a relative day, so the brief stays true whenever the org is handed out.
import { storyClock } from "../story-clock"
import { SAAS_PLANS } from "./fiction"
import { parisCivil, type SaasSubscription, saasMoneyPlan, saasPlan } from "./plan"

const euros = (minor: number) => `€${(minor / 100).toLocaleString("en-US")}`
const monthly = (s: SaasSubscription) => SAAS_PLANS[s.plan].monthlyMinor
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The brief's text at `anchor`, in English. */
export function saasMorningBrief(anchor: Date): string {
  const clock = storyClock(anchor)
  const plan = saasPlan(anchor)
  const money = saasMoneyPlan(anchor)
  const nameOf = (key: string) => plan.companies.find((c) => c.key === key)?.name ?? key

  const counted = money.subscriptions.filter(
    (s) => s.status === "active" || s.status === "past_due",
  )
  const mrr = counted.reduce((n, s) => n + monthly(s), 0)
  const pastDue = counted.filter((s) => s.status === "past_due")
  const pastDueMinor = pastDue.reduce((n, s) => n + monthly(s), 0)

  const month = clock.monthKey()
  const moves = money.movements.filter((m) => parisCivil(m.at).startsWith(month))
  const net = moves.reduce((n, m) => n + m.afterMinor - m.beforeMinor, 0)
  const subOf = (id: string) => money.subscriptions.find((s) => s.subscriptionId === id)
  const ofKind = (kind: string) => moves.filter((m) => m.kind === kind)
  const planName = (id: string) => {
    const sub = subOf(id)
    return sub ? SAAS_PLANS[sub.plan].name : ""
  }
  const newPlans = [...new Set(ofKind("new").map((m) => planName(m.subscriptionId)))]
  const upgradePlans = [...new Set(ofKind("upgrade").map((m) => planName(m.subscriptionId)))]
  const movementLine = [
    `${ofKind("new").length} new${newPlans.length === 1 ? ` on ${newPlans[0]}` : ""}`,
    `${plural(ofKind("upgrade").length, "upgrade", "upgrades")}${upgradePlans.length === 1 ? ` to ${upgradePlans[0]}` : ""}`,
    plural(ofKind("downgrade").length, "downgrade", "downgrades"),
    plural(ofKind("cancelled").length, "cancellation", "cancellations"),
  ].join(", ")

  const monthStart = new Date(`${month}-01T12:00:00Z`)
  const trials = money.subscriptions
    .filter((s) => s.status === "trialing" && s.trialEnd)
    .sort((a, b) => (a.trialEnd as Date).getTime() - (b.trialEnd as Date).getTime())
  const first = trials[0]
  const daysLeft = first
    ? Math.round(
        (Date.parse(parisCivil(first.trialEnd as Date)) - Date.parse(parisCivil(anchor))) /
          86_400_000,
      )
    : 0

  const open = plan.deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost")
  const openMinor = open.reduce((n, d) => n + d.amountMinor, 0)

  return [
    `Monthly recurring revenue is ${euros(mrr)}, ${net >= 0 ? "up" : "down"} ${euros(Math.abs(net))} since ${clock.fmt(monthStart, "en", "dayMonth")}: ${movementLine}.`,
    `${plural(pastDue.length, "subscription is", "subscriptions are")} past due, ${euros(pastDueMinor)} of MRR. Maison Arlon is the largest, and it also has ticket-412 open with Inès and a proposal with Tom.`,
    first
      ? `${plural(trials.length, "trial ends", "trials end")} within the week, ${nameOf(first.companyKey)} first, in ${plural(daysLeft, "day", "days")}.`
      : "",
    `${plural(open.length, "deal is", "deals are")} open, ${euros(openMinor)}. Hôtels Sauvan answered, so the follow-up drafted for Marc will not go out.`,
    "Sources: card payments, Projects, Tickets, Mail.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

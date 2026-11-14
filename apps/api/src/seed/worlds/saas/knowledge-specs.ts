// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's knowledge base: the help centre the support desk answers
// from, and the finance policies. The refund policy is restricted: only those
// who hold the finance grant (and the owner) read it.
import type { DemoKnowledgeSpecs } from "~/seed/tiers/demo/seed-support"

export const SAAS_KNOWLEDGE_SPECS: DemoKnowledgeSpecs = {
  authorKey: "yann",
  collections: [
    {
      key: "help-centre",
      name: "Help centre",
      description: "How the rota product works, written for the managers who plan the shifts.",
      owner: "yann",
    },
    {
      key: "finance-policies",
      name: "Finance policies",
      description: "Billing, refunds and failed card payments: what we do and who decides.",
      owner: "yann",
    },
  ],
  articles: [
    {
      key: "payroll-export",
      title: "Exporting rotas to payroll",
      collection: "help-centre",
      owner: "yann",
      summary: "How a manager exports a month of rotas to the payroll provider, venue by venue.",
      tags: ["exports", "payroll"],
      body:
        "# Exporting rotas to payroll\n\nOpen Rotas, pick the month and the venues, then Export. " +
        "A group with more than four venues exports them in one file per venue group.\n\n" +
        "If an export stops part way, note the venue it stopped at and hand it to the developers " +
        "in the Support handover channel.",
      reviewDueInDays: 60,
      verified: true,
    },
    {
      key: "shift-swaps",
      title: "Shift swaps and approvals",
      collection: "help-centre",
      owner: "yann",
      summary: "How staff swap shifts in the app and how a manager approves them.",
      tags: ["mobile", "swaps"],
      body:
        "# Shift swaps\n\nA staff member offers a shift in the app; a colleague takes it; the " +
        "venue's manager approves. Notifications go out as soon as the swap is approved.",
      reviewDueInDays: -5,
      verified: false,
    },
    {
      key: "plans-and-pricing",
      title: "Plans and pricing",
      collection: "help-centre",
      owner: "yann",
      summary: "Starter, Team and Group, per month excluding VAT, and the yearly plans.",
      tags: ["pricing", "plans"],
      body:
        "# Plans\n\n- Starter: EUR 149 per month\n- Team: EUR 490 per month\n- Group: EUR 1,450 per " +
        "month\n\nPrices exclude VAT. A yearly plan bills twelve months at once.",
      reviewDueInDays: 90,
      verified: true,
    },
    {
      key: "refund-policy",
      title: "Refund policy",
      collection: "finance-policies",
      owner: "yann",
      summary: "When a charge is refunded, who approves it, and what the credit note says.",
      tags: ["refunds", "billing"],
      body:
        "# Refund policy\n\nA charge taken after a cancellation is refunded in full, with a credit " +
        "note for the invoice. Never refund into an open dispute. Sara approves every refund.",
      reviewDueInDays: 120,
      verified: true,
      sensitivity: "restricted",
      orgAccess: "none",
    },
    {
      key: "failed-payments",
      title: "Failed card payments",
      collection: "finance-policies",
      owner: "yann",
      summary: "What we send when a card payment fails, and when.",
      tags: ["payments", "billing"],
      body:
        "# Failed card payments\n\nAn expired card gets a card update link, not a reminder. " +
        "After seven days past due, the account manager calls.",
      reviewDueInDays: 45,
      verified: true,
    },
  ],
}

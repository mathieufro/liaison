// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's support desk: its inboxes, the ticket queue the owner
// opens on (six open tickets), the shared mailbox's conversations with
// the prospects who wrote in, and the team calendar. Companies and deals are
// the pack's layer's (`plan.ts`, `layer.ts`), so the support layer seeds none.
//
// Every age is an offset in hours from the anchor; no string names a date.

import type { MailConversationSpec } from "~/seed/factories/mail/conversations"
import type { TicketSpec } from "~/seed/factories/support/tickets"
import type { DemoSupportSpecs } from "~/seed/tiers/demo/seed-support"
import { STORY_TIME_ZONE, storyClock } from "~/seed/worlds/story-clock"
import { SAAS_CUSTOMER_COMPANIES, SAAS_EMAIL_DOMAIN } from "./fiction"
import { SAAS_PIPELINE_KEY } from "./plan"

export const SAAS_TICKET_CATEGORIES = [
  "Exports and payroll",
  "Billing",
  "Onboarding",
  "Mobile app",
  "Account",
] as const

/** The tickets the boards name, by spec key. */
export const SAAS_TICKET_KEYS = {
  arlonExport: "tick-412",
  arlonOlder: "tick-377",
  ombreCharge: "tick-398",
} as const

export const SAAS_TICKETS: readonly TicketSpec[] = [
  {
    key: SAAS_TICKET_KEYS.arlonExport,
    number: 412,
    subject: "Export of last month's rotas",
    contactKey: "customer:claire-vidal",
    category: "Exports and payroll",
    team: "support",
    audience: "b2b",
    priority: "high",
    status: "open",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 30,
    body:
      "Hello, the payroll export for last month's rotas stops at the fourth hotel. Our payroll " +
      "provider needs the file before the end of the week. Can you look at it? Claire",
  },
  {
    key: SAAS_TICKET_KEYS.arlonOlder,
    number: 377,
    subject: "Shift swap notifications arrive late",
    contactKey: "customer:claire-vidal",
    category: "Mobile app",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 900,
    body: "Staff at two of our hotels get the swap notification an hour after it was approved.",
    followups: [
      {
        kind: "outbound",
        author: "ines",
        hoursAfter: 20,
        body: "Fixed in the last app release: notifications now go out as soon as a swap is approved.",
      },
    ],
  },
  {
    key: SAAS_TICKET_KEYS.ombreCharge,
    number: 398,
    subject: "Charged after cancelling",
    contactKey: "customer:emma-ombre",
    category: "Billing",
    team: "support",
    audience: "b2b",
    priority: "high",
    status: "open",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 20,
    body:
      "We cancelled our Starter plan and were charged again two days later, EUR 178.80. " +
      "Please refund it. Emma, Café Ombre",
  },
  {
    key: "vauban-onboarding",
    number: 415,
    subject: "Adding our second restaurant",
    contactKey: "customer:paul-vauban",
    category: "Onboarding",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "clemence",
    channel: "email",
    createdHoursAgo: 6,
    body:
      "We just signed for Team. How do we add our second restaurant and copy the rota template " +
      "from the first one? Paul",
  },
  {
    key: "vauban-mobile-login",
    number: 416,
    subject: "Staff cannot sign in to the app",
    contactKey: "customer:paul-vauban",
    category: "Mobile app",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "nolan",
    channel: "web_form",
    createdHoursAgo: 4,
    body: "Three of our waiters get 'invitation expired' when they open the link we sent them.",
  },
  {
    key: "verrieres-sso",
    number: 409,
    subject: "Single sign-on for the group",
    contactKey: "customer:louise-verrieres",
    category: "Account",
    team: "support",
    audience: "b2b",
    priority: "low",
    status: "open",
    assignee: "nolan",
    channel: "email",
    createdHoursAgo: 52,
    body: "Can our managers sign in with the group's own accounts instead of a password?",
  },
  {
    key: "saint-cyr-invoice-copy",
    number: 405,
    subject: "Copy of an invoice",
    contactKey: "customer:theo-saint-cyr",
    category: "Billing",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    channel: "email",
    createdHoursAgo: 75,
    body: "Our accountant asks for a copy of the invoice for the Team plan. Théo",
  },
  {
    key: "selene-trial-question",
    number: 386,
    subject: "How long is the trial?",
    contactKey: "customer:anais-selene",
    category: "Onboarding",
    team: "support",
    audience: "b2b",
    priority: "low",
    status: "closed",
    closedReason: "resolved",
    assignee: "clemence",
    channel: "web_form",
    createdHoursAgo: 200,
    body: "Before we sign up: how long is the trial, and can we try the Team plan?",
  },
]

const SALES_BOX = `sales@${SAAS_EMAIL_DOMAIN}`

/**
 * The prospects' last words, in the shared mailbox: Marc's question two hours
 * before the anchor (the guard closes the follow-up queued before it) and
 * Anaïs's reply the day before. Samir's thread, whose auto-reply names a date,
 * is `saasKoraConversation`.
 */
export const SAAS_MAIL: readonly MailConversationSpec[] = [
  {
    key: "sauvan-pricing",
    box: "org",
    subject: "Group pricing",
    status: "open",
    labels: ["sales"],
    isRead: false,
    isStarred: true,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Marc Sauvan",
        toEmail: "marc@hotels-sauvan.example",
        hoursAgo: 260,
        body: "Thank you for the demo. Here is the summary of what we showed your managers.",
      },
      {
        direction: "inbound",
        fromName: "Marc Sauvan",
        fromEmail: "marc@hotels-sauvan.example",
        toName: "Tideform",
        toEmail: SALES_BOX,
        hoursAgo: 2,
        body: "Can you send the group pricing for 11 sites?",
      },
    ],
  },
  {
    key: "selene-pilot",
    box: "org",
    subject: "Team pilot",
    status: "open",
    labels: ["sales"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Anaïs Morel",
        toEmail: "anais@comptoir-selene.example",
        hoursAgo: 70,
        body: "Here is what a Team pilot for your two counters would look like, for eight months.",
      },
      {
        direction: "inbound",
        fromName: "Anaïs Morel",
        fromEmail: "anais@comptoir-selene.example",
        toName: "Tideform",
        toEmail: SALES_BOX,
        hoursAgo: 22,
        body: "That works for us. Can we start with the counter on the quay?",
      },
    ],
  },
]

/** A Paris calendar day as an out-of-office writes it: "12 November". */
function dayMonth(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: STORY_TIME_ZONE,
  }).format(at)
}

/**
 * Samir's thread: the intro, then his out-of-office, which names the last day
 * he is away. The pack's layer writes it, since its date comes from the anchor;
 * the send check holds his follow-up until the morning after that day.
 */
export function saasKoraConversation(anchor: Date): MailConversationSpec {
  const clock = storyClock(anchor)
  return {
    key: "kora-intro",
    box: "org",
    subject: "Rota planning for Kora",
    status: "open",
    labels: ["sales"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Samir Aït",
        toEmail: "samir@kora-hospitality.example",
        hoursAgo: 240,
        body: "Following our call, here is how teams plan a week of shifts in Tideform.",
      },
      {
        direction: "inbound",
        fromName: "Samir Aït",
        fromEmail: "samir@kora-hospitality.example",
        toName: "Tideform",
        toEmail: SALES_BOX,
        hoursAgo: 30,
        body:
          `Thank you for your message. I am out of the office until ${dayMonth(clock.d(3))}, ` +
          "with no access to my mail. I will answer when I am back.",
        headers: { "auto-submitted": "auto-replied" },
      },
    ],
  }
}

/** A follow-up the deal follow-ups routine drafted, and what its send check reads now. */
export interface SaasFollowupSpec {
  key: string
  /** The deal it follows up on (`plan.ts` key). */
  dealKey: string
  /** The person it goes to (`customer:<key>`). */
  contactKey: string
  subject: string
  body: string
  /** When the routine staged it. */
  hoursAgo: number
  /** Whose opt-out arrives after it was staged, which withdraws it. */
  optOutAfter?: true
}

/**
 * The four follow-ups of the morning run: Lumen's waits on the owner; Sauvan's
 * was staged before Marc answered, so the check stops it; Hugo opted out after
 * Tilleul's was staged, which withdrew it; Samir's out-of-office holds Kora's.
 */
export const SAAS_FOLLOWUPS: readonly SaasFollowupSpec[] = [
  {
    key: "lumen-followup",
    dealKey: "lumen-team",
    contactKey: "customer:noor-haddad",
    subject: "Your Team annual proposal",
    body:
      "Hello Noor,\n\nI am following up on the Team annual proposal for Brasserie Lumen. " +
      "Is there anything you would like changed before you decide?\n\nBest regards",
    hoursAgo: 1,
  },
  {
    key: "sauvan-followup",
    dealKey: "sauvan-group",
    contactKey: "customer:marc-sauvan",
    subject: "Following up on the demo",
    body:
      "Hello Marc,\n\nI am following up on the demo we gave your managers. " +
      "Would a call about the Group plan be useful?\n\nBest regards",
    hoursAgo: 26,
  },
  {
    key: "tilleul-followup",
    dealKey: "tilleul-team",
    contactKey: "customer:hugo-perrin",
    subject: "After your trial",
    body: "Hello Hugo,\n\nYour trial has ended. Would you like to continue on the Team plan?\n\nBest regards",
    hoursAgo: 25,
    optOutAfter: true,
  },
  {
    key: "kora-followup",
    dealKey: "kora-team",
    contactKey: "customer:samir-ait",
    subject: "Rota planning for Kora",
    body:
      "Hello Samir,\n\nI am following up on how teams plan a week of shifts in Tideform. " +
      "Would a short demo for your managers help?\n\nBest regards",
    hoursAgo: 1,
  },
]

export const SAAS_SUPPORT_SPECS: DemoSupportSpecs = {
  customerCompanies: SAAS_CUSTOMER_COMPANIES,
  contactDuplicates: [],
  inboxes: { support: "Support", sales: "Sales", bugs: "Rota bugs" },
  ticketCategories: SAAS_TICKET_CATEGORIES,
  tickets: SAAS_TICKETS,
  ticketMerges: [],
  projects: [
    {
      key: "ROTA",
      name: "Product",
      description: "The rota product's roadmap: what is being built and what is next.",
      icon: "calendar",
      owner: "lucie",
      tasks: [
        {
          key: "payroll-export-fix",
          title: "Payroll export stops after four venues",
          status: "in_progress",
          assignee: "baptiste",
          priority: "high",
          dueInDays: 2,
        },
        {
          key: "group-sso",
          title: "Single sign-on for groups",
          status: "todo",
          assignee: "jonas",
          dueInDays: 20,
        },
        {
          key: "swap-reminders",
          title: "Remind managers of swaps waiting for approval",
          status: "backlog",
          assignee: "amel",
        },
        {
          key: "pricing-page-groups",
          title: "Review the group pricing page",
          status: "todo",
          assignee: "lucie",
          dueInDays: 5,
        },
      ],
    },
  ],
  calendarName: "Tideform team",
  events: [
    {
      key: "weekly-product",
      title: "Product review",
      day: 1,
      startHour: 10,
      durationMinutes: 45,
      attendees: ["lucie", "yann", "ines", "baptiste", "amel", "jonas"],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    },
    {
      key: "pipeline-review",
      title: "Pipeline review",
      day: 0,
      startHour: 9,
      startMinute: 30,
      durationMinutes: 30,
      attendees: ["tom", "elodie", "maxime"],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    },
  ],
  mail: SAAS_MAIL,
  mailTourConversation: null,
  companies: [],
  // The pipeline itself is the pack's layer's (`layer.ts`), with every deal.
  pipeline: {
    key: SAAS_PIPELINE_KEY,
    name: "Sales",
    description: "New plans and group expansions, from first call to signed plan.",
    deals: [],
  },
  approvals: [],
  productScenarios: false,
}

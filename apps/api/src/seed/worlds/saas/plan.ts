// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's plan: every company and every deal the pack writes, with
// its values and its dates, as a pure function of the anchor. No database, no
// wall clock: the layer writes exactly this, and a test holds the plan to the
// world's invariants at any anchor without seeding anything.
//
// Every date is a role on the story clock (`../story-clock.ts`): "won five
// days ago" is `d(-5)`, never a literal, and "this month" stays inside this
// month however early in the month the anchor falls.
import { type StoryClock, storyClock } from "~/seed/worlds/story-clock"
import {
  SAAS_ACCOUNT_MANAGERS,
  SAAS_CUSTOMER_COMPANIES,
  SAAS_CUSTOMERS,
  SAAS_PLANS,
  type SaasPlan,
} from "./fiction"

/** Why a company is in the workspace: what INV-T-11's breakdown counts it as. */
export type SaasCompanyKind =
  | "paying"
  | "trial"
  | "cancelled-this-month"
  | "cancelled-last-month"
  | "transfer"
  | "prospect"
  | "past"

export interface SaasCompanyRow {
  key: string
  name: string
  domain: string
  kind: SaasCompanyKind
  plan?: SaasPlan
  /** Person key of the account manager, when a board names one. */
  manager?: string
  /** Customer keys (`fiction.ts`) of the people who work there. */
  contactKeys: string[]
}

export type SaasDealStage = "Lead" | "Qualified" | "Demo" | "Proposal" | "Won" | "Lost"

export interface SaasDealRow {
  /** The deal's number in the pipeline (`SALES-<n>`). */
  number: number
  key: string
  title: string
  stage: SaasDealStage
  companyKey: string
  contactKey?: string
  /** A person key, or `owner` for the workspace's owner (the visitor). */
  owner: string
  amountMinor: number
  /** When the deal was opened. With no reply on record, the deal's quiet days run from here. */
  createdAt: Date
  /** When a won or lost deal closed. */
  closedAt?: Date
  nextStep?: string
  lostReason?: string
}

/** A task under a deal: what the owner has to do before the deal moves. */
export interface SaasDealSubtask {
  number: number
  key: string
  parentNumber: number
  title: string
  owner: string
  dueAt: Date
}

/** What the owner's Home leads with, in order: approvals and attention rows. */
export interface SaasNeedsYouRow {
  key: string
  kind: "approval" | "attention"
  what: string
}

export interface SaasPlanResult {
  anchor: Date
  companies: SaasCompanyRow[]
  deals: SaasDealRow[]
  subtasks: SaasDealSubtask[]
  needsYou: SaasNeedsYouRow[]
  /** The owner's sidebar queues: open items waiting in each. */
  queues: { support: number; deals: number; tasks: number; knowledge: number }
  /** The people the door names beside the visitor, and the visitor's own seat. */
  team: { named: number; ownerSeat: 1 }
}

/** The pipeline's key: deals read `SALES-<n>`. */
export const SAAS_PIPELINE_KEY = "SALES"

const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const domainOf = (name: string) => `${slug(name)}.example`

const contactsOf = (name: string): string[] =>
  Object.entries(SAAS_CUSTOMER_COMPANIES)
    .filter(([, company]) => company === name)
    .map(([key]) => `customer:${key}`)

const managerOf = (name: string): string | undefined =>
  Object.entries(SAAS_ACCOUNT_MANAGERS).find(([, names]) => names.includes(name))?.[0]

function row(
  name: string,
  kind: SaasCompanyKind,
  plan?: SaasPlan,
  domain?: string,
): SaasCompanyRow {
  const manager = managerOf(name)
  return {
    key: slug(name),
    name,
    domain: domain ?? domainOf(name),
    kind,
    ...(plan ? { plan } : {}),
    ...(manager ? { manager } : {}),
    contactKeys: contactsOf(name),
  }
}

/** The paying customers the boards name, with their plan. */
const NAMED_PAYING: ReadonlyArray<[string, SaasPlan]> = [
  ["Maison Arlon", "group"],
  ["Les Tables Vauban", "team"],
  ["Hôtel Quai Neuf", "team"],
  ["Bistrot Garance", "team"],
  ["Tables d'Orsan", "team"],
  ["Café Sillon", "starter"],
  ["Halle Perrine", "starter"],
  ["Ker Avel", "starter"],
  ["Relais Saint-Cyr", "team"],
  ["Résidence Calanque", "team"],
  ["Domaine Astier", "group"],
]

const TRIALS: ReadonlyArray<[string, SaasPlan]> = [
  ["Auberge Tilleul", "team"],
  ["Hôtel Bellerive", "team"],
  ["Groupe Lanterne", "group"],
  ["Bistrot Ardoise", "starter"],
]

const TRANSFER: ReadonlyArray<[string, SaasPlan]> = [
  ["Hôtels Belcour", "team"],
  ["Résidence Alizé", "team"],
  ["Le Comptoir Sud", "team"],
  ["Stadshotel Noord BV", "team"],
  ["Cantines du Port", "group"],
  ["Bistrot Marceau", "starter"],
  ["Hôtel Mirabel", "starter"],
  ["Domaine Ferrand", "team"],
  ["Camping Les Pins", "starter"],
  ["Groupe Verrières", "group"],
]

const PROSPECTS = [
  "Hôtels Sauvan",
  "Comptoir Sélène",
  "Hôtel Ondine",
  "Kora Hospitality",
  "KORA hospitality SAS",
  "Bistrot Carmin",
  "Pont Neuf Bistrots",
  "Brasserie Lumen",
  "Hôtel des Trois Ormes",
] as const

/** Kora's two records share the one domain: the duplicate a person merges. */
const KORA_DOMAIN = "kora-hospitality.example"

/** INV-T-11's counts: 169 paying, 4 trials, 4 cancelled this month, Café Ombre, 10 transfer, 9 prospects, 17 past. */
export const SAAS_COMPANY_COUNTS = {
  paying: 169,
  trial: 4,
  "cancelled-this-month": 4,
  "cancelled-last-month": 1,
  transfer: 10,
  prospect: 9,
  past: 17,
} as const satisfies Record<SaasCompanyKind, number>

/** The paying long tail's plan mix: 62 Starter, 83 Team, 24 Group in all (INV-T-1). */
const PLAN_MIX: Record<SaasPlan, number> = { starter: 62, team: 83, group: 24 }

const VENUE_KINDS = [
  "Hôtel",
  "Bistrot",
  "Brasserie",
  "Café",
  "Auberge",
  "Maison",
  "Résidence",
  "Cantine",
  "Relais",
  "Comptoir",
  "Table",
  "Halle",
]
const VENUE_NAMES = [
  "des Saules",
  "Belvédère",
  "du Phare",
  "des Glycines",
  "Corail",
  "des Tilleuls Bleus",
  "Marée Haute",
  "du Moulin Vert",
  "des Embruns",
  "Azurine",
  "du Vieux Quai",
  "des Lavandes",
  "Ardente",
  "du Grand Mail",
  "des Cèdres",
  "Opaline",
  "du Pont Levant",
  "des Mouettes",
  "Céladon",
  "du Clos Fleuri",
]

/** The n-th long tail name, never one a board names. */
function longTailNames(count: number, taken: ReadonlySet<string>, offset: number): string[] {
  const out: string[] = []
  let i = offset
  while (out.length < count) {
    const kind = VENUE_KINDS[i % VENUE_KINDS.length] as string
    const name = VENUE_NAMES[Math.floor(i / VENUE_KINDS.length) % VENUE_NAMES.length] as string
    const round = Math.floor(i / (VENUE_KINDS.length * VENUE_NAMES.length))
    const candidate = `${kind} ${name}${round > 0 ? ` ${round + 1}` : ""}`
    if (!taken.has(candidate)) out.push(candidate)
    i++
  }
  return out
}

function companies(): SaasCompanyRow[] {
  const out: SaasCompanyRow[] = []
  for (const [name, plan] of NAMED_PAYING) out.push(row(name, "paying", plan))
  const left = { ...PLAN_MIX }
  for (const [, plan] of NAMED_PAYING) left[plan]--
  const named = new Set([
    ...NAMED_PAYING.map(([n]) => n),
    ...TRIALS.map(([n]) => n),
    ...TRANSFER.map(([n]) => n),
    ...PROSPECTS,
    "Café Ombre",
  ])
  const tail = longTailNames(SAAS_COMPANY_COUNTS.paying - NAMED_PAYING.length + 4 + 17, named, 0)
  let t = 0
  for (const plan of ["starter", "team", "group"] as const) {
    for (let k = 0; k < left[plan]; k++) out.push(row(tail[t++] as string, "paying", plan))
  }
  for (const [name, plan] of TRIALS) out.push(row(name, "trial", plan))
  for (const plan of ["starter", "starter", "team", "team"] as const) {
    out.push(row(tail[t++] as string, "cancelled-this-month", plan))
  }
  out.push(row("Café Ombre", "cancelled-last-month", "starter"))
  for (const [name, plan] of TRANSFER) out.push(row(name, "transfer", plan))
  for (const name of PROSPECTS) {
    out.push(
      row(
        name,
        "prospect",
        undefined,
        name.toLowerCase().startsWith("kora") ? KORA_DOMAIN : undefined,
      ),
    )
  }
  for (let k = 0; k < SAAS_COMPANY_COUNTS.past; k++) out.push(row(tail[t++] as string, "past"))
  return out
}

/** An instant this month, `daysAgo` before the anchor, kept inside this month. */
function thisMonthDaysAgo(clock: StoryClock, daysAgo: number, i: number, of: number): Date {
  const at = clock.d(-daysAgo)
  return monthKeyOf(at) === clock.monthKey() ? at : clock.thisMonthEvent(i, of)
}

function monthKeyOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date)
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`
}

const EUR = (euros: number) => euros * 100

function deals(clock: StoryClock, rows: readonly SaasCompanyRow[]): SaasDealRow[] {
  const keyOf = (name: string) => {
    const found = rows.find((r) => r.name === name)
    if (!found) throw new Error(`saas plan: no company '${name}'`)
    return found.key
  }
  const named: SaasDealRow[] = [
    {
      number: 3,
      key: "arlon-group",
      title: "Maison Arlon, Group plan",
      stage: "Won",
      companyKey: keyOf("Maison Arlon"),
      contactKey: "customer:claire-vidal",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-640),
      closedAt: clock.d(-610),
    },
    {
      number: 9,
      key: "trois-ormes",
      title: "Hôtel des Trois Ormes, Group plan",
      stage: "Lost",
      companyKey: keyOf("Hôtel des Trois Ormes"),
      contactKey: "customer:denis-ormes",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-60),
      closedAt: thisMonthDaysAgo(clock, 7, 0, 2),
      lostReason: "Waiting until next year",
    },
    {
      number: 11,
      key: "vauban-team",
      title: "Les Tables Vauban, Team annual",
      stage: "Won",
      companyKey: keyOf("Les Tables Vauban"),
      contactKey: "customer:paul-vauban",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-35),
      closedAt: thisMonthDaysAgo(clock, 5, 1, 2),
    },
    {
      number: 12,
      key: "lumen-team",
      title: "Lumen, Team annual",
      stage: "Proposal",
      companyKey: keyOf("Brasserie Lumen"),
      contactKey: "customer:noor-haddad",
      owner: "owner",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-9),
      nextStep: "Follow up on the proposal",
    },
    {
      number: 14,
      key: "arlon-expansion",
      title: "Maison Arlon, 4 more hotels",
      stage: "Proposal",
      companyKey: keyOf("Maison Arlon"),
      contactKey: "customer:claire-vidal",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-3),
      nextStep: "Tom to confirm the rollout date",
    },
    {
      number: 15,
      key: "pont-neuf",
      title: "Pont Neuf Bistrots, Team annual",
      stage: "Demo",
      companyKey: keyOf("Pont Neuf Bistrots"),
      contactKey: "customer:julie-marchetti",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-6),
    },
    {
      number: 17,
      key: "sauvan-group",
      title: "Hôtels Sauvan, Group plan",
      stage: "Demo",
      companyKey: keyOf("Hôtels Sauvan"),
      contactKey: "customer:marc-sauvan",
      owner: "owner",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-12),
      nextStep: "Send the group pricing for 11 sites",
    },
    {
      number: 18,
      key: "tilleul-team",
      title: "Auberge Tilleul, Team after the trial",
      stage: "Qualified",
      companyKey: keyOf("Auberge Tilleul"),
      contactKey: "customer:hugo-perrin",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-11),
    },
    {
      number: 21,
      key: "kora-team",
      title: "Kora Hospitality, Team annual",
      stage: "Lead",
      companyKey: keyOf("Kora Hospitality"),
      contactKey: "customer:samir-ait",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-10),
    },
    {
      number: 24,
      key: "selene-pilot",
      title: "Team pilot",
      stage: "Qualified",
      companyKey: keyOf("Comptoir Sélène"),
      contactKey: "customer:anais-selene",
      owner: "owner",
      amountMinor: EUR(3_920),
      createdAt: clock.d(-8),
    },
    {
      number: 26,
      key: "carmin",
      title: "Bistrot Carmin, Starter for two sites",
      stage: "Lead",
      companyKey: keyOf("Bistrot Carmin"),
      contactKey: "customer:lina-carmin",
      owner: "tom",
      amountMinor: EUR(3_000),
      createdAt: clock.d(-5),
    },
    {
      number: 28,
      key: "ondine",
      title: "Hôtel Ondine, Team for one hotel",
      stage: "Lead",
      companyKey: keyOf("Hôtel Ondine"),
      contactKey: "customer:victor-ondine",
      owner: "tom",
      amountMinor: EUR(3_420),
      createdAt: clock.d(-1),
    },
  ]
  // The numbers between are older deals, closed before this month: customers
  // won and prospects lost, so every number up to the last exists.
  const used = new Set(named.map((d) => d.number))
  const paying = rows.filter((r) => r.kind === "paying" && !r.manager && r.contactKeys.length === 0)
  const past = rows.filter((r) => r.kind === "past")
  const history: SaasDealRow[] = []
  let w = 0
  let l = 0
  for (let n = 1; n <= 29; n++) {
    if (used.has(n)) continue
    const won = n % 3 !== 0
    const company = won ? paying[w++] : past[l++]
    if (!company) throw new Error("saas plan: not enough companies for the deal history")
    const amountMinor = EUR(
      company.plan === "group" ? 17_400 : company.plan === "starter" ? 1_788 : 5_880,
    )
    history.push({
      number: n,
      key: `history-${n}`,
      title: `${company.name}, ${won ? "first plan" : "trial that did not convert"}`,
      stage: won ? "Won" : "Lost",
      companyKey: company.key,
      owner: n % 2 === 0 ? "tom" : "maxime",
      amountMinor: won ? amountMinor : EUR(5_880),
      // Older than any month the anchor can be in: 40 days and more back.
      createdAt: clock.d(-(420 - n * 12)),
      closedAt: clock.d(-(400 - n * 12)),
      ...(won ? {} : { lostReason: "Chose to stay on spreadsheets" }),
    })
  }
  return [...named, ...history].sort((a, b) => a.number - b.number)
}

/**
 * The Arlon expansion's two subtasks, the owner's: they are the Tasks group of
 * the owner's Home (the projects app raises a task due within the week, or past
 * due, for its assignee only).
 */
function subtasks(clock: StoryClock): SaasDealSubtask[] {
  return [
    {
      number: 30,
      key: "arlon-rollout-plan",
      parentNumber: 14,
      title: "Draft the rollout plan for the 4 hotels",
      owner: "owner",
      dueAt: clock.d(4),
    },
    {
      number: 31,
      key: "arlon-pricing-sheet",
      parentNumber: 14,
      title: "Send the pricing sheet for the 4 hotels",
      owner: "owner",
      dueAt: clock.d(4),
    },
  ]
}

/** The `saas` world at `anchor`. Pure: two calls with one anchor are equal. */
export function saasPlan(anchor: Date): SaasPlanResult {
  const clock = storyClock(anchor)
  const rows = companies()
  return {
    anchor,
    companies: rows,
    deals: deals(clock, rows),
    subtasks: subtasks(clock),
    needsYou: [
      { key: "arlon-past-due", kind: "approval", what: "Card update reminder to Maison Arlon" },
      { key: "lumen-followup", kind: "approval", what: "Follow-up to Brasserie Lumen" },
      { key: "ombre-refund", kind: "approval", what: "Refund for Café Ombre" },
      { key: "pont-neuf-quiet", kind: "attention", what: "Pont Neuf Bistrots has gone quiet" },
    ],
    queues: { support: 6, deals: 3, tasks: 2, knowledge: 1 },
    team: { named: 13, ownerSeat: 1 },
  }
}

// ── Money ────────────────────────────────────────────────────────────────────
//
// The card customers' mirror (customers, subscriptions, their latest invoice
// and charge, the dispute, this month's movements), the issued invoices of the
// year with their numbers, and the schedules billed by transfer. Every amount
// comes from the plan prices (`SAAS_PLANS`), every instant from the story
// clock, whole seconds only: the card processor's objects carry seconds, so a
// mirror row read back and written again stays equal.

export type SaasBilling = "month" | "year"
export type SaasSubscriptionStatus = "active" | "past_due" | "trialing" | "canceled"
export type SaasMovementKind = "new" | "upgrade" | "downgrade" | "cancelled"

export interface SaasCard {
  brand: "visa" | "mastercard"
  last4: "4242" | "5108"
  /** `MM/YY`. */
  exp: string
}

export interface SaasSubscription {
  companyKey: string
  customerId: string
  subscriptionId: string
  /** The customer's billing address. */
  email: string
  customerSince: Date
  plan: SaasPlan
  billing: SaasBilling
  status: SaasSubscriptionStatus
  periodStart: Date
  periodEnd: Date
  trialEnd: Date | null
  canceledAt: Date | null
  pastDueSince: Date | null
  card: SaasCard
}

export interface SaasMovement {
  eventId: string
  subscriptionId: string
  customerId: string
  at: Date
  kind: SaasMovementKind
  beforeMinor: number
  afterMinor: number
}

/** One card charge with the processor's invoice it paid (or failed to pay). */
export interface SaasCardCharge {
  key: string
  invoiceId: string
  chargeId: string
  subscriptionId: string
  customerId: string
  /** Excluding VAT. */
  netMinor: number
  taxMinor: number
  invoiceStatus: "paid" | "open"
  chargeStatus: "succeeded" | "failed"
  failureCode: string | null
  periodStart: Date
  periodEnd: Date
  at: Date
  card: SaasCard
  disputed: boolean
  /** The issued invoice (`SaasInvoice.key`) that invoices this charge, when one does. */
  invoiceKey: string | null
}

export interface SaasDispute {
  disputeId: string
  chargeId: string
  amountMinor: number
  reason: string
  status: string
  at: Date
  evidenceDueBy: Date
}

/** An issued invoice of the year, numbered in date order. */
export interface SaasInvoice {
  key: string
  companyKey: string
  description: string
  unitMinor: number
  quantity: number
  issuedAt: Date
  paidAt: Date | null
  /** `F-<year>-<0001>`: per year, in date order, no gap. */
  number: string
  numberInt: number
  year: number
}

export interface SaasSchedule {
  key: string
  companyKey: string
  repeats: "month" | "quarter" | "year"
  billingDay: string
  status: "active" | "paused"
  description: string
  quantity: number
  unitMinor: number
  vatBp: number
  /** Paris civil dates, as the invoicing app computes them. */
  nextIssueOn: string | null
  nextDraftOn: string | null
  pausedUntil: string | null
  lastInvoiceKey: string | null
}

export interface SaasMoneyPlan {
  subscriptions: SaasSubscription[]
  movements: SaasMovement[]
  charges: SaasCardCharge[]
  dispute: SaasDispute
  invoices: SaasInvoice[]
  schedules: SaasSchedule[]
  /** When the last webhook event arrived: two minutes before the anchor. */
  lastEventAt: Date
  /** When the nightly reconcile last read the account. */
  syncedAt: Date
  connectedAt: Date
}

/** VAT on the plans, in basis points: French VAT at 20%. */
export const SAAS_VAT_BP = 2000

/** The companies billed by transfer (no card subscription), with their Liaison schedules. */
export const SAAS_TRANSFER_KEYS = TRANSFER.map(([name]) => slug(name))

const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000)
const DAY_MS = 86_400_000
const alnum = (key: string) => key.replace(/[^a-z0-9]/gi, "")
const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** Paris civil date `YYYY-MM-DD` of an instant. */
export function parisCivil(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(at)
}

function civilAdd(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  const at = new Date(Date.UTC(y, m - 1, d + n))
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

function lastDayOf(year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`
}

/** The invoicing app's draft day: three days before the issue day, back over a weekend. */
export function draftDayOf(issueOn: string): string {
  const draft = civilAdd(issueOn, -3)
  const [y, m, d] = draft.split("-").map(Number) as [number, number, number]
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return dow === 6 ? civilAdd(draft, -1) : dow === 0 ? civilAdd(draft, -2) : draft
}

/** The next month's or quarter's last day on or after `today`. */
function nextLastDay(today: string, repeats: "month" | "quarter"): string {
  const [y, m] = today.split("-").map(Number) as [number, number]
  const month = repeats === "month" ? m : Math.ceil(m / 3) * 3
  return lastDayOf(y, month)
}

const CARDS: SaasCard[] = [
  { brand: "visa", last4: "4242", exp: "" },
  { brand: "mastercard", last4: "5108", exp: "" },
]
function cardOf(i: number): SaasCard {
  const base = CARDS[i % 2] as SaasCard
  return { ...base, exp: `${pad(1 + (i % 12))}/${28 + (i % 3)}` }
}

const PAST_DUE: ReadonlyArray<[string, number]> = [
  ["Maison Arlon", 6],
  ["Hôtel Quai Neuf", 5],
  ["Bistrot Garance", 4],
  ["Tables d'Orsan", 2],
  ["Café Sillon", 3],
  ["Halle Perrine", 2],
  ["Ker Avel", 1],
]

/** The ids of Maison Arlon's subscription and invoices, as the boards name them. */
export const SAAS_ARLON_SUBSCRIPTION = "sub_1Q8XarlonGroup"

function money(
  clock: StoryClock,
  rows: readonly SaasCompanyRow[],
  dealsOf: SaasDealRow[],
): SaasMoneyPlan {
  const at = (n: number, hhmm?: string) => sec(clock.d(n, hhmm))
  const byName = (name: string) => {
    const r = rows.find((c) => c.name === name)
    if (!r) throw new Error(`saas plan: no company '${name}'`)
    return r
  }
  const emailOf = (r: SaasCompanyRow) => {
    const contact = r.contactKeys[0]?.replace(/^customer:/, "")
    const named = contact ? SAAS_CUSTOMER_EMAILS[contact] : undefined
    return named ?? `billing@${r.domain}`
  }
  const subs: SaasSubscription[] = []
  const movements: SaasMovement[] = []
  const charges: SaasCardCharge[] = []
  const priceOf = (plan: SaasPlan) => SAAS_PLAN_PRICES[plan]

  const paying = rows.filter((r) => r.kind === "paying")
  const named = new Set(NAMED_PAYING.map(([n]) => n))
  const tail = (plan: SaasPlan) => paying.filter((r) => !named.has(r.name) && r.plan === plan)
  const [tailStarter, tailTeam, tailGroup] = [tail("starter"), tail("team"), tail("group")]
  const monthly = new Set<string>([
    ...PAST_DUE.map(([n]) => byName(n).key),
    byName("Relais Saint-Cyr").key,
    ...tailStarter.slice(0, 8).map((r) => r.key),
    ...tailTeam.slice(0, 10).map((r) => r.key),
    ...tailGroup.slice(0, 4).map((r) => r.key),
  ])
  const newTeams = [byName("Les Tables Vauban"), ...tailTeam.slice(-5)]
  const upgraded = tailGroup[tailGroup.length - 1] as SaasCompanyRow
  const downgraded = tailStarter[tailStarter.length - 1] as SaasCompanyRow
  const cancelled = rows.filter((r) => r.kind === "cancelled-this-month")

  // This month's twelve movements, at the story clock's instants inside this month.
  const vaubanWon = dealsOf.find((d) => d.key === "vauban-team")?.closedAt
  if (!vaubanWon) throw new Error("saas plan: the won deal of this month has no close date")
  const moves: Array<{ row: SaasCompanyRow; kind: SaasMovementKind; at: Date }> = []
  const order: Array<[SaasCompanyRow, SaasMovementKind]> = [
    [newTeams[1] as SaasCompanyRow, "new"],
    [cancelled[0] as SaasCompanyRow, "cancelled"],
    [newTeams[2] as SaasCompanyRow, "new"],
    [upgraded, "upgrade"],
    [cancelled[2] as SaasCompanyRow, "cancelled"],
    [newTeams[3] as SaasCompanyRow, "new"],
    [downgraded, "downgrade"],
    [cancelled[1] as SaasCompanyRow, "cancelled"],
    [newTeams[4] as SaasCompanyRow, "new"],
    [cancelled[3] as SaasCompanyRow, "cancelled"],
    [newTeams[5] as SaasCompanyRow, "new"],
  ]
  for (const [k, [row, kind]] of order.entries()) {
    moves.push({ row, kind, at: sec(clock.thisMonthEvent(k, 12)) })
  }
  moves.push({ row: newTeams[0] as SaasCompanyRow, kind: "new", at: sec(vaubanWon) })
  const moveOf = new Map(moves.map((m) => [m.row.key, m]))

  const ids = (r: SaasCompanyRow) => ({
    customerId: `cus_TF${alnum(r.key)}`,
    subscriptionId: r.name === "Maison Arlon" ? SAAS_ARLON_SUBSCRIPTION : `sub_TF${alnum(r.key)}`,
  })

  let i = 0
  const push = (
    r: SaasCompanyRow,
    s: Partial<SaasSubscription> & Pick<SaasSubscription, "status" | "billing" | "periodStart">,
  ) => {
    const plan = r.plan as SaasPlan
    const card =
      r.name === "Maison Arlon"
        ? { brand: "visa" as const, last4: "4242" as const, exp: "" }
        : r.name === "Café Ombre"
          ? { brand: "mastercard" as const, last4: "5108" as const, exp: "" }
          : cardOf(i)
    const sub: SaasSubscription = {
      companyKey: r.key,
      ...ids(r),
      email: emailOf(r),
      customerSince: s.customerSince ?? at(-(400 + (i % 200))),
      plan,
      billing: s.billing,
      status: s.status,
      periodStart: s.periodStart,
      periodEnd:
        s.periodEnd ??
        sec(new Date(s.periodStart.getTime() + (s.billing === "month" ? 30 : 365) * DAY_MS)),
      trialEnd: s.trialEnd ?? null,
      canceledAt: s.canceledAt ?? null,
      pastDueSince: s.pastDueSince ?? null,
      card: { ...card, exp: card.exp || cardOf(i).exp },
    }
    // Maison Arlon's Visa ran out at the end of last month's card year.
    if (r.name === "Maison Arlon") sub.card.exp = expiredExp(clock)
    subs.push(sub)
    i++
    return sub
  }

  for (const r of paying) {
    const pastDue = PAST_DUE.find(([n]) => n === r.name)
    const move = moveOf.get(r.key)
    const billing: SaasBilling = monthly.has(r.key) ? "month" : "year"
    if (pastDue) {
      const since = at(-pastDue[1])
      push(r, {
        status: "past_due",
        billing,
        periodStart: since,
        pastDueSince: since,
        ...(r.name === "Maison Arlon" ? { customerSince: at(-610) } : {}),
      })
      continue
    }
    if (move?.kind === "new") {
      push(r, { status: "active", billing, periodStart: move.at, customerSince: move.at })
      continue
    }
    const back = billing === "month" ? 7 + ((i * 7) % 22) : 10 + ((i * 37) % 350)
    const start = r.name === "Relais Saint-Cyr" ? at(-4) : at(-back)
    push(r, { status: "active", billing, periodStart: start })
  }
  TRIALS.forEach(([name], k) => {
    const r = byName(name)
    const ends = [3, 4, 6, 7][k] as number
    push(r, {
      status: "trialing",
      billing: "month",
      periodStart: at(ends - 14),
      periodEnd: at(ends),
      trialEnd: at(ends),
      customerSince: at(ends - 14),
    })
  })
  for (const r of cancelled) {
    const move = moveOf.get(r.key) as (typeof moves)[number]
    push(r, {
      status: "canceled",
      billing: "month",
      periodStart: sec(new Date(move.at.getTime() - 20 * DAY_MS)),
      canceledAt: move.at,
    })
  }
  // Café Ombre cancelled 28 days before the anchor: always last month (the story clock's clamp).
  const ombre = byName("Café Ombre")
  const ombreCancelled =
    monthKeyOf(clock.d(-28)) === clock.monthKey()
      ? sec(clock.lastMonthWeekday(-1, "11:00"))
      : at(-28)
  push(ombre, {
    status: "canceled",
    billing: "month",
    periodStart: sec(new Date(ombreCancelled.getTime() - 20 * DAY_MS)),
    canceledAt: ombreCancelled,
  })

  // The movements, each as the change of the subscription's monthly amount.
  for (const m of moves) {
    const sub = subs.find((s) => s.companyKey === m.row.key) as SaasSubscription
    const team = priceOf("team")
    const [before, after] =
      m.kind === "new"
        ? [0, team]
        : m.kind === "upgrade"
          ? [team, priceOf("group")]
          : m.kind === "downgrade"
            ? [team, priceOf("starter")]
            : [priceOf(m.row.plan as SaasPlan), 0]
    movements.push({
      eventId: `evt_TF${alnum(m.row.key)}${m.kind}`,
      subscriptionId: sub.subscriptionId,
      customerId: sub.customerId,
      at: m.at,
      kind: m.kind,
      beforeMinor: before,
      afterMinor: after,
    })
  }
  // Café Ombre's own cancellation, last month: outside this month's movements.
  const ombreSub = subs.find((s) => s.companyKey === ombre.key) as SaasSubscription
  movements.push({
    eventId: `evt_TF${alnum(ombre.key)}cancelled`,
    subscriptionId: ombreSub.subscriptionId,
    customerId: ombreSub.customerId,
    at: ombreCancelled,
    kind: "cancelled",
    beforeMinor: priceOf("starter"),
    afterMinor: 0,
  })

  // Each counted subscription's latest charge.
  const ombreCharged = sec(new Date(ombreCancelled.getTime() + 2 * DAY_MS))
  const charge = (
    sub: SaasSubscription,
    key: string,
    c: Partial<SaasCardCharge> & Pick<SaasCardCharge, "at" | "periodStart" | "periodEnd">,
  ) => {
    const net = (sub.billing === "year" ? 12 : 1) * priceOf(sub.plan)
    charges.push({
      key,
      invoiceId: `in_TF${alnum(key)}`,
      chargeId: `ch_TF${alnum(key)}`,
      subscriptionId: sub.subscriptionId,
      customerId: sub.customerId,
      netMinor: net,
      taxMinor: (net * SAAS_VAT_BP) / 10_000,
      invoiceStatus: "paid",
      chargeStatus: "succeeded",
      failureCode: null,
      card: sub.card,
      disputed: false,
      invoiceKey: null,
      ...c,
    })
  }
  for (const sub of subs) {
    if (sub.status === "active") {
      charge(sub, `${sub.companyKey}-latest`, {
        at: sub.periodStart,
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
      })
    } else if (sub.status === "past_due") {
      charge(sub, `${sub.companyKey}-latest`, {
        at: sub.periodStart,
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        invoiceStatus: "open",
        chargeStatus: "failed",
        failureCode:
          sub.companyKey === byName("Maison Arlon").key ? "expired_card" : "card_declined",
        ...(sub.companyKey === byName("Maison Arlon").key ? { invoiceKey: "arlon-current" } : {}),
      })
    }
  }
  const arlonSub = subs.find((s) => s.companyKey === byName("Maison Arlon").key) as SaasSubscription
  charge(arlonSub, "maison-arlon-previous", {
    at: at(-37),
    periodStart: at(-37),
    periodEnd: at(-6),
    invoiceKey: "arlon-previous",
  })
  const relais = byName("Relais Saint-Cyr")
  const relaisSub = subs.find((s) => s.companyKey === relais.key) as SaasSubscription
  charge(relaisSub, "relais-saint-cyr-disputed", {
    at: at(-34),
    periodStart: at(-34),
    periodEnd: at(-4),
    disputed: true,
    invoiceKey: "relais-disputed",
  })
  charge(ombreSub, "cafe-ombre-after-cancel", {
    at: ombreCharged,
    periodStart: ombreCharged,
    periodEnd: sec(new Date(ombreCharged.getTime() + 30 * DAY_MS)),
    invoiceKey: "ombre-after-cancel",
  })

  const dispute: SaasDispute = {
    disputeId: `dp_TF${alnum(relais.key)}`,
    chargeId: `ch_TF${alnum("relais-saint-cyr-disputed")}`,
    amountMinor: priceOf("team") + (priceOf("team") * SAAS_VAT_BP) / 10_000,
    reason: "subscription_canceled",
    status: "needs_response",
    at: at(-4),
    evidenceDueBy: at(3),
  }

  const { invoices, schedules } = invoicesAndSchedules(clock, rows, {
    arlonCurrent: at(-6),
    arlonPrevious: at(-37),
    relais: at(-34),
    ombre: ombreCharged,
  })
  return {
    subscriptions: subs,
    movements,
    charges,
    dispute,
    invoices,
    schedules,
    lastEventAt: sec(clock.h(-2 / 60)),
    syncedAt: sec(clock.h(-3)),
    connectedAt: at(-640),
  }
}

/** The last day of the month before the anchor's, as a card's `MM/YY`: an expired card. */
function expiredExp(clock: StoryClock): string {
  const [y, m] = clock.monthKey().split("-").map(Number) as [number, number]
  const year = m === 1 ? y - 1 : y
  const month = m === 1 ? 12 : m - 1
  return `${pad(month)}/${pad(year % 100)}`
}

/** The plan prices per month, in minor units (`fiction.ts`). */
const SAAS_PLAN_PRICES: Record<SaasPlan, number> = {
  starter: SAAS_PLANS.starter.monthlyMinor,
  team: SAAS_PLANS.team.monthlyMinor,
  group: SAAS_PLANS.group.monthlyMinor,
}

const SAAS_CUSTOMER_EMAILS: Readonly<Record<string, string>> = Object.fromEntries(
  SAAS_CUSTOMERS.map((c) => [c.key, c.email]),
)

/**
 * The year's issued invoices, as day offsets at the board's own date, so the
 * numbers the boards name land on their rows there; at any other anchor the
 * same history numbers itself in date order. Between two named invoices the
 * card customers' renewals fill the days evenly.
 */
const NAMED_INVOICES: ReadonlyArray<{
  number: number
  key: string
  company: string
  daysAgo?: number
  when?: keyof NamedWhen
  plan: SaasPlan
  months: number
  paid: boolean
}> = [
  {
    number: 7,
    key: "verrieres-year",
    company: "Groupe Verrières",
    daysAgo: 308,
    plan: "group",
    months: 12,
    paid: true,
  },
  {
    number: 284,
    key: "pins-last",
    company: "Camping Les Pins",
    daysAgo: 70,
    plan: "starter",
    months: 1,
    paid: true,
  },
  {
    number: 298,
    key: "ferrand-quarter",
    company: "Domaine Ferrand",
    daysAgo: 40,
    plan: "team",
    months: 3,
    paid: true,
  },
  {
    number: 362,
    key: "arlon-previous",
    company: "Maison Arlon",
    when: "arlonPrevious",
    plan: "group",
    months: 1,
    paid: true,
  },
  {
    number: 369,
    key: "relais-disputed",
    company: "Relais Saint-Cyr",
    when: "relais",
    plan: "team",
    months: 1,
    paid: true,
  },
  {
    number: 391,
    key: "ombre-after-cancel",
    company: "Café Ombre",
    when: "ombre",
    plan: "starter",
    months: 1,
    paid: true,
  },
  {
    number: 411,
    key: "belcour-last",
    company: "Hôtels Belcour",
    daysAgo: 9,
    plan: "team",
    months: 1,
    paid: true,
  },
  {
    number: 412,
    key: "alize-last",
    company: "Résidence Alizé",
    daysAgo: 9,
    plan: "team",
    months: 1,
    paid: true,
  },
  {
    number: 413,
    key: "port-last",
    company: "Cantines du Port",
    daysAgo: 9,
    plan: "group",
    months: 1,
    paid: true,
  },
  {
    number: 414,
    key: "marceau-last",
    company: "Bistrot Marceau",
    daysAgo: 9,
    plan: "starter",
    months: 1,
    paid: false,
  },
  {
    number: 415,
    key: "comptoir-sud-last",
    company: "Le Comptoir Sud",
    daysAgo: 9,
    plan: "team",
    months: 1,
    paid: true,
  },
  {
    number: 416,
    key: "noord-last",
    company: "Stadshotel Noord BV",
    daysAgo: 9,
    plan: "team",
    months: 1,
    paid: true,
  },
  {
    number: 418,
    key: "arlon-current",
    company: "Maison Arlon",
    when: "arlonCurrent",
    plan: "group",
    months: 1,
    paid: false,
  },
]

interface NamedWhen {
  arlonCurrent: Date
  arlonPrevious: Date
  relais: Date
  ombre: Date
}

/** The year the board date's invoices are numbered in starts this many days before it. */
const BOARD_DAY_OF_YEAR = 312

function invoicesAndSchedules(
  clock: StoryClock,
  rows: readonly SaasCompanyRow[],
  when: NamedWhen,
): { invoices: SaasInvoice[]; schedules: SaasSchedule[] } {
  const keyOf = (name: string) => {
    const r = rows.find((c) => c.name === name)
    if (!r) throw new Error(`saas plan: no company '${name}'`)
    return r.key
  }
  const yearly = (plan: SaasPlan, months: number) => months * SAAS_PLAN_PRICES[plan]
  const label = (plan: SaasPlan, months: number) =>
    `${SAAS_PLANS[plan].name} plan, ${months === 12 ? "year" : months === 3 ? "quarter" : "month"}`
  // The day offsets every slot is issued on, from the named ones; between them, evenly.
  type Slot = { at: Date; seq: number; named?: (typeof NAMED_INVOICES)[number] }
  const slots: Slot[] = []
  const dayOf = (n: (typeof NAMED_INVOICES)[number]) =>
    n.daysAgo !== undefined
      ? n.daysAgo
      : Math.round(
          (clock.anchor.getTime() - (when[n.when as keyof NamedWhen] as Date).getTime()) / DAY_MS,
        )
  const instantOf = (n: (typeof NAMED_INVOICES)[number]) =>
    n.when ? (when[n.when] as Date) : sec(clock.d(-(n.daysAgo as number), "10:00"))
  let prev = { number: 0, days: BOARD_DAY_OF_YEAR }
  for (const n of NAMED_INVOICES) {
    const days = dayOf(n)
    const gap = n.number - prev.number - 1
    for (let j = 1; j <= gap; j++) {
      const d = prev.days - Math.floor((j * (prev.days - days)) / (gap + 1))
      slots.push({ at: sec(clock.d(-d, "10:00")), seq: prev.number + j })
    }
    slots.push({ at: instantOf(n), seq: n.number, named: n })
    prev = { number: n.number, days }
  }
  // Numbers follow the day, then the slot's place: a named invoice issued later in the day than
  // the anchor's 10:00 fillers keeps the board's number at any time of day. Within a day a
  // filler's time moves to sit beside its named neighbour, so issue times still follow numbers.
  const dayKey = (d: Date) => parisCivil(d)
  slots.sort((a, b) => dayKey(a.at).localeCompare(dayKey(b.at)) || a.seq - b.seq)
  for (let i = slots.length - 2; i >= 0; i--) {
    const s = slots[i] as Slot
    const next = slots[i + 1] as Slot
    if (!s.named && dayKey(s.at) === dayKey(next.at) && s.at.getTime() > next.at.getTime()) {
      s.at = new Date(next.at.getTime() - 60_000)
    }
  }
  for (let i = 1; i < slots.length; i++) {
    const s = slots[i] as Slot
    const prevSlot = slots[i - 1] as Slot
    if (
      !s.named &&
      dayKey(s.at) === dayKey(prevSlot.at) &&
      s.at.getTime() < prevSlot.at.getTime()
    ) {
      s.at = new Date(prevSlot.at.getTime() + 60_000)
    }
  }

  const fillers = rows.filter((r) => r.kind === "paying" && r.plan && r.name !== "Maison Arlon")
  const counters = new Map<number, number>()
  const invoices: SaasInvoice[] = []
  let f = 0
  for (const s of slots) {
    const year = Number(parisCivil(s.at).slice(0, 4))
    const numberInt = (counters.get(year) ?? 0) + 1
    counters.set(year, numberInt)
    const number = `F-${year}-${pad(numberInt, 4)}`
    if (s.named) {
      const n = s.named
      invoices.push({
        key: n.key,
        companyKey: keyOf(n.company),
        description: label(n.plan, n.months),
        unitMinor: n.months === 3 ? SAAS_PLAN_PRICES[n.plan] : yearly(n.plan, n.months),
        quantity: n.months === 3 ? 3 : 1,
        issuedAt: s.at,
        paidAt: n.paid ? s.at : null,
        number,
        numberInt,
        year,
      })
      continue
    }
    const r = fillers[f++ % fillers.length] as SaasCompanyRow
    const months = f % 4 === 0 ? 12 : 1
    invoices.push({
      key: `renewal-${s.seq}`,
      companyKey: r.key,
      description: label(r.plan as SaasPlan, months),
      unitMinor: yearly(r.plan as SaasPlan, months),
      quantity: 1,
      issuedAt: s.at,
      paidAt: s.at,
      number,
      numberInt,
      year,
    })
  }

  // The ten schedules billed by transfer.
  const today = parisCivil(clock.anchor)
  const monthEnd = nextLastDay(today, "month")
  const sched = (
    name: string,
    plan: SaasPlan,
    repeats: SaasSchedule["repeats"],
    extra: Partial<SaasSchedule> = {},
  ): SaasSchedule => {
    const nextIssueOn =
      extra.status === "paused"
        ? null
        : repeats === "month"
          ? monthEnd
          : repeats === "quarter"
            ? nextLastDay(today, "quarter")
            : parisCivil(clock.yearFirst(1, 5))
    return {
      key: `${slug(name)}-schedule`,
      companyKey: keyOf(name),
      repeats,
      billingDay: repeats === "year" ? "01-05" : "last",
      status: "active",
      description: `${SAAS_PLANS[plan].name} plan`,
      quantity: repeats === "quarter" ? 3 : 1,
      unitMinor: repeats === "year" ? 12 * SAAS_PLAN_PRICES[plan] : SAAS_PLAN_PRICES[plan],
      vatBp: SAAS_VAT_BP,
      nextIssueOn,
      nextDraftOn: nextIssueOn ? draftDayOf(nextIssueOn) : null,
      pausedUntil: null,
      lastInvoiceKey: null,
      ...extra,
    }
  }
  const schedules: SaasSchedule[] = [
    sched("Hôtels Belcour", "team", "month", { lastInvoiceKey: "belcour-last" }),
    sched("Résidence Alizé", "team", "month", { lastInvoiceKey: "alize-last" }),
    sched("Cantines du Port", "group", "month", { lastInvoiceKey: "port-last" }),
    sched("Bistrot Marceau", "starter", "month", { lastInvoiceKey: "marceau-last" }),
    sched("Le Comptoir Sud", "team", "month", { lastInvoiceKey: "comptoir-sud-last" }),
    // A Dutch company with a VAT number: reverse charge, no French VAT.
    sched("Stadshotel Noord BV", "team", "month", { lastInvoiceKey: "noord-last", vatBp: 0 }),
    // Its first run is this month's end.
    sched("Hôtel Mirabel", "starter", "month"),
    sched("Domaine Ferrand", "team", "quarter", { lastInvoiceKey: "ferrand-quarter" }),
    sched("Camping Les Pins", "starter", "month", {
      status: "paused",
      pausedUntil: parisCivil(clock.yearFirst(4, 1)),
      lastInvoiceKey: "pins-last",
    }),
    sched("Groupe Verrières", "group", "year", { lastInvoiceKey: "verrieres-year" }),
  ]
  return { invoices, schedules }
}

/** The `saas` world's money at `anchor`. Pure: two calls with one anchor are equal. */
export function saasMoneyPlan(anchor: Date): SaasMoneyPlan {
  const clock = storyClock(anchor)
  const rows = companies()
  return money(clock, rows, deals(clock, rows))
}

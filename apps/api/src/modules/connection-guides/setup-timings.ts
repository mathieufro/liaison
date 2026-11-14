// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How long each setup step takes the person doing it, the one source for every
 * time the product states: `liaison setup state` (the time of what is left),
 * the generated setup reference, the setup skill, the install page, the README
 * and AGENTS.md (a guard test checks they quote `TRIAL_SUMMARY`,
 * `basicOnboardingSummary()` and `fullOnboardingSummary()`).
 *
 * The totals (trial, basic, full) were measured on a real install with a coding
 * agent driving the steps (2026-10-31). The rows split them: each row is the
 * person's own time, in the provider's console, following the steps, with the
 * waits the provider imposes listed apart (they are not the person's time and
 * some take days, so they are never in a sum). The `basic` rows add up to the
 * basic onboarding, every row but the `extra` ones to the full onboarding (a
 * guard test checks both), and each HUMAN step of a guide, a manifest or a server
 * surface carries its own `minutes`, which fit its row. `liaison setup state`
 * sums the rows of what is left. Pure: no imports.
 */

export interface StepEstimate {
  /** Minutes of the person's own time, low and high. */
  minutes: [number, number]
  /** What the provider makes them wait for, outside their own time. */
  waits?: string
  /** `basic`: part of the basic onboarding (its rows add up to BASIC_ONBOARDING_MINUTES).
   *  `extra`: outside the measured full onboarding (a system of your own, or an
   *  alternative to another row), listed with its own time. Unset: the full onboarding. */
  part?: "basic" | "extra"
}

/** The quick trial: this machine, company knowledge and agents, no mail. Measured. */
export const TRIAL_MINUTES = 9
export const TRIAL_SUMMARY =
  "about 9 minutes for a trial on your own machine (your knowledge and agents, no mailbox yet, so nobody else can sign in)"

/** The basic onboarding on a server, measured on a live install (2026-10-31): the
 *  server, the mail sender, Google sign-in and the people, the support inbox and
 *  the company knowledge, with a coding agent running every AGENT step. */
export const BASIC_ONBOARDING_MINUTES = 15
/** A full onboarding with every connector, measured on the same install: at most. */
export const FULL_ONBOARDING_MAX_MINUTES = 120

/** Per server surface (server-setup.ts ids). Zero: nothing to do in a single-company setup. */
export const SERVER_ESTIMATES: Record<string, StepEstimate> = {
  domain: {
    minutes: [1, 3],
    part: "basic",
    waits: "DNS changes usually apply within minutes, sometimes hours",
  },
  email: {
    minutes: [3, 5],
    part: "basic",
    waits: "the mail provider verifies the domain's records, usually within minutes",
  },
  modelKeys: { minutes: [1, 2], part: "basic" },
  backups: { minutes: [1, 2] },
  signInGoogle: { minutes: [2, 4], part: "basic" },
  // A single company gives its clients in the workspace config instead.
  instanceClients: { minutes: [0, 0] },
  drivePicker: { minutes: [3, 5] },
  webPush: { minutes: [1, 2] },
  // Not available with the published phone app (server-setup.ts).
  phonePush: { minutes: [0, 0] },
  // The bundled store needs nothing; an external bucket is 15 to 20 minutes.
  objectStorage: { minutes: [0, 0] },
  webSearch: { minutes: [1, 2] },
}

/** Per group of connections set up together (one Google client serves all of them). */
export const CONNECTION_ESTIMATES: Array<{ refs: string[]; label: string } & StepEstimate> = [
  {
    refs: ["mail/gmail", "tickets/gmail", "calendar/google-calendar", "google-drive/drive"],
    label:
      "Google Workspace: one Google Cloud client, then Gmail, ticket inbox, Calendar and Drive consents",
    minutes: [4, 10],
    part: "basic",
    waits:
      "marking the client Trusted in a Google Workspace can take up to an hour to apply; Google's verification (needed only for personal Gmail accounts on full Gmail access) takes weeks",
  },
  {
    refs: ["ads/google", "ads/merchant", "ads/google-config", "social/google"],
    label:
      "Google Ads, Merchant Center and YouTube (optional, advanced): their APIs on the same Google client, Explorer access to the Google Ads API in the Cloud console (no developer token) and the account ids",
    minutes: [6, 12],
    waits:
      "Explorer access is usually granted within minutes; Basic access (only for creating accounts or managing users, which Liaison does not use) needs the Cloud project's brand verification",
  },
  {
    refs: ["shopify/shop"],
    label: "Shopify: a Dev Dashboard app, released and installed on the store",
    minutes: [6, 12],
  },
  {
    refs: ["social/facebook", "social/instagram"],
    label:
      "Facebook Pages and Instagram: one Meta app with both products, then the consents and the Page webhooks",
    minutes: [12, 20],
    waits:
      "Pages of people without a role on the Meta app need Business verification and App Review, which take days",
  },
  {
    refs: ["social/instagram_unified"],
    label:
      "Instagram with Unified login (preview, instead of the Instagram login above): the account in the app's business portfolio, a Unified-login configuration and its id",
    minutes: [12, 20],
    part: "extra",
  },
  { refs: ["ads/meta"], label: "Meta Ads: a system user token", minutes: [5, 8] },
  {
    refs: ["mail/imap", "tickets/imap"],
    label: "An IMAP mailbox: an app password",
    minutes: [2, 4],
  },
  { refs: ["gitlab/gitlab"], label: "GitLab: a read-only access token", minutes: [2, 4] },
  { refs: ["boxtal/boxtal"], label: "Boxtal: two API key pairs", minutes: [4, 7] },
  { refs: ["pennylane/pennylane"], label: "Pennylane: an API token", minutes: [3, 6] },
  // Not in the install the full onboarding was measured on: listed with its own time.
  {
    refs: ["github/github"],
    label: "GitHub: a read-only fine-grained token",
    minutes: [3, 5],
    part: "extra",
  },
  {
    refs: ["stripe/stripe"],
    label: "Stripe: a restricted key and a webhook",
    minutes: [5, 10],
    part: "extra",
  },
  {
    refs: ["calls/transcript-source", "monitoring/alert-source", "projects/ci-source"],
    label:
      "Webhook sources (call transcripts, monitoring alerts, CI status): one signed webhook each in your own system",
    minutes: [15, 30],
    part: "extra",
  },
  {
    refs: ["database/database", "database/warehouse"],
    label: "A database: a read-only role and its catalog",
    minutes: [10, 20],
    part: "extra",
  },
  {
    refs: ["api-connector/api"],
    label:
      "Another system's API (a CRM, an ERP): an adapter written and tested with your coding agent",
    minutes: [20, 40],
    part: "extra",
  },
]

/** The knowledge part: the person's own time (the interview, the review); the agent
 *  gathers and loads meanwhile (the measured 9-minute trial includes its work). */
export const KNOWLEDGE_ESTIMATE: StepEstimate = { minutes: [3, 6], part: "basic" }

/** Every row with its name, for the sums (server surfaces, connection groups, knowledge). */
export function allEstimates(): Array<{ name: string } & StepEstimate> {
  return [
    ...Object.entries(SERVER_ESTIMATES).map(([id, e]) => ({ name: `server:${id}`, ...e })),
    ...CONNECTION_ESTIMATES.map((e) => ({ ...e, name: e.refs.join("+") })),
    { name: "knowledge", ...KNOWLEDGE_ESTIMATE },
  ]
}

/** The low and high sums of the basic rows, and of the full onboarding's rows (not `extra`). */
export function estimateTotals(): { basic: [number, number]; full: [number, number] } {
  const sum = (rows: StepEstimate[]): [number, number] => [
    rows.reduce((n, r) => n + r.minutes[0], 0),
    rows.reduce((n, r) => n + r.minutes[1], 0),
  ]
  const rows = allEstimates()
  return {
    basic: sum(rows.filter((r) => r.part === "basic")),
    full: sum(rows.filter((r) => r.part !== "extra")),
  }
}

/** "about 2 hours": minutes as a person reads them (whole hours from 60 min). */
export function spoken(minutes: number): string {
  if (minutes < 60) return `about ${minutes} minutes`
  const h = Math.round((minutes / 60) * 2) / 2
  return `about ${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`
}

/** The sentence every surface quotes for the basic onboarding. Measured. */
export function basicOnboardingSummary(): string {
  return `${spoken(BASIC_ONBOARDING_MINUTES)} for the basic onboarding on a server (the mail sender, Google sign-in, your team, the support inbox and your company knowledge)`
}

/** "up to about 2 hours": a full onboarding with every connector. Measured. */
export function fullOnboardingHours(): string {
  return `up to ${spoken(FULL_ONBOARDING_MAX_MINUTES)}`
}

/** The sentence every surface quotes for a full onboarding. Measured. */
export function fullOnboardingSummary(): string {
  return `${fullOnboardingHours()} of your own time for a full onboarding on a server with every connector`
}

/** The estimate of one connection ref, or null when no group lists it. */
export function connectionEstimate(ref: string): (StepEstimate & { label: string }) | null {
  return CONNECTION_ESTIMATES.find((e) => e.refs.includes(ref)) ?? null
}

/** The connection group each shared guide (setup-guides.ts SETUP_GUIDE_IDS) is timed by. */
const GUIDE_REFS: Record<string, string> = {
  google: "mail/gmail",
  googleTrusted: "mail/gmail",
  shopify: "shopify/shop",
  shopifyDashboard: "shopify/shop",
  imap: "mail/imap",
}

/** The time of one shared guide, or null when it has none. */
export function guideEstimate(id: string): (StepEstimate & { label: string }) | null {
  const ref = GUIDE_REFS[id]
  return ref ? connectionEstimate(ref) : null
}

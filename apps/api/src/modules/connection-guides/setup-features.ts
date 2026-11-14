// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The features a setup offers, and what is left of the ones the person chose.
 *
 * The onboarding asks which features the person wants before any connector
 * (the setup-guide prompt, the setup skill). Their answer is stored in the org
 * config (`setup.features`, kernel settings `chosenFeatures`). What is LEFT is
 * only what they chose and is not yet connected; every other feature is a MENU
 * item with its time, offered, never owed. A step that has alternatives (Gmail
 * or an IMAP mailbox; the Instagram login or Instagram with Unified login) is
 * done as soon as one of them is connected, whether or not it was chosen.
 *
 * Until the person answers, the basics stand for their choice (the mail and
 * the support inbox), and the result says the question is still open.
 *
 * Pure: the caller passes which connections exist and which are connected.
 */
import { connectionEstimate } from "~/modules/connection-guides/setup-timings"

/** One step of a feature: done when any of `refs` (`app/connection`) is connected. */
export interface FeatureStep {
  refs: string[]
  /** Not needed for the feature to work (an extra the person may add). */
  optional?: boolean
}

export interface SetupFeature {
  id: string
  label: string
  steps: FeatureStep[]
  /** A workspace checklist item the feature is (setup-state.ts), instead of or beside connections. */
  item?: "import" | "connector"
  /** Part of the basics: what an unanswered question stands for. */
  basic?: boolean
}

export const SETUP_FEATURES: readonly SetupFeature[] = [
  {
    id: "email",
    label: "Email (Gmail or an IMAP mailbox)",
    steps: [{ refs: ["mail/gmail", "mail/imap"] }],
    basic: true,
  },
  {
    id: "support",
    label: "A support inbox (tickets)",
    steps: [{ refs: ["tickets/gmail", "tickets/imap"] }],
    basic: true,
  },
  {
    id: "import",
    label: "Import your projects (Jira) or your helpdesk history (Freshdesk or another desk)",
    steps: [],
    item: "import",
  },
  { id: "calendar", label: "Google Calendar", steps: [{ refs: ["calendar/google-calendar"] }] },
  { id: "drive", label: "Google Drive", steps: [{ refs: ["google-drive/drive"] }] },
  { id: "shopify", label: "Shopify", steps: [{ refs: ["shopify/shop"] }] },
  {
    id: "social",
    label: "Facebook Pages and Instagram",
    steps: [
      { refs: ["social/facebook"] },
      { refs: ["social/instagram", "social/instagram_unified"] },
    ],
  },
  { id: "youtube", label: "YouTube", steps: [{ refs: ["social/google"] }] },
  {
    id: "google-ads",
    label: "Google Ads",
    steps: [{ refs: ["ads/google"] }, { refs: ["ads/google-config"], optional: true }],
  },
  { id: "merchant", label: "Google Merchant Center", steps: [{ refs: ["ads/merchant"] }] },
  { id: "meta-ads", label: "Meta Ads", steps: [{ refs: ["ads/meta"] }] },
  { id: "gitlab", label: "GitLab", steps: [{ refs: ["gitlab/gitlab"] }] },
  { id: "github", label: "GitHub", steps: [{ refs: ["github/github"] }] },
  { id: "boxtal", label: "Boxtal shipping", steps: [{ refs: ["boxtal/boxtal"] }] },
  { id: "pennylane", label: "Pennylane accounting", steps: [{ refs: ["pennylane/pennylane"] }] },
  { id: "stripe", label: "Stripe payments", steps: [{ refs: ["stripe/stripe"] }] },
  {
    id: "database",
    label: "A database of your own",
    steps: [{ refs: ["database/database", "database/warehouse"] }],
  },
  {
    id: "api-connector",
    label: "Another system's API (a CRM, an ERP)",
    steps: [{ refs: ["api-connector/api"] }],
    item: "connector",
  },
  {
    id: "call-transcripts",
    label: "Call transcripts (a webhook from your call tool)",
    steps: [{ refs: ["calls/transcript-source"] }],
  },
  {
    id: "monitoring-alerts",
    label: "Monitoring alerts (a webhook from your monitoring)",
    steps: [{ refs: ["monitoring/alert-source"] }],
  },
  {
    id: "ci-status",
    label: "CI status on projects (a webhook from your CI)",
    steps: [{ refs: ["projects/ci-source"] }],
  },
]

export const SETUP_FEATURE_IDS: readonly string[] = SETUP_FEATURES.map((f) => f.id)

/** The ids `setup.features` accepts, for the error of an unknown one. */
export function unknownSetupFeatures(ids: readonly string[]): string[] {
  const known = new Set(SETUP_FEATURE_IDS)
  return ids.filter((id) => !known.has(id))
}

export interface FeatureFacts {
  /** The connection exists here: its app is on and declares it. */
  available(ref: string): boolean
  /** An active account is connected. */
  connected(ref: string): boolean
  /** A workspace checklist item is done. */
  itemDone(key: "import" | "connector"): boolean
}

/** One open step of a chosen feature. */
export interface FeatureLeftStep {
  feature: string
  /** The connections that would do it (alternatives), those available here only. */
  refs: string[]
  /** Set when nothing here can do it: the feature's app is off. */
  unavailable?: true
  /** The workspace item it is (import, connector), when it is one. */
  item?: "import" | "connector"
  /** What of the same feature is already connected, when something is: a
   *  partly done feature says so instead of reading as untouched. */
  done?: string[]
}

export interface FeatureMenuItem {
  feature: string
  label: string
  /** Minutes of the person's own time for its open steps (setup-timings.ts), when known. */
  minutes?: [number, number]
  /** Partly done: what is already connected, and the open steps left (alternatives per step). */
  done?: string[]
  open?: string[][]
}

export interface FeaturePlan {
  /** The features the person chose; null: not asked yet (the basics stand for it). */
  chosen: string[] | null
  /** What `left` is computed from: the chosen features, or the basics. */
  counted: string[]
  /** Chosen features whose every step is done. */
  done: string[]
  left: FeatureLeftStep[]
  /** Minutes of the person's own time the left steps take (one estimate group counts once). */
  leftMinutes: [number, number]
  /** Every other feature that works here and is not done, with its time: offered, never owed. */
  menu: FeatureMenuItem[]
}

function stepDone(step: FeatureStep, facts: FeatureFacts): boolean {
  return step.refs.some((r) => facts.connected(r))
}

/** The connections of a feature that are already connected (optional steps included). */
function connectedRefs(f: SetupFeature, facts: FeatureFacts): string[] {
  return f.steps.flatMap((s) => s.refs.filter((r) => facts.connected(r)))
}

/** The open steps of a feature (required ones; an optional step is never owed). */
function openSteps(f: SetupFeature, facts: FeatureFacts): FeatureLeftStep[] {
  const out: FeatureLeftStep[] = []
  const connected = connectedRefs(f, facts)
  const done = connected.length ? { done: connected } : {}
  if (f.item && !facts.itemDone(f.item) && f.steps.length === 0) {
    out.push({ feature: f.id, refs: [], item: f.item })
  }
  for (const step of f.steps) {
    if (step.optional || stepDone(step, facts)) continue
    const refs = step.refs.filter((r) => facts.available(r))
    // An item-backed connection (an API connector) is done by its item too.
    if (f.item && facts.itemDone(f.item)) continue
    out.push(
      refs.length
        ? { feature: f.id, refs, ...done }
        : { feature: f.id, refs: step.refs, unavailable: true, ...done },
    )
  }
  return out
}

/** Whether anything of a feature exists here (an item, or a connection of an app that is on). */
function featureAvailable(f: SetupFeature, facts: FeatureFacts): boolean {
  return f.item === "import" || f.steps.some((s) => s.refs.some((r) => facts.available(r)))
}

/** Sum the estimates of steps (the first available ref of each), each group once. */
function minutesOf(steps: FeatureLeftStep[], seen: Set<string>): [number, number] | undefined {
  let found = false
  const m: [number, number] = [0, 0]
  for (const s of steps) {
    const e = s.refs.map((r) => connectionEstimate(r)).find((x) => x !== null)
    if (!e) continue
    found = true
    if (seen.has(e.label)) continue
    seen.add(e.label)
    m[0] += e.minutes[0]
    m[1] += e.minutes[1]
  }
  return found ? m : undefined
}

export function buildFeaturePlan(chosen: string[] | null, facts: FeatureFacts): FeaturePlan {
  const known = new Set(SETUP_FEATURE_IDS)
  const picked = chosen?.filter((id) => known.has(id)) ?? null
  const counted = picked ?? SETUP_FEATURES.filter((f) => f.basic).map((f) => f.id)
  const countedSet = new Set(counted)
  const left: FeatureLeftStep[] = []
  const done: string[] = []
  for (const f of SETUP_FEATURES) {
    if (!countedSet.has(f.id)) continue
    const open = openSteps(f, facts)
    if (open.length === 0) done.push(f.id)
    left.push(...open)
  }
  const seen = new Set<string>()
  const leftMinutes = minutesOf(left, seen) ?? [0, 0]
  const menu: FeatureMenuItem[] = []
  for (const f of SETUP_FEATURES) {
    if (countedSet.has(f.id) || !featureAvailable(f, facts)) continue
    const open = openSteps(f, facts).filter((s) => !s.unavailable)
    if (open.length === 0) continue
    // A menu item's time is its own, even when a chosen feature shares its console work.
    const minutes = minutesOf(open, new Set())
    const connected = connectedRefs(f, facts)
    menu.push({
      feature: f.id,
      label: f.label,
      ...(minutes ? { minutes } : {}),
      ...(connected.length ? { done: connected, open: open.map((s) => s.refs) } : {}),
    })
  }
  return { chosen: picked, counted, done, left, leftMinutes, menu }
}

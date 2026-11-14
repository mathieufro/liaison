// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fiction the `standard` tier seeds: the Resonant Audio Labs team of the
// demo and lively tiers (seed/world/fiction.ts), cut to five people of distinct
// authority: the admin (Elodie Vasseur, signed up by the lane) and four
// teammates (Amina Cherif, Lucas Pereira, Tobias Braun, Margot Dufour, on the
// reserved `resonantaudiolabs.example` domain), their channels and chats,
// contacts, knowledge, tickets, approvals, mail and agent-app content. Data
// only; `seed/tiers/standard/` writes it.
//
// The Playwright and api e2e lanes and `bun run dev` read this world: specs
// address its people, threads and rows by these names and counts, so a change
// here is a change to every spec that reads it.

export const QA_PASSWORD = "QaPass1!"

export type QaPersonKey = "admin" | "amina" | "lucas" | "tobias" | "margot"
export type QaMemberKey = Exclude<QaPersonKey, "admin">

/** The four teammates, in the order they join the org. */
export const QA_MEMBERS: ReadonlyArray<{ key: QaMemberKey; email: string; name: string }> = [
  { key: "amina", email: "amina@resonantaudiolabs.example", name: "Amina Cherif" },
  { key: "lucas", email: "lucas@resonantaudiolabs.example", name: "Lucas Pereira" },
  { key: "tobias", email: "tobias@resonantaudiolabs.example", name: "Tobias Braun" },
  { key: "margot", email: "margot@resonantaudiolabs.example", name: "Margot Dufour" },
]

/** The scopes each teammate's own role grants at invitation. */
export const QA_MEMBER_SCOPES: readonly string[] = [
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:users:read",
  "kernel:contacts:read",
  "kernel:companies:read",
  "kernel:products:read",
  "kernel:contacts:write",
  "kernel:companies:write",
  "kernel:products:write",
  "mail:accounts:read",
  "mail:conversations:read",
  "mail:suppressions:read",
  "mail:conversations:write",
  "mail:messages:read",
  "mail:messages:write",
  "mail:approve",
  "test:gated:write",
  "test:approve",
  "kernel:approvals:read",
  "kernel:approvals:write",
  "kernel:approve",
  "kernel:agent:memory",
  "kernel:agent:web",
  "kernel:skills:read",
  "kernel:skills:write",
  "kernel:routines:read",
  "kernel:routines:write",
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
]

/**
 * The approver split. Amina and Lucas lose `mail:approve` and `test:approve`, so
 * a gated call they make waits for someone else (a direct UI call by a holder
 * of `<app>:approve` would approve itself). Tobias is the domain approver for
 * skills (`kernel:skills:approve` plus every skills domain) without the
 * admin-grade `kernel:approve`, which Margot keeps without skills authority.
 */
export const QA_APPROVER_SPLIT = {
  revoked: [
    { key: "amina", scopes: ["mail:approve", "test:approve"] },
    { key: "lucas", scopes: ["mail:approve", "test:approve"] },
    { key: "tobias", scopes: ["kernel:approve"] },
  ],
  userScopes: [{ key: "tobias", scope: "kernel:skills:approve" }],
  userDimensions: [{ key: "tobias", dimension: "kernel:skills_domain", values: ["*"] }],
} as const satisfies {
  revoked: ReadonlyArray<{ key: QaMemberKey; scopes: readonly string[] }>
  userScopes: ReadonlyArray<{ key: QaMemberKey; scope: string }>
  userDimensions: ReadonlyArray<{ key: QaMemberKey; dimension: string; values: readonly string[] }>
}

/** Every person sees every team's and every sensitivity's knowledge. */
export const QA_KNOWLEDGE_DIMENSIONS: ReadonlyArray<{ dimension: string; values: string[] }> = [
  { dimension: "team", values: ["*"] },
  { dimension: "sensitivity", values: ["restricted"] },
]

export interface QaContactSpec {
  key: "hansPrimary" | "hansDuplicate" | "sofiaPrimary" | "sofiaDuplicate"
  email: string
  name: string
  company: string
  externalId: Record<string, string>
}

/** Two people with a duplicate each: the merge surface's resting state. */
export const QA_CONTACTS: readonly QaContactSpec[] = [
  {
    key: "hansPrimary",
    email: "hans@acme.de",
    name: "Hans Weber",
    company: "Acme GmbH",
    externalId: { phase5: "hans-primary" },
  },
  {
    key: "hansDuplicate",
    email: "hans.weber@acme.de",
    name: "Hans Weber",
    company: "Acme GmbH",
    externalId: { phase5: "hans-duplicate" },
  },
  {
    key: "sofiaPrimary",
    email: "sofia.rossi@studio.test",
    name: "Sofia Rossi",
    company: "Rossi Studio",
    externalId: { phase5: "sofia-primary" },
  },
  {
    key: "sofiaDuplicate",
    email: "s.rossi@studio.test",
    name: "S. Rossi",
    company: "Rossi Studio",
    externalId: { phase5: "sofia-duplicate" },
  },
]

export type QaThreadKey =
  | "q2Marketing"
  | "bugCheckout"
  | "dmAdminAmina"
  | "dmAminaLucas"
  | "sprintRetro"
  | "securityAudit"
  | "designSystemV2"
  | "vendorEval"
  | "releaseChecklist"
  | "weeklyStandup"
  | "untitledDesignChat"
  | "untitledOpsChat"
  | "untitledAdminLucas"
  | "infraCostReview"

export interface QaThreadSpec {
  key: QaThreadKey
  creator: QaPersonKey
  participants: QaPersonKey[]
  title?: string
  isPinned?: boolean
  /** The first message is the creator's; then each line in order. */
  first: string
  lines: Array<[QaPersonKey, string]>
  /** Reactions by message position counted from the newest (0 = the last message), in order. */
  reactions?: Array<{ fromNewest: number; by: QaPersonKey; emoji: string }>
  /** A participant's own state on the thread, set last. */
  state?: { by: QaPersonKey; isArchived?: boolean; isMuted?: boolean }
}

/** Fourteen threads: 1 pinned, 1 archived, 1 muted, 3 untitled, 5 without Elodie. */
export const QA_THREADS: readonly QaThreadSpec[] = [
  {
    key: "q2Marketing",
    creator: "admin",
    participants: ["amina", "lucas"],
    title: "Q2 Marketing Plan",
    isPinned: true,
    first: "Let's align on the Q2 marketing strategy. I've drafted the budget.",
    lines: [
      ["amina", "Sounds good! I'll review the budget by EOD."],
      ["lucas", "Can we include the new social media campaign?"],
      ["admin", "Absolutely. Amina, can you pull the metrics from last quarter?"],
      ["amina", "Already on it. Here are the preliminary numbers..."],
      ["lucas", "These look promising. Let's schedule a deep dive."],
      ["admin", "Thursday 2pm works for me."],
      ["amina", "Same here. I'll send the invite."],
    ],
  },
  {
    key: "bugCheckout",
    creator: "amina",
    participants: ["lucas", "tobias"],
    title: "Bug in checkout flow",
    first: "Found a critical bug — the payment form crashes on mobile Safari.",
    lines: [
      ["lucas", "Can you share the stack trace?"],
      ["amina", "Here it is: TypeError: Cannot read property 'submit' of null"],
      ["tobias", "I think I see the issue. The form ref isn't initialized on iOS."],
      ["amina", "Good catch! Can you push a fix?"],
      ["tobias", "Working on it now. Should have a PR up in an hour."],
      ["lucas", "Let me know when it's ready for review."],
      ["tobias", "PR is up: #1247. Added a null check and a test case."],
      ["amina", "Reviewing now..."],
      ["amina", "LGTM! Merging."],
      ["lucas", "Nice work, team!"],
      ["tobias", "Thanks! The fix is deployed to staging."],
    ],
    reactions: [
      { fromNewest: 4, by: "amina", emoji: "👍" },
      { fromNewest: 7, by: "amina", emoji: "🎉" },
      { fromNewest: 7, by: "lucas", emoji: "🎉" },
      { fromNewest: 10, by: "tobias", emoji: "🙏" },
    ],
  },
  {
    key: "dmAdminAmina",
    creator: "admin",
    participants: ["amina"],
    first: "Hey Amina, quick question about the onboarding flow.",
    lines: [
      ["amina", "Sure, what's up?"],
      ["admin", "Can we add a progress bar to step 3?"],
      ["amina", "Definitely. I'll add it to the sprint backlog."],
      ["admin", "Thanks!"],
    ],
  },
  {
    key: "dmAminaLucas",
    creator: "amina",
    participants: ["lucas"],
    first: "Hey Lucas, did you see the latest design mockups?",
    lines: [
      ["lucas", "Not yet! Can you share the link?"],
      ["amina", "Here you go: https://figma.com/example. Let me know what you think."],
    ],
  },
  {
    key: "sprintRetro",
    creator: "admin",
    participants: ["amina", "lucas", "tobias", "margot"],
    title: "Sprint retrospective",
    first: "Time for our sprint retro! What went well this sprint?",
    lines: [
      ["amina", "The new search feature shipped on time. Great collaboration!"],
      ["lucas", "Agreed. The pair programming sessions were super helpful."],
      ["tobias", "Deployment pipeline improvements saved us hours."],
      ["margot", "Cross-team communication was much better this sprint."],
      ["admin", "Great feedback! Now, what could we improve?"],
      ["amina", "We need better estimation. Several stories took longer than expected."],
      ["lucas", "Code review turnaround time could be faster."],
      ["tobias", "More testing coverage for edge cases."],
      ["margot", "Documentation updates keep falling behind."],
      ["admin", "Noted. Let's create action items for next sprint."],
      ["amina", "I'll own the estimation improvement — proposing planning poker."],
      ["lucas", "I'll set up a code review SLA dashboard."],
      ["tobias", "I'll add integration test coverage targets to our CI."],
      ["margot", "I'll create a doc update checklist for PRs."],
      ["admin", "Perfect. Let's follow up next week. Great retro, team!"],
    ],
  },
  {
    key: "securityAudit",
    creator: "admin",
    participants: ["tobias"],
    title: "Security audit findings",
    first: "The security audit report is in. A few items need attention.",
    lines: [
      ["tobias", "I'll review the critical findings first."],
      ["admin", "Focus on the XSS vulnerability in the search input."],
      ["tobias", "Fixed and deployed. The input is now properly sanitized."],
    ],
    state: { by: "tobias", isArchived: true },
  },
  {
    key: "designSystemV2",
    creator: "amina",
    participants: ["lucas", "margot"],
    title: "Design system v2",
    first: "Starting work on the design system v2. Let's discuss the component library.",
    lines: [
      ["lucas", "I think we should migrate to CSS modules."],
      ["margot", "What about keeping Tailwind but adding more design tokens?"],
      ["amina", "Good idea, Margot. Let's prototype both approaches."],
      ["lucas", "I'll take the CSS modules prototype."],
      ["margot", "I'll handle the design tokens approach."],
    ],
    state: { by: "lucas", isMuted: true },
  },
  {
    key: "vendorEval",
    creator: "lucas",
    participants: ["tobias", "margot"],
    title: "Vendor evaluation",
    first: "We need to pick a cloud provider for the new service.",
    lines: [
      ["tobias", "I've been looking at AWS and GCP. Both have pros and cons."],
      ["margot", "Let's create a comparison matrix by Friday."],
    ],
  },
  {
    key: "releaseChecklist",
    creator: "admin",
    participants: ["amina", "lucas", "tobias"],
    title: "Release checklist",
    first: "Release v2.1 is next Tuesday. Let's track the checklist here.",
    lines: [
      ["amina", "Feature freeze is confirmed for Friday."],
      ["lucas", "All critical bugs are fixed and verified."],
      ["tobias", "CI/CD pipeline is green. Staging deploy successful."],
      ["admin", "QA signoff needed by Monday."],
      ["amina", "I'll coordinate with the QA team."],
      ["lucas", "Release notes drafted: https://docs.example.com/release-v2.1"],
      ["tobias", "Rollback plan documented and tested."],
      ["admin", "Looking good. Let's do a final review Monday morning."],
      ["amina", "Monday 9am works for everyone?"],
      ["lucas", "Confirmed."],
    ],
  },
  {
    key: "weeklyStandup",
    creator: "admin",
    participants: ["amina", "lucas", "tobias", "margot"],
    title: "Weekly standup notes",
    first: "Monday standup! Share your updates for the week.",
    lines: [
      ["amina", "Working on the search refactor. Should be done by Wednesday."],
      ["lucas", "Finishing the API pagination overhaul."],
      ["tobias", "Setting up monitoring dashboards for the new services."],
      ["margot", "Onboarding the new contractor. Writing docs."],
      ["admin", "I'm in meetings most of the day. Will review PRs tonight."],
      ["amina", "Quick update: search refactor hit a snag with the index."],
      ["lucas", "Need Tobias's input on the cache invalidation strategy."],
      ["tobias", "Sure, let's sync after standup."],
      ["margot", "Docs are up: https://wiki.example.com/onboarding-v2"],
      ["admin", "Great progress everyone. Same time Wednesday."],
      ["amina", "Wednesday update: search refactor is merged!"],
      ["lucas", "Pagination is done. Moving to the export feature."],
      ["tobias", "Dashboards are live. Found a memory leak in the logger."],
      ["margot", "Contractor is ramping up nicely. Starting first task tomorrow."],
      ["admin", "Solid week. Let's keep the momentum into next sprint."],
    ],
    reactions: [
      { fromNewest: 11, by: "lucas", emoji: "🎉" },
      { fromNewest: 11, by: "tobias", emoji: "🎉" },
      { fromNewest: 11, by: "admin", emoji: "👏" },
    ],
  },
  {
    key: "untitledDesignChat",
    creator: "amina",
    participants: ["lucas", "margot"],
    first: "Hey, quick thought on the color palette — should we go warmer?",
    lines: [
      ["margot", "I like it. The current blues feel too cold."],
      ["lucas", "Let's try it. I'll update the Figma tokens."],
      ["amina", "Perfect, send me the link when ready."],
    ],
  },
  {
    key: "untitledOpsChat",
    creator: "tobias",
    participants: ["margot"],
    first: "Did you see the CPU spike on staging around 3am?",
    lines: [
      ["margot", "Yeah, looks like the cron job overlapped with the backup window."],
      ["tobias", "I'll offset the schedule by an hour. Should fix it."],
    ],
  },
  {
    key: "untitledAdminLucas",
    creator: "admin",
    participants: ["lucas"],
    first: "Lucas, are you free for a quick sync tomorrow?",
    lines: [
      ["lucas", "Sure, afternoon works best for me."],
      ["admin", "2pm it is."],
    ],
  },
  {
    key: "infraCostReview",
    creator: "lucas",
    participants: ["tobias", "margot"],
    title: "Infrastructure cost review",
    first: "Our cloud bill jumped 30% this month. Let's figure out what changed.",
    lines: [
      ["tobias", "The new staging environments are running 24/7. We should add auto-shutdown."],
      ["margot", "Also the log retention policy — we're storing 90 days but only need 30."],
      ["lucas", "Good catches. I'll draft a cost reduction plan."],
    ],
  },
]

// ── Agent app: skills, routines, agent chats ────────────────────────────────

/**
 * The world's shared role agent. A shared skill belongs to a role agent
 * (`skills.owner_agent_id`), so the org's shared skills are seen on its page.
 */
export const QA_ROLE_AGENT = { handle: "@support-desk", displayName: "Support Desk" } as const

export interface QaSkillSpec {
  name: string
  description: string
  body: string
  /**
   * `role`: shared, owned by {@link QA_ROLE_AGENT}; `org`: shared and unowned
   * (a role agent adopts it); else the author's own agent.
   */
  owner: "admin" | "org" | "role"
  agentAuthored?: boolean
}

export const QA_SKILLS: readonly QaSkillSpec[] = [
  {
    name: "draft-customer-reply",
    description: "Draft a friendly, on-brand reply to a customer message.",
    body: "# Draft customer reply\n\nWrite a concise, warm reply. Acknowledge the issue, state the next step, and give a timeline. Keep it under 120 words.",
    owner: "admin",
  },
  {
    name: "weekly-status-summary",
    description: "Summarise a thread into a crisp weekly status update.",
    body: "# Weekly status summary\n\nProduce three sections: Done, In progress, Blocked. One line each, no fluff.",
    owner: "admin",
  },
  {
    name: "triage-bug-report",
    description: "Classify a bug report by severity and suggest an owner.",
    body: "# Triage bug report\n\nAssign a severity (S1–S4), summarise the repro in one line, and propose the most likely owner.",
    owner: "role",
  },
  {
    name: "meeting-notes-cleanup",
    description: "Turn rough meeting notes into structured minutes.",
    body: "# Meeting notes cleanup\n\nExtract decisions, action items (with owners), and open questions. Drop chatter.",
    owner: "org",
  },
  {
    name: "competitor-research-brief",
    description: "Compile a short competitor research brief from web sources.",
    body: "# Competitor research brief\n\nGive a 5-bullet overview: positioning, pricing, strengths, weaknesses, recent moves.",
    owner: "admin",
    agentAuthored: true,
  },
  {
    name: "onboarding-checklist",
    description: "Generate a new-hire onboarding checklist for a role.",
    body: "# Onboarding checklist\n\nList accounts to create, docs to read, and intro meetings to book for the first week.",
    owner: "org",
    agentAuthored: true,
  },
]

export interface QaRoutineSpec {
  name: string
  description: string
  owner: "admin" | "amina" | "lucas"
  kind: "recurring" | "scheduled"
  cron?: string
  timezone?: string
  /** Days from `now` for a scheduled routine's run. */
  runAtDays?: number
  prompt: string
  visibility: "personal" | "shared"
  status?: "active" | "paused_user" | "completed"
}

export const QA_ROUTINES: readonly QaRoutineSpec[] = [
  {
    name: "daily-thread-digest",
    description: "Post a morning digest of overnight thread activity.",
    owner: "admin",
    kind: "recurring",
    cron: "0 8 * * 1-5",
    timezone: "America/Toronto",
    prompt:
      "Summarise yesterday's unread threads into a short digest and notify me with the result.",
    visibility: "personal",
  },
  {
    name: "weekly-pipeline-review",
    description: "Compile a weekly sales pipeline review for the team.",
    owner: "admin",
    kind: "recurring",
    cron: "0 9 * * 1",
    timezone: "America/Toronto",
    prompt: "Review the sales pipeline thread and post a one-page status update.",
    visibility: "shared",
  },
  {
    name: "end-of-day-wrapup",
    description: "Write an end-of-day wrap-up of completed work.",
    owner: "amina",
    kind: "recurring",
    cron: "0 17 * * 1-5",
    timezone: "UTC",
    prompt: "List what got done today and what is still open.",
    visibility: "shared",
  },
  {
    name: "confirm-tracking-number",
    description: "One-shot reminder to confirm a customer's tracking number.",
    owner: "admin",
    kind: "scheduled",
    runAtDays: 3,
    prompt: "Remind me to confirm the customer's shipment tracking number and notify me.",
    visibility: "personal",
  },
  {
    name: "quarterly-archive-cleanup",
    description: "Archive stale threads at the end of the quarter.",
    owner: "lucas",
    kind: "recurring",
    cron: "0 6 1 */3 *",
    timezone: "UTC",
    prompt: "Identify threads with no activity in 90 days and propose an archive list.",
    visibility: "personal",
    status: "paused_user",
  },
  {
    name: "send-launch-recap",
    description: "One-shot recap of the product launch — already delivered.",
    owner: "admin",
    kind: "scheduled",
    runAtDays: -1,
    prompt: "Write a short recap of the launch and notify me.",
    visibility: "personal",
    status: "completed",
  },
]

/** One past run per routine, in routine order (days ago = position + 1). */
export const QA_ROUTINE_RUNS: ReadonlyArray<{
  status: "succeeded" | "failed" | "skipped_no_credits" | "skipped_overlap"
}> = [
  { status: "succeeded" },
  { status: "succeeded" },
  { status: "succeeded" },
  { status: "failed" },
  { status: "skipped_no_credits" },
  { status: "skipped_overlap" },
]
export const QA_ROUTINE_RUN_ERROR = "ECONNREFUSED talking to mail provider — auto-retry tomorrow"

export interface QaChatSpec {
  title: string
  owner: "admin" | "amina" | "lucas"
  messages: Array<{ authorType: "user" | "agent"; content: string }>
}

export const QA_AGENT_CHATS: readonly QaChatSpec[] = [
  {
    title: "Getting started with Liaison",
    owner: "admin",
    messages: [
      { authorType: "user", content: "What can you help me with?" },
      {
        authorType: "agent",
        content:
          "I can search threads, look up contacts, research the web, and run skills and routines on your behalf. Ask me anything.",
      },
    ],
  },
  {
    title: "Release v2.1 status",
    owner: "admin",
    messages: [
      { authorType: "user", content: "What's the status of the v2.1 release?" },
      {
        authorType: "agent",
        content:
          "Feature freeze is confirmed, all critical bugs are fixed, and staging is green. QA signoff is the last item — expected Monday.",
      },
    ],
  },
  {
    title: "Draft a reply to the Acme escalation",
    owner: "admin",
    messages: [
      { authorType: "user", content: "Help me reply to the Acme escalation thread." },
      {
        authorType: "agent",
        content:
          "Here's a draft: acknowledge the delay, confirm the fix shipped to staging, and offer a 15-minute call Thursday. Want me to post it?",
      },
    ],
  },
  {
    title: "Research competitors in the CRM space",
    owner: "amina",
    messages: [
      { authorType: "user", content: "Give me a quick competitor scan for CRMs." },
      {
        authorType: "agent",
        content:
          "Top three by positioning: one leads on automation, one on price, one on integrations. I can expand any of them into a brief.",
      },
    ],
  },
  {
    title: "Summarise the sprint retro",
    owner: "amina",
    messages: [
      { authorType: "user", content: "Summarise the sprint retro thread." },
      {
        authorType: "agent",
        content:
          "Went well: faster reviews. Needs work: flaky CI. Action: Lucas to stabilise the test suite by next Friday.",
      },
    ],
  },
  {
    title: "Plan the onboarding for the new hire",
    owner: "lucas",
    messages: [
      { authorType: "user", content: "Build an onboarding plan for our new engineer." },
      {
        authorType: "agent",
        content:
          "Week one: accounts + repo access, read the architecture docs, and three intro meetings. I can turn this into a checklist skill.",
      },
    ],
  },
]

/** The agent's saved-memory line with a tool call, on the first agent chat. */
export const QA_TOOL_CALL_MESSAGE = {
  content: "I saved a memory about your tone preference.",
  metadata: {
    toolCalls: [
      {
        toolCallId: "qa-seed-tc-1",
        toolName: "kernel:user_memory_set",
        args: {
          type: "user",
          name: "tone",
          description: "Prefers terse responses",
          content: "Elodie wants short answers; no preamble.",
        },
        result: { saved: true },
      },
    ],
  },
}

// ── Agent memory ─────────────────────────────────────────────────────────────

export interface QaMemoryEntry {
  type: "user" | "feedback" | "project" | "reference"
  name: string
  description: string
  content: string
}

export const QA_MEMORY: ReadonlyArray<{
  owner: "admin" | "amina" | "lucas"
  entries: QaMemoryEntry[]
}> = [
  {
    owner: "admin",
    entries: [
      {
        type: "user",
        name: "role",
        description: "Senior platform eng on the reliability team",
        content:
          "Elodie is a senior platform engineer focused on reliability. Deep Go expertise, learning React. Prefers minimal abstractions; flags premature ones.",
      },
      {
        type: "feedback",
        name: "response-format",
        description: "Prefers terse responses; one or two sentences max",
        content:
          "User explicitly asked for shorter agent responses. Avoid bullet lists for trivial answers. Don't summarize what was just said.",
      },
      {
        type: "feedback",
        name: "use-testids",
        description: "Always use data-testid for element location",
        content:
          "Never locate elements by CSS class, DOM structure, or fragile selectors. Add a `data-testid` to the component first if one is missing.",
      },
      {
        type: "project",
        name: "q3-platform-launch",
        description: "Q3 platform launch coordinates with the [[role]] team",
        content:
          "Q3 launch is gated on the platform reliability work — [[role]] is the relevant memory. Some references are stale: [[missing-name]] no longer exists; broken-link rendering is the test.",
      },
      {
        type: "reference",
        name: "linear-platform",
        description: "Linear project PLATFORM is where reliability tickets live",
        content:
          "Linear: project key PLATFORM. Use `mcp:linear:search` with `team:platform` filter.",
      },
    ],
  },
  {
    owner: "amina",
    entries: [
      {
        type: "user",
        name: "role",
        description: "Frontend lead — owns the design system",
        content: "Amina owns the design system and drives Kobalte adoption.",
      },
      {
        type: "feedback",
        name: "no-emoji",
        description: "Never use emoji in code or comments",
        content: "Emoji-free output everywhere — code, comments, commit messages.",
      },
    ],
  },
  {
    owner: "lucas",
    entries: [
      {
        type: "user",
        name: "role",
        description: "Backend engineer — owns the ingest pipeline",
        content: "Lucas owns the outbox + event ingest pipeline.",
      },
      {
        type: "project",
        name: "ingest-throughput",
        description: "Q3 goal: 5x ingest throughput",
        content: "Goal: 5x the ingest throughput vs Q2 baseline.",
      },
    ],
  },
]

/** The always-on memory index line the product writes for an entry. */
export function qaMemoryIndex(entries: readonly QaMemoryEntry[]): string {
  return entries.map((e) => `- [${e.description}](${e.name}) — ${e.type}`).join("\n")
}

// ── Knowledge ────────────────────────────────────────────────────────────────

export type QaCollectionKey = "engineering" | "backend" | "sales"

export const QA_COLLECTIONS: ReadonlyArray<{
  key: QaCollectionKey
  name: string
  parent?: QaCollectionKey
}> = [
  { key: "engineering", name: "Engineering" },
  { key: "backend", name: "Backend", parent: "engineering" },
  { key: "sales", name: "Sales" },
]

export interface QaDocSpec {
  title: string
  body: string
  documentScope: "personal" | "organization"
  sensitivity?: "public" | "internal" | "confidential" | "restricted"
  collections: QaCollectionKey[]
  reviewStatus?: "verified" | "needs_review" | "stale"
}

export const QA_DOCUMENTS: readonly QaDocSpec[] = [
  {
    title: "Q3 OKRs",
    body: "Improve onboarding NPS by 10 pts; ship two new connectors; reach 80% test coverage.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: ["engineering"],
    reviewStatus: "needs_review",
  },
  {
    title: "Platform Reliability Playbook",
    body: "Incident response runbook for the platform team.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: ["backend"],
    reviewStatus: "verified",
  },
  {
    title: "API Style Guide",
    body: "Conventions for new HTTP endpoints — naming, error envelope, pagination.",
    documentScope: "organization",
    sensitivity: "public",
    collections: ["engineering", "backend"],
    reviewStatus: "verified",
  },
  {
    title: "Sales Deck v3",
    body: "Latest sales pitch deck with talk-track notes.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: ["sales"],
    reviewStatus: "stale",
  },
  {
    title: "Onboarding Runbook",
    body: "How to onboard a new engineering hire.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: ["engineering"],
  },
  {
    title: "Kestrel 6 32-bit Float — Gain Staging & Per-Channel Limiter in Reaper",
    body:
      "Configuring 32-bit float gain staging and the per-channel limiter for the Kestrel 6 in Reaper.\n\n" +
      "1. Match the bit depth. The Kestrel 6 records 32-bit float WAV at up to 192 kHz. In Reaper, " +
      "set the project and render format to 32-bit float so quiet takes can be normalised without " +
      "clipping. A mismatch (Reaper left at the default 24-bit) is the usual cause of takes that " +
      "'clip on import'.\n\n" +
      "2. Per-channel limiter / safety track. The Kestrel 6 records a safety track 12 dB below each " +
      "input and applies its limiter per channel. In Reaper, import the safety track as a take lane " +
      "under its main channel so a clipped peak can be swapped for the safety take on that channel " +
      "alone.\n\n" +
      "3. Verify. Record a short loud clap on one input — only that channel should hit the limiter, " +
      "and its safety track should stay clean. If every channel limits together, the inputs are " +
      "linked as a stereo pair; unlink them on the Kestrel 6 and re-import in Reaper.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: [],
    reviewStatus: "verified",
  },
  {
    title: "Kestrel 6 line out over 3.5mm TRS — balanced vs unbalanced (which cable we ship)",
    body:
      "Connecting the Kestrel 6's line out to a camera or mixer over a 3.5mm TRS jack.\n\n" +
      "1. We ship unbalanced stereo. The Kestrel 6's line-out jack and the bundled Kestrel XLR Cable " +
      "Set (RAL-ACC-CABLE) use **unbalanced stereo TRS** wiring (tip = left, ring = right, " +
      "sleeve = ground). This matches the mic input of most cameras.\n\n" +
      "2. The usual failure: a balanced mono cable. If the camera records nothing or a thin, phasey " +
      "signal, the customer almost always has a **balanced mono TRS** cable (ring carries the " +
      "inverted signal). Feeding that into a stereo input cancels the audio when the camera sums " +
      "to mono.\n\n" +
      "3. The fix. Use the stereo TRS cable from the Kestrel XLR Cable Set, OR a TRS-to-dual-TS " +
      "breakout if they must keep their own cable. Do NOT recommend cutting/rewiring. Confirm the " +
      "camera's own input expectation (mic level vs line level) before the first take.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: [],
    reviewStatus: "verified",
  },
  {
    title: "Kestrel 6 won't boot after a v2.4 firmware update — factory-reset recovery",
    body:
      "If a Kestrel 6 is unresponsive / stuck on the boot screen after a v2.4 firmware update, recover it " +
      "with the factory-reset bootloader sequence (no hardware return needed):\n\n" +
      "1. Fully power down. Unplug USB, remove the batteries for 30 seconds.\n" +
      "2. Enter recovery (bootloader) mode. Hold the MENU + REC buttons together, then " +
      "reconnect USB while still holding. The status LED pulses amber = recovery mode (release the " +
      "buttons once it pulses).\n" +
      "3. Re-flash v2.4 from the utility. Open Kestrel Utility → Firmware → 'Recover / Re-flash', " +
      "select v2.4, and let it complete WITHOUT disconnecting (≈90s). A mid-flash disconnect is the " +
      "usual cause of the original brick.\n" +
      "4. Factory reset after re-flash. On the device, hold MENU for 5s → 'Reset all' to clear the " +
      "corrupted settings the failed update left behind.\n" +
      "5. Verify. The device should boot to the home meter screen and report v2.4 in the utility. If it " +
      "still won't enter recovery mode, THEN it's a hardware RMA — escalate.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: [],
    reviewStatus: "verified",
  },
  {
    title:
      "Kestrel 6 Bluetooth remote (Kestrel Control app) — pairing & 'not connecting' troubleshooting",
    body:
      "The Kestrel 6 is remote-controlled over Bluetooth LE from the Kestrel Control app. 'It won't " +
      "connect' is almost always an app-level pairing step that was skipped, not a fault.\n\n" +
      "1. Put the Kestrel 6 in pairing mode. Hold MENU + the BLUETOOTH key until the status LED " +
      "pulses blue. The device now advertises as 'Kestrel 6' over Bluetooth LE.\n\n" +
      "2. Connect inside the Kestrel Control app FIRST (this is the missed step). iOS/iPadOS and " +
      "Android: open Kestrel Control → Devices → connect 'Kestrel 6' — not the system Bluetooth " +
      "screen, which pairs it as a headset and blocks the app. Desktop has no remote app, so use " +
      "the USB connection instead.\n\n" +
      "3. Arm the remote. Only after the app shows 'Kestrel 6' connected will the transport and " +
      "meter controls appear — enable remote control there.\n\n" +
      "4. If it pairs but drops or won't appear: 2.4GHz Wi-Fi/wireless-mic interference is the usual " +
      "cause — move away from the receiver, forget + re-pair (MENU + BLUETOOTH again). A system-level " +
      "Bluetooth pairing does NOT work; it must be paired from the app. USB control always works as a fallback.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: [],
    reviewStatus: "verified",
  },
  {
    title: "Shipping exception — Mondial Relay pickup expired (point relais non retiré)",
    body:
      "When a Mondial Relay parcel is not collected within the hold window at the Point Relais " +
      "(typically 8 calendar days), the pickup EXPIRES and the parcel is automatically returned " +
      "toward us — it cannot be 're-held' at the same point.\n\n" +
      "1. Confirm the status. In the carrier tracking the parcel shows 'retour expéditeur' / pickup " +
      "expired. Tell the customer the original pickup can no longer be collected.\n\n" +
      "2. Offer a re-ship. Once the parcel is back with us (or immediately, with a fresh label) we " +
      "re-ship at no charge to: (a) a NEW Mondial Relay point of their choice, or (b) their home " +
      "address (Colissimo). Ask the customer to reply with the preferred new Point Relais ID or a " +
      "full home address.\n\n" +
      "3. Set expectations. Do NOT promise same-parcel re-delivery to the expired point. Re-ship ETA " +
      "is 3–5 business days from when we generate the new label. Note the ticket as awaiting the " +
      "customer's new address before re-labelling.",
    documentScope: "organization",
    sensitivity: "internal",
    collections: [],
    reviewStatus: "verified",
  },
  {
    title: "My Reading List",
    body: "Notes on books and papers to revisit.",
    documentScope: "personal",
    collections: [],
  },
  {
    title: "Weekly Standup Notes",
    body: "Personal notes from team standups.",
    documentScope: "personal",
    collections: [],
  },
  {
    title: "Q3 Personal Goals",
    body: "Personal Q3 goals — learn React deep dive, ship 3 KCs.",
    documentScope: "personal",
    collections: [],
  },
]

// ── Tickets ──────────────────────────────────────────────────────────────────

export const QA_TICKET_INBOXES: ReadonlyArray<{
  key: "support" | "sales" | "personal"
  name: string
  /** `null`: the admin's personal address, `elodie.personal+<id8>@resonantaudiolabs.example`. */
  email: string | null
}> = [
  { key: "support", name: "Support", email: "support@resonantaudiolabs.example" },
  { key: "sales", name: "Sales", email: "sales@resonantaudiolabs.example" },
  { key: "personal", name: "Elodie Personal", email: null },
]

export const QA_TICKET_CATEGORIES = ["Bug", "Feature Request", "Billing", "Onboarding", "Outage"]
export const QA_TICKET_STATUSES = [
  "open",
  "awaiting_customer",
  "awaiting_followup",
  "closed",
] as const
/** Twelve tickets: four to Amina, three to Lucas, five unassigned. */
export const QA_TICKET_ASSIGNEES: ReadonlyArray<"amina" | "lucas" | null> = [
  "amina",
  "amina",
  "amina",
  "amina",
  "lucas",
  "lucas",
  "lucas",
  null,
  null,
  null,
  null,
  null,
]

// ── Attention, approvals, saved views ────────────────────────────────────────

export interface QaAttentionSpec {
  app: string
  entityType: string
  entityId: string
  kind: string
  urgency: number
  summary: string
  /** `user`: Amina acted. */
  actorType: "user" | "agent" | "system"
  read: boolean
}

/** Elodie's home feed, across every source app. */
export const QA_ATTENTION: readonly QaAttentionSpec[] = [
  {
    app: "kernel",
    entityType: "thread",
    entityId: "qa-seed-mention-thread",
    kind: "mention",
    urgency: 2,
    summary: "Amina mentioned you in #q2-marketing",
    actorType: "user",
    read: false,
  },
  {
    app: "kernel",
    entityType: "approval_request",
    entityId: "qa-seed-approval-1",
    kind: "approval_request",
    urgency: 3,
    summary: "Approval requested for mail send: 'Q3 launch announcement'",
    actorType: "agent",
    read: false,
  },
  {
    app: "kernel",
    entityType: "routine",
    entityId: "qa-seed-routine-1",
    kind: "agent_notification",
    urgency: 1,
    summary: "Routine 'Morning Summary' completed with 3 highlights",
    actorType: "agent",
    read: false,
  },
  {
    app: "tickets",
    entityType: "ticket",
    entityId: "qa-seed-ticket-assigned",
    kind: "ticket_assigned",
    urgency: 2,
    summary: "Ticket 'Login broken on mobile' assigned to you",
    actorType: "user",
    read: false,
  },
  {
    app: "knowledge",
    entityType: "document",
    entityId: "qa-seed-doc-needs-review",
    kind: "review_due",
    urgency: 1,
    summary: "Document 'Q3 OKRs' is overdue for review",
    actorType: "system",
    read: true,
  },
  {
    app: "projects",
    entityType: "task",
    entityId: "qa-seed-task-assigned",
    kind: "task_assigned",
    urgency: 2,
    summary: "Task 'Audit RLS policies' assigned to you by Amina",
    actorType: "user",
    read: false,
  },
]

export interface QaApprovalSpec {
  handle: string
  toolName: string
  payload: Record<string, unknown>
  /** Who is asked: Elodie, plus Lucas where named. */
  notify: Array<"admin" | "lucas">
  /** Hours from `now` the request expires (negative: already expired). */
  expiresInHours: number
  /** Hours before `now` it was made. */
  createdHoursAgo: number
  status: "pending" | "approved" | "denied"
  decided?: { by: "admin" | "lucas"; hoursAgo: number; reason?: string }
  /** The request came from another thread than the one it is shown in. */
  crossThread?: boolean
  /** Position in the compound bundle (0 is its head). */
  bundlePosition?: number
  metadata?: Record<string, unknown>
}

/** Every resting state: pending, approved, denied, expired, cross-thread, a three-step bundle. */
export const QA_APPROVALS: readonly QaApprovalSpec[] = [
  {
    handle: "qa-approval-pending",
    toolName: "mail:reply",
    payload: { subject: "Q3 launch announcement", body: "Pre-launch draft." },
    notify: ["admin", "lucas"],
    expiresInHours: 1,
    createdHoursAgo: 0,
    status: "pending",
  },
  {
    handle: "qa-approval-approved",
    toolName: "tickets:reply",
    payload: { ticketId: "qa-ticket-1", body: "We resolved the issue." },
    notify: ["admin"],
    expiresInHours: 1,
    createdHoursAgo: 3,
    status: "approved",
    decided: { by: "admin", hoursAgo: 2 },
  },
  {
    handle: "qa-approval-denied",
    toolName: "mail:reply",
    payload: { subject: "Discount offer", body: "Limited-time 30% off." },
    notify: ["lucas"],
    expiresInHours: 1,
    createdHoursAgo: 5,
    status: "denied",
    decided: { by: "lucas", hoursAgo: 4, reason: "scope mismatch — needs sales approval" },
  },
  {
    handle: "qa-approval-expired",
    toolName: "tickets:reply",
    payload: { ticketId: "qa-ticket-old", body: "Stale ticket reply." },
    notify: ["admin"],
    expiresInHours: -1,
    createdHoursAgo: 2,
    status: "pending",
  },
  {
    handle: "qa-approval-cross-thread",
    toolName: "mail:reply",
    payload: { subject: "Cross-thread approval", body: "Sent from a separate thread." },
    notify: ["admin", "lucas"],
    expiresInHours: 1,
    createdHoursAgo: 0,
    status: "pending",
    crossThread: true,
    metadata: { crossThread: true },
  },
  {
    handle: "qa-approval-bundle-head",
    toolName: "mail:reply",
    payload: { subject: "Bundle step 1: send announcement", body: "Step 1." },
    notify: ["admin"],
    expiresInHours: 1,
    createdHoursAgo: 0,
    status: "pending",
    bundlePosition: 0,
  },
  {
    handle: "qa-approval-bundle-step-1",
    toolName: "tickets:reply",
    payload: { ticketId: "qa-ticket-2", body: "Step 2: close associated ticket." },
    notify: ["admin"],
    expiresInHours: 1,
    createdHoursAgo: 0,
    status: "pending",
    bundlePosition: 1,
  },
  {
    handle: "qa-approval-bundle-step-2",
    toolName: "knowledge_create",
    payload: { title: "Launch recap", body: "Step 3: record knowledge entry." },
    notify: ["admin"],
    expiresInHours: 1,
    createdHoursAgo: 0,
    status: "pending",
    bundlePosition: 2,
  },
]

export const QA_SAVED_VIEWS: ReadonlyArray<{
  viewId: string
  name: string
  owner: "admin" | "amina" | "lucas"
  sharedWithOrg: boolean
  /** `assignedToOwner`: the filter names the owner as the assignee. */
  filters: Record<string, unknown> & { assignedToOwner?: true }
}> = [
  {
    viewId: "qa-my-open",
    name: "My Open Tickets",
    owner: "admin",
    sharedWithOrg: false,
    filters: { status: ["open", "awaiting_followup"], assignedToOwner: true },
  },
  {
    viewId: "qa-team-backlog",
    name: "Team Backlog",
    owner: "amina",
    sharedWithOrg: true,
    filters: { status: ["open", "awaiting_followup", "awaiting_customer"] },
  },
  {
    viewId: "qa-closed-30d",
    name: "Closed Last 30d",
    owner: "lucas",
    sharedWithOrg: false,
    filters: { status: ["closed"], closed_within_days: 30 },
  },
]

// ── Mail ─────────────────────────────────────────────────────────────────────

export type QaMailboxKey = "orgImap" | "adminGmail" | "aminaPersonal"

export interface QaMailboxSpec {
  key: QaMailboxKey
  /** `org`: an org-shared mailbox; else the person who owns it. */
  owner: "org" | "admin" | "amina"
  connection: "imap" | "gmail"
  email: string
  connectionDisplayName: string
  displayName: string
  /** A stand-in refresh token, so the encrypted-secret columns are filled. */
  refreshToken: string | null
}

export const QA_MAILBOXES: readonly QaMailboxSpec[] = [
  {
    key: "orgImap",
    owner: "org",
    connection: "imap",
    email: "support@resonantaudiolabs.example",
    connectionDisplayName: "Org Support (IMAP)",
    displayName: "Org Support",
    refreshToken: "qa-dev-imap-placeholder",
  },
  {
    key: "adminGmail",
    owner: "admin",
    connection: "gmail",
    email: "elodie@gmail.test",
    connectionDisplayName: "Elodie's Gmail",
    displayName: "Elodie's Gmail",
    refreshToken: null,
  },
  {
    key: "aminaPersonal",
    owner: "amina",
    connection: "imap",
    email: "amina@personal.example",
    connectionDisplayName: "Amina's Personal IMAP",
    displayName: "Amina's Personal IMAP",
    refreshToken: "qa-dev-amina-imap-placeholder",
  },
]

export interface QaMailAddress {
  name: string
  email: string
}

export interface QaMailConversationSpec {
  externalThreadId: string
  mailbox: QaMailboxKey
  subject: string
  snippet: string
  status: "open" | "trashed" | "escalated"
  isRead: boolean
  isStarred: boolean
  labels: string[]
  messages: Array<{
    direction: "inbound" | "outbound"
    from: QaMailAddress
    to: QaMailAddress[]
    subject: string
    textBody: string
    hoursAgo: number
  }>
}

const SUPPORT: QaMailAddress = { name: "Support", email: "support@resonantaudiolabs.example" }

export const QA_MAIL_CONVERSATIONS: readonly QaMailConversationSpec[] = [
  {
    externalThreadId: "qa-conv-1",
    mailbox: "orgImap",
    subject: "Q3 launch — outstanding items",
    snippet: "Here are the open items for the Q3 launch...",
    status: "open",
    isRead: false,
    isStarred: true,
    labels: ["Inbox", "Important"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Hans Weber", email: "hans@acme.de" },
        to: [SUPPORT],
        subject: "Q3 launch — outstanding items",
        textBody: "Hi team, here are the items still open for Q3...",
        hoursAgo: 36,
      },
      {
        direction: "outbound",
        from: { name: "Elodie", email: "support@resonantaudiolabs.example" },
        to: [{ name: "Hans Weber", email: "hans@acme.de" }],
        subject: "Re: Q3 launch — outstanding items",
        textBody: "Thanks Hans — I'll get back with a status sweep by EOD.",
        hoursAgo: 30,
      },
      {
        direction: "inbound",
        from: { name: "Hans Weber", email: "hans@acme.de" },
        to: [SUPPORT],
        subject: "Re: Q3 launch — outstanding items",
        textBody: "Perfect, looking forward.",
        hoursAgo: 28,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-2",
    mailbox: "adminGmail",
    subject: "Welcome to Acme",
    snippet: "Hi Elodie, welcome to Acme...",
    status: "open",
    isRead: true,
    isStarred: false,
    labels: ["Inbox"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Acme Onboarding", email: "onboarding@acme.de" },
        to: [{ name: "Elodie", email: "elodie@gmail.test" }],
        subject: "Welcome to Acme",
        textBody: "Hi Elodie, welcome aboard. Here are your first-day links.",
        hoursAgo: 72,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-3",
    mailbox: "aminaPersonal",
    subject: "Conference invite",
    snippet: "Would you like to speak at...",
    status: "open",
    isRead: false,
    isStarred: false,
    labels: ["Inbox"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Conf Organizer", email: "speakers@confdays.example" },
        to: [{ name: "Amina", email: "amina@personal.example" }],
        subject: "Conference invite",
        textBody: "Would you like to speak at our Q4 conference?",
        hoursAgo: 12,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-4",
    mailbox: "orgImap",
    subject: "Billing question",
    snippet: "We were charged twice for...",
    status: "open",
    isRead: false,
    isStarred: false,
    labels: ["Inbox", "Customer"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Sofia Rossi", email: "sofia.rossi@studio.test" },
        to: [SUPPORT],
        subject: "Billing question",
        textBody: "We were charged twice for September — can you check?",
        hoursAgo: 4,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-5",
    mailbox: "orgImap",
    subject: "API integration help",
    snippet: "We're stuck on the webhook signature...",
    status: "open",
    isRead: true,
    isStarred: false,
    labels: ["Inbox"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Dev User", email: "dev@partner.example" },
        to: [SUPPORT],
        subject: "API integration help",
        textBody: "We're stuck on the webhook signature verification.",
        hoursAgo: 8,
      },
      {
        direction: "outbound",
        from: { name: "Lucas", email: "support@resonantaudiolabs.example" },
        to: [{ name: "Dev User", email: "dev@partner.example" }],
        subject: "Re: API integration help",
        textBody: "Quick reply: use HMAC-SHA256 with your signing key.",
        hoursAgo: 7,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-6",
    mailbox: "adminGmail",
    subject: "Newsletter — Q3 Engineering Digest",
    snippet: "Top picks from the engineering blog...",
    status: "open",
    isRead: true,
    isStarred: true,
    labels: ["Inbox", "Newsletters"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Engineering Weekly", email: "news@engweekly.example" },
        to: [{ name: "Elodie", email: "elodie@gmail.test" }],
        subject: "Q3 Engineering Digest",
        textBody: "Top picks from the engineering blog this quarter.",
        hoursAgo: 48,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-7",
    mailbox: "orgImap",
    subject: "Spam? — limited-time offer",
    snippet: "URGENT — claim your prize...",
    status: "trashed",
    isRead: true,
    isStarred: false,
    labels: ["Spam"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Spam Sender", email: "spam@spammer.example" },
        to: [SUPPORT],
        subject: "URGENT — claim your prize",
        textBody: "URGENT — claim your prize now! Limited time only.",
        hoursAgo: 24,
      },
    ],
  },
  {
    externalThreadId: "qa-conv-8",
    mailbox: "orgImap",
    subject: "Escalation — production outage",
    snippet: "We had a production outage on...",
    status: "escalated",
    isRead: true,
    isStarred: true,
    labels: ["Inbox", "Important", "Customer"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Customer Ops", email: "ops@customer.example" },
        to: [SUPPORT],
        subject: "Escalation — production outage",
        textBody: "We had a production outage at 14:30 UTC; need root cause ASAP.",
        hoursAgo: 16,
      },
    ],
  },
]

/** Connector rows with no credentials, so the integrations page lists them. */
export const QA_CONNECTOR_PLACEHOLDERS: ReadonlyArray<{
  app: string
  identifier: string
  displayName: string
}> = [
  { app: "slack", identifier: "qa-dev-slack-workspace", displayName: "QA Dev Slack Workspace" },
  { app: "github", identifier: "qa-dev-github-org", displayName: "QA Dev GitHub Org" },
]

/** Margot reads the product in French. */
export const QA_LOCALES: ReadonlyArray<{ key: QaPersonKey; locale: string }> = [
  { key: "margot", locale: "fr-FR" },
]

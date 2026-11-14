// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lively tier's activity, as a plan: fourteen days of a ten-person desk at
// work, written as offsets in hours before the tier's `now`. Pure and
// deterministic: one fixed seed drives every choice, so the same inputs give
// the same plan (and the same rows) on every run, and nothing here reads a
// clock or a random source.
//
// The window is [ACTIVITY_MIN_HOURS, ACTIVITY_DAYS days): the oldest entry is
// a little under fourteen days back and the newest a few minutes ago, so every
// screen reads as busy this week and still busy right now.

import type { DemoRole } from "~/seed/world/fiction"

export const ACTIVITY_DAYS = 14
/** The newest activity is this many hours before `now` (a few minutes). */
export const ACTIVITY_MIN_HOURS = 0.08
const WINDOW_HOURS = ACTIVITY_DAYS * 24 - 2

/** mulberry32: a small, well-mixed 32-bit generator. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PlanPerson {
  key: string
  role: DemoRole
}

export interface PlanInput {
  people: readonly PlanPerson[]
  /** Customer contact keys (`customer:<key>` / `dealer:<key>`) a ticket can come from. */
  contactKeys: readonly string[]
  /** Product titles the conversations are about. */
  products: readonly string[]
  /** Routine names, with how often each runs. */
  routines: ReadonlyArray<{ name: string; cadence: "daily" | "weekly" | "event" }>
  /** Sub agent role names a turn can hand work to. */
  subAgentTypes: readonly string[]
  /** Role agent handles that speak in channels. */
  roleAgents: readonly string[]
  /** The tier's `now` as a UTC hour of the day (0-24), so activity lands in working hours. */
  nowHourUtc?: number
}

export interface PlannedChannel {
  key: string
  title: string
  topic: string
  creator: string
}

export interface PlannedMessage {
  key: string
  /** Channel key, or `dm:<person>` for a person's chat with their own agent. */
  room: string
  /** Person key, or an agent handle (`@support`), or `agent` for the person's own agent. */
  author: string
  body: string
  hoursAgo: number
}

export interface PlannedTicket {
  key: string
  subject: string
  body: string
  contactKey: string
  category: string
  team: "support" | "operations" | "sales" | "finance"
  priority: "low" | "normal" | "high" | "urgent"
  status: "open" | "awaiting_customer" | "closed"
  assignee: string | null
  createdHoursAgo: number
  /** Hours after creation, in order. */
  replies: Array<{ kind: "outbound" | "inbound" | "note"; hoursAfter: number; body: string }>
}

export interface PlannedRoutineRun {
  key: string
  routine: string
  hoursAgo: number
  durationMs: number
  status: "succeeded" | "failed"
  trigger: "schedule" | "event"
}

export interface PlannedSubRun {
  key: string
  person: string
  subagentType: string
  prompt: string
  summary: string
  hoursAgo: number
  durationMs: number
  failed: boolean
}

export interface PlannedAttention {
  key: string
  person: string
  kind: "mention" | "thread_reply" | "agent_notification"
  /** Channel key for a thread kind, ticket key for a notification. */
  target: string
  actor: string
  summary: string
  hoursAgo: number
  read: boolean
}

export interface ActivityPlan {
  channels: PlannedChannel[]
  messages: PlannedMessage[]
  tickets: PlannedTicket[]
  routineRuns: PlannedRoutineRun[]
  subRuns: PlannedSubRun[]
  attention: PlannedAttention[]
}

const CHANNELS: Array<Omit<PlannedChannel, "creator"> & { creatorRole: PlanPerson["role"] }> = [
  {
    key: "desk",
    title: "Desk daily",
    topic: "What landed overnight, who takes what",
    creatorRole: "ops_lead",
  },
  {
    key: "dealers",
    title: "Dealer orders",
    topic: "Orders, quotes and stock for the dealer network",
    creatorRole: "sales",
  },
  {
    key: "returns",
    title: "Returns and repairs",
    topic: "RMAs, refurbished stock and repair turnaround",
    creatorRole: "fulfillment",
  },
  {
    key: "money",
    title: "Invoices and payments",
    topic: "Who paid, who is late, what goes out today",
    creatorRole: "finance",
  },
  {
    key: "firmware",
    title: "Firmware 3.2 rollout",
    topic: "Field reports on the 3.2 update",
    creatorRole: "support",
  },
]

const CHANNEL_LINES: Record<string, string[]> = {
  desk: [
    "Overnight queue is {n} tickets, mostly shipping questions. I'll take the first half.",
    "Two {p} units reported a hiss on input 3; tagging them for the hardware review.",
    "Can someone cover the dealer line between 2 and 4? I'm on the carrier call.",
    "Backlog is under ten for the first time this week.",
    "The {p} FAQ answer is outdated, I'm rewriting it before the next batch of tickets.",
    "Morning digest is out. Three tickets past their first response target.",
    "Handing the German tickets to Lucas while Amina is at the trade show.",
  ],
  dealers: [
    "Klangwerk wants 20 more {p} before the end of the month.",
    "Quote for the education bundle sent, waiting on their purchase order.",
    "Northfield asked whether the {p} price change applies to open orders. It does not.",
    "Restock of {p} lands Thursday, I told the dealers who were waiting.",
    "Atelier Sonore is asking for demo units for their store event.",
  ],
  returns: [
    "RMA for a {p} with a dead display, replacement goes out today.",
    "Three refurbished {p} units passed testing and are back in stock.",
    "Carrier lost a return parcel, claim is filed.",
    "Repair turnaround is at four days this week.",
  ],
  money: [
    "Dealer invoices for this week are issued.",
    "Westcoast paid the two overdue invoices, reminder cancelled.",
    "Credit note for the damaged {p} shipment is drafted, needs a second look.",
    "VAT check on the new Dutch dealer came back valid.",
    "Month end file is half done, waiting on the shipping costs.",
  ],
  firmware: [
    "3.2 fixes the timecode drift on the {p}, two customers confirmed.",
    "One report of the update stalling at 80 percent; asked for the log file.",
    "Release notes for 3.2 are in the knowledge base now.",
    "The {p} needs a power cycle after the update, adding it to the article.",
  ],
}

const AGENT_LINES = [
  "Summary: {n} new tickets since yesterday, two about the {p}. Drafts are ready for review.",
  "I matched the payment to its invoice and marked it paid.",
  "Three shipments are past their delivery estimate; I opened a claim draft for the oldest.",
  "The {p} article was viewed 40 times this week; two tickets were closed with it.",
]

const DM_ASKS = [
  "What is waiting on me today?",
  "Summarise the open {p} tickets.",
  "Draft a reply to the dealer asking about the {p} restock.",
  "Which invoices are overdue this week?",
  "Find the article about resetting the {p}.",
  "What did the routine find this morning?",
]

const DM_ANSWERS = [
  "You have {n} tickets assigned and one approval waiting. The oldest ticket is a {p} return.",
  "There are {n} open {p} tickets; most are about the firmware update and two are hardware faults.",
  "Here is a draft: the {p} restock lands Thursday and your order ships the same day.",
  "{n} invoices are overdue, the largest from a dealer in the Netherlands.",
  "The reset article is in Support playbooks, under Getting started.",
  "The morning triage closed {n} duplicates and flagged one urgent ticket.",
]

const TICKET_SUBJECTS: Array<{
  subject: string
  category: string
  team: PlannedTicket["team"]
  body: string
  /** The desk's answer, the customer's next message and an internal note, for this kind of ticket. */
  reply: string
  inbound: string
  note: string
}> = [
  {
    subject: "{p} not powering on after the update",
    category: "Firmware and software",
    team: "support",
    body: "Hello, since installing the latest update my {p} does not power on. The LED blinks twice and stops. What should I do?",
    reply:
      "Please hold the power button for ten seconds, then reinstall firmware 3.2.1 from the support page. Steps are attached.",
    inbound: "That did it, it boots again. Thank you!",
    note: "Third power-on report after 3.2; linking to the firmware thread.",
  },
  {
    subject: "Where is my {p} order?",
    category: "Shipping and delivery",
    team: "operations",
    body: "I ordered a {p} last week and the tracking has not moved for three days. Can you check?",
    reply:
      "I have checked with the carrier: the parcel was held at the Lyon hub and is moving again. Expected tomorrow.",
    inbound: "It arrived this morning, thanks.",
    note: "Carrier backlog at the Lyon hub, same as the other two this week.",
  },
  {
    subject: "Invoice copy for {p} purchase",
    category: "Billing and VAT",
    team: "finance",
    body: "Could you send me a copy of the invoice for my {p} with our VAT number on it?",
    reply: "Here is the invoice again, now with your VAT number on it.",
    inbound: "Received, thank you.",
    note: "VAT number checked in VIES: valid.",
  },
  {
    subject: "Crackle on input 2 of the {p}",
    category: "Hardware fault",
    team: "support",
    body: "There is a crackle on input 2 when I move the cable. Inputs 1 and 3 are fine.",
    reply:
      "Thanks for the detail. Could you send a photo of the serial number label? We will swap the unit if it is the input board.",
    inbound: "Here is the photo of the label.",
    note: "Second unit with this input fault this month, flagging for hardware.",
  },
  {
    subject: "Return request for {p}",
    category: "Returns and warranty",
    team: "operations",
    body: "The {p} is not what we need for our studio. Can we return it within the 30 days?",
    reply:
      "Yes, you are within the 30 days. Here is your return label; the refund goes out when the unit is back.",
    inbound: "Parcel dropped off today.",
    note: "Return label sent, refund on receipt.",
  },
  {
    subject: "Volume pricing for 15 {p}",
    category: "Dealer and pricing",
    team: "sales",
    body: "We are a school and would like 15 units of the {p}. Do you offer education pricing?",
    reply:
      "Thank you for thinking of us. The education tier applies from 10 units; the quote is attached.",
    inbound: "We will raise the purchase order next week.",
    note: "Education account, eligible for the 12 percent tier.",
  },
  {
    subject: "How do I set up timecode on the {p}?",
    category: "Getting started",
    team: "support",
    body: "I cannot find where to set the timecode frame rate on the {p}. Is there a guide?",
    reply:
      "It is under Settings, Timecode, Frame rate. The getting started article walks through it step by step.",
    inbound: "Found it, thanks.",
    note: "Good candidate for the FAQ, third time this month.",
  },
  {
    subject: "Damaged box on delivery ({p})",
    category: "Shipping and delivery",
    team: "operations",
    body: "The {p} arrived with a crushed box. The unit seems fine but I wanted you to know.",
    reply:
      "Sorry about the box. Since the unit works we will not ask for it back; a carrier claim is open on our side.",
    inbound: "Thanks for the quick answer.",
    note: "Carrier claim filed with photos.",
  },
]

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length] as T
}

function fill(template: string, rand: () => number, products: readonly string[]): string {
  return template
    .replaceAll("{p}", pick(rand, products))
    .replaceAll("{n}", String(2 + Math.floor(rand() * 9)))
}

/**
 * An instant in the desk's working hours (07:00-17:30 UTC, the Paris desk's
 * 08:00-18:30 in winter) on the day `daysAgo` back, as hours before `now`.
 * Today's hours still ahead of `now` fall in the last hour instead.
 */
function workHour(rand: () => number, daysAgo: number, nowHourUtc: number): number {
  const target = 7 + rand() * 10.5
  let h = daysAgo * 24 + (nowHourUtc - target)
  if (h < ACTIVITY_MIN_HOURS) h = ACTIVITY_MIN_HOURS + rand() * 0.9
  return Math.min(WINDOW_HOURS, h)
}

const round = (h: number) => Math.round(h * 100) / 100

export function planActivity(input: PlanInput, seed = 0x5eed14): ActivityPlan {
  const rand = seededRandom(seed)
  const nowH = input.nowHourUtc ?? 12
  const atWork = (daysAgo: number) => workHour(rand, daysAgo, nowH)
  const people = input.people
  const byRole = (role: PlanPerson["role"]) => people.filter((p) => p.role === role)
  const anyOf = (role: PlanPerson["role"]) => (byRole(role)[0] ?? people[0])?.key as string
  const supportDesk = people.filter((p) => p.role === "support" || p.role === "ops_lead")

  const channels: PlannedChannel[] = CHANNELS.map(({ creatorRole, ...c }) => ({
    ...c,
    creator: anyOf(creatorRole),
  }))

  // ── Channel messages: 5 to 8 a day across the rooms ─────────────────────
  const messages: PlannedMessage[] = []
  // A room never repeats the line it heard last, nor the speaker.
  const lastLine = new Map<string, string>()
  const lastAuthor = new Map<string, string>()
  const fresh = (room: string, lines: readonly string[]): string => {
    let line = pick(rand, lines)
    for (let k = 0; k < 4 && line === lastLine.get(room); k++) line = pick(rand, lines)
    lastLine.set(room, line)
    return line
  }
  for (let day = ACTIVITY_DAYS - 1; day >= 0; day--) {
    const count = 5 + Math.floor(rand() * 4)
    // The day's slots first, then the words in time order, so "the line a
    // room heard last" is the one before it on the screen.
    const slots = Array.from({ length: count }, (_, i) => ({
      i,
      channel: pick(rand, channels),
      agentTurn: rand() < 0.15 && input.roleAgents.length > 0,
      hoursAgo: round(day === 0 && i === 0 ? ACTIVITY_MIN_HOURS : atWork(day)),
    })).sort((x, y) => y.hoursAgo - x.hoursAgo)
    for (const { i, channel, agentTurn, hoursAgo } of slots) {
      let author = agentTurn ? pick(rand, input.roleAgents) : pick(rand, people).key
      for (let k = 0; k < 4 && !agentTurn && author === lastAuthor.get(channel.key); k++) {
        author = pick(rand, people).key
      }
      lastAuthor.set(channel.key, author)
      messages.push({
        key: `msg:${day}:${i}`,
        room: channel.key,
        author,
        body: fill(
          fresh(channel.key, agentTurn ? AGENT_LINES : (CHANNEL_LINES[channel.key] ?? [])),
          rand,
          input.products,
        ),
        hoursAgo,
      })
    }
  }

  // ── Each person's chats with their own agent: five asks over two weeks ───
  // Each ask once per person (five of the six), and the answer is about the
  // same product the ask named.
  for (const person of people) {
    const asks = DM_ASKS.map((_, k) => ({ k, r: rand() }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.k)
    for (let i = 0; i < 5; i++) {
      const day = Math.floor(rand() * ACTIVITY_DAYS)
      const at = atWork(day)
      const ask = asks[i] as number
      const product = [pick(rand, input.products)]
      messages.push({
        key: `dm:${person.key}:${i}:ask`,
        room: `dm:${person.key}`,
        author: person.key,
        body: fill(DM_ASKS[ask] as string, rand, product),
        hoursAgo: round(at),
      })
      messages.push({
        key: `dm:${person.key}:${i}:answer`,
        room: `dm:${person.key}`,
        author: "agent",
        body: fill(DM_ANSWERS[ask] as string, rand, product),
        hoursAgo: round(Math.max(ACTIVITY_MIN_HOURS / 2, at - 0.02)),
      })
    }
  }

  // ── Tickets: about four a day, older ones mostly closed ─────────────────
  const tickets: PlannedTicket[] = []
  for (let i = 0; i < 60; i++) {
    const t = pick(rand, TICKET_SUBJECTS)
    // One product per ticket: its subject, its message and its replies agree.
    const product = [pick(rand, input.products)]
    const day = Math.floor((i / 60) * ACTIVITY_DAYS)
    const createdHoursAgo = round(i === 0 ? 0.3 : atWork(day))
    const age = createdHoursAgo / 24
    const r = rand()
    const status: PlannedTicket["status"] =
      age > 7
        ? r < 0.85
          ? "closed"
          : "awaiting_customer"
        : r < 0.45
          ? "open"
          : r < 0.75
            ? "awaiting_customer"
            : "closed"
    const deskForTeam =
      t.team === "finance"
        ? byRole("finance")
        : t.team === "sales"
          ? byRole("sales")
          : t.team === "operations"
            ? [...byRole("fulfillment"), ...byRole("ops_lead")]
            : supportDesk
    const assignee =
      status === "open" && rand() < 0.3 ? null : (pick(rand, deskForTeam)?.key ?? null)
    const replies: PlannedTicket["replies"] = []
    const span = Math.max(0.1, createdHoursAgo - ACTIVITY_MIN_HOURS)
    if (status !== "open" || rand() < 0.4) {
      replies.push({
        kind: "outbound",
        hoursAfter: round(span * 0.3),
        body: t.reply,
      })
    }
    if (status === "closed" && rand() < 0.6) {
      replies.push({
        kind: "inbound",
        hoursAfter: round(span * 0.6),
        body: t.inbound,
      })
    }
    if (rand() < 0.25) {
      replies.push({ kind: "note", hoursAfter: round(span * 0.15), body: t.note })
    }
    replies.sort((a, b) => a.hoursAfter - b.hoursAfter)
    const priorityRoll = rand()
    tickets.push({
      key: `t${String(i).padStart(2, "0")}`,
      subject: fill(t.subject, rand, product),
      body: fill(t.body, rand, product),
      contactKey: pick(rand, input.contactKeys),
      category: t.category,
      team: t.team,
      priority:
        priorityRoll < 0.08
          ? "urgent"
          : priorityRoll < 0.25
            ? "high"
            : priorityRoll < 0.85
              ? "normal"
              : "low",
      status,
      assignee,
      createdHoursAgo,
      replies,
    })
  }

  // ── Routine runs: daily ones every working morning, weekly on Mondays ───
  const routineRuns: PlannedRoutineRun[] = []
  for (const routine of input.routines) {
    if (routine.cadence === "event") {
      for (let i = 0; i < 12; i++) {
        const ticket = tickets[i * 5] as PlannedTicket
        routineRuns.push({
          key: `${routine.name}:event:${ticket.key}`,
          routine: routine.name,
          hoursAgo: round(Math.max(ACTIVITY_MIN_HOURS, ticket.createdHoursAgo - 0.01)),
          durationMs: 8_000 + Math.floor(rand() * 30_000),
          status: rand() < 0.06 ? "failed" : "succeeded",
          trigger: "event",
        })
      }
      continue
    }
    const step = routine.cadence === "daily" ? 1 : 7
    for (let day = ACTIVITY_DAYS - 1; day >= 0; day -= step) {
      routineRuns.push({
        key: `${routine.name}:${day}`,
        routine: routine.name,
        hoursAgo: round(day * 24 + 2 + rand() * 0.2),
        durationMs: 15_000 + Math.floor(rand() * 90_000),
        status: rand() < 0.07 ? "failed" : "succeeded",
        trigger: "schedule",
      })
    }
  }
  // The newest run is minutes old, so "last run" reads as just now.
  const newestRun = routineRuns.reduce<PlannedRoutineRun | null>(
    (a, b) => (a === null || b.hoursAgo < a.hoursAgo ? b : a),
    null,
  )
  if (newestRun) newestRun.hoursAgo = ACTIVITY_MIN_HOURS

  // ── Sub runs: the agents hand research to their sub roles ────────────────
  const subRuns: PlannedSubRun[] = []
  if (input.subAgentTypes.length > 0) {
    for (let i = 0; i < 20; i++) {
      const person = pick(rand, people)
      const product = pick(rand, input.products)
      subRuns.push({
        key: `sub:${i}`,
        person: person.key,
        subagentType: pick(rand, input.subAgentTypes),
        prompt: `Collect every open ticket and order about the ${product} and list what is blocking each one.`,
        summary: `Found ${2 + Math.floor(rand() * 6)} open items about the ${product}; the oldest waits on a replacement part.`,
        hoursAgo: round(
          i === 0 ? ACTIVITY_MIN_HOURS * 2 : atWork(Math.floor(rand() * ACTIVITY_DAYS)),
        ),
        durationMs: 20_000 + Math.floor(rand() * 100_000),
        failed: rand() < 0.1,
      })
    }
  }

  // ── Attention: what reached each person, the newest still unread ─────────
  const attention: PlannedAttention[] = []
  for (const person of people) {
    const items: PlannedAttention[] = []
    for (let i = 0; i < 8; i++) {
      const kindRoll = rand()
      const kind: PlannedAttention["kind"] =
        kindRoll < 0.35 ? "mention" : kindRoll < 0.65 ? "thread_reply" : "agent_notification"
      const actor = pick(
        rand,
        people.filter((p) => p.key !== person.key),
      ).key
      const target =
        kind === "agent_notification" ? pick(rand, tickets).key : pick(rand, channels).key
      items.push({
        key: `${person.key}:${i}`,
        person: person.key,
        kind,
        target,
        actor,
        summary:
          kind === "agent_notification"
            ? `Ticket waiting on you: ${tickets.find((t) => t.key === target)?.subject ?? "a ticket"}`
            : kind === "mention"
              ? "mentioned you"
              : fill(pick(rand, CHANNEL_LINES[target] ?? AGENT_LINES), rand, input.products).slice(
                  0,
                  140,
                ),
        hoursAgo: round(i === 0 ? ACTIVITY_MIN_HOURS : atWork(Math.floor(rand() * ACTIVITY_DAYS))),
        read: true,
      })
    }
    items.sort((a, b) => a.hoursAgo - b.hoursAgo)
    // The newest three stay unread, one per (kind, target): the unread index is unique on it.
    const seen = new Set<string>()
    let unread = 0
    for (const item of items) {
      const id = `${item.kind}:${item.target}`
      if (unread < 3 && !seen.has(id)) {
        item.read = false
        seen.add(id)
        unread++
      }
    }
    attention.push(...items)
  }

  return { channels, messages, tickets, routineRuns, subRuns, attention }
}

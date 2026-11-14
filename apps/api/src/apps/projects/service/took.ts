// SPDX-License-Identifier: FSL-1.1-ALv2
// Took: real time is only ever a person's own statement. A person typing in the
// task's field states it themselves. An agent may record it only with the
// person's words: the quote must be whole words of the person's latest message
// of the thread (in-app), and the duration the message states there, read from
// the message itself, must equal `time`. Over MCP there is no
// thread, so the person's own connection and the quote's duration are what is
// checked; a connection bound to an agent never records it. Nothing here ever
// proposes, estimates or rounds a figure.
import { parseDuration } from "@liaison/shared"

export const NEEDS_PERSON_STATEMENT = "needs_person_statement"

export type TookOrigin = "in-app-agent" | "mcp" | "human-ui" | "system" | "dashboard"
export type EnteredVia = "field" | "agent" | "mcp"

/** Words of a text, lower case, without the punctuation around them. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,;:!?()"'«»]+(?=\s|$)/g, " ")
    .replace(/(?<=^|\s)[("'«»]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "")
}

/** The longest span of up to four words from `start` that reads as one duration. */
function durationAt(
  words: readonly string[],
  start: number,
  hoursPerDayMinutes: number,
): { minutes: number; len: number } | null {
  for (let len = Math.min(4, words.length - start); len >= 1; len--) {
    const minutes = parseDuration(words.slice(start, start + len).join(" "), hoursPerDayMinutes)
    if (minutes !== null) return { minutes, len }
  }
  return null
}

function firstDuration(
  words: readonly string[],
  hoursPerDayMinutes: number,
): { minutes: number; start: number; len: number } | null {
  for (let start = 0; start < words.length; start++) {
    const found = durationAt(words, start, hoursPerDayMinutes)
    if (found) return { ...found, start }
  }
  return null
}

/** The duration a person's words state: the first span of up to four words that reads as one. */
export function durationInQuote(quote: string, hoursPerDayMinutes: number): number | null {
  return firstDuration(wordsOf(quote), hoursPerDayMinutes)?.minutes ?? null
}

const NEGATIONS = new Set(["not", "no", "never", "pas", "non", "jamais"])

/**
 * The duration the person's message states where the quote stands in it, read from the
 * message's own words: the quote must be whole words of the message, and the figure is the
 * message's whole duration there (so "2 hours" taken out of "12 hours", or "1h" out of
 * "1h30", reads the person's figure, not the quote's). Null when the quote is not in the
 * message as whole words, states no duration, or the duration there is negated.
 */
function durationSaidInMessage(
  message: string,
  quote: string,
  hoursPerDayMinutes: number,
): number | null {
  const m = wordsOf(message)
  const q = wordsOf(quote)
  const inQuote = firstDuration(q, hoursPerDayMinutes)
  if (q.length === 0 || !inQuote) return null
  for (let i = 0; i + q.length <= m.length; i++) {
    if (!q.every((w, k) => m[i + k] === w)) continue
    const at = i + inQuote.start
    const said = durationAt(m, at, hoursPerDayMinutes)
    if (!said) continue
    // A duration that starts before the quote's and covers it ("1 h 30" around "30").
    const earlier = [1, 2, 3]
      .map((back) => (at - back >= 0 ? durationAt(m, at - back, hoursPerDayMinutes) : null))
      .some((d, idx) => d !== null && d.len > idx + 1)
    if (earlier) continue
    if (at > 0 && NEGATIONS.has(m[at - 1] ?? "")) continue
    return said.minutes
  }
  return null
}

export interface TookPlace {
  origin: TookOrigin
  /** The run frame's routine, sub-run and bound-agent facts (undefined: no frame). */
  frame:
    | { routineId?: string; background?: boolean; mcpGateway?: boolean; agentId?: string }
    | undefined
  /** The agent acting on the call, if one is (an MCP connection bound to an agent sets it). */
  actingAgentId: string | null
}

export interface TookRefusal {
  code: typeof NEEDS_PERSON_STATEMENT
  message: string
  next: string
}

const NEXT_ASK =
  "Ask the person how long it took, in their own words, and record exactly what they say. Never propose, estimate or round a figure."

function refuse(message: string): TookRefusal {
  return {
    code: NEEDS_PERSON_STATEMENT,
    message: `Nothing was recorded: ${message}`,
    next: NEXT_ASK,
  }
}

/** How the entry was made, from where the call came. */
export function enteredViaOf(origin: TookOrigin): EnteredVia {
  if (origin === "human-ui") return "field"
  if (origin === "mcp") return "mcp"
  return "agent"
}

/**
 * Is this call a person's own statement of `minutes`? Null when it is, else the refusal.
 * `latestHumanMessage` is the person's latest message in the thread (in-app agent only).
 */
export function checkPersonStatement(input: {
  place: TookPlace
  minutes: number
  quote: string | undefined
  hoursPerDayMinutes: number
  latestHumanMessage: string | null
}): TookRefusal | null {
  const { place, minutes, quote, hoursPerDayMinutes, latestHumanMessage } = input
  if (place.origin === "human-ui") return null
  if (place.frame?.routineId || place.frame?.background === true) {
    return refuse(
      "real time is a person's own statement, never recorded from a routine or a sub-run.",
    )
  }
  if (place.origin === "mcp") {
    if (place.frame?.agentId !== undefined || place.actingAgentId !== null) {
      return refuse(
        "this connection works for an agent, and only a person's own connection records their time.",
      )
    }
  } else if (place.origin !== "in-app-agent") {
    return refuse("real time is a person's own statement, and no person made this call.")
  }
  if (typeof quote !== "string" || quote.trim() === "") {
    return refuse("an agent records time only with the person's own words, given as quote.")
  }
  const said =
    place.origin === "in-app-agent"
      ? latestHumanMessage === null
        ? null
        : durationSaidInMessage(latestHumanMessage, quote, hoursPerDayMinutes)
      : durationInQuote(quote, hoursPerDayMinutes)
  if (said === null) {
    if (place.origin === "in-app-agent") {
      return refuse(
        "the quote is not, word for word, a duration the person states in their latest message in this conversation.",
      )
    }
    return refuse("the quote states no duration.")
  }
  if (said !== minutes) {
    return refuse("the time given differs from the duration in the person's words.")
  }
  return null
}

/** Today's date (YYYY-MM-DD) in a timezone, for a given instant. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

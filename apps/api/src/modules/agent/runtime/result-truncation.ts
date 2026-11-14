// SPDX-License-Identifier: FSL-1.1-ALv2
// Token-shaped truncation of agent tool results.
//
// Field finding (2026-07-17): one `tickets:get` on a 50-message ticket returned
// 738k chars (htmlBody + textBody of every message). That result is (1) fed to
// the model on the next step, (2) persisted in the thread's toolCalls metadata,
// and (3) replayed verbatim into EVERY subsequent step and every future tick of
// the same thread — compaction only fires at 80% of the model context window,
// so a long-lived routine thread re-pays hundreds of k tokens per STEP and a
// single tick burned >2M input tokens (Gemini's whole per-minute quota).
//
// Two independent caps, both structure-preserving (long STRINGS inside the
// result are cut; the JSON shape the agent navigates stays intact):
//   - LIVE cap (`truncateToolResultForModel`): what the model sees on the step
//     that made the call. Generous — the agent legitimately needs the data it
//     just asked for.
//   - REPLAY cap (`truncateReplayedToolResult`): what later steps/turns see
//     when history is reassembled. Aggressive — a result from ten turns ago is
//     reference material; the agent can re-run the tool if it truly needs the
//     full payload again.

/** Marker appended to every clipped string so the model knows data is missing
 *  and how to get it back. */
const CLIP_NOTE = (dropped: number): string =>
  `… [${dropped} chars truncated by the platform — re-run the tool (with narrower params) if you need the full content]`

interface TruncateOptions {
  /** Per-string ceiling (chars). Strings longer than this are clipped. */
  maxString: number
  /** Whole-result ceiling (chars of serialized JSON). After per-string
   *  clipping, a result still over this is stringified and hard-clipped. */
  maxTotal: number
}

/** Live results: per-string 40k, total 48k chars (~12k tokens). The
 *  per-string floor matters: skill bodies (~11k) and knowledge docs (~33k)
 *  arrive as ONE string via skill_read / knowledge:get — clipping tighter
 *  than the largest instructional doc cuts playbooks mid-procedure, so
 *  maxTotal must stay ABOVE maxString. The total was 200k (~50k tokens)
 *  until 2026-07-21: one oversized result could eat a whole step's budget
 *  and then ride verbatim in every later step. Claude Code and opencode
 *  both cap tool output near 50KB; anything bigger should be re-fetched
 *  with narrower params (the CLIP_NOTE tells the model how). */
export const LIVE_RESULT_LIMITS: TruncateOptions = { maxString: 40_000, maxTotal: 48_000 }

/**
 * A demo visitor's live results: per-string 3k, total 6k chars (about 2,300
 * tokens in the strict visitor estimate, JSON escaping included). A result
 * rides in every later step of the turn, and each visitor step on this box's
 * key holds its input's uncached worst cost in the visitor's budget as it
 * leaves (demo-spend-ceiling.ts, ONE STEP): a dozen steps of results at the
 * live limits (16,000 estimated tokens each) would hold most of a visitor's
 * budget on their own. With these, a routine run's last step is its first plus
 * at most eleven results (about 25,300): the heaviest guided turn, the support
 * routine's tick, opens at about 46,600
 * (seed/tiers/demo/visitor-turn-size.integration.test.ts), so it ends near
 * 72,000. The guided scenarios read a ticket, an order, an article or a short
 * list.
 */
export const VISITOR_RESULT_LIMITS: TruncateOptions = { maxString: 3_000, maxTotal: 6_000 }

/** Replayed history: per-string 2k, total 16k chars (~4k tokens) per result. */
export const REPLAY_RESULT_LIMITS: TruncateOptions = { maxString: 2_000, maxTotal: 16_000 }

function clipString(s: string, maxString: number): string {
  if (s.length <= maxString) return s
  return s.slice(0, maxString) + CLIP_NOTE(s.length - maxString)
}

function deepClipStrings(value: unknown, maxString: number): unknown {
  if (typeof value === "string") return clipString(value, maxString)
  if (Array.isArray(value)) return value.map((v) => deepClipStrings(v, maxString))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepClipStrings(v, maxString)
    }
    return out
  }
  return value
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Cap a tool result to `limits`. Structure-preserving where possible: long
 * strings inside the object are clipped in place; only when the clipped result
 * is STILL over `maxTotal` (pathological array fan-out) does it degrade to a
 * `{ truncatedResult, note }` envelope carrying the serialized head.
 * Small results pass through untouched (same reference — zero cost).
 */
export function truncateToolResult(value: unknown, limits: TruncateOptions): unknown {
  const total = serializedLength(value)
  if (total <= limits.maxTotal) return value
  const clipped = deepClipStrings(value, limits.maxString)
  const clippedTotal = serializedLength(clipped)
  if (clippedTotal <= limits.maxTotal) return clipped
  const serialized = JSON.stringify(clipped) ?? ""
  return {
    truncatedResult: serialized.slice(0, limits.maxTotal),
    note:
      `Result was ${total} chars and exceeded the platform's size cap even after clipping long fields; ` +
      `this is the serialized head. Re-run the tool with narrower params (filters, pagination, fewer fields) for the rest.`,
  }
}

/** What a clipped result was cut from, for as long as the clipped value is in use. */
const uncutResults = new WeakMap<object, unknown>()

export function truncateToolResultForModel(
  value: unknown,
  opts: { visitor?: boolean } = {},
): unknown {
  const capped = truncateToolResult(
    value,
    opts.visitor ? VISITOR_RESULT_LIMITS : LIVE_RESULT_LIMITS,
  )
  if (capped !== value && typeof capped === "object" && capped !== null) {
    uncutResults.set(capped, value)
  }
  return capped
}

/**
 * The whole result behind a value `truncateToolResultForModel` clipped, or the value itself. The
 * cap is about what the model is sent: a result card has its own byte bound and reads the whole
 * result, and it is the only reader of this.
 */
export function uncappedToolResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  return uncutResults.has(value) ? uncutResults.get(value) : value
}

/** Replay path accepts the persisted result (object or string). */
export function truncateReplayedToolResult(value: unknown): unknown {
  return truncateToolResult(value, REPLAY_RESULT_LIMITS)
}

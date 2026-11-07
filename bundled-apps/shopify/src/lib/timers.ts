// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Waiting, where waiting is possible.
//
// The bundle runs on two executors. One exposes NO timers (a guest `setTimeout`
// is "not defined"), the other has a real `setTimeout`. Every pause in this app
// goes through `sleep` below, which feature-detects the timer at call time: a
// no-op without one (pacing then comes from the network round trip and the
// caller's bounded loop), a real wait with one. Never call `setTimeout` directly.

type TimerFn = (fn: () => void, ms: number) => unknown

/** Pause for `ms` when the runtime has a timer; resolve at once otherwise. */
export function sleep(ms: number): Promise<void> {
  const timer = (globalThis as { setTimeout?: TimerFn }).setTimeout
  if (typeof timer !== "function" || !(ms > 0)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    timer(() => resolve(), ms)
  })
}

export const POLL_BASE_MS = 250
export const POLL_CAP_MS = 2_000

/** The wait before poll attempt `attemptIndex + 1`: 250 ms doubling to a 2 s cap. */
export function pollBackoffMs(attemptIndex: number): number {
  return Math.min(POLL_CAP_MS, POLL_BASE_MS * 2 ** Math.max(0, attemptIndex))
}

/**
 * A bounded poll pacer. Each call waits `pollBackoffMs(attempt)`, clipped so the
 * total waited never exceeds `budgetMs` (the share of the handler's execution
 * budget the caller gives to waiting). Once the budget is spent the pacer stops
 * waiting and the caller's iteration bound ends the loop.
 */
export function createPollPacer(
  budgetMs: number,
  sleepFn: (ms: number) => Promise<void> = sleep,
): (attemptIndex: number) => Promise<void> {
  let remaining = Math.max(0, budgetMs)
  return async (attemptIndex: number) => {
    const ms = Math.min(pollBackoffMs(attemptIndex), remaining)
    if (ms <= 0) return
    remaining -= ms
    await sleepFn(ms)
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Run a block under a chosen timer shape: `recording` replaces `setTimeout` with
// one that records each delay and fires on the next microtask (no wall-clock
// wait), `absent` removes it, the shape of a runtime without timers.

type Mode = "recording" | "absent"

export async function withTimer<T>(mode: Mode, fn: (delays: number[]) => Promise<T>): Promise<T> {
  const g = globalThis as { setTimeout?: unknown }
  const original = g.setTimeout
  const delays: number[] = []
  if (mode === "absent") {
    g.setTimeout = undefined
  } else {
    g.setTimeout = (cb: () => void, ms: number) => {
      delays.push(ms)
      queueMicrotask(cb)
      return 0
    }
  }
  try {
    return await fn(delays)
  } finally {
    g.setTimeout = original
  }
}

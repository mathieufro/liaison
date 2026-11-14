// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Keep holding" on a held mail draft: the viewer leaves the computed hold as it is. Nothing is
 * sent to the server (the hold is the server's own reading of the auto-reply); this browser only
 * remembers, per viewer, that the card is folded to its one line until that hold ends. A hold
 * that moves (a new auto-reply) or ends reads as not kept, so the card comes back by itself.
 */
import { createSignal } from "solid-js"

const STORAGE_KEY = "liaison:heldKept.v1"

type Kept = Record<string, string>

function read(): Kept {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Kept) : {}
  } catch {
    return {}
  }
}

const [kept, setKept] = createSignal<Kept>(read())

function write(next: Kept): void {
  setKept(next)
  try {
    if (Object.keys(next).length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY)
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage refused: the fold holds for this page only.
  }
}

/** Reactive: the viewer chose Keep holding on this draft's current hold. */
export function isHeldKept(requestId: string, holdUntil: string | null | undefined): boolean {
  return !!holdUntil && kept()[requestId] === holdUntil
}

/** Remember Keep holding for this hold; holds already over are dropped. */
export function keepHolding(requestId: string, holdUntil: string, now = Date.now()): void {
  const next: Kept = {}
  for (const [id, until] of Object.entries(kept())) {
    if (Date.parse(until) > now) next[id] = until
  }
  next[requestId] = holdUntil
  write(next)
}

/** Test seam: forget every fold and re-read storage. */
export const HeldKeptTestAccess = {
  reload(): void {
    setKept(read())
  },
}

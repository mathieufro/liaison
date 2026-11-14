// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one way a page puts words in the chat dock's composer: `dock.prefill(text)` opens the
// person's conversation with their own agent where it fits (the dock, or a thread tab on Home
// and on a phone) and puts the text in that conversation's composer, caret at the end. It only
// prefills: nothing is sent, the person reads it, changes it and presses Send themselves.
//
// The composer (`ComposeBar`) takes a waiting prefill for its own conversation once its editor
// is ready, so a composer that mounts after the call still gets it. The dock's layout is not
// touched.
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  type PersonalDmApi,
  personalAgentDmFor,
  revealPersonalAgentDm,
} from "~/modules/threads/personal-dm-store"

export interface ComposerPrefill {
  threadId: string
  text: string
  /** Distinguishes two prefills of the same words, so the second one still lands. */
  n: number
}

const [waiting, setWaiting] = createSignal<ComposerPrefill | null>(null)
let counter = 0

/** The prefill waiting for `threadId`'s composer, if any (reactive). */
export function pendingPrefill(threadId: string | undefined): ComposerPrefill | null {
  const p = waiting()
  return p && threadId && p.threadId === threadId ? p : null
}

/** The composer took it: it is not given again. */
export function consumePrefill(n: number): void {
  if (waiting()?.n === n) setWaiting(null)
}

/** Put `text` in the composer of `threadId` (no send). */
export function prefillThread(threadId: string, text: string): void {
  counter += 1
  setWaiting({ threadId, text, n: counter })
}

export const dock = {
  /**
   * Open the conversation with the person's own agent and put `text` in its composer. Never
   * sends. Resolves with the conversation's id once it is open.
   */
  async prefill(text: string, api?: PersonalDmApi): Promise<string> {
    const threadId = await personalAgentDmFor(api)
    prefillThread(threadId, text)
    revealPersonalAgentDm(threadId)
    return threadId
  },
}

export function resetDockPrefill(): void {
  setWaiting(null)
}
onSessionTeardown(resetDockPrefill)

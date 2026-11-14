// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The flat text a turn stores: every step's text, in order, each step a
 * paragraph of its own. The chat draws each step's text in its own block (the
 * turn's timeline), but whatever reads the stored text alone (a notification,
 * an export, a later turn's history, a search) used to get the steps run
 * together ("...these.Drafted"). A step's text that follows earlier text now
 * starts after a blank line; text within one step is kept as streamed.
 */

/** What separates two steps' text in the stored reply. */
export const STEP_SEPARATOR = "\n\n"

/** `next` appended to `reply` as a new paragraph, unless either side is blank. */
export function joinStepText(reply: string, next: string): string {
  if (!/\S/.test(next)) return reply
  if (!/\S/.test(reply)) return next
  return `${reply.replace(/\s+$/, "")}${STEP_SEPARATOR}${next.replace(/^\s+/, "")}`
}

/** Every step's text as one stored reply. */
export function joinStepTexts(texts: readonly string[]): string {
  return texts.reduce(joinStepText, "")
}

/**
 * The reply as a stream builds it: `add` each text delta, `endStep` at each
 * step's end. The first visible text of a step after earlier text starts a new
 * paragraph; a step's leading whitespace is dropped in favour of the separator.
 */
export function createReplyText(): {
  readonly text: string
  /** Each step's text exactly as streamed (their concatenation is the streamed text). */
  readonly steps: readonly string[]
  add: (delta: string) => void
  endStep: () => void
} {
  let text = ""
  let stepStarted = true
  const steps: string[] = []
  let rawStepStarted = true
  return {
    get text() {
      return text
    },
    get steps() {
      return steps
    },
    add(delta: string) {
      if (!delta) return
      if (rawStepStarted) steps.push(delta)
      else steps[steps.length - 1] += delta
      rawStepStarted = false
      if (stepStarted) {
        if (!/\S/.test(delta)) {
          if (!/\S/.test(text)) text += delta
          return
        }
        text = joinStepText(text, delta)
        stepStarted = false
        return
      }
      text += delta
    },
    endStep() {
      stepStarted = true
      rawStepStarted = true
    },
  }
}

/** The stored reply of steps streamed as `steps`, built as `createReplyText` builds it. */
export function replyTextOfSteps(steps: readonly string[]): string {
  const reply = createReplyText()
  for (const step of steps) {
    reply.add(step)
    reply.endStep()
  }
  return reply.text
}

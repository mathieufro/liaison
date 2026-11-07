// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import { isThreadTainted } from "~/modules/agent/scopes/taint"
import {
  type OpenTab,
  type OpenView,
  openViewsOf,
  runHasNoViewer,
  tabForId,
} from "~/modules/agent/tools/open-targets"

/** Chips drawn under one reply. */
export const SUGGESTED_STEPS_MAX = 4
const LABEL_MAX = 80
const TAB_ID = /^[\w:.@-]{1,200}$/
const PANEL_ID = /^[\w:/.@%=+-]{1,200}$/

export const suggestNextStepsParams = z.object({
  steps: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(LABEL_MAX),
        prompt: z.string().optional(),
        open: z
          .object({
            app: z.string().min(1),
            view: z.string().optional(),
            id: z.string().optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(SUGGESTED_STEPS_MAX),
})

export type SuggestNextStepsParams = z.infer<typeof suggestNextStepsParams>

/** A chip as the chat draws it: its words are the person's message, or it opens a tab. */
export type SuggestedStep =
  | { label: string; kind: "prompt" }
  | { label: string; kind: "open"; app: string; tab?: OpenTab }

export interface SuggestStepsContext {
  orgId: string
  agentExecutionThreadId?: string
}

type Refused = { ok: false; code: string; message: string; step?: number; valid?: string[] }
type Shown = { ok: true; shown: number; steps?: SuggestedStep[]; message: string }

const NOTHING_SHOWN = "No suggestion shown."

function refuse(code: string, message: string, step?: number, valid?: string[]): Refused {
  return {
    ok: false,
    code,
    message: `${step !== undefined ? `Step ${step}: ` : ""}${message} ${NOTHING_SHOWN}`,
    ...(step !== undefined ? { step } : {}),
    ...(valid ? { valid } : {}),
  }
}

/** The tab an open step reaches, decided here so a chip never opens what open_app would not. */
function openStep(
  orgId: string,
  open: { app: string; view?: string; id?: string },
  n: number,
): { app: string; tab?: OpenTab } | Refused {
  const app = open.app.trim()
  const view = open.view?.trim() || undefined
  const id = open.id?.trim() || undefined
  if (!view && !id) return { app }
  const views = openViewsOf(orgId, app)
  if (!views) return refuse("UNKNOWN_APP", `There is no app "${app}" with views to open.`, n)
  const records = views.filter((v) => v.needsId)
  const chosen: OpenView | undefined = view
    ? views.find((v) => v.view === view)
    : records.length === 1
      ? records[0]
      : undefined
  const names = views.map((v) => v.view)
  if (!chosen) {
    return refuse(
      "UNKNOWN_VIEW",
      view ? `${app} has no view "${view}".` : `${app} needs a view for that id.`,
      n,
      names,
    )
  }
  if (chosen.needsId && !id) {
    return refuse(
      "ID_REQUIRED",
      `${app} view "${chosen.view}" opens one record and needs its id.`,
      n,
    )
  }
  if (!chosen.needsId && id) {
    return refuse(
      "ID_NOT_TAKEN",
      `${app} view "${chosen.view}" is not a record: it takes no id.`,
      n,
    )
  }
  const shape = chosen.target.kind === "detail" ? PANEL_ID : TAB_ID
  if (id && !shape.test(id)) return refuse("BAD_ID", `"${id}" is not an id of ${app}.`, n)
  const tab = tabForId(chosen.target, id ?? chosen.view)
  if (!tab) {
    return refuse(
      "NOT_A_TAB",
      `${app} view "${chosen.view}" has no tab of its own; kernel__open_app opens it.`,
      n,
    )
  }
  return { app, tab }
}

/**
 * `suggest_next_steps`: up to four chips under the agent's reply. A prompt chip sends exactly the
 * words it shows as the person's own message, so its `prompt`, when given, must be its label: a
 * chip never says one thing and sends another. An open chip opens a tab the server resolved here.
 * The chips are drawn from this result. A conversation holding outside text gets none, so text
 * read from outside can never put words in the person's mouth.
 */
export async function handleSuggestNextSteps(
  params: SuggestNextStepsParams,
  ctx: SuggestStepsContext,
): Promise<Shown | Refused> {
  if (runHasNoViewer()) return refuse("NO_VIEWER", "This run has no person watching it.")
  const threadId = ctx.agentExecutionThreadId
  if (!threadId) return refuse("NO_CONVERSATION", "There is no conversation to show them in.")

  const steps: SuggestedStep[] = []
  for (const [i, step] of params.steps.entries()) {
    const n = i + 1
    const label = step.label.trim()
    if (step.open && step.prompt !== undefined) {
      return refuse("PROMPT_AND_OPEN", "A step either sends words or opens a tab, not both.", n)
    }
    if (step.prompt !== undefined && step.prompt.trim() !== label) {
      return refuse(
        "PROMPT_NOT_SHOWN",
        "A chip sends exactly the words it shows, and this prompt differs from its label. Put the words to send in label and leave prompt out.",
        n,
      )
    }
    if (step.open) {
      const opened = openStep(ctx.orgId, step.open, n)
      if ("ok" in opened) return opened
      steps.push({ label, kind: "open", ...opened })
    } else {
      steps.push({ label, kind: "prompt" })
    }
  }

  if (await isThreadTainted(threadId, ctx.orgId)) {
    return {
      ok: true,
      shown: 0,
      message: `${NOTHING_SHOWN} This conversation holds outside text, so no chip may speak for the person here; offer the steps in your reply instead.`,
    }
  }
  return {
    ok: true,
    shown: steps.length,
    steps,
    message: `${steps.length} shown under your reply. A click sends a chip's label as the person's message, or opens its tab.`,
  }
}

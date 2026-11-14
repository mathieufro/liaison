// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine templates the kernel itself ships (S28, A37), next to the ones apps
// declare in their manifests. They live in the same routineTemplateRegistry
// under the app name "kernel", are registered with every org's kernel tools
// (so a new org has them as soon as its runtime starts), and instantiate as
// routines with source_kind 'kernel' and no app_name.
import { routineTemplateRegistry } from "~/modules/apps/app-registries"

/** The registry's app slot for kernel templates. No app is ever named "kernel". */
export const KERNEL_TEMPLATE_APP = "kernel"

export const MORNING_BRIEF_TEMPLATE_KEY = "morning-brief"
export const DEAL_FOLLOWUPS_TEMPLATE_KEY = "deal-followups"

/**
 * Template keys of routines an app's own job acts through (an "app-run"
 * routine): an inbox option that nudges and closes silent tickets, say. Such a
 * routine has no agent and no tick: it exists so that what the job does is
 * attributed to "Routine {name}" (approval cards, messages, audit) while it
 * runs as its owner, under the owner's permissions. It is always disabled, is
 * never ticked, and cannot be edited: the app's setting is what switches it.
 */
export const APP_RUN_TEMPLATE_PREFIX = "app-run:"

export function isAppRunRoutine(templateKey: string | null | undefined): boolean {
  return typeof templateKey === "string" && templateKey.startsWith(APP_RUN_TEMPLATE_PREFIX)
}

/** "HH:MM" on a 24-hour clock. */
export const TEMPLATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Put a chosen "HH:MM" into a 5-field cron's minute and hour, keeping its day
 * fields ("0 8 * * 1-5" at "07:30" is "30 7 * * 1-5"). Null when either is
 * malformed.
 */
export function cronAtTime(cron: string, time: string): string | null {
  const m = TEMPLATE_TIME_PATTERN.exec(time)
  const fields = cron.trim().split(/\s+/)
  if (!m || fields.length !== 5) return null
  return [String(Number(m[2])), String(Number(m[1])), ...fields.slice(2)].join(" ")
}

/** The "HH:MM" a plain `M H ...` cron fires at, or null for anything fancier. */
export function timeOfCron(cron: string | null | undefined): string | null {
  const [min, hour] = (cron ?? "").trim().split(/\s+/)
  if (!min || !hour || !/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null
  return `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
}

/**
 * The Morning brief (S28, F1, F7): every weekday at the owner's chosen time, in
 * the owner's timezone, a short brief in the owner's own routine thread, and a
 * push through kernel__notify_user (a routine thread routes to `replies`, where
 * push is off by default, so the post alone would not reach the phone).
 */
const MORNING_BRIEF_PROMPT = [
  "Write my morning brief. Keep it short: three headed sections, at most 8 bullets in all, in my language.",
  "",
  "1. Overnight mail: the new mail in my mailboxes since yesterday 18:00 (mail search). One line per conversation that needs me: who, what, and what they expect. Skip newsletters and notifications.",
  "2. Waiting for my approval: the drafts and other actions waiting for me (kernel__approvals_list). One line each: what it is and for whom.",
  "3. Due: my tasks due today or overdue (projects tasks_byAssignee for me). One line each.",
  "",
  "A section with nothing in it says so in one line. Do not invent anything: only what the tools returned.",
  "Post the brief as your reply here. Then call kernel__notify_user exactly once with a one-line summary of the counts (for example: 3 new emails, 2 drafts to approve, 1 task due), so I get it on my phone.",
].join("\n")

/** Days of silence before a deal gets a follow-up, when the person names none. */
export const DEAL_FOLLOWUPS_DEFAULT_QUIET_DAYS = 7
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What a Deal follow-ups routine covers: how quiet a deal must be, and one pipeline or all. */
export interface DealFollowupOptions {
  quietDays: number
  pipelineId: string | null
}

/**
 * Deal follow-ups: every weekday, a draft per open deal gone quiet, for
 * the deal's owner to approve. What may be drafted is decided by the server
 * (`deals_followup_candidates`: quiet, opted out, basis, sender mailbox, a
 * draft already waiting) and checked again at send by the send guard, so the
 * prompt only says what to write and where.
 */
function dealFollowupsPrompt(o: DealFollowupOptions): string {
  const args = JSON.stringify({
    quietDays: o.quietDays,
    ...(o.pipelineId ? { projectId: o.pipelineId } : {}),
  })
  return [
    "Draft follow-ups for open deals that went quiet. You only draft: each mail waits for a person's approval.",
    "",
    `1. Call projects__deals_followup_candidates with ${args}.`,
    '2. For each row with skip null, write a short, friendly follow-up to the row\'s contact about the deal, in the language of their last message, signed as the deal\'s owner. Call mail__compose with the row\'s accountId, to the row\'s address, and followUp {"refs": [{"kind": "projects:deal", "id": <taskId>}]}. Never pass sendGuard. Then set the deal\'s next step with projects__deals_update {taskId, nextStep}.',
    "3. Never draft a row that has a skip, and never write to anyone else.",
    "4. Reply with a short summary: the drafts made (deal and person), then the skipped deals counted by reason, with their titles.",
  ].join("\n")
}

/** The options of a Deal follow-ups prompt, read back from its call line; null for any other prompt. */
export function dealFollowupOptionsOf(
  prompt: string | null | undefined,
): DealFollowupOptions | null {
  const m = /projects__deals_followup_candidates with (\{[^\n}]*\})/.exec(prompt ?? "")
  if (!m) return null
  try {
    const v = JSON.parse(m[1]!) as { quietDays?: unknown; projectId?: unknown }
    if (!Number.isInteger(v.quietDays) || (v.quietDays as number) < 1) return null
    return {
      quietDays: v.quietDays as number,
      pipelineId: typeof v.projectId === "string" && UUID_RE.test(v.projectId) ? v.projectId : null,
    }
  } catch {
    return null
  }
}

/** Check the options a person chose; an error is said in one plain sentence. */
export function dealFollowupOptions(raw: {
  quietDays?: unknown
  pipelineId?: unknown
}): DealFollowupOptions | { error: string } {
  const quietDays = raw.quietDays ?? DEAL_FOLLOWUPS_DEFAULT_QUIET_DAYS
  if (!Number.isInteger(quietDays) || (quietDays as number) < 1 || (quietDays as number) > 365) {
    return { error: "quietDays is a whole number of days, from 1 to 365." }
  }
  const pipelineId = raw.pipelineId ?? null
  if (pipelineId !== null && (typeof pipelineId !== "string" || !UUID_RE.test(pipelineId))) {
    return { error: "pipelineId is the id of a pipeline project." }
  }
  return { quietDays: quietDays as number, pipelineId: pipelineId as string | null }
}

export function registerKernelRoutineTemplates(orgId: string): void {
  routineTemplateRegistry.set([orgId, KERNEL_TEMPLATE_APP, MORNING_BRIEF_TEMPLATE_KEY], {
    description:
      "Morning brief: overnight mail, drafts waiting for your approval and tasks due, every weekday morning.",
    kind: "recurring",
    cron: "0 8 * * 1-5",
    // No timezone: the owner's own applies.
    promptTemplate: MORNING_BRIEF_PROMPT,
    scopes: [
      "mail:conversations:read",
      "kernel:approvals:read",
      "projects:tasks:read",
      // kernel__notify_user.
      "kernel:agent:memory",
    ],
    enabledByDefault: false,
    visibility: "personal",
    sourceKind: "kernel",
  })
  routineTemplateRegistry.set([orgId, KERNEL_TEMPLATE_APP, DEAL_FOLLOWUPS_TEMPLATE_KEY], {
    description:
      "Deal follow-ups: every weekday, a follow-up draft for each open deal gone quiet, for the deal's owner to approve.",
    kind: "recurring",
    cron: "0 8 * * 1-5",
    // No timezone: the owner's own applies.
    promptTemplate: dealFollowupsPrompt({
      quietDays: DEAL_FOLLOWUPS_DEFAULT_QUIET_DAYS,
      pipelineId: null,
    }),
    renderPrompt: (raw) => {
      const o = dealFollowupOptions(raw)
      return "error" in o ? o : { prompt: dealFollowupsPrompt(o) }
    },
    optionsOf: (prompt) => dealFollowupOptionsOf(prompt) ?? undefined,
    scopes: [
      "projects:projects:read",
      "projects:tasks:write",
      "mail:conversations:read",
      "mail:conversations:write",
    ],
    followUp: true,
    enabledByDefault: false,
    visibility: "personal",
    sourceKind: "kernel",
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Approval summaries for the kernel's gated tools that had none: their cards
// fell back to the raw parameters. Params in, summary out; subagent_create also
// reads the role it would overwrite, to show what changes.
import { loadSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import type { ApprovalSummarizer } from "~/modules/apps/app-registries"
import { listCatalog } from "~/modules/apps/catalog"
import { isAppRegistered } from "~/modules/apps/enabled-apps"
import { serverT } from "~/modules/i18n/server-i18n"
import { dayLabel, isoWeekdayOf } from "~/modules/users/away"

type Params = Record<string, unknown>
const asParams = (p: unknown): Params =>
  p && typeof p === "object" && !Array.isArray(p) ? (p as Params) : {}
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null

/** kernel:contacts_export: what leaves as a CSV file. */
export const summarizeContactsExport: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const tag = text(p.tag)
  const segment = text(p.segmentId)
  const scope = tag
    ? `contacts tagged "${tag}"`
    : segment
      ? "the contacts of one saved segment"
      : "every contact you can see"
  return {
    kind: "contacts_export",
    title: tag ? `Export contacts tagged "${tag}"` : "Export contacts to a CSV file",
    lines: [`Exports ${scope} (names, emails, phone numbers) to a CSV file.`],
  }
}

/** kernel:capture_business_knowledge: a new knowledge document the whole org reads. */
export const summarizeCaptureBusinessKnowledge: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const title = text(p.title) ?? "(untitled)"
  const body = text(p.body) ?? ""
  const preview = body.length > 180 ? `${body.slice(0, 180)}…` : body
  return {
    kind: "capture_business_knowledge",
    title: `Add to company knowledge: ${title}`,
    lines: [
      "A new knowledge document everyone in the organization can read.",
      ...(preview ? [preview] : []),
    ],
  }
}

/**
 * kernel:enable_app: an app every member then sees and the agent can use. The
 * card says whether approving INSTALLS the app on the instance first (from the
 * catalog, as the App store does) or only turns it on, in the requester's language.
 */
export const summarizeEnableApp: ApprovalSummarizer = async (raw, ctx) => {
  const app = text(asParams(raw).appName) ?? "(no app named)"
  const installs =
    listCatalog().some((e) => e.name === app) && !(await isAppRegistered(ctx.orgId, app))
  const { recipientLocale } = await import("~/modules/push/fanout-consumer")
  const locale = await recipientLocale(ctx.orgId, ctx.userId)
  const t = (key: string) => serverT(locale, `kernel.enableAppCard.${key}`, { app })
  return {
    kind: "enable_app",
    title: t(installs ? "installTitle" : "enableTitle"),
    lines: [t(installs ? "installLine" : "enableLine"), t("effectLine")],
  }
}

/** kernel:ai_models_set: the organization's default model and reasoning level. */
export const summarizeAiModelsSet: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((k) => typeof k === "string") : [])
  const lines: string[] = []
  const add = text(p.addFromOpenRouter)
  if (add) lines.push(`Add ${add} from OpenRouter, after a test call.`)
  if (p.autoModelKey === null) lines.push("Auto goes back to the cheapest model with a key.")
  else if (text(p.autoModelKey)) lines.push(`Auto runs ${text(p.autoModelKey)}.`)
  if (p.defaultReasoningLevel === null) lines.push("Default reasoning level: the built-in one.")
  else if (text(p.defaultReasoningLevel)) {
    lines.push(`Default reasoning level: ${text(p.defaultReasoningLevel)}.`)
  }
  if (list(p.enable).length > 0) lines.push(`Switch on: ${list(p.enable).join(", ")}.`)
  if (list(p.disable).length > 0) lines.push(`Switch off: ${list(p.disable).join(", ")}.`)
  lines.push("Applies to everything left on Auto, for everyone in the organization.")
  return { kind: "ai_models_set", title: "Change the organization's AI models", lines }
}

/** kernel:apps_set_enabled: an app turned On or Off for the whole workspace. */
export const summarizeAppsSetEnabled: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const app = text(p.appName) ?? "(no app named)"
  const on = p.enabled === true
  return {
    kind: "apps_set_enabled",
    title: on ? `Turn the ${app} app back on` : `Turn off the ${app} app`,
    lines: on
      ? ["Back on for everyone: its pages, agent tools, background sync and webhooks resume."]
      : [
          "Off for everyone: its pages and agent tools go, its background sync and webhooks stop.",
          "Its data is kept. Events received while it is off are not replayed.",
        ],
  }
}

/** kernel:apps_set_access: who may use an app. */
export const summarizeAppsSetAccess: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const app = text(p.appName) ?? "(no app named)"
  if (p.mode !== "restricted") {
    return {
      kind: "apps_set_access",
      title: `Let everyone use the ${app} app`,
      lines: ["Every member of the workspace can use it again."],
    }
  }
  const roles = Array.isArray(p.roleIds) ? p.roleIds.length : 0
  const people = Array.isArray(p.userIds) ? p.userIds.length : 0
  return {
    kind: "apps_set_access",
    title: `Limit who can use the ${app} app`,
    lines: [
      `Only ${roles} role${roles === 1 ? "" : "s"} and ${people} ${people === 1 ? "person" : "people"} keep it; admins always do.`,
      "Everyone else loses its pages, agent tools and approvals.",
    ],
  }
}

const listOrNone = (v: unknown): string =>
  Array.isArray(v) && v.length > 0 ? v.map(String).join(", ") : "(none)"

/** kernel:subagent_create: gated only when the slug names an existing role it would overwrite. */
export const summarizeSubagentCreate: ApprovalSummarizer = async (raw, ctx) => {
  const p = asParams(raw)
  const slug = text(p.agentType) ?? "(no slug)"
  const existing = text(p.agentType) ? await loadSubAgentDefinition(ctx.orgId, slug) : null
  const prompt = text(p.systemPrompt)
  const preview = prompt && prompt.length > 180 ? `${prompt.slice(0, 180)}…` : prompt
  if (!existing) {
    return {
      kind: "subagent_create",
      title: `Register the sub-agent role "${slug}"`,
      lines: [`Scope ceiling: ${listOrNone(p.scopeCeiling)}.`, ...(preview ? [preview] : [])],
    }
  }
  return {
    kind: "subagent_create",
    title: `Change the existing sub-agent role "${slug}"`,
    lines: [
      "Every later spawn of this role runs with the new definition.",
      `Scope ceiling: ${listOrNone(existing.scopeCeiling)} → ${listOrNone(p.scopeCeiling)}.`,
      preview
        ? `New instructions: ${preview}`
        : "New instructions: a default built from its purpose (the current ones are replaced).",
    ],
  }
}

/** kernel:subagent_delete: gated only when the slug names an existing role. */
export const summarizeSubagentDelete: ApprovalSummarizer = async (raw, ctx) => {
  const slug = text(asParams(raw).agentType) ?? "(no slug)"
  const existing = await loadSubAgentDefinition(ctx.orgId, slug)
  return {
    kind: "subagent_delete",
    title: `Delete the sub-agent role "${slug}"`,
    lines: [
      "Later spawns of this role, including from routines, fail until it is registered again.",
      ...(existing ? [`Scope ceiling: ${listOrNone(existing.scopeCeiling)}.`] : []),
      "Runs already started keep going.",
    ],
  }
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const awayDay = (v: unknown): string | null => {
  const d = text(v)
  if (!d) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(isoWeekdayOf(d)) ? dayLabel(d) : d
}

/** kernel:set_away: parked when the call came from outside text, a routine or an MCP client. */
export const summarizeSetAway: ApprovalSummarizer = async (raw) => {
  const p = asParams(raw)
  const other = text(p.userId) !== null
  const lines: string[] = []
  const on = awayDay(p.on)
  const from = awayDay(p.from)
  const to = awayDay(p.to)
  if (on) lines.push(`On ${on}.`)
  if (from || to) lines.push(`From ${from ?? "today"} to ${to ?? "the same day"}.`)
  if (typeof p.week === "number")
    lines.push(`ISO week ${p.week}${typeof p.weekYear === "number" ? ` of ${p.weekYear}` : ""}.`)
  if (Array.isArray(p.everyWeekday) && p.everyWeekday.length > 0) {
    const days = p.everyWeekday
      .map((d) => (typeof d === "number" ? WEEKDAY_NAMES[d - 1] : undefined))
      .filter((d): d is string => d !== undefined)
    lines.push(`Every week on ${days.join(", ")}.`)
  }
  if (text(p.nextInLineId)) lines.push("Names a next in line.")
  if (p.end === true) {
    return {
      kind: "set_away",
      title: other
        ? "End someone else's away days running today"
        : "End your away days running today",
      lines,
    }
  }
  if (lines.length === 1 && text(p.nextInLineId)) {
    return {
      kind: "set_away",
      title: other ? "Set someone else's standing next in line" : "Set your standing next in line",
      lines,
    }
  }
  return { kind: "set_away", title: other ? "Mark someone else away" : "Mark yourself away", lines }
}

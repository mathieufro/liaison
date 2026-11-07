// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Turns one tool result into a card, given the tool's `resultCard` template. Pure: the only
// inputs are the template and the result the actor was given, so a card can hold nothing the
// actor did not already receive, and it needs no database. It never throws: a result the
// template does not fit, or a card over its size bound, is `null` and the chat draws the
// ordinary tool row instead.
import {
  type CardAction,
  type CardCond,
  type CardFormat,
  type CardLabel,
  type CardOpen,
  type CardTemplate,
  type ResolvedCard,
  type ResolvedCardAction,
  type ResolvedCardGroupRow,
  type ResolvedCardOpen,
  type ResolvedCardValue,
  TOOL_CARD_GROUPS_MAX_BYTES,
  TOOL_CARD_GROUPS_MAX_ROWS,
  TOOL_CARD_MAX_BYTES,
} from "@liaison/shared"

/** The values a path can start from: the result, and inside a list, group or row, its element. */
interface Scope {
  result: Record<string, unknown>
  group?: unknown
  row?: unknown
  item?: unknown
}

/** A value a required field needs is absent: the whole card is `null`. */
class Missing extends Error {}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
const SINGLE_PLACEHOLDER = /^\{\{([^{}]*)\}\}$/
const ROOTS = new Set(["result", "group", "row", "item"])
const MAX_ITEMS = 20
const MAX_LINKS = 6
const MAX_TOTALS = 6
const MAX_NOTES = 3

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function lookup(scope: Scope, path: string): unknown {
  const [root, ...rest] = path.split(".")
  if (root === undefined || !ROOTS.has(root) || rest.length === 0) return undefined
  let cur: unknown = scope[root as keyof Scope]
  for (const key of rest) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return undefined
    cur = cur[key]
  }
  return cur
}

/** A string, number or boolean as the text a person reads; anything else is absent. */
function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "boolean") return String(v)
  return undefined
}

function scalarKeepingNumber(v: unknown): string | number | undefined {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return v
  return undefined
}

function tpl(text: string | undefined, scope: Scope): string | undefined {
  if (typeof text !== "string") return undefined
  let missing = false
  const out = text.replace(PLACEHOLDER, (_all, path: string) => {
    const v = scalar(lookup(scope, path.trim()))
    if (v === undefined) {
      missing = true
      return ""
    }
    return v
  })
  return missing ? undefined : out
}

const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Missing()
  return v
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function typedValue(raw: unknown, format: CardFormat): ResolvedCardValue | undefined {
  switch (format) {
    case "money": {
      if (!isRecord(raw)) return undefined
      const { minor, currency } = raw
      if (typeof minor !== "number" || !Number.isSafeInteger(minor)) return undefined
      if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return undefined
      return { t: "money", minor, currency: currency.toUpperCase() }
    }
    case "date":
      return typeof raw === "string" && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw))
        ? { t: "date", iso: raw }
        : undefined
    case "datetime":
    case "relative":
      return typeof raw === "string" && ISO_DATETIME.test(raw) && !Number.isNaN(Date.parse(raw))
        ? { t: format, iso: raw }
        : undefined
    case "number":
    case "percent":
      return typeof raw === "number" && Number.isFinite(raw) ? { t: format, n: raw } : undefined
    case "hours":
      return typeof raw === "number" && Number.isFinite(raw)
        ? { t: "hours", minutes: raw }
        : undefined
  }
}

/** A template with a format is one placeholder, so the value keeps its type. */
function formatted(
  text: string | undefined,
  format: CardFormat | undefined,
  scope: Scope,
): ResolvedCardValue | undefined {
  if (text === undefined) return undefined
  if (format === undefined) return tpl(text, scope)
  const match = SINGLE_PLACEHOLDER.exec(text)
  if (!match?.[1]) return undefined
  return typedValue(lookup(scope, match[1].trim()), format)
}

function formattedPath(
  path: string,
  format: CardFormat | undefined,
  scope: Scope,
): ResolvedCardValue | undefined {
  const raw = lookup(scope, path)
  return format === undefined ? scalar(raw) : typedValue(raw, format)
}

function cond(c: CardCond | undefined, scope: Scope): boolean {
  if (c === undefined) return true
  const v = lookup(scope, c.path)
  if (c.exists !== undefined && (v !== undefined && v !== null) !== c.exists) return false
  if (c.equals !== undefined && scalar(v) !== c.equals) return false
  return true
}

const label = (l: CardLabel): CardLabel =>
  l.labelKey === undefined ? { label: l.label } : { label: l.label, labelKey: l.labelKey }

function open(o: CardOpen | undefined, scope: Scope): ResolvedCardOpen | undefined {
  if (o === undefined) return undefined
  if (o.idPath === undefined) return { view: o.view }
  const id = scalar(lookup(scope, o.idPath))
  // A link with no id would open the wrong page: leave the link out.
  return id === undefined ? undefined : { view: o.view, id }
}

function externalUrl(template: string, scope: Scope): string | undefined {
  const match = /^(https:\/\/[^/]+)(\/.*)?$/.exec(template)
  if (!match?.[1]) return undefined
  let missing = false
  const rest = (match[2] ?? "").replace(PLACEHOLDER, (_all, path: string) => {
    const v = scalar(lookup(scope, path.trim()))
    if (v === undefined) {
      missing = true
      return ""
    }
    return encodeURIComponent(v)
  })
  if (missing) return undefined
  try {
    const url = new URL(match[1] + rest)
    return url.protocol === "https:" && url.origin === match[1] ? url.href : undefined
  } catch {
    return undefined
  }
}

function action(
  a: CardAction & { labelPath?: string },
  scope: Scope,
): ResolvedCardAction | undefined {
  if (!cond(a.when, scope)) return undefined
  const text = a.labelPath === undefined ? undefined : scalar(lookup(scope, a.labelPath))
  const shown: CardLabel = text === undefined ? label(a.label) : { label: text }
  switch (a.kind) {
    case "open": {
      const target = open({ view: a.view, idPath: a.idPath }, scope)
      return target === undefined
        ? undefined
        : { kind: "open", label: shown, view: target.view, ...(target.id ? { id: target.id } : {}) }
    }
    case "tool": {
      const params: Record<string, string | number> = {}
      for (const [name, path] of Object.entries(a.params)) {
        const v = scalarKeepingNumber(lookup(scope, path))
        if (v === undefined) return undefined
        params[name] = v
      }
      return {
        kind: "tool",
        label: shown,
        tool: a.tool,
        params,
        ...(a.confirm ? { confirm: label(a.confirm) } : {}),
        ...(a.primary ? { primary: true as const } : {}),
      }
    }
    case "ask": {
      const prompt = tpl(a.prompt, scope)
      return prompt === undefined ? undefined : { kind: "ask", label: shown, prompt }
    }
    case "external": {
      const url = externalUrl(a.urlTemplate, scope)
      return url === undefined ? undefined : { kind: "external", label: shown, url }
    }
  }
}

function actions(list: CardAction[] | undefined, scope: Scope): ResolvedCardAction[] {
  const out: ResolvedCardAction[] = []
  for (const a of list ?? []) {
    const resolved = action(a, scope)
    if (resolved) out.push(resolved)
  }
  return out
}

function elements(path: string, scope: Scope): Record<string, unknown>[] {
  const list = lookup(scope, path)
  if (!Array.isArray(list)) throw new Missing()
  return list.map((entry) => {
    if (!isRecord(entry)) throw new Missing()
    return entry
  })
}

/** A list the template reads when the result has it; one the result lacks is empty. */
function optionalElements(path: string, scope: Scope): Record<string, unknown>[] {
  return lookup(scope, path) === undefined ? [] : elements(path, scope)
}

function header(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  const ref = tpl(t.ref, scope)
  if (ref !== undefined) card.ref = ref
  const sub = tpl(t.sub, scope)
  if (sub !== undefined) card.sub = sub
  const end = tpl(t.end, scope)
  if (end !== undefined) card.end = end
  if (typeof t.foot === "string") {
    const foot = tpl(t.foot, scope)
    if (foot !== undefined) card.foot = foot
  } else if (t.foot) {
    card.foot = label(t.foot)
  }
  if (t.open) {
    const target = open(t.open, scope)
    if (target) card.open = target
  }
  if (t.status) {
    const state = scalar(lookup(scope, t.status.path))
    const shown =
      state !== undefined && Object.hasOwn(t.status.map, state) ? t.status.map[state] : undefined
    if (shown) {
      card.status = { label: label(shown.label), tone: shown.tone }
    }
  }
  const list = actions(t.actions, scope)
  if (list.length > 0) card.actions = list
}

function buildEntity(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  card.title = need(tpl(t.title, scope))
  header(t, scope, card)
  const rows: NonNullable<ResolvedCard["rows"]> = []
  for (const r of t.rows ?? []) {
    const value = formatted(r.value, r.format, scope)
    if (value === undefined) continue
    const shown = open(r.open, scope)
    rows.push({
      label: label(r.label),
      value,
      ...(r.mono ? { mono: true as const } : {}),
      ...(r.warnWhen && cond(r.warnWhen, scope) ? { warn: true as const } : {}),
      ...(shown ? { open: shown } : {}),
    })
  }
  if (rows.length > 0) card.rows = rows
}

function buildList(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  card.title = need(tpl(t.title, scope))
  header(t, scope, card)
  const spec = need(t.items)
  const limit = Math.min(spec.limit ?? MAX_ITEMS, MAX_ITEMS)
  card.items = elements(spec.path, scope)
    .slice(0, limit)
    .map((item) => {
      const at: Scope = { ...scope, item }
      const meta = tpl(spec.meta, at)
      const num = formatted(spec.num, spec.numFormat, at)
      const shown = open(spec.open, at)
      return {
        label: need(tpl(spec.label, at)),
        ...(meta === undefined ? {} : { meta }),
        ...(num === undefined ? {} : { num }),
        ...(shown ? { open: shown } : {}),
      }
    })
  if (t.more) card.more = { label: label(t.more.label), view: t.more.open.view }
}

function buildNumber(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  const title = tpl(t.title, scope)
  if (title !== undefined) card.title = title
  header(t, scope, card)
  card.value = need(formatted(t.value, t.valueFormat, scope))
  const delta = tpl(t.delta, scope)
  if (delta !== undefined) card.delta = delta
  // A figure without its method and source is not shown.
  card.how = label(need(t.how))
  card.source = need(tpl(t.source, scope))
}

function buildGroups(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  card.title = need(tpl(t.title, scope))
  header(t, scope, card)
  const cover = tpl(t.cover, scope)
  if (cover !== undefined) card.cover = cover
  if (t.notice && cond(t.notice.when, scope)) {
    const title = tpl(t.notice.title, scope)
    const text = tpl(t.notice.text, scope)
    if (title !== undefined && text !== undefined) {
      card.notice = { icon: t.notice.icon, title, text }
    }
  }
  const sum = t.summary
  if (sum && cond(sum.when, scope)) {
    card.summary = { text: need(tpl(sum.text, scope)), actions: actions(sum.actions, scope) }
  } else {
    buildGroupBody(t, scope, card)
  }
  const key = tpl(t.latestKey, scope)
  if (key !== undefined) card.latestKey = key
  if (t.supersededLabel) card.supersededLabel = label(t.supersededLabel)
}

function buildGroupBody(t: CardTemplate, scope: Scope, card: ResolvedCard): void {
  const columns = (t.columns ?? []).filter((c) => cond(c.when, scope))
  card.columns = columns.map((c) => ({
    key: c.key,
    label: label(c.label),
    ...(c.format ? { format: c.format } : {}),
  }))
  const spec = need(t.groups)
  const editing = t.edit && cond(t.edit.when, scope) ? t.edit : undefined
  let rowCount = 0
  card.groups = elements(spec.path, scope).map((group) => {
    const inGroup: Scope = { ...scope, group }
    const rows: ResolvedCardGroupRow[] = elements(spec.rows.path, inGroup).map((row) => {
      rowCount += 1
      const at: Scope = { ...inGroup, row }
      const resolved: ResolvedCardGroupRow = {
        id: need(scalar(lookup(at, spec.rows.id))),
        name: need(tpl(spec.rows.name, at)),
        cells: {},
        links: [],
      }
      const tag = tpl(spec.rows.tag, at)
      if (tag !== undefined) resolved.tag = tag
      if (spec.rows.flag !== undefined && lookup(at, spec.rows.flag)) resolved.flag = true
      const why = tpl(spec.rows.why, at)
      if (why !== undefined) resolved.why = why
      for (const column of columns) {
        const path = spec.rows.cells[column.key]
        const v = path === undefined ? undefined : formattedPath(path, column.format, at)
        if (v !== undefined) resolved.cells[column.key] = v
      }
      const links = spec.rows.links
      if (links) {
        for (const item of optionalElements(links.path, at).slice(
          0,
          Math.min(links.limit ?? MAX_LINKS, MAX_LINKS),
        )) {
          const here: Scope = { ...at, item }
          const text = tpl(links.label, here)
          if (text === undefined) continue
          const target = open(links.open, here)
          const url =
            links.urlPath === undefined ? undefined : httpsUrl(lookup(here, links.urlPath))
          resolved.links.push({
            label: text,
            ...(target ? { open: target } : {}),
            ...(url ? { url } : {}),
          })
        }
      }
      if (spec.rows.act) {
        const act = action(spec.rows.act, at)
        if (act) resolved.act = act
      }
      if (editing) {
        const values: NonNullable<ResolvedCardGroupRow["edit"]> = {}
        for (const field of editing.fields) {
          const value = scalarKeepingNumber(lookup(at, field.valuePath))
          if (value === undefined) continue
          const unit = field.unitPath === undefined ? undefined : scalar(lookup(at, field.unitPath))
          values[field.param] = unit === undefined ? { value } : { value, unit }
        }
        if (Object.keys(values).length > 0) resolved.edit = values
      }
      return resolved
    })
    return { label: need(tpl(spec.label, inGroup)), rows }
  })
  if (rowCount > TOOL_CARD_GROUPS_MAX_ROWS) throw new Missing()

  if (t.tot) {
    card.tot = optionalElements(t.tot.path, scope)
      .slice(0, MAX_TOTALS)
      .map((item) => {
        const at: Scope = { ...scope, item }
        return {
          k: need(tpl(t.tot?.k, at)),
          v: need(formatted(t.tot?.v, t.tot?.format, at)),
        }
      })
  }
  if (t.notes) {
    card.notes = optionalElements(t.notes.path, scope)
      .slice(0, MAX_NOTES)
      .map((item) => {
        const at: Scope = { ...scope, item }
        const icon = t.notes?.icon === undefined ? undefined : scalar(lookup(at, t.notes.icon))
        return { ...(icon === undefined ? {} : { icon }), text: need(tpl(t.notes?.text, at)) }
      })
  }
  if (editing) {
    const params: Record<string, string | number> = {}
    let complete = true
    for (const [name, path] of Object.entries(editing.params)) {
      const v = scalarKeepingNumber(lookup(scope, path))
      if (v === undefined) complete = false
      else params[name] = v
    }
    // Without the revision and ids the card was drawn from, an edit could not be applied.
    if (complete) {
      card.edit = {
        openLabel: label(editing.openLabel),
        doneLabel: label(editing.doneLabel),
        tool: editing.tool,
        params,
        rowParam: editing.rowParam,
        fields: editing.fields.map((f) => ({
          param: f.param,
          label: label(f.label),
          kind: f.kind,
          ...(f.private ? { private: true as const } : {}),
        })),
      }
    } else {
      for (const g of card.groups ?? []) for (const r of g.rows) delete r.edit
    }
  }
}

/** A link target from data is drawn as a link only when it is an https URL. */
function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  try {
    const url = new URL(raw)
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

const BUILDERS = {
  entity: buildEntity,
  list: buildList,
  number: buildNumber,
  groups: buildGroups,
} as const

/**
 * The card a tool result draws, or `null` when the result does not fit the template (a required
 * value is missing, the result is not an object) or the card is over its size bound.
 */
export function resolveToolCard(template: CardTemplate, result: unknown): ResolvedCard | null {
  try {
    if (!isRecord(result)) return null
    const scope: Scope = { result }
    if (!cond(template.when, scope)) return null
    const card: ResolvedCard = { kind: template.kind, pill: label(template.pill) }
    if (template.icon) card.icon = template.icon
    BUILDERS[template.kind](template, scope, card)
    const bound = template.kind === "groups" ? TOOL_CARD_GROUPS_MAX_BYTES : TOOL_CARD_MAX_BYTES
    return new TextEncoder().encode(JSON.stringify(card)).length > bound ? null : card
  } catch {
    return null
  }
}

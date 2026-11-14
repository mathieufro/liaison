// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The deep rules for a tool's `resultCard`, run from validateAppManifest. The JSON schema only
// says the value is an object; everything that makes a template safe to draw from data lives
// here, and every message names the tool and the JSON path of the offending value.
//
// A template is data: fixed labels and paths into the tool's result. No expression, no HTML, no
// code. An action can only open a page, call a tool of the same app, ask the agent, or open a
// literal https host; a tool the app gates is never reached by a click without a confirm.
import {
  isAppIconName,
  TOOL_CARD_FORMATS,
  TOOL_CARD_KINDS,
  TOOL_CARD_TONES,
  type ToolCardKind,
} from "@liaison/shared"

type Root = "result" | "group" | "row" | "item"

const TOP: readonly Root[] = ["result"]
const ITEM: readonly Root[] = ["result", "item"]
const GROUP: readonly Root[] = ["result", "group"]
const ROW: readonly Root[] = ["result", "group", "row"]
const ROW_ITEM: readonly Root[] = ["result", "group", "row", "item"]

const PATH = /^(result|group|row|item)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const COLUMN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const MARKUP = /<\s*[A-Za-z/!?]/

const LIMITS = { rows: 8, actions: 3, items: 20, links: 6, columns: 5, tot: 6, notes: 3, fields: 3 }

const HEADER_KEYS = ["ref", "title", "sub", "end", "foot", "open", "status", "actions"]
const KIND_KEYS: Record<ToolCardKind, string[]> = {
  entity: [...HEADER_KEYS, "rows"],
  list: [...HEADER_KEYS, "items", "more"],
  number: ["title", "sub", "foot", "value", "valueFormat", "delta", "how", "source"],
  groups: [
    ...HEADER_KEYS,
    "cover",
    "notice",
    "columns",
    "groups",
    "tot",
    "notes",
    "edit",
    "summary",
    "latestKey",
    "supersededLabel",
  ],
}
const REQUIRED_KEYS: Record<ToolCardKind, string[]> = {
  entity: ["title"],
  list: ["title", "items"],
  number: ["value", "how", "source"],
  groups: ["title", "groups", "columns"],
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

interface ToolDef {
  gated?: boolean
  conditionalGate?: boolean
  params?: { properties?: Obj }
  returns?: { schema?: Record<string, string> }
}

class CardCheck {
  readonly errors: string[] = []
  private readonly tools: Record<string, ToolDef>
  private readonly returns: Record<string, string> | undefined

  constructor(
    private readonly toolName: string,
    tools: Record<string, ToolDef>,
  ) {
    this.tools = tools
    this.returns = tools[toolName]?.returns?.schema
  }

  err(at: string, message: string): void {
    this.errors.push(`tools.${this.toolName}.resultCard${at}: ${message}`)
  }

  /** Reject unknown keys and wrong types by name before anything reads the value. */
  keys(v: Obj, allowed: readonly string[], at: string): void {
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key)) this.err(`${at}.${key}`, "is not a key of this card")
    }
  }

  object(v: unknown, at: string): v is Obj {
    if (isObj(v)) return true
    this.err(at, "must be an object")
    return false
  }

  array(v: unknown, at: string, max: number): v is unknown[] {
    if (!Array.isArray(v)) {
      this.err(at, "must be an array")
      return false
    }
    if (v.length > max) this.err(at, `has ${v.length} entries, at most ${max}`)
    return true
  }

  /** Fixed text: a non-empty string that carries no markup. */
  text(v: unknown, at: string): v is string {
    if (typeof v !== "string" || v.length === 0) {
      this.err(at, "must be a non-empty string")
      return false
    }
    if (MARKUP.test(v)) {
      this.err(at, "must be plain text, with no HTML")
      return false
    }
    return true
  }

  label(v: unknown, at: string): void {
    if (!this.object(v, at)) return
    this.keys(v, ["label", "labelKey"], at)
    this.text(v.label, `${at}.label`)
    if (v.labelKey !== undefined && (typeof v.labelKey !== "string" || v.labelKey === "")) {
      this.err(`${at}.labelKey`, "must be a non-empty string")
    }
  }

  path(v: unknown, roots: readonly Root[], at: string): v is string {
    if (typeof v !== "string") {
      this.err(at, "must be a path string")
      return false
    }
    const match = PATH.exec(v)
    if (!match) {
      this.err(at, `'${v}' is not a path: it must start with ${roots.join(", ")} and a dot`)
      return false
    }
    if (!roots.includes(match[1] as Root)) {
      this.err(
        at,
        `'${v}' starts with ${match[1]}, which is not available here (${roots.join(", ")})`,
      )
      return false
    }
    if (match[1] === "result") this.resultPath(v, match[2]?.slice(1).split(".") ?? [], at)
    return true
  }

  /** M3: a value the card shows is a value the tool declares it returns. */
  private resultPath(path: string, segments: string[], at: string): void {
    if (this.returns === undefined) return
    const first = segments[0] as string
    if (!Object.hasOwn(this.returns, first)) {
      this.err(at, `'${path}' is not in the tool's returns.schema`)
      return
    }
    const type = this.returns[first]
    if (segments.length > 1 && (type === "string" || type === "number" || type === "boolean")) {
      this.err(at, `'${path}' goes into '${first}', which the tool returns as ${type}`)
    }
  }

  /** Text with `{{path}}` placeholders. With `single`, exactly one placeholder and nothing else. */
  tpl(v: unknown, roots: readonly Root[], at: string, single = false): void {
    if (typeof v !== "string" || v.length === 0) {
      this.err(at, "must be a non-empty string")
      return
    }
    const parts = v.split(/(\{\{[^{}]*\}\})/)
    let placeholders = 0
    for (const part of parts) {
      const inner = /^\{\{([^{}]*)\}\}$/.exec(part)
      if (inner) {
        placeholders += 1
        // `{{a.b|a.c}}`: alternatives, the first the result has is shown. Each is a path.
        for (const alt of (inner[1] ?? "").split("|")) this.path(alt.trim(), roots, at)
      } else if (part.includes("{{") || part.includes("}}")) {
        this.err(at, "has an unclosed or nested {{ }}")
      } else if (MARKUP.test(part)) {
        this.err(at, "must be plain text, with no HTML")
      }
    }
    if (single && (placeholders !== 1 || !/^\{\{[^{}]*\}\}$/.test(v))) {
      this.err(at, "must be one {{path}} and nothing else, so a formatted value keeps its type")
    }
  }

  /** Plain text with no {{ }}: nothing in it comes from the result. */
  private fixedText(v: unknown, at: string): void {
    if (typeof v !== "string" || v.trim().length === 0) {
      this.err(at, "must be a non-empty string")
    } else if (v.includes("{{") || v.includes("}}")) {
      this.err(at, "must be fixed text, with no {{ }}: it is posted as the person's own words")
    } else if (MARKUP.test(v)) {
      this.err(at, "must be plain text, with no HTML")
    }
  }

  format(v: unknown, at: string): void {
    if (!TOOL_CARD_FORMATS.includes(v as (typeof TOOL_CARD_FORMATS)[number])) {
      this.err(at, `must be one of ${TOOL_CARD_FORMATS.join(", ")}`)
    }
  }

  /** A template and the optional format that types it. */
  typed(v: Obj, tplKey: string, formatKey: string, roots: readonly Root[], at: string): void {
    const format = v[formatKey]
    if (format !== undefined) this.format(format, `${at}.${formatKey}`)
    if (v[tplKey] !== undefined) this.tpl(v[tplKey], roots, `${at}.${tplKey}`, format !== undefined)
  }

  cond(v: unknown, roots: readonly Root[], at: string): void {
    if (!this.object(v, at)) return
    this.keys(v, ["path", "equals", "exists"], at)
    this.path(v.path, roots, `${at}.path`)
    if (v.equals === undefined && v.exists === undefined) {
      this.err(at, "needs equals or exists")
    }
    if (v.equals !== undefined && typeof v.equals !== "string") {
      this.err(`${at}.equals`, "must be a string")
    }
    if (v.exists !== undefined && typeof v.exists !== "boolean") {
      this.err(`${at}.exists`, "must be a boolean")
    }
  }

  icon(v: unknown, at: string): void {
    if (!isAppIconName(v)) this.err(at, `'${String(v)}' is not an icon of Liaison's icon set`)
  }

  open(v: unknown, roots: readonly Root[], at: string, idRequired = false): void {
    if (!this.object(v, at)) return
    this.keys(v, ["view", "idPath"], at)
    this.text(v.view, `${at}.view`)
    if (v.idPath !== undefined) this.path(v.idPath, roots, `${at}.idPath`)
    else if (idRequired) this.err(`${at}.idPath`, "is required")
  }

  /** The target of a `tool` action or an `edit`: a tool of this same app. */
  private target(name: unknown, at: string): ToolDef | undefined {
    if (typeof name !== "string" || name === "") {
      this.err(at, "must be the name of a tool of this app")
      return undefined
    }
    const def = Object.hasOwn(this.tools, name) ? this.tools[name] : undefined
    if (!def) {
      this.err(at, `'${name}' is not a tool of this app (only the app's own tools can be called)`)
      return undefined
    }
    return def
  }

  /** `names` must be parameters the target tool declares, when it declares any. */
  private paramNames(def: ToolDef, names: string[], at: string): void {
    const declared = def.params?.properties
    if (!isObj(declared)) return
    for (const name of names) {
      if (!Object.hasOwn(declared, name)) this.err(at, `'${name}' is not a parameter of the tool`)
    }
  }

  action(v: unknown, roots: readonly Root[], at: string, rowAct = false): void {
    if (!this.object(v, at)) return
    const common = ["kind", "label", "when"]
    this.label(v.label, `${at}.label`)
    if (v.when !== undefined) this.cond(v.when, roots, `${at}.when`)
    switch (v.kind) {
      case "open":
        this.keys(v, [...common, "view", "idPath", ...(rowAct ? ["labelPath"] : [])], at)
        this.text(v.view, `${at}.view`)
        if (v.idPath !== undefined) this.path(v.idPath, roots, `${at}.idPath`)
        break
      case "tool": {
        this.keys(
          v,
          [...common, "tool", "params", "confirm", "primary", ...(rowAct ? ["labelPath"] : [])],
          at,
        )
        const def = this.target(v.tool, `${at}.tool`)
        if (def?.gated === true && v.confirm === undefined) {
          this.err(at, `calls the gated tool '${String(v.tool)}' and needs a confirm label`)
        }
        if (v.confirm !== undefined) this.label(v.confirm, `${at}.confirm`)
        if (v.primary !== undefined && typeof v.primary !== "boolean") {
          this.err(`${at}.primary`, "must be a boolean")
        }
        this.paramPaths(v.params, roots, `${at}.params`, def)
        break
      }
      case "ask":
        // The click posts the prompt as the person's own message, so it is the app's fixed
        // words: a value of the result may be text someone outside the org wrote (a subject,
        // a mail body), and neither the prompt nor the button's label is drawn from it.
        this.keys(v, [...common, "prompt"], at)
        this.fixedText(v.prompt, `${at}.prompt`)
        break
      case "external":
        this.keys(v, [...common, "urlTemplate", ...(rowAct ? ["labelPath"] : [])], at)
        this.externalUrl(v.urlTemplate, roots, `${at}.urlTemplate`)
        break
      default:
        this.err(`${at}.kind`, "must be open, tool, ask or external")
    }
    if (rowAct && v.labelPath !== undefined) this.path(v.labelPath, roots, `${at}.labelPath`)
  }

  /** Ids come from the result, never typed text: every value is a path. */
  private paramPaths(v: unknown, roots: readonly Root[], at: string, def?: ToolDef): void {
    if (!this.object(v, at)) return
    for (const [name, path] of Object.entries(v)) this.path(path, roots, `${at}.${name}`)
    if (def) this.paramNames(def, Object.keys(v), at)
  }

  private externalUrl(v: unknown, roots: readonly Root[], at: string): void {
    if (typeof v !== "string") {
      this.err(at, "must be a string")
      return
    }
    const match = /^https:\/\/([^/?#]*)(.*)$/.exec(v)
    if (!match) {
      this.err(at, "must start with https://")
      return
    }
    const host = match[1] ?? ""
    const rest = match[2] ?? ""
    if (host.includes("{{") || host.includes("}}")) {
      this.err(at, "must have a literal host, with no {{ }} inside it")
    } else if (!HOST.test(host)) {
      this.err(at, `host '${host}' must be a literal host name (no user, port or IP address)`)
    }
    if (rest !== "" && !rest.startsWith("/")) {
      this.err(at, "must continue with a path after the host")
    }
    if (rest !== "") this.tpl(rest, roots, at)
  }

  status(v: unknown, at: string): void {
    if (!this.object(v, at)) return
    this.keys(v, ["path", "map"], at)
    this.path(v.path, TOP, `${at}.path`)
    if (!this.object(v.map, `${at}.map`)) return
    for (const [state, entry] of Object.entries(v.map)) {
      const here = `${at}.map.${state}`
      if (!this.object(entry, here)) continue
      this.keys(entry, ["label", "tone"], here)
      this.label(entry.label, `${here}.label`)
      if (!TOOL_CARD_TONES.includes(entry.tone as (typeof TOOL_CARD_TONES)[number])) {
        this.err(`${here}.tone`, `must be one of ${TOOL_CARD_TONES.join(", ")}`)
      }
    }
  }

  header(t: Obj): void {
    if (t.ref !== undefined) this.tpl(t.ref, TOP, ".ref")
    if (t.title !== undefined) this.tpl(t.title, TOP, ".title")
    if (t.sub !== undefined) this.tpl(t.sub, TOP, ".sub")
    if (t.end !== undefined) this.tpl(t.end, TOP, ".end")
    if (t.foot !== undefined) {
      if (typeof t.foot === "string") this.tpl(t.foot, TOP, ".foot")
      else this.label(t.foot, ".foot")
    }
    if (t.open !== undefined) this.open(t.open, TOP, ".open", true)
    if (t.status !== undefined) this.status(t.status, ".status")
    if (t.actions !== undefined && this.array(t.actions, ".actions", LIMITS.actions)) {
      for (const [i, a] of t.actions.entries()) this.action(a, TOP, `.actions[${i}]`)
    }
  }

  entity(t: Obj): void {
    if (t.rows === undefined || !this.array(t.rows, ".rows", LIMITS.rows)) return
    t.rows.forEach((r, i) => {
      const at = `.rows[${i}]`
      if (!this.object(r, at)) return
      this.keys(r, ["label", "value", "format", "mono", "warnWhen", "open"], at)
      this.label(r.label, `${at}.label`)
      this.typed(r, "value", "format", TOP, at)
      if (r.value === undefined) this.err(`${at}.value`, "is required")
      if (r.mono !== undefined && typeof r.mono !== "boolean")
        this.err(`${at}.mono`, "must be a boolean")
      if (r.warnWhen !== undefined) this.cond(r.warnWhen, TOP, `${at}.warnWhen`)
      if (r.open !== undefined) this.open(r.open, TOP, `${at}.open`)
    })
  }

  list(t: Obj): void {
    if (this.object(t.items, ".items")) {
      const i = t.items
      this.keys(i, ["path", "label", "meta", "num", "numFormat", "open", "limit"], ".items")
      this.path(i.path, TOP, ".items.path")
      this.tpl(i.label, ITEM, ".items.label")
      if (i.meta !== undefined) this.tpl(i.meta, ITEM, ".items.meta")
      this.typed(i, "num", "numFormat", ITEM, ".items")
      if (i.open !== undefined) this.open(i.open, ITEM, ".items.open")
      if (i.limit !== undefined) {
        if (
          !Number.isInteger(i.limit) ||
          (i.limit as number) < 1 ||
          (i.limit as number) > LIMITS.items
        ) {
          this.err(".items.limit", `must be a whole number from 1 to ${LIMITS.items}`)
        }
      }
    }
    if (t.more !== undefined && this.object(t.more, ".more")) {
      this.keys(t.more, ["label", "open"], ".more")
      this.label(t.more.label, ".more.label")
      if (this.object(t.more.open, ".more.open")) {
        this.keys(t.more.open, ["view"], ".more.open")
        this.text(t.more.open.view, ".more.open.view")
      }
    }
  }

  number(t: Obj): void {
    this.typed(t, "value", "valueFormat", TOP, "")
    if (t.delta !== undefined) this.tpl(t.delta, TOP, ".delta")
    // A figure without its method and source is not shown.
    if (t.how !== undefined) this.label(t.how, ".how")
    if (t.source !== undefined) this.tpl(t.source, TOP, ".source")
  }

  groups(t: Obj): void {
    if (t.cover !== undefined) this.tpl(t.cover, TOP, ".cover")
    if (t.notice !== undefined && this.object(t.notice, ".notice")) {
      const n = t.notice
      this.keys(n, ["when", "icon", "title", "text"], ".notice")
      if (n.when !== undefined) this.cond(n.when, TOP, ".notice.when")
      this.icon(n.icon, ".notice.icon")
      this.tpl(n.title, TOP, ".notice.title")
      this.tpl(n.text, TOP, ".notice.text")
    }
    const columnKeys = this.columns(t.columns)
    this.groupTable(t.groups, columnKeys)
    if (t.tot !== undefined && this.object(t.tot, ".tot")) {
      this.keys(t.tot, ["path", "k", "v", "format"], ".tot")
      this.path(t.tot.path, TOP, ".tot.path")
      this.tpl(t.tot.k, ITEM, ".tot.k")
      this.typed(t.tot, "v", "format", ITEM, ".tot")
      if (t.tot.v === undefined) this.err(".tot.v", "is required")
    }
    if (t.notes !== undefined && this.object(t.notes, ".notes")) {
      this.keys(t.notes, ["path", "icon", "text"], ".notes")
      this.path(t.notes.path, TOP, ".notes.path")
      if (t.notes.icon !== undefined) this.path(t.notes.icon, ITEM, ".notes.icon")
      this.tpl(t.notes.text, ITEM, ".notes.text")
    }
    if (t.edit !== undefined) this.edit(t.edit)
    if (t.summary !== undefined && this.object(t.summary, ".summary")) {
      const s = t.summary
      this.keys(s, ["when", "text", "actions"], ".summary")
      if (s.when !== undefined) this.cond(s.when, TOP, ".summary.when")
      this.tpl(s.text, TOP, ".summary.text")
      if (s.actions !== undefined && this.array(s.actions, ".summary.actions", LIMITS.actions)) {
        for (const [i, a] of s.actions.entries()) this.action(a, TOP, `.summary.actions[${i}]`)
      }
    }
    if (t.latestKey !== undefined) this.tpl(t.latestKey, TOP, ".latestKey")
    if (t.supersededLabel !== undefined) this.label(t.supersededLabel, ".supersededLabel")
  }

  private columns(v: unknown): Set<string> {
    const keys = new Set<string>()
    if (v === undefined || !this.array(v, ".columns", LIMITS.columns)) return keys
    if (v.length === 0) this.err(".columns", "needs at least one column")
    v.forEach((c, i) => {
      const at = `.columns[${i}]`
      if (!this.object(c, at)) return
      this.keys(c, ["key", "label", "when", "format"], at)
      if (typeof c.key !== "string" || !COLUMN_KEY.test(c.key)) {
        this.err(`${at}.key`, "must be a plain identifier")
      } else if (keys.has(c.key)) {
        this.err(`${at}.key`, `'${c.key}' is used twice`)
      } else {
        keys.add(c.key)
      }
      this.label(c.label, `${at}.label`)
      if (c.when !== undefined) this.cond(c.when, TOP, `${at}.when`)
      if (c.format !== undefined) this.format(c.format, `${at}.format`)
    })
    return keys
  }

  private groupTable(v: unknown, columnKeys: Set<string>): void {
    if (!this.object(v, ".groups")) return
    this.keys(v, ["path", "label", "rows"], ".groups")
    this.path(v.path, TOP, ".groups.path")
    this.tpl(v.label, GROUP, ".groups.label")
    if (!this.object(v.rows, ".groups.rows")) return
    const r = v.rows
    const at = ".groups.rows"
    this.keys(r, ["path", "id", "name", "tag", "flag", "why", "cells", "links", "act"], at)
    this.path(r.path, GROUP, `${at}.path`)
    this.path(r.id, ROW, `${at}.id`)
    this.tpl(r.name, ROW, `${at}.name`)
    if (r.tag !== undefined) this.tpl(r.tag, ROW, `${at}.tag`)
    if (r.flag !== undefined) this.path(r.flag, ROW, `${at}.flag`)
    if (r.why !== undefined) this.tpl(r.why, ROW, `${at}.why`)
    if (this.object(r.cells, `${at}.cells`)) {
      for (const [key, path] of Object.entries(r.cells)) {
        if (!columnKeys.has(key)) this.err(`${at}.cells.${key}`, "is not a column of the card")
        this.path(path, ROW, `${at}.cells.${key}`)
      }
    }
    if (r.links !== undefined && this.object(r.links, `${at}.links`)) {
      const l = r.links
      this.keys(l, ["path", "label", "open", "urlPath", "limit"], `${at}.links`)
      this.path(l.path, ROW, `${at}.links.path`)
      this.tpl(l.label, ROW_ITEM, `${at}.links.label`)
      if (l.open !== undefined) this.open(l.open, ROW_ITEM, `${at}.links.open`)
      if (l.urlPath !== undefined) this.path(l.urlPath, ROW_ITEM, `${at}.links.urlPath`)
      if (l.limit !== undefined) {
        if (
          !Number.isInteger(l.limit) ||
          (l.limit as number) < 1 ||
          (l.limit as number) > LIMITS.links
        ) {
          this.err(`${at}.links.limit`, `must be a whole number from 1 to ${LIMITS.links}`)
        }
      }
    }
    if (r.act !== undefined) this.action(r.act, ROW, `${at}.act`, true)
  }

  private edit(v: unknown): void {
    if (!this.object(v, ".edit")) return
    const at = ".edit"
    this.keys(v, ["when", "openLabel", "doneLabel", "tool", "params", "rowParam", "fields"], at)
    if (v.when !== undefined) this.cond(v.when, TOP, `${at}.when`)
    this.label(v.openLabel, `${at}.openLabel`)
    this.label(v.doneLabel, `${at}.doneLabel`)
    const def = this.target(v.tool, `${at}.tool`)
    // A click that edits a field runs at once: a tool that can park for approval is not reachable.
    if (def && (def.gated === true || def.conditionalGate === true)) {
      this.err(`${at}.tool`, `'${String(v.tool)}' is gated, and an edit cannot call a gated tool`)
    }
    this.paramPaths(v.params, TOP, `${at}.params`, def)
    if (typeof v.rowParam !== "string" || v.rowParam === "") {
      this.err(`${at}.rowParam`, "must be a parameter name")
    } else if (def) {
      this.paramNames(def, [v.rowParam], `${at}.rowParam`)
    }
    if (!this.array(v.fields, `${at}.fields`, LIMITS.fields)) return
    if (v.fields.length === 0) this.err(`${at}.fields`, "needs at least one field")
    v.fields.forEach((f, i) => {
      const here = `${at}.fields[${i}]`
      if (!this.object(f, here)) return
      this.keys(f, ["param", "label", "kind", "valuePath", "unitPath", "private"], here)
      if (typeof f.param !== "string" || f.param === "") {
        this.err(`${here}.param`, "must be a parameter name")
      } else if (def) {
        this.paramNames(def, [f.param], `${here}.param`)
      }
      this.label(f.label, `${here}.label`)
      if (f.kind !== "quantity" && f.kind !== "text") {
        this.err(`${here}.kind`, "must be quantity or text")
      }
      this.path(f.valuePath, ROW, `${here}.valuePath`)
      if (f.unitPath !== undefined) this.path(f.unitPath, ROW, `${here}.unitPath`)
      if (f.private !== undefined && typeof f.private !== "boolean") {
        this.err(`${here}.private`, "must be a boolean")
      }
    })
  }

  card(t: unknown): void {
    if (!this.object(t, "")) return
    const kind = t.kind
    if (!TOOL_CARD_KINDS.includes(kind as ToolCardKind)) {
      this.err(".kind", `'${String(kind)}' is not a card kind (${TOOL_CARD_KINDS.join(", ")})`)
      return
    }
    const k = kind as ToolCardKind
    this.keys(t, ["kind", "pill", "icon", "when", ...KIND_KEYS[k]], "")
    this.label(t.pill, ".pill")
    if (t.icon !== undefined) this.icon(t.icon, ".icon")
    if (t.when !== undefined) this.cond(t.when, TOP, ".when")
    for (const key of REQUIRED_KEYS[k]) {
      if (t[key] === undefined) this.err(`.${key}`, `is required on a ${k} card`)
    }
    if (this.returns === undefined) {
      this.err("", "needs the tool to declare returns.schema, so each path can be checked")
    }
    this.header(t)
    if (k === "entity") this.entity(t)
    if (k === "list") this.list(t)
    if (k === "number") this.number(t)
    if (k === "groups") this.groups(t)
  }
}

/** Every deep error of every tool's `resultCard`, each naming the tool and the JSON path. */
export function resultCardErrors(manifest: { tools?: unknown }): string[] {
  if (!isObj(manifest.tools)) return []
  const tools = manifest.tools as Record<string, ToolDef>
  const errors: string[] = []
  for (const [name, tool] of Object.entries(manifest.tools)) {
    if (!isObj(tool) || tool.resultCard === undefined) continue
    const check = new CardCheck(name, tools)
    check.card(tool.resultCard)
    errors.push(...check.errors)
  }
  return errors
}

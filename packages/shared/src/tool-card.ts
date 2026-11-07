// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's result card. An app declares a `CardTemplate` on a tool (data only: paths into the
// tool's result and fixed labels, never code); the server resolves it against the result into a
// `ResolvedCard`, which is stored with the call and drawn by the chat on any device.

/** Resolved card size bounds, in bytes of JSON. Over the bound, there is no card. */
export const TOOL_CARD_MAX_BYTES = 4096
export const TOOL_CARD_GROUPS_MAX_BYTES = 24_576
/** Rows a `groups` card holds across all its groups. */
export const TOOL_CARD_GROUPS_MAX_ROWS = 40

export const TOOL_CARD_KINDS = ["entity", "list", "number", "groups"] as const
export type ToolCardKind = (typeof TOOL_CARD_KINDS)[number]

export const TOOL_CARD_FORMATS = [
  "money",
  "date",
  "datetime",
  "relative",
  "number",
  "percent",
  "hours",
] as const
export type CardFormat = (typeof TOOL_CARD_FORMATS)[number]

export const TOOL_CARD_TONES = ["success", "warning", "muted", "accent"] as const
export type CardTone = (typeof TOOL_CARD_TONES)[number]

/** A fixed label, with the catalog key a translation is looked up by. */
export interface CardLabel {
  label: string
  labelKey?: string
}

/** `result.a.b`; inside lists `item.a`; inside a `groups` card `group.a` or `row.a` as well. */
export type CardPath = string
/** Literal text with `{{path}}` placeholders and nothing else: no expression, helper or HTML. */
export type CardTpl = string

export interface CardCond {
  path: CardPath
  equals?: string
  exists?: boolean
}

export interface CardOpen {
  view: string
  idPath?: CardPath
}

export type CardAction =
  | { kind: "open"; label: CardLabel; view: string; idPath?: CardPath; when?: CardCond }
  | {
      kind: "tool"
      label: CardLabel
      tool: string
      params: Record<string, CardPath>
      confirm?: CardLabel
      primary?: boolean
      when?: CardCond
    }
  | { kind: "ask"; label: CardLabel; prompt: CardTpl; when?: CardCond }
  | { kind: "external"; label: CardLabel; urlTemplate: string; when?: CardCond }

export interface CardGroupRow {
  path: CardPath
  id: CardPath
  name: CardTpl
  tag?: CardTpl
  flag?: CardPath
  why?: CardTpl
  cells: Record<string, CardPath>
  links?: {
    path: CardPath
    label: CardTpl
    open?: CardOpen
    urlPath?: CardPath
    limit?: number
  }
  act?: CardAction & { when?: CardCond; labelPath?: CardPath }
}

export interface CardTemplate {
  kind: ToolCardKind
  pill: CardLabel
  icon?: string
  when?: CardCond
  ref?: CardTpl
  title?: CardTpl
  sub?: CardTpl
  end?: CardTpl
  foot?: CardTpl | CardLabel
  open?: { view: string; idPath: CardPath }
  status?: {
    path: CardPath
    map: Record<string, { label: CardLabel; tone: CardTone }>
  }
  rows?: {
    label: CardLabel
    value: CardTpl
    format?: CardFormat
    mono?: boolean
    warnWhen?: CardCond
    open?: CardOpen
  }[]
  actions?: CardAction[]
  items?: {
    path: CardPath
    label: CardTpl
    meta?: CardTpl
    num?: CardTpl
    numFormat?: CardFormat
    open?: CardOpen
    limit?: number
  }
  more?: { label: CardLabel; open: { view: string } }
  // number
  value?: CardTpl
  valueFormat?: CardFormat
  delta?: CardTpl
  how?: CardLabel
  source?: CardTpl
  // groups
  cover?: CardTpl
  notice?: { when?: CardCond; icon: string; title: CardTpl; text: CardTpl }
  columns?: { key: string; label: CardLabel; when?: CardCond; format?: CardFormat }[]
  groups?: { path: CardPath; label: CardTpl; rows: CardGroupRow }
  tot?: { path: CardPath; k: CardTpl; v: CardTpl; format?: CardFormat }
  notes?: { path: CardPath; icon?: CardPath; text: CardTpl }
  edit?: {
    when?: CardCond
    openLabel: CardLabel
    doneLabel: CardLabel
    tool: string
    params: Record<string, CardPath>
    rowParam: string
    fields: {
      param: string
      label: CardLabel
      kind: "quantity" | "text"
      valuePath: CardPath
      unitPath?: CardPath
      private?: boolean
    }[]
  }
  summary?: { when?: CardCond; text: CardTpl; actions?: CardAction[] }
  latestKey?: CardTpl
  supersededLabel?: CardLabel
}

/** A value that has a format stays typed: the viewer's client formats it in the viewer's locale. */
export type ResolvedCardValue =
  | string
  | { t: "money"; minor: number; currency: string }
  | { t: "date"; iso: string }
  | { t: "datetime"; iso: string }
  | { t: "relative"; iso: string }
  | { t: "number"; n: number }
  | { t: "percent"; n: number }
  | { t: "hours"; minutes: number }

export interface ResolvedCardOpen {
  view: string
  id?: string
}

export type ResolvedCardAction =
  | { kind: "open"; label: CardLabel; view: string; id?: string }
  | {
      kind: "tool"
      label: CardLabel
      tool: string
      params: Record<string, string | number>
      confirm?: CardLabel
      primary?: true
    }
  | { kind: "ask"; label: CardLabel; prompt: string }
  | { kind: "external"; label: CardLabel; url: string }

export interface ResolvedCardGroupRow {
  id: string
  name: string
  tag?: string
  flag?: true
  why?: string
  cells: Record<string, ResolvedCardValue>
  links: { label: string; open?: ResolvedCardOpen; url?: string }[]
  act?: ResolvedCardAction
  /** Current value of each editable field, by tool parameter. */
  edit?: Record<string, { value: string | number; unit?: string }>
}

export interface ResolvedCard {
  kind: ToolCardKind
  pill: CardLabel
  icon?: string
  ref?: string
  title?: string
  sub?: string
  end?: string
  foot?: string | CardLabel
  open?: ResolvedCardOpen
  status?: { label: CardLabel; tone: CardTone }
  rows?: {
    label: CardLabel
    value: ResolvedCardValue
    mono?: true
    warn?: true
    open?: ResolvedCardOpen
  }[]
  actions?: ResolvedCardAction[]
  items?: {
    label: string
    meta?: string
    num?: ResolvedCardValue
    open?: ResolvedCardOpen
  }[]
  more?: { label: CardLabel; view: string }
  value?: ResolvedCardValue
  delta?: string
  how?: CardLabel
  source?: string
  cover?: string
  notice?: { icon: string; title: string; text: string }
  columns?: { key: string; label: CardLabel; format?: CardFormat }[]
  groups?: { label: string; rows: ResolvedCardGroupRow[] }[]
  tot?: { k: string; v: ResolvedCardValue }[]
  notes?: { icon?: string; text: string }[]
  edit?: {
    openLabel: CardLabel
    doneLabel: CardLabel
    tool: string
    params: Record<string, string | number>
    rowParam: string
    fields: {
      param: string
      label: CardLabel
      kind: "quantity" | "text"
      private?: true
    }[]
  }
  summary?: { text: string; actions: ResolvedCardAction[] }
  latestKey?: string
  supersededLabel?: CardLabel
}

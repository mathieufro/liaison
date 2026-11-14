// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A TOOL RESULT'S CARD, drawn under the call's row.
//
// The server resolved the card from the tool's own result when the call returned and stored it
// with the call, so this draws the same thing live, after a reload and on a phone, with no app
// bundle loaded and no app-specific branch. Every value is a Solid text node: nothing from a
// result is ever parsed as markup. A link opens a registered view, or an `https:` address; any
// other target reads as text.
//
// A card action and an inline edit call `POST /api/apps/:app/tools/:tool` with the stored card
// they came from (`cardRef`), so the server can check the call is one the card offers, at the
// revision drawn, and replace the stored card from the tool's answer. A refusal keeps what the
// person typed and shows the server's own words.

import type {
  CardLabel,
  ResolvedCard,
  ResolvedCardAction,
  ResolvedCardGroupRow,
  ResolvedCardOpen,
  ResolvedCardValue,
} from "@liaison/shared"
import { type Component, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { getTabType } from "~/framework/app-registry"
import { ApiError } from "~/lib/api-error"
import { formatToolName } from "~/modules/agent/format-tool-name"
import { userFromToken } from "~/modules/auth/auth-store"
import {
  catalogHasKey,
  currentLocale,
  type Translate,
  type TranslateParams,
  useI18n,
} from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import {
  findToolCallMessage,
  replaceStoredToolCard,
  sendMessage,
  type ToolCallState,
} from "~/modules/threads/message-store"

/** A failed call, live (the frame's `result.error`) and stored (`status: "error"`) alike. */
export function toolCallFailed(tc: ToolCallState): boolean {
  if (tc.status === "error") return true
  const r = tc.result
  return r !== null && typeof r === "object" && (r as { error?: unknown }).error != null
}

/** A call whose row draws a result card (or a card's error) instead of its line. */
export function hasToolCard(tc: ToolCallState): boolean {
  return !!tc.card || (!!tc.cardError && toolCallFailed(tc))
}

/** The app and tool of a stored or live tool name (`app__tool`, `app:tool`). */
export function appAndTool(toolName: string): { app: string; tool: string } | null {
  for (const sep of ["__", ":"]) {
    const at = toolName.indexOf(sep)
    if (at > 0) return { app: toolName.slice(0, at), tool: toolName.slice(at + sep.length) }
  }
  return null
}

/** A fixed label, translated when the catalog knows its key. */
export function cardLabel(label: CardLabel | string | undefined, t: Translate): string {
  if (label === undefined) return ""
  if (typeof label === "string") return label
  return label.labelKey && catalogHasKey(label.labelKey) ? t(label.labelKey) : label.label
}

/** A typed value in the viewer's locale. The thread is read by people in several. */
export function formatCardValue(value: ResolvedCardValue | undefined, locale: string): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    switch (value.t) {
      case "money": {
        const nf = new Intl.NumberFormat(locale, { style: "currency", currency: value.currency })
        const digits = nf.resolvedOptions().maximumFractionDigits ?? 2
        return nf.format(value.minor / 10 ** digits)
      }
      case "date":
        // A calendar date has no zone: read and written in UTC so it never moves a day.
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(`${value.iso}T00:00:00Z`),
        )
      case "datetime":
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(value.iso),
        )
      case "relative":
        return relativeFrom(new Date(value.iso).getTime(), Date.now(), locale)
      case "number":
        return new Intl.NumberFormat(locale).format(value.n)
      case "percent":
        // The tool's figure is in percent points: 12.5 reads 12.5 %.
        return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
          value.n / 100,
        )
      case "hours":
        return `${new Intl.NumberFormat(locale).format(Math.round(value.minutes / 60))} h`
    }
  } catch {
    // An unknown currency or a bad date: the raw figure, never an empty cell.
  }
  return JSON.stringify(value)
}

function relativeFrom(then: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const minutes = Math.round((then - now) / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour")
  return rtf.format(Math.round(hours / 24), "day")
}

/** Only an `https:` address is a link; anything else (http, javascript, data) is text. */
export function safeHttpsUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === "https:" ? url : null
  } catch {
    return null
  }
}

const TONE_CLASS: Record<string, string> = {
  success: "bg-green-500/10 text-green-600",
  warning: "bg-amber-500/10 text-amber-600",
  muted: "bg-surface-hover text-text-tertiary",
  accent: "bg-accent-glow text-accent",
}

// Each card is its own container: its cells stack or sit side by side by the card's width, not
// the window's. `data-tool-card` on the article gives its disclosures and links the 44px touch
// floor at the compact tiers (index.css), as buttons and fields already have.
const ARTICLE = "mt-1 rounded-md border border-border bg-surface text-[13px] @container"
const PILL =
  "rounded-full bg-surface-hover px-1.5 py-px text-[10.5px] font-medium text-text-secondary"
const BTN =
  "rounded-sm border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50"
const BTN_PRIMARY =
  "rounded-sm border border-accent-border bg-accent-glow px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent-wash disabled:pointer-events-none disabled:opacity-50"

/** A label that opens a registered view, or plain text when the view is not here. */
const OpenLink: Component<{ open?: ResolvedCardOpen; label: string; class?: string }> = (props) => {
  const view = () => (props.open && getTabType(props.open.view) ? props.open : null)
  return (
    <Show when={view()} fallback={<span class={props.class}>{props.label}</span>}>
      {(open) => (
        <button
          type="button"
          data-testid="card-open"
          class={`text-left text-accent hover:underline ${props.class ?? ""}`}
          onClick={() =>
            openTab({ type: open().view, entityId: open().id ?? "", label: props.label })
          }
        >
          {props.label}
        </button>
      )}
    </Show>
  )
}

interface CardActionsProps {
  actions: ResolvedCardAction[]
  run: (action: ResolvedCardAction, key: string) => void
  busy: string | null
  confirming: string | null
  setConfirming: (key: string | null) => void
  disabled: boolean
  keyPrefix: string
}

/** A card's buttons. A gated call asks its own question first, inline: no dialog. */
const CardActions: Component<CardActionsProps> = (props) => {
  const i18n = useI18n()
  return (
    <div class="flex flex-wrap items-center gap-1.5" data-testid="card-actions">
      <For each={props.actions}>
        {(action, i) => {
          const key = () => `${props.keyPrefix}${i()}`
          const label = () => cardLabel(action.label, i18n.t)
          if (action.kind === "external") {
            const url = safeHttpsUrl(action.url)
            return url ? (
              <a
                class={BTN}
                data-testid="card-action"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {label()}
              </a>
            ) : (
              <span class="text-xs text-text-tertiary">{label()}</span>
            )
          }
          if (action.kind === "open") {
            return (
              <OpenLink
                open={{ view: action.view, ...(action.id ? { id: action.id } : {}) }}
                label={label()}
                class="text-xs font-medium"
              />
            )
          }
          const confirm = action.kind === "tool" ? action.confirm : undefined
          return (
            <Show
              when={confirm && props.confirming === key()}
              fallback={
                <button
                  type="button"
                  data-testid="card-action"
                  class={action.kind === "tool" && action.primary ? BTN_PRIMARY : BTN}
                  disabled={props.disabled || props.busy !== null}
                  aria-busy={props.busy === key() || undefined}
                  onClick={() => (confirm ? props.setConfirming(key()) : props.run(action, key()))}
                >
                  {label()}
                </button>
              }
            >
              <span class="flex flex-wrap items-center gap-1.5" data-testid="card-confirm">
                <span class="text-xs text-text-secondary">{cardLabel(confirm, i18n.t)}</span>
                <button
                  type="button"
                  data-testid="card-confirm-yes"
                  class={BTN_PRIMARY}
                  disabled={props.busy !== null}
                  onClick={() => {
                    props.setConfirming(null)
                    props.run(action, key())
                  }}
                >
                  {i18n.t("kernel.toolCard.confirm")}
                </button>
                <button
                  type="button"
                  data-testid="card-confirm-cancel"
                  class={BTN}
                  onClick={() => props.setConfirming(null)}
                >
                  {i18n.t("kernel.toolCard.cancel")}
                </button>
              </span>
            </Show>
          )
        }}
      </For>
    </div>
  )
}

/** What a card action's call answered: the replaced card, a park, or nothing to draw. */
interface ToolAnswer {
  data?: unknown
  meta?: { card?: ResolvedCard | null; cardRevision?: number | null }
}

/** The words a refusal carries, for the person: the server's own, else a fixed line. */
function refusalText(err: unknown, t: Translate, fallbackKey: string): string {
  if (err instanceof ApiError && err.status > 0 && err.message && err.message !== "Request failed")
    return err.message
  return t(fallbackKey)
}

/** The latest card a `card_changed` refusal carries. */
function changedCard(err: unknown): { card: ResolvedCard; revision?: number } | null {
  if (!(err instanceof ApiError) || err.code !== "card_changed") return null
  const card = err.details?.card
  if (!card || typeof card !== "object") return null
  const revision = err.details?.cardRevision
  return {
    card: card as ResolvedCard,
    ...(typeof revision === "number" ? { revision } : {}),
  }
}

const isBlocked = (data: unknown) =>
  !!data && typeof data === "object" && (data as { blocked?: unknown }).blocked != null

export interface ToolCardProps {
  toolCall: ToolCallState
}

/** The card of one tool call: its result card, its error card, or nothing. */
export const ToolCard: Component<ToolCardProps> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const locale = () => currentLocale()
  // A replace the action's own answer carried, until the stored copy catches up.
  const [local, setLocal] = createSignal<{ card: ResolvedCard; revision: number } | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [retried, setRetried] = createSignal<"running" | "answered" | null>(null)
  const [editOpen, setEditOpen] = createSignal(false)
  const [drafts, setDrafts] = createStore<Record<string, string | undefined>>({})
  const [fieldNotes, setFieldNotes] = createStore<Record<string, string | undefined>>({})

  const storedRevision = () => props.toolCall.cardRevision ?? 1
  const card = (): ResolvedCard | undefined => {
    const mine = local()
    if (mine && mine.revision > storedRevision()) return mine.card
    return props.toolCall.card ?? mine?.card
  }
  const revision = () => Math.max(storedRevision(), local()?.revision ?? 0)
  const target = () => appAndTool(props.toolCall.toolName)
  /** The stored message, once the turn has ended: a card action names it. */
  const stored = () => findToolCallMessage(props.toolCall.toolCallId)
  const superseded = () => props.toolCall.cardSuperseded === true && !local()

  const t = (key: string, params?: TranslateParams) => i18n.t(key, params)

  async function post(tool: string, params: Record<string, unknown>, withRef: boolean) {
    const app = target()?.app
    if (!api || !app) throw new ApiError(t("kernel.toolCard.unreachable"), 0)
    const where = stored()
    const body: Record<string, unknown> = { params }
    if (withRef && where) {
      body.cardRef = {
        messageId: where.messageId,
        toolCallId: props.toolCall.toolCallId,
        revision: revision(),
      }
    }
    const res = await api.rawPost(
      `/apps/${encodeURIComponent(app)}/tools/${encodeURIComponent(tool)}`,
      body,
      { suppressGlobalError: true },
    )
    return (await res.json().catch(() => ({}))) as ToolAnswer
  }

  /** Draw the card an answer or a refusal carried, here and on the stored message. */
  function takeCard(next: ResolvedCard, nextRevision: number | undefined) {
    const rev = nextRevision ?? revision() + 1
    setLocal({ card: next, revision: rev })
    const where = stored()
    if (where) {
      replaceStoredToolCard(where.threadId, where.messageId, props.toolCall.toolCallId, next, rev)
    }
  }

  async function runAction(action: ResolvedCardAction, key: string) {
    if (busy() !== null) return
    setNotice(null)
    if (action.kind === "ask") {
      const where = stored()
      const user = userFromToken()
      if (!api || !where || !user) return
      setBusy(key)
      try {
        await sendMessage(api, where.threadId, action.prompt, { id: user.userId, name: user.name })
      } catch (err) {
        setNotice(refusalText(err, t, "kernel.toolCard.actionUnreachable"))
      } finally {
        setBusy(null)
      }
      return
    }
    if (action.kind !== "tool") return
    setBusy(key)
    try {
      const answer = await post(action.tool, action.params, true)
      if (isBlocked(answer.data)) setNotice(t("kernel.toolCard.waitingApproval"))
      const next = answer.meta?.card
      if (next) takeCard(next, answer.meta?.cardRevision ?? undefined)
    } catch (err) {
      const latest = changedCard(err)
      if (latest) takeCard(latest.card, latest.revision)
      setNotice(refusalText(err, t, "kernel.toolCard.actionUnreachable"))
    } finally {
      setBusy(null)
    }
  }

  /** One field of one row, as typed: the call carries that field alone. */
  async function sendField(row: ResolvedCardGroupRow, param: string, kind: "quantity" | "text") {
    const edit = card()?.edit
    if (!edit) return
    const key = `${row.id}:${param}`
    const typed = drafts[key]
    if (typed === undefined) return
    const current = row.edit?.[param]?.value
    if (String(current ?? "") === typed) return
    const value = kind === "quantity" && typed.trim() !== "" ? Number(typed) : typed
    setFieldNotes(key, undefined)
    setBusy(key)
    try {
      const answer = await post(
        edit.tool,
        { ...edit.params, [edit.rowParam]: row.id, [param]: value },
        true,
      )
      const next = answer.meta?.card
      if (next) {
        takeCard(next, answer.meta?.cardRevision ?? undefined)
        setDrafts(key, undefined)
      }
    } catch (err) {
      // The text stays as typed whatever the refusal: the person fixes it or leaves.
      const latest = changedCard(err)
      if (latest) takeCard(latest.card, latest.revision)
      setFieldNotes(
        key,
        err instanceof ApiError && err.status > 0
          ? refusalText(err, t, "kernel.toolCard.notSaved")
          : t("kernel.toolCard.notSaved"),
      )
    } finally {
      setBusy(null)
    }
  }

  async function retry() {
    const tool = target()?.tool
    if (!tool || busy() !== null) return
    setNotice(null)
    setBusy("retry")
    setRetried("running")
    try {
      // The same arguments the agent sent. A failed call has no card to replace, so no cardRef.
      const args =
        props.toolCall.args && typeof props.toolCall.args === "object" ? props.toolCall.args : {}
      const answer = await post(tool, args as Record<string, unknown>, false)
      const next = answer.meta?.card
      if (next) setLocal({ card: next, revision: revision() + 1 })
      setRetried("answered")
    } catch (err) {
      setRetried(null)
      setNotice(refusalText(err, t, "kernel.toolCard.actionUnreachable"))
    } finally {
      setBusy(null)
    }
  }

  const actionProps = (actions: ResolvedCardAction[], keyPrefix: string) => ({
    actions,
    run: (a: ResolvedCardAction, k: string) => void runAction(a, k),
    busy: busy(),
    confirming: confirming(),
    setConfirming,
    disabled: !stored(),
    keyPrefix,
  })

  const Notice = () => (
    <Show when={notice()}>
      {(text) => (
        <p class="mt-1.5 text-xs text-text-secondary" role="status" data-testid="card-notice">
          {text()}
        </p>
      )}
    </Show>
  )

  const errorMessage = () => {
    const e = (props.toolCall.result as { error?: unknown } | undefined)?.error
    if (typeof e === "string" && e) return e
    if (e && typeof e === "object") {
      const m = (e as { message?: unknown }).message
      if (typeof m === "string" && m) return m
    }
    return t("kernel.toolCard.noReason")
  }

  const Top = (p: { c: ResolvedCard; children?: JSX.Element }) => (
    <div class="flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
      <span class={PILL} data-testid="card-pill">
        {cardLabel(p.c.pill, i18n.t)}
      </span>
      <Show when={p.c.ref}>{(ref) => <span class="font-mono">{ref()}</span>}</Show>
      <Show when={p.c.status}>
        {(status) => (
          <span
            data-testid="card-status"
            class={`rounded-full px-1.5 py-px text-[10.5px] font-medium ${TONE_CLASS[status().tone] ?? ""}`}
          >
            {cardLabel(status().label, i18n.t)}
          </span>
        )}
      </Show>
      {p.children}
      <Show when={p.c.end}>{(end) => <span class="ml-auto">{end()}</span>}</Show>
    </div>
  )

  const Foot = (p: { c: ResolvedCard }) => (
    <Show when={p.c.foot}>
      {(foot) => (
        <div class="border-t border-border-subtle px-3 py-1.5 text-xs text-text-tertiary">
          {cardLabel(foot(), i18n.t)}
        </div>
      )}
    </Show>
  )

  const Entity = (p: { c: ResolvedCard }) => (
    <article class={ARTICLE} data-tool-card data-testid="card-entity">
      <div class="px-3 py-2.5">
        <Top c={p.c} />
        <OpenLink
          open={p.c.open}
          label={p.c.title ?? ""}
          class="mt-1 block font-medium text-text"
        />
        <Show when={p.c.sub}>
          {(sub) => <p class="mt-0.5 text-xs text-text-secondary">{sub()}</p>}
        </Show>
        <Show when={p.c.rows?.length}>
          <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs @sm:grid-cols-[auto_1fr]">
            <For each={p.c.rows}>
              {(row) => (
                <>
                  <dt class="text-text-tertiary">{cardLabel(row.label, i18n.t)}</dt>
                  <dd
                    data-testid="card-row-value"
                    class={`mb-1 min-w-0 break-words last:mb-0 @sm:mb-0 ${row.mono ? "font-mono" : ""} ${row.warn ? "text-amber-600" : "text-text-secondary"}`}
                  >
                    <OpenLink open={row.open} label={formatCardValue(row.value, locale())} />
                  </dd>
                </>
              )}
            </For>
          </dl>
        </Show>
        <Show when={p.c.actions?.length}>
          <div class="mt-2.5">
            <CardActions {...actionProps(p.c.actions ?? [], "a")} />
          </div>
        </Show>
        <Notice />
      </div>
      <Foot c={p.c} />
    </article>
  )

  const List = (p: { c: ResolvedCard }) => (
    <article class={ARTICLE} data-tool-card data-testid="card-list">
      <div class="px-3 py-2.5">
        <Top c={p.c}>
          <span class="font-medium text-text">{p.c.title}</span>
        </Top>
        <ul class="mt-1.5 flex flex-col gap-1 text-xs">
          <For each={p.c.items}>
            {(item) => (
              <li class="flex min-w-0 items-baseline gap-2" data-testid="card-list-item">
                <OpenLink open={item.open} label={item.label} class="min-w-0 truncate" />
                <Show when={item.meta}>
                  {(meta) => <span class="text-text-tertiary">{meta()}</span>}
                </Show>
                <Show when={item.num !== undefined}>
                  <span class="ml-auto shrink-0 tabular-nums text-text-secondary">
                    {formatCardValue(item.num, locale())}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={p.c.more}>
          {(more) => (
            <div class="mt-1.5 text-xs">
              <OpenLink open={{ view: more().view }} label={cardLabel(more().label, i18n.t)} />
            </div>
          )}
        </Show>
        <Show when={p.c.actions?.length}>
          <div class="mt-2.5">
            <CardActions {...actionProps(p.c.actions ?? [], "a")} />
          </div>
        </Show>
        <Notice />
      </div>
      <Foot c={p.c} />
    </article>
  )

  const NumberCard = (p: { c: ResolvedCard }) => (
    <article class={ARTICLE} data-tool-card data-testid="card-number">
      <div class="px-3 py-2.5">
        <Top c={p.c}>
          <span class="text-text-secondary">{p.c.title}</span>
        </Top>
        <div class="mt-1 flex items-baseline gap-2">
          <span class="text-[20px] font-semibold tabular-nums text-text" data-testid="card-value">
            {formatCardValue(p.c.value, locale())}
          </span>
          <Show when={p.c.delta}>
            {(delta) => <span class="text-xs text-text-tertiary">{delta()}</span>}
          </Show>
        </div>
        <Show when={p.c.sub}>
          {(sub) => <p class="mt-0.5 text-xs text-text-secondary">{sub()}</p>}
        </Show>
        <Show when={p.c.how}>
          {(how) => (
            <details class="mt-1.5 text-xs text-text-secondary">
              <summary class="cursor-pointer">{t("kernel.toolCard.howWorkedOut")}</summary>
              <p class="mt-1" data-testid="card-how">
                {cardLabel(how(), i18n.t)}
              </p>
            </details>
          )}
        </Show>
        <Show when={p.c.actions?.length}>
          <div class="mt-2.5">
            <CardActions {...actionProps(p.c.actions ?? [], "a")} />
          </div>
        </Show>
        <Notice />
      </div>
      <div
        class="border-t border-border-subtle px-3 py-1.5 text-xs text-text-tertiary"
        data-testid="card-source"
      >
        {t("kernel.toolCard.source", { source: p.c.source ?? "" })}
      </div>
    </article>
  )

  const GroupRow = (p: { c: ResolvedCard; row: ResolvedCardGroupRow }) => {
    const columns = () => p.c.columns ?? []
    const editing = () => editOpen() && !!p.row.edit && !!p.c.edit
    return (
      <li
        class="flex flex-col gap-0.5 border-t border-border-subtle py-1.5 first:border-t-0 @md:grid @md:grid-cols-[minmax(0,2fr)_repeat(var(--card-cols),minmax(0,1fr))] @md:items-baseline @md:gap-x-3"
        style={{ "--card-cols": String(Math.max(columns().length, 1)) }}
        data-testid="card-group-row"
        data-row-id={p.row.id}
      >
        <div class="min-w-0" data-testid="card-row-name">
          <span class="font-medium text-text">{p.row.name}</span>
          <Show when={p.row.tag}>{(tag) => <span class={`ml-1.5 ${PILL}`}>{tag()}</span>}</Show>
          <Show when={p.row.why}>{(why) => <p class="text-xs text-text-tertiary">{why()}</p>}</Show>
          <Show when={p.row.links.length}>
            <div class="mt-0.5 flex flex-wrap gap-x-2 text-xs">
              <For each={p.row.links}>
                {(link) => {
                  const url = safeHttpsUrl(link.url)
                  return url ? (
                    <a
                      class="text-accent hover:underline"
                      data-testid="card-row-link"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <OpenLink open={link.open} label={link.label} />
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
        <For each={columns()}>
          {(col) => {
            const field = () => p.c.edit?.fields.find((f) => f.param === col.key)
            const fieldKey = () => `${p.row.id}:${col.key}`
            return (
              <div
                class="flex min-w-0 justify-between gap-2 text-xs text-text-secondary @md:block @md:text-right"
                data-testid="card-cell"
                data-column={col.key}
              >
                <span class="text-text-tertiary @md:hidden" data-testid="card-cell-label">
                  {cardLabel(col.label, i18n.t)}
                </span>
                <Show
                  when={editing() && field() && p.row.edit?.[col.key] !== undefined}
                  fallback={
                    <span class="tabular-nums">
                      {formatCardValue(p.row.cells[col.key], locale())}
                    </span>
                  }
                >
                  <span class="flex flex-col items-end gap-0.5">
                    <input
                      data-testid="card-edit-field"
                      data-param={col.key}
                      aria-label={`${p.row.name}: ${cardLabel(field()?.label, i18n.t)}`}
                      class="w-20 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-right text-xs"
                      inputmode={field()?.kind === "quantity" ? "decimal" : "text"}
                      autocomplete="off"
                      value={drafts[fieldKey()] ?? String(p.row.edit?.[col.key]?.value ?? "")}
                      disabled={busy() === fieldKey() || !stored()}
                      onInput={(e) => setDrafts(fieldKey(), e.currentTarget.value)}
                      onChange={() => void sendField(p.row, col.key, field()?.kind ?? "text")}
                    />
                    <Show when={fieldNotes[fieldKey()]}>
                      {(note) => (
                        <span class="text-[11px] text-amber-600" data-testid="card-field-note">
                          {note()}
                        </span>
                      )}
                    </Show>
                  </span>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={p.row.act}>
          {(act) => (
            <div class="@md:col-span-full">
              <CardActions {...actionProps([act()], `r:${p.row.id}:`)} />
            </div>
          )}
        </Show>
      </li>
    )
  }

  const Groups = (p: { c: ResolvedCard }) => (
    <article class={ARTICLE} data-tool-card data-testid="card-groups">
      <div class="px-3 py-2.5">
        <Top c={p.c}>
          <span class="font-medium text-text">{p.c.title}</span>
        </Top>
        <Show when={p.c.cover}>
          {(cover) => <p class="mt-0.5 text-xs text-text-tertiary">{cover()}</p>}
        </Show>
        <Show when={p.c.notice}>
          {(n) => (
            <div class="mt-1.5 rounded-sm bg-surface-hover px-2 py-1.5 text-xs" role="note">
              <span class="font-medium text-text">{n().title}</span>
              <span class="ml-1 text-text-secondary">{n().text}</span>
            </div>
          )}
        </Show>
        <Show
          when={!p.c.summary}
          fallback={
            <div class="mt-1.5 text-xs" data-testid="card-summary">
              <p class="text-text-secondary">{p.c.summary?.text}</p>
              <Show when={p.c.summary?.actions.length}>
                <div class="mt-1.5">
                  <CardActions {...actionProps(p.c.summary?.actions ?? [], "s")} />
                </div>
              </Show>
            </div>
          }
        >
          <Show when={p.c.edit}>
            {(edit) => (
              <div class="mt-1.5 flex justify-end">
                <button
                  type="button"
                  data-testid="card-edit-toggle"
                  class={BTN}
                  aria-pressed={editOpen()}
                  onClick={() => setEditOpen((v) => !v)}
                >
                  {cardLabel(editOpen() ? edit().doneLabel : edit().openLabel, i18n.t)}
                </button>
              </div>
            )}
          </Show>
          <For each={p.c.groups}>
            {(group) => (
              <section class="mt-2" data-testid="card-group">
                {/* The group's name, then each column's heading over its figures (wide card). */}
                <div
                  class="@md:grid @md:grid-cols-[minmax(0,2fr)_repeat(var(--card-cols),minmax(0,1fr))] @md:items-baseline @md:gap-x-3"
                  style={{ "--card-cols": String(Math.max((p.c.columns ?? []).length, 1)) }}
                >
                  <h4 class="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                    {group.label}
                  </h4>
                  <For each={p.c.columns ?? []}>
                    {(col) => (
                      <span
                        class="hidden text-right text-[11px] text-text-tertiary @md:block"
                        data-testid="card-column-heading"
                        data-column={col.key}
                      >
                        {cardLabel(col.label, i18n.t)}
                      </span>
                    )}
                  </For>
                </div>
                <ul class="mt-0.5">
                  <For each={group.rows}>{(row) => <GroupRow c={p.c} row={row} />}</For>
                </ul>
              </section>
            )}
          </For>
        </Show>
        <Show when={p.c.tot?.length}>
          <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 border-t border-border-subtle pt-1.5 text-xs">
            <For each={p.c.tot}>
              {(tot) => (
                <div class="flex gap-1.5" data-testid="card-total">
                  <dt class="text-text-tertiary">{tot.k}</dt>
                  <dd class="font-medium tabular-nums text-text">
                    {formatCardValue(tot.v, locale())}
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
        <Show when={p.c.notes?.length}>
          <ul class="mt-1.5 flex flex-col gap-0.5 text-xs text-text-secondary">
            <For each={p.c.notes}>{(note) => <li data-testid="card-note">{note.text}</li>}</For>
          </ul>
        </Show>
        <Show when={p.c.actions?.length}>
          <div class="mt-2.5">
            <CardActions {...actionProps(p.c.actions ?? [], "a")} />
          </div>
        </Show>
        <Notice />
      </div>
      <Foot c={p.c} />
    </article>
  )

  const ErrorCard = () => (
    <article class={ARTICLE} data-tool-card data-testid="card-error" role="alert">
      <div class="px-3 py-2.5">
        <div class="flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
          <span class={PILL} data-testid="card-pill">
            {cardLabel(props.toolCall.cardError?.pill, i18n.t)}
          </span>
        </div>
        <div class="mt-1 font-medium text-text">
          {t("kernel.toolCard.errorTitle", { tool: formatToolName(props.toolCall.toolName) })}
        </div>
        <p class="mt-0.5 text-xs text-text-secondary" data-testid="card-error-message">
          {errorMessage()}
        </p>
        <Show when={props.toolCall.readOnly === true}>
          <div class="mt-2.5">
            <button
              type="button"
              data-testid="card-retry"
              class={BTN}
              disabled={busy() !== null}
              onClick={() => void retry()}
            >
              {t("kernel.toolCard.retry")}
            </button>
          </div>
        </Show>
        <Notice />
      </div>
    </article>
  )

  const Loading = () => (
    <article class={ARTICLE} data-tool-card data-testid="card-loading" aria-busy="true">
      <div class="flex items-center gap-1.5 px-3 py-2.5 text-xs text-text-tertiary">
        <span class={PILL}>{cardLabel(props.toolCall.cardError?.pill, i18n.t)}</span>
        <span>{t("kernel.toolCard.working")}</span>
      </div>
    </article>
  )

  return (
    <Switch>
      <Match when={retried() === "running"}>
        <Loading />
      </Match>
      <Match when={superseded() && props.toolCall.card}>
        {(c) => (
          <div
            class="mt-1 flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-tertiary"
            data-testid="card-superseded"
          >
            <span class={PILL}>{cardLabel(c().pill, i18n.t)}</span>
            <span>
              {c().supersededLabel
                ? cardLabel(c().supersededLabel, i18n.t)
                : t("kernel.toolCard.superseded")}
            </span>
          </div>
        )}
      </Match>
      <Match when={card()}>
        {(c) => (
          <Switch>
            <Match when={c().kind === "entity"}>
              <Entity c={c()} />
            </Match>
            <Match when={c().kind === "list"}>
              <List c={c()} />
            </Match>
            <Match when={c().kind === "number"}>
              <NumberCard c={c()} />
            </Match>
            <Match when={c().kind === "groups"}>
              <Groups c={c()} />
            </Match>
          </Switch>
        )}
      </Match>
      <Match when={retried() === "answered"}>
        <p class="mt-1 text-xs text-text-tertiary" data-testid="card-retried">
          {t("kernel.toolCard.answeredOnRetry")}
        </p>
      </Match>
      <Match when={props.toolCall.cardError && toolCallFailed(props.toolCall)}>
        <ErrorCard />
      </Match>
    </Switch>
  )
}

export default ToolCard

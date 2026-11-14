// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recurring schedule editor (`/invoicing/schedule/:scheduleId`, `new` for a new one), a tab.
// Actions at the top: Pause, Preview next invoice, and Save (an existing schedule) or Start (a
// new one). Sections: who invoices and the customer; when (repeats, billing date, ends, what each
// invoice covers, how it issues); how it is paid (bank transfer, or a card link URL), due terms and
// language; lines, where `{period}` becomes the dates an invoice covers; notes. The side column
// shows the totals, the next invoices with their draft days, how the number is taken, the last
// day to issue, and the errors.
//
// A customer who also pays a live Stripe subscription opens the conflict panel: Open their
// subscription, Pick another customer, or Bill something else, which asks one required line
// (what this schedule bills instead). Start stays disabled while the conflict is open and that
// line is not said. No invoice number shows before an invoice issues.
import { app, navigate, onEntityChange } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { periodLabel } from "../recurring/flags"
import {
  datesFrom,
  draftOn,
  periodKey,
  type Repeats,
  validateSchedule,
} from "../recurring/schedule"
import { ContactPicker, contactLabel, loadContact } from "./ContactPicker"
import { type EditorIssuerProfile, loadIssuerProfiles } from "./Editor"
import { tr } from "./i18n"
import { Button, formatMoneyMinor, inputClass } from "./kit"

const TAP = "min-h-11 md:min-h-8"
const BILLS_OTHER_MIN = 5

export interface ScheduleLineDraft {
  description: string
  qty: number
  unit_price_minor: number
  vat_bp: number
}

export interface ScheduleDraft {
  id: string | null
  status: string
  issuer_profile_id: string | null
  contact_id: string | null
  repeats: Repeats
  billing_day: string
  ends_on: string | null
  covers: "period_ended" | "period_ahead"
  issue_mode: "review" | "auto"
  paid_by: "transfer" | "card_link"
  card_link_url: string | null
  due_rule: "days_30" | "on_issue"
  language: "fr" | "en"
  lines: ScheduleLineDraft[]
  notes: string | null
  billsOtherThanStripe: string | null
  /** The version this draft was read at: a save says it, and a schedule saved since refuses it. */
  version: number
}

export function defaultSchedule(): ScheduleDraft {
  return {
    id: null,
    status: "draft",
    issuer_profile_id: null,
    contact_id: null,
    repeats: "month",
    billing_day: "last",
    ends_on: null,
    covers: "period_ended",
    issue_mode: "review",
    paid_by: "transfer",
    card_link_url: null,
    due_rule: "days_30",
    language: "fr",
    lines: [{ description: "", qty: 1, unit_price_minor: 0, vat_bp: 2000 }],
    notes: null,
    billsOtherThanStripe: null,
    version: 1,
  }
}

/** How the invoice number is taken: said in words, never a number before issue. */
export const NUMBER_LINE =
  "Taken the moment it issues: the next one in the series. Numbers run in order with none missing. A discarded draft uses none."

export interface Conflict {
  message: string
}

/** The open conflict a save refused with, when the customer already pays a Stripe subscription. */
export function conflictFrom(result: unknown): Conflict | null {
  const r = result as { status?: string; error?: { code?: string; message?: string } } | null
  if (r?.status === "error" && r.error?.code === "subscription_stream_conflict")
    return { message: r.error.message ?? "" }
  return null
}

function saidOther(d: ScheduleDraft): boolean {
  return (d.billsOtherThanStripe?.trim().length ?? 0) >= BILLS_OTHER_MIN
}

/** The lines error in the units the editor's fields take (a price, a percent), translated where shown. */
const LINES_ERROR =
  "add at least one line with a description, a quantity above zero, a price and a VAT rate from 0 to 100 %"

/** The schedule's own field errors, as the server would refuse them. */
export function draftErrors(d: ScheduleDraft): string[] {
  // The server speaks to agents in minor units and basis points; the editor's fields take a price
  // and a percent, so the lines error says it in those.
  const errors = validateSchedule({
    contact_id: d.contact_id ?? "",
    repeats: d.repeats,
    billing_day: d.billing_day,
    lines: d.lines,
  }).map((e) => (e.field === "lines" ? LINES_ERROR : e.message))
  if (!d.issuer_profile_id) errors.unshift("choose who invoices")
  if (d.paid_by === "card_link" && !/^https:\/\/\S+$/.test(d.card_link_url ?? ""))
    errors.push("give the card link, an https address")
  return errors
}

/** Whether Start (or Save) may run: never during an open conflict that nobody answered. */
export function editorActions(
  d: ScheduleDraft,
  conflict: Conflict | null,
): { startDisabled: boolean } {
  const blockedByConflict = conflict !== null && !saidOther(d)
  return { startDisabled: blockedByConflict || draftErrors(d).length > 0 }
}

/** The next issue days with their draft days. Never a number. */
export function nextInvoices(
  c: { repeats: Repeats; billing_day: string },
  today: string,
  n: number,
): Array<{ issueOn: string; draftOn: string }> {
  const out: Array<{ issueOn: string; draftOn: string }> = []
  let from = today
  try {
    for (let i = 0; i < n; i++) {
      const d = datesFrom(c, from)
      out.push({ issueOn: d.next_issue_on, draftOn: draftOn(d.next_issue_on) })
      const [y, m, day] = d.next_issue_on.split("-").map(Number) as [number, number, number]
      from = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10)
    }
  } catch {
    // A billing day that names no date: the errors column says so.
  }
  return out
}

/** A line as the next invoice prints it: `{period}` becomes the period that invoice bills. */
export function previewDescription(
  description: string,
  repeats: Repeats,
  issueOn: string | undefined,
): string {
  if (!issueOn) return description
  return description.split("{period}").join(periodLabel(periodKey(repeats, issueOn)))
}

/** The page and tab title: the customer's name once it is known. */
export function scheduleTitle(customer: string | null | undefined): string {
  return customer ? tr("Recurring: {{customer}}", { customer }) : tr("Recurring schedule")
}

/** The params of recurring_schedule_create (with a status) or recurring_schedule_update. */
export function scheduleParams(
  d: ScheduleDraft,
  status: "active" | "draft",
): Record<string, unknown> {
  const p: Record<string, unknown> = {
    issuer_profile_id: d.issuer_profile_id,
    contact_id: d.contact_id,
    repeats: d.repeats,
    billing_day: d.billing_day,
    ends_on: d.ends_on,
    covers: d.covers,
    issue_mode: d.issue_mode,
    paid_by: d.paid_by,
    due_rule: d.due_rule,
    language: d.language,
    notes: d.notes,
    lines: d.lines,
    status,
  }
  if (d.paid_by === "card_link" && d.card_link_url) p.card_link_url = d.card_link_url
  if (saidOther(d)) p.billsOtherThanStripe = d.billsOtherThanStripe?.trim()
  return p
}

/** An update sends only what changed, so a field the list does not carry (the notes) is never wiped. */
export function changedParams(
  before: ScheduleDraft,
  after: ScheduleDraft,
): Record<string, unknown> {
  const a = scheduleParams(before, "active")
  const b = scheduleParams(after, "active")
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(b)) {
    if (k === "issuer_profile_id" || k === "status") continue
    if (JSON.stringify(a[k]) !== JSON.stringify(v)) out[k] = v
  }
  return out
}

/** The invoice series an issuer numbers in, as a person reads it (`F-2026-`), or null when unknown. */
export function seriesOf(issuers: EditorIssuerProfile[], issuerId: string | null): string | null {
  const issuer = issuers.find((i) => i.id === issuerId) as
    | (EditorIssuerProfile & { prefix_invoice?: string | null })
    | undefined
  if (!issuer) return null
  const prefix =
    issuer.prefix_invoice?.replace("{YYYY}", String(new Date().getUTCFullYear())) ?? null
  return prefix
    ? tr("{{prefix}} then the next number, from {{issuer}}", { prefix, issuer: issuer.legal_name })
    : tr("The invoice series of {{issuer}}", { issuer: issuer.legal_name })
}

function lineTotal(l: ScheduleLineDraft): number {
  return Math.round(l.qty * l.unit_price_minor)
}

function totals(d: ScheduleDraft) {
  const sub = d.lines.reduce((a, l) => a + lineTotal(l), 0)
  const vat = d.lines.reduce((a, l) => a + Math.round((lineTotal(l) * l.vat_bp) / 10000), 0)
  return { sub, vat, total: sub + vat }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function loadSchedule(id: string): Promise<ScheduleDraft | null> {
  const r = await app.invokeTool<{ rows?: Array<Record<string, unknown>> }>("recurring_list", {
    limit: 200,
  })
  const row = r?.rows?.find((s) => s.id === id)
  return row ? draftFromRow(id, row) : null
}

/** The editor's draft of a schedule as `recurring_list` returns it. */
export function draftFromRow(id: string, row: Record<string, unknown>): ScheduleDraft {
  const base = defaultSchedule()
  return {
    ...base,
    id,
    status: String(row.status ?? "active"),
    issuer_profile_id: (row.issuer_profile_id as string) ?? null,
    contact_id: (row.contact_id as string) ?? null,
    repeats: (row.repeats as Repeats) ?? "month",
    billing_day: String(row.billing_day ?? "last"),
    ends_on: (row.ends_on as string | null) ?? null,
    covers: (row.covers as ScheduleDraft["covers"]) ?? base.covers,
    issue_mode: (row.issue_mode as ScheduleDraft["issue_mode"]) ?? "review",
    paid_by: (row.paid_by as ScheduleDraft["paid_by"]) ?? "transfer",
    card_link_url: (row.card_link_url as string | null) ?? null,
    due_rule: row.due_rule === "on_issue" ? "on_issue" : "days_30",
    language: row.language === "en" ? "en" : "fr",
    lines: Array.isArray(row.lines)
      ? (row.lines as ScheduleLineDraft[]).map((l) => ({
          ...l,
          unit_price_minor: Number(l.unit_price_minor),
        }))
      : base.lines,
    notes: (row.notes as string | null) ?? null,
    billsOtherThanStripe: (row.bills_other_than_stripe as string | null) ?? null,
    version: Number(row.version ?? 1),
  }
}

/** Whether the person has changed anything since the schedule was last read. */
export function hasEdits(saved: ScheduleDraft, draft: ScheduleDraft): boolean {
  return (
    Object.keys(changedParams(saved, draft)).length > 0 ||
    saved.billsOtherThanStripe !== draft.billsOtherThanStripe
  )
}

/** A save refused because someone else saved the schedule after it was opened. */
export function staleSaveFrom(result: unknown): boolean {
  const r = result as { status?: string; error?: { code?: string } } | null
  return r?.status === "error" && r.error?.code === "schedule_changed"
}

/** What the page says when another window saved the schedule: the new version, or the edits kept. */
export const CHANGED_ELSEWHERE =
  "Someone else just saved this schedule. The page shows what they saved."
export const CHANGED_UNDER_EDITS =
  "Someone else just saved this schedule. Your changes are still here; saving them will be refused and show what they saved."
export const STALE_SAVE =
  "Not saved: someone else saved this schedule after you opened it. The page now shows what they saved; make your change again on it."

function Section(p: { title: string; children: import("solid-js").JSX.Element; testid?: string }) {
  return (
    <section data-testid={p.testid} class="flex flex-col gap-3 border-b border-border-subtle pb-5">
      <h2 class="text-[13px] font-medium text-text">{p.title}</h2>
      {p.children}
    </section>
  )
}

function Choice<T extends string>(p: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  testid: string
}) {
  return (
    <div role="group" class="flex flex-wrap gap-1.5">
      <For each={p.options}>
        {(o) => (
          <button
            type="button"
            data-testid={`${p.testid}-${o.value}`}
            aria-pressed={p.value === o.value}
            onClick={() => p.onChange(o.value)}
            class={`rounded-md border px-3 text-[12.5px] ${TAP} ${p.value === o.value ? "border-accent bg-surface-active text-text" : "border-border-subtle text-text-secondary hover:text-text"}`}
          >
            {tr(o.label)}
          </button>
        )}
      </For>
    </div>
  )
}

const REPEATS_OPTIONS: ReadonlyArray<{ value: Repeats; label: string }> = [
  { value: "month", label: "Every month" },
  { value: "quarter", label: "Every quarter" },
  { value: "year", label: "Every year" },
]
const COVERS_OPTIONS = [
  { value: "period_ended", label: "The period just ended" },
  { value: "period_ahead", label: "The period ahead" },
] as const
const MODE_OPTIONS = [
  { value: "review", label: "After someone reviews a draft" },
  { value: "auto", label: "By itself" },
] as const
const PAID_OPTIONS = [
  { value: "transfer", label: "Bank transfer" },
  { value: "card_link", label: "Card link" },
] as const
const DUE_OPTIONS = [
  { value: "days_30", label: "30 days after issue" },
  { value: "on_issue", label: "On issue" },
] as const
const LANG_OPTIONS = [
  { value: "fr", label: "FR" },
  { value: "en", label: "EN" },
] as const

export const ScheduleEditor: Component<{ initial: ScheduleDraft }> = (props) => {
  const [d, setD] = createSignal<ScheduleDraft>(props.initial)
  // What the server holds: the base an update is diffed against, read again after each write.
  const [saved, setSaved] = createSignal<ScheduleDraft>(props.initial)
  const [contact] = createResource(
    () => d().contact_id || undefined,
    (id) => loadContact(id).catch(() => null),
  )
  const customer = () => {
    const c = contact()
    return c ? contactLabel(c) : null
  }
  // The tab names the customer, so several open schedules can be told apart.
  app.tabLabel(() => (customer() ? scheduleTitle(customer()) : null))
  const [conflict, setConflict] = createSignal<Conflict | null>(null)
  const [otherOpen, setOtherOpen] = createSignal(Boolean(props.initial.billsOtherThanStripe))
  const [note, setNote] = createSignal<string | null>(null)
  const [preview, setPreview] = createSignal(false)
  const [issuers] = createResource(loadIssuerProfiles)
  const patch = (p: Partial<ScheduleDraft>) => setD({ ...d(), ...p })
  const patchLine = (i: number, p: Partial<ScheduleLineDraft>) =>
    patch({ lines: d().lines.map((l, j) => (j === i ? { ...l, ...p } : l)) })
  const isNew = () => d().id === null
  const errors = () => draftErrors(d())
  const next = () => nextInvoices(d(), today(), 3)

  // After a write the page shows what the server now holds, never the state it had before.
  const reload = async () => {
    const id = d().id
    if (!id) return
    const fresh = await loadSchedule(id).catch(() => null)
    if (!fresh) return
    setSaved(fresh)
    setD(fresh)
  }

  // Another window (or an approved agent change) saved this schedule: show it, or keep the
  // person's own edits and say a save of them would be refused.
  // While this window saves, its own change is read back by the save itself.
  let saving = false
  onEntityChange("invoicing:recurring_schedule", (events) => {
    const id = d().id
    if (!id || saving) return
    const ours = events.some(
      (e) => e.resync || (e.data as { schedule_id?: string } | null)?.schedule_id === id,
    )
    if (!ours) return
    void (async () => {
      const fresh = await loadSchedule(id).catch(() => null)
      if (saving || !fresh || fresh.version === saved().version) return
      if (hasEdits(saved(), d())) {
        setNote(tr(CHANGED_UNDER_EDITS))
        return
      }
      setSaved(fresh)
      setD(fresh)
      setNote(tr(CHANGED_ELSEWHERE))
    })()
  })

  const outcome = (r: unknown): boolean => {
    const c = conflictFrom(r)
    if (c) {
      setConflict(c)
      setNote(null)
      return false
    }
    const res = r as {
      status?: string
      error?: { message?: string }
      id?: string
      schedule?: { id?: string }
    } | null
    if (res?.status === "error") setNote(res.error?.message ?? tr("Nothing was saved."))
    else if (res && ("blocked" in res || res.status === "pending_approval"))
      setNote(tr("Sent for approval."))
    else {
      setConflict(null)
      setNote(tr("Saved."))
      const id = res?.id ?? res?.schedule?.id
      if (isNew() && id) navigate(`/invoicing/schedule/${id}`)
      return true
    }
    return false
  }
  const save = async () => {
    setNote(null)
    saving = true
    try {
      if (isNew())
        outcome(await app.invokeTool("recurring_schedule_create", scheduleParams(d(), "active")))
      else {
        const r = await app.invokeTool("recurring_schedule_update", {
          id: d().id,
          expected_version: saved().version,
          ...changedParams(saved(), d()),
        })
        if (staleSaveFrom(r)) {
          await reload()
          setNote(tr(STALE_SAVE))
        } else if (outcome(r)) await reload()
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr("Nothing was saved."))
    } finally {
      saving = false
    }
  }
  const pause = async () => {
    try {
      if (outcome(await app.invokeTool("recurring_schedule_pause", { id: d().id }))) {
        setNote(tr("Paused. Nothing is drafted until it is resumed."))
        await reload()
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr("Nothing was saved."))
    }
  }
  const t = () => totals(d())
  const money = (n: number) => `${formatMoneyMinor(n, "EUR")} EUR`

  return (
    <section data-testid="schedule-editor" class="flex h-full min-h-0 flex-col">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-3.5">
        <div class="flex flex-col">
          <h1 data-testid="schedule-title" class="text-[15px] font-semibold text-text">
            {scheduleTitle(customer())}
          </h1>
          <span data-testid="schedule-status" class="text-[12px] text-text-tertiary">
            {isNew()
              ? tr("New")
              : tr(
                  d().status === "paused" ? "Paused" : d().status === "ended" ? "Ended" : "Active",
                )}
          </span>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={!isNew() && d().status === "active"}>
            <Button class={TAP} testid="schedule-pause" onClick={() => void pause()}>
              {tr("Pause")}
            </Button>
          </Show>
          <Button class={TAP} testid="schedule-preview" onClick={() => setPreview(!preview())}>
            {tr("Preview next invoice")}
          </Button>
          <Button
            variant="primary"
            class={TAP}
            testid="schedule-save"
            disabled={editorActions(d(), conflict()).startDisabled}
            onClick={() => void save()}
          >
            {isNew() ? tr("Start") : tr("Save")}
          </Button>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4 pb-dock-runway text-[12.5px] lg:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-5">
          <Show when={note()}>
            {(n) => (
              <p data-testid="schedule-note" class="text-text-secondary">
                {n()}
              </p>
            )}
          </Show>
          <Show when={preview()}>
            <div
              data-testid="schedule-preview-panel"
              class="rounded-md border border-border-subtle px-4 py-3"
            >
              <div class="text-text">
                {tr("Next invoice")}: {next()[0]?.issueOn ?? "-"}
              </div>
              <For each={d().lines}>
                {(l) => (
                  <div class="flex justify-between gap-3 text-text-secondary">
                    <span class="min-w-0 break-words">
                      {previewDescription(l.description, d().repeats, next()[0]?.issueOn)}
                    </span>
                    <span class="tabular-nums">{money(lineTotal(l))}</span>
                  </div>
                )}
              </For>
              <div class="text-text-tertiary">
                {tr("No number yet: it takes one when it issues.")}
              </div>
            </div>
          </Show>

          <Section title={tr("Who and to whom")}>
            <label class="flex flex-col gap-1.5">
              <span class="text-text-tertiary">{tr("Invoice from")}</span>
              <select
                data-testid="schedule-issuer"
                class={`${inputClass} ${TAP}`}
                value={d().issuer_profile_id ?? ""}
                disabled={!isNew()}
                onChange={(e) => patch({ issuer_profile_id: e.currentTarget.value || null })}
              >
                <option value="" selected={!d().issuer_profile_id}>
                  {tr("Choose")}
                </option>
                {/* `selected` per option: the list loads after the select, so its value alone is lost. */}
                <For each={issuers()?.items ?? ([] as EditorIssuerProfile[])}>
                  {(i) => (
                    <option value={i.id} selected={i.id === d().issuer_profile_id}>
                      {i.legal_name}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <div class="flex flex-col gap-1.5">
              <span class="text-text-tertiary">{tr("Customer")}</span>
              <ContactPicker
                required
                contactId={d().contact_id}
                onPick={(c) => {
                  patch({ contact_id: c.id })
                  setConflict(null)
                }}
                onClear={() => patch({ contact_id: null })}
              />
            </div>
            <Show when={conflict()}>
              {(c) => (
                <div
                  data-testid="schedule-conflict"
                  class="flex flex-col gap-2 rounded-md border border-border px-4 py-3"
                >
                  <div class="font-medium text-text">
                    {tr("This customer is already billed through Stripe")}
                  </div>
                  <div class="text-text-secondary">{c().message}</div>
                  <div class="text-text-secondary">
                    {tr(
                      "A schedule would invoice the same service a second time, so it cannot start.",
                    )}
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      class={TAP}
                      testid="conflict-open-subscription"
                      onClick={() => navigate("/stripe/customers")}
                    >
                      {tr("Open their subscription")}
                    </Button>
                    <Button
                      class={TAP}
                      testid="conflict-pick-another"
                      onClick={() => {
                        patch({ contact_id: null, billsOtherThanStripe: null })
                        setConflict(null)
                        setOtherOpen(false)
                      }}
                    >
                      {tr("Pick another customer")}
                    </Button>
                    <Button
                      class={TAP}
                      testid="conflict-bill-other"
                      onClick={() => setOtherOpen(true)}
                    >
                      {tr("Bill something else")}
                    </Button>
                  </div>
                  <Show when={otherOpen()}>
                    <label class="flex flex-col gap-1.5">
                      <span class="text-text-tertiary">
                        {tr("What does this schedule bill instead?")}
                      </span>
                      <input
                        data-testid="conflict-bills-other"
                        class={`${inputClass} ${TAP}`}
                        value={d().billsOtherThanStripe ?? ""}
                        onInput={(e) => patch({ billsOtherThanStripe: e.currentTarget.value })}
                      />
                    </label>
                  </Show>
                </div>
              )}
            </Show>
          </Section>

          <Section title={tr("Numbering series")} testid="schedule-series">
            <span data-testid="schedule-series-value" class="text-text">
              {seriesOf(issuers()?.items ?? [], d().issuer_profile_id) ??
                tr("The invoice series of the issuer you choose")}
            </span>
            <span class="text-text-tertiary">
              {tr("Read only: set on the issuer, in Settings, Invoicing.")}
            </span>
          </Section>

          <Section title={tr("When")}>
            <Choice
              testid="schedule-repeats"
              value={d().repeats}
              options={REPEATS_OPTIONS}
              onChange={(v) => patch({ repeats: v })}
            />
            <label class="flex flex-col gap-1.5">
              <span class="text-text-tertiary">{tr("Billing date")}</span>
              <input
                data-testid="schedule-billing-day"
                class={`${inputClass} ${TAP}`}
                value={d().billing_day}
                onInput={(e) => patch({ billing_day: e.currentTarget.value.trim() })}
              />
              <span class="text-text-tertiary">
                {tr("last, a day from 1 to 28, or MM-DD for a year")}
              </span>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-text-tertiary">{tr("Ends")}</span>
              <input
                type="date"
                data-testid="schedule-ends-on"
                class={`${inputClass} ${TAP}`}
                value={d().ends_on ?? ""}
                onInput={(e) => patch({ ends_on: e.currentTarget.value || null })}
              />
              <span class="text-text-tertiary">{tr("Empty: no end date")}</span>
            </label>
            <span class="text-text-tertiary">{tr("Each invoice bills for")}</span>
            <Choice
              testid="schedule-covers"
              value={d().covers}
              options={COVERS_OPTIONS}
              onChange={(v) => patch({ covers: v })}
            />
            <span class="text-text-tertiary">{tr("How each invoice issues")}</span>
            <Choice
              testid="schedule-mode"
              value={d().issue_mode}
              options={MODE_OPTIONS.slice(0, isNew() ? 1 : 2)}
              onChange={(v) => patch({ issue_mode: v })}
            />
          </Section>

          <Section title={tr("Payment")}>
            <span class="text-text-tertiary">{tr("Paid by")}</span>
            <Choice
              testid="schedule-paid-by"
              value={d().paid_by}
              options={PAID_OPTIONS}
              onChange={(v) => patch({ paid_by: v })}
            />
            <Show when={d().paid_by === "card_link"}>
              <label class="flex flex-col gap-1.5">
                <span class="text-text-tertiary">{tr("Card link")}</span>
                <input
                  data-testid="schedule-card-link"
                  class={`${inputClass} ${TAP}`}
                  placeholder="https://"
                  value={d().card_link_url ?? ""}
                  onInput={(e) => patch({ card_link_url: e.currentTarget.value.trim() || null })}
                />
              </label>
            </Show>
            <Show when={d().paid_by === "transfer"}>
              <p class="text-text-secondary">
                {tr(
                  "Your bank details print on the invoice, and it stays unpaid until someone marks the transfer received.",
                )}
              </p>
            </Show>
            <span class="text-text-tertiary">{tr("Due")}</span>
            <Choice
              testid="schedule-due"
              value={d().due_rule}
              options={DUE_OPTIONS}
              onChange={(v) => patch({ due_rule: v })}
            />
            <span class="text-text-tertiary">{tr("Language")}</span>
            <Choice
              testid="schedule-language"
              value={d().language}
              options={LANG_OPTIONS}
              onChange={(v) => patch({ language: v })}
            />
          </Section>

          <Section title={tr("Lines")} testid="schedule-lines">
            <For each={d().lines}>
              {(l, i) => (
                <div
                  data-testid={`schedule-line-${i()}`}
                  class="grid grid-cols-2 gap-2 md:grid-cols-[3fr_1fr_1.3fr_1fr_1.3fr]"
                >
                  <input
                    aria-label={tr("Description")}
                    class={`${inputClass} col-span-2 md:col-span-1 ${TAP}`}
                    value={l.description}
                    onInput={(e) => patchLine(i(), { description: e.currentTarget.value })}
                  />
                  <input
                    aria-label={tr("Qty")}
                    inputmode="decimal"
                    class={`${inputClass} ${TAP}`}
                    value={String(l.qty)}
                    onInput={(e) => patchLine(i(), { qty: Number(e.currentTarget.value) || 0 })}
                  />
                  <input
                    aria-label={tr("Unit price")}
                    inputmode="decimal"
                    class={`${inputClass} ${TAP}`}
                    value={(l.unit_price_minor / 100).toFixed(2)}
                    onChange={(e) =>
                      patchLine(i(), {
                        unit_price_minor:
                          Math.round(Number(e.currentTarget.value.replace(",", ".")) * 100) || 0,
                      })
                    }
                  />
                  <input
                    aria-label={tr("VAT %")}
                    inputmode="decimal"
                    class={`${inputClass} ${TAP}`}
                    value={String(l.vat_bp / 100)}
                    onChange={(e) =>
                      patchLine(i(), {
                        vat_bp:
                          Math.round(Number(e.currentTarget.value.replace(",", ".")) * 100) || 0,
                      })
                    }
                  />
                  <span class="self-center text-right tabular-nums text-text">
                    {money(lineTotal(l))}
                  </span>
                </div>
              )}
            </For>
            <p class="text-text-tertiary">
              {tr("{period} becomes the dates this invoice covers.")}
            </p>
            <div>
              <Button
                class={TAP}
                testid="schedule-add-line"
                onClick={() =>
                  patch({
                    lines: [
                      ...d().lines,
                      { description: "", qty: 1, unit_price_minor: 0, vat_bp: 2000 },
                    ],
                  })
                }
              >
                {tr("+ Add line")}
              </Button>
            </div>
          </Section>

          <Section title={tr("Notes")}>
            <textarea
              data-testid="schedule-notes"
              class={`${inputClass} min-h-20`}
              value={d().notes ?? ""}
              onInput={(e) => patch({ notes: e.currentTarget.value || null })}
            />
          </Section>
        </div>

        <aside data-testid="schedule-side" class="flex flex-col gap-4 lg:w-72">
          <div class="flex flex-col gap-1">
            <span class="text-text-tertiary">{tr("Each invoice")}</span>
            <div class="flex justify-between">
              <span>{tr("Subtotal")}</span>
              <span class="tabular-nums">{money(t().sub)}</span>
            </div>
            <div class="flex justify-between">
              <span>{tr("VAT")}</span>
              <span class="tabular-nums">{money(t().vat)}</span>
            </div>
            <div class="flex justify-between font-medium">
              <span>{tr("Grand total")}</span>
              <span class="tabular-nums">{money(t().total)}</span>
            </div>
          </div>
          <div data-testid="schedule-next" class="flex flex-col gap-1">
            <span class="text-text-tertiary">{tr("Next invoices")}</span>
            <For each={next()}>
              {(n) => (
                <div class="flex justify-between gap-2">
                  <span class="tabular-nums">{n.issueOn}</span>
                  <span class="text-text-secondary">
                    {tr("draft on {{day}}", { day: n.draftOn })}
                  </span>
                </div>
              )}
            </For>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-text-tertiary">{tr("Invoice number")}</span>
            <span data-testid="schedule-number-line" class="text-text-secondary">
              {tr(NUMBER_LINE)}
            </span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-text-tertiary">{tr("Last day to issue")}</span>
            <span class="text-text-secondary">
              {tr(
                "The end of the billing month. A draft still open moves to the top of Home before then.",
              )}
            </span>
          </div>
          <Show when={errors().length > 0}>
            <div data-testid="schedule-errors" class="flex flex-col gap-1">
              <span class="text-text-tertiary">{tr("Errors")}</span>
              <For each={errors()}>{(e) => <span class="text-text-secondary">{tr(e)}</span>}</For>
            </div>
          </Show>
        </aside>
      </div>
    </section>
  )
}

/** The schedule tab: `new`, or an existing schedule's id. */
export const InvoicingScheduleEditor: Component<{ entityId?: string }> = (props) => {
  const isNew = () => !props.entityId || props.entityId === "new"
  const [loaded] = createResource(
    () => (isNew() ? null : props.entityId),
    (id) => loadSchedule(id as string),
  )
  return (
    <Show when={!isNew()} fallback={<ScheduleEditor initial={defaultSchedule()} />}>
      <Show
        when={loaded()}
        fallback={
          <div data-testid="schedule-load-state" class="p-5 text-[12.5px] text-text-secondary">
            {loaded.loading
              ? tr("Loading")
              : tr("This schedule was not found. It may have been ended and removed.")}
          </div>
        }
      >
        {(s) => <ScheduleEditor initial={s()} />}
      </Show>
    </Show>
  )
}

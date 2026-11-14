// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Who issues what", a block of the issuer settings section (no page of its own). For each issuer
// profile: its identity line and its streams. Card subscriptions on Stripe appear only while Stripe
// is connected, with the choice of who issues their invoices in a panel; recurring by transfer and
// one-off invoices are always Liaison's and read "Always: not billed from Stripe". Rows are not
// clickable.
//
// A person's own change runs at once, so it asks a confirm whose text is the panel's warning.
// Stripe's own emails to customers cannot be read, so the block asks the person to check them
// until a person says they did; the word Checked appears only after that click.
import { app, fetch as hostFetch, onEntityChange } from "@liaison/host"
import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { tr } from "./i18n"
import { Badge, Button, isUserId } from "./kit"

export interface StreamView {
  stream: "card" | "transfer" | "one_off"
  issuer: "liaison" | "stripe" | "undecided"
  notBilledFromStripe?: boolean
  decidedAt?: string | null
  suggested?: { issuer: "liaison"; why: string } | null
  /** The stream's standing e-invoice authorization (card and transfer only). */
  standing?: StandingView
}

export interface StandingView {
  on: boolean
  turnedOnBy: string | null
  turnedOnAt: string | null
  until: string | null
}

export type StandingStream = "card" | "transfer"

/** How long a person has to take back turning a standing authorization off. */
export const STANDING_UNDO_MS = 8000

/**
 * Turning it on is a person's decision: the gated stream setting, never auto-approved. A person's
 * own click after the confirm is that decision, so it turns on at once; an agent's call waits.
 */
export function standingOnCall(issuerProfileId: string, stream: StandingStream) {
  return { tool: "issuer_stream_set", params: { issuerProfileId, stream, einvoiceStanding: true } }
}

/**
 * Turning it off runs only after STANDING_UNDO_MS; Undo inside that time calls nothing. One
 * pending "off" at a time: a second request replaces the first.
 */
export function createStandingOff(deps: {
  run: (tool: string, params: Record<string, unknown>) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let pending: { issuerProfileId: string; stream: StandingStream } | null = null
  let timer: unknown = null
  const cancel = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    pending = null
  }
  return {
    request(issuerProfileId: string, stream: StandingStream) {
      cancel()
      const target = { issuerProfileId, stream }
      pending = target
      timer = setTimer(() => {
        timer = null
        pending = null
        deps.run("einvoice_standing_off", { ...target })
      }, STANDING_UNDO_MS)
    },
    undo: cancel,
    pending: () => (pending ? { ...pending } : null),
  }
}

function dayOf(iso: string, locale?: string): string {
  // A date-only ISO string parses as UTC midnight, shown here in UTC.
  return new Date(iso).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** Off, or who turned it on, when, and until when. */
export function standingLine(v: StandingView, byName: string | null, locale?: string): string {
  if (!v.on) return tr("Off: e-invoices issued with no person wait for the daily send card.")
  return tr("On: turned on by {{who}} on {{on}}, until {{until}}.", {
    who: byName ?? tr("a person"),
    on: v.turnedOnAt ? dayOf(v.turnedOnAt, locale) : "-",
    until: v.until ? dayOf(v.until, locale) : "-",
  })
}

export interface IssuerStreamsView {
  issuerProfileId: string
  name: string
  country: string | null
  streams: StreamView[]
  stripe_emails: {
    state: "unknown" | "confirmed"
    confirmedBy: string | null
    confirmedAt: string | null
  } | null
}

const STREAM_LABEL: Record<StreamView["stream"], string> = {
  card: "Subscriptions paid by card",
  transfer: "Recurring by transfer",
  one_off: "One-off invoices",
}

/** One table row: the stream's name and who invoices it, in the reader's language. */
export function streamRow(s: StreamView): { name: string; who: string } {
  const name = tr(STREAM_LABEL[s.stream])
  if (s.stream !== "card") return { name, who: tr("Always: not billed from Stripe") }
  const who =
    s.issuer === "liaison"
      ? tr("Liaison invoices")
      : s.issuer === "stripe"
        ? tr("Stripe invoices")
        : tr("Not decided yet")
  return { name, who }
}

/** The emails line: a request to check until a person said they did, never the word Checked before. */
export function emailsLine(e: IssuerStreamsView["stripe_emails"], locale?: string): string | null {
  if (!e) return null
  if (e.state !== "confirmed" || !e.confirmedAt)
    return tr(
      "Please check in Stripe, Settings, Billing: finalized invoices, credit notes and payment receipts should not email customers. Liaison cannot read this setting.",
    )
  const day = new Date(e.confirmedAt).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  return tr(
    "Checked by a person on {{day}}. Liaison cannot read this setting, so check again if someone changes it.",
    { day },
  )
}

async function loadStreams(): Promise<IssuerStreamsView[]> {
  try {
    const r = await app.invokeTool<{ issuers?: IssuerStreamsView[] }>("issuer_stream_get", {})
    return r?.issuers ?? []
  } catch {
    return []
  }
}

async function personName(id: string | null): Promise<string | null> {
  if (!isUserId(id)) return null
  try {
    const p = await hostFetch<{ name?: string | null }>(
      `/api/users/${encodeURIComponent(id)}/preview`,
    )
    return p?.name ?? null
  } catch {
    return null
  }
}

/** What turning it on does, asked before the person's click runs. */
export const STANDING_ON_CONFIRM =
  "E-invoices of this stream issued with no person will be sent at issue, with no daily card, for 90 days. A renewal card comes a week before. You can turn it off at any time."

/** Whether an e-invoicing platform is set: with none, there is nothing to send to. */
async function loadPlatform(): Promise<string | null> {
  try {
    const r = await app.invokeTool<{ settings?: { provider_app?: string | null } }>(
      "einvoicing_settings_get",
      {},
    )
    return r?.settings?.provider_app ?? null
  } catch {
    return null
  }
}

const STANDING_LABEL: Record<StandingStream, string> = {
  card: "Send e-invoices of card subscriptions without a daily card",
  transfer: "Send e-invoices of recurring transfers without a daily card",
}

/** One stream's standing e-invoice authorization: its line, and Turn on, or Turn off with Undo. */
const StandingControl: Component<{
  issuerProfileId: string
  stream: StandingStream
  view: StandingView
  /** An e-invoicing platform is set; with none, turning on is not offered. */
  hasPlatform: boolean
  run: (tool: string, params: Record<string, unknown>) => Promise<void>
}> = (p) => {
  const [by] = createResource(() => p.view.turnedOnBy, personName)
  const [waiting, setWaiting] = createSignal(false)
  // The Undo window counts down, so the person sees how long is left.
  const [left, setLeft] = createSignal(0)
  let tick: ReturnType<typeof setInterval> | null = null
  const stopTick = () => {
    if (tick !== null) clearInterval(tick)
    tick = null
  }
  const off = createStandingOff({
    run: (tool, params) => {
      stopTick()
      setWaiting(false)
      void p.run(tool, params)
    },
  })
  onCleanup(() => {
    stopTick()
    off.undo()
  })
  return (
    <div
      data-testid={`standing-${p.stream}`}
      class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3"
    >
      <span class="text-sm font-medium">{tr(STANDING_LABEL[p.stream])}</span>
      <p
        class="text-xs text-[var(--color-text-secondary)]"
        data-testid={`standing-line-${p.stream}`}
      >
        {standingLine(p.view, by() ?? null)}
      </p>
      <Show
        when={waiting()}
        fallback={
          <Show
            when={p.view.on}
            fallback={
              <Show
                when={p.hasPlatform}
                fallback={
                  <p
                    class="text-xs text-[var(--color-text-secondary)]"
                    data-testid={`standing-needs-platform-${p.stream}`}
                  >
                    {tr(
                      "Choose an e-invoicing platform first, in E-invoicing on this page: with none set, there is nothing to send.",
                    )}
                  </p>
                }
              >
                <Button
                  class="min-h-11 md:min-h-8"
                  testid={`standing-on-${p.stream}`}
                  onClick={() => {
                    if (!window.confirm(tr(STANDING_ON_CONFIRM))) return
                    const c = standingOnCall(p.issuerProfileId, p.stream)
                    void p.run(c.tool, c.params)
                  }}
                >
                  {tr("Turn on")}
                </Button>
              </Show>
            }
          >
            <Button
              class="min-h-11 md:min-h-8"
              testid={`standing-off-${p.stream}`}
              onClick={() => {
                off.request(p.issuerProfileId, p.stream)
                setWaiting(true)
                setLeft(Math.round(STANDING_UNDO_MS / 1000))
                stopTick()
                tick = setInterval(() => setLeft(Math.max(0, left() - 1)), 1000)
              }}
            >
              {tr("Turn off")}
            </Button>
          </Show>
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="text-xs text-[var(--color-text-secondary)]"
            data-testid={`standing-pending-${p.stream}`}
          >
            {tr("Turning off in {{n}} seconds.", { n: left() })}
          </span>
          <Button
            class="min-h-11 md:min-h-8"
            testid={`standing-undo-${p.stream}`}
            onClick={() => {
              off.undo()
              stopTick()
              setWaiting(false)
            }}
          >
            {tr("Undo")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

export const InvoicingIssuerStreams: Component = () => {
  const [data, { refetch }] = app.createResource(loadStreams)
  const [platform, platformActions] = app.createResource(loadPlatform)
  // The platform is saved in another section of this page: follow its change.
  onCleanup(onEntityChange("invoicing:einvoicing", () => void platformActions.refetch()))
  const [error, setError] = createSignal<string | null>(null)

  const run = async (tool: string, params: Record<string, unknown>) => {
    setError(null)
    try {
      const r = await app.invokeTool<{ status?: string; error?: { message?: string } }>(
        tool,
        params,
      )
      if (r?.status === "error") setError(r.error?.message ?? tr("Nothing was changed."))
      else if (r && ("blocked" in r || r.status === "pending_approval"))
        setError(tr("Sent for approval."))
      refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Nothing was changed."))
    }
  }

  const choose = (issuerProfileId: string, issuer: "liaison" | "stripe") => {
    if (
      !window.confirm(
        tr(
          "Starts with the next renewal, after you confirm. Invoices Liaison already issued stay as they are, with their numbers. Check the change with your accountant.",
        ),
      )
    )
      return
    void run("issuer_stream_set", { issuerProfileId, stream: "card", issuer })
  }

  return (
    <div class="space-y-6" data-testid="invoicing-issuer-streams">
      <div>
        <h3 class="text-sm font-medium text-[var(--color-text)]">{tr("Who issues what")}</h3>
        <p class="text-xs text-[var(--color-text-secondary)]">
          {tr("If both invoiced the same sale, it would be invoiced twice.")}
        </p>
      </div>
      <Show when={error()}>
        <p class="text-xs text-[var(--color-text-secondary)]" data-testid="issuer-streams-error">
          {error()}
        </p>
      </Show>
      <For each={data() ?? []}>
        {(issuer) => {
          const card = () => issuer.streams.find((s) => s.stream === "card")
          return (
            <section class="space-y-3" data-testid={`issuer-streams-${issuer.issuerProfileId}`}>
              <p class="text-sm text-[var(--color-text)]">
                {issuer.name}
                <Show when={issuer.country}>
                  {(c) => <span class="text-[var(--color-text-meta)]"> · {c()}</span>}
                </Show>
              </p>
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-xs text-[var(--color-text-meta)]">
                    <th class="py-1 font-normal">{tr("Kind of sale")}</th>
                    <th class="py-1 font-normal">{tr("Who invoices")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={issuer.streams}>
                    {(s) => (
                      <tr data-testid={`stream-row-${s.stream}`}>
                        <td class="py-1">{streamRow(s).name}</td>
                        <td class="py-1 text-[var(--color-text-secondary)]">{streamRow(s).who}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <For
                each={issuer.streams.filter(
                  (s) => (s.stream === "card" || s.stream === "transfer") && s.standing,
                )}
              >
                {(s) => (
                  <StandingControl
                    issuerProfileId={issuer.issuerProfileId}
                    stream={s.stream as StandingStream}
                    view={s.standing as StandingView}
                    hasPlatform={!!platform()}
                    run={run}
                  />
                )}
              </For>
              <Show when={card()}>
                {(c) => (
                  <div
                    class="space-y-2 rounded-lg border border-[var(--color-border)] p-3"
                    data-testid="card-stream-panel"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium">{tr("Subscriptions paid by card")}</span>
                      <Show when={c().issuer === "undecided"}>
                        <Badge>{tr("Not decided yet")}</Badge>
                      </Show>
                    </div>
                    <Show when={c().suggested}>
                      {(s) => (
                        <p class="text-xs text-[var(--color-text-secondary)]">
                          {tr("Default for French companies")}: {s().why}
                        </p>
                      )}
                    </Show>
                    <div class="flex gap-2">
                      <Button
                        data-testid="card-issuer-liaison"
                        disabled={c().issuer === "liaison"}
                        onClick={() => choose(issuer.issuerProfileId, "liaison")}
                      >
                        {tr("Liaison invoices, Stripe only takes the payment")}
                      </Button>
                      <Button
                        data-testid="card-issuer-stripe"
                        disabled={c().issuer === "stripe"}
                        onClick={() => choose(issuer.issuerProfileId, "stripe")}
                      >
                        {tr("Stripe invoices, Liaison only shows you a copy")}
                      </Button>
                    </div>
                    <p
                      class="text-xs text-[var(--color-text-secondary)]"
                      data-testid="stripe-emails-line"
                    >
                      {emailsLine(issuer.stripe_emails)}
                    </p>
                    <Show when={issuer.stripe_emails?.state !== "confirmed"}>
                      <Button
                        data-testid="stripe-emails-confirm"
                        onClick={() =>
                          void run("issuer_emails_confirm", {
                            issuerProfileId: issuer.issuerProfileId,
                          })
                        }
                      >
                        {tr("I checked, they are off")}
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
            </section>
          )
        }}
      </For>
    </div>
  )
}

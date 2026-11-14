// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One month-end run (`/invoicing/run/:runId`, from `recurring_run_get`): when it issued, who
// approved it, the period, the number range, and each invoice with where it stands with the
// e-invoicing platform. "None missing" shows only when the numbers really follow each other. A
// partial run lists the rows that could not issue, each with Fix (its draft in the editor).
// Download all fetches each invoice's PDF through the same path as the invoice's own Download.
import { app, fetchBlob, fetch as hostFetch, navigate, openFile } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { tr } from "./i18n"
import { Button, formatMoneyMinor, isUserId } from "./kit"
import { einvoiceStatusWord, LastDayNote } from "./RecurringStates"

/** Phone-sized tap target that shrinks back on a desktop. */
export const TAP = "min-h-11 md:min-h-8"

export interface RunDetailRun {
  id: string
  status: string
  issue_on: string | null
  latest_issue_on: string | null
  period: string | null
  approved_by: string | null
  approved_at: string | null
  auto?: boolean
  /** The issuer's time zone, so a date reads as the issuer's day. */
  timezone?: string | null
}

export interface RunDetailRow {
  item_id: string
  draft_id: string | null
  document_id: string
  state: string
  customer: string | null
  net_minor: string
  vat_minor: string
  total_minor: string
  currency: string
  number: string | null
  flags: string[]
  failure: unknown
  einvoice_state: string | null
  collection_state: string | null
  payment_status: string | null
}

/** First and last number, and whether every number between them is in the run, in one series. */
export function numberRange(
  numbers: string[],
): { first: string; last: string; noGaps: boolean } | null {
  if (numbers.length === 0) return null
  const parsed = numbers.map((n) => {
    const m = /^(.*?)(\d+)$/.exec(n)
    return m ? { n, prefix: m[1] ?? "", seq: Number(m[2]) } : { n, prefix: n, seq: Number.NaN }
  })
  const sorted = [...parsed].sort((a, b) =>
    a.prefix === b.prefix ? a.seq - b.seq : a.prefix < b.prefix ? -1 : 1,
  )
  const first = sorted[0] as (typeof sorted)[number]
  const last = sorted[sorted.length - 1] as (typeof sorted)[number]
  const oneSeries = sorted.every((p) => p.prefix === first.prefix && Number.isFinite(p.seq))
  const consecutive = sorted.every(
    (p, i) => i === 0 || p.seq === (sorted[i - 1] as (typeof sorted)[number]).seq + 1,
  )
  return { first: first.n, last: last.n, noGaps: oneSeries && consecutive }
}

function failureText(f: unknown): string {
  if (f && typeof f === "object" && typeof (f as { message?: unknown }).message === "string")
    return (f as { message: string }).message
  return typeof f === "string" ? f : tr("It could not issue.")
}

function sum(rows: RunDetailRow[], key: "net_minor" | "vat_minor" | "total_minor"): string {
  return rows.reduce((acc, r) => acc + BigInt(r[key] || "0"), 0n).toString()
}

/** Run statuses after which the run's invoices carry numbers. */
const ISSUED_STATUSES = new Set(["issued", "partial"])

/** The word under the run's title, from the run's own status. */
export function runStatusWord(status: string): string {
  switch (status) {
    case "drafted":
      return tr("Drafted, waiting for approval")
    case "approved":
      return tr("Approved, not issued yet")
    case "issuing":
      return tr("Issuing")
    case "issued":
      return tr("Issued")
    case "partial":
      return tr("Partly issued")
    case "rejected":
      return tr("Not approved")
    case "late":
      return tr("Past its last day, not issued")
    case "nothing_to_issue":
      return tr("Closed, nothing to issue")
    default:
      return status
  }
}

/** A timestamp as the calendar day it was in `timezone` (UTC when unknown). */
export function dayIn(iso: string, timezone: string | null | undefined): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/** What the run detail shows, from the run read and the approver's name. */
export function runDetailView(
  run: RunDetailRun,
  rows: RunDetailRow[],
  approverName: string | null,
) {
  const issuedRun = ISSUED_STATUSES.has(run.status)
  // Before issue the run lists the drafts it will issue; after, the invoices it did issue.
  const shown = issuedRun
    ? rows.filter((r) => r.state === "issued" && r.number)
    : rows.filter((r) => r.state !== "left_out" && r.state !== "failed" && r.state !== "issued")
  return {
    status: run.status,
    statusWord:
      issuedRun && rows.some((r) => r.state === "failed")
        ? tr("Partly issued")
        : runStatusWord(run.status),
    issued: issuedRun,
    issuedOn: run.issue_on,
    approvedBy: run.approved_by ? approverName : null,
    approvedOn: run.approved_at ? dayIn(String(run.approved_at), run.timezone) : null,
    // Only an issued run with no approver issued by itself; before issue nobody has approved yet.
    approvalWord: run.approved_by
      ? null
      : issuedRun
        ? tr("Issued by itself")
        : tr("Not approved yet"),
    period: run.period,
    lateSince: run.status === "late" ? run.latest_issue_on : null,
    range: issuedRun ? numberRange(shown.map((r) => r.number as string)) : null,
    rows: shown.map((r) => ({
      key: r.number ?? r.item_id,
      documentId: r.document_id,
      href: r.number
        ? `/invoicing/document/${r.document_id}`
        : `/invoicing/editor/${r.draft_id ?? r.document_id}`,
      number: r.number,
      customer: r.customer,
      net: r.net_minor,
      vat: r.vat_minor,
      total: r.total_minor,
      currency: r.currency,
      einvoice: r.number ? einvoiceStatusWord(r) : null,
    })),
    failed: rows
      .filter((r) => r.state === "failed")
      .map((r) => ({
        itemId: r.item_id,
        customer: r.customer,
        why: failureText(r.failure),
        fixHref: `/invoicing/editor/${r.draft_id ?? r.document_id}`,
      })),
    totals: {
      net: sum(shown, "net_minor"),
      vat: sum(shown, "vat_minor"),
      total: sum(shown, "total_minor"),
      currency: shown[0]?.currency ?? "EUR",
    },
  }
}

interface RunRead {
  status: string
  run?: RunDetailRun
  rows?: RunDetailRow[]
  error?: { message?: string }
}

async function personName(id: string | null): Promise<string | null> {
  if (!isUserId(id)) return null
  try {
    const p = await hostFetch<{ name?: string | null; displayName?: string | null }>(
      `/api/users/${encodeURIComponent(id)}/preview`,
    )
    return p?.name ?? p?.displayName ?? null
  } catch {
    return null
  }
}

async function loadRun(runId: string) {
  const r = await app.invokeTool<RunRead>(
    "recurring_run_get",
    runId && runId !== "latest" ? { run_id: runId } : {},
  )
  if (!r || r.status !== "completed" || !r.run)
    throw new Error(r?.error?.message ?? tr("Could not load this run."))
  const name = await personName(r.run.approved_by)
  return runDetailView(r.run, r.rows ?? [], name ?? (r.run.approved_by ? tr("a person") : null))
}

async function downloadPdf(documentId: string, number: string): Promise<boolean> {
  const res = await app.invokeTool<{ url: string | null }>("documents_download_pdf", {
    id: documentId,
  })
  if (!res?.url) return false
  const blob = await fetchBlob(res.url)
  const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
  if (await openFile(pdf, `${number}.pdf`)) return true
  const url = URL.createObjectURL(pdf)
  const a = document.createElement("a")
  a.href = url
  a.download = `${number}.pdf`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

const money = (minor: string, currency: string) =>
  `${formatMoneyMinor(minor, currency)} ${currency}`

export const RunDetail: Component<{ runId: string }> = (props) => {
  const [view, { refetch }] = createResource(() => props.runId, loadRun)
  const [note, setNote] = createSignal<string | null>(null)
  const downloadAll = async () => {
    const rows = view()?.rows ?? []
    let missing = 0
    for (const r of rows) {
      if (!r.number) continue
      try {
        if (!(await downloadPdf(r.documentId, r.number))) missing++
      } catch {
        missing++
      }
    }
    setNote(
      missing > 0
        ? tr("{{n}} PDFs are not ready yet. Try again in a minute.", { n: missing })
        : null,
    )
  }

  return (
    <section data-testid="recurring-run-detail" class="flex h-full min-h-0 flex-col">
      <Show
        when={view()}
        fallback={
          <div class="p-5 text-[12.5px] text-text-secondary">
            <Show when={view.error} fallback={tr("Loading")}>
              <div class="flex flex-col items-start gap-2">
                <span>
                  {view.error instanceof Error
                    ? view.error.message
                    : tr("Could not load this run.")}
                </span>
                <Button class={TAP} onClick={() => refetch()}>
                  {tr("Retry")}
                </Button>
              </div>
            </Show>
          </div>
        }
      >
        {(v) => (
          <>
            {/* Actions sit at the top of the panel, never under the chat dock. */}
            <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-3.5">
              <div class="flex flex-col">
                <h1 class="text-[15px] font-semibold text-text">
                  {tr("{{period}} run", { period: v().period ?? "" })}
                </h1>
                <span data-testid="run-status" class="text-[12px] text-text-tertiary">
                  {v().statusWord}
                </span>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button
                  class={TAP}
                  testid="run-all-schedules"
                  onClick={() => navigate("/invoicing/recurring")}
                >
                  {tr("All schedules")}
                </Button>
                <Show when={v().issued && v().rows.length > 0}>
                  <Button class={TAP} testid="run-download-all" onClick={() => void downloadAll()}>
                    {tr("Download {{n}} PDFs", { n: v().rows.length })}
                  </Button>
                </Show>
              </div>
            </header>
            <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4 text-[12.5px]">
              <Show when={note()}>{(n) => <p class="text-text-secondary">{n()}</p>}</Show>
              <Show when={v().lateSince}>{(day) => <LastDayNote lastDay={day()} />}</Show>
              <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt class="text-text-tertiary">{v().issued ? tr("Issued") : tr("Issues on")}</dt>
                  <dd data-testid="run-issued-on" class="text-text">
                    {v().issuedOn ?? "-"}
                  </dd>
                </div>
                <div>
                  <dt class="text-text-tertiary">{tr("Approved by")}</dt>
                  <dd data-testid="run-approved-by" class="text-text">
                    {v().approvedBy
                      ? `${v().approvedBy}, ${v().approvedOn ?? ""}`
                      : v().approvalWord}
                  </dd>
                </div>
                <div>
                  <dt class="text-text-tertiary">{tr("Period")}</dt>
                  <dd data-testid="run-period" class="text-text">
                    {v().period ?? "-"}
                  </dd>
                </div>
                <div>
                  <dt class="text-text-tertiary">{tr("Numbers")}</dt>
                  <dd data-testid="run-numbers" class="font-mono text-text">
                    <Show
                      when={v().range}
                      fallback={v().issued ? tr("None yet") : tr("Given when the invoices issue")}
                    >
                      {(r) => (
                        <>
                          {r().first} {tr("to")} {r().last}
                          <Show when={r().noGaps}>
                            <span data-testid="run-no-gaps" class="font-sans text-text-secondary">
                              , {tr("none missing")}
                            </span>
                          </Show>
                        </>
                      )}
                    </Show>
                  </dd>
                </div>
              </dl>

              <Show when={v().failed.length > 0}>
                <div data-testid="run-failed" class="flex flex-col gap-2">
                  <h2 class="text-[13px] font-medium text-text">{tr("Could not issue")}</h2>
                  <For each={v().failed}>
                    {(f) => (
                      <div
                        data-testid={`run-failed-${f.itemId}`}
                        class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2"
                      >
                        <div class="flex min-w-0 flex-col">
                          <span class="text-text">{f.customer ?? "-"}</span>
                          <span class="text-text-secondary">{f.why}</span>
                        </div>
                        <Button
                          class={TAP}
                          testid={`run-fix-${f.itemId}`}
                          onClick={() => navigate(f.fixHref)}
                        >
                          {tr("Fix")}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div class="overflow-x-auto">
                <table class="w-full min-w-0 text-left">
                  <thead>
                    <tr class="text-[11.5px] text-text-tertiary">
                      <th class="py-1.5 pr-3 font-normal">{tr("Number")}</th>
                      <th class="py-1.5 pr-3 font-normal">{tr("Customer")}</th>
                      <th class="hidden py-1.5 pr-3 text-right font-normal md:table-cell">
                        {tr("Excl. VAT")}
                      </th>
                      <th class="hidden py-1.5 pr-3 text-right font-normal md:table-cell">
                        {tr("VAT")}
                      </th>
                      <th class="py-1.5 pr-3 text-right font-normal">{tr("Incl. VAT")}</th>
                      <th class="py-1.5 font-normal">{tr("E-invoicing platform")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={v().rows}>
                      {(r) => (
                        <tr data-testid={`run-row-${r.key}`} class="border-t border-border-subtle">
                          <td class="py-2 pr-3 font-mono">
                            <a
                              class={`inline-flex items-center text-text hover:underline ${TAP}`}
                              href={r.href}
                              onClick={(e) => {
                                e.preventDefault()
                                navigate(r.href)
                              }}
                            >
                              {r.number ?? (
                                <span class="font-sans text-text-secondary">{tr("Draft")}</span>
                              )}
                            </a>
                          </td>
                          <td class="break-words py-2 pr-3 text-text">{r.customer ?? "-"}</td>
                          <td class="hidden py-2 pr-3 text-right tabular-nums md:table-cell">
                            {money(r.net, r.currency)}
                          </td>
                          <td class="hidden py-2 pr-3 text-right tabular-nums md:table-cell">
                            {money(r.vat, r.currency)}
                          </td>
                          <td class="py-2 pr-3 text-right tabular-nums">
                            {money(r.total, r.currency)}
                          </td>
                          <td
                            data-testid={`run-einvoice-${r.key}`}
                            class="py-2 text-text-secondary"
                          >
                            {r.einvoice ? tr(r.einvoice) : "-"}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <p data-testid="run-totals" class="text-text-secondary">
                {v().issued
                  ? tr("{{n}} invoices", { n: v().rows.length })
                  : tr("{{n}} drafts to issue", { n: v().rows.length })}
                : {money(v().totals.net, v().totals.currency)} {tr("excl. VAT")},{" "}
                {money(v().totals.total, v().totals.currency)} {tr("incl. VAT")}
              </p>
              <ul class="flex flex-col gap-1 text-text-secondary">
                <Show
                  when={v().issued}
                  fallback={
                    <li>
                      {tr(
                        "Nothing is billed yet: these drafts become invoices, with their numbers, when the run issues.",
                      )}
                    </li>
                  }
                >
                  <li>
                    {tr(
                      "An issued invoice cannot be edited or deleted. A correction is a credit note linked to it, with its own number.",
                    )}
                  </li>
                  <li>
                    {tr(
                      "These schedules have now billed this period, so they cannot bill it again.",
                    )}
                  </li>
                </Show>
              </ul>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

export const InvoicingRunDetail: Component<{ entityId?: string }> = (props) => (
  <RunDetail runId={props.entityId ?? "latest"} />
)

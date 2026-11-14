// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The deal panel on a deal's task page, above the description: Amount,
// Company, Contact and Next step, with Mark won, Mark lost (an optional
// reason, inline) and Reopen as the person's own clicks. A reader without
// deal access sees "Needs deal access" in place of the amount and still sees
// the company and the contact. A reader without deal write sees no buttons.
// The panel reads the deal on its own: when that read fails it says so and
// the task page below is untouched. The foot line shows only when an active
// deal follow-up routine the reader can see would draft for this deal.

import { Check, X } from "lucide-solid"
import { type Component, createResource, createSignal, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { log as logger } from "~/lib/logger"
import { formatDay } from "~/lib/relative-time"
import { hasScope } from "~/modules/auth/auth-store"
import { openCompanyTab } from "~/modules/contacts/company-visuals"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type DealRead, readDeal, updateDeal } from "~/modules/projects/deal-api"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"

/** The routine template whose runs draft follow-ups for quiet deals. */
export const DEAL_FOLLOWUPS_TEMPLATE = "deal-followups"

interface RoutineRow {
  name: string
  templateKey: string | null
  enabled: boolean
  status: string
}

type PanelApi = Pick<ApiClient, "get" | "post">

function unwrap<T>(result: unknown): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

/** The first active deal follow-up routine the reader can see, by name. */
async function activeFollowupRoutine(api: PanelApi): Promise<string | null> {
  const lists = await Promise.allSettled([
    api.get("/agent/routines"),
    api.get("/agent/routines?visibility=shared"),
  ])
  for (const list of lists) {
    if (list.status !== "fulfilled") continue
    const rows = unwrap<RoutineRow[]>(list.value)
    const hit = (Array.isArray(rows) ? rows : []).find(
      (r) => r.templateKey === DEAL_FOLLOWUPS_TEMPLATE && r.enabled && r.status === "active",
    )
    if (hit) return hit.name
  }
  return null
}

async function contactName(api: PanelApi, id: string): Promise<string | null> {
  try {
    const c = unwrap<{ name?: string | null; email?: string | null }>(
      await api.get(`/contacts/${id}`),
    )
    return c?.name || c?.email || null
  } catch {
    return null
  }
}

export const DealPanel: Component<{
  api: PanelApi
  taskId: string
  /** The deal owner's name, for the routine line. */
  ownerName?: string | null
  disabled?: boolean
  /** Called after the deal changed, so the page reads the task again. */
  onChanged?: () => void
}> = (props) => {
  const i18n = useI18n()
  const [deal, { refetch }] = createResource(
    () => props.taskId,
    (taskId) => readDeal(props.api, taskId),
  )
  const [contact] = createResource(
    () => (deal.error ? null : deal.latest?.deal.contactId) ?? false,
    (id) => contactName(props.api, id),
  )
  const [routine] = createResource(
    () => (deal.error ? false : deal.latest?.deal.outcome === "open"),
    () => activeFollowupRoutine(props.api).catch(() => null),
  )
  const [busy, setBusy] = createSignal(false)
  const [losing, setLosing] = createSignal(false)
  const [reason, setReason] = createSignal("")
  const canWrite = () => !props.disabled && hasScope("projects:deals:write")

  const change = async (outcome: "won" | "lost" | "open", why?: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await updateDeal(props.api, {
        taskId: props.taskId,
        outcome,
        ...(outcome === "lost" ? { reason: why?.trim() || null } : {}),
      })
      setLosing(false)
      setReason("")
      await refetch()
      props.onChanged?.()
    } catch (err) {
      logger.error({ err }, "deal_panel_update_failed")
      addToast({ message: i18n.t("projects.deals.updateFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  const amountText = (d: DealRead): { text: string; muted: boolean } => {
    const v = d.values
    if (!v) return { text: i18n.t("projects.deals.needsDealAccess"), muted: true }
    if (v.amountMinor === null || !v.currency) {
      return { text: i18n.t("projects.deals.noAmount"), muted: true }
    }
    const amount = i18n.fmtCurrency(v.amountMinor / 100, v.currency)
    const text =
      v.amountPeriod === "month"
        ? i18n.t("projects.deals.perMonth", { amount })
        : v.amountPeriod === "year"
          ? i18n.t("projects.deals.perYear", { amount })
          : amount
    return { text, muted: false }
  }

  const closedLine = (d: DealRead): string | null => {
    if (d.deal.outcome === "open" || !d.deal.closedAt) return null
    const date = formatDay(d.deal.closedAt, i18n.locale())
    return d.deal.outcome === "won"
      ? i18n.t("projects.deals.wonOn", { date })
      : i18n.t("projects.deals.lostOn", { date })
  }

  const row = (label: string, testid: string, body: () => unknown) => (
    <div class="flex items-baseline gap-4 py-1">
      <span class="w-24 shrink-0 text-[12px] text-text-tertiary">{label}</span>
      <span data-testid={testid} class="min-w-0 text-[13px] text-text">
        {body() as never}
      </span>
    </div>
  )

  return (
    <Show
      when={!deal.error}
      fallback={
        <section
          data-testid="deal-panel.error"
          class="rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px] text-text-secondary"
        >
          {i18n.t("projects.deals.readFailed")}
        </section>
      }
    >
      <Show
        when={deal.latest !== undefined}
        fallback={
          <section
            data-testid="deal-panel.loading"
            class="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface px-4 py-3"
          >
            <Skeleton class="h-3 w-24" />
            <Skeleton class="h-3 w-48" />
            <Skeleton class="h-3 w-40" />
          </section>
        }
      >
        <Show when={deal.latest}>
          {(d) => (
            <section
              data-testid="deal-panel"
              data-outcome={d().deal.outcome}
              class="rounded-md border border-border-subtle bg-surface"
            >
              <header class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
                <h3 class="text-[11px] uppercase tracking-[0.06em] text-text-tertiary">
                  {i18n.t("projects.deals.panelTitle")}
                </h3>
                <Show when={closedLine(d())}>
                  <span data-testid="deal-panel.closed" class="text-[12px] text-text-secondary">
                    {closedLine(d())}
                  </span>
                </Show>
                <Show when={canWrite()}>
                  <span class="ml-auto flex items-center gap-1">
                    <Show
                      when={d().deal.outcome === "open"}
                      fallback={
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy()}
                          onClick={() => void change("open")}
                        >
                          <span data-testid="deal-panel.reopen">
                            {i18n.t("projects.deals.reopen")}
                          </span>
                        </Button>
                      }
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy()}
                        onClick={() => void change("won")}
                      >
                        <Check size={13} aria-hidden="true" />
                        <span data-testid="deal-panel.mark-won">
                          {i18n.t("projects.deals.markWon")}
                        </span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy() || losing()}
                        onClick={() => setLosing(true)}
                      >
                        <span data-testid="deal-panel.mark-lost">
                          {i18n.t("projects.deals.markLost")}
                        </span>
                      </Button>
                    </Show>
                  </span>
                </Show>
              </header>
              <Show when={losing()}>
                <form
                  data-testid="deal-panel.lost-form"
                  class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void change("lost", reason())
                  }}
                >
                  <input
                    data-testid="deal-panel.lost-reason"
                    type="text"
                    maxLength={500}
                    aria-label={i18n.t("projects.deals.lostReason")}
                    placeholder={i18n.t("projects.deals.lostReasonPlaceholder")}
                    value={reason()}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onInput={(e) => setReason(e.currentTarget.value)}
                    class="min-w-[200px] flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text outline-none focus:border-accent-muted"
                  />
                  <Button type="submit" variant="primary" size="sm" disabled={busy()}>
                    <span data-testid="deal-panel.lost-confirm">
                      {i18n.t("projects.deals.markLost")}
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={i18n.t("kernel.common.cancel")}
                    onClick={() => {
                      setLosing(false)
                      setReason("")
                    }}
                  >
                    <X size={13} aria-hidden="true" />
                  </Button>
                </form>
              </Show>
              <div class="px-4 py-2">
                {row(i18n.t("projects.deals.amount"), "deal-panel.amount", () => {
                  const a = amountText(d())
                  return (
                    <span class={a.muted ? "text-text-tertiary" : "font-mono tabular-nums"}>
                      {a.text}
                    </span>
                  )
                })}
                {row(i18n.t("projects.deals.company"), "deal-panel.company", () => (
                  <Show
                    when={d().deal.companyId}
                    fallback={
                      <span class="text-text-tertiary">{i18n.t("projects.deals.none")}</span>
                    }
                  >
                    {(id) => (
                      <button
                        type="button"
                        data-testid="deal-panel.company-link"
                        class="text-left text-text underline decoration-border underline-offset-2 hover:decoration-text"
                        onClick={() => openCompanyTab(id(), d().deal.companyName ?? undefined)}
                      >
                        {d().deal.companyName ?? i18n.t("projects.deals.clientUnavailable")}
                      </button>
                    )}
                  </Show>
                ))}
                {row(i18n.t("projects.deals.contact"), "deal-panel.contact", () => (
                  <Show
                    when={d().deal.contactId}
                    fallback={
                      <span class="text-text-tertiary">{i18n.t("projects.deals.none")}</span>
                    }
                  >
                    {(id) => (
                      <button
                        type="button"
                        data-testid="deal-panel.contact-link"
                        class="text-left text-text underline decoration-border underline-offset-2 hover:decoration-text"
                        onClick={() =>
                          openTab({
                            type: "contact-detail",
                            entityId: id(),
                            label: contact.latest ?? i18n.t("projects.deals.contact"),
                          })
                        }
                      >
                        {contact.latest ?? i18n.t("projects.deals.contact")}
                      </button>
                    )}
                  </Show>
                ))}
                {row(i18n.t("projects.deals.nextStep"), "deal-panel.next-step", () =>
                  d().deal.nextStep ? (
                    d().deal.nextStep
                  ) : (
                    <span class="text-text-tertiary">{i18n.t("projects.deals.none")}</span>
                  ),
                )}
                <Show when={d().deal.outcome === "lost" && d().deal.lostReason}>
                  {row(
                    i18n.t("projects.deals.lostReason"),
                    "deal-panel.lost-reason-text",
                    () => d().deal.lostReason,
                  )}
                </Show>
              </div>
              <Show when={d().deal.outcome === "open" && routine.latest}>
                {(name) => (
                  <p
                    data-testid="deal-panel.routine-line"
                    class="border-t border-border-subtle px-4 py-2 text-[12px] text-text-secondary"
                  >
                    {props.ownerName
                      ? i18n.t("projects.deals.routineLine", {
                          name: name(),
                          owner: props.ownerName,
                        })
                      : i18n.t("projects.deals.routineLineNoOwner", { name: name() })}
                  </p>
                )}
              </Show>
            </section>
          )}
        </Show>
      </Show>
    </Show>
  )
}

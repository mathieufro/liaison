// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketSummaryCard — collapsible AI summary, with regenerate button.

import type { Component } from "solid-js"
import { createEffect, createMemo, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import {
  applyTicketSummaryResult,
  ticketDetailStore,
  ticketSummaryVersion,
} from "~/modules/tickets/ticket-detail-store"
import {
  handleTicketSummaryEvent,
  isCollapsed,
  ticketSummaryStore,
  toggleSummary,
} from "~/modules/tickets/ticket-summary-store"

interface Props {
  ticketId: string
}

export const TicketSummaryCard: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const ticket = createMemo(() => ticketDetailStore.byId[props.ticketId])
  const collapsed = createMemo(() => isCollapsed(props.ticketId))
  const status = createMemo(
    () => ticketSummaryStore.statusByTicketId[props.ticketId] ?? ticket()?.summaryStatus ?? "idle",
  )
  const hasMessages = createMemo(() => Number(ticket()?.messageCount ?? 1) > 0)
  const summaryError = createMemo(
    () => ticket()?.summaryError ?? i18n.t("tickets.failedToGenerateSummary"),
  )

  // Fire ensureSummary once, as soon as a real ticketId is present. A one-shot
  // `onMount` fires with whatever `props.ticketId` holds at mount — if the card
  // mounts a tick before its id is populated, that sends ensureSummary with no
  // ticketId, which the tool rejects with a 400 (surfaced as an error toast).
  let requested = false
  createEffect(() => {
    const ticketId = props.ticketId
    if (requested || !ticketId) return
    requested = true
    // A live summary event that lands while this is in flight is newer: the
    // answer is then dropped instead of putting the old summary back.
    const version = ticketSummaryVersion(ticketId)
    void runTool(api, "tickets:ensureSummary", { ticketId })
      .then((out) => {
        if (applyTicketSummaryResult(ticketId, out, version)) {
          handleTicketSummaryEvent({ ticketId, ...(out as Record<string, unknown>) })
        }
      })
      .catch(() => {})
  })

  async function regenerate(): Promise<void> {
    try {
      const version = ticketSummaryVersion(props.ticketId)
      const out = await runTool(api, "tickets:regenerateSummary", { ticketId: props.ticketId })
      if (applyTicketSummaryResult(props.ticketId, out, version)) {
        handleTicketSummaryEvent({ ticketId: props.ticketId, ...(out as Record<string, unknown>) })
      }
    } catch {
      // non-fatal
    }
  }

  return (
    <Show when={hasMessages() ? ticket() : null}>
      {(t) => (
        <section
          class="border-b border-border bg-surface-emphasis p-3"
          data-testid="tickets-summary-card"
          data-collapsed={collapsed() ? "true" : "false"}
        >
          <header class="flex items-center justify-between">
            <button
              type="button"
              class="text-sm font-semibold"
              data-testid="tickets-summary-toggle"
              onClick={() => toggleSummary(props.ticketId)}
            >
              {i18n.t("tickets.summary")} {collapsed() ? "▸" : "▾"}
            </button>
            <Show when={!collapsed()}>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-surface-sunken hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="tickets-summary-regenerate"
                disabled={status() === "generating"}
                onClick={() => regenerate()}
              >
                <Show
                  when={status() === "generating"}
                  fallback={t().summaryText ? "Regenerate" : "Generate"}
                >
                  <svg
                    class="h-3 w-3 animate-spin"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      class="stroke-current opacity-25"
                      stroke-width="2"
                    />
                    <path
                      d="M8 2a6 6 0 0 1 6 6"
                      class="stroke-current"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                  {i18n.t("tickets.generating")}
                </Show>
              </button>
            </Show>
          </header>
          <Show when={!collapsed()}>
            <div class="mt-2 text-sm" data-testid="tickets-summary-body">
              <Show when={status() === "generating" && t().summaryText}>
                <p data-testid="tickets-summary-text">{t().summaryText}</p>
                <span class="text-text-tertiary" data-testid="tickets-summary-updating">
                  {i18n.t("tickets.updating")}
                </span>
              </Show>
              <Show when={status() === "generating" && !t().summaryText}>
                <p class="text-text-tertiary" data-testid="tickets-summary-generating">
                  {i18n.t("tickets.generating2")}
                </p>
              </Show>
              <Show when={status() === "error"}>
                <Show when={t().summaryText}>
                  <p data-testid="tickets-summary-text">{t().summaryText}</p>
                </Show>
                <div
                  class="mt-2 flex flex-wrap items-center gap-2 text-red-500"
                  data-testid="tickets-summary-error"
                >
                  <span>{summaryError()}</span>
                  <button
                    type="button"
                    class="rounded border border-red-300 px-2 py-0.5 text-xs"
                    data-testid="tickets-summary-retry"
                    onClick={() => regenerate()}
                  >
                    {i18n.t("kernel.common.retry2")}
                  </button>
                  <Show when={summaryError().toLowerCase().includes("credit")}>
                    <button type="button" class="rounded border border-border px-2 py-0.5 text-xs">
                      {i18n.t("tickets.topUpCredits")}
                    </button>
                  </Show>
                </div>
              </Show>
              <Show when={status() !== "generating" && status() !== "error"}>
                <Show
                  when={t().summaryText}
                  fallback={
                    <p class="text-text-tertiary" data-testid="tickets-summary-empty">
                      {i18n.t("tickets.summaryNotYetGenerated")}
                    </p>
                  }
                >
                  <p data-testid="tickets-summary-text">{t().summaryText}</p>
                </Show>
              </Show>
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}

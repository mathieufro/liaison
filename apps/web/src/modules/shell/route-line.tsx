// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO A ROW IS FOR, SAID ON THE ROW. A pending approval routed to a person carries its route,
// its placement on this viewer's Home and the names the line says (`metadata.route`,
// `metadata.placement`, `metadata.routeLine`). One "why" line per route and placement; none for
// an owner-routed row or a provider's own row, which keep their label. Also: the "While you
// were away" row's lines, and "away until" for people in pickers.

import type { AttentionItem } from "@liaison/shared"
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { DismissButton } from "~/modules/shell/AttentionRowExtras"
import { attentionStore } from "~/modules/shell/attention-store"
import { addToast } from "~/modules/shell/toast-store"

type T = (key: string, vars?: Record<string, string | number>) => string

interface PersonRoute {
  to: "person"
  userId: string
  why: "asked" | "on_item" | "manager"
  awayUntil: string | null
  standIn: string | null
  blockedStandIn: string | null
}

function personRoute(item: AttentionItem): PersonRoute | null {
  const r = item.metadata?.route as { to?: unknown } | undefined
  return r && r.to === "person" ? (r as PersonRoute) : null
}

function names(item: AttentionItem): {
  forName?: string
  standInName?: string
  blockedName?: string
} {
  const n = item.metadata?.routeLine
  return n && typeof n === "object" ? (n as Record<string, string>) : {}
}

/** "20 Dec" in the reader's language, from a `YYYY-MM-DD` date. */
export function shortDate(date: string, locale: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d)
}

/**
 * The row's "why" line, or null when it has none: an owner-routed row, a provider's row, a row
 * for the usual deciders with nobody blocked, and any row from a feed with no route.
 */
export function routeWhyLine(item: AttentionItem, t: T, locale: string): string | null {
  if (item.action?.type !== "decide_approval") return null
  const route = personRoute(item)
  if (!route) return null
  const placement = item.metadata?.placement
  const n = names(item)
  const someone = n.forName ?? t("kernel.homeRouting.someone")
  if (placement === "standing_in") {
    return t("kernel.homeRouting.standingIn", {
      name: someone,
      date: route.awayUntil ? shortDate(route.awayUntil, locale) : "",
    })
  }
  if (placement === "others") {
    if (route.why === "on_item") return t("kernel.homeRouting.othersOnItem", { name: someone })
    if (route.why === "manager") return t("kernel.homeRouting.othersManager", { name: someone })
    return t("kernel.homeRouting.othersAsked", { name: someone })
  }
  // Mine: the person it is for, or a stand-in walk that stopped at someone who cannot decide.
  if (route.blockedStandIn && n.blockedName) {
    return t("kernel.homeRouting.blocked", { blocked: n.blockedName, name: someone })
  }
  if (route.why === "asked") return t("kernel.homeRouting.mineAsked")
  if (route.why === "manager") return t("kernel.homeRouting.mineManager")
  return t("kernel.homeRouting.mineOnItem")
}

export const RouteWhyLine: Component<{ item: AttentionItem; testId: string }> = (props) => {
  const i18n = useI18n()
  const line = () => routeWhyLine(props.item, i18n.t, i18n.locale())
  return (
    <Show when={line()}>
      {(text) => (
        <span
          data-testid={`${props.testId}-why`}
          class="truncate text-[12px] leading-snug text-text-secondary"
        >
          {text()}
        </span>
      )}
    </Show>
  )
}

/** A row passed on from someone away (`metadata.forUserId`): never set aside by the stand-in. */
export function isPassedOnItem(item: AttentionItem): boolean {
  const f = item.metadata?.forUserId
  return typeof f === "string" && f.length > 0
}

// --- "While you were away" ---------------------------------------------------

export const AWAY_RECAP_KIND = "kernel:away.recap"

interface AwayRecap {
  lines: Array<{
    approvalId: string
    title: string
    outcome: "approved" | "denied"
    decidedByName: string | null
  }>
  more: number
}

export function awayRecapOf(item: AttentionItem): AwayRecap | null {
  if ((item.kind as string) !== AWAY_RECAP_KIND) return null
  const r = item.metadata?.awayRecap as AwayRecap | undefined
  return r && Array.isArray(r.lines) ? r : null
}

export const AwayRecapLines: Component<{ item: AttentionItem; testId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const recap = () => awayRecapOf(props.item)
  async function dismiss(): Promise<void> {
    try {
      await api.post("/attention-items/away-recap/dismiss", { rangeId: props.item.entityId })
      attentionStore.resolveLocally(props.item.id)
    } catch {
      addToast({ message: i18n.t("kernel.homeRouting.dismissFailed"), type: "error" })
    }
  }
  return (
    <Show when={recap()}>
      {(r) => (
        <div class="flex flex-col gap-1">
          <ul
            data-testid={`${props.testId}-recap`}
            class="flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-[12.5px] leading-snug text-text-secondary"
          >
            <For each={r().lines}>
              {(line) => (
                <li class="truncate" data-testid={`${props.testId}-recap-line`}>
                  {i18n.t(
                    line.outcome === "denied"
                      ? "kernel.homeRouting.recapDenied"
                      : "kernel.homeRouting.recapApproved",
                    {
                      title: line.title,
                      name: line.decidedByName ?? i18n.t("kernel.homeRouting.someone"),
                    },
                  )}
                </li>
              )}
            </For>
            <Show when={r().more > 0}>
              <li data-testid={`${props.testId}-recap-more`} class="text-text-tertiary">
                {i18n.t("kernel.homeRouting.recapMore", { count: r().more })}
              </li>
            </Show>
          </ul>
          <div class="flex">
            <DismissButton
              item={props.item}
              testId={props.testId}
              compact={false}
              onDismiss={() => void dismiss()}
            />
          </div>
        </div>
      )}
    </Show>
  )
}

// --- Pickers -----------------------------------------------------------------

/** What a picker says of someone away today, from the last day of their run of away days. */
export function awayLabel(
  away: { until: string | null } | null | undefined,
  t: T,
  locale: string,
  today: string = new Date().toISOString().slice(0, 10),
): string | null {
  if (!away) return null
  if (!away.until || away.until !== today) {
    return away.until
      ? t("kernel.homeRouting.awayUntil", { date: shortDate(away.until, locale) })
      : t("kernel.homeRouting.awayToday")
  }
  // Away today only (a recurring day): name the day they are back, a weekend skipped.
  const back = new Date(`${today}T12:00:00Z`)
  do back.setUTCDate(back.getUTCDate() + 1)
  while (back.getUTCDay() === 0 || back.getUTCDay() === 6)
  const day = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(back)
  return t("kernel.homeRouting.awayTodayBack", { day })
}

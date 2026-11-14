// SPDX-License-Identifier: FSL-1.1-ALv2
// The unified attention surface.
//
// Per spec § 12.3 (kept) + the card redesign (liaison-messaging-visibility,
// Task 8): the page reads top-down — greeting -> live status meta ->
// opt-in notification banner (dismissible) -> "needs you now" URGENT STRIP
// (individual decisions and genuine urgencies that are NOT carded elsewhere:
// scope requests, SLA fires, admin actions, ...) -> reorderable, collapsible
// CARDS (Approvals, Messages, Mail, Activity) -> optional errors footer.
//
// Approvals and mentions used to render as individual NOW rows, so a busy
// approval queue pushed everything else below the fold. They now live in
// their own cards: Approvals shows the first few rows and folds the rest
// behind "Show N more" (a nested scroll box inside the page's own scroll was
// the previous cap: three rows visible, two scrollbars, unreadable), and
// Messages is driven live off the thread-store (WS-instant, self-clearing)
// rather than the 60s-polled attention feed.
//
// First mount runs a 30ms-stagger fade+translate reveal capped at 8 rows for
// the urgent strip and the Approvals card (the two lists that inherited the
// old NOW section's staggered treatment). Subsequent mounts (tab switch
// back) skip the stagger.

import type { ApprovalRequestSummary, AttentionItem } from "@liaison/shared"
import { CheckCheck } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { isHeldKept } from "~/modules/approvals/held-kept"
import { userFromToken } from "~/modules/auth/auth-store"
import { setFocusedDate } from "~/modules/calendar/calendar-store"
import { DemoExampleLine } from "~/modules/demo/DemoExampleLine"
import { englishT, useI18n } from "~/modules/i18n/i18n-context"
import NotificationBanner from "~/modules/notifications/NotificationBanner"
import { pluralFormFor } from "~/modules/projects/plural"
import AlertClusterRow from "~/modules/shell/AlertClusterRow"
import { useApi } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import {
  approvalActionKey,
  isApprovalItem,
  partitionOthersRows,
} from "~/modules/shell/approval-facets"
import { focusedApproval } from "~/modules/shell/approval-focus"
import {
  type AlertEntry,
  type AttentionGroup,
  clusterAlerts,
  GROUP_AUTO_EXPAND_MAX,
  groupLabel,
  kindCountLabel,
  splitFeed,
} from "~/modules/shell/attention-groups"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import { demoOrgSurfaces } from "~/modules/shell/branding-store"
import HomeBriefCard from "~/modules/shell/HomeBriefCard"
import HomeCard from "~/modules/shell/HomeCard"
import {
  currentHomeViewer,
  heldUntilOf,
  homeApprovalItems,
  isApprovalDecisionInFlight,
  isHeldItem,
  isUncountedItem,
} from "~/modules/shell/home-action-count"
import { homeAgents, type TodayEvent, waitingOnOthers } from "~/modules/shell/home-agents-store"
import {
  CARD_IDS,
  type CardId,
  cardOrder,
  hydrateHomeCardLayout,
} from "~/modules/shell/home-card-layout"
import { homeFilter, homeSections, setHomeFilter } from "~/modules/shell/home-filter"
import { homeReadAllPlan } from "~/modules/shell/home-read-all"
import {
  alertClusterOf,
  alertItemsFor,
  approvalFacetOf,
  filterSection,
  type HomeFilter,
  type HomeSections,
  itemsGroup,
  OVERVIEW,
  queueOf,
} from "~/modules/shell/home-sections"
import { coveringOf, coversFor, StandingInLine } from "~/modules/shell/route-line"
import { shellTier } from "~/modules/shell/shell-tier"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { createNow } from "~/primitives/createNow"
import { STALE_AFTER_MS } from "~/primitives/createStaleResource"

interface HomeProps {
  entityId: string
}

const STAGGER_CAP = 8
/** Over this many approval rows, the list folds behind "Show N more"... */
export const APPROVALS_FOLD_OVER = 5
/** ...and shows this many first, in the same order (urgency first). */
export const APPROVALS_FOLD_SHOWN = 3
/**
 * Rows of the merged Alerts & messages card visible before it starts
 * scrolling internally. The card sits ABOVE Approvals in the default order,
 * so an unbounded one buries the approval queue (2026-09-11: 24 SLA alerts
 * did exactly that). Clustering removes most of the volume; this caps what
 * survives clustering. Row heights vary, so the cap is expressed as a
 * max-height ~5 two-line rows tall rather than a slice: nothing is hidden
 * behind a fold, it is all reachable by scrolling inside the card.
 */
const MERGED_LIST_MAX_ROWS = 5
const MERGED_LIST_MAX_HEIGHT = "285px"
const STAGGER_STEP_MS = 30
const STAGGER_DURATION_MS = 200

function staggerStyle(idx: number, active: boolean): JSX.CSSProperties {
  const delay = `${Math.min(idx, STAGGER_CAP) * STAGGER_STEP_MS}ms`
  return {
    opacity: active ? 1 : 0,
    transform: active ? "translateY(0)" : "translateY(4px)",
    transition: `opacity ${STAGGER_DURATION_MS}ms ease-out ${delay}, transform ${STAGGER_DURATION_MS}ms ease-out ${delay}`,
  }
}

interface AttentionFeedViewProps {
  /** "page" (default) is the desktop and tablet landing: the feed as the main
   *  panel. "phone" is the phone tier's Home SCREEN: the same greeting, the
   *  same cards and the same rows with their inline actions, rendered full
   *  width because the phone has no sidebar column beside it. */
  variant?: "page" | "phone"
}

/** The attention feed. It IS Home's landing view, on every tier. */
const AttentionFeedView: Component<AttentionFeedViewProps> = (props) => {
  const i18n = useI18n()
  const isPhone = () => props.variant === "phone"
  const cardTitles = (): Record<CardId, string> => ({
    approvals: i18n.t("kernel.homeCardApprovals"),
    // Conversations left Home for Messages (D21): this card is the alerts.
    messages: i18n.t("kernel.homeSectionAlerts"),
    mail: i18n.t("kernel.homeCardMail"),
    feed: i18n.t("kernel.homeCardActivity"),
  })
  const api = useApi()
  const isActive = useTabIsActive()
  // Ticking clock — makes greeting + "last updated" reactive so they advance
  // instead of freezing at first render. 30s cadence is enough for both.
  const now = createNow(30_000)
  const greeting = (): string => {
    const hour = new Date(now()).getHours()
    if (hour < 12) return i18n.t("kernel.homeGreetingMorning")
    if (hour < 18) return i18n.t("kernel.homeGreetingAfternoon")
    return i18n.t("kernel.homeGreetingEvening")
  }
  const displayName = (): string =>
    userFromToken()?.name ?? i18n.t("kernel.homeGreetingFallbackName")

  const [staggered, setStaggered] = createSignal(false)
  onMount(() => {
    // Trigger the keyframe class on the next frame so the initial render
    // captures the "before" state and CSS transitions into the "after".
    requestAnimationFrame(() => setStaggered(true))
  })

  // Card order/collapse hydration — GET on session start (Home mount), per
  // the persistence design. hydrateHomeCardLayout also registers `api` so
  // the debounced PUT on reorder/collapse has somewhere to send.
  onMount(() => {
    api
      .get<{ homeCardLayout: { order: string[]; collapsed: string[] } | null }>("/user/preferences")
      .then((prefs) => hydrateHomeCardLayout(api, prefs?.homeCardLayout ?? null))
      .catch(() => hydrateHomeCardLayout(api, null))
  })

  const feed = createMemo(() => splitFeed(attentionStore.items))
  // D21: the same model Home's sidebar reads (home-sections.ts). "Needs you"
  // is the Home badge; queues and agents are the rest. Conversations and new
  // mail are not on Home any more: they live in Messages and Mail.
  const sections = homeSections

  // --- Alerts: the "Needs you" items that are not approvals, time-limited
  // first, identical ones clustered (clusterAlerts). ---
  // A time-limited APPROVAL is decided in the Approvals card (which lists every
  // approval, expiring or not); repeating it here drew the same row twice.
  const urgentStrip = createMemo(() => [
    ...sections().needs.timeLimited.filter((item) => !isApprovalItem(item)),
    ...sections().needs.alerts,
  ])

  // --- Approvals card ---
  // A draft the send check stopped is not a decision: it shows with the alerts, uncounted.
  // A held draft is the viewer's own decision and sits here with its Held card, uncounted; once
  // they chose Keep holding it leaves Home until its hold ends, that morning (held-kept.ts).
  const allApprovalItems = createMemo(() =>
    homeApprovalItems(feed().now, true, currentHomeViewer()).filter(
      (i) =>
        !isUncountedItem(i) &&
        !isApprovalDecisionInFlight(i) &&
        !(isHeldItem(i) && isHeldKept(i.entityId, heldUntilOf(i))),
    ),
  )
  // WHOSE THE ROW IS. A row for someone else the viewer can also approve (the server's
  // `placement: others`: the person it is for decides it, or it is a colleague's own request
  // they could approve themselves) is not the viewer's ask: it waits in one closed group at
  // the card's end, with its count, and is in no badge. A feed with no placement reads mine.
  const approvalSplit = createMemo(() => partitionOthersRows(allApprovalItems()))
  const othersRows = createMemo(() => approvalSplit().others)
  const approvalItems = createMemo(() => approvalSplit().mine)
  // A held draft waits on no one until its hold ends, so it is in no count. It sits under the
  // counted rows in its own group with its own count, so the card's count is its list's length.
  const heldRows = createMemo(() => approvalItems().filter((i) => isHeldItem(i)))
  // One list, no per-action filter (the pill on each row names the action). Over five rows the
  // first three show and the rest fold behind "Show N more", order kept.
  const approvalRows = createMemo(() => approvalItems().filter((i) => !isHeldItem(i)))
  const [showAllApprovals, setShowAllApprovals] = createSignal(false)
  const visibleApprovalRows = createMemo(() =>
    showAllApprovals() || approvalRows().length <= APPROVALS_FOLD_OVER
      ? approvalRows()
      : approvalRows().slice(0, APPROVALS_FOLD_SHOWN),
  )
  const foldedApprovals = createMemo(() => approvalRows().length - visibleApprovalRows().length)
  // LIF-18: a notification opened Home for one approval. A fold that hides it opens, so its row
  // can bring itself into view (AttentionRow).
  createEffect(() => {
    const focus = focusedApproval()
    if (focus === null) return
    if (!approvalItems().some((item) => item.entityId === focus)) return
    if (!visibleApprovalRows().some((item) => item.entityId === focus)) setShowAllApprovals(true)
  })

  // Identical alerts collapse to one counted row (clusterAlerts). A
  // time-limited one (a node permission prompt, anything expiring within the
  // hour) never does and takes the top slot; `now()` re-evaluates the window.
  const alertEntries = createMemo(() => clusterAlerts(urgentStrip(), now()))
  // The card's badge counts ITEMS, not rows: "3 alerts" must not read as "1"
  // just because they clustered.
  const messagesCount = createMemo(() => urgentStrip().length)
  // Stopped sends: in the alerts card with their reason, never in a count.
  const uncountedRows = createMemo(() => sections().needs.uncounted)

  // --- Activity card: the viewer's queues, then what agents reported (a
  // routine that failed or paused, then the FYIs). Built without the reader's
  // language: `For` keys on the group object, so a group rebuilt on a language
  // switch was a new group, mounted again (a folded group came back open). Its
  // heading is translated where it renders (`groupLabel`), from `labelKey`. ---
  const activityGroups = createMemo(() => homeActivityGroups(sections()))
  const activityCount = createMemo(() =>
    activityGroups().reduce((sum, g) => sum + g.items.length, 0),
  )
  const groupedCount = createMemo(() => sections().queueTotal)
  const total = createMemo(() => sections().needs.total + activityCount())

  function cardHasContent(id: CardId): boolean {
    switch (id) {
      case "approvals":
        return approvalItems().length > 0 || othersRows().length > 0
      case "messages":
        return messagesCount() > 0 || uncountedRows().length > 0
      // New mail is Mail's (D21): Home no longer repeats it.
      case "mail":
        return false
      case "feed":
        return activityGroups().length > 0
    }
  }

  // Computed from what actually RENDERS, not from the raw item counts:
  // `total()` counts every attention item including kinds that are carded
  // but currently unrenderable (e.g. a `thread_reply` row for a thread
  // outside the client's 50-thread cap, or before hydration) -- if those
  // were the user's ONLY items, the old `total() > 0` gate suppressed
  // the empty state while zero cards and zero strip rows actually rendered,
  // producing a blank Home body under a "NOTHING NEEDS YOU NOW" header.
  const hasAnyContent = createMemo(
    () => urgentStrip().length > 0 || CARD_IDS.some((id) => cardHasContent(id)),
  )
  // A source that did not answer is named in the section, with Retry; the rest still shows.
  const failedSources = createMemo(() => [...new Set(attentionStore.errors.map((e) => e.app))])
  const nothingNeedsYou = createMemo(
    () =>
      sections().needs.total === 0 && approvalItems().length === 0 && urgentStrip().length === 0,
  )

  // "MIS À JOUR JUST NOW" was the tell: the label translated and the figure
  // beside it did not. Both come from the catalog-backed formatter now.
  const lastUpdated = createMemo(() => {
    const ts = attentionStore.lastFetchedAt
    if (!ts) return null
    return formatRelativeTime(new Date(ts).toISOString(), {
      now: new Date(now()),
      i18n: rowLocaleFrom(i18n),
    })
  })

  // Activation revalidation: when this tab becomes active and the attention feed
  // is older than the stale threshold, refetch (debounced by markStaleAndReload).
  // Mirrors createStaleResource's activation gate for a hand-rolled store.
  let wasActive = isActive()
  createEffect(() => {
    const active = isActive()
    const activated = active && !wasActive
    wasActive = active
    if (!activated) return
    const ts = attentionStore.lastFetchedAt
    if (!ts || Date.now() - ts > STALE_AFTER_MS) {
      attentionStore.markStaleAndReload(api)
    }
  })

  const isOverview = () => homeFilter() === OVERVIEW

  return (
    <div
      data-testid="home"
      class={cn(
        "mx-auto flex h-full w-full flex-col",
        isPhone() ? "px-4 pt-5" : "max-w-[1120px] px-5 pt-8 sm:px-8 sm:pt-10 xl:px-10",
      )}
    >
      {/* Header: greeting + status meta-line. The phone screen leads with the
          greeting as a large title, the way every other phone root does.
          It is OPAQUE and sticky: a transparent header let the feed's rows
          show through it as they scrolled, which reads as two lists at once. */}
      <div
        data-testid="home-header"
        class={cn("sticky top-0 z-10 shrink-0 bg-bg", isPhone() ? "-mx-4 px-4" : "-mx-5 px-5")}
      >
        <div class="flex items-start gap-3">
          <h1
            data-testid="home-greeting"
            class={cn(
              "min-w-0 flex-1 font-display font-semibold leading-tight text-text",
              // 32px of greeting on a 390px screen was a third of the fold spent
              // saying good morning. The phone leads with the feed, not the hero.
              isPhone() ? "text-[22px]" : "text-[24px]",
            )}
          >
            {greeting()}, {displayName()}.
          </h1>
          <HomeReadAllButton phone={isPhone()} />
        </div>
        <p
          data-testid="home-status"
          class={cn(
            "mt-1.5 text-text-tertiary",
            // All-caps with letter spacing wrapped to two lines at phone width.
            // One small sentence instead.
            isPhone() ? "text-[12px] leading-snug" : "text-[11px] uppercase tracking-[0.04em]",
          )}
        >
          <Show
            when={total() > 0}
            fallback={
              <Show
                when={attentionStore.errors.length > 0}
                fallback={<span>{i18n.t("kernel.allClear")}</span>}
              >
                <span>{i18n.t("kernel.couldnTLoad")}</span>
              </Show>
            }
          >
            <span>
              <Show
                when={sections().needs.total > 0}
                fallback={<span>{i18n.t("kernel.homeStatusNothingUrgent")}</span>}
              >
                <span class="font-mono tabular-nums">{sections().needs.total}</span>{" "}
                {i18n.t(
                  pluralFormFor(i18n.locale(), sections().needs.total) === "one"
                    ? "kernel.homeStatusNeedYouNowOne"
                    : "kernel.homeStatusNeedYouNowMany",
                )}
              </Show>
              <Show when={groupedCount() > 0}>
                <span class="text-text-tertiary">
                  {" · "}
                  <span class="font-mono tabular-nums">{groupedCount()}</span>{" "}
                  {i18n.t("kernel.homeStatusOtherWork")}
                </span>
              </Show>
              <Show when={lastUpdated()}>
                <span class="text-text-tertiary">
                  {" · "}
                  {i18n.t("kernel.homeStatusUpdated")} {lastUpdated()}
                </span>
              </Show>
            </span>
          </Show>
        </p>
        {/* A demo visitor's workspace says once that the company is an example. */}
        <Show when={demoOrgSurfaces()}>
          <DemoExampleLine class="mt-1.5 text-[12px] text-text-secondary" />
        </Show>
        <StandingInLine onShow={setHomeFilter} />
        <Show when={isPhone()}>
          <HomeSectionChips sections={sections()} />
        </Show>
      </div>

      {/* Feed body: the header above is fixed, this region owns the scroll.
          Every ancestor up to the shell (tab-content-area) is overflow-hidden
          by design, so an unbounded feed here would just clip with no scroll
          surface once it outgrows the viewport. */}
      <div class={cn("min-h-0 flex-1 overflow-y-auto pb-24", isPhone() ? "mt-4" : "mt-8")}>
        <NotificationBanner />
        <Show when={!isOverview()}>
          <HomeSlice filter={homeFilter()} sections={sections()} phone={isPhone()} />
        </Show>
        {/* Nothing of the viewer's own waits: "Needs you" at 0, and the line that says this is
            all, unless a source did not answer or the feed has not loaded yet. */}
        <Show when={isOverview() && nothingNeedsYou()}>
          <div data-testid={hasAnyContent() ? undefined : "home-empty-state"}>
            <HomeNeedsNone complete={!attentionStore.loading && failedSources().length === 0} />
          </div>
        </Show>
        <Show when={isOverview() && hasAnyContent()}>
          {/* Reorderable, collapsible cards. Exactly one home-feed container
              exists whenever there is any content -- the pre-redesign testid
              contract that existing e2e gates on. */}
          <div data-testid="home-feed">
            <For each={cardOrder()}>
              {(id) => (
                <Show when={cardHasContent(id)}>
                  <Switch>
                    <Match when={id === "approvals"}>
                      <HomeCard
                        id="approvals"
                        title={cardTitles().approvals}
                        count={approvalRows().length}
                      >
                        <ul class="divide-y divide-border-subtle">
                          <For each={visibleApprovalRows()}>
                            {(item, idx) => (
                              <div
                                class="will-change-[opacity,transform]"
                                style={staggerStyle(idx(), staggered())}
                              >
                                <AttentionRow item={item} />
                              </div>
                            )}
                          </For>
                        </ul>
                        <Show when={foldedApprovals() > 0 || showAllApprovals()}>
                          <button
                            type="button"
                            data-testid="home-approvals-fold"
                            onClick={() => setShowAllApprovals((v) => !v)}
                            class="flex w-full items-center justify-center gap-1.5 border-t border-border-subtle px-4 py-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                          >
                            <Show
                              when={foldedApprovals() > 0}
                              fallback={<span>{i18n.t("kernel.homeShowFewer")}</span>}
                            >
                              {i18n.t("kernel.homeShowMoreBefore")}{" "}
                              <span class="font-mono tabular-nums">{foldedApprovals()}</span>{" "}
                              {i18n.t("kernel.homeShowMoreAfter")}
                            </Show>
                          </button>
                        </Show>
                        <Show when={heldRows().length > 0}>
                          <HeldGroup rows={heldRows()} />
                        </Show>
                        <Show when={othersRows().length > 0}>
                          <OthersGroup rows={othersRows()} />
                        </Show>
                      </HomeCard>
                    </Match>
                    <Match when={id === "messages"}>
                      <HomeCard id="messages" title={cardTitles().messages} count={messagesCount()}>
                        {/* Two bounded sections in one card. Each gets its OWN
                            cap rather than sharing one budget: a loud alert
                            stream must not push unread messages out of sight
                            any more than it pushed Approvals off the page.
                            Both stay on screen; volume turns into scroll
                            inside its own section, never into page height. */}
                        <Show when={alertEntries().length > 0}>
                          <BoundedRows
                            testid="home-alerts-list"
                            rows={alertEntries().length}
                            staggered={staggered()}
                          >
                            <For each={alertEntries()}>
                              {(entry, idx) => (
                                <div
                                  class="will-change-[opacity,transform]"
                                  style={staggerStyle(idx(), staggered())}
                                >
                                  <Switch>
                                    <Match when={entry.type === "cluster" && entry.cluster}>
                                      {(cluster) => <AlertClusterRow cluster={cluster()} />}
                                    </Match>
                                    <Match when={entry.type === "item" && entry.item}>
                                      {(item) => <AttentionRow item={item()} />}
                                    </Match>
                                  </Switch>
                                </div>
                              )}
                            </For>
                          </BoundedRows>
                        </Show>
                        <Show when={uncountedRows().length > 0}>
                          <ul data-testid="home-stopped-list" class="divide-y divide-border-subtle">
                            <For each={uncountedRows()}>
                              {(item) => <AttentionRow item={item} />}
                            </For>
                          </ul>
                        </Show>
                      </HomeCard>
                    </Match>
                    <Match when={id === "feed"}>
                      <HomeCard id="feed" title={cardTitles().feed} count={activityCount()}>
                        <For each={activityGroups()}>
                          {(group) => <AttentionGroupSection group={group} />}
                        </For>
                      </HomeCard>
                    </Match>
                  </Switch>
                </Show>
              )}
            </For>
          </div>
        </Show>
        <For each={failedSources()}>
          {(app) => <HomeSourceFailed app={app} onRetry={() => void attentionStore.load(api)} />}
        </For>
        <Show when={isOverview()}>
          <HomeBriefCard />
        </Show>
      </div>
    </div>
  )
}

/** "Needs you" at 0. `complete`: every source answered, so this is everything for now. */
const HomeNeedsNone: Component<{ complete: boolean }> = (props) => {
  const i18n = useI18n()
  return (
    <section
      data-testid="home-needs-none"
      class="mb-5 rounded-md border border-border-subtle bg-surface"
    >
      <header class="flex items-center gap-2 px-4 py-2.5">
        <span class="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
          {i18n.t("kernel.homeDecisions.needsYouTitle")}
        </span>
        <span
          data-testid="home-needs-none-count"
          class="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary"
        >
          0
        </span>
      </header>
      <Show when={props.complete}>
        <p
          data-testid="home-needs-none-closing"
          class="border-t border-border-subtle px-4 py-5 text-[13px] text-text-secondary"
        >
          {i18n.t("kernel.homeDecisions.everythingForNow")}
        </p>
      </Show>
    </section>
  )
}

/**
 * One source that did not answer, named, in the section: what it holds is safe and still
 * waiting, and Retry asks again. The rest of Home shows as usual.
 */
const HomeSourceFailed: Component<{ app: string; onRetry: () => void }> = (props) => {
  const i18n = useI18n()
  // The whole feed failed (attention-store's `_aggregator`): no app to name, so the card says
  // Home could not load rather than "what _aggregator has".
  const feedWide = (): boolean => props.app === "_aggregator"
  const name = (): string => {
    const t = i18n.t(`kernel.nav.${props.app}`)
    return t === `kernel.nav.${props.app}`
      ? props.app.charAt(0).toUpperCase() + props.app.slice(1)
      : t
  }
  return (
    <section
      data-testid={`home-source-failed-${props.app}`}
      class="mb-5 flex items-start gap-3 rounded-md border border-border-subtle bg-surface px-4 py-3"
    >
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium text-text">
          {feedWide()
            ? i18n.t("kernel.homeDecisions.feedFailedTitle")
            : i18n.t("kernel.homeDecisions.sourceFailedTitle", { app: name() })}
        </p>
        <p class="mt-0.5 text-[12px] leading-snug text-text-secondary">
          {feedWide()
            ? i18n.t("kernel.homeDecisions.feedFailedBody")
            : i18n.t("kernel.homeDecisions.sourceFailedBody", { app: name() })}
        </p>
      </div>
      <button
        type="button"
        data-testid={`home-source-failed-${props.app}-retry`}
        class="shrink-0 rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text"
        onClick={() => props.onRetry()}
      >
        {i18n.t("kernel.homeDecisions.retry")}
      </button>
    </section>
  )
}

/**
 * One collapsible group: an uppercase label, a kind-count phrase, a mono total,
 * and (for persisted-event groups) a hover mark-all-read action. Small groups
 * open by default so sparse workspaces read like the old flat feed.
 */
const AttentionGroupSection: Component<{ group: AttentionGroup }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [marking, setMarking] = createSignal(false)

  const kindPhrase = (): string =>
    props.group.kindCounts
      .slice(0, 3)
      .map((k) => kindCountLabel(k.kind, k.count, rowLocaleFrom(i18n)))
      .join(" · ")

  const markAllRead = async (e: MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    if (marking()) return
    setMarking(true)
    try {
      await api.post("/attention-items/mark-read", {
        app: props.group.app,
        kinds: props.group.kindCounts.map((k) => k.kind),
      })
      attentionStore.markStaleAndReload(api)
    } catch {
      setMarking(false)
    }
  }

  return (
    <details
      class="group/section border-b border-border-subtle first:border-t"
      open={props.group.items.length <= GROUP_AUTO_EXPAND_MAX}
      data-testid={`home-group-${props.group.key}`}
    >
      <summary class="flex cursor-pointer list-none items-center gap-3 py-3 pr-3 transition-colors hover:bg-surface-hover/50">
        {/* Chevron rail mirrors the row icon rail (40px). */}
        <span class="flex w-10 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            class="font-mono text-[10px] text-text-tertiary transition-transform duration-150 group-open/section:rotate-90"
          >
            ›
          </span>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-secondary">
            {groupLabel(i18n.t, props.group)}
          </span>
          <span
            data-testid={`home-group-${props.group.key}-kinds`}
            class="truncate text-[11px] leading-tight text-text-tertiary"
          >
            {kindPhrase()}
          </span>
        </span>
        <Show when={props.group.markable}>
          <button
            type="button"
            data-testid={`home-group-${props.group.key}-mark-read`}
            disabled={marking()}
            onClick={(e) => void markAllRead(e)}
            class="flex shrink-0 items-center rounded-sm px-2 py-1 text-[12px] font-medium text-text-tertiary opacity-0 transition-all duration-150 hover:bg-surface-hover hover:text-accent group-hover/section:opacity-100 disabled:opacity-50"
          >
            {marking() ? i18n.t("kernel.homeMarkingRead") : i18n.t("kernel.homeMarkAllRead")}
          </button>
        </Show>
        <span
          data-testid={`home-group-${props.group.key}-count`}
          class="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary"
        >
          {props.group.items.length}
        </span>
      </summary>
      <ul class="divide-y divide-border-subtle border-t border-border-subtle">
        <For each={props.group.items}>{(item) => <AttentionRow item={item} />}</For>
      </ul>
    </details>
  )
}

/**
 * A row list that never grows past MERGED_LIST_MAX_ROWS on the page: beyond
 * that it scrolls inside itself. Each section on Home owns its own bound, so
 * one loud section (24 SLA alerts on 2026-09-11) cannot push the quieter ones
 * — unread messages, and the Approvals card below — off a normal-sized screen.
 * Nothing is truncated or hidden behind a fold; the overflow is one scroll away
 * in place.
 *
 * The cap is UNCONDITIONAL, not applied only when the row count looks large.
 * A gestalt walk of the fix caught the hole: the alert section held three rows
 * (under any threshold) but one was a cluster of 24, and expanding it grew the
 * section to 27 rows and pushed unread messages straight back off the page —
 * the exact bug this was meant to end. Content that grows AFTER render (an
 * expanded cluster, an inline approval card opening) is invisible to a
 * row-count test, and `max-height` costs nothing when the content is shorter:
 * no scrollbar appears until there is something to scroll.
 */
const BoundedRows: Component<{
  testid: string
  rows: number
  staggered: boolean
  children: JSX.Element
}> = (props) => {
  // NOT ON A PHONE. The 285px cap keeps one loud section from pushing the
  // quieter ones off a desktop page, where the cards sit side by side and the
  // inner scrollbar is visible. On a phone the cards are a single column the
  // page already scrolls, the inner scrollbar is invisible, and a phone row is
  // taller than a desktop one: the cap landed inside the last row and sliced
  // its "Open" button in half, which reads as a broken card rather than as
  // something to scroll. The card grows with its rows there and the page
  // carries the scroll, which is the gesture a thumb already makes.
  const capped = () => shellTier() !== "phone"
  return (
    <div
      data-testid={props.testid}
      // Whether the section overflows on FIRST render. Reporting only, the cap
      // itself does not depend on it.
      data-scrollable={capped() && props.rows > MERGED_LIST_MAX_ROWS ? "true" : undefined}
      data-capped={capped() ? "true" : "false"}
      class="overscroll-contain"
      style={capped() ? { "max-height": MERGED_LIST_MAX_HEIGHT, "overflow-y": "auto" } : undefined}
    >
      <ul
        class="divide-y divide-border-subtle"
        data-staggered={props.staggered ? "true" : undefined}
      >
        {props.children}
      </ul>
    </div>
  )
}

/** The Activity card's groups: the viewer's queues, then what agents
 *  reported (routines that failed or paused, then FYIs). */
function homeActivityGroups(sections: HomeSections): AttentionGroup[] {
  // The stored label is the English fallback only; the reader's language is
  // applied at render time from the labelKey.
  const t = englishT
  const groups = [...sections.queues]
  if (sections.agents.failed.length > 0) {
    groups.push({
      ...itemsGroup(
        "agents::failed",
        "kernel",
        t("kernel.homeSidebar.routinesFailed"),
        "kernel.homeSidebar.routinesFailed",
        sections.agents.failed,
      ),
      // Marking "all read" would clear every kernel FYI with them.
      markable: false,
    })
  }
  if (sections.agents.notifications.length > 0) {
    groups.push(
      itemsGroup(
        "kernel::notifications",
        "kernel",
        t("kernel.homeGroupNotifications"),
        "kernel.homeGroupNotifications",
        sections.agents.notifications,
      ),
    )
  }
  return groups
}

/**
 * The phone's section chips (D21): the sidebar's sections, one tap each,
 * right under the greeting, so "there are also 40 queued items" is above the
 * fold. A tap filters the feed below; tapping the lit chip goes back to the
 * overview. The navigator sheet holds the full sidebar.
 */
const HomeSectionChips: Component<{ sections: HomeSections }> = (props) => {
  const i18n = useI18n()
  const active = () => filterSection(homeFilter())
  const toggle = (section: "needs" | "queues" | "agents" | "today") =>
    setHomeFilter(active() === section ? OVERVIEW : section)
  const agentsCount = () => props.sections.agents.failed.length
  // The chip opens the Agents slice, so it shows only when that slice has rows.
  const agentsRows = () =>
    props.sections.agents.failed.length +
    props.sections.agents.notifications.length +
    waitingOnOthers().length
  const chip = (on: boolean) =>
    `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors ${
      on
        ? "border-accent-border bg-accent-glow text-accent"
        : "border-border-subtle text-text-secondary hover:bg-surface-hover"
    }`
  return (
    <div
      data-testid="home-section-chips"
      role="group"
      aria-label={i18n.t("kernel.homeSidebar.label")}
      class="-mx-1 mt-3 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
    >
      <button
        type="button"
        data-testid="home-chip-needs"
        aria-pressed={active() === "needs"}
        class={chip(active() === "needs")}
        onClick={() => toggle("needs")}
      >
        <span>{i18n.t("kernel.homeSidebar.needsYou")}</span>
        <Show when={props.sections.needs.total > 0}>
          <span
            data-testid="home-chip-needs-count"
            class="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 font-mono text-[10px] font-semibold tabular-nums text-white"
          >
            {props.sections.needs.total > 99 ? "99+" : props.sections.needs.total}
          </span>
        </Show>
      </button>
      <Show when={props.sections.queueTotal > 0}>
        <button
          type="button"
          data-testid="home-chip-queues"
          aria-pressed={active() === "queues"}
          class={chip(active() === "queues")}
          onClick={() => toggle("queues")}
        >
          <span>{i18n.t("kernel.homeSidebar.queuesChip")}</span>
          <span
            data-testid="home-chip-queues-count"
            class="font-mono text-[11px] tabular-nums text-text-tertiary"
          >
            {props.sections.queueTotal}
          </span>
        </button>
      </Show>
      <Show when={agentsRows() > 0}>
        <button
          type="button"
          data-testid="home-chip-agents"
          aria-pressed={active() === "agents"}
          class={chip(active() === "agents")}
          onClick={() => toggle("agents")}
        >
          <span>{i18n.t("kernel.homeSidebar.agents")}</span>
          <Show when={agentsCount() > 0}>
            <span
              data-testid="home-chip-agents-count"
              class="font-mono text-[11px] font-semibold tabular-nums text-danger"
            >
              {agentsCount()}
            </span>
          </Show>
        </button>
      </Show>
      <Show when={(homeAgents.today()?.length ?? 0) > 0}>
        <button
          type="button"
          data-testid="home-chip-today"
          aria-pressed={active() === "today"}
          class={chip(active() === "today")}
          onClick={() => toggle("today")}
        >
          <span>{i18n.t("kernel.homeSidebar.today")}</span>
        </button>
      </Show>
    </div>
  )
}

/** How long the confirmation's Undo stays offered. */
const READ_ALL_UNDO_MS = 8_000

/**
 * "Mark all as read", scoped to the slice the sidebar (or a phone chip)
 * selected (home-read-all.ts). One request reads every row of the slice that
 * can be read; decisions stay and the confirmation says how many. Hidden when
 * the slice holds nothing it could read (approvals, access requests, rows the
 * apps compute). Lives in the sticky header so it is reachable on a phone.
 */
const HomeReadAllButton: Component<{ phone: boolean }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const plan = createMemo(() => homeReadAllPlan(homeSections(), homeFilter()))
  const plural = (n: number, one: string, many: string) =>
    i18n.t(pluralFormFor(i18n.locale(), n) === "one" ? one : many, { count: String(n) })

  const run = async (): Promise<void> => {
    const p = plan()
    if (busy() || p.entities.length === 0) return
    setBusy(true)
    try {
      const res = await api.post<{ marked: number; eventIds: string[] }>(
        "/attention-items/mark-read-bulk",
        { items: p.entities },
      )
      let message =
        res.marked > 0
          ? plural(res.marked, "kernel.homeReadAll.doneOne", "kernel.homeReadAll.doneMany")
          : i18n.t("kernel.homeReadAll.noneLeft")
      if (p.decisionsLeft > 0) {
        message += ` ${
          p.approvalsLeft === p.decisionsLeft
            ? plural(
                p.approvalsLeft,
                "kernel.homeReadAll.approvalsLeftOne",
                "kernel.homeReadAll.approvalsLeftMany",
              )
            : plural(
                p.decisionsLeft,
                "kernel.homeReadAll.decisionsLeftOne",
                "kernel.homeReadAll.decisionsLeftMany",
              )
        }`
      }
      const eventIds = res.eventIds
      addToast({
        message,
        type: "success",
        ...(eventIds.length > 0
          ? {
              durationMs: READ_ALL_UNDO_MS,
              action: {
                label: i18n.t("kernel.homeReadAll.undo"),
                onClick: () => {
                  api
                    .post("/attention-items/mark-unread", { eventIds })
                    .then(() => attentionStore.load(api))
                    .catch(() =>
                      addToast({ message: i18n.t("kernel.homeReadAll.failed"), type: "error" }),
                    )
                },
              },
            }
          : {}),
      })
      // Reload now rather than on the debounced echo: the slice, the sidebar
      // counts and the Home badge all read this store.
      void attentionStore.load(api)
    } catch {
      addToast({ message: i18n.t("kernel.homeReadAll.failed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={plan().entities.length > 0}>
      <button
        type="button"
        data-testid="home-read-all"
        disabled={busy()}
        title={i18n.t("kernel.homeReadAll.title")}
        aria-label={i18n.t("kernel.homeReadAll.button")}
        onClick={() => void run()}
        // Icon only on a phone: a label pushed the greeting onto a second line
        // at 390 px. The name stays in aria-label and the title.
        class={cn(
          "flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-subtle font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50",
          props.phone ? "mt-0.5 h-8 w-8" : "mt-1 h-8 px-3 text-[12.5px]",
        )}
      >
        <CheckCheck size={props.phone ? 16 : 14} />
        <Show when={!props.phone}>
          <span>{i18n.t("kernel.homeReadAll.button")}</span>
        </Show>
      </button>
    </Show>
  )
}

/**
 * Drafts held by an auto-reply: under the counted rows, with their own count. Each row keeps
 * its Held card and comes back among the counted ones when its hold ends.
 */
const HeldGroup: Component<{ rows: AttentionItem[] }> = (props) => {
  const i18n = useI18n()
  return (
    <div data-testid="home-approvals-held" class="border-t border-border-subtle">
      <div class="flex items-center gap-2 px-4 py-2.5 text-[12px] text-text-tertiary">
        <span>{i18n.t("kernel.homeRouting.heldGroup")}</span>
        <span data-testid="home-approvals-held-count" class="font-mono tabular-nums">
          {props.rows.length}
        </span>
      </div>
      <ul class="divide-y divide-border-subtle">
        <For each={props.rows}>{(item) => <AttentionRow item={item} />}</For>
      </ul>
    </div>
  )
}

/**
 * "For others, you can also approve": rows for someone else, closed by default with their
 * count. Opening it shows each row with its "why" line saying who it is for; the rows stay
 * decidable, they are just not the viewer's ask.
 */
const OthersGroup: Component<{ rows: AttentionItem[] }> = (props) => {
  const i18n = useI18n()
  return (
    <details data-testid="home-approvals-others" class="group/others border-t border-border-subtle">
      <summary
        data-testid="home-approvals-others-summary"
        class="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[12px] text-text-tertiary hover:text-text-secondary"
      >
        <span class="font-mono text-[10px] transition-transform duration-150 group-open/others:rotate-90">
          ›
        </span>
        <span>{i18n.t("kernel.homeRouting.othersGroup")}</span>
        <span data-testid="home-approvals-others-count" class="font-mono tabular-nums">
          {props.rows.length}
        </span>
      </summary>
      <ul class="divide-y divide-border-subtle">
        <For each={props.rows}>{(item) => <AttentionRow item={item} />}</For>
      </ul>
    </details>
  )
}

/**
 * The main panel filtered to one sidebar entry (D21). It reuses Home's own
 * rows (AttentionRow, AlertClusterRow, the inline approval card), so Approve
 * and Reject stay where they are.
 */
const HomeSlice: Component<{ filter: HomeFilter; sections: HomeSections; phone: boolean }> = (
  props,
) => {
  const i18n = useI18n()
  const t = i18n.t
  const s = () => props.sections
  const facet = () => approvalFacetOf(props.filter)
  const cluster = () => alertClusterOf(props.filter)
  const queue = () => queueOf(props.filter)
  const queueGroup = () => s().queues.find((g) => g.key === queue()?.key)
  const queueItems = () => {
    const q = queue()
    const items = queueGroup()?.items ?? []
    return q?.kind ? items.filter((i) => i.kind === q.kind) : items
  }
  const approvals = () => {
    const f = facet()
    return f === null
      ? s().needs.approvals
      : s().needs.approvals.filter((i) => approvalActionKey(i) === f)
  }
  const waiting = waitingOnOthers
  // Covering for a colleague who is away: what the viewer now decides for them, nothing else.
  const coveringId = () => coveringOf(props.filter)
  const covering = (): AttentionItem[] => {
    const id = coveringId()
    if (!id) return []
    return [...s().needs.approvals, ...s().needs.others, ...s().needs.alerts].filter((i) =>
      coversFor(i, id),
    )
  }

  const title = (): string => {
    const f = props.filter
    if (f === "needs") return t("kernel.homeSidebar.needsYou")
    if (f === "needs:time") return t("kernel.homeSidebar.expiringSoon")
    if (f.startsWith("needs:approvals")) return t("kernel.homeCardApprovals")
    if (f === "needs:others") return t("kernel.homeRouting.othersGroup")
    if (coveringId()) return t("kernel.homeRouting.coveringTitle")
    if (f.startsWith("needs:alerts")) return t("kernel.homeSectionAlerts")
    if (f === "queues") return t("kernel.homeSidebar.yourQueues")
    if (f.startsWith("queue:")) {
      const g = queueGroup()
      return g ? groupLabel(t, g) : t("kernel.homeSidebar.yourQueues")
    }
    if (f === "agents") return t("kernel.homeSidebar.agents")
    if (f === "agents:failed") return t("kernel.homeSidebar.routinesFailed")
    if (f === "agents:waiting") return t("kernel.homeSidebar.waitingOnOthers")
    if (f === "agents:notifications") return t("kernel.homeGroupNotifications")
    if (f === "today") return t("kernel.homeSidebar.today")
    return t("kernel.homeSidebar.overview")
  }

  const alertEntriesFor = (): AlertEntry[] =>
    cluster() === null
      ? s().needs.alertEntries
      : alertItemsFor(s(), cluster()).map((item) => ({ type: "item" as const, key: item.id, item }))

  const count = (): number => {
    const f = props.filter
    if (f === "needs") return s().needs.total
    if (f === "needs:time") return s().needs.timeLimited.length
    if (f.startsWith("needs:approvals")) return approvals().length
    if (f === "needs:others") return s().needs.others.length
    if (coveringId()) return covering().length
    if (f.startsWith("needs:alerts")) return alertItemsFor(s(), cluster()).length
    if (f === "queues") return s().queueTotal
    if (f.startsWith("queue:")) return queueItems().length
    if (f === "agents")
      return s().agents.failed.length + waiting().length + s().agents.notifications.length
    if (f === "agents:failed") return s().agents.failed.length
    if (f === "agents:waiting") return waiting().length
    if (f === "agents:notifications") return s().agents.notifications.length
    if (f === "today") return homeAgents.today()?.length ?? 0
    return 0
  }

  const rows = (items: AttentionItem[]) => (
    <ul class="divide-y divide-border-subtle">
      <For each={items}>{(item) => <AttentionRow item={item} />}</For>
    </ul>
  )
  const alerts = () => (
    <ul class="divide-y divide-border-subtle">
      <For each={alertEntriesFor()}>
        {(entry) => (
          <Switch>
            <Match when={entry.type === "cluster" && entry.cluster}>
              {(c) => <AlertClusterRow cluster={c()} />}
            </Match>
            <Match when={entry.type === "item" && entry.item}>
              {(item) => <AttentionRow item={item()} />}
            </Match>
          </Switch>
        )}
      </For>
    </ul>
  )
  const label = (text: string) => (
    <div class="border-b border-border-subtle bg-surface-sunken/30 px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
      {text}
    </div>
  )

  return (
    <section data-testid="home-slice" data-filter={props.filter} class="mb-6">
      <div class="mb-3 flex items-center gap-2 text-[12px] text-text-tertiary">
        <span>{t("kernel.shellUi.showing")}</span>
        <span
          data-testid="home-slice-title"
          class="rounded-full border border-accent-border bg-accent-glow px-2.5 py-[3px] text-[11px] font-medium text-accent"
        >
          {title()} <span class="font-mono tabular-nums">{count()}</span>
        </span>
        <button
          type="button"
          data-testid="home-slice-back"
          class="ml-auto text-text-secondary hover:text-text hover:underline"
          onClick={() => setHomeFilter(OVERVIEW)}
        >
          ← {t("kernel.homeSidebar.overview")}
        </button>
      </div>
      <div class="overflow-clip rounded-lg border border-border-subtle bg-surface">
        <Show
          when={count() > 0}
          fallback={
            <p data-testid="home-slice-empty" class="px-4 py-6 text-[12.5px] text-text-tertiary">
              {t("kernel.shellUi.nothingLeftInThisFilterPick")}
            </p>
          }
        >
          <Switch>
            <Match when={props.filter === "needs"}>
              <Show when={s().needs.timeLimited.length > 0}>{rows(s().needs.timeLimited)}</Show>
              <Show when={s().needs.approvals.length > 0}>
                {label(t("kernel.homeCardApprovals"))}
                {rows(s().needs.approvals)}
              </Show>
              <Show when={s().needs.alerts.length > 0}>
                {label(t("kernel.homeSectionAlerts"))}
                {alerts()}
              </Show>
            </Match>
            <Match when={props.filter === "needs:time"}>{rows(s().needs.timeLimited)}</Match>
            <Match when={props.filter.startsWith("needs:approvals")}>{rows(approvals())}</Match>
            <Match when={props.filter === "needs:others"}>{rows(s().needs.others)}</Match>
            <Match when={coveringId()}>{rows(covering())}</Match>
            <Match when={props.filter.startsWith("needs:alerts")}>{alerts()}</Match>
            <Match when={props.filter === "queues"}>
              <For each={s().queues}>{(group) => <AttentionGroupSection group={group} />}</For>
            </Match>
            <Match when={props.filter.startsWith("queue:")}>{rows(queueItems())}</Match>
            <Match when={props.filter === "agents"}>
              <Show when={s().agents.failed.length > 0}>
                {label(t("kernel.homeSidebar.routinesFailed"))}
                {rows(s().agents.failed)}
              </Show>
              <Show when={waiting().length > 0}>
                {label(t("kernel.homeSidebar.waitingOnOthers"))}
                <WaitingRows rows={waiting()} />
              </Show>
              <Show when={s().agents.notifications.length > 0}>
                {label(t("kernel.homeGroupNotifications"))}
                {rows(s().agents.notifications)}
              </Show>
            </Match>
            <Match when={props.filter === "agents:failed"}>{rows(s().agents.failed)}</Match>
            <Match when={props.filter === "agents:waiting"}>
              <WaitingRows rows={waiting()} />
            </Match>
            <Match when={props.filter === "agents:notifications"}>
              {rows(s().agents.notifications)}
            </Match>
            <Match when={props.filter === "today"}>
              <TodayRows events={homeAgents.today() ?? []} />
            </Match>
          </Switch>
        </Show>
      </div>
    </section>
  )
}

/** My own pending requests that someone else decides: read-only, each opens
 *  the conversation that holds it. */
const WaitingRows: Component<{ rows: ApprovalRequestSummary[] }> = (props) => {
  const i18n = useI18n()
  const now = createNow(30_000)
  return (
    <ul class="divide-y divide-border-subtle">
      <For each={props.rows}>
        {(row) => (
          <li>
            <button
              type="button"
              data-testid={`home-waiting-row-${row.id}`}
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover/50"
              onClick={() =>
                openTab({
                  type: "thread",
                  entityId: row.threadId,
                  label: row.summary?.title ?? row.handle,
                })
              }
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-medium text-text">
                  {row.summary?.title ?? row.toolName}
                </span>
                <span class="block truncate text-[11.5px] text-text-tertiary">
                  {row.handle} ·{" "}
                  {formatRelativeTime(row.createdAt, {
                    now: new Date(now()),
                    i18n: rowLocaleFrom(i18n),
                  })}
                </span>
              </span>
              <span class="shrink-0 text-[11px] text-text-tertiary">
                {i18n.t("kernel.homeSidebar.waitingBadge")}
              </span>
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}

const TodayRows: Component<{ events: TodayEvent[] }> = (props) => {
  const i18n = useI18n()
  const time = (e: TodayEvent) =>
    e.allDay
      ? i18n.t("kernel.homeSidebar.allDay")
      : new Date(e.start).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" })
  return (
    <ul class="divide-y divide-border-subtle">
      <For each={props.events}>
        {(event) => (
          <li>
            <button
              type="button"
              data-testid={`home-today-row-${event.id}`}
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover/50"
              onClick={() => {
                setFocusedDate(new Date(event.start))
                openTab({
                  type: "calendar:month",
                  entityId: "calendar",
                  label: i18n.t("kernel.nav.calendar"),
                })
              }}
            >
              <span class="w-[64px] shrink-0 font-mono text-[12px] tabular-nums text-text-tertiary">
                {time(event)}
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px] text-text">{event.title}</span>
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}

/**
 * Home. Its landing IS the attention feed, on every tier: the one place that
 * tells you what needs you. Conversations are reached from the Home sidebar
 * (channels and direct messages) and, on the phone, from the Chats seat, so
 * the feed never shares the main panel with a second copy of that list.
 *
 * At phone tier the same feed is the root screen, rendered full width with the
 * phone header: greeting as a large title, then the cards, each row keeping
 * its own inline action.
 */
const Home: Component<HomeProps> = (_props) => (
  <Show
    when={shellTier() !== "phone"}
    fallback={
      <div data-testid="home-phone" class="flex h-full min-h-0 w-full flex-col">
        <AttentionFeedView variant="phone" />
      </div>
    }
  >
    <AttentionFeedView />
  </Show>
)

export default Home

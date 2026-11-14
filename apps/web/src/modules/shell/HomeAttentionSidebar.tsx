// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Home's own sidebar (D21). It used to be the Messages list, so Home and
// Messages read alike and nothing on screen said "there are also 14 tickets
// waiting". This is a table of contents of what is asked of the viewer:
//
//   Overview
//   NEEDS YOU          (total === the Home badge, red counts)
//   YOUR QUEUES        (grey counts, not in the badge)
//   AGENTS             (brief, failed or paused routines, my computer,
//                       waiting on others, notifications)
//   TODAY              (next events, only with a calendar)
//
// Every entry filters Home's main panel (home-filter.ts). It is the registered
// sidebar of the Home tab, so the shell gives it the desktop column, the
// tablet drawer and the phone navigator sheet like any other app's sidebar.

import {
  AlarmClock,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hourglass,
  Laptop,
  LayoutDashboard,
  Sun,
  XCircle,
} from "lucide-solid"
import { type Component, createMemo, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { cn } from "~/lib/cn"
import { approvalActionLabel } from "~/modules/approvals/approval-copy"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { setFocusedDate } from "~/modules/calendar/calendar-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import {
  alertClusterLabel,
  groupLabel,
  groupLabelForApp,
  itemExpiresAt,
  kindShortLabel,
} from "~/modules/shell/attention-groups"
import { rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import { followAttentionFeed, homeAgents, waitingOnOthers } from "~/modules/shell/home-agents-store"
import { homeFilter, homeSections, setHomeFilter } from "~/modules/shell/home-filter"
import type { HomeFilter } from "~/modules/shell/home-sections"
import { openTab } from "~/modules/shell/tab-store"
import {
  hydrateSidebarSections,
  isSectionCollapsed,
  type SidebarSectionId,
  toggleSectionCollapsed,
} from "~/modules/threads/sidebar-sections"

type Tone = "accent" | "muted" | "danger"

/** Open Home (it may not be the active tab, e.g. in the phone sheet) and filter it. */
export function showHomeSlice(filter: HomeFilter, homeLabel: string): void {
  setHomeFilter(filter)
  openTab({ type: "kernel:home", entityId: "home", label: homeLabel, preview: false })
}

const Count: Component<{ value: number | string; tone: Tone; testid?: string }> = (props) => (
  <span
    data-testid={props.testid}
    data-tone={props.tone}
    class={cn(
      "ml-2 shrink-0 font-mono text-[11px] tabular-nums",
      props.tone === "accent" &&
        "flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white",
      props.tone === "danger" && "font-semibold text-danger",
      props.tone === "muted" && "text-text-tertiary",
    )}
  >
    {props.value}
  </span>
)

const Row: Component<{
  testid: string
  label: string
  icon?: Component<{ size?: number }>
  count?: number | string
  tone?: Tone
  sub?: boolean
  active?: boolean
  dim?: boolean
  title?: string
  trailing?: JSX.Element
  onClick: () => void
}> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    aria-current={props.active ? "true" : undefined}
    title={props.title ?? props.label}
    onClick={() => props.onClick()}
    class={cn(
      "flex w-full items-center rounded py-1.5 pr-2 text-left text-[13px] transition-colors",
      props.sub ? "pl-9 text-[12.5px]" : "pl-3",
      props.active
        ? "bg-surface-active font-medium text-text"
        : props.dim
          ? "text-text-tertiary hover:bg-surface-hover"
          : "text-text-secondary hover:bg-surface-hover",
    )}
  >
    <Show when={props.icon && !props.sub}>
      <span class="mr-2 flex w-4 shrink-0 justify-center text-text-tertiary">
        <Dynamic component={props.icon} size={14} />
      </span>
    </Show>
    <span class="min-w-0 flex-1 truncate">{props.label}</span>
    {props.trailing}
    <Show when={props.count !== undefined && props.count !== 0}>
      <Count
        value={props.count ?? 0}
        tone={props.tone ?? "muted"}
        testid={`${props.testid}-count`}
      />
    </Show>
  </button>
)

const SectionHeader: Component<{
  id: SidebarSectionId
  testid: string
  label: string
  total?: number
  onToggle: () => void
}> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    aria-expanded={!isSectionCollapsed(props.id)}
    onClick={() => props.onToggle()}
    class="mt-3 flex w-full items-center px-3 py-1 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-text-tertiary hover:text-text-secondary"
  >
    <span class="mr-1 flex w-3 justify-center">
      <Show when={isSectionCollapsed(props.id)} fallback={<ChevronDown size={12} />}>
        <ChevronRight size={12} />
      </Show>
    </span>
    <span class="flex-1">{props.label}</span>
    <Show when={(props.total ?? 0) > 0}>
      <Count value={props.total ?? 0} tone="accent" testid={`${props.testid}-total`} />
    </Show>
  </button>
)

const HomeAttentionSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const t = i18n.t
  const userId = () => userFromToken()?.userId ?? ""
  const homeLabel = () => i18n.t("kernel.shellUi.home")
  const rowLocale = () => rowLocaleFrom(i18n)
  const sections = homeSections
  const filter = homeFilter

  onMount(() => {
    hydrateSidebarSections(userId())
    const stop = followAttentionFeed(api)
    onCleanup(stop)
  })

  const pick = (f: HomeFilter) => showHomeSlice(f, homeLabel())
  const toggle = (id: SidebarSectionId) => toggleSectionCollapsed(id, userId())
  const open = (id: SidebarSectionId) => !isSectionCollapsed(id)

  const waiting = waitingOnOthers

  const minutesLeft = (expiresAt: number | null): string | undefined => {
    if (expiresAt === null) return undefined
    const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))
    return t("kernel.homeSidebar.minutesLeft", { count: mins })
  }

  const facetLabel = (key: string, label: string, labelKey?: string, pill?: true) => {
    if (labelKey) {
      const said = i18n.t(labelKey)
      if (said !== labelKey || !pill) return said
    }
    if (pill) return label
    return approvalActionLabel(key, label, { t: i18n.t, locale: i18n.locale() }) ?? label
  }

  const clusterRowLabel = (kind: string, count: number) =>
    alertClusterLabel(kind, count, rowLocale()).replace(/^\d+\s+/, "")

  const briefTime = () => {
    // The brief's own time (its newest message), as Home's brief card shows it.
    const at = homeAgents.brief()?.messageAt
    if (!at) return undefined
    return new Date(at).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" })
  }

  function openBrief(): void {
    const b = homeAgents.brief()
    if (b?.outputThreadId) {
      openTab({ type: "thread", entityId: b.outputThreadId, label: b.name })
      return
    }
    openAgentRoutines()
  }

  function openAgentRoutines(): void {
    openTab({
      type: "agent",
      entityId: "self",
      label: i18n.t("kernel.nav.agents"),
      routePath: "/agents/self/routines",
    })
  }

  function openCalendar(at?: string): void {
    if (at) setFocusedDate(new Date(at))
    openTab({ type: "calendar:month", entityId: "calendar", label: i18n.t("kernel.nav.calendar") })
  }

  const eventTime = (start: string, allDay: boolean) =>
    allDay
      ? t("kernel.homeSidebar.allDay")
      : new Date(start).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" })

  // Offer a morning brief only to someone who can create one.
  const canSetUpBrief = () => hasScope("kernel:routines:write")
  const showBriefSetup = () => homeAgents.brief() === null && canSetUpBrief()
  const waitingCount = () => waiting().length
  // Agents shows only when one of its rows does: no empty header.
  const agentsVisible = () =>
    Boolean(homeAgents.brief()) ||
    showBriefSetup() ||
    sections().agents.failed.length > 0 ||
    Boolean(homeAgents.computer()) ||
    waitingCount() > 0 ||
    sections().agents.notifications.length > 0

  const failedSources = createMemo(() =>
    attentionStore.errors.filter((e) => e.app !== "_aggregator").map((e) => e.app),
  )

  return (
    <nav
      data-testid="home-attention-sidebar"
      aria-label={t("kernel.homeSidebar.label")}
      class="flex h-full min-h-0 flex-col overflow-y-auto px-2 pb-6 pt-3"
    >
      <Row
        testid="home-side-overview"
        label={t("kernel.homeSidebar.overview")}
        icon={LayoutDashboard}
        active={filter() === "overview"}
        onClick={() => pick("overview")}
      />

      {/* NEEDS YOU: never hidden, so the viewer knows it was checked. */}
      <SectionHeader
        id="homeNeeds"
        testid="home-side-needs"
        label={t("kernel.homeSidebar.needsYou")}
        total={sections().needs.total}
        onToggle={() => toggle("homeNeeds")}
      />
      <Show when={open("homeNeeds")}>
        <Show
          when={sections().needs.total > 0 || sections().needs.others.length > 0}
          fallback={
            <p
              data-testid="home-side-needs-empty"
              class="px-3 py-1.5 text-[12.5px] text-text-tertiary"
            >
              {t("kernel.homeSidebar.nothingNeedsYou")}
            </p>
          }
        >
          <For each={sections().needs.timeLimited}>
            {(item) => (
              <Row
                testid={`home-side-time-${item.id}`}
                label={item.summary}
                icon={AlarmClock}
                active={filter() === "needs:time"}
                trailing={
                  <span class="ml-2 shrink-0 text-[11px] font-medium text-warning">
                    {minutesLeft(itemExpiresAt(item))}
                  </span>
                }
                onClick={() => pick("needs:time")}
              />
            )}
          </For>
          <Show when={sections().needs.approvals.length > 0 || sections().needs.others.length > 0}>
            <Row
              testid="home-side-approvals"
              label={t("kernel.homeCardApprovals")}
              icon={CheckCircle2}
              count={sections().needs.approvals.length}
              tone="accent"
              active={filter() === "needs:approvals"}
              onClick={() => pick("needs:approvals")}
            />
            <Show when={sections().needs.approvalFacets.length > 1}>
              <For each={sections().needs.approvalFacets}>
                {(facet) => (
                  <Row
                    sub
                    testid={`home-side-approvals-${facet.key}`}
                    label={facetLabel(facet.key, facet.label, facet.labelKey, facet.pill)}
                    count={facet.count}
                    tone="muted"
                    active={filter() === `needs:approvals:${facet.key}`}
                    onClick={() => pick(`needs:approvals:${facet.key}`)}
                  />
                )}
              </For>
            </Show>
            <Show when={sections().needs.others.length > 0}>
              <Row
                sub
                dim
                testid="home-side-others"
                label={t("kernel.homeRouting.othersGroup")}
                count={sections().needs.others.length}
                tone="muted"
                active={filter() === "needs:others"}
                onClick={() => pick("needs:others")}
              />
            </Show>
          </Show>
          <Show when={sections().needs.alerts.length > 0}>
            <Row
              testid="home-side-alerts"
              label={i18n.t("kernel.homeSectionAlerts")}
              icon={AlertTriangle}
              // Rows, as Needs you shows them: alerts of one kind fold into one.
              count={sections().needs.alertEntries.length}
              tone="accent"
              active={filter() === "needs:alerts"}
              onClick={() => pick("needs:alerts")}
            />
            <For each={sections().needs.alertEntries}>
              {(entry) => {
                const key = () =>
                  entry.type === "cluster"
                    ? entry.cluster.key
                    : `${entry.item.app}::${entry.item.kind}`
                return (
                  <Row
                    sub
                    testid={`home-side-alert-${entry.key}`}
                    label={
                      entry.type === "cluster"
                        ? clusterRowLabel(entry.cluster.kind, entry.cluster.items.length)
                        : entry.item.summary
                    }
                    count={entry.type === "cluster" ? entry.cluster.items.length : undefined}
                    tone="muted"
                    active={filter() === `needs:alerts:${key()}`}
                    onClick={() => pick(`needs:alerts:${key()}`)}
                  />
                )
              }}
            </For>
          </Show>
        </Show>
      </Show>

      {/* YOUR QUEUES: hidden when empty. */}
      <Show when={sections().queues.length > 0}>
        <SectionHeader
          id="homeQueues"
          testid="home-side-queues"
          label={t("kernel.homeSidebar.yourQueues")}
          onToggle={() => toggle("homeQueues")}
        />
        <Show when={open("homeQueues")}>
          <For each={sections().queues}>
            {(group) => (
              <>
                <Row
                  testid={`home-side-queue-${group.key}`}
                  label={groupLabel(i18n.t, group) || groupLabelForApp(group.app)}
                  count={group.items.length}
                  tone="muted"
                  active={filter() === `queue:${group.key}`}
                  onClick={() => pick(`queue:${group.key}`)}
                />
                <Show when={group.kindCounts.length > 1}>
                  <For each={group.kindCounts}>
                    {(k) => (
                      <Row
                        sub
                        testid={`home-side-queue-${group.key}-${k.kind}`}
                        label={kindShortLabel(k.kind, rowLocale())}
                        count={k.count}
                        tone="muted"
                        active={filter() === `queue:${group.key}|${k.kind}`}
                        onClick={() => pick(`queue:${group.key}|${k.kind}`)}
                      />
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>
        </Show>
      </Show>

      {/* AGENTS: what agents produced or got stuck on. */}
      <Show when={agentsVisible()}>
        <SectionHeader
          id="homeAgents"
          testid="home-side-agents"
          label={t("kernel.homeSidebar.agents")}
          onToggle={() => toggle("homeAgents")}
        />
      </Show>
      <Show when={agentsVisible() && open("homeAgents")}>
        <Show
          when={homeAgents.brief()}
          fallback={
            <Show when={showBriefSetup()}>
              <Row
                dim
                testid="home-side-brief-setup"
                label={t("kernel.homeSidebar.setUpBrief")}
                icon={Sun}
                onClick={openAgentRoutines}
              />
            </Show>
          }
        >
          <Row
            testid="home-side-brief"
            label={t("kernel.homeSidebar.morningBrief")}
            icon={Sun}
            count={briefTime()}
            tone="muted"
            onClick={openBrief}
          />
        </Show>
        <Show when={sections().agents.failed.length > 0}>
          <Row
            testid="home-side-failed"
            label={t("kernel.homeSidebar.routinesFailed")}
            icon={XCircle}
            count={sections().agents.failed.length}
            tone="danger"
            active={filter() === "agents:failed"}
            onClick={() => pick("agents:failed")}
          />
        </Show>
        <Show when={homeAgents.computer()}>
          {(c) => (
            <Row
              testid="home-side-computer"
              label={t("kernel.homeSidebar.myComputer")}
              icon={Laptop}
              count={
                c().queued > 0
                  ? t("kernel.homeSidebar.queuedCount", { count: c().queued })
                  : undefined
              }
              tone="muted"
              trailing={
                <span
                  data-testid="home-side-computer-status"
                  data-online={c().online ? "true" : "false"}
                  title={
                    c().online ? t("kernel.homeSidebar.online") : t("kernel.homeSidebar.offline")
                  }
                  class={cn(
                    "ml-2 h-2 w-2 shrink-0 rounded-full",
                    c().online ? "bg-success" : "bg-text-tertiary",
                  )}
                />
              }
              onClick={() =>
                openTab({
                  type: "kernel:settings",
                  entityId: "settings",
                  label: i18n.t("kernel.common.settings"),
                  routePath: "/settings/computers",
                  preview: false,
                })
              }
            />
          )}
        </Show>
        <Show when={waiting().length > 0}>
          <Row
            testid="home-side-waiting"
            label={t("kernel.homeSidebar.waitingOnOthers")}
            icon={Hourglass}
            count={waiting().length}
            tone="muted"
            active={filter() === "agents:waiting"}
            onClick={() => pick("agents:waiting")}
          />
        </Show>
        <Show when={sections().agents.notifications.length > 0}>
          <Row
            testid="home-side-notifications"
            label={i18n.t("kernel.homeGroupNotifications")}
            icon={Bell}
            count={sections().agents.notifications.length}
            tone="muted"
            active={filter() === "agents:notifications"}
            onClick={() => pick("agents:notifications")}
          />
        </Show>
      </Show>

      {/* TODAY: only with a calendar that has something left today. */}
      <Show when={(homeAgents.today()?.length ?? 0) > 0}>
        <SectionHeader
          id="homeToday"
          testid="home-side-today"
          label={t("kernel.homeSidebar.today")}
          onToggle={() => toggle("homeToday")}
        />
        <Show when={open("homeToday")}>
          <For each={homeAgents.today() ?? []}>
            {(event) => (
              <button
                type="button"
                data-testid={`home-side-event-${event.id}`}
                onClick={() => openCalendar(event.start)}
                class="flex w-full items-center gap-2 rounded py-1.5 pl-3 pr-2 text-left text-[13px] text-text-secondary hover:bg-surface-hover"
              >
                <span
                  data-testid={`home-side-event-${event.id}-time`}
                  class="min-w-[44px] shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-text-tertiary"
                >
                  {eventTime(event.start, event.allDay)}
                </span>
                <span class="min-w-0 flex-1 truncate">{event.title}</span>
              </button>
            )}
          </For>
          <Row
            dim
            testid="home-side-open-calendar"
            label={t("kernel.homeSidebar.openCalendar")}
            onClick={() => openCalendar()}
          />
        </Show>
      </Show>

      {/* A source that failed says so instead of silently dropping its rows. */}
      <Show when={failedSources().length > 0}>
        <p data-testid="home-side-errors" class="mt-4 px-3 text-[11.5px] text-text-tertiary">
          <For each={failedSources()}>
            {(app) => (
              <span class="block">
                {t("kernel.homeSidebar.sourceUnavailable", { source: groupLabelForApp(app) })}
              </span>
            )}
          </For>
        </p>
      </Show>
    </nav>
  )
}

export default HomeAttentionSidebar

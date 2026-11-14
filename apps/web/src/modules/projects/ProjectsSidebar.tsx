// SPDX-License-Identifier: FSL-1.1-ALv2
// The single navigation surface for the Projects app.
//
// Three stacked regions, separated by 1px hairlines:
//   1. Search input (always-on, plays the same /-shortcut role as everywhere else)
//   2. Controls: filter chips ("Assigned to me" + status labels, contextual to
//      the active project, + due buckets) and saved views
//   3. Project list (active project gets a 2px accent rail): ungrouped projects
//      first, then each project group under its own foldable heading
//      (project-groups.ts, fold state per device), with the archived projects
//      folded underneath
//
// Height budget. Regions 2 and 3 share the body (everything between the search
// and the footer) and each scroll on their own. The project list takes
// whatever the controls leave (`flex-1`, basis 0%). The controls are capped
// at max(half the body, the body minus the list's natural height): a short
// project list lends its unused space to the controls, a long one still gets
// at least half the body.
// Before, only the list could shrink (`min-h-0`) while the filters and saved
// views kept their full content height (`min-height: auto`), so every extra
// status, due bucket or saved view came straight out of the list, down to a
// row or two on a laptop screen.
//
// No workspace top bar. The sidebar is the canonical filter UI; consumers
// (ProjectWorkspace, ProjectsHome) read projectsFilterStore.

import { Archive, ChevronDown, ChevronRight, Search } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { isFeatureOff } from "~/framework/org-features"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { crossProjectTasksStore } from "~/modules/projects/cross-project-tasks-store"
import { dueBucket } from "~/modules/projects/due-status"
import {
  type FoldOwner,
  groupProjects,
  loadFoldedGroups,
  saveFoldedGroups,
} from "~/modules/projects/project-groups"
import { projectStore } from "~/modules/projects/project-store"
import { type DueBucket, projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { type Project, projectsStore } from "~/modules/projects/projects-store"
import { prettyStatus } from "~/modules/projects/status-label"
import { useApi } from "~/modules/shell/ApiContext"
import { SavedViewsList } from "~/modules/shell/saved-views/SavedViewsList"
import { openTab, tabStore } from "~/modules/shell/tab-store"

const DEFAULT_STATUS_LABELS = ["backlog", "todo", "in_progress", "done", "cancelled"] as const

const DUE_BUCKETS: DueBucket[] = ["overdue", "due_soon", "later", "none"]

export const ProjectsSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  onMount(() => {
    if (!projectsStore.loaded) void projectsStore.load(api)
  })

  // Resolve the active project from the open workspace tab — drives the
  // status-pill set and the "active row" rail in the project list.
  const activeProjectId = createMemo<string | null>(() => {
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    if (!tab) return null
    if (tab.type === "projects:project") return tab.entityId ?? null
    if (tab.type === "projects:task") {
      // Best-effort: project-store loads the parent project lazily; if it's
      // already in memory, light up that project. Otherwise no row glows.
      return tab.entityId ? projectStore.projectIdForTask(tab.entityId) : null
    }
    return null
  })

  const activeProject = createMemo(() => {
    const id = activeProjectId()
    if (!id) return null
    return projectStore.project(id)
  })

  /**
   * The search and the filters act on the list and board views. On a task
   * tab those views are hidden, so a change there looked like it did nothing:
   * bring the task's project list forward (opening it when closed), or the
   * projects home when the project is not known yet. The task tab stays open
   * as it was; the list opens as a regular tab so it never replaces a
   * preview task tab.
   */
  const revealTaskList = (): void => {
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    if (tab?.type !== "projects:task" || !tab.entityId) return
    const projectId = projectStore.projectIdForTask(tab.entityId)
    if (projectId) {
      const name =
        projectsStore.items.find((p) => p.id === projectId)?.name ??
        projectStore.project(projectId)?.name ??
        i18n.t("projects.project")
      openTab({ type: "projects:project", entityId: projectId, label: name, preview: false })
      return
    }
    openTab({
      type: "projects:home",
      entityId: "projects-home",
      label: i18n.t("projects.projects"),
      preview: false,
    })
  }
  /** Apply a filter change, then make its result visible. */
  const filterThen = (change: () => void) => () => {
    change()
    revealTaskList()
  }

  const isProjectsHomeTab = createMemo(
    () => tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type === "projects:home",
  )

  const statusLabelsForCurrent = createMemo<string[]>(() => {
    const proj = activeProject()
    if (proj?.statuses?.length) {
      return [...proj.statuses].sort((a, b) => a.order - b.order).map((s) => s.label)
    }
    return [...DEFAULT_STATUS_LABELS]
  })

  const taskCountForLabel = (label: string) => {
    const proj = activeProject()
    if (proj) {
      const status = proj.statuses.find((s) => s.label === label)
      if (!status) return null
      return projectStore.tasksFor(proj.id).filter((t) => t.statusId === status.id).length
    }
    // On projects-home tab only, count the SAME cross-project rows the home list renders (PRJ-5), ensuring the chip count matches what the list displays.
    if (!isProjectsHomeTab() || !projectsFilterStore.isActive) return null
    return crossProjectTasksStore.items().filter((t) => t.statusLabel === label).length
  }

  // Counts are derived from the exact same projectStore.tasksFor() list the
  // rows render from, so a due-bucket chip's count can never drift from the
  // rows it leaves visible when clicked.
  const taskCountForDueBucket = (bucket: DueBucket) => {
    const proj = activeProject()
    const today = new Date().toISOString().slice(0, 10)
    if (proj) {
      const terminalById = new Map(proj.statuses.map((s) => [s.id, s.terminal]))
      return projectStore
        .tasksFor(proj.id)
        .filter(
          (t) => dueBucket(t.dueDate, terminalById.get(t.statusId) ?? false, today) === bucket,
        ).length
    }
    if (!isProjectsHomeTab() || !projectsFilterStore.isActive) return null
    return crossProjectTasksStore
      .items()
      .filter((t) => dueBucket(t.dueDate, t.terminal, today) === bucket).length
  }

  function dueBucketLabel(bucket: DueBucket): string {
    switch (bucket) {
      case "overdue":
        return i18n.t("projects.dueOverdue")
      case "due_soon":
        return i18n.t("projects.dueSoon")
      case "later":
        return i18n.t("projects.dueLater")
      case "none":
        return i18n.t("projects.dueNone")
    }
  }

  const sortedProjects = createMemo(() =>
    [...projectsStore.items]
      .filter((p) => !p.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  // Active projects by group: ungrouped first (no heading), then the groups
  // alphabetically. A folded group keeps its heading and count.
  const grouped = createMemo(() => groupProjects(sortedProjects()))
  // Folds are this person's in this org: a shared device keeps them apart.
  const foldOwner = (): FoldOwner | null => {
    const me = userFromToken()
    return me ? { orgId: me.orgId, userId: me.userId } : null
  }
  const [foldedGroups, setFoldedGroups] = createSignal<string[]>(loadFoldedGroups(foldOwner()))
  const isGroupFolded = (name: string) => foldedGroups().includes(name)
  const toggleGroup = (name: string) => {
    const next = isGroupFolded(name)
      ? foldedGroups().filter((g) => g !== name)
      : [...foldedGroups(), name]
    setFoldedGroups(next)
    saveFoldedGroups(foldOwner(), next)
  }

  const totalTasks = createMemo(() =>
    projectsStore.items
      .filter((p) => !p.archivedAt)
      .reduce((sum, p) => sum + (p.taskCount ?? 0), 0),
  )

  // Archived projects: folded away by default, fetched the first time the
  // fold opens. Opening one lands on its workspace, where Restore lives.
  const [archivedOpen, setArchivedOpen] = createSignal(false)
  const [archivedError, setArchivedError] = createSignal(false)
  const sortedArchived = createMemo(() =>
    [...projectsStore.archivedItems].sort((a, b) => a.name.localeCompare(b.name)),
  )
  let archivedToggleEl: HTMLButtonElement | undefined
  let listScrollEl: HTMLDivElement | undefined
  let listHeadingEl: HTMLHeadingElement | undefined
  let listContentEl: HTMLDivElement | undefined

  // The list's natural height (heading + rows + archived fold), measured, so
  // the controls' cap can give back whatever the list does not need.
  const [listNaturalPx, setListNaturalPx] = createSignal(0)
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !listContentEl) return
    const measure = () =>
      setListNaturalPx(
        Math.ceil((listHeadingEl?.offsetHeight ?? 0) + (listContentEl?.offsetHeight ?? 0)),
      )
    const ro = new ResizeObserver(measure)
    ro.observe(listContentEl)
    measure()
    onCleanup(() => ro.disconnect())
  })
  const controlsMaxHeight = () => {
    const natural = listNaturalPx()
    return natural > 0 ? `max(50%, calc(100% - ${natural}px))` : "50%"
  }
  const toggleArchived = () => {
    const next = !archivedOpen()
    setArchivedOpen(next)
    // The fold opens below the last project, usually out of view in the
    // list's scroll region: bring its header to the top of what is visible.
    // Scroll only the list's own region (scrollIntoView would also move the
    // clipped sidebar and the page).
    if (next) {
      requestAnimationFrame(() => {
        const scroller = listScrollEl
        const toggle = archivedToggleEl
        if (!scroller || !toggle || typeof scroller.scrollTo !== "function") return
        const offset = toggle.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: "smooth" })
      })
    }
    if (next && !projectsStore.archivedLoaded) {
      setArchivedError(false)
      projectsStore.loadArchived(api).catch(() => setArchivedError(true))
    }
  }

  return (
    <div data-testid="projects-sidebar" class="flex h-full min-h-0 w-full flex-col">
      {/* Header */}
      <header class="shrink-0 px-4 pt-5 pb-3">
        <h2 class="font-display text-[15px] font-semibold tracking-tight text-text">
          {i18n.t("projects.projects")}
        </h2>
        <p class="mt-0.5 text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
          <span class="font-mono tabular-nums">{sortedProjects().length}</span>{" "}
          {i18n.t("projects.active")} <span class="font-mono tabular-nums">{totalTasks()}</span>{" "}
          {i18n.t("projects.tasks")}
        </p>
      </header>

      {/* Search */}
      <div class="shrink-0 px-3 pb-3">
        <label class="group relative flex items-center">
          <Search
            class="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-text-tertiary transition-colors group-focus-within:text-text-secondary"
            aria-hidden="true"
          />
          <input
            data-testid="projects-sidebar.search"
            type="text"
            placeholder={i18n.t("projects.searchTasks")}
            value={projectsFilterStore.query}
            onInput={(e) => {
              projectsFilterStore.setQuery(e.currentTarget.value)
              revealTaskList()
            }}
            class="h-8 w-full rounded-sm border border-border-subtle bg-bg pl-8 pr-7 text-[12.5px] text-text placeholder:text-text-tertiary outline-none transition-colors focus:border-accent-border focus:bg-surface"
          />
          <Show when={projectsFilterStore.query.length > 0}>
            <button
              type="button"
              data-testid="projects-sidebar.search-clear"
              onClick={filterThen(() => projectsFilterStore.setQuery(""))}
              class="absolute right-2 text-[11px] text-text-tertiary hover:text-text-secondary"
              aria-label={i18n.t("projects.clearSearch")}
            >
              ×
            </button>
          </Show>
        </label>
      </div>

      <div class="border-t border-border-subtle" />

      {/* Body: everything between the search and the footer. Its height is
          definite (flex-1 of a definite column), so the controls' 50% cap is
          half of THIS space, not of the whole sidebar. */}
      <div data-testid="projects-sidebar.body" class="flex min-h-0 flex-1 flex-col">
        {/* Controls: filters + saved views. One scroll region, capped so the
          project list below keeps at least half the body (see header). */}
        <div
          data-testid="projects-sidebar.controls"
          class="flex min-h-0 flex-col overflow-y-auto overscroll-contain"
          style={{ "max-height": controlsMaxHeight() }}
        >
          {/* Capacity: only once a project uses time and budgets, and only for those who may read it. */}
          <Show
            when={!isFeatureOff("projects", "time_budgets") && hasScope("projects:capacity:read")}
          >
            <section class="flex flex-col gap-1 px-3 pt-3">
              <FilterRow
                testid="side-capacity"
                label={i18n.t("projects.capacity.sidebar")}
                active={
                  tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type ===
                  "projects:capacity"
                }
                onClick={() =>
                  openTab({
                    type: "projects:capacity",
                    entityId: "capacity",
                    label: i18n.t("projects.capacity.tab"),
                    preview: false,
                  })
                }
              />
            </section>
          </Show>
          {/* Filters */}
          <section class="flex flex-col gap-1 px-3 py-3">
            <FilterRow
              testid="projects-sidebar.filter-assigned-to-me"
              label={i18n.t("projects.assignedToMe")}
              active={projectsFilterStore.assignedToMe}
              onClick={filterThen(() => projectsFilterStore.toggleAssignedToMe())}
            />
            {/* The tasks I touched lately (comments, mentions, changes,
                creations, assignments), newest first, across projects or
                within the open one. */}
            <FilterRow
              testid="projects-sidebar.filter-recently-involved"
              label={i18n.t("projects.recentlyInvolved")}
              active={projectsFilterStore.involvedWithinDays !== null}
              onClick={filterThen(() => projectsFilterStore.toggleInvolved())}
            />
            <For each={statusLabelsForCurrent()}>
              {(label) => (
                <FilterRow
                  testid={`projects-sidebar.filter-status-${label}`}
                  label={prettyStatus(label)}
                  active={projectsFilterStore.statusLabels.includes(label)}
                  count={taskCountForLabel(label)}
                  onClick={filterThen(() => projectsFilterStore.toggleStatusLabel(label))}
                />
              )}
            </For>
            <p class="mt-2 px-0.5 text-[10px] uppercase tracking-[0.04em] text-text-tertiary">
              {i18n.t("projects.due")}
            </p>
            <For each={DUE_BUCKETS}>
              {(bucket) => (
                <FilterRow
                  testid={`projects-sidebar.filter-due-${bucket}`}
                  label={dueBucketLabel(bucket)}
                  active={projectsFilterStore.dueBuckets.includes(bucket)}
                  count={taskCountForDueBucket(bucket)}
                  onClick={filterThen(() => projectsFilterStore.toggleDueBucket(bucket))}
                />
              )}
            </For>
            <Show when={projectsFilterStore.isActive}>
              <button
                type="button"
                data-testid="projects-sidebar.filter-clear"
                onClick={filterThen(() => projectsFilterStore.clearAll())}
                class="mt-1 self-start text-[11px] uppercase tracking-[0.04em] text-text-tertiary hover:text-text-secondary"
              >
                {i18n.t("projects.clearFilters")}
              </button>
            </Show>
          </section>

          <div class="border-t border-border-subtle" />

          <SavedViewsList app="projects" viewId={activeProjectId() ? "project" : "home"} />
        </div>

        <div class="border-t border-border-subtle" />

        {/* Projects list: takes all the remaining height, scrolls on its own. */}
        <section data-testid="projects-sidebar.projects" class="flex min-h-0 flex-1 flex-col">
          <h3
            ref={listHeadingEl}
            class="shrink-0 px-4 pt-4 pb-2 text-[11px] uppercase tracking-[0.04em] text-text-tertiary"
          >
            {i18n.t("projects.projects")}
          </h3>
          <div ref={listScrollEl} class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div ref={listContentEl} class="pb-3">
              <ul data-testid="projects-sidebar.list">
                <For each={grouped().ungrouped}>
                  {(p) => (
                    <li>
                      <ActiveProjectRow project={p} active={activeProjectId() === p.id} />
                    </li>
                  )}
                </For>
                <For each={grouped().groups}>
                  {(group) => (
                    <li data-testid={`projects-sidebar.group-${group.name}`}>
                      <button
                        type="button"
                        data-testid={`projects-sidebar.group-toggle-${group.name}`}
                        aria-expanded={!isGroupFolded(group.name)}
                        onClick={() => toggleGroup(group.name)}
                        class="mt-2 flex w-full items-center gap-1.5 px-4 py-1 text-left text-[11px] uppercase tracking-[0.04em] text-text-tertiary transition-colors hover:text-text-secondary"
                      >
                        <Show
                          when={!isGroupFolded(group.name)}
                          fallback={<ChevronRight aria-hidden="true" class="h-3 w-3 shrink-0" />}
                        >
                          <ChevronDown aria-hidden="true" class="h-3 w-3 shrink-0" />
                        </Show>
                        <span class="flex-1 truncate normal-case tracking-normal">
                          {group.name}
                        </span>
                        <span class="font-mono tabular-nums normal-case">
                          {group.projects.length}
                        </span>
                      </button>
                      <Show when={!isGroupFolded(group.name)}>
                        <ul>
                          <For each={group.projects}>
                            {(p) => (
                              <li>
                                <ActiveProjectRow project={p} active={activeProjectId() === p.id} />
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </li>
                  )}
                </For>
                <Show when={sortedProjects().length === 0 && projectsStore.loaded}>
                  <li class="px-4 py-2 text-[12px] text-text-tertiary">
                    {i18n.t("projects.noProjectsYet")}
                  </li>
                </Show>
              </ul>

              {/* Archived fold */}
              <button
                type="button"
                ref={archivedToggleEl}
                data-testid="projects-sidebar.archived-toggle"
                aria-expanded={archivedOpen()}
                onClick={toggleArchived}
                class="mt-2 flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] uppercase tracking-[0.04em] text-text-tertiary transition-colors hover:text-text-secondary"
              >
                <Show
                  when={archivedOpen()}
                  fallback={<ChevronRight aria-hidden="true" class="h-3 w-3" />}
                >
                  <ChevronDown aria-hidden="true" class="h-3 w-3" />
                </Show>
                <span class="flex-1">{i18n.t("projects.archivedProjects")}</span>
                <Show when={projectsStore.archivedLoaded || sortedArchived().length > 0}>
                  <span class="font-mono tabular-nums normal-case">{sortedArchived().length}</span>
                </Show>
              </button>
              <Show when={archivedOpen()}>
                <ul data-testid="projects-sidebar.archived-list">
                  <For each={sortedArchived()}>
                    {(p) => {
                      const isActive = () => activeProjectId() === p.id
                      return (
                        <li>
                          <button
                            type="button"
                            data-testid={`projects-sidebar.archived-row-${p.id}`}
                            data-active={isActive() ? "true" : undefined}
                            onClick={() =>
                              openTab({ type: "projects:project", entityId: p.id, label: p.name })
                            }
                            class="group relative flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
                          >
                            <span
                              aria-hidden="true"
                              class={
                                isActive()
                                  ? "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
                                  : "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-transparent"
                              }
                            />
                            <Archive
                              aria-hidden="true"
                              class="h-3 w-3 shrink-0 text-text-tertiary"
                            />
                            <span class="flex-1 truncate text-[13px] text-text-tertiary group-hover:text-text-secondary">
                              <ProjectKeyPrefix
                                projectKey={p.key}
                                testid={`projects-sidebar.archived-row-key-${p.id}`}
                              />
                              {p.name}
                            </span>
                          </button>
                        </li>
                      )
                    }}
                  </For>
                  <Show when={archivedError()}>
                    <li class="px-4 py-2 text-[12px] text-text-tertiary">
                      {i18n.t("projects.archivedProjectsLoadFailed")}
                    </li>
                  </Show>
                  <Show
                    when={
                      !archivedError() &&
                      projectsStore.archivedLoaded &&
                      sortedArchived().length === 0
                    }
                  >
                    <li class="px-4 py-2 text-[12px] text-text-tertiary">
                      {i18n.t("projects.noArchivedProjects")}
                    </li>
                  </Show>
                </ul>
              </Show>
            </div>
          </div>
        </section>
      </div>

      {/* Footer — quiet meta line. New-project / new-task lives in the main panel header */}
      <footer class="shrink-0 border-t border-border-subtle px-4 py-3 text-[11px] text-text-tertiary">
        <Show
          when={projectsFilterStore.isActive}
          fallback={<span>{i18n.t("projects.pressToSearch")}</span>}
        >
          <span data-testid="projects-sidebar.filter-status">{i18n.t("projects.filtered")}</span>
        </Show>
      </footer>
    </div>
  )
}

/** One active project in the list: opens its workspace; the active one gets the rail. */
const ActiveProjectRow: Component<{ project: Project; active: boolean }> = (props) => (
  <button
    type="button"
    data-testid={`projects-sidebar.row-${props.project.id}`}
    data-active={props.active ? "true" : undefined}
    onClick={() =>
      openTab({
        type: "projects:project",
        entityId: props.project.id,
        label: props.project.name,
      })
    }
    class="group relative flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
  >
    <span
      aria-hidden="true"
      class={
        props.active
          ? "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
          : "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-transparent"
      }
    />
    <span
      class={
        props.active
          ? "flex-1 truncate text-[13px] font-medium text-text"
          : "flex-1 truncate text-[13px] font-medium text-text-secondary group-hover:text-text"
      }
    >
      <ProjectKeyPrefix
        projectKey={props.project.key}
        testid={`projects-sidebar.row-key-${props.project.id}`}
      />
      {props.project.name}
    </span>
    <span class="font-mono text-[11px] tabular-nums text-text-tertiary">
      {props.project.taskCount ?? 0}
    </span>
  </button>
)

/** The project key ahead of its name, small and mono like the workspace header's. */
const ProjectKeyPrefix: Component<{ projectKey: string | null | undefined; testid: string }> = (
  props,
) => (
  <Show when={props.projectKey}>
    <span
      data-testid={props.testid}
      class="mr-1.5 font-mono text-[11px] font-normal text-text-tertiary"
    >
      {props.projectKey}
    </span>
  </Show>
)

const FilterRow: Component<{
  testid: string
  label: string
  active: boolean
  count?: number | null
  onClick: () => void
}> = (props) => {
  return (
    <button
      type="button"
      data-testid={props.testid}
      data-active={props.active ? "true" : undefined}
      onClick={props.onClick}
      class={
        props.active
          ? "flex items-center justify-between gap-2 rounded-sm border border-accent-border bg-accent-glow px-2.5 py-1 text-[12.5px] font-medium text-accent"
          : "flex items-center justify-between gap-2 rounded-sm border border-transparent bg-transparent px-2.5 py-1 text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text"
      }
    >
      <span class="truncate">{props.label}</span>
      <Show when={props.count !== undefined && props.count !== null}>
        <span class="font-mono text-[11px] tabular-nums text-text-tertiary">{props.count}</span>
      </Show>
    </button>
  )
}

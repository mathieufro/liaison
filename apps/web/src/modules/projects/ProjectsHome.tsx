// SPDX-License-Identifier: FSL-1.1-ALv2
// projects:home — the landing pane shown when no project is open.
//
// When filters are active in the sidebar, the pane shows a flat cross-project
// task list matching those filters. Otherwise it stays a project directory.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js"
import { type EntityChangeEvent, onEntityChange } from "~/framework/entity-changes"
import { formatDateTime, formatDay, relativeTime } from "~/lib/relative-time"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type CrossProjectTaskSummary,
  crossProjectTasksStore,
} from "~/modules/projects/cross-project-tasks-store"
import { dueBucket, dueChipColorClass } from "~/modules/projects/due-status"
import { fetchInvolvedTasks, involvementLine } from "~/modules/projects/involved"
import { ensureLabelCatalog } from "~/modules/projects/label-catalog-store"
import { pluralFormFor } from "~/modules/projects/plural"
import { COLOR_OPTIONS, ICON_OPTIONS, projectIcon } from "~/modules/projects/project-appearance"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { type Project, projectsStore } from "~/modules/projects/projects-store"
import { releaseParam } from "~/modules/projects/release-filter"
import { prettyStatus } from "~/modules/projects/status-label"
import { TimeBudgetsSwitch } from "~/modules/projects/TimeBudgetsSwitch"
import { labelsQueryParam } from "~/modules/projects/task-labels"
import { taskMatchesQuery } from "~/modules/projects/task-search"
import { formatMinutes } from "~/modules/projects/time-budgets"
import { useApi } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { openTab } from "~/modules/shell/tab-store"
import { Avatar } from "~/ui/AvatarStack"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import { ResponsiveList } from "~/ui/ResponsiveList"

type CrossProjectTask = CrossProjectTaskSummary

// What the cross-project flat list shows or filters on (key, title, status,
// assignee, due date, release, labels). `statusLabel` resolves to a statusId.
const CROSS_PROJECT_TASK_FIELDS = new Set([
  "title",
  "statusId",
  "statusLabel",
  "assigneeId",
  "dueDate",
  "release",
  "labels",
])
const CROSS_PROJECT_TASK_ACTIONS = new Set(["created", "deleted", "restored", "moved"])

/** `?release=…&labels=…` for a per-project task list, "" when neither is set. */
function taskListQuery(release: string | null, labels: Record<string, string>): string {
  const parts = [releaseParam(release), labelsQueryParam(labels)].filter(
    (part): part is string => part !== null,
  )
  return parts.length > 0 ? `?${parts.join("&")}` : ""
}

function crossProjectListMayChange(e: EntityChangeEvent): boolean {
  if (e.resync || e.key === "projects:project_status") return true
  if (CROSS_PROJECT_TASK_ACTIONS.has(e.action)) return true
  if (e.action !== "updated") return false
  const changed = (e.data as { changedFields?: unknown } | null)?.changedFields
  // An update that does not say what it changed may change anything.
  if (!Array.isArray(changed)) return true
  return changed.some((f) => typeof f === "string" && CROSS_PROJECT_TASK_FIELDS.has(f))
}

export const ProjectsHome: Component<{ entityId: string }> = (_props) => {
  const i18n = useI18n()
  const api = useApi()
  const [newOpen, setNewOpen] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [newDescription, setNewDescription] = createSignal("")
  let descriptionEditor: RichEditorHandle | undefined
  const descriptionEditorDictation = useDictation({ target: () => descriptionEditor })
  const [newColumns, setNewColumns] = createSignal("")
  const [newIcon, setNewIcon] = createSignal(ICON_OPTIONS[0]!.name)
  const [newColor, setNewColor] = createSignal(COLOR_OPTIONS[0]!)
  const [newTimeOn, setNewTimeOn] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [createError, setCreateError] = createSignal<string | null>(null)
  const crossProjectTasks = crossProjectTasksStore.items
  const setCrossProjectTasks = crossProjectTasksStore.setItems
  const [loadingTasks, setLoadingTasks] = createSignal(false)

  onMount(() => {
    if (!projectsStore.loaded) void projectsStore.load(api)
    // The header says how many projects are archived (they live in the
    // sidebar's Archived fold). Fetch that fold once so the count is true on a
    // fresh load, not only for projects archived in this session.
    if (!projectsStore.archivedLoaded) void projectsStore.loadArchived(api).catch(() => {})
  })

  const createProject = async () => {
    const name = newName().trim()
    if (!name) {
      setCreateError(i18n.t("projects.nameIsRequired"))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const description = newDescription().trim()
      // "Idea, In discussion, Done" → the board's columns, in that order. Empty
      // = server defaults. Dedupe/terminal rules are the server's (400 back).
      const statuses = newColumns()
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0)
        .map((label) => ({ label }))
      const created = await api.post<{ id: string; name: string }>("/projects", {
        name,
        ...(description ? { description } : {}),
        icon: newIcon(),
        color: newColor(),
        ...(statuses.length > 0 ? { statuses } : {}),
        ...(newTimeOn() ? { timeBudgets: true } : {}),
      })
      setNewName("")
      setNewDescription("")
      setNewColumns("")
      setNewIcon(ICON_OPTIONS[0]!.name)
      setNewColor(COLOR_OPTIONS[0]!)
      setNewTimeOn(false)
      setNewOpen(false)
      await projectsStore.load(api)
      // Just created by the user — open as a permanent tab, not an ephemeral preview.
      openTab({
        type: "projects:project",
        entityId: created.id,
        label: created.name,
        preview: false,
      })
    } catch (err) {
      setCreateError((err as Error).message ?? i18n.t("projects.createFailed"))
    } finally {
      setCreating(false)
    }
  }

  // When sidebar filters become active on projects-home, fetch a flat
  // cross-project task list so the page stays useful instead of showing the
  // unchanged "open a project" nudge.
  const filtersActive = createMemo(() => projectsFilterStore.isActive)
  const meId = createMemo(() => userFromToken()?.userId ?? null)
  const activeProjects = createMemo(() =>
    projectsStore.items
      .filter((p) => !p.archivedAt)
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  )
  // `items` holds only active projects (the list fetch excludes archived), so
  // counting archived rows in it saw only those archived this session. The
  // union getter also covers the archived fold once the sidebar fetched it.
  const archivedProjectCount = createMemo(() => projectsStore.archivedItems.length)
  const totalTaskCount = createMemo(() =>
    projectsStore.items
      .filter((p) => !p.archivedAt)
      .reduce((sum, p) => sum + (p.taskCount ?? 0), 0),
  )
  const projectsAttention = createMemo(() => attentionStore.attentionForApp("projects"))
  const attentionCountForProject = (projectId: string) =>
    projectsAttention().filter((item) => item.metadata?.projectId === projectId).length

  const refreshCrossProjectTasks = async () => {
    if (!filtersActive()) {
      setCrossProjectTasks([])
      return
    }
    setLoadingTasks(true)
    try {
      // The label filter is applied server-side. Only a label filter needs the
      // catalog: once loaded, the filter store drops the ids it no longer
      // knows (which may leave no filter at all). Without the catalog the raw
      // map goes out and a project answering label_not_found is skipped below.
      if (Object.keys(projectsFilterStore.taskLabels).length > 0) {
        await ensureLabelCatalog(api)
        if (!projectsFilterStore.isActive) {
          setCrossProjectTasks([])
          return
        }
      }
      // "Recently involved": one request across projects, already ordered
      // by the newest involvement; the other filters still apply below.
      const involvedDays = projectsFilterStore.involvedWithinDays
      if (involvedDays !== null) {
        try {
          const involved = await fetchInvolvedTasks(api, {
            days: involvedDays,
            release: projectsFilterStore.release,
            labels: projectsFilterStore.taskLabels,
          })
          setCrossProjectTasks(
            involved.map((t) => ({
              id: t.id,
              key: t.key ?? undefined,
              title: t.title,
              statusLabel: t.statusLabel ?? "",
              terminal: t.statusTerminal,
              projectId: t.projectId,
              projectName: t.projectName,
              assigneeId: t.assigneeId,
              dueDate: t.dueDate,
              ...(t.timeboxMinutes !== undefined ? { timeboxMinutes: t.timeboxMinutes } : {}),
              involvement: t.involvement,
            })),
          )
        } catch {
          setCrossProjectTasks([])
        }
        return
      }
      const query = taskListQuery(projectsFilterStore.release, projectsFilterStore.taskLabels)
      const projects = projectsStore.items.filter((p) => !p.archivedAt)
      const all: CrossProjectTask[] = []
      for (const p of projects) {
        try {
          // GET /api/projects/:id returns the project detail (with statuses).
          // GET /api/projects/:id/tasks returns { items: TaskSummary[] }.
          const [detail, taskList] = await Promise.all([
            api.get<{
              id: string
              statuses: Array<{ id: string; label: string; terminal: boolean }>
            }>(`/projects/${p.id}`),
            api.get<{
              items: Array<{
                id: string
                key?: string
                title: string
                statusId: string
                assigneeId: string | null
                dueDate: string | null
                timeboxMinutes?: number | null
              }>
            }>(`/projects/${p.id}/tasks${query}`),
          ])
          const labelByStatus = new Map(detail.statuses.map((s) => [s.id, s.label]))
          const terminalByStatus = new Map(detail.statuses.map((s) => [s.id, s.terminal]))
          for (const t of taskList.items ?? []) {
            all.push({
              id: t.id,
              key: t.key,
              title: t.title,
              statusLabel: labelByStatus.get(t.statusId) ?? "",
              terminal: terminalByStatus.get(t.statusId) ?? false,
              projectId: p.id,
              projectName: p.name,
              assigneeId: t.assigneeId,
              dueDate: t.dueDate,
              ...(t.timeboxMinutes !== undefined ? { timeboxMinutes: t.timeboxMinutes } : {}),
            })
          }
        } catch {
          /* per-project failure: skip */
        }
      }
      setCrossProjectTasks(all)
    } finally {
      setLoadingTasks(false)
    }
  }

  // Re-fetch whenever the filter shape changes OR when the projects list
  // hydrates after an empty initial render. Without the projectsStore length
  // in the cache key, an early filter activation would cache an empty result.
  // Use createEffect so API calls and signal writes stay outside of memo tracking.
  createEffect(
    on(
      () =>
        `${projectsFilterStore.query}|${projectsFilterStore.assignedToMe}|${projectsFilterStore.statusLabels.join(",")}|${projectsFilterStore.dueBuckets.join(",")}|${projectsFilterStore.release ?? ""}|${JSON.stringify(projectsFilterStore.taskLabels)}|${projectsFilterStore.involvedWithinDays ?? ""}|${projectsStore.items.length}`,
      () => {
        if (projectsFilterStore.isActive) void refreshCrossProjectTasks()
        else setCrossProjectTasks([])
      },
    ),
  )

  // The flat list (and the sidebar chip counts that read the same store) is
  // fetched per filter change, one request pair per project: a task created,
  // deleted, restored or moved by anyone, or an edit to a field the list shows
  // or filters on, refetches it once per burst; any other edit does not.
  // Resync arrives here too.
  onEntityChange(
    ["projects:task", "projects:project_status"],
    (events) => {
      if (projectsFilterStore.isActive && events.some(crossProjectListMayChange)) {
        void refreshCrossProjectTasks()
      }
    },
    { debounceMs: 1500, maxWaitMs: 4000 },
  )

  const filteredCrossProjectTasks = createMemo(() => {
    const tasks = crossProjectTasks()
    const q = projectsFilterStore.query
    const labels = projectsFilterStore.statusLabels
    const dueBuckets = projectsFilterStore.dueBuckets
    const onlyMine = projectsFilterStore.assignedToMe
    const me = meId()
    const today = new Date().toISOString().slice(0, 10)
    return tasks.filter((t) => {
      if (!taskMatchesQuery(t, q)) return false
      if (labels.length > 0 && !labels.includes(t.statusLabel)) return false
      if (dueBuckets.length > 0) {
        const bucket = dueBucket(t.dueDate, t.terminal, today)
        if (!dueBuckets.includes(bucket as (typeof dueBuckets)[number])) return false
      }
      if (onlyMine && t.assigneeId !== me) return false
      return true
    })
  })

  const openTask = (t: CrossProjectTask) => {
    openTab({
      type: "projects:task",
      entityId: t.id,
      label: t.title,
      routePath: `/tasks/${t.id}`,
    })
  }

  const openProject = (project: Project) => {
    openTab({ type: "projects:project", entityId: project.id, label: project.name })
  }

  return (
    <div
      data-testid="projects-home"
      class="mx-auto flex h-full w-full max-w-[760px] flex-col px-8 pt-10 pb-16"
    >
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="font-display text-[22px] font-semibold leading-tight text-text">
            {i18n.t("projects.projects2")}
          </h1>
          <p class="mt-1 text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
            <span class="font-mono tabular-nums">{activeProjects().length}</span>{" "}
            {i18n.t("projects.active")}{" "}
            <span class="font-mono tabular-nums">{totalTaskCount()}</span>{" "}
            {i18n.t("projects.tasks")}
            <Show when={archivedProjectCount() > 0}>
              {" · "}
              <span data-testid="projects-home.archived-count" class="font-mono tabular-nums">
                {archivedProjectCount()}
              </span>{" "}
              {i18n.t("projects.archived")}
            </Show>
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
          <span data-testid="projects-home.new-project">{i18n.t("projects.newProject")}</span>
        </Button>
      </header>

      <Dialog open={newOpen()} onOpenChange={setNewOpen}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("projects.newProject")}</Dialog.Title>
          <div class="mt-3 flex flex-col gap-3">
            <Input
              data-testid="projects-home.new-project-name"
              value={newName()}
              autofocus
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              placeholder={i18n.t("projects.projectName")}
            />
            <div class="flex flex-col gap-1">
              <RichEditor
                preset="full"
                ref={(handle) => {
                  descriptionEditor = handle
                }}
                value={newDescription()}
                onChange={setNewDescription}
                onSubmit={() => void createProject()}
                placeholder={i18n.t("projects.descriptionOptional")}
                data-testid="projects-home.new-project-description"
                class="rounded-sm border border-border bg-bg px-3 py-2 transition-colors duration-150 focus-within:border-accent-muted"
                editorClass="max-h-[30vh] min-h-[4.5rem] overflow-y-auto"
              />
              {/* The wand stays with the field; the mic sits left of Create. */}
              <div class="flex justify-end gap-0.5">
                <ComposerAssist target={() => descriptionEditor} />
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-[12.5px] font-medium text-text-secondary">
                {i18n.t("projects.columnsOptional")}
              </span>
              <Input
                data-testid="projects-home.new-project-columns"
                value={newColumns()}
                onInput={(e) => setNewColumns((e.target as HTMLInputElement).value)}
                placeholder={i18n.t("projects.columnsPlaceholder")}
              />
              <span class="text-[11.5px] text-text-tertiary">{i18n.t("projects.columnsHint")}</span>
            </div>
            <div class="flex flex-col gap-2">
              <span class="text-[12.5px] font-medium text-text-secondary">
                {i18n.t("projects.icon")}
              </span>
              <div class="grid grid-cols-6 gap-1.5" data-testid="projects-home.new-project-icons">
                <For each={ICON_OPTIONS}>
                  {(option) => {
                    const Icon = option.icon
                    return (
                      <button
                        type="button"
                        data-testid={`projects-home.new-project-icon-${option.name}`}
                        aria-pressed={newIcon() === option.name}
                        class={`flex h-8 w-8 items-center justify-center rounded-sm border transition-colors ${
                          newIcon() === option.name
                            ? "border-accent-border bg-accent-glow text-accent"
                            : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                        }`}
                        onClick={() => setNewIcon(option.name)}
                      >
                        <Icon size={15} />
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>
            <div class="flex flex-col gap-2">
              <span class="text-[12.5px] font-medium text-text-secondary">
                {i18n.t("projects.color")}
              </span>
              <div class="grid grid-cols-8 gap-1.5" data-testid="projects-home.new-project-colors">
                <For each={COLOR_OPTIONS}>
                  {(color, index) => (
                    <button
                      type="button"
                      data-testid={`projects-home.new-project-color-${index()}`}
                      aria-pressed={newColor() === color}
                      class={`h-7 w-7 rounded-full border transition-transform ${
                        newColor() === color
                          ? "scale-105 border-accent-border ring-2 ring-accent-glow"
                          : "border-border-subtle"
                      }`}
                      style={{ "background-color": color }}
                      onClick={() => setNewColor(color)}
                    />
                  )}
                </For>
              </div>
            </div>
            <TimeBudgetsSwitch
              api={api}
              on={newTimeOn()}
              onChange={setNewTimeOn}
              idPrefix="projects-home.new-project"
            />
            <Show when={createError()}>
              <p class="text-[12px] text-warning">{createError()}</p>
            </Show>
          </div>
          {/* A take turns this footer into the recorder line. */}
          <div class="mt-4 flex items-center justify-end gap-2">
            <RecorderRow dictation={descriptionEditorDictation}>
              <Button variant="ghost" size="sm" onClick={() => setNewOpen(false)}>
                {i18n.t("kernel.common.cancel")}
              </Button>
              <DictationMic dictation={descriptionEditorDictation} />
              <Button
                variant="primary"
                size="sm"
                disabled={creating()}
                onClick={() => void createProject()}
              >
                <span data-testid="projects-home.new-project-confirm">
                  {i18n.t("projects.createProject")}
                </span>
              </Button>
            </RecorderRow>
          </div>
        </Dialog.Content>
      </Dialog>

      <Show
        when={filtersActive()}
        fallback={
          <ProjectsHomeProjectList
            projects={activeProjects()}
            attentionCountForProject={attentionCountForProject}
            onOpenProject={openProject}
          />
        }
      >
        <section
          data-testid="projects-home.cross-project-results"
          class="mt-8 flex min-h-0 flex-1 flex-col"
        >
          <h2
            data-testid="projects-home.showing-count"
            class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary"
          >
            {i18n.t("projects.showingNofM", {
              n: filteredCrossProjectTasks().length,
              m: crossProjectTasks().length,
            })}
          </h2>
          <ul class="mt-3 min-h-0 flex-1 overflow-y-auto divide-y divide-border-subtle border-y border-border-subtle">
            <Show
              when={!loadingTasks() || filteredCrossProjectTasks().length > 0}
              fallback={
                <li class="py-8 text-center text-[12.5px] text-text-tertiary">
                  {i18n.t("projects.loading")}
                </li>
              }
            >
              <For each={filteredCrossProjectTasks()}>
                {(t) => (
                  <li
                    data-testid={`projects-home.cross-project-row-${t.id}`}
                    onClick={() => openTask(t)}
                    class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-hover"
                  >
                    <Show when={t.key}>
                      <span class="shrink-0 font-mono text-[11px] text-text-tertiary">{t.key}</span>
                    </Show>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-[13px] text-text">{t.title}</span>
                      <Show when={t.involvement}>
                        {(inv) => (
                          <span
                            data-testid={`projects-home.involvement-${t.id}`}
                            title={formatDateTime(inv().at, i18n.locale())}
                            class="truncate text-[11px] text-text-tertiary"
                          >
                            {involvementLine(inv(), i18n.t, i18n.locale())}
                          </span>
                        )}
                      </Show>
                    </span>
                    <span class="text-[11px] text-text-tertiary">{t.projectName}</span>
                    <Show when={typeof t.timeboxMinutes === "number" ? t.timeboxMinutes : null}>
                      {(minutes) => (
                        <span
                          data-testid={`projects-home.row-planned-${t.id}`}
                          class="text-[11px] text-text-tertiary"
                        >
                          {i18n.t("projects.time.rowPlanned", { time: formatMinutes(minutes()) })}
                        </span>
                      )}
                    </Show>
                    <Show when={t.dueDate}>
                      <span
                        title={i18n.t("projects.dueDateTitle", {
                          date: formatDay(t.dueDate, i18n.locale(), { dateStyle: "long" }),
                        })}
                        class={`font-mono text-[11px] tabular-nums ${dueChipColorClass(
                          dueBucket(t.dueDate, t.terminal, new Date().toISOString().slice(0, 10)),
                        )}`}
                      >
                        {formatDay(t.dueDate, i18n.locale())}
                      </span>
                    </Show>
                    <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[11px] text-text-tertiary">
                      {prettyStatus(t.statusLabel)}
                    </span>
                  </li>
                )}
              </For>
              <Show when={!loadingTasks() && filteredCrossProjectTasks().length === 0}>
                <li
                  data-testid="projects-home.no-matches"
                  class="flex flex-col items-center gap-2 py-12 text-center text-[12.5px] text-text-tertiary"
                >
                  <span>{i18n.t("projects.noTasksMatchFilters")}</span>
                  <button
                    type="button"
                    data-testid="projects-home.no-matches-clear"
                    onClick={() => projectsFilterStore.clearAll()}
                    class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary hover:text-text-secondary"
                  >
                    {i18n.t("projects.clearFilters")}
                  </button>
                </li>
              </Show>
            </Show>
          </ul>
        </section>
      </Show>
    </div>
  )
}

const ProjectsHomeProjectList: Component<{
  projects: Project[]
  attentionCountForProject: (projectId: string) => number
  onOpenProject: (project: Project) => void
}> = (props) => {
  const i18n = useI18n()
  // "1 tasks" was hardcoded plural: use the app's {{count}}-plural convention
  // (mirrors kernel.digest.subjectOne/subjectMany) so a single-task project
  // reads "1 task", in both locales. The form itself is locale-aware
  // (pluralFormFor), not a bare `count === 1`: French takes the singular for
  // 0 too, so a 0-task project reads "0 tache", not "0 taches".
  const taskCountLabel = (count: number) =>
    i18n.t(
      pluralFormFor(i18n.locale(), count) === "one"
        ? "projects.taskCountOne"
        : "projects.taskCountMany",
      { count },
    )
  return (
    <section data-testid="projects-home.project-list" class="mt-8 flex min-h-0 flex-1 flex-col">
      <h2 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
        <span class="font-mono tabular-nums">{props.projects.length}</span>{" "}
        {i18n.t("projects.activeProjects")}
      </h2>
      <div class="mt-3 min-h-0 flex-1 overflow-y-auto divide-y divide-border-subtle border-y border-border-subtle">
        <ResponsiveList
          items={props.projects}
          cardClass="mx-3 my-2"
          renderRow={(project) => {
            const owner = () =>
              project.owner ?? { id: project.ownerId, name: "Project owner", avatarUrl: null }
            const attentionCount = () => props.attentionCountForProject(project.id)
            const Icon = projectIcon(project.icon)
            const updated = () => formatUpdated(project.updatedAt, i18n.locale())
            return (
              <button
                type="button"
                data-testid={`projects-home-row-${project.id}`}
                data-project-id={project.id}
                data-project-name={project.name}
                onClick={() => props.onOpenProject(project)}
                class="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-surface-hover"
              >
                <span
                  data-testid={`projects-home-row-${project.id}-icon`}
                  aria-hidden="true"
                  class="flex h-10 w-10 shrink-0 items-center justify-center text-text-secondary"
                  style={{
                    color: project.color
                      ? `color-mix(in oklch, ${project.color} 60%, var(--color-bg))`
                      : undefined,
                  }}
                >
                  <Icon size={18} />
                </span>
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-[15px] font-medium text-text">
                    {project.name}
                  </span>
                  <p class="mt-0.5 truncate text-[11px] text-text-tertiary">
                    {taskCountLabel(project.taskCount)} {i18n.t("projects.updated")} {updated()}
                  </p>
                </div>
                <Show when={attentionCount() > 0}>
                  <span
                    data-testid={`projects-home-row-${project.id}-attention`}
                    class="font-mono text-[12px] tabular-nums text-text-tertiary"
                  >
                    {attentionCount()}
                  </span>
                </Show>
                <span data-testid={`projects-home-row-${project.id}-task-count`} class="sr-only">
                  {taskCountLabel(project.taskCount)}
                </span>
                <Avatar user={owner()} size="sm" />
              </button>
            )
          }}
          renderCard={(project) => {
            const owner = () =>
              project.owner ?? { id: project.ownerId, name: "Project owner", avatarUrl: null }
            const attentionCount = () => props.attentionCountForProject(project.id)
            const Icon = projectIcon(project.icon)
            return (
              <button
                type="button"
                data-testid={`projects-home-card-${project.id}`}
                data-project-id={project.id}
                data-project-name={project.name}
                onClick={() => props.onOpenProject(project)}
                class="flex w-full flex-col gap-1 text-left"
              >
                {/* Project name first: the card's identifying anchor. */}
                <span
                  class="flex items-center gap-2 text-[15px] font-medium text-text"
                  data-testid={`projects-home-card-name-${project.id}`}
                >
                  <Icon size={16} />
                  {project.name}
                </span>
                <span class="text-[12px] text-text-tertiary">
                  {taskCountLabel(project.taskCount)} {"\u00b7"} {i18n.t("projects.updated2")}{" "}
                  {formatUpdated(project.updatedAt, i18n.locale())}
                </span>
                <span class="flex items-center gap-2 text-[12px] text-text-tertiary">
                  <span class="truncate">{owner().name}</span>
                  <Show when={attentionCount() > 0}>
                    <span
                      class="font-mono tabular-nums"
                      data-testid={`projects-home-card-${project.id}-attention`}
                    >
                      {attentionCount()}
                    </span>
                  </Show>
                </span>
              </button>
            )
          }}
        />
        <Show when={props.projects.length === 0}>
          <p class="py-12 text-center text-[12.5px] text-text-tertiary">
            {i18n.t("projects.noActiveProjectsYet")}
          </p>
        </Show>
      </div>
    </section>
  )
}

function formatUpdated(value: string, locale: string): string {
  return relativeTime(value, locale)
}

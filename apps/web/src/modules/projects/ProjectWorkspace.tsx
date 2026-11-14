// SPDX-License-Identifier: FSL-1.1-ALv2
// Project workspace — no top bar.
//
// The sidebar (ProjectsSidebar) is the canonical filter UI; this surface
// renders only the *content* (tasks list or kanban) plus a quiet inline
// header carrying the project name, an optional description, and a small
// view-switcher tucked to the right. New-task + Manage-statuses sit at the
// far right of the header at small ghost-button weight — they never compete
// with the content. Project level actions (Archive project, behind a
// confirmation, or Restore project on an archived one) sit in a "..." project
// menu at the end, apart from the view controls. At phone width Statuses,
// Trash and Filter by release join that menu so the toolbar stays one row.

import {
  Archive,
  ArchiveRestore,
  Columns3,
  Ellipsis,
  GripVertical,
  LayoutGrid,
  Link,
  List as ListIcon,
  ListPlus,
  Pencil,
  Tag,
  Trash2,
  Zap,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { formatDay } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { fetchAssignableMembers } from "~/modules/members/assignable-members"
import { BudgetLine } from "~/modules/projects/BudgetLine"
import { BudgetPanel } from "~/modules/projects/BudgetPanel"
import { formatSums, loadDealBoard, openTotals } from "~/modules/projects/deal-api"
import { computeDropPosition, dndState } from "~/modules/projects/dnd-state"
import { dueBucket, dueChipColorClass } from "~/modules/projects/due-status"
import { FieldsManager } from "~/modules/projects/FieldsManager"
import { fetchInvolvedTasks, type Involvement, involvementLine } from "~/modules/projects/involved"
import { LabelFilterChip, labelFilterHidden } from "~/modules/projects/LabelFilterChip"
import { ensureLabelCatalog } from "~/modules/projects/label-catalog-store"
import { NewTaskDialog } from "~/modules/projects/NewTaskDialog"
import { ProjectEditForm } from "~/modules/projects/ProjectEditForm"
import { ProjectKanbanView } from "~/modules/projects/ProjectKanbanView"
import { archiveProject, restoreProject } from "~/modules/projects/project-archive"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { selectedIds, toggleSelection } from "~/modules/projects/projects-selection-store"
import { ReleaseFilterChip } from "~/modules/projects/ReleaseFilterChip"
import { matchesRelease } from "~/modules/projects/release-filter"
import { StatusManager } from "~/modules/projects/StatusManager"
import { StatusPillPopover } from "~/modules/projects/StatusPillPopover"
import { TaskTrashDialog } from "~/modules/projects/TaskTrashDialog"
import { matchesLabelFilter } from "~/modules/projects/task-labels"
import { taskMatchesQuery } from "~/modules/projects/task-search"
import { budgetFor, loadBudget, timeOn } from "~/modules/projects/time-budgets"
import { useApi } from "~/modules/shell/ApiContext"
import { BulkActionToolbar } from "~/modules/shell/bulk/BulkActionToolbar"
import { copyLink, entityRoute } from "~/modules/shell/entity-link"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { SlotPanels } from "~/modules/shell/SlotPanels"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab, tabStore, updateTabRoutePath } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { PopupMenu } from "~/ui/PopupMenu"

type ViewMode = "list" | "kanban"

function viewFromRoute(routePath: string | undefined): ViewMode {
  if (!routePath) return "list"
  try {
    const url = new URL(routePath, "http://localhost")
    const v = url.searchParams.get("view")
    return v === "kanban" ? "kanban" : "list"
  } catch {
    return "list"
  }
}

interface ProjectWorkspaceProps {
  entityId: string
}

export const ProjectWorkspace: Component<ProjectWorkspaceProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const initialTab = tabStore.tabs.find((t) => t.entityId === props.entityId)
  const [view, setView] = createSignal<ViewMode>(viewFromRoute(initialTab?.routePath))
  // Default to a generous width so the kanban math doesn't degrade before
  // the ResizeObserver fires its first measurement. ResizeObserver is the
  // sole authoritative source thereafter — we don't read getBoundingClientRect
  // synchronously because the workspace pane may still be settling its grid
  // column on first mount, and a transiently small width would lock the view
  // into the degraded fallback even though the final layout is wide enough.
  const [workspaceWidth, setWorkspaceWidth] = createSignal(1440)
  // At phone width the header stacks (title above the toolbar) and each row
  // drops the parts that only serve a pointer: the drag handle (no drag on
  // touch) and the last-edit stamp. With them, a 390px row left the task
  // title three or four letters and the title ran under the view toggle.
  const phone = () => shellTier() === "phone"
  let containerRef: HTMLDivElement | undefined

  onMount(() => {
    void projectStore.load(api, props.entityId)
    void ensureLabelCatalog(api)
    if (containerRef && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width
        // Ignore the first transient narrow value during layout settle —
        // anything below ~200px is almost certainly mid-transition, not the
        // final pane width.
        if (typeof w === "number" && w >= 200) setWorkspaceWidth(w)
      })
      ro.observe(containerRef)
      onCleanup(() => ro.disconnect())
    }
  })

  createEffect(() => {
    const v = view()
    const tab = tabStore.tabs.find((t) => t.entityId === props.entityId)
    if (!tab) return
    const next = `/projects/${props.entityId}?view=${v}`
    if (tab.routePath !== next) {
      updateTabRoutePath(tab.id, next)
    }
  })

  const project = () => projectStore.project(props.entityId)
  const tasks = () => projectStore.tasksFor(props.entityId)

  // A sales pipeline's board reads the deal board: read again whenever a task
  // of the project changes (realtime events) or after a move on the board.
  const isPipeline = () => project()?.kind === "pipeline"
  const tasksSignature = createMemo(() =>
    tasks()
      .map((t) => `${t.id}:${t.statusId}:${t.updatedAt}`)
      .join("|"),
  )
  const [dealBoard, { refetch: refetchDealBoard }] = createResource(
    () => (isPipeline() ? { id: props.entityId, sig: tasksSignature() } : false),
    (key) => loadDealBoard(api, key.id),
  )
  // Reading an errored resource throws; the board then shows its error state.
  const board = () => (dealBoard.error ? undefined : dealBoard.latest)
  const [members] = createResource(
    () => isPipeline(),
    async () => {
      const { items } = await fetchAssignableMembers(api, "")
      return new Map(items.map((m) => [m.id, m.name]))
    },
  )
  const dealSubline = () => {
    const current = board()
    if (!current) return null
    const { count, sums } = openTotals(current)
    if (!sums || sums.length === 0) {
      return count === 1
        ? i18n.t("projects.deals.sublineNoAmountOne")
        : i18n.t("projects.deals.sublineNoAmount", { count })
    }
    const amount = formatSums(sums, i18n.fmtCurrency)
    return count === 1
      ? i18n.t("projects.deals.sublineOne", { amount })
      : i18n.t("projects.deals.subline", { count, amount })
  }
  const isSelected = (taskId: string) => selectedIds().includes(taskId)
  const isArchived = () => !!project()?.archivedAt
  // Time and budgets: the line and the panel exist only while this project uses it. The panel is a
  // right rail on a wide workspace and a block under the line otherwise, open until closed.
  // `planning_off` from any call refetches the project and the fields go.
  const timeActive = () => timeOn(project())
  const timeTurnedOff = () => void projectStore.refresh(api, props.entityId)
  const reloadBudget = () => void loadBudget(api, props.entityId, { onOff: timeTurnedOff })
  const [panelOpen, setPanelOpen] = createSignal<boolean | null>(null)
  const wideRail = () => !phone() && workspaceWidth() >= 960
  const panelShown = () => panelOpen() ?? true
  createEffect(() => {
    if (timeActive() && !isArchived() && !budgetFor(props.entityId)) reloadBudget()
  })
  const [newTaskOpen, setNewTaskOpen] = createSignal(false)
  const [statusManagerOpen, setStatusManagerOpen] = createSignal(false)
  const [fieldsManagerOpen, setFieldsManagerOpen] = createSignal(false)
  // The bin. Archived is NOT a status column — a deleted task leaves the board
  // entirely — so it gets its own panel rather than another lane.
  const [trashOpen, setTrashOpen] = createSignal(false)
  const [trashKey, setTrashKey] = createSignal(0)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = createSignal(false)
  const [archiveBusy, setArchiveBusy] = createSignal(false)
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false)
  // "Edit project" swaps the header's title block for an inline form (no modal).
  const [editing, setEditing] = createSignal(false)
  const [releasePickerOpen, setReleasePickerOpen] = createSignal(false)
  const [labelPickerOpen, setLabelPickerOpen] = createSignal(false)
  const openTrash = () => {
    // Bump BEFORE opening so the panel re-reads the bin instead of showing
    // whatever it held last time it was looked at.
    setTrashKey((k) => k + 1)
    setTrashOpen(true)
  }
  const [inlineDraft, setInlineDraft] = createSignal("")
  const [submittingDraft, setSubmittingDraft] = createSignal(false)

  const confirmArchive = async () => {
    if (archiveBusy()) return
    setArchiveBusy(true)
    try {
      await archiveProject(api, props.entityId)
      setArchiveConfirmOpen(false)
      addToast({ message: i18n.t("projects.projectArchived"), type: "info" })
    } catch {
      addToast({ message: i18n.t("projects.projectArchiveFailed"), type: "error" })
    } finally {
      setArchiveBusy(false)
    }
  }

  const restore = async () => {
    if (archiveBusy()) return
    setArchiveBusy(true)
    try {
      await restoreProject(api, props.entityId)
      addToast({ message: i18n.t("projects.projectRestored"), type: "info" })
    } catch {
      addToast({ message: i18n.t("projects.projectRestoreFailed"), type: "error" })
    } finally {
      setArchiveBusy(false)
    }
  }

  /** The project's Automations open as their own tab (a project-scoped view, never a modal). */
  function openAutomations() {
    openTab({
      type: "projects:automations",
      entityId: props.entityId,
      label: `${i18n.t("projects.automations.title")} · ${project()?.name ?? ""}`,
      routePath: `/automations/${props.entityId}`,
    })
  }

  const openTask = (taskId: string) => {
    const t = tasks().find((x) => x.id === taskId)
    openTab({
      type: "projects:task",
      entityId: taskId,
      label: t?.title ?? i18n.t("projects.task"),
      routePath: `/tasks/${taskId}`,
    })
  }

  const submitInline = async () => {
    const title = inlineDraft().trim()
    if (!title || isArchived()) return
    setSubmittingDraft(true)
    try {
      const created = await api.post<Task>(`/projects/${props.entityId}/tasks`, { title })
      // The row (and its key) shows at once; the WS echo merges by id.
      if (created?.id)
        projectStore.handleTaskEvent("created", { ...created, projectId: props.entityId })
      setInlineDraft("")
    } finally {
      setSubmittingDraft(false)
    }
  }

  const taskById = (id: string) => tasks().find((t) => t.id === id)

  // Filter pipeline. The order matters: filter first, then walk into a tree
  // for ordering — that way subtasks of a hidden parent still surface if they
  // match the filter, just at root level. Otherwise active filters would
  // sometimes hide assigned matches under unmatched parents.
  const currentUserId = createMemo(() => userFromToken()?.userId ?? null)
  // "Recently involved" in this project: the server says which tasks and why
  // (comments, mentions, changes, creations, assignments). Null while off or
  // loading; a failed fetch shows nothing rather than everything.
  const [involvedById, setInvolvedById] = createSignal<Map<string, Involvement> | null>(null)
  let involvedRequest = 0
  createEffect(
    on(
      () => [projectsFilterStore.involvedWithinDays, props.entityId] as const,
      ([days, projectId]) => {
        const req = ++involvedRequest
        if (days === null) {
          setInvolvedById(null)
          return
        }
        fetchInvolvedTasks(api, { days, projectId })
          .then((items) => {
            if (req === involvedRequest) {
              setInvolvedById(new Map(items.map((t) => [t.id, t.involvement])))
            }
          })
          .catch(() => {
            if (req === involvedRequest) setInvolvedById(new Map())
          })
      },
    ),
  )
  const involvementFor = (taskId: string): Involvement | undefined => involvedById()?.get(taskId)
  const matchingTaskIds = createMemo(() => {
    const proj = project()
    if (!proj) return null
    const q = projectsFilterStore.query
    const labels = projectsFilterStore.statusLabels
    const dueBuckets = projectsFilterStore.dueBuckets
    const onlyMine = projectsFilterStore.assignedToMe
    const release = projectsFilterStore.release
    // Already without the ids the catalog no longer knows (a deleted saved-view group).
    const labelFilter = projectsFilterStore.taskLabels
    const meId = currentUserId()
    const involvedOn = projectsFilterStore.involvedWithinDays !== null
    const involved = involvedById()
    const idsByStatus = new Map(proj.statuses.map((s) => [s.id, s.label]))
    const terminalByStatus = new Map(proj.statuses.map((s) => [s.id, s.terminal]))
    const today = new Date().toISOString().slice(0, 10)
    const ids = new Set<string>()
    // The board holds every task of the project, so the effective release
    // (own, else nearest ancestor) is resolved here and follows realtime edits.
    const byId = new Map(tasks().map((t) => [t.id, t]))
    for (const t of tasks()) {
      if (!taskMatchesQuery(t, q)) continue
      if (!matchesRelease(t, byId, release)) continue
      if (!matchesLabelFilter(t, byId, labelFilter)) continue
      if (labels.length > 0) {
        const label = idsByStatus.get(t.statusId)
        if (!label || !labels.includes(label)) continue
      }
      if (dueBuckets.length > 0) {
        const bucket = dueBucket(t.dueDate, terminalByStatus.get(t.statusId) ?? false, today)
        if (!dueBuckets.includes(bucket as (typeof dueBuckets)[number])) continue
      }
      if (onlyMine && t.assigneeId !== meId) continue
      if (involvedOn && !involved?.has(t.id)) continue
      ids.add(t.id)
    }
    return ids
  })

  // List ordering: group by status (in board order), and within the same
  // status oldest edit first, so stale work floats to the top of its group.
  // Position only breaks exact ties.
  const statusOrderById = createMemo(
    () => new Map((project()?.statuses ?? []).map((s) => [s.id, s.order])),
  )
  const compareTasks = (a: Task, b: Task): number => {
    const orders = statusOrderById()
    const sa = orders.get(a.statusId) ?? Number.MAX_SAFE_INTEGER
    const sb = orders.get(b.statusId) ?? Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
    return a.position - b.position
  }

  const orderedTasks = () => {
    const matches = matchingTaskIds()
    const filtering = matches !== null && projectsFilterStore.isActive
    if (!filtering) {
      // No filters: hierarchical walk, siblings sorted by status then edit date.
      const byParent = new Map<string | null, Task[]>()
      for (const t of tasks()) {
        const key = t.parentTaskId ?? null
        const list = byParent.get(key) ?? []
        list.push(t)
        byParent.set(key, list)
      }
      for (const list of byParent.values()) {
        list.sort(compareTasks)
      }
      const result: Array<{ task: Task; depth: number }> = []
      const walk = (parentId: string | null, depth: number) => {
        const list = byParent.get(parentId) ?? []
        for (const t of list) {
          result.push({ task: t, depth })
          walk(t.id, depth + 1)
        }
      }
      walk(null, 1)
      return result
    }
    // Filtering active: flat list of matches at depth 1. "Recently involved"
    // lists the newest involvement first.
    const involved = involvedById()
    const byInvolvement = (a: Task, b: Task): number => {
      const ia = involved?.get(a.id)?.at ?? ""
      const ib = involved?.get(b.id)?.at ?? ""
      return ia === ib ? compareTasks(a, b) : ia < ib ? 1 : -1
    }
    return tasks()
      .filter((t) => matches!.has(t.id))
      .sort(projectsFilterStore.involvedWithinDays !== null ? byInvolvement : compareTasks)
      .map((task) => ({ task, depth: 1 }))
  }

  // Memoized so reactive consumers (ProjectKanbanView) get a stable reference
  // they can iterate without unbinding subtrees.
  const tasksForKanban = createMemo(() => {
    if (!projectsFilterStore.isActive) return tasks()
    const matches = matchingTaskIds()
    if (matches === null) return tasks()
    return tasks().filter((t) => matches.has(t.id))
  })

  // When filters are active, narrow the kanban columns to match the selected
  // status pills — the sidebar's selection IS the column visibility.
  const statusesForKanban = createMemo(() => {
    const all = project()?.statuses ?? []
    const labels = projectsFilterStore.statusLabels
    if (labels.length === 0) return all
    return all.filter((s) => labels.includes(s.label))
  })

  // Tree-line guides per row. Three primitives compose every connector:
  //
  //   topHalf[k]    — straight 1px vertical from row top to row middle at
  //                   boundary k. Painted for ancestor pass-throughs (k < D)
  //                   and also as half of the L-corner at the row's own
  //                   boundary (k == D), there replaced by a curved corner.
  //
  //   bottomHalf[k] — straight 1px vertical from row middle to row bottom at
  //                   boundary k. Painted whenever the immediate next row is
  //                   still a descendant of the ancestor at depth k-1 (i.e.,
  //                   next.depth >= k). This single rule handles BOTH cases:
  //                   - sibling-continuation (k == D, next is sibling/cousin)
  //                   - child-start (k == D+1, next is direct child) — the
  //                     parent paints the lead-in segment so the line flows
  //                     continuously across the row boundary.
  //                   For deeper jumps (next.depth > D+1), the parent paints
  //                   bottom-halves at every intermediate boundary too.
  //
  //   ownDepth      — captured here so the renderer knows which boundary is
  //                   the row's own (where the L-corner replaces top-half).
  //
  // Boundaries iterate from 2 up to max(D, next.depth) so a row can paint
  // segments at boundaries deeper than its own when it has children below.
  // This generalises to arbitrary nesting depth.
  const rowGuides = createMemo(() => {
    const tasks = orderedTasks()
    const map = new Map<
      string,
      { topHalf: Set<number>; bottomHalf: Set<number>; ownDepth: number }
    >()
    for (let i = 0; i < tasks.length; i++) {
      const r = tasks[i]!
      const D = r.depth
      const next = tasks[i + 1]
      const topHalf = new Set<number>()
      const bottomHalf = new Set<number>()
      for (let k = 2; k <= D; k++) topHalf.add(k)
      if (next) {
        for (let k = 2; k <= next.depth; k++) bottomHalf.add(k)
      }
      map.set(r.task.id, { topHalf, bottomHalf, ownDepth: D })
    }
    return map
  })

  const isAncestor = (ancestorId: string, descendantId: string): boolean => {
    let current = taskById(descendantId)
    while (current?.parentTaskId) {
      if (current.parentTaskId === ancestorId) return true
      current = taskById(current.parentTaskId)
    }
    return false
  }

  const dropIsValid = (
    draggedId: string,
    targetId: string,
    position: "above" | "below" | "into",
  ) => {
    if (draggedId === targetId) return { ok: false, reason: "same" }
    if (position === "into" && isAncestor(draggedId, targetId)) {
      return { ok: false, reason: "cycle" }
    }
    // Sibling drop into a target that's a descendant of the dragged is fine —
    // the descendant gets pulled out of the dragged subtree by the move.
    return { ok: true as const }
  }

  // Translate (target, position) into a /move-task request body. Sibling drops
  // ride on parentTaskId of the target; nest drops set parentTaskId to target.
  const onTaskDrop = async (
    draggedId: string,
    targetId: string,
    position: "above" | "below" | "into",
  ) => {
    if (isArchived()) return
    if (!dropIsValid(draggedId, targetId, position).ok) return
    const target = taskById(targetId)
    if (!target) return
    const body =
      position === "into"
        ? { parentTaskId: targetId }
        : position === "above"
          ? {
              parentTaskId: target.parentTaskId,
              beforeTaskId: targetId,
            }
          : {
              parentTaskId: target.parentTaskId,
              afterTaskId: targetId,
            }
    try {
      await api.post(`/projects/${props.entityId}/tasks/${draggedId}/move`, body)
      await projectStore.load(api, props.entityId)
    } catch {
      /* WS reconciliation handles this */
    }
  }

  const loadError = () => projectStore.errorFor(props.entityId)

  return (
    <Show
      when={!(loadError() && !project())}
      fallback={
        <div
          class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
          data-testid="project-workspace.load-failed"
        >
          <div class="font-medium text-text">{i18n.t("projects.thisProjectCanTBeOpened")}</div>
          <div class="max-w-md text-[12.5px] text-text-secondary">
            {i18n.t("projects.itMayHaveBeenDeletedOr")}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void projectStore.load(api, props.entityId)}
          >
            {i18n.t("kernel.common.retry2")}
          </Button>
        </div>
      }
    >
      <div
        ref={containerRef}
        data-testid="project-workspace"
        data-project-id={props.entityId}
        class="flex h-full min-h-0 flex-col"
      >
        {/* Quiet inline header — no chrome, no surface. The sidebar is the chrome. */}
        <header
          data-testid="project-workspace.header"
          data-stacked={phone() ? "true" : "false"}
          class={
            phone()
              ? "flex shrink-0 flex-col items-stretch gap-3 px-4 pt-4 pb-3"
              : "flex shrink-0 items-start justify-between gap-4 px-6 pt-6 pb-4"
          }
        >
          <Show when={editing() && project()}>
            {(p) => <ProjectEditForm api={api} project={p()} onDone={() => setEditing(false)} />}
          </Show>
          <div class="min-w-0 flex-1" classList={{ hidden: editing() }}>
            <h1
              data-testid="project-workspace.title"
              class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 break-words font-display text-[18px] font-semibold leading-tight text-text"
            >
              {project()?.name ?? ""}
              <Show when={project()?.key}>
                <span class="font-mono text-[12px] font-normal text-text-tertiary">
                  {project()?.key}
                </span>
              </Show>
            </h1>
            <MarkdownContent
              content={project()?.description}
              api={api}
              class="mt-1 line-clamp-1 [&_.prose-thread]:text-[12.5px]! [&_.prose-thread]:text-text-tertiary!"
              data-testid="project-workspace.description"
            />
            <Show when={isPipeline() && dealSubline()}>
              <p
                data-testid="project-workspace.deal-subline"
                class="mt-1 text-[12.5px] text-text-secondary"
              >
                {dealSubline()}
              </p>
            </Show>
            <Show when={projectsFilterStore.isActive}>
              <p
                data-testid="project-workspace.showing-count"
                class="mt-1 text-[11px] uppercase tracking-[0.04em] text-text-tertiary"
              >
                {i18n.t("projects.showingNofM", {
                  n: matchingTaskIds()?.size ?? 0,
                  m: tasks().length,
                })}
              </p>
            </Show>
          </div>
          <div
            data-testid="project-workspace.toolbar"
            class={
              phone()
                ? "flex items-center justify-end gap-1"
                : "flex shrink-0 flex-wrap items-center gap-1"
            }
          >
            {/* Phone: one row (view toggle, New task, the project menu). The
                Release chip stays only while a release filter is on, so the
                filter can still be seen and cleared. */}
            <Show when={!phone()}>
              <ReleaseFilterChip api={api} tasks={tasks()} />
              <LabelFilterChip tasks={tasks()} />
              <span class="mx-2 h-4 w-px bg-border-subtle" aria-hidden="true" />
            </Show>
            {/* Phone: the release picker opens from the project menu ("Filter
                by release") and anchors here; an active filter stays on the
                row as a compact chip with its clear control. */}
            <Show when={phone() && (projectsFilterStore.release != null || releasePickerOpen())}>
              <ReleaseFilterChip
                api={api}
                tasks={tasks()}
                compact
                open={releasePickerOpen()}
                onOpenChange={setReleasePickerOpen}
              />
            </Show>
            <Show
              when={
                phone() &&
                (Object.keys(projectsFilterStore.taskLabels).length > 0 || labelPickerOpen())
              }
            >
              <LabelFilterChip
                tasks={tasks()}
                compact
                open={labelPickerOpen()}
                onOpenChange={setLabelPickerOpen}
              />
            </Show>
            <button
              type="button"
              data-testid="project-view-list"
              aria-label={i18n.t("projects.listView")}
              aria-pressed={view() === "list"}
              onClick={() => setView("list")}
              class={
                view() === "list"
                  ? "flex h-7 w-7 items-center justify-center rounded-sm border border-accent-border bg-accent-glow text-accent"
                  : "flex h-7 w-7 items-center justify-center rounded-sm border border-transparent text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
              }
            >
              <ListIcon class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="project-view-kanban"
              aria-label={i18n.t("projects.kanbanView")}
              aria-pressed={view() === "kanban"}
              onClick={() => setView("kanban")}
              class={
                view() === "kanban"
                  ? "flex h-7 w-7 items-center justify-center rounded-sm border border-accent-border bg-accent-glow text-accent"
                  : "flex h-7 w-7 items-center justify-center rounded-sm border border-transparent text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
              }
            >
              <LayoutGrid class="h-3.5 w-3.5" />
            </button>
            <span class="mx-2 h-4 w-px bg-border-subtle" aria-hidden="true" />
            {/* View controls for this board. At phone width they move into the
                project menu so the header keeps one row. */}
            <Show when={!phone()}>
              <Button
                variant="ghost"
                size="sm"
                disabled={isArchived()}
                onClick={() => setStatusManagerOpen(true)}
              >
                <span data-testid="project-workspace.manage-statuses">
                  {i18n.t("projects.statuses")}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isArchived()}
                onClick={() => setFieldsManagerOpen(true)}
              >
                <span data-testid="project-workspace.manage-fields">
                  {i18n.t("projects.fields.manage")}
                </span>
              </Button>
              <Button variant="ghost" size="sm" onClick={openAutomations}>
                <span data-testid="project-workspace.open-automations">
                  {i18n.t("projects.automations.title")}
                </span>
              </Button>
              <Button variant="ghost" size="sm" onClick={openTrash}>
                <span data-testid="project-workspace.open-trash">{i18n.t("projects.trash")}</span>
              </Button>
            </Show>
            <Button
              variant="primary"
              size="sm"
              disabled={isArchived()}
              onClick={() => setNewTaskOpen(true)}
            >
              <span data-testid="project-workspace.new-task">
                {isPipeline() ? i18n.t("projects.deals.newDeal") : i18n.t("projects.newTask")}
              </span>
            </Button>
            {/* Project level actions live in their own menu, apart from the
                view controls: a bare "Archive" beside "Trash" read as "view
                the archive", and the owner could not find it. */}
            <PopupMenu open={projectMenuOpen()} onOpenChange={setProjectMenuOpen}>
              <PopupMenu.Trigger
                data-testid="project-workspace.menu"
                aria-label={i18n.t("projects.projectActions")}
                class={`flex items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-text-secondary ${
                  phone() ? "h-11 w-11" : "h-7 w-7"
                }`}
              >
                <Ellipsis class="h-4 w-4" />
              </PopupMenu.Trigger>
              <PopupMenu.Content
                data-testid="project-workspace.menu-content"
                aria-label={i18n.t("projects.projectActions")}
                class="min-w-[200px]"
              >
                <Show when={phone()}>
                  <PopupMenu.Item
                    data-testid="project-workspace.menu-statuses"
                    disabled={isArchived()}
                    onSelect={() => setStatusManagerOpen(true)}
                  >
                    <Columns3 class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.statuses")}</span>
                  </PopupMenu.Item>
                  <PopupMenu.Item
                    data-testid="project-workspace.menu-fields"
                    disabled={isArchived()}
                    onSelect={() => setFieldsManagerOpen(true)}
                  >
                    <ListPlus class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.fields.manage")}</span>
                  </PopupMenu.Item>
                  <PopupMenu.Item
                    data-testid="project-workspace.menu-automations"
                    onSelect={openAutomations}
                  >
                    <Zap class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.automations.title")}</span>
                  </PopupMenu.Item>
                  <PopupMenu.Item
                    data-testid="project-workspace.menu-release"
                    onSelect={() => {
                      // Let the project menu finish closing (and hand focus
                      // back) before the release picker opens in its place.
                      setTimeout(() => setReleasePickerOpen(true), 0)
                    }}
                  >
                    <Tag class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.release.filter.menuLabel")}</span>
                  </PopupMenu.Item>
                  <Show when={!labelFilterHidden(tasks())}>
                    <PopupMenu.Item
                      data-testid="project-workspace.menu-labels"
                      onSelect={() => {
                        setTimeout(() => setLabelPickerOpen(true), 0)
                      }}
                    >
                      <Tag class="h-3.5 w-3.5" />
                      <span>{i18n.t("projects.labels.filter.menuLabel")}</span>
                    </PopupMenu.Item>
                  </Show>
                  <PopupMenu.Item data-testid="project-workspace.menu-trash" onSelect={openTrash}>
                    <Trash2 class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.trash")}</span>
                  </PopupMenu.Item>
                  <PopupMenu.Separator />
                </Show>
                <PopupMenu.Item
                  data-testid="project-workspace.menu-copy-link"
                  onSelect={() => void copyLink(entityRoute("projects:project", props.entityId))}
                >
                  <Link class="h-3.5 w-3.5" />
                  <span>{i18n.t("kernel.copyLink")}</span>
                </PopupMenu.Item>
                <PopupMenu.Item
                  data-testid="project-workspace.edit"
                  disabled={!project() || isArchived()}
                  onSelect={() => setEditing(true)}
                >
                  <Pencil class="h-3.5 w-3.5" />
                  <span>{i18n.t("projects.editProject")}</span>
                </PopupMenu.Item>
                <Show
                  when={isArchived()}
                  fallback={
                    <PopupMenu.Item
                      data-testid="project-workspace.archive"
                      disabled={!project() || archiveBusy()}
                      onSelect={() => setArchiveConfirmOpen(true)}
                    >
                      <Archive class="h-3.5 w-3.5" />
                      <span>{i18n.t("projects.archiveAction")}</span>
                    </PopupMenu.Item>
                  }
                >
                  <PopupMenu.Item
                    data-testid="project-workspace.restore"
                    disabled={archiveBusy()}
                    onSelect={() => void restore()}
                  >
                    <ArchiveRestore class="h-3.5 w-3.5" />
                    <span>{i18n.t("projects.restoreAction")}</span>
                  </PopupMenu.Item>
                </Show>
              </PopupMenu.Content>
            </PopupMenu>
          </div>
        </header>
        <Show when={isArchived()}>
          <div
            data-testid="project-workspace.archived-banner"
            class="flex items-center gap-3 border-y border-border-subtle bg-surface-hover px-6 py-2 text-[12px] text-text-secondary"
          >
            <span class="flex-1">{i18n.t("projects.thisProjectIsArchivedOpenThe")}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={archiveBusy()}
              onClick={() => void restore()}
            >
              <span data-testid="project-workspace.banner-restore">
                {i18n.t("projects.restoreAction")}
              </span>
            </Button>
          </div>
        </Show>
        {/* Panels other apps add to the project. */}
        <SlotPanels
          slot="project:detail:panel"
          entityId={props.entityId}
          class="flex shrink-0 flex-col gap-3 px-6 pb-3"
        />
        {/* Time and budgets: only a project using it shows the line and the panel. */}
        <Show when={timeActive() && !isArchived()}>
          <BudgetLine
            state={budgetFor(props.entityId)}
            panelOpen={panelShown()}
            onTogglePanel={() => setPanelOpen(!panelShown())}
            onRetry={reloadBudget}
          />
          <Show when={panelShown() && !wideRail()}>
            <BudgetPanel
              api={api}
              projectId={props.entityId}
              state={budgetFor(props.entityId)}
              rail={false}
              archived={isArchived()}
              onClose={() => setPanelOpen(false)}
              onPlanChanged={reloadBudget}
              onOff={timeTurnedOff}
            />
          </Show>
        </Show>
        <div class="relative flex min-h-0 flex-1 flex-col">
          <Show when={timeActive() && !isArchived() && panelShown() && wideRail()}>
            <BudgetPanel
              api={api}
              projectId={props.entityId}
              state={budgetFor(props.entityId)}
              rail={true}
              archived={isArchived()}
              onClose={() => setPanelOpen(false)}
              onPlanChanged={reloadBudget}
              onOff={timeTurnedOff}
            />
          </Show>
          <div class="flex-1 min-h-0 overflow-auto">
            <Show
              when={view() === "list"}
              fallback={
                <Show
                  when={!isPipeline() || !dealBoard.error}
                  fallback={
                    <div
                      data-testid="deal-board.error"
                      class="flex flex-col items-center gap-3 p-8 text-center text-[12.5px] text-text-secondary"
                    >
                      {i18n.t("projects.deals.boardFailed")}
                      <Button variant="outline" size="sm" onClick={() => void refetchDealBoard()}>
                        {i18n.t("kernel.common.retry2")}
                      </Button>
                    </div>
                  }
                >
                  <Show
                    when={!isPipeline() || board()}
                    fallback={
                      <div
                        data-testid="deal-board.loading"
                        class="flex gap-2 px-4 py-4"
                        aria-busy="true"
                      >
                        <For each={[0, 1, 2, 3]}>
                          {() => <div class="h-40 w-[240px] rounded-md bg-surface" />}
                        </For>
                      </div>
                    }
                  >
                    <ProjectKanbanView
                      statuses={statusesForKanban()}
                      tasks={tasksForKanban()}
                      workspaceWidth={workspaceWidth()}
                      projectId={props.entityId}
                      api={api}
                      disabled={isArchived()}
                      onTaskClick={openTask}
                      pipeline={
                        isPipeline() && board()
                          ? {
                              board: board()!,
                              memberName: (id) =>
                                (members.error ? null : members.latest?.get(id)) ?? null,
                              onChanged: async () => {
                                await refetchDealBoard()
                              },
                            }
                          : undefined
                      }
                    />
                  </Show>
                </Show>
              }
            >
              <BulkActionToolbar app="projects" viewId="project" />
              <ul data-testid="project-list-view" class="divide-y divide-border-subtle">
                <For each={orderedTasks()}>
                  {({ task: t, depth }) => {
                    const dndEnabled = () => !isArchived() && !projectsFilterStore.isActive
                    const isDragging = () => dndState.activeTaskId === t.id
                    const dropTarget = () => dndState.dropTarget
                    const isDropTarget = () => dropTarget()?.taskId === t.id
                    const dropPosition = () => (isDropTarget() ? dropTarget()!.position : null)
                    const dropInvalid = () =>
                      isDropTarget() && dropTarget()!.invalidReason !== undefined
                    return (
                      <li
                        data-testid="project-list-view.row"
                        data-task-id={t.id}
                        data-parent-task-id={t.parentTaskId ?? ""}
                        data-depth={depth}
                        data-drop-position={dropPosition()}
                        data-dragging={isDragging() ? "true" : undefined}
                        draggable={dndEnabled()}
                        onDragStart={(e) => {
                          if (!dndEnabled()) {
                            e.preventDefault()
                            return
                          }
                          e.dataTransfer?.setData("text/x-liaison-task", t.id)
                          e.dataTransfer!.effectAllowed = "move"
                          dndState.beginDrag(t.id)
                        }}
                        onDragEnd={() => dndState.clear()}
                        onDragOver={(e) => {
                          if (!dndEnabled() || !dndState.activeTaskId) return
                          const dragged = dndState.activeTaskId
                          e.preventDefault()
                          e.dataTransfer!.dropEffect = "move"
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const position = computeDropPosition(e, rect, e.shiftKey)
                          const validity = dropIsValid(dragged, t.id, position)
                          dndState.setDropTarget({
                            taskId: t.id,
                            position,
                            invalidReason: validity.ok ? undefined : validity.reason,
                          })
                        }}
                        onDragLeave={(e) => {
                          // Only clear if leaving to outside the row entirely.
                          const next = e.relatedTarget as Node | null
                          if (next && (e.currentTarget as HTMLElement).contains(next)) return
                          if (dndState.dropTarget?.taskId === t.id) {
                            dndState.setDropTarget(null)
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const dragged = dndState.activeTaskId
                          const target = dndState.dropTarget
                          dndState.clear()
                          if (!dragged || !target) return
                          if (target.invalidReason) return
                          void onTaskDrop(dragged, target.taskId, target.position)
                        }}
                        style={{ "padding-left": `${(depth - 1) * 20 + 20}px` }}
                        class={`group relative flex cursor-pointer items-center py-2 text-[13px] ${
                          phone() ? "gap-2 pr-4" : "gap-3 pr-6"
                        } ${isDragging() ? "opacity-40" : "hover:bg-surface-hover"}`}
                        classList={{
                          "bg-accent-tint ring-1 ring-inset ring-accent-border":
                            dropPosition() === "into" && !dropInvalid(),
                          "bg-warning-glow ring-1 ring-inset ring-warning-border":
                            dropPosition() === "into" && dropInvalid(),
                        }}
                        onClick={() => {
                          if (dndState.activeTaskId) return
                          openTask(t.id)
                        }}
                      >
                        {/* Tree-line guides — see `rowGuides` for the data model.
                        Three primitives, fully data-driven:
                        - L-corner (curved): own-boundary top-half + arm
                        - Straight top-half: ancestor pass-through
                        - Straight bottom-half: continuation or child-start
                        Connector lines flow continuously across rows because
                        each parent paints the lead-in bottom-half at its
                        children's boundary; each descendant picks up the same
                        line at top-half. Works for arbitrary nesting depth. */}
                        {(() => {
                          const guides = rowGuides().get(t.id)
                          if (!guides) return null
                          const allBoundaries = Array.from(
                            new Set([...guides.topHalf, ...guides.bottomHalf]),
                          ).sort((a, b) => a - b)
                          return (
                            <For each={allBoundaries}>
                              {(k) => {
                                const x = (k - 2) * 20 + 20
                                const isOwn = k === guides.ownDepth
                                const hasTop = guides.topHalf.has(k)
                                const hasBottom = guides.bottomHalf.has(k)
                                return (
                                  <>
                                    <Show when={isOwn && hasTop}>
                                      <span
                                        aria-hidden="true"
                                        data-testid="project-list-view.tree-line.l-corner"
                                        class="pointer-events-none absolute border-l border-b border-border transition-colors duration-150 group-hover:border-border-strong"
                                        style={{
                                          left: `${x}px`,
                                          top: 0,
                                          width: "10px",
                                          height: "calc(50% + 0.5px)",
                                          "border-bottom-left-radius": "6px",
                                        }}
                                      />
                                    </Show>
                                    <Show when={!isOwn && hasTop}>
                                      <span
                                        aria-hidden="true"
                                        data-testid="project-list-view.tree-line"
                                        class="pointer-events-none absolute top-0 w-px bg-border transition-colors duration-150 group-hover:bg-border-strong"
                                        style={{ left: `${x}px`, height: "50%" }}
                                      />
                                    </Show>
                                    <Show when={hasBottom}>
                                      <span
                                        aria-hidden="true"
                                        data-testid="project-list-view.tree-line"
                                        class="pointer-events-none absolute w-px bg-border transition-colors duration-150 group-hover:bg-border-strong"
                                        style={{ left: `${x}px`, top: "50%", bottom: 0 }}
                                      />
                                    </Show>
                                  </>
                                )
                              }}
                            </For>
                          )
                        })()}
                        {/* Top drop indicator (sibling-above) */}
                        <Show when={dropPosition() === "above"}>
                          <span
                            aria-hidden="true"
                            data-testid="project-list-view.drop-line-above"
                            class={
                              dropInvalid()
                                ? "absolute left-0 right-0 top-0 h-0.5 bg-warning"
                                : "absolute left-0 right-0 top-0 h-0.5 bg-accent"
                            }
                            style={{ "margin-left": `${(depth - 1) * 20 + 12}px` }}
                          />
                        </Show>
                        {/* Bottom drop indicator (sibling-below) */}
                        <Show when={dropPosition() === "below"}>
                          <span
                            aria-hidden="true"
                            data-testid="project-list-view.drop-line-below"
                            class={
                              dropInvalid()
                                ? "absolute left-0 right-0 bottom-0 h-0.5 bg-warning"
                                : "absolute left-0 right-0 bottom-0 h-0.5 bg-accent"
                            }
                            style={{ "margin-left": `${(depth - 1) * 20 + 12}px` }}
                          />
                        </Show>
                        {/* Drag handle — visual affordance only (the whole row is
                        draggable). Reveals on row hover; cursor flips to grab
                        on hover so the affordance reads. */}
                        <input
                          type="checkbox"
                          data-testid={`project-list-view.select-${t.id}`}
                          aria-label={i18n.t("projects.selectTask", { title: t.title })}
                          checked={isSelected(t.id)}
                          disabled={isArchived()}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelection(t.id)}
                          class="h-3.5 w-3.5 shrink-0 rounded border-border-subtle bg-surface text-accent opacity-0 transition-opacity group-hover:opacity-100 checked:opacity-100 focus:opacity-100 disabled:opacity-40"
                        />
                        <Show when={!phone()}>
                          <span
                            data-testid="project-list-view.drag-handle"
                            aria-hidden="true"
                            class="pointer-events-none flex h-5 w-4 shrink-0 items-center justify-center text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                          >
                            <GripVertical class="h-3.5 w-3.5" />
                          </span>
                        </Show>
                        <Show when={t.blocked}>
                          <span
                            aria-hidden="true"
                            title={i18n.t("projects.blocked")}
                            class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                          />
                        </Show>
                        <Show when={t.key}>
                          <span class="shrink-0 font-mono text-[11px] text-text-tertiary">
                            {t.key}
                          </span>
                        </Show>
                        <span
                          data-testid="project-list-view.task-title"
                          class="min-w-0 flex-1 truncate text-text"
                        >
                          {t.title}
                        </span>
                        <Show when={!phone() && involvementFor(t.id)}>
                          {(inv) => (
                            <span
                              data-testid={`project-list-view.involvement-${t.id}`}
                              class="max-w-[45%] shrink truncate text-[11px] text-text-tertiary"
                            >
                              {involvementLine(inv(), i18n.t, i18n.locale())}
                            </span>
                          )}
                        </Show>
                        <Show when={t.dueDate}>
                          <DueDateChip due={t.dueDate!} terminal={isTerminal(t.statusId)} />
                        </Show>
                        <Show when={!phone()}>
                          <span
                            data-testid="project-list-view.updated-at"
                            title={i18n.t("projects.lastEdited")}
                            class="font-mono text-[11px] tabular-nums text-text-tertiary"
                          >
                            {formatDay(t.updatedAt, i18n.locale(), {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                        </Show>
                        <Show when={project()}>
                          <span onClick={(e) => e.stopPropagation()}>
                            <StatusPillPopover
                              api={api}
                              projectId={props.entityId}
                              taskId={t.id}
                              current={project()?.statuses.find((s) => s.id === t.statusId) ?? null}
                              statuses={project()?.statuses ?? []}
                              disabled={isArchived()}
                            />
                          </span>
                        </Show>
                      </li>
                    )
                  }}
                </For>
                <Show when={!projectsFilterStore.isActive}>
                  <li class="flex items-center gap-3 px-6 py-2 text-[13px] text-text-tertiary">
                    <input
                      data-testid="project-list-view.inline-create"
                      value={inlineDraft()}
                      disabled={isArchived() || submittingDraft()}
                      onInput={(e) => setInlineDraft((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitInline()
                      }}
                      placeholder={i18n.t("projects.newTaskEnterToCreate")}
                      class="w-full bg-transparent text-text outline-none disabled:opacity-50"
                    />
                  </li>
                </Show>
                <Show when={projectsFilterStore.isActive && (matchingTaskIds()?.size ?? 0) === 0}>
                  <li
                    data-testid="project-list-view.no-matches"
                    class="flex flex-col items-center gap-2 px-6 py-10 text-center text-[12.5px] text-text-tertiary"
                  >
                    <span>{i18n.t("projects.noTasksMatchFilters")}</span>
                    <button
                      type="button"
                      data-testid="project-list-view.no-matches-clear"
                      onClick={() => projectsFilterStore.clearAll()}
                      class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary hover:text-text-secondary"
                    >
                      {i18n.t("projects.clearFilters")}
                    </button>
                  </li>
                </Show>
              </ul>
            </Show>
          </div>
        </div>
        <NewTaskDialog
          open={newTaskOpen()}
          onOpenChange={setNewTaskOpen}
          api={api}
          projectId={props.entityId}
          statuses={project()?.statuses ?? []}
          fields={project()?.fields ?? []}
        />
        <Dialog open={trashOpen()} onOpenChange={setTrashOpen}>
          <Dialog.Content class="max-w-lg">
            <Dialog.Title>{i18n.t("projects.trash")}</Dialog.Title>
            <p class="mt-1 text-[12px] text-text-tertiary">{i18n.t("projects.trashHint")}</p>
            <TaskTrashDialog projectId={props.entityId} refreshKey={trashKey()} />
          </Dialog.Content>
        </Dialog>
        <Dialog open={archiveConfirmOpen()} onOpenChange={setArchiveConfirmOpen}>
          <Dialog.Content class="max-w-md">
            <Dialog.Title>{i18n.t("projects.archiveProjectConfirmTitle")}</Dialog.Title>
            <Dialog.Description>
              {i18n.t("projects.archiveProjectConfirmBody", { name: project()?.name ?? "" })}
            </Dialog.Description>
            <div class="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={archiveBusy()}
                onClick={() => setArchiveConfirmOpen(false)}
              >
                <span data-testid="project-workspace.archive-cancel">
                  {i18n.t("kernel.common.cancel")}
                </span>
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={archiveBusy()}
                onClick={() => void confirmArchive()}
              >
                <span data-testid="project-workspace.archive-confirm">
                  {i18n.t("projects.archiveProject")}
                </span>
              </Button>
            </div>
          </Dialog.Content>
        </Dialog>
        <Dialog open={statusManagerOpen()} onOpenChange={setStatusManagerOpen}>
          <Dialog.Content class="max-w-lg">
            <Dialog.Title>{i18n.t("projects.manageStatuses")}</Dialog.Title>
            <div class="mt-4">
              <StatusManager
                api={api}
                projectId={props.entityId}
                statuses={project()?.statuses ?? []}
                archived={isArchived()}
              />
            </div>
          </Dialog.Content>
        </Dialog>
        <Dialog open={fieldsManagerOpen()} onOpenChange={setFieldsManagerOpen}>
          <Dialog.Content class="max-w-xl">
            <Dialog.Title>{i18n.t("projects.fields.managerTitle")}</Dialog.Title>
            <div class="mt-3">
              <FieldsManager
                api={api}
                projectId={props.entityId}
                fields={project()?.fields ?? []}
                archived={isArchived()}
              />
            </div>
          </Dialog.Content>
        </Dialog>
      </div>
    </Show>
  )

  function isTerminal(statusId: string): boolean {
    const proj = project()
    return !!proj?.statuses.find((s) => s.id === statusId)?.terminal
  }
}

const DueDateChip: Component<{ due: string; terminal: boolean }> = (props) => {
  const i18n = useI18n()
  const bucket = createMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return dueBucket(props.due, props.terminal, today)
  })
  return (
    <span
      title={i18n.t("projects.dueDateTitle", {
        date: formatDay(props.due, i18n.locale(), { dateStyle: "long" }),
      })}
      class={`font-mono text-[11px] tabular-nums ${dueChipColorClass(bucket())}`}
    >
      {formatDay(props.due, i18n.locale())}
    </span>
  )
}

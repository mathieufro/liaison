// SPDX-License-Identifier: FSL-1.1-ALv2
// projects:task — full-screen task detail tab.
//
// Two-pane layout per spec § 12.8: left content (1fr min-w-480), right thread
// (380px fixed). Editorial feel: every property is a clickable affordance,
// title and description are inline-editable, subtasks render as a compact
// child list. The thread is a first-class right rail, not a relegated panel.

import {
  ArrowUp,
  CalendarDays,
  Check,
  ChevronUp,
  CircleX,
  Eye,
  EyeOff,
  Flag,
  Link,
  OctagonAlert,
  Tag,
  Trash2,
  UserPlus,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { disambiguatedLabel, markAmbiguousNames } from "~/lib/name-collision"
import { formatDay, relativeTime } from "~/lib/relative-time"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { pastedFiles } from "~/modules/files/composer-attachments"
import { uploadFile } from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneeListStatus, AssigneeSearchField } from "~/modules/members/AssigneeSearch"
import { createAssignableMembers } from "~/modules/members/assignable-members"
import { Checklist } from "~/modules/projects/Checklist"
import { TaskLabelChips, taskLabelGroupIds } from "~/modules/projects/LabelChip"
import { LinkedDocuments } from "~/modules/projects/LinkedDocuments"
import { ensureLabelCatalog } from "~/modules/projects/label-catalog-store"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { fetchReleases } from "~/modules/projects/release-filter"
import { StatusPillPopover } from "~/modules/projects/StatusPillPopover"
import type { TaskLabel } from "~/modules/projects/task-labels"
import { useApi } from "~/modules/shell/ApiContext"
import { copyLink, entityRoute } from "~/modules/shell/entity-link"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { BacklinksPanel } from "~/modules/shell/references/BacklinksPanel"
import { awayLabel } from "~/modules/shell/route-line"
import { SlotPanels } from "~/modules/shell/SlotPanels"
import { closeTab, makeTabId, openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Avatar, type AvatarUser } from "~/ui/AvatarStack"
import { Combobox } from "~/ui/Combobox"
import { PopupMenu } from "~/ui/PopupMenu"

const TaskDiscussion = lazy(() => import("~/modules/projects/TaskDiscussion"))

interface TaskDetailProps {
  entityId: string
}

interface TaskWithProject {
  id: string
  number: number
  key?: string
  projectId: string
  title: string
  description: string | null
  statusId: string
  threadId: string
  parentTaskId: string | null
  assigneeId: string | null
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  priority: string
  dueDate: string | null
  startDate: string | null
  blocked: boolean
  release?: string | null
  /** Effective labels (own and inherited), as the server computed them. */
  labels?: TaskLabel[]
  createdBy: string
  /** The creator's name, resolved by the server. */
  createdByName?: string | null
  /** Set when an agent created the task: shown instead of the person. */
  createdByAgentLabel?: string | null
  createdAt: string
  updatedAt: string
  childCount: number
}

interface ThreadShape {
  id: string
  hiddenFromList?: boolean
}

/** Catalog keys, translated where the priority is drawn. */
const PRIORITY_LABEL: Record<string, string> = {
  low: "projects.priorityLevel.low",
  normal: "projects.priorityLevel.normal",
  high: "projects.priorityLevel.high",
  urgent: "projects.priorityLevel.urgent",
}

const PRIORITY_TONE: Record<string, string> = {
  low: "text-text-tertiary",
  normal: "text-text-secondary",
  high: "text-text",
  urgent: "text-warning",
}

/** The task is gone, or the reader may not see it: 404/403 or a `not_found` code. */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 404 || err.status === 403 || (err.code ?? "").includes("not_found")
}

export const TaskDetail: Component<TaskDetailProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  let taskController: AbortController | null = null
  let threadController: AbortController | null = null
  // The label chips need the org's label groups.
  onMount(() => void ensureLabelCatalog(api))
  onCleanup(() => {
    taskController?.abort()
    threadController?.abort()
  })

  const [notFound, setNotFound] = createSignal(false)
  const [task, { mutate, refetch }] = createResource(
    () => props.entityId,
    async (taskId) => {
      taskController?.abort()
      const ac = new AbortController()
      taskController = ac
      let result: TaskWithProject | null
      try {
        result = await api.post<TaskWithProject>(
          "/apps/tools/projects:get",
          { taskId },
          { signal: ac.signal },
        )
      } catch (err) {
        // A task that is gone, or that the reader may not see (a link, a
        // notification about a task since restricted), is "not found", as a
        // contact is; any other failure is the tab's error.
        if (isNotFound(err)) {
          setNotFound(true)
          return undefined
        }
        throw err
      }
      if (!result) {
        setNotFound(true)
        return undefined
      }
      setNotFound(false)
      if (result?.projectId) projectStore.noteTaskProject(result.id, result.projectId)
      if (result?.projectId && !projectStore.project(result.projectId)) {
        void projectStore.load(api, result.projectId)
      }
      return result
    },
  )

  // The displayed task follows the project store's row whenever the store
  // holds one at least as fresh as the fetched copy: a status change made
  // here, in another tab or by an agent lands in the store (POST/PATCH
  // response or WS event) and the pill and every field follow it.
  const liveTask = createMemo<TaskWithProject | undefined>(() => {
    const t = task()
    if (!t) return t
    const stored: (Task & Partial<Pick<TaskWithProject, "assignee" | "childCount">>) | null =
      projectStore.task(t.id)
    if (!stored || (stored.updatedAt && t.updatedAt && stored.updatedAt < t.updatedAt)) return t
    const assignee =
      stored.assignee !== undefined
        ? stored.assignee
        : stored.assigneeId === t.assigneeId
          ? t.assignee
          : null
    return {
      ...t,
      ...stored,
      key: stored.key ?? t.key,
      assignee,
      childCount: stored.childCount ?? t.childCount,
    }
  })

  const project = () => {
    const projectId = liveTask()?.projectId
    return projectId ? projectStore.project(projectId) : null
  }
  const projectTasks = () => {
    const projectId = liveTask()?.projectId
    return projectId ? projectStore.tasksFor(projectId) : []
  }
  const isArchived = () => !!project()?.archivedAt

  const currentStatus = () => {
    const t = liveTask()
    if (!t) return null
    return project()?.statuses.find((s) => s.id === t.statusId) ?? null
  }

  const subtasks = createMemo<Task[]>(() => {
    const t = liveTask()
    if (!t) return []
    return (
      projectTasks()
        .filter((x) => x.parentTaskId === t.id)
        // Positions are per status column, so two children in different statuses
        // can share one: creation order, then id, keeps the list stable.
        .sort(
          (a, b) =>
            a.position - b.position ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        )
    )
  })

  const parentTask = createMemo<Task | null>(() => {
    const t = liveTask()
    if (!t?.parentTaskId) return null
    return projectTasks().find((x) => x.id === t.parentTaskId) ?? null
  })

  const patch = async (input: Record<string, unknown>): Promise<void> => {
    const t = liveTask()
    if (!t || isArchived()) return
    try {
      const result = await api.patch<TaskWithProject>(
        `/projects/${t.projectId}/tasks/${t.id}`,
        input,
      )
      // Without a task in the answer, echo the input, minus `labels`: the
      // input is a map of ids, the stores hold the resolved entry array.
      const echo = result ?? withoutLabels(input)
      // Optimistically merge — the WS event will reconcile in projectStore.
      mutate({ ...t, ...echo } as TaskWithProject)
      // Echo into the project store too so open list/kanban views update
      // immediately instead of waiting on the outbox-driven WS event.
      projectStore.handleTaskEvent("updated", {
        id: t.id,
        projectId: t.projectId,
        ...(echo as Partial<Task>),
      })
      void refetch()
    } catch (err) {
      // Previously this swallowed every failure and refetched in silence: the
      // edited field snapped back to its old value with nothing said, which
      // reads to the user as "I can't edit this". Surface it instead.
      addToast({
        message: i18n.t("projects.taskUpdateFailed"),
        type: "error",
      })
      console.error("task update failed", err)
      void refetch()
    }
  }

  // A file pasted into the description is attached to the task, as the
  // Linked documents button would, and listed there.
  const [attachmentsVersion, setAttachmentsVersion] = createSignal(0)
  const attachPasted = async (files: File[]): Promise<void> => {
    const t = liveTask()
    if (!t || isArchived()) return
    try {
      for (const file of files) {
        await uploadFile(
          api,
          file,
          { app: "projects", entityType: "task", entityId: t.id },
          {
            disposition: file.type.startsWith("image/") ? "inline" : "attachment",
          },
        )
      }
    } catch {
      addToast({ message: i18n.t("projects.taskUpdateFailed"), type: "error" })
    } finally {
      setAttachmentsVersion((v) => v + 1)
    }
  }

  const [deleting, setDeleting] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)

  const remove = async (): Promise<void> => {
    const t = liveTask()
    if (!t || isArchived() || deleting()) return
    setDeleting(true)
    try {
      await api.delete(`/projects/${t.projectId}/tasks/${t.id}`)
      // Soft-delete archives the subtree, so drop the children too rather than
      // leaving the board showing rows the server no longer returns.
      projectStore.handleTaskEvent("deleted", { id: t.id, projectId: t.projectId })
      addToast({ message: i18n.t("projects.taskDeleted"), type: "info" })
      closeTab(makeTabId("projects:task", t.id))
    } catch (err) {
      addToast({ message: i18n.t("projects.taskDeleteFailed"), type: "error" })
      console.error("task delete failed", err)
    } finally {
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  // Thread "promotion" state. The task's auto-created thread is hidden from
  // the global thread list by default (server sets hidden_from_list=true).
  // Users can promote (show in sidebar) or demote (hide back) via PATCH
  // /threads/:id with hiddenFromList=true|false.
  const [thread, { mutate: mutateThread, refetch: refetchThread }] = createResource(
    () => liveTask()?.threadId ?? null,
    async (threadId) => {
      if (!threadId) return null
      threadController?.abort()
      const ac = new AbortController()
      threadController = ac
      // The thread only drives the promote-to-sidebar toggle. Never let a
      // failure here (e.g. a transient 404 before participant enrollment
      // settles) bubble to the tab ErrorBoundary and blank the whole task.
      try {
        return await api.get<ThreadShape>(`/threads/${threadId}`, { signal: ac.signal })
      } catch {
        return null
      }
    },
  )
  const promoted = (): boolean => thread()?.hiddenFromList === false
  const togglePromotion = async (): Promise<void> => {
    const t = thread()
    if (!t) return
    const next = !promoted()
    mutateThread({ ...t, hiddenFromList: !next })
    try {
      await api.patch(`/threads/${t.id}`, { hiddenFromList: !next })
    } finally {
      void refetchThread()
    }
  }

  return (
    // Content and discussion side by side only where both fit; narrower (the
    // phone, a laptop with the sidebar open) the discussion follows the content.
    <div
      data-testid="task-detail"
      data-task-id={props.entityId}
      class="@container flex h-full min-h-0 bg-bg"
    >
      <Show
        when={liveTask()}
        fallback={
          <Show
            when={notFound()}
            fallback={
              <div data-testid="task-detail.loading" class="p-8 text-[13px] text-text-tertiary">
                {i18n.t("kernel.common.loading2")}
              </div>
            }
          >
            <div
              data-testid="task-detail.not-found"
              class="flex flex-1 items-center justify-center p-8 text-sm text-text-secondary"
            >
              {i18n.t("projects.taskNotFound")}
            </div>
          </Show>
        }
      >
        {(t) => (
          <div
            data-testid="task-detail.layout"
            class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto @[860px]:grid-cols-[minmax(480px,1fr)_380px] @[860px]:overflow-hidden"
          >
            <div
              data-testid="task-detail.content-pane"
              class="min-w-0 @[860px]:min-w-[480px] @[860px]:overflow-y-auto [--dock-pad-base:0px] @[860px]:pb-dock-window-clearance"
            >
              <div class="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6 @[600px]:px-8 @[600px]:py-8">
                {/* Breadcrumb + parent back-link */}
                <div class="flex flex-col gap-1">
                  <Show when={parentTask()}>
                    {(parent) => (
                      <button
                        type="button"
                        data-testid="task-detail.parent-link"
                        class="flex w-fit items-center gap-1 text-[12px] text-text-tertiary transition-colors hover:text-text-secondary"
                        onClick={() => {
                          openTab({
                            type: "projects:task",
                            entityId: parent().id,
                            label: parent().title,
                            routePath: `/tasks/${parent().id}`,
                          })
                        }}
                      >
                        <ChevronUp class="h-3 w-3" />
                        <span class="truncate">{parent().title}</span>
                      </button>
                    )}
                  </Show>
                  <div
                    data-testid="task-detail.breadcrumb"
                    class="flex items-center gap-1.5 text-[12.5px] text-text-tertiary"
                  >
                    <span>{i18n.t("projects.projects")}</span>
                    <span class="text-text-tertiary/60">/</span>
                    <button
                      type="button"
                      data-testid="task-detail.breadcrumb-project"
                      class="transition-colors hover:text-text-secondary"
                      onClick={() => {
                        openTab({
                          type: "projects:project",
                          entityId: t().projectId,
                          label: project()?.name ?? i18n.t("projects.project"),
                        })
                      }}
                    >
                      {project()?.name ?? ""}
                    </button>
                  </div>
                </div>

                {/* Task key — copyable handle */}
                <Show when={t().key}>
                  <button
                    type="button"
                    data-testid="task-detail.key"
                    class="flex w-fit items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-text-tertiary hover:text-text-secondary"
                    title={i18n.t("projects.copyTaskKey")}
                    aria-label={i18n.t("projects.copyTaskKey")}
                    onClick={() => {
                      const key = t().key
                      if (!key) return
                      void navigator.clipboard?.writeText(key)
                      addToast({ message: i18n.t("projects.copiedKey", { key }), type: "info" })
                    }}
                  >
                    {t().key}
                  </button>
                </Show>

                {/* Author — who filed it (the agent when an agent did) and when. */}
                <Show when={t().createdByAgentLabel || t().createdByName}>
                  {(name) => (
                    <p
                      data-testid="task-detail.created-by"
                      data-agent={t().createdByAgentLabel ? "true" : undefined}
                      class="text-[12px] text-text-tertiary"
                    >
                      {i18n.t("projects.createdByLine", {
                        name: name(),
                        date: formatDay(t().createdAt, i18n.locale(), { dateStyle: "medium" }),
                      })}
                    </p>
                  )}
                </Show>

                {/* Delete — the UI had no task-delete affordance at all;
                    deleting was reachable only through the agent's gated tool. */}
                <button
                  type="button"
                  data-testid="task-detail.copy-link"
                  class="inline-flex w-fit items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary"
                  onClick={() => void copyLink(entityRoute("projects:task", t().id))}
                >
                  <Link size={13} aria-hidden="true" />
                  {i18n.t("kernel.copyLink")}
                </button>
                <div class="flex items-center gap-2">
                  <Show
                    when={confirmingDelete()}
                    fallback={
                      <button
                        type="button"
                        data-testid="task-detail.delete"
                        disabled={isArchived() || deleting()}
                        class="inline-flex w-fit items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-danger disabled:opacity-50"
                        onClick={() => setConfirmingDelete(true)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        {i18n.t("projects.deleteTask")}
                      </button>
                    }
                  >
                    <span class="text-[12.5px] text-text-secondary">
                      {t().childCount > 0
                        ? i18n.t("projects.deleteTaskConfirmSubtree")
                        : i18n.t("projects.deleteTaskConfirm")}
                    </span>
                    <button
                      type="button"
                      data-testid="task-detail.delete-confirm"
                      disabled={deleting()}
                      class="inline-flex items-center gap-1 rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[12.5px] text-danger transition-colors disabled:opacity-50"
                      onClick={() => void remove()}
                    >
                      {i18n.t("projects.delete")}
                    </button>
                    <button
                      type="button"
                      data-testid="task-detail.delete-cancel"
                      disabled={deleting()}
                      class="inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:text-text-secondary disabled:opacity-50"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      {i18n.t("projects.deleteTaskCancel")}
                    </button>
                  </Show>
                </div>

                {/* Title — inline-editable */}
                <EditableTitle
                  value={t().title}
                  onSave={(v) => patch({ title: v })}
                  disabled={isArchived()}
                />

                {/* Meta row: status / assignee / due / priority / blocked */}
                <div
                  data-testid="task-detail.meta-row"
                  class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px]"
                  classList={{ "border-b border-warning-border pb-3": t().blocked }}
                >
                  <Show when={project()}>
                    <span data-testid="task-detail.status">
                      <StatusPillPopover
                        api={api}
                        projectId={t().projectId}
                        taskId={t().id}
                        current={currentStatus()}
                        statuses={project()?.statuses ?? []}
                        disabled={isArchived()}
                        onChanged={(row) => {
                          const cur = task()
                          if (cur) mutate({ ...cur, ...row })
                        }}
                      />
                    </span>
                  </Show>
                  <MetaSeparator />
                  <AssigneeChip
                    api={api}
                    user={t().assignee}
                    onAssign={(userId) => patch({ assigneeId: userId })}
                    onAssignToMe={() => patch({ assigneeId: getMyUserId() })}
                    onUnassign={() => patch({ assigneeId: null })}
                    disabled={isArchived()}
                  />
                  <MetaSeparator />
                  <DueDateChip
                    value={t().dueDate}
                    onChange={(v) => patch({ dueDate: v })}
                    disabled={isArchived()}
                  />
                  <MetaSeparator />
                  <PriorityChip
                    value={t().priority}
                    onChange={(v) => patch({ priority: v })}
                    disabled={isArchived()}
                  />
                  <MetaSeparator />
                  <ReleaseChip
                    api={api}
                    value={t().release ?? null}
                    onChange={(v) => patch({ release: v })}
                    disabled={isArchived()}
                  />
                  <MetaSeparator />
                  {/* No label group and no label: no chip, so no separator either. */}
                  <Show when={taskLabelGroupIds(t().labels).length > 0}>
                    <TaskLabelChips
                      labels={t().labels}
                      disabled={isArchived()}
                      onChange={(groupId, valueId) => patch({ labels: { [groupId]: valueId } })}
                    />
                    <MetaSeparator />
                  </Show>
                  <BlockedChip
                    value={t().blocked}
                    onChange={(v) => patch({ blocked: v })}
                    disabled={isArchived()}
                  />
                  {/* Actions other apps add to the task. */}
                  <SlotPanels slot="project:task:actions" entityId={t().id} position="actions" />
                </div>

                {/* Description — inline editable */}
                <EditableDescription
                  value={t().description}
                  onSave={(v) => patch({ description: v })}
                  onPasteFiles={(files) => void attachPasted(files)}
                  disabled={isArchived()}
                  api={api}
                />

                {/* Linked documents — specs mentioned in the description
                    (Knowledge / Drive / files) + the task's own attachments,
                    each a collapsible preview. */}
                <LinkedDocuments
                  description={t().description}
                  taskId={t().id}
                  discussionThreadId={t().threadId}
                  attachmentsVersion={attachmentsVersion()}
                  api={api}
                  disabled={isArchived()}
                />

                {/* Checklist: items proven against the project's levels. */}
                <Checklist
                  api={api}
                  projectId={t().projectId}
                  taskId={t().id}
                  disabled={isArchived()}
                />

                {/* Subtasks — compact child list */}
                <Show when={subtasks().length > 0}>
                  <section data-testid="task-detail.subtasks" class="flex flex-col gap-2">
                    <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
                      {i18n.t("projects.subtasks")}{" "}
                      <span class="font-mono tabular-nums">{subtasks().length}</span>
                    </h3>
                    <ul class="divide-y divide-border-subtle border-y border-border-subtle">
                      <For each={subtasks()}>
                        {(child) => <SubtaskRow task={child} api={api} />}
                      </For>
                    </ul>
                  </section>
                </Show>

                {/* Tabs other apps add to the task, above its discussion. */}
                <SlotPanels slot="project:task:tabs" entityId={t().id} position="tabs" />

                {/* Provenance footer — sits just below the metadata blocks,
                    above the discussion timeline. */}
                <p data-testid="task-detail.provenance" class="text-[11px] text-text-tertiary">
                  {i18n.t("projects.created")} {formatRelativeTime(t().createdAt, i18n.locale())}{" "}
                  {i18n.t("projects.lastUpdated")}{" "}
                  {formatRelativeTime(t().updatedAt, i18n.locale())}
                </p>

                <BacklinksPanel app="projects" entityType="task" entityId={t().id} />
              </div>
            </div>

            <aside
              data-testid="task-detail.thread-pane"
              style={{ "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD }}
              class="border-t border-border-subtle bg-surface/30 px-4 pt-6 @[600px]:px-5 @[860px]:flex @[860px]:min-h-0 @[860px]:w-[380px] @[860px]:flex-col @[860px]:overflow-hidden @[860px]:border-t-0 @[860px]:border-l"
            >
              {/* The task's thread is a fixed right rail laid out as a chat: its
                  comments scroll above a composer pinned at the rail's bottom,
                  which keeps clear of the dock's bar lying over that corner
                  (--shell-dock-strip, Shell.tsx) with a little air. An open dock
                  window is not reserved: it covers the box until the person
                  collapses it, rather than lifting the box up the rail. The promote
                  toggle only controls global thread-list visibility. */}
              <Show when={t().threadId}>
                <section
                  data-testid="task-detail.discussion"
                  class="flex min-h-0 flex-col gap-3 @[860px]:flex-1"
                >
                  <div class="flex items-center justify-between gap-3">
                    <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
                      {i18n.t("projects.discussion")}
                    </h3>
                    <button
                      type="button"
                      data-testid="task-detail.promote-thread"
                      data-promoted={promoted() ? "true" : undefined}
                      onClick={() => void togglePromotion()}
                      class={
                        promoted()
                          ? "inline-flex items-center gap-1.5 rounded-sm border border-accent-border bg-accent-glow px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent-wash"
                          : "inline-flex items-center gap-1.5 rounded-sm border border-transparent px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary"
                      }
                      title={
                        promoted()
                          ? i18n.t("projects.thisThreadIsVisibleInYour")
                          : i18n.t("projects.addThisThreadToYourSidebar")
                      }
                    >
                      <Show when={promoted()} fallback={<EyeOff class="h-3 w-3" />}>
                        <Eye class="h-3 w-3" />
                      </Show>
                      {promoted()
                        ? i18n.t("projects.inThreadList")
                        : i18n.t("projects.addToThreadList")}
                    </button>
                  </div>
                  <div data-testid="task-detail.thread" class="flex min-h-0 flex-1 flex-col">
                    <TaskDiscussion threadId={t().threadId} />
                  </div>
                </section>
              </Show>
            </aside>
          </div>
        )}
      </Show>
    </div>
  )
}

function withoutLabels(input: Record<string, unknown>): Record<string, unknown> {
  const { labels: _labels, ...rest } = input
  return rest
}

const MetaSeparator: Component = () => (
  <span aria-hidden="true" class="text-text-tertiary/40">
    ·
  </span>
)

const EditableTitle: Component<{
  value: string
  onSave: (next: string) => void
  disabled: boolean
}> = (props) => {
  const [editing, setEditing] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  return (
    <Show
      when={editing()}
      fallback={
        <h1
          data-testid="task-detail.title"
          class={
            props.disabled
              ? "font-display text-[22px] font-medium leading-tight text-text"
              : "cursor-text font-display text-[22px] font-medium leading-tight text-text rounded-sm transition-colors hover:bg-surface-hover/40 -mx-1 px-1"
          }
          onClick={() => {
            if (props.disabled) return
            setEditing(true)
            queueMicrotask(() => inputRef?.focus())
          }}
        >
          {props.value}
        </h1>
      }
    >
      <input
        ref={inputRef}
        data-testid="task-detail.title-input"
        type="text"
        value={props.value}
        autofocus
        onBlur={(e) => {
          const next = e.currentTarget.value.trim()
          setEditing(false)
          if (next && next !== props.value) props.onSave(next)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur()
          if (e.key === "Escape") {
            ;(e.currentTarget as HTMLInputElement).value = props.value
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        class="-mx-1 w-full rounded-sm bg-surface px-1 font-display text-[22px] font-medium leading-tight text-text outline-none ring-1 ring-accent-border"
      />
    </Show>
  )
}

const EditableDescription: Component<{
  value: string | null
  onSave: (next: string) => void
  onPasteFiles: (files: File[]) => void
  disabled: boolean
  api: ApiClient
}> = (props) => {
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(props.value ?? "")
  let editor: RichEditorHandle | undefined
  // While the mic listens or the take is transcribed, a blur does not close
  // the field: the text has to land in it.
  const [dictating, setDictating] = createSignal(false)
  const dictation = useDictation({ target: () => editor, onActiveChange: setDictating })

  // Sync draft when the value changes from outside (initial load, WS update).
  // Guard against clobbering in-progress edits: only update when not actively editing.
  createEffect(
    on(
      () => props.value,
      (value) => {
        if (!editing()) setDraft(value ?? "")
      },
    ),
  )

  const commit = () => {
    if (!editing() || dictating()) return
    setEditing(false)
    // The editor hands back the stored text verbatim while nothing changed.
    if (draft() === (props.value ?? "")) return
    const next = draft().trim()
    if (next !== (props.value ?? "")) props.onSave(next)
  }

  return (
    <section data-testid="task-detail.description-section" class="flex flex-col gap-2">
      <div class="flex min-h-7 items-center justify-between gap-2">
        <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
          {i18n.t("projects.description")}
        </h3>
        <Show when={editing()}>
          {/* No Send here: the mic ends the helpers' row, and a take turns
              the row into the recorder. */}
          <span class="flex min-w-0 flex-1 items-center justify-end gap-0.5">
            <RecorderRow dictation={dictation}>
              <ComposerAssist target={() => editor} />
              <DictationMic dictation={dictation} />
            </RecorderRow>
          </span>
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={
          <div
            data-testid="task-detail.description"
            data-empty={!props.value ? "true" : undefined}
            class={
              props.disabled
                ? "text-[13.5px] leading-relaxed text-text-secondary"
                : "min-h-[2rem] cursor-text rounded-sm border-l border-transparent pl-3 text-[13.5px] leading-relaxed text-text-secondary transition-colors hover:border-border-subtle"
            }
            onClick={() => {
              if (!props.disabled) setEditing(true)
            }}
          >
            <Show
              when={props.value}
              fallback={
                <span class="text-text-tertiary italic">
                  {i18n.t("projects.addADescriptionMarkdownSupported")}
                </span>
              }
            >
              {/* Markdown + entity mentions, same renderer as thread messages. */}
              <MarkdownContent
                content={props.value}
                api={props.api}
                class="prose-thread"
                data-testid="task-detail.description-rendered"
              />
            </Show>
          </div>
        }
      >
        <RichEditor
          preset="full"
          autofocus
          ref={(handle) => {
            editor = handle
          }}
          value={draft()}
          onChange={setDraft}
          onBlur={commit}
          onSubmit={commit}
          onPaste={(e) => {
            const files = pastedFiles(e)
            if (files.length === 0) return
            e.preventDefault()
            props.onPasteFiles(files)
          }}
          onCancel={() => {
            setDraft(props.value ?? "")
            setEditing(false)
          }}
          placeholder={i18n.t("projects.addADescriptionMarkdownSupported")}
          data-testid="task-detail.description-input"
          class="rounded-sm border-l border-accent-border bg-(--editor-bg) px-3 py-2 [--editor-bg:color-mix(in_srgb,var(--color-surface)_60%,var(--color-bg))]"
          editorClass="min-h-[5.5rem]"
        />
      </Show>
    </section>
  )
}

/**
 * The task's assignee: any active teammate (searchable, read from the member
 * directory), me, or nobody. It used to offer only "Assign to me" and
 * "Unassign", so a task could not be handed to a colleague from here.
 */
const AssigneeChip: Component<{
  api: ApiClient
  user: { id: string; name: string; avatarUrl: string | null } | null
  onAssign: (userId: string) => void
  onAssignToMe: () => void
  onUnassign: () => void
  disabled: boolean
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const assignees = createAssignableMembers(props.api, open)
  const candidates = createMemo(() =>
    assignees.members().filter((m) => m.id !== getMyUserId() && m.id !== props.user?.id),
  )
  const ambiguous = createMemo(() => markAmbiguousNames(candidates(), (m) => m.name))
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) assignees.setQuery("")
  }
  return (
    <PopupMenu open={open()} onOpenChange={onOpenChange}>
      <PopupMenu.Trigger
        class="rounded-sm transition-colors disabled:opacity-50"
        aria-label={i18n.t("projects.assignee")}
      >
        <span
          data-testid="task-detail.assignee"
          class="inline-flex items-center gap-2 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-secondary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text"
        >
          <Show
            when={props.user}
            fallback={
              <>
                <UserPlus class="h-3.5 w-3.5 text-text-tertiary" />
                <span class="text-text-tertiary">{i18n.t("projects.unassigned")}</span>
              </>
            }
          >
            {(u) => (
              <>
                <Avatar user={u() as AvatarUser} size="sm" />
                <span>{u().name}</span>
              </>
            )}
          </Show>
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content aria-label={i18n.t("projects.assigneeActions")} class="w-64">
        <div class="px-1 pb-1">
          <AssigneeSearchField
            testIdPrefix="task-detail.assignee"
            value={assignees.query()}
            onInput={assignees.setQuery}
          />
        </div>
        <PopupMenu.Item
          onSelect={() => {
            props.onAssignToMe()
            onOpenChange(false)
          }}
        >
          <Check class="h-3.5 w-3.5" /> {i18n.t("projects.assignToMe")}
        </PopupMenu.Item>
        <div class="max-h-72 overflow-y-auto">
          <For each={ambiguous()}>
            {({ candidate: m, ambiguous: isAmbiguous }) => (
              <PopupMenu.Item
                textValue={m.name}
                onSelect={() => {
                  props.onAssign(m.id)
                  onOpenChange(false)
                }}
              >
                <span
                  class="inline-flex items-center gap-1.5"
                  data-testid="task-detail.assign-member"
                >
                  <Avatar user={{ id: m.id, name: m.name, avatarUrl: null }} size="sm" />
                  {disambiguatedLabel(m.name, m.email, isAmbiguous)}
                  <Show when={awayLabel(m.away, i18n.t, i18n.locale())}>
                    {(away) => (
                      <span
                        data-testid={`task-detail.assign-away-${m.id}`}
                        class="text-[11px] text-text-tertiary"
                      >
                        {away()}
                      </span>
                    )}
                  </Show>
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </div>
        <AssigneeListStatus
          testIdPrefix="task-detail.assignee"
          status={assignees.status()}
          shown={assignees.members().length}
          total={assignees.total()}
          onRetry={assignees.retry}
        />
        <Show when={props.user}>
          <PopupMenu.Item
            onSelect={() => {
              props.onUnassign()
              onOpenChange(false)
            }}
          >
            <CircleX class="h-3.5 w-3.5" /> {i18n.t("kernel.common.unassign")}
          </PopupMenu.Item>
        </Show>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

const DueDateChip: Component<{
  value: string | null
  onChange: (next: string | null) => void
  disabled: boolean
}> = (props) => {
  const i18n = useI18n()
  let inputRef: HTMLInputElement | undefined
  return (
    <span class="inline-flex items-center gap-1">
      <Show
        when={props.value}
        fallback={
          <button
            type="button"
            data-testid="task-detail.due-date-add"
            disabled={props.disabled}
            onClick={() => inputRef?.showPicker?.()}
            aria-label={i18n.t("projects.dueDate")}
            class="inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary disabled:opacity-50"
          >
            <CalendarDays class="h-3.5 w-3.5" />
            {i18n.t("projects.addDueDate")}
          </button>
        }
      >
        <button
          type="button"
          data-testid="task-detail.due-date"
          disabled={props.disabled}
          onClick={() => inputRef?.showPicker?.()}
          aria-label={`${i18n.t("projects.dueDate")}: ${props.value}`}
          class="inline-flex items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-0.5 font-mono text-[11.5px] tabular-nums text-text-secondary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text disabled:opacity-50"
        >
          <CalendarDays class="h-3.5 w-3.5 text-text-tertiary" />
          {props.value}
        </button>
      </Show>
      <input
        ref={inputRef}
        type="date"
        value={props.value ?? ""}
        onChange={(e) => {
          const v = (e.target as HTMLInputElement).value
          props.onChange(v.length > 0 ? v : null)
        }}
        class="absolute h-0 w-0 opacity-0"
      />
    </span>
  )
}

const PriorityChip: Component<{
  value: string
  onChange: (next: string) => void
  disabled: boolean
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger class="rounded-sm" aria-label={i18n.t("projects.priority")}>
        <span
          data-testid="task-detail.priority"
          class={`inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] transition-colors hover:border-border-subtle hover:bg-surface-hover/50 ${PRIORITY_TONE[props.value] ?? "text-text-tertiary"}`}
        >
          <Show when={props.value === "urgent"} fallback={<Flag class="h-3.5 w-3.5" />}>
            <ArrowUp class="h-3.5 w-3.5" />
          </Show>
          {i18n.t(PRIORITY_LABEL[props.value] ?? "projects.priorityLevel.normal")}
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content aria-label={i18n.t("projects.priority")}>
        <For each={["urgent", "high", "normal", "low"] as const}>
          {(p) => (
            <PopupMenu.Item
              onSelect={() => {
                props.onChange(p)
                setOpen(false)
              }}
            >
              <span class={PRIORITY_TONE[p]}>{i18n.t(PRIORITY_LABEL[p]!)}</span>
            </PopupMenu.Item>
          )}
        </For>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

const ReleaseChip: Component<{
  api: ApiClient
  value: string | null
  onChange: (next: string | null) => void
  disabled: boolean
}> = (props) => {
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  // Suggestions load when editing starts; a failed load leaves free text only.
  const [suggestions] = createResource(editing, async (on) => {
    if (!on) return []
    try {
      return (await fetchReleases(props.api)).map((r) => r.value)
    } catch {
      return []
    }
  })
  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          data-testid="task-detail.release"
          disabled={props.disabled}
          onClick={() => setEditing(true)}
          aria-label={i18n.t("projects.release.label")}
          title={
            props.value ? i18n.t("projects.release.title", { release: props.value }) : undefined
          }
          class={
            props.value
              ? "inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11.5px] text-text-secondary transition-colors hover:bg-surface-hover/50 hover:text-text disabled:opacity-50"
              : "inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary disabled:opacity-50"
          }
        >
          <Tag class="h-3.5 w-3.5" />
          {props.value ?? i18n.t("projects.release.add")}
        </button>
      }
    >
      <Combobox
        value={props.value ?? ""}
        suggestions={suggestions() ?? []}
        maxLength={40}
        autofocus
        placeholder={i18n.t("projects.release.placeholder")}
        aria-label={i18n.t("projects.release.label")}
        data-testid="task-detail.release-input"
        onCancel={() => setEditing(false)}
        onCommit={(v) => {
          setEditing(false)
          const next = v.trim()
          if (next !== (props.value ?? "")) props.onChange(next.length > 0 ? next : null)
        }}
      />
    </Show>
  )
}

const BlockedChip: Component<{
  value: boolean
  onChange: (next: boolean) => void
  disabled: boolean
}> = (props) => {
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-testid="task-detail.blocked-toggle"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.value)}
      class={
        props.value
          ? "inline-flex items-center gap-1 rounded-sm border border-warning-border bg-warning-glow px-1.5 py-0.5 text-[12.5px] text-warning transition-colors disabled:opacity-50"
          : "inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary disabled:opacity-50"
      }
    >
      <OctagonAlert class="h-3.5 w-3.5" />
      {props.value ? i18n.t("projects.blocked") : i18n.t("projects.notBlocked")}
    </button>
  )
}

const SubtaskRow: Component<{ task: Task; api: ApiClient }> = (props) => {
  const proj = () => projectStore.project(props.task.projectId)
  const status = () => proj()?.statuses.find((s) => s.id === props.task.statusId) ?? null
  return (
    <li
      data-testid={`task-detail.subtask-${props.task.id}`}
      class="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover/50"
      onClick={() => {
        openTab({
          type: "projects:task",
          entityId: props.task.id,
          label: props.task.title,
          routePath: `/tasks/${props.task.id}`,
        })
      }}
    >
      <Show when={props.task.blocked}>
        <span aria-hidden="true" class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
      </Show>
      <span class="flex-1 truncate text-[13px] text-text">{props.task.title}</span>
      <span onClick={(e) => e.stopPropagation()}>
        <StatusPillPopover
          api={props.api}
          projectId={props.task.projectId}
          taskId={props.task.id}
          current={status()}
          statuses={proj()?.statuses ?? []}
          disabled={!!proj()?.archivedAt}
        />
      </span>
    </li>
  )
}

function getMyUserId(): string | null {
  return userFromToken()?.userId ?? null
}

function formatRelativeTime(iso: string, locale: string): string {
  return relativeTime(iso, locale)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// A list block: the rows the app's list tool returns, in the declared columns.
// Edits are staged (S10): Add (when a create is declared) opens a small form of
// the declared fields and puts the new row in the list as "New"; Edit (when an
// update is declared) opens the same fields in the row, filled from it, and
// marks it "Edited"; Archive, once confirmed in place, marks a stored row for
// removal. Undo takes back a staged edit or removal. ONE dirty Save/Discard bar
// commits them through the declared ops (archives, then updates with
// `{ id, ...fields }`, then creates) or puts the stored rows back, and leaving the page with staged edits
// asks first (A9). On Save, a create result's `revealOnCreate` key (a generated
// secret) is shown ONCE, never kept, and a create that waits for approval shows
// that instead (§R1 P2-6); an op the server refuses stays staged with its
// message. Row actions are actions, not edits: they run their tool with the row
// id at once. Cells read as their column declares (`format`: relative time,
// option labels, a status badge with the real error).
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { formatBasisPoints, normaliseTimestamp } from "./cell-format"
import { DirtyBar } from "./DirtyBar"
import { FieldControl } from "./fields"
import { useAppPage } from "./page-context"
import { labelOf } from "./page-model"
import { callAppTool, rowsOf, valueAt } from "./settings-api"
import type { SettingsListBlock, SettingsListCreateField } from "./types"

const P = "kernel.settingsPage"

function cell(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (Array.isArray(v)) return v.map(cell).join(", ")
  if (typeof v === "boolean") return v ? "✓" : ""
  if (typeof v === "object") return ""
  return String(v)
}

type Column = SettingsListBlock["columns"][number]

/** A row the create form staged: its values, and the server's refusal once Save tried it. */
/** A stored row's staged update: the declared fields' values, and the server's refusal once Save tried it. */
interface StagedEdit {
  values: Record<string, unknown>
  error?: string
}

/** Two field values are the same edit (a list compares by content). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((a === undefined || a === null || a === "") && (b === undefined || b === null || b === ""))
    return true
  return JSON.stringify(a) === JSON.stringify(b)
}

interface StagedRow {
  key: string
  values: Record<string, unknown>
  error?: string
}

/** The tone of a status badge: an error stands out, the rest stay calm. */
function statusTone(v: string): string {
  if (v === "error" || v === "failed") return "border-warning-border bg-warning-glow text-text"
  return "border-border text-text-secondary"
}

export const ListBlock: Component<{
  app: string
  block: SettingsListBlock
  blockId: string
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const page = useAppPage()
  const [rows, { refetch }] = createResource(
    () => page?.reloadToken() ?? 0,
    async () => {
      const out = await callAppTool(api, props.app, props.block.ops.list, {})
      if (out.kind !== "ok") throw new Error(out.kind === "error" ? out.message : "pending")
      return rowsOf(out.data)
    },
  )
  const [creating, setCreating] = createSignal(false)
  const [draft, setDraft] = createSignal<Record<string, unknown>>({})
  const [pending, setPending] = createSignal(false)
  const [revealed, setRevealed] = createSignal<string[]>([])
  const [copied, setCopied] = createSignal<number | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  // The staged edits: rows to create, stored rows to update, stored rows to archive.
  const [added, setAdded] = createSignal<StagedRow[]>([])
  const [edited, setEdited] = createSignal<Record<string, StagedEdit>>({})
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editDraft, setEditDraft] = createSignal<Record<string, unknown>>({})
  const [archived, setArchived] = createSignal<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  let tempCounter = 0

  const changeCount = () => added().length + Object.keys(edited()).length + archived().size
  const draftTyped = () =>
    creating() && Object.values(draft()).some((v) => v !== undefined && v !== null && v !== "")
  createEffect(() => page?.setDirty(props.blockId, changeCount() > 0 || draftTyped()))

  function clearStaged(): void {
    setConfirming(null)
    setAdded([])
    setEdited({})
    setEditingId(null)
    setEditDraft({})
    setArchived(new Set<string>())
    setSaveError(null)
    setCreating(false)
    setDraft({})
  }
  // The page reloads (it came back on screen, or its edits were discarded on
  // leaving): the stored rows replace whatever was staged.
  createEffect(on(() => page?.reloadToken() ?? 0, clearStaged, { defer: true }))

  const columns = () =>
    props.block.columns.map((c) => ({ ...c, label: labelOf(i18n.t, c.labelKey, c.label) }))

  /** The label of an `enum` / `status` value: its declared option's, else the value. */
  const optionLabel = (col: Column, v: unknown): string => {
    const o = col.options?.find((opt) => opt.value === v)
    return o ? labelOf(i18n.t, o.labelKey, o.label) : cell(v)
  }

  /** One cell, read the way its column declares (M2: never a raw ISO time, slug or code). */
  const renderCell = (col: Column, row: Record<string, unknown>): JSX.Element => {
    const v = valueAt(row, col.key)
    switch (col.format) {
      case "datetime":
        return relativeTime(normaliseTimestamp(v), i18n.locale()) || i18n.t(`${P}.never`)
      case "basisPoints":
        return formatBasisPoints(v, i18n.locale())
      case "enum":
        return optionLabel(col, v)
      case "status": {
        if (v === null || v === undefined || v === "") return ""
        const err = col.errorKey ? valueAt(row, col.errorKey) : undefined
        const id = `${rowId(row)}-${col.key}`
        return (
          <>
            <span
              class={cn(
                "inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium",
                statusTone(String(v)),
              )}
              data-testid={`settings-list-status-${id}`}
              data-status={String(v)}
            >
              {optionLabel(col, v)}
            </span>
            <Show when={typeof err === "string" && err !== ""}>
              <span class="ml-1.5 text-text-secondary" data-testid={`settings-list-error-${id}`}>
                {String(err)}
              </span>
            </Show>
          </>
        )
      }
      default:
        return cell(v)
    }
  }
  /**
   * A secondary column with nothing to show (a keyword term has no platform)
   * is left out rather than read as "Platform:" and a blank. A datetime is
   * never empty: no value reads "Never".
   */
  const emptyCell = (col: Column, row: Record<string, unknown>): boolean => {
    if (col.format === "datetime") return false
    const v = valueAt(row, col.key)
    return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)
  }
  const archiveLabel = () =>
    props.block.archiveLabel
      ? labelOf(i18n.t, props.block.archiveLabelKey, props.block.archiveLabel)
      : i18n.t(`${P}.archive`)
  /** The confirm asks with the action's own name ("Revoke “CI key”?"), never a stock "Archive". */
  const archiveConfirmText = (r: Record<string, unknown>): string => {
    const name = rowName(r)
    if (!props.block.archiveLabel) {
      return name ? i18n.t(`${P}.archiveConfirm`, { name }) : i18n.t(`${P}.archiveConfirmUnnamed`)
    }
    const action = archiveLabel()
    return name
      ? i18n.t(`${P}.archiveConfirmAction`, { action, name })
      : i18n.t(`${P}.archiveConfirmActionUnnamed`, { action })
  }
  const rowId = (r: Record<string, unknown>) => String(r.id ?? "")
  // The row's name for the archive confirm: its first column, never its id.
  const rowName = (r: Record<string, unknown>) =>
    cell(valueAt(r, props.block.columns[0]?.key ?? "id"))

  function openCreate(): void {
    setDraft({})
    setPending(false)
    setCreating(true)
  }

  function closeCreate(): void {
    setCreating(false)
    setDraft({})
  }

  /** The create form's row joins the list as New; nothing is written until Save. */
  function stageCreate(): void {
    tempCounter += 1
    const values = draft()
    setAdded((a) => [...a, { key: `new-${tempCounter}`, values }])
    closeCreate()
  }

  function unstageCreate(key: string): void {
    setAdded((a) => a.filter((r) => r.key !== key))
  }

  /** The fields an edit sets: the declared create fields, when an update is declared. */
  const editFields = () => (props.block.ops.update ? (props.block.createFields ?? []) : [])

  function openEdit(row: Record<string, unknown>): void {
    const id = rowId(row)
    const staged = edited()[id]?.values
    const values: Record<string, unknown> = {}
    for (const f of editFields()) values[f.key] = staged ? staged[f.key] : valueAt(row, f.key)
    setEditDraft(values)
    setEditingId(id)
  }

  /** The row's edit is staged ("Edited"); a form back at the stored values stages nothing. */
  function stageEdit(row: Record<string, unknown>): void {
    const id = rowId(row)
    const values = editDraft()
    setEditingId(null)
    const same = editFields().every((f) => sameValue(values[f.key], valueAt(row, f.key)))
    if (same) unstageEdit(id)
    else setEdited((e) => ({ ...e, [id]: { values } }))
  }

  function unstageEdit(id: string): void {
    setEdited((e) => {
      if (!(id in e)) return e
      const next = { ...e }
      delete next[id]
      return next
    })
  }

  function toggleArchive(id: string, marked: boolean): void {
    // A row to remove is not also updated.
    if (marked) unstageEdit(id)
    setArchived((prev) => {
      const next = new Set(prev)
      if (marked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function discard(): void {
    clearStaged()
  }

  /** Commit the staged edits: archives, then updates, then creates, one op each, in order. */
  async function save(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    let failure: string | null = null
    let parked = false
    const secrets: string[] = []
    const archiveTool = props.block.ops.archive
    for (const id of archived()) {
      if (!archiveTool) break
      const out = await callAppTool(api, props.app, archiveTool, { id })
      if (out.kind === "error") {
        failure ??= out.message
        continue
      }
      if (out.kind === "pending") parked = true
      toggleArchive(id, false)
    }
    const updateTool = props.block.ops.update
    for (const [id, edit] of Object.entries(edited())) {
      if (!updateTool) break
      const out = await callAppTool(api, props.app, updateTool, { ...edit.values, id })
      if (out.kind === "error") {
        failure ??= out.message
        setEdited((e) => ({ ...e, [id]: { ...edit, error: out.message } }))
        continue
      }
      if (out.kind === "pending") parked = true
      unstageEdit(id)
    }
    const createTool = props.block.ops.create
    for (const row of added()) {
      if (!createTool) break
      const out = await callAppTool<Record<string, unknown>>(api, props.app, createTool, row.values)
      if (out.kind === "error") {
        failure ??= out.message
        setAdded((a) => a.map((r) => (r.key === row.key ? { ...r, error: out.message } : r)))
        continue
      }
      unstageCreate(row.key)
      if (out.kind === "pending") {
        parked = true
        continue
      }
      const key = props.block.revealOnCreate
      const secret = key && out.data ? valueAt(out.data, key) : undefined
      if (typeof secret === "string" && secret) secrets.push(secret)
    }
    setSaving(false)
    setPending(parked)
    setSaveError(failure)
    if (secrets.length > 0) {
      setCopied(null)
      setRevealed(secrets)
    } else if (!failure && !parked) {
      addToast({ message: i18n.t(`${P}.savedToast`), type: "success" })
    }
    void refetch()
  }

  async function rowAction(tool: string, id: string): Promise<void> {
    const out = await callAppTool(api, props.app, tool, { id })
    if (out.kind === "pending") {
      addToast({ message: i18n.t(`${P}.waitingApproval`), type: "info" })
    } else if (out.kind === "error") {
      addToast({ message: out.message, type: "error" })
    } else {
      addToast({ message: i18n.t(`${P}.actionDone`), type: "success" })
      void refetch()
    }
  }

  async function copy(text: string, index: number): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(index)
    } catch {
      setCopied(null)
    }
  }

  /** A row's cells: the first column as its name, the others labelled. */
  const renderCells = (row: Record<string, unknown>): JSX.Element => (
    <For each={columns()}>
      {(col, i) => (
        <Show when={i() === 0 || !emptyCell(col, row)}>
          <div
            class={
              i() === 0
                ? "truncate text-[13.5px] font-medium"
                : "truncate text-xs text-text-secondary"
            }
            data-testid={`settings-list-cell-${rowId(row)}-${col.key}`}
          >
            <Show when={i() > 0}>
              <span class="text-text-tertiary">{col.label}: </span>
            </Show>
            {renderCell(col, row)}
          </div>
        </Show>
      )}
    </For>
  )

  /** The row a staged create will make, as the list reads it. */
  const stagedRow = (r: StagedRow): Record<string, unknown> => ({ ...r.values, id: r.key })

  return (
    <div class="flex flex-col gap-3" data-testid={`settings-block-${props.blockId}`}>
      <Show when={revealed().length > 0}>
        <div
          class="flex flex-col gap-2 rounded-md border border-success-border bg-success-glow p-3"
          data-testid="settings-list-reveal"
        >
          <span class="text-[12.5px] font-medium">{i18n.t(`${P}.revealTitle`)}</span>
          <For each={revealed()}>
            {(secret, i) => (
              <div class="flex items-center gap-2">
                <code class="min-w-0 flex-1 break-all rounded-sm bg-bg px-2 py-1 font-mono text-xs">
                  {secret}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copy(secret, i())}>
                  {copied() === i() ? i18n.t(`${P}.copied`) : i18n.t(`${P}.copy`)}
                </Button>
              </div>
            )}
          </For>
          <div class="flex justify-end">
            <Button
              size="sm"
              data-testid="settings-list-reveal-done"
              onClick={() => {
                setRevealed([])
                setCopied(null)
              }}
            >
              {i18n.t(`${P}.done`)}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={props.block.title}>
        {(title) => (
          <h3 class="text-[13px] font-medium text-text" data-testid="settings-list-title">
            {labelOf(i18n.t, props.block.titleKey, title())}
          </h3>
        )}
      </Show>
      <Show when={pending()}>
        <div class="text-xs text-text-secondary" data-testid="settings-list-pending">
          {i18n.t(`${P}.waitingApproval`)}
        </div>
      </Show>
      <div class="rounded-lg border border-border bg-surface">
        <Show
          when={!rows.error}
          fallback={
            <div class="flex items-center gap-2 px-4 py-3 text-[13px] text-text-secondary">
              {i18n.t(`${P}.listFailed`)}
              <Button size="sm" variant="ghost" onClick={() => void refetch()}>
                {i18n.t(`${P}.retry`)}
              </Button>
            </div>
          }
        >
          <Show
            when={(rows() ?? []).length + added().length > 0}
            fallback={
              <Show when={!rows.loading}>
                <div
                  class="px-4 py-3 text-[13px] text-text-tertiary"
                  data-testid="settings-list-empty"
                >
                  {i18n.t(`${P}.empty`)}
                </div>
              </Show>
            }
          >
            <ul class="divide-y divide-border">
              <For each={rows()}>
                {(row) => {
                  const removing = () => archived().has(rowId(row))
                  const edit = () => edited()[rowId(row)]
                  return (
                    <li
                      class="flex min-h-11 flex-wrap items-center gap-3 px-3.5 py-2.5"
                      data-testid={`settings-list-row-${rowId(row)}`}
                      data-staged={removing() ? "archive" : edit() ? "update" : undefined}
                    >
                      <Show
                        when={editingId() === rowId(row)}
                        fallback={
                          <div
                            class={cn("min-w-0 flex-1", removing() && "line-through opacity-60")}
                          >
                            {renderCells(edit() ? { ...row, ...edit()?.values } : row)}
                            <Show when={edit()?.error}>
                              <div
                                class="text-xs text-error"
                                data-testid={`settings-list-row-error-${rowId(row)}`}
                              >
                                {edit()?.error}
                              </div>
                            </Show>
                          </div>
                        }
                      >
                        <div
                          class="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border bg-bg p-3"
                          data-testid={`settings-list-edit-form-${rowId(row)}`}
                        >
                          <For each={editFields()}>
                            {(f) => (
                              <div class="flex flex-col gap-1.5">
                                <span class="text-[12.5px] font-medium text-text-secondary">
                                  {labelOf(i18n.t, f.labelKey, f.label)}
                                </span>
                                <ListCreateInput
                                  app={props.app}
                                  field={f}
                                  testIdPrefix="settings-list-edit-field"
                                  value={editDraft()[f.key]}
                                  onValue={(v) => setEditDraft((d) => ({ ...d, [f.key]: v }))}
                                />
                              </div>
                            )}
                          </For>
                          <div class="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              {i18n.t(`${P}.cancel`)}
                            </Button>
                            <Button
                              size="sm"
                              data-testid={`settings-list-edit-apply-${rowId(row)}`}
                              onClick={() => stageEdit(row)}
                            >
                              {i18n.t(`${P}.done`)}
                            </Button>
                          </div>
                        </div>
                      </Show>
                      <Show when={edit() && !removing() && editingId() !== rowId(row)}>
                        <div class="flex items-center gap-2 text-xs">
                          <span
                            class="inline-flex items-center rounded border border-border px-1.5 py-px text-[11px] font-medium text-text-secondary"
                            data-testid={`settings-list-edited-${rowId(row)}`}
                          >
                            {i18n.t(`${P}.stagedEdited`)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`settings-list-edit-undo-${rowId(row)}`}
                            onClick={() => unstageEdit(rowId(row))}
                          >
                            {i18n.t(`${P}.undo`)}
                          </Button>
                        </div>
                      </Show>
                      <Show
                        when={!removing() && editingId() !== rowId(row)}
                        fallback={
                          <div class="flex items-center gap-2 text-xs">
                            <span
                              class="text-text-secondary"
                              data-testid={`settings-list-removing-${rowId(row)}`}
                            >
                              {i18n.t(`${P}.stagedRemoval`)}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              data-testid={`settings-list-undo-${rowId(row)}`}
                              onClick={() => toggleArchive(rowId(row), false)}
                            >
                              {i18n.t(`${P}.undo`)}
                            </Button>
                          </div>
                        }
                      >
                        <div class="flex items-center gap-1">
                          <Show when={editFields().length > 0}>
                            <Button
                              size="sm"
                              variant="ghost"
                              data-testid={`settings-list-edit-${rowId(row)}`}
                              onClick={() => openEdit(row)}
                            >
                              {i18n.t(`${P}.edit`)}
                            </Button>
                          </Show>
                          <For each={props.block.ops.rowAction ?? []}>
                            {(action, i) => (
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid={`settings-list-action-${i()}-${rowId(row)}`}
                                onClick={() => void rowAction(action.tool, rowId(row))}
                              >
                                {labelOf(i18n.t, action.labelKey, action.label)}
                              </Button>
                            )}
                          </For>
                          <Show when={props.block.ops.archive}>
                            <Show
                              when={confirming() === rowId(row)}
                              fallback={
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  class="text-error hover:text-error"
                                  data-testid={`settings-list-archive-${rowId(row)}`}
                                  onClick={() => setConfirming(rowId(row))}
                                >
                                  {archiveLabel()}
                                </Button>
                              }
                            >
                              <div
                                class="flex items-center gap-2 text-xs"
                                data-testid={`settings-list-confirm-${rowId(row)}`}
                              >
                                <span>{archiveConfirmText(row)}</span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setConfirming(null)}
                                >
                                  {i18n.t(`${P}.cancel`)}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  data-testid={`settings-list-archive-confirm-${rowId(row)}`}
                                  onClick={() => {
                                    setConfirming(null)
                                    toggleArchive(rowId(row), true)
                                  }}
                                >
                                  {archiveLabel()}
                                </Button>
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )
                }}
              </For>
              <For each={added()}>
                {(staged) => (
                  <li
                    class="flex min-h-11 flex-wrap items-center gap-3 px-3.5 py-2.5"
                    data-testid={`settings-list-row-${staged.key}`}
                    data-staged="create"
                  >
                    <div class="min-w-0 flex-1">
                      {renderCells(stagedRow(staged))}
                      <Show when={staged.error}>
                        <div
                          class="text-xs text-error"
                          data-testid={`settings-list-row-error-${staged.key}`}
                        >
                          {staged.error}
                        </div>
                      </Show>
                    </div>
                    <span
                      class="inline-flex items-center rounded border border-border px-1.5 py-px text-[11px] font-medium text-text-secondary"
                      data-testid={`settings-list-new-${staged.key}`}
                    >
                      {i18n.t(`${P}.stagedNew`)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`settings-list-unstage-${staged.key}`}
                      onClick={() => unstageCreate(staged.key)}
                    >
                      {i18n.t(`${P}.remove`)}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
      <Show when={props.block.ops.create}>
        <Show
          when={creating()}
          fallback={
            <div>
              <Button
                size="sm"
                variant="outline"
                data-testid="settings-list-add"
                onClick={openCreate}
              >
                {i18n.t(`${P}.add`)}
              </Button>
            </div>
          }
        >
          <div class="flex flex-col gap-3 rounded-lg border border-border bg-bg p-3">
            <For each={props.block.createFields ?? []}>
              {(f) => (
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12.5px] font-medium text-text-secondary">
                    {labelOf(i18n.t, f.labelKey, f.label)}
                  </span>
                  <ListCreateInput
                    app={props.app}
                    field={f}
                    value={draft()[f.key]}
                    onValue={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  />
                </div>
              )}
            </For>
            <div class="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={closeCreate}>
                {i18n.t(`${P}.cancel`)}
              </Button>
              <Button size="sm" data-testid="settings-list-create-submit" onClick={stageCreate}>
                {i18n.t(`${P}.add`)}
              </Button>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={saveError()}>
        <div class="text-xs text-error" data-testid="settings-list-error">
          {saveError()}
        </div>
      </Show>
      <Show when={changeCount() > 0}>
        <DirtyBar
          testId="settings-list"
          count={changeCount()}
          saving={saving()}
          onDiscard={discard}
          onSave={() => void save()}
        />
      </Show>
    </div>
  )
}

/** A create-form input: a plain typed control (no save of its own). */
const ListCreateInput: Component<{
  app: string
  field: SettingsListCreateField
  /** Test id prefix of a textual input (`<prefix>-<key>`); the create form's by default. */
  testIdPrefix?: string
  value: unknown
  onValue: (v: unknown) => void
}> = (props) => {
  const textual = () => ["text", "textarea", "url", "email", "number"].includes(props.field.type)
  return (
    <Show
      when={textual()}
      fallback={
        <FieldControl
          app={props.app}
          field={props.field}
          value={props.value}
          onCommit={props.onValue}
        />
      }
    >
      <input
        type={props.field.type === "number" ? "number" : "text"}
        class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none focus:border-accent-muted"
        autocomplete="off"
        data-testid={`${props.testIdPrefix ?? "settings-list-create"}-${props.field.key}`}
        value={props.value === undefined || props.value === null ? "" : String(props.value)}
        onInput={(e) => {
          const raw = e.currentTarget.value
          props.onValue(props.field.type === "number" && raw !== "" ? Number(raw) : raw)
        }}
      />
    </Show>
  )
}

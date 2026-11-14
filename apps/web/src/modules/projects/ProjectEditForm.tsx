// SPDX-License-Identifier: FSL-1.1-ALv2
// "Edit project", inline in the workspace header (no modal): name, key, icon,
// colour, description, client (a company the editor can read; cleared to
// none) and group (the sidebar heading it sits under; the
// org's existing groups are offered as suggestions). The key is read-only once the project has tasks
// (the server refuses it then: every task key and link is built on it).

import { type Component, createResource, createSignal, createUniqueId, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { COLOR_OPTIONS, ICON_OPTIONS } from "~/modules/projects/project-appearance"
import { type ProjectEditPatch, updateProjectFields } from "~/modules/projects/project-edit"
import { groupNames, MAX_PROJECT_GROUP_LENGTH } from "~/modules/projects/project-groups"
import type { ProjectDetail } from "~/modules/projects/project-store"
import { projectsStore } from "~/modules/projects/projects-store"
import { createTimePlanDraft, TimeBudgetsSwitch } from "~/modules/projects/TimeBudgetsSwitch"
import { forgetBudget } from "~/modules/projects/time-budgets"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

interface CompanyOption {
  id: string
  name: string
  domain?: string | null
}

type ClientApi = Partial<Pick<ApiClient, "get" | "getEnvelope">>

/** The client's name; null when the editor cannot see that company. */
async function clientName(api: ClientApi, id: string): Promise<string | null> {
  if (!api.get) return null
  try {
    const res = await api.get<CompanyOption | { data: CompanyOption }>(`/contacts/companies/${id}`)
    const company = res && "data" in (res as object) ? (res as { data: CompanyOption }).data : res
    return (company as CompanyOption | null)?.name ?? null
  } catch {
    return null
  }
}

/**
 * The project's client: the chosen company with Clear, or a search over the
 * companies the editor can read. Choosing or clearing is saved with the form.
 */
const ClientField: Component<{
  api: ClientApi
  value: string | null
  onChange: (id: string | null) => void
}> = (props) => {
  const i18n = useI18n()
  const [query, setQuery] = createSignal("")
  const [picked, setPicked] = createSignal<Record<string, string>>({})
  const [name] = createResource(
    () => (props.value && !picked()[props.value] ? props.value : false),
    (id) => clientName(props.api, id),
  )
  const [results] = createResource(
    () => query().trim() || false,
    async (q): Promise<CompanyOption[]> => {
      if (!props.api.getEnvelope) return []
      const params = new URLSearchParams({ query: q, limit: "8" })
      const res = await props.api.getEnvelope<CompanyOption[]>(
        `/contacts/companies?${params.toString()}`,
      )
      return Array.isArray(res?.data) ? res.data : []
    },
  )
  const shownName = () => {
    const id = props.value
    if (!id) return null
    return (
      picked()[id] ??
      name.latest ??
      (name.loading ? "" : i18n.t("projects.deals.clientUnavailable"))
    )
  }
  return (
    <div class="flex flex-col gap-1" data-testid="project-edit.client">
      <span class="text-[12px] font-medium text-text-secondary">
        {i18n.t("projects.deals.client")}
      </span>
      <Show
        when={props.value}
        fallback={
          <>
            <input
              data-testid="project-edit.client-search"
              type="text"
              autocomplete="off"
              placeholder={i18n.t("projects.deals.clientSearch")}
              aria-label={i18n.t("projects.deals.clientSearch")}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              class="rounded-sm border border-border bg-bg px-3 py-[7px] text-[13px] text-text outline-none transition-colors focus:border-accent-muted"
            />
            <Show when={query().trim() && !results.loading && !results.error}>
              <Show
                when={(results.latest ?? []).length > 0}
                fallback={
                  <span
                    data-testid="project-edit.client-no-match"
                    class="text-[11.5px] text-text-tertiary"
                  >
                    {i18n.t("projects.deals.clientNoMatch")}
                  </span>
                }
              >
                <ul class="flex flex-col rounded-sm border border-border-subtle">
                  <For each={results.latest ?? []}>
                    {(c) => (
                      <li>
                        <button
                          type="button"
                          data-testid={`project-edit.client-option-${c.id}`}
                          class="w-full px-3 py-1.5 text-left text-[13px] text-text hover:bg-surface-hover"
                          onClick={() => {
                            setPicked((m) => ({ ...m, [c.id]: c.name }))
                            setQuery("")
                            props.onChange(c.id)
                          }}
                        >
                          {c.name}
                          <Show when={c.domain}>
                            <span class="ml-2 text-[11.5px] text-text-tertiary">{c.domain}</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </>
        }
      >
        <div class="flex items-center gap-2">
          <span data-testid="project-edit.client-name" class="text-[13px] text-text">
            {shownName()}
          </span>
          <button
            type="button"
            data-testid="project-edit.client-clear"
            class="rounded-sm px-1.5 py-0.5 text-[12px] text-text-tertiary hover:bg-surface-hover hover:text-text"
            onClick={() => props.onChange(null)}
          >
            {i18n.t("projects.deals.clientClear")}
          </button>
        </div>
      </Show>
    </div>
  )
}

export const ProjectEditForm: Component<{
  api: ApiClient
  project: ProjectDetail
  onDone: () => void
}> = (props) => {
  const i18n = useI18n()
  const [name, setName] = createSignal(props.project.name)
  const [key, setKey] = createSignal(props.project.key ?? "")
  const [description, setDescription] = createSignal(props.project.description ?? "")
  const [icon, setIcon] = createSignal<string | null>(props.project.icon ?? null)
  const [color, setColor] = createSignal<string | null>(props.project.color ?? null)
  const [group, setGroup] = createSignal(props.project.group ?? "")
  const [client, setClient] = createSignal<string | null>(props.project.companyId ?? null)
  const groupListId = `project-edit-groups-${createUniqueId()}`
  const groupSuggestions = () =>
    groupNames([...projectsStore.items, ...projectsStore.archivedItems])
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const keyLocked = () => props.project.keyLocked === true
  // Time and budgets: a work project's own switch (never an organisation switch).
  const hasSwitch = () => props.project.kind !== "pipeline"
  const [timeOnNow, setTimeOnNow] = createSignal(props.project.timeBudgets === true)
  const plan = createTimePlanDraft(props.project, props.api)

  const save = async (): Promise<void> => {
    if (saving()) return
    const trimmed = name().trim()
    if (!trimmed) return
    const patch: ProjectEditPatch = {}
    if (trimmed !== props.project.name) patch.name = trimmed
    const nextKey = key().trim().toUpperCase()
    if (!keyLocked() && nextKey && nextKey !== (props.project.key ?? "")) {
      if (!KEY_RE.test(nextKey)) {
        setError(i18n.t("projects.projectKeyInvalid"))
        return
      }
      patch.key = nextKey
    }
    const nextDescription = description().trim() ? description() : null
    if (nextDescription !== (props.project.description ?? null)) {
      patch.description = nextDescription
    }
    if (icon() !== (props.project.icon ?? null)) patch.icon = icon()
    if (color() !== (props.project.color ?? null)) patch.color = color()
    const nextGroup = group().trim() || null
    if (nextGroup !== (props.project.group?.trim() || null)) {
      if (nextGroup && nextGroup.length > MAX_PROJECT_GROUP_LENGTH) {
        setError(i18n.t("projects.groupTooLong"))
        return
      }
      patch.group = nextGroup
    }
    if (client() !== (props.project.companyId ?? null)) patch.companyId = client()
    const flipped = hasSwitch() && timeOnNow() !== (props.project.timeBudgets === true)
    if (flipped) patch.timeBudgets = timeOnNow()
    const planning = hasSwitch() && timeOnNow() && props.project.timeBudgets === true
    if (Object.keys(patch).length === 0 && !planning) {
      props.onDone()
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (Object.keys(patch).length > 0) {
        await updateProjectFields(props.api, props.project.id, patch)
      }
      if (flipped) forgetBudget(props.project.id)
      if (planning) {
        const failed = await plan.apply(props.api, props.project.id)
        forgetBudget(props.project.id)
        if (failed) {
          setError(failed === "invalid-rate" ? i18n.t("projects.time.rateInvalid") : failed)
          return
        }
      }
      props.onDone()
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined
      setError(
        code === "project_key_taken"
          ? i18n.t("projects.projectKeyTaken")
          : code === "project_key_locked"
            ? i18n.t("projects.projectKeyLocked")
            : code === "invalid_project_key"
              ? i18n.t("projects.projectKeyInvalid")
              : code === "invalid_group"
                ? i18n.t("projects.groupTooLong")
                : i18n.t("projects.projectUpdateFailed"),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-testid="project-edit"
      class="flex w-full max-w-[560px] flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onDone()
      }}
    >
      <div class="flex items-end gap-2">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            data-testid="project-edit.name"
            label={i18n.t("projects.projectName")}
            value={name()}
            autofocus
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </div>
        <div
          class="flex w-28 shrink-0 flex-col gap-1"
          title={keyLocked() ? i18n.t("projects.projectKeyLocked") : undefined}
        >
          <Input
            data-testid="project-edit.key"
            label={i18n.t("projects.projectKey")}
            class="font-mono uppercase"
            value={key()}
            disabled={keyLocked()}
            maxLength={10}
            onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <Show when={keyLocked()}>
        <p data-testid="project-edit.key-locked" class="-mt-1 text-[11.5px] text-text-tertiary">
          {i18n.t("projects.projectKeyLocked")}
        </p>
      </Show>
      <label class="flex flex-col gap-1">
        <span class="text-[12px] font-medium text-text-secondary">
          {i18n.t("projects.descriptionOptional")}
        </span>
        <textarea
          data-testid="project-edit.description"
          rows={3}
          value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)}
          class="min-h-[4.5rem] rounded-sm border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none transition-colors focus:border-accent-muted"
        />
      </label>
      <ClientField api={props.api} value={client()} onChange={setClient} />
      <label class="flex flex-col gap-1">
        <span class="text-[12px] font-medium text-text-secondary">
          {i18n.t("projects.groupOptional")}
        </span>
        <input
          data-testid="project-edit.group"
          type="text"
          list={groupListId}
          autocomplete="off"
          maxLength={MAX_PROJECT_GROUP_LENGTH}
          value={group()}
          onInput={(e) => setGroup(e.currentTarget.value)}
          class="rounded-sm border border-border bg-bg px-3 py-[7px] text-[13px] text-text outline-none transition-colors focus:border-accent-muted"
        />
        <datalist id={groupListId} data-testid="project-edit.group-suggestions">
          <For each={groupSuggestions()}>{(name) => <option value={name} />}</For>
        </datalist>
        <span class="text-[11.5px] text-text-tertiary">{i18n.t("projects.groupHint")}</span>
      </label>
      <div class="flex flex-col gap-1.5">
        <span class="text-[12px] font-medium text-text-secondary">{i18n.t("projects.icon")}</span>
        <div class="flex flex-wrap gap-1.5" data-testid="project-edit.icons">
          <For each={ICON_OPTIONS}>
            {(option) => {
              const Icon = option.icon
              return (
                <button
                  type="button"
                  data-testid={`project-edit.icon-${option.name}`}
                  aria-pressed={icon() === option.name}
                  aria-label={option.name}
                  class={`flex h-7 w-7 items-center justify-center rounded-sm border transition-colors ${
                    icon() === option.name
                      ? "border-accent-border bg-accent-glow text-accent"
                      : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                  }`}
                  onClick={() => setIcon(option.name)}
                >
                  <Icon size={14} />
                </button>
              )
            }}
          </For>
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-[12px] font-medium text-text-secondary">{i18n.t("projects.color")}</span>
        <div class="flex flex-wrap gap-1.5" data-testid="project-edit.colors">
          <For each={COLOR_OPTIONS}>
            {(option, index) => (
              <button
                type="button"
                data-testid={`project-edit.color-${index()}`}
                aria-pressed={color() === option}
                aria-label={`${i18n.t("projects.color")} ${index() + 1}`}
                class={`h-6 w-6 rounded-full border transition-transform ${
                  color() === option
                    ? "scale-105 border-accent-border ring-2 ring-accent-glow"
                    : "border-border-subtle"
                }`}
                style={{ "background-color": option }}
                onClick={() => setColor(option)}
              />
            )}
          </For>
        </div>
      </div>
      <Show when={hasSwitch()}>
        <TimeBudgetsSwitch
          api={props.api}
          project={props.project}
          on={timeOnNow()}
          onChange={setTimeOnNow}
          plan={plan}
          idPrefix="project-edit"
        />
      </Show>
      <Show when={error()}>
        <p data-testid="project-edit.error" class="text-[12px] text-warning">
          {error()}
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={saving() || !name().trim()}>
          <span data-testid="project-edit.save">{i18n.t("projects.save")}</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => props.onDone()}>
          <span data-testid="project-edit.cancel">{i18n.t("kernel.common.cancel")}</span>
        </Button>
      </div>
    </form>
  )
}

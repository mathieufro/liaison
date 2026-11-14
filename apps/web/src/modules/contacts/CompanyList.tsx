// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Companies list (`/contacts/companies`): every company the reader sees,
// latest change first, searchable by name and domain. Each row says what the
// company is to us in one line: domain, the newest open deal (its amount only
// for a reader with deal access) and how many people. Calm: no colour for
// urgency, no score.

import { Plus, Search } from "lucide-solid"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { ContactAvatar } from "./ContactAvatar"
import {
  type Company,
  companyListStore,
  duplicateIds,
  listError,
  listLoaded,
  listLoading,
  listQuery,
  listTotal,
  loadCompanies,
  loadCompanyHints,
  proposalCount,
  setCompanyListQuery,
} from "./company-store"
import { companySummaryLine, openCompanyTab, openPeopleList } from "./company-visuals"

interface CompanyListProps {
  entityId: string
}

export const CompanyList: Component<CompanyListProps> = () => {
  const i18n = useI18n()
  const api = useApi()
  let debounce: ReturnType<typeof setTimeout> | undefined
  const [creating, setCreating] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [newDomain, setNewDomain] = createSignal("")
  const [createError, setCreateError] = createSignal<string | null>(null)
  const canWrite = () => hasScope("kernel:companies:write")

  onMount(() => {
    void loadCompanies(api as never)
    void loadCompanyHints(api as never)
  })
  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
  })

  function handleSearch(value: string): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      setCompanyListQuery(value)
      void loadCompanies(api as never)
    }, 300)
  }

  async function submitNew(): Promise<void> {
    const name = newName().trim()
    if (!name) return
    setCreateError(null)
    try {
      const created = await api.post<Company>("/contacts/companies", {
        name,
        ...(newDomain().trim() ? { domain: newDomain().trim() } : {}),
      })
      setNewName("")
      setNewDomain("")
      setCreating(false)
      void loadCompanies(api as never)
      if (created?.id) openCompanyTab(created.id, created.name)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    }
  }

  const ids = () => companyListStore.ids
  const empty = () => listLoaded() && !listLoading() && !listError() && ids().length === 0
  const searching = () => listQuery().trim().length > 0

  return (
    <div class="flex h-full flex-col" data-testid="company-list">
      <div class="border-b border-border-subtle px-4 pt-4 pb-3">
        <div class="flex items-center gap-3">
          <div
            class="inline-flex rounded-md border border-border-subtle bg-surface p-0.5 text-[12.5px]"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected="false"
              data-testid="company-list.mode-people"
              class="rounded px-2.5 py-1 text-text-tertiary hover:text-text"
              onClick={openPeopleList}
            >
              {i18n.t("contacts.companies.people")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="true"
              data-testid="company-list.mode-companies"
              class="rounded bg-surface-active px-2.5 py-1 text-text"
            >
              {i18n.t("contacts.companies.title")}
            </button>
          </div>
          <div class="ml-auto flex items-center gap-3">
            <Show when={listLoaded() && !listError() && ids().length > 0}>
              <span
                data-testid="company-list.count"
                class="font-mono text-[11px] tabular-nums text-text-tertiary"
              >
                {i18n.t("contacts.companies.countLine", { count: listTotal() })}
              </span>
            </Show>
            <Show when={canWrite()}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="company-list.new"
                onClick={() => setCreating((v) => !v)}
              >
                <Plus size={13} />
                {i18n.t("contacts.companies.newCompany")}
              </Button>
            </Show>
          </div>
        </div>
        <Show when={creating()}>
          <form
            data-testid="company-list.new-form"
            class="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submitNew()
            }}
          >
            <input
              data-testid="company-list.new-name"
              type="text"
              maxLength={200}
              aria-label={i18n.t("contacts.companies.newCompany")}
              placeholder={i18n.t("contacts.companies.newCompany")}
              class="min-w-48 flex-1 rounded-md border border-border-subtle bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-border"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
            />
            <input
              data-testid="company-list.new-domain"
              type="text"
              maxLength={300}
              aria-label={i18n.t("contacts.companies.newCompanyDomain")}
              placeholder="example.com"
              class="w-48 rounded-md border border-border-subtle bg-bg px-2.5 py-1.5 font-mono text-[12.5px] text-text outline-none focus:border-border"
              value={newDomain()}
              onInput={(e) => setNewDomain(e.currentTarget.value)}
            />
            <Button type="submit" size="sm" data-testid="company-list.new-save">
              {i18n.t("kernel.common.save")}
            </Button>
            <Show when={createError()}>
              {(msg) => (
                <p data-testid="company-list.new-error" class="w-full text-[12px] text-danger">
                  {msg()}
                </p>
              )}
            </Show>
          </form>
        </Show>
        <label class="mt-3 flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 transition-colors focus-within:border-border focus-within:bg-elevated">
          <Search size={14} class="shrink-0 text-text-tertiary" />
          <input
            data-testid="company-list.search"
            type="text"
            placeholder={i18n.t("contacts.companies.search")}
            class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
            value={listQuery()}
            onInput={(event) => handleSearch(event.currentTarget.value)}
          />
        </label>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show when={listLoading() && ids().length === 0}>
          <div data-testid="company-list.loading" class="space-y-1 px-4 py-3">
            <For each={[0, 1, 2, 3, 4, 5]}>
              {() => (
                <div class="flex items-center gap-3 py-2">
                  <Skeleton class="h-9 w-9 rounded-full" />
                  <div class="flex-1 space-y-1.5">
                    <Skeleton class="h-3 w-40" />
                    <Skeleton class="h-2.5 w-72" />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={listError()}>
          <div
            data-testid="company-list.error"
            class="flex flex-col items-center gap-3 px-4 py-12 text-[13px] text-text-secondary"
          >
            <span>{i18n.t("contacts.companies.loadError")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="company-list.retry"
              onClick={() => void loadCompanies(api as never)}
            >
              {i18n.t("contacts.companies.retry")}
            </Button>
          </div>
        </Show>

        <Show when={empty()}>
          <Show
            when={searching()}
            fallback={
              <div
                data-testid="company-list.empty"
                class="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-16 text-center"
              >
                <p class="text-[14px] text-text">{i18n.t("contacts.companies.emptyTitle")}</p>
                <p class="text-[12.5px] text-text-tertiary">
                  {i18n.t("contacts.companies.emptyHint")}
                </p>
                <Show when={proposalCount() > 0}>
                  <p
                    data-testid="company-list.empty-proposal"
                    class="mt-2 text-[12.5px] text-text-secondary"
                  >
                    {i18n.t("contacts.companies.emptyProposal", { count: proposalCount() })}
                  </p>
                </Show>
              </div>
            }
          >
            <p
              data-testid="company-list.no-match"
              class="px-4 py-12 text-center text-[13px] text-text-tertiary"
            >
              {i18n.t("contacts.companies.noMatch", { query: listQuery().trim() })}
            </p>
          </Show>
        </Show>

        <Show when={!listError() && ids().length > 0}>
          <ul data-testid="company-list.rows">
            <For each={ids()}>
              {(id) => {
                const company = () => companyListStore.byId[id]
                return (
                  <Show when={company()}>
                    {(c) => (
                      <li>
                        <button
                          type="button"
                          data-testid={`company-row-${id}`}
                          class="flex w-full items-start gap-3 border-b border-border-subtle px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                          onClick={() => openCompanyTab(id, c().name)}
                        >
                          <ContactAvatar id={id} name={c().name} size="md" />
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-2">
                              <span class="truncate text-[14px] text-text">{c().name}</span>
                              <Show when={duplicateIds().has(id)}>
                                <span
                                  data-testid={`company-row-${id}.duplicate`}
                                  class="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                                >
                                  {i18n.t("contacts.companies.possibleDuplicate")}
                                </span>
                              </Show>
                            </span>
                            <span
                              data-testid={`company-row-${id}.summary`}
                              class="mt-0.5 block truncate text-[12.5px] text-text-tertiary"
                            >
                              {companySummaryLine(c(), i18n)}
                            </span>
                          </span>
                          <span class="shrink-0 font-mono text-[11px] text-text-tertiary">
                            {c().updatedAt ? relativeTime(c().updatedAt, i18n.locale()) : ""}
                          </span>
                        </button>
                      </li>
                    )}
                  </Show>
                )
              }}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}

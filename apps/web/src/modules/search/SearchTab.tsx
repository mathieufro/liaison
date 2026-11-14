// SPDX-License-Identifier: FSL-1.1-ALv2

import { Search, X } from "lucide-solid"
import { type Component, createEffect, createMemo, For, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { appLabel, entityTypeLabel } from "~/lib/app-label"
import { entityIcon } from "~/lib/entity-icon"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  clearFilters,
  initFromUrlQuery,
  type SearchHit,
  searchStore,
  setOffset,
  setQuery,
  toggleAppFilter,
  toggleEntityTypeFilter,
} from "~/modules/search/search-store"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { shellTier } from "~/modules/shell/shell-tier"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { openSearchMessageHit } from "~/modules/threads/reply-panel-store"

interface SearchTabProps {
  entityId: string
}

// The entity glyph map moved to `~/lib/entity-icon` when the mention picker
// needed the same one. Re-exported here so this module's own consumers (and
// its phone test) keep their import path.
export { entityIcon }

function timeAgo(iso: unknown, locale: string): string {
  return typeof iso === "string" ? relativeTime(iso, locale) : ""
}

const SearchTab: Component<SearchTabProps> = () => {
  const i18n = useI18n()
  const api = useApi()
  const phone = () => shellTier() === "phone"
  const tabActive = useTabIsActive()
  let inputEl: HTMLInputElement | undefined

  // Opening Search puts the cursor in its box, so what the viewer types next is
  // the query: keys typed into a field never reach the shell's one-letter
  // shortcuts. The tab stays mounted while hidden, so this runs each time it is
  // shown again, not only on its first mount.
  createEffect(() => {
    if (!tabActive()) return
    queueMicrotask(() => inputEl?.focus())
  })

  // Honor /search?q=<initial query> when the tab is opened via URL.
  onMount(() => {
    if (typeof window !== "undefined" && !searchStore.query) {
      initFromUrlQuery(api, window.location.search)
    }
  })

  const hits = createMemo(() => searchStore.hits)
  const total = createMemo(() => searchStore.total)
  const appOptions = createMemo(() => {
    const apps = new Set<string>()
    for (const h of searchStore.hits) apps.add(h.app)
    return Array.from(apps).sort()
  })
  const entityTypeOptions = createMemo(() => {
    const types = new Set<string>()
    for (const h of searchStore.hits) types.add(h.entity_type)
    return Array.from(types).sort()
  })
  const selectedApps = createMemo(() => new Set(searchStore.filters.app ?? []))
  const selectedTypes = createMemo(() => new Set(searchStore.filters.entityType ?? []))
  const page = createMemo(() => ({
    offset: searchStore.offset,
    limit: searchStore.limit,
    hasNext: searchStore.offset + searchStore.hits.length < searchStore.total,
    hasPrev: searchStore.offset > 0,
  }))

  function handleInput(value: string): void {
    setQuery(value, api)
  }

  function onResultClick(hit: SearchHit): void {
    // A message hit opens its channel, with the reply panel when the message
    // lives in a reply thread (A17).
    if (openSearchMessageHit(hit)) return
    const entityId = (hit.entity_id ?? hit.id) as string
    const label =
      typeof hit.title === "string" && hit.title
        ? hit.title
        : typeof hit.body === "string"
          ? hit.body.slice(0, 80)
          : entityId
    void openEntity(api, hit.app, hit.entity_type, entityId, label)
  }

  return (
    <div
      data-testid="search-tab"
      class={
        phone()
          ? "flex h-full w-full flex-col px-4 pb-6 pt-3"
          : "mx-auto flex h-full w-full max-w-[720px] flex-col px-6 pb-6 pt-8"
      }
    >
      <Show when={phone()}>
        <h1
          data-testid="search-title"
          class="shrink-0 pb-2 font-display text-[32px] font-semibold leading-tight text-text"
        >
          {i18n.t("kernel.searchTitle")}
        </h1>
      </Show>
      {/* Sticky input */}
      <div
        class={
          phone()
            ? "sticky top-0 z-10 -mx-4 border-b border-border-subtle bg-bg px-4 pb-3"
            : "sticky top-0 z-10 -mx-6 border-b border-border-subtle bg-bg px-6 pb-3"
        }
      >
        <label class="flex items-center gap-2.5 rounded-sm border border-border bg-surface px-3 py-2">
          <Search size={16} class="shrink-0 text-text-tertiary" />
          <input
            ref={inputEl}
            data-testid="search-input"
            type="text"
            placeholder={i18n.t("kernel.searchEverything")}
            class="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-tertiary"
            value={searchStore.query}
            onInput={(e) => handleInput(e.currentTarget.value)}
          />
          <Show when={searchStore.query.length > 0}>
            <button
              type="button"
              data-testid="search-clear"
              class="text-text-tertiary hover:text-text-secondary"
              onClick={() => {
                handleInput("")
                clearFilters(api)
              }}
            >
              <X size={14} />
            </button>
          </Show>
        </label>
      </div>

      {/* Filter chips: app + entityType. Manifest dimension chips appear when
          the result set surfaces dimension-tagged hits. */}
      <Show
        when={
          searchStore.query.trim().length > 0 &&
          (appOptions().length > 0 || entityTypeOptions().length > 0)
        }
      >
        <div
          data-testid="search-filter-chips"
          class="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary"
        >
          <For each={appOptions()}>
            {(app) => (
              <button
                type="button"
                data-testid={`search-chip-app-${app}`}
                data-active={selectedApps().has(app) ? "true" : "false"}
                onClick={() => toggleAppFilter(app, api)}
                class={`rounded-full border px-2 py-0.5 ${
                  selectedApps().has(app)
                    ? "border-text-secondary bg-surface text-text"
                    : "border-border bg-bg text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {appLabel(app, i18n.t)}
              </button>
            )}
          </For>
          <For each={entityTypeOptions()}>
            {(type) => (
              <button
                type="button"
                data-testid={`search-chip-type-${type}`}
                data-active={selectedTypes().has(type) ? "true" : "false"}
                onClick={() => toggleEntityTypeFilter(type, api)}
                class={`rounded-full border px-2 py-0.5 ${
                  selectedTypes().has(type)
                    ? "border-text-secondary bg-surface text-text"
                    : "border-border bg-bg text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {entityTypeLabel(type, i18n.t)}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Results body */}
      <div class="mt-6 flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Show when={!searchStore.unavailable} fallback={<UnavailableState />}>
          <Show
            when={searchStore.query.trim().length > 0}
            fallback={
              <p data-testid="search-empty-hint" class="text-[13px] text-text-tertiary">
                {i18n.t("kernel.searchUi.emptyHint")}
              </p>
            }
          >
            <Show
              when={!searchStore.loading || hits().length > 0}
              fallback={
                <p data-testid="search-loading" class="text-[12px] text-text-tertiary">
                  {i18n.t("kernel.searchUi.searching")}
                </p>
              }
            >
              <Show
                when={hits().length > 0}
                fallback={
                  <p data-testid="search-zero-results" class="text-[13px] text-text-tertiary">
                    {i18n.t("kernel.searchUi.noResults", { query: searchStore.query })}
                  </p>
                }
              >
                <ul
                  data-testid="search-results"
                  class="divide-y divide-border-subtle border-y border-border-subtle"
                >
                  <For each={hits()}>
                    {(hit) => (
                      <li
                        data-testid={`search-result-${hit.app}-${hit.entity_type}-${hit.entity_id ?? hit.id}`}
                        class="cursor-pointer px-2 py-3 transition-colors hover:bg-surface-hover/50"
                        onClick={() => onResultClick(hit)}
                      >
                        <div class="flex items-baseline justify-between gap-3">
                          <span class="flex min-w-0 items-center gap-2">
                            <Dynamic
                              component={entityIcon(hit.entity_type)}
                              size={15}
                              class="shrink-0 text-text-tertiary"
                              data-testid={`search-result-icon-${hit.entity_type}`}
                            />
                            <span class="truncate text-[13.5px] font-medium text-text">
                              {(hit.title as string | undefined) ??
                                entityTypeLabel(hit.entity_type, i18n.t)}
                            </span>
                          </span>
                          <span class="shrink-0 text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
                            {appLabel(hit.app, i18n.t)} · {entityTypeLabel(hit.entity_type, i18n.t)}
                          </span>
                        </div>
                        <Show when={typeof hit.body === "string"}>
                          <p class="mt-0.5 truncate text-[12px] text-text-secondary">
                            {hit.body as string}
                          </p>
                        </Show>
                        <p class="mt-1 text-[11px] text-text-tertiary">
                          {timeAgo((hit as Record<string, unknown>).updated_at, i18n.locale())}
                        </p>
                      </li>
                    )}
                  </For>
                </ul>
                {/* Pagination */}
                <div class="mt-4 flex items-center justify-between text-[12px] text-text-tertiary">
                  <span data-testid="search-meta">
                    {i18n.t("kernel.searchUi.range", {
                      from: page().offset + 1,
                      to: page().offset + hits().length,
                      total: total(),
                    })}
                  </span>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="rounded-sm border border-border px-2 py-1 text-text-secondary disabled:opacity-40"
                      disabled={!page().hasPrev}
                      onClick={() => setOffset(Math.max(0, page().offset - page().limit), api)}
                    >
                      {i18n.t("kernel.searchUi.prev")}
                    </button>
                    <button
                      type="button"
                      data-testid="search-next-page"
                      class="rounded-sm border border-border px-2 py-1 text-text-secondary disabled:opacity-40"
                      disabled={!page().hasNext}
                      onClick={() => setOffset(page().offset + page().limit, api)}
                    >
                      {i18n.t("kernel.searchUi.next")}
                    </button>
                  </div>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

const UnavailableState: Component = () => {
  const i18n = useI18n()
  return (
    <div
      data-testid="search-unavailable"
      class="rounded-sm border border-border-subtle bg-surface px-4 py-5 text-[13px] text-text-secondary"
    >
      {i18n.t("kernel.searchUi.unavailable")}
    </div>
  )
}

export default SearchTab

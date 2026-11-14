// SPDX-License-Identifier: FSL-1.1-ALv2

import { Plus, Search, Users } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { resolveRegisteredTabType } from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { Skeleton } from "~/ui/Skeleton"
import { ContactAvatar } from "./ContactAvatar"
import {
  listLoaded as companiesLoaded,
  listLoading as companiesLoading,
  listTotal as companiesTotal,
  companyListStore,
  loadCompanies,
  setCompanyListQuery,
} from "./company-store"
import { openCompanyList, openCompanyTab } from "./company-visuals"
import {
  createGroup,
  groups,
  groupsLoaded,
  loadGroups,
  subscribeGroupsResync,
} from "./contact-groups-store"
import {
  contactListStore,
  groupFilter,
  loadContacts,
  loading,
  query,
  setGroupFilter,
  setQuery,
  total,
} from "./contact-list-store"
import { contactDisplayName } from "./contact-visuals"

// Sidebar surface for `contact-detail` tabs. Renders a compact, scrollable
// contact picker so the user can keep browsing related people without
// bouncing back to the list tab. Single search input + avatar + name rows.
export const ContactsSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  let debounceTimer: number | undefined

  onMount(() => {
    if (contactListStore.ids.length === 0) void loadContacts(api)
  })

  function handleSearch(value: string): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      setQuery(value)
      void loadContacts(api)
    }, 300)
  }

  function openContact(id: string): void {
    const contact = contactListStore.byId[id]
    openTab({ type: "contact-detail", entityId: id, label: contactDisplayName(contact) })
  }

  function openListTab(): void {
    openTab({ type: "contact-list", entityId: "list", label: "Contacts" })
  }

  // Highlight the currently open contact in the picker so the user always
  // knows where they are in the navigation.
  const activeContactId = createMemo(() => {
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    const contactDetailType =
      resolveRegisteredTabType("contact-detail") ?? "contacts:contact-detail"
    return tab?.type === contactDetailType ? tab.entityId : null
  })

  const isEmpty = () => contactListStore.ids.length === 0
  const trimmedQuery = createMemo(() => query().trim())

  return (
    <div class="flex h-full min-h-0 flex-col">
      {/* Header: title + count + "All contacts" link */}
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <div class="flex items-baseline gap-2">
          <h2 class="text-[12.5px] font-semibold text-text">{i18n.t("contacts.contacts")}</h2>
          <Show when={!loading() && !isEmpty()}>
            <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">{total()}</span>
          </Show>
        </div>
        <button
          type="button"
          class="rounded-sm px-1.5 py-0.5 text-[11px] text-text-tertiary hover:bg-surface-hover hover:text-text"
          onClick={openListTab}
          title={i18n.t("contacts.openTheFullContactList")}
        >
          {i18n.t("contacts.modeAll")}
        </button>
      </div>

      {/* Search */}
      <div class="px-3 pb-2">
        <label class="flex items-center gap-2 rounded-md border border-border-subtle bg-bg px-2 py-1 transition-colors focus-within:border-border focus-within:bg-elevated">
          <Search size={12} class="shrink-0 text-text-tertiary" />
          <input
            data-testid="contacts-sidebar-search"
            type="text"
            placeholder={i18n.t("contacts.search")}
            class="w-full bg-transparent text-[12px] text-text outline-none placeholder:text-text-tertiary"
            value={query()}
            onInput={(event) => handleSearch(event.currentTarget.value)}
          />
        </label>
      </div>

      <ContactsModeNav />
      <ContactGroupsSection />

      {/* List */}
      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show when={loading()}>
          <div class="space-y-1 px-2 py-1">
            <For each={[0, 1, 2, 3, 4, 5]}>
              {() => (
                <div class="flex items-center gap-2 px-1.5 py-1.5">
                  <Skeleton class="h-6 w-6 rounded-full" />
                  <Skeleton class="h-2.5 flex-1" />
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!loading()}>
          <Show
            when={!isEmpty()}
            fallback={
              <div class="px-3 py-8 text-center text-[11.5px] text-text-tertiary">
                <Show
                  when={trimmedQuery()}
                  fallback={
                    <span>
                      {groupFilter()
                        ? i18n.t("contacts.groups.emptyGroup")
                        : i18n.t("contacts.noContactsYet")}
                    </span>
                  }
                >
                  {i18n.t("contacts.noMatches")}
                </Show>
              </div>
            }
          >
            <ul class="px-1.5 pb-3">
              <For each={contactListStore.ids}>
                {(id) => {
                  const contact = () => contactListStore.byId[id]
                  const isActive = () => activeContactId() === id
                  return (
                    <Show when={contact()}>
                      <li>
                        <button
                          type="button"
                          data-testid={`contacts-sidebar-row-${id}`}
                          aria-current={isActive() ? "page" : undefined}
                          class={cn(
                            "group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors",
                            isActive()
                              ? "bg-surface-active text-text font-medium"
                              : "text-text-secondary hover:bg-surface-hover hover:text-text",
                          )}
                          onClick={() => openContact(id)}
                        >
                          <ContactAvatar
                            id={id}
                            name={contact().name}
                            email={contact().email}
                            size="sm"
                          />
                          <span
                            class="min-w-0 flex-1 truncate text-[12.5px]"
                            title={contactDisplayName(contact())}
                          >
                            {contactDisplayName(contact())}
                          </span>
                        </button>
                      </li>
                    </Show>
                  )
                }}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </div>
  )
}

/**
 * The Groups section (S15): the organisation's hand-picked contact groups; a click filters the
 * contact list to that group ("All contacts" lifts it) and a group can be created here. Shared
 * by the contact page's sidebar and the list page's, so both read and set the one list filter.
 */
export const ContactGroupsSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [creatingGroup, setCreatingGroup] = createSignal(false)
  const [newGroupName, setNewGroupName] = createSignal("")

  onMount(() => {
    subscribeGroupsResync()
    void loadGroups(api as never).catch(() => {})
  })

  function selectGroup(groupId: string | null): void {
    if (groupFilter() === groupId) return
    setGroupFilter(groupId)
    void loadContacts(api)
  }

  async function submitNewGroup(): Promise<void> {
    const name = newGroupName().trim()
    if (!name) return
    try {
      const group = await createGroup(api as never, name)
      setNewGroupName("")
      setCreatingGroup(false)
      selectGroup(group.id)
    } catch {
      // The name is kept so the user can change it (a duplicate name is refused).
    }
  }

  return (
    <section class="px-1.5 pb-2" data-testid="contacts-sidebar-groups">
      <div class="flex items-center justify-between px-1.5 pb-1">
        <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
          {i18n.t("contacts.groups.title")}
        </h3>
        <button
          type="button"
          data-testid="contacts-sidebar-new-group"
          class="rounded-sm p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text"
          aria-label={i18n.t("contacts.groups.newGroup")}
          title={i18n.t("contacts.groups.newGroup")}
          onClick={() => setCreatingGroup((v) => !v)}
        >
          <Plus size={12} />
        </button>
      </div>
      <Show when={creatingGroup()}>
        <form
          class="px-1.5 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            void submitNewGroup()
          }}
        >
          <input
            data-testid="contacts-sidebar-new-group-name"
            type="text"
            maxLength={80}
            placeholder={i18n.t("contacts.groups.groupName")}
            aria-label={i18n.t("contacts.groups.groupName")}
            class="w-full rounded-md border border-border-subtle bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-border"
            value={newGroupName()}
            onInput={(event) => setNewGroupName(event.currentTarget.value)}
          />
        </form>
      </Show>
      <ul>
        <li>
          <button
            type="button"
            data-testid="contacts-sidebar-group-all"
            aria-current={groupFilter() === null ? "true" : undefined}
            class={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors",
              groupFilter() === null
                ? "bg-surface-active font-medium text-text"
                : "text-text-secondary hover:bg-surface-hover hover:text-text",
            )}
            onClick={() => selectGroup(null)}
          >
            <span class="min-w-0 flex-1 truncate">{i18n.t("contacts.groups.allContacts")}</span>
          </button>
        </li>
        <For each={groups()}>
          {(group) => {
            const active = () => groupFilter() === group.id
            return (
              <li>
                <button
                  type="button"
                  data-testid={`contacts-sidebar-group-${group.id}`}
                  aria-current={active() ? "true" : undefined}
                  class={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors",
                    active()
                      ? "bg-surface-active font-medium text-text"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text",
                  )}
                  onClick={() => selectGroup(group.id)}
                >
                  <Users size={12} class="shrink-0 text-text-tertiary" />
                  <span class="min-w-0 flex-1 truncate" title={group.name}>
                    {group.name}
                  </span>
                  <span
                    class="font-mono text-[10.5px] tabular-nums text-text-tertiary"
                    title={i18n.t("contacts.groups.memberCount", { count: group.memberCount })}
                  >
                    {group.memberCount}
                  </span>
                </button>
              </li>
            )
          }}
        </For>
      </ul>
      <Show when={groupsLoaded() && groups().length === 0 && !creatingGroup()}>
        <p class="px-1.5 py-1 text-[11.5px] text-text-tertiary">
          {i18n.t("contacts.groups.noGroupsYet")}
        </p>
      </Show>
    </section>
  )
}

/**
 * Sidebar surface for the `contact-list` tab (the Contacts nav entry). The list itself is the
 * page, so this carries only the title and the Groups section, the same one a contact's page
 * shows: selecting a group filters the list beside it.
 */
export const ContactListSidebar: Component = () => {
  const i18n = useI18n()
  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="contact-list-sidebar">
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="text-[12.5px] font-semibold text-text">{i18n.t("contacts.contacts")}</h2>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <ContactsModeNav />
        <ContactGroupsSection />
      </div>
    </div>
  )
}

/**
 * People or companies: the two directories of Contacts, side by side in every
 * contacts sidebar. The one whose page is open is marked.
 */
export const ContactsModeNav: Component = () => {
  const i18n = useI18n()
  const activeType = createMemo(
    () => tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type,
  )
  const onCompanies = () => {
    const type = activeType()
    return (
      type === (resolveRegisteredTabType("company-list") ?? "contacts:company-list") ||
      type === (resolveRegisteredTabType("company-detail") ?? "contacts:company-detail")
    )
  }
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors",
      active
        ? "bg-surface-active font-medium text-text"
        : "text-text-secondary hover:bg-surface-hover hover:text-text",
    )
  return (
    <nav class="px-1.5 pb-2" data-testid="contacts-sidebar-modes">
      <button
        type="button"
        data-testid="contacts-sidebar-mode-people"
        aria-current={onCompanies() ? undefined : "page"}
        class={row(!onCompanies())}
        onClick={() => openTab({ type: "contact-list", entityId: "list", label: "Contacts" })}
      >
        <span class="min-w-0 flex-1 truncate">{i18n.t("contacts.companies.people")}</span>
      </button>
      <button
        type="button"
        data-testid="contacts-sidebar-mode-companies"
        aria-current={onCompanies() ? "page" : undefined}
        class={row(onCompanies())}
        onClick={openCompanyList}
      >
        <span class="min-w-0 flex-1 truncate">{i18n.t("contacts.companies.title")}</span>
        <Show when={companiesLoaded()}>
          <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">
            {companiesTotal()}
          </span>
        </Show>
      </button>
    </nav>
  )
}

/**
 * Sidebar of a company page: the two directories, a company search and the
 * companies, so the reader moves from one company to the next in place.
 */
export const CompaniesSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  let debounceTimer: number | undefined

  onMount(() => {
    if (companyListStore.ids.length === 0) void loadCompanies(api as never)
  })

  const activeCompanyId = createMemo(() => {
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    const type = resolveRegisteredTabType("company-detail") ?? "contacts:company-detail"
    return tab?.type === type ? tab.entityId : null
  })

  function handleSearch(value: string): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      setCompanyListQuery(value)
      void loadCompanies(api as never)
    }, 300)
  }

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="companies-sidebar">
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="text-[12.5px] font-semibold text-text">{i18n.t("contacts.contacts")}</h2>
      </div>
      <div class="px-3 pb-2">
        <label class="flex items-center gap-2 rounded-md border border-border-subtle bg-bg px-2 py-1 transition-colors focus-within:border-border focus-within:bg-elevated">
          <Search size={12} class="shrink-0 text-text-tertiary" />
          <input
            data-testid="companies-sidebar-search"
            type="text"
            placeholder={i18n.t("contacts.companies.search")}
            class="w-full bg-transparent text-[12px] text-text outline-none placeholder:text-text-tertiary"
            onInput={(event) => handleSearch(event.currentTarget.value)}
          />
        </label>
      </div>
      <ContactsModeNav />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show when={companiesLoading() && companyListStore.ids.length === 0}>
          <div class="space-y-1 px-2 py-1">
            <For each={[0, 1, 2, 3]}>
              {() => (
                <div class="flex items-center gap-2 px-1.5 py-1.5">
                  <Skeleton class="h-6 w-6 rounded-full" />
                  <Skeleton class="h-2.5 flex-1" />
                </div>
              )}
            </For>
          </div>
        </Show>
        <ul class="px-1.5 pb-3">
          <For each={companyListStore.ids}>
            {(id) => {
              const company = () => companyListStore.byId[id]
              const isActive = () => activeCompanyId() === id
              return (
                <Show when={company()}>
                  {(c) => (
                    <li>
                      <button
                        type="button"
                        data-testid={`companies-sidebar-row-${id}`}
                        aria-current={isActive() ? "page" : undefined}
                        class={cn(
                          "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors",
                          isActive()
                            ? "bg-surface-active font-medium text-text"
                            : "text-text-secondary hover:bg-surface-hover hover:text-text",
                        )}
                        onClick={() => openCompanyTab(id, c().name)}
                      >
                        <ContactAvatar id={id} name={c().name} size="sm" />
                        <span class="min-w-0 flex-1 truncate text-[12.5px]" title={c().name}>
                          {c().name}
                        </span>
                      </button>
                    </li>
                  )}
                </Show>
              )
            }}
          </For>
        </ul>
      </div>
    </div>
  )
}

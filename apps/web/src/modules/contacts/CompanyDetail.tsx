// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company's page (`/contacts/companies/:id`). In order: the header with its
// action row at the top, Waiting (only when something waits), People, Deals,
// then the sections other apps contribute (Money, Support, Work), the
// Timeline, and the company's discussion in the right rail. Every section is
// read from its own app as the reader: one that fails costs only itself. On a
// phone the page is three tabs (Overview, Timeline, Discussion) with an ask box
// at the bottom that leads into the discussion.

import {
  ArrowUp,
  GitMerge,
  Lock,
  MoreHorizontal,
  Share2,
  Trash2,
  UserPlus,
  Users,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js"
import { awayDay } from "~/lib/away-dates"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { attentionStore } from "~/modules/shell/attention-store"
import { createSlotPanels, type SlotEntry, SlotEntryView } from "~/modules/shell/SlotPanels"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { ActivityPanel } from "./ActivityPanel"
import { CompanyManagerPicker } from "./CompanyManagerPicker"
import { CompanyShareDialog } from "./CompanyShareDialog"
import { ContactAvatar } from "./ContactAvatar"
import {
  type Company,
  type CompanyDuplicate,
  companyStore,
  linkCompanyPeople,
  loadCompany,
  loadCompanyDuplicates,
  loadCompanyPeople,
  loadCompanyWaiting,
  markCompaniesNotSame,
  mergeCompanyInto,
  openCompanyDiscussion,
  setCompanyManager,
} from "./company-store"
import { dealText, openCompanyList, openCompanyTab } from "./company-visuals"

const EntityDiscussion = lazy(() => import("~/modules/threads/EntityDiscussion"))

/** People shown before "Show all". */
export const PEOPLE_SHOWN = 8

/** How long "Merge into" waits, with Undo, before it merges. */
export const MERGE_HOLD_MS = 8000

/** Contributed sections: money, support, work, then any other group. */
const SECTION_ORDER = ["money", "support", "work"]

interface CompanyDetailProps {
  entityId: string
}

interface PersonHit {
  id: string
  name: string | null
  email: string | null
  companyId?: string | null
}

export const CompanyDetail: Component<CompanyDetailProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const phone = () => shellTier() === "phone"
  const company = () => companyStore.companies[props.entityId]
  const loaded = () => props.entityId in companyStore.companies
  const people = () => companyStore.people[props.entityId] ?? []
  const manager = () => companyStore.managers[props.entityId] ?? null
  const me = () => userFromToken()?.userId ?? null

  const [peopleFailed, setPeopleFailed] = createSignal(false)
  const [peopleLoaded, setPeopleLoaded] = createSignal(false)
  const [showAllPeople, setShowAllPeople] = createSignal(false)
  const [overflowOpen, setOverflowOpen] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const [shareOpen, setShareOpen] = createSignal(false)
  const [panel, setPanel] = createSignal<"add" | "merge" | null>(null)
  const [phoneTab, setPhoneTab] = createSignal<"overview" | "timeline" | "discussion">("overview")
  // A suggested question put in the discussion box (the chips, the phone's ask box).
  const [prefill, setPrefill] = createSignal<{ text: string; n: number } | null>(null)
  const [managerNote, setManagerNote] = createSignal<string | null>(null)
  const [keptApart, setKeptApart] = createSignal<CompanyDuplicate | null>(null)
  const [duplicateNote, setDuplicateNote] = createSignal<string | null>(null)
  let reloadTimeline: (() => void) | undefined

  function ask(text: string): void {
    setPrefill({ text, n: (prefill()?.n ?? 0) + 1 })
    if (phone()) setPhoneTab("discussion")
  }

  async function pickManager(userId: string | null): Promise<void> {
    setManagerNote(null)
    try {
      const outcome = await setCompanyManager(api as never, props.entityId, userId)
      if (outcome === "pending") setManagerNote(i18n.t("contacts.companies.managerPending"))
      else if (outcome === "skipped") setManagerNote(i18n.t("contacts.companies.managerFailed"))
      else reloadTimeline?.()
    } catch {
      setManagerNote(i18n.t("contacts.companies.managerFailed"))
    }
  }

  // Writing: the scope, and a company the reader may change (an editor share,
  // or their own). RLS still decides; this only hides buttons that would fail.
  const canWrite = () => {
    const c = company()
    if (!c || !hasScope("kernel:companies:write")) return false
    return c.orgAccess !== "viewer" || c.createdBy === me()
  }

  async function refreshPeople(): Promise<void> {
    try {
      await loadCompanyPeople(api as never, props.entityId)
      setPeopleFailed(false)
    } catch {
      setPeopleFailed(true)
    } finally {
      setPeopleLoaded(true)
    }
  }

  onMount(() => {
    loadCompany(api as never, props.entityId)
      .then((c) => {
        if (!c) return
        void refreshPeople()
        void loadCompanyWaiting(api as never, props.entityId)
        loadCompanyDuplicates(api as never).catch(() => {})
      })
      .catch(() => {})
  })

  // "Only you see this company": a private company of its creator shared
  // with no one else. The sharing is read only when the company is private.
  const [privateAlone] = createResource(
    () => {
      const c = company()
      return c?.orgAccess === "none" && c.createdBy === me() ? props.entityId : null
    },
    async (id) => {
      try {
        const s = await api.get<{ users?: unknown[]; roles?: unknown[]; dimensions?: unknown[] }>(
          `/contacts/companies/${id}/sharing`,
        )
        return (
          (s?.users?.length ?? 0) + (s?.roles?.length ?? 0) + (s?.dimensions?.length ?? 0) === 0
        )
      } catch {
        return false
      }
    },
  )

  const visibility = () => {
    if (company()?.orgAccess !== "none") return "team" as const
    // Read only once ready: a pending read must never suspend the page.
    return privateAlone.state === "ready" && privateAlone() === true
      ? ("only-you" as const)
      : ("some" as const)
  }

  // The discussion opens once the company shows.
  const discussionId = () => companyStore.discussions[props.entityId]
  const [discussionFailed, setDiscussionFailed] = createSignal(false)
  let discussionOpening = false
  createEffect(() => {
    if (!company() || discussionId() || discussionOpening) return
    discussionOpening = true
    openCompanyDiscussion(api as never, props.entityId)
      .then(() => setDiscussionFailed(false))
      .catch(() => setDiscussionFailed(true))
      .finally(() => {
        discussionOpening = false
      })
  })

  // Waiting: Home's own approval rows (with their "why" line), for the
  // approvals the server found linked to this company.
  const waitingRows = createMemo(() => {
    const ids = new Set(companyStore.waiting[props.entityId] ?? [])
    if (ids.size === 0) return []
    return attentionStore.items.filter(
      (item) => item.action.type === "decide_approval" && ids.has(item.action.approvalId),
    )
  })

  const shownPeople = () =>
    showAllPeople() || people().length <= PEOPLE_SHOWN ? people() : people().slice(0, PEOPLE_SHOWN)

  // Other apps' sections, grouped by the panel's group, in that order.
  const slotEntries = createSlotPanels(() => "company_detail")
  const sections = createMemo(() => {
    const groups = new Map<string, SlotEntry[]>()
    for (const entry of slotEntries()) {
      const key = (entry.panel.group ?? entry.panel.id).toLowerCase()
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    const rank = (k: string) => {
      const i = SECTION_ORDER.indexOf(k)
      return i < 0 ? SECTION_ORDER.length : i
    }
    return [...groups.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([key, entries]) => ({ key, entries }))
  })
  const sectionTitle = (key: string, entries: SlotEntry[]) => {
    if (SECTION_ORDER.includes(key)) return i18n.t(`contacts.companies.${key}`)
    const first = entries[0]?.panel
    return first?.labelKey ? i18n.t(first.labelKey) : (first?.label ?? key)
  }

  async function performDelete(): Promise<void> {
    await api.delete(`/contacts/companies/${props.entityId}`)
    setConfirmingDelete(false)
    setOverflowOpen(false)
    openCompanyList()
  }

  return (
    <div
      class="@container flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="company-detail"
    >
      <Show
        when={loaded()}
        fallback={
          <div data-testid="company-detail.loading" class="mx-auto w-full max-w-[760px] px-8 pt-12">
            <span class="sr-only">{i18n.t("contacts.companies.loading")}</span>
            <div class="flex items-center gap-5">
              <Skeleton class="h-16 w-16 rounded-full" />
              <div class="flex-1 space-y-2">
                <Skeleton class="h-6 w-56" />
                <Skeleton class="h-3 w-72" />
              </div>
            </div>
            <div class="mt-10 space-y-3">
              <Skeleton class="h-3 w-24" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
          </div>
        }
      >
        <Show
          when={company()}
          fallback={
            <div
              data-testid="company-detail.no-access"
              class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
            >
              <Lock size={18} class="text-text-tertiary" />
              <p class="text-[14px] text-text">{i18n.t("contacts.companies.noAccess")}</p>
              <p class="max-w-sm text-[12.5px] text-text-tertiary">
                {i18n.t("contacts.companies.noAccessHint")}
              </p>
            </div>
          }
        >
          {(c) => (
            <div
              data-testid="company-detail.layout"
              class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto @[860px]:grid-cols-[minmax(480px,1fr)_380px] @[860px]:overflow-hidden"
            >
              <div class="min-w-0 @[860px]:min-w-[480px] @[860px]:overflow-y-auto [--dock-pad-base:0px] @[860px]:pb-dock-window-clearance">
                <div
                  data-testid="company-detail.body"
                  class={
                    phone()
                      ? "w-full px-4 pb-8 pt-4"
                      : "mx-auto w-full max-w-[760px] px-8 pb-24 pt-12"
                  }
                >
                  <Header
                    company={c()}
                    managerName={manager()?.name ?? null}
                    managerAway={manager()?.away?.until ?? null}
                    managerControl={
                      canWrite() ? (
                        <CompanyManagerPicker
                          managerName={manager()?.name ?? null}
                          awayText={
                            manager()?.away?.until
                              ? i18n.t("contacts.companies.awayUntil", {
                                  date: awayDay(manager()?.away?.until ?? "", i18n.locale()),
                                })
                              : null
                          }
                          onPick={pickManager}
                        />
                      ) : null
                    }
                    managerNote={managerNote()}
                    visibility={visibility()}
                    phone={phone()}
                    actions={
                      <Show when={canWrite()}>
                        <div
                          data-testid="company-detail.actions"
                          class="flex shrink-0 items-center gap-1.5"
                        >
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            class={phone() ? "min-h-11" : undefined}
                            data-testid="company-detail.add-person"
                            aria-expanded={panel() === "add" ? "true" : "false"}
                            onClick={() => setPanel((p) => (p === "add" ? null : "add"))}
                          >
                            <UserPlus size={13} />
                            {i18n.t("contacts.companies.addPerson")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            class={phone() ? "min-h-11" : undefined}
                            data-testid="company-detail.share"
                            onClick={() => setShareOpen(true)}
                          >
                            <Share2 size={13} />
                            {i18n.t("contacts.companies.share")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            class={phone() ? "min-h-11" : undefined}
                            data-testid="company-detail.merge"
                            aria-expanded={panel() === "merge" ? "true" : "false"}
                            onClick={() => setPanel((p) => (p === "merge" ? null : "merge"))}
                          >
                            {i18n.t("contacts.companies.mergeWith")}
                          </Button>
                          <div class="relative">
                            <button
                              type="button"
                              data-testid="company-detail.overflow"
                              aria-label={i18n.t("contacts.companies.moreActions")}
                              title={i18n.t("contacts.companies.moreActions")}
                              aria-expanded={overflowOpen() ? "true" : "false"}
                              class={`rounded-md p-1.5 text-text-tertiary hover:bg-surface-hover hover:text-text ${phone() ? "flex min-h-11 min-w-11 items-center justify-center" : ""}`}
                              onClick={() => setOverflowOpen((v) => !v)}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                            <Show when={overflowOpen()}>
                              <div class="absolute right-0 z-10 mt-1 min-w-44 overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-popover">
                                <button
                                  type="button"
                                  data-testid="company-detail.delete"
                                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-danger/10"
                                  onClick={() => {
                                    setConfirmingDelete(true)
                                    setOverflowOpen(false)
                                  }}
                                >
                                  <Trash2 size={13} />
                                  {i18n.t("kernel.common.delete")}
                                </button>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>
                    }
                  />

                  <Show when={confirmingDelete()}>
                    <div
                      data-testid="company-detail.delete-confirmation"
                      class="mt-6 flex items-center justify-end gap-2 rounded-md border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px]"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        {i18n.t("kernel.common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        data-testid="company-detail.delete-confirm"
                        onClick={() => void performDelete().catch(() => {})}
                      >
                        {i18n.t("kernel.common.delete")}
                      </Button>
                    </div>
                  </Show>

                  <Show when={panel() === "add"}>
                    <AddPersonStrip
                      company={c()}
                      onAdded={() => void refreshPeople()}
                      onClose={() => setPanel(null)}
                    />
                  </Show>
                  <Show when={panel() === "merge"}>
                    <MergeStrip company={c()} onClose={() => setPanel(null)} />
                  </Show>

                  <Show when={phone()}>
                    <div
                      role="tablist"
                      aria-label={i18n.t("contacts.companies.phoneTabs")}
                      data-testid="company-detail.phone-tabs"
                      class="mt-5 grid grid-cols-3 gap-2"
                    >
                      <For each={["overview", "timeline", "discussion"] as const}>
                        {(tab) => (
                          <button
                            type="button"
                            role="tab"
                            data-testid={`company-detail.tab-${tab}`}
                            aria-selected={phoneTab() === tab ? "true" : "false"}
                            class={`min-h-11 rounded-full border px-3 text-[13px] ${
                              phoneTab() === tab
                                ? "border-border bg-surface-hover text-text"
                                : "border-border-subtle text-text-secondary"
                            }`}
                            onClick={() => setPhoneTab(tab)}
                          >
                            {i18n.t(
                              tab === "overview"
                                ? "contacts.companies.phoneOverview"
                                : tab === "timeline"
                                  ? "contacts.companies.phoneTimeline"
                                  : "contacts.companies.phoneDiscussion",
                            )}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={!phone() || phoneTab() === "overview"}>
                    <Show when={waitingRows().length > 0}>
                      <section class="mt-10" data-testid="company-detail.waiting">
                        <SectionHeading eyebrow={i18n.t("contacts.companies.waiting")} />
                        <div class="mt-2 space-y-1">
                          <For each={waitingRows()}>{(item) => <AttentionRow item={item} />}</For>
                        </div>
                      </section>
                    </Show>

                    <For each={(companyStore.duplicates[props.entityId] ?? []).slice(0, 1)}>
                      {(dup) => (
                        <DuplicatePanel
                          company={c()}
                          duplicate={dup}
                          canWrite={canWrite()}
                          onKept={(d) => {
                            setDuplicateNote(null)
                            setKeptApart(d)
                          }}
                          onMerged={() => {
                            setKeptApart(null)
                            setDuplicateNote(
                              i18n.t("contacts.companies.mergeDone", {
                                source: dup.name,
                                target: c().name,
                              }),
                            )
                            void loadCompany(api as never, props.entityId).catch(() => {})
                            void refreshPeople()
                            reloadTimeline?.()
                          }}
                        />
                      )}
                    </For>

                    <Show when={keptApart()}>
                      {(k) => (
                        <p
                          data-testid="company-detail.kept-apart"
                          class="mt-8 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary"
                        >
                          {i18n.t("contacts.companies.keptSeparate", { name: k().name })}
                          <button
                            type="button"
                            data-testid="company-detail.kept-apart-undo"
                            class="min-h-8 rounded-md border border-border px-2.5 text-text-secondary hover:bg-surface-hover hover:text-text"
                            onClick={() =>
                              void markCompaniesNotSame(
                                api as never,
                                { ...k(), self: props.entityId },
                                true,
                              )
                                .then(() => setKeptApart(null))
                                .catch(() =>
                                  setDuplicateNote(i18n.t("contacts.companies.notSameFailed")),
                                )
                            }
                          >
                            {i18n.t("contacts.companies.undo")}
                          </button>
                        </p>
                      )}
                    </Show>
                    <Show when={duplicateNote()}>
                      {(note) => (
                        <p
                          data-testid="company-detail.duplicate-note"
                          class="mt-8 text-[12.5px] text-text-secondary"
                        >
                          {note()}
                        </p>
                      )}
                    </Show>

                    <section class="mt-10" data-testid="company-detail.people">
                      <SectionHeading
                        eyebrow={i18n.t("contacts.companies.peopleSection")}
                        count={c().peopleCount}
                      />
                      <Show
                        when={!peopleFailed()}
                        fallback={
                          <p
                            data-testid="company-detail.people-unavailable"
                            class="py-3 text-[12.5px] text-text-tertiary"
                          >
                            {i18n.t("contacts.companies.peopleUnavailable")}
                          </p>
                        }
                      >
                        <Show
                          when={people().length > 0}
                          fallback={
                            <Show when={peopleLoaded()}>
                              <div data-testid="company-detail.people-empty" class="mt-3">
                                <p class="rounded-md border border-dashed border-border-subtle px-4 py-4 text-center text-[12.5px] text-text-tertiary">
                                  {i18n.t("contacts.companies.noPeopleNew")}
                                </p>
                                <div class="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    data-testid="company-detail.ask-find-people"
                                    class="min-h-9 rounded-full border border-border px-3 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text"
                                    onClick={() =>
                                      ask(
                                        i18n.t("contacts.companies.askFindPeoplePrompt", {
                                          name: c().name,
                                        }),
                                      )
                                    }
                                  >
                                    {i18n.t("contacts.companies.askFindPeople")}
                                  </button>
                                  <Show when={c().domain}>
                                    {(domain) => (
                                      <button
                                        type="button"
                                        data-testid="company-detail.ask-link-mail"
                                        class="min-h-9 rounded-full border border-border px-3 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text"
                                        onClick={() =>
                                          ask(
                                            i18n.t("contacts.companies.askLinkMailPrompt", {
                                              name: c().name,
                                              domain: domain(),
                                            }),
                                          )
                                        }
                                      >
                                        {i18n.t("contacts.companies.askLinkMail")}
                                      </button>
                                    )}
                                  </Show>
                                </div>
                              </div>
                            </Show>
                          }
                        >
                          <ul class="divide-y divide-border-subtle">
                            <For each={shownPeople()}>
                              {(p) => (
                                <li>
                                  <button
                                    type="button"
                                    data-testid={`company-person-${p.id}`}
                                    class="flex w-full items-center gap-3 py-2 text-left text-[13px] hover:bg-surface-hover"
                                    onClick={() =>
                                      openTab({
                                        type: "contact-detail",
                                        entityId: p.id,
                                        label: p.name ?? p.email ?? "",
                                      })
                                    }
                                  >
                                    <ContactAvatar
                                      id={p.id}
                                      name={p.name}
                                      email={p.email}
                                      size="sm"
                                    />
                                    <span class="truncate text-text">{p.name ?? p.email}</span>
                                    <Show when={p.role}>
                                      <span class="truncate text-text-tertiary">{p.role}</span>
                                    </Show>
                                    <Show when={p.isMain}>
                                      <span class="rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary">
                                        {i18n.t("contacts.companies.mainContact")}
                                      </span>
                                    </Show>
                                    <span class="ml-auto truncate font-mono text-[12px] text-text-tertiary">
                                      {p.email}
                                    </span>
                                  </button>
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={people().length > PEOPLE_SHOWN}>
                            <button
                              type="button"
                              data-testid="company-detail.people-show-all"
                              class="mt-2 text-[12px] text-text-secondary hover:text-text"
                              onClick={() => setShowAllPeople((v) => !v)}
                            >
                              {showAllPeople()
                                ? i18n.t("contacts.companies.showFewer")
                                : i18n.t("contacts.companies.showAll", { count: people().length })}
                            </button>
                          </Show>
                        </Show>
                      </Show>
                    </section>

                    <section class="mt-10" data-testid="company-detail.deals">
                      <SectionHeading eyebrow={i18n.t("contacts.companies.deals")} />
                      <Show
                        when={c().openDeal}
                        fallback={
                          <p class="py-3 text-[12.5px] text-text-tertiary">
                            {i18n.t("contacts.companies.noOpenDeal")}
                          </p>
                        }
                      >
                        {(deal) => (
                          <>
                            <button
                              type="button"
                              data-testid={`company-deal-${deal().taskId}`}
                              class="flex w-full min-w-0 items-baseline gap-2 py-2 text-left text-[13px] text-text hover:bg-surface-hover"
                              onClick={() =>
                                openTab({
                                  type: "projects:task",
                                  entityId: deal().taskId,
                                  label: deal().title ?? dealText(deal(), i18n),
                                })
                              }
                            >
                              <Show when={deal().title}>
                                <span class="truncate font-medium">{deal().title}</span>
                              </Show>
                              <span class={deal().title ? "shrink-0 text-text-secondary" : ""}>
                                {dealText(deal(), i18n)}
                              </span>
                            </button>
                            <Show when={deal().projectId}>
                              {(projectId) => (
                                <button
                                  type="button"
                                  data-testid="company-detail.open-board"
                                  class="mt-1 text-[12.5px] text-accent hover:underline"
                                  onClick={() =>
                                    openTab({
                                      type: "projects:project",
                                      entityId: projectId(),
                                      label: i18n.t("contacts.companies.deals"),
                                    })
                                  }
                                >
                                  {i18n.t("contacts.companies.openBoard")}
                                </button>
                              )}
                            </Show>
                          </>
                        )}
                      </Show>
                    </section>

                    <For each={sections()}>
                      {(section) => (
                        <section
                          class="mt-10"
                          data-testid={`company-detail.section-${section.key}`}
                        >
                          <SectionHeading eyebrow={sectionTitle(section.key, section.entries)} />
                          <div class="mt-2 space-y-3">
                            <For each={section.entries}>
                              {(entry) => <SlotEntryView entry={entry} entityId={props.entityId} />}
                            </For>
                          </div>
                        </section>
                      )}
                    </For>
                  </Show>

                  <Show when={!phone() || phoneTab() === "timeline"}>
                    <section
                      class={phone() ? "mt-6" : "mt-10"}
                      data-testid="company-detail.timeline"
                    >
                      <ActivityPanel
                        path={`/contacts/companies/${props.entityId}/activity`}
                        testId="company-activity"
                        title={i18n.t("contacts.companies.timeline")}
                        emptyText={i18n.t("contacts.activity.empty")}
                        ref={(reload) => {
                          reloadTimeline = reload
                        }}
                      />
                    </section>
                  </Show>

                  <Show when={phone() && phoneTab() !== "discussion"}>
                    <form
                      data-testid="company-detail.ask-box"
                      class="sticky bottom-0 mt-6 flex items-center gap-2 bg-bg py-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const field = e.currentTarget.elements.namedItem(
                          "ask",
                        ) as HTMLInputElement | null
                        const text = field?.value.trim() ?? ""
                        if (field) field.value = ""
                        ask(text)
                      }}
                    >
                      <input
                        name="ask"
                        type="text"
                        data-testid="company-detail.ask-input"
                        aria-label={i18n.t("contacts.companies.askBox", { name: c().name })}
                        placeholder={i18n.t("contacts.companies.askBox", { name: c().name })}
                        class="min-h-11 min-w-0 flex-1 rounded-full border border-border bg-surface px-4 text-[14px] text-text outline-none placeholder:text-text-tertiary"
                      />
                      <button
                        type="submit"
                        data-testid="company-detail.ask-send"
                        aria-label={i18n.t("contacts.companies.discussionSend")}
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-hover text-text-secondary"
                      >
                        <ArrowUp size={16} />
                      </button>
                    </form>
                  </Show>
                </div>
              </div>

              <Show when={!phone() || phoneTab() === "discussion"}>
                <aside
                  data-testid="company-detail.discussion-pane"
                  style={{ "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD }}
                  class="border-t border-border-subtle bg-surface/30 px-4 pt-6 @[600px]:px-5 @[860px]:flex @[860px]:min-h-0 @[860px]:w-[380px] @[860px]:flex-col @[860px]:overflow-hidden @[860px]:border-t-0 @[860px]:border-l"
                >
                  <section
                    data-testid="company-detail.discussion"
                    class="flex min-h-0 flex-col gap-3 @[860px]:flex-1"
                  >
                    <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
                      {i18n.t("contacts.companies.discussion")}
                    </h3>
                    <p class="text-[12px] text-text-tertiary">
                      {i18n.t("contacts.companies.discussionHint", { name: c().name })}
                    </p>
                    <Show
                      when={discussionId()}
                      fallback={
                        <Show when={discussionFailed()}>
                          <p
                            data-testid="company-discussion.unavailable"
                            class="py-2 text-[12.5px] text-text-tertiary"
                          >
                            {i18n.t("contacts.companies.discussionUnavailable")}
                          </p>
                        </Show>
                      }
                    >
                      {(threadId) => (
                        <div
                          data-testid="company-detail.thread"
                          class="flex min-h-0 flex-1 flex-col"
                        >
                          <Suspense>
                            <EntityDiscussion
                              threadId={threadId()}
                              testId="company-discussion"
                              emptyText={i18n.t("contacts.companies.discussionEmpty")}
                              placeholder={i18n.t("contacts.companies.discussionPlaceholder", {
                                name: c().name,
                              })}
                              sendLabel={i18n.t("contacts.companies.discussionSend")}
                              prefill={prefill()}
                            />
                          </Suspense>
                        </div>
                      )}
                    </Show>
                  </section>
                </aside>
              </Show>

              <CompanyShareDialog
                companyId={props.entityId}
                companyName={c().name}
                open={shareOpen()}
                onOpenChange={setShareOpen}
                onSaved={() => void loadCompany(api as never, props.entityId).catch(() => {})}
              />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────

const Header: Component<{
  company: Company
  managerName: string | null
  managerAway: string | null
  /** The in-place picker, for a reader who may change the company. */
  managerControl: unknown
  managerNote: string | null
  visibility: "team" | "some" | "only-you"
  phone: boolean
  actions: unknown
}> = (props) => {
  const i18n = useI18n()
  return (
    <header
      class={
        props.phone ? "flex flex-col items-start gap-3" : "flex items-start justify-between gap-6"
      }
    >
      {/* max-w-full: in the phone's column (items-start) this block would
          otherwise grow to its one-line title and run off the screen. */}
      <div class="flex min-w-0 max-w-full items-start gap-5">
        <ContactAvatar id={props.company.id} name={props.company.name} size="xl" />
        <div class="min-w-0 pt-1">
          <h1
            data-testid="company-detail.title"
            class={`truncate font-display font-semibold leading-tight text-text ${props.phone ? "text-[30px]" : "text-[28px]"}`}
          >
            {props.company.name}
          </h1>
          <p class="mt-1 flex min-w-0 flex-wrap items-baseline gap-2 text-[13px] text-text-secondary">
            <Show when={props.company.domain}>
              <span data-testid="company-detail.domain" class="font-mono text-[12.5px]">
                {props.company.domain}
              </span>
            </Show>
            <Show when={props.company.description}>
              <span>{props.company.description}</span>
            </Show>
          </p>
          <p data-testid="company-detail.manager" class="mt-2 text-[12.5px] text-text-secondary">
            <span class="text-text-tertiary">{i18n.t("contacts.companies.accountManager")}</span>{" "}
            <Show when={!props.managerControl} fallback={props.managerControl as never}>
              <Show
                when={props.managerName}
                fallback={<span>{i18n.t("contacts.companies.noAccountManager")}</span>}
              >
                <span class="text-text">{props.managerName}</span>
                <Show when={props.managerAway}>
                  {(until) => (
                    <span class="text-text-tertiary">
                      {" · "}
                      {i18n.t("contacts.companies.awayUntil", {
                        date: awayDay(until(), i18n.locale()),
                      })}
                    </span>
                  )}
                </Show>
              </Show>
            </Show>
          </p>
          <Show when={props.managerNote}>
            {(note) => (
              <p
                data-testid="company-detail.manager-note"
                class="mt-1 text-[12px] text-text-tertiary"
              >
                {note()}
              </p>
            )}
          </Show>
          <p class="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <span
              data-testid="company-detail.visibility"
              data-visibility={props.visibility}
              class="inline-flex items-center gap-1 rounded bg-surface-hover px-1.5 py-0.5 text-text-secondary"
            >
              <Show when={props.visibility === "team"} fallback={<Lock size={10} />}>
                <Users size={10} />
              </Show>
              {props.visibility === "team"
                ? i18n.t("contacts.companies.visibleToTeam")
                : props.visibility === "only-you"
                  ? i18n.t("contacts.companies.onlyYou")
                  : i18n.t("contacts.companies.sharedWithSome")}
            </span>
            <Show when={props.company.closedAt}>
              <span class="rounded bg-surface-hover px-1.5 py-0.5 text-text-tertiary">
                {i18n.t("contacts.companies.relationshipEnded")}
              </span>
            </Show>
          </p>
        </div>
      </div>
      {props.actions as never}
    </header>
  )
}

// ── Add person: search people, link one with a click ───────────────────

const AddPersonStrip: Component<{
  company: Company
  onAdded: () => void
  onClose: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [hits, setHits] = createSignal<PersonHit[]>([])
  const [message, setMessage] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  function search(value: string): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const q = value.trim()
      if (!q) return setHits([])
      try {
        const res = await api.getEnvelope<PersonHit[]>(
          `/contacts?${new URLSearchParams({ query: q, limit: "8" }).toString()}`,
        )
        setHits((res.data ?? []).filter((p) => p.companyId !== props.company.id))
      } catch {
        setHits([])
      }
    }, 250)
  }

  async function add(person: PersonHit): Promise<void> {
    const name = person.name ?? person.email ?? ""
    try {
      await linkCompanyPeople(api as never, props.company.id, [person.id])
      setHits((list) => list.filter((p) => p.id !== person.id))
      setMessage(i18n.t("contacts.companies.addPersonDone", { name, company: props.company.name }))
      props.onAdded()
    } catch {
      setMessage(i18n.t("contacts.companies.addPersonFailed", { name }))
    }
  }

  return (
    <div
      data-testid="company-detail.add-strip"
      class="mt-6 rounded-md border border-border-subtle px-3 py-2.5"
    >
      <div class="flex items-center gap-2">
        <input
          data-testid="company-detail.add-search"
          type="text"
          aria-label={i18n.t("contacts.companies.addPersonSearch")}
          placeholder={i18n.t("contacts.companies.addPersonSearch")}
          class="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
          onInput={(e) => search(e.currentTarget.value)}
        />
        <button
          type="button"
          class="text-[12px] text-text-tertiary hover:text-text"
          onClick={() => props.onClose()}
        >
          {i18n.t("contacts.companies.close")}
        </button>
      </div>
      <ul class="mt-1">
        <For each={hits()}>
          {(p) => (
            <li>
              <button
                type="button"
                data-testid={`company-detail.add-hit-${p.id}`}
                class="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-[13px] hover:bg-surface-hover"
                onClick={() => void add(p)}
              >
                <ContactAvatar id={p.id} name={p.name} email={p.email} size="sm" />
                <span class="truncate text-text">{p.name ?? p.email}</span>
                <span class="ml-auto truncate font-mono text-[12px] text-text-tertiary">
                  {p.email}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={message()}>
        {(m) => (
          <p data-testid="company-detail.add-message" class="mt-1 text-[12px] text-text-secondary">
            {m()}
          </p>
        )}
      </Show>
    </div>
  )
}

// ── Merge with: pick the company to keep, say what happens, then merge ──

const MergeStrip: Component<{ company: Company; onClose: () => void }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [hits, setHits] = createSignal<Company[]>([])
  const [target, setTarget] = createSignal<Company | null>(null)
  const [failed, setFailed] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function search(value: string): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const q = value.trim()
      if (!q) return setHits([])
      try {
        const res = await api.getEnvelope<Company[]>(
          `/contacts/companies?${new URLSearchParams({ query: q, limit: "8" }).toString()}`,
        )
        setHits((res.data ?? []).filter((c) => c.id !== props.company.id))
      } catch {
        setHits([])
      }
    }, 250)
  }

  async function merge(): Promise<void> {
    const keep = target()
    if (!keep) return
    setFailed(false)
    try {
      await api.post("/apps/run-tool", {
        toolName: "kernel:companies_merge",
        params: { sourceId: props.company.id, targetId: keep.id },
      })
      props.onClose()
      openCompanyTab(keep.id, keep.name)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div
      data-testid="company-detail.merge-strip"
      class="mt-6 rounded-md border border-border-subtle px-3 py-2.5"
    >
      <Show
        when={target()}
        fallback={
          <>
            <div class="flex items-center gap-2">
              <input
                data-testid="company-detail.merge-search"
                type="text"
                aria-label={i18n.t("contacts.companies.mergeSearch")}
                placeholder={i18n.t("contacts.companies.mergeSearch")}
                class="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                onInput={(e) => search(e.currentTarget.value)}
              />
              <button
                type="button"
                class="text-[12px] text-text-tertiary hover:text-text"
                onClick={() => props.onClose()}
              >
                {i18n.t("contacts.companies.close")}
              </button>
            </div>
            <ul class="mt-1">
              <For each={hits()}>
                {(c) => (
                  <li>
                    <button
                      type="button"
                      data-testid={`company-detail.merge-hit-${c.id}`}
                      class="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-[13px] hover:bg-surface-hover"
                      onClick={() => setTarget(c)}
                    >
                      <ContactAvatar id={c.id} name={c.name} size="sm" />
                      <span class="truncate text-text">{c.name}</span>
                      <span class="ml-auto truncate font-mono text-[12px] text-text-tertiary">
                        {c.domain}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </>
        }
      >
        {(keep) => (
          <div class="flex flex-col gap-2 text-[13px]">
            <p data-testid="company-detail.merge-confirm-text" class="text-text-secondary">
              {i18n.t("contacts.companies.mergeConfirm", {
                source: props.company.name,
                target: keep().name,
              })}
            </p>
            <div class="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setTarget(null)}>
                {i18n.t("kernel.common.cancel")}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid="company-detail.merge-confirm"
                onClick={() => void merge()}
              >
                {i18n.t("contacts.companies.mergeInto", { name: keep().name })}
              </Button>
            </div>
            <Show when={failed()}>
              <p data-testid="company-detail.merge-failed" class="text-[12px] text-danger">
                {i18n.t("contacts.companies.mergeFailed")}
              </p>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

// ── Duplicate: merge the other one into this company, or keep them apart ──

const DuplicatePanel: Component<{
  company: Company
  duplicate: CompanyDuplicate
  canWrite: boolean
  onMerged: () => void
  onKept: (duplicate: CompanyDuplicate) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [other] = createResource(
    () => props.duplicate.id,
    async (id) => {
      try {
        const res = await api.get<Company | { data: Company }>(`/contacts/companies/${id}`)
        return res && "data" in (res as object) ? (res as { data: Company }).data : (res as Company)
      } catch {
        return null
      }
    },
  )
  // "Merge into": held 8 s with Undo. Closing the page in that time merges nothing.
  const [holding, setHolding] = createSignal(false)
  const [failed, setFailed] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  // The merge keeps the established company: the one with an open deal, else
  // more people, else the older one. On a minute-old copy's page that is the
  // other company, never the copy.
  const survivor = (): { id: string; name: string } => {
    const o = other.state === "ready" ? other() : null
    const here = { id: props.company.id, name: props.company.name }
    if (!o) return here
    const weight = (c: Company) => [c.openDeal ? 1 : 0, c.peopleCount] as const
    const [od, op] = weight(o)
    const [hd, hp] = weight(props.company)
    const otherWins =
      od !== hd
        ? od > hd
        : op !== hp
          ? op > hp
          : !!o.createdAt && !!props.company.createdAt && o.createdAt < props.company.createdAt
    return otherWins ? { id: o.id, name: o.name } : here
  }
  const mergedAway = () =>
    survivor().id === props.company.id
      ? { id: props.duplicate.id, name: props.duplicate.name }
      : { id: props.company.id, name: props.company.name }

  function startMerge(): void {
    setFailed(null)
    setHolding(true)
    const target = survivor()
    const source = mergedAway()
    timer = setTimeout(() => {
      timer = undefined
      mergeCompanyInto(api as never, source.id, target.id)
        .then(() =>
          target.id === props.company.id
            ? props.onMerged()
            : openCompanyTab(target.id, target.name),
        )
        .catch(() => setFailed(i18n.t("contacts.companies.mergeFailed")))
        .finally(() => setHolding(false))
    }, MERGE_HOLD_MS)
  }

  function undoMerge(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    setHolding(false)
  }

  async function keepSeparate(): Promise<void> {
    setFailed(null)
    const pair = { ...props.duplicate, self: props.company.id }
    try {
      await markCompaniesNotSame(api as never, pair)
      props.onKept(props.duplicate)
    } catch {
      setFailed(i18n.t("contacts.companies.notSameFailed"))
    }
  }

  const reason = () =>
    props.duplicate.signal === "same_domain"
      ? i18n.t("contacts.companies.duplicateSameDomain")
      : props.duplicate.signal === "same_name"
        ? i18n.t("contacts.companies.duplicateSameName")
        : i18n.t("contacts.companies.duplicateBoth")

  const otherLine = () => {
    // Read only once ready: a pending read must never suspend the page.
    const o = other.state === "ready" ? other() : null
    if (!o) return null
    const people =
      o.peopleCount === 1
        ? i18n.t("contacts.companies.personOne")
        : i18n.t("contacts.companies.personMany", { count: o.peopleCount })
    const deal = o.openDeal ? dealText(o.openDeal, i18n) : i18n.t("contacts.companies.noDeal")
    return `${people} · ${deal}`
  }

  return (
    <section
      data-testid="company-detail.duplicate"
      class="mt-8 rounded-md border border-border-subtle bg-surface/40 px-4 py-3"
    >
      <p class="flex items-center gap-2 text-[13.5px] text-text">
        <GitMerge size={14} class="text-text-tertiary" />
        {i18n.t("contacts.companies.duplicateTitle", { name: props.duplicate.name })}
      </p>
      <p class="mt-1 text-[12.5px] text-text-secondary">{reason()}</p>
      <Show when={otherLine()}>
        {(line) => (
          <p
            data-testid="company-detail.duplicate-other"
            class="mt-1 text-[12px] text-text-tertiary"
          >
            {props.duplicate.name}: {line()}
          </p>
        )}
      </Show>
      <Show when={props.canWrite}>
        <Show
          when={holding()}
          fallback={
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="company-detail.duplicate-merge"
                onClick={startMerge}
              >
                {i18n.t("contacts.companies.mergeInto", { name: survivor().name })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="company-detail.duplicate-keep"
                onClick={() => void keepSeparate()}
              >
                {i18n.t("contacts.companies.keepSeparate")}
              </Button>
            </div>
          }
        >
          <div
            data-testid="company-detail.duplicate-holding"
            class="mt-3 flex items-center justify-between gap-3 text-[12.5px] text-text-secondary"
          >
            <span>
              {i18n.t("contacts.companies.mergeHolding", {
                source: mergedAway().name,
                target: survivor().name,
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="company-detail.duplicate-undo"
              onClick={undoMerge}
            >
              {i18n.t("contacts.companies.undo")}
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={failed()}>
        {(f) => (
          <p data-testid="company-detail.duplicate-failed" class="mt-2 text-[12px] text-danger">
            {f()}
          </p>
        )}
      </Show>
    </section>
  )
}

// ── Section heading ────────────────────────────────────────────────────

const SectionHeading: Component<{ eyebrow: string; count?: number }> = (props) => (
  <div class="flex items-baseline justify-between gap-3 border-b border-border-subtle pb-2">
    <h2 class="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
      {props.eyebrow}
      <Show when={props.count !== undefined && props.count > 0}>
        <span class="ml-2 tabular-nums">{props.count}</span>
      </Show>
    </h2>
  </div>
)

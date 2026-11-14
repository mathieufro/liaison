// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  Building2,
  Check,
  Lock,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-solid"
import { type Component, createEffect, createSignal, lazy, onMount, Show, Suspense } from "solid-js"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/relative-time"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { SlotPanels } from "~/modules/shell/SlotPanels"
import { shellTier } from "~/modules/shell/shell-tier"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Button } from "~/ui/Button"
import { ActivityPanel } from "./ActivityPanel"
import { AddToGroupMenu } from "./AddToGroupMenu"
import { ContactAddresses } from "./ContactAddresses"
import { ContactAvatar } from "./ContactAvatar"
import { ContactMergeDialog } from "./ContactMergeDialog"
import { ContactShareDialog } from "./ContactShareDialog"
import { type Company, companyStore, loadCompany } from "./company-store"
import { dealText, openCompanyTab } from "./company-visuals"
import {
  contactDetailStore,
  deleteContact,
  loadContact,
  loadOptOut,
  openContactDiscussion,
  updateContact,
} from "./contact-detail-store"
import { loadContactGroups } from "./contact-groups-store"
import { openMerge } from "./contact-merge-store"
import { contactDisplayName } from "./contact-visuals"
import { TrustedSenderControl } from "./TrustedSenderControl"

const EntityDiscussion = lazy(() => import("~/modules/threads/EntityDiscussion"))

interface ContactDetailProps {
  entityId: string
}

export const ContactDetail: Component<ContactDetailProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const contact = () => contactDetailStore.contacts[props.entityId]
  // The contact's company, read as the viewer: a link and a line when they can see it, the plain
  // `company` text (no link, no error) when they cannot.
  const canReadCompanies = () => hasScope("kernel:companies:read")
  const linkedCompany = (): Company | null => {
    const id = contact()?.companyId
    return id ? (companyStore.companies[id] ?? null) : null
  }
  const companyLine = (company: Company): string =>
    company.openDeal
      ? dealText(company.openDeal, i18n)
      : (company.domain ?? i18n.t("contacts.companies.noDeal"))
  const canSeeTimeline = () => canReadCompanies()
  const day = (iso: string) =>
    i18n.fmtDate(new Date(iso), { day: "numeric", month: "short", year: "numeric" })
  /** What commercial mail to this person rests on, never "allowed" without a recorded basis. */
  const followUps = (): { state: string; headline: string; detail: string | null } => {
    const c = contact()
    const optOut = contactDetailStore.optOuts[props.entityId]
    if (optOut?.state === "opted_out") {
      const by = optOut.by ? i18n.t(`contacts.followUps.by.${optOut.by}`) : null
      const detail =
        optOut.since && by
          ? i18n.t("contacts.followUps.sinceBy", { date: day(optOut.since), by })
          : optOut.since
            ? i18n.t("contacts.followUps.since", { date: day(optOut.since) })
            : null
      return { state: "opted_out", headline: i18n.t("contacts.followUps.optedOut"), detail }
    }
    if (!optOut || optOut.state === "unavailable") {
      return {
        state: "unknown",
        headline: i18n.t("contacts.followUps.unknown"),
        detail: null,
      }
    }
    if (!c?.lawfulBasis) {
      return {
        state: "no_basis",
        headline: i18n.t("contacts.followUps.noBasis"),
        detail: null,
      }
    }
    return {
      state: "allowed",
      headline: i18n.t("contacts.followUps.allowed", {
        basis: i18n.t(`contacts.followUps.basis.${c.lawfulBasis}`),
      }),
      detail: c.lawfulBasisAt
        ? i18n.t("contacts.followUps.recorded", { date: day(c.lawfulBasisAt) })
        : null,
    }
  }
  const [overflowOpen, setOverflowOpen] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const [deleted, setDeleted] = createSignal(false)
  const [shareOpen, setShareOpen] = createSignal(false)
  // Contact groups (S15): the groups this contact is in, and the add menu.
  const [groupMenuOpen, setGroupMenuOpen] = createSignal(false)
  const [memberOf, setMemberOf] = createSignal<ReadonlySet<string>>(new Set())
  async function refreshGroups(): Promise<void> {
    try {
      const list = await loadContactGroups(api as never, props.entityId)
      setMemberOf(new Set(list.map((g) => g.id)))
    } catch {
      // Groups are an extra: the contact page stands without them.
    }
  }
  // Who can see it: the organisation, only its owner, or specific people.
  const visibility = () => {
    const c = contact()
    if (c?.orgAccess !== "none") return "organisation" as const
    return c.ownerUserId && c.ownerUserId === userFromToken()?.userId
      ? ("private" as const)
      : ("shared" as const)
  }
  const phone = () => shellTier() === "phone"
  // The contact's discussion: opened once the contact shows (the server enrols
  // whoever sees it), and again after its sharing changed (the store drops it).
  const discussionId = () => contactDetailStore.discussions[props.entityId]
  const [discussionFailed, setDiscussionFailed] = createSignal(false)
  let discussionOpening = false
  createEffect(() => {
    if (!contact() || discussionId() || discussionOpening) return
    discussionOpening = true
    openContactDiscussion(api, props.entityId)
      .then(() => setDiscussionFailed(false))
      .catch(() => setDiscussionFailed(true))
      .finally(() => {
        discussionOpening = false
      })
  })

  // Once the contact shows: its company (when the viewer may read companies) and its opt-out state.
  let followedContactId: string | null = null
  createEffect(() => {
    const c = contact()
    if (!c || followedContactId === c.id) return
    followedContactId = c.id
    void loadOptOut(api, c.id, c.email)
  })
  createEffect(() => {
    const id = contact()?.companyId
    if (!id || !canReadCompanies() || companyStore.companies[id] !== undefined) return
    loadCompany(api as never, id).catch(() => {})
  })

  onMount(() => {
    // A missing contact resolves to null (the not-found state below); any other failure is the
    // api client's to report (its global toast), never an uncaught rejection on the page.
    loadContact(api, props.entityId).catch(() => {})
    void refreshGroups()
  })

  async function performDelete(): Promise<void> {
    await deleteContact(api, props.entityId)
    setDeleted(true)
    setConfirmingDelete(false)
    setOverflowOpen(false)
  }

  return (
    // Content and discussion side by side only where both fit (as on a task);
    // narrower (the phone, a laptop with the sidebar open) the discussion
    // follows the contact's details, its box last.
    <div
      class="@container flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="contact-detail"
    >
      <Show
        when={!deleted() && contact()}
        fallback={
          <div
            class="flex flex-1 items-center justify-center text-sm text-text-secondary"
            data-testid="contact-not-found"
          >
            {deleted() ? i18n.t("contacts.contactDeleted") : i18n.t("contacts.contactNotFound")}
          </div>
        }
      >
        <div
          data-testid="contact-detail.layout"
          class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto @[860px]:grid-cols-[minmax(480px,1fr)_380px] @[860px]:overflow-hidden"
        >
          <div
            data-testid="contact-detail.content-pane"
            class="min-w-0 @[860px]:min-w-[480px] @[860px]:overflow-y-auto [--dock-pad-base:0px] @[860px]:pb-dock-window-clearance"
          >
            {/* ── Page container, generous padding, narrow column ─────
              At phone width the narrow column and its 32px gutters are the
              whole screen minus a third of it: full width with 16px gutters
              instead, which is what a phone reading column is. */}
            <div
              data-testid="contact-detail-body"
              class={
                phone() ? "w-full px-4 pb-8 pt-4" : "mx-auto w-full max-w-[760px] px-8 pb-24 pt-12"
              }
            >
              {/* ── Hero: avatar + name + actions ─────────────────── */}
              <header
                class={
                  phone()
                    ? "flex flex-col items-start gap-3"
                    : "flex items-start justify-between gap-6"
                }
              >
                <div class="flex min-w-0 items-start gap-5">
                  <ContactAvatar
                    id={props.entityId}
                    name={contact()?.name}
                    email={contact()?.email}
                    size="xl"
                  />
                  <div class="min-w-0 pt-1">
                    <h1
                      data-testid="contact-detail-title"
                      class={`truncate font-display font-semibold leading-tight text-text ${phone() ? "text-[30px]" : "text-[28px]"}`}
                    >
                      {contactDisplayName(contact() ?? {})}
                    </h1>
                    <Show when={contact()?.email}>
                      {(email) => (
                        <p class="mt-1 flex min-w-0 items-center gap-2">
                          <span class="truncate font-mono text-[12.5px] text-text-secondary">
                            {email()}
                          </span>
                          <TrustedSenderControl email={email()} testId="contact-sender-trust" />
                        </p>
                      )}
                    </Show>
                    <p class="mt-2 text-[11px] text-text-tertiary">
                      <span
                        data-testid="contact-visibility"
                        data-visibility={visibility()}
                        class="mr-1.5 inline-flex items-center gap-1 rounded bg-surface-hover px-1.5 py-0.5 text-text-secondary"
                        title={i18n.t(`contacts.sharing.visibility.${visibility()}Hint`)}
                      >
                        <Show when={visibility() === "organisation"} fallback={<Lock size={10} />}>
                          <Users size={10} />
                        </Show>
                        {i18n.t(`contacts.sharing.visibility.${visibility()}`)}
                      </span>
                      {contact()?.createdAt
                        ? i18n.t("contacts.addedWhen", {
                            when: relativeTime(contact()?.createdAt, i18n.locale()),
                          })
                        : i18n.t("contacts.addedRecently")}
                      <Show
                        when={contact()?.updatedAt && contact()?.updatedAt !== contact()?.createdAt}
                      >
                        <span aria-hidden="true" class="px-1.5 text-text-tertiary/60">
                          ·
                        </span>
                        <span>
                          {i18n.t("contacts.editedWhen", {
                            when: relativeTime(contact()?.updatedAt, i18n.locale()),
                          })}
                        </span>
                      </Show>
                    </p>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <div class="relative">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="contact-add-to-group"
                      aria-expanded={groupMenuOpen() ? "true" : "false"}
                      onClick={() => setGroupMenuOpen((v) => !v)}
                    >
                      <Users size={13} />
                      {i18n.t("contacts.groups.addToGroup")}
                    </Button>
                    <Show when={groupMenuOpen()}>
                      <AddToGroupMenu
                        contactIds={[props.entityId]}
                        memberOf={memberOf()}
                        onChanged={(groupId, added) => {
                          const next = new Set(memberOf())
                          if (added) next.add(groupId)
                          else next.delete(groupId)
                          setMemberOf(next)
                        }}
                        onClose={() => setGroupMenuOpen(false)}
                      />
                    </Show>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="contact-share-open"
                    onClick={() => setShareOpen(true)}
                  >
                    <Share2 size={13} />
                    {i18n.t("contacts.sharing.share")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="contact-merge-open"
                    onClick={() => openMerge(props.entityId)}
                  >
                    {i18n.t("contacts.mergeWith")}
                  </Button>
                  <div class="relative">
                    <button
                      type="button"
                      data-testid="contact-overflow-menu"
                      aria-label={i18n.t("contacts.moreActions")}
                      title={i18n.t("contacts.moreActions")}
                      aria-expanded={overflowOpen() ? "true" : "false"}
                      class="rounded-md p-1.5 text-text-tertiary hover:bg-surface-hover hover:text-text"
                      onClick={() => setOverflowOpen((v) => !v)}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    <Show when={overflowOpen()}>
                      <div class="absolute right-0 z-10 mt-1 min-w-44 overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-popover">
                        <button
                          type="button"
                          data-testid="contact-delete"
                          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-danger/10"
                          onClick={() => {
                            setConfirmingDelete(true)
                            setOverflowOpen(false)
                          }}
                        >
                          <Trash2 size={13} />
                          {i18n.t("contacts.deleteContact")}
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              </header>

              {/* ── Inline delete confirmation strip ─────────────── */}
              <Show when={confirmingDelete()}>
                <div
                  class="mt-6 flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px]"
                  data-testid="contact-delete-confirmation"
                >
                  <span class="text-text-secondary">
                    {i18n.t("contacts.deleteThisContactPermanently")}
                  </span>
                  <div class="flex items-center gap-2">
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
                      data-testid="contact-delete-confirm"
                      onClick={() => void performDelete()}
                    >
                      {i18n.t("kernel.common.delete")}
                    </Button>
                  </div>
                </div>
              </Show>

              {/* ── Identity strip: inline editable chips ────────── */}
              <section class="mt-10" data-testid="contact-detail-fields">
                <SectionHeading
                  eyebrow={i18n.t("contacts.eyebrowIdentity")}
                  hint={i18n.t("contacts.clickAnyFieldToEdit")}
                />
                <div
                  class={`mt-4 grid grid-cols-1 gap-y-1.5 sm:grid-cols-[120px_1fr] ${phone() ? "rounded-lg border border-border px-3 py-2" : ""}`}
                >
                  <InlineField
                    label={i18n.t("contacts.fieldName")}
                    testId="contact-name-input"
                    value={contact()?.name ?? ""}
                    placeholder={i18n.t("contacts.addAName")}
                    onCommit={(value) => void updateContact(api, props.entityId, { name: value })}
                  />
                  <ReadOnlyRow
                    label={i18n.t("contacts.fieldEmail")}
                    value={contact()?.email}
                    mono
                    empty="-"
                  />
                  <InlineField
                    label={i18n.t("contacts.fieldPhone")}
                    testId="contact-phone-input"
                    value={contact()?.phone ?? ""}
                    placeholder={i18n.t("contacts.addAPhone")}
                    onCommit={(value) => void updateContact(api, props.entityId, { phone: value })}
                  />
                  <Show
                    when={linkedCompany()}
                    fallback={
                      <InlineField
                        label={i18n.t("contacts.fieldCompany")}
                        testId="contact-company-input"
                        value={contact()?.company ?? ""}
                        placeholder={i18n.t("contacts.addACompany")}
                        onCommit={(value) =>
                          void updateContact(api, props.entityId, { company: value })
                        }
                      />
                    }
                  >
                    {(company) => (
                      <>
                        <div class="pt-1.5 text-[11.5px] uppercase tracking-wide text-text-tertiary">
                          {i18n.t("contacts.fieldCompany")}
                        </div>
                        <div
                          data-testid="contact-company"
                          class="flex min-w-0 flex-wrap items-baseline gap-x-3 py-1.5 text-[13px]"
                        >
                          <button
                            type="button"
                            data-testid="contact-company-link"
                            class="inline-flex items-center gap-1.5 text-accent underline-offset-2 hover:underline"
                            onClick={() => openCompanyTab(company().id, company().name)}
                          >
                            <Building2 size={14} aria-hidden="true" />
                            {company().name}
                          </button>
                          <span data-testid="contact-company-line" class="text-text-tertiary">
                            {companyLine(company())}
                          </span>
                        </div>
                      </>
                    )}
                  </Show>
                  <div class="pt-1.5 text-[11.5px] uppercase tracking-wide text-text-tertiary">
                    {i18n.t("contacts.followUps.label")}
                  </div>
                  <div class="min-w-0 py-1.5 text-[13px]" data-testid="contact-follow-ups">
                    <p data-testid="contact-follow-ups-state" data-state={followUps().state}>
                      {followUps().headline}
                    </p>
                    <Show when={followUps().detail}>
                      <p
                        data-testid="contact-follow-ups-detail"
                        class="mt-0.5 text-[12px] text-text-tertiary"
                      >
                        {followUps().detail}
                      </p>
                    </Show>
                  </div>
                </div>
              </section>

              {/* ── Addresses: the contact's address book ───────── */}
              <ContactAddresses contactId={props.entityId} />

              {/* ── Activity: only what involves this person, read from each app
                  as the reader. Without the companies scope the page has no
                  timeline (there is no older list behind it). ───────────── */}
              <Show when={canSeeTimeline()}>
                <section class="mt-12" data-testid="contact-detail.timeline">
                  <ActivityPanel
                    path={`/contacts/${props.entityId}/activity`}
                    testId="contact-activity"
                    title={i18n.t("contacts.eyebrowActivity")}
                    emptyText={i18n.t("contacts.activity.emptyContact")}
                  />
                  <Show when={linkedCompany()}>
                    <p
                      data-testid="contact-activity.scope-note"
                      class="mt-4 text-[12px] text-text-tertiary"
                    >
                      {i18n.t("contacts.activity.onlyThisPerson", {
                        name: contactDisplayName(contact()),
                        company: linkedCompany()?.name ?? "",
                      })}
                    </p>
                  </Show>
                </section>
              </Show>

              {/* Phase 17 (B10) — extension point: panels contributed by other
                apps (Invoicing's Documents panel, etc.) mount here, gated by
                server-side visibility_scope. Nothing renders when no apps
                contribute panels or the user lacks the required scopes. */}
              <SlotPanels slot="contact_detail" entityId={props.entityId} />
            </div>
          </div>

          {/* The contact's discussion, a fixed right rail laid out as a chat
              where both fit (its messages scroll above a box pinned at the
              rail's bottom), else after the details. Who reads and writes it
              is whoever sees the contact. */}
          <aside
            data-testid="contact-detail.discussion-pane"
            style={{ "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD }}
            class="border-t border-border-subtle bg-surface/30 px-4 pt-6 @[600px]:px-5 @[860px]:flex @[860px]:min-h-0 @[860px]:w-[380px] @[860px]:flex-col @[860px]:overflow-hidden @[860px]:border-t-0 @[860px]:border-l"
          >
            <section
              data-testid="contact-detail.discussion"
              class="flex min-h-0 flex-col gap-3 @[860px]:flex-1"
            >
              <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t("contacts.discussion")}
              </h3>
              <Show
                when={discussionId()}
                fallback={
                  <Show when={discussionFailed()}>
                    <p
                      data-testid="contact-discussion.unavailable"
                      class="py-2 text-[12.5px] text-text-tertiary"
                    >
                      {i18n.t("contacts.discussionUnavailable")}
                    </p>
                  </Show>
                }
              >
                {(threadId) => (
                  <div data-testid="contact-detail.thread" class="flex min-h-0 flex-1 flex-col">
                    <Suspense>
                      <EntityDiscussion
                        threadId={threadId()}
                        testId="contact-discussion"
                        emptyText={i18n.t("contacts.discussionEmpty")}
                        placeholder={i18n.t("contacts.discussionPlaceholder", {
                          name: contactDisplayName(contact() ?? {}),
                        })}
                        sendLabel={i18n.t("contacts.discussionSend")}
                      />
                    </Suspense>
                  </div>
                )}
              </Show>
            </section>
          </aside>
        </div>

        <ContactMergeDialog />
        <ContactShareDialog
          contactId={props.entityId}
          contactName={contactDisplayName(contact() ?? {})}
          open={shareOpen()}
          onOpenChange={setShareOpen}
          onSaved={() => void loadContact(api, props.entityId).catch(() => {})}
        />
      </Show>
    </div>
  )
}

// ── Section heading ────────────────────────────────────────────────

const SectionHeading: Component<{ eyebrow: string; hint?: string }> = (props) => (
  <div class="flex items-baseline justify-between gap-3 border-b border-border-subtle pb-2">
    <h2 class="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
      {props.eyebrow}
    </h2>
    <Show when={props.hint}>
      <span class="text-[10.5px] text-text-tertiary/70">{props.hint}</span>
    </Show>
  </div>
)

// ── Read-only row (for fields like Email that are immutable here) ──

const ReadOnlyRow: Component<{
  label: string
  value?: string | null
  mono?: boolean
  empty?: string
}> = (props) => (
  <>
    <div class="pt-1.5 text-[11.5px] uppercase tracking-wide text-text-tertiary">{props.label}</div>
    <div
      class={cn(
        "min-w-0 truncate py-1.5 text-[13px] text-text",
        props.mono && "font-mono text-[12.5px] text-text-secondary",
        !props.value && "text-text-tertiary",
      )}
    >
      {props.value ?? props.empty ?? "-"}
    </div>
  </>
)

// ── Inline editable field ─────────────────────────────────────────
// Click to edit; Esc cancels; Enter or blur commits.

const InlineField: Component<{
  label: string
  value: string
  testId?: string
  placeholder?: string
  onCommit: (value: string) => void
}> = (props) => {
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(props.value)
  let inputRef!: HTMLInputElement

  function start(): void {
    setDraft(props.value)
    setEditing(true)
    queueMicrotask(() => {
      inputRef?.focus()
      inputRef?.select()
    })
  }

  function cancel(): void {
    setEditing(false)
    setDraft(props.value)
  }

  function commit(): void {
    const next = draft().trim()
    if (next !== (props.value ?? "")) props.onCommit(next)
    setEditing(false)
  }

  return (
    <>
      <div class="pt-1.5 text-[11.5px] uppercase tracking-wide text-text-tertiary">
        {props.label}
      </div>
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            data-testid={props.testId}
            class={cn(
              "group flex min-w-0 items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-[13px] text-text transition-colors hover:bg-surface-hover",
              !props.value && "text-text-tertiary",
            )}
            onClick={() => start()}
          >
            <span class="truncate">{props.value || props.placeholder || "-"}</span>
            <span class="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              <Pencil size={11} class="text-text-tertiary" />
            </span>
          </button>
        }
      >
        <div class="flex items-center gap-1.5 py-1">
          <input
            ref={inputRef!}
            data-testid={props.testId}
            class="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus:border-accent-muted"
            value={draft()}
            placeholder={props.placeholder}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commit()
              } else if (event.key === "Escape") {
                event.preventDefault()
                cancel()
              }
            }}
            onBlur={() => commit()}
          />
          <button
            type="button"
            aria-label={i18n.t("contacts.cancel")}
            class="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text"
            // mousedown so the input's onBlur->commit doesn't race the click
            onMouseDown={(event) => {
              event.preventDefault()
              cancel()
            }}
          >
            <X size={12} />
          </button>
          <button
            type="button"
            aria-label={i18n.t("contacts.save")}
            class="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text"
            onMouseDown={(event) => {
              event.preventDefault()
              commit()
            }}
          >
            <Check size={12} />
          </button>
        </div>
      </Show>
    </>
  )
}

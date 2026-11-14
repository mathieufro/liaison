// SPDX-License-Identifier: FSL-1.1-ALv2
//
// InvoicingSidebar — per-app navigation rail for the Invoicing bundled app.
// Mounts inside the kernel's sidebar shell when any Invoicing-owned tab is
// active (declared on every `views.tabTypes.<type>.sidebar` entry of the
// manifest).
//
// Structure (unified-documents redesign):
//   ─── Documents ─── (All, Invoices, Quotes, Proformas, Purchase Orders)
//        the primary view — a filterable table with a Group-by switch that
//        absorbed the former per-customer / per-market sales dashboards.
//   ─── Views ─── (Awaiting payment) — a focused payment worklist; a question
//        grouping the Documents table can't answer.
//   ─── Queue ─── Pending Approval (N badge); Deferred (sticky when > 0)
//   ─── Admin ─── E-invoicing readiness (settings live in the Settings app)
//
// The "+ New quote ▼" CTA sits at the top-right with a dropdown that
// switches the create-action between quote/proforma/PO. Invoices and credit
// notes are never started by hand: they come from orders and from refunds.
//
// Pending-Approval data source (F1 compliance note). The badge count
// reads from the **app's own** `invoicing:pending_approvals.list` tool
// (see reads.ts, E5), scoped to the current org and filtered server-side
// to `tool_name LIKE 'invoicing:%'`. It does NOT call the kernel's
// approvals service directly — keeping the sidebar's count identical to
// the count the kernel exposes to the agent in the same view. Deferred
// count is read from `invoicing:deferred.list` (a thin sibling read tool
// that returns rows from `app_invoicing.deferred_events` with
// `status != 'permanent_failure'`).
//
// Design language mirrors ShopifySidebar: small uppercase eyebrow, column
// of section links with 2px accent rail on the active row, icons inline
// (14px stroked SVGs, no lucide dep).

import { app, currentPath, navigate } from "@liaison/host"
import {
  type Component,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { loadViewerAccess, NO_ACCESS, type ViewerAccess } from "./access"
import { tr } from "./i18n"
import { documentSearch, documentsSearchTarget, setDocumentSearch } from "./search-store"

// ─────────────────────────────────────────────────────────────────────────
// URL reactivity (same pattern as ShopifySidebar — bundled plugins cannot
// import `@solidjs/router`; the kernel pushes via history.pushState and we
// monkey-patch once to fan a custom nav event).
// ─────────────────────────────────────────────────────────────────────────
const NAV_EVENT = "liaison:invoicing-sidebar:nav"
/** This app's page in Settings (issuer profiles, numbering, defaults). */
export const SETTINGS_PATH = "/settings/apps/invoicing"
let patched = false
function installHistoryPatch(): void {
  if (patched) return
  patched = true
  // biome-ignore lint/suspicious/noExplicitAny: window patching
  const w = window as any
  const origPush = w.history.pushState.bind(w.history)
  const origReplace = w.history.replaceState.bind(w.history)
  w.history.pushState = (...args: unknown[]) => {
    const r = origPush(...args)
    w.dispatchEvent(new Event(NAV_EVENT))
    return r
  }
  w.history.replaceState = (...args: unknown[]) => {
    const r = origReplace(...args)
    w.dispatchEvent(new Event(NAV_EVENT))
    return r
  }
}

function usePathname() {
  const [path, setPath] = createSignal(currentPath().replace(/\?.*$/, ""))
  onMount(() => {
    installHistoryPatch()
    const onChange = () => setPath(currentPath().replace(/\?.*$/, ""))
    window.addEventListener("popstate", onChange)
    window.addEventListener(NAV_EVENT, onChange)
    onCleanup(() => {
      window.removeEventListener("popstate", onChange)
      window.removeEventListener(NAV_EVENT, onChange)
    })
  })
  return path
}

// ─────────────────────────────────────────────────────────────────────────
// Inline icons — 14px box, stroke 1.5, currentColor. Matches the kernel's
// lucide icon visual weight without adding a runtime dep to the bundle.
// ─────────────────────────────────────────────────────────────────────────
type IconProps = { class?: string }
const baseSvg = "h-3.5 w-3.5 shrink-0"

function ChartIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  )
}

function FileIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function ClockIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function AlertIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4M12 17h.01M10.3 3.86l-8.05 14a2 2 0 0 0 1.74 3h16.08a2 2 0 0 0 1.74-3l-8.05-14a2 2 0 0 0-3.46 0z" />
    </svg>
  )
}

function GearIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 9 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Nav rows.
// ─────────────────────────────────────────────────────────────────────────
interface NavLink {
  href: string
  label: string
  icon?: (p: IconProps) => JSX.Element
}

// Documents is the primary view — the unified, filterable, group-able table.
// The `:typeFilter` segment scopes it to a document type.
const DOCUMENTS: NavLink[] = [
  { href: "/invoicing/documents/all", label: "All" },
  { href: "/invoicing/documents/invoices", label: "Invoices" },
  { href: "/invoicing/documents/quotes", label: "Quotes" },
  { href: "/invoicing/documents/proformas", label: "Proformas" },
  { href: "/invoicing/documents/purchase-orders", label: "Purchase Orders" },
  { href: "/invoicing/documents/credit-notes", label: "Credit notes" },
  // Supplier e-invoices received through the e-invoicing platform (not documents this app issued).
  { href: "/invoicing/received", label: "Received" },
]

// Focused operational views. Awaiting payment is a payment worklist
// (overdue-sorted) — a genuinely different question from "list my documents".
// There is no separate customs/export view: export documents are just invoices
// that carry extra fields (HS codes, country of origin, incoterm), shown inside
// the document itself (detail + editor), not split into their own surface.
// Recurring invoicing: the schedules, with how many bill.
const RECURRING: NavLink[] = [{ href: "/invoicing/recurring", label: "Schedules" }]

const FOCUSED_VIEWS: NavLink[] = [
  { href: "/invoicing/dashboards/awaiting-payment", label: "Awaiting payment" },
]

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

// ─────────────────────────────────────────────────────────────────────────
// Counts loader.
//
// Pulls badge counts from the app's own tools. The Pending-Approval count
// MUST go through `invoicing:pending_approvals.list` (the same tool the
// agent calls) — see file-level docstring. The Deferred count goes through
// `invoicing:deferred.list`, filtered to status != 'permanent_failure'.
// ─────────────────────────────────────────────────────────────────────────
type PendingApprovalRow = { id: string; tool_name?: string }
type DeferredRow = { id: string; status: string }

async function loadCounts(): Promise<{ pendingApproval: number; deferred: number }> {
  try {
    const [pending, deferred] = await Promise.all([
      app.invokeTool<{ items: PendingApprovalRow[] }>("pending_approvals_list", {}),
      app
        .invokeTool<{ items: DeferredRow[] }>("deferred_list", {})
        .catch(() => ({ items: [] as DeferredRow[] })),
    ])
    const pendingCount = pending?.items?.length ?? 0
    const deferredCount = (deferred?.items ?? []).filter(
      (r) => r.status !== "permanent_failure",
    ).length
    return { pendingApproval: pendingCount, deferred: deferredCount }
  } catch {
    return { pendingApproval: 0, deferred: 0 }
  }
}

/** Schedules that bill (active), through the app's own recurring_list, the same the agent reads. */
async function loadScheduleCount(): Promise<number> {
  try {
    const r = await app.invokeTool<{ rows?: unknown[] }>("recurring_list", {
      status: "active",
      limit: 200,
    })
    return r?.rows?.length ?? 0
  } catch {
    return 0
  }
}

// ─────────────────────────────────────────────────────────────────────────
// + New quote ▼ dropdown.
// Only quote / proforma / purchase order can be started by hand. Invoices
// come from orders (the Shopify auto-flow) or from converting a quote or a
// proforma; credit notes come from refunds. Neither is offered here.
// ─────────────────────────────────────────────────────────────────────────
export type NewDocType = "quote" | "proforma" | "purchase_order"
export const NEW_DOC_TYPES: readonly NewDocType[] = ["quote", "proforma", "purchase_order"]
const TYPE_LABEL: Record<NewDocType, string> = {
  quote: "New quote",
  proforma: "New proforma",
  purchase_order: "New purchase order",
}

function NewDocCta() {
  const [type, setType] = createSignal<NewDocType>("quote")
  const [open, setOpen] = createSignal(false)
  const onPick = (t: NewDocType) => {
    setType(t)
    setOpen(false)
    // The type is encoded IN the entityId segment (`new:quote`) rather than a
    // `?type=` query param — MainPanel/the tab router only ever forwards the
    // `entityId` path segment to the tab's component (`<Dynamic entityId=.../>`),
    // never the query string, so `?type=` was silently dropped and the editor
    // fell back to reading `window.location.search` directly. Under keep-alive
    // tab rendering that reads whichever tab's URL happens to be current in
    // the address bar, not necessarily the one being opened/rendered — a
    // classic wrong-tab-URL bug. `navigate`, never `location.assign`: framed,
    // the window is the frame's, and sending it elsewhere stops the app.
    navigate(`/invoicing/editor/new:${t}`)
  }
  return (
    <div class="relative flex">
      <a
        href={`/invoicing/editor/new:${type()}`}
        data-testid="invoicing-sidebar-new-cta"
        class="flex-1 rounded-l-md border border-border-subtle bg-surface px-3 py-1.5 text-[12px] font-medium text-text hover:bg-surface-hover"
      >
        + {tr(TYPE_LABEL[type()])}
      </a>
      <button
        type="button"
        data-testid="invoicing-sidebar-new-cta-toggle"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        class="rounded-r-md border border-l-0 border-border-subtle bg-surface px-2 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text"
      >
        ▼
      </button>
      <Show when={open()}>
        <ul
          data-testid="invoicing-sidebar-new-cta-menu"
          class="absolute right-0 top-full z-10 mt-1 min-w-[170px] rounded-md border border-border-subtle bg-surface shadow-md"
        >
          {NEW_DOC_TYPES.map((t) => (
            <li>
              <button
                type="button"
                data-testid={`invoicing-sidebar-new-cta-menu-${t}`}
                onClick={() => onPick(t)}
                class="block w-full px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-hover"
              >
                {tr(TYPE_LABEL[t])}
              </button>
            </li>
          ))}
        </ul>
      </Show>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Section header — small uppercase eyebrow above each block.
// ─────────────────────────────────────────────────────────────────────────
function SectionHeader(p: { label: string; icon?: (ip: IconProps) => JSX.Element }) {
  return (
    <div class="mt-3 flex items-center gap-2 px-3 pb-1 text-[10.5px] uppercase tracking-wider text-text-tertiary">
      {p.icon ? <p.icon /> : null}
      <span>{tr(p.label)}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Row — single nav link.
// ─────────────────────────────────────────────────────────────────────────
function Row(p: { href: string; label: string; pathname: string; badge?: number }) {
  const active = () => isActive(p.pathname, p.href)
  return (
    <li>
      <a
        href={p.href}
        data-testid={`invoicing-sidebar-link-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
        aria-current={active() ? "page" : undefined}
        class={`flex items-center gap-2 rounded-md px-3 py-1 text-[12.5px] transition-colors ${
          active()
            ? "bg-surface-active font-medium text-text"
            : "text-text-secondary hover:bg-surface-hover hover:text-text"
        }`}
      >
        <span class="flex-1 truncate">{tr(p.label)}</span>
        <Show when={typeof p.badge === "number" && p.badge > 0}>
          <span
            data-testid={`invoicing-sidebar-badge-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
            class="rounded bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-text-secondary"
          >
            {p.badge}
          </span>
        </Show>
      </a>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// InvoicingSidebar — exposed via every Invoicing tabType's `sidebar` field
// in app.manifest.json#views.tabTypes.
// ─────────────────────────────────────────────────────────────────────────
export const InvoicingSidebar: Component = () => {
  const pathname = usePathname()
  const [pendingApproval, setPendingApproval] = createSignal(0)
  const [deferredCount, setDeferredCount] = createSignal(0)
  const [scheduleCount, setScheduleCount] = createSignal(0)
  // Writes (a new document, the approval queue, the readiness fixes) are offered
  // only to a viewer holding invoicing:documents:write; a read-only member sees
  // the documents and nothing it would be refused.
  const [access, setAccess] = createSignal<ViewerAccess>(NO_ACCESS)
  const canWrite = () => access().documents_write
  // The approval queue is for whoever can decide in it: a writer, or a holder of the approver scope.
  const canDecide = () => access().documents_write || access().approve

  // Initial fetch + re-fetch on nav events (badges should reflect the
  // freshest count when the user switches tabs).
  const refresh = async () => {
    const { pendingApproval: p, deferred: d } = await loadCounts()
    setPendingApproval(p)
    setDeferredCount(d)
    setScheduleCount(await loadScheduleCount())
  }
  onMount(() => {
    void refresh()
    void loadViewerAccess().then(setAccess)
    const onNav = () => {
      void refresh()
    }
    window.addEventListener(NAV_EVENT, onNav)
    onCleanup(() => window.removeEventListener(NAV_EVENT, onNav))
  })

  // Track pathname re-renders for tests that drive history.pushState.
  createEffect(() => {
    void pathname()
  })

  return (
    <nav data-testid="invoicing-sidebar" class="flex h-full min-h-0 flex-col">
      {/* Eyebrow: app identity + the "+ New quote ▼" CTA */}
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span class="text-[12.5px] font-semibold text-text">{tr("Invoicing")}</span>
        </div>
        <Show when={canWrite()}>
          <NewDocCta />
        </Show>
      </div>

      {/* Search — drives the documents-table filter via the shared signal.
          Typing filters live when a documents tab is already open; pressing
          Enter opens the documents list at `?q=` (the list on view, else All
          documents), so the results are visible, framed as well. */}
      <div class="border-b border-border-subtle px-3 py-2">
        <input
          type="search"
          placeholder={tr("Search documents...")}
          value={documentSearch()}
          onInput={(e) => setDocumentSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            // The search goes in the route too: framed, the documents list is
            // another frame that this module's signal never reaches.
            if (e.key !== "Enter") return
            const target = documentsSearchTarget(currentPath(), documentSearch())
            if (target !== currentPath()) navigate(target)
          }}
          data-testid="invoicing-sidebar-search"
          class="w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12.5px] text-text placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      {/* Sections */}
      <div class="flex-1 overflow-y-auto px-2 pb-3">
        <SectionHeader label={tr("Documents")} icon={FileIcon} />
        <ul class="flex flex-col gap-0.5">
          {DOCUMENTS.map((l) => (
            <Row href={l.href} label={l.label} pathname={pathname()} />
          ))}
        </ul>

        <SectionHeader label={tr("Recurring")} icon={ClockIcon} />
        <ul class="flex flex-col gap-0.5">
          {RECURRING.map((l) => (
            <Row href={l.href} label={l.label} pathname={pathname()} badge={scheduleCount()} />
          ))}
        </ul>

        <SectionHeader label={tr("Views")} icon={ChartIcon} />
        <ul class="flex flex-col gap-0.5">
          {FOCUSED_VIEWS.map((l) => (
            <Row href={l.href} label={l.label} pathname={pathname()} />
          ))}
        </ul>

        <Show when={canDecide() || deferredCount() > 0}>
          <SectionHeader label={tr("Queue")} icon={ClockIcon} />
          <ul class="flex flex-col gap-0.5">
            <Show when={canDecide()}>
              <Row
                href="/invoicing/pending-approval"
                label={tr("Pending Approval")}
                pathname={pathname()}
                badge={pendingApproval()}
              />
            </Show>
            {/* Deferred row is hidden when count is 0; sticky-visible when > 0
              per spec §"Visual Structure". */}
            <Show when={deferredCount() > 0}>
              <Row
                href="/invoicing/deferred"
                label={tr("Deferred")}
                pathname={pathname()}
                badge={deferredCount()}
              />
            </Show>
          </ul>
        </Show>

        <Show when={canWrite()}>
          <SectionHeader label={tr("Admin")} icon={AlertIcon} />
          <ul class="flex flex-col gap-0.5">
            <Row
              href="/invoicing/readiness"
              label={tr("E-invoicing readiness")}
              pathname={pathname()}
            />
          </ul>
        </Show>
      </div>

      {/* Footer: the app's settings page (issuer profiles, numbering) for a viewer who may read
          them; for anyone else a plain name, with no gear that looks like a link. */}
      <div class="mt-auto border-t border-border-subtle px-4 py-2">
        <Show
          when={access().settings_read}
          fallback={
            <div class="text-[10.5px] text-text-tertiary">
              {/* No version number: a fixed one went stale as the app moved on. */}
              <span>{tr("Invoicing")}</span>
            </div>
          }
        >
          <button
            type="button"
            data-testid="invoicing-sidebar-settings"
            class="flex items-center gap-1.5 text-[10.5px] text-text-tertiary hover:text-text-secondary"
            onClick={() => navigate(SETTINGS_PATH)}
          >
            <GearIcon />
            <span>{tr("Invoicing settings")}</span>
          </button>
        </Show>
      </div>
    </nav>
  )
}

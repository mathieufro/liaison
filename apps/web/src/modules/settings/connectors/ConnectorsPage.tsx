// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings > Connectors (`/settings/connectors`, S11, S16, D12, prototype
// S-CONNECTORS). Connectors (`kind: "connector"` apps) have no sidebar entry
// of their own: each gets a card here, for a viewer who can change at least
// one of its sections. One card is open at a time and `?open=<app>` opens
// it; an open card holds that app's settings sections with the same blocks as
// an app page. Below them, for kernel:org:admin, the organization's MCP
// servers (their list with status, and the stepped add flow in place; a server
// opens at `/settings/connectors/mcp/<id>`).
//
// Apps admins also get each card's management controls (Enabled, Remove from
// this workspace, S24), and a card for a connector turned Off, which the
// manifests feed no longer carries: it says Off and opens read-only (A7).
import { useNavigate, useSearchParams } from "@solidjs/router"
import {
  type Accessor,
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import { signInToMcp } from "~/modules/mcp-manager/api"
import { McpAddFlow } from "~/modules/mcp-manager/McpAddFlow"
import { McpConnectionsList } from "~/modules/mcp-manager/McpConnectionsList"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import {
  AppManagementControls,
  AppOffNotice,
  canManageApps,
} from "../app-management/AppManagementControls"
import { orgAppPageEntry } from "../app-management/org-app-page"
import { isOrgAppOff, orgAppsStore } from "../app-management/org-apps-store"
import { AppSettingsBody } from "../app-page/AppSettingsPage"
import { appSettingsPage, appSettingsPages } from "../app-page/app-settings-pages"
import { entryLabel, visibleSections } from "../app-page/page-model"
import type { AppSettingsPageEntry } from "../app-page/types"
import { appsStore, connectionState } from "../apps-store"
import { useSettingsPageActive } from "../settings-page-active"

const P = "kernel.settingsPage.connectors"

export const CONNECTORS_HREF = "/settings/connectors"
/** Where an org MCP server's detail lives. */
export function mcpServerHref(id: string): string {
  return `${CONNECTORS_HREF}/mcp/${encodeURIComponent(id)}`
}

/** The connectors a viewer gets a card for. */
export function visibleConnectors(
  entries: AppSettingsPageEntry[],
  canAccess: (scope: string) => boolean,
): AppSettingsPageEntry[] {
  return entries
    .filter(
      (e) =>
        e.manifest.kind === "connector" &&
        visibleSections(e.manifest.settings?.sections, canAccess).length > 0,
    )
    .sort((a, b) => connectorName(a).localeCompare(connectorName(b)))
}

function connectorName(e: AppSettingsPageEntry): string {
  return e.label ?? e.manifest.displayName ?? e.manifest.name
}

export const ConnectorsPage: Component<{ active?: Accessor<boolean> }> = (props) => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams<{ open?: string }>()
  const layoutActive = useSettingsPageActive()
  const active = () => (props.active ? props.active() : layoutActive())
  const api = useApi()
  onMount(() => {
    if (canManageApps()) void orgAppsStore.ensureLoaded(api).catch(() => {})
  })
  // Connectors turned Off are absent from the manifests feed; admins keep their card.
  const offConnectors = createMemo(() =>
    canManageApps()
      ? orgAppsStore
          .apps()
          .filter(
            (a) => a.kind === "connector" && a.status === "disabled" && !appSettingsPage(a.name),
          )
          .map(orgAppPageEntry)
          .sort((a, b) => connectorName(a).localeCompare(connectorName(b)))
      : [],
  )
  // Two lists, so a change of the workspace's app list never re-creates the
  // registered cards (an open card keeps its state).
  const connectors = createMemo(() =>
    visibleConnectors(appSettingsPages(), (s) => canAccessScope(s)),
  )
  const open = () => (typeof search.open === "string" ? search.open : undefined)
  const canMcp = () => canAccessScope("kernel:org:admin")

  function toggle(app: string): void {
    setSearch({ open: open() === app ? undefined : app }, { replace: true })
  }

  return (
    <div data-testid="connectors-page">
      <div class="mb-6 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-lg font-semibold leading-tight">{i18n.t(`${P}.title`)}</h1>
          <p class="mt-1 text-[12.5px] text-text-secondary">{i18n.t(`${P}.intro`)}</p>
        </div>
        <Button
          data-testid="connectors-add"
          onClick={() => navigate("/settings/store?kind=connector")}
        >
          + {i18n.t(`${P}.add`)}
        </Button>
      </div>
      <Show
        when={connectors().length + offConnectors().length > 0}
        fallback={
          <div class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary">
            {i18n.t(`${P}.none`)}
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={connectors()}>
            {(entry) => (
              <ConnectorCard
                entry={entry}
                open={open() === entry.appId}
                active={active}
                onToggle={() => toggle(entry.appId)}
              />
            )}
          </For>
          <For each={offConnectors()}>
            {(entry) => (
              <ConnectorCard
                entry={entry}
                open={open() === entry.appId}
                active={active}
                onToggle={() => toggle(entry.appId)}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={canMcp()}>
        <McpServersBlock />
      </Show>
    </div>
  )
}

const ConnectorCard: Component<{
  entry: AppSettingsPageEntry
  open: boolean
  active: Accessor<boolean>
  onToggle: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const app = () => props.entry.appId
  const off = () => isOrgAppOff(orgAppsStore.app(app()))
  // The load starts once; the header reads the shared connections store, so a
  // connection made in the card (its Connection block reloads that store)
  // shows here at once, not after a reload of the page.
  const [loaded] = createResource(
    () => (off() ? false : app()),
    async (name) => {
      await appsStore.loadConnections(api, name)
      return true
    },
  )
  const status = () => {
    if (!loaded()) return undefined
    const states = appsStore.connectionsFor(app()).map(connectionState)
    if (states.includes("connected")) return "connected" as const
    if (states.includes("attention")) return "attention" as const
    return "missing" as const
  }
  const statusText = () => {
    if (off()) return i18n.t("kernel.appManagement.offBadge")
    switch (status()) {
      case "connected":
        return i18n.t("kernel.settingsPage.connected")
      case "attention":
        return i18n.t("kernel.settingsPage.needsReconnect")
      case "missing":
        return i18n.t("kernel.settingsPage.notConnected")
      default:
        return ""
    }
  }
  const name = () => entryLabel(i18n.t, props.entry)
  const Icon = () => props.entry.icon
  return (
    <div
      class="overflow-hidden rounded-lg border border-border bg-surface"
      data-testid={`connector-card-${app()}`}
    >
      <button
        type="button"
        class="flex min-h-12 w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-hover"
        aria-expanded={props.open}
        aria-controls={`connector-body-${app()}`}
        data-testid={`connector-toggle-${app()}`}
        onClick={() => props.onToggle()}
      >
        <span class="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md border border-border bg-bg text-text-secondary">
          <Show
            when={Icon()}
            fallback={<span class="text-xs font-semibold">{name().slice(0, 1)}</span>}
          >
            {(I) => {
              const C = I()
              return <C size={16} />
            }}
          </Show>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13.5px] font-medium">{name()}</span>
          <span
            class="block text-xs"
            classList={{
              "text-success": !off() && status() === "connected",
              "text-warning": !off() && status() === "attention",
              "text-text-tertiary": off() || status() === "missing",
            }}
            data-testid={`connector-status-${app()}`}
          >
            {statusText()}
          </span>
        </span>
        <span
          class="text-text-tertiary transition-transform"
          classList={{ "rotate-90": props.open }}
          aria-hidden="true"
        >
          ›
        </span>
      </button>
      <Show when={props.open}>
        <div
          id={`connector-body-${app()}`}
          class="border-t border-border bg-bg px-3.5 py-3"
          data-testid={`connector-body-${app()}`}
        >
          <div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-3 empty:hidden">
            <AppManagementControls appId={app()} name={name()} kind="connector" />
          </div>
          <Show when={!off()} fallback={<AppOffNotice name={name()} />}>
            <AppSettingsBody entry={props.entry} active={props.active} compact />
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** The org's MCP servers: their list, and the stepped add flow in place. */
const McpServersBlock: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const [adding, setAdding] = createSignal(false)
  async function signIn(conn: { id: string; displayName: string }): Promise<void> {
    try {
      await signInToMcp(api, conn.id, (url) => void openExternal(url))
    } catch {
      addToast({
        message: i18n.t("kernel.mcpUi.resumeOAuthFailed", { name: conn.displayName }),
        type: "error",
      })
    }
  }
  return (
    <section class="mt-9" aria-labelledby="connectors-mcp-h" data-testid="connectors-mcp">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2
            id="connectors-mcp-h"
            class="flex flex-wrap items-center gap-2 text-[15px] font-semibold leading-snug"
          >
            {i18n.t(`${P}.mcpTitle`)}
            <span class="rounded-full border border-border px-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
              {i18n.t("kernel.settingsPage.organization")}
            </span>
          </h2>
          <p class="mt-0.5 text-[12.5px] text-text-secondary">{i18n.t(`${P}.mcpDescription`)}</p>
        </div>
        <Show
          when={!adding()}
          fallback={
            <Button
              size="sm"
              variant="ghost"
              data-testid="connectors-mcp-back"
              onClick={() => setAdding(false)}
            >
              {i18n.t(`${P}.back`)}
            </Button>
          }
        >
          <Button
            size="sm"
            variant="outline"
            data-testid="connectors-mcp-add"
            onClick={() => setAdding(true)}
          >
            + {i18n.t(`${P}.mcpAdd`)}
          </Button>
        </Show>
      </div>
      <Show
        when={adding()}
        fallback={
          <McpConnectionsList
            onAdd={() => setAdding(true)}
            onSelect={(c) => navigate(mcpServerHref(c.id))}
            onSignIn={(c) => void signIn(c)}
          />
        }
      >
        <McpAddFlow
          onCancel={() => setAdding(false)}
          onDone={(created) => {
            setAdding(false)
            navigate(mcpServerHref(created.id))
          }}
        />
      </Show>
    </section>
  )
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// One app's settings page (`/settings/apps/<app>`, S13, S24, prototype
// S-APPPAGE): a header (icon, name, version, publisher, and for apps admins the
// management controls: Enabled, Who can use it, Remove), then the sections the
// viewer may see, user sections first, each saved where it is shown. An app
// turned Off shows a read-only notice instead of its sections; an Off app the
// manifests feed no longer carries keeps its page for admins, built from the
// workspace's app list. The page refetches when it becomes active again (the settings
// layout keeps visited pages mounted) and asks before leaving with unsaved
// list or tree edits (A9).
//
// `AppSettingsBody` is the sections alone, used here and in each Connectors card.
import { useBeforeLeave, useLocation } from "@solidjs/router"
import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { isFeatureOff } from "~/framework/org-features"
import { registerUnsavedWork } from "~/lib/unsaved-work"
import { AppLogsPanel, showsAppLogs } from "~/modules/app-builder/AppLogsPanel"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { useTabId } from "~/modules/shell/TabVisibilityContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import {
  AppManagementControls,
  AppOffNotice,
  canManageApps,
} from "../app-management/AppManagementControls"
import { orgAppPageEntry } from "../app-management/org-app-page"
import { isOrgAppOff, orgAppsStore } from "../app-management/org-apps-store"
import { useSettingsPageActive } from "../settings-page-active"
import { appSettingsPage } from "./app-settings-pages"
import { AppPageProvider, createAppPageState } from "./page-context"
import { createSaveQueue, entryLabel, visibleSections } from "./page-model"
import { revealSettingsSection } from "./reveal-section"
import { SectionView } from "./SectionView"
import { loadSettingsValues, type SaveOutcome, saveSetting, saveSettingsUnit } from "./settings-api"
import type { AppSettingsPageEntry, SettingsScope, SettingsSection } from "./types"

const P = "kernel.settingsPage"

/** The live frames an app names in its UI exports as changing its settings. */
export function settingsChangeEvents(exports: Record<string, unknown> | undefined): string[] {
  const named = exports?.settingsChangeEvents
  return Array.isArray(named) ? named.filter((k): k is string => typeof k === "string") : []
}

function hasFields(sections: SettingsSection[], scope: SettingsScope): boolean {
  return sections.some((s) => s.scope === scope && s.blocks.some((b) => b.block === "field"))
}

export const AppSettingsBody: Component<{
  entry: AppSettingsPageEntry
  /** The page is on screen: false → true reloads values and blocks. */
  active: Accessor<boolean>
  /** A connection whose inline form opens on arrival (`?open=`). */
  openConnection?: string
  /** A section scrolled into view, its first control focused, on arrival (`?section=`). */
  revealSection?: string
  compact?: boolean
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const state = createAppPageState()
  const app = () => props.entry.appId
  // A section equal to the one already drawn keeps its object, so the list does not redraw it:
  // an admin's page may draw from the workspace's app list before the manifests feed registers
  // the app, and the same sections arriving then must not throw away an unsaved edit.
  const sections = createMemo<SettingsSection[]>((prev) => {
    const next = visibleSections(
      props.entry.manifest.settings?.sections?.filter(
        (s) => !isFeatureOff(props.entry.manifest.name, s.feature),
      ),
      (s) => canAccessScope(s),
    )
    return next.map((s) => {
      const drawn = prev.find((p) => p.id === s.id)
      return drawn && JSON.stringify(drawn) === JSON.stringify(s) ? drawn : s
    })
  }, [])

  // Values the page saved since the last load, shown over the loaded ones.
  const [saved, setSaved] = createSignal<Record<SettingsScope, Record<string, unknown>>>({
    org: {},
    user: {},
  })
  const load = (scope: SettingsScope) =>
    createResource(
      () => (hasFields(sections(), scope) ? state.reloadToken() + 1 : false),
      () => loadSettingsValues(api, app(), scope),
    )
  const [orgValues, { refetch: refetchOrgValues }] = load("org")
  const [userValues, { refetch: refetchUserValues }] = load("user")
  const loaded = (scope: SettingsScope) => (scope === "org" ? orgValues : userValues)

  // A setting changed elsewhere (the agent's approved change in a chat, a card,
  // another tab) shows without a reload: the app names the live frames that
  // carry such changes (`settingsChangeEvents` in its UI exports, e.g. Mail's
  // `mail:provider` for the Gmail switch), and an open page re-reads its
  // values when one arrives. The fresh values replace what this page saved
  // since its last load.
  const changeEvents = settingsChangeEvents(props.entry.exports)
  if (changeEvents.length > 0) {
    onEntityChange(changeEvents, () => {
      if (!props.active()) return
      void Promise.all([refetchOrgValues(), refetchUserValues()]).then(() =>
        setSaved({ org: {}, user: {} }),
      )
    })
  }

  createEffect(
    on(
      props.active,
      (active, was) => {
        if (active && was === false) {
          setSaved({ org: {}, user: {} })
          state.bumpReload()
        }
      },
      { defer: true },
    ),
  )

  // `?section=<id>`: once the section's values are in (its controls exist),
  // bring it into view. Asked again when the parameter changes.
  createEffect(
    on(
      () => {
        const id = props.revealSection
        const section = id ? sections().find((s) => s.id === id) : undefined
        if (!section) return null
        const values = loaded(section.scope)
        return values.loading ? null : section.id
      },
      (id) => {
        if (id) requestAnimationFrame(() => revealSettingsSection(app(), id))
      },
    ),
  )

  const queues = new Map<string, ReturnType<typeof createSaveQueue>>()
  function queueFor(sectionId: string) {
    let q = queues.get(sectionId)
    if (!q) {
      q = createSaveQueue()
      queues.set(sectionId, q)
    }
    return q
  }

  function fieldValue(scope: SettingsScope, key: string): unknown {
    const mine = saved()[scope]
    if (key in mine) return mine[key]
    return loaded(scope)()?.values?.[key] ?? null
  }

  // Leaving with unsaved list/tree edits asks first.
  const [leaveRetry, setLeaveRetry] = createSignal<(() => void) | null>(null)
  try {
    useBeforeLeave((e) => {
      if (!state.dirty() || e.defaultPrevented) return
      e.preventDefault()
      setLeaveRetry(() => () => e.retry(true))
    })
  } catch {
    // Rendered outside a router: nothing to intercept.
  }
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (state.dirty()) e.preventDefault()
  }
  window.addEventListener("beforeunload", onBeforeUnload)
  onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload))
  // The desktop Reload and closing this tab with others ask first too.
  onCleanup(
    registerUnsavedWork(`app-settings:${createUniqueId()}`, {
      tabId: useTabId(),
      describe: () => (state.dirty() ? i18n.t("kernel.unsavedWork.settingsEdits") : null),
    }),
  )

  function discardAndLeave(): void {
    const retry = leaveRetry()
    setLeaveRetry(null)
    state.clearDirty()
    state.bumpReload()
    retry?.()
  }

  return (
    <AppPageProvider value={state}>
      <div data-testid={`app-settings-body-${app()}`}>
        <Show
          when={sections().length > 0}
          fallback={
            <div
              class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
              data-testid="app-settings-empty"
            >
              {i18n.t(`${P}.noSettings`)}
            </div>
          }
        >
          <For each={sections()}>
            {(section) => {
              const scope = section.scope
              return (
                <SectionView
                  app={app()}
                  section={section}
                  compact={props.compact}
                  exports={props.entry.exports}
                  openConnection={props.openConnection}
                  value={(key) => fieldValue(scope, key)}
                  readError={(key) => loaded(scope)()?.errors?.[key]}
                  save={(path, value): Promise<SaveOutcome> =>
                    queueFor(section.id)(() => saveSetting(api, app(), scope, path, value))
                  }
                  saveUnit={(values) =>
                    queueFor(section.id)(() => saveSettingsUnit(api, app(), scope, values))
                  }
                  onSaved={(path, value) =>
                    setSaved((s) => ({ ...s, [scope]: { ...s[scope], [path]: value } }))
                  }
                />
              )
            }}
          </For>
        </Show>
      </div>
      <Dialog open={leaveRetry() !== null} onOpenChange={(open) => !open && setLeaveRetry(null)}>
        <Dialog.Content>
          <div data-testid="app-settings-discard-dialog">
            <Dialog.Title>{i18n.t(`${P}.discardTitle`)}</Dialog.Title>
            <p class="mt-3 text-sm text-text-secondary">{i18n.t(`${P}.discardBody`)}</p>
            <div class="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setLeaveRetry(null)}>
                {i18n.t(`${P}.keepEditing`)}
              </Button>
              <Button
                variant="danger"
                data-testid="app-settings-discard-confirm"
                onClick={discardAndLeave}
              >
                {i18n.t(`${P}.discard`)}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog>
    </AppPageProvider>
  )
}

/** The page header: icon, name, version, publisher, and the management controls. */
export const AppSettingsHeader: Component<{
  entry: AppSettingsPageEntry
  /** The management controls (apps admins). */
  children?: JSX.Element
}> = (props) => {
  const i18n = useI18n()
  const name = () => entryLabel(i18n.t, props.entry)
  return (
    <div
      class="mb-7 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3.5"
      data-testid="app-settings-header"
    >
      <span class="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md border border-border bg-bg text-text-secondary">
        <Show
          when={props.entry.icon}
          fallback={<span class="text-sm font-semibold">{name().slice(0, 1).toUpperCase()}</span>}
        >
          {(Icon) => {
            const I = Icon()
            return <I size={20} />
          }}
        </Show>
      </span>
      <div class="min-w-[150px] flex-1">
        <div class="flex flex-wrap items-baseline gap-2 text-[15px] font-semibold">
          <span data-testid="app-settings-name">{name()}</span>
          <Show when={props.entry.manifest.version}>
            <span
              class="font-mono text-xs font-normal text-text-tertiary"
              data-testid="app-settings-version"
            >
              v{props.entry.manifest.version}
            </span>
          </Show>
        </div>
        <Show when={props.entry.manifest.author}>
          <div class="text-[11px] text-text-secondary" data-testid="app-settings-publisher">
            {i18n.t(`${P}.byPublisher`, { publisher: props.entry.manifest.author ?? "" })}
          </div>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

/**
 * The settings page of `appId`. It knows it is on screen from the settings
 * layout's keep-alive hook (`useSettingsPageActive`); `active` overrides that.
 */
export const AppSettingsPage: Component<{ appId: string; active?: Accessor<boolean> }> = (
  props,
) => {
  const i18n = useI18n()
  const location = useLocation()
  const layoutActive = useSettingsPageActive()
  const active = () => (props.active ? props.active() : layoutActive())
  // An Off app is absent from the manifests feed: admins keep its page from
  // the workspace's app list.
  const orgApp = () => orgAppsStore.app(props.appId)
  const entry = () => {
    const registered = appSettingsPage(props.appId)
    if (registered) return registered
    const a = orgApp()
    return a && canManageApps() && a.status !== "removed" ? orgAppPageEntry(a) : undefined
  }
  const off = () => isOrgAppOff(orgApp())
  const pageApi = useApi()
  onMount(() => {
    if (canManageApps()) void orgAppsStore.ensureLoaded(pageApi).catch(() => {})
  })
  const openConnection = () => new URLSearchParams(location.search).get("open") ?? undefined
  const revealSection = () => new URLSearchParams(location.search).get("section") ?? undefined
  return (
    <div data-testid={`app-settings-page-${props.appId}`}>
      <Show
        when={entry()}
        fallback={
          <div
            class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
            data-testid="app-settings-missing"
          >
            {i18n.t(`${P}.appUnavailable`)}
          </div>
        }
      >
        {(e) => (
          <>
            <div class="mb-6">
              <h1 class="text-lg font-semibold leading-tight">{entryLabel(i18n.t, e())}</h1>
            </div>
            <AppSettingsHeader entry={e()}>
              <AppManagementControls
                appId={props.appId}
                name={entryLabel(i18n.t, e())}
                kind={e().manifest.kind === "connector" ? "connector" : "app"}
              />
            </AppSettingsHeader>
            <Show when={!off()} fallback={<AppOffNotice name={entryLabel(i18n.t, e())} />}>
              <AppSettingsBody
                entry={e()}
                active={active}
                openConnection={openConnection()}
                revealSection={revealSection()}
              />
            </Show>
            <Show when={showsAppLogs(props.appId)}>
              <AppLogsPanel app={props.appId} />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

export default AppSettingsPage

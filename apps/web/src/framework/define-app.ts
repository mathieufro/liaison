// SPDX-License-Identifier: FSL-1.1-ALv2
import type {
  AppKind,
  AppSettingsSchema,
  SettingsSection as AppSettingsSection,
} from "@liaison/app-sdk"
import {
  englishDictionaries,
  manifestTabUrlPatterns,
  type TabRouteOwner,
  tabRouteRefusal,
} from "@liaison/shared"
import { batch, type Component, createComponent, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  appRouteSlug,
  type BulkFieldSpec,
  type BulkUiCustomForm,
  type BulkUiSelection,
  type CommandRegistration,
  type ContributionEntry,
  getTabTypes,
  type KeyBinding,
  type ManifestAppData,
  type ManifestBulkAction,
  namespaceRegistryKey,
  registerActivityBarEntry,
  registerAppRoutes,
  registerBulkUiCustomForm,
  registerBulkUiSelection,
  registerCommand,
  registerConnectorApp,
  registerContribution,
  registerEntityExternalLink,
  registerKeybinding,
  registerManifestAppData,
  registerPanel,
  registerPhoneHeader,
  registerPhoneTopBarHidden,
  registerSavedViewsHandler,
  registerSettingsSection,
  registerSlot,
  registerTabType,
  registerWsEntityHandler,
  registerWsMessageHandler,
  type SavedViewsHandler,
  type SettingsPageSectionAccess,
  type SettingsSection,
  type SlotDeclaration,
  type TabTypeRegistration,
  unregisterActivityBarEntry,
  unregisterAppRoutes,
  unregisterBulkUi,
  unregisterCommand,
  unregisterConnectorApp,
  unregisterContributions,
  unregisterEntityExternalLinks,
  unregisterKeybinding,
  unregisterManifestAppData,
  unregisterPanels,
  unregisterPhoneHeader,
  unregisterSavedViewsHandlers,
  unregisterSettingsSections,
  unregisterSlot,
  unregisterTabType,
  unregisterWsEntityHandlers,
  unregisterWsMessageHandlers,
  type WsEntityHandler,
  type WsEntityHandlerRegistration,
  type WsMessageHandler,
  type WsMessageHandlerRegistration,
} from "~/framework/app-registry"
import { declaresAppIcon, iconNames, isolatedAppIcon } from "~/framework/isolated-app"

type RealtimeRegistration<THandler, TRegistration extends { handler: THandler }> =
  | THandler
  | TRegistration
  | Array<THandler | TRegistration>

type ExplicitWsHandlerRegistration = {
  __explicitKey: string
  handler: RealtimeRegistration<WsEntityHandler, WsEntityHandlerRegistration>
}

export interface AppDefinition {
  name: string
  tabTypes?: Record<string, TabTypeRegistration>
  activityBar?: {
    icon: Component<{ size?: number }>
    label: string
    /** Catalog key for the label a reader sees; see `ActivityBarEntry`. */
    labelKey?: string
    order: number
    position?: "top" | "bottom"
    /** See `ActivityBarEntry.external` — set for installed app bundles. */
    external?: boolean
    tabAction?: { type: string; entityId: string; label: string }
  }
  /** Extra bare routes that open this app at its default page, on top of the
   *  app's own name and the slug of its rail label. */
  routes?: string[]
  settings?: (Omit<SettingsSection, "id"> & { id?: string })[]
  commands?: CommandRegistration[]
  wsHandlers?: Record<
    string,
    | RealtimeRegistration<WsEntityHandler, WsEntityHandlerRegistration>
    | ExplicitWsHandlerRegistration
  >
  wsMessages?: Record<string, RealtimeRegistration<WsMessageHandler, WsMessageHandlerRegistration>>
  keybindings?: KeyBinding[]
  slots?: Record<string, SlotDeclaration>
  contributions?: Record<string, Omit<ContributionEntry, "appId">>
  panels?: Record<
    string,
    {
      component: Component<{ context?: unknown }>
      icon?: Component<{ size?: number }>
      label: string
    }
  >
  /** Entities whose `views.detail.<entity>` declares an external deep link,
   *  keyed by entity name. Presence signals `openEntity` to resolve an external
   *  URL for component-less "external-only" entities (e.g. a Shopify order). */
  entityExternalLinks?: Record<string, { label?: string }>
  saveable?: string[]
  savedViews?: Record<string, SavedViewsHandler>
  bulkUi?: {
    selection: Record<string, BulkUiSelection>
    customForms?: Record<string, BulkUiCustomForm>
  }
}

// Track registered app primitives for unregister.
// Only indexes types that need individual ID tracking for teardown (tabTypes,
// keybindingIds, commandIds, slotIds, panelIds). Activity bar entries, settings sections,
// contributions, attention providers, and WS handlers are torn down via
// bulk-unregister by appId in the registry — no per-ID tracking needed here.
const [appIndex, setAppIndex] = createStore<
  Record<
    string,
    {
      tabTypes: string[]
      keybindingIds: string[]
      commandIds: string[]
      slotIds: string[]
      panelIds: string[]
      // Runtime-attached phone headers (`registerAppPhoneHeader` /
      // `registerAppPhoneTopBarHidden`), tracked separately because they are
      // registered OUTSIDE `registerApp()` — typically from a manifest app's
      // `registerAppHooks()`, called once right after its manifest registers.
      // Carried forward across an idempotent `registerApp()` refresh (that
      // path never re-runs `registerAppHooks()` for an already-registered
      // app), cleared only on `unregisterApp()`.
      phoneHeaderTypes: string[]
    }
  >
>({})

function asRealtimeRegistrations<THandler, TRegistration extends { handler: THandler }>(
  value: RealtimeRegistration<THandler, TRegistration>,
): TRegistration[] {
  const entries = Array.isArray(value) ? value : [value]
  return entries.map((entry) =>
    typeof entry === "function" ? ({ handler: entry } as TRegistration) : entry,
  ) as TRegistration[]
}

export function registerApp(def: AppDefinition): void {
  // Atomic registration: without batch(), every registerTabType() bumps the
  // registry version signal and Shell's URL->tab effect runs synchronously
  // BETWEEN tab types. A deep link like /mail/<id> then prefix-matches the
  // static /mail pattern before /mail/:entityId exists, opens the list
  // singleton, and the tab->URL sync rewrites the URL - losing the deep link.
  batch(() => registerAppImpl(def))
}

/** The feature of the tab type an app's rail entry opens, when it has one. */
function navigationFeature(def: AppDefinition): string | undefined {
  const tabAction = def.activityBar?.tabAction
  const local =
    (tabAction && (def.tabTypes?.[tabAction.type] ? tabAction.type : tabAction.entityId)) ??
    Object.keys(def.tabTypes ?? {})[0]
  return local ? def.tabTypes?.[local]?.feature : undefined
}

function registerAppImpl(def: AppDefinition): void {
  const previousIndex = appIndex[def.name]
  const nextTabTypeKeys = Object.keys(def.tabTypes ?? {}).map((type) =>
    namespaceRegistryKey(def.name, type),
  )

  // Idempotent refresh: keep unchanged tab types registered continuously so
  // active tabs never lose their URL mapping during manifest reloads.
  if (previousIndex) {
    const nextTypes = new Set(nextTabTypeKeys)
    for (const type of previousIndex.tabTypes) {
      if (!nextTypes.has(type)) unregisterTabType(type)
    }

    unregisterActivityBarEntry(def.name)
    unregisterSettingsSections(def.name)
    for (const id of previousIndex.commandIds) unregisterCommand(id)
    unregisterWsEntityHandlers(def.name)
    unregisterWsMessageHandlers(def.name)
    for (const id of previousIndex.keybindingIds) unregisterKeybinding(id)
    for (const id of previousIndex.slotIds) unregisterSlot(id)
    unregisterContributions(def.name)
    unregisterPanels(def.name)
    unregisterEntityExternalLinks(def.name)
    unregisterSavedViewsHandlers(def.name)
    unregisterBulkUi(def.name)
    unregisterManifestAppData(def.name)
  }

  const tabTypeKeys: string[] = []
  const keybindingIds: string[] = []
  const commandIds: string[] = []
  const slotIds: string[] = []
  const panelIds: string[] = []
  const qualifiedTabTypes = new Map<string, string>()

  // Tab types
  if (def.tabTypes) {
    for (const [type, reg] of Object.entries(def.tabTypes)) {
      const qualifiedType = namespaceRegistryKey(def.name, type)
      registerTabType(qualifiedType, { ...reg, appId: def.name, localType: type })
      qualifiedTabTypes.set(type, qualifiedType)
      tabTypeKeys.push(qualifiedType)
    }
  }

  // Activity bar
  if (def.activityBar) {
    const firstTabType = tabTypeKeys[0]
    registerActivityBarEntry({
      id: def.name,
      icon: def.activityBar.icon,
      label: def.activityBar.label,
      labelKey: def.activityBar.labelKey,
      order: def.activityBar.order,
      position: def.activityBar.position,
      external: def.activityBar.external,
      appId: def.name,
      feature: navigationFeature(def),
      tabAction: def.activityBar.tabAction
        ? {
            ...def.activityBar.tabAction,
            // Qualify against the app's own tab types: try `type`, then
            // `entityId` (manifests conventionally use type:"home" with the
            // real local tab type in entityId), then the app's first tab type.
            // Never leak a bare unqualified string through — a bare "home" is
            // ambiguous across apps and resolves to undefined at render time,
            // which mounts an empty tab with no error.
            type:
              qualifiedTabTypes.get(def.activityBar.tabAction.type) ??
              qualifiedTabTypes.get(def.activityBar.tabAction.entityId) ??
              firstTabType ??
              def.activityBar.tabAction.type,
          }
        : {
            type: firstTabType ?? def.name,
            entityId: def.name,
            label: def.activityBar.label,
          },
    })
  }

  // Bare app routes. Registered next to the activity bar because they resolve
  // through the same default tab action; an app with no rail entry has no
  // default page to open, so it declares no bare route either.
  if (def.activityBar) {
    registerAppRoutes(def.name, [...(def.routes ?? []), appRouteSlug(def.activityBar.label)])
  } else {
    unregisterAppRoutes(def.name)
  }

  // Settings
  if (def.settings) {
    for (const section of def.settings) {
      const sectionId = section.id
        ? `${def.name}:${section.id}`
        : `${def.name}:${section.label.toLowerCase().replace(/\s+/g, "-")}`
      registerSettingsSection({ ...section, id: sectionId, appId: def.name })
    }
  }

  // Commands
  if (def.commands) {
    for (const cmd of def.commands) {
      const commandId = namespaceRegistryKey(def.name, cmd.id)
      registerCommand({ ...cmd, id: commandId, appId: def.name, localId: cmd.id })
      commandIds.push(commandId)
    }
  }

  // WS handlers
  if (def.wsHandlers) {
    for (const [entity, handlerRegistration] of Object.entries(def.wsHandlers)) {
      const explicitKey = (handlerRegistration as ExplicitWsHandlerRegistration).__explicitKey
      const qualifiedEntity = explicitKey ?? namespaceRegistryKey(def.name, entity)
      const registrations = explicitKey
        ? (handlerRegistration as ExplicitWsHandlerRegistration).handler
        : (handlerRegistration as RealtimeRegistration<
            WsEntityHandler,
            WsEntityHandlerRegistration
          >)
      for (const registration of asRealtimeRegistrations(registrations)) {
        registerWsEntityHandler(qualifiedEntity, def.name, registration.handler, {
          owner: registration.owner,
          priority: registration.priority,
        })
      }
    }
  }

  if (def.wsMessages) {
    for (const [type, handlerRegistration] of Object.entries(def.wsMessages)) {
      for (const registration of asRealtimeRegistrations(handlerRegistration)) {
        registerWsMessageHandler(type, def.name, registration.handler, {
          owner: registration.owner,
          priority: registration.priority,
        })
      }
    }
  }

  // Keybindings
  if (def.keybindings) {
    for (const binding of def.keybindings) {
      const bindingId = namespaceRegistryKey(def.name, binding.id)
      registerKeybinding({ ...binding, id: bindingId, appId: def.name, localId: binding.id })
      keybindingIds.push(bindingId)
    }
  }

  // Slots
  if (def.slots) {
    for (const [slotId, decl] of Object.entries(def.slots)) {
      registerSlot(slotId, decl)
      slotIds.push(slotId)
    }
  }

  // Contributions
  if (def.contributions) {
    for (const [slotId, entry] of Object.entries(def.contributions)) {
      registerContribution(slotId, { ...entry, appId: def.name })
    }
  }

  // Panels
  if (def.panels) {
    for (const [panelType, reg] of Object.entries(def.panels)) {
      const panelId = namespaceRegistryKey(def.name, panelType)
      registerPanel(panelId, { ...reg, appId: def.name, localType: panelType })
      panelIds.push(panelId)
    }
  }

  // Entity external links (torn down by appId in the previousIndex block)
  if (def.entityExternalLinks) {
    for (const [entity, reg] of Object.entries(def.entityExternalLinks)) {
      registerEntityExternalLink(def.name, entity, reg)
    }
  }

  // Saved Views handlers
  if (def.savedViews) {
    for (const [viewId, handler] of Object.entries(def.savedViews)) {
      registerSavedViewsHandler(def.name, viewId, handler)
    }
  }

  // Bulk UI selection accessors + custom forms
  if (def.bulkUi) {
    for (const [viewId, sel] of Object.entries(def.bulkUi.selection)) {
      registerBulkUiSelection(def.name, viewId, sel)
    }
    if (def.bulkUi.customForms) {
      for (const [action, form] of Object.entries(def.bulkUi.customForms)) {
        registerBulkUiCustomForm(def.name, action, form)
      }
    }
  }

  // Index for unregister. `phoneHeaderTypes` is carried forward from the
  // previous index (see the field's own comment) — this call never touches it.
  setAppIndex(def.name, {
    tabTypes: tabTypeKeys,
    keybindingIds,
    commandIds,
    slotIds,
    panelIds,
    phoneHeaderTypes: previousIndex?.phoneHeaderTypes ?? [],
  })
}

/**
 * Attach a phone-tier header component to an already-registered tab type,
 * from OUTSIDE `registerApp()` — the only way a manifest app (whose tab types
 * arrive as JSON, with no way to carry a component reference) can give one of
 * its tab types a phone header. Call once, after the app's `registerApp()` /
 * `registerAppFromManifest()` call has run (e.g. from `registerAppHooks()`).
 */
export function registerAppPhoneHeader(
  appId: string,
  tabType: string,
  header: Component<{ entityId: string }>,
): void {
  const qualifiedType = namespaceRegistryKey(appId, tabType)
  registerPhoneHeader(qualifiedType, header)
  setAppIndex(
    produce((s) => {
      const idx = s[appId]
      // Deduped: a second call for the same tab type (a re-registration, a
      // header AND a hidden-bar marker on one type) would otherwise leave two
      // entries, and `unregisterApp` would call `unregisterPhoneHeader` twice.
      if (idx) {
        if (!idx.phoneHeaderTypes.includes(qualifiedType)) idx.phoneHeaderTypes.push(qualifiedType)
      } else {
        s[appId] = {
          tabTypes: [],
          keybindingIds: [],
          commandIds: [],
          slotIds: [],
          panelIds: [],
          phoneHeaderTypes: [qualifiedType],
        }
      }
    }),
  )
}

/**
 * Mark an already-registered tab type as a large-title phone screen that owns
 * its title and hides the shared phone top bar entirely — the manifest-app
 * equivalent of `TabTypeRegistration.hidePhoneTopBar` (see that field and
 * `registerAppPhoneHeader` above for why this needs a runtime call at all).
 */
export function registerAppPhoneTopBarHidden(appId: string, tabType: string): void {
  const qualifiedType = namespaceRegistryKey(appId, tabType)
  registerPhoneTopBarHidden(qualifiedType)
  setAppIndex(
    produce((s) => {
      const idx = s[appId]
      // Deduped: a second call for the same tab type (a re-registration, a
      // header AND a hidden-bar marker on one type) would otherwise leave two
      // entries, and `unregisterApp` would call `unregisterPhoneHeader` twice.
      if (idx) {
        if (!idx.phoneHeaderTypes.includes(qualifiedType)) idx.phoneHeaderTypes.push(qualifiedType)
      } else {
        s[appId] = {
          tabTypes: [],
          keybindingIds: [],
          commandIds: [],
          slotIds: [],
          panelIds: [],
          phoneHeaderTypes: [qualifiedType],
        }
      }
    }),
  )
}

/**
 * A read-only window onto the teardown index, for the tests that assert what
 * `unregisterApp` will have to undo. Nothing in the app reads it.
 */
export const DefineAppTestAccess = {
  phoneHeaderTypes: (appId: string): readonly string[] => appIndex[appId]?.phoneHeaderTypes ?? [],
}

/**
 * Tear an app's frontend surface down. `keepTabTypes` leaves its tab types
 * registered (and its open tabs open) so a tab of an app the viewer just lost
 * access to stays and says why instead of vanishing; the kept types are
 * returned for the caller to release later with `unregisterTabTypes`.
 */
export function unregisterApp(
  name: string,
  options?: { notifyTabRemoval?: boolean; keepTabTypes?: boolean },
): string[] {
  const index = appIndex[name]
  if (!index) return []
  const keptTabTypes = options?.keepTabTypes ? [...index.tabTypes] : []

  // Remove tab types
  if (!options?.keepTabTypes) {
    for (const type of index.tabTypes) {
      unregisterTabType(type, { notifyRemoval: options?.notifyTabRemoval })
    }
  }

  // Remove activity bar entry
  unregisterActivityBarEntry(name)
  unregisterAppRoutes(name)

  // Remove settings sections (id-prefixed with appName) and a connector's card
  unregisterSettingsSections(name)
  unregisterConnectorApp(name)
  unregisterAppSettingsEntry(name)

  // Remove commands
  for (const id of index.commandIds) {
    unregisterCommand(id)
  }

  // Remove WS handlers
  unregisterWsEntityHandlers(name)
  unregisterWsMessageHandlers(name)

  // Remove keybindings
  for (const id of index.keybindingIds) {
    unregisterKeybinding(id)
  }

  // Remove slots
  for (const id of index.slotIds) {
    unregisterSlot(id)
  }

  // Remove contributions and panels
  unregisterContributions(name)
  unregisterPanels(name)

  // Remove saved views handlers + bulk UI registrations
  unregisterSavedViewsHandlers(name)
  unregisterBulkUi(name)
  unregisterManifestAppData(name)

  // Remove runtime-attached phone headers (registerAppPhoneHeader / registerAppPhoneTopBarHidden)
  for (const type of index.phoneHeaderTypes) {
    unregisterPhoneHeader(type)
  }

  // Clean index
  setAppIndex(
    produce((s) => {
      delete s[name]
    }),
  )
  return keptTabTypes
}

/** Reset app index (test isolation) */
export function resetAppIndex(): void {
  setAppIndex(reconcile({}))
  appSettingsRegistrations.clear()
}

/** One section of an app's declarative settings page (manifest `settings`). */
export type ManifestSettingsSection = AppSettingsSection

export interface AppManifest {
  name: string
  /** `connector` apps are cards on the Connectors page, never an Apps row. */
  kind?: AppKind
  /** The app's one declarative settings page (`/settings/apps/<name>`). */
  settings?: AppSettingsSchema
  displayName?: string
  version?: string
  /** Publisher, shown in the settings page header. */
  author?: string
  /** Bare routes that open this app at its default page, beside `/<name>`. */
  routes?: string[]
  views?: {
    tabTypes?: Record<
      string,
      {
        component: string
        sidebar?: string
        icon?: string
        /** Human tab label — used as the default when a tab of this type is
         *  opened from a URL. Falls back to the raw type name. */
        label?: string
        /** Catalog key for that label (`kernel.nav.*`), for an in-tree module
         *  whose name belongs to the product rather than to an installed app. */
        labelKey?: string
        singleton?: boolean
        urlPattern?: string
        preserveSubRoutes?: boolean
        resolveLabel?: string
        referenceable?: boolean
        /** A feature the app declares under top-level `features`. */
        feature?: string
      }
    >
    activityBar?: {
      icon: string
      label: string
      /** Catalog key for the rail label a reader sees (`kernel.nav.*`). */
      labelKey?: string
      order: number
      tabAction?: any
    }
    panels?: Record<string, { component: string; icon?: string; label: string }>
    detail?: Record<
      string,
      {
        component?: string
        icon?: string
        externalLink?: { urlTemplate: string; label?: string }
      }
    >
    commands?: Array<{ id: string; label: string; shortcut?: string }>
    keybindings?: Array<{ id: string; key: string; handler: string }>
    saveable?: string[]
    wsHandlers?: Record<string, string | { key: string; handler: string }>
  }
  /** A host declares `position`; an app contributes `panels` or `actions`. */
  slots?: Record<string, { position?: string; panels?: unknown[]; actions?: unknown[] }>
  contributions?: Record<
    string,
    { label: string; component: string; visibility_scope?: string; order?: number; group?: string }
  >
  bulk?: Record<string, any>
  savedViews?: Record<string, any>
  entities?: Record<string, any>
  attention?: { groupLabel?: { label: string; labelKey?: string } }
}

// Attach per-shared-field render hints (enum/type/widget/label) to each bulk
// action by reading the underlying tool's param schema, so the bulk form can
// render the right widget — a <select> for an enum like closedReason instead of
// a bare text input. Derived once here so the renderer stays schema-agnostic.
function enrichBulkFieldSpecs(manifest: AppManifest): Record<string, ManifestBulkAction> {
  const tools = (manifest as any).tools ?? {}
  const out: Record<string, ManifestBulkAction> = {}
  for (const [key, raw] of Object.entries((manifest as any).bulk ?? {})) {
    const action = { ...(raw as ManifestBulkAction) }
    const tool = tools[action.underlyingTool] ?? {}
    const props: Record<string, any> = tool?.params?.properties ?? {}
    const editable: Array<{ field?: string; label?: string; widget?: string }> = Array.isArray(
      tool?.editableFields,
    )
      ? tool.editableFields
      : []
    const specs: Record<string, BulkFieldSpec> = {}
    for (const field of action.sharedFields ?? []) {
      const p = props[field] ?? {}
      const ed = editable.find((e) => e.field === field)
      const spec: BulkFieldSpec = {}
      if (typeof p.type === "string") spec.type = p.type
      if (Array.isArray(p.enum)) spec.enum = p.enum.map(String)
      if (ed?.widget) spec.widget = ed.widget
      if (ed?.label) spec.label = ed.label
      specs[field] = spec
    }
    action.fieldSpecs = specs
    out[key] = action
  }
  return out
}

/**
 * The catalog key naming a manifest app in the shell (`kernel.nav.<app>`), for
 * an app whose manifest ships no `labelKey`. Bundled apps (Invoicing,
 * Monitoring) carried an English label only, so the tab strip, the activity
 * bar and the phone header said "Invoicing" to a French reader. Only a key the
 * catalog actually holds is returned; an installed third-party app keeps its
 * own label.
 */
export function appNavLabelKey(appName: string): string | undefined {
  const nav = (englishDictionaries().kernel as Record<string, any> | undefined)?.nav
  return nav && typeof nav[appName] === "string" ? `kernel.nav.${appName}` : undefined
}

/** The page an app's declarative settings render on. */
export function appSettingsHref(appName: string): string {
  return `/settings/apps/${appName}`
}

/**
 * What an app's declarative settings page needs to render: the manifest slice,
 * its name, rail icon and UI export bag (custom blocks resolve there). One per
 * app that declares `settings`, apps and connectors alike.
 */
export interface AppSettingsPageRegistration {
  appId: string
  manifest: Pick<AppManifest, "name" | "displayName" | "version" | "author" | "kind" | "settings">
  labelKey?: string
  label?: string
  icon?: Component<{ size?: number }>
  exports?: Record<string, unknown>
}

/** The settings pages module, handed over by the kernel bootstrap. */
export interface AppSettingsRouteWiring {
  /** Renders `/settings/apps/<app>`. */
  page: Component<{ appId: string }>
  registerPage: (entry: AppSettingsPageRegistration) => void
  unregisterPage: (appId: string) => void
}

// The framework layer may not import a module, so the kernel bootstrap hands
// the settings pages over once (`registerAppSettingsRoute`). Registrations made
// before that are kept here and handed over then; until then an app page
// renders nothing. This map is the one record of which app has a page: the
// Apps row, the Connectors card and the page entry all come from it.
const [settingsWiring, setSettingsWiring] = createSignal<AppSettingsRouteWiring | null>(null)
const appSettingsRegistrations = new Map<string, AppSettingsPageRegistration>()

/** Wire the settings pages module (the kernel bootstrap does, once). */
export function registerAppSettingsRoute(wiring: AppSettingsRouteWiring): void {
  setSettingsWiring(() => wiring)
  for (const entry of appSettingsRegistrations.values()) wiring.registerPage(entry)
}

function registerAppSettingsEntry(entry: AppSettingsPageRegistration): void {
  appSettingsRegistrations.set(entry.appId, entry)
  settingsWiring()?.registerPage(entry)
}

function unregisterAppSettingsEntry(appId: string): void {
  if (!appSettingsRegistrations.delete(appId)) return
  settingsWiring()?.unregisterPage(appId)
}

function appSettingsPageFor(appName: string): Component {
  return () => {
    const wiring = settingsWiring()
    return wiring ? createComponent(wiring.page, { appId: appName }) : null
  }
}

/** The catalog key naming an app with no rail entry (`kernel.nav.app.<app>`). */
export function settingsOnlyAppLabelKey(appName: string): string | undefined {
  const apps = (englishDictionaries().kernel as Record<string, any> | undefined)?.nav?.app
  return apps && typeof apps[appName] === "string" ? `kernel.nav.app.${appName}` : undefined
}

/**
 * The catalog key naming an app's settings row and page: its rail name, else
 * its settings-only name, else (for an app whose manifest declares no
 * `displayName`) the catalog's app name (`kernel.capabilities.apps.<app>`), so
 * a page never reads the package id ("mcp-manager"). A declared display name
 * stays the app's own and needs no key.
 */
export function appSettingsLabelKey(
  appName: string,
  displayName?: string | null,
): string | undefined {
  const own = appNavLabelKey(appName) ?? settingsOnlyAppLabelKey(appName)
  if (own || displayName) return own
  const apps = (englishDictionaries().kernel as Record<string, any> | undefined)?.capabilities?.apps
  return apps && typeof apps[appName] === "string"
    ? `kernel.capabilities.apps.${appName}`
    : undefined
}

function pageSectionAccess(
  appId: string,
  settings: AppManifest["settings"],
): SettingsPageSectionAccess[] {
  return (settings?.sections ?? []).map((s) => ({
    scope: s.scope,
    ...(s.adminScope ? { adminScope: s.adminScope } : {}),
    ...(s.feature ? { feature: s.feature, appId } : {}),
  }))
}

/**
 * The other apps whose tab routes an installed app must leave alone: the apps of the manifest
 * list (whatever order they register in), the tab types already registered (the kernel's
 * included) and every registered app's name.
 */
function tabRouteOwners(app: string, listed: readonly { name: string; manifest?: unknown }[]) {
  const owners: TabRouteOwner[] = listed.map((other) => ({
    name: other.name,
    patterns: manifestTabUrlPatterns(other.name, other.manifest),
  }))
  for (const reg of Object.values(getTabTypes())) {
    owners.push({ name: reg.appId ?? "kernel", patterns: [reg.urlPattern] })
  }
  for (const name of Object.keys(appIndex)) owners.push({ name, patterns: [] })
  return owners.filter((owner) => owner.name !== app)
}

export function registerAppFromManifest(
  manifest: AppManifest,
  uiExports: Record<string, any>,
  options: {
    /** An installed app (a UI bundle), not an in-tree module. */
    external?: boolean
    /** Every app of the manifest list, so an installed app registering first cannot take
     *  another's routes. */
    routeOwners?: readonly { name: string; manifest?: unknown }[]
  } = {},
): void {
  const appLabel = manifest.views?.activityBar?.label
  // An icon the manifest declares as data is the app's icon everywhere: the same glyph the host
  // draws when the app runs framed, so an app never changes face between the web and a shell.
  if (declaresAppIcon(manifest)) {
    const icon = isolatedAppIcon(manifest)
    const names = iconNames(manifest)
    const own = uiExports
    uiExports = new Proxy(own, {
      get: (target, name, receiver) =>
        typeof name === "string" && names.has(name) ? icon : Reflect.get(target, name, receiver),
    })
  }
  function resolveExport(name: string): any {
    const component = uiExports[name]
    if (!component) throw new Error(`UI export "${name}" not found for app "${manifest.name}"`)
    return component
  }

  const def: AppDefinition = { name: manifest.name }

  if (manifest.views?.tabTypes) {
    def.tabTypes = {}
    // An installed app's tab pattern must sit under a first segment it owns: the server
    // refuses one that does not, and the shell skips it too, so it can never open (and its
    // frame never navigate to or receive) another app's or a Liaison page's URL.
    const owners = options.external ? tabRouteOwners(manifest.name, options.routeOwners ?? []) : []
    for (const [type, reg] of Object.entries(manifest.views.tabTypes)) {
      const urlPattern = reg.urlPattern ?? `/${manifest.name}/${type}/:entityId`
      const refusal = options.external ? tabRouteRefusal(manifest.name, urlPattern, owners) : null
      if (refusal) {
        console.warn(`Installed app "${manifest.name}": tab type "${type}" skipped: its ${refusal}`)
        continue
      }
      def.tabTypes[type] = {
        component: resolveExport(reg.component),
        sidebar: reg.sidebar ? resolveExport(reg.sidebar) : null,
        icon: reg.icon ? resolveExport(reg.icon) : ((() => null) as any),
        urlPattern,
        // The manifest's human label — falling back to the raw type name gave
        // every URL-opened plugin tab a lowercase machine name ("documents",
        // "editor") instead of its declared label.
        defaultLabel: reg.label ?? type,
        // The app's home tab carries the app's name: named from the catalog
        // when the manifest gives no key.
        defaultLabelKey:
          reg.labelKey ??
          (reg.label !== undefined && reg.label === appLabel
            ? appNavLabelKey(manifest.name)
            : undefined),
        singleton: reg.singleton,
        preserveSubRoutes: reg.preserveSubRoutes,
        resolveLabel: reg.resolveLabel ? resolveExport(reg.resolveLabel) : undefined,
        referenceable: reg.referenceable,
        feature: reg.feature,
      }
    }
  }

  if (Array.isArray(manifest.routes)) {
    def.routes = manifest.routes.filter((r): r is string => typeof r === "string")
  }

  if (manifest.views?.activityBar) {
    const ab = manifest.views.activityBar
    def.activityBar = {
      icon: resolveExport(ab.icon),
      label: ab.label,
      labelKey: ab.labelKey ?? appNavLabelKey(manifest.name),
      order: ab.order,
      external: options.external,
      tabAction: ab.tabAction,
    }
  }

  // A declarative settings page: ONE entry per app (apps and connectors), the
  // record the Apps row, the page and the Connectors card all read.
  const settings = manifest.settings
  if (settings && settings.sections.length > 0) {
    const label = appLabel ?? manifest.displayName ?? manifest.name
    const labelKey =
      manifest.views?.activityBar?.labelKey ??
      appSettingsLabelKey(manifest.name, appLabel ?? manifest.displayName)
    const iconName = manifest.views?.activityBar?.icon
    const icon = iconName ? uiExports[iconName] : undefined
    registerAppSettingsEntry({
      appId: manifest.name,
      manifest: {
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        author: manifest.author,
        kind: manifest.kind,
        settings,
      },
      labelKey,
      label,
      ...(typeof icon === "function" ? { icon } : {}),
      exports: uiExports,
    })
    if (manifest.kind === "connector") {
      // A connector is a card on the Connectors page: no row, no page of its own.
      registerConnectorApp(manifest.name, pageSectionAccess(manifest.name, settings))
    } else {
      // ONE page per app, named like the app; visible when the viewer sees at
      // least one of its sections.
      def.settings = [
        {
          id: "settings",
          label,
          labelKey,
          href: appSettingsHref(manifest.name),
          group: "app",
          order: 0,
          pageSections: pageSectionAccess(manifest.name, settings),
          component: appSettingsPageFor(manifest.name),
        },
      ]
    }
  }

  if (manifest.views?.panels) {
    def.panels = {}
    for (const [panelType, reg] of Object.entries(manifest.views.panels)) {
      def.panels[panelType] = {
        component: resolveExport(reg.component),
        icon: reg.icon ? resolveExport(reg.icon) : undefined,
        label: reg.label,
      }
    }
  }

  // Phase 16.6 — `views.detail.<entity>` entries with a `component` register
  // as panels under the `detail:<entity>` localType. The kernel's `detail`
  // tab type (registered in bootstrap.ts) parses entityId as
  // `<appName>/<entity>/<id>` and resolves the panel through the existing
  // app-registry namespacing. Entries with an `externalLink` (whether or not
  // they also have a component) additionally register into the entity
  // external-link registry so `openEntity` knows an external deep link exists —
  // component-less "external-only" entries (e.g. a Shopify order, which has no
  // in-app tab) are opened via that link instead of a broken tab.
  if (manifest.views?.detail) {
    def.panels = def.panels ?? {}
    def.entityExternalLinks = {}
    for (const [entity, reg] of Object.entries(
      manifest.views.detail as Record<
        string,
        { component?: string; icon?: string; externalLink?: { label?: string } }
      >,
    )) {
      if (reg.externalLink) {
        def.entityExternalLinks[entity] = { label: reg.externalLink.label }
      }
      if (!reg.component) continue
      def.panels[`detail:${entity}`] = {
        component: resolveExport(reg.component),
        icon: reg.icon ? resolveExport(reg.icon) : undefined,
        label: entity,
      }
    }
  }

  if (manifest.views?.commands) {
    def.commands = manifest.views.commands.map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      shortcut: cmd.shortcut,
      execute: () => {
        /* Manifest commands dispatched via event system */
      },
    }))
  }

  if (manifest.views?.keybindings) {
    def.keybindings = manifest.views.keybindings.map((kb) => ({
      id: kb.id,
      key: kb.key,
      label: kb.id,
      handler: resolveExport(kb.handler) as (e: KeyboardEvent) => void,
    }))
  }

  if (manifest.views?.saveable) {
    def.saveable = manifest.views.saveable
  }

  if (manifest.views?.wsHandlers) {
    def.wsHandlers = {}
    for (const [entity, raw] of Object.entries(manifest.views.wsHandlers)) {
      if (typeof raw === "string") {
        def.wsHandlers[entity] = resolveExport(raw) as WsEntityHandler
      } else if (raw && typeof raw === "object") {
        def.wsHandlers[entity] = {
          __explicitKey: (raw as any).key,
          handler: resolveExport((raw as any).handler) as WsEntityHandler,
        }
      }
    }
  }

  // Phase 17 — `slots.<slot>.panels[]` and `slots.<host_app>.<slot_id>.tabs[]`
  // are contribution shapes (the app contributes panels/tabs to a slot owned
  // by another app or by the kernel). Map them to contributions so the local
  // contribution registry has the resolved component, and the server-side
  // /api/v1/slots/:slot enumeration's panel ids correlate back via
  // `ContributionEntry.id`. Falls back to the legacy `{position}` slot
  // declaration form for back-compat.
  if (manifest.slots) {
    const legacyDecl: Record<string, { position: string }> = {}
    for (const [slotKey, raw] of Object.entries(manifest.slots)) {
      // Contribution: `{ panels: [...] }` or `{ actions: [...] }` directly under the slot key.
      const contributed = raw as { panels?: unknown[]; actions?: unknown[] } | null | undefined
      const panels = [
        ...(Array.isArray(contributed?.panels) ? contributed.panels : []),
        ...(Array.isArray(contributed?.actions) ? contributed.actions : []),
      ]
      if (Array.isArray(contributed?.panels) || Array.isArray(contributed?.actions)) {
        for (const panel of panels as Array<{
          id: string
          label: string
          component: string
        }>) {
          registerContribution(slotKey, {
            appId: manifest.name,
            id: panel.id,
            label: panel.label,
            component: resolveExport(panel.component),
          })
        }
        continue
      }
      // Contribution: nested `slots.<host_app>.<slot_id>.tabs[]` (e.g.
      // `slots.invoicing.document_detail.tabs[]`). The effective slotId we
      // register against is `<host_app>.<slot_id>`.
      if (raw && typeof raw === "object") {
        for (const [nestedKey, nested] of Object.entries(
          raw as Record<string, { tabs?: any[] } | null>,
        )) {
          const tabs = (nested as { tabs?: any[] } | null | undefined)?.tabs
          if (!Array.isArray(tabs)) continue
          const effectiveSlot = `${slotKey}.${nestedKey}`
          for (const tab of tabs as Array<{ id: string; label: string; component: string }>) {
            registerContribution(effectiveSlot, {
              appId: manifest.name,
              id: tab.id,
              label: tab.label,
              component: resolveExport(tab.component),
            })
          }
        }
      }
      // Legacy `{position}` declaration — passed through to `def.slots`.
      if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { position?: unknown }).position === "string"
      ) {
        legacyDecl[slotKey] = raw as { position: string }
      }
    }
    if (Object.keys(legacyDecl).length > 0) {
      def.slots = legacyDecl as any
    }
  }

  if (manifest.contributions) {
    def.contributions = {}
    for (const [slot, contrib] of Object.entries(manifest.contributions)) {
      // The server lists a contribution under its component name as its id.
      def.contributions[slot] = {
        id: contrib.component,
        label: contrib.label,
        component: resolveExport(contrib.component),
      }
    }
  }

  registerApp(def)

  const manifestAppData: ManifestAppData = {}
  if (manifest.bulk) manifestAppData.bulk = enrichBulkFieldSpecs(manifest)
  if (manifest.savedViews) manifestAppData.savedViews = manifest.savedViews as any
  if (manifest.entities) manifestAppData.entities = manifest.entities as any
  if (manifest.attention?.groupLabel) {
    manifestAppData.attention = { groupLabel: manifest.attention.groupLabel }
  }
  if (Object.keys(manifestAppData).length > 0) {
    registerManifestAppData(manifest.name, manifestAppData)
  }
}

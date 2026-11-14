// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure registry — NO domain store imports. Zero circular dependency risk.
import type { Component } from "solid-js"
import { createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { notifyEntityChange } from "~/framework/entity-changes"
import { isFeatureOff } from "~/framework/org-features"
import { isAppUnavailable } from "~/framework/unavailable-apps"
import type { ApiClient } from "~/lib/api-client"
import { log } from "~/lib/logger"

type AliasMap = Map<string, Set<string>>

function addAlias(map: AliasMap, alias: string, registryId: string): void {
  const existing = map.get(alias) ?? new Set<string>()
  existing.add(registryId)
  map.set(alias, existing)
}

function removeAlias(map: AliasMap, alias: string, registryId: string): void {
  const existing = map.get(alias)
  if (!existing) return
  existing.delete(registryId)
  if (existing.size === 0) map.delete(alias)
}

function resolveAlias(
  map: AliasMap,
  id: string,
  exists: (registryId: string) => boolean,
): string | undefined {
  if (exists(id)) return id
  const candidates = map.get(id)
  if (!candidates || candidates.size === 0) return undefined
  if (candidates.size > 1) {
    log.warn({ alias: id, candidates: [...candidates] }, "Ambiguous alias — use fully qualified id")
    return undefined
  }
  const [resolved] = candidates
  return exists(resolved) ? resolved : undefined
}

export function namespaceRegistryKey(appId: string, localId: string): string {
  return `${appId}:${localId}`
}

/**
 * The label a reader sees for a registry entry. Kernel registrations carry a
 * `labelKey` into the shared catalog; an installed app that ships none keeps
 * its own English label rather than rendering a bare key.
 */
export function registryLabel(
  t: (key: string) => string,
  entry: { label: string; labelKey?: string },
): string {
  if (!entry.labelKey) return entry.label
  const translated = t(entry.labelKey)
  return translated === entry.labelKey ? entry.label : translated
}

/**
 * The label a reader sees for an OPEN TAB. An entity tab resolves its own name
 * (a thread title, a document title). A tab type with a FIXED name (Home,
 * Search, Settings, Mail, Tickets) is named from the catalog, so the tab strip
 * and the phone header follow the reader's language; the stored English label
 * stays the fallback for an app that ships no key.
 */
export function tabDisplayLabel(
  t: (key: string) => string,
  tab: { type: string; entityId: string; label: string },
): string {
  const reg = getTabType(tab.type)
  const resolved = reg?.resolveLabel?.(tab.entityId)
  if (resolved) return resolved
  const key = reg?.defaultLabelKey
  if (key && (!tab.label?.trim() || tab.label === reg?.defaultLabel)) {
    const translated = t(key)
    if (translated !== key) return translated
  }
  return tab.label
}

// ─── Tab Type Registry ───────────────────────────────────────────────

export interface TabTypeRegistration {
  component: Component<{ entityId: string }>
  sidebar: Component | null
  icon: Component<{ size?: number }>
  /** Draws the tab strip's mark for one entity in place of `icon` (a DM tab
   *  shows the counterpart's face); it falls back to `icon` itself. */
  entityIcon?: Component<{ entityId: string; size: number }>
  urlPattern: string
  defaultLabel: string
  /** Catalog key for the tab strip's label (`kernel.nav.*`), when this tab
   *  type carries a fixed name rather than an entity's own. */
  defaultLabelKey?: string
  appId?: string
  localType?: string
  /** A feature the app declares: off, no navigation leads here and an open tab shows the notice. */
  feature?: string
  singleton?: boolean
  /** Resolve a dynamic label from entityId (e.g. thread title from store) */
  resolveLabel?: (entityId: string) => string | undefined
  /** Don't overwrite sub-route URLs (e.g. /settings/security) when syncing tab→URL */
  preserveSubRoutes?: boolean
  /** Check whether the entity still exists and is accessible. Return false to evict the tab on startup. */
  validateEntity?: (entityId: string) => Promise<boolean>
  /** Marks this tab type as the canonical view for an entity, eligible for thread-reference tracking and live-nav. */
  referenceable?: boolean
  /** The phone tier's top bar content for this tab type (F4). A tab type that
   *  declares none keeps the plain label bar; a thread declares a nav bar with
   *  its title, its agent state and its actions menu. Resolved through this
   *  registry, so the shell never reads route params to decide. */
  phoneHeader?: Component<{ entityId: string }>
  /** F3: a root screen that owns a large title of its own (Chats, Work) hides
   *  the phone top bar ENTIRELY instead of using `phoneHeader` to customize
   *  its content — a bar left in place doubled the title ("Chats" small in
   *  the bar, "Chats" large below it) or printed the workspace name nowhere
   *  a small-title screen would (Work showed both; Chats showed neither its
   *  own title nor a consistent org placement). The screen renders the org
   *  name itself, as a small muted line under its own title. */
  hidePhoneTopBar?: boolean
}

const [tabTypeStore, setTabTypeStore] = createStore<Record<string, TabTypeRegistration>>({})
const [tabTypeRegistryVersion, setTabTypeRegistryVersion] = createSignal(0)
const tabTypeAliases: AliasMap = new Map()
const tabTypeRemovalListeners = new Set<(types: string[]) => void>()

function notifyTabTypeRemoval(types: string[]): void {
  if (types.length === 0) return
  for (const listener of tabTypeRemovalListeners) {
    listener([...types])
  }
}

export function registerTabType(type: string, reg: TabTypeRegistration): void {
  const existing = tabTypeStore[type]
  if (existing) removeAlias(tabTypeAliases, existing.localType ?? type, type)
  setTabTypeStore(type, reg)
  addAlias(tabTypeAliases, reg.localType ?? type, type)
  setTabTypeRegistryVersion((version) => version + 1)
}

export function unregisterTabType(type: string, options?: { notifyRemoval?: boolean }): void {
  unregisterTabTypes([type], options)
}

export function unregisterTabTypes(types: string[], options?: { notifyRemoval?: boolean }): void {
  if (types.length === 0) return
  for (const type of types) {
    const reg = tabTypeStore[type]
    if (reg) removeAlias(tabTypeAliases, reg.localType ?? type, type)
  }
  setTabTypeStore(
    produce((s) => {
      for (const type of types) {
        delete s[type]
      }
    }),
  )
  setTabTypeRegistryVersion((version) => version + 1)
  if (options?.notifyRemoval !== false) notifyTabTypeRemoval(types)
}

export { tabTypeRegistryVersion }

export function resolveRegisteredTabType(type: string): string | undefined {
  return resolveAlias(tabTypeAliases, type, (registryId) => Boolean(tabTypeStore[registryId]))
}

export function subscribeToTabTypeRemoval(listener: (types: string[]) => void): () => void {
  tabTypeRemovalListeners.add(listener)
  return () => {
    tabTypeRemovalListeners.delete(listener)
  }
}

export function getTabType(type: string): TabTypeRegistration | undefined {
  const registryId = resolveRegisteredTabType(type)
  const registration = registryId ? tabTypeStore[registryId] : undefined
  // The registration stays, so the feature coming back on needs no reload, and a
  // tab already open resolves to no component: the shell says why (MainPanel).
  return registration && !isFeatureOff(registration.appId, registration.feature)
    ? registration
    : undefined
}

export function getTabTypes(): Record<string, TabTypeRegistration> {
  return tabTypeStore
}

// ─── Phone Header Registry (runtime attachment) ───────────────────────
//
// `TabTypeRegistration.phoneHeader` / `.hidePhoneTopBar` work for a tab type
// declared as a literal object (the kernel's own `registerApp()` calls in
// bootstrap.ts), but a tab type created from an app MANIFEST goes through
// `registerAppFromManifest`, which builds `TabTypeRegistration` from JSON —
// and a component reference cannot travel through JSON. This registry lets a
// web module attach a phone header (or the hide-the-bar convention) to an
// ALREADY-REGISTERED tab type at runtime, once its own component has loaded
// (e.g. tickets' `registerAppHooks()`, called right after its manifest
// registers). Keyed by the fully-qualified tab type ("tickets:ticket"), same
// as the tab type registry itself. `MainPanel` checks this as a fallback
// when the tab type's own registration carries neither field.

export interface PhoneHeaderRegistration {
  header?: Component<{ entityId: string }>
  hideTopBar?: boolean
}

const [phoneHeaderStore, setPhoneHeaderStore] = createStore<
  Record<string, PhoneHeaderRegistration>
>({})

export function registerPhoneHeader(
  tabType: string,
  header: Component<{ entityId: string }>,
): void {
  setPhoneHeaderStore(
    produce((s) => {
      s[tabType] = { ...s[tabType], header }
    }),
  )
}

export function registerPhoneTopBarHidden(tabType: string): void {
  setPhoneHeaderStore(
    produce((s) => {
      s[tabType] = { ...s[tabType], hideTopBar: true }
    }),
  )
}

export function unregisterPhoneHeader(tabType: string): void {
  setPhoneHeaderStore(
    produce((s) => {
      delete s[tabType]
    }),
  )
}

export function getPhoneHeader(tabType: string): Component<{ entityId: string }> | undefined {
  return phoneHeaderStore[tabType]?.header
}

export function getPhoneTopBarHidden(tabType: string): boolean {
  return phoneHeaderStore[tabType]?.hideTopBar ?? false
}

// ─── Activity Bar Registry ───────────────────────────────────────────

export interface ActivityBarEntry {
  id: string
  icon: Component<{ size?: number }>
  /** The English label. It is the fallback and, for an app that ships no
   *  catalog entry, the only label. It also seeds derived identifiers (the
   *  activity bar's test ids), so it never moves when a locale changes. */
  label: string
  /** Catalog key for the label a READER sees (`kernel.nav.*`). A registration
   *  that names one is translated; one that does not keeps `label`. */
  labelKey?: string
  order: number
  appId: string
  /** The feature of the tab type this entry opens: off, the entry is hidden. */
  feature?: string
  position?: "top" | "bottom"
  /**
   * True for an app whose UI arrives as an installed bundle (`/api/apps/<name>/
   * <version>/ui.js`) rather than shipping inside the web client. It is the one
   * signal that separates "a module of this product" from "an app someone
   * installed", which the phone Work screen groups by — derived at registration,
   * never a hardcoded name list.
   */
  external?: boolean
  /** A count the rail draws on the entry when it is above zero (the Messages
   *  entry's unread total). Read reactively. */
  badge?: () => number
  /** The badge's colour: `danger` (the default, Messages' unread) or
   *  `warning` (Sessions waiting on you: never the danger red, charter). */
  badgeTone?: "danger" | "warning"
  /** Other tab types under which the entry reads as the active one: Messages
   *  stays lit while a conversation opened from its sidebar is showing. */
  activeForTabTypes?: string[]
  tabAction: { type: string; entityId: string; label: string }
}

const [activityBarStore, setActivityBarStore] = createStore<{ entries: ActivityBarEntry[] }>({
  entries: [],
})

export function registerActivityBarEntry(entry: ActivityBarEntry): void {
  setActivityBarStore(
    produce((s) => {
      const idx = s.entries.findIndex((e) => e.id === entry.id)
      if (idx >= 0) s.entries[idx] = entry
      else s.entries.push(entry)
    }),
  )
}

export function unregisterActivityBarEntry(id: string): void {
  setActivityBarStore(
    produce((s) => {
      s.entries = s.entries.filter((e) => e.id !== id)
    }),
  )
}

/** The nav entries a reader sees: an app Off or restricted away (S19, S20) has none. Its
 *  registration stays, so its routes still resolve to the unavailable notice and
 *  turning it back On brings the entry back without a reload. Reactive. */
export function getActivityBarEntries(): ActivityBarEntry[] {
  return activityBarStore.entries.filter(
    (e) => !isAppUnavailable(e.appId) && !isFeatureOff(e.appId, e.feature),
  )
}

/**
 * Resolve an app identifier (as the agent's `open_app` tool passes it — e.g.
 * "tickets", "mail", "knowledge", "home", "settings") to a concrete tab action
 * the shell can open. Matches against the registered activity-bar entries by, in
 * priority order: exact tab-action type ("home"), the local id after the ":"
 * ("settings" -> "kernel:settings"), the app id ("tickets"), or a type prefix
 * ("tickets" -> "tickets:inbox"). Returns null when nothing matches (the caller
 * treats that as a harmless no-op).
 */
export function getAppTabAction(
  app: string,
): { type: string; entityId: string; label: string } | null {
  const key = app.trim().toLowerCase()
  if (!key) return null
  // An unavailable app (S19, S20) is not reachable by name either: open_app finds nothing.
  const entries = getActivityBarEntries()
  const localId = (type: string) => {
    const idx = type.indexOf(":")
    return idx >= 0 ? type.slice(idx + 1) : type
  }
  const matchers: Array<(e: ActivityBarEntry) => boolean> = [
    (e) => e.tabAction.type.toLowerCase() === key,
    (e) => localId(e.tabAction.type).toLowerCase() === key,
    (e) => e.appId.toLowerCase() === key,
    (e) => e.tabAction.type.toLowerCase().startsWith(`${key}:`),
  ]
  for (const matches of matchers) {
    const hit = entries.find(matches)
    if (hit) return hit.tabAction
  }
  return null
}

// ─── Settings Section Registry ───────────────────────────────────────

export interface SettingsSection {
  id: string
  /** The English label, and the fallback for a section with no catalog key. */
  label: string
  /** Catalog key for the label a READER sees (`kernel.nav.section.*`). */
  labelKey?: string
  badge?: string
  /** Catalog key for the badge a READER sees (`kernel.nav.badge*`). */
  badgeKey?: string
  href: string
  /** Former paths of this section: the layout sends them to `href`. */
  aliases?: string[]
  component: Component
  /** `connectors` is the Connectors page: its group heading is its link. */
  group?: "user" | "ai" | "admin" | "app" | "connectors"
  appId?: string
  adminScope?: string
  /** A feature the app declares: off, the section is absent for everyone. */
  feature?: string
  /**
   * An app's declarative settings page: the scope and admin scope of each of
   * its sections. The page is visible when the viewer sees at least one of
   * them (every user section; an org section when they hold its admin scope).
   */
  pageSections?: SettingsPageSectionAccess[]
  order: number
  /** When true, this section stays active for any pathname under `${href}/...`. */
  preserveActiveOnSubpaths?: boolean
  /** Optional resolver to pick a different component for sub-routes (e.g. detail pages). */
  resolveRoute?: (pathname: string) => Component | null | undefined
  /** When true, the route stays active but the section is hidden from the sidebar. */
  hidden?: boolean
  /**
   * Optional reactive predicate gating visibility. Returning false hides the
   * section from the sidebar (route stays addressable). Used for edition-conditional
   * tabs like the managed-mode Plan tab.
   */
  visibleWhen?: () => boolean
}

/** Who sees one section of an app's settings page. */
export interface SettingsPageSectionAccess {
  scope: "user" | "org"
  /** Org sections default to `kernel:apps:admin` (the server's default). */
  adminScope?: string
  /** The feature this section belongs to, and its app. */
  feature?: string
  appId?: string
}

const [settingsStore, setSettingsStore] = createStore<{ sections: SettingsSection[] }>({
  sections: [],
})

export function registerSettingsSection(section: SettingsSection): void {
  setSettingsStore(
    produce((s) => {
      const idx = s.sections.findIndex((e) => e.id === section.id)
      if (idx >= 0) s.sections[idx] = section
      else s.sections.push(section)
    }),
  )
}

export function unregisterSettingsSections(appId: string): void {
  setSettingsStore(
    produce((s) => {
      s.sections = s.sections.filter((sec) => !sec.id.startsWith(`${appId}:`))
    }),
  )
}

/** Drop one section by its id. */
export function unregisterSettingsSection(id: string): void {
  setSettingsStore(
    produce((s) => {
      s.sections = s.sections.filter((sec) => sec.id !== id)
    }),
  )
}

export function getSettingsSections(): SettingsSection[] {
  return settingsStore.sections
}

// Connectors (manifest `kind: "connector"`) have no settings row of their own:
// each is a card on the Connectors page. The page's group heading shows when
// the viewer administers one of them, so the registry keeps who sees each
// connector's sections.
const [connectorStore, setConnectorStore] = createStore<{
  apps: Record<string, SettingsPageSectionAccess[]>
}>({ apps: {} })

export function registerConnectorApp(appId: string, sections: SettingsPageSectionAccess[]): void {
  setConnectorStore("apps", appId, sections)
}

export function unregisterConnectorApp(appId: string): void {
  setConnectorStore(
    produce((s) => {
      delete s.apps[appId]
    }),
  )
}

/** Every registered connector with the access of its settings sections. */
export function getConnectorApps(): { appId: string; sections: SettingsPageSectionAccess[] }[] {
  return Object.entries(connectorStore.apps).map(([appId, sections]) => ({ appId, sections }))
}

// Manifest apps register their settings sections after first paint, once their
// UI bundles load. Until the first manifest sync settles, a settings path that
// no section claims yet may still belong to one of those apps.
const [manifestAppsSettled, setManifestAppsSettledSignal] = createSignal(false)

export function areManifestAppsSettled(): boolean {
  return manifestAppsSettled()
}

export function setManifestAppsSettled(settled: boolean): void {
  setManifestAppsSettledSignal(settled)
}

// ─── Command Registry ────────────────────────────────────────────────

export interface CommandRegistration {
  id: string
  label: string
  shortcut?: string
  scope?: string
  appId?: string
  localId?: string
  // An alias is a second id for a command that is already listed under its
  // canonical id. It stays executable (keybindings and recorded command ids
  // keep working) but it is hidden from the command palette, where it would
  // otherwise show up as a duplicate row with the same label.
  alias?: boolean
  execute: () => void
}

const [commandStore, setCommandStore] = createStore<{ commands: CommandRegistration[] }>({
  commands: [],
})
const commandAliases: AliasMap = new Map()

export function registerCommand(cmd: CommandRegistration): void {
  const existing = commandStore.commands.find((entry) => entry.id === cmd.id)
  if (existing) removeAlias(commandAliases, existing.localId ?? existing.id, existing.id)
  addAlias(commandAliases, cmd.localId ?? cmd.id, cmd.id)
  setCommandStore(
    produce((s) => {
      const idx = s.commands.findIndex((c) => c.id === cmd.id)
      if (idx >= 0) s.commands[idx] = cmd
      else s.commands.push(cmd)
    }),
  )
}

export function getCommands(): CommandRegistration[] {
  return commandStore.commands
}

export function unregisterCommand(id: string): void {
  const resolvedId = resolveAlias(commandAliases, id, (registryId) =>
    commandStore.commands.some((cmd) => cmd.id === registryId),
  )
  if (!resolvedId) return
  const cmd = commandStore.commands.find((entry) => entry.id === resolvedId)
  if (cmd) removeAlias(commandAliases, cmd.localId ?? cmd.id, resolvedId)
  setCommandStore(
    produce((s) => {
      s.commands = s.commands.filter((c) => c.id !== resolvedId)
    }),
  )
}

export function executeCommand(id: string): void {
  const resolvedId = resolveAlias(commandAliases, id, (registryId) =>
    commandStore.commands.some((cmd) => cmd.id === registryId),
  )
  const cmd = commandStore.commands.find((c) => c.id === resolvedId)
  cmd?.execute()
}

// ─── WS Entity Handler Registry ─────────────────────────────────────

export interface WsDispatchContext {
  currentUserId: string
  activeTabId: string | null
  isDocumentVisible: boolean
  isOwnAction: boolean
}

export interface WsMessage {
  type: string
  eventId?: number
  payload?: unknown
  users?: Record<string, "online" | "away" | "offline">
}

export type WsEntityHandler = (action: string, data: any, context: WsDispatchContext) => void

export interface WsEntityHandlerRegistration {
  handler: WsEntityHandler
  owner?: string
  priority?: number
}

interface WsHandlerEntry {
  appId: string
  owner: string
  priority: number
  handler: WsEntityHandler
}

const wsHandlers = new Map<string, WsHandlerEntry[]>()

export type WsMessageHandler = (message: WsMessage, context: WsDispatchContext) => void

export interface WsMessageHandlerRegistration {
  handler: WsMessageHandler
  owner?: string
  priority?: number
}

interface WsMessageHandlerEntry {
  appId: string
  owner: string
  priority: number
  handler: WsMessageHandler
}

const wsMessageHandlers = new Map<string, WsMessageHandlerEntry[]>()

export function registerWsEntityHandler(
  entity: string,
  appId: string,
  handler: WsEntityHandler,
  options: { owner?: string; priority?: number } = {},
): void {
  const owner = options.owner ?? entity
  const existing = (wsHandlers.get(entity) ?? []).filter(
    (entry) => entry.appId !== appId || entry.owner !== owner,
  )
  existing.push({ appId, owner, priority: options.priority ?? 0, handler })
  existing.sort(
    (a, b) =>
      a.priority - b.priority || a.appId.localeCompare(b.appId) || a.owner.localeCompare(b.owner),
  )
  wsHandlers.set(entity, existing)
}

export function getWsEntityHandlers(entity: string): WsEntityHandler[] {
  return (wsHandlers.get(entity) ?? []).map((e) => e.handler)
}

export function dispatchWsEntityEvent(
  entity: string,
  action: string,
  data: any,
  context: WsDispatchContext,
): void {
  for (const entry of wsHandlers.get(entity) ?? []) {
    entry.handler(action, data, context)
  }
}

export function registerWsMessageHandler(
  type: string,
  appId: string,
  handler: WsMessageHandler,
  options: { owner?: string; priority?: number } = {},
): void {
  const owner = options.owner ?? type
  const existing = (wsMessageHandlers.get(type) ?? []).filter(
    (entry) => entry.appId !== appId || entry.owner !== owner,
  )
  existing.push({ appId, owner, priority: options.priority ?? 0, handler })
  existing.sort(
    (a, b) =>
      a.priority - b.priority || a.appId.localeCompare(b.appId) || a.owner.localeCompare(b.owner),
  )
  wsMessageHandlers.set(type, existing)
}

export function getWsMessageHandlers(type: string): WsMessageHandler[] {
  return (wsMessageHandlers.get(type) ?? []).map((entry) => entry.handler)
}

export function dispatchWsMessage(
  type: string,
  message: WsMessage,
  context: WsDispatchContext,
): void {
  for (const entry of wsMessageHandlers.get(type) ?? []) {
    entry.handler(message, context)
  }
}

export function dispatchWsEventMessage(message: WsMessage, context: WsDispatchContext): void {
  dispatchWsMessage("event", message, context)
  const payload = message.payload
  if (!payload || typeof payload !== "object") return

  const app = "app" in payload ? payload.app : undefined
  const entity = "entity" in payload ? payload.entity : undefined
  const action = "action" in payload ? payload.action : undefined
  const data = "data" in payload ? payload.data : undefined
  const actorId = "actorId" in payload ? payload.actorId : undefined
  if (typeof entity !== "string" || typeof action !== "string") return

  const dispatchKey = typeof app === "string" ? `${app}:${entity}` : `kernel:${entity}`

  const enrichedContext: WsDispatchContext = {
    ...context,
    isOwnAction: typeof actorId === "string" && actorId === context.currentUserId,
  }
  dispatchWsEntityEvent(dispatchKey, action, data, enrichedContext)
  // After the handlers: stores are patched before load-once views refetch.
  notifyEntityChange({
    key: dispatchKey,
    app: typeof app === "string" ? app : "kernel",
    entity,
    action,
    data,
    actorId: typeof actorId === "string" ? actorId : null,
  })
}

export function unregisterWsEntityHandlers(appId: string): void {
  for (const [entity, entries] of wsHandlers) {
    wsHandlers.set(
      entity,
      entries.filter((e) => e.appId !== appId),
    )
  }
}

export function unregisterWsMessageHandlers(appId: string): void {
  for (const [type, entries] of wsMessageHandlers) {
    wsMessageHandlers.set(
      type,
      entries.filter((entry) => entry.appId !== appId),
    )
  }
}

// ─── Keybinding Registry ─────────────────────────────────────────────

export interface KeyBinding {
  id: string
  /** Key spec: "mod+p", "mod+shift+t", "n", "escape". "mod" = Cmd on Mac, Ctrl elsewhere */
  key: string
  label: string
  appId?: string
  localId?: string
  activeInInput?: boolean
  handler: (e: KeyboardEvent) => void
}

const [keybindingStore, setKeybindingStore] = createStore<{ bindings: KeyBinding[] }>({
  bindings: [],
})
const keybindingAliases: AliasMap = new Map()

export function registerKeybinding(binding: KeyBinding): void {
  const existing = keybindingStore.bindings.find((entry) => entry.id === binding.id)
  if (existing) removeAlias(keybindingAliases, existing.localId ?? existing.id, existing.id)
  addAlias(keybindingAliases, binding.localId ?? binding.id, binding.id)
  setKeybindingStore(
    produce((s) => {
      const idx = s.bindings.findIndex((b) => b.id === binding.id)
      if (idx >= 0) s.bindings[idx] = binding
      else s.bindings.push(binding)
    }),
  )
}

export function unregisterKeybinding(id: string): void {
  const resolvedId = resolveAlias(keybindingAliases, id, (registryId) =>
    keybindingStore.bindings.some((binding) => binding.id === registryId),
  )
  if (!resolvedId) return
  const binding = keybindingStore.bindings.find((entry) => entry.id === resolvedId)
  if (binding) removeAlias(keybindingAliases, binding.localId ?? binding.id, resolvedId)
  setKeybindingStore(
    produce((s) => {
      s.bindings = s.bindings.filter((b) => b.id !== resolvedId)
    }),
  )
}

export function getKeybindings(): KeyBinding[] {
  return keybindingStore.bindings
}

/**
 * Runs the first registered binding a keydown matches, and returns it. A
 * keydown typed into a field (an input, a textarea, an editable element) only
 * reaches bindings marked `activeInInput`, so typing a word into a search box
 * never fires a single-letter shortcut such as "n" for a new message.
 */
export function dispatchKeybinding(e: KeyboardEvent): KeyBinding | null {
  const target = e.target as HTMLElement | null
  const tag = target?.tagName
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true
  for (const binding of getKeybindings()) {
    if (!binding.activeInInput && isInput) continue
    if (matchesKey(e, binding.key)) {
      e.preventDefault()
      binding.handler(e)
      return binding
    }
  }
  return null
}

/** Cross-platform key matching. "mod" maps to Meta on Mac, Ctrl on Windows/Linux */
export function matchesKey(e: KeyboardEvent, keySpec: string): boolean {
  const parts = keySpec.toLowerCase().split("+")
  const key = parts[parts.length - 1]
  const hasMod = parts.includes("mod")
  const needsShift = parts.includes("shift")
  const needsAlt = parts.includes("alt")

  // "mod" → metaKey OR ctrlKey (accept both for maximum cross-platform compat)
  if (hasMod) {
    if (!e.metaKey && !e.ctrlKey) return false
  } else {
    // No mod requested — reject if either meta or ctrl is pressed
    if (e.metaKey || e.ctrlKey) return false
  }

  // For shifted characters like "?" (Shift+/), allow shiftKey even when
  // "shift" isn't explicit in the spec — the character itself implies Shift.
  // Only enforce strict shift matching for plain a-z / 0-9 keys.
  if (needsShift && !e.shiftKey) return false
  if (!needsShift && e.shiftKey && /^[a-z0-9]$/.test(key)) return false
  if (needsAlt !== e.altKey) return false
  return e.key.toLowerCase() === key
}

// ─── Slot & Contribution Registry ────────────────────────────────────

export interface SlotDeclaration {
  position: "tabs" | "toolbar" | "menu" | "sidebar" | "sections"
}

export interface ContributionEntry {
  appId: string
  component: Component<{ entityId?: string }>
  label: string
  /** Phase 17 — stable id used to correlate a server-filtered panel back to
   *  its locally-registered component. Optional for back-compat with legacy
   *  single-contribution-per-slot registrations that have no explicit id. */
  id?: string
}

const slots = new Map<string, SlotDeclaration>()
const [contributionStore, setContributionStore] = createStore<Record<string, ContributionEntry[]>>(
  {},
)

export function registerSlot(slotId: string, declaration: SlotDeclaration): void {
  slots.set(slotId, declaration)
}

export function unregisterSlot(slotId: string): void {
  slots.delete(slotId)
}

export function registerContribution(slotId: string, entry: ContributionEntry): void {
  setContributionStore(
    produce((s) => {
      if (!s[slotId]) s[slotId] = []
      s[slotId].push(entry)
    }),
  )
}

export function getContributions(slotId: string): ContributionEntry[] {
  return contributionStore[slotId] ?? []
}

export function unregisterContributions(appId: string): void {
  setContributionStore(
    produce((s) => {
      for (const slotId of Object.keys(s)) {
        s[slotId] = s[slotId].filter((e) => e.appId !== appId)
      }
    }),
  )
}

// ─── Entity Opener Registry ──────────────────────────────────────────

export interface TabTarget {
  tabType: string
  entityId: string
  label?: string
  /** Explicit router sub-path to land on (e.g. a Settings section). Passed
   *  straight through to `openTab`'s `routePath` — see `tab-store.ts`. */
  routePath?: string
}

export type EntityOpener = (api: ApiClient, id: string) => TabTarget | Promise<TabTarget>

const entityOpeners = new Map<string, EntityOpener>()

function entityOpenerKey(app: string, entityType: string): string {
  return `${app}:${entityType}`
}

export function registerEntityOpener(app: string, entityType: string, opener: EntityOpener): void {
  entityOpeners.set(entityOpenerKey(app, entityType), opener)
}

export function getEntityOpener(app: string, entityType: string): EntityOpener | undefined {
  return entityOpeners.get(entityOpenerKey(app, entityType))
}

// ─── App Route Registry ──────────────────────────────────────────────
//
// An app's BARE route names the APP, not one of its pages: `/boxtal` means
// "open Boxtal", and an app may declare extra aliases for the same thing (its
// rail label, or routes its definition lists). A tab type's `urlPattern`
// addresses one PAGE, so a bare route
// matched nothing unless an app happened to give its default page the bare
// pattern — which is the only reason `/monitoring` resolved while `/boxtal`
// and `/ads` fell through to Home. Registering the bare route once, alongside
// the activity-bar entry that already carries the app's default tab action,
// makes the whole class work rather than a list of paths.

const appRoutes = new Map<string, string>()

/** The comparable form of a route: leading slash, no trailing slash, lower case. */
export function normalizeAppRoute(path: string): string {
  const trimmed = path.trim().toLowerCase().replace(/\/+$/, "")
  if (!trimmed) return "/"
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/**
 * Record the routes that open `appId` at its default page. The app's own name
 * is always one of them and always wins; `aliases` are the extra names the app
 * answers to (its rail label, plus anything its manifest declares), and the
 * first app to claim an alias keeps it.
 */
export function registerAppRoutes(appId: string, aliases: string[] = []): void {
  unregisterAppRoutes(appId)
  appRoutes.set(normalizeAppRoute(`/${appId}`), appId)
  for (const alias of aliases) {
    const normalized = normalizeAppRoute(alias)
    if (normalized === "/") continue
    if (appRoutes.has(normalized)) continue
    appRoutes.set(normalized, appId)
  }
}

/**
 * The route form of a human label. An app's rail label is the name a reader
 * knows it by ("Monitoring", "Boxtal"), so it is the bare route they type or
 * bookmark. Derived, never a per-app list.
 */
export function appRouteSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function unregisterAppRoutes(appId: string): void {
  for (const [route, owner] of [...appRoutes]) {
    if (owner === appId) appRoutes.delete(route)
  }
}

/**
 * The tab info an app's default page would produce from its OWN canonical URL.
 * Routing the alias through the canonical pattern (rather than through the tab
 * action's raw entityId) means `/boxtal` and `/boxtal/shipments` open the
 * very same tab instead of two tabs onto one page.
 */
function appDefaultTabInfo(
  appId: string,
): { type: string; entityId: string; label: string } | null {
  const entry = activityBarStore.entries.find((e) => e.appId === appId)
  if (!entry) return null
  const reg = getTabType(entry.tabAction.type)
  if (!reg) return null
  const canonical = patternToUrl(reg.urlPattern, entry.tabAction.entityId)
  const match = matchUrlPattern(reg.urlPattern, canonical)
  if (!match) return null
  return {
    type: entry.tabAction.type,
    entityId: match.entityId,
    label: reg.defaultLabel ?? entry.tabAction.label,
  }
}

// ─── URL Pattern Helpers ─────────────────────────────────────────────

/** Convert a URL pattern like "/threads/:entityId" to a URL */
export function patternToUrl(pattern: string, entityId: string): string {
  // Multi-segment (`:entityId+`) pattern takes precedence so the `+`
  // suffix doesn't survive into the URL.
  if (pattern.includes(":entityId+")) {
    return pattern.replace(":entityId+", entityId)
  }
  // Replace the first single-segment :param (any name) with the entityId.
  return pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/, entityId)
}

/** Match a pathname against a URL pattern. Returns entityId if matched. */
export function matchUrlPattern(pattern: string, pathname: string): { entityId: string } | null {
  // Root "/" — exact match only
  if (pattern === "/") {
    return pathname === "/" ? { entityId: "home" } : null
  }
  // Phase 16.6 — `:entityId+` matches one OR MORE slash-delimited segments
  // (greedy multi-segment). Used by the kernel `detail` tab type where the
  // entityId is "<appName>/<entity>/<id>".
  if (pattern.includes(":entityId+")) {
    const escaped = pattern
      .replace(":entityId+", "__ENTITY_PLACEHOLDER__")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(`^${escaped.replace("__ENTITY_PLACEHOLDER__", "(.+)")}$`)
    const match = pathname.match(regex)
    return match ? { entityId: match[1] } : null
  }
  // Dynamic single-segment param of ANY name (`:entityId`, `:dashboardId`,
  // `:typeFilter`, `:documentId`, …). Plugins name their dynamic slot
  // descriptively in the manifest; the kernel tab system carries a single
  // dynamic value, so the first captured group is returned as `entityId`.
  // `:` is not a regex metachar, so the `:param` tokens survive the escape pass.
  if (/:[A-Za-z_][A-Za-z0-9_]*/.test(pattern)) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(`^${escaped.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "([^/]+)")}$`)
    const match = pathname.match(regex)
    return match ? { entityId: match[1] } : null
  }
  // Static patterns — exact or prefix match
  return pathname === pattern || pathname.startsWith(`${pattern}/`)
    ? { entityId: pattern.replace(/^\//, "") }
    : null
}

/** Match pathname against all registered tab types. Dynamic patterns first, then static (longest first), root last. */
export function urlToTabInfo(
  pathname: string,
): { type: string; entityId: string; label: string } | null {
  const types = getTabTypes()
  const entries = Object.entries(types)

  for (const [type, reg] of entries) {
    if (
      !/:[A-Za-z_][A-Za-z0-9_]*/.test(reg.urlPattern) &&
      reg.urlPattern !== "/" &&
      pathname === reg.urlPattern
    ) {
      const match = matchUrlPattern(reg.urlPattern, pathname)
      if (match) return { type, entityId: match.entityId, label: reg.defaultLabel }
    }
  }

  // A tab type that OWNS its sub routes answers the deeper path too. Without
  // this, `/agents/@ada/skills` falls past the single-segment `/agents/:entityId`
  // and is swallowed by the static `/agents` directory it happens to sit under,
  // so every sub-route deep link lands on the wrong tab. Only a dynamic pattern
  // declaring `preserveSubRoutes` is matched this way, against the pathname cut
  // back to the pattern's own depth.
  //
  // A deeper pattern that matches the WHOLE path wins over this cut-back match:
  // `/projects/tasks/<id>` belongs to the `task` tab, not to `/projects/:entityId`
  // with entityId "tasks". The cut-back pass is a fallback for paths no page owns
  // in full, which is exactly the `/agents/@ada/skills` case.
  const ownedInFull = entries.some(
    ([, reg]) =>
      /:[A-Za-z_][A-Za-z0-9_]*/.test(reg.urlPattern) &&
      matchUrlPattern(reg.urlPattern, pathname) !== null,
  )
  if (!ownedInFull) {
    for (const [type, reg] of entries) {
      if (!reg.preserveSubRoutes) continue
      if (!/:[A-Za-z_][A-Za-z0-9_]*/.test(reg.urlPattern)) continue
      const depth = reg.urlPattern.split("/").filter(Boolean).length
      const segments = pathname.split("/").filter(Boolean)
      if (segments.length <= depth) continue
      const match = matchUrlPattern(reg.urlPattern, `/${segments.slice(0, depth).join("/")}`)
      if (match) return { type, entityId: match.entityId, label: reg.defaultLabel }
    }
  }

  // Sort: dynamic patterns first (most specific), then static by length desc, root "/" last
  entries.sort(([, a], [, b]) => {
    const aIsDynamic = /:[A-Za-z_][A-Za-z0-9_]*/.test(a.urlPattern)
    const bIsDynamic = /:[A-Za-z_][A-Za-z0-9_]*/.test(b.urlPattern)
    if (aIsDynamic !== bIsDynamic) return aIsDynamic ? -1 : 1
    if (a.urlPattern === "/") return 1
    if (b.urlPattern === "/") return -1
    return b.urlPattern.length - a.urlPattern.length
  })

  for (const [type, reg] of entries) {
    const match = matchUrlPattern(reg.urlPattern, pathname)
    if (match) return { type, entityId: match.entityId, label: reg.defaultLabel }
  }

  // No page owns this path. An app's bare route (or a declared alias) opens
  // that app's DEFAULT page, which is the last thing to try so it can never
  // shadow a real page pattern.
  const appId = appRoutes.get(normalizeAppRoute(pathname))
  if (appId) return appDefaultTabInfo(appId)

  return null
}

// ─── Panel Registry ──────────────────────────────────────────────────

export interface PanelRegistration {
  component: Component<{ context?: unknown }>
  icon?: Component<{ size?: number }>
  label: string
  appId: string
  localType: string
}

const [panelStore, setPanelStore] = createStore<Record<string, PanelRegistration>>({})

export function registerPanel(id: string, reg: PanelRegistration): void {
  setPanelStore(id, reg)
}

export function unregisterPanels(appId: string): void {
  setPanelStore(
    produce((s) => {
      for (const id of Object.keys(s)) {
        if (s[id].appId === appId) delete s[id]
      }
    }),
  )
}

export function getPanel(id: string): PanelRegistration | undefined {
  return panelStore[id]
}

// ─── Entity External-Link Registry ───────────────────────────────────
//
// Records that an app's `views.detail.<entity>` declares an EXTERNAL-ONLY deep
// link (an `externalLink` with no in-app `component` — e.g. a Shopify order,
// which has no in-app tab and opens the Shopify admin instead). The frontend
// only needs the PRESENCE + display label here; the concrete URL is resolved
// server-side (the shop domain lives in the org connection), so `openEntity`
// pairs this synchronous "is this external-only?" check with the
// `/references/open-target` endpoint. Keyed `app:entity`, carries `appId` for
// teardown — same shape as the panel registry.

export interface EntityExternalLinkRegistration {
  /** Display label declared on the manifest externalLink (e.g. "Open in Shopify"). */
  label?: string
  appId: string
}

const [entityExternalLinkStore, setEntityExternalLinkStore] = createStore<
  Record<string, EntityExternalLinkRegistration>
>({})

export function registerEntityExternalLink(
  appId: string,
  entity: string,
  reg: { label?: string },
): void {
  setEntityExternalLinkStore(namespaceRegistryKey(appId, entity), { label: reg.label, appId })
}

export function unregisterEntityExternalLinks(appId: string): void {
  setEntityExternalLinkStore(
    produce((s) => {
      for (const id of Object.keys(s)) {
        if (s[id].appId === appId) delete s[id]
      }
    }),
  )
}

export function getEntityExternalLink(
  app: string,
  entity: string,
): EntityExternalLinkRegistration | undefined {
  return entityExternalLinkStore[namespaceRegistryKey(app, entity)]
}

// ─── Reset (test isolation) ──────────────────────────────────────────

// ─── Saved Views Handlers ─────────────────────────────────────────────

export interface SavedViewsHandler {
  capture: () => unknown
  apply: (payload: unknown) => void
}

const savedViewsHandlers = new Map<string, SavedViewsHandler>()

function savedViewsKey(appId: string, viewId: string): string {
  return `${appId}:${viewId}`
}

export function registerSavedViewsHandler(
  appId: string,
  viewId: string,
  handler: SavedViewsHandler,
): void {
  savedViewsHandlers.set(savedViewsKey(appId, viewId), handler)
}

export function unregisterSavedViewsHandlers(appId: string): void {
  for (const key of [...savedViewsHandlers.keys()]) {
    if (key.startsWith(`${appId}:`)) savedViewsHandlers.delete(key)
  }
}

export function getSavedViewsHandler(appId: string, viewId: string): SavedViewsHandler | undefined {
  return savedViewsHandlers.get(savedViewsKey(appId, viewId))
}

// ─── Manifest Cache (bulk, savedViews, entities) ─────────────────────

// Per-shared-field render hints, derived at manifest registration from the
// underlying tool's param schema so the bulk form can render the right widget
// (e.g. a <select> for an enum like closedReason) instead of a bare text input.
export interface BulkFieldSpec {
  type?: string
  enum?: string[]
  widget?: string
  label?: string
}

export interface ManifestBulkAction {
  label: string
  underlyingTool: string
  dispatchMode: "perItem" | "aggregate"
  perItemParam?: string
  selectionParam?: string
  sharedFields?: string[]
  fieldSpecs?: Record<string, BulkFieldSpec>
  minSelection?: number
  agentTool?: string
  customForm?: string
  icon?: string
}

export interface ManifestSavedViewDefault {
  key: string
  name: string
  payload: Record<string, unknown>
}

export interface ManifestSavedView {
  defaults?: ManifestSavedViewDefault[]
}

/** A label an app declares: its English words and the catalog key a reader's
 *  language is looked up by. */
export interface ManifestLabel {
  label: string
  labelKey?: string
}

export interface ManifestAppData {
  /** The heading over the app's attention items on Home. */
  attention?: { groupLabel?: ManifestLabel }
  bulk?: Record<string, ManifestBulkAction>
  savedViews?: Record<string, ManifestSavedView>
  entities?: Record<string, { handlePrefix?: string; readScope?: string }>
}

const manifestAppData = new Map<string, ManifestAppData>()
// Read by Home while apps are still loading: a label read tracks this version,
// so a heading re-renders when its app's manifest arrives.
const [manifestAppDataVersion, setManifestAppDataVersion] = createSignal(0)

export function registerManifestAppData(appId: string, data: ManifestAppData): void {
  manifestAppData.set(appId, data)
  setManifestAppDataVersion((v) => v + 1)
}

export function unregisterManifestAppData(appId: string): void {
  manifestAppData.delete(appId)
  setManifestAppDataVersion((v) => v + 1)
}

/** The heading an app declares over its attention items, if it declares one. */
export function getAttentionGroupLabel(appId: string): ManifestLabel | undefined {
  manifestAppDataVersion()
  return manifestAppData.get(appId)?.attention?.groupLabel
}

export function getManifestBulkActions(
  appId: string,
): Record<string, ManifestBulkAction> | undefined {
  return manifestAppData.get(appId)?.bulk
}

export function getManifestBulkAction(
  appId: string,
  action: string,
): ManifestBulkAction | undefined {
  return manifestAppData.get(appId)?.bulk?.[action]
}

// ─── Bulk UI Selection + Custom Forms ────────────────────────────────

export interface BulkUiSelection {
  accessor: () => string[]
  clear: () => void
  replace?: (ids: string[]) => void
  all?: () => string[]
}

export type BulkUiCustomForm = Component<{
  ids: string[]
  onSubmit: (params: Record<string, unknown>) => void
  onCancel: () => void
}>

const bulkUiSelections = new Map<string, BulkUiSelection>()
const bulkUiCustomForms = new Map<string, BulkUiCustomForm>()

function bulkUiKey(appId: string, viewIdOrAction: string): string {
  return `${appId}:${viewIdOrAction}`
}

export function registerBulkUiSelection(
  appId: string,
  viewId: string,
  selection: BulkUiSelection,
): void {
  bulkUiSelections.set(bulkUiKey(appId, viewId), selection)
}

export function registerBulkUiCustomForm(
  appId: string,
  action: string,
  form: BulkUiCustomForm,
): void {
  bulkUiCustomForms.set(bulkUiKey(appId, action), form)
}

export function unregisterBulkUi(appId: string): void {
  for (const key of [...bulkUiSelections.keys()]) {
    if (key.startsWith(`${appId}:`)) bulkUiSelections.delete(key)
  }
  for (const key of [...bulkUiCustomForms.keys()]) {
    if (key.startsWith(`${appId}:`)) bulkUiCustomForms.delete(key)
  }
}

export function getBulkUiSelection(appId: string, viewId: string): BulkUiSelection | undefined {
  return bulkUiSelections.get(bulkUiKey(appId, viewId))
}

export function getBulkUiCustomForm(appId: string, action: string): BulkUiCustomForm | undefined {
  return bulkUiCustomForms.get(bulkUiKey(appId, action))
}

export function resetRegistry(): void {
  const removedTabTypes = Object.keys(tabTypeStore)
  setTabTypeStore(reconcile({}))
  setTabTypeRegistryVersion((version) => version + 1)
  setActivityBarStore(reconcile({ entries: [] }))
  setSettingsStore(reconcile({ sections: [] }))
  setConnectorStore(reconcile({ apps: {} }))
  setCommandStore(reconcile({ commands: [] }))
  setKeybindingStore(reconcile({ bindings: [] }))
  setPanelStore(reconcile({}))
  setEntityExternalLinkStore(reconcile({}))
  setPhoneHeaderStore(reconcile({}))
  tabTypeAliases.clear()
  commandAliases.clear()
  keybindingAliases.clear()
  wsHandlers.clear()
  wsMessageHandlers.clear()
  slots.clear()
  setContributionStore(reconcile({}))
  entityOpeners.clear()
  savedViewsHandlers.clear()
  bulkUiSelections.clear()
  bulkUiCustomForms.clear()
  manifestAppData.clear()
  appRoutes.clear()
  setManifestAppsSettledSignal(false)
  notifyTabTypeRemoval(removedTabTypes)
}

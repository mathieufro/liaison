// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Slot enumeration (Phase 17, Task B9).
 *
 * Reads the in-memory `slotRegistry` populated at app-install time by
 * `apps/api/src/modules/apps/runtime.ts` and returns the panels contributed
 * to a given slot in the requested org, filtered by the caller's scopes.
 *
 * The web shell consumes this via `GET /api/v1/slots/:slot` (see
 * `apps/api/src/modules/slots/routes.ts`) and mounts each returned panel
 * inside the slot host (e.g. the contact-detail page renders an extension
 * panel below the core metadata block).
 *
 * Slots are populated when apps' manifests declare `slots.<slot_name>.panels`
 * (or `slots.<host_app>.<slot_id>.tabs` for nested slots). The catchall
 * permits per-app slot namespaces without a schema bump.
 *
 * Per Phase 17 spec §K5: visibility is enforced by `panel.visibility_scope`
 * which must be granted to the caller (via `~/modules/permissions/permissions.hasScope`).
 * Panels without a `visibility_scope` are public-to-the-org. An app the org
 * admin turned Off, or restricted away from the caller, contributes nothing, nor
 * does a panel naming a feature the org has not switched on; callers prime the
 * org app state.
 *
 * This is the one list: manifest `slots.<slot>.panels` and `.actions`, and
 * `contributions.<slot>` (merged into the registry by the runtime), all pass
 * the same filters and sort by `order`, then app name, then id.
 */
import { type SlotRegistryEntry, slotRegistry } from "~/modules/apps/app-registries"
import { isAppUnavailableFor, isFeatureOffForTool } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"

export interface SlotPanel {
  id: string
  label: string
  component: string
  labelKey?: string
  order?: number
  group?: string
  visibility_scope?: string
  feature?: string
}

export interface ResolvedPanel extends SlotPanel {
  /** App that contributed the panel — the web shell uses this to look up the UI bundle. */
  app: string
}

export interface ListSlotPanelsOpts {
  orgId: string
  scopes: string[]
  slot: string
  /** The caller. Without one, an app restricted to some people shows nobody its panels. */
  userId?: string | null
}

/**
 * Put an app's manifest `slots` and `contributions` into the registry for one
 * org. A contribution joins the slot's panel list with its component name as
 * its id (the web registers it under the same id), so the scope, app-state and
 * feature filters apply to it like any panel. Called by the app runtime.
 *
 * Each slot's entry is built from this version's manifest alone: a re-registration
 * (a live upgrade) replaces what the previous version contributed rather than
 * adding to it, so a panel is listed once and a panel the new version dropped is gone.
 */
export function registerAppSlots(
  orgId: string,
  app: string,
  slots: Record<string, unknown> | undefined,
  contributions: Record<string, unknown> | undefined,
): void {
  const entries = new Map<string, SlotRegistryEntry>()
  for (const [slotName, slotDef] of Object.entries(slots ?? {})) {
    entries.set(slotName, slotDef as SlotRegistryEntry)
  }
  for (const [slot, raw] of Object.entries(contributions ?? {})) {
    const contribution = raw as Omit<SlotPanel, "id">
    const current = entries.get(slot) ?? {}
    entries.set(slot, {
      ...current,
      panels: [
        ...(Array.isArray(current.panels) ? current.panels : []),
        { ...contribution, id: contribution.component },
      ],
    })
  }
  for (const [slot, entry] of entries) slotRegistry.set([orgId, app, slot], entry)
}

function visible(orgId: string, app: string, panel: SlotPanel, scopes: string[]): boolean {
  if (panel.visibility_scope && !hasScope(panel.visibility_scope, scopes)) return false
  return !isFeatureOffForTool(orgId, { appName: app, feature: panel.feature })
}

function byOrderThenApp(a: ResolvedPanel, b: ResolvedPanel): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY
  const bo = b.order ?? Number.POSITIVE_INFINITY
  if (ao !== bo) return ao - bo
  if (a.app !== b.app) return a.app.localeCompare(b.app)
  return a.id.localeCompare(b.id)
}

/**
 * Enumerate all panels contributed to `slot` in `orgId`, filtered by the
 * caller's scopes. Returns sorted by `order` (ascending). Never returns
 * panels from other orgs; never throws for empty registries.
 */
export function listSlotPanels(opts: ListSlotPanelsOpts): ResolvedPanel[] {
  const out: ResolvedPanel[] = []

  // Nested form: `<host>.<slot_id>.tabs` (e.g. `invoicing.document_detail.tabs`).
  // Apps contribute tabs to a host slot by declaring
  // `slots.<host>.<slot_id>.tabs` in their manifest, which the runtime stores
  // under registry key [orgId, <contributing-app>, <host>] with value
  // `{ <slot_id>: { tabs: SlotPanel[] } }`. We split the dotted slot string and
  // read the nested array. A malformed (non-three-part) slot resolves to [].
  const parts = opts.slot.split(".")
  if (parts.length > 1) {
    if (parts.length !== 3) return [] // only `<host>.<slot_id>.tabs` is supported
    const [host, slotId, kind] = parts as [string, string, string]
    for (const [key, value] of slotRegistry.entriesOf(opts.orgId)) {
      const [orgId, app, slotName] = key
      if (orgId !== opts.orgId) continue
      if (slotName !== host) continue
      // An Off app (S19) keeps its data but shows no surface, embedded ones included.
      if (isAppUnavailableFor(opts.orgId, app, opts.userId)) continue
      const nested = (
        value as Record<string, { [k: string]: SlotPanel[] } | undefined> | undefined
      )?.[slotId]
      const tabs = nested?.[kind] ?? []
      for (const tab of tabs) {
        if (!visible(opts.orgId, app, tab, opts.scopes)) continue
        out.push({ ...tab, app })
      }
    }
    return out.sort(byOrderThenApp)
  }

  for (const [key, value] of slotRegistry.entriesOf(opts.orgId)) {
    const [orgId, app, slotName] = key
    if (orgId !== opts.orgId) continue
    if (slotName !== opts.slot) continue
    // Off for the org, or restricted away from this person: the same rule as its tools.
    if (isAppUnavailableFor(opts.orgId, app, opts.userId)) continue
    // slotDef shape from the manifest: { panels?, actions? }. Nested tabs go
    // through the `<host>.<slot_id>.tabs` branch above.
    const slotDef = value as { panels?: SlotPanel[]; actions?: SlotPanel[] } | undefined
    const entries = [
      ...(Array.isArray(slotDef?.panels) ? slotDef.panels : []),
      ...(Array.isArray(slotDef?.actions) ? slotDef.actions : []),
    ]
    for (const panel of entries) {
      if (!visible(opts.orgId, app, panel, opts.scopes)) continue
      out.push({ ...panel, app })
    }
  }
  return out.sort(byOrderThenApp)
}

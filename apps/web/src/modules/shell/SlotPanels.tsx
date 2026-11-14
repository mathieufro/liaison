// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SlotPanels — mounts the panels and actions other apps contribute to a named
 * slot of a host page (a ticket, a task, a project, a contact, a mail
 * conversation).
 *
 * Data flow:
 *   1. `GET /api/v1/slots/:slot` is the one list (apps/api/src/modules/slots/
 *      registry.ts): what the viewer may see, from apps the org has on, with
 *      their features on, sorted by `order` then app name. Manifest
 *      `slots.<slot>.panels` / `.actions` and `contributions.<slot>` both land
 *      there.
 *   2. Each returned entry `{ app, id }` is matched to the component the app's
 *      UI registered locally (`registerAppFromManifest`). An app that runs in a
 *      sandboxed frame registers its frame as that component, so it draws inside
 *      its frame.
 *   3. Each panel sits in its own error boundary: a panel that throws, or whose
 *      bundle did not load, shows `slot-panel-unavailable-<app>-<id>` and the
 *      host page stands. A failed list, or an empty one, renders nothing.
 */

import {
  type Accessor,
  type Component,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  Show,
  Suspense,
} from "solid-js"
import { getContributions } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

export interface ServerSlotPanel {
  id: string
  app: string
  label: string
  labelKey?: string
  component: string
  order?: number
  group?: string
}

export interface SlotEntry {
  panel: ServerSlotPanel
  component: Component<Record<string, unknown>> | undefined
}

/** Where the host draws the slot: stacked panels, an inline row of actions, or a tab strip. */
export type SlotPosition = "panel" | "actions" | "tabs"

async function fetchSlotPanels(
  api: ReturnType<typeof useApi>,
  slot: string,
  forTool?: string,
): Promise<ServerSlotPanel[]> {
  // Relative to the API base: `/v1/slots/:slot` is `/api/v1/slots/:slot` on the wire.
  const query = forTool ? `?for_tool=${encodeURIComponent(forTool)}` : ""
  const res = await api.get<{ panels: ServerSlotPanel[] }>(`/v1/slots/${slot}${query}`)
  return Array.isArray(res?.panels) ? res.panels : []
}

/**
 * The entries of one slot for this viewer, each with its local component (or
 * none when the app's UI did not load). Never throws: a failed list reads as
 * empty, so a host can count the entries (the phone's More sheet) safely.
 */
export function createSlotPanels(
  slot: Accessor<string>,
  /** The tool the host is about (an approval card's): panels contributed for that tool only. */
  forTool?: Accessor<string | undefined>,
): Accessor<SlotEntry[]> {
  const api = useApi()
  const key = () => ({ slot: slot(), forTool: forTool?.() })
  const [panels] = createResource(key, async (k) => {
    try {
      return await fetchSlotPanels(api, k.slot, k.forTool)
    } catch {
      return []
    }
  })
  return createMemo(() => {
    // A resource read throws once it holds an error: check before reading.
    if (panels.error) return []
    const list = panels.latest ?? []
    const local = getContributions(slot())
    return list.map((panel) => ({
      panel,
      component: local.find((c) => c.appId === panel.app && (c.id ?? "") === panel.id)
        ?.component as SlotEntry["component"],
    }))
  })
}

interface SlotPanelsProps {
  slot: string
  /** The host record (ticket, task, project, contact): passed as `entityId` to each panel. */
  entityId?: string
  /** `panel` (default) stacks them; `actions` is an inline row; `tabs` a tab strip. */
  position?: SlotPosition
  /** Props an older host contract also passes (a ticket panel's `ticketId`). */
  panelProps?: Record<string, unknown>
  /** Entries the host already read with `createSlotPanels` (it also counts them). */
  entries?: Accessor<SlotEntry[]>
  class?: string
}

function SlotPanelUnavailable(props: { panel: ServerSlotPanel }): JSX.Element {
  const i18n = useI18n()
  return (
    <div
      data-testid={`slot-panel-unavailable-${props.panel.app}-${props.panel.id}`}
      class="text-sm text-text-tertiary"
    >
      {i18n.t("kernel.shellUi.panelUnavailable")}
    </div>
  )
}

/** One contributed component, contained: a throw or a missing bundle costs this panel only. */
export function SlotEntryView(props: {
  entry: SlotEntry
  entityId?: string
  panelProps?: Record<string, unknown>
}): JSX.Element {
  return (
    <ErrorBoundary fallback={() => <SlotPanelUnavailable panel={props.entry.panel} />}>
      {/* Its own loading boundary: a panel's first fetch never blanks the host page. */}
      <Suspense>
        <Show
          when={props.entry.component}
          fallback={<SlotPanelUnavailable panel={props.entry.panel} />}
        >
          {(C) => {
            const Resolved = C()
            return <Resolved {...(props.panelProps ?? {})} entityId={props.entityId} />
          }}
        </Show>
      </Suspense>
    </ErrorBoundary>
  )
}

export const SlotPanels: Component<SlotPanelsProps> = (props) => {
  const i18n = useI18n()
  const entries = props.entries ?? createSlotPanels(() => props.slot)
  const position = () => props.position ?? "panel"
  const [selected, setSelected] = createSignal<string | null>(null)
  const keyOf = (e: SlotEntry) => `${e.panel.app}-${e.panel.id}`
  const current = () => {
    const list = entries()
    return list.find((e) => keyOf(e) === selected()) ?? list[0]
  }
  const label = (p: ServerSlotPanel) => (p.labelKey ? i18n.t(p.labelKey) : p.label)

  return (
    <Show when={entries().length > 0}>
      <div
        data-testid={`slot-panels-${props.slot}`}
        data-position={position()}
        class={props.class}
        classList={{ "flex items-center gap-1": position() === "actions" }}
      >
        <Show
          when={position() === "tabs"}
          fallback={
            <For each={entries()}>
              {(entry) => (
                <SlotEntryView
                  entry={entry}
                  entityId={props.entityId}
                  panelProps={props.panelProps}
                />
              )}
            </For>
          }
        >
          <div role="tablist" class="flex gap-3 border-b border-border-subtle">
            <For each={entries()}>
              {(entry) => (
                <button
                  type="button"
                  role="tab"
                  data-testid={`slot-tab-${keyOf(entry)}`}
                  aria-selected={current() === entry}
                  class="-mb-px border-b-2 px-0.5 pb-1.5 text-[12.5px]"
                  classList={{
                    "border-accent text-text": current() === entry,
                    "border-transparent text-text-tertiary": current() !== entry,
                  }}
                  onClick={() => setSelected(keyOf(entry))}
                >
                  {label(entry.panel)}
                </button>
              )}
            </For>
          </div>
          <Show when={current()} keyed>
            {(entry) => (
              <div role="tabpanel" class="pt-3">
                <SlotEntryView
                  entry={entry}
                  entityId={props.entityId}
                  panelProps={props.panelProps}
                />
              </div>
            )}
          </Show>
        </Show>
      </div>
    </Show>
  )
}

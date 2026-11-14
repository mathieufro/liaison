// SPDX-License-Identifier: FSL-1.1-ALv2
// One section of an app page: its heading with the "Just you" / "Organization"
// badge (S13; none on an org section that can hold a personal connection), then its blocks in schema order. A section whose fields share one
// tool setter saves as one unit behind a Save bar (M1); every other field saves
// on its own.
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { appsStore } from "~/modules/settings/apps-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { ConnectionsBlock, canAdministerConnection } from "./ConnectionsBlock"
import { CustomBlock } from "./CustomBlock"
import { FieldBlock } from "./fields"
import { ListBlock } from "./ListBlock"
import { useAppPage } from "./page-context"
import { labelOf, unitSetTool } from "./page-model"
import { settingsSectionElementId } from "./reveal-section"
import type { SaveOutcome, UnitSaveOutcome } from "./settings-api"
import { isSupportedSettingsBlock } from "./supported"
import { TreeBlock } from "./TreeBlock"
import type { SettingsBlock, SettingsSection } from "./types"
import { UnsupportedSettingsPart } from "./UnsupportedSettingsPart"

const P = "kernel.settingsPage"

export interface SectionViewProps {
  app: string
  section: SettingsSection
  /** Field values of the section's scope, by key. */
  value: (key: string) => unknown
  readError: (key: string) => { code: string; message: string } | undefined
  save: (path: string, value: unknown) => Promise<SaveOutcome>
  /** Save a section saved as one unit (several fields of one tool setter). */
  saveUnit?: (values: Record<string, unknown>) => Promise<UnitSaveOutcome>
  onSaved: (path: string, value: unknown) => void
  exports?: Record<string, unknown>
  openConnection?: string
  /** Inside a connector card: a smaller heading. */
  compact?: boolean
}

export const SectionView: Component<SectionViewProps> = (props) => {
  const i18n = useI18n()
  const title = () => labelOf(i18n.t, props.section.titleKey, props.section.title)
  const description = () =>
    props.section.description
      ? labelOf(i18n.t, props.section.descriptionKey, props.section.description)
      : undefined
  // An app may draw a note under a section's blocks: its UI export named after the section id,
  // then "SettingsNote" (the section "time" reads `TimeSettingsNote`). Nothing is shown without one.
  const sectionNote = (): Component | null => {
    const id = props.section.id
    const note = props.exports?.[`${id.charAt(0).toUpperCase()}${id.slice(1)}SettingsNote`]
    return typeof note === "function" ? (note as Component) : null
  }
  const headingId = () => `settings-section-h-${props.app}-${props.section.id}`
  const fieldsOnly = () => props.section.blocks.every((b) => b.block === "field")
  // A connect form offers Personal and Organization to whoever administers the
  // connection, and only Personal to anyone else; a named-instance connection is
  // always the org's. So an org section with a connection a person can hold says
  // nothing, nor does an open section to an admin (Organization is on offer
  // there); "Just you" stays true for a member. Unknown until they are listed.
  const showScopeBadge = () => {
    const blocks = props.section.blocks.flatMap((b) => (b.block === "connections" ? [b] : []))
    if (blocks.length === 0) return true
    const shown = appsStore
      .connectionsFor(props.app)
      .filter((c) => blocks.some((b) => !b.names || b.names.includes(c.name)))
    if (shown.length === 0) return false
    return props.section.scope === "user"
      ? !shown.some((c) => canAdministerConnection(props.app, c))
      : shown.every((c) => c.multiInstance)
  }

  // A section whose fields share one tool setter saves as one unit (M1): edits
  // wait here, one Save bar sends them together.
  const unit = () => (props.saveUnit ? unitSetTool(props.section) !== null : false)
  const page = useAppPage()
  const unitId = () => `${props.section.id}-unit`
  const [draft, setDraft] = createSignal<Record<string, unknown>>({})
  const [unitSaving, setUnitSaving] = createSignal(false)
  const [unitPending, setUnitPending] = createSignal(false)
  const [unitError, setUnitError] = createSignal<string | null>(null)
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const changed = () =>
    Object.entries(draft()).filter(([k, v]) => !same(v, props.value(k))) as Array<[string, unknown]>
  createEffect(() => page?.setDirty(unitId(), unit() && changed().length > 0))
  onCleanup(() => page?.setDirty(unitId(), false))
  if (page) {
    createEffect(
      on(
        page.reloadToken,
        () => {
          setDraft({})
          setUnitPending(false)
          setUnitError(null)
        },
        { defer: true },
      ),
    )
  }
  const fieldValue = (key: string) => {
    const d = draft()
    return key in d ? d[key] : props.value(key)
  }
  async function saveUnit(): Promise<void> {
    const save = props.saveUnit
    const values = Object.fromEntries(changed())
    if (!save || Object.keys(values).length === 0) return
    setUnitSaving(true)
    setUnitError(null)
    try {
      const out = await save(values)
      if (out.kind === "pending") {
        setUnitPending(true)
        return
      }
      for (const [k, v] of Object.entries(out.values)) props.onSaved(k, v)
      setDraft({})
      addToast({ message: i18n.t(`${P}.savedToast`), type: "success" })
    } catch (err) {
      setUnitError(err instanceof Error ? err.message : String(err))
    } finally {
      setUnitSaving(false)
    }
  }

  const block = (b: SettingsBlock, index: number) => {
    const blockId = `${props.section.id}-${index}`
    // A block or field type from a newer server than this build (supported.ts).
    if (!isSupportedSettingsBlock(b)) {
      const label = (b as { label?: unknown }).label
      return <UnsupportedSettingsPart label={typeof label === "string" ? label : undefined} />
    }
    return (
      <Switch fallback={<UnsupportedSettingsPart />}>
        <Match when={b.block === "field" && b}>
          {(f) => (
            <FieldBlock
              app={props.app}
              field={f()}
              value={unit() ? fieldValue(f().key) : props.value(f().key)}
              readError={props.readError(f().key)}
              readOnly={unit() && (unitPending() || unitSaving())}
              save={props.save}
              onSaved={(v) => props.onSaved(f().key, v)}
              onDraft={
                unit()
                  ? (v) => {
                      setUnitError(null)
                      setDraft((d) => ({ ...d, [f().key]: v }))
                    }
                  : undefined
              }
            />
          )}
        </Match>
        <Match when={b.block === "list" && b}>
          {(l) => <ListBlock app={props.app} block={l()} blockId={blockId} />}
        </Match>
        <Match when={b.block === "tree" && b}>
          {(t) => <TreeBlock app={props.app} block={t()} blockId={blockId} />}
        </Match>
        <Match when={b.block === "connections" && b}>
          {(c) => (
            <ConnectionsBlock
              app={props.app}
              block={c()}
              blockId={blockId}
              openConnection={props.openConnection}
              personalSection={props.section.scope === "user"}
            />
          )}
        </Match>
        <Match when={b.block === "custom" && b}>
          {(c) => <CustomBlock app={props.app} block={c()} exports={props.exports} />}
        </Match>
      </Switch>
    )
  }

  return (
    <section
      id={settingsSectionElementId(props.app, props.section.id)}
      tabIndex={-1}
      aria-labelledby={headingId()}
      data-testid={`settings-section-${props.section.id}`}
      class={props.compact ? "mt-5 first:mt-0" : "mt-9 first:mt-0"}
    >
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2
            id={headingId()}
            class={cn(
              "flex flex-wrap items-center gap-2 font-semibold leading-snug",
              props.compact ? "text-[13.5px]" : "text-[15px]",
            )}
          >
            {title()}
            <Show when={showScopeBadge()}>
              <span
                class="rounded-full border border-border px-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary"
                title={
                  props.section.scope === "user"
                    ? i18n.t(`${P}.justYouHint`)
                    : i18n.t(`${P}.organizationHint`)
                }
                data-testid={`settings-section-scope-${props.section.id}`}
              >
                {props.section.scope === "user"
                  ? i18n.t(`${P}.justYou`)
                  : i18n.t(`${P}.organization`)}
              </span>
            </Show>
          </h2>
          <Show when={description()}>
            <p class="mt-0.5 text-[12.5px] text-text-secondary">{description()}</p>
          </Show>
        </div>
      </div>
      <div
        class={cn(
          "flex flex-col",
          fieldsOnly() ? "gap-4 rounded-lg border border-border bg-surface p-4" : "gap-4",
        )}
      >
        <For each={props.section.blocks}>{(b, i) => block(b, i())}</For>
        <Show when={sectionNote()}>{(note) => <Dynamic component={note()} />}</Show>
        <Show when={unit() && unitPending()}>
          <div
            class="text-xs text-text-secondary"
            data-testid={`settings-unit-pending-${props.section.id}`}
          >
            {i18n.t(`${P}.waitingApproval`)}
          </div>
        </Show>
        <Show when={unit() && unitError()}>
          <div class="text-xs text-error" data-testid={`settings-unit-error-${props.section.id}`}>
            {unitError()}
          </div>
        </Show>
        <Show when={unit() && !unitPending() && changed().length > 0}>
          <div
            class="sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-2 shadow-popover"
            data-testid={`settings-unit-bar-${props.section.id}`}
          >
            <span
              class="min-w-0 flex-1 text-[13px]"
              data-testid={`settings-unit-count-${props.section.id}`}
            >
              {changed().length === 1
                ? i18n.t(`${P}.unsavedOne`)
                : i18n.t(`${P}.unsaved`, { count: changed().length })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`settings-unit-discard-${props.section.id}`}
              onClick={() => {
                setDraft({})
                setUnitError(null)
              }}
            >
              {i18n.t(`${P}.discard`)}
            </Button>
            <Button
              size="sm"
              loading={unitSaving()}
              data-testid={`settings-unit-save-${props.section.id}`}
              onClick={() => void saveUnit()}
            >
              {i18n.t(`${P}.save`)}
            </Button>
          </div>
        </Show>
      </div>
    </section>
  )
}

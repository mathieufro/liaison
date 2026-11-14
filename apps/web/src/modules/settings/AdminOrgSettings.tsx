// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, createResource, createSignal, For, on, Show } from "solid-js"
import { getTimezones } from "~/lib/timezones"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { ContextualSaveBar } from "~/modules/shell/save-bar/ContextualSaveBar"
import { addToast } from "~/modules/shell/toast-store"
import { Input } from "~/ui/Input"
import { billingMode } from "./BillingState"
import CommercialIdentitySection from "./CommercialIdentitySection"
import EmailSenderSection from "./EmailSenderSection"

interface OrgData {
  id: string
  name: string
  timezone?: string
  defaultLocale?: string
}

const KNOWN_TIMEZONES = new Set(getTimezones())

const AdminOrgSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [org, { refetch }] = createResource(async () => {
    const res = (await api.get("/org")) as OrgData | { data?: OrgData }
    return ("data" in (res as any) ? (res as any).data : res) as OrgData | null
  })

  const [name, setName] = createSignal("")
  const [timezone, setTimezone] = createSignal("")
  const [defaultLocale, setDefaultLocale] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [tzManual, setTzManual] = createSignal("")
  const [original, setOriginal] = createSignal<OrgData | null>(null)

  createEffect(
    on(org, (o) => {
      if (!o) return
      setOriginal(o)
      setName(o.name)
      setTimezone(o.timezone ?? "")
      setDefaultLocale(o.defaultLocale ?? "")
      setTzManual("")
    }),
  )

  const effectiveTz = () => tzManual() || timezone()
  const tzInvalid = () => effectiveTz().length > 0 && !KNOWN_TIMEZONES.has(effectiveTz())

  function dirty(): boolean {
    const o = original()
    if (!o) return false
    return (
      name() !== o.name ||
      effectiveTz() !== (o.timezone ?? "") ||
      defaultLocale() !== (o.defaultLocale ?? "")
    )
  }

  async function handleSave() {
    if (!dirty() || tzInvalid()) return
    setSaving(true)
    try {
      await api.patch("/org", {
        name: name(),
        timezone: effectiveTz() || undefined,
        defaultLocale: defaultLocale() || undefined,
      })
      await refetch()
      addToast({ message: i18n.t("kernel.settingsUi.organizationUpdated"), type: "success" })
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToUpdateOrganization"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    const o = original()
    if (!o) return
    setName(o.name)
    setTimezone(o.timezone ?? "")
    setDefaultLocale(o.defaultLocale ?? "")
    setTzManual("")
  }

  return (
    <div>
      <ContextualSaveBar
        dirty={dirty() && !tzInvalid()}
        saving={saving()}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
      <Show when={org()}>
        <div class="flex flex-col gap-4">
          <Input
            label={i18n.t("kernel.settingsUi.organizationName")}
            value={name()}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          />
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-text-secondary">
              {i18n.t("kernel.timezone")}
            </label>
            <select
              aria-label={i18n.t("kernel.timezone")}
              value={timezone()}
              onChange={(e) => {
                setTimezone(e.currentTarget.value)
                setTzManual("")
              }}
              class="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text"
              data-testid="admin-org-timezone-select"
            >
              <option value="">{i18n.t("kernel.selectTimezone")}</option>
              <For each={getTimezones()}>{(tz) => <option value={tz}>{tz}</option>}</For>
            </select>
            <input
              type="text"
              placeholder={i18n.t("kernel.orTypeATimezone")}
              value={tzManual()}
              onInput={(e) => setTzManual(e.currentTarget.value)}
              class="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text"
              data-testid="admin-org-timezone-manual"
            />
            <Show when={tzInvalid()}>
              <p class="text-xs text-danger" data-testid="admin-org-timezone-error">
                {i18n.t("kernel.settingsUi.invalidTimezone")}
              </p>
            </Show>
          </div>
          <Input
            label={i18n.t("kernel.settingsUi.defaultLocale")}
            value={defaultLocale()}
            placeholder={i18n.t("kernel.eGEnUs")}
            onInput={(e) => setDefaultLocale((e.currentTarget as HTMLInputElement).value)}
          />
          <div>
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
              disabled={!dirty() || tzInvalid() || saving()}
              onClick={handleSave}
              data-testid="admin-org-save"
            >
              {i18n.t("kernel.common.save")}
            </button>
          </div>
          {/* What every commercial mail states about its sender: org admins. */}
          <Show when={canAccessScope("kernel:org:admin")}>
            <div class="border-t border-border pt-4">
              <CommercialIdentitySection />
            </div>
          </Show>
          {/* The org's own sending domain (S29): managed edition, org admins. */}
          <Show when={billingMode() === "managed" && canAccessScope("kernel:org:admin")}>
            <div class="border-t border-border pt-4">
              <EmailSenderSection orgName={original()?.name ?? name()} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default AdminOrgSettings

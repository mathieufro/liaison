// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EinvoicingRegistration: the read-out under the e-invoicing fields of the
// declarative settings page (manifest `settings`, section "E-invoicing"). What
// the bound platform reports, in plain words: whether emission is activated
// and whether status updates arrive by webhook. The platform, cut-over date and
// send / booking switches are plain fields of the same section, saved through
// `einvoicing_settings_set`.
import { app, onEntityChange } from "@liaison/host"
import { type Component, createResource, For, onCleanup } from "solid-js"
import { tr } from "../i18n"

export interface EinvoicingSettingsData {
  status: string
  settings: {
    provider_app: string | null
    cutover_date: string | null
    send_enabled: boolean
    book_enabled: boolean
  }
  providers: string[]
  registration: {
    emission_activated?: boolean
    webhook?: { configured: boolean }
    status?: string
    error?: { message?: string }
  } | null
}

/** Plain-words lines about the bound platform. */
export function registrationLines(d: EinvoicingSettingsData | null): string[] {
  if (!d?.settings.provider_app)
    return [tr("No e-invoicing platform is set: nothing is sent or booked.")]
  const r = d.registration
  if (!r || r.status === "error")
    return [
      tr("The platform could not be reached: {{reason}}", { reason: r?.error?.message ?? "-" }),
    ]
  return [
    r.emission_activated
      ? tr("Emission is activated on the platform.")
      : tr("Emission is not activated on the platform yet: e-invoices wait until it is."),
    r.webhook?.configured
      ? tr("Status updates arrive by webhook.")
      : tr("Status updates are read every three hours (no webhook set up)."),
  ]
}

async function load(): Promise<EinvoicingSettingsData | null> {
  try {
    return await app.invokeTool<EinvoicingSettingsData>("einvoicing_settings_get", {})
  } catch {
    return null
  }
}

export const EinvoicingRegistration: Component = () => {
  const [data, { refetch }] = createResource(load)
  // Saving the platform above emits its binding change: read the platform again, so the lines
  // never keep saying what was true before the save.
  onCleanup(onEntityChange("invoicing:einvoicing", () => void refetch()))
  return (
    <ul
      data-testid="settings-einvoicing-registration"
      class="flex flex-col gap-0.5 text-[12.5px] text-text-secondary"
    >
      <For each={data.loading ? [] : registrationLines(data() ?? null)}>{(l) => <li>{l}</li>}</For>
    </ul>
  )
}

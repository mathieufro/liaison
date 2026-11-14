// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings → Organization → Commercial identity (org admins). The legal name
// and postal address every commercial mail ends with, beside its opt-out link.
// Until both are set the send check refuses commercial mail and names this
// section. `PUT /api/org/settings/commercial-identity` keeps the country policy
// the org already has (or the default).
import { type Component, createResource, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Input } from "~/ui/Input"

interface CommercialIdentity {
  legalName: string
  postalAddress: string
  countryPolicy?: Record<string, "optout" | "consent">
}

const CommercialIdentitySection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [legalName, setLegalName] = createSignal("")
  const [postalAddress, setPostalAddress] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const [loaded] = createResource(async () => {
    const res = await api.get<{ commercialIdentity: CommercialIdentity | null }>(
      "/org/settings/commercial-identity",
    )
    const current = res.commercialIdentity
    setLegalName(current?.legalName ?? "")
    setPostalAddress(current?.postalAddress ?? "")
    return current
  })

  const complete = () => legalName().trim() !== "" && postalAddress().trim() !== ""

  async function save() {
    if (!complete() || saving()) return
    setSaving(true)
    try {
      await api.put("/org/settings/commercial-identity", {
        legalName: legalName().trim(),
        postalAddress: postalAddress().trim(),
        ...(loaded()?.countryPolicy ? { countryPolicy: loaded()?.countryPolicy } : {}),
      })
      addToast({ message: i18n.t("mail.commercialIdentity.saved"), type: "success" })
    } catch {
      addToast({ message: i18n.t("mail.commercialIdentity.saveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section class="flex flex-col gap-3" data-testid="commercial-identity-section">
      <h3 class="text-sm font-medium text-text">{i18n.t("mail.commercialIdentity.title")}</h3>
      <p class="text-xs text-text-secondary">{i18n.t("mail.commercialIdentity.help")}</p>
      <Show when={!loaded.loading}>
        <Input
          label={i18n.t("mail.commercialIdentity.legalName")}
          value={legalName()}
          maxLength={200}
          onInput={(e) => setLegalName(e.currentTarget.value)}
          data-testid="commercial-identity-legal-name"
        />
        <Input
          label={i18n.t("mail.commercialIdentity.postalAddress")}
          value={postalAddress()}
          maxLength={500}
          onInput={(e) => setPostalAddress(e.currentTarget.value)}
          data-testid="commercial-identity-postal-address"
        />
        <div>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
            disabled={!complete() || saving()}
            onClick={save}
            data-testid="commercial-identity-save"
          >
            {i18n.t("kernel.common.save")}
          </button>
        </div>
      </Show>
    </section>
  )
}

export default CommercialIdentitySection

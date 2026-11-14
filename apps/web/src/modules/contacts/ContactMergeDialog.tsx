// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { contactDetailStore } from "./contact-detail-store"
import type { Contact } from "./contact-list-store"
import {
  closeMerge,
  confirmMerge,
  loadSourceConversations,
  mergeStore,
  searchTargets,
  selectTarget,
  setFieldChoice,
  setStep,
} from "./contact-merge-store"

export const ContactMergeDialog: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [targetQuery, setTargetQuery] = createSignal("")
  const sourceContact = () =>
    mergeStore.sourceId ? contactDetailStore.contacts[mergeStore.sourceId] : null
  const targetContact = () =>
    mergeStore.targetId
      ? (contactDetailStore.contacts[mergeStore.targetId] ??
        mergeStore.targetCandidates.find((candidate) => candidate.id === mergeStore.targetId) ??
        null)
      : null
  createEffect(() => {
    if (mergeStore.open && mergeStore.sourceId) void loadSourceConversations(api)
  })
  // Returns null when the field is absent so the ?? chain can fall through
  // to the next candidate. An empty string returned here would short-circuit
  // the chain and prevent source values from ever becoming the default.
  const fieldValue = (contact: Contact | null | undefined, field: keyof Contact): string | null => {
    const v = contact?.[field]
    return typeof v === "string" ? v : null
  }
  const selectedValue = (field: keyof Contact) =>
    mergeStore.resolvedFields[field] ??
    fieldValue(targetContact(), field) ??
    fieldValue(sourceContact(), field) ??
    ""
  const fields: (keyof Contact)[] = ["name", "email", "phone", "company"]

  function chooseDefaultsAndContinue(): void {
    for (const field of fields) {
      if (mergeStore.resolvedFields[field] === undefined)
        setFieldChoice(field, selectedValue(field))
    }
    setStep("confirm")
  }

  return (
    <Dialog open={mergeStore.open} onOpenChange={(open) => !open && closeMerge()}>
      <Dialog.Content>
        <Dialog.Title>{i18n.t("contacts.mergeContacts")}</Dialog.Title>
        <Dialog.Description>{i18n.t("contacts.mergeDescription")}</Dialog.Description>
        <Show when={mergeStore.error}>
          <div class="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {mergeStore.error}
          </div>
        </Show>

        <Show when={mergeStore.step === "search"}>
          <div class="mt-4 space-y-3">
            <div class="flex gap-2">
              <input
                data-testid="merge-target-search"
                class="min-w-0 flex-1 rounded border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent-muted"
                placeholder={i18n.t("contacts.searchContacts")}
                value={targetQuery()}
                onInput={(event) => setTargetQuery(event.currentTarget.value)}
              />
              <Button
                type="button"
                size="sm"
                data-testid="merge-target-search-submit"
                onClick={() => void searchTargets(api, targetQuery())}
              >
                {i18n.t("kernel.common.search")}
              </Button>
            </div>
            <For
              each={mergeStore.targetCandidates.filter(
                (candidate) => candidate.id !== mergeStore.sourceId,
              )}
            >
              {(candidate) => (
                <button
                  type="button"
                  data-testid={`merge-target-candidate-${candidate.id}`}
                  class="w-full rounded border border-border p-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => selectTarget(candidate.id)}
                >
                  <div class="font-medium text-text">
                    {candidate.name ?? candidate.email ?? i18n.t("contacts.contactFallback")}
                  </div>
                  <div class="text-xs text-text-tertiary">{candidate.email}</div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={mergeStore.step === "compare"}>
          <div class="mt-4 space-y-4">
            <div class="grid grid-cols-[110px_1fr_1fr] gap-2 text-xs text-text-tertiary">
              <div />
              <div class="font-medium text-text">{i18n.t("contacts.survivor")}</div>
              <div class="font-medium text-text">{i18n.t("contacts.duplicate")}</div>
              <For each={fields}>
                {(field) => (
                  <>
                    <div class="py-2 font-medium">{i18n.t(`contacts.fieldLabel.${field}`)}</div>
                    <label class="rounded border border-border p-2 text-text-secondary">
                      <input
                        class="mr-2"
                        type="radio"
                        name={`merge-${field}`}
                        checked={selectedValue(field) === fieldValue(targetContact(), field)}
                        onChange={() =>
                          setFieldChoice(field, fieldValue(targetContact(), field) ?? "")
                        }
                      />
                      {fieldValue(targetContact(), field) || i18n.t("contacts.empty")}
                    </label>
                    <label class="rounded border border-border p-2 text-text-secondary">
                      <input
                        class="mr-2"
                        type="radio"
                        name={`merge-${field}`}
                        checked={selectedValue(field) === fieldValue(sourceContact(), field)}
                        onChange={() =>
                          setFieldChoice(field, fieldValue(sourceContact(), field) ?? "")
                        }
                      />
                      {fieldValue(sourceContact(), field) || i18n.t("contacts.empty")}
                    </label>
                  </>
                )}
              </For>
            </div>
            <div class="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-text-secondary">
              {i18n.t("contacts.mergeFootnote")}
            </div>
            <div class="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closeMerge}>
                {i18n.t("kernel.common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="merge-continue"
                onClick={chooseDefaultsAndContinue}
              >
                {i18n.t("kernel.common.continue")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={mergeStore.step === "confirm"}>
          <div class="mt-4 space-y-4">
            <div class="rounded border border-border bg-surface-hover p-3 text-sm text-text-secondary">
              <div class="font-medium text-text">
                {i18n.t("contacts.mergeAbsorbs", {
                  target:
                    targetContact()?.name ??
                    targetContact()?.email ??
                    i18n.t("contacts.targetContact"),
                  source:
                    sourceContact()?.name ??
                    sourceContact()?.email ??
                    i18n.t("contacts.sourceContact"),
                })}
              </div>
              <div class="mt-1">
                {i18n.t("contacts.conversationsReassigned", {
                  count: mergeStore.sourceConversations,
                })}
              </div>
              <Show when={sourceContact()?.email}>
                <div class="mt-1 text-text-tertiary">
                  {i18n.t("contacts.willBeDiscarded", { email: sourceContact()!.email ?? "" })}
                </div>
              </Show>
            </div>
            <div class="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("compare")}>
                {i18n.t("contacts.back")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={closeMerge}>
                {i18n.t("kernel.common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="merge-confirm"
                onClick={async () => {
                  try {
                    await confirmMerge(api)
                    addToast({ message: i18n.t("contacts.contactsMerged"), type: "success" })
                  } catch {
                    // Error is rendered inline from the merge store so the user can retry.
                  }
                }}
              >
                {i18n.t("contacts.confirmMerge")}
              </Button>
            </div>
          </div>
        </Show>
      </Dialog.Content>
    </Dialog>
  )
}

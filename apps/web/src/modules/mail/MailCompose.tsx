// SPDX-License-Identifier: FSL-1.1-ALv2

import { markdownToEmail, type RecipientFact } from "@liaison/shared"
import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { connectionErrorKey } from "~/lib/connection-errors"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { updateContact } from "~/modules/contacts/contact-detail-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import {
  createUploadHold,
  type FileRow,
  parentKeyOf,
  uploadHoldLabel,
} from "~/modules/files/file-service"
import {
  attachmentErrorMessage,
  restoreStaged,
  StagedAttachmentChips,
} from "~/modules/files/StagedAttachmentChips"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openDraftBody } from "~/modules/mail/draft-body"
import { allAccounts, personalAccounts } from "~/modules/mail/mail-account-store"
import {
  createDraft,
  discardDraft,
  drafts,
  mailSendErrorKey,
  scheduleDraftSave,
  sendDraft,
} from "~/modules/mail/mail-draft-store"
import { RecipientFactsLine } from "~/modules/mail/RecipientFactsLine"
import { useApi } from "~/modules/shell/ApiContext"
import { closeTab, makeTabId } from "~/modules/shell/tab-store"

/** The answer of `POST /mail/compose-check`. */
interface ComposeCheck {
  commercial: boolean
  footerLines: string[] | null
  refusal: string | null
  line: string | null
  /** A prospect with no recorded lawful basis: said calmly, and the person may still send. */
  missingBasis?: { contactId: string | null; name: string } | null
  /** What is recorded about each recipient who is a contact (basis, consumer or business, opted out). */
  recipients?: RecipientFact[]
}

type LawfulBasis = "consent" | "customer" | "professional_interest" | "generic_address"

interface MailComposeProps {
  entityId: string
}

export const MailCompose: Component<MailComposeProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [draftId, setDraftId] = createSignal<string | null>(null)
  const [to, setTo] = createSignal("")
  const [cc, setCc] = createSignal("")
  const [bcc, setBcc] = createSignal("")
  const [subject, setSubject] = createSignal("")
  // The message as written (markdown); markdownToEmail makes the email.
  const [body, setBody] = createSignal("")
  const [showCcBcc, setShowCcBcc] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // The last send may have been delivered (the provider never confirmed it):
  // the next Send on this draft says the person wants it sent again anyway.
  const [confirmResend, setConfirmResend] = createSignal(false)
  const [accountId, setAccountId] = createSignal("")
  const [pendingFiles, setPendingFiles] = createSignal<FileRow[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)
  let editor: RichEditorHandle | undefined
  const dictation = useDictation({ target: () => editor })
  // What the recipients' data makes of this mail: a prospect's footer (fixed,
  // added at send), why it cannot go, or the opted-out line.
  const [commercial, setCommercial] = createSignal<ComposeCheck | null>(null)
  const [checkFailed, setCheckFailed] = createSignal(false)
  // Bumped after a basis is recorded so the check runs again.
  const [recheck, setRecheck] = createSignal(0)
  const [basisFailed, setBasisFailed] = createSignal(false)

  /** Records the chosen basis on the contact, through the contact's own edit path. */
  async function recordBasis(contactId: string, basis: string) {
    if (!basis) return
    setBasisFailed(false)
    try {
      await updateContact(api, contactId, { lawfulBasis: basis as LawfulBasis })
      setRecheck((n) => n + 1)
    } catch {
      setBasisFailed(true)
    }
  }

  createEffect(
    on(
      () => props.entityId,
      (eid) => {
        const existing = drafts()[eid]
        if (existing) {
          setDraftId(existing.id)
          setTo(existing.to.map((a) => a.email).join(", "))
          setCc(existing.cc.map((a) => a.email).join(", "))
          setBcc(existing.bcc.map((a) => a.email).join(", "))
          setSubject(existing.subject)
          void openDraftBody(existing, { draftId, body, setBody })
          setAccountId(existing.accountId)
          if (existing.cc.length > 0 || existing.bcc.length > 0) setShowCcBcc(true)
        } else {
          const personal = personalAccounts()
          setAccountId(personal[0]?.id ?? allAccounts()[0]?.id ?? "")
        }
      },
    ),
  )

  // Re-initialize accountId when accounts load after the initial effect
  createEffect(
    on(
      () => allAccounts().length,
      () => {
        if (!accountId() && !draftId()) {
          const personal = personalAccounts()
          setAccountId(personal[0]?.id ?? allAccounts()[0]?.id ?? "")
        }
      },
      { defer: true },
    ),
  )

  function parseEmails(input: string): Array<{ email: string }> {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@"))
      .map((email) => ({ email }))
  }

  // Asked again shortly after the recipients stop changing; an older answer
  // that arrives late is dropped.
  let checkSeq = 0
  let checkTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on([to, cc, bcc, recheck], ([t, c, b]) => {
      clearTimeout(checkTimer)
      const seq = ++checkSeq
      const recipients = {
        to: parseEmails(t).map((a) => a.email),
        cc: parseEmails(c).map((a) => a.email),
        bcc: parseEmails(b).map((a) => a.email),
      }
      if (recipients.to.length + recipients.cc.length + recipients.bcc.length === 0) {
        setCommercial(null)
        setCheckFailed(false)
        return
      }
      checkTimer = setTimeout(() => {
        api.post!<ComposeCheck>("/mail/compose-check", recipients)
          .then((answer) => {
            if (seq !== checkSeq) return
            setCommercial(answer)
            setCheckFailed(false)
          })
          .catch(() => {
            if (seq !== checkSeq) return
            setCommercial(null)
            setCheckFailed(true)
          })
      }, 300)
    }),
  )
  onCleanup(() => clearTimeout(checkTimer))

  const draftParentKey = (): string | null => {
    const id = draftId()
    return id ? parentKeyOf({ app: "mail", entityType: "draft", entityId: id }) : null
  }
  // Send sends the draft with the files already on it: one still uploading
  // went out missing and landed on the sent draft afterwards. Hold the send
  // until every picked file is on the draft.
  const uploadHold = createUploadHold(draftParentKey)

  // Every keystroke before the draft exists asks for it: they share one.
  let creating: Promise<string> | null = null
  function ensureDraft(): Promise<string> {
    const id = draftId()
    if (id) return Promise.resolve(id)
    creating ??= createDraft(api, { accountId: accountId() })
      .then((draft) => {
        setDraftId(draft.id)
        return draft.id
      })
      .finally(() => {
        creating = null
      })
    return creating
  }

  async function handleFieldChange(field: string, value: string): Promise<void> {
    // An edit makes it a different message than the one queued.
    uploadHold.cancel()
    setError(null)
    // The field takes the edit at once; only the save waits for the draft. A
    // value set after the wait arrived behind newer keystrokes and reloaded
    // the editor with stale text.
    const changes: any = {}
    if (field === "to") {
      setTo(value)
      changes.to = parseEmails(value)
    }
    if (field === "cc") {
      setCc(value)
      changes.cc = parseEmails(value)
    }
    if (field === "bcc") {
      setBcc(value)
      changes.bcc = parseEmails(value)
    }
    if (field === "subject") {
      setSubject(value)
      changes.subject = value
    }
    if (field === "body") {
      setBody(value)
      changes.markdown = value
    }
    scheduleDraftSave(api, await ensureDraft(), changes)
  }

  async function handleSend(): Promise<void> {
    // While a picked file uploads, Send queues the send (or, pressed again,
    // cancels it); it fires by itself once the files are on the draft.
    if (uploadHold.press(() => void handleSend())) return
    const id = draftId()
    if (!id) return
    setSending(true)
    setError(null)
    try {
      const email = markdownToEmail(body())
      await sendDraft(api, id, {
        to: parseEmails(to()),
        cc: parseEmails(cc()),
        bcc: parseEmails(bcc()),
        subject: subject(),
        htmlBody: email.html,
        textBody: email.text,
        ...(confirmResend() ? { confirmResend: true } : {}),
      })
      setConfirmResend(false)
      closeTab(makeTabId("mail:compose", props.entityId))
    } catch (err: any) {
      // A mailbox that cannot send says how to fix it, in the person's language.
      // A send that did not settle says whether it may have left.
      const fixable = connectionErrorKey(err) ?? mailSendErrorKey(err)
      setConfirmResend(fixable === "mail.sendOutcomeUnknown")
      setError(fixable ? i18n.t(fixable) : (err.message ?? "Failed to send"))
    } finally {
      setSending(false)
    }
  }

  async function handleDiscard(): Promise<void> {
    const id = draftId()
    if (id) await discardDraft(api, id)
    closeTab(makeTabId("mail:compose", props.entityId))
  }

  return (
    <div class="flex flex-col h-full" data-testid="mail-compose">
      <div class="border-b border-border px-4 py-3">
        <h2 class="text-base font-medium text-text">{i18n.t("mail.newEmail")}</h2>
      </div>

      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <Show when={allAccounts().length > 1}>
          <div class="flex items-center gap-2">
            <label class="text-sm text-text-secondary w-16">{i18n.t("mail.from")}</label>
            <select
              data-testid="mail-compose-account"
              class="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={accountId()}
              onChange={(e) => setAccountId(e.currentTarget.value)}
            >
              {allAccounts().map((a) => (
                <option value={a.id}>{a.emailAddress}</option>
              ))}
            </select>
          </div>
        </Show>

        <div class="flex items-center gap-2">
          <label class="text-sm text-text-secondary w-16">{i18n.t("mail.to")}</label>
          <input
            data-testid="mail-compose-to"
            type="text"
            class="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
            value={to()}
            onInput={(e) => void handleFieldChange("to", e.currentTarget.value)}
            placeholder="email@example.com"
          />
          <Show when={!showCcBcc()}>
            <button class="text-xs text-accent hover:underline" onClick={() => setShowCcBcc(true)}>
              {i18n.t("mail.ccBcc")}
            </button>
          </Show>
        </div>

        <Show when={showCcBcc()}>
          <div class="flex items-center gap-2">
            <label class="text-sm text-text-secondary w-16">{i18n.t("mail.cc")}</label>
            <input
              data-testid="mail-compose-cc"
              type="text"
              class="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={cc()}
              onInput={(e) => void handleFieldChange("cc", e.currentTarget.value)}
            />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-text-secondary w-16">{i18n.t("mail.bcc")}</label>
            <input
              data-testid="mail-compose-bcc"
              type="text"
              class="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={bcc()}
              onInput={(e) => void handleFieldChange("bcc", e.currentTarget.value)}
            />
          </div>
        </Show>

        <div class="flex items-center gap-2">
          <label class="text-sm text-text-secondary w-16">{i18n.t("mail.subject")}</label>
          <input
            data-testid="mail-compose-subject"
            type="text"
            class="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
            value={subject()}
            onInput={(e) => void handleFieldChange("subject", e.currentTarget.value)}
          />
        </div>

        {/* Staged files above the message, left-aligned, as in chat. */}
        <StagedAttachmentChips
          files={pendingFiles()}
          onRemoved={(f) => {
            uploadHold.cancel()
            setPendingFiles((p) => p.filter((x) => x.id !== f.id))
          }}
          onRestored={(f, i) => setPendingFiles((p) => restoreStaged(p, f, i))}
          error={attachError()}
          disabled={sending()}
          class="flex items-center gap-2.5 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
          uploadParentKey={draftParentKey()}
        />
        <div data-testid="mail-compose-editor">
          <RichEditor
            preset="full"
            value={body()}
            onChange={(next) => void handleFieldChange("body", next)}
            ref={(handle) => {
              editor = handle
            }}
            class="rounded border border-border bg-surface px-3 py-2 [--editor-bg:var(--color-surface)]"
            editorClass="min-h-[240px] text-sm"
          />
        </div>
        <RecipientFactsLine
          facts={commercial()?.recipients}
          testId="mail-compose-recipient-facts"
        />
        <Show when={commercial()?.footerLines}>
          {(lines) => (
            <div
              data-testid="mail-compose-commercial-footer"
              class="rounded border border-border bg-surface-sunken px-3 py-2 text-xs text-text-secondary select-text"
            >
              <p class="mb-1">{i18n.t("mail.commercialFooter.composerNote")}</p>
              <For each={lines()}>{(line) => <p class="text-text">{line}</p>}</For>
            </div>
          )}
        </Show>
        <Show when={commercial()?.missingBasis}>
          {(missing) => (
            <div
              data-testid="mail-compose-no-basis"
              class="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
            >
              <span>{i18n.t("mail.commercialFooter.noBasis", { name: missing().name })}</span>
              <Show when={missing().contactId}>
                {(contactId) => (
                  <select
                    data-testid="mail-compose-record-basis"
                    aria-label={i18n.t("mail.commercialFooter.recordBasis")}
                    class="rounded border border-border bg-surface px-1 py-0.5 text-xs text-text"
                    value=""
                    onChange={(event) => void recordBasis(contactId(), event.currentTarget.value)}
                  >
                    <option value="">{i18n.t("mail.commercialFooter.recordBasis")}</option>
                    <option value="consent">{i18n.t("mail.commercialFooter.basisConsent")}</option>
                    <option value="customer">
                      {i18n.t("mail.commercialFooter.basisCustomer")}
                    </option>
                    <option value="professional_interest">
                      {i18n.t("mail.commercialFooter.basisProfessionalInterest")}
                    </option>
                    <option value="generic_address">
                      {i18n.t("mail.commercialFooter.basisGenericAddress")}
                    </option>
                  </select>
                )}
              </Show>
              <Show when={basisFailed()}>
                <span data-testid="mail-compose-record-basis-failed">
                  {i18n.t("mail.commercialFooter.recordBasisFailed")}
                </span>
              </Show>
            </div>
          )}
        </Show>
        <Show when={commercial()?.refusal}>
          {(refusal) => (
            <p data-testid="mail-compose-commercial-refusal" class="text-xs text-red-500">
              {refusal()}
            </p>
          )}
        </Show>
        <Show when={commercial()?.line}>
          {(line) => (
            <p data-testid="mail-compose-opted-out-line" class="text-xs text-text-secondary">
              {line()}
            </p>
          )}
        </Show>
        <Show when={checkFailed()}>
          <p data-testid="mail-compose-commercial-check-failed" class="text-xs text-text-secondary">
            {i18n.t("mail.commercialFooter.checkFailed")}
          </p>
        </Show>
      </div>

      {/* pb-dock-clearance: Send sits in the panel's bottom right corner,
          under the dock's bar (index.css). */}
      <div class="flex items-center justify-between border-t border-border px-4 pt-3 pb-dock-clearance">
        <RecorderRow dictation={dictation}>
          <div class="flex items-center gap-3">
            <AttachmentUploadButton
              parent={() =>
                uploadHold.track(async () => ({
                  app: "mail",
                  entityType: "draft",
                  entityId: await ensureDraft(),
                }))
              }
              onUploaded={(row) => {
                setAttachError(null)
                setPendingFiles((p) => [...p, row])
              }}
              onError={(err) => setAttachError(attachmentErrorMessage(err))}
              disabled={sending()}
            />
            <ComposerAssist target={() => editor} disabled={sending()} />
            <button
              data-testid="mail-compose-discard"
              class="text-sm text-text-secondary hover:text-red-500"
              onClick={() => void handleDiscard()}
            >
              {i18n.t("mail.discard")}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <Show when={error()}>
              <span class="text-xs text-red-500">{error()}</span>
            </Show>
            <DictationMic dictation={dictation} disabled={sending()} />
            <button
              data-testid="mail-compose-send"
              class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
              disabled={sending() || parseEmails(to()).length === 0}
              title={uploadHoldLabel(i18n.t, uploadHold)}
              aria-label={uploadHoldLabel(i18n.t, uploadHold)}
              aria-pressed={uploadHold.held() ? uploadHold.queued() : undefined}
              data-queued={uploadHold.queued() ? "true" : undefined}
              onClick={() => void handleSend()}
            >
              {sending()
                ? i18n.t("mail.sending")
                : uploadHold.queued()
                  ? i18n.t("kernel.filesUi.sendQueued")
                  : i18n.t("kernel.common.send")}
            </button>
          </div>
        </RecorderRow>
      </div>
    </div>
  )
}

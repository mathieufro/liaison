// SPDX-License-Identifier: FSL-1.1-ALv2
// What a person can do with a mail draft the send check stopped, the same on its card and on
// its Home row: start a new reply from the message that stopped it, or open where it sits.
import type { ApprovalSendGuard } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"
import { userFromToken } from "~/modules/auth/auth-store"
import { openEntity } from "~/modules/shell/entity-opener"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { sendMessage } from "~/modules/threads/message-store"
import { ensurePersonalAgentDm } from "~/modules/threads/personal-dm-store"

type T = (key: string, params?: Record<string, string>) => string
type GuardRecord = NonNullable<ApprovalSendGuard["record"]>

/** A stop that is final for the draft as written, whose card says "Not sent". */
export function isFinalStop(g: ApprovalSendGuard | null | undefined): boolean {
  return g?.state === "replied" || g?.state === "bounced" || g?.state === "ref_stop"
}

/** The reply that stopped the draft, when the viewer can open it: what a new reply answers. */
export function redraftRecord(g: ApprovalSendGuard | null | undefined): GuardRecord | null {
  return g?.state === "replied" && g.record ? g.record : null
}

/** Where the stopping message sits, when the viewer can open it. */
export function stopRecord(g: ApprovalSendGuard | null | undefined): GuardRecord | null {
  return isFinalStop(g) && g?.record ? g.record : null
}

const tabTypeOf = (record: GuardRecord): string =>
  record.kind === "ticket" ? "tickets:ticket" : "mail:conversation"

export function openRecordLabel(record: GuardRecord, t: T): string {
  return record.kind === "ticket"
    ? t("kernel.approvalsUi.sendGuard.openTicket")
    : t("kernel.approvalsUi.sendGuard.openConversation")
}

export function openStopRecord(api: ApiClient, record: GuardRecord, label: string): void {
  void openEntity(
    api,
    record.kind === "ticket" ? "tickets" : "mail",
    record.kind === "ticket" ? "ticket" : "conversation",
    record.id,
    label,
  )
}

/**
 * A normal turn in the viewer's Personal agent conversation, reading the message that stopped
 * the draft as its current view, then that conversation opens. Nothing is staged here: the
 * agent's new draft comes back as its own card.
 */
export async function startRedraft(
  api: ApiClient,
  g: ApprovalSendGuard,
  title: string,
  t: T,
): Promise<void> {
  const record = redraftRecord(g)
  const me = userFromToken()
  if (!record || !me) return
  try {
    const threadId = await ensurePersonalAgentDm(api)
    await sendMessage(
      api,
      threadId,
      t("kernel.approvalsUi.sendGuard.redraftMessage", {
        who: g.who ?? t("kernel.approvalsUi.sendGuard.theOtherSide"),
        title,
      }),
      { id: me.userId, name: me.name ?? "" },
      { currentView: { tabType: tabTypeOf(record), entityId: record.id } },
    )
    openTab({
      type: "thread",
      entityId: threadId,
      label: t("kernel.approvalsUi.sendGuard.redraft"),
    })
  } catch {
    addToast({ message: t("kernel.approvalsUi.sendGuard.redraftFailed"), type: "error" })
  }
}

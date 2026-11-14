// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared mapping from a failed `POST /approvals/:id/decide` to what the operator
// sees. Extracted from ApprovalCard because there is more than one place to
// press Approve, and they MUST agree.
//
// Prod, 2026-08-04: Boxtal started refusing shipment creation with
// `InvalidPaymentException`. The kernel handled that correctly -- 422
// `handler_failed`, handler execution recorded `failed_no_effect`, and the
// response carried Boxtal's own sentence nested under `details.details.message`.
// But the approver was working from the attention feed, whose decide() had a
// bare `catch {}` that discarded the error and only reset the submitting flag.
// The row sat there unchanged, so Approve looked dead and the same request was
// clicked five times in nine seconds.
//
// The lesson is not "add a toast to that one call site": it is that the decide
// response's useful text is NEVER the top-level `message` (that is the opaque
// code `handler_failed`), so any call site that renders `err.message` shows the
// operator nothing actionable. Everything that decides an approval routes
// through here instead.

import type { ApiClient } from "~/lib/api-client"
import type { ApiError } from "~/lib/api-error"
import { type Translate, tNow } from "~/modules/i18n/i18n-context"

/**
 * The decide route nests the underlying handler failure (the actual upstream
 * error, e.g. a Boxtal payment rejection or a Shopify permission denial) under
 * `details.details.message`. Without surfacing it the operator only sees
 * "handler_failed" and cannot act.
 */
export function handlerCause(err: ApiError): string | null {
  const d = err.details as Record<string, unknown> | undefined
  const inner = (d?.details ?? d) as Record<string, unknown> | undefined
  const msg = inner?.message
  return typeof msg === "string" && msg.length > 0 ? msg : null
}

/**
 * A cause as it goes INTO a sentence that ends it with its own period ("Tool
 * execution failed: {{cause}}."). Upstream messages usually end in a period of
 * their own, which printed "... nothing was sent.." in the toast. Trailing
 * periods and whitespace go; other end punctuation (`?`, `!`, an ellipsis
 * character) is part of the message and stays.
 */
export function causeForSentence(cause: string): string {
  const trimmed = cause.replace(/[\s.]+$/u, "")
  return trimmed.length > 0 ? trimmed : cause.trim()
}

export interface DecideErrorHandling {
  toast: { message: string; type: "error" | "info" }
  /** Persist the cause on the card, not only in a transient toast. */
  inline: boolean
  keepExecuting: boolean
  keepReasonOpen: boolean
  /**
   * Reload the attention feed after this failure.
   *
   * TRUE only when the failure proves this row is GONE -- decided by someone
   * else, or deleted. Such a row can never be decided again, so leaving it on
   * screen invites the operator to click it forever (ticket-10197 /
   * ticket-10200). FALSE for everything still actionable, including
   * `execution_outcome_unknown`: that row is very much still there and Reject is
   * the way out of it, so dropping it would remove the only control that works.
   */
  refreshFeed: boolean
}

/**
 * The api stamps "Pending approval" as the default summary subtitle on every
 * gated call (execute-tool / approval-summarizers), in English, into the
 * stored request. That one default is the product's own words, so it is shown
 * in the reader's language; a summarizer's specific subtitle is data and is
 * shown as written.
 */
export function localizedApprovalSubtitle(subtitle: string, t: Translate = tNow): string {
  if (subtitle === "Pending approval") return t("kernel.approvalsUi.status.pending")
  // The projects summarizer's subtitles ("In <project>", "Create task").
  if (subtitle === "Create task") return t("kernel.approvalsUi.tpl.createTaskBare")
  const inProject = /^In (.+)$/.exec(subtitle)
  if (inProject) return t("kernel.approvalsUi.tpl.inProject", { project: inProject[1] ?? "" })
  return subtitle
}

export function decideErrorToast(err: ApiError, t: Translate = tNow): DecideErrorHandling {
  const code = err.code
  const status = err.status
  if (status === 400 && code === "invalid_reason") {
    return {
      toast: { message: t("kernel.approvalsUi.err.reasonTooLong"), type: "error" },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: true,
      refreshFeed: false,
    }
  }
  if (status === 403) {
    return {
      toast: { message: t("kernel.approvalsUi.err.noPermission"), type: "error" },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 404) {
    return {
      toast: { message: t("kernel.approvalsUi.err.gone"), type: "error" },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: true,
    }
  }
  if (status === 409 && code === "execution_outcome_unknown") {
    // NOT "someone else decided it": this request was approved, its handler never
    // reported back, and it will not be re-run. The operator needs to know that
    // Approve is refusing on purpose and that Reject is the way to close it out --
    // told "someone else decided it" they simply press Approve again, forever
    // (ticket-10197 / ticket-10200).
    return {
      toast: {
        message: handlerCause(err) ?? t("kernel.approvalsUi.err.outcomeUnknown"),
        type: "error",
      },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 409 && code === "payload_changed") {
    // The request was edited after this card was rendered. The approve did NOT run; the live
    // update replaces the card with the new payload, and the person decides on what they now see.
    return {
      toast: { message: t("kernel.approvalsUi.err.payloadChanged"), type: "info" },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: true,
    }
  }
  if (status === 422 && code === "send_guard_not_held") {
    // "Send now" on a mail that is no longer held: a reply came in, or the hold ended. Nothing
    // was sent; the card reloads and shows what the check says now.
    return {
      toast: { message: t("kernel.approvalsUi.err.sendGuardNotHeld"), type: "info" },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: true,
    }
  }
  if (status === 409 && code === "already_signed_off") {
    // A two-approver request this person already signed off (their own send, or
    // an earlier approve): it waits for a DIFFERENT approver and stays pending.
    return {
      toast: { message: t("kernel.approvalsUi.err.alreadySignedOff"), type: "info" },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 413) {
    // The body the approve carried was refused for its size: on a sealed mail
    // send that is the decrypted attachments. It used to read as
    // "could not be updated: PAYLOAD_TOO_LARGE", which tells nobody what to do.
    return {
      toast: { message: t("kernel.approvalsUi.err.tooLarge"), type: "error" },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 409 && code === "mailbox_fulfilment_required") {
    // Not a race: the send is sealed to the mailbox owner and this approve came
    // without the decrypted draft. It used to fall through to "decided by
    // someone else" on a request nobody had touched.
    return {
      toast: { message: t("kernel.approvalsUi.err.mailboxSealed"), type: "error" },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 409) {
    // `already_decided` carries the row's real status. Only approved/denied mean
    // someone decided it: an `approving` row is the caller's own (or a
    // colleague's) click still executing, and a withdrawn row was pulled by its
    // requester, often an agent replacing the draft while the card was open.
    const current = (err.details as { currentStatus?: unknown } | undefined)?.currentStatus
    const key =
      current === "approving"
        ? "kernel.approvalsUi.err.alreadyRunning"
        : current === "withdrawn"
          ? "kernel.approvalsUi.err.alreadyWithdrawn"
          : current === "expired"
            ? "kernel.approvalsUi.err.alreadyExpired"
            : current === "cancelled"
              ? "kernel.approvalsUi.err.alreadyCancelled"
              : "kernel.approvalsUi.err.decidedElsewhere"
    return {
      toast: { message: t(key), type: "info" },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: true,
    }
  }
  if (status === 422 && code === "handler_failed") {
    return {
      toast: {
        message: t("kernel.approvalsUi.err.toolFailed", {
          cause: causeForSentence(
            handlerCause(err) ?? err.message ?? t("kernel.approvalsUi.err.handlerError"),
          ),
        }),
        type: "error",
      },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 422 && code === "handler_ambiguous") {
    const cause = handlerCause(err)
    return {
      toast: {
        message: cause
          ? t("kernel.approvalsUi.err.toolRunFailed", { cause: causeForSentence(cause) })
          : t("kernel.approvalsUi.err.outcomeUnclear"),
        type: "error",
      },
      inline: true,
      keepExecuting: true,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 422 && code === "mail_draft_removed") {
    return {
      toast: { message: t("kernel.approvalsUi.err.mailDraftRemoved"), type: "error" },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status === 422 && code === "requester_lost_scope") {
    return {
      toast: {
        message: t("kernel.approvalsUi.err.nobodyMayRun"),
        type: "error",
      },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status >= 400 && status < 500) {
    return {
      toast: {
        message: t("kernel.approvalsUi.err.updateFailed", { code: code ?? "error" }),
        type: "error",
      },
      inline: true,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  if (status >= 500) {
    // The server WAS reached and failed the request. Calling that "couldn't
    // reach server" sent the operator checking their connection while the real
    // cause sat in the server log; the reference is the key to that log line.
    return {
      toast: {
        message: err.ref
          ? t("kernel.approvalsUi.err.serverError", { ref: err.ref })
          : t("kernel.approvalsUi.err.serverErrorNoRef"),
        type: "error",
      },
      inline: false,
      keepExecuting: false,
      keepReasonOpen: false,
      refreshFeed: false,
    }
  }
  return {
    toast: { message: t("kernel.approvalsUi.err.offline"), type: "error" },
    inline: false,
    keepExecuting: false,
    keepReasonOpen: false,
    refreshFeed: false,
  }
}

/**
 * The ONE way to post a decision (an approval or a scope request). Every
 * caller maps the failure itself through `decideErrorToast`, so the api
 * client's global toast is suppressed here: with it, one failed Approve
 * showed two contradictory toasts ("Something went wrong" AND "Couldn't
 * reach server"). Only the decision queue (decision-queue.ts) calls it: a
 * guard test forbids posting to a `/decide` route anywhere else.
 */
export function postDecision<T>(
  api: ApiClient,
  path: string,
  body: unknown,
  opts?: { keepalive?: boolean },
): Promise<T> {
  return api.post<T>(path, body, {
    suppressGlobalError: true,
    ...(opts?.keepalive ? { keepalive: true } : {}),
  })
}

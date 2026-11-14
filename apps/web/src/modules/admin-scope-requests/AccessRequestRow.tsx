// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN ACCESS REQUEST IN THE APPROVALS LIST (attention kind `scope_request`): an
// agent or a person asks for a scope, and someone holding
// `kernel:scope_requests:admin` (the only people the server sends it to) grants
// or denies it right here. Same anatomy as an approval row (DecisionRow): a
// neutral key, the "Access request" pill in the colour of the app whose scope
// is asked for, who asks and for what, what it allows and why, then Grant and
// Deny on the collapsed row itself, the way an approval shows Approve / Reject.
// The verbs are Grant / Deny so an access request never reads as an agent's
// action to approve. Details opens the request's facts.
//
// The decision goes through the same Undo window as an approval
// (decision-queue.ts, kind "scope-request"): the row hides at once, Undo
// brings it back, the feed reload confirms.

import type { AttentionItem } from "@liaison/shared"
import { Check, KeyRound, X } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { scopeLabel } from "~/lib/capability-copy"
import { appName } from "~/modules/approvals/approval-copy"
import { decideErrorToast } from "~/modules/approvals/decide-error"
import {
  isDecisionInFlight,
  isDecisionNotSent,
  isDecisionUndone,
  queueDecision,
} from "~/modules/approvals/decision-queue"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { appIdOfTool } from "~/modules/shell/AppPill"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import {
  DecisionCardActions,
  DecisionDetailsCard,
  DecisionRow,
  type DecisionRowAction,
} from "~/modules/shell/DecisionRow"
import { addToast } from "~/modules/shell/toast-store"

/** How many scopes the collapsed row names before "and N more". */
const NAMED_SCOPES = 2

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

/** What an access request row carries (kernel-translations.ts scope_request). */
export interface AccessRequestFacts {
  scopes: string[]
  requester: string | null
  reason: string | null
}

export function accessRequestOf(item: AttentionItem): AccessRequestFacts | null {
  if (item.kind !== "scope_request") return null
  const md = item.metadata ?? {}
  const scopes = Array.isArray(md.requestedScopes)
    ? md.requestedScopes.filter((s): s is string => typeof s === "string" && s.length > 0)
    : []
  // Older rows carry only the summary "<name> requested access: <title>".
  const fromSummary = /^(.+) requested access: (.+)$/.exec(item.summary)
  return {
    scopes,
    requester: str(md.agentName) ?? str(md.requesterLabel) ?? fromSummary?.[1] ?? null,
    reason: str(md.reason),
  }
}

/** The app whose scope is asked for: the pill's colour (the first scope's app). */
export function accessRequestAppId(facts: AccessRequestFacts): string | null {
  const first = facts.scopes[0]
  if (!first || first === "*") return null
  return appIdOfTool(first)
}

const AccessRequestRow: Component<{ item: AttentionItem; facts: AccessRequestFacts }> = (props) => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const [submitting, setSubmitting] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const testId = () => `attention-row-${props.item.app}-${props.item.entity}-${props.item.entityId}`

  const requester = () => props.facts.requester ?? t("kernel.accessRequestRow.someone")
  const apps = () => [
    ...new Set(props.facts.scopes.filter((s) => s !== "*").map((s) => appIdOfTool(s) ?? s)),
  ]
  const title = (): string => {
    const only = apps().length === 1 ? apps()[0] : null
    return only
      ? t("kernel.accessRequestRow.titleApp", { name: requester(), app: appName(only, t) })
      : t("kernel.accessRequestRow.title", { name: requester() })
  }
  const scopeLabels = () => props.facts.scopes.map((s) => scopeLabel(s, t))
  const allowsLine = (): string | null => {
    const labels = scopeLabels()
    if (labels.length === 0) return null
    const named = labels.slice(0, NAMED_SCOPES).join(", ")
    const rest = labels.length - NAMED_SCOPES
    return t("kernel.accessRequestRow.allows", {
      access: rest > 0 ? t("kernel.accessRequestRow.andMore", { named, count: rest }) : named,
    })
  }
  const whyLine = (): string | null =>
    props.facts.reason ? t("kernel.accessRequestRow.why", { reason: props.facts.reason }) : null
  const age = () => formatRelativeTime(props.item.occurredAt, { i18n: rowLocaleFrom(i18n) })
  const pill = () => ({
    appId: accessRequestAppId(props.facts),
    label: t("kernel.approvalKinds.accessRequest"),
  })

  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (submitting()) return
    setSubmitting(true)
    try {
      await queueDecision(
        api,
        "scope-request",
        props.item.entityId,
        { decision },
        { label: { title: title(), detail: allowsLine() } },
      )
      attentionStore.resolveLocally(props.item.id)
      attentionStore.markStaleAndReload(api)
    } catch (err) {
      if (isDecisionUndone(err)) {
        setSubmitting(false)
        return
      }
      addToast(
        err instanceof ApiError
          ? decideErrorToast(err, t).toast
          : { message: t("kernel.shellUi.couldnTReachServer"), type: "error" },
      )
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        attentionStore.markStaleAndReload(api)
      }
      setSubmitting(false)
    }
  }

  const grant = (): DecisionRowAction => ({
    label: t("kernel.accessRequestRow.grant"),
    testid: `${testId()}-grant`,
    icon: Check,
    disabled: submitting(),
    onClick: () => void decide("approve"),
  })
  const deny = (): DecisionRowAction => ({
    label: t("kernel.accessRequestRow.deny"),
    testid: `${testId()}-deny`,
    icon: X,
    disabled: submitting(),
    onClick: () => void decide("deny"),
  })

  const facts = () => [
    ...scopeLabels().map((label, i) => ({
      label: t("kernel.accessRequestRow.factAllows"),
      value: label,
      testid: `${testId()}-fact-allows-${i + 1}`,
    })),
    ...(props.facts.reason
      ? [
          {
            label: t("kernel.accessRequestRow.factWhy"),
            value: `“${props.facts.reason}”`,
            testid: `${testId()}-fact-why`,
          },
        ]
      : []),
  ]

  // A decision this device stored too long ago was dropped at boot, unsent (decision-queue.ts).
  const notSentLine = (): string | null =>
    isDecisionNotSent("scope-request", props.item.entityId)
      ? t("kernel.decisionToast.notSent")
      : null

  return (
    // A decision waiting out its Undo window hides the row; Undo brings it back.
    <Show when={!isDecisionInFlight("scope-request", props.item.entityId)}>
      <DecisionRow
        testId={testId()}
        kind={props.item.kind}
        ariaLabel={t("kernel.approvalKinds.accessRequest")}
        icon={KeyRound}
        pill={pill()}
        title={title()}
        lines={[notSentLine(), allowsLine(), whyLine()].filter((l): l is string => l !== null)}
        compactLine={notSentLine() ?? allowsLine()}
        meta={[t("kernel.shellUi.byName", { name: requester() }), age()]}
        primary={grant()}
        secondary={deny()}
        expanded={expanded()}
        onToggle={() => setExpanded((v) => !v)}
        attrs={{ "data-app": pill().appId ?? "system" }}
        details={
          <DecisionDetailsCard
            testId={`${testId()}-card`}
            icon={KeyRound}
            pill={pill()}
            handle={props.item.entityId.slice(0, 8)}
            title={scopeLabels().length === 1 ? (scopeLabels()[0] ?? title()) : title()}
            subtitle={t("kernel.accessRequestRow.subtitle", { name: requester() })}
            facts={facts()}
            technical={props.facts.scopes.join(", ") || null}
            provenance={t("kernel.accessRequestRow.provenance", { name: requester(), age: age() })}
            chip={t("kernel.accessRequestRow.adminsChip")}
            actions={<DecisionCardActions primary={grant()} secondary={deny()} />}
          />
        }
      />
    </Show>
  )
}

export default AccessRequestRow

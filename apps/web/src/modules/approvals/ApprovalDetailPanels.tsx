// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Panels an app contributes to the cards of one of its tools (`approval:detail:panel`, each
 * contribution naming its tool with `for_tool`): drawn inside the card, under its summary, so a
 * person reads and changes what the request covers without leaving it. A tool with no
 * contribution draws nothing.
 */
import type { ApprovalRequestSummary } from "@liaison/shared"
import { For, type JSX } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { createSlotPanels, SlotEntryView } from "~/modules/shell/SlotPanels"

export const APPROVAL_DETAIL_PANEL_SLOT = "approval:detail:panel"

export function ApprovalDetailPanels(props: {
  request: ApprovalRequestSummary
  /** Whether this viewer may decide the request (the card's own answer). */
  canDecide: boolean
}): JSX.Element {
  const entries = createSlotPanels(
    () => APPROVAL_DETAIL_PANEL_SLOT,
    () => props.request.toolName,
  )
  return (
    <For each={entries()}>
      {(entry) => (
        <div
          class="mt-3 min-w-0"
          data-testid={`approval-card-detail-panel-${entry.panel.app}-${entry.panel.id}`}
        >
          <SlotEntryView
            entry={entry}
            entityId={props.request.id}
            panelProps={{
              approvalId: props.request.id,
              toolName: props.request.toolName,
              status: props.request.status,
              payload: props.request.currentPayload,
              payloadHash: props.request.payloadHash,
              threadId: props.request.threadId,
              canDecide: props.canDecide,
              viewerScopes: userFromToken()?.scopes ?? [],
            }}
          />
        </div>
      )}
    </For>
  )
}

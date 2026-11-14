// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T10. The assignee picker as a bottom sheet, for the phone list's swipe
// action. It is the SAME picker the detail header's popup menu offers (the
// member directory with a search field, plus "Assign to me" and "Unassign")
// and the same store action: only the container differs, because a popup anchored to a row a
// finger is still holding is not a control anyone can hit.
import { type Component, createMemo, For, Show } from "solid-js"
import { disambiguatedLabel, markAmbiguousNames } from "~/lib/name-collision"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneeListStatus, AssigneeSearchField } from "~/modules/members/AssigneeSearch"
import { createAssignableMembers } from "~/modules/members/assignable-members"
import { useApi } from "~/modules/shell/ApiContext"
import { awayLabel } from "~/modules/shell/route-line"
import { assignTicket } from "~/modules/tickets/ticket-detail-store"
import { OverlaySheet } from "~/ui/OverlaySheet"

interface Props {
  ticketId: string
  open: boolean
  onClose: () => void
}

export const TicketAssignSheet: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  // Loaded on the first open, not on mount: a list of fifty rows must not fire
  // fifty member loads for sheets nobody opened. The caller is already the
  // "Assign to me" row, so the list leaves them out.
  const assignees = createAssignableMembers(api, () => props.open)
  const members = createMemo(() =>
    assignees.members().filter((m) => m.id !== userFromToken()?.userId),
  )
  // Only a name shared by two members on this sheet needs the email to tell
  // them apart; a uniquely named member keeps just the name.
  const markedMembers = createMemo(() => markAmbiguousNames(members(), (m) => m.name))

  async function pick(userId: string | null, name: string | null): Promise<void> {
    // Read the ticket BEFORE closing: the caller unmounts this sheet on close,
    // and `props.ticketId` read afterwards is a stale accessor.
    const ticketId = props.ticketId
    props.onClose()
    await assignTicket(api, ticketId, userId, name)
  }

  const rowClass =
    "flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-[15px] text-text hover:bg-surface-hover"

  return (
    <OverlaySheet
      open={props.open}
      onClose={() => props.onClose()}
      variant="bottom"
      title={i18n.t("kernel.ticketAssign")}
      closeLabel={i18n.t("kernel.close")}
    >
      <div data-testid="ticket-assign-sheet" class="flex flex-col pb-2">
        <div class="px-4 pb-2">
          <AssigneeSearchField
            testIdPrefix="tickets-assignee"
            value={assignees.query()}
            onInput={assignees.setQuery}
            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-[15px] text-text outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-accent-border"
          />
        </div>
        <button
          type="button"
          data-testid="ticket-assign-me"
          class={rowClass}
          onClick={() => void pick("me", userFromToken()?.name ?? null)}
        >
          {i18n.t("kernel.ticketAssignToMe")}
        </button>
        <For each={markedMembers()}>
          {({ candidate: member, ambiguous }) => (
            <button
              type="button"
              data-testid={`ticket-assign-member-${member.id}`}
              class={rowClass}
              onClick={() => void pick(member.id, member.name)}
            >
              <span>{disambiguatedLabel(member.name, member.email, ambiguous)}</span>
              <Show when={awayLabel(member.away, i18n.t, i18n.locale())}>
                {(away) => (
                  <span
                    data-testid={`ticket-assign-away-${member.id}`}
                    class="ml-auto text-[13px] text-text-tertiary"
                  >
                    {away()}
                  </span>
                )}
              </Show>
            </button>
          )}
        </For>
        <AssigneeListStatus
          testIdPrefix="tickets-assignee"
          status={assignees.status()}
          shown={assignees.members().length}
          total={assignees.total()}
          onRetry={assignees.retry}
          class="px-4 py-2 text-[13px] text-text-tertiary"
        />
        <button
          type="button"
          data-testid="ticket-assign-none"
          class={rowClass}
          onClick={() => void pick(null, null)}
        >
          {i18n.t("kernel.ticketUnassign")}
        </button>
      </div>
    </OverlaySheet>
  )
}

// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { disambiguatedLabel, markAmbiguousNames } from "~/lib/name-collision"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { awayLabel } from "~/modules/shell/route-line"
import { Avatar } from "~/ui/AvatarStack"
import { PopupMenu } from "~/ui/PopupMenu"

interface AssignableUser {
  id: string
  name: string
  email: string | null
  avatarUrl: string | null
  /** Away today: until when. Who can be picked does not change. */
  away?: { until: string | null } | null
}

interface AssigneePickerProps {
  assignedTo: string
  accountId: string
  onReassign: (userId: string | null) => void | Promise<void>
}

function unwrapData<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in result
    ? (result as { data: T }).data
    : (result as T)
}

export const AssigneePicker: Component<AssigneePickerProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [users, setUsers] = createSignal<AssignableUser[]>([])

  const assignedUser = () =>
    users().find((user) => user.id === props.assignedTo) ?? {
      id: props.assignedTo,
      name: "Assigned",
      email: null,
      avatarUrl: null,
    }

  // A name shared by two assignable users on this account only needs the
  // email alongside it; a unique name stays as it was.
  const markedUsers = createMemo(() => markAmbiguousNames(users(), (u) => u.name))

  async function loadUsers(): Promise<void> {
    setLoading(true)
    try {
      setUsers(
        unwrapData<AssignableUser[]>(await api.get(`/mail/accounts/${props.accountId}/assignees`)),
      )
    } finally {
      setLoading(false)
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen)
    if (nextOpen && users().length === 0 && !loading()) void loadUsers()
  }

  return (
    <PopupMenu open={open()} onOpenChange={handleOpenChange}>
      <PopupMenu.Trigger
        aria-label={i18n.t("mail.assignedTo", { name: assignedUser().name })}
        class="assignee-picker-trigger flex items-center gap-1 rounded-full border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover"
      >
        <span data-testid="assignee-picker-trigger" class="flex items-center gap-1">
          <Avatar user={assignedUser()} size="sm" />
          <span>{assignedUser().name}</span>
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content aria-label={i18n.t("mail.assignConversation")} class="min-w-48">
        <PopupMenu.Item
          data-testid="assignee-picker-unassign"
          onSelect={() => void props.onReassign(null)}
        >
          {i18n.t("kernel.common.unassign")}
        </PopupMenu.Item>
        <PopupMenu.Separator />
        <Show
          when={!loading()}
          fallback={
            <div class="px-3 py-2 text-[12px] text-text-tertiary">
              {i18n.t("kernel.common.loading3")}
            </div>
          }
        >
          <For each={markedUsers()}>
            {({ candidate: user, ambiguous }) => (
              <PopupMenu.Item
                data-testid={`assignee-picker-option-${user.id}`}
                onSelect={() => void props.onReassign(user.id)}
              >
                <Avatar user={user} size="sm" />
                <span>{disambiguatedLabel(user.name, user.email, ambiguous)}</span>
                <Show when={awayLabel(user.away, i18n.t, i18n.locale())}>
                  {(away) => (
                    <span
                      data-testid={`assignee-picker-away-${user.id}`}
                      class="ml-auto text-[11px] text-text-tertiary"
                    >
                      {away()}
                    </span>
                  )}
                </Show>
              </PopupMenu.Item>
            )}
          </For>
        </Show>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

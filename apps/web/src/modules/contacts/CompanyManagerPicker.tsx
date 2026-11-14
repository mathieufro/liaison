// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company's account manager, changed in place: the assignee pickers' own
// member list (active members, searchable, with "away until"), plus "No account
// manager". A pick saves at once: no dialog, no Save. A reader who may not
// change the company sees the name only (the page renders the plain line).
import { ChevronDown } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneeListStatus, AssigneeSearchField } from "~/modules/members/AssigneeSearch"
import { createAssignableMembers } from "~/modules/members/assignable-members"
import { useApi } from "~/modules/shell/ApiContext"
import { awayLabel } from "~/modules/shell/route-line"
import { PopupMenu } from "~/ui/PopupMenu"

interface CompanyManagerPickerProps {
  managerName: string | null
  /** The manager's own away line, when away. */
  awayText: string | null
  onPick: (userId: string | null) => void | Promise<void>
}

export const CompanyManagerPicker: Component<CompanyManagerPickerProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [open, setOpen] = createSignal(false)
  const members = createAssignableMembers(api, open)

  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger
        aria-label={i18n.t("contacts.companies.managerChange")}
        class="inline-flex min-h-7 items-center gap-1 rounded-full border border-border bg-surface px-2 text-[12.5px] text-text hover:bg-surface-hover"
      >
        <span data-testid="company-manager.trigger" class="inline-flex items-center gap-1">
          {props.managerName ?? i18n.t("contacts.companies.noAccountManager")}
          <Show when={props.awayText}>
            {(away) => <span class="text-text-tertiary">{` · ${away()}`}</span>}
          </Show>
          <ChevronDown size={12} class="text-text-tertiary" />
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content aria-label={i18n.t("contacts.companies.managerChange")} class="w-64">
        <div class="px-1 pb-1">
          <AssigneeSearchField
            testIdPrefix="company-manager"
            value={members.query()}
            onInput={members.setQuery}
          />
        </div>
        <PopupMenu.Item data-testid="company-manager.none" onSelect={() => void props.onPick(null)}>
          <span>{i18n.t("contacts.companies.noAccountManager")}</span>
        </PopupMenu.Item>
        <PopupMenu.Separator />
        <div class="max-h-72 overflow-y-auto">
          <For each={members.members()}>
            {(m) => (
              <PopupMenu.Item
                data-testid={`company-manager.option-${m.id}`}
                textValue={m.name}
                onSelect={() => void props.onPick(m.id)}
              >
                <span class="truncate">{m.name}</span>
                <Show when={awayLabel(m.away, i18n.t, i18n.locale())}>
                  {(away) => (
                    <span
                      data-testid={`company-manager.away-${m.id}`}
                      class="ml-auto shrink-0 text-[11px] text-text-tertiary"
                    >
                      {away()}
                    </span>
                  )}
                </Show>
              </PopupMenu.Item>
            )}
          </For>
        </div>
        <AssigneeListStatus
          testIdPrefix="company-manager"
          status={members.status()}
          shown={members.members().length}
          total={members.total()}
          onRetry={members.retry}
        />
      </PopupMenu.Content>
    </PopupMenu>
  )
}

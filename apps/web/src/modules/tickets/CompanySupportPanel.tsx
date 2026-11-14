// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Support section of a company's page (`slots.company_detail`, group
 * `support`): the open tickets of the company's people, read as the viewer
 * through `tickets:company_tickets`. The kernel lists the panel only for a
 * viewer who can read tickets.
 */
import { type Component, createResource, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"

export interface CompanyTicket {
  id: string
  handle: string | null
  subject: string | null
  status: string
  contactName: string | null
}

/** The company's open tickets, newest first. Throws when the read fails. */
export async function loadCompanyTickets(
  api: Pick<ApiClient, "post">,
  companyId: string,
): Promise<CompanyTicket[]> {
  const res = await api.post<
    { items?: CompanyTicket[]; error?: unknown } | { data: { items?: CompanyTicket[] } }
  >("/apps/run-tool", { toolName: "tickets:company_tickets", params: { companyId } })
  const body = (res && typeof res === "object" && "data" in res ? res.data : res) as {
    items?: CompanyTicket[]
    error?: unknown
  }
  if (!body || body.error || !Array.isArray(body.items)) throw new Error("company_tickets_failed")
  return body.items
}

export const CompanySupportPanel: Component<{ entityId?: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [tickets] = createResource(
    () => props.entityId || undefined,
    (id) => loadCompanyTickets(api, id),
  )
  return (
    <div data-testid="company-support-panel" class="text-[13px]">
      <Show
        when={!tickets.error}
        fallback={
          <p data-testid="company-support-panel.error" class="py-2 text-text-tertiary">
            {i18n.t("tickets.companySupport.error")}
          </p>
        }
      >
        <Show
          when={(tickets.latest?.length ?? 0) > 0}
          fallback={
            <Show when={tickets.latest}>
              <p data-testid="company-support-panel.empty" class="py-2 text-text-tertiary">
                {i18n.t("tickets.companySupport.empty")}
              </p>
            </Show>
          }
        >
          <ul class="divide-y divide-border-subtle">
            <For each={tickets.latest}>
              {(t) => {
                const label = [t.handle, t.subject].filter(Boolean).join(" ")
                return (
                  <li>
                    <button
                      type="button"
                      data-testid={`company-support-panel.ticket-${t.id}`}
                      class="flex min-h-[44px] w-full items-center gap-3 py-2 text-left hover:bg-surface-hover"
                      onClick={() => void openEntity(api, "tickets", "ticket", t.id, label)}
                    >
                      <span class="min-w-0 flex-1 truncate text-text">{label}</span>
                      <Show when={t.contactName}>
                        <span class="shrink-0 text-[12px] text-text-tertiary">{t.contactName}</span>
                      </Show>
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

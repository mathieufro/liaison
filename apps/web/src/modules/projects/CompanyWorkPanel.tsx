// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Work section of a company's page (`slots.company_detail`, group
 * `work`): the work projects whose client is the company and their open
 * tasks, read as the viewer through `projects:company_work`. Deals are not
 * listed here: the page's Deals section shows them.
 */
import { type Component, createResource, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"

export interface CompanyWorkTask {
  id: string
  key: string | null
  title: string
  status: string | null
}

export interface CompanyWorkProject {
  id: string
  name: string
  key: string | null
  openTasks: number
  tasks: CompanyWorkTask[]
}

export interface CompanyWork {
  projects: CompanyWorkProject[]
}

/** The company's work projects and their open tasks. Throws when the read fails. */
export async function loadCompanyWork(
  api: Pick<ApiClient, "post">,
  companyId: string,
): Promise<CompanyWork> {
  const res = await api.post<unknown>("/apps/run-tool", {
    toolName: "projects:company_work",
    params: { companyId },
  })
  const body = (
    res && typeof res === "object" && "data" in (res as object)
      ? (res as { data: unknown }).data
      : res
  ) as Partial<CompanyWork> & { error?: unknown }
  if (!body || body.error || !Array.isArray(body.projects)) {
    throw new Error("company_work_failed")
  }
  return {
    projects: body.projects.map((p) => ({
      ...p,
      openTasks: typeof p.openTasks === "number" ? p.openTasks : 0,
      tasks: Array.isArray(p.tasks) ? p.tasks : [],
    })),
  }
}

export const CompanyWorkPanel: Component<{ entityId?: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [work] = createResource(
    () => props.entityId || undefined,
    (id) => loadCompanyWork(api, id),
  )
  const empty = () => !!work.latest && work.latest.projects.length === 0
  return (
    <div data-testid="company-work-panel" class="space-y-3 text-[13px]">
      <Show
        when={!work.error}
        fallback={
          <p data-testid="company-work-panel.error" class="py-2 text-text-tertiary">
            {i18n.t("projects.companyWork.error")}
          </p>
        }
      >
        <Show when={empty()}>
          <p data-testid="company-work-panel.empty" class="py-2 text-text-tertiary">
            {i18n.t("projects.companyWork.empty")}
          </p>
        </Show>
        <Show when={(work.latest?.projects.length ?? 0) > 0}>
          <ul class="divide-y divide-border-subtle" data-testid="company-work-panel.projects">
            <For each={work.latest?.projects}>
              {(p) => (
                <li class="py-1">
                  <button
                    type="button"
                    data-testid={`company-work-panel.project-${p.id}`}
                    class="flex min-h-[44px] w-full items-center gap-3 py-2 text-left hover:bg-surface-hover"
                    onClick={() => void openEntity(api, "projects", "project", p.id, p.name)}
                  >
                    <span class="min-w-0 flex-1 truncate text-text">{p.name}</span>
                    <Show when={p.key}>
                      <span class="shrink-0 font-mono text-[12px] text-text-tertiary">{p.key}</span>
                    </Show>
                    <span
                      class="shrink-0 text-[12px] text-text-secondary"
                      data-testid={`company-work-panel.project-${p.id}.open`}
                    >
                      {i18n.t("projects.companyWork.openTasks", { count: p.openTasks })}
                    </span>
                  </button>
                  <Show when={p.tasks.length > 0}>
                    <ul class="pl-3" data-testid={`company-work-panel.project-${p.id}.tasks`}>
                      <For each={p.tasks}>
                        {(t) => (
                          <li>
                            <button
                              type="button"
                              data-testid={`company-work-panel.task-${t.id}`}
                              class="flex min-h-[44px] w-full items-center gap-3 py-1 text-left hover:bg-surface-hover"
                              onClick={() =>
                                void openEntity(
                                  api,
                                  "projects",
                                  "task",
                                  t.id,
                                  t.key ? `${t.key} ${t.title}` : t.title,
                                )
                              }
                            >
                              <span class="min-w-0 flex-1 truncate text-text-secondary">
                                <Show when={t.key}>
                                  <span class="font-mono text-[12px] text-text-tertiary">
                                    {t.key}{" "}
                                  </span>
                                </Show>
                                {t.title}
                              </span>
                              <Show when={t.status}>
                                <span class="shrink-0 text-[12px] text-text-tertiary">
                                  {t.status}
                                </span>
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

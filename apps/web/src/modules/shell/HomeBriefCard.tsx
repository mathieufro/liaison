// SPDX-License-Identifier: FSL-1.1-ALv2
// "Today's brief" on Home: the newest output of the viewer's own morning-brief routine, with
// its time (GET /api/home/brief). None yet: "No brief set up" with Set up, which opens the
// viewer's routines where the morning brief is offered.
import { type Component, createResource, Show } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"

export interface HomeBrief {
  routineId: string
  routineName: string
  message: { id: string; threadId: string; text: string; at: string } | null
}

/** The first lines of a brief: a card, not the whole message. */
const BRIEF_CHARS = 600

const HomeBriefCard: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [brief] = createResource(async () => {
    try {
      return (await api.get<HomeBrief | null>("/home/brief")) ?? null
    } catch {
      // No brief to show is not a failed Home: the card stays out.
      return undefined
    }
  })
  const message = () => brief()?.message ?? null
  const time = (at: string) =>
    new Date(at).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" })
  const text = (t: string) => (t.length > BRIEF_CHARS ? `${t.slice(0, BRIEF_CHARS)}…` : t)
  const openRoutines = () =>
    openTab({
      type: "agent",
      entityId: "self",
      label: i18n.t("kernel.nav.agents"),
      routePath: "/agents/self/routines",
    })
  const openBrief = (threadId: string, label: string) =>
    openTab({ type: "thread", entityId: threadId, label })

  return (
    <Show when={brief() !== undefined && !brief.loading}>
      <section
        data-testid="home-brief"
        class="mb-5 rounded-md border border-border-subtle bg-surface px-4 py-3"
      >
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-secondary">
            {i18n.t("kernel.homeDecisions.briefTitle")}
          </h2>
          <Show when={message()}>
            {(m) => (
              <span
                data-testid="home-brief-time"
                class="font-mono text-[11px] tabular-nums text-text-tertiary"
              >
                {time(m().at)}
              </span>
            )}
          </Show>
          <Show when={message()}>
            {(m) => (
              <button
                type="button"
                data-testid="home-brief-open"
                class="ml-auto rounded-md px-2 py-1 text-[12px] font-medium text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                onClick={() => openBrief(m().threadId, brief()?.routineName ?? "")}
              >
                {i18n.t("kernel.homeDecisions.briefOpen")}
              </button>
            )}
          </Show>
        </div>
        <Show
          when={message()}
          fallback={
            <div data-testid="home-brief-none" class="flex flex-col items-start gap-2">
              <p class="text-[12.5px] leading-snug text-text-secondary">
                {i18n.t("kernel.homeDecisions.briefNone")}
              </p>
              <Show when={hasScope("kernel:routines:write")}>
                <button
                  type="button"
                  data-testid="home-brief-setup"
                  class="rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text"
                  onClick={openRoutines}
                >
                  {i18n.t("kernel.homeDecisions.briefSetUp")}
                </button>
              </Show>
            </div>
          }
        >
          {(m) => (
            <p
              data-testid="home-brief-text"
              class="whitespace-pre-line text-[13px] leading-relaxed text-text"
            >
              {text(m().text)}
            </p>
          )}
        </Show>
      </section>
    </Show>
  )
}

export default HomeBriefCard

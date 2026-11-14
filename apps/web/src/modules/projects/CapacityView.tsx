// SPDX-License-Identifier: FSL-1.1-ALv2
// The capacity tab: one week of planned time against available time per person, in name order,
// on the projects that use time and budgets. It opens on this week; Next week shows the one after. A person's row opens onto the tasks that make up
// their planned time. "Who can take this?" asks the agent about one of them and lists, from the
// same capacity read, who has that much free planned time, each with "Move to <name>". A move is
// the presser's own act (no approval): it tells both people, and the line it leaves at the top
// offers Undo. Calm: no sort control, no colour by load, no percent, no comparison to real time,
// and a colleague's day off shows only as a smaller available figure.
import { formatDuration, nextIsoWeek } from "@liaison/shared"
import { ChevronDown, ChevronRight } from "lucide-solid"
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { dock } from "~/modules/shell/dock-prefill"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

interface CapacityTask {
  id: string
  key: string | null
  title: string
  minutes: number
}

interface CapacityData {
  week: string
  title: string
  availableMinutes: number
  plannedMinutes: number
  overLine: string | null
  people: Array<{
    userId: string
    name: string
    availableMinutes: number
    plannedMinutes: number
    note: string | null
    tasks?: CapacityTask[]
  }>
  left: CapacityTask[]
}

interface Candidate {
  userId: string
  name: string
}

interface MoveResult {
  moved: boolean
  task: { id: string; key: string | null; title: string }
  from: Candidate | null
  to: Candidate
  told: string[]
}

interface Asking {
  taskId: string
  candidates: Candidate[] | null
  failed: boolean
}

const hours = (minutes: number) => formatDuration(minutes, "h")
const taskName = (t: { key: string | null; title: string }) => t.key ?? t.title

export const CapacityView: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  /** This week, as the first read named it; the week after it is a click away. */
  const [thisWeek, setThisWeek] = createSignal<string | null>(null)
  const [showNext, setShowNext] = createSignal(false)
  const nextWeek = () => {
    const w = thisWeek()
    return w ? nextIsoWeek(w) : null
  }
  const [data, { refetch }] = createResource(
    () => ({ week: showNext() ? nextWeek() : null }),
    async ({ week }) => {
      const out = await runTool<CapacityData>(api, "projects:capacity_get", week ? { week } : {}, {
        suppressGlobalError: true,
      })
      if (!week && out.week) setThisWeek(out.week)
      return out
    },
  )
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /** The task whose "Who can take this?" is open, and who has that much free planned time. */
  const [asking, setAsking] = createSignal<Asking | null>(null)
  const [moved, setMoved] = createSignal<MoveResult | null>(null)
  const [busy, setBusy] = createSignal(false)

  const whoCanTake = async (task: CapacityTask, holder: string) => {
    void dock.prefill(
      i18n.t("projects.capacity.whoMessage", {
        task: task.key ? `${task.key}, ${task.title}` : task.title,
      }),
      api,
    )
    setAsking({ taskId: task.id, candidates: null, failed: false })
    try {
      const week = data()?.week
      const out = await runTool<{ candidates?: Candidate[] }>(
        api,
        "projects:capacity_get",
        { taskId: task.id, ...(week ? { week } : {}) },
        { suppressGlobalError: true },
      )
      const list = (out.candidates ?? []).filter((c) => c.userId !== holder)
      setAsking((cur) => (cur?.taskId === task.id ? { ...cur, candidates: list } : cur))
    } catch {
      setAsking((cur) => (cur?.taskId === task.id ? { ...cur, failed: true } : cur))
    }
  }

  const move = async (
    task: { id: string; key: string | null; title: string },
    toUserId: string | null,
  ): Promise<MoveResult | null> => {
    if (busy()) return null
    setBusy(true)
    try {
      const out = await runTool<MoveResult>(
        api,
        "projects:capacity_move",
        { taskId: task.id, toUserId },
        { suppressGlobalError: true },
      )
      setAsking(null)
      await refetch()
      return out
    } catch {
      addToast({
        message: i18n.t("projects.capacity.moveFailed", { task: taskName(task) }),
        type: "error",
      })
      return null
    } finally {
      setBusy(false)
    }
  }

  const moveTo = async (task: CapacityTask, toUserId: string) => {
    const out = await move(task, toUserId)
    if (out) setMoved(out.moved ? out : null)
  }

  const undo = async () => {
    const last = moved()
    if (!last) return
    // A task that had nobody goes back to nobody.
    const out = await move(last.task, last.from?.userId ?? null)
    if (out) setMoved(null)
  }

  const toldLine = (told: string[]) =>
    told.length >= 2
      ? i18n.t("projects.capacity.toldBoth", { a: told[0] ?? "", b: told[1] ?? "" })
      : told.length === 1
        ? i18n.t("projects.capacity.toldOne", { a: told[0] ?? "" })
        : ""

  return (
    <div class="h-full overflow-y-auto px-6 py-5 pb-dock-runway" data-testid="capacity-view">
      <Switch>
        <Match when={data.loading && !data.latest}>
          <p class="text-[13px] text-text-secondary" data-testid="capacity-view.loading">
            {i18n.t("projects.capacity.loading")}
          </p>
        </Match>
        <Match when={data.error || !data.latest?.people}>
          <div class="flex flex-col items-start gap-2" data-testid="capacity-view.error">
            <p class="text-[13px] text-text-secondary">{i18n.t("projects.capacity.error")}</p>
            <Button
              variant="outline"
              size="sm"
              data-testid="capacity-view.retry"
              onClick={() => void refetch()}
            >
              {i18n.t("projects.capacity.retry")}
            </Button>
          </div>
        </Match>
        <Match when={data.latest}>
          {(d) => (
            <>
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 class="text-[15px] font-medium text-text">{d().title}</h2>
                <Show when={nextWeek()}>
                  <div class="flex gap-1" data-testid="capacity-view.weeks">
                    <Button
                      variant={showNext() ? "ghost" : "outline"}
                      size="sm"
                      aria-pressed={!showNext()}
                      data-testid="capacity-view.this-week"
                      onClick={() => {
                        setAsking(null)
                        setShowNext(false)
                      }}
                    >
                      {i18n.t("projects.capacity.thisWeek")}
                    </Button>
                    <Button
                      variant={showNext() ? "outline" : "ghost"}
                      size="sm"
                      aria-pressed={showNext()}
                      data-testid="capacity-view.next-week"
                      onClick={() => {
                        setAsking(null)
                        setShowNext(true)
                      }}
                    >
                      {i18n.t("projects.capacity.nextWeek")}
                    </Button>
                  </div>
                </Show>
              </div>
              <Show when={moved()}>
                {(m) => (
                  <p
                    class="mt-2 flex flex-wrap items-baseline gap-x-3 text-[13px] text-text"
                    data-testid="capacity-view.moved"
                  >
                    <span>
                      {i18n.t("projects.capacity.moved", {
                        task: taskName(m().task),
                        name: m().to.name,
                      })}{" "}
                      {toldLine(m().told)}
                    </span>
                    <Show when={m().moved}>
                      <button
                        type="button"
                        class="text-[12.5px] text-text-secondary underline-offset-2 hover:text-text hover:underline"
                        data-testid="capacity-view.undo"
                        disabled={busy()}
                        onClick={() => void undo()}
                      >
                        {i18n.t("projects.capacity.undo")}
                      </button>
                    </Show>
                  </p>
                )}
              </Show>
              <Show
                when={d().people.length > 0}
                fallback={
                  <div class="mt-3 space-y-1" data-testid="capacity-view.no-timeboxes">
                    <p class="text-[13px] text-text">{i18n.t("projects.capacity.emptyTitle")}</p>
                    <p class="text-[13px] text-text-secondary">
                      {i18n.t("projects.capacity.emptyBody")}
                    </p>
                  </div>
                }
              >
                <p class="mt-1 text-[13px] text-text-secondary" data-testid="capacity-view.summary">
                  {i18n.t("projects.capacity.summary", {
                    planned: hours(d().plannedMinutes),
                    available: hours(d().availableMinutes),
                  })}
                </p>
                <Show when={d().overLine}>
                  {(line) => (
                    <p
                      class="mt-1 text-[13px] text-text-secondary"
                      data-testid="capacity-view.over-line"
                    >
                      {line()}
                    </p>
                  )}
                </Show>
                <ul class="mt-4 divide-y divide-border" data-testid="capacity-view.people">
                  <For each={d().people}>
                    {(p) => {
                      const tasks = () => p.tasks ?? []
                      return (
                        <li data-testid="capacity-view.person">
                          <div class="flex items-baseline justify-between gap-4 py-2">
                            <Show
                              when={tasks().length > 0}
                              fallback={<span class="text-[13.5px] text-text">{p.name}</span>}
                            >
                              <button
                                type="button"
                                class="flex items-center gap-1.5 text-left text-[13.5px] text-text"
                                aria-expanded={open().has(p.userId)}
                                data-testid="capacity-view.person-toggle"
                                onClick={() => toggle(p.userId)}
                              >
                                <Show
                                  when={open().has(p.userId)}
                                  fallback={<ChevronRight aria-hidden="true" class="h-3 w-3" />}
                                >
                                  <ChevronDown aria-hidden="true" class="h-3 w-3" />
                                </Show>
                                {p.name}
                              </button>
                            </Show>
                            <span
                              class="text-[13px] text-text-secondary"
                              data-testid="capacity-view.figures"
                            >
                              {i18n.t("projects.capacity.of", {
                                planned: hours(p.plannedMinutes),
                                available: hours(p.availableMinutes),
                              })}
                              <Show when={p.note}>
                                {(n) => (
                                  <span class="ml-3" data-testid="capacity-view.note">
                                    {n()}
                                  </span>
                                )}
                              </Show>
                            </span>
                          </div>
                          <Show when={open().has(p.userId)}>
                            <ul class="mb-2 ml-5 space-y-1" data-testid="capacity-view.tasks">
                              <For each={tasks()}>
                                {(t) => (
                                  <li class="text-[12.5px]" data-testid="capacity-view.task">
                                    <div class="flex items-baseline justify-between gap-3">
                                      <span class="min-w-0 truncate text-text-secondary">
                                        <Show when={t.key}>
                                          <span class="mr-1.5 font-mono text-[11px] text-text-tertiary">
                                            {t.key}
                                          </span>
                                        </Show>
                                        {t.title}
                                      </span>
                                      <span class="flex shrink-0 items-baseline gap-3">
                                        <span class="text-text-secondary">{hours(t.minutes)}</span>
                                        <button
                                          type="button"
                                          class="text-[12px] text-text-secondary underline-offset-2 hover:text-text hover:underline"
                                          data-testid="capacity-view.who-can-take"
                                          onClick={() => void whoCanTake(t, p.userId)}
                                        >
                                          {i18n.t("projects.capacity.whoCanTake")}
                                        </button>
                                      </span>
                                    </div>
                                    <Show when={asking()?.taskId === t.id ? asking() : null}>
                                      {(a) => (
                                        <div
                                          class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-text-secondary"
                                          data-testid="capacity-view.candidates"
                                        >
                                          <Switch>
                                            <Match when={a().failed}>
                                              <span>
                                                {i18n.t("projects.capacity.candidatesError")}
                                              </span>
                                            </Match>
                                            <Match when={a().candidates?.length === 0}>
                                              <span data-testid="capacity-view.none-fits">
                                                {i18n.t("projects.capacity.noneFits")}
                                              </span>
                                            </Match>
                                            <Match when={a().candidates}>
                                              {(list) => (
                                                <For each={list()}>
                                                  {(c) => (
                                                    <Button
                                                      variant="outline"
                                                      size="sm"
                                                      data-testid="capacity-view.move"
                                                      data-user={c.userId}
                                                      disabled={busy()}
                                                      onClick={() => void moveTo(t, c.userId)}
                                                    >
                                                      {i18n.t("projects.capacity.moveTo", {
                                                        name: c.name,
                                                      })}
                                                    </Button>
                                                  )}
                                                </For>
                                              )}
                                            </Match>
                                          </Switch>
                                        </div>
                                      )}
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
              <Show when={d().left.length > 0}>
                <div class="mt-4 text-[13px] text-text-secondary" data-testid="capacity-view.left">
                  {i18n.t("projects.capacity.left")}:{" "}
                  {d()
                    .left.map((t) => `${t.key ?? t.title} ${hours(t.minutes)}`)
                    .join(", ")}
                </div>
              </Show>
              <div class="mt-6 space-y-1 text-[12px] text-text-tertiary">
                <p data-testid="capacity-view.footnote">{i18n.t("projects.capacity.footnote")}</p>
                <p data-testid="capacity-view.footnote-days">
                  {i18n.t("projects.capacity.footnoteDays")}
                </p>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

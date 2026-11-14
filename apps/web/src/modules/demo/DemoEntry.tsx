// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first thing a stranger sees on the demo box, and the only screen between
// them and a populated product.
//
// ONE DOOR, THREE PAGES, counted in the header. First the visitor says what
// they want to see (the needs picker, with a bar showing the picks, their
// minutes and Continue); then meets the company: what it makes and sells, how
// each part of it runs on Liaison, the team, and the scenarios picked. Last,
// a name and an address beside Start, and a workspace of their own, seeded
// with that fictional company and the guided scenarios for those needs. The
// first verification code is mailed in the same request. There is no shared workspace
// to sign into and no published account: the seeded people exist as data
// (ticket authors, assignees, thread participants) and hold no password.
//
// IT RENDERS ONLY ON A DEMO DEPLOYMENT. `demoMode()` comes from the public
// branding read (branding-store.ts), which is the server saying so. Login.tsx
// gates on the same signal, so a self-hosted install that ships this bundle
// shows an ordinary login and none of this is reachable.
//
// A LINK CAN PRESELECT NEEDS. `?needs=support,commerce` (or `?needs=all`)
// arrives with those needs already picked and lands on the company page, so a
// page that sells one use case sends the visitor straight to it and they still
// meet the company first. "Change what you'll see" goes back to the picker.
//
// ONE QUESTION, NO NEW STEP. "Which looks most like your company?" sits above
// the picker on page one and preselects its tiles (EntryQuestion.tsx). It can be
// skipped, and every entry still opens the one example company, said so where
// the visitor meets it. `?entry=software` presets the answer the way `?needs=`
// presets the picks; a link's `needs` win over the entry's.
import {
  DEMO_WORLD_NEEDS,
  type DemoEntry as DemoEntryAnswer,
  type DemoEntryId,
  type DemoNeed,
  type DemoWorldId,
  demoWorldOfEntry,
  isDemoEntryId,
  isDemoNeed,
  presetNeeds,
} from "@liaison/shared"
import { useNavigate, useSearchParams } from "@solidjs/router"
import {
  BookOpen,
  CreditCard,
  FileText,
  FolderKanban,
  Mail,
  ShoppingBag,
  Ticket,
} from "lucide-solid"
import { type Component, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { consumeDemoEndedNotice } from "~/lib/demo-expired"
import { DemoExampleLine } from "~/modules/demo/DemoExampleLine"
import {
  createDemoWorkspace,
  type DemoSignupError,
  ensureDemoDoorSettings,
  watchDemoWorkspace,
} from "~/modules/demo/demo-store"
import { doorWorlds, refreshDoorWorlds } from "~/modules/demo/demo-world"
import { doorCompanyOf } from "~/modules/demo/door-company"
import { EntryQuestion, needsAfterEntry } from "~/modules/demo/EntryQuestion"
import { NeedsPicker, needAppId, needsMinutes } from "~/modules/demo/NeedsPicker"
import { createTurnstile } from "~/modules/demo/Turnstile"
import { useI18n } from "~/modules/i18n/i18n-context"
import { appSquareColor } from "~/modules/shell/app-color"
import { ensureBrandingLoaded, privacyUrl } from "~/modules/shell/branding-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

export { DEMO_COMPANY_NAME } from "~/modules/demo/door-company"

/** The icon each operations row wears: its app's, as the product draws it. */
const OPS_ICON: Readonly<Record<string, Component<{ size?: number }>>> = {
  payments: CreditCard,
  product: FolderKanban,
  support: Ticket,
  orders: ShoppingBag,
  invoicing: FileText,
  sales: Mail,
  projects: FolderKanban,
  knowledge: BookOpen,
}

const STEPS = ["scenarios", "company", "details"] as const

/**
 * The needs a `needs` link parameter asks for: a comma-separated list of need
 * ids, kept in the order given, with unknown and repeated values dropped, or
 * `all` for every need in canonical order.
 */
export function parseNeedsParam(
  raw: string | null | undefined,
  world: DemoWorldId = "products",
): DemoNeed[] {
  if (!raw) return []
  const values = raw.split(",").map((value) => value.trim().toLowerCase())
  const shown = DEMO_WORLD_NEEDS[world]
  if (values.includes("all")) return [...shown]
  const picked: DemoNeed[] = []
  for (const value of values) {
    // A need the world does not show is dropped, like an unknown one.
    if (isDemoNeed(value) && shown.includes(value) && !picked.includes(value)) picked.push(value)
  }
  return picked
}

/**
 * The needs a link preselects. On `/` the sign-in redirect wraps the original
 * address in `returnTo` (`/login?returnTo=%2F%3Fneeds%3Dsupport`), so the
 * parameter is read there too when the door's own address carries none.
 */
export function linkedNeeds(
  params: { needs?: string; returnTo?: string },
  world: DemoWorldId = "products",
): DemoNeed[] {
  const own = parseNeedsParam(params.needs, world)
  if (own.length > 0 || !params.returnTo?.startsWith("/")) return own
  const query = params.returnTo.split("?")[1]
  return query ? parseNeedsParam(new URLSearchParams(query).get("needs"), world) : []
}

function parseEntryParam(raw: string | null | undefined): DemoEntryId | null {
  const value = raw?.trim().toLowerCase()
  return isDemoEntryId(value) ? value : null
}

/**
 * The entry a link presets, read like `linkedNeeds`: its own address first, then
 * the sign-in redirect's `returnTo`. Anything but a known entry is no entry.
 */
export function linkedEntry(params: { entry?: string; returnTo?: string }): DemoEntryId | null {
  const own = parseEntryParam(params.entry)
  if (own || !params.returnTo?.startsWith("/")) return own
  const query = params.returnTo.split("?")[1]
  return query ? parseEntryParam(new URLSearchParams(query).get("entry")) : null
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export interface DemoEntryProps {
  /** Where the visitor goes once a session exists. Overridable by a test. */
  onSignedIn?: () => void
  /** Escape hatch to the ordinary login form, rendered by the caller. */
  onSignInInstead?: () => void
}

export const DemoEntry: Component<DemoEntryProps> = (props) => {
  const i18n = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [newsOptIn, setNewsOptIn] = createSignal(false)
  // Read once: the link only sets where the question and the picker start.
  const returnTo = firstParam(searchParams.returnTo)
  const linkEntry = linkedEntry({ entry: firstParam(searchParams.entry), returnTo })
  /** The picks the link asks for in the worlds the door runs: its `needs` win over its entry's preset. */
  const linkedPicks = (worlds: readonly DemoWorldId[]): DemoNeed[] => {
    const own = linkedNeeds(
      { needs: firstParam(searchParams.needs), returnTo },
      demoWorldOfEntry(linkEntry, worlds),
    )
    return own.length > 0 ? own : presetNeeds(linkEntry, worlds)
  }
  const linked = linkedPicks(doorWorlds())
  const [needs, setNeeds] = createSignal<DemoNeed[]>(linked)
  // The visitor's own hand on the picks or the answer: once there, a late door
  // read never rewrites them.
  let touched = false
  const [entry, setEntry] = createSignal<DemoEntryId | null>(linkEntry)
  const [entryText, setEntryText] = createSignal("")
  // 1: what to see. 2: the company the workspace is a copy of. 3: name, email,
  // Start. A link that picks needs skips step 1 and still meets the company.
  const [step, setStep] = createSignal<1 | 2 | 3>(linked.length > 0 ? 2 : 1)
  // "Just explore": every need seeded (the server needs at least one, and a
  // company with none would be nearly empty), no guided scenario implied.
  const [explore, setExplore] = createSignal(false)
  let nameField: HTMLInputElement | undefined
  const turnstile = createTurnstile()
  const [creating, setCreating] = createSignal(false)
  /** The server said the workspace is still being prepared: a busy moment, said calmly. */
  const [preparing, setPreparing] = createSignal(false)
  const [signupError, setSignupError] = createSignal("")
  // The tab was in a demo workspace that ended (lib/demo-expired.ts): say so,
  // once, above the door. Read at mount, so a reload no longer shows it.
  const workspaceEnded = consumeDemoEndedNotice()

  /** The world the answer opens among the worlds the deployment runs. */
  const world = (): DemoWorldId => demoWorldOfEntry(entry(), doorWorlds())

  onMount(() => {
    // Best-effort: the flag is usually already loaded (Login asks for it), and
    // this covers a direct hit on /demo.
    void ensureBrandingLoaded()
    void ensureDemoDoorSettings()
    // Which worlds this box runs lands after the first paint: a link's presets
    // are read again in them, unless the visitor has already made a choice.
    void refreshDoorWorlds().then((worlds) => {
      if (touched) return
      const picks = linkedPicks(worlds)
      if (picks.length === 0) return
      setNeeds(picks)
      setStep((current) => (current === 1 ? 2 : current))
    })
  })

  function enterProduct(): void {
    if (props.onSignedIn) props.onSignedIn()
    else navigate("/", { replace: true })
  }

  function messageFor(failure: DemoSignupError): string {
    switch (failure.kind) {
      case "rate_limited": {
        // Only name a wait we can state grammatically in every shipped locale.
        // Below two minutes "in about 1 minutes" is worse than no number.
        const minutes = failure.retryAfter ? Math.ceil(failure.retryAfter / 60) : 0
        return minutes >= 2
          ? i18n.t("kernel.demo.errRateLimited", { minutes })
          : i18n.t("kernel.demo.errRateLimitedNoRetry")
      }
      case "in_progress":
        return i18n.t("kernel.demo.errInProgress")
      case "gone":
        return i18n.t("kernel.demo.errGone")
      case "unavailable":
        return i18n.t("kernel.demo.errUnavailable")
      case "turnstile":
        return i18n.t("kernel.demo.errTurnstile")
      case "disposable":
        return i18n.t("kernel.demo.errDisposable")
      case "domain_cap":
        return i18n.t("kernel.demo.errDomainCap")
      default:
        return i18n.t("kernel.demo.errFailed")
    }
  }

  /** The session is live on the response, so this lands in the product and lets
   *  the world fill in around the visitor. */
  async function createWorkspace(event: Event): Promise<void> {
    event.preventDefault()
    if (creating()) return
    setSignupError("")
    setPreparing(false)
    setCreating(true)
    try {
      // The deployment's worlds may have changed since the door was read: read
      // them again, and when the company this answer opens is no longer the one
      // shown, go back to it (with the picks it has) rather than start another.
      const shown = world()
      await refreshDoorWorlds()
      if (world() !== shown) {
        const shownNow = DEMO_WORLD_NEEDS[world()]
        const kept = needs().filter((need) => shownNow.includes(need))
        setNeeds(kept.length > 0 ? kept : presetNeeds(entry(), doorWorlds()))
        setStep(2)
        return
      }
      await createDemoWorkspace({
        name: name(),
        email: email(),
        needs: needs(),
        newsOptIn: newsOptIn(),
        entry: answer(),
        turnstileToken: () => turnstile.token("demo_start"),
        onPreparing: () => setPreparing(true),
      })
      watchDemoWorkspace()
      enterProduct()
    } catch (err) {
      setSignupError(messageFor(err as DemoSignupError))
    } finally {
      setCreating(false)
      setPreparing(false)
    }
  }

  /** What still stops Start, in words; null once the visitor can start. The
   *  picks are settled on step 1, so only the details can be missing here. */
  const startHint = (): string | null =>
    name().trim() === "" || email().trim() === "" ? i18n.t("kernel.demo.startHintDetails") : null

  const company = () => doorCompanyOf(world())
  const copy = () => company().copyKey
  const everything = () => needs().length === DEMO_WORLD_NEEDS[world()].length
  const pickSummary = (): string =>
    everything()
      ? i18n.t("kernel.demo.needEverything")
      : needs()
          .map((need) => i18n.t(`kernel.demo.needShort.${need}`))
          .join(" → ")
  const minutes = () => i18n.t("kernel.demo.pickMinutes", { minutes: needsMinutes(needs()) })

  function chooseEntry(next: DemoEntryId | null): void {
    touched = true
    setNeeds(needsAfterEntry(needs(), entry(), next, doorWorlds()))
    setEntry(next)
  }

  function chooseNeeds(next: DemoNeed[]): void {
    touched = true
    setNeeds(next)
  }

  /** What the signup records: the answer, with its text for `other`. */
  function answer(): DemoEntryAnswer | undefined {
    const id = entry()
    if (!id) return undefined
    const text = id === "other" ? entryText().trim() : ""
    return text ? { id, text } : { id }
  }

  // "Other, or just show me" with nothing picked: Continue shows the whole company.
  const justShowMe = () => entry() === "other" && needs().length === 0

  function toCompany(): void {
    if (justShowMe()) {
      exploreOnOwn()
      return
    }
    if (needs().length === 0) return
    setExplore(false)
    setStep(2)
  }

  function exploreOnOwn(): void {
    // Every need of the world the answer opens (a company with none would be nearly empty).
    setNeeds([...DEMO_WORLD_NEEDS[world()]])
    setExplore(true)
    setStep(2)
  }

  function toDetails(): void {
    setStep(3)
    queueMicrotask(() => nameField?.focus())
  }

  const signIn = () => (
    <Show when={props.onSignInInstead}>
      {(handler) => (
        <button
          type="button"
          data-testid="demo-sign-in-instead"
          onClick={() => handler()()}
          class="text-[13px] text-text-secondary underline underline-offset-2 hover:text-text"
        >
          {i18n.t("kernel.demo.signIn")}
        </button>
      )}
    </Show>
  )

  return (
    // No overflow here: the document scrolls, so the picks bar stays stuck to the screen.
    <div data-testid="demo-entry" class="flex min-h-screen flex-col bg-bg">
      <header class="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          {i18n.t("kernel.demo.entryEyebrow")}
        </span>
        {/* Where the visitor is: the current page filled, the ones done
            outlined. Below sm only the current page keeps its label. */}
        <ol
          data-testid="demo-steps"
          aria-label={i18n.t("kernel.demo.stepsLabel")}
          class="flex items-center gap-1.5 text-[12px] text-text-tertiary"
        >
          <For each={STEPS}>
            {(id, i) => {
              const n = i() + 1
              const state = () => (n === step() ? "current" : n < step() ? "done" : "todo")
              return (
                <li
                  data-testid={`demo-step-${id}`}
                  data-state={state()}
                  aria-current={state() === "current" ? "step" : undefined}
                  class={`inline-flex items-center gap-1.5 ${
                    state() === "current"
                      ? "text-text"
                      : state() === "done"
                        ? "text-text-secondary"
                        : ""
                  }`}
                >
                  <Show when={i() > 0}>
                    <span aria-hidden="true" class="h-px w-3 bg-border sm:w-[18px]" />
                  </Show>
                  <span
                    class={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10.5px] font-medium ${
                      state() === "current"
                        ? "border-accent bg-accent text-accent-foreground"
                        : state() === "done"
                          ? "border-accent text-accent"
                          : "border-text-tertiary"
                    }`}
                  >
                    {n}
                  </span>
                  <span
                    class={
                      state() === "current"
                        ? "whitespace-nowrap"
                        : "hidden whitespace-nowrap sm:inline"
                    }
                  >
                    {i18n.t(`kernel.demo.step.${id}`)}
                  </span>
                </li>
              )
            }}
          </For>
        </ol>
        {signIn()}
      </header>
      <Show when={workspaceEnded}>
        <div class="mx-auto w-full max-w-[1000px] px-4 sm:px-6">
          <p
            data-testid="demo-workspace-ended"
            role="status"
            class="rounded-md border border-border bg-elevated px-3 py-2 text-[13.5px] text-text-secondary"
          >
            {i18n.t("kernel.demo.workspaceEnded")}
          </p>
        </div>
      </Show>
      <Switch>
        <Match when={step() === 1}>
          <section data-testid="demo-pick-step" class="flex flex-1 flex-col">
            <div class="mx-auto flex w-full max-w-[1000px] flex-1 flex-col gap-5 px-4 pb-6 pt-2 sm:px-6 lg:gap-5 lg:pt-2">
              <EntryQuestion
                worlds={doorWorlds()}
                value={entry()}
                onChange={chooseEntry}
                text={entryText()}
                onTextChange={setEntryText}
              />
              <h2 class="text-[15px] font-semibold leading-snug text-text">
                {i18n.t("kernel.demo.entryTitle")}
              </h2>
              <NeedsPicker world={world()} value={needs()} onChange={chooseNeeds} />
            </div>
            {/* The picks and Continue sit together, so what is missing is said
                beside the button it stops. Sticky on a phone, under the grid. */}
            <div class="sticky bottom-0 border-t border-border bg-elevated py-3">
              <div class="mx-auto flex w-full max-w-[1000px] flex-col px-4 sm:px-6 gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <p
                  data-testid="demo-pick-summary"
                  class="min-w-0 text-[13.5px] text-text-secondary"
                >
                  <Show
                    when={needs().length > 0}
                    fallback={
                      <span class="text-text-tertiary">
                        {justShowMe()
                          ? i18n.t("kernel.demo.entryPickNoneOther")
                          : i18n.t("kernel.demo.pickNone")}
                      </span>
                    }
                  >
                    <span class="font-semibold text-text">{pickSummary()}</span> · {minutes()}
                  </Show>
                </p>
                <div class="flex flex-col-reverse items-center gap-2.5 sm:flex-row sm:gap-4">
                  <button
                    type="button"
                    data-testid="demo-explore"
                    onClick={exploreOnOwn}
                    class="text-[13px] text-text-secondary underline underline-offset-2 hover:text-text"
                  >
                    {i18n.t("kernel.demo.exploreLink")}
                  </button>
                  <Button
                    type="button"
                    data-testid="demo-continue"
                    disabled={needs().length === 0 && !justShowMe()}
                    onClick={toCompany}
                    class="w-full sm:w-auto"
                  >
                    {i18n.t("kernel.demo.pickContinue")}
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </Match>
        {/* What the workspace is a copy of: what the company makes and sells,
            how each part of it runs on Liaison, the team, and what the visitor
            picked. The facts are the seed's (door-company.ts says where). */}
        <Match when={step() === 2}>
          <section
            data-testid="demo-company-step"
            class="flex flex-1 justify-center px-4 pb-6 pt-2 sm:px-6"
          >
            <div class="flex w-full max-w-[1000px] flex-col gap-3.5">
              <button
                type="button"
                data-testid="demo-change-picks"
                onClick={() => {
                  setExplore(false)
                  setStep(1)
                }}
                class="self-start text-[13px] text-text-secondary underline underline-offset-2 hover:text-text"
              >
                ← {i18n.t("kernel.demo.changePicks")}
              </button>
              <div class="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-text font-mono text-[15px] font-semibold text-bg"
                >
                  {company().initials}
                </span>
                <div class="flex min-w-0 flex-col gap-1">
                  <h1 class="text-2xl font-semibold leading-tight text-text sm:text-[26px]">
                    {company().name}
                  </h1>
                  <p class="text-[13.5px] text-text-tertiary">{i18n.t(`${copy()}.companyFacts`)}</p>
                </div>
              </div>
              <DemoExampleLine world={world()} class="text-[13.5px] text-text-secondary" />
              <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-9">
                <div data-testid="demo-intro" class="flex min-w-0 flex-col gap-3">
                  <p class="text-[14.5px] leading-relaxed text-text-secondary">
                    {i18n.t(`${copy()}.companyAbout`)}
                  </p>
                  <h2 class="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
                    {i18n.t("kernel.demo.companyHow")}
                  </h2>
                  <ul
                    data-testid="demo-company-ops"
                    class="grid gap-x-[22px] gap-y-2.5 sm:grid-cols-2"
                  >
                    <For each={company().opsList}>
                      {(op) => {
                        const Icon = OPS_ICON[op.key]
                        return (
                          <li
                            data-testid={`demo-company-op-${op.key}`}
                            class="grid grid-cols-[26px_minmax(0,1fr)] items-start gap-2.5"
                          >
                            <span
                              aria-hidden="true"
                              class="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-white"
                              style={{ "background-color": appSquareColor(op.app) }}
                            >
                              <Icon size={14} />
                            </span>
                            <span class="min-w-0">
                              <span class="block text-[13px] font-semibold text-text">
                                {i18n.t(`${copy()}.companyOps.${op.key}.title`)}
                              </span>
                              <span class="block text-[12.5px] leading-snug text-text-secondary">
                                {i18n.t(`${copy()}.companyOps.${op.key}.body`)}
                              </span>
                            </span>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                  <p class="text-[14px] leading-relaxed text-text-secondary">
                    {i18n.t(`${copy()}.companyYou`)}
                  </p>
                </div>
                <aside
                  data-testid="demo-company-side"
                  class="flex min-w-0 flex-col gap-3.5 rounded-[10px] border border-border bg-surface p-4"
                >
                  <h2 class="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
                    {i18n.t("kernel.demo.teamTitle")}
                  </h2>
                  <ul data-testid="demo-team" class="flex flex-col gap-[5px] text-[12.5px]">
                    <li class="flex justify-between gap-2.5 font-semibold text-text">
                      {i18n.t("kernel.demo.teamYou")}
                      <span class="text-right text-text-tertiary">
                        {i18n.t("kernel.demo.teamCeo")}
                      </span>
                    </li>
                    <For each={company().team}>
                      {(person) => (
                        <li class="flex justify-between gap-2.5 text-text">
                          {person.name}
                          <span class="text-right text-text-tertiary">
                            {i18n.t(`${copy()}.teamRole.${person.key}`)}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div>
                    <p class="mb-1.5 text-[12px] text-text-tertiary">
                      {i18n.t("kernel.demo.youllSee")}
                    </p>
                    <ul
                      data-testid="demo-picked"
                      class="flex flex-wrap gap-1.5"
                      aria-label={i18n.t("kernel.demo.youllSee")}
                    >
                      <Show
                        when={!everything()}
                        fallback={
                          <li
                            data-testid="demo-picked-all"
                            class="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-0.5 text-[12.5px] font-medium text-accent-foreground"
                          >
                            {explore()
                              ? i18n.t("kernel.demo.exploreChip")
                              : `${i18n.t("kernel.demo.needEverything")} · ${minutes()}`}
                          </li>
                        }
                      >
                        <For each={needs()}>
                          {(need, i) => (
                            <li
                              data-testid={`demo-picked-${need}`}
                              class="inline-flex items-center gap-1.5 rounded-full border border-border bg-elevated py-0.5 pl-0.5 pr-2.5 text-[12.5px] font-medium text-text"
                            >
                              <span
                                class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full font-mono text-[10px] font-semibold text-white"
                                style={{ "background-color": appSquareColor(needAppId(need)) }}
                              >
                                {i() + 1}
                              </span>
                              {i18n.t(`kernel.demo.needShort.${need}`)}
                            </li>
                          )}
                        </For>
                      </Show>
                    </ul>
                  </div>
                </aside>
              </div>
              <p
                data-testid="demo-company-simulated"
                class="border-t border-border pt-3.5 text-[13px] text-text-tertiary"
              >
                {i18n.t(`${copy()}.companySimulated`)}
              </p>
              <Button
                type="button"
                data-testid="demo-company-continue"
                onClick={toDetails}
                class="w-full sm:w-auto sm:self-end"
              >
                {i18n.t("kernel.demo.pickContinue")}
              </Button>
            </div>
          </section>
        </Match>
        <Match when={step() === 3}>
          <section
            data-testid="demo-signup-door"
            class="flex flex-1 justify-center px-4 pb-10 pt-2 sm:px-6 lg:pt-10"
          >
            <form
              class="flex w-full max-w-[420px] flex-col gap-5"
              onSubmit={(e) => void createWorkspace(e)}
            >
              <button
                type="button"
                data-testid="demo-details-back"
                onClick={() => setStep(2)}
                class="self-start text-[13px] text-text-secondary underline underline-offset-2 hover:text-text"
              >
                ← {i18n.t("kernel.demo.detailsBack")}
              </button>
              <h1 class="text-2xl font-semibold leading-tight text-text sm:text-[28px]">
                {i18n.t("kernel.demo.detailsTitle")}
              </h1>
              <div class="flex flex-col gap-3">
                <Input
                  ref={(el: HTMLInputElement) => (nameField = el)}
                  label={i18n.t("kernel.demo.nameLabel")}
                  placeholder={i18n.t("kernel.demo.namePlaceholder")}
                  value={name()}
                  maxLength={80}
                  name="name"
                  autocomplete="name"
                  data-testid="demo-name"
                  onInput={(e) => setName(e.currentTarget.value)}
                />
                <Input
                  label={i18n.t("kernel.demo.emailLabel")}
                  type="email"
                  placeholder={i18n.t("kernel.demo.emailPlaceholder")}
                  value={email()}
                  maxLength={254}
                  name="email"
                  autocomplete="email"
                  data-testid="demo-email"
                  onInput={(e) => setEmail(e.currentTarget.value)}
                />
                <label class="flex items-start gap-2 text-[13px] leading-snug text-text-secondary">
                  <input
                    type="checkbox"
                    data-testid="demo-news-opt-in"
                    checked={newsOptIn()}
                    onChange={(e) => setNewsOptIn(e.currentTarget.checked)}
                    class="mt-0.5"
                  />
                  <span>{i18n.t("kernel.demo.newsOptIn")}</span>
                </label>
              </div>
              <div class="flex flex-col gap-3">
                <turnstile.Widget />
                <Button
                  fullWidth
                  type="submit"
                  data-testid="demo-create"
                  loading={creating()}
                  disabled={creating() || startHint() !== null}
                  aria-describedby={startHint() ? "demo-create-hint" : undefined}
                >
                  {creating() ? i18n.t("kernel.demo.creating") : i18n.t("kernel.demo.createButton")}
                </Button>
                {/* Why Start is off, said where the visitor looks: a greyed button
                alone left visitors guessing that a scenario must be picked. */}
                <Show when={startHint()}>
                  {(hint) => (
                    <p
                      id="demo-create-hint"
                      data-testid="demo-create-hint"
                      class="text-[12px] leading-snug text-text-secondary"
                    >
                      {hint()}
                    </p>
                  )}
                </Show>
                {/* A busy moment: the server is still preparing the workspace and
                this page keeps asking on its own. Plain words, no alarm. */}
                <Show when={creating() && preparing()}>
                  <p
                    data-testid="demo-signup-preparing"
                    role="status"
                    class="text-[12px] leading-snug text-text-secondary"
                  >
                    {i18n.t("kernel.demo.signupPreparing")}
                  </p>
                </Show>
                <Show when={signupError()}>
                  <p data-testid="demo-signup-error" role="alert" class="text-xs text-error">
                    {signupError()}
                  </p>
                </Show>
                {/* Information at collection: what happens to the address, ticked or not. */}
                <p
                  data-testid="demo-lead-notice"
                  class="text-[11px] leading-snug text-text-tertiary"
                >
                  {i18n.t("kernel.demo.leadNotice")}
                  <Show when={privacyUrl()}>
                    {(url) => (
                      <>
                        {" "}
                        <a
                          href={url()}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="demo-privacy-link"
                          class="underline underline-offset-2 hover:text-text"
                        >
                          {i18n.t("kernel.demo.leadNoticePrivacy")}
                        </a>
                      </>
                    )}
                  </Show>
                </p>
              </div>
            </form>
          </section>
        </Match>
      </Switch>
    </div>
  )
}

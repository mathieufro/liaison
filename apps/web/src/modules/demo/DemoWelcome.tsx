// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's welcome popup: the first view after signup.
//
// A modal, and the one place a modal fits here: a trivial first-run choice,
// made once. Two steps:
//  1. "Turn on your agents": the email code (DemoVerifyPrompt), or "Use your
//     own model key instead", which opens the key form in its place. Skipped
//     when the address is already confirmed or a key is set; it moves on by
//     itself as soon as either is done.
//  2. "Where do you want to start?": the visitor's next scenario featured
//     with Start, the other picks listed with Start, in pick order, under the
//     needs picker's names. Start plays it through the scenario queue
//     (DemoScenarioRunner).
// "Browse on your own" sits in the footer at both steps; the close button,
// Escape and a click outside count as browsing too.
//
// IT OPENS BY ITSELF ONCE PER WORKSPACE. On the first arrival in it, with
// nothing on screen, until the visitor has answered it. The answer is the server's
// (`/api/demo/scenarios/welcome`, on the org's demo marker), so a reload or
// another browser does not ask again. "Scenarios k/n" in the banner always
// brings it back: on step 2 when the agents can run, otherwise on step 1.
//
// START OVER. Step 2 ends with "Start over", which asks first (a trivial
// confirm, in place of the list) and then hands the visitor a fresh workspace
// (`POST /api/demo/start-over`): the session moves to it in place, and the
// welcome opens there as on any first arrival, scenarios at 0.
//
// On a phone it is a bottom sheet with a grab handle and a sticky footer
// holding a full-width Browse; the list rows carry names only.
import type { DemoNeed, DemoWelcomeChoice, DemoWelcomeState } from "@liaison/shared"
import { X } from "lucide-solid"
import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import { sessionOrgId } from "~/modules/auth/auth-store"
import { DemoByokPrompt } from "~/modules/demo/DemoByokPrompt"
import { DemoExampleLine } from "~/modules/demo/DemoExampleLine"
import {
  type DemoScenarioItem,
  demoScenarioQueue,
  demoScenarioQueueLoaded,
  nextScenario,
  openScenario,
} from "~/modules/demo/DemoScenarioRunner"
import { DemoVerifyPrompt } from "~/modules/demo/DemoVerifyPrompt"
import {
  type DemoStartOverError,
  demoHasOwnKey,
  demoVerification,
  demoVerifyFocusRequest,
  refreshDemoBudget,
  startDemoOver,
} from "~/modules/demo/demo-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { resolveTour } from "~/modules/tours/tour-catalog"
import { tourStore } from "~/modules/tours/tour-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

type ApiClient = NonNullable<ReturnType<typeof useOptionalApi>>
type WelcomeStep = "agents" | "choose" | "startOver"

const [open, setOpen] = createSignal(false)
const [step, setStep] = createSignal<WelcomeStep>("agents")
/** Opened on step 1: the two-step bar shows, and step 2 says the agents are on. */
const [twoSteps, setTwoSteps] = createSignal(false)
/** Step 1 shows the key form in place of the code. */
const [keyForm, setKeyForm] = createSignal(false)
/**
 * The server's answer, with the org it is the answer OF. A visitor whose
 * workspace ended can start another in the same tab: the old one's answer is
 * not the new one's, so it only counts for the org the session is in now.
 */
const [answer, setAnswer] = createSignal<{
  orgId: string | null
  choice: DemoWelcomeChoice | null
} | null>(null)
/** The answer has been read for the org the session is in. */
const choiceLoaded = () => {
  const a = answer()
  return a !== null && a.orgId === sessionOrgId()
}
const choice = () => (choiceLoaded() ? (answer()?.choice ?? null) : null)
let client: ApiClient | null = null

/** The agents can run: a confirmed address, or the visitor's own key. */
function agentsOn(): boolean {
  return demoVerification()?.verified === true || demoHasOwnKey()
}

/** Open the popup: on step 2 when the agents can run, otherwise on step 1. */
export function openDemoWelcome(): void {
  const first: WelcomeStep = agentsOn() ? "choose" : "agents"
  setStep(first)
  setTwoSteps(first === "agents")
  setKeyForm(false)
  setOpen(true)
}

function record(next: DemoWelcomeChoice): void {
  if (choice() === next) return
  setAnswer({ orgId: sessionOrgId(), choice: next })
  void client
    ?.post<DemoWelcomeState>(
      "/demo/scenarios/welcome",
      { choice: next },
      {
        suppressGlobalError: true,
      },
    )
    .catch(() => {
      // Not recorded: the popup may open by itself once more on the next load.
    })
}

/** Browse, the close button, Escape, a click outside. */
function browse(): void {
  if (!open()) return
  // Leaving the start-over question is not an answer to the welcome.
  if (step() === "startOver") {
    setOpen(false)
    return
  }
  setOpen(false)
  record("browse")
}

function start(item: DemoScenarioItem): void {
  setOpen(false)
  record("start")
  void openScenario(item)
}

const actionKey = (item: DemoScenarioItem) =>
  item.status === "completed"
    ? "tours.engine.scenarioReplay"
    : item.status === "active" || item.status === "paused"
      ? "tours.engine.scenarioResume"
      : "tours.engine.scenarioStart"

/** A single-run scenario already played: it cannot be started again, only the whole demo started over. */
const isPlayedSingleRun = (item: DemoScenarioItem) =>
  item.singleRun === true && item.status === "completed"

/** The popup itself, and when it opens by itself. Mounted once, in DemoHost. */
export const DemoWelcome: Component<{ quiet?: boolean }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const phone = () => shellTier() === "phone"

  // Everything "once" here is once PER ORG: the session can move to another
  // org (a new demo workspace after an ended one) without a page load, and
  // that org is a first arrival of its own.
  const org = createMemo(sessionOrgId)

  // The answer, read on mount and again for each org the session moves to.
  createEffect(
    on(org, (orgId) => {
      if (!api) return
      client = api
      void (async () => {
        try {
          const state = await api.get<DemoWelcomeState>("/demo/scenarios/welcome", {
            suppressGlobalError: true,
          })
          // An answer read for an org the session has since left is not this one's.
          if (sessionOrgId() === orgId) setAnswer({ orgId, choice: state?.choice ?? null })
        } catch {
          // No answer (not a visitor workspace, the server unreachable): it does not open by itself.
        }
      })()
    }),
  )

  /** The org a once-flag was spent in; `undefined`: in none yet. */
  type SpentIn = string | null | undefined

  // Whether step 1 applies is the server's answer: read it once the visitor
  // has scenarios to offer.
  let budgetAskedIn: SpentIn
  createEffect(() => {
    const orgId = org()
    if (budgetAskedIn === orgId || !api) return
    if (!demoScenarioQueueLoaded() || demoScenarioQueue().length === 0) return
    budgetAskedIn = orgId
    if (demoVerification() === null) void refreshDemoBudget(api)
  })

  // The first arrival: nothing on screen, no answer yet. Once per org.
  let offeredIn: SpentIn
  createEffect(() => {
    const orgId = org()
    if (offeredIn === orgId || props.quiet) return
    if (!choiceLoaded() || !demoScenarioQueueLoaded() || !tourStore.itemsLoaded) return
    if (demoVerification() === null && !demoHasOwnKey()) return
    // A tour is about to come on screen (its link, a start): nothing opens over it.
    if (tourStore.starting) return
    offeredIn = orgId
    if (choice() !== null || demoScenarioQueue().length === 0) return
    const onScreen = tourStore.items.some(
      (i) => i.progress?.status === "active" || i.progress?.status === "paused",
    )
    if (onScreen || tourStore.current || tourStore.completed) return
    openDemoWelcome()
  })

  // Step 1 is done as soon as the agents can run (the code, or a saved key).
  createEffect(() => {
    if (open() && step() === "agents" && agentsOn()) setStep("choose")
  })

  // A spend refused for want of a confirmed address, outside a guided step
  // (whose own gate asks then): the code is asked for here.
  createEffect(
    on(
      demoVerifyFocusRequest,
      (n) => {
        if (n > 0 && !open() && !agentsOn() && tourStore.current?.status !== "active") {
          openDemoWelcome()
        }
      },
      { defer: true },
    ),
  )

  // A tour came on screen (a link, the tours menu): the popup steps aside.
  createEffect(
    on(
      () => (tourStore.current?.status === "active" ? tourStore.current.tourId : null),
      (activeId) => {
        if (activeId) setOpen(false)
      },
      { defer: true },
    ),
  )

  const featured = () => {
    const items = demoScenarioQueue()
    return nextScenario(items) ?? items.find((item) => resolveTour(item.tourId))
  }
  const others = () =>
    demoScenarioQueue().filter((item) => item !== featured() && resolveTour(item.tourId))
  const needName = (need: DemoNeed) => i18n.t(`kernel.demo.need.${need}`)
  const needDesc = (need: DemoNeed) => i18n.t(`kernel.demo.needDesc.${need}`)
  /** Phone: the content scrolls, the footer stays. */
  const pad = () => (phone() ? "px-4" : "")

  return (
    <Dialog open={open()} onOpenChange={(next) => !next && browse()}>
      <Dialog.Content
        positionerClass={phone() ? "items-end p-0" : undefined}
        class={
          phone()
            ? "max-h-[92dvh] max-w-none overflow-y-auto rounded-t-2xl rounded-b-none border-x-0 border-b-0 p-0 pt-2"
            : "max-h-[90dvh] max-w-[440px] overflow-y-auto p-5"
        }
      >
        <div
          data-testid="demo-welcome"
          data-step={step()}
          data-variant={phone() ? "sheet" : "dialog"}
          class="relative flex flex-col"
        >
          <Show when={phone()}>
            <div
              data-testid="demo-welcome-handle"
              aria-hidden="true"
              class="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-border-strong"
            />
          </Show>
          <button
            type="button"
            data-testid="demo-welcome-close"
            aria-label={i18n.t("tours.engine.close")}
            onClick={() => browse()}
            class={`absolute right-0 flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary ${
              phone() ? "top-2 right-3" : "-top-1"
            }`}
          >
            <X size={14} />
          </button>
          <div class={`flex flex-col ${pad()}`}>
            <Show when={twoSteps()}>
              <div
                data-testid="demo-welcome-steps"
                role="img"
                aria-label={i18n.t("tours.engine.welcome.step", {
                  k: step() === "agents" ? 1 : 2,
                  n: 2,
                })}
                class="mb-3 flex gap-1.5 pr-9"
              >
                <span class="h-[3px] flex-1 rounded-full bg-accent" />
                <span
                  class={`h-[3px] flex-1 rounded-full ${
                    step() === "choose" ? "bg-accent" : "bg-surface-active"
                  }`}
                />
              </div>
            </Show>
            <Show when={step() !== "startOver"} fallback={<StartOverConfirm />}>
              <Show
                when={step() === "choose"}
                fallback={
                  <>
                    <Dialog.Title class="pr-9 text-[15px] font-semibold">
                      {i18n.t("tours.engine.welcome.agentsTitle")}
                    </Dialog.Title>
                    <p class="mt-1 mb-3 text-[13px] leading-snug text-text-secondary">
                      {i18n.t("tours.engine.welcome.agentsBody")}
                    </p>
                    <Show
                      when={keyForm()}
                      fallback={
                        <DemoVerifyPrompt>
                          <button
                            type="button"
                            data-testid="demo-welcome-own-key"
                            onClick={() => setKeyForm(true)}
                            class="self-start text-left text-[12px] text-text-secondary underline underline-offset-2 hover:text-text"
                          >
                            {i18n.t("tours.engine.welcome.ownKey")}
                          </button>
                        </DemoVerifyPrompt>
                      }
                    >
                      <DemoByokPrompt>
                        <button
                          type="button"
                          data-testid="demo-welcome-back-to-code"
                          onClick={() => setKeyForm(false)}
                          class="text-left text-[12px] text-text-secondary underline underline-offset-2 hover:text-text"
                        >
                          {i18n.t("tours.engine.welcome.backToCode")}
                        </button>
                      </DemoByokPrompt>
                    </Show>
                  </>
                }
              >
                <Show when={twoSteps()}>
                  <p
                    data-testid="demo-welcome-confirmed"
                    role="status"
                    class="mb-2 flex items-center gap-2 text-[13px] text-text-secondary"
                  >
                    <span aria-hidden="true" class="text-[14px] text-success">
                      ✓
                    </span>
                    {demoVerification()?.verified
                      ? i18n.t("tours.engine.welcome.confirmed")
                      : i18n.t("tours.engine.welcome.ownKeyReady")}
                  </p>
                </Show>
                <Dialog.Title class="pr-9 text-[15px] font-semibold">
                  {i18n.t("tours.engine.welcome.chooseTitle")}
                </Dialog.Title>
                <Show when={featured()}>
                  {(item) => (
                    <div
                      data-testid="demo-welcome-featured"
                      data-need={item().need}
                      data-status={item().status}
                      class="mt-3 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
                    >
                      <div class="min-w-0 flex-1">
                        <p class="text-[13.5px] font-semibold text-text">{needName(item().need)}</p>
                        <p class="text-[12px] leading-snug text-text-secondary">
                          {needDesc(item().need)}
                        </p>
                        <p class="mt-0.5 font-mono text-[10.5px] text-text-tertiary">
                          {i18n.t("tours.engine.welcome.nextUp")}
                        </p>
                      </div>
                      <Show
                        when={isPlayedSingleRun(item())}
                        fallback={
                          <Button
                            size="sm"
                            class="shrink-0"
                            data-testid="demo-welcome-featured-start"
                            onClick={() => start(item())}
                          >
                            {i18n.t(actionKey(item()))}
                          </Button>
                        }
                      >
                        <PlayedAction need={item().need} prefix="demo-welcome-featured" />
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={others().length > 0}>
                  <p class="mx-1 mt-3 mb-1 font-mono text-[10px] font-semibold tracking-[0.07em] text-text-tertiary uppercase">
                    {i18n.t("tours.engine.welcome.orPick")}
                  </p>
                  <ul class="flex flex-col gap-px">
                    <For each={others()}>
                      {(item) => (
                        <li
                          data-testid={`demo-welcome-row-${item.need}`}
                          data-need={item.need}
                          data-status={item.status}
                          class={`flex items-center gap-2.5 rounded-md px-1 hover:bg-surface-hover ${
                            phone() ? "py-2" : "py-1.5"
                          }`}
                        >
                          <div class="min-w-0 flex-1">
                            <p class="text-[13px] font-medium text-text">{needName(item.need)}</p>
                            <Show when={!phone()}>
                              <p
                                data-testid={`demo-welcome-row-${item.need}-desc`}
                                class="text-[12px] leading-snug text-text-secondary"
                              >
                                {needDesc(item.need)}
                              </p>
                            </Show>
                          </div>
                          <Show
                            when={isPlayedSingleRun(item)}
                            fallback={
                              <Button
                                size="sm"
                                variant="outline"
                                class="shrink-0"
                                data-testid={`demo-welcome-row-${item.need}-start`}
                                onClick={() => start(item)}
                              >
                                {i18n.t(actionKey(item))}
                              </Button>
                            }
                          >
                            <PlayedAction
                              need={item.need}
                              prefix={`demo-welcome-row-${item.need}`}
                            />
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <button
                  type="button"
                  data-testid="demo-welcome-start-over"
                  onClick={() => setStep("startOver")}
                  class="mx-1 mt-3 self-start text-left text-[12px] text-text-secondary underline underline-offset-2 hover:text-text"
                >
                  {i18n.t("tours.engine.welcome.startOver")}
                </button>
              </Show>
            </Show>
            {/* The first view inside the world: what it is, in one quiet line. */}
            <Show when={step() !== "startOver"}>
              <DemoExampleLine class="mx-1 mt-3 text-[12px] text-text-secondary" />
            </Show>
          </div>
          <Show when={step() !== "startOver"}>
            <div
              data-testid="demo-welcome-footer"
              class={
                phone()
                  ? "sticky bottom-0 mt-4 flex flex-col gap-2 border-t border-border-subtle bg-elevated px-4 pt-2.5 pb-[max(14px,env(safe-area-inset-bottom,0px))]"
                  : "mt-4 flex flex-wrap items-center justify-between gap-2.5 border-t border-border-subtle pt-3"
              }
            >
              <span class="text-[12px] text-text-tertiary">
                {step() === "agents"
                  ? i18n.t("tours.engine.welcome.confirmLater")
                  : i18n.t("tours.engine.welcome.inBanner")}
              </span>
              <Button
                size="sm"
                variant="outline"
                fullWidth={phone()}
                data-testid="demo-welcome-browse"
                onClick={() => browse()}
              >
                {i18n.t("tours.engine.welcome.browse")}
              </Button>
            </div>
          </Show>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

/** What a played single-run scenario shows in place of Start: that it was played, and Start over. */
const PlayedAction: Component<{ need: DemoNeed; prefix: string }> = (props) => {
  const i18n = useI18n()
  return (
    <span class="flex shrink-0 items-center gap-2">
      <span data-testid={`${props.prefix}-played`} class="text-[12px] text-text-tertiary">
        {i18n.t("tours.engine.scenarioPlayed")}
      </span>
      <Button
        size="sm"
        variant="outline"
        data-testid={`${props.prefix}-start-over`}
        data-need={props.need}
        onClick={() => setStep("startOver")}
      >
        {i18n.t("tours.engine.welcome.startOver")}
      </Button>
    </span>
  )
}

/**
 * "Start over?": the trivial confirm in place of the scenario list. Yes hands
 * the visitor a fresh workspace (demo-store `startDemoOver`), session included,
 * and lands them on its home, where the welcome opens as on a first arrival.
 */
const StartOverConfirm: Component = () => {
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const phone = () => shellTier() === "phone"

  async function confirm(): Promise<void> {
    if (busy() || !client) return
    setBusy(true)
    setError(null)
    try {
      await startDemoOver(client)
      setOpen(false)
      setStep("agents")
      spaNavigate("/")
    } catch (err) {
      const failure = err as DemoStartOverError
      setError(failure.message ?? i18n.t("tours.engine.welcome.startOverFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="demo-start-over" class="flex flex-col">
      <Dialog.Title class="pr-9 text-[15px] font-semibold">
        {i18n.t("tours.engine.welcome.startOverTitle")}
      </Dialog.Title>
      <p class="mt-1 text-[13px] leading-snug text-text-secondary">
        {i18n.t("tours.engine.welcome.startOverBody", { n: demoScenarioQueue().length })}
      </p>
      <Show when={demoHasOwnKey()}>
        <p
          data-testid="demo-start-over-own-key"
          class="mt-2 text-[12px] leading-snug text-text-secondary"
        >
          {i18n.t("tours.engine.welcome.startOverOwnKey")}
        </p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p data-testid="demo-start-over-error" role="alert" class="mt-2 text-[12px] text-error">
            {message()}
          </p>
        )}
      </Show>
      <div
        class={
          phone()
            ? "mt-4 flex flex-col-reverse gap-2 pb-[max(14px,env(safe-area-inset-bottom,0px))]"
            : "mt-4 flex justify-end gap-2"
        }
      >
        <Button
          size="sm"
          variant="outline"
          fullWidth={phone()}
          data-testid="demo-start-over-cancel"
          disabled={busy()}
          onClick={() => setStep("choose")}
        >
          {i18n.t("tours.engine.welcome.startOverCancel")}
        </Button>
        <Button
          size="sm"
          fullWidth={phone()}
          data-testid="demo-start-over-confirm"
          disabled={busy()}
          onClick={() => void confirm()}
        >
          {busy()
            ? i18n.t("tours.engine.welcome.startOverWorking")
            : i18n.t("tours.engine.welcome.startOverConfirm")}
        </Button>
      </div>
    </div>
  )
}

/** "Scenarios k/n" in the demo banner: brings the welcome popup back. Mounted in DemoBanner. */
export const ScenariosBannerEntry: Component = () => {
  const i18n = useI18n()
  const done = () => demoScenarioQueue().filter((item) => item.status === "completed").length
  return (
    <Show when={demoScenarioQueue().length > 0}>
      <button
        type="button"
        data-testid="demo-scenarios-open"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => openDemoWelcome()}
        class="underline underline-offset-2 hover:text-text"
      >
        {i18n.t("tours.engine.scenarios", { k: done(), n: demoScenarioQueue().length })}
      </button>
    </Show>
  )
}

/** Test seam: reset the module's state between tests (a fresh page load). */
export const DemoWelcomeTestAccess = {
  reset(): void {
    setOpen(false)
    setStep("agents")
    setTwoSteps(false)
    setKeyForm(false)
    setAnswer(null)
    client = null
  },
}

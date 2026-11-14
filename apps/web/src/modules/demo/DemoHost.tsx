// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Everything the demo adds INSIDE the product, in one mount.
//
// The order on screen is the order of urgency: the standing banner, then the
// honest state of the seed while it is still running. The first view is the
// welcome popup (the email code, then where to start), a choice the visitor
// can wave away; it is not a wall. The only
// surface that takes the screen is the expired one, and it takes it because
// behind it every authenticated request is already being refused with a 403
// (demoExpiryMiddleware), so there is no product left to show.
import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { clearAuth } from "~/modules/auth/auth-store"
import { DemoBanner } from "~/modules/demo/DemoBanner"
import { DemoNextSteps } from "~/modules/demo/DemoNextSteps"
import { DemoScenarioRunner } from "~/modules/demo/DemoScenarioRunner"
import { DemoVerifyGate } from "~/modules/demo/DemoVerifyPrompt"
import { DemoWelcome } from "~/modules/demo/DemoWelcome"
import {
  demoExhaustedRequest,
  demoNextSteps,
  demoWorkspace,
  forgetDemoWorkspace,
  isDemoWorkspaceExpired,
  listenForDemoRefusals,
  openDemoNextStepsOnce,
  syncDemoWorkspace,
} from "~/modules/demo/demo-store"
import { forgetDemoWorld, loadDemoWorld } from "~/modules/demo/demo-world"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { demoOrgSurfaces } from "~/modules/shell/branding-store"
import { registerTourBeatGate, registerTourRefusalGate } from "~/modules/tours/beat-gates"
import { createNow } from "~/primitives/createNow"
import { Button } from "~/ui/Button"

export const DemoHost: Component = () => {
  const i18n = useI18n()
  // A minute is fine: the copy names a date and a time, not a countdown.
  const now = createNow(60_000)
  const [dismissedState, setDismissedState] = createSignal(false)

  const expired = () => demoOrgSurfaces() && isDemoWorkspaceExpired(now())
  const state = () => demoWorkspace()?.state ?? null

  // A reload lands here with whatever this browser last stored, which is not
  // the server's truth: ask the server once, and restart the poller only if
  // the seed really is still running (syncDemoWorkspace). Once, as soon as the
  // server's demo flag is known: branding can land after this mounts.
  let synced = false
  createEffect(() => {
    if (synced || !demoOrgSurfaces()) return
    synced = true
    // Spend refusals are heard here, only on a demo deployment.
    listenForDemoRefusals()
    void syncDemoWorkspace()
  })

  // A guided scenario's step that needs the agents waits on a confirmed
  // address: the tour panel shows the email-code prompt there (the scenario
  // runner registers the budget and failed gates).
  createEffect(() => {
    if (!demoOrgSurfaces()) return
    onCleanup(registerTourBeatGate("verify", DemoVerifyGate))
    // A scenario's agent turn refused before it ran: the beat shows the gate
    // that lifts it (the code prompt, the budget), not "could not find".
    onCleanup(registerTourRefusalGate("demo_verification_required", "verify"))
    for (const code of ["demo_budget_exhausted", "demo_box_exhausted", "demo_network_exhausted"]) {
      onCleanup(registerTourRefusalGate(code, "budget"))
    }
  })

  // The FIRST refusal that says the budget is spent opens the next-steps
  // dialog, unless it already opened by itself in this workspace.
  const api = useOptionalApi()

  // The workspace's own world: the example line, the limits panel and the
  // welcome read it. A failed read (or an org that is not a visitor's, as the
  // reserved review org is not) leaves it unknown, and they show no world's
  // name. Read again whenever the session becomes a demo one.
  createEffect(() => {
    if (!demoOrgSurfaces() || !api) {
      forgetDemoWorld()
      return
    }
    void loadDemoWorld(api)
  })
  createEffect(
    on(
      demoExhaustedRequest,
      (n) => {
        if (n > 0 && api) void openDemoNextStepsOnce(api)
      },
      { defer: true },
    ),
  )

  function startOver(): void {
    forgetDemoWorkspace()
    clearAuth()
  }

  return (
    <Show when={demoOrgSurfaces()}>
      <DemoBanner />
      <Show when={!expired() && !dismissedState() && state() === "provisioning"}>
        <div
          data-testid="demo-state-provisioning"
          role="status"
          class="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3 py-1.5 text-[12px] leading-snug text-text-secondary"
        >
          <span
            aria-hidden="true"
            class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
          />
          <span>{i18n.t("kernel.demo.stateProvisioning")}</span>
        </div>
      </Show>
      <Show when={!expired() && !dismissedState() && state() === "failed"}>
        <div
          data-testid="demo-state-failed"
          role="alert"
          class="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-3 py-1.5 text-[12px] leading-snug text-text-secondary"
        >
          <span>{i18n.t("kernel.demo.stateFailed")}</span>
          <button
            type="button"
            data-testid="demo-state-dismiss"
            onClick={() => setDismissedState(true)}
            class="shrink-0 underline underline-offset-2 hover:text-text"
          >
            {i18n.t("kernel.dismiss")}
          </button>
        </div>
      </Show>
      <Show when={!expired()}>
        {/* The dialog carries its own code field and key form: the welcome
            popup does not open over it by itself. */}
        <DemoWelcome quiet={demoNextSteps() !== null} />
        <DemoScenarioRunner />
        <DemoNextSteps />
      </Show>
      <Show when={expired()}>
        <div
          data-testid="demo-expired"
          role="alertdialog"
          aria-modal="true"
          class="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-4"
        >
          <div class="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6 text-center">
            <h2 class="text-base font-semibold text-text">{i18n.t("kernel.demo.expiredTitle")}</h2>
            <p class="text-[13px] leading-relaxed text-text-secondary">
              {i18n.t("kernel.demo.expiredBody")}
            </p>
            <Button fullWidth data-testid="demo-expired-restart" onClick={startOver}>
              {i18n.t("kernel.demo.expiredAction")}
            </Button>
          </div>
        </div>
      </Show>
    </Show>
  )
}

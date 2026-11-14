// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The short, honest list of what this instance will not do.
//
// EVERY LINE IS GROUNDED IN SHIPPED CODE, and the grounding is named here so a
// later change to the product shows up as a line that no longer matches:
//
//   mail        assertDemoEgressAllowed(orgId, "outbound_mail") at the sandbox
//               mail bridge (apps/api/src/modules/apps/sandbox/bridge/egress.ts)
//               for a reply, and `DemoRefusingEmailProvider` in
//               apps/api/src/infra/email.ts for the kernel channel that carries
//               invitations and sign-in links. BOTH refuse; neither sinks.
//   connectors  the same guard with "connector_credentials" on both credential
//               writes in apps/api/src/modules/apps/connections/service.ts, plus
//               the Shopify fixture provider in modules/demo/shopify.
//   ads         `DEMO_APPS` in apps/api/src/seed/tiers/demo/seed-org.ts does not include `ads`,
//               so the app is never installed in a demo workspace.
//   agents      a turn runs on this box's key only for a CONFIRMED address
//               (demo-verification.ts `demoVerifiedIdentity`), reserved and
//               settled per step against that mailbox's budget, its network's
//               and the box's (modules/demo/demo-spend.ts); a visitor's own
//               key runs instead, with no budget. No demo org holds credit
//               (`zeroDemoOrgCredits`).
//   mail code   the one mail that leaves: the verification code, to the
//               address typed at Start, through the demo system mail channel
//               (infra/email.ts `getDemoSystemMailProvider`).
//   expiry      `demoExpiryMiddleware` in modules/demo/demo-expiry.ts refuses
//               every authenticated request once the marker's `expiresAt` has
//               passed. Every workspace a visitor creates carries one.
import type { DemoWorldId } from "@liaison/shared"
import { type Component, For } from "solid-js"
import { demoWorldId } from "~/modules/demo/demo-world"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Dialog } from "~/ui/Dialog"

/**
 * The connectors line is the one that depends on the company: the products
 * world's own fixtures, the software world's payments stand-in. A world with no
 * line of its own, or one that is not known yet, states the generic limits
 * only, never another world's.
 */
const CONNECTORS_KEY: Readonly<Partial<Record<DemoWorldId, string>>> = {
  products: "kernel.demo.limitConnectors",
  saas: "kernel.demo.world.saas.limitConnectors",
}

export function limitKeys(world: DemoWorldId | null): string[] {
  const connectors = world ? CONNECTORS_KEY[world] : undefined
  return [
    "kernel.demo.limitMail",
    ...(connectors ? [connectors] : []),
    "kernel.demo.limitAds",
    "kernel.demo.limitAgents",
    "kernel.demo.limitBudget",
    "kernel.demo.limitExpiry",
  ]
}

export interface DemoLimitsPanelProps {
  open: boolean
  onClose: () => void
}

export const DemoLimitsPanel: Component<DemoLimitsPanelProps> = (props) => {
  const i18n = useI18n()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content class="w-full max-w-lg">
        <Dialog.Title>{i18n.t("kernel.demo.limitsTitle")}</Dialog.Title>
        <ul data-testid="demo-limits" class="mt-4 flex flex-col gap-3">
          <For each={limitKeys(demoWorldId())}>
            {(key) => (
              <li class="flex gap-2.5 text-[13px] leading-relaxed text-text-secondary">
                <span aria-hidden="true" class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span>{i18n.t(key)}</span>
              </li>
            )}
          </For>
        </ul>
      </Dialog.Content>
    </Dialog>
  )
}

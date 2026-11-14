// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An outside change delivered to the payments app's own webhook handler.
//
// After a modelled write (or an injector's outside fact), the event the real
// processor would send is handed to the app's registered handler through
// `executeManifestWebhook`, the way the demo world's commerce order reaches the
// store app. The handler reads the event's object again by id, which the
// stand-in answers from the outside state, and updates the mirror. The app's
// source is never imported here.
//
// A delivery that follows a write runs AFTER the write's answer has gone back
// to the app (never nested inside its sandbox call), on the jobs pool. The
// pending ones are tracked so a test or a harness can wait for them.
import { randomBytes } from "node:crypto"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { executeManifestWebhook } from "~/modules/webhooks/manifest-execution"
import { resolveHandlerScopes } from "~/modules/webhooks/verification"
import { PAYMENTS_APP } from "./sentinel"

type Obj = Record<string, unknown>

const log = rootLogger.child({ module: "demo-payments-standin" })

/** The app's webhook endpoint name (its manifest's `webhooks` key). */
export const PAYMENTS_WEBHOOK_ENDPOINT = "events"

const pending = new Set<Promise<void>>()

/** The event the processor would send for `object`, in its shape. */
export function standInEvent(type: string, object: Obj, now: Date = new Date()): Obj {
  return {
    id: `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    type,
    livemode: object.livemode === true,
    created: Math.floor(now.getTime() / 1000),
    data: { object },
  }
}

/** Hand `event` to the app's own handler for `orgId`, now. Resolves with the handler's result. */
export async function deliverDemoPaymentsEvent(orgId: string, event: Obj): Promise<unknown> {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
  const registration = webhookHandlers.get([orgId, PAYMENTS_APP, PAYMENTS_WEBHOOK_ENDPOINT])
  if (!registration || !isManifestHandler(registration.handler)) {
    throw new Error(
      "demo payments stand-in: the payments app's webhook handler is not registered for this org",
    )
  }
  const handlerRef: ManifestHandlerRef = registration.handler
  const manifest = registration._manifest ?? {
    name: PAYMENTS_APP,
    schema: {},
    events: {},
    connections: {},
    network: {},
  }
  const scopes = resolveHandlerScopes(PAYMENTS_APP, [], { thirdParty: false, grantedScopes: [] })
  const actor: ActorContext = { actorType: "system", orgId, purpose: "webhook", scopes }
  return withRlsContext(
    actor,
    async (tx) => {
      const bridge = createRpcBridge(
        PAYMENTS_APP,
        "system",
        orgId,
        tx,
        manifest,
        scopes,
        "system",
        undefined,
        {
          actor,
        },
      )
      return executeManifestWebhook({
        appName: PAYMENTS_APP,
        orgId,
        holdsTx: true,
        handlerRef,
        bundleSource: await loadBundle(handlerRef.bundlePath),
        params: event,
        bridge,
        extraArgs: [{}],
      })
    },
    { pool: "jobs" },
  )
}

/** Deliver `type` for `object` after the current answer has returned. Never throws. */
export function scheduleDemoPaymentsEvent(orgId: string, type: string, object: Obj): void {
  const run = (async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    try {
      await deliverDemoPaymentsEvent(orgId, standInEvent(type, object))
    } catch (err) {
      log.error(
        { err, orgId, type, objectId: object.id },
        "demo payments stand-in: event delivery failed",
      )
    }
  })()
  pending.add(run)
  void run.finally(() => pending.delete(run))
}

/** Wait until every scheduled delivery of this process has run (tests, the QA harness). */
export async function settleDemoPaymentsDeliveries(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}

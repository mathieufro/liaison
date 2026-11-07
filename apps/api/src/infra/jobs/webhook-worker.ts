// SPDX-License-Identifier: FSL-1.1-ALv2
import { withRlsContext } from "~/db/rls"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { withPinnedJobSlot } from "~/infra/jobs/pinned-jobs-gate"
import { effectOnce } from "~/lib/effect-once"
import { rootLogger } from "~/lib/logger"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { createAppContext } from "~/modules/apps/context"
import { isAppOffForPathOrg } from "~/modules/apps/org-apps"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { resolveToolTimeoutMs } from "~/modules/apps/sandbox/executor"
import { createSandboxRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { executeManifestWebhook } from "~/modules/webhooks/manifest-execution"

const log = rootLogger.child({ module: "webhook-worker" })
const SAFE_NAME = /^[a-z][a-z0-9_-]*$/

interface WebhookRetryJob {
  orgId?: unknown
  appName?: unknown
  endpointName?: unknown
  payload?: unknown
  /** Lowercased inbound header dict persisted at enqueue time (B18). */
  headers?: Record<string, string>
  /**
   * The retry's effect-ledger key (S11), set at enqueue. A retry queued by an
   * older release carries none and runs unkeyed, as before.
   */
  deliveryId?: unknown
}

function budgetFor(declared: number | undefined): { timeoutMs?: number } {
  const timeoutMs = resolveToolTimeoutMs(declared)
  return timeoutMs ? { timeoutMs } : {}
}

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Injectable seam so tests can assert the header re-supply path without a live
 *  sandbox/worker pool. Defaults to the real manifest executor. */
type ManifestExecutor = typeof executeManifestWebhook
let manifestExecutor: ManifestExecutor = executeManifestWebhook

/**
 * Process a single webhook retry job. Exported for test use so the header
 * re-supply path can be exercised without a live BullMQ worker.
 */
export async function processWebhookRetry(
  data: WebhookRetryJob,
  signal?: AbortSignal,
): Promise<void> {
  // Validate job data before use — appName and orgId come from URL path params
  // of unauthenticated webhook requests, so they must be re-validated here.
  if (!data?.appName || typeof data.appName !== "string" || !SAFE_NAME.test(data.appName)) {
    log.warn({ data }, "Invalid webhook retry job data — skipping")
    return
  }
  if (!data?.orgId || typeof data.orgId !== "string") {
    log.warn({ data }, "Missing orgId in webhook retry — skipping")
    return
  }

  if (
    !data?.endpointName ||
    typeof data.endpointName !== "string" ||
    !SAFE_NAME.test(data.endpointName)
  ) {
    log.warn({ data }, "Invalid endpointName in webhook retry — skipping")
    return
  }

  const appName = data.appName
  const orgId = data.orgId
  const endpointName = data.endpointName

  // An app turned Off (or removed) for the org after the delivery was queued:
  // its handler does not run, the retry is dropped like a fresh delivery would
  // be (S19, D24). An unreadable state throws, so the job retries later.
  if (await isAppOffForPathOrg(orgId, appName)) {
    log.info({ orgId, appName, endpointName }, "webhook retry dropped: the app is Off for the org")
    return
  }

  const reg = webhookHandlers.get([orgId, appName, endpointName] as [string, string, string])
  if (!reg) {
    log.warn({ orgId, appName, endpointName }, "Webhook handler not found for retry")
    return
  }

  const run = () => runRetryHandler(data, orgId, appName, reg, signal)
  if (typeof data.deliveryId !== "string" || !DELIVERY_ID.test(data.deliveryId)) {
    await run()
    return
  }
  // Claimed before the handler runs (S11). The handler's writes commit in one
  // transaction, so its outcome is never in doubt:
  // - a run that threw released the claim, and the job's retry runs it again;
  // - a run that committed and then lost its process (the job re-run by the
  //   stalled check) finds the key done and stops;
  // - a run killed inside the handler left the claim of a dead process
  //   (unknown), and its transaction rolled back with the process, so nothing
  //   was applied: the re-run takes the key back and runs the handler again.
  //   The one window this cannot close (committed, killed before the key was
  //   stored) re-applies the delivery, which the handler dedups on the
  //   provider's webhook id, as it did before the ledger.
  // Another worker holding it throws EffectInFlight, which the job's backoff retries.
  await effectOnce(
    orgId,
    `webhook:${appName}:${endpointName}:${data.deliveryId}`,
    async () => {
      await run()
      return { applied: true }
    },
    { onUnknown: async () => ({ outcome: "retry" }) },
  )
}

type WebhookRegistration = NonNullable<ReturnType<typeof webhookHandlers.get>>

async function runRetryHandler(
  data: WebhookRetryJob,
  orgId: string,
  appName: string,
  reg: WebhookRegistration,
  signal?: AbortSignal,
): Promise<void> {
  // The retry's transaction holds a jobs connection for the handler's whole
  // run: it waits for admission first (infra/jobs/pinned-jobs-gate.ts).
  await withPinnedJobSlot(
    `webhook:${appName}`,
    () => runInTransaction(data, orgId, appName, reg),
    signal,
  )
}

async function runInTransaction(
  data: WebhookRetryJob,
  orgId: string,
  appName: string,
  reg: WebhookRegistration,
): Promise<void> {
  await withRlsContext(
    { actorType: "system", orgId, purpose: "webhook", scopes: [appName] },
    async (tx) => {
      if (isManifestHandler(reg.handler)) {
        const handlerRef = reg.handler as ManifestHandlerRef
        const manifest = (reg as any)._manifest
        if (!manifest) throw new Error("manifest webhook handler missing _manifest metadata")
        const bridge = createSandboxRpcBridge(appName, "system", orgId, tx, manifest)
        const source = await loadBundle(handlerRef.bundlePath)
        // Re-supply the inbound headers persisted at enqueue time. The primary
        // delivery passes them as the 3rd handler arg; without them, header-
        // dependent handlers (e.g. Shopify keys dedup off x-shopify-webhook-id)
        // reject the retry and the side effect is lost permanently.
        await manifestExecutor({
          appName,
          orgId,
          // Inside the retry's withRlsContext transaction.
          holdsTx: true,
          handlerRef,
          bundleSource: source,
          params: data.payload,
          bridge,
          extraArgs: [data.headers ?? {}],
          // The same budget as the delivery it retries, through the tools' resolver.
          ...budgetFor(reg.timeoutMs),
        })
      } else {
        const retryCtx = createAppContext(appName, "system", orgId, tx)
        await (reg.handler as (payload: unknown, ctx: any) => Promise<void>)(data.payload, retryCtx)
      }
    },
    { pool: "jobs" },
  )
}

/** Initialize webhook retry worker — call from startup (not module load)
 *  to avoid leaking BullMQ/Redis connections in tests. */
export function initWebhookWorker(): void {
  registerJobWorker("kernel", "retry-webhook", (data: WebhookRetryJob, ctx) =>
    processWebhookRetry(data, ctx?.signal),
  )
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const WebhookWorkerTestAccess = {
  /** Test-only: override the manifest executor; pass nothing to restore. */
  setManifestExecutor(fn?: ManifestExecutor): void {
    manifestExecutor = fn ?? executeManifestWebhook
  },
}

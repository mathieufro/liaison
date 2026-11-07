// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Cloudflare face of an app's Worker module: a WorkerEntrypoint whose
// `run(req, bridge)` is the loader's call into the isolate
// (`worker.getEntrypoint().run(req, bridgeStub)`). Everything else is
// worker-core.ts; `cloudflare:workers` stays external in the build
// (scripts/apps-build-worker-bundle.ts) and is the module's only import
// outside the app and the core.
//
// Contract with the loader:
//  - `req`: the `/run` body (worker-core.ts reads exportName, params,
//    extraArgs, approval, bridgeMethods; runToken and bridgeUrl belong in the
//    Bridge's props, not here).
//  - `bridge.call(method, args)`: resolves with the cell's 200 reply body,
//    parsed and unchanged (`{data}`, `{}`, or `{error, errorStatus?,
//    errorCode?}`), and throws only for a non-200 answer or a network failure.
//    The error envelope is not thrown by the Bridge because Workers RPC keeps
//    only an Error's message: the isolate turns it into the rejection
//    `{message: error, status: errorStatus, code: errorCode}` itself
//    (worker-core.ts bridgeReplyData), so the handler sees the status and
//    code exactly as on QuickJS.
//  - Returns worker-core.ts's WorkerRunResult; the loader adds loadMs/cold.
//
// Every run builds a fresh ctx (an app may key state on the ctx object).

import { WorkerEntrypoint } from "cloudflare:workers"
import { runWithBridge, type WorkerBridge, type WorkerRunRequest } from "./worker-core"

export function createWorkerEntrypoint(mod: Record<string, unknown>) {
  return class AppWorker extends WorkerEntrypoint {
    run(req: WorkerRunRequest, bridge: WorkerBridge) {
      return runWithBridge(mod, req, bridge)
    }
  }
}

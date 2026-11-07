// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"
import { executeManifestWebhook } from "~/modules/webhooks/manifest-execution"

describe("a manifest webhook's budget", () => {
  afterEach(() => mock.restore())
  const run = async (timeoutMs?: number) => {
    const execute = mock(async (_: unknown) => ({ ok: true }))
    spyOn(workerPool, "initWorkerPool").mockResolvedValue(undefined as never)
    spyOn(workerPool, "getWorkerPool").mockReturnValue({ execute } as never)
    await executeManifestWebhook({
      appName: "x",
      orgId: "00000000-0000-0000-0000-000000000001",
      holdsTx: false,
      handlerRef: { bundlePath: "b", exportName: "h", trusted: false } as never,
      bundleSource: "",
      params: {},
      bridge: {},
      ...(timeoutMs ? { timeoutMs } : {}),
    })
    return execute.mock.calls[0]?.[0] as { timeoutMs?: number }
  }
  it("reaches the sandbox when the manifest sets one", async () => {
    expect((await run(18000)).timeoutMs).toBe(18000)
  })
  it("stays the sandbox default otherwise", async () => {
    expect((await run()).timeoutMs).toBeUndefined()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The probe route registers runs the bridge route then refuses exactly as the
// live isolation probes expect: another run's token 403, expired 401,
// settled 410, a second nonce 409; its own token and nonce reach the probe bridge.

import { describe, expect, it } from "bun:test"
import { createAppBridgeRoutes } from "~/modules/apps/workers/bridge-route"
import { RunRegistry } from "~/modules/apps/workers/run-registry"
import { createWorkersProbeRoutes } from "./workers-probe-routes"

const ORG = "00000000-0000-4000-8000-0000000c0de1"

function setup(enabled = true) {
  const registry = new RunRegistry()
  const probe = createWorkersProbeRoutes({ enabled: () => enabled, registry })
  const bridge = createAppBridgeRoutes({ registry, isConfigured: () => true })
  const register = async (body: Record<string, unknown> = {}) => {
    const res = await probe.request("/probe-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, app: "probe-app", ...body }),
    })
    return {
      status: res.status,
      data: ((await res.json().catch(() => ({}))) as { data: Record<string, string> }).data,
    }
  }
  const call = async (runId: string, token: string, nonce: string, method = "probe_echo") => {
    const res = await bridge.request(`/${runId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-exec-nonce": nonce,
        "content-type": "application/json",
      },
      body: JSON.stringify({ callId: 1, method, args: ["hi"] }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { register, call }
}

describe("POST /api/_test/apps/workers/probe-run", () => {
  it("is 404 without the QA flag", async () => {
    const { register } = setup(false)
    expect((await register()).status).toBe(404)
  })

  it("its run answers its own token, and refuses the probes' four cases", async () => {
    const { register, call } = setup()
    const a = (await register()).data
    const b = (await register()).data
    expect(a.runToken).not.toBe(b.runToken)
    const nonce = a.nonceHint as string
    expect(await call(a.runId, a.runToken, nonce)).toEqual({
      status: 200,
      body: { data: { echo: "hi" } },
    })
    expect((await call(a.runId, a.runToken, nonce, "probe_org")).body).toEqual({ data: ORG })
    expect((await call(a.runId, b.runToken, nonce)).status).toBe(403)
    expect((await call(a.runId, a.runToken, "another-nonce")).status).toBe(409)

    const expired = (await register({ expire: true })).data
    const e = await call(expired.runId, expired.runToken, "n")
    expect(e.status).toBe(401)
    expect(e.body.reason).toBe("expired")

    const settled = (await register({ settle: true })).data
    expect((await call(settled.runId, settled.runToken, "n")).status).toBe(410)
  })

  it("refuses a bad body", async () => {
    const { register } = setup()
    expect((await register({ orgId: "nope" })).status).toBe(400)
  })
})

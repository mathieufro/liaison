// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetDemoWorld,
  demoWorldId,
  doorWorlds,
  loadDemoWorld,
  refreshDoorWorlds,
} from "~/modules/demo/demo-world"

const reply = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

beforeEach(() => _resetDemoWorld())

describe("the door's worlds", () => {
  it("are products alone until the deployment says more, and when its answer fails", async () => {
    expect(doorWorlds()).toEqual(["products"])
    await refreshDoorWorlds(reply(500, {}))
    expect(doorWorlds()).toEqual(["products"])
    await refreshDoorWorlds(reply(200, { data: { worlds: ["products", "saas"] } }))
    expect(doorWorlds()).toEqual(["products", "saas"])
  })

  it("keep the last good answer when a later read fails, and drop what is not a world", async () => {
    await refreshDoorWorlds(reply(200, { data: { worlds: ["saas", "nonsense"] } }))
    expect(doorWorlds()).toEqual(["products", "saas"])
    await refreshDoorWorlds(
      vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch,
    )
    expect(doorWorlds()).toEqual(["products", "saas"])
  })
})

describe("the workspace's world", () => {
  it("is read from the server, and unknown when the read fails", async () => {
    await loadDemoWorld({ get: vi.fn().mockResolvedValue({ worldId: "saas" }) })
    expect(demoWorldId()).toBe("saas")
    await loadDemoWorld({ get: vi.fn().mockRejectedValue(new Error("404")) })
    expect(demoWorldId()).toBeNull()
  })
})

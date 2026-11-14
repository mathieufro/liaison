// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which example company the door and the visitor's workspace are about.
//
// Two reads, both advisory, neither able to change what a start creates (the
// server derives the world from the answer, never from the browser):
//
//   doorWorlds()   the worlds this deployment runs (`GET /demo/door`, public).
//                  The door shows the world the answer opens among them. Until
//                  the read lands, and whenever it fails, only `products`.
//   demoWorldId()  the signed-in visitor workspace's own world (`GET
//                  /demo/world`). Null until known, and whenever the read
//                  fails or the org is not a visitor's (the reserved review
//                  org answers 404): what reads it then shows no world's
//                  name rather than another world's.
import { DEMO_DEFAULT_WORLD, type DemoWorldId, demoWorldIdOf, isDemoWorldId } from "@liaison/shared"
import { createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { apiUrl } from "~/lib/env"
import { log } from "~/lib/logger"

const demoWorldLog = log.child({ module: "demo-world" })

const DEFAULT_WORLDS: readonly DemoWorldId[] = [DEMO_DEFAULT_WORLD]

const [worlds, setWorlds] = createSignal<readonly DemoWorldId[]>(DEFAULT_WORLDS)
const [world, setWorld] = createSignal<DemoWorldId | null>(null)

/** The worlds the door offers, `products` alone until the deployment says more. */
/** The visitor workspace's world, or null while it is unknown. */
export { world as demoWorldId, worlds as doorWorlds }

/**
 * Read the worlds this deployment runs. Resolves to the worlds now in force:
 * the read's, or, when it fails, what was there before (a failed first read
 * leaves `products` alone).
 */
export async function refreshDoorWorlds(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly DemoWorldId[]> {
  try {
    const res = await fetchImpl(apiUrl("/demo/door"))
    if (!res.ok) {
      // Not a demo deployment (404) or a failing one: the door is the products door.
      demoWorldLog.debug({ status: res.status }, "demo door worlds not available")
      return worlds()
    }
    const body = (await res.json()) as { data?: { worlds?: unknown } }
    const listed = Array.isArray(body?.data?.worlds) ? body.data.worlds.filter(isDemoWorldId) : []
    // The default world is always there: a start never opens nothing.
    setWorlds(listed.includes(DEMO_DEFAULT_WORLD) ? listed : [DEMO_DEFAULT_WORLD, ...listed])
  } catch (err) {
    demoWorldLog.warn({ err }, "demo door worlds read failed")
  }
  return worlds()
}

/** Read the signed-in visitor workspace's world; a failed read leaves it unknown. */
export async function loadDemoWorld(api: Pick<ApiClient, "get">): Promise<void> {
  try {
    const body = await api.get<{ worldId?: unknown }>("/demo/world", { suppressGlobalError: true })
    setWorld(isDemoWorldId(body?.worldId) ? demoWorldIdOf(body.worldId) : null)
  } catch (err) {
    setWorld(null)
    demoWorldLog.warn({ err }, "demo world read failed")
  }
}

/** Forget the workspace's world (the session ended or is not a visitor's). */
export function forgetDemoWorld(): void {
  setWorld(null)
}

/** @internal - test seam: the world a read would set. */
export function _setDemoWorld(next: DemoWorldId | null): void {
  setWorld(next)
}

/** @internal - test seam: the worlds a door read would set. */
export function _setDoorWorlds(next: readonly DemoWorldId[]): void {
  setWorlds(next)
}

/** @internal - test isolation only. */
export function _resetDemoWorld(): void {
  setWorlds(DEFAULT_WORLDS)
  setWorld(null)
}

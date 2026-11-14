// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo organization's GitHub reads never leave the box. The GitHub app runs over the real
// sandbox egress bridge of a demo org, with a recorder as the transport: with no connection it
// answers not_connected before any call, and even with connection settings in place (a demo
// stand-in connection) the host refuses the fetch, the app answers not_connected, and the
// recorder sees nothing.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { envelopeError, SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import type { FetchAnswer, GithubCtx } from "../../../../../bundled-apps/github/src/client"
import { githubListCommits, githubListRepos } from "../../../../../bundled-apps/github/src/tools"

const MANIFEST = {
  name: "github",
  connections: {
    github: {
      type: "credentials",
      allowedDomains: ["api.github.com"],
      credentialFields: [
        { name: "token", type: "password" },
        { name: "owner", type: "text", readable: true },
      ],
    },
  },
}

let onTheWire: string[] = []

function githubCtx(orgId: string, credentials: Record<string, string> | null): GithubCtx {
  const methods = createEgressMethods({
    orgId,
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "github",
    actorType: "user",
    egress: async () => ({ allowedDomains: ["api.github.com"], manifest: MANIFEST }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: MANIFEST,
    txDb: null,
    resolveCredentials: async () => {
      if (!credentials) throw new Error('No connected account for connection "github"')
      return credentials
    },
    requireCapability: () => {},
    errorEnvelope: (err: { code?: string; message?: string }) =>
      envelopeError(err?.code ?? "RPC_ERROR", err?.message ?? String(err)),
    bulkIteratorCursors: new Map(),
  } as unknown as BridgeContext) as unknown as {
    fetch: (url: string, opts: string) => Promise<string>
    connections_getSettings: (name: string) => Promise<string>
  }
  return {
    fetch: async (url, opts) =>
      JSON.parse(await methods.fetch(url, JSON.stringify(opts ?? {}))) as FetchAnswer,
    connections: { getSettings: (name: string) => methods.connections_getSettings(name) },
  }
}

describe("GitHub in a demo organization", () => {
  let demoOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "github-demo", name: "GitHub Demo" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    invalidateDemoMarker()
    SandboxBridgeTestAccess.setFetch((async (url: string | URL) => {
      onTheWire.push(String(url))
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch)
    SandboxBridgeTestAccess.setFetchInterceptsHost((hostname) => hostname === "api.github.com")
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    onTheWire = []
    invalidateDemoMarker()
  })

  it("a demo org's call never reaches the network", async () => {
    DemoModeTestAccess.set(true)
    expect(await githubListRepos({}, githubCtx(demoOrgId, null))).toMatchObject({
      error: { code: "not_connected" },
    })
    const standIn = githubCtx(demoOrgId, { token: "demo-stand-in", owner: "maison-example" })
    expect(await githubListCommits({ repo: "maison-example/site" }, standIn)).toMatchObject({
      error: { code: "not_connected" },
    })
    expect(onTheWire).toEqual([])
  })
})

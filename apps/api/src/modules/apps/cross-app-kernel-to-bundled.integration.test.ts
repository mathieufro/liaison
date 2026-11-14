// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A core app calls a sandboxed bundled app: projects (in-process) reaches invoicing's internal
// `project_invoiced_get` through the target its manifest declares in `cross_app_calls`, and
// through nothing else. An undeclared internal tool of the same app is refused to it, and a
// person or an agent calling the internal tool directly is refused too.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const PROJECT = "7a000000-0000-4000-8000-0000000000aa"
const SCOPES = ["projects:projects:read", "projects:margin:read"]

let orgId = ""
let userId = ""

function actor(scopes = SCOPES): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

/** A call made from inside the projects app, through its bridge, as the core host builds it. */
async function fromProjects(tool: string, params: unknown): Promise<Record<string, any>> {
  const a = actor()
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      projectsAppManifest as never,
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge.executeTool(tool, JSON.stringify(params)))
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  userId = (await minimal.session(orgId, { role: "member" })).userId
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  await registerApps([invoicingDescriptor() as never], orgId)
  await primeOrgApps(orgId, 0)
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("a core app's call into a bundled app", () => {
  it("a kernel app's declared call reaches a bundled app's internal tool and nothing else", async () => {
    // Declared: projects reaches it without holding any invoicing scope.
    const ok = await fromProjects("invoicing:project_invoiced_get", { projectId: PROJECT })
    expect(ok.status).toBe("completed")
    expect(ok.result).toMatchObject({ projectId: PROJECT, invoicedExcl: 0, documents: [] })

    // Undeclared internal tool of the same app: refused.
    const other = await fromProjects("invoicing:recurring_item_issue", { item_id: PROJECT })
    expect(other.status).toBe("error")
    expect(other.error.code).toBe("forbidden")

    // The internal tool called directly, by a person or an agent: refused.
    for (const actorType of ["user", "agent"] as const) {
      const direct = await executeToolCore({
        toolName: "invoicing:project_invoiced_get",
        orgId,
        actor:
          actorType === "user"
            ? actor(["invoicing:documents:read"])
            : ({ actorType: "agent", orgId, agentId: userId, userId, scopes: ["*"] } as never),
        params: { projectId: PROJECT },
        origin: "human-ui",
      })
      expect("error" in direct && direct.error.code).toBe("forbidden")
    }
  })

  it("projects declares exactly one cross-app target", () => {
    expect(
      (projectsAppManifest as { cross_app_calls?: Array<{ target: string }> }).cross_app_calls?.map(
        (c) => c.target,
      ),
    ).toEqual(["invoicing:project_invoiced_get"])
  })
})

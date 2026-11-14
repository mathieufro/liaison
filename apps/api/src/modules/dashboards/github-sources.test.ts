// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The GitHub app's reads are dashboard sources (every-read-is-a-source.guard.test.ts): each
// list or record read saves in a dashboard block and runs for the viewer, through the app's
// real handler over a stand-in GitHub (the app's own test ctx), registered from its manifest
// declaration since a bundled app is not installed in a fresh test org. The file read stays
// off dashboards: one repository file's text, outside text with no rows. The reads kept off the
// agent's catalog stay sources: a person's block runs them, and the agent building a dashboard
// finds them in the source list.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { checkToolSource, listEligibleSources } from "~/modules/dashboards/sources"
import { handleToolCall } from "~/modules/mcp/tool-call"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import type { GithubCtx } from "../../../../../bundled-apps/github/src/client"
import * as github from "../../../../../bundled-apps/github/src/handlers"
import { asCtx, base64, fakeCtx, json } from "../../../../../bundled-apps/github/src/test-ctx"

const MANIFEST = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "bundled-apps",
      "github",
      "app.manifest.json",
    ),
    "utf8",
  ),
) as {
  tools: Record<
    string,
    { handler: string; description: string; requiredScopes: string[]; agentVisible?: boolean }
  >
}

/** The reads the agent's catalog leaves out: dashboard sources only. */
const HIDDEN = Object.keys(MANIFEST.tools).filter((n) => MANIFEST.tools[n]?.agentVisible === false)

const OWNER = "maison-example"
const R = `/repos/${OWNER}/site`
const person = { login: "maison-dev" }
const commit = (sha: string) => ({
  sha,
  html_url: "u",
  commit: { message: `Change ${sha}`, author: { name: "Dev", date: "2026-10-01T10:00:00Z" } },
  author: person,
  parents: [],
})
const item = (n: number) => ({
  number: n,
  title: `Item ${n}`,
  body: null,
  state: "open",
  base: { ref: "main" },
  head: { ref: "f" },
  user: person,
  labels: [],
  milestone: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  merged_at: null,
  closed_at: null,
  html_url: "u",
})
const file = { filename: "a", status: "modified", additions: 1, deletions: 1, patch: "-a\n+a" }

/** A stand-in GitHub answering every read below. */
const ROUTES = {
  [`/orgs/${OWNER}/repos?per_page=100&type=all`]: json([
    {
      name: "site",
      full_name: `${OWNER}/site`,
      private: true,
      html_url: "u",
      description: null,
      default_branch: "main",
      updated_at: "x",
    },
    {
      name: "app",
      full_name: `${OWNER}/app`,
      private: true,
      html_url: "u",
      description: null,
      default_branch: "main",
      updated_at: "x",
    },
  ]),
  [`${R}/commits?per_page=100`]: json([commit("c1"), commit("c2"), commit("c3")]),
  [`${R}/commits/c1`]: json({ ...commit("c1"), files: [file, file] }),
  [`${R}/pulls?sort=updated&direction=desc&per_page=100`]: json([item(1), item(2)]),
  [`${R}/pulls/1`]: json(item(1)),
  [`${R}/pulls/1/files?per_page=100`]: json([file]),
  [`${R}/issues?per_page=100`]: json([item(3), item(4), { ...item(5), pull_request: {} }]),
  [`${R}/milestones?state=all&per_page=100`]: json([
    { number: 1, title: "Launch", state: "open", open_issues: 1, closed_issues: 1, html_url: "u" },
  ]),
  [`${R}/labels?per_page=100`]: json([
    { name: "bug", color: "red", description: null },
    { name: "web", color: "blue", description: null },
  ]),
  [`${R}/releases?per_page=100`]: json([
    { tag_name: "v1", name: "v1", body: null, draft: false, prerelease: false, html_url: "u" },
  ]),
  [`${R}/tags?per_page=100`]: json([{ name: "v1", commit: { sha: "c1" } }]),
  [`${R}/contents`]: json([
    { type: "dir", name: "docs", path: "docs", sha: "s", size: 0 },
    { type: "file", name: "README.md", path: "README.md", sha: "s", size: 5 },
  ]),
  [`${R}/contents/README.md`]: json({
    type: "file",
    name: "README.md",
    path: "README.md",
    sha: "s",
    size: 5,
    html_url: "u",
    encoding: "base64",
    content: base64("Hello"),
  }),
  [`/search/issues?q=launch%20user%3A${OWNER}%20is%3Aissue&per_page=100`]: json({
    total_count: 1,
    items: [item(3)],
  }),
}

/** Each read made a source, the block's params, the list it counts, and the rows it gets. */
const SOURCES: Array<{
  tool: string
  params?: Record<string, unknown>
  rowsPath?: string
  rows: number
}> = [
  { tool: "github_list_repos", rows: 2 },
  { tool: "github_list", params: { kind: "labels", repo: "site" }, rows: 2 },
  { tool: "github_list_commits", params: { repo: "site" }, rows: 3 },
  {
    tool: "github_get_commit",
    params: { repo: "site", sha: "c1", withDiff: true },
    rowsPath: "commit.diffs",
    rows: 2,
  },
  { tool: "github_list_pull_requests", params: { repo: "site" }, rows: 2 },
  {
    tool: "github_get_pull_request",
    params: { repo: "site", number: 1, withFiles: true },
    rowsPath: "pullRequest.files",
    rows: 1,
  },
  { tool: "github_list_issues", params: { repo: "site" }, rows: 2 },
  { tool: "github_list_milestones", params: { repo: "site" }, rows: 1 },
  { tool: "github_list_labels", params: { repo: "site" }, rows: 2 },
  { tool: "github_list_releases", params: { repo: "site" }, rows: 1 },
  { tool: "github_list_tags", params: { repo: "site" }, rows: 1 },
  { tool: "github_list_tree", params: { repo: "site" }, rows: 2 },
  { tool: "github_search", params: { scope: "issues", query: "launch" }, rows: 1 },
]

let orgId = ""
let viewer: UserContext

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "GitHub Sources Org" })
  orgId = org.orgId
  await ensureAppsForOrg(orgId)
  const ctx: GithubCtx = asCtx(fakeCtx({ routes: ROUTES }))
  for (const [name, t] of Object.entries(MANIFEST.tools)) {
    const handler = (github as Record<string, unknown>)[t.handler] as (
      p: unknown,
      c: GithubCtx,
    ) => Promise<unknown>
    toolRegistry.set([orgId, "github", name], {
      appName: "github",
      name,
      description: t.description,
      requiredScopes: t.requiredScopes,
      readOnly: true,
      trustBoundary: "user",
      ...(t.agentVisible === false ? { agentVisible: false } : {}),
      params: z.record(z.string(), z.unknown()),
      handler: async (params: unknown) => handler(params, ctx),
    })
  }
  viewer = {
    actorType: "user",
    userId: org.adminUserId,
    orgId,
    scopes: ["kernel:dashboards:read", "kernel:dashboards:write", "github:repo:read"],
    dimensionGrants: {},
  }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("GitHub reads as dashboard sources", () => {
  it("names every read but the file read", () => {
    expect([...SOURCES.map((s) => s.tool), "github_read_file"].sort()).toEqual(
      Object.keys(MANIFEST.tools).sort(),
    )
  })

  for (const s of SOURCES) {
    it(`a dashboard block on ${s.tool} saves and runs`, async () => {
      const d = await createDashboard(viewer, {
        title: `Source ${s.tool}`,
        visibility: "personal",
        spec: {
          v: 1,
          blocks: [
            {
              id: "b",
              type: "metric",
              title: s.tool,
              source: {
                kind: "tool",
                tool: `github:${s.tool}`,
                params: s.params ?? {},
                ...(s.rowsPath ? { rowsPath: s.rowsPath } : {}),
              },
              map: { agg: "count" },
            },
          ],
        },
      })
      expect(await getBlockData(viewer, d.id, "b")).toMatchObject({
        ok: true,
        data: { kind: "metric", value: s.rows },
      })
    })
  }

  it("the reads kept off the agent's catalog are listed as sources, and an agent's call is refused", async () => {
    expect(HIDDEN.length).toBe(8)
    const listed = (
      await listEligibleSources(
        orgId,
        { userId: viewer.userId as string, scopes: viewer.scopes },
        "github",
        200,
      )
    ).map((s) => s.tool)
    for (const name of HIDDEN) {
      expect(listed).toContain(`github:${name}`)
      const env = await executeToolCore({
        toolName: `github:${name}`,
        orgId,
        actor: { ...viewer, actorType: "agent" } as never,
        params: { repo: "site" },
        origin: "in-app-agent",
      })
      expect("error" in env && env.error.code).toBe("forbidden")
    }
  })

  it("a coding agent over MCP cannot call the reads kept off the agent's catalog, by name or through liaison_call_tool", async () => {
    const mcpCtx = { orgId, actor: viewer, connectionId: crypto.randomUUID() } as never
    for (const name of HIDDEN) {
      const direct = (await handleToolCall(mcpCtx, `github__${name}`, { repo: "site" })) as {
        isError?: boolean
        structuredContent?: { error?: { code?: string } }
      }
      expect(direct.isError).toBe(true)
      const proxied = (await handleToolCall(mcpCtx, "liaison_call_tool", {
        name: `github__${name}`,
        arguments: { repo: "site" },
      })) as { isError?: boolean }
      expect(proxied.isError).toBe(true)
    }
    // A visible read still answers over MCP.
    const visible = (await handleToolCall(mcpCtx, "github__github_list_repos", {})) as {
      isError?: boolean
    }
    expect(visible.isError ?? false).toBe(false)
  })

  it("a dashboard block on github_read_file is refused: one file's text, no rows", async () => {
    expect(
      await checkToolSource(orgId, "github:github_read_file", {
        userId: viewer.userId as string,
        scopes: viewer.scopes,
      }),
    ).toMatchObject({ ok: false, code: "not_allowed" })
  })
})

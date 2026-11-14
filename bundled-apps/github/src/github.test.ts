// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The GitHub app over a fake ctx (test-ctx.ts): the client's single method and
// pinned host, its typed errors, pagination and caps; the tools' answers and
// refusals (another owner, dot segments, not connected); redaction of every
// text body; the write-token refusal and provisioning verify; the manifest.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { API_VERSION, githubRequest, MAX_ROWS, redactSecrets } from "./client"
import * as handlers from "./handlers"
import { FINE_GRAINED_WARNING, verifyGithub } from "./provisioning"
import { asCtx, base64, fakeCtx, json } from "./test-ctx"
import {
  githubGetCommit,
  githubGetPullRequest,
  githubList,
  githubListCommits,
  githubListIssues,
  githubListLabels,
  githubListMilestones,
  githubListPullRequests,
  githubListReleases,
  githubListRepos,
  githubListTags,
  githubListTree,
  githubReadFile,
  githubSearch,
} from "./tools"

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
const AUTH = { connection: "github", scheme: "bearer", fields: ["token"] }
const OWNER = "maison-example"
const REPO = `${OWNER}/site`
const R = `/repos/${OWNER}/site`
/** Key shapes a repository may hold (built at run time so no scanner flags this file). */
const GH_KEY = `ghp_${"A1b2C3d4E5".repeat(4)}`
const AWS_KEY = `AKIA${"ABCDEFGH23456789"}`

const commit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/${REPO}/commit/${sha}`,
  commit: {
    message,
    author: { name: "Maison Dev", date: "2026-10-01T10:00:00Z" },
    committer: { name: "Maison Dev", date: "2026-10-01T10:00:00Z" },
  },
  author: { login: "maison-dev" },
  parents: [{ sha: "p1" }],
})
const pr = (n: number, updated = "2026-10-02T10:00:00Z") => ({
  number: n,
  title: `Change ${n}`,
  body: "body",
  state: "open",
  draft: false,
  base: { ref: "main" },
  head: { ref: `feature-${n}` },
  user: { login: "maison-dev" },
  assignees: [],
  labels: [{ name: "web" }],
  milestone: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: updated,
  merged_at: null,
  closed_at: null,
  html_url: `https://github.com/${REPO}/pull/${n}`,
})
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: "text",
  state: "open",
  labels: [{ name: "bug" }],
  milestone: { title: "Launch" },
  user: { login: "maison-dev" },
  assignees: [],
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  closed_at: null,
  html_url: `https://github.com/${REPO}/issues/${n}`,
  ...extra,
})

describe("manifest", () => {
  it("is version 1.0.3", () => {
    expect(MANIFEST.version).toBe("1.0.3")
  })

  it("shows the agent six reads; each one kept off its catalog names the visible read to use", () => {
    const tools = MANIFEST.tools as Record<string, { agentVisible?: boolean; useInstead?: string }>
    const visible = Object.keys(tools).filter((n) => tools[n]?.agentVisible !== false)
    expect(visible.sort()).toEqual([
      "github_get_commit",
      "github_get_pull_request",
      "github_list",
      "github_list_repos",
      "github_read_file",
      "github_search",
    ])
    for (const [name, t] of Object.entries(tools)) {
      if (t.agentVisible !== false) continue
      expect({ name, instead: visible.includes(t.useInstead ?? "") }).toEqual({
        name,
        instead: true,
      })
    }
  })

  it("declares fourteen read tools on its scope, every one read-only and marking the turn", () => {
    const tools = Object.entries(MANIFEST.tools as Record<string, Record<string, unknown>>)
    expect(tools.length).toBe(14)
    for (const [name, t] of tools) {
      expect({ name, readOnly: t.readOnly, taint: t.taintSource, trust: t.trustBoundary }).toEqual({
        name,
        readOnly: true,
        taint: true,
        trust: "user",
      })
      expect(t.requiredScopes).toEqual(["github:repo:read"])
      expect(name.startsWith("github_")).toBe(true)
    }
    expect(MANIFEST.connections.github.allowedDomains).toEqual(["api.github.com"])
  })

  it("exports every handler it names", () => {
    const names = [
      ...Object.values(MANIFEST.tools as Record<string, { handler: string }>).map((t) => t.handler),
      MANIFEST.provisioning.handler,
      MANIFEST.provisioning.verify,
    ]
    expect(names.length).toBe(16)
    for (const name of names)
      expect(typeof (handlers as Record<string, unknown>)[name]).toBe("function")
  })

  it("never lets app code read the token: the owner is the only readable field", () => {
    const fields = MANIFEST.connections.github.credentialFields as Array<{
      name: string
      type: string
      readable?: boolean
    }>
    expect(fields.filter((f) => f.readable).map((f) => f.name)).toEqual(["owner"])
    expect(fields.find((f) => f.name === "token")?.type).toBe("password")
  })
})

describe("client", () => {
  it("the client sends only GET to the pinned host", async () => {
    const ctx = fakeCtx({ routes: { "/user": json({ login: "maison-dev" }) } })
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(githubRequest(asCtx(ctx), "/user", { method })).rejects.toMatchObject({
        code: "read_only",
      })
    }
    await expect(githubRequest(asCtx(ctx), "https://example.com/user")).rejects.toMatchObject({
      code: "invalid_url",
    })
    await expect(
      githubRequest(asCtx(ctx), "https://api.github.com.example.com/user"),
    ).rejects.toMatchObject({ code: "invalid_url" })
    expect(ctx.calls).toEqual([])
    await githubRequest(asCtx(ctx), "/user")
    expect(ctx.calls).toEqual([
      {
        url: "https://api.github.com/user",
        method: "GET",
        auth: AUTH,
        headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION },
      },
    ])
  })

  it("errors map to their codes and never carry the token", async () => {
    const echo = { message: `Bad credentials for ${GH_KEY}` }
    const cases: Array<[ReturnType<typeof json>, Record<string, unknown>]> = [
      [json(echo, {}, 401), { code: "auth_revoked" }],
      [
        json(echo, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }, 403),
        { code: "rate_limited", retryAt: new Date(1893456000 * 1000).toISOString() },
      ],
      [json(echo, {}, 429), { code: "rate_limited" }],
      [json(echo, {}, 403), { code: "forbidden" }],
      [json(echo, {}, 404), { code: "not_found" }],
      [json(echo, {}, 502), { code: "github_error", status: 502 }],
    ]
    for (const [answer, want] of cases) {
      const ctx = fakeCtx({ routes: { [`${R}/labels?per_page=100`]: answer } })
      const out = await githubListLabels({ repo: REPO }, asCtx(ctx))
      expect(out).toMatchObject({ error: { code: want.code } })
      if (want.retryAt) expect(out).toMatchObject({ error: { retryAt: want.retryAt } })
      expect(JSON.stringify(out)).not.toContain(GH_KEY)
      const err = await githubRequest(asCtx(ctx), `${R}/labels?per_page=100`).catch((e) => e)
      expect(err).toMatchObject(want.status ? { status: want.status } : {})
      expect(String(err.message)).not.toContain(GH_KEY)
    }
  })

  it(`follows Link pages and says truncated past ${MAX_ROWS} rows`, async () => {
    const page = (n: number) =>
      json(
        Array.from({ length: 100 }, (_, i) => ({ name: `t${n}-${i}`, commit: { sha: "s" } })),
        { link: `<https://api.github.com${R}/tags?per_page=100&page=${n + 1}>; rel="next"` },
      )
    const routes: Record<string, ReturnType<typeof json>> = { [`${R}/tags?per_page=100`]: page(1) }
    for (let n = 2; n <= 6; n++) routes[`${R}/tags?per_page=100&page=${n}`] = page(n)
    const out = (await githubListTags({ repo: REPO }, asCtx(fakeCtx({ routes })))) as {
      tags: unknown[]
      truncated?: boolean
    }
    expect(out.tags.length).toBe(MAX_ROWS)
    expect(out.truncated).toBe(true)
  })

  it("refuses an answer over 10 MB", async () => {
    const big = { status: 200, headers: {}, body: `"${"x".repeat(10 * 1024 * 1024)}"` }
    const ctx = fakeCtx({ routes: { [`${R}/labels?per_page=100`]: big } })
    expect(await githubListLabels({ repo: REPO }, asCtx(ctx))).toMatchObject({
      error: { code: "github_error" },
    })
  })
})

describe("tools", () => {
  it("not connected, expired and rate limited answer their codes and no data", async () => {
    const unconnected: Array<"throws" | { values: Record<string, string>; missing: string[] }> = [
      "throws",
      { values: {}, missing: ["token", "owner"] },
      { values: { owner: OWNER }, missing: ["token"] },
    ]
    for (const settings of unconnected) {
      const ctx = fakeCtx({ settings })
      const out = await githubListRepos({}, asCtx(ctx))
      expect(out).toMatchObject({ error: { code: "not_connected" } })
      expect(Object.keys(out)).toEqual(["error"])
      expect(ctx.calls).toEqual([])
    }
    const tokenless = fakeCtx()
    tokenless.fetch = async () => {
      throw Object.assign(new Error('Connection "github" has no token'), {
        code: "credential_missing",
      })
    }
    expect(await githubListTags({ repo: REPO }, asCtx(tokenless))).toMatchObject({
      error: { code: "not_connected" },
    })
    const expired = fakeCtx({
      routes: { [`/orgs/${OWNER}/repos?per_page=100&type=all`]: json({}, {}, 401) },
    })
    const out401 = await githubListRepos({}, asCtx(expired))
    expect(Object.keys(out401)).toEqual(["error"])
    expect(out401).toMatchObject({ error: { code: "auth_revoked" } })
    const limited = fakeCtx({
      routes: {
        [`${R}/commits?per_page=100`]: json({}, { "retry-after": "60" }, 403),
      },
    })
    const out403 = await githubListCommits({ repo: REPO }, asCtx(limited))
    expect(Object.keys(out403)).toEqual(["error"])
    expect(out403).toMatchObject({ error: { code: "rate_limited" } })
    expect(typeof (out403 as { error: { retryAt?: string } }).error.retryAt).toBe("string")
  })

  it("a diff and a code search holding a key shape come back redacted", async () => {
    const leaky = `const key = "${GH_KEY}" // and ${AWS_KEY}`
    const ctx = fakeCtx({
      routes: {
        [`${R}/commits/abc123`]: json({
          ...commit("abc123", `Remove ${GH_KEY}`),
          stats: { additions: 0, deletions: 1, total: 1 },
          files: [
            {
              filename: "config.js",
              status: "modified",
              additions: 0,
              deletions: 1,
              patch: `-${leaky}`,
            },
          ],
        }),
        [`/search/code?q=key%20user%3A${OWNER}&per_page=100`]: json({
          total_count: 1,
          items: [
            {
              path: "config.js",
              html_url: `https://github.com/${REPO}/blob/main/config.js`,
              repository: { full_name: REPO },
              text_matches: [{ fragment: leaky }],
            },
          ],
        }),
      },
    })
    const diff = await githubGetCommit({ repo: REPO, sha: "abc123", withDiff: true }, asCtx(ctx))
    const search = await githubSearch({ scope: "code", query: "key" }, asCtx(ctx))
    for (const out of [diff, search]) {
      const text = JSON.stringify(out)
      expect(text).toContain("[REDACTED]")
      expect(text).not.toContain(GH_KEY)
      expect(text).not.toContain(AWS_KEY)
    }
    expect(ctx.calls.find((c) => c.url.includes("/search/"))?.headers?.accept).toBe(
      "application/vnd.github.text-match+json",
    )
  })

  it("redacts every text body: messages, titles, bodies, descriptions, file content", async () => {
    const secret = `token ${GH_KEY}`
    const ctx = fakeCtx({
      routes: {
        [`${R}/commits?per_page=100`]: json([commit("c1", `Fix\n\n${secret}`)]),
        [`${R}/pulls?sort=updated&direction=desc&per_page=100`]: json([
          { ...pr(1), title: secret, body: secret },
        ]),
        [`${R}/issues?per_page=100`]: json([issue(2, { body: secret })]),
        [`${R}/releases?per_page=100`]: json([
          {
            tag_name: "v1",
            name: "v1",
            body: secret,
            draft: false,
            prerelease: false,
            created_at: "x",
            published_at: "x",
            author: null,
            html_url: "u",
          },
        ]),
        [`${R}/milestones?state=all&per_page=100`]: json([
          {
            number: 1,
            title: "M",
            description: secret,
            state: "open",
            due_on: null,
            open_issues: 1,
            closed_issues: 0,
            html_url: "u",
          },
        ]),
        [`${R}/contents/a.env`]: json({
          type: "file",
          name: "a.env",
          path: "a.env",
          sha: "s",
          size: 10,
          html_url: "u",
          encoding: "base64",
          content: base64(secret),
        }),
      },
    })
    const outs = [
      await githubListCommits({ repo: REPO }, asCtx(ctx)),
      await githubListPullRequests({ repo: REPO }, asCtx(ctx)),
      await githubListIssues({ repo: REPO }, asCtx(ctx)),
      await githubListReleases({ repo: REPO }, asCtx(ctx)),
      await githubListMilestones({ repo: REPO }, asCtx(ctx)),
      await githubReadFile({ repo: REPO, path: "a.env" }, asCtx(ctx)),
    ]
    for (const out of outs) {
      expect(JSON.stringify(out)).not.toContain(GH_KEY)
      expect(JSON.stringify(out)).toContain("[REDACTED]")
    }
  })

  it("a repository outside the owner is refused", async () => {
    for (const repo of ["someone-else/site", "maison-example-x/site", "../site", "x/y/z", ".."]) {
      const ctx = fakeCtx()
      const out = await githubListCommits({ repo }, asCtx(ctx))
      expect((out as { error: { code: string } }).error.code).toMatch(
        /^(repo_outside_owner|invalid_repo)$/,
      )
      expect(ctx.calls).toEqual([])
    }
    const search = fakeCtx()
    for (const query of ["key repo:someone-else/site", "key org:someone-else", "key user:x"]) {
      expect(await githubSearch({ scope: "code", query }, asCtx(search))).toMatchObject({
        error: { code: "repo_outside_owner" },
      })
    }
    expect(search.calls).toEqual([])
    // A qualifier inside parentheses, after NOT, after a minus or a quote is still checked.
    const grouped = fakeCtx()
    for (const query of [
      "key (repo:someone-else/site)",
      "key OR(org:someone-else)",
      "key NOT(user:x)",
      "key -repo:someone-else/site",
      'key "x"owner:someone-else',
      "(launch) (REPO:someone-else/site OR x)",
    ]) {
      expect(await githubSearch({ scope: "code", query }, asCtx(grouped))).toMatchObject({
        error: { code: "repo_outside_owner" },
      })
    }
    expect(grouped.calls).toEqual([])
    // The owner's name is matched without regard to case, as GitHub does.
    const ok = fakeCtx({ routes: { [`${R}/tags?per_page=100`]: json([]) } })
    expect(await githubListTags({ repo: "Maison-Example/site" }, asCtx(ok))).toEqual({ tags: [] })
  })

  it("github_list answers each kind with that kind's own read, and an unknown kind reads nothing", async () => {
    const routes = {
      [`${R}/issues?state=all&labels=bug&per_page=100`]: json([
        issue(1),
        issue(2, { pull_request: {} }),
      ]),
      [`${R}/milestones?state=all&per_page=100`]: json([]),
      [`${R}/labels?per_page=100`]: json([{ name: "bug", color: "red", description: null }]),
      [`${R}/releases?per_page=100`]: json([]),
      [`${R}/tags?per_page=100`]: json([{ name: "v1", commit: { sha: "c1" } }]),
      [`${R}/commits?per_page=100&sha=main&author=ana`]: json([]),
      [`${R}/contents`]: json([{ type: "dir", name: "docs", path: "docs", sha: "s", size: 0 }]),
    }
    const ctx = asCtx(fakeCtx({ routes }))
    const kinds: Array<[string, Record<string, unknown>, () => Promise<unknown>]> = [
      [
        "issues",
        { state: "all", labels: "bug" },
        () => githubListIssues({ repo: REPO, state: "all", labels: "bug" }, ctx),
      ],
      ["milestones", {}, () => githubListMilestones({ repo: REPO }, ctx)],
      ["labels", {}, () => githubListLabels({ repo: REPO }, ctx)],
      ["releases", {}, () => githubListReleases({ repo: REPO }, ctx)],
      ["tags", {}, () => githubListTags({ repo: REPO }, ctx)],
      [
        "commits",
        { ref: "main", author: "ana" },
        () => githubListCommits({ repo: REPO, ref: "main", author: "ana" }, ctx),
      ],
      ["tree", {}, () => githubListTree({ repo: REPO }, ctx)],
    ]
    for (const [kind, extra, own] of kinds) {
      const out: unknown = await githubList({ kind, repo: REPO, ...extra }, ctx)
      const want: unknown = await own()
      expect({ kind, out }).toEqual({ kind, out: want })
      expect(out).not.toHaveProperty("error")
    }
    const calls = fakeCtx()
    expect(await githubList({ kind: "wikis", repo: REPO }, asCtx(calls))).toMatchObject({
      error: { code: "invalid_params", message: expect.stringContaining('not "wikis"') },
    })
    expect(calls.calls).toEqual([])
  })

  it("a path with dot segments builds no other API path", async () => {
    const ctx = fakeCtx()
    for (const path of ["x/../../../user", "..", "docs/./a.md", "a/.../b"]) {
      expect(await githubReadFile({ repo: REPO, path }, asCtx(ctx))).toMatchObject({
        error: { code: "invalid_path" },
      })
      expect(await githubListTree({ repo: REPO, path }, asCtx(ctx))).toMatchObject({
        error: { code: "invalid_path" },
      })
    }
    for (const sha of ["..", "."]) {
      expect(await githubGetCommit({ repo: REPO, sha }, asCtx(ctx))).toMatchObject({
        error: { code: "invalid_path" },
      })
    }
    expect(ctx.calls).toEqual([])
    // Other characters stay inside their segment.
    const enc = fakeCtx({
      routes: {
        [`${R}/contents/docs/a%3Fb%23c%25.md?ref=main`]: json({
          type: "file",
          name: "x",
          path: "docs/a?b#c%.md",
          sha: "s",
          size: 1,
          html_url: "u",
          encoding: "base64",
          content: base64("ok"),
        }),
      },
    })
    expect(
      await githubReadFile({ repo: REPO, path: "docs/a?b#c%.md", ref: "main" }, asCtx(enc)),
    ).toMatchObject({ content: "ok" })
  })

  it("each of the fourteen tools answers its fixture and refuses another owner", async () => {
    const routes = {
      [`/orgs/${OWNER}/repos?per_page=100&type=all`]: json([
        {
          name: "site",
          full_name: REPO,
          owner: { login: OWNER },
          private: true,
          html_url: `https://github.com/${REPO}`,
          description: "Website",
          default_branch: "main",
          updated_at: "2026-10-01T10:00:00Z",
        },
      ]),
      [`${R}/commits?per_page=100&sha=main&since=2026-09-01`]: json([commit("c1", "Add page")]),
      [`${R}/commits/c1`]: json({
        ...commit("c1", "Add page"),
        stats: { additions: 1, deletions: 0, total: 1 },
        files: [{ filename: "a", status: "added", additions: 1, deletions: 0, patch: "+a" }],
      }),
      [`${R}/pulls?state=all&sort=updated&direction=desc&per_page=100`]: json([
        pr(3, "2026-10-05T10:00:00Z"),
        pr(2, "2026-08-01T10:00:00Z"),
      ]),
      [`${R}/pulls/3`]: json(pr(3)),
      [`${R}/pulls/3/files?per_page=100`]: json([
        { filename: "b", status: "modified", additions: 1, deletions: 1, patch: "-b\n+b" },
      ]),
      [`${R}/milestones?state=all&per_page=100`]: json([
        {
          number: 4,
          title: "Launch",
          description: null,
          state: "open",
          due_on: null,
          open_issues: 1,
          closed_issues: 2,
          html_url: "u",
        },
      ]),
      [`${R}/issues?state=all&milestone=4&per_page=100`]: json([
        issue(5),
        issue(6, { pull_request: { url: "x" } }),
      ]),
      [`${R}/labels?per_page=100`]: json([{ name: "bug", color: "d73a4a", description: null }]),
      [`${R}/releases?per_page=100`]: json([
        {
          tag_name: "v1.0.0",
          name: "First",
          body: "Notes",
          draft: false,
          prerelease: false,
          created_at: "2026-10-01T10:00:00Z",
          published_at: "2026-10-01T10:00:00Z",
          author: { login: "maison-dev" },
          html_url: "u",
        },
      ]),
      [`${R}/tags?per_page=100`]: json([{ name: "v1.0.0", commit: { sha: "c1" } }]),
      [`${R}/contents/README.md`]: json({
        type: "file",
        name: "README.md",
        path: "README.md",
        sha: "s1",
        size: 5,
        html_url: "u",
        encoding: "base64",
        content: base64("Hello"),
      }),
      [`${R}/contents/docs?ref=main`]: json([
        { type: "file", name: "a.md", path: "docs/a.md", sha: "s", size: 3, html_url: "u" },
      ]),
      [`/search/issues?q=launch%20user%3A${OWNER}%20is%3Apr&per_page=100`]: json({
        total_count: 1,
        items: [issue(3, { pull_request: {} })],
      }),
    }
    const ctx = asCtx(fakeCtx({ routes }))
    const cases: Array<[string, () => Promise<unknown>, unknown, () => Promise<unknown>]> = [
      [
        "github_list_repos",
        () => githubListRepos({}, ctx),
        { repos: [{ name: REPO, private: true, defaultBranch: "main" }] },
        () => githubSearch({ scope: "code", query: "x org:someone-else" }, ctx),
      ],
      [
        "github_list_commits",
        () => githubListCommits({ repo: REPO, ref: "main", since: "2026-09-01" }, ctx),
        { commits: [{ sha: "c1", title: "Add page", login: "maison-dev" }] },
        () => githubListCommits({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_get_commit",
        () => githubGetCommit({ repo: REPO, sha: "c1", withDiff: true }, ctx),
        { commit: { sha: "c1", diffs: [{ path: "a", diff: "+a" }] } },
        () => githubGetCommit({ repo: "someone-else/site", sha: "c1" }, ctx),
      ],
      [
        "github_list_pull_requests",
        () => githubListPullRequests({ repo: REPO, state: "all", since: "2026-09-01" }, ctx),
        { pullRequests: [{ number: 3, baseBranch: "main" }] },
        () => githubListPullRequests({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_get_pull_request",
        () => githubGetPullRequest({ repo: REPO, number: 3, withFiles: true }, ctx),
        { pullRequest: { number: 3, files: [{ path: "b" }] } },
        () => githubGetPullRequest({ repo: "someone-else/site", number: 3 }, ctx),
      ],
      [
        "github_list_issues",
        () => githubListIssues({ repo: REPO, state: "all", milestone: "Launch" }, ctx),
        { issues: [{ number: 5, milestone: "Launch" }] },
        () => githubListIssues({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_list_milestones",
        () => githubListMilestones({ repo: REPO }, ctx),
        { milestones: [{ number: 4, title: "Launch", closedIssues: 2 }] },
        () => githubListMilestones({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_list_labels",
        () => githubListLabels({ repo: REPO }, ctx),
        { labels: [{ name: "bug" }] },
        () => githubListLabels({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_list_releases",
        () => githubListReleases({ repo: REPO }, ctx),
        { releases: [{ tagName: "v1.0.0", author: "maison-dev" }] },
        () => githubListReleases({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_list_tags",
        () => githubListTags({ repo: REPO }, ctx),
        { tags: [{ name: "v1.0.0", sha: "c1" }] },
        () => githubListTags({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_read_file",
        () => githubReadFile({ repo: REPO, path: "README.md" }, ctx),
        { content: "Hello", path: "README.md" },
        () => githubReadFile({ repo: "someone-else/site", path: "README.md" }, ctx),
      ],
      [
        "github_list_tree",
        () => githubListTree({ repo: REPO, path: "docs", ref: "main" }, ctx),
        { entries: [{ path: "docs/a.md", type: "file" }] },
        () => githubListTree({ repo: "someone-else/site" }, ctx),
      ],
      [
        "github_list",
        () => githubList({ kind: "tree", repo: REPO, path: "docs", ref: "main" }, ctx),
        { entries: [{ path: "docs/a.md", type: "file" }] },
        () => githubList({ kind: "tags", repo: "someone-else/site" }, ctx),
      ],
      [
        "github_search",
        () => githubSearch({ scope: "pull_requests", query: "launch" }, ctx),
        { results: [{ number: 3 }] },
        () => githubSearch({ scope: "issues", query: "repo:someone-else/site launch" }, ctx),
      ],
    ]
    expect(cases.map((c) => c[0]).sort()).toEqual(Object.keys(MANIFEST.tools).sort())
    for (const [name, run, want, refused] of cases) {
      expect({ name, out: await run() }).toMatchObject({ name, out: want })
      expect({ name, out: await refused() }).toMatchObject({
        name,
        out: { error: { code: "repo_outside_owner" } },
      })
    }
    // Pull requests are left out of the issue list; an older pull request ends the PR list.
    expect(
      (
        (await githubListIssues({ repo: REPO, state: "all", milestone: "4" }, ctx)) as {
          issues: unknown[]
        }
      ).issues.length,
    ).toBe(1)
    expect(
      (
        (await githubListPullRequests({ repo: REPO, state: "all", since: "2026-09-01" }, ctx)) as {
          pullRequests: unknown[]
        }
      ).pullRequests.length,
    ).toBe(1)
  })

  it("lists a user owner's repositories through the token's own list when it is no organization", async () => {
    const ctx = fakeCtx({
      routes: {
        [`/user/repos?per_page=100&affiliation=owner`]: json([
          {
            name: "site",
            full_name: REPO,
            owner: { login: OWNER },
            private: true,
            html_url: "u",
            description: null,
            default_branch: "main",
            updated_at: "x",
          },
          {
            name: "other",
            full_name: "someone-else/other",
            owner: { login: "someone-else" },
            private: false,
            html_url: "u",
            description: null,
            default_branch: "main",
            updated_at: "x",
          },
        ]),
      },
    })
    const out = (await githubListRepos({}, asCtx(ctx))) as { repos: Array<{ name: string }> }
    expect(out.repos.map((r) => r.name)).toEqual([REPO])
  })
})

describe("write access", () => {
  it("a write-capable token is refused with the fix named", async () => {
    for (const scopes of ["repo, read:org", "public_repo", "admin:org", "write:packages"]) {
      const ctx = fakeCtx({
        routes: {
          "/user": json({ login: "maison-dev" }, { "x-oauth-scopes": scopes }),
          [`/orgs/${OWNER}/repos?per_page=100&type=all`]: json([], { "x-oauth-scopes": scopes }),
        },
      })
      const tool = await githubListRepos({}, asCtx(ctx))
      expect(tool).toMatchObject({ error: { code: "write_token_refused" } })
      expect((tool as { error: { message: string } }).error.message).toContain(
        "fine-grained token with read-only Contents",
      )
      const verified = await verifyGithub({}, asCtx(ctx))
      expect(verified.ok).toBe(false)
      expect(verified.problems[0]).toContain("write_token_refused")
    }
  })

  it("verify passes a read-only classic token, and warns when GitHub shows no permissions", async () => {
    const routes = (headers: Record<string, string>) => ({
      "/user": json({ login: "maison-dev" }, headers),
      [`/users/${OWNER}`]: json({ login: OWNER }, headers),
    })
    const classic = await verifyGithub(
      {},
      asCtx(fakeCtx({ routes: routes({ "x-oauth-scopes": "read:org" }) })),
    )
    expect(classic).toEqual({ ok: true, problems: [], identity: `maison-dev @ ${OWNER}` })
    const fine = await verifyGithub({}, asCtx(fakeCtx({ routes: routes({}) })))
    expect(fine).toEqual({
      ok: true,
      problems: [],
      identity: `maison-dev @ ${OWNER} (${FINE_GRAINED_WARNING})`,
    })
    const missing = await verifyGithub({}, asCtx(fakeCtx({ settings: "throws" })))
    expect(missing.ok).toBe(false)
    expect(missing.problems[0]).toContain("not_connected")
  })
})

describe("text helpers", () => {
  it("redacts high-confidence secrets only", () => {
    const fine = `github_pat_${"a1B2".repeat(15)}`
    expect(redactSecrets(`a ${GH_KEY} b ${fine} c sha 0123456789abcdef`)).toBe(
      "a [REDACTED] b [REDACTED] c sha 0123456789abcdef",
    )
  })
  // Every armoured private key header in use: PKCS#8 (no algorithm word), the
  // algorithm-named PKCS#1 and SEC1 forms, OpenSSH, encrypted PKCS#8, PGP and SSH2.
  // Built from the label so the source holds no literal key header.
  const armour = (label: string, ssh2 = false): [string, string] => {
    const d = ssh2 ? "----" : "-----"
    const s = ssh2 ? " " : ""
    return [`${d}${s}BEGIN ${label}${s}${d}`, `${d}${s}END ${label}${s}${d}`]
  }
  const PEM_LABELS: Array<[string, string]> = [
    armour("PRIVATE KEY"),
    armour("RSA PRIVATE KEY"),
    armour("EC PRIVATE KEY"),
    armour("DSA PRIVATE KEY"),
    armour("OPENSSH PRIVATE KEY"),
    armour("ENCRYPTED PRIVATE KEY"),
    armour("PGP PRIVATE KEY BLOCK"),
    armour("SSH2 ENCRYPTED PRIVATE KEY", true),
  ]
  const KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7"

  it("redacts every form of armoured private key, keeping the text around it", () => {
    for (const [begin, end] of PEM_LABELS) {
      const out = redactSecrets(`before\n${begin}\n${KEY_BODY}\n${end}\nafter`)
      expect(out).toBe("before\n[REDACTED]\nafter")
    }
  })

  it("redacts a private key removed or added in a diff", () => {
    for (const [begin, end] of PEM_LABELS) {
      const diff = `@@ -1,4 +0,0 @@\n-${begin}\n-${KEY_BODY.replace("\n", "\n-")}\n-${end}\n ok`
      const out = redactSecrets(diff)
      expect(out).not.toContain("MIIEvQ")
      expect(out).not.toContain("BKcwgg")
      expect(out).toContain(" ok")
    }
  })

  it("redacts a private key whose end is cut off through the end of its hunk", () => {
    for (const [begin] of PEM_LABELS) {
      const diff = `@@ -1,3 +1,3 @@\n+${begin}\n+${KEY_BODY}\n@@ -40,2 +40,2 @@\n kept line`
      const out = redactSecrets(diff)
      expect(out).not.toContain("MIIEvQ")
      expect(out).not.toContain("BKcwgg")
      expect(out).toContain("@@ -40,2 +40,2 @@\n kept line")
      expect(redactSecrets(`${begin}\n${KEY_BODY}`)).toBe("[REDACTED]")
    }
  })

  it("keeps public keys and certificates", () => {
    const pub = "-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----"
    const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"
    expect(redactSecrets(pub)).toBe(pub)
    expect(redactSecrets(cert)).toBe(cert)
  })
})

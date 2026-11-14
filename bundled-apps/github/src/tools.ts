// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The read-only tools, name for name with GitLab's, plus `github_list`: the one listing the
// agent sees for a repository's issues, pull requests, milestones, labels, releases, tags,
// commits and tree (each kind's own read stays a dashboard source, off the agent's catalog). Each answers a
// compact shape or `{ error: { code, message } }` (never a throw: a sandboxed
// throw reaches the agent redacted). `not_connected` when the caller has no
// usable `github` connection, before any call; a repository outside the
// connected owner and a dot segment in a path are refused before any call.
// Every text body passes `redactSecrets`.

import {
  base64Bytes,
  connectedOwner,
  filePath,
  type GithubCtx,
  GithubHttpError,
  GithubNotConnectedError,
  GithubParamError,
  getJson,
  getList,
  redacted,
  redactSecrets,
  repoPath,
  segment,
  utf8Text,
} from "./client"

export type ToolError = { error: { code: string; message: string; retryAt?: string } }

export function toolError(err: unknown): ToolError {
  if (err instanceof GithubNotConnectedError) {
    return {
      error: {
        code: "not_connected",
        message: `${err.message} Nothing was read. An admin connects GitHub in Settings → GitHub.`,
      },
    }
  }
  if (err instanceof GithubHttpError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.retryAt ? { retryAt: err.retryAt } : {}),
      },
    }
  }
  // The host refuses the call when the connection holds no token: GitHub is not connected.
  const code = (err as { code?: unknown } | null)?.code
  // A demo organization never reaches GitHub: the host refuses its calls.
  if (code === "DEMO_RESTRICTED") {
    return {
      error: {
        code: "not_connected",
        message: "GitHub is not connected in this demo organization. Nothing was read.",
      },
    }
  }
  if (
    code === "credential_missing" ||
    (err instanceof Error && /No connected account|has no token/.test(err.message))
  ) {
    return toolError(new GithubNotConnectedError())
  }
  if (err instanceof GithubParamError) {
    return { error: { code: err.code, message: `${err.message} Nothing was read.` } }
  }
  return {
    error: {
      code: "github_error",
      message: redactSecrets(err instanceof Error ? err.message : "GitHub tool failed"),
    },
  }
}

async function guarded<T>(
  ctx: GithubCtx,
  run: (owner: string) => Promise<T>,
): Promise<T | ToolError> {
  try {
    return await run(await connectedOwner(ctx))
  } catch (err) {
    return toolError(err)
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join("&")}` : ""
}

/** `truncated: true` only when the list stopped before its last row. */
function withTruncation<T extends Record<string, unknown>>(out: T, truncated: boolean): T {
  return truncated ? { ...out, truncated: true } : out
}

interface Person {
  login: string
}
interface Repo {
  name: string
  full_name: string
  owner?: Person
  private: boolean
  html_url: string
  description: string | null
  default_branch: string
  archived?: boolean
  updated_at: string
}
interface Commit {
  sha: string
  html_url: string
  commit: {
    message: string
    author: { name: string; date: string } | null
    committer?: { name: string; date: string } | null
  }
  author: Person | null
  parents?: Array<{ sha: string }>
  stats?: { additions: number; deletions: number; total: number }
  files?: ChangedFile[]
}
interface ChangedFile {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}
interface PullRequest {
  number: number
  title: string
  body: string | null
  state: string
  draft?: boolean
  base: { ref: string }
  head: { ref: string }
  user: Person | null
  assignees?: Person[]
  labels?: Array<{ name: string }>
  milestone: { title: string } | null
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
  html_url: string
}
interface Issue {
  number: number
  title: string
  body: string | null
  state: string
  labels?: Array<{ name: string } | string>
  milestone: { title: string } | null
  user: Person | null
  assignees?: Person[]
  created_at: string
  updated_at: string
  closed_at: string | null
  html_url: string
  pull_request?: unknown
}

const firstLine = (text: string) => text.split("\n", 1)[0] ?? ""

const commitShape = (c: Commit) => ({
  sha: c.sha,
  shortSha: c.sha.slice(0, 8),
  title: redactSecrets(firstLine(c.commit?.message ?? "")),
  message: redactSecrets(c.commit?.message ?? ""),
  author: c.commit?.author?.name ?? null,
  login: c.author?.login ?? null,
  date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
  url: c.html_url,
  parents: (c.parents ?? []).map((p) => p.sha),
})

const fileShape = (f: ChangedFile) => ({
  path: f.filename,
  previousPath: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  diff: redacted(f.patch ?? null),
})

const labelNames = (labels: Array<{ name: string } | string> | undefined) =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : l.name))

const prShape = (pr: PullRequest) => ({
  number: pr.number,
  title: redactSecrets(pr.title),
  body: redacted(pr.body),
  state: pr.state,
  draft: pr.draft === true,
  merged: pr.merged_at !== null && pr.merged_at !== undefined,
  baseBranch: pr.base?.ref ?? null,
  headBranch: pr.head?.ref ?? null,
  author: pr.user?.login ?? null,
  assignees: (pr.assignees ?? []).map((a) => a.login),
  labels: labelNames(pr.labels),
  milestone: pr.milestone?.title ?? null,
  createdAt: pr.created_at,
  updatedAt: pr.updated_at,
  mergedAt: pr.merged_at,
  closedAt: pr.closed_at,
  url: pr.html_url,
})

const issueShape = (i: Issue) => ({
  number: i.number,
  title: redactSecrets(i.title),
  body: redacted(i.body),
  state: i.state,
  labels: labelNames(i.labels),
  milestone: i.milestone?.title ?? null,
  author: i.user?.login ?? null,
  assignees: (i.assignees ?? []).map((a) => a.login),
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  closedAt: i.closed_at,
  url: i.html_url,
})

const repoShape = (r: Repo) => ({
  name: r.full_name,
  private: r.private,
  description: redacted(r.description),
  defaultBranch: r.default_branch,
  archived: r.archived === true,
  updatedAt: r.updated_at,
  url: r.html_url,
})

export async function githubListRepos(_params: unknown, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    let listed: { items: Repo[]; truncated: boolean }
    try {
      listed = await getList<Repo>(
        ctx,
        `/orgs/${segment(owner, "owner")}/repos?per_page=100&type=all`,
      )
    } catch (err) {
      if (!(err instanceof GithubHttpError) || err.code !== "not_found") throw err
      // A user, not an organization: the token's own repositories of that user, private included.
      listed = await getList<Repo>(ctx, "/user/repos?per_page=100&affiliation=owner", {
        keep: (r) => (r.owner?.login ?? "").toLowerCase() === owner.toLowerCase(),
      })
    }
    return withTruncation({ repos: listed.items.map(repoShape) }, listed.truncated)
  })
}

export async function githubListCommits(
  params: {
    repo: string
    ref?: string
    path?: string
    since?: string
    until?: string
    author?: string
  },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const qs = query({
      per_page: 100,
      sha: params.ref,
      path: params.path,
      since: params.since,
      until: params.until,
      author: params.author,
    })
    const { items, truncated } = await getList<Commit>(
      ctx,
      `${repoPath(owner, params.repo)}/commits${qs}`,
    )
    return withTruncation({ commits: items.map(commitShape) }, truncated)
  })
}

export async function githubGetCommit(
  params: { repo: string; sha: string; withDiff?: boolean },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const commit = await getJson<Commit>(
      ctx,
      `${repoPath(owner, params.repo)}/commits/${segment(String(params.sha ?? ""), "sha")}`,
    )
    return {
      commit: {
        ...commitShape(commit),
        stats: commit.stats ?? null,
        ...(params.withDiff ? { diffs: (commit.files ?? []).map(fileShape) } : {}),
      },
    }
  })
}

export async function githubListPullRequests(
  params: { repo: string; state?: string; since?: string; base?: string },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const since = params.since ? Date.parse(params.since) : Number.NaN
    const qs = query({
      state: params.state,
      base: params.base,
      sort: "updated",
      direction: "desc",
      per_page: 100,
    })
    const { items, truncated } = await getList<PullRequest>(
      ctx,
      `${repoPath(owner, params.repo)}/pulls${qs}`,
      // Sorted by last update, newest first: the first older one ends the list.
      { stop: (pr) => !Number.isNaN(since) && Date.parse(pr.updated_at) < since },
    )
    return withTruncation({ pullRequests: items.map(prShape) }, truncated)
  })
}

export async function githubGetPullRequest(
  params: { repo: string; number: number; withFiles?: boolean },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const n = Number(params.number)
    if (!Number.isInteger(n) || n <= 0) {
      throw new GithubParamError(
        "invalid_params",
        `"${params.number}" is not a pull request number.`,
      )
    }
    const base = `${repoPath(owner, params.repo)}/pulls/${n}`
    const pr = await getJson<PullRequest>(ctx, base)
    if (!params.withFiles) return { pullRequest: prShape(pr) }
    const files = await getList<ChangedFile>(ctx, `${base}/files?per_page=100`)
    return {
      pullRequest: {
        ...prShape(pr),
        files: files.items.map(fileShape),
        ...(files.truncated ? { filesTruncated: true } : {}),
      },
    }
  })
}

export async function githubListIssues(
  params: { repo: string; state?: string; labels?: string; milestone?: string; since?: string },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const repo = repoPath(owner, params.repo)
    let milestone = params.milestone?.trim() || undefined
    if (milestone && milestone !== "*" && milestone !== "none" && !/^\d+$/.test(milestone)) {
      // GitHub filters by milestone number: resolve a title to its number.
      const all = await getList<{ number: number; title: string }>(
        ctx,
        `${repo}/milestones?state=all&per_page=100`,
      )
      const found = all.items.find((m) => m.title === milestone)
      if (!found) {
        throw new GithubParamError(
          "not_found",
          `No milestone titled "${milestone}" in ${params.repo}; github_list with kind milestones lists them.`,
        )
      }
      milestone = String(found.number)
    }
    const qs = query({
      state: params.state,
      labels: params.labels,
      milestone,
      since: params.since,
      per_page: 100,
    })
    // GitHub's issue list holds pull requests too: they are left out.
    const { items, truncated } = await getList<Issue>(ctx, `${repo}/issues${qs}`, {
      keep: (i) => i.pull_request === undefined,
    })
    return withTruncation({ issues: items.map(issueShape) }, truncated)
  })
}

export async function githubListMilestones(params: { repo: string }, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    const { items, truncated } = await getList<{
      number: number
      title: string
      description: string | null
      state: string
      due_on: string | null
      open_issues: number
      closed_issues: number
      html_url: string
    }>(ctx, `${repoPath(owner, params.repo)}/milestones?state=all&per_page=100`)
    return withTruncation(
      {
        milestones: items.map((m) => ({
          number: m.number,
          title: redactSecrets(m.title),
          description: redacted(m.description),
          state: m.state,
          dueOn: m.due_on,
          openIssues: m.open_issues,
          closedIssues: m.closed_issues,
          url: m.html_url,
        })),
      },
      truncated,
    )
  })
}

export async function githubListLabels(params: { repo: string }, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    const { items, truncated } = await getList<{
      name: string
      color: string
      description: string | null
    }>(ctx, `${repoPath(owner, params.repo)}/labels?per_page=100`)
    return withTruncation(
      {
        labels: items.map((l) => ({
          name: redactSecrets(l.name),
          color: l.color,
          description: redacted(l.description),
        })),
      },
      truncated,
    )
  })
}

export async function githubListReleases(params: { repo: string }, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    const { items, truncated } = await getList<{
      tag_name: string
      name: string | null
      body: string | null
      draft: boolean
      prerelease: boolean
      created_at: string
      published_at: string | null
      author: Person | null
      html_url: string
    }>(ctx, `${repoPath(owner, params.repo)}/releases?per_page=100`)
    return withTruncation(
      {
        releases: items.map((r) => ({
          tagName: r.tag_name,
          name: redacted(r.name),
          body: redacted(r.body),
          draft: r.draft,
          prerelease: r.prerelease,
          createdAt: r.created_at,
          publishedAt: r.published_at,
          author: r.author?.login ?? null,
          url: r.html_url,
        })),
      },
      truncated,
    )
  })
}

export async function githubListTags(params: { repo: string }, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    const { items, truncated } = await getList<{ name: string; commit: { sha: string } }>(
      ctx,
      `${repoPath(owner, params.repo)}/tags?per_page=100`,
    )
    return withTruncation(
      { tags: items.map((t) => ({ name: t.name, sha: t.commit?.sha ?? null })) },
      truncated,
    )
  })
}

interface ContentEntry {
  type: string
  name: string
  path: string
  sha: string
  size: number
  html_url: string | null
  content?: string
  encoding?: string
}

export async function githubReadFile(
  params: { repo: string; path: string; ref?: string },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const path = filePath(params.path)
    if (!path) throw new GithubParamError("invalid_path", "A file path is needed.")
    const answer = await getJson<ContentEntry | ContentEntry[]>(
      ctx,
      `${repoPath(owner, params.repo)}/contents/${path}${query({ ref: params.ref })}`,
    )
    if (Array.isArray(answer) || answer.type !== "file") {
      throw new GithubParamError(
        "not_a_file",
        `${params.path} is not a file: github_list with kind tree lists a directory.`,
      )
    }
    if (answer.encoding !== "base64" || typeof answer.content !== "string") {
      throw new GithubParamError(
        "too_large",
        `${params.path} is over 1 MB: GitHub does not hand its text out through this read.`,
      )
    }
    return {
      content: redactSecrets(utf8Text(base64Bytes(answer.content))),
      path: answer.path,
      sha: answer.sha,
      url: answer.html_url,
    }
  })
}

export async function githubListTree(
  params: { repo: string; path?: string; ref?: string },
  ctx: GithubCtx,
) {
  return guarded(ctx, async (owner) => {
    const path = filePath(params.path)
    const answer = await getJson<ContentEntry | ContentEntry[]>(
      ctx,
      `${repoPath(owner, params.repo)}/contents${path ? `/${path}` : ""}${query({ ref: params.ref })}`,
    )
    if (!Array.isArray(answer)) {
      throw new GithubParamError(
        "not_a_directory",
        `${params.path} is a file: github_read_file reads it.`,
      )
    }
    return {
      entries: answer.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
    }
  })
}

const SEARCH_KINDS: Record<string, { endpoint: string; qualifier: string }> = {
  code: { endpoint: "code", qualifier: "" },
  commits: { endpoint: "commits", qualifier: "" },
  issues: { endpoint: "issues", qualifier: " is:issue" },
  pull_requests: { endpoint: "issues", qualifier: " is:pr" },
}

/**
 * Refuses a qualifier that points the search at another owner's repositories, wherever it
 * stands: after a space, a parenthesis (GitHub ORs scope qualifiers in a group), a minus or a
 * quote. A value ends at a space or a parenthesis.
 */
function ownerOnlyQuery(owner: string, text: string): string {
  const re = /(?:^|[^\w])(repo|org|user|owner):("[^"]*"|[^\s()]+)/gi
  for (const m of text.matchAll(re)) {
    const kind = (m[1] ?? "").toLowerCase()
    const value = (m[2] ?? "").replace(/"/g, "")
    if (kind === "repo") repoPath(owner, value)
    else if (value.toLowerCase() !== owner.toLowerCase()) {
      throw new GithubParamError(
        "repo_outside_owner",
        `The search names ${kind}:${value}, not ${owner}. I search only the connected owner's repositories.`,
      )
    }
  }
  return text
}

export async function githubSearch(params: { scope: string; query: string }, ctx: GithubCtx) {
  return guarded(ctx, async (owner) => {
    // GitHub search's own kind of result (code, commits, issues, pull_requests).
    const searchKind = params.scope
    const kind = SEARCH_KINDS[searchKind]
    if (!kind) {
      throw new GithubParamError(
        "invalid_params",
        `scope must be one of ${Object.keys(SEARCH_KINDS).join(", ")}.`,
      )
    }
    const text = ownerOnlyQuery(owner, String(params.query ?? "").trim())
    const q = `${text} user:${owner}${kind.qualifier}`
    const { items, truncated } = await getList<Record<string, unknown>>(
      ctx,
      `/search/${kind.endpoint}${query({ q, per_page: 100 })}`,
      {
        accept: "application/vnd.github.text-match+json",
        itemsOf: (page) => ((page as { items?: unknown[] }).items ?? []) as unknown[],
      },
    )
    const results = items.map((r) => {
      if (searchKind === "commits") return commitShape(r as unknown as Commit)
      if (searchKind === "code") {
        const matches = (r.text_matches as Array<{ fragment?: string }> | undefined) ?? []
        return {
          repo: (r.repository as { full_name?: string } | undefined)?.full_name ?? null,
          path: r.path,
          url: r.html_url,
          fragments: matches.map((m) => redactSecrets(m.fragment ?? "")),
        }
      }
      return issueShape(r as unknown as Issue)
    })
    return withTruncation({ results }, truncated)
  })
}

/** The kinds `github_list` lists, each answered by that kind's own read. */
const LIST_KINDS = {
  issues: githubListIssues,
  pull_requests: githubListPullRequests,
  milestones: githubListMilestones,
  labels: githubListLabels,
  releases: githubListReleases,
  tags: githubListTags,
  commits: githubListCommits,
  tree: githubListTree,
} as const

export type GithubListKind = keyof typeof LIST_KINDS

/** One repository listing of `kind`, with that kind's filters; the others are not sent. */
export async function githubList(
  params: {
    kind: string
    repo: string
    state?: string
    since?: string
    labels?: string
    milestone?: string
    base?: string
    path?: string
    ref?: string
    until?: string
    author?: string
  },
  ctx: GithubCtx,
) {
  const { kind, ...rest } = params
  if (!Object.hasOwn(LIST_KINDS, kind)) {
    return toolError(
      new GithubParamError(
        "invalid_params",
        `kind must be one of ${Object.keys(LIST_KINDS).join(", ")}, not "${kind}".`,
      ),
    )
  }
  return LIST_KINDS[kind as GithubListKind](rest as never, ctx)
}

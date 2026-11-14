// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The 13 read-only agent tools. Each answers a compact, agent-friendly shape
// or `{ error: { code, message } }` (never a throw: a sandboxed throw reaches
// the agent redacted). `not_connected` when the caller has no usable `gitlab`
// connection; GitLab's own refusals keep their typed code.

import {
  connectedGroup,
  encodeId,
  type GitlabCtx,
  GitlabHttpError,
  GitlabNotConnectedError,
  getJson,
  getList,
  gitlabGet,
  nextLink,
  readFile,
  redactSecrets,
  WEB_BASE,
} from "./client"

/** `redactSecrets` over a text field that may be absent. */
function redacted<T extends string | null | undefined>(text: T): T {
  return (typeof text === "string" ? redactSecrets(text) : text) as T
}

/** A diff list with every diff's text redacted. */
function redactedDiffs<T extends { diff: string }>(diffs: T[]): T[] {
  return diffs.map((d) => ({ ...d, diff: redactSecrets(d.diff ?? "") }))
}

export type ToolError = { error: { code: string; message: string } }

export function toolError(err: unknown): ToolError {
  if (err instanceof GitlabNotConnectedError) {
    return { error: { code: "not_connected", message: err.message } }
  }
  if (err instanceof GitlabHttpError) {
    return { error: { code: err.code, message: err.gitlabMessage ?? err.message } }
  }
  return {
    error: {
      code: "TOOL_ERROR",
      message: err instanceof Error ? err.message : "GitLab tool failed",
    },
  }
}

async function guarded<T>(
  ctx: GitlabCtx,
  run: (group: string) => Promise<T>,
): Promise<T | ToolError> {
  try {
    return await run(await connectedGroup(ctx))
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
  return parts.join("&")
}

/** `truncated: true` only when the list stopped before its last page. */
function withTruncation<T extends Record<string, unknown>>(out: T, truncated: boolean): T {
  return truncated ? { ...out, truncated: true } : out
}

interface Project {
  id: number
  path_with_namespace: string
  web_url: string
  default_branch: string
}
interface Commit {
  id: string
  short_id: string
  title: string
  message: string
  author_name: string
  committed_date: string
  web_url: string
  parent_ids: string[]
  stats?: unknown
}
interface Person {
  username: string
}
interface Milestone {
  id: number
  iid: number
  title: string
  description: string | null
  state: string
  start_date: string | null
  due_date: string | null
  web_url: string
  issue_stats?: unknown
}
interface MergeRequest {
  iid: number
  title: string
  description: string | null
  state: string
  target_branch: string
  source_branch: string
  author: Person
  assignees: Person[]
  milestone: { title: string } | null
  labels: string[]
  created_at: string
  updated_at: string
  merged_at: string | null
  web_url: string
}
interface Issue {
  iid: number
  title: string
  description: string | null
  state: string
  labels: string[]
  milestone: { title: string } | null
  author: Person
  assignees: Person[]
  created_at: string
  updated_at: string
  closed_at: string | null
  web_url: string
}

const mrShape = (mr: MergeRequest) => ({
  iid: mr.iid,
  title: redactSecrets(mr.title ?? ""),
  description: redacted(mr.description),
  state: mr.state,
  targetBranch: mr.target_branch,
  sourceBranch: mr.source_branch,
  author: mr.author?.username ?? null,
  assignees: (mr.assignees ?? []).map((a) => a.username),
  milestone: mr.milestone?.title ?? null,
  labels: mr.labels ?? [],
  createdAt: mr.created_at,
  updatedAt: mr.updated_at,
  mergedAt: mr.merged_at,
  url: mr.web_url,
})

const issueShape = (i: Issue) => ({
  iid: i.iid,
  title: redactSecrets(i.title ?? ""),
  description: redacted(i.description),
  state: i.state,
  labels: i.labels ?? [],
  milestone: i.milestone?.title ?? null,
  author: i.author?.username ?? null,
  assignees: (i.assignees ?? []).map((a) => a.username),
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  closedAt: i.closed_at,
  url: i.web_url,
})

const commitShape = (c: Commit) => ({
  sha: c.id,
  shortSha: c.short_id,
  title: redactSecrets(c.title ?? ""),
  message: redactSecrets(c.message ?? ""),
  author: c.author_name,
  date: c.committed_date,
  url: c.web_url,
  parents: c.parent_ids,
})

export async function gitlabListProjects(_params: unknown, ctx: GitlabCtx) {
  return guarded(ctx, async (group) => {
    const { items, truncated } = await getList<Project>(
      ctx,
      `/groups/${encodeId(group)}/projects?per_page=50&include_subgroups=true&simple=true`,
    )
    return withTruncation(
      {
        projects: items.map((p) => ({
          id: p.id,
          path: p.path_with_namespace,
          url: p.web_url,
          defaultBranch: p.default_branch,
        })),
      },
      truncated,
    )
  })
}

export async function gitlabListCommits(
  params: { project: string; ref?: string; path?: string; since?: string; until?: string },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    const qs = query({
      per_page: 100,
      ref_name: params.ref,
      path: params.path,
      since: params.since,
      until: params.until,
    })
    const { items, truncated } = await getList<Commit>(
      ctx,
      `/projects/${encodeId(params.project)}/repository/commits?${qs}`,
    )
    return withTruncation({ commits: items.map(commitShape) }, truncated)
  })
}

export async function gitlabGetCommit(
  params: { project: string; sha: string; withDiff?: boolean },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    // The single-commit endpoint carries no diff: it lives on `/diff`.
    const base = `/projects/${encodeId(params.project)}/repository/commits/${encodeURIComponent(params.sha)}`
    const commit = await getJson<Commit>(ctx, base)
    const diffs = params.withDiff
      ? redactedDiffs(
          (
            await getList<{ old_path: string; new_path: string; diff: string }>(
              ctx,
              `${base}/diff?per_page=100`,
            )
          ).items,
        )
      : undefined
    return { commit: { ...commitShape(commit), stats: commit.stats, diffs } }
  })
}

export async function gitlabListMergeRequests(
  params: {
    project: string
    state?: string
    target_branch?: string
    milestone?: string
    labels?: string
    updated_after?: string
  },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    const qs = query({
      per_page: 100,
      state: params.state,
      target_branch: params.target_branch,
      milestone: params.milestone,
      labels: params.labels,
      updated_after: params.updated_after,
    })
    const { items, truncated } = await getList<MergeRequest>(
      ctx,
      `/projects/${encodeId(params.project)}/merge_requests?${qs}`,
    )
    return withTruncation({ mergeRequests: items.map(mrShape) }, truncated)
  })
}

export async function gitlabGetMergeRequest(
  params: { project: string; iid: number; withChanges?: boolean },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    // The MR read carries no diff; its per-file diffs are the paginated `/diffs`.
    const base = `/projects/${encodeId(params.project)}/merge_requests/${encodeURIComponent(String(params.iid))}`
    const mr = await getJson<MergeRequest>(ctx, base)
    const changes = params.withChanges
      ? redactedDiffs(
          (
            await getList<{ old_path: string; new_path: string; diff: string }>(
              ctx,
              `${base}/diffs?per_page=100`,
            )
          ).items,
        )
      : undefined
    return { mergeRequest: { ...mrShape(mr), changes } }
  })
}

export async function gitlabListIssues(
  params: {
    project: string
    state?: string
    milestone?: string
    labels?: string
    search?: string
    updated_after?: string
  },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    const qs = query({
      per_page: 100,
      state: params.state,
      milestone: params.milestone,
      labels: params.labels,
      search: params.search,
      updated_after: params.updated_after,
    })
    const { items, truncated } = await getList<Issue>(
      ctx,
      `/projects/${encodeId(params.project)}/issues?${qs}`,
    )
    return withTruncation(
      {
        issues: items.map(issueShape),
      },
      truncated,
    )
  })
}

export async function gitlabListMilestones(
  params: { project: string; state?: string },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    const { items, truncated } = await getList<Milestone>(
      ctx,
      `/projects/${encodeId(params.project)}/milestones?${query({ per_page: 100, state: params.state })}`,
    )
    return withTruncation(
      {
        milestones: items.map((m) => ({
          iid: m.iid,
          title: redactSecrets(m.title ?? ""),
          description: redacted(m.description),
          state: m.state,
          startDate: m.start_date,
          dueDate: m.due_date,
          url: m.web_url,
          issueStats: m.issue_stats,
        })),
      },
      truncated,
    )
  })
}

export async function gitlabListLabels(params: { project: string }, ctx: GitlabCtx) {
  return guarded(ctx, async () => {
    const { items, truncated } = await getList<{
      name: string
      color: string
      description: string | null
      open_issues_count?: number
      closed_issues_count?: number
      open_merge_requests_count?: number
    }>(ctx, `/projects/${encodeId(params.project)}/labels?per_page=100&with_counts=true`)
    return withTruncation(
      {
        labels: items.map((l) => ({
          name: l.name,
          color: l.color,
          description: redacted(l.description),
          openIssues: l.open_issues_count,
          closedIssues: l.closed_issues_count,
          openMRs: l.open_merge_requests_count,
        })),
      },
      truncated,
    )
  })
}

export async function gitlabListReleases(params: { project: string }, ctx: GitlabCtx) {
  return guarded(ctx, async () => {
    const { items, truncated } = await getList<{
      tag_name: string
      name: string
      description: string | null
      created_at: string
      released_at: string
      author: Person | null
      milestones: Array<{ title: string; iid: number; issue_stats: unknown }> | null
      assets?: { count: number }
    }>(ctx, `/projects/${encodeId(params.project)}/releases?per_page=100`)
    return withTruncation(
      {
        releases: items.map((r) => ({
          tagName: r.tag_name,
          name: redacted(r.name),
          description: redacted(r.description),
          createdAt: r.created_at,
          releasedAt: r.released_at,
          author: r.author?.username ?? null,
          milestones: (r.milestones ?? []).map((m) => ({
            title: m.title,
            iid: m.iid,
            issueStats: m.issue_stats,
          })),
          assetCount: r.assets?.count,
        })),
      },
      truncated,
    )
  })
}

export async function gitlabListTags(params: { project: string }, ctx: GitlabCtx) {
  return guarded(ctx, async () => {
    const { items, truncated } = await getList<{
      name: string
      message: string | null
      commit: { id: string; title: string; committed_date: string }
      release: { tag_name: string; description: string } | null
    }>(ctx, `/projects/${encodeId(params.project)}/repository/tags?per_page=100`)
    return withTruncation(
      {
        tags: items.map((t) => ({
          name: t.name,
          message: redacted(t.message),
          commit: { sha: t.commit.id, title: t.commit.title, date: t.commit.committed_date },
          release: t.release
            ? { tagName: t.release.tag_name, description: redacted(t.release.description) }
            : null,
        })),
      },
      truncated,
    )
  })
}

export async function gitlabReadFile(
  params: { project: string; path: string; ref?: string; startLine?: number; endLine?: number },
  ctx: GitlabCtx,
) {
  return guarded(
    ctx,
    async (): Promise<{ content: string; url: string; ref: string } | ToolError> => {
      const file = await readFile(ctx, params.project, params.path, params.ref ?? "HEAD")
      let text = redactSecrets(file.text)
      if (params.startLine !== undefined || params.endLine !== undefined) {
        const lines = text.split("\n")
        const start = params.startLine ?? 1
        const end = params.endLine ?? lines.length
        if (start > end) {
          return {
            error: {
              code: "INVALID_PARAMS",
              message: `startLine (${start}) must be ≤ endLine (${end})`,
            },
          }
        }
        if (start > lines.length) {
          return {
            error: {
              code: "INVALID_PARAMS",
              message: `startLine (${start}) exceeds file length (${lines.length} lines)`,
            },
          }
        }
        text = lines.slice(start - 1, end).join("\n")
      }
      // A numeric project id is no namespace: resolve one for a clickable link.
      let namespace = params.project
      try {
        namespace = (await getJson<Project>(ctx, `/projects/${encodeId(params.project)}`))
          .path_with_namespace
      } catch {
        // Keep the given project as a best-effort link.
      }
      return {
        content: text,
        url: `${WEB_BASE}/${namespace}/-/blob/${file.lastCommitId}/${params.path}`,
        ref: file.lastCommitId,
      }
    },
  )
}

export async function gitlabListTree(
  params: { project: string; path?: string; ref?: string; recursive?: boolean },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async () => {
    const qs = query({
      ref: params.ref ?? "HEAD",
      recursive: params.recursive ?? false,
      per_page: 100,
      pagination: "keyset",
      path: params.path,
    })
    const answer = await gitlabGet(
      ctx,
      `/projects/${encodeId(params.project)}/repository/tree?${qs}`,
    )
    const items = JSON.parse(answer.body) as Array<{
      id: string
      name: string
      type: string
      path: string
    }>
    const next = nextLink(answer)
    return {
      entries: items.map((e) => ({ name: e.name, path: e.path, type: e.type, id: e.id })),
      ...(next ? { nextCursor: next } : {}),
    }
  })
}

function searchHitShape(scope: string, r: Record<string, unknown>): Record<string, unknown> {
  if (scope === "commits") return commitShape(r as unknown as Commit)
  if (scope === "merge_requests") return mrShape(r as unknown as MergeRequest)
  if (scope === "issues") return issueShape(r as unknown as Issue)
  return {
    path: r.path,
    filename: r.filename,
    ref: r.ref,
    snippet: typeof r.data === "string" ? redactSecrets(r.data) : r.data,
    startLine: r.startline,
    projectId: r.project_id,
  }
}

export async function gitlabSearch(
  params: { project?: string; scope: string; query: string; ref?: string },
  ctx: GitlabCtx,
) {
  return guarded(ctx, async (group) => {
    const base = params.project
      ? `/projects/${encodeId(params.project)}/search`
      : `/groups/${encodeId(group)}/search`
    const qs = query({
      scope: params.scope,
      search: params.query,
      per_page: 100,
      ref: params.project ? params.ref : undefined,
    })
    const { items, truncated } = await getList<Record<string, unknown>>(ctx, `${base}?${qs}`)
    return withTruncation(
      {
        results: items.map((r) => searchHitShape(params.scope, r)),
      },
      truncated,
    )
  })
}

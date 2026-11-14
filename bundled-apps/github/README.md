# GitHub — read-only GitHub connector

GitHub gives agents **read-only** access to one GitHub organization or user:
repositories, commits, pull requests, issues, milestones, labels, releases,
tags, repository files and tree, and search. No write operation exists. When
GitHub is not connected the tools answer a `not_connected` error rather than
fabricating data.

## Tools

All tools are scoped `github:repo:read` and read-only. They mirror the GitLab
connector's tools name for name, plus `github_list`.

| Tool | What it does |
|------|--------------|
| `github_list_repos` | List the owner's repositories (call this first). |
| `github_list` | The one listing agents see: issues, pull requests, milestones, labels, releases, tags, commits or tree, by `kind`, answered by that kind's own read. |
| `github_list_commits` / `github_get_commit` | List/get commits (optionally with diff); agents list them through `github_list`. |
| `github_list_pull_requests` / `github_get_pull_request` | List/get pull requests (optionally with changed files). |
| `github_list_issues` | List issues, pull requests left out (state, labels, milestone, last update). |
| `github_list_milestones` / `github_list_labels` | List milestones / labels. |
| `github_list_releases` / `github_list_tags` | List releases / git tags. |
| `github_read_file` / `github_list_tree` | Read a file / list a repository path. |
| `github_search` | Search code, commits, issues or pull requests of the owner. |

The kinds' own reads (`github_list_issues`, `github_list_pull_requests`,
`github_list_milestones`, `github_list_labels`, `github_list_releases`,
`github_list_tags`, `github_list_tree`) are off the agent's catalog
(`agentVisible: false`, `useInstead: github_list`) and stay dashboard sources.

Every text a tool returns (file content, diffs, commit messages, titles,
bodies, search fragments) is secret-redacted (`src/client.ts`,
`redactSecrets`).

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) first for the
shared machinery. **Connection:** one `credentials` connection named `github`;
the operator pastes a token. The app never reads it: every call goes through
`ctx.fetch` with the connection named, and the host adds the token as an
`Authorization: Bearer` header, only to `api.github.com`. Only the `owner`
field is readable by the app.

| Field | Required | Where it comes from |
|---|---|---|
| `token` | ✓ | A GitHub **fine-grained personal access token** with **read-only** Contents, Metadata, Pull requests and Issues. Stored encrypted. |
| `owner` | ✓ | The organization or user name the connector reads (as in its GitHub URL). |

## Guarantees

- **GET only.** `githubRequest` throws on any other method before a call is
  made, and refuses any URL outside `https://api.github.com/`. The API version
  is pinned (`X-GitHub-Api-Version`).
- **The connected owner only.** A `repo` is `<owner>/<name>` or `<name>`; a
  repository of anyone else is refused (`repo_outside_owner`) before any call,
  and so is a search qualifier (`repo:`, `org:`, `user:`) naming another owner.
- **No path tricks.** Every path segment built from a parameter is
  percent-encoded and `.`/`..` segments are refused (`invalid_path`).
- **A token that can write is refused.** A classic token shows its scopes on
  every answer; one with `repo`, `public_repo`, `workflow`, `delete_repo`,
  `write:*` or `admin:*` is refused (`write_token_refused`) with the fix named.
  GitHub does not show a fine-grained token's permissions, so `verify` passes
  with a warning to keep it read-only.
- **Bounded reads.** Lists follow `Link` pages up to 500 rows and say
  `truncated: true`; an answer over 10 MB is refused.

### Failure modes

| Code | Cause | Fix |
|---|---|---|
| `not_connected` | no usable `github` connection for the caller | Connect in Settings → GitHub (org-owned for a shared token). |
| `auth_revoked` (401) | token expired or revoked | Paste a new read-only token in the same form. |
| `rate_limited` | GitHub's rate limit; `retryAt` says when | Wait until `retryAt`. |
| `forbidden` (403) | the token has no access to that read | Give the token read access to the repository. |
| `not_found` (404) | wrong name, or the token cannot see it | `github_list_repos` first. |
| `write_token_refused` | a classic token with a write scope | Create a fine-grained read-only token. |
| `github_error` | any other GitHub answer, with its status | Retry later. |

## Checking the connection

`liaison config verify` (and the check `config apply` runs after it applied the
connection) runs `provisioning.verify` (`src/provisioning.ts`): one read of the
token's user and of the owner.

## Contract fixtures

The app's wake-up contract fixtures (`apps/api/src/modules/apps/contract/fixtures/github/`)
are hand-written and marked `unrecorded` until a recording against GitHub with a
read-only token is made; the tools' working paths are covered over a fake
`ctx.fetch` in `src/github.test.ts`.

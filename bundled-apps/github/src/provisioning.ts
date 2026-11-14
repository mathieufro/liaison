// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Declarative setup (`config apply` / `config verify`). GitHub needs nothing
// beyond its connection, so the handler changes nothing; `verify` is the live
// check `config verify` and the post-apply health check run, through the
// connection's own credential (never read here).
//
// It is also the connect probe for write access: a classic token shows its
// scopes on every answer, and one that can write is refused with the fix
// named (client.ts refuses it on every read too). A fine-grained token's
// permissions are not shown by GitHub, so verify passes with a warning on its
// identity line that says to keep it read-only.

import { connectedOwner, type GithubCtx, githubRequest, header, segment } from "./client"
import { toolError } from "./tools"

/** Said when GitHub does not show the token's permissions (a fine-grained token). */
export const FINE_GRAINED_WARNING =
  "GitHub does not show this token's permissions: keep Contents, Metadata, Pull requests and Issues at Read-only, nothing at Read and write"

export async function provisionGithub(
  _input: { config?: Record<string, unknown>; dryRun?: boolean },
  _ctx: GithubCtx,
): Promise<{ changed: string[] }> {
  return { changed: [] }
}

export async function verifyGithub(
  _input: { config?: Record<string, unknown> },
  ctx: GithubCtx,
): Promise<{ ok: boolean; problems: string[]; identity?: string }> {
  try {
    const owner = await connectedOwner(ctx)
    const answer = await githubRequest(ctx, "/user")
    const user = JSON.parse(answer.body) as { login: string }
    await githubRequest(ctx, `/users/${segment(owner, "owner")}`)
    // The verify result carries no warning field: the warning rides on the identity line.
    const unshown = header(answer.headers, "x-oauth-scopes") === undefined
    return {
      ok: true,
      problems: [],
      identity: `${user.login} @ ${owner}${unshown ? ` (${FINE_GRAINED_WARNING})` : ""}`,
    }
  } catch (err) {
    const { error } = toolError(err)
    return { ok: false, problems: [`${error.code}: ${error.message}`] }
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

interface Ctx {
  executeTool: (toolName: string, paramsJson: string) => Promise<string>
  invalidateIdempotency: (toolName: string, idempotencyKey: string) => Promise<void>
  hasScope?: (scope: string) => Promise<boolean>
  db_insert?: (entity: string, dataJson: string) => Promise<string>
}

interface ParsedEnv {
  data?: unknown
  blocked?: unknown
  error?: { code: string; message: string; retryable: boolean }
}

function parse(json: string): ParsedEnv {
  return JSON.parse(json) as ParsedEnv
}

async function callB(params: any, ctx: Ctx): Promise<unknown> {
  const env = parse(
    await ctx.executeTool(
      "test-bridge-b:internalCallback",
      JSON.stringify({
        payload: params?.payload,
        idempotencyKey: params?.idempotencyKey,
        cycle: params?.cycle,
      }),
    ),
  )
  if (env.error) return { error: env.error }
  if (env.blocked) return { blocked: env.blocked }
  return { data: env.data }
}

async function recurse(params: any, ctx: Ctx): Promise<unknown> {
  const depth = Number(params?.depth ?? 0)
  if (depth >= 5) return { data: { depth } }
  const env = parse(
    await ctx.executeTool("test-bridge-a:recurse", JSON.stringify({ depth: depth + 1 })),
  )
  if (env.error) return { error: env.error }
  return env.data
}

async function idempotent(params: any, _ctx: Ctx): Promise<unknown> {
  const delay = Number(params?.delayMs ?? 0)
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return { data: { payload: params?.payload, computedAt: Date.now() + Math.random() } }
}

async function callIdempotent(params: any, ctx: Ctx): Promise<unknown> {
  const env = parse(
    await ctx.executeTool(
      "test-bridge-a:idempotent",
      JSON.stringify({
        idempotencyKey: params?.idempotencyKey,
        payload: params?.payload,
        delayMs: params?.delayMs,
      }),
    ),
  )
  if (env.error) return { error: env.error }
  if (env.blocked) return { blocked: env.blocked }
  return { data: env.data }
}

async function cleanup(params: any, ctx: Ctx): Promise<unknown> {
  await ctx.invalidateIdempotency("test-bridge-a:idempotent", params?.idempotencyKey)
  await ctx.invalidateIdempotency("test-bridge-a:callIdempotent", params?.idempotencyKey)
  return { data: { idempotencyKey: params?.idempotencyKey, cleaned: true } }
}

async function tainted(_params: any, _ctx: Ctx): Promise<unknown> {
  return { data: { tainted: true } }
}

async function callTaintedThenTrustBoundary(_params: any, ctx: Ctx): Promise<unknown> {
  const taintEnv = parse(await ctx.executeTool("test-bridge-a:tainted", "{}"))
  if (taintEnv.error) return { error: taintEnv.error }
  const followEnv = parse(
    await ctx.executeTool("test-bridge-a:callB", JSON.stringify({ payload: "post-taint" })),
  )
  if (followEnv.blocked) return { data: { taintObserved: true, blocked: followEnv.blocked } }
  if (followEnv.error) return { data: { taintObserved: true, innerError: followEnv.error } }
  return { data: { taintObserved: false, inner: followEnv.data } }
}

async function outcomesHandler(payload: any, ctx: Ctx): Promise<void> {
  const hasWebhookScope =
    ctx.hasScope != null ? await ctx.hasScope("test-bridge-a:webhook:write") : false
  if (ctx.db_insert) {
    await ctx.db_insert(
      "audit",
      JSON.stringify({
        key: "outcome-accepted",
        payload: { observedScopeWebhookWrite: hasWebhookScope === true, body: payload ?? null },
        at: new Date().toISOString(),
      }),
    )
  }
}

async function outcomesVerify(request: any): Promise<unknown> {
  const headers = request.headers ?? {}
  const outcome = headers["x-test-outcome"] ?? headers["X-Test-Outcome"]
  if (outcome === "drop") {
    return { drop: true, status: 200 }
  }
  if (outcome === "rate_limited") {
    return { valid: false, status: 429, retryAfterSeconds: 30 }
  }
  if (outcome === "reject") {
    return { valid: false, status: 401 }
  }
  return {
    valid: true,
    replayKey: `${Date.now()}-${Math.random()}`,
    // The audit table the handler writes is governed by the `thing` scope.
    scopes: ["test-bridge-a:thing:write", "test-bridge-a:webhook:write"],
  }
}

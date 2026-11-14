// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `request_secret`: the agent asks a person for a secret without ever seeing it.
//
// The call files a `kernel.secret_requests` row and returns its id; the web
// renders a form card from that id under the tool call (the scope request
// card's pattern). The person types the secret into the card, which posts it
// to the route that stores it; the server then derives completion from the
// store and the conversation gets a line with the result and a non-secret
// hint (modules/secret-requests).
//
// Not gated, on purpose: a parked approval would add a second card for
// nothing. The call writes a request, not a secret, and the card itself is the
// person's decision. Its row is read only by the conversation's participants
// (RLS), so a turn that read scoped data is judged by them alone
// (`sinkReadersConversation`), not by every member of the org. It is a
// trust-boundary tool: in a hardened turn that read outside text it parks
// rather than runs (A7). When such a parked call is approved, its card is
// drawn under the approval's result line (approvals/result-notice.ts), as it
// is under a call that ran in the turn.

import { isGmailAddress } from "@liaison/shared"
import type { RlsClient } from "~/db"
import {
  captureActingAgentId,
  currentRunContext,
  currentToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { connectionConfigRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { apiConnFor } from "~/modules/apps/connections/api/declarations"
import { getAdapterRow, listAdapterRows } from "~/modules/apps/connections/api/store"
import { connectionTurnedOff } from "~/modules/apps/connections/oauth-client-config"
import { isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { resolveGoogleClients } from "~/modules/connection-guides/google"
import { hasScope } from "~/modules/permissions/permissions"
import { needsClientCard } from "~/modules/secret-requests/pending-cards"
import { fileSecretRequest } from "~/modules/secret-requests/service"
import {
  checkTargetRegistered,
  parseSecretTarget,
  requestSecretParams,
  type SecretTarget,
  targetFields,
} from "~/modules/secret-requests/targets"

export const SINK_KERNEL_SECRET_REQUESTS = "kernel.secret_requests"

/** The kernel-tool ctx fields this handler reads (`createAppContext`). */
interface SecretToolCtx {
  userId: string
  orgId: string
  db: RlsClient
  agentExecutionThreadId?: string
  /** The acting scopes: a refusal names only the targets they may see. */
  scopes?: string[]
  /** The turn's taint, forwarded by the dispatch (the proposing turn's on an approved re-entry). */
  turnTaintScopes?: readonly string[]
}

/**
 * The scopes the turn that files the card had read: what the dispatch
 * forwarded, else the live frame (a frame without an accumulator is an
 * unknowable taint, held by nobody), else no turn at all. The row is stamped
 * with them (migration 0220), so a person who joins the conversation later
 * without them never reads the text the agent chose for the card.
 */
function filingTurnScopes(ctx: SecretToolCtx): string[] {
  if (ctx.turnTaintScopes !== undefined) return [...ctx.turnTaintScopes]
  const frame = currentRunContext()
  if (!frame) return []
  if (!frame.turnScopeAccumulator) return [...UNKNOWN_TURN_TAINT]
  return [...(currentToolCallScopesBefore() ?? frame.turnScopeAccumulator.snapshot())]
}

/**
 * A refusal the agent can act on: a 4xx it may retry with the target fixed
 * (never a 500 tool_error, which reads as a fault of ours).
 */
interface RequestSecretRefusal {
  error: { code: string; message: string; status: 400; retryable: boolean }
}

/** Whether this call posted the card, or found the same pending card already in the conversation. */
export type RequestSecretCard = "posted" | "already_posted"

export type RequestSecretResult =
  | {
      requestId: string
      kind: SecretTarget["kind"]
      target: Record<string, unknown>
      card: RequestSecretCard
      note: string
    }
  | RequestSecretRefusal

/**
 * What the agent may say about the card, in the result itself: the card is a
 * request, not a result. A weak model said "fully configured and connected"
 * right after a card was posted, with nothing connected (2026-10-27).
 */
export function requestSecretNote(kind: SecretTarget["kind"], card: RequestSecretCard): string {
  const done = kind === "oauth_connect" ? "connected" : "saved or configured"
  const head =
    card === "already_posted"
      ? "This card was already posted in this conversation and is still waiting: no second card was posted. Point the person at the card that is there; do not call request_secret again for it."
      : "A card is now in this conversation for the person to complete."
  return `${head} Nothing is ${done} until the person completes it: you will get a line in this conversation when they do. Until then never say it is ${done}, set up or working.`
}

function refused(message: string, retryable = true, code = "invalid_target"): RequestSecretRefusal {
  return { error: { code, message, status: 400, retryable } }
}

/**
 * A Connect card is posted only when its connect can start: a connection the
 * workspace switched off (Gmail mailboxes off) would hand the person a card
 * that fails on click. The refusal says what turns it on.
 */
async function connectTurnedOff(orgId: string, target: SecretTarget): Promise<string | null> {
  if (target.kind !== "oauth_connect") return null
  const off = await connectionTurnedOff(orgId, target.app, target.connection)
  return off ? `${off.message}. ${off.turnOn}` : null
}

async function adapterProblem(
  orgId: string,
  target: SecretTarget,
  scopes: string[],
): Promise<string | null> {
  if (target.kind !== "connection_credentials" || !target.identifier) return null
  const api = apiConnFor(orgId, target.app)
  if (!api || api.connection !== target.connection) return null
  const row = await getAdapterRow(api, target.identifier)
  if (row) return null
  // The saved adapters are named only to an actor who may read them.
  const saved = hasScope(api.decl.readScope, scopes)
    ? (await listAdapterRows(api)).map((r) => r.identifier)
    : []
  return (
    `No API connection adapter "${target.identifier}" in ${target.app}: ` +
    (saved.length > 0
      ? `the saved ones are ${saved.join(", ")}; or save this adapter first, then ask for its credentials.`
      : "save the adapter first, then ask for its credentials.")
  )
}

/**
 * A Connect card whose connection has no OAuth client yet, for a connection
 * whose guide creates that client first: the card would fail on click, and a
 * weak model skips the guide's first step (Shopify: the app file, deploy and
 * install). The refusal names that step, in the guide's order.
 */
const SETUP_BEFORE_CONNECT: Readonly<Record<string, string>> = {
  "shopify:shop":
    "The Shopify store cannot be connected yet: this workspace has no Shopify app client (neither its own nor the server's). Follow the guide's order: read the shopify-setup skill and call kernel__shopify_app_toml first (it posts the app file; the person creates and deploys the app with the Shopify CLI and installs it on the store). Only once they say the app is installed, ask for its client ID and secret with kernel__request_secret kind oauth_client (app shopify, connection shop), and post this Connect card after that card is saved. Do not ask for the shop domain before that.",
}

/** The Gmail connections a personal @gmail.com address cannot take on an unverified server client. */
const GMAIL_CONNECTIONS = new Set(["mail:gmail", "tickets:gmail"])

/**
 * A Gmail Connect card for a personal @gmail.com address while the mailbox would
 * use this server's Google client and Google has not verified it: Google never
 * grants Gmail to it, so the card can only fail. The prompt says so; a weak model
 * posted the card anyway. The refusal names the path that works.
 */
async function personalGmailNeedsImap(orgId: string, target: SecretTarget): Promise<string | null> {
  if (target.kind !== "oauth_connect" || !isGmailAddress(target.identifier)) return null
  if (!GMAIL_CONNECTIONS.has(`${target.app}:${target.connection}`)) return null
  const { workspace } = await resolveGoogleClients(orgId)
  if (workspace.source !== "instance" || workspace.restrictedVerified) return null
  return `${target.identifier} is a personal Gmail address and this server's Google client is not verified by Google, so it cannot connect Gmail with Google. Call kernel__google_setup with the address (path consumer_imap): say its statement, then connect the mailbox over IMAP with an app password (kernel__request_secret kind connection_credentials, app mail, connection imap, mode personal).`
}

async function connectNeedsSetupFirst(orgId: string, target: SecretTarget): Promise<string | null> {
  if (target.kind !== "oauth_connect") return null
  const step = SETUP_BEFORE_CONNECT[`${target.app}:${target.connection}`]
  if (!step) return null
  return (await needsClientCard(orgId, target.app, target.connection)) ? step : null
}

/**
 * Every refusal of a request the person never needs to see: bad params, a
 * target the workspace does not declare (named with the ones it does), a
 * missing adapter, a switched-off connection, a Connect card before its
 * guide's first step. Null: the card can be filed.
 */
async function requestSecretProblem(
  params: unknown,
  ctx: { orgId: string; userId: string; scopes: readonly string[] },
): Promise<{ target: SecretTarget } | RequestSecretRefusal> {
  const parsed = requestSecretParams.safeParse(params)
  if (!parsed.success) {
    return refused(`Invalid request_secret parameters: ${parsed.error.message}`)
  }
  const target = parseSecretTarget(parsed.data, ctx.orgId)
  if (!target.ok) return refused(target.error)
  const scopes = [...ctx.scopes]
  // A refusal names only connections of apps this actor may use: On for the
  // org, not restricted away from the person, and one they hold a scope of.
  await primeOrgApps(ctx.orgId)
  const canSeeApp = (app: string) =>
    !isAppUnavailableFor(ctx.orgId, app, ctx.userId) &&
    scopes.some((s) => s === "*" || s === `${app}:*` || s.startsWith(`${app}:`))
  const problem =
    checkTargetRegistered(ctx.orgId, target.target, canSeeApp) ??
    (await adapterProblem(ctx.orgId, target.target, scopes))
  if (problem) return refused(problem)
  const off = await connectTurnedOff(ctx.orgId, target.target)
  if (off) return refused(off, true, "connection_turned_off")
  const setupFirst = await connectNeedsSetupFirst(ctx.orgId, target.target)
  if (setupFirst) return refused(setupFirst, false, "setup_step_first")
  const imapInstead = await personalGmailNeedsImap(ctx.orgId, target.target)
  if (imapInstead) return refused(imapInstead, false, "personal_gmail_imap")
  return { target: target.target }
}

/**
 * BEFORE ANY GATE: a request that would be refused is refused at once. A turn
 * that read outside text parks a trust-boundary call for approval (A7), and a
 * parked request for a connection that does not exist (`shopify` for `shop`)
 * asked a person to approve a card that could never work.
 */
export async function refuseRequestSecretBeforeGate(
  params: unknown,
  ctx: { orgId: string; userId: string; scopes: readonly string[] },
): Promise<RequestSecretRefusal | null> {
  const problem = await requestSecretProblem(params, ctx)
  return "error" in problem ? problem : null
}

export async function handleRequestSecret(
  params: unknown,
  ctx: SecretToolCtx,
): Promise<RequestSecretResult> {
  const threadId = ctx.agentExecutionThreadId
  if (!threadId) {
    return refused(
      "A secret is asked for in a conversation, where the person types it into a card. There is no conversation here: tell the person where to enter it in Settings instead.",
      false,
    )
  }
  const checked = await requestSecretProblem(params, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.scopes ?? [],
  })
  if ("error" in checked) return checked

  const { row, reused } = await fileSecretRequest(ctx.db, {
    orgId: ctx.orgId,
    threadId,
    requestedBy: ctx.userId,
    agentId: captureActingAgentId(),
    target: checked.target,
    requiredScopes: filingTurnScopes(ctx),
  })
  const card: RequestSecretCard = reused ? "already_posted" : "posted"
  return {
    requestId: row.id,
    kind: checked.target.kind,
    target: targetFields(checked.target),
    card,
    note: requestSecretNote(checked.target.kind, card) + asksFor(ctx.orgId, checked.target),
  }
}

/**
 * The fields a credentials card asks for, by their labels ("Restricted key"), so what the agent
 * tells the person matches the card and never names a kind of key the app refuses.
 */
function asksFor(orgId: string, target: SecretTarget): string {
  if (target.kind !== "connection_credentials") return ""
  const fields =
    connectionConfigRegistry.get([orgId, target.app, target.connection])?.credentialFields ?? []
  const labels = fields.filter((f) => f.type === "password").map((f) => f.label)
  return labels.length > 0 ? ` The card asks for: ${labels.join(", ")}.` : ""
}

export function registerSecretRequestTool(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "request_secret"], {
    appName: "kernel",
    name: "request_secret",
    deferLoading: true,
    // How people ask for it ("connect my Gmail", "sign in to my mailbox", "add
    // our Shopify"): a member asking for their own account searched "connect
    // gmail", met only admin-locked config tools and concluded they needed an
    // administrator. These words find the card from the request itself.
    searchKeywords: [
      "connect",
      "connection",
      "gmail",
      "google",
      "calendar",
      "shopify",
      "mail",
      "mailbox",
      "account",
      "personal",
      "own",
      "oauth",
      "sign",
      "signin",
      "login",
      "credentials",
      "password",
      "key",
      "token",
    ],
    description:
      '"Connect my Gmail": kind oauth_connect, app mail, connection gmail, mode personal; any member, no admin needed. A card in this conversation asks the person for a secret (a model provider key, an app\'s login or OAuth client, the Google client, API connector credentials, a new Liaison API key) or connects an OAuth account (Gmail, Google Calendar, Shopify: kind oauth_connect, they sign in at the provider; mode personal for their own account, mode org for one the organization shares). You never see the secret or the tokens: you get a line saying it was saved or connected, with a short hint.',
    // The baseline every member and agent holds: who may SUBMIT the card is
    // decided by the target route's own scope, checked when the card saves.
    requiredScopes: ["kernel:threads:read"],
    trustBoundary: "user",
    // The card lives in a conversation: an MCP client has none to show it in.
    requiresAgentExecutionThread: true,
    writesToTable: SINK_KERNEL_SECRET_REQUESTS,
    // The row is read back only by the requester and the conversation's
    // participants (the secret_requests RLS policy): on a turn that read
    // scoped data, the request runs when they all hold what the turn read,
    // and parks for approval otherwise (scope-taint.ts, rule 6e).
    sinkReadersConversation: true,
    params: requestSecretParams,
    // A request that would be refused never parks for approval first.
    refuseBeforeGate: refuseRequestSecretBeforeGate,
    handler: handleRequestSecret,
  })
}

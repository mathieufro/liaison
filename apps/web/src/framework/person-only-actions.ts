// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel actions that only a person may take, from Liaison's own pages.
//
// App UIs (bundled and third-party) call the kernel through the host services
// (`host.fetch`, `host.invokeTool`), with the signed-in person's token. To the
// server such a call looks exactly like the person's own click, so an app
// could otherwise record, in the person's name, an act the person never took.
// The actions listed here are refused by the host services before any request
// leaves: the kernel's own pages (which call the API with their own client,
// not the host services) are the only browser path to them. An agent reaches
// the same act only through its gated tool, which a person approves on a card.
//
// This is the one place the list lives. Add an action here when the kernel
// treats it as a person's attestation (it records who checked something).
// The server keeps its own checks (an interactive session, no agent or MCP
// token); this list is the browser half of that rule.

export interface PersonOnlyRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Matched against the normalized kernel path (no query, no trailing slash, decoded). */
  path: RegExp
  /** What the action is, for the refusal message. */
  action: string
}

export interface PersonOnlyTool {
  app: string
  tool: string
  action: string
}

/** Kernel REST routes an app UI may never call. */
export const PERSON_ONLY_ROUTES: readonly PersonOnlyRoute[] = [
  {
    method: "POST",
    path: /^\/api\/contacts\/[^/]+\/addresses\/[^/]+\/verify$/i,
    action: "verify a contact's address",
  },
]

/** Tools an app UI may never run directly (a direct run counts as the person's click). */
export const PERSON_ONLY_TOOLS: readonly PersonOnlyTool[] = [
  { app: "kernel", tool: "contacts_address_verify", action: "verify a contact's address" },
]

/** The error an app UI gets for a person-only action. */
export class PersonOnlyActionError extends Error {
  readonly code = "person_only_action"
  constructor(action: string) {
    super(
      `@liaison/host: an app cannot ${action}. Only a person can, from Liaison's own page, or by approving the agent's request.`,
    )
    this.name = "PersonOnlyActionError"
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The path the server routes: dot segments resolved, query and fragment
 * dropped, percent escapes decoded, repeated and trailing slashes folded. The
 * fold errs on the side of matching: a path that differs only in spelling is
 * the same action.
 */
export function normalizeKernelPath(path: string): string {
  let pathname: string
  try {
    pathname = new URL(path, "http://kernel.invalid").pathname
  } catch {
    pathname = path.split(/[?#]/)[0] ?? path
  }
  const decoded = safeDecode(pathname).replace(/\/{2,}/g, "/")
  // Trailing slashes trimmed by index, not by an end-anchored pattern a long run of
  // slashes would make slow.
  let end = decoded.length
  while (end > 0 && decoded[end - 1] === "/") end--
  return decoded.length > 1 ? decoded.slice(0, end) : decoded
}

function matchesTool(qualified: string, entry: PersonOnlyTool): boolean {
  const segments = qualified
    .split(/:|__|\./)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const last = segments[segments.length - 1]
  return last === entry.tool.toLowerCase() && segments.includes(entry.app.toLowerCase())
}

/** The person-only tool a qualified name (`app:tool`, `app__tool`, ...) names, if any. */
export function personOnlyTool(qualified: string): PersonOnlyTool | null {
  return PERSON_ONLY_TOOLS.find((entry) => matchesTool(qualified, entry)) ?? null
}

/** The tool a kernel tool-running route names, when the path is one. */
function toolOfRoute(path: string, body: unknown): string | null {
  const segments = path.split("/").filter(Boolean)
  const key = segments.map((s) => s.toLowerCase())
  if (key[0] !== "api" || key[1] !== "apps") return null
  // /api/apps/tools/<app:tool>
  if (key.length === 4 && key[2] === "tools") return segments[3] ?? null
  // /api/apps/<app>/tools/<tool>
  if (key.length === 5 && key[3] === "tools") return `${segments[2]}:${segments[4]}`
  // /api/apps/run-tool { toolName }
  if (key.length === 3 && key[2] === "run-tool") {
    const name = body && typeof body === "object" && "toolName" in body ? body.toolName : undefined
    return typeof name === "string" ? name : null
  }
  return null
}

/**
 * Throws when an app UI's request is a person-only action: a listed route, or
 * a route that runs a listed tool. `body` is the parsed JSON body, if any.
 */
export function assertNotPersonOnly(method: string, path: string, body?: unknown): void {
  const verb = method.toUpperCase()
  const normalized = normalizeKernelPath(path)
  const route = PERSON_ONLY_ROUTES.find((r) => r.method === verb && r.path.test(normalized))
  if (route) throw new PersonOnlyActionError(route.action)
  if (verb !== "GET") {
    const tool = toolOfRoute(normalized, body)
    const entry = tool ? personOnlyTool(tool) : null
    if (entry) throw new PersonOnlyActionError(entry.action)
  }
}

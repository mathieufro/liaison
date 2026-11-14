// SPDX-License-Identifier: FSL-1.1-ALv2
import { ApiError } from "~/lib/api-error"
import { listAgentDirectory } from "~/modules/threads/agent-directory"

export interface MentionResult {
  /**
   * "user", "thread", "agent" or "approval_request" for the three buckets the
   * kernel owns; for an app entity the server sends the REGISTRATION's entity
   * type here ("task", "ticket", ...), repeated in `entityType`. The union is
   * open for exactly that reason: the picker keyed its glyph off this field
   * and drew the channel hash for every value it did not recognize.
   */
  type: "user" | "thread" | "entity" | "agent" | "approval_request" | (string & {})
  id: string
  label: string
  secondaryLabel?: string
  /** A colleague away today: until when (the last day of their run of away days). */
  away?: { until: string | null } | null
  app?: string
  entityType?: string
  threadId?: string
}

export type MentionTrigger = "@" | "#"

/**
 * What an agent mention puts INTO the message: the bare handle. The row's
 * title is the agent's display name now, so the label is no longer the wire
 * text; the handle rides on the row's second line, exactly as an approval
 * handle does.
 */
export function agentMentionHandle(item: MentionResult): string {
  const raw = (item.secondaryLabel ?? item.label).trim()
  return raw.startsWith("@") ? raw.slice(1) : raw
}

export class MentionSearchUnavailableError extends Error {
  constructor() {
    super("Mention search unavailable")
    this.name = "MentionSearchUnavailableError"
  }
}

/** A handle is stored with its leading "@"; the mention token supplies its
 *  own, so the label carries the bare name. */
function mentionLabel(handle: string, name: string): string {
  const bare = handle.startsWith("@") ? handle.slice(1) : handle
  return bare.length > 0 ? bare : name
}

/** Agents the org can address, narrowed to the ones this query prefix-matches
 *  on either their handle or their display name. Every agent is matched by its
 *  own handle: no name is special-cased, so a renamed personal agent is found
 *  under the name it now has. */
function agentMentions(query: string): MentionResult[] {
  const q = query.trim().toLowerCase()
  return listAgentDirectory()
    .filter((agent) => {
      const bare = mentionLabel(agent.handle, agent.name).toLowerCase()
      return bare.startsWith(q) || agent.name.toLowerCase().startsWith(q)
    })
    .map((agent) => ({
      type: "agent" as const,
      id: agent.id,
      // THE TITLE IS THE NAME. A row titled "@support" made the writer read
      // the machine handle and guess who it was; the handle reads underneath,
      // where it also tells two agents with the same display name apart.
      label: agent.name.trim().length > 0 ? agent.name : mentionLabel(agent.handle, agent.name),
      secondaryLabel: agent.handle.startsWith("@") ? agent.handle : `@${agent.handle}`,
    }))
}

export async function searchMentions(
  api: { get: (path: string) => Promise<any> },
  query: string,
  trigger: MentionTrigger = "@",
  limit = 8,
  type?: string,
): Promise<MentionResult[]> {
  // `@` ADDRESSES and `#` REFERENCES. `@` asks the server for the addressable
  // set, which is the org's members and nothing else (agents are added below
  // from the local directory), and `#` asks for the reference set: channels,
  // contacts, approval requests and app records. `@` used to complete
  // contacts too: tagging a customer notifies nobody, and on a bare `@` the
  // contact rows came back ahead of the colleagues the writer wanted. An
  // explicit `type` from a caller still wins.
  const resolvedType = type ?? (trigger === "@" ? "addressable" : "reference")
  let res: any
  try {
    const qs = new URLSearchParams({ q: query, limit: String(limit) })
    if (resolvedType) qs.set("type", resolvedType)
    res = await api.get(`/mentions?${qs.toString()}`)
  } catch (err) {
    if (err instanceof ApiError && (err.code === "SEARCH_UNAVAILABLE" || err.status === 503)) {
      throw new MentionSearchUnavailableError()
    }
    throw err
  }
  const data = res?.data ?? res
  const results: MentionResult[] = Array.isArray(data) ? data : []

  if (trigger === "@" && type === undefined) {
    // Members first, then agents: a colleague is who a writer tags most, and
    // the agents used to sit on top of them. Anything the server sends that is
    // not a member is dropped here as well, so a server that still answers
    // with contacts (an older build, a stale index) cannot put them back.
    const members = results.filter((row) => row.type === "user")
    return dedupeById([...members, ...agentMentions(query)])
  }
  if (trigger === "@") {
    return dedupeById([...results, ...agentMentions(query)])
  }

  return dedupeById(results)
}

/**
 * One row per entity. The popup's candidates arrive from two places that both
 * know the same channel: the indexed hits and the direct-DB top-up behind
 * `GET /mentions`, plus the local agent directory prepended above. Nothing
 * downstream reconciles them, so a channel known to several of them was listed
 * once per source. First occurrence wins, which keeps the deliberate ordering
 * (members before agents, indexed hits before the fallback).
 */
function dedupeById(rows: MentionResult[]): MentionResult[] {
  const seen = new Set<string>()
  const out: MentionResult[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

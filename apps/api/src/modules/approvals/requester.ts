// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO ASKED for an approval, as every surface names it.
//
// An approval row carries two identities: `requested_by`, the human the call is
// accountable to (it drives self-approval and requester checks, never display),
// and `agent_id`, the agent whose turn proposed it. Whenever an agent or a
// routine proposed the call, the card names IT, never the person: agent posts
// are attributed, not impersonated. A role or system agent is named as itself
// (a ticket draft the @support routine wrote is "by Support"); a routine run by
// a personal agent is "Routine {name}"; a personal agent's own turn is
// "{Person}'s agent". A call an MCP client made with no agent row behind it (an
// AI assistant on a connection bound to no agent; `metadata.origin` is "mcp") is
// "{Person}'s agent" too: the person did not write it.
// Only a person's own direct action names the person. A routine the reader
// cannot see is still a routine: its agent, else "Routine", never the person.
//
// This is the only place that rule lives. The card, the attention feed, push,
// and the agent's own pending-approval context all read `ApprovalRequester`
// from here and render its `name`; none of them joins users or agents itself.
import type { ApprovalRequester } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const K = drizzleSql.raw(schemaRef("kernel"))
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

interface Executor {
  execute: (query: ReturnType<typeof drizzleSql>) => Promise<unknown>
}

/** The pure rule, over the identities a row names. */
export function pickApprovalRequester(
  user: { id: string; name: string | null } | null,
  agent: { id: string; kind: string; displayName: string } | null,
  requestedBy: string,
  routine: { id: string; name: string | null } | null = null,
  origin: string | null = null,
  toolName: string | null = null,
): ApprovalRequester {
  if (agent && agent.kind !== "personal") {
    return { kind: "agent", id: agent.id, name: agent.displayName }
  }
  if (routine) {
    return {
      kind: "agent",
      id: agent?.id ?? routine.id,
      name: routine.name ? `Routine ${routine.name}` : "Routine",
    }
  }
  if (agent) {
    return { kind: "agent", id: agent.id, name: `${user?.name ?? "User"}'s agent` }
  }
  if (origin === "mcp") {
    return { kind: "agent", id: requestedBy, name: `${user?.name ?? "User"}'s agent` }
  }
  // An app's scheduled job raised it: the member it is filed under did not ask for it.
  if (origin === "system") {
    const app = toolName?.split(":")[0] ?? ""
    const label = app ? `${app.charAt(0).toUpperCase()}${app.slice(1).replace(/[-_]/g, " ")}` : null
    return {
      kind: "agent",
      id: requestedBy,
      name: label ? `Scheduled job (${label})` : "Scheduled job",
    }
  }
  return { kind: "user", id: user?.id ?? requestedBy, name: user?.name ?? "Unknown" }
}

/**
 * Resolves the requester of each approval row in one read. Keyed by approval
 * id. Works through RLS or privileged clients alike: an agent, routine or user
 * the caller cannot see is not named (a hidden routine falls back to its agent,
 * or to "Routine" when it ran without one; a hidden user to "Unknown").
 */
export async function readApprovalRequesters(
  db: Executor,
  orgId: string,
  approvalIds: string[],
): Promise<Map<string, ApprovalRequester>> {
  const ids = [...new Set(approvalIds.filter((id) => typeof id === "string" && id !== ""))]
  if (ids.length === 0) return new Map()
  const idList = drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  const rows = extractRows<{
    id: string
    requested_by: string
    user_id: string | null
    user_name: string | null
    agent_id: string | null
    agent_kind: string | null
    agent_name: string | null
    routine_id: string | null
    routine_name: string | null
    origin_routine_id: string | null
    origin: string | null
    tool_name: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT ar.id, ar.requested_by,
             u.id AS user_id, u.name AS user_name,
             a.id AS agent_id, a.kind AS agent_kind, a.display_name AS agent_name,
             r.id AS routine_id, COALESCE(NULLIF(btrim(r.title), ''), r.name) AS routine_name,
             CASE WHEN ar.metadata->>'originRoutineId' ~* ${UUID_PATTERN}
               THEN ar.metadata->>'originRoutineId' END AS origin_routine_id,
             ar.metadata->>'origin' AS origin, ar.tool_name
      FROM ${K}.approval_requests ar
      LEFT JOIN ${K}.users u ON u.id = ar.requested_by
      LEFT JOIN ${K}.agents a ON a.id = ar.agent_id AND a.org_id = ar.org_id
      LEFT JOIN ${K}.routines r ON r.org_id = ar.org_id
        AND r.id = CASE WHEN ar.metadata->>'originRoutineId' ~* ${UUID_PATTERN}
          THEN (ar.metadata->>'originRoutineId')::uuid END
      WHERE ar.org_id = ${orgId}::uuid AND ar.id IN (${idList})
    `),
  )
  return new Map(
    rows.map((r) => [
      r.id,
      pickApprovalRequester(
        r.user_id ? { id: r.user_id, name: r.user_name } : null,
        r.agent_id && r.agent_kind
          ? { id: r.agent_id, kind: r.agent_kind, displayName: r.agent_name ?? "" }
          : null,
        r.requested_by,
        r.routine_id && r.routine_name
          ? { id: r.routine_id, name: r.routine_name }
          : // Hidden from this reader: its agent is named if it had one, else "Routine".
            r.origin_routine_id && !(r.agent_id && r.agent_kind)
            ? { id: r.origin_routine_id, name: null }
            : null,
        r.origin,
        r.tool_name,
      ),
    ]),
  )
}

/** The single-row form of `readApprovalRequesters`. */
export async function readApprovalRequester(
  db: Executor,
  orgId: string,
  approvalId: string,
  requestedBy: string,
): Promise<ApprovalRequester> {
  return (
    (await readApprovalRequesters(db, orgId, [approvalId])).get(approvalId) ??
    pickApprovalRequester(null, null, requestedBy)
  )
}

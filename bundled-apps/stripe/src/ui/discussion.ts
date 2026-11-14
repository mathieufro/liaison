// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Posting to a customer's discussion. Refund and Cancel only ask here: the message names what is
// wanted, an agent prepares the approval, and a person decides it. Nothing in this file calls a tool.
import { fetch as hostFetch } from "@liaison/host"

const unwrap = <T>(r: T | { data: T }): T =>
  r && typeof r === "object" && "data" in (r as object) ? (r as { data: T }).data : (r as T)

/** Opens the customer's discussion, then writes the message into it. Returns the thread id. */
export async function postToDiscussion(rowId: string, text: string): Promise<string> {
  const opened = unwrap(
    await hostFetch<{ threadId: string } | { data: { threadId: string } }>(
      "/api/threads/entity-discussion",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: "stripe", entityType: "customer", entityId: rowId }),
      },
    ),
  )
  await hostFetch(`/api/threads/${encodeURIComponent(opened.threadId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text, correlationId: crypto.randomUUID() }),
  })
  return opened.threadId
}

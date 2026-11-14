// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { updatePayload } from "~/modules/approvals/edit"
import { getApproval, listApprovals } from "~/modules/approvals/list"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import {
  approvalEditableFieldsRegistry,
  approvalSummarizerRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = "00000000-0000-4000-8000-000000064001"
const REQUESTER = "00000000-0000-4000-8000-000000064002"
const APPROVER = "00000000-0000-4000-8000-000000064003"
const THREAD = "00000000-0000-4000-8000-000000064004"
const REQUEST = "00000000-0000-4000-8000-000000064005"
const REVOKED_REQUEST = "00000000-0000-4000-8000-000000064006"
const DEFERRED_REQUEST = "00000000-0000-4000-8000-000000064007"
const NESTED_REQUEST = "00000000-0000-4000-8000-000000064008"
// A would-be editor who PASSES field-level authorization (in the notify-set + holds the approve scope)
// but is NOT a participant of the approval's surface thread — so the system "Edited …" message post is
// rejected and updatePayload must surface the precise non-participant cause (not a bare "forbidden").
const NONPARTICIPANT_APPROVER = "00000000-0000-4000-8000-000000064009"
const NONPARTICIPANT_REQUEST = "00000000-0000-4000-8000-00000006400a"
// Shared-surface (ticket) draft raised by REQUESTER — its notify-set is JUST the
// requester, but per 0018's widened visibility any teammate with `tickets:approve`
// (a colleague working the same ticket) must be able to edit it, even though they
// are neither the requester, in the notify-set, nor a participant of the
// requester's private agent thread. TICKETS_TEAMMATE holds the capability;
// TICKETS_READER can only read the ticket (no approve) and must still be refused.
const TICKETS_TEAMMATE = "00000000-0000-4000-8000-00000006400b"
const TICKETS_READER = "00000000-0000-4000-8000-00000006400c"
const TICKETS_REQUEST = "00000000-0000-4000-8000-00000006400d"
// A partially-approved N-eyes request (minApprovers: 2, one sign-off recorded):
// editing the payload must RESET the recorded sign-off, or the edited content
// would execute carrying an approval given to the pre-edit version.
const NEYES_REQUEST = "00000000-0000-4000-8000-00000006400f"
// A draft carrying BOTH textBody and a derived pre-rendered htmlBody, whose
// textBody editable field declares `invalidates: ["htmlBody"]` — the
// approved-draft-sent-stale-html regression (edited text approved, customer
// received the untouched pre-edit HTML).
const DERIVED_REQUEST = "00000000-0000-4000-8000-00000006400e"
// A `projects:create` gated task-creation approval — mirrors the real app.manifest.json
// editableFields fix (title + description) so the module-level test exercises the actual
// declaration shape shipped for that tool, not just a synthetic fixture tool.
const PROJECTS_CREATE_REQUEST = "00000000-0000-4000-8000-000000064010"
// A gated tool that declares NO editableFields at all (the pre-fix shape for `projects:create`
// before this change) — used to assert the invalid_edit message says "(none)" rather than
// silently omitting the allowlist.
const NO_EDITABLE_REQUEST = "00000000-0000-4000-8000-000000064011"
// A team channel neither REQUESTER nor TICKETS_TEAMMATE ever joined: an agent staged a draft
// into it for its person. The requester-decider (holds edit_approval:approve, in the notify-set)
// may edit it; a requester who cannot decide it is still refused.
const CHANNEL = "00000000-0000-4000-8000-000000064030"
const CHANNEL_DECIDER_REQUEST = "00000000-0000-4000-8000-000000064031"
const CHANNEL_NONDECIDER_REQUEST = "00000000-0000-4000-8000-000000064032"

const requesterActor: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: ["edit_approval:approve", "kernel:approvals:read"],
  dimensionGrants: {},
}

describe("updatePayload", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Approval Edit Org', 'approval-edit-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES
      (${REQUESTER}, ${ORG}, 'approval-edit-requester@test.local', 'Approval Requester', 'active'),
      (${APPROVER}, ${ORG}, 'approval-edit-approver@test.local', 'Approval Approver', 'active'),
      (${NONPARTICIPANT_APPROVER}, ${ORG}, 'approval-edit-nonparticipant@test.local', 'Non-Participant Approver', 'active'),
      (${TICKETS_TEAMMATE}, ${ORG}, 'approval-edit-tickets-teammate@test.local', 'Tickets Teammate', 'active'),
      (${TICKETS_READER}, ${ORG}, 'approval-edit-tickets-reader@test.local', 'Tickets Reader', 'active')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES
      (${REQUESTER}, ${ORG}, 'edit_approval:approve'),
      (${NONPARTICIPANT_APPROVER}, ${ORG}, 'edit_approval:approve'),
      (${TICKETS_TEAMMATE}, ${ORG}, 'tickets:approve'),
      (${TICKETS_TEAMMATE}, ${ORG}, 'tickets:tickets:read'),
      (${TICKETS_READER}, ${ORG}, 'tickets:tickets:read')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'approval-edit-thread', 'approval', ${REQUESTER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
      (${THREAD}, ${REQUESTER}, ${ORG}, 'admin'),
      (${THREAD}, ${APPROVER}, ${ORG}, 'member')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${REQUEST}, ${ORG}, 'request-edit', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Edit Approval","lines":[]}'::jsonb),
      (${REVOKED_REQUEST}, ${ORG}, 'request-revoked', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Revoked Approval","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    // A deferred bundle step — editable until the cascade claims it.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary,
      bundle_id, bundle_position, depends_on_id
    ) VALUES
      (${DEFERRED_REQUEST}, ${ORG}, 'request-deferred', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'deferred', 'gated',
       '{"kind":"edit","title":"Deferred Step","lines":[]}'::jsonb, ${REQUEST}, 1, ${REQUEST})
      ON CONFLICT DO NOTHING`
    // A request whose tool edits a value nested inside the payload via a dot-path.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${NESTED_REQUEST}, ${ORG}, 'request-nested', ${THREAD}, ${THREAD}, 'edit_approval:nested',
       '{"customerEmail":{"subject":"Hi","body":"old body"}}'::jsonb,
       '{"customerEmail":{"subject":"Hi","body":"old body"}}'::jsonb,
       now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Nested Edit","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`

    // A pending request whose notify-set includes NONPARTICIPANT_APPROVER (who holds the approve scope)
    // but who is NOT a thread_participant of THREAD — the message-post step must reject and surface the
    // non-participant cause.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${NONPARTICIPANT_REQUEST}, ${ORG}, 'request-nonparticipant', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${NONPARTICIPANT_APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Non-participant Approver","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`

    // A shared-surface `tickets:reply` draft: notify-set is the requester ONLY, and
    // neither TICKETS_TEAMMATE nor TICKETS_READER is a participant of THREAD.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${TICKETS_REQUEST}, ${ORG}, 'request-tickets-reply', ${THREAD}, ${THREAD}, 'tickets:reply', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Ticket Reply Draft","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${CHANNEL}, ${ORG}, 'approval-edit-channel', 'approval', ${TICKETS_READER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
      (${CHANNEL}, ${TICKETS_READER}, ${ORG}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${CHANNEL_DECIDER_REQUEST}, ${ORG}, 'request-channel-decider', ${CHANNEL}, ${CHANNEL}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Channel draft","lines":[]}'::jsonb),
      (${CHANNEL_NONDECIDER_REQUEST}, ${ORG}, 'request-channel-nondecider', ${CHANNEL}, ${CHANNEL}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${TICKETS_TEAMMATE}]::uuid[], ${TICKETS_TEAMMATE}, 'pending', 'gated',
       '{"kind":"edit","title":"Channel draft, no decider","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`

    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "tool"],
      [{ field: "message", label: "Message", widget: "text" }],
    )
    toolRegistry.set([ORG, "edit_approval", "tool"], {
      appName: "edit_approval",
      name: "tool",
      description: "Edit approval test tool",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    } as Parameters<typeof toolRegistry.set>[1])
    approvalEditableFieldsRegistry.set(
      [ORG, "tickets", "reply"],
      [{ field: "message", label: "Message", widget: "text" }],
    )
    toolRegistry.set([ORG, "tickets", "reply"], {
      appName: "tickets",
      name: "reply",
      description: "Ticket reply test tool",
      requiredScopes: ["tickets:tickets:reply"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    } as Parameters<typeof toolRegistry.set>[1])
    // N-eyes fixture: one of two required sign-offs already recorded.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary, metadata
    ) VALUES
      (${NEYES_REQUEST}, ${ORG}, 'request-neyes', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"N-eyes Edit","lines":[]}'::jsonb,
       ${JSON.stringify({ minApprovers: 2, approvedBy: [APPROVER] })}::jsonb)
      ON CONFLICT DO NOTHING`

    // Derived-field fixture: textBody edits must blank the stale htmlBody.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${DERIVED_REQUEST}, ${ORG}, 'request-derived', ${THREAD}, ${THREAD}, 'edit_approval:derived',
       '{"subject":"Hello","textBody":"old text","htmlBody":"<p>old text</p>"}'::jsonb,
       '{"subject":"Hello","textBody":"old text","htmlBody":"<p>old text</p>"}'::jsonb,
       now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Derived Edit","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "derived"],
      [
        { field: "textBody", label: "Body", widget: "richtext", invalidates: ["htmlBody"] },
        { field: "subject", label: "Subject", widget: "text" },
      ],
    )
    toolRegistry.set([ORG, "edit_approval", "derived"], {
      appName: "edit_approval",
      name: "derived",
      description: "Derived-field edit approval test tool",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: {
          subject: { type: "string" },
          textBody: { type: "string" },
          htmlBody: { type: "string" },
        },
        required: ["textBody"],
      },
    } as Parameters<typeof toolRegistry.set>[1])
    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "nested"],
      [{ field: "customerEmail.body", label: "Body", widget: "richtext" }],
    )
    toolRegistry.set([ORG, "edit_approval", "nested"], {
      appName: "edit_approval",
      name: "nested",
      description: "Nested edit approval test tool",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: {
          customerEmail: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" } },
            required: ["subject", "body"],
          },
        },
        required: ["customerEmail"],
      },
    } as Parameters<typeof toolRegistry.set>[1])

    // Projects `create` fixture — same editableFields shape as the real
    // apps/projects/app.manifest.json fix (title + description, both plain-string `text`/`richtext`).
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${PROJECTS_CREATE_REQUEST}, ${ORG}, 'request-projects-create', ${THREAD}, ${THREAD}, 'projects:create',
       '{"title":"Old title","description":"Old description"}'::jsonb,
       '{"title":"Old title","description":"Old description"}'::jsonb,
       now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Create Task","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    approvalEditableFieldsRegistry.set(
      [ORG, "projects", "create"],
      [
        { field: "title", label: "Title", widget: "text" },
        { field: "description", label: "Description", widget: "richtext" },
      ],
    )
    toolRegistry.set([ORG, "projects", "create"], {
      appName: "projects",
      name: "create",
      description: "Create task test tool",
      requiredScopes: ["projects:tasks:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title"],
      },
    } as Parameters<typeof toolRegistry.set>[1])

    // A gated tool with an empty editableFields registration (never called `.set` at all) —
    // the invalid_edit message must still resolve cleanly to "(none)".
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${NO_EDITABLE_REQUEST}, ${ORG}, 'request-no-editable', ${THREAD}, ${THREAD}, 'edit_approval:noedit',
       '{"title":"Old title"}'::jsonb,
       '{"title":"Old title"}'::jsonb,
       now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"No Editable Fields","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    toolRegistry.set([ORG, "edit_approval", "noedit"], {
      appName: "edit_approval",
      name: "noedit",
      description: "No-editable-fields test tool",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    } as Parameters<typeof toolRegistry.set>[1])
  })

  afterAll(async () => {
    approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "tool"])
    toolRegistry.delete([ORG, "edit_approval", "tool"])
    approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "nested"])
    toolRegistry.delete([ORG, "edit_approval", "nested"])
    approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "derived"])
    toolRegistry.delete([ORG, "edit_approval", "derived"])
    approvalEditableFieldsRegistry.delete([ORG, "tickets", "reply"])
    toolRegistry.delete([ORG, "tickets", "reply"])
    approvalEditableFieldsRegistry.delete([ORG, "projects", "create"])
    toolRegistry.delete([ORG, "projects", "create"])
    toolRegistry.delete([ORG, "edit_approval", "noedit"])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  // The agent tool `approval_update_payload` asks only kernel:approvals:read and passes its turn's
  // scopes as `callerScopes`: the requester (the person the turn acts for) edits its own pending
  // request without any approver scope; editing another's still needs kernel:approvals:write.
  describe("through the agent tool (callerScopes)", () => {
    const OWN_REQUEST = "00000000-0000-4000-8000-000000064020"
    const PLAIN_REQUEST = "00000000-0000-4000-8000-000000064021"
    const PLAIN_MEMBER = "00000000-0000-4000-8000-000000064022"
    /** A named role agent's turn: the common agent base, no approver scope. */
    const ROLE_AGENT_TURN = ["kernel:approvals:read", "kernel:threads:read"]
    const actorFor = (userId: string, scopes: string[]): UserContext => ({
      actorType: "user",
      userId,
      orgId: ORG,
      scopes,
      dimensionGrants: {},
    })

    beforeAll(async () => {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES
        (${PLAIN_MEMBER}, ${ORG}, 'approval-edit-plain@test.local', 'Plain Member', 'active')
        ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
        (${THREAD}, ${PLAIN_MEMBER}, ${ORG}, 'member') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.approval_requests (
        id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
        current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
      ) VALUES
        (${OWN_REQUEST}, ${ORG}, 'request-own-agent', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
         '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${NONPARTICIPANT_APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
         '{"kind":"edit","title":"Own Agent Edit","lines":[]}'::jsonb),
        (${PLAIN_REQUEST}, ${ORG}, 'request-plain-member', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"old"}'::jsonb,
         '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${PLAIN_MEMBER}, ${NONPARTICIPANT_APPROVER}]::uuid[], ${PLAIN_MEMBER}, 'pending', 'gated',
         '{"kind":"edit","title":"Plain Member Edit","lines":[]}'::jsonb)
        ON CONFLICT DO NOTHING`
    })

    it("a role agent edits the request it staged for its person, with no approver scope", async () => {
      const seenHash = approvalPayloadHash("edit_approval:tool", { message: "old" })
      const result = await updatePayload({
        orgId: ORG,
        requestId: OWN_REQUEST,
        fields: { message: "fixed by the agent" },
        actor: actorFor(REQUESTER, ["edit_approval:approve", "kernel:approvals:read"]),
        callerScopes: ROLE_AGENT_TURN,
      })
      expect(result.currentPayload).toEqual({ message: "fixed by the agent" })
      // What an approver already saw no longer matches: an approve bound to it is refused (409).
      expect(result.payloadHash).not.toBe(seenHash)
    })

    it("a role agent cannot edit another person's request, even for an approver", async () => {
      await expect(
        updatePayload({
          orgId: ORG,
          requestId: OWN_REQUEST,
          fields: { message: "not mine" },
          actor: actorFor(NONPARTICIPANT_APPROVER, [
            "edit_approval:approve",
            "kernel:approvals:read",
          ]),
          callerScopes: [...ROLE_AGENT_TURN, "edit_approval:approve"],
        }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" })
    })

    it("a plain member edits its own request and is refused on another's", async () => {
      const own = await updatePayload({
        orgId: ORG,
        requestId: PLAIN_REQUEST,
        fields: { message: "member fix" },
        actor: actorFor(PLAIN_MEMBER, ["kernel:approvals:read"]),
        callerScopes: ["kernel:approvals:read"],
      })
      expect(own.currentPayload).toEqual({ message: "member fix" })
      // Not theirs and not in its audience: they cannot even see it (404), and nothing changes.
      await expect(
        updatePayload({
          orgId: ORG,
          requestId: OWN_REQUEST,
          fields: { message: "not mine" },
          actor: actorFor(PLAIN_MEMBER, ["kernel:approvals:read"]),
          callerScopes: ["kernel:approvals:read"],
        }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" })
      const [row] =
        await sql`SELECT current_payload FROM kernel.approval_requests WHERE id = ${OWN_REQUEST}`
      expect(row.current_payload.message).not.toBe("not mine")
    })

    it("an approver's turn holding kernel:approvals:write still edits as before", async () => {
      const result = await updatePayload({
        orgId: ORG,
        requestId: OWN_REQUEST,
        fields: { message: "approver fix" },
        actor: actorFor(NONPARTICIPANT_APPROVER, [
          "edit_approval:approve",
          "kernel:approvals:read",
        ]),
        callerScopes: ["kernel:approvals:read", "kernel:approvals:write", "edit_approval:approve"],
      })
      expect(result.currentPayload).toEqual({ message: "approver fix" })
    })
  })

  it("returns 403, not 404, for a snapshot approver whose current approve scope was revoked", async () => {
    await expect(
      updatePayload({
        orgId: ORG,
        requestId: REVOKED_REQUEST,
        fields: { message: "new" },
        actor: {
          actorType: "user",
          userId: APPROVER,
          orgId: ORG,
          scopes: ["edit_approval:approve"],
          dimensionGrants: {},
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
  })

  it("a notify-set approver who is NOT a thread participant CAN repair the payload", async () => {
    // Field-level auth passes (in notify-set + holds edit_approval:approve) but the editor is not a
    // participant of the requester's private agent thread, so the system 'Edited …' message post is
    // rejected. That used to surface as a 403 and left the approval unrepairable by anyone but its
    // requester — an approver could see a bad payload, could not fix it, and could not approve it
    // (five projects:create approvals parked on an invalid priority, 2026-09-09). The audit note is
    // now authored as the REQUESTER, who is always a participant of their own thread.
    const result = await updatePayload({
      orgId: ORG,
      requestId: NONPARTICIPANT_REQUEST,
      fields: { message: "corrected" },
      actor: {
        actorType: "user",
        userId: NONPARTICIPANT_APPROVER,
        orgId: ORG,
        scopes: ["edit_approval:approve", "kernel:approvals:read"],
        dimensionGrants: {},
      },
    })
    expect(result).toBeTruthy()

    // The edit is attributed to the REAL editor even though the message row is authored by the
    // requester — otherwise the fallback would quietly launder who changed the payload.
    const [msg] = await sql`
      SELECT author_id, metadata FROM kernel.messages
      WHERE metadata->>'type' = 'payload-edit'
      ORDER BY created_at DESC LIMIT 1
    `
    expect(msg.metadata.editorUserId).toBe(NONPARTICIPANT_APPROVER)
    expect(msg.author_id).not.toBe(NONPARTICIPANT_APPROVER)
  })

  it("a decider edits a draft waiting in a channel neither they nor the requester joined", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: CHANNEL_DECIDER_REQUEST,
      fields: { message: "decider fix" },
      actor: requesterActor,
    })
    expect(result.currentPayload).toEqual({ message: "decider fix" })
    expect(result.lastEdit?.editorUserId).toBe(REQUESTER)
    const [row] = await sql`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${CHANNEL_DECIDER_REQUEST}`
    expect(row.current_payload).toEqual({ message: "decider fix" })
    // The edit event still names the editor and the diff.
    const [event] = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload->>'entity' = 'approval_request'
        AND payload->>'action' = 'update' AND payload->>'entityId' = ${CHANNEL_DECIDER_REQUEST}
      ORDER BY created_at DESC LIMIT 1`
    expect(event.payload.data.lastEdit.editorUserId).toBe(REQUESTER)
  })

  it("a requester who cannot decide a draft in a channel they never joined is still refused, with the cause", async () => {
    await expect(
      updatePayload({
        orgId: ORG,
        requestId: CHANNEL_NONDECIDER_REQUEST,
        fields: { message: "not mine to change" },
        actor: {
          actorType: "user",
          userId: TICKETS_TEAMMATE,
          orgId: ORG,
          scopes: ["tickets:approve", "tickets:tickets:read", "kernel:approvals:read"],
          dimensionGrants: {},
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "cannot record the edit: you are not a participant of this approval's thread",
    })
    const [row] = await sql`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${CHANNEL_NONDECIDER_REQUEST}`
    expect(row.current_payload).toEqual({ message: "old" })
  })

  it("uses the persisted payload-edit message timestamp for response, event, list, and detail parity", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: REQUEST,
      fields: { message: "new" },
      actor: requesterActor,
    })

    const [event] = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload->>'entity' = 'approval_request' AND payload->>'action' = 'update'
      ORDER BY created_at DESC LIMIT 1
    `
    const detail = await withRlsContext(requesterActor, (tx) =>
      getApproval(tx, { orgId: ORG, userId: REQUESTER, requestId: REQUEST }),
    )
    const list = await withRlsContext(requesterActor, (tx) =>
      listApprovals(tx, { orgId: ORG, userId: REQUESTER, scopes: requesterActor.scopes }),
    )

    expect(result.lastEdit).toBeTruthy()
    expect(event.payload.data.lastEdit).toEqual(result.lastEdit)
    expect(detail?.lastEdit).toEqual(result.lastEdit)
    expect(list.find((row) => row.id === REQUEST)?.lastEdit).toEqual(result.lastEdit)
  })

  it("allows editing a deferred bundle step's payload", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: DEFERRED_REQUEST,
      fields: { message: "edited-while-deferred" },
      actor: requesterActor,
    })
    expect(result.lastEdit).toBeTruthy()
    expect(result.currentPayload.message).toBe("edited-while-deferred")
  })

  it("lets a teammate holding <app>:approve edit a shared-surface ticket draft they neither requested nor were notified on", async () => {
    // TICKETS_TEAMMATE is NOT the requester, NOT in the notify-set ({REQUESTER}),
    // and NOT a participant of the draft's private thread — but holds tickets:approve
    // and can read the ticket. The widened authorization admits the edit, and the
    // audit note is authored by the requester (a participant) so the post succeeds
    // while the displayed editor still resolves to the real teammate.
    const result = await updatePayload({
      orgId: ORG,
      requestId: TICKETS_REQUEST,
      fields: { message: "corrected by teammate" },
      actor: {
        actorType: "user",
        userId: TICKETS_TEAMMATE,
        orgId: ORG,
        scopes: ["tickets:approve", "tickets:tickets:read"],
        dimensionGrants: {},
      },
    })
    expect(result.lastEdit?.editorUserId).toBe(TICKETS_TEAMMATE)
    expect(result.currentPayload.message).toBe("corrected by teammate")
    const [row] = await sql`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${TICKETS_REQUEST}
    `
    expect(row.current_payload.message).toBe("corrected by teammate")
  })

  it("still refuses a shared-surface edit by a ticket reader lacking <app>:approve", async () => {
    // Widening the audience to the ticket team does NOT drop the capability gate:
    // a user who can read the ticket but lacks tickets:approve is still forbidden.
    await expect(
      updatePayload({
        orgId: ORG,
        requestId: TICKETS_REQUEST,
        fields: { message: "should be rejected" },
        actor: {
          actorType: "user",
          userId: TICKETS_READER,
          orgId: ORG,
          scopes: ["tickets:tickets:read"],
          dimensionGrants: {},
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
  })

  it("accepts a description edit on a pending projects:create approval end to end", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: PROJECTS_CREATE_REQUEST,
      fields: { description: "New description" },
      actor: requesterActor,
    })
    expect(result.currentPayload.description).toBe("New description")
    expect(result.currentPayload.title).toBe("Old title")
    expect(result.lastEdit?.diff).toEqual([
      { field: "description", from: "Old description", to: "New description" },
    ])
  })

  it("invalid_edit on an unknown field names the tool's real editable fields so the agent can self-correct", async () => {
    await expect(
      updatePayload({
        orgId: ORG,
        requestId: PROJECTS_CREATE_REQUEST,
        fields: { projectId: "some-other-project" },
        actor: requesterActor,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_edit",
      message: expect.stringContaining("editable fields: title, description"),
    })
  })

  it("invalid_edit on a tool with NO editableFields says '(none)' rather than omitting the allowlist", async () => {
    await expect(
      updatePayload({
        orgId: ORG,
        requestId: NO_EDITABLE_REQUEST,
        fields: { title: "attempted edit" },
        actor: requesterActor,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_edit",
      message: expect.stringContaining("editable fields: (none)"),
    })
  })

  it("an edit refused on a tool that declares editWith names those tools", async () => {
    const id = "00000000-0000-4000-8000-0000000640e1"
    await sql.unsafe(
      insertSql("kernel.approval_requests", {
        id,
        org_id: ORG,
        handle: "request-edit-with",
        thread_id: THREAD,
        originating_thread_id: THREAD,
        tool_name: "edit_approval:run_issue",
        tool_params: { raw: `'{"run_id":"r1","items":[]}'::jsonb` },
        current_payload: { raw: `'{"run_id":"r1","items":[]}'::jsonb` },
        expires_at: { raw: "now() + interval '1 hour'" },
        notify_user_ids: { raw: `ARRAY['${APPROVER}']::uuid[]` },
        requested_by: REQUESTER,
        status: "pending",
        reason: "gated",
        summary: { raw: `'{"kind":"run_issue","title":"Run","lines":[]}'::jsonb` },
      }),
    )
    toolRegistry.set([ORG, "edit_approval", "run_issue"], {
      appName: "edit_approval",
      name: "run_issue",
      description: "Issue a run",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      editWith: ["drafts_update", "drafts_create", "drafts_discard"],
      params: {
        type: "object",
        properties: { run_id: { type: "string" }, items: { type: "array" } },
      },
    } as Parameters<typeof toolRegistry.set>[1])
    try {
      let err: { status?: number; code?: string; message?: string } | undefined
      try {
        await updatePayload({
          orgId: ORG,
          requestId: id,
          fields: { items: [{ total: 1 }] },
          actor: requesterActor,
        })
      } catch (e) {
        err = e as typeof err
      }
      expect(err).toMatchObject({ status: 400, code: "invalid_edit" })
      for (const tool of ["drafts_update", "drafts_create", "drafts_discard"]) {
        expect(err?.message).toContain(`edit_approval__${tool}`)
      }
      const [row] = await sql`SELECT current_payload FROM kernel.approval_requests WHERE id = ${id}`
      expect(row?.current_payload).toEqual({ run_id: "r1", items: [] })
    } finally {
      toolRegistry.delete([ORG, "edit_approval", "run_issue"])
    }
  })

  it("blanks the derived htmlBody when the invalidating textBody is edited, so the executed send cannot ship the stale pre-edit HTML", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: DERIVED_REQUEST,
      fields: { textBody: "corrected text" },
      actor: requesterActor,
    })
    expect(result.currentPayload.textBody).toBe("corrected text")
    expect(result.currentPayload.htmlBody).toBe("")
    // The invalidation is recorded in the audit diff alongside the edit.
    expect(result.lastEdit?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "textBody", to: "corrected text" }),
        expect.objectContaining({ field: "htmlBody", from: "<p>old text</p>", to: "" }),
      ]),
    )
    // Persisted row — what the approve-time executor will actually read.
    const [row] = await sql`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${DERIVED_REQUEST}
    `
    expect(row.current_payload.textBody).toBe("corrected text")
    expect(row.current_payload.htmlBody).toBe("")
  })

  it("resets recorded N-eyes sign-offs when the payload is edited, and says so in the audit message", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: NEYES_REQUEST,
      fields: { message: "edited after first sign-off" },
      actor: requesterActor,
    })
    expect(result.currentPayload.message).toBe("edited after first sign-off")

    const [row] = await sql`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${NEYES_REQUEST}
    `
    // The distinct-approver set is cleared; the policy floor stays.
    expect(row.metadata.approvedBy).toBeUndefined()
    expect(row.metadata.minApprovers).toBe(2)

    const messages = await sql`
      SELECT content FROM kernel.messages
      WHERE org_id = ${ORG} AND content ILIKE '%sign-off%reset%'
    `
    expect(messages.length).toBeGreaterThan(0)
  })

  it("does NOT blank htmlBody when a non-invalidating field is edited", async () => {
    // htmlBody was blanked by the previous test; restore a derived value first.
    await sql`UPDATE kernel.approval_requests
      SET current_payload = jsonb_set(current_payload, '{htmlBody}', '"<p>corrected text</p>"')
      WHERE id = ${DERIVED_REQUEST}`
    const result = await updatePayload({
      orgId: ORG,
      requestId: DERIVED_REQUEST,
      fields: { subject: "New subject" },
      actor: requesterActor,
    })
    expect(result.currentPayload.subject).toBe("New subject")
    expect(result.currentPayload.htmlBody).toBe("<p>corrected text</p>")
  })

  it("applies a dot-path edit to the nested value, not a literal top-level key", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: NESTED_REQUEST,
      fields: { "customerEmail.body": "new body" },
      actor: requesterActor,
    })
    expect(result.lastEdit).toBeTruthy()
    // The nested value is updated in place; the sibling field is preserved.
    const email = result.currentPayload.customerEmail as Record<string, unknown>
    expect(email.body).toBe("new body")
    expect(email.subject).toBe("Hi")
    // No literal dotted key leaks into the payload.
    expect(result.currentPayload["customerEmail.body"]).toBeUndefined()

    // Persisted row reflects the nested write, not a shallow merge.
    const [row] = await sql`
      SELECT current_payload FROM kernel.approval_requests WHERE id = ${NESTED_REQUEST}
    `
    expect(row.current_payload.customerEmail.body).toBe("new body")
    expect(row.current_payload["customerEmail.body"]).toBeUndefined()
  })

  it("frees a replaced tool schema's validator after the tool is re-registered", async () => {
    // Every edit compiles, once, the validator for the tool's registered param
    // schema. A re-register replaces that schema object and the old validator
    // must not outlive it: one shared Ajv kept every schema it had compiled (and
    // its validator, which points back at it) alive from its code-generation
    // scope. Only WeakRefs to the schemas are held here.
    const LEAK_REQUEST = "00000000-0000-4000-8000-000000064012"
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${LEAK_REQUEST}, ${ORG}, 'request-leak', ${THREAD}, ${THREAD}, 'edit_approval:leak', '{"message":"old"}'::jsonb,
       '{"message":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Re-registered tool","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "leak"],
      [{ field: "message", label: "Message", widget: "text" }],
    )
    // Each version's schema also requires a field the payload lacks, so the edit
    // compiles that version's validator, fails it and rolls back, writing nothing.
    const registerAndEdit = async (i: number): Promise<WeakRef<object>> => {
      const params = {
        type: "object",
        properties: { message: { type: "string" }, [`extra${i}`]: { type: "string" } },
        required: ["message", `extra${i}`],
      }
      toolRegistry.set([ORG, "edit_approval", "leak"], {
        appName: "edit_approval",
        name: "leak",
        description: "Re-registered edit approval test tool",
        requiredScopes: ["edit_approval:write"],
        gated: true,
        handler: { bundlePath: "unused", exportName: "unused" },
        params,
      } as Parameters<typeof toolRegistry.set>[1])
      // Only the compiled schema check answers with the bare "invalid_edit"
      // message, so this proves the validator was built.
      await expect(
        updatePayload({
          orgId: ORG,
          requestId: LEAK_REQUEST,
          fields: { message: `edit ${i}` },
          actor: requesterActor,
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_edit", message: "invalid_edit" })
      return new WeakRef(params)
    }
    try {
      const versions = 6
      const schemas: WeakRef<object>[] = []
      for (let i = 0; i < versions; i++) schemas.push(await registerAndEdit(i))
      for (let k = 0; k < 5; k++) {
        Bun.gc(true)
        await Bun.sleep(10)
      }
      const replacedStillAlive = schemas.slice(0, -1).filter((r) => r.deref() !== undefined)
      expect(replacedStillAlive.length).toBe(0)
      expect(schemas[versions - 1].deref()).toBeDefined()
    } finally {
      approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "leak"])
      toolRegistry.delete([ORG, "edit_approval", "leak"])
    }
  })
  it("refuses an editable field the tool's schema does not declare, and stores nothing", async () => {
    // A tool that declares `body` editable while its params call the message
    // `textBody`: the edit used to be stored under `body`, which the handler never
    // reads, so the card showed the edit while the approved send kept the old text.
    const OFF_SCHEMA_REQUEST = "00000000-0000-4000-8000-000000064014"
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${OFF_SCHEMA_REQUEST}, ${ORG}, 'request-off-schema', ${THREAD}, ${THREAD}, 'edit_approval:offschema',
       '{"textBody":"old text"}'::jsonb, '{"textBody":"old text"}'::jsonb,
       now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Off-schema Edit","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "offschema"],
      [{ field: "body", label: "Message", widget: "text" }],
    )
    toolRegistry.set([ORG, "edit_approval", "offschema"], {
      appName: "edit_approval",
      name: "offschema",
      description: "Editable field missing from the schema",
      requiredScopes: ["edit_approval:write"],
      gated: true,
      handler: async () => ({}),
      params: { type: "object", properties: { textBody: { type: "string" } } },
    } as Parameters<typeof toolRegistry.set>[1])
    try {
      await expect(
        updatePayload({
          orgId: ORG,
          requestId: OFF_SCHEMA_REQUEST,
          fields: { body: "new text" },
          actor: requesterActor,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_edit",
        message: expect.stringContaining(
          "field 'body' is not a parameter of edit_approval:offschema",
        ),
      })
      const [row] =
        await sql`SELECT current_payload FROM kernel.approval_requests WHERE id = ${OFF_SCHEMA_REQUEST}`
      expect(row.current_payload).toEqual({ textBody: "old text" })
    } finally {
      approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "offschema"])
      toolRegistry.delete([ORG, "edit_approval", "offschema"])
    }
  })

  it("an edited reply body is the payload the card shows and the hash an approve binds to", async () => {
    const result = await updatePayload({
      orgId: ORG,
      requestId: DERIVED_REQUEST,
      fields: { textBody: "the edited reply" },
      actor: requesterActor,
    })
    const detail = await withRlsContext(requesterActor, (tx) =>
      getApproval(tx, { orgId: ORG, userId: REQUESTER, requestId: DERIVED_REQUEST }),
    )
    expect(detail?.currentPayload.textBody).toBe("the edited reply")
    expect(detail?.currentPayload).toEqual(result.currentPayload)
    expect(detail?.payloadHash).toBe(result.payloadHash)
    expect(result.payloadHash).toBe(
      approvalPayloadHash("edit_approval:derived", { ...result.currentPayload }),
    )
  })

  it("rebuilds the card's summary from the edited payload and returns the new fingerprint", async () => {
    const SUMMARY_REQUEST = "00000000-0000-4000-8000-000000064013"
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${SUMMARY_REQUEST}, ${ORG}, 'request-summary', ${THREAD}, ${THREAD}, 'edit_approval:tool', '{"message":"to alice"}'::jsonb,
       '{"message":"to alice"}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}, ${APPROVER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
       '{"kind":"edit","title":"Edit Approval","lines":["Message: to alice"]}'::jsonb)
      ON CONFLICT DO NOTHING`
    const editable = approvalEditableFieldsRegistry.get([ORG, "edit_approval", "tool"])
    approvalEditableFieldsRegistry.set(
      [ORG, "edit_approval", "tool"],
      [{ field: "message", label: "Message", widget: "text" }],
    )
    let summarizerRuns = 0
    registerApprovalSummarizer(ORG, "edit_approval", "tool", async (p) => {
      summarizerRuns++
      return {
        kind: "edit",
        title: "Edit Approval",
        lines: [`Message: ${(p as { message?: string }).message}`],
      }
    })
    try {
      const res = await updatePayload({
        orgId: ORG,
        requestId: SUMMARY_REQUEST,
        fields: { message: "to mallory" },
        actor: requesterActor,
      })
      expect(res.payloadHash).toBe(approvalPayloadHash("edit_approval:tool", res.currentPayload))
      const [row] =
        await sql`SELECT summary FROM kernel.approval_requests WHERE id = ${SUMMARY_REQUEST}`
      expect((row.summary as { lines: string[] }).lines).toEqual(["Message: to mallory"])
      expect(summarizerRuns).toBe(1)
      // The card and the list serve the stored summary: no summarizer runs on a read.
      const detail = await withRlsContext(requesterActor, (tx) =>
        getApproval(tx, { orgId: ORG, userId: REQUESTER, requestId: SUMMARY_REQUEST }),
      )
      const list = await withRlsContext(requesterActor, (tx) =>
        listApprovals(tx, { orgId: ORG, userId: REQUESTER, scopes: requesterActor.scopes }),
      )
      expect(detail?.summary?.lines).toEqual(["Message: to mallory"])
      expect(list.find((a) => a.id === SUMMARY_REQUEST)?.summary?.lines).toEqual([
        "Message: to mallory",
      ])
      expect(summarizerRuns).toBe(1)
    } finally {
      approvalSummarizerRegistry.delete([ORG, "edit_approval", "tool"])
      if (editable) approvalEditableFieldsRegistry.set([ORG, "edit_approval", "tool"], editable)
      else approvalEditableFieldsRegistry.delete([ORG, "edit_approval", "tool"])
    }
  })
})

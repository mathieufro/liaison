// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionKind } from "@liaison/shared"
import type { Predicate } from "./predicates"
import type { RecipientSpec } from "./recipients"

/** See `Translation.resolveWhen`. */
export type AttentionResolveWhen =
  | { field: string; equals: string | number | boolean }
  | { always: true }

/**
 * A Translation declares how a particular `entity:action` event should produce
 * `kernel.attention_events` rows. Kernel built-ins use path-based recipient
 * specs so participant/mention lists can be carried in `event.data` rather than
 * looked up from DB.
 */
export interface Translation {
  /** `${entity}:${action}` — matched against the event. */
  event: string
  /** Optional app restriction. Kernel built-ins set this to "kernel". */
  app?: string
  kind: AttentionKind
  urgency: number
  isUrgent?: boolean
  /** Mustache-lite template with `{{actor.name}}` and `{{payload.data.x.y}}`. */
  summary: string
  when?: Predicate
  recipients: RecipientSpec
  /** If true and `event.actorId` is among the resolved recipients, drop it. */
  excludeActor?: boolean
  /**
   * When this holds, `excludeActor` does not apply: the event's actor did not
   * write what it is about. An agent row's actor is the human whose turn it is,
   * and a routine's post in their conversation (`data.unprompted`) is news to
   * them like any message they have not read.
   */
  keepActorWhen?: Predicate
  /**
   * If true, drop any recipient who is also mentioned in `event.data.mentions`.
   * A mentioned user already gets the higher-urgency `mention` row — this stops
   * `thread_reply` from double-notifying them for the same message.
   */
  excludeMentioned?: boolean
  /**
   * If true, drop any recipient listed in `event.data.followerIds`. A reply's
   * followers are told by the `thread_followup` row, so a reply sent with
   * "also send to channel" must not tell them a second time as `thread_reply`
   * (THR-08). A no-op on an event that carries no followers (a channel post).
   */
  excludeFollowers?: boolean
  /**
   * Key the row on `(entityType, event.data[idField])` instead of the default
   * target (for a kernel message, its thread). The unread dedupe key and every
   * mark-read are per entity, so this is how a kind gets one row per sub-thing
   * of a thread: `thread_followup` keys on the reply thread's root, so three
   * followed roots are three rows and reading the channel clears none of them.
   * Falls back to the default target when the field is absent.
   */
  targetFromData?: { entityType: string; idField: string }
  /**
   * The row is a push about a specific message. Drop every recipient who cannot
   * see that message: `isMessageVisible` over `data.requiredScopes` and
   * `data.disclosureList`, with that recipient's own grants. An event without a
   * requiredScopes array reaches no one (fail closed). A hidden message gets no
   * row at all rather than a placeholder, as the approval feed drops a row its
   * reader cannot see.
   *
   * Set on EVERY message-derived translation, whether or not its summary quotes
   * the content. A18 forbids the push itself, not just the preview: no
   * notification is generated for a message whose requiredScopes the recipient
   * does not satisfy at send time, and the badge count reflects only what the
   * read-time predicate admits. A content-free summary still pushes a badge the
   * recipient cannot act on, for a message the thread hides from them.
   */
  requireMessageVisible?: boolean
  /**
   * Declarative `event.data.*` → attention-row `metadata` copy. Each listed key
   * is copied from `event.data` onto the row's `metadata` when defined; absent
   * keys are skipped. Generic — no per-kind branching in the translator body.
   */
  metadataFromData?: string[]
  /**
   * The event RESOLVES the attention row: matching unread rows (org, app,
   * entity_type, entity_id, kind) are marked read instead of upserted.
   *   • `{ field, equals }` — resolves when `event.data[field] === equals`, so a
   *     digest-style scanner clears its own row when the backlog reaches zero.
   *   • `{ always: true }` — the event's existence IS the resolution (an order
   *     being fulfilled ends the "new order" row's reason to exist). Without
   *     this form an app had to find a constant payload field to compare on.
   */
  resolveWhen?: AttentionResolveWhen
}

/**
 * An agent row that is news to the person it works for: a post nobody in the
 * conversation asked for (a routine's run, `SendMessageParams.unprompted`), or
 * the row that ends their agent's turn (its answer or summary,
 * `SendMessageParams.endsTurn`). Its progress lines and the posts it makes on
 * the way are not: they land in the chat as unread (etiquette rule 1).
 */
const NEWS_TO_ACTOR: Predicate = {
  op: "or",
  clauses: [
    { op: "eq", path: "data.unprompted", value: true },
    { op: "eq", path: "data.endsTurn", value: true },
  ],
}

export const kernelTranslations: Translation[] = [
  {
    event: "message:create",
    app: "kernel",
    kind: "thread_reply",
    urgency: 30,
    summary: "{{payload.data.preview}}",
    // Only human/agent replies notify participants. System messages (approval
    // decisions, handler errors, etc.) are not "replies" — they are either
    // noise or already carried by a more specific kind (`approval_decision`).
    // A reply the channel does not show is not channel news (S6): it tells
    // its followers through `thread_followup` below, and only a reply sent
    // with "also send to channel" still tells the room.
    when: {
      op: "and",
      clauses: [
        {
          op: "or",
          clauses: [
            { op: "in", path: "data.authorType", values: ["user", "agent"] },
            // A system row that ends a person's turn (a refusal, a failed
            // resume) is that turn's answer: it reaches their inbox too.
            { op: "eq", path: "data.endsTurn", value: true },
          ],
        },
        {
          op: "or",
          clauses: [
            { op: "not", clause: { op: "exists", path: "data.replyRootId" } },
            { op: "eq", path: "data.alsoInChannel", value: true },
          ],
        },
      ],
    },
    recipients: { kind: "participants", path: "data.participantIds" },
    excludeActor: true,
    keepActorWhen: NEWS_TO_ACTOR,
    excludeMentioned: true,
    // A follower of the root already gets `thread_followup` for this reply.
    excludeFollowers: true,
    // A muted or archived thread keeps the reply as a quiet inbox row: the
    // router decides that per recipient (notifications/router.ts, rule 7).
    // The summary is the message's first 140 characters.
    requireMessageVisible: true,
  },
  {
    // S6: a reply tells the people FOLLOWING its reply thread (the root's
    // author, every replier, every member mentioned in it), carried on the
    // event as `followerIds`. The writer is never told about their own reply,
    // and a member the reply mentions already gets the `mention` row.
    event: "message:create",
    app: "kernel",
    kind: "thread_followup",
    urgency: 40,
    summary: "{{payload.data.preview}}",
    when: {
      op: "and",
      clauses: [
        { op: "in", path: "data.authorType", values: ["user", "agent"] },
        { op: "exists", path: "data.replyRootId" },
      ],
    },
    recipients: { kind: "participants", path: "data.followerIds" },
    excludeActor: true,
    keepActorWhen: NEWS_TO_ACTOR,
    excludeMentioned: true,
    requireMessageVisible: true,
    // One row per followed root (THR-08): keyed on the root, a followup on
    // one root never overwrites another's, reading the channel leaves it be,
    // and reading that reply thread (POST .../replies/read) clears it alone.
    targetFromData: { entityType: "reply_thread", idField: "replyRootId" },
    // The client opens the reply panel on this root, in this channel.
    metadataFromData: ["replyRootId", "threadId"],
  },
  {
    event: "message:create",
    app: "kernel",
    kind: "mention",
    urgency: 60,
    summary: "{{actor.name}} mentioned you",
    when: { op: "exists", path: "data.mentions" },
    recipients: { kind: "mentions", path: "data.mentions" },
    // The summary quotes nothing, but the row is still a push about a message
    // the recipient may not be able to open. A18 bars the notification itself.
    requireMessageVisible: true,
    // A mention inside a reply thread opens that reply thread (A17).
    metadataFromData: ["replyRootId"],
  },
  {
    event: "approval_request:update",
    app: "kernel",
    kind: "approval_decision",
    urgency: 50,
    isUrgent: false,
    summary: "Approval {{payload.data.handle}} {{payload.data.status}}",
    // The event carries the approval summary (`buildApprovalSummary`): a
    // refusal is `denied`, and the requester is `requestedBy.id`. This row,
    // in the `approvals` group, is how the requester hears of a decision; the
    // thread's "Approved by X" / "Denied by X" line does not push.
    when: { op: "in", path: "data.status", values: ["approved", "denied", "expired"] },
    recipients: { kind: "field", path: "data.requestedBy.id" },
    // Nobody is told of their own decision. An expiry has no human actor (the
    // system stamps the requester), so it still reaches them.
    excludeActor: true,
    keepActorWhen: { op: "eq", path: "actorType", value: "system" },
  },
  // NOTE: a post-approval failure is no longer a SEPARATE attention item. The
  // failure now rides the approval summary as `lastFailure` (buildApprovalSummary,
  // sourced from approved_handler_executions) so the card renders it inline — one
  // surface, no parallel translation/event-data path.
  {
    event: "file:create",
    app: "kernel",
    kind: "file_shared",
    urgency: 20,
    summary: "{{actor.name}} added a file to {{payload.data.parentLabel}}",
    when: { op: "eq", path: "data.parentSharedSurface", value: true },
    recipients: { kind: "participants", path: "data.parentParticipantIds" },
    // The row is keyed on the file, which no tab renders: open the thread it was
    // added to (the event's link).
    metadataFromData: ["link"],
  },
  {
    event: "agent_notification:create",
    app: "kernel",
    kind: "agent_notification",
    urgency: 50, // static fallback — overridden per-row from data.urgency
    summary: "{{payload.data.summary}}",
    recipients: { kind: "participants", path: "data.targetUserIds" },
    // A routine run waiting for its owner's mailbox has its own kind (below).
    when: { op: "not", clause: { op: "exists", path: "data.routineMailboxWait" } },
    // A node chat's relayed permission prompt (P4 S24, A24) is decided on the
    // row itself: Allow / Deny on what is asked, from which node.
    // `routineAlert` (D21): a routine that failed or paused, filed by Home
    // under Agents > "Routines failed or paused" (routine-alert.ts).
    // `awayNamed`: a colleague marked the person away (modules/users/away.ts).
    // `awayCalendar`: the person's own calendar made, moved or asks about an away range.
    metadataFromData: [
      "link",
      "nodePermissionPromptId",
      "nodePermission",
      "routineAlert",
      "awayNamed",
      "awayCalendar",
      // `routedReminder`: a request waiting a day tells its deciders once
      // (approvals/routed-reminders.ts); `link` opens the request's conversation.
      "routedReminder",
    ],
  },
  {
    // A routine run waiting for its owner's private mailbox
    // (routine-mailbox-wait.ts): an item of the owner's approvals list, with
    // Run now and Dismiss. Not an approval of an agent's action: the owner
    // resumes their own routine, so no `<app>:approve` scope decides who sees
    // it; the event names the owner alone. The run itself takes the item out
    // of the list when it runs, is dismissed or expires.
    event: "agent_notification:create",
    app: "kernel",
    kind: "routine_mailbox_wait",
    urgency: 60,
    summary: "{{payload.data.summary}}",
    when: { op: "exists", path: "data.routineMailboxWait" },
    recipients: { kind: "participants", path: "data.targetUserIds" },
    metadataFromData: ["link", "routineMailboxWait"],
  },
  {
    // S17: an agent tool changed the user's own notification settings. The
    // announcement is a system_alert so no per-app rule can narrow it, and the
    // in-app channel cannot be switched off: no setting silences it. The summary
    // is rendered in the user's language by the tool.
    event: "notification_settings:update",
    app: "kernel",
    kind: "system_alert",
    urgency: 40,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "participants", path: "data.targetUserIds" },
    metadataFromData: ["link"],
  },
  {
    // An admin connected an account for the whole organization that a member
    // held personally (connections/service.ts, announceTakenOverAccounts): the
    // member's own connection was disconnected, so they are told, as a
    // system_alert no per-app rule can narrow.
    event: "connected_account:disconnect",
    app: "kernel",
    kind: "system_alert",
    urgency: 50,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    when: { op: "eq", path: "data.reason", value: "taken_over" },
    recipients: { kind: "field", path: "data.ownerId" },
  },
  {
    // An app refused the account a person had just connected (a mailbox
    // address another owner's mailbox holds, an IMAP login that failed): the
    // connection was disconnected, so the person who connected it is told why
    // (connections/service.ts disconnectConnection's notice).
    event: "connected_account:disconnect",
    app: "kernel",
    kind: "system_alert",
    urgency: 50,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    when: { op: "eq", path: "data.reason", value: "connect_refused" },
    recipients: { kind: "field", path: "data.notifyUserId" },
  },
  {
    // A personal connect the provider callback refused: the account is already
    // connected for the organization or by another member (connections/
    // service.ts, announceConnectRefused). No connection was stored, so this is
    // the person's only lasting record of why; the summary names what THEY can
    // do (a member is never told to reconnect the shared connection).
    event: "connected_account:refuse",
    app: "kernel",
    kind: "system_alert",
    urgency: 50,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    when: { op: "eq", path: "data.reason", value: "connect_refused" },
    recipients: { kind: "field", path: "data.notifyUserId" },
  },
  {
    // A whole-org export finished (modules/export/org-archive/store.ts): the
    // admin who asked is told it is ready to download, from Settings →
    // Organization.
    event: "org_export:complete",
    app: "kernel",
    kind: "system_alert",
    urgency: 50,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "field", path: "data.notifyUserId" },
    // The web's `kernel/org_export` opener lands it in Settings on this route.
    metadataFromData: ["settingsRoute"],
  },
  {
    // An org cap crossed 80 % or 100 % (modules/org/caps.ts): the org admins
    // are told once per cap, threshold and crossing (background jobs: once a
    // day per threshold). Calm urgency: a limit reached is information, and
    // only whoever runs the server can raise it.
    event: "org_cap:threshold",
    app: "kernel",
    kind: "system_alert",
    urgency: 40,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "scope_holders", scope: "kernel:org:admin" },
    // The web's `kernel/org_cap` opener lands it in Settings → Organization.
    metadataFromData: ["settingsRoute", "cap", "threshold"],
  },
  {
    // The org moved to another server (modules/org/transfer/after-commit.ts):
    // its MCP connections were signed by the old server and must be connected
    // again. Told once per move to the org's admins; calm, nothing is lost.
    event: "org_move:reconnect",
    app: "kernel",
    kind: "system_alert",
    urgency: 40,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "scope_holders", scope: "kernel:org:admin" },
    metadataFromData: ["settingsRoute", "connections"],
  },
  {
    // A bug report sent only to the Liaison team never arrived (refused,
    // expired or cancelled; modules/liaison-team/team-only.ts). No local ticket
    // holds it, so the org admins are told once, with the report text, and can
    // file it again. Calm urgency: nothing is broken on this server.
    event: "liaison_team_forward:undelivered",
    app: "kernel",
    kind: "system_alert",
    urgency: 40,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "scope_holders", scope: "kernel:org:admin" },
    metadataFromData: ["settingsRoute", "reportText", "outcome", "reason"],
  },
  {
    // A security signal for this org (modules/security/security-events.ts): an
    // account used up a budget of wrong answers to a sign-in factor. Org admins
    // are told, as a system_alert no per-app rule can narrow, at an urgency that
    // reaches the email digest too. Keyed per signal, account and day by the
    // emitter, so a repeat refreshes one row.
    event: "security_event:create",
    app: "kernel",
    kind: "system_alert",
    urgency: 75,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    recipients: { kind: "scope_holders", scope: "kernel:org:admin" },
    metadataFromData: ["securityEvent", "factor", "subjectUserId"],
  },
  {
    // The same row for the account a sign-in signal is about: an administrator
    // signing in from a new address hears about it even when the org admin
    // scope is not theirs (any `…:admin` scope counts). One row per recipient
    // and entity, so an org admin who is also the subject gets it once.
    event: "security_event:create",
    app: "kernel",
    kind: "system_alert",
    urgency: 75,
    isUrgent: false,
    summary: "{{payload.data.summary}}",
    when: { op: "in", path: "data.securityEvent", values: ["admin_signin_new_ip"] },
    recipients: { kind: "field", path: "data.subjectUserId" },
    metadataFromData: ["securityEvent", "method", "subjectUserId"],
  },
  {
    // A new scope request → notify everyone who can decide it (scope-admins).
    event: "scope_request:create",
    app: "kernel",
    kind: "scope_request",
    urgency: 60,
    // The asker comes off the event, not off the actor lookup: that lookup
    // reads `kernel.users`, and an agent turn's actor is the human whose turn
    // it was, so an agent's request rendered as "Someone requested access".
    // The title names the scopes asked for, so the admin can see what they are
    // deciding without opening the row.
    summary: "{{payload.data.requesterLabel}} requested access: {{payload.data.title}}",
    recipients: { kind: "scope_holders", scope: "kernel:scope_requests:admin" },
    metadataFromData: ["agentId", "agentName", "requestedScopes", "requesterLabel", "reason"],
  },
  {
    // A decision on a scope request → notify the original requester.
    event: "scope_request:update",
    app: "kernel",
    kind: "scope_request_decided",
    urgency: 40,
    summary: "Scope request {{payload.data.status}}",
    when: { op: "in", path: "data.status", values: ["approved", "denied"] },
    recipients: { kind: "field", path: "data.requestedBy" },
  },
  {
    // A decision on a scope request → resolve the ASK in every decider's feed.
    // The `scope_request` row is actionable ("X requested access") and stays
    // until read; without this, approving or denying left it sitting in every
    // admin's feed against an already-decided request. Org-wide by design
    // (resolveAttentionRows ignores recipients): the rows belong to the OTHER
    // admins too. The requester's `scope_request_decided` row is a different
    // kind and is left alone: that one is news to read, not a task.
    event: "scope_request:update",
    app: "kernel",
    kind: "scope_request",
    urgency: 60,
    summary: "",
    when: { op: "in", path: "data.status", values: ["approved", "denied"] },
    recipients: { kind: "field", path: "data.decidedBy" },
    resolveWhen: { always: true },
  },
]

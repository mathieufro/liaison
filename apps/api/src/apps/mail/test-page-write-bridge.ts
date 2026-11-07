// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test helper: the mail unit tests drive the bundle with hand-written mock
// bridges. Production writes a sync page host side, in one transaction, through
// `mail_writePage` (modules/mail/page-write.ts), which the mocks predate. This
// adapter gives a mock that surface, derived from the mock's OWN single-row
// methods, so what a test records (inserts, updates, emits) and what it stubs
// (stored messages, existing conversations) keep meaning what the test says:
//
//   - stored messages and existing conversations are asked of the mock's
//     `db_findMany`, one equality lookup per id, as the old handler did;
//   - conversations and messages are written through its `db_insert` (a sealing
//     mailbox's messages through its `mailbox_sealAndInsert` stub), roll-ups
//     through its `db_update`, events through its `emit`;
//   - the roll-up values and every event payload come from the REAL pure
//     helpers of page-write.ts, so the event-shape assertions (Invariant K, the
//     S16 origin) still test production code;
//   - senders resolve through the mock's `resolveContact`, if it has one.
//
// It also answers a `db_findMany` whose where carries an `in` list by asking
// the mock once per value with a plain equality where (each row stamped with
// the value it matched, as a real row carries it).
//
// The transaction, the sealing, the ON CONFLICT races and the contact policy
// are NOT emulated: they are tested against a real database in
// apps/mail/page-write.test.ts and modules/mail/sender-contacts.test.ts.
// Test-only: nothing in the app imports this file.

import { executeInSandbox as realExecuteInSandbox } from "~/modules/apps/sandbox/executor"
import {
  conversationCreateEvent,
  conversationUpdateEvent,
  type MailSyncOrigin,
  messageCreateEvent,
  newConversationStatus,
  type PageMessage,
  threadRollup,
} from "~/modules/mail/page-write"

type Bridge = Record<string, any>

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

async function emulateWritePage(
  bridge: Bridge,
  paramsJson: string,
  accountHint: Record<string, unknown> | undefined,
): Promise<string> {
  const { accountId, origin, messages } = JSON.parse(paramsJson) as {
    accountId: string
    origin: string
    messages: PageMessage[]
  }
  // The host reads the account row; a mock that has none gets the account the
  // test handed `processMessages` directly.
  const account =
    JSON.parse((await bridge.db_findOne?.("accounts", accountId)) ?? "null") ?? accountHint ?? {}
  const sealing = account.owner_type === "user" && account.encryption_state === "ready"
  const find = async (entity: string, where: Record<string, unknown>) =>
    JSON.parse(await bridge.db_findMany(entity, JSON.stringify({ where })))
  const entries: unknown[] = []
  const events: unknown[] = []
  const threads = new Map<string, { messages: PageMessage[]; current: any }>()
  for (const m of messages) {
    if ((await find("messages", { accountId, externalMessageId: m.externalMessageId })).length) {
      continue
    }
    let thread = threads.get(m.externalThreadId)
    if (!thread) {
      const [current] = await find("conversations", {
        accountId,
        externalThreadId: m.externalThreadId,
      })
      thread = { messages: [], current: current ?? null }
      threads.set(m.externalThreadId, thread)
    }
    thread.messages.push(m)
  }
  for (const [threadId, thread] of threads) {
    const rollup = threadRollup(thread.messages, thread.current, sealing)
    let conversationId: string
    if (!thread.current) {
      const first = [...thread.messages].sort(
        (a, b) => Date.parse(a.sentAt ?? "") - Date.parse(b.sentAt ?? ""),
      )[0] as PageMessage
      const created = JSON.parse(
        await bridge.db_insert(
          "conversations",
          JSON.stringify({
            accountId,
            ownerType: account.owner_type,
            ownerId: account.owner_id ?? undefined,
            externalThreadId: threadId,
            subject: sealing ? null : first.subject || null,
            snippet: rollup.snippet,
            fromEmail: rollup.fromEmail,
            status: newConversationStatus(thread.messages, origin as MailSyncOrigin),
            labels: rollup.labels,
            isRead: rollup.isRead,
            isStarred: rollup.isStarred,
            lastMessageAt: rollup.lastMessageAt,
            messageCount: thread.messages.length,
          }),
        ),
      )
      conversationId = created.id
      events.push(conversationCreateEvent(conversationId, accountId, first.subject, sealing))
    } else {
      conversationId = thread.current.id
      const messageCount =
        Number(thread.current.message_count ?? thread.current.messageCount ?? 0) +
        thread.messages.length
      const snippet = rollup.newer ? rollup.snippet : (thread.current.snippet ?? null)
      // The host reads the conversation up to a reply the user sent
      // (markConversationReadThrough); the mock holds no per-message state, so
      // a sent reply simply reads it.
      const isRead =
        (origin === "sent" || origin === "imap-sent") &&
        thread.messages.some((m) => (m.direction ?? "inbound") !== "inbound")
          ? true
          : rollup.isRead
      await bridge.db_update(
        "conversations",
        conversationId,
        JSON.stringify({
          messageCount,
          labels: rollup.labels,
          isRead,
          isStarred: rollup.isStarred,
          lastMessageAt: rollup.lastMessageAt,
          ...(!sealing && rollup.newer ? { snippet } : {}),
        }),
      )
      events.push(
        conversationUpdateEvent(
          conversationId,
          accountId,
          { snippet, messageCount, isRead, lastMessageAt: rollup.lastMessageAt },
          sealing,
        ),
      )
    }
    for (const m of thread.messages) {
      const row = {
        conversationId,
        accountId,
        externalMessageId: m.externalMessageId,
        externalProviderId: m.externalProviderId,
        fromAddress: m.from,
        toAddresses: m.to ?? [],
        labels: m.labels ?? [],
        direction: m.direction ?? "inbound",
        sentAt: m.sentAt,
        sentByUserId: m.sentByUserId ?? undefined,
        ownerType: account.owner_type,
        ownerId: account.owner_id ?? undefined,
      }
      const plaintext = {
        subject: m.subject || null,
        textBody: m.textBody || null,
        htmlBody: m.htmlBody || null,
        snippet: m.snippet || null,
      }
      const inserted = JSON.parse(
        sealing && bridge.mailbox_sealAndInsert
          ? await bridge.mailbox_sealAndInsert(
              JSON.stringify({ entity: "messages", accountId, row, plaintext }),
            )
          : await bridge.db_insert("messages", JSON.stringify({ ...row, ...plaintext })),
      )
      events.push(messageCreateEvent(m, inserted.id, conversationId, accountId, origin as never))
      entries.push({
        messageId: inserted.id,
        externalMessageId: m.externalMessageId,
        conversationId,
        resumed: false,
      })
    }
    if (bridge.resolveContact) {
      for (const m of thread.messages) {
        if ((m.direction ?? "inbound") === "inbound" && m.from?.email) {
          await bridge.resolveContact(JSON.stringify({ email: m.from.email, name: m.from.name }))
        }
      }
    }
  }
  for (const event of events) await bridge.emit?.(JSON.stringify(event))
  return JSON.stringify({ entries })
}

export function withPageWriteMethods(
  bridge: Bridge,
  accountHint?: Record<string, unknown>,
): Bridge {
  const out: Bridge = { ...bridge }
  const findMany = bridge.db_findMany
  if (findMany) {
    out.db_findMany = async (entity: string, optsJson: string) => {
      const opts = JSON.parse(optsJson || "{}")
      const where = opts.where ?? {}
      const inKey = Object.keys(where).find(
        (key) => where[key] && typeof where[key] === "object" && Array.isArray(where[key].in),
      )
      if (!inKey) return findMany(entity, optsJson)
      const column = snake(inKey)
      const rows: unknown[] = []
      for (const value of where[inKey].in) {
        const matched = JSON.parse(
          await findMany(entity, JSON.stringify({ ...opts, where: { ...where, [inKey]: value } })),
        ) as Array<Record<string, unknown>>
        rows.push(...matched.map((row) => ({ [column]: value, ...row })))
      }
      return JSON.stringify(rows)
    }
  }
  if (!bridge.mail_writePage) {
    out.mail_writePage = async (paramsJson: string) =>
      emulateWritePage({ ...bridge, db_findMany: out.db_findMany }, paramsJson, accountHint)
  }
  // The send check runs on the real bridge (send-guard.integration.test.ts). A
  // fake database has nothing for it to read, so it does not apply here.
  if (!bridge.mail_buildSendGuard) {
    out.mail_buildSendGuard = async () => JSON.stringify({ applies: false })
  }
  if (!bridge.mail_checkSendGuard) {
    out.mail_checkSendGuard = async () => JSON.stringify({ applies: false })
  }
  if (!bridge.mail_completeIngest) {
    out.mail_completeIngest = async () => JSON.stringify({ count: 0 })
  }
  return out
}

/** `executeInSandbox`, with the mock bridge given the page-write surface. */
export const executeInSandbox: typeof realExecuteInSandbox = (opts) =>
  realExecuteInSandbox({
    ...opts,
    bridge: withPageWriteMethods(
      opts.bridge as Bridge,
      (opts.params as { account?: Record<string, unknown> } | undefined)?.account,
    ),
  })

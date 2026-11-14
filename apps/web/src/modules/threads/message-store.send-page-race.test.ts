// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SENT MESSAGE SHOWS ONCE, EVEN WHEN A PAGE READ BEATS THE SEND'S ANSWER.
//
// Opening a conversation and sending into it at once (Discuss with the personal
// agent does) races the conversation's page read against the send. A page read
// after the server stored the message, but before the send's answer came back,
// already holds the real row; the pending row it echoes has to go then, and the
// socket echo that follows must not leave it either.
import { beforeEach, describe, expect, it } from "vitest"
import {
  handleWsMessageEvent,
  loadMessages,
  messageStore,
  resetMessageStore,
  sendMessage,
} from "~/modules/threads/message-store"
import { resetThreadStore } from "~/modules/threads/thread-store"

const THREAD = "t-race"
const USER = { id: "u-me", name: "Me" }

function serverRow(id: string, content: string, createdAt = "2026-11-10T07:30:00Z") {
  return {
    id,
    threadId: THREAD,
    authorId: USER.id,
    authorName: USER.name,
    authorType: "user",
    content,
    createdAt,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const rows = () =>
  (messageStore.threads[THREAD]?.ids ?? []).map((id) => ({
    ...messageStore.threads[THREAD]!.byId[id],
    id,
  }))

describe("a send racing the conversation's page read", () => {
  beforeEach(() => {
    resetMessageStore()
    resetThreadStore()
  })

  it("a page that already holds the sent message replaces its pending row", async () => {
    await loadMessages({ get: async () => [] }, THREAD)
    const answer = deferred<{ data: unknown }>()
    let correlationId = ""
    const post = async (_path: string, body: unknown) => {
      correlationId = String((body as { correlationId: string }).correlationId)
      return answer.promise
    }
    const sent = sendMessage({ post }, THREAD, "I want to discuss #Client Feedback", USER)
    await Promise.resolve()
    expect(rows().map((r) => r.pending)).toEqual([true])

    // The page read lands first, already holding the stored message.
    await loadMessages(
      { get: async () => [serverRow("m-1", "I want to discuss #Client Feedback")] },
      THREAD,
    )
    expect(rows().map((r) => r.id)).toEqual(["m-1"])

    // Then the socket echo, then the send's answer: still one message.
    handleWsMessageEvent("create", {
      ...serverRow("m-1", "I want to discuss #Client Feedback"),
      correlationId,
    })
    expect(rows().map((r) => r.id)).toEqual(["m-1"])
    answer.resolve({ data: serverRow("m-1", "I want to discuss #Client Feedback") })
    await sent
    expect(rows().map((r) => r.id)).toEqual(["m-1"])
  })

  it("the socket echo retires the pending row when the real row is already listed", async () => {
    await loadMessages({ get: async () => [] }, THREAD)
    const answer = deferred<{ data: unknown }>()
    let correlationId = ""
    const post = async (_path: string, body: unknown) => {
      correlationId = String((body as { correlationId: string }).correlationId)
      return answer.promise
    }
    const sent = sendMessage({ post }, THREAD, "hello", USER)
    await Promise.resolve()
    // The real row arrives under a different text (the server rewrote a
    // mention), so only the correlationId ties it to the pending send.
    await loadMessages({ get: async () => [serverRow("m-2", "hello there")] }, THREAD)
    expect(rows().filter((r) => r.pending)).toHaveLength(1)
    handleWsMessageEvent("create", { ...serverRow("m-2", "hello there"), correlationId })
    expect(rows().map((r) => r.id)).toEqual(["m-2"])
    answer.resolve({ data: serverRow("m-2", "hello there") })
    await sent
    expect(rows().map((r) => r.id)).toEqual(["m-2"])
  })

  it("an older identical message already listed never retires a new pending send", async () => {
    await loadMessages(
      { get: async () => [serverRow("m-old", "ok", "2026-11-10T07:00:00Z")] },
      THREAD,
    )
    const answer = deferred<{ data: unknown }>()
    const sent = sendMessage({ post: async () => answer.promise }, THREAD, "ok", USER)
    await Promise.resolve()
    await loadMessages(
      { get: async () => [serverRow("m-old", "ok", "2026-11-10T07:00:00Z")] },
      THREAD,
    )
    expect(rows().map((r) => r.pending ?? false)).toEqual([false, true])
    answer.resolve({ data: serverRow("m-new", "ok") })
    await sent
    expect(rows().map((r) => r.id)).toEqual(["m-old", "m-new"])
  })
})

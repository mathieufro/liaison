// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { InboundKind } from "~/modules/mail/classify-inbound"
import {
  addressInText,
  decideSendGuard,
  describeStop,
  type GuardInbound,
} from "~/modules/mail/send-guard"

const NOW = new Date("2026-11-06T12:00:00.000Z")

function inbound(
  id: string,
  kind: InboundKind,
  at: string,
  textBody: string | null = null,
): GuardInbound {
  return { id, kind, sender: `${id}@example.com`, at: new Date(at), textBody }
}

describe("decideSendGuard", () => {
  it("nothing inbound reads clear", () => {
    expect(decideSendGuard({ inbound: [], now: NOW })).toEqual({ state: "clear" })
  })

  it("an ignored mail reads clear", () => {
    const items = [inbound("news", "ignored", "2026-11-06T11:00:00.000Z")]
    expect(decideSendGuard({ inbound: items, now: NOW })).toEqual({ state: "clear" })
  })

  it("a reply reads replied, final, naming who and when", () => {
    const items = [inbound("ann", "reply", "2026-11-06T11:00:00.000Z")]
    expect(decideSendGuard({ inbound: items, now: NOW })).toEqual({
      state: "replied",
      final: true,
      messageId: "ann",
      who: "ann@example.com",
      at: new Date("2026-11-06T11:00:00.000Z"),
    })
  })

  it("a reply outranks a later auto-reply", () => {
    const items = [
      inbound("ooo", "auto_reply", "2026-11-06T11:30:00.000Z", "Back on 2026-11-16"),
      inbound("ann", "reply", "2026-11-06T09:00:00.000Z"),
    ]
    const decision = decideSendGuard({ inbound: items, now: NOW })
    expect(decision.state).toBe("replied")
  })

  it("a reply outranks a bounce", () => {
    const items = [
      inbound("daemon", "bounce", "2026-11-06T11:30:00.000Z"),
      inbound("ann", "reply", "2026-11-06T09:00:00.000Z"),
    ]
    expect(decideSendGuard({ inbound: items, now: NOW }).state).toBe("replied")
  })

  it("the newest reply is the one named", () => {
    const items = [
      inbound("old", "reply", "2026-11-05T09:00:00.000Z"),
      inbound("new", "reply", "2026-11-06T09:00:00.000Z"),
    ]
    expect(decideSendGuard({ inbound: items, now: NOW })).toMatchObject({ messageId: "new" })
  })

  it("bounce outranks auto-reply", () => {
    const items = [
      inbound("ooo", "auto_reply", "2026-11-06T11:30:00.000Z", "Back on 2026-11-16"),
      inbound("daemon", "bounce", "2026-11-06T09:00:00.000Z"),
    ]
    expect(decideSendGuard({ inbound: items, now: NOW })).toMatchObject({
      state: "bounced",
      final: true,
      messageId: "daemon",
    })
  })

  it("a reply or a bounce stops whatever ignoreAutoReply says", () => {
    const ignoreAutoReply = { by: "user-1", at: "2026-11-06T11:00:00.000Z" }
    const reply = [inbound("ann", "reply", "2026-11-06T11:00:00.000Z")]
    const bounce = [inbound("daemon", "bounce", "2026-11-06T11:00:00.000Z")]
    expect(decideSendGuard({ inbound: reply, now: NOW, ignoreAutoReply }).state).toBe("replied")
    expect(decideSendGuard({ inbound: bounce, now: NOW, ignoreAutoReply }).state).toBe("bounced")
  })

  it("an auto-reply in its window reads held, not final, with the parsed date", () => {
    const items = [inbound("ooo", "auto_reply", "2026-11-06T11:00:00.000Z", "Back on 2026-11-16")]
    expect(decideSendGuard({ inbound: items, now: NOW, timeZone: "Europe/Paris" })).toEqual({
      state: "held",
      final: false,
      messageId: "ooo",
      who: "ooo@example.com",
      at: new Date("2026-11-06T11:00:00.000Z"),
      returnDate: "2026-11-16",
      holdUntil: new Date("2026-11-15T23:00:00.000Z"),
    })
  })

  it("a sealed auto-reply holds 7 days with no date", () => {
    const items = [inbound("ooo", "auto_reply", "2026-11-06T11:00:00.000Z", null)]
    expect(decideSendGuard({ inbound: items, now: NOW })).toMatchObject({
      state: "held",
      returnDate: null,
      holdUntil: new Date("2026-11-13T11:00:00.000Z"),
    })
  })

  it("expired hold reads clear", () => {
    const items = [inbound("ooo", "auto_reply", "2026-10-20T11:00:00.000Z")]
    expect(decideSendGuard({ inbound: items, now: NOW })).toEqual({ state: "clear" })
  })

  it("a hold ends at the very instant of holdUntil", () => {
    const items = [inbound("ooo", "auto_reply", "2026-10-30T12:00:00.000Z")]
    expect(decideSendGuard({ inbound: items, now: NOW })).toEqual({ state: "clear" })
    const justBefore = new Date(NOW.getTime() - 1)
    expect(decideSendGuard({ inbound: items, now: justBefore }).state).toBe("held")
  })

  it("ignoreAutoReply set reads clear", () => {
    const items = [inbound("ooo", "auto_reply", "2026-11-06T11:00:00.000Z", "Back on 2026-11-16")]
    const ignoreAutoReply = { by: "user-1", at: "2026-11-06T11:30:00.000Z" }
    expect(decideSendGuard({ inbound: items, now: NOW, ignoreAutoReply })).toEqual({
      state: "clear",
    })
  })

  it("the newest auto-reply decides the hold", () => {
    const items = [
      inbound("old", "auto_reply", "2026-11-01T09:00:00.000Z", "Back on 2026-12-01"),
      inbound("new", "auto_reply", "2026-10-02T09:00:00.000Z"),
      inbound("newest", "auto_reply", "2026-11-05T09:00:00.000Z", "Back on 2026-11-20"),
    ]
    expect(decideSendGuard({ inbound: items, now: NOW })).toMatchObject({
      state: "held",
      messageId: "newest",
      returnDate: "2026-11-20",
    })
  })

  it("an expired newest auto-reply reads clear even with an older one still in its window", () => {
    const items = [
      inbound("old", "auto_reply", "2026-10-02T09:00:00.000Z", "Back on 2026-11-20"),
      inbound("new", "auto_reply", "2026-10-20T09:00:00.000Z"),
    ]
    expect(decideSendGuard({ inbound: items, now: NOW })).toEqual({ state: "clear" })
  })
})

describe("describeStop: where a stopping reply came in", () => {
  const at = "2026-11-06T11:00:00.000Z"

  it("a reply on a ticket the caller cannot open names a ticket, not a mailbox", () => {
    const text = describeStop(
      { state: "replied", final: true, who: "tomas@example.com", at, source: "ticket" },
      "approved",
    )
    expect(text).toContain("tomas@example.com replied on 2026-11-06 11:00 UTC.")
    expect(text).toContain("It came in on a ticket you cannot open.")
    expect(text).toContain("Next: ask whoever handles that ticket")
    expect(text).not.toContain("mailbox")
  })

  it("a reply in a mailbox the caller cannot read still says a mailbox", () => {
    const text = describeStop(
      { state: "replied", final: true, who: "ann@example.com", at, source: "conversation" },
      "approved",
    )
    expect(text).toContain("It came in to a mailbox you cannot read.")
  })
})

describe("addressInText: a report's text names the address", () => {
  const finds = (address: string, text: string) => new RegExp(addressInText(address)).test(text)

  it("an address that ends a sentence is found", () => {
    expect(finds("bob@x.example", "could not be delivered to bob@x.example.")).toBe(true)
    expect(finds("bob@x.example", "<bob@x.example>: 550 user unknown")).toBe(true)
  })

  it("a longer domain or local part is another address", () => {
    expect(finds("bob@x.example", "delivered to bob@x.example.evil.test")).toBe(false)
    expect(finds("bob@x.example", "delivered to xbob@x.example")).toBe(false)
    expect(finds("bob@x.example", "delivered to a.bob@x.example")).toBe(false)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  classifyInbound,
  failedRecipients,
  htmlAsText,
  reportConcerns,
  reportText,
} from "~/modules/mail/classify-inbound"

const DELIVERY_REPORT = 'multipart/report; report-type=delivery-status; boundary="b1"'
const READ_RECEIPT = 'multipart/report; report-type=disposition-notification; boundary="b1"'
const dsnBody = (...actions: string[]) =>
  [
    "This is the mail system.",
    "",
    "Reporting-MTA: dns; mx.example.com",
    ...actions.flatMap((action) => [
      "",
      "Final-Recipient: rfc822; a@b.example",
      `Action: ${action}`,
    ]),
  ].join("\n")

describe("classifyInbound: bounces", () => {
  it("a delivery report whose Action is not delayed is a bounce", () => {
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Undeliverable", dsnBody("failed")),
    ).toBe("bounce")
  })

  it("a sender local part of mailer-daemon is a bounce", () => {
    expect(
      classifyInbound({}, "Mail delivery failed", "It failed", "MAILER-DAEMON@mx.example.com"),
    ).toBe("bounce")
  })

  it("a sender local part of postmaster is a bounce", () => {
    expect(classifyInbound({}, "Returned mail", "It failed", "postmaster@example.com")).toBe(
      "bounce",
    )
  })

  it("the sender is read from the From header when not passed apart", () => {
    expect(
      classifyInbound(
        { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
        "Delivery Status Notification (Failure)",
        "It failed",
      ),
    ).toBe("bounce")
  })

  it("a local part that only contains mailer-daemon is not a bounce", () => {
    expect(classifyInbound({}, "Hello", "Hi", "not-mailer-daemon@example.com")).toBe("reply")
  })

  it("action=failed is a bounce", () => {
    expect(classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("failed"))).toBe(
      "bounce",
    )
  })

  it("a report with one failed and one delayed recipient is a bounce", () => {
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("delayed", "failed")),
    ).toBe("bounce")
  })

  it("a delivery report with a sealed body is a bounce", () => {
    expect(classifyInbound({ "content-type": DELIVERY_REPORT }, null, null)).toBe("bounce")
  })

  it("a sealed mail from mailer-daemon is a bounce", () => {
    expect(classifyInbound({}, null, null, "mailer-daemon@mx.example.com")).toBe("bounce")
  })

  it("a failure report stored with no Action field is a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Delivery Status Notification (Failure)",
        "Address not found. Your message wasn't delivered.",
      ),
    ).toBe("bounce")
  })

  it("a failure report about a mail whose subject speaks of a delay is a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Undeliverable: Delivery delayed for order 12",
        "Your message wasn't delivered.",
      ),
    ).toBe("bounce")
  })

  it("a report type written in another case or quoted still reads as a delivery report", () => {
    expect(
      classifyInbound(
        { "Content-Type": 'Multipart/Report;\r\n\tReport-Type="Delivery-Status"; boundary=x' },
        "Report",
        dsnBody("failed"),
      ),
    ).toBe("bounce")
  })
})

describe("classifyInbound: reports that are not bounces", () => {
  it("disposition-notification is not a bounce", () => {
    expect(
      classifyInbound({ "content-type": READ_RECEIPT }, "Read: Offer", "Your message was read"),
    ).toBe("ignored")
  })

  it("a read receipt sent with auto-submitted reads as a read receipt, not an auto-reply", () => {
    expect(
      classifyInbound(
        { "content-type": READ_RECEIPT, "auto-submitted": "auto-replied" },
        "Read: Offer",
        "Your message was read",
      ),
    ).toBe("ignored")
  })

  it("a sealed read receipt is not a bounce", () => {
    expect(classifyInbound({ "content-type": READ_RECEIPT }, null, null)).toBe("ignored")
  })

  it("action=delivered is not a bounce", () => {
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("delivered")),
    ).toBe("ignored")
  })

  it("action=relayed is not a bounce", () => {
    expect(classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("relayed"))).toBe(
      "ignored",
    )
  })

  it("one delivered and one failed recipient is a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Report",
        dsnBody("delivered", "failed"),
      ),
    ).toBe("bounce")
  })

  it("a French delay notice is not a bounce", () => {
    for (const [subject, body] of [
      ["Remise différée : votre commande", "Le message est en attente."],
      ["Retard de distribution", ""],
      ["Avis du serveur", "La remise de ce message a été retardée."],
      ["Avis du serveur", "Ceci est un simple avertissement, rien à faire."],
      ["Avis du serveur", "Nouvelle tentative de remise dans quatre heures."],
    ] as const) {
      expect(classifyInbound({ "content-type": DELIVERY_REPORT }, subject, body)).toBe("ignored")
      expect(classifyInbound({}, subject, body, "mailer-daemon@mx.example.com")).toBe("ignored")
    }
  })

  it("a French failure notice, or wording nobody listed, stays a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Non remis : votre commande",
        "Votre message n'a pas pu être remis.",
      ),
    ).toBe("bounce")
    expect(classifyInbound({}, "Zustellung verzögert", "", "mailer-daemon@mx.example.com")).toBe(
      "bounce",
    )
  })

  it("the stored sender decides, not the headers an IMAP mailbox never kept", () => {
    expect(
      classifyInbound({}, "Returned mail", "Could not deliver.", "MAILER-DAEMON@mx.test"),
    ).toBe("bounce")
    expect(classifyInbound({}, "Merci", "Bien reçu.", "client@client.test")).toBe("reply")
  })

  it("action=delayed is not a bounce", () => {
    expect(classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("delayed"))).toBe(
      "ignored",
    )
  })

  it("a delay notice from mailer-daemon with auto-submitted is not a bounce and not an auto-reply", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT, "auto-submitted": "auto-replied" },
        "Delayed Mail (still being retried)",
        dsnBody("delayed"),
        "MAILER-DAEMON@mx.example.com",
      ),
    ).toBe("ignored")
  })

  it("a delay notice from mailer-daemon stored with no headers is not a bounce", () => {
    expect(
      classifyInbound({}, "Delayed Mail", dsnBody("delayed"), "MAILER-DAEMON@mx.example.com"),
    ).toBe("ignored")
  })

  it("a delay notice stored with its human part only is not a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Delivery Status Notification (Delay)",
        "Delivery incomplete. There was a temporary problem delivering your message. Gmail will retry for 47 more hours.",
      ),
    ).toBe("ignored")
  })

  it("a delay notice with no text part is not a bounce", () => {
    expect(
      classifyInbound(
        { "content-type": DELIVERY_REPORT },
        "Delivery Status Notification (Delay)",
        null,
      ),
    ).toBe("ignored")
  })

  it("a report of another type falls through to the other rules", () => {
    const feedback = 'multipart/report; report-type=feedback-report; boundary="b1"'
    expect(classifyInbound({ "content-type": feedback }, "Abuse report", "Details")).toBe("reply")
  })

  it("a multipart mail that is not a report ignores an Action line in its body", () => {
    expect(
      classifyInbound(
        { "content-type": 'multipart/mixed; boundary="b1"' },
        "Next steps",
        "Action: delayed\nCan we talk on Monday?",
      ),
    ).toBe("reply")
  })
})

describe("classifyInbound: auto-replies", () => {
  it("auto-submitted: no is not auto", () => {
    expect(classifyInbound({ "auto-submitted": "no" }, "Thanks", "Thanks")).toBe("reply")
  })

  it("auto-submitted: No with a parameter is not auto", () => {
    expect(classifyInbound({ "auto-submitted": " No ; note=x" }, "Thanks", "Thanks")).toBe("reply")
  })

  it("auto-submitted: auto-replied is an auto-reply", () => {
    expect(classifyInbound({ "auto-submitted": "auto-replied" }, "Re: Offer", "I am away")).toBe(
      "auto_reply",
    )
  })

  it("a header name in another case is read", () => {
    expect(classifyInbound({ "Auto-Submitted": "auto-generated" }, "Re: Offer", "I am away")).toBe(
      "auto_reply",
    )
  })

  it("precedence: auto_reply is an auto-reply", () => {
    expect(classifyInbound({ precedence: "auto_reply" }, "Re: Offer", "I am away")).toBe(
      "auto_reply",
    )
  })

  it("x-autoreply is an auto-reply", () => {
    expect(classifyInbound({ "x-autoreply": "yes" }, "Re: Offer", "I am away")).toBe("auto_reply")
  })

  it("x-autorespond is an auto-reply", () => {
    expect(classifyInbound({ "x-autorespond": "yes" }, "Re: Offer", "I am away")).toBe("auto_reply")
  })

  it("only x-auto-response-suppress with In-Reply-To is a reply", () => {
    expect(
      classifyInbound(
        { "x-auto-response-suppress": "All", "in-reply-to": "<a@b>" },
        "Re: Offer",
        "Yes, let us go ahead",
      ),
    ).toBe("reply")
  })

  it("only x-auto-response-suppress with no In-Reply-To is an auto-reply", () => {
    expect(classifyInbound({ "x-auto-response-suppress": "All" }, "Notice", "Notice")).toBe(
      "auto_reply",
    )
  })

  it("x-auto-response-suppress with a blank In-Reply-To is an auto-reply", () => {
    expect(
      classifyInbound(
        { "x-auto-response-suppress": "All", "in-reply-to": " " },
        "Notice",
        "Notice",
      ),
    ).toBe("auto_reply")
  })

  for (const subject of [
    "Out of office",
    "OUT OF OFFICE: until Monday",
    "Automatic reply: Offer",
    "Auto-reply: Offer",
    "Autoreply",
    "auto reply",
    "Absence",
    "Absent du bureau",
    "Réponse automatique : Offre",
    "RÉPONSE AUTOMATIQUE",
    "Réponse automatique",
    "  Absent",
  ]) {
    it(`the subject prefix of "${subject}" is an auto-reply`, () => {
      expect(classifyInbound({}, subject, "Text")).toBe("auto_reply")
    })
  }

  it("a subject that only mentions an absence after Re: is a reply", () => {
    expect(classifyInbound({}, "Re: Out of office next week?", "Yes")).toBe("reply")
  })

  it("a subject whose first word only starts like absent is a reply", () => {
    expect(classifyInbound({}, "Absenteeism figures", "Attached")).toBe("reply")
  })
})

describe("classifyInbound: ignored", () => {
  it("list-id is ignored", () => {
    expect(classifyInbound({ "list-id": "<news.example.com>" }, "News", "News")).toBe("ignored")
  })

  it("list-unsubscribe is ignored", () => {
    expect(classifyInbound({ "list-unsubscribe": "<mailto:x@y>" }, "News", "News")).toBe("ignored")
  })

  for (const precedence of ["bulk", "junk", "list", " BULK "]) {
    it(`precedence: ${precedence} is ignored`, () => {
      expect(classifyInbound({ precedence }, "News", "News")).toBe("ignored")
    })
  }

  it("an automated list mail holds rather than being dropped", () => {
    expect(
      classifyInbound({ "list-id": "<x>", "auto-submitted": "auto-generated" }, "Build", "Build"),
    ).toBe("auto_reply")
  })
})

describe("classifyInbound: replies", () => {
  it("a plain mail is a reply", () => {
    expect(classifyInbound({ "content-type": "text/plain" }, "Re: Offer", "Yes, let us go")).toBe(
      "reply",
    )
  })

  it("a mail with no headers at all is a reply", () => {
    expect(classifyInbound({}, "Re: Offer", "Yes, let us go")).toBe("reply")
  })

  for (const raw of [null, undefined, "text", 3, ["a"]]) {
    it(`stored headers of ${JSON.stringify(raw)} read as none`, () => {
      expect(classifyInbound(raw, "Re: Offer", "Yes")).toBe("reply")
    })
  }
})

// Sealing keeps the allowlisted headers in clear and empties subject and body.
describe("classifyInbound: a sealed mailbox", () => {
  it("a sealed inbound with auto-submitted is an auto-reply", () => {
    expect(classifyInbound({ "auto-submitted": "auto-replied" }, null, null)).toBe("auto_reply")
  })

  it("a sealed inbound with list-id is ignored", () => {
    expect(classifyInbound({ "list-id": "<x>" }, null, null)).toBe("ignored")
  })

  it("a sealed inbound with no such header is a reply", () => {
    expect(classifyInbound({ "content-type": "text/plain" }, null, null)).toBe("reply")
  })

  it("a retained header sealed from a list value reads its value", () => {
    expect(classifyInbound({ "auto-submitted": '["no"]' }, null, null)).toBe("reply")
    expect(classifyInbound({ "auto-submitted": '["auto-replied"]' }, null, null)).toBe("auto_reply")
  })
})

describe("classifyInbound: header values", () => {
  it("a header held as a list is read", () => {
    expect(classifyInbound({ "auto-submitted": ["no", "auto-replied"] }, "Re: x", "y")).toBe(
      "auto_reply",
    )
  })
})

describe("classifyInbound: delay notices", () => {
  it("a report with Action: delayed and no Action: failed is not a bounce", () => {
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("delayed", "relayed")),
    ).toBe("ignored")
  })

  it("an action other than failed is not a bounce", () => {
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", dsnBody("deferred")),
    ).toBe("ignored")
  })

  it("an HTML-only delay notice reads by its HTML", () => {
    const html =
      "<p>This is a warning only.</p><p>Final-Recipient: rfc822; a@b.example<br>Action: delayed</p>"
    expect(
      classifyInbound({ "content-type": DELIVERY_REPORT }, "Report", reportText(null, html)),
    ).toBe("ignored")
    expect(
      classifyInbound({}, "Undelivered", reportText("", html), "mailer-daemon@mx.example.com"),
    ).toBe("ignored")
  })
})

const GROUP_REPORT = [
  "Your message wasn't delivered to alice@x.example because the address couldn't be found.",
  "",
  "----- Original message -----",
  "",
  "From: us@org.example",
  "To: alice@x.example, bob@x.example",
  "Cc: carol@x.example",
  "Subject: Our offer",
].join("\n")

describe("failedRecipients: which address a report says failed", () => {
  it("the machine part names the failed recipient, not the others the original went to", () => {
    const text = [
      "Delivery to the following recipient failed permanently.",
      "",
      "Reporting-MTA: dns; mx.x.example",
      "",
      "Final-Recipient: rfc822; alice@x.example",
      "Action: failed",
      "",
      "Final-Recipient: rfc822; bob@x.example",
      "Action: delayed",
      "",
      "To: alice@x.example, bob@x.example",
    ].join("\n")
    expect(failedRecipients(text, null)).toEqual(["alice@x.example"])
  })

  it("without a machine part, the addresses before the quoted original", () => {
    expect(failedRecipients(GROUP_REPORT, null)).toEqual(["alice@x.example"])
  })

  it("quoted headers alone name no failed address", () => {
    expect(failedRecipients(GROUP_REPORT.slice(GROUP_REPORT.indexOf("-----")), null)).toEqual([])
  })

  it("a full stop after the address is punctuation", () => {
    expect(failedRecipients("Could not be delivered to bob@x.example.", null)).toEqual([
      "bob@x.example",
    ])
  })

  it("a longer domain is another address", () => {
    expect(failedRecipients("Could not be delivered to bob@x.example.evil.test", null)).toEqual([
      "bob@x.example.evil.test",
    ])
  })

  it("an HTML-only report reads by its HTML", () => {
    expect(failedRecipients(null, "<p>Delivery to <b>alice@x.example</b> failed.</p>")).toEqual([
      "alice@x.example",
    ])
  })
})

describe("reportConcerns: whether a failure is about a draft's recipient", () => {
  const facts = (addresses: string[], textBody: string | null, answered: string[] | null) => ({
    textBody,
    htmlBody: null,
    answered,
    addresses,
  })

  it("a failure for alice on a mail to alice and bob concerns alice only", () => {
    const answered = ["alice@x.example", "bob@x.example", "carol@x.example"]
    expect(reportConcerns(facts(["bob@x.example"], GROUP_REPORT, answered))).toBe(false)
    expect(reportConcerns(facts(["carol@x.example"], GROUP_REPORT, answered))).toBe(false)
    expect(reportConcerns(facts(["ALICE@x.example"], GROUP_REPORT, answered))).toBe(true)
  })

  it("a report naming no address concerns the one recipient of the mail it answers", () => {
    expect(reportConcerns(facts(["alice@x.example"], null, ["alice@x.example"]))).toBe(true)
  })

  it("a report naming no address on a group mail concerns nobody", () => {
    const answered = ["alice@x.example", "bob@x.example"]
    expect(reportConcerns(facts(["alice@x.example"], null, answered))).toBe(false)
    expect(reportConcerns(facts(["bob@x.example"], null, answered))).toBe(false)
  })

  it("a report naming no address and answering none of our mail concerns nobody", () => {
    expect(reportConcerns(facts(["alice@x.example"], "Delivery failed.", null))).toBe(false)
  })

  it("a sub-domain address is not the draft's", () => {
    const text = "Could not be delivered to bob@x.example.evil.test."
    expect(reportConcerns(facts(["bob@x.example"], text, null))).toBe(false)
  })
})

describe("htmlAsText", () => {
  it("leaves no angle bracket, whatever the markup or its entities", () => {
    const out = htmlAsText("<scr<script>ipt>x</script> &lt;b&gt; <p>a@b.example</p>") ?? ""
    expect(out).not.toMatch(/[<>]/)
    expect(out).toContain("a@b.example")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ranker reads a query word beyond its exact spelling: another form of the
// word ("invoicing", "factures"), a misspelling ("refnud"), a translation or a
// plain synonym ("rembourser", "money"), and in a query of several words it
// weighs a rare word above one many tools answer to. Pure: a fixture catalog,
// no server.
import { describe, expect, it } from "bun:test"
import { rankDeferredTools, scoreDeferredTools, wordStem } from "./tool-rank"

interface Row {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: string[]
}

const row = (appName: string, toolName: string, description: string, keywords?: string[]): Row => ({
  sdkName: `${appName}__${toolName}`,
  toolName,
  appName,
  description,
  ...(keywords ? { keywords } : {}),
})

const CATALOG: Row[] = [
  row("shop", "refunds_create", "Give a customer their payment back on an order."),
  row("shop", "orders_search", "Find orders by number, customer or date."),
  row("billing", "invoice_send", "Email a finished document to its customer."),
  row("billing", "documents_search", "Find documents.", ["abonné"]),
  row("billing", "drafts_create", "Start a draft document."),
  row("calendar", "create_event", "Put a meeting in a calendar."),
  row("tasks", "comment", "Leave a note on a task."),
  row("chat", "message_send", "Post a message."),
  row("mail", "compose_send", "Write and send a new email."),
  row("social", "reply_send", "Answer a public post."),
  row("ads", "report_send", "Send the ads report."),
  row("crm", "note_send", "Send a note."),
  row("files", "link_send", "Send a link to a file."),
  row("digest", "digest_create", "Set up a summary of what happened."),
  row("cards", "cards_list", "List the cards."),
  row("carts", "carts_list", "List the abandoned carts."),
  row("api-connector", "connector_adapter_save", "Save how Liaison talks to an outside system.", [
    "connect",
    "integration",
  ]),
]
const APPS = new Set(CATALOG.map((t) => t.appName))

const rank = (query: string) =>
  rankDeferredTools(CATALOG, query, { cap: 5, appNames: APPS }).all.map((s) => s.tool.sdkName)
const scoreOf = (query: string, sdkName: string) =>
  scoreDeferredTools(CATALOG, query, { appNames: APPS }).find((s) => s.tool.sdkName === sdkName)
    ?.score ?? 0

describe("tool search: other forms of a word", () => {
  it("stems French and English forms of one word to one stem", () => {
    expect(wordStem("factures")).toBe(wordStem("facturer"))
    expect(wordStem("facture")).toBe(wordStem("facturation"))
    expect(wordStem("invoicing")).toBe(wordStem("invoice"))
    // A stem keeps four letters: "cree" is not cut to "cr".
    expect(wordStem("cree")).toBe("cree")
  })

  it("'invoicing' finds the tool named invoice_send first", () => {
    expect(rank("invoicing")[0]).toBe("billing__invoice_send")
  })

  it("'abonnement' finds the tool whose keyword is 'abonné'", () => {
    expect(rank("abonnement")[0]).toBe("billing__documents_search")
  })

  it("another form scores under the exact word", () => {
    expect(scoreOf("invoicing", "billing__invoice_send")).toBeLessThan(
      scoreOf("invoice", "billing__invoice_send"),
    )
  })
})

describe("tool search: misspelt words", () => {
  it("'refnud' finds refunds_create first (two letters swapped)", () => {
    expect(rank("refnud")[0]).toBe("shop__refunds_create")
  })

  it("'oders' finds orders_search (a letter missing)", () => {
    expect(rank("oders")[0]).toBe("shop__orders_search")
  })

  it("a word the catalog holds is never read as a misspelling of another", () => {
    // "cards" is a name part, so carts_list does not answer to it.
    expect(rank("cards")).not.toContain("carts__carts_list")
  })

  it("a word under 5 letters is corrected only for two swapped neighbouring letters", () => {
    // A letter changed or dropped in so short a word makes another word ("cord", "crd").
    expect(rank("cerd")).toEqual([])
    expect(rank("crd")).toEqual([])
    expect(rank("crad")[0]).toBe("cards__cards_list")
  })
})

describe("tool search: translations and plain synonyms of name words", () => {
  it("'rembourser' finds refunds_create, which has no French keyword", () => {
    expect(rank("rembourser")[0]).toBe("shop__refunds_create")
  })

  it("'rdv' and 'réunion' find create_event", () => {
    expect(rank("rdv")[0]).toBe("calendar__create_event")
    expect(rank("réunion")[0]).toBe("calendar__create_event")
  })

  it("'crée' finds a tool named create", () => {
    expect(rank("crée")).toContain("billing__drafts_create")
  })
})

describe("tool search: a rare word weighs more than a common one", () => {
  it("'send the digest' ranks digest_create above every tool named *_send", () => {
    // Each word is one name part of its tools: unweighed, all seven tie at 10.
    const digest = scoreOf("send the digest", "digest__digest_create")
    for (const t of CATALOG.filter((t) => t.toolName.endsWith("_send")))
      expect(digest).toBeGreaterThan(scoreOf("send the digest", t.sdkName))
    expect(rank("send the digest")[0]).toBe("digest__digest_create")
  })

  it("a single word is scored as before: no weighing", () => {
    expect(scoreOf("digest", "digest__digest_create")).toBe(10)
  })
})

describe("tool search: a word no tool answers to", () => {
  it("credits the connector when the rest of the query asks to connect ('connect hubspot')", () => {
    expect(rank("connect hubspot")[0]).toBe("api-connector__connector_adapter_save")
  })

  it("credits no connector in a sentence about something else ('create event with Lumen')", () => {
    expect(rank("create event with Lumen")).not.toContain("api-connector__connector_adapter_save")
    expect(rank("create event with Lumen")[0]).toBe("calendar__create_event")
  })
})

describe("tool search: the organization's own records and agent nouns", () => {
  const OWN: Row[] = [
    row("kernel", "companies_search", "Find the organization's companies.", ["société"]),
    row("kernel", "create_role", "Create a role."),
    row("shop", "companies_search", "Find the store's B2B companies.", ["société", "b2b"]),
    row("ship", "create_shipment", "Create a shipment."),
    row("ship", "labels_create", "Print a label."),
    row("deals", "deals_update", "Change a deal."),
    row("ads", "dealer_list", "Who resells for us."),
  ]
  const apps = ["shop", "ship", "deals", "ads"]
  const score = (q: string, name: string) =>
    scoreDeferredTools(OWN, q, { appNames: apps }).find((s) => s.tool.sdkName === name)?.score ?? 0

  it("a word the kernel's tool of the same record matches puts it first", () => {
    expect(score("société", "kernel__companies_search")).toBeGreaterThan(
      score("société", "shop__companies_search"),
    )
  })

  it("a word naming the app, or one only the app answers to, lifts the app's tool", () => {
    expect(score("shop société", "shop__companies_search")).toBeGreaterThan(
      score("shop société", "kernel__companies_search"),
    )
    expect(score("b2b société", "shop__companies_search")).toBeGreaterThan(
      score("b2b société", "kernel__companies_search"),
    )
  })

  it("a word ending a tool's name is an action, not a shared record ('create')", () => {
    expect(score("create", "ship__create_shipment")).toBe(score("create", "kernel__create_role"))
  })

  it("a word plus -er is another word: 'deal' is not 'dealer', 'dealers' still is", () => {
    expect(score("deal", "ads__dealer_list")).toBe(0)
    expect(score("deals", "ads__dealer_list")).toBe(0)
    expect(score("dealers", "ads__dealer_list")).toBeGreaterThan(0)
    expect(score("deal", "deals__deals_update")).toBeGreaterThan(0)
  })
})

describe("tool search: punctuation around a word", () => {
  it("a word followed by a question mark, or in brackets, scores as the word", () => {
    const refund = "shop__refunds_create"
    expect(scoreOf("refunds?", refund)).toBe(scoreOf("refunds", refund))
    expect(scoreOf("(invoice)", "billing__invoice_send")).toBe(
      scoreOf("invoice", "billing__invoice_send"),
    )
    expect(scoreOf("« drafts »", "billing__drafts_create")).toBe(
      scoreOf("drafts", "billing__drafts_create"),
    )
  })

  it("words joined by a plus sign or an ampersand are two words", () => {
    expect(scoreOf("drafts+invoice", "billing__drafts_create")).toBeGreaterThan(0)
    expect(scoreOf("drafts+invoice", "billing__invoice_send")).toBeGreaterThan(0)
    expect(scoreOf("drafts&invoice", "billing__invoice_send")).toBeGreaterThan(0)
  })
})

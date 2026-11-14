// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How the ranker reads the way people actually type a request: wrapped in
// courtesy ("could you please ... when you get a chance"), with a French verb
// conjugated away from its infinitive ("réponds", "ouvre"), or with two letters
// of a short word swapped ("mial"). Pure: a fixture catalog, no server.
import { describe, expect, it } from "bun:test"
import { withoutCourtesy } from "./tool-lexicon"
import { type TextEmbedder, type ToolMeaning, ToolMeaningIndex } from "./tool-meaning"
import { hiddenToolAliases, rankDeferredTools, scoreDeferredTools } from "./tool-rank"

interface Row {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: string[]
  aliases?: string[]
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
  row("shop", "orders_get", "Read one order."),
  row("shop", "orders_search", "Find orders by number, customer or date."),
  row("tickets", "close", "Close a ticket once it is handled."),
  row("tickets", "get", "Read one ticket."),
  row("tickets", "reply", "Answer the customer on a ticket."),
  row("billing", "invoice_issue", "Issue a draft invoice."),
  row("billing", "documents_get", "Read one invoice or quote."),
  row("mail", "compose", "Write and send a new email."),
  row("mail", "search", "Find emails."),
  row("projects", "create", "Create a task."),
  row("projects", "move", "Move a task to another project."),
  row("knowledge", "create", "Write a new page."),
  row("knowledge", "open", "Open a page."),
]
const APPS = new Set(CATALOG.map((t) => t.appName))

const ranking = (query: string) => {
  const r = rankDeferredTools(CATALOG, query, { cap: 5, appNames: APPS })
  return { listed: r.ranked.map((s) => s.tool.sdkName), loaded: [...r.strongNames].sort() }
}
const top = (query: string) => ranking(query).listed[0]

describe("courtesy around a request", () => {
  it("a polite wrapper around a request ranks the same tools as the bare request", () => {
    const pairs: Array<[string, string]> = [
      ["could you please refund the order", "refund the order"],
      ["would you mind closing the ticket when you get a chance", "closing the ticket"],
      ["I'd like you to issue the invoice, thanks", "issue the invoice"],
      ["can you reply to the ticket if possible", "reply to the ticket"],
      ["est-ce que tu pourrais rembourser la commande s'il te plaît", "rembourser la commande"],
      ["merci de bien vouloir fermer le ticket", "fermer le ticket"],
      ["pourrais-tu émettre la facture ?", "émettre la facture"],
    ]
    for (const [polite, bare] of pairs) expect(ranking(polite), polite).toEqual(ranking(bare))
  })

  it("keeps a request's own words: only the wrapper goes", () => {
    expect(withoutCourtesy("Could you get the invoice?")).toBe("get the invoice?")
    expect(withoutCourtesy("When you get a chance, get me order 1042")).toBe(", get me order 1042")
    expect(withoutCourtesy("Est-ce que tu pourrais fermer le ticket, s'il te plaît")).toBe(
      "fermer le ticket,",
    )
    // Nothing but courtesy: the query stays whole rather than empty.
    expect(withoutCourtesy("thanks")).toBe("thanks")
  })

  it("the meaning model reads the request without its courtesy wrapper", async () => {
    const queries: string[] = []
    const unit = (i: number) => Array.from({ length: 24 }, (_, k) => (k === i ? 1 : 0))
    const embedder: TextEmbedder = {
      id: "recording",
      async embed(texts, kind) {
        if (kind === "query") queries.push(...texts)
        return texts.map((_, i) => unit(i % 24))
      },
    }
    const many = Array.from({ length: 24 }, (_, i) => row("app", `tool_${i}`, `Tool ${i}.`))
    const index = new ToolMeaningIndex(embedder)
    index.prepare(many)
    await index.ready()
    const meaning: ToolMeaning | null = await index.meaningFor(
      "Could you please refund Élodie when you get a chance?",
      many,
    )
    expect(meaning).not.toBeNull()
    expect(queries).toEqual(["refund Élodie ?"])
  })
})

describe("French verb forms", () => {
  it("a French verb form whose stem is not its infinitive's reads as that verb", () => {
    // "réponds" is "répondre", "ouvre" is "ouvrir": the lexicon holds the infinitive.
    expect(top("réponds au client sur ce ticket")).toBe("tickets__reply")
    expect(top("ouvre la page")).toBe("knowledge__open")
  })
})

describe("short misspellings", () => {
  it("a four-letter word with two neighbouring letters swapped reads as the word it misspells", () => {
    expect(top("mial Sara")).toBe("mail__compose")
    expect(top("mvoe task")).toBe("projects__move")
  })

  it("a four-letter word one letter off another is not read as it", () => {
    // "main" and "mall" are words of their own, not misspellings of "mail".
    for (const q of ["main", "mall"])
      expect(
        scoreDeferredTools(CATALOG, q).filter((s) => s.tool.appName === "mail" && s.score > 0),
        q,
      ).toEqual([])
  })

  it("a four-letter word that is a word itself is not read as the word it would misspell", () => {
    // "lits" is "lit" (a catalog word) plus "s"; "sign" is a lexicon word, not a swap of "sing".
    const catalog: Row[] = [
      ...CATALOG,
      row("lights", "list", "List the lights that are lit right now."),
      row("choir", "sing", "Play a song for the choir."),
    ]
    const strong = (q: string) =>
      [
        ...rankDeferredTools(catalog, q, {
          cap: 5,
          appNames: new Set(catalog.map((t) => t.appName)),
        }).strongNames,
      ].sort()
    expect(strong("lits")).toEqual([])
    expect(
      scoreDeferredTools(catalog, "sign").filter((s) => s.tool.toolName === "sing" && s.score > 0),
    ).toEqual([])
    // A swap that is no word at all still reads as the word it misspells.
    expect(strong("lsit")).toContain("lights__list")
  })
})

describe("French words for a company", () => {
  // Every tool here matches one query word through its keywords; only the
  // timeline is also about a company, and says so in its name alone.
  const catalog: Row[] = [
    row("kernel", "audit_search", "Search the audit log.", ["historique"]),
    row("kernel", "routine_events", "List a routine's runs.", ["historique"]),
    row("billing", "customer_history", "A customer's past documents.", ["historique"]),
    row("billing", "issuer_profile_list", "List issuer profiles.", ["société"]),
    row("billing", "issuer_profile_update", "Change an issuer profile.", ["société"]),
    row("kernel", "company_timeline", "A record's timeline, newest first.", ["historique"]),
  ]
  const apps = new Set(catalog.map((t) => t.appName))
  const first = (query: string) =>
    rankDeferredTools(catalog, query, { cap: 5, appNames: apps }).ranked[0]?.tool.sdkName

  it("société and entreprise read as the company a tool name speaks of", () => {
    expect(first("historique société")).toBe("kernel__company_timeline")
    expect(first("historique entreprise")).toBe("kernel__company_timeline")
    expect(first("historique des sociétés")).toBe("kernel__company_timeline")
  })
})

describe("a read that took over hidden reads", () => {
  // One list read answers several kinds by a parameter; the per-kind reads it
  // replaced are hidden from agents and name it as the tool to use instead.
  const hidden = [
    { appName: "code", toolName: "list_pull_requests", agentVisible: false, useInstead: "list" },
    { appName: "code", toolName: "list_releases", agentVisible: false, useInstead: "list" },
    { appName: "code", toolName: "list_drafts", agentVisible: false, useInstead: "kernel__drafts" },
    { appName: "code", toolName: "get_pull_request", useInstead: "list" },
  ]
  const catalog = (aliases?: string[]): Row[] => [
    {
      ...row("code", "list", "List a repository's items by kind."),
      ...(aliases ? { aliases } : {}),
    },
    row("code", "get_pull_request", "Read one pull request."),
    row("review", "list_merge_requests", "List merge requests."),
    row("review", "list_releases", "List releases."),
  ]
  const first = (rows: Row[], query: string) =>
    rankDeferredTools(rows, query, { cap: 5, appNames: new Set(["code", "review"]) }).ranked[0]
      ?.tool.sdkName

  it("names each visible tool by the hidden tools that send an agent to it", () => {
    const aliases = hiddenToolAliases(hidden)
    expect(aliases.get("code__list")).toEqual(["list_pull_requests", "list_releases"])
    expect(aliases.get("kernel__drafts")).toEqual(["list_drafts"])
    // A visible tool that names another is no alias of it.
    expect([...aliases.keys()].sort()).toEqual(["code__list", "kernel__drafts"])
  })

  it("the list read answers to the names of the reads it replaced", () => {
    const aliases = hiddenToolAliases(hidden).get("code__list")
    expect(first(catalog(), "code pull requests")).toBe("code__get_pull_request")
    expect(first(catalog(aliases), "code pull requests")).toBe("code__list")
    expect(first(catalog(aliases), "list code releases")).toBe("code__list")
  })

  it("another app's tool named by the query still leads its app's words", () => {
    const aliases = hiddenToolAliases(hidden).get("code__list")
    expect(first(catalog(aliases), "review releases")).toBe("review__list_releases")
  })
})

describe("words for correcting, time and a report", () => {
  const catalog: Row[] = [
    row("work", "task_time_set", "Record your own time on a task.", ["temps"]),
    row("work", "task_time_correct", "Change another person's time entry.", ["corriger"]),
    row("work", "task_time_get", "Your time on a task.", ["temps"]),
    row("work", "timesheet_export", "A project's dated sheet as a file.", ["timesheet"]),
    row("billing", "documents_update", "Change an invoice."),
    row("billing", "documents_download_pdf", "A document as a PDF."),
    row("billing", "documents_retry_pdf", "Render a PDF again."),
    row("kernel", "dashboards_pdf", "A dashboard as a PDF."),
    row("kernel", "files_merge_pdfs", "Join PDF files."),
  ]
  const apps = new Set(catalog.map((t) => t.appName))
  const listed = (query: string) =>
    rankDeferredTools(catalog, query, { cap: 5, appNames: apps }).ranked.map((s) => s.tool.sdkName)

  it("corriger and correct reach both the time tools that change an entry", () => {
    for (const query of ["corriger temps", "correct time entry", "correct my time"]) {
      expect(listed(query).slice(0, 3)).toContain("work__task_time_correct")
      expect(listed(query).slice(0, 4)).toContain("work__task_time_set")
    }
  })

  it("a report as a PDF reaches the tool that exports one", () => {
    expect(listed("hours report pdf")).toContain("work__timesheet_export")
  })
})

describe("a rate of one kind and a rate of another", () => {
  // The tools that should lose come first, so a tie would not pass for a lead.
  const catalog: Row[] = [
    row("projects", "cost_rate_set", "Set a person's cost per hour from a date on."),
    row("projects", "cost_rates_list", "Each person's cost per hour."),
    row("projects", "reconcile_card_get", "A saved card again."),
    row("projects", "billing_terms_set", "Set how a project is billed: rate or fixed price.", [
      "rate",
    ]),
    row("projects", "reconcile_line_update", "Change one line of a saved card."),
    row("projects", "tasks_byProject", "List one project's tasks."),
    row("shop", "repeat_rate", "How many customers order again."),
    row("pay", "card_update_link", "A link to change a card."),
  ]
  const apps = new Set(catalog.map((t) => t.appName))
  const listed = (query: string) =>
    rankDeferredTools(catalog, query, { cap: 5, appNames: apps }).ranked.map((s) => s.tool.sdkName)

  it("a project's rate leads over a person's cost rate", () => {
    expect(listed("project rate")[0]).toBe("projects__billing_terms_set")
  })

  it("the cost rate still leads when the query says cost, or only sets a rate", () => {
    expect(listed("cost rate").slice(0, 2).sort()).toEqual([
      "projects__cost_rate_set",
      "projects__cost_rates_list",
    ])
    expect(listed("set cost rate")[0]).toBe("projects__cost_rate_set")
  })

  it("a word between the record's own words keeps the record's kind", () => {
    expect(listed("reconcile card line")[0]).toBe("projects__reconcile_line_update")
    const score = (query: string) =>
      scoreDeferredTools(catalog, query, { appNames: apps }).find(
        (s) => s.tool.toolName === "reconcile_line_update",
      )?.score
    expect(score("reconcile card line")).toBe(score("line reconcile card"))
  })
})

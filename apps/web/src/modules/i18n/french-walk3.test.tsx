// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The third QA walk of a French org (2026-09-23) still read English where the words come
// from DATA or from a server template: the personal agent's default name, an approval
// withdrawn by its requester, a scope decision, a projects approval's "Priority: high" and
// "In <project>", a Jira automation's note, search result types, raw app ids, a user's
// status, the seeded "Full Member" role and the usage periods. Each helper turns that data
// into the reader's language; these pin the French. The two scanners at the bottom read the
// SERVER's templates, so a template added there without a French rendering fails here.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { appLabel, entityTypeLabel, roleDisplayName } from "~/lib/app-label"
import { localizeApprovalText } from "~/modules/approvals/approval-copy"
import { localizedApprovalSubtitle } from "~/modules/approvals/decide-error"
import { kernelAttentionTitle } from "~/modules/shell/attention-row-format"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { localizeSystemLine } from "~/modules/threads/system-line"
import { localizeKnownTicketNotes } from "~/modules/tickets/known-notes"
import { I18nProvider, translatorFor } from "./i18n-context"

const fr = translatorFor("fr")
const en = translatorFor("en")
const frCtx = { t: fr, locale: "fr" }

// The helpers read the ACTIVE locale, which a mounted provider sets.
const useLocale = (locale: "fr" | "en") => {
  cleanup()
  render(() => <I18nProvider initialLocale={locale}>{null}</I18nProvider>)
}
beforeEach(() => useLocale("fr"))
afterEach(() => cleanup())

describe("the personal agent's default name", () => {
  test("reads in French; a chosen name stays as written", () => {
    expect(localizeAgentName(PERSONAL_AGENT_DISPLAY_NAME)).toBe("Agent personnel")
    expect(localizeAgentName("Oracle")).toBe("Oracle")
  })
})

describe("platform-written thread lines", () => {
  test("a withdrawn approval, from its metadata or its stored sentence", () => {
    expect(
      localizeSystemLine("Withdrawn by the requester. Reason: test retiré.", fr, {
        type: "approval-decision",
        decision: "withdrawn",
        reason: "test retiré",
      }),
    ).toBe("Retirée par le demandeur. Motif : test retiré.")
    expect(localizeSystemLine("Withdrawn by the requester.", fr)).toBe("Retirée par le demandeur.")
    expect(
      localizeSystemLine("Withdrawn by the requester. Reason: Recette 22-23/09 : retirée.", fr),
    ).toBe("Retirée par le demandeur. Motif : Recette 22-23/09 : retirée.")
    expect(localizeSystemLine("Bonjour", fr)).toBe("Bonjour")
  })
})

describe("kernel attention rows", () => {
  const row = (kind: string, summary: string) => ({ app: "kernel", kind, summary })
  test("scope decisions, mentions, files, access requests and approval decisions", () => {
    expect(kernelAttentionTitle(row("scope_request_decided", "Scope request denied"), fr)).toBe(
      "Demande d'accès refusée",
    )
    expect(kernelAttentionTitle(row("mention", "Alice mentioned you"), fr)).toBe(
      "Alice vous a mentionné",
    )
    expect(kernelAttentionTitle(row("approval_decision", "Approval request-7 rejected"), fr)).toBe(
      "Demande request-7 refusée",
    )
    // Someone marked the person away: translated only on the row that says so.
    const awayLine = "Nadia Lead marked you away on Mon 7 Dec 2026"
    expect(
      kernelAttentionTitle(
        { ...row("agent_notification", awayLine), metadata: { awayNamed: { rangeId: "r" } } },
        fr,
      ),
    ).toBe("Nadia Lead vous a indiqué absent on Mon 7 Dec 2026")
    expect(kernelAttentionTitle(row("agent_notification", awayLine), fr)).toBe(awayLine)
    // The person's own calendar asks about an event: its title comes live from the feed.
    const asked = (title?: string) => ({
      ...row("agent_notification", "Is this calendar event time off, on Mon 7 Dec 2026?"),
      metadata: {
        awayCalendar: { kind: "asked", said: "on Mon 7 Dec 2026", ...(title ? { title } : {}) },
      },
    })
    expect(kernelAttentionTitle(asked("Congés"), fr)).toBe(
      "« Congés » est-il une absence, on Mon 7 Dec 2026 ? Rien n’est compté tant que vous n’avez pas répondu Oui.",
    )
    expect(kernelAttentionTitle(asked(), fr)).toContain("Cet événement de l’agenda")
    expect(
      kernelAttentionTitle(
        {
          ...row("agent_notification", "x"),
          metadata: {
            awayCalendar: { kind: "set", said: "on Mon 7 Dec 2026", nextInLine: "Sara" },
          },
        },
        fr,
      ),
    ).toBe("Votre agenda vous indique absent on Mon 7 Dec 2026. Suivant : Sara.")
    // An app's own row is its app's business.
    expect(kernelAttentionTitle({ app: "tickets", kind: "mention", summary: "x" }, fr)).toBe("x")
  })
})

describe("a projects approval", () => {
  test("its subtitle and its lines", () => {
    expect(localizedApprovalSubtitle("In Recette App Initialisation", fr)).toBe(
      "Dans Recette App Initialisation",
    )
    expect(localizedApprovalSubtitle("Create task", fr)).toBe("Créer une tâche")
    expect(localizeApprovalText("Priority: high", frCtx)).toBe("Priorité : haute")
    expect(localizeApprovalText("Assignee: Dana", frCtx)).toBe("Responsable : Dana")
    expect(localizeApprovalText("Due: 2026-10-01", frCtx)).toBe("Échéance : 2026-10-01")
    expect(localizeApprovalText("(no description)", frCtx)).toBe("(aucune description)")
  })
})

describe("imported automation notes", () => {
  test("the JSM reopen sentence reads in French, the rest of the note as written", () => {
    expect(
      localizeKnownTicketNotes(
        "Reopened automatically — customer replied after the request was resolved.",
        fr,
      ),
    ).toBe("Rouvert automatiquement : le client a répondu après la résolution de la demande.")
    expect(localizeKnownTicketNotes("Client relancé par téléphone.", fr)).toBe(
      "Client relancé par téléphone.",
    )
  })
})

describe("identifiers the server hands over", () => {
  test("app ids, search types, the seeded role, a user's status and usage periods", () => {
    expect(appLabel("invoicing", fr)).toBe("Facturation")
    expect(appLabel("monitoring", fr, "Monitoring")).toBe("Supervision")
    expect(appLabel("some-new-app", fr, "Some New App")).toBe("Some New App")
    expect(entityTypeLabel("task", fr)).toBe("tâche")
    expect(entityTypeLabel("widget", fr)).toBe("widget")
    expect(roleDisplayName("Full Member", fr)).toBe("Membre à part entière")
    expect(roleDisplayName("support-business-analyst", fr)).toBe("support-business-analyst")
    expect(fr("kernel.settingsUi.userStatus.active")).toBe("Actif")
    expect(fr("kernel.settingsUi.usagePeriod.7d")).toBe("7 jours")
    useLocale("en")
    expect(appLabel("monitoring", en, "Monitoring")).toBe("Monitoring")
    expect(roleDisplayName("Full Member", en)).toBe("Full Member")
  })
})

// ---------------------------------------------------------------------------------------
// SCANNERS: the server's own templates, read from source.
// ---------------------------------------------------------------------------------------

const API = join(__dirname, "..", "..", "..", "..", "api", "src")

describe("scanner: every kernel attention template has a French rendering", () => {
  const src = readFileSync(join(API, "modules", "attention", "kernel-translations.ts"), "utf8")
  const entries = [
    ...src.matchAll(/\n {4}kind: "([a-z_]+)",[\s\S]*?\n {4}summary: "([^"]+)"/g),
  ].map((m) => ({ kind: m[1] ?? "", template: m[2] ?? "" }))
  // Pure data: the row quotes a message or an agent's own words.
  const DATA_ONLY = new Set(["{{payload.data.preview}}", "{{payload.data.summary}}"])
  const sample = (template: string) =>
    template
      .replace("{{actor.name}}", "Alice")
      .replace("{{payload.data.requesterLabel}}", "Alice")
      .replace("{{payload.data.handle}}", "request-3")
      .replace("{{payload.data.parentLabel}}", "Roadmap")
      .replace("{{payload.data.title}}", "tickets")
      .replace("{{payload.data.status}}", "denied")

  test("the scan found the templates", () => {
    expect(entries.length).toBeGreaterThanOrEqual(6)
  })
  for (const { kind, template } of entries) {
    if (DATA_ONLY.has(template)) continue
    test(`${kind}: "${template}"`, () => {
      const status = kind === "approval_decision" ? "rejected" : "denied"
      const english = sample(template).replace("denied", status)
      const french = kernelAttentionTitle({ app: "kernel", kind, summary: english }, fr)
      expect(french).not.toBe(english)
    })
  }
})

describe("scanner: every projects approval line has a French rendering", () => {
  const src = readFileSync(join(API, "apps", "projects", "summarizers.ts"), "utf8")
  const prefixes = [
    ...new Set([...src.matchAll(/lines\.push\(`([A-Z][A-Za-z ]+): \$\{/g)].map((m) => m[1])),
  ]
  test("the scan found the lines", () => {
    expect(prefixes).toContain("Priority")
  })
  for (const prefix of prefixes) {
    test(`"${prefix}: …"`, () => {
      const english = `${prefix}: x`
      expect(localizeApprovalText(english, frCtx)).not.toBe(english)
    })
  }
})

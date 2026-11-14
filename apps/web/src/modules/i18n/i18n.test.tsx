// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveLocale, SHIPPED_LOCALES } from "@liaison/shared"
import { render } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import { scanHardcodedStrings, untranslatedTableReads } from "./hardcoded-scan"
import { I18nProvider, useI18n } from "./i18n-context"

describe("locale resolution", () => {
  test("stored preference wins", () => {
    expect(resolveLocale("fr", "en-US")).toBe("fr")
  })
  test("navigator fallback when no stored pref", () => {
    expect(resolveLocale(null, "fr-FR")).toBe("fr")
  })
  test("falls back to en for an unshipped navigator locale", () => {
    expect(resolveLocale(null, "de-DE")).toBe("en")
  })
  test("falls back to en for an unshipped stored value", () => {
    expect(resolveLocale("de", "de-DE")).toBe("en")
  })
})

function Probe() {
  const { t } = useI18n()
  return (
    <>
      <span data-testid="k">{t("kernel.common.save")}</span>
      <span data-testid="missing">{t("kernel.does.not.exist")}</span>
    </>
  )
}

function EnOnlyProbe() {
  const { t } = useI18n()
  return <span data-testid="enonly">{t("kernel.enonly.key")}</span>
}

describe("t() rendering + fallback", () => {
  test("renders fr kernel string when locale is fr", () => {
    const r = render(() => (
      <I18nProvider initialLocale="fr">
        <Probe />
      </I18nProvider>
    ))
    expect(r.getByTestId("k").textContent).toBe("Enregistrer")
  })
  test("renders en kernel string when locale is en", () => {
    const r = render(() => (
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>
    ))
    expect(r.getByTestId("k").textContent).toBe("Save")
  })
  test("missing key renders the key path, not blank", () => {
    const r = render(() => (
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>
    ))
    expect(r.getByTestId("missing").textContent).toBe("kernel.does.not.exist")
  })
  test("per-key fallback: key only in en still resolves under fr", () => {
    const r = render(() => (
      <I18nProvider initialLocale="fr">
        <EnOnlyProbe />
      </I18nProvider>
    ))
    expect(r.getByTestId("enonly").textContent).toBe("English only value")
  })
})

function FmtProbe() {
  const { fmtNumber, fmtCurrency } = useI18n()
  return (
    <>
      <span data-testid="num">{fmtNumber(1234.5)}</span>
      <span data-testid="cur">{fmtCurrency(10, "EUR")}</span>
    </>
  )
}

describe("Intl formatting (I3)", () => {
  test("number/currency localize per active locale", () => {
    const en = render(() => (
      <I18nProvider initialLocale="en">
        <FmtProbe />
      </I18nProvider>
    ))
    const enNum = en.getByTestId("num").textContent
    const enCur = en.getByTestId("cur").textContent
    en.unmount()
    const fr = render(() => (
      <I18nProvider initialLocale="fr">
        <FmtProbe />
      </I18nProvider>
    ))
    expect(enNum).toBe(new Intl.NumberFormat("en").format(1234.5))
    expect(fr.getByTestId("num").textContent).toBe(new Intl.NumberFormat("fr").format(1234.5))
    expect(fr.getByTestId("num").textContent).not.toBe(enNum)
    expect(fr.getByTestId("cur").textContent).not.toBe(enCur)
  })
})

function ReactiveProbe() {
  const { t, setLocale } = useI18n()
  return (
    <>
      <span data-testid="rk">{t("kernel.common.cancel")}</span>
      <button type="button" data-testid="switch" onClick={() => setLocale("fr")}>
        fr
      </button>
    </>
  )
}

describe("reactive locale switch (no remount)", () => {
  test("setLocale flips t() output without remount", () => {
    const r = render(() => (
      <I18nProvider initialLocale="en">
        <ReactiveProbe />
      </I18nProvider>
    ))
    expect(r.getByTestId("rk").textContent).toBe("Cancel")
    ;(r.getByTestId("switch") as HTMLButtonElement).click()
    expect(r.getByTestId("rk").textContent).toBe("Annuler")
  })
})

describe("the document language follows the UI", () => {
  test("<html lang> is the resolved locale and follows a switch", () => {
    document.documentElement.lang = "en"
    const r = render(() => (
      <I18nProvider initialLocale="fr">
        <ReactiveProbe />
      </I18nProvider>
    ))
    expect(document.documentElement.lang).toBe("fr")
    r.unmount()
    const en = render(() => (
      <I18nProvider initialLocale="en">
        <ReactiveProbe />
      </I18nProvider>
    ))
    expect(document.documentElement.lang).toBe("en")
    ;(en.getByTestId("switch") as HTMLButtonElement).click()
    expect(document.documentElement.lang).toBe("fr")
  })
})

describe("add-a-stub-locale is file-only for the locale list (I7)", () => {
  test("SHIPPED_LOCALES + dictionaries are generated from the locales/ tree", () => {
    expect(SHIPPED_LOCALES).toContain("en")
    expect(SHIPPED_LOCALES).toContain("fr")
    // SHIPPED_LOCALES and the dictionary map are DERIVED from the
    // locales/<x>/ directory tree (generated _generated.ts, predev/prebuild).
    // Adding a locale is truly file-only — no hand code edit in locales.ts or
    // dictionaries.ts. End-to-end proof: scripts/i18n-gen-dictionaries.test.ts.
    expect(resolveLocale("en", null)).toBe("en")
  })
})

describe("en/fr key parity (catches wrapped-but-never-translated)", () => {
  // The fr key set must equal the en key set per namespace, except an
  // explicitly-allowlisted en-only set (the i18n test fixture key).
  const EN_ONLY_ALLOWLIST = new Set<string>(["kernel.enonly.key"])

  function flattenKeys(obj: Record<string, unknown>, prefix: string, out: Set<string>) {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === "object" && !Array.isArray(v)) {
        flattenKeys(v as Record<string, unknown>, path, out)
      } else {
        out.add(path)
      }
    }
  }

  test("every en namespace has a matching fr namespace with identical key sets", () => {
    const enMods = import.meta.glob("../../../../../packages/shared/src/i18n/locales/en/*.json", {
      eager: true,
    }) as Record<string, { default: Record<string, unknown> }>
    const frMods = import.meta.glob("../../../../../packages/shared/src/i18n/locales/fr/*.json", {
      eager: true,
    }) as Record<string, { default: Record<string, unknown> }>

    const nsOf = (p: string) => p.split("/").pop()?.replace(".json", "") ?? p
    const frByNs = new Map<string, Record<string, unknown>>()
    for (const [p, m] of Object.entries(frMods)) frByNs.set(nsOf(p), m.default)

    expect(Object.keys(enMods).length).toBeGreaterThan(0)

    for (const [p, m] of Object.entries(enMods)) {
      const ns = nsOf(p)
      const enKeys = new Set<string>()
      flattenKeys(m.default, ns, enKeys)
      const frDict = frByNs.get(ns)
      expect(frDict, `fr namespace missing for ${ns}`).toBeDefined()
      const frKeys = new Set<string>()
      flattenKeys(frDict as Record<string, unknown>, ns, frKeys)
      const enMinusAllowlist = [...enKeys].filter((k) => !EN_ONLY_ALLOWLIST.has(k)).sort()
      expect([...frKeys].sort()).toEqual(enMinusAllowlist)
    }
  })
})

/**
 * THE DESKTOP TWINS (`copy()` in NotificationBanner, and formerly AttentionPreferences).
 *
 * Both components pick their copy by appending "App" to a base key when the
 * page is wrapped by the desktop shell, and `t()` answers a miss with the KEY
 * ITSELF: a twin that was never added renders the literal string
 * "kernel.desktopNotificationsHintApp" at the user, in both locales, and
 * nothing else would have said so.
 */
describe("desktop copy twins exist in every locale", () => {
  const BASE_KEYS = [
    "desktopNotificationsBannerHint",
    "desktopNotificationsBlocked",
    "desktopNotificationsBlockedToast",
    "desktopNotificationsHint",
    "desktopNotificationsUnsupported",
  ]

  test("every key copy() can ask for has an App twin in en and fr", () => {
    const mods = import.meta.glob("../../../../../packages/shared/src/i18n/locales/*/kernel.json", {
      eager: true,
    }) as Record<string, { default: Record<string, unknown> }>
    const locales = Object.entries(mods)
    expect(locales.length).toBeGreaterThanOrEqual(2)

    for (const [path, mod] of locales) {
      const locale = path.split("/").at(-2)
      for (const base of BASE_KEYS) {
        const twin = mod.default[`${base}App`]
        expect(typeof twin, `${locale}: ${base}App is missing`).toBe("string")
        expect(`${locale} ${base}App: ${(twin as string).length > 0}`).toBe(
          `${locale} ${base}App: true`,
        )
        // The base key is what a browser still reads, so both halves are real.
        expect(typeof mod.default[base], `${locale}: ${base} is missing`).toBe("string")
      }
    }
  })
})

describe("placeholders use the double brace form the resolver interpolates", () => {
  // A `{count}` with single braces is rendered verbatim to the user ("Show
  // {count} request(s)" shipped once). The resolver only substitutes `{{name}}`.
  test("no locale string carries a single brace placeholder", () => {
    const mods = import.meta.glob("../../../../../packages/shared/src/i18n/locales/*/*.json", {
      eager: true,
    }) as Record<string, { default: Record<string, unknown> }>
    const offenders: string[] = []
    const walk = (file: string, obj: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = path ? `${path}.${k}` : k
        if (typeof v === "string") {
          if (/(^|[^{])\{[a-zA-Z_]+\}([^}]|$)/.test(v)) offenders.push(`${file}: ${key}`)
        } else if (v && typeof v === "object") walk(file, v as Record<string, unknown>, key)
      }
    }
    for (const [file, mod] of Object.entries(mods)) walk(file, mod.default, "")
    expect(offenders).toEqual([])
  })
})

/**
 * A FRENCH ORG READ HALF ITS UI IN ENGLISH (2026-09 walk): "Reply", "Send
 * reply", "SLA breached", "Approve", "Every Monday at 8:30 AM", "Personal
 * agent", while every key that existed had its French twin. The parity test
 * above only compares the catalogs, so copy that never reached a catalog, and
 * keys requested but never written ("kernel.homeCluster.task_overdue"), passed.
 * These two guards close both holes for the surfaces a customer works in.
 */
function flatKeys(obj: Record<string, unknown>, prefix: string, out: Set<string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatKeys(v as Record<string, unknown>, path, out)
    } else out.add(path)
  }
}

function englishKeys(): Set<string> {
  const mods = import.meta.glob("../../../../../packages/shared/src/i18n/locales/en/*.json", {
    eager: true,
  }) as Record<string, { default: Record<string, unknown> }>
  const keys = new Set<string>()
  for (const [p, m] of Object.entries(mods)) {
    flatKeys(m.default, p.split("/").pop()?.replace(".json", "") ?? p, keys)
  }
  return keys
}

/** Every web source file, raw, keyed by its path under src/. */
function webSources(): Array<[string, string]> {
  const mods = import.meta.glob(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
  return (
    Object.entries(mods)
      .filter(([p]) => !p.includes("/tests/"))
      // Vite keys each file by its shortest relative path ("../tickets/x.tsx",
      // "../../App.tsx"); resolve them all to "src/...".
      .map(([p, src]) => [new URL(p, "file:///root/src/modules/i18n/").pathname.slice(6), src])
  )
}

describe("every key the web asks for exists in the catalog", () => {
  test("literal t() keys resolve in en (and so, by parity, in fr)", () => {
    const keys = englishKeys()
    const call = /(?<![\w$])(?:t|tNow|englishT|\.t)\(\s*"([a-zA-Z][\w-]*\.[\w.-]+)"/g
    const missing: string[] = []
    for (const [file, src] of webSources()) {
      for (const m of src.matchAll(call)) {
        if (!keys.has(m[1]!)) missing.push(`${file}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  // The Home feed builds these keys from an item's kind, so no literal names
  // them: a kind without its catalog words logged "missing translation key"
  // and printed the raw English fallback to a French reader.
  test("every attention kind has its Home words in the catalog", () => {
    const keys = englishKeys()
    const manifests = import.meta.glob("../../../../../bundled-apps/*/app.manifest.json", {
      eager: true,
    }) as Record<string, { default: unknown }>
    const manifestKinds = new Set<string>()
    for (const m of Object.values(manifests)) {
      for (const hit of JSON.stringify(m.default).matchAll(/"kind":"([a-z_]+:[a-z_.]+)"/g)) {
        const tail = hit[1]!.slice(hit[1]!.indexOf(":") + 1)
        manifestKinds.add(tail.includes(".") ? tail.slice(tail.lastIndexOf(".") + 1) : tail)
      }
    }
    // A core app writes its kinds from its own service code, under a `*_KIND` constant.
    const coreSources = import.meta.glob("../../../../api/src/apps/*/service/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
    for (const [file, src] of Object.entries(coreSources)) {
      if (file.includes(".test.")) continue
      for (const hit of src.matchAll(/_KIND = "([a-z_]+:[a-z_.]+)"/g)) {
        const tail = hit[1]!.slice(hit[1]!.indexOf(":") + 1)
        manifestKinds.add(tail.includes(".") ? tail.slice(tail.lastIndexOf(".") + 1) : tail)
      }
    }
    expect(manifestKinds.has("first_on")).toBe(true)
    const kernelKinds = [
      "awaiting_agent",
      "unassigned",
      "nudge_due",
      "followup_due",
      "sla_risk",
      "task_overdue",
      "task_due_this_week",
      "task_blocked",
      "thread_reply",
      "file_shared",
      "mention",
      "agent_notification",
      "system_alert",
      "scope_request",
      "scope_request_decided",
      "approval_decision",
      "admin_action",
      "knowledge_review",
    ]
    expect(manifestKinds.has("critical")).toBe(true)
    const missing: string[] = []
    for (const kind of [...kernelKinds, ...manifestKinds]) {
      for (const form of ["one", "other"]) {
        const key = `kernel.homeKind.${kind}.${form}`
        if (!keys.has(key)) missing.push(key)
      }
    }
    for (const kind of ["task_overdue", "sla_risk", "critical", "warning"]) {
      if (!keys.has(`kernel.homeCluster.${kind}`)) missing.push(`kernel.homeCluster.${kind}`)
    }
    expect(missing).toEqual([])
  })
})

describe("no hardcoded English in the surfaces a customer works in", () => {
  const SURFACES = [
    "tickets",
    "mail",
    "knowledge",
    "projects",
    "approvals",
    "agent",
    "settings",
    "shell",
    "threads",
    "calendar",
    // Second French walk (2026-09-23): each of these still spoke English.
    "contacts",
    "files",
    "search",
    "auth",
    "mcp-manager",
    // The desktop app's own controls (2026-09-23): a French user running an
    // agent on her machine read "This machine", "Permission needed", "Allow".
    "desktop",
    // The mailbox encryption screens (2026-09-28): the unlock, enrollment and
    // security pages still spoke English in multi-line paragraphs.
    "mailbox",
  ]

  /**
   * What stays literal, and why. Anything new in these surfaces goes through
   * the catalog instead of this list.
   */
  const ALLOWED = new Set([
    // The activity bar reads `labelKey`; this is the stored fallback label.
    "src/modules/agent/agent-app.ts::Agents",
    // A transport error string, only shown when the server sent none.
    "src/modules/shell/attention-store.ts::fetch failed",
    // Key caps read the same in French.
    "src/modules/shell/key-label.ts::Ctrl",
    "src/modules/shell/key-label.ts::Win",
    "src/modules/shell/key-label.ts::Alt",
    // The no-locale English default of a helper every surface passes a locale to.
    "src/modules/shell/attention-row-format.ts::just now",
    // The Home tab's stored fallback; the tab strip names it from the catalog.
    "src/modules/shell/tab-store.ts::Home",
    // Stable English data hooks (`data-kind-label`); the badge renders labelKey.
    "src/modules/shell/message-kind.ts::From customer",
    "src/modules/shell/message-kind.ts::Sent to customer",
    "src/modules/shell/message-kind.ts::Sending",
    "src/modules/shell/message-kind.ts::Internal note",
    // The product's name, the same in every language.
    "src/modules/auth/Login.tsx::Liaison",
    "src/modules/auth/Register.tsx::Liaison",
    // The contacts tab's stored fallback; the tab strip names it from the catalog.
    "src/modules/contacts/ContactsSidebar.tsx::Contacts",
    // The company list and contact list tabs' stored fallbacks; the manifest's labelKey names them.
    "src/modules/contacts/company-visuals.ts::Companies",
    "src/modules/contacts/company-visuals.ts::Contacts",
    // Fixture data of the browser-baseline test helper; never mounted by the app.
    "src/modules/desktop/baseline-render.tsx::Baseline thread",
    // The `label` stored on a new mailbox wrap row (data, like the enrollment's
    // own wrapInput labels); every screen names a wrap by its type through
    // wrapLabel and the catalog, never by this stored label.
    "src/modules/mailbox/MailboxUnlock.tsx::Mailbox password",
    "src/modules/mailbox/MailboxUnlock.tsx::Passkey",
    "src/modules/mailbox/MailboxSecuritySettings.tsx::Mailbox password",
    "src/modules/mailbox/mailbox-store.ts::Mailbox password",
    // Worker protocol messages: the page acts on the code and says it in its own
    // catalog copy (MailboxUnlock FAILURE_KEYS); this text reaches a screen at
    // most as the technical detail inside a translated sentence.
    "src/modules/mailbox/crypto-worker-handler.ts::the mailbox worker could not complete that operation",
    "src/modules/mailbox/crypto-worker-handler.ts::unknown operation",
    // The synthetic vocabulary of a developer benchmark script, not the app.
    "src/modules/mailbox/search-index/measure-index-size.ts::w word",
  ])

  test("every user-visible literal goes through t()", () => {
    const sources = webSources()
    // The glob is the whole guard: an empty read passes every assertion below.
    expect(sources.some(([f]) => f === "src/modules/tickets/TicketComposer.tsx")).toBe(true)
    const found: string[] = []
    for (const [file, src] of sources) {
      const surface = file.split("/")[2]
      if (!file.startsWith("src/modules/") || !SURFACES.includes(surface ?? "")) continue
      // Test fixtures (`__fixtures__/`) are data a test mounts, never the app.
      if (file.includes("/__fixtures__/")) continue
      for (const hit of scanHardcodedStrings(file, src)) {
        const id = `${file}::${hit.text}`
        if (!ALLOWED.has(id)) found.push(`${file}:${hit.line}: ${hit.text}`)
      }
    }
    expect(found).toEqual([])
  })

  test("no module label table reaches the screen past t()", () => {
    // A table of English labels declared once and read raw at its render site
    // (a sub-run's "Running", a task's "High") passes the literal scan above.
    const TABLE_ALLOWED = new Set([
      // A brand, the same in every language.
      "src/modules/projects/LinkedDocuments.tsx::KIND_LABEL.source_link",
      // Stable English data hooks (`data-kind-label`); the badge renders labelKey.
      "src/modules/shell/message-kind.ts::OUTBOUND",
      "src/modules/shell/message-kind.ts::OUTBOUND_PENDING",
      "src/modules/shell/message-kind.ts::NOTE",
      "src/modules/shell/message-kind.ts::INBOUND",
      // The title of the thread this opens with the agent (stored data, not
      // chrome). Owned by the knowledge module's current rework.
      "src/modules/knowledge/KnowledgeHome.tsx::CREATE_FROM_LABEL",
      // Plan tier names are product names.
      "src/modules/settings/PlanSettings.tsx::TIER_LABELS[managed.tier]",
      "src/modules/settings/UsageSettings.tsx::TIER_LABELS[b().tier]",
      // Shell commands to type, the same in every language.
      "src/modules/settings/computers/RemoteReposSection.tsx::LOGIN[source.tool]",
    ])
    const found: string[] = []
    for (const [file, src] of webSources()) {
      const surface = file.split("/")[2]
      if (!file.startsWith("src/modules/") || !SURFACES.includes(surface ?? "")) continue
      for (const hit of untranslatedTableReads(file, src)) {
        if (!TABLE_ALLOWED.has(`${file}::${hit.text}`))
          found.push(`${file}:${hit.line}: ${hit.text}`)
      }
    }
    expect(found).toEqual([])
    // And it sees the shape: a table read raw, and the same read through t().
    const probe = `
      const LABEL: Record<string, string> = { a: "New quote" }
      export const C = (p: { k: string }) => (
        <div>{LABEL[p.k]}{t(LABEL[p.k])}{LABEL[p.k] ?? t("x.y")}</div>
      )`
    expect(untranslatedTableReads("c.tsx", probe).map((h) => h.text)).toEqual([
      "LABEL[p.k]",
      "LABEL[p.k]",
    ])
  })

  test("the scanner catches the shapes that slipped through the line lint", () => {
    const src = `
      export function C(props: { busy: boolean }) {
        addToast({ message: "Preferences saved", type: "success" })
        return (
          <div title="Close tab">
            <span>
              Send reply
            </span>
            {props.busy ? "Saving..." : "Save"}
            {t("kernel.common.save")}
          </div>
        )
      }`
    const texts = scanHardcodedStrings("c.tsx", src).map((h) => h.text)
    expect(texts).toEqual(["Preferences saved", "Close tab", "Send reply", "Saving...", "Save"])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// InvoicingSettings F6 tests — pure-logic surfaces only (bun:test).
//
// Pinned:
//   - manifest publishes views.settings[] with { id, label, href, component }
//     matching the shopify-shape (resolves review I12).
//   - emitVatWarning() flags EU-country issuers with no VAT id.
//   - isInvalidIban() flags IBANs with wrong checksum / wrong length.
//   - canDelete() blocks deletion of issuer profiles with references.
//   - canArchive() always allowed; canCreate() validates required fields.
//   - source emits the issuer profiles panel by testid (the shop mappings,
//     tax regimes and HS codes are read-only list blocks of the page).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import {
  canCreate,
  canDelete,
  emitVatWarning,
  InvoicingIssuerProfiles,
  type IssuerProfileDraft,
  isInvalidIban,
  LOGO_ACCEPTED_MIME_TYPES,
  LOGO_MAX_BYTES,
  validateLogoFile,
} from "./settings"

const source = readFileSync(join(import.meta.dir, "settings.tsx"), "utf-8")

const validIssuer = (over: Partial<IssuerProfileDraft> = {}): IssuerProfileDraft => ({
  legal_name: "Fabrikam SAS",
  country: "FR",
  vat_id: "FR12345678901",
  default_currency: "EUR",
  default_language: "fr",
  default_payment_terms_days: 30,
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  iban: "FR7630006000011234567890189",
  ...over,
})

describe("InvoicingIssuerProfiles (Phase 17 F6)", () => {
  it("exports a Component", () => {
    expect(typeof InvoicingIssuerProfiles).toBe("function")
  })

  // The declarative settings page (/settings/apps/invoicing): the issuer
  // profiles block, three read-only lists, the e-invoicing fields over a tool
  // pair whose get answers exactly what the set takes.
  it("manifest declares the settings page and no views.settings", () => {
    const m = manifest as unknown as {
      views?: { settings?: unknown }
      tools: Record<string, { readOnly?: boolean; agentVisible?: boolean; gated?: boolean }>
      settings: { sections: Array<{ id: string; blocks: Array<Record<string, unknown>> }> }
    }
    expect(m.views?.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => s.id)).toEqual([
      "issuers",
      "shop-mappings",
      "tax-regimes",
      "hs-codes",
      "einvoicing",
    ])
    const blocks = m.settings.sections.flatMap((s) => s.blocks)
    expect(blocks.filter((b) => b.block === "custom").map((b) => b.component)).toEqual([
      "InvoicingIssuerProfiles",
      "InvoicingIssuerStreams",
      "EinvoicingRegistration",
    ])
    // Read-only lists: a list tool and nothing else.
    for (const list of blocks.filter((b) => b.block === "list")) {
      expect(Object.keys(list.ops as object)).toEqual(["list"])
      expect(m.tools[(list.ops as { list: string }).list]?.readOnly).toBe(true)
    }
    const fields = blocks.filter((b) => b.block === "field")
    expect(fields.map((f) => [f.key, f.type])).toEqual([
      ["provider_app", "select"],
      ["cutover_date", "date"],
      ["send_enabled", "toggle"],
      ["book_enabled", "toggle"],
    ])
    for (const f of fields) {
      expect(f.source).toEqual({
        tool: { get: "einvoicing_settings_values", set: "einvoicing_settings_set" },
      })
    }
    expect(fields[0]?.optionsTool).toBe("einvoicing_provider_options")
    // The page's own reads are read-only, ungated, and not for agents.
    for (const name of ["einvoicing_settings_values", "einvoicing_provider_options"]) {
      expect(m.tools[name]).toMatchObject({ readOnly: true, agentVisible: false })
      expect(m.tools[name]?.gated).toBeUndefined()
    }
  })

  it("emitVatWarning flags EU-country issuer without VAT id", () => {
    expect(emitVatWarning(validIssuer({ country: "DE", vat_id: null }))).toBe(true)
    expect(emitVatWarning(validIssuer({ country: "DE", vat_id: "DE123" }))).toBe(false)
    // Non-EU → no warning regardless
    expect(emitVatWarning(validIssuer({ country: "US", vat_id: null }))).toBe(false)
  })

  it("isInvalidIban flags malformed IBANs (length + alphanumeric)", () => {
    // valid French IBAN (27 chars, alnum)
    expect(isInvalidIban("FR7630006000011234567890189")).toBe(false)
    // too short
    expect(isInvalidIban("FR123")).toBe(true)
    // non-alphanumeric chars rejected
    expect(isInvalidIban("FR76 3000 6000 ABCDEF X@@@@@1")).toBe(true)
    // empty / undefined → not flagged (user just hasn't filled it)
    expect(isInvalidIban("")).toBe(false)
    expect(isInvalidIban(null)).toBe(false)
  })

  it("canDelete blocks deletion when references exist", () => {
    expect(canDelete({ reference_count: 0 })).toBe(true)
    expect(canDelete({ reference_count: 5 })).toBe(false)
  })

  it("canCreate validates required fields", () => {
    expect(canCreate(validIssuer())).toBe(true)
    expect(canCreate(validIssuer({ legal_name: "" }))).toBe(false)
    expect(canCreate(validIssuer({ country: "" }))).toBe(false)
    expect(canCreate(validIssuer({ default_currency: "" }))).toBe(false)
  })

  it("source emits the issuer profiles panel with its testid, and only that panel (E2E pickup)", () => {
    expect(source).toContain("settings-panel-issuer-profiles")
    expect(source).not.toContain("settings-panel-shop-mappings")
    expect(source).not.toContain("settings-panel-tax-regimes")
    expect(source).not.toContain("settings-panel-hs-code-library")
  })

  it("source emits the VAT warning copy when issuer is EU + no VAT id", () => {
    expect(source).toContain("VAT ID is required by law")
  })

  it("source emits the IBAN soft-warn copy", () => {
    expect(source).toContain("IBAN looks invalid")
  })

  it("source emits the deletion-blocked copy when references exist", () => {
    expect(source).toContain("Cannot delete: referenced by")
  })

  // ── Logo upload ───────────────────────────────────────────────────────
  describe("Logo upload", () => {
    it("validateLogoFile accepts PNG/JPEG under the size cap", () => {
      expect(validateLogoFile({ type: "image/png", size: 1024 })).toEqual({ ok: true })
      expect(validateLogoFile({ type: "image/jpeg", size: LOGO_MAX_BYTES })).toEqual({ ok: true })
    })

    it("validateLogoFile rejects a disallowed mime type", () => {
      const r = validateLogoFile({ type: "image/gif", size: 1024 })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/PNG or JPEG/)
    })

    it("validateLogoFile rejects a file over 2MB", () => {
      const r = validateLogoFile({ type: "image/png", size: LOGO_MAX_BYTES + 1 })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/2MB/)
    })

    it("LOGO_ACCEPTED_MIME_TYPES is exactly png + jpeg", () => {
      expect(LOGO_ACCEPTED_MIME_TYPES).toEqual(["image/png", "image/jpeg"])
    })

    it("source emits the logo row testids", () => {
      expect(source).toContain("settings-logo-thumb")
      expect(source).toContain("settings-logo-input")
      expect(source).toContain("settings-logo-remove")
    })

    it("source hints to save the profile first for a brand-new (unsaved) profile", () => {
      expect(source).toContain("Save the profile first, then upload a logo.")
    })

    it("source uploads via presign → PUT → confirm, then persists logo_file_id via settings_issuer_profile_update", () => {
      expect(source).toContain("/api/files/upload-url")
      expect(source).toContain("/api/files/confirm")
      expect(source).toMatch(/method:\s*"PUT"/)
      expect(source).toContain('"settings_issuer_profile_update"')
      expect(source).toContain("logo_file_id: fileId")
    })

    it("source removes the logo by setting logo_file_id to null via settings_issuer_profile_update", () => {
      expect(source).toContain("logo_file_id: null")
    })

    it("every upload/confirm fetch goes through the host fetch, which carries the session auth", () => {
      expect(source).toContain('hostFetch<UploadUrlResponse>("/api/files/upload-url"')
      expect(source).toContain('hostFetch<{ id: string }>("/api/files/confirm"')
    })
  })

  // ── prices_include_tax ─────────────────────────────────────────────────
  describe("Prices include tax", () => {
    it("source emits the toggle with its testid and label", () => {
      expect(source).toContain("issuer-prices-include-tax")
      expect(source).toContain("Prices include tax")
      expect(source).toContain('type="checkbox"')
    })

    it("source emits the helper text pointing at the Shopify tax setting", () => {
      expect(source).toContain("Match your Shopify tax setting.")
      expect(source).toContain("tax inclusive")
    })

    it("source binds the toggle to the draft's prices_include_tax", () => {
      expect(source).toContain("checked={!!d().prices_include_tax}")
      expect(source).toContain("prices_include_tax: e.currentTarget.checked")
    })

    it("a new profile starts with prices_include_tax off", () => {
      expect(source).toContain("prices_include_tax: false")
    })
  })
})

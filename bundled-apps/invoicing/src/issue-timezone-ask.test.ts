// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The time zone is asked once per issuer: the first issue on a profile nobody gave a zone (and
// whose organization has none either) raises one Home line to the holders of the settings scope.
// Issuing is never blocked and nothing issued changes.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FICTIONAL_SIRENS, FR_SELLER_IDENTITY } from "./einvoicing/test-fixtures"
import { type IssueCtx, type IssueInput, issueDocument } from "./issue"
import { settingsIssuerProfileUpdate } from "./mutations"
import type { MutationsCtx } from "./mutations/shared"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  events: { emits: string[] }
  attention: {
    translations: Array<{
      event: string
      kind: string
      when?: { op: string; path: string }
      resolveWhen?: { always?: boolean }
      recipients: { kind: string; scope: string }
    }>
  }
}

type Emitted = { entity: string; action: string; entityId?: string; data?: unknown }

function makeCtx(opts?: { orgZone?: string; seed?: Array<Record<string, unknown>> }) {
  const db = createMockDb({
    seed: {
      einvoicing_settings: [{ gate_mode: "enforce", gate_mode_source: "config" }],
      counterparty_identities: [
        {
          contact_id: "contact-fr-1",
          customer_kind: "business",
          siren: FICTIONAL_SIRENS[0],
          registry_name: "Acme France SAS",
          registry_status: "A",
          source: "registry",
          confirmed_via: "auto",
        },
      ],
      ...(opts?.seed ? { documents: opts.seed } : {}),
    },
  })
  const emitted: Emitted[] = []
  const ctx: IssueCtx = {
    getUserId: async () => "user-1",
    db,
    time: testTime(opts?.orgZone ?? "UTC"),
    pdf: {
      async render() {
        return {
          file_id: "file-1",
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: "msg-1" }) },
    emit: async (e) => {
      emitted.push({ entity: e.entity, action: e.action, entityId: e.entityId, data: e.data })
    },
  }
  return { ctx, db, emitted }
}

function issuer(extra: Record<string, unknown> = {}) {
  return {
    id: "issuer-1",
    legal_name: "Maison Nord SARL",
    country: "FR",
    vat_id: "FR12345678901",
    address: "1 rue de Test, 75001 Paris",
    iban: "FR7630006000011234567890189",
    swift_bic: "BNPAFRPP",
    bank_name: "BNP Test",
    default_language: "fr" as const,
    prefix_invoice: "INV-{YYYY}-",
    prefix_quote: "QUO-{YYYY}-",
    prefix_proforma: "PRO-{YYYY}-",
    prefix_po: "PO-{YYYY}-",
    ...FR_SELLER_IDENTITY,
    ...extra,
  }
}

const counterparty = {
  contact_id: "contact-fr-1",
  legal_name: "Acme France SAS",
  country: "FR",
  vat_id: "FR55555555555",
  address: "10 rue Domestic, 75001 Paris",
  email: "compta@acmefrance.example",
  customer_kind: "business" as const,
  billing_line1: "10 rue Domestic",
  billing_postcode: "75001",
  billing_city: "Paris",
}

function draft(): IssueInput["draft"] {
  return {
    currency: "EUR",
    incoterm: "DAP",
    year_of_issue: 2026,
    issued_at: "2026-05-15",
    due_at: "2026-06-14",
    external_refs: {},
    lines: [
      {
        position: 1,
        description: "Consulting",
        quantity: "1",
        unit_price_minor: 10000n,
        line_kind: "service",
        product_source: null,
        external_id: null,
      },
    ],
  }
}

async function issueOn(ctx: IssueCtx, issuerRow: ReturnType<typeof issuer>) {
  return issueDocument(ctx, {
    type: "invoice",
    operation_category: "services",
    issuer: issuerRow,
    counterparty,
    draft: draft(),
  })
}

const asks = (emitted: Emitted[]) =>
  emitted.filter((e) => e.entity === "issuer_profile" && e.action === "timezone_unset")

describe("the issuer time zone is asked once", () => {
  test("the first issue on a UTC issuer raises one line, the second none, an answer stops it, and a profile with a zone never raises it", async () => {
    // red: raise on every issue and the second issue below raises a second line.
    const unset = makeCtx()
    const first = await issueOn(unset.ctx, issuer())
    expect(first.number).toBe("INV-2026-0001")
    expect(asks(unset.emitted)).toHaveLength(1)
    expect(asks(unset.emitted)[0]).toMatchObject({
      entityId: "issuer-1",
      data: {
        issuer_profile_id: "issuer-1",
        legal_name: "Maison Nord SARL",
        document_id: expect.any(String),
      },
    })
    // Issuing is not blocked and nothing issued changed: the line comes after the number.
    expect(unset.db.__all("documents")).toHaveLength(1)

    const second = await issueOn(unset.ctx, issuer())
    expect(second.number).toBe("INV-2026-0002")
    expect(asks(unset.emitted)).toHaveLength(1)

    // A profile with a zone never raises it, UTC chosen on purpose (stored Etc/UTC) included.
    for (const timezone of ["Europe/Paris", "Etc/UTC"]) {
      const chosen = makeCtx()
      await issueOn(chosen.ctx, issuer({ timezone }))
      expect(asks(chosen.emitted)).toHaveLength(0)
    }
  })

  test("an organization that has a zone is not asked, and an issuer with issued documents is not asked retroactively", async () => {
    const withOrgZone = makeCtx({ orgZone: "Europe/Paris" })
    await issueOn(withOrgZone.ctx, issuer())
    expect(asks(withOrgZone.emitted)).toHaveLength(0)

    const history = makeCtx({
      seed: [
        {
          id: "old-1",
          type: "invoice",
          status: "paid",
          issuer_profile_id: "issuer-1",
          number: "INV-2025-0009",
          number_int: 9,
          year_of_issue: 2025,
        },
      ],
    })
    await issueOn(history.ctx, issuer())
    expect(asks(history.emitted)).toHaveLength(0)

    // A draft is not an issue: a profile holding only drafts is still at its first issue.
    const draftsOnly = makeCtx({
      seed: [{ id: "d-1", type: "invoice", status: "draft", issuer_profile_id: "issuer-1" }],
    })
    await issueOn(draftsOnly.ctx, issuer())
    expect(asks(draftsOnly.emitted)).toHaveLength(1)
  })

  test("the line goes to the holders of the settings scope, and setting a zone resolves it", async () => {
    const translation = manifest.attention.translations.find(
      (t) => t.event === "issuer_profile:timezone_unset",
    )
    expect(manifest.events.emits).toContain("issuer_profile:timezone_unset")
    expect(translation?.recipients).toEqual({
      kind: "scope_holders",
      scope: "invoicing:settings:write",
    })

    // The answer: a profile update that sets the zone. UTC on purpose is stored as Etc/UTC.
    const { ctx, db, emitted } = makeCtx()
    await db.insert("issuer_profiles", { ...issuer(), id: "issuer-1", timezone: "UTC" })
    const row = (await db.findOne("issuer_profiles", "issuer-1")) as Record<string, unknown>
    const answer = await settingsIssuerProfileUpdate({ ...ctx, db } as unknown as MutationsCtx, {
      id: String(row.id),
      timezone: "UTC",
    })
    expect(answer.status).toBe("completed")
    const updated = emitted.find((e) => e.entity === "issuer_profile" && e.action === "updated")
    expect((updated!.data as { changes: Record<string, unknown> }).changes.timezone).toEqual({
      from: "UTC",
      to: "Etc/UTC",
    })

    // The resolving translation reads that very event: it matches only a zone change and
    // resolves unconditionally, so an unrelated profile edit leaves the line alone.
    const resolver = manifest.attention.translations.find(
      (t) => t.event === "issuer_profile:updated" && t.kind === translation?.kind,
    )
    expect(resolver?.resolveWhen).toEqual({ always: true })
    expect(resolver?.when).toEqual({ op: "exists", path: "changes.timezone" })

    // After the answer the profile reads as chosen: its first issue raises nothing.
    const stored = (await db.findOne("issuer_profiles", "issuer-1")) as { timezone: string }
    expect(stored.timezone).toBe("Etc/UTC")
    const after = makeCtx()
    await issueOn(after.ctx, issuer({ timezone: stored.timezone }))
    expect(asks(after.emitted)).toHaveLength(0)
  })
})

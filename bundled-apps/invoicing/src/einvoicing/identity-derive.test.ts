// SPDX-License-Identifier: FSL-1.1-ALv2
// Customer kind derivation and the derived identity row.
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { deriveKind, ensureDerivedIdentity, hasLegalFormToken } from "./identity-derive"

describe("deriveKind", () => {
  test("a VAT id derives business", () => {
    expect(
      deriveKind({
        vat_id: "FR68900000001",
        legal_name: "Exemple",
        country: "FR",
        origin: "manual",
      }),
    ).toBe("business")
  })

  test("a company on the contact derives business", () => {
    expect(
      deriveKind({
        company: "Exemple Atelier",
        legal_name: "Celine Exemple",
        country: "FR",
        origin: "manual",
      }),
    ).toBe("business")
  })

  test("a buyer outside France with no signal is an individual", () => {
    expect(deriveKind({ legal_name: "Alex Example", country: "DE", origin: "manual" })).toBe(
      "individual",
    )
  })

  test("a French buyer with no signal is unknown on a manual document", () => {
    expect(deriveKind({ legal_name: "Celine Exemple", country: "FR", origin: "manual" })).toBeNull()
  })

  test("a French checkout buyer with no signal is an individual", () => {
    expect(deriveKind({ legal_name: "Celine Exemple", country: "FR", origin: "shopify" })).toBe(
      "individual",
    )
  })

  test("a legal-form token without VAT id or company is unknown, whatever the origin", () => {
    expect(
      deriveKind({ legal_name: "Exemple Atelier SARL", country: "FR", origin: "manual" }),
    ).toBeNull()
    expect(
      deriveKind({ legal_name: "Exemple Atelier S.A.R.L.", country: "FR", origin: "shopify" }),
    ).toBeNull()
    expect(deriveKind({ legal_name: "Beispiel GmbH", country: "DE", origin: "manual" })).toBeNull()
  })

  test("no country is unknown", () => {
    expect(deriveKind({ legal_name: "Celine Exemple", country: null, origin: "manual" })).toBeNull()
  })

  test("hasLegalFormToken matches whole tokens only", () => {
    expect(hasLegalFormToken("Exemple SAS")).toBe(true)
    expect(hasLegalFormToken("Sasha Exemple")).toBe(false)
  })
})

describe("ensureDerivedIdentity", () => {
  test("writes a derived, unconfirmed identity with the SIREN read off a French VAT id", async () => {
    const db = createMockDb()
    const id = await ensureDerivedIdentity(db, {
      contact_id: "c-1",
      customer_kind: "business",
      vat_id: "FR68900000001",
      billing_country: "FR",
    })
    expect(id).not.toBeNull()
    const rows = db.__all("counterparty_identities")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      contact_id: "c-1",
      customer_kind: "business",
      siren: "900000001",
      source: "derived",
      confirmed_via: null,
    })
  })

  test("never touches an existing identity row", async () => {
    const db = createMockDb({
      seed: {
        counterparty_identities: [
          { contact_id: "c-1", customer_kind: "individual", source: "manual" },
        ],
      },
    })
    const id = await ensureDerivedIdentity(db, {
      contact_id: "c-1",
      customer_kind: "business",
      vat_id: null,
    })
    expect(id).toBeNull()
    expect(db.__all("counterparty_identities")).toHaveLength(1)
    expect(db.__all("counterparty_identities")[0]?.customer_kind).toBe("individual")
  })

  test("an identity another writer recorded first (a unique-key race) is left as it is", async () => {
    const db = {
      findMany: async () => [],
      insert: async () => {
        throw new Error(
          'duplicate key value violates unique constraint "counterparty_identities_org_id_contact_id_key" (23505)',
        )
      },
    }
    const id = await ensureDerivedIdentity(db, { contact_id: "c-1", customer_kind: "individual" })
    expect(id).toBeNull()
  })

  test("the same race in a sandboxed run, where the failed insert rejects with its text alone", async () => {
    const db = {
      findMany: async () => [],
      insert: async () => {
        throw 'Failed query — pg: duplicate key value violates unique constraint "counterparty_identities_org_id_contact_id_key" (23505)'
      },
    }
    const id = await ensureDerivedIdentity(db, { contact_id: "c-1", customer_kind: "individual" })
    expect(id).toBeNull()
  })

  test("any other insert failure still throws", async () => {
    const db = {
      findMany: async () => [],
      insert: async () => {
        throw new Error("connection reset")
      },
    }
    await expect(
      ensureDerivedIdentity(db, { contact_id: "c-1", customer_kind: "individual" }),
    ).rejects.toThrow("connection reset")
  })
})

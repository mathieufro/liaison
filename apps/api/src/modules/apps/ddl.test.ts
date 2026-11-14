// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 17 D1 — exercises the typed-DDL surface added so the Invoicing manifest
// can declare bigint money columns, smallint year-of-issue, and numeric(15,3)
// quantity. These three types were not in FIELD_TYPE_MAP before Phase 17.
import { describe, expect, it } from "bun:test"
import {
  generateAlterTableDdl,
  generateNotNullLoosenDdl,
  generateTableDdl,
  generateTriggerDdl,
  mapFieldTypeToPgDataType,
} from "./ddl"

describe("generateTableDdl: typed DDL extensions", () => {
  it("emits BIGINT for `bigint` typed fields", () => {
    const ddl = generateTableDdl("app_invoicing", "t", { amount: "bigint" })
    expect(ddl).toMatch(/"amount"\s+BIGINT\s+NOT NULL/)
  })

  it("emits BIGINT with default for object-form bigint", () => {
    const ddl = generateTableDdl("app_invoicing", "t", {
      amount: { type: "bigint", default: 0 },
    })
    expect(ddl).toMatch(/"amount"\s+BIGINT\s+NOT NULL\s+DEFAULT 0/)
  })

  it("emits SMALLINT for `smallint` typed fields", () => {
    const ddl = generateTableDdl("app_invoicing", "t", { year: "smallint?" })
    expect(ddl).toMatch(/"year"\s+SMALLINT(?!\s+NOT NULL)/)
  })

  it("emits NUMERIC(p,s) when precision and scale are declared", () => {
    const ddl = generateTableDdl("app_invoicing", "t", {
      quantity: { type: "numeric", precision: 15, scale: 3 },
    })
    expect(ddl).toMatch(/"quantity"\s+NUMERIC\(15,\s*3\)/)
  })

  it("emits plain NUMERIC when no precision/scale is declared", () => {
    const ddl = generateTableDdl("app_invoicing", "t", { rate: "numeric" })
    expect(ddl).toMatch(/"rate"\s+NUMERIC\s+NOT NULL/)
  })

  it("mapFieldTypeToPgDataType recognises the new types", () => {
    expect(mapFieldTypeToPgDataType("bigint")).toBe("bigint")
    expect(mapFieldTypeToPgDataType("smallint")).toBe("smallint")
    expect(mapFieldTypeToPgDataType({ type: "numeric", precision: 15, scale: 3 })).toBe("numeric")
  })
})

describe("generateTableDdl, bytea ciphertext columns", () => {
  it("emits BYTEA for a nullable `bytea` typed field", () => {
    const ddl = generateTableDdl("app_mail", "messages", { cipher: "bytea?" })
    expect(ddl).toMatch(/"cipher"\s+BYTEA(?!\s+NOT NULL)/)
  })

  it("emits BYTEA on the ADD COLUMN path so an existing table gains the column", () => {
    const ddl = generateAlterTableDdl("app_mail", "messages", { cipher: "bytea?" })
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS "cipher" BYTEA/)
  })

  it("mapFieldTypeToPgDataType resolves bytea to the information_schema data type", () => {
    expect(mapFieldTypeToPgDataType("bytea")).toBe("bytea")
    expect(mapFieldTypeToPgDataType("bytea?")).toBe("bytea")
    expect(mapFieldTypeToPgDataType({ type: "bytea" })).toBe("bytea")
  })
})

describe("generateTriggerDdl — dollar-quote injection hardening", () => {
  const def = (body: string) => ({
    timing: "BEFORE",
    event: ["INSERT"],
    level: "ROW",
    language: "plpgsql",
    body,
  })

  it("rejects a body containing the dollar-quote tag sequence $TRIGGER_BODY$", () => {
    expect(() =>
      generateTriggerDdl(
        "app_x",
        "t",
        "trg",
        def("BEGIN END; $TRIGGER_BODY$ ; DROP TABLE kernel.users; --"),
      ),
    ).toThrow(/dollar-quote tag/)
  })

  it("rejects a body containing an empty dollar-quote tag $$", () => {
    expect(() => generateTriggerDdl("app_x", "t", "trg", def("BEGIN $$ x $$ END;"))).toThrow(
      /dollar-quote tag/,
    )
  })

  it("emits a content-hash-derived dollar-quote tag ($TRG_<hash>$), not a static $TRIGGER_BODY$", () => {
    const ddl = generateTriggerDdl("app_x", "t", "trg", def("BEGIN RETURN NEW; END;"))
    expect(ddl).not.toContain("$TRIGGER_BODY$")
    expect(ddl).toMatch(/\$TRG_[0-9a-f]{16}\$/)
    // The tag wraps the body symmetrically.
    const tags = ddl.match(/\$TRG_[0-9a-f]{16}\$/g)
    expect(tags?.length).toBe(2)
    expect(tags?.[0]).toBe(tags?.[1])
  })

  it("generates correct DDL for a legitimate plpgsql body using $1 positional params", () => {
    const ddl = generateTriggerDdl(
      "app_tickets",
      "categories",
      "enforce_category_depth",
      def(
        "DECLARE _exists boolean; BEGIN IF NEW.parent_id IS NULL THEN RETURN NEW; END IF; " +
          "EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.categories WHERE id = $1 AND parent_id IS NOT NULL)', TG_TABLE_SCHEMA) " +
          "INTO _exists USING NEW.parent_id; IF _exists THEN RAISE EXCEPTION 'category_depth_limit'; END IF; RETURN NEW; END;",
      ),
    )
    expect(ddl).toContain("CREATE OR REPLACE FUNCTION")
    expect(ddl).toContain("RAISE EXCEPTION 'category_depth_limit'")
    expect(ddl).toContain("USING NEW.parent_id")
    expect(ddl).toMatch(/\$TRG_[0-9a-f]{16}\$/)
  })
})

describe("partial-index WHERE — injection hardening at the emission site", () => {
  it("generateTableDdl rejects a subquery in a partial-unique WHERE", () => {
    expect(() =>
      generateTableDdl(
        "app_x",
        "t",
        { foo: "string?" },
        {
          unique: [{ columns: ["foo"], where: "foo = (SELECT id FROM kernel.users)" }],
        },
      ),
    ).toThrow(/Unsafe partial-index WHERE/)
  })

  it("generateTableDdl rejects a function call (pg_sleep) in a partial index WHERE", () => {
    expect(() =>
      generateTableDdl("app_x", "t", { foo: "string?" }, undefined, [
        { columns: ["foo"], where: "pg_sleep(5) > 0" },
      ]),
    ).toThrow(/Unsafe partial-index WHERE/)
  })

  it("generateTableDdl rejects a comment in a partial index WHERE", () => {
    expect(() =>
      generateTableDdl("app_x", "t", { foo: "string?" }, undefined, [
        { columns: ["foo"], where: "foo IS NOT NULL -- x" },
      ]),
    ).toThrow(/Unsafe partial-index WHERE/)
  })

  it("generateAlterTableDdl rejects a subquery in a partial-unique WHERE", () => {
    expect(() =>
      generateAlterTableDdl(
        "app_x",
        "t",
        {},
        {
          unique: [{ columns: ["foo"], where: "foo = (SELECT 1)" }],
        },
      ),
    ).toThrow(/Unsafe partial-index WHERE/)
  })

  it("generateTableDdl emits a legitimate partial-unique WHERE unchanged", () => {
    const ddl = generateTableDdl(
      "app_tickets",
      "msgs",
      { externalMessageId: "string?" },
      {
        unique: [{ columns: ["externalMessageId"], where: "external_message_id IS NOT NULL" }],
      },
    )
    expect(ddl).toContain("WHERE external_message_id IS NOT NULL")
  })

  it("generateTableDdl emits a legitimate partial index WHERE with a quoted literal unchanged", () => {
    const ddl = generateTableDdl("app_boxtal", "orders", { orderStatus: "string?" }, undefined, [
      { columns: ["orderStatus"], where: "order_status IS DISTINCT FROM 'CANCELLED'" },
    ])
    expect(ddl).toContain("WHERE order_status IS DISTINCT FROM 'CANCELLED'")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Partial-unique reconciliation (boxtal 0.2.0 regression class: an app version
// that CHANGES a partial unique's column list — (document_ref) →
// (document_ref, kind) — mints a NEW deterministic index name; the runtime must
// be able to compute both the declared set and a safe DROP for the stale one,
// or the old index keeps enforcing the old rule on upgraded deployments).
// ─────────────────────────────────────────────────────────────────────────
import {
  declaredPartialUniqueIndexNames,
  generateDropIndexDdl,
  partialUniqueIndexName,
} from "./ddl"

describe("partial-unique reconciliation helpers", () => {
  it("partialUniqueIndexName matches the name generateTableDdl emits (single + multi column, snake-cased)", () => {
    expect(partialUniqueIndexName("app_boxtal", "shipment", ["documentRef"])).toBe(
      "uniq_app_boxtal_shipment_document_ref",
    )
    expect(partialUniqueIndexName("app_boxtal", "shipment", ["documentRef", "kind"])).toBe(
      "uniq_app_boxtal_shipment_document_ref_kind",
    )
    const ddl = generateTableDdl(
      "app_boxtal",
      "shipment",
      { documentRef: "string?", kind: "string?" },
      {
        unique: [
          { columns: ["documentRef", "kind"], where: "order_status IS DISTINCT FROM 'CANCELLED'" },
        ],
      },
    )
    expect(ddl).toContain('"uniq_app_boxtal_shipment_document_ref_kind"')
  })

  it("zero-column partial unique names the org-wide singleton index", () => {
    expect(partialUniqueIndexName("app_x", "t", [])).toBe("uniq_app_x_t_org")
  })

  it("declaredPartialUniqueIndexNames lists only object-form (partial) uniques, skipping array-form table constraints", () => {
    expect(
      declaredPartialUniqueIndexNames("app_boxtal", "shipment", {
        unique: [
          ["externalId"], // table-level UNIQUE — not a uniq_-named index
          { columns: ["documentRef", "kind"], where: "order_status IS DISTINCT FROM 'CANCELLED'" },
        ],
      }),
    ).toEqual(["uniq_app_boxtal_shipment_document_ref_kind"])
    expect(declaredPartialUniqueIndexNames("app_boxtal", "shipment", undefined)).toEqual([])
  })

  it("generateDropIndexDdl quotes identifiers and rejects a non-identifier index name", () => {
    expect(generateDropIndexDdl("app_boxtal", "uniq_app_boxtal_shipment_document_ref")).toBe(
      'DROP INDEX IF EXISTS "app_boxtal"."uniq_app_boxtal_shipment_document_ref"',
    )
    expect(() => generateDropIndexDdl("app_boxtal", 'evil"; DROP TABLE x; --')).toThrow(
      /Invalid SQL identifier/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Enum CHECK reconciliation (invoicing 0.5.0 regression: widening an enum in
// the manifest must recreate the live `<table>_<col>_check`, or inserts with
// the new value violate the stale constraint on upgraded deployments).
// ─────────────────────────────────────────────────────────────────────────
import { constraintDefEnumValues, enumCheckMatches, generateEnumCheckReconcileDdl } from "./ddl"

describe("enum CHECK reconciliation", () => {
  const liveDef =
    "CHECK ((type = ANY (ARRAY['invoice'::text, 'quote'::text, 'proforma'::text, 'purchase_order'::text])))"

  it("extracts literal values from a pg_get_constraintdef body", () => {
    expect(constraintDefEnumValues(liveDef)).toEqual([
      "invoice",
      "quote",
      "proforma",
      "purchase_order",
    ])
  })

  it("matches when the live set equals the manifest enum regardless of order", () => {
    expect(enumCheckMatches(liveDef, ["quote", "invoice", "purchase_order", "proforma"])).toBe(true)
  })

  it("detects a widened manifest enum (credit_note added)", () => {
    expect(
      enumCheckMatches(liveDef, ["invoice", "quote", "proforma", "purchase_order", "credit_note"]),
    ).toBe(false)
  })

  it("emits DROP+ADD recreating the default-named constraint with escaped literals", () => {
    const stmts = generateEnumCheckReconcileDdl("app_invoicing", "documents", "type", [
      "invoice",
      "credit_note",
      "o'brien",
    ])
    expect(stmts).toHaveLength(2)
    expect(stmts[0]).toBe(
      'ALTER TABLE "app_invoicing"."documents" DROP CONSTRAINT "documents_type_check"',
    )
    expect(stmts[1]).toContain('ADD CONSTRAINT "documents_type_check"')
    expect(stmts[1]).toContain(`CHECK ("type" IN ('invoice', 'credit_note', 'o''brien'))`)
  })
})

describe("generateNotNullLoosenDdl", () => {
  it("drops NOT NULL for a field the manifest declares nullable", () => {
    expect(generateNotNullLoosenDdl("app_x", "rows", "contactId", "uuid?")).toBe(
      'ALTER TABLE "app_x"."rows" ALTER COLUMN "contact_id" DROP NOT NULL',
    )
    expect(
      generateNotNullLoosenDdl("app_x", "rows", "n", { type: "integer", required: false }),
    ).toBe('ALTER TABLE "app_x"."rows" ALTER COLUMN "n" DROP NOT NULL')
  })

  it("emits nothing for a field still declared NOT NULL", () => {
    expect(generateNotNullLoosenDdl("app_x", "rows", "n", "uuid")).toBeNull()
    expect(
      generateNotNullLoosenDdl("app_x", "rows", "n", { type: "integer", default: 0 }),
    ).toBeNull()
  })
})

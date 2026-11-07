// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A draft-builder context for one GoldenCase: the invoice, the contact copy, the address book,
// the Shopify order and the prep rows, each answered the way the real cross-app tools answer.
// `calls` records every cross-app target the build reached, so a test can count reads.
import type { BoxtalToolCtx, CrossAppEnvelope } from "../ctx"
import { createMockDb } from "../test-db"
import type { GoldenCase } from "./address-golden"

const SENDER = {
  name: "Fabrikam SAS",
  company: "Fabrikam SAS",
  email: "ship@fabrikam.example",
  phone: "+33123456789",
  street: "10 Rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  countryIsoCode: "FR",
}

export function docId(c: GoldenCase): string {
  return `11111111-1111-4111-8111-${c.id.replace("case-", "").padStart(12, "0")}`
}

export function goldenCtx(c: GoldenCase) {
  const id = docId(c)
  const calls: string[] = []
  const doc = {
    id,
    number: `INV-${c.id}`,
    currency: "EUR",
    incoterm: "DAP",
    issued_at: "2026-10-01",
    grand_total_minor: "12000",
    ...c.doc,
    lines: [
      {
        id: `${c.id}-l1`,
        description: "Synth module",
        quantity: "1.000",
        unit_price_minor: "10000",
        hs_code: "854370",
        country_of_origin: "FR",
        customs_description: "Synthesizer module",
        product_source: "shopify",
        external_id: "V1",
      },
    ],
  }
  const db = createMockDb({
    seed: {
      shipping_profile: [
        { id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.5, solo_length: 30, solo_width: 20, solo_height: 10, content_category: "content:v1:10120" },
      ],
      app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER }],
      ...(c.doc.shopify_order_id
        ? {
            prep_meta: [
              {
                id: `pm-${c.id}`,
                document_ref: id,
                shopify_order_id: c.doc.shopify_order_id,
                order_name: `#${c.doc.shopify_order_id}`,
                ...(c.cachedShipTo && c.order
                  ? {
                      ship_to: c.order.shippingAddress
                        ? { source: "order", address: { ...c.order.shippingAddress, email: c.order.email ?? null } }
                        : c.order.customerAddress
                          ? { source: "customer", address: { ...c.order.customerAddress, email: c.order.email ?? null } }
                          : null,
                    }
                  : {}),
              },
            ],
          }
        : {}),
      ...(c.prepRecipient
        ? { prep_order_state: [{ id: `pos-${c.id}`, order_key: `proforma:${id}`, proforma_document_ref: id, recipient: c.prepRecipient }] }
        : {}),
    },
  })
  const executeTool = async (target: string, _args: string | Record<string, unknown>): Promise<CrossAppEnvelope> => {
    calls.push(target)
    if (target === "invoicing:documents_get") return { status: "completed", result: doc }
    if (target === "kernel:contacts_read") {
      return {
        status: "completed",
        result: {
          contact: {
            id: c.doc.counterparty_contact_id,
            email: c.doc.counterparty_email,
            metadata: c.contactAddress ? { shipping_address: c.contactAddress } : {},
          },
        },
      }
    }
    if (target === "kernel:contacts_addresses_list") {
      return {
        status: "completed",
        result: {
          contactId: c.doc.counterparty_contact_id,
          addresses: (c.book ?? []).map((b, i) => ({
            id: `addr-${c.id}-${i}`,
            label: null,
            name: null,
            company: null,
            street2: null,
            region: null,
            phone: null,
            email: null,
            verified: false,
            verifiedAt: null,
            verifiedBy: null,
            verifiedByName: null,
            verificationSource: null,
            stale: false,
            archived: false,
            ...b,
          })),
        },
      }
    }
    if (target === "shopify:orders_get") {
      if (!c.order) return { status: "error", error: { code: "not_found", message: "not found" } }
      return {
        status: "completed",
        result: {
          name: `#${c.doc.shopify_order_id}`,
          shippingAddress: c.order.shippingAddress ?? null,
          customerAddress: c.order.customerAddress ?? null,
          attributes: { email: c.order.email ?? null },
        },
      }
    }
    return { status: "completed", result: null }
  }
  const ctx: BoxtalToolCtx = {
    orgId: "org-1",
    db,
    fetch: async () => ({ status: 500, headers: {}, body: "" }),
    executeTool,
    connections: {},
    config: { get: async () => null, has: async () => false },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return { ctx, calls, id }
}


// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DocumentDetail F3 tests — bundled-app tests use bun:test (no jsdom).
// Pin: (a) the component module imports cleanly under the host shim,
// (b) the four built-in tabs (Overview / Customs / PDF / Lifecycle) are
// registered with the expected ids + order, (c) external tab
// contributions from K5 slot host are merged into the tab list in
// (order, label) sort order, (d) footer-action buttons emit the correct
// invocation map (testid → tool name), (e) pdf_status states drive the
// expected UI affordances (failed → retry button present; pending →
// download disabled; ready → download enabled), (f) the manifest
// publishes the `slots.invoicing.document_detail.tabs[]` shape so
// Phase 18 Boxtal can extend it.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import {
  ACTION_NOTE_DISMISS_MS,
  BUILT_IN_TABS,
  canConvertToInvoice,
  convertConfirmBody,
  convertResultNote,
  DocumentDetail,
  type DocumentDetailTabContribution,
  FOOTER_ACTIONS,
  footerActionResultNote,
  isEditableDocumentStatus,
  mergeTabs,
  moneyChips,
  pdfNotReadyNote,
  pdfStatusAffordance,
  shopifyOrderUrl,
  stripeCollection,
  toLoadedDocument,
} from "./DocumentDetail"
import { FR as fr } from "./i18n-fr"
import { einvoiceStatusWord } from "./RecurringStates"

const source = readFileSync(join(import.meta.dir, "DocumentDetail.tsx"), "utf-8")

describe("DocumentDetail (Phase 17 F3)", () => {
  it("exports a Component", () => {
    expect(typeof DocumentDetail).toBe("function")
  })

  it("declares the four built-in tabs in spec §12 order", () => {
    expect(BUILT_IN_TABS.map((t) => t.id)).toEqual(["overview", "customs", "pdf", "lifecycle"])
    expect(BUILT_IN_TABS.map((t) => t.label)).toEqual(["Overview", "Customs", "PDF", "Lifecycle"])
    // Sorted by order — spec §12 puts Overview first, Lifecycle last.
    const orders = BUILT_IN_TABS.map((t) => t.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it("mergeTabs() interleaves external contributions by (order, label)", () => {
    const external: DocumentDetailTabContribution[] = [
      // Phase 18 Boxtal example: shipment tab sits after customs.
      { id: "shipment", label: "Shipment", component: "BoxtalShipmentTab", order: 25 },
      { id: "audit", label: "Audit", component: "AuditTab", order: 100 },
    ]
    const merged = mergeTabs(external)
    expect(merged.map((t) => t.id)).toEqual([
      "overview", // 10
      "customs", // 20
      "shipment", // 25 — external, post-customs
      "pdf", // 30
      "lifecycle", // 40
      "audit", // 100 — external, tail
    ])
  })

  it("mergeTabs() is stable on label for equal-order ties", () => {
    const external: DocumentDetailTabContribution[] = [
      { id: "alt-overview", label: "Alt", component: "AltTab", order: 10 },
    ]
    const merged = mergeTabs(external)
    // Both "overview" and "alt-overview" have order 10; tie-break by label
    // alphabetically — "Alt" < "Overview" so external comes first.
    const idsAtOrder10 = merged.filter((t) => t.order === 10).map((t) => t.id)
    expect(idsAtOrder10).toEqual(["alt-overview", "overview"])
  })

  it("footer actions are wired to the correct tool names", () => {
    // The footer renders four actions; each carries a `tool` field so the
    // component's click handler can call `app.invokeTool(action.tool, ...)`.
    // Per spec §12: Mark paid / Send to customer / Convert to invoice /
    // Preview PDF / Download PDF.
    expect(FOOTER_ACTIONS.mark_paid.tool).toBe("documents_mark_paid")
    expect(FOOTER_ACTIONS.send_to_customer.tool).toBe("documents_send_to_customer")
    expect(FOOTER_ACTIONS.convert_to_invoice.tool).toBe("documents_convert_to_invoice")
  })

  // ── Footer-action id params (kernel assertKnownParams mismatch) ─────────
  //
  // Each tool's manifest requires a different id key (`document_id`,
  // `source_document_id`, `id`, `draft_id`). Before `idParam` existed, every
  // footer action rode the shared `invoke()` helper's hardcoded `{ id }`,
  // which `assertKnownParams` 400s for the tools that need a different key
  // and `invoke()`'s empty `catch {}` swallowed silently, so Mark paid /
  // Send to customer / Convert to invoice did nothing on click. See
  // `footer-action-params.test.ts` for the full manifest cross-check.
  describe("footer action id params", () => {
    it("FOOTER_ACTIONS declares the manifest-required id key per action", () => {
      expect(FOOTER_ACTIONS.mark_paid.idParam).toBe("document_id")
      expect(FOOTER_ACTIONS.send_to_customer.idParam).toBe("document_id")
      expect(FOOTER_ACTIONS.convert_to_invoice.idParam).toBe("source_document_id")
      expect(FOOTER_ACTIONS.preview_pdf.idParam).toBe("id")
      expect(FOOTER_ACTIONS.download_pdf.idParam).toBe("id")
      expect(FOOTER_ACTIONS.delete_draft.idParam).toBe("draft_id")
    })

    it("invoke() keys the payload off action.idParam, not a hardcoded 'id'", () => {
      expect(source).toMatch(
        /invoke = async\s*\(\s*action:\s*\{\s*tool:\s*string;\s*idParam:\s*string\s*\}[\s\S]{0,260}\[action\.idParam\]:\s*props\.documentId/,
      )
      // The old shared-helper call sites that would have sent a hardcoded
      // `{ id }` no longer exist.
      expect(source).not.toContain('invoke("documents_retry_pdf")')
      expect(source).not.toContain("invoke(FOOTER_ACTIONS.mark_paid.tool)")
      expect(source).not.toContain("invoke(FOOTER_ACTIONS.send_to_customer.tool)")
    })

    it("markPaid / sendToCustomer route through invoke() with the full action object (idParam intact)", () => {
      expect(source).toContain("const markPaid = () => void invoke(FOOTER_ACTIONS.mark_paid)")
      expect(source).toContain(
        "const sendToCustomer = () => void invoke(FOOTER_ACTIONS.send_to_customer)",
      )
    })

    it("runConvertToInvoice sends source_document_id, not id", () => {
      expect(source).toMatch(
        /runConvertToInvoice = async[\s\S]{0,400}\[FOOTER_ACTIONS\.convert_to_invoice\.idParam\]:\s*props\.documentId/,
      )
    })
  })

  // ── invoke() error / blocked surfacing (was an empty catch {}) ──────────
  describe("footer action failure surfacing", () => {
    it("invoke()'s catch is no longer empty: it records a thrown message as an error note", () => {
      expect(source).not.toMatch(/catch\s*\{\s*\/\/ Toast surface/)
      expect(source).toMatch(
        /catch \(e\) \{\s*showActionNote\(\{\s*text: e instanceof Error \? e\.message/,
      )
    })

    it("a gated call ({ blocked: {...} } envelope) sets a non-error 'Sent for approval.' note", () => {
      expect(source).toContain("isBlockedResult(result)")
      expect(
        footerActionResultNote("documents_mark_paid", { blocked: { approvalRequestId: "a1" } }),
      ).toEqual({
        text: "Sent for approval.",
        isError: false,
      })
    })

    it("renders the action note with the error tone only when isError is set", () => {
      expect(source).toContain('data-testid="document-detail-action-note"')
      expect(source).toContain("border-error-border bg-error-glow text-error")
    })
  })

  it("pdfNotReadyNote() says what is happening when a PDF cannot open yet", () => {
    expect(pdfNotReadyNote("pending")).toBe(
      "This PDF is not ready yet. If it stays that way, use Retry render on the PDF tab.",
    )
    expect(pdfNotReadyNote("failed")).toBe(
      "This PDF could not be rendered. Use Retry render on the PDF tab.",
    )
    expect(pdfNotReadyNote(undefined)).toBe(pdfNotReadyNote("pending"))
    // A calm note, in the app's other language too.
    for (const s of ["pending", "failed"] as const) expect(fr[pdfNotReadyNote(s)]).toBeTruthy()
  })

  it("a PDF that cannot open says so, instead of doing nothing", () => {
    expect(source).toMatch(/if \(!res\?\.url\) \{\s*showActionNote\(\{ text: pdfNotReadyNote\(/)
  })

  it("pdfStatusAffordance() respects the four declared states", () => {
    // Failed → retry button present, download disabled
    const failed = pdfStatusAffordance("failed")
    expect(failed.showRetry).toBe(true)
    expect(failed.downloadEnabled).toBe(false)

    // Pending → retry offered (a render that never ran stays pending until someone asks), download disabled
    const pending = pdfStatusAffordance("pending")
    expect(pending.showRetry).toBe(true)
    expect(pending.downloadEnabled).toBe(false)

    // Ready → no retry, download enabled
    const ready = pdfStatusAffordance("ready")
    expect(ready.showRetry).toBe(false)
    expect(ready.downloadEnabled).toBe(true)

    // PDF/A-3 skip → download still works (only archival metadata absent)
    const skipped = pdfStatusAffordance("pdf_a3_normalization_skipped")
    expect(skipped.showRetry).toBe(false)
    expect(skipped.downloadEnabled).toBe(true)
    // Surface a warning so the user knows long-term archival metadata
    // is absent (per spec §K2 PDF/A-3 note).
    expect(skipped.showA3SkippedNote).toBe(true)

    // Undefined (legacy / brand-new draft) → no retry, download disabled
    const none = pdfStatusAffordance(undefined)
    expect(none.showRetry).toBe(false)
    expect(none.downloadEnabled).toBe(false)
  })

  it("source emits a slot-mount call for invoicing.document_detail.tabs", () => {
    // The component must enumerate contributions from K5 slot host so
    // Phase 18 Boxtal's shipment tab actually shows up.
    expect(source).toContain("invoicing.document_detail.tabs")
  })

  it("publishes slots.invoicing.document_detail.tabs[] in manifest (K5 contract)", () => {
    // The slot list itself can be empty in the invoicing app — invoicing
    // doesn't contribute external tabs to its own document detail; other
    // apps (Phase 18) will. What matters is the slot key is declared so
    // the K5 enumeration finds *something* at this slot id.
    const slots = (manifest as { slots?: Record<string, unknown> }).slots ?? {}
    const invoicingSlot = (slots as Record<string, unknown>).invoicing as
      | { document_detail?: { tabs?: unknown[] } }
      | undefined
    expect(invoicingSlot).toBeDefined()
    expect(invoicingSlot?.document_detail).toBeDefined()
    expect(Array.isArray(invoicingSlot?.document_detail?.tabs)).toBe(true)
  })

  it("an invoice Stripe collects names its Stripe invoice and customer, and offers no Mark paid", () => {
    expect(stripeCollection({ stripe_invoice_id: "in_1", stripe_customer_id: "cus_1" })).toEqual({
      invoiceId: "in_1",
      customerId: "cus_1",
    })
    expect(stripeCollection({ stripe_invoice_id: "in_1" })).toEqual({
      invoiceId: "in_1",
      customerId: null,
    })
    expect(stripeCollection({})).toBeNull()
    expect(stripeCollection(undefined)).toBeNull()
    expect(source).toContain(
      'doc().type !== "credit_note" && !stripeCollection(doc().external_refs)',
    )
    expect(source).toContain("document-detail-open-stripe")
    expect(source).toContain("document-detail-open-contact")
  })

  it("renders footer-action testids in source for E2E pickup", () => {
    // Playwright (G6 killer scenario) targets these testids.
    expect(source).toContain("document-detail-action-mark-paid")
    expect(source).toContain("document-detail-action-send-to-customer")
    expect(source).toContain("document-detail-action-convert-to-invoice")
    expect(source).toContain("document-detail-action-preview-pdf")
    expect(source).toContain("document-detail-action-download-pdf")
  })

  it("renders the 'Panel unavailable' placeholder for bundle-load failures", () => {
    // K5 contract: when an external tab's component fails to load, the
    // tab strip still shows the label but the body renders a graceful
    // placeholder instead of crashing the panel.
    expect(source).toContain("Tab unavailable")
  })

  it("renders the empty-lifecycle placeholder when log is empty", () => {
    // Spec §12: Lifecycle tab renders empty log gracefully.
    expect(source).toContain("No lifecycle events yet")
  })

  it("renders the failed-PDF retry button copy", () => {
    expect(source).toContain("Retry render")
  })

  it("mergeTabs preserves the contributing `app` on external tabs", () => {
    const external: DocumentDetailTabContribution[] = [
      {
        id: "shipment",
        label: "Shipment",
        component: "BoxtalShipmentTab",
        order: 25,
        app: "boxtal",
      },
    ]
    const merged = mergeTabs(external)
    const shipment = merged.find((t) => t.id === "shipment")
    expect(shipment?.app).toBe("boxtal")
  })

  it("renders external tab bodies via the host-driven slot mount (no hardcoded placeholder body)", () => {
    // Source pin (bundled-app UI tests have no DOM): the external-tab body path
    // now delegates to the host bridge instead of always rendering placeholder copy.
    expect(source).toContain("app.mountSlot")
    expect(source).toContain('slot: "invoicing.document_detail.tabs"')
  })

  it("renders an Edit footer action for any editable status, navigating to the editor", () => {
    // List → detail → edit wiring: the footer action navigates to
    // /invoicing/editor/:documentId via the host's in-app navigate (not
    // window.location) — see DataTable.tsx's onRowClick for the same
    // navigate idiom used elsewhere in this app. The action now shows for
    // ANY editable status (not just draft) — see isEditableDocumentStatus.
    expect(source).toContain("document-detail-action-edit-draft")
    expect(source).toContain("document-detail-action-edit")
    expect(source).toMatch(/import \{[^}]*\bnavigate\b[^}]*\} from "@liaison\/host"/)
    expect(source).toMatch(/doc\(\)\.status === "draft"/)
    expect(source).toContain("navigate(`/invoicing/editor/${props.documentId}`)")
  })

  // ── isEditableDocumentStatus (edit affordance gate) ─────────────────────
  describe("isEditableDocumentStatus", () => {
    it("is false only for voided/cancelled", () => {
      expect(isEditableDocumentStatus("voided")).toBe(false)
      expect(isEditableDocumentStatus("cancelled")).toBe(false)
    })
    it("is true for draft, issued, and every other lifecycle status", () => {
      for (const status of ["draft", "issued", "sent", "paid", "overdue", "pending_approval"]) {
        expect(isEditableDocumentStatus(status)).toBe(true)
      }
    })
  })

  it("renders the Edit footer action for every status except voided/cancelled", () => {
    expect(source).toContain("isEditableDocumentStatus(doc().status)")
  })

  // ── Customer block (Overview tab) ────────────────────────────────────────
  describe("Customer block", () => {
    it("source renders the document-detail-customer block with name/country/email/vat/address testids", () => {
      expect(source).toContain("document-detail-customer")
      expect(source).toContain("document-detail-customer-name")
      expect(source).toContain("document-detail-customer-country")
      expect(source).toContain("document-detail-customer-email")
      expect(source).toContain("document-detail-customer-vat")
      expect(source).toContain("document-detail-customer-address")
    })

    it("CustomerBlock is rendered inside OverviewBody", () => {
      expect(source).toMatch(/<CustomerBlock doc=\{p\.doc\}\s*\/>/)
    })
  })

  // ── Inline PDF preview (PDF tab) ─────────────────────────────────────────
  describe("Inline PDF preview", () => {
    it("source fetches the PDF inline bytes through the host fetchBlob and creates a blob URL for the embed", () => {
      expect(source).toContain("document-detail-pdf-embed")
      // The CSP has object-src 'none': a plugin element can never show it.
      expect(source).not.toMatch(/<object\b/)
      expect(source).toMatch(/<iframe\s+data-testid="document-detail-pdf-embed"/)
      expect(source).toContain("fetchPdfBlobUrl")
      expect(source).toContain("documents_preview_pdf")
      expect(source).toContain("fetchBlob(res.url)")
      expect(source).toContain("application/pdf")
      expect(source).toContain("URL.createObjectURL")
    })

    it("revokes the blob URL on cleanup", () => {
      expect(source).toContain("onCleanup")
      expect(source).toContain("URL.revokeObjectURL")
    })

    it("re-keys the PDF fetch on pdf_file_id so an edit's re-render is picked up", () => {
      expect(source).toMatch(
        /createResource\(\s*\(\)\s*=>\s*\(p\.doc\.pdf_file_id[\s\S]{0,80}fileId:\s*p\.doc\.pdf_file_id/,
      )
    })

    it("renders Preview/Download buttons above the embed", () => {
      expect(source).toContain("document-detail-pdf-preview-inline")
      expect(source).toContain("document-detail-pdf-download-inline")
    })
  })

  // ── Shopify order link (feature 3) ───────────────────────────────────────
  describe("shopifyOrderUrl", () => {
    it("builds the admin order URL from a Shopify-sourced document's external_refs", () => {
      const url = shopifyOrderUrl({
        shopify_order_id: "12768069779622",
        shopify_shop_domain: "example-store.myshopify.com",
        scope: "goods",
      })
      expect(url).toBe("https://example-store.myshopify.com/admin/orders/12768069779622")
    })

    it("strips a stray scheme/path from a stored shop domain", () => {
      const url = shopifyOrderUrl({
        shopify_order_id: "42",
        shopify_shop_domain: "https://acme.myshopify.com/admin",
      })
      expect(url).toBe("https://acme.myshopify.com/admin/orders/42")
    })

    it("returns null when external_refs is undefined (manually created invoice)", () => {
      expect(shopifyOrderUrl(undefined)).toBeNull()
    })

    it("returns null when external_refs has no shopify_order_id (e.g. a credit-note's original_document_id refs)", () => {
      expect(
        shopifyOrderUrl({ original_document_id: "d1", original_document_number: "INV-2026-0001" }),
      ).toBeNull()
    })

    it("returns null when shopify_order_id is present but shopify_shop_domain is missing", () => {
      expect(shopifyOrderUrl({ shopify_order_id: "42" })).toBeNull()
    })

    it("returns null when either field is not a string", () => {
      expect(
        shopifyOrderUrl({ shopify_order_id: 42, shopify_shop_domain: "acme.myshopify.com" }),
      ).toBeNull()
    })

    it("source renders the Open Shopify order link only when shopifyOrderUrl() resolves", () => {
      expect(source).toContain("document-detail-open-shopify-order")
      expect(source).toMatch(/Show when=\{shopifyOrderUrl\(doc\(\)\.external_refs\)\}/)
      expect(source).toContain("Open Shopify order")
      expect(source).toContain('target="_blank"')
      expect(source).toContain('rel="noopener noreferrer"')
    })

    it("source renders the human order number whenever the document carries one, independent of the deep link", () => {
      // Imported documents carry an order number but no shop domain to link to,
      // so the reference must not be gated on shopifyOrderUrl().
      expect(source).toContain("document-detail-order-number")
      expect(source).toMatch(/Show when=\{doc\(\)\.shopify_order_number\}/)
    })

    // red: drop the po_number Show block from the header strip -> the customer's PO
    // number is on the document row but nowhere for an operator to see it next to
    // the Shopify order reference.
    it("source renders the customer's PO number next to the Shopify order number", () => {
      expect(source).toContain("document-detail-po-number")
      expect(source).toMatch(/Show when=\{doc\(\)\.po_number\}/)
      expect(source).toContain("PO number")
    })

    // red: drop the notes block from the header -> free-text mentions printed on the
    // PDF are invisible to the operator reading the document in the app.
    it("source renders the document notes under the PO-number strip, preserving line breaks", () => {
      expect(source).toContain("document-detail-notes")
      expect(source).toMatch(/Show when=\{doc\(\)\.notes\}/)
      expect(source).toContain("whitespace-pre-wrap")
      // The label is translated (tr) and keeps its trailing space before the text.
      expect(source).toContain('{tr("Notes")} </span>')
    })
  })

  // ── Payment-status badge (feature 1's visible half) ──────────────────────

  // ── Convert to invoice: confirmation dialog + result handling ──────────
  //
  // Converting is irreversible and, for a Shopify-linked quote, reaches into
  // Shopify and creates a real order, so the click must open a dialog and the
  // tool must fire only after the human confirms.
  describe("convert to invoice", () => {
    it("offers the action only for a quote in sent/accepted and a proforma in sent", () => {
      expect(canConvertToInvoice({ type: "quote", status: "sent" })).toBe(true)
      expect(canConvertToInvoice({ type: "quote", status: "accepted" })).toBe(true)
      expect(canConvertToInvoice({ type: "quote", status: "draft" })).toBe(false)
      expect(canConvertToInvoice({ type: "quote", status: "rejected" })).toBe(false)
      expect(canConvertToInvoice({ type: "quote", status: "invoiced" })).toBe(false)
      expect(canConvertToInvoice({ type: "proforma", status: "sent" })).toBe(true)
      expect(canConvertToInvoice({ type: "proforma", status: "issued" })).toBe(false)
      expect(canConvertToInvoice({ type: "purchase_order", status: "sent" })).toBe(false)
      expect(canConvertToInvoice({ type: "invoice", status: "issued" })).toBe(false)
      expect(canConvertToInvoice({ type: "credit_note", status: "issued" })).toBe(false)
    })

    it("the footer button is gated on canConvertToInvoice, not on the type alone", () => {
      expect(source).toContain("<Show when={canConvertToInvoice(doc())}>")
      expect(source).not.toMatch(
        /Show when=\{doc\(\)\.type !== "invoice" && doc\(\)\.type !== "credit_note"\}/,
      )
    })

    it("the button opens the dialog and does NOT invoke the tool directly", () => {
      // onClick asks; only the dialog's onConfirm invokes.
      expect(source).toContain("onClick={askConvertToInvoice}")
      expect(source).toContain("setConfirmConvert(true)")
      expect(source).toContain("onConfirm={() => void runConvertToInvoice()}")
      expect(source).toMatch(
        /runConvertToInvoice = async[\s\S]{0,320}invokeTool<unknown>\(FOOTER_ACTIONS\.convert_to_invoice\.tool/,
      )
      // The old fire-on-click handler is gone.
      expect(source).not.toContain("const convertToInvoice = () => void invoke(")
    })

    it("cancelling closes the dialog and invokes nothing", () => {
      expect(source).toContain("onCancel={() => setConfirmConvert(false)}")
      // onCancel carries no tool call.
      const cancel = source.slice(source.indexOf("onCancel={() => setConfirmConvert(false)}"))
      expect(cancel.slice(0, 80)).not.toContain("invokeTool")
    })

    it("renders the ConfirmDialog with the agreed testid and confirm label", () => {
      expect(source).toContain("<ConfirmDialog")
      expect(source).toContain('testid="document-detail-confirm-convert"')
      expect(source).toContain("confirmLabel={tr(FOOTER_ACTIONS.convert_to_invoice.label)}")
      expect(FOOTER_ACTIONS.convert_to_invoice.label).toBe("Convert to invoice")
    })

    it("the dialog body names the Shopify draft order when the quote is linked", () => {
      expect(convertConfirmBody({ type: "quote", shopify_draft_order_name: "#D12" })).toBe(
        "This completes draft order #D12 in Shopify and creates the order. The invoice is issued from that order automatically.",
      )
      expect(convertConfirmBody({ type: "quote", shopify_draft_order_name: null })).toBe(
        "This issues an invoice from this quote.",
      )
      expect(convertConfirmBody({ type: "proforma" })).toBe(
        "This issues an invoice from this proforma.",
      )
    })

    it("no dash punctuation in the convert copy (customer-visible strings)", () => {
      for (const copy of [
        convertConfirmBody({ type: "quote", shopify_draft_order_name: "#D12" }),
        convertConfirmBody({ type: "proforma" }),
        convertResultNote({
          status: "completed",
          mode: "shopify_order_created",
          shopify_order_number: "#1149",
        }) ?? "",
        convertResultNote({ status: "pending_approval", approval_id: "a1" }) ?? "",
      ]) {
        expect(copy).not.toMatch(/\u2014|\u2013|--/)
      }
    })

    it("a shopify_order_created result renders the order-created note", () => {
      expect(
        convertResultNote({
          status: "completed",
          mode: "shopify_order_created",
          shopify_order_id: "gid://shopify/Order/456",
          shopify_order_number: "#1149",
          document_id: "doc-1",
        }),
      ).toBe("Order #1149 created in Shopify. The invoice is being issued.")
      // Shopify occasionally has not resolved the order name yet.
      expect(
        convertResultNote({
          status: "completed",
          mode: "shopify_order_created",
          shopify_order_number: null,
        }),
      ).toBe("Order created in Shopify. The invoice is being issued.")
      expect(source).toContain("document-detail-convert-result")
    })

    it("a pending_approval result says so, an error surfaces its message, a local convert stays quiet", () => {
      expect(convertResultNote({ status: "pending_approval", approval_id: "a1" })).toBe(
        "Sent for approval.",
      )
      expect(
        convertResultNote({
          status: "error",
          error: { code: "not_convertible", message: "Quote already invoiced." },
        }),
      ).toBe("Quote already invoiced.")
      expect(
        convertResultNote({
          status: "completed",
          mode: "local",
          document_id: "doc-2",
          number: "INV-1",
        }),
      ).toBeNull()
      expect(convertResultNote(null)).toBeNull()
    })

    it("a { blocked } envelope (the kernel's actual gated-call shape) also says 'Sent for approval.'", () => {
      // The kernel gates a call by returning `{ blocked: {...} }` in place of
      // the handler's result, not a `status: "pending_approval"` field —
      // `convertResultNote` checked only the latter, so a real gated convert
      // rendered no note at all (the `Show when={convertNote()}` block never
      // appeared).
      expect(
        convertResultNote({ blocked: { approvalRequestId: "a1", requesterCanApprove: false } }),
      ).toBe("Sent for approval.")
    })
  })

  // ── Shopify draft-order linkage ────────────────────────────────────────
  it("the header names the Shopify draft order when the document is linked", () => {
    expect(source).toContain("document-detail-draft-order-ref")
    expect(source).toContain("<Show when={doc().shopify_draft_order_name}>")
    expect(source).toContain("Shopify draft order")
  })

  // ── Legacy draft rows ──────────────────────────────────────────────────
  it("keeps the draft-only Edit / Delete actions, returning to All documents after a delete", () => {
    // Legacy draft rows stay reachable by direct link; the Drafts route is gone.
    expect(source).toContain("document-detail-action-delete-draft")
    expect(source).toContain("document-detail-action-edit-draft")
    expect(source).toContain('navigate("/invoicing/documents/all")')
    expect(source).not.toContain("/invoicing/documents/drafts")
  })

  describe("payment-status badge", () => {
    it("source renders document-detail-payment-chip gated on payment_status, excluding credit notes", () => {
      expect(source).toContain("document-detail-payment-chip")
      expect(source).toMatch(
        /Show when=\{doc\(\)\.type !== "credit_note" && doc\(\)\.payment_status\}/,
      )
    })

    it("PAYMENT_LABEL / PAYMENT_TONE cover paid, partial, refunded, unpaid", () => {
      expect(source).toMatch(/paid:\s*"success"/)
      expect(source).toMatch(/partial:\s*"warning"/)
      expect(source).toMatch(/refunded:\s*"muted"/)
      expect(source).toMatch(/unpaid:\s*"neutral"/)
      expect(source).toContain('paid: "Paid"')
      expect(source).toContain('partial: "Partial"')
      expect(source).toContain('refunded: "Refunded"')
      expect(source).toContain('unpaid: "Unpaid"')
    })
  })
})

// "Send to customer" used to succeed in silence: the button went quiet and the operator could not
// tell a sent document from a click that did nothing.
// red: make footerActionResultNote return null for a completed send -> no confirmation at all.
describe("send to customer confirmation", () => {
  it("a completed send confirms discreetly and clears itself", () => {
    const note = footerActionResultNote(FOOTER_ACTIONS.send_to_customer.tool, {
      status: "completed",
      dispatched: true,
    })
    expect(note).toEqual({
      text: "Sent to the customer.",
      isError: false,
      autoDismissMs: ACTION_NOTE_DISMISS_MS,
    })
  })

  it("a gated send says it went for approval and does not claim it was sent", () => {
    const note = footerActionResultNote(FOOTER_ACTIONS.send_to_customer.tool, {
      blocked: { approvalRequestId: "a1" },
    })
    expect(note).toEqual({ text: "Sent for approval.", isError: false })
  })

  it("a returned error envelope surfaces its message instead of looking like success", () => {
    const note = footerActionResultNote(FOOTER_ACTIONS.send_to_customer.tool, {
      status: "error",
      error: { code: "no_recipient", message: "No email address for this customer." },
    })
    expect(note).toEqual({ text: "No email address for this customer.", isError: true })
  })

  it("the component wires the note through the self dismissing setter", () => {
    expect(source).toContain("footerActionResultNote(action.tool, result)")
    expect(source).toContain("setTimeout(")
  })
})

describe("DocumentDetail regime line", () => {
  it("mounts the regime line under the customer block, for invoices and credit notes only", () => {
    expect(source).toContain('import { RegimeLine } from "./einvoicing/RegimeLine"')
    expect(source).toMatch(
      /<CustomerBlock doc=\{p\.doc\} \/>\s*<Show when=\{p\.doc\.type === "invoice" \|\| p\.doc\.type === "credit_note"\}>\s*<RegimeLine/,
    )
  })
})

describe("toLoadedDocument: an id that resolves to nothing", () => {
  it("is not found for a null result (another org's document, a deleted draft)", () => {
    expect(toLoadedDocument(null)).toBeNull()
    expect(toLoadedDocument(undefined)).toBeNull()
  })

  it("is not found for a shape without an id and a status, never a half-empty document", () => {
    // The host once handed a `{ data: null }` envelope through as the document itself: every
    // field undefined, and the status badge's humanize() crashed the tab on `.replace`.
    expect(toLoadedDocument({ data: null })).toBeNull()
    expect(toLoadedDocument({})).toBeNull()
  })

  it("throws a tool error instead of calling it not found", () => {
    expect(() =>
      toLoadedDocument({ status: "error", error: { message: "boom", code: "internal" } }),
    ).toThrow("boom")
  })

  it("reads the flat shape and the legacy envelope", () => {
    const doc = { id: "d1", type: "invoice", status: "issued", currency: "EUR" }
    const line = { id: "l1" }
    expect(toLoadedDocument({ ...doc, lines: [line] })).toMatchObject({
      document: { id: "d1", status: "issued" },
      lines: [line],
      externalTabs: [],
    })
    expect(toLoadedDocument({ document: doc, lines: [line] })).toMatchObject({
      document: { id: "d1" },
      lines: [line],
    })
  })

  it("renders a not-found state when the resource resolves to nothing", () => {
    expect(source).toContain('data-testid="document-detail-not-found"')
  })
})

describe("an invoice issued by Liaison and collected elsewhere", () => {
  const base = {
    status: "issued",
    type: "invoice",
    stream: "card" as const,
    payment_status: "unpaid",
    einvoice_state: "sent",
    collection_state: null,
  }

  it("Collected shows only after an accepted report", () => {
    // Paid, but nothing reported yet, or the report failed: never Collected.
    expect(einvoiceStatusWord({ ...base, payment_status: "paid" })).not.toBe("Collected")
    expect(
      einvoiceStatusWord({ ...base, payment_status: "paid", collection_state: "failed" }),
    ).not.toBe("Collected")
    expect(
      einvoiceStatusWord({ ...base, payment_status: "paid", collection_state: "reported" }),
    ).toBe("Collected")
  })

  it("chips say who issued and who took the payment, and the payment only once it is in", () => {
    expect(moneyChips(base)).toEqual(["Issued by Liaison"])
    expect(moneyChips({ ...base, payment_status: "paid" })).toEqual([
      "Issued by Liaison",
      "Collected by Stripe",
    ])
    expect(moneyChips({ ...base, stream: "transfer", payment_status: "paid" })).toEqual([
      "Issued by Liaison",
    ])
    // A draft, a quote, or a document from no stream gets no chip.
    expect(moneyChips({ ...base, status: "draft" })).toEqual([])
    expect(moneyChips({ ...base, type: "quote" })).toEqual([])
    expect(moneyChips({ ...base, stream: null })).toEqual([])
  })
})

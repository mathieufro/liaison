// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing-pa@1 op handlers (manifest tools: internal, invisible to agents, ungated,
// contractOnly — reachable only through the kernel contract dispatch from the bound caller).
import type { BookingData, EinvoiceBuyer } from "@liaison/app-sdk/contracts"
import type { PennylaneToolCtx } from "../ctx"
import { getClient } from "../lib/get-client"
import { PennylaneClient } from "../lib/pennylane-client"
import {
  fetchReceivedFile,
  getReceived,
  listReceived,
  type ReceptionCtx,
  setReceivedStatus,
} from "../received/received"
import { bookSale, findBooking } from "./book"
import { fromException, type OpError } from "./errors"
import { listStatusChanges } from "./inbox"
import {
  advanceEinvoice,
  findEinvoice,
  getEinvoiceStatus,
  registrationStatus,
  submitEinvoice,
} from "./send"
import { readAppConfig, SUBSCRIPTION_KEY } from "./webhooks"

async function withClient<T>(
  ctx: PennylaneToolCtx,
  what: string,
  fn: (c: PennylaneClient) => Promise<T>,
): Promise<T | OpError> {
  let client: PennylaneClient
  try {
    client = ctx.__client instanceof PennylaneClient ? ctx.__client : (await getClient(ctx)).client
  } catch (e) {
    return fromException(e, what)
  }
  return fn(client)
}

export const einvoicingRegistrationStatus = (_p: Record<string, never>, ctx: PennylaneToolCtx) =>
  withClient(ctx, "registration_status", async (c) => {
    try {
      const reg = await registrationStatus(c)
      const sub = await readAppConfig<{ id: number; callback_url: string; at: string }>(
        ctx,
        SUBSCRIPTION_KEY,
      )
      return {
        ...reg,
        webhook: sub
          ? { configured: true, subscription_id: sub.id, since: sub.at }
          : { configured: false },
      }
    } catch (e) {
      return fromException(e, "registration_status")
    }
  })

export const einvoicingFind = (
  p: { invoice_number: string; issue_date: string },
  ctx: PennylaneToolCtx,
) => withClient(ctx, "find_einvoice", (c) => findEinvoice(c, p))

export const einvoicingSubmit = (
  p: {
    document_ref: string
    invoice_number: string
    issue_date: string
    facturx_file_id: string
    legal_original_sha256: string
    cii_xml: string
    buyer: EinvoiceBuyer
    idempotency_key: string
    stream_ref?: string
    run_item_ref?: string
  },
  ctx: PennylaneToolCtx,
) => {
  // `stream_ref` and `run_item_ref` bind the dispatch grant of a person's decision; Pennylane never sees them.
  const { stream_ref: _stream, run_item_ref: _item, ...send } = p
  return withClient(ctx, "submit_einvoice", (c) => submitEinvoice(c, send))
}

export const einvoicingAdvance = (
  p: {
    provider_ref: string
    invoice_number: string
    issue_date: string
    document_ref?: string
    legal_original_sha256?: string
    stream_ref?: string
    run_item_ref?: string
  },
  ctx: PennylaneToolCtx,
) => {
  const { stream_ref: _stream, run_item_ref: _item, ...step } = p
  return withClient(ctx, "advance_einvoice", (c) => advanceEinvoice(c, step))
}

export const einvoicingStatus = (p: { provider_ref: string }, ctx: PennylaneToolCtx) =>
  withClient(ctx, "get_einvoice_status", (c) => getEinvoiceStatus(c, p))

export const einvoicingStatusChanges = (
  p: { cursor?: string | null; kind?: string | null },
  ctx: PennylaneToolCtx,
) => listStatusChanges(ctx, p)

export const einvoicingFindBooking = (p: { idempotency_key: string }, ctx: PennylaneToolCtx) =>
  withClient(ctx, "find_booking", (c) => findBooking(c, p))

export const einvoicingBook = (
  p: {
    document_ref: string
    pdf_file_id: string
    legal_original_sha256: string
    data: BookingData
    idempotency_key: string
  },
  ctx: PennylaneToolCtx,
) => withClient(ctx, "book_sale", (c) => bookSale(c, p))

// — reception (optional ops) —
export const einvoicingReceivedList = (p: { cursor?: string | null }, ctx: PennylaneToolCtx) =>
  listReceived(ctx, p)
export const einvoicingReceivedGet = (p: { provider_ref: string }, ctx: PennylaneToolCtx) =>
  getReceived(ctx, p)
export const einvoicingReceivedFile = (
  p: {
    provider_ref: string
    file: "original" | "rendering"
    target: { app: string; entity_type: string; entity_id: string }
  },
  ctx: ReceptionCtx,
) => fetchReceivedFile(ctx, p)
export const einvoicingReceivedSetStatus = (
  p: { provider_ref: string; status: string; reason?: string | null; comment?: string | null },
  ctx: PennylaneToolCtx,
) => setReceivedStatus(ctx, p)

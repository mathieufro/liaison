// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared, precise tool/handler context shapes. These replace the per-file
// `db: any; fetch: any` + `ctx as never` casts the orchestrator layer used to
// carry — the helpers (`getClient`, `reserveCreate`, …) already declare exact
// shapes, so the ctx must too. `BoxtalToolCtx` is a structural superset that
// satisfies every helper's narrower requirement, so a single typed `ctx` flows
// through `getClient(ctx)`, `reserveCreate(ctx, …)`, etc. with no casts.

import type { CrossAppEnvelope, DbClient } from "@liaison/app-sdk"
import type { BoxtalFetch } from "./lib/boxtal-v3-client"

export type { CrossAppEnvelope }

export interface BoxtalLogger {
  info?(msg: string, data?: unknown): void
  warn?(msg: string, data?: unknown): void
  error?(msg: string, data?: unknown): void
  debug?(msg: string, data?: unknown): void
}

/**
 * The context every Boxtal tool handler receives. `db` is the generic CRUD
 * bridge (`DbClient`); `fetch` is the host fetch shaped like `BoxtalFetch`;
 * `connections` is the dual-shape credentials accessor (resolved in
 * `get-client.ts`); `config.get` / `config.has` read the kernel-minted app config;
 * `executeTool` is the cross-app K4 envelope.
 */
export interface BoxtalToolCtx {
  orgId: string
  db: DbClient
  fetch: BoxtalFetch
  connections: unknown
  config: { get(key: string): Promise<unknown>; has(key: string): Promise<boolean> }
  executeTool: (
    target: string,
    args: string | Record<string, unknown>,
  ) => Promise<CrossAppEnvelope>
  logger?: BoxtalLogger
  /** Emit one of the app's declared events (manifest `events.emits`); the attention
   *  translations turn some of them into attention items. */
  emit?: (event: {
    entity: string
    action: string
    entityId?: string
    data?: Record<string, unknown>
  }) => Promise<void>
  /** Host bridge: binary-safe import of an upstream signed URL (a label PDF)
   *  into kernel.files under one of THIS app's fileParents. Optional — present
   *  in the real sandbox runtime; tests exercising the label-import path stub
   *  it. Args/result are JSON strings (bridge convention). */
  files_importFromUrl?: (argsJson: string) => Promise<string>
  /** Host bridge: list this app's files on one parent (`{ app, entityType, entityId }`). */
  files_listAttachments?: (parentJson: string) => Promise<string>
  /** Host bridge (capability `files.analyzeDocument`): read one of this app's own files with the
   *  org's media model. `{ fileId, prompt }` -> `{ text, model }` or `{ error: { code, message } }`.
   *  Absent where the host has no such seam; the label reader then marks "tracking to confirm". */
  files_analyzeDocument?: (argsJson: string) => Promise<string>
  /** Approval handler-protocol bridges (no-ops outside an approval execution).
   *  Used by create_shipment to park the sequence on `awaiting_output` when the
   *  label PDF has not generated yet — the kernel poll job (manifest
   *  `pollHandler`) then materializes the outputs and resumes the cascade. */
  approval_recordStarted?: (toolName: string) => Promise<void>
  approval_recordAwaitingOutput?: (toolName: string, externalRefJson?: string) => Promise<void>
  /** Set only when the kernel re-runs a call a human approved; null or absent on a
   *  direct call (a Ship click by someone who may approve runs with no approval). */
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  /** The calling user (host bridge; async in the sandbox worker). Absent in some test ctxs. */
  getUserId?: () => Promise<string> | string
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TYPED HOST CALLS AN APP'S SCREENS MAKE INSTEAD OF REACHING KERNEL ROUTES.
//
// A framed app (isolated-app.tsx) reaches only its own `/api/apps/<app>/...`
// routes through `fetch`. What it needs beyond them is a call of its own here,
// answered by the page with the person's session, each one bound to the
// calling app and limited to what that app may do:
//
// - `context()`: org and person (ids, names, locale), never a token;
// - `openFileById(fileId, filename)`: the host fetches the file and opens it (the
//   desktop shell in its viewer, a browser in a new tab or a download); no bytes
//   go back to the app. The frame only names ids it saw in its own results or
//   files attached to its own records (checked in isolated-app.tsx);
// - `listDocumentTemplates(entity)` / `printDocuments(...)`: the org's templates
//   and prints for one of the app's own record types (the app is the caller);
// - `listMyApprovals()`: the pending approvals of this app's own tools that the
//   person may decide;
// - `decideApproval(id, decision, payloadHash)`: the HOST asks the person in its
//   own dialog (an app's button is never the decision), checks the approval is
//   one of this app's tools, and approves the payload fingerprint the HOST read and
//   showed (an app's differing one, or an edit during the dialog, is refused);
// - `editApproval(id, fields)`: one of this app's own pending approvals, through the
//   approvals route, which changes only the fields the tool declares editable;
// - `openExternal(url)`: https only, a host the app's manifest declares, never
//   this page's origin; opened with noopener and noreferrer;
// - `openRecord(app, entity, id)`: another app's record in its own tab (the
//   person's session decides whether it shows); `openApprovals()`: the queue.
//
// In-page (first-party) apps get the same calls with the app bound by the SDK;
// the frame adds its own checks on top.

import type {
  HostContext,
  HostDocumentTemplate,
  HostPrintRequest,
  HostPrintResult,
} from "@liaison/host"
import { getTabType, urlToTabInfo } from "~/framework/app-registry"
import { userFromToken } from "~/modules/auth/auth-store"
import { canOpenDownloadedFile, openDownloadedFile } from "~/modules/desktop/desktop-store"
import { currentLocale } from "~/modules/i18n/i18n-context"
import { confirmAppApproval } from "~/modules/shell/app-approval-confirm"
import { orgName } from "~/modules/shell/branding-store"
import { openTab } from "~/modules/shell/tab-store"

/** An id as the kernel mints them (uuid-like), nothing a path could be built from. */
export const KERNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** A record type as manifests spell them. */
const ENTITY_NAME = /^[a-zA-Z][\w-]*$/
const APP_NAME = /^[a-z][a-z0-9-]*$/

/** The hosts each app's manifest declares (the app list's `externalHosts`), for openExternal. */
const declaredHosts = new Map<string, readonly string[]>()

/** Record the hosts an app declares (bootstrap, from the app list). */
export function setAppExternalHosts(app: string, hosts: readonly string[] | undefined): void {
  if (hosts && hosts.length > 0) declaredHosts.set(app, [...hosts])
  else declaredHosts.delete(app)
}

/** The hosts an app declares, for openExternal. */
export function appExternalHosts(app: string): readonly string[] {
  return declaredHosts.get(app) ?? []
}

export interface AppHostCallDeps {
  fetch: <T = unknown>(path: string, init?: RequestInit) => Promise<T>
  fetchBlob: (path: string) => Promise<Blob>
  navigate: (path: string) => void
  /**
   * Sends the person's decision. Wired to the decision queue (decision-queue.ts),
   * the one place a decision is sent: it waits out the Undo window like every
   * other approve and reject.
   */
  decide: (
    approvalId: string,
    body: { decision: "approve" | "deny"; payloadHash?: string },
    label: { title: string } | null,
  ) => Promise<unknown>
}

/** A kernel approval row, as far as the host reads it. */
interface ApprovalRow {
  id: string
  status?: string
  toolName?: string
  summary?: { title?: string; subtitle?: string; lines?: string[] } | null
  payloadHash?: string
}

/** Whether `host` is one of the hosts declared (`*.example.com` covers sub-hosts only). */
export function hostDeclared(host: string, declared: readonly string[]): boolean {
  const h = host.toLowerCase()
  return declared.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1
    return h === p
  })
}

/**
 * The URL an app may open in a new tab, or null: https only, no credentials in
 * it, a host its manifest declares, never this page's own origin (use navigate).
 */
export function externalTarget(
  url: unknown,
  declared: readonly string[],
  pageOrigin: string,
): string | null {
  if (typeof url !== "string" || url.length > 4_096) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
  if (parsed.origin === pageOrigin) return null
  if (!hostDeclared(parsed.hostname, declared)) return null
  return parsed.href
}

/** Open a URL in a new tab with no opener and no referrer. */
function openNewTab(url: string): void {
  if (typeof window === "undefined") return
  window.open(url, "_blank", "noopener,noreferrer")
}

/** Show bytes the host fetched: the desktop viewer, else a new tab, else a download. */
async function showFile(blob: Blob, filename: string, preOpened: Window | null): Promise<void> {
  if (canOpenDownloadedFile()) {
    preOpened?.close()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (await openDownloadedFile(bytes, filename)) return
    throw new Error(`the desktop app could not open ${filename}`)
  }
  const url = URL.createObjectURL(blob)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  if (preOpened && !preOpened.closed) {
    preOpened.location.href = url
    return
  }
  // No tab could be opened (the click is too long ago for a popup): a download.
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function buildAppHostCalls(deps: AppHostCallDeps) {
  return {
    context: (): HostContext | null => {
      const user = userFromToken()
      if (!user) return null
      const locale = currentLocale()
      return {
        orgId: user.orgId,
        orgName: orgName() ?? "",
        locale,
        user: { id: user.userId, name: user.name, locale },
      }
    },

    openFileById: async (_app: string, fileId: string, filename: string): Promise<void> => {
      if (!KERNEL_ID.test(fileId)) throw new Error("openFile: a file id is required")
      const name = (typeof filename === "string" && filename.trim()) || "document"
      // A tab opened now, inside what is left of the click, survives the fetch below.
      let preOpened: Window | null = null
      if (!canOpenDownloadedFile() && typeof window !== "undefined") {
        try {
          preOpened = window.open("", "_blank")
          if (preOpened) preOpened.opener = null
        } catch {
          preOpened = null
        }
      }
      let blob: Blob
      try {
        blob = await deps.fetchBlob(`/api/files/${encodeURIComponent(fileId)}/inline`)
      } catch (err) {
        preOpened?.close()
        throw err
      }
      await showFile(blob, name.slice(0, 200), preOpened)
    },

    listDocumentTemplates: (app: string, entity: string): Promise<HostDocumentTemplate[]> => {
      if (!ENTITY_NAME.test(entity)) throw new Error("listDocumentTemplates: an entity is required")
      return deps.fetch<HostDocumentTemplate[]>(
        `/api/documents/templates?app=${encodeURIComponent(app)}&entity=${encodeURIComponent(entity)}`,
      )
    },

    printDocuments: (app: string, request: HostPrintRequest): Promise<HostPrintResult> => {
      if (!ENTITY_NAME.test(request.entity) || !KERNEL_ID.test(request.id)) {
        throw new Error("printDocuments: an entity and a record id are required")
      }
      const templateIds = request.templateIds.filter((id) => KERNEL_ID.test(id)).slice(0, 50)
      return deps.fetch<HostPrintResult>("/api/documents/print", {
        method: "POST",
        body: JSON.stringify({
          app,
          entity: request.entity,
          recordId: request.id,
          templateIds,
          ...(request.merge ? { merge: true } : {}),
        }),
      })
    },

    listMyApprovals: async (app: string): Promise<unknown[]> => {
      const rows = await deps.fetch<unknown>(
        `/api/approvals?status=pending&decidableByMe=true&app=${encodeURIComponent(app)}`,
      )
      const list = Array.isArray(rows) ? rows : []
      // Only this app's own tools, whatever the server's filter did.
      return list.filter(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as ApprovalRow).toolName === "string" &&
          ((row as ApprovalRow).toolName as string).startsWith(`${app}:`),
      )
    },

    decideApproval: async (
      app: string,
      approvalId: string,
      decision: "approve" | "deny",
      payloadHash?: string,
    ): Promise<unknown> => {
      if (!KERNEL_ID.test(approvalId)) throw new Error("decideApproval: an approval id is required")
      if (decision !== "approve" && decision !== "deny") {
        throw new Error("decideApproval: decision must be approve or deny")
      }
      const read = async (): Promise<ApprovalRow & { toolName: string }> => {
        const row = await deps.fetch<ApprovalRow>(
          `/api/approvals/${encodeURIComponent(approvalId)}`,
        )
        if (!row || typeof row.toolName !== "string" || !row.toolName.startsWith(`${app}:`)) {
          throw new Error("decideApproval: not an approval of this app")
        }
        if (row.status !== undefined && row.status !== "pending") {
          throw new Error("decideApproval: this approval is no longer pending")
        }
        return { ...row, toolName: row.toolName }
      }
      const approval = await read()
      // The approve is bound to the payload the HOST read and shows, never to a
      // fingerprint the app hands over: an app that saw another version is refused.
      const shown = typeof approval.payloadHash === "string" ? approval.payloadHash : undefined
      const asked = typeof payloadHash === "string" && payloadHash ? payloadHash : undefined
      if (decision === "approve") {
        if (!shown) throw new Error("decideApproval: this approval carries no payload fingerprint")
        if (asked !== undefined && asked !== shown) {
          throw new Error("decideApproval: the approval changed since the app showed it")
        }
      }
      // The person decides in the host's own dialog: an app's button only asks.
      const confirmed = await confirmAppApproval({
        app,
        decision,
        title: approval.summary?.title?.trim() || approval.toolName,
        lines: (approval.summary?.lines ?? []).filter((l): l is string => typeof l === "string"),
      })
      if (!confirmed) throw new Error("decideApproval: cancelled")
      if (decision === "approve") {
        // An edit made while the dialog was open: what the person read is not what would run.
        const now = await read()
        if (now.payloadHash !== shown) {
          throw new Error("decideApproval: the approval changed while you were deciding")
        }
      }
      // Through the decision queue, like every other approve and reject: the
      // Undo window applies, and the decision toast names what was decided.
      return deps.decide(
        approvalId,
        decision === "approve" ? { decision, payloadHash: shown } : { decision },
        { title: approval.summary?.title?.trim() || approval.toolName },
      )
    },

    editApproval: async (
      app: string,
      approvalId: string,
      fields: Record<string, unknown>,
    ): Promise<{ currentPayload?: Record<string, unknown>; payloadHash?: string }> => {
      if (!KERNEL_ID.test(approvalId)) throw new Error("editApproval: an approval id is required")
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error("editApproval: the fields to change are required")
      }
      const row = await deps.fetch<ApprovalRow>(`/api/approvals/${encodeURIComponent(approvalId)}`)
      if (!row || typeof row.toolName !== "string" || !row.toolName.startsWith(`${app}:`)) {
        throw new Error("editApproval: not an approval of this app")
      }
      if (row.status !== undefined && row.status !== "pending") {
        throw new Error("editApproval: this approval is no longer pending")
      }
      // The server checks each field against the tool's editable fields.
      return deps.fetch(`/api/approvals/${encodeURIComponent(approvalId)}/payload`, {
        method: "POST",
        body: JSON.stringify({ fields }),
      })
    },

    openExternal: async (app: string, url: string): Promise<void> => {
      const pageOrigin = typeof window !== "undefined" ? window.location.origin : ""
      const target = externalTarget(url, appExternalHosts(app), pageOrigin)
      if (!target) {
        throw new Error("openExternal: only an https page on a host this app declares")
      }
      openNewTab(target)
    },

    openRecord: (_caller: string, app: string, entity: string, id: string): void => {
      if (!APP_NAME.test(app) || !ENTITY_NAME.test(entity) || !KERNEL_ID.test(id)) {
        throw new Error("openRecord: an app, an entity and a record id are required")
      }
      // The record's own tab: `<app>:<entity>`, else the tab the app routes
      // `/<app>/<entity>/<id>` to (invoicing's `/invoicing/document/:documentId`),
      // else the generic detail page. The person's session decides what it shows.
      const type = `${app}:${entity}`
      if (getTabType(type)) {
        openTab({ type, entityId: id, label: id })
        return
      }
      const path = `/${encodeURIComponent(app)}/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`
      const routed = urlToTabInfo(path)
      if (routed && getTabType(routed.type)?.appId === app) {
        deps.navigate(path)
        return
      }
      deps.navigate(
        `/detail/${encodeURIComponent(app)}/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
      )
    },

    openApprovals: (): void => deps.navigate("/approvals"),
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host API version: the one version number for everything an app relies on
// from the server it runs in (its manifest shape, the sandbox bridge, the frame
// protocol, the host services). An app declares the range it needs as `host`
// in its manifest (a semver range, "^1" when absent); the server refuses to
// install, upgrade or load an app whose range it cannot satisfy.
//
// A change an app could notice as a break bumps the major; an addition bumps
// the minor. The server keeps answering every major listed below.
//
// 1.1: `currentPath()` (the page's path, which a framed app cannot read from its
// own location), the frame's `path` message and in-app links that move the page.
// 1.2: `app.trackOpenRecord()` (the record a page has open in a pane, which a turn
// sent from its tab names) and the frame's `setOpenRecord` call.
// 1.3: typed host calls a screen framed on an origin of its own needs: `getContext()`,
// `app.openFile(fileId)`, `app.listDocumentTemplates`/`printDocuments`,
// `app.listMyApprovals`/`decideApproval` (confirmed by the host), `app.openExternal`,
// `app.openRecord`, `app.openApprovals`.
// 1.4: `app.editApproval` (a person edits a pending approval's fields, confirmed by
// the host) and `prefill` on `mountEntityDiscussion` (text placed in the composer).
// 1.5: `app.tabLabel()` (names a page's tab after the record it shows; a host
// without it keeps the app's own tab label).

/** The host API version this build of Liaison provides. */
export const HOST_API_VERSION = "1.5.0"

/** The host API majors this build of Liaison answers. */
export const SUPPORTED_HOST_API_MAJORS: readonly number[] = [1]

/** The range assumed for a manifest that declares no `host`. */
export const DEFAULT_HOST_API_RANGE = "^1"

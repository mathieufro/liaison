// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * T1 — live app-registry discipline guard.
 *
 * The single rule this enforces (review §7, theme T1): KERNEL code that needs
 * to enumerate apps reads the LIVE registry (`listInstalledApps` /
 * `manifestRegistry`), never a static import list, and never branches on an
 * app-name literal. Hardcoded app knowledge in the kernel is the root cause of
 * B1 (GDPR erasure hardcodes 6 manifests), I-SBX-2 (RPC bridge hardcodes ~30
 * app methods), I-THR-3 (reference-display branches on `tickets`/`projects`),
 * and the connections/runtime app-name branches.
 *
 * This guard is STATIC ANALYSIS (mirrors `session-lifecycle-enforcement.test.ts`
 * and `check-migration-baseline.ts`). It scans kernel source — `modules/**`,
 * `services/**`, `infra/**` — and fails on:
 *
 *   (a) a branch on a NON-kernel app-name literal:
 *       `<ident> === "tickets"`, `=== "mail"`, `=== "shopify"`, …
 *       (`=== "kernel"` is exempt — `kernel` is the host, not an app, so
 *        distinguishing kernel-vs-app is structurally legitimate.)
 *
 *   (b) a hardcoded ARRAY of imported `app.manifest.json` modules in a
 *       compliance/enumeration path (the B1 `MANIFESTS = [...]` shape).
 *
 * Two allowlists narrow the scan to NEW violations only:
 *
 *   KNOWN_LITERAL_USES — every app-literal branch that exists today, keyed on
 *   the BRANCH TEXT in its file (never on a line number), annotated with its
 *   finding ID and the wave that drains it. Seeded so
 *   the guard is GREEN now (CI unblocked) while biting on any NEW app-literal
 *   branch a kernel module introduces. Drop each entry as its fix lands.
 *
 *   KNOWN_MANIFEST_ARRAYS — files that today build a hardcoded manifest array
 *   in a compliance/enumeration path (B1). Same drain semantics.
 *
 * The carved-out sandbox RPC bridge (`modules/apps/sandbox/rpc-bridge.ts`,
 * I-SBX-2) is owned by another agent and is excluded from the scan entirely.
 */
import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const apiSrc = path.resolve(__dirname, "..", "..")

/** Kernel source roots — code here MUST read the live registry, not literals. */
const KERNEL_DIRS = ["modules", "services", "infra"]

/** Excluded from the scan entirely (carve-out / not kernel-enumeration code). */
const EXCLUDED_FILE_SUFFIXES = [
  // I-SBX-2 — owned by another agent / deferred.
  path.join("modules", "apps", "sandbox", "rpc-bridge.ts"),
  // The same bridge, split into per-capability factories that rpc-bridge.ts composes.
  ...[
    "context.ts",
    "shared.ts",
    "identity.ts",
    "db.ts",
    "platform.ts",
    "agent.ts",
    "egress.ts",
    "mail.ts",
    "approvals.ts",
    "tickets.ts",
    "calendar.ts",
    "conversion.ts",
    "projects.ts",
    "knowledge.ts",
    "knowledge-curation.ts",
    "files.ts",
  ].map((name) => path.join("modules", "apps", "sandbox", "bridge", name)),
  // This guard itself + the accessor that documents the exemption.
  path.join("modules", "apps", "app-registry-discipline.test.ts"),
  path.join("modules", "apps", "app-registries.ts"),
]

/**
 * A pinned app-literal branch: the file it lives in and the BRANCH TEXT, with
 * `occurrences` where one file carries the identical branch more than once.
 *
 * KEYED ON THE TEXT, NOT ON A LINE NUMBER. Three rounds in a row re-pinned
 * `infra/events/event-subscribers.ts` because a line was inserted ABOVE the
 * branch, which says nothing about the branch and is not a review anyone
 * needs to do. Whitespace is normalised, so a reformat does not drift the pin
 * either; deleting the branch, or growing a second copy of it, still does.
 */
interface LiteralPin {
  file: string
  /** The branch line, whitespace-normalised. Compared by containment. */
  branch: string
  /** How many lines in that file carry this branch. Default 1, asserted exactly. */
  occurrences?: number
}

/** Whitespace-normalised source line, the form every pin is compared in. */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ")
}

/**
 * App-literal branches that exist today, each annotated with its finding ID +
 * draining wave. Adding a NEW app-literal branch in kernel code fails the
 * guard until it is either fixed (read the registry) or, if genuinely
 * unavoidable, triaged here.
 */
const KNOWN_LITERAL_USES: LiteralPin[] = [
  // Private mailboxes: an encrypted mailbox's attachment is the mail app's by
  // definition, and these two read mail-private state to refuse to expose it.
  {
    file: "modules/agent/media/media-analysis-tool.ts",
    branch:
      'if (file.app === "mail" && persistAllowed && (await deps.isPrivateMailFile(ctx.orgId, file.id))) {',
  },
  {
    file: "modules/mailbox-crypto/content-suppression.ts",
    branch: 'if (file.app !== "mail") return false',
  },
  // connections service — kernel connections flow branches on the mail app to
  // pick settings paths and to read mail-app-private tables (app_mail.accounts)
  // that the kernel cannot enumerate generically. WS-1/P1 drains.
  {
    file: "modules/apps/connections/service.ts",
    branch: 'if (appName === "mail") {',
    occurrences: 2,
  }, // appName === "mail" (loadMailAuthorizedConnectedAccounts)
  // (The settingsPath branch on mail was drained: settings-paths.ts reads the
  //  app's manifest, see "settings links are manifest-driven" below.)
  // attention feed decideInContext openTarget: a tickets-reply approval's
  // "Open" must land on the TICKET record, whose id lives in the gated call's
  // payload — a kernel-declared special case until manifests can declare an
  // openTarget resolver (32b461c3 landed without a pin; re-pinned after the
  // authority-module refactor shifted the file).
  // Opt-outs: the event that an address opted out is mail's (mail/suppression:added), and
  // the drafts it withdraws are kernel approval rows; the kernel owns the opt-out list.
  {
    file: "modules/approvals/withdraw-on-events.ts",
    branch:
      'if (event.app !== "mail" || event.entity !== "suppression" || event.action !== "added") return',
  },
  {
    file: "modules/approvals/attention.ts",
    branch: '...(appName === "tickets" && typeof r.current_payload?.ticketId === "string"',
  }, // appName === "tickets" (decideInContext openTarget)
  // (runtime-helpers.ts tickets branch was drained into the
  //  appScopeAliasProviders registry map — no literal branch remains.)
  // audit timeline route special-cases the mail conversation entity.
  {
    file: "modules/audit/timeline-routes.ts",
    branch: 'if (appName === "mail" && entityType === "conversation") {',
  }, // appName === "mail"
  // ...and the per-record visibility check that follows skips the entities the
  // two special cases above already checked. The text also occurs inside the
  // `if` above, hence two occurrences.
  {
    file: "modules/audit/timeline-routes.ts",
    branch: '(appName === "mail" && entityType === "conversation")',
    occurrences: 2,
  }, // appName === "mail" (already checked above)
  // websocket infra special-cases the knowledge synced_source entity.
  {
    file: "infra/websocket.ts",
    branch: 'if (app === "knowledge" && entity === "synced_source") {',
  }, // app === "knowledge"
  // websocket tickets sub-entity WS scope gate (F2): message/note/sla ride the
  // parent ticket read scope + dimension grants (an internal note is its own
  // `note` event since the tours work; it was a `message` event before, under
  // the same gate); inbox/category gate on their own read scopes. Built-in
  // kernel special-case mirroring the knowledge/mail gates; the sub-entity ->
  // scope map is intentionally kernel-declared here.
  {
    file: "infra/websocket.ts",
    branch:
      'if (app === "tickets" && (entity === "message" || entity === "note" || entity === "sla")) {',
  }, // app === "tickets" (message/note/sla scope+dimension gate)
  { file: "infra/websocket.ts", branch: 'if (app === "tickets" && entity === "inbox") {' }, // app === "tickets" (inbox -> tickets:inboxes:read)
  { file: "infra/websocket.ts", branch: 'if (app === "tickets" && entity === "category") {' }, // app === "tickets" (category -> tickets:categories:read)
  // websocket project_status WS frames ride project-read scopes (no
  // projects:project_status scope exists on any real grant).
  {
    file: "infra/websocket.ts",
    branch: 'if (app === "projects" && entity === "project_status") {',
  }, // app === "projects" && entity === "project_status"
  // websocket task / checklist-item frames ride the RLS read predicate of
  // app_projects.tasks (projects:projects:read); a tasks-only grant reads no row.
  {
    file: "infra/websocket.ts",
    branch: 'if (app === "projects" && (entity === "task" || entity === "task_checklist_item")) {',
  }, // app === "projects" && entity === "task" | "task_checklist_item"
  // websocket task-label frames ride the same projects read predicate as tasks.
  {
    file: "infra/websocket.ts",
    branch: 'if (app === "projects" && entity === "label") {',
  }, // app === "projects" && entity === "label"
  // websocket mail-account access gating branches on the mail app.
  { file: "infra/websocket.ts", branch: 'if (payload.app !== "mail") return true' }, // payload.app !== "mail"
  // routine draft-claim guard skips non-tickets events (built-in tickets flow).
  {
    file: "modules/agent/routines/routine-draft-claim-guard.ts",
    branch: 'if (ev.app !== "tickets") return null',
  }, // ev.app !== "tickets"
  // files attach label-resolution branches on the google-drive app to label
  // imported/staged material. P1: derive the label from the entity registry.
  {
    file: "modules/files/attach.ts",
    branch: 'label = row.sessionApp === "google-drive" ? "Google Drive" : "an imported file"',
  }, // sessionApp === "google-drive"
  // search indexer special-cases the tickets message-create event to index the
  // parent ticket (Meili ticket-search unification, 3418f7e4 — landed without a
  // pin). P1: dispatch through a registry-declared search-index subscriber.
  { file: "modules/search/indexer.ts", branch: 'event.app === "tickets" &&' }, // event.app === "tickets"
  // event subscribers special-case mail + mcp app events instead of dispatching
  // through a registry-declared subscriber map. P1 drains. The mcp resource-update
  // subscriber (Phase 15) routes notifications/resources/updated and is a genuine
  // built-in special-case.
  {
    file: "infra/events/event-subscribers.ts",
    branch: 'if (event.app !== "mail") return event.data',
  }, // event.app !== "mail" (enrichMailFanoutData)
  { file: "infra/events/event-subscribers.ts", branch: 'event.app === "mcp" &&' }, // event.app === "mcp" (isResourceUpdated: the resource-update subscriber)
  // Setup guides, setup state and connect cards. A Shopify store connection signs in
  // at a per-store authorize URL and a Google client is shared by several apps: the
  // guide family is chosen on that, with the app name as the fallback the manifest
  // cannot express yet (no per-connection "family" field). Drains when it can.
  { file: "modules/secret-requests/guides.ts", branch: 'return app === "shopify" ||' }, // isShopifyConnection
  {
    file: "modules/connection-guides/connection-setup.ts",
    branch: 'if (app === "shopify" || isShopifyAuthorizeUrl(decl.authorizationUrl))',
  }, // connectionFamily
  {
    file: "modules/connection-guides/google.ts",
    branch: 'c.app === "mail" && c.connection === "gmail"',
  }, // the Gmail push step of the Google guide
  {
    file: "modules/agent/tools/setup-state-tool.ts",
    branch: 'if (app === "shopify" && connection === "shop") {',
  }, // the shopify-setup skill
  {
    file: "modules/agent/tools/setup-state-tool.ts",
    branch: '|| app === "google-drive") {',
  }, // Drive's client is a Google client too
  // Entity discussions: a task's discussion is the task's own comment thread, kept by the
  // projects app, so it is never a second thread (a contact's is the kernel's).
  {
    file: "modules/threads/entity-discussion.ts",
    branch: 'ref.app === "projects" && ref.entityType === "task"',
  },
  // The tool bench reads the instruction text of real apps; the example app is the
  // template every new app copies, not a catalog the model is served.
  { file: "modules/agent/tools/tool-bench/bench.ts", branch: 'if (app === "example") continue' },
  // connect_link_send: a mail connection asks the person which mailbox kind they want.
  { file: "modules/agent/tools/connection-tools.ts", branch: '${params.app === "mail" ?' },
  // open-cards: the Google Calendar app's cards open under the calendar card kind.
  {
    file: "modules/agent/runtime/open-cards.ts",
    branch: 'if (app === "google-calendar" || app === "calendar") return "calendar"',
  },
  // Replayed system events: what state a fresh mailbox or ticket inbox connection is
  // in ("first sync pending") is mail- and tickets-specific copy for the agent.
  {
    file: "modules/agent/context/system-event-replay.ts",
    branch: 'if (target.connection === "imap" || target.app === "mail") {',
  },
  {
    file: "modules/agent/context/system-event-replay.ts",
    branch: 'if (target.app === "mail" || target.app === "tickets") {',
  },
  // A projects task discussion names its task line (loadDiscussionTaskLine).
  {
    file: "modules/agent/context/context.ts",
    branch: 'origin.app === "projects" && origin.entityType === "task"',
  },
  // websocket infra: a mail provider switch frame is gated on mail:accounts:read.
  { file: "infra/websocket.ts", branch: 'if (app === "mail" && entity === "provider") {' },
  // The demo commerce world follows an issued invoicing document to its shipment
  // (demo-only, never on a customer org).
  {
    file: "modules/demo/world/commerce-order.ts",
    branch:
      'if (event.app !== "invoicing" || event.entity !== "document" || event.action !== "issued") {',
  },
  // The new_email notification producer consumes the mail app's own message
  // events, the same filter as the other mail event subscribers above.
  {
    file: "modules/notifications/mail-producer.ts",
    branch:
      'if (event.app !== "mail" || event.entity !== "message" || event.action !== "create") return',
  }, // event.app !== "mail" (processNewEmailEvent)
  // (connection-health attention's settingsRouteFor tickets/mail branches were
  //  drained the same way: the route comes from the app's manifest.)
  // --- The encrypted-mailbox subsystem ----------------------------------
  // Mailbox plaintext is a MAIL-app concept: per-account keys, the
  // plaintext-never-at-rest invariant and the redaction of mail bodies out of
  // agent context exist only because the mail app stores sealed content. These
  // branches gate that machinery OFF for every other app rather than dispatching
  // on a capability, so a ticket subject or a Shopify note is never treated as
  // sealed mailbox plaintext. Kernel-declared by design, not a drain target:
  // generalizing would mean letting any app claim the mailbox key path.
  {
    file: "modules/mailbox-crypto/content-suppression.ts",
    branch: 'if (app !== "mail") return false',
    occurrences: 2,
  }, // app !== "mail"
  {
    file: "modules/mailbox-crypto/attachment-seal.ts",
    branch: 'if (input.app !== "mail") return null',
  }, // input.app !== "mail"
  {
    file: "modules/mailbox-crypto/approval-payload.ts",
    branch: 'if (input.appName !== "mail") return params',
  }, // input.appName !== "mail"
  // The agent's reader of email attachments (sealed ones through the owner's browser): a file
  // of any other app is never asked of the mailbox key path, and is read by analyze_media.
  {
    file: "modules/agent/media/mail-attachment-read.ts",
    branch: 'if (file.app !== "mail") {',
  }, // file.app !== "mail"
  {
    file: "modules/agent/mailbox-plaintext/mail-plaintext-redaction.ts",
    branch: 'if (parts?.app !== "mail") return result',
  }, // parts?.app !== "mail"
  {
    file: "modules/agent/mailbox-plaintext/mail-plaintext-redaction.ts",
    branch: 'if (parts?.app !== "mail") return args',
  }, // parts?.app !== "mail"
  // search doc-builder and thread reference-display read the same sealed-mail
  // carve-out (never index or render mail plaintext from the generic path).
  { file: "modules/search/doc-builder.ts", branch: 'reg.app === "mail"' }, // reg.app === "mail"
  { file: "modules/threads/reference-display.ts", branch: 'app === "mail" &&' }, // app === "mail"
  // event subscriber mail branch, sibling of the enrichMailFanoutData pin above
  // (same dispatch, same P1 drain: a registry-declared subscriber map).
  { file: "infra/events/event-subscribers.ts", branch: 'if (event.app === "mail") {' }, // event.app === "mail" (stripMessageContentForAudit)
  // Untrusted-content classification (the scope-taint pass): which file origins
  // and which trigger events carry outside text. Both fail CLOSED (an unknown
  // app is external), and the named apps are the ones whose rows are third-party
  // payloads by construction. Drain: a manifest-declared `untrustedSource` mark
  // on the entity/event, read from the live registry.
  { file: "modules/files/origin.ts", branch: 'r.app === "mail" ||' }, // fileIsFromOutside: a mailbox attachment
  {
    file: "modules/files/origin.ts",
    branch: 'r.sessionTargetApp === "google-drive",',
  }, // fileIsFromOutside: an integration import
  {
    file: "infra/jobs/event-routine-gate.ts",
    branch: 'return evt.app === "mail" && evt.entity === "message" && evt.action === "create"',
  }, // isMailSenderFilterEvent
  {
    file: "infra/jobs/event-routine-gate.ts",
    branch: 'if (evt.app === "social") return "external"',
  }, // triggerEventOrigin
  {
    file: "infra/jobs/event-routine-gate.ts",
    branch: 'if (evt.app === "mail" && evt.entity === "conversation") return "external"',
  }, // triggerEventOrigin
  { file: "infra/jobs/event-routine-gate.ts", branch: 'evt.app === "tickets" &&' }, // triggerEventOrigin: an inbound ticket message
]

/**
 * Files that hardcode a manifest array in a compliance/enumeration path (B1).
 * Key = relPath. WS-4 (erasure) replaces this with the live registry for the
 * org and fails erasure on any installed app missing an erasure declaration.
 */
const KNOWN_MANIFEST_ARRAYS = new Set<string>([
  // T1 — export orchestrator imports 6 app.manifest.json files to build a
  // hardcoded `APP_VERSIONS` map for the export manifest's `schemaVersions`.
  // The app ENUMERATION is already dynamic (exportRegistry); only the version
  // stamp is hardcoded. WS-4/P1: carry the version on the live registry entry
  // (or read kernel.apps_installed.version) and drop the static map.
  "modules/export/orchestrator.ts",
  // The CLI's built-in import kinds: an operator process that never registers apps
  // per org reads the five built-in manifests statically; the API resolves the same
  // kinds from the org's import registry.
  "modules/imports/builtin-kinds.ts",
])

function walk(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== "node_modules") {
      out.push(...walk(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

function kernelFiles(): string[] {
  const files: string[] = []
  for (const d of KERNEL_DIRS) files.push(...walk(path.join(apiSrc, d)))
  return files.filter((f) => !EXCLUDED_FILE_SUFFIXES.some((s) => f.endsWith(s)))
}

// Branch on a NON-kernel app-name literal. We match `<ident> === "literal"`
// and `<ident> !== "literal"` where the identifier ends in `app` / `appName`
// (case-insensitive) so we target app-name dispatch, not arbitrary string
// comparisons. `kernel` is exempt (host, not an app). A leading `typeof` is
// excluded so `typeof x.appName !== "string"` (a runtime type guard) is not a
// false positive; JS primitive type names are also never app names.
const APP_LITERAL_RE = /\b(\w*[aA]pp(?:Name)?)\s*[!=]==\s*"([a-z][a-z0-9-]*)"/g
const JS_TYPE_NAMES = new Set(["string", "number", "boolean", "object", "function", "undefined"])

/** App-name literals matched on a line, after dropping `kernel`, JS primitive
 *  type names, and `typeof <ident> === "<type>"` runtime guards. */
function appLiteralsOnLine(line: string): string[] {
  const out: string[] = []
  // A comment that QUOTES a branch (`// scoped to app === "mail", deliberately`)
  // is documentation, not dispatch. Skip `//` lines and block-comment bodies so
  // the guard pins real branches and prose cannot drift the pins.
  const t = line.trimStart()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return out
  APP_LITERAL_RE.lastIndex = 0
  let m: RegExpExecArray | null = APP_LITERAL_RE.exec(line)
  while (m !== null) {
    const literal = m[2]
    const before = line.slice(0, m.index)
    const isTypeof = /\btypeof\s*$/.test(before)
    if (literal !== "kernel" && !JS_TYPE_NAMES.has(literal) && !isTypeof) {
      out.push(literal)
    }
    m = APP_LITERAL_RE.exec(line)
  }
  return out
}

/** True when `line` in `rel` is one of the pinned branches. */
export function isPinnedBranch(pins: readonly LiteralPin[], rel: string, line: string): boolean {
  const normalized = normalizeLine(line)
  return pins.some((pin) => pin.file === rel && normalized.includes(normalizeLine(pin.branch)))
}

/** The pins that no longer describe their file, with why. */
export function stalePins(
  pins: readonly LiteralPin[],
  read: (rel: string) => string | null,
): string[] {
  const stale: string[] = []
  for (const pin of pins) {
    const content = read(pin.file)
    if (content === null) {
      stale.push(`${pin.file} (file gone): ${pin.branch}`)
      continue
    }
    const wanted = normalizeLine(pin.branch)
    const found = content
      .split("\n")
      .filter((line) => normalizeLine(line).includes(wanted) && appLiteralsOnLine(line).length > 0)
    const expected = pin.occurrences ?? 1
    if (found.length !== expected) {
      stale.push(
        `${pin.file} (${found.length} lines carry this branch, pinned ${expected}): ${pin.branch}`,
      )
    }
  }
  return stale
}

describe("T1 — live app-registry discipline", () => {
  it("no NEW app-name-literal branch in kernel code (modules/services/infra)", () => {
    const violations: string[] = []
    for (const file of kernelFiles()) {
      const rel = path.relative(apiSrc, file)
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, idx) => {
        for (const literal of appLiteralsOnLine(line)) {
          if (!isPinnedBranch(KNOWN_LITERAL_USES, rel, line)) {
            violations.push(
              `${rel}:${idx + 1}: branch on app literal "${literal}" — read the live registry`,
            )
          }
        }
      })
    }
    expect(violations).toEqual([])
  })

  it("no NEW hardcoded manifest array in a compliance/enumeration path", () => {
    const violations: string[] = []
    for (const file of kernelFiles()) {
      const rel = path.relative(apiSrc, file)
      if (KNOWN_MANIFEST_ARRAYS.has(rel)) continue
      const content = fs.readFileSync(file, "utf-8")
      // Heuristic: ≥2 default-imports from `app.manifest.json` modules in one
      // file is a hardcoded manifest list (a single app importing its own
      // manifest is fine; the kernel collecting many is the B1 smell).
      const manifestImports = content.match(/import\s+\w+\s+from\s+"[^"]*app\.manifest\.json"/g)
      if (manifestImports && manifestImports.length >= 2) {
        violations.push(
          `${rel}: imports ${manifestImports.length} app.manifest.json files — enumerate the live registry instead`,
        )
      }
    }
    expect(violations).toEqual([])
  })

  it("every pinned branch is still there, exactly as often as pinned", () => {
    // Keep the allowlist honest: if a fix lands or a file is reformatted, the
    // pinned line no longer matches — fail so the stale entry is removed rather
    // than silently masking a future violation at the same line number.
    const stale = stalePins(KNOWN_LITERAL_USES, (rel) => {
      const abs = path.join(apiSrc, rel)
      return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null
    })
    expect(stale).toEqual([])
  })

  // The pin mechanism itself, exercised on synthetic sources: a guard whose
  // allowlist is keyed on a line number has to be re-pinned every time an
  // unrelated line is inserted above the branch, which is three rounds of this
  // epic spent editing numbers. These two cases are the contract.
  it("a pin survives the code moving, and dies when the branch does", () => {
    const pins: LiteralPin[] = [{ file: "infra/x.ts", branch: 'if (event.app !== "mail") return' }]
    const branch = '  if (event.app !== "mail") return event.data'
    const before = `const a = 1\n${branch}\n`
    const moved = `const a = 1\nconst b = 2\nconst c = 3\n${branch}\n`
    const reformatted = `const a = 1\n  if (event.app  !==  "mail")   return event.data\n`
    const gone = "const a = 1\nif (isMailEvent(event)) return event.data\n"

    expect(isPinnedBranch(pins, "infra/x.ts", branch)).toBe(true)
    // Same branch, ten lines lower, and reformatted: still pinned, no edit.
    for (const source of [before, moved, reformatted]) {
      expect(stalePins(pins, () => source)).toEqual([])
    }
    // Removing the branch is exactly what the pin must notice.
    expect(stalePins(pins, () => gone)).toHaveLength(1)
    // And so is growing a second copy of it behind the pin's back.
    expect(stalePins(pins, () => `${branch}\n${branch}\n`)).toHaveLength(1)
    // A pin never covers another file's identical branch.
    expect(isPinnedBranch(pins, "infra/y.ts", branch)).toBe(false)
  })

  it("a duplicated branch is pinned by count, so losing one of the two is caught", () => {
    const pins: LiteralPin[] = [
      { file: "infra/x.ts", branch: 'if (app !== "mail") return false', occurrences: 2 },
    ]
    const two = 'if (app !== "mail") return false\nconst z = 1\nif (app !== "mail") return false\n'
    expect(stalePins(pins, () => two)).toEqual([])
    expect(stalePins(pins, () => 'if (app !== "mail") return false\n')).toHaveLength(1)
  })

  it("every allowlisted manifest-array file still imports ≥2 manifests", () => {
    const stale: string[] = []
    for (const rel of KNOWN_MANIFEST_ARRAYS) {
      const abs = path.join(apiSrc, rel)
      if (!fs.existsSync(abs)) {
        stale.push(`${rel} (file gone)`)
        continue
      }
      const content = fs.readFileSync(abs, "utf-8")
      const n = (content.match(/import\s+\w+\s+from\s+"[^"]*app\.manifest\.json"/g) ?? []).length
      if (n < 2) stale.push(`${rel} (only ${n} manifest imports)`)
    }
    expect(stale).toEqual([])
  })

  // A settings link the server stores (an OAuth callback redirect, an attention
  // row's settingsRoute, a shell connect's landing page) comes from the app's
  // manifest (settings-paths.ts: connector card, app page or store), never from a
  // per-app path literal in kernel code or app.ts.
  it("settings links are manifest-driven: no per-app settings path literal", () => {
    const PER_APP_SETTINGS_PATH =
      /["'`]\/settings\/(?:mail|tickets|calendar|knowledge|invoicing|shopify|boxtal|social|ads|gitlab|database|google-drive|pennylane|api-connector|connections|admin\/apps)\b/
    const files = [...kernelFiles(), path.join(apiSrc, "app.ts")]
    const offenders: string[] = []
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) return
        if (PER_APP_SETTINGS_PATH.test(line)) {
          offenders.push(`${path.relative(apiSrc, file)}:${i + 1}: ${t}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

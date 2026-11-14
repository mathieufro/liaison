// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member's own data-subject export, through the real tool path
// (`executeTool` → scope check → handler → kernel file). Two members, Alice and
// Bob, each hold messages, a conversation, a file, approvals, a routine-free
// profile, an audit entry, a connected account, an outside AI client, a
// dashboard, an agent store document, an app draft and the log lines of a
// preview run of it. Alice's
// bundle holds her rows and none of Bob's, never a token or a hash, she can
// export herself without the data-subject authority, and she cannot export Bob:
// that answers 404 exactly like a person who does not exist, and parks no
// approval. A holder of the authority can export Bob.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents, approvalRequests, files, users } from "~/db/schema/kernel"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { createDraft } from "~/modules/app-builder/drafts"
import { createRunLogSink } from "~/modules/app-builder/logs"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createDashboard } from "~/modules/dashboards/service"
import { AGENT_STORE_APP, setDocument } from "~/modules/data-store/service"
import { seedContext } from "~/seed/context"
import { seedMemoryEntries } from "~/seed/factories/agent/memory"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { seedFileRow } from "~/seed/factories/files/file-row"
import { seedConnectedAccountRow, seedMcpConnection } from "~/seed/factories/org/platform-rows"
import { seedAuditEntry, setUserPreferences } from "~/seed/factories/org/rows"
import { actorFor } from "~/seed/factories/people/actors"
import { seedThreadHistory } from "~/seed/factories/threads/history"
import * as minimal from "~/seed/tiers/minimal"
import { restoreFilesSelectPolicy } from "~/tests/helpers/files-select-policy"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOOL = "kernel:data_subject_export"
const tag = crypto.randomUUID().slice(0, 8)
const SECRETS = {
  aliceAccess: `alice-access-token-${tag}`,
  aliceRefresh: `alice-refresh-token-${tag}`,
  aliceCreds: `alice-credentials-${tag}`,
  aliceMcp: `alice-mcp-hash-${tag}`,
  aliceAuditPw: `alice-audit-password-${tag}`,
  aliceSettingsToken: `alice-settings-token-${tag}`,
}
const ALICE_MARK = `alice-mark-${tag}`
/** A read scope no one holds: a log line tagged with it is out of every member's reach. */
const UNHELD_SCOPE = "kernel:never:held"
/** Each member's preview runs: the one they can read, and the one tagged with `UNHELD_SCOPE`. */
const runs: Record<string, { seen: string; unseen: string; draftId: string }> = {}
const BOB_MARK = `bob-mark-${tag}`

let orgId: string
let alice: UserContext
let bob: UserContext
let officer: UserContext
let aliceHash: string

type Saved = { fileId: string; counts: Record<string, number>; note: string }

async function exportAs(actor: UserContext, params: Record<string, unknown>) {
  return (await executeTool<Saved>({ toolName: TOOL, orgId, actor, params, origin: "human-ui" }))
    .data
}

async function bundleText(fileId: string): Promise<string> {
  const [row] = await withSystemDb("test-read-export-file", (db) =>
    db.select({ key: files.storageKey }).from(files).where(eq(files.id, fileId)).limit(1),
  )
  if (!row) throw new Error(`no file row ${fileId}`)
  return (await getObjectBuffer(row.key)).toString("utf-8")
}

async function personalAgentOf(userId: string): Promise<string> {
  const [row] = await withSystemDb("test-personal-agent", (db) =>
    db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.ownerUserId, userId), eq(agents.kind, "personal")))
      .limit(1),
  )
  if (!row) throw new Error(`no personal agent for ${userId}`)
  return row.id
}

async function seedMember(person: minimal.Person, mark: string, secrets?: typeof SECRETS) {
  const ctx = seedContext({ orgId, now: new Date() })
  await minimal.grantScope(person.id, "kernel:apps:build")
  const actor = await actorFor(ctx, person.id)
  const threadId = await minimal.thread(orgId, person.id, { title: `${mark} conversation` })
  await seedThreadHistory(ctx, [
    { key: `${mark}-m1`, threadId, actor, body: `${mark} message body`, at: new Date() },
  ])
  await seedFileRow({
    orgId,
    app: "kernel",
    entityType: "thread",
    entityId: threadId,
    filename: `${mark}-upload.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1234,
    storageKey: `orgs/${orgId}/test/${mark}.pdf`,
    uploadedBy: person.id,
  })
  await setUserPreferences(person.id, { magicWandInstructions: `${mark} tone` })
  await seedAuditEntry({
    orgId,
    actorId: person.id,
    actorType: "user",
    app: "kernel",
    entityType: "user",
    entityId: person.id,
    action: "update",
    changes: {
      name: `${mark} renamed`,
      ...(secrets ? { passwordHash: secrets.aliceAuditPw } : {}),
    },
  })
  await seedConnectedAccountRow({
    orgId,
    appName: "mail",
    connectionName: "gmail",
    ownerType: "user",
    ownerId: person.id,
    providerType: "google",
    identifier: `${mark}@mailbox.example`,
    displayName: `${mark} mailbox`,
    accessTokenEncrypted: secrets?.aliceAccess ?? `${mark}-access`,
    refreshTokenEncrypted: secrets?.aliceRefresh ?? `${mark}-refresh`,
    credentialsEncrypted: secrets?.aliceCreds ?? `${mark}-creds`,
    status: "connected",
    createdBy: person.id,
  })
  await seedMcpConnection({
    orgId,
    userId: person.id,
    clientId: `${mark}-client`,
    label: `${mark} desktop client`,
    refreshTokenHash: secrets?.aliceMcp ?? `${mark}-mcp-hash`,
  })
  await seedApprovalRequests(ctx, [
    {
      id: crypto.randomUUID(),
      handle: `${mark}-appr`,
      threadId,
      toolName: "kernel:invite_user",
      payload: { email: `${mark}-payload@example.com` },
      requestedBy: person.id,
      agentId: null,
      notifyUserIds: [],
      status: "pending",
      createdAt: new Date(),
    },
  ])
  await seedMemoryEntries(ctx, {
    writerUserId: person.id,
    entries: [
      {
        ownerAgentId: await personalAgentOf(person.id),
        type: "user",
        name: `pref-${tag}`,
        description: `${mark} memory`,
        content: `${mark} likes oolong`,
      },
    ],
  })
  await createDashboard(actor, {
    title: `${mark} dashboard`,
    visibility: "personal",
    spec: { v: 1, blocks: [] },
  })
  await withRlsContext(actor, (tx) =>
    setDocument(tx, { orgId, app: AGENT_STORE_APP, userId: person.id }, "notes", `${mark}-note`, {
      title: `${mark} note contents`,
    }),
  )
  const baseName = `${mark.split("-")[0]}${tag}`.replace(/[^a-z0-9]/g, "x")
  const made = await withRlsContext(actor, (tx) =>
    createDraft(
      tx,
      { orgId, userId: person.id },
      {
        baseName,
        title: `${mark} tracker`,
        files: {
          "app.manifest.json": JSON.stringify({ name: baseName, version: "0.1.0" }),
          "handlers.ts": `export const ping = () => '${mark} handler code'\n`,
        },
      },
    ),
  )
  const preview = (scopeTags: string[]) => {
    const sink = createRunLogSink({
      orgId,
      app: baseName,
      draftId: made.draft.id,
      actorUserId: person.id,
      scopeTags,
    })
    sink.append("info", `${mark} log text`, { customer: `${mark}-log-field` })
    sink.append("error", `${mark} log text again`, {})
    return sink.flush().then(() => sink.runId)
  }
  runs[mark] = {
    draftId: made.draft.id,
    seen: await preview([]),
    unseen: await preview([UNHELD_SCOPE]),
  }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  // The files SELECT policy production builds at boot: a database fresh from the template
  // holds the deny-all placeholder, and the files section would read nothing.
  await restoreFilesSelectPolicy()
  const ctx = seedContext({ orgId, now: new Date() })
  const a = await minimal.person(orgId, { name: `Alice ${tag}` })
  const b = await minimal.person(orgId, { name: `Bob ${tag}` })
  const o = await minimal.person(orgId, { name: `Officer ${tag}` })
  await minimal.grantScope(o.id, "kernel:data_subject:export")
  await withSystemDb("test-alice-settings", (db) =>
    db
      .update(users)
      .set({ settings: { sidebar: "compact", apiToken: SECRETS.aliceSettingsToken } })
      .where(eq(users.id, a.id)),
  )
  await seedMember(a, ALICE_MARK, SECRETS)
  await seedMember(b, BOB_MARK)
  alice = await actorFor(ctx, a.id)
  bob = await actorFor(ctx, b.id)
  officer = await actorFor(ctx, o.id)
  const [row] = await withSystemDb("test-alice-hash", (db) =>
    db.select({ h: users.passwordHash }).from(users).where(eq(users.id, a.id)),
  )
  aliceHash = row?.h ?? ""
}, 120_000)

afterAll(releaseTestLock)

describe("data subject export of a member", () => {
  it("a member exports themself without the data-subject authority, and the bundle holds their rows and none of another member's", async () => {
    expect(alice.scopes).not.toContain("kernel:data_subject:export")
    const saved = await exportAs(alice, { userId: "me" })
    expect(saved.note).toContain(saved.fileId)
    const text = await bundleText(saved.fileId)
    const bundle = JSON.parse(text)
    expect(bundle.subject).toMatchObject({ kind: "user", userId: alice.userId })
    for (const key of [
      "preferences",
      "roles",
      "messages",
      "threads",
      "files",
      "approvals",
      "auditEntries",
      "connectedAccounts",
      "connectedApps",
      "dashboards",
      "storeDocuments",
      "appDrafts",
      "appLogs",
    ]) {
      expect({ key, rows: bundle.records[key].rows.length }).not.toEqual({ key, rows: 0 })
      expect(saved.counts[key]).toBe(bundle.records[key].rows.length)
    }
    expect(text).toContain(`${ALICE_MARK} message body`)
    expect(text).toContain(`${ALICE_MARK}-upload.pdf`)
    expect(text).toContain(`/api/files/`)
    expect(text).toContain(`${ALICE_MARK} likes oolong`)
    expect(text).toContain(`${ALICE_MARK}@mailbox.example`)
    expect(text).toContain(`${ALICE_MARK} renamed`)
    expect(text).toContain("compact")
    expect(text).toContain(`${ALICE_MARK} dashboard`)
    expect(text).toContain(`${ALICE_MARK}-note`)
    // A store document's contents stay out: the export lists it, it does not copy it.
    expect(text).not.toContain(`${ALICE_MARK} note contents`)
    // Nothing of Bob's, not even the payload of Alice's own approval request.
    expect(text).not.toContain(BOB_MARK)
    expect(text).not.toContain(`${ALICE_MARK}-payload@example.com`)
  })

  it("a member's app drafts and the runs their actions started are in their bundle, without code or log text", async () => {
    const saved = await exportAs(alice, { userId: "me" })
    const text = await bundleText(saved.fileId)
    const records = JSON.parse(text).records as Record<
      string,
      { note: string; rows: Array<Record<string, unknown>> }
    >
    const mine = runs[ALICE_MARK]
    if (!mine) throw new Error("Alice's runs were not seeded")
    expect(records.appDrafts?.rows).toEqual([
      expect.objectContaining({
        id: mine.draftId,
        title: `${ALICE_MARK} tracker`,
        made: true,
        last_changed: true,
        versions_made: [1],
      }),
    ])
    // Both runs are hers, the one tagged with a scope she lacks too: listed by counts and times only.
    expect(records.appLogs?.rows).toEqual([
      expect.objectContaining({ run_id: mine.seen, draft_id: mine.draftId, lines: 2, errors: 1 }),
      expect.objectContaining({ run_id: mine.unseen, draft_id: mine.draftId, lines: 2, errors: 1 }),
    ])
    expect(saved.counts.appDrafts).toBe(1)
    expect(saved.counts.appLogs).toBe(2)
    // Listed, never copied: the draft's code and what the app wrote stay out.
    expect(text).not.toContain(`${ALICE_MARK} handler code`)
    expect(text).not.toContain(`${ALICE_MARK} log text`)
    expect(text).not.toContain(`${ALICE_MARK}-log-field`)
    expect(text).not.toContain(BOB_MARK)
  })

  it("a member who lost the app permissions still finds the drafts they made and the runs they started in their export", async () => {
    // Mutation caught: the two sections read under the member's current access (a member
    // without kernel:apps:build reads no draft, and no run tagged with a scope they lack).
    const theirs = runs[BOB_MARK]
    if (!theirs) throw new Error("Bob's runs were not seeded")
    await minimal.revokeScope(bob.userId, "kernel:apps:build")
    const saved = await exportAs(officer, { userId: bob.userId })
    const text = await bundleText(saved.fileId)
    const records = JSON.parse(text).records as Record<
      string,
      { rows: Array<Record<string, unknown>> }
    >
    expect(officer.scopes).not.toContain("kernel:apps:build")
    expect(records.appDrafts?.rows.map((r) => r.id)).toEqual([theirs.draftId])
    expect(records.appLogs?.rows.map((r) => r.run_id)).toEqual([theirs.seen, theirs.unseen])
    expect(text).not.toContain(`${BOB_MARK} handler code`)
    expect(text).not.toContain(`${BOB_MARK} log text`)
    expect(text).not.toContain(ALICE_MARK)
  })

  it("never writes a token, a credential, a password hash or a secret-named setting", async () => {
    const saved = await exportAs(alice, { userId: alice.userId })
    const text = await bundleText(saved.fileId)
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret)
    expect(aliceHash.length).toBeGreaterThan(0)
    expect(text).not.toContain(aliceHash)
  })

  it("a member without the authority cannot export another member: 404, the same as a person who does not exist", async () => {
    const refusal = (params: Record<string, unknown>) =>
      exportAs(alice, params).then(
        () => {
          throw new Error("expected a refusal")
        },
        (err: { status?: number; code?: string; message?: string }) => ({
          status: err.status,
          code: err.code,
          message: err.message,
        }),
      )
    const other = await refusal({ userId: bob.userId })
    const missing = await refusal({ userId: crypto.randomUUID() })
    expect(other.status).toBe(404)
    expect(other).toEqual(missing)
    // A contact is refused the same way without the authority.
    const contactId = await minimal.contact(orgId, `c-${tag}@customer.example`)
    expect((await refusal({ contactId })).status).toBe(404)
  })

  it("an agent call to export someone else parks no approval", async () => {
    const before = await withSystemDb("test-count-approvals", (db) =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.toolName, TOOL))),
    )
    const err = await executeTool({
      toolName: TOOL,
      orgId,
      actor: alice,
      params: { userId: bob.userId },
      origin: "in-app-agent",
    }).then(
      (r) => r,
      (e: { status?: number }) => e,
    )
    expect((err as { status?: number }).status).toBe(404)
    const after = await withSystemDb("test-count-approvals", (db) =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.toolName, TOOL))),
    )
    expect(after.length).toBe(before.length)
  })

  it("the data-subject authority exports another member", async () => {
    const saved = await exportAs(officer, { userId: bob.userId })
    const text = await bundleText(saved.fileId)
    expect(JSON.parse(text).subject).toMatchObject({ kind: "user", userId: bob.userId })
    expect(text).toContain(`${BOB_MARK}@mailbox.example`)
    expect(text).not.toContain(ALICE_MARK)
  })
})

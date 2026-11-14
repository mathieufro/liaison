// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a commercial mail carries when it leaves, through the real mail handlers
// in the sandbox, the real gate and decision: the legal name, the postal
// address, one opt-out link (the same in the text, the HTML and the
// List-Unsubscribe header), "or reply stop", and the one-click header, on the
// Gmail raw path and on SMTP, whatever the approver edited. Without the
// identity nothing stages; a commercial mail goes to one outside person.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as privileged from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import * as eventBusModule from "~/infra/events/event-bus"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import * as connectionsService from "~/modules/apps/connections/service"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { buildRawSentMessage, type SmtpSendParams } from "~/modules/apps/sandbox/smtp-bridge"
import { seedContext } from "~/seed/context"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { ensureRecordedBasis } from "~/tests/helpers/prospect"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount } from "../../../test-support/seed/mail"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)
const tokenSpy = spyOn(connectionsService, "getTokenForConnection").mockImplementation(
  (async () => "test-access-token") as never,
)

const IDENTITY = { legalName: "Maison Arlon SAS", postalAddress: "4 rue du Port, 13002 Marseille" }

let orgId = ""
let userId = ""
let colleague = ""
let admin: UserContext
let threadId = ""
let smtpAccount = ""
let gmailAccount = ""

const smtpSent: SmtpSendParams[] = []
const gmailRaw: string[] = []
let counter = 0
const outside = (name: string) => `${name}-${++counter}@prospect.example`

type Envelope = Awaited<ReturnType<typeof executeToolCore>>
function blockedId(envelope: Envelope): string {
  if (!("blocked" in envelope)) throw new Error(`not staged: ${JSON.stringify(envelope)}`)
  return envelope.blocked.approvalRequestId as string
}

const stage = async (params: Record<string, unknown>) => {
  // Commercial mail needs a recorded basis; these tests are about what it carries.
  await ensureRecordedBasis(orgId, [
    ...((params.to as unknown[]) ?? []),
    ...((params.cc as unknown[]) ?? []),
    ...((params.bcc as unknown[]) ?? []),
  ])
  return executeToolCore({
    toolName: "mail:compose",
    orgId,
    actor: admin,
    params,
    threadId,
    origin: "in-app-agent",
  })
}

const followUp = (to: string[], extra: Record<string, unknown> = {}) => ({
  accountId: smtpAccount,
  to,
  subject: "Your studio project",
  textBody: "Shall we book a call next week?",
  followUp: {},
  ...extra,
})

const approve = (requestId: string) =>
  decideApproval({ orgId, requestId, actor: admin, decision: "approve" })

async function setIdentity(value: unknown): Promise<void> {
  await privileged.withSystemDb("commercial-footer-test-identity", (tx) =>
    tx.execute(drizzleSql`UPDATE kernel.organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{commercialIdentity}',
                               ${JSON.stringify(value)}::jsonb, true)
      WHERE id = ${orgId}::uuid`),
  )
}

const LINK = /https?:\/\/[^\s"<>]+\/public\/opt-out\/[A-Za-z0-9_-]{43}/

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = {
    ...a.actor,
    scopes: [
      ...a.actor.scopes,
      "mail:conversations:write",
      "mail:conversations:read",
      "mail:approve",
    ],
  }
  const [me] = await privileged.withSystemDb(
    "commercial-footer-test-me",
    async (tx) =>
      (await tx.execute(
        drizzleSql`SELECT email FROM kernel.users WHERE id = ${userId}::uuid`,
      )) as unknown as Array<{ email: string }>,
  )
  colleague = `colleague@${String(me?.email).split("@")[1]}`
  threadId = await minimal.thread(orgId, userId)
  await ensureAppsForOrg(orgId)
  await setIdentity(IDENTITY)
  SandboxBridgeTestAccess.setSmtpSend(async (_c, _i, message) => {
    smtpSent.push(message as SmtpSendParams)
    return { messageId: `<sent-${smtpSent.length}@org.test>`, deliveryState: "delivered" }
  })
  SandboxBridgeTestAccess.setFetchInterceptsHost((host) => host === "gmail.googleapis.com")
  SandboxBridgeTestAccess.setFetch((async (_url: string, init?: RequestInit) => {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw?: string }
    if (raw) gmailRaw.push(Buffer.from(raw, "base64url").toString("utf8"))
    return new Response(JSON.stringify({ id: `gm-${gmailRaw.length}`, threadId: "t-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch)
  const ctx = seedContext({ orgId, now: new Date() })
  smtpAccount = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "sales@org.test",
      provider: "imap",
    })
  ).accountId
  gmailAccount = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "deals@org.test",
      provider: "gmail",
    })
  ).accountId
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  tokenSpy.mockRestore()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("the commercial footer", () => {
  it("a commercial mail carries the legal name, address, opt-out link and unsubscribe headers even after an approver removed them", async () => {
    // SMTP: the approver rewrites the body and deletes the footer they saw nowhere.
    const to = outside("smtp")
    const id = blockedId(await stage(followUp([to])))
    await updatePayload({
      orgId,
      requestId: id,
      actor: admin,
      fields: { textBody: "Shall we book a call? (no footer please)" },
    } as never)
    await approve(id)
    const message = smtpSent.at(-1) as SmtpSendParams
    expect(message.textBody).toContain(`${IDENTITY.legalName}, ${IDENTITY.postalAddress}`)
    expect(message.textBody).toMatch(new RegExp(`${LINK.source} or reply stop\\.`))
    expect(message.headers?.["List-Unsubscribe"]).toMatch(new RegExp(`^<${LINK.source}>$`))
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    // CRM-2: the SMTP path writes both headers on the wire (nodemailer's own bytes).
    const wire = (await buildRawSentMessage(message, "<wire@org.test>")).toString("utf8")
    // nodemailer folds the long header onto a continuation line.
    expect(wire).toMatch(/^List-Unsubscribe:\s+<https?:\/\/[^>]+\/public\/opt-out\/[^>]+>/m)
    expect(wire).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m)

    // Gmail raw: the same, in the RFC 2822 message the API is handed.
    const gm = outside("gmail")
    const gid = blockedId(await stage(followUp([gm], { accountId: gmailAccount })))
    await approve(gid)
    const raw = gmailRaw.at(-1) as string
    expect(raw).toContain(`${IDENTITY.legalName}, ${IDENTITY.postalAddress}`)
    expect(raw).toMatch(/^List-Unsubscribe: <https?:\/\/[^>]+\/public\/opt-out\/[^>]+>\r$/m)
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m)
  }, 60_000)

  it("a commercial mail's text, HTML and header carry the same opt-out link", async () => {
    const id = blockedId(
      await stage(
        followUp([outside("same-link")], {
          htmlBody: "<html><body><p>Shall we book a call?</p></body></html>",
        }),
      ),
    )
    await approve(id)
    const message = smtpSent.at(-1) as SmtpSendParams
    const inText = LINK.exec(message.textBody)?.[0]
    const inHtml = LINK.exec(message.htmlBody)?.[0]
    const inHeader = LINK.exec(message.headers?.["List-Unsubscribe"] ?? "")?.[0]
    expect(inText).toBeDefined()
    expect(inHtml).toBe(inText)
    expect(inHeader).toBe(inText)
    // The footer sits inside the body, before it closes.
    expect(message.htmlBody.indexOf(IDENTITY.legalName)).toBeLessThan(
      message.htmlBody.indexOf("</body>"),
    )
  }, 60_000)

  it("no tracking image is ever added", async () => {
    const id = blockedId(
      await stage(
        followUp([outside("no-pixel")], { htmlBody: "<html><body><p>Hello</p></body></html>" }),
      ),
    )
    await approve(id)
    const message = smtpSent.at(-1) as SmtpSendParams
    expect(message.htmlBody).not.toContain("<img")
    expect(message.textBody).not.toContain("<img")
  }, 60_000)

  it("a commercial mail to two outside people is refused, a colleague on copy is allowed", async () => {
    const two = await stage(followUp([outside("first"), outside("second")]))
    if (!("error" in two)) throw new Error("not refused")
    expect(two.error.code).toBe("commercial_one_recipient")
    expect(two.error.message).toContain("each gets their own opt-out link")
    const withColleague = await stage(followUp([outside("one")], { cc: [colleague] }))
    blockedId(withColleague)
  }, 60_000)

  it("a commercial send without a legal name or address is refused naming the setting", async () => {
    await setIdentity({ legalName: "Maison Arlon SAS" })
    try {
      const staged = await stage(followUp([outside("no-identity")]))
      if (!("error" in staged)) throw new Error("not refused")
      expect(staged.error.code).toBe("commercial_identity_missing")
      expect(staged.error.message).toContain("Settings > Organization > Commercial identity")
      expect(staged.error.message).toContain("config_email")
    } finally {
      await setIdentity(IDENTITY)
    }
  }, 60_000)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Transporter } from "nodemailer"
import nodemailer from "nodemailer"
import {
  type EmailOutageKind,
  noteEmailProviderAccepted,
  noteEmailProviderRefused,
} from "~/infra/email-outage"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoRestrictionError, demoRestrictionMessage } from "~/modules/demo/demo-egress"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

/** Escape user-controlled strings before embedding in HTML email templates. */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

const log = rootLogger.child({ service: "email" })

/**
 * What kind of system message this is, the one thing about its content a log
 * line may say. A subject or body can carry a sign-in code, a magic link, a
 * reset or invitation token, so neither is ever logged (see `emailLogFields`).
 */
export type EmailTemplateId =
  | "auth.sign-in-code"
  | "auth.step-up-code"
  | "auth.password-reset"
  | "users.invitation"
  | "connections.connect-link"
  | "attention.digest"
  | "tickets.csat-survey"
  | "demo.verification-code"
  | "demo.owner-alert"

export interface EmailMessage {
  to: string
  subject: string
  /** The template it was rendered from: what the send's log line names. */
  template?: EmailTemplateId
  html: string
  text?: string
  /** Per-message From override (per-org email identity). Falls back to the
   *  provider's configured `from` (env.EMAIL_FROM) when omitted. */
  from?: string
  replyTo?: string
  idempotencyKey?: string
}

export class EmailRateLimitError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    /** The provider's own reason, when it says one. */
    public readonly reason?: string,
  ) {
    super("RATE_LIMIT")
    this.name = "EmailRateLimitError"
  }
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "EmailProviderError"
  }
}

/** The domain of a recipient address, lowercased; "unknown" when it has none. */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@")
  if (at < 0 || at === address.length - 1) return "unknown"
  return address
    .slice(at + 1)
    .replace(/[>\s].*$/, "")
    .toLowerCase()
}

/**
 * The only fields a send's log line carries: the template id and the
 * recipient's domain. Never the subject (the sign-in and demo codes are in
 * it), the body (codes, magic links, reset and invitation tokens) or the full
 * address.
 */
export function emailLogFields(message: Pick<EmailMessage, "to" | "template">): {
  template: string
  toDomain: string
} {
  return { template: message.template ?? "unlabelled", toDomain: recipientDomain(message.to) }
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>
  verify(): Promise<boolean>
}

// --- Mail that happens once (S11) ---
//
// `sendEmailOnce` is the door for a mail a job may send twice (a digest whose
// job is re-run after a crash or a hand-back). With `message.idempotencyKey`
// set, the key is claimed in the effect ledger (lib/effect-once.ts) before the
// provider is called, so every provider gets the guarantee, not only Resend
// (which also receives the key as its `Idempotency-Key` header). A mail of a
// load org (lib/load-harness.ts) goes to the effect sink instead of the
// provider. Without a key the mail is sent as `provider.send` would.

/** What `sendEmailOnce` did. `unknown`: an earlier attempt may have sent it; not sent again. */
export type EmailOnceOutcome = "sent" | "replayed" | "unknown" | "sunk"

export async function sendEmailOnce(
  orgId: string,
  provider: EmailProvider,
  message: EmailMessage,
): Promise<EmailOnceOutcome> {
  const { isLoadOrg } = await import("~/lib/load-harness")
  const sink = await isLoadOrg(orgId)
  // The sink stands in for the provider, inside the ledger's claim below, so
  // a load run's sink counts exactly what would have gone out: a doubled count
  // is a doubled mail.
  const send = async (): Promise<void> => {
    if (!sink) return provider.send(message)
    const { recordSinkEffect } = await import("~/lib/effect-sink")
    const key =
      message.idempotencyKey ?? `unkeyed:${message.template ?? "mail"}:${crypto.randomUUID()}`
    await recordSinkEffect(orgId, "mail", key)
    log.info({ ...emailLogFields(message), orgId }, "Email counted in the load sink (not sent)")
  }
  if (!message.idempotencyKey) {
    await send()
    return sink ? "sunk" : "sent"
  }
  const { effectOnce } = await import("~/lib/effect-once")
  const outcome = await effectOnce(orgId, `mail:${message.idempotencyKey}`, async () => {
    await send()
    return { sent: true }
  })
  if (outcome.status === "ran") return sink ? "sunk" : "sent"
  return outcome.status
}

// --- Console adapter (dev / test, and any instance without a mail provider) ---
//
// Logs the template and the recipient's domain. The subject and BODY carry
// sign-in codes, magic links, invite, reset and 2FA codes, so they are logged
// only when the operator opted in with LIAISON_CONSOLE_EMAIL_BODIES (a local trial with no
// mail server, where that log line is the only way to receive a sign-in code;
// the quickstart sets it), and then at warn so it stands out.

/**
 * The HTML without its style and script elements, read by position rather than by pattern: an
 * opening tag up to its closing tag goes, contents and all; an unclosed one takes the rest.
 */
function withoutStyleAndScript(html: string): string {
  const lower = html.toLowerCase()
  let out = ""
  let at = 0
  for (;;) {
    const starts = ["style", "script"]
      .map((tag) => ({ tag, start: lower.indexOf(`<${tag}`, at) }))
      .filter((m) => m.start >= 0)
      .sort((a, b) => a.start - b.start)
    const next = starts[0]
    if (!next) return out + html.slice(at)
    out += html.slice(at, next.start)
    const close = lower.indexOf(`</${next.tag}`, next.start)
    if (close < 0) return out
    const end = lower.indexOf(">", close)
    if (end < 0) return out
    at = end + 1
  }
}

/** A tag that ends a line of text: a line break or the close of a block. */
const LINE_ENDING_TAG = /^(br\b|\/(p|div|tr|h[1-6]|li)\b)/

/**
 * The text between the tags, every tag dropped by position: a line-ending tag becomes a newline,
 * and an unclosed `<` takes the rest.
 */
function tagsToText(html: string): string {
  let out = ""
  let at = 0
  for (;;) {
    const open = html.indexOf("<", at)
    if (open < 0) return out + html.slice(at)
    out += html.slice(at, open)
    const close = html.indexOf(">", open)
    if (close < 0) return out
    const tag = html
      .slice(open + 1, close)
      .trim()
      .toLowerCase()
    if (LINE_ENDING_TAG.test(tag)) out += "\n"
    at = close + 1
  }
}

export function consoleEmailBody(message: EmailMessage): string {
  if (message.text) return message.text
  return tagsToText(withoutStyleAndScript(message.html))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

/** How many sent messages the console provider keeps for inspection. */
export const CONSOLE_SENT_LIMIT = 100

export class ConsoleEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = []

  constructor(private readonly logBodies: boolean = env.LIAISON_CONSOLE_EMAIL_BODIES) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message)
    // Bounded: a long-running instance without SMTP must not grow forever.
    if (this.sent.length > CONSOLE_SENT_LIMIT) {
      this.sent.splice(0, this.sent.length - CONSOLE_SENT_LIMIT)
    }
    if (this.logBodies) {
      log.warn(
        {
          ...emailLogFields(message),
          to: message.to,
          subject: message.subject,
          body: consoleEmailBody(message),
        },
        "Email sent (console, body logged: LIAISON_CONSOLE_EMAIL_BODIES)",
      )
    } else {
      log.info(emailLogFields(message), "Email sent (console)")
    }
  }

  async verify(): Promise<boolean> {
    return true
  }
}

// --- Demo adapter: refuse, do not sink ---
//
// A demo instance sends no mail off the box. Pinning both channels to
// `ConsoleEmailProvider` made that true and made the product LIE about it: an
// admin persona who invited a user saw "invited" and nothing happened, which is
// precisely the silent sink `demo-egress.ts` argues against by name, and the
// limits panel described only the sandbox mail bridge, which does refuse.
//
// So the demo box refuses on this channel too. The message is still written to
// the log first, because an operator debugging a demo box wants to see what
// would have been sent, and then the send throws with the same sentence the
// mail bridge already gives a visitor. Callers survive it: every system send in
// this codebase is fire-and-forget inside a try/catch with a `log.error` (see
// apps/api/CLAUDE.md, "Email: two channels"), and the handlers that report to a
// person surface the refusal instead of reporting success.
//
// `verify()` answers false rather than throwing: it is a health question, and
// the honest answer on a demo box is "this channel does not deliver".

let _demoProvider: DemoRefusingEmailProvider | null = null

/** The one refusing provider this process uses. Shared so a test can read it. */
export function demoProvider(): DemoRefusingEmailProvider {
  if (!_demoProvider) _demoProvider = new DemoRefusingEmailProvider()
  return _demoProvider
}

export class DemoRefusingEmailProvider implements EmailProvider {
  /** Kept for the same reason ConsoleEmailProvider keeps it: a test can read it. */
  readonly refused: EmailMessage[] = []

  async send(message: EmailMessage): Promise<void> {
    this.refused.push(message)
    log.warn(emailLogFields(message), "Email refused (LIAISON_DEMO_MODE - no mail leaves this box)")
    throw new DemoRestrictionError(demoRestrictionMessage("outbound_mail"), "outbound_mail")
  }

  async verify(): Promise<boolean> {
    return false
  }
}

// --- SMTP adapter (production / self-hosted) ---

export class SmtpEmailProvider implements EmailProvider {
  private transport: Transporter

  constructor(config: {
    host: string
    port: number
    user: string
    pass: string
    from: string
    secure?: boolean
  }) {
    const hasAuth = config.user && config.pass
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure ?? config.port === 465,
      ...(hasAuth ? { auth: { user: config.user, pass: config.pass } } : {}),
      // Prevent a hung SMTP server from blocking the process indefinitely.
      connectionTimeout: 10_000, // 10 s to establish TCP + TLS
      greetingTimeout: 8_000, // 8 s to receive SMTP greeting
      socketTimeout: 30_000, // 30 s idle between DATA chunks
    })
    this.from = config.from
  }

  private from: string

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: message.from ?? this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
    })
    log.info(emailLogFields(message), "Email sent (SMTP)")
  }

  async verify(): Promise<boolean> {
    try {
      await this.transport.verify()
      return true
    } catch (err) {
      log.error({ err }, "SMTP connection verification failed")
      return false
    }
  }
}

// --- Resend adapter (managed transactional API) ---

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string
  private readonly from: string
  private readonly fetchImpl: FetchLike

  constructor(config: { apiKey: string; from: string; fetch?: FetchLike }) {
    this.apiKey = config.apiKey
    this.from = config.from
    this.fetchImpl = config.fetch ?? ((url, init) => globalThis.fetch(url, init))
  }

  async send(message: EmailMessage): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    }
    if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey

    const body = {
      from: message.from ?? this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {}),
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }

    let res: Response
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new EmailProviderError(`Resend network error: ${(err as Error).message}`)
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") ?? ""
      const secs = Number.parseInt(retryAfter, 10)
      const retryAfterMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 60_000
      const reason = await res
        .json()
        .then((b: unknown) => {
          const name = (b as { name?: unknown } | null)?.name
          return typeof name === "string" ? name : undefined
        })
        .catch(() => undefined)
      throw new EmailRateLimitError(retryAfterMs, reason)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new EmailProviderError(`Resend ${res.status}: ${text.slice(0, 256)}`, res.status)
    }
    log.info(emailLogFields(message), "Email sent (resend)")
  }

  async verify(): Promise<boolean> {
    try {
      const res = await this.fetchImpl("https://api.resend.com/domains", {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 200) return true
      if (res.status === 401) return false
      log.warn({ status: res.status }, "Resend verify unexpected status")
      return false
    } catch (err) {
      log.error({ err }, "Resend verify error")
      return false
    }
  }
}

// --- Singleton ---

let _provider: EmailProvider | null = null

export function initEmailProvider(): EmailProvider {
  if (_provider) return _provider

  // A demo instance sends no mail off the box, on either channel, and SAYS SO
  // rather than accepting the send and dropping it. The signup route
  // deliberately needs no email round trip, so refusing costs the demo nothing
  // and removes the one way a visitor could make a public box mail a stranger
  // (an invite to any address they type) while keeping the product honest about
  // what just happened. Read straight off `env` rather than through
  // `isDemoModeEnabled()` because this runs at boot, before any request, and
  // the provider is then cached.
  if (isDemoModeEnabled()) {
    log.warn("Email provider: demo refusal (LIAISON_DEMO_MODE - no mail leaves this box)")
    return demoProvider()
  }

  if (env.RESEND_API_KEY) {
    _provider = new ResendEmailProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    })
    log.info("Email provider: resend")
  } else if (env.SMTP_HOST) {
    _provider = new SmtpEmailProvider({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.EMAIL_FROM,
      secure: env.SMTP_SECURE,
    })
    log.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, "Email provider: SMTP")
  } else {
    _provider = new ConsoleEmailProvider()
    if (env.NODE_ENV === "production") {
      // Loud on purpose: on a real deployment nobody receives sign-in codes,
      // invitations or password resets until SMTP_* or RESEND_API_KEY is set.
      log.warn(
        { bodiesLogged: env.LIAISON_CONSOLE_EMAIL_BODIES },
        "NO MAIL PROVIDER: emails are only written to this log, nobody receives them. " +
          "Set SMTP_HOST (or RESEND_API_KEY) in the deployment's .env." +
          (env.LIAISON_CONSOLE_EMAIL_BODIES
            ? " LIAISON_CONSOLE_EMAIL_BODIES is on: sign-in codes and links are in this log; " +
              "use it for a local trial only."
            : ""),
      )
    } else {
      log.info("Email provider: console (no SMTP configured)")
    }
  }

  return _provider
}

/**
 * The demo refusal is decided PER CALL, ahead of the cache, not once at boot.
 * `initEmailProvider` used to bake it into `_provider`, which meant the one
 * property that must hold on a demo box ("nothing leaves, and it says so")
 * could not be exercised without rebooting a process, and a runtime flip of the
 * flag would have been ignored. The check is one module-local boolean, so a
 * normal deployment pays nothing for it.
 */
export function getEmailProvider(): EmailProvider {
  if (isDemoModeEnabled()) return demoProvider()
  if (!_provider) return initEmailProvider()
  return _provider
}

/** Override the provider — for tests only. */
export function setEmailProvider(provider: EmailProvider): void {
  _provider = provider
}

// --- System / transactional email channel ---
//
// Sign-in codes, magic links, password resets, 2FA step-up codes, team
// invitations and the attention digest are SYSTEM email: the recipient is a
// team member who must actually receive it, even on a deployment whose DEFAULT
// provider is a sink (e.g. staging routes all app/customer mail to Mailpit so
// nothing reaches a real customer). This channel is selected INDEPENDENTLY of
// the default provider: when SYSTEM_RESEND_API_KEY is set it delivers via
// Resend; otherwise it inherits the default provider, so dev/test and any
// deployment that doesn't set it keep today's behavior unchanged (fail-safe:
// absent config means "same sink as everything else", never "silently real").
//
// Customer-facing email stays on the default provider on purpose — the mail /
// tickets apps send through a per-org connected account (smtp-bridge), and the
// CSAT survey (apps/tickets/admin.ts) uses getEmailProvider() — so none of it
// follows this channel to a real inbox.
let _systemProvider: EmailProvider | null = null

/** The From of system mail: SYSTEM_EMAIL_FROM when set, else EMAIL_FROM. */
export function systemEmailFrom(): string {
  return env.SYSTEM_EMAIL_FROM || env.EMAIL_FROM
}

/**
 * Stamp the system sender on every message that does not name its own From.
 * The inherited default provider is configured with EMAIL_FROM, which on a
 * deployment is often the customer-facing support identity.
 */
function withSystemFrom(provider: EmailProvider): EmailProvider {
  if (!env.SYSTEM_EMAIL_FROM) return provider
  return {
    send: (message) => provider.send({ ...message, from: message.from ?? systemEmailFrom() }),
    verify: () => provider.verify(),
  }
}

export function initSystemEmailProvider(): void {
  if (env.SYSTEM_RESEND_API_KEY) {
    // Build + cache + log the resend line via the getter.
    getSystemEmailProvider()
  } else {
    log.info("System email channel: inherits default provider (SYSTEM_RESEND_API_KEY unset)")
  }
}

/**
 * Does system mail (sign-in codes, magic links, resets) leave this instance at
 * all? False on a demo box, where every send is refused for the WHOLE
 * instance. A flow whose only delivery is an email (the magic-link sign-in)
 * asks this up front and says so, rather than issuing a code nobody can receive.
 */
export function systemEmailLeavesThisInstance(): boolean {
  return !isDemoModeEnabled()
}

export function getSystemEmailProvider(): EmailProvider {
  // Demo mode overrides SYSTEM_RESEND_API_KEY rather than inheriting around it,
  // and it is checked BEFORE the cache: this is the channel that carries magic
  // links and invitations, which is exactly the channel a visitor could aim at
  // somebody else's inbox.
  if (isDemoModeEnabled()) return demoProvider()
  if (_systemProvider) return _systemProvider
  if (env.SYSTEM_RESEND_API_KEY) {
    _systemProvider = new ResendEmailProvider({
      apiKey: env.SYSTEM_RESEND_API_KEY,
      from: systemEmailFrom(),
    })
    log.info("System email channel: resend (auth/team mail delivers to real inboxes)")
    return _systemProvider
  }
  // Inherit the default provider. NOT cached, so a later setEmailProvider()
  // (tests) is still honored by system sends.
  return withSystemFrom(getEmailProvider())
}

/**
 * What a failed send says about the provider as a whole, or null when it says
 * nothing (this one address, this one sender, a moment's rate limit).
 */
export function emailFailureOutage(err: unknown): { kind: EmailOutageKind; detail: string } | null {
  if (err instanceof EmailRateLimitError) {
    return err.reason === "daily_quota_exceeded" || err.reason === "monthly_quota_exceeded"
      ? { kind: "quota", detail: err.reason }
      : null
  }
  if (err instanceof EmailProviderError) {
    if (err.status === undefined || err.status >= 500) {
      return { kind: "unreachable", detail: `resend ${err.status ?? "network"}` }
    }
    const key = /invalid_api_key|missing_api_key|restricted_api_key/.exec(err.message)
    if (key) return { kind: "credentials", detail: key[0] }
    // Resend answers a key it does not take with 401 and the generic `validation_error`.
    return err.status === 401 ? { kind: "credentials", detail: "resend 401" } : null
  }
  // A nodemailer failure: `code` for the connection, `responseCode` and `response` for the server,
  // `command` for the stage it answered.
  const smtp = err as {
    code?: unknown
    command?: unknown
    responseCode?: unknown
    response?: unknown
  } | null
  if (!smtp || typeof smtp !== "object") return null
  const code = typeof smtp.code === "string" ? smtp.code : ""
  const reply = typeof smtp.responseCode === "number" ? smtp.responseCode : 0
  const text = typeof smtp.response === "string" ? smtp.response : ""
  if (code === "EAUTH" || reply === 535 || reply === 534) {
    return { kind: "credentials", detail: `smtp ${code || reply}` }
  }
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS"].includes(code)) {
    return { kind: "unreachable", detail: `smtp ${code}` }
  }
  if (reply === 421) return { kind: "unreachable", detail: "smtp 421" }
  // One mailbox or address, at any stage (x.1 and x.2 of RFC 3463, or plainly worded):
  // a server that checks its own users can say it after the data as well.
  if (/\b[45]\.[12]\.\d{1,3}\b|mailbox|over quota/i.test(text)) return null
  if (code === "EENVELOPE" && smtp.command === "RCPT TO") {
    // The reply is about this recipient (a greylist, a limit of theirs), unless it names the sender.
    if (/sending limit|sending paused|(daily|message|sending|send) quota/i.test(text)) {
      return { kind: "quota", detail: `smtp ${reply}` }
    }
    return /\b4\.3\.1\b/.test(text) ? { kind: "unreachable", detail: "smtp 4.3.1" } : null
  }
  if (/quota|sending limit|limit exceeded|sending paused/i.test(text)) {
    return { kind: "quota", detail: `smtp ${reply}` }
  }
  if (reply === 451 || reply === 452 || reply === 454) {
    return { kind: "unreachable", detail: `smtp ${reply}` }
  }
  return null
}

/**
 * A system mail a person is waiting on (a sign-in code, a reset link): sent as
 * any other, and its outcome kept as the instance's mail state (email-outage.ts).
 */
export async function sendSystemEmailObserved(message: EmailMessage): Promise<void> {
  try {
    await getSystemEmailProvider().send(message)
  } catch (err) {
    const outage = emailFailureOutage(err)
    if (outage) await noteEmailProviderRefused(outage.kind, outage.detail).catch(() => {})
    throw err
  }
  await noteEmailProviderAccepted().catch(() => {})
}

/** Override the system provider — for tests only. Pass null to reset. */
export function setSystemEmailProvider(provider: EmailProvider | null): void {
  _systemProvider = provider
}

// --- Org sender channel (managed edition) ---
//
// An org of the managed edition whose own sending domain is verified sends its
// org-scoped mail (invitations, connect links, digests, CSAT) with a key
// restricted to that domain, pushed by the control plane and stored encrypted
// in the org's settings (modules/cloud/mail-sender.ts). Resolution and the
// fallback sender live in `getOrgSenderTransport` (modules/org/email-from.ts);
// this builds the transport for one key. Sign-in mail never uses it.

export type OrgSenderProviderFactory = (config: { apiKey: string; from: string }) => EmailProvider

let orgSenderFactory: OrgSenderProviderFactory | null = null

/** A Resend transport on the org's own domain-restricted key. */
export function orgSenderProvider(config: { apiKey: string; from: string }): EmailProvider {
  if (orgSenderFactory) return orgSenderFactory(config)
  return new ResendEmailProvider(config)
}

/** Override the org sender transport — for tests only. Pass null to reset. */
export function setOrgSenderProviderFactory(factory: OrgSenderProviderFactory | null): void {
  orgSenderFactory = factory
}

// --- Demo system mail channel ---
//
// A demo box refuses every send on the two channels above. Two messages must
// still leave it: the visitor's verification code (to the address they typed
// at Start) and the owner alert (to LIAISON_DEMO_ALERT_EMAIL). They go through
// this THIRD channel, which exists only in demo mode and carries only fixed
// templates with no visitor-supplied text. Its importers are pinned by a test
// (demo-system-mail-imports.test.ts): demo-verification.ts and demo-alerts.ts,
// nothing else, so no product path can borrow it to mail a stranger.
//
// Provider: LIAISON_DEMO_MAIL_RESEND_API_KEY, else SYSTEM_RESEND_API_KEY. With
// neither, there is no channel (null) and the callers say so (a code send
// answers 503 `demo_mail_unavailable`). LIAISON_DEMO_MAIL_CAPTURE keeps every
// message in process for tests and local runs; it is refused in production.

/** One message the capture sender kept. */
export interface CapturedDemoMail extends EmailMessage {
  capturedAt: number
}

/** The in-process sender tests and local runs read their codes from. */
export class CapturedDemoMailProvider implements EmailProvider {
  readonly sent: CapturedDemoMail[] = []

  async send(message: EmailMessage): Promise<void> {
    this.sent.push({ ...message, capturedAt: Date.now() })
    if (this.sent.length > CONSOLE_SENT_LIMIT) {
      this.sent.splice(0, this.sent.length - CONSOLE_SENT_LIMIT)
    }
    log.info(emailLogFields(message), "Demo mail captured (not sent)")
  }

  async verify(): Promise<boolean> {
    return true
  }
}

let _demoCapture: CapturedDemoMailProvider | null = null
let _demoResend: ResendEmailProvider | null = null
let _demoSmtp: SmtpEmailProvider | null = null
let _demoSystemOverride: EmailProvider | null | undefined

/** The capture sender, created on first use. Read by tests. */
export function capturedDemoMail(): CapturedDemoMailProvider {
  if (!_demoCapture) _demoCapture = new CapturedDemoMailProvider()
  return _demoCapture
}

export class DemoMailCaptureInProductionError extends Error {
  constructor() {
    super("LIAISON_DEMO_MAIL_CAPTURE is set in production; demo system mail is refused")
    this.name = "DemoMailCaptureInProductionError"
  }
}

/**
 * The demo system mail provider, or null when this box has none. Demo mode
 * only (null otherwise). Throws when the capture sender is configured in
 * production.
 */
export function getDemoSystemMailProvider(): EmailProvider | null {
  if (_demoSystemOverride !== undefined) return _demoSystemOverride
  if (!isDemoModeEnabled()) return null
  if (env.LIAISON_DEMO_MAIL_CAPTURE) {
    if (env.NODE_ENV === "production") throw new DemoMailCaptureInProductionError()
    return capturedDemoMail()
  }
  const apiKey = env.LIAISON_DEMO_MAIL_RESEND_API_KEY || env.SYSTEM_RESEND_API_KEY
  if (apiKey) {
    if (!_demoResend) {
      _demoResend = new ResendEmailProvider({ apiKey, from: systemEmailFrom() })
      log.info("Demo system mail channel: resend")
    }
    return _demoResend
  }
  // A box that sends its mail over SMTP has a channel too (demoMailConfigured counts SMTP_HOST):
  // without it, an SMTP-only demo box could never turn visitor agents on.
  if (env.SMTP_HOST) {
    if (!_demoSmtp) {
      _demoSmtp = new SmtpEmailProvider({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: systemEmailFrom(),
        secure: env.SMTP_SECURE,
      })
      log.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, "Demo system mail channel: SMTP")
    }
    return _demoSmtp
  }
  return null
}

/** Does this box have a demo system mail channel at all? Never throws. */
export function isDemoSystemMailConfigured(): boolean {
  try {
    return getDemoSystemMailProvider() !== null
  } catch {
    return false
  }
}

/** Override the demo system provider — tests only. `undefined` restores the env choice. */
export function setDemoSystemMailProvider(provider: EmailProvider | null | undefined): void {
  _demoSystemOverride = provider
}

const escapeAlertHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Hand the owner alert (demo-alerts.ts) its sender: this channel, resolved per
 * send. Called once at boot in demo mode. A box with no channel registers no
 * sender, so visitor spend on the box key stays off (`no_mail`).
 */
export function registerDemoAlertChannel(): void {
  if (!isDemoSystemMailConfigured()) {
    registerDemoAlertMailer(null)
    return
  }
  registerDemoAlertMailer(async ({ to, subject, text }) => {
    const provider = getDemoSystemMailProvider()
    if (!provider) throw new Error("the demo system mail channel is not configured")
    await provider.send({
      to,
      subject,
      text,
      html: `<p>${escapeAlertHtml(text)}</p>`,
      template: "demo.owner-alert",
    })
  })
}

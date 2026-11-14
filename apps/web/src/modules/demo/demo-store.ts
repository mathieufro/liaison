// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visitor's own workspace: creating one, watching it fill in, and knowing
// when it is over.
//
// THE SESSION WORKS BEFORE THE WORLD DOES. `POST /api/demo/orgs` returns an org,
// a user, the agents and a session in seconds, and seeds the world behind the
// response (apps/api/src/modules/demo/routes.ts). So this store puts the
// visitor INTO the product on the response and polls `statusUrl` from there,
// rather than holding them on a waiting screen watching a bar move. The three
// states the poll can report are all real and all handled:
//
//   provisioning  the world is still filling in. Say so, keep polling.
//   ready         everything seeded.
//   failed        a part of the world did not seed, or the seed has been stuck
//                 past the server's own deadline. An error: the visitor is
//                 told so plainly, never shown a finished workspace.
//
// The poll budget is 600 an hour per peer and separate from the three signups,
// so polling can never lock a visitor out of the workspace it is reporting on.
// We still stop polling once the state settles, and back off while we wait.
import type { DemoEntry, DemoNeed } from "@liaison/shared"
import { createSignal } from "solid-js"
import { registerWsEntityHandler } from "~/framework/app-registry"
import { type ApiClient, anonApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { apiUrl } from "~/lib/env"
import { log } from "~/lib/logger"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { setTokens } from "~/modules/auth/auth-store"
import { _resetDemoWorld, forgetDemoWorld } from "~/modules/demo/demo-world"

const demoLog = log.child({ module: "demo" })

export type DemoProvisioningState = "provisioning" | "ready" | "failed"

export interface DemoWorkspace {
  orgId: string
  orgSlug: string
  /** Where the readiness poll goes. Server-supplied, never assembled here. */
  statusUrl: string
  state: DemoProvisioningState
  /** ISO 8601, from the server. The one thing that decides expiry. */
  expiresAt: string | null
}

/**
 * Why the signup could not be done, in the vocabulary the screen speaks. Every
 * member is a real response from the route, not a guess:
 *
 *   rate_limited   429 on the three-signups-an-hour budget.
 *   in_progress    503 (the box is busy), or a start the server still reported
 *                  as being made when this click's retry deadline ran out.
 *                  Carries the server's Retry-After.
 *   gone           409, the workspace this start's signup key made has expired
 *                  or is no longer a demo org (a reset or the reaper ran).
 *   unavailable    404, demo mode is off on this deployment.
 *   failed         anything else.
 */
export type DemoSignupFailure =
  | "rate_limited"
  | "in_progress"
  | "gone"
  | "unavailable"
  | "turnstile"
  | "disposable"
  | "domain_cap"
  | "failed"

export interface DemoSignupError {
  kind: DemoSignupFailure
  /** Seconds, when the server named one. */
  retryAfter: number | null
}

const STORAGE_KEY = "liaison:demo-workspace"

const [workspace, setWorkspaceSignal] = createSignal<DemoWorkspace | null>(readStored())

export { workspace as demoWorkspace }

/** A key has been accepted by the server: the agents run on it from now on. */
const BYOK_SAVED_KEY = "liaison:demo-byok-saved"
const [byokSaved, setByokSavedSignal] = createSignal(readFlag(BYOK_SAVED_KEY))

export { byokSaved as demoByokSaved }

export function markDemoByokSaved(): void {
  setByokSavedSignal(true)
  writeFlag(BYOK_SAVED_KEY, true)
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, "1")
    else localStorage.removeItem(key)
  } catch {
    // A browser with storage blocked simply re-offers the prompt next load,
    // which is the harmless direction.
  }
}

function readStored(): DemoWorkspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DemoWorkspace>
    if (typeof parsed.orgId !== "string" || typeof parsed.statusUrl !== "string") return null
    return {
      orgId: parsed.orgId,
      orgSlug: typeof parsed.orgSlug === "string" ? parsed.orgSlug : "",
      statusUrl: parsed.statusUrl,
      state: isState(parsed.state) ? parsed.state : "provisioning",
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
    }
  } catch {
    return null
  }
}

function isState(value: unknown): value is DemoProvisioningState {
  return value === "provisioning" || value === "ready" || value === "failed"
}

function setWorkspace(next: DemoWorkspace | null): void {
  // The saved-key flag belongs to ONE workspace. A visitor who saved a key in
  // a workspace that has since ended would otherwise never be offered the key
  // form in the next one, which has no key at all.
  const previous = workspace()
  if (previous && previous.orgId !== next?.orgId) {
    setByokSavedSignal(false)
    writeFlag(BYOK_SAVED_KEY, false)
  }
  setWorkspaceSignal(next)
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // The signal is the live truth; storage only survives a reload.
  }
}

/** Drop the record, so the entry screen offers a fresh workspace. */
export function forgetDemoWorkspace(): void {
  stopPolling()
  setWorkspace(null)
  forgetDemoWorld()
}

/**
 * Has this workspace's time run out? Decided against the server's `expiresAt`
 * and the caller's clock, exactly as the server decides it (demo-expiry.ts
 * reads the marker, never `created_at` plus an env value). A workspace with no
 * expiry never expires, which is the reserved App Review org's posture.
 */
export function isDemoWorkspaceExpired(
  now: number,
  ws: DemoWorkspace | null = workspace(),
): boolean {
  if (!ws?.expiresAt) return false
  const at = Date.parse(ws.expiresAt)
  return Number.isFinite(at) && at <= now
}

interface CreateResponse {
  orgId: string
  orgSlug: string
  userId: string
  state: DemoProvisioningState
  statusUrl: string
  expiresAt: string
  accessToken: string
  refreshToken?: string
  needs?: DemoNeed[]
  verification?: { sent: boolean; emailMasked: string }
}

function classify(err: unknown): DemoSignupError {
  if (err instanceof ApiError) {
    const retryAfter = typeof err.retryAfter === "number" ? err.retryAfter : null
    if (err.code === "turnstile_failed") return { kind: "turnstile", retryAfter: null }
    if (err.code === "disposable_email") return { kind: "disposable", retryAfter: null }
    if (err.code === "domain_cap") return { kind: "domain_cap", retryAfter: null }
    if (err.status === 429) return { kind: "rate_limited", retryAfter }
    if (err.status === 503) return { kind: "in_progress", retryAfter: retryAfter ?? 2 }
    if (err.status === 409) return { kind: "gone", retryAfter: null }
    if (err.status === 404) return { kind: "unavailable", retryAfter: null }
  }
  return { kind: "failed", retryAfter: null }
}

// ── The signup key: a lost response is recoverable ─────────────────────────
//
// A signup can outlive the request that carried it: the server's request
// timeout answers 504 without stopping the work, and a connection can drop or
// hang. The workspace is made either way, and the session rides only on the
// response, so without this the visitor clicked again, got a second workspace,
// and the first sat there with nobody able to enter it. So one "Start the demo"
// carries one random key, every retry of that start resends it (each with a
// fresh Turnstile token, which the server checks first every time), and the
// server answers a known key with the workspace it already made, or 202 while
// it is still making it. The key lives in sessionStorage until a start
// succeeds, so the next click after a failure resumes the same start; it is
// never the address or anything a stranger could type.

const SIGNUP_KEY_STORAGE = "liaison:demo-signup-key"
/** How long one click keeps retrying a lost or still-running start. */
const SIGNUP_RETRY_DEADLINE_MS = 2 * 60 * 1000
/**
 * How long one attempt may hang before it counts as lost. Past the server's own
 * thirty second request timeout, so a slow but live answer is not cut short.
 */
const SIGNUP_ATTEMPT_TIMEOUT_MS = 40_000
/** Backs off from two seconds to fifteen, so a dead connection is not a request storm. */
const SIGNUP_RETRY_FIRST_DELAY_MS = 2_000
const SIGNUP_RETRY_MAX_DELAY_MS = 15_000

let memorySignupKey: string | null = null

function newSignupKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The key of the start in progress, made on the first click and kept until it succeeds. */
function currentSignupKey(): string {
  try {
    const stored = sessionStorage.getItem(SIGNUP_KEY_STORAGE)
    if (stored) return stored
  } catch {
    // Storage blocked: the in-memory key still covers retries in this page.
  }
  if (!memorySignupKey) memorySignupKey = newSignupKey()
  try {
    sessionStorage.setItem(SIGNUP_KEY_STORAGE, memorySignupKey)
  } catch {
    // As above.
  }
  return memorySignupKey
}

function forgetSignupKey(): void {
  memorySignupKey = null
  try {
    sessionStorage.removeItem(SIGNUP_KEY_STORAGE)
  } catch {
    // As above.
  }
}

/** Thrown by an attempt this client gave up on: its answer may still have made the workspace. */
class SignupAttemptTimedOut extends Error {}

/** A failure that may have made the workspace anyway: the response was lost, not refused. */
function responseWasLost(err: unknown): boolean {
  if (err instanceof SignupAttemptTimedOut) return true
  return err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 504)
}

/** "Still being prepared, ask again", with the server's own wait when it is busy. */
interface SignupCreating {
  state: "creating"
  retryAfter?: number
}

function isCreating(body: unknown): body is SignupCreating {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { state?: unknown }).state === "creating" &&
    !("accessToken" in body)
  )
}

/** One POST, abandoned (and reported as lost) once it hangs past its own timeout. */
async function postSignupAttempt(
  body: Record<string, unknown>,
): Promise<CreateResponse | SignupCreating> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, SIGNUP_ATTEMPT_TIMEOUT_MS)
  try {
    return await anonApiClient.post<CreateResponse | SignupCreating>("/demo/orgs", body, {
      suppressGlobalError: true,
      signal: controller.signal,
    })
  } catch (err) {
    if (timedOut) throw new SignupAttemptTimedOut("signup attempt timed out")
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a visitor workspace and sign the visitor into it. A lost response or a
 * start still being made is retried with the same signup key and a fresh
 * Turnstile token, so the visitor lands in the workspace that start made rather
 * than in a second one. Resolves to the workspace, or throws a
 * {@link DemoSignupError} the screen renders as words rather than as a status
 * code.
 */
/** The door runs Turnstile (a site key is published) and the browser got no token. */
function turnstileFailed(token: string): boolean {
  return token === "" && typeof doorSettings()?.turnstileSiteKey === "string"
}

export async function createDemoWorkspace(input: {
  name: string
  email: string
  needs: DemoNeed[]
  /** The visitor ticked "send me news". */
  newsOptIn?: boolean
  /** The door's company question; absent when the visitor skipped it. */
  entry?: DemoEntry
  /** A fresh Turnstile token per attempt: the server checks one on every retry. */
  turnstileToken: () => Promise<string>
  /** Called when the server says the workspace is still being prepared (a busy moment). */
  onPreparing?: () => void
}): Promise<DemoWorkspace> {
  const signupKey = currentSignupKey()
  const deadline = Date.now() + SIGNUP_RETRY_DEADLINE_MS
  let delay = SIGNUP_RETRY_FIRST_DELAY_MS
  const wait = async () => {
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, SIGNUP_RETRY_MAX_DELAY_MS)
  }
  let body: CreateResponse
  for (;;) {
    let answer: CreateResponse | SignupCreating
    // No token while the door runs Turnstile means the browser's check failed:
    // the server would refuse the request, so say why instead of posting it.
    const turnstileToken = await input.turnstileToken()
    if (turnstileFailed(turnstileToken)) {
      throw { kind: "turnstile", retryAfter: null } as DemoSignupError
    }
    try {
      answer = await postSignupAttempt({
        name: input.name.trim(),
        email: input.email.trim(),
        needs: input.needs,
        ...(input.newsOptIn ? { newsOptIn: true } : {}),
        ...(input.entry ? { entry: input.entry } : {}),
        turnstileToken,
        signupKey,
      })
    } catch (err) {
      if (responseWasLost(err) && Date.now() < deadline) {
        demoLog.warn({ err }, "demo signup response lost; retrying with the same signup key")
        await wait()
        continue
      }
      // 409: the workspace this key made is gone; the next click starts afresh.
      if (err instanceof ApiError && err.status === 409) forgetSignupKey()
      throw classify(err)
    }
    if (isCreating(answer)) {
      if (Date.now() >= deadline) throw { kind: "in_progress", retryAfter: 2 } as DemoSignupError
      input.onPreparing?.()
      // The server names its own wait when it is busy; never ask sooner.
      const asked = typeof answer.retryAfter === "number" ? answer.retryAfter * 1000 : 0
      delay = Math.max(delay, Math.min(asked, SIGNUP_RETRY_MAX_DELAY_MS))
      await wait()
      continue
    }
    body = answer
    break
  }
  forgetSignupKey()
  const next: DemoWorkspace = {
    orgId: body.orgId,
    orgSlug: body.orgSlug,
    statusUrl: body.statusUrl,
    state: isState(body.state) ? body.state : "provisioning",
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  }
  // The session is live from here: this is what lets the visitor be put into
  // the product instead of onto a waiting screen. First: a session in another
  // org (an ended workspace's) resets every per-org store as it starts, so
  // what this workspace knows is written after it.
  setTokens(body.accessToken, body.refreshToken)
  setWorkspace(next)
  setVerification({
    verified: false,
    emailMasked: body.verification?.emailMasked ?? null,
    codeSent: body.verification?.sent === true,
  })
  return next
}

// ── Start over ───────────────────────────────────────────────────────────────

/** Why a start-over did not happen: the server's own sentence, when it gave one. */
export interface DemoStartOverError {
  kind: "limited" | "failed"
  message: string | null
}

/**
 * Start the demo over: the server hands this visitor a fresh workspace (same
 * person, same confirmed address, same budget and end date) and ends the old
 * one. The answer is a signup's, so the session moves to the new workspace in
 * place, exactly as after Start: every per-org store resets, scenarios read 0.
 * Throws a {@link DemoStartOverError}.
 */
export async function startDemoOver(api: ApiClient): Promise<DemoWorkspace> {
  let body: CreateResponse
  try {
    body = await api.post<CreateResponse>("/demo/start-over", {}, { suppressGlobalError: true })
  } catch (err) {
    const message = err instanceof ApiError && err.code ? err.message : null
    const kind = err instanceof ApiError && err.status === 429 ? "limited" : "failed"
    throw { kind, message } as DemoStartOverError
  }
  stopPolling()
  const next: DemoWorkspace = {
    orgId: body.orgId,
    orgSlug: body.orgSlug,
    statusUrl: body.statusUrl,
    state: isState(body.state) ? body.state : "provisioning",
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  }
  setTokens(body.accessToken, body.refreshToken)
  setWorkspace(next)
  // The address came along: the server says whether it is confirmed.
  void refreshDemoBudget(api)
  watchDemoWorkspace()
  return next
}

// ── Readiness polling ────────────────────────────────────────────────────────

/** Backs off from one second to eight, so a slow seed is not a poll storm. */
const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 8_000
/**
 * WHEN TO GIVE UP, and it is the SERVER'S answer, not ours.
 *
 * Three numbers used to disagree about how long a seed may take: the seeder was
 * given 900s, the server called a `provisioning` record stale after 5 minutes,
 * and this file stopped polling after 10 and gave up by itself. A visitor
 * whose seed legitimately took six minutes, the exact case the 900s raise
 * exists for, was told a few apps were emptier than they should be and was
 * never told the world had actually finished.
 *
 * So the status response now carries `pollUntil`, derived from the one deadline
 * in apps/api/src/modules/demo/demo-provisioning.ts, and this is only the
 * fallback for a server too old to send it. It is deliberately LONGER than the
 * server's deadline: overshooting costs one more poll on a 600-an-hour budget,
 * while undershooting is the bug above.
 */
const MAX_POLL_MS = 20 * 60 * 1000

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollGeneration = 0

export function stopPolling(): void {
  pollGeneration += 1
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

interface StatusResponse {
  state: DemoProvisioningState
  expiresAt?: string | null
  /** ISO 8601. When the SERVER says to stop asking. Absent on an older server. */
  pollUntil?: string | null
}

/** One status read. Exported so a test can drive a single step. */
export async function readDemoStatus(statusUrl: string): Promise<StatusResponse | null> {
  try {
    // `statusUrl` is server-supplied and starts `/api/`; the client's own base
    // handling wants the path without that prefix.
    const path = statusUrl.replace(/^\/api/, "")
    return await anonApiClient.get<StatusResponse>(path, { suppressGlobalError: true })
  } catch (err) {
    demoLog.warn({ err }, "demo status read failed")
    return null
  }
}

/**
 * Watch the workspace fill in, and stop the moment it settles. Idempotent: a
 * second call cancels the first, so a remount cannot leave two pollers running.
 */
export function watchDemoWorkspace(now: () => number = Date.now): void {
  const ws = workspace()
  if (!ws) return
  if (ws.state !== "provisioning") return
  stopPolling()
  const generation = pollGeneration
  const startedAt = now()
  let delay = FIRST_DELAY_MS
  /** The server's own deadline, once it has told us one. */
  let deadline: number | null = null

  const step = async (): Promise<void> => {
    if (generation !== pollGeneration) return
    const current = workspace()
    if (!current) return
    const status = await readDemoStatus(current.statusUrl)
    if (generation !== pollGeneration) return
    if (status && typeof status.pollUntil === "string") {
      const at = Date.parse(status.pollUntil)
      if (Number.isFinite(at)) deadline = at
    }
    if (status && isState(status.state)) {
      setWorkspace({
        ...current,
        state: status.state,
        expiresAt: typeof status.expiresAt === "string" ? status.expiresAt : current.expiresAt,
      })
      if (status.state !== "provisioning") {
        stopPolling()
        return
      }
    }
    if (deadline !== null ? now() > deadline : now() - startedAt > MAX_POLL_MS) {
      // Past the deadline the SERVER named (or, with no answer at all, past our
      // own fallback). Say the seed failed rather than spin: a seed past its
      // deadline did not finish, and the visitor is told so.
      const latest = workspace()
      if (latest) setWorkspace({ ...latest, state: "failed" })
      stopPolling()
      return
    }
    delay = Math.min(delay * 2, MAX_DELAY_MS)
    pollTimer = setTimeout(() => void step(), delay)
  }

  pollTimer = setTimeout(() => void step(), FIRST_DELAY_MS)
}

/**
 * Bring the stored record up to the SERVER's state, once, on mount.
 *
 * The record in storage is only what this browser last heard. A reload can
 * land with it at `provisioning` while the seed finished long ago (the poller
 * that would have said so died with the page, or never ran on this route), and
 * everything gated on readiness, the model key prompt first of all, then
 * stayed hidden for the life of the workspace. So any record that is not
 * `ready` asks the server once; a seed that really is still running gets its
 * poller back from here. A failed read changes nothing and still restarts the
 * poller, which carries its own retry and deadline.
 */
export async function syncDemoWorkspace(): Promise<void> {
  const ws = workspace()
  if (!ws || ws.state === "ready") return
  const status = await readDemoStatus(ws.statusUrl)
  const current = workspace()
  if (!current || current.orgId !== ws.orgId) return
  if (status && isState(status.state)) {
    setWorkspace({
      ...current,
      state: status.state,
      expiresAt: typeof status.expiresAt === "string" ? status.expiresAt : current.expiresAt,
    })
  }
  if (workspace()?.state === "provisioning") watchDemoWorkspace()
}

// ── The door's public settings ───────────────────────────────────────────────

/** What a demo deployment publishes for its door (public branding `demo`). */
export interface DemoDoorSettings {
  turnstileSiteKey?: string
  bookingUrl?: string
  /** The self-hosting guide; the option is absent when the box sets none. */
  selfHostUrl?: string
}

const [doorSettings, setDoorSettings] = createSignal<DemoDoorSettings | null>(null)

export { doorSettings as demoDoorSettings }

let doorInFlight: Promise<void> | null = null

/** Read the door's settings from the public branding read, once per page. */
export function ensureDemoDoorSettings(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (doorSettings()) return Promise.resolve()
  if (doorInFlight) return doorInFlight
  doorInFlight = (async () => {
    try {
      const res = await fetchImpl(apiUrl("/settings/branding"))
      if (!res.ok) return
      const body = (await res.json()) as { data?: { demo?: Partial<DemoDoorSettings> } }
      const demo = body?.data?.demo
      if (demo && typeof demo === "object") {
        setDoorSettings({
          ...(typeof demo.selfHostUrl === "string" ? { selfHostUrl: demo.selfHostUrl } : {}),
          ...(typeof demo.turnstileSiteKey === "string"
            ? { turnstileSiteKey: demo.turnstileSiteKey }
            : {}),
          ...(typeof demo.bookingUrl === "string" ? { bookingUrl: demo.bookingUrl } : {}),
        })
      }
    } catch (err) {
      demoLog.warn({ err }, "demo door settings read failed")
    } finally {
      doorInFlight = null
    }
  })()
  return doorInFlight
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface DemoVerificationState {
  verified: boolean
  emailMasked: string | null
  /** A code was sent at Start (or since). */
  codeSent: boolean
}

const [verification, setVerification] = createSignal<DemoVerificationState | null>(null)

export { verification as demoVerification }

/** Bumped whenever something asks the code field to take focus. */
const [verifyFocus, setVerifyFocus] = createSignal(0)

export { verifyFocus as demoVerifyFocusRequest }

/** Why a code action failed, in the vocabulary the prompt speaks. */
export type DemoCodeFailure =
  | { kind: "invalid"; attemptsLeft: number }
  | { kind: "expired" }
  | { kind: "exhausted" }
  | { kind: "send_limited"; retryAfter: number | null }
  | { kind: "verify_limited" }
  | { kind: "turnstile" }
  | { kind: "mail_unavailable" }
  | { kind: "failed" }

function codeFailure(err: unknown): DemoCodeFailure {
  if (err instanceof ApiError) {
    const left = err.details?.attemptsLeft
    switch (err.code) {
      case "code_invalid":
        return { kind: "invalid", attemptsLeft: typeof left === "number" ? left : 0 }
      case "code_expired":
        return { kind: "expired" }
      case "code_attempts_exhausted":
        return { kind: "exhausted" }
      case "code_send_limited":
        return { kind: "send_limited", retryAfter: err.retryAfter ?? null }
      case "verify_limited":
        return { kind: "verify_limited" }
      case "turnstile_failed":
        return { kind: "turnstile" }
      case "demo_mail_unavailable":
        return { kind: "mail_unavailable" }
    }
  }
  return { kind: "failed" }
}

/** Submit the code the visitor typed. Throws a {@link DemoCodeFailure}. */
export async function submitDemoCode(api: ApiClient, code: string): Promise<void> {
  try {
    await api.post("/demo/verify", { code: code.trim() }, { suppressGlobalError: true })
  } catch (err) {
    throw codeFailure(err)
  }
  setVerification((v) => ({ verified: true, emailMasked: v?.emailMasked ?? null, codeSent: true }))
  void refreshDemoBudget(api)
}

/** Re-send the code (fresh Turnstile token). Throws a {@link DemoCodeFailure}. */
export async function resendDemoCode(api: ApiClient, turnstileToken: string): Promise<void> {
  if (turnstileFailed(turnstileToken)) throw { kind: "turnstile" } as DemoCodeFailure
  try {
    const res = await api.post<{ sent: boolean; emailMasked: string }>(
      "/demo/verify/send",
      { turnstileToken },
      { suppressGlobalError: true },
    )
    setVerification((v) => ({
      verified: v?.verified ?? false,
      emailMasked: res.emailMasked,
      codeSent: true,
    }))
  } catch (err) {
    throw codeFailure(err)
  }
}

/** The link page's Confirm press: unauthenticated, token + fresh Turnstile. */
export async function confirmDemoLink(token: string, turnstileToken: string): Promise<void> {
  try {
    await anonApiClient.post(
      "/demo/verify",
      { token, turnstileToken },
      { suppressGlobalError: true },
    )
  } catch (err) {
    throw codeFailure(err)
  }
}

// ── Budget ───────────────────────────────────────────────────────────────────

export interface DemoBudgetState {
  verified: boolean
  emailMasked: string | null
  /** The visitor's own address (orders the next-steps options, fills the contact link). */
  email?: string | null
  /** The next-steps dialog already opened by itself in this workspace. */
  nextStepsShown?: boolean
  /** Opted in to news (checkbox or button). On the list only once verified too. */
  notifyManaged: boolean
  budget: { usedMicroEur: number; capMicroEur: number }
  box: { exhausted: boolean }
  byok: string[]
  /** A code is waiting in the visitor's inbox (false: none could be sent). */
  codeSent?: boolean
}

const [budget, setBudget] = createSignal<DemoBudgetState | null>(null)

export { budget as demoBudget }

/** Read the visitor's verification and budget from the server. */
export async function refreshDemoBudget(api: Pick<ApiClient, "get">): Promise<void> {
  try {
    const next = await api.get<DemoBudgetState>("/demo/budget", { suppressGlobalError: true })
    setBudget(next)
    setVerification((v) => ({
      verified: next.verified,
      emailMasked: next.emailMasked,
      codeSent: typeof next.codeSent === "boolean" ? next.codeSent : (v?.codeSent ?? true),
    }))
  } catch (err) {
    demoLog.warn({ err }, "demo budget read failed")
  }
}

/** The visitor runs the agents on a key of their own (saved here, or the server says so). */
export function demoHasOwnKey(): boolean {
  return byokSaved() || (budget()?.byok?.length ?? 0) > 0
}

/**
 * What the budget page headlines: the budget is open, spent, the box's day is
 * spent, or (on our key) the address is not confirmed yet.
 */
export type DemoBudgetHeadline = "open" | "spent" | "box" | "unverified"

export function demoBudgetHeadline(b: DemoBudgetState | null): DemoBudgetHeadline | null {
  if (!b) return null
  const ownKey = (b.byok?.length ?? 0) > 0
  if (ownKey) return "open"
  if (b.box?.exhausted) return "box"
  if (b.budget && b.budget.capMicroEur > 0 && b.budget.usedMicroEur >= b.budget.capMicroEur) {
    return "spent"
  }
  if (!b.verified) return "unverified"
  return "open"
}

/** The later opt-in to news, in the next-steps dialog. Verified only (403 otherwise). */
export async function requestManagedNotice(api: ApiClient): Promise<boolean> {
  try {
    await api.post("/demo/notify-managed", {}, { suppressGlobalError: true })
    setBudget((b) => (b ? { ...b, notifyManaged: true } : b))
    return true
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_verified") {
      setVerifyFocus((n) => n + 1)
      return false
    }
    throw err
  }
}

// ── Spend refusals and the next-steps dialog ─────────────────────────────────
//
// A refused agent turn reaches the visitor as a system message carrying the
// refusal code (`metadata.demoRefusal`), and an API refusal as an error code.
// Both land here: the code field takes focus on `demo_verification_required`,
// and the next-steps dialog (DemoNextSteps.tsx) opens on the FIRST budget or
// box refusal of the workspace: the server remembers it opened
// (`nextStepsShown`, POST /demo/next-steps/shown), so a reload does not open
// it again; the banner's Budget link opens it at any time. Any module can
// report a refusal without importing this file, through a
// `liaison:demo-refusal` window event.

export const DEMO_REFUSAL_EVENT = "liaison:demo-refusal"

const EXHAUSTED_CODES = new Set([
  "demo_budget_exhausted",
  "demo_box_exhausted",
  "demo_network_exhausted",
])

/**
 * When the dialog is shown: `budget` (the budget, opened by a refusal or the
 * banner) or `end` (after the visitor's last scenario).
 */
export type DemoNextStepsMoment = "budget" | "end"

const [nextSteps, setNextSteps] = createSignal<DemoNextStepsMoment | null>(null)

/** The moment the next-steps dialog is open for, or null when closed. */
export { nextSteps as demoNextSteps }

export function openDemoNextSteps(moment: DemoNextStepsMoment): void {
  setNextSteps(moment)
}

export function closeDemoNextSteps(): void {
  setNextSteps(null)
}

const [exhaustedOpen, setExhaustedOpen] = createSignal(0)
const [lastExhausted, setLastExhausted] = createSignal<string | null>(null)

/** The latest budget or box refusal code this page heard (the dialog's headline). */
/** Bumped once, on the first exhausted refusal of this page. */
export { exhaustedOpen as demoExhaustedRequest, lastExhausted as demoLastExhaustedRefusal }

let exhaustedShown = false

/**
 * The first exhausted refusal's follow-up (DemoHost): open the dialog unless
 * it already opened by itself in this workspace, and record that it did.
 */
export async function openDemoNextStepsOnce(api: Pick<ApiClient, "get" | "post">): Promise<void> {
  await refreshDemoBudget(api)
  if (budget()?.nextStepsShown === true) return
  openDemoNextSteps("budget")
  setBudget((b) => (b ? { ...b, nextStepsShown: true } : b))
  try {
    await api.post("/demo/next-steps/shown", {}, { suppressGlobalError: true })
  } catch (err) {
    demoLog.warn({ err }, "demo next-steps record failed")
  }
}

/** React to one spend refusal code. */
export function noteDemoRefusal(code: string | null | undefined): void {
  if (!code) return
  if (code === "demo_verification_required") {
    setVerification((v) => ({
      verified: false,
      emailMasked: v?.emailMasked ?? null,
      codeSent: v?.codeSent ?? false,
    }))
    setVerifyFocus((n) => n + 1)
    return
  }
  if (EXHAUSTED_CODES.has(code)) setLastExhausted(code)
  if (EXHAUSTED_CODES.has(code) && !exhaustedShown) {
    exhaustedShown = true
    setExhaustedOpen((n) => n + 1)
  }
}

let listening = false

/** Start listening for refusals (idempotent). DemoHost calls it in demo mode. */
export function listenForDemoRefusals(): void {
  if (listening) return
  listening = true
  registerWsEntityHandler(
    "message",
    "demo",
    (action, data) => {
      if (action !== "create") return
      const meta = (data as { metadata?: { demoRefusal?: unknown } } | null)?.metadata
      if (typeof meta?.demoRefusal === "string") noteDemoRefusal(meta.demoRefusal)
    },
    { owner: "demo-refusals" },
  )
  window.addEventListener(DEMO_REFUSAL_EVENT, (event) => {
    const code = (event as CustomEvent<{ code?: unknown }>).detail?.code
    if (typeof code === "string") noteDemoRefusal(code)
  })
}

// The address, the budget and the dialog's one opening belong to ONE
// workspace: the next session (a sign-out, another org) reads its own.
onSessionTeardown(() => {
  setVerification(null)
  setBudget(null)
  setNextSteps(null)
  setLastExhausted(null)
  exhaustedShown = false
})

/** @internal - test isolation only. Re-reads what a previous page left behind. */
export function _hydrateDemoWorkspace(): void {
  setWorkspaceSignal(readStored())
  setByokSavedSignal(readFlag(BYOK_SAVED_KEY))
}

/** @internal - test seam: the verification state a status read would set. */
export function _setDemoVerification(next: DemoVerificationState | null): void {
  setVerification(next)
}

/** @internal - test isolation only */
export function _resetDemoStore(): void {
  stopPolling()
  forgetSignupKey()
  setWorkspaceSignal(null)
  setVerification(null)
  setBudget(null)
  setDoorSettings(null)
  _resetDemoWorld()
  setNextSteps(null)
  setLastExhausted(null)
  exhaustedShown = false
  setByokSavedSignal(false)
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(BYOK_SAVED_KEY)
  } catch {
    // nothing to clear
  }
}

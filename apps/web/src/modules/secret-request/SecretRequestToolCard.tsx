// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SECRET CARD: where a person types a secret an agent asked for.
//
// The agent's `request_secret` call returns a request id; this card, drawn
// under that tool call, reads the request and shows what is asked for, where
// it goes (read-only and named) and a form. The secret is posted straight to
// the route that stores that kind of secret, with the person's own session,
// exactly as the settings page would; then the card asks the server to check
// the store (`/complete` takes no body). The agent never sees the secret.
//
// Password conventions of the API connector's credentials form: secret fields
// are password inputs with autocomplete off, values live in a signal and are
// cleared once saved, failures show a generic line (a provider key's refusal
// is shown as the key route words it, which never echoes the key).
//
// A new API key is created BY the person here and shown once, with Copy; it
// lives in this component only, so leaving the conversation drops it.
//
// A connect card (`oauth_connect`) types no secret. Its "Connect with Google"
// opens the provider's consent in a popup, opened synchronously in the click so
// no blocker stops it; the server then answers the provider's URL and the popup
// goes there. A blocked popup runs the consent in this tab instead, and the
// server brings the tab back to the conversation. The desktop and mobile apps
// run it their own way (settings/oauth-connect.ts, runShellOAuth). The card
// learns the result from the server (the request's event), never from the
// popup: the code and the tokens never reach this page.

import {
  googleSetupGuide,
  type SetupGuide,
  type SetupGuideTranslate,
  shopifyDashboardGuide,
} from "@liaison/shared"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { appLabel } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MailboxSetupCard } from "~/modules/mailbox/MailboxSetupCard"
import { runShellOAuth, shellRunsOAuth } from "~/modules/settings/oauth-connect"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { type ConnectPopup, openConnectPopup, takeConnectReturn } from "./connect-popup"
import {
  type SecretRequestGuide,
  type SecretRequestRow,
  secretRequestStore,
} from "./secret-request-store"

const QUIET = { suppressGlobalError: true } as const

/** Refusals of a connect's start the card words itself (secret-requests/routes.ts). */
const CONNECT_REFUSAL_CODES = new Set([
  "connect_missing_value",
  "connect_invalid_value",
  "connect_no_client",
  "connect_missing_setting",
  "connect_turned_off",
])

/** Providers the Connect button names; any other says "Connect". */
const CONNECT_PROVIDERS = new Set(["google", "shopify", "microsoft", "meta"])

/** Names the card knows how to label; any other field shows the app's own label or its name. */
const KNOWN_FIELDS = new Set([
  "apiKey",
  "token",
  "username",
  "password",
  "clientId",
  "clientSecret",
  "email",
  "shop",
])

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Post the typed values to the target's own route. */
async function storeSecret(
  api: ApiClient,
  row: SecretRequestRow,
  values: Record<string, string>,
  /** The person confirmed replacing a member's personal account of the same identifier. */
  takeOver = false,
): Promise<number> {
  const t = row.target
  switch (row.kind) {
    case "byok":
      await api.post(
        "/settings/ai/keys",
        { provider: text(t.provider), apiKey: values.apiKey ?? "" },
        QUIET,
      )
      return 0
    case "connection_credentials": {
      const app = encodeURIComponent(text(t.app))
      const connection = encodeURIComponent(text(t.connection))
      // The ORGANIZATION's account unless the agent asked for the person's own
      // (a personal mailbox): only that person can submit a personal card.
      await api.post(
        `/connections/${app}/${connection}/credentials`,
        {
          mode: t.mode === "personal" ? "personal" : "org",
          ...(takeOver ? { takeOver: true } : {}),
          credentials: { ...values, ...row.fixed },
        },
        QUIET,
      )
      return 0
    }
    case "oauth_client": {
      const app = encodeURIComponent(text(t.app))
      const connection = encodeURIComponent(text(t.connection))
      const saved = await api.put<{ reconnectToMove?: number }>(
        `/connections/${app}/${connection}/oauth-client`,
        { clientId: values.clientId ?? "", clientSecret: values.clientSecret ?? "" },
        QUIET,
      )
      return saved?.reconnectToMove ?? 0
    }
    case "google_integration_client":
      return (
        (
          await api.patch<{ reconnectToMove?: number }>(
            "/settings/integrations/google",
            { clientId: values.clientId ?? "", clientSecret: values.clientSecret ?? "" },
            QUIET,
          )
        )?.reconnectToMove ?? 0
      )
    case "api_key":
    case "oauth_connect":
      return 0
  }
}

/** A client card's guide as steps, in the viewer's language (shared with the agent's tool). */
function guideSteps(
  guide: SecretRequestGuide,
  t: SetupGuideTranslate,
  fallbackTitle: string,
): { guide: SetupGuide; docsUrl?: string } {
  switch (guide.provider) {
    case "google":
      return { guide: googleSetupGuide(guide.values, t) }
    case "shopify":
      return { guide: shopifyDashboardGuide(guide.values, t) }
    case "app":
      return {
        guide: {
          title: guide.summary ?? fallbackTitle,
          steps: guide.steps.map((step, i) => ({ id: `step-${i}`, title: step, body: "" })),
        },
        ...(guide.docsUrl ? { docsUrl: guide.docsUrl } : {}),
      }
  }
}

/** A client card's setup steps: numbered, with the values to copy. */
const GuideSteps: Component<{ guide: SecretRequestGuide }> = (props) => {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal<string | null>(null)
  const shown = () =>
    guideSteps(
      props.guide,
      (key, params) => i18n.t(key, params),
      i18n.t("secret-request.guide.title"),
    )
  async function copy(value: string): Promise<void> {
    if (!navigator.clipboard) return
    await navigator.clipboard.writeText(value)
    setCopied(value)
  }
  return (
    <section
      class="mt-2 flex flex-col gap-1.5 text-xs text-text-secondary"
      aria-label={shown().guide.title}
      data-testid="secret-request-guide"
    >
      <p class="font-medium text-text">{shown().guide.title}</p>
      <ol class="ml-4 list-decimal flex flex-col gap-1.5">
        <For each={shown().guide.steps}>
          {(step) => (
            <li data-testid={`secret-request-guide-step-${step.id}`}>
              <span class="font-medium text-text">{step.title}</span>
              <Show when={step.optional}>
                <span class="ml-1 text-text-tertiary">
                  {i18n.t("secret-request.guide.optional")}
                </span>
              </Show>
              <Show when={step.body}>
                <p class="mt-0.5">{step.body}</p>
              </Show>
              <For each={step.links ?? []}>
                {(link) => (
                  <a
                    class="mt-1 block text-accent hover:underline"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`secret-request-guide-link-${step.id}`}
                  >
                    {link.label}
                  </a>
                )}
              </For>
              <For each={step.values ?? []}>
                {(value) => (
                  <div
                    class="mt-1 flex items-center gap-2"
                    data-testid="secret-request-guide-value"
                  >
                    <code
                      // A sentence wraps at spaces; a URL, scope or command may break anywhere.
                      class={`select-all rounded-sm border border-border bg-bg px-1.5 py-0.5 ${
                        value.includes(" ") ? "break-words font-sans" : "break-all"
                      }`}
                    >
                      {value}
                    </code>
                    <Button size="sm" variant="ghost" onClick={() => void copy(value)}>
                      {copied() === value
                        ? i18n.t("secret-request.copied")
                        : i18n.t("secret-request.copy")}
                    </Button>
                  </div>
                )}
              </For>
            </li>
          )}
        </For>
      </ol>
      <Show when={shown().docsUrl}>
        {(url) => (
          <a class="underline" href={url()} target="_blank" rel="noopener noreferrer">
            {i18n.t("secret-request.guide.docs")}
          </a>
        )}
      </Show>
    </section>
  )
}

/**
 * A card that connected the person's own mailbox (Gmail or IMAP, mode
 * personal). A private mailbox fetches nothing until its owner sets a mailbox
 * password, so the connected card leads straight into the mailbox setup card;
 * a transparent one needs nothing and the setup card stays silent.
 */
export function personalMailbox(r: Pick<SecretRequestRow, "kind" | "target">): boolean {
  return (
    (r.kind === "oauth_connect" || r.kind === "connection_credentials") &&
    r.target.app === "mail" &&
    r.target.mode === "personal"
  )
}

function personalMailboxAddress(r: Pick<SecretRequestRow, "target">): string | undefined {
  const id = r.target.identifier
  return typeof id === "string" && id.includes("@") ? id : undefined
}

const SecretRequestToolCard: Component<{ requestId: string }> = (props) => {
  const api = useOptionalApi()
  const i18n = useI18n()
  if (api) void secretRequestStore.ensureLoaded(api, props.requestId).catch(() => undefined)
  const row = () => secretRequestStore.getById(props.requestId)

  const [values, setValues] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [missing, setMissing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  /** Accounts connected with another client that a reconnect moves to the saved one. */
  const [reconnectToMove, setReconnectToMove] = createSignal(0)
  const [revealedKey, setRevealedKey] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)
  const [takeover, setTakeover] = createSignal<{
    memberName: string
    entered: Record<string, string>
  } | null>(null)
  const [connecting, setConnecting] = createSignal(false)
  // A consent that ran in this tab and failed comes back to the conversation
  // with its reason: shown here, with Retry, and the address cleaned.
  const returned = typeof window === "undefined" ? null : takeConnectReturn(props.requestId)
  const [retry, setRetry] = createSignal(returned !== null)
  if (returned) setError(i18n.t(`secret-request.connectFailure.${returned}`))
  // A consent that failed in the popup: the server tells the card its reason
  // (the `secret_request` frame), shown here with Retry, like a same-tab return.
  createEffect(
    on(
      () => secretRequestStore.failureOf(props.requestId),
      (failure) => {
        if (!failure || row()?.status !== "pending") return
        setConnecting(false)
        setRetry(true)
        setError(i18n.t(`secret-request.connectFailure.${failure}`))
      },
    ),
  )
  const popupWatchers = new Set<ReturnType<typeof setInterval>>()
  onCleanup(() => {
    for (const timer of popupWatchers) clearInterval(timer)
    popupWatchers.clear()
  })

  const title = (r: SecretRequestRow) => {
    const t = r.target
    // An app with one connection of its own name reads "Sign-in for Shop", never "(shop)".
    const sameName =
      (r.kind === "connection_credentials" ||
        r.kind === "oauth_client" ||
        r.kind === "oauth_connect") &&
      text(t.app) !== "" &&
      text(t.connection) === text(t.app)
    return i18n.t(
      sameName ? `secret-request.titleOneConnection.${r.kind}` : `secret-request.title.${r.kind}`,
      {
        provider: i18n.t(`secret-request.provider.${text(t.provider)}`),
        app: text(t.app) ? appLabel(text(t.app), i18n.t) : "",
        connection: text(t.connection),
        identifier: text(t.identifier),
        label: text(t.label),
      },
    )
  }

  const connectLabel = (r: SecretRequestRow) => {
    const provider = r.connect?.provider
    return provider && CONNECT_PROVIDERS.has(provider)
      ? i18n.t("secret-request.connectWith", {
          provider: i18n.t(`secret-request.connectProvider.${provider}`),
        })
      : i18n.t("secret-request.connect")
  }

  const destinationValue = (d: { name: string; value: string }) =>
    d.name === "mode" && (d.value === "personal" || d.value === "org")
      ? i18n.t(`secret-request.mode.${d.value}`)
      : d.name === "app"
        ? appLabel(d.value, i18n.t)
        : d.value

  /** The read-only rows a person reads: the app by its name, and a connection only when it is not the app's own. */
  const destinationRows = (r: SecretRequestRow) => {
    const app = r.destination.find((d) => d.name === "app")?.value
    return r.destination.filter((d) => !(d.name === "connection" && d.value === app))
  }

  const fieldLabel = (field: { name: string; label?: string }) =>
    field.label ??
    (KNOWN_FIELDS.has(field.name) ? i18n.t(`secret-request.field.${field.name}`) : field.name)

  /**
   * The server's own refusal, which says why and what to do (a key of the wrong kind, a key the
   * provider refused), for every kind of card: the routes word it without the secret. A failure
   * with no such words (a network error, a 5xx other than the provider's 502) stays generic.
   */
  function failureText(_r: SecretRequestRow, err: unknown): string {
    if (
      err instanceof ApiError &&
      err.message &&
      ((err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) ||
        err.status === 502)
    ) {
      return err.message
    }
    return i18n.t("secret-request.failed")
  }

  async function complete(r: SecretRequestRow): Promise<void> {
    if (!api) return
    const saved = await api.post<SecretRequestRow>(
      `/secret-requests/${r.id}/complete`,
      undefined,
      QUIET,
    )
    if (saved?.id) secretRequestStore.upsert(saved)
  }

  async function save(e: Event): Promise<void> {
    e.preventDefault()
    const r = row()
    if (!api || !r) return
    const entered = Object.fromEntries(
      r.fields.map((f) => [
        f.name,
        f.secret ? (values()[f.name] ?? "") : (values()[f.name] ?? "").trim(),
      ]),
    )
    if (r.fields.some((f) => f.required && !entered[f.name])) {
      setMissing(true)
      return
    }
    setMissing(false)
    await submit(r, entered, false)
  }

  /**
   * Store, then ask the server to check. A member holding the same account
   * personally is a 409 naming them: the card says the save replaces it and
   * waits for the person to confirm (`takeOver`), keeping what was typed.
   */
  async function submit(
    r: SecretRequestRow,
    entered: Record<string, string>,
    takeOver: boolean,
  ): Promise<void> {
    if (!api) return
    setError(null)
    setTakeover(null)
    setBusy(true)
    try {
      setReconnectToMove(await storeSecret(api, r, entered, takeOver))
      setValues({})
      await complete(r)
    } catch (err) {
      if (
        !takeOver &&
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "connection_held_by_member"
      ) {
        const member = err.details?.memberName
        setTakeover({ memberName: typeof member === "string" ? member : "", entered })
      } else {
        setError(failureText(r, err))
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmTakeover(): Promise<void> {
    const r = row()
    const pending = takeover()
    if (!r || !pending) return
    await submit(r, pending.entered, true)
  }

  /** The typed fields of a connect card (Shopify's store), or null when one is missing. */
  function connectFields(r: SecretRequestRow): Record<string, string> | null {
    const entered = Object.fromEntries(
      r.fields.map((f) => [f.name, (values()[f.name] ?? "").trim()]),
    )
    if (r.fields.some((f) => f.required && !entered[f.name])) return null
    return entered
  }

  /**
   * A refused start in the person's words: a known refusal by its code, a
   * server refusal worded for a person (an app turned off) as it is, anything
   * else generic.
   */
  function connectFailureText(err: unknown): string {
    if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500) {
      return i18n.t("secret-request.connectFailed")
    }
    if (err.code && CONNECT_REFUSAL_CODES.has(err.code)) {
      return i18n.t(`secret-request.connectRefused.${err.code}`)
    }
    if (err.code === "connect_failed" || !err.message) return i18n.t("secret-request.connectFailed")
    return err.message
  }

  /**
   * Connect, from the click itself: the popup must open before any await, or
   * the browser blocks it. In a shell the app's own flow runs instead.
   */
  function connect(): void {
    const r = row()
    if (!api || !r || connecting()) return
    const entered = connectFields(r)
    if (!entered) {
      setMissing(true)
      return
    }
    setMissing(false)
    setError(null)
    setRetry(false)
    secretRequestStore.clearFailure(r.id)
    if (shellRunsOAuth()) {
      void connectInShell(r, entered)
      return
    }
    const popup = openConnectPopup(r.id)
    void connectInBrowser(r, entered, popup)
  }

  async function connectInBrowser(
    r: SecretRequestRow,
    entered: Record<string, string>,
    popup: ConnectPopup | null,
  ): Promise<void> {
    if (!api) return
    setConnecting(true)
    try {
      const started = await api.post<{ redirectUrl?: string } | null>(
        `/secret-requests/${r.id}/authorize`,
        { ...entered, display: popup ? "popup" : "tab" },
        QUIET,
      )
      if (!started?.redirectUrl) throw new Error("no redirect")
      if (!popup) {
        // Blocked: this tab goes to the provider, and the server brings it
        // back to this conversation.
        window.location.assign(started.redirectUrl)
        return
      }
      popup.location.href = started.redirectUrl
      watchPopup(popup, r.id)
    } catch (err) {
      popup?.close()
      setConnecting(false)
      setError(connectFailureText(err))
    }
  }

  /** When the popup closes, the card re-reads its row (the event may already have). */
  function watchPopup(popup: ConnectPopup, id: string): void {
    const timer = setInterval(() => {
      if (!popup.closed) return
      clearInterval(timer)
      popupWatchers.delete(timer)
      setConnecting(false)
      if (api) void secretRequestStore.reload(api, id).catch(() => undefined)
    }, 500)
    popupWatchers.add(timer)
  }

  async function connectInShell(r: SecretRequestRow, entered: Record<string, string>) {
    if (!api) return
    setConnecting(true)
    try {
      const outcome = await runShellOAuth({
        start: async (params) =>
          (
            await api.post<{ redirectUrl?: string } | null>(
              `/secret-requests/${r.id}/authorize`,
              { ...entered, ...params },
              QUIET,
            )
          )?.redirectUrl,
        redeem: (body) => api.post<unknown>("/connections/oauth-handoff", body, QUIET),
      })
      if (outcome.kind === "connected") await secretRequestStore.reload(api, r.id)
    } catch (err) {
      // The shell's own failures are worded for a person (oauth-connect.ts).
      setError(
        err instanceof ApiError || !(err instanceof Error) ? connectFailureText(err) : err.message,
      )
    } finally {
      setConnecting(false)
    }
  }

  async function createKey(): Promise<void> {
    const r = row()
    if (!api || !r) return
    setError(null)
    setBusy(true)
    try {
      const origins = Array.isArray(r.target.allowedOrigins) ? r.target.allowedOrigins : []
      const minted = await api.post<{ key?: unknown }>(
        "/apps/run-tool",
        {
          toolName: "tickets:apiKeys.create",
          params: {
            label: text(r.target.label),
            ...(origins.length ? { allowedOrigins: origins } : {}),
          },
        },
        QUIET,
      )
      if (typeof minted?.key !== "string") throw new Error("no key")
      setRevealedKey(minted.key)
      await complete(r)
    } catch (err) {
      setError(failureText(r, err))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    const r = row()
    if (!api || !r) return
    setError(null)
    try {
      const cancelled = await api.post<SecretRequestRow>(
        `/secret-requests/${r.id}/cancel`,
        undefined,
        QUIET,
      )
      setValues({})
      if (cancelled?.id) secretRequestStore.upsert(cancelled)
    } catch (err) {
      setError(failureText(r, err))
    }
  }

  async function copyKey(): Promise<void> {
    const key = revealedKey()
    if (!key || !navigator.clipboard) return
    await navigator.clipboard.writeText(key)
    setCopied(true)
  }

  return (
    <Show when={row()}>
      {(r) => (
        <div
          class="mt-1 rounded-md border border-border bg-surface px-4 py-3 text-[13px]"
          data-testid={`secret-request-${r().id}`}
        >
          <div class="font-medium text-text" data-testid="secret-request-title">
            {title(r())}
          </div>
          <p class="mt-0.5 text-xs text-text-secondary" data-testid="secret-request-asked-by">
            {r().agentName
              ? i18n.t("secret-request.askedByFor", {
                  agent: r().agentName ?? "",
                  requester: r().requesterName ?? "",
                })
              : i18n.t("secret-request.askedFor", { requester: r().requesterName ?? "" })}
          </p>
          <p class="mt-0.5 text-xs text-text-secondary">{i18n.t("secret-request.subtitle")}</p>
          <Show when={destinationRows(r()).length > 0}>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <For each={destinationRows(r())}>
                {(d) => (
                  <>
                    <dt class="text-text-tertiary">
                      {i18n.t(`secret-request.destination.${d.name}`)}
                    </dt>
                    <dd
                      class="truncate text-text-secondary"
                      data-testid={`secret-request-destination-${d.name}`}
                    >
                      {destinationValue(d)}
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </Show>

          <Show when={r().status === "pending" && r().canSubmit ? r().guide : null}>
            {(guide) => <GuideSteps guide={guide()} />}
          </Show>

          <Show when={revealedKey()}>
            {(key) => (
              <div class="mt-3 flex flex-col gap-1.5" data-testid="secret-request-key-reveal">
                <code
                  class="block select-all break-all rounded-sm border border-border bg-bg px-2 py-1.5 text-[12.5px]"
                  data-testid="secret-request-key"
                >
                  {key()}
                </code>
                <div class="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="secret-request-key-copy"
                    onClick={() => void copyKey()}
                  >
                    {copied() ? i18n.t("secret-request.copied") : i18n.t("secret-request.copy")}
                  </Button>
                  <span class="text-xs text-text-secondary" data-testid="secret-request-key-once">
                    {i18n.t("secret-request.keyShownOnce")}
                  </span>
                </div>
              </div>
            )}
          </Show>

          <Switch>
            <Match when={r().status === "saved" && r().kind === "oauth_connect"}>
              <p class="mt-2 text-xs text-text-secondary" data-testid="secret-request-connected">
                {r().hint
                  ? i18n.t("secret-request.connectedWithHint", { hint: r().hint ?? "" })
                  : i18n.t("secret-request.connected")}
              </p>
              {/* The person's own mailbox: on to its mailbox password, if it waits for one. */}
              <Show when={personalMailbox(r())}>
                <MailboxSetupCard quiet email={personalMailboxAddress(r())} />
              </Show>
            </Match>
            <Match when={r().status === "saved"}>
              <p class="mt-2 text-xs text-text-secondary" data-testid="secret-request-saved">
                {r().hint
                  ? i18n.t("secret-request.savedWithHint", { hint: r().hint ?? "" })
                  : i18n.t("secret-request.saved")}
              </p>
              <Show when={reconnectToMove() > 0}>
                <p
                  class="mt-1 text-xs text-text-secondary"
                  data-testid="secret-request-reconnect-to-move"
                >
                  {i18n.t("secret-request.reconnectToMove", { count: reconnectToMove() })}
                </p>
              </Show>
            </Match>
            <Match when={r().status === "cancelled"}>
              <p class="mt-2 text-xs text-text-secondary" data-testid="secret-request-cancelled">
                {i18n.t("secret-request.cancelled")}
              </p>
            </Match>
            <Match when={r().status === "expired"}>
              <p class="mt-2 text-xs text-text-secondary" data-testid="secret-request-expired">
                {i18n.t("secret-request.expired")}
              </p>
            </Match>
            <Match when={!r().canSubmit}>
              <div class="mt-2 flex items-center gap-2">
                <p class="text-xs text-text-secondary" data-testid="secret-request-waiting">
                  {(r().kind === "oauth_connect" || r().kind === "connection_credentials") &&
                  r().target.mode === "personal"
                    ? i18n.t("secret-request.waitingForRequester", {
                        requester: r().requesterName ?? "",
                      })
                    : r().kind === "oauth_connect"
                      ? i18n.t("secret-request.waitingForConnect")
                      : i18n.t("secret-request.waiting")}
                </p>
                <Show when={r().canCancel}>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="secret-request-cancel"
                    onClick={() => void cancel()}
                  >
                    {i18n.t("secret-request.cancel")}
                  </Button>
                </Show>
              </div>
            </Match>
            <Match when={r().kind === "oauth_connect"}>
              <form
                class="mt-3 flex flex-col gap-3"
                autocomplete="off"
                data-testid="secret-request-connect-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  connect()
                }}
              >
                <For each={r().fields}>
                  {(field) => (
                    <Input
                      data-testid={`secret-request-field-${field.name}`}
                      name={field.name}
                      type="text"
                      autocomplete="off"
                      label={fieldLabel(field)}
                      placeholder={
                        field.name === "shop" ? i18n.t("secret-request.shopPlaceholder") : undefined
                      }
                      value={values()[field.name] ?? ""}
                      onInput={(e) => {
                        const value = e.currentTarget.value
                        setValues((v) => ({ ...v, [field.name]: value }))
                      }}
                    />
                  )}
                </For>
                <Show when={missing()}>
                  <p class="text-xs text-error" data-testid="secret-request-missing">
                    {i18n.t("secret-request.missing")}
                  </p>
                </Show>
                <div class="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    data-testid="secret-request-connect"
                    loading={connecting()}
                  >
                    {retry() ? i18n.t("secret-request.connectRetry") : connectLabel(r())}
                  </Button>
                  <Show when={r().canCancel}>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="secret-request-cancel"
                      onClick={() => void cancel()}
                    >
                      {i18n.t("secret-request.cancel")}
                    </Button>
                  </Show>
                </div>
                <Show when={connecting()}>
                  <p
                    class="text-xs text-text-secondary"
                    role="status"
                    aria-live="polite"
                    data-testid="secret-request-connecting"
                  >
                    {i18n.t("secret-request.connecting")}
                  </p>
                </Show>
              </form>
            </Match>
            <Match when={r().kind === "api_key"}>
              <div class="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  data-testid="secret-request-create-key"
                  loading={busy()}
                  onClick={() => void createKey()}
                >
                  {i18n.t("secret-request.createKey")}
                </Button>
                <Show when={r().canCancel}>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="secret-request-cancel"
                    onClick={() => void cancel()}
                  >
                    {i18n.t("secret-request.cancel")}
                  </Button>
                </Show>
              </div>
            </Match>
            <Match when={true}>
              <form
                class="mt-3 flex flex-col gap-3"
                autocomplete="off"
                data-testid="secret-request-form"
                onSubmit={(e) => void save(e)}
              >
                <For each={r().fields}>
                  {(field) => (
                    <Input
                      data-testid={`secret-request-field-${field.name}`}
                      name={field.name}
                      type={field.secret ? "password" : "text"}
                      autocomplete={field.secret ? "new-password" : "off"}
                      data-1p-ignore={true}
                      data-lpignore="true"
                      label={fieldLabel(field)}
                      value={values()[field.name] ?? ""}
                      onInput={(e) => {
                        const value = e.currentTarget.value
                        setValues((v) => ({ ...v, [field.name]: value }))
                      }}
                    />
                  )}
                </For>
                <Show when={missing()}>
                  <p class="text-xs text-error" data-testid="secret-request-missing">
                    {i18n.t("secret-request.missing")}
                  </p>
                </Show>
                <div class="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    data-testid="secret-request-save"
                    loading={busy()}
                  >
                    {i18n.t("secret-request.save")}
                  </Button>
                  <Show when={r().canCancel}>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="secret-request-cancel"
                      onClick={() => void cancel()}
                    >
                      {i18n.t("secret-request.cancel")}
                    </Button>
                  </Show>
                </div>
              </form>
            </Match>
          </Switch>
          <Show when={takeover()}>
            {(pending) => (
              <div
                class="mt-2 flex flex-col gap-2 rounded-sm border border-border px-3 py-2 text-xs"
                data-testid="secret-request-takeover"
              >
                <p class="text-text-secondary">
                  {i18n.t("secret-request.takeoverNotice", { member: pending().memberName })}
                </p>
                <div class="flex items-center gap-2">
                  <Button
                    size="sm"
                    data-testid="secret-request-takeover-confirm"
                    loading={busy()}
                    onClick={() => void confirmTakeover()}
                  >
                    {i18n.t("secret-request.takeoverConfirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="secret-request-takeover-cancel"
                    onClick={() => setTakeover(null)}
                  >
                    {i18n.t("secret-request.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={error()}>
            {(message) => (
              <p class="mt-2 text-xs text-error" role="alert" data-testid="secret-request-error">
                {message()}
              </p>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

export default SecretRequestToolCard

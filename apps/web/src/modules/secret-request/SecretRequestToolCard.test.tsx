// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

const shellMocks = vi.hoisted(() => ({
  shellRunsOAuth: vi.fn(() => false),
  runShellOAuth: vi.fn(),
}))
vi.mock("~/modules/settings/oauth-connect", () => shellMocks)

const popupMocks = vi.hoisted(() => ({
  openConnectPopup: vi.fn(),
  takeConnectReturn: vi.fn((): string | null => null),
}))
vi.mock("./connect-popup", () => popupMocks)

import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import SecretRequestToolCard from "./SecretRequestToolCard"
import { type SecretRequestRow, secretRequestStore } from "./secret-request-store"

let seq = 0

function row(over: Partial<SecretRequestRow> = {}): SecretRequestRow {
  seq += 1
  return {
    id: `sec-${seq}`,
    kind: "byok",
    target: { provider: "openrouter" },
    title: "OpenRouter API key",
    status: "pending",
    hint: null,
    requestedBy: "u-1",
    agentId: "a-1",
    threadId: "t-1",
    createdAt: "2026-10-25T10:00:00Z",
    expiresAt: "2026-10-26T10:00:00Z",
    completedAt: null,
    canSubmit: true,
    canCancel: true,
    fields: [{ name: "apiKey", secret: true, required: true }],
    destination: [{ name: "provider", value: "openrouter" }],
    fixed: {},
    agentName: "Setup",
    requesterName: "Dana",
    ...over,
  }
}

function mount(r: SecretRequestRow) {
  apiMocks.get.mockResolvedValue(r)
  return render(() => (
    <I18nProvider>
      <SecretRequestToolCard requestId={r.id} />
    </I18nProvider>
  ))
}

function input(testId: string): HTMLInputElement {
  const el = screen.getByTestId(testId)
  if (!(el instanceof HTMLInputElement)) throw new Error(`${testId} is not an input`)
  return el
}

describe("SecretRequestToolCard", () => {
  beforeEach(() => {
    for (const fn of Object.values(apiMocks)) fn.mockReset()
  })

  it("byok: a password field, the provider named, Save and Cancel", async () => {
    const r = row()
    mount(r)
    expect(await screen.findByTestId(`secret-request-${r.id}`)).toBeInTheDocument()
    const key = input("secret-request-field-apiKey")
    expect(key.type).toBe("password")
    expect(key.autocomplete).toBe("new-password")
    expect(screen.getByTestId("secret-request-destination-provider")).toHaveTextContent(
      "openrouter",
    )
    expect(screen.getByTestId("secret-request-save")).toBeInTheDocument()
    expect(screen.getByTestId("secret-request-cancel")).toBeInTheDocument()
  })

  it("says who asked: the agent, for the person", async () => {
    const r = row()
    mount(r)
    expect(await screen.findByTestId("secret-request-asked-by")).toHaveTextContent(
      "Asked by Setup for Dana",
    )
  })

  it("a member's personal account: the card says it replaces it and asks before taking it over", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", identifier: "ops@example.com" },
      title: "mail imap credentials (ops@example.com)",
      fields: [{ name: "password", label: "Password", secret: true, required: true }],
      destination: [{ name: "identifier", value: "ops@example.com" }],
      fixed: { email: "ops@example.com" },
    })
    mount(r)
    await screen.findByTestId("secret-request-field-password")
    let attempts = 0
    apiMocks.post.mockImplementation(async (path: string, body: { takeOver?: boolean }) => {
      if (path.endsWith("/complete")) return { ...r, status: "saved", canSubmit: false }
      attempts += 1
      if (!body.takeOver) {
        throw new ApiError("held", 409, "connection_held_by_member", undefined, {
          memberName: "Morgan",
        })
      }
      return {}
    })
    fireEvent.input(input("secret-request-field-password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    expect(await screen.findByTestId("secret-request-takeover")).toHaveTextContent(
      "This replaces Morgan's personal account.",
    )
    expect(apiMocks.post).not.toHaveBeenCalledWith(
      `/secret-requests/${r.id}/complete`,
      undefined,
      expect.anything(),
    )
    fireEvent.click(screen.getByTestId("secret-request-takeover-confirm"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/mail/imap/credentials",
        { mode: "org", takeOver: true, credentials: { password: "pw", email: "ops@example.com" } },
        { suppressGlobalError: true },
      ),
    )
    expect(attempts).toBe(2)
    expect(await screen.findByTestId("secret-request-saved")).toBeInTheDocument()
  })

  it("posts the key to the key route, then asks the server to check, and clears the field", async () => {
    const r = row()
    mount(r)
    await screen.findByTestId("secret-request-field-apiKey")
    apiMocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/complete") ? { ...r, status: "saved", hint: "…abcd", canSubmit: false } : {},
    )
    fireEvent.input(input("secret-request-field-apiKey"), {
      target: { value: "sk-or-typed-abcd" },
    })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(`/secret-requests/${r.id}/complete`, undefined, {
        suppressGlobalError: true,
      }),
    )
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/settings/ai/keys",
      { provider: "openrouter", apiKey: "sk-or-typed-abcd" },
      { suppressGlobalError: true },
    )
    expect(await screen.findByTestId("secret-request-saved")).toHaveTextContent("…abcd")
    expect(screen.queryByTestId("secret-request-field-apiKey")).toBeNull()
  })

  it("byok: shows the key route's refusal, which never echoes the key, and keeps the form", async () => {
    const r = row()
    mount(r)
    await screen.findByTestId("secret-request-field-apiKey")
    apiMocks.post.mockRejectedValue(new ApiError("Invalid API key for OpenRouter", 400))
    fireEvent.input(input("secret-request-field-apiKey"), { target: { value: "bad" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    expect(await screen.findByTestId("secret-request-error")).toHaveTextContent(
      "Invalid API key for OpenRouter",
    )
    expect(apiMocks.post).not.toHaveBeenCalledWith(
      `/secret-requests/${r.id}/complete`,
      undefined,
      expect.anything(),
    )
  })

  it("someone without the scope sees the card read-only", async () => {
    const r = row({ canSubmit: false, canCancel: false })
    mount(r)
    expect(await screen.findByTestId("secret-request-waiting")).toBeInTheDocument()
    expect(screen.queryByTestId("secret-request-field-apiKey")).toBeNull()
    expect(screen.queryByTestId("secret-request-save")).toBeNull()
  })

  it("connection credentials: posts the org-owned account (mode org) with the declared fields", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "gitlab", connection: "gitlab" },
      title: "gitlab gitlab credentials",
      fields: [
        { name: "token", label: "Access token", secret: true, required: true },
        { name: "group", label: "Group", secret: false, required: true },
      ],
      destination: [
        { name: "app", value: "gitlab" },
        { name: "connection", value: "gitlab" },
      ],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-token")
    expect(input("secret-request-field-token").type).toBe("password")
    expect(input("secret-request-field-group").type).toBe("text")
    apiMocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/complete") ? { ...r, status: "saved", canSubmit: false } : {},
    )
    fireEvent.input(input("secret-request-field-token"), { target: { value: "glpat-x" } })
    fireEvent.input(input("secret-request-field-group"), { target: { value: "acme" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/gitlab/gitlab/credentials",
        { mode: "org", credentials: { token: "glpat-x", group: "acme" } },
        { suppressGlobalError: true },
      ),
    )
  })

  it("connection credentials, mode personal: posts the person's own account", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "gitlab", connection: "gitlab", mode: "personal" },
      title: "gitlab gitlab credentials (personal)",
      fields: [{ name: "token", label: "Access token", secret: true, required: true }],
      destination: [
        { name: "app", value: "gitlab" },
        { name: "connection", value: "gitlab" },
      ],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-token")
    apiMocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/complete") ? { ...r, status: "saved", canSubmit: false } : {},
    )
    fireEvent.input(input("secret-request-field-token"), { target: { value: "glpat-own" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/gitlab/gitlab/credentials",
        { mode: "personal", credentials: { token: "glpat-own" } },
        { suppressGlobalError: true },
      ),
    )
  })

  it("a refused key shows the server's own reason, and the app reads by its name, never its ids", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "boxtal", connection: "boxtal" },
      title: "boxtal boxtal credentials",
      fields: [{ name: "apiKey", label: "Restricted key", secret: true, required: true }],
      destination: [
        { name: "app", value: "boxtal" },
        { name: "connection", value: "boxtal" },
      ],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-apiKey")
    expect(screen.queryByTestId("secret-request-destination-connection")).toBeNull()
    expect(screen.getByTestId("secret-request-destination-app").textContent).not.toBe("boxtal")
    apiMocks.post.mockRejectedValue(
      new ApiError(
        "That is your secret key, so I did not keep it. Paste a restricted key: it starts with rk_.",
        400,
        "secret_key_refused",
      ),
    )
    fireEvent.input(input("secret-request-field-apiKey"), { target: { value: "sk_test_x" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    expect(await screen.findByTestId("secret-request-error")).toHaveTextContent("starts with rk_")
  })

  it("a mailbox the request names: its address is sent as is, never asked for", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "mail", connection: "imap", identifier: "ops@example.com" },
      title: "mail imap credentials (ops@example.com)",
      fields: [{ name: "password", label: "Password", secret: true, required: true }],
      destination: [{ name: "identifier", value: "ops@example.com" }],
      fixed: { email: "ops@example.com" },
    })
    mount(r)
    await screen.findByTestId("secret-request-field-password")
    expect(screen.queryByTestId("secret-request-field-email")).toBeNull()
    apiMocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/complete") ? { ...r, status: "saved", canSubmit: false } : {},
    )
    fireEvent.input(input("secret-request-field-password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/mail/imap/credentials",
        { mode: "org", credentials: { password: "pw", email: "ops@example.com" } },
        { suppressGlobalError: true },
      ),
    )
  })

  it("API connection: posts mode org with the adapter's identifier and shows where it goes", async () => {
    const r = row({
      kind: "connection_credentials",
      target: { app: "api-connector", connection: "api", identifier: "crm" },
      title: "api-connector api credentials (crm)",
      fields: [{ name: "token", secret: true, required: true }],
      fixed: { identifier: "crm" },
      destination: [
        { name: "app", value: "api-connector" },
        { name: "connection", value: "api" },
        { name: "identifier", value: "crm" },
        { name: "baseUrl", value: "https://crm.example.com" },
        { name: "authType", value: "bearer" },
      ],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-token")
    expect(screen.getByTestId("secret-request-destination-baseUrl")).toHaveTextContent(
      "https://crm.example.com",
    )
    apiMocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/complete") ? { ...r, status: "saved", canSubmit: false } : {},
    )
    fireEvent.input(input("secret-request-field-token"), { target: { value: "crm-token" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/api-connector/api/credentials",
        { mode: "org", credentials: { identifier: "crm", token: "crm-token" } },
        { suppressGlobalError: true },
      ),
    )
  })

  it("OAuth client: the id in plain text, the secret as a password, saved with PUT", async () => {
    const r = row({
      kind: "oauth_client",
      target: { app: "mail", connection: "gmail" },
      title: "mail gmail OAuth client",
      fields: [
        { name: "clientId", secret: false, required: true },
        { name: "clientSecret", secret: true, required: true },
      ],
      destination: [],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-clientId")
    expect(input("secret-request-field-clientId").type).toBe("text")
    expect(input("secret-request-field-clientSecret").type).toBe("password")
    apiMocks.put.mockResolvedValue({})
    apiMocks.post.mockResolvedValue({ ...r, status: "saved", canSubmit: false })
    fireEvent.input(input("secret-request-field-clientId"), { target: { value: "id-1" } })
    fireEvent.input(input("secret-request-field-clientSecret"), { target: { value: "s-1" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    await waitFor(() =>
      expect(apiMocks.put).toHaveBeenCalledWith(
        "/connections/mail/gmail/oauth-client",
        { clientId: "id-1", clientSecret: "s-1" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("OAuth client: when accounts were connected with another client, the saved card says a reconnect moves them", async () => {
    const r = row({
      kind: "oauth_client",
      target: { app: "shopify", connection: "shop" },
      title: "shopify shop OAuth client",
      fields: [
        { name: "clientId", secret: false, required: true },
        { name: "clientSecret", secret: true, required: true },
      ],
      destination: [],
    })
    mount(r)
    await screen.findByTestId("secret-request-field-clientId")
    apiMocks.put.mockResolvedValue({ configured: true, reconnectToMove: 2 })
    apiMocks.post.mockResolvedValue({ ...r, status: "saved", canSubmit: false })
    fireEvent.input(input("secret-request-field-clientId"), { target: { value: "id-1" } })
    fireEvent.input(input("secret-request-field-clientSecret"), { target: { value: "s-1" } })
    fireEvent.click(screen.getByTestId("secret-request-save"))
    expect(await screen.findByTestId("secret-request-reconnect-to-move")).toHaveTextContent("2")
  })

  it("API key: the person creates it, sees it once with Copy, and the card says it will not be shown again", async () => {
    const r = row({
      kind: "api_key",
      target: { label: "Website form" },
      title: 'API key "Website form"',
      fields: [],
      destination: [{ name: "label", value: "Website form" }],
    })
    mount(r)
    apiMocks.post.mockImplementation(async (path: string) =>
      path === "/apps/run-tool"
        ? { key: "ABCD1234EFGH5678", keyPrefix: "ABCD1234" }
        : { ...r, status: "saved", hint: "ABCD1234", canSubmit: false },
    )
    fireEvent.click(await screen.findByTestId("secret-request-create-key"))
    expect(await screen.findByTestId("secret-request-key")).toHaveTextContent("ABCD1234EFGH5678")
    expect(screen.getByTestId("secret-request-key-copy")).toBeInTheDocument()
    expect(screen.getByTestId("secret-request-key-once")).toBeInTheDocument()
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      { toolName: "tickets:apiKeys.create", params: { label: "Website form" } },
      { suppressGlobalError: true },
    )
  })

  it("a saved, cancelled or expired card says so and offers no form", async () => {
    mount(row({ status: "expired", canSubmit: false, canCancel: false }))
    expect(await screen.findByTestId("secret-request-expired")).toBeInTheDocument()
    expect(screen.queryByTestId("secret-request-save")).toBeNull()
  })

  describe("connect card (oauth_connect)", () => {
    function connectRow(over: Partial<SecretRequestRow> = {}): SecretRequestRow {
      return row({
        kind: "oauth_connect",
        target: { app: "mail", connection: "gmail", mode: "personal" },
        title: "mail gmail connection (personal)",
        fields: [],
        destination: [
          { name: "app", value: "mail" },
          { name: "connection", value: "gmail" },
          { name: "mode", value: "personal" },
        ],
        connect: { provider: "google" },
        ...over,
      })
    }

    beforeEach(() => {
      shellMocks.shellRunsOAuth.mockReturnValue(false)
      shellMocks.runShellOAuth.mockReset()
    })

    it("opens the consent popup in the click, before the server answers, then sends it to the provider", async () => {
      const r = connectRow()
      mount(r)
      const popup = { closed: false, close: vi.fn(), location: { href: "about:blank" } }
      const open = popupMocks.openConnectPopup.mockReturnValue(popup)
      let answer: (v: { redirectUrl: string }) => void = () => undefined
      apiMocks.post.mockImplementation(
        () => new Promise((resolve) => (answer = resolve as typeof answer)),
      )
      const button = await screen.findByTestId("secret-request-connect")
      expect(button).toHaveTextContent("Connect with Google")
      expect(screen.getByTestId("secret-request-destination-mode")).toHaveTextContent("Your own")
      fireEvent.click(button)
      // Synchronous: the popup exists before the authorize call is answered.
      expect(open).toHaveBeenCalledWith(r.id)
      expect(apiMocks.post).toHaveBeenCalledWith(
        `/secret-requests/${r.id}/authorize`,
        { display: "popup" },
        { suppressGlobalError: true },
      )
      answer({ redirectUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" })
      await waitFor(() =>
        expect(popup.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=s"),
      )
      expect(screen.getByTestId("secret-request-connecting")).toHaveAttribute("role", "status")
      open.mockReset()
    })

    it("a blocked popup runs the consent in this tab, which the server brings back", async () => {
      const r = connectRow()
      mount(r)
      const open = popupMocks.openConnectPopup.mockReturnValue(null)
      const assign = vi.fn()
      const realLocation = window.location
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...realLocation, assign },
      })
      apiMocks.post.mockResolvedValue({ redirectUrl: "https://accounts.google.com/auth?state=t" })
      fireEvent.click(await screen.findByTestId("secret-request-connect"))
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith("https://accounts.google.com/auth?state=t"),
      )
      expect(apiMocks.post).toHaveBeenCalledWith(
        `/secret-requests/${r.id}/authorize`,
        { display: "tab" },
        { suppressGlobalError: true },
      )
      Object.defineProperty(window, "location", { configurable: true, value: realLocation })
      open.mockReset()
    })

    it("Shopify asks for the store, and shows the server's refusal", async () => {
      const r = connectRow({
        target: { app: "shopify", connection: "shop", mode: "org" },
        fields: [{ name: "shop", secret: false, required: true }],
        connect: { provider: "shopify" },
      })
      mount(r)
      const popup = { closed: false, close: vi.fn(), location: { href: "about:blank" } }
      const open = popupMocks.openConnectPopup.mockReturnValue(popup)
      const button = await screen.findByTestId("secret-request-connect")
      expect(button).toHaveTextContent("Connect with Shopify")
      // Nothing typed: no popup, a line saying what is missing.
      fireEvent.click(button)
      expect(await screen.findByTestId("secret-request-missing")).toBeInTheDocument()
      expect(open).not.toHaveBeenCalled()
      fireEvent.input(input("secret-request-field-shop"), { target: { value: " acme " } })
      apiMocks.post.mockRejectedValue(new ApiError("server words", 400, "connect_invalid_value"))
      fireEvent.click(button)
      expect(apiMocks.post).toHaveBeenCalledWith(
        `/secret-requests/${r.id}/authorize`,
        { shop: "acme", display: "popup" },
        { suppressGlobalError: true },
      )
      // A known refusal is worded by the card, in the person's language.
      expect(await screen.findByTestId("secret-request-error")).toHaveTextContent(
        "That is not a store domain",
      )
      expect(popup.close).toHaveBeenCalled()
      open.mockReset()
    })

    it("an unexpected refusal shows a generic line, never the server's internals", async () => {
      const r = connectRow()
      mount(r)
      popupMocks.openConnectPopup.mockReturnValue({
        closed: false,
        close: vi.fn(),
        location: { href: "about:blank" },
      })
      apiMocks.post.mockRejectedValue(new ApiError("stack trace here", 400, "connect_failed"))
      fireEvent.click(await screen.findByTestId("secret-request-connect"))
      const line = await screen.findByTestId("secret-request-error")
      expect(line).toHaveTextContent("Could not start the connection.")
      expect(line).not.toHaveTextContent("stack trace")
      popupMocks.openConnectPopup.mockReset()
    })

    it("a consent that failed in this tab comes back as a line on the card, with Try again", async () => {
      popupMocks.takeConnectReturn.mockReturnValueOnce("access_denied")
      const r = connectRow()
      mount(r)
      expect(await screen.findByTestId("secret-request-error")).toHaveTextContent(
        "Access was not allowed at the provider.",
      )
      expect(screen.getByTestId("secret-request-connect")).toHaveTextContent("Try again")
      expect(popupMocks.takeConnectReturn).toHaveBeenCalledWith(r.id)
    })

    it("walk N42: a consent refused in the popup shows its reason on the card, from the server's frame", async () => {
      const r = connectRow()
      mount(r)
      await screen.findByTestId("secret-request-connect")
      expect(screen.queryByTestId("secret-request-error")).toBeNull()
      // The callback refused it (another owner holds the account): the row stays
      // pending, and the `secret_request` frame carries only the reason code.
      secretRequestStore.handleEvent(apiMocks as never, {
        id: r.id,
        status: "pending",
        failure: "connection_held_by_other_owner",
      })
      expect(await screen.findByTestId("secret-request-error")).toHaveTextContent(
        "This account is already connected for the organization or another member.",
      )
      expect(screen.getByTestId("secret-request-connect")).toHaveTextContent("Try again")
      // A frame with an unknown code is worded as the generic failure, never echoed.
      secretRequestStore.clearFailure(r.id)
      secretRequestStore.handleEvent(apiMocks as never, { id: r.id, failure: "<b>x</b>" })
      await waitFor(() =>
        expect(screen.getByTestId("secret-request-error")).not.toHaveTextContent("<b>x</b>"),
      )
    })

    it("a desktop or mobile app runs its own flow, redeeming through the handoff", async () => {
      shellMocks.shellRunsOAuth.mockReturnValue(true)
      shellMocks.runShellOAuth.mockResolvedValue({ kind: "connected", result: {} })
      const r = connectRow()
      mount(r)
      const open = popupMocks.openConnectPopup
      fireEvent.click(await screen.findByTestId("secret-request-connect"))
      await waitFor(() => expect(shellMocks.runShellOAuth).toHaveBeenCalled())
      expect(open).not.toHaveBeenCalled()
      const flow = shellMocks.runShellOAuth.mock.calls[0][0] as {
        redeem: (b: { code: string; code_verifier: string }) => Promise<unknown>
      }
      await flow.redeem({ code: "c", code_verifier: "v" })
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/connections/oauth-handoff",
        { code: "c", code_verifier: "v" },
        { suppressGlobalError: true },
      )
      open.mockReset()
    })

    it("another member sees whose it is, read-only; a connected card names the account", async () => {
      mount(connectRow({ canSubmit: false, canCancel: false }))
      expect(await screen.findByTestId("secret-request-waiting")).toHaveTextContent(
        "Waiting for Dana to connect it.",
      )
      expect(screen.queryByTestId("secret-request-connect")).toBeNull()
      mount(connectRow({ status: "saved", hint: "dana@example.com", canSubmit: false }))
      expect(await screen.findByTestId("secret-request-connected")).toHaveTextContent(
        "Connected (dana@example.com).",
      )
    })

    it("a Google client card renders the shared Google guide with the values to copy", async () => {
      mount(
        row({
          kind: "google_integration_client",
          target: {},
          fields: [
            { name: "clientId", secret: false, required: true },
            { name: "clientSecret", secret: true, required: true },
          ],
          destination: [],
          guide: {
            provider: "google",
            values: {
              baseUrl: "https://liaison.example",
              connectionsRedirectUri: "https://liaison.example/api/connections/callback",
              signIn: {
                enabled: false,
                redirectUri: "https://liaison.example/api/auth/oauth/callback",
              },
              redirectUris: ["https://liaison.example/api/connections/callback"],
              scopes: ["https://www.googleapis.com/auth/gmail.modify"],
              apis: [{ id: "gmail.googleapis.com", name: "Gmail API" }],
              unmappedScopes: [],
              connections: [],
              gmailPush: {
                publisher: "gmail-api-push@system.gserviceaccount.com",
                endpoint: null,
                instanceTopic: false,
              },
              instanceClientOnly: false,
              clientReady: false,
              verifyApis: false,
              clients: {
                workspace: { source: "none", restrictedVerified: false },
                drive: { source: "none", restrictedVerified: false },
              },
            },
          },
        }),
      )
      expect(await screen.findByTestId("secret-request-guide")).toBeInTheDocument()
      expect(screen.getByTestId("secret-request-guide-step-client")).toHaveTextContent(
        "https://liaison.example/api/connections/callback",
      )
      expect(screen.getByTestId("secret-request-guide-step-apis")).toHaveTextContent("Gmail API")
      // No push step without the Mail app.
      expect(screen.queryByTestId("secret-request-guide-step-push")).toBeNull()
    })

    it("an app's own client steps show as a numbered list", async () => {
      mount(
        row({
          kind: "oauth_client",
          target: { app: "example", connection: "api" },
          fields: [
            { name: "clientId", secret: false, required: true },
            { name: "clientSecret", secret: true, required: true },
          ],
          guide: {
            provider: "app",
            summary: "Create an OAuth app.",
            steps: ["Open it.", "Copy it."],
          },
        }),
      )
      expect(await screen.findByTestId("secret-request-guide")).toHaveTextContent(
        "Create an OAuth app.",
      )
      expect(screen.getByTestId("secret-request-guide-step-step-1")).toHaveTextContent("Copy it.")
    })
  })
})

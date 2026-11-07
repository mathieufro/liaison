// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `connect <app>/<connection>`: interactive OAuth helper.
 *
 * Browser-required connections (mail/gmail, tickets/gmail, social/google,
 * social/meta, shopify/shop) cannot be provisioned headlessly: a human must
 * consent at the provider. This helper does everything around that consent so
 * an operator only has to click a link:
 *
 *  1. Parse `ref` by the FIRST `/` into `[app, connection]`. Missing or no slash
 *     prints usage and exits 2.
 *  2. Resolve the org (config `org.slug`, else the single-org default).
 *  3. `ensureAppsForOrg(orgId)` to warm `connectionConfigRegistry`; without it
 *     `startOAuthFlow` throws "not declared in manifest".
 *  4. For Google connections, save the per-org OAuth client when the config
 *     supplies one (`mail.mailboxes[].google` for mail/gmail,
 *     `tickets.inboxes[].google` for tickets/gmail).
 *  4b. Print the connection's guide first, from the same code as the agent and
 *     `liaison guide` (modules/connection-guides/plan.ts): the Trusted steps for
 *     a Google Workspace address on a client Google has not verified, the
 *     create-your-own-client steps when there is no client, the Shopify Dev
 *     Dashboard steps when the store has no app. A personal Gmail address on
 *     such a client is refused (Google refuses it too): it connects over IMAP.
 *  5. Snapshot the active connections for `(app, connection)`, then
 *     `startOAuthFlow` and print the authorize URL to STDERR (never stdout).
 *  6. Poll until a NEW active connection appears (bounded; timeout exits 1). A
 *     pre-existing connection never satisfies the wait, so connecting a second
 *     account does not return before the consent lands.
 *  7. The two mail products stay separate:
 *     - `mail/gmail` connects a Mail app mailbox and nothing else. It never
 *       creates a ticket inbox.
 *     - `tickets/gmail` connects a ticket inbox. The server's tickets app creates
 *       the inbox for the authorized address; once it appears, the settings of
 *       the matching `tickets.inboxes[]` entry (name, fromDisplayName,
 *       defaultTeam, notifyNewTicket, default) are applied.
 *
 * `--token-env <VAR>` is the one non-interactive form: a provider that issues
 * an access token without a consent screen (a Shopify custom app's Admin API
 * token) is connected from that token, read from the named environment
 * variable only (never argv, never logged), through the OAuth callback's own
 * storage (`connectWithAccessToken`): encrypted token, replaced row, mirrored
 * client secret (`--client-secret-env`), `connected_account:create` event.
 *
 * Container-friendly: the redirect targets the SERVER's public
 * `/api/connections/callback`, so the CLI needs no inbound port.
 */
import { MAILBOX_MODE_CHOICE, resolveLocale } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { interpolateEnv, parseConfigFile } from "~/cli/config/parse"
import { type ProvisioningConfig, validateConfig } from "~/cli/config/schema"
import { renderConnectionSetup, renderGuideText } from "~/cli/guide"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import {
  convergeTicketInbox,
  readTicketInbox,
  type TicketInboxRow,
} from "~/cli/provisioners/ticket-inboxes"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  ConnectLinkError,
  type ConnectLinkRefusal,
  emailConnectLink,
  mintConnectLink,
  readConnectLinkRefusal,
  readConnectLinkStatus,
} from "~/modules/apps/connections/connect-links"
import { connectWithAccessToken, startOAuthFlow } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type { MxResolver } from "~/modules/connection-guides/account-type"
import {
  appConnectionSetup,
  googleConnectPlan,
  resolveGoogleSetupValues,
  shopifyDashboardPlan,
  translator,
} from "~/modules/connection-guides/plan"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"

const log = rootLogger.child({ module: "cli-connect" })

/** Connections that authenticate through the per-org Google OAuth client. */
const GOOGLE_CONNECTIONS = new Set(["mail/gmail", "tickets/gmail", "social/google"])

/** One line each, printed with the usage string. */
export const CONNECT_USAGE =
  "usage: liaison connect <app>/<connection> [--config <path>] [--org <slug|id>] [--email <address>] [--for <member email> [--send]]\n" +
  "       liaison connect <app>/<connection> --token-env <VAR> [--account <id>] [--client-secret-env <VAR>] [--scopes <a,b>] [--org <slug|id>]\n" +
  "  --token-env <VAR>  connect from a static access token held in that environment variable (no browser)\n" +
  "  --for <email>  a one-time link for that member to connect their OWN account (personal)\n" +
  "  mail/gmail     connect a Mail app mailbox (read and send in Mail; creates no ticket inbox)\n" +
  "  tickets/gmail  connect a ticket inbox (its mail becomes tickets)"

export interface RunConnectArgs {
  /** `<app>/<connection>` — split on the FIRST slash. */
  ref: string
  /** Optional config path supplying org, Google client, templateVars, inbox settings. */
  configPath?: string
  /** The Gmail address being connected; required when the config lists several. */
  email?: string
  /**
   * Connect for this member, as THEIR personal connection: prints a one-time
   * link only they can use once signed in (connect-links.ts), then waits for a
   * connection they own.
   */
  forEmail?: string
  /** With `forEmail`: also email them the link. */
  send?: boolean
  /** The org (slug or id); else the config's `org.slug`, else the single org. */
  org?: string
  /**
   * Connect from a static access token held in this environment variable (no
   * browser). The token is read from the environment only, never argv.
   */
  tokenEnv?: string
  /** With `tokenEnv`: the account (the shop domain for Shopify). */
  account?: string
  /** With `tokenEnv`: the environment variable holding the app's client secret. */
  clientSecretEnv?: string
  /** With `tokenEnv`: the scopes the token holds, comma-separated. */
  scopes?: string
}

export interface RunConnectResult {
  exitCode: number
}

/**
 * Injectable seams so the helper is unit-testable without a live OAuth provider
 * or outbox worker. A constructor seam — NOT a cast. The production helper wires
 * the real `startOAuthFlow`, `ensureAppsForOrg`, `saveGoogleIntegrationConfig`,
 * and a 1s/300s bounded poll; tests inject a fast clock + stubs that simulate the
 * connection landing (or never landing → timeout).
 */
export interface ConnectDeps {
  ensureAppsForOrg: (orgId: string) => Promise<void>
  saveGoogleIntegrationConfig: (
    orgId: string,
    config: { clientId: string; clientSecret: string },
  ) => Promise<void>
  startOAuthFlow: (
    orgId: string,
    userId: string,
    appName: string,
    connectionName: string,
    opts?: { ownerType?: "user" | "org"; ownerId?: string | null; shop?: string },
  ) => Promise<string>
  /** Where the authorize URL + progress goes — defaults to stderr. */
  log: (msg: string) => void
  /** Poll cadence for the connection and ticket inbox reads. */
  pollIntervalMs: number
  /** Bounded total wait before reporting a timeout. */
  pollTimeoutMs: number
  sleep: (ms: number) => Promise<void>
  /** `--for`: how long to wait for the member (default: the link's life + the OAuth state's). */
  linkPollTimeoutMs?: number
  /** Mints the one-time link of `--for`; default connect-links.ts. */
  mintConnectLink?: typeof mintConnectLink
  /** Emails it (`--send`); default connect-links.ts. */
  emailConnectLink?: typeof emailConnectLink
  /** Why the link's connect was refused, once the callback refused it; default connect-links.ts. */
  readConnectLinkRefusal?: typeof readConnectLinkRefusal
  /** Whether the link is still open, redeemed or expired (server side); default connect-links.ts. */
  readConnectLinkStatus?: typeof readConnectLinkStatus
  /** Stores a static access token as the connection; default service.ts. */
  connectWithAccessToken?: typeof connectWithAccessToken
  /** Reads an environment variable (`--token-env`); default process.env. */
  readEnv?: (name: string) => string | undefined
  /** The guide printed before the flow (tests inject one); default: connectGuide. */
  guide?: (orgId: string, refKey: string, email: string | undefined) => Promise<ConnectGuide>
}

/** What connect prints before the flow, and whether it refuses to start it. */
export interface ConnectGuide {
  lines: string[]
  /** Refused before any flow starts (a personal Gmail on an unverified client). */
  refuse: boolean
  /** Printed with the authorize URL: what a provider's admin-policy block means. */
  failureHint?: string
}

/** Why a `--for` wait ended without a connection, before its deadline. */
type LinkWaitStop = { refused: ConnectLinkRefusal } | { expired: true }

/** The Google connections whose path depends on the address (Gmail). */
const GMAIL_REFS = new Set(["mail/gmail", "tickets/gmail"])

async function orgLocale(orgId: string) {
  const row = await withPrivilegedDb(orgId, "cli-connect-locale", async (tx) =>
    extractRows<{ default_locale: string }>(
      await tx.execute(
        drizzleSql`SELECT default_locale FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid`,
      ),
    ),
  )
  return resolveLocale(row[0]?.default_locale)
}

/** The guide of a Gmail or Shopify connect, from the same code as the agent's. */
export async function connectGuide(
  orgId: string,
  refKey: string,
  email: string | undefined,
  /** Tests inject the MX lookup. */
  resolver?: MxResolver,
): Promise<ConnectGuide> {
  const t = translator(await orgLocale(orgId))
  if (GMAIL_REFS.has(refKey)) {
    const plan = await googleConnectPlan(
      await resolveGoogleSetupValues(orgId),
      t,
      { email },
      { resolver },
    )
    if (plan.path === "consumer_imap") {
      return {
        refuse: true,
        lines: [
          plan.statement ?? "",
          "",
          `connect: '${email}' is not connected with Google here. Set provider: imap for it in the config (mail.mailboxes or tickets.inboxes) and run config apply; its servers and app-password steps: liaison guide imap --email ${email}`,
        ],
      }
    }
    const lines =
      plan.path === "trusted" || plan.path === "own_client"
        ? [`path: ${plan.path}`, "", ...(plan.guide ? renderGuideText(plan.guide) : [])]
        : []
    return {
      refuse: false,
      lines,
      failureHint: t("kernel.auth.connectFailedReason.admin_policy_blocked"),
    }
  }
  if (refKey === "shopify/shop") {
    const plan = await shopifyDashboardPlan(orgId, t, "agent")
    if ("error" in plan || plan.values.clientSource !== "none") return { refuse: false, lines: [] }
    return { refuse: false, lines: renderGuideText(plan.guide) }
  }
  // Any other connection: the steps its client card shows (connection-setup.ts).
  const [app = "", connection = ""] = refKey.split("/", 2)
  const setup = await appConnectionSetup(orgId, app, connection)
  if (!setup) return { refuse: false, lines: [] }
  if (setup.family === "google") {
    return {
      refuse: false,
      lines: [
        "Its Google client, redirect URI, scopes and APIs: liaison guide google (the same client as Gmail unless the guide lists it as a separate client).",
        "",
      ],
      failureHint: t("kernel.auth.connectFailedReason.admin_policy_blocked"),
    }
  }
  if (setup.type === "credentials") {
    return {
      refuse: true,
      lines: [
        ...renderConnectionSetup(setup),
        "",
        `connect: ${refKey} takes credentials, not a browser sign-in: give them in the config (apps[].connection.credentials) and run liaison config apply.`,
      ],
    }
  }
  return { refuse: false, lines: [...renderConnectionSetup(setup), ""] }
}

const defaultDeps: ConnectDeps = {
  ensureAppsForOrg,
  saveGoogleIntegrationConfig,
  startOAuthFlow,
  log: (msg) => process.stderr.write(`${msg}\n`),
  // OAuth state TTL window is generous; a human opening a browser + consenting
  // typically lands in well under a minute, but allow a comfortable bound.
  pollIntervalMs: 1_000,
  pollTimeoutMs: 300_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Split a `<app>/<connection>` ref on the FIRST slash. Returns null if there is
 * no slash, or either side is empty.
 */
function parseRef(ref: string): { app: string; connection: string } | null {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash >= ref.length - 1) return null
  return { app: ref.slice(0, slash), connection: ref.slice(slash + 1) }
}

/**
 * Load + validate the optional config file (org, Google client, templateVars,
 * inbox settings). A config that was passed but is unusable is an error, never
 * silently ignored: it would otherwise skip the org and inbox settings.
 */
function loadConfig(
  configPath: string | undefined,
): { ok: true; config: ProvisioningConfig | null } | { ok: false; message: string } {
  if (!configPath) return { ok: true, config: null }
  const parsed = parseConfigFile(configPath)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  // Interpolate ${ENV} refs before validation, exactly like `config apply`, else
  // a value like `identifier: ${SHOPIFY_STORE_DOMAIN}` reaches startOAuthFlow as
  // the literal string and fails template-var validation.
  let interpolated: unknown
  try {
    interpolated = interpolateEnv(parsed.raw)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  const validated = validateConfig(interpolated)
  return validated.ok
    ? { ok: true, config: validated.config }
    : { ok: false, message: validated.message }
}

/** The config's Google OAuth client for a Google connection ref, if any. */
function googleClientFor(
  refKey: string,
  config: ProvisioningConfig,
): { clientId: string; clientSecret: string } | undefined {
  const fromMail = config.mail?.mailboxes?.find((m) => m.provider === "gmail" && m.google)?.google
  const fromTickets = config.tickets?.inboxes?.find(
    (i) => i.provider === "gmail" && i.google,
  )?.google
  if (refKey === "mail/gmail") return fromMail
  if (refKey === "tickets/gmail") return fromTickets
  return fromMail ?? fromTickets
}

/** Resolve the first active admin/owner user id for the org (the OAuth actor). */
async function resolveActorUserId(orgId: string): Promise<string | null> {
  return withPrivilegedDb(orgId, "cli-connect-resolve-actor", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("users")}
        WHERE org_id = ${orgId}::uuid AND status = 'active'
        ORDER BY created_at ASC LIMIT 1
      `),
    )
    return rows[0]?.id ?? null
  })
}

export function createConnect(deps: ConnectDeps = defaultDeps) {
  /** Ids of the currently active connections for `(org, app, connection)`. */
  async function activeConnectionIds(
    orgId: string,
    app: string,
    connection: string,
  ): Promise<Set<string>> {
    const rows = await withPrivilegedDb(orgId, "cli-connect-snapshot", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = ${app} AND connection_name = ${connection}
          AND status = 'active'
      `),
    )
    return new Set(extractRows<{ id: string }>(rows).map((r) => r.id))
  }

  /** Bounded poll for an active connection that was not in `before`. */
  async function pollForNewConnection(
    orgId: string,
    app: string,
    connection: string,
    before: Set<string>,
    /** Only a personal connection this member owns satisfies the wait. */
    ownerId?: string,
    timeoutMs: number = deps.pollTimeoutMs,
    /**
     * Ends the wait early: the connect was refused (a link's callback said
     * why), or the link expired without being used.
     */
    stopped?: () => Promise<LinkWaitStop | null>,
  ): Promise<{ id: string; identifier: string } | LinkWaitStop | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rows = await withPrivilegedDb(orgId, "cli-connect-poll-account", (tx) =>
        tx.execute(drizzleSql`
          SELECT id, identifier FROM ${kernelRel("connected_accounts")}
          WHERE org_id = ${orgId}::uuid AND app_name = ${app} AND connection_name = ${connection}
            AND status = 'active'
            AND (${ownerId ?? null}::uuid IS NULL
                 OR (owner_type = 'user' AND owner_id = ${ownerId ?? null}::uuid))
          ORDER BY created_at DESC
        `),
      )
      const fresh = extractRows<{ id: string; identifier: string }>(rows).find(
        (r) => !before.has(r.id),
      )
      if (fresh) return fresh
      const stop = stopped ? await stopped() : null
      if (stop) return stop
      if (Date.now() >= deadline) return null
      await deps.sleep(deps.pollIntervalMs)
    }
  }

  /** Bounded poll for the ticket inbox the server binds to a tickets connection. */
  async function pollForTicketInbox(
    orgId: string,
    address: string,
    connectedAccountId: string,
  ): Promise<TicketInboxRow | null> {
    const deadline = Date.now() + deps.pollTimeoutMs
    for (;;) {
      const row = await readTicketInbox(
        (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        orgId,
        address,
      )
      if (row && row.connected_account_id === connectedAccountId) return row
      if (Date.now() >= deadline) return null
      await deps.sleep(deps.pollIntervalMs)
    }
  }

  /**
   * `--token-env <VAR>`: connect from a static access token, no browser. The
   * token and the client secret come from the environment only and are never
   * printed.
   */
  async function connectWithToken(
    orgId: string,
    userId: string,
    app: string,
    connection: string,
    args: RunConnectArgs,
  ): Promise<RunConnectResult> {
    const refKey = `${app}/${connection}`
    const readEnv = deps.readEnv ?? ((name: string) => process.env[name])
    const token = readEnv(args.tokenEnv ?? "")?.trim()
    if (!token) {
      deps.log(`connect: the environment variable ${args.tokenEnv} is empty or unset`)
      return { exitCode: 2 }
    }
    let clientSecret: string | undefined
    if (args.clientSecretEnv !== undefined) {
      clientSecret = readEnv(args.clientSecretEnv)?.trim()
      if (!clientSecret) {
        deps.log(`connect: the environment variable ${args.clientSecretEnv} is empty or unset`)
        return { exitCode: 2 }
      }
    }
    await deps.ensureAppsForOrg(orgId)
    const declared = connectionConfigRegistry.get([orgId, app, connection])
    if (!declared) {
      deps.log(`connect: ${refKey} is not declared by an app installed for this org`)
      return { exitCode: 2 }
    }
    if (declared.type !== "oauth2") {
      deps.log(
        `connect: ${refKey} is not an OAuth connection; --token-env is for OAuth connections only ` +
          "(credentials go in the config, apps[].connection.credentials, and config apply)",
      )
      return { exitCode: 2 }
    }
    if (declared.identifierVar && !args.account) {
      deps.log(`connect: ${refKey} needs --account <${declared.identifierVar}>`)
      return { exitCode: 2 }
    }
    const grantedScopes = args.scopes
      ?.split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    let connected: { accountId: string; identifier: string }
    try {
      connected = await (deps.connectWithAccessToken ?? connectWithAccessToken)({
        orgId,
        userId,
        appName: app,
        connectionName: connection,
        accessToken: token,
        ...(args.account !== undefined ? { account: args.account } : {}),
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        ...(grantedScopes !== undefined ? { grantedScopes } : {}),
      })
    } catch (err) {
      // The service's messages name the connection, never the token.
      deps.log(`connect: ${err instanceof Error ? err.message : String(err)}`)
      return { exitCode: 1 }
    }
    deps.log(`${refKey} connected (${connected.identifier}) from a static access token.`)
    if (declared.clientSecretConfigKey && clientSecret === undefined) {
      deps.log(
        `connect: no --client-secret-env given: ${refKey}'s webhook signatures are checked with ` +
          "the client secret saved before, if any; pass the app's client secret to set it",
      )
    }
    return { exitCode: 0 }
  }

  /**
   * `--for <email>`: a one-time link for that member to connect their own
   * account. The operator never consents for them: the link works only once
   * they are signed in as themselves, and the connection is theirs.
   */
  async function connectFor(
    orgId: string,
    app: string,
    connection: string,
    forEmail: string,
    send: boolean,
    configPath: string | undefined,
  ): Promise<RunConnectResult> {
    const refKey = `${app}/${connection}`
    await deps.ensureAppsForOrg(orgId)
    let link: Awaited<ReturnType<typeof mintConnectLink>>
    try {
      link = await (deps.mintConnectLink ?? mintConnectLink)({
        orgId,
        email: forEmail,
        appName: app,
        connectionName: connection,
        minter: { kind: "cli" },
      })
    } catch (err) {
      deps.log(`connect: ${err instanceof Error ? err.message : String(err)}`)
      return { exitCode: err instanceof ConnectLinkError ? 2 : 1 }
    }
    const before = await activeConnectionIds(orgId, app, connection)
    const minutes = Math.round((link.expiresAt.getTime() - Date.now()) / 60_000)
    deps.log("")
    deps.log(`Send this link to ${link.user.email} to connect their own ${refKey} (personal):`)
    deps.log("")
    deps.log(`  ${link.url}`)
    deps.log("")
    deps.log(
      `It works once, for ${minutes} minutes, and only when ${link.user.email} is signed in to Liaison as themselves ` +
        "(anyone else is asked to sign in as them). It never signs anyone in. " +
        (app === "mail"
          ? "They choose a standard or private mailbox on that page; a private one asks for its mailbox password in the same browser. " +
            `${MAILBOX_MODE_CHOICE.standard} ${MAILBOX_MODE_CHOICE.private}`
          : ""),
    )
    if (send) {
      try {
        await (deps.emailConnectLink ?? emailConnectLink)({
          orgId,
          link,
          appName: app,
          connectionName: connection,
          senderName: null,
        })
        deps.log(`Emailed the link to ${link.user.email}.`)
      } catch (err) {
        deps.log(
          `connect: emailing the link failed (${err instanceof Error ? err.message : String(err)}); send it yourself`,
        )
      }
    }
    deps.log(`Waiting for ${link.user.email} to connect…`)
    // A person may take the link's whole life to open it, then the consent.
    const linkWait = link.expiresAt.getTime() - Date.now() + 15 * 60_000
    const connected = await pollForNewConnection(
      orgId,
      app,
      connection,
      before,
      link.user.id,
      deps.linkPollTimeoutMs ?? linkWait,
      async () => {
        const refusal = await (deps.readConnectLinkRefusal ?? readConnectLinkRefusal)(link.token)
        if (refusal) return { refused: refusal }
        // The server's record of the link, not a local clock: once it is gone
        // unused, nobody can connect through it any more.
        const state = await (deps.readConnectLinkStatus ?? readConnectLinkStatus)(link.token)
        return state.status === "expired" ? { expired: true } : null
      },
    )
    if (connected && "expired" in connected) {
      deps.log(
        `connect: the link for ${link.user.email} expired before it was used (it was valid until ${link.expiresAt.toISOString()}). Nothing was connected.`,
      )
      deps.log(
        `For a new link, run: liaison connect ${refKey}${configPath ? ` --config ${configPath}` : ""} --for ${link.user.email}${send ? " --send" : ""}`,
      )
      return { exitCode: 1 }
    }
    if (connected && "refused" in connected) {
      // The member followed the link and the server refused the connect: stop
      // now with the reason (the link is used up), never wait until it expires.
      deps.log(
        `connect: ${link.user.email}'s connect was refused (${connected.refused.reason}): ${connected.refused.message}`,
      )
      deps.log("Nothing was connected. Fix the cause, then run this again for a new link.")
      return { exitCode: 1 }
    }
    if (!connected) {
      deps.log(
        `connect: timed out waiting for ${link.user.email} to finish connecting; if nothing was connected, run this again for a new link`,
      )
      return { exitCode: 1 }
    }
    deps.log(`${refKey} connected for ${link.user.email} (${connected.identifier}), personal.`)
    return { exitCode: 0 }
  }

  return async function runConnect(args: RunConnectArgs): Promise<RunConnectResult> {
    const parsedRef = parseRef(args.ref)
    if (!parsedRef) {
      deps.log(CONNECT_USAGE)
      return { exitCode: 2 }
    }
    const { app, connection } = parsedRef
    const refKey = `${app}/${connection}`

    const loaded = loadConfig(args.configPath)
    if (!loaded.ok) {
      deps.log(`connect: ${loaded.message}`)
      return { exitCode: 2 }
    }
    const config = loaded.config

    const resolved = await resolveOrgId(
      args.org ?? config?.org.slug,
      "multiple orgs exist — pass --org <slug>, or a --config with org.slug, to disambiguate",
    )
    if (!resolved.ok) {
      deps.log(`connect: ${resolved.message}`)
      return { exitCode: 2 }
    }
    const orgId = resolved.orgId

    if (args.forEmail !== undefined) {
      return connectFor(orgId, app, connection, args.forEmail, args.send === true, args.configPath)
    }

    const userId = await resolveActorUserId(orgId)
    if (!userId) {
      deps.log(`connect: org ${orgId} has no active user to act as the OAuth initiator`)
      return { exitCode: 2 }
    }

    if (args.tokenEnv !== undefined) {
      return connectWithToken(orgId, userId, app, connection, args)
    }

    // Warm the registry so startOAuthFlow can resolve the manifest connection.
    await deps.ensureAppsForOrg(orgId)

    // Save a per-org Google OAuth client when the config supplies one for this
    // connection (the deployment env client is the fallback otherwise).
    if (GOOGLE_CONNECTIONS.has(refKey) && config) {
      const google = googleClientFor(refKey, config)
      if (google) {
        await deps.saveGoogleIntegrationConfig(orgId, google)
        deps.log(`saved per-org Google OAuth client for ${refKey}`)
      }
    }

    // The guide, before anything starts: the same steps the agent gives.
    // The address decides the path, so never guess between several.
    const declared =
      refKey === "mail/gmail"
        ? (config?.mail?.mailboxes ?? [])
            .filter((m) => m.provider === "gmail")
            .map((m) => m.address)
        : refKey === "tickets/gmail"
          ? (config?.tickets?.inboxes ?? [])
              .filter((i) => i.provider === "gmail")
              .map((i) => i.address)
          : []
    if (!args.email && declared.length > 1) {
      deps.log(
        `connect: the config lists ${declared.length} Gmail addresses for ${refKey} (${declared.join(", ")}); ` +
          "pass --email <address> to say which one to connect",
      )
      return { exitCode: 2 }
    }
    const email = args.email ?? declared[0]
    const guide = await (deps.guide ?? connectGuide)(orgId, refKey, email)
    for (const line of guide.lines) deps.log(line)
    if (guide.refuse) return { exitCode: 2 }

    // Collect templateVars generically. The connections service currently models
    // `shop` (Shopify per-store domain) explicitly; source it from the config's
    // shopify connection identifier when present.
    const shop = config?.apps?.find((a) => a.name === app && a.connection?.name === connection)
      ?.connection?.identifier

    const before = await activeConnectionIds(orgId, app, connection)

    let authorizeUrl: string
    try {
      authorizeUrl = await deps.startOAuthFlow(orgId, userId, app, connection, {
        ownerType: "org",
        ...(shop !== undefined ? { shop } : {}),
      })
    } catch (err) {
      deps.log(`connect: ${err instanceof Error ? err.message : String(err)}`)
      if (shop === undefined && err instanceof Error && err.message.includes('"shop" value')) {
        deps.log(
          `connect: put the store domain in the config, apps[name=${app}].connection.identifier ` +
            '(e.g. identifier: "acme.myshopify.com"), and pass --config <path>',
        )
      }
      return { exitCode: 1 }
    }

    // Print the authorize URL to STDERR with instructions — NEVER stdout, NEVER a
    // token. The operator opens it in a browser; the live server's callback stores
    // the encrypted token + emits connected_account:create.
    deps.log("")
    deps.log(`Open this URL in a browser to authorize ${refKey}:`)
    deps.log("")
    deps.log(`  ${authorizeUrl}`)
    deps.log("")
    if (guide.failureHint)
      deps.log(`If Google refuses with admin_policy_enforced: ${guide.failureHint}`)
    deps.log("Waiting for the connection to complete (the server handles the callback)…")

    const connected = await pollForNewConnection(orgId, app, connection, before)
    // No refusal or expiry check here: an operator's own flow is not a link's.
    if (!connected || !("identifier" in connected)) {
      deps.log(
        `connect: timed out waiting for ${refKey} to connect — ` +
          "re-run once you have completed the browser authorization",
      )
      return { exitCode: 1 }
    }
    deps.log(`${refKey} connected (${connected.identifier}).`)

    if (refKey === "mail/gmail") {
      deps.log(
        `'${connected.identifier}' is a Mail app mailbox. It creates no ticket inbox; ` +
          "for a support inbox use 'liaison connect tickets/gmail'.",
      )
    }

    if (refKey === "tickets/gmail") {
      const entry = config?.tickets?.inboxes?.find(
        (i) =>
          i.provider === "gmail" && i.address.toLowerCase() === connected.identifier.toLowerCase(),
      )
      if (config?.tickets?.inboxes?.length && !entry) {
        deps.log(
          `connect: '${connected.identifier}' is not declared in tickets.inboxes; ` +
            "its inbox keeps the default settings",
        )
      }
      const row = await pollForTicketInbox(orgId, connected.identifier, connected.id)
      if (!row) {
        deps.log(
          `connect: the server has not created the ticket inbox for '${connected.identifier}' yet; ` +
            "re-run config apply to apply its settings",
        )
        return { exitCode: 0 }
      }
      deps.log(`ticket inbox for '${connected.identifier}' is ready`)
      if (entry) {
        try {
          const fields = await convergeTicketInbox(
            (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            orgId,
            userId,
            row,
            entry,
          )
          if (fields.length > 0) deps.log(`ticket inbox settings applied: ${fields.join(", ")}`)
        } catch (err) {
          log.error({ err, address: connected.identifier }, "connect inbox settings failed")
          deps.log(
            `connect: applying inbox settings failed: ${err instanceof Error ? err.message : String(err)}`,
          )
          return { exitCode: 1 }
        }
      }
    }

    return { exitCode: 0 }
  }
}

/** Production connect helper (real services, 1s/300s bounded poll). */
const productionConnect = createConnect()

export function runConnect(args: RunConnectArgs): Promise<RunConnectResult> {
  return productionConnect(args)
}

# Connecting apps — the shared machinery

Most Liaison apps do their work against an external system (a Google Drive, a
Shopify store, a GitLab instance) or an inbound credential (an SMTP mailbox, an
API key). The kernel owns a single **connections** subsystem that every app
reuses; an app only *declares* what it needs in its manifest and reads the
resolved token at tool time. This document describes that shared machinery once.
Each app's own `README.md` has a **Connecting** section that specialises it —
which connection(s) it declares, where the credentials come from, and the
failure modes specific to that provider. Read this doc first, then the app's.

Everything below is verified against the code in
`apps/api/src/modules/apps/connections/` (service, routes, oauth-client
resolution) — not aspirational.

---

## 1. Two connection types

An app declares its connections in its manifest under `connections.<name>`:

```jsonc
"connections": {
  "drive": {
    "type": "oauth2",              // "oauth2" | "credentials"
    "scopes": ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
    "allowedDomains": ["googleapis.com", "accounts.google.com"],
    "setupGuide": { "summary": "…", "steps": [{ "who": "human", "text": "…", "url": "https://…" }] }
  }
}
```

| Field | Meaning |
|-------|---------|
| `type` | `credentials` or `oauth2` (see below). |
| `scopes` | OAuth scopes requested at authorize time (oauth2 only). |
| `optionalScopes` | Scopes the app may ask for later, never in the base grant (Shopify's Plus-only `read_users`). They are never written to a generated provider app configuration: Shopify-managed installation refuses `read_users` among its optional scopes. |
| `protectedScopes` | Scopes the provider grants only after approving the app (Shopify's `read_all_orders`), as `[{ "scope", "setting" }]`. They stay out of `scopes`, and the generated `shopify.app.toml` lists one only once the org turned `setting` on. The authorize request asks for one when the org turned on `setting` (a toggle in the app's org settings), or when the account being reconnected already holds it, so a reconnect never drops it. A connection whose grant lacks it is flagged in Attention, which says to request it from the provider, turn the setting on and reconnect. |
| `scopesFromAppConfiguration` | `true` when the provider grants the scopes of the provider app's released configuration, whatever the authorize request asks for (Shopify-managed installation). A grant missing a scope is flagged in Attention with the fix in that order: add the scope to the app's configuration, release it, then reconnect. |
| `identifierVar` | The template variable (or credential field) whose value is an account's identifier, such as Shopify's `shop`. The connections listing carries it, so **Reconnect** on a per-store account starts the sign-in on that account's store (`example.myshopify.com`) without asking for it again. |
| `apiVersion` | The provider API version the app pins (Shopify's Admin API `YYYY-MM`). The generated `shopify.app.toml` carries it as its webhook API version. |
| `callbackSignature` | How the provider signs its OAuth callback. `hmac-sha256-query` (Shopify): Liaison checks the callback's `hmac` with the client secret before it exchanges the code, and refuses a callback that names another store than the one the connect started for. The stored account is always the store the connect started for. |
| `allowedDomains` | Egress allowlist — the sandbox/host outbound-fetch guard rejects calls to any other host. |
| `credentialFields` | For `credentials` type: the fields the Settings form renders (`name`, `label`, `type`, `required`, `readable`). `readable: true` lets an edit form read the stored value back; leave it off for anything secret. `refusePattern` (`pattern`, `code`, `message`, optional `messageKey`) refuses the wrong kind of secret before anything is stored: a matching value answers 422 with `code` and the message, never the value. |
| `checkBeforeStore` | For `credentials` type: the name of a read-only tool of the app that checks a new key before it is stored. The tool runs with the new key in place of the stored one; when it refuses, the save answers 422 with the tool's code and message and the stored key stays. |
| `setupGuide` | `{ summary, steps, docsUrl }`: the provider-side steps, shown in the Settings connect dialog, printed by `liaison guide <app>/<connection>` and listed in the [setup reference](reference/setup.md). A step is `{ "who": "human" \| "agent", "text", "url"?, "place"?, "minutes"?, "values"? }`: `who` says who does it, `url` is the direct page a HUMAN step happens on, `place` (`liaison` for a card or form in Liaison, `own` for the person's own system) replaces `url` for a HUMAN step with no provider page, `values` are the exact strings to copy. A plain string still reads as a HUMAN step. Every shipped HUMAN step has a `url` or a `place` (a guard test checks). |

### `credentials`

The operator enters field values (API key, host, username/password, token) in
**Settings → the app → Connect**. The form is generated from
`credentialFields`. Values are validated against the manifest and stored
**encrypted** (`ENCRYPTION_KEY`, `CryptoContext.connectedAccountAccessToken`).

- Route: `POST /api/connections/:appName/:connectionName/credentials`
  with `{ credentials: { <field>: <value>, … }, mode?, displayName? }`.
- The route **rejects undeclared fields** and **requires every non-optional
  field** — a typo'd field name is a 400, not a silently dropped value.
- The identifier for the stored account is the `email` or `identifier` field if
  present, else the connecting user's id.
- `liaison config apply` takes the identifier from the field the manifest names
  in `identifierVar` (for example the Google Ads `customerId`), else from the
  config's `identifier`. `liaison guide <app>/<connection>` marks every field a
  person may leave empty as optional.
- `GET /api/connections/:id/settings` returns an account's stored fields the
  manifest marks `readable: true` (hosts, ports, username), so an edit form
  opens filled. No other field is ever returned. Its owner reads a personal account; an org account needs the
  connection's admin scope.

### `oauth2`

The operator clicks **Connect**, is redirected to the provider's consent
screen, approves, and is redirected back. The kernel exchanges the code for an
access token (+ refresh token) and stores both encrypted. This needs an **OAuth
client** (client id + secret) to exist first — see §3.

- Authorize: `POST /api/connections/:appName/:connectionName/authorize`
  → `{ redirectUrl }`. The browser follows `redirectUrl` to the provider.
- Callback (public, no auth): `GET /api/connections/callback?code=…&state=…`.
  The kernel validates `state` (15-minute TTL in Redis), exchanges the code, and
  redirects back into the app UI.

**Account names.** Settings shows each account by its display name, else its
identifier when that reads as a name (an email, a handle). A bare number or a
UUID is never shown: the row then reads as the connection's own name. A
connection whose identifier is opaque declares `displayNameUrl` (plus
`displayNameFields`) so the kernel reads the account's name with its access
token at connect, at token renewal and on reconcile. An account stored without
a name is also looked up when Settings lists it: in the background, one account
at a time, and a failed lookup waits 30 minutes before a later view tries again.

**Authorize parameters from an app setting.** A value that differs per
deployment (Meta's `config_id` of a Facebook Login for Business configuration)
is declared as `authorizeConfigParams: { "<param>": { "configKey", "pattern" } }`.
The kernel reads the value from the app's config (a key the manifest declares
in `configKeys`, set by an admin or with `config apply` `apps[].config`) and
checks it against the anchored `pattern`, matched against the whole value. While it is missing or does not match,
**Connect** is refused with `missing_setting` and the name of the setting. The
OAuth and OpenID Connect protocol parameters (the ones the kernel sets itself:
`client_id`, `redirect_uri`, `state`, `scope`, PKCE, `login_hint`; and
`response_mode`, `nonce`, `prompt`, `code`, `request`, `request_uri` and the
like) cannot come from config. Fixed extras still go in
`extraParams` (`override_default_response_type: "true"`). The connection guide
lists the setting as a step before connecting.

**An identifier from a list of accounts.** A sign-in that can cover several
accounts declares `identifierFromUserinfoPath` (a dotted path into the
`userinfoUrl` response, `[]` over an array: `data[].id`) and optionally
`accountNameField` (the field beside the id that names the account). One
account is connected under its id. When several come back, the kernel never
picks one: it connects the one the flow was started for (the connect card's
`identifier`, matched by id or name) or, without one, connects nothing and
names the accounts, so the person connects again for the one they mean. No
account at the path connects nothing either.

---

## 2. The OAuth callback URL

For **every** oauth2 connection the redirect URI the kernel sends to the
provider is:

```
${BASE_URL}/api/connections/callback
```

`BASE_URL` is the instance's public URL (env var; in production the server
refuses to boot if it is still the `http://localhost:3000` default, because MCP
OAuth discovery depends on it). This exact URL — including scheme and host —
**must be registered in the OAuth client's list of authorised redirect URIs on
the provider side** (e.g. Google's "Authorized redirect URIs"). A mismatch is
the single most common OAuth failure: the provider shows `redirect_uri_mismatch`
before the user ever reaches your app.

There is one callback for all apps; the `state` parameter carries which app,
connection, org, user and owner-type the flow belongs to.

### One redirect host for several org hosts

A deployment that serves each org on its own host (`LIAISON_ORG_HOST_TEMPLATE`)
can send every provider to one central host instead: set
`LIAISON_OAUTH_REDIRECT_BASE` (for example `https://auth.example.com`). The
redirect URI is then `${LIAISON_OAUTH_REDIRECT_BASE}/api/connections/callback`
for connections and `${LIAISON_OAUTH_REDIRECT_BASE}/api/auth/oauth/callback`
for sign-in, the one URI to register with each provider. The code exchange sends
the same URI. The `state` starts with the org's slug and a dot
(`acme.<random>`), so whatever serves the central host can send the browser on
to `acme`'s own host, where the flow started; the callback there refuses a state
that names another org or has no slug. Every setup guide (Google, Shopify, Meta
and the rest) shows the central URI when the variable is set. MCP server
sign-ins keep the org's own host: their clients are registered per connection,
so no single URI is needed. Unset, everything uses `BASE_URL` as above.

### Set up a Google OAuth client

The agent guides an administrator through it (kernel skill `google-setup`).
It never writes the values from memory: `kernel__google_setup` computes them
for this server and workspace (`modules/connection-guides/google.ts`):

- **Redirect URIs**: `${BASE_URL}/api/connections/callback`, plus
  `${BASE_URL}/api/auth/oauth/callback` only when the deployment signs people
  in with Google (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, set
  by whoever runs the server, never per workspace).
- **Scopes**: the union of the Google scopes of the apps that are on, as their
  manifests declare them.
- **APIs to enable**: the Google APIs those scopes need (Gmail, Google
  Calendar, Google Drive, and Google Ads, Merchant or YouTube Data when those
  apps are on).

The steps, in Google Cloud console: choose or create a project; enable the
APIs; in **Google Auth Platform**, **Audience**: **Internal** for a Google
Workspace organization, or **External** with publishing status **Testing**
and each Gmail address added as a test user (Testing grants expire after 7
days, so the connection must be made again); **Branding** (the guide gives
the app name, your own admin address as the support and developer contact
email, and the domain to authorize); **Data access**
(the scopes); **Clients** → **Create client** → **Web application** with the
redirect URIs. The client ID and secret then go through the form card, never
the chat. When the project's ID is known, every console link of the guide
opens with that project selected, and every step the person does says its own
time. Gmail push through Pub/Sub is optional (polling works without it):
a topic, the role Pub/Sub Publisher for `gmail-api-push@system.gserviceaccount.com`,
and a push subscription to `${BASE_URL}/webhooks/<org id>/mail/gmail-push`.

When every Google connection that is on already has a client, the
workspace's own or the one this server provides (see section 3), nothing is
created in Google Cloud and each account connects with its Connect card. With
the workspace's own client, a connection that was never connected with it (the
client was set up for Gmail, Calendar was turned on later) first has its APIs
turned on and its scopes added in that client's project; Gmail push stays
optional. When the server provides a shared
Gmail push topic (`GMAIL_PUBSUB_TOPIC`), the Pub/Sub step is dropped too. On a
managed server that topic lives in the project of the server's own Google client,
and Gmail publishes only to a topic in the calling client's project: a workspace
on its own Google client keeps the Pub/Sub step and creates the topic in its own
project. The
scopes and APIs the tool lists cover only the connections that still need a
client. Once the workspace has its own Google client, a connection that takes a
client of its own (Google Drive, YouTube) is left out of these steps and named
apart: it is set up only when someone asks for it, on its own client card, and
can reuse the same project and client. The result starts with
`remainingInGoogleCloud`, the steps still to do in Google Cloud before
connecting (an empty list means none are left), and its next step says the same
in words.

The Connect card for a Shopify store is refused while the workspace has no
Shopify client (its own or the server's): the agent first walks the person
through creating the app in the Shopify Dev Dashboard (`kernel__shopify_setup`:
App URL, redirect URLs, scopes and API version computed for this server, with
Shopify-managed installation; no app review, no CLI), then the client card, then the Connect
card. Someone who prefers the Shopify CLI gets the `shopify.app.toml`
(`kernel__shopify_app_toml`) instead. A Connect card or client card for a connection the
workspace does not declare is refused before any approval, with the
connections it does declare.

### Mailbox limit

Whoever runs the server can limit how many mailboxes an organization connects
(`liaison org caps --mailboxes`, see [Limit an organization](provisioning-cli.md#limit-an-organization)).
Every Gmail or IMAP connection counts, for Mail or Tickets, until it is
disconnected; the same address counts once. Past the limit, connecting a new
address is refused with `MAILBOX_LIMIT_REACHED` (409, or the connect failure of
the same name after an OAuth consent); reconnecting a connected address always
works.

In the managed edition plans do not limit mailboxes, shared or personal: connecting
one is never refused. What mail stores counts towards the plan's storage.

### Which path an address takes

`kernel__google_setup` with the mailbox address (`email`), and `liaison guide
google --email <address>` on the command line, first classify the address
(`connection-guides/account-type.ts`: known consumer and Microsoft domains,
then the domain's MX records, with a short timeout; anything undecided is
`unknown`) and return one `path` (`googleConnectPath` in `@liaison/shared`):

| Path | When | What happens |
|---|---|---|
| `consent` | the workspace has its own Google client, the instance's client is verified for the restricted scopes (`GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED=true`), or the address is in a Workspace domain the instance's client is Internal to (`GOOGLE_OAUTH_INTERNAL_DOMAINS`) | the Connect card, nothing in Google Cloud. For an Internal client the guide adds one optional check: if Google answers `admin_policy_enforced`, a super admin ticks **Trust internal, domain-owned apps** in [API controls](https://admin.google.com/ac/owl) |
| `trusted` | Google Workspace address, instance client External and not verified | the Workspace administrator marks the instance's client(s) as **Trusted** in the Admin console (Security → Access and data control → API controls → Manage App Access → Configure new app), then the Connect card. The agent first asks whether the person is a super admin and walks one step per message; a person who is not gets the message to forward, copied as is. The steps and the client IDs come from `googleTrustedGuide`, with a message the person can forward to the administrator. |
| `consumer_imap` | personal Gmail address, instance client not verified | no Connect card: Google blocks unverified restricted scopes for personal accounts. The mailbox connects over IMAP with an app password (2-Step Verification first, then the app password, then the form, which comes filled with Gmail's servers). The form is a personal one (`connection_credentials` with `mode: "personal"`): the mailbox is the person's own, not the organization's, and only that person can fill it in. A Gmail Connect card for a personal Gmail address is refused (`personal_gmail_imap`) while the instance client is unverified. Read, star, archive and trash sync both ways and the Sent folder is imported; new mail arrives every 2 minutes. Google Drive connects in picked mode (below). Mail forwarding is never offered. |
| `own_client` | no client at all | the Google Cloud steps above, then the client card |
| `imap` | Outlook, Microsoft 365 or another provider | the provider's IMAP steps (Microsoft no longer accepts passwords over IMAP). When the mail servers are not a provider Liaison knows (a filtering gateway in front of the mailbox, for one), the agent asks who hosts the mailbox and never assumes Google Workspace. |
| `ask` | the address could not be classified | the agent asks whether it is a Workspace or a personal account |

A consent that a Workspace policy blocks comes back as the connect failure
`admin_policy_blocked`, whose message points to the Trusted step.

A mailbox that is not on Google connects over IMAP with an app password. The
same tool returns each provider's steps and servers (Gmail, iCloud, Fastmail).
Outlook.com and Microsoft 365 mailboxes no longer accept a password or an app
password over IMAP.

A refused sign-in says why: wrong password, an app password is needed, IMAP is
turned off for the mailbox, Google held the sign-in back until it is confirmed
in a browser, or too many connections at once. A Gmail app password pasted with its
spaces (`abcd efgh ijkl mnop`) works as is.

### Google Drive: the whole Drive or the files you pick

Google Drive connects in one of two modes, and the agent's Google setup and
`liaison guide google --email <address>` (`driveMode`) say which:

- **Full**: Liaison reads the whole Drive (`drive.readonly`). This is the mode
  with the workspace's own Google client, with a server client verified for
  restricted scopes, and for a Google Workspace address.
- **Picked**: a personal Google account on the server's unverified client. The
  address decides: the one the agent's Connect card was made for (sent to Google
  as `login_hint`), otherwise the person's sign-in address.
  Google does not grant it the whole Drive, so Liaison asks only for
  `drive.file` and sees just the files and folders the person picks. After
  connecting, the **Choose files for Liaison** card's **Choose files** button
  opens Google's Picker. The card shows on the connect card, when the agent
  offers it, and on the Drive account in Settings > Apps > Google Drive, which also lists the picked items with a
  button to remove each. Picked items sync into Knowledge; a removed item
  leaves it. Files added to a picked folder later may need picking too.

A Drive the **organization** connects reads, in either mode, only the shared
drives an admin picks, never the connecting account's My Drive: the Google
setup guide ends with the step **Pick the shared drives the team should see**.
Connect it with an account that is a member of each of those shared drives
(Google lists only that account's drives). Until one is picked it reads nothing
and admins get a Home item; a reconnect keeps the picked drives. See
[Google Drive](apps/google-drive.md#share-the-organizations-shared-drives).

The Picker needs two server variables: `GOOGLE_PICKER_API_KEY` (an API key
with the Google Picker API enabled) and `GOOGLE_CLOUD_PROJECT_NUMBER` (the
number of the Google Cloud project that owns the Drive client). Without them
the card says so to the administrator instead of showing **Choose files**. In
the desktop and phone apps the Picker opens in the system browser.

The steps are structured (`googleSetupGuide`, `googleTrustedGuide`,
`imapPasswordGuide`, `shopifySetupGuide` and `shopifyDashboardGuide` in
`@liaison/shared`, strings in the `setup-guides` i18n
namespace), so a client card can render the same guide.

---

## 3. Where the OAuth client (client id + secret) comes from

One resolver picks every connection's client
(`modules/apps/connections/oauth-client.ts`, `resolveOAuthClient`), in a
**fixed order**:

1. **The workspace's own client** ("org"). Gmail (Mail, Tickets) and Google
   Calendar share the **workspace Google client** saved in Settings. Every
   other connection has its own row in `kernel.oauth_providers` named
   `<appName>:<connectionName>` (see below).
2. **A client the instance provides** ("instance"): one client the server
   brings for every workspace, from its environment, so nobody creates one.

| Connections | Instance client (both variables, or neither) |
|---|---|
| Gmail (Mail, Tickets), Google Calendar | `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` |
| Google Drive | `GOOGLE_DRIVE_OAUTH_CLIENT_ID` / `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` |
| Google Ads, Merchant Center (Ads), YouTube (Social) | `GOOGLE_MARKETING_OAUTH_CLIENT_ID` / `GOOGLE_MARKETING_OAUTH_CLIENT_SECRET` |
| Shopify | `SHOPIFY_APP_CLIENT_ID` / `SHOPIFY_APP_CLIENT_SECRET` |
| Facebook, Instagram through Facebook login (Social), managed edition only | `META_APP_ID` / `META_APP_SECRET` |

A workspace that brings its own client always overrides the instance's.
On a managed server, while a workspace uses the server's Google client or Meta
app, the server's Gmail push values (topic, audience, service account) and its
Meta app secret and callback are the ones the apps use: a value the workspace
stored for one of them is ignored, and setting one is refused
(`cell_config_locked`). A workspace on its own client keeps its own values.
`GOOGLE_OAUTH_*` is the sign-in client, never an app connection's.

When the instance provides a connection's client, the setup skips client
creation entirely: `kernel__google_setup` and `kernel__shopify_app_toml` report
the client source (`org`, `instance` or `none`), the guide collapses to the
connect step, the Shopify tool hands over no `shopify.app.toml`, and
`kernel__setup_state` lists, per OAuth connection, the next step: a client card
(no client yet), a consent card (a client exists), or connected. What it
counts as left is only the connections of the features the person chose
(`setup.features`, the basics until they answer): a step with alternatives
(Gmail or an IMAP mailbox) is done by either, and every other feature is a
menu with its time (`modules/connection-guides/setup-features.ts`). A new
connection joins a feature there.

An app's own client resolver (`_oauthClientResolvers`) can refuse a connection
the workspace switched off by throwing `ConnectionTurnedOffError`
(`modules/apps/connections/oauth-client-config.ts`) with what turns it on (Mail
does this while **Gmail mailboxes** is off). `kernel__setup_state` then reports
the step `turn_on` with that text, `kernel__request_secret` posts no consent card
for it, and a card met by the switch is refused with the code
`connect_turned_off`.

A Shopify instance app is used for OAuth and, since Shopify signs webhooks with
the app's secret, for webhook HMAC verification: the verifier reads the
connection's current client secret through the same resolver
(`modules/webhooks/routes.ts`). Webhook subscriptions stay per workspace, at
`${BASE_URL}/webhooks/<org id>/shopify/<topic>`. Register
`${BASE_URL}/api/connections/callback` as the app's redirect URL.
Distribute an instance Shopify app as a custom app: an App Store app must answer
Shopify's mandatory compliance webhooks (`customers/data_request`,
`customers/redact`, `shop/redact`), which are not implemented yet. A delivery is
accepted only with its `X-Shopify-Shop-Domain` header, for a store the
organization has connected (an instance app signs every organization's
deliveries with the same secret).

Each connected account records the client that minted its tokens (`org` or
`instance`, and the client id; accounts from before are `legacy` and resolve in
the order that applied then). A refresh, and a Shopify webhook check through the
secret stored at connect, keep using that client after the workspace saves
another. Saving a client reports how many accounts a reconnect would move. When
the minting client is gone (the instance stopped providing it), the account is
marked for reconnect.

An in-tree app may still declare `_oauthClientResolvers.<connection>` in its
`manifest-descriptor.ts` to gate its connection: Mail refuses Gmail when the
Gmail provider is off for the org, then takes the workspace Google client
through the resolver. A resolver that returns `null` leaves the choice to the
order above. `oauth-client.guard.test.ts` fails when any other module reads a
connection's client on its own.

### Provisioning the DB fallback client

Two equivalent surfaces write the `kernel.oauth_providers` row (they share one
upsert, so they cannot drift):

- **API** (scope `kernel:apps:admin`):
  ```
  PUT /api/connections/:appName/:connectionName/oauth-client
  { "clientId": "…", "clientSecret": "…" }
  ```
  The route 404s if the connection is not declared in the installed app's
  manifest, and 400s if the connection is not `type: oauth2` — so a typo can't
  create a dangling client row.
- **Settings → the app → OAuth client dialog** — same upsert, admin-gated.
  When a client is already configured (the org's or the instance's), the
  connect dialog shows one **Connect** button and a sentence naming whose
  account gets connected (yours, or the organization's); the client fields
  sit behind **Use your own OAuth client**, which replaces the client. With
  no client configured, the fields show up front. On a managed instance whose
  client the instance provides, the dialog never offers the fields.

Read it back with `GET …/oauth-client` (secret is never returned).

---

## 4. Ownership: user-owned vs org-owned

Every connection is stored with an `ownerType`:

| Shape | `ownerType` / `owner_id` | Who can use it | Pick it for |
|-------|--------------------------|----------------|-------------|
| **User-owned** (default) | `user` / connecting user's id | Only that user's own tool calls / agent runs. Isolated by RLS. | Personal mailboxes, a user's own calendar. |
| **Org-owned** (shared) | `org` / `NULL` | Any member; resolvable by agents and by any tool call in the org. | Shared company resources: a company Google Drive, the org's Shopify store, a shared GitLab token. |

- **Choose via the connect request:** `mode: "org"` (aliases: `owner`,
  `ownerType`) on the authorize/credentials call. Org connections require the
  `<appName>:accounts:admin` scope — a non-admin gets 403.
- **The isolation gotcha:** a **user-owned** connection makes the app's tools
  return `not_connected` **for every other user**, including agents acting as
  someone else. This looks like a bug ("I connected it, why does the agent say
  it's not connected?") but is the isolation working as designed — the agent ran
  as a different user, or you wanted org-owned. For anything a shared agent must
  reach, connect it **org-owned**.
- **One owner per account:** a personal connect of an account the
  organization (or another member) already holds is refused and the shared
  connection is left as it is. The person who tried gets an alert in their
  feed saying why and what they can do: a member is told to connect a
  different account or ask an admin, an admin that they can disconnect the
  shared connection first.
- **Any member connects their own account from the chat:** asking the agent
  "connect my Gmail" posts a personal Connect card
  (`kernel__request_secret`, kind `oauth_connect`, mode `personal`); no admin
  scope is needed.
- **Standard or private mailbox:** every setup surface (the in-product agent,
  the setup skill, `liaison connect --for`) asks it once for a person's own
  mailbox, with the same two sentences: standard (transparent) mailboxes are
  read server-side and routines run unattended; for security, routines and
  agents can't read private mail while you're offline, and those runs wait for
  you (**Run now** in your approvals).
- **An admin connects a member's own account with a one-time link:**
  `liaison connect <app>/<connection> --for <email>` (or the agent's gated
  `kernel__connect_link_send`, after an approval) mints a Liaison link at `/connect/link`. Only
  its hash is stored, bound to the org, the member and the connection; it
  expires after 30 minutes and is consumed on first use. It never signs anyone
  in: it works only when the signed-in user is that member (anyone else in the
  organization is told to sign in as them; a session of another organization
  gets the same answer as an unknown link), and then starts the same browser-bound personal
  flow as the Connect button (`POST /api/connections/links/redeem`), so the
  connection is the member's. Minting one for someone else takes the
  connection's admin scope (or the server's CLI). When the connect is refused
  (for example, the account is already the organization's, or its domain is
  not allowed), the browser comes back to the link's page, which says
  **Nothing was connected.** and why, and the waiting `liaison connect --for`
  stops with the same reason and exit code 1. A link nobody opened before it
  expired ends the wait too, with exit code 1 and the command for a new link;
  one the member opened keeps it waiting while they finish the consent. One account can be both an
  organization connection and a member's own only where the app keeps their
  data apart (Google Drive); mail, calendar and ticket inboxes keep one owner
  per account.
- **Disconnect by address:** `liaison disconnect <app>/<connection> <account>`
  and the agent's gated `kernel__connection_disconnect`. An org connection
  takes the connection's admin scope; a personal connection only its owner.
  The CLI removes a member's personal connection only with `--force`, and
  writes a `connection.disconnect.forced` audit entry naming the owner; the
  disconnect is recorded as the system's, not a member's. When one address
  matches several connections, both refuse and list each (owner, id): pass
  the id of the one you mean. The agent's approval card names that one
  connection (whose it is, its address and id, what gets deleted), and the
  approved call removes exactly that id.
- Disconnect and reconcile of org-owned connections are likewise
  admin-gated (`DELETE /api/connections/:id`,
  `POST /api/connections/:id/reconcile`).

If a connection's post-connect initialization was lost (the app's subscriber
wasn't live when the connect event fired), re-drive it idempotently with
`POST /api/connections/:appName/:connectionName/reconcile` (or by connection id)
— safe to click repeatedly.

---

## 5. Token lifetime and refresh

Two different tokens, two different lifetimes — do not conflate them:

- **The connection's OAuth access token** (the token used to call the provider):
  short-lived, provider-set (`expires_in`). The kernel **refreshes it
  automatically** on read. `getTokenForConnection` refreshes an expired or
  about-to-expire token (`~2 min` skew, wider for long-lived Instagram-style
  tokens) using the stored refresh token, persists the new token, and returns
  it. Apps never see the boundary. A refresh that fails because the provider
  rejected the refresh token (Google `400 invalid_grant`, `401`) marks the
  account as needing re-authorization — the fix is **reconnect**, not retry.
  Credentials connections and tokens with no expiry pass through unchanged.
  A token that expires but cannot renew itself (no refresh token, no
  self-refresh: Facebook Login's long-lived user token, about 60 days) gets a
  Home item for the admins 14 days before it lapses, with the date: reconnect
  before then to keep syncing. Once it has lapsed, the item says it expired.
  The date is the provider's own when the connection declares `tokenDebugUrl`
  (Meta's `debug_token`, asked at connect): the earlier of the token's expiry
  and its data-access expiry. Otherwise it is the expiry the token exchange
  gave, and only a token meant to last more than a day gets a reminder. The
  item says which it is ("as the provider reports it" or "from the expiry
  given at connect").

- **The MCP access token** (minted for a headless MCP client, §6): TTL is
  **900 s / 15 minutes** (`MCP_ACCESS_TOKEN_TTL_SECONDS`) to bound the
  revoke→401 window. It is refreshable through the MCP OAuth server's
  refresh-token grant; a headless client re-mints/refreshes when it 401s. This
  is the "~15 minute token" you will see expire on staging — it is the MCP token,
  not the connection token above.

### Disconnecting: revocation and data deletion

Disconnecting a connection (`DELETE /api/connections/:id`, an app's own
disconnect such as `mail:disconnectAccount`, or the last Tickets inbox on a
mailbox) runs one kernel path, `disconnectConnection`:

0. **The app cleans up at the provider, first.** A connection that declares
   `beforeDisconnect: "<export>"` in its manifest has that handler run before the
   disconnect, while the connection is still active and its token still works
   (`connections/before-disconnect.ts`). Shopify uses it to delete the webhook
   subscriptions the org registered on the store (callbacks under
   `<base>/webhooks/<orgId>/shopify/`, never another org's or another host's).
   `DELETE /api/connections/:id` runs it once the caller may disconnect that
   connection (an org connection takes its admin scope, a personal one must be
   visible to the caller), and so does the purge of an expired demo org (its
   rows go without a disconnect). An app disconnecting its own account from a
   tool cleans up before it calls the disconnect; the CLI connector provisioner's
   replace path does not run it. Best effort: a
   failure or a 20 s timeout is logged and never blocks the disconnect.
1. **Stop the push watch, then revoke at the provider.** A connection that declares
   `watchStopUrl` in its manifest (Gmail's `users.stop`, for Mail and Tickets) has that
   endpoint called with its token first, so no new change notification arrives
   for the account. Then a connection that declares `revocationUrl`
   (RFC 7009; every Google connection declares
   `https://oauth2.googleapis.com/revoke`) has its refresh token (else its
   access token) POSTed there. Neither blocks the disconnect, and each call has a 5 s
   timeout. Google keeps ONE grant per Google
   account and OAuth client, shared by every app on that client (Mail, Tickets
   and Calendar; Drive too when it reuses the same client), so the
   grant is kept while another active connection on the instance (any org) holds
   the same account at the same revocation endpoint; the last one revokes it. A
   watch is kept the same way, while another active connection declares the same
   stop endpoint for the account: disconnecting Mail keeps Tickets on the same
   mailbox working, and stops the watch even though Calendar keeps the grant. The
   cross-org lookup is a system read that answers only yes or no. Google sign-in holds
   no token here and does not count: revoking signs nobody out. Two servers sharing
   one OAuth client cannot see each other's connections, so a disconnect on one can
   end the grant the other uses; the other then asks for a reconnect.
2. **Delete the secrets.** The row keeps its history (`status = 'disconnected'`)
   but its access token, refresh token and stored credentials are nulled. A
   re-authorization that replaces a connection drops the old row's tokens too,
   without revoking (the provider hands the reconnect the same grant).
3. **The app deletes what it imported**, on the `connected_account:disconnect`
   event: Mail deletes the mailbox's conversations, messages, drafts, attachment
   files and search documents (the account row stays, marked disconnected);
   Calendar deletes the account's calendars, events and sync log; Drive deletes
   the folders synced into Knowledge from that Drive account (documents, links,
   the collections the sync created, search documents) and, with the org's last
   Drive connection, the cached Drive content. Tickets keeps its tickets and their
   messages (team records) and archives the inbox. A re-authorization (a new
   active connection for the same address) keeps everything.

The provider work runs after the disconnect commits (a rolled-back disconnect
does nothing), from a row the disconnect's own transaction writes to
`kernel.connection_teardowns`, the connection's encrypted tokens moving there
unchanged, so any process can finish it: the caller that owns the transaction runs
it right after, the committed `connected_account:disconnect` event runs it for a
disconnect made inside an app tool's transaction, and the server's leader retries
every minute what is due. A network failure, a 429 or a 5xx from the provider
retries after 1, 5 and 15 minutes, 1 and 4 hours, then every 8 hours, and the
revocation never runs before the stop has an answer. Each teardown logs one line
(`Connection teardown finished at the provider`) with the outcome of the watch and
the grant, never a token, an address or message content. After 72 hours the row and
its tokens are deleted and an error is logged with
`alert: "connection_teardown_gave_up"`; the person can still remove the grant in
their Google account. A person who reconnects the account meanwhile keeps the new
grant and watch: the old tokens are just deleted.

Erasing a user (`liaison erase-user`) does the same for that user's own OAuth
connections, written in the erasure's transaction. Deleting an organization does it
for all of its connections before its rows go, while its own OAuth client still
exists; a row that an outage holds back outlives the organization, at most those 72
hours. An organization moved to another server keeps its grants and watches, so its
move does nothing here. Deactivating a user removes no connection: nothing they own
is deleted, and an admin disconnects a mailbox that should go.

A push that arrives for an account no longer connected, as can happen when a watch
could not be stopped and is lapsing by itself, is answered and dropped: no sync is
started, nothing of it is stored, and its address is not logged.

---

## 6. Headless connect: the MCP device flow

A program holding a device sign-in token that calls an app's tools over REST (`POST /api/apps/run-tool` and its siblings, bulk actions, tool-backed settings) is judged like an MCP client, never as a person's click: a gated tool parks an approval, and outside-text and host rules apply. Its reads are marked on one hidden thread per sign-in, so a `threadId` it sends is ignored. A message it posts to an agent is not a person typing either: a tool that needs a typed message waits for approval, and the message does not clear a conversation's outside-text mark.

For a headless MCP client (a CLI, a bot) that has no browser session, the device
flow mints an MCP token that then acts **as** the approving user:

1. **Initiate** — `POST /mcp/device/initiate { clientId, agentId? }`.
   `clientId` must be listed in the instance's `DEVICE_FLOW_CLIENTS` env
   (comma-separated ids, or `*`). If `DEVICE_FLOW_CLIENTS` is empty the route
   403s with an actionable message — the headless path is **opt-in**. Once it
   is on, the Liaison desktop app's own client id (`liaison-desktop`) is
   admitted as well, listed or not: its local sessions need an agent-scoped
   token and this grant is the only way it gets one.
   `agentId` binds the resulting connection to an agent, narrowing its token to
   that agent's live scope ceiling.
   Returns `{ deviceCode, userCode, verificationUri, expiresIn: 900 }`.
2. **Approve** — a signed-in user approves the `userCode`:
   `POST /api/auth/device-flow/approve/:userCode` with the **Bearer token of the
   approving user**. The minted MCP token acts as that user, so **whose
   user-owned connections the token can see is decided here** — approve as the
   user who owns the connections the client needs (or use org-owned connections).
   A grant bound to no agent carries the approver's whole access, so the approve
   call must say so explicitly with the body `{ "confirmFullAccess": true }`
   (409 otherwise). `GET /api/auth/device-flow/pending/:userCode` (same bearer)
   returns what the request asks for before anyone approves it: client id,
   device label, source IP, declared scopes or bound agent, and `fullAccess`.
3. **Poll** — `GET /mcp/device/poll/:deviceCode?client_id=<id>` until
   `status: "approved"`, which returns the token (single-consume). States before
   that: `authorization_pending`, `slow_down` (429, honour `Retry-After`),
   `expired`, `denied`.
   A grant initiated with an `agentId` must re-state it as `&agent_id=<id>` on
   the poll, and a grant initiated without one must not name any. Anything else
   is a 400 and the grant is spent: re-initiate. The binding is never inferred,
   so a lost or mismatched one can never quietly widen the token to the
   approving user's own scopes.

### The approval page

`initiate` returns `verificationUri = ${BASE_URL}/auth/device?code=<userCode>`,
and `apps/web` serves that URL: **`/auth/device`**, optionally with `?code=`
(`apps/web/src/modules/auth/DeviceApproval.tsx`, routed in `App.tsx`).

The page shows the code and, before Approve is enabled, what the request says
about itself (from `GET /api/auth/device-flow/pending/:userCode`): the client id
and device label, both marked as chosen by the requester and so unverified, the
IP address the request came from, and the scopes it declared or the agent it is
bound to. A request that would carry the visitor's whole access (a login request
with no scopes, an MCP grant bound to no agent) needs an explicit "I understand"
tick before Approve works, and the server refuses the approval without it. The
page offers **Approve** and **Deny**, which call `POST /api/auth/device-flow/approve/:userCode` and
`POST /api/auth/device-flow/deny/:userCode` with the visitor's own bearer token.
The code field is editable, so a truncated link or a code read off the other
screen still works; it is normalised to 8 uppercase alphanumerics, and the
server is what validates it. A rejected code (404 on an expired, consumed or
unknown grant) says so inline and the visitor can retry with another.

The page is behind `ProtectedRoute`, so a signed-out visitor is sent to
`/login?returnTo=%2Fauth%2Fdevice%3Fcode%3D<userCode>` and lands back on it,
code intact, once they sign in. Approving is therefore the ordinary path; the
API-side approve call with a bearer token (step 2 above) remains available for
scripts and for a client with no browser at hand.

---

## 7. The same provider in several apps — pick the right one

A connection is identified by **`<app>/<connection>`**, and several apps
deliberately declare a connection with the *same* name against the *same*
provider. They are not interchangeable. Today:

| Provider | Declared by | What connecting it actually gets you |
|---|---|---|
| Google / Gmail | **`tickets/gmail`** | The **desk's mailbox**: inbound mail becomes tickets. Auto-creates a tickets inbox and starts `gmail-initial-sync`. |
| | **`mail/gmail`** | A **mail client** inside Liaison: read, search, triage, draft replies. Creates no ticket, ever. |
| | `calendar/google-calendar` | Calendar events. |
| | `google-drive/drive` | Files. |
| IMAP/SMTP | **`tickets/imap`** | Same as `tickets/gmail`, for a non-Google mailbox: mail becomes tickets. |
| | **`mail/imap`** | Same as `mail/gmail`, for a non-Google mailbox. |

The Google four ask the same account for overlapping scopes, so **the consent
screen looks identical** and approving the wrong one succeeds. The IMAP pair is
worse still: the credentials form is the same host/port/user/password in both
apps, with nothing on screen to tell them apart. That is what makes this worth a
section: the failure is silent.

**Symptom of picking the wrong one:** the OAuth completes, the account shows
`active` in `kernel.connected_accounts`, and the thing you wanted never happens
— no tickets, no events, no files. Nothing errors, because nothing is wrong;
you connected a different app.

**How to tell before you start:** the app's post-connect subscriber is gated on
its own name. `ticketsOnAccountConnected` returns early unless
`event.data.appName === "tickets"`, so connecting `mail/gmail` cannot create a
tickets inbox no matter how correct the token is. Read the app's README
"Connecting" section — the one that owns the *outcome* you want, not the one
that owns the *provider*.

**How to tell after:** each app's connect has a visible side effect. For
`tickets/gmail` it is a new inbox in Settings → Tickets Inboxes named after the
address. No side effect ⇒ wrong app.

Reach for the app whose **outcome** you want:

- "customer mail should become tickets" → `tickets/gmail` (or `tickets/imap`)
- "I want to read and reply to mail in Liaison" → `mail/gmail` (or `mail/imap`)

Connecting both against one address is legal and occasionally intended, but it
grants two apps full read/write on that mailbox — do it on purpose, not by
accident, and disconnect the one you did not mean to add.

> The OAuth **client** (id + secret) is resolved per app too, and the env var
> names differ per app (§3). `tickets/gmail` and `mail/gmail` both end up on the
> shared Google integration client, but by different routes — Tickets via
> `resolveGoogleOAuthClientConfig`, Mail via
> `resolveEnabledMailProviderOAuthClient`, which **additionally** requires the
> per-org "Gmail enabled" flag that Settings → Mail Setup writes. So
> `mail/gmail` can be blocked by a gate that does not apply to `tickets/gmail`
> at all. If one works and the other 403s, this is why.

---

## 8. Failure modes (cross-app)

| Symptom | Likely cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at the provider | `${BASE_URL}/api/connections/callback` not in the client's authorised redirect URIs, or `BASE_URL` wrong | Register the exact callback URL; verify `BASE_URL`. |
| "No OAuth client configured" on Connect | env-driven resolver unset **and** no `kernel.oauth_providers` row | Set the app's `*_OAUTH_CLIENT_*` env, **or** `PUT …/oauth-client`. |
| Env client id set but still not picked up | wrong env var name (e.g. `GOOGLE_OAUTH_*` instead of `GOOGLE_DRIVE_OAUTH_*`), only one of the pair set, or the workspace has its own client (it wins) | Use the exact names in section 3; check `GET /api/connections/:app/:conn/oauth-client` for the source. |
| Tool returns `not_connected` for some users only | connection is **user-owned**; the caller/agent is a different user | Reconnect **org-owned** (`mode: "org"`, needs `:accounts:admin`). |
| A call answers `connection_not_connected` (422) | the connection has no active account: never connected, disconnected, or its account was deleted. A tool returns it as its answer, not a failure; a mail send names the mailbox and says nothing was sent | Connect (or reconnect) it in Settings → Connections. |
| 403 "Admin scope required" on connect/disconnect | org-mode connect without `<app>:accounts:admin` | Grant the scope or connect user-owned. |
| App silently uninitialised after connecting | post-connect event lost | `POST /api/connections/:appName/:connectionName/reconcile`. |
| "requires re-authorization" / repeated 401s | refresh token revoked/expired at provider | Disconnect and reconnect. |
| Callback answers `503` `org_moving` | the organization was being moved to another server at that moment | Connect again a few seconds later. |
| MCP device flow 403 on initiate | `clientId` not in `DEVICE_FLOW_CLIENTS` | Add it to the env (or `*`). |
| Connect succeeds, account is `active`, **but nothing happens** (no tickets / no events / no files) | Connected the **wrong app's** connection for the same provider (§7) | Connect the app that owns the outcome, e.g. `tickets/gmail` not `mail/gmail`. Disconnect the stray one. |

Provider-specific errors (Google Drive scope/quota, Shopify shop-domain, …) are
documented in each app's own README.

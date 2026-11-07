// SPDX-License-Identifier: FSL-1.1-ALv2
// JSON Schema definition for app.manifest.json
// Validated server-side by Ajv in validateAppManifest()

const NAME_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
const SEMVER_PATTERN = "^\\d+\\.\\d+\\.\\d+(-[\\w.]+)?(\\+[\\w.]+)?$"
const EVENT_PATTERN = "^[a-z_]+:[a-z_]+$"
const SLOT_KEY_PATTERN = "^[a-z0-9-]+:[a-z0-9-]+(:[a-z0-9-]+)*$"
const WEBHOOK_NAME_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
const TOOL_DEPENDENCY_PATTERN = "^[a-z][a-z0-9_-]*:[a-zA-Z][a-zA-Z0-9_]*$"
// A visible name: the text, and optionally the catalog key that follows the reader's language.
const LABEL_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1 },
    labelKey: { type: "string", minLength: 1 },
  },
  required: ["label"],
} as const
// One panel or action an app contributes to a slot. `visibility_scope` hides it from people
// without the scope, `order` sorts it, `group` is a label key for a host that sections its panels.
const SLOT_CONTRIBUTION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    label: { type: "string" },
    labelKey: { type: "string" },
    component: { type: "string" },
    visibility_scope: { type: "string", minLength: 1 },
    order: { type: "integer" },
    group: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
  },
} as const
const SCOPE_PATTERN = "^[a-z][a-z0-9_-]*:[a-zA-Z0-9_:-]+$"

// Partial-index / partial-unique WHERE clauses are interpolated verbatim into
// privileged DDL — a `;`-only reject still allows subquery/function injection
// (e.g. `(SELECT ...)` subverting uniqueness, or `pg_sleep(...)` DoS). Restrict
// to a simple comparison grammar: `column IS [NOT] NULL`, `column IS [NOT]
// DISTINCT FROM <lit>`, or `column <op> <lit>` (op ∈ = <> != < <= > >=), joined
// by AND/OR. <lit> is a single-quoted string, number, or true/false/null. No
// parentheses, subqueries, function calls, comments, or statement separators.
// Mirrors validateWhereClause() in ddl.ts (the emission-site defense-in-depth).
// Ajv compiles `pattern` without the `i` flag, so SQL keywords are written with
// case-insensitive character classes (e.g. `[Ii][Ss]`).
const _KW = (word: string) =>
  word
    .split("")
    .map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
    .join("")
const _LITERAL = `(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|${_KW("true")}|${_KW("false")}|${_KW("null")})`
const _IS = _KW("is")
const _NOT = _KW("not")
const WHERE_TERM_PATTERN =
  `[a-z_][a-z0-9_]*\\s+(?:${_IS}\\s+(?:${_NOT}\\s+)?${_KW("null")}` +
  `|${_IS}\\s+(?:${_NOT}\\s+)?${_KW("distinct")}\\s+${_KW("from")}\\s+${_LITERAL}` +
  `|(?:=|<>|!=|<=|>=|<|>)\\s*${_LITERAL})`
const WHERE_CLAUSE_PATTERN = `^\\s*${WHERE_TERM_PATTERN}(?:\\s+(?:${_KW("and")}|${_KW("or")})\\s+${WHERE_TERM_PATTERN})*\\s*$`

// Reusable JSON-Schema fragment for a partial-index WHERE clause.
const whereClauseSchema = {
  type: "string",
  minLength: 1,
  pattern: WHERE_CLAUSE_PATTERN,
}

/**
 * Known platform capabilities that apps may declare. Capabilities gate access
 * to RPC bridge methods that touch shared kernel infrastructure (the agent
 * runtime, Redis pub/sub). The bridge enforces the declaration at call entry.
 */
export const KNOWN_CAPABILITIES = [
  "agent.run",
  "agent.spawn",
  "realtime.publish",
  // Phase 16 — apps that orchestrate Liaison-side authorization (e.g. Shopify
  // mirroring its `read_users` to per-user scope grants) declare this; the
  // RPC bridge gates `grants.setUserScopes` on the declaration.
  "grants.setUserScopes",
  // Phase 16 Task A7 — apps that need to ingest large bulk-operation result
  // URLs (e.g. Shopify's bulk operations) declare this to use the
  // `ctx.bulk.fetchToBlob` / `iterateJsonl` / `deleteBlob` primitives.
  "bulk.fetch",
  // Phase 17 (K1) — apps that post messages into kernel.threads on behalf of
  // a contact (e.g. invoicing posting the issued invoice PDF into the
  // contact's primary thread). The bridge gates `messages.post` on the
  // declaration.
  "messages.post",
  // Phase 17 (K2) — apps that render PDF documents via the kernel's
  // worker-pool renderer (`pdf.render`).
  "pdf.render",
  // Phase 17 (K3) — apps that allocate gapless monotonic sequence numbers
  // via `sequences.allocate` (e.g. INV-2026-0001).
  "sequences.allocate",
  // Apps that import a business system's customers into the ORGANISATION's
  // contacts (e.g. Shopify customers, the counterparties invoicing issues to).
  // Connecting such an app is the admin's decision to share those customers
  // with the org; without the declaration an app's `resolveContact` only links
  // to contacts that already exist (modules/contacts/service.ts ContactAudience).
  "contacts.addToOrganisation",
  // Apps that read their OWN files (a PDF or an image) with the org's media-analysis model
  // (`files.analyzeDocument`): credits, the demo refusal and the org's `apps` media toggle apply.
  "files.analyzeDocument",
] as const

const referencesSchema = {
  type: "object",
  properties: {
    schema: { type: "string" },
    table: { type: "string" },
    column: { type: "string" },
    onDelete: {
      type: "string",
      enum: ["cascade", "set null", "restrict", "no action"],
    },
  },
  required: ["table", "column"],
  additionalProperties: false,
}

const fieldDefSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        type: { type: "string" },
        required: { type: "boolean" },
        default: {},
        enum: { type: "array", items: { type: "string" }, minItems: 1 },
        references: referencesSchema,
        // G1: per-field user-reference erasure declaration. The cross-field
        // rule (userRef⇔onErase) is enforced in validateSchemaConstraints.
        userRef: { type: "boolean", enum: [true] },
        onErase: { type: "string", enum: ["delete", "anonymize"] },
      },
      required: ["type"],
    },
  ],
}

/** One import kind under `import.kinds` (see the `import` key below). */
const importKindSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    // The canonical record, as a JSON Schema. Must be `type: "object"`
    // (checked by validateAppManifest, which also compiles it).
    schema: { type: "object" },
    // Export name of the handler: a host module for built-in apps, a bundle
    // export for installed apps.
    handler: { type: "string", minLength: 1 },
    // Export name of the preview's check (installed apps): the handler's own
    // per-record checks without writing, one { status, error? } per record, so
    // a preview refuses what the run would.
    check: { type: "string", minLength: 1 },
    // Top-level string field holding the source's stable id.
    dedupKey: { type: "string", minLength: 1 },
    // Schema-qualified tables this kind writes (the coverage guard reads them).
    tables: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    // Scopes the person starting a run must hold.
    writeScopes: {
      type: "array",
      items: { type: "string", pattern: SCOPE_PATTERN },
      minItems: 1,
    },
    // A record field carrying a dimension value the person must be granted.
    dimension: {
      type: "object",
      properties: {
        field: { type: "string", minLength: 1 },
        dimension: { type: "string", minLength: 1 },
      },
      required: ["field", "dimension"],
      additionalProperties: false,
    },
    // Fields holding people's emails (resolved to users).
    people: { type: "array", items: { type: "string", minLength: 1 } },
    // Fields holding file references.
    files: { type: "array", items: { type: "string", minLength: 1 } },
    // Another kind of the same app whose records must be imported first.
    parent: { type: "string", minLength: 1 },
    // Tables (among `tables`) whose rows later records of the same run update
    // (in-run roll-ups); undo compares their changes with the run's end.
    rollupTables: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["schema", "handler", "dedupKey", "tables", "writeScopes"],
  additionalProperties: false,
}

const dimensionDefSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["membership", "level", "enum", "value"] },
    column: { type: "string" },
    order: { type: "array", items: { type: "string" } },
    values: { type: "array", items: { type: "string" } },
    /** Admin-UI label, eg. "Team". Defaults to the capitalized key. */
    label: { type: "string", minLength: 1 },
    /** One-line helper shown under the label in the admin UI. */
    description: { type: "string", minLength: 1 },
    /**
     * Optional href to a settings page that manages this dimension's values
     * (eg. "/settings/apps/mail"). Used for dynamic dimensions whose
     * values aren't enumerable from the manifest itself — the admin UI
     * surfaces a "manage in {section}" link instead of a checkbox grid.
     */
    manageHref: { type: "string", minLength: 1 },
    inheritFrom: {
      type: "object",
      properties: {
        table: { type: "string" },
        localColumn: { type: "string" },
        remoteColumn: { type: "string" },
      },
      required: ["table", "localColumn", "remoteColumn"],
      additionalProperties: false,
    },
  },
  required: ["type"],
}

const triggerDefSchema = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      timing: { type: "string", enum: ["BEFORE", "AFTER", "INSTEAD OF"] },
      event: {
        type: "array",
        items: {
          type: "string",
          pattern: "^(INSERT|UPDATE|DELETE|UPDATE OF [a-z_][a-z0-9_]*)$",
        },
        minItems: 1,
      },
      level: { type: "string", enum: ["ROW", "STATEMENT"] },
      language: { type: "string", enum: ["plpgsql"] },
      // A trigger body is interpolated between dollar-quote tags into DDL run by
      // a privileged DB role. A body containing a dollar-quote tag sequence
      // ($...$) could close the quote early and inject arbitrary DDL/DML, so it
      // is rejected here (the DDL generator derives a content-hash tag and also
      // rejects this as defense-in-depth). Note `$1`/`$2` positional params do
      // NOT match — a tag requires an opening AND closing `$`.
      body: { type: "string", minLength: 1, not: { pattern: "\\$[A-Za-z0-9_]*\\$" } },
    },
    required: ["timing", "event", "level", "language", "body"],
    additionalProperties: false,
  },
}

const credentialFieldSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    label: { type: "string" },
    type: { type: "string", enum: ["text", "password", "number"] },
    required: { type: "boolean" },
    // The stored value may be read back to prefill an edit form
    // (GET /api/connections/:id/settings). Default false: a field is
    // readable only when the manifest says it holds no secret.
    readable: { type: "boolean" },
  },
  required: ["name", "label", "type"],
}

const connectionSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["oauth2", "credentials"] },
    // Optional human-readable description of the connection, surfaced in the
    // connect UI alongside the setup guide.
    description: { type: "string" },
    // The app works without this connection (an inbound webhook secret, an
    // alternative account). Settings > Apps then offers it as a secondary
    // "Set up ... (optional)" link instead of a primary "Connect".
    optional: { type: "boolean" },
    // A few words naming what the connection connects ("CI release-status
    // webhook"): the connect button's label. English; the web catalog may
    // translate first-party ones (kernel.appConnections.<app>.<connection>).
    purpose: { type: "string", minLength: 1, maxLength: 60 },
    // The scope that administers this connection for the organization: connect it
    // org-owned, share a personal account, disconnect or reconcile an org-owned one.
    // One of the app's own scopes; default `<app>:accounts:admin`.
    adminScope: { type: "string", minLength: 3 },
    authorizationUrl: { type: "string" },
    tokenUrl: { type: "string" },
    userinfoUrl: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    // Scopes the provider grants only once it approved the app (Shopify's
    // `read_all_orders`). Never in `scopes` nor the generated provider app
    // configuration; the authorize request asks for one when the org turned on
    // `setting` (an org settings toggle of the app) or the account being
    // re-authorized already holds it (connections/protected-scopes.ts).
    // Scopes of `scopes` Google allows a client only once verified for restricted
    // scopes (Drive's `drive.readonly`): dropped from the authorize request when
    // this client may not ask this person for them (connections/restricted-scopes.ts).
    restrictedScopes: { type: "array", items: { type: "string" } },
    // The provider grants the scopes of the provider app's released configuration,
    // whatever the authorize request asks for (Shopify-managed installation): a scope
    // missing from a grant is added to that configuration and released before a
    // reconnect can grant it (connections/attention.ts says so).
    scopesFromAppConfiguration: { type: "boolean" },
    protectedScopes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: { type: "string", minLength: 1 },
          setting: { type: "string", minLength: 1 },
        },
        required: ["scope", "setting"],
        additionalProperties: false,
      },
    },
    extraParams: { type: "object", additionalProperties: { type: "string" } },
    // Authorize parameters whose value is a per-deployment app setting, keyed by
    // parameter name: `{ config_id: { configKey, pattern } }`. The value is read
    // from the app's config (a key declared in `configKeys`) and must match the
    // anchored `pattern`; missing or wrong, the start is refused
    // (connections/oauth-manifest-knobs.ts).
    authorizeConfigParams: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          configKey: { type: "string", minLength: 1 },
          pattern: { type: "string", minLength: 2 },
        },
        required: ["configKey", "pattern"],
        additionalProperties: false,
      },
    },
    // OAuth2 provider-quirk knobs (optional; defaults preserve standard behaviour).
    // For providers like Meta Instagram Business Login that diverge from OIDC.
    scopeSeparator: { type: "string" },
    usePkce: { type: "boolean" },
    longLivedTokenUrl: { type: "string" },
    longLivedTokenGrantType: { type: "string" },
    longLivedTokenParamName: { type: "string" },
    longLivedIncludeClientId: { type: "boolean" },
    identifierFromTokenField: { type: "string" },
    identifierFromUserinfoField: { type: "string" },
    // The identifier at a dotted path of the `userinfoUrl` response (`data[].id`,
    // `[]` maps over an array) for a sign-in that can cover several accounts;
    // several are never picked from silently (connections/oauth-manifest-knobs.ts).
    identifierFromUserinfoPath: { type: "string", minLength: 1 },
    // The field beside the id at that path naming the account (`username`).
    accountNameField: { type: "string", minLength: 1 },
    grantedScopesUrl: { type: "string" },
    // Meta's debug_token: the token's real expiry (app-registries.ts tokenDebugUrl).
    tokenDebugUrl: { type: "string" },
    displayNameUrl: { type: "string" },
    displayNameFields: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    refreshTokenUrl: { type: "string" },
    // RFC 7009 token revocation endpoint, called on disconnect and erasure.
    revocationUrl: { type: "string" },
    // Called (POST, the connection's bearer token) on removal, before the revocation,
    // to end a push watch at the provider: Gmail's users.stop.
    watchStopUrl: { type: "string" },
    // One provider account may be connected BOTH for the organization and as a
    // member's own, as two rows reading disjoint data (app-registries.ts).
    orgAndPersonalCoexist: { type: "boolean" },
    // Export name of the handler run before a disconnect, while the token is valid.
    beforeDisconnect: { type: "string", minLength: 1 },
    refreshGrantType: { type: "string" },
    refreshUsesAccessToken: { type: "boolean" },
    refreshWindowMs: { type: "number" },
    credentialFields: { type: "array", items: credentialFieldSchema },
    // Credentials only: several org-owned accounts per org, each keyed by its
    // slug identifier (the credentials route then requires `identifier`).
    multiInstance: { type: "boolean" },
    allowedDomains: { type: "array", items: { type: "string" } },
    // Per-template-variable normalization rules (e.g. `{shop}` for per-store
    // providers). The kernel applies these generically during the OAuth flow.
    templateVars: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          lowercase: { type: "boolean" },
          pattern: { type: "string" },
          appendSuffix: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    // Template variable whose normalized value is the connection identifier.
    identifierVar: { type: "string" },
    // How the provider signs its OAuth callback, verified with the client secret
    // before the code is exchanged. `hmac-sha256-query`: an `hmac` parameter, the
    // hex HMAC-SHA256 of the other parameters sorted and joined `k=v&...`
    // (Shopify).
    callbackSignature: { type: "string", enum: ["hmac-sha256-query"] },
    // apps.config key to mirror the OAuth client secret into after connect
    // (e.g. for webhook HMAC verification by the app's sandboxed code).
    clientSecretConfigKey: { type: "string" },
    // apps.config key the kernel mints a random webhook-signing secret into when
    // a CREDENTIALS connection is established (no OAuth client secret to mirror).
    // The connect handler reads it via `ctx.config.get` to forward to the
    // provider's subscription API; the sandboxed verifier reads the same value
    // via `bridge.config_get`. One minted value, two read paths, no write bridge.
    webhookSecretConfigKey: { type: "string" },
    // apps.config keys holding a secret the PROVIDER mints and the app hands to the kernel once
    // (e.g. a webhook signing secret returned by the provider's subscription API). Written only
    // through `ctx.config.setSecret(key, value)`, encrypted at rest, readable by the app's own
    // verifier and handlers through `config_get`, never logged.
    appSecretConfigKeys: {
      type: "array",
      items: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" },
    },
    // Operator-facing "how to connect" guide, surfaced in the UI next to the
    // connect form (the `?` popover), `liaison guide` and the setup reference.
    // Ships + versions with the app manifest. A step is a string (a HUMAN step,
    // markdown; the frontend sanitises before rendering) or the structured form
    // { who, text, url?, place?, minutes?, values? } (connection-setup.ts SetupStep).
    setupGuide: {
      type: "object",
      properties: {
        summary: { type: "string" },
        steps: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  who: { enum: ["human", "agent"] },
                  text: { type: "string", minLength: 1 },
                  url: { type: "string", pattern: "^https://" },
                  place: { enum: ["liaison", "own"] },
                  minutes: { type: "number", minimum: 0 },
                  values: { type: "array", items: { type: "string" } },
                },
                required: ["who", "text"],
                additionalProperties: false,
              },
            ],
          },
        },
        docsUrl: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: ["type", "allowedDomains"],
  if: { properties: { type: { const: "oauth2" } }, required: ["type"] },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
  then: {
    required: ["authorizationUrl", "tokenUrl", "allowedDomains"],
    properties: {
      allowedDomains: { type: "array", items: { type: "string" }, minItems: 1 },
      // One account per (org, owner) for OAuth: multiInstance is credentials-only.
      multiInstance: { const: false },
    },
  },
  else: {
    if: { properties: { type: { const: "credentials" } }, required: ["type"] },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
    then: { required: ["credentialFields", "allowedDomains"] },
  },
}

const toolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    params: { type: "object" },
    // Every scope the tool requires; the actor must hold each one.
    requiredScopes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    // Scope taint (modules/agent/scopes/scope-taint.ts): the schema-qualified table this
    // tool writes (`app_<name>.<table>`, the app's own schema only; the runtime
    // drops any other), or `readOnly` for a tool that writes nothing (honoured for
    // trusted apps, and for sandboxed apps the platform vouches for as first-party,
    // never on the manifest's own say). A tool with neither is refused on a tainted turn.
    writesToTable: { type: "string", pattern: "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$" },
    // The scope every reader of `writesToTable` must hold (scope-taint.ts, consequence 4):
    // a tainted write to it runs only when every holder of this scope holds what the turn
    // read. The app's own scope namespace only, and honoured only where `readOnly` is.
    sinkReadScope: { type: "string", pattern: "^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)+$" },
    // Same-resource allowance (A46): the table a READ tool's rows come from, and the
    // parameter naming the row a call targets. Same app-own-schema rule as
    // `writesToTable`; the runtime drops a declaration naming another app's schema.
    readsFromTable: { type: "string", pattern: "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$" },
    targetRowParam: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    // A46b: where the row ids live in a READ tool's RESULT, a dot path walked through
    // arrays. Only the rows a read RETURNED become taint origins, so a tool whose
    // result does not carry a top-level `id` names its path here.
    resultRowPath: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$",
    },
    readOnly: { type: "boolean" },
    handler: {},
    preflight: { type: "string" },
    // The params the preflight pins (server values the approval binds). See
    // app-registries.ts `pinnedParams`.
    // A top-level param name: never a dotted path.
    pinnedParams: { type: "array", items: { type: "string", minLength: 1, pattern: "^[^.]+$" } },
    // The params carrying text a person outside the org reads; an unfilled placeholder there
    // ("[DATE]", "{{name}}", "TBD") is refused before any gate (outbound-placeholders.ts).
    // app-registries.ts `outboundTextParams`. Top-level param names.
    outboundTextParams: {
      type: "array",
      items: { type: "string", minLength: 1, pattern: "^[^.]+$" },
    },
    summarizer: { type: "string" },
    // Declarative hydration for the approval summary: before running the
    // summarizer, the kernel executes this UNGATED read tool of the SAME app
    // (standard executeTool path: RLS, scopes, sandbox) and passes its result
    // to the summarizer as a `meta.context` extra arg. `params` maps the read
    // tool's params from the gated call's params by dot-path. This is how a
    // fulfillment approval shows the order number, customer, and line items
    // without granting the summarizer any live bridge access.
    summarizerContext: {
      type: "object",
      properties: {
        tool: { type: "string" },
        params: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["tool", "params"],
      additionalProperties: false,
    },
    gated: { type: "boolean" },
    // Marks a tool that gates CONDITIONALLY inside its handler (via
    // `ctx.requestApproval`) rather than declaratively. Such a tool keeps
    // `gated` unset/false (so it does not gate unconditionally) but may still
    // declare `editableFields` for the approval it parks (see contract.ts).
    conditionalGate: { type: "boolean" },
    // Blast-radius classification for a GATED tool's approval, surfaced on the
    // attention feed so an operator can triage at a glance. "external" = the
    // action's effect leaves the org or is customer/world-visible (send an
    // email, reply to a customer ticket, post publicly, create a refund/
    // shipment/invoice sent to a customer, spend money). "internal" =
    // org-internal and reversible (close/reopen a ticket, set a label/
    // category/priority, an internal note). Undeclared gated tools are treated
    // as "external" downstream — fail-safe: nothing risky may read as safe.
    approvalImpact: { type: "string", enum: ["external", "internal"] },
    deferLoading: { type: "boolean" },
    // Words people use for what the tool does, single words, in any language: read
    // only by the `tool_search` ranker, never sent to a model.
    searchKeywords: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 40, pattern: "^\\S+$" },
      maxItems: 30,
    },
    agentVisible: { type: "boolean" },
    trustBoundary: { type: "string", enum: ["internal", "agent", "user"] },
    // A provider-contract op (see top-level `implements`): reachable ONLY through the kernel
    // contract dispatch (`ctx.contracts.call`), never directly by a user, an agent or an app.
    contractOnly: { type: "boolean" },
    // A gated tool no auto-approve policy and no capability arm may wave through: only a human
    // approval or a direct UI click by an approver runs it (outbound legal actions).
    noAutoApprove: { type: "boolean" },
    instructions: { type: "string" },
    taintSource: { type: "boolean" },
    externalEffect: { type: "boolean" },
    retryOnTransientDbError: { type: "boolean" },
    // Sandbox execution budget for one run of this tool handler (mirrors the
    // jobs-level timeoutMs). For read tools that fan out many cross-app calls
    // (e.g. a worklist resolving one draft per invoice), the prod default
    // (5s) is too tight while the work is legitimate and bounded. Capped well
    // below the jobs ceiling: an interactive tool must never hold a worker for
    // minutes.
    timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
    // Bridge-owned transactions escape hatch: keeps the tool's whole handler
    // run inside ONE ambient RLS transaction (the pre-session legacy
    // contract) instead of per-call bridge transactions. See runtime.ts
    // (~line 1128) and executeToolHandler in execute-tool.ts.
    atomic: { type: "boolean" },
    approvalCard: { type: "object", properties: { pill: LABEL_SCHEMA } },
    // Shape only here; the deep rules for a result card arrive with the card resolver.
    resultCard: { type: "object" },
    // The line shown while the tool runs ("Reading subscriptions"), and its catalog key.
    runningLabel: { type: "string", minLength: 1 },
    runningLabelKey: { type: "string", minLength: 1 },
    // A call that chains `@ref` tokens stages unpinned and the handler builds the pinned
    // value at execute. Needs `pinnedParams` (checked by the `then` below).
    pinnedOptionalOnRefs: { type: "boolean" },
    // First-party only (the runtime copies them for a vouched app alone): what the tool writes
    // is read only by the person writing it, and the params through which a call carries the turn.
    sinkReadersSelf: { type: "boolean" },
    contentParams: { type: "array", items: { type: "string", minLength: 1 } },
    // Names a feature the app declares under top-level `features`.
    feature: { type: "string", minLength: 1 },
    // Loaded with the app on a hard focus: always (`true`), or when the focus verified that
    // entity type (a string).
    focusCore: { oneOf: [{ type: "boolean" }, { type: "string", minLength: 1 }] },
    // Narrows `taintSource` to the rows that match: a field of the row read and the value
    // that makes it outside text.
    taintSourceWhen: {
      type: "object",
      properties: {
        field: { type: "string", minLength: 1 },
        equals: { type: ["string", "number", "boolean"] },
      },
      required: ["field", "equals"],
      additionalProperties: false,
    },
    // On a tool with `agentVisible: false`: the visible tool of the same app to use instead.
    useInstead: { type: "string", minLength: 1 },
    approvalExpiryHours: { type: "integer", minimum: 1, maximum: 720 },
    // Opt-in idempotency for a GATED tool: names a single param whose value
    // uniquely identifies the action being staged (e.g. boxtal:create_shipment's
    // `draft_id`). When set, staging a second approval for the SAME (org, tool,
    // key-value) while a prior one is still PENDING (not yet decided) returns that
    // existing pending approval's blocked envelope INSTEAD of creating a duplicate.
    // This makes a re-stage (e.g. after a carrier correction, or a transient
    // retry) idempotent — one pending approval per keyed action — so the human
    // never sees two pending create_shipments for the same order. Unset = today's
    // behavior (every gated call stages a fresh approval).
    approvalDedupeKeyParam: { type: "string" },
    // Only with approvalDedupeKeyParam: restrict the dedupe to a pending
    // approval staged by the SAME requester (person, acting agent, routine).
    // A pending approval anyone else staged for the key is never restaged.
    approvalDedupeSameRequester: { type: "boolean" },
    // Async-output polling for a GATED tool whose side effect completes
    // synchronously but whose OUTPUTS materialize later (e.g. a carrier order
    // whose label PDF generates asynchronously). Names a bundle export the
    // kernel invokes on the approval-poll schedule with
    // `{ external_ref }` (the ref the handler recorded via
    // ctx.approval_recordAwaitingOutput); the export returns
    // `{ ready: false }` or `{ ready: true, result: {...full outputs...} }`.
    // When ready, the decided result is updated and the sequence cascade
    // resumes — deferred dependents referencing `@ref` outputs execute with
    // the materialized values instead of failing on a null.
    pollHandler: { type: "string", minLength: 1 },
    // Declarative resource-owner resolution for a GATED tool (privacy routing).
    // Declares that this call targets a row of the app's own `table` (id taken
    // from the tool param named `param`) whose owning account may be PERSONAL
    // (owner_type='user'). Optional `account` hops one level: `column` on the
    // target row references the account table carrying the effective
    // `visibility`. When the resolved account is personal, the approval is
    // routed to the OWNER alone (never the org-wide approver set) and the
    // owner may decide it without holding `<app>:approve`.
    // The `requester` form covers a call that CREATES a personal resource (no
    // row exists yet to look up): when the named param equals the given value,
    // the requesting user is the owner, e.g. mcp-manager `add_connection` with
    // `ownershipScope: "personal"`.
    resourceOwner: {
      anyOf: [
        {
          type: "object",
          properties: {
            table: { type: "string", minLength: 1 },
            param: { type: "string", minLength: 1 },
            account: {
              type: "object",
              properties: {
                table: { type: "string", minLength: 1 },
                column: { type: "string", minLength: 1 },
              },
              required: ["table", "column"],
              additionalProperties: false,
            },
          },
          required: ["table", "param"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            requester: {
              type: "object",
              properties: {
                param: { type: "string", minLength: 1 },
                equals: { type: "string", minLength: 1 },
              },
              required: ["param", "equals"],
              additionalProperties: false,
            },
          },
          required: ["requester"],
          additionalProperties: false,
        },
      ],
    },
    editableFields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          label: { type: "string" },
          // Phase 16 Task A5 — widget enum widened. `checkbox` toggles a single
          // boolean param. `checkbox-per-line` requires `listSource` to dot-path
          // to an array of items in the original params; the UI renders one
          // checkbox per item and the edit revision is keyed by item id.
          // `key-value-list` exposes editing a Record<string,string>.
          // `email-list` edits a recipient array (mail to/cc/bcc) before approving a send.
          widget: {
            type: "string",
            enum: [
              "text",
              "richtext",
              "checkbox",
              "checkbox-per-line",
              "key-value-list",
              "email-list",
            ],
          },
          listSource: { type: "string" },
          // Derived payload keys blanked when this field is edited (e.g. a
          // pre-rendered `htmlBody` derived from `textBody`) so the executed
          // handler regenerates them from the edited value instead of sending
          // the stale copy. Cross-field constraints (keys exist in params, no
          // self-reference) are enforced in contract.ts.
          invalidates: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["field", "label", "widget"],
        additionalProperties: false,
      },
    },
    returns: {
      type: "object",
      properties: {
        schema: { type: "object", additionalProperties: { type: "string" } },
        dimensions: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  },
  required: ["description", "handler", "requiredScopes"],
  // The retired single `scope` key; validateAppManifest names it before this runs.
  not: { required: ["scope"] },
  if: { required: ["pinnedOptionalOnRefs"] },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
  then: { required: ["pinnedParams"] },
}

export const appManifestJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: NAME_PATTERN },
    version: { type: "string", pattern: SEMVER_PATTERN },
    trusted: { type: "boolean" },
    rlsManagedBy: { type: "string", enum: ["migration"] },
    description: { type: "string" },
    // Tools that add a short block about the entity in view to the agent's context.
    contextProviders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          on: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          tool: { type: "string", minLength: 1 },
          scope: { type: "string", minLength: 1 },
          loadTools: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["on", "tool", "scope"],
        additionalProperties: false,
      },
    },
    // Per kind of outbound message, the read-only tool that can stop it before it leaves.
    sendGuardProviders: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          tool: { type: "string", minLength: 1 },
          serviceMessage: { type: "boolean" },
          pill: LABEL_SCHEMA,
        },
        required: ["tool"],
        additionalProperties: false,
      },
    },
    // Per-org switchable features; a tool, slot panel or tab type names one with `feature`.
    features: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          adminScope: { type: "string", minLength: 1 },
          labelKey: { type: "string", minLength: 1 },
          offMessageKey: { type: "string", minLength: 1 },
          offNextKey: { type: "string", minLength: 1 },
        },
        required: ["adminScope", "labelKey"],
        additionalProperties: false,
      },
    },
    // Fields of this app's data that a person outside the org can set.
    outsideTextFields: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
    // Entity type to the read-only tool that says who an approval for it is for.
    approvalRoute: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    agentInstructions: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            core: { type: "string", minLength: 1 },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tools: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
                  text: { type: "string", minLength: 1 },
                },
                required: ["tools", "text"],
                additionalProperties: false,
              },
            },
          },
          required: ["core"],
          additionalProperties: false,
        },
      ],
    },
    // ── Distribution metadata (`.liaisonapp` package format) ──
    // These are optional for bundled in-tree apps and required (enforced by
    // packageManifestSchema in @liaison/app-sdk) for installed third-party apps.
    // Declared here so an in-tree app dir that also ships these fields still
    // validates against the runtime manifest schema (additionalProperties: false).
    packageFormat: { type: "integer", minimum: 1 },
    license: { type: "string", minLength: 1 },
    // The host API range the app needs ("^1" when absent): checked against
    // this server's host API version at install, upgrade and registration.
    host: { type: "string", minLength: 1 },
    // A security release: once this version is active, a rollback never goes
    // below it. Honoured for first-party (catalog) packages only (activation.ts).
    noRollback: { type: "boolean" },
    // Ignored: accepted so packages built before the host range still validate.
    sdkVersion: { type: "string", minLength: 1 },
    minLiaisonVersion: { type: "string", minLength: 1 },
    author: { type: "string", minLength: 1 },
    homepage: { type: "string", minLength: 1 },
    updateUrl: { type: "string", minLength: 1 },
    displayName: { type: "string", minLength: 1 },
    // The app's icon as data, never code (S1): SVG markup (at most 8 KB, plain
    // drawing elements only, checked by validateAppManifest) or the name of an
    // icon in Liaison's icon set. `views.activityBar.icon` stays the export name.
    iconSvg: { type: "string", minLength: 1, maxLength: 8192 },
    iconName: { type: "string", minLength: 1 },
    // Extra bare routes that open the app at its default page, beside `/<name>`
    // and the rail label's slug. A path here names the APP, not one of its
    // pages, and the first app to claim one keeps it.
    routes: {
      type: "array",
      items: { type: "string", pattern: "^/[a-z0-9][a-z0-9/-]*$" },
    },
    // Declared scopes the app requests — surfaced in the install-grant UX.
    // For in-tree apps this is informational (scopes are derived from tools);
    // for `.liaisonapp` packages it is the canonical grant list.
    scopes: { type: "array", items: { type: "string" } },
    // Platform capabilities the app declares — gates RPC bridge methods that
    // touch shared kernel infrastructure (agent runtime, Redis pub/sub). Each
    // capability is enforced at the bridge call site via requireCapability().
    capabilities: {
      type: "array",
      items: { type: "string", enum: [...KNOWN_CAPABILITIES] },
      uniqueItems: true,
    },
    dependencies: {
      type: "object",
      properties: {
        required: { type: "array", items: { type: "string" } },
        optional: { type: "array", items: { type: "string" } },
        tools: {
          type: "array",
          items: { type: "string", pattern: TOOL_DEPENDENCY_PATTERN },
        },
      },
    },
    schema: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          fields: { type: "object", additionalProperties: fieldDefSchema },
          // Logical RLS scope-entity alias. When set, the table's generated RLS
          // gates on `<app>:<rlsScope>:<op>` instead of `<app>:<tableName>:<op>`,
          // so a physical table can be reached by a coarser grantable scope
          // (e.g. document_lines → documents, issuer_profiles → settings).
          rlsScope: { type: "string", minLength: 1 },
          // An EXTRA full scope grant (e.g. `social:internal`) that ALSO satisfies the
          // table's WRITE (UPDATE/INSERT/DELETE) RLS policies — for a table whose UNGATED
          // INTERNAL-mutation tools are scoped on a DIFFERENT family than its `rlsScope`.
          // Example: social `finding` has rlsScope `findings` (so reads/gated writes gate
          // on `social:findings:*`) but its set_triage / dismiss_finding internal writes
          // are scoped `social:internal`; declaring internalWriteScope:"social:internal"
          // lets an internal-scope-only context (a triage-only routine ceiling) write the
          // triage metadata instead of its UPDATE being silently RLS-denied (0 rows, no
          // error). READ policy is unaffected.
          internalWriteScope: { type: "string", minLength: 1 },
          // The table's real access is granted by PERMISSIVE policies a SQL
          // migration owns (OR-ed with the generated ones), e.g. a draft visible
          // to its author only. Changes no policy: it tells the registration's
          // scope-reachability check to verify those migration policies exist
          // instead of judging the generated policy alone (see
          // rls-generator.migrationGovernedTables).
          rlsGovernedByMigration: { type: "boolean" },
          // Columns a migration owns on purpose and the manifest does not
          // declare (sharing-model columns RLS reads, generated columns): the
          // registration's drift check does not report them.
          migrationOwnedColumns: { type: "array", items: { type: "string", minLength: 1 } },
          // Personal-visibility RLS restriction. A table declaring this gets an
          // EXTRA AND-condition on every generated policy: rows belonging to a
          // PERSONAL account (effective visibility 'personal': explicit
          // `visibility` column, else owner_type='user') are visible/writable
          // ONLY when app.current_user_id equals the account owner. Broad
          // scopes ('*', '<app>:*') and dimension wildcards no longer pierce
          // personal rows. Self form: {} (the table itself is the account,
          // must carry owner_type/owner_id and optionally visibility). Via
          // form: { via: { table, localColumn } } joins one hop to the account
          // table through the row's `localColumn`.
          personalScope: {
            type: "object",
            properties: {
              via: {
                type: "object",
                properties: {
                  table: { type: "string", minLength: 1 },
                  localColumn: { type: "string", minLength: 1 },
                },
                required: ["table", "localColumn"],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          dimensions: { type: "object", additionalProperties: dimensionDefSchema },
          triggers: triggerDefSchema,
          // Legal records: rows are write-once and neither they nor their files can be deleted
          // within `retentionYears` of `anchor` (default created_at). Kernel-enforced.
          immutable: {
            type: "object",
            properties: {
              retentionYears: { type: "integer", minimum: 1, maximum: 100 },
              anchor: { type: "string", pattern: "^[a-z_][a-z0-9_]*$" },
              // Only these columns are write-once (others may advance, e.g. a ledger row's state).
              writeOnceColumns: {
                type: "array",
                minItems: 1,
                items: { type: "string", pattern: "^[a-z_][a-z0-9_]*$" },
              },
            },
            required: ["retentionYears"],
            additionalProperties: false,
          },
          // Legal records kept in the encrypted legal-retention archive when the org
          // is deleted (modules/org/delete/legal-archive.ts), whether or not the
          // table is `immutable` (immutable tables always are, every row).
          // `true`: every row. An object selects rows: `where` (each listed
          // column holds one of its values, compared as text; columns ANDed)
          // and/or `parent` (rows whose `column` names the `id` of a kept row of
          // another marked table of this app).
          legalRetention: {
            anyOf: [
              { type: "boolean" },
              {
                type: "object",
                properties: {
                  where: {
                    type: "object",
                    minProperties: 1,
                    additionalProperties: {
                      type: "object",
                      properties: {
                        in: {
                          type: "array",
                          minItems: 1,
                          items: { type: ["string", "number", "boolean"] },
                        },
                      },
                      required: ["in"],
                      additionalProperties: false,
                    },
                  },
                  parent: {
                    type: "object",
                    properties: {
                      table: { type: "string", minLength: 1 },
                      column: { type: "string", minLength: 1 },
                    },
                    required: ["table", "column"],
                    additionalProperties: false,
                  },
                },
                minProperties: 1,
                additionalProperties: false,
              },
            ],
          },
          timeline: { type: "array", items: { type: "string" } },
          searchable: { type: "array", items: { type: "string" } },
          constraints: {
            type: "object",
            properties: {
              unique: {
                type: "array",
                items: {
                  oneOf: [
                    {
                      type: "array",
                      items: { type: "string" },
                      minItems: 1,
                    },
                    {
                      type: "object",
                      properties: {
                        columns: {
                          type: "array",
                          items: { type: "string" },
                          minItems: 0,
                        },
                        where: whereClauseSchema,
                      },
                      required: ["columns", "where"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
          indexes: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                },
                {
                  type: "object",
                  properties: {
                    columns: {
                      type: "array",
                      items: { type: "string" },
                      minItems: 1,
                    },
                    where: whereClauseSchema,
                  },
                  required: ["columns", "where"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
    },
    tools: { type: "object", additionalProperties: toolSchema },
    events: {
      type: "object",
      properties: {
        emits: { type: "array", items: { type: "string", pattern: EVENT_PATTERN } },
        subscribes: { type: "object" },
      },
    },
    jobs: {
      type: "object",
      patternProperties: {
        ".*": {
          type: "object",
          properties: {
            schedule: { type: "string" },
            handler: { type: "string" },
            onDemand: { type: "boolean" },
            // Sandbox execution budget for one run of this job handler. Jobs
            // that drain a bounded batch (e.g. invoicing deferred-retry) set a
            // generous ceiling above the 60s default so a large-but-bounded
            // sweep always finishes inside it. Falls back to 60_000 in runtime.
            timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
            // Which orgs a scheduled run is for: { everyOrg } | { connection?, rows? }
            // (infra/jobs/fanout-runs-for.ts, which validates its shape).
            runsFor: { type: "object" },
            retry: {
              type: "object",
              properties: {
                attempts: { type: "number" },
                backoff: { type: "string", enum: ["exponential", "fixed"] },
              },
            },
          },
          required: ["handler"],
        },
      },
    },
    webhooks: {
      type: "object",
      patternProperties: {
        [WEBHOOK_NAME_PATTERN]: {
          type: "object",
          properties: {
            handler: { type: "string" },
            verify: { type: "string" },
            bodyLimitBytes: {
              type: "integer",
              minimum: 1024,
              maximum: 10 * 1024 * 1024,
            },
            // Sandbox budget for one run of this handler, like a tool's: a handler that makes
            // several provider calls (a payment) outlives the prod default of 5 s. At most 29 s:
            // a provider is waiting, within the 30 s request ceiling (webhooks/manifest-execution.ts).
            timeoutMs: { type: "integer", minimum: 1000, maximum: 29000 },
          },
          required: ["handler", "verify"],
        },
      },
    },
    // Required on an app that declares webhooks (cross-field rule in contract.ts):
    // how the kernel judges whether the stream is still landing
    // (modules/webhooks/ingest-health.ts). Either `{ probe: "<job>" }`, a scheduled
    // job returning `{ upstreamActivityAt: ISO | null }` (or `{ probed: false,
    // reason }` when it could not ask), or `{ probe: null, reason }` saying why no
    // upstream can be queried; such an app is then judged by rejections only.
    webhookHealth: {
      type: "object",
      properties: {
        probe: {},
        reason: { type: "string" },
        // How long after the change the probe reports a delivery may still be in
        // flight before it counts as missed (default 1800). For a sender that
        // delivers late; only with a probe.
        deliveryGraceSec: { type: "integer", minimum: 60, maximum: 86400 },
      },
      required: ["probe"],
      additionalProperties: false,
    },
    entities: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          labelField: { type: "string" },
          handlePrefix: { type: "string" },
          searchable: { type: "boolean" },
          mentionable: { type: "boolean" },
          // One conversation per row, with visibility derived from the row. Needs a label
          // field and a page.
          discussion: { type: "boolean" },
          tableName: { type: "string" },
          readScope: { type: "string" },
          cardComponent: { type: "string" },
          // Phase 16 — entity lives in an external system (e.g. Shopify orders).
          // No local schema entry required; cross-field `entity_schema_mismatch`
          // check in contract.ts skips these.
          external: { type: "boolean" },
          // Soft-delete marker column (e.g. "archived_at"). A row whose value
          // here is non-null is not index-eligible: the incremental indexer
          // deletes it, the full reindex skips (and so prunes) it, and the
          // direct-DB mention fallback filters it out. Without it an archived
          // row re-enters search on the next reindex or upsert event.
          archivedField: { type: "string" },
          indexFields: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              // More text for the body: columns of the entity's own row, or one key of a JSON
              // column as "column.key". Names reach no SQL (the row is already read), but are held
              // to the identifier shape anyway.
              bodyFields: {
                type: "array",
                maxItems: 16,
                items: {
                  type: "string",
                  pattern: "^[a-z_][a-z0-9_]{0,62}(\\.[a-z_][a-z0-9_]{0,62})?$",
                },
              },
              // More text for the body from CHILD rows of the same app schema: the rows of
              // `tableName` whose `foreignKey` is this row's id (an invoice's lines). The names
              // reach SQL as identifiers, so they are held to one shape.
              bodyFrom: {
                type: "object",
                properties: {
                  tableName: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  foreignKey: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  columns: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  },
                },
                required: ["tableName", "foreignKey", "columns"],
                additionalProperties: false,
              },
              handle: { type: "string" },
              labelSecondary: { type: "string" },
              // The second line from a related row of the same app schema. The
              // names reach SQL as identifiers, so they are held to one shape.
              labelSecondaryFrom: {
                type: "object",
                properties: {
                  tableName: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  foreignKey: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  columns: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" },
                  },
                },
                required: ["tableName", "foreignKey", "columns"],
                additionalProperties: false,
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
          permissionFields: {
            type: "object",
            properties: {
              readScope: { type: "string" },
              participantIdsField: { type: "string" },
              dimensionFields: { type: "array", items: { type: "string" } },
              // Generic ACL search primitive (mirrors participant_ids): three
              // denormalized columns the search indexer reads to build a
              // MeiliSearch filter equivalent to a Drive-style sharing RLS
              // policy — org-wide + per-user + per-role ACL. App-agnostic:
              // field names are declared here, not hardcoded in the indexer.
              aclFields: {
                type: "object",
                properties: {
                  orgWideField: { type: "string" },
                  userIdsField: { type: "string" },
                  roleIdsField: { type: "string" },
                },
                required: ["orgWideField", "userIdsField", "roleIdsField"],
                additionalProperties: false,
              },
            },
            required: ["readScope"],
            additionalProperties: false,
          },
          fileParent: {
            type: "object",
            properties: {
              tableName: { type: "string" },
              schemaRef: { type: "string" },
              joinOn: { type: "string" },
              readScope: { type: "string" },
              writeScope: { type: "string" },
              // Who may delete a file on this parent: its uploader, or a holder
              // of this scope (both also need writeScope). Absent: writeScope.
              deleteScope: { type: "string" },
            },
            required: ["tableName", "schemaRef", "joinOn", "readScope", "writeScope"],
            additionalProperties: false,
          },
          // The entity prints through the org's document templates
          // (modules/documents/print.ts). `recordTool` is this app's own
          // readOnly, ungated tool returning the record as JSON, called with
          // `{ [idParam]: <record id> }` under the caller's authorization;
          // `fields` are the record's paths a template may map (a field with
          // `repeat` is one per row of the list at that path, mapped as
          // `<repeat>.<n>.<rest>`). Printed files land on this entity's
          // fileParent. Cross-field rules: contract.ts printDeclarationErrors.
          print: {
            type: "object",
            properties: {
              recordTool: { type: "string", minLength: 1 },
              idParam: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
              label: { type: "string", minLength: 1, maxLength: 200 },
              fields: {
                type: "array",
                maxItems: 500,
                items: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      maxLength: 500,
                      pattern: "^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$",
                    },
                    label: { type: "string", minLength: 1, maxLength: 200 },
                    type: { type: "string", enum: ["string", "number", "boolean", "date"] },
                    repeat: {
                      type: "string",
                      maxLength: 500,
                      pattern: "^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$",
                    },
                  },
                  required: ["path", "label", "type"],
                  additionalProperties: false,
                },
              },
            },
            required: ["recordTool", "idParam", "label", "fields"],
            additionalProperties: false,
          },
        },
        required: ["labelField"],
        additionalProperties: false,
      },
    },
    attention: {
      type: "object",
      properties: {
        // Phase 16 Task A3 — declared axes (e.g. "market", "currency") that
        // appear in event metadata and that subscription rules may filter on.
        // Additive: existing manifests without `filterableAxes` remain valid.
        filterableAxes: {
          type: "array",
          items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          uniqueItems: true,
        },
        // The heading over this app's attention items.
        groupLabel: LABEL_SCHEMA,
        translations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              // The words for the item, and their catalog key.
              label: { type: "string", minLength: 1 },
              labelKey: { type: "string", minLength: 1 },
              event: { type: "string", pattern: EVENT_PATTERN },
              // Phase 16 Task A3 — `kind` is either a core enum entry or an
              // `<appName>:<dotted.kind>` form (the app-namespaced extension).
              kind: {
                oneOf: [
                  {
                    type: "string",
                    enum: [
                      "sla_risk",
                      "awaiting_agent",
                      "unassigned",
                      "nudge_due",
                      "followup_due",
                      "admin_action",
                      "task_overdue",
                      "task_due_this_week",
                      "task_blocked",
                      "approval_pending",
                      "mention",
                      "thread_reply",
                      "thread_followup",
                      "approval_decision",
                      "system_alert",
                      "file_shared",
                    ],
                  },
                  {
                    type: "string",
                    pattern: "^[a-z][a-z0-9_-]*:[a-zA-Z][a-zA-Z0-9_.]*$",
                  },
                ],
              },
              urgency: { type: "integer", minimum: 0, maximum: 100 },
              isUrgent: { type: "boolean" },
              summary: { type: "string", minLength: 1 },
              when: { type: "object" },
              // The event RESOLVES (marks read) the matching attention row
              // instead of upserting one. Two forms:
              //   { field, equals } — conditional: resolves when
              //     event.data[field] === equals (e.g. an unfulfilled digest
              //     whose count reached 0).
              //   { always: true }  — unconditional: the event's very existence
              //     means the tracked condition is over (e.g. order:fulfilled
              //     resolves the order:created row). Most real resolutions are
              //     this shape, and without it an app had to invent a constant
              //     payload field to compare against.
              resolveWhen: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      field: { type: "string", minLength: 1 },
                      equals: { type: ["string", "number", "boolean"] },
                    },
                    required: ["field", "equals"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: { always: { const: true } },
                    required: ["always"],
                    additionalProperties: false,
                  },
                ],
              },
              recipients: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      kind: { const: "field" },
                      path: { type: "string", minLength: 1 },
                    },
                    required: ["kind", "path"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "participants" },
                      path: { type: "string", minLength: 1 },
                      excludeActor: { type: "boolean" },
                    },
                    required: ["kind", "path"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "scope_holders" },
                      scope: { type: "string", minLength: 1 },
                      dimensionFilter: { type: "object" },
                      excludeActor: { type: "boolean" },
                    },
                    required: ["kind", "scope"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "mentions" },
                      path: { type: "string", minLength: 1 },
                    },
                    required: ["kind", "path"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "actor" },
                    },
                    required: ["kind"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["event", "kind", "urgency", "summary", "recipients"],
            additionalProperties: false,
          },
        },
      },
      required: ["translations"],
      additionalProperties: false,
    },
    // Phase 16 Task A3 — manifest-declared external-search handler. The kernel
    // search service auto-registers a sandbox-bridged handler when this block
    // is present (Task A4 wires the registration).
    search: {
      type: "object",
      properties: {
        handler: { type: "string", minLength: 1 },
        entities: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
        timeoutMs: { type: "integer", minimum: 100, maximum: 10000, default: 5000 },
      },
      required: ["handler", "entities"],
      additionalProperties: false,
    },
    skills: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          description: { type: "string", minLength: 1, maxLength: 100 },
          body: { type: "string", minLength: 1 },
          requiredScopes: {
            type: "array",
            items: { type: "string" },
          },
          kind: { type: "string", enum: ["playbook", "guide"] },
          enabledByDefault: { type: "boolean" },
          // Author-declared trigger vocabulary, same shape + normalization as
          // `kernel.skills.auto_attach` (DB skills). Optional: a skill that
          // declares nothing behaves exactly as before. See
          // parseAutoAttachKeywords/parseAutoAttachApps in skills-routines-tools.ts.
          autoAttach: {
            type: "object",
            properties: {
              keywords: { type: "array", items: { type: "string", minLength: 2 } },
              apps: { type: "array", items: { type: "string", minLength: 1 } },
            },
            additionalProperties: false,
          },
        },
        required: ["description", "body"],
        additionalProperties: false,
      },
    },
    agents: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          whenToUse: { type: "string", minLength: 1 },
          systemPrompt: { type: "string", minLength: 1 },
          scopeCeiling: { type: "array", items: { type: "string", pattern: SCOPE_PATTERN } },
          toolAllowlist: { type: "array", items: { type: "string" } },
          toolDenylist: { type: "array", items: { type: "string" } },
          skills: { type: "array", items: { type: "string" } },
          defaultMaxSteps: { type: "integer", minimum: 1 },
          defaultTimeoutMs: { type: "integer", minimum: 1 },
          contextProfile: { type: "string", enum: ["minimal", "standard", "full"] },
        },
        required: ["whenToUse", "systemPrompt", "scopeCeiling"],
        additionalProperties: false,
      },
    },
    routines: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          description: { type: "string", minLength: 1, maxLength: 200 },
          kind: { type: "string", enum: ["recurring", "scheduled", "event"] },
          cron: { type: "string" },
          timezone: { type: "string" },
          runAt: { type: "string" },
          // Full event id `<app>:<entity>:<action>`. entity:action use [a-z_]+
          // (the kernel EVENT_PATTERN); the leading app segment matches the
          // manifest NAME pattern. The cross-field check further requires the
          // app segment === manifest.name and entity:action ∈ events.emits.
          event: { type: "string", pattern: "^[a-z][a-z0-9_-]*:[a-z_]+:[a-z_]+$" },
          promptTemplate: { type: "string", minLength: 1 },
          scopes: { type: "array", items: { type: "string" } },
          enabledByDefault: { type: "boolean" },
          // Copied to the routine when the template is enabled.
          followUp: { type: "boolean" },
        },
        required: ["description", "kind", "promptTemplate", "scopes", "enabledByDefault"],
        additionalProperties: false,
      },
    },
    prompts: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1 },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    roles: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          description: { type: "string", minLength: 1 },
          extends: { type: "string" },
          scopes: {
            type: "array",
            items: { type: "string", pattern: SCOPE_PATTERN },
          },
        },
        required: ["scopes", "description"],
        additionalProperties: false,
      },
    },
    // Scopes of this app's own `member` tier that the org's kernel `member`
    // preset receives ONCE, when the app is first installed in that org. An
    // admin's later removal is never overruled (no reconcile on boot). The
    // cross-field check pins every entry to the app's flattened `member` role.
    memberPresetScopes: {
      type: "array",
      items: { type: "string", pattern: SCOPE_PATTERN },
      uniqueItems: true,
    },
    // Scopes of this app's own `member` tier that EVERY active member of the
    // org holds, whatever their roles: the registration records them on the
    // org's `kernel.apps` row and the kernel unions them into each member's
    // effective scopes (loadEffectivePermissions), so a person whose only role
    // is a custom one still holds them. Unlike `memberPresetScopes` (a one-shot
    // grant to one role an admin can edit) this is a standing floor no role
    // edit removes. The app's access restriction (S20) still drops them for
    // people kept out of the app, and an Off app's routes stay closed by the
    // app-state gate. The cross-field check pins every entry to the app's
    // flattened `member` role.
    everyMemberScopes: {
      type: "array",
      items: { type: "string", pattern: SCOPE_PATTERN },
      uniqueItems: true,
    },
    orgSettings: {
      type: "object",
      properties: {
        defaults: { type: "object" },
      },
    },
    userSettings: {
      type: "object",
      properties: {
        defaults: { type: "object" },
      },
    },
    export: {
      type: "object",
      properties: {
        formats: { type: "array", items: { type: "string" } },
        handler: { type: "string" },
        schema: { type: "object", additionalProperties: { type: "string" } },
        dimensions: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["formats", "handler"],
    },
    // Import kinds (modules/imports): each kind names the canonical record
    // shape the app accepts (a JSON Schema of type object), the handler that
    // writes a batch of records, the top-level field that deduplicates them,
    // the tables it writes and the scopes a run needs. validateAppManifest
    // adds the cross-field rules (object schema, dedupKey is a string field,
    // parent names a sibling kind).
    import: {
      type: "object",
      properties: {
        kinds: {
          type: "object",
          minProperties: 1,
          propertyNames: { pattern: "^[a-z][a-z0-9-]*$" },
          additionalProperties: importKindSchema,
        },
      },
      required: ["kinds"],
      additionalProperties: false,
    },
    connections: { type: "object", additionalProperties: connectionSchema },
    // `app` (default) or `connector`: a connector has no workspace view and its
    // settings render as a card on the Connectors page.
    kind: { type: "string", enum: ["app", "connector"] },
    // The declarative settings page. Its structure is `appSettingsSchema` in
    // @liaison/app-sdk (app-settings.ts), checked by validateAppManifest right
    // after this schema, with the cross-field rules (tools, configKeys, scopes).
    settings: { type: "object" },
    // The App store listing. Its structure is `appListingSchema` in @liaison/app-sdk
    // (app-listing.ts), checked by validateAppManifest with the SPDX `license` rule
    // and the refusal of any price, pricing or plan key under it.
    listing: { type: "object" },
    // Non-secret `kernel.apps.config` keys an admin may write
    // (`PUT /api/apps/:app/config/:key`, `config apply` `apps[].config`). Mirrors
    // `appConfigKeySchema` in @liaison/app-sdk; validateAppManifest refuses a key
    // a connection reserves for a secret, and duplicates.
    configKeys: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,99}$" },
          type: { type: "string", enum: ["json", "string", "url"] },
          label: { type: "string", minLength: 1, maxLength: 120 },
        },
        required: ["key", "type"],
        additionalProperties: false,
      },
    },
    network: {
      type: "object",
      properties: {
        allowedDomains: { type: "array", items: { type: "string" } },
        // TEST-ONLY escape hatch: when NODE_ENV=test, allow outbound fetches to
        // loopback/private hosts. Inert in production (validateOutboundUrlNoDns
        // and the DNS-pin layer both ignore this flag outside test). Used by
        // chaos-debug to POST to a host-side recorder on 127.0.0.1.
        allowPrivateHostsInTest: { type: "boolean", default: false },
      },
    },
    views: {
      type: "object",
      properties: {
        tabTypes: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              component: { type: "string" },
              label: { type: "string" },
              // Catalog key for that label, so an in-tree module's tab name
              // follows the reader's language instead of shipping English.
              labelKey: { type: "string" },
              icon: { type: "string" },
              sidebar: { type: "string" },
              urlPattern: { type: "string" },
              singleton: { type: "boolean" },
              preserveSubRoutes: { type: "boolean" },
              referenceable: { type: "boolean" },
              resolveLabel: { type: "string" },
              feature: { type: "string", minLength: 1 },
              // The entity this tab's id names, when the tab is not named for it:
              // `document`, or `kernel:contact` for another app's. It is how a turn
              // sent from the tab learns which record is open.
              entity: { type: "string", pattern: "^[a-z][a-z0-9_-]*(:[a-zA-Z][a-zA-Z0-9_-]*)?$" },
            },
            additionalProperties: false,
          },
        },
        activityBar: { type: "object" },
        panels: { type: "object" },
        attentionItems: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                handler: { type: "string" },
                scope: { type: "string" },
                passesOn: { type: "boolean" },
              },
              required: ["handler"],
              additionalProperties: false,
            },
          ],
        },
        commands: { type: "array" },
        keybindings: { type: "array" },
        saveable: { type: "array", items: { type: "string" } },
        wsHandlers: {
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  key: { type: "string" },
                  handler: { type: "string" },
                },
                required: ["key", "handler"],
                additionalProperties: false,
              },
            ],
          },
        },
        // Phase 16 Task A3 — per-entity detail-panel config. The `externalLink`
        // surfaces a deep-link button into the upstream system (e.g. Shopify
        // admin). `urlTemplate` is rendered with `{{id}}` substitution.
        detail: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              component: { type: "string", minLength: 1 },
              externalLink: {
                type: "object",
                properties: {
                  urlTemplate: { type: "string", pattern: "^https?://" },
                  label: { type: "string", default: "Open in app ↗" },
                },
                required: ["urlTemplate"],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
    },
    slots: {
      type: "object",
      patternProperties: {
        [SLOT_KEY_PATTERN]: {
          type: "object",
          properties: {
            // A host declaring where its slot sits.
            position: { type: "string", enum: ["tabs", "toolbar", "menu", "sidebar"] },
            // An app contributing to a slot.
            panels: { type: "array", items: SLOT_CONTRIBUTION_SCHEMA },
            actions: { type: "array", items: SLOT_CONTRIBUTION_SCHEMA },
          },
          anyOf: [{ required: ["position"] }, { required: ["panels"] }, { required: ["actions"] }],
        },
      },
    },
    contributions: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          label: { type: "string" },
          component: { type: "string" },
          visibility_scope: { type: "string", minLength: 1 },
          order: { type: "integer" },
          group: { type: "string", minLength: 1 },
          feature: { type: "string", minLength: 1 },
        },
        required: ["label", "component"],
      },
    },
    bulk: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          label: { type: "string" },
          underlyingTool: { type: "string" },
          dispatchMode: { type: "string", enum: ["perItem", "aggregate"] },
          perItemParam: { type: "string" },
          selectionParam: { type: "string" },
          sharedFields: { type: "array", items: { type: "string" } },
          agentTool: { type: "string" },
          icon: { type: "string" },
          customForm: { type: "string" },
          minSelection: { type: "integer", minimum: 1 },
          // perItem only: fields of the underlying tool's result copied onto
          // each succeeded item of the bulk response.
          itemResultFields: { type: "array", items: { type: "string" } },
        },
        required: ["label", "underlyingTool", "dispatchMode"],
        additionalProperties: false,
        allOf: [
          {
            if: { properties: { dispatchMode: { const: "perItem" } } },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
            then: { required: ["perItemParam"] },
          },
          {
            if: { properties: { dispatchMode: { const: "aggregate" } } },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
            then: { required: ["selectionParam"] },
          },
        ],
      },
    },
    // Phase 17 — PDF template registry. Apps that render PDFs (e.g. the
    // invoicing app's invoice/quote/proforma/po templates) declare each
    // template here with a `kind` string (e.g. `invoicing:invoice_v1`).
    // Templates are persisted at install time (`apps_installed.pdf_templates`)
    // and rehydrated into the per-org renderer registry on boot.
    pdf_templates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", minLength: 1 },
          source: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: true,
      },
    },
    // Phase 17 — Cross-app tool dependencies. Each entry declares a target
    // tool the declaring app intends to call via `ctx.executeTool`. The bridge
    // gates the call on the declaration; the executor verifies the target app
    // + tool exist.
    cross_app_calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]*:[a-zA-Z][a-zA-Z0-9_]*$",
          },
          reason: { type: "string" },
        },
        required: ["target"],
        additionalProperties: true,
      },
    },
    // Provider contracts this app implements: `{contract, version, tools:{<op>:<tool name>}}`.
    // Checked at registration against the kernel's known contracts (provider-contracts/validate.ts).
    implements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          contract: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          version: { type: "integer", minimum: 1 },
          tools: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["contract", "version", "tools"],
        additionalProperties: false,
      },
    },
    // Provider contracts this app calls through `ctx.contracts.call`, with the place its
    // admin-set binding (the provider app name) lives: `<own table>.<column>`.
    contract_calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          contract: { type: "string", pattern: "^[a-z][a-z0-9-]*@[0-9]+$" },
          bindingSetting: { type: "string" },
          reason: { type: "string" },
        },
        required: ["contract", "bindingSetting"],
        additionalProperties: false,
      },
    },
    savedViews: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          defaults: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1 },
                payload: { type: "object" },
              },
              required: ["key", "name", "payload"],
              additionalProperties: false,
            },
          },
        },
        required: ["defaults"],
      },
    },
  },
  required: ["name", "version"],
  additionalProperties: false,
}

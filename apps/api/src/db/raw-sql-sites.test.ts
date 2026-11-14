// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Raw SQL sites (security invariant).
//
// `sql.raw`, `.unsafe` and string-built `execute` bypass parameter binding: a
// value spliced into one is SQL. The enumerator (test-support/security/
// enumerate.ts) lists every such site with the expressions interpolated into
// it. An interpolation is accepted without review when it is an identifier
// built by a quoting or schema helper, or a constant. Any other expression
// needs a reviewed entry here, per expression: file#enclosing function → the
// spliced expression → why no user-derived value reaches it. A new expression
// spliced anywhere, a reviewed function included, fails until reviewed.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  enumerateRawSql,
  LIAISON_ROOT,
  type SurfaceRow,
  serverSourceFiles,
} from "../../test-support/security/enumerate"

/** Identifier helpers and constants: safe to splice by construction. */
const SAFE_INTERPOLATION =
  /^(quoteIdent\(.*\)|(schemaRef|[a-zA-Z]*Rel|rel|sr|kernelTable|tableRef|mailSchema|CALENDAR_SCHEMA|kernelRel)\(.*\)|[A-Z][A-Z0-9_]*(\(\))?|schema|schemaName|ks|mks|kernelSchema|mailSchema|tablePrefix|parentSchema|appMailSchema|ticketsSchema|K|KS|k)$/

const IDENT_FROM_CODE = "identifier or alias chosen by the calling code, never by input"
const MANIFEST_IDENT =
  "table/column names from a manifest registration (fileParent, searchable entity, timeline entity); bundled manifests only, schema-validated"
const CATALOG_IDENT = "table/column names read from information_schema / pg_catalog"
const BY_DESIGN_SQL =
  "runs SQL against a connected EXTERNAL database by design; guarded by the read-only role check (db/role-reach.ts) and statement caps"

const APP_DDL =
  "DDL from the generators in modules/apps/ddl.ts: names validateIdentifier'd and quoteIdent'd, from the validated manifest"

/**
 * `file#enclosing function` → each spliced expression in it → why no user-derived value
 * reaches it. Reviewed per interpolation: a new expression spliced into a reviewed function
 * fails until it has its own entry.
 */
const REVIEWED: Record<string, Record<string, string>> = {
  "apps/api/src/modules/cloud/storage-estimate.ts#measureSource": {
    "relOf(s)": "schemaRef of a table in the module's literal SOURCES list",
    's.columns.map((c) => `COALESCE(pg_column_size("${c}"), 0)`).join(" + ")':
      "column names from the module's literal SOURCES list, quoted; no value from a request or a row",
  },
  "apps/api/src/modules/org/transfer/closure.ts#query": {
    text: `the org transfer's one query helper: SQL its modules build from catalog names (rel / quoteIdent), every value bound as a $n parameter; ${CATALOG_IDENT}`,
  },
  "apps/api/src/modules/org/transfer/import.ts#stage": {
    name: "xfer_stage_<n>, n the import's own section counter",
  },
  "apps/api/src/modules/org/transfer/purge.ts#deleteLinkedRows.unsafe": {
    text: "the TransferSql adapter over the purge's own transaction: passes the DELETE built below unchanged",
  },
  "apps/api/src/modules/org/transfer/purge.ts#deleteLinkedRows": {
    'orgPredicate(closure, t, "t", orgId)': `EXISTS joins on catalog FK columns (quoteIdent'd) down to the org row, the org id assertUuid'd into a literal (closure.ts orgPredicate); ${CATALOG_IDENT}`,
  },
  "apps/api/src/modules/org/delete/legal-archive.ts#rowLines": {
    cols: `primary key column names (quoteIdent'd); ${CATALOG_IDENT}`,
    'pk.types[i] ?? "text"': `format_type of the primary key columns; ${CATALOG_IDENT}`,
    keyOut: `primary key column names (quoteIdent'd) and positional aliases; ${CATALOG_IDENT}`,
  },
  "apps/api/src/apps/calendar/import-kind.ts#cal": {
    t: "rel helper; literal names",
  },
  "apps/api/src/apps/calendar/import-kind.ts#kernel": {
    t: "rel helper; literal names",
  },
  "apps/api/src/cli/keys-rotate.ts#orgFilter": {
    orgColumn: 'the literal "org_id" at its only caller; org ids are bound parameters',
  },
  "apps/api/src/cli/keys-rotate.ts#rotateEncryptionKey": {
    "col.table": "from the module constants COLUMNS / JSON_COLUMNS, never input",
    "col.column": "from the module constants COLUMNS / JSON_COLUMNS, never input",
    name: "a rowContext column name from the module constant COLUMNS, never input",
  },
  "apps/api/src/apps/calendar/sync.ts#updateAccount": {
    col: "column keys are literals at both callers (sync.ts:813,883)",
  },
  "apps/api/src/apps/calendar/tools.ts#listEventsForCaller": {
    'pointTimestampSql("start")': IDENT_FROM_CODE,
    'pointTimestampSql(`"end"`)': IDENT_FROM_CODE,
    'pointTimestampSql("original_start_time")': IDENT_FROM_CODE,
  },
  "apps/api/src/modules/apps/connections/sql/transports/postgres-direct.ts#PostgresDirect.begin": {
    timeoutMs: "timeout is a validated integer",
  },
  "apps/api/src/modules/apps/connections/sql/transports/postgres-direct.ts#PostgresDirect.exec": {
    text: BY_DESIGN_SQL,
  },
  "apps/api/src/apps/knowledge/knowledge-jobs.ts#reclaimStaleRunningSources": {
    "String(STALE_RUNNING_THRESHOLD_MINUTES)": "numeric constant",
  },
  "apps/api/src/apps/knowledge/account-sources-purge.ts#knowledgeRel": {
    name: "rel helper; name is a string literal at every caller",
  },
  "apps/api/src/apps/knowledge/schema-refs.ts#knowledgeRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/knowledge/schema-refs.ts#kernelRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/mail/search-enrichment.ts#mailRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/mail/search-enrichment.ts#kernelRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/modules/imports/kernel-kinds/chat.ts#kernelRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/modules/mail/purge-account.ts#mailRel": {
    name: "rel helper; name is a string literal at every caller (purge-account.ts:61-160)",
  },
  "apps/api/src/apps/mail/search.ts#mailRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/projects/schema-refs.ts#projectsRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/projects/schema-refs.ts#kernelRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/projects/service/due-status.ts#dueBucketSql": {
    taskAlias: IDENT_FROM_CODE,
    statusAlias: IDENT_FROM_CODE,
  },
  "apps/api/src/apps/tickets/backlog-health.ts#notSuppressedInbox": {
    prefix: IDENT_FROM_CODE,
  },
  "apps/api/src/apps/tickets/schema-refs.ts#ticketsRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/tickets/schema-refs.ts#kernelRel": {
    name: "rel helper; name is a literal at every caller",
  },
  "apps/api/src/apps/tickets/state-machine.ts#applyEffects": {
    col: "SET keys are a fixed set built in applyEffects (state-machine.ts:463-522)",
  },
  "apps/api/src/cli/contacts/apply-provenance.ts#applyProvenance": {
    conversations: "operator CLI; relation names from code",
  },
  "apps/api/src/cli/contacts/apply-provenance.ts#restoreProvenance": {
    'columns.join(", ")': "operator CLI; column list from code",
  },
  "apps/api/src/cli/contacts/privatize-mailbox-senders.ts#classify": {
    "classificationSql(orgId, references)":
      "operator CLI; uuid-checked ids and code-built predicates",
  },
  "apps/api/src/cli/invoicing/import.ts#invRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/cli/invoicing/import.ts#kernelRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/cli/provisioners/invoicing.ts#invRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/cli/provisioners/invoicing.ts#kernelRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/cli/slack/import.ts#kernelRel": {
    name: "rel helper; literal names",
  },
  "apps/api/src/db/migrate.ts#runMigrations": {
    "requestLoginPasswordSql(opts.requestPassword)":
      "a SCRAM-SHA-256 verifier computed in migrate.ts, checked to be base64 and `$:` only before quoting; the password itself is never spliced",
  },
  "apps/api/src/db/migrate.ts#ensurePolicyRoles": {
    "policyRolesSql()":
      "a DO block built only from the POLICY_ROLES constant (three fixed role names), no input",
  },
  "apps/api/src/db/privileged.ts#privilegedFrom": {
    role: "the transaction's current_user, checked against /^liaison_[a-z_]+$/ (assertRestorableRole, privileged.ts) before the restore",
  },
  "apps/api/src/infra/boot-phase10.ts#runDdl": {
    "Math.trunc(lockTimeoutMs)": "lock timeout truncated to an integer",
    stmt: "boot-time policy DDL generated from code",
    "policyFingerprintSql(kernelSchema)": "fingerprint query from code over the kernel schema name",
    "quoteLiteral(policyComment(stmt, after.fingerprint, build.versions))":
      "COMMENT takes no bind parameter; stamp of hex hashes plus base64url catalog versions, quoted with quoteLiteral",
  },
  "apps/api/src/infra/events/outbox-worker.ts#adminExec": {
    query: "fixed outbox statements from the same file",
  },
  "apps/api/src/lib/handle.ts#nextHandle": {
    sequenceName: "sequence name checked against SEQ_NAME_RE (handle.ts:14)",
  },
  "apps/api/src/modules/agent/scopes/known-guests.ts#knownAddresses": {
    tickets: IDENT_FROM_CODE,
    mailMessages: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/provisioning/config-export.ts#exportIssuerProfiles": {
    'ISSUER_COLUMNS.map(([c]) => c).join(", ")':
      "column names from the module constant ISSUER_COLUMNS, never input",
    invSchema: 'schemaRef("app_invoicing"), a literal app schema name',
  },
  "apps/api/src/modules/apps/runtime.ts#stampAppSchema": {
    "quoteLiteralSql(ddlStamp)": "stamp quoted with quoteLiteralSql",
  },
  "apps/api/src/modules/apps/runtime.ts#schemaTransaction": {
    lockTimeoutMs:
      "withAppDdlLockRetry's numeric argument: 0 or Math.max(1, Math.trunc(appDdlLockPolicy.lockTimeoutMs)), a code constant",
    role: "loop variable over the literal tuple liaison_rls / liaison_admin",
    "tablePrivilegesFor(role)": "privilege list from a code constant per role",
    "generateSequenceDdl(schemaName, entityName)": APP_DDL,
    stmt: APP_DDL,
    loosen: APP_DDL,
    "generateTableUniqueAddDdl(schemaName, entityName, cols)": APP_DDL,
    "generateDropIndexDdl(schemaName, indexname)":
      "index name read from pg_indexes; validateIdentifier + quoteIdent in the generator (ddl.ts)",
  },
  "apps/api/src/modules/apps/sandbox/bridge/context.ts#buildFilteredWhereClause": {
    termJoiner: "' AND ' / ' OR ' joiner; terms bound as parameters",
  },
  "apps/api/src/modules/apps/sandbox/bridge/context.ts#findKernelEntityById": {
    'entity === "users" ? KERNEL_USER_COLUMNS : "*"':
      "fixed column list; entity limited to contacts|users",
  },
  "apps/api/src/modules/apps/sandbox/bridge/context.ts#findKernelEntitiesByIds": {
    'entity === "users" ? KERNEL_USER_COLUMNS : "*"':
      "fixed column list; entity limited to contacts|users; ids bound as uuid parameters",
  },
  "apps/api/src/modules/apps/sandbox/bridge/db.ts#createDbMethods.db_findMany": {
    'cols.join(", ")':
      "columns/order keys checked against the manifest schema, then quoteIdent (db.ts:110-150)",
    parts:
      "columns/order keys checked against the manifest schema, then quoteIdent (db.ts:110-150)",
  },
  "apps/api/src/modules/apps/sandbox/bridge/db.ts#createDbMethods.db_insert": {
    'entries.map(([k]) => quoteIdent(snakeCase(k))).join(", ")':
      "keys checked by validateFields, then quoteIdent",
  },
  "apps/api/src/modules/apps/sandbox/bridge/db.ts#createDbMethods.db_updateMany": {
    'entity === "accounts" ? "id" : "account_id"': "fixed column choice",
  },
  "apps/api/src/modules/apps/sandbox/bridge/files.ts#assertMailParentNotResetMidRun": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/apps/sandbox/bridge/files.ts#createFilesMethods": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/apps/sandbox/bridge/files.ts#createFilesMethods.files_importFromUrl": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/apps/sandbox/bridge/files.ts#createFilesMethods.files_reparent": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/apps/sandbox/bridge/mail.ts#createMailMethods.mailbox_sealAndInsert": {
    'entries.map(([k]) => quoteIdent(snakeCase(k))).join(", ")':
      "keys validated against the manifest, then quoteIdent",
  },
  "apps/api/src/modules/apps/sandbox/bridge/platform.ts#resolveRenderParent": {
    "reg.tableName": MANIFEST_IDENT,
    "reg.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/apps/sandbox/bridge/platform.ts#createPlatformMethods.pdf_render": {
    '["id", "org_id", ...cols.map((c) => quoteIdent(snakeCase(c)))].join(", ")':
      "commitRow keys checked against declared fields, then quoteIdent (platform.ts:264-283)",
  },
  "apps/api/src/modules/audit/timeline-routes.ts#GET /:app/:entityType/:entityId": {
    "target.schema": MANIFEST_IDENT,
    "target.table": MANIFEST_IDENT,
    "target.joinOn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/contacts/service.ts#repointContactSoftReferences": {
    deals: "quoteIdent(schemaRef()) over code constants (service.ts, repointContactSoftReferences)",
  },
  "apps/api/src/modules/contacts/companies.ts#repointAppCompanyLinks": {
    qualified:
      "quoteIdent(schemaRef()) and quoteIdent over the code constant APP_COMPANY_LINKS (companies.ts), checked with to_regclass first",
  },
  "apps/api/src/modules/contacts/companies.ts#liveSchedulesBilling": {
    qualified:
      "quoteIdent(schemaRef()) over code constants (companies.ts), checked with to_regclass first",
  },
  "apps/api/src/modules/contacts/companies.ts#unlinkAppCompanyRows": {
    qualified:
      "quoteIdent(schemaRef()) and quoteIdent over the code constant APP_COMPANY_LINKS (companies.ts), checked with to_regclass first",
  },
  "apps/api/src/modules/contacts/service.ts#liveSchedulesBillingContact": {
    qualified:
      "quoteIdent(schemaRef()) over code constants (service.ts), checked with to_regclass first",
  },
  "apps/api/src/modules/contacts/erasure.ts#clearContactSoftReferences": {
    dealsTable: "rel() over code constants (erasure.ts:81)",
    customersTable: "rel() over code constants (erasure.ts), checked with to_regclass first",
    schedulesTable: "rel() over code constants (erasure.ts), checked with to_regclass first",
  },
  "apps/api/src/modules/contacts/erasure.ts#release": {
    used: "OR-joined EXISTS predicates built in this function from the code reference table and the checked ids",
    orgId: "UUID-checked before splicing (erasure.ts:83-85)",
    userId: "UUID-checked before splicing (erasure.ts:83-85)",
    conversations: "rel() over code constants (erasure.ts:87)",
  },
  "apps/api/src/modules/contacts/references.ts#countTeamReferences": {
    "predicateSql(ref)": "predicate built from the code reference table",
    i: "array index of the reference table, a number",
  },
  "apps/api/src/modules/org/purge/rows.ts#deleteOrgRows": {
    "t.schema": CATALOG_IDENT,
    "t.table": CATALOG_IDENT,
  },
  "apps/api/src/modules/org/purge/rows.ts#tablesHoldingOrgRows": {
    "t.schema": CATALOG_IDENT,
    "t.table": CATALOG_IDENT,
  },
  "apps/api/src/modules/org/purge/rows.ts#countOrgRows": {
    "t.schema": CATALOG_IDENT,
    "t.table": CATALOG_IDENT,
  },
  "apps/api/src/modules/org/purge/immutable-triggers.ts#ensureImmutableTriggersCurrent": {
    stmt: `${APP_DDL}; schema and table read from pg_catalog, the spec read back from the trigger body this generator wrote (immutableSpecFromTriggerBody: digits and identifiers only)`,
  },
  "apps/api/src/modules/export/org-archive/writer.ts#scopeWhere": {
    "withheld.keep()":
      "a predicate from the code constant WITHHELD_ROWS (withheld.ts): fixed SQL over alias t and schemaRef names, no value from a request or a row",
  },
  "apps/api/src/apps/projects/service/reconcile-sweep.ts#sweepClaims": {
    docs: 'schemaRef("app_invoicing") plus the literal table name documents, checked with to_regclass first',
  },
  "apps/api/src/apps/projects/service/reconcile.ts#readableProofRefs": {
    rel: "schemaRef() and table name from the code constant OWNED_PROOFS, checked with to_regclass first",
  },
  "apps/api/src/apps/projects/service/time-settings.ts#selectedCalendars": {
    rel: 'schemaRef("app_calendar") plus the literal table name calendars, checked with to_regclass first',
  },
  "apps/api/src/apps/projects/service/time-plan.ts#keep": {
    col: 'a column name the calling code writes as a literal (keep("basis") and the like) to keep a plan or terms column unchanged in an upsert',
  },
  "apps/api/src/modules/export/org-archive/writer.ts#readBatch": {
    'pk.join(", ")': `${CATALOG_IDENT} (primary key columns), each quoteIdent'd`,
    'plan.pkTypes[i] ?? "text"': "format_type() of a primary key column, read from pg_catalog",
    keyCols: `${CATALOG_IDENT} (primary key columns), each quoteIdent'd`,
    keyOut: "fixed aliases __k0, __k1, ... built from a counter",
    sealedOut: 'the fixed alias ", __sealed" or nothing',
    sealedCol: `${CATALOG_IDENT}, quoteIdent'd, kept only when listed in the code constant KEPT_COLUMNS`,
    "plan.select": `${CATALOG_IDENT}, quoteIdent'd, with expressions from a fixed per-type switch`,
  },
  "apps/api/src/modules/demo/warehouse/provision.ts#applyGrants": {
    "demoWarehouseGrants(login.role, literal)": "deploy-time DDL from code constants",
  },
  "apps/api/src/modules/demo/warehouse/provision.ts#provisionDemoWarehouse": {
    '[...DEMO_WAREHOUSE_TABLES] .map((t) => `${DEMO_WAREHOUSE_SCHEMA}.${t}`) .join(", ")':
      "deploy-time DDL from code constants",
  },
  "apps/api/src/modules/erasure/erase-user.ts#assertOrgPiiSchemasAccounted": {
    "c.table_schema": CATALOG_IDENT,
    "c.table_name": CATALOG_IDENT,
  },
  "apps/api/src/modules/erasure/erase-user.ts#kernelColumnHasUser": {
    table: IDENT_FROM_CODE,
    column: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/erasure/erase-user.ts#eraseUser": {
    "f.schema": IDENT_FROM_CODE,
    "f.table": IDENT_FROM_CODE,
    "f.column": IDENT_FROM_CODE,
  },
  "apps/api/src/modules/erasure/erased-user.ts#authorErasedSql": {
    alias: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/export/data-subject-export-tool.ts#buildDataSubjectBundle": {
    documentsTable: IDENT_FROM_CODE,
    identityTable: IDENT_FROM_CODE,
    schedulesTable: IDENT_FROM_CODE,
    customersTable: IDENT_FROM_CODE,
    subscriptionsTable: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/files/message-attachments.ts#messageIdOf": {
    filesAlias: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/files/service.ts#assertParentVisible": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
    "parent.softDeleteColumn": MANIFEST_IDENT,
  },
  "apps/api/src/modules/files/service.ts#deleteFile": {
    "parent.tableName": MANIFEST_IDENT,
    "parent.joinOn": MANIFEST_IDENT,
    "parent.retention.anchor": MANIFEST_IDENT,
  },
  "apps/api/src/modules/mailbox-crypto/content-suppression.ts#mailAccountSuppressedSql": {
    alias: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/mailbox-crypto/content-suppression.ts#isMailEntitySuppressed": {
    table: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/mailbox-crypto/content-suppression.ts#isMailAttachmentMailboxPrivate": {
    table: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/mailbox-crypto/post-sync-assertions.ts#assertMailboxSchemaState": {
    q: "quoteIdent'd schema/table/column names from code and pg_attribute",
    col: "quoteIdent'd schema/table/column names from code and pg_attribute",
    everEnrolled: "quoteIdent'd schema/table/column names from code and pg_attribute",
    'hasStateColumn ? managedArmed : ""':
      "the managed-mode arming branch: a literal state and quoteIdent'd kernel names from code",
  },
  "apps/api/src/modules/mailbox-crypto/purge.ts#headersAsObject": {
    column: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/mailbox-crypto/purge.ts#headersOutsideAllowlist": {
    column: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/mailbox-keys/attention.ts#computeMailboxEnrollmentAttentionItems": {
    mail: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/monitor/index.ts#getOutboxDiag": {
    table: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/monitor/index.ts#getMailIngestDiag": {
    inboxes: IDENT_FROM_CODE,
    connectedAccounts: IDENT_FROM_CODE,
    accounts: IDENT_FROM_CODE,
  },
  "apps/api/src/modules/search/mention-secondary.ts#attachMentionSecondaryLabels": {
    i: "column alias index; ids bound",
  },
  "apps/api/src/modules/search/reindex.ts#streamEntity": {
    qualified: MANIFEST_IDENT,
  },
  "apps/api/src/modules/search/service.ts#directMentionFallback": {
    table:
      "org id and query escaped by sqlLiteral/sqlLikeLiteral, identifiers by a strict quoteIdent (service.ts:1165-1178), limit a number",
    where:
      "org id and query escaped by sqlLiteral/sqlLikeLiteral, identifiers by a strict quoteIdent (service.ts:1165-1178), limit a number",
    orderBy:
      "org id and query escaped by sqlLiteral/sqlLikeLiteral, identifiers by a strict quoteIdent (service.ts:1165-1178), limit a number",
    limit:
      "org id and query escaped by sqlLiteral/sqlLikeLiteral, identifiers by a strict quoteIdent (service.ts:1165-1178), limit a number",
  },
  "apps/api/src/modules/agent/tools/navigation-tool.ts#lookupHandle": {
    "where.table": `app name and table name from handleColumn: ${MANIFEST_IDENT}, each checked against SAFE_IDENT and double-quoted`,
    "where.column": `the entity's declared handle column from handleColumn: ${MANIFEST_IDENT}, checked against SAFE_IDENT and double-quoted`,
  },
  "apps/api/src/modules/threads/reference-display.ts#loadAppEntityLabelAndSnippet": {
    labelField: "identifiers checked against SAFE_IDENT (reference-display.ts:116-119)",
    tableName: "identifiers checked against SAFE_IDENT (reference-display.ts:116-119)",
    handleField: "identifiers checked against SAFE_IDENT (reference-display.ts:116-119)",
  },
  "apps/api/src/modules/users/merge-placeholder.ts#conflictPredicate": {
    predicate: "partial-index predicate read from pg_catalog (pg_get_expr)",
  },
  "apps/api/src/modules/data-store/service.ts#columnCompare": {
    op: 'typed as a value of the module constant RANGE_OPS or the literal "=" (compileWhere); the compared value is a bound parameter',
  },
  "apps/api/src/modules/data-store/service.ts#compileWhere": {
    op: "RANGE_OPS[key], after Object.hasOwn(RANGE_OPS, key): one of > >= < <=; the compared value is a bound parameter",
  },
  "apps/api/src/modules/data-store/service.ts#queryDocuments": {
    'dir === "asc" ? ">" : "<"': "one of two literals; dir is checked to be 'asc' or 'desc' above",
  },
  "apps/db-gate/src/gate-db.ts#GateDb.runRead": {
    "this.statementTimeoutMs":
      "number from the gate's own options (DEFAULT_STATEMENT_TIMEOUT_MS or operator config)",
    cappedText: BY_DESIGN_SQL,
  },
  "apps/db-gate/src/gate-db.ts#GateDb.runQuery": {
    "this.statementTimeoutMs":
      "number from the gate's own options (DEFAULT_STATEMENT_TIMEOUT_MS or operator config)",
    cappedText: BY_DESIGN_SQL,
  },
}

const keyOf = (loc: string, enclosing: unknown) => `${loc.replace(/:\d+$/, "")}#${enclosing}`

/** Every spliced expression no rule and no reviewed entry accounts for. */
export function unreviewedInterpolations(
  rows: SurfaceRow[],
  reviewed: Record<string, Record<string, string>>,
): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (!r.attrs.dynamic) continue
    const ints = (r.attrs.interpolations as string[] | null) ?? []
    const entry = reviewed[keyOf(r.location, r.attrs.enclosing)] ?? {}
    const bad = ints.filter((i) => !SAFE_INTERPOLATION.test(i) && !entry[i])
    if (bad.length > 0) out.push(`${r.location} ${r.attrs.enclosing}: ${bad.join(" | ")}`)
  }
  return out
}

/** Reviewed interpolations no enumerated site splices any more. */
export function staleReviews(
  rows: SurfaceRow[],
  reviewed: Record<string, Record<string, string>>,
): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    const key = keyOf(r.location, r.attrs.enclosing)
    for (const i of (r.attrs.interpolations as string[] | null) ?? []) seen.add(`${key} ${i}`)
  }
  return Object.entries(reviewed).flatMap(([key, ints]) =>
    Object.keys(ints)
      .map((i) => `${key} ${i}`)
      .filter((k) => !seen.has(k)),
  )
}

describe("raw SQL sites", () => {
  const rows = enumerateRawSql(serverSourceFiles()).filter(
    (r) => !r.location.includes("/test-support/"),
  )

  test("the enumerator finds the raw SQL sites", () => {
    expect(rows.length).toBeGreaterThan(400)
  })

  test("every spliced non-identifier expression is reviewed on its own", () => {
    expect(unreviewedInterpolations(rows, REVIEWED)).toEqual([])
  })

  test("no reviewed interpolation is stale", () => {
    expect(staleReviews(rows, REVIEWED)).toEqual([])
  })

  test("a new interpolation in a reviewed function fails until it is reviewed", () => {
    const file = path.join(LIAISON_ROOT, "apps/api/src/apps/calendar/sync.ts")
    const text = `import { sql } from "drizzle-orm"
export async function updateAccount(tx: any, col: string, body: { order: string }) {
  await tx.execute(sql.raw(\`UPDATE a SET \${col} = 1\`))
  await tx.execute(sql.raw(\`UPDATE a SET \${col} = 1 ORDER BY \${body.order}\`))
}
`
    const synthetic = enumerateRawSql([file], LIAISON_ROOT, new Map([[file, text]]))
    expect(synthetic).toHaveLength(2)
    expect(unreviewedInterpolations(synthetic, REVIEWED)).toEqual([
      "apps/api/src/apps/calendar/sync.ts:4 updateAccount: body.order",
    ])
  })

  test("an interpolation is read whole and with collapsed whitespace", () => {
    const file = path.join(LIAISON_ROOT, "apps/api/src/x.ts")
    // Ten plain interpolations, then one spread over three lines.
    const many = Array.from({ length: 10 }, (_, i) => `$\{v${i}}`).join(", ")
    const multiLine = `$\{[\n    a,\n    b,\n  ].join(",")}`
    const text = [
      'import { sql } from "drizzle-orm"',
      "export function f() {",
      `  return sql.raw(\`SELECT ${many}, ${multiLine}\`)`,
      "}",
    ].join("\n")
    const [row] = enumerateRawSql([file], LIAISON_ROOT, new Map([[file, text]]))
    const ints = row?.attrs.interpolations as string[]
    expect(ints).toHaveLength(11)
    expect(ints[10]).toBe('[ a, b, ].join(",")')
  })
})

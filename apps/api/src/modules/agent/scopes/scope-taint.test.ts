// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import {
  checkScopeTaint,
  checkToolScopeTaint,
  SCOPE_TAINT_NO_DECIDER_MESSAGE,
  SINK_APP_KNOWLEDGE_DOCUMENTS,
  SINK_APP_PROJECTS_TASK_CHECKLIST_ITEMS,
  SINK_APP_PROJECTS_TASK_DEPENDENCIES,
  SINK_APP_PROJECTS_TASKS,
  SINK_KERNEL_AGENT_MEMORY,
  SINK_KERNEL_AGENT_RUNS,
  SINK_KERNEL_ATTENTION_SUBSCRIPTIONS,
  SINK_KERNEL_MESSAGES,
  SINK_KERNEL_SCOPE_REQUESTS,
  SINK_KERNEL_SUB_AGENT_DEFINITIONS,
  SINK_KERNEL_USER_PREFERENCES,
  SINK_KERNEL_USER_THREAD_STATE,
  TAINT_CONTROL_PLANE_SINKS,
  TAINT_ENFORCING_SINKS,
  TAINT_LOW_SENSITIVITY_SINKS,
  taintDisclosureLine,
  taintSourceApps,
  taintSurfaceLabel,
  toScopeTaintBlockedError,
  UNDECLARED_WRITE_TARGET,
  UNKNOWN_TURN_TAINT,
} from "~/modules/agent/scopes/scope-taint"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"

const BLOCKED = { allowed: false, reason: "scope_taint_blocked" }
const TAINTED = ["a:b:read"]

describe("checkToolScopeTaint: taint fails closed on undeclared write tools", () => {
  it("a tainted turn blocks an undeclared, non-read-only tool", () => {
    const refused = toScopeTaintBlockedError(UNDECLARED_WRITE_TARGET, TAINTED)
    expect(checkToolScopeTaint(TAINTED, {})).toEqual(refused)
    expect(checkToolScopeTaint(TAINTED, { readOnly: false })).toEqual(refused)
  })

  it("a tainted turn allows a read-only tool", () => {
    expect(checkToolScopeTaint(TAINTED, { readOnly: true })).toBeNull()
  })

  it("a tainted turn allows every enforcing sink", () => {
    for (const sink of [
      SINK_KERNEL_MESSAGES,
      SINK_KERNEL_AGENT_MEMORY,
      SINK_APP_KNOWLEDGE_DOCUMENTS,
    ]) {
      expect(checkToolScopeTaint(TAINTED, { writesToTable: sink })).toBeNull()
    }
  })

  it("a tainted turn blocks a declared non-enforcing table", () => {
    expect(checkToolScopeTaint(TAINTED, { writesToTable: "kernel.contacts" })).toEqual(
      toScopeTaintBlockedError("kernel.contacts", TAINTED),
    )
  })

  it("a declared write target wins over a readOnly marker, so a contradictory tool is still checked", () => {
    expect(
      checkToolScopeTaint(TAINTED, { readOnly: true, writesToTable: "kernel.contacts" }),
    ).toEqual(toScopeTaintBlockedError("kernel.contacts", TAINTED))
  })

  it("an untainted turn allows everything", () => {
    for (const toolDef of [
      {},
      { readOnly: false },
      { readOnly: true },
      { writesToTable: "kernel.contacts" },
      { writesToTable: SINK_KERNEL_MESSAGES },
    ]) {
      expect(checkToolScopeTaint([], toolDef)).toBeNull()
    }
  })
})

describe("checkToolScopeTaint: a write carrying none of the turn (rule 6f)", () => {
  const withdraw = { writesToTable: "kernel.approval_requests", contentParams: ["reason"] }

  it("runs on a tainted turn when every content parameter is absent, null or blank", () => {
    for (const args of [{ requestId: "r" }, { requestId: "r", reason: null }, { reason: "  " }]) {
      expect(checkToolScopeTaint(TAINTED, withdraw, { args })).toBeNull()
    }
  })

  it("is judged as before once a content parameter carries text, and the refusal names the way out", () => {
    const refused = checkToolScopeTaint(TAINTED, withdraw, { args: { reason: "why" } })
    expect(refused?.code).toBe("E_SCOPE_TAINT_BLOCKED")
    expect(refused?.message).toContain("WITHOUT reason")
    // A non-string value fails closed.
    expect(checkToolScopeTaint(TAINTED, withdraw, { args: { reason: 1 } })?.code).toBe(
      "E_SCOPE_TAINT_BLOCKED",
    )
  })

  it("a declared empty list says no parameter carries content: it runs on a tainted turn", () => {
    const flagFlip = { writesToTable: "kernel.threads", contentParams: [] as string[] }
    expect(checkToolScopeTaint(TAINTED, flagFlip, { args: {} })).toBeNull()
  })

  it("a tool declaring no content parameters keeps the plain rule and the plain message", () => {
    expect(
      checkToolScopeTaint(TAINTED, { writesToTable: "kernel.approval_requests" }, { args: {} }),
    ).toEqual(toScopeTaintBlockedError("kernel.approval_requests", TAINTED))
  })
})

describe("knowledge manifest write-target declarations", () => {
  it("the knowledge tools that write documents declare app_knowledge.documents, and only those", () => {
    const declared: Record<string, string> = {}
    for (const [name, def] of Object.entries(
      knowledgeManifest.tools as Record<string, { writesToTable?: string }>,
    )) {
      if (def.writesToTable !== undefined) declared[name] = def.writesToTable
    }
    // Only the document writers declare the enforcing sink. The collection tools declare
    // their own non-enforcing tables (2026-09-25 sweep), so a tainted turn's refusal names
    // the real table. add_folder_source and source_link_create reach a remote source
    // (Drive, GitLab) and stay undeclared: external writes.
    expect(declared).toEqual({
      create: "app_knowledge.documents",
      update: "app_knowledge.documents",
      archive: "app_knowledge.documents",
      restore: "app_knowledge.documents",
      verify: "app_knowledge.documents",
      add_to_collection: "app_knowledge.collection_memberships",
      remove_from_collection: "app_knowledge.collection_memberships",
      collection_create: "app_knowledge.collections",
      collection_delete: "app_knowledge.collections",
      collection_update: "app_knowledge.collections",
    })
  })
})

describe("checkScopeTaint", () => {
  it("checkScopeTaint allows any write when the turn has touched no scoped data", () => {
    expect(checkScopeTaint([], "tickets")).toEqual({ allowed: true })
  })

  // Kernel control-plane sinks: a tainted turn may still dispatch a sub-run, register a role
  // and ask for a scope. Nothing here is a business record with a non-scope-aware read.
  for (const sink of [
    SINK_KERNEL_AGENT_RUNS,
    SINK_KERNEL_SUB_AGENT_DEFINITIONS,
    SINK_KERNEL_SCOPE_REQUESTS,
    SINK_KERNEL_USER_PREFERENCES,
    SINK_KERNEL_ATTENTION_SUBSCRIPTIONS,
    SINK_KERNEL_USER_THREAD_STATE,
  ]) {
    it(`checkScopeTaint allows a write to a control-plane sink on a tainted turn: ${sink}`, () => {
      expect(TAINT_CONTROL_PLANE_SINKS.has(sink)).toBe(true)
      expect(TAINT_ENFORCING_SINKS.has(sink)).toBe(false)
      expect(checkScopeTaint(["a:b:read"], sink)).toEqual({ allowed: true })
    })
  }

  // Project task tables are low sensitivity (owner decision): a tainted turn may file a task,
  // tick a checklist item or link two tasks; the project itself and its statuses keep the rule.
  for (const sink of [
    SINK_APP_PROJECTS_TASKS,
    SINK_APP_PROJECTS_TASK_CHECKLIST_ITEMS,
    SINK_APP_PROJECTS_TASK_DEPENDENCIES,
  ]) {
    it(`checkScopeTaint allows a write to a low-sensitivity sink on a tainted turn: ${sink}`, () => {
      expect(TAINT_LOW_SENSITIVITY_SINKS.has(sink)).toBe(true)
      expect(checkScopeTaint(["a:b:read"], sink)).toEqual({ allowed: true })
    })
  }

  it("the low-sensitivity allowance is closed to project task tables", () => {
    for (const table of [
      "app_projects.projects",
      "app_projects.project_statuses",
      "app_projects.task",
      "projects.tasks",
      "app_tickets.tickets",
    ]) {
      expect(checkScopeTaint(["a:b:read"], table)).toEqual(BLOCKED)
    }
  })

  it("the control-plane allowance is closed: a neighbouring kernel table is still refused", () => {
    for (const table of ["kernel.agents", "kernel.tickets", "kernel.files", "kernel.contacts"]) {
      expect(checkScopeTaint(["a:b:read"], table)).toEqual(BLOCKED)
    }
  })

  for (const sink of ["kernel.messages", "kernel.agent_memory", "app_knowledge.documents"]) {
    it(`checkScopeTaint allows a write to an enforcing sink even with accumulated scopes: ${sink}`, () => {
      expect(checkScopeTaint(["a:b:read"], sink)).toEqual({ allowed: true })
    })
  }

  for (const sink of ["tickets", "projects", "contacts", "files", "mail", "skills", "routines"]) {
    it(`checkScopeTaint blocks a write to a non-enforcing sink when scopes are accumulated: ${sink}`, () => {
      expect(checkScopeTaint(["a:b:read"], sink)).toEqual(BLOCKED)
    })
  }

  // The sink match is exact on the unprefixed, schema-qualified table name. Bare names,
  // other schemas' tables sharing a base name, a runtime SCHEMA_PREFIX, the pre-rename
  // memory table, case or whitespace variants and sibling tables are all non-enforcing.
  for (const sink of [
    "messages",
    "agent_memory",
    "app_knowledge",
    "app_mail.messages",
    "app_social.messages",
    "app_social.dm_message",
    "test_w1_kernel.messages",
    "test_w1_app_knowledge.documents",
    "kernel.agent_user_memory",
    "app_knowledge.collections",
    "Kernel.messages",
    " kernel.messages",
    "kernel.messages ",
    'kernel."messages"',
    "kernel.messages_archive",
    "",
  ]) {
    it(`checkScopeTaint blocks a look-alike sink name when scopes are accumulated: '${sink}'`, () => {
      expect(checkScopeTaint(["a:b:read"], sink)).toEqual(BLOCKED)
    })
  }

  it("TAINT_ENFORCING_SINKS is exactly the closed list kernel.messages, kernel.agent_memory, app_knowledge.documents", () => {
    expect([...TAINT_ENFORCING_SINKS].sort()).toEqual([
      "app_knowledge.documents",
      "kernel.agent_memory",
      "kernel.messages",
    ])
  })
})

describe("toScopeTaintBlockedError", () => {
  it("toScopeTaintBlockedError returns the named E_SCOPE_TAINT_BLOCKED shape with the refused table", () => {
    const refused = toScopeTaintBlockedError("tickets", TAINTED)
    expect(refused).toMatchObject({
      ok: false,
      code: "E_SCOPE_TAINT_BLOCKED",
      writeTargetTable: "tickets",
      reason: "scope_taint_blocked",
    })
  })

  it("the refusal tells the model the write did not happen and how to report it", () => {
    // A bare code was answered with "I have replied to the ticket" on the
    // Flash Lite bench: the rule rides on the result, where it is read.
    const refused = toScopeTaintBlockedError("app_tickets.tickets", TAINTED)
    expect(refused.message).toContain("NOT EXECUTED")
    expect(refused.message).toContain("app_tickets.tickets")
    expect(refused.message).toMatch(/never as done/)
  })
})

describe("writesToTable annotations on kernel tools", () => {
  const ORG_ID = "00000000-0000-0000-0000-000000da0e18"

  beforeAll(async () => {
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
  })

  it("kernel write tools declare writesToTable as the exact schema-qualified table they write", () => {
    const annotated: Record<string, string> = {}
    for (const [[orgId, appName, toolName], entry] of toolRegistry.entries()) {
      if (orgId !== ORG_ID || appName !== "kernel") continue
      if (entry.writesToTable !== undefined) annotated[toolName] = entry.writesToTable
    }
    // Literal strings on purpose: a typo in the registration metadata or in the sink
    // constants must fail here, not only in the execution-path integration test.
    expect(annotated).toEqual({
      threads_reply: "kernel.messages",
      // P3b: the coordination tools post into the conversation, agents_ask as a
      // question addressed to another agent and agents_invite as the seating
      // note, so both land rows in the same enforcing sink as threads_reply.
      agents_ask: "kernel.messages",
      agents_invite: "kernel.messages",
      user_memory_set: "kernel.agent_memory",
      // Dashboards: the saved dashboard row (personal, or org-wide after an approval).
      dashboards_create: "kernel.dashboards",
      dashboards_update: "kernel.dashboards",
      dashboards_edit: "kernel.dashboards",
      dashboards_pdf: "kernel.files",
      dashboards_share: "kernel.dashboards",
      dashboards_delete: "kernel.dashboards",
      // Dashboard tables: rows in the data store (judged by the table's readers), the tables.
      tables_rows_write: "kernel.app_documents",
      tables_edit: "kernel.dashboard_tables",
      // The app data store: a document of an app's declared collection.
      data_set: "kernel.app_documents",
      data_update: "kernel.app_documents",
      data_delete: "kernel.app_documents",
      // P4m: a delete mutates the index that is re-injected every turn, so it
      // is as much a write as a set, and the six file verbs write the same
      // rows through the memory tree.
      user_memory_delete: "kernel.agent_memory",
      memory_create: "kernel.agent_memory",
      memory_str_replace: "kernel.agent_memory",
      memory_insert: "kernel.agent_memory",
      memory_delete: "kernel.agent_memory",
      memory_rename: "kernel.agent_memory",
      capture_business_knowledge: "app_knowledge.documents",
      companies_link_batch: "kernel.companies",
      companies_link_contacts: "kernel.contacts",
      companies_mark_not_same: "kernel.companies",
      companies_merge: "kernel.companies",
      companies_write: "kernel.companies",
      // The person's own computer sessions: a command lands in the session's own
      // queue, read back only by its owner and the session on their computer.
      computer_session_answer: "kernel.node_session_commands",
      computer_session_send: "kernel.node_session_commands",
      computer_session_settings: "kernel.node_session_commands",
      computer_session_stop: "kernel.node_session_commands",
      contacts_write: "kernel.contacts",
      // FX-C2/C10: the merge writes kernel.contacts (updates the survivor,
      // deletes the source), same non-enforcing table as contacts_write.
      // Declaring it is what lets a read-then-merge turn use the A46
      // same-resource allowance instead of being refused as undeclared.
      contacts_merge: "kernel.contacts",
      // Sharing a private contact with the org updates its row.
      contacts_share: "kernel.contacts",
      // S15 contact groups: a group row and its member rows, each declaring its
      // readers (kernel:contacts:read), so the dispatch judges them by rule 6.
      contacts_group_create: "kernel.contact_segments",
      contacts_group_rename: "kernel.contact_segments",
      contacts_group_delete: "kernel.contact_segments",
      contacts_group_add: "kernel.contact_group_members",
      contacts_group_remove: "kernel.contact_group_members",
      // The address book: an address row, read back under kernel:contacts:read.
      contacts_address_upsert: "kernel.contact_addresses",
      contacts_address_verify: "kernel.contact_addresses",
      // Product attributes by SKU, read by holders of kernel:products:read.
      product_attributes_upsert: "kernel.product_attributes",
      // Document templates, read by every member who reads files (kernel:files:read); the
      // preview is the caller's own staged file; a print lands on the record and carries
      // only ids (contentParams []).
      document_template_create: "kernel.document_templates",
      document_template_update: "kernel.document_templates",
      document_template_archive: "kernel.document_templates",
      document_template_preview: "kernel.files",
      documents_print: "kernel.files",
      // Needed-template rules, read back by holders of kernel:org:admin.
      document_rules_upsert: "kernel.document_template_rules",
      document_rules_delete: "kernel.document_template_rules",
      // Kernel CONTROL-PLANE rows, not business records. Undeclared, these three were refused
      // on every tainted turn as writes to "undeclared", which made a sub-run and a scope
      // request unreachable from an agent turn that had read anything scoped.
      spawn_agent: "kernel.agent_runs",
      subagent_create: "kernel.sub_agent_definitions",
      request_scope: "kernel.scope_requests",
      // The secret form card: the row holds the request, never the secret.
      request_secret: "kernel.secret_requests",
      // Imports: a saved transform version (read by import runners), a preview's
      // dry-run row and a cancel flag (read by holders of kernel:imports:read).
      import_transform_save: "kernel.import_transforms",
      import_preview: "kernel.import_runs",
      import_cancel: "kernel.import_runs",
      // 2026-09-25: its initial message is a kernel.messages row stamped like threads_reply;
      // the title's audience (the participants) is judged inside the handler.
      threads_create: "kernel.messages",
      // P4: a chat job's request and its result are messages of the asking thread.
      run_on_my_computer: "kernel.messages",
      // Posts the generated shopify.app.toml in the conversation (setup-guide-tools.ts).
      shopify_app_toml: "kernel.messages",
      subagent_delete: "kernel.sub_agent_definitions",
      // The 2026-09-25 sweep: every write names its real table. None is an enforcing sink,
      // so each is still refused on a turn whose taint is relevant.
      approval_update_payload: "kernel.approval_requests",
      approval_withdraw: "kernel.approval_requests",
      // S24: turning an app On/Off and setting who may use it write kernel.apps.
      apps_set_access: "kernel.apps",
      ai_models_set: "kernel.organizations",
      apps_set_enabled: "kernel.apps",
      create_pinned_thread: "kernel.threads",
      data_subject_export: "kernel.files",
      enable_app: "kernel.organizations",
      files_merge_pdfs: "kernel.files",
      files_upload_url: "kernel.files",
      files_upload_confirm: "kernel.files",
      notify_user: "kernel.attention_events",
      // Lifts the thread's outside-text mark on a person's approval (outside-text-tools.ts).
      outside_text_clear: "kernel.threads",
      merge_imported_user: "kernel.users",
      // The bug report tool files a ticket.
      report_bug: "app_tickets.tickets",
      // S17: the user's own notification settings. Self rows, none an enforcing
      // sink, so a tainted turn is refused these like any other kernel write.
      notifications_set: "kernel.user_preferences",
      set_away: "kernel.away_ranges",
      notification_rules_set: "kernel.attention_subscriptions",
      thread_mute_set: "kernel.user_thread_state",
      // The caller's (or, with kernel:users:admin, a member's) hidden sidebar
      // apps: a display preference, never access.
      sidebar_apps_set: "kernel.user_preferences",
      watch_state: "kernel.routine_state",
    })
  })

  it("spawn_agent, subagent_create and request_scope run on a tainted turn while a domain write is still refused", () => {
    const entry = (name: string) => toolRegistry.get([ORG_ID, "kernel", name])
    for (const name of ["spawn_agent", "subagent_create", "request_scope"]) {
      const def = entry(name)
      expect(def).toBeDefined()
      // The decision the live tour hit: same turn, same taint, through the same helper the
      // tool bridge calls.
      expect(checkToolScopeTaint(TAINTED, def as never, { args: {} })).toBeNull()
    }
    // ... and the taint still does its job in that same turn: a contacts write has no
    // same-resource origin here, so it is refused exactly as before.
    expect(checkToolScopeTaint(TAINTED, entry("contacts_write") as never, { args: {} })).toEqual(
      toScopeTaintBlockedError("kernel.contacts", TAINTED),
    )
    // analyze_media is a read: it stores only an unbriefed analysis, drawn from the file alone.
    expect(checkToolScopeTaint(TAINTED, entry("analyze_media") as never, { args: {} })).toBeNull()
  })

  it("documents: a tainted turn may preview and print; a template write declares its readers", () => {
    const entry = (name: string) => toolRegistry.get([ORG_ID, "kernel", name]) as never
    // The preview is the caller's own staged file (rule 6d), judged at the dispatch.
    expect(
      checkToolScopeTaint(TAINTED, entry("document_template_preview"), {
        args: { recordId: "r" },
        deferGatedToDispatch: true,
      }),
    ).toBeNull()
    // A print passes only ids: none of the turn's text reaches the printed file (rule 6f).
    expect(
      checkToolScopeTaint(TAINTED, entry("documents_print"), {
        args: { app: "a", entity: "e", recordId: "r", templateIds: ["t"] },
      }),
    ).toBeNull()
    // A template body is read by every member who reads files. The writes are gated, so on a
    // tainted turn they always park for a holder of the taint (rule 8; behaviour pinned in
    // document-agent-tools.test.ts); the declared readers name the sink for the card.
    expect(toolRegistry.get([ORG_ID, "kernel", "document_template_create"])?.sinkReadScope).toBe(
      "kernel:files:read",
    )
  })

  it("S28: a turn tainted by a job's source scopes may call files_upload_url and files_upload_confirm", () => {
    const entry = (name: string) => toolRegistry.get([ORG_ID, "kernel", name]) as never
    for (const name of ["files_upload_url", "files_upload_confirm"]) {
      // Same helper and flag the tool bridge uses; the dispatch then judges the uploader's grants.
      expect(
        checkToolScopeTaint(TAINTED, entry(name), { args: {}, deferGatedToDispatch: true }),
      ).toBeNull()
    }
  })

  it("S28: the same turn is still refused E_SCOPE_TAINT_BLOCKED on files_merge_pdfs by the plain rule; the bridge defers it to the dispatch, which parks it (rule 8)", () => {
    const merge = toolRegistry.get([ORG_ID, "kernel", "files_merge_pdfs"]) as never
    expect(checkToolScopeTaint(TAINTED, merge, { args: { file_ids: ["f"] } })?.code).toBe(
      "E_SCOPE_TAINT_BLOCKED",
    )
    expect(
      checkToolScopeTaint(TAINTED, merge, {
        args: { file_ids: ["f"] },
        deferGatedToDispatch: true,
      }),
    ).toBeNull()
  })

  it("approval_withdraw runs on a tainted turn, with or without a reason; approval_update_payload stays judged", () => {
    const entry = (name: string) => toolRegistry.get([ORG_ID, "kernel", name]) as never
    expect(
      checkToolScopeTaint(TAINTED, entry("approval_withdraw"), { args: { requestId: "r" } }),
    ).toBeNull()
    // The reason is stamped with the turn's taint where it is posted (withdraw.ts).
    expect(
      checkToolScopeTaint(TAINTED, entry("approval_withdraw"), { args: { reason: "x" } }),
    ).toBeNull()
    expect(
      checkToolScopeTaint(TAINTED, entry("approval_update_payload"), { args: { fields: {} } })
        ?.code,
    ).toBe("E_SCOPE_TAINT_BLOCKED")
  })

  it("the enforcing-sink annotations are allowed and the contacts annotation is blocked under taint", () => {
    const table = (name: string) => toolRegistry.get([ORG_ID, "kernel", name])?.writesToTable ?? ""
    for (const name of ["threads_reply", "user_memory_set", "capture_business_knowledge"]) {
      expect(checkScopeTaint(["a:b:read"], table(name))).toEqual({ allowed: true })
    }
    expect(checkScopeTaint(["a:b:read"], table("contacts_write"))).toEqual(BLOCKED)
  })

  it("exactly the provably read-only kernel tools carry readOnly, and none of them declares a write target", () => {
    const marked: string[] = []
    for (const [[orgId, appName, toolName], entry] of toolRegistry.entries()) {
      if (orgId !== ORG_ID || appName !== "kernel") continue
      if (entry.readOnly === true) {
        marked.push(toolName)
        expect(entry.writesToTable).toBeUndefined()
      }
    }
    // Writers and egress tools (web_search, web_fetch) are deliberately absent: an unmarked
    // tool counts as a write.
    expect(marked.sort()).toEqual(
      [
        // Its only write is the result cache on the file row, and that holds an unbriefed
        // analysis only (drawn from the file alone, none of the turn's data).
        "analyze_media",
        // The org's model settings; its OpenRouter search filters the catalogue fetched whole
        // from the fixed host, so no text of the turn goes out. Writes nothing.
        "ai_models_get",
        "approval_policy_get",
        "approvals_list",
        "audit_search",
        // The entry a deferred tool is called through (call-tool.ts, #499): marked readOnly
        // as it runs nothing itself; the tool it reaches carries its own annotation.
        "call_tool",
        // Listing the sessions importable from the person's computer: its only write is
        // the owner-bound, expiring import offer per row (bookkeeping, none of the turn's data).
        "computer_session_import_list",
        // Listing and reading the person's own computer sessions writes nothing.
        "computer_session_list",
        "computer_session_read",
        // Config as code: the plan and the export read the org's configuration, never write it.
        "config_export",
        "config_plan",
        // Company reads: search, one company, the duplicate scan and the proposals write nothing.
        "companies_find_duplicates",
        "companies_propose_from_contacts",
        "companies_read",
        "companies_search",
        // A company's timeline reads each app as the caller and stores nothing.
        "company_timeline",
        "contacts_addresses_list",
        "contacts_find_duplicates",
        "contacts_group_members",
        "contacts_groups_list",
        // A contact's identifiers (id, email, company id) for an app's own check: one select.
        "contacts_identity",
        "contacts_read",
        "contacts_search",
        // Dashboards and the app data store: reads of saved dashboards, the eligible sources,
        // one block's preview (its bridge refuses every write), and declared collections.
        "dashboards_get",
        "dashboards_history",
        "dashboards_list",
        "dashboards_preview_block",
        "dashboards_snapshot",
        "dashboards_sources",
        // Dashboard tables: the tables the person sees, one table, its rows.
        "tables_get",
        "tables_list",
        "tables_query",
        "data_collections_list",
        "data_get",
        "data_query",
        "describe_user_access",
        // The printable record types and the org's document templates; they write nothing.
        "document_record_types_list",
        "document_template_get",
        "document_templates_list",
        // The org's needed-template rules, read under the caller's RLS; writes nothing.
        "document_rules_list",
        // Which templates given records need, by the same rules; writes nothing.
        "document_rules_match",
        // 2026-09-25: resolves which apps can export and returns a download URL; the
        // download route reads under the caller's own RLS. It writes nothing.
        "export",
        "files_list",
        "files_read",
        // S19: the repositories on the person's computer and the ones its gh and glab
        // reach. Like the import listing, the only write is the owner-bound, expiring
        // share offer per repository (bookkeeping, none of the turn's data).
        "find_repos_on_my_computer",
        "get_role",
        // Deployment facts for a Google OAuth client (setup-guide-tools.ts); writes nothing.
        "google_setup",
        // The import kinds and their record schemas (manifest declarations, no
        // org record), and one import run's status and report: they write nothing.
        "import_kinds",
        // The shipped example transforms: repository files, no org record.
        "import_reference",
        // The first records of an uploaded export, parsed: it writes nothing.
        "import_sample",
        "import_status",
        "list_dimensions",
        "list_locked_capabilities",
        "list_my_remote_repos",
        "list_routine_events",
        "list_routines",
        "list_scopes",
        "list_skills",
        "mail_attachment_read",
        // The card for the person's own mailbox (mailbox-setup-tool.ts): it reads their
        // mailboxes and encryption settings; the card's own route does any change.
        "mailbox_setup",
        // P4m: recall. It reads files, episodes and the verbatim transcript,
        // and the only row it touches is the recall COUNTER on what it
        // returned, which carries no content and is no laundering sink. A
        // tainted turn must still be able to recall, so this cannot be a write.
        // P4m: one closed episode read back by id. Same recall family as
        // memory_search and memory_open, and it writes nothing.
        "memory_episode",
        // P4m: the verbatim window behind a transcript hit, per message
        // visibility checked and writing nothing at all.
        "memory_open",
        "memory_search",
        // P4m: reading one memory file or listing a folder, nothing else.
        "memory_view",
        "merge_imported_user_preview",
        // S17: reads the caller's own notification settings, writes nothing.
        "notifications_get",
        "open_app",
        // Lists what marked the conversation, from its own history; writes nothing.
        "outside_text_sources",
        "policy_get",
        // Product attributes by SKU, read under the caller's RLS; writes nothing.
        "product_attributes_list",
        "roles_list",
        // Reads the tool registry and the scope catalog, never an org record (f783b90c9).
        "routine_tool_scopes",
        // What is left to set up in the workspace (setup-state-tool.ts); writes nothing.
        "setup_state",
        // The Shopify Dev Dashboard steps from deployment facts and the manifest; writes nothing.
        "shopify_setup",
        // Reads a person's hidden sidebar apps, writes nothing.
        "sidebar_apps_get",
        "skill_read",
        "skill_search",
        "subagent_get",
        "subagent_list",
        // Chips under the reply, drawn on the requester's own screen; a chip only sends its
        // label as the person's next message, so it writes nothing.
        "suggest_next_steps",
        "threads_list",
        "threads_read",
        "threads_search",
        "tool_search",
        "user_memory_get",
        "users_list",
        "users_search",
      ].sort(),
    )
  })
})

describe("rule 8: the card line and the no-decider refusal of a parked tainted write", () => {
  const TAINT = [
    "boxtal:shipments:read",
    "shopify:fulfillments:read",
    "kernel:contacts:read",
    "tickets:tickets:read",
    ...UNKNOWN_TURN_TAINT,
  ]

  it("names the apps the data came from, never the unknown sentinel or a wildcard", () => {
    expect(taintSourceApps([...TAINT, "*"])).toEqual(["boxtal", "contacts", "shopify", "tickets"])
  })

  it("says where it would be shown and that approving discloses it, within the card's line cap", () => {
    const tickets = [
      { name: "ticket", tableName: "tickets" },
      { name: "message", tableName: "messages" },
    ]
    const mail = [
      { name: "conversation", tableName: "conversations" },
      { name: "outbound_staging", tableName: "accounts" },
    ]
    const line = taintDisclosureLine(TAINT, taintSurfaceLabel(["app_tickets.tickets"], tickets))
    expect(line).toBe(
      "Drafted after reading boxtal, contacts, shopify, tickets data that some people who can read this ticket cannot see: approving shares it with them.",
    )
    // Mail's reply declares no writesToTable; its resourceOwner table names the conversation.
    expect(taintSurfaceLabel([undefined, "conversations"], mail)).toBe("this conversation")
    expect(
      taintSurfaceLabel(["app_boxtal.app_config"], [{ name: "shipment", tableName: "shipments" }]),
    ).toBe("app_boxtal.app_config")
    expect(taintSurfaceLabel([undefined], [])).toBe("where it is written")
    const many = Array.from({ length: 40 }, (_, i) => `app${i}:things:read`)
    expect(taintDisclosureLine(many, "this ticket").length).toBeLessThanOrEqual(200)
  })

  it("the no-decider refusal names the deciding scope and the remedy, never a new conversation", () => {
    const text = SCOPE_TAINT_NO_DECIDER_MESSAGE(["boxtal:shipments:read"], "tickets:approve")
    expect(text).toStartWith("NOT EXECUTED")
    expect(text).toContain("nobody holding tickets:approve")
    expect(text).toContain("boxtal:shipments:read")
    expect(text).toContain("an admin adjusts scopes")
    expect(text).toContain("Starting a new conversation is NOT possible")
  })
})

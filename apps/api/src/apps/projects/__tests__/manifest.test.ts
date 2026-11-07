// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"
import projectsManifest from "../app.manifest.json"
import { projectsAppManifest } from "../manifest-descriptor"

// The app guide is a short core plus sections keyed by the tools they are
// about (app-guide.ts); these assertions read the whole guide.
type ManifestGuide = string | { core: string; sections?: Array<{ tools: string[]; text: string }> }
const guideText = (m: { agentInstructions?: unknown }): string => {
  const g = m.agentInstructions as ManifestGuide | undefined
  if (!g) return ""
  return typeof g === "string" ? g : [g.core, ...(g.sections ?? []).map((s) => s.text)].join("\n\n")
}

describe("projects.manifest", () => {
  it("declares the heading over its attention items, in the words and catalog key Home shows", () => {
    expect(projectsManifest.attention.groupLabel).toEqual({
      label: "Tasks",
      labelKey: "kernel.homeGroupTasks",
    })
  })

  it("projects.manifest.validates", () => {
    const result = validateAppManifest(projectsManifest)
    if (!result.success) {
      throw new Error(`projects manifest invalid: ${result.error}`)
    }
    expect(result.success).toBe(true)
  })

  it("projects.manifest.tab-types-and-activity-bar", () => {
    expect(projectsAppManifest.views.tabTypes.home).toBeDefined()
    expect(projectsAppManifest.views.tabTypes.project.referenceable).toBe(true)
    expect(projectsAppManifest.views.tabTypes.task.referenceable).toBe(true)
    expect(projectsAppManifest.views.tabTypes.home.referenceable).toBe(false)
    expect(projectsAppManifest.views.activityBar.icon).toBe("ProjectsIcon")
  })

  it("projects.manifest.events-emit-task-moved", () => {
    expect(projectsAppManifest.events.emits).toContain("task:moved")
    expect(projectsAppManifest.events.emits).toContain("project:created")
    expect(projectsAppManifest.events.emits).toContain("project:updated")
    expect(projectsAppManifest.events.emits).toContain("project:archived")
    expect(projectsAppManifest.events.emits).toContain("project:restored")
  })

  it("projects.manifest.gated-tools-declare-a-stage-time-preflight", async () => {
    // A gated call must not be parked for a human when the data it needs is
    // missing: every gated tool names a preflight the kernel runs BEFORE the
    // approval is created, and that export must exist in the handler bundle.
    const tools = projectsManifest.tools as Record<string, { gated?: boolean; preflight?: string }>
    const gated = Object.entries(tools).filter(([, t]) => t.gated)
    expect(gated.length).toBeGreaterThan(0)
    expect(gated.filter(([, t]) => typeof t.preflight !== "string").map(([n]) => n)).toEqual([])
    const source = await Bun.file(new URL("../handlers.ts", import.meta.url)).text()
    for (const [, tool] of gated) {
      expect(source).toContain(`async function ${tool.preflight}(`)
    }
  })

  it("projects.manifest.version-bumped-for-checklist-tools", () => {
    // Pinned so the next change that touches this manifest is forced to bump
    // the version again (the runtime skips re-registration when the version
    // is unchanged — see apps/api CLAUDE.md's bundled-app version gotcha).
    // 1.7.6: the CI section moved to the declarative settings page.
    // 1.7.7: createProject takes the project's tasks (one approval for the whole plan).
    // 1.7.9: task labels
    // 1.10.2: more French and English tool search words
    // 1.10.3: approval_route_read says who an approval about a task is for; Home passes on.
    // 1.10.5: its attention heading is declared in the manifest.
    expect(projectsManifest.version).toBe("1.10.5")
  })

  it("projects.manifest.task-labels", () => {
    const m = projectsManifest as unknown as {
      tools: Record<string, any>
      bulk: Record<string, any>
      roles: Record<string, { scopes: string[] }>
      events: { emits: string[] }
      views: { wsHandlers: Record<string, string> }
      agentInstructions: { sections: Array<{ tools: string[]; text: string }> }
    }
    const t = m.tools
    for (const name of ["create", "update"]) {
      const labels = t[name].params.properties.labels
      expect(labels.type).toBe("object")
      expect(labels.additionalProperties).toEqual({ type: ["string", "null"] })
    }
    const byProject = t.tasks_byProject.params.properties
    expect(byProject.labels.type).toBe("object")
    expect(byProject.labels.additionalProperties).toEqual({ type: "string" })
    expect(byProject.completedAfter.type).toBe("string")
    expect(byProject.completedBefore.type).toBe("string")

    const expected: Record<string, { scope: string; handler: string; hidden: boolean }> = {
      "labels.list": { scope: "projects:projects:read", handler: "labelsList", hidden: false },
      "labels.tree": { scope: "projects:projects:read", handler: "labelsTree", hidden: true },
      "labels.create": { scope: "projects:labels:admin", handler: "labelsCreate", hidden: false },
      "labels.update": { scope: "projects:labels:admin", handler: "labelsUpdate", hidden: false },
      "labels.archive": { scope: "projects:labels:admin", handler: "labelsArchive", hidden: false },
      "labels.reorder": { scope: "projects:labels:admin", handler: "labelsReorder", hidden: true },
    }
    for (const [name, want] of Object.entries(expected)) {
      const tool = t[name]
      expect(tool, name).toBeDefined()
      expect(tool.requiredScopes).toEqual([want.scope])
      expect(tool.handler).toBe(want.handler)
      expect(tool.trustBoundary).toBe("user")
      expect(tool.gated).toBeUndefined()
      expect(tool.agentVisible === false).toBe(want.hidden)
    }
    for (const name of ["labels.create", "labels.update", "labels.archive", "labels.reorder"]) {
      expect(t[name].writesToTable).toBe("app_projects.labels")
    }
    for (const name of ["labels.list", "labels.tree"]) {
      expect(t[name].readsFromTable).toBe("app_projects.labels")
      expect(t[name].readOnly).toBe(true)
    }

    expect(m.bulk.setLabels).toEqual({
      label: "Set labels…",
      underlyingTool: "update",
      dispatchMode: "perItem",
      perItemParam: "taskId",
      sharedFields: ["labels"],
      agentTool: "bulkUpdate",
      customForm: "SetTaskLabelsForm",
    })
    expect(m.roles.admin!.scopes).toContain("projects:labels:admin")
    for (const action of ["created", "updated", "archived", "restored", "reordered"]) {
      expect(m.events.emits).toContain(`label:${action}`)
    }
    expect(m.views.wsHandlers.label).toBe("handleLabelEvent")
    const guide = m.agentInstructions.sections.map((s) => s.text).join("\n")
    expect(guide).toContain("completedAfter")
    expect(guide).toContain("labels.list")
  })

  // Settings > Apps labels each connection with its purpose and demotes the
  // optional ones (a bare "Connect" made a working app look uninstalled).
  it("declares what each connection connects, and which ones are optional", () => {
    const c = (
      projectsManifest as unknown as {
        connections: Record<string, { purpose?: string; optional?: boolean }>
      }
    ).connections
    expect(c["ci-source"]?.purpose).toBe("CI release-status webhook")
    expect(c["ci-source"]?.optional === true).toBe(true)
  })

  it("projects.manifest.checklist-tools-shapes-and-gating", async () => {
    // Spec S13: five checklist tools, only the removal gated (with a preflight
    // and a summarizer the registration can load).
    type Tool = {
      handler: string
      gated?: boolean
      readOnly?: boolean
      preflight?: string
      summarizer?: string
      requiredScopes: string[]
      params: {
        properties: Record<string, any>
        required?: string[]
      }
    }
    const tools = projectsManifest.tools as unknown as Record<string, Tool>
    const get = tools.checklist_get!
    expect(get.readOnly).toBe(true)
    expect(get.gated).toBeUndefined()
    expect(get.requiredScopes).toEqual(["projects:tasks:read"])
    expect(get.params.required).toEqual(["taskId"])

    const add = tools.checklist_add_items!
    expect(add.gated).toBeUndefined()
    expect(add.params.required).toEqual(["taskId", "items"])
    expect(add.params.properties.items.maxItems).toBe(50)
    expect(add.params.properties.items.items.required).toEqual(["title"])

    const upd = tools.checklist_update_item!
    expect(upd.gated).toBeUndefined()
    expect(Object.keys(upd.params.properties).sort()).toEqual([
      "afterItemId",
      "beforeItemId",
      "details",
      "itemId",
      "title",
    ])

    const setv = tools.checklist_set_validation!
    expect(setv.gated).toBeUndefined()
    expect(Object.keys(setv.params.properties).sort()).toEqual([
      "entries",
      "itemId",
      "level",
      "note",
      "source",
      "state",
    ])
    expect(setv.params.properties.state.enum).toEqual(["not_done", "fail", "success", "na"])
    expect(setv.params.properties.entries.maxItems).toBe(50)
    expect(setv.params.properties.entries.items.required).toEqual(["itemId", "level", "state"])

    const rm = tools.checklist_remove_item!
    expect(rm.gated).toBe(true)
    expect(rm.preflight).toBe("checklistRemoveItemPreflight")
    expect(rm.summarizer).toBe("summarizeRemoveChecklistItem")
    expect(rm.params.required).toEqual(["itemId"])
    const summarizers = (await import("../summarizers")) as Record<string, unknown>
    expect(typeof summarizers.summarizeRemoveChecklistItem).toBe("function")

    // release on the task writes and the two list filters; levels on createProject.
    for (const name of ["create", "update", "tasks_byProject", "tasks_byAssignee"]) {
      expect(tools[name]!.params.properties.release, `${name}.release`).toBeDefined()
    }
    const levels = tools.createProject!.params.properties.validationLevels
    expect(levels.type).toBe("array")
    expect(levels.items.required).toEqual(["name"])
    expect(Object.keys(levels.items.properties)).toEqual(["name"])
    expect(tools.createProject!.params.properties.checklistOnCards.type).toBe("boolean")
    const setvDesc = (setv as unknown as { description: string }).description
    expect(setvDesc).not.toContain("checklist_level_not_agent")
    expect(setvDesc).not.toContain("checklist_source_required")
  })

  it("projects.manifest.ws-handler-for-checklist-item-events", () => {
    // Item writes emit `task_checklist_item` events; the web store applies them
    // through this handler (exported by the projects web module).
    expect(projectsAppManifest.views.wsHandlers).toMatchObject({
      task: "handleTaskEvent",
      task_checklist_item: "handleChecklistItemEvent",
    })
  })

  it("projects.manifest.agent-instructions-cover-checklists", () => {
    // Spec S13, D13-D15: agents record what the human tells them on any level,
    // always note a fail, may move to Done but must read the warning and say
    // so, add items only once the human agreed, never remove without approval.
    const m = projectsManifest as unknown as {
      agentInstructions: { sections: Array<{ tools: string[]; text: string }> }
    }
    const section = m.agentInstructions.sections.find((s) =>
      s.text.startsWith("CHECKLISTS AND VALIDATION LEVELS"),
    )
    expect(section).toBeDefined()
    expect(section!.tools).toEqual(
      expect.arrayContaining(["checklist_set_validation", "checklist_add_items", "update", "move"]),
    )
    const text = section!.text
    expect(text).toContain("RECORD WHAT THE HUMAN TELLS YOU")
    expect(text).toContain("on any level")
    expect(text).toContain("never invent a verdict")
    expect(text).toContain("A `fail` always needs a `note`")
    expect(text).toContain("the checklist never blocks a status change")
    expect(text).toContain("`checklistWarning`")
    expect(text).toContain("say plainly to the user which items are not proven")
    expect(text).toContain("`bulkUpdate` returns it on each affected item")
    expect(text).toContain("and `update` returns it in its result")
    expect(text).not.toContain("`update` (gated)")
    expect(text).toContain("only after the human validated the list")
    expect(text).toContain("NEVER remove items without the human's approval")
    for (const gone of ["checklist_done_requires_human", "agent access", "with_source"]) {
      expect(text).not.toContain(gone)
    }
  })

  it("projects.manifest.a-board-is-created-with-the-columns-the-user-named", () => {
    // A user asked for a roadmap with idea / in discussion / candidate / todo /
    // in progress / done and got backlog/todo/in_progress/done/cancelled: the
    // tool had no way to say which columns, and the agentInstructions told the
    // agent (falsely) that no tool creates project statuses, so it never fixed
    // the board up afterwards either. The `statuses` param is the fix; the
    // instructions must point at it and at status_update for renames.
    const m = projectsManifest as {
      agentInstructions: unknown
      tools: Record<string, { params?: { properties?: Record<string, unknown> } }>
    }
    const statuses = m.tools.createProject?.params?.properties?.statuses as {
      type: string
      items: { required: string[]; properties: Record<string, unknown> }
    }
    expect(statuses?.type).toBe("array")
    expect(statuses.items.required).toEqual(["label"])
    expect(Object.keys(statuses.items.properties).sort()).toEqual(["color", "label", "terminal"])
    expect(guideText(m)).toContain("`createProject` as `statuses`")
    expect(guideText(m)).toContain("`status_update` (rename")
    expect(guideText(m)).not.toContain("no agent tool creates project statuses")
    expect(guideText(m)).not.toContain("There is NO `instantiate_template`")
  })

  it("projects.manifest.status-tools-tell-mcp-agents-to-read-the-checklist-warning", () => {
    // Agent instructions reach only the in-app agent; an MCP client sees tool
    // descriptions. The tools that can change a status must carry the rule:
    // Done is allowed, the result's warning must be read and told to the user.
    const m = projectsManifest as { tools: Record<string, { description?: string }> }
    for (const name of ["update", "move"]) {
      const desc = m.tools[name]?.description ?? ""
      expect(desc, `${name}.description`).toContain("checklist is incomplete")
      expect(desc, `${name}.description`).toContain("`checklistWarning`")
      expect(desc, `${name}.description`).toContain("tell the user")
      expect(desc, `${name}.description`).not.toContain("checklist_done_requires_human")
    }
    // `update` runs directly since 2026-09-28: its own result carries the warning,
    // and nothing may still tell the agent to wait for an approval.
    const update = m.tools.update?.description ?? ""
    expect(update).toContain("the result carries `checklistWarning`")
    expect(update).not.toContain("once a human approves")
    expect(update).not.toContain("GATED")
  })

  it("projects.manifest.task-bodies-are-markdown-and-can-link-documents", () => {
    // The task page renders the description as markdown with entity mentions;
    // a spec linked as `@[Title](knowledge:source_link:<id>)` shows as a
    // collapsible preview on the card. The tool schema has to say so, or the
    // agent keeps pasting bare Drive URLs that render as plain links.
    const m = projectsManifest as {
      agentInstructions: unknown
      tools: Record<string, { params?: { properties?: Record<string, { description?: string }> } }>
    }
    for (const name of ["create", "update"]) {
      const desc = m.tools[name]?.params?.properties?.description?.description ?? ""
      expect(desc, `${name}.description`).toContain("knowledge:source_link:<id>")
      expect(desc, `${name}.description`).toContain("knowledge:document:<id>")
      expect(desc, `${name}.description`).toContain("kernel:file:<id>")
    }
    expect(guideText(m)).toContain("SPEC DOCUMENTS ON A ROADMAP ITEM")
  })

  it("projects.manifest.task-write-tools-constrain-priority-to-the-column-CHECK", () => {
    // `app_projects.tasks.priority` carries CHECK (priority IN
    // ('low','normal','high','urgent')). `create`/`update` used to advertise it
    // as a free-form string ("Optional priority (e.g. normal, high)."), so an
    // agent filed a task with the plausible-but-invalid "medium" and the call
    // died as a raw postgres "Failed query: INSERT INTO app_projects.tasks ..."
    // dump. The enum on the tool schema is the prevention; assertTaskPriority
    // is the net under it.
    const tools = (
      projectsManifest as {
        tools: Record<string, { params?: { properties?: Record<string, { enum?: string[] }> } }>
      }
    ).tools
    for (const name of ["create", "update"]) {
      expect(tools[name]?.params?.properties?.priority?.enum, `${name}.priority.enum`).toEqual([
        "low",
        "normal",
        "high",
        "urgent",
      ])
    }
  })

  it("projects.manifest.agent-facing-texts-no-longer-call-the-direct-tools-gated", () => {
    // S27: every text that told the agent create/update/status_add/status_update
    // land as approvals is rewritten, or the agent reports done work as pending.
    const m = projectsManifest as unknown as {
      agentInstructions: unknown
      tools: Record<string, { description?: string }>
    }
    for (const name of ["create", "update", "status_add", "status_update"]) {
      const desc = m.tools[name]?.description ?? ""
      expect(desc, `${name}.description`).not.toContain("GATED")
      expect(desc, `${name}.description`).not.toContain("pending approval")
      expect(desc, `${name}.description`).toContain("Not gated")
    }
    const guide = guideText(m)
    expect(guide).not.toContain("all three are GATED")
    expect(guide).not.toContain("`status_add` (gated")
    expect(guide).toContain("`status_delete` is GATED")
    expect(m.tools.status_delete?.description).toContain("GATED")
    expect(m.tools.delete?.description ?? "").toMatch(/gated|approval/i)
  })
  it("projects.manifest.searchable-entities-declare-indexFields (PRJ-2)", () => {
    // `searchable: true` alone is not enough: buildSearchDocument only sets a
    // document's title/body from `indexFields`, so a searchable entity with no
    // indexFields is indexed with no title and is unfindable by any text
    // query. Both `project` and `task` were missing this declaration.
    const entities = (
      projectsManifest as {
        entities: Record<string, { searchable?: boolean; indexFields?: { title: string } }>
      }
    ).entities
    for (const [name, entity] of Object.entries(entities)) {
      if (!entity.searchable) continue
      expect(entity.indexFields?.title, `${name}.indexFields.title`).toBeTruthy()
    }
  })

  it("projects.manifest.declares-kernel-dependency", () => {
    expect(projectsAppManifest.dependencies?.required).toContain("kernel")
  })

  it("projects.manifest.exposes-attentionItems-as-a-self-scoped-read-tool", () => {
    // Regression (my-overdue-tasks-standup): attentionItems used to be ONLY a
    // `views` handler (not agent-callable), so the agent reached for `search`
    // (returns PROJECTS, not tasks) and could not answer "what's overdue / due
    // this week assigned to me". It is now a self-scoped read TOOL wired to the
    // existing computeAttentionItems handler — no id/assignee param required.
    const tools = (
      projectsManifest as {
        tools: Record<
          string,
          { handler: string; requiredScopes: string[]; params?: { required?: string[] } }
        >
      }
    ).tools
    const tool = tools.attentionItems
    expect(tool).toBeDefined()
    expect(tool.handler).toBe("computeAttentionItems")
    expect(tool.requiredScopes).toEqual(["projects:tasks:read"])
    expect(tool.params?.required ?? []).toEqual([])
  })

  it("projects.manifest.read-and-ungated-write-tools-opt-into-transient-db-auto-retry (BL-180 + BL-275)", () => {
    // BL-180: concurrent projects writes (several `create` in one turn) intermittently
    // hit transient DB write-contention under full chaos-world load. The pure-transactional
    // DB-write tools opt into a side-effect-safe auto-retry (a serialization/deadlock aborts
    // the txn atomically → re-issue is not a duplicate).
    //
    // BL-275 (stale-task-sweeper-routine re-gate): a transient DB blip (serialization /
    // deadlock / connection blip — `isTransientDbError`) on a READ tool ALSO surfaced as the
    // `transient_db_error` envelope, and the weak agent — instead of retrying the SAME read —
    // ABANDONED the entire project it was reading and reported only partial coverage (a
    // one-project-only sweep digest that the runtime judge correctly failed). The original
    // BL-180 reasoning ("read tools must NOT auto-retry — no write to retry") was BACKWARDS:
    // a read has NOTHING to commit, so re-issuing it is the SAFEST possible auto-retry —
    // perfectly idempotent, zero duplicate risk. So the read tools NOW opt in too, fixing the
    // blip server-side (2 retries, fresh transaction each) so it never reaches the agent.
    //
    // The gated delete/merge writes stay OFF: they are serialized by approval and the
    // agent-retry fallback covers them; auto-retry there interacts with the approval/idempotency
    // path, so leave them to the existing fallback — assert the flag lands on EVERY read tool
    // plus the ungated write tools, and NOT on the gated delete/merge.
    const tools = (
      projectsManifest as { tools: Record<string, { retryOnTransientDbError?: boolean }> }
    ).tools
    for (const name of [
      // ungated writes (BL-180)
      "move",
      "createProject",
      "instantiate_template",
      "add_dependency",
      // idempotent reads (BL-275) — a transient blip on a read must never reach the agent
      "search",
      "get",
      "tasks_byProject",
      "tasks_byAssignee",
      "attentionItems",
      "portfolio_rollup",
      "labels.list",
      "labels.tree",
    ]) {
      expect(tools[name]?.retryOnTransientDbError).toBe(true)
    }
    // Gated writes stay on the approval-serialized agent-retry fallback, not server auto-retry.
    // create/update were gated from 2026-07-10 to 2026-09-28 and left the auto-retry list then;
    // un-gating them did not opt them back in.
    for (const name of ["delete", "merge", "create", "update"]) {
      expect(tools[name]?.retryOnTransientDbError).toBeUndefined()
    }
  })

  it("projects.manifest.create-update-status_add-status_update-are-direct; destructive tools stay gated", () => {
    // Owner ruling 2026-09-28: an agent creates and edits tasks and adds or
    // renames columns without an approval card. Deleting, merging, dropping a
    // column and removing a checklist item stay gated, each with its preflight
    // and a summarizer that names what the reviewer is approving.
    const APPROVAL_KEYS = [
      "gated",
      "approvalImpact",
      "editableFields",
      "summarizer",
      "approvalExpiryHours",
      "preflight",
    ]
    const tools = projectsManifest.tools as unknown as Record<string, Record<string, unknown>>
    for (const name of ["create", "update", "status_add", "status_update"]) {
      const declared = APPROVAL_KEYS.filter((k) => k in tools[name]!)
      expect(declared, `${name} declares approval keys`).toEqual([])
    }
    const stillGated: Array<[string, string, string]> = [
      ["delete", "deleteTaskPreflight", "summarizeDeleteTask"],
      ["merge", "mergeTasksPreflight", "summarizeMergeTasks"],
      ["status_delete", "deleteStatusPreflight", "summarizeDeleteStatus"],
      ["checklist_remove_item", "checklistRemoveItemPreflight", "summarizeRemoveChecklistItem"],
    ]
    for (const [name, preflight, summarizer] of stillGated) {
      expect(tools[name]!.gated, `${name}.gated`).toBe(true)
      expect(tools[name]!.preflight, `${name}.preflight`).toBe(preflight)
      expect(tools[name]!.summarizer, `${name}.summarizer`).toBe(summarizer)
    }
    const gatedNames = Object.entries(tools)
      .filter(([, t]) => t.gated === true)
      .map(([n]) => n)
      .sort()
    expect(gatedNames).toEqual(["checklist_remove_item", "delete", "merge", "status_delete"])
  })

  it("projects.manifest.get-accepts-explicit-taskId-and-projectId (task detail regression)", () => {
    // The web task detail view calls projects:get with { taskId } and the RPC
    // bridge has always resolved id / taskId / projectId. Strict tool-param
    // validation rejected the undeclared keys and every task tab crashed with
    // "taskId is not a recognised parameter" — the schema must declare all three.
    const params = (
      projectsManifest as {
        tools: Record<
          string,
          { params: { properties: Record<string, unknown>; required?: string[] } }
        >
      }
    ).tools.get.params
    expect(Object.keys(params.properties).sort()).toEqual(["id", "projectId", "taskId"])
    expect(params.required ?? []).toEqual([])
  })

  it("projects.manifest.task-declares-fileParent", () => {
    // Tasks must be a valid file-attachment destination: without a `fileParent`
    // declaration the kernel.files SELECT policy has no (projects, task) branch,
    // so any file row parented to a task is RLS-invisible (denied by default per
    // rls-builder.ts). Scopes mirror the member role's task rights — a project
    // member can read a task's attachments and attach files to tasks; removing
    // one is for its uploader or a projects administrator (deleteScope).
    const entities = (
      projectsManifest as {
        entities: Record<string, { fileParent?: Record<string, string> }>
      }
    ).entities
    expect(entities.task.fileParent).toEqual({
      tableName: "tasks",
      schemaRef: "app_projects",
      joinOn: "id",
      readScope: "projects:tasks:read",
      writeScope: "projects:tasks:write",
      deleteScope: "projects:settings:admin",
    })
  })

  it("projects.manifest.createProject-steers-one-task-per-enumerated-item + no-native-object honesty (BL-223)", () => {
    // BL-223 (marco-modular-expo-demo-loaner-tracking): when scaffolding a board/checklist over a
    // KNOWN ENUMERATED SET (6 loaner units, N orders, N rows), a weak model collapsed the N items
    // into 4-5 generic action-category buckets ("clear the exceptions", "coordinate returns") instead
    // of ONE task PER ITEM carrying recipient/id/return-due — and silently presented the improvised
    // projects board as if a purpose-built loaner tracker existed. The createProject affordance now
    // makes per-item the DEFAULT scaffold shape (general project-scaffold-class affordance, the same
    // shape legitimated at l530/l533: one task per order / one task per theme), bounded by budget with
    // an honest partial, and requires the agent to disclose when it has improvised because no native
    // object exists. Assert both steers are present (root cause: the prose only mentioned per-unit
    // inside the budget-partial clause, reading as conditional rather than the default shape).
    const tools = (projectsManifest as { tools: Record<string, { description: string }> }).tools
    const desc = tools.createProject.description
    // per-item scaffold default over an enumerated set
    expect(desc).toContain("ENUMERATED SET")
    expect(desc).toContain("ONE TASK PER ITEM")
    expect(desc).toMatch(/NOT a handful of generic action-category buckets/i)
    // honest partial under budget (carry the rest to the SAME project, never collapse to buckets)
    expect(desc).toMatch(/partial pass/i)
    expect(desc).toMatch(/never collapse to generic buckets/i)
    // disclose improvisation when there is no native object for the tracked thing
    expect(desc).toMatch(/no native (object|X)/i)
    expect(desc).toMatch(/improvis/i)
  })

  it("create task description param steers self-contained, source-cited bodies for web-research tasks", () => {
    // Regression (competitive-teardown-task-with-source-citations): the weak agent fanned web research
    // into one task per comparison axis but filed bodies with the data point + Kestrel 6 angle yet NO
    // source URL and no web-sourced marker — the rubric requires each task to carry a cited Tideboard
    // URL, so the run failed on citation alone (3× judge-confirmed). The fix is on the `create` tool's
    // `description` PARAM (the surface the model reads at the moment it writes the body), not just
    // system.md prose: it must demand a self-contained body carrying the data point, the source URL,
    // and (for a comparison) our contrasting angle.
    const params = (
      projectsManifest as {
        tools: Record<
          string,
          { params?: { properties?: Record<string, { description?: string }> } }
        >
      }
    ).tools.create.params
    const descParam = params?.properties?.description?.description ?? ""
    expect(descParam).toMatch(/SELF-CONTAINED/i)
    expect(descParam).toMatch(/source URL/i)
    expect(descParam).toMatch(/contrasting|angle/i)
    // sourceUrl is the discrete, enforceable citation input — the host appends it to the body so the
    // URL ALWAYS lands in the workspace even when the model drops it from its free-text description.
    const sourceUrlParam = params?.properties?.sourceUrl?.description ?? ""
    expect(sourceUrlParam.length).toBeGreaterThan(20)
    expect(sourceUrlParam).toMatch(/web research/i)
    expect(sourceUrlParam).toMatch(/every|always/i)
  })

  it("create steers an outreach/shortlist task body to carry link + contact + a WHY-RELEVANT note", () => {
    // Regression (influencer-shortlist-project-modular-expo-launch, l588): the weak agent built one task
    // per researched creator with `Channel: <url>\nContact: <email>` but DROPPED the rubric-required
    // per-creator relevance note — even though the web_search snippet handed it the rationale verbatim
    // (2 of 3 gate runs failed on exactly this, judge-confirmed). The fix is on the `create` tool surface
    // (the description the model reads at create time): an outreach/shortlist task body must carry the
    // entity's LINK, any CONTACT, AND a one-line WHY-RELEVANT rationale — all three, on every such task.
    const tools = (
      projectsManifest as {
        tools: Record<
          string,
          {
            description: string
            params?: { properties?: Record<string, { description?: string }> }
          }
        >
      }
    ).tools
    const toolDesc = tools.create.description
    expect(toolDesc).toMatch(/outreach|shortlist/i)
    expect(toolDesc).toMatch(/why[\s-]?relevant|relevance/i)
    // …and the description PARAM (the body-authoring surface) must carry the same requirement, so the
    // model is steered at the exact moment it writes the body, not only in the tool blurb.
    const descParam = tools.create.params?.properties?.description?.description ?? ""
    expect(descParam).toMatch(/outreach|shortlist|researched[\s-]?entity/i)
    expect(descParam).toMatch(/why[\s-]?relevant|relevance/i)
    expect(descParam).toMatch(/required|not optional|incomplete/i)
  })

  it("projects.manifest.exposes-tasks_byProject (BL-151 — list a project's tasks)", () => {
    // BL-151: digest/backlog routines + launch-from-template need to ENUMERATE a project's tasks,
    // which search (title-text) / get (by-id) / tasks_byAssignee (per-person) cannot. tasks_byProject
    // closes that gap, wired to the new listProjectTasks service.
    const tools = (
      projectsManifest as {
        tools: Record<
          string,
          { handler: string; requiredScopes: string[]; params?: { required?: string[] } }
        >
      }
    ).tools
    const tool = tools.tasks_byProject
    expect(tool).toBeDefined()
    expect(tool.handler).toBe("tasksByProject")
    expect(tool.requiredScopes).toEqual(["projects:tasks:read"])
    expect(tool.params?.required ?? []).toEqual(["projectId"])
  })

  it("gated destructive tools (delete/merge) declare a dynamic summarizer that names the task — not an opaque-uuid approvalCard", () => {
    // Integrity (duplicate-task-cleanup-merge, mirrors the l646 contacts_merge scrutiny): a human
    // approving a DESTRUCTIVE op must see WHAT is being deleted/merged — the task TITLE — not a blind
    // "Delete task <uuid>". The old `approvalCard.summary` static template ({{params.taskId}}) was DEAD
    // config (never rendered: nothing in runtime consumes `approvalCard`), so the human only ever saw
    // the default summary (toolName + JSON params = the opaque uuid). The fix routes both gated tools
    // through a dynamic `summarizer` (summarizers.ts) that loads + names the title. Assert the wiring is
    // in place and the dead approvalCard is gone, so a future edit can't silently revert to opacity.
    const tools = (
      projectsManifest as {
        tools: Record<string, { gated?: boolean; summarizer?: string; approvalCard?: unknown }>
      }
    ).tools
    expect(tools.delete.gated).toBe(true)
    expect(tools.delete.summarizer).toBe("summarizeDeleteTask")
    expect(tools.delete.approvalCard).toBeUndefined()
    expect(tools.merge.gated).toBe(true)
    expect(tools.merge.summarizer).toBe("summarizeMergeTasks")
    expect(tools.merge.approvalCard).toBeUndefined()
  })
})

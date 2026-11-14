// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel provider contracts: registration refuses a wrong provider or caller declaration;
// resolution reads the caller's own admin-set binding; the contract dispatch is the only way
// into a `contractOnly` tool; `noAutoApprove` leaves only a human approval (or the approver's
// own click) to run a gated tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  appContractCallsRegistry,
  appContractImplementationsRegistry,
  appCrossAppCallsRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { computeSkipGate, executeToolCore } from "~/modules/apps/execute-tool"
import {
  readKernelContractBinding,
  writeKernelContractBinding,
} from "~/modules/apps/provider-contracts/binding"
import { mintContractGrant } from "~/modules/apps/provider-contracts/grant"
import { resolveContractProvider } from "~/modules/apps/provider-contracts/resolve"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  installPermissiveFilesSelectPolicy,
  restoreFilesSelectPolicy,
} from "~/tests/helpers/files-select-policy"

const OPS = {
  registration_status: "pa_registration",
  find_einvoice: "pa_find",
  submit_einvoice: "pa_submit",
  advance_einvoice: "pa_advance",
  get_einvoice_status: "pa_status",
  list_status_changes: "pa_changes",
  find_booking: "pa_find_booking",
  book_sale: "pa_book",
}
const OP_PARAMS: Record<string, string[]> = {
  pa_registration: [],
  pa_find: ["invoice_number", "issue_date"],
  pa_submit: [
    "document_ref",
    "invoice_number",
    "issue_date",
    "facturx_file_id",
    "legal_original_sha256",
    "cii_xml",
    "buyer",
    "idempotency_key",
    "stream_ref",
    "run_item_ref",
  ],
  pa_advance: [
    "provider_ref",
    "invoice_number",
    "issue_date",
    "document_ref",
    "legal_original_sha256",
    "stream_ref",
    "run_item_ref",
  ],
  pa_status: ["provider_ref"],
  pa_changes: ["cursor"],
  pa_find_booking: ["idempotency_key"],
  pa_book: ["document_ref", "pdf_file_id", "legal_original_sha256", "data", "idempotency_key"],
}

function opTool(name: string, over: Record<string, unknown> = {}) {
  return {
    description: `op ${name}`,
    requiredScopes: ["prov:internal"],
    handler: name,
    trustBoundary: "internal",
    agentVisible: false,
    contractOnly: true,
    params: {
      type: "object",
      properties: Object.fromEntries(OP_PARAMS[name]!.map((p) => [p, {}])),
    },
    ...over,
  }
}

function providerManifest(over: { tools?: Record<string, unknown>; implements?: unknown } = {}) {
  return {
    name: "prov",
    version: "1.0.0",
    scopes: ["prov:internal"],
    tools: {
      ...Object.fromEntries(Object.values(OPS).map((t) => [t, opTool(t)])),
      ...(over.tools ?? {}),
    },
    implements: over.implements ?? [{ contract: "einvoicing-pa", version: 1, tools: OPS }],
  }
}

const errorOf = (m: unknown) => validateAppManifest(m).error ?? ""

describe("registration refusals", () => {
  it("accepts a complete provider", () => {
    expect(validateAppManifest(providerManifest()).error ?? null).toBeNull()
  })
  it("refuses a contract version the kernel does not know", () => {
    expect(
      errorOf(
        providerManifest({ implements: [{ contract: "einvoicing-pa", version: 2, tools: OPS }] }),
      ),
    ).toContain('unknown contract "einvoicing-pa@2"')
  })
  it("refuses a provider missing a required op", () => {
    const { book_sale: _drop, ...rest } = OPS
    expect(
      errorOf(
        providerManifest({ implements: [{ contract: "einvoicing-pa", version: 1, tools: rest }] }),
      ),
    ).toContain('requires op "book_sale"')
  })
  for (const [flag, value, msg] of [
    ["trustBoundary", "user", 'trustBoundary "internal"'],
    ["agentVisible", true, "agentVisible false"],
    ["gated", true, "must not be gated"],
    ["contractOnly", false, "contractOnly true"],
  ] as const) {
    it(`refuses an op tool with ${flag}=${String(value)}`, () => {
      expect(
        errorOf(providerManifest({ tools: { pa_submit: opTool("pa_submit", { [flag]: value }) } })),
      ).toContain(msg)
    })
  }
  it("refuses an op tool that lacks a param the contract requires", () => {
    const t = opTool("pa_submit", {
      params: { type: "object", properties: { invoice_number: {} } },
    })
    expect(errorOf(providerManifest({ tools: { pa_submit: t } }))).toContain(
      'requires param "legal_original_sha256"',
    )
  })
  it("refuses a contractOnly tool no implements entry maps (unreachable)", () => {
    expect(
      errorOf(
        providerManifest({ tools: { stray: { ...opTool("pa_registration"), handler: "stray" } } }),
      ),
    ).toContain("tools.stray: contractOnly but not mapped")
  })
  it("refuses noAutoApprove on an ungated tool, and a caller binding outside its own schema", () => {
    const caller = {
      name: "callr",
      version: "1.0.0",
      scopes: ["callr:write"],
      schema: { settings: { fields: { provider_app: "text?" } } },
      tools: {
        send: {
          description: "s",
          requiredScopes: ["callr:write"],
          handler: "send",
          noAutoApprove: true,
        },
      },
      contract_calls: [{ contract: "einvoicing-pa@1", bindingSetting: "settings.nope" }],
    }
    const err = errorOf(caller)
    expect(err).toContain("noAutoApprove is only meaningful on a gated tool")
    expect(err).toContain('"settings.nope" is not a column')
    expect(
      validateAppManifest({
        ...caller,
        tools: { send: { ...caller.tools.send, gated: true } },
        contract_calls: [{ contract: "einvoicing-pa@1", bindingSetting: "settings.provider_app" }],
      }).error ?? null,
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
const ORG = randomUUID()
const CALLER = "ctcaller"
const SECOND = "ctsecond"
const PROVIDER = "ctprov"
const KEY = "einvoicing-pa@1"
const calls: unknown[] = []

/** The app's own mirror column only (what any app can write in its own schema). */
async function setMirror(app: string, value: string | null) {
  await sql.unsafe(`DELETE FROM app_${app}.settings WHERE org_id = '${ORG}'`)
  if (value !== null)
    await sql.unsafe(
      `INSERT INTO app_${app}.settings (org_id, provider_app) VALUES ('${ORG}', '${value}')`,
    )
}

/** The kernel binding (an administrator's audited path) plus the app's mirror. */
async function setBinding(app: string, value: string | null) {
  await setMirror(app, value)
  await withPrivilegedDb(ORG, "test", (tx) =>
    writeKernelContractBinding(tx as never, {
      orgId: ORG,
      contract: KEY,
      callerApp: app,
      provider: value,
      actorId: null,
      actorType: "system",
      source: "test",
    }),
  )
}

describe("resolution and dispatch", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Contract Org', ${`ct-${ORG.slice(0, 8)}`})`
    for (const app of [CALLER, SECOND]) {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_${app}`)
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS app_${app}.settings (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), provider_app text)`,
      )
      // A real app schema carries the kernel's grants; this stand-in grants the read directly.
      await sql.unsafe(`GRANT USAGE ON SCHEMA app_${app} TO PUBLIC`)
      await sql.unsafe(`GRANT SELECT ON app_${app}.settings TO PUBLIC`)
      appContractCallsRegistry.set([ORG, app], {
        [KEY]: { bindingSetting: "settings.provider_app" },
      })
    }
    appContractImplementationsRegistry.set([ORG, PROVIDER], { [KEY]: { ops: OPS } })
    for (const t of Object.values(OPS)) {
      toolRegistry.set([ORG, PROVIDER, t], {
        appName: PROVIDER,
        name: t,
        description: t,
        requiredScopes: [`${PROVIDER}:internal`],
        trustBoundary: "internal",
        agentVisible: false,
        contractOnly: true,
        handler: async (params: unknown) => {
          calls.push({ tool: t, params })
          return { ok: true, tool: t }
        },
      } as never)
    }
  })

  afterAll(async () => {
    for (const app of [CALLER, SECOND]) await sql.unsafe(`DROP SCHEMA IF EXISTS app_${app} CASCADE`)
    for (const t of Object.values(OPS)) toolRegistry.delete([ORG, PROVIDER, t])
    appContractCallsRegistry.deleteByPrefix([ORG])
    appContractImplementationsRegistry.deleteByPrefix([ORG])
    appCrossAppCallsRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  const system = {
    actorType: "system" as const,
    orgId: ORG,
    purpose: "job" as const,
    scopes: [`${CALLER}:*`],
  }
  const bridgeOf = (app: string, tx: unknown) =>
    createRpcBridge(app, "system", ORG, tx as never, { name: app } as never, [`${app}:*`], "system")
  // A production bridge runs on the run's RLS session, never on a privileged slot.
  const call = (app: string, op: string, params: Record<string, unknown> = {}) =>
    withRlsContext({ ...system, scopes: [`${app}:*`] }, async (tx) =>
      JSON.parse(await bridgeOf(app, tx).contracts_call(KEY, op, JSON.stringify(params))),
    )

  it("unconfigured binding → contract_provider_not_configured, provider never called", async () => {
    await setBinding(CALLER, null)
    calls.length = 0
    const out = await call(CALLER, "registration_status")
    expect(out).toMatchObject({
      status: "error",
      error: { code: "contract_provider_not_configured" },
    })
    expect(calls).toHaveLength(0)
  })

  it("a caller that does not declare the contract is refused", async () => {
    const r = await resolveContractProvider(ORG, "undeclared_app", KEY)
    expect(r).toMatchObject({ ok: false, code: "contract_undeclared" })
  })

  it("a binding naming an app that does not implement the contract is refused", async () => {
    await setBinding(CALLER, "someother")
    const out = await call(CALLER, "registration_status")
    expect(out).toMatchObject({ status: "error", error: { code: "contract_provider_unavailable" } })
  })

  it("dispatches the op to the bound provider's tool through executeToolCore", async () => {
    await setBinding(CALLER, PROVIDER)
    calls.length = 0
    const out = await call(CALLER, "find_einvoice", {
      invoice_number: "FA-1",
      issue_date: "2026-11-02",
    })
    expect(out).toMatchObject({
      status: "completed",
      provider: PROVIDER,
      result: { ok: true, tool: "pa_find" },
    })
    expect(calls).toEqual([
      { tool: "pa_find", params: { invoice_number: "FA-1", issue_date: "2026-11-02" } },
    ])
  })

  it("a second app declaring the contract without its own admin-set binding is not configured", async () => {
    await setBinding(CALLER, PROVIDER)
    await setBinding(SECOND, null)
    const out = await call(SECOND, "registration_status")
    expect(out).toMatchObject({
      status: "error",
      error: { code: "contract_provider_not_configured" },
    })
  })

  it("a contractOnly tool refuses a user, an agent, and a plain app-to-app call (even a declared one)", async () => {
    calls.length = 0
    const user = {
      actorType: "user" as const,
      userId: randomUUID(),
      orgId: ORG,
      scopes: [`${PROVIDER}:*`],
      dimensionGrants: {},
    }
    const agent = { ...user, actorType: "agent" as const, agentId: randomUUID() }
    for (const [actor, origin] of [
      [user, "human-ui"],
      [agent, "in-app-agent"],
    ] as const) {
      const r = await executeToolCore({
        toolName: `${PROVIDER}:pa_submit`,
        orgId: ORG,
        actor: actor as never,
        params: {},
        origin,
      })
      expect("error" in r ? r.error.code : "ran").toBe("forbidden")
    }
    appCrossAppCallsRegistry.set([ORG, CALLER], { targets: [`${PROVIDER}:pa_submit`] })
    const viaExecuteTool = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG,
      actor: system,
      params: {},
      origin: "system",
      internalCall: { callerApp: CALLER },
    })
    expect("error" in viaExecuteTool ? viaExecuteTool.error.code : "ran").toBe("forbidden")
    // A forged contract claim from an app that does not declare the contract.
    const forged = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG,
      actor: system,
      params: {},
      origin: "system",
      internalCall: {
        callerApp: "undeclared_app",
        contractCall: { contract: KEY, op: "submit_einvoice" },
      },
    })
    expect("error" in forged ? forged.error.code : "ran").toBe("forbidden")
    // A claim naming a different op than the tool's.
    const wrongOp = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG,
      actor: system,
      params: {},
      origin: "system",
      internalCall: { callerApp: CALLER, contractCall: { contract: KEY, op: "book_sale" } },
    })
    expect("error" in wrongOp ? wrongOp.error.code : "ran").toBe("forbidden")
    expect(calls).toHaveLength(0)
  })
})

describe("authorization: the binding only an administrator sets, and the dispatch grant of outbound ops", () => {
  const OPS2 = OPS
  const ORG2 = randomUUID()
  const APPROVER = randomUUID()
  const ADMIN_SCOPES = ["kernel:org:admin", `${CALLER}:*`]
  beforeAll(async () => {
    // The caller's legal original below has no registered fileParent; the stand-in
    // org-scoped policy is what a real readable parent grants the caller's RLS check.
    await installPermissiveFilesSelectPolicy()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG2}, 'Contract Org 2', ${`ct2-${ORG2.slice(0, 8)}`})`
    for (const app of [CALLER, SECOND]) {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_${app}`)
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS app_${app}.settings (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), provider_app text)`,
      )
      await sql.unsafe(`GRANT USAGE ON SCHEMA app_${app} TO PUBLIC`)
      await sql.unsafe(`GRANT SELECT ON app_${app}.settings TO PUBLIC`)
      appContractCallsRegistry.set([ORG2, app], {
        [KEY]: { bindingSetting: "settings.provider_app" },
      })
    }
    appContractImplementationsRegistry.set([ORG2, PROVIDER], { [KEY]: { ops: OPS2 } })
    for (const t of Object.values(OPS2)) {
      toolRegistry.set([ORG2, PROVIDER, t], {
        appName: PROVIDER,
        name: t,
        description: t,
        requiredScopes: [`${PROVIDER}:internal`],
        trustBoundary: "internal",
        agentVisible: false,
        contractOnly: true,
        handler: async (params: unknown) => {
          calls.push({ tool: t, params })
          return { ok: true, tool: t }
        },
      } as never)
    }
    await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
      VALUES (${CALLER_FILE}, ${ORG2}, ${CALLER}, 'legal_original', ${randomUUID()}, 'FA-1.pdf', 'application/pdf', 1, ${`orgs/${ORG2}/x`})`
    // The caller's own gated tools: one a person must approve (noAutoApprove), one a policy may approve.
    toolRegistry.set([ORG2, CALLER, "send"], {
      appName: CALLER,
      name: "send",
      description: "send",
      requiredScopes: [`${CALLER}:send`],
      gated: true,
      noAutoApprove: true,
      handler: async () => ({}),
    } as never)
    toolRegistry.set([ORG2, CALLER, "loose"], {
      appName: CALLER,
      name: "loose",
      description: "loose",
      requiredScopes: [`${CALLER}:loose`],
      gated: true,
      handler: async () => ({}),
    } as never)
  })
  afterAll(async () => {
    await restoreFilesSelectPolicy()
    for (const t of Object.values(OPS2)) toolRegistry.delete([ORG2, PROVIDER, t])
    toolRegistry.delete([ORG2, CALLER, "send"])
    toolRegistry.delete([ORG2, CALLER, "loose"])
    appContractCallsRegistry.deleteByPrefix([ORG2])
    appContractImplementationsRegistry.deleteByPrefix([ORG2])
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG2}`
  })
  const mirror = async (app: string, value: string | null) => {
    await sql.unsafe(`DELETE FROM app_${app}.settings WHERE org_id = '${ORG2}'`)
    if (value !== null)
      await sql.unsafe(
        `INSERT INTO app_${app}.settings (org_id, provider_app) VALUES ('${ORG2}', '${value}')`,
      )
  }
  const kernelBind = (app: string, value: string | null) =>
    withPrivilegedDb(ORG2, "test", (tx) =>
      writeKernelContractBinding(tx as never, {
        orgId: ORG2,
        contract: KEY,
        callerApp: app,
        provider: value,
        actorId: null,
        actorType: "system",
        source: "test",
      }),
    )
  const sys = (app: string, tx: unknown, approval?: unknown, opts?: unknown) =>
    createRpcBridge(
      app,
      "system",
      ORG2,
      tx as never,
      { name: app } as never,
      [`${app}:*`],
      "system",
      approval as never,
      opts as never,
    )
  // A production bridge runs on the run's RLS session, never on a privileged slot.
  // Its job context carries the bridged app's scopes, so the caller's file check
  // runs under that app's own RLS reach.
  const run = <T>(fn: (tx: unknown) => Promise<T>, app: string = CALLER) =>
    withRlsContext(
      { actorType: "system", orgId: ORG2, purpose: "job", scopes: [`${app}:*`] },
      (tx) => fn(tx),
    )
  const SUBJECT = {
    document_ref: "doc-1",
    invoice_number: "FA-1",
    legal_original_sha256: "a".repeat(64),
  }
  // The caller's legal original (a kernel file the caller can read).
  const CALLER_FILE = randomUUID()
  const submitParams = (over: Record<string, unknown> = {}) => ({
    ...SUBJECT,
    issue_date: "2026-11-02",
    facturx_file_id: CALLER_FILE,
    cii_xml: "<x/>",
    buyer: {},
    idempotency_key: "k1",
    ...over,
  })

  it("an app that writes its own mirror column is not bound: only the kernel binding counts", async () => {
    await mirror(SECOND, PROVIDER) // the cross-app vector: the app's own code writes its own table
    calls.length = 0
    const out = await run(
      async (tx) =>
        JSON.parse(await sys(SECOND, tx).contracts_call(KEY, "registration_status", "{}")),
      SECOND,
    )
    expect(out).toMatchObject({
      status: "error",
      error: { code: "contract_provider_not_configured" },
    })
    expect(calls).toHaveLength(0)
  })

  it("a mirror that disagrees with the kernel binding refuses the dispatch", async () => {
    await kernelBind(CALLER, PROVIDER)
    await mirror(CALLER, "someother")
    const out = await run(async (tx) =>
      JSON.parse(await sys(CALLER, tx).contracts_call(KEY, "registration_status", "{}")),
    )
    expect(out).toMatchObject({ status: "error", error: { code: "contract_binding_mismatch" } })
    await mirror(CALLER, PROVIDER)
  })

  it("contracts.setBinding: refused to a job, to a non-administrator and to an agent turn; an administrator's own click binds, audited", async () => {
    await kernelBind(SECOND, null)
    const userBridge = (scopes: string[], origin: string, tx: unknown) =>
      createRpcBridge(
        SECOND,
        APPROVER,
        ORG2,
        tx as never,
        { name: SECOND } as never,
        scopes,
        "user",
        undefined,
        {
          origin,
          actor: { actorType: "user", userId: APPROVER, orgId: ORG2, scopes, dimensionGrants: {} },
        } as never,
      )
    for (const make of [
      (tx: unknown) => sys(SECOND, tx),
      (tx: unknown) => userBridge([`${SECOND}:*`], "human-ui", tx),
      (tx: unknown) => userBridge(ADMIN_SCOPES, "in-app-agent", tx),
    ]) {
      const out = await run(async (tx) =>
        JSON.parse(await make(tx).contracts_setBinding(KEY, PROVIDER)),
      )
      expect(out).toMatchObject({ status: "error", error: { code: "contract_binding_forbidden" } })
    }
    expect(await readKernelContractBinding(ORG2, KEY, SECOND)).toBeNull()
    const ok = await run(async (tx) =>
      JSON.parse(
        await userBridge(ADMIN_SCOPES, "human-ui", tx).contracts_setBinding(KEY, PROVIDER),
      ),
    )
    expect(ok).toMatchObject({ status: "ok", provider: PROVIDER, previous: null })
    expect(await readKernelContractBinding(ORG2, KEY, SECOND)).toBe(PROVIDER)
    const [audit] = await sql<Array<{ actor_id: string; changes: unknown }>>`
      SELECT actor_id::text, changes FROM kernel.audit_log WHERE org_id = ${ORG2} AND action = 'contract.binding_changed' AND actor_id IS NOT NULL`
    expect(audit).toMatchObject({
      actor_id: APPROVER,
      changes: { [`${KEY}:${SECOND}`]: { from: null, to: PROVIDER } },
    })
    const bad = await run(async (tx) =>
      JSON.parse(
        await userBridge(ADMIN_SCOPES, "human-ui", tx).contracts_setBinding(KEY, "notaprovider"),
      ),
    )
    expect(bad).toMatchObject({ status: "error", error: { code: "provider_not_available" } })
  })

  it("an outbound op without a grant, or with a forged one, never reaches the provider", async () => {
    await kernelBind(CALLER, PROVIDER)
    await mirror(CALLER, PROVIDER)
    calls.length = 0
    const none = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "submit_einvoice",
          JSON.stringify(submitParams()),
        ),
      ),
    )
    expect(none).toMatchObject({ status: "error", error: { code: "contract_grant_required" } })
    const forged = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "submit_einvoice",
          JSON.stringify(submitParams()),
          JSON.stringify({ grant: "eyJ2IjoxfQ.AAAA" }),
        ),
      ),
    )
    expect(forged).toMatchObject({ status: "error", error: { code: "contract_grant_invalid" } })
    // A read op needs none.
    const read = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "find_einvoice",
          JSON.stringify({ invoice_number: "FA-1", issue_date: "2026-11-02" }),
        ),
      ),
    )
    expect(read).toMatchObject({ status: "completed" })
    expect(calls).toEqual([
      { tool: "pa_find", params: { invoice_number: "FA-1", issue_date: "2026-11-02" } },
    ])
  })

  it("contracts.grant: refused to a job and to a policy-approvable tool; minted in a person's approval of a never-auto-approved tool; bound to the document", async () => {
    const ask = (bridge: Record<string, any>) =>
      bridge.contracts_grant(
        KEY,
        JSON.stringify(["submit_einvoice", "advance_einvoice"]),
        JSON.stringify(SUBJECT),
      )
    const job = await run(async (tx) => JSON.parse(await ask(sys(CALLER, tx))))
    expect(job).toMatchObject({ status: "error", error: { code: "contract_grant_refused" } })
    const loose = await run(async (tx) =>
      JSON.parse(
        await ask(
          sys(CALLER, tx, {
            approvalRequestId: randomUUID(),
            approvalDeciderId: APPROVER,
            toolName: `${CALLER}:loose`,
          }),
        ),
      ),
    )
    expect(loose).toMatchObject({ status: "error", error: { code: "contract_grant_refused" } })
    const read = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx, {
          approvalRequestId: randomUUID(),
          approvalDeciderId: APPROVER,
          toolName: `${CALLER}:send`,
        }).contracts_grant(KEY, JSON.stringify(["find_einvoice"]), JSON.stringify(SUBJECT)),
      ),
    )
    expect(read).toMatchObject({ status: "error", error: { code: "invalid_input" } })
    const { grant } = await run(async (tx) =>
      JSON.parse(
        await ask(
          sys(CALLER, tx, {
            approvalRequestId: randomUUID(),
            approvalDeciderId: APPROVER,
            toolName: `${CALLER}:send`,
          }),
        ),
      ),
    )
    expect(typeof grant).toBe("string")
    // The job presents it later: dispatched.
    calls.length = 0
    const ok = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "submit_einvoice",
          JSON.stringify(submitParams()),
          JSON.stringify({ grant }),
        ),
      ),
    )
    expect(ok).toMatchObject({ status: "completed", result: { tool: "pa_submit" } })
    // Not for another document, not for an op it does not name, not for another app.
    const other = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "submit_einvoice",
          JSON.stringify(submitParams({ document_ref: "doc-2" })),
          JSON.stringify({ grant }),
        ),
      ),
    )
    expect(other).toMatchObject({ status: "error", error: { code: "contract_grant_mismatch" } })
    const book = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "book_sale",
          JSON.stringify({
            document_ref: "doc-1",
            pdf_file_id: randomUUID(),
            legal_original_sha256: "a".repeat(64),
            data: {},
            idempotency_key: "k",
          }),
          JSON.stringify({ grant }),
        ),
      ),
    )
    expect(book).toMatchObject({ status: "error", error: { code: "contract_grant_mismatch" } })
    await kernelBind(SECOND, PROVIDER)
    await mirror(SECOND, PROVIDER)
    const stolen = await run(
      async (tx) =>
        JSON.parse(
          await sys(SECOND, tx).contracts_call(
            KEY,
            "submit_einvoice",
            JSON.stringify(submitParams()),
            JSON.stringify({ grant }),
          ),
        ),
      SECOND,
    )
    expect(stolen).toMatchObject({ status: "error", error: { code: "contract_grant_mismatch" } })
    expect(calls).toHaveLength(1)
  })

  it("an approver's own click of the never-auto-approved tool mints it; the same click on another tool does not", async () => {
    const clickOf = (tool: string, tx: unknown) =>
      createRpcBridge(
        CALLER,
        APPROVER,
        ORG2,
        tx as never,
        { name: CALLER } as never,
        [`${CALLER}:*`],
        "user",
        undefined,
        {
          origin: "human-ui",
          humanAuthorized: true,
          callChain: [`${CALLER}:${tool}`],
          actor: {
            actorType: "user",
            userId: APPROVER,
            orgId: ORG2,
            scopes: [`${CALLER}:*`],
            dimensionGrants: {},
          },
        } as never,
      )
    const minted = await run(async (tx) =>
      JSON.parse(
        await clickOf("send", tx).contracts_grant(
          KEY,
          JSON.stringify(["submit_einvoice"]),
          JSON.stringify(SUBJECT),
        ),
      ),
    )
    expect(typeof minted.grant).toBe("string")
    const refused = await run(async (tx) =>
      JSON.parse(
        await clickOf("loose", tx).contracts_grant(
          KEY,
          JSON.stringify(["submit_einvoice"]),
          JSON.stringify(SUBJECT),
        ),
      ),
    )
    expect(refused).toMatchObject({ status: "error", error: { code: "contract_grant_refused" } })
  })

  it("after a switch of binding: reads of pinned work go through the provider it went through; outbound work approved through it is refused", async () => {
    const PROV2 = "ctprov2"
    appContractImplementationsRegistry.set([ORG2, PROV2], { [KEY]: { ops: OPS2 } })
    for (const t of Object.values(OPS2)) {
      toolRegistry.set([ORG2, PROV2, t], {
        appName: PROV2,
        name: t,
        description: t,
        requiredScopes: [`${PROV2}:internal`],
        trustBoundary: "internal",
        agentVisible: false,
        contractOnly: true,
        handler: async (params: unknown) => {
          calls.push({ tool: `p2:${t}`, params })
          return { ok: true, tool: `p2:${t}` }
        },
      } as never)
    }
    try {
      await kernelBind(CALLER, PROVIDER)
      await mirror(CALLER, PROVIDER)
      const { grant } = await run(async (tx) =>
        JSON.parse(
          await sys(CALLER, tx, {
            approvalRequestId: randomUUID(),
            approvalDeciderId: APPROVER,
            toolName: `${CALLER}:send`,
          }).contracts_grant(KEY, JSON.stringify(["submit_einvoice"]), JSON.stringify(SUBJECT)),
        ),
      )
      await kernelBind(CALLER, PROV2)
      await mirror(CALLER, PROV2)
      calls.length = 0
      const status = JSON.stringify({ provider_ref: "42" })
      const pinnedRead = await run(async (tx) =>
        JSON.parse(
          await sys(CALLER, tx).contracts_call(
            KEY,
            "get_einvoice_status",
            status,
            JSON.stringify({ provider: PROVIDER }),
          ),
        ),
      )
      expect(pinnedRead).toMatchObject({
        status: "completed",
        provider: PROVIDER,
        result: { tool: "pa_status" },
      })
      const currentRead = await run(async (tx) =>
        JSON.parse(await sys(CALLER, tx).contracts_call(KEY, "get_einvoice_status", status)),
      )
      expect(currentRead).toMatchObject({
        status: "completed",
        provider: PROV2,
        result: { tool: "p2:pa_status" },
      })
      // Outbound: pinned to the old PA, or unpinned with a grant from the old binding: refused.
      for (const opts of [{ grant, provider: PROVIDER }, { grant }]) {
        const out = await run(async (tx) =>
          JSON.parse(
            await sys(CALLER, tx).contracts_call(
              KEY,
              "submit_einvoice",
              JSON.stringify(submitParams()),
              JSON.stringify(opts),
            ),
          ),
        )
        expect(out).toMatchObject({ status: "error", error: { code: "contract_provider_changed" } })
      }
      // A provider this app was never bound to cannot be read through by pinning it.
      const never = await run(
        async (tx) =>
          JSON.parse(
            await sys(SECOND, tx).contracts_call(
              KEY,
              "get_einvoice_status",
              status,
              JSON.stringify({ provider: PROV2 }),
            ),
          ),
        SECOND,
      )
      expect(never).toMatchObject({ status: "error" })
      expect(calls.map((c) => (c as { tool: string }).tool)).toEqual(["pa_status", "p2:pa_status"])
    } finally {
      for (const t of Object.values(OPS2)) toolRegistry.delete([ORG2, PROV2, t])
      appContractImplementationsRegistry.delete([ORG2, PROV2])
    }
  })

  it("the provider runs on its own data only: none of the caller's scopes, and only the caller's files the op names", async () => {
    await kernelBind(CALLER, PROVIDER)
    await mirror(CALLER, PROVIDER)
    const seenScopes: string[] = []
    const t = OPS2.registration_status
    const prev = toolRegistry.get([ORG2, PROVIDER, t])!
    toolRegistry.set([ORG2, PROVIDER, t], {
      ...prev,
      handler: async (_p: unknown, ctx: { db: { execute(q: unknown): Promise<unknown> } }) => {
        const r = await ctx.db.execute(
          drizzleSql`SELECT current_setting('app.current_scopes', true) AS s`,
        )
        seenScopes.push(String((extractRows(r as never)[0] as { s: string }).s))
        return { ok: true }
      },
    } as never)
    try {
      const out = await run(async (tx) =>
        JSON.parse(await sys(CALLER, tx).contracts_call(KEY, "registration_status", "{}")),
      )
      expect(out).toMatchObject({ status: "completed" })
      expect(seenScopes[0]).toContain(`${PROVIDER}:*`)
      expect(seenScopes[0]).not.toContain(CALLER)
    } finally {
      toolRegistry.set([ORG2, PROVIDER, t], prev as never)
    }
    // A file the caller cannot read is never handed over: refused before the provider runs.
    const { grant } = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx, {
          approvalRequestId: randomUUID(),
          approvalDeciderId: APPROVER,
          toolName: `${CALLER}:send`,
        }).contracts_grant(KEY, JSON.stringify(["submit_einvoice"]), JSON.stringify(SUBJECT)),
      ),
    )
    calls.length = 0
    const unreadable = await run(async (tx) =>
      JSON.parse(
        await sys(CALLER, tx).contracts_call(
          KEY,
          "submit_einvoice",
          JSON.stringify(submitParams({ facturx_file_id: randomUUID() })),
          JSON.stringify({ grant }),
        ),
      ),
    )
    expect(unreadable).toMatchObject({ status: "error", error: { code: "file_not_readable" } })
    expect(calls).toHaveLength(0)
  })

  it("the dispatch choke point re-checks the grant: a kernel path claiming the contract without one is forbidden", async () => {
    calls.length = 0
    const system = {
      actorType: "system" as const,
      orgId: ORG2,
      purpose: "job" as const,
      scopes: [`${CALLER}:*`],
    }
    const params = submitParams()
    const noGrant = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG2,
      actor: system,
      params,
      origin: "system",
      internalCall: { callerApp: CALLER, contractCall: { contract: KEY, op: "submit_einvoice" } },
    })
    expect("error" in noGrant ? noGrant.error.code : "ran").toBe("forbidden")
    const wrongDoc = mintContractGrant({
      org: ORG2,
      caller: CALLER,
      contract: KEY,
      ops: ["submit_einvoice"],
      subject: { document_ref: "doc-9" },
      via: "test",
    })
    const mismatch = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG2,
      actor: system,
      params,
      origin: "system",
      internalCall: {
        callerApp: CALLER,
        contractCall: { contract: KEY, op: "submit_einvoice", grant: wrongDoc },
      },
    })
    expect("error" in mismatch ? mismatch.error.code : "ran").toBe("forbidden")
    const expired = mintContractGrant({
      org: ORG2,
      caller: CALLER,
      contract: KEY,
      ops: ["submit_einvoice"],
      subject: { document_ref: "doc-1" },
      via: "test",
      exp: Date.now() - 1,
    })
    const late = await executeToolCore({
      toolName: `${PROVIDER}:pa_submit`,
      orgId: ORG2,
      actor: system,
      params,
      origin: "system",
      internalCall: {
        callerApp: CALLER,
        contractCall: { contract: KEY, op: "submit_einvoice", grant: expired },
      },
    })
    expect("error" in late ? late.error.code : "ran").toBe("forbidden")
    expect(calls).toHaveLength(0)
  })
})

describe("noAutoApprove", () => {
  const base = {
    orgId: "org1",
    toolName: "inv:send",
    appName: "inv",
    actor: {
      actorType: "agent" as const,
      userId: "u",
      orgId: "org1",
      scopes: [],
      dimensionGrants: {},
    },
    isDirectHumanCall: false,
    requesterCanApprove: false,
    gated: true,
    validatedParams: { document_id: "d" },
    evaluatePolicy: async () => ({ requireApproval: false, minApprovers: 1 }),
    evaluate: async () => ({ decision: "auto_approve" as const, policyId: "p1" }),
    noAutoApprove: true,
  }
  it("an auto-approve policy cannot run it", async () => {
    const r = await computeSkipGate(base)
    expect(r.skip).toBe(false)
    expect(r.autoApprovedByPolicy).toBeUndefined()
    expect((await computeSkipGate({ ...base, noAutoApprove: false })).skip).toBe(true) // control
  })
  it("neither capability arm (machine or human-authorized cross-app) can run it", async () => {
    expect(
      (
        await computeSkipGate({
          ...base,
          machineAuthorizedCrossAppCall: true,
          origin: "system",
          callerApp: "inv",
        })
      ).skip,
    ).toBe(false)
    expect(
      (
        await computeSkipGate({
          ...base,
          machineAuthorizedCrossAppCall: true,
          humanAuthorizedCrossAppCall: true,
          callerApp: "inv",
        })
      ).skip,
    ).toBe(false)
  })
  it("a direct UI click runs on the tool's own scopes, never the approve scope", async () => {
    expect(
      (
        await computeSkipGate({
          ...base,
          isDirectHumanCall: true,
          personHoldsToolScopes: true,
          requesterCanApprove: false,
        })
      ).skip,
    ).toBe(true)
    expect(
      (
        await computeSkipGate({
          ...base,
          isDirectHumanCall: true,
          personHoldsToolScopes: false,
          requesterCanApprove: true,
        })
      ).skip,
    ).toBe(false)
  })
})

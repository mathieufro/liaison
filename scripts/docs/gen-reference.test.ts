// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The reference generators (scripts/docs/gen-reference.ts), on fixtures: a
 * fixture repo root in a temp dir with its own env schema, config schema,
 * scope catalog and app manifest, never the real files.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  cell,
  collectAgentTools,
  collectConfigSchema,
  collectEnvSchema,
  collectEnvVars,
  collectKernelScopes,
  collectKernelTools,
  collectManifestSettings,
  renderAgentTools,
  renderAppSettings,
  renderEnv,
  run,
} from "./gen-reference"

const ENV_SRC = `import { z } from "zod"
import { envBoolean } from "~/lib/env-boolean"
export const envSchema = z
  .object({
    // The port the server listens on.
    // Second line of the same comment.
    PORT: z.coerce.number().default(3000),
    JWT_SECRET: z.string().min(32),
    /** Turns the frobnicator on. */
    FROB_ENABLED: envBoolean(false),
    // ── Demo knobs ──────────
    // Read only in demo mode.
    //
    // How long a visitor lives.
    DEMO_TTL: z.coerce.number().int().default(72),
    // ── end demo knobs ──────
    LOG_LEVEL: z.enum(["debug", "info"]).optional(),
  })
  .superRefine(() => {})
`

const CONFIG_SRC = `import { z } from "zod"
const orgSchema = z.object({
  // The org's URL slug.
  slug: z.string().min(1),
  timezone: z.string().optional(),
})
const userSchema = z.object({
  email: z.string(),
  mode: z.enum(["invite", "create"]).default("invite"),
})
export const configSchema = z
  .object({
    org: orgSchema,
    users: z.array(userSchema).optional(),
  })
  .strict()
`

const SCOPES_SRC = `export const KERNEL_SCOPES = [
  { scope: "kernel", app: "kernel", description: "Full kernel access" },
  { scope: "kernel:fixture:read", app: "kernel", description: "Read " + "fixtures" },
]
`

const MANIFEST = {
  name: "fixtureapp",
  listing: { summary: "A fixture app." },
  settings: {
    sections: [
      {
        id: "general",
        title: "General",
        scope: "org",
        adminScope: "fixtureapp:settings:admin",
        blocks: [
          { block: "field", key: "fixture_setting_key", label: "Fixture setting", type: "text" },
          { block: "connections", names: ["fixture-conn"] },
        ],
      },
    ],
  },
  tools: {
    fixture_tool_name: {
      description: "Does the fixture thing. And more after the first sentence.",
      gated: true,
      requiredScopes: ["fixtureapp:things:write"],
    },
  },
}

const tmpRoots: string[] = []
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

function put(root: string, rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** A fixture repo root with every source the generator reads. */
function fixtureRoot(opts: { envSrc?: string; extraFiles?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gen-reference-"))
  tmpRoots.push(root)
  put(root, "apps/api/src/lib/env.ts", opts.envSrc ?? ENV_SRC)
  put(root, "apps/api/src/cli/config/schema.ts", CONFIG_SRC)
  put(root, "apps/api/src/modules/permissions/scope-catalog.ts", SCOPES_SRC)
  put(root, "bundled-apps/fixtureapp/app.manifest.json", JSON.stringify(MANIFEST))
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) put(root, rel, content)
  return root
}

describe("env schema", () => {
  test("a key's leading comment becomes its description, joined to one paragraph", () => {
    const { entries } = collectEnvSchema(ENV_SRC)
    const port = entries.find((e) => e.name === "PORT")
    expect(port?.description).toBe(
      "The port the server listens on. Second line of the same comment.",
    )
    expect(port?.type).toBe("number")
    expect(port?.default).toBe("3000")
    expect(port?.required).toBe(false)
    expect(entries.find((e) => e.name === "FROB_ENABLED")?.description).toBe(
      "Turns the frobnicator on.",
    )
  })

  test("type, default and required are read from the zod chain", () => {
    const { entries } = collectEnvSchema(ENV_SRC)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get("JWT_SECRET")?.required).toBe(true)
    expect(byName.get("FROB_ENABLED")?.type).toBe("boolean")
    expect(byName.get("FROB_ENABLED")?.default).toBe("false")
    expect(byName.get("LOG_LEVEL")?.type).toBe('"debug" | "info"')
    expect(byName.get("LOG_LEVEL")?.required).toBe(false)
  })

  test("banner comments group keys; the paragraph after an opening banner is the intro", () => {
    const { entries, groups } = collectEnvSchema(ENV_SRC)
    const ttl = entries.find((e) => e.name === "DEMO_TTL")
    expect(ttl?.group).toBe("Demo knobs")
    expect(ttl?.description).toBe("How long a visitor lives.")
    expect(groups.find((g) => g.title === "Demo knobs")?.intro).toBe("Read only in demo mode.")
    expect(entries.find((e) => e.name === "LOG_LEVEL")?.group).toBeNull()
  })

  test("a key added to the schema shows up in the page", () => {
    const before = renderEnv(collectEnvVars(fixtureRoot()))
    expect(before).not.toContain("BRAND_NEW_KEY")
    const added = ENV_SRC.replace(
      "JWT_SECRET: z.string().min(32),",
      "JWT_SECRET: z.string().min(32),\n    // A brand new key.\n    BRAND_NEW_KEY: z.string().optional(),",
    )
    const after = renderEnv(collectEnvVars(fixtureRoot({ envSrc: added })))
    expect(after).toContain("| `BRAND_NEW_KEY` | `string` |  | no | A brand new key. |")
  })

  test("vars read outside the schema are listed; exempt names and prefixes are dropped", () => {
    const root = fixtureRoot({
      extraFiles: {
        "apps/api/src/feature.ts":
          'const a = process.env.REAL_EXTRA_VAR\nconst b = process.env.E2E_FIXTURE_SWITCH\nconst c = Bun.env["NAMED_EXEMPT"]\nconst d = process.env.PORT\n',
        "apps/api/src/feature.test.ts": "process.env.ONLY_IN_A_TEST\n",
      },
    })
    const c = collectEnvVars(root, {
      names: { NAMED_EXEMPT: "fixture" },
      prefixes: { E2E_: "fixture" },
    })
    expect(c.extra.map((u) => u.name)).toEqual(["REAL_EXTRA_VAR"])
    expect(c.extra[0]?.files).toEqual(["apps/api/src/feature.ts:1"])
    expect(c.exempt).toEqual(["E2E_FIXTURE_SWITCH", "NAMED_EXEMPT"])
    // Without the prefix rule the prefixed var is listed.
    const open = collectEnvVars(root, { names: {}, prefixes: {} })
    expect(open.extra.map((u) => u.name)).toContain("E2E_FIXTURE_SWITCH")
  })
})

describe("config schema", () => {
  test("sections and nested keys with type, required, default and description", () => {
    const sections = collectConfigSchema(CONFIG_SRC)
    expect(sections.map((s) => s.key)).toEqual(["org", "users"])
    const org = sections[0]
    expect(org?.required).toBe(true)
    expect(org?.rows.find((r) => r.path === "org.slug")?.description).toBe("The org's URL slug.")
    expect(org?.rows.find((r) => r.path === "org.timezone")?.required).toBe(false)
    const mode = sections[1]?.rows.find((r) => r.path === "users[].mode")
    expect(mode?.default).toBe('"invite"')
    expect(mode?.required).toBe(false)
    expect(sections[1]?.type).toBe("object[]")
  })
})

describe("scopes", () => {
  test("KERNEL_SCOPES entries, concatenated descriptions joined", () => {
    expect(collectKernelScopes(SCOPES_SRC)).toEqual([
      { scope: "kernel", description: "Full kernel access" },
      { scope: "kernel:fixture:read", description: "Read fixtures" },
    ])
  })

  test("a scope given as a constant is resolved; an unresolvable one throws", () => {
    const src = `const FIXTURE_SCOPE = "kernel:fixture:const"
const FIXTURE_DESC = "Constant description"
export const KERNEL_SCOPES = [{ scope: FIXTURE_SCOPE, app: "kernel", description: FIXTURE_DESC }]
`
    expect(collectKernelScopes(src)).toEqual([
      { scope: "kernel:fixture:const", description: "Constant description" },
    ])
    expect(() =>
      collectKernelScopes(`export const KERNEL_SCOPES = [{ scope: makeScope(), app: "kernel" }]\n`),
    ).toThrow(/KERNEL_SCOPES/)
  })
})

const KERNEL_TOOLS_SRC = `import { z } from "zod"
import { IMPORTED_SCOPE } from "./fixture-scopes"
import { LOOP_DESCRIPTION } from "~/modules/fixture/descriptions"
const FIXTURE_WORDS = ["fixture"]
export async function registerKernelAgentTools(orgId: string) {
  const LOCAL_SCOPE = "kernel:fixture:read"
  toolRegistry.set([orgId, "kernel", "literal_tool"], {
    appName: "kernel",
    name: "literal_tool",
    description: "A literal tool. Second sentence.",
    requiredScopes: ["kernel:fixture:write"],
    gated: true,
    deferLoading: true,
    searchKeywords: [...FIXTURE_WORDS, "littéral"],
    params: z.object({ id: z.string() }),
  })
  toolRegistry.set([orgId, "kernel", "const_scope_tool"], {
    appName: "kernel",
    name: "const_scope_tool",
    description: "Uses constant scopes.",
    requiredScopes: [LOCAL_SCOPE, IMPORTED_SCOPE],
  })
  const loopTools: Array<{ name: string; description: string; requiredScopes: string[] }> = [
    { name: "loop_tool_a", description: LOOP_DESCRIPTION, requiredScopes: ["kernel:loop:read"] },
    { name: "loop_tool_b", description: "Loop tool b.", requiredScopes: [LOCAL_SCOPE] },
  ]
  for (const t of loopTools) {
    toolRegistry.set([orgId, "kernel", t.name], {
      appName: "kernel",
      name: t.name,
      description: t.description,
      requiredScopes: t.requiredScopes,
      ...(t.requiredScopes.includes("kernel:loop:read") ? { readOnly: true } : {}),
    })
  }
  await refreshWebSearchToolRegistration(orgId)
  for (const [name, hint] of Object.entries(HINTS)) {
    const entry = toolRegistry.get([orgId, "kernel", name])
    if (!entry) continue
    toolRegistry.set([orgId, "kernel", name], { ...entry, handler: wrap(entry.handler, hint) })
  }
}
function webSearchToolDefinition() {
  return {
    appName: "kernel",
    name: "web_search",
    description: "Search the web.",
    requiredScopes: ["kernel:agent:web"],
  }
}
export async function refreshWebSearchToolRegistration(orgId: string) {
  if (await isWebSearchConfigured(orgId)) {
    toolRegistry.set([orgId, "kernel", "web_search"], webSearchToolDefinition())
  } else {
    toolRegistry.delete([orgId, "kernel", "web_search"])
  }
}
`

function kernelToolsRoot(src: string = KERNEL_TOOLS_SRC): string {
  return fixtureRoot({
    extraFiles: {
      "apps/api/src/modules/agent/tools/kernel-tools.ts": src,
      "apps/api/src/modules/agent/tools/fixture-scopes.ts":
        'export const IMPORTED_SCOPE = "kernel:fixture:imported"\n',
      "apps/api/src/modules/fixture/descriptions.ts":
        'export const LOOP_DESCRIPTION =\n  "Loop tool a, described by an imported constant. More."\n',
    },
  })
}

describe("kernel tools", () => {
  test("constant scopes resolve, in the same file and through an import", () => {
    const { tools } = collectKernelTools(kernelToolsRoot())
    expect(tools.find((t) => t.name === "const_scope_tool")?.requiredScopes).toEqual([
      "kernel:fixture:read",
      "kernel:fixture:imported",
    ])
    expect(tools.find((t) => t.name === "literal_tool")).toMatchObject({
      name: "literal_tool",
      description: "A literal tool.",
      gated: true,
      requiredScopes: ["kernel:fixture:write"],
    })
  })

  test("a tool carries what the tool search reads: whole description, keywords, deferLoading", () => {
    const { tools } = collectKernelTools(kernelToolsRoot())
    expect(tools.find((t) => t.name === "literal_tool")).toMatchObject({
      fullDescription: "A literal tool. Second sentence.",
      searchKeywords: ["fixture", "littéral"],
      deferLoading: true,
      agentVisible: true,
      routineOnly: false,
      paramsChars: "z.object({ id: z.string() })".length,
    })
    expect(tools.find((t) => t.name === "const_scope_tool")?.deferLoading).toBeUndefined()
  })

  test("tools registered in a loop over a definition array are listed", () => {
    const { tools } = collectKernelTools(kernelToolsRoot())
    expect(tools.find((t) => t.name === "loop_tool_a")).toMatchObject({
      name: "loop_tool_a",
      description: "Loop tool a, described by an imported constant.",
      gated: false,
      requiredScopes: ["kernel:loop:read"],
    })
    expect(tools.find((t) => t.name === "loop_tool_b")?.requiredScopes).toEqual([
      "kernel:fixture:read",
    ])
  })

  test("a description written as a template of a string constant and a number constant is read in full", () => {
    const src = KERNEL_TOOLS_SRC.replace(
      '  const LOCAL_SCOPE = "kernel:fixture:read"\n',
      `  const LOCAL_SCOPE = "kernel:fixture:read"
  const ROW_NOUN = "rows"
  const MAX_ROWS = 500
  toolRegistry.set([orgId, "kernel", "template_tool"], {
    appName: "kernel",
    name: "template_tool",
    description: \`Write up to \${MAX_ROWS} \${ROW_NOUN} in one call. More.\`,
    requiredScopes: [LOCAL_SCOPE],
  })
`,
    )
    const { tools } = collectKernelTools(kernelToolsRoot(src))
    expect(tools.find((t) => t.name === "template_tool")?.description).toBe(
      "Write up to 500 rows in one call.",
    )
  })

  test("web_search, built by a function and registered conditionally, is listed with its condition", () => {
    const kernel = collectKernelTools(kernelToolsRoot())
    expect(kernel.tools.map((t) => t.name)).toEqual([
      "const_scope_tool",
      "literal_tool",
      "loop_tool_a",
      "loop_tool_b",
      "web_search",
    ])
    const ws = kernel.tools.find((t) => t.name === "web_search")
    expect(ws?.requiredScopes).toEqual(["kernel:agent:web"])
    expect(ws?.availability).toContain("EXA_API_KEY")
    const md = renderAgentTools(kernel, [])
    expect(md).toContain(
      "| `web_search` | Search the web. Available when a web search key is configured",
    )
    expect(md).not.toContain("computed definitions")
  })

  test("a scope expression that cannot be resolved fails the generation, naming the tool", () => {
    const src = KERNEL_TOOLS_SRC.replace(
      "requiredScopes: [LOCAL_SCOPE, IMPORTED_SCOPE],",
      "requiredScopes: [LOCAL_SCOPE, scopeFor(orgId)],",
    )
    expect(() => collectKernelTools(kernelToolsRoot(src))).toThrow(/const_scope_tool/)
    const missing = KERNEL_TOOLS_SRC.replace(
      "requiredScopes: [LOCAL_SCOPE, IMPORTED_SCOPE],",
      "requiredScopes: [LOCAL_SCOPE, NOT_DEFINED_ANYWHERE],",
    )
    expect(() => collectKernelTools(kernelToolsRoot(missing))).toThrow(/const_scope_tool/)
  })
})

describe("manifests", () => {
  test("a fixture manifest's settings key appears in the settings page", () => {
    const root = fixtureRoot()
    const settings = collectManifestSettings(root)
    expect(settings[0]?.sections[0]?.adminScope).toBe("fixtureapp:settings:admin")
    const md = renderAppSettings(settings)
    expect(md).toContain("## fixtureapp")
    expect(md).toContain("| `fixture_setting_key` | Fixture setting | text |")
    expect(md).toContain("| fixture-conn | connections |")
  })

  test("a fixture manifest's tool name appears in the agent tools page", () => {
    const root = fixtureRoot()
    const md = renderAgentTools({ tools: [] }, collectAgentTools(root))
    expect(md).toContain(
      "| `fixture_tool_name` | Does the fixture thing. | yes | `fixtureapp:things:write` |",
    )
  })
})

describe("--check", () => {
  test("passes when the pages are fresh, fails listing a stale one, and writes nothing", () => {
    const root = fixtureRoot()
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(run(["--check"], root)).toBe(1) // nothing generated yet
      expect(run([], root)).toBe(0)
      expect(run(["--check"], root)).toBe(0)
      const envPage = join(root, "docs/reference/env.md")
      const edited = `${readFileSync(envPage, "utf8")}\nhand edit\n`
      writeFileSync(envPage, edited)
      errSpy.mockClear()
      expect(run(["--check"], root)).toBe(1)
      const reported = errSpy.mock.calls.map((c) => String(c[0])).join("")
      expect(reported).toContain("docs/reference/env.md")
      expect(reported).not.toContain("docs/reference/cli.md")
      expect(readFileSync(envPage, "utf8")).toBe(edited)
    } finally {
      out.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe("markdown", () => {
  test("cells escape pipes and angle brackets, keep code spans", () => {
    expect(cell("a | b <slug> `x | <y>`")).toBe("a \\| b &lt;slug&gt; `x \\| <y>`")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { firstPartyOnlyToolKeyErrors, validateAppManifest } from "~/modules/apps/contract"

describe("manifest schema: bulk", () => {
  it("requires perItemParam when dispatchMode=perItem", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: { close: { description: "c", requiredScopes: ["x:y:z"], handler: "h" } },
      bulk: {
        close: {
          label: "Close",
          underlyingTool: "close",
          dispatchMode: "perItem",
          sharedFields: [],
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/perItemParam/)
  })

  it("requires selectionParam when dispatchMode=aggregate", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: { merge: { description: "m", requiredScopes: ["x:y:z"], handler: "h" } },
      bulk: {
        merge: { label: "Merge", underlyingTool: "merge", dispatchMode: "aggregate" },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/selectionParam/)
  })

  it("rejects bulk actions whose underlyingTool is unknown", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: { close: { description: "c", requiredScopes: ["x:y:z"], handler: "h" } },
      bulk: {
        bogus: {
          label: "Bogus",
          underlyingTool: "nope",
          dispatchMode: "perItem",
          perItemParam: "id",
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/underlyingTool/)
  })

  it("rejects agentTool collision with existing tool", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: {
        close: { description: "c", requiredScopes: ["x:y:z"], handler: "h" },
        bulkClose: { description: "b", requiredScopes: ["x:y:z"], handler: "h" },
      },
      bulk: {
        close: {
          label: "Close",
          underlyingTool: "close",
          dispatchMode: "perItem",
          perItemParam: "id",
          agentTool: "bulkClose",
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/agentTool/)
  })

  it("rejects sharedFields not declared by underlying tool", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: {
        close: {
          description: "c",
          requiredScopes: ["x:y:z"],
          handler: "h",
          params: { type: "object", properties: { closedReason: { type: "string" } } },
        },
      },
      bulk: {
        close: {
          label: "Close",
          underlyingTool: "close",
          dispatchMode: "perItem",
          perItemParam: "id",
          sharedFields: ["bogus"],
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/sharedFields/)
  })

  it("accepts a valid bulk declaration", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: {
        close: {
          description: "c",
          requiredScopes: ["x:y:z"],
          handler: "h",
          params: {
            type: "object",
            properties: { closedReason: { type: "string" }, ticketId: { type: "string" } },
          },
        },
      },
      bulk: {
        close: {
          label: "Close tickets…",
          underlyingTool: "close",
          dispatchMode: "perItem",
          perItemParam: "ticketId",
          sharedFields: ["closedReason"],
          agentTool: "bulkClose",
        },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe("manifest schema: searchable entities", () => {
  it("rejects searchable:true without readScope", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      entities: {
        foo: { labelField: "name", handlePrefix: "f", searchable: true, tableName: "foos" },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/readScope/)
  })

  it("rejects searchable:true without tableName", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      entities: {
        foo: { labelField: "name", handlePrefix: "f", searchable: true, readScope: "x:y:read" },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/tableName/)
  })

  it("accepts a valid searchable entity", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      schema: { foos: { fields: { name: "string" } } },
      entities: {
        foo: {
          labelField: "name",
          handlePrefix: "f",
          searchable: true,
          tableName: "foos",
          readScope: "x:y:read",
        },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe("manifest schema: savedViews", () => {
  it("rejects savedViews for unknown viewId", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      savedViews: {
        bogus: { defaults: [{ key: "a", name: "A", payload: {} }] },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/savedViews/)
  })

  it("rejects duplicate default keys within a view", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      views: { tabTypes: { inbox: { component: "Inbox" } } },
      savedViews: {
        inbox: {
          defaults: [
            { key: "a", name: "A", payload: {} },
            { key: "a", name: "A2", payload: {} },
          ],
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/duplicate/)
  })

  it("accepts kernel 'home' viewId", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      savedViews: {
        home: { defaults: [{ key: "a", name: "A", payload: {} }] },
      },
    })
    expect(r.success).toBe(true)
  })
})

// Phase 16 Task A3 — manifest schema additive extensions.
describe("manifest schema: Phase-16 additive extensions", () => {
  const minimal = { name: "shopify", version: "0.1.0" }

  // filterableAxes
  it("accepts attention.filterableAxes as an additive extension", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: { translations: [], filterableAxes: ["market", "currency"] },
    })
    expect(r.success).toBe(true)
  })

  it("rejects malformed filterableAxes (uppercase letters)", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: { translations: [], filterableAxes: ["Market"] },
    })
    expect(r.success).toBe(false)
  })

  it("rejects duplicate filterableAxes entries", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: { translations: [], filterableAxes: ["market", "market"] },
    })
    expect(r.success).toBe(false)
  })

  // Attention `kind` extension
  it("accepts a core-enum attention kind (back-compat)", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: {
        translations: [
          {
            event: "kernel:thread_reply",
            kind: "mention",
            urgency: 60,
            summary: "x",
            recipients: { kind: "actor" },
          },
        ],
      },
    })
    expect(r.success).toBe(true)
  })

  it("accepts an `<appName>:<kind>` namespaced attention kind", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: {
        translations: [
          {
            event: "shopify:order_created",
            kind: "shopify:order.created",
            urgency: 40,
            summary: "New order",
            recipients: { kind: "actor" },
          },
        ],
      },
    })
    expect(r.success).toBe(true)
  })

  it("rejects malformed namespaced kind (uppercase prefix)", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: {
        translations: [
          {
            event: "shopify:order_created",
            kind: "Shopify:order.created",
            urgency: 40,
            summary: "x",
            recipients: { kind: "actor" },
          },
        ],
      },
    })
    expect(r.success).toBe(false)
  })

  // Search block
  it("accepts a `search` block at the top level", () => {
    const r = validateAppManifest({
      ...minimal,
      search: { handler: "searchHandler", entities: ["order"], timeoutMs: 5000 },
    })
    expect(r.success).toBe(true)
  })

  it("a webhook's budget fits inside the request ceiling: 29000 is the most", () => {
    const withBudget = (timeoutMs: number) =>
      validateAppManifest({
        ...minimal,
        webhooks: { hook: { handler: "hook", verify: "verify", timeoutMs } },
        webhookHealth: { probe: null, reason: "the provider has no list API" },
      }).success
    expect(withBudget(29_000)).toBe(true)
    expect(withBudget(29_001)).toBe(false)
    expect(withBudget(999)).toBe(false)
  })

  it("rejects search.timeoutMs above 10000", () => {
    const r = validateAppManifest({
      ...minimal,
      search: { handler: "x", entities: ["y"], timeoutMs: 99999 },
    })
    expect(r.success).toBe(false)
  })

  it("rejects search without required handler+entities", () => {
    const r = validateAppManifest({ ...minimal, search: { timeoutMs: 1000 } })
    expect(r.success).toBe(false)
  })

  // views.detail
  it("accepts views.detail.<entity>.externalLink", () => {
    const r = validateAppManifest({
      ...minimal,
      views: {
        detail: {
          order: {
            component: "OrderPanel",
            externalLink: { urlTemplate: "https://x.myshopify.com/admin/orders/{{id}}" },
          },
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it("rejects externalLink.urlTemplate that doesn't start with http(s)://", () => {
    const r = validateAppManifest({
      ...minimal,
      views: {
        detail: {
          order: {
            component: "OrderPanel",
            externalLink: { urlTemplate: "javascript:alert(1)" },
          },
        },
      },
    })
    expect(r.success).toBe(false)
  })

  // Non-regression: keep existing strictness.
  it("non-regression: rejects unknown attention field — additionalProperties:false still enforced", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: { translations: [], bogusField: 1 },
    } as any)
    expect(r.success).toBe(false)
  })

  // Phase 16 Task A5 — editableFields widget enum widened.
  it("accepts editableFields widget=`checkbox-per-line` with listSource", () => {
    const r = validateAppManifest({
      name: "shopify",
      version: "0.1.0",
      tools: {
        refund: {
          description: "Refund",
          requiredScopes: ["shopify:refunds:create"],
          handler: "refundCreate",
          gated: true,
          params: { type: "object", properties: { restock: { type: "object" } } },
          editableFields: [
            {
              field: "restock",
              label: "Restock",
              widget: "checkbox-per-line",
              listSource: "lineItems",
            },
          ],
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it("accepts editableFields widget=`checkbox` and `key-value-list`", () => {
    const r = validateAppManifest({
      name: "shopify",
      version: "0.1.0",
      tools: {
        x: {
          description: "x",
          requiredScopes: ["shopify:orders:write"],
          handler: "h",
          gated: true,
          params: {
            type: "object",
            properties: { notify: { type: "boolean" }, tags: { type: "object" } },
          },
          editableFields: [
            { field: "notify", label: "Notify customer", widget: "checkbox" },
            { field: "tags", label: "Tags", widget: "key-value-list" },
          ],
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it("rejects unknown widget", () => {
    const r = validateAppManifest({
      name: "shopify",
      version: "0.1.0",
      tools: {
        x: {
          description: "x",
          requiredScopes: ["shopify:orders:write"],
          handler: "h",
          gated: true,
          params: { type: "object", properties: { x: { type: "string" } } },
          editableFields: [{ field: "x", label: "x", widget: "buzzer" }],
        },
      },
    } as any)
    expect(r.success).toBe(false)
  })

  it("non-regression: rejects unknown field on a translation — additionalProperties:false still enforced", () => {
    const r = validateAppManifest({
      ...minimal,
      attention: {
        translations: [
          {
            event: "shopify:order_created",
            kind: "mention",
            urgency: 60,
            summary: "x",
            recipients: { kind: "actor" },
            adminBypass: true,
          },
        ],
      },
    } as any)
    expect(r.success).toBe(false)
  })
})

describe("manifest schema: connection setupGuide", () => {
  const withConn = (setupGuide?: unknown) => ({
    name: "gitlab",
    version: "1.0.0",
    connections: {
      gitlab: {
        type: "credentials",
        allowedDomains: ["gitlab.com"],
        credentialFields: [{ name: "token", label: "Token", type: "password" }],
        ...(setupGuide ? { setupGuide } : {}),
      },
    },
  })

  it("validates a connection with a full setupGuide (summary + steps + docsUrl)", () => {
    const r = validateAppManifest(
      withConn({
        summary: "Connect a GitLab group read-only.",
        steps: ["Open Access tokens.", "Create a read-only token.", "Paste it here."],
        docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
      }) as any,
    )
    expect(r.success).toBe(true)
  })

  it("validates a connection with no setupGuide (optional)", () => {
    const r = validateAppManifest(withConn() as any)
    expect(r.success).toBe(true)
  })

  it("rejects a setupGuide whose steps are not all strings", () => {
    const r = validateAppManifest(withConn({ steps: ["ok", 123] }) as any)
    expect(r.success).toBe(false)
  })

  it("rejects an unknown property inside setupGuide", () => {
    const r = validateAppManifest(withConn({ summary: "x", bogus: true }) as any)
    expect(r.success).toBe(false)
  })
})

describe("manifest schema: DDL-injection hardening", () => {
  // Build a minimal manifest carrying one entity with the given schema overrides.
  const withEntity = (entity: Record<string, unknown>) =>
    validateAppManifest({
      name: "x",
      version: "1.0.0",
      schema: { thing: { fields: { foo: "string?" }, ...entity } },
    } as any)

  const withTrigger = (body: string) =>
    validateAppManifest({
      name: "x",
      version: "1.0.0",
      schema: {
        thing: {
          fields: { parentId: "uuid?" },
          triggers: {
            t: {
              timing: "BEFORE",
              event: ["INSERT"],
              level: "ROW",
              language: "plpgsql",
              body,
            },
          },
        },
      },
    } as any)

  describe("trigger body", () => {
    it("rejects a body containing the dollar-quote tag sequence $TRIGGER_BODY$", () => {
      const r = withTrigger("BEGIN RETURN NEW; END; $TRIGGER_BODY$ ; DROP TABLE kernel.users; --")
      expect(r.success).toBe(false)
    })

    it("rejects a body containing an empty dollar-quote tag $$", () => {
      const r = withTrigger("BEGIN $$ malicious $$ RETURN NEW; END;")
      expect(r.success).toBe(false)
    })

    it("accepts a legitimate plpgsql body that uses positional params ($1) and format()", () => {
      // Verbatim shape from the in-tree tickets app (enforce_category_depth).
      const r = withTrigger(
        "DECLARE _exists boolean; BEGIN IF NEW.parent_id IS NULL THEN RETURN NEW; END IF; " +
          "EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.categories WHERE id = $1 AND parent_id IS NOT NULL)', TG_TABLE_SCHEMA) " +
          "INTO _exists USING NEW.parent_id; IF _exists THEN RAISE EXCEPTION 'category_depth_limit'; END IF; RETURN NEW; END;",
      )
      expect(r.success).toBe(true)
    })
  })

  describe("partial-index / partial-unique WHERE", () => {
    const reject = (where: string) =>
      expect(withEntity({ indexes: [{ columns: ["foo"], where }] }).success).toBe(false)
    const accept = (where: string) =>
      expect(withEntity({ indexes: [{ columns: ["foo"], where }] }).success).toBe(true)

    it("rejects a subquery in the WHERE clause", () => {
      reject("foo = (SELECT id FROM kernel.users LIMIT 1)")
    })

    it("rejects a function call (pg_sleep DoS) in the WHERE clause", () => {
      reject("pg_sleep(10) > 0")
    })

    it("rejects an inline comment in the WHERE clause", () => {
      reject("foo IS NOT NULL -- gotcha")
    })

    it("rejects a block comment in the WHERE clause", () => {
      reject("foo IS NOT NULL /* gotcha */")
    })

    it("rejects a statement separator in the WHERE clause", () => {
      reject("foo IS NOT NULL; DROP TABLE kernel.users")
    })

    it("rejects a CTE/WITH subquery in the WHERE clause", () => {
      reject("foo = (WITH x AS (SELECT 1) SELECT 1 FROM x)")
    })

    // The legitimate shapes used by in-tree + bundled apps must keep validating.
    it("accepts `archived_at IS NULL` (knowledge app)", () => {
      accept("archived_at IS NULL")
    })
    it("accepts `external_message_id IS NOT NULL` (tickets app)", () => {
      accept("external_message_id IS NOT NULL")
    })
    it("accepts `order_status IS DISTINCT FROM 'CANCELLED'` (boxtal app)", () => {
      accept("order_status IS DISTINCT FROM 'CANCELLED'")
    })
    it("accepts `is_default_for_create = true` in a partial UNIQUE (tickets app)", () => {
      const r = withEntity({
        constraints: { unique: [{ columns: [], where: "is_default_for_create = true" }] },
      })
      expect(r.success).toBe(true)
    })
    it("accepts simple predicates joined by AND/OR", () => {
      accept("foo IS NOT NULL AND archived_at IS NULL")
      accept("foo = 'a' OR foo = 'b'")
    })
  })
})

describe("manifest schema: tool scope-taint declarations", () => {
  const withTool = (extra: Record<string, unknown>) =>
    validateAppManifest({
      name: "x",
      version: "1.0.0",
      tools: { t: { description: "t", requiredScopes: ["x:y:z"], handler: "h", ...extra } },
    })

  it("accepts writesToTable and readOnly on a tool", () => {
    expect(withTool({ writesToTable: "app_x.items" }).success).toBe(true)
    expect(withTool({ readOnly: true }).success).toBe(true)
  })

  it("rejects a writesToTable that is not a schema-qualified table", () => {
    for (const writesToTable of ["items", "App_X.items", "app_x.items.y", ""]) {
      expect(withTool({ writesToTable }).success).toBe(false)
    }
  })

  it("rejects a non-boolean readOnly", () => {
    expect(withTool({ readOnly: "yes" }).success).toBe(false)
  })
})

describe("manifest schema: skills.<name>.autoAttach", () => {
  const withSkill = (autoAttach: unknown) =>
    validateAppManifest({
      name: "x",
      version: "1.0.0",
      skills: {
        "prepare-shipment": {
          description: "Prepare the shipment",
          body: "x",
          autoAttach,
        },
      },
    })

  it("accepts a valid autoAttach with keywords and apps", () => {
    const r = withSkill({ keywords: ["expedie", "colis"], apps: ["boxtal"] })
    expect(r.success).toBe(true)
  })

  it("accepts a skill that declares no autoAttach at all (no behaviour change)", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      skills: { "prepare-shipment": { description: "Prepare the shipment", body: "x" } },
    })
    expect(r.success).toBe(true)
  })

  it("rejects autoAttach.keywords given as a string instead of an array", () => {
    const r = withSkill({ keywords: "repair" })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown property inside autoAttach", () => {
    const r = withSkill({ keywords: ["colis"], bogus: true })
    expect(r.success).toBe(false)
  })
})

describe("manifest schema: agentInstructions sections", () => {
  const base = {
    name: "x",
    version: "1.0.0",
    tools: { close: { description: "c", requiredScopes: ["x:y:z"], handler: "h" } },
  }
  it("accepts a core with sections keyed by declared tools", () => {
    const r = validateAppManifest({
      ...base,
      agentInstructions: { core: "X core.", sections: [{ tools: ["close"], text: "Closing." }] },
    })
    expect(r.success).toBe(true)
  })
  it("rejects a section naming a tool the app does not declare", () => {
    const r = validateAppManifest({
      ...base,
      agentInstructions: { core: "X core.", sections: [{ tools: ["clsoe"], text: "Closing." }] },
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/clsoe/)
  })
})

describe("manifest schema: configKeys", () => {
  const connections = {
    hook: {
      type: "credentials",
      allowedDomains: ["x.example"],
      credentialFields: [],
      webhookSecretConfigKey: "hookSecret",
    },
  }

  it("accepts declared non-secret config keys", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      connections,
      configKeys: [
        { key: "sources", type: "json" },
        { key: "dashboardUrl", type: "url", label: "Dashboard" },
      ],
    })
    expect(r.error).toBeUndefined()
    expect(r.success).toBe(true)
  })

  it("refuses a config key equal to a connection's webhookSecretConfigKey", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      connections,
      configKeys: [{ key: "hookSecret", type: "string" }],
    })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/connection secret/)
  })

  it("refuses an unknown config key type", () => {
    const r = validateAppManifest({
      name: "x",
      version: "1.0.0",
      configKeys: [{ key: "a", type: "number" }],
    })
    expect(r.success).toBe(false)
  })
})

describe("manifest schema: connection multiInstance", () => {
  const conn = (extra: Record<string, unknown>) =>
    validateAppManifest({
      name: "multi",
      version: "1.0.0",
      connections: { api: { allowedDomains: [], ...extra } },
    })

  it("accepts multiInstance on a credentials connection", () => {
    const r = conn({
      type: "credentials",
      multiInstance: true,
      credentialFields: [{ name: "apiKey", label: "Key", type: "password", required: false }],
    })
    expect(r.success).toBe(true)
  })

  it("refuses a non-boolean multiInstance", () => {
    const r = conn({ type: "credentials", multiInstance: "yes", credentialFields: [] })
    expect(r.success).toBe(false)
  })

  it("refuses multiInstance on an oauth2 connection", () => {
    const r = conn({
      type: "oauth2",
      multiInstance: true,
      authorizationUrl: "https://x.example/authorize",
      tokenUrl: "https://x.example/token",
      allowedDomains: ["x.example"],
    })
    expect(r.success).toBe(false)
  })
})

describe("manifest schema: where a call may run", () => {
  const withKeys = () => ({
    name: "x",
    version: "1.0.0",
    tools: {
      mine: {
        description: "m",
        requiredScopes: ["x:y:read"],
        handler: "h",
        readOnly: true,
        humanTurnOnly: true,
      },
      private_read: {
        description: "p",
        requiredScopes: ["x:y:read"],
        handler: "h",
        readOnly: true,
        dmOnly: true,
      },
    },
  })

  it("the schema accepts both keys as booleans and refuses another type", () => {
    expect(validateAppManifest(withKeys()).success).toBe(true)
    const wrong = withKeys()
    ;(wrong.tools.mine as Record<string, unknown>).humanTurnOnly = "yes"
    expect(validateAppManifest(wrong).success).toBe(false)
  })

  it("a third-party manifest cannot declare the two keys", () => {
    const errors = firstPartyOnlyToolKeyErrors(withKeys())
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain("tools.mine.humanTurnOnly: only a first-party app may declare it")
    expect(errors[1]).toContain("tools.private_read.dmOnly: only a first-party app may declare it")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import {
  createItem,
  exportItems,
  handleTestWebhook,
  listItems,
  mockExternalSearch,
  onItemCreated,
  processItemsBatch,
  riskyAction,
  verifyTestSignature,
} from "./handlers"

export const testApp = {
  name: "test",
  version: "1.0.0",
  description: "Kernel contract validation app",

  schema: {
    items: {
      fields: {
        title: "string",
        status: "string",
        team: "string",
        sensitivity: "string",
        createdBy: { type: "uuid", required: false },
      },
      dimensions: {
        team: { type: "membership" as const },
        sensitivity: {
          type: "level" as const,
          order: ["public", "internal", "confidential"],
        },
      },
      timeline: ["status", "team"],
      searchable: ["title"],
    },
    // The external records `externalSearch` returns: a dimension is declared on
    // a table, so the `market` its response filter uses is declared here. The
    // items scopes read it, as in the manifest.
    externalrecords: {
      rlsScope: "items",
      fields: { name: "string", market: "string" },
      dimensions: {
        market: { type: "membership" as const, values: ["eu", "us", "ap"] },
      },
    },
  },

  entities: {
    item: {
      labelField: "title",
      handlePrefix: "item",
      searchable: true,
    },
  },

  views: {
    activityBar: { icon: "TestIcon", label: "Test Items", order: 99 },
  },

  slots: {
    "item:detail:actions": { position: "toolbar" as const },
  },

  tools: {
    listItems: {
      description: "List test items",
      params: z.object({ status: z.string().optional() }),
      requiredScopes: ["test:items:read"],
      handler: listItems,
    },
    createItem: {
      description: "Create a test item",
      params: z.object({ title: z.string(), team: z.string() }),
      requiredScopes: ["test:items:write"],
      handler: createItem,
    },
    riskyAction: {
      description: "A gated action requiring approval",
      params: z.object({ itemId: z.string(), action: z.string() }),
      requiredScopes: ["test:items:write"],
      gated: true,
      handler: riskyAction,
    },
    externalSearch: {
      description: "Mock external API search (tests response filtering)",
      params: z.object({ query: z.string() }),
      requiredScopes: ["test:external:read"],
      handler: mockExternalSearch,
      returns: {
        schema: { id: "string", name: "string", market: "string" },
        dimensions: { market: "test:market" },
      },
    },
  },

  events: {
    emits: ["items:created", "items:updated", "items:deleted"],
    subscribes: {
      "items:created": onItemCreated,
    },
  },

  jobs: {
    processItems: {
      schedule: "0/5 * * * *",
      handler: processItemsBatch,
      retry: { attempts: 2, backoff: "exponential" as const },
    },
  },

  webhooks: {
    "test-hook": {
      handler: handleTestWebhook,
      verify: verifyTestSignature,
    },
  },
  webhookHealth: { probe: null, reason: "Test fixture with no upstream." },

  export: {
    formats: ["json"],
    handler: exportItems,
  },

  // Exercise the contributions contract field
  contributions: {
    "test:detail:tabs": {
      component: "TestContributionPanel",
      label: "Test Contribution",
    },
  },
}

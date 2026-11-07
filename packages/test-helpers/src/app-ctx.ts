// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/test-helpers/app-ctx: the inert AppContext skeleton bundled-app
// test doubles build on. Every kernel primitive is a no-op returning its
// bridge contract shape; a suite overrides the surfaces it exercises (db,
// emit, fetch, connections, config) and casts the result to its ctx type.
// Every call returns fresh objects, so a test mutating one ctx never leaks
// into another.

export const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
export const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

export function noopLogger(): {
  info: () => void
  warn: () => void
  error: () => void
  debug: () => void
} {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

export function stubAppContext(): Record<string, unknown> {
  return {
    userId: TEST_USER_ID,
    orgId: TEST_ORG_ID,
    db: {
      findMany: async () => [],
      findOne: async () => null,
      insert: async () => ({ id: "row-1" }),
      update: async () => {},
      updateMany: async () => ({ count: 0 }),
      delete: async () => {},
      count: async () => 0,
    },
    emit: async () => {},
    enqueueJob: async () => {},
    resolveContact: async () => ({}),
    connections: {},
    listContactsByExternalId: async () => ({ contacts: [], nextCursor: null }),
    fetch: async () => ({ status: 200, headers: {}, body: "" }),
    logger: noopLogger(),
    config: { get: async () => null, has: async () => false, setSecret: async () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "b", sizeBytes: 0 }),
      // eslint-disable-next-line require-yield
      iterateJsonl: async function* () {},
      deleteBlob: async () => {},
    },
    messages: { post: async () => ({ message_id: "m", thread_id: "t" }) },
    pdf: { render: async () => ({ file_id: "f", byte_size: 0, page_count: 0 }) },
    sequences: { allocate: async () => ({ value: 1 }) },
    time: {
      civil: async ({ timezone }: { timezone: string }) => ({
        date: "2026-01-01",
        year: 2026,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        weekday: 4,
        zone: timezone,
      }),
    },
  }
}

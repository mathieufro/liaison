// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox bridge exposes a pinned method set, each with a pinned sync/async
// kind. The list was taken from the single-closure bridge before it was split
// into per-capability factories, so a method lost or duplicated by a factory
// shows up here. The kind is part of the contract: the executor and the session
// bridge dispatch on `fn.constructor.name === "AsyncFunction"`, so a getter that
// became async (or an async method that became a promise-returning plain
// function) changes how QuickJS marshals it.
//
// Adding or removing a bridge method means editing this list on purpose.
//
// Construction never touches the database (the session bridge relies on that),
// so a poison transaction is enough: any db access during construction throws.
import { describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import type { RlsSession } from "~/db/rls"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const EXPECTED_METHODS: ReadonlyArray<readonly [string, "sync" | "async"]> = [
  ["_approvalContext_get", "sync"],
  ["agent_awaitRun", "async"],
  ["agent_run", "async"],
  ["agent_spawn", "async"],
  ["approval_recordAmbiguous", "async"],
  ["approval_recordAwaitingOutput", "async"],
  ["approval_recordEffectLanded", "async"],
  ["approval_recordFailedNoEffect", "async"],
  ["approval_recordStarted", "async"],
  ["approval_recordSucceeded", "async"],
  ["approvals_pendingFor", "async"],
  ["approvals_statusOf", "async"],
  ["bulk_deleteBlob", "async"],
  ["bulk_fetchToBlob", "async"],
  ["bulk_iterateJsonl_next", "async"],
  ["calendar_applyIncrementalSyncPages", "async"],
  ["calendar_applyInitialSyncPages", "async"],
  ["calendar_applyPushResult", "async"],
  ["calendar_applyRemoteDeletion", "async"],
  ["calendar_channelToken", "async"],
  ["calendar_createEvent", "async"],
  ["calendar_deleteEvent", "async"],
  ["calendar_finalizeRemoteDelete", "async"],
  ["calendar_findCalendarsForPollFallback", "async"],
  ["calendar_findCalendarsForWatchRenewal", "async"],
  ["calendar_findStalePendingPushes", "async"],
  ["calendar_getAccount", "async"],
  ["calendar_getCalendar", "async"],
  ["calendar_getEvent", "async"],
  ["calendar_grantOrgAccess", "async"],
  ["calendar_handlePushConflict", "async"],
  ["calendar_handleWebhook", "async"],
  ["calendar_importCalendars", "async"],
  ["calendar_listAccounts", "async"],
  ["calendar_listCalendars", "async"],
  ["calendar_listEvents", "async"],
  ["calendar_markCalendarPolled", "async"],
  ["calendar_markPushRejected", "async"],
  ["calendar_notePushFailure", "async"],
  ["calendar_onAccountConnected", "async"],
  ["calendar_onAccountDisconnected", "async"],
  ["calendar_recordImportFailure", "async"],
  ["calendar_recordPushFailure", "async"],
  ["calendar_recordWatchChannel", "async"],
  ["calendar_recoverFromSyncTokenGone", "async"],
  ["calendar_restoreRefusedDelete", "async"],
  ["calendar_retryImport", "async"],
  ["calendar_revertToRemote", "async"],
  ["calendar_runJob", "async"],
  ["calendar_searchEvents", "async"],
  ["calendar_setSelected", "async"],
  ["calendar_stopWatchChannelOnly", "async"],
  ["calendar_updateEvent", "async"],
  ["callerHasScope", "sync"],
  ["codec_base64EncodeUtf8", "async"],
  ["codec_base64UrlEncodeUtf8", "async"],
  ["codec_markdownToEmail", "async"],
  ["config_get", "async"],
  ["config_setSecret", "async"],
  ["connections_describe", "async"],
  ["connections_disconnect", "async"],
  ["connections_getAccounts", "async"],
  ["connections_getCredentials", "async"],
  ["connections_getToken", "async"],
  ["contracts_binding", "async"],
  ["contracts_call", "async"],
  ["contracts_grant", "async"],
  ["contracts_providers", "async"],
  ["contracts_setBinding", "async"],
  ["db_count", "async"],
  ["db_delete", "async"],
  ["db_findMany", "async"],
  ["db_findOne", "async"],
  ["db_insert", "async"],
  ["db_update", "async"],
  ["db_updateMany", "async"],
  ["effects_claim", "async"],
  ["effects_complete", "async"],
  ["effects_markUnknown", "async"],
  ["effects_release", "async"],
  ["effects_settleUnknown", "async"],
  ["emit", "async"],
  ["enqueueJob", "async"],
  ["executeTool", "async"],
  ["fetch", "async"],
  ["files_analyzeDocument", "async"],
  ["files_attachToParent", "async"],
  ["files_getAttachmentBytes", "async"],
  ["files_importAttachment", "async"],
  ["files_importFromUrl", "async"],
  ["files_listAttachments", "async"],
  ["files_reparent", "async"],
  ["getCallerApp", "sync"],
  ["getIngestionCallerApp", "sync"],
  ["getOrgId", "sync"],
  ["getOrgSettings", "async"],
  ["getUserId", "sync"],
  ["getUserSettings", "async"],
  ["grants_setUserScopes", "async"],
  ["hasOnlineUsers", "async"],
  ["hasScope", "async"],
  ["imap_fetch", "async"],
  ["imap_writeBack", "async"],
  ["invalidateIdempotency", "async"],
  ["kernel_findContactsByExternalId", "async"],
  ["kernel_findOne", "async"],
  ["kernel_listApprovals", "async"],
  ["knowledge_addFolderSource", "async"],
  ["knowledge_add_to_collection", "async"],
  ["knowledge_archive", "async"],
  ["knowledge_attentionItems", "async"],
  ["knowledge_collection_create", "async"],
  ["knowledge_collection_delete", "async"],
  ["knowledge_collection_update", "async"],
  ["knowledge_create", "async"],
  ["knowledge_create_validate", "async"],
  ["knowledge_find_by_title", "async"],
  ["knowledge_get", "async"],
  ["knowledge_remove_from_collection", "async"],
  ["knowledge_restore", "async"],
  ["knowledge_search", "async"],
  ["knowledge_source_link_create", "async"],
  ["knowledge_syncedSources", "async"],
  ["knowledge_update", "async"],
  ["knowledge_update_validate", "async"],
  ["knowledge_verify", "async"],
  ["listContactsByExternalId", "async"],
  ["log_debug", "sync"],
  ["log_error", "sync"],
  ["log_info", "sync"],
  ["log_warn", "sync"],
  ["mail_appendInboundMessage", "async"],
  ["mail_applyLabelDelta", "async"],
  ["mail_buildSendGuard", "async"],
  ["mail_checkSendGuard", "async"],
  ["mail_completeIngest", "async"],
  ["mail_conversion_markConverted", "async"],
  ["mail_conversion_readConversation", "async"],
  ["mail_createFromTicket", "async"],
  ["mail_providersGet", "async"],
  ["mail_providersSet", "async"],
  ["mail_purgeDisconnectedAccount", "async"],
  ["mail_releaseForeignAccount", "async"],
  ["mail_search", "async"],
  ["mail_writePage", "async"],
  ["mailbox_enqueueClientJob", "async"],
  ["mailbox_seal", "async"],
  ["mailbox_sealAndInsert", "async"],
  ["mcp_checkConnectionWrite", "async"],
  ["mcp_createConnection", "async"],
  ["mcp_listConnections", "async"],
  ["messages_post", "async"],
  ["nextHandle", "async"],
  ["pdf_render", "async"],
  ["projects_addComment", "async"],
  ["projects_addDependency", "async"],
  ["projects_addStatus", "async"],
  ["projects_attentionItems", "async"],
  ["projects_checklistAddItems", "async"],
  ["projects_checklistGet", "async"],
  ["projects_checklistRemoveItem", "async"],
  ["projects_checklistSetValidation", "async"],
  ["projects_checklistUpdateItem", "async"],
  ["projects_createProject", "async"],
  ["projects_createTask", "async"],
  ["projects_deleteStatus", "async"],
  ["projects_deleteTask", "async"],
  ["projects_get", "async"],
  ["projects_instantiateTemplate", "async"],
  ["projects_labelsArchive", "async"],
  ["projects_labelsCreate", "async"],
  ["projects_labelsList", "async"],
  ["projects_labelsReorder", "async"],
  ["projects_labelsTree", "async"],
  ["projects_labelsUpdate", "async"],
  ["projects_listComments", "async"],
  ["projects_mergeTasks", "async"],
  ["projects_moveTask", "async"],
  ["projects_portfolioRollup", "async"],
  ["projects_resolveAssignee", "async"],
  ["projects_search", "async"],
  ["projects_tasksByAssignee", "async"],
  ["projects_tasksByProject", "async"],
  ["projects_updateProject", "async"],
  ["projects_updateStatus", "async"],
  ["projects_updateTask", "async"],
  ["pubsub_verifyGoogleOidcJwt", "async"],
  ["realtime_publish", "async"],
  ["requestApproval", "async"],
  ["resolveContact", "async"],
  ["sequences_allocate", "async"],
  ["smtp_send", "async"],
  ["threads_deleteEntityDiscussion", "async"],
  ["threads_pruneEntityDiscussion", "async"],
  ["tickets_admin", "async"],
  ["tickets_assign", "async"],
  ["tickets_attentionItems", "async"],
  ["tickets_conversion_closeAsMailConverted", "async"],
  ["tickets_conversion_readTicket", "async"],
  ["tickets_create", "async"],
  ["tickets_createFromMail", "async"],
  ["tickets_deleteIfUnreferenced", "async"],
  ["tickets_get", "async"],
  ["tickets_inboxCounts", "async"],
  ["tickets_listForContact", "async"],
  ["tickets_listSyncableAccounts", "async"],
  ["tickets_markRead", "async"],
  ["tickets_merge", "async"],
  ["tickets_onGmailPushService", "async"],
  ["tickets_processInboundMessage", "async"],
  ["tickets_pullMailReply", "async"],
  ["tickets_runJob", "async"],
  ["tickets_runSync", "async"],
  ["tickets_search", "async"],
  ["tickets_setAudience", "async"],
  ["tickets_setCategory", "async"],
  ["tickets_setLanguage", "async"],
  ["tickets_setPriority", "async"],
  ["tickets_setTeam", "async"],
  ["tickets_summary_ensure", "async"],
  ["tickets_summary_regenerate", "async"],
  ["tickets_summary_runJob", "async"],
  ["tickets_validateAndApply", "async"],
  ["time_civil", "async"],
]

const poisonTx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`bridge construction touched txDb.${String(prop)}`)
    },
  },
) as unknown as RlsClient

const ORG = "00000000-0000-0000-0000-00000000c0a1"
const USER = "00000000-0000-0000-0000-00000000c0a2"
const APP = "method-set-probe"
const manifest = { name: APP }

function surface(bridge: Record<string, any>): Array<[string, string]> {
  return Object.keys(bridge)
    .map((name): [string, string] => {
      const member = bridge[name]
      if (typeof member !== "function") return [name, typeof member]
      return [name, member.constructor.name === "AsyncFunction" ? "async" : "sync"]
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

const expected = EXPECTED_METHODS.map(([name, kind]): [string, string] => [name, kind])

describe("rpc bridge exposes the same method set", () => {
  it("createRpcBridge: every method name with its sync/async kind", () => {
    const bridge = createRpcBridge(APP, USER, ORG, poisonTx, manifest)
    expect(surface(bridge)).toEqual(expected)
  })

  it("createSessionRpcBridge: the same names and kinds", () => {
    const session = {
      run: async () => {
        throw new Error("no bridge method is invoked in this test")
      },
    } as unknown as RlsSession
    const bridge = createSessionRpcBridge(APP, USER, ORG, session, manifest)
    expect(surface(bridge)).toEqual(expected)
  })
})

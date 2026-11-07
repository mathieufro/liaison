// SPDX-License-Identifier: FSL-1.1-ALv2
// Intentional barrel file — re-exports every kernel schema table and enum so
// callers import from "~/db/schema/kernel" rather than individual leaf files.

export type { AgentKnowledgePointer, NewAgentKnowledgePointer } from "./agent-knowledge-pointers"
export { agentKnowledgePointers } from "./agent-knowledge-pointers"
export type { AgentLocalClaim, NewAgentLocalClaim } from "./agent-local-claims"
export { agentLocalClaims } from "./agent-local-claims"
export {
  agentMemory,
  approvalHandleCounters,
  approvalRequests,
  approvedHandlerExecutions,
} from "./agent-memory"
export type { AgentMigrationLedgerRow } from "./agent-migration-ledger"
export { agentMigrationLedger } from "./agent-migration-ledger"
export type { AgentSkillIndex, NewAgentSkillIndex } from "./agent-skill-index"
export { agentSkillIndex } from "./agent-skill-index"
export type {
  AgentThreadCheckpoint,
  NewAgentThreadCheckpoint,
} from "./agent-thread-checkpoints"
export { agentThreadCheckpoints } from "./agent-thread-checkpoints"
export {
  AGENT_TURN_FAILURE_REASONS,
  AGENT_TURN_ORIGINS,
  AGENT_TURN_STATES,
  type AgentTurnEventRow,
  type AgentTurnFailureReason,
  type AgentTurnOrigin,
  type AgentTurnRestrictions,
  type AgentTurnResumeInput,
  type AgentTurnRow,
  type AgentTurnState,
  agentTurnEvents,
  agentTurns,
} from "./agent-turns"
export type { Agent, AgentKind, NewAgent } from "./agents"
export { agentKindEnum, agents } from "./agents"
export type { AppSeededAssets, NewAppSeededAssets } from "./app-seeded-assets"
export { appSeededAssets } from "./app-seeded-assets"
export { appSequences } from "./app-sequences"
export type { ApprovalPolicy, NewApprovalPolicy } from "./approval-policies"
export { approvalPolicies } from "./approval-policies"
export { appStatusEnum, apps, orgAppAccess } from "./apps"
export { appActivationEvents, appsActiveVersion, appsInstalled } from "./apps-installed"
export { attentionEvents } from "./attention-events"
export { attentionSubscriptions } from "./attention-subscriptions"
export { actorTypeEnum, auditLog } from "./audit-log"
export type { AutoApprovePolicy, NewAutoApprovePolicy } from "./auto-approve-policies"
export { autoApprovePolicies } from "./auto-approve-policies"
export type { AwayRange, NewAwayRange } from "./away-ranges"
export { awayRanges } from "./away-ranges"
export type { CloudRequestOutcomeRow } from "./cloud-request-outcomes"
export { cloudRequestOutcomes } from "./cloud-request-outcomes"
export { type ConfigAppliedFieldRow, configAppliedFields } from "./config-applied-fields"
export { connectedAccounts } from "./connected-accounts"
export type { ConnectionTeardownRow } from "./connection-teardowns"
export { connectionTeardowns } from "./connection-teardowns"
export type {
  ContactAddressOrigin,
  ContactAddressRole,
  ContactAddressSource,
  ContactSegmentKind,
  OrgAccess,
} from "./contacts"
export {
  contactAddresses,
  contactGroupMembers,
  contactSegments,
  contacts,
  trustedSenders,
} from "./contacts"
export type { ControlPlaneOutboxRow } from "./control-plane-outbox"
export { controlPlaneOutbox } from "./control-plane-outbox"
export { creditBalances, creditTransactions, modelPricing } from "./credits"
export { demoLeads } from "./demo-leads"
export { demoSpend } from "./demo-spend"
export { type DemoWorldMarkRow, demoWorldMarks } from "./demo-world-marks"
export { deviceFlowRequests, deviceFlowStateEnum } from "./device-flow"
export type { DisabledAppSkill, NewDisabledAppSkill } from "./disabled-app-skills"
export { disabledAppSkills } from "./disabled-app-skills"
export {
  type DocumentTemplateRuleRow,
  documentTemplateRules,
} from "./document-template-rules"
export {
  type DocumentTemplateField,
  type DocumentTemplateKind,
  type DocumentTemplateMappingEntry,
  type DocumentTemplateRow,
  documentTemplates,
} from "./document-templates"
export type { DurableConsumerMark } from "./durable-consumer-marks"
export { durableConsumerMarks } from "./durable-consumer-marks"
export {
  EFFECT_LEDGER_STATES,
  type EffectLedgerRow,
  type EffectLedgerState,
  effectLedger,
} from "./effect-ledger"
export { fileUploadSessions } from "./file-upload-sessions"
export { files } from "./files"
export {
  type ImportLedgerRow,
  type ImportRunCounts,
  type ImportRunRow,
  type ImportRunStatus,
  importLedger,
  importRuns,
} from "./import-runs"
export { type ImportTransform, importTransforms } from "./import-transforms"
export { type ImportUpload, importUploads } from "./import-uploads"
export { invitations } from "./invitations"
export type {
  MailboxClientJob,
  MailboxMigrationState,
  NewUserKeyWrap,
  NewUserMailboxIdentity,
  UserKeyWrap,
  UserMailboxIdentity,
} from "./mailbox-keys"
export {
  bytea,
  instanceSettings,
  mailboxClientJobs,
  mailboxMigrationState,
  mailboxServerKeys,
  userKeyWraps,
  userMailboxIdentities,
} from "./mailbox-keys"
export { mcpConnections, mcpOauthClients } from "./mcp"
export {
  NODE_JOB_KINDS,
  NODE_JOB_RESUME_AFTER,
  NODE_JOB_SOURCES,
  NODE_JOB_STATUSES,
  NODE_LEVEL_CONFIRMATION_PURPOSES,
  NODE_PERMISSION_MODES,
  NODE_PROMPT_STATUSES,
  NODE_RUNS_ON,
  NODE_SESSION_COMMAND_OUTCOMES,
  type NodeJobKind,
  type NodeJobResumeAfter,
  type NodeJobSource,
  type NodeJobStatus,
  type NodeLevelConfirmationPurpose,
  type NodePermissionMode,
  type NodePromptStatus,
  type NodeRunsOn,
  type NodeSessionCommandOutcome,
  type NodeSharedFolder,
  nodeAttachments,
  nodeCapabilities,
  nodeConnections,
  nodeJobs,
  nodeLevelConfirmations,
  nodePermissionPrompts,
  nodeProfiles,
  nodeSessionCommands,
  nodeSessionEvents,
  nodeSessions,
  nodes,
  threadNodeSettings,
} from "./nodes"
export {
  DELIVERY_RESULTS,
  DELIVERY_SURFACES,
  type DeliveryResult,
  type DeliverySurface,
  type NotificationDelivery,
  notificationDeliveries,
} from "./notification-deliveries"
export {
  browserPushSubscriptions,
  CREDENTIAL_SURFACES,
  type CredentialSurface,
  DESKTOP_PERMISSIONS,
  type DesktopPermission,
  desktopDevices,
  notificationDeviceCredentials,
  notificationReceipts,
  RECEIPT_OUTCOMES,
  type ReceiptOutcome,
} from "./notification-devices"
export { oauthAccounts, oauthProviders } from "./oauth"
export type { NewOrgAppFeature, OrgAppFeature } from "./org-app-features"
export { orgAppFeatures } from "./org-app-features"
export { type OrgBillingStateRow, orgBillingState, type StorageEstimate } from "./org-billing-state"
export {
  type LegalArchiveRow,
  legalArchives,
  type OrgDeletionExport,
  type OrgDeletionRow,
  type OrgDeletionStatus,
  type OrgDeletionWaiver,
  orgDeletions,
} from "./org-deletions"
export { type OrgExportRow, type OrgExportStatus, orgExports } from "./org-exports"
export type { OrgTransferLedgerRow } from "./org-transfer-ledger"
export { orgTransferLedger } from "./org-transfer-ledger"
export { kernel, organizations } from "./organizations"
export { passwordResets } from "./password-resets"
export { pendingEvents } from "./pending-events"
export { type ProductAttributeRow, productAttributes } from "./product-attributes"
export type { NewPushToken, PushToken } from "./push-tokens"
export { pushPlatformEnum, pushTokens } from "./push-tokens"
export { resourceGrants } from "./resource-grants"
export type { RestoreDrillMarkerRow } from "./restore-drill-markers"
export { restoreDrillMarkers } from "./restore-drill-markers"
export {
  appScopeGrantAudit,
  roleDimensionGrants,
  roleScopeGrants,
  roles,
  userDimensionGrants,
  userRoles,
  userScopeGrants,
} from "./roles"
export type { NewRoutineRun, RoutineRun } from "./routine-runs"
export { routineRuns } from "./routine-runs"
export type { NewRoutineState, RoutineState } from "./routine-state"
export { routineState } from "./routine-state"
export type { NewRoutine, Routine } from "./routines"
export { routines } from "./routines"
export { savedViews } from "./saved-views"
export type { NewScopeDisclosurePolicy, ScopeDisclosurePolicy } from "./scope-disclosure-policy"
export { scopeDisclosurePolicy } from "./scope-disclosure-policy"
export type { ScopeRequest, ScopeRequestInsert } from "./scope-requests"
export { scopeRequests } from "./scope-requests"
export {
  SECRET_REQUEST_KINDS,
  SECRET_REQUEST_STATUSES,
  type SecretRequest,
  type SecretRequestKind,
  type SecretRequestStatus,
  secretRequests,
} from "./secret-requests"
export { sessions } from "./sessions"
export type { NewSkill, Skill } from "./skills"
export { skills } from "./skills"
export type {
  ContextProfile,
  NewSubAgentDefinition,
  SubAgentDefinition,
} from "./sub-agent-definitions"
export { subAgentDefinitions } from "./sub-agent-definitions"
export type {
  AgentRun,
  AgentRunStatus,
  NewAgentRun,
} from "./sub-agent-runs"
export { agentRuns } from "./sub-agent-runs"
export { systemConfig } from "./system-config"
export type {
  BriefRowKind,
  BriefRowStatus,
  NewThreadBrief,
  NewThreadBriefMark,
  NewThreadEpisode,
  ThreadBrief,
  ThreadBriefMark,
  ThreadEpisode,
} from "./thread-briefs"
export {
  BRIEF_ROW_KINDS,
  BRIEF_ROW_STATUSES,
  threadBriefMarks,
  threadBriefs,
  threadEpisodes,
} from "./thread-briefs"
export {
  messageReactions,
  messages,
  replyThreadFollowers,
  threadParticipants,
  threadReferences,
  threads,
  userThreadState,
} from "./threads"
export { timelineEntries } from "./timeline-entries"
export { type TourProgressRow, tourProgress } from "./tour-progress"
export { userPreferences } from "./user-preferences"
export { userStatusEnum, users } from "./users"

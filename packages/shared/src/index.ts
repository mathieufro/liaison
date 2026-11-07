// SPDX-License-Identifier: FSL-1.1-ALv2
// Public API barrel — the only barrel file in the project

export {
  agentSpeakerName,
  ownerFirstName,
  PERSONAL_AGENT_DISPLAY_NAME,
  personalAgentLabel,
} from "./agents/personal-agent-name"
export * from "./app-frame-document"
export * from "./app-icon-svg"
export * from "./app-signing/keys"
export * from "./app-signing/revocations"
export * from "./app-signing/statement"
export * from "./app-signing/verify"
export * from "./app-tab-routes"
export type {
  ApprovalAuthorityFacts,
  ApprovalRoute,
  AuthorityViewer,
  AwayDays,
  AwayRangeDays,
  HomePlacement,
  PeerRequestFacts,
  RoutingFacts,
  RoutingWorld,
} from "./approvals/authority"
export {
  awayRunEnd,
  canDecidePure,
  canEditPure,
  canSeeInFeed,
  canSeeInList,
  decidingScope,
  decidingScopeForToolDef,
  factsFromSummary,
  holdsDecidingScope,
  homePlacement,
  isAwayOn,
  isNotified,
  isOwnerRouted,
  isPeerSelfApprovable,
  isRequester,
  isSharedSurfaceFacts,
  MAIL_DRAFT_READ_SCOPE,
  personLocalDate,
  routeApproval,
  SHARED_SURFACE_APPROVAL_TOOLS,
  sharedSurfaceDraftReadScope,
  TICKET_DRAFT_READ_SCOPE,
} from "./approvals/authority"
export { APPROVING_WEDGE_GRACE_MS, isApprovingWedged } from "./approvals/wedge-grace"
export * from "./calendar-recurrence"
export {
  CAPABILITY_LABELS,
  capabilityCategories,
  capabilityLabel,
  GENERIC_CAPABILITY_LABEL,
  WILDCARD_CAPABILITY_CATEGORY,
} from "./capability-categories"
export type {
  AppNameOptions,
  CapabilityChip,
  CapabilityVocabulary,
  CategoryLabelOptions,
  ScopeLabelOptions,
} from "./capability-display"
export {
  APP_DISPLAY_NAMES,
  appDisplayName,
  capabilityCategoryChip,
  DEFAULT_CAPABILITY_VOCABULARY,
  humanizeSlug,
  roleScopeKey,
  scopeDisplayLabel,
} from "./capability-display"
export * from "./connect-failures"
export { csvCell } from "./csv"
export * from "./demo/needs"
export * from "./emoji-shortcodes"
export type { HtmlToTextOptions } from "./html-to-text"
export { htmlToText } from "./html-to-text"
export type { LocaleDict, NamespaceDicts } from "./i18n/dictionaries"
export { dictionariesFor, englishDictionaries } from "./i18n/dictionaries"
export type { ShippedLocale } from "./i18n/locales"
export { resolveLocale, SHIPPED_LOCALES, toShippedLocale } from "./i18n/locales"
export * from "./imap-login-failures"
export {
  IMPORT_PLACEHOLDER_EMAIL_DOMAIN,
  IMPORT_PLACEHOLDER_EMAIL_LIKE,
  importPlaceholderEmail,
  isImportPlaceholderEmail,
} from "./import-placeholder"
export * from "./label-skeleton"
export * from "./line-diff"
export * from "./mail-participant"
export type { EmailBody } from "./markdown-email"
export { markdownToEmail } from "./markdown-email"
export { editorMarkdown, matchUnderline } from "./markdown-rules"
export type { Entry as MemoryLinkEntry, LinkToken as MemoryLinkToken } from "./memory-links"
export { extractLinkedNames, resolveMemoryLinks } from "./memory-links"
export type { ModelPricingSeedEntry } from "./model-pricing-seed"
export { BOOTSTRAP_ECB_RATE, MODEL_PRICING_SEED } from "./model-pricing-seed"
export * from "./node-chat-modes"
export * from "./node-folders"
export * from "./node-guardrails"
export * from "./node-import"
export * from "./node-levels"
export * from "./node-models"
export * from "./node-session-files"
export * from "./node-session-paths"
export * from "./node-session-protocol"
export * from "./notifications/approval-reminder"
export * from "./notifications/badge"
export * from "./notifications/groups"
export * from "./pdf/commands"
export * from "./pdf/text-layout"
export { isProviderCreditBlockError } from "./provider-errors"
export type { ModelReasoningCapability, ReasoningLevel } from "./reasoning"
export {
  AUTO_REASONING_LEVEL,
  canDisableThinking,
  DEMO_BOX_KEY_REASONING_LEVEL,
  getReasoningCapability,
  REASONING_LEVELS,
  reasoningCapableProvider,
  reasoningLevelSchema,
  resolveTurnReasoningLevel,
} from "./reasoning"
export * from "./refs"
export * from "./reserved-web-routes"
export type { MemoryEntry, MemoryFrontmatter, MemoryType } from "./schemas/agent-memory"
export {
  isLegalMemoryPath,
  isLegalMemorySlug,
  MEMORY_FILE_TYPES,
  MEMORY_INDEX_PATH,
  MEMORY_TYPES,
  MemoryCreateParamsSchema,
  MemoryCreateSchema,
  MemoryDeleteParamsSchema,
  MemoryEntrySchema,
  MemoryFileTypeSchema,
  MemoryFrontmatterSchema,
  MemoryInsertParamsSchema,
  MemoryNameSchema,
  MemoryOpenParamsSchema,
  MemoryPathSchema,
  MemoryRenameParamsSchema,
  MemorySearchParamsSchema,
  MemoryStrReplaceParamsSchema,
  MemoryTypeSchema,
  MemoryUpdateSchema,
  MemoryViewParamsSchema,
} from "./schemas/agent-memory"
export * from "./secret-redaction"
export { isValidServerAddress, normalizeServerAddress } from "./server-address"
export * from "./setup-guides"
export * from "./status-lines"
export { relabelAgentMentions } from "./threads/agent-mention-labels"
export type { AgentNoticeCode, ProviderNoticeCode } from "./threads/agent-notice"
export {
  AGENT_NOTICE_DETAIL_MAX,
  AGENT_NOTICE_I18N_KEYS,
  AGENT_NOTICE_META_KEY,
  AGENT_NOTICE_STORED_LINES,
  agentNoticeCode,
  agentNoticeDetail,
  agentNoticeStoredText,
  classifyProviderError,
  localizeAgentNotice,
  redactSecretShapes,
  safeAgentNoticeDetail,
} from "./threads/agent-notice"
export type {
  ConversationFacts,
  ConversationKind,
  ConversationSeat,
} from "./threads/conversation-shape"
export {
  classifyConversation,
  isChannelShape,
  isDirectMessageShape,
  otherSeats,
  soleAgentCounterpart,
} from "./threads/conversation-shape"
export type { DmIdentitySeat } from "./threads/dm-identity"
export {
  AGENT_GUEST_SEAT_ROLE,
  conversationIdentitySeats,
  MENTION_SEAT_ORIGIN,
  seatMakesGroupOfDm,
} from "./threads/dm-identity"
export type {
  LocalTurnRecord,
  LocalTurnTimelineEntry,
  LocalTurnToolCall,
  LocalTurnUsage,
} from "./threads/local-turn"
export {
  normalizeLocalToolName,
  redactArgs,
  redactResult,
  redactSecrets,
  sanitizeLocalTurnRecord,
} from "./threads/local-turn"
export { messagePlainText } from "./threads/plain-text"
export type { ThreadAnchor } from "./threads/thread-anchor"
export {
  parseThreadAnchor,
  threadAnchorKind,
  threadAnchorKindKey,
  threadAnchorMessageRoute,
  threadAnchorRoute,
  threadAnchorTitle,
} from "./threads/thread-anchor"
export {
  isChatListThreadType,
  isRunLogThreadType,
  NOT_CHAT_LIST_THREAD_TYPES,
  RUN_LOG_THREAD_TYPES,
} from "./threads/thread-kind"
export type { OrgTier } from "./tier-allowance"
export { TIER_ALLOWANCE, TIER_ORDER, tierAtLeast } from "./tier-allowance"
export * from "./tool-card"
export * from "./tours/api"
export * from "./tours/index"
export * from "./tours/schema"
export * from "./types/index"
export * from "./validation/index"

// SPDX-License-Identifier: FSL-1.1-ALv2
// @liaison/app-sdk — Backend SDK for Liaison app handlers
// Provides typed AppContext interface, defineHandlers helper, and schema builder.

export {
  APP_CONFIG_KEY_TYPES,
  APP_CONFIG_VALUE_MAX_BYTES,
  type AppConfigKeyDecl,
  type AppConfigKeyType,
  type AppConfigWriteCheck,
  type AppConfigWriteErrorCode,
  appConfigKeySchema,
  appConfigValueError,
  checkAppConfigWrite,
  configKeysDeclarationErrors,
  connectionSecretConfigKeys,
} from "./app-config-keys"
export {
  APP_LISTING_CATEGORIES,
  type AppListing,
  type AppListingCategory,
  appListingSchema,
  FORBIDDEN_LISTING_KEYS,
  isSpdxLicenseExpression,
  listingDeclarationErrors,
} from "./app-listing"
export {
  APP_KINDS,
  type AppKind,
  type AppSettingsSchema,
  appKindSchema,
  appSettingsSchema,
  DEFAULT_SETTINGS_ADMIN_SCOPE,
  fieldSourceKind,
  isReservedSettingsNamespace,
  RESERVED_SETTINGS_NAMESPACES,
  SETTINGS_FIELD_TYPES,
  SETTINGS_SECRET_KEY_PATTERN,
  type SettingsBlock,
  type SettingsConnectionsBlock,
  type SettingsCustomBlock,
  type SettingsDeclarationOptions,
  type SettingsField,
  type SettingsFieldSource,
  type SettingsFieldType,
  type SettingsListBlock,
  type SettingsListCreateField,
  type SettingsSection,
  type SettingsTreeBlock,
  settingsBlockSchema,
  settingsDeclarationErrors,
  settingsSectionSchema,
} from "./app-settings"
export { defineHandlers } from "./define-handlers"
export { refuseTool, ToolError, type ToolRefusal } from "./errors"
export { minorAmountRefusal, readMinorAmount } from "./minor-amount"
export {
  type AppRegistryEntry,
  appRegistryEntrySchema,
  LIAISON_APP_VERSION,
  ManifestValidationError,
  OPTIONAL_FILES,
  type PackageManifest,
  packageManifestSchema,
  REQUIRED_FILES,
  validateManifest,
} from "./package-format"
export {
  type DrawCommand,
  type DrawImageOptions,
  type DrawLineOptions,
  type DrawRectangleOptions,
  type DrawTextOptions,
  PdfBuilder,
  PdfPage,
  type Point,
  type RgbColor,
  rgb,
  type StandardFontName,
} from "./pdf-builder"
export type {
  AppContext,
  ConnectionClient,
  ConnectionSettings,
  CrossAppEnvelope,
  DbClient,
  FetchAuth,
  FetchMultipartPart,
  Logger,
  UpstreamProbeResult,
  WebhookResult,
} from "./types"

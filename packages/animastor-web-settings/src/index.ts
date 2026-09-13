// @animastor/web-settings public entry point.
//
// Pure AI provider and Local AI Connector helpers — provider validation,
// connector lifecycle, status mapping, sharing badges, and timestamp
// formatting. Zero host dependencies; pure functions and types only.
//
// Host consumers:
//   pages/SettingsPage.tsx — aiProviders exports
//   features/localAi/LocalAISection.tsx — both aiProviders and localAi exports
//
// The package imports nothing but its own internal modules. No host stores,
// no api/client, no i18n, no DOM. The host consumes ONLY through this entry.

// ── AI Provider helpers ────────────────────────────────────────────────────
export type { ProviderType, ProviderStatus, AiProviderMeta, AiProviderRead, AiProviderList, AiProviderTest, ValidationResult } from './aiProviders';
export {
  PROVIDER_TYPE_OPTIONS,
  VALID_PROVIDER_TYPES,
  OPENROUTER_DEFAULT_ENDPOINT,
  normalizeMeta,
  endpointPlaceholderFor,
  validateProviderInput,
  describeTestResult,
  statusLabel,
  formatLastTested,
  canSave,
} from './aiProviders';

// ── Local AI Connector helpers ─────────────────────────────────────────────
export type {
  ConnectorRuntimeType,
  ConnectorStatus,
  AiConnectorStatus,
  AiConnectorModels,
  RegistrationResponse,
  RotateResponse,
  RefreshModelsResponse,
  ConnectorTestResponse,
  LocalProviderMeta,
  AiEndpoint,
  ShareStatus,
} from './localAi';
export {
  RUNTIME_TYPE_OPTIONS,
  VALID_RUNTIME_TYPES,
  REGISTRATION_STEP_KEYS,
  OFFLINE_TROUBLESHOOT_KEYS,
  validateCreateInput,
  looksLikeRegToken,
  looksLikeConnectorCredential,
  statusKey,
  statusClass,
  runtimeReachable,
  runtimeInfo,
  formatLastSeen,
  connectorErrorKey,
  regTokenExpired,
  buildRunCommand,
  buildBindingBody,
  shareStatus,
  shareStatusKey,
  shareStatusClass,
} from './localAi';

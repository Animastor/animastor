// @animastor/web-local-ai public entry point.
//
// Local AI Connector section UI for Animastor web frontend:
//   - connector lifecycle (create/rotate/revoke) with one-time token disclosure
//   - explicit model refresh (never automatic — AD-7)
//   - provider binding (Connector ≠ Provider — AD-2)
//   - user-initiated test probe
//   - Share this AI endpoints (LLM Sharing Phase 1 owner control plane)
//
// Host capabilities (api, i18n, ui) arrive via the injected LocalAiPorts
// contract. Domain logic is consumed from the pure @animastor/web-settings
// package — the first package→package dependency in the web layer.
//
// Host consumers:
//   pages/SettingsPage.tsx — LocalAISection (section === 'local-ai')

// Ports and types
export type {
  LocalAiPorts,
  LocalAiApiPort,
  LocalAiApiError,
  LocalAiI18nPort,
  LocalAiI18nKey,
  LocalAiUiPort,
  LocalAiModalProps,
} from './ports';

// Components (require LocalAiPorts injection)
export { LocalAISection } from './LocalAISection';

// LocalAiPorts — the complete host contract of the @animastor/web-local-ai
// package (docs/architecture/web-local-ai-extraction-audit.md).
//
// Dependency direction (frozen by arch guards):
//
//   host app (SettingsPage.tsx) ──composition──▶ app/localAiAdapters.ts
//   app/localAiAdapters.ts ──implements──▶ LocalAiPorts (this file)
//   LocalAi modules ──consumes ONLY──▶ LocalAiPorts
//   LocalAi modules ──imports──▶ @animastor/web-settings (pure Tier B
//                                package — the first package→package dep)
//
// The Local AI contour (LocalAISection) must never import api/client,
// app/i18n, lib/ui, or any host module directly. The ONLY host-side place
// where those modules meet this contract is app/localAiAdapters.ts.
//
// Port payload types are LocalAi-local structural types (NOT imports of the
// host types): the host adapter bridges them, and TypeScript rejects the
// adapter the moment a host type drifts from this contract.

import type { JSX } from 'preact';

// ── Error contract (package-owned minimal surface) ──────────────────────────

/** Minimal API error contract the Local AI modules need. The host adapter
 *  bridges the real host ApiError; this is a structural subtype — the
 *  TypeScript compiler verifies the adapter at the seam. */
export interface LocalAiApiError {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  readonly code?: string;
}

// ── API port ───────────────────────────────────────────────────────────────

/** API port — the HTTP surface the Local AI modules consume. */
export interface LocalAiApiPort {
  getJson: <T>(url: string) => Promise<T>;
  postJson: <T>(url: string, body?: unknown) => Promise<T>;
  putJson: <T>(url: string, body: unknown) => Promise<T>;
  deleteJson: <T>(url: string) => Promise<T>;
  ApiError: new (message: string, status: number, code?: string) => LocalAiApiError;
}

// ── i18n key union ──────────────────────────────────────────────────────────

/** i18n keys the Local AI surface needs (the dictionary stays host-owned).
 *  Covers every literal call site PLUS the keys returned by the
 *  @animastor/web-settings helpers (statusKey, shareStatusKey,
 *  connectorErrorKey, validateCreateInput errors, RUNTIME_TYPE_OPTIONS
 *  labelKeys, REGISTRATION_STEP_KEYS, OFFLINE_TROUBLESHOOT_KEYS). */
export type LocalAiI18nKey =
  // Provider binding / common
  | 'ai_provider_last_tested'
  | 'ai_provider_model'
  | 'ai_provider_test'
  | 'ai_provider_test_ok'
  | 'dialog_cancel'
  | 'play_loading'
  // Local AI section chrome
  | 'local_ai_add_hint'
  | 'local_ai_add_title'
  | 'local_ai_bind'
  | 'local_ai_binding_active'
  | 'local_ai_binding_none'
  | 'local_ai_bound'
  | 'local_ai_bound_badge'
  | 'local_ai_create'
  | 'local_ai_credential_warning'
  | 'local_ai_desc'
  | 'local_ai_empty'
  | 'local_ai_err_auth'
  | 'local_ai_err_forbidden'
  | 'local_ai_err_generic'
  | 'local_ai_err_no_models'
  | 'local_ai_err_not_found'
  | 'local_ai_err_rate_limited'
  | 'local_ai_list_title'
  | 'local_ai_model_auto'
  | 'local_ai_model_pick_hint'
  | 'local_ai_models_count'
  | 'local_ai_models_disclaimer'
  | 'local_ai_models_refreshed'
  | 'local_ai_name_hint'
  | 'local_ai_name_label'
  | 'local_ai_pending_hint'
  | 'local_ai_rebind'
  | 'local_ai_refresh_models'
  | 'local_ai_reg_expired'
  | 'local_ai_reg_title'
  | 'local_ai_reg_token_label'
  | 'local_ai_reg_ttl_hint'
  | 'local_ai_reissue_token'
  | 'local_ai_revoke_confirm'
  | 'local_ai_revoked'
  | 'local_ai_revoke_hint'
  | 'local_ai_rotate_hint'
  | 'local_ai_run_command_label'
  | 'local_ai_runtime_label'
  | 'local_ai_runtime_ok'
  | 'local_ai_runtime_unknown'
  | 'local_ai_setup_intro'
  | 'local_ai_setup_title'
  | 'local_ai_test_cold_warning'
  | 'local_ai_test_fail'
  | 'local_ai_title'
  | 'local_ai_unbind'
  | 'local_ai_unbound'
  // LLM Sharing Phase 1
  | 'share_ai_concurrency_label'
  | 'share_ai_create_endpoint'
  | 'share_ai_create_endpoint_hint'
  | 'share_ai_disabled_notice'
  | 'share_ai_enable_confirm'
  | 'share_ai_enabled_notice'
  | 'share_ai_endpoint_created'
  | 'share_ai_endpoint_deleted'
  | 'share_ai_models_label'
  | 'share_ai_no_endpoint_hint'
  | 'share_ai_share_button'
  | 'share_ai_title'
  | 'share_ai_unshare_button'
  // Shared worker-pill strings (host CSS/i18n reuse)
  | 'worker_copied'
  | 'worker_copy'
  | 'worker_copy_failed'
  | 'worker_delete'
  | 'worker_done'
  | 'worker_last_seen'
  | 'worker_revoke'
  | 'worker_rotate'
  | 'worker_rotate_short'
  | 'worker_trouble_title'
  // Keys returned by @animastor/web-settings helpers (dynamic call sites)
  // — validateCreateInput errors
  | 'local_ai_name_required'
  | 'local_ai_name_too_long'
  | 'local_ai_runtime_invalid'
  // — RUNTIME_TYPE_OPTIONS labelKeys
  | 'local_ai_runtime_ollama'
  | 'local_ai_runtime_vllm'
  | 'local_ai_runtime_llamacpp'
  | 'local_ai_runtime_lmstudio'
  | 'local_ai_runtime_openai_compatible'
  // — statusKey
  | 'local_ai_status_pending'
  | 'local_ai_status_online'
  | 'local_ai_status_offline'
  // — REGISTRATION_STEP_KEYS
  | 'local_ai_setup_step_1'
  | 'local_ai_setup_step_2'
  | 'local_ai_setup_step_3'
  | 'local_ai_setup_step_4'
  // — OFFLINE_TROUBLESHOOT_KEYS
  | 'local_ai_trouble_process'
  | 'local_ai_trouble_runtime'
  | 'local_ai_trouble_network'
  // — shareStatusKey
  | 'share_ai_status_private'
  | 'share_ai_status_shared'
  | 'share_ai_status_offline'
  | 'share_ai_status_runtime_unavailable'
  // — connectorErrorKey vocabulary
  | 'local_ai_err_offline'
  | 'local_ai_err_timeout'
  | 'local_ai_err_runtime_unreachable'
  | 'local_ai_err_model_not_found'
  | 'local_ai_err_busy'
  | 'local_ai_err_context_length'
  | 'local_ai_err_bad_response'
  | 'local_ai_err_runtime_error'
  | 'local_ai_err_response_too_large'
  | 'local_ai_err_request_too_large'
  | 'local_ai_err_invalid_request'
  | 'local_ai_err_discovery_failed'
  | 'local_ai_err_registration_expired'
  | 'local_ai_err_registration_used';

// ── i18n port ──────────────────────────────────────────────────────────────

export interface LocalAiI18nPort {
  t: (key: LocalAiI18nKey, fallback?: string) => string;
  tf: (key: LocalAiI18nKey, ...params: unknown[]) => string;
}

// ── Modal component type ────────────────────────────────────────────────────

export interface LocalAiModalProps {
  title?: string;
  onClose: () => void;
  footer?: JSX.Element | JSX.Element[];
  children: JSX.Element | JSX.Element[];
}

// ── UI port ────────────────────────────────────────────────────────────────

export interface LocalAiUiPort {
  Modal: (props: LocalAiModalProps) => JSX.Element;
  toast: (message: string, duration?: number) => void;
}

// ── Ports ──────────────────────────────────────────────────────────────────

/** The complete host contract consumed by the Local AI modules. */
export interface LocalAiPorts {
  api: LocalAiApiPort;
  i18n: LocalAiI18nPort;
  ui: LocalAiUiPort;
}

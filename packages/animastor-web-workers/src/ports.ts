// WorkerPorts — the complete host contract of the @animastor/web-workers
// package (docs/architecture/web-workers-extraction-audit.md).
//
// Dependency direction (frozen by arch guards):
//
//   host app (SettingsPage.tsx) ──composition──▶ app/workerAdapters.ts
//   app/workerAdapters.ts ──implements──▶ WorkerPorts (this file)
//   Worker modules ──consumes ONLY──▶ WorkerPorts (+ package-internal modules)
//
// The Worker contour (privateWorkers / workerSetup / sharing /
// shareNotifications / PrivateWorkersSection / WorkerSharingUI) must never
// import api/client, app/i18n, app/icons, state/authStore, or lib/ui
// directly. The ONLY host-side place where those modules meet this contract
// is app/workerAdapters.ts.
//
// Port payload types are Worker-local structural types (NOT imports of the
// host types): the host adapter bridges them, and TypeScript rejects
// the adapter the moment a host type drifts from this contract.

import type { JSX } from 'preact';

// ── Error contract (package-owned minimal surface) ──────────────────────────

/** Minimal API error contract the Worker modules need. The host adapter
 *  bridges the real host ApiError; this is a structural subtype — the
 *  TypeScript compiler verifies the adapter at the seam. */
export interface WorkerApiError {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  readonly code?: string;
}

// ── API port ───────────────────────────────────────────────────────────────

/** API port — the HTTP surface the Worker modules consume. */
export interface WorkerApiPort {
  getJson: <T>(url: string) => Promise<T>;
  postJson: <T>(url: string, body?: unknown) => Promise<T>;
  deleteJson: <T>(url: string) => Promise<T>;
  deleteJsonBody: <T>(url: string, body: unknown) => Promise<T>;
  ApiError: new (message: string, status: number, code?: string) => WorkerApiError;
}

// ── i18n key union ──────────────────────────────────────────────────────────

/** i18n keys the Worker surface needs (the dictionary stays host-owned). */
export type WorkerI18nKey =
  // Worker management
  | 'worker_mgmt_desc'
  | 'worker_mgmt_title'
  | 'worker_add'
  | 'worker_create'
  | 'worker_name'
  | 'worker_name_hint'
  | 'worker_name_required'
  | 'worker_name_too_long'
  | 'worker_type_invalid'
  | 'worker_empty'
  | 'worker_done'
  | 'worker_copy'
  | 'worker_copy_failed'
  | 'worker_copied'
  | 'worker_credential_warning'
  | 'worker_last_seen'
  | 'worker_details_title'
  | 'worker_details_gpu'
  | 'worker_details_vram'
  | 'worker_details_profiles'
  | 'worker_details_workflows'
  | 'worker_details_capabilities_empty'
  | 'worker_details_uninstall'
  | 'worker_rotate'
  | 'worker_rotate_short'
  | 'worker_rotate_confirm'
  | 'worker_revoke'
  | 'worker_revoke_confirm'
  | 'worker_revoked'
  | 'worker_delete'
  | 'worker_delete_confirm'
  | 'worker_deleted'
  | 'worker_offline_hint'
  | 'worker_trouble_title'
  | 'worker_trouble_hub_url'
  | 'worker_trouble_token'
  | 'worker_trouble_process'
  | 'worker_trouble_network'
  | 'worker_access_public'
  | 'worker_access_private'
  | 'worker_err_auth_required'
  | 'worker_err_forbidden'
  | 'worker_err_not_found'
  | 'worker_err_unavailable'
  // Setup Center
  | 'worker_setup_center_title'
  | 'worker_setup_choose_profile'
  | 'worker_setup_recommended'
  | 'worker_setup_draft_badge'
  | 'worker_setup_set_up'
  | 'worker_setup_disk_budget'
  | 'worker_setup_mode_title'
  | 'worker_setup_mode_managed'
  | 'worker_setup_mode_managed_desc'
  | 'worker_setup_mode_managed_unavailable'
  | 'worker_setup_mode_existing'
  | 'worker_setup_mode_existing_desc'
  | 'worker_setup_mode_existing_unavailable'
  | 'worker_setup_existing_warning'
  | 'worker_setup_platform_title'
  | 'worker_setup_availability_stable'
  | 'worker_setup_availability_preview'
  | 'worker_setup_availability_experimental'
  | 'worker_setup_platform_ready'
  | 'worker_setup_platform_existing_only'
  | 'worker_setup_platform_no_installer'
  | 'worker_setup_platform_soon'
  | 'worker_setup_platform_unavailable'
  | 'worker_setup_create_title'
  | 'worker_setup_key_title'
  | 'worker_setup_key_installer_note'
  | 'worker_setup_installer_title'
  | 'worker_setup_installer_version_line'
  | 'worker_setup_version_fmt'
  | 'worker_setup_download_installer'
  | 'worker_setup_checksum'
  | 'worker_setup_installer_unavailable'
  | 'worker_setup_installer_down_existing_hint'
  | 'worker_setup_bundle_title'
  | 'worker_setup_bundle_note'
  | 'worker_setup_download_bundle'
  | 'worker_setup_workflows_title'
  | 'worker_setup_workflow_none'
  | 'worker_setup_workflow_download'
  | 'worker_setup_workflow_unavailable'
  | 'worker_setup_workflow_optional'
  | 'worker_setup_instructions_title'
  | 'worker_setup_verify_command_label'
  | 'worker_setup_verify_hint'
  | 'worker_setup_report_problem_hint'
  | 'worker_setup_report_problem'
  | 'worker_setup_step_prereq_title'
  | 'worker_setup_step_prereq_body'
  | 'worker_setup_step_download_bootstrap_title'
  | 'worker_setup_step_download_bootstrap_body'
  | 'worker_setup_step_run_bootstrap_title'
  | 'worker_setup_step_run_bootstrap_body'
  | 'worker_setup_step_download_bundle_title'
  | 'worker_setup_step_download_bundle_body'
  | 'worker_setup_step_unpack_bundle_title'
  | 'worker_setup_step_unpack_bundle_body'
  | 'worker_setup_step_configure_worker_title'
  | 'worker_setup_step_configure_worker_body'
  | 'worker_setup_step_start_worker_title'
  | 'worker_setup_step_start_worker_body'
  | 'worker_setup_step_verify_title'
  | 'worker_setup_step_verify_body'
  | 'worker_setup_step_installer_unavailable_title'
  | 'worker_setup_step_installer_unavailable_body'
  | 'worker_setup_step_planned_title'
  | 'worker_setup_step_planned_body'
  | 'worker_setup_step_isolated_unavailable_title'
  | 'worker_setup_step_isolated_unavailable_body'
  | 'worker_setup_step_docker_prereq_title'
  | 'worker_setup_step_docker_prereq_body'
  | 'worker_setup_step_docker_build_title'
  | 'worker_setup_step_docker_build_body'
  | 'worker_setup_step_docker_install_title'
  | 'worker_setup_step_docker_install_body'
  | 'worker_setup_step_docker_runtime_title'
  | 'worker_setup_step_docker_runtime_body'
  | 'worker_setup_back'
  | 'worker_setup_next'
  // Sharing
  | 'share_btn'
  | 'share_tab_my'
  | 'share_tab_shared_with_me'
  | 'share_tab_community'
  | 'share_badge_title'
  | 'share_swm_title'
  | 'share_swm_empty'
  | 'share_swm_hint'
  | 'share_login_required'
  | 'share_community_title'
  | 'share_community_hint'
  | 'share_community_empty'
  | 'share_modal_title'
  | 'share_mode_label'
  | 'share_mode_off'
  | 'share_mode_public'
  | 'share_mode_public_desc'
  | 'share_mode_users'
  | 'share_mode_users_desc'
  | 'share_expires_label'
  | 'share_expires_none'
  | 'share_expires_until'
  | 'share_recipients_label'
  | 'share_recipients_empty'
  | 'share_add_user_label'
  | 'share_add_user_placeholder'
  | 'share_add_btn'
  | 'share_lookup_ok'
  | 'share_lookup_not_found'
  | 'share_stop_confirm'
  | 'share_stop_btn'
  | 'share_started_public'
  | 'share_started_users'
  | 'share_stopped'
  | 'share_user_added'
  | 'share_user_removed'
  | 'share_shared_by'
  | 'share_public_badge'
  | 'share_notification'
  | 'share_err_username_required'
  | 'share_err_username_too_long'
  | 'share_err_duplicate'
  | 'share_err_forbidden'
  | 'share_err_already_active'
  | 'share_err_no_users_policy'
  | 'share_err_unknown_user'
  | 'share_err_self_grant'
  | 'share_err_expiry_past'
  | 'share_err_invalid_users'
  | 'share_err_invalid_scope'
  | 'share_err_unavailable'
  // Worker counts
  | 'worker_counts_fmt'
  | 'worker_counts_my_private'
  // Worker status keys (returned by setupStatusKey/statusKey)
  | 'worker_status_online'
  | 'worker_status_offline'
  | 'worker_status_revoked'
  | 'worker_status_connecting'
  | 'worker_status_error'
  | 'worker_status_installing'
  | 'worker_status_not_configured'
  // Worker setup create body
  | 'worker_setup_create_body'
  // Common
  | 'layer_audio'
  | 'layer_image'
  | 'layer_video'
  | 'play_loading'
  | 'dialog_cancel'
  | 'dialog_ok';

export type WorkerT = (key: WorkerI18nKey, fallback?: string) => string;
export type WorkerTf = (key: WorkerI18nKey, ...params: unknown[]) => string;

// ── i18n port ──────────────────────────────────────────────────────────────

export interface WorkerI18nPort {
  t: WorkerT;
  tf: WorkerTf;
}

// ── Icon component types ────────────────────────────────────────────────────

export type WorkerIconProps = JSX.SVGAttributes<SVGSVGElement>;
export type WorkerIconComponent = (props: WorkerIconProps) => JSX.Element;

// ── Icons port ─────────────────────────────────────────────────────────────

export interface WorkerIconsPort {
  Add: WorkerIconComponent;
  Reset: WorkerIconComponent;
}

// ── Modal component type ────────────────────────────────────────────────────

export interface WorkerModalProps {
  title?: string;
  onClose: () => void;
  footer?: JSX.Element | JSX.Element[];
  children: JSX.Element | JSX.Element[];
}

// ── UI port ────────────────────────────────────────────────────────────────

export interface WorkerUiPort {
  Modal: (props: WorkerModalProps) => JSX.Element;
  toast: (message: string, duration?: number) => void;
}

// ── Auth port ──────────────────────────────────────────────────────────────

export interface WorkerAuthPort {
  isAuthenticated: () => boolean;
}

// ── Ports ──────────────────────────────────────────────────────────────────

/** The complete host contract consumed by the Worker modules. */
export interface WorkerPorts {
  api: WorkerApiPort;
  i18n: WorkerI18nPort;
  ui: WorkerUiPort;
  auth: WorkerAuthPort;
  icons: WorkerIconsPort;
}

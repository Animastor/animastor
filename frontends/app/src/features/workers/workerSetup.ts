// ─────────────────────────────────────────────────────────────────────────
// Private Worker Setup Center (Phase 3.1) — Setup Contract client + helpers
// ─────────────────────────────────────────────────────────────────────────
// Consumes the unified backend contract (/api/v1/private-worker/setup/*)
// that Web and Android share. Pure logic only (no DOM) so it is fully
// unit-testable; the section component stays thin.
//
// SECURITY INVARIANTS (Phase 3.1 §14/§21):
//  - The Worker Key is a ONE-TIME disclosure from POST /workers. It lives
//    only in transient component state while the disclosure is open.
//  - This module NEVER persists the key (no localStorage/sessionStorage/
//    IndexedDB/URL) and NEVER puts it into a request URL — the Setup
//    Contract itself never carries a key (backend placeholder only).
//  - Nothing here logs the key; analytics receive no worker material.

import { getJson, postJson } from '../../api/client';

// ── Contract DTOs (1:1 with backend/src/installer/setup-contract.js) ────────

export type SetupPlatform = 'linux' | 'windows' | 'docker';
export type SetupInstallMode = 'managed' | 'existing' | 'shared' | 'isolated';
export type SetupWorkerStatus =
  | 'NOT_CONFIGURED' | 'INSTALLING' | 'CONNECTING'
  | 'ONLINE' | 'OFFLINE' | 'ERROR' | 'REVOKED';

export interface SetupArtifactInfo {
  available: boolean;
  status: 'available' | 'draft' | 'planned' | 'unavailable';
  version: string | null;
  download_url: string | null;
  sha256: string | null;
  files?: string[];
  signature?: string | null;
  signature_algorithm?: string | null;
}

export interface SetupProfile {
  id: string;
  name: string;
  description: string;
  worker_type: 'audio' | 'image' | 'video';
  status: 'draft' | 'stable' | 'planned';
  supported_install_modes: SetupInstallMode[];
  gpu: { min_vram_gb: number | null; reference_gpu?: string | null };
  disk_budget_bytes_approx: number;
  workflows: string[];
  dependencies_summary: { custom_nodes: number; models: number; approx_bytes: number };
}

export interface SetupMethod {
  platform: SetupPlatform;
  architectures: string[];
  status: 'available' | 'unavailable' | 'planned';
  installer: SetupArtifactInfo;
  uninstaller: SetupArtifactInfo;
  worker_bundle: SetupArtifactInfo;
  supported_profiles: string[];
  minimum_requirements: { node: string | null; python: string | null; gpu: string | null } | null;
}

export interface SetupWorkflow {
  id: string;
  name: string;
  profile_id: string;
  revision: string | null;
  baseline_available: boolean;
  download_url: string | null;
  sha256: string | null;
  editable: boolean;
}

export interface SetupInstructionStep {
  id: string;
  title: string;
  body: string;
  code?: string | null;
  checksum?: { algorithm: string; value: string } | null;
  requirements?: Record<string, string> | null;
}

export interface SetupInstructions {
  platform: SetupPlatform;
  mode: SetupInstallMode;
  profile_ids: string[];
  steps: SetupInstructionStep[];
  env: { required: string[]; template_block: string };
  worker_key_policy: { disclosed_once: boolean; disclosed_by: string[] };
}

export interface SetupWorkerDetail {
  worker_id: string;
  name: string;
  worker_type: 'audio' | 'image' | 'video';
  status: SetupWorkerStatus;
  base_status: 'ONLINE' | 'OFFLINE' | 'REVOKED';
  status_model: SetupWorkerStatus[];
  last_seen: number | null;
  capabilities: {
    profiles?: string[];
    workflows?: string[];
    gpu?: { name: string | null; vram_gb: number | null };
  } | null;
  details: unknown | null;
}

// ── API calls ───────────────────────────────────────────────────────────────

const BASE = '/private-worker/setup';

export function fetchSetupProfiles(): Promise<{ profiles: SetupProfile[] }> {
  return getJson<{ profiles: SetupProfile[] }>(`${BASE}/profiles`);
}

export function fetchSetupMethods(): Promise<{ methods: SetupMethod[] }> {
  return getJson<{ methods: SetupMethod[] }>(`${BASE}/methods`);
}

export function fetchSetupWorkflows(profileId: string): Promise<{ workflows: SetupWorkflow[] }> {
  return getJson<{ workflows: SetupWorkflow[] }>(`${BASE}/workflows?profile_id=${encodeURIComponent(profileId)}`);
}

export function fetchSetupInstructions(profileId: string, platform: SetupPlatform, mode: SetupInstallMode): Promise<SetupInstructions> {
  const q = `profile_id=${encodeURIComponent(profileId)}&platform=${platform}&mode=${mode}`;
  return getJson<SetupInstructions>(`${BASE}/instructions?${q}`);
}

export function fetchSetupWorkerStatus(workerId: string): Promise<{ worker: SetupWorkerDetail }> {
  return getJson<{ worker: SetupWorkerDetail }>(`${BASE}/workers/${encodeURIComponent(workerId)}`);
}

export interface SetupPlanResponse {
  result: 'READY' | 'READY_WITH_WARNINGS' | 'BLOCKED';
  platform: SetupPlatform;
  mode: SetupInstallMode;
  profiles: string[];
  actions: { type: string; component: string; name: string; conditional: boolean }[];
  warnings: { code: string; message: string }[];
  blocks: { code: string; message: string }[];
  sharing: { verdict: string } | null;
}

export function postSetupPlan(profileIds: string[], mode: SetupInstallMode, platform: SetupPlatform): Promise<SetupPlanResponse> {
  return postJson<SetupPlanResponse>(`${BASE}/plan`, { profile_ids: profileIds, mode, platform });
}

// ── Pure helpers (unit-tested in workerSetup.test.ts) ───────────────────────

/** Origin-relative artifact URL ('/gpu/installer') → absolute download URL.
 *  Returns null for null/empty input (unavailable artifact ⇒ no fake link). */
export function resolveArtifactUrl(downloadUrl: string | null, origin?: string): string | null {
  if (!downloadUrl) return null;
  if (/^https?:\/\//i.test(downloadUrl)) return downloadUrl;
  const base = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  if (!base) return downloadUrl;
  return `${base.replace(/\/$/, '')}${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`;
}

/** Group profiles for the Setup Center cards: one card per worker type,
 *  first profile of the type is the recommended one (manifest order). */
export function groupProfilesByType(profiles: SetupProfile[]): {
  worker_type: 'image' | 'video' | 'audio';
  recommended: SetupProfile;
  alternatives: SetupProfile[];
}[] {
  const order: ('image' | 'video' | 'audio')[] = ['image', 'video', 'audio'];
  return order
    .map((wt) => {
      const of = profiles.filter((p) => p.worker_type === wt);
      if (of.length === 0) return null;
      return { worker_type: wt, recommended: of[0], alternatives: of.slice(1) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export interface PlatformOption {
  platform: SetupPlatform;
  /** true only when the platform's installer artifact is actually available. */
  selectable: boolean;
  /** i18n state key: installer available / coming soon / temporarily unavailable. */
  stateKey: 'worker_setup_platform_ready' | 'worker_setup_platform_soon' | 'worker_setup_platform_unavailable';
  installerVersion: string | null;
}

/** Map installation methods to UI platform options. Unavailable platforms
 *  are NEVER presented as actionable (Phase 3.1 §11). */
export function platformOptions(methods: SetupMethod[]): PlatformOption[] {
  const order: SetupPlatform[] = ['linux', 'windows', 'docker'];
  return order.map((platform) => {
    const m = methods.find((x) => x.platform === platform);
    if (!m || m.status === 'planned') {
      return { platform, selectable: false, stateKey: 'worker_setup_platform_soon' as const, installerVersion: null };
    }
    if (m.installer.available) {
      return { platform, selectable: true, stateKey: 'worker_setup_platform_ready' as const, installerVersion: m.installer.version };
    }
    return { platform, selectable: false, stateKey: 'worker_setup_platform_unavailable' as const, installerVersion: m.installer.version };
  });
}

export function pickMethod(methods: SetupMethod[], platform: SetupPlatform): SetupMethod | null {
  return methods.find((m) => m.platform === platform) ?? null;
}

/** Extended status model → i18n key (legacy statuses keep their keys). */
export function setupStatusKey(status: SetupWorkerStatus | string):
  'worker_status_online' | 'worker_status_offline' | 'worker_status_revoked'
  | 'worker_status_connecting' | 'worker_status_error' | 'worker_status_installing'
  | 'worker_status_not_configured' {
  switch (status) {
    case 'ONLINE': return 'worker_status_online';
    case 'REVOKED': return 'worker_status_revoked';
    case 'CONNECTING': return 'worker_status_connecting';
    case 'ERROR': return 'worker_status_error';
    case 'INSTALLING': return 'worker_status_installing';
    case 'NOT_CONFIGURED': return 'worker_status_not_configured';
    default: return 'worker_status_offline';
  }
}

/** CSS class suffix for the extended status pill. */
export function setupStatusClass(status: SetupWorkerStatus | string): string {
  switch (status) {
    case 'ONLINE': return 'worker__status--online';
    case 'REVOKED': return 'worker__status--revoked';
    case 'CONNECTING': return 'worker__status--connecting';
    case 'ERROR': return 'worker__status--error';
    case 'INSTALLING': return 'worker__status--connecting';
    default: return 'worker__status--offline';
  }
}

// ── Wizard state machine (pure) ─────────────────────────────────────────────

export type WizardStep = 'profile' | 'mode' | 'platform' | 'create' | 'install';

export interface WizardState {
  step: WizardStep;
  profileId: string | null;
  mode: 'managed' | 'existing' | null;
  platform: SetupPlatform | null;
}

export function initialWizardState(): WizardState {
  return { step: 'profile', profileId: null, mode: null, platform: null };
}

const STEP_ORDER: WizardStep[] = ['profile', 'mode', 'platform', 'create', 'install'];

export function canGoNext(state: WizardState, ctx: { installerSelectable: boolean; nameValid: boolean }): boolean {
  switch (state.step) {
    case 'profile': return state.profileId !== null;
    case 'mode': return state.mode !== null;
    case 'platform': return state.platform !== null && ctx.installerSelectable;
    case 'create': return ctx.nameValid;
    default: return false;
  }
}

export function nextStep(state: WizardState): WizardStep | null {
  const i = STEP_ORDER.indexOf(state.step);
  return i >= 0 && i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1] : null;
}

export function prevStep(state: WizardState): WizardStep | null {
  const i = STEP_ORDER.indexOf(state.step);
  return i > 0 ? STEP_ORDER[i - 1] : null;
}

/** Instruction step id → localized title/body i18n keys. Unknown ids fall
 *  back to the API-provided text (future-proof). Commands/checksums are
 *  ALWAYS rendered verbatim from the API — never hardcoded in the UI. */
export function stepTitleKey(id: string): string | null {
  const map: Record<string, string> = {
    'create-worker': 'worker_setup_step_create_worker_title',
    'prerequisites': 'worker_setup_step_prereq_title',
    'download-installer': 'worker_setup_step_download_title',
    'run-installer': 'worker_setup_step_run_title',
    'verify': 'worker_setup_step_verify_title',
    'platform-planned': 'worker_setup_step_planned_title',
  };
  return map[id] ?? null;
}

export function stepBodyKey(id: string): string | null {
  const map: Record<string, string> = {
    'create-worker': 'worker_setup_step_create_worker_body',
    'prerequisites': 'worker_setup_step_prereq_body',
    'download-installer': 'worker_setup_step_download_body',
    'run-installer': 'worker_setup_step_run_body',
    'verify': 'worker_setup_step_verify_body',
    'platform-planned': 'worker_setup_step_planned_body',
  };
  return map[id] ?? null;
}

/** Human-friendly disk budget (bytes → GB, one decimal). */
export function formatDiskBudget(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

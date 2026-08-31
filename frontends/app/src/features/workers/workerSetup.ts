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
/** OS platforms in the capability model (docker is a DEPLOYMENT, not an OS). */
export type SetupOSPlatform = 'linux' | 'windows';
export type SetupDeployment = 'native' | 'docker';
export type SetupAvailability = 'stable' | 'preview' | 'experimental';
export type SetupInstallMode = 'managed' | 'existing' | 'shared' | 'isolated';
export type SetupWorkerStatus =
  | 'NOT_CONFIGURED' | 'INSTALLING' | 'CONNECTING'
  | 'ONLINE' | 'OFFLINE' | 'ERROR' | 'REVOKED';

/**
 * The single backend capability model (GET /setup/methods → capabilities):
 * every Platform × Deployment combination with its honest availability.
 * Web and Android render the SAME source of truth — no local availability
 * tables, no `if (platform === 'windows')` scattered across components.
 */
export interface DeploymentCapability {
  platform: SetupOSPlatform;
  deployment: SetupDeployment;
  availability: SetupAvailability | null;
  allowed: boolean;
  reason: string | null;
  notice: string | null;
}

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
  checksum?: { algorithm: string; value: string; verify_code?: string | null } | null;
  requirements?: Record<string, string> | null;
}

/** Installer artifact metadata for the install step UI (bootstrap flow):
 *  version is the primary UX line; the sha256 belongs in a collapsed
 *  block (shown once). download_url is the profile-embedded bootstrap
 *  script (managed/existing) or the installer bundle (isolated). */
export interface SetupInstallerInfo {
  version: string | null;
  sha256: string | null;
  status: string;
  download_url: string | null;
}

export interface SetupInstructions {
  platform: SetupOSPlatform;
  /** native | docker (docker is a deployment of linux). */
  deployment?: SetupDeployment;
  /** Honest availability of the selected combination (informational). */
  availability?: SetupAvailability | null;
  /** Backend notice for non-stable combinations (rendered verbatim). */
  notice?: string | null;
  mode: SetupInstallMode;
  profile_ids: string[];
  steps: SetupInstructionStep[];
  env: { required: string[]; template_block: string };
  worker_key_policy: { disclosed_once: boolean; disclosed_by: string[] };
  /** Bootstrap installer metadata — null when the installer is unavailable. */
  installer?: SetupInstallerInfo | null;
  /** Optional terminal diagnostics (e.g. $HOME/animastor/tools/status.sh).
   *  Never a required step: the page itself shows the worker status. */
  verify_command?: string | null;
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

export function fetchSetupMethods(): Promise<SetupMethodsResponse> {
  return getJson<SetupMethodsResponse>(`${BASE}/methods`);
}

/** GET /setup/methods response envelope: artifact metadata + the shared
 *  Platform × Deployment × Availability capability model. */
export interface SetupMethodsResponse {
  methods: SetupMethod[];
  capabilities?: DeploymentCapability[];
}

export function fetchSetupWorkflows(profileId: string): Promise<{ workflows: SetupWorkflow[] }> {
  return getJson<{ workflows: SetupWorkflow[] }>(`${BASE}/workflows?profile_id=${encodeURIComponent(profileId)}`);
}

export function fetchSetupInstructions(
  profileId: string,
  platform: SetupPlatform,
  mode: SetupInstallMode,
  deployment: SetupDeployment = 'native',
): Promise<SetupInstructions> {
  const q = `profile_id=${encodeURIComponent(profileId)}&platform=${platform}&deployment=${deployment}&mode=${mode}`;
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

export function postSetupPlan(
  profileIds: string[],
  mode: SetupInstallMode,
  platform: SetupPlatform,
  deployment: SetupDeployment = 'native',
): Promise<SetupPlanResponse> {
  return postJson<SetupPlanResponse>(`${BASE}/plan`, { profile_ids: profileIds, mode, platform, deployment });
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

/** Primary installer download for the install step. The Setup Contract
 *  instructions carry the profile-embedded bootstrap script URL (managed/
 *  existing) or the installer bundle (isolated) — it always wins over the
 *  generic method artifact, which is a fallback for the loading state. */
export function installerDownloadUrl(instructions: SetupInstructions | null, method: SetupMethod | null): string | null {
  const fromInstructions = instructions?.installer?.download_url ?? null;
  if (fromInstructions) return fromInstructions;
  return method?.installer?.download_url ?? null;
}

/** Installer version shown prominently in the install step (same precedence
 *  as [installerDownloadUrl]). */
export function installerVersion(instructions: SetupInstructions | null, method: SetupMethod | null): string | null {
  return instructions?.installer?.version ?? method?.installer?.version ?? null;
}

/** Installer SHA-256 — rendered in a collapsed block, shown once
 *  (same precedence as [installerDownloadUrl]). */
export function installerSha256(instructions: SetupInstructions | null, method: SetupMethod | null): string | null {
  return instructions?.installer?.sha256 ?? method?.installer?.sha256 ?? null;
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
  /** true only when the platform can actually serve the selected mode. */
  selectable: boolean;
  /** i18n state key: installer available / existing-only / coming soon /
   *  installer down / temporarily unavailable. */
  stateKey:
  | 'worker_setup_platform_ready'
  | 'worker_setup_platform_existing_only'
  | 'worker_setup_platform_no_installer'
  | 'worker_setup_platform_soon'
  | 'worker_setup_platform_unavailable';
  installerVersion: string | null;
}

/** Can this method serve the given install mode? Managed needs the installer;
 *  Existing ComfyUI needs the installer OR the worker runtime bundle — one
 *  missing artifact must never block the whole platform (Phase 3.1 §3). */
export function platformSelectable(method: SetupMethod | null, mode: 'managed' | 'existing' | null): boolean {
  if (!method || method.status === 'planned') return false;
  if (method.installer.available) return true;
  return mode === 'existing' && method.worker_bundle.available;
}

/** Map installation methods to UI platform options for the SELECTED mode.
 *  Unavailable platforms are NEVER presented as actionable (Phase 3.1 §11). */
export function platformOptions(methods: SetupMethod[], mode: 'managed' | 'existing' | null = null): PlatformOption[] {
  const order: SetupPlatform[] = ['linux', 'windows', 'docker'];
  return order.map((platform) => {
    const m = methods.find((x) => x.platform === platform);
    if (!m || m.status === 'planned') {
      return { platform, selectable: false, stateKey: 'worker_setup_platform_soon' as const, installerVersion: null };
    }
    if (m.installer.available) {
      return { platform, selectable: true, stateKey: 'worker_setup_platform_ready' as const, installerVersion: m.installer.version };
    }
    if (m.worker_bundle.available) {
      return mode === 'existing'
        ? { platform, selectable: true, stateKey: 'worker_setup_platform_existing_only' as const, installerVersion: null }
        : { platform, selectable: false, stateKey: 'worker_setup_platform_no_installer' as const, installerVersion: null };
    }
    return { platform, selectable: false, stateKey: 'worker_setup_platform_unavailable' as const, installerVersion: m.installer.version };
  });
}

/** Per-mode availability on the real (linux) platform — used to gate the mode
 *  step so the wizard never offers a mode that cannot continue. */
export function linuxModeAvailability(methods: SetupMethod[]): { managed: boolean; existing: boolean } {
  const linux = methods.find((m) => m.platform === 'linux');
  if (!linux || linux.status === 'planned') return { managed: false, existing: false };
  return {
    managed: linux.installer.available,
    existing: linux.installer.available || linux.worker_bundle.available,
  };
}

// ── Deployment options (the capability model, rendered) ─────────────────────

export type DeploymentKey = 'linux-native' | 'windows-native' | 'linux-docker';

/** One selectable "Platform · Deployment" choice in the wizard. */
export interface DeploymentOption {
  key: DeploymentKey;
  platform: SetupOSPlatform;
  deployment: SetupDeployment;
  /** Platform × Deployment label, e.g. "Linux · Native". */
  label: string;
  availability: SetupAvailability;
  availabilityKey: 'worker_setup_availability_stable' | 'worker_setup_availability_preview' | 'worker_setup_availability_experimental';
  /** true only when the combination can actually serve the selected mode. */
  selectable: boolean;
  /** i18n state key (same model as [PlatformOption.stateKey]). */
  stateKey:
  | 'worker_setup_platform_ready'
  | 'worker_setup_platform_existing_only'
  | 'worker_setup_platform_no_installer'
  | 'worker_setup_platform_soon'
  | 'worker_setup_platform_unavailable';
  installerVersion: string | null;
  /** Backend notice for non-stable levels — informational, never blocking. */
  notice: string | null;
}

const AVAILABILITY_KEYS = {
  stable: 'worker_setup_availability_stable',
  preview: 'worker_setup_availability_preview',
  experimental: 'worker_setup_availability_experimental',
} as const;

/** Artifact availability of one OS platform for the given mode (same rules
 *  as [platformSelectable]). */
function osSelectable(methods: SetupMethod[], platform: SetupOSPlatform, mode: 'managed' | 'existing' | null): boolean {
  const m = methods.find((x) => x.platform === platform);
  if (!m || m.status === 'planned') return false;
  if (m.installer.available) return true;
  return mode === 'existing' && m.worker_bundle.available;
}

function artifactStateKey(
  methods: SetupMethod[], platform: SetupOSPlatform, mode: 'managed' | 'existing' | null,
): { stateKey: DeploymentOption['stateKey']; installerVersion: string | null } {
  const m = methods.find((x) => x.platform === platform);
  if (!m || m.status === 'planned') return { stateKey: 'worker_setup_platform_soon', installerVersion: null };
  if (m.installer.available) return { stateKey: 'worker_setup_platform_ready', installerVersion: m.installer.version };
  if (m.worker_bundle.available) {
    return mode === 'existing'
      ? { stateKey: 'worker_setup_platform_existing_only', installerVersion: null }
      : { stateKey: 'worker_setup_platform_no_installer', installerVersion: null };
  }
  return { stateKey: 'worker_setup_platform_unavailable', installerVersion: m.installer.version };
}

/**
 * Map the backend capability model to wizard choices. The docker deployment
 * deploys linux (its artifacts ARE the linux artifacts); it stays a managed-
 * mode path (the container installs the full stack itself). Unallowed
 * combinations (windows+docker) are never rendered. If the backend response
 * carries no capabilities (older backend), the honest fallback mirrors the
 * legacy platform options — never a locally invented availability table.
 */
export function deploymentOptions(
  methods: SetupMethod[],
  capabilities: DeploymentCapability[] | null | undefined,
  mode: 'managed' | 'existing' | null = null,
): DeploymentOption[] {
  const LABELS: Record<DeploymentKey, string> = {
    'linux-native': 'Linux · Native',
    'windows-native': 'Windows · Native',
    'linux-docker': 'Linux · Docker',
  };
  const caps = (capabilities && capabilities.length > 0)
    ? capabilities
    : [
      { platform: 'linux', deployment: 'native', availability: 'stable', allowed: true, reason: null, notice: null },
      { platform: 'windows', deployment: 'native', availability: 'preview', allowed: true, reason: null, notice: null },
      { platform: 'linux', deployment: 'docker', availability: 'experimental', allowed: true, reason: null, notice: null },
    ] as DeploymentCapability[];
  const order: DeploymentKey[] = ['linux-native', 'windows-native', 'linux-docker'];
  return order
    .map((key) => {
      const [platform, deployment] = key.split('-') as [SetupOSPlatform, SetupDeployment];
      const cap = caps.find((c) => c.platform === platform && c.deployment === deployment);
      if (!cap || !cap.allowed || !cap.availability) return null;
      const artifactPlatform: SetupOSPlatform = 'linux'; // docker deploys linux
      const selectable = deployment === 'docker'
        ? mode === 'managed' && osSelectable(methods, artifactPlatform, 'managed')
        : osSelectable(methods, platform, mode);
      const { stateKey, installerVersion } = artifactStateKey(
        methods, deployment === 'docker' ? 'linux' : platform, mode,
      );
      return {
        key,
        platform,
        deployment,
        label: LABELS[key],
        availability: cap.availability,
        availabilityKey: AVAILABILITY_KEYS[cap.availability],
        selectable,
        stateKey,
        installerVersion,
        notice: cap.notice,
      } satisfies DeploymentOption;
    })
    .filter((x): x is DeploymentOption => x !== null);
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
  platform: SetupOSPlatform | null;
  deployment: SetupDeployment | null;
}

export function initialWizardState(): WizardState {
  return { step: 'profile', profileId: null, mode: null, platform: null, deployment: null };
}

const STEP_ORDER: WizardStep[] = ['profile', 'mode', 'platform', 'create', 'install'];

export function canGoNext(state: WizardState, ctx: { platformSelectable: boolean; nameValid: boolean }): boolean {
  switch (state.step) {
    case 'profile': return state.profileId !== null;
    case 'mode': return state.mode !== null;
    case 'platform': return state.platform !== null && state.deployment !== null && ctx.platformSelectable;
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
 *  ALWAYS rendered verbatim from the API — never hardcoded in the UI.
 *  The worker is ALWAYS created before instructions are shown (wizard
 *  'create' step) — there is no 'create-worker' instruction step. */
export function stepTitleKey(id: string): string | null {
  const map: Record<string, string> = {
    'prerequisites': 'worker_setup_step_prereq_title',
    'download-bootstrap': 'worker_setup_step_download_bootstrap_title',
    'run-bootstrap': 'worker_setup_step_run_bootstrap_title',
    'download-bundle': 'worker_setup_step_download_bundle_title',
    'unpack-bundle': 'worker_setup_step_unpack_bundle_title',
    'configure-worker': 'worker_setup_step_configure_worker_title',
    'start-worker': 'worker_setup_step_start_worker_title',
    'verify': 'worker_setup_step_verify_title',
    'installer-unavailable': 'worker_setup_step_installer_unavailable_title',
    'platform-planned': 'worker_setup_step_planned_title',
    'isolated-unavailable': 'worker_setup_step_isolated_unavailable_title',
    'docker-prerequisites': 'worker_setup_step_docker_prereq_title',
    'docker-build': 'worker_setup_step_docker_build_title',
    'docker-install': 'worker_setup_step_docker_install_title',
    'docker-runtime': 'worker_setup_step_docker_runtime_title',
  };
  return map[id] ?? null;
}

export function stepBodyKey(id: string): string | null {
  const map: Record<string, string> = {
    'prerequisites': 'worker_setup_step_prereq_body',
    'download-bootstrap': 'worker_setup_step_download_bootstrap_body',
    'run-bootstrap': 'worker_setup_step_run_bootstrap_body',
    'download-bundle': 'worker_setup_step_download_bundle_body',
    'unpack-bundle': 'worker_setup_step_unpack_bundle_body',
    'configure-worker': 'worker_setup_step_configure_worker_body',
    'start-worker': 'worker_setup_step_start_worker_body',
    'verify': 'worker_setup_step_verify_body',
    'installer-unavailable': 'worker_setup_step_installer_unavailable_body',
    'platform-planned': 'worker_setup_step_planned_body',
    'isolated-unavailable': 'worker_setup_step_isolated_unavailable_body',
    'docker-prerequisites': 'worker_setup_step_docker_prereq_body',
    'docker-build': 'worker_setup_step_docker_build_body',
    'docker-install': 'worker_setup_step_docker_install_body',
    'docker-runtime': 'worker_setup_step_docker_runtime_body',
  };
  return map[id] ?? null;
}

/** Human-friendly disk budget (bytes → GB, one decimal). */
export function formatDiskBudget(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

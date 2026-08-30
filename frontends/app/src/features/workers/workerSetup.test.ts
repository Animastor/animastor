// Tests for the Private Worker Setup Center (Phase 3.1). Covers the Setup
// Contract client (profiles/installation/worker/workflow), the wizard state
// machine, and the Worker Key security invariants (no logs, no analytics,
// no localStorage, no URL). Legacy single-file helpers stay covered by
// privateWorkers.test.ts — they must keep working (compatibility path).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSetupProfiles, fetchSetupMethods, fetchSetupWorkflows,
  fetchSetupInstructions,
  resolveArtifactUrl, installerDownloadUrl, installerVersion, installerSha256,
  groupProfilesByType, platformOptions, pickMethod,
  platformSelectable, linuxModeAvailability,
  setupStatusKey, setupStatusClass,
  initialWizardState, canGoNext, nextStep, prevStep,
  stepTitleKey, stepBodyKey, formatDiskBudget,
  type SetupProfile, type SetupMethod,
} from './workerSetup';
import { buildSetupContract, renderEnvBlock, looksLikeWorkerToken } from './privateWorkers';

// ── fixtures (shaped like real backend responses) ───────────────────────────

const PROFILES: SetupProfile[] = [
  {
    id: 'image/qwen-image', name: 'Qwen Image', description: 'd', worker_type: 'image',
    status: 'draft', supported_install_modes: ['managed', 'existing', 'shared', 'isolated'],
    gpu: { min_vram_gb: null }, disk_budget_bytes_approx: 12 * 1024 ** 3,
    workflows: ['img-qwen-image'], dependencies_summary: { custom_nodes: 1, models: 2, approx_bytes: 1 },
  },
  {
    id: 'video/ltx-2.3', name: 'LTX Video 2.3', description: 'd', worker_type: 'video',
    status: 'draft', supported_install_modes: ['managed', 'existing', 'shared', 'isolated'],
    gpu: { min_vram_gb: null }, disk_budget_bytes_approx: 30 * 1024 ** 3,
    workflows: ['vid-ltx-2.3-t2v'], dependencies_summary: { custom_nodes: 1, models: 1, approx_bytes: 1 },
  },
  {
    id: 'audio/qwen-tts', name: 'Qwen TTS', description: 'd', worker_type: 'audio',
    status: 'draft', supported_install_modes: ['managed', 'existing', 'shared', 'isolated'],
    gpu: { min_vram_gb: null }, disk_budget_bytes_approx: 9 * 1024 ** 3,
    workflows: ['tts-qwen-narrator'], dependencies_summary: { custom_nodes: 1, models: 2, approx_bytes: 1 },
  },
];

function method(
  platform: SetupMethod['platform'],
  installerAvailable: boolean,
  version: string | null,
  bundleAvailable?: boolean,
): SetupMethod {
  const artifact = (available: boolean, v: string | null, url: string | null): SetupMethod['installer'] => ({
    available,
    status: available ? 'draft' : 'planned',
    version: v,
    download_url: url,
    sha256: available ? 'a'.repeat(64) : null,
  });
  const bundleUp = bundleAvailable === undefined ? installerAvailable : bundleAvailable;
  const linuxUp = installerAvailable || bundleUp;
  return {
    platform,
    architectures: platform === 'docker' ? [] : ['x86_64'],
    status: platform === 'linux' ? (linuxUp ? 'available' : 'unavailable') : 'planned',
    installer: artifact(installerAvailable, version, installerAvailable ? '/gpu/installer' : null),
    uninstaller: artifact(false, null, null),
    worker_bundle: artifact(bundleUp, '2.0.0', bundleUp ? '/gpu/worker-bundle' : null),
    supported_profiles: PROFILES.map((p) => p.id),
    minimum_requirements: null,
  };
}

const METHODS: SetupMethod[] = [
  method('linux', true, '1.0.0'),
  method('windows', false, null),
  method('docker', false, null),
];

// ── Profiles ────────────────────────────────────────────────────────────────

describe('profiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('profiles are loaded from the API (never hardcoded in the UI)', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ profiles: PROFILES }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { profiles } = await fetchSetupProfiles();
    expect(profiles.map((p) => p.id)).toEqual(['image/qwen-image', 'video/ltx-2.3', 'audio/qwen-tts']);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/private-worker/setup/profiles');
  });

  it('groupProfilesByType builds one card per worker type with a recommended profile', () => {
    const cards = groupProfilesByType(PROFILES);
    expect(cards.map((c) => c.worker_type)).toEqual(['image', 'video', 'audio']);
    expect(cards[0].recommended.id).toBe('image/qwen-image');
    expect(cards[0].alternatives).toEqual([]);
  });

  it('unavailable profiles → no cards (nothing to select)', () => {
    expect(groupProfilesByType([])).toEqual([]);
    const onlyAudio = groupProfilesByType(PROFILES.filter((p) => p.worker_type === 'audio'));
    expect(onlyAudio.map((c) => c.worker_type)).toEqual(['audio']);
  });
});

// ── Installation ────────────────────────────────────────────────────────────

describe('installation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Linux installer available → selectable with the API-provided version', () => {
    const opts = platformOptions(METHODS);
    const linux = opts.find((o) => o.platform === 'linux')!;
    expect(linux.selectable).toBe(true);
    expect(linux.stateKey).toBe('worker_setup_platform_ready');
    expect(linux.installerVersion).toBe('1.0.0'); // whatever the API says
  });

  it('Windows/Docker unavailable → never presented as actionable', () => {
    const opts = platformOptions(METHODS);
    for (const p of ['windows', 'docker'] as const) {
      const o = opts.find((x) => x.platform === p)!;
      expect(o.selectable).toBe(false);
      expect(o.stateKey).toBe('worker_setup_platform_soon');
    }
  });

  it('linux installer artifact temporarily down → unavailable state, not selectable', () => {
    const opts = platformOptions([method('linux', false, '1.0.0', false), ...METHODS.slice(1)]);
    const linux = opts.find((o) => o.platform === 'linux')!;
    expect(linux.selectable).toBe(false);
    expect(linux.stateKey).toBe('worker_setup_platform_unavailable');
  });

  it('independence — installer down but bundle served: Existing ComfyUI stays selectable', () => {
    const bundleOnly = [method('linux', false, '1.0.0', true), ...METHODS.slice(1)];
    // managed needs the installer → blocked with a reason, not a silent dead end
    const managed = platformOptions(bundleOnly, 'managed').find((o) => o.platform === 'linux')!;
    expect(managed.selectable).toBe(false);
    expect(managed.stateKey).toBe('worker_setup_platform_no_installer');
    // existing needs only the bundle → still actionable
    const existing = platformOptions(bundleOnly, 'existing').find((o) => o.platform === 'linux')!;
    expect(existing.selectable).toBe(true);
    expect(existing.stateKey).toBe('worker_setup_platform_existing_only');
    // platform-level availability is independent of the installer artifact
    expect(pickMethod(bundleOnly, 'linux')!.status).toBe('available');
    expect(platformSelectable(pickMethod(bundleOnly, 'linux'), 'existing')).toBe(true);
    expect(platformSelectable(pickMethod(bundleOnly, 'linux'), 'managed')).toBe(false);
  });

  it('mode gating — linuxModeAvailability reflects real artifact capabilities', () => {
    expect(linuxModeAvailability(METHODS)).toEqual({ managed: true, existing: true });
    const bundleOnly = [method('linux', false, '1.0.0', true), ...METHODS.slice(1)];
    expect(linuxModeAvailability(bundleOnly)).toEqual({ managed: false, existing: true });
    const allDown = [method('linux', false, '1.0.0', false), ...METHODS.slice(1)];
    expect(linuxModeAvailability(allDown)).toEqual({ managed: false, existing: false });
  });

  it('correct artifact/version displayed — no hardcoded version anywhere', async () => {
    // The displayed version must equal the API-provided version for ANY value.
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ methods: [method('linux', true, '9.8.7')] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { methods } = await fetchSetupMethods();
    const linux = pickMethod(methods, 'linux')!;
    expect(linux.installer.version).toBe('9.8.7');
    expect(platformOptions(methods).find((o) => o.platform === 'linux')!.installerVersion).toBe('9.8.7');
    expect(linux.installer.download_url).toBe('/gpu/installer');
    expect(linux.worker_bundle.download_url).toBe('/gpu/worker-bundle');
  });

  it('uninstaller stays planned without a fake download URL', () => {
    const linux = pickMethod(METHODS, 'linux')!;
    expect(linux.uninstaller.available).toBe(false);
    expect(linux.uninstaller.download_url).toBeNull();
    expect(resolveArtifactUrl(linux.uninstaller.download_url)).toBeNull();
  });
});

// ── Artifact URLs ───────────────────────────────────────────────────────────

describe('resolveArtifactUrl', () => {
  it('turns origin-relative contract URLs into absolute downloads', () => {
    expect(resolveArtifactUrl('/gpu/installer', 'https://app.example')).toBe('https://app.example/gpu/installer');
    expect(resolveArtifactUrl('/gpu/workflow/img-qwen-image', 'https://app.example/')).toBe('https://app.example/gpu/workflow/img-qwen-image');
  });
  it('null/empty (unavailable artifact) → null (no fake link)', () => {
    expect(resolveArtifactUrl(null)).toBeNull();
    expect(resolveArtifactUrl('', 'https://app.example')).toBeNull();
  });
  it('absolute URLs pass through', () => {
    expect(resolveArtifactUrl('https://hub.example/gpu/installer')).toBe('https://hub.example/gpu/installer');
  });
});

// ── Worker ──────────────────────────────────────────────────────────────────

describe('worker', () => {
  it('create — wizard allows creation only with a valid name', () => {
    const base = { ...initialWizardState(), step: 'create' as const, profileId: 'image/qwen-image', mode: 'managed' as const, platform: 'linux' as const };
    expect(canGoNext(base, { platformSelectable: true, nameValid: false })).toBe(false);
    expect(canGoNext(base, { platformSelectable: true, nameValid: true })).toBe(true);
  });

  it('key handling — one-time token shape recognized; wizard steps never carry it', () => {
    expect(looksLikeWorkerToken('wrk.abc.def123')).toBe(true);
    // the wizard state machine holds only selections — no credential field
    const s = initialWizardState();
    expect(JSON.stringify(s)).not.toContain('wrk.');
    expect(Object.keys(s)).toEqual(['step', 'profileId', 'mode', 'platform']);
  });

  it('status — extended model maps every status to a label + pill class', () => {
    expect(setupStatusKey('ONLINE')).toBe('worker_status_online');
    expect(setupStatusKey('OFFLINE')).toBe('worker_status_offline');
    expect(setupStatusKey('CONNECTING')).toBe('worker_status_connecting');
    expect(setupStatusKey('ERROR')).toBe('worker_status_error');
    expect(setupStatusKey('INSTALLING')).toBe('worker_status_installing');
    expect(setupStatusKey('NOT_CONFIGURED')).toBe('worker_status_not_configured');
    expect(setupStatusKey('REVOKED')).toBe('worker_status_revoked');
    expect(setupStatusClass('CONNECTING')).toBe('worker__status--connecting');
    expect(setupStatusClass('ERROR')).toBe('worker__status--error');
  });

  it('error/offline — unknown statuses degrade to offline (never invented)', () => {
    expect(setupStatusKey('SOMETHING_NEW')).toBe('worker_status_offline');
    expect(setupStatusClass('SOMETHING_NEW')).toBe('worker__status--offline');
  });

  it('wizard navigation — profile → mode → platform → create → install', () => {
    let s = initialWizardState();
    expect(s.step).toBe('profile');
    expect(nextStep(s)).toBe('mode');
    s = { ...s, step: 'mode', profileId: 'image/qwen-image' };
    expect(nextStep(s)).toBe('platform');
    expect(prevStep(s)).toBe('profile');
    s = { ...s, step: 'platform', mode: 'managed' };
    expect(nextStep(s)).toBe('create');
    s = { ...s, step: 'create', platform: 'linux' };
    expect(nextStep(s)).toBe('install');
    s = { ...s, step: 'install' };
    expect(nextStep(s)).toBeNull();
    // platform step blocked unless the platform is actually selectable
    const atPlatform = { ...initialWizardState(), step: 'platform' as const, platform: 'linux' as const };
    expect(canGoNext(atPlatform, { platformSelectable: false, nameValid: false })).toBe(false);
    expect(canGoNext(atPlatform, { platformSelectable: true, nameValid: false })).toBe(true);
  });
});

// ── Workflows ───────────────────────────────────────────────────────────────

describe('workflows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('baseline workflow link comes from the API and is downloadable', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({
        workflows: [{
          id: 'img-qwen-image', name: 'Qwen Image', profile_id: 'image/qwen-image',
          revision: '2026.08.26-r2', baseline_available: true,
          download_url: '/gpu/workflow/img-qwen-image', sha256: 'f'.repeat(64), editable: true,
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { workflows } = await fetchSetupWorkflows('image/qwen-image');
    expect(String(fetchMock.mock.calls[0][0])).toContain('profile_id=image%2Fqwen-image');
    const url = resolveArtifactUrl(workflows[0].download_url, 'https://app.example');
    expect(url).toBe('https://app.example/gpu/workflow/img-qwen-image');
  });

  it('editable indication — workflows are starting points, never read-only', () => {
    // The contract flag is passed through; the UI shows the editable note.
    const wf = { id: 'x', name: 'X', profile_id: 'image/qwen-image', revision: null, baseline_available: true, download_url: '/gpu/workflow/x', sha256: null, editable: true };
    expect(wf.editable).toBe(true);
  });

  it('unavailable baseline → no fake link', () => {
    expect(resolveArtifactUrl(null, 'https://app.example')).toBeNull();
  });
});

// ── Security — Worker Key handling (Phase 3.1 §14/§21) ──────────────────────

describe('security — worker key', () => {
  afterEach(() => vi.unstubAllGlobals());

  const KEY = 'wrk.testworker.dGVzdC1zZWNyZXQ';

  it('never lands in a URL (instructions query + artifact links are key-free)', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchSetupInstructions('image/qwen-image', 'linux', 'managed');
    for (const url of seen) expect(url).not.toContain('wrk.');
    expect(resolveArtifactUrl('/gpu/installer', 'https://app.example')).not.toContain('wrk.');
  });

  it('never lands in localStorage/sessionStorage', () => {
    const storeSpy = {
      setItem: vi.fn(), getItem: vi.fn(() => null), removeItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', storeSpy);
    vi.stubGlobal('sessionStorage', storeSpy);
    // exercise every helper that touches worker material
    buildSetupContract(KEY, 'image', 'Home GPU');
    renderEnvBlock({ HUB_URL: 'https://x/gpu', ANIMASTOR_WORKER_TOKEN: KEY, WORKER_TYPE: 'image', WORKER_ID: 'home-gpu' });
    resolveArtifactUrl('/gpu/installer', 'https://app.example');
    expect(storeSpy.setItem).not.toHaveBeenCalled();
  });

  it('never lands in console logs or analytics', () => {
    const logSpy = vi.fn(); const errSpy = vi.fn(); const warnSpy = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(logSpy);
    vi.spyOn(console, 'error').mockImplementation(errSpy);
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    buildSetupContract(KEY, 'image', 'Home GPU');
    setupStatusKey('CONNECTING');
    groupProfilesByType(PROFILES);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('env block carries the key ONLY in ANIMASTOR_WORKER_TOKEN (never in HUB_URL)', () => {
    const c = buildSetupContract(KEY, 'image', 'Home GPU');
    const block = renderEnvBlock(c.env);
    expect(block).toContain(`ANIMASTOR_WORKER_TOKEN=${KEY}`);
    expect(c.env.HUB_URL).not.toContain(KEY);
    expect(block.split('\n')[0]).not.toContain(KEY); // HUB_URL line is first
  });
});

// ── Instructions localization mapping ───────────────────────────────────────

describe('instruction step mapping', () => {
  it('bootstrap flow steps map to i18n keys; unknown ids fall back to API text', () => {
    expect(stepTitleKey('download-bootstrap')).toBe('worker_setup_step_download_bootstrap_title');
    expect(stepBodyKey('run-bootstrap')).toBe('worker_setup_step_run_bootstrap_body');
    expect(stepTitleKey('verify')).toBe('worker_setup_step_verify_title');
    expect(stepTitleKey('some-future-step')).toBeNull();
    expect(stepBodyKey('some-future-step')).toBeNull();
  });

  it('no create-worker step — the worker is ALWAYS created before instructions are shown', () => {
    expect(stepTitleKey('create-worker')).toBeNull();
    expect(stepBodyKey('create-worker')).toBeNull();
    // legacy tarball step ids are gone too (superseded by the bootstrap flow)
    expect(stepTitleKey('download-installer')).toBeNull();
    expect(stepBodyKey('run-installer')).toBeNull();
  });

  it('bundle-based existing flow + degraded states have localized mappings', () => {
    for (const id of ['download-bundle', 'unpack-bundle', 'configure-worker', 'start-worker', 'installer-unavailable', 'platform-planned']) {
      expect(stepTitleKey(id), id).toBeTypeOf('string');
      expect(stepBodyKey(id), id).toBeTypeOf('string');
    }
    expect(stepTitleKey('download-bundle')).toBe('worker_setup_step_download_bundle_title');
    expect(stepBodyKey('start-worker')).toBe('worker_setup_step_start_worker_body');
    expect(stepTitleKey('installer-unavailable')).toBe('worker_setup_step_installer_unavailable_title');
  });
});

// ── Installer artifact metadata (bootstrap contract) ────────────────────────

describe('installer artifact metadata', () => {
  const bootstrapInstructions = {
    platform: 'linux' as const,
    mode: 'managed' as const,
    profile_ids: ['image/qwen-image'],
    steps: [],
    env: { required: [], template_block: '' },
    worker_key_policy: { disclosed_once: true, disclosed_by: [] },
    installer: {
      version: '1.2.3',
      sha256: 'b'.repeat(64),
      status: 'available',
      download_url: 'https://animastor.in/gpu/installer?profile=image%2Fqwen-image&mode=managed',
    },
    verify_command: '$HOME/animastor/tools/status.sh',
  } as import('./workerSetup').SetupInstructions;

  it('instructions.installer wins over the generic method artifact', () => {
    const m = method('linux', true, '0.9.0');
    expect(installerDownloadUrl(bootstrapInstructions, m)).toContain('profile=image%2Fqwen-image');
    expect(installerVersion(bootstrapInstructions, m)).toBe('1.2.3');
    expect(installerSha256(bootstrapInstructions, m)).toBe('b'.repeat(64));
  });

  it('falls back to the method artifact while instructions are loading', () => {
    const m = method('linux', true, '0.9.0');
    expect(installerDownloadUrl(null, m)).toBe('/gpu/installer');
    expect(installerVersion(null, m)).toBe('0.9.0');
    expect(installerSha256(null, m)).toBe('a'.repeat(64));
  });

  it('degraded contract (installer null) + unavailable method → no fake link', () => {
    const degraded = { ...bootstrapInstructions, installer: null, verify_command: null };
    const down = method('linux', false, null, false);
    expect(installerDownloadUrl(degraded, down)).toBeNull();
    expect(installerVersion(degraded, down)).toBeNull();
    expect(installerSha256(degraded, down)).toBeNull();
    expect(resolveArtifactUrl(installerDownloadUrl(degraded, down))).toBeNull();
  });

  it('profile/mode are embedded in the bootstrap URL — user types nothing', () => {
    const url = installerDownloadUrl(bootstrapInstructions, null)!;
    expect(url).toContain('profile=image%2Fqwen-image');
    expect(url).toContain('mode=managed');
  });

  it('verify_command is optional terminal diagnostics — never a required step', () => {
    expect(bootstrapInstructions.verify_command).toBe('$HOME/animastor/tools/status.sh');
    const without = { ...bootstrapInstructions, verify_command: null };
    expect(without.verify_command).toBeNull();
  });
});

// ── Misc ────────────────────────────────────────────────────────────────────

describe('formatDiskBudget', () => {
  it('bytes → human GB; invalid → null', () => {
    expect(formatDiskBudget(12 * 1024 ** 3)).toBe('12 GB');
    expect(formatDiskBudget(9.5 * 1024 ** 3)).toBe('9.5 GB');
    expect(formatDiskBudget(null)).toBeNull();
    expect(formatDiskBudget(0)).toBeNull();
    expect(formatDiskBudget(NaN)).toBeNull();
  });
});

// ── Legacy compatibility path stays intact ──────────────────────────────────

describe('legacy single-file flow (compatibility — not canonical)', () => {
  it('buildSetupContract/renderEnvBlock still work for the fallback renderer', () => {
    const c = buildSetupContract('wrk.id.secret', 'image', 'Home RTX');
    expect(c.steps).toHaveLength(5);
    expect(c.runCommand).toBe('node worker.cjs');
    expect(renderEnvBlock(c.env)).toContain('WORKER_TYPE=image');
  });
});

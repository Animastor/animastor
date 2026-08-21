// Tests for the Private Worker Management pure helpers (Experimental Beta
// — Phase 3). Covers create-input validation, the one-time credential
// contract, status derivation/classification, last-seen formatting, and
// the worker setup contract (env var name parity with worker.cjs).
import { describe, expect, it } from 'vitest';
import {
  validateCreateInput,
  looksLikeWorkerToken,
  statusClass,
  statusKey,
  formatLastSeen,
  buildSetupContract,
  renderEnvBlock,
  OFFLINE_TROUBLESHOOT_KEYS,
  VALID_WORKER_TYPES,
} from './privateWorkers';

// ── create-input validation ────────────────────────────────────────────────
describe('validateCreateInput', () => {
  it('accepts a trimmed name and a valid worker type', () => {
    expect(validateCreateInput('  home-rtx  ', 'image')).toEqual({
      ok: true, name: 'home-rtx', worker_type: 'image',
    });
  });
  it('rejects an empty / whitespace-only name', () => {
    expect(validateCreateInput('   ', 'audio').ok).toBe(false);
    expect(validateCreateInput('', 'audio').ok).toBe(false);
  });
  it('rejects a name longer than 120 chars', () => {
    expect(validateCreateInput('x'.repeat(121), 'audio').ok).toBe(false);
    expect(validateCreateInput('x'.repeat(120), 'audio').ok).toBe(true);
  });
  it('rejects an invalid worker type', () => {
    expect(validateCreateInput('ok', 'quantum').ok).toBe(false);
    expect(validateCreateInput('ok', 'UPSACLE').ok).toBe(false);
    expect(VALID_WORKER_TYPES).toEqual(['audio', 'image', 'video']);
  });
});

// ── one-time credential token contract ─────────────────────────────────────
describe('looksLikeWorkerToken', () => {
  it('recognizes a wrk.<id>.<secret> token', () => {
    expect(looksLikeWorkerToken('wrk.abc.def123')).toBe(true);
  });
  it('rejects session/guest/garbage tokens (wrong prefix or shape)', () => {
    expect(looksLikeWorkerToken('sid.abc.def')).toBe(false);
    expect(looksLikeWorkerToken('gst.abc.def')).toBe(false);
    expect(looksLikeWorkerToken('garbage')).toBe(false);
    expect(looksLikeWorkerToken('wrk.abc')).toBe(false);
    expect(looksLikeWorkerToken('wrk.abc.def.extra')).toBe(false);
    expect(looksLikeWorkerToken('')).toBe(false);
    expect(looksLikeWorkerToken('wrk..')).toBe(false);
  });
});

// ── status derivation ──────────────────────────────────────────────────────
describe('status classification', () => {
  it('maps ONLINE/OFFLINE/REVOKED to class + i18n key', () => {
    expect(statusClass('ONLINE')).toBe('worker__status--online');
    expect(statusClass('OFFLINE')).toBe('worker__status--offline');
    expect(statusClass('REVOKED')).toBe('worker__status--revoked');
    expect(statusKey('ONLINE')).toBe('worker_status_online');
    expect(statusKey('OFFLINE')).toBe('worker_status_offline');
    expect(statusKey('REVOKED')).toBe('worker_status_revoked');
  });
});

// ── last-seen formatting ───────────────────────────────────────────────────
describe('formatLastSeen', () => {
  const now = 1_700_000_000_000;
  it('null → em dash', () => {
    expect(formatLastSeen(null, now)).toBe('—');
  });
  it('recent (< 60s) → seconds', () => {
    expect(formatLastSeen(now - 5_000, now)).toBe('5s');
    expect(formatLastSeen(now - 59_000, now)).toBe('59s');
  });
  it('minutes / hours / days', () => {
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('5m');
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatLastSeen(now - 2 * 86_400_000, now)).toBe('2d');
  });
});

// ── worker setup contract — env var parity with worker.cjs ─────────────────
describe('buildSetupContract', () => {
  it('emits EXACTLY the env vars worker.cjs reads', () => {
    const c = buildSetupContract('wrk.id.secret', 'image', 'Home RTX 3090');
    expect(Object.keys(c.env).sort()).toEqual(['ANIMASTOR_WORKER_TOKEN', 'HUB_URL', 'WORKER_ID', 'WORKER_TYPE']);
    expect(c.env.ANIMASTOR_WORKER_TOKEN).toBe('wrk.id.secret');
    expect(c.env.WORKER_TYPE).toBe('image');
    // WORKER_ID is derived from the human label: spaces → dashes, lowercased.
    expect(c.env.WORKER_ID).toBe('home-rtx-3090');
    // Five setup steps in order — the UI must present this exact sequence.
    expect(c.steps).toHaveLength(5);
    expect(c.steps[0]).toBe('worker_setup_step_1');
    expect(c.steps[4]).toBe('worker_setup_step_5');
  });

  it('never embeds the token in the HUB_URL (it goes only in ANIMASTOR_WORKER_TOKEN)', () => {
    const c = buildSetupContract('wrk.id.secret', 'audio', 'w');
    expect(c.env.HUB_URL).not.to.contain('wrk.id.secret');
    expect(c.env.WORKER_ID).not.to.contain('secret');
  });

  it('exposes the worker source + run command for onboarding', () => {
    const c = buildSetupContract('wrk.id.secret', 'image', 'w');
    // Source is served by the GPU Hub itself (repo mirror is private).
    expect(c.sourceUrl).toBe(`${c.env.HUB_URL}/worker-source`);
    expect(c.downloadCommand).toBe(`curl -o worker.cjs ${c.env.HUB_URL}/worker-source`);
    // The real start command matching the worker implementation.
    expect(c.runCommand).toBe('node worker.cjs');
    // Prerequisites are i18n keys, not hardcoded prose.
    expect(c.prereqs).toContain('worker_prereq_node');
    expect(c.prereqs).toContain('worker_prereq_comfy');
    expect(c.prereqs).toContain('worker_prereq_models');
  });
});

// ── copyable env block ─────────────────────────────────────────────────────
describe('renderEnvBlock', () => {
  it('renders EXACTLY the four vars worker.cjs reads, one per line', () => {
    const c = buildSetupContract('wrk.id.secret', 'video', 'My GPU');
    const block = renderEnvBlock(c.env);
    expect(block).toBe([
      `HUB_URL=${c.env.HUB_URL}`,
      'ANIMASTOR_WORKER_TOKEN=wrk.id.secret',
      'WORKER_TYPE=video',
      'WORKER_ID=my-gpu',
    ].join('\n'));
  });
});

// ── offline troubleshooting hints ──────────────────────────────────────────
describe('OFFLINE_TROUBLESHOOT_KEYS', () => {
  it('covers hub url / token / process / network without server internals', () => {
    expect(OFFLINE_TROUBLESHOOT_KEYS).toEqual([
      'worker_trouble_hub_url',
      'worker_trouble_token',
      'worker_trouble_process',
      'worker_trouble_network',
    ]);
  });
});

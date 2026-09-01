// Tests for Worker Sharing V2 (SH-2) frontend feature module: pure helpers
// (mode derivation, expiry conversion/formatting, recipient validation,
// error mapping, state diffing) and the thin API layer against the real
// wire contract (fetch stubbed 1:1 with backend routes). The kill-switch
// probe contract (config → fail CLOSED) is covered too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SharePolicy, type SharedWithMeWorker, type ShareGrant,
  shareModeOf, isPolicyExpired, sharedStatusClass, sharedByLabel,
  normalizeUsername, isDuplicateRecipient,
  epochToDatetimeLocal, datetimeLocalToEpoch, formatExpiry,
  shareErrorKey, diffSharedWorkers, canBeShared,
  fetchShareState, startShare, stopShare, addShareUsers, removeShareUser, lookupUser,
  probeShareFeature, shareFeatureEnabled,
} from './sharing';
import { ApiError } from '../../api/client';

// ── fixtures ────────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;

function policy(over: Partial<SharePolicy> = {}): SharePolicy {
  return {
    policy_id: 'p1', scope_kind: 'public', starts_at: NOW - 1000,
    expires_at: null, revoked_at: null, ...over,
  };
}

function grant(over: Partial<ShareGrant> = {}): ShareGrant {
  return {
    grant_id: 'g1', policy_id: 'p1', user_id: 'u2',
    created_at: NOW - 500, username: 'ivan', display_name: 'Ivan Petrov', ...over,
  };
}

function swm(over: Partial<SharedWithMeWorker> = {}): SharedWithMeWorker {
  return {
    worker_id: 'w1', name: 'Home GPU', worker_type: 'audio', capabilities: null,
    owner_workspace_id: 'ws1', revoked_at: null, last_seen: NOW - 30_000,
    created_at: NOW - 86_400_000, granted_at: NOW - 1000,
    share_policy: { policy_id: 'p1', scope_kind: 'users', starts_at: NOW - 1000, expires_at: null },
    access_reason: { kind: 'shared_by_user', shared_by: 'ivan', shared_by_display_name: 'Ivan Petrov', owner_workspace_name: 'Ivan ws' },
    ...over,
  };
}

// ── mode derivation (owner view: Off / Public / Specific users) ────────────
describe('shareModeOf', () => {
  it('derives off/public/users from the active policy', () => {
    expect(shareModeOf(null)).toBe('off');
    expect(shareModeOf(policy({ scope_kind: 'public' }))).toBe('public');
    expect(shareModeOf(policy({ scope_kind: 'users' }))).toBe('users');
  });
  it('treats a revoked policy as off', () => {
    expect(shareModeOf(policy({ revoked_at: NOW }))).toBe('off');
  });
});

describe('isPolicyExpired', () => {
  it('expired policy is not active (expiry re-check mirrors backend)', () => {
    expect(isPolicyExpired(policy({ expires_at: NOW - 1 }), NOW)).toBe(true);
    expect(isPolicyExpired(policy({ expires_at: NOW + 1 }), NOW)).toBe(false);
    expect(isPolicyExpired(policy({ expires_at: null }), NOW)).toBe(false);
    expect(isPolicyExpired(null)).toBe(false);
  });
});

// ── shared-with-me entry rendering (access reason §14.2) ───────────────────
describe('sharedByLabel + sharedStatusClass', () => {
  it('renders the "Shared by <username>" reason', () => {
    expect(sharedByLabel(swm())).toBe('ivan');
  });
  it('falls back through display name / workspace name', () => {
    expect(sharedByLabel(swm({ access_reason: { kind: 'shared_by_user', shared_by: null, shared_by_display_name: null, owner_workspace_name: 'ws name' } }))).toBe('ws name');
    expect(sharedByLabel(swm({ access_reason: { kind: 'shared_by_user', shared_by: null, shared_by_display_name: null, owner_workspace_name: null } }))).toBe('');
  });
  it('online when last seen is fresh, offline when revoked or expired', () => {
    expect(sharedStatusClass(swm(), NOW)).toBe('online');
    expect(sharedStatusClass(swm({ last_seen: NOW - 10 * 60_000 }), NOW)).toBe('offline');
    expect(sharedStatusClass(swm({ revoked_at: NOW }), NOW)).toBe('offline');
    expect(sharedStatusClass(swm({ share_policy: { policy_id: 'p', scope_kind: 'users', starts_at: NOW - 1000, expires_at: NOW - 1 } }), NOW)).toBe('offline');
  });
});

// ── recipient picker validation (exact username, no fuzzy search) ──────────
describe('normalizeUsername + isDuplicateRecipient', () => {
  it('trims and accepts a plain username', () => {
    expect(normalizeUsername('  ivan ')).toEqual({ ok: true, username: 'ivan' });
  });
  it('rejects empty and over-long inputs', () => {
    expect(normalizeUsername('   ').ok).toBe(false);
    expect(normalizeUsername('x'.repeat(121)).ok).toBe(false);
    expect(normalizeUsername('x'.repeat(120)).ok).toBe(true);
  });
  it('detects a duplicate recipient (case-sensitive exact match)', () => {
    expect(isDuplicateRecipient('ivan', [grant()])).toBe(true);
    expect(isDuplicateRecipient('Ivan', [grant()])).toBe(false);
    expect(isDuplicateRecipient('maria', [grant()])).toBe(false);
  });
});

// ── expiry (datetime-local ⇄ epoch) ────────────────────────────────────────
describe('expiry conversion', () => {
  it('round-trips epoch → datetime-local → epoch (minute precision)', () => {
    const ts = NOW - (NOW % 60_000);
    const v = epochToDatetimeLocal(ts);
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const back = datetimeLocalToEpoch(v, ts - 1000);
    expect(back).toEqual({ ok: true, expiresAt: ts });
  });
  it('empty value = no expiry', () => {
    expect(datetimeLocalToEpoch('', NOW)).toEqual({ ok: true, expiresAt: null });
  });
  it('rejects a past expiry (mirrors the backend rule)', () => {
    expect(datetimeLocalToEpoch(epochToDatetimeLocal(NOW - 60_000), NOW)).toEqual({ ok: false, error: 'share_err_expiry_past' });
  });
  it('unparseable value degrades to no expiry (client cannot invent rules)', () => {
    expect(datetimeLocalToEpoch('garbage', NOW)).toEqual({ ok: true, expiresAt: null });
  });
  it('formats relative expiry for near dates and a date for far ones', () => {
    expect(formatExpiry(NOW + 90_000, NOW)).toBe('2m');
    expect(formatExpiry(NOW + 3 * 3_600_000, NOW)).toBe('3h');
    expect(formatExpiry(NOW + 3 * 86_400_000, NOW)).toBe('3d');
    expect(formatExpiry(NOW + 30 * 86_400_000, NOW)).toBe(new Date(NOW + 30 * 86_400_000).toLocaleDateString());
    expect(formatExpiry(null, NOW)).toBe('');
  });
});

// ── error mapping (ApiError → localized keys) ──────────────────────────────
describe('shareErrorKey', () => {
  it('maps the documented backend error codes', () => {
    expect(shareErrorKey(new ApiError('Unknown user(s): x', 400))).toBe('share_err_unknown_user');
    expect(shareErrorKey(new ApiError('Cannot share with yourself', 400))).toBe('share_err_self_grant');
    expect(shareErrorKey(new ApiError('Worker is already shared — stop sharing first', 409))).toBe('share_err_already_active');
    expect(shareErrorKey(new ApiError('Worker has no active users sharing — start sharing with users first', 409))).toBe('share_err_no_users_policy');
    expect(shareErrorKey(new ApiError('expires_at must be in the future', 400))).toBe('share_err_expiry_past');
    expect(shareErrorKey(new ApiError('users must be a non-empty array', 400))).toBe('share_err_invalid_users');
    expect(shareErrorKey(new ApiError('scope must be one of', 400))).toBe('share_err_invalid_scope');
    expect(shareErrorKey(new ApiError('Authentication required', 401))).toBe('worker_err_auth_required');
    expect(shareErrorKey(new ApiError('Worker not found', 404))).toBe('worker_err_not_found');
    expect(shareErrorKey(new ApiError('Guests cannot look up users', 403))).toBe('share_err_forbidden');
    expect(shareErrorKey(new ApiError('DB exploded', 500))).toBe('worker_err_unavailable');
  });
  it('non-ApiError degrades to a generic message', () => {
    expect(shareErrorKey(new Error('boom'))).toBe('boom');
  });
});

// ── notification diff (§14.2 state → trigger derivation) ───────────────────
describe('diffSharedWorkers', () => {
  it('returns only newly granted workers (by worker_id)', () => {
    const a = swm({ worker_id: 'w1' });
    const b = swm({ worker_id: 'w2' });
    expect(diffSharedWorkers([a], [a, b])).toEqual([b]);
    expect(diffSharedWorkers([a, b], [a])).toEqual([]);
  });
  it('an entry that disappears and reappears is new again (re-share)', () => {
    const a = swm({ worker_id: 'w1' });
    expect(diffSharedWorkers([], [a])).toEqual([a]);
  });
});

// ── owner row eligibility ───────────────────────────────────────────────────
describe('canBeShared', () => {
  it('private non-revoked workers only (mode is never editable via UI)', () => {
    expect(canBeShared({ worker_id: 'w', workspace_id: 'ws', name: 'n', worker_type: 'audio', capabilities: null, mode: 'private', status: 'ONLINE', token_prefix: null, last_seen: null, revoked_at: null, created_at: NOW })).toBe(true);
    expect(canBeShared({ worker_id: 'w', workspace_id: 'ws', name: 'n', worker_type: 'audio', capabilities: null, mode: 'share', status: 'ONLINE', token_prefix: null, last_seen: null, revoked_at: null, created_at: NOW })).toBe(false);
    expect(canBeShared({ worker_id: 'w', workspace_id: 'ws', name: 'n', worker_type: 'audio', capabilities: null, mode: 'private', status: 'REVOKED', token_prefix: null, last_seen: null, revoked_at: NOW, created_at: NOW })).toBe(false);
  });
});

// ── API layer (wire contract with the real backend routes) ─────────────────
describe('sharing API client', () => {
  beforeEach(() => { shareFeatureEnabled.value = true; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('startShare POSTs scope+users and re-reads the owner view', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/workers/w1/share')) {
        expect(JSON.parse(String(init.body))).toEqual({ scope: 'users', users: ['ivan'] });
        return ok({ sharing: true, policy: policy({ scope_kind: 'users' }), grants: [grant()] });
      }
      if (String(url).endsWith('/workers/w1/share') && !init?.method) {
        return ok({ sharing: true, policy: policy({ scope_kind: 'users' }), grants: [grant()] });
      }
      throw new Error('unexpected ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await startShare('w1', { scope: 'users', users: ['ivan'] });
    expect(res.sharing).toBe(true);
    expect(res.grants).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // POST + canonical re-read
  });

  it('startShare public never sends a users array (backend contract)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ scope: 'public' });
        return ok({ sharing: true, policy: policy(), grants: [] });
      }
      return ok({ sharing: true, policy: policy(), grants: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await startShare('w1', { scope: 'public' });
  });

  it('stopShare DELETEs the policy endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      expect(String(url)).toContain('/workers/w1/share');
      return ok({ sharing: false, stopped: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    await stopShare('w1');
  });

  it('addShareUsers POSTs usernames; response grants replace local state', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init && init.method).toBe('POST');
      expect(JSON.parse(String(init && init.body))).toEqual({ users: ['maria'] });
      return ok({ grants: [grant({ username: 'maria' })] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const grants = await addShareUsers('w1', ['maria']);
    expect(grants[0].username).toBe('maria');
  });

  it('removeShareUser DELETEs with a JSON body { username }', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init && init.method).toBe('DELETE');
      expect(JSON.parse(String(init && init.body))).toEqual({ username: 'maria' });
      return ok({ revoked: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await removeShareUser('w1', 'maria')).toBe(true);
  });

  it('lookupUser returns the public projection or null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toContain('/users/lookup?username=ivan');
      return ok({ user: { user_id: 'u2', username: 'ivan', display_name: 'Ivan Petrov' } });
    }));
    const user = await lookupUser('ivan');
    expect(user).toEqual({ user_id: 'u2', username: 'ivan', display_name: 'Ivan Petrov' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'User not found' }), { status: 404 })));
    expect(await lookupUser('ghost')).toBeNull();
  });

  it('fetchShareState surfaces the full owner view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ sharing: true, policy: policy({ scope_kind: 'users' }), grants: [grant()] })));
    const s = await fetchShareState('w1');
    expect(s.sharing).toBe(true);
    expect(s.grants).toHaveLength(1);
  });
});

// ── kill-switch capability probe (config → fail CLOSED) ────────────────────
describe('probeShareFeature', () => {
  afterEach(() => { vi.unstubAllGlobals(); shareFeatureEnabled.value = null; });

  it('reads features.share from /config when the kill-switch is on', async () => {
    shareFeatureEnabled.value = null;
    vi.stubGlobal('fetch', vi.fn(async () => ok({ limits: {}, features: { share: true } })));
    expect(await probeShareFeature()).toBe(true);
    expect(shareFeatureEnabled.value).toBe(true);
  });

  it('disabled flag → UI layer must never dial V2 endpoints', async () => {
    shareFeatureEnabled.value = null;
    const fetchMock = vi.fn(async (_url: string) => ok({ limits: {}, features: { share: false } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeShareFeature()).toBe(false);
    // The probe is the ONLY request — no share endpoint is ever called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).not.toContain('/workers/');
  });

  it('config unreachable → fail CLOSED', async () => {
    shareFeatureEnabled.value = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await probeShareFeature()).toBe(false);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────
function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Worker Sharing V2 (SH-2) — frontend feature module
// ─────────────────────────────────────────────────────────────────────────
// Client of the ALREADY IMPLEMENTED V2 backend surface (worker-routes.cjs,
// users-routes.cjs). This module owns NO parallel state model: every read
// goes to the backend and responses replace local state wholesale — the
// server is the single source of truth for grants, policies and expiry.
//
// Kill-switch (SHARE_FEATURES_ENABLED): the capability is read once from
// GET /api/v1/config (features.share — backend mirrors the env lazily).
// When the flag is off the UI hides every sharing element and NO V2
// endpoint is ever called (the backend answers 404 for them anyway; we
// simply never dial).
//
// Pure helpers (shareModeOf, expiry conversion, error mapping, diff) live
// here so they are unit-testable without a DOM — same pattern as
// privateWorkers.ts.

import { signal } from '@preact/signals';
import { getJson, postJson, deleteJson, deleteJsonBody, ApiError } from '../../api/client';
import type { PrivateWorker, WorkerStatus, WorkerType } from './privateWorkers';

// ── Wire types (1:1 with backend JSON) ─────────────────────────────────────

export type ShareScope = 'public' | 'users';

/** share_policies row (active policy snapshot, owner or read view). */
export interface SharePolicy {
  policy_id: string;
  worker_id?: string;
  workspace_id?: string;
  scope_kind: ShareScope;
  starts_at: number | null;
  expires_at: number | null;
  revoked_at?: number | null;
  created_by?: string | null;
  created_at?: number;
}

/** share_policy_grants row joined with the recipient's public projection. */
export interface ShareGrant {
  grant_id: string;
  policy_id: string;
  user_id: string;
  created_at: number | null;
  username: string;
  display_name: string | null;
}

/** GET /workers/:id/share — owner view of the current sharing state. */
export interface ShareState {
  sharing: boolean;
  policy: SharePolicy | null;
  grants: ShareGrant[];
}

/** GET /workers/shared-with-me entry — §14.2 access reason included. */
export interface SharedWithMeWorker {
  worker_id: string;
  name: string;
  worker_type: WorkerType;
  capabilities: unknown;
  owner_workspace_id: string;
  revoked_at: number | null;
  last_seen: number | null;
  created_at: number | null;
  granted_at: number | null;
  share_policy: { policy_id: string; scope_kind: ShareScope; starts_at: number | null; expires_at: number | null };
  access_reason: {
    kind: 'shared_by_user';
    shared_by: string | null;
    shared_by_display_name: string | null;
    owner_workspace_name: string | null;
  };
}

/** GET /users/lookup — exact username match, public projection only. */
export interface LookupUser {
  user_id: string;
  username: string;
  display_name: string | null;
}

// ── Kill-switch capability (read ONCE from /config) ───────────────────────

/** null = unknown (probe not finished); otherwise the mirrored flag. */
export const shareFeatureEnabled = signal<boolean | null>(null);

/** One-time capability probe. Never re-dials: the flag lives for the session
 *  (a running process flips it only via env change, which implies a restart
 *  in the current deployment model). */
export async function probeShareFeature(): Promise<boolean> {
  if (shareFeatureEnabled.value !== null) return shareFeatureEnabled.value;
  try {
    const cfg = await getJson<{ features?: { share?: boolean } }>('/config');
    shareFeatureEnabled.value = cfg?.features?.share === true;
  } catch {
    // Config unavailable — fail CLOSED: no sharing UI, no V2 requests.
    shareFeatureEnabled.value = false;
  }
  return shareFeatureEnabled.value;
}

// ── API functions (thin, 1:1 with the backend routes) ──────────────────────

export async function fetchShareState(workerId: string): Promise<ShareState> {
  const res = await getJson<ShareState>(`/workers/${encodeURIComponent(workerId)}/share`);
  return { sharing: !!res.sharing, policy: res.policy ?? null, grants: res.grants ?? [] };
}

/** Start sharing. scope 'public' (no recipients) or 'users' (+ usernames). */
export async function startShare(workerId: string, opts: {
  scope: ShareScope; users?: string[]; expiresAt?: number | null;
}): Promise<ShareState & { created?: true }> {
  const body: Record<string, unknown> = { scope: opts.scope };
  if (opts.scope === 'users') body.users = opts.users ?? [];
  if (opts.expiresAt != null) body.expires_at = opts.expiresAt;
  await postJson<unknown>(`/workers/${encodeURIComponent(workerId)}/share`, body);
  // Server response is authoritative but partial (policy+grants) — re-read
  // the canonical owner view so the UI never mirrors a hand-built state.
  return { ...(await fetchShareState(workerId)), created: true };
}

export async function stopShare(workerId: string): Promise<void> {
  await deleteJson(`/workers/${encodeURIComponent(workerId)}/share`);
}

export async function addShareUsers(workerId: string, usernames: string[]): Promise<ShareGrant[]> {
  const res = await postJson<{ grants: ShareGrant[] }>(
    `/workers/${encodeURIComponent(workerId)}/share/users`, { users: usernames });
  return res.grants ?? [];
}

export async function removeShareUser(workerId: string, username: string): Promise<boolean> {
  const res = await deleteJsonBody<{ revoked: boolean }>(
    `/workers/${encodeURIComponent(workerId)}/share/users`, { username });
  return !!res.revoked;
}

export async function lookupUser(username: string): Promise<LookupUser | null> {
  try {
    const res = await getJson<{ user: LookupUser }>(
      `/users/lookup?username=${encodeURIComponent(username)}`);
    return res.user ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null; // unknown user
    throw e;
  }
}

export async function fetchSharedWithMe(): Promise<SharedWithMeWorker[]> {
  const res = await getJson<{ workers: SharedWithMeWorker[] }>('/workers/shared-with-me');
  return res.workers ?? [];
}

// ── Pure helpers ───────────────────────────────────────────────────────────

export type ShareMode = 'off' | 'public' | 'users';

/** Derive the user-facing sharing mode from the active policy (or null). */
export function shareModeOf(policy: SharePolicy | null | undefined): ShareMode {
  if (!policy || policy.revoked_at != null) return 'off';
  if (policy.scope_kind === 'users') return 'users';
  if (policy.scope_kind === 'public') return 'public';
  return 'off';
}

/** Is the policy expired (expiry re-check mirrors the backend read rule)? */
export function isPolicyExpired(policy: SharePolicy | null | undefined, now: number = Date.now()): boolean {
  if (!policy) return false;
  return policy.expires_at != null && policy.expires_at <= now;
}

/** Current status pill for a shared-with-me worker (owner's own rows reuse
 *  the same classes; a foreign worker's ONLINE-ness is informational). */
export function sharedStatusClass(w: SharedWithMeWorker, now: number = Date.now()): 'online' | 'offline' {
  if (w.revoked_at != null) return 'offline';
  if (isPolicyExpired(w.share_policy, now)) return 'offline';
  return w.last_seen != null && now - w.last_seen < 90_000 ? 'online' : 'offline';
}

/** "Shared by <username>" — §14.2 access reason rendering. */
export function sharedByLabel(entry: SharedWithMeWorker): string {
  const a = entry.access_reason;
  return a.shared_by || a.shared_by_display_name || a.owner_workspace_name || '';
}

const MAX_USERNAME_LEN = 120;

/** Trim + validate a recipient input BEFORE the exact-match lookup. */
export function normalizeUsername(raw: string): { ok: true; username: string } | { ok: false; error: 'share_err_username_required' | 'share_err_username_too_long' } {
  const username = raw.trim();
  if (!username) return { ok: false, error: 'share_err_username_required' };
  if (username.length > MAX_USERNAME_LEN) return { ok: false, error: 'share_err_username_too_long' };
  return { ok: true, username };
}

/** True when the username is already among the visible recipients. */
export function isDuplicateRecipient(username: string, grants: ShareGrant[]): boolean {
  const u = username.trim();
  return grants.some((g) => g.username === u);
}

// ── Expiry (datetime-local ⇄ epoch-ms) ─────────────────────────────────────

/** Epoch-ms → value for <input type="datetime-local"> (local time, minutes). */
export function epochToDatetimeLocal(ts: number | null | undefined): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value → epoch-ms, or { error } when in the past/unparsed.
 *  Mirrors the backend rule: expires_at must be an integer strictly in the
 *  future — the client pre-checks to save a round-trip, never to override. */
export function datetimeLocalToEpoch(value: string, now: number = Date.now()):
  { ok: true; expiresAt: number | null } | { ok: false; error: 'share_err_expiry_past' } {
  if (!value) return { ok: true, expiresAt: null }; // no expiry — valid
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return { ok: true, expiresAt: null };
  if (ts <= now) return { ok: false, error: 'share_err_expiry_past' };
  return { ok: true, expiresAt: ts };
}

/** Short localized "until" suffix: relative for <7d, else date. */
export function formatExpiry(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null) return '';
  const diff = ts - now;
  if (diff <= 0) return new Date(ts).toLocaleString();
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString();
}

// ── Error mapping (ApiError → localized message) ───────────────────────────

/** Map share-flow failures to i18n keys; hides DB/Redis internals the same
 *  way humanError() does in PrivateWorkersSection. */
export function shareErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || '';
    if (e.status === 401) return 'worker_err_auth_required';
    if (e.status === 403) return 'share_err_forbidden';
    if (e.status === 404) return 'worker_err_not_found';
    if (e.status === 409) {
      if (msg.includes('already shared')) return 'share_err_already_active';
      if (msg.includes('no active users sharing')) return 'share_err_no_users_policy';
    }
    if (e.status === 400) {
      if (msg.includes('Unknown user')) return 'share_err_unknown_user';
      if (msg.includes('yourself')) return 'share_err_self_grant';
      if (msg.includes('expires_at must be in the future')) return 'share_err_expiry_past';
      if (msg.includes('users must be')) return 'share_err_invalid_users';
      if (msg.includes('scope')) return 'share_err_invalid_scope';
    }
    if (e.status >= 500) return 'worker_err_unavailable';
    return e.message || 'share_err_unavailable';
  }
  return (e as Error)?.message || 'share_err_unavailable';
}

// ── Notification derivation (state diff, §14.2) ────────────────────────────

/** Which entries of `next` are NEW compared to `prev` (by worker_id).
 *  Pure — used by shareNotifications to raise «<username> поделился …». */
export function diffSharedWorkers(prev: SharedWithMeWorker[], next: SharedWithMeWorker[]): SharedWithMeWorker[] {
  const seen = new Set(prev.map((w) => w.worker_id));
  return next.filter((w) => !seen.has(w.worker_id));
}

/** Worker row eligibility for the owner's Share control: private, not
 *  revoked. The backend enforces the same predicates (D7) — this only
 *  avoids rendering a button that would 404. */
export function canBeShared(worker: PrivateWorker): boolean {
  return worker.mode === 'private' && worker.status !== 'REVOKED';
}

export type { WorkerStatus };

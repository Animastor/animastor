// ─────────────────────────────────────────────────────────────────────────
// Private Worker Management (Experimental Beta — Phase 3)
// ─────────────────────────────────────────────────────────────────────────
// Pure helpers shared by the /settings/private-workers UI and its tests.
// No DOM / no React here — the section component imports these.
//
// SECURITY INVARIANT: the plaintext worker credential (token) is a ONE-TIME
// disclosure. It lives only transiently in React `useState` (component
// memory) and is NEVER persisted — not in localStorage, sessionStorage, the
// URL, Redux persistence nor IndexedDB. The helpers below assert nothing
// about token storage; the component is responsible for that.

export type WorkerType = 'audio' | 'image' | 'video';
export type WorkerMode = 'private' | 'share';
export type WorkerStatus = 'ONLINE' | 'OFFLINE' | 'REVOKED';

/** Public worker shape returned by GET /api/v1/workers (list/detail/create/rotate).
 *  NEVER contains `token` or `token_hash` — only safe metadata. */
export interface PrivateWorker {
  worker_id: string;
  workspace_id: string;
  name: string;
  worker_type: WorkerType;
  capabilities: unknown;
  mode: WorkerMode;
  status: WorkerStatus;
  token_prefix: string | null;
  last_seen: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface CreateWorkerResponse { worker: PrivateWorker; token: string }
export interface RotateWorkerResponse { worker: PrivateWorker; token: string }
export interface ListWorkersResponse { workers: PrivateWorker[] }
export interface WorkerDetailResponse { worker: PrivateWorker }
export interface RevokeWorkerResponse { revoked: boolean }

export const WORKER_TYPE_OPTIONS: { type: WorkerType; label: 'layer_audio' | 'layer_image' | 'layer_video' }[] = [
  { type: 'audio', label: 'layer_audio' },
  { type: 'image', label: 'layer_image' },
  { type: 'video', label: 'layer_video' },
];

export const VALID_WORKER_TYPES: WorkerType[] = ['audio', 'image', 'video'];

/** Parse/validate the body of a create-worker call. Returns null if invalid. */
export function validateCreateInput(name: string, workerType: string): { ok: true; name: string; worker_type: WorkerType } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'worker_name_required' };
  if (trimmed.length > 120) return { ok: false, error: 'worker_name_too_long' };
  if (!VALID_WORKER_TYPES.includes(workerType as WorkerType)) return { ok: false, error: 'worker_type_invalid' };
  return { ok: true, name: trimmed, worker_type: workerType as WorkerType };
}

/** A `wrk.<id>.<secret>` token, as issued by the backend one-time. */
export function looksLikeWorkerToken(token: string): boolean {
  if (!token || token.length < 8) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'wrk') return false;
  return parts[1].length > 0 && parts[2].length > 0;
}

/** Localized status key + a stable DONE/ONLINE/OFFLINE/REVOKED label set. */
export function statusKey(status: WorkerStatus): 'worker_status_online' | 'worker_status_offline' | 'worker_status_revoked' {
  if (status === 'ONLINE') return 'worker_status_online';
  if (status === 'REVOKED') return 'worker_status_revoked';
  return 'worker_status_offline';
}

/** CSS class suffix for the status pill — reused by the list and detail rows. */
export function statusClass(status: WorkerStatus): string {
  if (status === 'ONLINE') return 'worker__status--online';
  if (status === 'REVOKED') return 'worker__status--revoked';
  return 'worker__status--offline';
}

/** Format an epoch-ms timestamp as a localized relative/short string. */
export function formatLastSeen(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return '—';
  const diff = now - ts;
  if (diff < 0) return new Date(ts).toLocaleString();
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

/** Worker setup contract — the EXACT env var names worker.cjs reads.
 *  Kept in sync with worker/worker/worker.cjs (HUB_URL, ANIMASTOR_WORKER_TOKEN,
 *  WORKER_TYPE, WORKER_ID). Changing these here without the worker breaks Beta. */
export interface WorkerSetupContract {
  env: { HUB_URL: string; ANIMASTOR_WORKER_TOKEN: string; WORKER_TYPE: WorkerType; WORKER_ID: string };
  steps: readonly string[];
}

export function buildSetupContract(token: string, workerType: WorkerType, workerName: string): WorkerSetupContract {
  const HUB_URL = typeof location !== 'undefined'
    ? `${location.origin}/gpu`
    : 'https://<your-hub>/gpu';
  return {
    env: {
      HUB_URL,
      ANIMASTOR_WORKER_TOKEN: token,
      WORKER_TYPE: workerType,
      WORKER_ID: workerName.replace(/\s+/g, '-').toLowerCase(),
    },
    steps: [
      'worker_setup_step_1',
      'worker_setup_step_2',
      'worker_setup_step_3',
      'worker_setup_step_4',
    ],
  };
}

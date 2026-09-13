// ─────────────────────────────────────────────────────────────────────────
// Share notifications — MINIMAL adapter (SH-2 UX §5/§6)
// ─────────────────────────────────────────────────────────────────────────
// The backend already emits the structured `worker.shared_with_user` event
// (share-events.js) but has NO user-facing notification delivery yet — the
// documented seam is a sink contract for a future inbox/WS consumer.
//
// This module is the matching FRONTEND seam, deliberately minimal:
//   • `onShareNotice(fn)` — subscribe to notices; a future notification
//     transport (SSE/WS/inbox poll) plugs in by calling `emitShareNotice`.
//   • Until such transport exists, notices are DERIVED from the canonical
//     state: each "Shared with me" refresh diffs the previous list
//     (diffSharedWorkers in sharing.ts) and every newly granted worker_id
//     raises a notice + feeds the unread badge.
//   • The badge counts PERSONAL shared workers only (never the community
//     pool). The seen-marker is session-only UI sugar; access itself is
//     always re-fetched from the backend — local state is never the source
//     of truth for grants (revoked/expired entries simply stop arriving).

import { signal } from '@preact/signals';
import type { SharedWithMeWorker } from './sharing';

/** Mirrors share-events.js payload (stable event contract). */
export interface ShareNotice {
  event: 'worker.shared_with_user';
  worker_id: string | null;
  worker_name: string | null;
  actor_username: string | null;
  ts: number;
}

type NoticeHandler = (n: ShareNotice) => void;

const handlers = new Set<NoticeHandler>();

/** Subscribe to share notices. Returns the unsubscribe function. */
export function onShareNotice(fn: NoticeHandler): () => void {
  handlers.add(fn);
  return () => { handlers.delete(fn); };
}

/** Transport seam: raise a notice to every subscriber (never throws). */
export function emitShareNotice(notice: ShareNotice): void {
  for (const fn of handlers) {
    try { fn(notice); } catch (_) { /* subscribers must not break the flow */ }
  }
}

/** Build a notice from a shared-with-me entry + now (pure). */
export function noticeFromEntry(entry: SharedWithMeWorker, ts: number = Date.now()): ShareNotice {
  return {
    event: 'worker.shared_with_user',
    worker_id: entry.worker_id ?? null,
    worker_name: entry.name ?? null,
    actor_username: entry.access_reason?.shared_by ?? null,
    ts,
  };
}

/** Localized notice message: «Ivan поделился Worker "X" с вами». */
export function shareNoticeMessage(n: ShareNotice, fmt: (actor: string, worker: string) => string): string {
  return fmt(n.actor_username ?? '', n.worker_name ?? '');
}

// ── Unread badge (§6) ───────────────────────────────────────────────────────

/** Personal shared-worker count from the latest backend fetch (truth). */
export const sharedWithMeCount = signal(0);
/** How many of those entries the user has not viewed this session. */
export const sharedUnreadCount = signal(0);

// NOTICE dedup: every worker_id ever seen in a sync (across view state) —
// a grant toasts once per session, even if the user views and it stays.
const knownWorkerIds = new Set<string>();
// BADGE state: worker_ids the user has explicitly viewed this session.
const viewedWorkerIds = new Set<string>();

/** Sync the badge + derive notices from a fresh shared-with-me read.
 *  The FIRST sync of a session only seeds state (no surprise toasts for
 *  access granted before the page loaded — the badge already reflects it);
 *  every later sync raises notices for genuinely new worker_ids.
 *  Returns the entries that raised notices ([] on initial sync). */
export function syncSharedWithMe(prev: SharedWithMeWorker[], next: SharedWithMeWorker[]): SharedWithMeWorker[] {
  sharedWithMeCount.value = next.length;
  const isInitialSync = prev.length === 0 && knownWorkerIds.size === 0;
  const freshForNotices = next.filter((w) => !knownWorkerIds.has(w.worker_id));
  for (const w of next) knownWorkerIds.add(w.worker_id);
  sharedUnreadCount.value = next.filter((w) => !viewedWorkerIds.has(w.worker_id)).length;
  if (!isInitialSync) {
    for (const w of freshForNotices) emitShareNotice(noticeFromEntry(w));
  }
  return isInitialSync ? [] : freshForNotices;
}

/** User opened "Shared with me" — badge clears (session sugar only). */
export function markSharedSeen(current: SharedWithMeWorker[]): void {
  for (const w of current) viewedWorkerIds.add(w.worker_id);
  sharedUnreadCount.value = 0;
}

/** Re-initialize the session-only notification state (used by tests and a
 *  full re-login; access itself is always re-fetched from the backend). */
export function resetShareNotifications(): void {
  knownWorkerIds.clear();
  viewedWorkerIds.clear();
  sharedWithMeCount.value = 0;
  sharedUnreadCount.value = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// AI chat streaming UX helpers (LLM Sharing Phase 3).
//
// Pure, testable mapping of the production SSE contract to UI state:
//   - sourceBadgeKey: the `ai_source` token → honest Private/Shared badge
//     (a SAFE token only — the backend never sends endpoint/owner detail).
//   - streamErrorKey: sanitized backend error codes → localized i18n keys.
//   - isUserCancelled: distinguishes the user's cancel from other aborts.
// ─────────────────────────────────────────────────────────────────────────

// ai_source tokens the backend may put on meta/done frames (Phase 2 §6):
// 'private-local' | 'shared' | 'cloud' | 'system'.
export type AiSource = 'private-local' | 'shared' | 'cloud' | 'system';

export function sourceBadgeKey(source: string | null | undefined): string | null {
  switch (source) {
    case 'private-local': return 'ai_source_private';
    case 'shared': return 'ai_source_shared';
    case 'cloud': return 'ai_source_cloud';
    case 'system': return 'ai_source_system';
    default: return null;
  }
}

// Sanitized backend failure codes (shared-pool / transport / stream route).
// Known codes map to honest localized states; unknown codes fall back to the
// backend's fixed sanitized message.
export function streamErrorKey(code: string | null | undefined): string | null {
  switch (code) {
    case 'ai_unavailable': return 'ai_state_unavailable';
    case 'local_ai_not_ready': return 'ai_state_local_not_ready';
    case 'shared_unavailable': return 'ai_state_shared_unavailable';
    case 'connector_offline': return 'ai_state_offline';
    case 'session_closed': return 'ai_state_offline';
    case 'runtime_unreachable': return 'ai_state_runtime_unreachable';
    case 'timeout': return 'ai_state_timeout';
    case 'busy': return 'ai_state_busy';
    case 'model_not_found': return 'ai_state_model_not_found';
    case 'stream_failed': return 'ai_state_stream_failed';
    case 'cancelled': return 'ai_cancelled';
    default: return null;
  }
}

// True when the stream ended because the USER pressed stop (their own
// AbortController aborted) — the UI keeps the partial answer and marks the
// message cancelled instead of showing an error.
export function isUserCancelled(err: unknown, cancelledRef: { current: boolean }): boolean {
  if (cancelledRef.current) return true;
  const e = err as { name?: string; code?: number } | null;
  return !!e && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

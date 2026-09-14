// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-sse — public API entry point
// ═══════════════════════════════════════════════════════════════
//  SSE stream orchestration for generation progress. Manages the
//  reconnect loop, epoch-guarded event routing, and error handling.
//
//  The host owns:
//   - AbortController + SSE connection (transport layer)
//   - Epoch counter (session identity for stale detection)
//   - Host signals (via ProgressEventSink)
//   - ProgressTrackingState (host-owned explicit state)
//
//  This package owns:
//   - Reconnect loop with exponential backoff
//   - Epoch checking (stale session detection)
//   - Event routing through @animastor/web-generator
//
//  Dependency rules (pinned by architecture guard):
//   - This package imports ONLY @animastor/web-generator
//     (for routeProgressEvent, ProgressEventSink, ProgressTrackingState).
//   - It must NOT import host stores, api/client, app/*, pages,
//     @preact/signals, or any other @animastor/* package.
// ═══════════════════════════════════════════════════════════════

import { routeProgressEvent } from '@animastor/web-generator';
import type { ProgressEventSink, ProgressTrackingState } from '@animastor/web-generator';

// Re-export types for host convenience
export type { ProgressEventSink, ProgressTrackingState };

/** Minimal SSE event shape — the data field carries the JSON payload. */
export interface SseEvent {
  data: string;
}

/**
 * Stream capabilities provided by the host. The host owns the actual
 * SSE connection; this package consumes the async iterable.
 */
export interface SseStreamPort {
  /** Start an SSE stream. Returns an async iterable of events.
   *  The host manages AbortController, URL construction, and
   *  the actual fetch connection. When the stream is aborted
   *  (via stop()), the async iterable should throw or resolve. */
  start(bookId: string): AsyncIterable<SseEvent>;
  /** Abort the current stream (cancel / book close / new generation). */
  stop(): void;
}

/** Configuration for the reconnect loop. */
export interface SseStreamConfig {
  /** Initial reconnect delay in ms (default: 1000). */
  initialDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 15000). */
  maxDelayMs?: number;
  /** Maximum exponent for backoff (default: 4 → 1s, 2s, 4s, 8s, 15s cap). */
  maxExponent?: number;
}

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_MAX_EXPONENT = 4;

// ── Core function ───────────────────────────────────────────

/**
 * Run the SSE progress stream with reconnect logic and event routing.
 *
 * This function owns the reconnect loop. It:
 *  1. Iterates the SSE stream provided by the host
 *  2. Routes each event through @animastor/web-generator's routeProgressEvent
 *  3. On stream close (normal or error), waits with exponential backoff
 *     and retries — server SSE keeps the connection open; close = drop
 *  4. Checks the epoch on every iteration — returns silently if stale
 *
 * Exit conditions:
 *  - Epoch mismatch (host bumped epoch → cancel/new generation)
 *
 * Reconnect triggers (both reconnect via exponential backoff):
 *  - Normal stream close (server dropped connection)
 *  - Stream error (network failure, timeout, etc.)
 *
 * The host controls session lifetime via the epoch: when the host bumps the
 * epoch (e.g., on cancel or new generation), this function detects the mismatch
 * and exits its loop on the next iteration.
 *
 * @param streamPort - Host-provided SSE stream capabilities
 * @param getEpoch - Returns the current session epoch. The host increments
 *   this on cancel/new generation. The function checks this before each
 *   reconnect and after each event to detect stale sessions.
 * @param sink - Host signal bridge for event routing
 * @param tracking - Host-owned progress tracking state
 * @param bookId - Current book identifier
 * @param config - Optional reconnect configuration
 */
export async function runSseStream(
  streamPort: SseStreamPort,
  getEpoch: () => number,
  sink: ProgressEventSink,
  tracking: ProgressTrackingState,
  bookId: string,
  config?: SseStreamConfig,
): Promise<void> {
  const initialDelay = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelay = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxExponent = config?.maxExponent ?? DEFAULT_MAX_EXPONENT;

  let attempt = 0;
  let epoch = getEpoch();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const stream = streamPort.start(bookId);
      for await (const ev of stream) {
        if (getEpoch() !== epoch) return;
        if (ev.data) {
          routeProgressEvent(sink, tracking, ev.data);
        }
      }
      // Stream closed — reconnect (server keeps it open; close = drop).
    } catch { /* will retry below */ }

    // Stale check — host bumped epoch
    if (getEpoch() !== epoch) return;

    // Reconnect with backoff
    const delayMs = Math.min(maxDelay, initialDelay * (1 << Math.min(attempt, maxExponent)));
    attempt++;
    await new Promise((r) => setTimeout(r, delayMs));

    // Re-check stale after waiting
    if (getEpoch() !== epoch) return;
  }
}

/**
 * Route a single SSE event payload through the domain router.
 * Convenience wrapper for testing or manual event dispatch.
 */
export function handleProgressEvent(
  sink: ProgressEventSink,
  tracking: ProgressTrackingState,
  data: string,
): void {
  routeProgressEvent(sink, tracking, data);
}

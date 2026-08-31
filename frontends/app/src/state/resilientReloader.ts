// Reload retry/recovery layer on top of the ResourceInvalidations pipeline —
// 1:1 contract with the Android ResilientReloader.kt (commit 1b2fbf66):
//
//     invalidation → reload → network failure → retry/recovery → reload → UI
//
// Contract:
//  - Bounded backoff 1s → 2s → 5s → 10s (initial attempt + one retry per
//    delay step). No infinite aggressive polling.
//  - Fast path: a connectivity restore during a backoff wait short-circuits
//    the remaining timer — the retry happens the moment the network returns.
//  - If the network is still DOWN when the bounded cycle exhausts, the reloader
//    parks on the restore signal (event-driven, zero polling) and makes ONE
//    final attempt — an outage longer than the backoff window still self-heals
//    when connectivity returns.
//  - Transient vs permanent: only network-level failures are retried
//    (TypeError from fetch — offline/DNS; ApiError 408 — client timeout).
//    An ApiError with a real HTTP status (404/500) means the server IS
//    reachable — "the data is really unavailable", never a network blip.
//
// Pure TypeScript (no browser API at module scope): callers pass a recovery
// signal — the browser implementation is WindowOnlineRecovery (navigator.onLine
// + 'online'/'offline' events, the navigator.onLine analogue of Android's
// ConnectivityManager callback); tests substitute fakes.

import { ApiError } from '../api/client';

export interface NetworkRecoverySignal {
  /** Best-effort current connectivity state. */
  readonly isOnline: boolean;
  /**
   * Registers a one-shot callback for the next offline → online transition.
   * Returns the unsubscribe function (used to detach the callback when the
   * bounded backoff timer wins the race). While online the callback simply
   * never fires — the caller's timer bounds the wait, like Android's
   * withTimeoutOrNull over the `restored` flow.
   */
  onNextRestore(fn: () => void): () => void;
}

/**
 * Browser recovery signal: navigator.onLine + the 'online'/'offline' events.
 * The 'online' event fires exactly on an offline → online transition, which
 * mirrors the ConnectivityManager semantics on Android.
 */
export class WindowOnlineRecovery implements NetworkRecoverySignal {
  private online: boolean;
  private listeners = new Set<() => void>();
  private wired = false;

  constructor() {
    this.online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    // Lazy wiring so importing the class in Node tests stays side-effect free.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      this.wired = true;
    }
  }

  private handleOnline = () => {
    this.online = true;
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error('[resilientReloader] recovery listener failed', e);
      }
    });
    this.listeners.clear();
  };

  private handleOffline = () => {
    this.online = false;
  };

  get isOnline(): boolean {
    return this.online;
  }

  onNextRestore(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    if (!this.wired) return;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.wired = false;
    this.listeners.clear();
  }
}

// Shared app instance, created on first use (pages run in the browser; the
// module stays importable from Node tests without touching window).
let shared: NetworkRecoverySignal | null = null;
export function sharedRecovery(): NetworkRecoverySignal {
  if (shared == null) shared = new WindowOnlineRecovery();
  return shared;
}

export type ReloadResult<T> =
  | { kind: 'success'; value: T }
  /** Network went away mid-reload and stayed down through the whole bounded
   *  cycle — the caller keeps the previously loaded content. */
  | { kind: 'transient-failure'; attempts: number; cause: unknown }
  /** The server answered with an error — the data is really unavailable or
   *  missing; this is not a connectivity problem. */
  | { kind: 'permanent-failure'; cause: unknown };

export const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

/** Total attempts phase 1 makes: the initial one plus one per delay step. */
export function phaseOneAttempts(retryDelaysMs: number[]): number {
  return retryDelaysMs.length + 1;
}

/** Network-level failures are transient. Everything else (an HTTP status, a
 *  parse error) means the request reached its destination. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch: offline / DNS / connection reset
  if (e instanceof ApiError) return e.status === 408; // client-side read timeout
  return false;
}

function isCallerAbort(e: unknown): boolean {
  // An AbortError that reached us is caller-initiated cancellation (the
  // client's own read timeout is converted to ApiError 408 before this point).
  return (
    typeof DOMException !== 'undefined' &&
    e instanceof DOMException &&
    e.name === 'AbortError'
  );
}

/**
 * Bounded backoff wait, short-circuited by a connectivity restore (Android
 * withTimeoutOrNull(delay) { restored.first() } parity). While online the
 * restore callback never fires and the timer bounds the wait; while offline
 * the restore resolves early.
 */
function backoffWait(recovery: NetworkRecoverySignal, delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    const off = recovery.onNextRestore(done);
  });
}

/**
 * Run [attempt] with retry/recovery. [onRetry] fires right after a transient
 * failure, when the backoff wait starts — the hook for the unobtrusive
 * "retrying automatically…" notice.
 */
export async function resilientReload<T>(opts: {
  recovery: NetworkRecoverySignal;
  attempt: () => Promise<T>;
  retryDelaysMs?: number[];
  onRetry?: (attempt: number, cause: unknown) => void;
}): Promise<ReloadResult<T>> {
  const { recovery, attempt } = opts;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const onRetry = opts.onRetry;
  let attempts = 0;

  // Phase 1 — bounded backoff with connectivity fast-path.
  for (let step = 0; step <= retryDelaysMs.length; step++) {
    attempts++;
    try {
      return { kind: 'success', value: await attempt() };
    } catch (e) {
      if (isCallerAbort(e)) throw e;
      if (!isTransientError(e)) return { kind: 'permanent-failure', cause: e };
      if (step < retryDelaysMs.length) {
        onRetry?.(attempts, e);
        await backoffWait(recovery, retryDelaysMs[step]);
      }
    }
  }

  // Phase 2 — still offline at exhaustion: park on the restore signal (no
  // timer, no polling) and make one final attempt when it returns.
  if (!recovery.isOnline) {
    await new Promise<void>((resolve) => {
      const off = recovery.onNextRestore(resolve);
      // Safety net: if the signal is online again before we registered (event
      // already consumed), the callback would never fire — bail via the flag.
      if (recovery.isOnline) {
        off();
        resolve();
      }
    });
    attempts++;
    try {
      return { kind: 'success', value: await attempt() };
    } catch (e) {
      if (isCallerAbort(e)) throw e;
      if (!isTransientError(e)) return { kind: 'permanent-failure', cause: e };
    }
  }

  return { kind: 'transient-failure', attempts, cause: undefined };
}

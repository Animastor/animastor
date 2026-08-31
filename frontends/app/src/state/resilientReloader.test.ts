// Tests for the reload retry/recovery state machine (resilientReloader.ts) —
// the web half of the layer on top of the ResourceInvalidations pipeline.
// Android parity: ResilientReloaderTest.kt. Fake recovery signal; zero-length
// backoff steps keep the tests fast while preserving attempt/phase logic.
import { describe, it, expect } from 'vitest';
import {
  resilientReload, isTransientError, phaseOneAttempts,
  DEFAULT_RETRY_DELAYS_MS, type NetworkRecoverySignal,
} from './resilientReloader';
import { ApiError } from '../api/client';

/** Fake connectivity signal with manual online/offline flips. */
class FakeRecovery implements NetworkRecoverySignal {
  online: boolean;
  private cbs = new Set<() => void>();
  constructor(startOnline = true) {
    this.online = startOnline;
  }
  get isOnline(): boolean {
    return this.online;
  }
  onNextRestore(fn: () => void): () => void {
    this.cbs.add(fn);
    return () => {
      this.cbs.delete(fn);
    };
  }
  goOffline(): void {
    this.online = false;
  }
  goOnline(): void {
    this.online = true;
    this.cbs.forEach((fn) => fn());
    this.cbs.clear();
  }
}

const noBackoff = [0, 0, 0];

describe('resilientReload', () => {
  it('succeeds on first attempt without retries', async () => {
    const recovery = new FakeRecovery();
    let calls = 0;
    const result = await resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        return 'fresh';
      },
      retryDelaysMs: noBackoff,
    });
    expect(result).toEqual({ kind: 'success', value: 'fresh' });
    expect(calls).toBe(1);
  });

  it('retries a transient failure until success', async () => {
    const recovery = new FakeRecovery();
    let calls = 0;
    const result = await resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        if (calls === 1) throw new TypeError('Failed to fetch'); // offline blip
        return 'fresh';
      },
      retryDelaysMs: noBackoff,
    });
    expect(result).toEqual({ kind: 'success', value: 'fresh' });
    expect(calls).toBe(2);
  });

  it('gives up after the bounded cycle when the server keeps timing out (online)', async () => {
    const recovery = new FakeRecovery(); // online but every request times out
    let calls = 0;
    const result = await resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        throw new ApiError('Request timeout', 408);
      },
      retryDelaysMs: noBackoff,
    });
    expect(result.kind).toBe('transient-failure');
    expect(calls).toBe(phaseOneAttempts(noBackoff));
  });

  it('permanent failure (server answered) is never retried', async () => {
    const recovery = new FakeRecovery();
    let calls = 0;
    const result = await resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        throw new ApiError('Not Found', 404); // the server IS reachable
      },
      retryDelaysMs: noBackoff,
    });
    expect(result).toMatchObject({ kind: 'permanent-failure' });
    expect(calls).toBe(1);
  });

  it('parks offline and makes the final attempt when connectivity returns', async () => {
    const recovery = new FakeRecovery(false);
    let calls = 0;
    const p = resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        if (calls <= phaseOneAttempts(noBackoff)) throw new TypeError('still offline');
        return 'recovered';
      },
      retryDelaysMs: noBackoff,
    });
    // Let the bounded cycle exhaust while offline, then restore.
    await new Promise((r) => setTimeout(r, 20));
    recovery.goOnline();
    const result = await p;
    expect(result).toEqual({ kind: 'success', value: 'recovered' });
    expect(calls).toBe(phaseOneAttempts(noBackoff) + 1);
  });

  it('restore during backoff short-circuits the wait (fast path)', async () => {
    const recovery = new FakeRecovery();
    let calls = 0;
    const p = resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        if (calls === 1) throw new TypeError('blip right before restore');
        return 'fast';
      },
      retryDelaysMs: [60_000, 60_000, 60_000, 60_000], // would take minutes
    });
    // The restore event must release the 60s backoff wait almost immediately.
    await new Promise((r) => setTimeout(r, 10));
    recovery.goOnline();
    const result = await p;
    expect(result).toEqual({ kind: 'success', value: 'fast' });
    expect(calls).toBe(2);
  });

  it('onRetry hook fires on every scheduled backoff', async () => {
    const recovery = new FakeRecovery();
    const retryAttempts: number[] = [];
    let calls = 0;
    await resilientReload({
      recovery,
      attempt: async () => {
        calls++;
        if (calls <= 2) throw new TypeError('flaky');
        return null;
      },
      retryDelaysMs: noBackoff,
      onRetry: (attempt) => retryAttempts.push(attempt),
    });
    expect(retryAttempts).toEqual([1, 2]);
  });

  it('timeout ApiError (408) is transient, other statuses are not', () => {
    expect(isTransientError(new ApiError('Request timeout', 408))).toBe(true);
    expect(isTransientError(new ApiError('Not Found', 404))).toBe(false);
    expect(isTransientError(new ApiError('Server Error', 500))).toBe(false);
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('default backoff steps match the Android contract (1s 2s 5s 10s)', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000]);
    expect(phaseOneAttempts(DEFAULT_RETRY_DELAYS_MS)).toBe(5);
  });
});

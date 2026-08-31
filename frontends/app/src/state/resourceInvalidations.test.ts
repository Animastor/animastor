// Tests for the generic resource invalidation bus (resourceInvalidations.ts) —
// the web half of the "external data mutation → invalidation event → cache
// evict → re-fetch → reactive UI update" pipeline (Android parity:
// ResourceInvalidationsTest.kt). Pure module, no mocks required.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  bookResource, BOOK_RESOURCE_PREFIX, emitExternal, emitLocal,
  onResourceInvalidated, type ResourceInvalidationEvent,
} from './resourceInvalidations';

describe('resourceInvalidations bus', () => {
  const received: ResourceInvalidationEvent[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    received.length = 0;
    unsub = onResourceInvalidated((e) => received.push(e));
  });
  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  it('delivers an EXTERNAL event with the scoped resource key', () => {
    emitExternal(bookResource('b1'));
    expect(received).toEqual([{ kind: 'EXTERNAL', resource: 'book:b1' }]);
  });

  it('delivers a LOCAL event preserving the kind', () => {
    emitLocal(bookResource('b2'));
    expect(received).toEqual([{ kind: 'LOCAL', resource: 'book:b2' }]);
  });

  it('rejects a blank resource key (no event emitted)', () => {
    emitExternal('');
    emitLocal('   ');
    expect(received).toEqual([]);
  });

  it(' unsubscribed listeners no longer receive events', () => {
    unsub?.();
    emitExternal(bookResource('b3'));
    expect(received).toEqual([]);
  });

  it('fan-outs one event to every subscriber', () => {
    const second: ResourceInvalidationEvent[] = [];
    const off = onResourceInvalidated((e) => second.push(e));
    emitExternal(bookResource('b4'));
    expect(received).toEqual(second);
    off();
  });

  it('bookResource key format is stable and prefixed', () => {
    expect(bookResource('abc123')).toBe('book:abc123');
    expect(bookResource('abc123').startsWith(BOOK_RESOURCE_PREFIX)).toBe(true);
  });

  it('does not swallow listener errors of other subscribers (dispatch continues)', () => {
    const err = vi.fn(() => { throw new Error('boom'); });
    const off = onResourceInvalidated(err);
    emitExternal(bookResource('b5'));
    expect(received.length).toBe(1);
    off();
  });
});

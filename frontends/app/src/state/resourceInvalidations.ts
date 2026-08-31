// Generic invalidation bus for book-scoped JSON resources — 1:1 contract with
// the Android pipeline (ResourceInvalidations.kt):
//
//     external data mutation → invalidation event → cache evict → re-fetch
//     → reactive UI update
//
// Motivating case: the AI Assistant applies patches to the book bundle
// server-side (POST /ai/chat → patches_applied); every surface holding book
// data (Edit tables, Navigator tree, Generator/assistant context bars) must
// re-read the canonical JSON instead of showing stale values. This is NOT a
// browser-reload substitute and not polling — events fire at mutation time.
//
// Listener-Set dispatch mirrors generateStore.onPlaybackPrepared (the
// SharedFlow equivalent). Two kinds, same semantics as Android:
//  - EXTERNAL — the resource changed outside this client's write path
//    (AI Assistant patch, another device). Screens re-read it.
//  - LOCAL — this client's own write (editor save, entity add/delete).
//    The initiating screen already re-fetched; the data layer uses it to
//    evict derived caches (playbackStore.invalidateBookContent).
export type ResourceInvalidationKind = 'EXTERNAL' | 'LOCAL';

export interface ResourceInvalidationEvent {
  kind: ResourceInvalidationKind;
  /** Logical resource key, e.g. "book:<bookId>" — not a file path. */
  resource: string;
}

/** Well-known resource keys (Android ResourceInvalidations.Keys parity). */
export const BOOK_RESOURCE_PREFIX = 'book:';
export function bookResource(bookId: string): string {
  return `${BOOK_RESOURCE_PREFIX}${bookId}`;
}

const listeners = new Set<(e: ResourceInvalidationEvent) => void>();

/** Subscribe to invalidation events; returns the unsubscribe function. */
export function onResourceInvalidated(
  fn: (e: ResourceInvalidationEvent) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(kind: ResourceInvalidationKind, resource: string): void {
  if (!resource.trim()) return; // blank keys are rejected (Android isBlank parity)
  const event: ResourceInvalidationEvent = { kind, resource };
  // Resilient dispatch: a throwing listener must not break the others or the
  // emitting code path (mirrors coroutine isolation — a faulty collector
  // never takes down the emitter).
  listeners.forEach((f) => {
    try {
      f(event);
    } catch (e) {
      console.error('[resourceInvalidations] listener failed', e);
    }
  });
}

/** The resource was mutated outside this client's write path. */
export function emitExternal(resource: string): void {
  emit('EXTERNAL', resource);
}

/** This client just mutated the resource through its own write path. */
export function emitLocal(resource: string): void {
  emit('LOCAL', resource);
}

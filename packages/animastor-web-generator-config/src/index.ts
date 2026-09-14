// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-config — public API entry point
// ═══════════════════════════════════════════════════════════════
//  Layer-config domain logic: load/persist book configuration
//  (audio/image/video/vbook toggles, analysis mode/parallelism)
//  and asset-state queries. Pure functions parameterized by
//  explicit ports — zero host reach.
//
//  Boundary rules (pinned by architecture guard):
//   - This package must NOT import host stores, api/client,
//     app/* (router/i18n/desktop/icons), pages, @preact/signals,
//     or any @animastor/* package.
//   - All host capabilities arrive as explicit port interfaces.
//   - Wire types are vendored locally (models.ts).
// ═══════════════════════════════════════════════════════════════

import type { LayerConfig, AssetsState } from './models';

export type { LayerConfig, AssetsState };

// ── Port interfaces ─────────────────────────────────────────

/** Read-only identity — the package reads bookId, never writes it. */
export interface IdentityPort {
  getBookId(): string;
}

/** JSON HTTP transport — the host provides the real fetch-based
 *  implementation; this package never imports api/client. */
export interface TransportPort {
  getJson<T>(path: string): Promise<T>;
  putJson<T>(path: string, body: unknown): Promise<T>;
}

// ── Pure functions ──────────────────────────────────────────

/**
 * Fetch the layer config for the current book from the server.
 * Returns the parsed config on success, or null if no book is open
 * or the request fails.
 *
 * The caller (host) is responsible for applying the returned values
 * to host-owned signals.
 */
export async function loadLayerConfig(
  identity: IdentityPort,
  transport: TransportPort,
): Promise<LayerConfig | null> {
  const bookId = identity.getBookId();
  if (!bookId) return null;
  try {
    return await transport.getJson<LayerConfig>(
      `/book/${encodeURIComponent(bookId)}/layer-config`,
    );
  } catch (e) {
    console.warn('loadLayerConfig failed:', (e as Error).message);
    return null;
  }
}

/**
 * Persist the given layer config to the server.
 * No-op if bookId is empty. Errors are logged and swallowed
 * (matching the previous host behavior).
 */
export async function persistLayerConfig(
  transport: TransportPort,
  bookId: string,
  config: {
    audio_enabled: boolean;
    image_enabled: boolean;
    video_enabled: boolean;
    vbook_enabled: boolean;
  },
): Promise<void> {
  if (!bookId) return;
  try {
    await transport.putJson(
      `/book/${encodeURIComponent(bookId)}/layer-config`,
      config,
    );
  } catch (e) {
    console.warn('persistLayerConfig failed:', (e as Error).message);
  }
}

/**
 * Fetch the asset state for the current book.
 * Returns the parsed response on success, or null if no book is open
 * or the request fails.
 */
export async function getAssetsState(
  identity: IdentityPort,
  transport: TransportPort,
): Promise<AssetsState | null> {
  const bookId = identity.getBookId();
  if (!bookId) return null;
  try {
    return await transport.getJson<AssetsState>(
      `/book/${encodeURIComponent(bookId)}/assets-state`,
    );
  } catch (e) {
    console.warn('getAssetsState failed:', (e as Error).message);
    return null;
  }
}

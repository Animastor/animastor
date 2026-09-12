// PlayerPorts — the complete host contract of the future
// @animastor/web-player package (docs/architecture/web-player-module-extraction-audit.md,
// Phase 1 prep: created in-app, BEFORE the physical package cut).
//
// Dependency direction (frozen by arch guards):
//
//   host app (main.tsx) ──composition──▶ app/playerAdapters.ts
//   app/playerAdapters.ts ──implements──▶ PlayerPorts (this file)
//   Player engine/page ──consumes ONLY──▶ PlayerPorts (+ package-internal modules)
//
// The Player contour (playbackStore / playbackGate / mediaCache / PlayPage)
// must never import generateStore / positionStore / resourceInvalidations /
// api/client / api/models / app/i18n / app/icons / app/desktop directly. The
// ONLY host-side place where those modules meet this contract is
// app/playerAdapters.ts. This file imports nothing but Preact types and the
// package-local vendored models — it is the future package's public surface.
//
// Port payload types are Player-local structural types (NOT imports of the
// host store types): the host adapter bridges them, and TypeScript rejects
// the adapter the moment a host store type drifts from this contract.

import type { Signal } from '@preact/signals';
import type { JSX } from 'preact';
import type { SceneRef } from './models';

// ── Port payload types (structural copies of the host shapes) ──────────────

/** Port payload type of the shared active position (host: state/positionStore.ActivePosition). */
export interface PlayerActivePosition {
  chapterId: string | null;
  sceneId: string | null;
  unitId: string | null;
  chunkId: string | null;
  unitIndex: number;
}

/**
 * Port payload type of the generation-completion event (host:
 * state/generateStore.PlaybackPrepared). Deliberately NOT narrowed — unlike
 * the Navigator's `{bookId, buildId}` copy, the engine consumes the FULL
 * payload (scene list, cover bitmap, soft-refresh flag).
 */
export interface PlaybackPreparedEvent {
  bookId: string;
  buildId: string;
  scenes: SceneRef[];
  coverImage?: Blob;
  softRefresh?: boolean;
}

/** Port payload type of the invalidation event (host: state/resourceInvalidations). */
export interface PlayerResourceInvalidationEvent {
  kind: 'EXTERNAL' | 'LOCAL';
  /** Logical resource key, e.g. "book:<bookId>" — not a file path. */
  resource: string;
}

/** i18n keys the Play surface needs (the dictionary stays host-owned). */
export type PlayerI18nKey =
  | 'play_placeholder'
  | 'play_placeholder_no_generation'
  | 'play_loading'
  | 'play_ready'
  | 'play_playing'
  | 'play_paused'
  | 'play_play'
  | 'play_pause'
  | 'play_fullscreen'
  | 'play_generate_hint'
  | 'layer_audio'
  | 'layer_image'
  | 'layer_video'
  | 'layer_subtitles'
  | 'iu_not_generated'
  | 'empty_state'
  | 'empty_state_book_loaded';

export type PlayerT = (key: PlayerI18nKey, fallback?: string) => string;

/** Icon component props (the SVG kit stays host-owned). */
export type PlayerIconProps = JSX.SVGAttributes<SVGSVGElement>;

export type PlayerIconComponent = (props: PlayerIconProps) => JSX.Element;

// ── Ports ──────────────────────────────────────────────────────────────────

/**
 * SessionPort — the shared session identity. The signals are the HOST
 * SINGLETONS (generateStore.bookId/buildId) passed by reference, never copied:
 * the engine keeps its internal projection (set by preparePlayback), but the
 * Play surface and any future package code read the identity ONLY here —
 * the package must not become a second public source of truth for it.
 */
export interface PlayerSessionPort {
  readonly bookId: Signal<string>;
  readonly buildId: Signal<string>;
}

/**
 * GenerationPort — generation completion (host: generateStore.onPlaybackPrepared).
 * The surviving half of the dissolved generateStore ⇄ playbackStore cycle,
 * inverted into a port: the engine subscribes through this seam only.
 */
export interface PlayerGenerationPort {
  onPlaybackPrepared(fn: (prep: PlaybackPreparedEvent) => void): () => void;
}

/**
 * PositionPort — the shared active position (host: positionStore). WRITE
 * direction: the engine advances the position on every scene/unit transition
 * (the inverse of the Navigator's read-direction port).
 */
export interface PlayerPositionPort {
  navigateTo(p: Partial<PlayerActivePosition>): void;
}

/**
 * InvalidationsPort — the shared freshness bus (host: resourceInvalidations).
 * The engine is a pure consumer: book-bundle invalidations evict the player's
 * JSON-derived scene cache.
 */
export interface PlayerInvalidationsPort {
  onResourceInvalidated(fn: (e: PlayerResourceInvalidationEvent) => void): () => void;
  /** True for book-scoped resources ("book:*") — host keeps the key grammar. */
  isBookResource(resource: string): boolean;
}

/**
 * HttpPort — api/client stays host. NOTE videoUrl: the engine builds the
 * direct <video> src (base + scene path, progressive Range streaming) — the
 * base-URL assumption must go through the port (mediaUrl precedent), never a
 * local API_BASE reach.
 */
export interface PlayerHttpPort {
  getJson<T>(path: string): Promise<T>;
  getBlob(path: string): Promise<Blob>;
  retryWithBackoff<T>(fn: () => Promise<T>, attempts?: number, minMs?: number, maxMs?: number): Promise<T>;
  videoUrl(path: string): string;
}

/** ShellModePort — the desktop/mobile fork (host: app/desktop, matchMedia 1180px). */
export interface PlayerShellModePort {
  /** Called during the Play surface's render; the host implementation stays live-reactive to the shell breakpoint. */
  isDesktop(): boolean;
}

/** I18nPort — app/i18n stays host (typed key union, FilePorts precedent). */
export interface PlayerI18nPort {
  t: PlayerT;
}

/** IconsPort — app/icons stays host (12 icons used by the Play surface). */
export interface PlayerIconsPort {
  Play(props: PlayerIconProps): JSX.Element;
  Pause(props: PlayerIconProps): JSX.Element;
  VolumeUp(props: PlayerIconProps): JSX.Element;
  VolumeOff(props: PlayerIconProps): JSX.Element;
  Image(props: PlayerIconProps): JSX.Element;
  ImageOff(props: PlayerIconProps): JSX.Element;
  Videocam(props: PlayerIconProps): JSX.Element;
  VideocamOff(props: PlayerIconProps): JSX.Element;
  Subtitles(props: PlayerIconProps): JSX.Element;
  SubtitlesOff(props: PlayerIconProps): JSX.Element;
  Fullscreen(props: PlayerIconProps): JSX.Element;
  FullscreenExit(props: PlayerIconProps): JSX.Element;
}

/** The complete host contract consumed by the Player engine + Play surface. */
export interface PlayerPorts {
  session: PlayerSessionPort;
  generation: PlayerGenerationPort;
  position: PlayerPositionPort;
  invalidations: PlayerInvalidationsPort;
  http: PlayerHttpPort;
  shellMode: PlayerShellModePort;
  i18n: PlayerI18nPort;
  icons: PlayerIconsPort;
}

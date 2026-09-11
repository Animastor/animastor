// NavigatorPorts — the complete host contract of the @animastor/web-navigator
// package (docs/architecture/navigator-module-extraction-audit.md).
//
// Dependency direction (frozen by arch guards):
//
//   host app (main.tsx / AppShell.tsx) ──composition──▶ app/navigatorAdapters.ts
//   app/navigatorAdapters.ts ──implements──▶ NavigatorPorts (this file)
//   Navigator surface ──consumes ONLY──▶ NavigatorPorts
//
// The Navigator must never import generateStore / playbackStore / positionStore /
// resourceInvalidations / resilientReloader / AppShell / api/client / app/i18n /
// app/icons / app/router / app/desktop directly. The ONLY host-side place where
// those modules meet this contract is app/navigatorAdapters.ts. This file imports
// nothing but Preact types — it is the package's public surface.
//
// Port payload types are Navigator-local structural types (NOT imports of the
// host store types): the host adapter bridges them, and TypeScript rejects the
// adapter the moment a host store type drifts from this contract.

import type { Signal } from '@preact/signals';
import type { JSX } from 'preact';

/** Port payload type of the shared position (host: state/positionStore — the SharedPositionManager stays host). */
export interface ActivePosition {
  chapterId: string | null;
  sceneId: string | null;
  unitId: string | null;
  chunkId: string | null;
  unitIndex: number;
}

/** Port payload type of the generation-completion event (host: state/generateStore.onPlaybackPrepared). */
export interface PlaybackPreparedEvent {
  bookId: string;
  buildId: string;
}

/** Port payload type of the invalidation event (host: state/resourceInvalidations). */
export interface ResourceInvalidationEvent {
  kind: 'EXTERNAL' | 'LOCAL';
  resource: string;
}

/** Port payload type of the connectivity recovery signal (host: state/resilientReloader). */
export interface NetworkRecoverySignal {
  readonly isOnline: boolean;
  onNextRestore(fn: () => void): () => void;
}

/** Port payload type of the reload result (host: state/resilientReloader.ReloadResult). */
export type ReloadResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'transient-failure'; attempts: number; cause: unknown }
  | { kind: 'permanent-failure'; cause: unknown };

/** i18n keys the Navigator surface needs (the dictionary stays host-owned). */
export type NavigatorI18nKey =
  | 'navigate_cover'
  | 'navigate_prologue'
  | 'navigate_chapter'
  | 'navigate_scene'
  | 'navigate_scene_type'
  | 'navigate_unit'
  | 'navigate_no_position'
  | 'navigate_empty'
  | 'navigate_open_in_player';

export type NavigatorT = (key: NavigatorI18nKey) => string;

/** Icon component props (the SVG kit stays host-owned). */
export type NavigatorIconProps = JSX.SVGAttributes<SVGSVGElement>;

// ── Ports ────────────────────────────────────────────────────────────────

/** SeekPort — the Player seam (extraction blocker N1). The playbackStore stays host. */
export interface SeekPort {
  /** External seek, 1:1 with playbackStore.seekToPosition (same async/error semantics). */
  seekToPosition(chapterId: string, sceneId: string, unitIndex: number, unitId: string | null): Promise<void>;
}

/** BookSourcePort — session identity + generation completion (blocker N2). generateStore stays host; bookId/buildId remain the host app's single source of truth. */
export interface BookSourcePort {
  readonly bookId: Signal<string>;
  readonly buildId: Signal<string>;
  /** Subscribe to generation completion; returns the unsubscribe function. */
  onPlaybackPrepared(fn: (prep: PlaybackPreparedEvent) => void): () => void;
}

/** PositionPort — the shared navigation state (blocker N3). positionStore stays host; the Navigator must not fork it. */
export interface PositionPort {
  readonly position: Signal<ActivePosition>;
  navigateTo(p: Partial<ActivePosition>): void;
}

/** Invalidation boundary — the shared freshness bus stays host; the Navigator is a pure consumer. */
export interface InvalidationPort {
  onResourceInvalidated(fn: (e: ResourceInvalidationEvent) => void): () => void;
  bookResource(bookId: string): string;
}

/** Reload boundary — the bounded backoff/recovery pipeline stays host. */
export interface ReloadPort {
  resilientReload<T>(opts: { recovery: NetworkRecoverySignal; attempt: () => Promise<T> }): Promise<ReloadResult<T>>;
  sharedRecovery(): NetworkRecoverySignal;
}

/** ShellModePort — the desktop/mobile behavioral fork made explicit (blocker N5). The matchMedia query stays host. */
export interface ShellModePort {
  /** Called during the Navigator's render; the host implementation stays live-reactive to the shell breakpoint (min-width: 1180px). */
  isDesktop(): boolean;
}

/** NavigationPort — the router stays host-owned; /play route knowledge stays in the shell. */
export interface NavigationPort {
  navigateToPlay(): void;
}

/** HttpPort — api/client stays host; the preview URL grammar must go through mediaUrl, never a local base. */
export interface HttpPort {
  getJson<T>(path: string): Promise<T>;
  mediaUrl(path: string): string;
}

/** I18nPort — app/i18n stays host. */
export interface I18nPort {
  t: NavigatorT;
}

/** UI-kit adapter — app/icons stays host. */
export interface IconsPort {
  Play(props: NavigatorIconProps): JSX.Element;
  ImageOff(props: NavigatorIconProps): JSX.Element;
}

/** The complete host contract consumed by the Navigator surface. */
export interface NavigatorPorts {
  seek: SeekPort;
  bookSource: BookSourcePort;
  position: PositionPort;
  invalidations: InvalidationPort;
  reload: ReloadPort;
  shellMode: ShellModePort;
  navigation: NavigationPort;
  http: HttpPort;
  i18n: I18nPort;
  icons: IconsPort;
}

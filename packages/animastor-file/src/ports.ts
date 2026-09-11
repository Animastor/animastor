// FilePorts — the complete host contract of the @animastor/web-file package
// (docs/architecture/file-module-extraction-audit.md, Phase 1 prep).
//
// Dependency direction (frozen by arch guards):
//
//   host app (main.tsx / AppShell.tsx) ──composition──▶ app/fileAdapters.ts
//   app/fileAdapters.ts ──implements──▶ FilePorts (this file)
//   File surface ──consumes ONLY──▶ FilePorts
//
// The File page must never import generateStore / api/client / app/i18n /
// app/router / app/icons / lib/ui / app/desktop / AppShell directly. The ONLY
// host-side place where those modules meet this contract is app/fileAdapters.ts.
// This file imports nothing but Preact types — it is the future package's
// public surface, kept in-app until the physical cut of @animastor/web-file.
//
// Port payload types are File-local structural types (NOT imports of the host
// store types): the host adapter bridges them, and TypeScript rejects the
// adapter the moment a host store type drifts from this contract.
//
// These ports are NOT a mechanical copy of NavigatorPorts — they mirror the
// measured dependencies of FilePage (audit Phase 1): no seek, no position, no
// invalidation/reload reach from the page level; the import/open/create flows
// reach them inside the File slice (host store until extraction B1).

import type { Signal } from '@preact/signals';
import type { JSX } from 'preact';

// ── Structural payload types (host adapters bridge to the real stores) ──

/** Port payload type of the shared generation/book phase (host: generateStore.PlayerPhase). */
export type FilePhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

/** Port payload type of the one-shot navigation handshake (audit hidden dep #2). */
export type FileNavigationEvent = 'play' | 'generate' | null;

/** Routes the File surface is allowed to request (route table stays host-owned). */
export type FileRoute = '/play' | '/generate' | '/edit' | '/library';

/** Export types offered by the download section (1:1 with FileFragment). */
export type FileExportType = 'book' | 'storyboard' | 'audio' | 'video';

/** i18n keys the File surface needs (the dictionary stays host-owned). */
export type FileI18nKey =
  | 'file_status_opening' | 'file_status_generating' | 'file_status_checking'
  | 'file_from_device' | 'file_from_device_desc'
  | 'file_create' | 'file_create_desc'
  | 'library_button' | 'empty_state'
  | 'download_section'
  | 'download_book' | 'download_book_desc'
  | 'download_storyboard' | 'download_storyboard_desc'
  | 'download_audio' | 'download_audio_desc'
  | 'download_video' | 'download_video_desc'
  | 'export_preparing' | 'export_preparing_storyboard'
  | 'export_merging_audio' | 'export_merging_video'
  | 'export_progress' | 'export_saved'
  | 'download_failed';

/** Icon component props (the SVG kit stays host-owned). */
export type FileIconProps = JSX.SVGAttributes<SVGSVGElement>;

export type FileIconComponent = (props: FileIconProps) => JSX.Element;

// ── Ports ────────────────────────────────────────────────────────────────

/**
 * FileSessionPort — the shared book-session identity + File screen state.
 *
 * `bookId`/`buildId`/`phase` stay the HOST's single source of truth (audit B6:
 * shared with Generate/Play/Edit/AppShell bounce) — they are received as
 * signals, never copied. `navigationEvent` is the one-shot handshake: the File
 * surface consumes AND resets it (Android hasSwitchedToPlay guard parity).
 */
export interface FileSessionPort {
  readonly bookId: Signal<string>;
  readonly buildId: Signal<string>;
  readonly phase: Signal<FilePhase>;
  readonly errorMessage: Signal<string | null>;
  readonly importMessages: Signal<string[]>;
  readonly isExporting: Signal<boolean>;
  readonly navigationEvent: Signal<FileNavigationEvent>;
}

/**
 * FileActionsPort — the File slice operations (import/open/create/close + export
 * bookkeeping). Hosted in generateStore until the slice split (audit blocker B1);
 * the package cannot reach the host store, so these are injected.
 */
export interface FileActionsPort {
  importBookFromFile(file: File): Promise<void>;
  openBookById(param: string): Promise<void>;
  closeBook(): void;
  createBlankBook(): Promise<string | null>;
  setExporting(v: boolean): void;
  setExportProgress(v: number): void;
}

/** FileHttpPort — api/client stays host; the download path grammar stays in the page. */
export interface FileHttpPort {
  getBlob(path: string, onProgress?: (progress: number) => void): Promise<Blob>;
}

/** FileI18nPort — app/i18n stays host. */
export interface FileI18nPort {
  t(key: FileI18nKey, fallback?: string): string;
  tf(key: FileI18nKey, ...args: (string | number)[]): string;
}

/** FileToastPort — lib/ui toast stays host. */
export interface FileToastPort {
  toast(message: string, durationMs?: number): void;
}

/** FileNavigationPort — the router stays host-owned; File may only ask for these four routes. */
export interface FileNavigationPort {
  navigate(route: FileRoute): void;
}

/**
 * FileOpenRequestPort — the AppShell desktop "Open" entry made explicit.
 * Host implementation: the shell's window CustomEvent (see OPEN_FILE_EVENT in
 * app/fileAdapters.ts — audit hidden dep #1, now a frozen, documented port
 * instead of a page-level window listener).
 */
export interface FileOpenRequestPort {
  /** Subscribe to open requests; returns the unsubscribe function. */
  onOpenRequest(fn: () => void): () => void;
}

/**
 * FileDeepLinkPort — the `?book=` / `?open=` deep-link URL contract
 * (audit hidden dep #3). The host adapter reads and strips the param; the File
 * surface only learns whether an open was requested (Android ACTION_VIEW parity).
 */
export interface FileDeepLinkPort {
  /** Consume the deep-link book id once (reads `?book=`/`?open=`, strips it from the URL). */
  takeBookParam(): string | null;
}

/** FileIconsPort — app/icons stays host. */
export interface FileIconsPort {
  Folder: FileIconComponent;
  Add: FileIconComponent;
  Library: FileIconComponent;
  Download: FileIconComponent;
  Image: FileIconComponent;
  VolumeUp: FileIconComponent;
  Video: FileIconComponent;
}

/** The complete host contract consumed by the File surface. */
export interface FilePorts {
  session: FileSessionPort;
  actions: FileActionsPort;
  http: FileHttpPort;
  i18n: FileI18nPort;
  toast: FileToastPort;
  navigation: FileNavigationPort;
  openRequests: FileOpenRequestPort;
  deepLink: FileDeepLinkPort;
  icons: FileIconsPort;
}

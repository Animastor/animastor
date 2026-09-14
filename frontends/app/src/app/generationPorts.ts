// ═══════════════════════════════════════════════════════════════
//  GenerationPorts — boundary interfaces for future orchestration
// ═══════════════════════════════════════════════════════════════
//  Step 4 of the web-generator extraction audit
//  (docs/architecture/web-generator-extraction-audit.md §13).
//
//  These interfaces define the MINIMAL capabilities that a future
//  generation-orchestration package would need from the host.
//  They are design-only — no production code depends on them yet.
//
//  Dependency rules (frozen by architecture guard):
//   - This file must NOT import @preact/signals, api/client,
//     state/* stores, pages, or any @animastor/* package.
//   - Future orchestration imports THIS file (ports), not generateStore.
//   - generateStore does NOT import this file (host provides the
//     implementation, does not depend on the port contract).
//   - The dependency direction is:
//       host (generateStore) ──implements──▶ ports
//       orchestration        ──depends on──▶ ports
// ═══════════════════════════════════════════════════════════════

// ── Identity (read-only for orchestration) ──────────────────

/** Orchestration reads identity but never writes it.
 *  bookId/buildId are host-owned signals — the port exposes plain
 *  getters so the orchestration package has zero signal dependency. */
export interface GenerationIdentityPort {
  /** Current open book (empty string = no book). */
  getBookId(): string;
  /** Current build id (empty string = no build yet). */
  getBuildId(): string;
}

// ── Transport ───────────────────────────────────────────────

/** JSON HTTP transport — orchestration makes API calls through this
 *  port. The host provides the real fetch-based implementation;
 *  orchestration never imports api/client. */
export interface GenerationTransportPort {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body?: unknown): Promise<T>;
  postJsonLong<T>(path: string, body?: unknown): Promise<T>;
  putJson<T>(path: string, body: unknown): Promise<T>;
}

/** SSE stream — the host owns the AbortController, reconnection
 *  loop, and epoch guard. Orchestration receives parsed events. */
export interface GenerationSsePort {
  /** Start a progress SSE stream. Returns an async iterator of
   *  raw event data strings. The host manages reconnect. */
  startStream(bookId: string): AsyncIterable<string>;
  /** Abort the current stream (cancel / book close). */
  stopStream(): void;
}

// ── Navigation (write direction only) ───────────────────────

/** Orchestration anchors position after generation completes.
 *  The host owns positionStore; orchestration calls navigateTo
 *  through this port. Orchestration does NOT read position —
 *  the "if no position, anchor at first scene" logic stays
 *  host-side in applyGenerationResults. */
export interface GenerationNavigationPort {
  navigateTo(p: {
    chapterId: string | null;
    sceneId: string | null;
    unitId: null;
    chunkId: null;
    unitIndex: number;
  }): void;
}

// ── Playback event (fire-and-forget) ────────────────────────

/** Orchestration emits generation-completion events through this
 *  port. The host wires it to the onPlaybackPrepared bus.
 *  Orchestration does NOT subscribe — that's the Player's job
 *  via PlayerPorts.generation. */
export interface GenerationPlaybackPort {
  emitPlaybackPrepared(prep: {
    bookId: string;
    buildId: string;
    scenes: unknown[];
    softRefresh?: boolean;
  }): void;
}

// ── State callbacks (host-owned signal writes) ──────────────

/** Orchestration updates generation state through these callbacks.
 *  Each callback writes to a host-owned signal; orchestration never
 *  holds signal references.
 *
 *  These are intentionally narrow — orchestration can setPhase but
 *  cannot read it; can setErrorMessage but cannot read it. The host
 *  decides how to expose the values to UI. */
export interface GenerationStatePort {
  setPhase(phase: string): void;
  setErrorMessage(msg: string | null): void;
  setGenerationStatus(status: 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS'): void;
  setIsRegenerating(v: boolean): void;
  setBuildId(buildId: string): void;
  setDirtySummary(summary: unknown): void;
}

// ── Layer config (read + write through port) ────────────────

/** Orchestration reads/writes layer config through these callbacks
 *  rather than directly touching host signals. */
export interface GenerationConfigPort {
  setAudioEnabled(v: boolean): void;
  setImageEnabled(v: boolean): void;
  setVideoEnabled(v: boolean): void;
  setVBookEnabled(v: boolean): void;
  setAnalysisMode(mode: 'sequential' | 'parallel'): void;
  setAnalysisParallelism(n: number): void;
  setLayerConfigLoaded(v: boolean): void;
  setAnalysisConfigLoaded(v: boolean): void;
}

// ── Progress / session management ───────────────────────────

/** Orchestration resets generation tracking through these callbacks.
 *  The host owns progressTracking / generationTimer state objects. */
export interface GenerationProgressPort {
  resetProgressState(): void;
  clearVBookProgress(): void;
  bumpVBookPollToken(): void;
  markImportIncomplete(): void;
  stopGenerationSession(): void;
}

// ═══════════════════════════════════════════════════════════════
//  Composite port (optional — orchestration can use individual
//  ports or this bundle, depending on the extraction shape).
// ═══════════════════════════════════════════════════════════════

export interface GenerationPorts {
  identity: GenerationIdentityPort;
  transport: GenerationTransportPort;
  sse: GenerationSsePort;
  navigation: GenerationNavigationPort;
  playback: GenerationPlaybackPort;
  state: GenerationStatePort;
  config: GenerationConfigPort;
  progress: GenerationProgressPort;
}

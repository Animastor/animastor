// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-vbook — public API entry point
// ═══════════════════════════════════════════════════════════════
//  VBook agent lifecycle orchestration (web-generator-extraction-audit
//  §17.3, Step 9). This package owns the REAL orchestration decisions:
//
//   - checkAgentStatus: one /agent-status poll + agent→progress merge +
//     ANALYZING/CREATING_SCENES→COMPLETED finalization classification
//   - startVBookGeneration: bootstrap-vs-bootstrap-next-window decision,
//     long-timeout POST, poll kick, abort reconciliation with /agent-status
//   - pollVBookProgress: 2s poll loop — inactive×2 finalization, `paused`
//     finalization with the real window counter, 60min safety cap +
//     agent re-probe, SUCCESS handoff to the host via onGenerationFinalized
//   - updateVBookProgress: agent-status → structured VBookProgress merge
//
//  Architecture boundary:
//    host generateStore → provides capabilities/state callbacks →
//    @animastor/web-generator-vbook → returns orchestration decisions/
//    results → host applies host-owned navigation/playback/state.
//
//  The host owns (and this package never touches):
//   - generateStore / api/client / authStore / fileStore / playbackStore /
//     positionStore / app/* / pages/* / @preact/signals
//   - vbookProgress signal (written through the setVBookProgress callback)
//   - poll-token authority (VBookPollState is host-owned, passed by
//     reference — bumping it from the host cancels stale polls)
//   - timer ownership (startTimer/stopTimer callbacks)
//   - SSE AbortController/epoch lifecycle (the startStream callback is
//     the host's startProgressStream; no SSE implementation here)
//   - applyGenerationResults (arrives as the onGenerationFinalized
//     callback — fetch/extract final book state, position/anchor checks,
//     navigation decisions, playback notification all stay host-side)
//
//  Dependency rules (pinned by architecture guard):
//   - This package imports ONLY @animastor/web-generator (for
//     applyAgentStatus, createAnalyzingVBookProgress, types).
//   - Transport only through the injected VBookTransportPort.
//   - Identity only through the injected VBookIdentityPort (getBookId).
//   - No module-global mutable state — all mutable state is explicit
//     (VBookPollState / VBookPollContract), owned by the host.
// ═══════════════════════════════════════════════════════════════

import {
  applyAgentStatus,
  createAnalyzingVBookProgress,
} from '@animastor/web-generator';
import type { AgentStatusLike, VBookProgress } from '@animastor/web-generator';

import type { AgentStatusWire, BookStatusWire } from './models';

// Re-export for host convenience — generateStore re-exports the type
// surface for GeneratePage; the factory travels with this slice now.
export type { AgentStatusLike, VBookProgress } from '@animastor/web-generator';
export type { AgentStatusWire, BookStatusWire } from './models';

// ── Ports ────────────────────────────────────────────────────

/** Identity capability — the ONLY way this package learns bookId.
 *  The host binds `getBookId: () => bookId.value`. */
export interface VBookIdentityPort {
  getBookId(): string;
}

/** HTTP transport capability — GET for agent status/book status,
 *  POST long-running for the blocking bootstrap routes. The host
 *  binds api/client's getJson/postJsonLong; this package never
 *  imports the API client. */
export interface VBookTransportPort {
  getJson<T>(path: string): Promise<T>;
  postJsonLong<T>(path: string, body?: unknown): Promise<T>;
}

// ── Explicit poll state ──────────────────────────────────────

/** Host-owned poll-session state object. Replaces the module-scope
 *  `vbookPollToken` let in generateStore: the host owns ONE instance
 *  and passes it by reference. Bumping `token` (host-side via
 *  bumpVBookPollToken / stopGenerationSession / cancelTask) invalidates
 *  every in-flight poll started with an older token — stale polling
 *  stops safely on the next token check. */
export interface VBookPollState {
  token: number;
}

export function createVBookPollState(): VBookPollState {
  return { token: 0 };
}

/** Read-side view of the poll state the loops check against. Hosts that
 *  prefer callbacks over shared-object mutation can implement this with
 *  `getPollToken: () => vbookPoll.token` — same contract. */
export interface VBookPollContract {
  getPollToken(): number;
  bumpPollToken(): number;
}

// ── Host state callbacks ─────────────────────────────────────

/** Host-owned generation-state surface. The package decides WHEN and
 *  WHAT; the host decides how each write lands (signals, nav-icon pulse
 *  machinery, etc.). Reads are equally explicit — isRegenerating gates
 *  the shared wall-clock timer stop, importCompleteReceived is the SSE
 *  import handshake latch the host owns. */
export interface VBookHostState {
  /** Read current VBookProgress (the package merges into it). */
  getVBookProgress(): VBookProgress;
  /** Write current VBookProgress. */
  setVBookProgress(p: VBookProgress): void;
  /** Set nav-icon generation status (host owns pulse/reset machinery). */
  setGenerationStatus(status: 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS'): void;
  /** Read isRegenerating (VBook shares the generation session with the
   *  GPU stages — timer must not stop while other stages run). */
  getIsRegenerating(): boolean;
  /** Set isRegenerating. */
  setIsRegenerating(v: boolean): void;
  /** Set progressTracking.newGenerationPending (host-owned latch that
   *  gates the new-generation progress-row window). */
  setNewGenerationPending(v: boolean): void;
  /** Set progressTracking.importCompleteReceived (host-owned SSE
   *  import_complete latch — starts false per window). */
  setImportCompleteReceived(v: boolean): void;
  /** Read progressTracking.importCompleteReceived. */
  getImportCompleteReceived(): boolean;
}

/** Host-owned lifecycle hooks. Timer, SSE, and finalization stay
 *  host-side; the package invokes them at the right lifecycle points. */
export interface VBookLifecycleCallbacks {
  /** Start the shared wall-clock generation timer (host owns the
   *  GenerationTimerState instance). */
  startTimer(): void;
  /** Stop the shared wall-clock timer (only called when the VBook
   *  window truly finished and the session is not regenerating). */
  stopTimer(): void;
  /** Start the SSE progress stream for this book (host owns the
   *  AbortController/epoch — @animastor/web-generator-sse machinery;
   *  NOT re-implemented here). */
  startStream(bookId: string): void;
  /** Reset VBook progress to idle + clear the analysis rows (host
   *  signal writes — clearVBookProgress stays a host seam). */
  onVBookCleared(): void;
  /** Generation finalized successfully — the host continues with
   *  applyGenerationResults: fetch/extract final book state, position/
   *  anchor checks, navigation decisions, playback notification. The
   *  package holds no navigation/playback knowledge. */
  onGenerationFinalized(): void | Promise<void>;
}

/** Full capability bundle the host injects. */
export interface VBookAgentPorts {
  identity: VBookIdentityPort;
  transport: VBookTransportPort;
  poll: VBookPollContract;
  state: VBookHostState;
  lifecycle: VBookLifecycleCallbacks;
}

// ── Poll loop tuning (injectable for tests; production defaults) ──

export interface VBookPollConfig {
  /** Delay between agent-status polls (default 2000ms). */
  pollIntervalMs?: number;
  /** Delay after a failed poll (default 3000ms). */
  errorIntervalMs?: number;
  /** Consecutive inactive polls before finalization (default 2). */
  maxInactive?: number;
  /** Safety cap against a stuck backend — NOT a generation deadline
   *  (default 60min). */
  maxPollMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_ERROR_INTERVAL_MS = 3_000;
const DEFAULT_MAX_INACTIVE = 2;
const DEFAULT_MAX_POLL_MS = 60 * 60 * 1_000;

// ── updateVBookProgress ──────────────────────────────────────

/** Merge an /agent-status payload into the current VBookProgress (port
 *  of generateStore.updateVBookProgress — the pure mapping lives in
 *  @animastor/web-generator applyAgentStatus; this writes the result
 *  through the host callback). */
export function updateVBookProgress(
  state: VBookHostState,
  status: AgentStatusLike,
): void {
  state.setVBookProgress(applyAgentStatus(state.getVBookProgress(), status));
}

// ── checkAgentStatus ─────────────────────────────────────────

/** Poll /agent-status once and update VBookProgress (port of
 *  generateStore.checkVBookAgentStatus — the GeneratePage 1.5s panel
 *  poll calls this). Returns the resulting VBookProgress. Transport
 *  errors keep the current progress (the panel reconciles next tick). */
export async function checkAgentStatus(ports: VBookAgentPorts): Promise<VBookProgress> {
  const bid = ports.identity.getBookId();
  if (!bid) return ports.state.getVBookProgress();
  try {
    const status = await ports.transport.getJson<AgentStatusWire>(
      `/book/${encodeURIComponent(bid)}/agent-status`,
    );
    // 'paused' = the CURRENT window finished and the agent is idle,
    // waiting for the user to press "Генерировать далее" (manual
    // continuation) — that is a terminal state for this window, so it
    // counts as inactive and finalizes COMPLETED with the real window
    // counter (e.g. "3/3", not "1/1").
    if (status.active && status.progress_msg != null) {
      updateVBookProgress(ports.state, status);
    } else if (!status.active) {
      const current = ports.state.getVBookProgress();
      if (current.stage === 'ANALYZING' || current.stage === 'CREATING_SCENES') {
        // The agent just finished — re-read the now-saved window counters
        // (window_total_scenes from window_data) before marking COMPLETED,
        // so the final counter reflects the real window size (e.g. "3/3",
        // or "2/2" for a partial final window), not the mid-pipeline
        // estimate.
        if (status.progress_msg != null) updateVBookProgress(ports.state, status);
        ports.state.setVBookProgress({
          ...ports.state.getVBookProgress(),
          stage: 'COMPLETED',
        });
      }
    }
  } catch { /* keep current */ }
  return ports.state.getVBookProgress();
}

// ── pollVBookProgress ────────────────────────────────────────

/** 2s poll loop tracking the VBook agent to completion (port of
 *  generateStore.pollVBookProgress). Terminal classifications:
 *  import handshake complete → COMPLETED; `paused` window → COMPLETED
 *  with the real counter (never auto-advance); inactive×2 → COMPLETED;
 *  safety cap → probe the agent once, finalize only if it truly
 *  finished. On success: setGenerationStatus('SUCCESS'), stop the
 *  timer unless the session is still regenerating, and hand finalization
 *  to the host via onGenerationFinalized. Stale tokens (host bumped
 *  VBookPollState) return silently at every checkpoint. */
export async function pollVBookProgress(
  ports: VBookAgentPorts,
  bookId: string,
  token: number,
  config?: VBookPollConfig,
): Promise<void> {
  const pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const errorIntervalMs = config?.errorIntervalMs ?? DEFAULT_ERROR_INTERVAL_MS;
  const maxInactive = config?.maxInactive ?? DEFAULT_MAX_INACTIVE;
  const maxPollMs = config?.maxPollMs ?? DEFAULT_MAX_POLL_MS;

  let consecutiveInactive = 0;
  const startTime = Date.now();
  let safetyCapTripped = false;
  while (consecutiveInactive < maxInactive) {
    if (ports.poll.getPollToken() !== token) return;
    if (ports.state.getImportCompleteReceived()) {
      ports.state.setVBookProgress({
        ...ports.state.getVBookProgress(),
        stage: 'COMPLETED',
      });
      break;
    }
    if (Date.now() - startTime > maxPollMs) {
      safetyCapTripped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (ports.poll.getPollToken() !== token) return;
    try {
      const status = await ports.transport.getJson<AgentStatusWire>(
        `/book/${encodeURIComponent(bookId)}/agent-status`,
      );
      // 'paused' = the current window is complete; the agent is idle,
      // waiting for the user to press "Генерировать далее" (manual
      // continuation — one window per click). Finalize this window
      // immediately with the real counter (e.g. "3/3") — never
      // auto-advance to the next window.
      if (status.session_status === 'paused') {
        if (status.progress_msg != null) updateVBookProgress(ports.state, status);
        ports.state.setVBookProgress({
          ...ports.state.getVBookProgress(),
          stage: 'COMPLETED',
        });
        break;
      }
      if (status.active && status.progress_msg != null) {
        consecutiveInactive = 0;
        updateVBookProgress(ports.state, status);
      } else if (!status.active) {
        consecutiveInactive++;
        if (status.progress_msg != null) updateVBookProgress(ports.state, status);
        if (consecutiveInactive >= maxInactive) {
          ports.state.setVBookProgress({
            ...ports.state.getVBookProgress(),
            stage: 'COMPLETED',
          });
        }
      } else {
        consecutiveInactive = 0;
      }
    } catch {
      consecutiveInactive++;
      await new Promise((r) => setTimeout(r, errorIntervalMs));
    }
  }
  if (ports.poll.getPollToken() !== token) return;
  // If the safety cap tripped, probe the real agent state before
  // deciding: a still-running agent must NOT be finalised (SUCCESS +
  // stopTimer would freeze the timer mid-generation) — the host's 1.5s
  // panel poll + checkAgentStatus keep tracking it. But if the agent
  // actually finished (backend stuck reporting active), finalise
  // normally so the generation is not left dangling.
  if (safetyCapTripped) {
    console.warn('pollVBookProgress: safety cap reached — probing agent state');
    try {
      const status = await ports.transport.getJson<{ active: boolean }>(
        `/book/${encodeURIComponent(bookId)}/agent-status`,
      );
      if (!status.active) {
        ports.state.setVBookProgress({
          ...ports.state.getVBookProgress(),
          stage: 'COMPLETED',
        });
        ports.state.setGenerationStatus('SUCCESS');
        if (!ports.state.getIsRegenerating()) ports.lifecycle.stopTimer();
        await ports.lifecycle.onGenerationFinalized();
        return;
      }
    } catch { /* leave UI alive */ }
    console.warn('pollVBookProgress: agent still active after safety cap — leaving UI alive');
    return;
  }
  ports.state.setGenerationStatus('SUCCESS');
  if (!ports.state.getIsRegenerating()) ports.lifecycle.stopTimer();
  await ports.lifecycle.onGenerationFinalized();
}

// ── startVBookGeneration ─────────────────────────────────────

/** Start VBook AI-agent generation (port of generateStore.startVBookGeneration):
 *  bootstrap / bootstrap-next-window + poll. The bootstrap-vs-next-window
 *  decision reads `/book/:id/status` once; both routes POST with the long
 *  timeout (they block for the whole AI window — minutes). On transport
 *  failure the loop reconciles with /agent-status: a still-running (or
 *  paused) agent keeps the progress UI + timer alive and is tracked to
 *  completion; a genuinely dead session tears the progress down. */
export async function startVBookGeneration(
  ports: VBookAgentPorts,
  config?: VBookPollConfig,
): Promise<void> {
  const bid = ports.identity.getBookId();
  if (!bid) return;
  ports.state.setGenerationStatus('RUNNING');
  // VBook is part of the same generation session as the GPU stages — mark
  // the session regenerating (mirrors startGeneration) so the shared
  // wall-clock timer is NOT stopped when the VBook agent finishes while
  // audio/image/video stages are still running (Android GenerateViewModel
  // fix, 1:1 parity).
  ports.state.setIsRegenerating(true);
  ports.state.setNewGenerationPending(true);
  ports.state.setVBookProgress(createAnalyzingVBookProgress());
  // Manual per-window mode: one click = one window = one generation. The
  // timer always starts fresh for the new window (no survival across
  // windows); the previous window's finalise already stopped it.
  ports.lifecycle.startTimer();
  ports.lifecycle.startStream(bid);
  ports.state.setImportCompleteReceived(false);
  const token = ports.poll.bumpPollToken();
  try {
    const status = await ports.transport
      .getJson<BookStatusWire>(`/book/${encodeURIComponent(bid)}/status`)
      .catch(() => null);
    const needsBootstrap = status?.ready !== true;
    if (needsBootstrap) {
      await ports.transport.postJsonLong(`/book/${encodeURIComponent(bid)}/bootstrap`);
    } else {
      await ports.transport.postJsonLong(`/book/${encodeURIComponent(bid)}/bootstrap-next-window`);
    }
    await pollVBookProgress(ports, bid, token, config);
  } catch (e) {
    if (ports.poll.getPollToken() !== token) return;
    console.warn('startVBookGeneration failed:', (e as Error).message);
    // A client-side abort (timeout/network blip) does NOT stop the backend
    // agent — the bootstrap route keeps processing the window. Before
    // tearing the progress UI down, reconcile with the real agent state:
    // if it is still running, keep the block + timer alive and let the
    // poller track it to completion. Only tear down on a genuine failure
    // (no active session).
    try {
      const status = await ports.transport.getJson<{ active: boolean; session_status?: string | null }>(
        `/book/${encodeURIComponent(bid)}/agent-status`,
      );
      // Keep the UI alive if the agent is still running, or if the window
      // already finished (paused) — pollVBookProgress finalizes a paused
      // window immediately with the real counter (green "3/3").
      if (status.active || status.session_status === 'paused') {
        await pollVBookProgress(ports, bid, token, config);
        return;
      }
    } catch { /* agent-status unavailable — fall through to teardown */ }
    ports.lifecycle.onVBookCleared();
    ports.lifecycle.stopTimer();
  }
}

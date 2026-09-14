// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-vbook — unit tests
// ═══════════════════════════════════════════════════════════════
//  All host capabilities are mocked: identity getter, HTTP transport,
//  poll state, state callbacks, lifecycle callbacks. Zero host
//  imports — the architecture guard test pins that separately.

import { describe, it, expect, vi } from 'vitest';
import {
  checkAgentStatus,
  createVBookPollState,
  pollVBookProgress,
  startVBookGeneration,
  updateVBookProgress,
} from '../src/index';
import type { VBookAgentPorts, VBookHostState, VBookPollContract } from '../src/index';
import type { AgentStatusWire } from '../src/index';
import {
  createAnalyzingVBookProgress,
  createIdleVBookProgress,
} from '@animastor/web-generator';
import type { AgentStatusLike, VBookProgress } from '@animastor/web-generator';

// ── Harness ─────────────────────────────────────────────────

interface Recording {
  status: ('IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS')[];
  vbookProgressWrites: VBookProgress[];
  isRegenerating: boolean;
  newGenerationPending: boolean | null;
  importCompleteReceived: boolean;
  timerStarts: number;
  timerStops: number;
  streamStarts: string[];
  clears: number;
  finalized: number;
}

function makeRecording(): Recording {
  return {
    status: [],
    vbookProgressWrites: [],
    isRegenerating: false,
    newGenerationPending: null,
    importCompleteReceived: false,
    timerStarts: 0,
    timerStops: 0,
    streamStarts: [],
    clears: 0,
    finalized: 0,
  };
}

/** Mock port bundle. transport.getJson is a vi.fn the test programs. */
function makePorts(
  recording: Recording,
  getBookId: () => string = () => 'book-1',
): { ports: VBookAgentPorts; transport: { getJson: ReturnType<typeof vi.fn>; postJsonLong: ReturnType<typeof vi.fn> }; pollState: { token: number } } {
  let vbookProgress = createIdleVBookProgress();
  const pollState = { token: 0 };

  const state: VBookHostState = {
    getVBookProgress: () => vbookProgress,
    setVBookProgress: (p) => {
      vbookProgress = p;
      recording.vbookProgressWrites.push(p);
    },
    setGenerationStatus: (s) => { recording.status.push(s); },
    getIsRegenerating: () => recording.isRegenerating,
    setIsRegenerating: (v) => { recording.isRegenerating = v; },
    setNewGenerationPending: (v) => { recording.newGenerationPending = v; },
    setImportCompleteReceived: (v) => { recording.importCompleteReceived = v; },
    getImportCompleteReceived: () => recording.importCompleteReceived,
  };

  const poll: VBookPollContract = {
    getPollToken: () => pollState.token,
    bumpPollToken: () => { return ++pollState.token; },
  };

  const transport = {
    getJson: vi.fn(async () => ({ active: false }) as AgentStatusWire),
    postJsonLong: vi.fn(async () => ({})),
  };

  const ports: VBookAgentPorts = {
    identity: { getBookId },
    transport,
    poll,
    state,
    lifecycle: {
      startTimer: () => { recording.timerStarts++; },
      stopTimer: () => { recording.timerStops++; },
      startStream: (bId) => { recording.streamStarts.push(bId); },
      onVBookCleared: () => { recording.clears++; },
      onGenerationFinalized: () => { recording.finalized++; },
    },
  };

  return { ports, transport, pollState };
}

/** Active agent-status payload mid-window. */
function activeStatus(partial: Partial<AgentStatusWire> = {}): AgentStatusWire {
  return {
    active: true,
    session_status: 'running',
    progress_msg: 'Создание сцен',
    step_type: 'create_visual_prompts',
    window_total_scenes: 3,
    window_scene_index: 2,
    created_scenes: 5,
    window_index: 1,
    ...partial,
  };
}

// ── updateVBookProgress ──────────────────────────────────────

describe('updateVBookProgress', () => {
  it('merges agent status into current VBookProgress via the host callback', () => {
    const rec = makeRecording();
    const { ports } = makePorts(rec);
    ports.state.setVBookProgress(createAnalyzingVBookProgress());
    updateVBookProgress(ports.state, activeStatus() as AgentStatusLike);
    const after = ports.state.getVBookProgress();
    expect(after.stage).toBe('CREATING_SCENES');
    expect(after.scenesInWindow).toBe(3);
    expect(after.sceneIndex).toBe(1);
    expect(rec.vbookProgressWrites.length).toBeGreaterThan(0);
  });
});

// ── checkAgentStatus ─────────────────────────────────────────

describe('checkAgentStatus', () => {
  it('returns current progress unchanged when no book is open', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec, () => '');
    const result = await checkAgentStatus(ports);
    expect(transport.getJson).not.toHaveBeenCalled();
    expect(result.stage).toBe('IDLE');
  });

  it('merges an active status with a progress message', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockResolvedValueOnce(activeStatus());
    const result = await checkAgentStatus(ports);
    expect(result.stage).toBe('CREATING_SCENES');
    expect(result.stepType).toBe('create_visual_prompts');
  });

  it('finalizes ANALYZING → COMPLETED when the agent went inactive', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    ports.state.setVBookProgress(createAnalyzingVBookProgress());
    transport.getJson.mockResolvedValueOnce({
      active: false,
      session_status: 'idle',
      progress_msg: 'Готово',
      window_total_scenes: 3,
      window_scene_index: 3,
    });
    const result = await checkAgentStatus(ports);
    expect(result.stage).toBe('COMPLETED');
  });

  it('keeps current progress on transport error', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    ports.state.setVBookProgress(createAnalyzingVBookProgress());
    transport.getJson.mockRejectedValueOnce(new Error('network down'));
    const result = await checkAgentStatus(ports);
    expect(result.stage).toBe('ANALYZING');
  });

  it('does not finalize an already-idle progress', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockResolvedValueOnce({ active: false, progress_msg: 'done' });
    const result = await checkAgentStatus(ports);
    expect(result.stage).toBe('IDLE');
  });
});

// ── pollVBookProgress ─────────────────────────────────────────

describe('pollVBookProgress', () => {
  it('finalizes COMPLETED after maxInactive consecutive inactive polls and calls onGenerationFinalized', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockResolvedValue({ active: false, progress_msg: null });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(ports.state.getVBookProgress().stage).toBe('COMPLETED');
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
    // isRegenerating false → timer stopped by the poll loop
    expect(rec.timerStops).toBe(1);
  });

  it('keeps the timer running while the session is regenerating', async () => {
    const rec = makeRecording();
    rec.isRegenerating = true;
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockResolvedValue({ active: false, progress_msg: null });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
    expect(rec.timerStops).toBe(0);
  });

  it('continues polling while the agent is active, then finalizes on inactive', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson
      .mockResolvedValueOnce(activeStatus())
      .mockResolvedValueOnce(activeStatus())
      .mockResolvedValueOnce(activeStatus())
      .mockResolvedValue({ active: false, progress_msg: null });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(rec.vbookProgressWrites.length).toBeGreaterThanOrEqual(3);
    expect(ports.state.getVBookProgress().stage).toBe('COMPLETED');
    expect(rec.finalized).toBe(1);
  });

  it('finalizes a paused window immediately with the real counter', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockResolvedValue({
      active: false,
      session_status: 'paused',
      progress_msg: 'Окно завершено',
      window_total_scenes: 3,
      window_scene_index: 3,
    });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    const after = ports.state.getVBookProgress();
    expect(after.stage).toBe('COMPLETED');
    expect(after.scenesInWindow).toBe(3);
    expect(rec.finalized).toBe(1);
  });

  it('finalizes immediately when the import handshake completed', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    rec.importCompleteReceived = true;
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(transport.getJson).not.toHaveBeenCalled();
    expect(ports.state.getVBookProgress().stage).toBe('COMPLETED');
    expect(rec.finalized).toBe(1);
  });

  it('survives transient poll errors and finalizes once inactive (errors count toward the inactive budget)', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(activeStatus())
      .mockResolvedValue({ active: false, progress_msg: null });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    // 1 error + 1 inactive poll = 2 consecutive inactive → the host
    // semantics finalize the window (SUCCESS + onGenerationFinalized).
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
  });

  it('finalizes optimistically after maxInactive consecutive poll errors (host parity)', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockRejectedValue(new Error('network down'));
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
    // Host parity: the error path does NOT write a COMPLETED stage — only
    // the inactive path does; the panel poll reconciles the stage later.
    expect(rec.status.length).toBe(1);
  });

  it('stops silently when the host bumps the poll token (stale session)', async () => {
    const rec = makeRecording();
    const { ports, transport, pollState } = makePorts(rec);
    transport.getJson.mockImplementation(async () => {
      pollState.token = 99; // host cancels mid-flight
      return activeStatus();
    });
    await pollVBookProgress(ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0 });
    expect(rec.finalized).toBe(0);
    expect(rec.status).not.toContain('SUCCESS');
    expect(ports.state.getVBookProgress().stage).not.toBe('COMPLETED');
  });

  it('does not finalize a still-active agent after the safety cap; finalizes a truly finished one', async () => {
    // safety cap: negative cap trips immediately + active agent → leave UI alive
    const recActive = makeRecording();
    const active = makePorts(recActive);
    active.transport.getJson.mockResolvedValue(activeStatus());
    await pollVBookProgress(active.ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0, maxPollMs: -1 });
    expect(recActive.finalized).toBe(0);
    expect(recActive.status).not.toContain('SUCCESS');

    // safety cap + genuinely finished agent → the probe finalizes.
    // Cap trips before the first poll fires, so every getJson call is the
    // final probe.
    const recDone = makeRecording();
    const done = makePorts(recDone);
    done.transport.getJson.mockResolvedValue({ active: false, progress_msg: null });
    await pollVBookProgress(done.ports, 'book-1', 0, { pollIntervalMs: 0, errorIntervalMs: 0, maxPollMs: -1 });
    expect(recDone.finalized).toBe(1);
    expect(recDone.status).toContain('SUCCESS');
  });
});

// ── startVBookGeneration ─────────────────────────────────────

describe('startVBookGeneration', () => {
  it('is a no-op without a book', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec, () => '');
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(transport.getJson).not.toHaveBeenCalled();
    expect(rec.status).toEqual([]);
    expect(rec.timerStarts).toBe(0);
  });

  it('arms the session state, starts timer + stream, and picks bootstrap for an unready book', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    // The agent stays ACTIVE for the first polls (arming assertions check
    // mid-run state) and then goes inactive so the loop terminates.
    let pollCount = 0;
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return { ready: false };
      pollCount++;
      return pollCount <= 2 ? activeStatus() : { active: false, progress_msg: null };
    });
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(rec.status[0]).toBe('RUNNING');
    expect(rec.isRegenerating).toBe(true);
    expect(rec.newGenerationPending).toBe(true);
    expect(rec.timerStarts).toBe(1);
    expect(rec.streamStarts).toEqual(['book-1']);
    expect(rec.vbookProgressWrites.some((p) => p.stage === 'ANALYZING' || p.stage === 'CREATING_SCENES')).toBe(true);
    expect(transport.postJsonLong).toHaveBeenCalledWith('/book/book-1/bootstrap');
    expect(transport.postJsonLong).not.toHaveBeenCalledWith('/book/book-1/bootstrap-next-window');
    // The poll loop finished the window (agent went inactive).
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
  });

  it('picks bootstrap-next-window for a ready book', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return { ready: true };
      return { active: false, progress_msg: null };
    });
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(transport.postJsonLong).toHaveBeenCalledWith('/book/book-1/bootstrap-next-window');
    expect(transport.postJsonLong).not.toHaveBeenCalledWith('/book/book-1/bootstrap');
  });

  it('finalizes through the poll loop on success', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return { ready: true };
      return { active: false, progress_msg: null };
    });
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(rec.status).toContain('SUCCESS');
    expect(rec.finalized).toBe(1);
  });

  it('treats an unreachable /status as needing bootstrap', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/status')) throw new Error('down');
      return { active: false, progress_msg: null };
    });
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(transport.postJsonLong).toHaveBeenCalledWith('/book/book-1/bootstrap');
  });

  it('keeps tracking an active agent when the bootstrap POST aborts client-side', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    // /status resolves, bootstrap aborts, agent-status reports ACTIVE —
    // the reconciliation must keep polling. The agent then goes inactive
    // so the reconciliation poll loop terminates the window.
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/agent-status')) return activeStatus();
      return { ready: true };
    });
    // after N polls the agent finishes
    let pollCount = 0;
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return { ready: true };
      pollCount++;
      return pollCount <= 3 ? activeStatus() : { active: false, progress_msg: null };
    });
    transport.postJsonLong.mockRejectedValueOnce(new Error('Request timeout'));
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    // The reconciliation polled agent-status; an active agent leaves the UI
    // alive — the poll loop keeps running until the agent goes inactive.
    expect(rec.clears).toBe(0);
    expect(ports.state.getVBookProgress().stepType).toBe('create_visual_prompts');
    expect(rec.finalized).toBe(1);
  });

  it('tears the progress down when the agent is genuinely dead after a failure', async () => {
    const rec = makeRecording();
    const { ports, transport } = makePorts(rec);
    transport.getJson.mockImplementation(async (path: string) => {
      if (path.includes('/agent-status')) return { active: false, session_status: 'idle' };
      return { ready: true };
    });
    transport.postJsonLong.mockRejectedValueOnce(new Error('boom'));
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(rec.clears).toBe(1);
    expect(rec.timerStops).toBe(1);
    expect(rec.finalized).toBe(0);
  });

  it('aborts silently when the host cancelled the session mid-flight (stale token)', async () => {
    const rec = makeRecording();
    const { ports, transport, pollState } = makePorts(rec);
    transport.postJsonLong.mockImplementation(async () => {
      pollState.token = 42; // host cancelled while the POST was in flight
      throw new Error('aborted');
    });
    await startVBookGeneration(ports, { pollIntervalMs: 0 });
    expect(rec.clears).toBe(0);
    expect(rec.timerStops).toBe(0);
    expect(rec.finalized).toBe(0);
  });
});

// ── Explicit poll state ──────────────────────────────────────

describe('createVBookPollState', () => {
  it('creates a fresh explicit state object (no module-global mutable state)', () => {
    const a = createVBookPollState();
    const b = createVBookPollState();
    expect(a).not.toBe(b);
    expect(a.token).toBe(0);
    a.token = 5;
    expect(b.token).toBe(0);
  });
});

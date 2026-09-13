// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — VBook progress mapping tests
// ═══════════════════════════════════════════════════════════════
//  vbookProgressFromEvent (SSE) + applyAgentStatus (/agent-status)
//  + factories. 1:1 with the previous inline store implementations.
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
  applyAgentStatus, createAnalyzingVBookProgress, createIdleVBookProgress,
  vbookProgressFromEvent,
} from './vbookProgress';

describe('vbookProgressFromEvent — SSE vbook branch', () => {
  it('maps creating_units / creating_visuals to CREATING_SCENES; anything else to ANALYZING', () => {
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 'creating_units' }).stage).toBe('CREATING_SCENES');
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 'creating_visuals' }).stage).toBe('CREATING_SCENES');
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 'analyzing_chars' }).stage).toBe('ANALYZING');
  });

  it('window counters: window_total_scenes preferred, window_size fallback, min 1', () => {
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's', window_total_scenes: 5, window_size: 3 }).scenesInWindow).toBe(5);
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's', window_size: 3 }).scenesInWindow).toBe(3);
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's' }).scenesInWindow).toBe(1);
  });

  it('scene index is 0-based, clamped into the window; -1 when unreported', () => {
    const p = vbookProgressFromEvent({ type: 'vbook', stage: 's', window_total_scenes: 5, window_scene_index: 2 });
    expect(p.sceneIndex).toBe(1);
    const clamped = vbookProgressFromEvent({ type: 'vbook', stage: 's', window_total_scenes: 2, window_scene_index: 9 });
    expect(clamped.sceneIndex).toBe(1);
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's' }).sceneIndex).toBe(-1);
  });

  it('totalScenes prefers total_scenes, falls back to scene_index, min 1', () => {
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's', total_scenes: 7 }).totalScenes).toBe(7);
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's', scene_index: 4 }).totalScenes).toBe(4);
    expect(vbookProgressFromEvent({ type: 'vbook', stage: 's' }).totalScenes).toBe(1);
  });

  it('message trimmed to null when whitespace; stepType mirrors the stage id', () => {
    const p = vbookProgressFromEvent({ type: 'vbook', stage: 'analyzing_chars', message: '  ' });
    expect(p.message).toBeNull();
    expect(p.stepType).toBe('analyzing_chars');
    expect(p.windowIndex).toBe(0);
    const q = vbookProgressFromEvent({ type: 'vbook', stage: 's', message: 'Генерация 3/3' });
    expect(q.message).toBe('Генерация 3/3');
  });
});

describe('applyAgentStatus — /agent-status merge', () => {
  it('maps create_units/create_visual_prompts step_type to CREATING_SCENES, else ANALYZING', () => {
    expect(applyAgentStatus(createIdleVBookProgress(), { step_type: 'create_units' }).stage).toBe('CREATING_SCENES');
    expect(applyAgentStatus(createIdleVBookProgress(), { step_type: 'create_visual_prompts' }).stage).toBe('CREATING_SCENES');
    expect(applyAgentStatus(createIdleVBookProgress(), { step_type: 'extract_chars' }).stage).toBe('ANALYZING');
    expect(applyAgentStatus(createIdleVBookProgress(), {}).stage).toBe('ANALYZING');
  });

  it('derives window index from created_scenes - window_start_scene + 1 when scene index is absent', () => {
    const p = applyAgentStatus(createIdleVBookProgress(), {
      step_type: 'create_units', window_total_scenes: 4,
      created_scenes: 6, window_start_scene: 3,
    });
    // windowSceneIndex = 6-3+1 = 4 → 0-based 3, clamped to window size 4-1 = 3.
    expect(p.sceneIndex).toBe(3);
    expect(p.scenesInWindow).toBe(4);
    expect(p.totalScenes).toBe(6);
  });

  it('preserves the previous sceneIndex when the poll reports none', () => {
    const prev = { ...createAnalyzingVBookProgress(), sceneIndex: 2 };
    const p = applyAgentStatus(prev, { step_type: 'create_units', window_total_scenes: 5 });
    expect(p.sceneIndex).toBe(2);
  });

  it('preserves the previous stepType when the poll reports none (no Russian fallback flash)', () => {
    const prev = { ...createAnalyzingVBookProgress(), stepType: 'extract_chars' };
    const p = applyAgentStatus(prev, {});
    expect(p.stepType).toBe('extract_chars');
    const overridden = applyAgentStatus(prev, { step_type: 'create_units' });
    expect(overridden.stepType).toBe('create_units');
  });

  it('totalScenes prefers created_scenes over total_scenes; progress_msg semantics', () => {
    const p = applyAgentStatus(createIdleVBookProgress(), {
      created_scenes: 10, total_scenes: 4, window_index: 2, progress_msg: 'Генерация 3/3',
    });
    expect(p.totalScenes).toBe(10);
    expect(p.windowIndex).toBe(2);
    expect(p.message).toBe('Генерация 3/3');
    // Whitespace-only message → null (trim() gates, original value passes through when non-empty).
    expect(applyAgentStatus(createIdleVBookProgress(), { progress_msg: '   ' }).message).toBeNull();
  });
});

describe('factories', () => {
  it('idle: stage IDLE, no scenes, no message, no step type', () => {
    expect(createIdleVBookProgress()).toEqual({
      stage: 'IDLE', sceneIndex: -1, scenesInWindow: 0, totalScenes: null, windowIndex: 0, message: null, stepType: null,
    });
  });

  it('analyzing: stage ANALYZING, window of 1', () => {
    expect(createAnalyzingVBookProgress()).toEqual({
      stage: 'ANALYZING', sceneIndex: -1, scenesInWindow: 1, totalScenes: null, windowIndex: 0, message: null, stepType: null,
    });
  });
});

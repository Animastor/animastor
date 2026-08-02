// lib/waveform.tsx — WaveformView.kt port (06 §2, R10). Canvas render identical to
// the Android custom View.draw(): vertical peak lines centered on midY, selection
// fill + border, draggable start/end handles, white playhead with top triangle,
// time labels (start/end/total in M:SS.d), and a "No waveform data" fallback.
//
// The Android paints are hardcoded colors (not theme attributes) — kept as-is:
//   waveform   0x8890CAF9  → rgba(144,202,249,.53)
//   selection  0x3390CAF9  → rgba(144,202,249,.20)
//   sel border 0x55FFB74D  → rgba(255,183,77,.33)
//   handle     #FFB74D
//   playhead   #FFFFFF
//   text       0xCCFFFFFF  → rgba(255,255,255,.80)
//   time text  0x99FFFFFF  → rgba(255,255,255,.60)
//
// Deviation (06 §15): Android touch coordinates are raw px (scaled by density);
// here CSS px with the same 24px touchSlop (≈ the Android value at ~1x density).
// The playback playhead is driven either by a `playbackPositionMs` prop or by a
// `playbackSignal` (Signal<number>) — the signal path redraws without re-rendering
// the page, matching Android's 50ms playback tick without per-frame React state.

import { useEffect, useRef, useCallback } from 'preact/hooks';
import { effect } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { WaveformPeak } from '../api/models';

export interface WaveformSelection {
  startMs: number;
  endMs: number;
}

export interface WaveformProps {
  peaks: WaveformPeak[];
  durationMs: number;
  selection: WaveformSelection | null;
  /** -1 = hidden. */
  playbackPositionMs?: number;
  /** Optional signal; when set, the playhead follows it per tick without re-render. */
  playbackSignal?: Signal<number>;
  onRangeChange?: (startMs: number, endMs: number) => void;
  onRangeChangeEnd?: (startMs: number, endMs: number) => void;
}

const PAD = 12;
const TOUCH_SLOP = 24; // Android touchSlop = 24f

type DragTarget = 'none' | 'start' | 'end';

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const millis = Math.floor(ms % 1000 / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${millis}`;
}

export function Waveform(props: WaveformProps) {
  const { peaks, durationMs, selection, onRangeChange, onRangeChangeEnd } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ target: DragTarget; startMs: number; endMs: number }>({
    target: 'none', startMs: 0, endMs: 0,
  });
  // Playhead read inside draw() — keep the latest value without re-running draw()'s
  // dep list: prop updates here, signal ticks update the canvas via the effect below.
  const playbackRef = useRef(props.playbackPositionMs ?? -1);
  playbackRef.current = props.playbackPositionMs ?? -1;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const w = cssW;
    const h = cssH;
    const drawLeft = PAD;
    const drawRight = w - PAD;
    const drawWidth = drawRight - drawLeft;
    const midY = h / 2;
    // Scale handle/dot geometry by view height (Android: fixed px on a 72dp view).
    const s = h / 72;
    const playbackPositionMs = playbackRef.current;

    const msToX = (ms: number) => (durationMs > 0 ? (ms / durationMs) * drawWidth : 0);

    // ── Waveform bars ──
    if (!peaks || peaks.length === 0) {
      ctx.fillStyle = 'var(--text-2)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `500 12px system-ui, sans-serif`; // textNoData 24sp ≈ 9px @1x
      ctx.fillText('No waveform data', w / 2, midY);
    } else {
      ctx.strokeStyle = 'rgba(144,202,249,.53)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      const barCount = peaks.length;
      const barWidth = drawWidth / barCount;
      ctx.beginPath();
      for (let i = 0; i < barCount; i++) {
        const peak = peaks[i];
        const x = drawLeft + i * barWidth + barWidth / 2;
        const posHeight = Math.min(Math.abs(peak.pos) * midY * 0.9, midY - 4);
        const negHeight = Math.min(Math.abs(peak.neg) * midY * 0.9, midY - 4);
        ctx.moveTo(x, midY - posHeight);
        ctx.lineTo(x, midY + negHeight);
      }
      ctx.stroke();
    }

    // ── Selection (fill + border) + handles ──
    let selLeft = 0;
    let selRight = 0;
    if (selection && durationMs > 0) {
      selLeft = drawLeft + msToX(selection.startMs);
      selRight = drawLeft + msToX(selection.endMs);
      if (selRight <= selLeft) selRight = selLeft + 4;
      ctx.fillStyle = 'rgba(144,202,249,.20)';
      ctx.fillRect(selLeft, 0, selRight - selLeft, h);
      ctx.strokeStyle = 'rgba(255,183,77,.33)';
      ctx.lineWidth = 1;
      ctx.strokeRect(selLeft, 0, selRight - selLeft, h);

      ctx.strokeStyle = '#FFB74D';
      ctx.lineWidth = 3;
      ctx.fillStyle = '#FFB74D';
      const handleRadius = 8 * s;
      for (const hx of [selLeft, selRight]) {
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx, midY, handleRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hx, midY - 16 * s, 3 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hx, midY + 16 * s, 3 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Playhead ──
    if (playbackPositionMs >= 0 && durationMs > 0) {
      const px = drawLeft + msToX(playbackPositionMs);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      const tri = 8 * s;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px - tri, -tri);
      ctx.lineTo(px + tri, -tri);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }

    // ── Time labels ──
    if (selection && durationMs > 0) {
      const startLabel = formatMs(selection.startMs);
      const endLabel = formatMs(selection.endMs);
      const totalLabel = formatMs(durationMs);
      // Secondary text color from the design system (--text-2): warm gray that
      // stays legible on both themes over the blue waveform bars.
      ctx.fillStyle = 'var(--text-2)';
      ctx.font = '11px system-ui, sans-serif'; // timeText 20sp ≈ 7px @1x
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(startLabel, selLeft + 6, h - 7);
      ctx.textAlign = 'right';
      ctx.fillText(endLabel, selRight - 6, h - 7);
      ctx.textAlign = 'left';
      ctx.fillText(totalLabel, drawLeft + 2, 14);
    }
  }, [peaks, durationMs, selection]);

  // Redraw on prop changes (invalidates()).
  useEffect(() => { draw(); }, [draw]);

  // Redraw per signal tick (playback rAF loop) without re-rendering the page.
  const playbackSignal = props.playbackSignal;
  useEffect(() => {
    if (!playbackSignal) return;
    return effect(() => {
      void playbackSignal.value;
      draw();
    });
  }, [draw, playbackSignal]);

  // ── Pointer drag (onTouchEvent equivalent) ──
  const onPointerDown = (e: PointerEvent) => {
    if (durationMs <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const drawWidth = rect.width - PAD * 2;
    if (drawWidth <= 0) return;
    const drawLeft = PAD;
    const selLeft = drawLeft + (selection ? (selection.startMs / durationMs) * drawWidth : 0);
    const selRight = drawLeft + (selection ? (selection.endMs / durationMs) * drawWidth : 0);
    const x = e.clientX - rect.left;
    const distToStart = Math.abs(x - selLeft);
    const distToEnd = Math.abs(x - selRight);
    let target: DragTarget = 'none';
    if (distToStart < TOUCH_SLOP * 2) target = 'start';
    else if (distToEnd < TOUCH_SLOP * 2) target = 'end';
    if (target === 'none') return;
    dragRef.current = {
      target,
      startMs: selection?.startMs ?? 0,
      endMs: selection?.endMs ?? 0,
    };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (drag.target === 'none') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const drawLeft = PAD;
    const drawWidth = rect.width - PAD * 2;
    if (drawWidth <= 0) return;
    const x = Math.min(Math.max(e.clientX - rect.left - drawLeft, 0), drawWidth);
    const ms = Math.round((x / drawWidth) * durationMs);
    let startMs = drag.startMs;
    let endMs = drag.endMs;
    if (drag.target === 'start') {
      startMs = Math.min(ms, endMs - 50);
    } else {
      endMs = Math.max(ms, startMs + 50);
      endMs = Math.min(endMs, durationMs);
    }
    if (startMs !== drag.startMs || endMs !== drag.endMs) {
      drag.startMs = startMs;
      drag.endMs = endMs;
      onRangeChange?.(startMs, endMs);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (drag.target === 'none') return;
    drag.target = 'none';
    const canvas = canvasRef.current;
    try { canvas?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    onRangeChangeEnd?.(drag.startMs, drag.endMs);
  };

  return (
    <div ref={wrapRef} class="waveform" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
}

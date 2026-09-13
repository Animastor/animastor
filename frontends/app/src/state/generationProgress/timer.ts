// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — generation wall-clock timer
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1).
//  Port of GenerateViewModel's timerStartedAt/finalElapsedSeconds
//  (Android parity): the timer is wall-clock session state, NOT a
//  signal — a mutable state object the host (generateStore) owns one
//  instance of. All computation lives here; the host delegates.
//  No host reach, no Date.now() outside injected call sites.
// ═══════════════════════════════════════════════════════════════

export interface GenerationTimerState {
  /** Wall-clock epoch ms of the session start. 0 = never started,
   *  -1 = stopped (read finalElapsedSeconds). */
  startedAt: number;
  /** Final value in seconds once stopped; 0 while running. */
  finalElapsedSeconds: number;
}

export function createGenerationTimer(): GenerationTimerState {
  return { startedAt: 0, finalElapsedSeconds: 0 };
}

export function startGenerationTimer(t: GenerationTimerState, now: number = Date.now()): void {
  t.startedAt = now;
  t.finalElapsedSeconds = 0;
}

export function stopGenerationTimer(t: GenerationTimerState, now: number = Date.now()): void {
  if (t.startedAt > 0) t.finalElapsedSeconds = Math.floor((now - t.startedAt) / 1000);
  t.startedAt = -1;
}

/** Live elapsed while running; frozen final once stopped (GeneratePage
 *  liveElapsedSeconds/globalElapsedSeconds — identical bodies). */
export function elapsedSeconds(t: GenerationTimerState, now: number = Date.now()): number {
  if (t.startedAt > 0) return Math.floor((now - t.startedAt) / 1000);
  return t.finalElapsedSeconds;
}

/** hh:mm:ss formatter (Android formatTimerText; also used by the
 *  Analysis progress panel timers). */
export function formatTimerText(elapsedSeconds: number): string {
  const sec = Math.max(0, Math.floor(elapsedSeconds));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

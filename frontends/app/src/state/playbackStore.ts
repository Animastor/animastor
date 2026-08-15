// PlaybackViewModel + player engine equivalent (stage 7 — Play, the final screen).
//
// Houses the whole player subsystem that in Android is split between
// PlaybackViewModel.kt (queue/preload/fetch/phase state) and PlayFragment.kt
// (the MediaPlayer trio + IU cycling). On the web both halves are module-scoped
// so they survive tab switches (Android Fragment.hide/show): the two <audio>
// elements live in a hidden host div appended to <body>, the <video> element is
// adopted from PlayPage and re-attached on mount.
//
// Key ports (1:1 with the Android source, deviations in docs/06 §16):
//  - scene queue + currentIndex/currentUnitIndex (PlaybackViewModel)
//  - preloadAhead(3) with parallel fetch + retryWithBackoff (3, 1s→2→5s)
//  - fetchSceneData: status → audio/video/IU (parallel) + mediaCache (Cache API)
//  - gapless: two <audio> + early switch −200ms (06 §1.2 variant A)
//  - IU cycling on requestAnimationFrame over audio.currentTime (06 §1.3 A),
//    silent-IU timer mode for scenes without audio (Cover)
//  - soft refresh (needsContentRefresh) + clearCache on buildId change
//  - lifecycle: pause on document.hidden, position save/restore via
//    sessionStorage on pagehide/pageshow (06 §1.8)
//  - DONT_DO.md: no IU stall/retry, no skip-IU-by-null-bitmap, no rewrite of
//    the sliding-window preload, single navigation source (FileFragment only).
import { signal } from '@preact/signals';
import { API_BASE, getBlob, getJson, retryWithBackoff } from '../api/client';
import type { BookData, SceneStatusResponse, StoryboardResponse } from '../api/models';
import { sceneRefs } from '../api/models';
import { navigateTo } from './positionStore';
import type { ActivePosition } from './positionStore';
import { onPlaybackPrepared } from './generateStore';
import type { SceneRef } from './generateStore';
import { getMedia, putMedia, clearCache as clearMediaCache } from '../cache/mediaCache';

export type PlayerPhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

export interface PlaybackUiState {
  phase: PlayerPhase;
  errorMessage: string | null;
  sceneCount: number;
  currentIndex: number;
  currentUnitIndex: number;
  /** Monotonic delivery counter — PlaybackUiState.chunkSequence equivalent. */
  chunkSequence: number;
}

const initial: PlaybackUiState = {
  phase: 'IDLE', errorMessage: null, sceneCount: 0, currentIndex: 0, currentUnitIndex: 0, chunkSequence: 0
};

export const uiState = signal<PlaybackUiState>(initial);
export const bookId = signal('');
export const buildId = signal('');
export const sceneQueue = signal<SceneRef[]>([]);

// ── External seek (PlaybackViewModel.pendingExternalSeek / missingIuPosition) ──
export const missingIuPosition = signal<ActivePosition | null>(null);
export const pendingExternalSeek = signal<ActivePosition | null>(null);

// ── Layer toggles (fragment_play.xml layer chips) ──
export const layerAudio = signal(true);
export const layerImage = signal(true);
export const layerVideo = signal(true);
export const layerSubtitles = signal(true);

// ── Display state consumed by PlayPage (fragment collectors) ──
export const coverImage = signal<string | null>(null);      // blob URL (state.coverImage)
export const previewImage = signal<string | null>(null);    // blob URL (state.previewImage)
export const currentIuSequence = signal<IuImageItem[] | null>(null);
export const currentIuBlobUrl = signal<string | null>(null); // resultImage src
export const subtitleText = signal<string | null>(null);     // subtitleText TextView
export const iuMissing = signal(false);                      // iuMissingOverlay visible
export const enginePaused = signal(false);                   // fragment.isPaused mirror
export const videoVisible = signal(false);                   // videoSurface visibility

// ── IuImageItem / IuStatus / PreloadedScene (GenerateViewModel.kt:1564) ──
export type IuStatus = 'READY' | 'NOT_GENERATED' | 'FAILED';
export interface IuImageItem {
  blobUrl: string | null;
  durationMs: number;
  unitId: string | null;
  text: string | null;
  status: IuStatus;
  /** Server-computed start (ms) on the whole-scene timeline (start_ms). */
  startMs: number | null;
}
export interface PreloadedScene {
  audio: Blob;
  audioUrl: string;
  /** status.video_ready — whether the whole-scene video exists on the backend.
   *  The video itself is NOT downloaded as part of the scene bundle anymore:
   *  it is streamed from its direct HTTP URL (ensureSceneVideo) only when the
   *  scene actually plays with the video layer enabled — preloading/downloading
   *  it burned ~43 MB/scene. */
  videoReady: boolean;
  iuSequence: IuImageItem[];
}

// ═══════════════════════════════════════════════════════════════
//  INTERNAL ENGINE STATE (PlayFragment.kt fields)
// ═══════════════════════════════════════════════════════════════

const PRELOAD_AHEAD = 3;
const SAVED_POS_KEY = 'animastor:playbackPosition';

let currentIndex = 0;                 // PlaybackViewModel.currentIndex
let currentUnitIndex = 0;             // PlaybackViewModel.currentUnitIndex
let currentIuIndex = 0;               // fragment.currentIuIndex
let isPaused = false;                 // fragment.isPaused
let pendingLoad = false;              // fragment.pendingLoad
let sceneTransitionPending = false;   // fragment.sceneTransitionPending
let nextChainReady = false;           // fragment.nextChainReady
let needsContentRefresh = false;      // PlaybackViewModel.needsContentRefresh
let needsRotationResume = false;      // PlaybackViewModel.needsRotationResume
let savedPlaybackPositionMs = 0;      // PlaybackViewModel.savedPlaybackPositionMs
let pendingSeekPositionMs = -1;       // PlaybackViewModel.pendingSeekPositionMs
let isExecutingExternalSeek = false;
// Set by executePendingSeek (an external unit tap), consumed by the next
// handleChunk: marks the computed seekMs as an EXPLICIT video target — even
// when it is 0 (unit 1 / scene start). Without this, seeking to 0 fell into
// the "sync to audio position" branch and, when the same scene video URL was
// re-used (no reload, element stays at the old position), the video never
// moved back to the start.
let pendingExplicitUnitTarget = false;
let currentVolume = 1;                // fragment.currentVolume
// Explicit position (seconds) the whole-scene video must land on once loaded.
// Set on unit navigation; guards re-syncs (attachVideo) from clobbering it with
// the audio element's not-yet-seeked currentTime (seek is async). -1 = none.
let pendingVideoTargetSec = -1;
let sceneSeqCounter = 0;              // PlaybackViewModel.sceneSeqCounter
let lastProcessedSceneSequence = 0;
let videoEnded = false;

const preloadCache = new Map<string, PreloadedScene>();      // `${buildId}_${sceneKey}`
let preloadJobToken = 0;             // stale-preload guard
let sceneEpoch = 0;                  // stale-fetch guard (discard emits after reset)
let activeScene: PreloadedScene | null = null; // last delivered scene (URL GC)

// Media elements (fragment MediaPlayers) — audio lives in a hidden host,
// video is adopted from the PlayPage DOM tree.
let engineHost: HTMLDivElement | null = null;
let currentPlayer: HTMLAudioElement | null = null;
let nextPlayer: HTMLAudioElement | null = null;
let videoEl: HTMLVideoElement | null = null;
// Direct HTTP URL of the current scene's video (streamed progressively with
// Range — the browser fetches moov + first samples, not the whole file).
let videoSrcUrl: string | null = null;
// Scene key of the whole-scene video currently loaded in videoEl. Used to
// detect unit navigation WITHIN the same scene: the video file does not change
// (blob URLs are recreated per fetch, so the scene key — not the URL — is the
// identity), and re-src'ing the element would clear the frame and force a
// black/storyboard gap until the new source decodes. Web parity with the
// Android keepSurface fix: the current frame stays visible through the seek
// and the new unit's frame replaces it directly.
let currentVideoSceneKey: string | null = null;
let iuRafId = 0;
let silentTimer: number | null = null;

interface SavedPosition {
  bookId: string;
  buildId: string;
  index: number;
  posMs: number;
}
let pendingPositionRestore: SavedPosition | null = null;

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function sceneKeyOf(ref: SceneRef): string { return `${ref.chapterId}:${ref.sceneId}`; }
function enc(s: string): string { return encodeURIComponent(s); }
function scenePath(chId: string, scId: string, kind: string): string {
  return `/scene/${enc(bookId.value)}/${enc(chId)}/${enc(scId)}/${kind}?build_id=${enc(buildId.value)}`;
}
function iuPath(bId: string, bld: string, chId: string, scId: string, unitId: string): string {
  return `/iu-image/${enc(bId)}/${enc(chId)}/${enc(scId)}/${enc(unitId)}?build_id=${enc(bld)}`;
}
function currentSceneRef(): SceneRef | undefined { return sceneQueue.value[currentIndex]; }
export function currentChapterId(): string | null { return currentSceneRef()?.chapterId ?? null; }
export function currentSceneId(): string | null { return currentSceneRef()?.sceneId ?? null; }
export function getCurrentSceneKey(): string | null {
  const ref = currentSceneRef();
  return ref ? sceneKeyOf(ref) : null;
}
export const currentSceneIndex = (): number => currentIndex;
export const sceneQueueSize = (): number => sceneQueue.value.length;

function revokeSceneUrls(scene: PreloadedScene): void {
  URL.revokeObjectURL(scene.audioUrl);
  for (const iu of scene.iuSequence) if (iu.blobUrl) URL.revokeObjectURL(iu.blobUrl);
}

// Revokes cached object URLs unless they are still referenced by the current
// IU sequence (currentIuSequence may outlive a cache entry after soft refresh).
function clearPreloadCache(): void {
  const live = new Set(currentIuSequence.value?.map((i) => i.blobUrl).filter(Boolean));
  for (const scene of preloadCache.values()) {
    if (!live.has(scene.audioUrl)) URL.revokeObjectURL(scene.audioUrl);
    for (const iu of scene.iuSequence) if (iu.blobUrl && !live.has(iu.blobUrl)) URL.revokeObjectURL(iu.blobUrl);
  }
  preloadCache.clear();
}

function bumpSceneEpoch(): void { sceneEpoch++; }

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API — activity coordinator / PlayPage
// ═══════════════════════════════════════════════════════════════

/** Start playback from the beginning, or refresh content for the same book
 *  (PlaybackViewModel.preparePlayback). Clears media cache when the build
 *  changed (DONT_DO #5 — never remove). */
export function preparePlayback(bId: string, bBuild: string, scenes: SceneRef[]): void {
  const prevBookId = bookId.value;
  const prevBuildId = buildId.value;
  const savedIndex = currentIndex < scenes.length ? currentIndex : 0;

  bumpSceneEpoch();
  clearPreloadCache();
  bookId.value = bId;
  buildId.value = bBuild;
  sceneQueue.value = scenes;
  currentIndex = prevBookId === bId && savedIndex < scenes.length ? savedIndex : 0;
  currentUnitIndex = 0;

  // New book → drop the previous book's cover/preview so a failed cover load
  // never leaves the old book's art on screen (web hardening; Android keeps
  // the stale bitmap in its state flow until setCoverImage replaces it).
  if (prevBookId !== bId) {
    if (coverImage.value) URL.revokeObjectURL(coverImage.value);
    coverImage.value = null;
    if (previewImage.value) URL.revokeObjectURL(previewImage.value);
    previewImage.value = null;
  }

  if (prevBuildId !== bBuild || prevBookId !== bId) {
    void clearMediaCache();
  }
  uiState.value = {
    ...initial,
    phase: scenes.length ? 'SCENE_READY' : 'IDLE',
    sceneCount: scenes.length,
    currentIndex,
  };
  missingIuPosition.value = null;
  pendingExternalSeek.value = null;
}

/** Soft refresh after regeneration (PlaybackViewModel.refreshContent): keeps
 *  position/phase while PAUSED or PLAYING, sets needsContentRefresh so the next
 *  resume re-fetches the current scene; full reset otherwise. */
export function refreshContent(bId: string, bBuild: string, scenes: SceneRef[]): void {
  const sceneKeys = scenes.map(sceneKeyOf);
  const currentKey = getCurrentSceneKey();
  const newIndex = currentKey ? sceneKeys.indexOf(currentKey) : -1;

  bumpSceneEpoch();
  clearPreloadCache();
  bookId.value = bId;
  buildId.value = bBuild;
  sceneQueue.value = scenes;
  currentIndex = newIndex >= 0 ? newIndex : 0;

  // Backend updates content in-place — always clear the cache so the next
  // fetch hits the network and returns freshly generated content.
  void clearMediaCache();

  const phase = uiState.value.phase;
  if (phase === 'PLAYING' || phase === 'PAUSED') {
    needsContentRefresh = true;
    pendingSeekPositionMs = -1;
    stopAll();
    uiState.value = {
      ...uiState.value,
      phase: 'SCENE_READY',
      sceneCount: scenes.length,
      currentIndex,
    };
    return;
  }
  uiState.value = {
    ...uiState.value,
    phase: scenes.length ? 'SCENE_READY' : 'IDLE',
    sceneCount: scenes.length,
    currentIndex,
  };
}

/** Set the cover image (PlaybackViewModel.setCoverImage). */
export function setCoverImage(blob: Blob): void {
  if (coverImage.value) URL.revokeObjectURL(coverImage.value);
  coverImage.value = URL.createObjectURL(blob);
}
export function setPreviewImage(blobUrl: string | null): void {
  previewImage.value = blobUrl;
}

/** Ensure the player is initialized for a book (PlaybackViewModel.ensureInitialized):
 *  fetch book JSON → preparePlayback → load cover from the first (cover) scene. */
export async function ensureInitialized(targetBookId: string, targetBuildId: string): Promise<void> {
  if (bookId.value && bookId.value === targetBookId) return;
  try {
    const bookData = await getJson<BookData>(`/book/${enc(targetBookId)}`);
    const scenes = sceneRefs(bookData);
    const coverScene = scenes.find((s) => s.sceneType === 'cover');
    preparePlayback(targetBookId, targetBuildId, scenes);
    const first = coverScene ?? scenes[0];
    if (first) void loadCoverIntoState(first.chapterId, first.sceneId);
    if (pendingPositionRestore && pendingPositionRestore.bookId === targetBookId) {
      const saved = pendingPositionRestore;
      pendingPositionRestore = null;
      applyRestoredPosition(saved);
    }
  } catch (e) {
    console.warn('ensureInitialized failed:', (e as Error).message);
  }
}

/** Cover via first scene's first IU image (PlaybackViewModel.loadCoverIntoState),
 *  with the same ~5× retry/backoff as loadCoverBitmap (PLAYER_STATE.md §3).
 *  Called from the coordinator on every prepare (book open + generation
 *  completion) so a cover that was missing at open time replaces the curtains
 *  as soon as it becomes available — no manual page refresh needed. */
async function loadCoverIntoState(chapterId: string | null, sceneId: string | null): Promise<void> {
  if (!chapterId || !sceneId) return;
  // Capture the book/build at call time: a retry that outlives a book switch
  // must fetch the SAME book's cover and never clobber the new book's cover
  // with a stale async result (Android ties this to one book via the VM scope).
  const bId = bookId.value;
  const bld = buildId.value;
  if (!bId) return;
  try {
    const blob = await retryWithBackoff(async () => {
      const sb = await getJson<StoryboardResponse>(`/scene/${enc(bId)}/${enc(chapterId)}/${enc(sceneId)}/storyboard?build_id=${enc(bld)}`);
      const iu = sb.ius?.[0];
      if (!iu) throw new Error('no IU');
      return await getBlob(iuPath(bId, bld, chapterId, sceneId, iu.unit_id));
    }, 5, 1000, 5000);
    // bookId+buildId guard: a stale async result for a previous book/build must
    // never clobber the current book's cover (Android ties this to one VM scope).
    if (blob.size > 0 && bookId.value === bId && buildId.value === bld) setCoverImage(blob);
  } catch {
    /* cover stays unset — curtains fallback */
  }
}

/** PlaybackViewModel.playSceneQueue — restart from the beginning. */
export function playSceneQueue(): void {
  if (sceneQueue.value.length === 0) return;
  uiState.value = { ...uiState.value, errorMessage: null };
  missingIuPosition.value = null;
  currentIuSequence.value = null;
  currentUnitIndex = 0;
  lastProcessedSceneSequence = 0;
  currentIndex = 0;
  bumpSceneEpoch();
  preloadAhead(true);
  playNext();
}

/** PlaybackViewModel.resumeFromCurrentScene — used by the rotation-resume and
 *  SCENE_READY-with-position branches of the play button. */
export function resumeFromCurrentScene(): void {
  needsRotationResume = false;
  if (sceneQueue.value.length === 0) return;
  if (needsContentRefresh) {
    pendingSeekPositionMs = -1;
    savedPlaybackPositionMs = 0;
    needsContentRefresh = false;
    void clearMediaCache();
  } else {
    pendingSeekPositionMs = savedPlaybackPositionMs;
  }
  clearPreloadCache();
  preloadAhead(true);
  playNext();
}

export function rotationRecovery(): void {
  needsRotationResume = true;
  uiState.value = { ...uiState.value, phase: 'SCENE_READY' };
}

/** Pause playback (PlaybackViewModel.pausePlayback + fragment.pausePlayback). */
export function pausePlayback(): void {
  isPaused = true;
  enginePaused.value = true;
  try { currentPlayer?.pause(); } catch { /* ignore */ }
  try { videoEl?.pause(); } catch { /* ignore */ }
  uiState.value = { ...uiState.value, phase: 'PAUSED' };
}

/** Resume playback; when needsContentRefresh is set, re-fetch the current scene
 *  (releases stale players first — PLAYER_STATE.md §2). */
export function resumePlayback(): void {
  if (needsContentRefresh) {
    needsContentRefresh = false;
    stopAll();
    uiState.value = { ...uiState.value, phase: 'DOWNLOADING' };
    playNext();
    return;
  }
  isPaused = false;
  enginePaused.value = false;
  showCurrentIu();
  playAudio(currentPlayer);
  if (videoEl && videoSrcUrl && !videoEnded) {
    // Apply any unconsumed video-timeline target before starting — otherwise
    // the video could resume from a stale (possibly scene-start) position.
    if (pendingVideoTargetSec >= 0) {
      try { videoEl.currentTime = pendingVideoTargetSec; } catch { /* ignore */ }
      pendingVideoTargetSec = -1;
    }
    try { void videoEl.play().catch(() => { }); } catch { /* ignore */ }
  }
  uiState.value = { ...uiState.value, phase: 'PLAYING' };
  startIuCycling();
}

/** Handle a media error (PlaybackViewModel.handlePlaybackError). */
export function handlePlaybackError(errorMsg: string): void {
  stopAll();
  uiState.value = { ...uiState.value, phase: 'SCENE_READY', errorMessage: errorMsg };
}

/** Handle a null player (PlaybackViewModel.handleNullPlayer). */
export function handleNullPlayer(sceneKey: string): void {
  stopAll();
  uiState.value = { ...uiState.value, phase: 'SCENE_READY', errorMessage: `Audio playback failed for ${sceneKey}` };
}

/** Big play button (fragment onViewCreated playButton click — 1:1 branches). */
export function handlePlayButton(): void {
  const phase = uiState.value.phase;
  if (phase === 'PLAYING' && currentPlayer == null) {
    resumeFromCurrentScene();
  } else if (phase === 'PLAYING' && !isPaused) {
    pausePlayback();
  } else if (phase === 'PLAYING' && isPaused) {
    resumePlayback();
  } else if (phase === 'PAUSED') {
    resumePlayback();
  } else if (phase === 'SCENE_READY' && needsRotationResume) {
    resumeFromCurrentScene();
  } else if (phase === 'SCENE_READY') {
    if (currentIndex >= sceneQueue.value.length) playSceneQueue();
    else if (currentIndex > 0) resumeFromCurrentScene();
    else playSceneQueue();
  } else if (phase === 'IDLE' && sceneQueue.value.length > 0) {
    playSceneQueue();
  }
}

/** Fragment.onHiddenChanged(hidden=true) — pause when the Play tab is left. */
export function pauseIfPlaying(): void {
  const phase = uiState.value.phase;
  if (phase === 'PLAYING' && !isPaused) {
    if (currentPlayer == null && currentIuSequence.value != null) {
      cancelIuCycling();
      isPaused = true;
      enginePaused.value = true;
    } else {
      pausePlayback();
    }
  }
}

/** Fragment.checkPendingExternalSeek — executed on PlayPage mount. */
export function checkPendingExternalSeek(): void {
  if (pendingExternalSeek.value) {
    pendingLoad = true;
    stopAll();
    executePendingSeek();
  }
}

/** PlaybackViewModel.seekToPosition (external seek from Navigate/Edit):
 *  scene in queue → pendingExternalSeek; scene missing → refresh queue from
 *  book JSON; still missing → missingIuPosition overlay. */
export async function seekToPosition(chapterId: string, sceneId: string, unitIndex: number, unitId: string | null = null): Promise<void> {
  const sceneKey = `${chapterId}:${sceneId}`;
  const idx = sceneQueue.value.findIndex((s) => sceneKeyOf(s) === sceneKey);
  if (idx >= 0) {
    missingIuPosition.value = null;
    pendingExternalSeek.value = { chapterId, sceneId, unitId, chunkId: sceneKey, unitIndex };
    uiState.value = { ...uiState.value, currentIndex: idx };
    // Android parity (PlaybackViewModel.kt: currentIndex = idx): the internal
    // engine index must move too — executePendingSeek/playNext read THIS var,
    // and without it the player would start from the old (beginning) scene.
    currentIndex = idx;
    return;
  }

  const bId = bookId.value;
  if (!bId) {
    missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
    pendingExternalSeek.value = null;
    return;
  }
  try {
    const bookData = await getJson<BookData>(`/book/${enc(bId)}`);
    const allScenes = sceneRefs(bookData);
    const allKeys = allScenes.map(sceneKeyOf);
    const newIdx = allKeys.indexOf(sceneKey);
    if (newIdx >= 0) {
      sceneQueue.value = allScenes;
      missingIuPosition.value = null;
      pendingExternalSeek.value = { chapterId, sceneId, unitId, chunkId: sceneKey, unitIndex };
      uiState.value = { ...uiState.value, currentIndex: newIdx, sceneCount: allScenes.length };
      // Android parity (PlaybackViewModel.kt: currentIndex = newIdx after refresh).
      currentIndex = newIdx;
    } else {
      missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
      pendingExternalSeek.value = null;
    }
  } catch {
    missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
    pendingExternalSeek.value = null;
  }
}

export function clearMissingIu(): void {
  missingIuPosition.value = null;
}

/** PlaybackViewModel.executePendingSeek — full pipeline (phase DOWNLOADING →
 *  playNext); the caller sets pendingLoad so the fresh player stays paused. */
export function executePendingSeek(): void {
  const seek = pendingExternalSeek.value;
  if (!seek) return;
  pendingExternalSeek.value = null;

  // Derive the index from the seek itself (chunkId IS the scene key) instead of
  // trusting the module-level currentIndex — restoreSavedPositionIfAny on Play
  // mount can clobber it between seekToPosition and here, which would play the
  // restored scene instead of the selected one (web hardening; Android runs the
  // same look-up when refreshing the queue).
  const sceneIdx = sceneQueue.value.findIndex((s) => sceneKeyOf(s) === seek.chunkId);
  if (sceneIdx < 0) {
    playSceneQueue();
    return;
  }
  currentIndex = sceneIdx;
  missingIuPosition.value = null;
  isExecutingExternalSeek = true;
  pendingExplicitUnitTarget = true;
  currentUnitIndex = seek.unitIndex;
  navigateTo({ ...seek });
  needsContentRefresh = false;
  bumpSceneEpoch();
  uiState.value = { ...uiState.value, phase: 'DOWNLOADING', currentUnitIndex: seek.unitIndex };
  clearPreloadCache();
  preloadAhead(true);
  playNext();
}

/** PlaybackViewModel.closeBook + clearPlaybackState. */
export function closeBook(): void {
  bumpSceneEpoch();
  stopAll();
  clearPreloadCache();
  if (coverImage.value) URL.revokeObjectURL(coverImage.value);
  if (previewImage.value) URL.revokeObjectURL(previewImage.value);
  bookId.value = '';
  buildId.value = '';
  sceneQueue.value = [];
  missingIuPosition.value = null;
  pendingExternalSeek.value = null;
  coverImage.value = null;
  previewImage.value = null;
  currentIuSequence.value = null;
  currentIuBlobUrl.value = null;
  subtitleText.value = null;
  iuMissing.value = false;
  currentIndex = 0;
  currentUnitIndex = 0;
  currentIuIndex = 0;
  sessionStorage.removeItem(SAVED_POS_KEY);
  navigateTo({ chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0 });
  uiState.value = { ...initial };
}

// ── Layer toggles (fragment layer chip listeners) ──
export function setLayerAudio(v: boolean): void {
  layerAudio.value = v;
  currentVolume = v ? 1 : 0;
  if (currentPlayer) currentPlayer.volume = currentVolume;
  if (nextPlayer) nextPlayer.volume = currentVolume;
  if (videoEl) videoEl.volume = currentVolume;
}
export function setLayerImage(v: boolean): void {
  layerImage.value = v;
  updateLayers();
  if (v) {
    const ius = currentIuSequence.value;
    if (ius && ius.length && currentIuIndex < ius.length) showIu(ius[currentIuIndex]);
  }
}
export function setLayerVideo(v: boolean): void {
  layerVideo.value = v;
  updateLayers();
  // Layer re-enabled mid-scene: if the current scene has a backend video that
  // was never fetched (layer was off → we skipped it to save traffic), fetch it
  // now and attach it synced to the audio position.
  if (v) {
    const key = getCurrentSceneKey();
    if (key && activeScene?.videoReady) {
      ensureSceneVideo(key, null);
    }
  }
}
export function setLayerSubtitles(v: boolean): void {
  layerSubtitles.value = v;
  updateSubtitleVisibility();
}

// ── Video element adoption (PlayPage mounts/unmounts) ──
export function attachVideo(el: HTMLVideoElement): void {
  detachVideo();
  videoEl = el;
  el.addEventListener('ended', onVideoEnded);
  el.addEventListener('error', onVideoError);
  if (videoSrcUrl) {
    currentVideoSceneKey = getCurrentSceneKey();
    el.src = videoSrcUrl;
    // Prefer the explicit video-timeline target while one is pending; the
    // audio currentTime can still be unseeked (0) right after a unit seek.
    if (pendingVideoTargetSec >= 0) {
      try { el.currentTime = pendingVideoTargetSec; } catch { /* not ready */ }
    } else {
      const cur = currentPlayer?.currentTime ?? 0;
      if (cur > 0) { try { el.currentTime = cur; } catch { /* not ready */ } }
    }
    if (!isPaused && uiState.value.phase === 'PLAYING') {
      try { void el.play().catch(() => { }); } catch { /* ignore */ }
    }
  }
  updateLayers();
}
export function detachVideo(): void {
  if (videoEl) {
    videoEl.removeEventListener('ended', onVideoEnded);
    videoEl.removeEventListener('error', onVideoError);
    try { videoEl.pause(); } catch { /* ignore */ }
    videoEl.removeAttribute('src');
    videoEl = null;
  }
  currentVideoSceneKey = null;
  updateLayers();
}

// ═══════════════════════════════════════════════════════════════
//  INTERNAL — playback logic (PlaybackViewModel internals)
// ═══════════════════════════════════════════════════════════════

function playNext(): void {
  if (currentIndex >= sceneQueue.value.length) {
    currentIndex = 0;
    cancelIuCycling();
    uiState.value = { ...uiState.value, phase: 'SCENE_READY', currentIndex: 0 };
    return;
  }
  const ref = sceneQueue.value[currentIndex];
  const sceneKey = sceneKeyOf(ref);
  const chId = ref.chapterId ?? '';
  const scId = ref.sceneId ?? '';

  if (!isExecutingExternalSeek) {
    currentUnitIndex = 0;
    navigateTo({ chapterId: chId, sceneId: scId, unitId: null, chunkId: sceneKey, unitIndex: 0 });
  }
  isExecutingExternalSeek = false;

  const cached = preloadCache.get(`${buildId.value}_${sceneKey}`);
  if (cached) {
    preloadCache.delete(`${buildId.value}_${sceneKey}`);
    emitScene(cached);
    preloadAhead();
    return;
  }

  uiState.value = { ...uiState.value, phase: 'DOWNLOADING' };
  const epoch = sceneEpoch;
  void retryWithBackoff(() => fetchSceneData(sceneKey), 3, 1000, 5000)
    .then((data) => {
      if (epoch !== sceneEpoch) { revokeSceneUrls(data); return; }
      if (needsContentRefresh) { revokeSceneUrls(data); return; }
      previewImage.value = null;
      emitScene(data);
      preloadAhead();
    })
    .catch((e: unknown) => {
      if (epoch !== sceneEpoch) return;
      const msg = `Scene ${sceneKey}: ${(e as Error).message}`;
      uiState.value = { ...uiState.value, phase: 'SCENE_READY', errorMessage: msg };
    });
}

function emitScene(scene: PreloadedScene): void {
  const seq = ++sceneSeqCounter;
  uiState.value = {
    ...uiState.value,
    phase: 'PLAYING',
    chunkSequence: seq,
    errorMessage: null,
    currentIndex,
  };
  processPendingScene(scene);
  // The previous scene's object URLs are no longer displayed (handleChunk/
  // handleSilentChunk replaced currentIuSequence / released the players) —
  // revoke them so long playthroughs don't accumulate blob URLs.
  const prev = activeScene;
  activeScene = scene;
  if (prev && prev !== scene) revokeSceneUrls(prev);
}

/** Fragment observeState collector equivalent: PLAYING + new chunk sequence →
 *  handleChunk (audio) or handleSilentChunk (silent scene, e.g. Cover). */
function processPendingScene(scene: PreloadedScene): void {
  if (uiState.value.chunkSequence <= lastProcessedSceneSequence) return;
  lastProcessedSceneSequence = uiState.value.chunkSequence;
  if (scene.audio.size > 0) {
    handleChunk(scene);
  } else if (scene.iuSequence.length > 0) {
    handleSilentChunk(scene.iuSequence);
  }
}

/** Preload 3 scenes ahead (PRELOAD_AHEAD=3), parallel fetch, single attempt
 *  each (PlaybackViewModel.preloadAhead). Chained mid-scene via the
 *  observePreloadCompletion equivalent. */
function preloadAhead(includeCurrent = false): void {
  const bld = buildId.value;
  if (!bld) return;
  const token = ++preloadJobToken;
  const start = includeCurrent ? 0 : 1;
  const scenesToPreload: SceneRef[] = [];
  for (let offset = start; offset <= PRELOAD_AHEAD; offset++) {
    const ref = sceneQueue.value[currentIndex + offset];
    if (!ref) break;
    if (!preloadCache.has(`${bld}_${sceneKeyOf(ref)}`)) scenesToPreload.push(ref);
  }
  if (scenesToPreload.length === 0) return;

  void Promise.all(scenesToPreload.map(async (ref) => {
    const key = `${bld}_${sceneKeyOf(ref)}`;
    try {
      const data = await fetchSceneData(sceneKeyOf(ref));
      if (token !== preloadJobToken) { revokeSceneUrls(data); return; }
      preloadCache.set(key, data);
      // observePreloadCompletion: if a player is running with no chained next,
      // attach the freshly preloaded scene for a gapless −200ms switch.
      if (currentPlayer && !nextChainReady && nextPlayer == null) preloadAheadAudio();
    } catch {
      /* load on demand via playNext */
    }
  }));
}

// Raw scene assets shared by concurrent fetches of the same scene (preload +
// playNext + quick re-taps). The network download happens ONCE; each caller of
// fetchSceneData gets its own PreloadedScene with freshly created object URLs,
// so revoking one caller's URLs (stale-token drop) never breaks another's.
interface RawIu {
  blob: Blob | null;
  durationMs: number;
  unitId: string | null;
  text: string | null;
  status: IuStatus;
  startMs: number | null;
}
interface SceneAssets {
  audio: Blob;
  videoReady: boolean;
  iuSequence: RawIu[];
}
const inflightAssets = new Map<string, Promise<SceneAssets>>();

/** fetchSceneAssets: status → audio/IU in parallel; throws when audio isn't
 *  ready (retryWithBackoff in playNext re-tries). Media blobs go through the
 *  Cache API keyed `${buildId}_${sceneKey}` (SimpleDiskCache equivalent).
 *  Video is deliberately NOT part of the bundle — it is fetched on demand by
 *  ensureSceneVideo only when the scene actually plays with the video layer on
 *  (saves ~43 MB per preloaded/skipped scene). */
async function fetchSceneAssets(sceneKey: string): Promise<SceneAssets> {
  const [chId, scId] = sceneKey.split(':', 2);
  const status = await getJson<SceneStatusResponse>(scenePath(chId, scId, 'status')).catch(() => null);
  if (!status || !status.audio_ready) {
    throw new Error(`Audio not ready for ${sceneKey}`);
  }

  const [audio, iuSequence] = await Promise.all([
    getSceneAudioBlob(chId, scId, sceneKey),
    fetchIuSequence(chId, scId),
  ]);
  return { audio, videoReady: !!status.video_ready, iuSequence };
}

/** fetchSceneData: shared fetch of scene assets + per-call object URLs. */
async function fetchSceneData(sceneKey: string): Promise<PreloadedScene> {
  const bld = buildId.value;
  const mapKey = `${bld}_${sceneKey}`;
  let promise = inflightAssets.get(mapKey);
  if (!promise) {
    promise = fetchSceneAssets(sceneKey);
    inflightAssets.set(mapKey, promise);
    promise.catch(() => { }).finally(() => { inflightAssets.delete(mapKey); });
  }
  const assets = await promise;
  return {
    audio: assets.audio,
    audioUrl: URL.createObjectURL(assets.audio),
    videoReady: assets.videoReady,
    iuSequence: assets.iuSequence.map((iu) => ({
      blobUrl: iu.blob ? URL.createObjectURL(iu.blob) : null,
      durationMs: iu.durationMs,
      unitId: iu.unitId,
      text: iu.text,
      status: iu.status,
      startMs: iu.startMs,
    })),
  };
}

async function getSceneAudioBlob(chId: string, scId: string, sceneKey: string): Promise<Blob> {
  const bld = buildId.value;
  const cached = await getMedia(bld, sceneKey, 'audio');
  if (cached) return cached;
  try {
    const blob = await getBlob(scenePath(chId, scId, 'audio'));
    void putMedia(bld, sceneKey, 'audio', blob);
    return blob;
  } catch {
    // Android Repository.getSceneAudio failure → byteArrayOf() → silent scene
    // (timer-based IU cycling via handleSilentChunk). Match that instead of
    // hard-erroring the whole scene.
    return new Blob([]);
  }
}

/** fetchIuSequence: storyboard → each IU image blob (placeholder on failure,
 *  never skip the index — DONT_DO #3). */
async function fetchIuSequence(chapterId: string, sceneId: string): Promise<RawIu[]> {
  try {
    const sb = await getJson<StoryboardResponse>(scenePath(chapterId, sceneId, 'storyboard'));
    if (!sb.ius || sb.ius.length === 0) return [];
    return await Promise.all(sb.ius.map(async (iu) => {
      const durationMs = iu.duration_ms ?? 200; // N1: server-computed; floor fallback
      const text = iu.text ?? null;
      const startMs = iu.start_ms ?? null;
      try {
        const blob = await getIuImageBlob(chapterId, sceneId, iu.unit_id);
        return { blob, durationMs, unitId: iu.unit_id ?? null, text, status: 'READY' as IuStatus, startMs };
      } catch {
        return { blob: null, durationMs, unitId: iu.unit_id ?? null, text, status: 'NOT_GENERATED' as IuStatus, startMs };
      }
    }));
  } catch {
    return [];
  }
}

async function getIuImageBlob(chId: string, scId: string, unitId: string): Promise<Blob> {
  const bld = buildId.value;
  const key = `${chId}:${scId}:${unitId}`;
  const cached = await getMedia(bld, key, 'iu');
  if (cached) return cached;
  const blob = await getBlob(iuPath(bookId.value, bld, chId, scId, unitId));
  void putMedia(bld, key, 'iu', blob);
  return blob;
}

/** tryPreloadNextScene / getPreloadedScene. */
function getPreloadedScene(index: number): PreloadedScene | null {
  const ref = sceneQueue.value[index];
  if (!ref) return null;
  return preloadCache.get(`${buildId.value}_${sceneKeyOf(ref)}`) ?? null;
}
function tryPreloadNextScene(): PreloadedScene | null {
  return getPreloadedScene(currentIndex + 1);
}

/** onAudioCompleted — advance to the next scene. */
function onAudioCompleted(): void {
  currentIndex++;
  playNext();
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE — fragment MediaPlayer management (PlayFragment.kt)
// ═══════════════════════════════════════════════════════════════

function ensureHost(): HTMLDivElement {
  if (!engineHost) {
    engineHost = document.createElement('div');
    engineHost.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(engineHost);
  }
  return engineHost;
}

function createAudio(url: string): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.volume = currentVolume;
  el.src = url;
  ensureHost().appendChild(el);
  return el;
}
function playAudio(el: HTMLAudioElement | null): void {
  if (!el) return;
  try { void el.play().catch(() => { }); } catch { /* ignore */ }
}
function pauseAudio(el: HTMLAudioElement | null): void {
  if (!el) return;
  try { el.pause(); } catch { /* ignore */ }
}
function seekAudio(el: HTMLAudioElement, ms: number): void {
  try { el.currentTime = ms / 1000; } catch { /* ignore */ }
}

/** Release an audio element (fragment MediaPlayer.release equivalent): drop
 *  listeners, unload src and remove it from the hidden host so elements don't
 *  accumulate while the queue plays. */
function releaseAudioEl(el: HTMLAudioElement | null): void {
  if (!el) return;
  el.removeEventListener('ended', onTrackEnd);
  el.removeEventListener('error', onAudioError);
  try { el.pause(); } catch { /* ignore */ }
  el.removeAttribute('src');
  try { el.load(); } catch { /* ignore */ }
  el.remove();
}

/** handleChunk — deliver a scene with audio: set IU sequence, create the first
 *  player or chain the next one, seek to the target unit (sum of durationMs). */
function handleChunk(scene: PreloadedScene): void {
  // Compute the target position on the CANONICAL timeline (audio/start_ms)
  // BEFORE touching any player. The whole-scene video is aligned to the audio
  // timeline at merge time (group clips are trimmed to their exact audio frame
  // counts), so BOTH the audio and the video seek to the same position — the
  // final muxed product has a single timeline. Priority: externally selected
  // unit → rotation-resume.
  const ius = scene.iuSequence;
  const targetUnit = currentUnitIndex;
  const seekToUnit = targetUnit > 0 && ius.length > 0 && targetUnit < ius.length ? targetUnit : 0;
  const pendingRotMs = pendingSeekPositionMs;
  const seekMs = seekToUnit > 0 && ius.length > 0 ? unitStartMs(ius, seekToUnit)
    : pendingRotMs > 0 ? pendingRotMs : 0;
  if (seekMs > 0) pendingSeekPositionMs = -1;
  if (seekToUnit > 0 && ius.length > 0) {
    console.info(`[PLAY] UNIT-SEEK unit=${ius[seekToUnit].unitId} index=${seekToUnit} ` +
      `startMs=${ius[seekToUnit].startMs} seekMs=${seekMs}`);
  }

  // An external unit tap (or rotation resume) is an EXPLICIT video target —
  // including 0 for unit 1 — so the video is seeked to it directly instead of
  // falling into the audio-sync branch (which leaves a reused <video> element
  // stuck at its old position when the same scene URL is re-assigned).
  const explicitVideoSeekMs: number | null =
    (pendingExplicitUnitTarget || pendingRotMs > 0) ? seekMs : null;
  pendingExplicitUnitTarget = false;
  // Video is streamed ON DEMAND from its direct HTTP URL (ensureSceneVideo) —
  // never downloaded as part of the scene bundle. If the video for this scene
  // is already attached (same-scene unit navigation), just seek it to the unit
  // target without re-src'ing the element.
  if (scene.videoReady && layerVideo.value) {
    if (!seekAttachedVideo(explicitVideoSeekMs)) {
      ensureSceneVideo(getCurrentSceneKey(), explicitVideoSeekMs);
    }
  }

  currentIuSequence.value = ius;
  currentIuIndex = seekToUnit;
  uiState.value = { ...uiState.value, currentUnitIndex: seekToUnit };
  if (ius.length > 0) {
    showIu(ius[seekToUnit]);
  } else {
    showIuMissing();
    updateSubtitleIfEnabled(null);
  }

  if (nextChainReady && currentPlayer) {
    nextChainReady = false;
    preloadAheadAudio();
    sceneTransitionPending = true;
    return;
  }

  if (currentPlayer == null) {
    const el = createAudio(scene.audioUrl);
    el.addEventListener('ended', onTrackEnd);
    el.addEventListener('error', onAudioError);
    currentPlayer = el;

    if (pendingLoad) {
      pendingLoad = false;
      isPaused = true;
      enginePaused.value = true;
      pauseAudio(el);
      uiState.value = { ...uiState.value, phase: 'PAUSED' };
    } else {
      playAudio(el);
    }
    if (seekMs > 0) {
      seekAudio(el, seekMs);
    } else if (pendingSeekPositionMs > 0) {
      seekAudio(el, pendingSeekPositionMs);
      pendingSeekPositionMs = -1;
    }
    if (currentPlayer) startIuCycling();
    else if (ius.length > 0) startSilentIuCycling();
    preloadAheadAudio();
  } else {
    preloadNext(scene);
    sceneTransitionPending = true;
    startIuCycling();
  }
  updateLayers();
}

/** Start offset (ms) of a unit on the whole-scene timeline (audio = start_ms,
 *  the canonical position — the video is aligned to the same timeline at merge
 *  time). Falls back to cumulative durationMs for legacy storyboards. */
function unitStartMs(ius: IuImageItem[], unitIndex: number): number {
  const startMs = ius[unitIndex]?.startMs;
  if (startMs != null && startMs > 0) return startMs;
  let seekMs = 0;
  for (let i = 0; i < unitIndex; i++) seekMs += ius[i].durationMs;
  return seekMs;
}

/** handleSilentChunk — no audio: release players, timer-based IU cycling. */
function handleSilentChunk(ius: IuImageItem[]): void {
  stopAll();
  currentIuSequence.value = ius;
  currentIuIndex = 0;
  uiState.value = { ...uiState.value, currentUnitIndex: 0 };
  if (ius.length > 0) {
    showIu(ius[0]);
  }
  isPaused = false;
  enginePaused.value = false;
  startSilentIuCycling();
  updateLayers();
}

/** preloadAheadAudio — chain the next scene's audio (gapless option A). */
function preloadAheadAudio(): void {
  const next = tryPreloadNextScene();
  if (!next) return;
  preloadNext(next);
  nextChainReady = true;
  sceneTransitionPending = true;
}

/** preloadNext — (re)create nextPlayer with the given scene audio. */
function preloadNext(scene: PreloadedScene): void {
  releaseAudioEl(nextPlayer);
  if (scene.audio.size === 0) {
    nextPlayer = null;
    return;
  }
  const el = createAudio(scene.audioUrl);
  el.addEventListener('ended', onTrackEnd);
  el.addEventListener('error', onAudioError);
  nextPlayer = el;
}

/** startIuCycling — RAF over audio.currentTime vs cumulative durationMs
 *  (06 §1.3 A; DONT_DO #1/#3: never stall audio for an image, never skip IU). */
function startIuCycling(): void {
  cancelIuCycling();
  const tick = () => {
    iuRafId = requestAnimationFrame(tick);
    const ius = currentIuSequence.value;
    const player = currentPlayer;
    if (!ius || ius.length === 0 || !player) return;
    if (isPaused) return;

    const pos = player.currentTime * 1000;
    const dur = (player.duration && isFinite(player.duration) ? player.duration : 0) * 1000;
    if (dur <= 0) return;

    // Early gapless switch −200ms before scene end (PlayFragment.kt:893).
    // Gate on nextPlayer: after a promotion the flag can briefly stay true with
    // nextPlayer already consumed (DOWNLOADING window) — never advance twice.
    if (pos >= dur - 200 && sceneTransitionPending && nextPlayer != null) {
      sceneTransitionPending = false;
      switchToNextPlayer();
      return;
    }

    // Map audio position → unit index on the same timeline the seek uses:
    // server start_ms boundaries when present, else cumulative durationMs.
    let idx = 0;
    if (ius[0]?.startMs != null) {
      for (let i = 0; i < ius.length; i++) {
        if ((ius[i].startMs ?? 0) <= pos) idx = i;
        else break;
      }
      if (idx >= ius.length) idx = ius.length - 1;
    } else {
      let cumulative = 0;
      for (let i = 0; i < ius.length; i++) {
        cumulative += ius[i].durationMs;
        if (pos < cumulative) { idx = i; break; }
      }
      if (idx >= ius.length) idx = ius.length - 1;
    }
    if (idx === 0 && currentIuIndex !== 0) return;
    if (idx !== currentIuIndex) {
      currentIuIndex = idx;
      if (isPaused) return;
      uiState.value = { ...uiState.value, currentUnitIndex: idx };
      const item = ius[idx];
      showIu(item);
      navigateTo({
        chapterId: currentChapterId(),
        sceneId: currentSceneId(),
        unitId: item.unitId,
        chunkId: getCurrentSceneKey(),
        unitIndex: idx,
      });
    }
  };
  iuRafId = requestAnimationFrame(tick);
}

/** startSilentIuCycling — timer-based cycling for scenes without audio. */
function startSilentIuCycling(): void {
  cancelIuCycling();
  const loop = () => {
    if (isPaused) { silentTimer = window.setTimeout(loop, 500); return; }
    const ius = currentIuSequence.value;
    if (!ius || ius.length === 0) { silentTimer = window.setTimeout(loop, 500); return; }
    if (currentIuIndex >= ius.length) { silentTimer = window.setTimeout(loop, 500); return; }
    // No images at all → idle-poll slowly (still never stalls anything).
    if (ius.every((it) => it.status !== 'READY' && !it.blobUrl)) {
      silentTimer = window.setTimeout(loop, 5000);
      return;
    }
    const dur = ius[currentIuIndex].durationMs;
    silentTimer = window.setTimeout(() => {
      if (isPaused || ius !== currentIuSequence.value) return;
      const nextIdx = (currentIuIndex + 1) % ius.length;
      currentIuIndex = nextIdx;
      uiState.value = { ...uiState.value, currentUnitIndex: nextIdx };
      showIu(ius[nextIdx]);
      navigateTo({
        chapterId: currentChapterId(),
        sceneId: currentSceneId(),
        unitId: ius[nextIdx].unitId,
        chunkId: getCurrentSceneKey(),
        unitIndex: nextIdx,
      });
    }, dur);
  };
  loop();
}

function cancelIuCycling(): void {
  if (iuRafId) cancelAnimationFrame(iuRafId);
  iuRafId = 0;
  if (silentTimer != null) clearTimeout(silentTimer);
  silentTimer = null;
}

/** switchToNextPlayer — promote nextPlayer at the −200ms early switch. */
function switchToNextPlayer(): void {
  currentIuIndex = 0;
  subtitleText.value = null;
  releaseAudioEl(currentPlayer);
  currentPlayer = nextPlayer;
  nextPlayer = null;
  if (currentPlayer) {
    if (isPaused) pauseAudio(currentPlayer);
    else playAudio(currentPlayer);
    startIuCycling();
  }
  onAudioCompleted();
}

/** onTrackEnd — natural end of the current audio: promote next, or show the
 *  cover-only state at the end of the queue. */
function onTrackEnd(): void {
  cancelIuCycling();
  releaseAudioEl(currentPlayer);
  currentPlayer = nextPlayer;
  nextPlayer = null;
  if (currentPlayer) {
    currentIuIndex = 0;
    subtitleText.value = null;
    if (isPaused) pauseAudio(currentPlayer);
    else playAudio(currentPlayer);
    startIuCycling();
  } else {
    showCoverOnly();
  }
  onAudioCompleted();
}

/** Audio element error — reset to SCENE_READY so the user can retry. */
function onAudioError(): void {
  isPaused = false;
  enginePaused.value = false;
  handlePlaybackError('Audio playback error');
}

function showCurrentIu(): void {
  const ius = currentIuSequence.value;
  if (!ius || ius.length === 0) return;
  const idx = Math.max(0, Math.min(currentUnitIndex, ius.length - 1));
  showIu(ius[idx]);
}

function showIu(item: IuImageItem): void {
  // Image and subtitle are updated INDEPENDENTLY (Android: showIuImage(item)
  // + updateSubtitleIfEnabled(item.text) are separate calls). A unit whose
  // image is missing/not-generated still shows its subtitle when the subtitles
  // layer is on — hiding the text with the image was a web bug (subtitle would
  // only appear after toggling the chip, because updateSubtitleVisibility reads
  // the text directly from the sequence bypassing image readiness).
  if (item.blobUrl && item.status === 'READY') {
    currentIuBlobUrl.value = item.blobUrl;
    iuMissing.value = false;
  } else {
    currentIuBlobUrl.value = null;
    iuMissing.value = true;
  }
  updateSubtitleIfEnabled(item.text);
}

function showIuMissing(): void {
  currentIuBlobUrl.value = null;
  iuMissing.value = true;
}

function showCoverOnly(): void {
  currentIuBlobUrl.value = null;
  iuMissing.value = false;
  subtitleText.value = null;
}

function updateSubtitleIfEnabled(text: string | null): void {
  subtitleText.value = layerSubtitles.value && text != null ? text : null;
}

function updateSubtitleVisibility(): void {
  const ius = currentIuSequence.value;
  const text = layerSubtitles.value && ius && currentIuIndex < ius.length ? ius[currentIuIndex].text : null;
  subtitleText.value = text ?? null;
}

/** updateLayers — videoSurface visibility (image layer handled in render). */
function updateLayers(): void {
  videoVisible.value = !!videoEl && !!videoSrcUrl && !videoEnded && layerVideo.value;
}

/** seekAttachedVideo — same whole-scene video (unit navigation within a
 *  scene): do NOT re-src the element — the browser keeps the current frame
 *  visible through the seek, so the new unit's frame replaces it directly (no
 *  black/storyboard gap). Returns true when the video for the current scene is
 *  already attached and was seeked; false when no video is attached yet. */
function seekAttachedVideo(explicitSeekMs: number | null): boolean {
  const sceneKey = getCurrentSceneKey();
  if (!videoEl || currentVideoSceneKey == null || sceneKey == null || sceneKey !== currentVideoSceneKey) {
    return false;
  }
  videoEnded = false;
  pendingVideoTargetSec = explicitSeekMs != null ? explicitSeekMs / 1000 : -1;
  applyVideoSeek(explicitSeekMs);
  if (!isPaused && !pendingLoad && uiState.value.phase === 'PLAYING') {
    try { void videoEl.play().catch(() => { }); } catch { /* ignore */ }
  }
  updateLayers();
  return true;
}

/** ensureSceneVideo — stream the whole-scene video for sceneKey from its
 *  direct HTTP URL on the <video> element (PROGRESSIVE DOWNLOAD: the browser
 *  fetches the moov atom + first samples and starts decoding while the rest
 *  keeps downloading; seeks are served by backend Range/206 requests — the
 *  files are faststart'd, see docs/05-frontend/VIDEO_LOADING_RESEARCH.md).
 *  Skipped when the video layer is off or the video is already attached for
 *  this scene (same-scene unit tap → just seek). No blob/Cache API roundtrip:
 *  the whole-scene MP4 (~43 MB) is never downloaded into memory ahead of
 *  playback. */
function ensureSceneVideo(sceneKey: string | null, explicitSeekMs: number | null = null): void {
  if (!sceneKey) return;
  if (!layerVideo.value) return;
  // Already attached for this scene (e.g. re-emit after a same-scene unit tap)
  // — just re-apply the seek target.
  if (seekAttachedVideo(explicitSeekMs)) return;
  const [chId, scId] = sceneKey.split(':', 2);
  playVideoOverlay(API_BASE + scenePath(chId, scId, 'video'), explicitSeekMs);
}

/** playVideoOverlay — load the scene video on the adopted <video> element.
 *  With an explicit target (unit navigation / rotation resume) seek to the
 *  timeline position and keep it; otherwise (normal playback) sync to the
 *  audio position. Reading the audio currentTime as the target here is racy —
 *  right after a unit seek the audio element is not seeked yet (seek is
 *  async), which left the video at 0 ("2nd unit → start of video"). */
function playVideoOverlay(url: string, explicitSeekMs: number | null = null): void {
  // Same whole-scene video already attached — redundant src, just seek.
  if (seekAttachedVideo(explicitSeekMs)) return;
  videoSrcUrl = url;
  currentVideoSceneKey = getCurrentSceneKey();
  videoEnded = false;
  // Explicit target in seconds — 0 is a valid target (unit 1 / scene start).
  // null = no explicit target → audio-sync fallback in applyVideoSeek.
  pendingVideoTargetSec = explicitSeekMs != null ? explicitSeekMs / 1000 : -1;
  if (!videoEl) { updateLayers(); return; }
  videoEl.src = url;
  applyVideoSeek(explicitSeekMs);
  // currentTime set before metadata loads is unreliable in some browsers —
  // re-apply once the metadata is ready.
  const onMeta = () => {
    videoEl?.removeEventListener('loadedmetadata', onMeta);
    applyVideoSeek(explicitSeekMs);
  };
  videoEl.addEventListener('loadedmetadata', onMeta);
  if (!isPaused && !pendingLoad && uiState.value.phase === 'PLAYING') {
    try { void videoEl.play().catch(() => { }); } catch { /* ignore */ }
  }
  updateLayers();
}

/** Seek the adopted video element to an explicit position (ms on the VIDEO
 *  timeline) when one is given — INCLUDING 0 — else sync to the audio
 *  position (late-loaded video during chained scene playback). */
function applyVideoSeek(explicitSeekMs: number | null): void {
  const el = videoEl;
  if (!el) return;
  if (explicitSeekMs != null) {
    try { el.currentTime = explicitSeekMs / 1000; } catch { /* ignore */ }
  } else {
    const cur = currentPlayer?.currentTime ?? 0;
    if (cur > 0) { try { el.currentTime = cur; } catch { /* ignore */ } }
  }
}

function onVideoEnded(): void {
  videoEnded = true;
  updateLayers();
}

/** Stream failed (e.g. the video file 404s despite a stale video_ready status,
 *  or a transient network error) — drop the src so the storyboard layer shows
 *  instead of a black element. */
function onVideoError(): void {
  videoSrcUrl = null;
  updateLayers();
}

/** stopAll — fragment.stopAll(): release players, reset engine flags. */
export function stopAll(): void {
  cancelIuCycling();
  currentIuSequence.value = null;
  currentIuBlobUrl.value = null;
  subtitleText.value = null;
  iuMissing.value = false;
  currentIuIndex = 0;
  sceneTransitionPending = false;
  nextChainReady = false;
  releaseAudioEl(currentPlayer);
  currentPlayer = null;
  releaseAudioEl(nextPlayer);
  nextPlayer = null;
  if (videoEl) {
    try { videoEl.pause(); } catch { /* ignore */ }
    videoEl.removeAttribute('src');
  }
  videoSrcUrl = null;
  videoEnded = false;
  pendingVideoTargetSec = -1;
  currentVideoSceneKey = null;
  isPaused = false;
  enginePaused.value = false;
  updateLayers();
}

// ═══════════════════════════════════════════════════════════════
//  LIFECYCLE — Page Visibility + position persistence (06 §1.8)
// ═══════════════════════════════════════════════════════════════

function savePlaybackPosition(): void {
  const posMs = currentPlayer ? Math.round(currentPlayer.currentTime * 1000) : 0;
  if (posMs <= 0 && uiState.value.phase !== 'PLAYING') return;
  try {
    sessionStorage.setItem(SAVED_POS_KEY, JSON.stringify({
      bookId: bookId.value,
      buildId: buildId.value,
      index: currentIndex,
      posMs,
    } satisfies SavedPosition));
  } catch { /* storage unavailable */ }
}

function applyRestoredPosition(saved: SavedPosition): void {
  savedPlaybackPositionMs = saved.posMs;
  needsRotationResume = true;
  pendingSeekPositionMs = saved.posMs;
  stopAll();
  currentIndex = Math.min(saved.index, Math.max(0, sceneQueue.value.length - 1));
  uiState.value = { ...uiState.value, phase: 'SCENE_READY', currentIndex, currentUnitIndex: 0 };
}

/** Restore a saved playback position (pagehide → pageshow / fresh load).
 *  Call from PlayPage on mount; pageshow listener covers bfcache restores. */
export function restoreSavedPositionIfAny(): void {
  let saved: SavedPosition | null = null;
  try {
    const raw = sessionStorage.getItem(SAVED_POS_KEY);
    if (!raw) return;
    sessionStorage.removeItem(SAVED_POS_KEY);
    saved = JSON.parse(raw) as SavedPosition;
  } catch { return; }
  if (!saved || !saved.bookId) return;
  if (bookId.value === saved.bookId) {
    applyRestoredPosition(saved);
  } else if (!bookId.value) {
    // Fresh reload — ensureInitialized (from PlayPage mount) applies it.
    pendingPositionRestore = saved;
    void ensureInitialized(saved.bookId, saved.buildId);
  }
}

/** Wire lifecycle listeners once from main.tsx (onPause/onResume equivalent). */
export function wirePlaybackLifecycle(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseIfPlaying();
  });
  window.addEventListener('pagehide', () => {
    savePlaybackPosition();
  });
  window.addEventListener('pageshow', () => {
    restoreSavedPositionIfAny();
  });
}

// ── Playback coordinator (MainActivity.setupPlaybackCoordination) ──
let wired = false;
export function wirePlaybackCoordination(): void {
  if (wired) return;
  wired = true;
  onPlaybackPrepared((prep) => {
    if (prep.softRefresh) {
      refreshContent(prep.bookId, prep.buildId, prep.scenes);
    } else {
      preparePlayback(prep.bookId, prep.buildId, prep.scenes);
    }
    if (prep.coverImage != null) {
      setCoverImage(prep.coverImage);
    } else {
      // Android parity (GenerateViewModel.loadCoverBitmap +
      // PlaybackViewModel.loadCoverIntoState): the cover is (re)loaded from the
      // first scene even when the preparation payload carries no bitmap — at
      // book open AND on generation completion. A failed load (cover not
      // generated yet) leaves the curtains fallback up; a later success
      // replaces them — and a new book without a cover falls back to the
      // curtains again (preparePlayback drops the previous book's cover).
      const coverScene = prep.scenes.find((s) => s.sceneType === 'cover') ?? prep.scenes[0];
      if (coverScene) void loadCoverIntoState(coverScene.chapterId, coverScene.sceneId);
    }
  });
}

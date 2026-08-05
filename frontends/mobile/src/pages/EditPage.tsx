// EditPage — 1:1 with EditFragment.kt + fragment_edit.xml (stage 6).
//  - Position bar (include_position_bar) → /navigate on tap; label from
//    bookData + ActivePosition, unitCount shown on the right.
//  - Unit carousel: prev/current/next cards with IU previews
//    (GET /preview/...?build_id=); the img sits in normal flow (width:100%,
//    height:auto) so its own aspect ratio sets the card height — portrait
//    images always get portrait cards (Android loadPreviewImage parity),
//    "Не сгенерировано" overlay.
//  - Audio timeline panel: play/stop (scene audio via /scene/.../audio), the
//    WaveformView canvas (lib/waveform.tsx, R10) with draggable range handles,
//    and a reset-to-original button. Drag preview is local; PUT /timings on
//    release applies the server-side cascade (N2, 1:1).
//  - 7 property tabs (Scene/Audio/Unit/Characters/Voices/Locations/Global) with
//    scroll indicators; default tab = Unit (index 2).
//  - Field editors per tab (inputCard/readOnlyCard ports). Characters/Voices are
//    editable and save through dedicated endpoints (PATCH /characters/{id},
//    PATCH /voices/{id}) — the Android save path routed their keys into the
//    scene object (never persisted); web fixes it (§15).
//  - Save per tab with fixed field routing (§15): scene keys to the scene,
//    unit keys to the unit (unit_id), audio keys as audio.*, locations →
//    /locations/{id}, characters → /characters/{id}, voices → /voices/{id},
//    global → /metadata. Passport overrides go in a separate PATCH without
//    unit_id (server applies them to the scene).
//  - Dirty indicator from generateStore.dirtySummary (server diff of the last
//    regenerate); "Save *" while local edits are pending.
//  - Position changes (Navigate/AI) reload the editor; unit navigation calls
//    playbackStore.seekToPosition like the Android carousel.

import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { getJson, patchJson, postJson, putJson } from '../api/client';
import type {
  AppConfig, BookChapter, BookData, BookScene, BookUnit, CharPassport, SceneTiming, WaveformData,
} from '../api/models';
import { t, tf } from '../app/i18n';
import { navigate } from '../app/router';
import {
  bookId as bookIdSignal, buildId as buildIdSignal, dirtySummary as dirtySignal, onPlaybackPrepared,
} from '../state/generateStore';
import { navigateTo, position as positionSignal } from '../state/positionStore';
import { seekToPosition } from '../state/playbackStore';
import { Waveform } from '../lib/waveform';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconClock, IconClose, IconImageOff, IconPlay, IconReset, IconSave, IconStop } from '../app/icons';

// ── Tabs (propertyTabs) — default to Unit (index 2) like EditFragment ──
const TABS = ['edit_scene', 'edit_audio', 'edit_units_tab', 'edit_characters_tab', 'edit_voices_tab', 'edit_locations_tab', 'edit_global_tab'] as const;
const DEFAULT_TAB = 2;
const SCENE_TAB = 0;
const AUDIO_TAB = 1;
const UNITS_TAB = 2;
const CHARS_TAB = 3;
const VOICES_TAB = 4;
const LOCATIONS_TAB = 5;
const GLOBAL_TAB = 6;

const PASSPORT_OVERRIDE_FIELDS = ['base_appearance', 'detailed_appearance', 'clothing_base', 'clothing_details', 'video_tokens'];

interface OverrideBlock {
  charId: string;
  fields: Record<string, string>;
}

// ── Field label mapping (EditFragment.fieldLabel — user-facing keys only) ──
function fieldLabel(key: string): string {
  switch (key) {
    case 'type': return t('field_type');
    case 'text': return t('field_text');
    case 'audio.speaker': return t('field_speaker');
    case 'audio.text': return t('field_audio_text');
    case 'image.shot': return t('field_shot');
    case 'image.prompt': return t('field_prompt');
    case 'image.negative': return t('field_negative');
    case 'video.action': return t('field_action');
    case 'chapter_title': return t('field_chapter_title');
    case 'scene_title': return t('field_scene_title');
    case 'style': return t('field_style');
    case 'env.time': return t('field_time');
    case 'env.lighting': return t('field_lighting');
    case 'env.weather': return t('field_weather');
    case 'env.mood': return t('field_mood');
    case 'env.atmosphere': return t('field_atmosphere');
    case 'env.country': return t('field_country');
    case 'env.epoch': return t('field_epoch');
    case 'participants': return t('field_participants');
    case 'voice': return t('field_voice');
    case 'full_text': return t('field_full_text');
    case 'title': return t('field_title');
    case 'author': return t('field_author');
    case 'language': return t('field_language');
    case 'country': return t('field_country');
    case 'epoch': return t('field_epoch');
    case 'render_style': return t('field_render_style');
    case 'lighting_default': return t('field_lighting_default');
    case 'narration_voice': return t('field_narrator_instruction');
    default: return key;
  }
}

function passportFieldLabel(key: string): string {
  switch (key) {
    case 'base_appearance': return t('field_base_appearance');
    case 'detailed_appearance': return t('field_detailed_appearance');
    case 'clothing_base': return t('field_clothing_base');
    case 'clothing_details': return t('field_clothing_details');
    case 'video_tokens': return t('field_video_tokens');
    default: return key;
  }
}

// ── readField / readUnitField ports ──
function readField(sc: BookScene, key: string): string {
  const env = sc.location?.environment;
  switch (key) {
    case 'scene_id': return sc.scene_id ?? '';
    case 'scene_title': return sc.scene_title ?? '';
    case 'type': return sc.type ?? '';
    case 'style': return sc.style ?? '';
    case 'location.id': return sc.location?.id ?? '';
    case 'env.time': return env?.time ?? '';
    case 'env.lighting': return env?.lighting ?? '';
    case 'env.weather': return env?.weather ?? '';
    case 'env.mood': return env?.mood ?? '';
    case 'env.atmosphere': return env?.atmosphere ?? '';
    case 'env.country': return env?.country ?? '';
    case 'env.epoch': return env?.epoch ?? '';
    case 'participants': return sc.participants?.join(', ') ?? '';
    case 'voice': return sc.audio?.voice ?? '';
    case 'full_text': return sc.audio?.full_text ?? '';
    default: return '';
  }
}

function readUnitField(u: BookUnit, key: string): string {
  switch (key) {
    case 'id': return u.id ?? '';
    case 'type': return u.type ?? '';
    case 'text': return u.text ?? '';
    case 'audio.speaker': return u.audio?.speaker ?? '';
    case 'audio.text': return u.audio?.text ?? '';
    case 'image.shot': return u.image?.shot ?? '';
    case 'image.prompt': return u.image?.prompt ?? '';
    case 'image.negative': return u.image?.negative ?? '';
    case 'video.action': return u.video?.action ?? '';
    default: return '';
  }
}

// Unit id fallback (EditFragment: unit.id ?: "iu%04d").
function unitId(u: BookUnit, index: number): string {
  return u.id ?? `iu${String(index).padStart(4, '0')}`;
}

export function EditPage(props: { path?: string }) {
  void props;
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [currentChIndex, setCurrentChIndex] = useState(0);
  const [currentScIndex, setCurrentScIndex] = useState(0);
  const [tab, setTab] = useState(DEFAULT_TAB);
  const [loading, setLoading] = useState(false);
  const [posLabel, setPosLabel] = useState(t('navigate_no_position'));
  const [unitCountText, setUnitCountText] = useState('');
  const [hasUnits, setHasUnits] = useState(false);
  // Backend-served frame-prompt limit (image.prompt / video.action) — fetched once.
  const [imagePromptMaxChars, setImagePromptMaxChars] = useState<number | undefined>(undefined);

  // Field values shared across tabs for the current scene (fieldValues map).
  const fieldValues = useRef<Record<string, string>>({});
  const [saveDirty, setSaveDirty] = useState(false);
  const saveDirtyRef = useRef(false);
  // Forces the per-field char counter to re-render on EVERY keystroke: markDirty
  // early-returns once saveDirty is set, so the counter cannot rely on it.
  const [counterTick, setCounterTick] = useState(0);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveText, setSaveText] = useState<string>(t('edit_save'));
  const [errorText, setErrorText] = useState<string | null>(null);

  // Timeline (waveform + timings + audio playback).
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  // Synchronous mirror — the waveform drag writes it before saveTimings reads it
  // (React setState is async; Android mutated a plain var).
  const timingDataRef = useRef<SceneTiming | null>(null);
  const [timelineVisible, setTimelineVisible] = useState(false);
  // Collapsible panels (web deviation — frees vertical space for the editor).
  const [carouselCollapsed, setCarouselCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  // Full-size image zoom dialog (opens from the current carousel card).
  const [zoom, setZoom] = useState<{ url: string; label: string } | null>(null);
  const [zoomFailed, setZoomFailed] = useState(false);
  const [selection, setSelection] = useState<{ startMs: number; endMs: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const originalTimings = useRef<Record<string, [number, number]>>({});
  const timelineDirty = useRef(false);
  const playbackPos = useSignal(-1);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const rafId = useRef<number | null>(null);

  // Passport override blocks (Scene tab).
  const [overrideBlocks, setOverrideBlocks] = useState<OverrideBlock[]>([]);
  const blocksSceneKey = useRef<string | null>(null);

  // Tab scroll indicators.
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const bid = bookIdSignal.value;
  const bld = buildIdSignal.value;
  const chapters = bookData?.chapters ?? [];
  const currentScene = (): BookScene | null => chapters[currentChIndex]?.scenes?.[currentScIndex] ?? null;

  // ── stop playback (no DOM deps) ──
  const stopPlaybackInternal = useCallback(() => {
    if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    playbackPos.value = -1;
    setIsPlaying(false);
    if (audioEl.current) {
      try { audioEl.current.pause(); } catch { /* ignore */ }
      try { audioEl.current.removeAttribute('src'); audioEl.current.load(); } catch { /* ignore */ }
      audioEl.current = null;
    }
  }, [playbackPos]);

  // ── clearEditor ──
  const clearEditor = useCallback(() => {
    setBookData(null);
    setCurrentChIndex(0);
    setCurrentScIndex(0);
    fieldValues.current = {};
    setOverrideBlocks([]);
    blocksSceneKey.current = null;
    setPosLabel(t('navigate_no_position'));
    setErrorText(null);
    setHasUnits(false);
    setUnitCountText('');
    stopPlaybackInternal();
    setWaveformData(null);
    timingDataRef.current = null;
    setSelection(null);
    setTimelineVisible(false);
    setSaveBusy(false);
    setSaveText(t('edit_save'));
  }, [stopPlaybackInternal]);

  const setSaveLoading = useCallback((busy: boolean, isSaving: boolean) => {
    setSaveBusy(busy);
    setSaveText(busy ? (isSaving ? t('edit_saving') : t('edit_loading')) : t('edit_save'));
  }, []);

  const showSaveError = useCallback((message: string) => {
    setSaveBusy(false);
    setSaveText(t('edit_save'));
    setErrorText(message);
  }, []);

  const markDirty = useCallback(() => {
    if (saveDirtyRef.current) return;
    saveDirtyRef.current = true;
    setSaveDirty(true);
  }, []);

  // ── loadAndSync: fetch book + sync chapter/scene indexes ──
  const loadAndSync = useCallback(async (chId: string | null, scId: string | null) => {
    const bId = bookIdSignal.value;
    if (!bId) {
      clearEditor();
      return;
    }
    setLoading(true);
    try {
      const bd = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
      setBookData(bd);
      // snapshotCurrentBook() — fire-and-forget server snapshot (non-fatal).
      void postJson(`/book/${encodeURIComponent(bId)}/snapshot`).catch(() => {});
      const chs = bd.chapters ?? [];
      const nc = Math.max(0, chs.findIndex((c) => c.chapter_id === chId));
      const ns = Math.max(0, (chs[nc]?.scenes ?? []).findIndex((s) => s.scene_id === scId));
      setCurrentChIndex(nc);
      setCurrentScIndex(ns);
    } catch {
      showSaveError(t('edit_load_failed'));
    } finally {
      setLoading(false);
    }
  }, [showSaveError, clearEditor]);

  // ── Observe position (observePosition) — reload on every position change ──
  const lastPosKey = useRef<string | null>(null);
  if (lastPosKey.current === null) {
    const p = positionSignal.value;
    lastPosKey.current = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}|${p.unitIndex}` : null;
  }
  useEffect(() => {
    const p = positionSignal.value;
    const key = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}|${p.unitIndex}` : null;
    if (key !== lastPosKey.current) {
      lastPosKey.current = key;
      // Any navigation discards unsaved field edits (Android fieldValues.clear()
      // on unit moves as well as scene changes) — 1:1.
      fieldValues.current = {};
      saveDirtyRef.current = false;
      setSaveDirty(false);
      if (p.chapterId != null && p.sceneId != null) {
        void loadAndSync(p.chapterId, p.sceneId);
      } else if (!bookIdSignal.value) {
        clearEditor();
      }
    }
  }, [positionSignal.value, loadAndSync, clearEditor]);

  // ── Backend editor limits (imagePromptMaxChars) — fetched once on mount ──
  useEffect(() => {
    void getJson<AppConfig>('/config')
      .then((cfg) => {
        const v = cfg.limits?.image_prompt_max_chars;
        if (typeof v === 'number' && v > 0) setImagePromptMaxChars(v);
      })
      .catch(() => { /* limit stays undefined → fields render without a counter */ });
  }, []);

  // ── Reload on book change / playbackPrepared (generation completion) ──
  useEffect(() => {
    const p = positionSignal.value;
    if (bid && p.chapterId != null && p.sceneId != null) {
      void loadAndSync(p.chapterId, p.sceneId);
    }
    return onPlaybackPrepared((prep) => {
      if (bookIdSignal.value && bookIdSignal.value === prep.bookId) {
        const pp = positionSignal.value;
        if (pp.chapterId != null && pp.sceneId != null) void loadAndSync(pp.chapterId, pp.sceneId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, loadAndSync]);

  // ── Position label (updatePositionLabel) + unit count ──
  useEffect(() => {
    const p = positionSignal.value;
    const ch = chapters[currentChIndex];
    const sc = chapters[currentChIndex]?.scenes?.[currentScIndex];
    const totalUnits = sc?.units?.length ?? 0;
    setHasUnits(totalUnits > 0);
    setUnitCountText(totalUnits > 0 ? tf('navigate_units_count', totalUnits) : '');
    if (!p.chapterId || !ch) {
      setPosLabel(t('navigate_no_position'));
      return;
    }
    const isSpecial = ch.is_special === true;
    const chTitle = ch.chapter_title?.trim();
    const scTitle = sc?.scene_title?.trim();
    let chLabel = '—';
    if (isSpecial) {
      const type = (ch.type ?? '').toLowerCase();
      chLabel = type === 'cover' ? t('navigate_cover')
        : type === 'prologue' ? t('navigate_prologue')
        : chTitle ?? (ch.type ? ch.type.charAt(0).toUpperCase() + ch.type.slice(1) : '—');
    } else if (chTitle) {
      chLabel = chTitle;
    } else if (ch.display_number != null) {
      chLabel = `${t('navigate_chapter')} ${ch.display_number}`;
    }
    const scNum = sc?.display_index ?? currentScIndex + 1;
    const scLabel = sc != null ? `${t('navigate_scene')} ${scNum}` : '—';
    const unitLabel = `${t('navigate_unit')} ${p.unitIndex + 1}`;
    const full = scTitle != null
      ? `${chLabel} / ${scLabel} — ${scTitle} / ${unitLabel}`
      : `${chLabel} / ${scLabel} / ${unitLabel}`;
    setPosLabel(full);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData, positionSignal.value]);

  // ── Timeline: waveform + timings in parallel (loadTimelineData) ──
  const loadTimelineData = useCallback(async () => {
    const bId = bookIdSignal.value;
    const bBuild = buildIdSignal.value;
    const sc = currentScene();
    const ch = chapters[currentChIndex];
    if (!bId || !bBuild || !sc || !ch) return;
    const chId = ch.chapter_id ?? '';
    const scId = sc.scene_id ?? '';
    stopPlaybackInternal();
    setWaveformData(null);
    timingDataRef.current = null;
    try {
      const [wd, td] = await Promise.all([
        getJson<WaveformData>(`/scene/${encodeURIComponent(bId)}/${encodeURIComponent(chId)}/${encodeURIComponent(scId)}/waveform?build_id=${encodeURIComponent(bBuild)}`).catch(() => null),
        getJson<SceneTiming>(`/scene/${encodeURIComponent(bId)}/${encodeURIComponent(chId)}/${encodeURIComponent(scId)}/timings?build_id=${encodeURIComponent(bBuild)}`).catch(() => null),
      ]);
      if (wd && td) {
        const audioDurationMs = Math.round(wd.duration_sec * 1000);
        const computedUnits = td.units
          .slice()
          .sort((a, b) => a.scene_order - b.scene_order)
          .map((u) => {
            const startMs = Math.max(0, u.start_ms ?? 0);
            const endMs = Math.min(Math.max(startMs, u.end_ms ?? startMs), audioDurationMs);
            return { ...u, start_ms: startMs, end_ms: endMs };
          });
        const td2: SceneTiming = { ...td, units: computedUnits };
        originalTimings.current = {};
        computedUnits.forEach((u) => { originalTimings.current[u.unit_id] = [u.start_ms ?? 0, u.end_ms ?? 0]; });
        timingDataRef.current = td2;
        setWaveformData(wd);
        setTimelineVisible(true);
        updateSelectionFromTimings(td2);
      } else {
        setTimelineVisible(false);
      }
    } catch {
      setTimelineVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData, stopPlaybackInternal]);

  // updateTimelineSelection: set waveform selection from the current unit
  function updateSelectionFromTimings(td: SceneTiming | null): void {
    const units = td?.units ?? [];
    const idx = positionSignal.value.unitIndex;
    const unit = units[idx];
    if (unit) {
      setSelection({ startMs: unit.start_ms ?? 0, endMs: unit.end_ms ?? 0 });
    }
  }

  useEffect(() => {
    if (currentScene() && bookIdSignal.value) void loadTimelineData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData, loadTimelineData]);

  // ── Range drag (handleRangeChange / handleRangeChangeEnd) ──
  const handleRangeChange = useCallback((startMs: number, endMs: number) => {
    const td = timingDataRef.current;
    if (!td) return;
    const idx = positionSignal.value.unitIndex;
    const units = td.units.map((u, i) => {
      if (i === idx) return { ...u, start_ms: startMs, end_ms: endMs };
      // The handles are SHARED boundaries: the left handle is also the previous
      // unit's end, the right handle is also the next unit's start.
      if (i === idx - 1) return { ...u, end_ms: startMs };
      if (i === idx + 1) return { ...u, start_ms: endMs };
      return u;
    });
    const td2 = { ...td, units };
    timingDataRef.current = td2;
    setSelection({ startMs, endMs });
  }, []);

  const saveTimings = useCallback(async () => {
    const td = timingDataRef.current;
    const sc = currentScene();
    const ch = chapters[currentChIndex];
    const bId = bookIdSignal.value;
    const bBuild = buildIdSignal.value;
    if (!td || !sc || !ch || !bId || !bBuild) return;
    const chId = ch.chapter_id ?? '';
    const scId = sc.scene_id ?? '';
    try {
      const res = await putJson<{ units: { unit_id: string; start_ms: number; end_ms: number }[] }>(
        `/scene/${encodeURIComponent(bId)}/${encodeURIComponent(chId)}/${encodeURIComponent(scId)}/timings`,
        { build_id: bBuild, units: td.units.map((u) => ({ unit_id: u.unit_id, start_ms: u.start_ms ?? 0, end_ms: u.end_ms ?? 0 })) }
      );
      const map = new Map(res.units.map((u) => [u.unit_id, u]));
      const updatedUnits = td.units.map((u) => {
        const r = map.get(u.unit_id);
        return r ? { ...u, start_ms: r.start_ms, end_ms: r.end_ms } : u;
      });
      const td2 = { ...td, units: updatedUnits };
      timingDataRef.current = td2;
      updateSelectionFromTimings(td2);
      timelineDirty.current = false;
    } catch { /* keep local state — Android swallows the error */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData]);

  const handleRangeChangeEnd = useCallback(() => {
    timelineDirty.current = true;
    void saveTimings();
  }, [saveTimings]);

  // ── Reset current unit timing ──
  const resetCurrentUnitTiming = useCallback(() => {
    const td = timingDataRef.current;
    if (!td) return;
    const idx = positionSignal.value.unitIndex;
    const unit = td.units[idx];
    if (!unit) return;
    const orig = originalTimings.current[unit.unit_id];
    if (!orig) return;
    const units = td.units.map((u, i) => (i === idx ? { ...u, start_ms: orig[0], end_ms: orig[1] } : u));
    const td2 = { ...td, units };
    timingDataRef.current = td2;
    updateSelectionFromTimings(td2);
    void saveTimings();
  }, [saveTimings]);

  // ── Playback (startPlayback/stopPlayback/togglePlayback) — 1:1 with
  // EditFragment: seek to unit.start_ms, start(), tick every frame and stop at
  // unit.end_ms (Android: `if (cur >= unit.end_ms || cur >= audioDurationMs)
  // stopPlayback()`, plus setOnCompletionListener { stopPlayback() }). ──
  const startPlayback = useCallback(() => {
    const bId = bookIdSignal.value;
    const bBuild = buildIdSignal.value;
    const sc = currentScene();
    const ch = chapters[currentChIndex];
    const idx = positionSignal.value.unitIndex;
    const unit = timingDataRef.current?.units?.[idx];
    if (!bId || !bBuild || !sc || !ch || !unit) return;
    const chId = ch.chapter_id ?? '';
    const scId = sc.scene_id ?? '';
    // Range to play — the current unit's timing boundary on the scene timeline.
    const startMs = unit.start_ms ?? 0;
    const endMs = unit.end_ms ?? 0;

    if (!audioEl.current) {
      const a = new Audio(`/api/v1/scene/${encodeURIComponent(bId)}/${encodeURIComponent(chId)}/${encodeURIComponent(scId)}/audio?build_id=${encodeURIComponent(bBuild)}`);
      a.preload = 'auto';
      audioEl.current = a;
    }
    const a = audioEl.current;
    // MediaPlayer.setOnCompletionListener { stopPlayback() }.
    a.onended = () => stopPlaybackInternal();

    const play = () => {
      // p.seekTo(unit.start_ms.toInt()) — clamp to the seekable duration.
      const durSec = a.duration && isFinite(a.duration) ? a.duration : Number.MAX_SAFE_INTEGER;
      const seekSec = Math.max(0, Math.min(startMs / 1000, durSec));
      const applySeek = () => { try { a.currentTime = seekSec; } catch { /* not seekable yet */ } };
      applySeek();
      void a.play().then(() => {
        // Belt & suspenders: a few browsers reset currentTime when play() begins
        // (or the first seek was issued before data was buffered). Now that the
        // backend answers Range requests with 206, re-apply the seek once playback
        // is actually running so the range plays from its start marker.
        if (Math.abs((a.currentTime || 0) - seekSec) > 0.25) {
          try { a.currentTime = seekSec; } catch { /* ignore */ }
        }
      }).catch(() => {});
      setIsPlaying(true);
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
      const tick = () => {
        if (!audioEl.current) return;
        const cur = audioEl.current.currentTime * 1000;
        const dur = audioEl.current.duration && isFinite(audioEl.current.duration)
          ? audioEl.current.duration * 1000
          : Number.POSITIVE_INFINITY;
        playbackPos.value = cur;
        if ((endMs > 0 && cur >= endMs) || cur >= dur) {
          stopPlaybackInternal();
          return;
        }
        rafId.current = requestAnimationFrame(tick);
      };
      rafId.current = requestAnimationFrame(tick);
    };
    // readyState >= 1 (HAVE_METADATA) ⇒ seekable; a metadata race (readyState
    // landing on 1 before the listener attaches) would otherwise skip play().
    if (a.readyState >= 1) {
      play();
    } else {
      const onReady = () => {
        a.removeEventListener('loadedmetadata', onReady);
        play();
      };
      a.addEventListener('loadedmetadata', onReady);
      a.addEventListener('error', () => stopPlaybackInternal(), { once: true });
      a.load();
    }
  }, [currentChIndex, currentScIndex, bookData, stopPlaybackInternal, playbackPos]);

  const togglePlayback = useCallback(() => {
    if (isPlaying) stopPlaybackInternal();
    else startPlayback();
  }, [isPlaying, startPlayback, stopPlaybackInternal]);

  // ── Carousel navigation (navigateUnit) — position + seekToPosition ──
  const navigateUnit = useCallback((delta: number) => {
    const p = positionSignal.value;
    const idx = p.unitIndex;
    const sc = currentScene();
    if (!sc) return;
    const units = sc.units ?? [];
    const scenes = chapters[currentChIndex]?.scenes ?? [];
    const atStart = idx === 0;
    const atEnd = idx >= units.length - 1;
    const doNavigate = (targetCh: number, targetSc: number, unitIdx: number, u: BookUnit | null) => {
      const ch = chapters[targetCh];
      const s = ch?.scenes?.[targetSc];
      if (!ch || !s) return;
      navigateTo({
        chapterId: ch.chapter_id ?? null,
        sceneId: s.scene_id ?? null,
        unitId: u?.id ?? null,
        chunkId: null,
        unitIndex: unitIdx,
      });
      if (ch.chapter_id != null && s.scene_id != null) {
        void seekToPosition(ch.chapter_id, s.scene_id, unitIdx, u ? unitId(u, unitIdx) : null);
      }
    };

    if (delta < 0 && atStart && currentScIndex > 0) {
      const prevSc = scenes[currentScIndex - 1];
      if (prevSc) {
        const prevUnits = prevSc.units ?? [];
        const prevUnitIndex = prevUnits.length > 0 ? prevUnits.length - 1 : 0;
        doNavigate(currentChIndex, currentScIndex - 1, prevUnitIndex, prevUnits[prevUnitIndex] ?? null);
      }
    } else if (delta < 0 && atStart && currentScIndex === 0 && currentChIndex > 0) {
      const prevCh = chapters[currentChIndex - 1];
      const prevChScenes = prevCh?.scenes ?? [];
      const prevSc = prevChScenes[prevChScenes.length - 1];
      if (prevSc) {
        const prevUnits = prevSc.units ?? [];
        const prevUnitIndex = prevUnits.length > 0 ? prevUnits.length - 1 : 0;
        doNavigate(currentChIndex - 1, prevChScenes.length - 1, prevUnitIndex, prevUnits[prevUnitIndex] ?? null);
      }
    } else if (delta > 0 && atEnd && currentScIndex < scenes.length - 1) {
      const nextSc = scenes[currentScIndex + 1];
      if (nextSc) {
        const nextUnits = nextSc.units ?? [];
        doNavigate(currentChIndex, currentScIndex + 1, 0, nextUnits[0] ?? null);
      }
    } else if (delta > 0 && atEnd && currentScIndex >= scenes.length - 1 && currentChIndex < chapters.length - 1) {
      const nextCh = chapters[currentChIndex + 1];
      const nextSc = nextCh?.scenes?.[0];
      if (nextSc) {
        const nextUnits = nextSc.units ?? [];
        doNavigate(currentChIndex + 1, 0, 0, nextUnits[0] ?? null);
      }
    } else {
      const newIndex = Math.max(0, Math.min(idx + delta, units.length - 1));
      if (newIndex === idx) return;
      const u = units[newIndex];
      navigateTo({
        chapterId: chapters[currentChIndex]?.chapter_id ?? null,
        sceneId: sc.scene_id ?? null,
        unitId: u?.id ?? null,
        chunkId: null,
        unitIndex: newIndex,
      });
      const chId = chapters[currentChIndex]?.chapter_id;
      if (chId != null && sc.scene_id != null) {
        void seekToPosition(chId, sc.scene_id, newIndex, u ? unitId(u, newIndex) : null);
      }
    }
  }, [currentChIndex, currentScIndex, chapters, bookData]);

  // ── Passport override blocks (ensurePassportBlocks) ──
  // buildBlocksFromScene is a pure builder used both synchronously during render
  // (no setState-during-render) and by the effect that syncs state on scene change.
  function buildBlocksFromScene(sc: BookScene): OverrideBlock[] {
    const blocks: OverrideBlock[] = [];
    const passport = sc.passport ?? {};
    Object.entries(passport).forEach(([charId, p]) => {
      const fields: Record<string, string> = {};
      PASSPORT_OVERRIDE_FIELDS.forEach((f) => {
        const v = p ? (p as CharPassport)[f as keyof CharPassport] : undefined;
        if (v) fields[f] = v;
      });
      blocks.push({ charId, fields });
    });
    if (blocks.length === 0) blocks.push({ charId: '', fields: {} });
    return blocks;
  }

  const ensurePassportBlocks = useCallback((sc: BookScene) => {
    const key = `${currentChIndex}/${currentScIndex}`;
    if (blocksSceneKey.current === key) return;
    blocksSceneKey.current = key;
    setOverrideBlocks(buildBlocksFromScene(sc));
  }, [currentChIndex, currentScIndex]);

  useEffect(() => {
    const sc = currentScene();
    if (sc) ensurePassportBlocks(sc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData, ensurePassportBlocks]);

  const passportOverrideLimit = useCallback((): number => {
    const raw = fieldValues.current['participants']?.trim()
      || currentScene()?.participants?.join(', ') || '';
    if (!raw) return Number.MAX_SAFE_INTEGER;
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData]);

  const blockUsed = (b: OverrideBlock): boolean =>
    b.charId.trim() !== '' && Object.values(b.fields).some((v) => v.trim() !== '');
  const blockEmpty = (b: OverrideBlock): boolean =>
    b.charId.trim() === '' && Object.values(b.fields).every((v) => v.trim() === '');

  const maybeAppendPassportBlock = useCallback(() => {
    setOverrideBlocks((prev) => {
      let next = prev;
      while (next.length >= 2 && blockEmpty(next[next.length - 1]) && blockEmpty(next[next.length - 2])) {
        next = next.slice(0, -1);
      }
      const last = next[next.length - 1];
      if (!last || !blockUsed(last)) return next;
      if (next.filter(blockUsed).length >= passportOverrideLimit()) return next;
      return [...next, { charId: '', fields: {} }];
    });
  }, [passportOverrideLimit]);

  const updateOverrideBlock = useCallback((index: number, patch: Partial<OverrideBlock>) => {
    setOverrideBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
    markDirty();
    maybeAppendPassportBlock();
  }, [markDirty, maybeAppendPassportBlock]);

  // buildPassportOverrideFields — diff vs the scene's existing overrides
  const buildPassportOverrideFields = useCallback((sc: BookScene): Record<string, string> => {
    const result: Record<string, string> = {};
    const desired = new Map<string, Record<string, string>>();
    overrideBlocks.forEach((block) => {
      const charId = block.charId.trim();
      if (charId === '' || !Object.values(block.fields).some((v) => v.trim() !== '')) return;
      const m = desired.get(charId) ?? {};
      PASSPORT_OVERRIDE_FIELDS.forEach((f) => {
        const v = block.fields[f]?.trim() ?? '';
        if (v) m[f] = v;
      });
      desired.set(charId, m);
    });
    const existing = sc.passport ?? {};
    const allCharIds = new Set([...desired.keys(), ...Object.keys(existing)]);
    allCharIds.forEach((charId) => {
      const want = desired.get(charId);
      const have = existing[charId];
      PASSPORT_OVERRIDE_FIELDS.forEach((f) => {
        const newVal = want?.[f] ?? '';
        const oldVal = have ? String((have as CharPassport)[f as keyof CharPassport] ?? '') : '';
        if (newVal !== oldVal) {
          result[`passport.${charId}.${f}`] = newVal;
        }
      });
    });
    return result;
  }, [overrideBlocks]);

  // ── Save (saveToBackend) ──
  const saveToBackend = useCallback(async () => {
    const bd = bookData;
    const bId = bookIdSignal.value;
    if (!bd || !bId) {
      showSaveError('No book data');
      return;
    }
    const fv = fieldValues.current;

    // GLOBAL tab — PATCH /book/{id}/metadata (diff vs original)
    if (tab === GLOBAL_TAB) {
      setSaveLoading(true, true);
      try {
        const body: Record<string, string | null> = {};
        const orig: Record<string, string> = {
          title: bd.book?.title ?? '',
          author: bd.book?.author ?? '',
          language: bd.book?.language ?? '',
          country: bd.bible?.country ?? '',
          epoch: bd.bible?.epoch ?? '',
          render_style: bd.bible?.render_rules?.style ?? '',
          lighting_default: bd.bible?.render_rules?.lighting_default ?? '',
          narration_voice: bd.book?.defaults?.narration_voice ?? '',
        };
        Object.keys(orig).forEach((key) => {
          if (!(key in fv)) return;
          const value = fv[key];
          if (value !== orig[key]) body[key] = value.trim() === '' ? null : value;
        });
        if (Object.keys(body).length > 0) {
          await patchJson(`/book/${encodeURIComponent(bId)}/metadata`, body);
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
      }
      return;
    }

    // LOCATIONS tab — PATCH /locations/{id} per loc.* key group
    if (tab === LOCATIONS_TAB) {
      setSaveLoading(true, true);
      try {
        const byLoc = new Map<string, Record<string, string>>();
        Object.entries(fv).forEach(([key, value]) => {
          if (!key.startsWith('loc.')) return;
          const rest = key.slice(4);
          const dot = rest.indexOf('.');
          if (dot <= 0) return;
          const locId = rest.slice(0, dot);
          const fieldKey = rest.slice(dot + 1);
          const m = byLoc.get(locId) ?? {};
          m[fieldKey] = value;
          byLoc.set(locId, m);
        });
        if (byLoc.size === 0) {
          setSaveLoading(false, true);
          return;
        }
        for (const [locId, fields] of byLoc) {
          await patchJson(`/book/${encodeURIComponent(bId)}/locations/${encodeURIComponent(locId)}`, { fields });
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
      }
      return;
    }

    // CHARACTERS tab — PATCH /characters/{id} per CHANGED char (name + passport).
    if (tab === CHARS_TAB) {
      setSaveLoading(true, true);
      try {
        const byChar = new Map<string, Record<string, string>>();
        Object.entries(fv).forEach(([key, value]) => {
          if (!key.startsWith('char.')) return;
          const rest = key.slice(5); // drop 'char.'
          const dot = rest.indexOf('.');
          if (dot <= 0) return;
          // Note: first-dot split mirrors Android's char.<id>.passport.* keys;
          // ids containing '.' would mis-route (Android-parity limitation).
          const charId = rest.slice(0, dot);
          const fieldKey = rest.slice(dot + 1);
          const m = byChar.get(charId) ?? {};
          m[fieldKey] = value;
          byChar.set(charId, m);
        });
        const chars = bd.characters ?? [];
        let anyChanged = false;
        for (const [charId, fields] of byChar) {
          // Diff vs canonical data — skip untouched entities (GLOBAL-tab pattern).
          const orig = chars.find((c) => c.id === charId);
          const changed: Record<string, string> = {};
          Object.entries(fields).forEach(([k, v]) => {
            const oldVal = k === 'name'
              ? (orig?.name ?? '')
              : String((orig?.passport as CharPassport | null)?.[k as keyof CharPassport] ?? '');
            if (v !== oldVal) changed[k] = v;
          });
          if (Object.keys(changed).length === 0) continue;
          anyChanged = true;
          await patchJson(`/book/${encodeURIComponent(bId)}/characters/${encodeURIComponent(charId)}`, { fields: changed });
        }
        if (!anyChanged) {
          setSaveLoading(false, true);
          saveDirtyRef.current = false;
          setSaveDirty(false);
          return;
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
        saveDirtyRef.current = false;
        setSaveDirty(false);
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
      }
      return;
    }

    // VOICES tab — PATCH /voices/{id} per CHANGED voice (instruction).
    if (tab === VOICES_TAB) {
      setSaveLoading(true, true);
      try {
        const byVoice = new Map<string, Record<string, string>>();
        Object.entries(fv).forEach(([key, value]) => {
          if (!key.startsWith('voice.')) return;
          const rest = key.slice(6); // drop 'voice.'
          const dot = rest.indexOf('.');
          if (dot <= 0) return;
          const voiceId = rest.slice(0, dot);
          const fieldKey = rest.slice(dot + 1);
          const m = byVoice.get(voiceId) ?? {};
          m[fieldKey] = value;
          byVoice.set(voiceId, m);
        });
        const voices = bd.voices ?? {};
        let anyChanged = false;
        for (const [voiceId, fields] of byVoice) {
          const orig = voices[voiceId]?.instruction ?? '';
          const changed: Record<string, string> = {};
          Object.entries(fields).forEach(([k, v]) => {
            if (v !== orig) changed[k] = v;
          });
          if (Object.keys(changed).length === 0) continue;
          anyChanged = true;
          await patchJson(`/book/${encodeURIComponent(bId)}/voices/${encodeURIComponent(voiceId)}`, { fields: changed });
        }
        if (!anyChanged) {
          setSaveLoading(false, true);
          saveDirtyRef.current = false;
          setSaveDirty(false);
          return;
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
        saveDirtyRef.current = false;
        setSaveDirty(false);
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
      }
      return;
    }

    const ch = chapters[currentChIndex];
    const sc = currentScene();
    const chapterId = ch?.chapter_id;
    const sceneId = sc?.scene_id;
    if (!ch || !sc || !chapterId || !sceneId) {
      showSaveError('No chapter data');
      return;
    }

    setSaveLoading(true, true);
    try {
      let fields: Record<string, string> = {};
      const body: Record<string, unknown> = { fields };

      if (tab === SCENE_TAB) {
        const sceneKeys = ['scene_title', 'type', 'style', 'participants', 'location.id', 'env.time', 'env.lighting', 'env.weather', 'env.mood', 'env.atmosphere', 'env.country', 'env.epoch'];
        sceneKeys.forEach((k) => { if (k in fv) fields[k] = fv[k]; });
        const chapterTitle = fv['chapter_title']?.trim();
        if (chapterTitle) body['chapter_title'] = chapterTitle;
      } else if (tab === AUDIO_TAB) {
        // Fixed routing deviation: write scene.audio.* (Android sends "voice"/
        // "full_text" which the server places at scene.voice — never read back).
        if ('voice' in fv) fields['audio.voice'] = fv['voice'];
        if ('full_text' in fv) fields['audio.full_text'] = fv['full_text'];
      } else if (tab === UNITS_TAB) {
        const p = positionSignal.value;
        const units = sc.units ?? [];
        const u = units[p.unitIndex];
        if (u) {
          body['unit_id'] = u.id ?? null;
          ['text', 'audio.speaker', 'audio.text', 'image.shot', 'image.prompt', 'image.negative', 'video.action'].forEach((k) => {
            if (k in fv) fields[k] = fv[k];
          });
        }
      }

      if (Object.keys(fields).length > 0 || body['chapter_title']) {
        await patchJson(`/book/${encodeURIComponent(bId)}/scene/${encodeURIComponent(chapterId)}/${encodeURIComponent(sceneId)}`, body);
      }

      // Scene character passport overrides — separate PATCH WITHOUT unit_id so the
      // server applies them to the scene itself (1:1 with EditFragment).
      const passportFields = buildPassportOverrideFields(sc);
      if (Object.keys(passportFields).length > 0) {
        await patchJson(`/book/${encodeURIComponent(bId)}/scene/${encodeURIComponent(chapterId)}/${encodeURIComponent(sceneId)}`, { fields: passportFields });
      }

      // Thin-client: re-fetch canonical book data.
      const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
      if (fresh) setBookData(fresh);
      setSaveLoading(false, true);
      setErrorText(null);
      saveDirtyRef.current = false;
      setSaveDirty(false);
    } catch (e) {
      showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookData, chapters, currentChIndex, currentScIndex, buildPassportOverrideFields, showSaveError, setSaveLoading]);

  // ── Tab scroll indicators (updateTabScrollIndicators) ──
  const updateTabScrollIndicators = useCallback(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  const scrollTabs = useCallback((direction: number) => {
    tabsScrollRef.current?.scrollBy({ left: direction * 160, behavior: 'smooth' });
  }, []);

  // ── Content builders ──

  const sectionLabel = (text: string): JSX.Element => <div class="edit-section">{text}</div>;

  const inputCard = (label: string, value: string, multiline: boolean, storeKey: string, maxLength?: number): JSX.Element => {
    if (!(storeKey in fieldValues.current)) fieldValues.current[storeKey] = value;
    const currentLen = (fieldValues.current[storeKey] ?? '').length;
    return (
      <div class="edit-field" key={storeKey}>
        <label class="edit-field__label">{label}</label>
        {multiline ? (
          <textarea
            class="edit-field__input edit-field__input--area"
            rows={4}
            maxLength={maxLength}
            defaultValue={fieldValues.current[storeKey]}
            onInput={(e) => { fieldValues.current[storeKey] = (e.target as HTMLTextAreaElement).value; setCounterTick((t) => t + 1); markDirty(); }}
          />
        ) : (
          <input
            class="edit-field__input"
            type="text"
            maxLength={maxLength}
            defaultValue={fieldValues.current[storeKey]}
            onInput={(e) => { fieldValues.current[storeKey] = (e.target as HTMLInputElement).value; setCounterTick((t) => t + 1); markDirty(); }}
          />
        )}
        {maxLength !== undefined && (
          <div class="edit-field__counter" data-counter-version={counterTick}>{currentLen}/{maxLength}</div>
        )}
      </div>
    );
  };

  const readonlyField = (label: string, value: string): JSX.Element => (
    <div class="edit-field">
      <label class="edit-field__label">{label}</label>
      <input class="edit-field__input" type="text" value={value} readOnly />
    </div>
  );

  const buildSceneFields = (sc: BookScene, ch: BookChapter | undefined): JSX.Element[] => {
    const out: JSX.Element[] = [];
    out.push(sectionLabel(t('edit_section_scene_general')));
    out.push(readonlyField('chapter_id', ch?.chapter_id ?? '—'));
    if (ch) out.push(inputCard(fieldLabel('chapter_title'), ch.chapter_title ?? '', false, 'chapter_title'));
    out.push(readonlyField('scene_id', sc.scene_id ?? '—'));
    ['scene_title', 'type', 'style'].forEach((key) => {
      out.push(inputCard(fieldLabel(key), readField(sc, key), (fieldValues.current[key]?.length ?? 0) > 80, key));
    });
    out.push(sectionLabel(t('edit_section_scene_characters')));
    out.push(inputCard(fieldLabel('participants'), readField(sc, 'participants'), false, 'participants'));
    out.push(buildPassportOverrideSection(sc));
    out.push(sectionLabel(t('edit_section_scene_location')));
    ['location.id', 'env.time', 'env.lighting', 'env.weather', 'env.mood', 'env.atmosphere', 'env.country', 'env.epoch'].forEach((key) => {
      out.push(inputCard(fieldLabel(key), readField(sc, key), (fieldValues.current[key]?.length ?? 0) > 80, key));
    });
    return out;
  };

  const buildAudioFields = (sc: BookScene): JSX.Element[] => {
    return ['voice', 'full_text'].map((key) =>
      inputCard(fieldLabel(key), readField(sc, key), (fieldValues.current[key]?.length ?? 0) > 80, key)
    );
  };

  const buildUnitFields = (sc: BookScene): JSX.Element[] => {
    const units = sc.units ?? [];
    const idx = Math.max(0, Math.min(positionSignal.value.unitIndex, units.length - 1));
    const u = units[idx];
    if (!u) return [];
    const out: JSX.Element[] = [];
    // Counter on the left, duration on the right — balanced section header.
    // Duration = the current unit's timing (end − start); this builder re-runs
    // on every render, so it tracks waveform drags live.
    const unitTiming = timingDataRef.current?.units?.[idx];
    // Match the waveform labels exactly (they truncate tenths — formatMs uses
    // Math.floor(ms % 1000 / 100)), so the header duration equals what the
    // user reads as end − start on the waveform. Rounding here caused a 0.1 gap.
    const durTenths = unitTiming
      ? Math.max(0, Math.floor((unitTiming.end_ms ?? 0) / 100) - Math.floor((unitTiming.start_ms ?? 0) / 100))
      : 0;
    out.push(
      <div class="edit-section edit-section--row">
        <span>{tf('edit_unit_label', idx + 1, units.length)}</span>
        <span class="edit-section__meta">
          <IconClock width={14} height={14} />
          {tf('edit_unit_duration', (durTenths / 10).toFixed(1))}
        </span>
      </div>
    );
    out.push(readonlyField('id', u.id ?? ''));
    out.push(readonlyField(t('field_type'), u.type ?? ''));
    const textKey = 'text';
    const textVal = u.text ?? '';
    out.push(inputCard(fieldLabel(textKey), textVal, textVal.length > 80, textKey));
    out.push(sectionLabel(t('edit_section_audio')));
    ['audio.speaker', 'audio.text'].forEach((key) => {
      out.push(inputCard(fieldLabel(key), readUnitField(u, key), key === 'audio.text' && (fieldValues.current[key]?.length ?? 0) > 80, key));
    });
    out.push(sectionLabel(t('edit_section_image')));
    ['image.shot', 'image.prompt', 'image.negative'].forEach((key) => {
      out.push(inputCard(fieldLabel(key), readUnitField(u, key), key === 'image.prompt' && (fieldValues.current[key]?.length ?? 0) > 80, key, key === 'image.prompt' ? imagePromptMaxChars : undefined));
    });
    out.push(sectionLabel(t('edit_section_video')));
    out.push(inputCard(fieldLabel('video.action'), readUnitField(u, 'video.action'), (fieldValues.current['video.action']?.length ?? 0) > 80, 'video.action', imagePromptMaxChars));
    return out;
  };

  const buildCharactersFields = (): JSX.Element[] => {
    const characters = bookData?.characters ?? [];
    if (characters.length === 0) {
      return [<div class="edit-empty-inline" key="empty">{t('edit_no_characters')}</div>];
    }
    return characters.map((ch) => {
      const charId = ch.id ?? '';
      // char.<id>.name / char.<id>.passport.<field> — per-character store keys
      // (Android EditFragment uses the same prefix pattern).
      return (
        <div class="edit-card" key={charId || 'char'}>
          {readonlyField('id', charId)}
          {inputCard(t('field_name'), ch.name ?? '', false, `char.${charId}.name`)}
          <div class="edit-section">{t('field_passport')}</div>
          {PASSPORT_OVERRIDE_FIELDS.map((f) => {
            const v = String((ch.passport as CharPassport | null)?.[f as keyof CharPassport] ?? '');
            return inputCard(passportFieldLabel(f), v, v.length > 80, `char.${charId}.passport.${f}`);
          })}
        </div>
      );
    });
  };

  const buildVoicesFields = (): JSX.Element[] => {
    const voices = bookData?.voices ?? {};
    const entries = Object.entries(voices);
    if (entries.length === 0) {
      return [<div class="edit-empty-inline" key="empty">{t('edit_no_voices')}</div>];
    }
    return entries.map(([voiceId, entry]) => (
      <div class="edit-card" key={voiceId}>
        <div class="edit-card__title">{voiceId}</div>
        {inputCard(t('field_instruction'), entry?.instruction ?? '', (entry?.instruction?.length ?? 0) > 80, `voice.${voiceId}.instruction`)}
      </div>
    ));
  };

  const buildLocationsFields = (): JSX.Element[] => {
    const locations = bookData?.locations ?? bookData?.bible?.locations ?? {};
    const entries = Object.entries(locations);
    if (entries.length === 0) {
      return [<div class="edit-empty-inline" key="empty">{t('edit_no_locations')}</div>];
    }
    return entries.map(([locId, loc]) => {
      const prefix = `loc.${locId}.`;
      const env = loc?.environment;
      const out: JSX.Element[] = [];
      out.push(
        <div class="edit-card" key={locId}>
          {readonlyField('id', locId)}
          {inputCard(t('field_name'), loc?.name ?? '', false, `${prefix}name`)}
          {inputCard(t('field_description'), loc?.description ?? '', (loc?.description?.length ?? 0) > 80, `${prefix}description`)}
          <div class="edit-section">{t('field_environment')}</div>
          {(
            [
              ['time', t('field_time')], ['season', t('field_season')], ['lighting', t('field_lighting')],
              ['weather', t('field_weather')], ['mood', t('field_mood')], ['atmosphere', t('field_atmosphere')],
            ] as const
          ).map(([envKey, label]) => {
            const v = env?.[envKey] ?? '';
            return inputCard(label, v, v.length > 80, `${prefix}environment.${envKey}`);
          })}
        </div>
      );
      return <div key={locId}>{out}</div>;
    });
  };

  const buildGlobalFields = (): JSX.Element[] => {
    const manifest = bookData?.manifest;
    const bookMeta = bookData?.book;
    const bible = bookData?.bible;
    const out: JSX.Element[] = [];
    out.push(sectionLabel(t('field_book_id')));
    if (manifest) {
      out.push(readonlyField(t('field_book_id'), manifest.book_id ?? '—'));
      out.push(readonlyField(t('field_vbook_version'), manifest.vbook_version ?? '—'));
      out.push(readonlyField(t('field_created_at'), manifest.created_at ?? '—'));
    } else {
      out.push(readonlyField(t('field_book_id'), bookMeta?.book_id ?? '—'));
    }
    out.push(sectionLabel(t('edit_tabs_global_book')));
    const bookValues: Record<string, string> = {
      title: bookMeta?.title ?? '',
      author: bookMeta?.author ?? '',
      language: bookMeta?.language ?? '',
    };
    ['title', 'author', 'language'].forEach((key) => {
      out.push(inputCard(fieldLabel(key), bookValues[key] ?? '', false, key));
    });
    out.push(sectionLabel(t('edit_tabs_global_world')));
    [
      ['country', bible?.country ?? ''],
      ['epoch', bible?.epoch ?? ''],
      ['render_style', bible?.render_rules?.style ?? ''],
      ['lighting_default', bible?.render_rules?.lighting_default ?? ''],
    ].forEach(([key, value]) => {
      out.push(inputCard(fieldLabel(key), value as string, false, key as string));
    });
    out.push(sectionLabel(t('edit_section_audio')));
    out.push(inputCard(t('field_narrator_instruction'), bookMeta?.defaults?.narration_voice ?? '', false, 'narration_voice'));
    return out;
  };

  const buildPassportOverrideSection = (sc: BookScene): JSX.Element => {
    const sceneKey = `${currentChIndex}/${currentScIndex}`;
    // State carries a trailing free block (Android buildPassportOverrideSection +
    // maybeAppendPassportBlock keep the invariant: ≤1 trailing empty block,
    // appended when the last one becomes used) — no render-time append needed.
    const blocks = blocksSceneKey.current === sceneKey ? overrideBlocks : buildBlocksFromScene(sc);
    const limit = passportOverrideLimit();
    return (
      <div class="edit-overrides">
        {limit !== Number.MAX_SAFE_INTEGER && (
          <div class="edit-overrides__hint">{tf('overrides_limit_hint', limit)}</div>
        )}
        {blocks.map((block, i) => (
          <div class="edit-card edit-card--override" key={`${currentChIndex}/${currentScIndex}/${i}`}>
            <div class="edit-field">
              <label class="edit-field__label">{t('field_character_id')}</label>
              <input
                class="edit-field__input"
                type="text"
                value={block.charId}
                onInput={(e) => updateOverrideBlock(i, { charId: (e.target as HTMLInputElement).value })}
              />
            </div>
            {PASSPORT_OVERRIDE_FIELDS.map((f) => (
              <div class="edit-field" key={f}>
                <label class="edit-field__label">{passportFieldLabel(f)}</label>
                <textarea
                  class="edit-field__input edit-field__input--area"
                  rows={3}
                  value={block.fields[f] ?? ''}
                  onInput={(e) => {
                    const v = (e.target as HTMLTextAreaElement).value;
                    updateOverrideBlock(i, { fields: { ...block.fields, [f]: v } });
                  }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  // ── Dirty indicator ──
  const dirty = dirtySignal.value;

  // ── Tab content (rebuildContent) ──
  const renderContent = (): JSX.Element => {
    if (tab === CHARS_TAB) return <>{buildCharactersFields()}</>;
    if (tab === VOICES_TAB) return <>{buildVoicesFields()}</>;
    if (tab === LOCATIONS_TAB) return <>{buildLocationsFields()}</>;
    if (tab === GLOBAL_TAB) return <>{buildGlobalFields()}</>;
    const sc = currentScene();
    if (!sc) return <div class="edit-empty-inline" />;
    if (tab === SCENE_TAB) return <>{buildSceneFields(sc, chapters[currentChIndex])}</>;
    if (tab === AUDIO_TAB) return <>{buildAudioFields(sc)}</>;
    return <>{buildUnitFields(sc)}</>;
  };

  // ── Carousel data (updateCarousel) ──
  interface CarouselItem { unit: BookUnit | null; index: number; chapterId: string | null; sceneId: string | null; }
  const carousel = useMemo((): { prev: CarouselItem | null; current: CarouselItem | null; next: CarouselItem | null } => {
    const sc = currentScene();
    const units = sc?.units ?? [];
    const scenes = chapters[currentChIndex]?.scenes ?? [];
    const p = positionSignal.value;
    const idx = p.unitIndex;
    const mk = (chIdx: number, scIdx: number, u: BookUnit | null, uIndex: number): CarouselItem => ({
      unit: u,
      index: uIndex,
      chapterId: chapters[chIdx]?.chapter_id ?? null,
      sceneId: chapters[chIdx]?.scenes?.[scIdx]?.scene_id ?? null,
    });
    let prev: CarouselItem | null = null;
    let current: CarouselItem | null = null;
    let next: CarouselItem | null = null;
    if (sc && units.length > 0) {
      current = mk(currentChIndex, currentScIndex, units[idx] ?? null, idx);
      if (idx > 0) {
        prev = mk(currentChIndex, currentScIndex, units[idx - 1], idx - 1);
      } else if (currentScIndex > 0) {
        const prevSc = scenes[currentScIndex - 1];
        const prevUnits = prevSc?.units ?? [];
        if (prevUnits.length > 0) prev = mk(currentChIndex, currentScIndex - 1, prevUnits[prevUnits.length - 1], prevUnits.length - 1);
      } else if (currentChIndex > 0) {
        const prevChScenes = chapters[currentChIndex - 1]?.scenes ?? [];
        const prevSc = prevChScenes[prevChScenes.length - 1];
        const prevUnits = prevSc?.units ?? [];
        if (prevUnits.length > 0) prev = mk(currentChIndex - 1, prevChScenes.length - 1, prevUnits[prevUnits.length - 1], prevUnits.length - 1);
      }
      if (idx + 1 < units.length) {
        next = mk(currentChIndex, currentScIndex, units[idx + 1], idx + 1);
      } else if (currentScIndex < scenes.length - 1) {
        const nextSc = scenes[currentScIndex + 1];
        const nextUnits = nextSc?.units ?? [];
        if (nextUnits.length > 0) next = mk(currentChIndex, currentScIndex + 1, nextUnits[0], 0);
      } else if (currentChIndex < chapters.length - 1) {
        const nextSc = chapters[currentChIndex + 1]?.scenes?.[0];
        const nextUnits = nextSc?.units ?? [];
        if (nextUnits.length > 0) next = mk(currentChIndex + 1, 0, nextUnits[0], 0);
      }
    }
    return { prev, current, next };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChIndex, currentScIndex, bookData, positionSignal.value]);

  // ── Full-size image zoom (opens from the current carousel card) ──
  // Uses the original IU image (/iu-image) rather than the downscaled preview
  // (preview is a capped PNG; the zoom shows the full render).
  const openZoom = useCallback((item: CarouselItem | null) => {
    if (!item || !item.chapterId || !item.sceneId || !item.unit) return;
    const url = `/api/v1/iu-image/${encodeURIComponent(bid)}/${encodeURIComponent(item.chapterId)}/${encodeURIComponent(item.sceneId)}/${encodeURIComponent(unitId(item.unit, item.index))}?build_id=${encodeURIComponent(bld)}`;
    setZoomFailed(false);
    setZoom({ url, label: `${t('navigate_unit')} ${item.index + 1}` });
  }, [bid, bld]);

  // Zoom dialog: Escape closes it + locks body scroll while open.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [zoom]);

  return (
    <section class="page edit-page">
      {/* Position bar — tappable → Navigate */}
      <button class="gen-posbar edit-posbar" type="button" onClick={() => navigate('/navigate')}>
        <span class="gen-posbar__label">{posLabel}</span>
        {hasUnits && <span class="gen-posbar__units">{unitCountText}</span>}
      </button>

      {/* Unit carousel — collapsible panel (web deviation: frees vertical
          space for the editor). Expanded = original carousel + a small
          collapse chevron floating in its top-right corner (zero extra
          height). Collapsed = thin title strip that re-expands on tap.
          The carousel stays mounted (hidden via CSS) so image sizes restore
          exactly; current card opens the full-size image. */}
      <div class={'edit-panel' + (carouselCollapsed ? ' edit-panel--collapsed' : '')}>
        <button class="edit-panel__strip" type="button" aria-expanded={!carouselCollapsed} onClick={() => setCarouselCollapsed(false)}>
          <span class="edit-panel__title">{t('edit_carousel_title')}</span>
          <span class="edit-panel__chev" aria-hidden="true"><IconChevronDown width={18} height={18} /></span>
        </button>
        <button class="edit-panel__collapse" type="button" aria-label={t('edit_collapse')} onClick={() => setCarouselCollapsed(true)}>
          <IconChevronUp width={16} height={16} />
        </button>
        <div class="edit-carousel">
          <CarouselCard kind="prev" bid={bid} bld={bld} item={carousel.prev} onClick={() => carousel.prev && navigateUnit(-1)} />
          <CarouselCard kind="current" bid={bid} bld={bld} item={carousel.current} onClick={() => openZoom(carousel.current)} />
          <CarouselCard kind="next" bid={bid} bld={bld} item={carousel.next} onClick={() => carousel.next && navigateUnit(1)} />
        </div>
      </div>

      {/* Audio timeline panel — collapsible (same web deviation). Collapsing
          stops playback so audio never plays without the visible waveform. */}
      {timelineVisible && (
        <div class={'edit-panel' + (timelineCollapsed ? ' edit-panel--collapsed' : '')}>
          <button class="edit-panel__strip" type="button" aria-expanded={!timelineCollapsed} onClick={() => setTimelineCollapsed(false)}>
            <span class="edit-panel__title">{t('edit_waveform_title')}</span>
            <span class="edit-panel__chev" aria-hidden="true"><IconChevronDown width={18} height={18} /></span>
          </button>
          <button class="edit-panel__collapse" type="button" aria-label={t('edit_collapse')} onClick={() => { stopPlaybackInternal(); setTimelineCollapsed(true); }}>
            <IconChevronUp width={16} height={16} />
          </button>
          <div class="edit-timeline">
            <button class="edit-timeline__btn" type="button" aria-label={isPlaying ? t('timeline_stop') : t('timeline_play')} onClick={togglePlayback}>
              {isPlaying ? <IconStop width={22} height={22} /> : <IconPlay width={22} height={22} />}
            </button>
            <div class="edit-timeline__wave">
              <Waveform
                peaks={waveformData?.peaks ?? []}
                durationMs={Math.round((waveformData?.duration_sec ?? 0) * 1000)}
                selection={selection}
                playbackSignal={playbackPos}
                onRangeChange={handleRangeChange}
                onRangeChangeEnd={handleRangeChangeEnd}
              />
            </div>
            <button class="edit-timeline__btn" type="button" aria-label={t('timeline_reset')} onClick={resetCurrentUnitTiming}>
              <IconReset width={22} height={22} />
            </button>
          </div>
        </div>
      )}

      {/* Property tabs with scroll indicators */}
      <div class="edit-tabs">
        <button class="edit-tabs__scroll" type="button" aria-label="Scroll left" disabled={!canScrollLeft} style={{ opacity: canScrollLeft ? 1 : 0.3 }} onClick={() => scrollTabs(-1)}>
          <IconChevronLeft width={20} height={20} />
        </button>
        <div class="edit-tabs__scroll-x" ref={tabsScrollRef} onScroll={updateTabScrollIndicators}>
          {TABS.map((key, i) => (
            <button
              key={key}
              type="button"
              class={'edit-tabs__item' + (i === tab ? ' edit-tabs__item--active' : '')}
              onClick={() => setTab(i)}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <button class="edit-tabs__scroll" type="button" aria-label="Scroll right" disabled={!canScrollRight} style={{ opacity: canScrollRight ? 1 : 0.3 }} onClick={() => scrollTabs(1)}>
          <IconChevronRight width={20} height={20} />
        </button>
      </div>

      {/* Content area */}
      <div class="edit-content">
        {loading ? <div class="progress"><div class="progress__bar" /></div> : renderContent()}
      </div>

      {/* Bottom save row */}
      <div class="edit-bottom">
        <button
          class="edit-save"
          type="button"
          disabled={saveBusy}
          style={{ opacity: saveBusy ? 0.5 : 1 }}
          onClick={saveToBackend}
        >
          <IconSave width={20} height={20} />
          {saveDirty ? `${saveText} *` : saveText}
        </button>
      </div>

      {/* Dirty indicator — server diff summary after regeneration */}
      {dirty && ((dirty.changed ?? 0) + (dirty.added ?? 0) + (dirty.removed ?? 0)) > 0 && (
        <div class="edit-dirty">{dirtyIndicatorText(dirty)}</div>
      )}

      {/* Error */}
      {errorText && <div class="edit-error">{errorText}</div>}

      {/* Empty state */}
      {!bid && !loading && <div class="edit-empty">{t('no_book_loaded')}</div>}

      {/* Full-size image zoom dialog (backdrop click / Escape / X closes) */}
      {zoom && (
        <div class="zoom-backdrop" role="presentation" onClick={() => setZoom(null)}>
          <div class="zoom" role="dialog" aria-modal="true" aria-label={zoom.label} onClick={(e) => e.stopPropagation()}>
            {zoomFailed ? (
              <span class="zoom__fallback"><IconImageOff width={40} height={40} /> {t('iu_not_generated')}</span>
            ) : (
              <img class="zoom__img" src={zoom.url} alt={zoom.label} onError={() => setZoomFailed(true)} />
            )}
            <span class="zoom__label">{zoom.label}</span>
          </div>
          <button class="zoom__close" type="button" aria-label={t('edit_close')} onClick={() => setZoom(null)}>
            <IconClose width={20} height={20} />
          </button>
        </div>
      )}
    </section>
  );
}

function dirtyIndicatorText(dirty: { changed?: number; added?: number; removed?: number }): string {
  const parts: string[] = [];
  if (dirty.changed) parts.push(`${dirty.changed} changed`);
  if (dirty.added) parts.push(`${dirty.added} added`);
  if (dirty.removed) parts.push(`${dirty.removed} removed`);
  return `Dirty: ${parts.join(', ')}`;
}

// ── Carousel card — preview image + missing overlay. The card's height is
// driven by the <img> itself (block, width:100%, height:auto): the browser
// preserves the image's own aspect ratio natively, so portrait images always
// get portrait cards — exactly like Android loadPreviewImage (hDp = cardWDp
// × h/w), but with zero JS measurement/races. Missing images fall back to the
// card's 140dp min-height. ──
function CarouselCard({ kind, bid, bld, item, onClick }: {
  kind: 'prev' | 'current' | 'next';
  bid: string;
  bld: string;
  item: { unit: BookUnit | null; index: number; chapterId: string | null; sceneId: string | null } | null;
  onClick: () => void;
}) {
  const isCurrent = kind === 'current';
  const unit = item?.unit ?? null;

  return (
    <div
      class={`edit-unit-card edit-unit-card--${kind}${!item ? ' edit-unit-card--hidden' : ''}`}
      role={unit ? 'button' : undefined}
      tabIndex={unit ? 0 : -1}
      onClick={onClick}
      onKeyDown={unit ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      {item && item.chapterId && item.sceneId && unit ? (
        <UnitPreview
          bid={bid}
          bld={bld}
          chapterId={item.chapterId}
          sceneId={item.sceneId}
          unitId={unitId(unit, item.index)}
          isCurrent={isCurrent}
          label={isCurrent && unit ? `${t('navigate_unit')} ${item.index + 1}` : null}
        />
      ) : isCurrent ? (
        <span class="edit-unit-card__icon"><IconImageOff width={28} height={28} /></span>
      ) : null}
    </div>
  );
}

// Unit preview — loads GET /preview/...?build_id=; fallback ic_image_off +
// "Не сгенерировано" overlay (showPreviewMissing). The <img> is in normal
// flow (not absolute) so its natural aspect ratio sets the card height.
function UnitPreview({ bid, bld, chapterId, sceneId, unitId, isCurrent, label }: {
  bid: string;
  bld: string;
  chapterId: string;
  sceneId: string;
  unitId: string;
  isCurrent: boolean;
  label: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [unitId]);

  if (failed) {
    return (
      <>
        <span class="edit-unit-card__icon"><IconImageOff width={28} height={28} /></span>
        <span class="edit-unit-card__label">{t('iu_not_generated')}</span>
      </>
    );
  }
  const src = `/api/v1/preview/${encodeURIComponent(bid)}/${encodeURIComponent(chapterId)}/${encodeURIComponent(sceneId)}/${encodeURIComponent(unitId)}?build_id=${encodeURIComponent(bld)}`;
  return (
    <>
      <img
        class="edit-unit-card__img"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {isCurrent && label && <span class="edit-unit-card__label">{label}</span>}
    </>
  );
}

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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { deleteJson, getJson, patchJson, postJson, putJson } from '../api/client';
import type {
  AppConfig, BookChapter, BookData, BookScene, BookUnit, CharPassport, SceneTiming, WaveformData,
} from '../api/models';
import { t, tf } from '../app/i18n';
import { navigate } from '../app/router';
import { useDesktopShell } from '../app/desktop';
import {
  bookId as bookIdSignal, buildId as buildIdSignal, dirtySummary as dirtySignal, onPlaybackPrepared,
} from '../state/generateStore';
import { navigateTo, position as positionSignal } from '../state/positionStore';
import { seekToPosition } from '../state/playbackStore';
import { Waveform } from '../lib/waveform';
import { DeleteConfirmDialog, ENTITY_SCHEMAS, EntityAddButton, EntityDeleteButton, EntityEditorDialog, StructureAddDialog } from '../lib/entityEditor';
import type { EntityKind, StructureKind, StructureParentOption } from '../lib/entityEditor';
import { chapterId as genChapterId, sceneId as genSceneId, unitId as genUnitId } from '../lib/idgen';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconClock, IconClose, IconFullscreen, IconImageOff, IconPlay, IconReset, IconSave, IconStop } from '../app/icons';

// ── Tabs (propertyTabs) — Chapter is the first level, then Scene → Audio →
//    Unit ("Модуль") → Characters/Voices/Locations/Global. Default to Unit
//    (index 3) like EditFragment ──
const TABS = ['edit_chapter_tab', 'edit_scene', 'edit_audio', 'edit_units_tab', 'edit_characters_tab', 'edit_voices_tab', 'edit_locations_tab', 'edit_global_tab'] as const;
const DEFAULT_TAB = 3;
const CHAPTER_TAB = 0;
const SCENE_TAB = 1;
const AUDIO_TAB = 2;
const UNITS_TAB = 3;
const CHARS_TAB = 4;
const VOICES_TAB = 5;
const LOCATIONS_TAB = 6;
const GLOBAL_TAB = 7;

const PASSPORT_OVERRIDE_FIELDS = ['appearance', 'clothes', 'video_tokens'];

interface OverrideBlock {
  charId: string;
  fields: Record<string, string>;
}

// ── Desktop draft persistence across mounts (Phase 9, plan §1.1/§14) ──
// Mode switches and route changes (mode switcher, "Open in Player", back /
// forward) unmount EditPage. A dirty desktop draft is snapshotted here on
// unmount and restored on the next mount — the in-mount position observer only
// covers changes while the page stays mounted, so without this a long prompt
// would be silently lost whenever the user leaves the editor. Mobile keeps the
// Android 1:1 discard behaviour (nothing is ever stored there).
interface StoredDraft {
  chapterId: string | null;
  sceneId: string | null;
  unitIndex: number;
  tab: number;
  fv: Record<string, string>;
  blocks: OverrideBlock[];
}
let storedDraft: StoredDraft | null = null;
function storeDesktopDraft(d: StoredDraft): void { storedDraft = d; }
// takeDesktopDraft — read-once: the mount restore consumes the snapshot.
function takeDesktopDraft(): StoredDraft | null {
  const d = storedDraft;
  storedDraft = null;
  return d;
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
    case 'appearance': return t('field_appearance');
    case 'clothes': return t('field_clothes');
    case 'video_tokens': return t('field_video_tokens');
    default: return key;
  }
}

// Render a passport field value as editable text. video_tokens may be an array
// of features (agent scheme) or a legacy string — String([...]) would join
// WITHOUT a space ("a,b"), so arrays are joined explicitly with ", ".
function passportFieldText(p: CharPassport | null | undefined, f: string): string {
  const raw = p ? (p as CharPassport)[f as keyof CharPassport] : undefined;
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
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
  // Desktop prompt editors (image.prompt / video.action) render as dedicated
  // tall textareas ONLY in the desktop shell — mobile keeps the 1:1 Android
  // field rendering (plan §5.4, §10: desktop gated by the shared breakpoint).
  const isDesktop = useDesktopShell();
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

  // Entity Add/Delete (Characters / Locations / Voices tables) — one reusable
  // schema-driven pattern; both dialogs share the busy/error state since only
  // one is open at a time.
  const [entityAddKind, setEntityAddKind] = useState<EntityKind | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: EntityKind; id: string } | null>(null);
  const [entityBusy, setEntityBusy] = useState(false);
  const [entityError, setEntityError] = useState<string | null>(null);

  // Structure Add/Delete (chapters / scenes / units — the editor hierarchy).
  // Reuses the entity busy/error state: only one dialog is open at a time.
  const [structureAddKind, setStructureAddKind] = useState<StructureKind | null>(null);
  // Readonly id preview for the open add dialog (generated client-side, the
  // server keeps it when unique and otherwise regenerates it).
  const [structurePreviewId, setStructurePreviewId] = useState('');
  interface StructureDeleteTarget {
    kind: StructureKind;
    chapterId: string;
    sceneId: string | null;
    id: string;
  }
  const [structureDelete, setStructureDelete] = useState<StructureDeleteTarget | null>(null);

  // Timeline (waveform + timings + audio playback).
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  // Synchronous mirror — the waveform drag writes it before saveTimings reads it
  // (React setState is async; Android mutated a plain var).
  const timingDataRef = useRef<SceneTiming | null>(null);
  const [timelineVisible, setTimelineVisible] = useState(false);
  // Collapsible panels (web deviation — frees vertical space for the editor).
  const [carouselCollapsed, setCarouselCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  // Desktop draft protection (plan §5.2): pending unit navigation action
  // awaiting the user's Save / Discard / Cancel decision when the draft is dirty.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
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
  // One-shot guard: when a draft is restored (mount restore or the in-mount
  // recover modal), ensurePassportBlocks must NOT rebuild the restored blocks
  // from the scene's canonical passport right after the reload — the restored
  // override edits may be unsaved and would be silently clobbered. The flag is
  // consumed by the first ensure call for the restored scene.
  const preserveBlocksRef = useRef(false);

  // Tab scroll indicators.
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  // Pending center-selected-tab retry (used while the strip has no layout yet).
  const centerRafRef = useRef<number | null>(null);

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

  // ── Draft snapshot for external navigation (plan §5.2): when the position
  //    changes from OUTSIDE the editor (Navigator panel click, AI, deep link)
  //    while a desktop draft is dirty, the field values are snapshotted and a
  //    recover modal offers to go back instead of silently losing the draft.
  //    Mobile keeps the Android 1:1 discard behaviour (no prompt).
  const draftSnapshot = useRef<{
    chapterId: string | null; sceneId: string | null; unitIndex: number;
    tab: number; fv: Record<string, string>; blocks: OverrideBlock[];
  } | null>(null);
  const [draftRecoverOpen, setDraftRecoverOpen] = useState(false);

  // Set while restoreDraft navigates back to the snapshotted position — the
  // position observer must not clear the restored draft or re-snapshot it.
  const restoringRef = useRef(false);

  // Latest-value mirrors for the unmount draft snapshot: effect closures capture
  // the values from the render they were created in, and the save effect has a
  // stable dep — refs keep the cleanup reading the CURRENT tab / override blocks.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const overrideBlocksRef = useRef(overrideBlocks);
  overrideBlocksRef.current = overrideBlocks;

  // ── Mount restore (Phase 9): a draft left dirty on a previous visit comes
  //    back — same position → fields restored directly (loadAndSync only seeds
  //    keys inputCard has not already set); other position → the recover modal
  //    offers to go back, exactly like an in-mount external navigation.
  useEffect(() => {
    if (!isDesktop) return;
    const stored = takeDesktopDraft();
    if (!stored) return;
    const p = positionSignal.value;
    const samePosition = stored.chapterId === p.chapterId
      && stored.sceneId === p.sceneId
      && stored.unitIndex === p.unitIndex;
    if (samePosition) {
      fieldValues.current = { ...stored.fv };
      setOverrideBlocks(stored.blocks);
      blocksSceneKey.current = null;
      preserveBlocksRef.current = true;
      setTab(stored.tab);
      saveDirtyRef.current = true;
      setSaveDirty(true);
    } else {
      draftSnapshot.current = stored;
      setDraftRecoverOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  // ── Unmount snapshot (Phase 9): leaving the editor with a dirty desktop
  //    draft stores it for the mount restore above instead of losing it.
  useEffect(() => {
    return () => {
      if (!isDesktop || !saveDirtyRef.current) return;
      const p = positionSignal.value;
      if (p.chapterId == null || p.sceneId == null) return;
      storeDesktopDraft({
        chapterId: p.chapterId,
        sceneId: p.sceneId,
        unitIndex: p.unitIndex,
        tab: tabRef.current,
        fv: { ...fieldValues.current },
        blocks: overrideBlocksRef.current.map((b) => ({ charId: b.charId, fields: { ...b.fields } })),
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  // ── Observe position (observePosition) — reload on every position change ──
  // Structured mirror of the last seen position (in addition to the key) so a
  // dirty desktop draft can be snapshotted without parsing a joined string.
  const lastPosRef = useRef<{ chapterId: string | null; sceneId: string | null; unitIndex: number } | null>(null);
  const lastPosKey = useRef<string | null>(null);
  if (lastPosKey.current === null) {
    const p = positionSignal.value;
    lastPosKey.current = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}|${p.unitIndex}` : null;
    lastPosRef.current = { chapterId: p.chapterId, sceneId: p.sceneId, unitIndex: p.unitIndex };
  }
  useEffect(() => {
    const p = positionSignal.value;
    const key = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}|${p.unitIndex}` : null;
    if (key !== lastPosKey.current) {
      lastPosKey.current = key;
      // Restore path: keep the restored draft untouched, just reload the scene.
      if (restoringRef.current) {
        restoringRef.current = false;
        lastPosRef.current = { chapterId: p.chapterId, sceneId: p.sceneId, unitIndex: p.unitIndex };
        if (p.chapterId != null && p.sceneId != null) {
          void loadAndSync(p.chapterId, p.sceneId);
        } else if (!bookIdSignal.value) {
          clearEditor();
        }
        return;
      }
      // Desktop + dirty draft + a real previous position → snapshot instead of
      // discarding. Editor-internal navigation never reaches here dirty (the
      // confirm modal in requestUnitNavigation/requestUnitJump handles it), so
      // this only fires for external position changes.
      const prev = lastPosRef.current;
      lastPosRef.current = { chapterId: p.chapterId, sceneId: p.sceneId, unitIndex: p.unitIndex };
      if (isDesktop && saveDirtyRef.current && prev != null) {
        draftSnapshot.current = {
          chapterId: prev.chapterId,
          sceneId: prev.sceneId,
          unitIndex: prev.unitIndex,
          tab,
          fv: { ...fieldValues.current },
          blocks: overrideBlocks.map((b) => ({ charId: b.charId, fields: { ...b.fields } })),
        };
        setDraftRecoverOpen(true);
      }
      // Any navigation discards the active field edits (Android
      // fieldValues.clear() on unit moves as well as scene changes) — 1:1. The
      // snapshot above preserves the desktop draft for the recover path.
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

  // ── Auto-position when a book is loaded but no position is selected yet
  //    (EditFragment.loadBookAndAutoPosition parity): a fresh generation can
  //    finish with the position still unset — the RAW_IMPORTED book had no
  //    scenes at import time, so importBookFromFile navigated to null and the
  //    editor would otherwise stay empty. Anchor at the first chapter's first
  //    scene, unit 0, exactly like Android EditFragment. applyGenerationResults
  //    also sets the position on generation completion, so this fallback only
  //    fires when the editor is opened directly with a loaded book + null
  //    position (mount or book change).
  const loadBookAndAutoPosition = useCallback(async () => {
    const bId = bookIdSignal.value;
    if (!bId) return;
    try {
      const bd = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
      // Race guard: the user may have picked a position elsewhere while the
      // fetch was in flight — never clobber a newer choice.
      if (positionSignal.value.chapterId != null) return;
      const chs = bd.chapters ?? [];
      const firstCh = chs[0];
      const firstSc = firstCh?.scenes?.[0];
      if (firstCh && firstSc) {
        navigateTo({
          chapterId: firstCh.chapter_id ?? null,
          sceneId: firstSc.scene_id ?? null,
          unitId: firstSc.units?.[0]?.id ?? null,
          chunkId: null,
          unitIndex: 0,
        });
      }
    } catch { /* keep the empty state (no book data to position on) */ }
  }, []);

  useEffect(() => {
    const p = positionSignal.value;
    if (p.chapterId == null && bookIdSignal.value) {
      void loadBookAndAutoPosition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, loadBookAndAutoPosition]);

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

  // ── Desktop draft protection (plan §5.2): navigating units with unsaved
  //    edits on desktop asks Save / Discard / Cancel instead of silently
  //    dropping the draft (mobile keeps the Android 1:1 discard behaviour).
  //    Pending actions are stored as closures so both carousel deltas and
  //    thumbnail-rail jumps use the same confirmation flow.
  const requestUnitNavigation = useCallback((delta: number) => {
    if (isDesktop && saveDirtyRef.current) {
      setPendingNav(() => () => navigateUnit(delta));
    } else {
      navigateUnit(delta);
    }
  }, [isDesktop, navigateUnit]);

  // ── Jump to an absolute unit index within the current scene (thumbnail rail,
  //    plan §5.3) — position + seekToPosition, same semantics as navigateUnit's
  //    in-scene branch.
  const jumpToUnit = useCallback((index: number) => {
    const sc = currentScene();
    if (!sc) return;
    const units = sc.units ?? [];
    const clamped = Math.max(0, Math.min(index, units.length - 1));
    const u = units[clamped];
    navigateTo({
      chapterId: chapters[currentChIndex]?.chapter_id ?? null,
      sceneId: sc.scene_id ?? null,
      unitId: u?.id ?? null,
      chunkId: null,
      unitIndex: clamped,
    });
    const chId = chapters[currentChIndex]?.chapter_id;
    if (chId != null && sc.scene_id != null) {
      void seekToPosition(chId, sc.scene_id, clamped, u ? unitId(u, clamped) : null);
    }
  }, [currentChIndex, currentScIndex, chapters, bookData]);

  const requestUnitJump = useCallback((index: number) => {
    // Jumping to the already-active unit is a no-op — never prompt for it.
    if (index === positionSignal.value.unitIndex) return;
    if (isDesktop && saveDirtyRef.current) {
      setPendingNav(() => () => jumpToUnit(index));
    } else {
      jumpToUnit(index);
    }
  }, [isDesktop, jumpToUnit]);

  // ── Restore an externally-navigated-away draft (plan §5.2): switch back to
  //    the snapshotted position, restore tab/fields/overrides and mark dirty so
  //    the user can review and save. The position change reloads the scene.
  const restoreDraft = useCallback(() => {
    const snap = draftSnapshot.current;
    if (!snap) return;
    draftSnapshot.current = null;
    setDraftRecoverOpen(false);
    fieldValues.current = { ...snap.fv };
    setOverrideBlocks(snap.blocks);
    blocksSceneKey.current = null;
    preserveBlocksRef.current = true;
    setTab(snap.tab);
    saveDirtyRef.current = true;
    setSaveDirty(true);
    if (snap.chapterId != null && snap.sceneId != null) {
      restoringRef.current = true;
      navigateTo({ chapterId: snap.chapterId, sceneId: snap.sceneId, unitId: null, chunkId: null, unitIndex: snap.unitIndex });
    }
  }, []);

  const discardDraft = useCallback(() => {
    draftSnapshot.current = null;
    setDraftRecoverOpen(false);
  }, []);

  // ── Passport override blocks (ensurePassportBlocks) ──
  // buildBlocksFromScene is a pure builder used both synchronously during render
  // (no setState-during-render) and by the effect that syncs state on scene change.
  function buildBlocksFromScene(sc: BookScene): OverrideBlock[] {
    const blocks: OverrideBlock[] = [];
    const passport = sc.passport ?? {};
    Object.entries(passport).forEach(([charId, p]) => {
      const fields: Record<string, string> = {};
      PASSPORT_OVERRIDE_FIELDS.forEach((f) => {
        const raw = p ? (p as CharPassport)[f as keyof CharPassport] : undefined;
        // video_tokens may be an array of features (agent scheme) — render as text.
        const v = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
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
    // A restored draft must survive the canonical rebuild (see preserveBlocksRef).
    if (preserveBlocksRef.current) {
      preserveBlocksRef.current = false;
      return;
    }
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
        const oldVal = have ? passportFieldText(have as CharPassport, f) : '';
        if (newVal !== oldVal) {
          result[`passport.${charId}.${f}`] = newVal;
        }
      });
    });
    return result;
  }, [overrideBlocks]);

  // ── Save (saveToBackend) — resolves true only when the save succeeded, so
  //    desktop draft protection can continue navigation after a confirmed save
  //    (plan §5.2) and never loses a long prompt on failure.
  const saveToBackend = useCallback(async (): Promise<boolean> => {
    const bd = bookData;
    const bId = bookIdSignal.value;
    if (!bd || !bId) {
      showSaveError('No book data');
      return false;
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
        return true;
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
        return false;
      }
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
          return true;
        }
        // Top-level locations.json wins; legacy bible.locations is the fallback
        // (mirrors buildLocationsFields).
        const existingLocs = { ...(bd.locations ?? {}), ...(bd.bible?.locations ?? {}) };
        for (const [locId, fields] of byLoc) {
          // Skip entities deleted since the editor rendered (stale fieldValues).
          if (!(locId in existingLocs)) continue;
          await patchJson(`/book/${encodeURIComponent(bId)}/locations/${encodeURIComponent(locId)}`, { fields });
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
        return true;
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
        return false;
      }
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
          // Skip entities deleted since the editor rendered (stale fieldValues).
          if (!orig) continue;
          const changed: Record<string, string> = {};
          Object.entries(fields).forEach(([k, v]) => {
            // passport.<field> keys must compare against the REAL field
            // (p[field]); passportFieldText(p, 'passport.appearance') would look
            // up p['passport.appearance'] — always '' — so clearing a field to
            // empty never persisted and untouched fields were re-sent every save.
            const oldVal = k === 'name'
              ? (orig?.name ?? '')
              : passportFieldText(orig?.passport as CharPassport | null, k.startsWith('passport.') ? k.slice('passport.'.length) : k);
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
          return true;
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
        saveDirtyRef.current = false;
        setSaveDirty(false);
        return true;
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
        return false;
      }
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
          // Skip entities deleted since the editor rendered (stale fieldValues).
          if (!(voiceId in voices)) continue;
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
          return true;
        }
        const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
        if (fresh) setBookData(fresh);
        setSaveLoading(false, true);
        setErrorText(null);
        saveDirtyRef.current = false;
        setSaveDirty(false);
        return true;
      } catch (e) {
        showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
        return false;
      }
    }

    const ch = chapters[currentChIndex];
    const sc = currentScene();
    const chapterId = ch?.chapter_id;
    const sceneId = sc?.scene_id;
    if (!ch || !sc || !chapterId || !sceneId) {
      showSaveError('No chapter data');
      return false;
    }

    setSaveLoading(true, true);
    try {
      let fields: Record<string, string> = {};
      const body: Record<string, unknown> = { fields };

      if (tab === CHAPTER_TAB) {
        // Chapter-level fields only — chapter_title (and future chapter data).
        const chapterTitle = fv['chapter_title']?.trim();
        if (chapterTitle) body['chapter_title'] = chapterTitle;
      } else if (tab === SCENE_TAB) {
        const sceneKeys = ['scene_title', 'type', 'style', 'participants', 'location.id', 'env.time', 'env.lighting', 'env.weather', 'env.mood', 'env.atmosphere', 'env.country', 'env.epoch'];
        sceneKeys.forEach((k) => { if (k in fv) fields[k] = fv[k]; });
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
      return true;
    } catch (e) {
      showSaveError(`${(e as Error).name}: ${(e as Error).message || 'unknown'}`);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bookData, chapters, currentChIndex, currentScIndex, buildPassportOverrideFields, showSaveError, setSaveLoading]);

  // ── Ctrl/Cmd+S — desktop editor save (plan §5.2): the same explicit save
  //    path, triggered from the keyboard when a draft is dirty. Works on all
  //    desktop widths; harmless on touch where the shortcut rarely fires.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // e.code (physical key) is layout-independent: Ctrl+S / Cmd+S works on
      // RU and EN layouts alike (e.key would be 's' or 'ы' depending on layout).
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        if (saveDirtyRef.current) void saveToBackend();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveToBackend]);

  // ── Arrow-key unit navigation (desktop, plan §5.3/§11): Left/Right move the
  //    active unit only when focus is NOT inside an editable control (input,
  //    textarea, select, contenteditable) — text editing shortcuts stay
  //    untouched. Gated by isDesktop so mobile keeps its existing behaviour.
  useEffect(() => {
    if (!isDesktop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (zoom || pendingNav !== null || draftRecoverOpen) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      e.preventDefault();
      requestUnitNavigation(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, requestUnitNavigation, zoom, pendingNav, draftRecoverOpen]);

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

  // Center the selected tab in the scrollable strip (Android parity:
  // EditFragment.centerSelectedTab). Android computes the scroll position that
  // puts the tab's center at the viewport's center —
  //   target = tab.left − (viewportWidth − tabWidth)/2
  // — clamps it to the scroll range and smooth-scrolls. If the selected tab is
  // already centered (delta ≈ 0) the scroll is skipped. While the strip/tab
  // has no layout (0 width) the attempt is retried on the next frame.
  const centerSelectedTab = useCallback((index: number, attempts = 0) => {
    const el = tabsScrollRef.current;
    const tab = el ? (el.children[index] as HTMLElement | undefined) : undefined;
    if (!el || !tab) return;
    const viewport = el.clientWidth;
    const tabWidth = tab.offsetWidth;
    if (viewport <= 0 || tabWidth <= 0) {
      if (attempts < 30) {
        centerRafRef.current = requestAnimationFrame(() => centerSelectedTab(index, attempts + 1));
      }
      return;
    }
    const tabRect = tab.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    // tab.left relative to the strip's content origin (scroll coordinate 0).
    const tabLeft = tabRect.left - elRect.left;
    const target = tabLeft - (viewport - tabWidth) / 2;
    const maxScroll = Math.max(0, el.scrollWidth - viewport);
    const clamped = Math.min(Math.max(target, 0), maxScroll);
    // Already centered (or everything fits) — no redundant scroll.
    if (Math.abs(clamped - el.scrollLeft) < 2) {
      updateTabScrollIndicators();
      return;
    }
    el.scrollTo({ left: clamped, behavior: 'smooth' });
    updateTabScrollIndicators();
  }, [updateTabScrollIndicators]);

  // Center the selected tab on every switch — user taps AND programmatic
  // switches (mount draft restore, draft-recover restore, default tab) all
  // funnel through setTab, so this single effect covers both.
  useEffect(() => {
    if (centerRafRef.current != null) {
      cancelAnimationFrame(centerRafRef.current);
      centerRafRef.current = null;
    }
    centerSelectedTab(tab);
  }, [tab, centerSelectedTab]);

  useEffect(() => () => {
    if (centerRafRef.current != null) cancelAnimationFrame(centerRafRef.current);
  }, []);

  // Initial + reactive scroll-indicator state. The chevrons must be computed on
  // the very first render (before any scroll event fires) — otherwise a tab row
  // that overflows to the right starts with an inactive right chevron until the
  // user nudges the scroll. useLayoutEffect keeps the very first painted frame
  // correct (Android parity: EditFragment posts updateTabScrollIndicators()
  // right after view setup). ResizeObserver + window resize keep the state in
  // sync when the window or the container changes size.
  useLayoutEffect(() => {
    updateTabScrollIndicators();
    const onResize = () => updateTabScrollIndicators();
    window.addEventListener('resize', onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && tabsScrollRef.current) {
      ro = new ResizeObserver(onResize);
      ro.observe(tabsScrollRef.current);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [updateTabScrollIndicators]);

  // ── Entity add/delete (Characters / Locations / Voices) ──
  // Save/delete go through the dedicated backend endpoints (POST/DELETE
  // /characters, /locations, /voices); after success the canonical book data is
  // re-fetched so the table updates without a manual page reload. The id stays
  // free-form here — the server transliterates non-canonical input via the
  // existing backend utility (never duplicated on the client).
  const refreshBook = useCallback(async () => {
    const bId = bookIdSignal.value;
    if (!bId) return;
    const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
    if (fresh) setBookData(fresh);
  }, []);

  const entityCollection = useCallback((kind: EntityKind): string =>
    kind === 'character' ? 'characters' : kind === 'location' ? 'locations' : 'voices', []);

  const buildCreateBody = useCallback((kind: EntityKind, values: Record<string, string>): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    const id = (values.id ?? '').trim();
    const name = (values.name ?? '').trim();
    if (id) body.id = id;
    if (name) body.name = name;
    if (kind === 'character') {
      const passport: Record<string, string> = {};
      ['appearance', 'clothes', 'video_tokens'].forEach((f) => {
        const v = (values[`passport.${f}`] ?? '').trim();
        if (v) passport[f] = v;
      });
      if (Object.keys(passport).length > 0) body.passport = passport;
    } else if (kind === 'location') {
      const desc = (values.description ?? '').trim();
      if (desc) body.description = desc;
      const env: Record<string, string> = {};
      ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere'].forEach((f) => {
        const v = (values[`environment.${f}`] ?? '').trim();
        if (v) env[f] = v;
      });
      if (Object.keys(env).length > 0) body.environment = env;
    } else {
      const instruction = (values.instruction ?? '').trim();
      if (instruction) body.instruction = instruction;
    }
    return body;
  }, []);

  const saveEntity = useCallback(async (kind: EntityKind, values: Record<string, string>) => {
    const bId = bookIdSignal.value;
    if (!bId) return;
    setEntityBusy(true);
    setEntityError(null);
    try {
      await postJson(`/book/${encodeURIComponent(bId)}/${entityCollection(kind)}`, buildCreateBody(kind, values));
      setEntityAddKind(null);
      await refreshBook();
    } catch (e) {
      setEntityError((e as Error).message);
    } finally {
      setEntityBusy(false);
    }
  }, [entityCollection, buildCreateBody, refreshBook]);

  const confirmDeleteEntity = useCallback(async () => {
    const target = deleteTarget;
    const bId = bookIdSignal.value;
    if (!target || !bId) return;
    setEntityBusy(true);
    setEntityError(null);
    try {
      await deleteJson(`/book/${encodeURIComponent(bId)}/${entityCollection(target.kind)}/${encodeURIComponent(target.id)}`);
      setDeleteTarget(null);
      await refreshBook();
    } catch (e) {
      setEntityError((e as Error).message);
    } finally {
      setEntityBusy(false);
    }
  }, [deleteTarget, entityCollection, refreshBook]);

  const entityExistingIds = useMemo(() => {
    const bd = bookData;
    if (!bd) return new Set<string>();
    if (entityAddKind === 'character') return new Set((bd.characters ?? []).map((c) => c.id ?? ''));
    if (entityAddKind === 'location') return new Set(Object.keys(bd.locations ?? {}));
    return new Set(Object.keys(bd.voices ?? {}));
  }, [bookData, entityAddKind]);

  // ── Structure add/delete (chapters / scenes / units) ──
  // POST/DELETE through the dedicated endpoints; after success the canonical book
  // is re-fetched and the shared position is re-anchored, so the position
  // observer reloads the editor onto the new/nearest element. The ids come from
  // the server (the readonly dialog preview is used verbatim when unique). New
  // chapters/scenes are seeded with one unit by the backend — the editor is
  // always anchored on a valid chapter+scene+unit position.

  const openStructureAdd = useCallback((kind: StructureKind) => {
    setEntityError(null);
    setStructurePreviewId(kind === 'chapter' ? genChapterId() : kind === 'scene' ? genSceneId() : genUnitId());
    setStructureAddKind(kind);
  }, []);

  const structureChapters = useMemo<StructureParentOption[]>(() =>
    (bookData?.chapters ?? []).map((c, i) => ({
      id: c.chapter_id ?? '',
      label: c.chapter_title?.trim()
        ? tf('structure_chapter_option', c.display_number ?? i + 1, c.chapter_title.trim())
        : (c.chapter_id ?? `ch-${i}`),
    })), [bookData]);

  const structureScenes = useMemo<StructureParentOption[]>(() =>
    (bookData?.chapters ?? []).flatMap((c) =>
      (c.scenes ?? []).map((s) => ({
        chapterId: c.chapter_id ?? '',
        id: s.scene_id ?? '',
        label: s.scene_title?.trim() ? s.scene_title.trim() : (s.scene_id ?? ''),
      }))), [bookData]);

  const saveStructure = useCallback(async (kind: StructureKind, values: { chapterId: string | null; sceneId: string | null; title: string }) => {
    const bId = bookIdSignal.value;
    if (!bId) return;
    setEntityBusy(true);
    setEntityError(null);
    try {
      let position: { chapterId: string; sceneId: string; unitId: string; unitIndex: number } | null = null;
      if (kind === 'chapter') {
        const res = await postJson<{ chapter_id: string; scene_id: string; unit_id: string }>(`/book/${encodeURIComponent(bId)}/chapters`, {
          id: structurePreviewId,
          title: values.title,
          after_chapter_id: positionSignal.value.chapterId ?? null,
        });
        position = { chapterId: res.chapter_id, sceneId: res.scene_id, unitId: res.unit_id, unitIndex: 0 };
      } else if (kind === 'scene') {
        const res = await postJson<{ scene_id: string; unit_id: string }>(`/book/${encodeURIComponent(bId)}/chapters/${encodeURIComponent(values.chapterId ?? '')}/scenes`, {
          id: structurePreviewId,
          title: values.title,
        });
        position = { chapterId: values.chapterId ?? '', sceneId: res.scene_id, unitId: res.unit_id, unitIndex: 0 };
      } else {
        const chosenChapter = (bookData?.chapters ?? []).find((c) =>
          (c.scenes ?? []).some((s) => s.scene_id === values.sceneId))?.chapter_id ?? positionSignal.value.chapterId ?? '';
        const res = await postJson<{ unit_id: string; unit_index: number }>(`/book/${encodeURIComponent(bId)}/chapters/${encodeURIComponent(chosenChapter)}/scenes/${encodeURIComponent(values.sceneId ?? '')}/units`, {
          id: structurePreviewId,
        });
        position = { chapterId: chosenChapter, sceneId: values.sceneId ?? '', unitId: res.unit_id, unitIndex: res.unit_index };
      }
      setStructureAddKind(null);
      const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
      setBookData(fresh);
      if (position) {
        navigateTo({
          chapterId: position.chapterId || null,
          sceneId: position.sceneId || null,
          unitId: position.unitId || null,
          chunkId: null,
          unitIndex: position.unitIndex,
        });
      }
    } catch (e) {
      setEntityError((e as Error).message);
    } finally {
      setEntityBusy(false);
    }
  }, [structurePreviewId, bookData]);

  const confirmDeleteStructure = useCallback(async () => {
    const target = structureDelete;
    const bId = bookIdSignal.value;
    if (!target || !bId) return;
    setEntityBusy(true);
    setEntityError(null);
    try {
      const scId = target.sceneId ?? '';
      const path = target.kind === 'chapter'
        ? `/book/${encodeURIComponent(bId)}/chapters/${encodeURIComponent(target.id)}`
        : target.kind === 'scene'
          ? `/book/${encodeURIComponent(bId)}/chapters/${encodeURIComponent(target.chapterId)}/scenes/${encodeURIComponent(target.id)}`
          : `/book/${encodeURIComponent(bId)}/chapters/${encodeURIComponent(target.chapterId)}/scenes/${encodeURIComponent(scId)}/units/${encodeURIComponent(target.id)}`;
      await deleteJson(path);
      setStructureDelete(null);
      const fresh = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
      setBookData(fresh);
      // Re-anchor the position to a valid chapter+scene+unit. The current
      // chapter/scene are kept when they still exist (the scene index clamps to
      // a neighbour); the deleted element shifts indexes down. When the current
      // chapter was deleted, fall back to the first remaining chapter.
      const chs = fresh.chapters ?? [];
      if (chs.length > 0) {
        const curChId = positionSignal.value.chapterId;
        let chIdx = chs.findIndex((c) => c.chapter_id === curChId);
        if (chIdx < 0) chIdx = 0;
        const ch = chs[chIdx];
        const curScId = positionSignal.value.sceneId;
        let scIdx = (ch.scenes ?? []).findIndex((s) => s.scene_id === curScId);
        if (scIdx < 0) scIdx = 0;
        const sc = ch.scenes?.[scIdx];
        const units = sc?.units ?? [];
        const unitIndex = Math.max(0, Math.min(positionSignal.value.unitIndex, units.length - 1));
        navigateTo({
          chapterId: ch.chapter_id ?? null,
          sceneId: sc?.scene_id ?? null,
          unitId: units[unitIndex]?.id ?? null,
          chunkId: null,
          unitIndex,
        });
      }
    } catch (e) {
      setEntityError((e as Error).message);
    } finally {
      setEntityBusy(false);
    }
  }, [structureDelete]);

  const isEntityTab = tab === CHARS_TAB || tab === VOICES_TAB || tab === LOCATIONS_TAB;
  const isStructureTab = tab === CHAPTER_TAB || tab === SCENE_TAB || tab === UNITS_TAB;
  const currentEntityKind: EntityKind = tab === CHARS_TAB ? 'character' : tab === LOCATIONS_TAB ? 'location' : 'voice';

  // ── Content builders ──

  const sectionLabel = (text: string): JSX.Element => <div class="edit-section">{text}</div>;

  const inputCard = (label: string, value: string, multiline: boolean, storeKey: string, maxLength?: number): JSX.Element => {
    if (!(storeKey in fieldValues.current)) fieldValues.current[storeKey] = value;
    const currentLen = (fieldValues.current[storeKey] ?? '').length;
    // Values containing line breaks MUST use a multiline textarea — a single-line
    // <input type="text"> strips "\n" on render ("С.А. Хабаров\n\nЗа пределами
    // алгоритмов" glues into "ХабаровЗа…"), and an edit would save the stripped
    // value back, destroying TTS paragraph breaks. Length alone (the old
    // heuristic) missed short multiline texts like book covers.
    // Desktop prompt editors (image.prompt / video.action, plan §5.4) are ALWAYS
    // multiline textareas — dedicated working fields, not ordinary input cards.
    // Only the desktop shell promotes the frame prompts to dedicated editors;
    // mobile keeps the original single/multiline heuristic untouched.
    const isPromptEditor = isDesktop && (storeKey === 'image.prompt' || storeKey === 'video.action');
    const useTextarea = isPromptEditor || multiline || (fieldValues.current[storeKey] ?? '').includes('\n');
    return (
      <div class={'edit-field' + (isPromptEditor ? ' edit-field--prompt' : '')} key={storeKey}>
        <label class="edit-field__label">{label}</label>
        {useTextarea ? (
          <textarea
            class="edit-field__input edit-field__input--area"
            rows={isPromptEditor ? 8 : 4}
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

  // Chapter tab — a dedicated chapter-level component. Currently shows the
  // chapter id + title; future chapter-level data (passport overrides, other
  // chapter parameters) belongs here, NOT in the Scene tab.
  const buildChapterFields = (ch: BookChapter | undefined): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const chId = ch?.chapter_id;
    if (chId) {
      out.push(
        <div class="edit-card__head" key="chapter-head">
          <EntityDeleteButton onClick={() => { setEntityError(null); setStructureDelete({ kind: 'chapter', chapterId: chId, sceneId: null, id: chId }); }} />
          <span class="edit-card__title">{chId}</span>
        </div>
      );
    }
    out.push(sectionLabel(t('edit_section_chapter_general')));
    out.push(readonlyField('chapter_id', ch?.chapter_id ?? '—'));
    out.push(inputCard(fieldLabel('chapter_title'), ch?.chapter_title ?? '', false, 'chapter_title'));
    return out;
  };

  const buildSceneFields = (sc: BookScene): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const scId = sc.scene_id;
    const chId = chapters[currentChIndex]?.chapter_id;
    if (scId && chId) {
      out.push(
        <div class="edit-card__head" key="scene-head">
          <EntityDeleteButton onClick={() => { setEntityError(null); setStructureDelete({ kind: 'scene', chapterId: chId, sceneId: scId, id: scId }); }} />
          <span class="edit-card__title">{scId}</span>
        </div>
      );
    }
    out.push(sectionLabel(t('edit_section_scene_general')));
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
        <span class="edit-section__label">
          <span class="edit-section__delete">
            <EntityDeleteButton onClick={() => {
              setEntityError(null);
              const chId = chapters[currentChIndex]?.chapter_id;
              const scId = currentScene()?.scene_id;
              if (chId && scId && u.id) setStructureDelete({ kind: 'unit', chapterId: chId, sceneId: scId, id: u.id });
            }} />
          </span>
          {tf('edit_unit_label', idx + 1, units.length)}
        </span>
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
          {/* Delete on the LEFT so the floating "+" (top-right corner of the
              table) never sits on top of the first row's delete button. */}
          <div class="edit-card__head">
            <EntityDeleteButton onClick={() => { setEntityError(null); setDeleteTarget({ kind: 'character', id: charId }); }} />
            <span class="edit-card__title">{charId || '—'}</span>
          </div>
          {inputCard(t('field_name'), ch.name ?? '', false, `char.${charId}.name`)}
          <div class="edit-section">{t('field_passport')}</div>
          {PASSPORT_OVERRIDE_FIELDS.map((f) => {
            const v = passportFieldText(ch.passport as CharPassport | null, f);
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
        <div class="edit-card__head">
          <EntityDeleteButton onClick={() => { setEntityError(null); setDeleteTarget({ kind: 'voice', id: voiceId }); }} />
          <span class="edit-card__title">{voiceId}</span>
        </div>
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
          <div class="edit-card__head">
            <EntityDeleteButton onClick={() => { setEntityError(null); setDeleteTarget({ kind: 'location', id: locId }); }} />
            <span class="edit-card__title">{locId}</span>
          </div>
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
    if (tab === CHAPTER_TAB) return <>{buildChapterFields(chapters[currentChIndex])}</>;
    if (tab === CHARS_TAB) return <>{buildCharactersFields()}</>;
    if (tab === VOICES_TAB) return <>{buildVoicesFields()}</>;
    if (tab === LOCATIONS_TAB) return <>{buildLocationsFields()}</>;
    if (tab === GLOBAL_TAB) return <>{buildGlobalFields()}</>;
    const sc = currentScene();
    if (!sc) return <div class="edit-empty-inline" />;
    if (tab === SCENE_TAB) return <>{buildSceneFields(sc)}</>;
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

  // Draft-protection modal: Escape cancels the pending navigation (plan §11 —
  // Escape closes the top-most dismissible surface) + locks body scroll.
  useEffect(() => {
    if (pendingNav === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPendingNav(null); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [pendingNav]);

  // Draft-recover modal: Escape dismisses the snapshot (draft stays lost, the
  // user explicitly gave it up) + locks body scroll.
  useEffect(() => {
    if (!draftRecoverOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') discardDraft(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [draftRecoverOpen, discardDraft]);

  return (
    <section class="page edit-page">
      {/* Desktop editor header (plan §5.1/§5.2) — breadcrumb, unit ordinal,
          previous/next, save state and a persistent Save action. Mobile keeps
          the Android position bar; the header is desktop-only. */}
      {isDesktop && (
        <div class="edit-header">
          <span class="edit-header__pos" title={posLabel}>{posLabel}</span>
          {hasUnits && <span class="edit-header__units">{unitCountText}</span>}
          <span class="edit-header__nav">
            <button
              type="button"
              class="edit-header__nav-btn"
              aria-label={t('edit_previous_unit')}
              disabled={!carousel.prev}
              onClick={() => requestUnitNavigation(-1)}
            >
              <IconChevronLeft width={18} height={18} />
            </button>
            <button
              type="button"
              class="edit-header__nav-btn"
              aria-label={t('edit_next_unit')}
              disabled={!carousel.next}
              onClick={() => requestUnitNavigation(1)}
            >
              <IconChevronRight width={18} height={18} />
            </button>
          </span>
          <span
            class={'edit-header__state' + (saveBusy ? ' edit-header__state--busy' : saveDirty ? ' edit-header__state--dirty' : ' edit-header__state--saved')}
            aria-live="polite"
          >
            {saveBusy ? t('edit_saving') : saveDirty ? t('edit_unsaved_changes') : t('edit_saved')}
          </span>
          <button
            type="button"
            class="edit-header__save"
            disabled={saveBusy}
            onClick={() => void saveToBackend()}
          >
            <IconSave width={16} height={16} />
            {saveText}
          </button>
        </div>
      )}

      {/* Position bar — tappable → Navigate (mobile). On desktop the Navigator
          is already a persistent right panel, so the bar is an informational
          breadcrumb and must not route away and empty the workspace. */}
      <button class="gen-posbar edit-posbar" type="button" onClick={() => { if (!isDesktop) navigate('/navigate'); }}>
        <span class="gen-posbar__label">{posLabel}</span>
        {hasUnits && <span class="gen-posbar__units">{unitCountText}</span>}
      </button>

      {/* Desktop editor columns: the preview column (carousel + timeline) and
          the inspector column (tabs + fields) each fill the workspace height
          on desktop (grid rows minmax(0,1fr)), so neither starves the other.
          On mobile the wrappers are display:contents, keeping the flat 1:1
          Android composition (the children stay direct flex children of
          .edit-page). */}
      <div class="edit-preview">

      {/* Unit carousel — collapsible panel (web deviation: frees vertical
          space for the editor). Expanded = original carousel + a small
          collapse chevron floating in its top-right corner (zero extra
          height). Collapsed = thin title strip that re-expands on tap.
          The carousel stays mounted (hidden via CSS) so image sizes restore
          exactly; current card opens the full-size image. */}
      <div class={'edit-panel edit-panel--carousel' + (carouselCollapsed ? ' edit-panel--collapsed' : '')}>
        <button class="edit-panel__strip" type="button" aria-expanded={!carouselCollapsed} onClick={() => setCarouselCollapsed(false)}>
          <span class="edit-panel__title">{t('edit_carousel_title')}</span>
          <span class="edit-panel__chev" aria-hidden="true"><IconChevronDown width={18} height={18} /></span>
        </button>
        <button class="edit-panel__collapse" type="button" aria-label={t('edit_collapse')} onClick={() => setCarouselCollapsed(true)}>
          <IconChevronUp width={16} height={16} />
        </button>
        {isDesktop ? (
          /* Desktop preview stage + unit rail (plan §5.3): a bounded canvas for
             the current unit (click → full-size zoom) and a horizontally
             scrollable rail of the current scene's units; selecting a rail
             thumb jumps through the shared position with draft protection. */
          <DesktopUnitStage
            bid={bid}
            bld={bld}
            chapterId={chapters[currentChIndex]?.chapter_id ?? null}
            sceneId={currentScene()?.scene_id ?? null}
            units={currentScene()?.units ?? []}
            currentIndex={positionSignal.value.unitIndex}
            onZoom={() => openZoom(carousel.current)}
            onJump={requestUnitJump}
          />
        ) : (
          <div class="edit-carousel">
            <CarouselCard kind="prev" bid={bid} bld={bld} item={carousel.prev} onClick={() => carousel.prev && requestUnitNavigation(-1)} />
            <CarouselCard kind="current" bid={bid} bld={bld} item={carousel.current} onClick={() => openZoom(carousel.current)} />
            <CarouselCard kind="next" bid={bid} bld={bld} item={carousel.next} onClick={() => carousel.next && requestUnitNavigation(1)} />
          </div>
        )}
      </div>

      {/* Audio timeline panel — collapsible (same web deviation). Collapsing
          stops playback so audio never plays without the visible waveform. */}
      {timelineVisible && (
        <div class={'edit-panel edit-panel--timeline' + (timelineCollapsed ? ' edit-panel--collapsed' : '')}>
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
      </div>

      <div class="edit-inspector">
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

      {/* Content area — entity tables (characters/voices/locations) AND the
          structure tabs (chapter/scene/unit) get the floating "+" overlay in the
          top-right corner (zero layout space). */}
      <div class="edit-content">
        {loading ? <div class="progress"><div class="progress__bar" /></div> : (
          isEntityTab || isStructureTab ? (
            <div class="edit-entity-table">
              <EntityAddButton onClick={() => {
                setEntityError(null);
                if (isStructureTab) openStructureAdd(tab === CHAPTER_TAB ? 'chapter' : tab === SCENE_TAB ? 'scene' : 'unit');
                else setEntityAddKind(currentEntityKind);
              }} />
              {renderContent()}
            </div>
          ) : renderContent()
        )}
      </div>
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

      {/* Desktop draft-recover modal (plan §5.2): the position changed from
          outside the editor while a draft was dirty; the draft is snapshotted
          and offered back instead of being silently dropped. */}
      {draftRecoverOpen && draftSnapshot.current !== null && (
        <div class="modal-backdrop" role="presentation" onClick={discardDraft}>
          <div class="modal" role="dialog" aria-modal="true" aria-label={t('edit_draft_recover_title')} onClick={(e) => e.stopPropagation()}>
            <div class="modal__title">{t('edit_draft_recover_title')}</div>
            <div class="modal__body">
              <p class="modal__notice">{t('edit_draft_recover_desc')}</p>
            </div>
            <div class="modal__footer">
              <button type="button" class="btn btn--outlined" autofocus onClick={discardDraft}>{t('edit_draft_recover_discard')}</button>
              <button type="button" class="btn" onClick={restoreDraft}>{t('edit_draft_recover_back')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Entity add dialog (Characters / Locations / Voices tables) — schema-
          driven reusable form; save closes it and refreshes the table. */}
      {entityAddKind && (
        <EntityEditorDialog
          schema={ENTITY_SCHEMAS[entityAddKind]}
          existingIds={entityExistingIds}
          busy={entityBusy}
          error={entityError}
          onSave={(values) => void saveEntity(entityAddKind, values)}
          onClose={() => { if (!entityBusy) { setEntityAddKind(null); setEntityError(null); } }}
        />
      )}

      {/* Entity delete confirmation — destructive actions never fire without
          explicit confirmation; the text is per-entity (character/location/voice). */}
      {deleteTarget && (
        <DeleteConfirmDialog
          title={t(ENTITY_SCHEMAS[deleteTarget.kind].deleteTitleKey)}
          message={t(ENTITY_SCHEMAS[deleteTarget.kind].deleteConfirmKey)}
          busy={entityBusy}
          error={entityError}
          onConfirm={() => void confirmDeleteEntity()}
          onClose={() => { if (!entityBusy) { setDeleteTarget(null); setEntityError(null); } }}
        />
      )}

      {/* Structure add dialog (chapters / scenes / units) — readonly id preview
          + optional parent dropdown (scene→chapter, unit→scene, pre-filled with
          the current selection) + title. The parent is the explicit user choice;
          the server anchors the insert point. */}
      {structureAddKind && (
        <StructureAddDialog
          kind={structureAddKind}
          id={structurePreviewId}
          chapters={structureChapters}
          scenes={structureScenes}
          defaultChapterId={positionSignal.value.chapterId}
          defaultSceneId={positionSignal.value.sceneId}
          busy={entityBusy}
          error={entityError}
          onSave={(values) => void saveStructure(structureAddKind, values)}
          onClose={() => { if (!entityBusy) { setStructureAddKind(null); setEntityError(null); } }}
        />
      )}

      {/* Structure delete confirmation — chapter/scene/unit (destructive). */}
      {structureDelete && (
        <DeleteConfirmDialog
          title={t(structureDelete.kind === 'chapter' ? 'structure_delete_chapter' : structureDelete.kind === 'scene' ? 'structure_delete_scene' : 'structure_delete_unit')}
          message={t(structureDelete.kind === 'chapter' ? 'structure_delete_chapter_confirm' : structureDelete.kind === 'scene' ? 'structure_delete_scene_confirm' : 'structure_delete_unit_confirm')}
          busy={entityBusy}
          error={entityError}
          onConfirm={() => void confirmDeleteStructure()}
          onClose={() => { if (!entityBusy) { setStructureDelete(null); setEntityError(null); } }}
        />
      )}

      {/* Desktop draft protection modal (plan §5.2): an unsaved draft must
          never be silently lost on unit navigation. Save → continue on
          success; Discard → navigate and drop the draft; Cancel → stay. */}
      {pendingNav !== null && (
        <div class="modal-backdrop" role="presentation" onClick={() => setPendingNav(null)}>
          <div class="modal" role="dialog" aria-modal="true" aria-label={t('edit_confirm_title')} onClick={(e) => e.stopPropagation()}>
            <div class="modal__title">{t('edit_confirm_title')}</div>
            <div class="modal__body">
              <p class="modal__notice">{t('edit_confirm_desc')}</p>
            </div>
            <div class="modal__footer">
              {/* autofocus lands on the safe action; plan §11 — initial meaningful focus */}
              <button type="button" class="btn btn--outlined" autofocus onClick={() => setPendingNav(null)}>{t('dialog_cancel')}</button>
              <button
                type="button"
                class="btn btn--outlined"
                onClick={() => { const act = pendingNav; setPendingNav(null); act(); }}
              >{t('edit_discard')}</button>
              <button
                type="button"
                class="btn"
                disabled={saveBusy}
                onClick={() => {
                  const act = pendingNav;
                  void saveToBackend().then((ok) => { if (ok) { setPendingNav(null); act(); } });
                }}
              >{t('edit_save_and_go')}</button>
            </div>
          </div>
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
  return (
    <>
      <img
        class="edit-unit-card__img"
        src={previewUrl(bid, bld, chapterId, sceneId, unitId)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {isCurrent && label && <span class="edit-unit-card__label">{label}</span>}
    </>
  );
}

// Shared preview URL (GET /preview/...?build_id=) — the same endpoint the
// mobile carousel uses; desktop stage and rail reuse it unchanged.
function previewUrl(bid: string, bld: string, chapterId: string, sceneId: string, unitId: string): string {
  return `/api/v1/preview/${encodeURIComponent(bid)}/${encodeURIComponent(chapterId)}/${encodeURIComponent(sceneId)}/${encodeURIComponent(unitId)}?build_id=${encodeURIComponent(bld)}`;
}

// ── Desktop preview stage + unit rail (plan §5.3) ──
// Large bounded canvas for the current unit (click → existing full-size zoom)
// above a horizontally scrollable rail of the current scene's units. Clicking a
// rail thumb jumps through the shared position (draft-protected); the active
// thumb is highlighted with the existing accent/container language.
function DesktopUnitStage({ bid, bld, chapterId, sceneId, units, currentIndex, onZoom, onJump }: {
  bid: string;
  bld: string;
  chapterId: string | null;
  sceneId: string | null;
  units: BookUnit[];
  currentIndex: number;
  onZoom: () => void;
  onJump: (index: number) => void;
}) {
  const idx = Math.max(0, Math.min(currentIndex, units.length - 1));
  const current = units[idx];
  const label = current ? `${t('navigate_unit')} ${idx + 1}` : null;
  // Keep the active thumb in view as the unit changes via keyboard/header
  // arrows (plan §5.3: "keep the active item in view without stealing focus").
  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const active = rail.querySelector('[data-active="true"]');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [idx]);

  return (
    <div class="edit-stage">
      <div class="edit-stage__canvas">
        {chapterId && sceneId && current ? (
          <StagePreview
            bid={bid}
            bld={bld}
            chapterId={chapterId}
            sceneId={sceneId}
            unitId={unitId(current, idx)}
            onClick={onZoom}
            label={label}
          />
        ) : (
          <div class="edit-stage__missing"><IconImageOff width={32} height={32} /></div>
        )}
      </div>
      <div class="edit-stage__rail" ref={railRef} role="group" aria-label={t('edit_rail_title')}>
        {units.length === 0 ? (
          <span class="edit-stage__empty">{t('edit_rail_empty')}</span>
        ) : units.map((u, i) => {
          const active = i === idx;
          return (
            <button
              type="button"
              key={u.id ?? `iu${String(i).padStart(4, '0')}`}
              class={'edit-stage__thumb' + (active ? ' edit-stage__thumb--active' : '')}
              data-active={active ? 'true' : undefined}
              aria-current={active ? 'true' : undefined}
              aria-label={`${t('navigate_unit')} ${i + 1}`}
              onClick={() => onJump(i)}
            >
              {chapterId && sceneId ? (
                <RailThumb bid={bid} bld={bld} chapterId={chapterId} sceneId={sceneId} unitId={unitId(u, i)} />
              ) : (
                <span class="edit-stage__thumb-missing"><IconImageOff width={16} height={16} /></span>
              )}
              <span class="edit-stage__thumb-label">{i + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Large current-unit preview: stable bounded canvas (object-fit: contain),
// click opens the existing full-size zoom, missing state falls back to the
// image-off icon — the rail and mobile carousel keep their own rendering.
function StagePreview({ bid, bld, chapterId, sceneId, unitId, onClick, label }: {
  bid: string;
  bld: string;
  chapterId: string;
  sceneId: string;
  unitId: string;
  onClick: () => void;
  label: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [unitId]);

  return (
    <button type="button" class="edit-stage__zoom" aria-label={t('edit_zoom_preview')} title={t('edit_zoom_preview')} onClick={onClick}>
      {failed ? (
        <span class="edit-stage__missing"><IconImageOff width={32} height={32} /></span>
      ) : (
        <img
          class="edit-stage__img"
          src={previewUrl(bid, bld, chapterId, sceneId, unitId)}
          alt={label ?? ''}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      <span class="edit-stage__zoom-hint" aria-hidden="true"><IconFullscreen width={18} height={18} /></span>
    </button>
  );
}

// Compact rail thumb — same preview endpoint, fixed square crop.
function RailThumb({ bid, bld, chapterId, sceneId, unitId }: {
  bid: string;
  bld: string;
  chapterId: string;
  sceneId: string;
  unitId: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [unitId]);

  if (failed) {
    return <span class="edit-stage__thumb-missing"><IconImageOff width={16} height={16} /></span>;
  }
  return (
    <img
      class="edit-stage__thumb-img"
      src={previewUrl(bid, bld, chapterId, sceneId, unitId)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BookChapter, BookData, BookScene, BookUnit } from '../api/models';
import { unitIndex } from '../api/models';
import type {
  ActivePosition, NavigatorIconProps, NavigatorPorts, NavigatorT,
} from '../modules/navigator/ports';

// NavigatePage — 1:1 with NavigateFragment + fragment_navigate.xml (stage 5).
//  - Position bar (include_position_bar) — label from bookData + ActivePosition.
//  - LinearProgressIndicator while the book loads; empty state when no book.
//  - Structure tree: chapters (bold accent, indent 8) → scenes (surfaceVariant,
//    indent 24, expandedScenes set) → units (13sp, [type] tag, 44dp preview
//    thumbnail, active = accent + secondaryContainer).
//  - Chapter tap toggles collapse (web fixes the Android chapter-toggle lost on
//    rebuild — see 06 §14); scene tap toggles expandedScenes; unit tap →
//    PositionPort.navigateTo + SeekPort.seekToPosition + (mobile) /play.
//  - Auto-expand the current position's scene (expandedScenes follows position).
//  - Reload structure on playbackPrepared (generation completion).
//
// Host boundary (docs/architecture/navigator-module-extraction-audit.md):
// the page consumes ONLY the injected NavigatorPorts — never the host stores
// (playbackStore / generateStore / positionStore / resourceInvalidations /
// resilientReloader), api/client, app/i18n, app/icons, app/router, app/desktop
// or AppShell. The host wires the real implementations in app/navigatorAdapters.ts.

export type NavItem =
  | { kind: 'chapter'; id: string; label: string; expanded: boolean; chapterId?: string | null }
  | {
      kind: 'scene'; id: string; label: string; expanded: boolean;
      chapterId?: string | null; sceneId?: string | null;
    }
  | {
      kind: 'unit'; id: string; label: string; type?: string | null;
      isActive: boolean; chapterId: string | null; sceneId: string | null;
      unitId: string; index: number;
    };

// Chapter label — 1:1 with NavigateFragment.rebuildStructure chLabel rules.
export function chapterLabel(ch: BookChapter, chIdx: number, t: NavigatorT): string {
  const chTitle = ch.chapter_title?.slice(0, 60).replace(/\n/g, ' ')?.trim();
  const isSpecial = ch.is_special === true;
  if (isSpecial) {
    switch ((ch.type ?? '').toLowerCase()) {
      case 'cover': return t('navigate_cover');
      case 'prologue': return t('navigate_prologue');
      default: return chTitle ?? (ch.type ? ch.type.charAt(0).toUpperCase() + ch.type.slice(1) : '');
    }
  }
  if (ch.display_number != null) {
    const prefix = `${t('navigate_chapter')} ${ch.display_number}`;
    if (chTitle && !/^\p{L}+\s+\d+$/u.test(chTitle)) {
      // Android: keep the title only if it already contains a digit, else "Chapter N — Title"
      return /\d/.test(chTitle) ? chTitle : `${prefix} — ${chTitle}`;
    }
    return prefix;
  }
  if (chTitle) return chTitle;
  return `${t('navigate_chapter')} ${chIdx + 1}`;
}

export function sceneLabel(sc: BookScene, scIdx: number, t: NavigatorT): string {
  const scTitle = sc.scene_title?.slice(0, 60).replace(/\n/g, ' ')?.trim();
  const scNum = sc.display_index ?? scIdx + 1;
  return scTitle
    ? `${t('navigate_scene')} ${scNum} — ${scTitle}`
    : `${t('navigate_scene')} ${scNum}`;
}

export function unitLabel(u: BookUnit, uIdx: number, t: NavigatorT): string {
  const textPreview = u.text?.replace(/\n/g, ' ')?.trim();
  return textPreview
    ? `${t('navigate_unit')} ${uIdx + 1} — ${textPreview}`
    : `${t('navigate_unit')} ${uIdx + 1}`;
}

// rebuildStructure — pure: chapters → scenes → units (Android parity).
export function buildStructure(
  data: BookData,
  pos: ActivePosition,
  scenes: Set<string>,
  chapterExp: Map<string, boolean>,
  t: NavigatorT,
): NavItem[] {
  const chapters = data.chapters ?? [];
  const out: NavItem[] = [];
  chapters.forEach((ch, chIdx) => {
    const chapterId = ch.chapter_id ?? null;
    const label = chapterLabel(ch, chIdx, t);
    // Default rule: current chapter or ≤3 chapters are expanded (Android parity).
    // The user override map wins over the default in both directions — 06 §14.
    const defaultExpanded = chapterId === pos.chapterId || chapters.length <= 3;
    const expanded = chapterId != null
      ? (chapterExp.get(chapterId) ?? defaultExpanded)
      : defaultExpanded;
    out.push({ kind: 'chapter', id: chapterId ?? `ch${chIdx}`, label, expanded, chapterId });
    if (!expanded) return;
    (ch.scenes ?? []).forEach((sc, scIdx) => {
      const scKey = chapterId != null && sc.scene_id != null ? `${chapterId}|${sc.scene_id}` : null;
      const scExpanded = scKey != null && scenes.has(scKey);
      const scType = sc.type;
      const scStyle = sc.style;
      // Android onBind: "… — type (style)" with style, else "… (type | scene)"
      const scText = scStyle != null
        ? `${sceneLabel(sc, scIdx, t)} — ${scType} (${scStyle})`
        : `${sceneLabel(sc, scIdx, t)} (${scType ?? t('navigate_scene_type')})`;
      out.push({
        kind: 'scene', id: sc.scene_id ?? `sc${scIdx}`, label: scText, expanded: scExpanded,
        chapterId, sceneId: sc.scene_id,
      });
      if (!scExpanded) return;
      (sc.units ?? []).forEach((u, uIdx) => {
        const isActive = chapterId === pos.chapterId && sc.scene_id === pos.sceneId && uIdx === pos.unitIndex;
        out.push({
          kind: 'unit',
          id: u.id ?? `u${uIdx}`,
          label: unitLabel(u, uIdx, t),
          type: u.type,
          isActive,
          chapterId,
          sceneId: sc.scene_id ?? null,
          unitId: u.id ?? `iu${String(uIdx).padStart(4, '0')}`,
          index: uIdx,
        });
      });
    });
  });
  return out;
}

export function NavigatePage(props: { path?: string; ports: NavigatorPorts }) {
  const ports = props.ports;
  const { bookSource, position, seek, invalidations, reload, navigation, shellMode, http, i18n, icons } = ports;
  const positionSignal = position.position;
  // Desktop (plan §4.3): the Navigator is a persistent right panel, so unit
  // selection updates the shared position but must NOT force a mode switch to
  // /play — that would interrupt editing. Mobile keeps the Android 1:1
  // switchToPlayTab() behaviour.
  const isDesktop = shellMode.isDesktop();
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [loading, setLoading] = useState(false);
  // Start with the current position's scene already expanded — avoids the
  // one-frame flash of a collapsed current scene before the auto-expand effect
  // runs (Android builds expandedScenes synchronously in rebuildStructure).
  const [expandedScenes, setExpandedScenes] = useState<Set<string>>(() => {
    const p = positionSignal.value;
    return p.chapterId && p.sceneId ? new Set([`${p.chapterId}|${p.sceneId}`]) : new Set();
  });
  // Chapter expansion: user override map (chapterId → explicitly expanded/collapsed).
  // Entries absent from the map follow the default rule below. A collapsed-only set
  // could never expand a default-collapsed chapter in a book with >3 chapters — the
  // same no-op toggle bug Android has (06 §14). The map fixes both directions.
  const [chapterExpanded, setChapterExpanded] = useState<Map<string, boolean>>(new Map());
  const [items, setItems] = useState<NavItem[]>([]);
  const [posLabel, setPosLabel] = useState(i18n.t('navigate_no_position'));
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  // Lazy-init so the auto-expand effect treats the mount position as already seen.
  const lastPositionKey = useRef<string | null>(null);
  if (lastPositionKey.current === null) {
    const p = positionSignal.value;
    lastPositionKey.current = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}` : null;
  }

  const bid = bookSource.bookId.value;
  const bld = bookSource.buildId.value;

  // ── Load book (loadBook with isLoading guard like NavigateFragment) ──
  const loadBook = useCallback(async () => {
    const bId = bookSource.bookId.value;
    if (!bId) {
      setBookData(null);
      setLoading(false);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const result = await reload.resilientReload({
      recovery: reload.sharedRecovery(),
      attempt: () => http.getJson<BookData>(`/book/${encodeURIComponent(bId)}`),
    });
    if (result.kind === 'success') setBookData(result.value);
    loadingRef.current = false;
    setLoading(false);
  }, [bookSource, reload, http]);

  useEffect(() => {
    void loadBook();
    // observeGenerationCompletion — reload structure when generation finishes
    return bookSource.onPlaybackPrepared((prep) => {
      if (bookSource.bookId.value && bookSource.bookId.value === prep.bookId) void loadBook();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, loadBook]);

  // ── Invalidation pipeline (view layer — NavigateFragment parity): the book
  // JSON changed outside this screen (AI Assistant patch, another device) —
  // re-read the structure so the tree shows new/renamed chapters, scenes and
  // units without a manual reload. Matters on desktop where this panel stays
  // mounted; on mobile the remount fetches fresh data anyway.
  useEffect(() => {
    return invalidations.onResourceInvalidated((e) => {
      const currentBook = bookSource.bookId.value;
      if (e.kind !== 'EXTERNAL') return;
      if (!currentBook || e.resource !== invalidations.bookResource(currentBook)) return;
      void loadBook();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, loadBook]);

  // ── Auto-expand only the current position's scene, collapse others (NavigateFragment) ──
  useEffect(() => {
    const p = positionSignal.value;
    const posKey = p.chapterId && p.sceneId ? `${p.chapterId}|${p.sceneId}` : null;
    if (posKey != null && posKey !== lastPositionKey.current) {
      lastPositionKey.current = posKey;
      setExpandedScenes(new Set([posKey]));
    }
  }, [positionSignal.value]);

  // ── Build the structure items (rebuildStructure) ──
  useEffect(() => {
    if (!bookData) { setItems([]); return; }
    setItems(buildStructure(bookData, positionSignal.value, expandedScenes, chapterExpanded, i18n.t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookData, positionSignal.value, expandedScenes, chapterExpanded, i18n.t]);

  // ── Position bar label (updatePositionBar) ──
  useEffect(() => {
    const p = positionSignal.value;
    if (!p.chapterId || !bookData) { setPosLabel(i18n.t('navigate_no_position')); return; }
    const ch = bookData.chapters?.find((c) => c.chapter_id === p.chapterId);
    const sc = ch?.scenes?.find((s) => s.scene_id === p.sceneId);
    const isSpecial = ch?.is_special === true;
    const scIdx = sc?.display_index ?? 0;
    const uIdx = unitIndex(bookData, p.chapterId, p.sceneId, p.unitIndex);
    const chTitle = ch?.chapter_title?.trim();
    const scTitle = sc?.scene_title?.trim();
    let chLabel = '';
    if (isSpecial) {
      const type = (ch?.type ?? '').toLowerCase();
      chLabel = type === 'cover' ? i18n.t('navigate_cover')
        : type === 'prologue' ? i18n.t('navigate_prologue')
        : chTitle ?? (ch?.type ? ch.type.charAt(0).toUpperCase() + ch.type.slice(1) : '');
    } else if (ch?.display_number != null) {
      const prefix = `${i18n.t('navigate_chapter')} ${ch.display_number}`;
      if (chTitle && !/^\p{L}+\s+\d+$/u.test(chTitle)) {
        chLabel = /\d/.test(chTitle) ? chTitle : `${prefix} — ${chTitle}`;
      } else {
        chLabel = prefix;
      }
    } else if (chTitle) {
      chLabel = chTitle;
    }
    if (!chLabel) { setPosLabel(''); return; }
    const scLabel = scIdx > 0 ? `${i18n.t('navigate_scene')} ${scIdx}` : '';
    const unitText = uIdx > 0 ? `${i18n.t('navigate_unit')} ${uIdx}` : '';
    // Android computes the same final label in every branch (chTitle folds into
    // chLabel; only scTitle changes the separator) — collapse to one expression.
    const full = scTitle
      ? `${chLabel} / ${scLabel} — ${scTitle} / ${unitText}`
      : `${chLabel} / ${scLabel} / ${unitText}`;
    setPosLabel(full);
  }, [positionSignal.value, bookData, i18n.t]);

  // ── Scroll to the active unit after rebuild (scrollToActivePosition) ──
  useEffect(() => {
    if (items.length === 0) return;
    const el = listRef.current?.querySelector('[data-nav-active="true"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [items]);

  // ── Item interactions ──
  const selectUnit = useCallback((item: Extract<NavItem, { kind: 'unit' }>) => {
    // 1:1 with NavigateFragment unit click — seek only when the scene is real
    position.navigateTo({ chapterId: item.chapterId, sceneId: item.sceneId, unitId: item.unitId, unitIndex: item.index });
    if (item.chapterId != null && item.sceneId != null) {
      void seek.seekToPosition(item.chapterId, item.sceneId, item.index, item.unitId);
    }
  }, [position, seek]);

  // Explicit "open in Player" (plan §4.3): select the unit, then switch the
  // workspace to Player. Desktop single-click only selects; double-click or the
  // play button on the active row are the explicit playback actions.
  const openInPlayer = useCallback((item: Extract<NavItem, { kind: 'unit' }>) => {
    selectUnit(item);
    navigation.navigateToPlay();
  }, [selectUnit, navigation]);

  const onItemClick = (item: NavItem) => {
    if (item.kind === 'chapter') {
      const id = item.chapterId;
      if (id == null) return;
      setChapterExpanded((prev) => {
        const next = new Map(prev);
        const currentlyExpanded = next.get(id)
          ?? (id === positionSignal.value.chapterId || (bookData?.chapters?.length ?? 0) <= 3);
        next.set(id, !currentlyExpanded);
        return next;
      });
      // Chapter tap only expands/collapses the chapter — its scenes stay
      // collapsed (only the current-position scene stays expanded); unit
      // buttons appear after tapping a scene (1:1 with NavigateFragment).
    } else if (item.kind === 'scene') {
      const key = item.chapterId != null && item.sceneId != null ? `${item.chapterId}|${item.sceneId}` : null;
      if (key == null) return;
      setExpandedScenes((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    } else if (item.kind === 'unit') {
      selectUnit(item);
      if (!isDesktop) navigation.navigateToPlay(); // switchToPlayTab()
    }
  };

  const renderItem = (item: NavItem): JSX.Element => {
    if (item.kind === 'chapter') {
      return (
        <button key={item.id} type="button" class="nav-item nav-item--chapter" onClick={() => onItemClick(item)}>
          <span class="nav-item__text">{item.label}</span>
        </button>
      );
    }
    if (item.kind === 'scene') {
      return (
        <button key={item.id} type="button" class="nav-item nav-item--scene" onClick={() => onItemClick(item)}>
          <span class="nav-item__text">{item.label}</span>
        </button>
      );
    }
    return (
      // Row wrapper hosts the explicit desktop "open in Player" action next to
      // the select button (a nested button inside a button would be invalid).
      <div key={item.id} class="nav-unit-row">
        <button
          type="button"
          data-nav-active={item.isActive ? 'true' : undefined}
          class={'nav-item nav-item--unit' + (item.isActive ? ' nav-item--unit-active' : '')}
          onClick={() => onItemClick(item)}
          onDblClick={() => { if (isDesktop) openInPlayer(item); }}
        >
          <UnitThumb
            mediaUrl={http.mediaUrl}
            imageOff={icons.ImageOff}
            bookId={bid}
            buildId={bld}
            chapterId={item.chapterId}
            sceneId={item.sceneId}
            unitId={item.unitId}
          />
          <span class="nav-item__text">
            {item.type != null ? `[${item.type}] ` : ''}{item.label}
          </span>
        </button>
        {isDesktop && item.isActive && (
          <button
            type="button"
            class="nav-unit-row__play"
            aria-label={i18n.t('navigate_open_in_player')}
            title={i18n.t('navigate_open_in_player')}
            onClick={() => openInPlayer(item)}
          >
            <icons.Play width={16} height={16} />
          </button>
        )}
      </div>
    );
  };

  return (
    <section class="page nav-page">
      {/* Position bar (include_position_bar) — static, label only (NavigateFragment
          never sets unitCount, so it stays hidden here) */}
      <div class="gen-posbar">
        <span class="gen-posbar__label">{posLabel}</span>
      </div>

      {/* Loading indicator (LinearProgressIndicator) */}
      {loading && <div class="progress nav-progress"><div class="progress__bar" /></div>}

      {/* Empty state */}
      {!bid && !loading && (
        <div class="nav-empty">{i18n.t('navigate_empty')}</div>
      )}
      {bid && !loading && items.length === 0 && (
        <div class="nav-empty">{i18n.t('navigate_empty')}</div>
      )}

      {/* Structure list (RecyclerView) */}
      <div class="nav-list" ref={listRef}>
        {items.map(renderItem)}
      </div>
    </section>
  );
}

// Unit preview thumbnail — 1:1 with loadUnitPreview: GET /preview/{book}/{ch}/{sc}/{iu}
// with build_id; fallback to the ic_image_off icon (tinted onSurfaceVariant).
// The media base stays host-owned (HttpPort.mediaUrl — preview grammar contract).
function UnitThumb({ mediaUrl, imageOff: ImageOff, bookId: bid, buildId: bld, chapterId, sceneId, unitId }: {
  mediaUrl: (path: string) => string;
  imageOff: (props: NavigatorIconProps) => JSX.Element;
  bookId: string; buildId: string; chapterId: string | null; sceneId: string | null; unitId: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!bid || !chapterId || !sceneId) return null;
  if (failed) {
    return (
      <span class="nav-item__thumb">
        <ImageOff width={22} height={22} />
      </span>
    );
  }
  const src = mediaUrl(`/preview/${encodeURIComponent(bid)}/${encodeURIComponent(chapterId)}/${encodeURIComponent(sceneId)}/${encodeURIComponent(unitId)}?build_id=${encodeURIComponent(bld)}`);
  return <img class="nav-item__thumb" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

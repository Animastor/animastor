// @vitest-environment happy-dom
// Navigator characterization tests (navigator-module-extraction-audit.md).
//
// They pin the CURRENT behavior of the Navigator surface through the
// NavigatorPorts contract with fake ports — no host store is imported:
//  - buildStructure tree semantics (labels, override map, default expansion,
//    active unit, fallback ids);
//  - special chapter labels (cover / prologue) and scene label grammar;
//  - expansion of the current position (mount + follow-position);
//  - desktop/mobile unit interaction fork (select-only vs select + /play);
//  - navigation to /play through NavigationPort;
//  - seek through SeekPort (args parity);
//  - reload-trigger triad (bookId change / playbackPrepared / EXTERNAL
//    invalidation) through the port fakes;
//  - preview thumbnail grammar through HttpPort.mediaUrl.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { NavigatePage, buildStructure } from '../src/NavigatePage';
import type { ActivePosition, NavigatorPorts } from '../src/ports';

// ── Fixtures ─────────────────────────────────────────────────────────────

const BOOK = {
  chapters: [
    {
      chapter_id: 'ch-1',
      chapter_title: 'The Beginning',
      display_number: 1,
      scenes: [
        {
          scene_id: 'sc-1a',
          scene_title: 'First Scene',
          display_index: 1,
          type: 'dialogue',
          units: [
            { id: 'iu-1', type: 'line', text: 'Hello world' },
            { id: 'iu-2', type: 'action', text: null },
          ],
        },
        { scene_id: 'sc-1b', scene_title: null, display_index: 2, type: 'narration', units: [{ id: 'iu-3', type: null, text: 'Narrative' }] },
      ],
    },
    {
      chapter_id: 'ch-2', chapter_title: 'Cover Book', is_special: true, type: 'cover', scenes: [],
    },
    {
      chapter_id: 'ch-3', chapter_title: 'Prologue Book', is_special: true, type: 'prologue', scenes: [],
    },
    {
      chapter_id: 'ch-4', chapter_title: null, display_number: null, scenes: [],
    },
  ],
};

const EN = {
  navigate_cover: 'Cover',
  navigate_prologue: 'Prologue',
  navigate_chapter: 'Chapter',
  navigate_scene: 'Scene',
  navigate_scene_type: 'scene',
  navigate_unit: 'Unit',
  navigate_no_position: 'No position selected',
  navigate_empty: 'No book loaded',
  navigate_open_in_player: 'Open in Player',
} as const;

const POSITION: ActivePosition = { chapterId: 'ch-1', sceneId: 'sc-1a', unitId: 'iu-1', chunkId: null, unitIndex: 0 };

// ── Fake ports (the whole boundary under test — no host stores involved) ──

function makePorts(opts: { book?: unknown; bookId?: string; isDesktop?: boolean } = {}) {
  const seekToPosition = vi.fn(() => Promise.resolve());
  const navigateToPlay = vi.fn();
  const navigationRoutes: string[] = [];
  const navigateTo = vi.fn();
  const onPlaybackPrepared = vi.fn((_fn: (p: { bookId: string; buildId: string }) => void) => () => {});
  const onResourceInvalidated = vi.fn((_fn: (e: { kind: 'EXTERNAL' | 'LOCAL'; resource: string }) => void) => () => {});
  const getJson = vi.fn(() => Promise.resolve(opts.book ?? BOOK));

  const ports: NavigatorPorts = {
    seek: { seekToPosition },
    bookSource: {
      bookId: signal(opts.bookId ?? 'b-1'),
      buildId: signal('bd-1'),
      onPlaybackPrepared: onPlaybackPrepared as NavigatorPorts['bookSource']['onPlaybackPrepared'],
    },
    position: {
      position: signal<ActivePosition>({ chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0 }),
      navigateTo,
    },
    invalidations: {
      onResourceInvalidated: onResourceInvalidated as NavigatorPorts['invalidations']['onResourceInvalidated'],
      bookResource: (id: string) => `book:${id}`,
    },
    reload: {
      resilientReload: ({ attempt }) => attempt().then((value) => ({ kind: 'success' as const, value })),
      sharedRecovery: () => ({ isOnline: true, onNextRestore: () => () => {} }),
    },
    shellMode: { isDesktop: () => opts.isDesktop ?? false },
    navigation: { navigateToPlay },
    http: {
      getJson: getJson as NavigatorPorts['http']['getJson'],
      mediaUrl: (path: string) => `/api/v1${path}`,
    },
    i18n: { t: ((key: keyof typeof EN) => EN[key]) as NavigatorPorts['i18n']['t'] },
    icons: {
      Play: () => <svg data-testid="icon-play" />,
      ImageOff: () => <svg data-testid="icon-image-off" />,
    },
  };
  return {
    ports,
    fakes: { seekToPosition, navigateToPlay, navigateTo, getJson, onPlaybackPrepared, onResourceInvalidated, navigationRoutes },
  };
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('buildStructure (pure characterization)', () => {
  const t = (k: keyof typeof EN) => EN[k];

  it('labels: "Chapter N — Title" rule, 1-based unit labels, text previews', () => {
    const items = buildStructure(BOOK, POSITION, new Set(['ch-1|sc-1a']), new Map(), t);
    expect(items[0]).toMatchObject({ kind: 'chapter', label: 'Chapter 1 — The Beginning' });
    expect(items[1]).toMatchObject({ kind: 'scene', label: 'Scene 1 — First Scene (dialogue)' });
    expect(items[2]).toMatchObject({ kind: 'unit', label: 'Unit 1 — Hello world' });
    expect(items[3]).toMatchObject({ kind: 'unit', label: 'Unit 2' });
  });

  it('chapter title containing a digit is kept verbatim (Android parity)', () => {
    const book = { chapters: [{ chapter_id: 'c', display_number: 2, chapter_title: 'The End 2', scenes: [] }] };
    expect(buildStructure(book, POSITION, new Set(), new Map(), t)[0].label).toBe('The End 2');
  });

  it('chapter without number/title falls back to "Chapter <idx+1>"', () => {
    expect(buildStructure(BOOK, POSITION, new Set(), new Map(), t)[5].label).toBe('Chapter 4');
  });

  it('unit fallback id is iu + zero-padded index when the unit has no id', () => {
    const book = { chapters: [{ chapter_id: 'c', scenes: [{ scene_id: 's', type: 't', units: [{ id: null }] }] }] };
    const items = buildStructure(book, POSITION, new Set(['c|s']), new Map(), t);
    expect(items[2]).toMatchObject({ kind: 'unit', unitId: 'iu0000' });
  });

  it('default expansion: >3 chapters → only the current chapter; ≤3 → all', () => {
    const big = buildStructure(BOOK, POSITION, new Set(), new Map(), t);
    expect(big.filter((i) => i.kind === 'chapter').map((i) => i.expanded)).toEqual([true, false, false, false]);

    const small = buildStructure({ chapters: BOOK.chapters.slice(0, 2) }, POSITION, new Set(), new Map(), t);
    expect(small.filter((i) => i.kind === 'chapter').map((i) => i.expanded)).toEqual([true, true]);
  });

  it('override map wins over the default in both directions (06 §14)', () => {
    const items = buildStructure(BOOK, POSITION, new Set(), new Map([['ch-1', false], ['ch-2', true]]), t);
    const chapters = items.filter((i) => i.kind === 'chapter');
    expect(chapters[0].expanded).toBe(false); // default true, overridden collapsed
    expect(chapters[1].expanded).toBe(true);  // default false, overridden expanded
  });

  it('special chapters: cover → "Cover", prologue → "Prologue"', () => {
    const items = buildStructure(BOOK, POSITION, new Set(), new Map(), t);
    const chapters = items.filter((i) => i.kind === 'chapter');
    expect(chapters[1].label).toBe('Cover');
    expect(chapters[2].label).toBe('Prologue');
  });

  it('special chapter with unknown type falls back to the capitalized type, then the title', () => {
    const typed = { chapters: [{ chapter_id: 'x', is_special: true, type: 'epigraph', scenes: [] }] };
    expect(buildStructure(typed, POSITION, new Set(), new Map(), t)[0].label).toBe('Epigraph');
    const titled = { chapters: [{ chapter_id: 'y', chapter_title: 'Intro', is_special: true, type: 'note', scenes: [] }] };
    expect(buildStructure(titled, POSITION, new Set(), new Map(), t)[0].label).toBe('Intro');
  });

  it('scene label: style → "… — type (style)"; missing type → "(scene)" fallback', () => {
    const book = {
      chapters: [{
        chapter_id: 'c', display_number: 1,
        scenes: [
          { scene_id: 's1', display_index: 1, type: 'dialogue', style: 'noir', units: [] },
          { scene_id: 's2', display_index: 2, type: null, units: [] },
        ],
      }],
    };
    const items = buildStructure(book, POSITION, new Set(['c|s1', 'c|s2']), new Map(), t);
    expect(items[1].label).toBe('Scene 1 — dialogue (noir)');
    expect(items[2].label).toBe('Scene 2 (scene)');
  });

  it('scene expansion follows the expandedScenes set (keyed chapterId|sceneId)', () => {
    const items = buildStructure(BOOK, POSITION, new Set(['ch-1|sc-1a']), new Map(), t);
    const scenes = items.filter((i) => i.kind === 'scene');
    expect(scenes[0].expanded).toBe(true);
    expect(scenes[1].expanded).toBe(false);
  });

  it('active unit: chapterId + sceneId + unitIndex match the position', () => {
    const items = buildStructure(BOOK, POSITION, new Set(['ch-1|sc-1a']), new Map(), t);
    const units = items.filter((i) => i.kind === 'unit');
    expect(units[0].isActive).toBe(true);
    expect(units[1].isActive).toBe(false);
  });

  it('empty book / no chapters → empty tree', () => {
    expect(buildStructure({ chapters: null }, POSITION, new Set(), new Map(), t)).toEqual([]);
  });
});

// ── Component behavior through the ports ─────────────────────────────────

describe('NavigatePage (ports-injected characterization)', () => {
  it('loads the book via HttpPort.getJson with the /book/:id path and shows the tree', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-9' });
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(fakes.getJson).toHaveBeenCalledWith('/book/b-9'));
    await vi.waitFor(() => expect(screen.queryAllByText(/The Beginning/).length).toBeGreaterThan(0));
  });

  it('empty state when no book is open (bookId = "") — no fetch', async () => {
    const { ports, fakes } = makePorts({ bookId: '' });
    render(<NavigatePage ports={ports} />);
    expect(fakes.getJson).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByText('No book loaded')).toBeTruthy());
  });

  it('auto-expands the current position scene on mount', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world').length).toBeGreaterThan(0));
  });

  it('follows a position change: new scene auto-expands, old one collapses', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world').length).toBeGreaterThan(0));
    act(() => {
      ports.position.position.value = { ...POSITION, sceneId: 'sc-1b', unitId: 'iu-3' };
    });
    await vi.waitFor(() => expect(screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === 'Unit 1 — Narrative').length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/Hello world/).length).toBe(0);
  });

  it('position bar renders "Chapter / Scene — Title / Unit" for the current position', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(screen.getByText('Chapter 1 — The Beginning / Scene 1 — First Scene / Unit 1')).toBeTruthy());
  });

  it('position bar shows the fallback label when no position is set', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' });
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(screen.getByText('No position selected')).toBeTruthy());
  });

  it('chapter tap toggles the chapter; scene tap opens units; chapter tap never expands scenes', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' }); // no position set
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(screen.getAllByText(/The Beginning/).length).toBeGreaterThan(0));
    // 4 chapters, no current position → all default-collapsed
    expect(screen.queryAllByText(/Scene 1 —/).length).toBe(0);
    fireEvent.click(screen.getByText('Chapter 1 — The Beginning'));
    // chapter expanded (override) → its scenes appear collapsed; units hidden
    expect(screen.getAllByText('Scene 1 — First Scene (dialogue)').length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/\[line\] navigate_unit 1 —/).length).toBe(0);
    fireEvent.click(screen.getByText('Scene 1 — First Scene (dialogue)'));
    expect(screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world').length).toBeGreaterThan(0);
    // second chapter tap collapses it again (override wins both directions)
    fireEvent.click(screen.getByText('Chapter 1 — The Beginning'));
    expect(screen.queryAllByText(/Scene 1 —/).length).toBe(0);
  });

  it('mobile unit tap → PositionPort.navigateTo + SeekPort.seekToPosition + NavigationPort → /play', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1', isDesktop: false });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    const unit = await vi.waitFor(() => screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world')[0]);
    fireEvent.click(unit);
    expect(fakes.navigateTo).toHaveBeenCalledWith({ chapterId: 'ch-1', sceneId: 'sc-1a', unitId: 'iu-1', unitIndex: 0 });
    expect(fakes.seekToPosition).toHaveBeenCalledTimes(1);
    expect(fakes.seekToPosition).toHaveBeenCalledWith('ch-1', 'sc-1a', 0, 'iu-1');
    expect(fakes.navigateToPlay).toHaveBeenCalledTimes(1); // switchToPlayTab()
  });

  it('desktop unit tap → select only: navigateTo + seek run, NO navigation to /play', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1', isDesktop: true });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    const unit = await vi.waitFor(() => screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world')[0]);
    fireEvent.click(unit);
    expect(fakes.navigateTo).toHaveBeenCalledTimes(1);
    expect(fakes.seekToPosition).toHaveBeenCalledTimes(1);
    expect(fakes.navigateToPlay).not.toHaveBeenCalled();
  });

  it('desktop double-click on a unit → seek + navigate to /play (explicit playback)', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1', isDesktop: true });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    const unit = await vi.waitFor(() => screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world')[0]);
    fireEvent.dblClick(unit);
    expect(fakes.seekToPosition).toHaveBeenCalledTimes(1);
    expect(fakes.navigateToPlay).toHaveBeenCalledTimes(1);
  });

  it('desktop active row shows the play button → seek + navigate to /play', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1', isDesktop: true });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    const play = await vi.waitFor(() => screen.getByTitle('Open in Player'));
    fireEvent.click(play);
    expect(fakes.navigateToPlay).toHaveBeenCalledTimes(1);
    expect(fakes.seekToPosition).toHaveBeenCalledTimes(1);
  });

  it('mobile renders no play button and double-click does not navigate', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1', isDesktop: false });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    const unit = await vi.waitFor(() => screen.getAllByText((_, el) => el?.className === 'nav-item__text' && el.textContent?.replace(/\s+/g, ' ').trim() === '[line] Unit 1 — Hello world')[0]);
    expect(screen.queryByTitle('Open in Player')).toBeNull();
    fireEvent.dblClick(unit);
    expect(fakes.navigateToPlay).not.toHaveBeenCalled();
  });

  it('reload triggers: onPlaybackPrepared for the same book re-fetches; another book does not', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1' });
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(fakes.onPlaybackPrepared).toHaveBeenCalled());
    const handler = fakes.onPlaybackPrepared.mock.calls[0][0];
    await vi.waitFor(() => expect(fakes.getJson).toHaveBeenCalledTimes(1)); // initial load done (loadingRef guard)
    fakes.getJson.mockClear();
    handler({ bookId: 'b-1', buildId: 'bd-1' });
    await vi.waitFor(() => expect(fakes.getJson).toHaveBeenCalledTimes(1));
    fakes.getJson.mockClear();
    handler({ bookId: 'other', buildId: 'bd-1' });
    expect(fakes.getJson).not.toHaveBeenCalled();
  });

  it('invalidation trigger: EXTERNAL event for book:<id> re-fetches; LOCAL and foreign resources do not', async () => {
    const { ports, fakes } = makePorts({ book: BOOK, bookId: 'b-1' });
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => expect(fakes.onResourceInvalidated).toHaveBeenCalled());
    const handler = fakes.onResourceInvalidated.mock.calls[0][0];
    await vi.waitFor(() => expect(fakes.getJson).toHaveBeenCalledTimes(1)); // initial load done (loadingRef guard)
    fakes.getJson.mockClear();
    handler({ kind: 'LOCAL', resource: 'book:b-1' });
    handler({ kind: 'EXTERNAL', resource: 'book:other' });
    expect(fakes.getJson).not.toHaveBeenCalled();
    handler({ kind: 'EXTERNAL', resource: 'book:b-1' });
    await vi.waitFor(() => expect(fakes.getJson).toHaveBeenCalledTimes(1));
  });

  it('unit thumbnails use HttpPort.mediaUrl with the /preview grammar', async () => {
    const { ports } = makePorts({ book: BOOK, bookId: 'b-1' });
    ports.position.position.value = POSITION;
    render(<NavigatePage ports={ports} />);
    await vi.waitFor(() => {
      const img = document.querySelector('img.nav-item__thumb') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toBe('/api/v1/preview/b-1/ch-1/sc-1a/iu-1?build_id=bd-1');
    });
  });
});

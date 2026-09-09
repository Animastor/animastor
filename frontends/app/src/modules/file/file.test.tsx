// @vitest-environment happy-dom
// File characterization tests (file-module-extraction-audit.md, Phase 1 prep).
//
// They pin the CURRENT behavior of the File surface through the FilePorts
// contract with fake ports — no host store is imported:
//  - card rendering (i18n strings through the port);
//  - enable rules of the download section (book vs media);
//  - status-priority rendering (error > export > importing > loading, else hidden);
//  - import picker + drag-drop through ActionsPort;
//  - Create New Book → closeBook + createBlankBook + navigate('/edit');
//  - Library card → navigate('/library');
//  - one-shot navigationEvent handshake (consume-and-reset + hasNavigated guard);
//  - download flow (path grammar, progress, filename, saved status, error toast);
//  - open-request port (desktop "Open" → picker click);
//  - deep-link takeBookParam → openBookById (once per mount).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { FilePage } from '../../pages/FilePage';
import type {
  FilePhase, FilePorts,
} from './ports';

// ── Fake ports ───────────────────────────────────────────────────────────

const STRINGS: Record<string, string> = {
  file_status_opening: 'Opening…',
  file_status_generating: 'Generating…',
  file_status_checking: 'Checking…',
  file_from_device: 'From Device',
  file_from_device_desc: 'Import a book file',
  file_create: 'Create New Book',
  file_create_desc: 'Start from scratch',
  library_button: 'Library',
  empty_state: 'Nothing here yet',
  download_section: 'Download',
  download_book: 'Book',
  download_storyboard: 'Storyboard',
  download_audio: 'Audio',
  download_video: 'Video',
  export_preparing: 'Preparing…',
  export_preparing_storyboard: 'Preparing storyboard…',
  export_merging_audio: 'Merging audio…',
  export_merging_video: 'Merging video…',
  export_progress: 'Saving {0}%',
  export_saved: 'Saved',
  download_failed: 'Download failed',
};

function makePorts(): { ports: FilePorts; events: string[] } {
  const events: string[] = [];
  const session = {
    bookId: signal(''),
    buildId: signal(''),
    phase: signal<FilePhase>('IDLE'),
    errorMessage: signal<string | null>(null),
    importMessages: signal<string[]>([]),
    isExporting: signal(false),
    navigationEvent: signal<'play' | 'generate' | null>(null),
  };
  const ports: FilePorts = {
    session,
    actions: {
      importBookFromFile: vi.fn(async (file: File) => { events.push(`import:${file.name}`); }),
      openBookById: vi.fn(async (param: string) => { events.push(`open:${param}`); }),
      closeBook: vi.fn(() => { events.push('close'); }),
      createBlankBook: vi.fn(async () => 'new-book-1'),
      setExporting: vi.fn((v: boolean) => { session.isExporting.value = v; }),
      setExportProgress: vi.fn((v: number) => { events.push(`progress:${v}`); }),
    },
    http: {
      getBlob: vi.fn(async (path: string, onProgress?: (p: number) => void) => {
        events.push(`blob:${path}`);
        onProgress?.(0.5);
        return new Blob(['x'], { type: 'application/octet-stream' });
      }),
    },
    i18n: {
      t: (key, fallback) => STRINGS[key] ?? fallback ?? key,
      tf: (key, ...args) => (STRINGS[key] ?? key).replace(/\{0\}/g, String(args[0])),
    },
    toast: { toast: vi.fn((msg: string) => { events.push(`toast:${msg}`); }) },
    navigation: { navigate: vi.fn((route) => { events.push(`nav:${route}`); }) },
    openRequests: { onOpenRequest: vi.fn((fn: () => void) => { events.push('open-request-sub'); openHandlers.push(fn); return () => {}; }) },
    deepLink: { takeBookParam: vi.fn(() => null) },
    icons: {
      Folder: () => <span data-testid="icon-folder" />,
      Add: () => <span data-testid="icon-add" />,
      Library: () => <span data-testid="icon-library" />,
      Download: () => <span data-testid="icon-download" />,
      Image: () => <span data-testid="icon-image" />,
      VolumeUp: () => <span data-testid="icon-volume" />,
      Video: () => <span data-testid="icon-video" />,
    },
  };
  return { ports, events };
}

let openHandlers: Array<() => void> = [];

beforeEach(() => {
  openHandlers = [];
  vi.spyOn(document, 'createElement');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── Rendering ────────────────────────────────────────────────────────────

describe('FilePage — rendering', () => {
  it('renders the three cards + download section with i18n strings from the port', () => {
    const { ports } = makePorts();
    render(<FilePage ports={ports} />);
    expect(screen.getByRole('button', { name: 'From Device' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create New Book' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Library' })).toBeTruthy();
    expect(screen.getByText('Download')).toBeTruthy();
    // Empty session → ALL downloads disabled (book needs bookId, media need
    // bookId+buildId+ready phase — audit Phase 1 enable rules).
    expect((screen.getByRole('button', { name: 'Book' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Storyboard' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Audio' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Video' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no status line in IDLE (Android observeState: else hidden)', () => {
    const { ports } = makePorts();
    render(<FilePage ports={ports} />);
    expect(screen.queryByText('Opening…')).toBeNull();
  });

  it('error wins over everything (status text = errorMessage, no bar)', () => {
    const { ports } = makePorts();
    ports.session.phase.value = 'LOADING_BOOK';
    ports.session.errorMessage.value = 'boom';
    render(<FilePage ports={ports} />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('importing shows the LAST import message; empty list falls back to "Opening…" + bar', () => {
    const { ports } = makePorts();
    ports.session.phase.value = 'IMPORTING_TXT';
    render(<FilePage ports={ports} />);
    expect(screen.getByText('Opening…')).toBeTruthy();

    act(() => { ports.session.importMessages.value = ['✓ File selected', '✓ TXT read']; });
    expect(screen.getByText('✓ TXT read')).toBeTruthy();
  });

  it('loading phases map: LOADING_BOOK→Opening, GENERATING→Generating, DOWNLOADING→Checking', () => {
    const { ports } = makePorts();
    ports.session.phase.value = 'LOADING_BOOK';
    const { unmount } = render(<FilePage ports={ports} />);
    expect(screen.getByText('Opening…')).toBeTruthy();
    unmount();

    ports.session.phase.value = 'GENERATING';
    render(<FilePage ports={ports} />);
    expect(screen.getByText('Generating…')).toBeTruthy();
    cleanup();

    ports.session.phase.value = 'DOWNLOADING';
    render(<FilePage ports={ports} />);
    expect(screen.getByText('Checking…')).toBeTruthy();
  });
});

// ── Enable rules ─────────────────────────────────────────────────────────

describe('FilePage — download enable rules', () => {
  it('book download: bookId set → enabled; exporting → disabled', () => {
    const { ports } = makePorts();
    ports.session.bookId.value = 'b1';
    render(<FilePage ports={ports} />);
    expect((screen.getByRole('button', { name: 'Book' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    ports.session.isExporting.value = true;
    render(<FilePage ports={ports} />);
    expect((screen.getByRole('button', { name: 'Book' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('media downloads need bookId + buildId + SCENE_READY/PLAYING', () => {
    const { ports } = makePorts();
    ports.session.bookId.value = 'b1';
    ports.session.buildId.value = 'bd1';
    ports.session.phase.value = 'PAUSED';
    render(<FilePage ports={ports} />);
    expect((screen.getByRole('button', { name: 'Audio' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    ports.session.phase.value = 'SCENE_READY';
    render(<FilePage ports={ports} />);
    expect((screen.getByRole('button', { name: 'Audio' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    ports.session.phase.value = 'PLAYING';
    render(<FilePage ports={ports} />);
    expect((screen.getByRole('button', { name: 'Video' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Import / create / library ────────────────────────────────────────────

describe('FilePage — interactions', () => {
  it('Import card click opens the file picker; picking a file → actions.importBookFromFile', async () => {
    const { ports, events } = makePorts();
    render(<FilePage ports={ports} />);
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'From Device' }));
    expect(clickSpy).toHaveBeenCalled();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'story.vbook');
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(ports.actions.importBookFromFile).toHaveBeenCalledWith(file);
    expect(events.filter((e) => e.startsWith('import:'))).toEqual(['import:story.vbook']);
  });

  it('drag-drop → importBookFromFile', async () => {
    const { ports } = makePorts();
    render(<FilePage ports={ports} />);
    const card = screen.getByRole('button', { name: 'From Device' });
    const file = new File(['data'], 'book.txt');
    const dt = { files: [file] } as unknown as DataTransfer;
    await act(async () => { fireEvent.drop(card, { dataTransfer: dt }); });
    expect(ports.actions.importBookFromFile).toHaveBeenCalledWith(file);
  });

  it('Create New Book → closeBook, createBlankBook, navigate /edit; null id → no navigation', async () => {
    const { ports, events } = makePorts();
    render(<FilePage ports={ports} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create New Book' })); });
    expect(ports.actions.closeBook).toHaveBeenCalled();
    expect(ports.actions.createBlankBook).toHaveBeenCalled();
    expect(events).toContain('nav:/edit');
    cleanup();

    const { ports: p2, events: ev2 } = makePorts();
    (p2.actions.createBlankBook as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    render(<FilePage ports={p2} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create New Book' })); });
    expect(ev2.filter((e) => e.startsWith('nav:'))).toEqual([]);
  });

  it('Library card → navigate /library', () => {
    const { ports, events } = makePorts();
    render(<FilePage ports={ports} />);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(events).toContain('nav:/library');
  });

  it('open-request port triggers the picker (desktop "Open" path)', () => {
    const { ports } = makePorts();
    render(<FilePage ports={ports} />);
    expect(ports.openRequests.onOpenRequest).toHaveBeenCalled();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => { openHandlers.forEach((fn) => fn()); });
    expect(clickSpy).toHaveBeenCalled();
  });

  it('deep link: takeBookParam → openBookById exactly once per mount', async () => {
    const { ports } = makePorts();
    (ports.deepLink.takeBookParam as ReturnType<typeof vi.fn>).mockReturnValue('linked-1');
    render(<FilePage ports={ports} />);
    await waitFor(() => expect(ports.actions.openBookById).toHaveBeenCalledWith('linked-1'));
    expect((ports.deepLink.takeBookParam as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ── navigationEvent handshake ────────────────────────────────────────────

describe('FilePage — navigationEvent one-shot handshake', () => {
  it('initial event → navigate + reset; a NEW import re-arms the guard', () => {
    const { ports, events } = makePorts();
    ports.session.navigationEvent.value = 'play';
    render(<FilePage ports={ports} />);
    expect(events).toContain('nav:/play');
    expect(ports.session.navigationEvent.value).toBeNull();

    // Second emission without a new import: the guard keeps it unconsumed
    // (Android hasSwitchedToPlay stays true until runImport resets it).
    act(() => { ports.session.navigationEvent.value = 'generate'; });
    expect(events.filter((e) => e.startsWith('nav:'))).toEqual(['nav:/play']);
  });

  it('runImport re-arms: a fresh import emits → navigates again', () => {
    const { ports, events } = makePorts();
    ports.session.navigationEvent.value = 'play';
    render(<FilePage ports={ports} />);
    expect(events.filter((e) => e.startsWith('nav:'))).toEqual(['nav:/play']);

    // New import resets the one-shot guard, then the store emits again.
    const file = new File(['d'], 'second.vbook');
    act(() => { fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } }); });
    act(() => { ports.session.navigationEvent.value = 'generate'; });
    expect(events.filter((e) => e.startsWith('nav:'))).toEqual(['nav:/play', 'nav:/generate']);
  });

  it('hasNavigated guard: a stale event emitted twice is consumed once per import run', () => {
    const { ports, events } = makePorts();
    ports.session.navigationEvent.value = 'play';
    render(<FilePage ports={ports} />);
    const navs = events.filter((e) => e.startsWith('nav:'));
    expect(navs).toEqual(['nav:/play']);
  });
});

// ── Export flow ──────────────────────────────────────────────────────────

describe('FilePage — export/download flow', () => {
  beforeEach(() => {
    // jsdom/happy-dom: <a download> click — stub navigate & object URL.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('book export: path grammar + progress callback + Saved status', async () => {
    const { ports, events } = makePorts();
    ports.session.bookId.value = 'b1';
    render(<FilePage ports={ports} />);
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(events).toContain('blob:/book/b1/download'));
    expect(events).toContain('progress:0.5');
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  });

  it('media export path grammar: storyboard / audio / video with build_id query', async () => {
    const { ports, events } = makePorts();
    ports.session.bookId.value = 'b1';
    ports.session.buildId.value = 'bd 1';
    ports.session.phase.value = 'SCENE_READY';
    render(<FilePage ports={ports} />);

    fireEvent.click(screen.getByRole('button', { name: 'Storyboard' }));
    await waitFor(() => expect(events).toContain('blob:/book/b1/storyboard?build_id=bd%201'));
    cleanup();

    const { ports: p2, events: ev2 } = makePorts();
    p2.session.bookId.value = 'b1';
    p2.session.buildId.value = 'bd1';
    p2.session.phase.value = 'PLAYING';
    render(<FilePage ports={p2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    await waitFor(() => expect(ev2).toContain('blob:/book/b1/audio?build_id=bd1'));
    cleanup();

    const { ports: p3, events: ev3 } = makePorts();
    p3.session.bookId.value = 'b1';
    p3.session.buildId.value = 'bd1';
    p3.session.phase.value = 'PLAYING';
    render(<FilePage ports={p3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    await waitFor(() => expect(ev3).toContain('blob:/book/b1/export?build_id=bd1'));
  });

  it('export failure: toast with localized prefix, status cleared, exporting released', async () => {
    const { ports } = makePorts();
    ports.session.bookId.value = 'b1';
    (ports.http.getBlob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net down'));
    render(<FilePage ports={ports} />);
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(ports.toast.toast).toHaveBeenCalledWith('Download failed: net down', 4000));
    expect(ports.session.isExporting.value).toBe(false);
  });

  it('guards: no bookId → no export; media without ready phase → no request', () => {
    const { ports, events } = makePorts();
    render(<FilePage ports={ports} />);
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(events.filter((e) => e.startsWith('blob:'))).toEqual([]);
  });
});

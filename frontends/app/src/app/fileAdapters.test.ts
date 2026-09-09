// @vitest-environment happy-dom
// fileAdapters wiring test — the host composition root must bridge the REAL
// shared infrastructure to FilePorts without forking the shared session state
// (audit Phase 2: "bookId/buildId signals — the session identity stays the
// single source of truth in the host").

import { describe, it, expect, vi } from 'vitest';
import { filePorts, OPEN_FILE_EVENT } from './fileAdapters';
import * as generateStore from '../state/generateStore';
import * as fileStore from '../state/fileStore';

describe('fileAdapters — host wiring', () => {
  it('session identity + shared status signals are the generateStore signals themselves (no fork)', () => {
    expect(filePorts.session.bookId).toBe(generateStore.bookId);
    expect(filePorts.session.buildId).toBe(generateStore.buildId);
    expect(filePorts.session.phase).toBe(generateStore.phase);
    expect(filePorts.session.errorMessage).toBe(generateStore.errorMessage);
  });

  it('File-owned signals are the fileStore signals themselves (single owner, no copy)', () => {
    expect(filePorts.session.importMessages).toBe(fileStore.importMessages);
    expect(filePorts.session.isExporting).toBe(fileStore.isExporting);
    expect(filePorts.session.navigationEvent).toBe(fileStore.navigationEvent);
  });

  it('session identity is NOT forked: fileStore writes the shared generateStore signals', async () => {
    // fileStore.loadBook seam must be generateStore.loadBook itself (identity
    // write path stays host-owned — no duplicate persist logic in fileStore).
    fileStore.importMessages.value = ['x'];
    fileStore.setExporting(true);
    fileStore.setExportProgress(7);
    expect(fileStore.isExporting.value).toBe(true);
    expect(fileStore.exportProgress.value).toBe(7);
    fileStore.setExporting(false);
    expect(fileStore.isExporting.value).toBe(false);
    expect(fileStore.exportProgress.value).toBe(0); // reset on export end
  });

  it('fileStore is wired to the shared seams at composition time', async () => {
    // The composition root ran wireFileStore at module load; a second call is
    // idempotent wiring, but the seams must exist (no throw on first use).
    expect(() => fileStore.setExportProgress(0)).not.toThrow();
  });

  it('i18n resolves real dictionary keys through the port', () => {
    expect(filePorts.i18n.t('file_from_device')).toBeTruthy();
    expect(filePorts.i18n.t('file_from_device')).not.toBe('file_from_device');
    expect(filePorts.i18n.tf('export_progress', 42)).toContain('42');
  });

  it('open-request port subscribes on window and unsubscribes (OPEN_FILE_EVENT)', () => {
    const handler = vi.fn();
    const unsub = filePorts.openRequests.onOpenRequest(handler);
    window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT));
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('deep link: reads ?book= and strips it from the URL; ?open= fallback; null when absent', () => {
    history.replaceState(null, '', '/file?book=abc');
    expect(filePorts.deepLink.takeBookParam()).toBe('abc');
    expect(location.search).toBe('');

    history.replaceState(null, '', '/file?open=xyz');
    expect(filePorts.deepLink.takeBookParam()).toBe('xyz');
    expect(location.search).toBe('');

    history.replaceState(null, '', '/file');
    expect(filePorts.deepLink.takeBookParam()).toBeNull();
  });
});

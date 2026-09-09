// @vitest-environment happy-dom
// fileAdapters wiring test — the host composition root must bridge the REAL
// shared infrastructure to FilePorts without forking the shared session state
// (audit Phase 2: "bookId/buildId signals — the session identity stays the
// single source of truth in the host").

import { describe, it, expect, vi } from 'vitest';
import { filePorts, OPEN_FILE_EVENT } from './fileAdapters';
import * as generateStore from '../state/generateStore';

describe('fileAdapters — host wiring', () => {
  it('session signals are the generateStore signals themselves (no fork)', () => {
    expect(filePorts.session.bookId).toBe(generateStore.bookId);
    expect(filePorts.session.buildId).toBe(generateStore.buildId);
    expect(filePorts.session.phase).toBe(generateStore.phase);
    expect(filePorts.session.errorMessage).toBe(generateStore.errorMessage);
    expect(filePorts.session.importMessages).toBe(generateStore.importMessages);
    expect(filePorts.session.isExporting).toBe(generateStore.isExporting);
    expect(filePorts.session.navigationEvent).toBe(generateStore.navigationEvent);
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

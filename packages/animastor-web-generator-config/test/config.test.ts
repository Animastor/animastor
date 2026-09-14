// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-config — unit tests
// ═══════════════════════════════════════════════════════════════
//  Pure function tests: loadLayerConfig, persistLayerConfig,
//  getAssetsState. All tests use mock ports — zero host imports.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadLayerConfig, persistLayerConfig, getAssetsState } from '../src/index';
import type { IdentityPort, TransportPort } from '../src/index';

function mockIdentity(bookId: string): IdentityPort {
  return { getBookId: () => bookId };
}

function mockTransport(overrides: Partial<{
  getJson: ReturnType<typeof vi.fn>;
  putJson: ReturnType<typeof vi.fn>;
}> = {}): TransportPort {
  return {
    getJson: overrides.getJson ?? vi.fn(async () => ({})),
    putJson: overrides.putJson ?? vi.fn(async () => ({})),
  };
}

describe('loadLayerConfig', () => {
  it('returns config on success', async () => {
    const cfg = {
      audio_enabled: true, image_enabled: false, video_enabled: true,
      vbook_enabled: true, chunk_size: 3, analysis_mode: 'parallel' as const,
      analysis_parallelism: 4,
    };
    const transport = mockTransport({ getJson: vi.fn(async () => cfg) });
    const result = await loadLayerConfig(mockIdentity('book-1'), transport);
    expect(result).toEqual(cfg);
    expect(transport.getJson).toHaveBeenCalledWith('/book/book-1/layer-config');
  });

  it('returns null when bookId is empty', async () => {
    const transport = mockTransport();
    const result = await loadLayerConfig(mockIdentity(''), transport);
    expect(result).toBeNull();
    expect(transport.getJson).not.toHaveBeenCalled();
  });

  it('returns null on API error', async () => {
    const transport = mockTransport({
      getJson: vi.fn(async () => { throw new Error('network'); }),
    });
    const result = await loadLayerConfig(mockIdentity('book-1'), transport);
    expect(result).toBeNull();
  });

  it('URL-encodes bookId', async () => {
    const transport = mockTransport({ getJson: vi.fn(async () => null) });
    await loadLayerConfig(mockIdentity('a/b/c'), transport);
    expect(transport.getJson).toHaveBeenCalledWith('/book/a%2Fb%2Fc/layer-config');
  });
});

describe('persistLayerConfig', () => {
  it('sends PUT with config payload', async () => {
    const transport = mockTransport();
    const config = {
      audio_enabled: true, image_enabled: false,
      video_enabled: true, vbook_enabled: false,
    };
    await persistLayerConfig(transport, 'book-1', config);
    expect(transport.putJson).toHaveBeenCalledWith(
      '/book/book-1/layer-config',
      config,
    );
  });

  it('no-op when bookId is empty', async () => {
    const transport = mockTransport();
    await persistLayerConfig(transport, '', {
      audio_enabled: true, image_enabled: true,
      video_enabled: true, vbook_enabled: true,
    });
    expect(transport.putJson).not.toHaveBeenCalled();
  });

  it('swallows errors', async () => {
    const transport = mockTransport({
      putJson: vi.fn(async () => { throw new Error('fail'); }),
    });
    // Should not throw
    await persistLayerConfig(transport, 'book-1', {
      audio_enabled: true, image_enabled: true,
      video_enabled: true, vbook_enabled: true,
    });
  });

  it('URL-encodes bookId', async () => {
    const transport = mockTransport();
    await persistLayerConfig(transport, 'a/b', {
      audio_enabled: true, image_enabled: true,
      video_enabled: true, vbook_enabled: true,
    });
    expect(transport.putJson).toHaveBeenCalledWith(
      '/book/a%2Fb/layer-config',
      expect.anything(),
    );
  });
});

describe('getAssetsState', () => {
  it('returns assets state on success', async () => {
    const assets = { has_assets: true };
    const transport = mockTransport({ getJson: vi.fn(async () => assets) });
    const result = await getAssetsState(mockIdentity('book-1'), transport);
    expect(result).toEqual(assets);
    expect(transport.getJson).toHaveBeenCalledWith('/book/book-1/assets-state');
  });

  it('returns null when bookId is empty', async () => {
    const transport = mockTransport();
    const result = await getAssetsState(mockIdentity(''), transport);
    expect(result).toBeNull();
    expect(transport.getJson).not.toHaveBeenCalled();
  });

  it('returns null on API error', async () => {
    const transport = mockTransport({
      getJson: vi.fn(async () => { throw new Error('offline'); }),
    });
    const result = await getAssetsState(mockIdentity('book-1'), transport);
    expect(result).toBeNull();
  });
});

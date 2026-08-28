'use strict';

/**
 * Installer Phase 3.4 — ModelScope snapshot download (D2 closed).
 *
 * Tests for the installer_preload mechanism that pre-downloads ModelScope repos
 * for deterministic/offline operation. The custom node's auto_download is NOT
 * relied upon.
 *
 *   MS1  listModelScopeFiles returns file listing from ModelScope REST API
 *   MS2  downloadModelScopeRepo downloads all files into target directory
 *   MS3  idempotent: verified files are NOT re-downloaded
 *   MS4  checksum mismatch triggers re-download
 *   MS5  expected_files filter: only listed files are downloaded
 *   MS6  subdirectory creation for nested files (e.g. speech_tokenizer/)
 *   MS7  HTTP error from ModelScope API returns clear failure
 *   MS8  empty repo returns failure
 *   MS9  modelscopeFileUrl builds correct download URLs
 *   MS10 modelscopeStrategy returns correct mechanisms
 */

const assert = require('assert');
const { createMemoryFs } = require('../src/installer/engine/io');
const downloader = require('../src/installer/engine/downloader');

// ---------------------------------------------------------------------------
// Mock io factory
// ---------------------------------------------------------------------------

function createIo({ files = {}, http = {} } = {}) {
    const fs = createMemoryFs(files);
    const calls = { http: [] };
    const self = {
        fs,
        calls,
        http: {
            async download({ url, dest }) {
                calls.http.push({ op: 'download', url, dest });
                const handler = http[url];
                if (!handler) throw new Error(`unexpected download ${url}`);
                return handler({ dest, fs: self.fs });
            },
            async fetchJson(url, opts = {}) {
                calls.http.push({ op: 'fetchJson', url, opts });
                const handler = http[url];
                if (!handler) return { status: 404, json: null };
                if (typeof handler === 'function') return handler(opts);
                return handler;
            },
        },
        async hashFile(absPath) {
            calls.http.push({ op: 'hashFile', absPath });
            try {
                // hash RAW BYTES (like the real streaming hashFile) — never the
                // utf8-decoded string readFileSync would return for binary data
                const content = fs.readBufferSync ? fs.readBufferSync(absPath) : fs.readFileSync(absPath);
                const crypto = require('crypto');
                return crypto.createHash('sha256').update(content).digest('hex');
            } catch (_) {
                return 'deadbeef'.repeat(8);
            }
        },
    };
    return self;
}

function makeHeader() {
    return downloader.makeHeaderProvider({});
}

/** Make a download handler that writes a buffer of exactly `size` bytes. */
function makeDownloadHandler(size) {
    return ({ dest, fs }) => {
        const buf = Buffer.alloc(size, 0xab);
        fs.writeFileSync(dest, buf);
        return { status: 200, resumed: false };
    };
}

// ---------------------------------------------------------------------------
// MS1: listModelScopeFiles returns file listing
// ---------------------------------------------------------------------------
describe('ModelScope download — MS1: listModelScopeFiles', () => {
    it('returns file list from ModelScope REST API', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Code: 200,
                        Data: {
                            Files: [
                                { Name: 'model.safetensors', Path: 'model.safetensors', Type: 'blob', Size: 1024, Sha256: 'a1' },
                                { Name: 'speech_tokenizer', Path: 'speech_tokenizer', Type: 'tree', Size: 0, Sha256: '' },
                                { Name: 'config.json', Path: 'config.json', Type: 'blob', Size: 64, Sha256: 'b2' },
                            ],
                        },
                    },
                }),
                'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS/repo/files?Revision=master&Root=speech_tokenizer': () => ({
                    status: 200,
                    json: {
                        Code: 200,
                        Data: {
                            Files: [
                                { Name: 'model.safetensors', Path: 'speech_tokenizer/model.safetensors', Type: 'blob', Size: 512, Sha256: 'c3' },
                            ],
                        },
                    },
                }),
            },
        });

        const result = await downloader.listModelScopeFiles(io, 'Qwen/Qwen3-TTS', 'master', null);
        assert.ok(result.ok, result.error);
        assert.strictEqual(result.files.length, 3);
        const byPath = Object.fromEntries(result.files.map((f) => [f.Path, f]));
        assert.strictEqual(byPath['model.safetensors'].Size, 1024);
        assert.strictEqual(byPath['speech_tokenizer/model.safetensors'].Size, 512);
        assert.strictEqual(byPath['config.json'].Size, 64);
        assert.strictEqual(byPath['config.json'].Sha256, 'b2');
    });

    it('recurses into subdirectories (tree entries) instead of listing them as files', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Name: 'subdir', Path: 'subdir', Type: 'tree', Size: 0 },
                                { Name: 'file.bin', Path: 'file.bin', Type: 'blob', Size: 100 },
                            ],
                        },
                    },
                }),
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master&Root=subdir': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Name: 'file.bin', Path: 'subdir/file.bin', Type: 'blob', Size: 50 },
                            ],
                        },
                    },
                }),
            },
        });

        const result = await downloader.listModelScopeFiles(io, 'Qwen/test', 'master', null);
        assert.ok(result.ok, result.error);
        assert.strictEqual(result.files.length, 2);
        const paths = result.files.map((f) => f.Path).sort();
        assert.deepStrictEqual(paths, ['file.bin', 'subdir/file.bin']);
    });

    it('returns error for HTTP 401', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/private/repo/repo/files?Revision=master': () => ({
                    status: 401,
                    json: null,
                }),
            },
        });

        const result = await downloader.listModelScopeFiles(io, 'private/repo', 'master', null);
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('401'));
    });

    it('handles flat array response format', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/flat/repo/files?Revision=master': () => ({
                    status: 200,
                    json: [
                        { Path: 'model.bin', Type: 'blob', Size: 256 },
                    ],
                }),
            },
        });

        const result = await downloader.listModelScopeFiles(io, 'Qwen/flat', 'master', null);
        assert.ok(result.ok, result.error);
        assert.strictEqual(result.files.length, 1);
        assert.strictEqual(result.files[0].Path, 'model.bin');
    });
});

// ---------------------------------------------------------------------------
// MS2: downloadModelScopeRepo downloads all files
// ---------------------------------------------------------------------------
describe('ModelScope download — MS2: downloadModelScopeRepo', () => {
    it('downloads all files from a ModelScope repo', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Name: 'model.safetensors', Path: 'model.safetensors', Type: 'blob', Size: 100 },
                                { Name: 'speech_tokenizer', Path: 'speech_tokenizer', Type: 'tree', Size: 0 },
                            ],
                        },
                    },
                }),
                'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS/repo/files?Revision=master&Root=speech_tokenizer': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Name: 'model.safetensors', Path: 'speech_tokenizer/model.safetensors', Type: 'blob', Size: 50 },
                            ],
                        },
                    },
                }),
            },
        });

        // Override download to write a file of the correct size
        const origDownload = io.http.download;
        io.http.download = async (opts) => {
            const url = opts.url;
            // Parse expected size from the URL to match listing
            const sizeMatch = url.includes('model.safetensors') && !url.includes('speech') ? 100
                : url.includes('speech_tokenizer') ? 50 : 100;
            const buf = Buffer.alloc(sizeMatch, 0xab);
            const { fs } = io;
            const dir = opts.dest.replace(/[\\/][^\\/]+$/, '');
            if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(opts.dest, buf);
            return { status: 200, resumed: false };
        };

        const spec = {
            id: 'model-repo:qwen3-tts',
            kind: 'modelscope',
            repository: 'Qwen/Qwen3-TTS',
            revision: 'master',
            target_path: 'models/TTS/Qwen/Qwen3-TTS',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
            retries: 2,
            retryDelayMs: 0,
            log: null,
        });

        assert.strictEqual(result.status, 'downloaded');
        assert.strictEqual(result.files.length, 2);
        assert.ok(result.files.every((f) => f.status === 'downloaded'));
        // Verify files exist on disk
        assert.ok(io.fs.existsSync('/comfyui/models/TTS/Qwen/Qwen3-TTS/model.safetensors'));
        assert.ok(io.fs.existsSync('/comfyui/models/TTS/Qwen/Qwen3-TTS/speech_tokenizer/model.safetensors'));
    });
});

// ---------------------------------------------------------------------------
// MS3: idempotency — verified files are NOT re-downloaded
// ---------------------------------------------------------------------------
describe('ModelScope download — MS3: idempotency', () => {
    it('skips files that already pass size verification', async () => {
        const content = Buffer.alloc(1024, 0xab);

        const io = createIo({
            files: {
                '/comfyui/models/TTS/test/model.safetensors': content,
            },
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'model.safetensors', Type: 'blob', Size: 1024 },
                            ],
                        },
                    },
                }),
            },
        });

        io.http.download = async () => {
            throw new Error('should NOT download: file already verified');
        };

        const spec = {
            id: 'model-repo:test',
            kind: 'modelscope',
            repository: 'Qwen/test',
            revision: 'master',
            target_path: 'models/TTS/test',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
        });

        assert.strictEqual(result.status, 'downloaded');
        assert.strictEqual(result.files.length, 1);
        assert.strictEqual(result.files[0].status, 'skipped');
    });
});

// ---------------------------------------------------------------------------
// MS4: checksum mismatch triggers re-download
// ---------------------------------------------------------------------------
describe('ModelScope download — MS4: size mismatch triggers re-download', () => {
    it('re-downloads when existing file has wrong size', async () => {
        const io = createIo({
            files: {
                '/comfyui/models/TTS/test/model.safetensors': Buffer.alloc(10, 0xff),
            },
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'model.safetensors', Type: 'blob', Size: 1024 },
                            ],
                        },
                    },
                }),
            },
        });

        let downloadCalled = false;
        io.http.download = async ({ dest }) => {
            downloadCalled = true;
            const buf = Buffer.alloc(1024, 0xab);
            io.fs.writeFileSync(dest, buf);
            return { status: 200, resumed: false };
        };

        const spec = {
            id: 'model-repo:test',
            kind: 'modelscope',
            repository: 'Qwen/test',
            revision: 'master',
            target_path: 'models/TTS/test',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
        });

        assert.ok(downloadCalled, 'should have re-downloaded due to size mismatch');
        assert.strictEqual(result.status, 'downloaded');
    });
});

// ---------------------------------------------------------------------------
// MS4b: registry-provided sha256 from the listing is used for verification
// ---------------------------------------------------------------------------
describe('ModelScope download — MS4b: registry sha256 verification', () => {
    const crypto = require('crypto');
    const content = Buffer.alloc(8, 0xab);
    const goodSha = crypto.createHash('sha256').update(content).digest('hex');

    function ioWithSha(sha) {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/sha/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'model.bin', Type: 'blob', Size: content.length, Sha256: sha },
                            ],
                        },
                    },
                }),
            },
        });
        io.http.download = async ({ dest }) => {
            io.fs.writeFileSync(dest, content);
            return { status: 200, resumed: false };
        };
        return io;
    }

    const spec = {
        id: 'model-repo:sha',
        kind: 'modelscope',
        repository: 'Qwen/sha',
        revision: 'master',
        target_path: 'models/TTS/sha',
        ready: true,
    };

    it('verifies downloaded bytes against the registry sha256', async () => {
        const io = ioWithSha(goodSha);
        const result = await downloader.downloadModelScopeRepo(io, { ...spec }, {
            root: '/comfyui', getHeader: makeHeader(), retries: 1, retryDelayMs: 0,
        });
        assert.strictEqual(result.status, 'downloaded', JSON.stringify(result));
        assert.strictEqual(result.files[0].grade, 'checksum-verified');
    });

    it('fails (never publishes) when the registry sha256 does not match', async () => {
        const io = ioWithSha('0'.repeat(64));
        const result = await downloader.downloadModelScopeRepo(io, { ...spec }, {
            root: '/comfyui', getHeader: makeHeader(), retries: 2, retryDelayMs: 0,
        });
        assert.strictEqual(result.status, 'failed', JSON.stringify(result));
        assert.ok(!io.fs.existsSync('/comfyui/models/TTS/sha/model.bin'), 'corrupt file must not be published');
    });
});

// ---------------------------------------------------------------------------
// MS5: expected_files filter
// ---------------------------------------------------------------------------
describe('ModelScope download — MS5: expected_files filter', () => {
    it('only downloads files matching expected_files list', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'model.safetensors', Type: 'blob', Size: 100 },
                                { Path: 'speech_tokenizer', Type: 'tree', Size: 0 },
                                { Path: 'README.md', Type: 'blob', Size: 20 },
                            ],
                        },
                    },
                }),
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master&Root=speech_tokenizer': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'speech_tokenizer/model.safetensors', Type: 'blob', Size: 50 },
                            ],
                        },
                    },
                }),
            },
        });

        const downloaded = [];
        io.http.download = async ({ url, dest }) => {
            const filePath = decodeURIComponent(url.split('FilePath=')[1] || '');
            downloaded.push(filePath);
            const size = filePath.includes('speech') ? 50 : 100;
            io.fs.writeFileSync(dest, Buffer.alloc(size, 0xab));
            return { status: 200, resumed: false };
        };

        const spec = {
            id: 'model-repo:test',
            kind: 'modelscope',
            repository: 'Qwen/test',
            revision: 'master',
            target_path: 'models/TTS/test',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
            expectedFiles: ['model.safetensors', 'speech_tokenizer/model.safetensors'],
        });

        assert.strictEqual(result.status, 'downloaded');
        assert.strictEqual(downloaded.length, 2);
        assert.ok(!downloaded.some((d) => d.includes('README.md')), 'README.md should NOT be downloaded');
    });
});

// ---------------------------------------------------------------------------
// MS6: subdirectory creation
// ---------------------------------------------------------------------------
describe('ModelScope download — MS6: subdirectory creation', () => {
    it('creates subdirectories for nested file paths', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'tokenizer', Type: 'tree', Size: 0 },
                            ],
                        },
                    },
                }),
                'https://modelscope.cn/api/v1/models/Qwen/test/repo/files?Revision=master&Root=tokenizer': () => ({
                    status: 200,
                    json: {
                        Data: {
                            Files: [
                                { Path: 'tokenizer/config.json', Type: 'blob', Size: 10 },
                            ],
                        },
                    },
                }),
            },
        });

        io.http.download = async ({ dest }) => {
            io.fs.writeFileSync(dest, Buffer.alloc(10, 0xab));
            return { status: 200, resumed: false };
        };

        const spec = {
            id: 'model-repo:test',
            kind: 'modelscope',
            repository: 'Qwen/test',
            revision: 'master',
            target_path: 'models/TTS/test',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
        });

        assert.strictEqual(result.status, 'downloaded');
        assert.ok(io.fs.existsSync('/comfyui/models/TTS/test/tokenizer/config.json'));
    });
});

// ---------------------------------------------------------------------------
// MS7: HTTP error from ModelScope
// ---------------------------------------------------------------------------
describe('ModelScope download — MS7: API error', () => {
    it('returns clear failure for listing error', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/bad/repo/files?Revision=master': () => ({
                    status: 500,
                    json: null,
                }),
            },
        });

        const spec = {
            id: 'model-repo:bad',
            kind: 'modelscope',
            repository: 'Qwen/bad',
            revision: 'master',
            target_path: 'models/TTS/bad',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
        });

        assert.strictEqual(result.status, 'failed');
        assert.ok(result.reason.includes('ModelScope file listing failed'));
    });
});

// ---------------------------------------------------------------------------
// MS8: empty repo
// ---------------------------------------------------------------------------
describe('ModelScope download — MS8: empty repo', () => {
    it('returns failure for repo with no files', async () => {
        const io = createIo({
            http: {
                'https://modelscope.cn/api/v1/models/Qwen/empty/repo/files?Revision=master': () => ({
                    status: 200,
                    json: { Data: { Files: [] } },
                }),
            },
        });

        const spec = {
            id: 'model-repo:empty',
            kind: 'modelscope',
            repository: 'Qwen/empty',
            revision: 'master',
            target_path: 'models/TTS/empty',
            ready: true,
        };

        const result = await downloader.downloadModelScopeRepo(io, spec, {
            root: '/comfyui',
            getHeader: makeHeader(),
        });

        assert.strictEqual(result.status, 'failed');
        assert.ok(result.reason.includes('no downloadable files'));
    });
});

// ---------------------------------------------------------------------------
// MS9: modelscopeFileUrl builds correct URLs
// ---------------------------------------------------------------------------
describe('ModelScope download — MS9: modelscopeFileUrl', () => {
    it('builds correct download URL with encoded path', () => {
        const url = downloader.modelscopeFileUrl('Qwen/Qwen3-TTS', 'model.safetensors', 'master');
        assert.strictEqual(url, 'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS/repo?Revision=master&FilePath=model.safetensors');
    });

    it('encodes special characters in file path', () => {
        const url = downloader.modelscopeFileUrl('Qwen/test', 'dir/file name.safetensors', 'v1');
        assert.ok(url.includes('FilePath=dir%2Ffile%20name.safetensors'));
    });

    it('uses default revision master', () => {
        const url = downloader.modelscopeFileUrl('Qwen/test', 'file.bin');
        assert.ok(url.includes('Revision=master'));
    });
});

// ---------------------------------------------------------------------------
// MS10: modelscopeStrategy
// ---------------------------------------------------------------------------
describe('ModelScope download — MS10: modelscopeStrategy', () => {
    it('returns installer_preload for installer_preload mechanism', () => {
        const dep = { delivery: { mechanism: 'installer_preload' } };
        const result = downloader.modelscopeStrategy(dep);
        assert.strictEqual(result.mechanism, 'installer_preload');
    });

    it('returns node_auto_download for node mechanism', () => {
        const dep = { delivery: { mechanism: 'node_auto_download' } };
        const result = downloader.modelscopeStrategy(dep);
        assert.strictEqual(result.mechanism, 'node_auto_download');
    });

    it('returns blocked for unknown mechanism', () => {
        const dep = { delivery: { mechanism: 'unknown' } };
        const result = downloader.modelscopeStrategy(dep);
        assert.strictEqual(result.mechanism, 'blocked');
    });

    it('returns blocked when delivery is missing', () => {
        const dep = {};
        const result = downloader.modelscopeStrategy(dep);
        assert.strictEqual(result.mechanism, 'blocked');
    });
});

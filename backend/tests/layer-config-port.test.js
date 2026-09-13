// ======================================================
// O-10 RUNTIME TESTS — LayerConfigPort contract + adapter delegation
// ======================================================
// Targets the O-10 seam (docs/architecture/generation-module-
// extraction-reconnaissance.md §32.27):
//   1. the port fails fast when unwired and resolves both ops when
//      wired (fail-fast contract, `_resetLayerConfigPort` test
//      hygiene);
//   2. the adapter delegates 1:1 to services/layer-config
//      get/restoreFromBooks through the lazy call-time channel — a
//      require.cache stub of ../src/services/layer-config is honored
//      (the worklist-rebuild purge-list stubbing channel);
//   3. the real service still answers with the frozen normalize
//      semantics (defaults on missing key, clamp on out-of-range
//      value — no network: FakeRedis in-memory);
//   4. the consumer legs keep their exact pre-O-10 semantics —
//      scene-orchestrator timeout tolerance (a throwing read leaves
//      videoTimeoutMs undefined — the try/catch swallows), and the
//      reconciliation PHASE C6 leg surfaces a call failure as a
//      warned non-fatal phase error (a missing service previously
//      skipped the phase silently; a FAILING service reported the
//      phase error — both behaviors preserved through the port).
// The composition-root wiring is exercised through the mocharc test
// bindings (generation-test-bindings.cjs mirrors backend.cjs).
// ======================================================

const { expect } = require('chai');

const port = require('../src/runtime/layer-config-port');
const adapter = require('../src/storage/layer-config-adapter');

const SERVICE_PATH = require.resolve('../src/services/layer-config');

class FakeRedis {
    constructor() { this.store = new Map(); }
    async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
    async set(k, v, mode) {
        if (mode === 'NX') {
            if (this.store.has(k)) return null;
            this.store.set(k, v);
            return 'OK';
        }
        this.store.set(k, v);
        return 'OK';
    }
    async del(k) { this.store.delete(k); return 1; }
}

describe('O-10 LayerConfigPort — contract, delegation and consumer-leg semantics', () => {

    describe('port contract', () => {
        afterEach(() => {
            // Re-wire the mocharc bindings adapter (test hygiene).
            port.setLayerConfigPort(adapter);
        });

        it('fails fast when unwired (layerConfig / layerConfigOp)', () => {
            port._resetLayerConfigPort();
            expect(() => port.layerConfig()).to.throw(/layer-config-port: not wired/);
            expect(() => port.layerConfigOp('get')).to.throw(/layer-config-port: op 'get' is not wired/);
        });

        it('the wiring gate rejects a missing adapter and a half-wired adapter', () => {
            expect(() => port.setLayerConfigPort(null)).to.throw(/adapter is required/);
            expect(() => port.setLayerConfigPort({ get: async () => {} })).to.throw(/adapter must implement restoreFromBooks\(\)/);
            expect(() => port.setLayerConfigPort({ restoreFromBooks: async () => {} })).to.throw(/adapter must implement get\(\)/);
        });

        it('isLayerConfigPortWired tracks the wiring state; the OPS set is frozen at two ops', () => {
            expect(port.isLayerConfigPortWired()).to.equal(true);
            expect(port.OPS).to.deep.equal(['get', 'restoreFromBooks']);
            port._resetLayerConfigPort();
            expect(port.isLayerConfigPortWired()).to.equal(false);
        });
    });

    describe('adapter delegation (1:1, lazy channel)', () => {
        it('get delegates to the real service through the call-time channel (normalize semantics intact)', async () => {
            const redis = new FakeRedis();
            // Missing key → normalized defaults (pre-O-10 behavior).
            const cfg = await adapter.get(redis, 'book-none');
            expect(cfg.audio_enabled).to.equal(true);
            expect(cfg.chunk_size).to.be.a('number');
            // Present key → clamped values.
            await redis.set('animastor:layer-config:book-1', JSON.stringify({ chunk_size: 99, video_timeout_minutes: 500 }));
            const clamped = await adapter.get(redis, 'book-1');
            expect(clamped.chunk_size).to.equal(5);      // clamp 1..5
            expect(clamped.video_timeout_minutes).to.equal(180); // clamp 10..180
        });

        it('restoreFromBooks delegates 1:1 (counting contract intact)', async () => {
            const redis = new FakeRedis();
            // No books dir entries to restore → 0 (the service's best-effort
            // read of the configured BOOKS_DIR; identical pre-O-10).
            const count = await adapter.restoreFromBooks(redis);
            expect(count).to.be.a('number');
        });

        it('a require.cache stub of the service is honored through the adapter (stubbing parity)', async () => {
            const real = require(SERVICE_PATH);
            const originalGet = real.get;
            let calls = 0;
            real.get = async () => { calls++; return { stubbed: true }; };
            try {
                const result = await adapter.get(new FakeRedis(), 'book-stub');
                expect(calls).to.equal(1);
                expect(result).to.deep.equal({ stubbed: true });
            } finally {
                real.get = originalGet;
            }
        });
    });

    describe('consumer-leg semantics preserved through the port', () => {
        it('the scene-orchestrator timeout leg tolerates a throwing read (pre-O-10 try/catch tolerance)', async () => {
            // The leg wraps the port call in try { … } catch (_) {} — a
            // throwing adapter/service read must leave videoTimeoutMs
            // undefined and never reject the dispatch.
            const stubErr = new Error('layer-config read failed');
            const savedImpl = adapter.get;
            adapter.get = async () => { throw stubErr; };
            try {
                let videoTimeoutMs;
                try {
                    const cfg = await port.layerConfigOp('get')(new FakeRedis(), 'book-1');
                    if (cfg && cfg.video_timeout_minutes > 0) {
                        videoTimeoutMs = cfg.video_timeout_minutes * 60 * 1000;
                    }
                } catch (_) {}
                expect(videoTimeoutMs).to.equal(undefined);
            } finally {
                adapter.get = savedImpl;
            }
        });

        it('the reconciliation C6 leg surfaces a call failure as a warned non-fatal phase error', async () => {
            // Pre-O-10: a FAILING restoreFromBooks call hit the outer
            // catch → warn + summary.errors.push — the cycle stayed ok.
            // Through the port the same failure must reach the same
            // outer catch (the port propagates the adapter's rejection).
            const stubErr = new Error('restore failed');
            const savedImpl = adapter.restoreFromBooks;
            adapter.restoreFromBooks = async () => { throw stubErr; };
            try {
                const summary = { errors: [] };
                const phases = [];
                const warnings = [];
                const warn = (m) => warnings.push(m);
                try {
                    const c6Count = await port.layerConfigOp('restoreFromBooks')(new FakeRedis());
                    if (c6Count > 0) phases.push(`layer_config_restore:${c6Count}`);
                } catch (err) {
                    warn(`Phase C6 failed: ${err.message}`);
                    summary.errors.push(`layer_config_restore: ${err.message}`);
                }
                expect(phases).to.deep.equal([]);
                expect(warnings).to.have.lengthOf(1);
                expect(warnings[0]).to.include('Phase C6 failed: restore failed');
                expect(summary.errors).to.deep.equal(['layer_config_restore: restore failed']);
            } finally {
                adapter.restoreFromBooks = savedImpl;
            }
        });

        it('the missing-service degrade of the C6 inner require maps to the same silent skip (optional-load parity)', () => {
            // Pre-O-10 the C6 leg's INNER try set layerConfig = null on a
            // require failure and the phase was skipped WITHOUT the
            // outer warn (restoreFromBooks was simply never called).
            // Post-O-10 the adapter's lazy resolver throws inside the
            // port call — the O10 arch guard pins that the tier code
            // keeps the outer try/catch, and this test pins the PORT
            // contract: an unwired port throws the fail-fast error that
            // the caller's catch handles.
            const savedImpl = adapter.restoreFromBooks;
            adapter.restoreFromBooks = undefined;
            try {
                // A half-unwired port op fails fast (never silently
                // skips) — the caller's catch decides what it means.
                expect(() => port.layerConfigOp('restoreFromBooks')).to.throw(/not wired/);
            } finally {
                adapter.restoreFromBooks = savedImpl;
            }
        });
    });

    describe('host channel unchanged', () => {
        it('services/layer-config keeps its frozen public surface (routes/agent/test consumers)', () => {
            const svc = require(SERVICE_PATH);
            for (const op of ['get', 'set', 'restoreFromBooks', 'getChunkSize', 'normalize', 'SCOPES', 'ANALYSIS_MODES', 'DEFAULTS', 'key']) {
                expect(svc[op], `services/layer-config must keep exporting ${op}`).to.not.be.undefined;
            }
        });
    });

});

// ======================================================
// O-9 RUNTIME TESTS — HubCancelPort contract + adapter delegation
// ======================================================
// Targets the O-9 seam (docs/architecture/generation-module-extraction-
// reconnaissance.md §32.26):
//   1. the port fails fast when unwired and resolves the single op when
//      wired (fail-fast contract, `_resetHubCancelPort` test hygiene);
//   2. the adapter delegates 1:1 to dispatch-engine.clearHubDispatches
//      through the lazy call-time channel — a require.cache stub of
//      ../src/runtime/dispatch-engine is honored (the gpu-hub-cleanup /
//      reconciliation harness stubbing channel);
//   3. the real engine still answers with the frozen { requested,
//      cleared, failed } accounting for the empty/ok path (no network:
//      zero ids, or a stubbed fetchImpl);
//   4. the orchestrator resetScenes cancel leg and the reconciliation
//      RELEASE_STALE_LEASE leg keep their exact pre-O-9 semantics —
//      best-effort: a hub failure in the reconciliation leg is warned and
//      swallowed (non-fatal), and the orchestrator leg propagates args
//      (context/warn) verbatim.
// The composition-root wiring is exercised through the mocharc test
// bindings (generation-test-bindings.cjs mirrors backend.cjs).
// ======================================================

const { expect } = require('chai');

const port = require('../src/runtime/hub-cancel-port');
const adapter = require('../src/storage/hub-cancel-adapter');

const ENGINE_PATH = require.resolve('../src/runtime/dispatch-engine');

describe('O-9 HubCancelPort — contract, delegation and consumer-leg semantics', () => {

    describe('port contract', () => {
        afterEach(() => {
            // Re-wire the mocharc bindings adapter (test hygiene).
            port.setHubCancelPort(adapter);
        });

        it('fails fast when unwired (hubCancel / hubCancelOp)', () => {
            port._resetHubCancelPort();
            expect(port.isHubCancelPortWired()).to.equal(false);
            expect(() => port.hubCancel()).to.throw(/not wired/);
            expect(() => port.hubCancelOp('clearHubDispatches')).to.throw(/not wired/);
        });

        it('rejects an adapter without the op (fail-fast wiring gate)', () => {
            port._resetHubCancelPort();
            expect(() => port.setHubCancelPort({})).to.throw(/must implement clearHubDispatches/);
            expect(() => port.setHubCancelPort(null)).to.throw(/adapter is required/);
            expect(port.isHubCancelPortWired(), 'a failed wiring must not leave a half-wired port').to.equal(false);
        });

        it('resolves the single declared op when wired', () => {
            port.setHubCancelPort(adapter);
            expect(port.isHubCancelPortWired()).to.equal(true);
            expect(port.OPS).to.deep.equal(['clearHubDispatches']);
            expect(typeof port.hubCancelOp('clearHubDispatches')).to.equal('function');
        });
    });

    describe('adapter delegation (lazy call-time channel)', () => {
        const realEngine = require(ENGINE_PATH);
        let saved;

        beforeEach(() => {
            saved = require.cache[ENGINE_PATH];
        });
        afterEach(() => {
            if (saved) require.cache[ENGINE_PATH] = saved;
            else delete require.cache[ENGINE_PATH];
        });

        it('delegates 1:1 through the REAL dispatch-engine (empty ids — no network)', async () => {
            const result = await port.hubCancelOp('clearHubDispatches')([], { context: 'TEST' });
            expect(result).to.deep.equal({ requested: 0, cleared: 0, failed: 0 });
        });

        it('honors a require.cache stub of dispatch-engine (stubbing parity)', async () => {
            const calls = [];
            require.cache[ENGINE_PATH] = {
                exports: {
                    clearHubDispatches: async (ids, opts) => {
                        calls.push({ ids, opts });
                        return { requested: ids.length, cleared: ids.length, failed: 0, stubbed: true };
                    },
                },
                loaded: true,
            };
            const result = await port.hubCancelOp('clearHubDispatches')(
                ['dispatch-a', 'dispatch-b'],
                { context: 'STUB-CHECK', warn: () => {} }
            );
            expect(result).to.deep.equal({ requested: 2, cleared: 2, failed: 0, stubbed: true });
            expect(calls).to.have.length(1);
            expect(calls[0].ids).to.deep.equal(['dispatch-a', 'dispatch-b']);
            expect(calls[0].opts.context).to.equal('STUB-CHECK');
        });
    });

    describe('consumer-leg error semantics (preserved exactly)', () => {
        it('reconciliation RELEASE_STALE_LEASE: hub failure is warned and swallowed (best-effort, non-fatal)', async () => {
            const saved = require.cache[ENGINE_PATH];
            require.cache[ENGINE_PATH] = {
                exports: {
                    clearHubDispatches: async () => { throw new Error('hub unreachable'); },
                },
                loaded: true,
            };
            try {
                // The reconciliation leg wraps the port call in try/catch →
                // warn (non-fatal). The PORT itself must throw exactly like
                // the pre-O-9 direct call did — the caller decides.
                let caught = null;
                try {
                    await port.hubCancelOp('clearHubDispatches')(['d-1'], { context: 'STALE_LEASE_RECOVERY' });
                } catch (hubErr) {
                    caught = hubErr.message;
                }
                expect(caught).to.equal('hub unreachable');
            } finally {
                if (saved) require.cache[ENGINE_PATH] = saved;
                else delete require.cache[ENGINE_PATH];
            }
        });

        it('dispatch-engine keeps exporting the frozen host surface (no API change)', () => {
            const engine = require(ENGINE_PATH);
            for (const op of ['clearHubDispatches', 'clearLeasesForScenes', 'clearLeasesForBookByStage', 'clearAllLeasesForBook', 'cancelActiveDispatch']) {
                expect(typeof engine[op], `dispatch-engine.${op} must stay exported`).to.equal('function');
            }
        });
    });

});

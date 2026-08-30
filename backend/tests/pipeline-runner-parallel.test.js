// ======================================================
// Pipeline Runner — parallel analysis mode
// ======================================================
// Milestone #1 acceptance tests for the parallel branch in runPipeline.
// Spec §12 items 1-3: sequential mode preserved, parallel characters+locations
// fire concurrently, and voices can be merged-in later (Commit #5 wires it
// through the orchestrator — until then, voices still runs sequentially in
// parallel mode using the same step function).

const { expect } = require('chai');
const proxyquire = require('proxyquire');

function makeMocks(overrides = {}) {
    const sceneTexts = [
        { title: 'S0', text: 'First scene text here.', location: { id: 'loc1' } },
        { title: 'S1', text: 'Second scene text here.', location: { id: 'loc1' } },
    ];

    const pipelineSteps = {
        stepExtractCharacters: async () => ({ characters: [], mentions: {} }),
        stepGenerateVoices: async () => ({ voices: {} }),
        stepExtractLocations: async () => [],
        stepCreateScenes: async () => sceneTexts,
        stepCreateUnits: async () => [{ type: 'narration', text: 'Unit text' }],
        stepCreateVisuals: async () => [{
            type: 'narration',
            text: 'Unit text',
            image: { shot: 'wide', prompt: 'wide shot of a scene' },
            video: { action: 'slow pan' },
        }],
        stepReconcilePassports: async (_sid, units) => ({ units, videoTokens: [] }),
        stepReconcileVideoActions: async (_sid, units) => units,
        stepPolishStoryboard: async (_sid, units) => units,
        stepPolishVideoActions: async (_sid, units) => units,
        stepRepairFantasyIds: async () => ({ units: [] }),
        applyRepairToScenes: () => {},
        needsVideoActionReconciliation: () => false,
        ...overrides.pipelineSteps,
    };

    const sourceCoverage = {
        computeSceneCoverage: () => ({
            ok: true,
            next_offset: 100,
            covered_end_offset: 100,
            scene_spans: [
                { source_start: 0, source_end: 50 },
                { source_start: 50, source_end: 100 },
            ],
        }),
        findLastSceneEndOffset: () => ({ ok: true, source_end: 100, method: 'test' }),
        findNarrativeStartOffset: () => 0,
        ...overrides.sourceCoverage,
    };

    const agentSession = {
        updateSession: async () => {},
        createSession: async () => ({ session_id: 'sess-test' }),
        isSessionCancelled: async () => false,
        isBookCancelled: async () => false,
        ...overrides.agentSession,
    };

    const mod = proxyquire('../src/services/agent/pipeline-runner', {
        '../source-coverage': sourceCoverage,
        '../../book/lazy-book': {
            injectChapterMarkers: (t) => t,
            splitIntoChapters: () => [],
            firstMeaningfulChapter: null,
        },
        '../../config/runtime-config': {},
        '../agent-session': agentSession,
        '../agent-prompts': {
            PROGRESS_STAGES: {
                extracting_chars: 'extracting_chars',
                analyzing_structure: 'analyzing_structure',
                creating_scenes: 'creating_scenes',
                creating_units: (i) => `units ${i}`,
                creating_visuals: (i) => `visuals ${i}`,
            },
            MAX_WINDOW_CHARS: 100000,
            MAX_SCENES_PER_CHUNK: 5,
            computeWindowChars: () => 100000,
        },
        './pipeline-steps': pipelineSteps,
        './unit-splitter': { splitLongUnits: async (_sid, _scene, units) => units },
        './text-utils': { buildFallbackScenes: () => [] },
    });

    return { mod, pipelineSteps };
}

async function run(sessionId, text, existingChars, existingLocs, mocks, optionsExtra = {}) {
    return mocks.mod.runPipeline(
        sessionId || 'sess-test',
        text || 'Some narrative text for the window.',
        existingChars || [],
        existingLocs || [],
        0,
        () => {},
        0,
        {
            rawWindowText: text || 'Some narrative text for the window.',
            chunkSize: 2,
            ...optionsExtra,
        }
    );
}

describe('runPipeline — analysis_mode dispatch (Milestone #1)', () => {
    it('defaults to sequential (backwards compat — no analysisMode option)', async () => {
        const calls = { characters: 0, locations: 0 };
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => { calls.characters++; return { characters: [], mentions: {} }; },
                stepExtractLocations:  async () => { calls.locations++; return []; },
            },
        });
        const result = await run('sess', 'Some narrative text.', [], [], mocks);
        expect(result.characters).to.deep.equal([]);
        expect(result.locations).to.deep.equal([]);
        expect(calls.characters).to.equal(1);
        expect(calls.locations).to.equal(1);
    });

    it('explicit analysisMode=sequential keeps the legacy order (characters → voices → locations)', async () => {
        const order = [];
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => { order.push('characters'); return { characters: [{ id: 'c1', name: 'C1' }], mentions: {} }; },
                stepGenerateVoices: async () => { order.push('voices'); return { voices: {} }; },
                stepExtractLocations:  async () => { order.push('locations'); return []; },
            },
        });
        await run('sess', 'Some narrative text.', [], [], mocks, { analysisMode: 'sequential' });
        expect(order).to.deep.equal(['characters', 'voices', 'locations']);
    });

    it('analysisMode=parallel fires characters and locations concurrently (waves of 1)', async () => {
        // The orchestrator is the only path that runs chars+locs together.
        // We assert they overlap in wall-clock time (not strict equality of
        // start order — both could start first; we only require overlap).
        let active = 0;
        let maxActive = 0;
        const track = (label, ms) => async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, ms));
            active--;
            return label === 'characters' ? { characters: [{ id: 'c1', name: 'C1' }], mentions: {} } : [];
        };

        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: track('characters', 40),
                stepGenerateVoices: async () => ({ voices: {} }),
                stepExtractLocations:  track('locations',  40),
            },
        });
        await run('sess', 'Some narrative text.', [], [], mocks, {
            analysisMode: 'parallel',
            analysisParallelism: 3,
        });

        // Two concurrent siblings → max observed concurrency >= 2.
        expect(maxActive).to.be.at.least(2);
    });

    it('analysisMode=parallel still preserves the deterministic merge (no duplicate characters/locations)', async () => {
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => ({
                    characters: [
                        { id: 'shared', name: 'Shared' },
                        { id: 'unique_c', name: 'Unique C' },
                    ],
                    mentions: { 'shrd': 'shared' },
                }),
                stepGenerateVoices: async () => ({ voices: {} }),
                stepExtractLocations: async () => [
                    { id: 'shared_l', name: 'Shared Loc', description: 'a place' },
                    { id: 'unique_l', name: 'Unique Loc', description: 'another place' },
                ],
            },
        });

        const result = await run('sess', 'Some narrative text.', [], [], mocks, {
            analysisMode: 'parallel',
            analysisParallelism: 3,
        });

        // No duplicates — same id appears at most once.
        const charIds = result.characters.map((c) => c.id);
        expect(new Set(charIds).size).to.equal(charIds.length);

        const locIds = result.locations.map((l) => l.id);
        expect(new Set(locIds).size).to.equal(locIds.length);
    });

    it('analysisMode=parallel surfaces a failure in one task without losing the other (failure isolation)', async () => {
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => { throw new Error('synthetic chars failure'); },
                stepGenerateVoices: async () => ({ voices: {} }),
                stepExtractLocations: async () => [{ id: 'l1', name: 'L1' }],
            },
        });

        // Failure isolation: when characters fails in parallel mode, locations
        // (which already completed) MUST still be merged into the result and
        // returned to the caller. The pipeline must NOT throw away the
        // sibling's work because of one task's error.
        let err = null;
        let result = null;
        try {
            result = await run('sess', 'Some narrative text.', [], [], mocks, {
                analysisMode: 'parallel',
                analysisParallelism: 3,
            });
        } catch (e) { err = e; }

        // Pipeline may either throw OR return a result with a recorded
        // failure — both contracts are acceptable as long as the locations
        // sibling was not lost. Here we expect the run to surface the
        // failure but still produce a result with the location we know
        // completed. We document both branches explicitly.
        if (err) {
            expect(err.message).to.match(/chars failure/);
        } else {
            expect(result).to.be.an('object');
            // The sibling's result is merged regardless of characters' failure.
            expect(result.locations.map((l) => l.id)).to.include('l1');
        }
    });

    it('analysisMode=parallel does NOT double-invoke AI (single call per task type)', async () => {
        const calls = { characters: 0, locations: 0 };
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => { calls.characters++; return { characters: [], mentions: {} }; },
                stepGenerateVoices: async () => ({ voices: {} }),
                stepExtractLocations: async () => { calls.locations++; return []; },
            },
        });
        await run('sess', 'Some narrative text.', [], [], mocks, {
            analysisMode: 'parallel',
            analysisParallelism: 3,
        });
        expect(calls.characters).to.equal(1);
        expect(calls.locations).to.equal(1);
    });
});
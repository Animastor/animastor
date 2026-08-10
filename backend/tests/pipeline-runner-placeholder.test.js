// ======================================================
// Pipeline Runner — placeholder character guard
// ======================================================
// Regression guard for the 'unknown' character bug: when the AI extracts NO
// characters (a book whose source has no character descriptions), the pipeline
// must keep an EMPTY character set — it must NOT synthesize a fake
// { id: 'unknown', name: 'Unknown' } fallback. That placeholder previously
// leaked into characters.json and scene.participants as a phantom character.
//
// Main rule: absence of information about a person ≠ a fictitious 'unknown'
// character. An empty set is the correct answer.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

// ── Shared mocks (runPipeline only) ───────────────────────────────────

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

async function run(sessionId, text, existingChars, existingLocs, mocks) {
    return mocks.mod.runPipeline(
        sessionId || 'sess-test',
        text || 'Some narrative text for the window.',
        existingChars || [],
        existingLocs || [],
        0,
        () => {},
        0,
        { rawWindowText: text || 'Some narrative text for the window.', chunkSize: 2 }
    );
}

describe('runPipeline — placeholder character guard (no fake "unknown")', () => {
    it('keeps an EMPTY character set when nothing is extracted and nothing exists (no "unknown" fallback)', async () => {
        const mocks = makeMocks();
        const result = await run('sess', 'Some narrative text.', [], [], mocks);

        expect(result.characters).to.deep.equal([]);
        expect(result.characters.some(c => c.id === 'unknown' || c.name === 'Unknown')).to.equal(false);
        // scenes stay participant-free
        expect(result.scenes.every(s => (s.participants || []).length === 0)).to.equal(true);
    });

    it('drops a placeholder character the AI itself returned and keeps the real one', async () => {
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => ({
                    characters: [
                        { id: 'unknown', name: 'Unknown', appearance: 'Unidentified character' },
                        { id: 'anna_smirnova', name: 'Anna Smirnova', appearance: 'tall, blonde' },
                    ],
                    mentions: {},
                }),
                stepCreateScenes: async () => [{
                    title: 'S0',
                    text: 'First scene text here.',
                    location: { id: 'loc1' },
                    characters_present: ['anna_smirnova'],
                }],
            },
        });

        const result = await run('sess', 'Some narrative text.', [], [], mocks);

        expect(result.characters.map(c => c.id)).to.deep.equal(['anna_smirnova']);
        // the real character flows into scene participants as before
        expect(result.scenes[0].participants).to.deep.equal(['anna_smirnova']);
    });

    it('filters a placeholder that leaked into existing characters by older code', async () => {
        const mocks = makeMocks();
        const existing = [
            { id: 'unknown', name: 'Unknown', role: 'minor' },
            { id: 'boris_volkov', name: 'Boris Volkov', role: 'main' },
        ];
        const result = await run('sess', 'Some narrative text.', existing, [], mocks);

        expect(result.characters.map(c => c.id)).to.deep.equal(['boris_volkov']);
    });

    it('keeps a placeholder-named character that has a real appearance (mysterious stranger is a real character)', async () => {
        const mocks = makeMocks({
            pipelineSteps: {
                stepExtractCharacters: async () => ({
                    characters: [
                        { id: 'neizvestnyy', name: 'Неизвестный', appearance: 'высокий мужчина в чёрном плаще' },
                    ],
                    mentions: {},
                }),
                stepCreateScenes: async () => [{
                    title: 'S0',
                    text: 'First scene text here.',
                    location: { id: 'loc1' },
                    characters_present: ['neizvestnyy'],
                }],
            },
        });

        const result = await run('sess', 'Some narrative text.', [], [], mocks);

        expect(result.characters.map(c => c.id)).to.deep.equal(['neizvestnyy']);
        expect(result.scenes[0].participants).to.deep.equal(['neizvestnyy']);
    });
});

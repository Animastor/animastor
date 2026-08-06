const { expect } = require('chai');

// ── Duration-aware Video Action Polish ─────────────────────────────────
// stepPolishVideoActions must send each unit's estimated_duration_sec
// (the module's play time, computed with the same speech-duration heuristic
// the unit-splitter and video chunking use) so the agent can pace actions
// to plausibly fill the available time — and the prompt must carry the
// timing-realism guidance.

const { estimateSpeechDurationSec } = require('../src/services/placeholder-audio');

function unit(overrides = {}) {
    return {
        sceneIndex: 0,
        unitIndex: 0,
        sceneTitle: 'Test scene',
        sceneText: 'Scene text.',
        text: 'Unit text.',
        type: 'narration',
        image: { shot: 'wide', prompt: 'A man stands by the window in the rain' },
        video: { action: 'He turns around slowly' },
        ...overrides,
    };
}

// Build a proxyquired pipeline-steps with a stubbed AI caller + session.
function loadModule(aiCallerOverrides, sessionOverrides = {}) {
    const proxyquire = require('proxyquire');
    const calls = {
        createStep: 0,
        completeStep: 0,
        failStep: 0,
        updateSession: 0,
    };
    const session = {
        createStep: async () => { calls.createStep += 1; return { step_id: 'step-test' }; },
        completeStep: async () => { calls.completeStep += 1; },
        failStep: async () => { calls.failStep += 1; },
        updateSession: async () => { calls.updateSession += 1; },
        ...sessionOverrides,
    };
    const aiCaller = {
        callAI: async () => ({ units: [] }),
        logConversation: async () => {},
        ...aiCallerOverrides,
    };
    const mod = proxyquire('../src/services/agent/pipeline-steps', {
        './ai-caller': aiCaller,
        '../agent-session': session,
    });
    return { mod, calls, aiCaller };
}

describe('stepPolishVideoActions (duration-aware polish)', () => {
    it('sends estimated_duration_sec for every unit, matching the speech-duration heuristic', async () => {
        let sentUser = '';
        const { mod } = loadModule({
            callAI: async (messages) => {
                sentUser = messages[1].content;
                return { units: [] };
            },
        });

        const text0 = 'One two three four five.';
        const text1 = 'A much longer unit text with many words across the line.';
        const input = [
            unit({ sceneIndex: 0, unitIndex: 0, text: text0 }),
            unit({ sceneIndex: 0, unitIndex: 1, text: text1 }),
        ];

        await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(sentUser).to.include(`"estimated_duration_sec":${estimateSpeechDurationSec(text0)}`);
        expect(sentUser).to.include(`"estimated_duration_sec":${estimateSpeechDurationSec(text1)}`);
    });

    it('floors the duration at 2s for empty/whitespace text', async () => {
        let sentUser = '';
        const { mod } = loadModule({
            callAI: async (messages) => {
                sentUser = messages[1].content;
                return { units: [] };
            },
        });

        const input = [
            unit({ sceneIndex: 0, unitIndex: 0, text: '   ' }),
            unit({ sceneIndex: 0, unitIndex: 1, text: 'One two three.' }),
        ];

        await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(sentUser).to.include('"estimated_duration_sec":2'); // heuristic min
        expect(sentUser).to.include(`"estimated_duration_sec":${estimateSpeechDurationSec('One two three.')}`);
    });

    it('includes the timing-realism guidance in the system prompt', async () => {
        let sentSystem = '';
        const { mod } = loadModule({
            callAI: async (messages) => {
                sentSystem = messages[0].content;
                return { units: [] };
            },
        });

        const input = [
            unit({ sceneIndex: 0, unitIndex: 0, text: 'One two three four five.' }),
            unit({ sceneIndex: 0, unitIndex: 1, text: 'One two three four five six seven eight.' }),
        ];

        await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(sentSystem).to.include('Timing realism');
        expect(sentSystem).to.include('estimated_duration_sec');
        expect(sentSystem).to.include('per-second choreography');
        // long modules must get a sequence, short modules must stay minimal
        expect(sentSystem).to.include('Long module');
        expect(sentSystem).to.include('Short module');
    });

    it('applies the polished action back to the returned units only', async () => {
        const { mod } = loadModule({
            callAI: async () => ({
                units: [
                    { scene_index: 0, unit_index: 0, video: { action: 'He raises his hand, pauses, then lowers it slowly' } },
                ],
            }),
        });

        const input = [
            unit({ sceneIndex: 0, unitIndex: 0 }),
            unit({ sceneIndex: 0, unitIndex: 1, video: { action: 'She stands still, breathing' } }),
        ];

        const result = await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(result[0].video.action).to.equal('He raises his hand, pauses, then lowers it slowly');
        expect(result[1].video.action).to.equal('She stands still, breathing'); // not returned — untouched
    });

    it('keeps original units when the AI call fails', async () => {
        const { mod, calls } = loadModule({
            callAI: async () => { throw new Error('LLM down'); },
        });

        const input = [
            unit({ sceneIndex: 0, unitIndex: 0 }),
            unit({ sceneIndex: 0, unitIndex: 1 }),
        ];

        const result = await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(result).to.equal(input); // untouched
        expect(result[0].video.action).to.equal('He turns around slowly');
        expect(calls.failStep).to.equal(1);
    });

    it('skips entirely (no AI call, no step row) when fewer than 2 units', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const input = [unit({ sceneIndex: 0, unitIndex: 0 })];
        const result = await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(aiCalled).to.equal(0);
        expect(calls.createStep).to.equal(0);
        // updateSession fires once for the progress message before the skip check
        expect(calls.updateSession).to.equal(1);
        expect(result).to.equal(input);
    });

    it('excludes out-of-format actions (> max chars) from the request', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const longAction = unit({ sceneIndex: 0, unitIndex: 0, video: { action: 'X'.repeat(2500) } });
        const input = [
            longAction,
            unit({ sceneIndex: 0, unitIndex: 1 }),
            unit({ sceneIndex: 0, unitIndex: 2 }),
        ];

        const result = await mod.stepPolishVideoActions('sess', input, [], [], 0, () => {});

        expect(aiCalled).to.equal(1); // only the two in-format units are sent
        expect(result[0].video.action).to.equal('X'.repeat(2500)); // never overwritten
    });
});

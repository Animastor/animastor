const { expect } = require('chai');

// ── Static-copy detection: a unit whose video.action is (nearly) a verbatim
// copy of image.prompt must go through Video Reconciliation. Actions that the
// visuals agent wrote independently (distinct text) must never be touched.

function unit(overrides = {}) {
    return {
        sceneIndex: 0,
        unitIndex: 0,
        sceneTitle: 'Test scene',
        sceneText: 'Scene text.',
        text: 'Unit text.',
        type: 'narration',
        image: { shot: 'wide', prompt: 'A man stands by the window in the rain' },
        video: { action: 'A man stands by the window in the rain' },
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

describe('isStaticActionCopy', () => {
    it('detects an exact verbatim copy', () => {
        const { mod } = loadModule({});
        expect(mod.isStaticActionCopy(
            'A man stands by the window in the rain',
            'A man stands by the window in the rain',
        )).to.equal(true);
    });

    it('detects copies differing only in case/punctuation', () => {
        const { mod } = loadModule({});
        expect(mod.isStaticActionCopy(
            'A man stands by the window in the rain.',
            'a man stands by the window in the rain',
        )).to.equal(true);
    });

    it('detects a copy that is the prompt plus extra wording (containment)', () => {
        const { mod } = loadModule({});
        expect(mod.isStaticActionCopy(
            'mikhail_berlioz and ivan_ponyrev sitting on a bench, golden sunset',
            'mikhail_berlioz and ivan_ponyrev sitting on a bench, golden sunset, ivan_ponyrev leans forward',
        )).to.equal(true);
    });

    it('treats a substantially reworded action as an independent agent result', () => {
        const { mod } = loadModule({});
        expect(mod.isStaticActionCopy(
            'Two men at a table, candlelight, dark room',
            'He raises his glass slowly and sets it down',
        )).to.equal(false);
    });

    it('returns false for empty inputs', () => {
        const { mod } = loadModule({});
        expect(mod.isStaticActionCopy('', 'something')).to.equal(false);
        expect(mod.isStaticActionCopy('something', '')).to.equal(false);
        expect(mod.isStaticActionCopy(null, null)).to.equal(false);
    });
});

describe('needsVideoActionReconciliation', () => {
    it('is true for an exact copy of image.prompt', () => {
        const { mod } = loadModule({});
        expect(mod.needsVideoActionReconciliation(unit())).to.equal(true);
    });

    it('is true for an empty video.action', () => {
        const { mod } = loadModule({});
        expect(mod.needsVideoActionReconciliation(unit({ video: {} }))).to.equal(true);
        expect(mod.needsVideoActionReconciliation(unit({ video: { action: '   ' } }))).to.equal(true);
    });

    it('is false for an agent-authored action distinct from the prompt', () => {
        const { mod } = loadModule({});
        const u = unit({ video: { action: 'He turns around slowly' } });
        expect(mod.needsVideoActionReconciliation(u)).to.equal(false);
    });
});

describe('stepReconcileVideoActions (targeted reconciliation)', () => {
    it('sends only static-copy units to the AI and never overwrites agent-authored actions', async () => {
        let aiCalled = 0;
        let sentMessage = '';
        const { mod, calls } = loadModule({
            callAI: async (messages) => {
                aiCalled += 1;
                sentMessage = messages[1].content;
                return {
                    units: [
                        // legit fix for the copy unit
                        { scene_index: 0, unit_index: 0, video: { action: 'He turns to the window, rain streaking the glass' } },
                        // hallucinated unit for the agent-authored one — must be ignored
                        { scene_index: 0, unit_index: 1, video: { action: 'HALLUCINATED OVERWRITE' } },
                    ],
                };
            },
        });

        const copyUnit = unit({ sceneIndex: 0, unitIndex: 0 });
        const authoredUnit = unit({
            sceneIndex: 0,
            unitIndex: 1,
            image: { shot: 'medium', prompt: 'Two people at a table, candlelight' },
            video: { action: 'He raises his glass slowly' },
        });
        const input = [copyUnit, authoredUnit];

        const result = await mod.stepReconcileVideoActions('sess', input, [], 0, () => {});

        expect(aiCalled).to.equal(1);
        // the copy unit is in the request
        expect(sentMessage).to.include('A man stands by the window in the rain');
        // the agent-authored action/prompt is NOT in the request
        expect(sentMessage).to.not.include('He raises his glass slowly');
        expect(sentMessage).to.not.include('Two people at a table');
        // the copy unit got fixed
        expect(result[0].video.action).to.equal('He turns to the window, rain streaking the glass');
        // the agent-authored unit is untouched (not even the hallucinated value)
        expect(result[1].video.action).to.equal('He raises his glass slowly');
        expect(calls.createStep).to.equal(1);
        expect(calls.completeStep).to.equal(1);
    });

    it('skips entirely (no AI call, no step row) when every action is agent-authored', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const authoredUnit = unit({
            image: { shot: 'medium', prompt: 'Two people at a table, candlelight' },
            video: { action: 'He raises his glass slowly' },
        });
        const input = [authoredUnit];

        const result = await mod.stepReconcileVideoActions('sess', input, [], 0, () => {});

        expect(aiCalled).to.equal(0);
        expect(calls.createStep).to.equal(0);
        expect(calls.updateSession).to.equal(0);
        expect(result).to.equal(input); // same array reference, untouched
        expect(result[0].video.action).to.equal('He raises his glass slowly');
    });

    it('generates an action for an empty video.action', async () => {
        let aiCalled = 0;
        const { mod } = loadModule({
            callAI: async (messages) => {
                aiCalled += 1;
                expect(messages[1].content).to.include('Unit text.');
                return { units: [{ scene_index: 0, unit_index: 0, video: { action: 'Slow pan across the quiet room' } }] };
            },
        });

        const emptyUnit = unit({ video: {} });
        const result = await mod.stepReconcileVideoActions('sess', [emptyUnit], [], 0, () => {});

        expect(aiCalled).to.equal(1);
        expect(result[0].video.action).to.equal('Slow pan across the quiet room');
    });

    it('keeps originals and completes when AI returns no units for sent candidates', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const copyUnit = unit();
        const result = await mod.stepReconcileVideoActions('sess', [copyUnit], [], 0, () => {});

        expect(aiCalled).to.equal(1);
        expect(result[0].video.action).to.equal('A man stands by the window in the rain'); // untouched
        expect(calls.completeStep).to.equal(1);
    });

    it('keeps original units when the AI call fails', async () => {
        const { mod, calls } = loadModule({
            callAI: async () => { throw new Error('LLM down'); },
        });

        const copyUnit = unit();
        const input = [copyUnit];

        const result = await mod.stepReconcileVideoActions('sess', input, [], 0, () => {});

        expect(result).to.equal(input); // untouched
        expect(result[0].video.action).to.equal('A man stands by the window in the rain');
        expect(calls.failStep).to.equal(1);
    });

    it('excludes out-of-format actions (> max chars) from the candidates', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const longCopy = unit({ video: { action: 'X'.repeat(2500) } });
        const result = await mod.stepReconcileVideoActions('sess', [longCopy], [], 0, () => {});

        expect(aiCalled).to.equal(0);
        expect(calls.createStep).to.equal(0);
        expect(result[0].video.action).to.equal('X'.repeat(2500)); // never overwritten
    });
});

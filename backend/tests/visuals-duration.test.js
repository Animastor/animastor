const { expect } = require('chai');

// ── Duration-aware visuals generation ─────────────────────────────────
// stepCreateVisuals must show each unit's approximate play time
// (estimated_duration_sec, speech-duration heuristic) so video.action is
// written with the module's duration in mind from the very first pass.

const { estimateSpeechDurationSec } = require('../src/services/placeholder-audio');

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

function scene() {
    return {
        title: 'Evening at the pond',
        type: 'narration',
        location: { id: 'patriarch_ponds' },
        participants: [],
    };
}

describe('stepCreateVisuals (duration-aware input)', () => {
    it('sends estimated_duration_sec in every unit line', async () => {
        let sentUser = '';
        const { mod } = loadModule({
            callAI: async (messages) => {
                sentUser = messages[1].content;
                return { units: [] };
            },
        });

        const text0 = 'One two three.';
        const text1 = 'A longer unit text with many words across the line.';
        const units = [
            { text: text0, type: 'narration' },
            { text: text1, type: 'dialogue' },
        ];

        await mod.stepCreateVisuals('sess', scene(), units, 0, [], [], 0, () => {}, null, {}, {});

        expect(sentUser).to.include(
            `Unit 1: text="${text0}", type="narration", estimated_duration_sec=${estimateSpeechDurationSec(text0)}`
        );
        expect(sentUser).to.include(
            `Unit 2: text="${text1}", type="dialogue", estimated_duration_sec=${estimateSpeechDurationSec(text1)}`
        );
    });

    it('includes the soft timing guidance in the system prompt', async () => {
        let sentSystem = '';
        const { mod } = loadModule({
            callAI: async (messages) => {
                sentSystem = messages[0].content;
                return { units: [] };
            },
        });

        await mod.stepCreateVisuals('sess', scene(), [
            { text: 'One two three.', type: 'narration' },
        ], 0, [], [], 0, () => {}, null, {}, {});

        expect(sentSystem).to.include('estimated_duration_sec');
        expect(sentSystem).to.include('Align the motion with it');
    });
});

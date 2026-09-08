// ======================================================
// CHARACTER ANALYZER — C20 contract behavior tests
// ======================================================
// Pins the runtime behavior of the extracted module
// (docs/architecture/character-analyzer-extraction-c20.md) against the
// pre-extraction behavior of pipeline-steps.stepExtractCharacters /
// stepGenerateVoices. No prompt, merge, or fallback semantics change.
//
// Covers: happy path, empty AI payload, malformed AI response, transport
// failure (fallback/throw contract), port fail-closed, voice write-back
// rules (no overwrite, placeholder skip), skill injection.

const { expect } = require('chai');
const { extractCharacters, generateVoices } = require('../src/services/character-analyzer');

function makePorts(callAIResult, overrides = {}) {
    const calls = { log: 0, complete: 0, fail: 0, update: 0, create: 0 };
    const ports = {
        callAI: async () => callAIResult,
        logConversation: async () => { calls.log++; },
        updateSession: async () => { calls.update++; },
        createStep: async () => { calls.create++; return { step_id: 'step-1' }; },
        completeStep: async () => { calls.complete++; },
        failStep: async () => { calls.fail++; },
        extractingCharactersMessage: '⟳ Извлекаю персонажей...',
        voiceGenerationMessage: '⟳ Подбираю голоса для персонажей...',
        prompt: (name) => `PROMPT:${name}`,
        fillLang: (t, lang) => `${t}[${lang}]`,
        buildSkill: () => null,
        ...overrides.ports,
    };
    return { ports, calls };
}

const baseInput = {
    windowText: 'Window text with characters.',
    language: 'ru',
    sessionId: 'sess-c20',
    stepIndex: 3,
    progress: () => {},
};

describe('C20 character-analyzer: extractCharacters contract', () => {
    it('returns { characters, mentions } and completes the step on a well-formed response', async () => {
        const ai = { characters: [{ id: 'anna_smirnova', name: 'Anna', appearance: 'tall' }], mentions: { editor: 'anna_smirnova' } };
        const { ports, calls } = makePorts(ai);
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal(ai);
        expect(calls.complete).to.equal(1);
        expect(calls.fail).to.equal(0);
        expect(calls.log).to.equal(1);
    });

    it('normalizes a partial response: missing fields → empty containers', async () => {
        const { ports, calls } = makePorts({});
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal({ characters: [], mentions: {} });
        expect(calls.complete).to.equal(1);
    });

    it('normalizes a malformed response: non-object JSON → empty containers (no throw)', async () => {
        const { ports } = makePorts('not-an-object');
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal({ characters: [], mentions: {} });
    });

    it('builds the localized characters prompt + window text verbatim', async () => {
        let seen = null;
        const { ports } = makePorts({ characters: [], mentions: {} }, {
            ports: { callAI: async (messages) => { seen = messages; return { characters: [], mentions: {} }; } },
        });
        await extractCharacters(baseInput, ports);
        expect(seen[0].content).to.equal('PROMPT:characters[ru]');
        expect(seen[1].content).to.include(baseInput.windowText);
    });

    it('fails closed when host ports are missing', async () => {
        await extractCharacters(baseInput, {}).then(
            () => { throw new Error('must not resolve'); },
            (err) => expect(err.message).to.match(/character-analyzer: missing host port/)
        );
    });

    it('on AI failure: failStep + rethrow (runner keeps existing set — degradation is host-owned)', async () => {
        const { ports, calls } = makePorts(null, {
            ports: { callAI: async () => { throw new Error('transport down'); } },
        });
        await extractCharacters(baseInput, ports).then(
            () => { throw new Error('must not resolve'); },
            (err) => {
                expect(err.message).to.equal('transport down');
                expect(calls.fail).to.equal(1);
                expect(calls.complete).to.equal(0);
            }
        );
    });
});

describe('C20 character-analyzer: generateVoices contract (F7)', () => {
    const realChar = (over = {}) => ({
        id: 'anna_smirnova', name: 'Anna', role: 'protagonist',
        description: 'editor', appearance: 'tall, gray eyes', traits: ['sharp'],
        ...over,
    });

    it('writes voice instructions into characters[i].voice in place', async () => {
        const ch = realChar();
        const { ports, calls } = makePorts({ voices: { anna_smirnova: { instruction: 'Warm low voice.' } } });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: { anna_smirnova: { instruction: 'Warm low voice.' } } });
        expect(ch.voice).to.equal('Warm low voice.');
        expect(calls.complete).to.equal(1);
    });

    it('never overwrites an existing meaningful voice', async () => {
        const ch = realChar({ voice: 'An already crafted, detailed voice instruction for TTS' });
        const { ports } = makePorts({ voices: { anna_smirnova: { instruction: 'NEW VOICE' } } });
        await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(ch.voice).to.equal('An already crafted, detailed voice instruction for TTS');
    });

    it('skips a dialogue-only participant without described appearance (no voice invented)', async () => {
        const phantom = { id: 'unknown', name: 'unknown' };
        const { ports } = makePorts({ voices: { unknown: { instruction: 'X' } } });
        const out = await generateVoices({ ...baseInput, characters: [phantom], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: {} });
        expect(phantom.voice).to.equal(undefined);
    });

    it('injects the audio skill section ahead of the prompt when a profile is configured', async () => {
        let seen = null;
        const { ports } = makePorts({ voices: {} }, {
            ports: {
                buildSkill: (domain, profile) => (domain === 'audio' && profile === 'qwen-tts' ? 'SKILL:audio' : null),
                callAI: async (messages) => { seen = messages; return { voices: {} }; },
            },
        });
        await generateVoices({ ...baseInput, characters: [realChar()], promptProfiles: { audioProfile: 'qwen-tts' } }, ports);
        expect(seen[0].content.startsWith('SKILL:audio')).to.equal(true);
    });

    it('on AI failure: failStep + warn, returns { voices: {} } and keeps existing voices', async () => {
        const ch = realChar({ voice: 'weak' }); // short voice → needs generation, reaches the AI call
        const { ports, calls } = makePorts(null, {
            ports: { callAI: async () => { throw new Error('transport down'); } },
        });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: {} });
        expect(ch.voice).to.equal('weak');
        expect(calls.fail).to.equal(1);
    });

    it('fails closed when host ports are missing', async () => {
        await generateVoices({ ...baseInput, characters: [realChar()], promptProfiles: {} }, {}).then(
            () => { throw new Error('must not resolve'); },
            (err) => expect(err.message).to.match(/character-analyzer: missing host port/)
        );
    });
});

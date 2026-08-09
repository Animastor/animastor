const { expect } = require('chai');
const snakeGuard = require('../src/utils/snake-guard');
const {
    findUnverifiedSnakeTokens,
    isFantasySnakeToken,
    sanitizeParticipants,
    findCanonicalId,
    canonicalizeText,
    canonicalizeMixedScriptId,
} = snakeGuard;

// ── Pure detection (src/utils/snake-guard.js) ──────────────────────────

describe('snake-guard — fantasy snake_case id detection', () => {
    const knownIds = ['anna_smirnova', 'boris_volkov', 'city_park'];

    it('flags an invented snake id (zhenshchina_v_budochke)', () => {
        const tokens = findUnverifiedSnakeTokens('zhenshchina_v_budochke hands over the water', knownIds);
        expect(tokens).to.deep.equal(['zhenshchina_v_budochke']);
    });

    it('flags possessive forms of invented ids', () => {
        expect(findUnverifiedSnakeTokens("zhenshchina_v_budochke's hands", knownIds))
            .to.deep.equal(['zhenshchina_v_budochke']);
    });

    it('flags uppercase-mangled invented ids', () => {
        expect(findUnverifiedSnakeTokens('Woman_in_Kiosk enters', knownIds))
            .to.deep.equal(['Woman_in_Kiosk']);
    });

    it('keeps known character and location ids', () => {
        expect(findUnverifiedSnakeTokens('anna_smirnova and boris_volkov at city_park', knownIds))
            .to.deep.equal([]);
    });

    it('ignores whitelisted technical/visual tokens (close_up, park_bench)', () => {
        expect(findUnverifiedSnakeTokens('close_up of park_bench in soft_light', knownIds))
            .to.deep.equal([]);
    });

    it('never false-positives on plain words (he / the alley)', () => {
        expect(findUnverifiedSnakeTokens('they walk along the alley, he turns, heat rises', knownIds))
            .to.deep.equal([]);
    });

    it('flags chimeras (prefix-variants of real ids) as unverified — they are auto-fixed later', () => {
        expect(findUnverifiedSnakeTokens('mikhail_berlio gestures', ['mikhail_berlioz']))
            .to.deep.equal(['mikhail_berlio']);
        expect(findUnverifiedSnakeTokens('anna_smirnova_extra arrives', knownIds))
            .to.deep.equal(['anna_smirnova_extra']);
    });

    it('dedupes repeated tokens', () => {
        expect(findUnverifiedSnakeTokens('a_b sits, c_d stands, a_b moves', knownIds))
            .to.deep.equal(['a_b', 'c_d']);
    });

    it('handles empty/null input', () => {
        expect(findUnverifiedSnakeTokens('', knownIds)).to.deep.equal([]);
        expect(findUnverifiedSnakeTokens(null, knownIds)).to.deep.equal([]);
    });

    it('isFantasySnakeToken single-value check', () => {
        expect(isFantasySnakeToken('zhenshchina_v_budochke', knownIds)).to.equal(true);
        expect(isFantasySnakeToken('anna_smirnova', knownIds)).to.equal(false);
        expect(isFantasySnakeToken('женщина в будочке', knownIds)).to.equal(false);
        expect(isFantasySnakeToken('', knownIds)).to.equal(false);
    });

    it('sanitizeParticipants keeps known ids + natural designations, drops fantasy', () => {
        const out = sanitizeParticipants(
            ['anna_smirnova', 'женщина в будочке', 'zhenshchina_v_budochke'],
            knownIds
        );
        expect(out).to.deep.equal(['anna_smirnova', 'женщина в будочке']);
    });

    it('sanitizeParticipants reports dropped values via onDrop', () => {
        const dropped = [];
        const out = sanitizeParticipants(
            ['zhenshchina_v_budochke', 'anna_smirnova'],
            knownIds,
            { onDrop: (p) => dropped.push(p) }
        );
        expect(out).to.deep.equal(['anna_smirnova']);
        expect(dropped).to.deep.equal(['zhenshchina_v_budochke']);
    });

    it('sanitizeParticipants replaces chimeras via onReplace and drops fantasy via onDrop', () => {
        const replaced = [];
        const dropped = [];
        const out = sanitizeParticipants(
            ['anna_smirnova', 'zhenshchina_v_budochke', 'mikhail_berлиоз', 'женщина в будочке'],
            ['anna_smirnova', 'mikhail_berlioz'],
            { onReplace: (f, t) => replaced.push([f, t]), onDrop: (p) => dropped.push(p) }
        );
        expect(out).to.deep.equal(['anna_smirnova', 'mikhail_berlioz', 'женщина в будочке']);
        expect(replaced).to.deep.equal([['mikhail_berлиоз', 'mikhail_berlioz']]);
        expect(dropped).to.deep.equal(['zhenshchina_v_budochke']);
    });
});

describe('findCanonicalId — chimera resolution', () => {
    it('resolves mixed-script ids (mikhail_berлиоз → mikhail_berlioz)', () => {
        expect(findCanonicalId('mikhail_berлиоз', ['mikhail_berlioz'])).to.equal('mikhail_berlioz');
    });

    it('resolves trailing-underscore ids (mihail_bulgakov_ → mihail_bulgakov)', () => {
        expect(findCanonicalId('mihail_bulgakov_', ['mihail_bulgakov'])).to.equal('mihail_bulgakov');
    });

    it('resolves y/iy transliteration variants (mihail_bulgakoviy → mihail_bulgakov)', () => {
        expect(findCanonicalId('mihail_bulgakoviy', ['mihail_bulgakov'])).to.equal('mihail_bulgakov');
    });

    it('resolves 1-2 char typos (ivan_ponerov → ivan_ponyrev)', () => {
        expect(findCanonicalId('ivan_ponerov', ['ivan_ponyrev'])).to.equal('ivan_ponyrev');
    });

    it('resolves noise-suffix ids (anna_smirnova_extra → anna_smirnova)', () => {
        expect(findCanonicalId('anna_smirnova_extra', ['anna_smirnova'])).to.equal('anna_smirnova');
    });

    it('returns null when there is no confident match (true fantasy)', () => {
        expect(findCanonicalId('zhenshchina_v_budochke', ['anna_smirnova', 'boris_volkov'])).to.equal(null);
    });

    it('returns null on ambiguous equidistant candidates', () => {
        expect(findCanonicalId('mihail_bulgakovv', ['mihail_bulgakov', 'mihail_bulgakova'])).to.equal(null);
    });
});

describe('canonicalizeText / canonicalizeMixedScriptId', () => {
    it('aligns chimera tokens and preserves possessives', () => {
        expect(canonicalizeText("mikhail_berлиоз's glasses", ['mikhail_berlioz']))
            .to.equal("mikhail_berlioz's glasses");
        expect(canonicalizeText('ivan_ponerov arrives', ['ivan_ponyrev']))
            .to.equal('ivan_ponyrev arrives');
    });

    it('leaves known ids, whitelist and natural text untouched', () => {
        expect(canonicalizeText('anna_smirnova sits on a park bench, close_up', ['anna_smirnova', 'boris_volkov']))
            .to.equal('anna_smirnova sits on a park bench, close_up');
        expect(canonicalizeText('they walk along the alley', ['anna_smirnova']))
            .to.equal('they walk along the alley');
        expect(canonicalizeText(null, ['anna_smirnova'])).to.equal(null);
    });

    it('canonicalizeMixedScriptId normalizes mixed ids but keeps pure ones', () => {
        expect(canonicalizeMixedScriptId('patriarshie_pруды')).to.equal('patriarshie_prudy');
        expect(canonicalizeMixedScriptId('kiosk_at_patriarshie_pруды')).to.equal('kiosk_at_patriarshie_prudy');
        expect(canonicalizeMixedScriptId('city_park')).to.equal('city_park');
        expect(canonicalizeMixedScriptId('патриаршие_пруды')).to.equal('патриаршие_пруды');
    });
});

// ── stepRepairFantasyIds (hybrid: deterministic scan + LLM reassembly) ─

function unit(overrides = {}) {
    return {
        sceneIndex: 0,
        unitIndex: 0,
        sceneTitle: 'Kiosk scene',
        sceneText: '— Дайте воды, — попросила женщина в будочке.',
        text: '— Дайте воды, — попросила женщина в будочке.',
        type: 'dialogue',
        image: { shot: 'medium', prompt: 'zhenshchina_v_budochke hands a glass of water' },
        video: { action: 'zhenshchina_v_budochke turns away' },
        ...overrides,
    };
}

const CHARACTERS = [
    { id: 'anna_smirnova', name: 'Anna Smirnova' },
    { id: 'boris_volkov', name: 'Boris Volkov' },
];
const LOCATIONS = [{ id: 'city_park', name: 'City Park' }];

function loadModule(aiCallerOverrides, sessionOverrides = {}) {
    const proxyquire = require('proxyquire');
    const calls = { createStep: 0, completeStep: 0, failStep: 0, updateSession: 0 };
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

describe('stepRepairFantasyIds (hybrid snake repair)', () => {
    it('reassembles a unit whose prompt/action reference a fantasy id', async () => {
        let aiCalled = 0;
        let sentMessage = '';
        let systemMessage = '';
        const { mod, calls } = loadModule({
            callAI: async (messages) => {
                aiCalled += 1;
                sentMessage = messages[1].content;
                systemMessage = messages[0].content;
                return {
                    units: [{
                        scene_index: 0,
                        unit_index: 0,
                        image: { prompt: 'the kiosk saleswoman hands a glass of water' },
                        video: { action: 'the kiosk saleswoman turns away' },
                    }],
                };
            },
        });

        const input = [unit()];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(aiCalled).to.equal(1);
        // user message carries the flagged token + the source text (natural designation)
        expect(sentMessage).to.include('zhenshchina_v_budochke');
        expect(sentMessage).to.include('женщина в будочке');
        // system message carries the known ids the agent may use
        expect(systemMessage).to.include('anna_smirnova');
        expect(systemMessage).to.include('city_park');
        // the prompt is reassembled with the natural designation, not an id
        expect(result[0].image.prompt).to.equal('the kiosk saleswoman hands a glass of water');
        expect(result[0].video.action).to.equal('the kiosk saleswoman turns away');
        expect(calls.createStep).to.equal(1);
        expect(calls.completeStep).to.equal(1);
    });

    it('skips entirely (no AI call, no step row) when nothing is flagged', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });

        const clean = unit({
            image: { shot: 'medium', prompt: 'anna_smirnova and boris_volkov sitting on a park bench' },
            video: { action: 'boris_volkov leans forward' },
        });
        const input = [clean];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(aiCalled).to.equal(0);
        expect(calls.createStep).to.equal(0);
        expect(calls.updateSession).to.equal(0);
        expect(result).to.equal(input);
    });

    it('rejects a repair that STILL contains an unverified id — keeps the original', async () => {
        const { mod, calls } = loadModule({
            callAI: async () => ({
                units: [{
                    scene_index: 0,
                    unit_index: 0,
                    image: { prompt: 'zhenshchina_v_budochke stands by the booth' },
                }],
            }),
        });

        const input = [unit()];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(result[0].image.prompt).to.equal('zhenshchina_v_budochke hands a glass of water'); // original kept
        expect(result[0].video.action).to.equal('zhenshchina_v_budochke turns away');
        expect(calls.completeStep).to.equal(1);
    });

    it('keeps originals when the AI call fails', async () => {
        const { mod, calls } = loadModule({
            callAI: async () => { throw new Error('LLM down'); },
        });

        const input = [unit()];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(result).to.equal(input);
        expect(result[0].image.prompt).to.equal('zhenshchina_v_budochke hands a glass of water');
        expect(calls.failStep).to.equal(1);
    });

    it('never touches unflagged units, even when the agent hallucinates rows for them', async () => {
        const { mod } = loadModule({
            callAI: async () => ({
                units: [
                    // complete fix for the flagged unit (both fields — otherwise the
                    // whole-unit residual scan would revert it as a partial fix)
                    {
                        scene_index: 0,
                        unit_index: 0,
                        image: { prompt: 'the kiosk saleswoman hands a glass of water' },
                        video: { action: 'the kiosk saleswoman turns away' },
                    },
                    // hallucinated overwrite for the CLEAN unit — must be ignored
                    { scene_index: 0, unit_index: 1, image: { prompt: 'HALLUCINATED OVERWRITE' } },
                ],
            }),
        });

        const flagged = unit({ sceneIndex: 0, unitIndex: 0 });
        const clean = unit({
            sceneIndex: 0,
            unitIndex: 1,
            image: { shot: 'wide', prompt: 'boris_volkov reading a newspaper' },
            video: { action: 'boris_volkov turns a page' },
        });
        const input = [flagged, clean];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(result[0].image.prompt).to.equal('the kiosk saleswoman hands a glass of water');
        expect(result[0].video.action).to.equal('the kiosk saleswoman turns away');
        expect(result[1].image.prompt).to.equal('boris_volkov reading a newspaper');
        expect(result[1].video.action).to.equal('boris_volkov turns a page');
    });

    it('auto-canonicalizes chimera ids deterministically (no LLM call)', async () => {
        let aiCalled = 0;
        const { mod, calls } = loadModule({
            callAI: async () => { aiCalled += 1; return { units: [] }; },
        });
        const chars = CHARACTERS.concat([{ id: 'mikhail_berlioz', name: 'Mikhail Berlioz' }]);
        const input = [unit({
            image: { shot: 'medium', prompt: 'mikhail_berлиоз raises his hand' },
            video: { action: 'mikhail_berлиоз waves' },
        })];
        const result = await mod.stepRepairFantasyIds('sess', input, chars, LOCATIONS, 0, () => {});

        expect(aiCalled).to.equal(0);
        expect(calls.createStep).to.equal(0);
        expect(result[0].image.prompt).to.equal('mikhail_berlioz raises his hand');
        expect(result[0].video.action).to.equal('mikhail_berlioz waves');
    });

    it('canonicalizeVisualUnit fixes prompt/action/speaker chimeras in range', () => {
        const { mod } = loadModule({});
        const u = unit({
            image: { shot: 'medium', prompt: 'mikhail_berлиоз raises his hand' },
            video: { action: 'mikhail_berлиоз waves' },
            audio: { speaker: 'mikhail_berлиоз' },
        });
        const { unit: out, changed } = mod.canonicalizeVisualUnit(u, ['mikhail_berlioz', 'city_park']);
        expect(changed).to.equal(true);
        expect(out.image.prompt).to.equal('mikhail_berlioz raises his hand');
        expect(out.video.action).to.equal('mikhail_berlioz waves');
        expect(out.audio.speaker).to.equal('mikhail_berlioz');
    });

    it('fixes a fantasy audio.speaker id alongside the prompt', async () => {
        const { mod } = loadModule({
            callAI: async () => ({
                units: [{
                    scene_index: 0,
                    unit_index: 0,
                    image: { prompt: 'the kiosk saleswoman hands a glass of water' },
                    video: { action: 'the kiosk saleswoman turns away' },
                    audio: { speaker: 'the kiosk saleswoman' },
                }],
            }),
        });

        const input = [unit({ audio: { speaker: 'zhenshchina_v_budochke' } })];
        const result = await mod.stepRepairFantasyIds('sess', input, CHARACTERS, LOCATIONS, 0, () => {});

        expect(result[0].audio.speaker).to.equal('the kiosk saleswoman');
        expect(result[0].image.prompt).to.equal('the kiosk saleswoman hands a glass of water');
    });

    it('mergeRepairResults applies a complete fix (prompt + action)', () => {
        const { mod } = loadModule({});
        const input = [unit()];
        const flagged = [{ unit: input[0], tokens: ['zhenshchina_v_budochke'] }];
        const repaired = [{
            scene_index: 0,
            unit_index: 0,
            image: { prompt: 'the kiosk saleswoman hands a glass of water' },
            video: { action: 'the kiosk saleswoman turns away' },
        }];
        const { units, changed, stillBad } = mod.mergeRepairResults(
            input, flagged, repaired, CHARACTERS, ['anna_smirnova', 'boris_volkov', 'city_park']
        );
        expect(changed).to.equal(1);
        expect(stillBad).to.equal(0);
        expect(units[0].image.prompt).to.equal('the kiosk saleswoman hands a glass of water');
        expect(units[0].video.action).to.equal('the kiosk saleswoman turns away');
    });

    it('mergeRepairResults REVERTS a partial fix (residual id remains in the other field)', () => {
        const { mod } = loadModule({});
        const input = [unit()];
        const flagged = [{ unit: input[0], tokens: ['zhenshchina_v_budochke'] }];
        // agent fixed ONLY the prompt — the action still carries the fantasy id
        const repaired = [{
            scene_index: 0,
            unit_index: 0,
            image: { prompt: 'the kiosk saleswoman hands a glass of water' },
        }];
        const { units, changed, stillBad } = mod.mergeRepairResults(
            input, flagged, repaired, CHARACTERS, ['anna_smirnova', 'boris_volkov', 'city_park']
        );
        expect(changed).to.equal(0);
        expect(stillBad).to.equal(1);
        // the whole unit is reverted — nothing partially-fixed reaches the book
        expect(units[0].image.prompt).to.equal('zhenshchina_v_budochke hands a glass of water');
        expect(units[0].video.action).to.equal('zhenshchina_v_budochke turns away');
    });

    it('applyRepairToScenes writes image, video AND audio.speaker back into scenes', () => {
        const { mod } = loadModule({});
        const scenes = [{
            title: 'S0',
            units: [
                { image: { shot: 'medium', prompt: 'old prompt' }, video: { action: 'old action' }, audio: { speaker: 'zhenshchina_v_budochke' } },
                { image: { shot: 'wide', prompt: 'untouched prompt' }, video: { action: 'untouched action' }, audio: { speaker: 'anna_smirnova' } },
            ],
        }];
        mod.applyRepairToScenes(scenes, [{
            sceneIndex: 0,
            unitIndex: 0,
            image: { prompt: 'the kiosk saleswoman hands a glass of water' },
            video: { action: 'the kiosk saleswoman turns away' },
            audio: { speaker: 'the kiosk saleswoman' },
        }]);
        expect(scenes[0].units[0].image.prompt).to.equal('the kiosk saleswoman hands a glass of water');
        expect(scenes[0].units[0].video.action).to.equal('the kiosk saleswoman turns away');
        // the speaker fix MUST reach the book — this was the silent-wiring bug
        expect(scenes[0].units[0].audio.speaker).to.equal('the kiosk saleswoman');
        // other units untouched
        expect(scenes[0].units[1].image.prompt).to.equal('untouched prompt');
        expect(scenes[0].units[1].audio.speaker).to.equal('anna_smirnova');
    });

    it('applyRepairToScenes never injects audio into units that had none', () => {
        const { mod } = loadModule({});
        const scenes = [{ title: 'S0', units: [{ image: { prompt: 'p' }, video: { action: 'a' } }] }];
        mod.applyRepairToScenes(scenes, [{ sceneIndex: 0, unitIndex: 0, audio: { speaker: 'the kiosk saleswoman' } }]);
        expect(scenes[0].units[0].audio).to.equal(undefined);
    });

    it('mergeRepairResults rejects fixes that still carry an unverified id', () => {
        const { mod } = loadModule({});
        const input = [unit()];
        const flagged = [{ unit: input[0], tokens: ['zhenshchina_v_budochke'] }];
        const repaired = [{
            scene_index: 0,
            unit_index: 0,
            image: { prompt: 'still_bad_id stands by the booth' },
            video: { action: 'the kiosk saleswoman turns away' },
        }];
        const { units, changed, stillBad } = mod.mergeRepairResults(
            input, flagged, repaired, CHARACTERS, ['anna_smirnova', 'boris_volkov', 'city_park']
        );
        expect(changed).to.equal(0);
        expect(stillBad).to.equal(1);
        expect(units[0].image.prompt).to.equal('zhenshchina_v_budochke hands a glass of water');
        expect(units[0].video.action).to.equal('zhenshchina_v_budochke turns away');
    });
});

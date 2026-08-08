// ======================================================
// Audio Assembly Profile — programmatic prompt assembly (A)
// ======================================================
// Tests for:
//   - audioProfileNameFromConnector: connector → profile name helper
//   - resolveAudioAssembly: audio profile resolution in generation.js
//   - buildMergedDialogueWorkflow: default_instruct comes from the profile
// ======================================================

const { expect } = require('chai');
const { audioProfileNameFromConnector } = require('../src/audio/connector-utils');
const { resolveAssembly, DEFAULT_AUDIO_SECTIONS } = require('../src/image/assembly-profile');

// Silence audio helpers.log during tests
const helpers = require('../src/audio/helpers');
const origLog = helpers.log;
before(() => { helpers.log = () => {}; });
after(() => { helpers.log = origLog; });

// buildMergedDialogueWorkflow needs the real TTS workflows loaded (loadWorkflows
// is normally called at backend startup, not on require).
const wfLoader = require('../src/workflows/workflow-loader');
before(() => { wfLoader.loadWorkflows(); });

describe('audioProfileNameFromConnector', () => {
    it('reads the audio profile from the connector profile field', () => {
        expect(audioProfileNameFromConnector({ profile: { audioProfile: 'qwen-tts' } })).to.equal('qwen-tts');
    });

    it('returns null when the connector has no profile (built-in assembly applies)', () => {
        expect(audioProfileNameFromConnector({})).to.equal(null);
        expect(audioProfileNameFromConnector(null)).to.equal(null);
    });
});

describe('Audio assembly resolution (generation.js)', () => {
    const { resolveAudioAssembly, buildMergedDialogueWorkflow } = require('../src/audio/generation');

    it('resolveAudioAssembly resolves qwen-tts via the real dialogue connector', () => {
        const assembly = resolveAudioAssembly();
        expect(assembly.type).to.equal('audio');
        expect(assembly.sections).to.deep.equal(DEFAULT_AUDIO_SECTIONS);
        expect(assembly.defaults.defaultInstruct).to.equal('');
    });

    it('buildMergedDialogueWorkflow writes default_instruct from the profile defaults', () => {
        const segments = [{ segment_type: 'dialogue', text: 'berlioz: Привет, Бездомный.' }];
        const wf = buildMergedDialogueWorkflow(segments, { characters: [] });
        expect(wf).to.not.equal(null);
        // Profile default is '' → node 108 default_instruct must be ''
        expect(wf["108"].inputs.default_instruct).to.equal('');
        // Script still carries the dialogue text
        expect(wf["108"].inputs.script).to.include('Привет');
    });

    it('unknown audio profiles behave like the built-in default', () => {
        const a = resolveAssembly('audio', 'qwen-tts');
        const b = resolveAssembly('audio', 'does-not-exist');
        expect(b.sections).to.deep.equal(a.sections);
        expect(b.defaults).to.deep.equal(a.defaults);
    });
});

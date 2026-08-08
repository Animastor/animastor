// ======================================================
// Assembly Profile — programmatic prompt assembly (P)
// ======================================================
// Tests for:
//   - resolveAssembly: profile lookup chain (specific → type default → built-in)
//   - buildImagePrompt: profile-driven section order + suppression
// ======================================================

const { expect } = require('chai');
const {
    resolveAssembly,
    DEFAULT_IMAGE_SECTIONS,
    DEFAULT_IMAGE_DEFAULTS,
    DEFAULT_VIDEO_SECTIONS,
    DEFAULT_VIDEO_DEFAULTS,
    DEFAULT_AUDIO_SECTIONS,
    DEFAULT_AUDIO_DEFAULTS,
} = require('../src/image/assembly-profile');
const { buildImagePrompt } = require('../src/image/image-service');
const { imageProfileNameFromConnector } = require('../src/image/connector-utils');

describe('Assembly profile resolver', () => {

    it('resolves qwen-image profile with no suppressed sections', () => {
        const cfg = resolveAssembly('image', 'qwen-image');
        expect(cfg.profileName).to.equal('qwen-image');
        expect(cfg.sections).to.have.lengthOf(15);
        // The qwen skill governs ONLY the core sentence; the wrapper assembles
        // every section (shot/style/mood/lighting/atmosphere included) from
        // structured fields and the environment — nothing is suppressed.
        expect(cfg.suppress.size).to.equal(0);
        expect(cfg.defaults.quality).to.include('highly detailed');
        expect(cfg.defaults.negativeBase).to.equal('blurry, low quality, artifacts');
    });

    it("treats 'default' as the built-in fallback (no default profile on disk)", () => {
        const cfg = resolveAssembly('image', 'default');
        expect(cfg.suppress.size).to.equal(0);
        expect(cfg.sections[0]).to.equal('renderMode');
        expect(cfg.sections[cfg.sections.length - 1]).to.equal('quality');
    });

    it('falls back to built-in default for unknown profiles', () => {
        const cfg = resolveAssembly('image', 'flux-unknown');
        expect(cfg.sections).to.deep.equal(DEFAULT_IMAGE_SECTIONS);
        expect(cfg.suppress.size).to.equal(0);
    });

    it('falls back to built-in default when no profile name is given', () => {
        const cfg = resolveAssembly('image');
        expect(cfg.sections).to.deep.equal(DEFAULT_IMAGE_SECTIONS);
    });

    it('falls back to built-in default for a type with no profile files', () => {
        const cfg = resolveAssembly('music', 'some-model');
        expect(cfg.sections).to.deep.equal(DEFAULT_IMAGE_SECTIONS);
        expect(cfg.defaults).to.deep.equal(DEFAULT_IMAGE_DEFAULTS);
    });

    it("resolves audio assembly via the built-in fallback ('default' no longer exists)", () => {
        const cfg = resolveAssembly('audio', 'default');
        expect(cfg.sections).to.deep.equal(DEFAULT_AUDIO_SECTIONS);
        expect(cfg.defaults).to.deep.equal(DEFAULT_AUDIO_DEFAULTS);
        expect(cfg.suppress.size).to.equal(0);
    });

    it('resolves the qwen-tts audio profile', () => {
        const cfg = resolveAssembly('audio', 'qwen-tts');
        expect(cfg.profileName).to.equal('qwen-tts');
        expect(cfg.sections).to.deep.equal(DEFAULT_AUDIO_SECTIONS);
        expect(cfg.defaults.defaultInstruct).to.equal('');
        expect(cfg.suppress.size).to.equal(0);
    });

    it('falls back to the audio built-in for unknown audio profiles', () => {
        const cfg = resolveAssembly('audio', 'fish-speech-unknown');
        expect(cfg.sections).to.deep.equal(DEFAULT_AUDIO_SECTIONS);
        expect(cfg.defaults).to.deep.equal(DEFAULT_AUDIO_DEFAULTS);
    });

    it("resolves video assembly via the built-in fallback ('default' no longer exists)", () => {
        const cfg = resolveAssembly('video', 'default');
        expect(cfg.sections).to.deep.equal(DEFAULT_VIDEO_SECTIONS);
        expect(cfg.suppress.size).to.equal(0);
        expect(cfg.defaults.negativeBase).to.equal('blurry, low quality, still frame, jitter, flicker, artifacts');
    });

    it('resolves the ltx-2.3 video profile', () => {
        const cfg = resolveAssembly('video', 'ltx-2.3');
        expect(cfg.profileName).to.equal('ltx-2.3');
        expect(cfg.sections).to.deep.equal(DEFAULT_VIDEO_SECTIONS);
        expect(cfg.defaults).to.deep.equal(DEFAULT_VIDEO_DEFAULTS);
        expect(cfg.suppress.size).to.equal(0);
    });

    it('falls back to the video built-in for unknown video profiles', () => {
        const cfg = resolveAssembly('video', 'veo-unknown');
        expect(cfg.sections).to.deep.equal(DEFAULT_VIDEO_SECTIONS);
        expect(cfg.defaults).to.deep.equal(DEFAULT_VIDEO_DEFAULTS);
    });
});

describe('Image profile name from connector', () => {

    it('reads the image profile from the connector profile field', () => {
        expect(imageProfileNameFromConnector({ profile: { imageProfile: 'qwen-image' } })).to.equal('qwen-image');
    });

    it('returns null when the connector has no profile (built-in assembly applies)', () => {
        expect(imageProfileNameFromConnector({})).to.equal(null);
        expect(imageProfileNameFromConnector(null)).to.equal(null);
    });
});

describe('buildImagePrompt — assembly profile driven', () => {

    const bookPayload = {
        characters: [
            { id: 'berlioz', name: 'Берлиоз', passport: { appearance: 'short and stout', clothes: 'gray summer suit' } },
            { id: 'bezdomny', name: 'Бездомный', passport: { appearance: 'broad-shouldered, ginger hair' } },
        ],
        locations: {
            moscow_patriarskie: {
                description: 'Patriarch Ponds in Moscow',
                environment: {
                    time: 'warm evening',
                    season: 'summer',
                    lighting: 'soft street lamps',
                    mood: 'quiet and calm',
                },
            },
        },
    };

    const unit = {
        type: 'narration',
        image: { prompt: 'berlioz and bezdomny sitting on a bench near the pond, arguing', shot: 'close' },
    };

    const scene = {
        participants: ['berlioz', 'bezdomny'],
        visual: { render: 'cinematic' },
        location: { id: 'moscow_patriarskie' },
    };

    it('default profile keeps the full wrapper (general → specific)', () => {
        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('style cinematic');
        expect(result).to.include('soft street lamps');
        expect(result).to.include('quiet and calm');
        expect(result).to.include('close shot');
        expect(result).to.include('berlioz:');
        expect(result).to.include('berlioz and bezdomny sitting');
        expect(result).to.include('image quality');
    });

    it('qwen-image profile assembles the full wrapper (shot/style/lighting/mood from data)', () => {
        const result = buildImagePrompt(unit, scene, {}, bookPayload, { profile: 'qwen-image' });
        // The wrapper always adds the full wrapper from structured fields + env.
        expect(result).to.include('style cinematic');
        expect(result).to.include('soft street lamps');
        expect(result).to.include('quiet and calm');
        expect(result).to.include('close shot');
        // context, characters, direct prompt, quality remain
        expect(result).to.include('Patriarch Ponds in Moscow');
        expect(result).to.include('warm evening');
        expect(result).to.include('berlioz:');
        expect(result).to.include('berlioz and bezdomny sitting');
        expect(result).to.include('image quality');
    });

    it('unknown profile behaves exactly like the default', () => {
        const a = buildImagePrompt(unit, scene, {}, bookPayload);
        const b = buildImagePrompt(unit, scene, {}, bookPayload, { profile: 'does-not-exist' });
        expect(b).to.equal(a);
    });

    it('quality defaults come from the profile', () => {
        const unitNoQuality = { ...unit, image: { ...unit.image } };
        const result = buildImagePrompt(unitNoQuality, scene, {}, bookPayload, { profile: 'qwen-image' });
        expect(result).to.include('image quality: highly detailed, sharp focus');
    });
});

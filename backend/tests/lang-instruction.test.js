// ======================================================
// Language Architecture — buildLangInstruction / resolveBookLanguage / %LANGUAGE%
// ======================================================
// Tests for the language helpers added to agent-prompts.js:
//   - buildLangInstruction(lang) — VALUE substituted for the %LANGUAGE% placeholder
//   - resolveBookLanguage(draft)  — book.language → defaults.language → detectLanguage → 'ru'
//   - langName(code)              — language code → display name
// Plus placeholder wiring in ai/rules/*.md:
//   - UI-facing rules carry "%LANGUAGE%" point-wise next to user-facing fields
//     (name, title, description) — GPU-facing fields (appearance, environment)
//     stay English via explicit mandates
//   - GPU-facing rules carry a fixed "Result language: English (en)"
// See docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md

const { expect } = require('chai');

const {
    buildLangInstruction,
    resolveBookLanguage,
    langName,
    fillLang,
    SYSTEM_PROMPTS,
} = require('../src/services/agent-prompts');

describe('buildLangInstruction — %LANGUAGE% value', () => {

    it('returns the Russian value for ru', () => {
        expect(buildLangInstruction('ru')).to.equal('Russian (ru)');
    });

    it('returns the English value for en', () => {
        expect(buildLangInstruction('en')).to.equal('English (en)');
    });

    it('handles additional languages (de)', () => {
        expect(buildLangInstruction('de')).to.equal('German (de)');
    });

    it('defaults to ru when language is missing', () => {
        expect(buildLangInstruction(undefined)).to.equal('Russian (ru)');
        expect(buildLangInstruction(null)).to.equal('Russian (ru)');
        expect(buildLangInstruction('')).to.equal('Russian (ru)');
    });

    it('normalizes uppercase language codes', () => {
        expect(buildLangInstruction('DE')).to.equal('German (de)');
    });

    it('falls back to the raw code for unknown languages', () => {
        expect(buildLangInstruction('fi')).to.equal('fi (fi)');
    });
});

describe('fillLang — replaces EVERY %LANGUAGE% occurrence', () => {

    it('replaces all occurrences, not just the first', () => {
        const template = 'a %LANGUAGE% b %LANGUAGE% c %LANGUAGE%';
        const rendered = fillLang(template, 'ru');
        expect(rendered).to.equal('a Russian (ru) b Russian (ru) c Russian (ru)');
        expect(rendered).to.not.include('%LANGUAGE%');
    });

    it('leaves no raw placeholder in characters.md (4 occurrences)', () => {
        const rendered = fillLang(SYSTEM_PROMPTS.characters, 'ru');
        const count = (rendered.match(/%LANGUAGE%/g) || []).length;
        expect(count).to.equal(0);
        const expected = buildLangInstruction('ru');
        const occurrences = (rendered.match(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        expect(occurrences).to.equal(4);
    });

    it('replaces all occurrences in locations.md (2 occurrences)', () => {
        const rendered = fillLang(SYSTEM_PROMPTS.locations, 'de');
        expect(rendered).to.not.include('%LANGUAGE%');
        const occurrences = (rendered.match(/German \(de\)/g) || []).length;
        expect(occurrences).to.equal(2);
    });

    it('handles templates without the placeholder', () => {
        expect(fillLang('no placeholder here', 'ru')).to.equal('no placeholder here');
    });

    it('returns empty string for null/undefined templates', () => {
        expect(fillLang(null, 'ru')).to.equal('');
        expect(fillLang(undefined, 'ru')).to.equal('');
    });

    it('structure.md renders its single occurrence', () => {
        const rendered = fillLang(SYSTEM_PROMPTS.structure, 'ru');
        expect(rendered).to.not.include('%LANGUAGE%');
        expect(rendered).to.include('Russian (ru)');
    });
});

describe('ai/rules/*.md — %LANGUAGE% point-wise wiring', () => {

    // UI-facing rules: %LANGUAGE% is placed point-wise next to USER-FACING fields
    // (name, title, description) — GPU-facing fields inside them (appearance,
    // environment) stay English and carry an explicit ENGLISH mandate.
    const UI_RULES = ['structure', 'characters', 'locations', 'scenes'];

    // GPU-facing rules: their OUTPUT feeds generation models → fixed English, no placeholder.
    const GPU_RULES = ['visuals', 'storyboard_polish', 'video_action_reconciliation',
        'video_action_polish', 'passport_reconciliation'];

    it('UI rules carry the %LANGUAGE% placeholder point-wise', () => {
        for (const name of UI_RULES) {
            expect(SYSTEM_PROMPTS[name], name).to.include('%LANGUAGE%');
        }
    });

    it('UI rules do NOT have a blanket "Result language:" line — language is field-specific', () => {
        for (const name of UI_RULES) {
            expect(SYSTEM_PROMPTS[name], name).to.not.include('Result language: %LANGUAGE%');
        }
    });

    it('GPU-facing fields inside UI rules are mandated ENGLISH', () => {
        // characters.md — appearance feeds image/video generation
        expect(SYSTEM_PROMPTS.characters).to.include('appearance MUST be written in ENGLISH');
        // locations.md — environment feeds generation
        expect(SYSTEM_PROMPTS.locations).to.include('environment` values MUST be written in ENGLISH');
        // locations.md — description is injected verbatim into image/video prompts → English too
        expect(SYSTEM_PROMPTS.locations).to.include('description` values MUST be written in ENGLISH');
        // scenes.md — scene environment overrides feed generation (merged from enrich_scenes.md)
        expect(SYSTEM_PROMPTS.scenes).to.include('environment` field values MUST be written in ENGLISH');
    });

    it('GPU rules carry a fixed "Result language: English (en)" and no placeholder', () => {
        for (const name of GPU_RULES) {
            expect(SYSTEM_PROMPTS[name], name).to.include('Result language: English (en)');
            expect(SYSTEM_PROMPTS[name], name).to.not.include('%LANGUAGE%');
        }
    });

    it('voice_generation has both: instructions English + TTS output language from %LANGUAGE%', () => {
        expect(SYSTEM_PROMPTS.voice_generation).to.include('Result language: English (en)');
        expect(SYSTEM_PROMPTS.voice_generation).to.include('TTS output language: %LANGUAGE%');
    });

    it('substituting %LANGUAGE% produces the concrete value', () => {
        const rendered = fillLang(SYSTEM_PROMPTS.scenes, 'de');
        // scenes.md now carries the placeholder TWICE (scene-titles section + output format)
        expect(rendered).to.not.include('%LANGUAGE%');
        const occurrences = (rendered.match(/German \(de\)/g) || []).length;
        expect(occurrences).to.equal(2);
        // GPU rules need no substitution — already fixed English
        expect(SYSTEM_PROMPTS.visuals).to.include('Result language: English (en)');
    });

    it('scenes.md carries the %BOOK_DEFAULT% placeholder for book-level country/epoch', () => {
        // Book default country/epoch are threaded into the scene split prompt via
        // stepCreateScenes (bookDefault param) — assert the placeholder exists and
        // substitutes cleanly with a concrete value.
        expect(SYSTEM_PROMPTS.scenes).to.include('%BOOK_DEFAULT%');
        const rendered = SYSTEM_PROMPTS.scenes.replace('%BOOK_DEFAULT%', 'country: Japan\nepoch: 19th century');
        expect(rendered).to.include('country: Japan\nepoch: 19th century');
        expect(rendered).to.not.include('%BOOK_DEFAULT%');
    });
});

describe('resolveBookLanguage — book language resolution', () => {

    it('uses book.language when set', () => {
        expect(resolveBookLanguage({ book: { language: 'en' } })).to.equal('en');
    });

    it('falls back to defaults.language when book.language is null', () => {
        expect(resolveBookLanguage({ book: { language: null, defaults: { language: 'de' } } }))
            .to.equal('de');
    });

    it('detects Russian from sourceText when no explicit language', () => {
        const draft = { book: {}, sourceText: 'Привет, это русский текст книги для проверки определения языка.' };
        expect(resolveBookLanguage(draft)).to.equal('ru');
    });

    it('detects English from sourceText when no explicit language', () => {
        const draft = { book: {}, sourceText: 'Hello, this is an English book text used for language detection.' };
        expect(resolveBookLanguage(draft)).to.equal('en');
    });

    it('returns ru for a null draft', () => {
        expect(resolveBookLanguage(null)).to.equal('ru');
    });
});

describe('langName — language code mapping', () => {

    it('maps known codes to display names', () => {
        expect(langName('ru')).to.equal('Russian');
        expect(langName('en')).to.equal('English');
        expect(langName('de')).to.equal('German');
    });

    it('returns the code itself for unknown languages', () => {
        expect(langName('zz')).to.equal('zz');
    });
});

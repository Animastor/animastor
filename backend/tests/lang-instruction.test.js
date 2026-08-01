// ======================================================
// Language Architecture — buildLangInstruction / resolveBookLanguage / %LANGUAGE%
// ======================================================
// Tests for the language helpers added to agent-prompts.js:
//   - buildLangInstruction(lang) — VALUE substituted for the %LANGUAGE% placeholder
//   - resolveBookLanguage(draft)  — book.language → defaults.language → detectLanguage → 'ru'
//   - langName(code)              — language code → display name
// Plus placeholder wiring in ai/rules/*.md:
//   - UI-facing rules carry "Result language: %LANGUAGE%"
//   - GPU-facing rules carry a fixed "Result language: English (en)"
// See docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md

const { expect } = require('chai');

const {
    buildLangInstruction,
    resolveBookLanguage,
    langName,
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

describe('ai/rules/*.md — %LANGUAGE% placeholder wiring', () => {

    // UI-facing rules: their OUTPUT is user-facing text → localize via %LANGUAGE%.
    const UI_RULES = ['structure', 'characters', 'locations', 'scenes', 'enrich_scenes'];

    // GPU-facing rules: their OUTPUT feeds generation models → fixed English.
    const GPU_RULES = ['visuals', 'storyboard_polish', 'video_action_reconciliation',
        'video_action_polish', 'passport_reconciliation'];

    it('UI rules carry the "Result language: %LANGUAGE%" line', () => {
        for (const name of UI_RULES) {
            expect(SYSTEM_PROMPTS[name], name).to.include('Result language: %LANGUAGE%');
        }
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

    it('substituting %LANGUAGE% produces the concrete line', () => {
        const rendered = SYSTEM_PROMPTS.scenes.replace('%LANGUAGE%', buildLangInstruction('de'));
        expect(rendered).to.include('Result language: German (de)');
        // GPU rules need no substitution — already fixed English
        expect(SYSTEM_PROMPTS.visuals).to.include('Result language: English (en)');
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

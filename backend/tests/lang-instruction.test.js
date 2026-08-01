// ======================================================
// Language Architecture — buildLangInstruction / resolveBookLanguage
// ======================================================
// Tests for the language helpers added to agent-prompts.js:
//   - buildLangInstruction(lang) — "Output language" block for text-generating steps
//   - buildVoiceLangHint(lang)   — Native <Lang> pronunciation marker for the voice step
//   - resolveBookLanguage(draft) — book.language → defaults.language → detectLanguage → 'ru'
//   - langName(code)             — language code → display name
// See docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md

const { expect } = require('chai');

const {
    buildLangInstruction,
    buildVoiceLangHint,
    resolveBookLanguage,
    langName,
} = require('../src/services/agent-prompts');

describe('buildLangInstruction — output language block', () => {

    it('returns a Russian instruction for ru', () => {
        const block = buildLangInstruction('ru');
        expect(block).to.include('The book is generated in Russian (ru).');
        expect(block).to.include('scene titles (scene.title)');
        expect(block).to.include('image.prompt, video.action');
    });

    it('returns an English instruction for en', () => {
        const block = buildLangInstruction('en');
        expect(block).to.include('The book is generated in English (en).');
    });

    it('handles additional languages (de)', () => {
        const block = buildLangInstruction('de');
        expect(block).to.include('The book is generated in German (de).');
    });

    it('defaults to ru when language is missing', () => {
        expect(buildLangInstruction(undefined)).to.include('Russian (ru)');
        expect(buildLangInstruction(null)).to.include('Russian (ru)');
        expect(buildLangInstruction('')).to.include('Russian (ru)');
    });

    it('normalizes uppercase language codes', () => {
        expect(buildLangInstruction('DE')).to.include('German (de)');
    });

    it('keeps AI-facing fields in English regardless of book language', () => {
        const block = buildLangInstruction('ru');
        expect(block).to.include('Keep AI-facing fields in ENGLISH');
        expect(block).to.include('Never translate');
    });

    it('falls back to the raw code for unknown languages', () => {
        const block = buildLangInstruction('fi');
        expect(block).to.include('The book is generated in fi (fi).');
    });
});

describe('buildVoiceLangHint — voice step language hint', () => {

    it('adds a Native pronunciation marker for ru', () => {
        const hint = buildVoiceLangHint('ru');
        expect(hint).to.include('Native Russian pronunciation');
        expect(hint).to.include('remain in English');
    });

    it('adds a Native pronunciation marker for en', () => {
        expect(buildVoiceLangHint('en')).to.include('Native English pronunciation');
    });

    it('defaults to Russian pronunciation when language is missing', () => {
        expect(buildVoiceLangHint(undefined)).to.include('Native Russian pronunciation');
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

// ======================================================
// Coreference Resolution — Agent Service Tests (Simplified)
// ======================================================
// Tests for:
//   - getFallbackImage
//   - splitIntoSentences / splitIntoSentencesWithOffsets
// ======================================================
// NOTE: unit.participants removed from the system.
// assignUnitParticipants, applyScenePairParticipantFallback,
// shouldInjectParticipantPassports, promptMentionsGenericPeople — all removed.
// Participants are inferred from visual prompt text via inferCharactersFromPrompt.

const { expect } = require('chai');
const {
    getFallbackImage,
    splitIntoSentences,
    splitIntoSentencesWithOffsets,
} = require('../src/services/agent-service');
const {
    isGenericCharacter,
    isPlaceholderCharacter,
    isPlaceholderCharacterId,
    hasRealAppearance,
    mergeCharacterLists,
} = require('../src/utils/character-identity');

describe('Coreference — visual fallback participants', () => {
    const characters = [
        { id: 'berlioz', name: 'Берлиоз' },
        { id: 'ponyrev', name: 'Бездомный' },
    ];

    it('uses scene-level participants when available', () => {
        const prompt = getFallbackImage('Берлиоз сел.', characters, {
            participants: ['berlioz'],
            location: { id: 'patriarch_ponds' },
        });
        expect(prompt).to.equal('berlioz at patriarch ponds, cinematic shot');
    });

    it('does not inject all known characters when participants are empty', () => {
        const prompt = getFallbackImage('Пустая аллея.', characters, {
            participants: [],
            location: { id: 'patriarch_ponds' },
        });
        expect(prompt).to.equal('the scene at patriarch ponds, cinematic shot');
        expect(prompt).to.not.include('berlioz');
        expect(prompt).to.not.include('ponyrev');
    });
});

// ======================================================
// character identity merge
// ======================================================

describe('Coreference — character identity merge', () => {
    it('merges a short surname id into an existing full canonical character', () => {
        const existing = [{
            id: 'mikhail_aleksandrovich_berlioz',
            name: 'Михаил Александрович Берлиоз',
            appearance: 'short, bald editor',
        }];
        const incoming = [{
            id: 'berlioz',
            name: 'Берлиоз',
            appearance: 'momentary pale tense face',
        }];

        const result = mergeCharacterLists(existing, incoming);
        expect(result.characters).to.have.lengthOf(1);
        expect(result.characters[0].id).to.equal('mikhail_aleksandrovich_berlioz');
        expect(result.characters[0].appearance).to.equal('short, bald editor');
        expect(result.enriched).to.equal(1);
    });

    it('skips generic-only characters but keeps contextual role-only characters', () => {
        expect(isGenericCharacter({ id: 'woman', name: 'Женщина' })).to.equal(true);
        expect(isGenericCharacter({ id: 'zhenshchina_v_budochke', name: 'Женщина в будочке' })).to.equal(false);

        const result = mergeCharacterLists([], [
            { id: 'woman', name: 'Женщина' },
            { id: 'zhenshchina_v_budochke', name: 'Женщина в будочке' },
        ]);

        expect(result.characters.map(c => c.id)).to.deep.equal(['zhenshchina_v_budochke']);
        expect(result.skippedGeneric).to.equal(1);
    });

    it('flags placeholder ids/names (unknown, unnamed, Unidentified, неизвестный)', () => {
        expect(isPlaceholderCharacter({ id: 'unknown', name: 'Unknown' })).to.equal(true);
        expect(isPlaceholderCharacter({ id: 'some_real_id', name: 'Unidentified' })).to.equal(true);
        expect(isPlaceholderCharacter({ id: 'anna_smirnova', name: 'Anna Smirnova' })).to.equal(false);
        expect(isPlaceholderCharacter(null)).to.equal(true);
        expect(isPlaceholderCharacterId('unknown')).to.equal(true);
        expect(isPlaceholderCharacterId('Unidentified')).to.equal(true);
        expect(isPlaceholderCharacterId('неизвестный')).to.equal(true);
        expect(isPlaceholderCharacterId('anna_smirnova')).to.equal(false);
        expect(isPlaceholderCharacterId('')).to.equal(false);
    });

    it('a placeholder-named character WITH a real appearance is a real character (survives)', () => {
        // "Неизвестный" (the mysterious stranger) is a legitimate literary name —
        // with a described appearance it is a REAL character, not a placeholder.
        expect(isPlaceholderCharacter({ id: 'neizvestnyy', name: 'Неизвестный', appearance: 'высокий мужчина в чёрном плаще' })).to.equal(false);
        expect(isPlaceholderCharacter({ id: 'unknown', name: 'Unknown', appearance: 'tall man in a long black coat' })).to.equal(false);
        // ...but a placeholder id/name with NO real info (or only placeholder
        // boilerplate) is still a fictitious 'unknown' character.
        expect(isPlaceholderCharacter({ id: 'unknown', name: 'Unknown', appearance: 'Unidentified character' })).to.equal(true);
        expect(isPlaceholderCharacter({ id: 'unknown', name: 'Unknown', description: 'не описан' })).to.equal(true);
    });

    it('mergeCharacterLists with skipGeneric never re-introduces placeholders from AI output', () => {
        const result = mergeCharacterLists([], [
            { id: 'unknown', name: 'Unknown', appearance: 'Unidentified character' },
            { id: 'anna_smirnova', name: 'Anna Smirnova', appearance: 'tall, blonde' },
        ]);
        expect(result.characters.map(c => c.id)).to.deep.equal(['anna_smirnova']);
    });

    it('mergeCharacterLists keeps a placeholder-named character that has a real appearance', () => {
        const result = mergeCharacterLists([], [
            { id: 'neizvestnyy', name: 'Неизвестный', appearance: 'высокий мужчина в чёрном плаще' },
            { id: 'anna_smirnova', name: 'Anna Smirnova', appearance: 'tall, blonde' },
        ]);
        expect(result.characters.map(c => c.id).sort()).to.deep.equal(['anna_smirnova', 'neizvestnyy']);
    });

    it('mergeCharacterLists filters a legacy placeholder that sits in the EXISTING set', () => {
        // Older code once wrote { id: 'unknown' } into characters.json — it must
        // be cleaned at merge time so it never reaches knownParticipantIds /
        // scene.participants. A legacy placeholder WITH a real appearance stays.
        const result = mergeCharacterLists([
            { id: 'unknown', name: 'Unknown' },
            { id: 'boris_volkov', name: 'Boris Volkov', role: 'main' },
        ], []);
        expect(result.characters.map(c => c.id)).to.deep.equal(['boris_volkov']);

        const withRealAppearance = mergeCharacterLists([
            { id: 'unknown', name: 'Unknown', appearance: 'tall man in a long black coat' },
        ], []);
        expect(withRealAppearance.characters.map(c => c.id)).to.deep.equal(['unknown']);
    });
});

// ======================================================
// hasRealAppearance — export guard + semantics
// ======================================================
// REGRESSION: commit c058d8c introduced hasRealAppearance as the shared
// predicate for the pipeline (pipeline-steps stepGenerateVoices filters
// voice candidates through it, lazy-book/create.js builds characters.json
// through it) but forgot to export it — every caller received `undefined`
// and generation crashed with "hasRealAppearance is not a function" between
// the characters and locations stages. The export guard below pins the
// module contract so the crash can never silently come back.

describe('Coreference — hasRealAppearance', () => {
    it('is exported as a callable function (all pipeline importers rely on it)', () => {
        expect(typeof hasRealAppearance).to.equal('function');
        // The two production importers must resolve the export — this would
        // have thrown at require time had the import been undefined-broken.
        const pipelineSteps = require('../src/services/agent/pipeline-steps');
        expect(pipelineSteps).to.be.an('object');
        const lazyBookCreate = require('../src/book/lazy-book/create');
        expect(lazyBookCreate).to.be.an('object');
    });

    it('a character with a real appearance (even placeholder-ish id) is visually real', () => {
        expect(hasRealAppearance({ id: 'neizvestnyy', appearance: 'высокий мужчина в чёрном плаще' })).to.equal(true);
        expect(hasRealAppearance({ id: 'berlioz', appearance: 'tall man, age unknown' })).to.equal(true);
        expect(hasRealAppearance({ id: 'berlioz', clothes: 'серый костюм' })).to.equal(true);
    });

    it('no appearance or placeholder-only boilerplate is NOT a real appearance', () => {
        expect(hasRealAppearance({ id: 'berlioz' })).to.equal(false);
        expect(hasRealAppearance({ id: 'berlioz', appearance: '' })).to.equal(false);
        expect(hasRealAppearance({ id: 'unknown', appearance: 'Unidentified character' })).to.equal(false);
        expect(hasRealAppearance({ id: 'berlioz', description: 'не описан' })).to.equal(false);
    });
});

// ======================================================
// splitIntoSentences
// ======================================================

describe('Coreference — splitIntoSentences', () => {

    it('splits text on sentence endings', () => {
        const text = 'Берлиоз шёл. Бездомный бежал.';
        const result = splitIntoSentences(text);
        expect(result).to.have.lengthOf(2);
        expect(result[0]).to.include('Берлиоз');
        expect(result[1]).to.include('Бездомный');
    });

    it('handles exclamation and question marks', () => {
        const text = 'Кто там? Это Берлиоз!';
        const result = splitIntoSentences(text);
        expect(result).to.have.lengthOf(2);
    });

    it('includes trailing punctuation in sentence', () => {
        const text = 'Берлиоз шёл.';
        const result = splitIntoSentences(text);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.equal('Берлиоз шёл.');
    });

    it('handles empty text', () => {
        expect(splitIntoSentences('')).to.deep.equal([]);
    });

    it('handles Russian ellipsis', () => {
        const text = 'Он подумал… Потом ответил.';
        const result = splitIntoSentences(text);
        expect(result).to.have.lengthOf(2);
    });

    it('handles paragraph breaks', () => {
        const text = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
        const result = splitIntoSentences(text);
        expect(result).to.have.lengthOf(3);
    });
});

// ======================================================
// splitIntoSentencesWithOffsets
// ======================================================

describe('Coreference — splitIntoSentencesWithOffsets', () => {

    it('returns sentences with start and end offsets', () => {
        const text = 'Берлиоз шёл. Бездомный бежал.';
        const result = splitIntoSentencesWithOffsets(text);
        expect(result).to.have.lengthOf(2);
        expect(result[0]).to.have.keys('text', 'start', 'end');
        expect(result[0].start).to.equal(0);
        // Start of second sentence may equal first's end (space between)
        expect(result[1].start).to.be.at.least(result[0].end);
    });

    it('offsets handle simple text correctly', () => {
        const text = 'A. B. C.';
        const result = splitIntoSentencesWithOffsets(text);
        expect(result).to.have.lengthOf(3);
        expect(result[0].text).to.equal('A.');
        expect(result[1].text).to.equal('B.');
        expect(result[2].text).to.equal('C.');
        // Offsets: start of each sentence
        expect(result[0].start).to.equal(0);
        expect(result[1].start).to.be.at.least(result[0].end);
        expect(result[2].start).to.be.at.least(result[1].end);
    });
});

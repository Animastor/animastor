// ======================================================
// Coreference Resolution — Agent Service Tests (Simplified)
// ======================================================
// Tests for:
//   - assignUnitParticipants (LLM output validation)
//   - applyScenePairParticipantFallback
//   - shouldInjectParticipantPassports
//   - getFallbackVisual
//   - splitIntoSentences / splitIntoSentencesWithOffsets
// ======================================================

const { expect } = require('chai');
const {
    assignUnitParticipants,
    getFallbackVisual,
    applyScenePairParticipantFallback,
    shouldInjectParticipantPassports,
    splitIntoSentences,
    splitIntoSentencesWithOffsets,
} = require('../src/services/agent-service');
const {
    isGenericCharacter,
    mergeCharacterLists,
} = require('../src/utils/character-identity');

// ======================================================
// assignUnitParticipants — LLM output validation
// ======================================================

describe('Coreference — assignUnitParticipants validation', () => {
    const characters = [
        { id: 'berlioz', name: 'Берлиоз' },
        { id: 'ponyrev', name: 'Бездомный' },
    ];

    it('accepts valid character IDs from LLM output', () => {
        const units = [
            { text: 'Берлиоз сел на скамейку.', participants: ['berlioz'] },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(result[0]).to.have.members(['berlioz']);
    });

    it('handles multiple participants per unit', () => {
        const units = [
            { text: 'Берлиоз и Бездомный сидели.', participants: ['berlioz', 'ponyrev'] },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(result[0]).to.have.members(['berlioz', 'ponyrev']);
    });

    it('filters out unknown character IDs', () => {
        const units = [
            { text: 'Неизвестный персонаж.', participants: ['berlioz', 'fake_char'] },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(result[0]).to.deep.equal(['berlioz']);
    });

    it('returns empty for unit with no participants', () => {
        const units = [
            { text: 'Пейзаж без людей.', participants: [] },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it('returns empty for unit without participants field', () => {
        const units = [
            { text: 'Пейзаж без людей.' },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it('handles multiple units with different participants', () => {
        const units = [
            { text: 'Берлиоз шёл.', participants: ['berlioz'] },
            { text: 'Бездомный бежал.', participants: ['ponyrev'] },
            { text: 'Пустая аллея.', participants: [] },
        ];
        const result = assignUnitParticipants(units, characters);
        expect(result[0]).to.have.members(['berlioz']);
        expect(result[1]).to.have.members(['ponyrev']);
        expect(result[2]).to.be.undefined;
    });

    it('deduplicates character IDs', () => {
        const units = [
            { text: 'Текст.', participants: ['berlioz', 'berlioz', 'berlioz'] },
        ];
        const result = assignUnitParticipants(units, characters);
        // assignUnitParticipants does NOT dedup — it passes through validated IDs
        // (dedup happens elsewhere: buildCharacters in image-service.js)
        expect(result[0]).to.have.members(['berlioz']);
    });

    it('returns empty for empty units array', () => {
        expect(assignUnitParticipants([], characters)).to.deep.equal({});
    });

    it('returns empty for undefined units', () => {
        expect(assignUnitParticipants(undefined, characters)).to.deep.equal({});
    });

    it('handles empty characters list', () => {
        const units = [
            { text: 'Текст.', participants: ['berlioz'] },
        ];
        const result = assignUnitParticipants(units, []);
        expect(Object.keys(result)).to.have.lengthOf(0);
    });
});

describe('Coreference — visual fallback participants', () => {
    const characters = [
        { id: 'berlioz', name: 'Берлиоз' },
        { id: 'ponyrev', name: 'Бездомный' },
    ];

    it('uses unit-level participants when available', () => {
        const prompt = getFallbackVisual('Берлиоз сел.', characters, {
            participants: ['berlioz'],
            location: { id: 'patriarch_ponds' },
        });
        expect(prompt).to.equal('berlioz at patriarch_ponds, cinematic shot');
    });

    it('does not inject all known characters when participants are empty', () => {
        const prompt = getFallbackVisual('Пустая аллея.', characters, {
            participants: [],
            location: { id: 'patriarch_ponds' },
        });
        expect(prompt).to.equal('the scene at patriarch_ponds, cinematic shot');
        expect(prompt).to.not.include('berlioz');
        expect(prompt).to.not.include('ponyrev');
    });
});

describe('Coreference — scene pair participant fallback', () => {
    const sceneParticipants = ['mikhail_aleksandrovich_berlioz', 'ivan_nikolaevich_ponyrev'];

    it('assigns both scene participants for clear group references', () => {
        const units = [{
            text: 'Напившись, литераторы немедленно начали икать и уселись на скамейке.',
        }];
        const result = applyScenePairParticipantFallback(units, {}, sceneParticipants);
        expect(result[0]).to.have.members(sceneParticipants);
    });

    it('assigns both scene participants for ordinal references', () => {
        const units = [
            { text: 'Первый был маленького роста.' },
            { text: 'Второй был плечистый и рыжеватый.' },
        ];
        const result = applyScenePairParticipantFallback(units, {}, sceneParticipants);
        expect(result[0]).to.have.members(sceneParticipants);
        expect(result[1]).to.have.members(sceneParticipants);
    });

    it('does not override explicit unit participants', () => {
        const units = [{ text: 'Первый был маленького роста.' }];
        const result = applyScenePairParticipantFallback(units, { 0: ['mikhail_aleksandrovich_berlioz'] }, sceneParticipants);
        expect(result[0]).to.deep.equal(['mikhail_aleksandrovich_berlioz']);
    });

    it('does not guess when scene participant count is not exactly two', () => {
        const units = [{ text: 'Литераторы сели на скамейку.' }];
        const result = applyScenePairParticipantFallback(units, {}, ['a', 'b', 'c']);
        expect(result).to.deep.equal({});
    });
});

describe('Coreference — passport injection guard', () => {
    it('injects participants for generic people wording even when character_binding is false', () => {
        expect(shouldInjectParticipantPassports('Two writers sitting on the bench', ['berlioz', 'ponyrev'], false)).to.equal(true);
    });

    it('keeps no-people prompts unbound when character_binding is false', () => {
        expect(shouldInjectParticipantPassports('empty bench, no people visible', ['berlioz', 'ponyrev'], false)).to.equal(false);
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

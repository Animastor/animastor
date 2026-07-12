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

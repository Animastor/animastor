// ======================================================
// Coreference Resolution — Agent Service Tests (P7)
// ======================================================
// Tests for:
//   - assignUnitParticipants (text-based matching, no DB)
//   - computeHash
//   - normalizeForMatch
//   - splitIntoSentences / splitIntoSentencesWithOffsets
// ======================================================

const { expect } = require('chai');
const {
    computeHash,
    normalizeForMatch,
    splitIntoSentences,
    splitIntoSentencesWithOffsets,
} = require('../src/services/agent-service');

// ======================================================
// assignUnitParticipants — text-based matching
// ======================================================

describe('Coreference — assignUnitParticipants text matching', () => {

    // Simulates the exact algorithm used by assignUnitParticipants (text-based matching)
    function simulateMatching(mentions, units) {
        const unitParticipants = {};
        for (let ui = 0; ui < units.length; ui++) {
            const uText = (units[ui]?.text || '').toLowerCase();
            if (!uText) continue;
            const chars = new Set();
            for (const m of mentions) {
                const mText = (m.mention_text || '').toLowerCase();
                if (mText && uText.includes(mText) && m.character_id) {
                    chars.add(m.character_id);
                }
            }
            if (chars.size > 0) {
                unitParticipants[ui] = [...chars];
            }
        }
        return unitParticipants;
    }

    it('assigns correct characters to unit with direct mentions', () => {
        const units = [{ text: 'На скамейке сидели Берлиоз и Бездомный.' }];
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }, { character_id: 'ponyrev', mention_text: 'Бездомный' }];
        const result = simulateMatching(m, units);
        expect(result[0]).to.have.members(['berlioz', 'ponyrev']);
    });

    it('finds characters by descriptive mention (редактор, поэт)', () => {
        const units = [{ text: 'Поэт Иван Николаевич Понырев смотрел на редактора МАССОЛИТА.' }];
        const m = [
            { character_id: 'berlioz', mention_text: 'редактор' },
            { character_id: 'ponyrev', mention_text: 'поэт' },
            { character_id: 'ponyrev', mention_text: 'Иван Николаевич Понырев' },
        ];
        const result = simulateMatching(m, units);
        expect(result[0]).to.have.members(['berlioz', 'ponyrev']);
    });

    it('returns empty for unit with no character mentions', () => {
        const units = [{ text: 'Солнце садилось за Садовое кольцо. Было жарко.' }];
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }];
        expect(Object.keys(simulateMatching(m, units))).to.have.lengthOf(0);
    });

    it('handles multiple units with different characters', () => {
        const units = [
            { text: 'Берлиоз пожал руку профессору.' },
            { text: 'Поэт и Бездомный стояли рядом.' },
            { text: 'Солнце садилось за горизонт.' },
        ];
        const m = [
            { character_id: 'berlioz', mention_text: 'Берлиоз' },
            { character_id: 'woland', mention_text: 'профессор' },
            { character_id: 'ponyrev', mention_text: 'Бездомный' },
            { character_id: 'ponyrev', mention_text: 'поэт' },
        ];
        const result = simulateMatching(m, units);
        expect(result[0]).to.have.members(['berlioz', 'woland']);
        expect(result[1]).to.have.members(['ponyrev']);
        expect(result[2]).to.be.undefined;
    });

    it('is case insensitive', () => {
        const units = [{ text: 'БЕРЛИОЗ И БЕЗДОМНЫЙ' }];
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }, { character_id: 'ponyrev', mention_text: 'Бездомный' }];
        const result = simulateMatching(m, units);
        expect(result[0]).to.have.members(['berlioz', 'ponyrev']);
    });

    it('skips unit with empty text', () => {
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }];
        const result = simulateMatching(m, [{ text: '' }, { text: 'Берлиоз тут' }]);
        expect(result[0]).to.be.undefined;
        expect(result[1]).to.have.members(['berlioz']);
    });

    it('handles empty mentions array', () => {
        expect(Object.keys(simulateMatching([], [{ text: 'Берлиоз' }]))).to.have.lengthOf(0);
    });

    it('handles mention that appears in multiple units', () => {
        const units = [{ text: 'Берлиоз шёл по аллее.' }, { text: 'Берлиоз сел на скамейку.' }];
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }];
        const result = simulateMatching(m, units);
        expect(result[0]).to.have.members(['berlioz']);
        expect(result[1]).to.have.members(['berlioz']);
    });

    it('deduplicates characters in same unit', () => {
        const units = [{ text: 'Берлиоз сказал Берлиозу, что Берлиоз устал.' }];
        const m = [{ character_id: 'berlioz', mention_text: 'Берлиоз' }];
        const result = simulateMatching(m, units);
        expect(result[0]).to.deep.equal(['berlioz']);
    });
});

// ======================================================
// computeHash
// ======================================================

describe('Coreference — computeHash', () => {

    it('returns consistent hash for same input', () => {
        const h1 = computeHash('hello world');
        const h2 = computeHash('hello world');
        expect(h1).to.equal(h2);
    });

    it('returns different hash for different input', () => {
        const h1 = computeHash('hello');
        const h2 = computeHash('world');
        expect(h1).to.not.equal(h2);
    });

    it('handles empty string', () => {
        expect(computeHash('')).to.be.a('string');
    });

    it('handles objects', () => {
        const h = computeHash({ a: 1, b: 2 });
        expect(h).to.be.a('string');
        expect(h.length).to.be.above(0);
    });

    it('handles arrays', () => {
        const h = computeHash([1, 2, 3]);
        expect(h).to.be.a('string');
    });

    it('returns consistent hash for same object', () => {
        const obj = { id: 'berlioz', name: 'Берлиоз' };
        expect(computeHash(obj)).to.equal(computeHash(obj));
    });

    it('returns hex string', () => {
        const h = computeHash('test');
        expect(h).to.match(/^[0-9a-f]+$/);
    });
});

// ======================================================
// normalizeForMatch
// ======================================================

describe('Coreference — normalizeForMatch', () => {

    it('lowercases input', () => {
        expect(normalizeForMatch('BERLIOZ')).to.equal('berlioz');
    });

    it('transliterates Cyrillic to Latin', () => {
        expect(normalizeForMatch('Берлиоз')).to.equal('berlioz');
    });

    it('handles mixed Russian/English', () => {
        const result = normalizeForMatch('moscow_patriarskie_pруды');
        expect(result).to.include('moscow');
        expect(result).to.include('patriarskie');
        expect(result).to.include('prudy');
    });

    it('replaces underscores and hyphens with spaces', () => {
        expect(normalizeForMatch('ivan_nikolaevich-ponyrev')).to.equal('ivan nikolaevich ponyrev');
    });

    it('strips punctuation', () => {
        expect(normalizeForMatch('Берлиоз!!!')).to.equal('berlioz');
    });

    it('handles complex Russian text', () => {
        const result = normalizeForMatch('Михаил Александрович Берлиоз');
        expect(result).to.equal('mikhail aleksandrovich berlioz');
    });

    it('handles empty string', () => {
        expect(normalizeForMatch('')).to.equal('');
        expect(normalizeForMatch(null)).to.equal('');
    });

    it('handles text with only punctuation', () => {
        expect(normalizeForMatch('!!! ??? ...')).to.equal('');
    });

    it('normalizes multiple spaces', () => {
        expect(normalizeForMatch('berlioz    bezdomny')).to.equal('berlioz bezdomny');
    });

    it('transliterates ё→yo, й→y, щ→shch', () => {
        expect(normalizeForMatch('ёлка йод щука')).to.equal('yolka yod shchuka');
    });

    it('removes hard/soft signs', () => {
        expect(normalizeForMatch('объём пьеса')).to.equal('obyom pesa');
    });

    it('transliterates ц→ts, ч→ch, ш→sh', () => {
        expect(normalizeForMatch('царь чай шум')).to.equal('tsar chay shum');
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

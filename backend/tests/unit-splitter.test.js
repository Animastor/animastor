const { expect } = require('chai');
const {
    getUnitDurationSec,
    findLongUnits,
    splitBySentences,
    splitByCommas,
    splitByWordCount,
    emergencySplit,
    splitLongUnits,
    MAX_UNIT_DURATION_SEC,
} = require('../src/services/agent/unit-splitter');

describe('unit-splitter', function() {
    this.timeout(5000); // 5s timeout for all tests (no AI calls)

    describe('getUnitDurationSec', () => {
        it('returns 2s minimum for empty text', () => {
            expect(getUnitDurationSec('')).to.equal(2);
            expect(getUnitDurationSec(null)).to.equal(2);
            expect(getUnitDurationSec(undefined)).to.equal(2);
        });

        it('estimates ~0.3s per word', () => {
            const dur = getUnitDurationSec('one two three four five six seven eight nine ten');
            expect(dur).to.equal(3);
        });

        it('returns at least 2s minimum', () => {
            const dur = getUnitDurationSec('hello');
            expect(dur).to.equal(2);
        });
    });

    describe('findLongUnits', () => {
        it('returns empty for all short units', () => {
            const units = [
                { text: 'Hello world.' },
                { text: 'How are you?' },
                { text: 'Good.' },
            ];
            const long = findLongUnits(units);
            expect(long).to.have.length(0);
        });

        it('finds units exceeding MAX_UNIT_DURATION_SEC', () => {
            const longText = Array(70).fill('word').join(' ');
            const units = [
                { text: 'Hello.' },
                { text: longText },
                { text: 'Fine.' },
            ];
            const long = findLongUnits(units);
            expect(long).to.have.length(1);
            expect(long[0].index).to.equal(1);
            expect(long[0].duration).to.be.above(MAX_UNIT_DURATION_SEC);
        });

        it('finds multiple long units', () => {
            const longText = Array(70).fill('word').join(' ');
            const units = [
                { text: longText },
                { text: 'Short.' },
                { text: longText },
            ];
            const long = findLongUnits(units);
            expect(long).to.have.length(2);
        });
    });

    describe('splitBySentences', () => {
        it('splits text by sentences', () => {
            const text = 'First sentence. Second sentence! Third sentence?';
            const parts = splitBySentences(text);
            expect(parts).to.have.length(3);
            expect(parts[0]).to.match(/^First/);
            expect(parts[1]).to.match(/^Second/);
            expect(parts[2]).to.match(/^Third/);
        });

        it('returns original text if single sentence', () => {
            const text = 'Just one sentence.';
            const parts = splitBySentences(text);
            expect(parts).to.have.length(1);
            expect(parts[0]).to.equal(text);
        });
    });

    describe('splitByCommas', () => {
        it('splits text by commas', () => {
            const text = 'He walked in, sat down, and sighed deeply';
            const parts = splitByCommas(text);
            expect(parts).to.have.length(3);
            expect(parts[0]).to.match(/^He/);
            expect(parts[1]).to.match(/^sat/);
            expect(parts[2]).to.match(/^and/);
        });

        it('splits by semicolons', () => {
            const text = 'First part; second part; third part';
            const parts = splitByCommas(text);
            expect(parts).to.have.length(3);
        });

        it('splits by em-dash', () => {
            const text = 'One part—another part—third part';
            const parts = splitByCommas(text);
            expect(parts).to.have.length(3);
        });

        it('returns original if no separators', () => {
            const parts = splitByCommas('Just some text.');
            expect(parts).to.have.length(1);
        });
    });

    describe('splitByWordCount', () => {
        it('splits text into equal halves by word count', () => {
            const text = 'one two three four five six';
            const parts = splitByWordCount(text);
            expect(parts).to.have.length(2);
            expect(parts[0]).to.equal('one two three');
            expect(parts[1]).to.equal('four five six');
        });

        it('returns original for single word', () => {
            const parts = splitByWordCount('hello');
            expect(parts).to.have.length(1);
        });
    });

    describe('emergencySplit', () => {
        it('uses sentence split when text has multiple sentences', () => {
            const unit = { text: 'First part. Second part. Third part.', type: 'narration' };
            const result = emergencySplit(unit);
            expect(result).to.have.length(3);
            expect(result[0].type).to.equal('narration');
        });

        it('preserves audio for dialogue units on first fragment', () => {
            const unit = {
                text: 'Hello there. How are you?',
                type: 'dialogue',
                audio: { text: 'Hello there. How are you?', speaker: 'berlioz' },
            };
            const result = emergencySplit(unit);
            expect(result.length).to.be.at.least(2);
            expect(result[0].audio.speaker).to.equal('berlioz');
        });
    });

    describe('splitLongUnits (no AI — all short)', () => {
        it('returns original units when none exceed threshold', async () => {
            const units = [
                { text: 'Short one.', type: 'narration' },
                { text: 'Another short one.', type: 'narration' },
            ];
            const result = await splitLongUnits('session', {}, units, 0, 0, () => {});
            expect(result).to.equal(units); // same array reference
        });

        it('returns empty array for empty input', async () => {
            const result = await splitLongUnits('session', {}, [], 0, 0, () => {});
            expect(result).to.deep.equal([]);
        });

        it('returns empty array for null input', async () => {
            const result = await splitLongUnits('session', {}, null, 0, 0, () => {});
            expect(result).to.deep.equal([]);
        });
    });

    describe('splitLongUnits (AI mock)', () => {
        it('uses emergency fallback when AI returns empty (AI fails)', async () => {
            const proxyquire = require('proxyquire');
            const unitSplitterMock = proxyquire('../src/services/agent/unit-splitter', {
                './ai-caller': {
                    callAI: async () => ({ units: [] }),
                    logConversation: async () => {},
                },
                '../agent-session': {
                    updateSession: async () => {},
                },
            });

            // ~70 words → ~21s > 20s
            const longText = Array(70).fill('word').join(' ');
            const units = [
                { text: 'Short one.', type: 'narration' },
                { text: longText, type: 'narration' },
                { text: 'Another short.', type: 'narration' },
            ];
            const result = await unitSplitterMock.splitLongUnits('test-uuid', {}, units, 0, 0, () => {});
            // Long unit should be split via emergency fallback
            expect(result.length).to.be.above(units.length);
        });

        it('uses AI split when AI returns valid split', async () => {
            const proxyquire = require('proxyquire');
            const unitSplitterMock = proxyquire('../src/services/agent/unit-splitter', {
                './ai-caller': {
                    callAI: async () => ({
                        units: [
                            { text: 'First part of the long narration that goes on and on.', type: 'narration' },
                            { text: 'Second part continuing the thought.', type: 'narration' },
                        ],
                    }),
                    logConversation: async () => {},
                },
                '../agent-session': {
                    updateSession: async () => {},
                },
            });

            const longText = Array(70).fill('word').join(' ');
            const units = [{ text: longText, type: 'narration' }];
            const result = await unitSplitterMock.splitLongUnits('test-uuid', {}, units, 0, 0, () => {});
            // Should use AI result: 2 units
            expect(result).to.have.length(2);
            expect(result[0].text).to.include('First part');
        });

        it('preserves dialogue audio.speaker via AI split', async () => {
            const proxyquire = require('proxyquire');
            const unitSplitterMock = proxyquire('../src/services/agent/unit-splitter', {
                './ai-caller': {
                    callAI: async () => ({
                        units: [
                            { text: 'First sentence.', type: 'dialogue' },
                            { text: 'Second sentence.', type: 'dialogue' },
                        ],
                    }),
                    logConversation: async () => {},
                },
                '../agent-session': {
                    updateSession: async () => {},
                },
            });

            const longText = Array(70).fill('word').join(' ');
            const units = [{
                text: longText,
                type: 'dialogue',
                audio: { text: longText, speaker: 'berlioz' },
            }];
            const result = await unitSplitterMock.splitLongUnits('test-uuid', {}, units, 0, 0, () => {});
            expect(result).to.have.length(2);
            // First fragment should get audio from original
            expect(result[0].audio).to.be.ok;
            expect(result[0].audio.speaker).to.equal('berlioz');
        });
    });
});

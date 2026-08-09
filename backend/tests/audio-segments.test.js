const { expect } = require('chai');
const {
    padShortText,
    extractNarrationFromDialogueUnit,
    buildSegments,
    splitTextIntoChunks,
    splitDialogueIntoChunks,
    narratorVoice,
} = require('../src/audio/segments');

// Silence helpers.log during tests — only show warnings
const helpers = require('../src/audio/helpers');
const origLog = helpers.log;
const origWarn = helpers.warn;
before(() => {
    helpers.log = () => {};
});
after(() => {
    helpers.log = origLog;
    helpers.warn = origWarn;
});

describe('Audio Segments', () => {

    // ═══════════════════════════════════════════════════════
    // padShortText
    // ═══════════════════════════════════════════════════════
    describe('padShortText', () => {
        it('returns text unchanged when >= 40 chars', () => {
            const text = 'A sentence that is forty characters long!';
            expect(padShortText(text)).to.equal(text);
        });

        it('returns exact boundary (40 chars) unchanged', () => {
            const text = 'A'.repeat(40);
            expect(padShortText(text)).to.equal(text);
        });

        it('duplicates text + space when < 40 chars', () => {
            const text = 'Короткий текст';
            const result = padShortText(text);
            expect(result).to.equal(`${text} ${text}`);
        });

        it('returns the correct format for single word', () => {
            const text = 'Hello';
            expect(padShortText(text)).to.equal('Hello Hello');
        });

        it('duplicates punctuation correctly', () => {
            const text = '— Привет!';
            expect(padShortText(text)).to.equal('— Привет! — Привет!');
        });
    });

    // ═══════════════════════════════════════════════════════
    // splitTextIntoChunks
    // ═══════════════════════════════════════════════════════
    describe('splitTextIntoChunks', () => {
        it('returns empty for null/undefined/empty', () => {
            expect(splitTextIntoChunks(null)).to.deep.equal([]);
            expect(splitTextIntoChunks(undefined)).to.deep.equal([]);
            expect(splitTextIntoChunks('')).to.deep.equal([]);
            expect(splitTextIntoChunks('   ')).to.deep.equal([]);
        });

        it('returns single chunk for short text', () => {
            const result = splitTextIntoChunks('Hello world.');
            expect(result).to.deep.equal(['Hello world.']);
        });

        it('splits by sentence when text exceeds maxChars', () => {
            const s1 = 'A'.repeat(200) + '. ';
            const s2 = 'B'.repeat(100) + '.';
            const result = splitTextIntoChunks(s1 + s2, 250);
            expect(result).to.have.length(2);
            expect(result[0]).to.include('A');
            expect(result[1]).to.include('B');
        });
    });

    // ═══════════════════════════════════════════════════════
    // splitDialogueIntoChunks
    // ═══════════════════════════════════════════════════════
    describe('splitDialogueIntoChunks', () => {
        it('returns empty for null/undefined/empty', () => {
            expect(splitDialogueIntoChunks(null)).to.deep.equal([]);
            expect(splitDialogueIntoChunks(undefined)).to.deep.equal([]);
            expect(splitDialogueIntoChunks('')).to.deep.equal([]);
        });

        it('preserves speaker: text format', () => {
            const text = 'ivan: Hello world.';
            const result = splitDialogueIntoChunks(text);
            expect(result).to.deep.equal(['ivan: Hello world.']);
        });

        it('splits long dialogue by speaker lines', () => {
            const text = 'ivan: ' + 'A'.repeat(200) + '\n' + 'maria: ' + 'B'.repeat(100);
            const result = splitDialogueIntoChunks(text, 250);
            expect(result).to.have.length(2);
            expect(result[0]).to.match(/^ivan:/);
            expect(result[1]).to.match(/^maria:/);
        });

        it('keeps natural-designation speakers (Cyrillic, spaces) as labels', () => {
            const text = 'женщина в будочке: ' + 'A'.repeat(200) + '\n' + 'anna_smirnova: ' + 'B'.repeat(100);
            const result = splitDialogueIntoChunks(text, 250);
            expect(result).to.have.length(2);
            expect(result[0]).to.match(/^женщина в будочке:/);
            expect(result[1]).to.match(/^anna_smirnova:/);
        });
    });

    // ═══════════════════════════════════════════════════════
    // isAtWordBoundary (tested through extractNarrationFromDialogueUnit)
    // ═══════════════════════════════════════════════════════
    describe('extractNarrationFromDialogueUnit (word-boundary guard)', () => {
        it('rejects substring collision: "да" inside "дала"', () => {
            const unit = {
                text: '— Дала, — ответила женщина.',
                audio: { text: 'да', speaker: 'zhenshchina' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            // "да" matches inside "Дала" at word-start → isAtWordBoundary
            // checks if char AFTER match ("л") is a letter → true → not at boundary
            expect(result).to.equal(null);
        });

        it('rejects substring collision: "но" inside "Норвегия"', () => {
            const unit = {
                text: 'Норвегия — красивая страна.',
                audio: { text: 'но', speaker: 'speaker' }
            };
            expect(extractNarrationFromDialogueUnit(unit)).to.equal(null);
        });

        it('accepts word-boundary match: "да" as standalone word', () => {
            const unit = {
                text: '— Да, — ответила женщина.',
                audio: { text: 'Да', speaker: 'zhenshchina' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.not.equal(null);
            expect(result).to.not.equal('');
            expect(result.pre).to.equal('');
            expect(result.post).to.include('ответила женщина');
        });

        it('rejects single-character dialogue matching inside longer text', () => {
            const unit = {
                text: 'Абракадабра.',
                audio: { text: 'а', speaker: 'speaker' }
            };
            // "а" appears at multiple positions — but always inside a word
            expect(extractNarrationFromDialogueUnit(unit)).to.equal(null);
        });
    });

    // ═══════════════════════════════════════════════════════
    // extractNarrationFromDialogueUnit
    // ═══════════════════════════════════════════════════════
    describe('extractNarrationFromDialogueUnit', () => {
        // --- Null/edge cases ---
        it('returns null for missing audio.text', () => {
            expect(extractNarrationFromDialogueUnit({ text: 'Hello', audio: {} })).to.equal(null);
            expect(extractNarrationFromDialogueUnit({ text: 'Hello' })).to.equal(null);
        });

        it('returns null for missing unit.text', () => {
            expect(extractNarrationFromDialogueUnit({ audio: { text: 'Hi' } })).to.equal(null);
        });

        it('returns null when dialogue text not found in full text', () => {
            const unit = {
                text: '— Совсем другой текст.',
                audio: { text: 'Не найдено', speaker: 'x' }
            };
            expect(extractNarrationFromDialogueUnit(unit)).to.equal(null);
        });

        it('returns null for empty normDialogue (only opener characters)', () => {
            const unit = {
                text: '— Narration here.',
                audio: { text: '— ', speaker: 'x' }
            };
            expect(extractNarrationFromDialogueUnit(unit)).to.equal(null);
        });

        // --- Pattern A: post-dialogue narration ---
        it('Pattern A: extracts post-dialogue narration (Russian em-dash)', () => {
            const unit = {
                text: '— Нарзану нету, — ответила женщина.',
                audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.pre).to.equal('');
            expect(result.post).to.include('ответила женщина');
        });

        it('Pattern A: extracts post-dialogue narration (English quotes)', () => {
            const unit = {
                text: '"No," said the woman.',
                audio: { text: 'No', speaker: 'woman' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.pre).to.equal('');
            expect(result.post).to.include('said the woman');
        });

        it('Pattern A: removes only leading opener markers from normFull', () => {
            // The opening quotes should be stripped for matching, but
            // preservation of trailing punctuation is handled by pre/post
            const unit = {
                text: '«Привет, — сказал он.»',
                audio: { text: 'Привет', speaker: 'on' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.post).to.include('сказал он');
        });

        // --- Pattern B: pre-dialogue narration ---
        it('Pattern B: extracts pre-dialogue narration (Russian colon)', () => {
            const unit = {
                text: 'Женщина ответила: — Нарзану нету.',
                audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.pre).to.include('Женщина ответила');
            expect(result.post).to.equal('');
        });

        it('Pattern B: extracts pre-dialogue narration (English)', () => {
            const unit = {
                text: 'The woman said: No.',
                audio: { text: 'No', speaker: 'woman' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.pre).to.include('The woman said');
            expect(result.post).to.equal('');
        });

        // --- Both pre and post ---
        it('extracts both pre and post narration', () => {
            const unit = {
                text: 'Он подошёл: — Привет, — сказал он.',
                audio: { text: 'Привет', speaker: 'on' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.pre).to.include('Он подошёл');
            expect(result.post).to.include('сказал он');
        });

        // --- Pure dialogue (no narration) ---
        it('returns "" for pure dialogue with no surrounding narration', () => {
            const unit = {
                text: '— Нарзану нету.',
                audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.equal('');
        });

        it('returns "" when only trailing punctuation (< 2 chars)', () => {
            const unit = {
                text: '— Да.',
                audio: { text: 'Да', speaker: 'x' }
            };
            expect(extractNarrationFromDialogueUnit(unit)).to.equal('');
        });

        // --- Multilingual ---
        it('handles french guillemets', () => {
            const unit = {
                text: '« Non, » répondit la femme.',
                audio: { text: 'Non', speaker: 'femme' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.post).to.include('répondit la femme');
        });

        it('handles german low-high quotes', () => {
            const unit = {
                text: '„Nein“, sagte die Frau.',
                audio: { text: 'Nein', speaker: 'frau' }
            };
            const result = extractNarrationFromDialogueUnit(unit);
            expect(result).to.be.an('object');
            expect(result.post).to.include('sagte die Frau');
        });
    });

    // ═══════════════════════════════════════════════════════
    // buildSegments
    // ═══════════════════════════════════════════════════════
    describe('buildSegments — narration scene', () => {
        it('returns segments for narration scene', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'narration',
                payload: { audio: { full_text: 'Hello world. How are you today? I am fine, thank you.' } }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('How are you today');
            expect(segments[0].padded).to.equal(false);
        });

        it('pads short narration text (< 40 chars)', () => {
            // Use text without sentence-ending punctuation so splitTextIntoChunks
            // keeps it as one chunk after padShortText duplication
            const entry = {
                runtime_type: 'scene',
                scene_type: 'narration',
                payload: { audio: { full_text: 'Short padded' } }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Short padded');
            expect(segments[0].padded).to.equal(true);
        });

        it('handles cover scene type with padding', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'cover',
                payload: { audio: { full_text: 'Cover text' } }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Cover text');
            expect(segments[0].padded).to.equal(true);
        });

        it('handles chapter_intro scene type', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'chapter_intro',
                payload: { audio: { full_text: 'Chapter One: The Beginning' } }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
        });
    });

    describe('buildSegments — dialogue scene', () => {
        it('returns dialogue segment for pure dialogue unit', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: '— Нарзану нету.',
                        audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('dialogue');
            expect(segments[0].text).to.equal('zhenshchina: Нарзану нету');
            // dialogue segments should NOT have padded flag (not applicable)
        });

        it('keeps natural designation of an episodic speaker (no snake_case forced)', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: '— Дайте воды, — попросила женщина в будочке.',
                        audio: { text: 'Дайте воды', speaker: 'женщина в будочке' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            expect(segments.some(s => s.segment_type === 'dialogue' && s.text === 'женщина в будочке: Дайте воды')).to.equal(true);
        });

        it('generates hybrid for Pattern A (post-dialogue narration)', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: '— Нарзану нету, — ответила женщина.',
                        audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // Expected: dialogue + narration post
            expect(segments).to.have.length(2);
            expect(segments[0].segment_type).to.equal('dialogue');
            expect(segments[0].text).to.equal('zhenshchina: Нарзану нету');
            expect(segments[1].segment_type).to.equal('narration');
            expect(segments[1].text).to.include('ответила женщина');
        });

        it('generates hybrid for Pattern B (pre-dialogue narration)', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: 'Женщина ответила: — Нарзану нету.',
                        audio: { text: 'Нарзану нету', speaker: 'zhenshchina' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // Expected: narration pre + dialogue
            expect(segments).to.have.length(2);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Женщина ответила');
            expect(segments[1].segment_type).to.equal('dialogue');
            expect(segments[1].text).to.equal('zhenshchina: Нарзану нету');
        });

        it('generates hybrid for both pre and post narration', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: 'Он подошёл: — Привет, — сказал он.',
                        audio: { text: 'Привет', speaker: 'on' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // Expected: narration pre + dialogue + narration post
            expect(segments).to.have.length(3);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Он подошёл');
            expect(segments[1].segment_type).to.equal('dialogue');
            expect(segments[1].text).to.equal('on: Привет');
            expect(segments[2].segment_type).to.equal('narration');
            expect(segments[2].text).to.include('сказал он');
        });

        it('falls back to narrator for crooked dialogue (substring collision)', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: '— Дала, — ответила женщина.',
                        audio: { text: 'да', speaker: 'zhenshchina' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // "да" matches inside "Дала" → fallback → narrator reads full text
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Дала');
            expect(segments[0].text).to.include('ответила женщина');
        });

        it('interleaves narration and dialogue units correctly', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [
                        { type: 'narration', text: 'Они подошли к ларьку.' },
                        { type: 'dialogue',
                            text: '— Дайте нарзану, — попросил Берлиоз.',
                            audio: { text: 'Дайте нарзану', speaker: 'berlioz' } },
                        { type: 'dialogue',
                            text: '— Нарзану нету, — ответила женщина.',
                            audio: { text: 'Нарзану нету', speaker: 'zhenshchina' } },
                        { type: 'narration', text: 'Женщина вздохнула.' },
                    ]
                }
            };
            const segments = buildSegments(entry);
            // Expected: nar(1) + dialogue + post-nar(1) + dialogue + post-nar(2) + nar(2)
            expect(segments.length).to.be.at.least(5);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('ларьку');
            expect(segments[1].segment_type).to.equal('dialogue');
            expect(segments[1].text).to.include('berlioz: Дайте нарзану');
            expect(segments[2].segment_type).to.equal('narration');
            expect(segments[2].text).to.include('попросил Берлиоз');
            expect(segments[3].segment_type).to.equal('dialogue');
            expect(segments[3].text).to.include('zhenshchina: Нарзану нету');
            expect(segments[4].segment_type).to.equal('narration');
            expect(segments[4].text).to.include('ответила женщина');
            // Last is the standalone narration from unit 4
            expect(segments[segments.length - 1].segment_type).to.equal('narration');
            expect(segments[segments.length - 1].text).to.include('вздохнула');
        });

        it('skips typography units', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [
                        { type: 'typography', text: 'Chapter 1' },
                        { type: 'narration', text: 'The story begins.' },
                    ]
                }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('The story begins.');
        });

        it('skips dialogue units without speaker or text', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [
                        { type: 'dialogue' },
                        { type: 'narration', text: 'Only narration.' },
                    ]
                }
            };
            const segments = buildSegments(entry);
            expect(segments).to.have.length(1);
        });

        it('returns empty array for dialogue scene with no valid units', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: { units: [] }
            };
            expect(buildSegments(entry)).to.deep.equal([]);
        });

        it('returns empty array for unknown runtime type', () => {
            const entry = { runtime_type: 'unknown' };
            expect(buildSegments(entry)).to.deep.equal([]);
        });

        it('pads short embedded narration (pre) when < 40 chars', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: 'Он: — Привет.',
                        audio: { text: 'Привет', speaker: 'on' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // pre = 'Он: —' (5 chars) → padded
            expect(segments).to.have.length(2);
            expect(segments[0].segment_type).to.equal('narration');
            expect(segments[0].text).to.include('Он:');
            expect(segments[0].padded).to.equal(true);
            expect(segments[1].segment_type).to.equal('dialogue');
        });

        it('pads short embedded narration (post) when < 40 chars', () => {
            const entry = {
                runtime_type: 'scene',
                scene_type: 'dialogue',
                payload: {
                    units: [{
                        type: 'dialogue',
                        text: '— Привет, — сказал.',
                        audio: { text: 'Привет', speaker: 'on' }
                    }]
                }
            };
            const segments = buildSegments(entry);
            // post = ', — сказал.' (11 chars) → padShortText gives 23 chars
            expect(segments).to.have.length(2);
            expect(segments[0].segment_type).to.equal('dialogue');
            expect(segments[1].segment_type).to.equal('narration');
            expect(segments[1].padded).to.equal(true);
            expect(segments[1].text).to.include('сказал');
        });
    });

    // ═══════════════════════════════════════════════════════
    // narratorVoice
    // ═══════════════════════════════════════════════════════
    describe('narratorVoice', () => {
        it('returns narrator voice instruction from voices.narrator', () => {
            const scene = {};
            const book = {
                voices: { narrator: { instruction: 'calm russian male' } }
            };
            expect(narratorVoice(scene, book)).to.equal('calm russian male');
        });

        it('falls back to bible.narrator.voice.instruction', () => {
            const scene = {};
            const book = {
                bible: { narrator: { voice: { instruction: 'deep female' } } }
            };
            expect(narratorVoice(scene, book)).to.equal('deep female');
        });

        it('uses scene audio voice override', () => {
            const scene = { audio: { voice: 'special_narrator' } };
            const book = {
                characters: [{ id: 'special_narrator', voice: { instruction: 'special tone' } }]
            };
            expect(narratorVoice(scene, book)).to.equal('special tone');
        });

        it('returns empty string when no voice found', () => {
            expect(narratorVoice({}, {})).to.equal('');
        });
    });
});

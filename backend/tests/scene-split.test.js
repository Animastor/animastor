const { expect } = require('chai');
const { estimateSpeechDurationSec } = require('../src/services/placeholder-audio');
const {
    splitIntoSentences,
    buildFallbackScenes,
    resolveSceneProgress,
    MAX_SCENES_PER_CHUNK,
    SCENE_TARGET_SEC,
    SCENE_MAX_SEC,
    SCENE_MIN_SEC,
} = require('../src/services/agent-service');
const sourceCoverage = require('../src/services/source-coverage');

describe('Scene Splitting (Phase A.3 revamp)', () => {

    describe('sequential scene-window progress', () => {
        it('caps generated scenes at eight per window', () => {
            expect(MAX_SCENES_PER_CHUNK).to.equal(8);
            expect(SCENE_TARGET_SEC).to.equal(20);
            expect(SCENE_MAX_SEC).to.equal(30);
            expect(SCENE_MIN_SEC).to.equal(5);
        });

        it('advances to the end of the last returned scene, not to the end of the buffer', () => {
            const source = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
            const scenes = [
                { text: 'First sentence.' },
                { text: 'Second sentence.' },
                { text: 'Third sentence.' },
            ];

            const progress = resolveSceneProgress(source, scenes, 100);
            expect(progress.coverage.ok).to.equal(true);
            expect(progress.nextOffset).to.equal(100 + source.indexOf('Fourth sentence.'));
            expect(progress.coverage.covered_end_offset)
                .to.equal(100 + source.indexOf('Third sentence.') + 'Third sentence.'.length);
        });

        it('can find the last scene end by full text or tail fragment', () => {
            const source = 'Intro text. Processed scene begins here. It ends on this sentence.\n\nUnused tail.';
            const sceneText = 'Processed scene begins here. It ends on this sentence.';

            const found = sourceCoverage.findLastSceneEndOffset(source, sceneText, { sourceOffsetBase: 10 });
            expect(found.ok).to.equal(true);
            expect(found.source_end).to.equal(10 + source.indexOf(sceneText) + sceneText.length);
            expect(found.next_offset).to.equal(10 + source.indexOf('Unused tail.'));
        });
    });

    describe('estimateSpeechDurationSec', () => {
        it('returns SPEECH_MIN_SEC for empty/null/whitespace', () => {
            expect(estimateSpeechDurationSec('')).to.equal(2);
            expect(estimateSpeechDurationSec(null)).to.equal(2);
            expect(estimateSpeechDurationSec(undefined)).to.equal(2);
            expect(estimateSpeechDurationSec('   ')).to.equal(2);
        });

        it('returns ~0.3s per word for short text (floored at SPEECH_MIN_SEC)', () => {
            const dur = estimateSpeechDurationSec('Hello world');
            expect(dur).to.equal(2);
        });

        it('returns ~0.3s per word for longer text', () => {
            const words = Array(65).fill('word').join(' ');
            const dur = estimateSpeechDurationSec(words);
            expect(dur).to.be.closeTo(19.5, 0.5);
        });

        it('rounds to 0.1s precision', () => {
            const dur = estimateSpeechDurationSec('one two three');
            const decimals = (dur % 1).toFixed(1).split('.')[1];
            expect(decimals).to.have.length.at.most(1);
        });

        it('treats multiple spaces as one delimiter', () => {
            const a = estimateSpeechDurationSec('a b c');
            const b = estimateSpeechDurationSec('a   b   c');
            expect(a).to.equal(b);
        });

        it('handles russian text correctly (floored at SPEECH_MIN_SEC)', () => {
            const text = 'Мама мыла раму';
            const dur = estimateSpeechDurationSec(text);
            expect(dur).to.equal(2);
        });
    });

    describe('splitIntoSentences', () => {
        it('splits on terminal punctuation (. ! ? …)', () => {
            const result = splitIntoSentences('Hello world. How are you? I am fine!');
            expect(result).to.deep.equal(['Hello world.', 'How are you?', 'I am fine!']);
        });

        it('keeps closing quotes with terminal punctuation', () => {
            const result = splitIntoSentences('He said "No." She left.');
            expect(result).to.deep.equal(['He said "No."', 'She left.']);
        });

        it('splits on double newline (paragraph break)', () => {
            const result = splitIntoSentences('First paragraph.\n\nSecond paragraph.');
            expect(result).to.deep.equal(['First paragraph.', 'Second paragraph.']);
        });

        it('handles ellipsis as sentence boundary', () => {
            const result = splitIntoSentences('I wondered… What if?');
            expect(result).to.deep.equal(['I wondered…', 'What if?']);
        });

        it('returns empty array for empty input', () => {
            expect(splitIntoSentences('')).to.deep.equal([]);
            expect(splitIntoSentences(null)).to.deep.equal([]);
            expect(splitIntoSentences(undefined)).to.deep.equal([]);
        });

        it('handles mixed russian punctuation', () => {
            const result = splitIntoSentences('— Привет! — сказал он. — Как дела?');
            expect(result).to.have.length(3);
            expect(result[0]).to.include('Привет!');
            expect(result[1]).to.include('сказал он.');
            expect(result[2]).to.include('Как дела?');
        });

        it('consumes consecutive terminal punctuation', () => {
            const result = splitIntoSentences('Really?! I doubt it.');
            expect(result).to.deep.equal(['Really?!', 'I doubt it.']);
        });

        it('splits on abbreviations with periods (known limitation — simple heuristic)', () => {
            const result = splitIntoSentences('Dr. Smith arrived. He was late.');
            expect(result).to.have.length(3);
            expect(result[0]).to.equal('Dr.');
            expect(result[2]).to.equal('He was late.');
        });
    });

    describe('buildFallbackScenes', () => {
        it('returns empty array for empty input', () => {
            expect(buildFallbackScenes('')).to.deep.equal([]);
            expect(buildFallbackScenes(null)).to.deep.equal([]);
        });

        it('produces one scene for short text', () => {
            const scenes = buildFallbackScenes('Hello world.');
            expect(scenes).to.have.length(1);
            expect(scenes[0].text).to.equal('Hello world.');
            expect(scenes[0].type).to.equal('narration');
        });

        it('each scene ends on a complete sentence', () => {
            const text = Array(30).fill('A short sentence.').join(' ');
            const scenes = buildFallbackScenes(text);
            for (const s of scenes) {
                const trimmed = s.text.trim();
                expect(trimmed).to.match(/[.!?…"»]$/);
            }
        });

        it('scenes concatenated verbatim reconstruct the source', () => {
            const sentences = [
                'First sentence of the story.',
                'Second sentence follows.',
                'Third one is here too.',
                'Fourth keeps the pattern going.',
                'Fifth and final sentence ends it.',
            ];
            const text = sentences.join(' ');
            const scenes = buildFallbackScenes(text);
            const reconstructed = scenes.map(s => s.text).join(' ');
            expect(reconstructed).to.equal(text);
        });

        it('produces at most one scene per sentence even when sentence exceeds max (known limitation)', () => {
            const manyWords = Array(300).fill('word').join(' ') + '.';
            const scenes = buildFallbackScenes(manyWords);
            expect(scenes).to.have.length(1);
            const wordCount = scenes[0].text.split(/\s+/).filter(Boolean).length;
            expect(wordCount).to.equal(300);
        });

        it('preserves original whitespace including paragraph breaks (\n\n → \n\n, not space)', () => {
            const text = 'First paragraph sentence one. Second sentence ends here.\n\nSecond paragraph starts. And continues.';
            const scenes = buildFallbackScenes(text);
            const reconstructed = scenes.map(s => s.text).join('');
            expect(reconstructed).to.equal(text);
        });

        it('preserves original whitespace with irregular spacing', () => {
            const text = 'Hello.   \n\nWorld.   Fine.';
            const scenes = buildFallbackScenes(text);
            const reconstructed = scenes.map(s => s.text).join('');
            expect(reconstructed).to.equal(text);
        });

        it('falls back to paragraph split when no sentence boundaries exist', () => {
            const text = 'A single unsplittable block of text with no punctuation whatsoever just words ' +
                Array(200).fill('something').join(' ') + ' at the end';
            const scenes = buildFallbackScenes(text);
            expect(scenes.length).to.be.at.least(1);
            const reconstructed = scenes.map(s => s.text).join('');
            const originalStripped = text.replace(/\s+/g, '');
            const reconStripped = reconstructed.replace(/\s+/g, '');
            expect(reconStripped).to.equal(originalStripped);
        });

        it('every scene has required fields', () => {
            const scenes = buildFallbackScenes('Hello world. Goodbye world.');
            for (const s of scenes) {
                expect(s).to.have.all.keys('title', 'text', 'type', 'participants', 'location');
                expect(s.type).to.equal('narration');
                expect(Array.isArray(s.participants)).to.be.true;
            }
        });
    });
});

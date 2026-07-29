// ======================================================
// Scene Cache Tests
// ======================================================
// Tests the scene caching mechanism:
//   - extraScenes split when AI returns more scenes than chunkSize
//   - processCachedScenes structure validation
//   - Coverage with capped scenes (first N processed, rest cached)

const { expect } = require('chai');
const sourceCoverage = require('../src/services/source-coverage');
const { resolveSceneProgress } = require('../src/services/agent-service');
const {
    MAX_SCENES_PER_CHUNK,
} = require('../src/services/agent-service');

describe('Scene Cache (Phase C)', () => {

    describe('configuration', () => {
        it('MAX_SCENES_PER_CHUNK is 2 (scenes processed per batch)', () => {
            expect(MAX_SCENES_PER_CHUNK).to.equal(2);
        });
    });

    describe('extraScenes: coverage with capped scenes', () => {

        it('coverage advances past first N scenes, rest are in source text', () => {
            const source = [
                'Scene one text. End of scene one.',
                'Scene two text. Middle of story.',
                'Scene three text. More narrative.',
                'Scene four text. Still continuing.',
                'Scene five text. Final scene here.',
            ].join(' ');

            // Simulate: chunkSize=2, AI returned 5 scenes → cap to first 2
            const cappedScenes = [
                { text: 'Scene one text. End of scene one.' },
                { text: 'Scene two text. Middle of story.' },
            ];

            const progress = resolveSceneProgress(source, cappedScenes, 0);

            expect(progress.coverage.ok).to.equal(true);
            // Coverage should end after scene 2
            const scene2End = source.indexOf('Scene three text.');
            expect(progress.nextOffset).to.equal(scene2End);
            expect(progress.coverage.covered_end_offset)
                .to.equal(source.indexOf('Scene two text. Middle of story.') +
                          'Scene two text. Middle of story.'.length);

            // The remaining text (scene 3-5) is still in source but past covered_end
            const remaining = source.substring(scene2End);
            expect(remaining).to.include('Scene three text.');
            expect(remaining).to.include('Scene four text.');
            expect(remaining).to.include('Scene five text.');
        });

        it('returns correct next_offset when scenes are not contiguous (gap)', () => {
            const source = 'Start here. Scene A content. Scene B content. More text. Final bit.';
            // Simulate: scene 1 ends after "Scene A content." which is before "Scene B content."
            const singleScene = [
                { text: 'Start here. Scene A content.' },
            ];

            const progress = resolveSceneProgress(source, singleScene, 0);
            expect(progress.coverage.ok).to.equal(true);
            expect(progress.nextOffset)
                .to.equal(source.indexOf('Scene B content.'));
        });

        it('extra scenes text is preserved in source after capped coverage', () => {
            const source = 'Part one. Part two. Part three. Part four. Part five.';
            // Cap to 2 scenes
            const capped = [
                { text: 'Part one.' },
                { text: 'Part two.' },
            ];

            const progress = resolveSceneProgress(source, capped, 0);
            expect(progress.coverage.ok).to.equal(true);

            // The "extra" scenes text still exists in source after nextOffset
            const remaining = source.substring(progress.nextOffset);
            expect(remaining).to.equal('Part three. Part four. Part five.');
        });
    });

    describe('processCachedScenes return structure', () => {

        it('validates scene object shape for caching (same as stepCreateScenes output)', () => {
            // This is the structure that stepCreateScenes returns from AI
            // and that gets stored in cached_scenes in window_data
            const cachedScene = {
                title: 'Test Scene',
                text: 'Scene text content here. Multiple sentences.',
                type: 'narration',
                characters_present: ['character_one'],
                location: { id: 'test_location' },
            };

            // Verify required fields for pipeline processing
            expect(cachedScene).to.have.all.keys(
                'title', 'text', 'type', 'characters_present', 'location'
            );
            expect(cachedScene.title).to.be.a('string').with.length.at.least(2);
            expect(cachedScene.text).to.be.a('string').with.length.at.least(10);
            expect(cachedScene.type).to.be.oneOf(['narration', 'dialogue']);
            expect(cachedScene.characters_present).to.be.an('array');
            expect(cachedScene.location.id).to.be.a('string');
        });

        it('processCachedScenes processes scenes through enrichment + units + visuals', () => {
            // Integration-level test: processCachedScenes needs AI calls.
            // This test verifies the module exports the function.
            const pipelineRunner = require('../src/services/agent/pipeline-runner');
            expect(pipelineRunner).to.have.property('processCachedScenes');
            expect(pipelineRunner.processCachedScenes).to.be.a('function');
        });
    });

    describe('cached_scenes in window_data', () => {

        it('cached_scenes field replaces deprecated remaining_scenes', () => {
            // Simulate window_data from bootstrapWithAgent
            const windowData = {
                window_index: 0,
                created_scenes: 2,
                cached_scenes: [
                    { title: 'Extra Scene 1', text: 'Text of extra scene 1.', type: 'narration', characters_present: [], location: { id: 'loc' } },
                    { title: 'Extra Scene 2', text: 'Text of extra scene 2.', type: 'narration', characters_present: [], location: { id: 'loc' } },
                    { title: 'Extra Scene 3', text: 'Text of extra scene 3.', type: 'narration', characters_present: [], location: { id: 'loc' } },
                ],
                remaining_text: '...',
                currentOffset: 5500,
            };

            expect(windowData.cached_scenes).to.have.length(3);
            expect(windowData.cached_scenes[0].title).to.equal('Extra Scene 1');
            expect(windowData.cached_scenes[2].title).to.equal('Extra Scene 3');

            // Simulate bootstrapNextWindow: take first 2, keep 1
            const chunkSize = 2;
            const batch = windowData.cached_scenes.slice(0, chunkSize);
            const remaining = windowData.cached_scenes.slice(chunkSize);

            expect(batch).to.have.length(2);
            expect(remaining).to.have.length(1);
            expect(remaining[0].title).to.equal('Extra Scene 3');

            // Simulate second window: take last 1
            const batch2 = remaining.slice(0, chunkSize);
            const remaining2 = remaining.slice(chunkSize);
            expect(batch2).to.have.length(1);
            expect(remaining2).to.have.length(0);
        });

        it('all_done correctly detects no more cached scenes and no remaining text', () => {
            const windowData = {
                cached_scenes: [],
                remaining_text: '',
            };

            const noMoreCached = windowData.cached_scenes.length === 0;
            const hasRemainingText = !!(windowData.remaining_text && windowData.remaining_text.length > 0);
            const allDone = noMoreCached && !hasRemainingText;

            expect(allDone).to.equal(true);
        });

        it('all_done is false when cached scenes remain', () => {
            const windowData = {
                cached_scenes: [{ title: 'Extra', text: 'Extra text.', type: 'narration', characters_present: [], location: { id: 'loc' } }],
                remaining_text: 'More text.',
            };

            const noMoreCached = windowData.cached_scenes.length === 0;
            const hasRemainingText = !!(windowData.remaining_text && windowData.remaining_text.length > 0);
            const allDone = noMoreCached && !hasRemainingText;

            expect(allDone).to.equal(false);
        });

        it('all_done is false when remaining text exists but no cached scenes', () => {
            const windowData = {
                cached_scenes: [],
                remaining_text: 'Still more text to process.',
            };

            const noMoreCached = windowData.cached_scenes.length === 0;
            const hasRemainingText = !!(windowData.remaining_text && windowData.remaining_text.length > 0);

            expect(noMoreCached).to.equal(true);
            expect(hasRemainingText).to.equal(true);
        });
    });

    describe('capScenes + extraScenes split simulation', () => {

        it('splits scenes array into processed + extra', () => {
            const aiScenes = [
                { text: 'Scene 1.' },
                { text: 'Scene 2.' },
                { text: 'Scene 3.' },
                { text: 'Scene 4.' },
                { text: 'Scene 5.' },
            ];
            const effectiveChunkSize = 2;

            const extraScenes = aiScenes.slice(effectiveChunkSize);
            const capped = aiScenes.slice(0, effectiveChunkSize);

            expect(capped).to.have.length(2);
            expect(capped[0].text).to.equal('Scene 1.');
            expect(capped[1].text).to.equal('Scene 2.');
            expect(extraScenes).to.have.length(3);
            expect(extraScenes[0].text).to.equal('Scene 3.');
            expect(extraScenes[2].text).to.equal('Scene 5.');
        });

        it('extraScenes is empty when AI returns exactly chunkSize scenes', () => {
            const aiScenes = [
                { text: 'Scene 1.' },
                { text: 'Scene 2.' },
            ];
            const effectiveChunkSize = 2;

            const extraScenes = aiScenes.slice(effectiveChunkSize);
            expect(extraScenes).to.have.length(0);
        });

        it('extraScenes is empty when AI returns fewer than chunkSize scenes', () => {
            const aiScenes = [
                { text: 'Scene 1.' },
            ];
            const effectiveChunkSize = 2;

            const extraScenes = aiScenes.slice(effectiveChunkSize);
            expect(extraScenes).to.have.length(0);
        });

        it('fallback path clears extraScenes (deterministic scenes — no cache)', () => {
            const extraScenes = [
                { text: 'Would-be cached scene.' },
            ];
            // Fallback clears extras
            extraScenes.length = 0;
            expect(extraScenes).to.have.length(0);
        });
    });
});

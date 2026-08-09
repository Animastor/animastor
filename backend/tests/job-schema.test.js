const { expect } = require('chai');
const jobSchema = require('../src/runtime/job-schema');

describe('job-schema (единый контракт job_id)', () => {
    describe('buildJobId', () => {
        it('builds id with valid type suffix', () => {
            expect(jobSchema.buildJobId('book_ch-1_sc-2_0001', 'audio')).to.equal('book_ch-1_sc-2_0001:audio');
        });

        it('rejects unknown types', () => {
            expect(() => jobSchema.buildJobId('x', 'music')).to.throw(/unknown job type/);
        });

        it('rejects empty assetId', () => {
            expect(() => jobSchema.buildJobId('', 'audio')).to.throw(/invalid assetId/);
        });
    });

    describe('parseJobId — audio chunk', () => {
        it('parses bookId with underscores', () => {
            const p = jobSchema.parseJobId('evening_city_demo_ch-ce87_sc-6c4e_0003:audio');
            expect(p).to.deep.include({
                kind: 'audio_chunk',
                bookId: 'evening_city_demo',
                chapterId: 'ch-ce87',
                sceneId: 'sc-6c4e',
                chunkIndex: '0003',
            });
        });

        it('rejects audio id without a 4-digit chunk index', () => {
            expect(jobSchema.parseJobId('book_ch_sc:audio')).to.equal(null);
        });
    });

    describe('parseJobId — IU image', () => {
        it('parses new :iu_image format', () => {
            const p = jobSchema.parseJobId('my_book_ch-1_sc-2_iu-abc:iu_image');
            expect(p).to.deep.include({
                kind: 'iu_image', bookId: 'my_book', chapterId: 'ch-1', sceneId: 'sc-2', iuId: 'iu-abc',
            });
        });

        it('detects legacy :image with _iu marker as iu_image', () => {
            const p = jobSchema.parseJobId('my_book_ch-1_sc-2_iu-abc:image');
            expect(p.kind).to.equal('iu_image');
            expect(p.iuId).to.equal('iu-abc');
        });
    });

    describe('parseJobId — scene image / video', () => {
        it('parses legacy scene image', () => {
            const p = jobSchema.parseJobId('my_book_ch-1_sc-2:image');
            expect(p).to.deep.include({ kind: 'scene_image', bookId: 'my_book', chapterId: 'ch-1', sceneId: 'sc-2' });
        });

        it('parses video with group suffix', () => {
            const p = jobSchema.parseJobId('my_book_ch-1_sc-2_g3:video');
            expect(p).to.deep.include({
                kind: 'scene_video', bookId: 'my_book', chapterId: 'ch-1', sceneId: 'sc-2', groupSuffix: '_g3',
            });
        });

        it('parses video without group suffix', () => {
            const p = jobSchema.parseJobId('my_book_ch-1_sc-2:video');
            expect(p.groupSuffix).to.equal('');
            expect(p.sceneId).to.equal('sc-2');
        });
    });

    describe('roundtrip', () => {
        it('parseJobId(buildJobId(x)) preserves assetId and type', () => {
            const cases = [
                ['book_ch-1_sc-2_0001', 'audio'],
                ['book_ch-1_sc-2_iu-x', 'iu_image'],
                ['book_ch-1_sc-2', 'image'],
                ['book_ch-1_sc-2_g1', 'video'],
            ];
            for (const [assetId, type] of cases) {
                const p = jobSchema.parseJobId(jobSchema.buildJobId(assetId, type));
                expect(p, `${assetId}:${type}`).to.not.equal(null);
                expect(p.assetId).to.equal(assetId);
                expect(p.type).to.equal(type);
            }
        });
    });

    describe('garbage input', () => {
        it('returns null for missing suffix, unknown suffix, empty and non-string', () => {
            expect(jobSchema.parseJobId('no-suffix')).to.equal(null);
            expect(jobSchema.parseJobId('x:music')).to.equal(null);
            expect(jobSchema.parseJobId('')).to.equal(null);
            expect(jobSchema.parseJobId(null)).to.equal(null);
        });
    });
});

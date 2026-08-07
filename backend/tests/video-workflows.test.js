const { expect } = require('chai');
const wf = require('../src/workflows/video/video-workflows');

describe('toValidLTXFrames', () => {
    it('returns 1 for 0-1 frames', () => {
        expect(wf.toValidLTXFrames(0)).to.equal(1);
        expect(wf.toValidLTXFrames(1)).to.equal(1);
    });
    it('rounds up to 8n+1', () => {
        expect(wf.toValidLTXFrames(2)).to.equal(9);
        expect(wf.toValidLTXFrames(8)).to.equal(9);
        expect(wf.toValidLTXFrames(9)).to.equal(9);
        expect(wf.toValidLTXFrames(10)).to.equal(17);
        expect(wf.toValidLTXFrames(16)).to.equal(17);
        expect(wf.toValidLTXFrames(17)).to.equal(17);
        expect(wf.toValidLTXFrames(18)).to.equal(25);
    });
    it('handles large values', () => {
        expect(wf.toValidLTXFrames(97)).to.equal(97);
        expect(wf.toValidLTXFrames(98)).to.equal(105);
        expect(wf.toValidLTXFrames(100)).to.equal(105);
        expect(wf.toValidLTXFrames(101)).to.equal(105);
        expect(wf.toValidLTXFrames(336)).to.equal(337);
        expect(wf.toValidLTXFrames(337)).to.equal(337);
        expect(wf.toValidLTXFrames(338)).to.equal(345);
    });
});

describe('selectWorkflowGroups (duration-aware)', () => {
    // Helper: creates N mock units (only count matters, content is irrelevant)
    function makeUnits(n) { return Array.from({ length: n }, (_, i) => ({ id: `u${i}` })); }

    describe('short durations (< 5s each) — fills up to 4 per group', () => {
        it('returns single 1p for 1 unit (3s)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(1), [3]);
            expect(g).to.deep.equal([{ count: 1, offset: 0, name: 'video-ltx-1p' }]);
        });
        it('returns single 2p for 2 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(2), [3, 3]);
            expect(g).to.deep.equal([{ count: 2, offset: 0, name: 'video-ltx-2p' }]);
        });
        it('returns single 3p for 3 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(3), [3, 3, 3]);
            expect(g).to.deep.equal([{ count: 3, offset: 0, name: 'video-ltx-3p' }]);
        });
        it('returns single 4p for 4 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(4), [3, 3, 3, 3]);
            expect(g).to.deep.equal([{ count: 4, offset: 0, name: 'video-ltx-4p' }]);
        });
        it('returns 4p+1p for 5 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(5), [3, 3, 3, 3, 3]);
            expect(g).to.deep.equal([
                { count: 4, offset: 0, name: 'video-ltx-4p' },
                { count: 1, offset: 4, name: 'video-ltx-1p' }
            ]);
        });
        it('returns 4p+4p for 8 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(8), Array(8).fill(3));
            expect(g).to.deep.equal([
                { count: 4, offset: 0, name: 'video-ltx-4p' },
                { count: 4, offset: 4, name: 'video-ltx-4p' }
            ]);
        });
        it('returns 4p+4p+2p for 10 units (3s each)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(10), Array(10).fill(3));
            expect(g).to.deep.equal([
                { count: 4, offset: 0, name: 'video-ltx-4p' },
                { count: 4, offset: 4, name: 'video-ltx-4p' },
                { count: 2, offset: 8, name: 'video-ltx-2p' }
            ]);
        });
        it('returns empty for 0 units', () => {
            const g = wf.selectWorkflowGroups([], []);
            expect(g).to.deep.equal([]);
        });
    });

    describe('longer durations — groups by cumulative time', () => {
        it('splits 4×10s into 2p+2p (each group ~20s)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(4), [10, 10, 10, 10]);
            expect(g).to.deep.equal([
                { count: 2, offset: 0, name: 'video-ltx-2p' },
                { count: 2, offset: 2, name: 'video-ltx-2p' }
            ]);
        });
        it('splits 3×8s into 2p+1p (2×8=16 < 20, 3×8=24 > 20)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(3), [8, 8, 8]);
            expect(g).to.deep.equal([
                { count: 2, offset: 0, name: 'video-ltx-2p' },
                { count: 1, offset: 2, name: 'video-ltx-1p' }
            ]);
        });
        it('keeps 2×[15,5] in one group (exactly 20s)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(2), [15, 5]);
            expect(g).to.deep.equal([
                { count: 2, offset: 0, name: 'video-ltx-2p' }
            ]);
        });
        it('splits 2×[15,10] into two 1p groups (25 > 20)', () => {
            const g = wf.selectWorkflowGroups(makeUnits(2), [15, 10]);
            expect(g).to.deep.equal([
                { count: 1, offset: 0, name: 'video-ltx-1p' },
                { count: 1, offset: 1, name: 'video-ltx-1p' }
            ]);
        });
        it('places single long IU (25s) alone in 1p group', () => {
            const g = wf.selectWorkflowGroups(makeUnits(1), [25]);
            expect(g).to.deep.equal([{ count: 1, offset: 0, name: 'video-ltx-1p' }]);
        });
        it('mixed durations: [5,5,5,10,5] → 3p+2p', () => {
            const g = wf.selectWorkflowGroups(makeUnits(5), [5, 5, 5, 10, 5]);
            expect(g).to.deep.equal([
                { count: 3, offset: 0, name: 'video-ltx-3p' }, // 5+5+5=15 < 20
                { count: 2, offset: 3, name: 'video-ltx-2p' }  // 10+5=15 < 20
            ]);
        });
        it('clamps sub-MIN_IU durations to 1s minimum', () => {
            const g = wf.selectWorkflowGroups(makeUnits(4), [0.3, 0.5, 3, 3]);
            // 0.3→1, 0.5→1, sum=2, +3=5, +3=8 < 20 → all 4 in one group
            expect(g).to.deep.equal([
                { count: 4, offset: 0, name: 'video-ltx-4p' }
            ]);
        });
        it('uses MIN_IU_DURATION (1s) when duration is missing', () => {
            const g = wf.selectWorkflowGroups(makeUnits(3), []);
            // All durations default to 1s, sum=3 < 20 → 3p
            expect(g).to.deep.equal([
                { count: 3, offset: 0, name: 'video-ltx-3p' }
            ]);
        });
    });
});

describe('calculateFrames', () => {
    it('returns correct frames for 1 IU (3s)', () => {
        const result = wf.calculateFrames([3]);
        // 3s * 24 = 72 frames, total = toValidLTXFrames(72) = 73
        expect(result.frameIndices).to.deep.equal([-1]);
        expect(result.totalFrames).to.equal(73);
    });

    it('returns correct frames for 2 IUs', () => {
        const result = wf.calculateFrames([3, 4]);
        // IU1: 72 frames, IU2: 96 frames, sum: 168, total: toValidLTXFrames(168) = 169
        expect(result.frameIndices).to.deep.equal([0, -1]);
        expect(result.totalFrames).to.equal(169);
        expect(result.frameCounts).to.deep.equal([72, 96]);
    });

    it('returns correct frames for 3 IUs', () => {
        const result = wf.calculateFrames([3, 4, 5]);
        // IU1: 72, IU2: 96, IU3: 120, sum: 288, total: toValidLTXFrames(288) = 289
        expect(result.frameIndices).to.deep.equal([0, 72, -1]);
        expect(result.totalFrames).to.equal(289);
        expect(result.frameCounts).to.deep.equal([72, 96, 120]);
    });

    it('returns correct frames for 4 IUs', () => {
        const result = wf.calculateFrames([3, 4, 5, 2]);
        // IU1: 72, IU2: 96, IU3: 120, IU4: 48 sum: 336, total: toValidLTXFrames(336) = 337
        expect(result.frameIndices).to.deep.equal([0, 72, 168, -1]);
        expect(result.totalFrames).to.equal(337);
        expect(result.frameCounts).to.deep.equal([72, 96, 120, 48]);
    });

    it('clamps sub-1s durations to MIN_IU_DURATION', () => {
        const result = wf.calculateFrames([0.5, 0.3]);
        // Both should be 1s minimum: 24 frames each, sum: 48, total: toValidLTXFrames(48) = 49
        expect(result.frameCounts).to.deep.equal([24, 24]);
        expect(result.totalFrames).to.equal(49);
    });
});

describe('buildVideoPrompt', () => {
    const sceneData = {
        book_id: 'b1',
        chapter_id: 'ch1',
        scene_id: 'sc1',
        scene: {
            participants: ['char_hero', 'char_sidekick'],
            location: {
                id: 'loc_castle',
                environment: { time: 'night', weather: 'clear', mood: 'mysterious' }
            },
            visual: { render: 'cinematic_realism' }
        },
        chapter: { title: 'The Beginning' },
    };

    const loadedBook = {
        manifest: { title: 'Adventure Story', render: { mode: 'cinematic_realism' } },
        characters: [
            { id: 'char_hero', name: 'Hero', passport: { video_tokens: 'hero token description' } },
            { id: 'char_sidekick', name: 'Sidekick', passport: { video_tokens: 'sidekick token' } },
        ],
        locations: {
            'loc_castle': { description: 'an ancient castle' }
        }
    };

    const units = [
        {
            id: 'u1',
            image: { shot: 'wide', prompt: 'Hero stands at the gate' },
            participants: ['char_hero']
        },
        {
            id: 'u2',
            image: { shot: 'medium', prompt: 'Sidekick approaches from behind' },
            participants: ['char_hero', 'char_sidekick']
        }
    ];

    it('includes character video_tokens', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('Hero: hero token description');
        expect(prompt).to.include('Sidekick: sidekick token');
    });

    it('prefers scene.passport video_tokens override over global passport', () => {
        const sceneWithOverride = {
            ...sceneData,
            scene: {
                ...sceneData.scene,
                passport: {
                    char_hero: { video_tokens: 'hero scene override token' },
                },
            },
        };
        const prompt = wf.buildVideoPrompt(sceneWithOverride, loadedBook, units, [3, 4]);
        expect(prompt).to.include('Hero: hero scene override token');
        expect(prompt).not.to.include('Hero: hero token description');
        // Sidekick unaffected — falls back to global passport
        expect(prompt).to.include('Sidekick: sidekick token');
    });

    it('joins array video_tokens (new agent format) into a comma list', () => {
        const bookWithArrays = {
            ...loadedBook,
            characters: [
                { id: 'char_hero', name: 'Hero', passport: { video_tokens: ['tie', 'round glasses'] } },
                { id: 'char_sidekick', name: 'Sidekick', passport: { video_tokens: ['red jacket'] } },
            ],
        };
        const prompt = wf.buildVideoPrompt(sceneData, bookWithArrays, units, [3, 4]);
        expect(prompt).to.include('Hero: tie, round glasses');
        expect(prompt).to.include('Sidekick: red jacket');
    });

    it('falls back to global token when a scene override collides with another participant', () => {
        const collidingScene = {
            ...sceneData,
            scene: {
                ...sceneData.scene,
                passport: {
                    char_hero: { video_tokens: ['tie'] },
                    char_sidekick: { video_tokens: ['tie'] }, // collision with hero
                },
            },
        };
        const prompt = wf.buildVideoPrompt(collidingScene, loadedBook, units, [3, 4]);
        // Hero keeps the scene override; sidekick falls back to its global token
        expect(prompt).to.include('Hero: tie');
        expect(prompt).to.include('Sidekick: sidekick token');
    });

    it('falls back to global passport when scene.passport has no override', () => {
        const sceneNoOverride = {
            ...sceneData,
            scene: {
                ...sceneData.scene,
                passport: {},
            },
        };
        const prompt = wf.buildVideoPrompt(sceneNoOverride, loadedBook, units, [3, 4]);
        expect(prompt).to.include('Hero: hero token description');
    });

    it('includes storyboard with time ranges', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('0.0–3.0s:');
        expect(prompt).to.include('3.0–7.0s:');
    });

    it('includes scene description in first IU', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('ancient castle');
        expect(prompt).to.include('night');
    });

    it('includes FPS footer', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('24fps');
    });

    it('includes render mode in footer', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('cinematic realism');
    });

    it('handles participants without video_tokens gracefully', () => {
        const bookNoTokens = {
            ...loadedBook,
            characters: [
                { id: 'char_hero', name: 'Hero', passport: {} },
            ]
        };
        const prompt = wf.buildVideoPrompt(sceneData, bookNoTokens, [units[0]], [3]);
        expect(prompt).not.to.include('Hero:');
    });

    it('uses image.prompt as the IU visual text', () => {
        const prompt = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]);
        expect(prompt).to.include('Hero stands at the gate');
        expect(prompt).to.include('Sidekick approaches from behind');
    });
});

describe('buildVideoNegativePrompt', () => {
    it('adds per-IU negative fields to the workflow negative prompt', () => {
        const result = wf.buildVideoNegativePrompt(
            { scene: { visual: {} } },
            [
                { id: 'iu-a8d4f90c', image: { negative: 'extra fingers' } },
                { id: 'iu-6ab2e1e0', image: { negative: 'warped face' } }
            ]
        );

        expect(result).to.include('extra fingers');
        expect(result).to.include('warped face');
        expect(result).to.include('blurry, low quality');
    });

    it('falls back to the base negative prompt', () => {
        const result = wf.buildVideoNegativePrompt({ scene: {} }, [{ id: 'iu-a8d4f90c' }]);
        expect(result).to.equal('blurry, low quality, still frame, jitter, flicker, artifacts');
    });
});

describe('buildVideoWorkflows', () => {
    // This test validates the high-level workflow builder
    // Full workflow JSON construction is covered by buildWorkflowForGroup tests

    it('returns failure for empty scene data', async () => {
        const result = await wf.buildVideoWorkflows(
            { book_id: 'b1', chapter_id: 'ch1', scene_id: 'sc1', scene: {} },
            { characters: [] },
            'build1',
            {}
        );
        expect(result.success).to.be.false;
        expect(result.reason).to.equal('no_units');
    });
});

describe('buildCharLines (video token resolution)', () => {
    it('renders array tokens and legacy string tokens', () => {
        const book = {
            characters: [
                { id: 'a', name: 'A', passport: { video_tokens: ['tie', 'glasses'] } },
                { id: 'b', name: 'B', passport: { video_tokens: 'red jacket' } },
            ],
        };
        const lines = wf.buildCharLines(['a', 'b'], book, {});
        expect(lines).to.deep.equal(['A: tie, glasses', 'B: red jacket']);
    });

    it('drops the second line when both scene and global tokens collide', () => {
        const book = {
            characters: [
                { id: 'a', name: 'A', passport: { video_tokens: 'same token' } },
                { id: 'b', name: 'B', passport: { video_tokens: 'same token' } },
            ],
        };
        const lines = wf.buildCharLines(['a', 'b'], book, {});
        expect(lines).to.have.length(1);
        expect(lines[0]).to.include('A: same token');
    });

    it('skips participants without tokens', () => {
        const book = {
            characters: [
                { id: 'a', name: 'A', passport: {} },
            ],
        };
        expect(wf.buildCharLines(['a'], book, {})).to.deep.equal([]);
    });

    it('prefers scene override over global token', () => {
        const book = {
            characters: [
                { id: 'a', name: 'A', passport: { video_tokens: 'global token' } },
            ],
        };
        const scene = { passport: { a: { video_tokens: ['scene token'] } } };
        expect(wf.buildCharLines(['a'], book, scene)).to.deep.equal(['A: scene token']);
    });
});

describe('buildVideoPromptLegacy', () => {
    it('builds a basic prompt from scene/chapter/book', () => {
        const prompt = wf.buildVideoPromptLegacy(
            { type: 'action', location: 'forest' },
            { title: 'Chapter 1' },
            { manifest: { title: 'My Book' } }
        );
        expect(prompt).to.include('Scene: action');
        expect(prompt).to.include('Location: forest');
        expect(prompt).to.include('Chapter: Chapter 1');
        expect(prompt).to.include('Book: My Book');
    });
});

describe('motionFromState', () => {
    it('returns minimal movement for calm states', () => {
        expect(wf.motionFromState('calm')).to.include('minimal movement');
        expect(wf.motionFromState('peaceful_calm')).to.include('minimal movement');
    });
    it('returns active movement for agitated states', () => {
        expect(wf.motionFromState('agitated')).to.include('active gestures');
        expect(wf.motionFromState('heated_discussion')).to.include('active gestures');
    });
    it('returns empty for unknown states', () => {
        expect(wf.motionFromState('unknown')).to.equal('');
        expect(wf.motionFromState(null)).to.equal('');
        expect(wf.motionFromState(undefined)).to.equal('');
    });
});

describe('buildCamera', () => {
    it('builds camera description from scene visual', () => {
        const result = wf.buildCamera({ visual: { camera: { shot: 'close-up', angle: 'low' } } });
        expect(result).to.equal('close-up shot, low angle');
    });
    it('returns empty without camera data', () => {
        expect(wf.buildCamera({})).to.equal('');
        expect(wf.buildCamera(null)).to.equal('');
    });
});

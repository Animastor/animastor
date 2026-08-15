// Regression test — per-unit video_start_ms on the whole-scene VIDEO timeline.
//
// The whole-scene scene video is a naive concat of LTX group clips; each group
// is rounded UP to a valid 8n+1 frame count, so the video timeline drifts
// ahead of the audio/start_ms timeline. Seeking the video to a unit's start_ms
// lands inside the PREVIOUS unit's clip ("one-unit shift" when jumping between
// units in the player). video_start_ms gives each unit its real position on
// the VIDEO timeline, derived from the actual generated group clips.
const { expect } = require('chai');
const path = require('path');
const MODULE = '../src/video/video-timeline';

const { rawFrameCounts, computeOffsetsFromGroupSec, computeOffsetsSingleUnit, computeGroupTargetFrames } = require(MODULE);

const FPS = 24;
// Three 10s units → 240 raw frames each; a single-unit clip is 241 frames.
const DURATIONS = [10, 10, 10];
const RAW = rawFrameCounts(DURATIONS, FPS);

describe('Video timeline alignment (video_start_ms / merge trim targets)', () => {
    it('computeGroupTargetFrames: trims each group clip to its exact audio frame count', () => {
        // Single-unit groups: target = the unit's raw frames (184/366/283/495/201),
        // NOT the padded 8n+1 counts (185/369/289/497/201).
        const groupSec = [185 / FPS, 369 / FPS, 289 / FPS, 497 / FPS, 201 / FPS];
        const raw = rawFrameCounts([7.656, 15.264, 11.808, 20.616, 8.376], FPS);
        expect(computeGroupTargetFrames(raw, groupSec, FPS)).to.deep.equal([184, 366, 283, 495, 201]);
    });

    it('computeGroupTargetFrames: multi-unit group target = sum of raw frames', () => {
        // g1 = [u0,u1]: padded 481 frames → target 480 (240+240); g2 = [u2]: 241 → 240.
        const groupSec = [481 / FPS, 241 / FPS];
        const raw = rawFrameCounts([10, 10, 10], FPS);
        expect(computeGroupTargetFrames(raw, groupSec, FPS)).to.deep.equal([480, 240]);
    });
    it('single-unit groups: video_start_ms = cumulative rounded clip durations, ahead of start_ms', () => {
        // Each unit is its own group: 241 frames (10.0417s) per clip.
        const groupSec = [241 / FPS, 241 / FPS, 241 / FPS];
        const offsets = computeOffsetsFromGroupSec([{}, {}, {}], RAW, groupSec, FPS);
        // start_ms (audio timeline) would be 0 / 10000 / 20000 — the video
        // timeline drifts ahead (+42ms per clip here, more with bigger units).
        expect(offsets).to.deep.equal([0, 10042, 20083]);
    });

    it('single-unit model (no group files) matches the single-unit-group case', () => {
        expect(computeOffsetsSingleUnit([{}, {}, {}], RAW, FPS)).to.deep.equal([0, 10042, 20083]);
    });

    it('multi-unit group: within-group boundaries at raw frames, tax absorbed by the group end', () => {
        // g1 = [u0, u1]: raw 240+240 = 480 → rounded to 481 frames (20.0417s).
        // g2 = [u2]: 241 frames.
        const groupSec = [481 / FPS, 241 / FPS];
        const offsets = computeOffsetsFromGroupSec([{}, {}, {}], RAW, groupSec, FPS);
        // u1 sits at the raw frame boundary inside the group (240/24 = 10s);
        // u2 starts after the rounded group total (481/24 = 20.0417s → 20042ms).
        expect(offsets).to.deep.equal([0, 10000, 20042]);
    });

    it('four-unit group with a 5-frame tax: intermediate units at raw boundaries', () => {
        // u0..u2 = 240 frames each, u3 = 23.0s → 552 raw → group raw = 240*3+552 =
        // 1272 → toValid(1272) = 1273 frames (53.0417s). Offsets:
        //   u0 = 0, u1 = 10000, u2 = 20000, u3 = 30000, u4 = 53042 (next group).
        const raw = rawFrameCounts([10, 10, 10, 23], FPS); // [240,240,240,552]
        const groupSec = [toValid(1272) / FPS, 241 / FPS];
        const offsets = computeOffsetsFromGroupSec([{}, {}, {}, {}, {}], [...raw, 240], groupSec, FPS);
        expect(offsets).to.deep.equal([0, 10000, 20000, 30000, 53042]);

        function toValid(rawTotal) {
            return Math.ceil((rawTotal - 1) / 8) * 8 + 1;
        }
    });

    it('group measured shorter than any unit prefix → falls back to single-unit model', () => {
        // Corrupt/short g1 (say 8s) can't match u0 (240 raw → 241 frames) —
        // the remaining units fall back to per-unit rounding.
        const groupSec = [8.0, 241 / FPS];
        const offsets = computeOffsetsFromGroupSec([{}, {}, {}], RAW, groupSec, FPS);
        expect(offsets).to.deep.equal([0, 10042, 20083]);
    });
});

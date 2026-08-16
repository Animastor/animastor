// ======================================================
// VIDEO TIMELINE OFFSETS (video_start_ms per unit)
// ======================================================
// The whole-scene video (`{prefix}.mp4`) is a concat of per-group clips
// (`{prefix}_gN.mp4`). On LTX workflows each group's frame count is rounded UP
// to a valid 8n+1 count (toValidLTXFrames), so every group carries an
// alignment tax and the video timeline drifts AHEAD of the audio/start_ms
// timeline (measured on real builds: +0.05s after unit 1 … +0.49s by the last
// unit of a 5-unit scene). On other models (e.g. Minimax H3) the clips land at
// the exact frame counts and there is NO tax. Players that seek the scene
// video to a unit's start_ms land inside the PREVIOUS unit's clip on taxed
// builds — the "one-unit shift" observed when jumping between units.
//
// This module computes each unit's real position on the VIDEO timeline from
// the ACTUAL generated files (the authoritative source — reconstructing the
// group plan from stored durations is NOT reliable: the grouping that was
// actually used can differ from what a re-run of the DP would produce today).
// Measurement is deliberately MODEL-AGNOSTIC:
//
//   1. Merged file (`{prefix}.mp4`) — probe its frame PTS and map each unit's
//      audio boundary to the first video frame at-or-after it. This is the
//      exact timeline of the file actually served to the player, so it is the
//      most precise source whenever the merge exists.
//   2. Group files (`{prefix}_gN.mp4`) — probe each group's duration and match
//      consecutive units to it tolerantly: a group's measured frame count may
//      equal the exact raw sum (non-LTX) OR the LTX-rounded count (8n+1 tax).
//      Within a group, unit boundaries sit at the raw frame counts; only the
//      LAST unit of a group absorbs the alignment tax.
//   3. Identity fallback (no files / mismatch): video_start_ms = start_ms —
//      assume the video timeline equals the audio timeline (the merge pipeline
//      trims group clips to exact audio frame counts, so this is the correct
//      default when nothing can be measured).

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { selectWorkflowGroups, toValidLTXFrames } = require('../workflows/video/video-workflows');
const config = require('../config/runtime-config');

const logPrefix = '[VIDEO-TIMELINE]';
const FPS_DEFAULT = 24;
const MIN_IU_DURATION = 1.0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// key → { ts, videoStartMs: number[] }
const offsetCache = new Map();

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function probeVideoDurationSec(filePath) {
    return new Promise(resolve => {
        const proc = spawn('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const v = parseFloat(out.trim());
            resolve(Number.isFinite(v) && v > 0 ? v : null);
        });
    });
}

function listSceneVideoGroups(outDir, buildId, bookId, chapterId, sceneId) {
    const dir = path.join(outDir, buildId);
    if (!fs.existsSync(dir)) return [];
    const prefix = `${bookId}_${chapterId}_${sceneId}`;
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.mp4') && /_g\d+\.mp4$/.test(f))
        .sort((a, b) => {
            const na = parseInt((a.match(/_g(\d+)/) || [0, 0])[1], 10);
            const nb = parseInt((b.match(/_g(\d+)/) || [0, 0])[1], 10);
            return na - nb;
        });
}

/** Map unit durations to per-unit raw frame counts (mirrors calculateFrames). */
function rawFrameCounts(durations, fps) {
    const minFrames = Math.round(MIN_IU_DURATION * fps);
    return durations.map(d => Math.max(minFrames, Math.round(d * fps)));
}

/** Tolerant frame-count match: a measured group frame count may equal the
 *  exact raw sum (non-LTX models) OR the LTX-rounded count (8n+1 tax) —
 *  anything in [rawSum, toValid(rawSum)] is a valid match. */
function groupMatches(groupFrames, acc) {
    return groupFrames >= acc && groupFrames <= toValidLTXFrames(acc);
}

/** Pure matching: given measured per-group clip durations, compute how many
 *  units each group contains and the per-group TARGET frame count — the exact
 *  audio-duration frame count the clip must be trimmed to so the merged video
 *  timeline aligns with the audio/start_ms timeline (removes the 8n+1 tax). */
function computeGroupTargetFrames(rawFrames, groupSec, fps) {
    const groupFrames = groupSec.map(s => Math.round(s * fps));
    const targets = [];
    let idx = 0;
    for (let g = 0; g < groupSec.length && idx < rawFrames.length; g++) {
        const first = idx;
        let acc = 0;
        let matched = false;
        while (idx < rawFrames.length) {
            acc += rawFrames[idx];
            idx++;
            if (groupMatches(groupFrames[g], acc)) { matched = true; break; }
            if (acc > groupFrames[g]) { idx = first; break; }
        }
        if (matched) {
            targets.push(acc);
        } else {
            // Unmatchable group — fall back to a single unit per group.
            targets.push(rawFrames[first] ?? 0);
            idx = first + 1;
        }
    }
    return targets;
}

/** Pure matching: given measured per-group clip durations, compute per-unit
 *  video_start_ms. Within a group, unit boundaries sit at raw frame counts;
 *  only the group's LAST unit absorbs the alignment tax. */
function computeOffsetsFromGroupSec(ius, rawFrames, groupSec, fps) {
    const videoStartMs = new Array(ius.length).fill(0);
    const groupFrames = groupSec.map(s => Math.round(s * fps));
    let idx = 0;
    let completedSec = 0;
    for (let g = 0; g < groupSec.length && idx < ius.length; g++) {
        const first = idx;
        let acc = 0;
        let assigned = false;
        while (idx < ius.length) {
            acc += rawFrames[idx];
            idx++;
            if (groupMatches(groupFrames[g], acc)) { assigned = true; break; }
            if (acc > groupFrames[g]) { idx = first; break; }
        }
        if (assigned) {
            let withinSec = 0;
            for (let k = first; k < idx; k++) {
                videoStartMs[k] = Math.round(1000 * (completedSec + withinSec));
                withinSec += rawFrames[k] / fps;
            }
            completedSec += groupFrames[g] / fps;
        } else {
            // Measured group shorter than any unit prefix — give up on the real
            // grouping and fall back to the identity model (video = audio
            // timeline) for the rest.
            for (let k = first; k < ius.length; k++) {
                videoStartMs[k] = Math.round(1000 * completedSec);
                completedSec += rawFrames[k] / fps;
            }
            idx = ius.length;
        }
    }
    for (; idx < ius.length; idx++) {
        videoStartMs[idx] = Math.round(1000 * completedSec);
        completedSec += rawFrames[idx] / fps;
    }
    return videoStartMs;
}

/** Identity model: video timeline = audio/start_ms timeline (the merge pipeline
 *  trims group clips to exact audio frame counts, so this is the correct
 *  default when nothing can be measured — no tax assumption). */
function computeOffsetsSingleUnit(ius, rawFrames, fps) {
    const videoStartMs = new Array(ius.length).fill(0);
    let accSec = 0;
    for (let k = 0; k < ius.length; k++) {
        videoStartMs[k] = Math.round(1000 * accSec);
        accSec += rawFrames[k] / fps;
    }
    return videoStartMs;
}

/** Probe every video frame's PTS (seconds, display order). */
function probeFramePtsSec(filePath) {
    return new Promise(resolve => {
        const proc = spawn('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', filePath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const pts = out.split(/\r?\n/).map(s => parseFloat(s.trim())).filter(Number.isFinite);
            resolve(pts.length > 0 ? pts : null);
        });
    });
}

/** Merged-file measurement: map each unit's audio boundary to the first video
 *  frame at-or-after it on the ACTUAL served file's frame timeline. This is the
 *  most precise, fully model-agnostic source — it measures the exact file the
 *  player streams (works for LTX-taxed, non-LTX exact and any residual trim
 *  drift). Returns null when the file's frames can't cover the unit timeline. */
function computeOffsetsFromMergedFramePts(durations, framePtsSec) {
    const videoStartMs = new Array(durations.length).fill(0);
    let boundarySec = 0;
    let fi = 0;
    for (let k = 1; k < durations.length; k++) {
        boundarySec += durations[k - 1];
        while (fi < framePtsSec.length && framePtsSec[fi] < boundarySec - 1e-6) fi++;
        if (fi >= framePtsSec.length) return null;
        videoStartMs[k] = Math.round(1000 * framePtsSec[fi]);
    }
    return videoStartMs;
}

/**
 * Compute per-unit video_start_ms (positions on the whole-scene VIDEO
 * timeline) for a scene's units and attach them to each iu object.
 * Returns true when computed from real group files, false when a fallback
 * (single-unit model) was used.
 *
 * @param {Array} ius storyboard IUs (unit_id, estimated_duration_sec, start_ms, end_ms)
 * @param {string} outputDir build directory (the route's config.OUTPUT_DIR)
 */
async function computeVideoStartMs(ius, buildId, bookId, chapterId, sceneId, outputDir) {
    if (!Array.isArray(ius) || ius.length === 0) return false;
    const outDir = outputDir || config.OUTPUT_DIR;

    const cacheKey = `${buildId}:${chapterId}:${sceneId}`;
    const cached = offsetCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        for (let k = 0; k < ius.length; k++) ius[k].video_start_ms = cached.videoStartMs[k] ?? 0;
        return true;
    }

    const fps = parseInt(process.env.VIDEO_FPS || String(FPS_DEFAULT), 10);
    const durations = ius.map(iu => {
        const est = iu.estimated_duration_sec && iu.estimated_duration_sec > 0 ? iu.estimated_duration_sec : null;
        const real = iu.start_ms != null && iu.end_ms != null ? (iu.end_ms - iu.start_ms) / 1000 : null;
        return est || real || MIN_IU_DURATION;
    });
    const rawFrames = rawFrameCounts(durations, fps);

    let videoStartMs = null;
    let source = 'identity';

    const audioTotalSec = durations.reduce((s, d) => s + d, 0);

    // 1) Merged file — the exact timeline of the file served to the player.
    //    Preferred when the merge is ALIGNED or nearly so (group clips trimmed
    //    to exact audio frame counts; residual drift up to 0.5s / few frames —
    //    real builds measure +14..40ms per unit). Then the first frame
    //    at-or-after each audio boundary IS the unit's first frame
    //    (frame-exact: lands on the selected unit's first frame, never the
    //    previous unit's tail, when the boundary falls between frames). For
    //    heavily UNALIGNED merges (video total much larger — the 8n+1 tax
    //    survives wholesale) the frame PTS cannot recover the drift (the
    //    boundary frame is still the previous unit's content), so we fall
    //    through to the group files which can.
    const mergedPath = path.join(outDir, buildId, `${bookId}_${chapterId}_${sceneId}.mp4`);
    if (fs.existsSync(mergedPath)) {
        const mergedDur = await probeVideoDurationSec(mergedPath);
        const aligned = mergedDur != null && Math.abs(mergedDur - audioTotalSec) <= 0.5;
        if (aligned) {
            const framePts = await probeFramePtsSec(mergedPath);
            if (framePts && framePts.length > 0) {
                const offsets = computeOffsetsFromMergedFramePts(durations, framePts);
                if (offsets) {
                    videoStartMs = offsets;
                    source = 'merged file (aligned)';
                }
            }
        }
    }

    // 2) Group files — recover the real per-group tax of an UNALIGNED merge
    //    (or mid-generation, no merged file yet).
    if (!videoStartMs) {
        const groupFiles = listSceneVideoGroups(outDir, buildId, bookId, chapterId, sceneId);
        const groupSec = [];
        if (groupFiles.length > 0) {
            for (const f of groupFiles) {
                const dur = await probeVideoDurationSec(path.join(outDir, buildId, f));
                if (dur == null) { groupSec.length = 0; break; }
                groupSec.push(dur);
            }
            if (groupSec.length === groupFiles.length && groupSec.length > 0) {
                videoStartMs = computeOffsetsFromGroupSec(ius, rawFrames, groupSec, fps);
                source = 'group files';
            }
        }
    }

    // 3) Identity fallback (no measurable files).
    if (!videoStartMs) videoStartMs = computeOffsetsSingleUnit(ius, rawFrames, fps);

    for (let k = 0; k < ius.length; k++) ius[k].video_start_ms = videoStartMs[k];
    offsetCache.set(cacheKey, { ts: Date.now(), videoStartMs });

    log(`scene ${bookId}/${chapterId}/${sceneId}: video_start_ms (${source}) = ${ius.map(iu => `${iu.unit_id}=${iu.video_start_ms}ms`).join(', ')}`);
    return source !== 'identity';
}

module.exports = {
    computeVideoStartMs,
    rawFrameCounts,
    computeOffsetsFromGroupSec,
    computeOffsetsSingleUnit,
    computeGroupTargetFrames,
    computeOffsetsFromMergedFramePts,
    probeVideoDurationSec,
    probeFramePtsSec,
};

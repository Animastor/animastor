// ======================================================
// VIDEO TIMELINE OFFSETS (video_start_ms per unit)
// ======================================================
// The whole-scene video (`{prefix}.mp4`) is a naive concat of per-group LTX
// clips (`{prefix}_gN.mp4`). Each group's frame count is rounded UP to a valid
// LTX 8n+1 count (toValidLTXFrames), so every group carries an alignment tax
// and the video timeline drifts AHEAD of the audio/start_ms timeline (measured
// on real builds: +0.05s after unit 1 … +0.49s by the last unit of a 5-unit
// scene). Players that seek the scene video to a unit's start_ms therefore
// land inside the PREVIOUS unit's clip — the "one-unit shift" observed when
// jumping between units.
//
// This module computes each unit's real position on the VIDEO timeline from
// the actual generated group files (the authoritative source — reconstructing
// the group plan from stored durations is NOT reliable: the grouping that was
// actually used can differ from what a re-run of the DP would produce today).
//
//   - Probe each `_gN.mp4` duration (ffprobe).
//   - Match consecutive units to each group: a group's frame count equals
//     toValidLTXFrames(Σ rawFrames of its units) (verified exactly on real
//     builds: encoder preserves the planned frame counts).
//   - Within a group, unit boundaries sit at the raw frame counts; only the
//     LAST unit of a group absorbs the alignment tax.
//
// Fallbacks (no group files / mismatch): assume every unit is its own clip
// (toValid(rawFrames[k]) per unit) — exact for the common single-unit case.

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
            if (toValidLTXFrames(acc) === groupFrames[g]) { matched = true; break; }
            if (toValidLTXFrames(acc) > groupFrames[g]) { idx = first; break; }
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
            if (toValidLTXFrames(acc) === groupFrames[g]) { assigned = true; break; }
            if (toValidLTXFrames(acc) > groupFrames[g]) { idx = first; break; }
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
            // grouping and fall back to the single-unit model for the rest.
            for (let k = first; k < ius.length; k++) {
                videoStartMs[k] = Math.round(1000 * completedSec);
                completedSec += toValidLTXFrames(rawFrames[k]) / fps;
            }
            idx = ius.length;
        }
    }
    for (; idx < ius.length; idx++) {
        videoStartMs[idx] = Math.round(1000 * completedSec);
        completedSec += toValidLTXFrames(rawFrames[idx]) / fps;
    }
    return videoStartMs;
}

/** Single-unit model: each unit is its own clip (per-unit alignment tax). */
function computeOffsetsSingleUnit(ius, rawFrames, fps) {
    const videoStartMs = new Array(ius.length).fill(0);
    let accSec = 0;
    for (let k = 0; k < ius.length; k++) {
        videoStartMs[k] = Math.round(1000 * accSec);
        accSec += toValidLTXFrames(rawFrames[k]) / fps;
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

    let videoStartMs;
    let fromRealGroups = false;

    const groupFiles = listSceneVideoGroups(outDir, buildId, bookId, chapterId, sceneId);
    const groupSec = [];
    if (groupFiles.length > 0) {
        for (const f of groupFiles) {
            const dur = await probeVideoDurationSec(path.join(outDir, buildId, f));
            if (dur == null) { groupSec.length = 0; break; }
            groupSec.push(dur);
        }
        fromRealGroups = groupSec.length === groupFiles.length && groupSec.length > 0;
    }

    videoStartMs = fromRealGroups
        ? computeOffsetsFromGroupSec(ius, rawFrames, groupSec, fps)
        : computeOffsetsSingleUnit(ius, rawFrames, fps);

    for (let k = 0; k < ius.length; k++) ius[k].video_start_ms = videoStartMs[k];
    offsetCache.set(cacheKey, { ts: Date.now(), videoStartMs });

    log(`scene ${bookId}/${chapterId}/${sceneId}: video_start_ms (${fromRealGroups ? 'from group files' : 'single-unit model'}) = ${ius.map(iu => `${iu.unit_id}=${iu.video_start_ms}ms`).join(', ')}`);
    return fromRealGroups;
}

module.exports = {
    computeVideoStartMs,
    rawFrameCounts,
    computeOffsetsFromGroupSec,
    computeOffsetsSingleUnit,
    computeGroupTargetFrames,
    probeVideoDurationSec,
};

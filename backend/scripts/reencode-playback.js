#!/usr/bin/env node
/**
 * Re-encode existing merged scene videos into the playback profile
 * (PLAYBACK_VIDEO_BITRATE_KBPS, default 2000 kbps) — the "batch faststart"
 * equivalent for the bitrate cap. Pipeline SOURCES (_gN.mp4) are untouched;
 * only the lightweight derivative served to the Player is rebuilt, and the
 * unit-boundary keyframes are preserved (forced from {prefix}.chunk-durations.json
 * so unit seeks keep landing on the right unit).
 *
 * Idempotent: files already at/below the profile bitrate are skipped, so a
 * re-run is a no-op. Files whose durations are unknown are re-encoded plain
 * (bitrate still capped, but boundary keyframes are not forced — the DB
 * durations would be needed for those).
 *
 * Usage (host):      node backend/scripts/reencode-playback.js [buildDir ...]
 * Usage (container): BACKEND_ROOT=/app node /tmp/reencode-playback.js
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = process.env.BACKEND_ROOT || path.resolve(__dirname, '..');
const videoMerge = require(path.join(ROOT, 'src/video/video-merge'));
const config = require(path.join(ROOT, 'src/config/runtime-config'));

const CAP_KBPS = config.PLAYBACK_VIDEO_BITRATE_KBPS;
const SRC_CAP_KBPS = config.SOURCE_VIDEO_BITRATE_KBPS;
// --sources: also cap the pipeline group clips (_gN.mp4) to the SOURCE profile
// (3500 kbps) — merged scene files are ALWAYS re-encoded to the playback
// profile; sources are only touched in this mode.
const CAP_SOURCES = process.argv.includes('--sources');

function probeBitrateKbps(filePath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=bit_rate',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf8' });
    const v = parseFloat((r.stdout || '').trim());
    return Number.isFinite(v) && v > 0 ? v / 1000 : null;
}

/** Unit durations (seconds) from {prefix}.chunk-durations.json, ordered. */
function loadUnitDurationsFromDisk(prefixPath) {
    const jsonPath = prefixPath + '.chunk-durations.json';
    if (!fs.existsSync(jsonPath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!Array.isArray(data.records) || data.records.length === 0) return null;
        return data.records
            .slice()
            .sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0))
            .map(r => (r.tail_duration_sec != null ? r.tail_duration_sec : r.raw_duration_sec));
    } catch (err) {
        console.warn(`  ⚠️ cannot parse ${path.basename(jsonPath)}: ${err.message}`);
        return null;
    }
}

async function reencode(videoPath, buildId, prefix) {
    const current = probeBitrateKbps(videoPath);
    if (current != null && CAP_KBPS > 0 && current <= CAP_KBPS * 1.05) {
        console.log(`  ⏭  skip ${path.basename(videoPath)} (already ${(current / 1000).toFixed(1)} Mbps ≤ ${CAP_KBPS / 1000} Mbps)`);
        return;
    }
    if (CAP_SOURCES) {
        // Source clips: cap to SOURCE_VIDEO_BITRATE_KBPS (no keyframes — the
        // unit-boundary keyframes are forced later by the playback merge).
        if (current != null && SRC_CAP_KBPS > 0 && current <= SRC_CAP_KBPS * 1.05) {
            console.log(`  ⏭  skip ${path.basename(videoPath)} (source already ${(current / 1000).toFixed(1)} Mbps ≤ ${SRC_CAP_KBPS / 1000} Mbps)`);
            return;
        }
        const tmp = videoPath + '.cap.mp4';
        try {
            await videoMerge.encodeSourceProfile(videoPath, tmp);
            fs.renameSync(tmp, videoPath);
            const after = probeBitrateKbps(videoPath);
            console.log(`  ✓ source-cap ${path.basename(videoPath)} → ${after != null ? (after / 1000).toFixed(1) : '?'} Mbps`);
        } catch (err) {
            console.error(`  ✗ source-cap failed for ${path.basename(videoPath)}: ${err.message}`);
            try { fs.unlinkSync(tmp); } catch {}
        }
        return;
    }
    const durations = loadUnitDurationsFromDisk(prefix);
    if (durations && durations.length > 1) {
        const ok = await videoMerge.forceKeyframesAtUnitBoundaries(videoPath, buildId, null, null, null, durations);
        if (ok) {
            const after = probeBitrateKbps(videoPath);
            console.log(`  ✓ keyframes+profile ${path.basename(videoPath)} → ${after != null ? (after / 1000).toFixed(1) : '?'} Mbps`);
            return;
        }
        console.warn(`  ⚠️ forceKeyframes failed for ${path.basename(videoPath)} — plain profile encode`);
    }
    const tmp = videoPath + '.replay.mp4';
    try {
        await videoMerge.encodePlaybackProfile(videoPath, tmp);
        fs.renameSync(tmp, videoPath);
        const after = probeBitrateKbps(videoPath);
        console.log(`  ✓ profile ${path.basename(videoPath)} → ${after != null ? (after / 1000).toFixed(1) : '?'} Mbps`);
    } catch (err) {
        console.error(`  ✗ encode failed for ${path.basename(videoPath)}: ${err.message}`);
        try { fs.unlinkSync(tmp); } catch {}
    }
}

async function scanBuildDir(buildDir) {
    const buildId = path.basename(buildDir);
    console.log(`\n== build ${buildId}`);
    let entries;
    try { entries = fs.readdirSync(buildDir); } catch { return; }
    for (const name of entries) {
        if (!name.endsWith('.mp4')) continue;
        if (/_g\d+\.mp4$/.test(name)) {
            if (CAP_SOURCES) {
                const videoPath = path.join(buildDir, name);
                await reencode(videoPath, buildId, path.join(buildDir, name.replace(/\.mp4$/, '')));
            }
            continue; // source clips are never re-encoded in the default mode
        }
        const idxCh = name.indexOf('_ch-');
        const idxSc = name.indexOf('_sc-');
        if (idxCh < 0 || idxSc <= idxCh) continue;
        if (/\.(src|book|kf|single|merge|trim|replay|cap)\.mp4$/.test(name)) continue;
        const videoPath = path.join(buildDir, name);
        await reencode(videoPath, buildId, path.join(buildDir, name.replace(/\.mp4$/, '')));
    }
}

async function main() {
    const targets = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const roots = targets.length > 0 ? targets : [config.OUTPUT_DIR];
    console.log(`Playback profile: ${CAP_KBPS > 0 ? `${CAP_KBPS / 1000} Mbps` : 'DISABLED (CRF 18 fallback)'}`);
    if (CAP_SOURCES) console.log(`Source profile: ${SRC_CAP_KBPS > 0 ? `${SRC_CAP_KBPS / 1000} Mbps` : 'DISABLED'}`);
    for (const root of roots) {
        let buildDirs = [];
        try {
            buildDirs = fs.readdirSync(root)
                .filter(d => d.startsWith('build_') || d.startsWith('demo_'))
                .map(d => path.join(root, d));
        } catch (err) {
            console.error(`cannot read ${root}: ${err.message}`);
            continue;
        }
        for (const d of buildDirs) await scanBuildDir(d);
    }
    console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });

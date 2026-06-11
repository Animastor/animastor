const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WAVEFORM_PEAKS = 1000;
const CACHE_DIR = path.join(os.tmpdir(), 'animastor-waveforms');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

async function computeWaveform(audioPath) {
    const cacheKey = Buffer.from(audioPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

    if (fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            if (cached && cached.peaks && cached.peaks.length > 0) {
                return cached.peaks;
            }
        } catch (_) {}
    }

    const peaks = await extractPeaks(audioPath);
    if (peaks && peaks.length > 0) {
        try {
            fs.writeFileSync(cachePath, JSON.stringify(peaks), 'utf-8');
        } catch (_) {}
    }
    return peaks;
}

function extractPeaks(audioPath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(audioPath)) {
            return reject(new Error(`Audio file not found: ${audioPath}`));
        }

        const args = [
            '-i', audioPath,
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '8000',
            '-y',
            'pipe:1'
        ];

        const child = execFile('ffmpeg', args, {
            maxBuffer: 50 * 1024 * 1024,
            encoding: null,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const chunks = [];
        let stderr = '';

        child.stdout.on('data', (data) => {
            chunks.push(data);
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', (err) => {
            reject(new Error(`ffmpeg error: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
                return;
            }

            try {
                const buffer = Buffer.concat(chunks);
                const peaks = computePeaks(buffer);
                resolve(peaks);
            } catch (err) {
                reject(err);
            }
        });
    });
}

function computePeaks(samples) {
    if (samples.length < 4) return [];

    const numSamples = Math.floor(samples.length / 2);
    const samplesPerPeak = Math.max(1, Math.floor(numSamples / WAVEFORM_PEAKS));
    const peaks = [];

    let posIdx = 0;
    let negIdx = 0;

    for (let i = 0; i < WAVEFORM_PEAKS; i++) {
        const startSample = i * samplesPerPeak;
        const endSample = Math.min(startSample + samplesPerPeak, numSamples);

        let maxPositive = 0;
        let maxNegative = 0;

        for (let j = startSample; j < endSample; j++) {
            const byteOffset = j * 2;
            if (byteOffset >= samples.length - 1) break;
            const value = samples.readInt16LE(byteOffset);
            if (value > maxPositive) maxPositive = value;
            if (value < maxNegative) maxNegative = value;
        }

        posIdx++;
        negIdx++;

        peaks.push({
            pos: maxPositive / 32768.0,
            neg: maxNegative / 32768.0
        });
    }

    return peaks;
}

function getSceneAudioPath(buildId, bookId, chapterId, sceneId) {
    const config = require('../config/runtime-config');
    return path.join(config.OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
}

module.exports = { computeWaveform, extractPeaks, getSceneAudioPath };

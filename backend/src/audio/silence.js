// ======================================================
// Silent Audio Generation (Placeholder)
// ======================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const helpers = require('./helpers');
const { isFFmpegAvailable } = require('./connector-utils');

/**
 * Write a minimal valid MP3 silence file using pure Node.js.
 * This is a fallback when ffmpeg is not available.
 * Generates MPEG1 Layer 3 silent frames.
 */
function writeSilentMP3Node(outputPath, durationSec) {
    const sampleRate = 24000;
    const bitrateKbps = 64;
    const frameSamples = 1152;
    const frameSize = Math.floor(144 * bitrateKbps * 1000 / sampleRate);

    const header = Buffer.alloc(4);
    header[0] = 0xFF;
    header[1] = 0xFB;
    header[2] = 0x58;
    header[3] = 0xC4;

    const frame = Buffer.concat([header, Buffer.alloc(frameSize - 4, 0)]);

    const framesNeeded = Math.max(1, Math.ceil((durationSec * sampleRate) / frameSamples));
    const totalSize = framesNeeded * frameSize;
    const result = Buffer.alloc(totalSize);
    for (let i = 0; i < framesNeeded; i++) {
        frame.copy(result, i * frameSize);
    }

    fs.writeFileSync(outputPath, result);
}

/**
 * Generate a silent MP3 audio file.
 * Prefers ffmpeg for proper encoding, falls back to pure Node.js MP3 frame generation.
 */
async function generateSilentAudio(outputPath, durationSec) {
    if (isFFmpegAvailable()) {
        return new Promise((resolve, reject) => {
            const args = [
                '-f', 'lavfi',
                '-i', 'anullsrc=r=24000:cl=mono',
                '-t', String(durationSec),
                '-c:a', 'libmp3lame',
                '-b:a', '64k',
                '-y', outputPath
            ];

            const ffmpeg = spawn('ffmpeg', args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stderr = '';
            ffmpeg.stderr.on('data', data => { stderr += data.toString(); });
            ffmpeg.stdout.on('data', () => {});

            ffmpeg.on('close', code => {
                if (code === 0) {
                    helpers.log(`Silent audio generated: ${path.basename(outputPath)} (${durationSec.toFixed(1)}s)`);
                    resolve(outputPath);
                } else {
                    helpers.error(`Silent audio generation failed: ffmpeg exited with code ${code}`);
                    reject(new Error(`ffmpeg silence exited with code ${code}: ${stderr}`));
                }
            });

            ffmpeg.on('error', reject);
        });
    }

    helpers.log(`ffmpeg not found, generating silent MP3 with Node.js fallback: ${path.basename(outputPath)} (${durationSec.toFixed(1)}s)`);
    writeSilentMP3Node(outputPath, durationSec);
    return outputPath;
}

module.exports = {
    generateSilentAudio,
    writeSilentMP3Node,
};

// ======================================================
// Audio FFmpeg Operations
// ======================================================

const { spawn } = require('child_process');

async function runFFmpegMerge(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';

        ffmpeg.stderr.on('data', data => {
            stderr += data.toString();
        });

        ffmpeg.stdout.on('data', () => {});

        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

async function runFFmpegTrim(inputPath, outputPath, startTimeSec = 0, durationSec = null) {
    return new Promise((resolve, reject) => {
        const args = ['-i', inputPath];

        if (startTimeSec > 0) {
            args.push('-ss', String(startTimeSec));
        }

        const filterArgs = ['-af', 'silenceremove=stop_periods=-1:stop_duration=0.2:stop_threshold=-50dB'];
        args.push(...filterArgs);

        if (durationSec !== null) {
            args.push('-t', String(durationSec));
        }

        args.push('-y', outputPath);

        const ffmpeg = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';

        ffmpeg.stderr.on('data', data => {
            stderr += data.toString();
        });

        ffmpeg.stdout.on('data', () => {});

        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg trim exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

function probeDuration(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=duration',
            '-of', 'csv=p=0',
            filePath
        ]);
        let out = '';
        probe.stdout.on('data', d => { out += d.toString(); });
        probe.on('close', code => {
            if (code !== 0) { resolve(0); return; }
            const lines = out.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const dur = parseFloat(line);
                if (Number.isFinite(dur) && dur > 0) { resolve(dur); return; }
            }
            resolve(0);
        });
        probe.on('error', () => resolve(0));
    });
}

function cutFirstHalf(filePath, outputPath, duration) {
    return new Promise((resolve) => {
        const cut = spawn('ffmpeg', [
            '-i', filePath,
            '-t', String(duration),
            '-c', 'copy',
            '-y', outputPath
        ]);
        cut.on('close', code => resolve(code === 0));
        cut.on('error', () => resolve(false));
    });
}

function findQuietestPoint(filePath, startPct = 0.25, endPct = 0.75) {
    return new Promise((resolve) => {
        const sampleRate = 24000;
        const windowMs = 50;
        const windowSamples = Math.floor(sampleRate * windowMs / 1000);

        const ff = spawn('ffmpeg', [
            '-i', filePath,
            '-ac', '1',
            '-ar', String(sampleRate),
            '-f', 's16le',
            '-y',
            'pipe:1'
        ]);

        const chunks = [];
        ff.stdout.on('data', d => { chunks.push(d); });
        let stderrBuf = '';
        ff.stderr.on('data', d => { stderrBuf += d.toString(); });

        ff.on('close', code => {
            if (code !== 0) { resolve(0); return; }
            const buf = Buffer.concat(chunks);
            const totalSamples = Math.floor(buf.length / 2);
            if (totalSamples < windowSamples * 3) { resolve(0); return; }

            const totalWindows = Math.floor(totalSamples / windowSamples);
            const lo = Math.floor(totalWindows * Math.max(0, Math.min(1, startPct)));
            const hi = Math.floor(totalWindows * Math.max(0, Math.min(1, endPct)));
            let minRms = Infinity, minWin = lo;

            for (let w = lo; w < hi && w < totalWindows; w++) {
                let sumSq = 0;
                const offset = w * windowSamples * 2;
                const len = Math.min(windowSamples * 2, buf.length - offset);
                for (let i = 0; i < len; i += 2) {
                    const s = buf.readInt16LE(offset + i);
                    sumSq += s * s;
                }
                const rms = Math.sqrt(sumSq / (len / 2));
                if (rms < minRms) {
                    minRms = rms;
                    minWin = w;
                }
            }

            const cutTime = (minWin * windowMs + windowMs / 2) / 1000;
            resolve(cutTime);
        });
        ff.on('error', () => resolve(0));
    });
}

module.exports = {
    runFFmpegMerge,
    runFFmpegTrim,
    probeDuration,
    cutFirstHalf,
    findQuietestPoint,
};

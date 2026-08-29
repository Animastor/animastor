'use strict';

/**
 * Download progress — user-visible status for long downloads (ModelScope
 * repos, single artifacts).
 *
 * Requirements:
 *   - the user must SEE that the download is running, which file, how much
 *     was downloaded, the speed and the ETA;
 *   - batch (repo) downloads also show aggregate progress;
 *   - DO NOT spam the log — a single in-place line on a TTY, throttled
 *     lines (time AND byte-delta based) in non-TTY environments;
 *   - fully injectable (isTTY/write/log/now) for deterministic tests.
 */

/**
 * "12", "1.2 GB", "512 MB", "800 KB"
 */
function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    if (i === 0) return `${Math.round(v)} ${units[i]}`;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 75 → "01:15", 3725 → "1:02:05" */
function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * "Downloading Qwen/.../file.safetensors  1.2 GB / 4.8 GB (25%)  12.3 MB/s  ETA 05:12"
 */
function renderProgressLine({ prefix = 'Downloading', label, received, total, rateBps = null, etaSeconds = null }) {
    const parts = [`${prefix} ${label}`];
    if (Number.isFinite(total) && total > 0) {
        const pct = Math.min(100, Math.floor((received / total) * 100));
        parts.push(`${formatBytes(received)} / ${formatBytes(total)} (${pct}%)`);
    } else {
        parts.push(formatBytes(received));
    }
    if (Number.isFinite(rateBps) && rateBps > 0) parts.push(`${formatBytes(rateBps)}/s`);
    if (Number.isFinite(etaSeconds) && etaSeconds > 0) parts.push(`ETA ${formatEta(etaSeconds)}`);
    return parts.join('  ');
}

/**
 * Create a progress reporter for one download step (single file or repo).
 *
 * @param {object} opts { isTTY, write, log, now, minIntervalMs, minDeltaBytes }
 * @returns reporter with beginRepo/fileSkipped/beginFile/onChunk/endFile/endRepo
 */
function createProgressReporter(opts = {}) {
    const {
        isTTY = false,
        write = null,
        log = null,
        now = () => Date.now(),
        minIntervalMs = 2000,
        minDeltaBytes = 1 * 1024 * 1024,
    } = opts;

    const sinkWrite = write || (isTTY && typeof process !== 'undefined' && process.stderr && process.stderr.write
        ? (s) => { try { process.stderr.write(s); } catch (_) { /* gone */ } }
        : null);
    const sinkLog = log && typeof log.info === 'function' ? (msg) => log.info(msg) : null;

    const state = {
        repo: null, // { repository, filesTotal, filesDone, bytesTotal, bytesDone }
        file: null, // { label, received, total, lastSampleAt, lastSampleBytes, rateBps, etaSeconds }
        active: false,   // a TTY line is on screen
        lastEmitAt: -Infinity,
        lastEmitBytes: 0,
    };

    const clearLine = () => {
        if (state.active && sinkWrite) sinkWrite('\n');
        state.active = false;
    };

    const emitTTY = (line) => {
        if (!sinkWrite) return;
        sinkWrite(`\r${line}\x1b[K`);
        state.active = true;
    };

    const emitLog = (line) => {
        if (sinkLog) sinkLog(line);
    };

    /** Throttle decision for non-TTY environments. */
    const shouldEmit = (t, bytes) => {
        if (state.lastEmitAt === -Infinity) return true;
        if (t - state.lastEmitAt >= minIntervalMs && bytes - state.lastEmitBytes >= minDeltaBytes) return true;
        return false;
    };

    const currentLine = () => {
        if (state.file) {
            return renderProgressLine({
                prefix: 'Downloading',
                label: state.file.label,
                received: state.file.received,
                total: state.file.total,
                rateBps: state.file.rateBps,
                etaSeconds: state.file.etaSeconds,
            });
        }
        if (state.repo) {
            return renderProgressLine({
                prefix: 'Repo',
                label: `${state.repo.repository} (${state.repo.filesDone}/${state.repo.filesTotal} files)`,
                received: state.repo.bytesDone,
                total: state.repo.bytesTotal,
            });
        }
        return null;
    };

    return {
        /** Start a repo (batch) download: aggregate progress over its files. */
        beginRepo({ repository, filesTotal, bytesTotal = null }) {
            clearLine();
            state.repo = {
                repository: repository || 'repo',
                filesTotal: filesTotal || 0,
                filesDone: 0,
                bytesTotal: Number.isFinite(bytesTotal) && bytesTotal > 0 ? bytesTotal : null,
                bytesDone: 0,
            };
            state.file = null;
            state.lastEmitAt = -Infinity;
            state.lastEmitBytes = 0;
        },

        /** A file that did not need downloading still counts toward aggregate. */
        fileSkipped(filePath, size = null) {
            if (!state.repo) return;
            state.repo.filesDone += 1;
            if (Number.isFinite(size) && size > 0) state.repo.bytesDone += size;
            state.lastEmitAt = -Infinity;
            state.lastEmitBytes = 0;
        },

        /** Start tracking one file. */
        beginFile(label, total = null) {
            clearLine();
            state.file = {
                label,
                received: 0,
                total: Number.isFinite(total) && total > 0 ? total : null,
                lastSampleAt: now(),
                lastSampleBytes: 0,
                rateBps: null,
                etaSeconds: null,
            };
            state.lastEmitAt = now();
            state.lastEmitBytes = 0;
        },

        /** Progress callback shape from io.http.download: { received, total }. */
        onChunk({ received, total } = {}) {
            const f = state.file;
            if (!f) return;
            if (Number.isFinite(received)) f.received = received;
            if (Number.isFinite(total) && total > 0 && f.total === null) f.total = total;
            const t = now();
            const dt = t - f.lastSampleAt;
            if (dt >= 400) {
                const instant = (f.received - f.lastSampleBytes) / (dt / 1000);
                // smoothed rate (EMA) so short stalls don't whipsaw the ETA
                f.rateBps = f.rateBps === null ? instant : (f.rateBps * 0.6 + instant * 0.4);
                if (Number.isFinite(f.rateBps) && f.rateBps > 0 && f.total) {
                    f.etaSeconds = (f.total - f.received) / f.rateBps;
                }
                f.lastSampleAt = t;
                f.lastSampleBytes = f.received;
            }
            const line = currentLine();
            if (!line) return;
            if (isTTY) {
                emitTTY(line);
            } else if (shouldEmit(t, f.received)) {
                state.lastEmitAt = t;
                state.lastEmitBytes = f.received;
                emitLog(line);
            }
        },

        /** Finish the current file. Always emits a final (throttle-free) line in non-TTY. */
        endFile({ status = 'downloaded', bytes = null } = {}) {
            const f = state.file;
            if (!f) return;
            clearLine();
            if (state.repo) {
                state.repo.filesDone += 1;
                const b = Number.isFinite(bytes) && bytes > 0 ? bytes : f.received;
                if (b > 0) state.repo.bytesDone += b;
            }
            const verb = status === 'skipped' ? 'Skipped'
                : status === 'resumed' ? 'Resumed'
                    : status === 'failed' ? 'FAILED'
                        : 'Downloaded';
            emitLog(renderProgressLine({
                prefix: verb,
                label: f.label,
                received: f.received,
                total: f.total,
            }));
            state.file = null;
            state.lastEmitAt = -Infinity;
            state.lastEmitBytes = 0;
        },

        /** Finish the repo download. */
        endRepo({ status = 'downloaded' } = {}) {
            clearLine();
            if (state.repo) {
                emitLog(renderProgressLine({
                    prefix: status === 'failed' ? 'Repo FAILED' : 'Repo complete',
                    label: `${state.repo.repository} (${state.repo.filesDone}/${state.repo.filesTotal} files)`,
                    received: state.repo.bytesDone,
                    total: state.repo.bytesTotal,
                }));
            }
            state.repo = null;
            state.file = null;
            state.active = false;
        },
    };
}

module.exports = {
    formatBytes,
    formatEta,
    renderProgressLine,
    createProgressReporter,
};

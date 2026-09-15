'use strict';

/**
 * Download progress — user-visible status for long downloads (ModelScope
 * repos, single artifacts).
 *
 * Requirements:
 *   - the user must SEE that the download is running, which file, how much
 *     was downloaded, the speed and the ETA;
 *   - batch (repo) downloads also show aggregate progress;
 *   - DO NOT spam the log: on a TTY the active download occupies ONE
 *     in-place line, redrawn only when time/percent/file changed (never
 *     once per network chunk); in non-TTY environments throttled plain
 *     lines (time AND byte-delta based), no ANSI escapes;
 *   - a completed download collapses into ONE final "[✓]" line (deduped);
 *   - indeterminate downloads (no Content-Length) get a spinner + bytes;
 *   - terminal output goes through the shared term renderer when provided,
 *     so installer status lines and the progress line never overwrite each
 *     other, and everything shares ONE stream;
 *   - fully injectable (isTTY/write/log/term/now) for deterministic tests.
 */

const { createTermRenderer } = require('./term');

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

const BAR_WIDTH = 20;

/** 0.68 → "[█████████████░░░░░░░]" (null when total unknown) */
function renderBar(received, total, width = BAR_WIDTH) {
    if (!Number.isFinite(total) || total <= 0) return null;
    const frac = Math.max(0, Math.min(1, received / total));
    const filled = Math.min(width, Math.round(frac * width));
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

/** Status markers: in-progress / done / failed. */
const MARK_OK = '[✓]';
const MARK_RUN = '[→]';
const MARK_FAIL = '[✗]';

function finalMarker(status) {
    return status === 'failed' ? MARK_FAIL : MARK_OK;
}

function finalVerb(status) {
    return status === 'skipped' ? 'Skipped'
        : status === 'resumed' ? 'Resumed'
            : status === 'failed' ? 'FAILED'
                : 'Downloaded';
}

/**
 * Create a progress reporter for one download step (single file or repo).
 *
 * @param {object} opts { isTTY, write, log, term, now, minIntervalMs, minDeltaBytes, minRedrawMs }
 *   - term: shared createTermRenderer() instance (preferred — one stream with
 *     installer status). When absent, a private renderer is built from
 *     isTTY/write, and permanent lines fall back to `log`.
 * @returns reporter with beginRepo/fileSkipped/beginFile/onChunk/endFile/endRepo
 */
function createProgressReporter(opts = {}) {
    const {
        isTTY = false,
        write = null,
        log = null,
        term = null,
        now = () => Date.now(),
        minIntervalMs = 2000,
        minDeltaBytes = 1 * 1024 * 1024,
        minRedrawMs = 120,
    } = opts;

    const tty = term ? term.isTTY : !!isTTY;

    const sinkWrite = write || (tty && typeof process !== 'undefined' && process.stdout && process.stdout.write
        ? (s) => { try { process.stdout.write(s); } catch (_) { /* gone */ } }
        : null);
    const sinkLog = log && typeof log.info === 'function' ? (msg) => log.info(msg) : null;

    const screen = term || (tty && sinkWrite
        ? createTermRenderer({ isTTY: true, write: sinkWrite, now, minRedrawMs })
        : null);

    const state = {
        repo: null, // { repository, filesTotal, filesDone, bytesTotal, bytesDone }
        file: null, // { label, received, total, lastSampleAt, lastSampleBytes, rateBps, etaSeconds }
        lastEmitAt: -Infinity,
        lastEmitBytes: 0,
        lastRedrawAt: -Infinity,
        lastRedrawPct: null,
        lastRedrawLabel: null,
    };

    // --- rendering ---------------------------------------------------------

    const repoNote = () => (state.repo
        ? `  ${state.repo.filesDone}/${state.repo.filesTotal} files`
        : '');

    /** The live status line (marker + bar + bytes + speed + ETA), or null. */
    const renderActive = () => {
        if (state.file) {
            const f = state.file;
            const note = repoNote();
            if (Number.isFinite(f.total) && f.total > 0) {
                const pct = Math.min(100, Math.floor((f.received / f.total) * 100));
                const parts = [
                    `${MARK_RUN} Downloading ${f.label}`,
                    renderBar(f.received, f.total),
                    `${pct}%`,
                    `${formatBytes(f.received)} / ${formatBytes(f.total)}`,
                ];
                if (Number.isFinite(f.rateBps) && f.rateBps > 0) parts.push(`${formatBytes(f.rateBps)}/s`);
                if (Number.isFinite(f.etaSeconds) && f.etaSeconds > 0) parts.push(`ETA ${formatEta(f.etaSeconds)}`);
                return parts.join('  ') + note;
            }
            // indeterminate: spinner + current file + bytes so far
            return `${MARK_RUN} Downloading ${f.label}  ${screen ? screen.spinnerFrame() : '·'}  ${formatBytes(f.received)}${note}`;
        }
        if (state.repo) {
            return renderProgressLine({
                prefix: `${MARK_RUN} Repo`,
                label: `${state.repo.repository} (${state.repo.filesDone}/${state.repo.filesTotal} files)`,
                received: state.repo.bytesDone,
                total: state.repo.bytesTotal,
            });
        }
        return null;
    };

    /** One final, permanent line per finished file/repo. */
    const renderFinal = (marker, prefix, label, received, total) => renderProgressLine({
        prefix: `${marker} ${prefix}`,
        label,
        received,
        total,
    });

    // --- sinks -------------------------------------------------------------

    /** Permanent line: via logger when available (archive + redaction),
     *  otherwise directly through the renderer (private-sink mode). */
    const emitFinal = (line) => {
        if (sinkLog) sinkLog(line);
        else if (screen) screen.print(line);
    };

    const clearLive = () => {
        if (screen) screen.clear();
        state.lastRedrawAt = -Infinity;
        state.lastRedrawPct = null;
        state.lastRedrawLabel = null;
    };

    /** Throttle decision for non-TTY environments. */
    const shouldEmit = (t, bytes) => {
        if (state.lastEmitAt === -Infinity) return true;
        if (t - state.lastEmitAt >= minIntervalMs && bytes - state.lastEmitBytes >= minDeltaBytes) return true;
        return false;
    };

    /** TTY redraw decision: on meaningful change (percent/file) or time tick. */
    const shouldRedraw = (t, pct, label) => {
        if (state.lastRedrawAt === -Infinity) return true;
        if (label !== state.lastRedrawLabel) return true;
        if (pct !== null && pct !== state.lastRedrawPct) return true;
        if (t - state.lastRedrawAt >= minRedrawMs) return true;
        return false;
    };

    return {
        /** Start a repo (batch) download: aggregate progress over its files. */
        beginRepo({ repository, filesTotal, bytesTotal = null }) {
            clearLive();
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
            if (tty && screen) {
                const line = renderActive();
                if (line) screen.status(line, { force: true });
            }
        },

        /** A file that did not need downloading: one "[✓]" line, aggregate count. */
        fileSkipped(filePath, size = null) {
            if (!state.repo) return;
            state.repo.filesDone += 1;
            if (Number.isFinite(size) && size > 0) state.repo.bytesDone += size;
            state.lastEmitAt = -Infinity;
            state.lastEmitBytes = 0;
            emitFinal(renderProgressLine({
                prefix: `${MARK_OK} Skipped`,
                label: `${filePath} (already present)`,
                received: Number.isFinite(size) && size > 0 ? size : 0,
                total: Number.isFinite(size) && size > 0 ? size : null,
            }));
        },

        /** Start tracking one file. */
        beginFile(label, total = null) {
            clearLive();
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
            if (tty && screen) {
                const line = renderActive();
                if (line) screen.status(line, { force: true });
            }
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
            const line = renderActive();
            if (!line) return;
            if (tty && screen) {
                // ONE in-place line; redraw on meaningful change or time tick —
                // never once per network chunk.
                const pct = Number.isFinite(f.total) && f.total > 0
                    ? Math.min(100, Math.floor((f.received / f.total) * 100))
                    : null;
                if (shouldRedraw(t, pct, f.label)) {
                    state.lastRedrawAt = t;
                    state.lastRedrawPct = pct;
                    state.lastRedrawLabel = f.label;
                    if (pct === null) screen.nextSpinnerFrame();
                    screen.status(renderActive());
                }
            } else if (shouldEmit(t, f.received)) {
                state.lastEmitAt = t;
                state.lastEmitBytes = f.received;
                if (sinkLog) sinkLog(line);
            }
        },

        /** Finish the current file. Always emits ONE final (throttle-free) line. */
        endFile({ status = 'downloaded', bytes = null } = {}) {
            const f = state.file;
            if (!f) return;
            clearLive();
            if (state.repo) {
                state.repo.filesDone += 1;
                const b = Number.isFinite(bytes) && bytes > 0 ? bytes : f.received;
                if (b > 0) state.repo.bytesDone += b;
            }
            emitFinal(renderProgressLine({
                prefix: `${finalMarker(status)} ${finalVerb(status)}`,
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
            clearLive();
            if (state.repo) {
                emitFinal(renderProgressLine({
                    prefix: `${finalMarker(status)} Repo ${status === 'failed' ? 'FAILED' : 'complete'}`,
                    label: `${state.repo.repository} (${state.repo.filesDone}/${state.repo.filesTotal} files)`,
                    received: state.repo.bytesDone,
                    total: state.repo.bytesTotal,
                }));
            }
            state.repo = null;
            state.file = null;
        },
    };
}

module.exports = {
    formatBytes,
    formatEta,
    renderProgressLine,
    renderBar,
    createProgressReporter,
};

'use strict';

/**
 * Terminal renderer — the SINGLE point through which the installer draws
 * anything on the terminal: permanent lines (logger output, plan text,
 * final download statuses), the one mutable "active status" line used by
 * download progress, and the busy spinner for long subprocess steps.
 *
 * Why it exists: before this module the progress line was drawn directly
 * on stderr while installer messages went to stdout — the two streams
 * interleaved arbitrarily and the progress redraw was not throttled, so
 * a long download painted hundreds of near-identical "Downloading …"
 * lines over the installer status.
 *
 * Contract:
 *   - TTY      → `status()` redraws ONE line in place (\r … ESC[K), time-
 *                throttled; `print()` first erases the active line, writes
 *                the permanent line, then re-renders the active line below
 *                it — installer messages, progress and the busy spinner
 *                never overwrite each other;
 *   - non-TTY  → `status()` and the spinner are no-ops, `print()` is a
 *                plain line. ANSI escape sequences are NEVER emitted, so
 *                pipes/CI/logs stay clean;
 *   - all output goes through ONE stream (stdout by default), so ordering
 *                with logger output is deterministic;
 *   - ONE status line, ONE owner: the busy spinner yields it to the
 *                download progress line while that is on screen and takes
 *                it back when the progress line is cleared;
 *   - fully injectable (isTTY/write/now/delayFn/tickFn) for deterministic
 *                tests.
 *
 * Note on external tools: spawnSync/spawn output is already captured (io.js)
 * and never streams to the terminal. Any future external downloader must be
 * piped through this renderer too — external processes must never draw their
 * own UI over the installer's terminal output.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];

/** 64000 → "1m 04s", 12400 → "12s" */
function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Create a terminal renderer.
 *
 * @param {object} opts { isTTY, write, now, minRedrawMs, ascii, delayFn, tickFn }
 * @returns renderer with status/print/clear/startBusy/stopBusy/withBusy/
 *          withBusySync/nextSpinnerFrame/spinnerFrame/isTTY/active/busy
 */
function createTermRenderer(opts = {}) {
    const {
        isTTY = false,
        write = null,
        now = () => Date.now(),
        minRedrawMs = 120,
        ascii = false,
        delayFn = (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
        tickFn = (ms, fn) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
    } = opts;

    const frames = ascii ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;

    const out = write || ((s) => {
        try {
            if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
        } catch (_) { /* stream gone */ }
    });

    const raw = (s) => { try { out(s); } catch (_) { /* stream gone */ } };

    const state = {
        activeText: null,   // text currently on the status line (or null)
        drawnText: null,    // text as last actually drawn (dedup)
        lastRedrawAt: -Infinity,
        spinnerIdx: 0,
        owner: null,        // who owns the status line: 'busy' | 'external' | null
    };

    let busy = null; // { label, startedAt, shown, cancelled, frame, keepalives, cancelShow, cancelTick, cancelKeep }

    const erase = () => {
        if (isTTY && state.activeText !== null) raw('\r\x1b[K');
    };

    const drawStatus = (text, owner) => {
        state.activeText = text;
        state.drawnText = text;
        state.lastRedrawAt = now();
        if (owner) state.owner = owner;
        raw(`\r${text}\x1b[K`);
    };

    return {
        isTTY: !!isTTY,

        /** True while a status line is on screen. */
        get active() { return state.activeText !== null; },

        /** True while a busy spinner is running (visible or pending). */
        get busy() { return busy !== null; },

        /**
         * Set/replace the active status line (throttled in time; identical
         * consecutive texts are never redrawn). `force` bypasses throttle —
         * used when the line changes meaningfully (file switch, first chunk).
         * Passing null clears the line. A drawn line takes ownership of the
         * status line, pausing the busy spinner until clear(). Non-TTY: no-op.
         */
        status(text, { force = false } = {}) {
            if (!isTTY) return;
            if (text === null || text === undefined) { this.clear(); return; }
            const t = now();
            if (!force && text === state.drawnText) return;
            if (!force && t - state.lastRedrawAt < minRedrawMs) return;
            drawStatus(text, 'external');
        },

        /** Advance and return the indeterminate-progress spinner frame. */
        nextSpinnerFrame() {
            state.spinnerIdx = (state.spinnerIdx + 1) % frames.length;
            return frames[state.spinnerIdx];
        },

        /** Current spinner frame (no advance). */
        spinnerFrame() { return frames[state.spinnerIdx]; },

        /**
         * Emit a PERMANENT line: erases the active status line first (so
         * logger output never merges into it), writes the line, then re-
         * renders the status line below it. Non-TTY: plain line, no ANSI.
         */
        print(line) {
            const had = state.activeText;
            erase();
            state.drawnText = null;
            raw(`${line}\n`);
            if (isTTY && had !== null) drawStatus(had); // keep the live status below the permanent line
        },

        /** Remove the active status line from screen (no replacement). */
        clear() {
            erase();
            state.activeText = null;
            state.drawnText = null;
            state.owner = null;
        },

        // -----------------------------------------------------------------
        // Busy indicator — ONE shared spinner for long subprocess steps
        // (pip install, npm install, git clone, waiting for ComfyUI, …).
        // -----------------------------------------------------------------

        /**
         * Start the busy spinner for a long operation.
         *
         * TTY: the line `[⠋] {label}...` appears only after `minShowMs`
         * (fast operations never flicker), then animates on `intervalMs`.
         * While the download progress line owns the status line the spinner
         * pauses; it resumes when that line is cleared.
         *
         * Non-TTY: no animation and no ANSI; a plain keepalive line
         * `... {label} ({elapsed})` every `keepaliveMs` (0 = off).
         *
         * @param {string} label operation name, e.g. "Installing ComfyUI requirements"
         * @param {object} [o] { immediate, minShowMs, intervalMs, keepaliveMs }
         */
        startBusy(label, o = {}) {
            if (busy) this.stopBusy({ ok: true }); // one busy at a time
            const {
                immediate = false,
                minShowMs = 400,
                intervalMs = 120,
                keepaliveMs = 30000,
            } = o;
            busy = {
                label: String(label),
                startedAt: now(),
                shown: false,
                cancelled: false,
                frame: 0,
                keepalives: 0,
                cancelShow: null,
                cancelTick: null,
                cancelKeep: null,
            };
            const show = () => {
                if (!busy || busy.cancelled) return;
                busy.shown = true;
                if (isTTY) this._drawBusy();
                if (isTTY) busy.cancelTick = tickFn(intervalMs, () => this._busyTick());
            };
            if (immediate) show();
            else busy.cancelShow = delayFn(minShowMs, show);
            if (!isTTY && keepaliveMs > 0) {
                busy.cancelKeep = tickFn(keepaliveMs, () => {
                    if (!busy || busy.cancelled) return;
                    busy.keepalives += 1;
                    raw(`... ${busy.label} (${formatDuration(now() - busy.startedAt)})\n`);
                });
            }
        },

        /** Internal: draw one busy frame (TTY). */
        _drawBusy() {
            if (!busy || !isTTY) return;
            drawStatus(`${frames[busy.frame % frames.length]} ${busy.label}...`, 'busy');
        },

        /** Internal: animation tick — advances the frame unless the status
         *  line is owned by the download progress. */
        _busyTick() {
            if (!busy || !busy.shown || busy.cancelled || !isTTY) return;
            if (state.owner === 'external' && state.activeText !== null) return; // progress line on screen — pause
            busy.frame += 1;
            this._drawBusy();
        },

        /**
         * Stop the busy spinner. When the spinner (or a keepalive) ever
         * became visible, ONE final line is emitted:
         *   `[✓] {label} (12s)` on success, `[✗] {label} FAILED (12s)` on
         * failure with `detail` on the following line. A fast operation
         * that never showed anything stays completely silent.
         */
        stopBusy({ ok = true, detail = null } = {}) {
            const b = busy;
            if (!b) return;
            busy = null;
            b.cancelled = true;
            if (b.cancelShow) b.cancelShow();
            if (b.cancelTick) b.cancelTick();
            if (b.cancelKeep) b.cancelKeep();
            const wasVisible = b.shown || b.keepalives > 0;
            if (!wasVisible && ok !== false) return; // fast op — no flicker, nothing to close; failures are ALWAYS shown
            const dur = formatDuration(now() - b.startedAt);
            const mark = ok ? '[✓]' : '[✗]';
            const head = `${mark} ${b.label}${ok ? '' : ' FAILED'} (${dur})`;
            this.clear();
            if (detail !== null && detail !== undefined && String(detail).trim() !== '') {
                const safe = String(detail).replace(/\r/g, '');
                this.print(head);
                for (const line of safe.split('\n').slice(0, 20)) {
                    if (line.trim() !== '') this.print(`  ${line}`);
                }
            } else {
                this.print(head);
            }
        },

        /**
         * Run an (async) operation under the busy spinner: starts it, stops
         * it with [✓]/[✗] and rethrows errors after closing the spinner.
         * The value of `fn()` is returned. Use for async work (animated
         * spinner) — for synchronous subprocess work use withBusySync.
         */
        async withBusy(label, fn, o) {
            this.startBusy(label, o);
            try {
                const result = await fn();
                this.stopBusy({ ok: true });
                return result;
            } catch (err) {
                this.stopBusy({ ok: false, detail: err && err.message ? String(err.message) : String(err) });
                throw err;
            }
        },

        /**
         * Synchronous variant: the static busy line is drawn IMMEDIATELY
         * (no animation is possible while spawnSync blocks the event loop),
         * then closed with one final [✓]/[✗] line. Use for long SYNC child
         * processes (git clone via exec, npm install, tar).
         */
        withBusySync(label, fn) {
            this.startBusy(label, { immediate: true });
            try {
                const result = fn();
                this.stopBusy({ ok: true });
                return result;
            } catch (err) {
                this.stopBusy({ ok: false, detail: err && err.message ? String(err.message) : String(err) });
                throw err;
            }
        },
    };
}

module.exports = {
    SPINNER_FRAMES,
    SPINNER_FRAMES_ASCII,
    formatDuration,
    createTermRenderer,
};

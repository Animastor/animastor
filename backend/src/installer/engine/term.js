'use strict';

/**
 * Terminal renderer — the SINGLE point through which the installer draws
 * anything on the terminal: permanent lines (logger output, plan text,
 * final download statuses) and the one mutable "active status" line used
 * by download progress.
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
 *                it — installer messages and progress never overwrite each
 *                other;
 *   - non-TTY  → `status()` is a no-op, `print()` is a plain line. ANSI
 *                escape sequences are NEVER emitted, so pipes/CI/logs stay
 *                clean;
 *   - all output goes through ONE stream (stdout by default), so ordering
 *                with logger output is deterministic;
 *   - fully injectable (isTTY/write/now) for deterministic tests.
 *
 * Note on external tools: spawnSync/spawn output is already captured (io.js)
 * and never streams to the terminal. Any future external downloader must be
 * piped through this renderer too — external processes must never draw their
 * own UI over the installer's terminal output.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Create a terminal renderer.
 *
 * @param {object} opts { isTTY, write, now, minRedrawMs }
 * @returns renderer with status/print/clear/nextSpinnerFrame/spinnerFrame/isTTY/active
 */
function createTermRenderer(opts = {}) {
    const {
        isTTY = false,
        write = null,
        now = () => Date.now(),
        minRedrawMs = 120,
    } = opts;

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
    };

    const erase = () => {
        if (isTTY && state.activeText !== null) raw('\r\x1b[K');
    };

    const drawStatus = (text) => {
        state.activeText = text;
        state.drawnText = text;
        state.lastRedrawAt = now();
        raw(`\r${text}\x1b[K`);
    };

    return {
        isTTY: !!isTTY,

        /** True while a status line is on screen. */
        get active() { return state.activeText !== null; },

        /**
         * Set/replace the active status line (throttled in time; identical
         * consecutive texts are never redrawn). `force` bypasses throttle —
         * used when the line changes meaningfully (file switch, first chunk).
         * Passing null clears the line. Non-TTY: no-op.
         */
        status(text, { force = false } = {}) {
            if (!isTTY) return;
            if (text === null || text === undefined) { this.clear(); return; }
            const t = now();
            if (!force && text === state.drawnText) return;
            if (!force && t - state.lastRedrawAt < minRedrawMs) return;
            drawStatus(text);
        },

        /** Advance and return the indeterminate-progress spinner frame. */
        nextSpinnerFrame() {
            state.spinnerIdx = (state.spinnerIdx + 1) % SPINNER_FRAMES.length;
            return SPINNER_FRAMES[state.spinnerIdx];
        },

        /** Current spinner frame (no advance). */
        spinnerFrame() { return SPINNER_FRAMES[state.spinnerIdx]; },

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
        },
    };
}

module.exports = {
    SPINNER_FRAMES,
    createTermRenderer,
};

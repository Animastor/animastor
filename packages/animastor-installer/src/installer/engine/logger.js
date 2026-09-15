'use strict';

/**
 * Logger — Private Worker Installer Phase 2.
 *
 * Diagnostic logging with step/duration tracking and a hard secret-redaction
 * layer. Every line that leaves the logger passes through redaction:
 *   - registered secret VALUES (Worker Key, HF token…) are scrubbed;
 *   - KEY=value assignments of secret-looking names are masked.
 * The Worker Key and download tokens are registered here the moment they are
 * entered and are never logged, stored in state, or put in reports.
 */

const { redactSecrets, isSecretName } = require('../safety-rules');

function createLogger({ io, sink = null, quiet = false } = {}) {
    const secrets = new Set();
    const lines = [];

    function emit(level, msg) {
        const safe = redact(String(msg), secrets);
        const ts = new Date(io.now()).toISOString();
        const line = `[${ts}] [${level}] ${safe}`;
        lines.push(line);
        if (!quiet) {
            if (sink) sink(line);
            else console.log(line); // eslint-disable-line no-console
        }
    }

    function redact(text, secretSet) {
        let out = redactSecrets(text, Array.from(secretSet));
        // belt & braces: mask any wrk.<id>.<secret> shaped token
        out = out.replace(/wrk\.[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, (m) => {
            const parts = m.split('.');
            return `wrk.${parts[1]}.<REDACTED>`;
        });
        return out;
    }

    return {
        /** Register a secret value for redaction from ALL further output. */
        registerSecret(value) {
            if (value) secrets.add(String(value));
        },
        /** Redact secrets from a string WITHOUT logging it — used when
         *  subprocess output lines are surfaced through the terminal. */
        scrub: (msg) => redact(String(msg), secrets),
        info: (msg) => emit('INFO', msg),
        warn: (msg) => emit('WARN', msg),
        error: (msg) => emit('ERROR', msg),
        /** Raw user-facing output (plan text, reports) — still redacted. */
        output: (msg) => emit('OUT', msg),
        /**
         * Run fn inside a named step; logs start, result and duration.
         * Returns { ok, value|error, ms }.
         */
        async step(name, fn) {
            emit('STEP', `${name} — started`);
            const t0 = io.now();
            try {
                const value = await fn();
                emit('STEP', `${name} — done (${io.now() - t0} ms)`);
                return { ok: true, value, ms: io.now() - t0 };
            } catch (err) {
                emit('STEP', `${name} — FAILED (${io.now() - t0} ms): ${err && err.message ? err.message : err}`);
                return { ok: false, error: err, ms: io.now() - t0 };
            }
        },
        lines,
        isSecretName,
    };
}

module.exports = { createLogger };

'use strict';

/**
 * Terminal renderer + download progress normalization tests.
 *
 *  T1  renderer: status redraw is throttled and deduped (TTY)
 *  T2  renderer: print() interleaves cleanly with an active status line
 *  T3  renderer: non-TTY emits NO ANSI escape sequences, status is a no-op
 *  T4  renderer: spinner frames cycle
 *  P1  progress: thousands of chunks → bounded number of redraws (TTY)
 *  P2  progress: final status emitted EXACTLY once (double endFile safe)
 *  P3  progress: non-TTY output has no ANSI escapes at all
 *  P4  progress: failures are visible ([✗] FAILED) and log warnings survive
 *  P5  progress: installer messages interleave with the active line without
 *      corrupting it (shared term renderer, as wired by cli.js)
 *  P6  progress: bar rendering
 *  P7  progress: shared term + logger wiring emits each final line once
 */

const assert = require('assert');
const { createTermRenderer, SPINNER_FRAMES } = require('../src/installer/engine/term');
const progress = require('../src/installer/engine/progress');

function collect() {
    const out = [];
    return { out, write: (s) => out.push(s) };
}

describe('term renderer', () => {
    it('T1: status() dedups identical text (no pointless redraws); changing text redraws within throttle', () => {
        const { out, write } = collect();
        let t = 1000;
        const r = createTermRenderer({ isTTY: true, write, now: () => t });
        r.status('a', { force: true });
        r.status('a'); // identical — no redraw
        t += 10;
        r.status('a'); // identical — still no redraw
        t += 200;
        r.status('b'); // changed text after throttle window — redraw
        t += 200;
        r.status('b'); // identical — no redraw
        const draws = out.filter((s) => s.startsWith('\r')).length;
        assert.strictEqual(draws, 2, `draws: ${JSON.stringify(out)}`);
        assert.ok(out.every((s) => s.includes('\x1b[K')), 'every draw clears to EOL');
    });

    it('T2: print() erases the active line, writes the message, redraws status below', () => {
        const { out, write } = collect();
        let t = 1000;
        const r = createTermRenderer({ isTTY: true, write, now: () => t, minRedrawMs: 0 });
        r.status('downloading…', { force: true });
        out.length = 0;
        r.print('[INFO] some installer message');
        assert.deepStrictEqual(out, ['\r\x1b[K', '[INFO] some installer message\n', '\rdownloading…\x1b[K']);
        assert.strictEqual(r.active, true);
    });

    it('T3: non-TTY print is a plain line, status is a no-op, zero ANSI', () => {
        const { out, write } = collect();
        const r = createTermRenderer({ isTTY: false, write, now: () => 0 });
        r.status('should not appear');
        r.print('plain line');
        r.print('another [✓] line');
        assert.deepStrictEqual(out, ['plain line\n', 'another [✓] line\n']);
        assert.ok(out.join('').indexOf('\x1b') === -1, 'no escape sequences');
        assert.strictEqual(r.active, false);
    });

    it('T4: spinner frames cycle through the braille set', () => {
        const r = createTermRenderer({ isTTY: false, write: () => {} });
        const seen = new Set();
        for (let i = 0; i < 25; i++) seen.add(r.nextSpinnerFrame());
        assert.deepStrictEqual(seen, new Set(SPINNER_FRAMES));
    });

    it('T5: clear() removes the status line', () => {
        const { out, write } = collect();
        const r = createTermRenderer({ isTTY: true, write, now: () => 0 });
        r.status('x', { force: true });
        r.clear();
        assert.strictEqual(r.active, false);
        assert.strictEqual(out[out.length - 1], '\r\x1b[K');
    });
});

describe('download progress normalization', () => {
    it('P1: 5000 chunks produce a bounded number of TTY redraws, not 5000 lines', () => {
        const { out, write } = collect();
        let t = 1000;
        const rep = progress.createProgressReporter({
            isTTY: true,
            write,
            now: () => t,
            minRedrawMs: 120,
        });
        rep.beginFile('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors', 3.5 * 1024 ** 3);
        for (let i = 1; i <= 5000; i++) {
            t += 1; // chunks arrive every millisecond
            rep.onChunk({ received: i * (3.5 * 1024 ** 3) / 5000, total: 3.5 * 1024 ** 3 });
        }
        rep.endFile({ status: 'downloaded' });
        const draws = out.filter((s) => s.startsWith('\r[→]')).length;
        const finalLines = out.filter((s) => s.startsWith('[✓]')).length;
        // redraws ≤ percent changes (~100) + time ticks (5s / 120ms ≈ 41) + first draw
        assert.ok(draws > 0 && draws <= 160, `bounded redraws, got ${draws}`);
        assert.strictEqual(finalLines, 1, 'exactly one final line');
        assert.ok(out.filter((s) => s.includes('\n')).length === 1, 'only the final line breaks the line');
    });

    it('P2: double endFile / endRepo never duplicate the final status', () => {
        const { out, write } = collect();
        const rep = progress.createProgressReporter({ isTTY: true, write, now: () => 1000 });
        rep.beginFile('f.bin', 100);
        rep.onChunk({ received: 100, total: 100 });
        rep.endFile({ status: 'downloaded' });
        rep.endFile({ status: 'downloaded' }); // engine + caller both call it — must be safe
        const finals = out.filter((s) => s.startsWith('[✓] Downloaded')).length;
        assert.strictEqual(finals, 1, JSON.stringify(out));
    });

    it('P3: non-TTY output (pipe/CI/log) contains no ANSI escapes and no carriage returns', () => {
        const lines = [];
        const rep = progress.createProgressReporter({
            isTTY: false,
            log: { info: (m) => lines.push(m) },
            now: () => 1000,
        });
        rep.beginRepo({ repository: 'Qwen/Qwen3-TTS', filesTotal: 1, bytesTotal: 1000 });
        rep.fileSkipped('config.json', 100);
        rep.beginFile('model.safetensors', 900);
        for (let i = 1; i <= 50; i++) rep.onChunk({ received: i * 18, total: 900 });
        rep.endFile({ status: 'downloaded' });
        rep.endRepo({ status: 'downloaded' });
        const joined = lines.join('\n');
        assert.ok(!joined.includes('\x1b'), 'no ANSI escapes');
        assert.ok(!joined.includes('\r'), 'no carriage returns');
        assert.ok(lines.some((l) => l.startsWith('[✓] Downloaded model.safetensors')), lines.join('|'));
        assert.ok(lines.some((l) => l.includes('Repo complete')), lines.join('|'));
    });

    it('P4: failures are visible ([✗] FAILED) and downloader warnings are not swallowed', () => {
        const { out, write } = collect();
        const warns = [];
        let t = 1000;
        const rep = progress.createProgressReporter({ isTTY: true, write, now: () => t });
        rep.beginFile('broken.bin', 1000);
        t += 500;
        rep.onChunk({ received: 100, total: 1000 });
        rep.endFile({ status: 'failed' });
        // installer messages still print normally while nothing is active
        const r = createTermRenderer({ isTTY: true, write, now: () => t });
        r.print('attempt 1/3 failed: HTTP 503 from source');
        const joined = out.join('');
        assert.ok(joined.includes('[✗] FAILED broken.bin'), 'failure line present');
        assert.ok(joined.includes('attempt 1/3 failed: HTTP 503 from source\n'), 'warnings preserved');
    });

    it('P5: shared term renderer — installer messages and progress never overwrite each other', () => {
        const { out, write } = collect();
        let t = 1000;
        const screen = createTermRenderer({ isTTY: true, write, now: () => t, minRedrawMs: 0 });
        const rep = progress.createProgressReporter({ isTTY: true, term: screen, now: () => t });
        rep.beginFile('model.safetensors', 1000);
        rep.onChunk({ received: 400, total: 1000 });
        out.length = 0;
        // a logger line arrives mid-download (as via logger sink → screen.print)
        screen.print('[INFO] [STEP] download model qwen3-tts — started');
        const seq = out.join('');
        // erase → message (intact, one clean line) → status redrawn below
        assert.ok(seq.startsWith('\r\x1b[K'), 'active line erased before the message');
        assert.strictEqual(out[1], '[INFO] [STEP] download model qwen3-tts — started\n', 'message is one intact line');
        assert.ok(out[out.length - 1].startsWith('\r[→] Downloading model.safetensors'), 'status re-rendered after the message');
    });

    it('P6: renderBar fills proportionally', () => {
        assert.strictEqual(progress.renderBar(0, 100), '[░░░░░░░░░░░░░░░░░░░░]');
        assert.strictEqual(progress.renderBar(50, 100), '[██████████░░░░░░░░░░]');
        assert.strictEqual(progress.renderBar(100, 100), '[████████████████████]');
        assert.strictEqual(progress.renderBar(10, 0), null, 'unknown total → no bar');
        assert.strictEqual(progress.renderBar(150, 100), '[████████████████████]', 'clamped');
    });

    it('P7: shared term + logger wiring (as in cli.js) prints each final line exactly once', () => {
        const { out, write } = collect();
        let t = 1000;
        const screen = createTermRenderer({ isTTY: true, write, now: () => t });
        const log = { info: (m) => screen.print(m) }; // logger sink → screen
        const rep = progress.createProgressReporter({ isTTY: true, term: screen, log, now: () => t });
        rep.beginFile('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors', 1000);
        rep.onChunk({ received: 500, total: 1000 });
        rep.endFile({ status: 'downloaded' });
        const finalOccurrences = out.join('').split('[✓] Downloaded').length - 1;
        assert.strictEqual(finalOccurrences, 1, 'one visual final line, no duplicate via logger sink');
    });
});

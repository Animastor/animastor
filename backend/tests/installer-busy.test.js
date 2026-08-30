'use strict';

/**
 * Busy indicator tests — the shared spinner for long subprocess steps
 * (pip install, npm install, git clone, waiting for ComfyUI, …) drawn
 * through the single term renderer.
 *
 *  B1  spinner starts after the min-show threshold (TTY), animates
 *  B2  immediate (sync) mode draws at once
 *  B3  fast op (< minShowMs) never flickers — silent start AND stop
 *  B4  success → one "[✓]" final line; failure → "[✗] … FAILED" + detail
 *  B5  log lines print correctly during busy (erased / re-rendered)
 *  B6  download progress and busy spinner share ONE line without conflict
 *  B7  non-TTY: no ANSI at all, keepalive lines instead of animation
 *  B8  withBusy rethrows the error after closing the spinner
 *  B9  second startBusy closes the first (single busy at a time)
 *  B10 execAsync: line callback, CR filtering, raw capture, timeout
 *  B11 preparePythonRuntime streams pip output lines via term+log.scrub
 */

const assert = require('assert');
const { createTermRenderer, SPINNER_FRAMES, SPINNER_FRAMES_ASCII } = require('../src/installer/engine/term');
const { createRealIo } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const comfyui = require('../src/installer/engine/comfyui');

function collect() {
    const out = [];
    return { out, write: (s) => out.push(s) };
}

/** Deterministic timers: delayFn/tickFn driven by a virtual clock. */
function makeTimers() {
    const jobs = []; // { at, fn, repeat }
    let t = 0;
    const clock = {
        now: () => t,
        advance(ms) {
            const target = t + ms;
            for (;;) {
                const next = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at)[0];
                if (!next) break;
                t = Math.max(t, next.at);
                if (next.repeat) next.at += next.every; else jobs.splice(jobs.indexOf(next), 1);
                next.fn();
                if (next.repeat && !jobs.includes(next)) break; // cancelled inside fn
            }
            t = target;
        },
    };
    const delayFn = (ms, fn) => { jobs.push({ at: t + ms, fn }); return () => { const i = jobs.findIndex((j) => j.fn === fn); if (i >= 0) jobs.splice(i, 1); }; };
    const tickFn = (every, fn) => {
        const j = { at: t + every, fn, repeat: true, every };
        jobs.push(j);
        return () => { const i = jobs.indexOf(j); if (i >= 0) jobs.splice(i, 1); };
    };
    return { clock, delayFn, tickFn };
}

function makeTty(o = {}) {
    const { out, write } = collect();
    const timers = makeTimers();
    const r = createTermRenderer({
        isTTY: true,
        write,
        now: timers.clock.now,
        delayFn: timers.delayFn,
        tickFn: timers.tickFn,
        ...o,
    });
    return { r, out, timers };
}

describe('busy indicator (term renderer)', () => {
    it('B1: spinner appears after minShowMs and animates; stop emits one [✓] with duration', () => {
        const { r, out, timers } = makeTty();
        r.startBusy('Installing ComfyUI requirements');
        assert.strictEqual(r.busy, true);
        assert.strictEqual(out.join(''), '', 'nothing drawn before minShowMs');
        timers.clock.advance(400);
        assert.ok(out.join('').includes('⠋ Installing ComfyUI requirements...'), out.join(''));
        timers.clock.advance(360); // 3 ticks
        assert.ok(out.join('').includes('⠸'), 'frame advanced');
        r.stopBusy({ ok: true });
        const plain = out.join('').replace(/\r/g, '').replace(/\x1b\[K/g, '');
        const finals = plain.match(/\[✓\] Installing ComfyUI requirements \(\d+s\)/g) || [];
        assert.strictEqual(finals.length, 1, `one [✓] final line with duration: ${plain}`);
        assert.strictEqual(r.busy, false);
        assert.strictEqual(r.active, false);
    });

    it('B2: withBusySync draws immediately (sync subprocess cannot animate)', () => {
        const { r, out } = makeTty();
        const val = r.withBusySync('Cloning ComfyUI', () => 42);
        assert.strictEqual(val, 42);
        assert.ok(out.join('').includes('⠋ Cloning ComfyUI...'), 'immediate first frame');
        assert.ok(out.join('').includes('[✓] Cloning ComfyUI'), out.join(''));
    });

    it('B3: a fast operation (< minShowMs) never flickers — no start line, no final line', () => {
        const { r, out, timers } = makeTty();
        r.startBusy('quick step');
        r.stopBusy({ ok: true });
        timers.clock.advance(5000);
        assert.strictEqual(out.join(''), '', `silence expected: ${JSON.stringify(out)}`);
    });

    it('B4: failure emits one [✗] FAILED line plus the error detail (diagnostics preserved)', () => {
        const { r, out, timers } = makeTty();
        r.startBusy('Installing Python runtime', { immediate: true });
        timers.clock.advance(10);
        r.stopBusy({ ok: false, detail: 'pip install failed: HTTP 503\n  line2' });
        const text = out.join('');
        assert.ok(text.includes('[✗] Installing Python runtime FAILED'), text);
        assert.ok(text.includes('pip install failed: HTTP 503'), 'error detail present');
        assert.ok(text.includes('line2'), 'multi-line detail preserved');
        // detail must be plain permanent lines, never merged into the spinner
        assert.ok(text.split('\n').every((l) => !l.includes('⠋') || !l.includes('pip install')), 'no overlap');
    });

    it('B5: log lines print during busy — spinner erased before, redrawn after', () => {
        const { r, out, timers } = makeTty();
        r.startBusy('Installing ComfyUI requirements', { immediate: true });
        timers.clock.advance(10);
        out.length = 0;
        r.print('Collecting sqlalchemy');
        const seq = out.join('').replace(/\x1b\[K/g, '');
        assert.ok(seq.startsWith('\r'), 'spinner erased before the log line');
        assert.ok(seq.includes('\rCollecting sqlalchemy\n'), 'log line intact');
        assert.ok(seq.endsWith('\r⠋ Installing ComfyUI requirements...'), 'spinner redrawn after');
    });

    it('B6: download progress and busy spinner never conflict — spinner pauses while progress owns the line', () => {
        const { r, out, timers } = makeTty();
        r.startBusy('Installing ComfyUI requirements', { immediate: true });
        // download progress takes over the status line (as wired in engine)
        r.status('[→] Downloading model.safetensors  50%', { force: true });
        out.length = 0;
        timers.clock.advance(1000); // busy ticks would fire 8×
        assert.strictEqual(out.join(''), '', 'spinner must not draw over the progress line');
        r.clear(); // progress done — releases the line
        out.length = 0;
        timers.clock.advance(130);
        const resumed = out.join('').replace(/\x1b\[K/g, '');
        assert.ok(/^⠙|^⠋/.test(resumed.replace(/^\r/, '')), `spinner resumed: ${JSON.stringify(out)}`);
        assert.ok(resumed.includes('Installing ComfyUI requirements'), 'busy label redrawn');
        r.stopBusy({ ok: true });
        assert.ok(out.join('').includes('[✓] Installing ComfyUI requirements'), out.join(''));
        assert.strictEqual(out.filter((s) => s.includes('[✓]')).length, 1, 'exactly one final line');
    });

    it('B7: non-TTY — zero ANSI, keepalive lines replace the animation, stop is a plain line', () => {
        const { out, write } = collect();
        const timers = makeTimers();
        const r = createTermRenderer({
            isTTY: false,
            write,
            now: timers.clock.now,
            delayFn: timers.delayFn,
            tickFn: timers.tickFn,
        });
        r.startBusy('Installing ComfyUI requirements', { keepaliveMs: 1000 });
        timers.clock.advance(2500);
        r.stopBusy({ ok: true });
        const text = out.join('');
        assert.ok(!text.includes('\x1b') && !text.includes('\r'), `no ANSI/CR: ${JSON.stringify(out)}`);
        assert.strictEqual(text.split('\n').filter((l) => l.startsWith('... ')).length, 2, 'keepalives at 1s and 2s');
        assert.ok(text.includes('[✓] Installing ComfyUI requirements'), text);
    });

    it('B7b: ascii mode uses the ASCII spinner set (non-UTF-8 terminals)', () => {
        const { r, out } = makeTty({ ascii: true });
        r.withBusySync('Installing requirements', () => {});
        const text = out.join('');
        assert.ok(SPINNER_FRAMES_ASCII.some((f) => text.includes(`${f} Installing requirements`)), text);
        assert.ok(!SPINNER_FRAMES.some((f) => f.length > 1 && text.includes(f)), 'no braille frames in ascii mode');
    });

    it('B8: withBusy rethrows after closing the spinner', async () => {
        const { r, out } = makeTty();
        await assert.rejects(
            () => r.withBusy('failing op', async () => { throw new Error('boom'); }),
            /boom/,
        );
        const text = out.join('');
        assert.ok(text.includes('[✗] failing op FAILED'), text);
        assert.ok(text.includes('boom'), text);
        assert.strictEqual(r.busy, false);
    });

    it('B9: a second startBusy closes the first busy (ONE busy at a time)', () => {
        const { r, out } = makeTty();
        r.startBusy('first', { immediate: true });
        r.startBusy('second', { immediate: true });
        const text = out.join('');
        assert.ok(text.includes('[✓] first'), 'first closed with [✓]');
        assert.ok(text.includes('second'), 'second is active');
        r.stopBusy({ ok: true });
        assert.strictEqual(out.filter((s) => s.includes('[✓] second')).length, 1);
    });

    it('B10: execAsync — onLine gets complete lines, CR fragments filtered, raw output captured, timeout kills', async () => {
        const io = createRealIo();
        const lines = [];
        const r1 = await io.execAsync(process.execPath, ['-e', 'console.log("a"); console.log("b\\r(pip bar)"); console.log("c")'], { onLine: (l) => lines.push(l) });
        assert.strictEqual(r1.code, 0);
        assert.deepStrictEqual(lines, ['a', 'c'], 'CR-progress fragment filtered, complete lines only');
        assert.ok(r1.stdout.includes('(pip bar)'), 'raw stdout still captured');

        const t0 = Date.now();
        const r2 = await io.execAsync('sleep', ['5'], { timeout: 150 });
        assert.ok(Date.now() - t0 < 3000, 'killed early');
        assert.strictEqual(r2.code, -1, `code: ${r2.code}`);
        assert.ok(r2.error && r2.error.includes('timed out'), r2.error);

        const r3 = await io.execAsync(process.execPath, ['-e', 'console.error("to-stderr"); process.exit(3)']);
        assert.strictEqual(r3.code, 3);
        assert.ok(r3.stderr.includes('to-stderr'), 'stderr captured');
    });

    it('B11: preparePythonRuntime streams pip output via term (scrubbed through the logger)', async () => {
        const { out, write } = collect();
        const timers = makeTimers();
        const term = createTermRenderer({ isTTY: true, write, now: timers.clock.now, delayFn: timers.delayFn, tickFn: timers.tickFn });
        const io = createRealIo();
        const log = createLogger({ io, sink: (line) => term.print(line) });
        log.registerSecret('super-secret-token');

        // mock a slow pip on PATH via a temp dir script? — simpler: mock io.execAsync directly
        io.execAsync = async (cmd, args, opts = {}) => {
            if (args.join(' ').includes('install')) {
                for (const l of ['Collecting sqlalchemy', 'Installing collected packages: sqlalchemy', 'Successfully installed sqlalchemy']) {
                    if (opts.onLine) opts.onLine(l);
                }
            }
            return { code: 0, stdout: '', stderr: '' };
        };
        // venv already exists with pip
        io.fs = {
            existsSync: (p) => String(p).endsWith('python') || String(p).endsWith('requirements.txt'),
            statSync: () => ({ size: 1, isFile: true, isDirectory: false }),
            mkdirSync: () => {}, writeFileSync: () => {},
        };

        const run = term.withBusy('Installing ComfyUI requirements', () => comfyui.preparePythonRuntime(io, {
            root: '/tmp/comfy', torchSpec: null, log, term,
        }), { immediate: true });
        await run;
        const text = out.join('');
        assert.ok(text.includes('Collecting sqlalchemy'), `pip lines streamed: ${text}`);
        assert.ok(text.includes('[✓] Installing ComfyUI requirements'), 'one final [✓] line');
        assert.strictEqual(text.match(/\[✓\] Installing ComfyUI requirements/g).length, 1, 'final line exactly once');
    });
});

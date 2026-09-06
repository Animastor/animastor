// ======================================================
// animastor-worker — cleanup tests (worker-cleanup.cjs)
// ======================================================
// Точечная уборка временных файлов ComfyUI: image/video/audio сценарии,
// сохранение output при незавершённой доставке и устойчивость к
// отсутствующим файлам. Сам worker.cjs (монолитный скрипт с
// fetch/nvidia-smi) не юнитится — тестируется изолированный модуль
// cleanup. Порт из backend/tests/worker-cleanup.test.js (Phase 9D:
// package-owned unit tests moved into the package).

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const { safeUnlink, cleanupJobArtifacts } = require('../worker/worker-cleanup.cjs');

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'worker-cleanup-test-'));
}

async function exists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
}

async function writeFiles(dir, names) {
    const paths = names.map((n) => path.join(dir, n));
    for (const p of paths) await fsp.writeFile(p, 'x');
    return paths;
}

describe('worker-cleanup — safeUnlink', () => {
    it('removes an existing file and reports ok', async () => {
        const dir = await tmpDir();
        const file = path.join(dir, 'a.png');
        await fsp.writeFile(file, 'x');

        const res = await safeUnlink(file);
        expect.equal(res.ok, true);
        expect.equal(await exists(file), false);
    });

    it('missing file → ok (ENOENT is not an error)', async () => {
        const dir = await tmpDir();
        const res = await safeUnlink(path.join(dir, 'nope.png'));
        expect.equal(res.ok, true);
        expect.equal(res.missing, true);
    });

    it('unremovable path (directory) → ok:false with a reason, never throws', async () => {
        const dir = await tmpDir();
        const res = await safeUnlink(dir);
        expect.equal(res.ok, false);
        expect.typeOf(res.error, 'string');
    });
});

describe('worker-cleanup — cleanupJobArtifacts', () => {
    it('image job: input file + output file are both removed', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['img_input.png']))[0];
        const output = (await writeFiles(dir, ['ComfyUI_00001_.png']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: [input], outputFile: output });
        expect.equal(res.cleaned, 2);
        expect.deepEqual(res.failed, []);
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), false);
    });

    it('video job: all reference input files + output mp4 are removed', async () => {
        const dir = await tmpDir();
        const inputs = await writeFiles(dir, ['sc_iu1.png', 'sc_iu2.png', 'sc_iu3.png', 'sc_iu4.png']);
        const output = (await writeFiles(dir, ['LTX-2_00001_.mp4']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: inputs, outputFile: output });
        expect.equal(res.cleaned, 5);
        expect.equal(await exists(output), false);
        for (const p of inputs) expect.equal(await exists(p), false);
    });

    it('audio job: no input files, output mp3 is removed', async () => {
        const dir = await tmpDir();
        const output = (await writeFiles(dir, ['tts_00001_.mp3']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: [], outputFile: output });
        expect.equal(res.cleaned, 1);
        expect.equal(await exists(output), false);
    });

    it('generation error: input removed, output not touched (no outputFile passed)', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['sc_iu1.png']))[0];
        const strayOutput = (await writeFiles(dir, ['LTX-2_00001_.mp4']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: [input], outputFile: null });
        expect.equal(res.cleaned, 1);
        expect.equal(await exists(input), false);
        expect.equal(await exists(strayOutput), true);
    });

    it('download/sendResult error: output is preserved (not passed to cleanup)', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['sc_iu1.png']))[0];
        const output = (await writeFiles(dir, ['LTX-2_00001_.mp4']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: [input], outputFile: null });
        expect.equal(res.cleaned, 1);
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), true);
    });

    it('missing file during cleanup does not crash: counted as cleaned, others removed', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['exists.png']))[0];
        const ghost = path.join(dir, 'already-deleted.png');

        const res = await cleanupJobArtifacts({ inputFiles: [ghost, input], outputFile: null });
        expect.equal(res.cleaned, 2);
        expect.deepEqual(res.failed, []);
        expect.equal(await exists(input), false);
    });

    it('one unremovable file (directory) does not stop cleanup of the rest', async () => {
        const dir = await tmpDir();
        const sub = await fsp.mkdir(path.join(dir, 'subdir'));
        const input = (await writeFiles(dir, ['ok.png']))[0];

        const res = await cleanupJobArtifacts({ inputFiles: [sub, input], outputFile: null });
        expect.equal(res.cleaned, 1);
        expect.equal(res.failed.length, 1);
        expect.equal(res.failed[0].path, sub);
        expect.typeOf(res.failed[0].reason, 'string');
        expect.equal(await exists(input), false);
    });

    it('returns the outputFile it was asked to remove', async () => {
        const dir = await tmpDir();
        const output = (await writeFiles(dir, ['out.mp4']))[0];
        const res = await cleanupJobArtifacts({ inputFiles: [], outputFile: output });
        expect.equal(res.outputFile, output);
        expect.equal(await exists(output), false);
    });
});

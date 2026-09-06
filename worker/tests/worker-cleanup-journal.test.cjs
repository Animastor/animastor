// ======================================================
// animastor-worker — cleanup journal tests (worker-cleanup-journal.cjs)
// ======================================================
// Тестирует worker-cleanup-journal.cjs (CREATED→GENERATED→DELIVERED→CLEANED)
// и recoverCleanupJournal(): доставленные job дочищаются, недоставленные —
// только input, частичный cleanup держит запись, corruption безопасен.
// Порт из backend/tests/worker-cleanup-journal.test.js (Phase 9D:
// package-owned unit tests moved into the package).

const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const journal = require('../worker/worker-cleanup-journal.cjs');

const silentLog = () => {};

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'worker-journal-test-'));
}

async function exists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
}

async function writeFiles(dir, names) {
    const paths = names.map((n) => path.join(dir, n));
    for (const p of paths) await fsp.writeFile(p, 'x');
    return paths;
}

// Полная последовательность lifecycle: created → inputs → generated → delivered.
async function buildJournal(dir, { jobId, dispatchId, inputs = [], output = null, delivered = true } = {}) {
    const jid = jobId || 'book_ch_sc_0001:audio';
    const did = dispatchId || 'dispatch-test-1';
    const opts = { journalDir: dir, jobId: jid, dispatchId: did, log: silentLog };
    await journal.createJob(opts);
    for (const p of inputs) await journal.addInputFile(opts, p);
    if (output) await journal.setOutputAndGenerated(opts, output);
    if (delivered) await journal.setDelivered(opts);
    return { jobId: jid, dispatchId: did, opts };
}

describe('worker-cleanup-journal — create + transitions', () => {
    it('new job creates a journal record with phase=created', async () => {
        const dir = await tmpDir();
        const rec = await journal.createJob({ journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog });
        expect.exist(rec);
        expect.equal(rec.phase, 'created');
        expect.deepEqual(rec.input_files, []);
        expect.equal(rec.output_file, null);

        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        expect.equal(await exists(file), true);
        // Атомарная запись не оставляет tmp-хвостов.
        const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp.json'));
        expect.deepEqual(leftovers, []);
    });

    it('image job: one input path is recorded', async () => {
        const dir = await tmpDir();
        const input = path.join(dir, 'in.png');
        await journal.createJob({ journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog });
        await journal.addInputFile({ journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog }, input);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect.deepEqual(rec.input_files, [input]);
    });

    it('video job: all reference images are recorded (dedup-safe)', async () => {
        const dir = await tmpDir();
        const inputs = await writeFiles(dir, ['iu1.png', 'iu2.png', 'iu3.png', 'iu4.png']);
        const opts = { journalDir: dir, jobId: 'b_c_s_g1:video', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        for (const p of inputs) await journal.addInputFile(opts, p);
        // повторная запись того же пути не дублируется
        await journal.addInputFile(opts, inputs[0]);

        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_g1:video')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect.deepEqual(rec.input_files, inputs);
        expect.equal(rec.input_files.length, 4);
    });

    it('generated stores the output path', async () => {
        const dir = await tmpDir();
        const output = path.join(dir, 'out', 'result.mp4');
        const opts = { journalDir: dir, jobId: 'b_c_s_g1:video', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setOutputAndGenerated(opts, output);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_g1:video')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect.equal(rec.phase, 'generated');
        expect.equal(rec.output_file, output);
    });

    it('delivered is set after successful sendResult (transition order)', async () => {
        const dir = await tmpDir();
        const opts = { journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setDelivered(opts);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect.equal(rec.phase, 'delivered');
    });
});

describe('worker-cleanup-journal — recoverCleanupJournal', () => {
    it('delivered recovery deletes input + output and removes the journal', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        const { opts } = await buildJournal(dir, { inputs: [input], output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.found, 1);
        expect.equal(res.cleaned, 2);
        expect.equal(res.kept, 0);
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), false);
        expect.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    });

    it('created recovery deletes input but keeps output', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input], output, delivered: false });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.cleaned, 1);
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), true);
        // всё удалилось (input), journal можно убрать
        expect.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    });

    it('generated recovery deletes input but keeps output', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input], output, delivered: false });

        const file = path.join(dir, `${journal.sanitizeFilePart('book_ch_sc_0001:audio')}__${journal.sanitizeFilePart('dispatch-test-1')}.json`);
        const rec = journal.readRecord(file);
        expect.equal(rec.phase, 'generated');

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), true);
    });

    it('partial cleanup keeps the journal for the next recovery', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['ok.png']))[0];
        const blocked = path.join(dir, 'blocked');
        await fsp.mkdir(blocked);
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input, blocked], output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.cleaned, 2); // ok.png + result.mp4
        expect.equal(res.kept, 1);
        expect.equal(await exists(input), false);
        expect.equal(await exists(output), false);
        // journal остался, т.к. blocked не удалился
        expect.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);

        // Следующий recovery: убираем препятствие → cleanup завершается.
        await fsp.rmdir(blocked);
        const res2 = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res2.kept, 0);
        expect.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    });

    it('ENOENT is safe — already-deleted files count as cleaned', async () => {
        const dir = await tmpDir();
        const ghost = path.join(dir, 'gone.png');
        await buildJournal(dir, { inputs: [ghost], output: null });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.cleaned, 1);
        expect.equal(res.failed, undefined);
        expect.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    });

    it('repeated recovery is safe (no journals left → no-op)', async () => {
        const dir = await tmpDir();
        await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.found, 0);
        expect.equal(res.kept, 0);
    });

    it('corrupt journal does not break startup and is kept for diagnostics', async () => {
        const dir = await tmpDir();
        await fsp.writeFile(path.join(dir, 'broken__dispatch-x.json'), '{ not json !!!');
        const goodInput = (await writeFiles(dir, ['good.png']))[0];
        await buildJournal(dir, { jobId: 'good_job:image', dispatchId: 'dispatch-good', inputs: [goodInput], output: null });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.found, 2);
        expect.equal(res.corrupt, 1);
        expect.equal(await exists(path.join(dir, 'broken__dispatch-x.json')), true);
        // хорошая запись обработана
        expect.equal(await exists(goodInput), false);
    });

    it('missing journal means no orphan deletion', async () => {
        const dir = await tmpDir();
        const orphan = (await writeFiles(dir, ['orphan.png']))[0];

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.found, 0);
        expect.equal(await exists(orphan), true);
    });

    it('audio works without any input file', async () => {
        const dir = await tmpDir();
        const output = (await writeFiles(dir, ['tts_00001_.mp3']))[0];
        const opts = { journalDir: dir, jobId: 'b_c_s_0001:audio', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setOutputAndGenerated(opts, output);
        await journal.setDelivered(opts);

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.cleaned, 1);
        expect.equal(await exists(output), false);
    });

    it('video recovery deletes all reference images + one mp4', async () => {
        const dir = await tmpDir();
        const inputs = await writeFiles(dir, ['sc_iu1.png', 'sc_iu2.png', 'sc_iu3.png']);
        const output = (await writeFiles(dir, ['LTX-2_00001_.mp4']))[0];
        await buildJournal(dir, { jobId: 'b_c_s_g1:video', dispatchId: 'd-vid', inputs, output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect.equal(res.cleaned, 4);
        for (const p of inputs) expect.equal(await exists(p), false);
        expect.equal(await exists(output), false);
    });
});

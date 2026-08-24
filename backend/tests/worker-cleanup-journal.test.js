// ======================================================
// Worker cleanup journal tests — crash-safe recovery
// ======================================================
// Тестирует worker-cleanup-journal.cjs (CREATED→GENERATED→DELIVERED→CLEANED)
// и recoverCleanupJournal(): доставленные job дочищаются, недоставленные —
// только input, частичный cleanup держит запись, corruption безопасен.

const { expect } = require('chai');
const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');

const journal = require('../../worker/worker/worker-cleanup-journal.cjs');

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
        expect(rec).to.exist;
        expect(rec.phase).to.equal('created');
        expect(rec.input_files).to.deep.equal([]);
        expect(rec.output_file).to.equal(null);

        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        expect(await exists(file)).to.equal(true);
        // Атомарная запись не оставляет tmp-хвостов.
        const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp.json'));
        expect(leftovers).to.deep.equal([]);
    });

    it('image job: one input path is recorded', async () => {
        const dir = await tmpDir();
        const input = path.join(dir, 'in.png');
        await journal.createJob({ journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog });
        await journal.addInputFile({ journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog }, input);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect(rec.input_files).to.deep.equal([input]);
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
        expect(rec.input_files).to.deep.equal(inputs);
        expect(rec.input_files.length).to.equal(4);
    });

    it('generated stores the output path', async () => {
        const dir = await tmpDir();
        const output = path.join(dir, 'out', 'result.mp4');
        const opts = { journalDir: dir, jobId: 'b_c_s_g1:video', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setOutputAndGenerated(opts, output);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_g1:video')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect(rec.phase).to.equal('generated');
        expect(rec.output_file).to.equal(output);
    });

    it('delivered is set after successful sendResult (transition order)', async () => {
        const dir = await tmpDir();
        const opts = { journalDir: dir, jobId: 'b_c_s_1:image', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setDelivered(opts);
        const file = path.join(dir, `${journal.sanitizeFilePart('b_c_s_1:image')}__${journal.sanitizeFilePart('d1')}.json`);
        const rec = journal.readRecord(file);
        expect(rec.phase).to.equal('delivered');
    });
});

describe('worker-cleanup-journal — recoverCleanupJournal', () => {
    it('delivered recovery deletes input + output and removes the journal', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        const { opts } = await buildJournal(dir, { inputs: [input], output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.found).to.equal(1);
        expect(res.cleaned).to.equal(2);
        expect(res.kept).to.equal(0);
        expect(await exists(input)).to.equal(false);
        expect(await exists(output)).to.equal(false);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).to.deep.equal([]);
    });

    it('created recovery deletes input but keeps output', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input], output, delivered: false });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.cleaned).to.equal(1);
        expect(await exists(input)).to.equal(false);
        expect(await exists(output)).to.equal(true);
        // всё удалилось (input), journal можно убрать
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).to.deep.equal([]);
    });

    it('generated recovery deletes input but keeps output', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['in.png']))[0];
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input], output, delivered: false });

        const file = path.join(dir, `${journal.sanitizeFilePart('book_ch_sc_0001:audio')}__${journal.sanitizeFilePart('dispatch-test-1')}.json`);
        const rec = journal.readRecord(file);
        expect(rec.phase).to.equal('generated');

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(await exists(input)).to.equal(false);
        expect(await exists(output)).to.equal(true);
    });

    it('partial cleanup keeps the journal for the next recovery', async () => {
        const dir = await tmpDir();
        const input = (await writeFiles(dir, ['ok.png']))[0];
        const blocked = path.join(dir, 'blocked');
        await fsp.mkdir(blocked);
        const output = (await writeFiles(dir, ['result.mp4']))[0];
        await buildJournal(dir, { inputs: [input, blocked], output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.cleaned).to.equal(2); // ok.png + result.mp4
        expect(res.kept).to.equal(1);
        expect(await exists(input)).to.equal(false);
        expect(await exists(output)).to.equal(false);
        // journal остался, т.к. blocked не удалился
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length).to.equal(1);

        // Следующий recovery: убираем препятствие → cleanup завершается.
        await fsp.rmdir(blocked);
        const res2 = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res2.kept).to.equal(0);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).to.deep.equal([]);
    });

    it('ENOENT is safe — already-deleted files count as cleaned', async () => {
        const dir = await tmpDir();
        const ghost = path.join(dir, 'gone.png');
        await buildJournal(dir, { inputs: [ghost], output: null });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.cleaned).to.equal(1);
        expect(res.failed).to.equal(undefined);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).to.deep.equal([]);
    });

    it('repeated recovery is safe (no journals left → no-op)', async () => {
        const dir = await tmpDir();
        await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.found).to.equal(0);
        expect(res.kept).to.equal(0);
    });

    it('corrupt journal does not break startup and is kept for diagnostics', async () => {
        const dir = await tmpDir();
        await fsp.writeFile(path.join(dir, 'broken__dispatch-x.json'), '{ not json !!!');
        const goodInput = (await writeFiles(dir, ['good.png']))[0];
        await buildJournal(dir, { jobId: 'good_job:image', dispatchId: 'dispatch-good', inputs: [goodInput], output: null });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.found).to.equal(2);
        expect(res.corrupt).to.equal(1);
        expect(await exists(path.join(dir, 'broken__dispatch-x.json'))).to.equal(true);
        // хорошая запись обработана
        expect(await exists(goodInput)).to.equal(false);
    });

    it('missing journal means no orphan deletion', async () => {
        const dir = await tmpDir();
        const orphan = (await writeFiles(dir, ['orphan.png']))[0];

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.found).to.equal(0);
        expect(await exists(orphan)).to.equal(true);
    });

    it('audio works without any input file', async () => {
        const dir = await tmpDir();
        const output = (await writeFiles(dir, ['tts_00001_.mp3']))[0];
        const opts = { journalDir: dir, jobId: 'b_c_s_0001:audio', dispatchId: 'd1', log: silentLog };
        await journal.createJob(opts);
        await journal.setOutputAndGenerated(opts, output);
        await journal.setDelivered(opts);

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.cleaned).to.equal(1);
        expect(await exists(output)).to.equal(false);
    });

    it('video recovery deletes all reference images + one mp4', async () => {
        const dir = await tmpDir();
        const inputs = await writeFiles(dir, ['sc_iu1.png', 'sc_iu2.png', 'sc_iu3.png']);
        const output = (await writeFiles(dir, ['LTX-2_00001_.mp4']))[0];
        await buildJournal(dir, { jobId: 'b_c_s_g1:video', dispatchId: 'd-vid', inputs, output });

        const res = await journal.recoverCleanupJournal({ journalDir: dir, log: silentLog });
        expect(res.cleaned).to.equal(4);
        for (const p of inputs) expect(await exists(p)).to.equal(false);
        expect(await exists(output)).to.equal(false);
    });
});

// ======================================================
// AI Patch Validation — Bundle Contract Guard Tests
// ======================================================
// Guards the AI mutation pipeline:
//   AI patch → applyPatchesValidated → contract validation → save
//
// Regression coverage for the real incident: the assistant was asked to
// "add Svetlana's voice + instruction" in the Editor and produced a
// structurally broken voices.json (a value of the wrong type — what a
// missing closing brace / truncated tool-call argument degrades into).
// Android's strict parser then failed to load the book while the
// lenient Web frontend opened it with the voice instruction missing.
//
// Contract: a patch that breaks the bundle must be REJECTED —
//   1. no success report (patches_applied: 0),
//   2. previous valid canonical state untouched on disk,
//   3. structured error naming the failing resource,
//   4. a corrected patch applies normally afterwards.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const chatEngine = require('../src/services/chat-engine.cjs')({});
const config = require('../src/config/runtime-config');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('AI Patch Validation — bundle contract guard', () => {
    let tmpDir;
    let bookId;
    let bookDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-patch-validation-'));
        bookId = 'test-patch-validation-' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        config.BOOKS_DIR = tmpDir;

        // Minimal but contract-complete book fixture (voices.json = the
        // resource from the real incident).
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId,
            vbook_version: '3.1',
            state: 'BOOTSTRAPPED',
            created_at: new Date().toISOString(),
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId,
            title: 'Patch Validation Book',
            structure: { chapters_order: [] },
        }, null, 2));

        fs.writeFileSync(path.join(bookDir, 'voices.json'), JSON.stringify({
            narrator: { instruction: 'Deep calm voice' },
        }, null, 2));
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ── The incident, replayed at the engine level ────────────────
    it('rejects a broken voices.json patch (AI tool-call arguments)', () => {
        const bookData = bookModule.loadBook(bookId);
        // What a truncated/brace-broken AI tool-call argument degrades into:
        // the model supplies a raw string instead of a voice object.
        const brokenArgs = JSON.stringify({
            patches: [{
                op: 'replace',
                path: '/voices/narrator',
                value: '{\"instruction\": \"голос Светланы\"' // ← "missing closing brace"
            }]
        });
        const args = JSON.parse(brokenArgs);

        const patchResult = chatEngine.applyPatchesValidated(bookData, args.patches);
        expect(patchResult.result).to.be.null;
        expect(patchResult.errors).to.have.lengthOf(1);
        expect(patchResult.errors[0]).to.include('voices');
        expect(patchResult.validation_errors.join(' ')).to.include('narrator');
    });

    it('rejects the Svetlana add-voice patch and keeps previous voices.json intact', () => {
        const bookData = bookModule.loadBook(bookId);
        const before = fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8');

        const patches = [{ op: 'add', path: '/voices/svetlana', value: 'broken string, not an object' }];
        const patchResult = chatEngine.applyPatchesValidated(bookData, patches);

        expect(patchResult.result).to.be.null;
        expect(patchResult.validation_errors.join(' ')).to.include('svetlana');

        // Canonical state untouched.
        expect(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8')).to.equal(before);
    });

    it('applies a corrected Svetlana voice patch on retry', () => {
        const bookData = bookModule.loadBook(bookId);

        // Turn 1 — broken patch is rejected.
        const broken = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/voices/svetlana', value: 'broken' }
        ]);
        expect(broken.result).to.be.null;

        // Turn 2 — corrected patch (proper object with instruction).
        const fixed = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/voices/svetlana', value: { instruction: 'Мягкий женский голос, тёплый тембр' } }
        ]);
        expect(fixed.errors).to.have.lengthOf(0);
        expect(fixed.result.voices.svetlana.instruction).to.equal('Мягкий женский голос, тёплый тембр');

        // Save succeeds and the value round-trips through the file.
        bookModule.saveBookBundle(fixed.result);
        const onDisk = JSON.parse(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8'));
        expect(onDisk.svetlana.instruction).to.equal('Мягкий женский голос, тёплый тембр');
        expect(onDisk.narrator.instruction).to.equal('Deep calm voice');
    });

    it('rejects a characters patch that replaces the array with a scalar', () => {
        const bookData = bookModule.loadBook(bookId);
        const patchResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'replace', path: '/characters', value: 'oops' }
        ]);
        expect(patchResult.result).to.be.null;
        expect(patchResult.validation_errors.join(' ')).to.include('characters');
    });

    it('accepts valid multi-resource patches (voices + characters + bible)', () => {
        fs.writeFileSync(path.join(bookDir, 'bible.json'), JSON.stringify({ country: 'Russia' }, null, 2));
        const reloaded = bookModule.loadBook(bookId);

        const patchResult = chatEngine.applyPatchesValidated(reloaded, [
            { op: 'add', path: '/voices/svetlana', value: { instruction: 'Спокойный голос' } },
            { op: 'add', path: '/characters/-', value: { id: 'svetlana', name: 'Svetlana' } },
            { op: 'replace', path: '/bible/country', value: 'USSR' },
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        expect(patchResult.result).to.not.be.null;
    });

    it('saveBookBundle refuses to write a bundle with a broken voices resource (defense in depth)', () => {
        const bookData = bookModule.loadBook(bookId);
        const voicesBefore = fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8');
        const manifestBefore = fs.readFileSync(path.join(bookDir, 'manifest.json'), 'utf8');
        bookData.voices = { narrator: 'not-an-object' };

        expect(() => bookModule.saveBookBundle(bookData)).to.throw(/voices\.json/);
        // Not a single file was touched — the throw precedes the first write.
        expect(fs.readFileSync(path.join(bookDir, 'voices.json'), 'utf8')).to.equal(voicesBefore);
        expect(fs.readFileSync(path.join(bookDir, 'manifest.json'), 'utf8')).to.equal(manifestBefore);
    });

    it('validateBundleFile reports resource-level errors with details', () => {
        const { validateBundleFile } = require('../src/book/bundle-validator.cjs');

        const ok = validateBundleFile('voices.json', { narrator: { instruction: 'ok' } });
        expect(ok.valid).to.be.true;

        const bad = validateBundleFile('voices.json', { narrator: { instruction: 42 } });
        expect(bad.valid).to.be.false;
        expect(bad.errors[0]).to.include('narrator');
        expect(bad.errors[0]).to.include('instruction');

        const nonSerializable = validateBundleFile('book.json', { structure: { chapters_order: [] }, bad: undefined });
        expect(nonSerializable.valid).to.be.true; // undefined keys are dropped by stringify — legal
    });

    it('rejects non-JSON-serializable patch values (NaN, circular reference)', () => {
        const bookData = bookModule.loadBook(bookId);
        const circular = { instruction: 'x' };
        circular.self = circular;

        const nanResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'replace', path: '/voices/narrator', value: { instruction: NaN } }
        ]);
        expect(nanResult.result).to.be.null;
        expect(nanResult.validation_errors.join(' ')).to.include('non-serializable');

        const circularResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'replace', path: '/voices/narrator', value: circular }
        ]);
        expect(circularResult.result).to.be.null;
    });

    it('chat route contract: broken patch → rejected:false applied, structured errors surfaced', async () => {
        // Route-level simulation without HTTP: reuse the exact save-block
        // semantics from ai-routes.cjs via applyPatchesValidated + save gate.
        const bookData = bookModule.loadBook(bookId);
        const patches = [{ op: 'add', path: '/voices/svetlana', value: 'broken' }];
        const patchResult = chatEngine.applyPatchesValidated(bookData, patches);

        // Save-block gate: errors ⇒ patches reset ⇒ patches_applied stays 0.
        let applied = patches.length;
        if (patchResult.errors.length > 0) applied = 0;
        expect(applied).to.equal(0);

        // The API payload the assistant receives:
        expect(patchResult.validation_errors.join(' ')).to.include('voices');
        expect(patchResult.errors[0]).to.include('Bundle validation failed');
    });

    it('valid patch → saves and reports success (happy path unchanged)', () => {
        const bookData = bookModule.loadBook(bookId);
        const patchResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/voices/svetlana', value: { instruction: 'Голос Светланы' } }
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        bookModule.saveBookBundle(patchResult.result);

        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded.voices.svetlana.instruction).to.equal('Голос Светланы');
    });
});

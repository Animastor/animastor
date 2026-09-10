// ======================================================
// Assistant Ports (Assistant extraction preparation)
// ======================================================
// The narrow contract the AI Assistant contour (routes/ai-routes.cjs,
// services/chat-engine.cjs, middleware/ai-book-guard.js) may use to reach
// the host. The composition root (backend.cjs) builds it from ready-made
// host services — the Assistant never sees the storage barrel, whole
// VBook services or SQL. This is the seam a future @animastor/assistant
// package will be wired through (host adapters only).
// (docs/architecture/ai-assistant-extraction-preparation.md)
//
//   loadBook(bookId)              — canonical||draft book read (lazy mode)
//   persistBook(bookId, bundle)   — canonical save: full bundle save when
//                                   chapters are intact, targeted file save
//                                   (chapters skipped) on a corrupted load;
//                                   ONE semantics for both callers/routes
//   validateBundle(bundle)        — bundle-contract validation (object form)
//   validateBundleFile(name,data)— per-file validation (targeted save)
//   resolveChatAI(bookId)         — chat provider resolution (Provider
//                                   Gateway seam; fallbackBaseUrl binding)
//   sessionRepo                   — chat-session repository port (see
//                                   storage/postgres/repositories/chat-session-repo)
//   purgeForBook(bookId)          — Assistant-data purge (chat sessions) for
//                                   book deletion / cache teardown
//   log                           — host logger

const path = require('path');
const fs = require('fs');

function createAssistantPorts({ bookModel, book, lazyBook, bundleValidator, providerGateway, chatEngine, sessionRepo, log }) {
    if (!bookModel?.loadBook) throw new Error('assistantPorts: bookModel.loadBook is required');
    if (typeof book?.saveBookBundle !== 'function') throw new Error('assistantPorts: book.saveBookBundle is required');
    if (typeof lazyBook?.getBookDir !== 'function') throw new Error('assistantPorts: lazyBook.getBookDir is required');
    if (typeof bundleValidator?.validateBundleObject !== 'function') throw new Error('assistantPorts: bundleValidator.validateBundleObject is required');
    if (typeof bundleValidator?.validateBundleFile !== 'function') throw new Error('assistantPorts: bundleValidator.validateBundleFile is required');
    if (typeof providerGateway?.chat?.resolveProvider !== 'function') throw new Error('assistantPorts: providerGateway.chat.resolveProvider is required');
    if (!sessionRepo) throw new Error('assistantPorts: sessionRepo is required');
    if (typeof log !== 'function') throw new Error('assistantPorts: log is required');

    // ── Book read ────────────────────────────────────
    // Phase 4 facade: canonical || draft fallback lives INSIDE the loader.
    // The Assistant contour must not choose between loaders itself.
    function loadBook(bookId) {
        return bookModel.loadBook(bookId, { mode: 'lazy' });
    }

    // ── Book write ───────────────────────────────────
    // ONE save semantics for the Assistant:
    //   - chapters intact → full multi-file bundle save (bible → bible.json,
    //     locations → locations.json, …) via saveBookBundle;
    //   - chapters array empty (corrupted load) → targeted save of every
    //     non-chapter file, chapters deliberately skipped so orphaned
    //     chapter files survive; every target file is validated BEFORE the
    //     first write — a failing file aborts the whole save.
    // Both chat routes (non-streaming + stream) call this port — the
    // fallback logic is not duplicated per route any more.
    const BUNDLE_TARGETS = [
        ['manifest.json', 'manifest'],
        ['book.json', 'book'],
        ['bible.json', 'bible'],
        ['locations.json', 'locations'],
        ['voices.json', 'voices'],
        ['characters.json', 'characters'],
    ];

    function persistBook(bookId, bundle) {
        if (bundle.chapters?.length > 0) {
            book.saveBookBundle(bundle);
            return { mode: 'bundle' };
        }
        // Zero-chapter fallback — targeted save (chapters skipped).
        const bookDir = lazyBook.getBookDir(bookId);
        const targets = BUNDLE_TARGETS
            .map(([file, key]) => [file, bundle[key]])
            .filter(([, data]) => data != null);
        // Validate EVERY file BEFORE the first write — a failing file
        // aborts the whole save, previous state stays intact.
        for (const [file, data] of targets) {
            const fileCheck = bundleValidator.validateBundleFile(file, data);
            if (!fileCheck.valid) {
                throw new Error(`Bundle validation failed (${fileCheck.errors.join('; ')})`);
            }
        }
        for (const [file, data] of targets) {
            fs.writeFileSync(path.join(bookDir, file), JSON.stringify(data, null, 2));
        }
        return { mode: 'targeted' };
    }

    // ── Bundle validation ────────────────────────────
    // The port keeps the SAME validator the chat-engine pipeline uses, so
    // applyPatchesValidated and the save gate share one contract.
    function validateBundle(bundle) {
        return bundleValidator.validateBundleObject(bundle);
    }

    function validateBundleFile(name, data) {
        return bundleValidator.validateBundleFile(name, data);
    }

    // ── Chat provider resolution ─────────────────────
    // Provider Gateway seam (Phase 3): the stable consumer entry. The
    // fallback base URL is a chat-engine constant — host knowledge stays
    // at the composition root.
    async function resolveChatAI(bookId) {
        return providerGateway.chat.resolveProvider(bookId, {
            fallbackBaseUrl: chatEngine.AI_API_BASE_URL,
        });
    }

    // ── Assistant-data purge ─────────────────────────
    // The reverse edge (book deletion / cache teardown → Assistant data):
    // purge flows call this port instead of the ai_chat_sessions table.
    async function purgeForBook(bookId) {
        await sessionRepo.purgeSessionsForBook(bookId);
    }

    return {
        loadBook,
        persistBook,
        validateBundle,
        validateBundleFile,
        resolveChatAI,
        sessionRepo,
        purgeForBook,
        log,
    };
}

module.exports = { createAssistantPorts };

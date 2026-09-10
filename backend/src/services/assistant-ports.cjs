// ======================================================
// Assistant Ports — HOST ADAPTER (implementation half)
// ======================================================
// The IMPLEMENTATION half of the AssistantPorts seam. The contracts live
// in the @animastor/assistant package
// (packages/animastor-assistant/src/assistant-ports-contract.cjs); THIS
// module is the host adapter that knows the concrete legs: Book Model,
// saveBookBundle, lazyBook.getBookDir (zero-chapter fallback), the bundle
// validator, the Provider Gateway, the chat-session repository, the
// SSRF-guarded fetch (url-safety), the connector shared-pool and the
// AI-source token mapping. The composition root (backend.cjs) builds it
// and hands it to createAssistantRoutes — the package never sees the
// storage barrel, whole VBook services, SQL or host internals.
// (docs/architecture/ai-assistant-extraction.md)
//
//   loadBook(bookId)              — canonical||draft book read (lazy mode)
//   persistBook(bookId, bundle)   — canonical save: full bundle save when
//                                   chapters are intact, targeted file save
//                                   (chapters skipped) on a corrupted load;
//                                   ONE semantics for both callers/routes
//   validateBundle(bundle)         — bundle-contract validation (object form)
//   validateBundleFile(name,data)— per-file validation (targeted save)
//   resolveChatAI(bookId)         — chat provider resolution (Provider
//                                   Gateway seam; fallbackBaseUrl binding)
//   sessionRepo                   — chat-session repository port (the PG
//                                   implementation stays host-side in
//                                   storage/postgres/repositories/chat-session-repo)
//   purgeForBook(bookId)          — Assistant-data purge (chat sessions) for
//                                   book deletion / cache teardown
//   chatTransport                 — inference transport legs the Assistant
//                                   HTTP contour needs:
//                                     safeFetch(url, opts)          — url-safety
//                                     runSharedInference(...)       — ai-connector/shared-pool
//                                     describeSharedError(code)     — shared-pool
//                                     chatAiSourceToken(ai)         — provider-gateway.chat.sourceToken
//   log                           — host logger

const path = require('path');
const fs = require('fs');

function createAssistantPorts({
    bookModel, book, lazyBook, bundleValidator,
    providerGateway, chatEngine, sessionRepo,
    urlSafety, sharedPool, log,
}) {
    if (!bookModel?.loadBook) throw new Error('assistantPorts: bookModel.loadBook is required');
    if (typeof book?.saveBookBundle !== 'function') throw new Error('assistantPorts: book.saveBookBundle is required');
    if (typeof lazyBook?.getBookDir !== 'function') throw new Error('assistantPorts: lazyBook.getBookDir is required');
    if (typeof bundleValidator?.validateBundleObject !== 'function') throw new Error('assistantPorts: bundleValidator.validateBundleObject is required');
    if (typeof bundleValidator?.validateBundleFile !== 'function') throw new Error('assistantPorts: bundleValidator.validateBundleFile is required');
    if (typeof providerGateway?.chat?.resolveProvider !== 'function') throw new Error('assistantPorts: providerGateway.chat.resolveProvider is required');
    if (!sessionRepo) throw new Error('assistantPorts: sessionRepo is required');
    if (typeof urlSafety?.safeFetch !== 'function') throw new Error('assistantPorts: urlSafety.safeFetch is required (chatTransport)');
    if (typeof sharedPool?.runSharedInference !== 'function') throw new Error('assistantPorts: sharedPool.runSharedInference is required (chatTransport)');
    if (typeof sharedPool?.describeSharedError !== 'function') throw new Error('assistantPorts: sharedPool.describeSharedError is required (chatTransport)');
    if (typeof providerGateway?.chat?.sourceToken !== 'function') throw new Error('assistantPorts: providerGateway.chat.sourceToken is required (chatTransport)');
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

    // ── Inference transport legs (chatTransport) ──────
    // The Assistant HTTP contour (package) reaches the host transports
    // ONLY through this port: the SSRF-guarded fetch for cloud providers,
    // the connector/shared-pool inference path and the sanitized error/
    // source-token surfaces. No url-safety / shared-pool / provider-gateway
    // requires exist inside @animastor/assistant.
    const chatTransport = {
        safeFetch: urlSafety.safeFetch,
        runSharedInference: sharedPool.runSharedInference,
        describeSharedError: sharedPool.describeSharedError,
        chatAiSourceToken: (ai) => providerGateway.chat.sourceToken(ai),
    };

    return {
        loadBook,
        persistBook,
        validateBundle,
        validateBundleFile,
        resolveChatAI,
        sessionRepo,
        purgeForBook,
        chatTransport,
        log,
    };
}

module.exports = { createAssistantPorts };

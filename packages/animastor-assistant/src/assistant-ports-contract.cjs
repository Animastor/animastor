// ======================================================
// ASSISTANT PORTS — CONTRACT (Assistant-owned)
// ======================================================
// The interface half of the AssistantPorts seam: the narrow host contract
// the Assistant contour consumes. The IMPLEMENTATION half (the host
// adapter that knows Book Model, saveBookBundle, lazyBook.getBookDir, the
// bundle validator, the Provider Gateway and the filesystem) stays
// HOST-side in backend/src/services/assistant-ports.cjs and is injected
// here by the composition root.
//
// Contract (every member is required — see assertAssistantPorts):
//   loadBook(bookId)                → canonical||draft book read (lazy mode)
//   persistBook(bookId, bundle)     → ONE save semantics: full bundle save
//                                     when chapters are intact; targeted
//                                     per-file save (chapters skipped) on a
//                                     corrupted zero-chapter load
//   validateBundle(bundle)          → bundle-contract validation (object)
//   validateBundleFile(name, data)  → per-file validation (targeted save)
//   resolveChatAI(bookId)           → chat provider resolution
//   sessionRepo                     → chat-session repository port
//                                     (session-repo-contract.cjs surface)
//   purgeForBook(bookId)            → Assistant-data purge (book deletion /
//                                     cache teardown reverse edge)
//   chatTransport                   → inference transport legs:
//       safeFetch(url, opts)        → SSRF-guarded fetch (cloud providers)
//       runSharedInference(...)     → connector shared inference
//       describeSharedError(code)   → sanitized shared-inference message
//       chatAiSourceToken(ai)      → safe consumer-facing source token
//   log                            → host logger
//
// (docs/architecture/ai-assistant-extraction.md)

'use strict';

const { assertSessionRepo } = require('./session-repo-contract.cjs');

/**
 * Runtime contract check for an AssistantPorts adapter. Throws a named
 * error when a required port is missing — the composition root fails
 * fast instead of the first request. Returns the ports unchanged.
 */
function assertAssistantPorts(ports) {
    const must = (cond, msg) => { if (!cond) throw new Error(`assistantPorts: ${msg}`); };
    must(typeof ports?.loadBook === 'function', 'loadBook is required');
    must(typeof ports?.persistBook === 'function', 'persistBook is required');
    must(typeof ports?.validateBundle === 'function', 'validateBundle is required');
    must(typeof ports?.validateBundleFile === 'function', 'validateBundleFile is required');
    must(typeof ports?.resolveChatAI === 'function', 'resolveChatAI is required');
    must(typeof ports?.purgeForBook === 'function', 'purgeForBook is required');
    must(typeof ports?.log === 'function', 'log is required');
    assertSessionRepo(ports?.sessionRepo, 'assistantPorts.sessionRepo');
    const t = ports?.chatTransport;
    must(typeof t?.safeFetch === 'function', 'chatTransport.safeFetch is required');
    must(typeof t?.runSharedInference === 'function', 'chatTransport.runSharedInference is required');
    must(typeof t?.describeSharedError === 'function', 'chatTransport.describeSharedError is required');
    must(typeof t?.chatAiSourceToken === 'function', 'chatTransport.chatAiSourceToken is required');
    return ports;
}

module.exports = { assertAssistantPorts };

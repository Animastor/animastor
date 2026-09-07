// ======================================================
// VBOOK PACKAGE BOUNDARY — booksRoot port
// ======================================================
// The book domain (future @animastor/vbook-runtime) must not import host
// config (`config/runtime-config`) nor read `process.env` — the host owns
// the filesystem root location, the package owns the layout under it.
//
// The composition root (backend.cjs in production, tests/vbook-test-bindings.cjs
// in tests) binds the root exactly once, before any book operation:
//
//   configureBooksRoot(config.BOOKS_DIR)              // static root
//   configureBooksRoot(() => config.BOOKS_DIR)        // live provider
//
// The provider form keeps today's read-per-call semantics (tests that
// re-point config.BOOKS_DIR at a temp dir keep working unchanged); the
// static form is the canonical standalone-package API.
//
// Fail-closed: with no binding, every path getter throws instead of
// guessing a root. No env fallback lives here — env resolution is host
// business. Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md §3.3.

'use strict';

let booksRootProvider = null;

function configureBooksRoot(provider) {
    if (typeof provider === 'string') {
        if (!provider.trim()) {
            throw new Error('vbook: booksRoot must be a non-empty string');
        }
        const root = provider;
        booksRootProvider = () => root;
        return;
    }
    if (typeof provider === 'function') {
        booksRootProvider = provider;
        return;
    }
    throw new Error('vbook: configureBooksRoot expects a non-empty string or a () => string provider');
}

function getBooksRoot() {
    if (typeof booksRootProvider !== 'function') {
        throw new Error('vbook: booksRoot is not configured — call configureBooksRoot() at the composition root before any book operation');
    }
    const root = booksRootProvider();
    if (typeof root !== 'string' || !root.trim()) {
        throw new Error('vbook: booksRoot provider resolved to an invalid root (non-string or empty)');
    }
    return root;
}

function isBooksRootConfigured() {
    return typeof booksRootProvider === 'function';
}

// Factory for isolated (guard/unit) tests: a fresh port instance with its
// own binding state, so global singleton state never leaks across tests.
function createBooksRootPort() {
    let provider = null;
    return {
        configure(p) {
            if (typeof p === 'string') {
                if (!p.trim()) throw new Error('vbook: booksRoot must be a non-empty string');
                const root = p;
                provider = () => root;
                return;
            }
            if (typeof p === 'function') { provider = p; return; }
            throw new Error('vbook: configureBooksRoot expects a non-empty string or a () => string provider');
        },
        get() {
            if (typeof provider !== 'function') {
                throw new Error('vbook: booksRoot is not configured — call configureBooksRoot() at the composition root before any book operation');
            }
            const root = provider();
            if (typeof root !== 'string' || !root.trim()) {
                throw new Error('vbook: booksRoot provider resolved to an invalid root (non-string or empty)');
            }
            return root;
        },
        isConfigured() { return typeof provider === 'function'; },
    };
}

module.exports = { configureBooksRoot, getBooksRoot, isBooksRootConfigured, createBooksRootPort };

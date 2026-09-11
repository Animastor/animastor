// ======================================================
// ASSISTANT CONTOUR GUARD (Assistant extraction)
// ======================================================
// Proves the architectural boundary of the AI Assistant contour AFTER the
// physical @animastor/assistant extraction (the contour moved to
// packages/animastor-assistant; the host keeps the ai-book-guard
// middleware, the AssistantPorts adapter and the PG session repo):
//
//   A1  Assistant files hold no SQL / no postgres / no storage barrel —
//       session persistence goes through the chat-session repository port.
//   A2  ai_chat_sessions SQL lives ONLY in the repository (+ schema
//       migrations); purge flows and routes must not name the table.
//   A3  Assistant routes get host dependencies ONLY through the narrow
//       AssistantPorts seam (no wide routeDeps spread, no whole
//       Book/VBook service objects) — registered through the package.
//   A4  Book/VBook access inside the Assistant contour goes through ports
//       (loadBook/persistBook) — no direct bookModel/book/lazyBook/
//       bundle-validator requires in the route; transport legs
//       (fetch/shared-pool/gateway) arrive through chatTransport.
//   A5  purge flows (book-deletion, cache-routes) purge Assistant data via
//       the purgeAssistantForBook port — no ai_chat_sessions table name.
//   A6  the chat transport contract (SSE meta/delta/done/error, tools,
//       AbortController, shared-pool connector path) stays intact — the
//       extraction moved wiring, not the wire protocol.
//   A7  the chat engine's bundle-contract validator is injected (the
//       package holds NO direct book-domain require) and the composition
//       root binds it (shared validator with the save gate).
//
// Docs: docs/architecture/ai-assistant-extraction.md

const { expect } = require('chai');
const path = require('path');
const { listSourceFiles, readSource, rel, REPO_ROOT, BACKEND_SRC } = require('./helpers');

const ASSISTANT_PKG_SRC = path.join(REPO_ROOT, 'packages', 'animastor-assistant', 'src');
const ASSISTANT_ROUTE = path.join(ASSISTANT_PKG_SRC, 'assistant-routes.cjs');
const CHAT_ENGINE = path.join(ASSISTANT_PKG_SRC, 'chat-engine.cjs');
const AI_BOOK_GUARD = path.join(BACKEND_SRC, 'middleware', 'ai-book-guard.js');
const ASSISTANT_PORTS = path.join(BACKEND_SRC, 'services', 'assistant-ports.cjs');
const CHAT_SESSION_REPO = path.join(BACKEND_SRC, 'storage', 'postgres', 'repositories', 'chat-session-repo.js');
const BOOK_DELETION = path.join(BACKEND_SRC, 'services', 'book-deletion.cjs');
const CACHE_ROUTES = path.join(BACKEND_SRC, 'routes', 'book', 'cache-routes.cjs');
const BOOK_ROUTES = path.join(BACKEND_SRC, 'routes', 'book-routes.cjs');
const COMPOSITION_ROOT = path.join(BACKEND_SRC, 'backend.cjs');

const ASSISTANT_CONTOUR_FILES = [ASSISTANT_ROUTE, CHAT_ENGINE, AI_BOOK_GUARD, ASSISTANT_PORTS];

// ── A1 — no SQL / postgres / storage barrel in the Assistant contour ────
describe('architecture: assistant contour (physical extraction)', () => {
    it('A1: Assistant files hold no SQL, no postgres handle, no storage barrel', () => {
        for (const file of ASSISTANT_CONTOUR_FILES) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not require the raw postgres handle`)
                .to.not.match(/require\(\s*['"][^'"]*storage\/postgres\/database['"]\s*\)/);
            expect(src, `${rel(file)} must not require the storage barrel`)
                .to.not.match(/require\(\s*['"][^'"]*\/storage['"]\s*\)|require\(\s*['"][^'"]*\/storage\/index['"]\s*\)/);
            expect(src, `${rel(file)} must not touch storage.postgres`)
                .to.not.include('storage.postgres');
            expect(src, `${rel(file)} must not contain SQL statements`)
                .to.not.match(/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\bFROM\b|\bINSERT INTO\b|\bUPDATE\b\s+\w+\s+\bSET\b/i);
        }
    });

    it('A1c: the WHOLE @animastor/assistant package holds no SQL, no postgres, no ai_chat_sessions, no fs at all', () => {
        // The package is physically extracted: every src file (routes,
        // engine, contracts, entrypoint) must stay clean of host-infrastructure
        // knowledge. The persona CONTENT is injected — the package has NO
        // filesystem knowledge whatsoever (no fs require, no fs call).
        for (const file of listSourceFiles(ASSISTANT_PKG_SRC)) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not name the ai_chat_sessions table`).to.not.include('ai_chat_sessions');
            expect(src, `${rel(file)} must not require postgres/storage`).to.not.match(/require\(\s*['"][^'"]*(postgres|storage)['"]/);
            expect(src, `${rel(file)} must not contain SQL`).to.not.match(/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\bFROM\b|\bINSERT INTO\b|\bUPDATE\b\s+\w+\s+\bSET\b/i);
            expect(src, `${rel(file)} must not require fs`).to.not.match(/require\(\s*['"](node:)?fs['"]\s*\)/);
            expect(src, `${rel(file)} must not use any fs API`).to.not.match(/\bfs\.(readFile|writeFile|existsSync|readdir|stat|unlink|mkdir)/);
            expect(src, `${rel(file)} must not read process.env (injected config only)`).to.not.include('process.env');
        }
    });

    it('A1b: the ai-book-guard resolves sessions through the repository port, not SQL', () => {
        const guard = readSource(AI_BOOK_GUARD);
        expect(guard).to.include('chat-session-repo');
        expect(guard).to.include('getBookIdForSession');
        expect(guard).to.not.include('SELECT');
        // The repo is swappable (composition root / tests) via the seam.
        expect(guard).to.include('configureAiBookGuard');
    });

    it('A2: ai_chat_sessions SQL lives ONLY in the chat-session repository', () => {
        const allowed = new Set([
            rel(CHAT_SESSION_REPO),
            'backend/src/storage/postgres/schema.js', // migrations/DDL owner
        ]);
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const src = readSource(file);
            const hasSql = /ai_chat_sessions/.test(stripLiterate(src));
            if (hasSql && !allowed.has(rel(file))) offenders.push(rel(file));
        }
        expect(offenders, 'ai_chat_sessions must be named only in chat-session-repo (SQL) — comments allowed elsewhere only if no SQL rides along').to.deep.equal([]);
        // The repository itself owns the table SQL.
        const repo = readSource(CHAT_SESSION_REPO);
        expect(repo).to.include('FROM ai_chat_sessions');
        expect(repo).to.include('purgeSessionsForBook');
    });

    it('A3: Assistant routes are wired ONLY with the narrow seam (no wide deps spread)', () => {
        const root = readSource(COMPOSITION_ROOT);
        // The registration must not spread the wide routeDeps into the route.
        // (Physical extraction: registration goes through the package API.)
        const regMatch = root.match(/createAssistantRoutes\(app, redis, \{([\s\S]*?)\}\);/);
        expect(regMatch, 'createAssistantRoutes registration block must exist in the composition root').to.not.equal(null);
        const regBody = regMatch[1];
        expect(regBody, 'the Assistant route must receive chatEngine through the seam wiring').to.include('chatEngine');
        expect(regBody).to.include('assistantPorts');
        expect(regBody, 'no storage barrel may ride into the Assistant route').to.not.include('storage');
        expect(regBody, 'no ...routeDeps spread into the Assistant route').to.not.include('...routeDeps');
        expect(regBody, 'no whole book service into the Assistant route').to.not.include('book:');
        // The route itself destructures only the narrow set.
        const route = readSource(ASSISTANT_ROUTE);
        const destructure = route.match(/module\.exports = function\(app, redis, deps\) \{\s*const \{([\s\S]*?)\} = deps;/);
        expect(destructure, 'the route deps destructure must be found').to.not.equal(null);
        const names = destructure[1].split(/[,\s]+/).filter(Boolean);
        expect(names).to.deep.equal(['chatEngine', 'assistantPorts', 'utils']);
    });

    it('A3b: AssistantPorts surface is narrow and complete', () => {
        const ports = readSource(ASSISTANT_PORTS);
        expect(ports).to.include('function createAssistantPorts(');
        for (const port of ['loadBook', 'persistBook', 'validateBundle', 'resolveChatAI', 'purgeForBook', 'sessionRepo', 'chatTransport']) {
            expect(ports, `AssistantPorts must expose the ${port} port`).to.include(port);
        }
        // One persistBook semantics for bundle + zero-chapter fallback.
        expect(ports).to.include('saveBookBundle');
        expect(ports).to.match(/chapters\?\.length > 0/);
        expect(ports).to.include('validateBundleFile');
        // The transport legs are bound host-side (no package-side requires).
        expect(ports).to.include('safeFetch: urlSafety.safeFetch');
        expect(ports).to.include('runSharedInference: sharedPool.runSharedInference');
    });

    it('A4: Book/VBook access goes through ports, not direct service objects', () => {
        const route = readSource(ASSISTANT_ROUTE);
        // Book reads/writes ride the ports seam.
        expect(route).to.match(/\bloadBook\(bookId\)/);
        expect(route).to.match(/\bpersistBook\(bookId,/);
        // No direct host book legs inside the route.
        expect(route, 'no direct bookModel in the route').to.not.include('bookModel.');
        expect(route, 'no direct book.saveBookBundle in the route').to.not.include('book.saveBookBundle');
        expect(route, 'no direct lazyBook in the route').to.not.include('lazyBook.');
        expect(route, 'no direct bundle-validator require in the route').to.not.include("bundle-validator");
        expect(route, 'no direct book dir / filesystem fallback in the route').to.not.include('getBookDir');
        expect(route, 'no writeFileSync in the route').to.not.include('writeFileSync');
        // Provider resolution + transport legs are injected through the ports.
        expect(route).to.not.include('providerGateway.chat.resolveProvider');
        expect(route, 'no url-safety require in the route').to.not.include('url-safety');
        expect(route, 'no shared-pool require in the route').to.not.include('shared-pool');
        expect(route, 'no provider-gateway require in the route').to.not.include('provider-gateway');
        // The whole contour holds zero require() calls at all (ports only).
        expect(route, 'the package route must hold no require() calls').to.not.match(/\brequire\s*\(/);
    });

    it('A5: purge flows reach Assistant data via the port, not the table name', () => {
        const del = readSource(BOOK_DELETION);
        expect(del).to.include('purgeAssistantForBook');
        const delCode = stripLiterate(del);
        expect(delCode, 'book-deletion must not name the Assistant table').to.not.include('ai_chat_sessions');
        expect(delCode, 'book-deletion must not keep the table in its purge list').to.not.match(/'ai_chat_sessions'/);

        const cache = readSource(CACHE_ROUTES);
        expect(cache).to.include('purgeAssistantForBook');
        const cacheCode = stripLiterate(cache);
        expect(cacheCode, 'cache-routes must not name the Assistant table').to.not.include('ai_chat_sessions');

        // The wiring exists: composition root + book-routes pass the port.
        const root = readSource(COMPOSITION_ROOT);
        expect(root).to.include('purgeAssistantForBook');
        const bookRoutes = readSource(BOOK_ROUTES);
        expect(bookRoutes).to.include('purgeAssistantForBook');
    });

    it('A6: the chat transport contract stays intact (SSE meta/delta/done/error)', () => {
        const route = readSource(ASSISTANT_ROUTE);
        // SSE frames
        expect(route).to.include("'text/event-stream; charset=utf-8'");
        expect(route).to.include('writeEvent');
        for (const frame of ["'meta'", "'delta'", "'done'", "'error'"]) {
            expect(route, `the ${frame} SSE frame must be kept`).to.include(frame);
        }
        expect(route).to.include('terminalSent');
        // Tools + connector path
        expect(route).to.include('getToolsForMode');
        expect(route).to.include('extractToolCallsFromContent');
        expect(route).to.include('sharedPool.runSharedInference');
        expect(route).to.include("ai.transport === 'connector'");
        // Abort lifecycle
        expect(route).to.include('new AbortController()');
        expect(route).to.include("res.on('close', onConnClosed)");
    });

    it('A7: chat-engine bundle validation + persona content are injected (composition-root bound, NO host require)', () => {
        const engine = readSource(CHAT_ENGINE);
        expect(engine).to.match(/module\.exports = function\(config, deps = \{\}\)/);
        // The package engine requires the validator via injection ONLY —
        // the historical ../book/bundle-validator.cjs fallback is gone
        // with the physical move (the package has no host imports).
        expect(engine).to.include('deps.validateBundleObject is required');
        expect(engine, 'the package engine must not require host book files').to.not.include("require('../book/bundle-validator.cjs')");
        expect(engine, 'the package engine must not require anything host-side').to.not.match(/require\(\s*['"][^'"]*book/);
        // The persona arrives as injected CONTENT — no fs, no path.
        expect(engine, 'the package engine must have no fs').to.not.match(/require\(\s*['"](node:)?fs['"]/);
        expect(engine).to.include('deps.aiProfile');
        // The composition root binds the shared validator + persona content.
        const root = readSource(COMPOSITION_ROOT);
        expect(root).to.match(/createChatEngine\(config, \{\s*validateBundleObject:/);
        expect(root).to.include('aiProfile');
        expect(root, 'the host reads the persona through its loader').to.include('loadAssistantProfile');
    });
});

// Strip line/block comments so guards scan CODE, not prose (file headers
// legitimately mention ai_chat_sessions while explaining the boundary).
function stripLiterate(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

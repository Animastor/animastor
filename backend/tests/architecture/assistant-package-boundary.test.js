// ======================================================
// ASSISTANT PACKAGE BOUNDARY — @animastor/assistant guards
// (physical extraction)
// ======================================================
// The Assistant is physically extracted to packages/animastor-assistant
// (@animastor/assistant). This suite freezes the package boundary the
// extraction created:
//
//   PB1 — Deep-import guard: no host source file (backend/src/**) contains
//         a deep import of the package ("@animastor/assistant/...", a path
//         into packages/animastor-assistant/src, or a relative path reaching
//         the package directory). The package root require is the ONLY
//         sanctioned specifier.
//   PB2 — Export map freeze: package.json exports == { ".": "./src/index.cjs" }
//         (root-only, closed map); the manifest is publish-complete; the
//         package declares ZERO runtime dependencies (the Assistant owns
//         pure logic + contracts only — every host leg is injected).
//   PB3 — Public API surface: require('@animastor/assistant') resolves and
//         exposes EXACTLY the four public factories — createChatEngine,
//         createAssistantRoutes, assertAssistantPorts, assertSessionRepo —
//         nothing more.
//   PB4 — No reverse imports / package closure: no package source file
//         requires the backend host (backend/src/**), the PostgreSQL
//         storage layer, the Book domain (backend/src/book/**, @animastor/
//         vbook-runtime), lazyBook, the provider gateway, the ai-connector
//         shared pool, url-safety, config, Redis or ANY other @animastor
//         package. The require closure of the package reaches only
//         intra-package files and node builtins. No require cycles.
//   PB5 — Host-adapter side: the PG chat-session repository, the Assistant
//         ports adapter (book/lazyBook/bundle-validator/provider-gateway/
//         shared-pool/url-safety legs) and the ai-book-guard middleware
//         stay HOST-side; the ai_chat_sessions SQL stays ONLY in the host
//         repository (+ schema migrations).
//   PB6 — Dependency direction: host → adapters/ports → package. No package
//         file may require ../backend or any backend path; the composition
//         root is the ONLY host module requiring @animastor/assistant.
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).
// Docs: docs/architecture/ai-assistant-extraction.md

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { builtinModules } = require('module');
const {
    REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers,
} = require('./helpers');

const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'animastor-assistant');
const PACKAGE_SRC = path.join(PACKAGE_DIR, 'src');
const PACKAGE_ENTRY = path.join(PACKAGE_SRC, 'index.cjs');

/** Strip comments so doc mentions are not edges (same shape as E-guards). */
function codeOf(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

// ── PB1 — deep-import guard (host → package root ONLY) ───────────────────
describe('PB1: the host never deep-imports the assistant package', () => {
    const DEEP_ASSISTANT_RE = /require\(\s*['"]@animastor\/assistant\/[^'"]*['"]\s*\)/;
    const SRC_PATH_RE = /require\(\s*['"][^'"]*packages\/animastor-assistant\/src\/[^'"]*['"]\s*\)/;
    const REL_ESCAPE_RE = /require\(\s*['"]\.\.[^'"]*animastor-assistant[^'"]*['"]\s*\)/;

    it('no backend/src file deep-imports @animastor/assistant (package root only)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const code = codeOf(readSource(file));
            if (DEEP_ASSISTANT_RE.test(code) || SRC_PATH_RE.test(code) || REL_ESCAPE_RE.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'host must consume @animastor/assistant through the package root only')
            .to.deep.equal([]);
    });

    it('no host file reaches the package src/ by a relative path either', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const code = codeOf(readSource(file));
            if (/require\(\s*['"][^'"]*animastor-assistant[^'"]*['"]\s*\)/.test(code)) {
                offenders.push(rel(file));
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── PB2 — export map + manifest freeze ───────────────────────────────────
describe('PB2: the package manifest is publish-ready and boundary-closed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

    it('the export map is exactly the package root', () => {
        expect(pkg.exports).to.deep.equal({ '.': './src/index.cjs' });
    });

    it('the manifest is publish-complete', () => {
        expect(pkg.name).to.equal('@animastor/assistant');
        expect(pkg.version).to.match(/^\d+\.\d+\.\d+$/);
        expect(pkg.description).to.be.a('string').with.length.above(10);
        expect(Array.isArray(pkg.keywords) && pkg.keywords.length > 0).to.equal(true);
        expect(pkg.license).to.equal('MIT');
        expect(pkg.repository && pkg.repository.url).to.include('animastor');
        expect(pkg.homepage).to.be.a('string');
        expect(pkg.bugs && pkg.bugs.url).to.be.a('string');
        expect(pkg.engines && pkg.engines.node).to.be.a('string');
        expect(pkg.main).to.equal('src/index.cjs');
        expect(pkg.files).to.deep.equal(['src/', 'README.md', 'LICENSE']);
        expect(pkg.scripts && pkg.scripts.test).to.match(/mocha/);
    });

    it('the package declares ZERO runtime dependencies (every host leg is injected)', () => {
        expect(Object.keys(pkg.dependencies || {})).to.deep.equal([]);
    });
});

// ── PB3 — public API surface (root entrypoint) ───────────────────────────
describe('PB3: the package root exposes exactly the public API', () => {
    const api = require(PACKAGE_ENTRY);
    const PUBLIC_API = [
        'assertAssistantPorts',
        'assertSessionRepo',
        'createAssistantRoutes',
        'createChatEngine',
    ].sort();

    it('exports exactly the four public factories (nothing more)', () => {
        expect(Object.keys(api).sort()).to.deep.equal(PUBLIC_API);
    });

    it('every export is a function', () => {
        for (const key of PUBLIC_API) {
            expect(api[key], `${key} must be a function`).to.be.a('function');
        }
    });
});

// ── PB4 — package closure (no reverse imports, no cycles) ────────────────
describe('PB4: the package require closure stays self-contained', () => {
    function walk(startFiles) {
        const edges = [];
        const visited = new Set();
        const queue = [...startFiles];
        while (queue.length > 0) {
            const file = queue.shift();
            const key = path.resolve(file);
            if (visited.has(key)) continue;
            visited.add(key);
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (!spec.startsWith('.')) {
                    edges.push(`${rel(file)}: ${spec} (undeclared external)`);
                    continue;
                }
                const base = path.resolve(path.dirname(file), spec);
                const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
                const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (!resolved) { edges.push(`${rel(file)}: ${spec} (unresolved)`); continue; }
                if (resolved.startsWith(PACKAGE_DIR + path.sep)) { queue.push(resolved); continue; }
                edges.push(`${rel(file)} → ${rel(resolved)} (host module)`);
            }
        }
        return edges;
    }

    it('the whole package (entrypoint included) reaches only intra-package files + node builtins', () => {
        const edges = walk([PACKAGE_ENTRY]);
        expect(edges, 'assistant package closure must stay self-contained (assistantPorts is the only host seam, injected at registration)')
            .to.deep.equal([]);
    });

    it('the package require graph has no cycles', () => {
        const graph = new Map();
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            const specs = [];
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (!spec.startsWith('.')) continue;
                const base = path.resolve(path.dirname(file), spec);
                const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
                const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (resolved && resolved.startsWith(PACKAGE_DIR + path.sep)) specs.push(resolved);
            }
            graph.set(path.resolve(file), specs);
        }
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        let cyclic = false;
        const visit = (node) => {
            if (cyclic) return;
            color.set(node, GRAY);
            for (const next of graph.get(node) || []) {
                const c = color.get(next) || WHITE;
                if (c === GRAY) { cyclic = true; return; }
                if (c === WHITE) visit(next);
            }
            color.set(node, BLACK);
        };
        for (const node of graph.keys()) {
            if ((color.get(node) || WHITE) === WHITE) visit(node);
            if (cyclic) break;
        }
        expect(cyclic, 'assistant package must not gain require cycles').to.equal(false);
    });

    it('no package file requires the backend host or any other @animastor package', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (/backend|@animastor\//.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('no package file references the PostgreSQL/Book/gateway/shared-pool internals by import path', () => {
        const offenders = [];
        for (const file of listSourceFiles(PACKAGE_SRC)) {
            const code = codeOf(readSource(file));
            for (const forbidden of ['storage/postgres', 'services/provider-gateway', 'ai-connector/shared-pool', 'services/url-safety', 'book/lazy-book', 'bundle-validator']) {
                if (code.includes(forbidden)) offenders.push(`${rel(file)}: ${forbidden}`);
            }
        }
        expect(offenders, 'the package must reach these only through the injected ports').to.deep.equal([]);
    });
});

// ── PB5 — host-side adapters stay host-side ───────────────────────────────
describe('PB5: the host keeps the PG implementation, the adapters and the guard', () => {
    const CHAT_SESSION_REPO = path.join(BACKEND_SRC, 'storage', 'postgres', 'repositories', 'chat-session-repo.js');
    const ASSISTANT_PORTS = path.join(BACKEND_SRC, 'services', 'assistant-ports.cjs');
    const AI_BOOK_GUARD = path.join(BACKEND_SRC, 'middleware', 'ai-book-guard.js');

    it('the PG chat-session repository stays host-side and owns the table SQL', () => {
        const repo = readSource(CHAT_SESSION_REPO);
        expect(repo).to.include('FROM ai_chat_sessions');
        expect(repo).to.include('purgeSessionsForBook');
        // The repository implements the package contract (surface parity).
        const contract = readSource(path.join(PACKAGE_SRC, 'session-repo-contract.cjs'));
        for (const m of ['listSessionsForBook', 'getSession', 'getMessages', 'createSession', 'setMessages', 'renameSession', 'deleteSession', 'getBookIdForSession', 'purgeSessionsForBook']) {
            expect(repo, `the host repo must implement the ${m} contract method`).to.include(`function ${m}`);
            expect(contract, `the package contract must pin the ${m} method`).to.include(`'${m}'`);
        }
    });

    it('the AssistantPorts adapter stays host-side and binds the concrete host legs', () => {
        const ports = readSource(ASSISTANT_PORTS);
        expect(ports).to.include('function createAssistantPorts(');
        // The adapter — and ONLY the adapter — may know these host legs.
        for (const leg of ['bookModel', 'saveBookBundle', 'lazyBook', 'bundleValidator', 'providerGateway', 'sessionRepo', 'sharedPool', 'urlSafety']) {
            expect(ports, `the host adapter must bind the ${leg} leg`).to.include(leg);
        }
        // The transport port re-shapes the legs for the package.
        expect(ports).to.include('chatTransport');
        expect(ports).to.include('safeFetch: urlSafety.safeFetch');
        expect(ports).to.include('runSharedInference: sharedPool.runSharedInference');
    });

    it('the ai-book-guard middleware stays host-side and reaches the session through the seam', () => {
        const guard = readSource(AI_BOOK_GUARD);
        expect(guard).to.include('configureAiBookGuard');
        expect(guard).to.include('getBookIdForSession');
        expect(guard).to.not.include('SELECT');
    });
});

// ── PB6 — dependency direction (host → adapters/ports → package) ─────────
describe('PB6: dependency direction — the composition root is the only host consumer', () => {
    it('backend.cjs is the only backend/src file requiring @animastor/assistant', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const code = codeOf(readSource(file));
            if (/require\(\s*['"]@animastor\/assistant['"]\s*\)/.test(code) && rel(file) !== 'backend/src/backend.cjs') {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'only the composition root may require the package root (tests use their own fixtures)').to.deep.equal([]);
    });

    it('the wiring direction is host adapters → package (createAssistantRoutes registered in backend.cjs)', () => {
        const root = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(root).to.include("require('@animastor/assistant')");
        expect(root).to.match(/createAssistantRoutes\(app, redis, \{/);
        expect(root).to.match(/createChatEngine\(config, \{/);
        // The package exports are destructured from the root require only.
        const m = root.match(/const \{ ([^}]+) \} = require\('@animastor\/assistant'\);/);
        expect(m).to.not.equal(null);
        const names = m[1].split(/[,\s]+/).filter(Boolean);
        expect(names.every((n) => ['createChatEngine', 'createAssistantRoutes', 'assertAssistantPorts', 'assertSessionRepo'].includes(n))).to.equal(true);
    });
});

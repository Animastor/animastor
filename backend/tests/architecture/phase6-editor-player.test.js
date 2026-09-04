// ======================================================
// PHASE 6 — Editor / Player architectural boundaries
// ======================================================
// Guards the Player/Editor boundaries added on top of the Canonical Book
// Model (Phase 4). Docs: docs/architecture/PHASE_6_EDITOR_PLAYER.md
//
//   T1 — Player facade exists and depends only on the Book Model layer
//   T2 — Editor facade exists and depends only on the Book Model layer
//   T3 — player/editor layers never import orchestration, runtime, Redis,
//        PG/storage, provider or service internals (structural, whole-dir scan)
//   T4 — both facades are wired at the composition root and reach the routes
//   T5 — Editor contour routes load/save through editorModel (no direct
//        book.loadBook / book.saveBookBundle); Player contour media routes
//        read through playerModel, with the import/generation leg pinned
//   T6 — contour routes do not gain NEW deps on orchestration/runtime/PG
//        internals (frozen baseline of existing legacy edges)
//   T7 — frontend Player/Editor consumers build API URLs through the
//        api/client seam (no hardcoded '/api/v1/...' literals)
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { readSource, rel, REPO_ROOT, BACKEND_SRC, listSourceFiles, requireSpecifiers } = require('./helpers');

const PLAYER_DIR = path.join(BACKEND_SRC, 'player');
const EDITOR_DIR = path.join(BACKEND_SRC, 'editor');
const PLAYER_FACADE = path.join(PLAYER_DIR, 'index.cjs');
const EDITOR_FACADE = path.join(EDITOR_DIR, 'index.cjs');
const BACKEND_ROOT = path.join(BACKEND_SRC, 'backend.cjs');
const FRONTEND_APP_DIR = path.join(REPO_ROOT, 'frontends', 'app', 'src');

// Layers below the Player/Editor boundary — the ONLY backend code they may
// reach is the Canonical Book Model layer (backend/src/book/**) plus node
// builtins. Everything else is an implementation-detail leak.
const FORBIDDEN_SPEC = /orchestration|runtime|redis|ioredis|storage\/postgres|storage\/|provider-gateway|ai-service|ai-loader|generation|services\/|routes\/|middleware\/|workflows|video\/|audio\/|image\//i;
const BOOK_LAYER_ALLOWED = /^(\.\.?\/)+(book)\//;

function assertBoundaryClean(dir) {
    const offenders = [];
    for (const file of listSourceFiles(dir)) {
        for (const spec of requireSpecifiers(readSource(file))) {
            if (!spec.startsWith('.')) continue; // node builtins only otherwise
            const violates = FORBIDDEN_SPEC.test(spec) && !BOOK_LAYER_ALLOWED.test(spec);
            if (violates) offenders.push(`${rel(file)}: ${spec}`);
        }
    }
    return offenders;
}

// ── T1 — Player facade ───────────────────────────────────────────────────
describe('T1: Player facade contract', () => {
    it('exists with a createPlayerModel factory over the Book Model', () => {
        const { createPlayerModel } = require(PLAYER_FACADE);
        expect(createPlayerModel).to.be.a('function');

        const fake = {
            loadBook: (id) => ({ id }),
            getBookIdentity: (id) => ({ bookId: id }),
            getBookManifest: (id) => ({ book_id: id }),
        };
        const pm = createPlayerModel({ bookModel: fake });
        expect(pm.loadBook('b1').id).to.equal('b1');
        expect(pm.getBookIdentity('b1').bookId).to.equal('b1');
        expect(pm.getBookManifest('b1').book_id).to.equal('b1');
    });

    it('delegates reads to the injected Canonical Book Model (never a raw loader)', () => {
        const src = readSource(PLAYER_FACADE);
        expect(src).to.include("require('../book/book-model.cjs')");
        expect(src).to.not.match(/require\(['"]\.\.\/book['"]\)/); // no raw book/index.js loader
        expect(src).to.not.match(/require\(['"]\.\.\/(services|storage|runtime|orchestration|routes)/);
        // The boundary must be documented in the source itself.
        expect(src).to.match(/Canonical Book Model/);
    });
});

// ── T2 — Editor facade ───────────────────────────────────────────────────
describe('T2: Editor facade contract (read / modify / commit)', () => {
    it('exists with a createEditorModel factory exposing read + commit', () => {
        const { createEditorModel } = require(EDITOR_FACADE);
        expect(createEditorModel).to.be.a('function');

        const loaded = [];
        const committed = [];
        const fake = { loadBook: (id) => { loaded.push(id); return { book_id: id }; } };
        const em = createEditorModel({
            bookModel: fake,
            persistBook: (b, files) => { committed.push([b.book_id, files]); return b; },
        });
        const book = em.read('b1');
        expect(loaded).to.deep.equal(['b1']);
        em.commit(book, null);
        expect(committed).to.deep.equal([['b1', null]]);
    });

    it('rejects construction without the canonical bundle writer', () => {
        const { createEditorModel } = require(EDITOR_FACADE);
        expect(() => createEditorModel({})).to.throw(/persistBook/);
    });

    it('delegates to the Book Model + injected writer (never raw backend internals)', () => {
        const src = readSource(EDITOR_FACADE);
        expect(src).to.include("require('../book/book-model.cjs')");
        expect(src).to.not.match(/require\(['"]\.\.\/book['"]\)/); // writer is injected, not required
        expect(src).to.not.match(/require\(['"]\.\.\/(services|storage|runtime|orchestration|routes)/);
        expect(src).to.match(/MODIFY/); // the three edit phases must be explicit
        expect(src).to.match(/COMMIT/);
    });
});

// ── T3 — structural forbidden-deps scan (whole player/ and editor/ dirs) ─
describe('T3: player/editor layers import nothing outside the Book Model layer', () => {
    it('backend/src/player/** has no implementation-detail requires', () => {
        expect(assertBoundaryClean(PLAYER_DIR), 'player layer boundary violation').to.deep.equal([]);
    });

    it('backend/src/editor/** has no implementation-detail requires', () => {
        expect(assertBoundaryClean(EDITOR_DIR), 'editor layer boundary violation').to.deep.equal([]);
    });
});

// ── T4 — composition-root wiring ─────────────────────────────────────────
describe('T4: facades are wired at the composition root', () => {
    it('backend.cjs creates both facades from the Canonical Book Model', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/createPlayerModel\(\s*\{\s*bookModel\s*\}\s*\)/);
        expect(backend).to.match(/createEditorModel\(\s*\{\s*bookModel,\s*persistBook:\s*book\.saveBookBundle\s*\}\s*\)/);
    });

    it('routeDeps exposes playerModel and editorModel', () => {
        const backend = readSource(BACKEND_ROOT);
        expect(backend).to.match(/playerModel:/);
        expect(backend).to.match(/editorModel:/);
    });

    it('contour routes destructure the facade deps', () => {
        expect(readSource(path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs'))).to.match(/playerModel/);
        expect(readSource(path.join(BACKEND_SRC, 'routes', 'book', 'chunks-routes.cjs'))).to.match(/playerModel/);
        expect(readSource(path.join(BACKEND_SRC, 'routes', 'book', 'core-routes.cjs'))).to.match(/editorModel/);
        expect(readSource(path.join(BACKEND_SRC, 'routes', 'book', 'entity-crud-routes.cjs'))).to.match(/editorModel/);
    });
});

// ── T5 — contour routes go through the facades ───────────────────────────
describe('T5: Editor/Player contours load through the facades', () => {
    const editorRoutes = [
        'routes/book/core-routes.cjs',
        'routes/book/entity-crud-routes.cjs',
    ];

    it('editor routes have NO direct book.loadBook / book.saveBookBundle calls', () => {
        for (const f of editorRoutes) {
            const src = readSource(path.join(BACKEND_SRC, f));
            expect(src, `${f} must not call book.loadBook directly`).to.not.match(/\bbook\.loadBook\s*\(/);
            expect(src, `${f} must not call book.saveBookBundle directly`).to.not.match(/\bbook\.saveBookBundle\s*\(/);
        }
    });

    it('player media routes read books through playerModel only (import leg pinned)', () => {
        // routes/generation-routes.cjs serves BOTH playback media (Player
        // contour) and the legacy full-book import (POST /generate). The
        // playback reads go through playerModel; the import/generation leg
        // keeps its direct loader calls — pinned exactly here so it cannot
        // grow silently (docs/architecture/PHASE_6_EDITOR_PLAYER.md §6).
        const src = readSource(path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs'));
        const direct = [...src.matchAll(/\bbook\.loadBook\s*\(/g)].length;
        expect(direct, 'routes/generation-routes.cjs direct book.loadBook count grew').to.equal(3);
        expect(src).to.match(/diskCopyExists: !!book\.loadBook\(bookId\)/);
        expect(src).to.match(/const existingBook = book\.loadBook\(bookId\);/);
        expect(src).to.match(/const loadedBook = book\.loadBook\(bookId\);/);
        // The playback read sites must go through the Player boundary.
        expect(src).to.match(/playerModel\.loadBook\(bookId\)/);
        expect(src).to.match(/playerModel\.loadBook\(book_id\)/);
    });

    it('chunks (playback queue) route reads through playerModel', () => {
        const src = readSource(path.join(BACKEND_SRC, 'routes', 'book', 'chunks-routes.cjs'));
        expect(src).to.not.match(/\bbook\.loadBook\s*\(/);
        expect(src).to.match(/playerModel\.loadBook\(bookId\)/);
    });

    it('generation-control routes keep their pinned loader calls (regenerate leg)', () => {
        // routes/book/generation-routes.cjs is the generation-control leg
        // (POST /book/:id/regenerate, cancel-generation, generate-next) — a
        // generation-pipeline concern, deliberately NOT migrated to playerModel
        // (docs/architecture/PHASE_6_EDITOR_PLAYER.md §6.1). Its direct
        // book.loadBook calls are pinned here (same rule as the import leg in
        // routes/generation-routes.cjs) so the leg cannot grow new facade
        // bypasses silently.
        const src = readSource(path.join(BACKEND_SRC, 'routes', 'book', 'generation-routes.cjs'));
        const direct = [...src.matchAll(/\bbook\.loadBook\s*\(/g)].length;
        expect(direct, 'routes/book/generation-routes.cjs direct book.loadBook count grew').to.equal(3);
        expect(src).to.not.match(/\bbook\.saveBookBundle\s*\(/);
    });
});

// ── T6 — frozen legacy edges on the contour routes ───────────────────────
describe('T6: contour routes do not gain new implementation-detail deps', () => {
    // Baseline of the LEGACY edges that still exist on the Player/Editor
    // contour routes after Phase 6 (documented in
    // docs/architecture/PHASE_6_EDITOR_PLAYER.md §6 — deliberately not
    // migrated). New edges in these families fail.
    const BASELINE = {
        'routes/generation-routes.cjs': [
            '../middleware/auth-context',
            '../video/video-timeline',
            '../storage/postgres/repositories/book-repo',
            '../storage/postgres/repositories/task-repo',
            '../middleware/workspace-ownership',
            '../storage/postgres/repositories/generation-cancel-repo',
            '../runtime/scene-window',
            '../runtime/worker-health',
            '../services/ai-service',
            '../services/workspace-ai-provider',
            '../services/progress-pubsub.cjs',
            '../runtime/job-schema',
            '../runtime/dispatch-engine',
            '../services/audio-orchestrator',
            '../services/video-orchestrator',
        ],
        'routes/book/core-routes.cjs': [
            '../../storage/postgres/repositories/scene-assets-repo',
            '../../orchestration/scene-restoration',
            './scene-patch-utils.cjs',
            './recover-chunks.cjs',
            '../../services/source-coverage-audit',
            '../../services/agent-prompts',
        ],
        'routes/book/chunks-routes.cjs': [
            '../../storage/postgres/repositories/scene-assets-repo',
            './iu-progress-utils.cjs',
        ],
        'routes/book/entity-crud-routes.cjs': [
            '../../utils/entity-id',
            './scene-patch-utils.cjs',
            '../../book/lazy-book/paths',
            '../../services/entity-cleanup.cjs',
            '../../middleware/workspace-ownership',
        ],
        'routes/book/generation-routes.cjs': [
            // Generation-control leg (regenerate / cancel / generate-next) —
            // requires dispatch/runtime + PG repos + raw PG for its VBook
            // session cancellation, all baselined legacy edges (§6.1).
            '../../storage/postgres/repositories/scene-assets-repo',
            '../../services/generation-progress',
            '../../runtime/dispatch-engine',
            '../../storage/postgres/repositories/task-repo',
            '../../storage/postgres/repositories/book-repo',
            '../../storage/postgres/repositories/generation-cancel-repo',
            '../../storage/postgres/database',
        ],
    };

    function scanEdgeSpecs(src) {
        // require('<spec>') anywhere in the file (top-level + lazy); full-line
        // comments are stripped so usage docs like
        // "// require('./routes/generation-routes.cjs')..." are not edges.
        const code = src.split('\n')
            .filter((line) => !/^\s*\/\//.test(line))
            .join('\n');
        return [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    }

    it('relative require sets of the contour routes stay frozen', () => {
        const offenders = [];
        for (const [file, baseline] of Object.entries(BASELINE)) {
            const src = readSource(path.join(BACKEND_SRC, file));
            const specs = scanEdgeSpecs(src).filter((s) => s.startsWith('.'));
            const baselineSet = new Set(baseline);
            for (const spec of specs) {
                if (!baselineSet.has(spec)) offenders.push(`${file}: ${spec}`);
            }
        }
        expect(offenders, 'NEW implementation-detail dep on a Player/Editor contour route').to.deep.equal([]);
    });

    it('no contour route opens Redis or raw PG client connections directly', () => {
        for (const file of Object.keys(BASELINE)) {
            const src = readSource(path.join(BACKEND_SRC, file));
            expect(src, `${file} must not open PG connections`).to.not.match(/require\(['"](pg|.*postgres)['"]\)/);
            expect(src, `${file} must not open Redis connections`).to.not.match(/require\(['"]ioredis['"]\)/);
        }
    });
});

// ── T7 — frontend Player/Editor consumers use the API seam ──────────────
describe('T7: frontend Player/Editor consumers build API URLs through the client seam', () => {
    it('pages/ and state/ contain no hardcoded /api/v1/ URL literals', () => {
        // The API base is owned by frontends/app/src/api/client.ts (API_BASE +
        // mediaUrl). Quoted literals starting with /api/v1/ outside it bypass
        // the seam (comments and external endpoints like openrouter.ai are
        // not quoted literals and do not match).
        const offenders = [];
        for (const dir of ['pages', 'state']) {
            for (const file of listSourceFiles(path.join(FRONTEND_APP_DIR, dir), ['.ts', '.tsx'])) {
                if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
                const src = readSource(file);
                if (/['"`]\/api\/v1\//.test(src)) offenders.push(rel(file));
            }
        }
        expect(offenders, 'hardcoded /api/v1/ literals must go through api/client.ts').to.deep.equal([]);
    });

    it('api/client.ts owns the API base and exposes the media URL seam', () => {
        const client = readSource(path.join(FRONTEND_APP_DIR, 'api', 'client.ts'));
        expect(client).to.match(/export const API_BASE = '\/api\/v1';/);
        expect(client).to.match(/export function mediaUrl/);
    });
});

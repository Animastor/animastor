// ======================================================
// EDITOR PHASE 2 — CONTRACT FREEZE / EXTRACTION READINESS GUARDS
// (E4–E8)
// ======================================================
// Docs: docs/architecture/editor-module-extraction-audit.md
// §Phase 2 (contract freeze + extraction-readiness audit). These guards
// freeze what the Phase 1 route split produced so the future physical
// move to packages/animastor-editor stays mechanical:
//
//   E4 — Dependency matrix freeze: the exact dep legs each contour
//        registrar consumes (member access + destructuring) are pinned,
//        so a new host leg cannot appear silently.
//   E5 — editorPorts contract freeze: the port object shape (the 7
//        frozen port names) is validated functionally —
//        createEditorPorts({deps}) requires the mandatory legs and
//        passes all legs through verbatim (identity, no wrapping).
//   E6 — Transitive require closure: the module closure of the contour
//        (registrars + helpers, excluding the composition-root seam
//        itself) reaches ONLY intra-contour files, the two host id
//        grammar shims (book/lazy-book/paths — a pure re-export of
//        @animastor/vbook-runtime — and utils/entity-id) and the pure
//        transliteration map (utils/cyr-latin-map — zero deps) plus
//        node builtins. B1 is resolved: the old hidden chain
//        (entity-id → image/helpers → string-utils → runtime-config)
//        is gone — entity-id now imports cyrToLatin from the
//        standalone utils/cyr-latin-map module.
//   E7 — Editor package future boundary: the contour is carried by
//        exactly the five files; no package requires editor modules;
//        the physical packages/animastor-editor does not exist yet.
//   E8 — No editorPorts bypass: contour handlers reach host legs ONLY
//        through the destructured editorModel/editorPorts/utils members
//        — no require() inside handler bodies (lazy requires), no
//        secondary deps.* access, no agent/generation domain imports.
//
// All checks are static/functional source scans (Phase 1 helpers,
// CI-safe — no server boot, no DB).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { builtinModules } = require('module');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier, REPO_ROOT,
} = require('./helpers');

const EDITOR_DIR = path.join(BACKEND_SRC, 'routes', 'editor');
const EDITOR_REGISTRARS = [
    path.join(EDITOR_DIR, 'editor-routes.cjs'),
    path.join(EDITOR_DIR, 'entity-crud-routes.cjs'),
];
const EDITOR_PORTS = path.join(EDITOR_DIR, 'editor-ports.cjs');
const EDITOR_HELPERS = [
    path.join(EDITOR_DIR, 'scene-patch-utils.cjs'),
    path.join(EDITOR_DIR, 'read-recovery.cjs'),
];
const BACKEND_ROOT = path.join(BACKEND_SRC, 'backend.cjs');

// ── The frozen editorPorts shape (Phase 1 seam, frozen in Phase 2) ────────
const FROZEN_PORTS = [
    'sceneAssetsRepo',   // PG scene-assets: bumpSceneVersions / setDirtyUnitIds
    'placeholderAudio',   // read-repair: recoverMissingPlaceholders
    'auditCoverage',     // services/source-coverage-audit
    'promptLimit',       // IMAGE_PROMPT_MAX_CHARS (agent-domain constant)
    'purge',             // entity-cleanup purgeScene / purgeUnit
    'resolveOwnership',  // workspace-ownership.resolveWorkspaceForBook
    'recoveryCtx',       // read-recovery ctx (redis chunk repair)
];

/** Strip comments so doc mentions are not legs; keep code structure. */
function codeOf(file) {
    return readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

// ── E4 — dependency matrix freeze ─────────────────────────────────────────
describe('E4: dependency matrix — contour deps legs stay frozen', () => {
    const BASELINE = {
        'routes/editor/editor-routes.cjs': [
            'book.collectSceneList',        // thin-client scene_list projection
            'bookDeletion.deleteBook',      // DELETE /book cascade (host service)
            'bookDiff.computeBookDiff',     // dirty-scene diff (host service)
            'editorModel.commit',           // canonical writer (facade)
            'editorModel.read',             // canonical reader (facade)
            'editorPorts.auditCoverage',    // GET source-coverage
            'editorPorts.placeholderAudio', // GET book read-repair
            'editorPorts.promptLimit',      // prompt length ceiling
            'editorPorts.recoveryCtx',      // GET book chunk recovery
            'editorPorts.sceneAssetsRepo',  // post-commit fan-out
            'storage.bookSync',             // post-commit PG reconcile
            'utils.log',                     // destructured: const { log } = utils
        ],
        'routes/editor/entity-crud-routes.cjs': [
            'editorModel.commit',
            'editorModel.read',
            'editorPorts.purge',            // structure-delete deep cleanup
            'editorPorts.resolveOwnership', // POST /book/blank ownership attach
            'utils.log',                     // destructured: const { log } = utils
        ],
    };

    // All host legs consumed from the given dep objects: both `dep.member`
    // access and `const { a, b } = dep` destructuring.
    function legsUsed(code, depNames) {
        const used = new Set();
        for (const dep of depNames) {
            for (const m of code.matchAll(new RegExp('(?<![\\w.$-])' + dep + '\\.([A-Za-z_$][\\w$]*)', 'g'))) {
                used.add(`${dep}.${m[1]}`);
            }
            for (const m of code.matchAll(new RegExp('const\\s*\\{([^}]*)\\}\\s*=\\s*' + dep + '\\s*;', 'g'))) {
                for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
                    used.add(`${dep}.${n}`);
                }
            }
        }
        return [...used].sort();
    }

    it('editor-routes.cjs consumes exactly the frozen dep legs', () => {
        const used = legsUsed(codeOf(EDITOR_REGISTRARS[0]), ['book', 'bookDiff', 'storage', 'bookDeletion', 'editorModel', 'editorPorts', 'utils']);
        expect(used, 'editor-routes dep matrix changed — see Phase 2 audit §E4').to.deep.equal(BASELINE['routes/editor/editor-routes.cjs']);
    });

    it('entity-crud-routes.cjs consumes exactly the frozen dep legs', () => {
        const used = legsUsed(codeOf(EDITOR_REGISTRARS[1]), ['editorModel', 'editorPorts', 'utils']);
        expect(used, 'entity-crud dep matrix changed — see Phase 2 audit §E4').to.deep.equal(BASELINE['routes/editor/entity-crud-routes.cjs']);
    });

    it('read-recovery ctx consumes exactly the frozen ctx fields', () => {
        const code = codeOf(EDITOR_HELPERS[1]);
        // destructured ctx fields — the ctx contract
        const m = code.match(/const\s*\{([^}]*)\}\s*=\s*ctx\s*;/);
        expect(m, 'read-recovery must destructure its ctx explicitly').to.not.equal(null);
        const fields = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
        expect(fields).to.deep.equal([
            'activeScenes', 'book', 'config', 'getAllChunks', 'log', 'redis', 'saveChunk', 'state',
        ]);
        // the ctx contract is fully documented in its header; the handler
        // consumes the chunk legs + redis counters + book projections
        for (const f of ['redis', 'book', 'config']) {
            expect(code, `ctx.${f} must be consumed as a member`).to.match(new RegExp('(?<![\\w.$])' + f + '\\.'));
        }
        for (const f of ['getAllChunks', 'saveChunk', 'log']) {
            expect(code, `ctx.${f} must be invoked`).to.match(new RegExp('(?<![\\w.$])' + f + '\\s*\\('));
        }
    });
});

// ── E5 — editorPorts contract freeze (functional) ─────────────────────────
describe('E5: createEditorPorts — the frozen port object contract', () => {
    it('exports exactly the seven frozen port names', () => {
        const createEditorPorts = require(EDITOR_PORTS);
        const ports = createEditorPorts({
            deps: {
                sceneAssetsRepo: {}, placeholderAudio: {}, auditCoverage: {},
                promptLimit: 2000, purge: {}, resolveOwnership: {}, recoveryCtx: {},
            },
        });
        expect(Object.keys(ports).sort()).to.deep.equal([...FROZEN_PORTS].sort());
    });

    it('passes host legs through by reference (identity, no wrapping)', () => {
        const createEditorPorts = require(EDITOR_PORTS);
        const legs = {
            sceneAssetsRepo: { leg: 1 },
            placeholderAudio: { leg: 2 },
            auditCoverage: { leg: 3 },
            promptLimit: 2000,
            purge: { leg: 4 },
            resolveOwnership: { leg: 5 },
            recoveryCtx: { leg: 6 },
        };
        const ports = createEditorPorts({ deps: legs });
        // Same references — the port object NEVER wraps/re-implements host
        // legs (the pre-split function references flow through untouched).
        for (const k of FROZEN_PORTS) expect(ports[k], `port ${k} must be the same reference`).to.equal(legs[k]);
    });

    it('throws fail-closed when a mandatory port is missing', () => {
        const createEditorPorts = require(EDITOR_PORTS);
        expect(() => createEditorPorts({ deps: {} })).to.throw(/sceneAssetsRepo/);
        expect(() => createEditorPorts({ deps: { sceneAssetsRepo: {} } })).to.throw(/placeholderAudio/);
    });

    it('backend.cjs wires all seven ports at the composition root', () => {
        const src = readSource(BACKEND_ROOT);
        expect(src).to.match(/editorPorts:\s*require\('\.\/routes\/editor\/editor-ports\.cjs'\)/);
        // The deps block carries every port name as a key or shorthand.
        const wiring = src.slice(src.indexOf('editorPorts: require('));
        const block = wiring.slice(0, wiring.indexOf('}),\n};') > 0 ? wiring.indexOf('}),\n};') : 5000);
        for (const p of FROZEN_PORTS) {
            expect(block, `composition root must wire the ${p} port`).to.match(new RegExp('\\b' + p + '\\b'));
        }
    });
});

// ── E6 — transitive require closure (extraction readiness) ────────────────
describe('E6: contour require closure reaches only intra-contour + the pinned id-grammar shims', () => {
    // The closure walk starts at the registrars + pure helpers and follows
    // every relative require. The seam (editor-ports.cjs) is excluded: it is
    // the composition-root shape file and holds zero requires (pinned by
    // E2); its deps arrive from backend.cjs.
    const START = [...EDITOR_REGISTRARS, ...EDITOR_HELPERS];
    // Host files allowed inside the closure (the Phase 3 dependency matrix):
    //   book/lazy-book/paths.js — pure re-export shim of @animastor/vbook-runtime
    //     (post-move the package imports the runtime export directly);
    //   utils/entity-id.js — Editor-only id transliteration (move candidate);
    //   utils/cyr-latin-map.js — pure CYR_LATIN_MAP + cyrToLatin (zero deps,
    //     the canonical transliteration source; entity-id + image/helpers both
    //     import from here).
    // B1 resolved: image/helpers.js, utils/string-utils.js, and
    // config/runtime-config.js are NO LONGER in the closure.
    const ALLOWED_HOST_FILES = new Set([
        path.join(BACKEND_SRC, 'book', 'lazy-book', 'paths.js'),
        path.join(BACKEND_SRC, 'utils', 'entity-id.js'),
        path.join(BACKEND_SRC, 'utils', 'cyr-latin-map.js'),
    ]);

    function walkClosure() {
        const seen = [];
        const queue = [...START];
        const visited = new Set();
        while (queue.length > 0) {
            const file = queue.shift();
            const key = path.resolve(file);
            if (visited.has(key)) continue;
            visited.add(key);
            for (const spec of requireSpecifiers(readSource(file))) {
                if (builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0])) continue;
                if (!spec.startsWith('.')) continue;
                const resolved = resolveSpecifier(file, spec);
                if (!resolved) continue;
                const isContour = resolved.startsWith(EDITOR_DIR + path.sep);
                if (isContour) { queue.push(resolved); continue; }
                seen.push({ from: rel(file), spec, to: rel(resolved) });
                // continue walking host legs ONLY for the allowed shims so
                // their own transitive host deps stay visible in `seen`
                if (ALLOWED_HOST_FILES.has(resolved)) queue.push(resolved);
            }
        }
        return seen;
    }

    it('the closure reaches only the pinned host files (the Phase 2 matrix)', () => {
        const edges = walkClosure();
        const offenders = edges.filter((e) => !ALLOWED_HOST_FILES.has(path.join(REPO_ROOT, e.to)));
        expect(
            offenders.map((e) => `${e.from} → ${e.to}`),
            'editor contour closure gained a new host module — extend the Phase 2 dependency matrix consciously',
        ).to.deep.equal([]);
        // The pinned host set is exact — B1 resolved: only the pure
        // transliteration chain (entity-id → cyr-latin-map) plus the
        // vbook-runtime shim remain; no image/string-utils/runtime-config.
        const reachedHost = [...new Set(edges.map((e) => e.to))].sort();
        expect(reachedHost).to.deep.equal([
            'backend/src/book/lazy-book/paths.js',
            'backend/src/utils/cyr-latin-map.js',
            'backend/src/utils/entity-id.js',
        ]);
    });

    it('book/lazy-book/paths is a pure shim over @animastor/vbook-runtime (zero host logic)', () => {
        const code = codeOf(path.join(BACKEND_SRC, 'book', 'lazy-book', 'paths.js')).trim();
        expect(code).to.equal("module.exports = require('@animastor/vbook-runtime/lazy-book/paths');");
    });

    it('scene-patch-utils stays pure (zero requires)', () => {
        const specs = requireSpecifiers(codeOf(EDITOR_HELPERS[0]));
        expect(specs, 'scene-patch-utils is the shared pure helper — it must not gain requires').to.deep.equal([]);
    });

    it('B1 resolved: the closure no longer reaches image/helpers, string-utils, or runtime-config', () => {
        const edges = walkClosure();
        const reachedHost = edges.map((e) => e.to);
        const forbidden = [
            'backend/src/image/helpers.js',
            'backend/src/utils/string-utils.js',
            'backend/src/config/runtime-config.js',
        ];
        for (const f of forbidden) {
            expect(reachedHost, `B1 regression: ${f} must not be in the editor closure`).to.not.include(f);
        }
    });

    it('cyr-latin-map is a pure zero-dependency module (the canonical transliteration source)', () => {
        const code = codeOf(path.join(BACKEND_SRC, 'utils', 'cyr-latin-map.js'));
        const specs = requireSpecifiers(code);
        expect(specs, 'cyr-latin-map must not require any host module').to.deep.equal([]);
        expect(code).to.match(/CYR_LATIN_MAP/);
        expect(code).to.match(/function cyrToLatin/);
    });

    it('entity-id imports cyrToLatin from cyr-latin-map (not from image/helpers)', () => {
        const code = codeOf(path.join(BACKEND_SRC, 'utils', 'entity-id.js'));
        expect(code).to.match(/require\(['"]\.\/cyr-latin-map['"]\)/);
        expect(code).to.not.match(/require\(['"].*image\/helpers['"]\)/);
    });
});

// ── E7 — Editor package future boundary ───────────────────────────────────
describe('E7: editor contour is carried by exactly the 5 files + the facade', () => {
    it('routes/editor/** contains exactly the five contour files (no strays)', () => {
        const files = listSourceFiles(EDITOR_DIR).map((f) => rel(f)).sort();
        expect(files).to.deep.equal([
            'backend/src/routes/editor/editor-ports.cjs',
            'backend/src/routes/editor/editor-routes.cjs',
            'backend/src/routes/editor/entity-crud-routes.cjs',
            'backend/src/routes/editor/read-recovery.cjs',
            'backend/src/routes/editor/scene-patch-utils.cjs',
        ]);
    });

    it('the editor model facade stays a one-facade module (read/commit only)', () => {
        const src = readSource(path.join(BACKEND_SRC, 'editor', 'index.cjs'));
        expect(src).to.match(/read\(bookId/);
        expect(src).to.match(/commit\(book/);
        expect(src).to.not.match(/require\(['"]\.\.\/(routes|services|storage|runtime|orchestration)/);
    });

    it('packages/animastor-editor does NOT exist yet (physical move not started)', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'packages', 'animastor-editor'))).to.equal(false);
    });

    it('no package requires an editor module (one-way street)', () => {
        const offenders = [];
        for (const pkg of ['animastor-player', 'animastor-vbook-runtime', 'animastor-worker', 'animastor-parser', 'animastor-contracts']) {
            const dir = path.join(REPO_ROOT, 'packages', pkg);
            for (const file of listSourceFiles(dir)) {
                for (const spec of requireSpecifiers(readSource(file))) {
                    if (/editor/i.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'packages stay decoupled from the editor contour').to.deep.equal([]);
    });
});

// ── E8 — no editorPorts bypass ────────────────────────────────────────────
describe('E8: no editorPorts bypass — contour reaches host legs only via the seams', () => {
    it('no contour file contains require() inside handler bodies (lazy host requires)', () => {
        const offenders = [];
        for (const file of listSourceFiles(EDITOR_DIR)) {
            const lines = readSource(file).split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^\s*\/\//.test(line)) continue;
                const trimmed = line.replace(/\s\/\/.*$/, '');
                // a require() after module.exports (inside the registrar
                // function body) is a lazy host leg
                if (/require\(\s*['"]/.test(trimmed)) {
                    const before = lines.slice(0, i).join('\n');
                    if (/module\.exports\s*=/.test(before)) {
                        offenders.push(`${rel(file)}:${i + 1}: ${trimmed.trim()}`);
                    }
                }
            }
        }
        expect(offenders, 'host legs must arrive via editorPorts, not lazy requires').to.deep.equal([]);
    });

    it('registrars destructure deps exactly once at the top (no secondary deps.* access)', () => {
        for (const file of EDITOR_REGISTRARS) {
            const src = codeOf(file);
            const splitAt = src.indexOf('} = deps');
            expect(splitAt, `${rel(file)} must destructure deps`).to.be.above(-1);
            const after = src.slice(splitAt);
            expect(after, `${rel(file)} must not access deps.* after destructuring (new hidden legs)`).to.not.match(/\bdeps\./);
        }
    });

    it('the contour never requires the AI/generation/agent domain', () => {
        for (const file of listSourceFiles(EDITOR_DIR)) {
            for (const spec of requireSpecifiers(codeOf(file))) {
                expect(spec, `${rel(file)} must not require the agent domain (${spec})`).to.not.match(/agent|generation|ai-/i);
            }
        }
    });
});

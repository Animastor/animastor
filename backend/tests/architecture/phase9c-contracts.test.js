// ======================================================
// PHASE 9C — @animastor/contracts extraction guards
// ======================================================
// Phase 9C moved the canonical Job Protocol v2 implementation into the
// standalone package @animastor/contracts (contracts/, top level — mirrors
// the ai-connector/ package convention). This suite guards the extraction:
//
//   C1. package manifest: @animastor/contracts, zero runtime deps.
//   C2. contracts isolation: node builtins + own files only; no require
//       into backend/worker/gpu-hub/ai-connector from contracts.
//   C3. backend keeps the compatibility facade at the old path and does
//       NOT re-implement the grammar (no second divergent schema).
//   C4. protocol_version = 2 pinned in the canonical source.
//   C5. dependency direction: nothing code-depends on contracts except the
//       backend facade and tests; the hub consumes the PUBLISHED registry
//       package (Phase 10G — no hub-side code seam into contracts/ sources).
//       worker/LAC stay copy-isolated.
//   C6. cross-side parity: contracts ↔ backend facade runtime identity;
//       contracts JOB_TYPES ↔ worker split-regex family ↔ hub
//       SYSTEM_JOB_TYPES (Backend ↔ Contracts ↔ Worker/GPU Hub).
//   C7. deployment: the backend compose service mounts the package so the
//       facade resolves inside the container. The gpu-hub service carries
//       NO contracts mount (Phase 10G: the hub installs the published
//       package from the registry — a mount would shadow it).
//
// Normative spec: docs/architecture/JOB_PROTOCOL_V2.md (FROZEN).
// Audit: docs/architecture/PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel,
    requireSpecifiers, resolveSpecifier,
} = require('./helpers');

const CONTRACTS_DIR = path.join(REPO_ROOT, 'packages', 'animastor-contracts');
const CONTRACTS_IMPL_PATH = path.join(CONTRACTS_DIR, 'src', 'job-protocol-v2.js');
const CONTRACTS_INDEX_PATH = path.join(CONTRACTS_DIR, 'src', 'index.js');
const jobSchemaPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'job-schema.js');
const gpuHubPath = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub', 'gpu-hub.js');
const workerPath = path.join(REPO_ROOT, 'worker', 'worker', 'worker.cjs');
const LAC_DIR = path.join(REPO_ROOT, 'packages', 'animastor-ai-connector');
const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');
const WORKER_DIR = path.join(REPO_ROOT, 'worker', 'worker');

function read(file) {
    return readSource(file);
}

/** Resolved relative require targets of a file (repo-relative posix paths). */
function relativeTargets(file) {
    const out = [];
    for (const spec of requireSpecifiers(readSource(file))) {
        if (!spec.startsWith('.')) continue;
        const base = path.resolve(path.dirname(file), spec);
        const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
        let resolved = null;
        for (const c of candidates) {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) { resolved = c; break; }
        }
        out.push({ spec, target: rel(resolved || base) });
    }
    return out;
}

// ── C1 — package manifest ────────────────────────────────────────────────
describe('Phase 9C: @animastor/contracts package manifest', () => {
    it('manifest pins the name, semver and a dependency-free runtime', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/contracts');
        expect(pkg.version).to.match(/^\d+\.\d+\.\d+$/);
        expect(pkg.main).to.equal('src/index.js');
        expect(pkg.dependencies || {}, 'contracts must have ZERO runtime dependencies').to.deep.equal({});
        expect(pkg.license).to.equal('MIT');
    });

    it('canonical implementation and entry point exist', () => {
        expect(fs.existsSync(CONTRACTS_IMPL_PATH), 'contracts/src/job-protocol-v2.js must exist').to.equal(true);
        expect(fs.existsSync(CONTRACTS_INDEX_PATH), 'contracts/src/index.js must exist').to.equal(true);
    });
});

// ── C2 — contracts isolation ─────────────────────────────────────────────
describe('Phase 9C: contracts package isolation', () => {
    it('contracts sources require only node builtins + their own files (zero npm deps)', () => {
        const builtins = new Set(require('module').builtinModules);
        const offenders = [];
        for (const file of listSourceFiles(CONTRACTS_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('.')) continue;
                if (builtins.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'contracts must stay dependency-free (no npm packages)').to.deep.equal([]);
    });

    it('contracts never reaches into backend/worker/gpu-hub/ai-connector sources', () => {
        const offenders = [];
        for (const file of listSourceFiles(CONTRACTS_DIR)) {
            for (const { spec, target } of relativeTargets(file)) {
                if (!target.startsWith('packages/animastor-contracts/')) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'contracts must not code-depend on any consuming component').to.deep.equal([]);
    });
});

// ── C3 — backend facade (no second divergent schema) ─────────────────────
describe('Phase 9C: backend job-schema stays a pure facade', () => {
    it('the old path keeps working and re-exports the contracts package', () => {
        const facade = read(jobSchemaPath);
        expect(facade).to.include("require('@animastor/contracts')");
        // no grammar re-implementation may creep back in
        expect(facade, 'facade must not define PROTOCOL_VERSION locally').to.not.match(/PROTOCOL_VERSION\s*=\s*\d/);
        expect(facade, 'facade must not define grammar functions').to.not.match(/function\s+(parseJobId|buildJobId|splitJobId|getStageForJobId)\b/);
        expect(facade, 'facade must not redefine STAGE_BY_KIND').to.not.match(/STAGE_BY_KIND\s*=\s*\{/);
    });

    it('no second divergent schema: grammar is defined ONLY in contracts (or delegates to it)', () => {
        // scan all production trees for grammar-function definitions
        const grammarDefRe = /function\s+(parseJobId|buildJobId|splitJobId|getStageForJobId)\b/;
        // Phase 9D: the worker bundle carries a GENERATED verbatim copy of
        // the canonical implementation (worker/worker/job-protocol-v2.cjs).
        // It is not a divergent schema — byte parity is guarded by
        // phase9d-worker-package.test.js — so it is excluded here.
        const GENERATED_WORKER_COPY = 'worker/worker/job-protocol-v2.cjs';
        const offenders = [];
        for (const dir of [BACKEND_SRC, HUB_DIR, WORKER_DIR, LAC_DIR]) {
            for (const file of listSourceFiles(dir)) {
                const src = readSource(file);
                if (!grammarDefRe.test(src)) continue;
                if (rel(file) === GENERATED_WORKER_COPY) continue;
                // a local definition is only acceptable as a pure delegation
                // wrapper — the file must require the backend facade/contracts
                if (!/require\([^)]*job-schema/.test(src) && !/require\([^)]*contracts/.test(src)) {
                    offenders.push(rel(file));
                }
            }
        }
        expect(offenders, 'a grammar implementation that does not delegate to contracts is a divergent schema').to.deep.equal([]);
    });

    it('PROTOCOL_VERSION literal may only live in contracts (canonical) and the worker generated copy', () => {
        // allowed definition sites: the canonical package, the worker
        // generated copy, and the LAC wire protocol (ai-connector v1 — a
        // different protocol, NOT Job Protocol v2). Phase 10B removed the
        // hub from this list: the hub consumes the canonical package via
        // the compose mount seam and carries no local literal.
        const allowed = new Set([
            'packages/animastor-contracts/src/job-protocol-v2.js', // canonical
            'worker/worker/job-protocol-v2.cjs',       // GENERATED from canonical (Phase 9D, B2)
            'backend/src/routes/ai-connector-routes.cjs', // LAC protocol v1 (separate contract)
        ]);
        const offenders = [];
        const literalRe = /PROTOCOL_VERSION\s*=\s*\d/;
        for (const dir of [BACKEND_SRC, HUB_DIR, WORKER_DIR, LAC_DIR, CONTRACTS_DIR]) {
            for (const file of listSourceFiles(dir)) {
                if (literalRe.test(readSource(file)) && !allowed.has(rel(file))) offenders.push(rel(file));
            }
        }
        expect(offenders, 'a new independent PROTOCOL_VERSION definition is a divergent schema').to.deep.equal([]);
    });
});

// ── C4 — canonical value pin ─────────────────────────────────────────────
describe('Phase 9C: canonical protocol value', () => {
    const contractsImpl = require(CONTRACTS_IMPL_PATH);

    it('protocol_version = 2 in the canonical source (value + literal)', () => {
        expect(contractsImpl.PROTOCOL_VERSION).to.equal(2);
        expect(read(CONTRACTS_IMPL_PATH)).to.match(/PROTOCOL_VERSION\s*=\s*2\b/);
    });

    it('canonical JOB_TYPES / STAGE_BY_KIND / SYSTEM_JOB_TYPES are frozen', () => {
        expect(contractsImpl.JOB_TYPES).to.deep.equal(['audio', 'image', 'iu_image', 'video']);
        expect(contractsImpl.SYSTEM_JOB_TYPES).to.deep.equal(['audio', 'image', 'video']);
        expect(contractsImpl.STAGE_BY_KIND).to.deep.equal({
            audio_chunk: 'audio',
            iu_image: 'image',
            scene_image: 'image',
            scene_video: 'video',
        });
    });
});

// ── C5 — dependency direction ────────────────────────────────────────────
describe('Phase 9C: dependency direction into contracts', () => {
    it('only the backend facade reaches contracts relatively; hub consumes the registry package (production trees)', () => {
        // Phase 10G: the hub consumes the PUBLISHED registry package via its
        // own manifest — it must NOT relatively reach into the monorepo
        // contracts/ sources. The backend facade stays the single relative
        // consumer; worker/LAC stay copy-isolated.
        const allowed = new Set([
            'backend/src/runtime/job-schema.js',
        ]);
        const offenders = [];
        for (const dir of [BACKEND_SRC, HUB_DIR, WORKER_DIR, LAC_DIR]) {
            for (const file of listSourceFiles(dir)) {
                for (const { spec, target } of relativeTargets(file)) {
                    if (target.startsWith('packages/animastor-contracts/') && !allowed.has(rel(file))) {
                        offenders.push(`${rel(file)}: ${spec}`);
                    }
                }
            }
        }
        expect(offenders, 'backend business logic must consume the facade, not contracts sources directly').to.deep.equal([]);
    });

    it('no backend/src file bypasses the facade via the bare npm specifier (facade is the single choke point)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('@animastor/contracts') && !rel(file).endsWith('runtime/job-schema.js')) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'backend must import contracts only through the facade').to.deep.equal([]);
    });

    it('the facade stays the ONLY backend production consumer (single choke point)', () => {
        const facade = read(jobSchemaPath);
        expect(facade.match(/require\('@animastor\/contracts'\)/g), 'exactly one package require in the facade').to.have.length(1);
    });
});

// ── C6 — cross-side contract parity (backend ↔ contracts ↔ hub/worker) ───
describe('Phase 9C: cross-side Job Protocol v2 parity', () => {
    const contractsImpl = require(CONTRACTS_IMPL_PATH);
    const facade = require(jobSchemaPath);

    it('backend facade and contracts export the identical API (runtime)', () => {
        expect(Object.keys(facade).sort()).to.deep.equal(Object.keys(contractsImpl).sort());
        expect(facade.PROTOCOL_VERSION).to.equal(contractsImpl.PROTOCOL_VERSION);
        expect(facade.JOB_TYPES).to.deep.equal(contractsImpl.JOB_TYPES);
        expect(facade.STAGE_BY_KIND).to.deep.equal(contractsImpl.STAGE_BY_KIND);
        for (const fn of ['buildJobId', 'splitJobId', 'parseJobId', 'getStageForJobId']) {
            expect(facade[fn]).to.equal(contractsImpl[fn], `${fn} must be the same function object`);
        }
    });

    it('worker split-regex family stays equal to canonical JOB_TYPES', () => {
        const worker = read(workerPath);
        // Phase 9D: the worker no longer carries inline split literals —
        // both input-file naming splits consume JOB_ID_SPLIT_RE from the
        // generated canonical copy (worker/worker/job-protocol-v2.cjs),
        // whose family is pinned separately below.
        const usages = [...worker.matchAll(/job_id\.split\(JOB_ID_SPLIT_RE\)/g)].map((m) => m[0]);
        expect(usages, 'worker job_id split usages of the generated copy').to.deep.equal([
            'job_id.split(JOB_ID_SPLIT_RE)', 'job_id.split(JOB_ID_SPLIT_RE)',
        ]);
        const workerCopy = read(path.join(WORKER_DIR, 'job-protocol-v2.cjs'));
        expect(workerCopy).to.include('JOB_ID_SPLIT_RE = /:(iu_image|image|audio|video)$/');
        // and the canonical split family must contain exactly the JOB_TYPES set
        const family = contractsImpl.JOB_ID_SPLIT_RE.source.replace(/^:\(/, '').replace(/\)\$$/, '');
        expect(family.split('|').sort()).to.deep.equal([...contractsImpl.JOB_TYPES].sort());
    });

    it('hub SYSTEM_JOB_TYPES stays equal to canonical SYSTEM_JOB_TYPES', () => {
        const hub = read(gpuHubPath);
        const m = hub.match(/SYSTEM_JOB_TYPES\s*=\s*\[([^\]]+)\]/);
        expect(m, 'hub SYSTEM_JOB_TYPES literal must exist').to.exist;
        const hubTypes = m[1].split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, ''));
        expect(hubTypes).to.deep.equal(contractsImpl.SYSTEM_JOB_TYPES);
        for (const t of hubTypes) {
            expect(contractsImpl.JOB_TYPES).to.include(t, 'hub transport type must be a canonical job type');
        }
    });

    it('protocol_version = 2 (contracts canonical; hub + worker consume it, no hub local literal)', () => {
        // Phase 10B: the hub consumes the canonical package via the compose
        // mount seam and carries NO local literal; the worker generated copy
        // still carries the frozen literal.
        const v = (src) => [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(v(read(CONTRACTS_IMPL_PATH)), 'contracts/src/job-protocol-v2.js').to.deep.equal([2]);
        expect(v(read(gpuHubPath)), 'gpu-hub/gpu-hub.js (Phase 10B: no local literal)').to.deep.equal([]);
        expect(v(read(path.join(WORKER_DIR, 'job-protocol-v2.cjs'))), 'worker/worker/job-protocol-v2.cjs (generated)').to.deep.equal([2]);
        // worker.cjs itself must have NO local literal (it consumes the copy)
        expect(v(read(workerPath)), 'worker/worker/worker.cjs (no local literal)').to.deep.equal([]);
    });

    it('frozen parse vectors behave identically in contracts and via the backend facade', () => {
        const vectors = [
            ['evening_city_demo_ch-ce87_sc-6c4e_0003:audio', { kind: 'audio_chunk', chapterId: 'ch-ce87', sceneId: 'sc-6c4e', chunkIndex: '0003' }],
            ['my_book_ch-1_sc-2_iu-abc:iu_image', { kind: 'iu_image', iuId: 'iu-abc' }],
            ['my_book_ch-1_sc-2_iu-abc:image', { kind: 'iu_image', iuId: 'iu-abc' }],
            ['my_book_ch-1_sc-2:image', { kind: 'scene_image' }],
            ['b_ch-1_sc-2_g3:video', { kind: 'scene_video', groupSuffix: '_g3' }],
            ['garbage', null],
            ['a_b_c:dungeon', null],
            ['', null],
            [null, null],
        ];
        for (const [input, expectation] of vectors) {
            expect(contractsImpl.parseJobId(input), `contracts.parseJobId(${JSON.stringify(input)})`).to.deep.equal(facade.parseJobId(input));
            if (expectation === null) {
                expect(contractsImpl.parseJobId(input)).to.equal(null);
            } else {
                expect(contractsImpl.parseJobId(input)).to.deep.include(expectation);
            }
        }
    });
});

// ── C7 — deployment wiring ───────────────────────────────────────────────
describe('Phase 9C: contracts deployment wiring', () => {
    it('backend compose service mounts the contracts package read-only', () => {
        const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
        expect(compose).to.include('./packages/animastor-contracts:/app/node_modules/@animastor/contracts:ro');
    });

    it('gpu-hub compose service carries NO contracts mount (Phase 10G: hub resolves the published registry package)', () => {
        // The hub installs @animastor/contracts from the npm registry
        // (Phase 10G); the Phase 10B compose mount was removed then. A
        // surviving mount would SHADOW the registry copy inside the hub
        // container and silently reintroduce the monorepo coupling.
        const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
        const hubSection = compose.slice(compose.indexOf('  gpu-hub:'), compose.indexOf('  nginx:'));
        expect(hubSection, 'contracts mount must NOT return in the gpu-hub service').to.not.include('@animastor/contracts');
    });
});

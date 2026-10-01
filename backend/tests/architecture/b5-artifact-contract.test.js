// ======================================================
// B5 — artifact contract (prep plan §2) pre-split guards
// ======================================================
// The full artifact scheme (GitHub Release assets + stager fetching them)
// lands POST-SPLIT, but the pre-split mechanics is already live and guarded
// here:
//   - packages/animastor-gpu-hub/artifacts.lock.json pins the exact content
//     (sha256_tree) of the 4 contract artifact groups (§2.2 matrix);
//   - the Dockerfile stager verifies the staged trees against the lock
//     BEFORE the runtime stage's `COPY --from=stager` (§2.3 checksum
//     invariant: mismatch = fail build);
//   - the lock is byte-fresh: recomputed digests must equal the committed
//     lock (double-entry bookkeeping — this test recomputes independently
//     of the writer tool).
//
// Static + digest checks only (no docker daemon needed in CI).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');
const LOCK_PATH = path.join(HUB_DIR, 'artifacts.lock.json');

const GROUPS = [
    {
        name: 'worker-bundle',
        stagedName: 'worker-bundle',
        source_repository: 'animastor-worker',
        walkRoot: path.join(REPO_ROOT, 'packages', 'animastor-worker', 'worker'),
        extraFiles: [],
    },
    {
        name: 'hub-workflows',
        stagedName: 'workflows',
        source_repository: 'animastor-backend',
        walkRoot: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
        extraFiles: [],
    },
    {
        name: 'installer-src',
        stagedName: 'installer-src',
        source_repository: 'animastor-backend',
        // Flattened staged layout: src/installer/* at group root + package.json.
        walkRoot: path.join(REPO_ROOT, 'packages', 'animastor-installer', 'src', 'installer'),
        extraFiles: [
            path.join(REPO_ROOT, 'packages', 'animastor-installer', 'package.json'),
        ],
    },
    {
        name: 'install-manifests',
        stagedName: 'install-manifests',
        source_repository: 'animastor-backend',
        walkRoot: path.join(REPO_ROOT, 'packages', 'animastor-installer', 'ai', 'install-manifests'),
        extraFiles: [],
    },
];

/** Independent digest implementation (deliberately NOT the writer tool). */
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function stagedDigest(group) {
    const rels = [];
    (function walk(dir, base) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = base ? `${base}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(full, rel); continue; }
            if (!entry.isFile()) continue;
            if (entry.name === 'package-lock.json') continue;
            rels.push(rel);
        }
    })(group.walkRoot, '');
    for (const abs of group.extraFiles) {
        rels.push(path.basename(abs));
    }
    // Canonical order = PATH sort (C locale), matching the lock writer and
    // the busybox staging gate — NOT a line sort (which would order by digest).
    rels.sort();
    const digestOf = new Map();
    for (const rel of rels) {
        const abs = group.extraFiles.find((a) => path.basename(a) === rel) || path.join(group.walkRoot, rel);
        digestOf.set(rel, sha256(fs.readFileSync(abs)));
    }
    const lines = rels.map((rel) => `${digestOf.get(rel)}  ${rel}`);
    return sha256(lines.join('\n') + '\n');
}

let lock;

describe('B5: artifact contract pre-split guards (prep plan §2)', () => {
    before(() => {
        lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    });

    it('artifacts.lock.json exists in the hub package and pins all 4 contract groups', () => {
        expect(fs.existsSync(LOCK_PATH), 'artifacts.lock.json missing').to.be.true;
        for (const g of GROUPS) {
            expect(lock.artifacts[g.name], `group ${g.name} missing from lock`).to.exist;
        }
        expect(Object.keys(lock.artifacts).sort()).to.deep.equal(
            ['hub-workflows', 'install-manifests', 'installer-src', 'worker-bundle']);
    });

    it('each lock entry carries the §2.1 contract fields (repo, tag, asset, version, sha256_tree)', () => {
        for (const g of GROUPS) {
            const entry = lock.artifacts[g.name];
            expect(entry.source_repository, `${g.name}.source_repository`).to.equal(g.source_repository);
            expect(entry.release_tag, `${g.name}.release_tag`).to.be.a('string').and.not.empty;
            expect(entry.asset_filename, `${g.name}.asset_filename`).to.be.a('string').and.not.empty;
            expect(entry.version, `${g.name}.version`).to.be.a('string').and.not.empty;
            expect(entry.sha256_tree, `${g.name}.sha256_tree`).to.match(/^[0-9a-f]{64}$/);
            expect(entry.files, `${g.name}.files`).to.be.a('number').and.above(0);
        }
    });

    it('committed lock digests match an INDEPENDENT recomputation of the source trees (double-entry)', () => {
        for (const g of GROUPS) {
            const actual = stagedDigest(g);
            expect(actual, `${g.name}: source tree drifted from artifacts.lock.json — run node tools/update-artifacts-lock.cjs and commit`)
                .to.equal(lock.artifacts[g.name].sha256_tree);
        }
    });

    it('worker-bundle version pin matches the canonical worker manifest (2.1.1)', () => {
        const workerPkg = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'packages', 'animastor-worker', 'worker', 'package.json'), 'utf8'));
        expect(lock.artifacts['worker-bundle'].version).to.equal(workerPkg.version);
        expect(lock.artifacts['worker-bundle'].release_tag).to.equal(`worker-bundle-v${workerPkg.version}`);
        expect(lock.artifacts['worker-bundle'].asset_filename).to.equal(`animastor-worker-bundle-${workerPkg.version}.zip`);
    });

    it('staging gate script exists, is executable, and consumes the lock (POSIX sh)', () => {
        const gate = path.join(HUB_DIR, 'scripts', 'verify-staged-artifacts.sh');
        expect(fs.existsSync(gate), 'verify-staged-artifacts.sh missing').to.be.true;
        expect(fs.statSync(gate).mode & 0o111, 'gate not executable').to.not.equal(0);
        const src = fs.readFileSync(gate, 'utf8');
        expect(src).to.include('sha256_tree');
        expect(src).to.not.match(/bash\b/); // busybox sh only (alpine stager)
        for (const g of GROUPS) expect(src).to.include(g.name);
    });

    it('Dockerfile verifies staged digests BEFORE COPY --from=stager (§2.3 invariant)', () => {
        const df = fs.readFileSync(path.join(HUB_DIR, 'Dockerfile'), 'utf8');
        const stagerIdx = df.indexOf('AS stager');
        const runtimeIdx = df.indexOf('FROM node:');
        const stager = df.slice(stagerIdx, runtimeIdx);
        // Gate runs inside the STAGER stage, not after the artifact COPY.
        expect(stager).to.include('verify-staged-artifacts.sh');
        expect(stager).to.include('artifacts.lock.json');
        expect(stager).to.include('COPY packages/animastor-gpu-hub/artifacts.lock.json');
        // The gate step must textually precede the runtime stage boundary —
        // i.e. the verification happens before /staging/artifacts is consumed.
        const gateRun = stager.indexOf('RUN sh /staging/verify-staged-artifacts.sh');
        const stagerCopies = stager.indexOf('COPY ${WORKER_BUNDLE_SRC}/');
        expect(gateRun, 'gate RUN not found in stager stage').to.be.above(stagerCopies);
    });

    it('gate fails on tampered staging tree (tamper resistance, executed)', () => {
        // Execute the real gate against a tampered copy of the staged trees.
        const os = require('os');
        const { execFileSync } = require('child_process');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-gate-'));
        try {
            for (const g of GROUPS) {
                fs.mkdirSync(path.join(tmp, g.stagedName), { recursive: true });
                fs.cpSync(g.walkRoot, path.join(tmp, g.stagedName), { recursive: true });
                const junk = path.join(tmp, g.stagedName, 'package-lock.json');
                if (fs.existsSync(junk)) fs.rmSync(junk);
            }
            for (const abs of GROUPS.find((x) => x.name === 'installer-src').extraFiles) {
                fs.copyFileSync(abs, path.join(tmp, 'installer-src', path.basename(abs)));
            }
            fs.copyFileSync(LOCK_PATH, path.join(tmp, 'artifacts.lock.json'));

            // 1) clean tree passes
            execFileSync('sh', [path.join(HUB_DIR, 'scripts', 'verify-staged-artifacts.sh'),
                path.join(tmp, 'artifacts.lock.json'), tmp], { stdio: 'pipe' });

            // 2) any byte flip must fail the gate
            fs.appendFileSync(path.join(tmp, 'workflows', 'img-qwen-image.json'), '\n// tampered\n');
            let failed = false;
            try {
                execFileSync('sh', [path.join(HUB_DIR, 'scripts', 'verify-staged-artifacts.sh'),
                    path.join(tmp, 'artifacts.lock.json'), tmp], { stdio: 'pipe' });
            } catch (_) { failed = true; }
            expect(failed, 'gate accepted a tampered artifact — integrity invariant broken').to.be.true;
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

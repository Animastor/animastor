// ======================================================
// GUARDRAIL — LAC legacy path guard (Phase 8D)
// ======================================================
// Phase 8C physically extracted the Local AI Connector from
// local-ai-connector/ into the standalone ai-connector package
// boundary (commit 0a5f6b78). This guard freezes that result:
// production/runtime code must never reference the legacy
// "local-ai-connector" path again (require/import specifier,
// path fragment, or quoted directory segment).
//
// Intentionally NOT banned (lookalikes that must keep working):
//   - 'local-ai-connector-binding'  — DB credential marker (compat)
//   - 'local-ai-connector-v1.md'    — historical planning-doc references
//
// Non-vacuous: a negative control materializes a real violation in a
// production root and proves the scan flags it. Docs:
// docs/architecture/PHASE_8_LAC_EXTRACTION_DESIGN.md.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./helpers');

// Structural roots only (no file lists) — resilient to repo evolution.
const PRODUCTION_ROOTS = [
    'backend/src',
    'gpu-hub',
    'worker/worker',
    'ai-connector',
    'frontends/app/src',
    'frontends/android/app/src',
    'scripts',
]
    .map((p) => path.join(REPO_ROOT, ...p.split('/')))
    .filter((p) => fs.existsSync(p));

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.kt', '.sh', '.py']);

// Standalone-token match: the legacy name not glued to another word or
// hyphen, so "-binding" / "-v1.md" compatibility markers stay allowed
// while any path-like usage ('.../local-ai-connector/...',
// 'local-ai-connector/lib/...', require('local-ai-connector'), quoted
// path.join segments) is caught.
const LEGACY_PATH_RE = /(?<![\w-])local-ai-connector(?![-\w])/;

function scanForLegacyPath(rootDir) {
    const offenders = [];
    if (!fs.existsSync(rootDir)) return offenders;
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
                const src = fs.readFileSync(full, 'utf8');
                if (LEGACY_PATH_RE.test(src)) offenders.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
            }
        }
    })(rootDir);
    return offenders;
}

const NEGATIVE_CONTROL_FILE = path.join(REPO_ROOT, 'backend', 'src', '__guard_negative_control__.cjs');

describe('architecture: LAC legacy path guard (Phase 8D)', () => {
    it('production/runtime code contains no reference to the legacy local-ai-connector path', () => {
        expect(PRODUCTION_ROOTS, 'expected production roots to exist (backend/src, gpu-hub, worker/worker, ai-connector, frontends)').to.have.lengthOf.at.least(4);
        const offenders = PRODUCTION_ROOTS.flatMap(scanForLegacyPath);
        expect(offenders, 'legacy "local-ai-connector" path reference found in production code. The connector lives at ai-connector/ since Phase 8C — update the reference (compat markers like local-ai-connector-binding / doc names stay allowed).').to.deep.equal([]);
    });

    it('negative control: the guard detects a reintroduced legacy path reference', function () {
        this.timeout(5000);
        let detected;
        try {
            fs.writeFileSync(NEGATIVE_CONTROL_FILE, "// synthetic violation for guard verification\nconst x = require('../../local-ai-connector/lib/connector.cjs');\nmodule.exports = { x };\n");
            detected = scanForLegacyPath(path.join(REPO_ROOT, 'backend', 'src'));
        } finally {
            if (fs.existsSync(NEGATIVE_CONTROL_FILE)) fs.rmSync(NEGATIVE_CONTROL_FILE, { force: true });
        }
        expect(detected).to.deep.equal(['backend/src/__guard_negative_control__.cjs']);
    });
});

// ======================================================
// VBOOK BUNDLE 3.1 — validator ↔ schema contract sync (audit A1)
// ======================================================
// Closes the Phase-1 open item "C1 JSON Schema pending": the schema at
// packages/animastor-vbook-runtime/schemas/vbook-bundle-3.1.schema.json is
// pinned to bundle-validator.cjs rule by rule. What the validator rejects,
// the schema rejects, and vice versa — with the documented strictness
// deltas explicitly baselined (see the schema description):
//   D1  manifest vbook_version/state/source — schema-strict enums; the
//       validator stays lenient (in-memory/legacy drafts); production
//       manifest writers are pinned below instead;
//   D2  unit-id grammar — schema-strict; the validator's unit scan is
//       currently a no-op (its collect filter pre-selects matching ids),
//       recorded as a conscious validator gap, NOT silently drifted;
//   D3  JSON-serializability (NaN/circular) — validator-side pre-write
//       hardening; unexpressable in a schema of parsed JSON.
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md §4.2,
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./helpers');

const SCHEMA_PATH = path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime', 'schemas', 'vbook-bundle-3.1.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const validator = require('@animastor/vbook-runtime/bundle-validator.cjs');

// ── Minimal JSON Schema evaluator (draft 2020-12 subset used by the file) ─
function resolveRef(ref) {
    expect(ref.startsWith('#/$defs/'), `unsupported $ref: ${ref}`).to.equal(true);
    return schema.$defs[ref.slice('#/$defs/'.length)];
}

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function checkType(v, t) {
    const types = Array.isArray(t) ? t : [t];
    return types.some((one) => {
        if (one === 'integer') return typeof v === 'number' && Number.isInteger(v);
        if (one === 'number') return typeof v === 'number' && Number.isFinite(v);
        return typeOf(v) === one;
    });
}

function validates(node, value) {
    if (node === true) return true;
    if (node === false) return false;
    if (node.$ref) return validates(resolveRef(node.$ref), value);
    if (node.anyOf) return node.anyOf.some((sub) => validates(sub, value));
    if (node.not) return !validates(node.not, value);
    if ('const' in node) return JSON.stringify(value) === JSON.stringify(node.const);
    if (node.enum) return node.enum.some((opt) => JSON.stringify(opt) === JSON.stringify(value));
    if (node.type) {
        if (!checkType(value, node.type)) return false;
    }
    if (typeOf(value) === 'string') {
        if (node.pattern && !(new RegExp(node.pattern)).test(value)) return false;
        if (typeof node.minLength === 'number' && value.length < node.minLength) return false;
    }
    if (typeOf(value) === 'array') {
        if (node.items && !value.every((item) => validates(node.items, item))) return false;
    }
    if (typeOf(value) === 'object') {
        for (const key of node.required || []) {
            if (!(key in value)) return false;
        }
        for (const [key, sub] of Object.entries(node.properties || {})) {
            if (key in value && !validates(sub, value[key])) return false;
        }
        if (node.additionalProperties && typeof node.additionalProperties === 'object') {
            const declared = new Set(Object.keys(node.properties || {}));
            for (const [key, item] of Object.entries(value)) {
                if (!declared.has(key) && !validates(node.additionalProperties, item)) return false;
            }
        }
    }
    return true;
}

function schemaRejects(value) {
    return !validates(schema, value);
}

// ── Shared fixture base (matches the in-memory post-build bundle shape) ──
function baseBundle() {
    return {
        manifest: { book_id: 'b1' },
        book: null,
        locations: {},
        voices: {},
        behaviors: {},
        characters: [],
    };
}

function validatorVerdict(bundle) {
    return validator.validateBundleObject(bundle).valid;
}

describe('vbook-bundle-3.1: schema exists and mirrors the validator (audit A1)', () => {
    it('the canonical schema file is present in the future package', () => {
        expect(fs.existsSync(SCHEMA_PATH), 'vbook-bundle-3.1.schema.json must exist before the physical move').to.equal(true);
        expect(schema.$id).to.include('vbook-bundle-3.1');
    });

    // Two-way equivalence battery: every probe mutates one rule family.
    const PROBES = [
        ['manifest missing', (b) => { delete b.manifest; }],
        ['manifest not an object', (b) => { b.manifest = 'x'; }],
        ['manifest.book_id missing', (b) => { delete b.manifest.book_id; }],
        ['manifest.book_id not a string', (b) => { b.manifest.book_id = 42; }],
        ['manifest.book_id empty', (b) => { b.manifest.book_id = ''; }],
        ['book.json null (lazy flow tolerated)', (b) => { b.book = null; }],
        ['book.json not an object', (b) => { b.book = 'x'; }],
        ['book.structure not an object', (b) => { b.book = { structure: 'x' }; }],
        ['chapters_order is a string', (b) => { b.book = { structure: { chapters_order: 'x' } }; }],
        ['chapters_order has non-string', (b) => { b.book = { structure: { chapters_order: ['a', 5] } }; }],
        ['locations missing', (b) => { delete b.locations; }],
        ['locations is an array', (b) => { b.locations = []; }],
        ['locations is null', (b) => { b.locations = null; }],
        ['voices missing', (b) => { delete b.voices; }],
        ['voices entry not an object', (b) => { b.voices = { v1: 'x' }; }],
        ['voices.instruction not a string', (b) => { b.voices = { v1: { instruction: 5 } }; }],
        ['behaviors is a string', (b) => { b.behaviors = 'x'; }],
        ['characters missing', (b) => { delete b.characters; }],
        ['characters is an object', (b) => { b.characters = {}; }],
        ['characters entry not an object', (b) => { b.characters = [{ id: 'a' }, 'oops']; }],
        ['chapters missing (optional)', (b) => { delete b.chapters; }],
        ['chapters is a string', (b) => { b.chapters = 'x'; }],
        ['chapter not an object', (b) => { b.chapters = ['x']; }],
        ['chapter_id bad grammar', (b) => { b.chapters = [{ chapter_id: 'ch-XYZ', scenes: [] }]; }],
        ['chapter_id is a number (validator tolerates non-strings)', (b) => { b.chapters = [{ chapter_id: 123, scenes: [] }]; }],
        ['scenes is a string', (b) => { b.chapters = [{ scenes: 'x' }]; }],
        ['scene not an object', (b) => { b.chapters = [{ scenes: ['x'] }]; }],
        ['scene_id bad grammar', (b) => { b.chapters = [{ scenes: [{ scene_id: 'sc-zz' }] }]; }],
        ['participants is a string', (b) => { b.chapters = [{ scenes: [{ participants: 'a' }] }]; }],
        ['participants has an empty string', (b) => { b.chapters = [{ scenes: [{ participants: ['ok', ''] }] }]; }],
    ];

    PROBES.forEach(([name, mutate]) => {
        it(`two-way sync: "${name}"`, () => {
            const bundle = baseBundle();
            mutate(bundle);
            const validatorValid = validatorVerdict(bundle);
            const schemaValid = !schemaRejects(bundle);
            expect(validatorValid, `validator verdict for "${name}"`).to.equal(schemaValid, `schema verdict for "${name}"`);
        });
    });

    it('the canonical bundle passes both sides', () => {
        const bundle = baseBundle();
        bundle.book = { book_id: 'b1', version: '3.0', structure: { chapters_order: ['chapters/ch-000001.json'] } };
        bundle.chapters = [{
            chapter_id: 'ch-000001',
            scenes: [{ scene_id: 'sc-000001', participants: ['c1', 'c2'], units: [{ id: 'iu-000001' }] }],
        }];
        expect(validatorVerdict(bundle)).to.equal(true);
        expect(schemaRejects(bundle)).to.equal(false);
    });

    // ── D1 — schema-strict manifest production fields ────────────────────
    describe('documented delta D1: manifest production fields (schema-strict, producer-pinned)', () => {
        it('schema rejects a wrong vbook_version / state / source value the validator tolerates', () => {
            const bundle = baseBundle();
            bundle.manifest.vbook_version = '3.0';
            expect(validatorVerdict(bundle), 'validator is lenient by design (legacy bundles)').to.equal(true);
            expect(schemaRejects(bundle), 'schema freezes the production contract').to.equal(true);
        });

        it('producers emit vbook_version 3.1 with enum-conforming state/source', () => {
            const draftSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime', 'src', 'lazy-book', 'draft.js'), 'utf8');
            expect(draftSrc).to.match(/vbook_version:\s*'3\.1'/);
            expect(draftSrc).to.match(/source:\s*sourceType/);
            expect(draftSrc).to.match(/state:\s*BookState\.RAW_IMPORTED/);
            const crudSrc = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'routes', 'book', 'entity-crud-routes.cjs'), 'utf8');
            expect(crudSrc).to.match(/vbook_version:\s*'3\.1'/);
        });

        it('constants enums stay in sync with the schema enums', () => {
            const constants = require('@animastor/vbook-runtime/lazy-book/constants');
            expect(Object.values(constants.BookState).sort()).to.deep.equal([...schema.$defs.manifest.properties.state.enum].sort());
            expect(Object.values(constants.SourceType).sort()).to.deep.equal([...schema.$defs.manifest.properties.source.enum].sort());
        });
    });

    // ── D2 — unit-id grammar (validator gap pinned, not drifted) ─────────
    describe('documented delta D2: unit-id grammar is schema-strict', () => {
        it('the validator unit scan is currently a no-op (pinned as a conscious gap)', () => {
            const bundle = baseBundle();
            bundle.chapters = [{ scenes: [{ units: [{ id: 'iu-ZZ' }] }] }];
            expect(validatorVerdict(bundle)).to.equal(true);
            expect(schemaRejects(bundle)).to.equal(true);
        });
    });
});

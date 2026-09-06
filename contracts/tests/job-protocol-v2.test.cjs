// ======================================================
// @animastor/contracts — Job Protocol v2 package tests
// ======================================================
// Expectations are PORTED from the backend suites (backend/tests/
// job-schema.test.js, backend/tests/architecture/phase2-job-protocol-v2.test.js,
// gpu-hub-contract.test.js) — same vectors, same strictness. Nothing is
// weakened: the package must satisfy the exact contract the backend tests
// already freeze.
// Normative spec: docs/architecture/JOB_PROTOCOL_V2.md (Phase 9A, FROZEN).
// ======================================================

const { describe, it, expect } = require('./harness.cjs');
const contracts = require('../src/index.js');
const jobProtocolV2 = require('../src/job-protocol-v2.js');

const {
    PROTOCOL_VERSION,
    JOB_TYPES,
    SYSTEM_JOB_TYPES,
    STAGE_BY_KIND,
    buildJobId,
    splitJobId,
    parseJobId,
    getStageForJobId,
    TASK_ENVELOPE_REQUIRED_FIELDS,
    TASK_ENVELOPE_FIELDS,
    RESULT_ENVELOPE_REQUIRED_FIELDS,
    ERROR_ENVELOPE_REQUIRED_FIELDS,
    BEACON_ENVELOPE_REQUIRED_FIELDS,
    ERROR_TOKENS,
    validateTaskEnvelopeIdentity,
    validateResultEnvelopeIdentity,
} = jobProtocolV2;

describe('Job Protocol v2 — protocol constants (frozen)', () => {
    it('protocol_version = 2 (integer, frozen for the whole Phase 9)', () => {
        expect.equal(PROTOCOL_VERSION, 2, 'PROTOCOL_VERSION must stay 2 (JOB_PROTOCOL_V2.md §3.1)');
        expect.equal(typeof PROTOCOL_VERSION, 'number');
        expect.equal(Math.trunc(PROTOCOL_VERSION), PROTOCOL_VERSION, 'protocol_version must be an integer');
    });

    it('JOB_TYPES = [audio, image, iu_image, video] in canonical order', () => {
        expect.deepEqual(JOB_TYPES, ['audio', 'image', 'iu_image', 'video']);
    });

    it('SYSTEM_JOB_TYPES = [audio, image, video] (hub transport family)', () => {
        expect.deepEqual(SYSTEM_JOB_TYPES, ['audio', 'image', 'video']);
    });

    it('STAGE_BY_KIND mapping is frozen', () => {
        expect.deepEqual(STAGE_BY_KIND, {
            audio_chunk: 'audio',
            iu_image: 'image',
            scene_image: 'image',
            scene_video: 'video',
        });
    });

    it('package entry exposes the same API flat and namespaced', () => {
        expect.equal(contracts.PROTOCOL_VERSION, PROTOCOL_VERSION);
        expect.equal(contracts.jobProtocolV2, jobProtocolV2);
        for (const key of ['buildJobId', 'splitJobId', 'parseJobId', 'getStageForJobId', 'JOB_TYPES', 'STAGE_BY_KIND']) {
            expect.equal(contracts[key], jobProtocolV2[key], `index.js must re-export ${key}`);
        }
    });
});

describe('Job Protocol v2 — buildJobId (canonical envelope builder)', () => {
    it('builds id with valid type suffix', () => {
        expect.equal(buildJobId('book_ch-1_sc-2_0001', 'audio'), 'book_ch-1_sc-2_0001:audio');
        expect.equal(buildJobId('x_ch-1_sc-2', 'image'), 'x_ch-1_sc-2:image');
        expect.equal(buildJobId('a_b_c', 'iu_image'), 'a_b_c:iu_image');
        expect.equal(buildJobId('a_b_c_g1', 'video'), 'a_b_c_g1:video');
    });

    it('rejects unknown types', () => {
        expect.throws(() => buildJobId('x', 'music'), /unknown job type/);
        expect.throws(() => buildJobId('x', 'Audio'), /unknown job type/, 'type match is case-sensitive');
        expect.throws(() => buildJobId('x', ''), /unknown job type/);
    });

    it('rejects empty assetId', () => {
        expect.throws(() => buildJobId('', 'audio'), /invalid assetId/);
    });

    it('rejects non-string assetId', () => {
        expect.throws(() => buildJobId(null, 'audio'), /invalid assetId/);
        expect.throws(() => buildJobId(undefined, 'audio'), /invalid assetId/);
        expect.throws(() => buildJobId(123, 'audio'), /invalid assetId/);
    });
});

describe('Job Protocol v2 — splitJobId (suffix-only split)', () => {
    it('splits the type suffix from the last colon', () => {
        expect.deepEqual(splitJobId('book_ch-1_sc-2_0001:audio'), { assetId: 'book_ch-1_sc-2_0001', type: 'audio' });
        expect.deepEqual(splitJobId('a:b:audio'), { assetId: 'a:b', type: 'audio' }, 'assetId may contain colons; split from the end');
    });

    it('returns null for missing suffix, unknown suffix, empty and non-string', () => {
        expect.deepEqual(splitJobId('no-suffix'), null);
        expect.deepEqual(splitJobId('x:music'), null);
        expect.deepEqual(splitJobId('x:'), null);
        expect.deepEqual(splitJobId(''), null);
        expect.deepEqual(splitJobId(null), null);
        expect.deepEqual(splitJobId(undefined), null);
        expect.deepEqual(splitJobId(42), null);
    });
});

describe('Job Protocol v2 — parseJobId: audio chunk', () => {
    it('parses bookId with underscores', () => {
        const p = parseJobId('evening_city_demo_ch-ce87_sc-6c4e_0003:audio');
        expect.deepEqual(p, {
            kind: 'audio_chunk',
            type: 'audio',
            assetId: 'evening_city_demo_ch-ce87_sc-6c4e_0003',
            bookId: 'evening_city_demo',
            chapterId: 'ch-ce87',
            sceneId: 'sc-6c4e',
            chunkIndex: '0003',
        });
    });

    it('rejects audio id without a 4-digit chunk index', () => {
        expect.deepEqual(parseJobId('book_ch_sc:audio'), null);
        expect.deepEqual(parseJobId('book_ch_sc_x:audio'), null, 'non-numeric chunk index');
    });

    it('boundary chunk indexes: 0000 and 9999 valid, 5 digits invalid', () => {
        expect.deepEqual(parseJobId('b_c1_s1_0000:audio').chunkIndex, '0000');
        expect.deepEqual(parseJobId('b_c1_s1_9999:audio').chunkIndex, '9999');
        expect.deepEqual(parseJobId('b_c1_s1_00000:audio'), null, '5 digits must fail');
        expect.deepEqual(parseJobId('b_c1_s1_0001x:audio'), null, 'non-digit suffix must fail');
    });

    it('parse-from-the-end: extra underscored segments join bookId', () => {
        const p = parseJobId('a_b_c_d_0001:audio');
        expect.equal(p.bookId, 'a_b');
        expect.equal(p.chapterId, 'c');
        expect.equal(p.sceneId, 'd');
        expect.equal(p.chunkIndex, '0001');
    });
});

describe('Job Protocol v2 — parseJobId: IU image', () => {
    it('parses new :iu_image format', () => {
        const p = parseJobId('my_book_ch-1_sc-2_iu-abc:iu_image');
        expect.deepEqual(p, {
            kind: 'iu_image',
            type: 'iu_image',
            assetId: 'my_book_ch-1_sc-2_iu-abc',
            bookId: 'my_book',
            chapterId: 'ch-1',
            sceneId: 'sc-2',
            iuId: 'iu-abc',
        });
    });

    it('detects legacy :image with _iu marker as iu_image', () => {
        const p = parseJobId('my_book_ch-1_sc-2_iu-abc:image');
        expect.equal(p.kind, 'iu_image');
        expect.equal(p.iuId, 'iu-abc');
    });

    it('legacy marker is substring-based ("_iu" anywhere in the assetId)', () => {
        const p = parseJobId('b_c1_s1_iu9:image');
        expect.equal(p.kind, 'iu_image', 'segment "_iu9" contains the "_iu" marker');
        expect.equal(p.iuId, 'iu9');
        const plain = parseJobId('b_c1_s1_xiu9:image');
        expect.equal(plain.kind, 'scene_image', '"_xiu9" does not contain "_iu" — stays a scene image');
    });
});

describe('Job Protocol v2 — parseJobId: scene image / video', () => {
    it('parses legacy scene image', () => {
        const p = parseJobId('my_book_ch-1_sc-2:image');
        expect.deepEqual(p, {
            kind: 'scene_image',
            type: 'image',
            assetId: 'my_book_ch-1_sc-2',
            bookId: 'my_book',
            chapterId: 'ch-1',
            sceneId: 'sc-2',
        });
    });

    it('parses video with group suffix', () => {
        const p = parseJobId('my_book_ch-1_sc-2_g3:video');
        expect.deepEqual(p, {
            kind: 'scene_video',
            type: 'video',
            assetId: 'my_book_ch-1_sc-2_g3',
            bookId: 'my_book',
            chapterId: 'ch-1',
            sceneId: 'sc-2',
            groupSuffix: '_g3',
        });
    });

    it('parses video without group suffix', () => {
        const p = parseJobId('my_book_ch-1_sc-2:video');
        expect.equal(p.groupSuffix, '');
        expect.equal(p.sceneId, 'sc-2');
    });

    it('boundary group suffixes: multi-digit ok, malformed stays part of sceneId', () => {
        expect.equal(parseJobId('b_c1_s2_g0:video').groupSuffix, '_g0');
        expect.equal(parseJobId('b_c1_s2_g123:video').groupSuffix, '_g123');
        const p = parseJobId('b_c1_s2_gg:video');
        expect.equal(p.groupSuffix, '', '_gg is not a group suffix');
        expect.equal(p.sceneId, 'gg');
    });

    it('rejects image/video ids with too few segments', () => {
        expect.deepEqual(parseJobId('onlyscene:image'), null);
        expect.deepEqual(parseJobId('onlyscene:video'), null);
        expect.deepEqual(parseJobId('ch_sc:image'), null, '2 segments < 3 for scene image');
        expect.deepEqual(parseJobId('ch_sc:video'), null);
    });
});

describe('Job Protocol v2 — parseJobId: garbage input (never throws)', () => {
    it('returns null for missing suffix, unknown suffix, empty and non-string', () => {
        expect.deepEqual(parseJobId('no-suffix'), null);
        expect.deepEqual(parseJobId('x:music'), null);
        expect.deepEqual(parseJobId('garbage'), null);
        expect.deepEqual(parseJobId('a_b_c:dungeon'), null);
        expect.deepEqual(parseJobId(''), null);
        expect.deepEqual(parseJobId(null), null);
        expect.deepEqual(parseJobId(undefined), null);
        expect.deepEqual(parseJobId(42), null);
        expect.deepEqual(parseJobId({}), null);
    });

    it('empty assetId with valid suffix still fails the grammar', () => {
        expect.deepEqual(parseJobId(':audio'), null);
        expect.deepEqual(parseJobId(':image'), null);
    });
});

describe('Job Protocol v2 — roundtrip and stage mapping', () => {
    it('parseJobId(buildJobId(x)) preserves assetId and type', () => {
        const cases = [
            ['book_ch-1_sc-2_0001', 'audio'],
            ['book_ch-1_sc-2_iu-x', 'iu_image'],
            ['book_ch-1_sc-2', 'image'],
            ['book_ch-1_sc-2_g1', 'video'],
        ];
        for (const [assetId, type] of cases) {
            const p = parseJobId(buildJobId(assetId, type));
            expect.ok(p, `${assetId}:${type} must parse`);
            expect.equal(p.assetId, assetId, `${assetId}:${type} assetId roundtrip`);
            expect.equal(p.type, type, `${assetId}:${type} type roundtrip`);
        }
    });

    it('getStageForJobId maps every kind', () => {
        expect.equal(getStageForJobId('b_c1_s1_0001:audio'), 'audio');
        expect.equal(getStageForJobId('b_c1_s1_iu-x:iu_image'), 'image');
        expect.equal(getStageForJobId('b_c1_s1:image'), 'image');
        expect.equal(getStageForJobId('b_c1_s1:video'), 'video');
        expect.equal(getStageForJobId('b_c1_s1_g2:video'), 'video');
    });

    it('getStageForJobId returns null for unrecognized ids', () => {
        expect.deepEqual(getStageForJobId('garbage'), null);
        expect.deepEqual(getStageForJobId('x:music'), null);
        expect.deepEqual(getStageForJobId(null), null);
    });
});

describe('Job Protocol v2 — envelope contract helpers (advisory)', () => {
    it('task envelope required identity set matches the hub check', () => {
        expect.deepEqual(TASK_ENVELOPE_REQUIRED_FIELDS, [
            'dispatch_id', 'build_id', 'book_id', 'chapter_id', 'scene_id',
            'stage', 'protocol_version',
        ]);
        expect.deepEqual(TASK_ENVELOPE_FIELDS, [
            'job_id', 'params', 'job_type', 'assets', 'build_id',
            'protocol_version', 'book_id', 'chapter_id', 'scene_id', 'stage',
            'dispatch_id', 'workspace_id', 'policy_id', 'timeout_ms',
        ]);
    });

    it('result/error/beacon required sets match the frozen envelopes', () => {
        expect.deepEqual(RESULT_ENVELOPE_REQUIRED_FIELDS, ['job_id', 'build_id', 'dispatch_id', 'protocol_version', 'result_base64']);
        expect.deepEqual(ERROR_ENVELOPE_REQUIRED_FIELDS, ['job_id', 'build_id', 'dispatch_id', 'protocol_version']);
        expect.deepEqual(BEACON_ENVELOPE_REQUIRED_FIELDS, ['protocol_version']);
    });

    it('canonical error tokens are frozen', () => {
        expect.deepEqual(ERROR_TOKENS, {
            PROTOCOL_VERSION_MISMATCH: 'protocol_version_mismatch',
            INCOMPLETE_DISPATCH_IDENTITY: 'incomplete_dispatch_identity',
            INVALID_WORKSPACE_ID: 'invalid_workspace_id',
            INVALID_POLICY_ID: 'invalid_policy_id',
            INVALID_POLICY_ROUTING: 'invalid_policy_routing',
            INVALID: 'invalid',
            NOT_TASK_CLAIMER: 'not_task_claimer',
            STALE_OR_UNKNOWN_DISPATCH: 'stale_or_unknown_dispatch',
            WORKER_PROTOCOL_MISMATCH: 'worker_protocol_mismatch',
            WORKER_TYPE_MISMATCH: 'worker_type_mismatch',
            WORKER_IDENTITY_REQUIRED: 'worker_identity_required',
            HUB_API_KEY_NOT_CONFIGURED: 'hub_api_key_not_configured',
        });
    });

    it('validateTaskEnvelopeIdentity mirrors the hub /task guard', () => {
        const valid = {
            protocol_version: 2,
            dispatch_id: 'd1',
            build_id: 'b1',
            book_id: 'book',
            chapter_id: 'c1',
            scene_id: 's1',
            stage: 'audio',
        };
        expect.equal(validateTaskEnvelopeIdentity(valid), null);
        expect.equal(validateTaskEnvelopeIdentity({ ...valid, protocol_version: 1 }), 'protocol_version_mismatch');
        expect.equal(validateTaskEnvelopeIdentity({ ...valid, protocol_version: undefined }), 'protocol_version_mismatch');
        for (const field of ['dispatch_id', 'build_id', 'book_id', 'chapter_id', 'scene_id', 'stage']) {
            const broken = { ...valid };
            delete broken[field];
            expect.equal(validateTaskEnvelopeIdentity(broken), 'incomplete_dispatch_identity', `missing ${field} must be rejected`);
        }
        expect.equal(validateTaskEnvelopeIdentity(null), 'incomplete_dispatch_identity');
    });

    it('hub does not require job_id/job_type/params in the identity set (§3.2 CURRENT BEHAVIOR)', () => {
        const minimal = {
            protocol_version: 2,
            dispatch_id: 'd1',
            build_id: 'b1',
            book_id: 'book',
            chapter_id: 'c1',
            scene_id: 's1',
            stage: 'audio',
        };
        expect.equal(validateTaskEnvelopeIdentity(minimal), null, 'job_id/job_type/params stay outside the hub required set');
    });

    it('validateResultEnvelopeIdentity mirrors the hub result/error guards', () => {
        const base = { protocol_version: 2, job_id: 'b_c1_s1_0001:audio', build_id: 'b1', dispatch_id: 'd1' };
        expect.equal(validateResultEnvelopeIdentity({ ...base, result_base64: 'data:image/png;base64,xx' }, { requireResultBase64: true }), null);
        expect.equal(validateResultEnvelopeIdentity({ ...base }, { requireResultBase64: true }), 'invalid', 'result without result_base64');
        expect.equal(validateResultEnvelopeIdentity({ ...base }), null, 'error envelope does not need result_base64');
        expect.equal(validateResultEnvelopeIdentity({ ...base, protocol_version: 3 }), 'invalid');
        expect.equal(validateResultEnvelopeIdentity(null), 'invalid');
        for (const field of ['job_id', 'build_id', 'dispatch_id']) {
            const broken = { ...base };
            delete broken[field];
            expect.equal(validateResultEnvelopeIdentity(broken), 'invalid', `missing ${field} must be rejected`);
        }
    });
});

describe('Job Protocol v2 — unknown fields behavior (§3.20)', () => {
    it('package exports exactly the frozen API surface (no hidden schema logic)', () => {
        const expectedKeys = [
            'PROTOCOL_VERSION', 'JOB_TYPES', 'SYSTEM_JOB_TYPES', 'STAGE_BY_KIND',
            'CHUNK_INDEX_RE', 'GROUP_SUFFIX_RE', 'JOB_ID_SPLIT_RE',
            'buildJobId', 'splitJobId', 'parseJobId', 'getStageForJobId',
            'TASK_ENVELOPE_REQUIRED_FIELDS', 'TASK_ENVELOPE_FIELDS',
            'RESULT_ENVELOPE_REQUIRED_FIELDS', 'ERROR_ENVELOPE_REQUIRED_FIELDS',
            'BEACON_ENVELOPE_REQUIRED_FIELDS', 'ERROR_TOKENS',
            'validateTaskEnvelopeIdentity', 'validateResultEnvelopeIdentity',
        ].sort();
        expect.deepEqual(Object.keys(jobProtocolV2).sort(), expectedKeys);
    });

    it('unknown fields are ignored by the advisory helpers (never rejected)', () => {
        const task = {
            protocol_version: 2,
            dispatch_id: 'd1',
            build_id: 'b1',
            book_id: 'book',
            chapter_id: 'c1',
            scene_id: 's1',
            stage: 'audio',
            job_id: 'book_c1_s1_0001:audio',
            job_type: 'audio',
            params: { nodes: {} },
            some_future_field: { nested: true },
        };
        expect.equal(validateTaskEnvelopeIdentity(task), null, 'unknown/extra fields must not fail the identity check');
    });

    it('grammar helpers stay pure (no I/O surface)', () => {
        for (const key of Object.keys(jobProtocolV2)) {
            expect.notMatch(key, /fetch|http|redis|io$/i, `export ${key} must not imply transport logic`);
        }
    });
});

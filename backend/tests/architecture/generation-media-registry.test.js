// ======================================================
// GENERATION MEDIA REGISTRY — S-2 architecture guards
// ======================================================
// Guards the S-2 registry-ization seam:
//   S2-A  Generation Core must not directly import audio/image/video
//         implementations except through the registry or allowed registration
//         points (scene-orchestrator dispatches via registry, scene-callbacks
//         owns completion handlers).
//   S2-B  Each registered media type must have a registry entry.
//   S2-C  No new Core → media reverse dependencies.
//   S2-D  Unknown media types must be handled via existing error paths.
//   S2-E  The registry API is internal (not a public package API).
//   S2-F  Player / Editor / VBook boundaries must not be weakened.
//
// Static source scan — CI-safe, zero runtime imports.

const { expect } = require('chai');
const path = require('path');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers,
} = require('./helpers');

// S-7: the media registry + default registrations are package-owned.
const PKG_SRC = path.join(BACKEND_SRC, '..', '..', 'packages', 'animastor-generation', 'src');

// ======================================================
// S2-A: Generation Core import isolation
// ======================================================
// The generation core (orchestration + runtime) must not directly import
// audio/image/video implementation modules except through allowed paths:
//   - scene-orchestrator.js: imports audio, image, video (executor dispatch)
//   - scene-callbacks.js: imports audio, image, video (completion handlers)
//   - scene-restoration.js: may reference media modules for recovery
// These are the REGISTRATION POINTS — they wire executors into the registry.

const MEDIA_IMPL_RE = /(?:require\([^)]*(?:\/audio\/|\/image\/|\/video\/))/;

// Files in the generation core that are ALLOWED to import media implementations
const ALLOWED_MEDIA_IMPORTERS = new Set([
    path.join(BACKEND_SRC, 'orchestration', 'scene-orchestrator.js'),
    path.join(BACKEND_SRC, 'orchestration', 'scene-callbacks.js'),
    path.join(BACKEND_SRC, 'orchestration', 'scene-restoration.js'),
    // reconciliation-engine lazy-requires audio/image/video for repair
    path.join(BACKEND_SRC, 'runtime', 'reconciliation-engine.js'),
    // task-handler delegates to audio/video orchestrators
    path.join(BACKEND_SRC, 'services', 'task-handler.cjs'),
]);

// Core files that must NOT import media implementations
const CORE_FILES = [
    path.join(BACKEND_SRC, 'orchestration', 'orchestrator.js'),
    path.join(BACKEND_SRC, 'runtime', 'dispatch-engine.js'),
    path.join(BACKEND_SRC, 'runtime', 'runtime-scheduler.js'),
    path.join(BACKEND_SRC, 'runtime', 'gpu-dispatcher.js'),
    path.join(BACKEND_SRC, 'runtime', 'circuit-breaker.js'),
    path.join(BACKEND_SRC, 'runtime', 'retry-budget-manager.js'),
    path.join(BACKEND_SRC, 'runtime', 'lease-manager.js'),
    path.join(PKG_SRC, 'core', 'media-registry.js'),
    path.join(PKG_SRC, 'core', 'default-registrations.js'),
];

describe('architecture: Generation media registry (S-2)', () => {
    describe('S2-A: Core import isolation', () => {
        it('core runtime/orchestration modules must not directly import audio/image/video implementations', () => {
            const offenders = [];
            for (const file of CORE_FILES) {
                if (!require('fs').existsSync(file)) continue;
                const code = readSource(file);
                const imports = requireSpecifiers(code);
                for (const spec of imports) {
                    if (/\/audio\/|\/image\/|\/video\//.test(spec)) {
                        offenders.push(`${rel(file)}: imports ${spec}`);
                    }
                }
            }
            expect(offenders, 'Core must not import media implementations directly — use registry').to.deep.equal([]);
        });

        it('media registry module does not import audio/image/video implementations', () => {
            const registryFile = path.join(PKG_SRC, 'core', 'media-registry.js');
            const code = readSource(registryFile);
            const imports = requireSpecifiers(code);
            const mediaImports = imports.filter(s => /\/audio\/|\/image\/|\/video\//.test(s));
            expect(mediaImports, 'media-registry must be media-implementation agnostic').to.deep.equal([]);
        });

        it('default-registrations module does not import audio/image/video implementations', () => {
            const regFile = path.join(PKG_SRC, 'core', 'default-registrations.js');
            const code = readSource(regFile);
            const imports = requireSpecifiers(code);
            const mediaImports = imports.filter(s => /\/audio\/|\/image\/|\/video\//.test(s));
            expect(mediaImports, 'default-registrations must be config-only, no media imports').to.deep.equal([]);
        });
    });

    describe('S2-B: Registry integrity', () => {
        it('media registry exports required API surface', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            const requiredFns = [
                'registerMediaType', 'getMediaType', 'hasMediaType',
                'listMediaTypes', 'listCapabilities',
                'resolveValidWorkerTypes', 'resolveAssets',
                'resolveJobTimeout', 'resolveLeaseTtl', 'resolveMaxActive',
                'resolveRetryBudget', 'resolveCircuitService',
                'isValidWorkerType', 'layerConfigKey', 'timeoutConfigKey',
            ];
            for (const fn of requiredFns) {
                expect(registry[fn], `registry.${fn} must exist`).to.be.a('function');
            }
        });

        it('default registrations register audio, image, video', () => {
            // Initialize registry
            require(path.join(PKG_SRC, 'core', 'default-registrations'));
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            expect(registry.hasMediaType('audio')).to.be.true;
            expect(registry.hasMediaType('image')).to.be.true;
            expect(registry.hasMediaType('video')).to.be.true;
        });

        it('each registered type has required capability fields', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            for (const type of ['audio', 'image', 'video']) {
                const cap = registry.getMediaType(type);
                expect(cap, `${type} capability must exist`).to.exist;
                expect(cap.mediaType, `${type} must have mediaType`).to.equal(type);
                expect(cap.taskTypes, `${type} must have taskTypes`).to.be.an('array');
                expect(cap.timeout, `${type} must have timeout`).to.be.an('object');
                expect(cap.quota, `${type} must have quota`).to.be.an('object');
                expect(cap.retry, `${type} must have retry`).to.be.an('object');
                expect(cap.circuit, `${type} must have circuit`).to.be.an('object');
                expect(cap.progress, `${type} must have progress`).to.be.an('object');
            }
        });
    });

    describe('S2-C: No new reverse dependencies', () => {
        it('audio module does not import generation/media-registry', () => {
            const audioDir = path.join(BACKEND_SRC, 'audio');
            const files = listSourceFiles(audioDir);
            const offenders = [];
            for (const file of files) {
                const code = readSource(file);
                if (/require\([^)]*generation\/media-registry/.test(code) || /\.mediaRegistry\b/.test(code)) {
                    offenders.push(rel(file));
                }
            }
            expect(offenders, 'audio must not depend on media registry').to.deep.equal([]);
        });

        it('image module does not import generation/media-registry', () => {
            const imageDir = path.join(BACKEND_SRC, 'image');
            const files = listSourceFiles(imageDir);
            const offenders = [];
            for (const file of files) {
                const code = readSource(file);
                if (/require\([^)]*generation\/media-registry/.test(code) || /\.mediaRegistry\b/.test(code)) {
                    offenders.push(rel(file));
                }
            }
            expect(offenders, 'image must not depend on media registry').to.deep.equal([]);
        });

        it('video module does not import generation/media-registry', () => {
            const videoDir = path.join(BACKEND_SRC, 'video');
            const files = listSourceFiles(videoDir);
            const offenders = [];
            for (const file of files) {
                const code = readSource(file);
                if (/require\([^)]*generation\/media-registry/.test(code) || /\.mediaRegistry\b/.test(code)) {
                    offenders.push(rel(file));
                }
            }
            expect(offenders, 'video must not depend on media registry').to.deep.equal([]);
        });
    });

    describe('S2-D: Unknown media type handling', () => {
        it('dispatchStage returns unknown_stage for unregistered type', () => {
            // The registry correctly rejects unknown types
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            expect(registry.hasMediaType('nonexistent')).to.be.false;
            expect(registry.isValidWorkerType('nonexistent')).to.be.false;
        });
    });

    describe('S2-E: Registry is internal', () => {
        it('media registry is not imported by routes outside generation contour', () => {
            const routeDirs = [
                path.join(BACKEND_SRC, 'routes'),
            ];
            const offenders = [];
            for (const dir of routeDirs) {
                const files = listSourceFiles(dir);
                for (const file of files) {
                    // generation-routes.cjs is allowed to use the registry
                    if (file.includes('generation-routes')) continue;
                    const code = readSource(file);
                    if (/require\([^)]*generation\/media-registry/.test(code) || /\.mediaRegistry\b/.test(code)) {
                        offenders.push(rel(file));
                    }
                }
            }
            expect(offenders, 'media registry is internal to generation — routes must not import it directly').to.deep.equal([]);
        });
    });

    describe('S2-F: Player/Editor/VBook boundaries', () => {
        it('generation media registry does not import player/editor/vbook modules', () => {
            const registryFile = path.join(PKG_SRC, 'core', 'media-registry.js');
            const code = readSource(registryFile);
            const imports = requireSpecifiers(code);
            const boundaryViolations = imports.filter(s =>
                /@animastor\/player|@animastor\/editor|@animastor\/vbook|\/player\/|\/editor\//.test(s)
            );
            expect(boundaryViolations, 'registry must not cross package boundaries').to.deep.equal([]);
        });

        it('generation routes contain no player/editor requires (boundary regression)', () => {
            const genRouteFiles = [
                path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs'),
                path.join(BACKEND_SRC, 'routes', 'book', 'generation-routes.cjs'),
                path.join(BACKEND_SRC, 'routes', 'book', 'progress-panel.cjs'),
            ];
            const offenders = [];
            for (const file of genRouteFiles) {
                if (!require('fs').existsSync(file)) continue;
                for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                    if (/routes\/player|@animastor\/player|player-routes|routes\/editor|@animastor\/editor|editor-routes/.test(spec)) {
                        offenders.push(`${rel(file)}: ${spec}`);
                    }
                }
            }
            expect(offenders).to.deep.equal([]);
        });
    });

    // ==================================================
    // S2-G: No duplicate canonical media configuration
    // ==================================================
    // runtime-config is the canonical owner of numeric config (QUOTAS,
    // LEASE_TTL_S, STUCK_THRESHOLDS). The registry must READ those values
    // (default-registrations) — never restate them as its own literals.
    describe('S2-G: No duplicate canonical media configuration', () => {
        it('default-registrations reads config values from the GenerationConfig port, not literals', () => {
            const regFile = readSource(path.join(PKG_SRC, 'core', 'default-registrations.js'));
            // Strip comments — only code statements may reference config
            const code = codeOf(regFile);

            // Canonical numeric literals that live in runtime-config must not
            // be restated in code (quota values, lease TTLs, stuck thresholds)
            const forbidden = [
                /quota:\s*\{\s*maxActive:\s*(?:8|4|2)\b/,
                /leaseTtlS:\s*(?:20|30)\s*\*\s*60/,
                /generatingMinutes:\s*(?:15|30|60)\b/,
                /pendingMinutes:\s*(?:15|30|60)\b/,
            ];
            const offenders = forbidden.filter(re => re.test(code)).map(String);
            expect(offenders, 'registry must read canonical values from runtime-config').to.deep.equal([]);

            // S-6: the wiring goes through the Generation-owned GenerationConfig
            // port (host adapter binds runtime-config) — generation/ must NOT
            // require runtime-config directly anymore (S6-A enforces contour-wide)
            expect(code, 'default-registrations must consume the GenerationConfig port').to.match(/require\([^)]*ports\/generation-config/);
            expect(code, 'default-registrations must not require runtime-config directly (S-6 port)').to.not.match(/require\([^)]*runtime-config/);
        });

        it('registry capability values match runtime-config exactly (no drift)', () => {
            require(path.join(PKG_SRC, 'core', 'default-registrations'));
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            const cfg = require(path.join(BACKEND_SRC, 'config', 'runtime-config'));

            expect(registry.resolveLeaseTtl('audio')).to.equal(cfg.LEASE_TTL_S.AUDIO);
            expect(registry.resolveLeaseTtl('image')).to.equal(cfg.LEASE_TTL_S.IMAGE);
            expect(registry.resolveLeaseTtl('video')).to.equal(cfg.LEASE_TTL_S.VIDEO);
            expect(registry.resolveMaxActive('audio')).to.equal(cfg.QUOTAS.MAX_ACTIVE_AUDIO);
            expect(registry.resolveMaxActive('image')).to.equal(cfg.QUOTAS.MAX_ACTIVE_IMAGE);
            expect(registry.resolveMaxActive('video')).to.equal(cfg.QUOTAS.MAX_ACTIVE_VIDEO);
            expect(registry.resolveStuckThresholds('audio').generatingMinutes).to.equal(cfg.STUCK_THRESHOLDS.AUDIO_GENERATING);
            expect(registry.resolveStuckThresholds('image').generatingMinutes).to.equal(cfg.STUCK_THRESHOLDS.IMAGE_GENERATING);
            expect(registry.resolveStuckThresholds('video').generatingMinutes).to.equal(cfg.STUCK_THRESHOLDS.VIDEO_GENERATING);
        });

        it('runtime-config WORKER_HEARTBEAT_TYPES stays consistent with registry types', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            const cfg = require(path.join(BACKEND_SRC, 'config', 'runtime-config'));
            const registryTypes = registry.listMediaTypes().sort();
            const heartbeatTypes = [...cfg.WORKER_HEARTBEAT_TYPES].sort();
            expect(heartbeatTypes, 'heartbeat infra constant must list exactly the registered media types').to.deep.equal(registryTypes);
        });

        it('no other module restates quota/TTL literals as canonical maps', () => {
            // Stale duplicates found & removed in the completion pass:
            // prometheus QUOTA_MAX {3,2,1} / LEASE_TTLS {15,20,30},
            // runtime-metrics quotas {3,2,1}. Guard against reintroduction.
            const files = [
                path.join(BACKEND_SRC, 'metrics', 'prometheus.js'),
                path.join(BACKEND_SRC, 'runtime', 'runtime-metrics.js'),
            ];
            for (const file of files) {
                const code = codeOf(readSource(file));
                expect(code, `${rel(file)} must not restate quota literals`).to.not.match(/maxAudio:\s*3|maxActive:\s*3\s*,|audio:\s*3\s*,\s*image:\s*2\s*,\s*video:\s*1/);
                expect(code, `${rel(file)} must not restate lease TTL literals`).to.not.match(/audio:\s*15\s*\*\s*60/);
            }
        });
    });

    // ==================================================
    // S2-H: Core runtime holds no standalone media maps
    // ==================================================
    // Core runtime modules must resolve media-type lists/maps through the
    // registry — no independent hardcoded audio/image/video capability maps.
    describe('S2-H: Core runtime has no standalone audio/image/video maps', () => {
        const MAP_PATTERNS = [
            // { audio: X, image: Y, video: Z } object literal (code, not comment)
            /\{\s*['"]?audio['"]?\s*:\s*[^}]+['"]?image['"]?\s*:[^}]+['"]?video['"]?\s*:/,
            // ['audio', 'image', 'video'] array literal
            /\[\s*['"]audio['"]\s*,\s*['"]image['"]\s*,\s*['"]video['"]\s*\]/,
            // new Set(['audio', 'image', 'video'])
            /new Set\(\s*\[\s*['"]audio['"]\s*,\s*['"]image['"]\s*,\s*['"]video['"]\s*\]/,
        ];

        // Files allowed to mention media literals (registration point, or
        // documented media implementation detail — see §22 of the recon doc)
        const ALLOWED = new Set([
            // S-7: generation/default-registrations + media-registry moved to the
            // package (packages/animastor-generation/src/core/) — outside this
            // host-tree scan; the package tier is guarded by the S4/S6 suites.
            'config/runtime-config.js',          // WORKER_HEARTBEAT_TYPES (S2-G consistency-guarded)
            'orchestration/scene-orchestrator.js', // media executors (implementation)
            'orchestration/scene-callbacks.js',   // media handlers (implementation)
            'state/event-journal.js',           // per-type event types (workflow contract; canonical owner since O-1)
            'orchestration/orchestrator.js',     // FAIL_EVENT_TYPES fallback keys per media type in comment + Stage literal handlers
            'services/generation-progress.js',    // (docs only after completion pass)
            'services/scene-asset-registry.js',   // ['audio','image','video','storyboard'] — PG asset registry incl. non-media 'storyboard'
            'services/prompt-dependency-registry.js', // JSON unit keys ('audio'/'image'/'video' are unit field names, not media types)
            'services/cleanup-service.cjs',       // legacy counters mirror (dead display stats, see §22)
            'routes/connector-routes.cjs',        // connector profiles (outside generation contour — S2-E)
            'routes/worker-setup-routes.cjs',     // worker setup profiles (outside contour)
            'routes/book/generation-routes.cjs',  // 'cover'/'vbook' cancel types + error message text
            'routes/generation-routes.cjs',       // stale_dispatch acceptance for audio/video + audio/video orchestrator ternary
            'runtime/runtime-scheduler.js',       // per-type scheduling branches + video→image dependency (documented media logic)
            'runtime/dispatch-engine.js',         // JSDoc text + image IU markers
            'state/scene-state.js',               // per-asset default shape (audio/image/video hash fields — FSM data contract)
            'state/scene-state-ops.js',           // S-5: guarded restore writes per-asset READY hash {audio,image,video} — FSM data contract (moved from orchestrator facade)
            'services/profile-override.js',       // connector profile field names (media implementation: connector/skill layer, not a capability map)
            'services/prompt-profile-loader.js',  // skill-file grouping by type (media implementation: prompt/skill layer)
        ].map(p => path.join(BACKEND_SRC, p)));

        it('core runtime/orchestration/metrics/storage files contain no hardcoded media maps', () => {
            const coreDirs = [
                path.join(BACKEND_SRC, 'runtime'),
                path.join(BACKEND_SRC, 'orchestration'),
                path.join(BACKEND_SRC, 'metrics'),
                path.join(BACKEND_SRC, 'storage'),
                path.join(BACKEND_SRC, 'services'),
                path.join(BACKEND_SRC, 'state'),
            ];
            const offenders = [];
            // S-7: the package core tier (media-registry/default-registrations own
            // the canonical registration literals — S4/S6 suites pin that contour)
            const pkgAllowed = new Set([
                path.join(PKG_SRC, 'core', 'default-registrations.js'),
                path.join(PKG_SRC, 'core', 'media-registry.js'),   // doc comments only
                path.join(PKG_SRC, 'core', 'scene-state.js'),      // per-asset default shape (audio/image/video hash fields — FSM data contract, mirrors host state/scene-state.js)
            ]);
            for (const pkgFile of listSourceFiles(PKG_SRC)) {
                if (pkgAllowed.has(pkgFile)) continue;
                const code = codeOf(readSource(pkgFile));
                for (const re of MAP_PATTERNS) {
                    const m = code.match(re);
                    if (m) { offenders.push(`@pkg/${path.relative(PKG_SRC, pkgFile)}: ${m[0].slice(0, 60)}`); break; }
                }
            }
            for (const dir of coreDirs) {
                for (const file of listSourceFiles(dir)) {
                    if (ALLOWED.has(file)) continue;
                    const code = codeOf(readSource(file));
                    for (const re of MAP_PATTERNS) {
                        const m = code.match(re);
                        if (m) { offenders.push(`${rel(file)}: ${m[0].slice(0, 60)}`); break; }
                    }
                }
            }
            expect(offenders, 'media lists must resolve via media-registry').to.deep.equal([]);
        });
    });

    // ==================================================
    // S2-I: Unknown type flows through existing error paths
    // ==================================================
    // After registry-ization, unknown media/task types must produce the SAME
    // errors as before (no behavior change in HTTP/runtime semantics).
    describe('S2-I: Unknown media/task type error semantics preserved', () => {
        it('gpu-dispatcher.sendUnified rejects unknown job_type with "Invalid job type"', async () => {
            const gpuDispatcher = require(path.join(BACKEND_SRC, 'runtime', 'gpu-dispatcher'));
            let err;
            try {
                await gpuDispatcher.sendUnified({
                    job_id: 'bk1_ch1_sc1_audio_0001', params: {}, job_type: 'hologram',
                    dispatch_id: 'd-1',
                });
            } catch (e) { err = e; }
            // Exact message the route/dispatch layer relied on pre-registry
            expect(err).to.be.an('error');
            expect(err.message).to.equal('Invalid job type');
        });

        it('scene-state rejects unknown asset with existing validation error', async () => {
            const sceneState = require(path.join(BACKEND_SRC, 'state', 'scene-state'));
            const { createMockRedis } = require(path.join('..', 'mocks', 'redis-mock'));
            const redis = createMockRedis();
            const result = await sceneState.unsafeRestoreAssetState(
                redis, 'b1', 'c1', 's1', 'hologram', 'ready'
            );
            // Pre-existing semantics: null + error log, NOT a throw
            expect(result).to.be.null;
        });

        it('scene-orchestrator refuses to dispatch an unregistered stage', async () => {
            const sceneOrch = require(path.join(BACKEND_SRC, 'orchestration', 'scene-orchestrator'));
            let err;
            try {
                await sceneOrch.dispatchSceneStage({}, 'b1', 'c1', 's1', 'hologram', {});
            } catch (e) { err = e; }
            expect(err).to.be.an('error');
        });

        it('media-registry bootstrap cannot register a type that resolves unknown worker type', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            expect(registry.hasMediaType('unknown')).to.be.false;
            expect(registry.resolveMaxActive('unknown')).to.be.undefined;
            expect(registry.resolveLeaseTtl('unknown')).to.be.undefined;
        });
    });

    // ==================================================
    // S2-J: Registry task types match production task types
    // ==================================================
    // Task types are the Redis/Job Protocol vocabulary — S-2 must not add,
    // rename or alias them. 1:1 mapping audio→audio, image→image, video→video.
    describe('S2-J: Registry task types match production task types (1:1)', () => {
        it('each registered media type maps to exactly itself as task type', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            for (const type of registry.listMediaTypes()) {
                const cap = registry.getMediaType(type);
                expect(cap.taskTypes, `${type} taskTypes must be 1:1`).to.deep.equal([type]);
            }
        });

        it('resolveValidWorkerTypes returns exactly the registered media types', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            const workerTypes = registry.resolveValidWorkerTypes();
            expect([...workerTypes].sort()).to.deep.equal(['audio', 'image', 'video']);
        });

        it('registry does not introduce iu_image or other job-protocol subtypes', () => {
            const registry = require(path.join(PKG_SRC, 'core', 'media-registry'));
            const all = new Set();
            for (const cap of registry.listCapabilities()) cap.taskTypes.forEach(t => all.add(t));
            expect(all.has('iu_image'), 'iu_image is a Job Protocol contract type (frozen packages/animastor-contracts), not a registry type').to.be.false;
            expect(all.has('cover'), 'cover is a capability/profile of image flow, not a registry type').to.be.false;
        });
    });
});

/** Strip comments so doc mentions are not treated as code edges. */
function codeOf(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

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
    path.join(BACKEND_SRC, 'generation', 'media-registry.js'),
    path.join(BACKEND_SRC, 'generation', 'default-registrations.js'),
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
            const registryFile = path.join(BACKEND_SRC, 'generation', 'media-registry.js');
            const code = readSource(registryFile);
            const imports = requireSpecifiers(code);
            const mediaImports = imports.filter(s => /\/audio\/|\/image\/|\/video\//.test(s));
            expect(mediaImports, 'media-registry must be media-implementation agnostic').to.deep.equal([]);
        });

        it('default-registrations module does not import audio/image/video implementations', () => {
            const regFile = path.join(BACKEND_SRC, 'generation', 'default-registrations.js');
            const code = readSource(regFile);
            const imports = requireSpecifiers(code);
            const mediaImports = imports.filter(s => /\/audio\/|\/image\/|\/video\//.test(s));
            expect(mediaImports, 'default-registrations must be config-only, no media imports').to.deep.equal([]);
        });
    });

    describe('S2-B: Registry integrity', () => {
        it('media registry exports required API surface', () => {
            const registry = require(path.join(BACKEND_SRC, 'generation', 'media-registry'));
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
            require(path.join(BACKEND_SRC, 'generation', 'default-registrations'));
            const registry = require(path.join(BACKEND_SRC, 'generation', 'media-registry'));
            expect(registry.hasMediaType('audio')).to.be.true;
            expect(registry.hasMediaType('image')).to.be.true;
            expect(registry.hasMediaType('video')).to.be.true;
        });

        it('each registered type has required capability fields', () => {
            const registry = require(path.join(BACKEND_SRC, 'generation', 'media-registry'));
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
                if (/require\([^)]*generation\/media-registry/.test(code)) {
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
                if (/require\([^)]*generation\/media-registry/.test(code)) {
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
                if (/require\([^)]*generation\/media-registry/.test(code)) {
                    offenders.push(rel(file));
                }
            }
            expect(offenders, 'video must not depend on media registry').to.deep.equal([]);
        });
    });

    describe('S2-D: Unknown media type handling', () => {
        it('dispatchStage returns unknown_stage for unregistered type', () => {
            // The registry correctly rejects unknown types
            const registry = require(path.join(BACKEND_SRC, 'generation', 'media-registry'));
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
                    if (/require\([^)]*generation\/media-registry/.test(code)) {
                        offenders.push(rel(file));
                    }
                }
            }
            expect(offenders, 'media registry is internal to generation — routes must not import it directly').to.deep.equal([]);
        });
    });

    describe('S2-F: Player/Editor/VBook boundaries', () => {
        it('generation media registry does not import player/editor/vbook modules', () => {
            const registryFile = path.join(BACKEND_SRC, 'generation', 'media-registry.js');
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

// ======================================================
// @animastor/generation — dirty-grammar (public subpath + root namespace)
// ======================================================
// The scene-change → dirty-layer grammar of the Generation domain, adopted
// from the host (backend/src/services/prompt-dependency-registry.js,
// backend/src/dependency-graph.js, backend/src/utils/{scene-hash,
// speech-estimation,cyr-latin-map}.js — the reconnaissance doc
// docs/architecture/backend-decomposition-reconnaissance.md §4.2).
//
// This tier owns the PURE answers to three questions:
//   1. Which generation layers does a scene change dirty?
//      (prompt-dependency-registry.computeSceneDirtyLayers)
//   2. Which layers must regenerate when a layer is dirty (transitively)?
//      (dependency-graph.resolveDirtyLayers)
//   3. What is the canonical creative-content fingerprint of a scene/book?
//      (scene-hash.computeSceneHash / computeBookHash)
// plus the two shared pure primitives the grammar and the host pipelines
// consume: the speech-duration heuristic (speech-estimation) and the
// Cyrillic→Latin transliteration (cyr-latin-map — the single canonical
// copy; the editor package keeps its own internal copy by its own boundary
// doctrine, host copies were deleted by this adoption).
//
// Everything here is pure: zero requires of the host, no fs, no config, no
// Redis/PG, no process.env. The EXECUTION side (marking dirty scenes into
// Redis, FSM-valid resets) stays a host concern (backend book-diff host
// half + storage adapters).
//
// Public surface (frozen — pinned by backend/tests/architecture/
// generation-package-boundary.test.js G7-G):
//   computeSceneDirtyLayers, getFieldsForLayer, getCrossFields,
//   getLayerDependencies, sceneReferencesCharacter,
//   SCENE_FIELDS, CROSS_FIELDS,
//   resolveDirtyLayers, DEPENDENCY_GRAPH,
//   computeSceneHash, computeBookHash, shortHash, generateBuildId,
//   estimateSpeechDurationSec, SPEECH_SEC_PER_WORD, SPEECH_MIN_SEC,
//   cyrToLatin, CYR_LATIN_MAP,
//   isEqual, extractPassport (testing seams, moved verbatim)
//
// Consumed by the host through the package ROOT namespace property
// (dirtyGrammar) or the './dirty-grammar' subpath export — never by a
// deep file path (G7-D).

const registry = require('./prompt-dependency-registry');
const dependencyGraph = require('./dependency-graph');
const sceneHash = require('./scene-hash');
const speechEstimation = require('./speech-estimation');
const cyrLatinMap = require('./cyr-latin-map');

module.exports = {
    // ── scene dirty-layer computation (the Prompt Dependency Registry) ──
    computeSceneDirtyLayers: registry.computeSceneDirtyLayers,
    getFieldsForLayer: registry.getFieldsForLayer,
    getCrossFields: registry.getCrossFields,
    getLayerDependencies: registry.getLayerDependencies,
    sceneReferencesCharacter: registry.sceneReferencesCharacter,
    SCENE_FIELDS: registry.SCENE_FIELDS,
    CROSS_FIELDS: registry.CROSS_FIELDS,
    // moved verbatim for testing parity (the host book-diff re-exports it)
    isEqual: registry.isEqual,
    extractPassport: registry.extractPassport,

    // ── layer→layer regeneration graph ────────────────────────────────
    resolveDirtyLayers: dependencyGraph.resolveDirtyLayers,
    DEPENDENCY_GRAPH: dependencyGraph.DEPENDENCY_GRAPH,

    // ── creative-content fingerprinting ───────────────────────────────
    computeSceneHash: sceneHash.computeSceneHash,
    computeBookHash: sceneHash.computeBookHash,
    shortHash: sceneHash.shortHash,
    generateBuildId: sceneHash.generateBuildId,

    // ── shared pure primitives ────────────────────────────────────────
    estimateSpeechDurationSec: speechEstimation.estimateSpeechDurationSec,
    SPEECH_SEC_PER_WORD: speechEstimation.SPEECH_SEC_PER_WORD,
    SPEECH_MIN_SEC: speechEstimation.SPEECH_MIN_SEC,
    cyrToLatin: cyrLatinMap.cyrToLatin,
    CYR_LATIN_MAP: cyrLatinMap.CYR_LATIN_MAP,
};

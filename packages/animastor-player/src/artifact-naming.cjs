// ======================================================
// @animastor/player — ARTIFACT NAMING GRAMMAR (seam)
// ======================================================
// The single place where the playback contour reconstructs media artifact
// filenames. Generation WRITES these files (audio-orchestrator, video-
// orchestrator, image pipeline, filesystem-store) and the Player contour
// READS them; the grammar itself is an undeclared cross-domain contract
// (Player extraction audit §4, risk R2).
//
// Owner of the grammar today: the generation/storage writers, canonical
// definitions in storage/filesystem-store.js (makeSceneAudioFilename,
// makeChunkAudioFilename, makeIUImageFilename, makePreviewFilename) plus the
// video group grammar `${prefix}_gN.mp4` (video-orchestrator suffixes).
// The Player must NOT import generation implementations directly — this
// module re-exposes the grammar through an explicit, dependency-free
// utility contract (@animastor/player/src/artifact-naming.cjs — moved with
// the physical extraction). Generation keeps its own writer functions; the
// byte-identity pin below is the drift guard. Long-term home (optional):
// @animastor/vbook-runtime schema territory — out of scope here.
//
// NOTE: strings here MUST stay byte-identical to the writers. Guarded by
// backend/tests/architecture/player-route-split.test.js (P7 naming pins).

/**
 * Scene audio: `${book}_${chapter}_${scene}.mp3`
 * (mirrors filesystem-store.makeSceneAudioFilename / audio-orchestrator merge output)
 */
function sceneAudioName(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}.mp3`;
}

/** Scene video (merged, player-facing): `${prefix}.mp4` */
function sceneVideoName(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}.mp4`;
}

/** Video group clip: `${prefix}_g${n}.mp4` (video-orchestrator suffix grammar) */
function sceneVideoGroupName(bookId, chapterId, sceneId, group) {
    return `${bookId}_${chapterId}_${sceneId}_g${group}.mp4`;
}

/** Scene image: `${prefix}.png` */
function sceneImageName(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}.png`;
}

/**
 * IU image prefix glob: `${prefix}_iu` — IU images are
 * `${prefix}_iu{iuId}.png` (mirrors filesystem-store.makeIUImageFilename;
 * the route serves by exact id via iuImageName and lists by this prefix).
 */
function iuImagePrefix(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}_iu`;
}

/**
 * IU image by exact URL id: `${prefix}_${iuId}.png`. The URL :iuId carries the
 * `iu` prefix itself (frontend unitId: u.id ?? 'iu0001'), so this equals the
 * writer's `${prefix}_iu${strippedId}.png` (filesystem-store
 * .makeIUImageFilename with the ^iu-stripped id — see image/preview.js).
 */
function iuImageName(bookId, chapterId, sceneId, iuId) {
    return `${bookId}_${chapterId}_${sceneId}_${iuId}.png`;
}

/** Prefix shared by every scene artifact (audio/video/image/iu/preview). */
function sceneArtifactPrefix(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}`;
}

module.exports = {
    sceneAudioName,
    sceneVideoName,
    sceneVideoGroupName,
    sceneImageName,
    iuImagePrefix,
    iuImageName,
    sceneArtifactPrefix,
};

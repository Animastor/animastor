// ======================================================
// Generation Artifact Naming — canonical grammar (S-4)
// ======================================================
// The single canonical owner of the on-disk artifact filename grammar that
// Generation WRITES and its consumers (Player, export routes, cleanup)
// READ. Previously the grammar lived inline in ~20 production sites
// (audio pipeline, video merge, image registry, orchestration cleanup) and
// was re-declared as a dependency-free contract in @animastor/player
// (artifact-naming.cjs) with a byte-identity guard.
//
// S-4 moves the ownership INSIDE the future @animastor/generation package:
// every call site below now composes its filename from these helpers. The
// bytes produced are unchanged — `${bookId}_${chapterId}_${sceneId}` is the
// scene prefix, everything else is a documented suffix grammar:
//
//   scene audio:          {prefix}.mp3                    (merged scene audio)
//   scene audio chunk:    {prefix}_{NNNN}.mp3             (pad(4) chunk index)
//   scene image (IU):     {prefix}_{unitId}.png           (unitId: `iu0001`)
//   scene image preview:  {prefix}_pr{strippedUnitId}.png (^iu-stripped id)
//   scene video (group):  {prefix}{groupSuffix}.mp4       (`_gN` suffix, N>=1)
//   scene video (merged): {prefix}.mp4                    (player-facing)
//   book video export:    {bookId}.mp4
//
// Cross-domain pins: the @animastor/player artifact-naming.cjs contract
// strings (guarded by tests/architecture/player-route-split.test.js) and
// the Job Protocol v2 assetId grammar (packages/animastor-contracts —
// job_id = `{assetId}:{type}`) must stay byte-identical. S4-G pins the
// single-ownership invariant.
//
// Host dependency note: OUTPUT_DIR is deliberately NOT owned here — path
// composition happens via utils/string-utils.getOutputPath (host config
// boundary, future S-6 mediaUtils/filesystem port). This module is pure.

const SCENE_CHUNK_PAD = 4;

/** The scene prefix every artifact grammar is built on: `{bookId}_{chapterId}_{sceneId}` */
function scenePrefix(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}`;
}

/** Scene audio (merged): `{prefix}.mp3` */
function sceneAudioName(bookId, chapterId, sceneId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}.mp3`;
}

/** Scene audio chunk: `{prefix}_{NNNN}.mp3` (chunk index padded to 4) */
function sceneChunkAudioName(bookId, chapterId, sceneId, chunkIndex) {
    return `${scenePrefix(bookId, chapterId, sceneId)}_${String(chunkIndex).padStart(SCENE_CHUNK_PAD, '0')}.mp3`;
}

/** Scene image (IU): `{prefix}_{unitId}.png` */
function sceneImageName(bookId, chapterId, sceneId, unitId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}_${unitId}.png`;
}

/** Scene image (legacy whole-scene, no unit suffix): `{prefix}.png` */
function sceneImageBaseName(bookId, chapterId, sceneId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}.png`;
}

/** Scene image preview: `{prefix}_pr{strippedUnitId}.png` */
function sceneImagePreviewName(bookId, chapterId, sceneId, unitId) {
    const stripped = String(unitId).replace(/^iu/, '');
    return `${scenePrefix(bookId, chapterId, sceneId)}_pr${stripped}.png`;
}

/** Scene video group clip: `{prefix}{groupSuffix}.mp4` (groupSuffix `_gN`, N>=1) */
function sceneVideoGroupName(bookId, chapterId, sceneId, groupSuffix) {
    return `${scenePrefix(bookId, chapterId, sceneId)}${groupSuffix || ''}.mp4`;
}

/** Scene video (merged, player-facing): `{prefix}.mp4` */
function sceneVideoName(bookId, chapterId, sceneId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}.mp4`;
}

/** Book video export: `{bookId}.mp4` */
function bookVideoName(bookId) {
    return `${bookId}.mp4`;
}

/** Book audio (whole-book merged legacy artifact): `{bookId}.mp3` */
function bookAudioName(bookId) {
    return `${bookId}.mp3`;
}

/** IU in-flight Redis marker / IU asset id: `{prefix}_{unitId}` */
function iuAssetId(bookId, chapterId, sceneId, unitId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}_${unitId}`;
}

/** IU progress/scan Redis prefix: `{prefix}_iu-` */
function iuScanPrefix(bookId, chapterId, sceneId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}_iu-`;
}

/** IU image disk-prefix glob: `{prefix}_iu` (all IU images of a scene) */
function iuImagePrefix(bookId, chapterId, sceneId) {
    return `${scenePrefix(bookId, chapterId, sceneId)}_iu`;
}

module.exports = {
    SCENE_CHUNK_PAD,
    scenePrefix,
    sceneAudioName,
    sceneChunkAudioName,
    sceneImageName,
    sceneImageBaseName,
    sceneImagePreviewName,
    sceneVideoGroupName,
    sceneVideoName,
    bookVideoName,
    bookAudioName,
    iuAssetId,
    iuScanPrefix,
    iuImagePrefix,
};

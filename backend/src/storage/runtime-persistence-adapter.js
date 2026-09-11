// ======================================================
// HOST ADAPTER: RuntimePersistenceAdapter — O-2 PersistencePort impl
// ======================================================
// Host-side implementation of the O-2 PersistencePort
// (runtime/persistence-port.js). Owns every concrete persistence detail the
// runtime/orchestration tiers must not know: the PG repositories, the SQL,
// the tables, the storage barrel (filesystem-store + Redis asset-registry).
//
//   runtime/persistence-port   (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/runtime-persistence-adapter  ← THIS FILE (host impl)
//
// Lazy require discipline (matches pre-O-2 behavior): every repo/barrel
// handle is resolved at CALL time, never captured at module load. This keeps
// require.cache-based test stubbing working exactly as before — a harness
// that stubs `storage/postgres/repositories/task-repo` etc. and then
// requires the tier consumer gets the stub through this adapter, and a
// module reload after require.cache manipulation re-resolves correctly.
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-2 call —
// identical repositories, identical arguments, identical return values and
// errors. No SQL changed, no query semantics changed (O-2 acceptance).
// Semantics notes preserved verbatim:
//   - tasks.hasActiveTaskForScene: pre-O-2 the caller swallowed ALL errors
//     and treated them as "task exists" (fail-safe, no repair) — the
//     throw-through here keeps that caller-side catch semantics byte-equal.
//   - sceneAssets.getAsset falls back to the latest row when buildId is
//     null (repo-internal ORDER BY, unchanged).
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.9
// ======================================================

// Lazy call-time resolvers — never capture the module instance at load time.
const database = () => require('./postgres/database');
const taskRepo = () => require('./postgres/repositories/task-repo');
const sceneAssetsRepo = () => require('./postgres/repositories/scene-assets-repo');
const iuRepo = () => require('./postgres/repositories/iu-repo');
const generationCancelRepo = () => require('./postgres/repositories/generation-cancel-repo');
// registry + filesystem stay BARREL-delegated (../storage), exactly as the
// tier consumers consumed them pre-O-2 — harnesses that stub the barrel keep
// intercepting these ops through the adapter's lazy resolution.
const storageBarrel = () => require('./index');

// ── tasks ─────────────────────────────────────────────
async function updateTaskStatus(taskId, status, error) {
    return taskRepo().updateTaskStatus(taskId, status, error);
}

async function hasActiveTaskForScene(bookId, sceneId, taskType) {
    return taskRepo().hasActiveTaskForScene(bookId, sceneId, taskType);
}

// ── sceneAssets ───────────────────────────────────────
async function getAsset(bookId, chapterId, sceneId, assetType, buildId) {
    return sceneAssetsRepo().getAsset(bookId, chapterId, sceneId, assetType, buildId);
}

async function markReady(bookId, chapterId, sceneId, assetType, path, extras) {
    return sceneAssetsRepo().markReady(bookId, chapterId, sceneId, assetType, path, extras);
}

async function getDirtyUnitIds(bookId, chapterId, sceneId) {
    return sceneAssetsRepo().getDirtyUnitIds(bookId, chapterId, sceneId);
}

async function setDirtyUnitIds(bookId, chapterId, sceneId, unitIds) {
    return sceneAssetsRepo().setDirtyUnitIds(bookId, chapterId, sceneId, unitIds);
}

async function clearDirtyUnitIds(bookId, chapterId, sceneId) {
    return sceneAssetsRepo().clearDirtyUnitIds(bookId, chapterId, sceneId);
}

async function clearDirtyFlag(bookId, chapterId, sceneId) {
    return sceneAssetsRepo().clearDirtyFlag(bookId, chapterId, sceneId);
}

async function getDirtyScenesByVersion(bookId) {
    return sceneAssetsRepo().getDirtyScenesByVersion(bookId);
}

// Pre-O-2 (reconciliation rebuildWorkList): two raw barrel queries issued
// back-to-back per book. The SQL moved here verbatim — same statements, same
// params, same row shapes; only the fetch is batched into one op.
async function getDirtyMarkers(bookId) {
    const unitMarker = await database().query(`
        SELECT DISTINCT chapter_id, scene_id FROM scenes
        WHERE book_id = $1 AND dirty_unit_ids IS NOT NULL AND array_length(dirty_unit_ids, 1) > 0
    `, [bookId]);
    const assetMarker = await database().query(`
        SELECT DISTINCT chapter_id, scene_id, asset_type FROM scene_assets
        WHERE book_id = $1 AND status IN ('stale', 'failed', 'pending')
    `, [bookId]);
    return { unitScenes: unitMarker.rows, assetStages: assetMarker.rows };
}

// ── iu ────────────────────────────────────────────────
async function getImageUnitsForScene(buildId, bookId, chapterId, sceneId) {
    return iuRepo().getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
}

async function upsertImageUnit(buildId, bookId, chapterId, sceneId, unitId, data) {
    return iuRepo().upsertImageUnit(buildId, bookId, chapterId, sceneId, unitId, data);
}

// ── cancel ────────────────────────────────────────────
async function isCancelled(bookId) {
    return generationCancelRepo().isCancelled(bookId);
}

async function getAllCancelled() {
    return generationCancelRepo().getAllCancelled();
}

// ── sceneVersions (scenes-table version reads) ────────
// Pre-O-2 these were two raw SQL shapes issued from three tier files.
// The SQL moves here verbatim — column list, WHERE, params and row shape
// unchanged; callers consume `.rows` exactly as before.

// `SELECT content_version, audio_config_version FROM scenes WHERE book_id =
//  $1 AND chapter_id = $2 AND scene_id = $3` — scene-window (2 sites),
//  scene-restoration, orchestrator.completeStage version gate.
async function getSceneVersions(bookId, chapterId, sceneId) {
    const result = await database().query(`
        SELECT content_version, audio_config_version FROM scenes
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
    return result.rows;
}

// `SELECT s.content_version, s.audio_config_version, a.scene_content_version,
//  a.scene_audio_config_version, a.status as asset_status FROM scenes s LEFT
//  JOIN scene_assets a …` — runtime-scheduler.detectVersionStale.
async function getAudioConfigVersions(bookId, chapterId, sceneId) {
    const result = await database().query(`
        SELECT s.content_version, s.audio_config_version,
               a.scene_content_version, a.scene_audio_config_version, a.status as asset_status
        FROM scenes s
        LEFT JOIN scene_assets a ON a.book_id = s.book_id
            AND a.chapter_id = s.chapter_id
            AND a.scene_id = s.scene_id
        WHERE s.book_id = $1 AND s.chapter_id = $2 AND s.scene_id = $3
    `, [bookId, chapterId, sceneId]);
    return result.rows;
}

// `SELECT s.book_id, s.chapter_id, s.scene_id, s.content_version,
//  s.audio_config_version, a.asset_type, a.scene_content_version,
//  a.scene_audio_config_version FROM scenes s LEFT JOIN scene_assets a …
//  WHERE s.content_version > 1 OR s.audio_config_version > 1` —
//  reconciliation-engine.checkVersionStaleness (C2 book-wide scan).
async function getVersionStalenessRows() {
    const result = await database().query(`
        SELECT s.book_id, s.chapter_id, s.scene_id, s.content_version, s.audio_config_version,
               a.asset_type, a.scene_content_version, a.scene_audio_config_version
        FROM scenes s
        LEFT JOIN scene_assets a ON a.book_id = s.book_id
            AND a.chapter_id = s.chapter_id
            AND a.scene_id = s.scene_id
        WHERE s.content_version > 1 OR s.audio_config_version > 1
    `);
    return result.rows;
}

// ── registry (Redis asset registry — BARREL delegation, pre-O-2 channel) ──
async function getSceneAssetsRedis(redis, bookId, chapterId, sceneId) {
    return storageBarrel().registry.getSceneAssetsRedis(redis, bookId, chapterId, sceneId);
}

async function registerSceneAudioRedis(redis, bookId, chapterId, sceneId, payload) {
    return storageBarrel().registry.registerSceneAudioRedis(redis, bookId, chapterId, sceneId, payload);
}

async function registerSceneImageRedis(redis, bookId, chapterId, sceneId, payload) {
    return storageBarrel().registry.registerSceneImageRedis(redis, bookId, chapterId, sceneId, payload);
}

async function registerSceneVideoRedis(redis, bookId, chapterId, sceneId, payload) {
    return storageBarrel().registry.registerSceneVideoRedis(redis, bookId, chapterId, sceneId, payload);
}

// ── filesystem (BARREL delegation — path composition, pre-O-2 channel) ──
function getSceneAudioPath(outputDir, buildId, bookId, chapterId, sceneId) {
    return storageBarrel().filesystem.getSceneAudioPath(outputDir, buildId, bookId, chapterId, sceneId);
}

// ── listBooks (rebuildWorkList Phase 1) ───────────────
// Pre-O-2: `SELECT DISTINCT book_id FROM scenes` issued through the storage
// barrel. Returns rows unchanged; the caller maps `.rows`.
async function listBooks() {
    const result = await database().query('SELECT DISTINCT book_id FROM scenes');
    return result.rows;
}

module.exports = {
    tasks: {
        updateTaskStatus,
        hasActiveTaskForScene,
    },
    sceneAssets: {
        getAsset,
        markReady,
        getDirtyUnitIds,
        setDirtyUnitIds,
        clearDirtyUnitIds,
        clearDirtyFlag,
        getDirtyScenesByVersion,
        getDirtyMarkers,
    },
    iu: {
        getImageUnitsForScene,
        upsertImageUnit,
    },
    cancel: {
        isCancelled,
        getAllCancelled,
    },
    sceneVersions: {
        getSceneVersions,
        getAudioConfigVersions,
        getVersionStalenessRows,
    },
    registry: {
        getSceneAssetsRedis,
        registerSceneAudioRedis,
        registerSceneImageRedis,
        registerSceneVideoRedis,
    },
    filesystem: {
        getSceneAudioPath,
    },
    listBooks,
};

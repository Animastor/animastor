// ======================================================
// JOB SCHEMA — единый контракт job_id backend ↔ gpu-hub ↔ worker
// ======================================================
// T2 консолидации (docs/03-audit/ORCHESTRATION_CONSOLIDATION_TODO.md).
// До этого модуля формат job_id был устной конвенцией, разбираемой
// независимо в task-handler, cleanup-service, gpu-hub и worker.
//
// Форматы (строка = `${assetId}:${type}`):
//   audio-чанк:    {bookId}_{chapterId}_{sceneId}_{NNNN}:audio   (NNNN = pad(4))
//   IU-изображение:{bookId}_{chapterId}_{sceneId}_{iuId}:iu_image
//   scene image:   {bookId}_{chapterId}_{sceneId}:image          (legacy; если
//                  assetId содержит '_iu' — это IU-изображение старого формата)
//   видео:         {bookId}_{chapterId}_{sceneId}[_gN]:video     (_gN = группа)
//
// bookId может содержать '_'; chapterId/sceneId/chunkIndex/iuId — нет,
// поэтому разбор всегда идёт с конца.
//
// gpu-hub и worker — отдельные процессы без общего пакета: у них лежат
// упрощённые копии разбора с якорем `SYNC: backend/src/runtime/job-schema.js`.
// Меняешь формат здесь — обнови копии.

// Версия протокола backend ↔ gpu-hub ↔ worker. Передаётся в task и callback
// payload. Все три компонента отклоняют несовпадающую версию: mixed-version
// rollout допускается только после остановки выдачи задач старому worker.
const PROTOCOL_VERSION = 2; // T4: добавлен dispatch_id

const JOB_TYPES = ['audio', 'image', 'iu_image', 'video'];
const STAGE_BY_KIND = {
    audio_chunk: 'audio',
    iu_image: 'image',
    scene_image: 'image',
    scene_video: 'video',
};

const CHUNK_INDEX_RE = /^\d{4}$/;
const GROUP_SUFFIX_RE = /^(.+?)(_g\d+)$/;

function buildJobId(assetId, type) {
    if (!assetId || typeof assetId !== 'string') {
        throw new Error(`buildJobId: invalid assetId: ${assetId}`);
    }
    if (!JOB_TYPES.includes(type)) {
        throw new Error(`buildJobId: unknown job type: ${type}`);
    }
    return `${assetId}:${type}`;
}

// Отрезает типовой суффикс. Возвращает { assetId, type } или null.
function splitJobId(jobId) {
    if (!jobId || typeof jobId !== 'string') return null;
    const idx = jobId.lastIndexOf(':');
    if (idx === -1) return null;
    const type = jobId.slice(idx + 1);
    if (!JOB_TYPES.includes(type)) return null;
    return { assetId: jobId.slice(0, idx), type };
}

// Полный разбор. Возвращает null для нераспознаваемых id.
// kind: 'audio_chunk' | 'iu_image' | 'scene_image' | 'scene_video'
function parseJobId(jobId) {
    const split = splitJobId(jobId);
    if (!split) return null;
    const { assetId, type } = split;

    if (type === 'audio') {
        const parts = assetId.split('_');
        if (parts.length < 4) return null;
        const chunkIndex = parts.pop();
        if (!CHUNK_INDEX_RE.test(chunkIndex)) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'audio_chunk', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, chunkIndex,
        };
    }

    if (type === 'iu_image' || (type === 'image' && assetId.includes('_iu'))) {
        const parts = assetId.split('_');
        if (parts.length < 4) return null;
        const iuId = parts.pop();
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'iu_image', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, iuId,
        };
    }

    if (type === 'image') {
        const parts = assetId.split('_');
        if (parts.length < 3) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'scene_image', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId,
        };
    }

    if (type === 'video') {
        let base = assetId;
        let groupSuffix = '';
        const groupMatch = base.match(GROUP_SUFFIX_RE);
        if (groupMatch) {
            base = groupMatch[1];
            groupSuffix = groupMatch[2];
        }
        const parts = base.split('_');
        if (parts.length < 3) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'scene_video', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, groupSuffix,
        };
    }

    return null;
}

function getStageForJobId(jobId) {
    const parsed = parseJobId(jobId);
    if (!parsed) return null;
    return STAGE_BY_KIND[parsed.kind] || null;
}

module.exports = {
    PROTOCOL_VERSION,
    JOB_TYPES,
    STAGE_BY_KIND,
    buildJobId,
    splitJobId,
    parseJobId,
    getStageForJobId,
};

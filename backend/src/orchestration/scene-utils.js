const journal = require('./event-journal');

const logPrefix = '[ORCH]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

async function logEvent(redis, scene, type, stateName, details = {}) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    await journal.appendSceneEvent(
        redis,
        bookId,
        chapterId,
        sceneId,
        type,
        stateName,
        details
    );
}

module.exports = { log, warn, error, logEvent };

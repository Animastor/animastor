const config = require('../config/runtime-config');
const jobSchema = require('./job-schema');
const { PROTOCOL_VERSION } = jobSchema;

const logPrefix = '[GPU]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const stats = {
    audio_jobs_started: 0,
    image_jobs_started: 0,
    video_jobs_started: 0,
    failed_jobs: 0
};



// T4: Структурированный результат отправки
// { sent: true, jobId } или { sent: false, error }
async function sendUnified(taskSpec) {
    if (!taskSpec.job_id || !taskSpec.params || !taskSpec.job_type) {
        throw new Error("Invalid task specification");
    }
    const validTypes = ['audio', 'image', 'video'];
    if (!validTypes.includes(taskSpec.job_type)) {
        throw new Error("Invalid job type");
    }
    if (!taskSpec.dispatch_id || typeof taskSpec.dispatch_id !== 'string') {
        throw new Error("dispatch_id is required");
    }

    const parsed = jobSchema.parseJobId(taskSpec.job_id);
    if (!parsed) {
        throw new Error(`Invalid job_id: ${taskSpec.job_id}`);
    }

    const payload = {
        ...taskSpec,
        build_id: taskSpec.build_id || "default",
        protocol_version: PROTOCOL_VERSION,
        book_id: parsed.bookId,
        chapter_id: parsed.chapterId,
        scene_id: parsed.sceneId,
        stage: jobSchema.STAGE_BY_KIND[parsed.kind],
    };

    // T9: Include GPU_HUB_API_KEY header for authenticated requests
    const headers = { "Content-Type": "application/json" };
    if (config.GPU_HUB_API_KEY) {
        headers['x-api-key'] = config.GPU_HUB_API_KEY;
    }

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const res = await fetch(`${config.HUB_URL}/task`, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            log(`Task sent: ${payload.job_id} (${payload.job_type}), build: ${payload.build_id}, dispatch: ${payload.dispatch_id}`);
            switch (payload.job_type) {
                case 'audio': stats.audio_jobs_started++; break;
                case 'image': stats.image_jobs_started++; break;
                case 'video': stats.video_jobs_started++; break;
            }
            return { sent: true, jobId: payload.job_id, dispatchId: payload.dispatch_id };
        } catch (err) {
            lastError = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
    }
    stats.failed_jobs++;
    return { sent: false, error: lastError ? lastError.message : 'max_retries' };
}

async function send(job_id, workflow, type, build_id, dispatch_id) {
    return sendUnified({ job_id, params: workflow, job_type: type, build_id, dispatch_id });
}

module.exports = { send, sendUnified };

const config = require('../config/runtime-config');
const { PROTOCOL_VERSION } = require('./job-schema');

const logPrefix = '[GPU]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const stats = {
    audio_jobs_started: 0,
    image_jobs_started: 0,
    video_jobs_started: 0,
    failed_jobs: 0
};



async function sendUnified(taskSpec) {
    if (!taskSpec.job_id || !taskSpec.params || !taskSpec.job_type) {
        throw new Error("Invalid task specification");
    }
    const validTypes = ['audio', 'image', 'video'];
    if (!validTypes.includes(taskSpec.job_type)) {
        throw new Error("Invalid job type");
    }
    if (!taskSpec.build_id) {
        taskSpec.build_id = "default";
    }
    taskSpec.protocol_version = PROTOCOL_VERSION;

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const res = await fetch(`${config.HUB_URL}/task`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(taskSpec),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            log(`Task sent: ${taskSpec.job_id} (${taskSpec.job_type}), build: ${taskSpec.build_id}`);
            switch (taskSpec.job_type) {
                case 'audio': stats.audio_jobs_started++; break;
                case 'image': stats.image_jobs_started++; break;
                case 'video': stats.video_jobs_started++; break;
            }
            return;
        } catch (err) {
            lastError = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
    }
    stats.failed_jobs++;
    throw lastError;
}

async function send(job_id, workflow, type, build_id) {
    await sendUnified({ job_id, params: workflow, job_type: type, build_id });
}

module.exports = { send, sendUnified };

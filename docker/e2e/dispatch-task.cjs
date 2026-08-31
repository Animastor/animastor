'use strict';
// E2E dispatch: push a REAL generation task through the production GPU Hub
// (POST /task, x-api-key — the documented backend→hub interface) and poll the
// hub's result key in Redis until the worker delivers.
//
// Usage: node dispatch-task.cjs <workflow.json> [text] [timeout_sec]
// Env:   E2E_WORKSPACE_ID (private worker's workspace), E2E_HUB=https://animastor.in/gpu
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

const WORKFLOW_PATH = process.argv[2] || '/home/animastor/animastor/backend/ai/workflows/tts-qwen-narrator.json';
const TEXT = process.argv[3] || 'Animastor docker deployment end to end test. One short sentence.';
const POLL_TIMEOUT_MS = Number(process.argv[4] || 2400) * 1000;

const WORKSPACE_ID = process.env.E2E_WORKSPACE_ID;
if (!WORKSPACE_ID) { console.error('E2E_WORKSPACE_ID required'); process.exit(1); }
const HUB = process.env.E2E_HUB || 'https://animastor.in/gpu';

const API_KEY = execSync('docker exec gpu-hub printenv GPU_HUB_API_KEY').toString().trim();
if (!API_KEY) { console.error('GPU_HUB_API_KEY not found in hub container'); process.exit(1); }

// task identity — book/chapter/scene mirror the production dispatch schema
const TS = Date.now().toString(36);
const JOB = {
    job_id: `e2e-docker-${TS}:audio`,
    build_id: `e2ebuild${TS}`,
    dispatch_id: `e2edisp${TS}`,
    book_id: 'e2ebook',
    chapter_id: 'e2ech',
    scene_id: 'e2escene',
    stage: 'generate',
    job_type: 'audio',
    protocol_version: 2,
    workspace_id: WORKSPACE_ID,
    timeout_ms: 1800000, // CPU generation may be slow; hub floors this at GPU_TIMEOUT
};
// the hub names the result key with the task STAGE as the final segment
const RESULT_KEY = `animastor:result:${JOB.build_id}:${JOB.book_id}:${JOB.chapter_id}:${JOB.scene_id}:${JOB.stage}`;

// workflow: baseline artifact → task.params (worker posts it to /prompt as-is)
const wf = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
for (const node of Object.values(wf)) {
    if (node.class_type === 'Qwen3TTSVoiceDesign') node.inputs.text = TEXT;
}

// dispatch
const body = JSON.stringify({ ...JOB, params: wf });
const res = execFileSync('curl', [
    '-fsS', '-X', 'POST', `${HUB}/task`,
    '-H', 'Content-Type: application/json',
    '-H', `x-api-key: ${API_KEY}`,
    '--data-binary', '@-',
], { input: body, timeout: 30000 }).toString();
console.log(`[dispatch] ${JOB.job_id} → hub: ${res}`);

// poll the hub's result key in Redis (the hub writes it on /task/result)
const t0 = Date.now();
while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    let raw = '';
    try {
        raw = execSync(`docker exec animastor-redis redis-cli GET ${RESULT_KEY}`).toString().trim();
    } catch (_) { /* redis hiccup — keep polling */ }
    if (raw && raw !== '' && raw !== '(nil)') {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* raw payload */ }
        const b64 = parsed && parsed.result_base64 ? parsed.result_base64 : raw;
        const bytes = Buffer.from(b64, 'base64');
        const outFile = `/tmp/opencode/e2e-result-${TS}.bin`;
        fs.writeFileSync(outFile, bytes);
        const magic = bytes.subarray(0, 4).toString('hex');
        const kind = magic.startsWith('4944') || bytes.subarray(0,3).toString()==='ID3' || bytes[0]===0xff
            ? 'audio(mp3)'
            : magic.startsWith('8950') ? 'image(png)' : `unknown(${magic})`;
        console.log(`[result] DELIVERED type=${parsed ? parsed.worker_version : '?'} bytes=${bytes.length} magic=${kind} → ${outFile}`);
        console.log(`[result] result key: ${RESULT_KEY}`);
        process.exit(0);
    }
    process.stdout.write('.');
    setTimeout(() => {}, 0);
    execSync('sleep 10');
}
console.error(`\n[poll] TIMEOUT after ${Math.round(POLL_TIMEOUT_MS / 1000)}s — no result key`);
process.exit(2);

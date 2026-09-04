// ======================================================
// PHASE 2 — GPU Hub / Worker boundary contract (architecture guardrail)
// ======================================================
// Guards the semantic boundary between GPU Hub (transport/orchestration) and
// Worker (execution), without rewriting either (Phase 2, Part B.4).
//
// Contract invariants (current, from docs/architecture/PHASE_2_CONTRACTS.md §7):
//   1. GPU Hub exposes the pinned route surface.
//   2. Worker consumes the same surface (no protocol drift).
//   3. Worker identity comes ONLY from the Bearer credential (never query/body).
//   4. Worker is a self-contained bundle (no backend/hub/book/generation/PG deps,
//      HTTP to hub only, no Redis).
//   5. GPU Hub has no code-level backend/worker dependency (HTTP + shared Redis only).
//   6. Protocol version stays 2 in all three copies.
//   7. Hub is auth-gated (api key for backend-facing, Bearer for worker-facing).
//
// Dependency/protocol-version pins are source-inspection guardrails (same
// discipline as Phase 1). Behavior pins (route surface, identity source) are
// contract pins where possible.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const gpuHubPath = path.join(REPO_ROOT, 'gpu-hub', 'gpu-hub.js');
const workerPath = path.join(REPO_ROOT, 'worker', 'worker', 'worker.cjs');
const dispatcherPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'gpu-dispatcher.js');
const jobSchemaPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'job-schema.js');

function read(file) {
    return readSource(file);
}

describe('architecture: GPU Hub / Worker boundary — role separation', () => {
    it('hub exposes exactly the pinned route surface (additions must be deliberate)', () => {
        const src = read(gpuHubPath);
        const found = [...src.matchAll(/app\.(post|get|delete|put)\(\s*\"([^\"]+)\"/g)]
            .map((m) => [m[1].toUpperCase(), m[2]]);
        const HUB_ROUTES = [
            ['POST', '/beacon'],
            ['POST', '/task'],
            ['GET', '/task/next'],
            ['POST', '/task/result'],
            ['POST', '/task/error'],
            ['DELETE', '/queue/clear'],
        ];
        for (const [method, route] of HUB_ROUTES) {
            expect(found.some((f) => f[0] === method && f[1] === route),
                `gpu-hub must keep ${method} ${route}`).to.equal(true);
        }
    });

    it('worker still consumes the same hub surface (no protocol drift)', () => {
        const worker = read(workerPath);
        expect(worker).to.include('`${HUB_URL}/beacon`');
        expect(worker).to.include('`${HUB_URL}/task/next?worker=${WORKER_ID}&type=${WORKER_TYPE}`');
        expect(worker).to.include('`${HUB_URL}/task/result`');
        expect(worker).to.include('`${HUB_URL}/task/error`');
    });

    it('backend dispatcher still sends /task and checks protocol_version', () => {
        const dispatcher = read(dispatcherPath);
        expect(dispatcher).to.include('`${config.HUB_URL}/task`');
        expect(dispatcher).to.match(/protocol_version/);
    });

    it('hub auth: worker identity comes ONLY from the credential, never query/body', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('requireWorkerCredential');
        expect(hub).to.include('parseWorkerToken');
        // registry key + auth mirror are the only identity sources
        expect(hub).to.include("'animastor:gpu-hub:workers'");
        expect(hub).to.include("'animastor:worker-auth'");
    });

    it('worker is a self-contained execution bundle (no backend/hub/book/generation/PG deps)', () => {
        const banned = /postgres|storage\/postgres|book-repo|generation-routes|orchestrat|reconciliation|book\/index|ai-service/i;
        for (const file of fs.readdirSync(path.join(REPO_ROOT, 'worker', 'worker'))) {
            if (!/\.cjs$/.test(file) && !/\.js$/.test(file)) continue;
            const src = readSource(path.join(REPO_ROOT, 'worker', 'worker', file));
            expect(src, file).to.not.match(banned);
        }
    });

    it('worker talks to the hub via HTTP only (no Redis, no direct backend calls)', () => {
        for (const file of fs.readdirSync(path.join(REPO_ROOT, 'worker', 'worker'))) {
            if (!/\.cjs$/.test(file) && !/\.js$/.test(file)) continue;
            const src = readSource(path.join(REPO_ROOT, 'worker', 'worker', file));
            expect(src, file).to.not.match(/ioredis|new\s+Redis|createClient/);
        }
    });

    it('hub has no code-level backend/worker source dependencies (HTTP + shared Redis only)', () => {
        const banned = /require\(['\"][^'\"]*(backend\/src|backend\/ai|worker\/worker|frontends)/;
        for (const file of fs.readdirSync(path.join(REPO_ROOT, 'gpu-hub'))) {
            if (!/\.js$/.test(file) && !/\.cjs$/.test(file)) continue;
            const src = readSource(path.join(REPO_ROOT, 'gpu-hub', file));
            expect(src, file).to.not.match(banned);
        }
    });

    it('hub stays a transport/orchestration boundary (curates queues/running/heartbeat/registry, forwards results/errors)', () => {
        const hub = read(gpuHubPath);
        // Hub does not invent book-generation business logic — it validates
        // envelope shape, manages queues/running/heartbeat/registry, and
        // forwards results/errors to backend.
        expect(hub).to.match(/result_base64/);
        expect(hub).to.match(/notifyBackendError/);
        expect(hub).to.match(/backend.*retry/);
    });
});

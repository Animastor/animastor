'use strict';

/**
 * Docker deployment tests — the deployment dimension WITHOUT a docker daemon.
 *
 * Docker is a DEPLOYMENT of the linux platform (never an OS). These tests pin
 * the deployment-adapter contract and the container-artifact security gates
 * that the VPS E2E relies on (docker/worker/Dockerfile + entrypoint.sh):
 *   1. adapter surface: container paths, volume mapping, GPU runtime flags,
 *      connectivity (loopback ComfyUI), container-owned lifecycle;
 *   2. composition: linux+docker is experimental, linux+native unchanged,
 *      docker on windows rejected;
 *   3. entrypoint fail-closed credential gates (env + argv) — bootstrap
 *      parity inside the container;
 *   4. entrypoint integrity gate: hub-published sha256 must be verified
 *      before the installer bundle is persisted;
 *   5. entrypoint lifecycle: install on first boot, idempotent resume after
 *      container restart, runtime containers stay alive as PID 1;
 *   6. the container never installs an NVIDIA driver (GPU belongs to the
 *      host runtime).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const platforms = require('../src/installer/platform');
const docker = require('../src/installer/platform/deployment/docker');
const native = require('../src/installer/platform/deployment/native');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCKER_DIR = path.join(REPO_ROOT, 'docker', 'worker');

describe('docker deployment adapter', () => {
    it('is experimental and explicitly NOT production-supported', () => {
        assert.strictEqual(docker.name, 'docker');
        assert.strictEqual(docker.productionReady, false);
        assert.strictEqual(docker.experimental, true);
        assert.strictEqual(docker.requiresPlatform, 'linux');
    });

    it('keeps the whole installation under ONE container volume root', () => {
        assert.strictEqual(docker.paths.data, '/data/animastor');
        for (const key of ['root', 'workerDir', 'toolsDir', 'stateDir']) {
            assert.ok(docker.paths[key].startsWith('/data/animastor/'),
                `${key} must live on the persistent volume (got ${docker.paths[key]})`);
        }
    });

    it('maps host ~/animastor/data to the container root', () => {
        const vm = docker.volumeMap();
        assert.ok(Array.isArray(vm) && vm.length >= 1);
        assert.strictEqual(vm[0].container, '/data/animastor');
        assert.ok(typeof vm[0].host === 'string' && vm[0].host.length > 0);
    });

    it('GPU access comes from the HOST runtime (flag, never a driver install)', () => {
        assert.strictEqual(docker.gpuRuntime.flag, '--gpus all');
        assert.ok(/Container Toolkit|host/i.test(docker.gpuRuntime.note));
    });

    it('connectivity: ComfyUI on loopback, worker makes only OUTBOUND calls', () => {
        assert.strictEqual(docker.connectivity.comfyuiBase(8188), 'http://127.0.0.1:8188');
        assert.ok(/OUTBOUND/i.test(docker.connectivity.note));
    });

    it('lifecycle: the CONTAINER owns processes — the installer never manages docker', () => {
        assert.strictEqual(docker.lifecycle, 'container');
        assert.strictEqual(native.lifecycle, 'process');
    });

    it('mapPath is identity in both deployment adapters (paths chosen by the caller)', () => {
        assert.strictEqual(docker.mapPath('/x/y'), '/x/y');
        assert.strictEqual(native.mapPath('/x/y'), '/x/y');
    });
});

describe('deployment composition via resolveRuntime', () => {
    it('linux + native stays production-ready (docker work must not change native)', () => {
        const rt = platforms.resolveRuntime({ platform: 'linux', deployment: 'native', env: {} });
        assert.strictEqual(rt.deployment, 'native');
        assert.strictEqual(rt.productionReady, true);
    });

    it('linux + docker resolves but is NOT production-ready', () => {
        const rt = platforms.resolveRuntime({ platform: 'linux', deployment: 'docker', env: {} });
        assert.strictEqual(rt.deployment, 'docker');
        assert.strictEqual(rt.productionReady, false);
    });

    it('docker deployment on the windows platform is rejected', () => {
        assert.throws(
            () => platforms.resolveRuntime({ platform: 'windows', deployment: 'docker', env: {} }),
            /docker deployment requires the linux platform/,
        );
    });
});

describe('container entrypoint security and lifecycle gates', () => {
    const entrypoint = fs.readFileSync(path.join(DOCKER_DIR, 'entrypoint.sh'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(DOCKER_DIR, 'Dockerfile'), 'utf8');

    it('refuses Worker Key material through the environment (fail-closed, bootstrap parity)', () => {
        for (const v of ['ANIMASTOR_WORKER_TOKEN', 'WORKER_TOKEN', 'WORKER_KEY']) {
            assert.ok(entrypoint.includes(v), `entrypoint must gate ${v}`);
        }
        assert.ok(/refusing to start/.test(entrypoint));
    });

    it('refuses credential material through argv', () => {
        assert.ok(/wrk\.\*/.test(entrypoint), 'wrk.* argv pattern must be gated');
        assert.ok(/worker-key=/.test(entrypoint));
    });

    it('verifies the hub-published installer bundle sha256 before persisting it', () => {
        assert.ok(entrypoint.includes('/installer/bundle'));
        assert.ok(entrypoint.includes('/installer/sha256'));
        assert.ok(entrypoint.includes('sha256sum'));
        assert.ok(/mismatch/.test(entrypoint), 'a checksum mismatch must abort the boot');
    });

    it('persists the installer ON THE VOLUME so tools survive container replacement', () => {
        assert.ok(/DATA=\/data\/animastor/.test(entrypoint), 'volume root variable');
        assert.ok(/INSTALLER_DIR="\$DATA\/installer"/.test(entrypoint), 'installer persisted under the volume');
        assert.ok(entrypoint.includes('cp -a'));
    });

    it('installs on first boot and resumes (auto-reconnect) on every later boot', () => {
        assert.ok(/install-state\.json/.test(entrypoint), 'boot decision reads the install state');
        const resumeIdx = entrypoint.indexOf('resume');
        const installIdx = entrypoint.indexOf('install --profile');
        assert.ok(resumeIdx !== -1 && installIdx !== -1, 'both paths must exist');
        assert.ok(/stays alive/.test(entrypoint), 'runtime containers stay alive as PID 1');
        assert.ok(/ANIMASTOR_EXIT_AFTER_INSTALL/.test(entrypoint), 'install containers must propagate the installer exit code');
    });

    it('never installs an NVIDIA driver inside the container', () => {
        assert.ok(!/nvidia-driver|NVIDIA.*Driver.*apt/i.test(dockerfile));
        assert.ok(/Container Toolkit/.test(dockerfile), 'the GPU contract is documented for the HOST');
    });

    it('runs as a dedicated non-root user matching the host account', () => {
        assert.ok(/useradd .* -u 1001/.test(dockerfile), 'uid 1001 keeps volume ownership consistent');
        assert.ok(/^USER animastor$/m.test(dockerfile));
    });
});

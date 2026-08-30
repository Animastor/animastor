'use strict';

/**
 * Docker deployment adapter — ARCHITECTURAL PREPARATION ONLY.
 *
 * Docker is a DEPLOYMENT of a platform (linux), never an OS platform: the
 * installer still runs under the linux platform adapter inside the
 * container. This module prepares the deployment-specific touchpoints
 * (container paths, volume mapping, GPU runtime flags, connectivity,
 * lifecycle semantics) WITHOUT declaring docker production-supported.
 *
 * Status: experimental. Nothing in the setup contract or CLI advertises
 * docker yet; real validation happens on a VPS integration test before the
 * productionReady flag may flip.
 */

const NAME = 'docker';

// In-container layout: everything under a single volume mount so the whole
// installation survives container replacement.
const CONTAINER_ROOT = '/data/animastor';

module.exports = {
    name: NAME,
    displayName: 'Docker (experimental)',
    productionReady: false, // NOT production-supported until VPS-validated
    experimental: true,
    requiresPlatform: 'linux',

    /** Container paths (inside the container, all under one volume). */
    paths: {
        root: `${CONTAINER_ROOT}/comfyui`,
        workerDir: `${CONTAINER_ROOT}/worker`,
        toolsDir: `${CONTAINER_ROOT}/tools`,
        stateDir: `${CONTAINER_ROOT}/state`,
        data: CONTAINER_ROOT,
    },

    /**
     * Suggested volume mapping (host → container) for the reference image.
     * The engine never invents host paths; this is documentation for the
     * future docker integration test / compose file.
     */
    volumeMap() {
        return [
            { host: '~/animastor/data', container: CONTAINER_ROOT },
        ];
    },

    /** GPU runtime requirements for the container runtime. */
    gpuRuntime: {
        flag: '--gpus all',
        note: 'NVIDIA Container Toolkit must be installed on the host; the container sees the GPU through nvidia-smi as usual.',
    },

    /**
     * Lifecycle: processes are owned by the CONTAINER, not by the installer.
     * stop/restart of the installation inside the container stays valid
     * (uid-guarded process management), but container start/stop/restart is
     * the orchestrator's job (docker stop/restart), never the installer's.
     */
    lifecycle: 'container',

    /** Connectivity: worker↔ComfyUI on loopback inside the container. */
    connectivity: {
        comfyuiBase: (port) => `http://127.0.0.1:${port}`,
        note: 'The worker only makes OUTBOUND calls to the hub — no inbound ports are required (publish nothing).',
    },

    /**
     * Path mapping for the engine: roots inside the container follow the
     * container layout when the caller did not pin explicit paths.
     */
    mapPath(p) {
        return p;
    },
};

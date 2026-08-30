'use strict';

/**
 * Native deployment adapter — the default: components run directly on the
 * host OS (detached daemons, files under the user's home). This is what the
 * installer has always done on Linux; the module exists so the engine can
 * ask for deployment behaviour explicitly instead of assuming it.
 */

const NAME = 'native';

module.exports = {
    name: NAME,
    displayName: 'Native',
    productionReady: true,

    /**
     * Paths used as-is: the roots the user/CLI chose are the real roots.
     * (A container deployment would remap these to volume targets.)
     */
    mapPath(p) {
        return p;
    },

    /**
     * Service start/stop/restart are plain detached processes owned by the
     * installer (see engine/comfyui.js and engine/worker.js) — no container
     * lifecycle layer involved.
     */
    lifecycle: 'process',

    /** Connectivity assumptions: everything on loopback of the same host. */
    connectivity: {
        comfyuiBase: (port) => `http://127.0.0.1:${port}`,
    },
};

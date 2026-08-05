// ======================================================
// Config Routes — GET /api/v1/config
// ======================================================
// Tests that the config endpoint serves the editor limits:
//   1. Returns 200 with a { limits: {...} } object
//   2. Serves the exact backend constant IMAGE_PROMPT_MAX_CHARS
//   3. The limit matches the save-boundary validation ceiling the editors
//      enforce (core-routes.cjs prompt guard, IMAGE_PROMPT_MAX_CHARS = 2000)

const { expect } = require('chai');
const express = require('express');

const { IMAGE_PROMPT_MAX_CHARS } = require('../src/services/agent-prompts');
const configRoutes = require('../src/routes/config-routes.cjs');

/** Boot the real config route on an ephemeral port (no supertest dep). */
function startConfigServer() {
    const app = express();
    configRoutes(app);
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            resolve({
                base: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((res) => server.close(res)),
            });
        });
    });
}

describe('GET /api/v1/config', () => {
    let srv;

    before(async () => {
        srv = await startConfigServer();
    });

    after(async () => {
        await srv.close();
    });

    it('returns 200 with a limits object', async () => {
        const res = await fetch(`${srv.base}/api/v1/config`);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body).to.have.property('limits');
        expect(body.limits).to.have.property('image_prompt_max_chars');
    });

    it('serves the exact backend IMAGE_PROMPT_MAX_CHARS constant', async () => {
        const res = await fetch(`${srv.base}/api/v1/config`);
        const body = await res.json();
        expect(body.limits.image_prompt_max_chars).to.equal(IMAGE_PROMPT_MAX_CHARS);
        expect(IMAGE_PROMPT_MAX_CHARS).to.be.above(0);
    });

    it('limit matches the save-boundary ceiling the editors enforce (2000)', async () => {
        const res = await fetch(`${srv.base}/api/v1/config`);
        const body = await res.json();
        // Documented contract: the editors (Android + web) enforce this same
        // value and the server rejects over-limit saves in core-routes.cjs.
        expect(body.limits.image_prompt_max_chars).to.equal(2000);
    });
});

// ======================================================
// Profile Override — functional user profile selection
// ======================================================
// Tests for:
//   - profile-override.js: setOverride/getOverride/resolvePromptProfiles
//   - connector-routes: GET /profiles (effective) + PUT /profiles (persist)
// ======================================================

const { expect } = require('chai');
const express = require('express');

// buildMergedDialogueWorkflow needs the real workflows loaded (loadWorkflows is
// normally called at backend startup, not on require).
const wfLoader = require('../src/workflows/workflow-loader');
before(() => { wfLoader.loadWorkflows(); });

const profileOverride = require('../src/services/profile-override');

// Reset the cache between tests so choices never leak across test cases.
afterEach(async () => {
    await profileOverride.setOverride('audio', null);
    await profileOverride.setOverride('image', null);
    await profileOverride.setOverride('video', null);
});

describe('profile-override (unit)', () => {

    it('starts with no overrides — connector profiles win', () => {
        expect(profileOverride.getOverrides()).to.deep.equal({ audio: null, image: null, video: null });
        expect(profileOverride.resolvePromptProfiles()).to.deep.equal({
            audioProfile: 'qwen-tts',
            imageProfile: 'qwen-image',
            videoProfile: 'ltx-2.3',
        });
    });

    it('connectorProfileName reads the profile field from the canonical connector', () => {
        expect(profileOverride.connectorProfileName('audio')).to.equal('qwen-tts');
        expect(profileOverride.connectorProfileName('image')).to.equal('qwen-image');
        expect(profileOverride.connectorProfileName('video')).to.equal('ltx-2.3');
    });

    it('setOverride stores the choice and resolvePromptProfiles honors it', async () => {
        await profileOverride.setOverride('image', 'qwen-image');
        expect(profileOverride.getOverride('image')).to.equal('qwen-image');
        expect(profileOverride.resolvePromptProfiles().imageProfile).to.equal('qwen-image');
        // Other types stay connector-derived
        expect(profileOverride.resolvePromptProfiles().audioProfile).to.equal('qwen-tts');
        expect(profileOverride.resolvePromptProfiles().videoProfile).to.equal('ltx-2.3');
    });

    it('clearing an override falls back to the connector profile', async () => {
        await profileOverride.setOverride('video', 'ltx-2.3');
        expect(profileOverride.resolvePromptProfiles().videoProfile).to.equal('ltx-2.3');
        await profileOverride.setOverride('video', '');
        expect(profileOverride.resolvePromptProfiles().videoProfile).to.equal('ltx-2.3');
    });

    it('unknown types are never treated as overrides', async () => {
        expect(profileOverride.getOverride('nope')).to.equal(null);
    });
});

// ── Routes ──────────────────────────────────────────────

const connectorRoutes = require('../src/routes/connector-routes.cjs');
const wfManager = require('../src/services/workflow-manager');

/** Boot the real connector routes on an ephemeral port (no supertest dep). */
function startProfilesServer() {
    const app = express();
    app.use(express.json());
    connectorRoutes(app, null, { wfManager, utils: { log: () => {} } });
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            resolve({
                base: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((res) => server.close(res)),
            });
        });
    });
}

describe('Connector profile routes', () => {
    let srv;

    before(async () => {
        srv = await startProfilesServer();
    });

    after(async () => {
        await srv.close();
    });

    it('GET /profiles returns connector-derived profiles when no override is set', async () => {
        const res = await fetch(`${srv.base}/api/v1/connectors/profiles`);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.profiles.audio).to.equal('qwen-tts');
        expect(body.profiles.image).to.equal('qwen-image');
        expect(body.profiles.video).to.equal('ltx-2.3');
        // options lists the selectable profiles from skill files — real profiles
        // only ('default' was removed)
        for (const type of ['audio', 'image', 'video']) {
            expect(Array.isArray(body.options[type])).to.be.true;
            expect(body.options[type]).to.not.include('default');
        }
    });

    it('PUT /profiles persists a choice and GET reflects it', async () => {
        const put = await fetch(`${srv.base}/api/v1/connectors/profiles`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'image', profile: 'qwen-image' }),
        });
        expect(put.status).to.equal(200);
        const putBody = await put.json();
        expect(putBody.ok).to.be.true;
        expect(putBody.profiles.image).to.equal('qwen-image');

        const res = await fetch(`${srv.base}/api/v1/connectors/profiles`);
        const body = await res.json();
        expect(body.profiles.image).to.equal('qwen-image');
        expect(body.profiles.audio).to.equal('qwen-tts');
    });

    it('PUT with null clears the override — connector profile returns', async () => {
        await fetch(`${srv.base}/api/v1/connectors/profiles`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'video', profile: 'ltx-2.3' }),
        });
        let res = await fetch(`${srv.base}/api/v1/connectors/profiles`);
        expect((await res.json()).profiles.video).to.equal('ltx-2.3');

        const clear = await fetch(`${srv.base}/api/v1/connectors/profiles`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'video', profile: null }),
        });
        expect(clear.status).to.equal(200);

        res = await fetch(`${srv.base}/api/v1/connectors/profiles`);
        expect((await res.json()).profiles.video).to.equal('ltx-2.3');
    });

    it('PUT rejects an unknown type', async () => {
        const res = await fetch(`${srv.base}/api/v1/connectors/profiles`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'music', profile: 'default' }),
        });
        expect(res.status).to.equal(400);
    });

    it('PUT rejects profiles not present on disk (incl. the removed "default")', async () => {
        for (const profile of ['does-not-exist', 'default']) {
            const res = await fetch(`${srv.base}/api/v1/connectors/profiles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'image', profile }),
            });
            expect(res.status, `profile ${profile}`).to.equal(400);
        }
    });
});

// ======================================================
// @animastor/generation — package-own test suite
// ======================================================
// Runs STANDALONE (`npm test` inside packages/animastor-generation) with no
// backend source tree and no host adapters — the package must be loadable
// and testable independently (S-7 G7-L). Host ports are wired with pure
// package-side stubs through the public API; nothing from backend/src is
// required anywhere in this suite.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §29

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const generation = require('../src/index.js');

// Pure package-side config stub (the canonical value shapes of the
// GenerationConfig port contract — no host runtime-config involvement).
const STUB_CONFIG = {
    leaseTtlS: { AUDIO: 1200, IMAGE: 1800, VIDEO: 1800 },
    quotas: { MAX_ACTIVE_AUDIO: 8, MAX_ACTIVE_IMAGE: 4, MAX_ACTIVE_VIDEO: 2 },
    stuckThresholds: {
        AUDIO_GENERATING: 15, AUDIO_PENDING: 15,
        IMAGE_GENERATING: 30, IMAGE_PENDING: 30,
        VIDEO_GENERATING: 60, VIDEO_PENDING: 60,
    },
};

describe('@animastor/generation package', () => {

    after(() => {
        // hygiene: drop the stub wiring so a same-process consumer starts clean
        generation.ports.generationConfig._resetGenerationConfig();
        generation.mediaRegistry._clearRegistry();
    });

    // ── physical layout & isolation ─────────────────────────────────
    it('loads standalone from its physical location (no host wiring required)', () => {
        const entry = path.join(__dirname, '..', 'src', 'index.js');
        const gen = require(entry);
        expect(Object.keys(gen).sort()).to.deep.equal([
            'artifactNaming', 'bootstrap', 'comfyuiProvider', 'generationProgress',
            'mediaRegistry', 'ports', 'promptProfiles', 'sceneState',
        ]);
        delete require.cache[require.resolve(entry)];
    });

    it('package source contains no backend requires (self-guard)', () => {
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!/\.(js|cjs)$/.test(entry.name)) continue;
                const src = fs.readFileSync(full, 'utf8');
                const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
                for (const spec of specs) {
                    if (/backend|(^|\.\.\/)+src\//.test(spec)) offenders.push(`${full}: ${spec}`);
                }
            }
        })(path.join(__dirname, '..', 'src'));
        expect(offenders).to.deep.equal([]);
    });

    it('exports map exposes the root only (no accidental deep imports)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        expect(pkg.exports).to.deep.equal({ '.': './src/index.js' });
        expect(() => require('../src/core/artifact-naming.js')).to.not.throw(); // direct file load still works for tooling
        expect(() => require('@animastor/generation/core/artifact-naming')).to.throw(); // but not as a package subpath
    });

    // ── ports: fail-fast + wiring through the public API ────────────
    it('ports fail fast when unwired and accept the documented binding shapes', () => {
        const { generationConfig, dispatchTransport, profileStore, bookData } = generation.ports;
        expect(generationConfig.CONFIG_KEYS).to.deep.equal(['leaseTtlS', 'quotas', 'stuckThresholds']);
        expect(() => generationConfig.generationConfig()).to.throw(/not wired/);
        expect(() => generationConfig.setGenerationConfig(null)).to.throw(/adapter is required/);
        expect(() => generationConfig.setGenerationConfig({ leaseTtlS: {} })).to.throw(/must provide 'quotas'/);
        expect(() => dispatchTransport.dispatch({})).to.throw(/not wired/);
        expect(() => dispatchTransport.setDispatchTransport({ nope: 1 })).to.throw(/must implement dispatch/);
        expect(() => profileStore.getAssemblyProfile('image/x')).to.throw(/not wired/);
        expect(() => bookData.tokensToString(['x'])).to.throw(/not wired/);
        expect(() => bookData.setBookData({ collectSceneUnits: () => [] })).to.throw(/must implement tokensToString/);
    });

    // ── media registry + bootstrap (S-2 domain) ─────────────────────
    it('bootstrap() registers the default media capabilities through the config port (no host fallback)', () => {
        generation.ports.generationConfig.setGenerationConfig(STUB_CONFIG);
        generation.bootstrap();
        const registry = generation.mediaRegistry;
        expect(registry.listMediaTypes()).to.deep.equal(['audio', 'image', 'video']);
        // values flow 1:1 from the wired config slices
        expect(registry.resolveLeaseTtl('audio')).to.equal(STUB_CONFIG.leaseTtlS.AUDIO);
        expect(registry.resolveLeaseTtl('video')).to.equal(STUB_CONFIG.leaseTtlS.VIDEO);
        expect(registry.resolveMaxActive('image')).to.equal(STUB_CONFIG.quotas.MAX_ACTIVE_IMAGE);
        expect(registry.resolveStuckThresholds('video').generatingMinutes).to.equal(STUB_CONFIG.stuckThresholds.VIDEO_GENERATING);
        // registry canonical homes (job timeouts + per-scene retry limits)
        expect(registry.resolveJobTimeout('audio')).to.equal(30 * 60 * 1000);
        expect(registry.resolveJobTimeout('video')).to.equal(60 * 60 * 1000);
        expect(registry.resolveRetryBudget('audio')).to.equal(10);
        expect(registry.resolveRetryBudget('video')).to.equal(5);
        expect(registry.resolveCancelStages('image')).to.deep.equal(['image']);
        expect(registry.resolveValidWorkerTypes()).to.deep.equal(new Set(['audio', 'image', 'video']));
        expect(registry.hasMediaType('hologram')).to.equal(false);
        expect(registry.isValidWorkerType('hologram')).to.equal(false);
    });

    // ── scene-state FSM contract (S-4 domain) ───────────────────────
    it('scene-state exposes the frozen per-asset FSM contract', () => {
        const fsm = generation.sceneState;
        expect(fsm.AssetState).to.deep.equal({
            NEW: 'new', DIRTY: 'dirty', PENDING: 'pending', GENERATING: 'generating',
            READY: 'ready', FAILED: 'failed', PLACEHOLDER: 'placeholder',
        });
        expect(fsm.ASSETS.includes('audio')).to.equal(true);
        expect(fsm.ASSETS.join(',')).to.equal('audio,image,video');
        expect(fsm.validateAssetTransition('new', 'dirty').valid).to.equal(true);
        expect(fsm.validateAssetTransition('ready', 'pending').valid).to.equal(false);
        expect(fsm.validateAssetTransition('ready', 'ready').reason).to.equal('same_state');
        expect(fsm.validateAssetUpdate('audio', 'ready')).to.equal(null);
        expect(fsm.validateAssetUpdate('hologram', 'ready')).to.match(/Invalid asset type/);
        expect(fsm.validateAssetUpdate('audio', 'ascended')).to.match(/Invalid asset status/);
        expect(fsm.validateAssetUpdates({ audio: 'ready', video: 'pending' })).to.equal(null);
        expect(fsm.validateAssetUpdates({ audio: 'ascended' })).to.match(/Invalid asset status/);
        expect(fsm.normalizeAssetStates({})).to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
        expect(fsm.normalizeAssetStates({ audio: 'ready' })).to.deep.equal({ audio: 'ready', image: 'new', video: 'new' });
    });

    // ── artifact naming grammar (S-4 single owner) ──────────────────
    it('artifact-naming produces the frozen filename grammar', () => {
        const naming = generation.artifactNaming;
        expect(naming.scenePrefix('bk', 'ch1', 'sc2')).to.equal('bk_ch1_sc2');
        expect(naming.sceneAudioName('bk', 'ch1', 'sc2')).to.equal('bk_ch1_sc2.mp3');
        expect(naming.sceneChunkAudioName('bk', 'ch1', 'sc2', 3)).to.equal('bk_ch1_sc2_0003.mp3');
        expect(naming.sceneImageName('bk', 'ch1', 'sc2', 'iu0007')).to.equal('bk_ch1_sc2_iu0007.png');
        expect(naming.sceneImagePreviewName('bk', 'ch1', 'sc2', 'iu0007')).to.equal('bk_ch1_sc2_pr0007.png');
        expect(naming.sceneVideoName('bk', 'ch1', 'sc2')).to.equal('bk_ch1_sc2.mp4');
        expect(naming.sceneVideoGroupName('bk', 'ch1', 'sc2', '_g2')).to.equal('bk_ch1_sc2_g2.mp4');
        expect(naming.iuAssetId('bk', 'ch1', 'sc2', 7)).to.equal('bk_ch1_sc2_7');
    });

    // ── generation-progress pure domain (S-4) ───────────────────────
    it('generation-progress exposes the pure task-registry domain (no persistence API)', () => {
        const progress = generation.generationProgress;
        for (const fn of Object.keys(progress)) {
            expect(['createTaskRecords', 'filterTaskMap', 'sceneTaskState', 'hasActiveTasks',
                'activeTasksByType', 'taskId', 'normalizeScope', 'targetsForType', 'buildTask',
                'WORKER_TYPES', 'TERMINAL_RETENTION_MS'].includes(fn),
            `no persistence API on the pure core: ${fn}`).to.equal(true);
        }
        expect(progress.normalizeScope({ chapterId: 'ch1' })).to.deep.equal({ scope: 'whole_book', chapter_id: 'ch1', scene_id: null });
        expect(progress.taskId('audio')).to.match(/^generation-audio-\d+-[0-9a-f]{8}$/);
        const task = progress.buildTask('audio', progress.normalizeScope({}), [{ chapter_id: 'c', scene_id: 's' }]);
        expect(task).to.include({ type: 'audio', status: 'active', chapter_id: null, scene_id: null });
        expect(task.task_id).to.be.a('string');
    });

    // ── prompt profiles (S-4 domain, ProfileStore port) ─────────────
    it('prompt-profiles resolve through the ProfileStore port and normalize text purely', () => {
        const { promptProfiles, ports } = generation;
        ports.profileStore.setProfileStore({
            getAssemblyProfile: (name) => ({
                profileName: name,
                sections: ['core', 'style'],
                defaults: { defaultInstruct: 'stub-instruct' },
            }),
        });
        try {
            const cfg = promptProfiles.assemblyProfile.resolveAssembly('image', 'stub-profile');
            expect(cfg.profileName).to.equal('stub-profile'); // the stub store was consulted
            expect(cfg.sections).to.be.an('array').that.is.not.empty;
            expect(cfg.defaults).to.be.an('object');
            expect(promptProfiles.promptTextUtils.escapeRegExp('a.b*c')).to.equal('a\\.b\\*c');
            expect(promptProfiles.promptTextUtils.normalizeForMatch('Мама-Мыла_раму!')).to.equal('mama myla ramu');
            expect(promptProfiles.promptTextUtils.isSafeCharacterAlias('Мама')).to.equal(true);
            expect(promptProfiles.promptTextUtils.isSafeCharacterAlias('the')).to.equal(false);
            // aliasIndex form: alias → character id (Latin transliteration extended)
            const refs = promptProfiles.characterUtils.normalizeCharacterRefs(
                'Мама мыла раму', null, { 'мама': 'char_mama' });
            expect(refs).to.equal('char_mama мыла раму');
        } finally {
            ports.profileStore._resetProfileStore();
        }
    });

    // ── comfyui-provider seam (S-3, DispatchTransport port) ─────────
    it('comfyui-provider dispatches through the DispatchTransport port (payload preserved)', async () => {
        const { comfyuiProvider, ports } = generation;
        const seen = [];
        ports.dispatchTransport.setDispatchTransport({
            dispatch: async (taskSpec) => { seen.push(taskSpec); return { sent: true, jobId: taskSpec.job_id, dispatchId: taskSpec.dispatch_id }; },
        });
        try {
            const res = await comfyuiProvider.generate({
                jobId: 'bk_ch1_sc2_0001',
                workflow: { prompt: 'hello' },
                jobType: 'audio',
                buildId: 'b-1',
                dispatchId: 'd-1',
                timeoutMs: 60000,
            });
            expect(res).to.deep.equal({ sent: true, jobId: 'bk_ch1_sc2_0001', dispatchId: 'd-1' });
            expect(seen[0]).to.deep.equal({
                job_id: 'bk_ch1_sc2_0001',
                params: { prompt: 'hello' },
                job_type: 'audio',
                build_id: 'b-1',
                dispatch_id: 'd-1',
                timeout_ms: 60000,
            });
            // camelCase sugar stripped; provider exposes no cancel surface
            expect(comfyuiProvider.cancel).to.equal(undefined);
            expect(comfyuiProvider.PROVIDER_NAME).to.equal('comfyui');
            expect(comfyuiProvider.WORKFLOW_NAMES).to.deep.equal({
                narration: 'tts-qwen-narrator',
                dialogue: 'tts-qwen-dialogue',
                image: 'img-qwen-image',
                videoFamily: 'video-ltx',
            });
            expect(comfyuiProvider.profileNameFromConnector({ profile: { audioProfile: 'p1' } }, 'audio')).to.equal('p1');
            expect(comfyuiProvider.profileNameFromConnector(null, 'audio')).to.equal(null);
        } finally {
            ports.dispatchTransport._resetDispatchTransport();
        }
    });

    it('_clearRegistry suppresses re-bootstrap (S-2 test-hook contract) — runs last, poisons registry', () => {
        generation.mediaRegistry._clearRegistry();
        expect(generation.mediaRegistry.hasMediaType('audio')).to.equal(false); // suppression
        expect(generation.mediaRegistry.listMediaTypes()).to.deep.equal([]);
    });
});

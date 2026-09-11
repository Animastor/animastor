// ======================================================
// S-4 — Shared Infrastructure Moves (architecture guards)
// ======================================================
// Pins the S-4 result: Generation Core shared infrastructure physically
// relocated into the Generation Core contour — since S-7 that contour IS the
// @animastor/generation package (packages/animastor-generation/src; the
// intermediate backend/src/generation/ area is GONE). Behavior-neutral;
// guards freeze the dependency direction:
//
//   Generation Core (package core/*, prompt-profiles/*, moved utils)
//       ↓
//   Generation media capabilities (audio/image/video/workflows — host tier)
//       ↓
//   Generation provider / ports (comfyui-provider, media-registry — package)
//       ↓
//   Host adapters (storage, redis, config, routes — host)
//
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const PKG_SRC = path.join(__dirname, '..', '..', '..', 'packages', 'animastor-generation', 'src');

function read(p) {
    return fs.readFileSync(path.join(SRC, p), 'utf8');
}

function readPkg(p) {
    return fs.readFileSync(path.join(PKG_SRC, p), 'utf8');
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(js|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function relativeToSrc(full) {
    return path.relative(SRC, full).replace(/\\/g, '/');
}

/** Extract literal require() targets from a source string. */
function requiresOf(source) {
    const specs = [];
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
    return specs;
}

// The Generation Core tier after S-4 (pure shared components; registry is the
// media-capability seam). S-7: package-owned files are read from PKG_SRC;
// the one shared host util (speech-estimation, §26.2 verdict) stays host-side.
const S4_CORE_PKG_FILES = [
    'core/artifact-naming.js',
    'core/generation-progress.js',
    'core/scene-state.js',
    'core/media-registry.js',
    'prompt-profiles/assembly-profile.js',
    'prompt-profiles/character-utils.js',
    'prompt-profiles/prompt-text-utils.js',
];
const S4_CORE_HOST_FILES = [
    'utils/speech-estimation.js',
];
const S4_CORE_ALL = [
    ...S4_CORE_PKG_FILES.map(f => ({ file: f, src: readPkg(f) })),
    ...S4_CORE_HOST_FILES.map(f => ({ file: f, src: read(f) })),
];

// S-7: the S-4 transition shims for the moved core are DELETED (consumers use
// the package public API). The one host-internal surface shim that remains is
// state/scene-state.js (state-layer re-export over the Redis host adapter,
// not a package shim).
const DELETED_SHIM_FILES = [
    'image/assembly-profile.js',
    'image/character-utils.js',
];
const REMAINING_HOST_SHIM_FILES = [
    'state/scene-state.js',
];

// Host adapters that own the Redis persistence split out of the S-4 core in
// the correction pass (audit 8e77d950): pure logic stays in the package,
// Redis keys + client calls live here. Their public API is unchanged.
const S4_HOST_REDIS_ADAPTERS = [
    'services/generation-progress.js',
    'state/asset-state-store.js',
];

describe('S-4: shared infrastructure moves', () => {
    // ─────────────────────────────────────────────────────────────
    // S4-A — Generation Core does not import VBook/Player/Editor
    // ─────────────────────────────────────────────────────────────
    it('S4-A: Generation Core requires no VBook/Player/Editor/Book modules', () => {
        const forbidden = [
            /@animastor\/player/, /@animastor\/editor/, /@animastor\/vbook-runtime/,
            /(^|\/|\.\.\/)book(\.js|\.cjs|\/|')/, /services\/agent/,
            /agent-service/, /window-generator/, /agent-prompts/,
        ];
        for (const { file, src } of S4_CORE_ALL) {
            for (const spec of requiresOf(src)) {
                for (const re of forbidden) {
                    expect(re.test(spec), `${file} must not require '${spec}'`).to.equal(false);
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-B — Generation Core does not import GPU/ComfyUI
    // ─────────────────────────────────────────────────────────────
    it('S4-B: Generation Core requires no GPU Hub/Worker/ComfyUI/gpu-dispatcher', () => {
        const forbidden = [
            /animastor-gpu-hub/, /animastor-worker/, /animastor-comfyui-workflow-connector/,
            /gpu-dispatcher/, /HUB_URL/,
        ];
        for (const { file, src } of S4_CORE_ALL) {
            for (const spec of requiresOf(src)) {
                for (const re of forbidden) {
                    expect(re.test(spec), `${file} must not require '${spec}' (provider/gpu seam lives outside the S-4 core tier)`).to.equal(false);
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-C — Core does not depend on HTTP/Express
    // ─────────────────────────────────────────────────────────────
    it('S4-C: Generation Core requires no express/http/router modules', () => {
        const forbidden = [/^express$/, /^http$/, /^https$/, /router/, /middleware\//, /routes\//];
        for (const { file, src } of S4_CORE_ALL) {
            for (const spec of requiresOf(src)) {
                for (const re of forbidden) {
                    expect(re.test(spec), `${file} must not require '${spec}'`).to.equal(false);
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-D — Core has no direct host Redis/PG/config/filesystem dependencies
    // ─────────────────────────────────────────────────────────────
    // Strengthened after the S-4 audit: the original guard only checked
    // require() literals, so a Core file could still receive a redis client
    // and call `.hset(...) / .hgetall(...) / .del(...) / .expire(...)` on it.
    // The guard now inspects the SOURCE of every Core file for:
    //   1. host module requires (redis, ioredis, pg, fs, runtime-config, storage)
    //   2. direct Redis command calls on ANY receiver (.hset(, .hget(, ...)
    //   3. any method call on a passed-in redis-like client (redis.h*(), redisClient.*())
    //   4. env/config/filesystem reads (process.env, readFileSync, ...)

    /** Redis command names — direct `.cmd(` calls are forbidden in Core. */
    const REDIS_COMMANDS = [
        'hset', 'hsetnx', 'hget', 'hgetall', 'hdel', 'hkeys', 'hvals', 'hlen', 'hexists', 'hincrby',
        'del', 'unlink', 'expire', 'pexpire', 'expireat', 'ttl', 'pttl', 'persist', 'setex', 'setnx',
        'incr', 'incrby', 'decr', 'decrby',
        'sadd', 'srem', 'smembers', 'sismember', 'spop', 'scard',
        'lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen', 'lrem', 'lindex',
        'zadd', 'zrem', 'zrange', 'zscore', 'zcard',
        'mget', 'mset', 'getset', 'scan',
        'publish', 'subscribe', 'psubscribe', 'punsubscribe',
        'xadd', 'xlen', 'xrange', 'xreadgroup',
    ];
    const REDIS_OPS_RE = new RegExp(`\\.(${REDIS_COMMANDS.join('|')})\\s*\\(`);
    /** Any method call on a passed-in redis-like client: `redis.*(`, `redisClient.*(`, `redisConn.*(`. */
    const PASSED_CLIENT_RE = /\bredis[A-Za-z0-9_]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(/;
    /** Redis client construction. */
    const CLIENT_CTOR_RE = /\b(?:new\s+Redis\b|createClient\s*\()/;
    const HOST_REQUIRES_RE = [
        /ioredis/,
        /require\(\s*['"](redis|fake-redis|redis-mock)['"]\s*\)/,
        /require\(\s*['"]pg['"]\s*\)/,
        /postgres/, /database/, /\.\.\/storage/, /storage\/postgres/,
        /config\/runtime-config/, /require\(\s*['"][^'"]*runtime-config['"]\s*\)/,        /require\(\s*['"](fs|fs\/promises)['"]\s*\)/,
        /require\(\s*['"]node:fs(?:\/promises)?['"]\s*\)/,
    ];
    const FILESYSTEM_ACCESS_RE = /\b(?:readFile|writeFile|appendFile|readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|rmSync|createReadStream|createWriteStream)\s*\(/;
    const ENV_CONFIG_ACCESS_RE = [/process\.env/, /\bprocess\.cwd\b/, /\bruntimeConfig\b/];

    function assertCoreIsHostFree(file, src) {
        for (const re of HOST_REQUIRES_RE) {
            for (const spec of requiresOf(src)) {
                expect(re.test(spec), `${file} must not require '${spec}' (host clients must be injected — S-6 ports)`).to.equal(false);
            }
            // require()-target check only for the generic host-module patterns —
            // comments may mention them (e.g. the media-registry header).
            if (re.source !== 'config\\/runtime-config') {
                expect(re.test(src), `${file} must not reference host modules (${re})`).to.equal(false);
            }
        }
        expect(REDIS_OPS_RE.test(src), `${file} must not issue Redis commands directly (.${REDIS_COMMANDS.join('/.')} — persistence belongs to the host adapter)`).to.equal(false);
        expect(PASSED_CLIENT_RE.test(src), `${file} must not call methods on a passed-in redis client (S-6 RedisPort owns persistence)`).to.equal(false);
        expect(CLIENT_CTOR_RE.test(src), `${file} must not construct Redis clients`).to.equal(false);
        expect(FILESYSTEM_ACCESS_RE.test(src), `${file} must not touch the filesystem directly (S-6 FileSystemPort)`).to.equal(false);
        for (const re of ENV_CONFIG_ACCESS_RE) {
            expect(re.test(src), `${file} must not read env/config directly (${re})`).to.equal(false);
        }
    }

    it('S4-D: Generation Core has no direct redis/pg/config/storage dependencies', () => {
        for (const { file, src } of S4_CORE_ALL) {
            assertCoreIsHostFree(file, src);
        }
        // S-6 UPDATE: the documented host-adapter dependency (ai-loader
        // inside assembly-profile, pinned since S-4 as the future port) is
        // GONE — profile files load through the Generation-owned ProfileStore
        // port (package ports/profile-store.js). NO S4 core file may
        // require a host service; assembly-profile must consume the port.
        const coreWithHostAdapter = S4_CORE_ALL.filter(({ src }) => requiresOf(src).some(s => /ai-loader/.test(s)));
        expect(coreWithHostAdapter.map(f => f.file), 'core must not require host services — use the ProfileStore port').to.deep.equal([]);
        expect(requiresOf(readPkg('prompt-profiles/assembly-profile.js')),
            'assembly-profile must load profiles through ports/profile-store')
            .to.include('../ports/profile-store');
    });

    // ─────────────────────────────────────────────────────────────
    // S4-D2 — the whole Generation Core contour is Redis-free
    // ─────────────────────────────────────────────────────────────
    // Core-adjacent files (S-2/S-3 seams: media registry bootstrap, provider
    // seam, registrations — all package-owned since S-7) are classified in
    // the recon doc; NONE of them may implement Redis persistence or touch
    // the filesystem directly.
    it('S4-D2: no file under the package implements Redis persistence or fs access', () => {
        for (const full of walk(PKG_SRC)) {
            const rel = path.relative(PKG_SRC, full).replace(/\\/g, '/');
            const src = fs.readFileSync(full, 'utf8');
            expect(REDIS_OPS_RE.test(src), `${rel} issues Redis commands directly — move persistence to a host adapter`).to.equal(false);
            expect(PASSED_CLIENT_RE.test(src), `${rel} calls methods on a passed-in redis client — move persistence to a host adapter`).to.equal(false);
            expect(CLIENT_CTOR_RE.test(src), `${rel} constructs a Redis client`).to.equal(false);
            expect(FILESYSTEM_ACCESS_RE.test(src), `${rel} touches the filesystem directly`).to.equal(false);
            expect(/require\(\s*['"](fs|fs\/promises|node:fs(?:\/promises)?)['"]\s*\)/.test(src), `${rel} requires fs`).to.equal(false);
        }
        // The Redis key namespaces previously owned by core files now have a
        // single host-adapter owner each (core is key-agnostic).
        const all = walk(SRC).map(f => [relativeToSrc(f), fs.readFileSync(f, 'utf8')]);
        const singleDef = (pattern, canonical) => {
            const owners = all.filter(([file, src]) => pattern.test(src)).map(([file]) => file);
            expect(owners, `${canonical} must be the only owner of this Redis key namespace`).to.deep.equal([canonical]);
        };
        singleDef(/const KEY_PREFIX = 'animastor:generation-progress'/, 'services/generation-progress.js');
        singleDef(/const ASSET_STATE_KEY_PREFIX = 'animastor:asset-state'/, 'state/asset-state-store.js');
    });

    // ─────────────────────────────────────────────────────────────
    // S4-E — no duplicate Generation Core implementations
    // ─────────────────────────────────────────────────────────────
    it('S4-E: each relocated core utility has exactly one implementation', () => {
        const all = [
            ...walk(SRC).map(f => [relativeToSrc(f), fs.readFileSync(f, 'utf8')]),
            ...walk(PKG_SRC).map(f => [`@pkg/${path.relative(PKG_SRC, f).replace(/\\/g, '/')}`, fs.readFileSync(f, 'utf8')]),
        ];
        const singleDef = (pattern, canonical) => {
            const owners = all.filter(([file, src]) => pattern.test(src)).map(([file]) => file);
            const canonicalKey = canonical.startsWith('@pkg/') ? canonical : canonical;
            expect(owners, `${canonical} must be the only implementation`).to.include(canonicalKey);
            expect(owners.filter(f => f !== canonicalKey), `duplicate implementations of ${canonical}: ${owners.filter(f => f !== canonicalKey).join(', ')}`).to.deep.equal([]);
        };
        singleDef(/function estimateSpeechDurationSec/, 'utils/speech-estimation.js');
        singleDef(/function normalizeCharacterRefs/, '@pkg/prompt-profiles/character-utils.js');
        singleDef(/function resolveAssembly/, '@pkg/prompt-profiles/assembly-profile.js');
        singleDef(/function sceneChunkAudioName/, '@pkg/core/artifact-naming.js');
        // S-7: the old image/ shims are GONE (no logic migrated back);
        // the two Redis adapters split out of the core are real modules (not shims)
        for (const shim of DELETED_SHIM_FILES) {
            expect(fs.existsSync(path.join(SRC, shim)), `${shim} must stay deleted (package public API replaced it in S-7)`).to.equal(false);
        }
        for (const shim of REMAINING_HOST_SHIM_FILES) {
            const src = read(shim);
            expect(src, `${shim} must stay a one-line re-export shim`).to.match(/module\.exports\s*=\s*require\(/);
        }
        for (const adapter of S4_HOST_REDIS_ADAPTERS) {
            expect(read(adapter), `${adapter} must exist as the Redis host adapter`).to.be.a('string').that.is.not.empty;
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-D3 — the split core/adapter pair keeps behavior parity
    // ─────────────────────────────────────────────────────────────
    // The Redis adapter owns the key namespace + client calls; the core owns
    // the domain logic. The adapter must delegate to the core (dependency
    // direction core ← adapter, never the reverse) and expose the frozen
    // registry API.
    it('S4-D3: generation-progress Redis adapter delegates to the pure core (API frozen)', () => {
        const coreSrc = readPkg('core/generation-progress.js');
        const adapterSrc = read('services/generation-progress.js');
        // dependency direction: adapter → package core (S-7: via public API)
        expect(adapterSrc).to.match(/require\(\s*['"]@animastor\/generation['"]\s*\)\.generationProgress/);
        expect(coreSrc).to.not.match(/require\(\s*['"][^'"]*services\//);
        // frozen registry API (generation-progress.test.js, happy-path, progress-panel)
        const progress = require(path.join(SRC, 'services', 'generation-progress.js'));
        for (const fn of ['createTasks', 'listTasks', 'getTask', 'updateTask', 'markCompleted',
            'markCancelled', 'getSceneTaskState', 'hasActiveTasks', 'getActiveTasksByType',
            'reconcileCompletedTasks', 'removeTask', 'clear']) {
            expect(progress[fn], `services/generation-progress.${fn}`).to.be.a('function');
        }
        expect(progress.KEY_PREFIX).to.equal('animastor:generation-progress');
        expect(progress.TTL_SECONDS).to.equal(4 * 60 * 60);
        // pure core exposes NO persistence surface
        const coreExports = require(path.join(PKG_SRC, 'core', 'generation-progress.js'));
        for (const fn of Object.keys(coreExports)) {
            expect(['createTaskRecords', 'filterTaskMap', 'sceneTaskState', 'hasActiveTasks',
                'activeTasksByType', 'taskId', 'normalizeScope', 'targetsForType', 'buildTask',
                'WORKER_TYPES', 'TERMINAL_RETENTION_MS'].includes(fn),
            `package generation-progress must not export persistence API: ${fn}`).to.equal(true);
        }
    });

    it('S4-D3: asset-state Redis adapter delegates to the pure FSM core (API frozen)', () => {
        const coreSrc = readPkg('core/scene-state.js');
        const adapterSrc = read('state/asset-state-store.js');
        // dependency direction: adapter → package core (S-7: via public API)
        expect(adapterSrc).to.match(/require\(\s*['"]@animastor\/generation['"]\s*\)\.sceneState/);
        expect(coreSrc).to.not.match(/require\(\s*['"][^'"]*state\//);
        // frozen FSM surface (asset-state.test.js, scene-state.test.js, redis-ownership)
        const store = require(path.join(SRC, 'state', 'asset-state-store.js'));
        expect(store.ASSETS.join(',')).to.equal('audio,image,video');
        expect(store.AssetState.READY).to.equal('ready');
        expect(store.validateAssetTransition('new', 'dirty').valid).to.equal(true);
        expect(store.validateAssetTransition('ready', 'pending').valid).to.equal(false);
        expect(store.ASSET_STATE_KEY_PREFIX).to.equal('animastor:asset-state');
        for (const fn of ['getAssetStates', 'unsafeRestoreAssetState', 'unsafeRestoreAssetStates', 'setAssetState', 'setAssetStates']) {
            expect(store[fn], `state/asset-state-store.${fn}`).to.be.a('function');
        }
        // pure core exposes NO persistence surface
        const coreExports = require(path.join(PKG_SRC, 'core', 'scene-state.js'));
        for (const fn of Object.keys(coreExports)) {
            expect(['AssetState', 'ASSETS', 'validateAssetTransition', 'normalizeAssetStates',
                'validateAssetUpdate', 'validateAssetUpdates'].includes(fn),
            `package scene-state must not export persistence API: ${fn}`).to.equal(true);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-F — artifact/job-id grammar has a single canonical owner
    // ─────────────────────────────────────────────────────────────
    it('S4-F: the scene artifact grammar is owned solely by the package artifact-naming module', () => {
        const grammarRe = /`\$\{\s*bookId\s*\}_\$\{\s*(chapterId|chapter|s\.chapter_id|ds\.chapter_id|scene\.chapter_id|sceneData\.chapter_id|result\.chapter\.chapter|sceneData\.chapter)\s*\}_\$\{\s*(sceneId|s\.scene_id|ds\.scene_id|scene\.scene_id|sceneData\.scene_id)\s*\}/;
        const all = walk(SRC).map(f => [relativeToSrc(f), fs.readFileSync(f, 'utf8')]);
        const offenders = all
            .filter(([file, src]) => grammarRe.test(src))
            .map(([file]) => file);
        expect(offenders, `raw scene-grammar literals outside the canonical owner (package core/artifact-naming.js): ${offenders.join(', ')}`).to.deep.equal([]);
        // the canonical owner still defines the grammar (now package-owned)
        expect(grammarRe.test(readPkg('core/artifact-naming.js')),
            'the package artifact-naming module must remain the grammar owner').to.equal(true);
        // the writer-side host adapter composes through the owner (no local redefinition)
        const fsStore = read('storage/filesystem-store.js');
        for (const fn of ['makeSceneAudioFilename', 'makeChunkAudioFilename', 'makeIUImageFilename', 'makePreviewFilename']) {
            expect(fsStore, `${fn} must delegate to the canonical grammar`).to.match(new RegExp(`artifactNaming\\.[a-zA-Z]+`));
        }
    });

    it('S4-F: the canonical grammar is byte-compatible with the Player naming contract', () => {
        const naming = require(path.join(PKG_SRC, 'core', 'artifact-naming.js'));
        const playerNaming = require(path.join(__dirname, '..', '..', '..', 'packages', 'animastor-player', 'src', 'artifact-naming.cjs'));
        expect(naming.sceneAudioName('b', 'c', 's')).to.equal(playerNaming.sceneAudioName('b', 'c', 's'));
        expect(naming.sceneVideoName('b', 'c', 's')).to.equal(playerNaming.sceneVideoName('b', 'c', 's'));
        expect(naming.sceneVideoGroupName('b', 'c', 's', '_g2')).to.equal(playerNaming.sceneVideoGroupName('b', 'c', 's', 2));
        expect(naming.sceneImageName('b', 'c', 's', 'iu0001')).to.equal(playerNaming.iuImageName('b', 'c', 's', 'iu0001'));
        expect(naming.sceneImageBaseName('b', 'c', 's')).to.equal(playerNaming.sceneImageName('b', 'c', 's'));
        expect(naming.iuImagePrefix('b', 'c', 's')).to.equal(playerNaming.iuImagePrefix('b', 'c', 's'));
    });

    // ─────────────────────────────────────────────────────────────
    // S4-G — media namespaces do not import each other
    // ─────────────────────────────────────────────────────────────
    it('S4-G: audio/image/video/workflows have no cross-media module imports', () => {
        const mediaDirs = ['audio', 'image', 'video', 'workflows'];
        const scanned = [];
        for (const dir of mediaDirs) {
            for (const full of walk(path.join(SRC, dir))) {
                scanned.push([dir, full]);
            }
        }
        for (const [dir, full] of scanned) {
            for (const spec of requiresOf(fs.readFileSync(full, 'utf8'))) {
                const m = spec.match(/(?:^|\.\.\/|\.\.\/\.\.\/|\.\/)(audio|image|video)(?=\/|')/);
                if (m) {
                    const rel = relativeToSrc(full);
                    expect(m[1], `${rel} must not import the ${m[1]} media namespace ('${spec}'; shared pieces live in @animastor/generation now)`)
                        .to.not.equal(dir);
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────
    // S4-H — Player/Editor/VBook boundary surfaces stay intact
    // ─────────────────────────────────────────────────────────────
    it('S4-H: boundary suites\u2019 pinned surfaces stay alive through the package public API', () => {
        // scene-state FSM surface (asset-state.test.js, scene-state.test.js, redis-ownership)
        const sceneState = require(path.join(SRC, 'state', 'scene-state.js'));
        expect(sceneState.ASSETS.join(',')).to.equal('audio,image,video');
        // task registry surface (generation-progress.test.js, happy-path, progress-panel)
        const progress = require(path.join(SRC, 'services', 'generation-progress.js'));
        expect(progress.createTasks).to.be.a('function');
        expect(progress.KEY_PREFIX).to.equal('animastor:generation-progress');
        // image public surface — S-7: consumed through the package root
        // (coreference-image.test.js consumes image-service, which delegates
        // to the package character-utils)
        const charUtils = require(path.join(PKG_SRC, 'prompt-profiles', 'character-utils.js'));
        expect(charUtils.normalizeCharacterRefs('x', [])).to.equal('x');
        // assembly profile surface (assembly-profile.test.js, audio-profile.test.js — S-7: package root)
        const assembly = require('@animastor/generation').promptProfiles.assemblyProfile;
        expect(assembly.resolveAssembly('audio').defaults).to.have.property('defaultInstruct');
        // the shared speech heuristic surface (visuals-duration.test.js, scene-split.test.js)
        const speech = require(path.join(SRC, 'utils', 'speech-estimation.js'));
        expect(speech.estimateSpeechDurationSec('')).to.equal(2);
        expect(speech.estimateSpeechDurationSec('one two three four five six seven')).to.equal(2.1);
    });
});

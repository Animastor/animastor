// ======================================================
// animastor-worker — .env loader tests (worker-env.cjs)
// ======================================================
// The bundle must work standalone: `cp .env.example .env && node worker.cjs`.
// worker-env.cjs provides the dependency-free loader; these tests pin its
// behavior (ported verbatim from backend/tests/worker-bundle-env.test.js,
// Phase 9D moved package-owned unit tests into the package):
//   - no .env → no-op (environment variables only);
//   - real environment variables ALWAYS win over the file;
//   - comments/blank/malformed lines are ignored, quotes stripped;
//   - worker.cjs wires the loader in before reading its config.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const BUNDLE_DIR = path.join(__dirname, '..', 'worker');
const { loadDotEnv, parseEnvLine } = require(path.join(BUNDLE_DIR, 'worker-env.cjs'));

describe('worker bundle — .env loader (worker-env.cjs)', () => {
    let tmpDir;
    const savedEnv = {};

    function track(key, value) {
        if (!(key in savedEnv)) savedEnv[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }

    it('parses KEY=VALUE lines; ignores comments/blanks/malformed; strips quotes', () => {
        expect.deepEqual(parseEnvLine('FOO=bar'), ['FOO', 'bar']);
        expect.deepEqual(parseEnvLine('  export FOO="bar baz"  '), ['FOO', 'bar baz']);
        expect.deepEqual(parseEnvLine("FOO='quoted'"), ['FOO', 'quoted']);
        expect.equal(parseEnvLine('# comment'), null);
        expect.equal(parseEnvLine(''), null);
        expect.equal(parseEnvLine('not an env line'), null);
        expect.equal(parseEnvLine('1BAD=x'), null);
    });

    it('no .env file → false, environment untouched', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-env-'));
        track('WORKER_ENV_TEST_A', undefined);
        delete process.env.WORKER_ENV_TEST_A;
        expect.equal(loadDotEnv(tmpDir), false);
        expect.equal(process.env.WORKER_ENV_TEST_A, undefined);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads .env values into process.env', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-env-'));
        track('HUB_URL', undefined);
        track('WORKER_TYPE', undefined);
        delete process.env.HUB_URL;
        delete process.env.WORKER_TYPE;
        fs.writeFileSync(path.join(tmpDir, '.env'), [
            '# Animastor worker env',
            'HUB_URL=https://animastor.in/gpu',
            '',
            'WORKER_TYPE=image',
        ].join('\n'));
        expect.equal(loadDotEnv(tmpDir), true);
        expect.equal(process.env.HUB_URL, 'https://animastor.in/gpu');
        expect.equal(process.env.WORKER_TYPE, 'image');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        track('HUB_URL', undefined); delete process.env.HUB_URL;
        track('WORKER_TYPE', undefined); delete process.env.WORKER_TYPE;
    });

    it('REAL environment variables always win over the file', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-env-'));
        track('ANIMASTOR_WORKER_TOKEN', 'wrk.fromenv.envsecret');
        fs.writeFileSync(path.join(tmpDir, '.env'), 'ANIMASTOR_WORKER_TOKEN=wrk.fromfile.filesecret\n');
        expect.equal(loadDotEnv(tmpDir), true);
        expect.equal(process.env.ANIMASTOR_WORKER_TOKEN, 'wrk.fromenv.envsecret');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        track('ANIMASTOR_WORKER_TOKEN', undefined); delete process.env.ANIMASTOR_WORKER_TOKEN;
    });
});

describe('worker bundle — self-contained wiring', () => {
    it('worker.cjs loads the env loader before reading its config', () => {
        const src = fs.readFileSync(path.join(BUNDLE_DIR, 'worker.cjs'), 'utf8');
        const requireAt = src.indexOf('require("./worker-env.cjs")');
        const configAt = src.indexOf('const HUB_URL = process.env.HUB_URL');
        expect.ok(requireAt > -1, 'worker-env.cjs must be required by worker.cjs');
        expect.ok(configAt > -1, 'worker.cjs config section must exist');
        expect.ok(requireAt < configAt, 'the .env loader must run before the config section');
    });
});

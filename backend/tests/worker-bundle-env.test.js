// ======================================================
// Worker bundle — self-contained .env loading (Phase 3.1)
// ======================================================
// The bundle-based Existing ComfyUI flow must work with a single archive:
// `cp .env.example .env && node worker.cjs`. worker-env.cjs provides the
// dependency-free loader; these tests pin its behavior:
//   - no .env → no-op (environment variables only);
//   - real environment variables ALWAYS win over the file;
//   - comments/blank/malformed lines are ignored, quotes stripped;
//   - the loader is part of the published bundle and wired into worker.cjs.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER_DIR = path.join(__dirname, '..', '..', 'worker', 'worker');
const { loadDotEnv, parseEnvLine } = require(path.join(WORKER_DIR, 'worker-env.cjs'));

describe('worker bundle — .env loader (worker-env.cjs)', () => {
    let tmpDir;
    const savedEnv = {};

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-env-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
            delete savedEnv[k];
        }
    });

    function track(key, value) {
        if (!(key in savedEnv)) savedEnv[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }

    it('parses KEY=VALUE lines; ignores comments/blanks/malformed; strips quotes', () => {
        expect(parseEnvLine('FOO=bar')).to.deep.equal(['FOO', 'bar']);
        expect(parseEnvLine('  export FOO="bar baz"  ')).to.deep.equal(['FOO', 'bar baz']);
        expect(parseEnvLine("FOO='quoted'")).to.deep.equal(['FOO', 'quoted']);
        expect(parseEnvLine('# comment')).to.equal(null);
        expect(parseEnvLine('')).to.equal(null);
        expect(parseEnvLine('not an env line')).to.equal(null);
        expect(parseEnvLine('1BAD=x')).to.equal(null);
    });

    it('no .env file → false, environment untouched', () => {
        track('WORKER_ENV_TEST_A', undefined);
        delete process.env.WORKER_ENV_TEST_A;
        expect(loadDotEnv(tmpDir)).to.equal(false);
        expect(process.env.WORKER_ENV_TEST_A).to.equal(undefined);
    });

    it('loads .env values into process.env', () => {
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
        expect(loadDotEnv(tmpDir)).to.equal(true);
        expect(process.env.HUB_URL).to.equal('https://animastor.in/gpu');
        expect(process.env.WORKER_TYPE).to.equal('image');
    });

    it('REAL environment variables always win over the file', () => {
        track('ANIMASTOR_WORKER_TOKEN', 'wrk.fromenv.envsecret');
        fs.writeFileSync(path.join(tmpDir, '.env'), 'ANIMASTOR_WORKER_TOKEN=wrk.fromfile.filesecret\n');
        expect(loadDotEnv(tmpDir)).to.equal(true);
        expect(process.env.ANIMASTOR_WORKER_TOKEN).to.equal('wrk.fromenv.envsecret');
    });
});

describe('worker bundle — self-contained wiring (Phase 3.1)', () => {
    it('worker.cjs loads the env loader before reading its config', () => {
        const src = fs.readFileSync(path.join(WORKER_DIR, 'worker.cjs'), 'utf8');
        const requireAt = src.indexOf('require("./worker-env.cjs")');
        const configAt = src.indexOf('const HUB_URL = process.env.HUB_URL');
        expect(requireAt).to.be.greaterThan(-1);
        expect(configAt).to.be.greaterThan(-1);
        expect(requireAt).to.be.lessThan(configAt); // loader runs first
    });

    it('the manifest file lists ship the loader with every profile bundle', () => {
        const manifests = path.join(__dirname, '..', 'ai', 'install-manifests');
        for (const type of fs.readdirSync(manifests).sort()) {
            const typeDir = path.join(manifests, type);
            if (!fs.statSync(typeDir).isDirectory()) continue;
            for (const file of fs.readdirSync(typeDir).sort()) {
                if (!file.endsWith('.json')) continue;
                const m = JSON.parse(fs.readFileSync(path.join(typeDir, file), 'utf8'));
                expect(m.worker_bundle.files, `${type}/${file}`).to.include('worker-env.cjs');
            }
        }
    });
});

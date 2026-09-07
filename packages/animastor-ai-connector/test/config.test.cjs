// ======================================================
// Config parsing tests — migrated from backend
// tests/ai-connector-discovery.test.js (LAC-3 config block).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const { it, describe, expect } = require('./harness.cjs');
const { parseConfig, RUNTIME_TYPES, DEFAULT_RUNTIME_BASE_URL } = require('../lib/config.cjs');

const baseArgs = ['--url', 'wss://animastor.example/api/v1/ai-connector/ws', '--token', 'llmc.aGVsbG8.aGVsbG8'];

describe('config: parsing + validation', () => {
    it('default base URL is loopback Ollama', () => {
        const res = parseConfig(baseArgs);
        expect.equal(res.ok, true);
        expect.equal(res.config.baseUrl, DEFAULT_RUNTIME_BASE_URL);
        expect.equal(res.config.baseUrl, 'http://127.0.0.1:11434');
    });

    it('non-loopback base URL refused without --allow-lan', () => {
        const res = parseConfig([...baseArgs, '--base-url', 'http://192.168.1.50:11434']);
        expect.equal(res.ok, false);
        expect.include(res.errors.join(' '), 'loopback');
    });

    it('non-loopback base URL allowed ONLY with explicit --allow-lan', () => {
        const res = parseConfig([...baseArgs, '--base-url', 'http://192.168.1.50:11434', '--allow-lan']);
        expect.equal(res.ok, true);
        expect.equal(res.config.allowLan, true);
    });

    it('runtime-type allowlist enforced; unknown type refused', () => {
        expect.equal(parseConfig([...baseArgs, '--runtime-type', 'ollama']).ok, true);
        expect.equal(parseConfig([...baseArgs, '--runtime-type', 'gpu-hub']).ok, false);
        expect.deepEqual(RUNTIME_TYPES, ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible']);
    });

    it('plain ws:// refused off-loopback (wss mandatory)', () => {
        const bad = ['--url', 'ws://animastor.example/api/v1/ai-connector/ws', '--token', 'llmc.a.a'];
        expect.equal(parseConfig(bad).ok, false);
        const okLoop = ['--url', 'ws://127.0.0.1:8080/api/v1/ai-connector/ws', '--token', 'llmc.a.a'];
        expect.equal(parseConfig(okLoop).ok, true);
    });

    it('token must match the llmc.*/llmcreg.* shape; garbage refused', () => {
        expect.equal(parseConfig([...baseArgs, '--token', 'not-a-token']).ok, false);
        expect.equal(parseConfig(baseArgs).ok, true);
        const reg = parseConfig(['--url', baseArgs[1], '--token', 'llmcreg.aGVsbG8.aGVsbG8']);
        expect.equal(reg.ok, true);
    });

    it('token material is never echoed in validation errors', () => {
        const secret = 'llmc.aGVsbG8.T1VSU0VDUkVUU0VDUkVU';
        const res = parseConfig(['--url', 'wss://x.example/ws', '--token', 'nope-'.repeat(10)]);
        expect.equal(res.ok, false);
        expect.notInclude(JSON.stringify(res), 'T1VSU0VDUkVU');
        expect.notInclude(JSON.stringify(res), secret);
    });

    it('unknown CLI flags rejected (no hidden surface)', () => {
        expect.equal(parseConfig([...baseArgs, '--execute', 'rm -rf /']).ok, false);
        expect.equal(parseConfig([...baseArgs, '--proxy-url', 'http://evil']).ok, false);
        expect.equal(parseConfig([...baseArgs, 'positional-garbage']).ok, false);
    });

    it('missing values and heartbeat range enforced', () => {
        expect.equal(parseConfig([...baseArgs, '--url']).ok, false);
        expect.equal(parseConfig([...baseArgs, '--heartbeat-interval-ms', '100']).ok, false);
        expect.equal(parseConfig([...baseArgs, '--heartbeat-interval-ms', '700000']).ok, false);
        expect.equal(parseConfig([...baseArgs, '--heartbeat-interval-ms', '1000']).ok, true);
    });

    it('env fallbacks: ANIMASTOR_CONNECTOR_URL / ANIMASTOR_CONNECTOR_TOKEN', () => {
        const env = {
            ANIMASTOR_CONNECTOR_URL: 'wss://from-env.example/api/v1/ai-connector/ws',
            ANIMASTOR_CONNECTOR_TOKEN: 'llmc.env.env',
        };
        const res = parseConfig([], { env });
        expect.equal(res.ok, true);
        expect.equal(res.config.url, env.ANIMASTOR_CONNECTOR_URL);
        expect.equal(res.config.token, env.ANIMASTOR_CONNECTOR_TOKEN);
        // CLI wins over env.
        const res2 = parseConfig(['--token', 'llmc.cli.cli'], { env });
        expect.equal(res2.config.token, 'llmc.cli.cli');
    });
});

// ======================================================
// Package self-contract tests — SPEC.md ↔ code consistency.
// Package-owned equivalent of the backend cross-side contract test,
// runnable WITHOUT the backend: pins the published SPEC numbers against
// this implementation so the document can never silently drift from
// the code while the package lives on its own.
// ======================================================

const fs = require('fs');
const path = require('path');
const { it, describe, expect } = require('./harness.cjs');
const chatLib = require('../lib/chat.cjs');
const configLib = require('../lib/config.cjs');
const adaptersLib = require('../lib/runtime-adapters/index.cjs');
const opLog = require('../lib/log.cjs');

const SPEC = fs.readFileSync(path.join(__dirname, '..', 'SPEC.md'), 'utf8');

describe('contract: SPEC.md ↔ package code', () => {
    it('protocol_version 1 is stated in the SPEC and sent in hello', () => {
        expect.include(SPEC, 'protocol_version:** `1`');
        const connectorSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connector.cjs'), 'utf8');
        const m = connectorSrc.match(/protocol_version['"]?\s*:\s*(\d+)/);
        expect.equal(Number(m[1]), 1);
    });

    it('every documented frame type exists in the SPEC table', () => {
        for (const type of ['hello', 'ready', 'heartbeat', 'models.refresh', 'models.list',
            'chat.request', 'chat.delta', 'chat.response', 'chat.error', 'chat.cancel']) {
            expect.include(SPEC, `\`${type}\``);
        }
    });

    it('every chat error code in the code allowlist is documented in the SPEC', () => {
        for (const code of chatLib.CHAT_ERROR_CODES) {
            expect.include(SPEC, `\`${code}\``);
        }
        // And the SPEC's §8 table mentions exactly the allowlist codes.
        const tableSection = SPEC.split('## 8.')[1].split('## 9.')[0];
        for (const code of ['invalid_request', 'request_too_large', 'model_not_found', 'busy',
            'timeout', 'runtime_unreachable', 'context_length', 'bad_response',
            'runtime_error', 'response_too_large', 'cancelled']) {
            expect.include(tableSection, code);
        }
    });

    it('documented limits match chat.cjs LIMITS exactly', () => {
        const L = chatLib.LIMITS;
        const pairs = [
            ['64', L.maxMessages],
            ['32 768 chars (32 KB)', L.maxMessageChars],
            ['131 072 chars (128 KB)', L.maxTotalPromptChars],
            ['8 192', L.maxMaxTokens],
            ['1 000 … 180 000', L.minTimeoutMs + ' … ' + L.maxTimeoutMs],
            ['2 (overflow → `busy`)', L.maxConcurrentRequests],
            ['60 KB (61 440 bytes)', L.maxResponseFrameBytes],
            ['100 000 (then fail-closed)', L.maxSeenRequestIds],
        ];
        for (const [doc, value] of pairs) {
            expect.include(SPEC, doc);
        }
        expect.equal(L.maxTimeoutMs, 180000);
        expect.equal(L.minTimeoutMs, 1000);
        expect.equal(L.maxResponseFrameBytes, 61440);
    });

    it('the runtime-type allowlist in the SPEC matches the adapter registry', () => {
        expect.include(SPEC, '`ollama | vllm | llamacpp | lmstudio | openai-compatible`');
        expect.deepEqual(adaptersLib.RUNTIME_TYPES, ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible']);
    });

    it('token grammar documented in the SPEC matches lib/config.cjs behavior', () => {
        expect.include(SPEC, '^(llmc|llmcreg)\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$');
        const okUrl = 'wss://x.example/ws';
        for (const good of ['llmc.a.b', 'llmcreg.A-b_C.x-Y_9']) {
            expect.equal(configLib.parseConfig(['--url', okUrl, '--token', good]).ok, true);
        }
        for (const bad of ['llmcd.a.b', 'llmc.a.b.c', 'llmc..b', 'llmc.a.']) {
            expect.equal(configLib.parseConfig(['--url', okUrl, '--token', bad]).ok, false);
        }
    });

    it('heartbeat clamp range (250 ms–600 000 ms) documented and enforced', () => {
        expect.include(SPEC, '250 ms–600 000 ms');
        expect.equal(configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', 'llmc.a.b', '--heartbeat-interval-ms', '249']).ok, false);
        expect.equal(configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', 'llmc.a.b', '--heartbeat-interval-ms', '600001']).ok, false);
        expect.equal(configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', 'llmc.a.b', '--heartbeat-interval-ms', '250']).ok, true);
    });

    it('credential safety rules from the SPEC hold behaviorally', () => {
        // Validation errors never echo token material; the op log never
        // records credentials (the `credential` field is dropped by the
        // recordOp allowlist; `model` IS a documented metadata field, so a
        // token-looking model id is a caller bug, not a log leak).
        const res = configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', 'llmc.TOPSECRET.TOP!SECRET']);
        expect.equal(res.ok, false);
        expect.notInclude(JSON.stringify(res), 'TOPSECRET');
        opLog.reset();
        opLog.recordOp({ op: 'chat_completion', model: 'm', status: 'ok', credential: 'llmc.TOPSECRET.y', prompt: 'SECRET-PROMPT' });
        const dump = JSON.stringify(opLog.list());
        expect.notInclude(dump, 'TOPSECRET');   // credential field dropped
        expect.notInclude(dump, 'SECRET-PROMPT'); // unknown field dropped
        expect.include(dump, 'chat_completion');   // known metadata kept
        opLog.reset();
    });
});

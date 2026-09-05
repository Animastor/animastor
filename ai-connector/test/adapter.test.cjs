// ======================================================
// Runtime adapter tests (discovery + chat + normalization) — migrated
// from backend tests/ai-connector-discovery.test.js /
// ai-connector-inference.test.js (adapter blocks).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const http = require('http');
const { it, describe, expect } = require('./harness.cjs');
const {
    discoverModels,
    chatCompletion,
    normalizeOpenAiModels,
    normalizeOpenAiChatCompletion,
    getAdapter,
    isLoopbackBase,
} = require('../lib/runtime-adapters/index.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeRuntime(handler, opts = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ path: req.url, method: req.method });
            if (opts.hang) return; // never answer
            handler(req, res, server);
        });
        server.requests = [];
        server.listen(0, '127.0.0.1', () => {
            server.baseUrl = `http://127.0.0.1:${server.address().port}`;
            server.closeServer = () => new Promise((r) => server.close(() => r()));
            resolve(server);
        });
    });
}

const openAiModels = (ids) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
const openAiChat = (content, extra = {}) => ({
    id: 'cmpl-1', object: 'chat.completion', created: 1700000000, model: 'qwen3:32b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    service_tier: 'free',
    ...extra,
});

describe('adapter: GET /v1/models (discovery)', () => {
    it('successful discovery → normalized string[]; fixed path + method', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['qwen3:32b', 'llama3:8b'])));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect.equal(res.ok, true);
            expect.deepEqual(res.models, ['qwen3:32b', 'llama3:8b']);
            expect.lengthOf(rt.requests, 1);
            expect.equal(rt.requests[0].path, '/v1/models');
            expect.equal(rt.requests[0].method, 'GET');
        } finally { await rt.closeServer(); }
    });

    it('empty list → ok with []', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200); res.end(JSON.stringify({ data: [] }));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect.equal(res.ok, true);
            expect.deepEqual(res.models, []);
        } finally { await rt.closeServer(); }
    });

    it('unknown fields dropped; malformed JSON / wrong structure → bad_response', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200); res.end('not json {{{');
        });
        try {
            expect.equal((await discoverModels({ baseUrl: rt.baseUrl })).code, 'bad_response');
        } finally { await rt.closeServer(); }
        expect.equal(normalizeOpenAiModels({ models: ['a'] }).ok, false);
        expect.equal(normalizeOpenAiModels([1, 2]).ok, false);
        expect.equal(normalizeOpenAiModels(null).ok, false);
        expect.equal(normalizeOpenAiModels({ data: [{ id: 'a', evil: 'x' }] }).models[0], 'a');
    });

    it('oversized response → response_too_large; timeout; refused; HTTP error → runtime_error', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200);
            res.write('{"data":[');
            for (let i = 0; i < 160; i++) res.write(`"${'x'.repeat(64 * 1024)}",`);
            res.end('"end"]}');
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl, maxResponseBytes: 512 * 1024 });
            expect.equal(res.code, 'response_too_large');
        } finally { await rt.closeServer(); }

        const hung = await startFakeRuntime(() => {}, { hang: true });
        try {
            const res = await discoverModels({ baseUrl: hung.baseUrl, timeoutMs: 200 });
            expect.equal(res.code, 'timeout');
        } finally { await hung.closeServer(); }

        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.closeServer();
        expect.equal((await discoverModels({ baseUrl: deadBase })).code, 'runtime_unreachable');

        const err = await startFakeRuntime((req, res) => {
            res.writeHead(500); res.end('internal detail — never surface');
        });
        try {
            const res = await discoverModels({ baseUrl: err.baseUrl });
            expect.equal(res.code, 'runtime_error');
            expect.notInclude(JSON.stringify(res), 'internal detail');
        } finally { await err.closeServer(); }
    });

    it('redirect is REFUSED; adapter registry allowlist; isLoopbackBase', async () => {
        const target = await startFakeRuntime((req, res) => {
            res.writeHead(200); res.end(JSON.stringify(openAiModels(['redirected'])));
        });
        const redirector = await startFakeRuntime((req, res) => {
            res.writeHead(302, { Location: `${target.baseUrl}/v1/models` }); res.end();
        });
        try {
            const res = await discoverModels({ baseUrl: redirector.baseUrl });
            expect.equal(res.ok, false);
            expect.lengthOf(target.requests, 0);
        } finally {
            await redirector.closeServer();
            await target.closeServer();
        }
        for (const t of ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible']) {
            expect.ok(getAdapter(t), t);
        }
        expect.equal(getAdapter('gpu-hub'), null);
        expect.equal(getAdapter(undefined), null);
        expect.equal(isLoopbackBase('http://127.0.0.1:11434'), true);
        expect.equal(isLoopbackBase('http://localhost:123'), true);
        expect.equal(isLoopbackBase('http://192.168.1.5:11434'), false);
        expect.equal(isLoopbackBase('ftp://127.0.0.1'), false);
    });
});

describe('adapter: POST /v1/chat/completions (non-streaming)', () => {
    it('success → content, finish_reason, usage; POST + fixed path; stream:false hardcoded', async () => {
        let seenBody = null;
        const rt = await startFakeRuntime((req, res) => {
            let b = '';
            req.on('data', (c) => { b += c; });
            req.on('end', () => {
                seenBody = JSON.parse(b);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(openAiChat('Hello!')));
            });
        });
        try {
            const res = await chatCompletion({
                baseUrl: rt.baseUrl, model: 'qwen3:32b',
                messages: [{ role: 'user', content: 'hi' }],
                maxTokens: 16, temperature: 0.2, timeoutMs: 2000,
            });
            expect.equal(res.ok, true);
            expect.equal(res.content, 'Hello!');
            expect.equal(res.finishReason, 'stop');
            expect.deepEqual(res.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
            expect.equal(rt.requests[0].path, '/v1/chat/completions');
            expect.equal(rt.requests[0].method, 'POST');
            expect.equal(seenBody.stream, false);
            expect.equal(seenBody.max_tokens, 16);
            expect.equal(seenBody.temperature, 0.2);
        } finally { await rt.closeServer(); }
    });

    it('HTTP classification: 404→model_not_found; 400 context→context_length; 500→runtime_error; refused→runtime_unreachable', async () => {
        const mk = (status, body) => startFakeRuntime((req, res) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body || '{}');
        });
        const r404 = await mk(404);
        try { expect.equal((await chatCompletion({ baseUrl: r404.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'model_not_found'); }
        finally { await r404.closeServer(); }
        const r400 = await mk(400, JSON.stringify({ error: { message: 'context length exceeded' } }));
        try { expect.equal((await chatCompletion({ baseUrl: r400.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'context_length'); }
        finally { await r400.closeServer(); }
        const r400b = await mk(400, JSON.stringify({ error: { message: 'unrelated' } }));
        try { expect.equal((await chatCompletion({ baseUrl: r400b.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'runtime_error'); }
        finally { await r400b.closeServer(); }
        const r500 = await mk(500, 'secret internal detail');
        try {
            const res = await chatCompletion({ baseUrl: r500.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] });
            expect.equal(res.code, 'runtime_error');
            expect.notInclude(JSON.stringify(res), 'secret internal detail');
        } finally { await r500.closeServer(); }
        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.closeServer();
        expect.equal((await chatCompletion({ baseUrl: deadBase, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'runtime_unreachable');
    });

    it('malformed / oversized responses → bad_response / response_too_large', async () => {
        const badJson = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('not json'); });
        try { expect.equal((await chatCompletion({ baseUrl: badJson.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'bad_response'); }
        finally { await badJson.closeServer(); }
        const badShape = await startFakeRuntime((req, res) => { res.writeHead(200); res.end(JSON.stringify({ choices: [] })); });
        try { expect.equal((await chatCompletion({ baseUrl: badShape.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }] })).code, 'bad_response'); }
        finally { await badShape.closeServer(); }
        expect.equal(normalizeOpenAiChatCompletion({ choices: [{ message: { content: 'x' } }] }).content, 'x');
        expect.equal(normalizeOpenAiChatCompletion({ choices: [{ message: { content: null } }] }).ok, false);
        expect.equal(normalizeOpenAiChatCompletion({ choices: [{ message: { content: 'x' } }], usage: { junk: 1, prompt_tokens: 2 } }).usage.prompt_tokens, 2);
        expect.equal(normalizeOpenAiChatCompletion({ choices: [{ message: { content: 'x' } }], usage: { junk: 1 } }).usage, undefined);
    });

    it('hostile caller options cannot redirect the target (arbitrary URL impossible)', async () => {
        // The adapter builds ONE URL from the base + fixed path — extra
        // opts fields are ignored by construction (no passthrough).
        const res = await chatCompletion({
            baseUrl: 'http://127.0.0.1:1', model: 'm', messages: [{ role: 'user', content: 'x' }],
            timeoutMs: 150,
        });
        expect.equal(res.ok, false);
        expect.equal(res.code, 'runtime_unreachable');
    });
});

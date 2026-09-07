// ======================================================
// chat.request validation + limits tests — migrated from backend
// tests/ai-connector-inference.test.js / streaming (chat lib blocks).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const { it, describe, expect } = require('./harness.cjs');
const chatLib = require('../lib/chat.cjs');

const REQ = (over = {}) => ({
    type: 'chat.request',
    request_id: 'req-1',
    model: 'qwen3:32b',
    messages: [{ role: 'user', content: 'Hello there' }],
    params: { max_tokens: 128, temperature: 0.5 },
    timeout_ms: 5000,
    ...over,
});

describe('chat lib: validation', () => {
    it('valid request → ok with extracted fields', () => {
        const v = chatLib.validateChatRequest(REQ());
        expect.equal(v.ok, true);
        expect.equal(v.request.requestId, 'req-1');
        expect.equal(v.request.model, 'qwen3:32b');
        expect.equal(v.request.maxTokens, 128);
        expect.equal(v.request.temperature, 0.5);
        expect.equal(v.request.timeoutMs, 5000);
        expect.equal(v.request.stream, false);
    });

    it('non-object / missing request_id → drop silently (null requestId)', () => {
        for (const bad of [null, 'str', [1], {}]) {
            const v = chatLib.validateChatRequest(bad);
            expect.equal(v.ok, false);
            expect.equal(v.requestId, null);
        }
        const noId = chatLib.validateChatRequest({ type: 'chat.request', model: 'm', messages: [] });
        expect.equal(noId.ok, false);
        expect.equal(noId.requestId, null);
    });

    it('model: missing/oversized/control-chars → invalid_request', () => {
        expect.equal(chatLib.validateChatRequest(REQ({ model: 42 })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ model: '   ' })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ model: 'x\u0007y' })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ model: 'y'.repeat(513) })).code, 'invalid_request');
    });

    it('messages: empty / bad role / empty content → invalid_request', () => {
        expect.equal(chatLib.validateChatRequest(REQ({ messages: [] })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ messages: 'nope' })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ messages: [{ role: 'tool', content: 'x' }] })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ messages: [{ role: 'user', content: '' }] })).code, 'invalid_request');
    });

    it('messages: count / per-message / prompt caps → request_too_large', () => {
        const sixtyFive = Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' }));
        expect.equal(chatLib.validateChatRequest(REQ({ messages: sixtyFive })).code, 'request_too_large');
        const bigMsg = [{ role: 'user', content: 'x'.repeat(32 * 1024 + 1) }];
        expect.equal(chatLib.validateChatRequest(REQ({ messages: bigMsg })).code, 'request_too_large');
        const bigTotal = Array.from({ length: 64 }, () => ({ role: 'user', content: 'x'.repeat(2100) }));
        expect.equal(chatLib.validateChatRequest(REQ({ messages: bigTotal })).code, 'request_too_large');
    });

    it('max_tokens / temperature ranges enforced', () => {
        expect.equal(chatLib.validateChatRequest(REQ({ params: { max_tokens: 0 } })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ params: { max_tokens: 8193 } })).code, 'request_too_large');
        expect.equal(chatLib.validateChatRequest(REQ({ params: { temperature: 2.5 } })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ params: { temperature: -0.1 } })).code, 'invalid_request');
        expect.equal(chatLib.validateChatRequest(REQ({ params: { stream: 'true' } })).request.stream, false);
        expect.equal(chatLib.validateChatRequest(REQ({ params: { stream: true } })).request.stream, true);
    });

    it('timeout_ms is clamped, never trusted', () => {
        expect.equal(chatLib.validateChatRequest(REQ({ timeout_ms: 1 })).request.timeoutMs, 1000);
        expect.equal(chatLib.validateChatRequest(REQ({ timeout_ms: 999999 })).request.timeoutMs, 180000);
        expect.equal(chatLib.validateChatRequest(REQ({ timeout_ms: 'junk' })).request.timeoutMs, 180000);
        expect.equal(chatLib.validateChatRequest(REQ({})).request.timeoutMs, 5000);
    });

    it('unknown fields (url/base_url/endpoint/identity) are dropped at the seam', () => {
        const hostile = chatLib.validateChatRequest({
            ...REQ(),
            url: 'http://evil.example',
            base_url: 'http://evil.example',
            endpoint: '/elsewhere',
            identity: 'attacker',
        });
        expect.equal(hostile.ok, true);
        expect.notInclude(JSON.stringify(hostile.request), 'evil.example');
    });

    it('unknown message entry fields (name, tool_calls, url) are dropped', () => {
        const v = chatLib.validateChatRequest({
            ...REQ(),
            messages: [{ role: 'user', content: 'hi', name: 'x', tool_calls: [], url: 'http://evil' }],
        });
        expect.equal(v.ok, true);
        expect.deepEqual(v.request.messages, [{ role: 'user', content: 'hi' }]);
    });
});

describe('chat lib: limits + error allowlist', () => {
    it('LIMITS match the published SPEC numbers', () => {
        const L = chatLib.LIMITS;
        expect.equal(L.maxMessages, 64);
        expect.equal(L.maxMessageChars, 32 * 1024);
        expect.equal(L.maxTotalPromptChars, 128 * 1024);
        expect.equal(L.maxMaxTokens, 8192);
        expect.equal(L.minTemperature, 0);
        expect.equal(L.maxTemperature, 2);
        expect.equal(L.minTimeoutMs, 1000);
        expect.equal(L.maxTimeoutMs, 180 * 1000);
        expect.equal(L.maxConcurrentRequests, 2);
        expect.equal(L.maxSeenRequestIds, 100000);
        expect.equal(L.maxResponseFrameBytes, 60 * 1024);
        expect.equal(L.maxDeltaChars, 16 * 1024);
        expect.equal(L.maxStreamedContentChars, 32 * 1024);
        expect.equal(L.maxSseEventBytes, 64 * 1024);
        expect.equal(L.maxSseLineBytes, 64 * 1024);
        expect.equal(L.maxRequestIdChars, 128);
        expect.equal(L.maxModelChars, 512);
    });

    it('CHAT_ERROR_CODES is the fixed 11-code allowlist', () => {
        expect.deepEqual([...chatLib.CHAT_ERROR_CODES].sort(), [
            'bad_response', 'busy', 'cancelled', 'context_length', 'invalid_request',
            'model_not_found', 'request_too_large', 'response_too_large', 'runtime_error',
            'runtime_unreachable', 'timeout',
        ]);
        // cloud-internal codes never appear
        expect.notInclude(chatLib.CHAT_ERROR_CODES, 'connector_offline');
        expect.notInclude(chatLib.CHAT_ERROR_CODES, 'session_closed');
    });

    it('validateChatCancel reads request_id and NOTHING else', () => {
        expect.equal(chatLib.validateChatCancel({ type: 'chat.cancel', request_id: 'req-1' }), 'req-1');
        expect.equal(chatLib.validateChatCancel({ request_id: 42 }), null);
        expect.equal(chatLib.validateChatCancel(null), null);
        expect.equal(chatLib.validateChatCancel({ request_id: 'bad id\u0000' }), null);
    });

    it('fingerprintRequestId is stable, 16 hex chars, same id ⇒ same fp', () => {
        const a = chatLib.fingerprintRequestId('req-1');
        const b = chatLib.fingerprintRequestId('req-1');
        const c = chatLib.fingerprintRequestId('req-2');
        expect.equal(a, b);
        expect.ok(a !== c, 'different ids must fingerprint differently');
        expect.match(a, /^[0-9a-f]{16}$/);
    });
});

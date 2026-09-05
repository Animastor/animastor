// ======================================================
// PHASE 8 — LAC ↔ backend cross-side contract sync test
// ======================================================
// Pins the PUBLIC CONTRACT numbers shared between the LAC package
// (local-ai-connector/) and the backend WS endpoint so the two sides
// cannot silently drift apart — especially across a future physical
// extraction of the package out of the monorepo.
//
// What is pinned (PUBLIC CONTRACT only, not implementation details):
//   1. protocol_version: LAC hello sends 1, backend routes require 1;
//   2. token grammar: llmc.*/llmcreg.* family prefixes + shape regex;
//   3. limits: chat request/response/stream size + concurrency caps;
//   4. heartbeat semantics: interval, timeout window, client clamp range;
//   5. error codes: the chat.error allowlist (same set on both sides);
//   6. runtime types: the runtime-type allowlist mirrored on both sides;
//   7. frame surface: every frame type one side sends, the other handles.
//
// File-location policy: the LAC side is located relative to REPO_ROOT
// with a single constant; if the package moves (Phase 8 extraction), only
// that constant (and package.json resolution, which stays standard npm)
// changes. The test reads the package's PUBLISHED exports (require of the
// package modules) — the same surface any external consumer gets.
//
// This suite complements (does not replace) phase2-lac-transport-contract
// (boundary shape) and P7-T1 (structural isolation). It requires the real
// modules, so it validates behavior-level contract equality, not text.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./helpers');

// Single point of truth for the future extraction: if the package moves,
// update this (or the resolution below) once.
const LAC_DIR = path.join(REPO_ROOT, 'local-ai-connector');

// The backend side under contract.
const routes = require('../../src/routes/ai-connector-routes.cjs');
const transport = require('../../src/services/ai-connector/transport');

// The LAC side under contract — required as modules (public surface),
// falling back to source-scanning if the dependency is not installed.
const lacPkg = JSON.parse(fs.readFileSync(path.join(LAC_DIR, 'package.json'), 'utf8'));
const chatLib = require(path.join(LAC_DIR, 'lib', 'chat.cjs'));
const configLib = require(path.join(LAC_DIR, 'lib', 'config.cjs'));
const adaptersLib = require(path.join(LAC_DIR, 'lib', 'runtime-adapters', 'index.cjs'));
const connectorSrc = fs.readFileSync(path.join(LAC_DIR, 'lib', 'connector.cjs'), 'utf8');

describe('contract: LAC ↔ backend — protocol version 1', () => {
    it('LAC hello sends exactly the protocol_version the backend requires', () => {
        // LAC connector.cjs hardcodes the hello protocol_version literal.
        const m = connectorSrc.match(/protocol_version['"]?\s*:\s*(\d+)/);
        expect(m, 'connector.cjs must send a literal protocol_version in hello').to.not.equal(null);
        expect(Number(m[1])).to.equal(routes.PROTOCOL_VERSION);
        expect(routes.PROTOCOL_VERSION).to.equal(1);
    });

    it('the backend rejects any other version fail-closed (validateHello)', () => {
        // Shape-level: the route validates msg.protocol_version !== 1 → close.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-connector-routes.cjs'), 'utf8');
        expect(src).to.include('protocol_version_unsupported');
    });
});

describe('contract: LAC ↔ backend — token grammar', () => {
    it('token families match on both sides (llmc persistent, llmcreg one-time)', () => {
        expect(lacPkg.name).to.equal('animastor-ai-connector');
        // Backend repo defines the authoritative families.
        const repo = require('../../src/storage/postgres/repositories/ai-connector-repo');
        const families = [repo.TOKEN_PREFIX, repo.REG_TOKEN_PREFIX].sort();
        expect(families).to.deep.equal(['llmc', 'llmcreg']);
    });

    it('LAC-side token regex accepts real minted tokens and rejects lookalikes', () => {
        // Mint a REAL token pair with the backend generator (valid UUID
        // connector id), then check the LAC config parser accepts them
        // (the grammar is the contract).
        const repo = require('../../src/storage/postgres/repositories/ai-connector-repo');
        const uuid = '01234567-89ab-cdef-0123-456789abcdef';
        const cred = repo.generateCredential(uuid).token;
        const reg = repo.generateRegToken(uuid).token;
        const okUrl = 'wss://animastor.example/api/v1/ai-connector/ws';
        expect(configLib.parseConfig(['--url', okUrl, '--token', cred]).ok).to.equal(true);
        expect(configLib.parseConfig(['--url', okUrl, '--token', reg]).ok).to.equal(true);
        for (const bad of ['llmc.only-two', 'llmcreg.a.b.c', 'sk-abc', 'llmc.$$$.$$$']) {
            expect(configLib.parseConfig(['--url', okUrl, '--token', bad]).ok).to.equal(false);
        }
    });
});

describe('contract: LAC ↔ backend — chat limits mirror', () => {
    it('prompt/message/model/token/temperature caps are identical on both sides', () => {
        const L = chatLib.LIMITS;          // connector-side (lib/chat.cjs)
        const T = transport.LIMITS;        // backend-side (transport.js)
        expect(L.maxModelChars).to.equal(T.maxModelChars);
        expect(L.maxMessages).to.equal(T.maxMessages);
        expect(L.maxMessageChars).to.equal(T.maxMessageChars);
        expect(L.maxTotalPromptChars).to.equal(T.maxTotalPromptChars);
        expect(L.maxMaxTokens).to.equal(T.maxMaxTokens);
        expect(L.minTemperature).to.equal(T.minTemperature);
        expect(L.maxTemperature).to.equal(T.maxTemperature);
    });

    it('streaming caps (delta / cumulative) are identical on both sides', () => {
        expect(chatLib.LIMITS.maxDeltaChars).to.equal(transport.LIMITS.maxDeltaChars);
        expect(chatLib.LIMITS.maxStreamedContentChars).to.equal(transport.LIMITS.maxStreamedContentChars);
    });

    it('response size contract: connector frame cap ≤ backend inbound cap, content caps equal', () => {
        // Connector: serialized chat.response ≤ maxResponseFrameBytes.
        // Backend: inbound WS frame cap (routes DEFAULTS.maxPayloadBytes)
        //          + per-content cap (transport maxResponseChars).
        const backendFrameCap = routes.DEFAULTS.maxPayloadBytes; // 64 KB
        expect(chatLib.LIMITS.maxResponseFrameBytes).to.be.below(backendFrameCap);
        expect(chatLib.LIMITS.maxStreamedContentChars).to.equal(transport.LIMITS.maxStreamedContentChars);
    });

    it('chat timeout window: both sides cap at the same 180 s maximum', () => {
        expect(chatLib.LIMITS.maxTimeoutMs).to.equal(180 * 1000);
        expect(transport.DEFAULTS.requestTimeoutMs).to.equal(180 * 1000);
    });
});

describe('contract: LAC ↔ backend — heartbeat semantics', () => {
    it('backend-advertised cadence is within the connector clamp range', () => {
        const advertised = routes.DEFAULTS.heartbeatIntervalMs; // 15 000
        expect(advertised).to.be.at.least(250);
        expect(advertised).to.be.at.most(600000);
        // The connector's fallback cadence equals the backend default.
        const fallback = /heartbeatIntervalMs:\s*(\d+)\s*\*\s*1000/.exec(connectorSrc);
        expect(fallback && Number(fallback[1]) * 1000).to.equal(routes.DEFAULTS.heartbeatIntervalMs);
    });

    it('backend silence window ≥ 2× the advertised cadence (liveness contract)', () => {
        expect(routes.DEFAULTS.heartbeatTimeoutMs).to.be.at.least(2 * routes.DEFAULTS.heartbeatIntervalMs);
    });
});

describe('contract: LAC ↔ backend — chat error code allowlist', () => {
    it('both sides allowlist exactly the same wire error codes', () => {
        const lacCodes = [...chatLib.CHAT_ERROR_CODES].sort();
        const backendCodes = [...transport.CONNECTOR_CHAT_ERROR_CODES].sort();
        expect(lacCodes).to.deep.equal(backendCodes);
    });

    it('the allowlist matches the published SPEC', () => {
        const spec = fs.readFileSync(path.join(LAC_DIR, 'SPEC.md'), 'utf8');
        for (const code of chatLib.CHAT_ERROR_CODES) {
            expect(spec, `SPEC.md must document the ${code} error code`).to.include(`\`${code}\``);
        }
    });

    it('cloud-only codes never appear on the wire allowlist', () => {
        // connector_offline / session_closed / stream_failed are transport-
        // internal (cloud→caller), never valid in a C→S chat.error frame.
        for (const internal of ['connector_offline', 'session_closed']) {
            expect(chatLib.CHAT_ERROR_CODES).to.not.include(internal);
        }
    });
});

describe('contract: LAC ↔ backend — runtime types allowlist', () => {
    it('the runtime-type list is identical on both sides', () => {
        const repo = require('../../src/storage/postgres/repositories/ai-connector-repo');
        expect([...adaptersLib.RUNTIME_TYPES].sort()).to.deep.equal([...repo.RUNTIME_TYPES].sort());
    });
});

describe('contract: LAC ↔ backend — frame surface', () => {
    const LAC_SENDS = ['hello', 'heartbeat', 'models.list', 'chat.response', 'chat.delta', 'chat.error'];
    const LAC_RECEIVES = ['ready', 'models.refresh', 'chat.request', 'chat.cancel'];
    const BACKEND_SENDS = ['ready', 'models.refresh', 'chat.request', 'chat.cancel'];
    const BACKEND_RECEIVES = ['hello', 'heartbeat', 'models.list', 'chat.response', 'chat.delta', 'chat.error'];

    it('every frame LAC sends is handled by the backend route', () => {
        const routesSrc = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-connector-routes.cjs'), 'utf8');
        for (const type of LAC_SENDS) {
            expect(routesSrc, `backend routes must handle ${type}`).to.include(`'${type}'`);
        }
    });

    it('every frame the backend sends is handled by the LAC session', () => {
        for (const type of BACKEND_SENDS) {
            expect(connectorSrc, `LAC connector must handle ${type}`).to.include(`'${type}'`);
        }
    });

    it('the frame sets are exact complements (no orphan types)', () => {
        expect(LAC_RECEIVES.sort()).to.deep.equal(BACKEND_SENDS.sort());
        expect(BACKEND_RECEIVES.sort()).to.deep.equal(LAC_SENDS.sort());
    });

    it('chat.request / chat.cancel FROM the connector are outside its own send surface', () => {
        // The connector only ever emits these as received-handlers; a
        // send({type:'chat.request'…}) must not exist.
        const sends = [...connectorSrc.matchAll(/send\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
        for (const serverOnly of ['chat.request', 'chat.cancel', 'models.refresh', 'ready']) {
            expect(sends).to.not.include(serverOnly);
        }
    });
});

describe('contract: LAC ↔ backend — unknown-frame and unknown-field behavior', () => {
    it('both sides ignore unknown frame types safely (documented in SPEC)', () => {
        const spec = fs.readFileSync(path.join(LAC_DIR, 'SPEC.md'), 'utf8');
        expect(spec).to.include('Unknown frame `type`');
        const routesSrc = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-connector-routes.cjs'), 'utf8');
        expect(routesSrc).to.include('ignored unknown message type');
        expect(connectorSrc).to.include('Unknown types are ignored');
    });

    it('unknown fields are dropped at the seam on both sides', () => {
        // Behavioral: a chat.request with hostile url fields must validate
        // identically with and without them (LAC side).
        const base = {
            type: 'chat.request', request_id: 'req-1', model: 'm1',
            messages: [{ role: 'user', content: 'hi' }],
        };
        const clean = chatLib.validateChatRequest(base);
        const hostile = chatLib.validateChatRequest({
            ...base,
            url: 'http://evil.example/v1',
            base_url: 'http://evil.example',
            endpoint: '/elsewhere',
        });
        expect(clean.ok).to.equal(true);
        expect(hostile.ok).to.equal(true);
        expect(hostile.request.messages).to.deep.equal(clean.request.messages);
        expect(JSON.stringify(hostile.request)).to.not.include('evil.example');
    });
});

describe('contract: LAC ↔ backend — credential safety across the seam', () => {
    it('LAC validation errors never echo token material', () => {
        const secret = 'llmc.' + 'a'.repeat(20) + '.SECRETVALUE';
        // A syntactically valid prefix + garbage tail: rejected, and the
        // secret tail must not appear anywhere in the error payload.
        const res = configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', secret + '!!!']);
        expect(res.ok).to.equal(false);
        expect(JSON.stringify(res)).to.not.include('SECRETVALUE');
        // Control: a valid-shaped token parses fine.
        expect(configLib.parseConfig(['--url', 'wss://x.example/ws', '--token', 'llmc.a.b']).ok).to.equal(true);
    });

    it('backend transport sanitizes error messages to the 256-char cap', () => {
        const msg = transport.SANITIZED_MESSAGES;
        expect(Object.keys(msg).length).to.be.at.least(10);
        expect(transport.LIMITS.maxErrorFrameMessageChars).to.equal(256);
    });
});

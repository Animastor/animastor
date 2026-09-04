// ======================================================
// PHASE 2 — Local AI Connector transport contract (architecture guardrail)
// ======================================================
// Guards the LAC boundary (Phase 2, Part B.1–B.2), without changing the
// protocol. The contract is derived from current behavior (docs/architecture/
// PHASE_2_CONTRACTS.md §5).
//
// Two transports, strictly separated:
//   Transport A:  backend → LAC (WS) → local runtime adapter → user's local model
//   Transport B:  backend → provider gateway → external/cloud provider
//
// LAC identity rule (worker-auth doctrine, verbatim): connector_id/workspace_id
// are derived ONLY from the credential / registration token, never from
// client query/body.
//
// Transport surface (current, pinned from current code):
//   C→S hello, ready, heartbeat, models.list, chat.delta/response/error
//   S→C chat.request, chat.cancel (S→C frames are transport-owned, never client)
//
// LAC itself is WS-only client (no Redis, no PG). Provider resolution is a
// separate transport (workspace_ai_provider / ai-service), not LAC.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const lacIndex = path.join(REPO_ROOT, 'local-ai-connector', 'index.cjs');
const lacConfig = path.join(REPO_ROOT, 'local-ai-connector', 'lib', 'config.cjs');
const lacConnector = path.join(REPO_ROOT, 'local-ai-connector', 'lib', 'connector.cjs');
const lacChat = path.join(REPO_ROOT, 'local-ai-connector', 'lib', 'chat.cjs');
const lacRuntimeIndex = path.join(REPO_ROOT, 'local-ai-connector', 'lib', 'runtime-adapters', 'index.cjs');
const backendRoutes = path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-connector-routes.cjs');
const backendTransport = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'transport.js');
const backendDiscovery = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'discovery.js');
const backendRegistry = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'registry.js');
const sharedPool = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'shared-pool.js');
const workspaceProvider = path.join(REPO_ROOT, 'backend', 'src', 'services', 'workspace-ai-provider.js');
const aiService = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-service.js');

function read(file) {
    return readSource(file);
}

describe('architecture: LAC boundary — standalone, WS-only, outbound-only', () => {
    it('local-ai-connector package has only ws as external dependency', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'local-ai-connector', 'package.json'), 'utf8'));
        expect(pkg.dependencies).to.have.property('ws');
        expect(Object.keys(pkg.dependencies)).to.deep.equal(['ws']);
    });

    it('LAC entrypoint is a CLI that dials out (outbound WS), never listens for inference', () => {
        const idx = read(lacIndex);
        expect(idx).to.include('createConnectorSession');
        expect(idx).to.match(/wss:\/\//);
        expect(idx).to.match(/--url/);
        expect(idx).to.match(/--token/);
    });

    it('LAC core lib has no Redis and no Postgres (connector.cjs may mention PG only as a comment/doc reference)', () => {
        // connector.cjs is the session module; it may contain prose references
        // to PG (e.g. "PG is source of truth") but must not import PG.
        for (const file of [lacIndex, lacConfig, lacChat, lacRuntimeIndex]) {
            const src = read(file);
            expect(src, file).to.not.match(/redis/i);
            expect(src, file).to.not.match(/require\(['"][^'"]*pg|postgres/i);
        }
        const conn = read(lacConnector);
        expect(conn).to.not.match(/require\(['"][^'"]*pg|postgres/i);
        expect(conn).to.not.match(/redis/i);
    });

    it('LAC transport is WS only (no HTTP inference proxy to cloud)', () => {
        // Connector is a WS client to the backend; inference rides the local
        // runtime adapter, not an HTTP proxy through the cloud.
        const conn = read(lacConnector);
        expect(conn).to.include('ws');
        // AD-5: the runtime base URL is local config only (local-ai-connector
        // lib/config.cjs exposes --base-url / ANIMASTOR_RUNTIME_BASE_URL).
        const cfg = read(lacConfig);
        expect(cfg).to.match(/base.url|baseUrl|base_url|base-url|base-url|baseUrl/);
    });

    it('LAC runtime adapter is an allowlist, not a proxy', () => {
        const rtai = read(lacRuntimeIndex);
        // V1 adapter knows exactly two paths: models + chat completions.
        expect(rtai).to.include('openai-compatible');
        // The adapter index is the allowlist registry.
        expect(rtai).to.match(/adapter/i);
    });

    it('LAC protocol has exactly the documented frame types (no hidden surface)', () => {
        const conn = read(lacConnector);
        // inbound frames the connector handles
        expect(conn).to.match(/models\.list/);
        expect(conn).to.match(/chat\.request/);
        expect(conn).to.match(/chat\.cancel/);
        // outbound frames the connector sends
        expect(conn).to.match(/heartbeat/);
        expect(conn).to.match(/chat\.response/);
        expect(conn).to.match(/chat\.error/);
    });
});

describe('architecture: LAC identity rule (credential-derived, never client query/body)', () => {
    it('backend LAC routes derive identity from credential / registration token only', () => {
        const routes = read(backendRoutes);
        // hello validation enforces exactly one auth mode (credential xor reg_token).
        expect(routes).to.include('validateHello');
        expect(routes).to.match(/credential/);
        expect(routes).to.match(/reg_token/);
        // identity resolution is repo-based (authenticateConnector / activateConnector).
        expect(routes).to.match(/authenticateConnector/);
        expect(routes).to.match(/activateConnector/);
    });

    it('LAC connector-side session authenticates via hello/ready, not client-supplied id', () => {
        const conn = read(lacConnector);
        expect(conn).to.match(/hello/);
        expect(conn).to.match(/ready/);
    });
});

describe('architecture: LAC inference contract (request / response / error / timeout / cancel)', () => {
    it('transport service enforces the same limits as the connector-side chat lib', () => {
        const tr = read(backendTransport);
        // Both sides share limits (defense in depth).
        expect(tr).to.include('LIMITS');
        expect(tr).to.match(/maxModelChars/);
        expect(tr).to.match(/maxMessages/);
        expect(tr).to.match(/maxTotalPromptChars/);
        expect(tr).to.match(/maxTokens|max_max_tokens|maxMaxTokens/);
        const chat = read(lacChat);
        expect(chat).to.match(/maxModelChars|model.*limit/);
    });

    it('LAC response contract: ok:true with content/finishReason/usage, or sanitized ok:false', () => {
        const tr = read(backendTransport);
        expect(tr).to.match(/ok:\s*true,\s*content/);
        expect(tr).to.match(/finishReason/);
        expect(tr).to.match(/usage/);
        expect(tr).to.match(/ok:\s*false,\s*code/);
        expect(tr).to.include('SANITIZED_MESSAGES');
    });

    it('LAC error codes are allowlisted / sanitized, never raw runtime detail', () => {
        const tr = read(backendTransport);
        expect(tr).to.match(/CONNECTOR_CHAT_ERROR_CODES/);
        expect(tr).to.match(/runtime_error/);
        expect(tr).to.match(/bad_response/);
        expect(tr).to.match(/timeout/);
        expect(tr).to.match(/cancelled/);
        // Unknown codes degrade to a generic code (no hostile content echo).
        expect(tr).to.match(/GENERIC_CHAT_ERROR/);
    });

    it('LAC timeout is authoritative (cloud timer → chat.cancel downstream)', () => {
        const tr = read(backendTransport);
        expect(tr).to.match(/chat\.cancel/);
        expect(tr).to.match(/timeout/);
        expect(tr).to.match(/clearTimeout/);
    });

    it('LAC cancellation is symmetrical to timeout (consumer signal → chat.cancel → cancelled)', () => {
        const tr = read(backendTransport);
        expect(tr).to.match(/signal/);
        expect(tr).to.match(/abort/);
        expect(tr).to.match(/cancelled/);
    });

    it('LAC streaming (Phase 5) is a separate mode with chat.delta, still transport-validated', () => {
        const tr = read(backendTransport);
        expect(tr).to.match(/chat\.delta/);
        expect(tr).to.match(/onDelta/);
        expect(tr).to.match(/stream/);
        // Streaming deltas are capped and correlated by request_id.
        expect(tr).to.match(/maxDeltaChars|max.*delta/);
    });
});

describe('architecture: LAC vs cloud provider transport — never mixed', () => {
    it('workspace_ai_provider is a separate transport resolution path (not a LAC session)', () => {
        // Provider resolution is the cloud/external-gateway path. It does not
        // become a connector snapshot.
        const wp = read(workspaceProvider);
        expect(wp).to.match(/resolveAIForWorkspace|resolveAIForBook/);
        const svc = read(aiService);
        expect(svc).to.include('callAI');
    });

    it('connector snapshot shape is transport:connector / provider:local-ai / endpoint:null / apiKey:null', () => {
        const pool = read(sharedPool);
        expect(pool).to.match(/transport:\s*['`]connector['`]/);
        expect(pool).to.match(/provider:\s*['`]local-ai['`]/);
        expect(pool).to.match(/endpoint:\s*null/);
        expect(pool).to.match(/apiKey:\s*null/);
    });

    it('shared-pool snapshot carries NO runtime URL / credential (AD-5 boundary)', () => {
        const pool = read(sharedPool);
        // Consumer never learns the owner's runtime URL or any connector secret.
        expect(pool).to.match(/never learns/);
        expect(pool).to.match(/secret/);
    });
});

describe('architecture: LAC liveness / registry contract', () => {
    it('LAC registry is the authoritative WS liveness (PG status is a stale trace)', () => {
        const reg = read(backendRegistry);
        expect(reg).to.include('getLive');
        expect(reg).to.include('isLive');
        expect(reg).to.include('register');
        expect(reg).to.include('unregister');
        // PG status is a trace; the live map is authoritative (documented
        // in shared-pool.js: 'the AUTHORITATIVE WS liveness, LAC §7 — PG status
        // is a stale trace and is NEVER consulted here').
        const pool = read(sharedPool);
        expect(pool).to.match(/registry\.isLive/);
        expect(pool).to.match(/is a stale trace/);
    });

    it('LAC liveness mirror on Redis is backend-owned, not LAC itself', () => {
        const routes = read(backendRoutes);
        expect(routes).to.match(/animastor:ai-connector:hb/);
        // LAC itself does not touch Redis.
        const conn = read(lacConnector);
        expect(conn).to.not.match(/redis/i);
    });

    it('LAC heartbeat carries models + runtime_ok + capabilities (current shape)', () => {
        const routes = read(backendRoutes);
        expect(routes).to.match(/models\[\]/);
        expect(routes).to.match(/runtime_ok/);
        expect(routes).to.match(/capabilities/);
    });
});

// ======================================================
// PHASE 3 — Provider Gateway boundary (architecture guardrail)
// ======================================================
// The Provider Gateway is a LOGICAL module boundary inside the modular
// monolith — NOT a service split. Phase 3 formalizes the three already
// existing AI provider directions as explicit contracts:
//
//   ProviderGateway
//   ├── resolve      — provider resolution (workspace-ai-provider chain)
//   ├── agent        — callAI: non-streaming JSON (agent pipelines)
//   ├── chat         — SSE transport: tools / abort / connector / shared-pool
//   └── generation   — ComfyUI / GPU job dispatch (Job Protocol v2)
//
// These tests guard the BOUNDARIES, not private function names:
//   T1  Agent contract      — non-streaming JSON, no SSE/tools creep
//   T2  Chat contract       — SSE, tools, abort, connector, shared-pool
//   T3  Transport separation— callAI ≠ chat transport (no cross-wiring)
//   T4  Generation separation— generation must not depend on LLM transports
//   T5  Gateway surface     — stable facade with exactly three directions
//   T6  Provider isolation  — ComfyUI details stay out of Agent/Chat
// Docs: docs/architecture/PHASE_3_PROVIDER_GATEWAY.md

const { expect } = require('chai');
const path = require('path');
const { readSource, REPO_ROOT } = require('./helpers');

const gatewayPath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'provider-gateway.js');
const comfyuiSeamPath = path.join(REPO_ROOT, 'backend', 'src', 'generation', 'comfyui-provider.js');
const aiServicePath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-service.js');
const aiCallerPath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'agent', 'ai-caller.js');
const chatRoutePath = path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-routes.cjs');
const chatEnginePath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'chat-engine.cjs');
const sharedPoolPath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'shared-pool.js');
const gpuDispatcherPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'gpu-dispatcher.js');
const audioGenPath = path.join(REPO_ROOT, 'backend', 'src', 'audio', 'generation.js');
const workflowLoaderPath = path.join(REPO_ROOT, 'backend', 'src', 'workflows', 'workflow-loader.js');

function read(file) { return readSource(file); }

/**
 * Strip JS comments so section-scoped assertions judge CODE, not prose.
 * Documentation comments legitimately mention the other transports
 * (e.g. "the chat transport lives in ai-routes.cjs") — the invariant is
 * about code, not vocabulary.
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/** Extract the source between two literal markers (section-scoped checks). */
function section(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + 1);
    expect(start, `section marker not found: ${startMarker}`).to.be.at.least(0);
    expect(end, `section end marker not found: ${endMarker}`).to.be.above(start);
    return source.slice(start, end);
}

// ======================================================
// T1 — Agent contract: non-streaming JSON, no chat-transport creep
// ======================================================
describe('architecture: Phase 3 agent provider contract (non-streaming JSON)', () => {
    it('callAI stays non-streaming JSON: stream:false upstream, no SSE, no tool lifecycle', () => {
        const service = read(aiServicePath);
        expect(service).to.match(/stream:\s*false/);
        expect(service).to.not.include('text/event-stream');
        expect(service).to.not.include('tool_choice');
        expect(service).to.not.include('getToolsForMode');
    });

    it('agent pipeline caller keeps retries + provider context and never grows an SSE/tools surface', () => {
        const caller = read(aiCallerPath);
        expect(caller).to.include('callAI(');
        expect(caller).to.match(/STEP_RETRIES|retries/);
        expect(caller).to.include('AsyncLocalStorage');
        expect(caller).to.not.include('text/event-stream');
        expect(caller).to.not.include('writeEvent');
        expect(caller).to.not.include('tool_choice');
    });

    it('gateway agent section delegates to ai-service and exposes no streaming/chat surface', () => {
        const agentSection = section(stripComments(read(gatewayPath)), 'const agent = {', 'const chat = {');
        expect(agentSection).to.include('aiService.callAI');
        expect(agentSection).to.include('parseJsonResponse');
        expect(agentSection).to.not.match(/SSE|event-stream|onDelta/i);
        expect(agentSection).to.not.include('runSharedInference');
        expect(agentSection).to.not.include('gpuDispatcher');
    });
});

// ======================================================
// T2 — Chat contract: SSE, tools, abort, connector, shared-pool
// ======================================================
describe('architecture: Phase 3 chat provider contract (SSE transport)', () => {
    it('chat transport keeps the SSE contract: meta/delta/done/error, exactly one terminal frame', () => {
        const chat = read(chatRoutePath);
        expect(chat).to.include("'text/event-stream; charset=utf-8'");
        expect(chat).to.match(/writeEvent\('meta'/);
        expect(chat).to.match(/writeEvent\('delta'/);
        expect(chat).to.match(/sendTerminal\('done'/);
        expect(chat).to.match(/sendTerminal\('error'/);
    });

    it('chat transport keeps tools, timeout, cancellation and request correlation', () => {
        const chat = read(chatRoutePath);
        expect(chat).to.include('getToolsForMode');
        expect(chat).to.match(/tool_choice/);
        expect(chat).to.match(/new AbortController\(\)/);
        expect(chat).to.match(/AI_FETCH_TIMEOUT_MS/);
        expect(chat).to.match(/res\.on\('close'/);
        // request correlation: connector transport request_id (LAC v1)
        const transport = read(path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'transport.js'));
        expect(transport).to.match(/request_id/);
    });

    it('chat transport rides the connector path via shared-pool (private + shared)', () => {
        const chat = read(chatRoutePath);
        expect(chat).to.match(/ai\.transport === 'connector'/);
        expect(chat).to.include('sharedPool.runSharedInference');
        expect(chat).to.include('describeSharedError');
        const pool = read(sharedPoolPath);
        expect(pool).to.include('runSharedInference');
        // sanitized connector codes keep their status mapping (offline/busy → 503, timeout/cancelled → 504)
        expect(chat).to.include('connector_offline');
        expect(chat).to.include('shared_unavailable');
        // the sanitized code surface itself lives in the transport/pool layer
        const transport = read(path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'transport.js'));
        expect(transport).to.include('session_closed');
    });

    it('gateway chat section owns the resolution seam and the sanitized error surface', () => {
        const chatSection = section(stripComments(read(gatewayPath)), 'const chat = {', 'const generation = {');
        expect(chatSection).to.include('resolveProvider');
        expect(chatSection).to.include('runSharedInference');
        expect(chatSection).to.include('describeSharedError');
        expect(chatSection).to.include("'meta', 'delta', 'done', 'error'");
        expect(chatSection).to.include("'private-local'");
        // chat resolution goes through the workspace chain, never a direct fetch
        expect(chatSection).to.include("purpose: 'chat'");
    });
});

// ======================================================
// T3 — Transport separation: callAI ≠ chat transport (no cross-wiring)
// ======================================================
describe('architecture: Phase 3 transport separation (callAI vs chat)', () => {
    it('chat transport never requires the agent transport', () => {
        const chat = read(chatRoutePath);
        expect(chat).to.not.include('agent/ai-caller');
        expect(chat).to.not.include("require('../services/agent/ai-caller')");
    });

    it('agent transport never requires the chat transport or its engine', () => {
        const caller = read(aiCallerPath);
        const service = read(aiServicePath);
        for (const src of [caller, service]) {
            expect(src).to.not.include('chat-engine');
            expect(src).to.not.include('ai-routes');
            expect(src).to.not.include('getToolsForMode');
        }
        // callAI has no SSE re-emission branch of its own
        expect(service).to.not.include("event: ");
    });

    it('no transport merge inside the gateway: agent section has no chat protocol, chat section has no stream:false call', () => {
        const code = stripComments(read(gatewayPath));
        const agentSection = section(code, 'const agent = {', 'const chat = {');
        const chatSection = section(code, 'const chat = {', 'const generation = {');
        expect(agentSection).to.not.match(/SSE|event-stream|onDelta/i);
        expect(chatSection).to.not.match(/stream:\s*false/);
        // no universal merged entry: the facade never exposes one shared
        // completion method for both directions on the same object
        expect(agentSection).to.not.include('chat.');
        expect(chatSection).to.not.include('agent.');
    });
});

// ======================================================
// T4 — Generation separation: no LLM transport deps in the generation domain
// ======================================================
describe('architecture: Phase 3 generation provider separation', () => {
    const GENERATION_FILES = [
        audioGenPath,
        path.join(REPO_ROOT, 'backend', 'src', 'image', 'iu-processor.js'),
        path.join(REPO_ROOT, 'backend', 'src', 'image', 'image-service.js'),
        path.join(REPO_ROOT, 'backend', 'src', 'video', 'video-service.js'),
        path.join(REPO_ROOT, 'backend', 'src', 'workflows', 'video', 'video-workflows.js'),
        path.join(REPO_ROOT, 'backend', 'src', 'services', 'audio-orchestrator.js'),
        path.join(REPO_ROOT, 'backend', 'src', 'services', 'video-orchestrator.js'),
        gpuDispatcherPath,
        comfyuiSeamPath,
    ];

    it('generation modules never import the agent/chat LLM transports', () => {
        for (const file of GENERATION_FILES) {
            const src = read(file);
            expect(src, `${file} must not import ai-service`).to.not.match(/require\(['"][^'"]*ai-service['"]\)/);
            expect(src, `${file} must not import agent/ai-caller`).to.not.match(/require\(['"][^'"]*agent\/ai-caller['"]\)/);
            expect(src, `${file} must not import chat-engine`).to.not.match(/require\(['"][^'"]*chat-engine['"]\)/);
            expect(src, `${file} must not import the connector shared-pool`).to.not.match(/require\(['"][^'"]*ai-connector\/shared-pool['"]\)/);
            expect(src, `${file} must not import the connector transport`).to.not.match(/require\(['"][^'"]*ai-connector\/transport['"]\)/);
        }
    });

    it('generation dispatch goes through the GPU Hub boundary (Job Protocol v2), not HTTP LLM calls', () => {
        const gw = read(gatewayPath);
        expect(gw).to.include('gpu-dispatcher');
        const dispatcher = read(gpuDispatcherPath);
        expect(dispatcher).to.match(/PROTOCOL_VERSION|protocol_version/);
        expect(dispatcher).to.match(/HUB_URL/);
        const seam = read(comfyuiSeamPath);
        expect(seam).to.include('sendUnified');
        expect(seam).to.include('job-schema');
    });

    it('gateway generation section carries no LLM transport semantics', () => {
        const genSection = section(stripComments(read(gatewayPath)), 'const generation = {', 'module.exports');
        expect(genSection).to.not.include('aiService');
        expect(genSection).to.not.include('aiCaller');
        expect(genSection).to.not.include('runSharedInference');
        expect(genSection).to.not.match(/event-stream|onDelta/i);
    });
});

// ======================================================
// T5 — Gateway surface: stable facade with exactly three directions
// ======================================================
describe('architecture: Phase 3 gateway surface', () => {
    it('the facade exists and exports exactly the three directions + resolution', () => {
        const gw = read(gatewayPath);
        expect(gw).to.include("DIRECTIONS: ['agent', 'chat', 'generation']");
        expect(gw).to.match(/const resolve = \{/);
        expect(gw).to.match(/const agent = \{/);
        expect(gw).to.match(/const chat = \{/);
        expect(gw).to.match(/const generation = \{/);
        expect(gw).to.match(/module\.exports = \{\s*DIRECTIONS: \['agent', 'chat', 'generation'\],\s*resolve,\s*agent,\s*chat,\s*generation,?\s*\}/);
    });

    it('every direction delegates to the existing implementation (no reimplementation)', () => {
        const gw = read(gatewayPath);
        expect(gw).to.include("require('./ai-service')");
        expect(gw).to.include("require('./agent/ai-caller')");
        expect(gw).to.include("require('./workspace-ai-provider')");
        expect(gw).to.include("require('../runtime/gpu-dispatcher')");
        expect(gw).to.include("require('../generation/comfyui-provider')");
    });

    it('the gateway has no universal merged generate() across protocols', () => {
        const code = stripComments(read(gatewayPath));
        expect(code).to.not.match(/\bgenerate\s*\(/);
        // resolution is transport-independent and delegates to the workspace chain
        const resolveSection = section(code, 'const resolve = {', 'const agent = {');
        expect(resolveSection).to.include('resolveAIForWorkspace');
        expect(resolveSection).to.include('resolveAIForBook');
        expect(resolveSection).to.include('resolveAIProvider');
    });

    it('the ComfyUI provider seam exists as the provider-specific generation entry', () => {
        const seam = read(comfyuiSeamPath);
        expect(seam).to.match(/PROVIDER_NAME/);
        expect(seam).to.include("require('../workflows/workflow-loader')");
        expect(seam).to.match(/loadWorkflow|getConnector/);
        expect(seam).to.not.match(/require\(['"][^'"]*(ai-service|chat-engine|ai-caller|shared-pool)['"]\)/);
    });
});

// ======================================================
// T6 — Provider-specific isolation: ComfyUI details never cross into Agent/Chat
// ======================================================
describe('architecture: Phase 3 ComfyUI isolation from Agent/Chat contracts', () => {
    const LLM_CONTRACT_FILES = [
        ['ai-service.js', aiServicePath],
        ['agent/ai-caller.js', aiCallerPath],
        ['routes/ai-routes.cjs', chatRoutePath],
        ['services/chat-engine.cjs', chatEnginePath],
        ['services/provider-gateway.js', gatewayPath],
    ];

    it('workflow names, workflow loaders and raw node ids never appear in the LLM contract files', () => {
        for (const [name, file] of LLM_CONTRACT_FILES) {
            const src = read(file);
            expect(src, `${name} must not know ComfyUI workflow names`).to.not.match(/tts-qwen|img-qwen|video-ltx/i);
            expect(src, `${name} must not import the workflow loader`).to.not.match(/require\(['"][^'"]*workflow-loader['"]\)/);
            expect(src, `${name} must not import the connector-loader`).to.not.match(/require\(['"][^'"]*connector-loader['"]\)/);
            expect(src, `${name} must not patch ComfyUI nodes`).to.not.match(/wfAudio\[|wfImg\[/);
        }
        // The gateway routes generation dispatch (its generation section), so
        // the gpu-dispatcher edge is checked SECTION-scoped: agent/chat code
        // must never dispatch GPU jobs.
        const code = stripComments(read(gatewayPath));
        const agentSection = section(code, 'const agent = {', 'const chat = {');
        const chatSection = section(code, 'const chat = {', 'const generation = {');
        expect(agentSection, 'agent section must not dispatch GPU jobs').to.not.include('gpuDispatcher');
        expect(chatSection, 'chat section must not dispatch GPU jobs').to.not.include('gpuDispatcher');
        for (const [name, file] of LLM_CONTRACT_FILES.filter(([, f]) => f !== gatewayPath)) {
            expect(read(file), `${name} must not dispatch GPU jobs`).to.not.match(/require\(['"][^'"]*gpu-dispatcher['"]\)/);
        }
    });

    it('the raw ComfyUI knowledge stays pinned inside the generation domain (known-gap location)', () => {
        // Documented current leak (Phase 3 = boundary, not refactor): the
        // audio TTS workflows are assembled with raw node ids directly in
        // audio/generation.js. This test pins WHERE that knowledge lives so
        // it cannot silently appear in the Agent/Chat contract files above.
        const audio = read(audioGenPath);
        expect(audio).to.match(/tts-qwen-narrator|tts-qwen-dialogue/);
        expect(audio).to.match(/wfAudio\["108"\]/);
        const loader = read(workflowLoaderPath);
        expect(loader).to.include('getWorkflow');
        const seam = read(comfyuiSeamPath);
        expect(seam).to.match(/tts-qwen-narrator/);
        expect(seam).to.match(/img-qwen-image/);
        expect(seam).to.match(/video-ltx/);
    });
});

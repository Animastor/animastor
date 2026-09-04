// ======================================================
// GUARDRAIL 5 — Chat transport contract (Phase 1)
// ======================================================
// The final review REJECTED the first audit's proposal to merge the chat
// route into callAI. The two transports serve different consumers and must
// stay SEPARATE:
//
//   callAI (services/agent/ai-caller.js → ai-service.callAI)
//     — non-streaming JSON transport for agent pipelines;
//     — retry + provider context (AsyncLocalStorage), stream:false.
//
//   Chat transport (routes/ai-routes.cjs)
//     — SSE (text/event-stream);
//     — tools / tool_choice;
//     — AbortController (timeouts + shared disconnect);
//     — connector transport (runSharedInference via shared-pool);
//     — shared-pool slots (reserve/release lifecycle).
//
// This test guarantees the chat transport KEEPS its streaming/chat
// capabilities and that callAI does not silently grow them (which would
// start the merge the review forbade).
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §Chat transport.

const { expect } = require('chai');
const path = require('path');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const chatRoutePath = path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-routes.cjs');
const aiCallerPath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'agent', 'ai-caller.js');
const aiServicePath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-service.js');
const sharedPoolPath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'shared-pool.js');

describe('architecture: chat transport contract', () => {
    it('chat transport keeps SSE streaming capability', () => {
        const chat = readSource(chatRoutePath);
        expect(chat).to.include("'text/event-stream; charset=utf-8'");
        expect(chat).to.include('writeEvent');
    });

    it('chat transport keeps tool-calling capability', () => {
        const chat = readSource(chatRoutePath);
        expect(chat).to.include('getToolsForMode');
        expect(chat).to.match(/tools:\s*tools\.length\s*>\s*0\s*\?\s*tools\s*:\s*undefined/);
        expect(chat).to.match(/tool_choice/);
        expect(chat).to.include('extractToolCallsFromContent');
    });

    it('chat transport keeps AbortController lifecycle (timeout + shared disconnect)', () => {
        const chat = readSource(chatRoutePath);
        expect(chat).to.match(/new AbortController\(\)/);
        // shared inference borrows capacity: res 'close' must abort
        expect(chat).to.include('disconnectSignal');
        expect(chat).to.include("res.on('close', onConnClosed)");
    });

    it('chat transport keeps the connector path via shared-pool (runSharedInference)', () => {
        const chat = readSource(chatRoutePath);
        expect(chat).to.include("ai.transport === 'connector'");
        expect(chat).to.include('sharedPool.runSharedInference');
        const pool = readSource(sharedPoolPath);
        expect(pool).to.include('runSharedInference');
    });

    it('callAI stays a non-streaming JSON transport for agents (no SSE/tools/pool creep)', () => {
        const caller = readSource(aiCallerPath);
        const service = readSource(aiServicePath);
        expect(caller).to.include('callAI(');
        // no streaming surface in the agent path
        expect(caller).to.not.include('text/event-stream');
        expect(caller).to.not.include('writeEvent');
        expect(caller).to.not.include('getToolsForMode');
        // agent transport defaults to stream:false
        expect(service).to.match(/stream:\s*false/);
    });

    it('agent pipelines consume callAI; chat route consumes its own transport (no cross-wiring)', () => {
        const chat = readSource(chatRoutePath);
        // chat route must NOT fall back to ai-caller (agent transport)
        expect(chat).to.not.include('agent/ai-caller');
        expect(chat).to.not.include("require('../services/agent/ai-caller')");
    });
});

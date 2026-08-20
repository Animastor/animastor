// ======================================================
// Agent AI Caller
// ======================================================
// Transport separation for the agent pipeline: the pipeline steps only pass
// { maxTokens, timeout } — they do NOT know which workspace/provider they
// run for. The bootstrap/wrapper resolves the workspace provider ONCE from
// the book and runs the pipeline inside runWithProvider(...). callAI picks
// the provider from explicit options or the AsyncLocalStorage context, and
// ai-service.callAI falls back to global env when neither is present.

const { AsyncLocalStorage } = require('async_hooks');
const { query } = require('../../storage/postgres/database');
const config = require('../../config/runtime-config');
const aiService = require('../ai-service');
const { STEP_RETRIES } = require('../agent-prompts');

const providerStore = new AsyncLocalStorage();

/** Run `fn` inside an explicit AI provider context. */
async function runWithProvider(provider, fn) {
    if (!provider) return fn();
    return providerStore.run(provider, fn);
}

/** Currently active provider context (or null outside one). */
function getActiveProvider() {
    return providerStore.getStore() || null;
}

async function callAI(messages, options) {
    const provider = options?.provider || getActiveProvider();
    const model = options?.model
        || (provider && provider.model)
        || config.OPENROUTER_MODEL
        || 'qwen/qwen3.5-122b-a10b';

    let lastError = null;
    const attemptCount = options?.retries || STEP_RETRIES;
    for (let attempt = 1; attempt <= attemptCount; attempt++) {
        try {
            const response = await aiService.callAI(messages, {
                ...options,
                model,
                timeout: options?.timeout || 180000,
                maxTokens: options?.maxTokens || 2048,
            }, provider);
            const parsed = aiService.parseJsonResponse(response.content);
            return parsed;
        } catch (err) {
            lastError = err;
            console.warn(`[AGENT] AI call attempt ${attempt} failed: ${err.message}`);
            if (attempt < attemptCount) {
                const delay = 2000 * attempt;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`AI call failed after ${attemptCount} attempts: ${lastError?.message || 'unknown error'}`);
}

async function logConversation(sessionId, stepId, messages, responseContent) {
    const result = await query(
        `INSERT INTO agent_conversations (session_id, step_id, attempt) VALUES ($1, $2, 1) RETURNING *`,
        [sessionId, stepId]
    );
    const convId = result.rows[0].conversation_id;
    for (const msg of messages) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [convId, msg.role, msg.content]
        );
    }
    if (responseContent) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
            [convId, responseContent]
        );
    }
}

module.exports = {
    callAI,
    runWithProvider,
    getActiveProvider,
    logConversation,
};

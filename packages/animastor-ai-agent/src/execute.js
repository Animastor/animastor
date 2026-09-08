// ======================================================
// AI Agent Core — generic task execution lifecycle
// ======================================================
// The single generic entry point for running any AI task through the
// standard lifecycle:
//
//   task → buildMessages → callAI → structured JSON → task-owned
//   normalize/validation → result | error/degradation
//
// Every concrete AI task (analysis, authoring, generation, or any future
// AI task) is defined as a declarative task object. The core owns the
// lifecycle; task-specific logic — including result validation and
// degradation — lives in the task definition's callbacks.
//
// VALIDATION IS TASK-OWNED: the core does NOT know any semantic schema.
// A task validates/normalizes its AI result in `normalize` (throwing there
// is treated exactly like an AI failure: failStep + onError/rethrow).
//
// Zero domain knowledge. Zero requires beyond assertHostPorts.
// The task object must be provided by the caller — this module never
// imports concrete analyzers, prompts, providers, or generation code.

const { assertHostPorts } = require('./ports');

/**
 * Execute a generic AI task through the standard lifecycle.
 *
 * Task definition contract:
 *
 *   {
 *     requiredPorts: string[],              // port names this task needs
 *     taskName: string,                     // e.g. 'ai-agent/locations'
 *     stage: string,                        // progress stage key
 *     progressMessage: (ports) => string,   // resolve progress text from ports
 *     stepType: string,                     // PG step type, e.g. 'analyze_locations'
 *     buildMessages: (input, ports) => {    // build AI messages + options
 *       messages: Array<{role, content}>,
 *       options?: { maxTokens?: number }
 *     },
 *     normalize?: (result, input, ports) => any,  // task-owned validation + post-processing
 *     failMessage?: (err) => string,              // custom failStep message (default: err.message)
 *     onError?: (err, step, ports, input) => any, // custom degradation (default: rethrow)
 *   }
 *
 * Lifecycle:
 *   Pre-step (no PG step exists yet — an error here propagates as-is,
 *   failStep is NOT called because there is nothing to fail):
 *     1. assertHostPorts (fail-closed)
 *     2. resolve progress message
 *     3. emit progress + updateSession
 *     4. createStep
 *   Post-step (one shared error path — failStep is called AT MOST ONCE):
 *     5. buildMessages (task-specific)
 *     6. callAI (injected seam)
 *     7. normalize (task-owned validation)
 *     8. logConversation
 *     9. completeStep
 *    10. return result
 *   On ANY error in 5–9:
 *     a. failStep(step_id, failMessage(err) || err.message) — shielded:
 *        if failStep itself throws, the original error is preserved
 *        (the failure is logged, never re-thrown over the original)
 *     b. onError(err, step, ports, input) if defined, else rethrow err
 *
 * @param {object} task - Declarative task definition
 * @param {object} input - Task input (must include sessionId, stepIndex?, progress?)
 * @param {object} ports - Host-injected ports
 * @returns {Promise<any>} Task result
 */
async function execute(task, input, ports) {
    // ── 1. Validate host ports (fail-closed; pre-step) ──
    const _ports = assertHostPorts(ports, task.requiredPorts, task.taskName);

    // ── 2. Resolve progress message (pre-step) ──
    const message = task.progressMessage(_ports);

    // ── 3. Emit progress + update session (pre-step) ──
    const _progress = input.progress || (() => {});
    _progress({ stage: task.stage, message });
    await _ports.updateSession(input.sessionId, { progress_msg: message });

    // ── 4. Create step (pre-step for error handling: no step → no failStep) ──
    const step = await _ports.createStep(
        input.sessionId,
        task.stepType,
        input.stepIndex || 0,
        input.sceneIndex,
    );

    // ── 5–9. Everything after step creation shares ONE error path ──
    // buildMessages is inside the guarded region: a task-side prompt-assembly
    // bug must not leave the PG step dangling in a non-terminal state.
    try {
        const { messages, options } = task.buildMessages(input, _ports);
        const rawResult = await _ports.callAI(messages, options || {});
        const result = task.normalize ? task.normalize(rawResult, input, _ports) : rawResult;
        await _ports.logConversation(input.sessionId, step.step_id, messages, JSON.stringify(rawResult));
        await _ports.completeStep(step.step_id, result);
        return result;
    } catch (err) {
        // failStep exactly once, shielded: a failing failStep (e.g. PG down)
        // must never mask the original task error.
        try {
            const failMsg = task.failMessage ? task.failMessage(err) : err.message;
            await _ports.failStep(step.step_id, failMsg);
        } catch (failErr) {
            console.warn(`[ai-agent] ${task.taskName}: failStep also failed: ${failErr.message} (original error kept: ${err.message})`);
        }
        if (task.onError) {
            return task.onError(err, step, _ports, input);
        }
        throw err;
    }
}

module.exports = { execute };

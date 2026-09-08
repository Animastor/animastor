// ======================================================
// AI Agent Core — generic task execution lifecycle
// ======================================================
// The single generic entry point for running any AI task through the
// standard lifecycle:
//
//   task → prompt/rules/skills → callAI → structured JSON → validation
//   → error/degradation
//
// Every concrete AI task (analysis, authoring, generation, or any future
// AI task) is defined as a declarative task object. The core owns the
// lifecycle; task-specific logic lives in the task definition's callbacks.
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
 *     normalize?: (result, input, ports) => any,  // post-process raw AI result
 *     failMessage?: (err) => string,              // custom failStep message (default: err.message)
 *     onError?: (err, step, ports) => any,        // custom degradation (default: rethrow)
 *   }
 *
 * Lifecycle:
 *   1. assertHostPorts (fail-closed)
 *   2. resolve progress message from ports
 *   3. emit progress + updateSession
 *   4. createStep
 *   5. buildMessages (task-specific)
 *   6. callAI (injected seam)
 *   7. normalize → log → complete
 *   on error: failStep (with failMessage or err.message) + onError (or rethrow)
 *
 * @param {object} task - Declarative task definition
 * @param {object} input - Task input (must include sessionId, stepIndex?, progress?)
 * @param {object} ports - Host-injected ports
 * @returns {Promise<any>} Task result
 */
async function execute(task, input, ports) {
    // ── 1. Validate host ports (fail-closed) ──
    const _ports = assertHostPorts(ports, task.requiredPorts, task.taskName);

    // ── 2. Resolve progress message ──
    const message = task.progressMessage(_ports);

    // ── 3. Emit progress + update session ──
    const _progress = input.progress || (() => {});
    _progress({ stage: task.stage, message });
    await _ports.updateSession(input.sessionId, { progress_msg: message });

    // ── 4. Create step ──
    const step = await _ports.createStep(
        input.sessionId,
        task.stepType,
        input.stepIndex || 0,
        input.sceneIndex,
    );

    // ── 5. Build messages (task-specific) ──
    const { messages, options } = task.buildMessages(input, _ports);

    // ── 6–9. Call AI → normalize → log → complete ──
    try {
        const rawResult = await _ports.callAI(messages, options || {});
        const result = task.normalize ? task.normalize(rawResult, input, _ports) : rawResult;
        await _ports.logConversation(input.sessionId, step.step_id, messages, JSON.stringify(rawResult));
        await _ports.completeStep(step.step_id, result);
        return result;
    } catch (err) {
        const failMsg = task.failMessage ? task.failMessage(err) : err.message;
        await _ports.failStep(step.step_id, failMsg);
        if (task.onError) {
            return task.onError(err, step, _ports);
        }
        throw err;
    }
}

module.exports = { execute };

// ======================================================
// AI Agent Core — execute() unit tests
// ======================================================
// Tests the generic task execution lifecycle in isolation,
// using stub ports to verify the contract without real AI/PG.

const { expect } = require('chai');
const { execute } = require('../../packages/animastor-ai-agent/src/execute');

function stubPorts(overrides = {}) {
    return {
        callAI: async (messages, opts) => ({ ok: true, messages, opts }),
        logConversation: async () => {},
        updateSession: async () => {},
        createStep: async (sid, type, idx, sceneIdx) => ({ step_id: `step-${type}-${idx}`, type, scene_index: sceneIdx }),
        completeStep: async () => {},
        failStep: async () => {},
        extractingLocationsMessage: 'Extracting locations…',
        prompt: (name) => `PROMPT:${name}`,
        fillLang: (text, lang) => text,
        ...overrides,
    };
}

function minimalTask(overrides = {}) {
    return {
        requiredPorts: ['callAI', 'logConversation', 'updateSession', 'createStep', 'completeStep', 'failStep'],
        taskName: 'test-task',
        stage: 'testing',
        progressMessage: () => 'Testing…',
        stepType: 'test_step',
        buildMessages: (input) => ({
            messages: [{ role: 'user', content: input.text || 'hello' }],
            options: { maxTokens: 100 },
        }),
        ...overrides,
    };
}

describe('AI Agent Core: execute() lifecycle', () => {
    const baseInput = { sessionId: 's1', stepIndex: 0, text: 'test' };

    it('returns the raw result when no normalize is defined', async () => {
        const task = minimalTask();
        const ports = stubPorts({ callAI: async () => ({ data: 42 }) });
        const result = await execute(task, baseInput, ports);
        expect(result).to.deep.equal({ data: 42 });
    });

    it('calls buildMessages with resolved input and ports', async () => {
        let capturedInput, capturedPorts;
        const task = minimalTask({
            buildMessages(input, ports) {
                capturedInput = input;
                capturedPorts = ports;
                return { messages: [{ role: 'user', content: 'x' }] };
            },
        });
        const ports = stubPorts();
        await execute(task, baseInput, ports);
        expect(capturedInput).to.equal(baseInput);
        expect(capturedPorts).to.have.property('callAI');
    });

    it('passes options from buildMessages to callAI', async () => {
        let capturedOpts;
        const task = minimalTask({
            buildMessages: () => ({
                messages: [{ role: 'user', content: 'x' }],
                options: { maxTokens: 2048, temperature: 0.7 },
            }),
        });
        const ports = stubPorts({
            callAI: async (msgs, opts) => { capturedOpts = opts; return {}; },
        });
        await execute(task, baseInput, ports);
        expect(capturedOpts).to.deep.equal({ maxTokens: 2048, temperature: 0.7 });
    });

    it('defaults options to {} when buildMessages omits options', async () => {
        let capturedOpts;
        const task = minimalTask({
            buildMessages: () => ({ messages: [{ role: 'user', content: 'x' }] }),
        });
        const ports = stubPorts({
            callAI: async (msgs, opts) => { capturedOpts = opts; return {}; },
        });
        await execute(task, baseInput, ports);
        expect(capturedOpts).to.deep.equal({});
    });

    it('applies normalize to the raw AI result', async () => {
        const task = minimalTask({
            normalize: (result) => ({ normalized: true, original: result }),
        });
        const ports = stubPorts({ callAI: async () => ({ raw: 1 }) });
        const result = await execute(task, baseInput, ports);
        expect(result).to.deep.equal({ normalized: true, original: { raw: 1 } });
    });

    it('normalize receives (rawResult, input, ports)', async () => {
        let capturedArgs;
        const task = minimalTask({
            normalize: (raw, input, ports) => {
                capturedArgs = { raw, input, ports };
                return raw;
            },
        });
        const ports = stubPorts({ callAI: async () => ({ x: 1 }) });
        await execute(task, baseInput, ports);
        expect(capturedArgs.raw).to.deep.equal({ x: 1 });
        expect(capturedArgs.input).to.equal(baseInput);
        expect(capturedArgs.ports).to.have.property('callAI');
    });

    it('logs the raw result (not the normalized result) to logConversation', async () => {
        let loggedPayload;
        const task = minimalTask({
            normalize: () => ({ normalized: true }),
        });
        const ports = stubPorts({
            callAI: async () => ({ raw: 'data' }),
            logConversation: async (sid, stepId, msgs, payload) => { loggedPayload = payload; },
        });
        await execute(task, baseInput, ports);
        expect(loggedPayload).to.equal(JSON.stringify({ raw: 'data' }));
    });

    it('passes the normalized result to completeStep', async () => {
        let completedPayload;
        const task = minimalTask({
            normalize: () => ({ normalized: true }),
        });
        const ports = stubPorts({
            callAI: async () => ({ raw: 'data' }),
            completeStep: async (stepId, payload) => { completedPayload = payload; },
        });
        await execute(task, baseInput, ports);
        expect(completedPayload).to.deep.equal({ normalized: true });
    });

    it('emits progress and updates session before calling AI', async () => {
        const callOrder = [];
        const task = minimalTask({
            progressMessage: () => 'My progress',
            stage: 'my_stage',
        });
        const ports = stubPorts({
            updateSession: async () => { callOrder.push('updateSession'); },
            createStep: async () => { callOrder.push('createStep'); return { step_id: 's1' }; },
            callAI: async () => { callOrder.push('callAI'); return {}; },
        });
        const progressEvents = [];
        const input = { ...baseInput, progress: (e) => progressEvents.push(e) };
        await execute(task, input, ports);
        expect(progressEvents[0]).to.deep.equal({ stage: 'my_stage', message: 'My progress' });
        expect(callOrder).to.deep.equal(['updateSession', 'createStep', 'callAI']);
    });

    it('uses stepIndex 0 when stepIndex is omitted', async () => {
        let capturedType, capturedIdx;
        const task = minimalTask();
        const ports = stubPorts({
            createStep: async (sid, type, idx) => { capturedType = type; capturedIdx = idx; return { step_id: 's1' }; },
        });
        await execute(task, { sessionId: 's1' }, ports);
        expect(capturedType).to.equal('test_step');
        expect(capturedIdx).to.equal(0);
    });

    it('passes sceneIndex to createStep when provided', async () => {
        let capturedSceneIdx;
        const task = minimalTask();
        const ports = stubPorts({
            createStep: async (sid, type, idx, sceneIdx) => { capturedSceneIdx = sceneIdx; return { step_id: 's1' }; },
        });
        await execute(task, { ...baseInput, sceneIndex: 3 }, ports);
        expect(capturedSceneIdx).to.equal(3);
    });

    it('on error: calls failStep then onError (when defined)', async () => {
        let failStepMsg;
        const task = minimalTask({
            onError: (err, step, ports) => ({ degraded: true, msg: err.message }),
        });
        const ports = stubPorts({
            callAI: async () => { throw new Error('AI down'); },
            failStep: async (stepId, msg) => { failStepMsg = msg; },
        });
        const result = await execute(task, baseInput, ports);
        expect(failStepMsg).to.equal('AI down');
        expect(result).to.deep.equal({ degraded: true, msg: 'AI down' });
    });

    it('on error: calls failStep then rethrows (when no onError)', async () => {
        let failStepMsg;
        const task = minimalTask();
        const ports = stubPorts({
            callAI: async () => { throw new Error('AI exploded'); },
            failStep: async (stepId, msg) => { failStepMsg = msg; },
        });
        try {
            await execute(task, baseInput, ports);
            expect.fail('should have thrown');
        } catch (err) {
            expect(err.message).to.equal('AI exploded');
        }
        expect(failStepMsg).to.equal('AI exploded');
    });

    it('uses failMessage callback when provided', async () => {
        let failStepMsg;
        const task = minimalTask({
            failMessage: (err) => `custom: ${err.message}`,
            onError: () => ({ degraded: true }),
        });
        const ports = stubPorts({
            callAI: async () => { throw new Error('boom'); },
            failStep: async (stepId, msg) => { failStepMsg = msg; },
        });
        await execute(task, baseInput, ports);
        expect(failStepMsg).to.equal('custom: boom');
    });

    it('validates required ports and throws when missing', async () => {
        const task = minimalTask({ requiredPorts: ['callAI', 'missingPort'] });
        const ports = stubPorts();
        delete ports.missingPort;
        try {
            await execute(task, baseInput, ports);
            expect.fail('should have thrown');
        } catch (err) {
            expect(err.message).to.include('missingPort');
            expect(err.message).to.include('missing host port');
        }
    });

    it('does not call AI when ports are missing (fail-closed)', async () => {
        let aiCalled = false;
        const task = minimalTask({ requiredPorts: ['callAI', 'nope'] });
        const ports = stubPorts({ callAI: async () => { aiCalled = true; return {}; } });
        try {
            await execute(task, baseInput, ports);
        } catch (_) { /* expected */ }
        expect(aiCalled).to.equal(false);
    });

    it('passes a progress function from input when provided', async () => {
        const events = [];
        const task = minimalTask({
            progressMessage: () => 'msg',
            stage: 'stg',
        });
        const ports = stubPorts();
        const input = { ...baseInput, progress: (e) => events.push(e) };
        await execute(task, input, ports);
        expect(events).to.have.lengthOf(1);
        expect(events[0]).to.deep.equal({ stage: 'stg', message: 'msg' });
    });

    it('does not throw when input.progress is omitted', async () => {
        const task = minimalTask({ progressMessage: () => 'msg', stage: 'stg' });
        const ports = stubPorts();
        await execute(task, { sessionId: 's1' }, ports);
    });
});

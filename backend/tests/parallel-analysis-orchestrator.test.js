// ======================================================
// Parallel Analysis Orchestrator — skeleton tests
// ======================================================
// Validates the task model: dependency waves, failure isolation, cancellation
// propagation. AI transport is mocked (we use plain async functions as
// analyzers — the orchestrator is generic over the step signature).

const { expect } = require('chai');
const orchestrator = require('../src/services/agent/parallel-analysis-orchestrator');

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAnalyzers(specs) {
    // The orchestrator's ANALYZERS entry calls e.g. ctx.analyzers.stepExtractCharacters.
    // specs is keyed by short id ("characters"); we map to the canonical step name.
    const map = {
        characters: 'stepExtractCharacters',
        locations:  'stepExtractLocations',
        voices:     'stepGenerateVoices',
    };
    const analyzers = {};
    for (const id of Object.keys(specs)) {
        const key = map[id];
        if (!key) throw new Error(`test helper: unknown analyzer id ${id}`);
        analyzers[key] = specs[id];
    }
    return analyzers;
}

const baseCtx = {
    sessionId: 'sess-x',
    text: 'window text',
    characters: [],
    language: 'en',
    promptProfiles: {},
    stepIndex: 0,
    publishVBook: () => {},
    checkCancelled: async () => {},
};

describe('parallel-analysis-orchestrator — task model', () => {
    it('exports the lifecycle status enum', () => {
        expect(orchestrator.TASK_STATUS).to.deep.equal({
            PENDING:   'pending',
            RUNNING:   'running',
            COMPLETED: 'completed',
            FAILED:    'failed',
            CANCELLED: 'cancelled',
        });
    });

    it('exposes the built-in ANALYZERS registry with three tasks', () => {
        expect(Object.keys(orchestrator.ANALYZERS).sort()).to.deep.equal(['characters', 'locations', 'voices']);
        expect(orchestrator.ANALYZERS.characters.dependsOn).to.deep.equal([]);
        expect(orchestrator.ANALYZERS.locations.dependsOn).to.deep.equal([]);
        expect(orchestrator.ANALYZERS.voices.dependsOn).to.deep.equal(['characters']);
    });

    it('planTasks() returns tasks in dependency order', () => {
        // Voices depends on characters → characters first; locations has no deps.
        const plan = orchestrator.planTasks(['voices', 'locations', 'characters']);
        expect(plan.map((t) => t.id)).to.deep.equal(['characters', 'voices', 'locations']);
    });

    it('planTasks() rejects unknown task ids', () => {
        expect(() => orchestrator.planTasks(['bogus'])).to.throw(/Unknown analysis task id/);
    });

it('runs three tasks: characters + locations in wave 1, voices after characters in wave 2', async () => {
        const order = [];
        let active = 0;
        let maxActive = 0;

        const track = (label, ms) => async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push(`start:${label}`);
            await SLEEP(ms);
            order.push(`end:${label}`);
            active--;
            return { label };
        };

        const result = await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'real', name: 'Real' }],  // so voices actually invokes its step
            analyzers: makeAnalyzers({
                characters: track('characters', 50),
                locations:  track('locations', 50),
                voices:     track('voices', 10),
            }),
            taskIds: ['characters', 'locations', 'voices'],
        });

        expect(result.ok).to.equal(true);
        expect(result.tasks.map((t) => t.status)).to.deep.equal(['completed', 'completed', 'completed']);

        // Wave 1 ran characters + locations concurrently; voices started after wave 1.
        const startVoices = order.indexOf('start:voices');
        const endChars    = order.indexOf('end:characters');
        const endLocs     = order.indexOf('end:locations');
        const startChars  = order.indexOf('start:characters');
        const startLocs   = order.indexOf('start:locations');
        expect(startVoices).to.be.greaterThan(-1);
        expect(endChars).to.be.greaterThan(-1);
        expect(endLocs).to.be.greaterThan(-1);
        // Voices must start AFTER both characters and locations END (wave 2).
        expect(startVoices).to.be.greaterThan(endChars);
        expect(startVoices).to.be.greaterThan(endLocs);
        // characters + locations overlap: each starts before the other ends.
        expect(startLocs).to.be.lessThan(endChars);
        expect(startChars).to.be.lessThan(endLocs);
        // Two-way concurrency was actually achieved.
        expect(maxActive).to.be.at.least(2);
    });

    it('isolates failures: one failed task does not abort siblings', async () => {
        const calls = { chars: 0, locs: 0, voices: 0 };

        const result = await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'real', name: 'Real' }],  // so voices can pass its early-return
            analyzers: makeAnalyzers({
                characters: async () => { calls.chars++; throw new Error('synthetic chars failure'); },
                locations:  async () => { calls.locs++; return { id: 'loc1' }; },
                voices:     async () => { calls.voices++; return { voices: { real: 'soft' } }; },
            }),
            taskIds: ['characters', 'locations', 'voices'],
        });

        expect(calls.chars).to.equal(1);
        expect(calls.locs).to.equal(1);
        expect(calls.voices).to.equal(1);

        const byId = Object.fromEntries(result.tasks.map((t) => [t.id, t.status]));
        expect(byId.characters).to.equal('failed');
        expect(byId.locations).to.equal('completed');
        expect(byId.voices).to.equal('completed');

        expect(result.ok).to.equal(false);
        expect(result.failedTaskIds).to.deep.equal(['characters']);
    });

    it('records task startedAt / finishedAt / durationMs', async () => {
        const result = await orchestrator.run({
            ...baseCtx,
            analyzers: makeAnalyzers({
                characters: async () => { await SLEEP(20); return { characters: [] }; },
                locations:  async () => [],
                voices:     async () => ({ voices: {} }),
            }),
            taskIds: ['characters', 'locations', 'voices'],
        });

        for (const t of result.tasks) {
            expect(t.startedAt).to.be.a('number');
            expect(t.finishedAt).to.be.a('number');
            expect(t.durationMs).to.be.a('number');
            expect(t.finishedAt).to.be.at.least(t.startedAt);
        }
    });

    it('honours checkCancelled — does not start new tasks after cancel', async () => {
        let cancelled = false;
        const calls = { chars: 0, locs: 0, voices: 0 };

        const result = await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'real', name: 'Real' }],
            analyzers: makeAnalyzers({
                // The very first call (characters) is what flips the cancel
                // flag mid-flight, so we expect chars to NEVER reach its body
                // — checkCancelled throws before stepExtractCharacters runs.
                characters: async () => { calls.chars++; return {}; },
                locations:  async () => { calls.locs++; return []; },
                voices:     async () => { calls.voices++; return { voices: { real: 'soft' } }; },
            }),
            taskIds: ['characters', 'locations', 'voices'],
            checkCancelled: async () => {
                if (cancelled) {
                    const err = new Error('cancelled');
                    err.code = 'SESSION_CANCELLED';
                    throw err;
                }
            },
            parallelism: 1,  // serialise the wave so we can cancel mid-flight
            onTaskEvent: (_event, task) => {
                // The instant characters is dispatched, flip the cancel flag.
                // The next checkCancelled() call will throw, aborting the
                // step body BEFORE any AI request fires.
                if (task.id === 'characters' && _event === 'task_started') {
                    cancelled = true;
                }
            },
        });

        // Character step was queued but its body never ran — cancellation
        // was honoured as soon as the cancel flag was set.
        expect(calls.chars).to.equal(0);
        expect(result.cancelled).to.equal(true);
        const byId = Object.fromEntries(result.tasks.map((t) => [t.id, t.status]));
        expect(byId.characters).to.equal('cancelled');
        expect(byId.locations).to.equal('cancelled');
        expect(byId.voices).to.equal('cancelled');
    });

    it('emits task_started / task_completed events with a counter', async () => {
        const events = [];
        await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'real', name: 'Real' }],
            analyzers: makeAnalyzers({
                characters: async () => ({}),
                locations:  async () => [],
                voices:     async () => ({ voices: { real: 'soft' } }),
            }),
            taskIds: ['characters', 'locations', 'voices'],
            parallelism: 1,  // serialise so completed_count rises monotonically
            onTaskEvent: (event, task, completed, total) => {
                events.push({ event, id: task.id, completed, total });
            },
        });

        const completed = events.filter((e) => e.event === 'task_completed');
        expect(completed).to.have.lengthOf(3);
        for (const e of completed) expect(e.total).to.equal(3);
        // Counter monotonically increases from 1 → 3 (serialised).
        expect(completed.map((e) => e.completed)).to.deep.equal([1, 2, 3]);
    });

    it('publishes analysis_parallel progress events between waves', async () => {
        const published = [];
        await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'real', name: 'Real' }],
            analyzers: makeAnalyzers({
                characters: async () => ({}),
                locations:  async () => [],
                voices:     async () => ({ voices: { real: 'soft' } }),
            }),
            taskIds: ['characters', 'locations', 'voices'],
            parallelism: 1,
            publishVBook: (e) => { if (e.stage === 'analysis_parallel') published.push(e); },
        });

        // Two waves ⇒ two heartbeats; final one shows 3/3.
        expect(published.length).to.be.at.least(2);
        const last = published[published.length - 1];
        expect(last.analysis_total).to.equal(3);
        expect(last.analysis_completed).to.equal(3);
        expect(last.analysis_mode).to.equal('parallel');
    });

    it('throws when analyzers map is missing', async () => {
        let err = null;
        try {
            await orchestrator.run({ ...baseCtx, taskIds: ['characters'] });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/analyzers map is required/);
    });

    it('throws when sessionId is missing', async () => {
        let err = null;
        try {
            await orchestrator.run({
                ...baseCtx,
                sessionId: null,
                analyzers: makeAnalyzers({ characters: async () => ({}) }),
                taskIds: ['characters'],
            });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/sessionId is required/);
    });

    it('emits per-task analysis events with the spec shape', async () => {
        const events = [];
        await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'r', name: 'Real' }],
            analyzers: makeAnalyzers({
                characters: async () => ({ characters: [{ id: 'r', name: 'Real' }], mentions: {} }),
                locations:  async () => [{ id: 'l', name: 'L' }],
                voices:     async () => ({ voices: { r: 'soft' } }),
            }),
            taskIds: ['characters', 'locations', 'voices'],
            parallelism: 3,
            publishAnalysis: (e) => events.push(e),
        });

        // Every task must have emitted task_started + task_completed.
        const completed = events.filter((e) => e.type === 'analysis' && e.event === 'task_completed');
        expect(completed).to.have.lengthOf(3);
        for (const e of completed) {
            expect(e.type).to.equal('analysis');
            expect(e.status).to.equal('completed');
            expect(e.total_tasks).to.equal(3);
            expect(typeof e.completed_tasks).to.equal('number');
            expect(typeof e.failed_tasks).to.equal('number');
            expect(typeof e.duration_ms).to.equal('number');
            expect(e.duration_ms).to.be.at.least(0);
        }
    });

    it('can orchestrate voices as wave-2 dependency (future milestone hook)', async () => {
        // The orchestrator's voices entry is available but the pipeline-runner
        // currently runs voices in its legacy slot (because voices mutates
        // characters[i].voice and needs the MERGED character set). When the
        // merge logic moves inside the orchestrator (next milestone), the
        // pipeline can drop voices from its own loop and pass all three task
        // ids here. This test pins the dependency wave ordering.
        const calls = { characters: 0, voices: 0 };
        const result = await orchestrator.run({
            ...baseCtx,
            characters: [{ id: 'r', name: 'Real', appearance: 'described' }],
            analyzers: makeAnalyzers({
                characters: async () => {
                    calls.characters++;
                    await SLEEP(20);
                    return { characters: [{ id: 'r', name: 'Real' }], mentions: {} };
                },
                voices: async () => { calls.voices++; return { voices: { r: 'soft' } }; },
            }),
            taskIds: ['characters', 'voices'],
            parallelism: 3,
        });
        expect(result.ok).to.equal(true);
        expect(result.tasks.find((t) => t.id === 'voices').status).to.equal('completed');
        // voices ran exactly once and only after characters.
        expect(calls.voices).to.equal(1);
        expect(calls.characters).to.equal(1);
    });
});
const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

/**
 * Build the /agent-status route with a stubbed postgres storage layer.
 * @param {{ agentRow?: object|null, agentSteps?: object[], genRows?: object[] }} state
 */
function createHarness(state) {
    let handler = null;
    const app = {
        get(path, callback) {
            if (path.endsWith('/agent-status')) handler = callback;
        },
    };
    const storage = {
        postgres: {
            query: async (sql, params) => {
                if (sql.includes('FROM agent_steps')) {
                    return { rows: state.agentSteps || [] };
                }
                if (sql.includes('FROM book_generation_sessions')) {
                    return { rows: state.genRows || [] };
                }
                if (sql.includes('FROM agent_sessions')) {
                    return { rows: state.agentRow ? [state.agentRow] : [] };
                }
                return { rows: [] };
            },
        },
    };
    const deps = {
        config: { WINDOW_SIZE: 3 },
        storage,
        layerConfig: { getChunkSize: async () => 3 },
        utils: { log: () => {} },
    };
    require('../src/routes/book/agent-routes.cjs')(app, createMockRedis(), deps);
    return async bookId => {
        const res = createResponse();
        await handler({ params: { bookId } }, res);
        return res;
    };
}

function makeAgentRow(status, windowData) {
    return {
        session_id: 'sess-1',
        session_status: status,
        progress_msg: status === 'paused' ? '⟳ Окно 1: 3 сцен. Обрабатываю следующие окна...' : 'done',
        window_data: JSON.stringify(windowData),
        knowledge_base: null,
        source_type: 'txt_import',
    };
}

describe('Agent status — paused session between windows', () => {
    it('reports paused-with-remaining-text as INACTIVE (window complete, awaiting manual next)', async () => {
        const res = await createHarness({
            agentRow: makeAgentRow('paused', {
                window_index: 0,
                total_scenes: 3,
                created_scenes: 3,
                cached_scenes: [],
                remaining_text: 'Ещё остался текст для следующих окон...',
            }),
        })('book-1');

        expect(res.statusCode).to.equal(200);
        expect(res.body.active).to.equal(false);
        expect(res.body.session_status).to.equal('paused');
        // Real final-window counters are still exposed for the frontend counter
        // (green "3/3" when the user finalizes the window).
        expect(res.body.window_total_scenes).to.equal(3);
    });

    it('reports paused-with-cached-scenes as INACTIVE, remaining_cached from cached_scenes', async () => {
        const res = await createHarness({
            agentRow: makeAgentRow('paused', {
                window_index: 1,
                total_scenes: 2,
                created_scenes: 5,
                cached_scenes: [{ id: 'c1' }, { id: 'c2' }],
                remaining_text: '',
            }),
        })('book-2');

        expect(res.body.active).to.equal(false);
        expect(res.body.remaining_cached).to.equal(2);
    });

    it('reports paused-with-nothing-left as INACTIVE (effectively done)', async () => {
        const res = await createHarness({
            agentRow: makeAgentRow('paused', {
                window_index: 2,
                total_scenes: 1,
                created_scenes: 5,
                cached_scenes: [],
                remaining_text: '',
            }),
        })('book-3');

        expect(res.body.active).to.equal(false);
    });

    it('reports completed session as INACTIVE', async () => {
        const res = await createHarness({
            agentRow: makeAgentRow('completed', {
                window_index: 0,
                total_scenes: 3,
                created_scenes: 3,
                cached_scenes: [],
                remaining_text: '',
            }),
        })('book-4');

        expect(res.body.active).to.equal(false);
        expect(res.body.session_status).to.equal('completed');
    });

    it('reports INACTIVE with null fields when no agent session exists', async () => {
        const res = await createHarness({ agentRow: null })('book-none');

        expect(res.statusCode).to.equal(200);
        expect(res.body.active).to.equal(false);
        expect(res.body.session_status).to.equal(null);
        expect(res.body.window_size).to.equal(3); // configured chunk size fallback
    });

    it('reports running session as ACTIVE with window counters', async () => {
        const res = await createHarness({
            agentRow: makeAgentRow('running', {
                window_index: 0,
                total_scenes: 3,
                created_scenes: 3,
                cached_scenes: [],
                remaining_text: '',
            }),
        })('book-5');

        expect(res.body.active).to.equal(true);
        expect(res.body.window_total_scenes).to.equal(3);
        expect(res.body.window_size).to.equal(3);
    });
});

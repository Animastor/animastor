const { expect } = require('chai');
const dispatchEngine = require('../src/runtime/dispatch-engine');

describe('GPU Hub dispatch cleanup', () => {
    it('deduplicates dispatch ids and applies API authentication', async () => {
        const calls = [];
        const result = await dispatchEngine.clearHubDispatches(
            ['dispatch-a', 'dispatch-a', 'dispatch-b'],
            {
                hubUrl: 'http://gpu-hub.test',
                apiKey: 'secret',
                fetchImpl: async (url, options) => {
                    calls.push({ url, options });
                    return { ok: true, status: 200 };
                },
            }
        );

        expect(result).to.deep.equal({ requested: 2, cleared: 2, failed: 0 });
        expect(calls).to.have.length(2);
        expect(calls[0].options).to.deep.equal({
            method: 'DELETE',
            headers: { 'x-api-key': 'secret' },
        });
        expect(calls.map(call => call.url)).to.have.members([
            'http://gpu-hub.test/queue/clear?dispatch_id=dispatch-a',
            'http://gpu-hub.test/queue/clear?dispatch_id=dispatch-b',
        ]);
    });

    it('reports HTTP and network failures without aborting remaining cleanup', async () => {
        const warnings = [];
        const responses = new Map([
            ['dispatch-a', { ok: false, status: 503 }],
            ['dispatch-b', new Error('network down')],
            ['dispatch-c', { ok: true, status: 200 }],
        ]);

        const result = await dispatchEngine.clearHubDispatches(
            [...responses.keys()],
            {
                hubUrl: 'http://gpu-hub.test',
                context: 'TEST-CLEANUP',
                warn: message => warnings.push(message),
                fetchImpl: async url => {
                    const dispatchId = new URL(url).searchParams.get('dispatch_id');
                    const response = responses.get(dispatchId);
                    if (response instanceof Error) throw response;
                    return response;
                },
            }
        );

        expect(result).to.deep.equal({ requested: 3, cleared: 1, failed: 2 });
        expect(warnings).to.have.length(2);
        expect(warnings[0]).to.include('TEST-CLEANUP');
        expect(warnings[1]).to.include('network down');
    });
});

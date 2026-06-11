const { expect } = require('chai');
const chatStore = require('../src/services/chat-store');

describe('Chat Store (Phase A.6)', () => {
    const testBookId = 'test-book-chat';
    let chat;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        chat = chatStore;
        await chat.deleteBookHistory(testBookId);
    });

    afterEach(async () => {
        await chat.deleteBookHistory(testBookId);
    });

    it('appends user and assistant messages', async () => {
        const u = await chat.appendUserMessage(testBookId, 'What is the plot?', {
            sceneId: 'sc-1', characterId: 'author', topic: 'plot',
        });
        expect(u.role).to.equal('user');
        expect(u.scene_id).to.equal('sc-1');

        const a = await chat.appendAssistantMessage(testBookId, 'The plot follows...', {
            sceneId: 'sc-1', characterId: 'author', topic: 'plot',
        });
        expect(a.role).to.equal('assistant');
    });

    it('appendExchange returns both messages', async () => {
        const r = await chat.appendExchange(
            testBookId,
            'Who is Woland?',
            'A mysterious visitor.',
            { sceneId: 'sc-1', characterId: 'woland', topic: 'casting' }
        );
        expect(r.user.role).to.equal('user');
        expect(r.assistant.role).to.equal('assistant');
    });

    it('rejects invalid role', async () => {
        let threw = false;
        try {
            await chat.appendUserMessage(testBookId, 'x', { });
            // calling internal with bad role
            const repo = require('../src/storage/postgres/repositories/chat-repo');
            await repo.appendMessage(testBookId, { role: 'alien', message: 'x' });
        } catch (_) { threw = true; }
        expect(threw).to.be.true;
    });

    it('getBookHistory returns messages in chronological order', async () => {
        await chat.appendUserMessage(testBookId, 'first', { topic: 't' });
        await chat.appendAssistantMessage(testBookId, 'second', { topic: 't' });
        const h = await chat.getBookHistory(testBookId);
        expect(h.length).to.equal(2);
        expect(h[0].role).to.equal('user');
        expect(h[1].role).to.equal('assistant');
    });

    it('getSceneHistory filters by scene', async () => {
        await chat.appendUserMessage(testBookId, 'a', { sceneId: 'sc-1' });
        await chat.appendUserMessage(testBookId, 'b', { sceneId: 'sc-2' });
        const s1 = await chat.getSceneHistory(testBookId, 'sc-1');
        expect(s1.length).to.equal(1);
        expect(s1[0].message).to.equal('a');
    });

    it('getCharacterHistory filters by character', async () => {
        await chat.appendUserMessage(testBookId, 'w1', { characterId: 'woland' });
        await chat.appendUserMessage(testBookId, 'b1', { characterId: 'berlioz' });
        const w = await chat.getCharacterHistory(testBookId, 'woland');
        expect(w.length).to.equal(1);
        expect(w[0].message).to.equal('w1');
    });

    it('getTopicDiscussions returns messages for a topic', async () => {
        await chat.appendUserMessage(testBookId, 'q1', { topic: 'casting' });
        await chat.appendAssistantMessage(testBookId, 'a1', { topic: 'casting' });
        await chat.appendUserMessage(testBookId, 'q2', { topic: 'music' });
        const c = await chat.getTopicDiscussions(testBookId, 'casting');
        expect(c.length).to.equal(2);
    });

    it('listTopics returns aggregated topics', async () => {
        await chat.appendUserMessage(testBookId, 'q1', { topic: 'casting' });
        await chat.appendUserMessage(testBookId, 'q2', { topic: 'casting' });
        await chat.appendUserMessage(testBookId, 'q3', { topic: 'music' });
        const t = await chat.listTopics(testBookId);
        const casting = t.find(x => x.topic === 'casting');
        expect(casting.count).to.equal(2);
    });

    it('searchMessages does case-insensitive ILIKE search', async () => {
        await chat.appendUserMessage(testBookId, 'Hello WORLD', {});
        const r = await chat.searchMessages(testBookId, 'world');
        expect(r.length).to.be.gte(1);
    });

    it('assistant message also writes a book event when context is rich', async () => {
        await chat.appendAssistantMessage(testBookId, 'a long answer', {
            sceneId: 'sc-1', characterId: 'woland', topic: 'casting',
        });
        const events = await require('../src/services/book-event-log').getEventsByRef(
            testBookId, 'chat', 'sc-1:woland:casting'
        );
        expect(events.length).to.be.gte(1);
    });

    it('getMessageCount returns total', async () => {
        await chat.appendUserMessage(testBookId, 'a', {});
        await chat.appendAssistantMessage(testBookId, 'b', {});
        const c = await chat.getMessageCount(testBookId);
        expect(c).to.equal(2);
    });
});

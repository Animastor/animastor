const { expect } = require('chai');
const bookEventLog = require('../src/services/book-event-log');

describe('Book Event Log (Phase A.5)', () => {
    const testBookId = 'test-book-events';
    let bookEvents;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        bookEvents = bookEventLog;
        await bookEvents.deleteBookEvents(testBookId);
    });

    afterEach(async () => {
        await bookEvents.deleteBookEvents(testBookId);
    });

    it('appends an event', async () => {
        const e = await bookEvents.append(testBookId, bookEvents.EventType.SCENE_CREATED, {
            chapterId: 'ch-1', sceneId: 'sc-1',
        });
        expect(e).to.have.property('id');
        expect(e.event_type).to.equal('SCENE_CREATED');
        expect(e.book_id).to.equal(testBookId);
    });

    it('appends batch atomically', async () => {
        const events = [
            { eventType: 'AUDIO_COMPLETED', chapterId: 'ch-1', sceneId: 'sc-1' },
            { eventType: 'VIDEO_COMPLETED', chapterId: 'ch-1', sceneId: 'sc-1' },
            { eventType: 'CHAT_DISCUSSION', chapterId: 'ch-1', sceneId: 'sc-1', topic: 'casting' },
        ];
        const r = await bookEvents.appendBatch(testBookId, events);
        expect(r).to.have.length(3);
    });

    it('rejects event with missing book_id or event_type', async () => {
        let threw = false;
        try { await bookEvents.append(null, 'X'); } catch (_) { threw = true; }
        expect(threw).to.be.true;

        threw = false;
        try { await bookEvents.append(testBookId, null); } catch (_) { threw = true; }
        expect(threw).to.be.true;
    });

    it('convenience helpers work and tag refs', async () => {
        await bookEvents.sceneCreated(testBookId, 'ch-1', 'sc-1', { hash: 'abc' });
        await bookEvents.characterUpdated(testBookId, 'char-1', { name: 'Woland' });
        await bookEvents.audioGenerated(testBookId, 'ch-1', 'sc-1', { duration: 3.2 });
        await bookEvents.chatDiscussion(testBookId, 'sc-1', 'char-1', 'casting', { preview: 'hi' });

        const chatEvents = await bookEvents.getEventsByRef(testBookId, 'chat', 'sc-1:char-1:casting');
        expect(chatEvents.length).to.be.gte(1);
        expect(chatEvents[0].event_type).to.equal('CHAT_DISCUSSION');
    });

    it('getBookEvents returns events in chronological order', async () => {
        await bookEvents.sceneCreated(testBookId, 'c1', 's1');
        await bookEvents.sceneUpdated(testBookId, 'c1', 's1');
        await bookEvents.sceneDeleted(testBookId, 'c1', 's1');
        const events = await bookEvents.getBookEvents(testBookId);
        expect(events.length).to.be.gte(3);
        const types = events.slice(-3).map(e => e.event_type);
        expect(types).to.deep.equal(['SCENE_CREATED', 'SCENE_UPDATED', 'SCENE_DELETED']);
    });

    it('getSceneEvents filters by chapter + scene', async () => {
        await bookEvents.sceneCreated(testBookId, 'c1', 's1');
        await bookEvents.sceneCreated(testBookId, 'c1', 's2');
        await bookEvents.sceneCreated(testBookId, 'c2', 's1');
        const s1c1 = await bookEvents.getSceneEvents(testBookId, 'c1', 's1');
        expect(s1c1.length).to.equal(1);
        expect(s1c1[0].scene_id).to.equal('s1');
    });

    it('getBookEvents supports eventType filter', async () => {
        await bookEvents.sceneCreated(testBookId, 'c1', 's1');
        await bookEvents.characterUpdated(testBookId, 'c-x');
        const only = await bookEvents.getBookEvents(testBookId, { eventType: 'CHARACTER_UPDATED' });
        expect(only.every(e => e.event_type === 'CHARACTER_UPDATED')).to.be.true;
    });

    it('purgeOlderThan deletes old events', async () => {
        const now = Math.floor(Date.now() / 1000);
        await bookEvents.append(testBookId, 'TEST_OLD', { details: { _old: true } });
        const removed = await bookEvents.purgeOlderThan(now + 60);
        expect(removed).to.be.gte(0);
    });
});

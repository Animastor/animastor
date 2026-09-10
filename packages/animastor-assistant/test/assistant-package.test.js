// ======================================================
// @animastor/assistant — PACKAGE TESTS (host-run, repo checkout)
// ======================================================
// Package-owned unit tests for the extracted Assistant contour.
// Engine-level only — no host deps (express/PG/Redis) needed.
//
// Coverage:
//   PT1 — public API surface
//   PT2 — port contracts fail closed on bad adapters
//   PT3 — chat engine: patch pipeline + participants normalization +
//         system prompt doctrine

const { expect } = require('chai');
const assistant = require('../src/index.cjs');
const { createChatEngine, createAssistantRoutes, assertAssistantPorts, assertSessionRepo } = assistant;

// ── PT1 — public API ─────────────────────────────────────────────────────
describe('PT1: package public API', () => {
    it('exposes exactly the four public factories', () => {
        expect(Object.keys(assistant).sort()).to.deep.equal([
            'assertAssistantPorts', 'assertSessionRepo', 'createAssistantRoutes', 'createChatEngine',
        ]);
    });

    it('createChatEngine requires the injected bundle validator (no host fallback)', () => {
        expect(() => createChatEngine({}, {})).to.throw(/validateBundleObject is required/);
    });
});

// ── PT2 — port contracts fail closed ─────────────────────────────────────
describe('PT2: port contracts fail closed', () => {
    const repoSurface = {
        listSessionsForBook: async () => [],
        getSession: async () => null,
        getMessages: async () => [],
        createSession: async () => {},
        setMessages: async () => {},
        renameSession: async () => null,
        deleteSession: async () => null,
        getBookIdForSession: async () => null,
        purgeSessionsForBook: async () => {},
    };

    const fullPorts = {
        loadBook: () => null,
        persistBook: () => ({}),
        validateBundle: () => ({ valid: true, errors: [] }),
        validateBundleFile: () => ({ valid: true, errors: [] }),
        resolveChatAI: async () => ({}),
        sessionRepo: { ...repoSurface },
        purgeForBook: async () => {},
        chatTransport: {
            safeFetch: async () => ({}),
            runSharedInference: async () => ({ ok: true }),
            describeSharedError: (code) => `shared error: ${code}`,
            chatAiSourceToken: () => 'cloud',
        },
        log: () => {},
    };

    it('assertSessionRepo accepts the full surface and rejects a partial adapter', () => {
        assertSessionRepo({ ...repoSurface });
        expect(() => assertSessionRepo({ ...repoSurface, deleteSession: undefined }))
            .to.throw(/deleteSession/);
    });

    it('assertAssistantPorts accepts the full seam', () => {
        assertAssistantPorts(fullPorts);
    });

    it('assertAssistantPorts rejects missing chatTransport.chatAiSourceToken', () => {
        expect(() => assertAssistantPorts({
            ...fullPorts,
            chatTransport: {
                safeFetch: async () => ({}),
                runSharedInference: async () => ({}),
                describeSharedError: () => '',
                chatAiSourceToken: undefined,
            },
        })).to.throw(/chatAiSourceToken/);
    });

    it('assertAssistantPorts rejects missing sessionRepo', () => {
        expect(() => assertAssistantPorts({
            ...fullPorts,
            sessionRepo: { getSession: async () => null },
        })).to.throw(/sessionRepo/);
    });
});

// ── PT3 — engine behavior (engine-level) ─────────────────────────────────
describe('PT3: chat engine (package-own logic)', () => {
    const validateBundleObject = (bundle) => {
        const errors = [];
        for (const ch of bundle.chapters || []) {
            for (const sc of ch.scenes || []) {
                const p = sc.participants;
                if (p !== undefined && p !== null && !Array.isArray(p)) {
                    errors.push(`participants at ${sc.scene_id} must be an array`);
                }
            }
        }
        return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
    };
    const engine = createChatEngine({}, { validateBundleObject, aiProfilePath: null });

    it('applyPatchesValidated normalizes {"item": x} participants across ALL scenes', () => {
        const book = {
            characters: [{ id: 'yura', name: 'Юра' }],
            chapters: [{
                chapter_id: 'ch-1', scenes: [
                    { scene_id: 'sc-1', participants: { item: ['yura'] } },
                    { scene_id: 'sc-2', participants: 'Юра' },
                    { scene_id: 'sc-3', participants: ['Юра', 'yura'] },
                ],
            }],
        };
        const res = engine.applyPatchesValidated(book, []);
        expect(res.errors).to.have.lengthOf(0);
        const scenes = res.result.chapters[0].scenes;
        expect(scenes[0].participants).to.deep.equal(['yura']);
        expect(scenes[1].participants).to.deep.equal(['yura']);
        expect(scenes[2].participants).to.deep.equal(['yura']);
    });

    it('applyPatchesValidated withholds result when bundle contract fails after normalization', () => {
        const book = {
            chapters: [{
                chapter_id: 'ch-1', scenes: [
                    { scene_id: 'sc-1', participants: ['yura'] },
                    { scene_id: 'sc-2' },
                ],
            }],
        };
        const res = engine.applyPatchesValidated(book, [
            { op: 'replace', path: '/chapters/0/scenes/0/participants', value: 42 },
        ]);
        expect(res.result).to.be.null;
        expect(res.errors.join(' ')).to.include('participants');
    });

    it('the edit-mode system prompt carries the participants doctrine', () => {
        const prompt = engine.buildChatSystemPrompt({ mode: 'edit', topic: 'book', lang: 'ru', modelName: 'm1' });
        expect(prompt).to.include('participants');
        expect(prompt).to.include('character_id');
    });

    it('getToolsForMode exposes edit_book only in unlocked edit mode', () => {
        expect(engine.getToolsForMode('edit', 'b1', false)).to.have.lengthOf(1);
        expect(engine.getToolsForMode('edit', 'b1', true)).to.have.lengthOf(0);
        expect(engine.getToolsForMode('chat', 'b1', false)).to.have.lengthOf(0);
    });
});

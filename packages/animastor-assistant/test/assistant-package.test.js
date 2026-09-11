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
//   PT4 — prompt building + tool definitions + tool-call parsing
//   PT5 — runtime purity (no fs/env/path/dynamic require) + no host requires
//   PT6 — HTTP contour registers /api/v1/ai/* via injected ports

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
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

    it('createChatEngine accepts an injected persona string and falls back when absent', () => {
        const withProfile = createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
            aiProfile: '# Injected persona',
        });
        expect(withProfile.loadSystemPrompt()).to.equal('# Injected persona');
        const noProfile = createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
        });
        expect(noProfile.loadSystemPrompt()).to.match(/Анимастор/);
    });

    it('createChatEngine takes the fallback base URL from injected config, not env', () => {
        const engine = createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
            aiApiBaseUrl: 'https://injected.example/v1',
        });
        expect(engine.AI_API_BASE_URL).to.equal('https://injected.example/v1');
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
    const engine = createChatEngine({}, { validateBundleObject, aiProfile: null });

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

    it('EDIT_BOOK_TOOL declares the edit_book function contract', () => {
        const tool = engine.toolDefinitions.EDIT_BOOK_TOOL;
        expect(tool.type).to.equal('function');
        expect(tool.function.name).to.equal('edit_book');
        expect(tool.function.parameters.required).to.deep.equal(['patches']);
    });

    it('buildBookContext renders the full book JSON; buildCompactBookContext summarizes', () => {
        const book = { book: { title: 'T' }, chapters: [{ chapter_id: 'c1', scenes: [{ scene_id: 's1' }] }] };
        expect(engine.buildBookContext(book)).to.include('```json');
        const compact = engine.buildCompactBookContext(book);
        expect(compact).to.include('Chapters: 1');
        expect(compact).to.not.include('```json');
        expect(engine.buildBookContext(null)).to.equal('');
        expect(engine.buildCompactBookContext(null)).to.equal('');
    });

    it('parseAIResponse strips think blocks and extracts patch blocks', () => {
        const parsed = engine.parseAIResponse('visible ' + String.fromCharCode(60) + 'think>hidden' + String.fromCharCode(60) + '/think> ```patches\n[{"op":"replace","path":"/book/title","value":"X"}]\n```');
        expect(parsed.reply).to.equal('visible');
        expect(parsed.patches.length).to.be.above(0);
        expect(parsed.patches[0]).to.deep.include({ op: 'replace', path: '/book/title' });
    });

    it('applyPatches applies replace/add/remove ops and reports unresolved paths', () => {
        const book = { book: { title: 'A' }, chapters: [{ scenes: [] }] };
        const ok = engine.applyPatches(book, [{ op: 'replace', path: '/book/title', value: 'B' }]);
        expect(ok.errors).to.have.lengthOf(0);
        expect(ok.result.book.title).to.equal('B');
        const bad = engine.applyPatches(book, [{ op: 'replace', path: '/nope/missing', value: 1 }]);
        expect(bad.errors.join(' ')).to.match(/resolve|not found/i);
    });

    it('resolvePath walks arrays and object keys', () => {
        const book = { chapters: [{ scenes: [{ scene_id: 's1' }] }] };
        const r = engine.resolvePath(book, '/chapters/0/scenes/0/scene_id');
        expect(r.value).to.equal('s1');
    });
});

// ── PT5 — runtime purity (no host/ambient assumptions) ───────────────────
describe('PT5: package runtime is IO-free and host-free', () => {
    const SRC = path.join(__dirname, '..', 'src');
    const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.cjs'));

    it('no source file requires fs/path/os/child_process or reads process.env', () => {
        const offenders = [];
        for (const f of files) {
            const src = fs.readFileSync(path.join(SRC, f), 'utf8');
            if (/require\(\s*['"](node:)?(fs|path|os|child_process)['"]\s*\)/.test(src)) offenders.push(`${f}: host builtin`);
            if (src.includes('process.env')) offenders.push(`${f}: process.env`);
            if (src.includes('__dirname') || src.includes('process.cwd')) offenders.push(`${f}: path assumption`);
        }
        expect(offenders).to.deep.equal([]);
    });

    it('no source file requires the backend host or another @animastor package', () => {
        const offenders = [];
        for (const f of files) {
            const src = fs.readFileSync(path.join(SRC, f), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n').map((l) => l.replace(/\s\/\/.*$/, '')).filter((l) => !/^\s*\/\//.test(l)).join('\n');
            const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                if (/backend|@animastor\//.test(m[1])) offenders.push(`${f}: ${m[1]}`);
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

// ── PT6 — HTTP contour surface via injected ports ────────────────────────
describe('PT6: assistant routes register the /api/v1/ai/* contract', () => {
    const repoSurface = {
        listSessionsForBook: async () => [], getSession: async () => null,
        getMessages: async () => [], createSession: async () => {},
        setMessages: async () => {}, renameSession: async () => null,
        deleteSession: async () => null, getBookIdForSession: async () => null,
        purgeSessionsForBook: async () => {},
    };

    it('registers sessions CRUD, chat and stream routes on an express-like app', () => {
        const routes = [];
        const app = {
            get: (p) => routes.push(`GET ${p}`),
            post: (p) => routes.push(`POST ${p}`),
            patch: (p) => routes.push(`PATCH ${p}`),
            delete: (p) => routes.push(`DELETE ${p}`),
        };
        const chatEngine = createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
            aiProfile: null,
        });
        createAssistantRoutes(app, null, {
            chatEngine,
            assistantPorts: {
                loadBook: () => null, persistBook: () => ({}),
                validateBundle: () => ({ valid: true, errors: [] }),
                validateBundleFile: () => ({ valid: true, errors: [] }),
                resolveChatAI: async () => ({}),
                sessionRepo: repoSurface, purgeForBook: async () => {},
                chatTransport: {
                    safeFetch: async () => ({}), runSharedInference: async () => ({ ok: true }),
                    describeSharedError: (c) => String(c), chatAiSourceToken: () => 'cloud',
                },
                log: () => {},
            },
            utils: { log: () => {} },
        });
        expect(routes).to.include('GET /api/v1/ai/sessions');
        expect(routes).to.include('POST /api/v1/ai/sessions');
        expect(routes).to.include('PATCH /api/v1/ai/sessions/:id');
        expect(routes).to.include('DELETE /api/v1/ai/sessions/:id');
        expect(routes).to.include('GET /api/v1/ai/sessions/:id/messages');
        expect(routes).to.include('POST /api/v1/ai/chat');
        expect(routes).to.include('POST /api/v1/ai/chat/stream');
    });
});

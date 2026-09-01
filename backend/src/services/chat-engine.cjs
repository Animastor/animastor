// ======================================================
// ANIMASTOR BACKEND — CHAT ENGINE
// ======================================================
// AI chat engine — system prompts, book context building,
// mode-specific tool definitions, AI response parsing,
// and JSON patch application.

const fs = require('fs');
const path = require('path');
const { validateBundleObject } = require('../book/bundle-validator.cjs');

module.exports = function(config) {
    // AI assistant profile lives in the AI tree (backend/ai), alongside rules,
    // skills, profiles, workflows and connectors. Env override for exotic setups.
    const AI_PROFILE_PATH = process.env.AI_PROFILE_PATH || path.join(__dirname, '../../ai/ai-assistant-profile.md');
    const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://integrate.api.nvidia.com/v1';

    // ── Mode-specific system prompts ──────────────────
    const MODE_PROMPTS = {
        conversation: 'You are a creative assistant in Conversational mode. Answer questions, discuss ideas, explain concepts, and brainstorm. Do NOT make any changes to the book — this is a read-only discussion.',
        import: 'You are an Import specialist. Convert arbitrary text into Animastor book structure. Analyze the text and automatically determine chapters, scenes, and units. If a book is already open, decide whether the text is a new chapter, continuation of current chapter, or extension of current scene. If no book is open, create a new book with manifest, metadata, chapters, scenes, and units. The user must NOT manually mark chapters/scenes/units — determine the structure from content. Always produce a valid Animastor book JSON.',
        edit: [
            'You are an Editor. You can modify scenes, characters, locations, behavior, and book structure.',
            'Use the `edit_book` tool to apply changes. Always confirm changes with the user before applying.',
            '',
            '## Scene Participants',
            '`scene.participants` is ALWAYS a JSON array of character_id strings taken from `characters.json` — never display names, never a bare string, never an object like {"item": ...}.',
            'Example: `["yura", "svetlana"]` — NOT `["Юра", "yura"]` and NOT `{"item": ["yura", "svetlana"]}`.',
            'When the user asks to fix participants across the whole book, apply the change to EVERY scene in EVERY chapter — do not stop after one scene. List one patch per affected scene.',
            '',
            '## Character Behavior',
            'Each character can have a Behavior entry in the book data under `behaviors` (keyed by character_id).',
            'Behavior describes HOW a character acts — their mannerisms, habits, and reactions.',
            '',
            'Behavior schema:',
            '```json',
            '{',
            '  "<character_id>": {',
            '    "baseline": "How the character normally behaves — characteristic manner of movement, expressions, gestures, posture, speech patterns.",',
            '    "quirks": ["Repeated characteristic habit or mannerism."],',
            '    "reactions": [',
            '      {',
            '        "trigger": "A situation or emotional state.",',
            '        "reaction": "The observable behavioral response."',
            '      }',
            '    ]',
            '  }',
            '}',
            '```',
            '',
            'Field meanings:',
            '- **baseline**: how the character behaves NORMALLY — characteristic manner of movement, expressions, gestures, posture, speech rhythm.',
            '- **quirks**: recurring habits or mannerisms specific to this character (one string per entry).',
            '- **reactions**: trigger→reaction patterns. `trigger` = situation or state; `reaction` = observable behavioral response.',
            '',
            'When the user asks to create or modify character behavior:',
            '1. Find the character by character_id from `characters` in the book data.',
            '2. Study the character passport (appearance, clothes, description) to understand their personality.',
            '3. Create behavior that matches the character personality — distinct, specific, believable.',
            '4. Use `edit_book` to write to `/behaviors/{character_id}` with the full behavior object.',
            '5. Do NOT create a new character. Do NOT modify passport or voice unless asked.',
            '',
            'Example user request: "Придумай поведение для Юры и Светланы."',
            'Agent action: find characters Yuri and Svetlana, analyze passports, write individualized baseline/quirks/reactions via edit_book.',
        ].join('\n'),
        director: 'You are a Film Director. Advise on camera angles, composition, lighting, mood, and atmosphere for scenes. You can write into storyboard_elements for the current scene. Think visually and cinematically.',
        extraction: 'You are an Extraction specialist. Extract structured entities from the text such as characters, objects, locations, and key terms.',
        validation: 'You are a Validation specialist. Check book JSON for correctness, completeness, and integrity. Verify required fields, cross-references, scene links, and data consistency. Return a list of violations with severity levels.',
    };

    // ── Topic-specific system prompts ─────────────────
    const TOPIC_PROMPTS = {
        book: 'You are a creative assistant helping with a visual book project. Answer questions about the book, its plot, characters, and structure.',
        scene: 'You are a scene editor assistant. Help refine the current scene: visuals, audio, pacing, and dialogue. Use the current position context (chapter/scene/unit) when relevant.',
        characters: 'You are a character development assistant. Help design, refine, and track characters for the visual book.',
        script: 'You are a scriptwriting assistant. Help with plot structure, narrative flow, scene transitions, and story arc.',
    };

    /**
     * Build a system prompt from structured fields (mode, topic, language, position).
     * Replaces the client-side system prompt assembly in AiAssistantFragment.
     */
    function buildChatSystemPrompt({ mode, topic, lang, bookData, chapterId, sceneId, unitIndex, modelName }) {
        const appName = 'Animastor';
        const modeKey = mode || 'conversation';
        const topicKey = topic || 'book';
        const modePrompt = MODE_PROMPTS[modeKey] || MODE_PROMPTS.conversation;
        const topicPrompt = TOPIC_PROMPTS[topicKey] || TOPIC_PROMPTS.book;

        // Resolve position context from book data
        let positionContext = '';
        if (bookData) {
            try {
                const chapters = bookData.chapters || [];
                // If chapterId is not provided, find the chapter that contains sceneId
                // Modern lazy-book chapters carry `chapter_id`; legacy parse.js
                // chapters carry `chapter`. Normalize so position context resolves
                // for both formats.
                const chIdOf = c => c.chapter_id ?? c.chapter;
                const resolvedChapterId = chapterId || (sceneId
                    ? chIdOf(chapters.find(c => c.scenes?.some(s => s.scene_id === sceneId)))
                    : null);
                if (!resolvedChapterId) { positionContext = ''; }
                else {
                const ch = chapters.find(c => chIdOf(c) === resolvedChapterId);
                const isSpecial = ch?.type === 'cover' || ch?.type === 'prologue';
                const chTitle = ch?.chapter_title || '';
                let chName = chapterId;
                if (isSpecial) {
                    chName = chTitle || ch?.type || chapterId;
                } else if (chTitle) {
                    chName = chTitle;
                } else if (ch?.display_number != null) {
                    chName = `Chapter ${ch.display_number}`;
                }

                let scName = '';
                let unitDesc = '';
                if (sceneId) {
                    const scenes = ch?.scenes || [];
                    const sc = scenes.find(s => s.scene_id === sceneId);
                    const scIdx = scenes.indexOf(sc) + 1;
                    if (scIdx > 0) {
                        const titleSuffix = sc?.scene_title ? ` — ${sc.scene_title}` : '';
                        scName = `Scene ${scIdx}${titleSuffix}`;
                    }
                    if (unitIndex != null && unitIndex >= 0) {
                        const units = sc?.units || [];
                        const unit = units[unitIndex];
                        if (unit) {
                            const typeLabel = unit.type ? unit.type.charAt(0).toUpperCase() + unit.type.slice(1) : 'Unit';
                            const textSnippet = unit.text ? unit.text.slice(0, 60).replace(/[\n\r]/g, ' ') : '';
                            unitDesc = textSnippet ? `${typeLabel} — "${textSnippet}"` : `${typeLabel} ${unitIndex + 1}`;
                        } else {
                            unitDesc = `Unit ${unitIndex + 1}`;
                        }
                    }
                }

                const parts = [`Current position: ${chName}`];
                if (scName) parts.push(scName);
                if (unitDesc) parts.push(unitDesc);
                positionContext = parts.join(' / ');
                }
            } catch (_) {
                // Silent fallback — position context is optional
            }
        }

        // Language instruction
        let langInstruction = '';
        switch (lang) {
            case 'ru':
                langInstruction = '\n\nIMPORTANT: Always reply in Russian. Use Russian for all responses regardless of the user\'s language.';
                break;
            case 'en':
                langInstruction = '';
                break;
            case 'auto':
            default:
                langInstruction = '\n\nIMPORTANT: Always reply in the user\'s language. If they write in Russian, reply in Russian. If they write in English, reply in English.';
                break;
        }

        const parts = [
            '## Identity',
            `You are **${appName}** — an intelligent assistant for creating visual books on the Animastor platform.`,
            `Always introduce yourself as ${appName}. When greeting users, say you are ${appName}, their visual book assistant — NOT any other AI assistant or service.`,
            `Your AI model identifier is: ${modelName || 'AI model'}. If asked about your model, architecture, or origin, respond ONLY with this exact identifier. Never use any other model name.`,
            '',
            '## Mission',
            'Help users create, edit, and publish multimedia visual books. Assist with plot development, character design, scene structuring, and all aspects of the Animastor platform.',
            '',
            `Mode: ${modeKey.charAt(0).toUpperCase() + modeKey.slice(1)}`,
            modePrompt,
            '',
            `Topic: ${topicKey.charAt(0).toUpperCase() + topicKey.slice(1)}`,
            topicPrompt,
        ];
        if (positionContext) {
            parts.push('');
            parts.push(`Current context: ${positionContext}`);
        }
        if (langInstruction) {
            parts.push('');
            parts.push(langInstruction.trim());
        }

        return parts.join('\n');
    }

    // ── System prompt (fallback for legacy clients) ────
    function loadSystemPrompt() {
        try {
            if (fs.existsSync(AI_PROFILE_PATH)) {
                return fs.readFileSync(AI_PROFILE_PATH, 'utf-8').trim();
            }
        } catch (_) { /* ignore */ }
        return `# AI Assistant Profile: Анимастор

## Identity
Ты — **Анимастор**, умный помощник для создания интерактивных историй и книг на платформе Animastor.

## Mission
Ты помогаешь пользователям создавать, редактировать и публиковать мультимедийные книги.

## Capabilities
- Помогаешь придумывать сюжеты, персонажей, диалоги и сценарии
- Разбиваешь текст на сцены, главы, описываешь визуальные и аудио-элементы
- Объясняешь формат .vbook и процесс генерации
- Отвечаешь на вопросы по платформе
- Предлагаешь креативные идеи

## Rules
- Всегда представляешься как Анимастор
- Не выдаёшь себя за человека
- Отвечаешь на том же языке, на котором к тебе обратились
- Если вопрос вне твоей компетенции — честно говоришь об этом`;
    }

    // ── Book context builder ──────────────────────────
    function buildBookContext(bookData) {
        if (!bookData) return '';
        const isLocked = bookData.manifest?.locked === true;
        const lines = [];
        lines.push(`Locked: ${isLocked}`);
        lines.push('');
        lines.push('Below is the full book JSON data. Read it, modify it as needed, and return the full changed version in your response.');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(bookData, null, 2));
        lines.push('```');
        return lines.join('\n');
    }

    // ── Tool definitions ──────────────────────────────
    const EDIT_BOOK_TOOL = {
        type: 'function',
        function: {
            name: 'edit_book',
            description: 'Apply changes to the current book. Call this when the user asks to edit the book content (title, author, characters, scenes, text, behavior, etc.). Supports writing to /behaviors/{character_id} for character behavior. Do NOT call if the book is locked.',
            parameters: {
                type: 'object',
                properties: {
                    patches: {
                        type: 'array',
                        description: 'List of JSON Patch operations',
                        items: {
                            type: 'object',
                            properties: {
                                op: { type: 'string', enum: ['replace', 'add', 'remove'], description: 'Operation type' },
                                path: { type: 'string', description: 'JSON path like /book/title, /chapters/0/scenes/1/units/0/text, /behaviors/character_id/baseline' },
                                value: { description: 'New value (for replace/add)' },
                            },
                            required: ['op', 'path'],
                        },
                    },
                },
                required: ['patches'],
            },
        },
    };

    // ── Mode-specific tool selection ──────────────────
    // Only 'edit' carries a tool (EDIT_BOOK_TOOL — the one with a real
    // backend handler). Every other mode is text-only: the remaining tool
    // definitions (storyboard / import_book / extract_entities /
    // validate_book) never had handlers (ai-routes.cjs replies
    // 'Tool executed (no handler)'), so exposing them only taught models to
    // burn tokens on calls that did nothing.
    function getToolsForMode(mode, bookId, isLocked) {
        if (mode === 'edit' && !isLocked) return [EDIT_BOOK_TOOL];
        return [];
    }

    // ── AI response parsing ───────────────────────────
    function parseAIResponse(text) {
        if (!text) return { reply: '', patches: [] };

        // Strip AI chain-of-thought reasoning blocks — not meant for the UI
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        const patches = [];
        const regex = /```patches\n([\s\S]*?)```/g;
        let match;
        let cleanText = text;

        while ((match = regex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (Array.isArray(parsed)) {
                    patches.push(...parsed);
                } else {
                    patches.push(parsed);
                }
            } catch (e) {
                console.warn('[AI] Failed to parse patches block:', e.message);
            }
            cleanText = cleanText.replace(match[0], '').trim();
        }

        // Also look for inline JSON patches (single { ... } with op/path)
        const inlineRegex = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
        let inlineMatch;
        while ((inlineMatch = inlineRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(inlineMatch[0]);
                if (parsed.op && parsed.path) {
                    patches.push(parsed);
                }
            } catch (e) { /* not a valid patch object */ }
        }

        return { reply: cleanText.trim(), patches };
    }

    // ── JSON path resolver ────────────────────────────
    function resolvePath(obj, pathStr) {
        const parts = pathStr.split('/').filter(Boolean);
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (current[key] === undefined || current[key] === null) {
                try {
                    const num = parseInt(key, 10);
                    if (!isNaN(num) && Array.isArray(current)) {
                        current = current[num];
                    } else {
                        current = current[key];
                    }
                } catch {
                    return { parent: null, key: null, value: undefined };
                }
            } else {
                current = current[key];
            }
        }
        const lastKey = parts[parts.length - 1];
        return { parent: current, key: lastKey, value: current ? current[lastKey] : undefined };
    }

    // ── JSON Patch application ────────────────────────
    function applyPatches(obj, patches) {
        const result = JSON.parse(JSON.stringify(obj));
        const errors = [];

        for (const patch of patches) {
            const { op, path: pathStr, value } = patch;
            const { parent, key, value: oldValue } = resolvePath(result, pathStr);

            if (!parent && op !== 'add') {
                errors.push(`Cannot resolve path: ${pathStr}`);
                continue;
            }

            try {
                switch (op) {
                    case 'replace':
                        if (key !== null && key in parent) {
                            parent[key] = value;
                        } else {
                            errors.push(`Path not found for replace: ${pathStr}`);
                        }
                        break;

                    case 'add':
                        if (key === '-') {
                            if (Array.isArray(parent)) {
                                parent.push(value);
                            } else {
                                errors.push(`Cannot append to non-array: ${pathStr}`);
                            }
                        } else if (key && key.match(/^\d+$/)) {
                            const idx = parseInt(key, 10);
                            if (Array.isArray(parent)) {
                                parent.splice(idx, 0, value);
                            } else {
                                errors.push(`Cannot insert at index in non-array: ${pathStr}`);
                            }
                        } else if (parent && key) {
                            parent[key] = value;
                        } else {
                            errors.push(`Invalid add path: ${pathStr}`);
                        }
                        break;

                    case 'remove':
                        if (key && key.match(/^\d+$/)) {
                            const idx = parseInt(key, 10);
                            if (Array.isArray(parent)) {
                                parent.splice(idx, 1);
                            } else {
                                errors.push(`Cannot remove index from non-array: ${pathStr}`);
                            }
                        } else if (parent && key && key in parent) {
                            delete parent[key];
                        } else {
                            errors.push(`Path not found for remove: ${pathStr}`);
                        }
                        break;

                    default:
                        errors.push(`Unknown operation: ${op}`);
                }
            } catch (e) {
                errors.push(`Error applying ${op} at ${pathStr}: ${e.message}`);
            }
        }

        return { result, errors };
    }

    // ── Deterministic scene-participants guard ─────────
    // Models frequently produce `scene.participants` in the wrong shape when
    // editing (e.g. {"item": [...]} — a JSON-Schema `items` hallucination, or
    // display names ["Юра","yura"] instead of IDs). Left alone, those values
    // would either corrupt the canonical state ({"item": ...} passed the old
    // contract check) or leave the user's "IDs only" request half-done.
    // This normalizer runs over EVERY scene after patches are applied, so a
    // partial or malformed model patch can never leave the field broken:
    //   - {"item": x}            → unwrapped to x
    //   - bare string            → wrapped into an array
    //   - display name (Юра)     → mapped to its character_id (yura)
    //   - duplicates             → removed, order preserved
    function normalizeBookParticipants(book) {
        if (!book || !Array.isArray(book.chapters)) return book;
        const lookup = new Map();
        if (Array.isArray(book.characters)) {
            for (const ch of book.characters) {
                if (!ch || typeof ch !== 'object') continue;
                const id = ch.id;
                if (typeof id === 'string' && id) {
                    lookup.set(id.toLowerCase(), id);
                    if (typeof ch.name === 'string' && ch.name) {
                        lookup.set(ch.name.toLowerCase(), id);
                    }
                }
            }
        }
        const normalizeOne = (value) => {
            if (value === null || value === undefined) return value;
            let arr;
            if (typeof value === 'object' && !Array.isArray(value) && value.item !== undefined) {
                arr = value.item;
            } else {
                arr = value;
            }
            if (typeof arr === 'string') arr = [arr];
            if (!Array.isArray(arr)) return value; // unfixable — left for the validator to reject
            const out = [];
            for (const item of arr) {
                if (typeof item !== 'string') continue;
                const s = item.trim();
                if (!s) continue;
                const resolved = lookup.get(s.toLowerCase()) || s;
                if (!out.includes(resolved)) out.push(resolved);
            }
            return out;
        };
        for (const chapter of book.chapters) {
            if (!chapter || typeof chapter !== 'object' || !Array.isArray(chapter.scenes)) continue;
            for (const scene of chapter.scenes) {
                if (scene && typeof scene === 'object' && 'participants' in scene) {
                    scene.participants = normalizeOne(scene.participants);
                }
            }
        }
        return book;
    }

    // ── Patch application with bundle-contract validation ──
    // Pipeline: AI patch → apply ops → normalize participants → validate
    // contract → only a valid result is returned as candidate canonical
    // state. On violation the result is withheld (null) so no caller can
    // persist broken JSON; errors name the failing file/resource so the
    // assistant (or the user) can issue a corrective patch in the next turn.
    function applyPatchesValidated(obj, patches) {
        const { result, errors } = applyPatches(obj, patches);
        if (errors.length > 0) {
            return { result: null, errors, validation_errors: [] };
        }
        // Deterministic guard: unwrap {"item": x}, map names → character_id,
        // dedupe — across ALL scenes, not just the ones the model patched.
        normalizeBookParticipants(result);
        const validation = validateBundleObject(result);
        if (!validation.valid) {
            return {
                result: null,
                errors: [`Bundle validation failed: ${validation.errors.join('; ')}`],
                validation_errors: validation.errors,
            };
        }
        return { result, errors, validation_errors: [] };
    }

    // `applyPatches` is kept exported for tests/legacy callers; AI mutation
    // routes use `applyPatchesValidated` (see ai-routes.cjs).
    return {
        AI_PROFILE_PATH,
        AI_API_BASE_URL,
        loadSystemPrompt,
        buildChatSystemPrompt,
        buildBookContext,
        getToolsForMode,
        parseAIResponse,
        resolvePath,
        applyPatches,
        applyPatchesValidated,
        normalizeBookParticipants,
        validateBundleObject,
        toolDefinitions: {
            EDIT_BOOK_TOOL,
        },
    };
};

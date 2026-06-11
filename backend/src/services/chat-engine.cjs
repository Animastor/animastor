// ======================================================
// ANIMASTOR BACKEND — CHAT ENGINE
// ======================================================
// AI chat engine — system prompts, book context building,
// mode-specific tool definitions, AI response parsing,
// and JSON patch application.
//
// Usage:
//   const chatEngine = require('./services/chat-engine.cjs')(config);

const fs = require('fs');

module.exports = function(config) {
    const AI_PROFILE_PATH = process.env.AI_PROFILE_PATH || '/data/ai-assistant-profile.md';
    const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://integrate.api.nvidia.com/v1';

    // ── System prompt ─────────────────────────────────
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
            description: 'Apply changes to the current book. Call this when the user asks to edit the book content (title, author, characters, scenes, text, etc.). Do NOT call if the book is locked.',
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
                                path: { type: 'string', description: 'JSON path like /book/title, /chapters/0/scenes/1/units/0/text' },
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

    const STORYBOARD_TOOL = {
        type: 'function',
        function: {
            name: 'write_storyboard',
            description: 'Write storyboard elements for a scene. Use this in Director mode to set camera angles, composition, lighting, and transitions for each unit.',
            parameters: {
                type: 'object',
                properties: {
                    scene_id: { type: 'string', description: 'The scene id to update' },
                    elements: {
                        type: 'array',
                        description: 'List of storyboard elements, one per unit',
                        items: {
                            type: 'object',
                            properties: {
                                unit_id: { type: 'string', description: 'Unit id within the scene' },
                                camera_angle: { type: 'string', enum: ['wide', 'medium', 'closeup', 'birds_eye', 'low_angle', 'dutch'], description: 'Camera angle for this unit' },
                                composition: { type: 'string', description: 'Visual composition description' },
                                lighting: { type: 'string', description: 'Lighting description for this unit' },
                                background: { type: 'string', description: 'Background / environment description' },
                                transition: { type: 'string', enum: ['cut', 'fade', 'dissolve', 'wipe'], description: 'Transition from previous unit' },
                            },
                            required: ['unit_id', 'camera_angle'],
                        },
                    },
                },
                required: ['scene_id', 'elements'],
            },
        },
    };

    const IMPORT_BOOK_TOOL = {
        type: 'function',
        function: {
            name: 'import_book',
            description: 'Import arbitrary text into the book structure. Creates or extends the book with auto-detected chapters, scenes, and units.',
            parameters: {
                type: 'object',
                properties: {
                    book: {
                        type: 'object',
                        description: 'Complete book JSON with manifest, metadata, chapters, characters, and locations',
                        properties: {
                            manifest: { type: 'object', description: 'Book manifest with version and timestamps' },
                            metadata: { type: 'object', description: 'Book metadata: title, author, description, language' },
                            chapters: { type: 'array', description: 'Array of chapters', items: { type: 'object' } },
                            characters: { type: 'array', items: { type: 'object' } },
                            locations: { type: 'array', items: { type: 'object' } },
                        },
                    },
                },
                required: ['book'],
            },
        },
    };

    const EXTRACT_ENTITIES_TOOL = {
        type: 'function',
        function: {
            name: 'extract_entities',
            description: 'Analyze text and extract characters, locations, objects, relationships, and plot facts.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to analyze' },
                    existing_characters: { type: 'array', items: { type: 'string' }, description: 'Known character names' },
                    existing_locations: { type: 'array', items: { type: 'string' }, description: 'Known location names' },
                },
                required: ['text'],
            },
        },
    };

    const VALIDATE_BOOK_TOOL = {
        type: 'function',
        function: {
            name: 'validate_book',
            description: 'Validate book integrity — check for missing fields, inconsistent references, and structural issues.',
            parameters: { type: 'object', properties: {} },
        },
    };

    // ── Mode-specific tool selection ──────────────────
    function getToolsForMode(mode, bookId, isLocked) {
        switch (mode) {
            case 'edit':
                return isLocked ? [] : [EDIT_BOOK_TOOL];
            case 'director':
                return [STORYBOARD_TOOL];
            case 'import':
                return [IMPORT_BOOK_TOOL];
            case 'analyze':
                return [EXTRACT_ENTITIES_TOOL];
            case 'validate':
                return [VALIDATE_BOOK_TOOL];
            case 'chat':
            default:
                return [EDIT_BOOK_TOOL, STORYBOARD_TOOL, EXTRACT_ENTITIES_TOOL, VALIDATE_BOOK_TOOL];
        }
    }

    // ── AI response parsing ───────────────────────────
    function parseAIResponse(text) {
        if (!text) return { reply: '', patches: [] };

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

    return {
        AI_PROFILE_PATH,
        AI_API_BASE_URL,
        loadSystemPrompt,
        buildBookContext,
        getToolsForMode,
        parseAIResponse,
        resolvePath,
        applyPatches,
        toolDefinitions: {
            EDIT_BOOK_TOOL,
            STORYBOARD_TOOL,
            IMPORT_BOOK_TOOL,
            EXTRACT_ENTITIES_TOOL,
            VALIDATE_BOOK_TOOL,
        },
    };
};

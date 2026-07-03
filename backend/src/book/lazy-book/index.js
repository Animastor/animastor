const fs = require('fs');
const path = require('path');

const config = require('../../config/runtime-config');
const {
    BookState, SceneStatus, SourceType, UnitType, DEFAULT_WINDOW_SIZE,
} = require('./constants');
const {
    getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getBiblePath, getChapterDir, getChapterPath,
    generateId, chapterId, sceneId, unitId, generateBookId,
} = require('./paths');
const {
    splitIntoChapters, splitIntoScenes, splitIntoUnits,
    firstMeaningfulChapter, detectLanguage,
    injectChapterMarkers,
} = require('./parser');

function createDraftBook(sourceText, sourceType, title) {
    const bookId = generateBookId(title || 'untitled');
    const bookDir = getBookDir(bookId);
    fs.mkdirSync(bookDir, { recursive: true });

    const manifest = {
        vbook_version: '3.1',
        book_id: bookId,
        source: sourceType,
        state: BookState.RAW_IMPORTED,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        import_meta: {
            source_type: sourceType,
            original_size: Buffer.byteLength(sourceText, 'utf8'),
            import_timestamp: new Date().toISOString(),
        },
    };

    const bookMeta = {
        book_id: bookId,
        version: '3.0',
        title: title || 'Imported Book',
        author: null,
        language: null,
        structure: {
            has_prologue: false,
            chapters_order: [],
        },
        defaults: {
            narration_voice: 'narrator',
            language: 'ru',
            scene: { auto_anchors: true, spatial_lock: true },
            iu: { character_binding: true },
        },
        transitions: {
            chapter_intro_style: 'soviet_book_page',
            default_transition: 'cut',
            soft_transition: 'fade',
        },
    };

    fs.writeFileSync(getManifestPath(bookDir), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));
    fs.writeFileSync(getSourcePath(bookDir), sourceText, 'utf8');

    console.log(`[LAZY-BOOK] RAW_IMPORTED: ${bookId} (${sourceType}, ${manifest.import_meta.original_size} bytes)`);
    return { bookId, manifest, book: bookMeta };
}

function loadDraftBook(bookId) {
    const bookDir = getBookDir(bookId);
    if (!fs.existsSync(bookDir)) return null;

    try {
        const mp = getManifestPath(bookDir);
        const bp = getBookMetaPath(bookDir);
        if (!fs.existsSync(mp) || !fs.existsSync(bp)) return null;

        const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const bookMeta = JSON.parse(fs.readFileSync(bp, 'utf8'));
        const sourceText = fs.existsSync(getSourcePath(bookDir))
            ? fs.readFileSync(getSourcePath(bookDir), 'utf8') : null;

        let characters = [];
        const charPath = getCharactersPath(bookDir);
        if (fs.existsSync(charPath)) characters = JSON.parse(fs.readFileSync(charPath, 'utf8'));

        let bible = {};
        const bibPath = getBiblePath(bookDir);
        if (fs.existsSync(bibPath)) bible = JSON.parse(fs.readFileSync(bibPath, 'utf8'));

        const chapters = [];
        const chDir = getChapterDir(bookDir);
        if (fs.existsSync(chDir)) {
            const chFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
            for (const cf of chFiles) {
                try { chapters.push(JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'))); }
                catch (e) { console.warn(`[LAZY-BOOK] Skipping bad chapter ${cf}: ${e.message}`); }
            }
        }

        return { manifest, book: bookMeta, sourceText, characters, bible, chapters };
    } catch (err) {
        console.error(`[LAZY-BOOK] Failed to load ${bookId}:`, err.message);
        return null;
    }
}

function updateBookState(bookId, newState) {
    const mp = getManifestPath(getBookDir(bookId));
    if (!fs.existsSync(mp)) throw new Error(`Book ${bookId} not found`);
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.state = newState;
    m.updated_at = new Date().toISOString();
    fs.writeFileSync(mp, JSON.stringify(m, null, 2));
    console.log(`[LAZY-BOOK] ${bookId}: ${newState}`);
    return m;
}

function lazyParseNextWindow(bookId, windowSize) {
    const draft = loadDraftBook(bookId);
    if (!draft) throw new Error(`Book ${bookId} not found`);
    if (!draft.sourceText) throw new Error(`Book ${bookId} has no source text`);

    const ws = windowSize || DEFAULT_WINDOW_SIZE;
    const chapters = splitIntoChapters(draft.sourceText);

    const parsedIndices = new Set();
    for (const ch of draft.chapters) {
        if (ch.chapter_index !== undefined) parsedIndices.add(ch.chapter_index);
    }

    let nextIdx = -1;
    for (let i = 0; i < chapters.length; i++) {
        if (!parsedIndices.has(i)) { nextIdx = i; break; }
    }

    if (nextIdx === -1) {
        updateBookState(bookId, BookState.ACTIVE);
        return { parsed: 0, complete: true, chapters: [] };
    }

    const endIdx = Math.min(nextIdx + ws, chapters.length);
    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    const parsedChapters = [];

    for (let ci = nextIdx; ci < endIdx; ci++) {
        const chInfo = chapters[ci];
        const chId = chapterId();
        const fullChapterText = draft.sourceText.substring(
            chInfo.startOffset || 0,
            chInfo.endOffset || draft.sourceText.length
        );
        const chLines = fullChapterText.split('\n');
        const chFirst = chLines[0]?.trim() || '';
        const chapterText = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
            ? chLines.slice(1).join('\n').trim() : fullChapterText.trim();
        const sceneTexts = splitIntoScenes(chapterText);

        const chObj = {
            chapter: chId,
            chapter_title: chInfo.title,
            type: /пролог|prologue/i.test(chInfo.title) ? 'prologue'
                : /эпилог|epilogue/i.test(chInfo.title) ? 'epilogue' : 'chapter',
            chapter_index: ci,
            status: SceneStatus.PARSED,
            scenes: [],
        };

        for (let si = 0; si < sceneTexts.length; si++) {
            const sceneText = sceneTexts[si];
            const units = splitIntoUnits(sceneText);
            const participants = [];
            for (const u of units) {
                for (const p of (u.participants || [])) {
                    if (!participants.includes(p)) participants.push(p);
                }
            }

            const sceneStyle = units.some(u => u.type === UnitType.TYPOGRAPHY) ? 'soviet_book_page' : undefined;
            chObj.scenes.push({
                scene_id: sceneId(),
                scene_title: si === 0 ? chInfo.title : `Scene ${si + 1}`,
                type: units.some(u => u.type === UnitType.DIALOGUE) && units.filter(u => u.type === UnitType.DIALOGUE).length > units.length / 3
                    ? 'dialogue' : 'narration',
                style: sceneStyle,
                participants,
                audio: { voice: 'narrator', full_text: sceneText },
                units: units.map(u => ({
                    id: unitId(),
                    type: u.type,
                    text: u.text,
                    participants: u.participants,
                })),
            });
        }

        const chFile = `${chId}.json`;
        fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chObj, null, 2));
        parsedChapters.push(chObj);
    }

    const bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    const complete = endIdx >= chapters.length;
    updateBookState(bookId, complete ? BookState.ACTIVE : BookState.BOOTSTRAPPED);

    return {
        parsed: parsedChapters.length,
        windowStart: nextIdx,
        windowEnd: endIdx - 1,
        complete,
        chapters: parsedChapters.map(ch => ({
            chapter: ch.chapter,
            chapter_title: ch.chapter_title,
            chapter_index: ch.chapter_index,
            status: ch.status,
            scene_count: ch.scenes.length,
        })),
    };
}

function lazyParseChapter(bookId, chapterIndex) {
    const draft = loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    const chapters = splitIntoChapters(draft.sourceText);
    if (chapterIndex < 0 || chapterIndex >= chapters.length) throw new Error(`Chapter ${chapterIndex} out of range (0-${chapters.length - 1})`);

    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    for (const cf of fs.readdirSync(chDir).filter(f => f.endsWith('.json'))) {
        try {
            const ch = JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'));
            if (ch.chapter_index === chapterIndex) return { chapter: ch, wasExisting: true };
        } catch (e) { /* skip */ }
    }

    const chInfo = chapters[chapterIndex];
    const chId = chapterId();
    const fullChText = draft.sourceText.substring(
        chInfo.startOffset || 0, chInfo.endOffset || draft.sourceText.length
    );
    const chLines = fullChText.split('\n');
    const chFirst = chLines[0]?.trim() || '';
    const chapterText = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
        ? chLines.slice(1).join('\n').trim() : fullChText.trim();
    const sceneTexts = splitIntoScenes(chapterText);

    const chObj = {
        chapter: chId,
        chapter_title: chInfo.title,
        type: /пролог|prologue/i.test(chInfo.title) ? 'prologue' : 'chapter',
        chapter_index: chapterIndex,
        status: SceneStatus.PARSED,
        scenes: [],
    };

    for (const sceneText of sceneTexts) {
        const units = splitIntoUnits(sceneText);
        const participants = [];
        for (const u of units) {
            for (const p of (u.participants || [])) {
                if (!participants.includes(p)) participants.push(p);
            }
        }

        const sceneStyle = units.some(u => u.type === UnitType.TYPOGRAPHY) ? 'soviet_book_page' : undefined;
        chObj.scenes.push({
            scene_id: sceneId(),
            scene_title: `${chObj.scenes.length + 1}`,
            type: units.some(u => u.type === UnitType.DIALOGUE) && units.filter(u => u.type === UnitType.DIALOGUE).length > units.length / 3
                ? 'dialogue' : 'narration',
            style: sceneStyle,
            participants,
            audio: { voice: 'narrator', full_text: sceneText },
            units: units.map(u => ({
                id: unitId(),
                type: u.type,
                text: u.text,
                participants: u.participants,
            })),
        });
    }

    const chFile = `${chId}.json`;
    fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chObj, null, 2));

    const bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    return { chapter: chObj, wasExisting: false };
}

function getBookStatus(bookId) {
    const draft = loadDraftBook(bookId);
    if (!draft) return null;

    let totalChapters = 0;
    if (draft.sourceText) {
        totalChapters = splitIntoChapters(draft.sourceText).length;
    }

    let totalScenes = 0;
    let parsedScenes = 0;
    for (const ch of draft.chapters) {
        totalScenes += ch.scenes ? ch.scenes.length : 0;
    }
    parsedScenes = totalScenes;

    return {
        bookId,
        state: draft.manifest.state,
        source: draft.manifest.source,
        title: draft.book.title,
        author: draft.book.author,
        language: draft.book.language,
        hasSource: !!draft.sourceText,
        hasCharacters: draft.characters.length > 0,
        hasBible: Object.keys(draft.bible).length > 0,
        totalChapters,
        parsedChapters: draft.chapters.length,
        totalScenes,
        parsedScenes,
        characterCount: draft.characters.length,
        locationCount: Object.keys(draft.bible.locations || {}).length,
        sourceSize: draft.manifest.import_meta?.original_size || 0,
        updatedAt: draft.manifest.updated_at,
    };
}

function getChaptersSummary(bookId) {
    const draft = loadDraftBook(bookId);
    if (!draft) return null;

    const allChapters = draft.sourceText ? splitIntoChapters(draft.sourceText) : [];

    const chapters = allChapters.map((ch, i) => {
        const parsed = draft.chapters.find(c => c.chapter_index === i);
        return {
            index: i,
            title: ch.title,
            startLine: ch.startLine,
            endLine: ch.endLine,
            status: parsed ? SceneStatus.PARSED : SceneStatus.NOT_PARSED,
            chapterId: parsed ? parsed.chapter : null,
            sceneCount: parsed ? (parsed.scenes ? parsed.scenes.length : 0) : null,
            sceneTitles: parsed ? (parsed.scenes || []).map(s => s.scene_title || `Scene ${s.scene_id}`) : [],
        };
    });

    return {
        bookId,
        state: draft.manifest.state,
        totalChapters: allChapters.length,
        parsedChapters: draft.chapters.length,
        chapters,
    };
}

function createChapterIntroScene(chapterTitle, chapterNumber, language) {
    const scId = sceneId();

    let cleanTitle = (chapterTitle || '').trim();
    cleanTitle = cleanTitle.replace(/^(?:Глава|Chapter)\s*\d+\s*[.:]?\s*/i, '').trim();

    const sceneText = language === 'ru'
        ? `Глава ${chapterNumber}\n${cleanTitle}`
        : `Chapter ${chapterNumber}\n${cleanTitle}`;

    return {
        scene_id: scId,
        scene_title: `Глава ${chapterNumber}`,
        type: 'chapter_intro',
        style: 'soviet_book_page',
        participants: [],
        audio: {
            voice: 'narrator',
            full_text: sceneText,
        },
        units: [{
            id: unitId(),
            type: 'typography',
            text: sceneText,
            participants: [],
            visual: {
                shot: 'wide',
                prompt: `Chapter ${chapterNumber} title page typography, book style, ${cleanTitle}`,
                type: 'typography',
                text_render: sceneText,
                quality: 'high',
            },
        }],
    };
}

function createCoverChapter(title, author, language) {
    const chId = chapterId();
    const scId = sceneId();
    const displayTitle = title || 'Imported Book';
    const displayAuthor = author || '';

    const textParts = [];
    if (displayAuthor) textParts.push(displayAuthor);
    if (displayTitle) textParts.push(displayTitle);
    const sceneText = textParts.join('\n\n');

    return {
        chapter: chId,
        chapter_title: 'Обложка',
        type: 'cover',
        scenes: [{
            scene_id: scId,
            scene_title: 'Cover',
            type: 'cover',
            style: 'soviet_book_page',
            participants: [],
            audio: {
                voice: 'narrator',
                full_text: sceneText,
            },
            units: [{
                id: unitId(),
                type: 'typography',
                text: sceneText,
                participants: [],
                visual: {
                    shot: 'wide',
                    prompt: `Book cover: ${displayTitle}${displayAuthor ? ` by ${displayAuthor}` : ''}, typography, elegant design`,
                    type: 'typography',
                    text_render: sceneText,
                    quality: 'high',
                },
            }],
        }],
    };
}

function saveCoverChapter(bookId, coverChapter) {
    if (!coverChapter) return;
    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    const chFile = `${coverChapter.chapter}.json`;
    const chPath = path.join(chDir, chFile);
    fs.writeFileSync(chPath, JSON.stringify(coverChapter, null, 2));
    console.log(`[LAZY-BOOK] Cover chapter saved to chapters/${chFile} for ${bookId}: "${coverChapter.chapter_title}"`);
}

function updateBookMetadata(bookDir, updates) {
    const bp = getBookMetaPath(bookDir);
    if (!fs.existsSync(bp)) return;
    const bookMeta = JSON.parse(fs.readFileSync(bp, 'utf8'));
    let changed = false;
    if (updates.author && !bookMeta.author) {
        bookMeta.author = updates.author;
        changed = true;
    }
    if (updates.title && !bookMeta.title) {
        bookMeta.title = updates.title;
        changed = true;
    }
    if (updates.structure) {
        if (updates.structure.has_prologue !== undefined) {
            bookMeta.structure.has_prologue = updates.structure.has_prologue;
            changed = true;
        }
        if (updates.structure.has_epilogue !== undefined) {
            bookMeta.structure.has_epilogue = updates.structure.has_epilogue;
            changed = true;
        }
        if (updates.structure.parts) {
            bookMeta.structure.parts = updates.structure.parts;
            changed = true;
        }
        if (updates.structure.chapters) {
            bookMeta.structure.chapters = updates.structure.chapters;
            changed = true;
        }
    }
    if (changed) {
        bookMeta.updated_at = new Date().toISOString();
        fs.writeFileSync(bp, JSON.stringify(bookMeta, null, 2));
        console.log(`[LAZY-BOOK] Metadata updated: ${Object.keys(updates).join(', ')}`);
    }
}

function createFromAnalysis(bookId, analysis, options = {}) {
    const { maxScenes, chapterTitle } = options;
    const structure = options.structure || analysis.structure || null;
    return createOrAppendScenes(bookId, analysis, {
        maxScenes: maxScenes ?? analysis.maxScenes ?? 6,
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? 'Глава 1',
        chapterIndex: 0,
        isFirstWindow: true,
        structure: structure,
    });
}

function appendToBook(bookId, analysis, options = {}) {
    const { chapterTitle, chapterIndex } = options;
    const structure = options.structure || analysis.structure || null;
    return createOrAppendScenes(bookId, analysis, {
        maxScenes: options.maxScenes ?? analysis.maxScenes ?? 6,
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? `Глава ${(chapterIndex ?? analysis.chapterIndex ?? 0) + 1}`,
        chapterIndex: chapterIndex ?? analysis.chapterIndex ?? 0,
        isFirstWindow: false,
        structure: structure,
    });
}

function fragmentAppearanceForVideo(appearance, charName) {
    if (!appearance || appearance.length < 5) {
        return `${charName.toLowerCase()} character, distinctive appearance`;
    }

    const sentences = appearance.match(/[^.!?]+[.!?]+/g) || [appearance];

    const fragments = [];

    const ageBuildRe = /(\d+[-\s]year[-\s]old|young|middle[-\s]aged|elderly|old|teen|child|\bkid\b|toddler|infant|adult)|(?:thin|slim|stocky|muscular|strong|heavy|overweight|obese|frail|petite|broad|wide|narrow|tall|short|average|athletic|lean|buff|chubby|plump|curvy|slender|small|large)/i;
    for (const s of sentences) {
        const match = s.match(ageBuildRe);
        if (match) {
            const frag = s.replace(ageBuildRe, '$1 $2').split(/[.,;]/)[0].trim();
            const clean = frag.replace(/^(his|her|a |the |an )/i, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const faceHairRe = /(?:face|hair|eyes|brow|beard|moustache|mustache|whisker|cheek|chin|jaw|nose|lips|mouth|forehead|skin|complexion|pale|wrinkle|freckle|scar|clean[-\s]shaven|bald|haired|hairstyle|bearded|glasses|spectacles|oculus)/i;
    const faceHairRu = /(?:лиц|волос|глаз|бров|бород|ус|щек|подбород|нос|губ|рот|лоб|кож|морщин|веснуш|шрам|брит|лыс|очк)/i;
    for (const s of sentences) {
        if (faceHairRe.test(s) || faceHairRu.test(s)) {
            const clean = s.replace(/^(his|her|a |the |an |его|ее|его|их|моя|мои|наши)/i, '').trim();
            if (clean.length > 5 && clean.length < 80) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const clothingRe = /(?:wearing|dressed|suit|shirt|coat|dress|hat|jacket|tie|shoes|boots|uniform|robe|cloak|outfit|sweater|vest|hoodie|pants|jeans|skirt|scarf|gloves|belt|cape|gown|tunic|armor|crown|necklace|bracelet|ring|earring|tattoo|piercing)|(?:костюм|пиджак|брюк|шляп|кепк|фуражк|рубашк|сорочк|галстук|пальто|плать|ботинк|сапог|халат|куртк|сюртук|жилет|френч|шинел|мундир|плащ|шарф|перчатк|ремень|пояс)/i;
    for (const s of sentences) {
        if (clothingRe.test(s)) {
            const clean = s.replace(/^(in |wearing |dressed in |a |the |his |her |одет|в |надет|облачен)/i, '').trim();
            if (clean.length > 3 && clean.length < 80) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const featureRe = /(?:distinctive|unusual|notable|remarkable|striking|peculiar|curious|strange|odd|unique|special|особ|необыч|примечател|выдающ|стран|уникал)/i;
    for (const s of sentences) {
        if (featureRe.test(s)) {
            let clean = s.replace(featureRe, '').replace(/^(his|her|a |the |an |with a |with |has a |имеет|обладает|c |со |сво|его|ее)/i, '').trim();
            clean = clean.replace(/[.,;:!?]+$/, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    if (fragments.length < 2) {
        const parts = appearance.split(/[,;]/).map(p => p.trim()).filter(p => p.length > 3);
        for (const part of parts) {
            if (/выглядит|кажется|похож|как будто|словно|looks? like|seems|appears|feels|emotion|trembl|тревог|волн|радост|груст|печал|страх|испуг|удивлен/i.test(part)) continue;
            const clean = part.replace(/^(a |the |his |her |an |and |with )/i, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                if (fragments.length >= 4) break;
            }
        }
    }

    const unique = [];
    for (const f of fragments) {
        const isDuplicate = unique.some(u =>
            u.includes(f) || f.includes(u) ||
            u.split(/\s+/).slice(0, 3).join(' ') === f.split(/\s+/).slice(0, 3).join(' ')
        );
        if (!isDuplicate) unique.push(f);
    }

    let result = unique.join(', ');
    if (result.length > 120) {
        result = result.substring(0, 120).replace(/\s+\S*$/, '');
    }

    return result || `${charName.toLowerCase()} character, distinctive appearance`;
}

/**
 * Extract a meaningful scene title from the scene's text content.
 * Used as a fallback when the AI doesn't provide a proper title.
 * Takes the first sentence, limits to ~8 words.
 *
 * NOTE: Parallel implementation of agent-service.js extractSceneTitle.
 * Kept separate to avoid circular dependency (lazy-book imports by agent-service).
 * Keep in sync when modifying.
 */
function extractSceneTitle(sceneText, fallbackIndex) {
    const t = (sceneText || '').trim();
    if (!t) return `Scene ${fallbackIndex + 1}`;

    let title = t;

    // For dialogue-starting scenes, use the first speech line
    if (/^[—–\-]/.test(t)) {
        const newlinePos = t.indexOf('\n');
        const firstLine = newlinePos > 0 ? t.substring(0, newlinePos) : t;
        title = firstLine.replace(/^[—–\-\s"]+/, '').replace(/["»]+$/, '').trim();
    } else {
        // For narration, take first sentence
        // Prefer . ! ? over … to avoid mid-sentence ellipsis splits.
        const dotEnd = t.search(/[.!?](?:\s|$)/);
        const sentenceEnd = dotEnd >= 0 ? dotEnd : t.search(/…(?:\s|$)/);
        if (sentenceEnd > 3) {
            title = t.substring(0, sentenceEnd + 1);
        }
        title = title.replace(/^[—–\-\s"]+/, '').replace(/[.!?…]+$/, '').trim();
    }

    // Limit to ~8 words for a concise title
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 8) {
        title = words.slice(0, 8).join(' ');
        if (title.length < t.length) title += '…';
    }

    // Capitalise first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title || `Scene ${fallbackIndex + 1}`;
}

/**
 * Check whether a scene title is generic / auto-generated
 * (e.g. "Scene 1", "Scene 2") and should be replaced.
 * NOTE: Parallel implementation of agent-service.js isGenericSceneTitle.
 * Keep in sync when modifying.
 */
function isGenericSceneTitle(title) {
    if (!title) return true;
    const trimmed = title.trim();
    if (trimmed.length < 3) return true;
    if (/^(Scene|Сцена|Chapter|Глава|Part|Часть)\s*\d*$/i.test(trimmed)) return true;
    return false;
}

function extractClothing(appearance) {
    if (!appearance) {
        return {
            clothingBase: 'period-appropriate clothing',
            clothingDetails: 'clothing as described in the narrative',
        };
    }

    const clothingRe = /((?:wearing|dressed in|in a|in an|clad in|adorned in|wore|wears|wearing a|dressed|clothed|attired|outfitted)\s+[^.,;!?]{3,60})|([^.,;!?]{3,60}(?:suit|shirt|coat|dress|hat|jacket|tie|shoes|boots|uniform|robe|cloak|outfit|sweater|vest|hoodie|pants|jeans|skirt|scarf|gloves|belt|cape|gown|tunic|armor|crown|necklace|ring)[^.,;!?]{0,40})|((?:костюм|пиджак|брюк|шляп|кепк|фуражк|рубашк|сорочк|галстук|пальто|плать|ботинк|сапог|халат|куртк|сюртук|жилет|френч|шинел|мундир|плащ|шарф|перчатк|ремень|пояс|кепка|фуражка)[^.,;!?]{0,40})/gi;

    const matches = appearance.match(clothingRe);

    if (matches && matches.length > 0) {
        const cleanMatches = matches
            .map(m => m.replace(/^(in |a |the |his |her |wearing |dressed |clad in|adorned in|wore|wears|одет|в |надет|облачен|на нем|на ней|на нем была|на ней была)/i, '').trim())
            .filter(m => m.length > 3);

        if (cleanMatches.length > 0) {
            return {
                clothingBase: cleanMatches[0].toLowerCase(),
                clothingDetails: cleanMatches.slice(0, 3).join('; ').toLowerCase(),
            };
        }
    }

    const fallbackRe = /(?:в [^.,;!?]{5,60}|[нН]осит [^.,;!?]{5,60}|одет[аоы]? [в] [^.,;!?]{5,60}|wear(?:ing)? [^.,;!?]{5,60}|dressed [^.,;!?]{5,60}|clad [^.,;!?]{5,60})/i;
    const fallbackMatch = appearance.match(fallbackRe);
    if (fallbackMatch) {
        return {
            clothingBase: fallbackMatch[0].trim().toLowerCase(),
            clothingDetails: fallbackMatch[0].trim().toLowerCase(),
        };
    }

    return {
        clothingBase: 'period-appropriate clothing',
        clothingDetails: 'clothing as described in the text',
    };
}

function createOrAppendScenes(bookId, analysis, windowConfig) {
    const draft = loadDraftBook(bookId);
    if (!draft) throw new Error(`Book ${bookId} not found`);
    if (!draft.sourceText) throw new Error(`Book ${bookId} has no source text`);

    const { sourceText, book: bookMeta } = draft;
    const language = bookMeta.language || detectLanguage(sourceText);
    if (!bookMeta.language) bookMeta.language = language;

    const { maxScenes, chapterTitle, chapterIndex, isFirstWindow, structure } = windowConfig;
    const bookDir = getBookDir(bookId);

    if (structure && isFirstWindow) {
        updateBookMetadata(bookDir, {
            author: structure.author,
            title: structure.title,
            structure: {
                has_prologue: structure.has_prologue,
                has_epilogue: structure.has_epilogue,
                parts: structure.parts,
                chapters: structure.chapters,
            },
        });
    }

    let existingCharacters = [];
    let existingBible = null;

    if (!isFirstWindow) {
        try {
            const charPath = getCharactersPath(bookDir);
            if (fs.existsSync(charPath)) {
                existingCharacters = JSON.parse(fs.readFileSync(charPath, 'utf8'));
            }
        } catch (e) {
            console.warn(`[LAZY-BOOK] Failed to load existing characters: ${e.message}`);
        }
        try {
            const bibPath = getBiblePath(bookDir);
            if (fs.existsSync(bibPath)) {
                existingBible = JSON.parse(fs.readFileSync(bibPath, 'utf8'));
            }
        } catch (e) {
            console.warn(`[LAZY-BOOK] Failed to load existing bible: ${e.message}`);
        }
    }

    const existingIds = new Set(existingCharacters.map(c => c.id));
    const mergedCharacters = [...existingCharacters];

    const defaultVoiceRu = 'A mature Russian male voice. Deep, calm, reflective. Native Russian pronunciation.';
    const defaultVoiceEn = 'A mature male voice. Deep, calm, reflective. Native English pronunciation.';

    for (const ch of (analysis.characters || [])) {
        if (existingIds.has(ch.id)) continue;
        const charId = ch.id || ch.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');

        const rawAppearance = ch.appearance || ch.description || null;

        let appearance;
        if (!rawAppearance || /не опис|no descr|unknown|unclear/i.test(rawAppearance)) {
            appearance = `${ch.name}: a character from the story, seen in period-appropriate clothing, with distinctive features as described in the narrative context`;
        } else {
            appearance = rawAppearance;
        }

        const baseMatch = appearance.match(/^[^.!?]+[.!?]?/);
        const baseAppearance = baseMatch ? baseMatch[0].trim() : appearance;
        const detailedAppearance = appearance;

        const videoTokens = fragmentAppearanceForVideo(appearance, ch.name);

        const { clothingBase, clothingDetails } = extractClothing(appearance);

        const voiceInstruction = ch.voice
            ? ch.voice
            : (mergedCharacters.length === 0
                ? (language === 'ru' ? defaultVoiceRu : defaultVoiceEn)
                : (language === 'ru'
                    ? `A Russian ${mergedCharacters.length < 3 ? 'male' : 'character'} voice matching ${ch.name}. Natural intonation.`
                    : `A character voice matching ${ch.name}. Natural intonation.`));

        mergedCharacters.push({
            id: charId,
            name: ch.name,
            role: ch.role || 'minor',
            passport: {
                base_appearance: baseAppearance,
                detailed_appearance: detailedAppearance,
                clothing_base: clothingBase,
                clothing_details: clothingDetails,
                video_tokens: videoTokens || `${ch.name.toLowerCase()} character, period clothing, distinctive appearance`,
            },
            voice: {
                instruction: voiceInstruction,
            },
        });
        existingIds.add(charId);
    }

    let locations = {};
    if (existingBible && existingBible.locations) {
        locations = { ...existingBible.locations };
    }
    for (const loc of (analysis.locations || [])) {
        const locId = loc.id || loc.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!locations[locId]) {
            locations[locId] = {
                description: loc.description || `${loc.name} — location from the source text`,
                visual_style: 'natural cinematic style matching narrative context',
                cinematic_space: loc.name,
                default_mood: 'neutral narrative mood',
            };
        }
    }

    const narratorVoice = language === 'ru'
        ? 'A mature Russian male voice. Deep, calm, reflective, slightly melancholic. Slow literary narration, soft authority, philosophical tone. Native Russian pronunciation.'
        : 'A mature male voice. Deep, calm, reflective. Slow literary narration, soft authority. Native English pronunciation.';

    const bible = {
        version: '3.0',
        narrator: { voice: { instruction: narratorVoice } },
        locations,
        render_rules: {
            style: 'cinematic_realism',
            lighting_default: 'natural',
            character_consistency: true,
            spatial_consistency: true,
        },
    };

    fs.writeFileSync(getCharactersPath(bookDir), JSON.stringify(mergedCharacters, null, 2));
    fs.writeFileSync(getBiblePath(bookDir), JSON.stringify(bible, null, 2));

    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    let chapterObj = null;
    let chFile = null;

    if (!isFirstWindow) {
        const existingChapters = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
        for (const cf of existingChapters) {
            try {
                const ch = JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'));
                if (ch.chapter_index === chapterIndex) {
                    chapterObj = ch;
                    chFile = cf;
                    break;
                }
            } catch (e) { /* skip */ }
        }
    }

    if (!chapterObj) {
        const chId = chapterId();
        chFile = `${chId}.json`;
        chapterObj = {
            chapter: chId,
            chapter_title: chapterTitle || `Chapter ${chapterIndex + 1}`,
            type: 'chapter',
            chapter_index: chapterIndex,
            status: SceneStatus.PARSED,
            scenes: [],
        };
    }

    const hasCoverChapter = fs.readdirSync(chDir).filter(f => f.endsWith('.json'))
        .some(f => {
            try {
                const ch = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
                return ch.type === 'cover';
            } catch (_) { return false; }
        });

    if (isFirstWindow && !hasCoverChapter) {
        const coverTitle = structure?.title || bookMeta.title || 'Imported Book';
        const coverAuthor = structure?.author || bookMeta.author || null;
        const coverChapter = createCoverChapter(coverTitle, coverAuthor, language);
        saveCoverChapter(bookId, coverChapter);
        console.log(`[LAZY-BOOK] Cover chapter saved for ${bookId}`);

        const bookMetaPath = getBookMetaPath(bookDir);
        if (fs.existsSync(bookMetaPath)) {
            try {
                const bm = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
                if (bm.structure?.chapters_order) {
                    bm.structure.chapters_order.unshift(`${coverChapter.chapter}.json`);
                    fs.writeFileSync(bookMetaPath, JSON.stringify(bm, null, 2));
                }
            } catch (_) {}
        }
    }

    // ── Migration: move old chapter_intro scene → chapter.intro ──
    const oldIntroIdx = chapterObj.scenes.findIndex(s => s.type === 'chapter_intro');
    if (oldIntroIdx >= 0 && !chapterObj.intro) {
        const oldIntro = chapterObj.scenes[oldIntroIdx];
        chapterObj.intro = {
            text: oldIntro.audio?.full_text || oldIntro.units?.[0]?.text || '',
            scene_title: oldIntro.scene_title || '',
            style: oldIntro.style || 'soviet_book_page',
        };
        chapterObj.scenes.splice(oldIntroIdx, 1);
    }

    // ── Create chapter_intro metadata (programmatic, not a scene) ──
    // ── Build chapter title with full name (e.g., "Глава 1 — НИКОГДА НЕ РАЗГОВАРИВАЙТЕ...") ──
    let fullChapterTitle = null;
    if (structure && structure.chapters && structure.chapters.length > 0) {
        const chapterInfo = windowConfig.chapterIndex < structure.chapters.length
            ? structure.chapters[windowConfig.chapterIndex]
            : null;
        if (chapterInfo) {
            const chNum = chapterInfo.number || (windowConfig.chapterIndex + 1);
            const chTitleRaw = chapterInfo.title || '';
            if (chTitleRaw && chTitleRaw.length > 0) {
                fullChapterTitle = `Глава ${chNum} — ${chTitleRaw}`;
            }
        }
    }
    if (!fullChapterTitle) {
        fullChapterTitle = chapterTitle || `Глава ${(chapterIndex || 0) + 1}`;
    }
    if (chapterObj && !chapterObj.chapter_title || chapterObj.chapter_title === chapterTitle) {
        chapterObj.chapter_title = fullChapterTitle;
    }

    // ── Create chapter_intro metadata (programmatic, not a scene) ──
    if (!chapterObj.intro) {
        let introData = null;

        // Helper: build intro from a chapter title string (e.g. "Глава 1: НИКОГДА НЕ РАЗГОВАРИВАЙТЕ...")
        // or fallback to just "Глава N" if no title available.
        function buildIntroFromTitle(rawTitle, chNum, lang) {
            const clean = (rawTitle || '').replace(/^(?:Глава|Chapter)\s*\d+\s*[.:]?\s*/i, '').trim();
            if (clean) {
                return {
                    text: lang === 'ru' ? `Глава ${chNum}\n${clean}` : `Chapter ${chNum}\n${clean}`,
                    scene_title: lang === 'ru' ? `Глава ${chNum}` : `Chapter ${chNum}`,
                    style: 'soviet_book_page',
                };
            }
            return null;
        }

        // 1) Try the AI structure first (it has the AI-extracted chapter title)
        if (structure && structure.chapters && structure.chapters.length > 0) {
            const chapterInfo = windowConfig.chapterIndex < structure.chapters.length
                ? structure.chapters[windowConfig.chapterIndex]
                : null;
            if (chapterInfo) {
                const chNum = chapterInfo.number || (windowConfig.chapterIndex + 1);
                const chTitle = chapterInfo.title || '';
                if (chTitle) {
                    introData = buildIntroFromTitle(chTitle, chNum, language);
                }
            }
        }

        // 2) Fallback: use the parser-extracted chapterTitle (from getWindowText / splitIntoChapters)
        if (!introData) {
            const chNum = (chapterIndex || 0) + 1;
            const fallbackTitle = chapterTitle || (language === 'ru' ? `Глава ${chNum}` : `Chapter ${chNum}`);
            introData = buildIntroFromTitle(fallbackTitle, chNum, language)
                || {
                    text: language === 'ru' ? `Глава ${chNum}` : `Chapter ${chNum}`,
                    scene_title: language === 'ru' ? `Глава ${chNum}` : `Chapter ${chNum}`,
                    style: 'soviet_book_page',
                };
        }

        if (introData) {
            chapterObj.intro = introData;
        }
    }

    // ── Create programmatic chapter_intro scene (prepended to scenes[]) ──
    const introMeta = chapterObj.intro;
    if (introMeta && introMeta.text) {
        const existingIntro = chapterObj.scenes.find(s => s.type === 'chapter_intro');
        if (!existingIntro) {
            const introScene = {
                scene_id: sceneId(),
                scene_title: introMeta.scene_title || `Глава ${(chapterIndex || 0) + 1}`,
                type: 'chapter_intro',
                style: introMeta.style || 'soviet_book_page',
                participants: [],
                audio: {
                    voice: 'narrator',
                    full_text: introMeta.text,
                },
                units: [{
                    id: unitId(),
                    type: 'typography',
                    text: introMeta.text,
                    participants: [],
                    visual: {
                        shot: 'wide',
                        prompt: `Chapter ${(chapterIndex || 0) + 1} title page typography, book style`,
                        type: 'typography',
                        text_render: introMeta.text,
                        quality: 'high',
                    },
                }],
            };
            chapterObj.scenes.unshift(introScene);
        }
    }

    // ── AI narrative scenes (clean maxScenes, no structural subtraction) ──
    const aiScenes = (analysis.scenes || []).slice(0, maxScenes);
    const validScenes = aiScenes.filter(s => s.text && s.text.trim().length > 0 && s.units && s.units.some(u => (u.text || '').trim()));
    if (validScenes.length === 0 && !chapterObj.intro) {
        throw new Error('AI returned no valid scenes — book cannot be created');
    }

    for (const aiScene of validScenes) {
        const scId = sceneId();
        const sceneText = aiScene.text.trim();

        const sceneUnits = aiScene.units
            .filter(u => (u.text || '').trim())
            .map(u => ({
                id: unitId(),
                type: u.type || 'perception',
                text: u.text.trim(),
                participants: u.participants || [],
                visual: u.visual || undefined,
                source_start: u.source_start ?? undefined,
                source_end: u.source_end ?? undefined,
            }));

        const cleanUnits = sceneUnits.length > 0 ? sceneUnits : [{
            id: unitId(),
            type: 'perception',
            text: sceneText,
            participants: [],
        }];

        const isDialogue = cleanUnits.some(u => u.type === 'dialogue' || u.type === 'dialectic');

        const allParticipants = [];
        const sceneParticipants = aiScene.characters_present || aiScene.participants || [];
        for (const p of sceneParticipants) {
            if (!allParticipants.includes(p)) allParticipants.push(p);
        }
        for (const u of cleanUnits) {
            for (const p of (u.participants || [])) {
                if (!allParticipants.includes(p)) allParticipants.push(p);
            }
        }

        // style is only relevant for typography scenes (cover, chapter_intro),
        // NOT for narrative scenes. The buildImagePrompt() function has its own
        // visual style resolution with proper typography-style filtering.
        const sceneStyle = aiScene.type === 'chapter_intro' || cleanUnits.some(u => u.type === 'typography')
            ? 'soviet_book_page'
            : undefined;

        chapterObj.scenes.push({
            scene_id: scId,
            scene_title: (aiScene.title && !isGenericSceneTitle(aiScene.title))
                ? aiScene.title
                : extractSceneTitle(aiScene.text || '', chapterObj.scenes.length),
            type: isDialogue ? 'dialogue' : 'narration',
            style: sceneStyle,
            participants: allParticipants,
            location: aiScene.location || undefined,
            character_anchors: aiScene.character_anchors || undefined,
            source_start: aiScene.source_start ?? null,
            source_end: aiScene.source_end ?? null,
            audio: {
                voice: 'narrator',
                full_text: sceneText,
            },
            units: cleanUnits,
        });
    }

    if (chapterObj.scenes.length === 0) {
        throw new Error('No valid scenes created from AI analysis');
    }

    fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chapterObj, null, 2));

    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
    // Preserve cover chapter at position 0 (it was saved earlier via saveCoverChapter)
    const coverIdx = existingFiles.findIndex(f => {
        try {
            const ch = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
            return ch.type === 'cover';
        } catch (_) { return false; }
    });
    if (coverIdx > 0) {
        const coverFile = existingFiles.splice(coverIdx, 1)[0];
        existingFiles.unshift(coverFile);
    }
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    const bookState = isFirstWindow ? BookState.BOOTSTRAPPED : BookState.BOOTSTRAPPED;
    updateBookState(bookId, bookState);

    console.log(`[LAZY-BOOK] ${isFirstWindow ? 'Created' : 'Appended'} ${bookId}: ${mergedCharacters.length} chars, ${Object.keys(locations).length} locs, ${chapterObj.scenes.length} scenes (window, chIndex=${chapterIndex})`);

    return {
        bookId,
        state: bookState,
        title: bookMeta.title,
        author: bookMeta.author,
        language,
        characters: mergedCharacters.length,
        locations: Object.keys(locations).length,
        chapter: chapterObj,
        scenes: chapterObj.scenes.length,
    };
}

module.exports = {
    BookState, SceneStatus, SourceType, UnitType,
    getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getBiblePath, getChapterDir, getChapterPath,
    createDraftBook, loadDraftBook, updateBookState,
    createFromAnalysis, appendToBook,
    createOrAppendScenes,
    lazyParseNextWindow, lazyParseChapter,
    getBookStatus, getChaptersSummary,
    splitIntoChapters, splitIntoScenes, splitIntoUnits, firstMeaningfulChapter,
    detectLanguage, injectChapterMarkers,
    chapterId, sceneId, unitId, generateBookId,
    DEFAULT_WINDOW_SIZE,
    createCoverChapter,
    saveCoverChapter,
};

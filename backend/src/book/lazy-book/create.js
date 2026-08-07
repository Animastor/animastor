// ======================================================
// Lazy Book — Scene & Chapter Creation
// ======================================================

const fs = require('fs');
const path = require('path');
const { BookState, SceneStatus } = require('./constants');
const { getBookDir, getChapterDir, getBookMetaPath, getCharactersPath, getMentionsPath, getBiblePath, getLocationsPath, getVoicesPath, chapterId, sceneId, unitId } = require('./paths');
const { detectLanguage } = require('./parser');
const { findCanonicalCharacter, isGenericCharacter } = require('../../utils/character-identity');
const draft = require('./draft');
const metadata = require('./metadata');
const chapterUtils = require('./chapter-utils');
const appearance = require('./appearance');

function createFromAnalysis(bookId, analysis, options = {}) {
    const { maxScenes, chapterTitle } = options;
    const structure = options.structure || analysis.structure || null;
    return createOrAppendScenes(bookId, analysis, {
        maxScenes: maxScenes ?? analysis.maxScenes ?? 6,
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? null,
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
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? null,
        chapterIndex: chapterIndex ?? analysis.chapterIndex ?? 0,
        isFirstWindow: false,
        structure: structure,
    });
}

function createOrAppendScenes(bookId, analysis, windowConfig) {
    const d = draft.loadDraftBook(bookId);
    if (!d) throw new Error(`Book ${bookId} not found`);
    if (!d.sourceText) throw new Error(`Book ${bookId} has no source text`);

    let bookMeta = d.book;
    const sourceText = d.sourceText;
    const language = bookMeta.language || detectLanguage(sourceText);
    if (!bookMeta.language) bookMeta.language = language;

    const { maxScenes, chapterTitle, chapterIndex, isFirstWindow, structure } = windowConfig;
    const bookDir = getBookDir(bookId);

    if (structure && isFirstWindow) {
        metadata.updateBookMetadata(bookDir, {
            author: structure.author,
            title: structure.title,
            structure: {
                has_prologue: structure.has_prologue,
                has_epilogue: structure.has_epilogue,
                parts: structure.parts,
                chapters: structure.chapters,
            },
        });
        // updateBookMetadata's guards skip already-set title/author — but the
        // draft title is the FILENAME ("test.txt"), which must be overridden
        // by the real detected title (same behavior as bootstrap.js).
        const freshMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
        if (structure.title) freshMeta.title = structure.title;
        if (structure.author) freshMeta.author = structure.author;
        fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(freshMeta, null, 2));
        // Re-read: the final chapters_order write below must not clobber the
        // metadata update above with the stale in-memory copy.
        bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    }

    let existingCharacters = [];
    let existingLocations = {};

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
            // Load existing locations from separate file
            const locPath = getLocationsPath(bookDir);
            if (fs.existsSync(locPath)) {
                existingLocations = JSON.parse(fs.readFileSync(locPath, 'utf8'));
            }
        } catch (e) {
            console.warn(`[LAZY-BOOK] Failed to load existing locations: ${e.message}`);
        }
    }

    const existingIds = new Set(existingCharacters.map(c => c.id));
    const mergedCharacters = [...existingCharacters];

    const defaultVoiceRu = 'A mature Russian male voice. Deep, calm, reflective. Native Russian pronunciation.';
    const defaultVoiceEn = 'A mature male voice. Deep, calm, reflective. Native English pronunciation.';

    for (const ch of (analysis.characters || [])) {
        const charId = ch.id || ch.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
        if (existingIds.has(charId)) continue;
        if (isGenericCharacter({ ...ch, id: charId })) {
            console.warn(`[LAZY-BOOK] Skipping generic character without stable context: ${charId}`);
            continue;
        }
        const canonical = findCanonicalCharacter({ ...ch, id: charId }, mergedCharacters);
        if (canonical) {
            console.log(`[LAZY-BOOK] Merged character alias ${charId} -> ${canonical.id}`);
            continue;
        }

        // The AGENT (ai/rules/characters.md) is responsible for separating the
        // physical appearance from the clothes. The program ONLY validates the
        // agent's output and fills safe defaults — it never re-splits text with
        // heuristics, so appearance and clothes never overlap or get mangled.
        const rawAppearance = ch.appearance || ch.description || null;

        let appearanceDesc;
        if (!rawAppearance || /не опис|no descr|unknown|unclear/i.test(rawAppearance)) {
            appearanceDesc = `${ch.name}: a character from the story, seen in period-appropriate clothing, with distinctive features as described in the narrative context`;
        } else {
            appearanceDesc = rawAppearance;
        }

        // clothes comes from the agent as its own field. An empty string is fine —
        // the prompt builder appends clothing only when it is non-empty.
        const clothes = (typeof ch.clothes === 'string' && ch.clothes.trim())
            ? ch.clothes.trim()
            : '';

        const videoTokens = appearance.fragmentAppearanceForVideo(
            clothes ? `${appearanceDesc}, ${clothes}` : appearanceDesc,
            ch.name
        );

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
                appearance: appearanceDesc,
                clothes,
                video_tokens: videoTokens || `${ch.name.toLowerCase()} character, period clothing, distinctive appearance`,
            },
            voice: {
                instruction: voiceInstruction,
            },
        });
        existingIds.add(charId);
    }

    let locations = { ...existingLocations };
    for (const loc of (analysis.locations || [])) {
        const locId = loc.id || loc.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!locations[locId]) {
            const entry = {
                name: loc.name,
                description: loc.description || `${loc.name} — location from the source text`,
            };
            // Global environment template — scene environments override it per-field.
            if (loc.environment && typeof loc.environment === 'object' && Object.keys(loc.environment).length > 0) {
                entry.environment = loc.environment;
            }
            locations[locId] = entry;
        } else if (loc.name && !locations[locId].name) {
            // Backfill missing name on existing location (first window wins)
            locations[locId].name = loc.name;
        }
    }

    const narratorVoice = language === 'ru'
        ? 'A mature Russian male voice. Deep, calm, reflective, slightly melancholic. Slow literary narration, soft authority, philosophical tone. Native Russian pronunciation.'
        : 'A mature male voice. Deep, calm, reflective. Slow literary narration, soft authority. Native English pronunciation.';

    const bible = {
        version: '3.0',
        locations,
        country: structure?.country || null,
        epoch: structure?.epoch || null,
        render_rules: {
            style: 'cinematic_realism',
            lighting_default: 'natural',
            character_consistency: true,
            spatial_consistency: true,
        },
    };

    let mergedMentions = {};
    try {
        const mPath = getMentionsPath(bookDir);
        if (fs.existsSync(mPath)) {
            mergedMentions = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        }
    } catch (_) {}
    if (analysis.mentions && typeof analysis.mentions === 'object') {
        for (const [alias, charId] of Object.entries(analysis.mentions)) {
            if (!mergedMentions[alias]) mergedMentions[alias] = charId;
        }
    }
    if (Object.keys(mergedMentions).length > 0) {
        fs.writeFileSync(getMentionsPath(bookDir), JSON.stringify(mergedMentions, null, 2));
    }

    const passportChars = mergedCharacters.filter(c => {
        const p = c.passport || {};
        // A character counts as visually described when it has EITHER a real
        // appearance OR real clothes (the agent may provide one without the other).
        const appearanceText = p.appearance || p.clothes || '';
        const hasRealAppearance = appearanceText.length > 8 &&
            !/character from the story|period-appropriate|as described in/i.test(appearanceText);
        return hasRealAppearance;
    }).map(c => {
        // Strip voice — voices live in voices.json only
        const { voice, ...charWithoutVoice } = c;
        return charWithoutVoice;
    });
    fs.writeFileSync(getCharactersPath(bookDir), JSON.stringify(passportChars, null, 2));
    if (passportChars.length < mergedCharacters.length) {
        console.log(`[LAZY-BOOK] Filtered characters: ${passportChars.length} with passport out of ${mergedCharacters.length} total`);
    }

    // Save locations to separate file
    fs.writeFileSync(getLocationsPath(bookDir), JSON.stringify(locations, null, 2));

    // Save all voices to separate file (narrator + characters)
    // voices.json — single source of truth. For subsequent windows, load existing
    // and only add/update voices for NEW characters from the current window.
    // Old characters keep their existing voices untouched.
    let voices = { narrator: { instruction: narratorVoice } };
    try {
        const vPath = getVoicesPath(bookDir);
        if (fs.existsSync(vPath)) {
            const existing = JSON.parse(fs.readFileSync(vPath, 'utf8')) || {};
            voices = { narrator: { instruction: narratorVoice }, ...existing };
        }
    } catch (e) {
        console.warn(`[LAZY-BOOK] Failed to load existing voices: ${e.message}`);
    }
    // Add/update voices for characters from the current window.
    // stepGenerateVoices sets ch.voice as a STRING (voices[id].instruction),
    // not as { instruction: string }. Handle both formats.
    for (const ch of (analysis.characters || [])) {
        if (!ch.id) continue;
        const vi = typeof ch.voice === 'string' ? ch.voice : ch.voice?.instruction;
        if (vi) {
            voices[ch.id] = { instruction: vi };
        }
    }
    fs.writeFileSync(getVoicesPath(bookDir), JSON.stringify(voices, null, 2));

    // Save bible.json without locations and narrator
    const { locations: _bibleLocs, narrator: _bibleNarrator, ...bibleWithoutExtra } = bible;
    fs.writeFileSync(getBiblePath(bookDir), JSON.stringify(bibleWithoutExtra, null, 2));

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
            chapter_id: chId,
            chapter_title: chapterTitle || null,
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
        // Cover ONLY when a REAL title was detected by the structure analysis
        // (v2: "find what exists"). Never the filename-derived bookMeta.title —
        // a book without a title simply has no cover chapter.
        const coverTitle = structure?.title || null;
        const coverAuthor = structure?.author || null;
        if (coverTitle) {
            const coverChapter = chapterUtils.createCoverChapter(coverTitle, coverAuthor, language);
            chapterUtils.saveCoverChapter(bookId, coverChapter);
            console.log(`[LAZY-BOOK] Cover chapter saved for ${bookId}`);

            const bookMetaPath = getBookMetaPath(bookDir);
            if (fs.existsSync(bookMetaPath)) {
                try {
                    const bm = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
                    if (bm.structure?.chapters_order) {
                        bm.structure.chapters_order.unshift(`${coverChapter.chapter_id}.json`);
                        fs.writeFileSync(bookMetaPath, JSON.stringify(bm, null, 2));
                    }
                } catch (_) {}
            }
        } else {
            console.log(`[LAZY-BOOK] No cover chapter — no title detected for ${bookId}`);
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

    // ── Segment info from the v2 chapter map ──
    // structure.chapters is aligned by index with the segments and carries
    // { type, number, title, label, header_line }. It drives the chapter
    // type, the title, and the typography intro scene.
    const segInfo = (structure && structure.chapters && windowConfig.chapterIndex < structure.chapters.length)
        ? structure.chapters[windowConfig.chapterIndex]
        : null;

    const segType = (segInfo?.type && segInfo.type !== 'body') ? segInfo.type : 'chapter';
    chapterObj.type = segType;

    // Chapter title: prologue/epilogue → label («Пролог») always wins,
    // chapter → clean title («Земля»), plain body → null (no forced structure).
    if (segInfo?.label && segType !== 'chapter') {
        chapterObj.chapter_title = segInfo.label;
    } else if (chapterObj && !chapterObj.chapter_title) {
        if (segInfo?.title) {
            chapterObj.chapter_title = segInfo.title;
        } else if (chapterTitle) {
            chapterObj.chapter_title = chapterTitle;
        }
    }

    // ── Typography intro metadata from the segment ──
    // buildSegmentIntro returns null for body/poem — unstructured text gets
    // NO "Глава 1" title card (find what exists, don't force a structure).
    if (!chapterObj.intro) {
        const introData = chapterUtils.buildSegmentIntro(
            segInfo || (chapterTitle ? { type: 'chapter', title: chapterTitle } : null),
            language
        );
        if (introData) {
            chapterObj.intro = introData;
        }
    }

    // ── Create programmatic chapter_intro scene ──
    const introMeta = chapterObj.intro;
    if (introMeta && introMeta.text) {
        const existingIntro = chapterObj.scenes.find(s => s.type === 'chapter_intro');
        if (!existingIntro) {
            const introScene = {
                scene_id: sceneId(),
                scene_title: introMeta.scene_title || `Глава ${(chapterIndex || 0) + 1}`,
                type: 'chapter_intro',
                style: introMeta.style || 'soviet_book_page',
                audio: {
                    voice: 'narrator',
                    full_text: introMeta.text,
                },
                units: [{
                    id: unitId(),
                    type: 'typography',
                    text: introMeta.text,
                    image: {
                        shot: 'wide',
                        prompt: `Chapter ${(chapterIndex || 0) + 1} title page typography, book style`,
                    },
                }],
            };
            chapterObj.scenes.unshift(introScene);
        }
    }

    // ── AI narrative scenes ──
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
                audio: u.audio || undefined,
                image: u.image || undefined,
                video: u.video || undefined,
                source_start: u.source_start ?? undefined,
                source_end: u.source_end ?? undefined,
            }));

        const cleanUnits = sceneUnits.length > 0 ? sceneUnits : [{
            id: unitId(),
            type: 'perception',
            text: sceneText,
        }];

        const isDialogue = cleanUnits.some(u => u.type === 'dialogue' || u.type === 'dialectic');

        const allParticipants = [];
        const sceneParticipants = aiScene.characters_present || aiScene.participants || [];
        for (const p of sceneParticipants) {
            if (!allParticipants.includes(p)) allParticipants.push(p);
        }

        // Supplement participants from unit visual prompts (they contain character_ids)
        // Always run this — the AI may return partial characters_present, and visual
        // prompts often reference characters the scene-step AI forgot to list.
        if (mergedCharacters.length > 0) {
            const visualPrompts = (aiScene.units || [])
                .map(u => u.image?.prompt || '')
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            if (visualPrompts.length > 0) {
                const before = allParticipants.length;
                for (const ch of mergedCharacters) {
                    const chId = (ch.id || '').toLowerCase();
                    if (!chId || chId.length < 3) continue;
                    // Token-based matching: split character ID by underscores,
                    // check if ALL meaningful tokens appear in the visual prompts.
                    // This handles cases where visual prompts use longer IDs
                    // (e.g. "mikhail_alexandrovich_berlioz") while characters.json
                    // has a shorter ID (e.g. "mikhail_berlioz").
                    // This is safe because character IDs are unique identifiers,
                    // not common words — false positives are extremely unlikely.
                    const tokens = chId.split('_').filter(t => t.length >= 3);
                    if (tokens.length === 0) continue;
                    const allTokensFound = tokens.every(t => visualPrompts.includes(t));
                    if (allTokensFound) {
                        if (!allParticipants.includes(ch.id)) allParticipants.push(ch.id);
                    }
                }
                if (allParticipants.length > before) {
                    console.log(`[LAZY-BOOK] Visual prompts added ${allParticipants.length - before} more participants for scene "${(aiScene.title || '').slice(0, 40)}"`);
                }
            }
        }

        // unit.participants removed — participants come from scene-level only

        const sceneStyle = aiScene.type === 'chapter_intro' || cleanUnits.some(u => u.type === 'typography')
            ? 'soviet_book_page'
            : undefined;

        // Build audio config based on scene type.
        // For dialogue scenes: voice='dialogue', full_text=original literary text (with —).
        // The TTS script (speaker:text) is built at generation time by buildSegments()
        // from units that have type='dialogue' and speaker field.
        // For narration scenes: voice='narrator', full_text=raw scene text.
        const hasDialogueWithSpeaker = isDialogue && cleanUnits.some(u => u.type === 'dialogue' && u.audio?.speaker);
        if (hasDialogueWithSpeaker) {
            audioConfig = {
                voice: 'dialogue',
                full_text: sceneText,
            };
            const dialogueCount = cleanUnits.filter(u => u.type === 'dialogue').length;
            const withSpeakerCount = cleanUnits.filter(u => u.type === 'dialogue' && u.audio?.speaker).length;
            if (withSpeakerCount < dialogueCount) {
                console.warn(`[LAZY-BOOK] Scene "${aiScene.title}": ${dialogueCount - withSpeakerCount}/${dialogueCount} dialogue units missing speaker`);
            }
        } else if (isDialogue) {
            console.warn(`[LAZY-BOOK] Scene "${aiScene.title}" marked as dialogue but has no units with speaker — falling back to narrator voice`);
            audioConfig = {
                voice: 'narrator',
                full_text: sceneText,
            };
        } else {
            audioConfig = {
                voice: 'narrator',
                full_text: sceneText,
            };
        }

        chapterObj.scenes.push({
            scene_id: scId,
            scene_title: aiScene.title || chapterUtils.extractSceneTitle(aiScene.text || '', chapterObj.scenes.length),
            type: isDialogue ? 'dialogue' : 'narration',
            style: sceneStyle,
            participants: allParticipants,
            location: aiScene.location || undefined,
            source_start: aiScene.source_start ?? null,
            source_end: aiScene.source_end ?? null,
            audio: audioConfig,
            units: cleanUnits,
        });
    }

    if (chapterObj.scenes.length === 0) {
        throw new Error('No valid scenes created from AI analysis');
    }

    fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chapterObj, null, 2));

    // chapters_order must reflect the READING order (cover, prologue index 0,
    // chapters 1..N), NOT the filename order — hex chapter IDs are random.
    // Sort by chapter_index: cover first (no index), then by index ascending.
    const chapterSortKey = (f) => {
        try {
            const ch = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
            if (ch.type === 'cover') return -1;
            return ch.chapter_index ?? Number.MAX_SAFE_INTEGER;
        } catch (_) { return Number.MAX_SAFE_INTEGER; }
    };
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json'))
        .sort((a, b) => chapterSortKey(a) - chapterSortKey(b));
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    const bookState = isFirstWindow ? BookState.BOOTSTRAPPED : BookState.BOOTSTRAPPED;
    draft.updateBookState(bookId, bookState);

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
    createFromAnalysis,
    appendToBook,
    createOrAppendScenes,
};

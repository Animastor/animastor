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

function createOrAppendScenes(bookId, analysis, windowConfig) {
    const d = draft.loadDraftBook(bookId);
    if (!d) throw new Error(`Book ${bookId} not found`);
    if (!d.sourceText) throw new Error(`Book ${bookId} has no source text`);

    const { sourceText, book: bookMeta } = d;
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

        const rawAppearance = ch.appearance || ch.description || null;

        let appearanceDesc;
        if (!rawAppearance || /не опис|no descr|unknown|unclear/i.test(rawAppearance)) {
            appearanceDesc = `${ch.name}: a character from the story, seen in period-appropriate clothing, with distinctive features as described in the narrative context`;
        } else {
            appearanceDesc = rawAppearance;
        }

        const baseMatch = appearanceDesc.match(/^[^.!?]+[.!?]?/);
        const baseAppearance = baseMatch ? baseMatch[0].trim() : appearanceDesc;
        const detailedAppearance = appearanceDesc;

        const videoTokens = appearance.fragmentAppearanceForVideo(appearanceDesc, ch.name);

        const { clothingBase, clothingDetails } = appearance.extractClothing(appearanceDesc);

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

    let locations = { ...existingLocations };
    for (const loc of (analysis.locations || [])) {
        const locId = loc.id || loc.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!locations[locId]) {
            locations[locId] = {
                description: loc.description || `${loc.name} — location from the source text`,
                cinematic_space: loc.name,
            };
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
        const appearanceText = p.base_appearance || p.detailed_appearance || '';
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
    const voices = { narrator: { instruction: narratorVoice } };
    for (const ch of mergedCharacters) {
        if (ch.voice?.instruction) {
            voices[ch.id] = { instruction: ch.voice.instruction };
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
        const coverChapter = chapterUtils.createCoverChapter(coverTitle, coverAuthor, language);
        chapterUtils.saveCoverChapter(bookId, coverChapter);
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

    // ── Build chapter title with full name ──
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

    // ── Create chapter_intro metadata ──
    if (!chapterObj.intro) {
        let introData = null;

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
                visual: u.visual || undefined,
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
                .map(u => u.visual?.prompt || '')
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
        const hasDialogueWithSpeaker = isDialogue && cleanUnits.some(u => u.type === 'dialogue' && u.speaker);
        if (hasDialogueWithSpeaker) {
            audioConfig = {
                voice: 'dialogue',
                full_text: sceneText,
            };
            const dialogueCount = cleanUnits.filter(u => u.type === 'dialogue').length;
            const withSpeakerCount = cleanUnits.filter(u => u.type === 'dialogue' && u.speaker).length;
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

    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
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

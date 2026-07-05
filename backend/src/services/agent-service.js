// ======================================================
// Agent Service - Barrel Index
// ======================================================
// Re-exports all agent sub-modules for backward compatibility.
// Split from the original monolithic agent-service.js.
//
// Sub-modules (services/agent/):
//   ai-caller.js      - callAI, logConversation
//   text-utils.js     - stripStructureFromText, splitIntoSentences, buildFallbackScenes, splitTextEvenlyByParagraphs, splitIntoSentencesWithOffsets
//   scene-title-utils  - extractSceneTitle, isGenericSceneTitle (shared via utils/scene-title-utils.js)
//   visual-utils.js   - getFallbackVisual, buildVisualExemplars, formatExamplesForPrompt
//   coreference.js    - assignUnitParticipants
//   pipeline-steps.js - stepAnalyzeStructure, stepExtractCharacters, stepExtractLocations, stepCreateScenes, stepEnrichScenes, stepCreateUnits, stepCreateVisuals
//   pipeline-runner.js - getWindowText, resolveSceneProgress, runPipeline
//   bootstrap.js     - bootstrapWithAgent, bootstrapNextWindow

const { createSession, updateSession, getSession } = require('./agent-session');
const { loadKnowledgeBase } = require('./knowledge-base');
const { PROGRESS_STAGES, MAX_WINDOW_CHARS, SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK } = require('./agent-prompts');
const textUtils = require('./agent/text-utils');
const visualUtils = require('./agent/visual-utils');

const bootstrap = require('./agent/bootstrap');
const { extractSceneTitle, isGenericSceneTitle } = require('../utils/scene-title-utils');

module.exports = {
    // Re-exports from agent-session
    createSession,
    updateSession,
    getSession,

    // Re-exports from knowledge-base
    loadKnowledgeBase,

    // Bootstrap functions (used by txt-importer)
    bootstrapWithAgent: bootstrap.bootstrapWithAgent,
    bootstrapNextWindow: bootstrap.bootstrapNextWindow,

    // Constants (used by txt-importer, book-routes, etc.)
    PROGRESS_STAGES,
    MAX_WINDOW_CHARS,
    SCENE_TARGET_SEC,
    SCENE_MAX_SEC,
    SCENE_MIN_SEC,
    MAX_SCENES_PER_CHUNK,

    // Text utilities (exported for unit testing)
    splitIntoSentences: textUtils.splitIntoSentences,
    splitIntoSentencesWithOffsets: textUtils.splitIntoSentencesWithOffsets,
    buildFallbackScenes: textUtils.buildFallbackScenes,
    splitTextEvenlyByParagraphs: textUtils.splitTextEvenlyByParagraphs,
    extractSceneTitle,
    isGenericSceneTitle,
    resolveSceneProgress: require('./agent/pipeline-runner').resolveSceneProgress,
    // Visual utilities (exported for unit testing)
    buildVisualExemplars: visualUtils.buildVisualExemplars,
    getFallbackVisual: visualUtils.getFallbackVisual,

};

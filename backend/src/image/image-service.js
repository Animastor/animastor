// ======================================================
// Image Service - Barrel Index
// ======================================================
// Re-exports all image sub-modules for backward compatibility.
// Split from the original monolithic image-service.js.
//
// Sub-modules:
//   helpers.js         - log, warn, error, debug, getOutputPath, cleanJoin, normalization utilities
//   connector-utils.js - getImageNodeId, applyImageValue, WORKFLOW_NAME
//   registry.js        - saveIURegistry, getIURegistry, probeIUImage, resolveCanonicalSceneImage, collectSceneUnits
//   character-utils.js - normalizeCharacterRefs, buildCharacterAliases, buildSafeAliasIndex
//   prompt-builder.js  - buildImagePrompt, buildIUImageWorkflow, generateIUImageWorkflow, resolveVisualStyle, resolveLocationFromPrompt, buildCharacters
//   iu-processor.js    - processSingleIU, generateSceneIUImages, saveIUMetadata, getSceneDuration
//   preview.js         - getOrCreatePreview, getImageMetadata

const helpers = require('./helpers');
const connectorUtils = require('./connector-utils');
const registry = require('./registry');
const charUtils = require('./character-utils');
const promptBuilder = require('./prompt-builder');
const iuProcessor = require('./iu-processor');
const preview = require('./preview');

module.exports = {
    // helpers
    getOutputPath: helpers.getOutputPath,
    getImageMetadata: preview.getImageMetadata,
    isTypographyStyle: helpers.isTypographyStyle,
    resolveLocationFromPrompt: promptBuilder.resolveLocationFromPrompt,
    resolveNegativePrompt: promptBuilder.resolveNegativePrompt,

    // connector-utils
    getImageNodeId: connectorUtils.getImageNodeId,
    applyImageValue: connectorUtils.applyImageValue,
    WORKFLOW_NAME: connectorUtils.WORKFLOW_NAME,

    // registry
    saveIURegistry: registry.saveIURegistry,
    getIURegistry: registry.getIURegistry,
    probeIUImage: registry.probeIUImage,
    resolveCanonicalSceneImage: registry.resolveCanonicalSceneImage,
    collectSceneUnits: registry.collectSceneUnits,

    // prompt-builder
    buildIUImageWorkflow: promptBuilder.buildIUImageWorkflow,
    buildImagePrompt: promptBuilder.buildImagePrompt,
    generateIUImageWorkflow: promptBuilder.generateIUImageWorkflow,
    resolveVisualStyle: promptBuilder.resolveVisualStyle,
    buildCharacters: promptBuilder.buildCharacters,

    // iu-processor
    generateSceneIUImages: iuProcessor.generateSceneIUImages,
    processSingleIU: iuProcessor.processSingleIU,
    saveIUMetadata: iuProcessor.saveIUMetadata,
    getSceneDuration: iuProcessor.getSceneDuration,

    // preview
    getOrCreatePreview: preview.getOrCreatePreview,

    // character-utils (normalizeCharacterRefs is imported by agent-service.js)
    normalizeCharacterRefs: charUtils.normalizeCharacterRefs,
    buildSafeAliasIndex: charUtils.buildSafeAliasIndex,
};

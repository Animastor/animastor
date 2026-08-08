// ======================================================
// Audio Service - Barrel Index
// ======================================================
// Re-exports all audio sub-modules for backward compatibility.
// Split from the original monolithic audio-service.js.
//
// Sub-modules:
//   helpers.js        - getOutputPath, log, warn, error, escapeRegExp
//   connector-utils.js - isFFmpegAvailable, applyAudioValue, getAudioNodeId
//   ffmpeg.js         - runFFmpegMerge, runFFmpegTrim, probeDuration, cutFirstHalf, findQuietestPoint
//   validation.js     - validateCanonicalAudio, isSceneAudioReady, getAudioDuration
//   chunks.js         - findExistingSceneChunks, allSceneChunksExist, areSceneAudioChunksReady, makeChunkId, getChunkAudioPath
//   segments.js       - splitTextIntoChunks, splitDialogueIntoChunks, narratorVoice, padShortText, buildSegments
//   pipeline.js       - buildSceneAudio, createConcatFile, mergeSceneAudioChunks, recoverSceneAudioFromChunks
//   generation.js     - generateSceneAudio, mergeBookAudio, trimPaddedSceneAudio
//   silence.js        - generateSilentAudio, writeSilentMP3Node

const helpers = require('./helpers');
const connectorUtils = require('./connector-utils');
const ffmpeg = require('./ffmpeg');
const validation = require('./validation');
const chunks = require('./chunks');
const segments = require('./segments');
const pipeline = require('./pipeline');
const generation = require('./generation');
const silence = require('./silence');

module.exports = {
    // helpers
    getOutputPath: helpers.getOutputPath,
    escapeRegExp: helpers.escapeRegExp,

    // connector-utils
    isFFmpegAvailable: connectorUtils.isFFmpegAvailable,
    applyAudioValue: connectorUtils.applyAudioValue,
    getAudioNodeId: connectorUtils.getAudioNodeId,
    audioProfileNameFromConnector: connectorUtils.audioProfileNameFromConnector,

    // ffmpeg
    runFFmpegMerge: ffmpeg.runFFmpegMerge,
    runFFmpegTrim: ffmpeg.runFFmpegTrim,
    probeDuration: ffmpeg.probeDuration,
    cutFirstHalf: ffmpeg.cutFirstHalf,
    findQuietestPoint: ffmpeg.findQuietestPoint,

    // validation
    validateCanonicalAudio: validation.validateCanonicalAudio,
    isSceneAudioReady: validation.isSceneAudioReady,
    getAudioDuration: validation.getAudioDuration,

    // chunks
    findExistingSceneChunks: chunks.findExistingSceneChunks,
    allSceneChunksExist: chunks.allSceneChunksExist,
    areSceneAudioChunksReady: chunks.areSceneAudioChunksReady,
    makeChunkId: chunks.makeChunkId,
    getChunkAudioPath: chunks.getChunkAudioPath,

    // segments
    splitTextIntoChunks: segments.splitTextIntoChunks,
    splitDialogueIntoChunks: segments.splitDialogueIntoChunks,
    narratorVoice: segments.narratorVoice,
    padShortText: segments.padShortText,
    buildSegments: segments.buildSegments,

    // pipeline
    createConcatFile: pipeline.createConcatFile,
    buildSceneAudio: pipeline.buildSceneAudio,
    mergeSceneAudioChunks: pipeline.mergeSceneAudioChunks,
    recoverSceneAudioFromChunks: pipeline.recoverSceneAudioFromChunks,

    // generation
    generateSceneAudio: generation.generateSceneAudio,
    mergeBookAudio: generation.mergeBookAudio,
    trimPaddedSceneAudio: generation.trimPaddedSceneAudio,
    WORKFLOW_NARRATION: generation.WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE: generation.WORKFLOW_DIALOGUE,

    // silence
    generateSilentAudio: silence.generateSilentAudio,
    writeSilentMP3Node: silence.writeSilentMP3Node,
};

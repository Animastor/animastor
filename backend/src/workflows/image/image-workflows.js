// ======================================================
// Image Workflows - v1.1.0 (Connector-aware)
// ======================================================
// Workflow builders for image generation.
// Uses connector system to resolve nodeIds.

const imageService = require('../../image/image-service');
const wfLoader = require('../workflow-loader');

const WORKFLOW_NAME = 'img-qwen-image';

// ======================================================
// IMAGE WORKFLOW TEMPLATES
// ======================================================

/**
 * Image workflow builder for ComfyUI img-qwen-image.
 * Uses connector to resolve nodeIds instead of hardcoded "108"/"109".
 */
function buildImageWorkflow(prompt, negativePrompt) {
    const workflow = {};

    const connector = wfLoader.getConnector(WORKFLOW_NAME);
    if (connector) {
        const cl = require('../connector-loader');

        // Build a minimal workflow with just the prompt nodes
        // Set prompt on the node that the connector specifies
        const promptNodeId = cl.getNodeId(connector, 'positivePrompt');
        if (promptNodeId) {
            workflow[promptNodeId] = {
                inputs: { text: prompt }
            };
        }

        const negNodeId = cl.getNodeId(connector, 'negativePrompt');
        if (negNodeId) {
            workflow[negNodeId] = {
                inputs: { text: negativePrompt || "blurry, low quality, artifacts" }
            };
        }
    } else {
        // Legacy fallback
        workflow["108"] = {
            inputs: { text: prompt }
        };
        workflow["109"] = {
            inputs: { text: negativePrompt || "blurry, low quality, artifacts" }
        };
    }

    return workflow;
}

/**
 * Build image prompt from scene and IU payload.
 * Delegates to image-service.js for full prompt composition.
 */
function buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload) {
    return imageService.buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload);
}

/**
 * Build negative prompt for image generation.
 */
function buildNegativePrompt(customNegative = '') {
    const baseNegative = 'blurry, low quality, artifacts';
    return customNegative ? `${customNegative}, ${baseNegative}` : baseNegative;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    buildImageWorkflow,
    buildImagePrompt,
    buildNegativePrompt
};

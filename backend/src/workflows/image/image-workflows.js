// ======================================================
// Image Workflows - v1.0.0
// ======================================================
// Workflow builders for image generation.
// Uses image-service.js for prompt building.

const imageService = require('../../image/image-service');

// ======================================================
// IMAGE WORKFLOW TEMPLATES
// ======================================================

/**
 * Image workflow builder for ComfyUI img-qwen-image.
 */
function buildImageWorkflow(prompt, negativePrompt) {
    const workflow = {
        "108": {
            inputs: {
                text: prompt
            }
        },
        "109": {
            inputs: {
                text: negativePrompt || "blurry, low quality, artifacts"
            }
        }
    };
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

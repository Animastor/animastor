// ======================================================
// Audio Workflows - v1.1.0 (Connector-aware)
// ======================================================
// Workflow builders for audio generation (TTS).
// Uses connector system to resolve nodeIds.

const wfLoader = require('../workflow-loader');

const logPrefix = '[WORKFLOW:AUDIO]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

/**
 * Build workflow node using connector for narration.
 */
function buildNarrationNode(connector, field) {
    if (connector) {
        const cl = require('../connector-loader');
        const nodeId = cl.getNodeId(connector, field);
        return nodeId ? { nodeId, field } : null;
    }
    return null;
}

/**
 * Build narration TTS workflow using connector.
 */
function buildNarrationTTSWorkflow(text, voiceInstruction) {
    const connector = wfLoader.getConnector(WORKFLOW_NARRATION);
    const workflow = {};

    if (connector) {
        const cl = require('../connector-loader');
        const nodeId = cl.getNodeId(connector, 'narrationText');
        if (nodeId) {
            workflow[nodeId] = {
                inputs: {
                    text: text,
                    voice_instruction: voiceInstruction
                }
            };
        }
    }

    return workflow;
}

/**
 * Build dialogue TTS workflow using connector.
 */
function buildDialogueTTSWorkflow(script, c1Voice, c2Voice, c1Role, c2Role) {
    const connector = wfLoader.getConnector(WORKFLOW_DIALOGUE);
    const workflow = {};

    if (connector) {
        const cl = require('../connector-loader');

        const scriptNodeId = cl.getNodeId(connector, 'dialogueScript');
        if (scriptNodeId) {
            workflow[scriptNodeId] = {
                inputs: {
                    script: script,
                    default_instruct: ""
                }
            };
        }

        const c1VoiceNodeId = cl.getNodeId(connector, 'character1Voice');
        if (c1VoiceNodeId) {
            workflow[c1VoiceNodeId] = {
                inputs: {
                    voice_instruction: c1Voice || ""
                }
            };
        }

        const c2VoiceNodeId = cl.getNodeId(connector, 'character2Voice');
        if (c2VoiceNodeId) {
            workflow[c2VoiceNodeId] = {
                inputs: {
                    voice_instruction: c2Voice || ""
                }
            };
        }

        const roleNodeId = cl.getNodeId(connector, 'roleName1');
        // roleName1 and roleName2 are on the same node (Qwen3TTSRoleBank)
        if (roleNodeId) {
            // For multi-field on same node, we need to handle carefully
            workflow[roleNodeId] = {
                inputs: {
                    role_name_1: c1Role || "role1",
                    role_name_2: c2Role || "role2"
                }
            };
        }
    }

    return workflow;
}

// ======================================================
// VOICE INSTRUCTION BUILDERS
// ======================================================

function buildNarratorVoice(scene, book) {
    const globalRender = book?.manifest?.render;
    const narration = globalRender?.narration;

    if (narration?.voice?.instruction) {
        return narration.voice.instruction;
    }

    const sceneType = scene?.type || 'narration';
    const location = scene?.location || '';

    let instruction = `Narration voice for ${sceneType}`;

    if (location) {
        instruction += `, scene location: ${location}`;
    }

    return instruction;
}

function buildNarratorVoiceFromScene(scene, book) {
    return buildNarratorVoice(scene, book);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    audioWorkflowTemplates: {
        buildNarrationTTSWorkflow,
        buildDialogueTTSWorkflow
    },
    buildNarratorVoice,
    buildNarratorVoiceFromScene
};

// ======================================================
// Audio Workflows - v1.0.0
// ======================================================
// Workflow builders for audio generation (TTS).
// Does NOT know orchestrator or state machine.

const logPrefix = '[WORKFLOW:AUDIO]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// AUDIO WORKFLOW TEMPLATES
// ======================================================

/**
 * Audio workflow builders for TTS generation.
 * Returns a copy of the base workflow with filled inputs.
 */
const audioWorkflowTemplates = {
    /**
     * Build narration TTS workflow.
     */
    buildNarrationTTSWorkflow: (text, voiceInstruction) => {
        const workflow = {
            "108": {
                inputs: {
                    text: text,
                    voice_instruction: voiceInstruction
                }
            }
        };
        return workflow;
    },

    /**
     * Build dialogue TTS workflow.
     */
    buildDialogueTTSWorkflow: (script, c1Voice, c2Voice, c1Role, c2Role) => {
        const workflow = {
            "108": {
                inputs: {
                    script: script,
                    default_instruct: ""
                }
            },
            "71": {
                inputs: {
                    voice_instruction: c1Voice || ""
                }
            },
            "80": {
                inputs: {
                    voice_instruction: c2Voice || ""
                }
            },
            "74": {
                inputs: {
                    role_name_1: c1Role || "role1",
                    role_name_2: c2Role || "role2"
                }
            }
        };
        return workflow;
    }
};

// ======================================================
// VOICE INSTRUCTION BUILDERS
// ======================================================

/**
 * Build voice instruction for narrator voice.
 */
function buildNarratorVoice(scene, book) {
    // Get global narration settings if available
    const globalRender = book?.manifest?.render;
    const narration = globalRender?.narration;

    if (narration?.voice?.instruction) {
        return narration.voice.instruction;
    }

    // Default settings based on scene type
    const sceneType = scene?.type || 'narration';
    const location = scene?.location || '';

    let instruction = `Narration voice for ${sceneType}`;

    if (location) {
        instruction += `, scene location: ${location}`;
    }

    return instruction;
}

/**
 * Build narrator voice instruction from scene data.
 * This is a simpler version - the actual voice instruction
 * should be configured in book manifest or scene metadata.
 */
function buildNarratorVoiceFromScene(scene, book) {
    return buildNarratorVoice(scene, book);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    audioWorkflowTemplates,
    buildNarratorVoice,
    buildNarratorVoiceFromScene
};

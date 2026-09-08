// ======================================================
// @animastor/ai-analysis — AI Analysis Layer
// ======================================================
// The semantic analysis layer: all AI analysis tasks and authoring
// operations. Uses @animastor/ai-agent for the execution mechanism
// (fail-closed ports, callAI seam pattern).
//
// Dependency direction (enforced):
//   host/backend → ai-analysis → ai-agent
//
// This module owns:
//   - Structure analysis (F1/F6) — services/structure-analyzer (C19)
//   - Character extraction (F2)  — services/character-analyzer (C20)
//   - Voice authoring (F7)       — services/character-analyzer/voices (C20)
//   - Location extraction (F3)   — tasks/locations.js
//   - Scene analysis (F4)        — tasks/scenes.js
//   - Unit analysis (F5)         — tasks/units.js
//   - Shared context builder     — context.js
//
// This module does NOT own:
//   - Execution mechanism (ports, fail-closed validation) → ai-agent
//   - Orchestration / pipeline / persistence → host
//   - Generation (TTS/audio/image/video) → host / generation modules
//   - Prompt assets (ai/rules/*.md) → host filesystem
//
// C19/C20 modules remain physically in backend/src/services/ and are
// re-exported here so the host has one analysis surface.

const { assertHostPorts } = require('@animastor/ai-agent');

// Analysis tasks — local to this package
const { extractLocations } = require('./tasks/locations');
const { createScenes, normalizeSceneEnvironment } = require('./tasks/scenes');
const { createUnits } = require('./tasks/units');
const { buildLocationsContext } = require('./context');

// C19/C20 analyzer modules — physically in backend/src/services/,
// re-exported through this analysis seam so the host wires ALL analysis
// through ONE contour. These modules follow the same port-injection
// pattern and are compositionally part of the analysis layer.
const { analyzeBookStructure } = require('../../../backend/src/services/structure-analyzer');
const { extractCharacters, generateVoices } = require('../../../backend/src/services/character-analyzer');

module.exports = {
    // shared execution mechanism (re-exported from ai-agent for convenience)
    assertHostPorts,
    // shared pure prompt-context builder
    buildLocationsContext,
    // Structure / Chapter analysis (C19 module — F1/F6)
    analyzeBookStructure,
    analyzeStructure: analyzeBookStructure,
    // Character extraction (C20 module — F2)
    extractCharacters,
    // Voice description authoring (C20 module — F7; NOT TTS generation)
    generateVoices,
    // Location extraction (F3)
    extractLocations,
    // Scene analysis (F4)
    createScenes,
    normalizeSceneEnvironment,
    // Unit analysis (F5)
    createUnits,
};

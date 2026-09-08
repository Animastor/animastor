// ======================================================
// AI Agent / AI Analysis — contour seam (C21)
// ======================================================
// The shared execution boundary for all AI ANALYSIS tasks of the import
// pipeline. The mechanism every task follows is the same:
//
//   task → prompt/rules/skills/examples → callAI → structured JSON → result
//
// with fail-closed host ports (see ./ports.js) and per-task degradation
// semantics. This module owns the mechanism and the task operations; the
// host owns orchestration (pipeline-runner / parallel-analysis-orchestrator),
// merge logic, persistence (window_data PG + Book Writer) and generation.
//
// Tasks reachable through this seam (each keeps its own prompt, rules,
// skills/examples, input contract and output JSON contract — C21 §4):
//
//   analyzeStructure   → Structure / Chapter analysis (F1/F6)
//                        physical home: services/structure-analyzer (C19)
//   extractCharacters  → Character extraction (F2)
//                        physical home: services/character-analyzer (C20)
//   generateVoices     → Voice DESCRIPTION authoring (F7) — analysis of
//                        dialogue into TTS voice instructions. NOT audio
//                        generation: no TTS/audio rendering happens here
//                        (that belongs to the future Audio/TTS Generation
//                        module). Physical home: character-analyzer/voices.
//   extractLocations   → Location extraction (F3)        — this module
//   createScenes       → Scene analysis (F4)             — this module
//   createUnits        → Unit analysis (F5)              — this module
//
// Dependency boundary (C21 §3, pinned by guards):
//   - the LLM is reached ONLY through the injected `callAI` port;
//   - persistence/session/logging/prompts are host-injected ports;
//   - NO PG/Redis/HTTP/fs, NO Book Writer, NO Importer, NO provider SDKs,
//     NO Audio/Image/Video Generation inside this module;
//   - pure deterministic utils (snake-guard, vbook-runtime identity) may be
//     consumed — never duplicated.
//
// Replaceability: to replace one analysis task, replace its task file /
// physical module — the other tasks, the runner and generation are not
// touched. To add a new analysis task, add a task file + one host adapter;
// do not widen this seam for generation concerns.

const { assertHostPorts } = require('./ports');
const { buildLocationsContext } = require('./context');
const { extractLocations } = require('./tasks/locations');
const { createScenes } = require('./tasks/scenes');
const { createUnits } = require('./tasks/units');
// Already-extracted functional modules are part of the same contour; their
// operations are re-exported here so the host wires ALL analysis tasks
// through ONE seam (pipeline-steps adapters → ai-agent).
const { analyzeBookStructure } = require('../structure-analyzer');
const { extractCharacters, generateVoices } = require('../character-analyzer');

module.exports = {
    // shared execution mechanism
    assertHostPorts,
    // shared pure prompt-context builder (also consumed by host polish steps)
    buildLocationsContext,
    // Structure / Chapter analysis (C19 module — F1/F6)
    analyzeBookStructure,
    analyzeStructure: analyzeBookStructure,
    // Character extraction (C20 module — F2)
    extractCharacters,
    // Voice description authoring (C20 module — F7; NOT TTS generation)
    generateVoices,
    // Location extraction (this module — F3)
    extractLocations,
    // Scene analysis (this module — F4)
    createScenes,
    // Unit analysis (this module — F5)
    createUnits,
};

// ======================================================
// AI Agent / AI Analysis — backward-compatible barrel (C21 → C21.1)
// ======================================================
// Backward-compatible re-export barrel. The actual implementation now lives
// in two packages:
//
//   @animastor/ai-agent   — Core: fail-closed host port validation mechanism
//   @animastor/ai-analysis — Semantic: all analysis tasks + C19/C20 modules
//
// Dependency direction:
//   host/backend → ai-analysis → ai-agent
//
// This barrel delegates to the analysis package so existing host adapters
// (pipeline-steps.js) continue to work unchanged. New code should import
// directly from the appropriate package.
//
// Tasks reachable through this seam (each keeps its own prompt, rules,
// skills/examples, input contract and output JSON contract — C21 §4):
//
//   analyzeStructure   → Structure / Chapter analysis (F1/F6)
//   extractCharacters  → Character extraction (F2)
//   generateVoices     → Voice DESCRIPTION authoring (F7)
//   extractLocations   → Location extraction (F3)
//   createScenes       → Scene analysis (F4)
//   createUnits        → Unit analysis (F5)

const analysis = require('@animastor/ai-analysis');

module.exports = analysis;

// ======================================================
// @animastor/ai-agent — AI Agent Core
// ======================================================
// The shared execution mechanism for all AI analysis tasks:
//
//   task → callAI → structured JSON → validation/error/degradation lifecycle
//
// This package owns ONLY the mechanism — no domain knowledge, no persistence,
// no generation concerns. The AI Analysis layer
// (@animastor/ai-analysis) owns the semantic analysis tasks.
//
// Dependency boundary (enforced by architecture guards):
//   ✗ NO characters / locations / scenes / units / structure / voice
//   ✗ NO concrete analyzers / Book Writer / Importer
//   ✗ NO AI provider / callAI implementation / fetch
//   ✗ NO PG / Redis / fs
//   ✗ NO TTS / audio / image / video generation
//   ✓ Pure mechanism only (fail-closed port validation)

const { assertHostPorts } = require('./ports');

module.exports = {
    assertHostPorts,
};

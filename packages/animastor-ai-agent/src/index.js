// ======================================================
// @animastor/ai-agent — AI Agent Core
// ======================================================
// Generic AI execution engine: the shared mechanism for running ANY AI task
// through a standard lifecycle.
//
//   task → prompt/rules/skills/examples → callAI → structured JSON → result
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
//   ✓ Pure mechanism only (port validation + generic lifecycle)

const { assertHostPorts } = require('./ports');
const { execute } = require('./execute');

module.exports = {
    assertHostPorts,
    execute,
};

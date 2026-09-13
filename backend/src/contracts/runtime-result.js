// ======================================================
// Runtime Result Contract — Phase 5 seam (data layer) — FACADE
// ======================================================
// §32.30 physical extraction: the canonical implementation moved verbatim
// into the @animastor/contracts package (packages/animastor-contracts/src/
// runtime-result.js). This backend file is now a thin re-export facade kept
// so existing host imports (`require('.../contracts/runtime-result')`)
// do not break — same pattern as the job-schema Phase 9C facade. Do NOT add
// new behavior here — extend the contracts package instead.
//
// Stable shape of a runtime job/dispatch execution result, exchanged
// between runtime (producer) and orchestration (consumer).
//
// Layer position: `contracts/` sits BELOW orchestration and runtime.
// See docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md §3.1.
//
// Statuses are job-level and map 1:1 onto dispatch-engine finalization
// outcomes: success → completed, failure → failed, cancelled → cancelled.
// The runtime-internal outcome vocabulary never leaves the runtime layer.

'use strict';

module.exports = require('@animastor/contracts').runtimeResult;

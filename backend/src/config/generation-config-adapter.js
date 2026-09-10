// ======================================================
// HOST ADAPTER — GenerationConfig (S-6)
// ======================================================
// The ONLY module that translates host configuration into the Generation
// GenerationConfig port. runtime-config remains the canonical source of
// truth (S2-G consistency guards); this adapter binds the three capability
// slices VERBATIM (no value mapping — the port contract documents the
// canonical key names), so values cannot drift.
//
// Ownership: ports belong to Generation Core; adapters belong to the host.
// This file is host-side: it may read runtime-config and call the port
// setter — the REVERSE edge (generation → runtime-config) is what S-6
// removed and the S6-A guard now forbids.
//
// Wiring sites (composition roots):
//   - backend.cjs                      — production (before default-registrations loads)
//   - tests/generation-test-bindings.cjs — mocha fixture (same ordering)
//   - generation/default-registrations.js — lazy-bootstrap fallback (host-side
//     registration adapter; keeps the S-2 self-bootstrap order-independent)
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

const runtimeConfig = require('./runtime-config');
const { setGenerationConfig } = require('../generation/ports/generation-config');

/**
 * Bind the canonical runtime-config slices into the GenerationConfig port.
 * Idempotent — rebinding the same canonical slices is a no-op semantically.
 */
function bindGenerationConfig() {
    setGenerationConfig({
        leaseTtlS: runtimeConfig.LEASE_TTL_S,
        quotas: runtimeConfig.QUOTAS,
        stuckThresholds: runtimeConfig.STUCK_THRESHOLDS,
    });
}

module.exports = { bindGenerationConfig };

// ======================================================
// AI Analysis — shared pure prompt-context builders
// ======================================================
// Pure, deterministic formatting helpers shared by AI analysis tasks and
// (via the module seam) by host-side generation steps that embed the same
// registry context into their prompts. NO AI, NO I/O, NO host requires.
//
// Deliberately NOT owned by any single task file: several tasks and host
// steps consume it, and the "no cross-dependencies between AI tasks" rule
// (C21 §6) forbids task→task imports. The shared context layer is the
// sanctioned sharing point.

/**
 * Build the location context block for agent prompts.
 * Includes each location's GLOBAL environment template so the scene split step
 * can check the scene against it and write only per-scene overrides.
 */
function buildLocationsContext(locations) {
    return (locations || []).map(l => {
        const env = l.environment || {};
        const envParts = ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere']
            .filter(k => env[k])
            .map(k => `${k}: ${env[k]}`);
        const envStr = envParts.length > 0 ? ` (default environment: ${envParts.join(', ')})` : '';
        return `- ${l.id}: ${l.name || l.id} (${l.type || 'unknown'})${envStr}`;
    }).join('\n') || 'None';
}

module.exports = { buildLocationsContext };

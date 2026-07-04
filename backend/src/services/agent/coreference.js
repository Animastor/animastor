// ======================================================
// Agent Coreference Resolution
// ======================================================
// Assigns unit participants by validating character IDs from LLM output.

/**
 * Assign unit participants by validating character IDs directly from LLM output.
 * The LLM in stepCreateUnits returns participants for each unit.
 * This function validates that the returned character IDs exist in the known characters list.
 */
function assignUnitParticipants(units, characters, mentions) {
    if (!units || units.length === 0) return {};

    const knownIds = new Set((characters || []).map(c => c.id).filter(Boolean));
    const result = {};

    for (let ui = 0; ui < units.length; ui++) {
        const participants = units[ui]?.participants || [];
        if (participants.length === 0) continue;

        const resolved = [];
        for (const id of participants) {
            if (knownIds.has(id)) {
                resolved.push(id);
            } else if (mentions && mentions[id] && knownIds.has(mentions[id])) {
                resolved.push(mentions[id]);
            }
        }
        if (resolved.length > 0) {
            result[ui] = [...new Set(resolved)];
        }
    }

    return result;
}

module.exports = {
    assignUnitParticipants,
};

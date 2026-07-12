// Dry-run: builds the visuals-step system prompt (%CONTEXT% + rules) for the
// Patriarch Ponds sample scene, WITHOUT hitting the DB or the LLM. Verifies that
// the Imagination Unit doctrine and character passport data reach the model.
//
// Run: node backend/scripts/dryrun-visuals-iu.js
const { SYSTEM_PROMPTS } = require('../src/services/agent-prompts');

// --- The exact sample scene (from backend/ai/examples/ch-319c798a.json) ---
const scene = {
    title: 'Вечер на Патриарших',
    scene_title: 'Вечер на Патриарших',
    type: 'narration',
    location: { id: 'patriarch_ponds' },
    participants: ['berlioz', 'bezdomny'],
};
const characters = [
    { id: 'berlioz', name: 'Mikhail Berlioz', description: 'slim 1930s Moscow editor' },
    { id: 'bezdomny', name: 'Ivan Bezdomny', description: 'young poet' },
];
const units = [
    { text: 'Был жаркий весенний вечер в Москве.', type: 'perception' },
    { text: 'На Патриарших прудах на скамейке сидели двое: редактор Берлиоз и поэт Иван Бездомный.', type: 'perception' },
    { text: 'Они вели разговор о религии.', type: 'dialogue' },
];

// --- %CONTEXT% builder: byte-for-byte the logic now in stepCreateVisuals ---
function buildContext(scene, characters) {
    const locName = scene.location?.id || 'the scene';
    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, `Location (name to use in prompts): ${locName}`, ''];
    contextParts.push('Characters in scene (name them explicitly in every prompt — no pronouns):');
    let namedCount = 0;
    for (const pId of (scene.participants || [])) {
        const ch = (characters || []).find(c => c.id === pId);
        if (!ch) continue;
        contextParts.push(`- ${ch.id}: ${ch.name} — ${ch.description || ''}`);
        namedCount++;
    }
    if (scene.participants && scene.participants.length > 0 && namedCount === 0) {
        contextParts.push('(unknown characters)');
    }
    return contextParts.join('\n');
}

// --- getFallbackImage: byte-for-byte the logic now in agent-service ---
function getFallbackImage(text, characters, scene) {
    const participants = (scene.participants || []);
    const who = participants.length
        ? participants.map(pId => (characters || []).find(c => c.id === pId)?.id || pId).join(' and ')
        : ((characters || []).map(c => c.id).join(' and '));
    if (!who) return 'the scene at ' + (scene.location?.id || 'the scene') + ', cinematic shot';
    const locName = scene.location?.id || 'the scene';
    return `${who} at ${locName}, cinematic shot`;
}

// --- Real few-shot exemplar block, built from ai/examples (via the exported fn if
// the service module loads; otherwise skipped gracefully). ---
let exemplars = '';
try {
    ({ buildImageExemplars: exemplars } = require('../src/services/agent-service'));
    exemplars = typeof exemplars === 'function' ? exemplars() : '';
} catch (e) {
    console.warn('(note) could not load agent-service for exemplars:', e.message);
}

const contextStr = buildContext(scene, characters);
const unitsStr = units.map((u, i) => `Unit ${i + 1}: text="${(u.text || '').substring(0, 200)}", type="${u.type || 'perception'}"`).join('\n');
const finalPrompt = SYSTEM_PROMPTS.visuals
    .replace('%CONTEXT%', contextStr)
    .replace('%EXAMPLES%', exemplars || '')
    .replace('%UNITS%', unitsStr);

console.log('================ ASSEMBLED SYSTEM PROMPT ================\n');
console.log(finalPrompt);
console.log('\n================ FALLBACK PROMPTS (no LLM) ================\n');
for (const u of units) console.log('•', getFallbackImage(u.text, characters, scene));

// --- Assertions ---
console.log('\n================ ASSERTIONS ================');
const checks = [
    ['CONTEXT has location name', contextStr.includes('patriarch_ponds')],
    ['CONTEXT has berlioz', contextStr.includes('berlioz: Mikhail Berlioz')],
    ['CONTEXT has bezdomny', contextStr.includes('bezdomny: Ivan Bezdomny')],
    ['prompt bans generic nouns', finalPrompt.includes('generic collective nouns')],
    ['prompt has guiding question', finalPrompt.includes('WHO exactly is in the frame')],
    ['prompt has stable-extras rule', finalPrompt.includes('CONCRETE, REPEATABLE anchor')],
    ['fallback is pronoun-free & named', getFallbackImage('', characters, scene) === 'berlioz and bezdomny at patriarch_ponds, cinematic shot'],
    ['few-shot exemplar block injected', /Worked example/.test(finalPrompt)],
    ['image-first philosophy present', /Core philosophy/.test(finalPrompt) && /no participants/i.test(finalPrompt)],
    ['character-less unit guidance present', /Character-less units/.test(finalPrompt)],
    ['character rules scoped to when-people-present', /apply ONLY when the unit actually contains people/i.test(finalPrompt)],
    ['output format uses image section', finalPrompt.includes('"image"')],
    ['output format uses video section', finalPrompt.includes('"video"')],
    ['exemplar block is doctrine-clean (no pronouns/generic nouns)',
        !exemplars || !/\b(they|two men|the writers|crowd|pedestrians|one person)\b/i.test(exemplars)],
];
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); if (!pass) ok = false; }
console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);

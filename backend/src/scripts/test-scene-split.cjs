// ======================================================
// Test Scene Split — calls AI with scene splitting prompt
// Usage: cat prompt.txt | node src/scripts/test-scene-split.cjs
// ======================================================
// Reads stdin: the raw content of prompt.txt which contains:
// [Russian narrative text]\n\nПримени к этому тексту следующий промпт...\n\n[Scene Splitting prompt template with %PLACEHOLDERS%]
// Saves AI response to /tmp/ai-scene-split-response.md

const fs = require('fs');
const path = require('path');
const aiService = require('../services/ai-service');

// ── Read stdin ──────────────────────────────────────────
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

// ── Parse input ─────────────────────────────────────────
function parseInput(text) {
    // The delimiter is: "Примени к этому тексту следующий промпт, не используя контекста других чатов:"
    const delimiter = 'Примени к этому тексту следующий промпт, не используя контекста других чатов:';
    const idx = text.indexOf(delimiter);
    if (idx === -1) {
        throw new Error('Missing delimiter: "Примени к этому тексту следующий промпт, не используя контекста других чатов:"');
    }

    const beforeDelim = text.substring(0, idx).trim();
    const afterDelim = text.substring(idx + delimiter.length).trim();

    // The part before the delimiter may contain the user instruction line
    // "Примени к этому тексту следующий промпт, не используя контекста других чатов:"
    // The part after is the Scene Splitting prompt template

    // But the text before could have some user instructions too:
    // Let's check if there's still a marker left over
    const instructionLine = 'Примени к этому тексту следующий промпт, не используя контекста других чатов:';

    return {
        narrativeText: beforeDelim,
        promptTemplate: afterDelim,
    };
}

// ── Get characters from text ────────────────────────────
function extractKnownEntities(text) {
    const characters = [];
    const locations = [];

    // Known characters from Master and Margarita
    if (/берлиоз/i.test(text)) {
        characters.push({ id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз' });
        characters.push({ id: 'berlioz', name: 'Берлиоз' });
    }
    if (/бездомный/i.test(text) || /понырев/i.test(text)) {
        characters.push({ id: 'ivan_bezdomny', name: 'Иван Николаевич Понырев (Бездомный)' });
        characters.push({ id: 'bezdomny', name: 'Бездомный' });
    }
    if (/воланд|прозрачный гражданин|клетчатый/i.test(text)) {
        characters.push({ id: 'woland', name: 'Воланд' });
    }
    if (/женщина|продавщи/i.test(text)) {
        characters.push({ id: 'kiosk_woman', name: 'Женщина в будочке' });
    }

    // Known locations from Master and Margarita
    if (/патриарших|прудах/i.test(text)) {
        locations.push({ id: 'patriarch_ponds', name: 'Патриаршие пруды' });
    }
    if (/будочк|киоск/i.test(text)) {
        locations.push({ id: 'kiosk', name: 'Будочка «Пиво и воды»' });
    }
    if (/скамейк/i.test(text)) {
        locations.push({ id: 'bench', name: 'Скамейка у пруда' });
    }
    if (/бронн/i.test(text)) {
        locations.push({ id: 'bronnaya_street', name: 'Малая Бронная улица' });
    }
    if (/москв/i.test(text)) {
        locations.push({ id: 'moscow', name: 'Москва' });
    }

    return { characters, locations };
}

// ── Build example reference block ───────────────────────
function buildReferenceExamples() {
    return `
\`\`\`
Example scene (CORRECT):
title: "У киоска с пивом"
text: "— Дайте нарзану, — попросил Берлиоз. — Нарзану нету, — ответила женщина. — Пиво есть? — осведомился Бездомный. — Пиво привезут к вечеру, — ответила женщина."
type: "dialogue"
characters_present: ["mikhail_berlioz", "ivan_bezdomny", "kiosk_woman"]
location: { "id": "kiosk" }
\`\`\`

---
Example scene (CORRECT):
title: "Появление Воланда"
text: "И тут знойный воздух сгустился перед ним, и соткался из этого воздуха прозрачный гражданин престранного вида."
type: "narration"
characters_present: ["mikhail_berlioz", "woland"]
location: { "id": "patriarch_ponds" }
\`\`\`
`;
}

// ── Build characters block ──────────────────────────────
function buildCharactersBlock(characters) {
    if (characters.length === 0) return 'No known characters.';
    return characters.map(c =>
        `- character_id: ${c.id}\n  name: ${c.name}`
    ).join('\n\n');
}

// ── Build locations block ───────────────────────────────
function buildLocationsBlock(locations) {
    if (locations.length === 0) return 'No known locations.';
    return locations.map(l =>
        `- location_id: ${l.id}\n  name: ${l.name}`
    ).join('\n\n');
}

// ── Replace placeholders in prompt template ────────────
function fillPromptTemplate(template, knownEntities) {
    const maxScenes = 5;
    const referenceExamples = buildReferenceExamples();
    const charactersBlock = buildCharactersBlock(knownEntities.characters);
    const locationsBlock = buildLocationsBlock(knownEntities.locations);

    let result = template
        .replace(/%MAX_SCENES%/g, String(maxScenes))
        .replace(/%REFERENCE_EXAMPLES%/g, referenceExamples)
        .replace(/%EXISTING_CHARACTERS%/g, charactersBlock)
        .replace(/%EXISTING_LOCATIONS%/g, locationsBlock);

    return result;
}

// ── Main ─────────────────────────────────────────────────
async function main() {
    console.log('[TEST-SCENE-SPLIT] Reading stdin...');
    const input = await readStdin();
    console.log(`[TEST-SCENE-SPLIT] Read ${input.length} chars`);

    const { narrativeText, promptTemplate } = parseInput(input);
    console.log(`[TEST-SCENE-SPLIT] Narrative text: ${narrativeText.length} chars`);
    console.log(`[TEST-SCENE-SPLIT] Prompt template: ${promptTemplate.length} chars`);

    // Extract known entities from text
    const knownEntities = extractKnownEntities(narrativeText);
    console.log(`[TEST-SCENE-SPLIT] Known characters:`);
    knownEntities.characters.forEach(c => console.log(`  - ${c.id}: ${c.name}`));
    console.log(`[TEST-SCENE-SPLIT] Known locations:`);
    knownEntities.locations.forEach(l => console.log(`  - ${l.id}: ${l.name}`));

    // Fill prompt template
    const systemPrompt = fillPromptTemplate(promptTemplate, knownEntities);
    console.log(`[TEST-SCENE-SPLIT] System prompt: ${systemPrompt.length} chars`);

    // Log a snippet of what we're sending
    console.log(`[TEST-SCENE-SPLIT] System prompt preview (first 500 chars):`);
    console.log(systemPrompt.substring(0, 500));
    console.log(`...`);
    console.log(`[TEST-SCENE-SPLIT] User message preview (first 300 chars):`);
    console.log(narrativeText.substring(0, 300));
    console.log(`...`);

    // Call AI
    console.log('[TEST-SCENE-SPLIT] Calling AI...');
    const response = await aiService.callAI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: narrativeText },
    ], {
        timeout: 180000,
        maxTokens: 16384,
        temperature: 0.3,
    });

    console.log(`[TEST-SCENE-SPLIT] AI responded: ${response.content.length} chars`);
    console.log(`[TEST-SCENE-SPLIT] Finish reason: ${response.finishReason || 'N/A'}`);
    console.log(`[TEST-SCENE-SPLIT] Usage: ${JSON.stringify(response.usage || {})}`);

    // Save response
    const outputPath = '/tmp/ai-scene-split-response.md';
    const mdContent = `# AI Scene Split Response

## Metadata

- **Model**: ${process.env.OPENROUTER_MODEL || 'default'}
- **Timestamp**: ${new Date().toISOString()}
- **Narrative text**: ${narrativeText.length} chars
- **System prompt**: ${systemPrompt.length} chars
- **Response length**: ${response.content.length} chars
- **Finish reason**: ${response.finishReason || 'N/A'}
- **Usage tokens**: ${JSON.stringify(response.usage || {})}

---

## System Prompt (Scene Splitting)

\`\`\`
${systemPrompt}
\`\`\`

---

## User Message (Narrative Text)

\`\`\`
${narrativeText}
\`\`\`

---

## AI Response

\`\`\`json
${response.content}
\`\`\`

---

## Raw AI Response

\`\`\`
${response.content}
\`\`\`

## Known Characters Used

| ID | Name |
|----|------|
${knownEntities.characters.map(c => `| ${c.id} | ${c.name} |`).join('\n')}

## Known Locations Used

| ID | Name |
|----|------|
${knownEntities.locations.map(l => `| ${l.id} | ${l.name} |`).join('\n')}
`;

    fs.writeFileSync(outputPath, mdContent, 'utf-8');
    console.log(`[TEST-SCENE-SPLIT] Response saved to ${outputPath}`);
    console.log('');
    console.log('To copy to host:');
    console.log('  docker compose cp animastor-backend:/tmp/ai-scene-split-response.md ./docs/');
}

main().catch(err => {
    console.error('[TEST-SCENE-SPLIT] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});

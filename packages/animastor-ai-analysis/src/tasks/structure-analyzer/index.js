// ======================================================
// Structure Analyzer — C19 functional module boundary
// ======================================================
// AI analysis of book structure: chapters / segments / structural
// metadata (title, author, prologue/epilogue, parts, country, epoch).
//
// Frozen contract (C18 §6 F1):
//   analyzeBookStructure(input, ports) → StructureAnalysis
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Fail: → deterministic fallbackStructure — NEVER fails the import.
// The deterministic fallback is computed in onError using the injected detector.

const {
    extractCandidates,
    buildDeterministicMap,
    mapToStructureChapters,
} = require('../structure-detector-deterministic');
const { analyzeStructure } = require('./ai-merge');
const { execute } = require('@animastor/ai-agent');

function _buildFallback(input, detector) {
    const fallbackMap = detector.buildDeterministicMap(input.sourceText);
    return {
        author: fallbackMap.author?.text || null,
        title: fallbackMap.title?.text || null,
        has_prologue: fallbackMap.hasPrologue,
        has_epilogue: fallbackMap.hasEpilogue,
        parts: fallbackMap.parts || [],
        chapters: detector.mapToStructureChapters(fallbackMap),
        segments: fallbackMap.segments || [],
        country: null,
        epoch: null,
    };
}

const structureTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'analyzingStructureMessage', 'prompt', 'fillLang',
    ],
    taskName: 'structure-analyzer',
    stage: 'analyzing_structure',
    progressMessage: (ports) => ports.analyzingStructureMessage,
    stepType: 'analyze_structure',

    buildMessages(input, ports) {
        const detector = ports.detector || {
            extractCandidates,
            buildDeterministicMap,
            mapToStructureChapters,
        };
        const { candidates } = input.candidates
            ? { candidates: input.candidates }
            : detector.extractCandidates(input.sourceText);

        const headBlock = candidates
            .filter(c => c.inHeadBlock)
            .sort((a, b) => a.lineIndex - b.lineIndex)
            .slice(0, 15)
            .map(c => `${c.lineIndex + 1}: ${c.text}`)
            .join('\n');

        const candidatePayload = candidates
            .filter(c => c.keyword || c.headingLikelihood >= 0.3 || (c.inHeadBlock && c.standalone))
            .slice(0, 60)
            .map(c => ({
                id: c.id,
                line: c.text,
                next_paragraph: c.nextParagraphPreview || null,
            }));

        const userPrompt = [
            'Analyze the structure of this text. For each candidate line decide:',
            '- What are these short lines? Book title? Author? (for lines at the very top)',
            '- Prologue + its title? Chapter + its title? Part? Epilogue?',
            '- Or is it just an ordinary heading / narrative line (reject)?',
            'For the VERY FIRST line, answer explicitly: is there a person\'s full',
            'name (initials + surname, e.g. "С. А. Хабаров")? The first line may',
            'contain the title AND the author name without a separator — split',
            'them into title + author. A name INSIDE the title text ("Жизнь',
            'Хабарова") is part of the title, not an author.',
            'Find what ACTUALLY exists — do NOT invent a structure for a poem,',
            'a fragment, or a few sentences.',
            '',
            '## Head of the document',
            '```',
            headBlock || '(no head lines)',
            '```',
            '',
            '## Candidate lines (short standalone lines with the paragraph below)',
            '```json',
            JSON.stringify(candidatePayload, null, 1),
            '```',
        ].join('\n');

        return {
            messages: [
                { role: 'system', content: ports.fillLang(ports.prompt('structure'), input.language) },
                { role: 'user', content: userPrompt },
            ],
            options: { maxTokens: 4096 },
        };
    },

    normalize(result, input, _ports) {
        const detector = _ports.detector || {
            extractCandidates,
            buildDeterministicMap,
            mapToStructureChapters,
        };
        const map = analyzeStructure(input.sourceText, result);
        const structure = {
            author: map.author?.text || null,
            title: map.title?.text || null,
            has_prologue: map.hasPrologue,
            has_epilogue: map.hasEpilogue,
            parts: map.parts || [],
            chapters: detector.mapToStructureChapters(map),
            segments: map.segments || [],
            country: result.country || null,
            epoch: result.epoch || null,
        };
        console.log(`[AGENT] Step 0 (structure): title=${structure.title ? `«${structure.title}»` : '✗'}, author=${structure.author ? `«${structure.author}»` : '✗'}, ${structure.segments.length} segments (${structure.segments.map(s => s.type).join(',')})`);
        return structure;
    },

    onError(err, step, ports, input) {
        const detector = ports.detector || {
            extractCandidates,
            buildDeterministicMap,
            mapToStructureChapters,
        };
        console.error(`[AGENT] Step 0 (structure) FAILED: ${err.message} — using deterministic structure map`);
        return _buildFallback(input, detector);
    },
};

/**
 * Analyze the structure of a full book source text.
 * @param {object} input { sourceText, candidates?, language, sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep, completeStep, failStep, analyzingStructureMessage, prompt, fillLang, detector? }
 * @returns {Promise<object>} StructureAnalysis
 */
async function analyzeBookStructure(input, ports) {
    return execute(structureTask, input, ports);
}

module.exports = {
    analyzeBookStructure,
    analyzeStructure,
    mergeAiDecisions: require('./ai-merge').mergeAiDecisions,
    sanitizeStructure: require('./ai-merge').sanitizeStructure,
    extractCandidates,
    buildDeterministicMap,
    mapToStructureChapters,
    structureTask,
};

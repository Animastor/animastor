// ======================================================
// Structure Analyzer — C19 functional module boundary
// ======================================================
// AI analysis of book structure: chapters / segments / structural
// metadata (title, author, prologue/epilogue, parts, country, epoch).
//
// Frozen contract (docs/architecture/structure-analyzer-extraction-c19.md):
//
//   analyzeBookStructure(input, ports) → StructureAnalysis
//
//     input: {
//       sourceText: string,          // the exact source instance — segment
//                                    // offsets anchor into it (no
//                                    // trim/normalize/re-decode across the
//                                    // boundary, C17 risk 7)
//       candidates?: CandidateLine[], // optional pre-extracted candidates
//                                     // (re-derived when absent)
//       language: string,
//       sessionId, stepIndex, progress,   // session/progress = ports (C18 §6 F1)
//     }
//
//     output: { author, title, has_prologue, has_epilogue, parts[],
//               chapters: LegacyChapterDTO[], segments: ParserSegment[],
//               country, epoch }
//       — the structure shape consumed by the pipeline/windows/Book Writer
//         (C18 §6 F1 contract, unchanged).
//
//     fail: → deterministic fallbackStructure — NEVER fails the import
//             (C18 §6 F1 fail contract, unchanged).
//
// Ports (host-injected; no ambient access, no PG/Redis/fs inside):
//   callAI(messages, options) → parsed JSON — the single LLM seam
//     (ai-caller.callAI); provider context is threaded by the host.
//   logConversation(sessionId, stepId, messages, response) — conversation log.
//   updateSession / createStep / completeStep / failStep — session & step
//     persistence (agent-session impls passed by the host adapter).
//   analyzingStructureMessage — user-facing progress message (PROGRESS_STAGES).
//   prompt(name) → string — prompt source (SYSTEM_PROMPTS.structure).
//   fillLang(template, language) → string — language placeholder fill.
//   detector? — deterministic detector override (extractCandidates /
//     buildDeterministicMap / mapToStructureChapters); defaults to the host
//     parser adapter (structure-detector-deterministic.js). A replacement
//     implementation can inject its own deterministic backbone here.
//
// Replaceability (C19 §12): to replace the Structure Analysis algorithm,
// replace THIS module (or inject ports.callAI + ports.detector) — without
// touching Character/Location/Scene analysis, Generation, the Importer, or
// the Book Writer. Persistence and the LLM transport stay host-side; the
// deterministic parser adapter stays host-side.
// ======================================================

const {
    extractCandidates,
    buildDeterministicMap,
    mapToStructureChapters,
} = require('../structure-detector-deterministic');
const { analyzeStructure, mergeAiDecisions, sanitizeStructure } = require('./ai-merge');

/**
 * Analyze the structure of a full book source text.
 * LLM classification is merged into the deterministic backbone; any AI
 * failure degrades to the deterministic map (never fails the import).
 *
 * @param {object} input { sourceText, candidates?, language,
 *                         sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep,
 *                         completeStep, failStep, analyzingStructureMessage,
 *                         prompt, fillLang, detector? }
 * @returns {Promise<object>} StructureAnalysis (C18 §6 F1 shape)
 */
async function analyzeBookStructure(input, ports) {
    const _ports = ports || {};
    const REQUIRED_PORTS = [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'analyzingStructureMessage', 'prompt', 'fillLang',
    ];
    const missing = REQUIRED_PORTS.filter((p) => !_ports[p]);
    if (missing.length) {
        throw new Error(`structure-analyzer: missing host port(s): ${missing.join(', ')} — persistence and the LLM seam are host-injected (C19 §5)`);
    }
    const {
        callAI, logConversation, updateSession, createStep,
        completeStep, failStep, analyzingStructureMessage, prompt, fillLang,
    } = _ports;
    const detector = _ports.detector || {
        extractCandidates,
        buildDeterministicMap,
        mapToStructureChapters,
    };
    const _progress = input.progress || (() => {});
    const sourceText = input.sourceText;
    const language = input.language;

    _progress({ stage: 'analyzing_structure', message: analyzingStructureMessage });
    await updateSession(input.sessionId, { progress_msg: analyzingStructureMessage });

    const step = await createStep(input.sessionId, 'analyze_structure', input.stepIndex || 0);

    // ── Candidates: the program finds suspicious lines, the LLM classifies ──
    const { candidates } = input.candidates
        ? { candidates: input.candidates }
        : detector.extractCandidates(sourceText);

    const headBlock = candidates
        .filter(c => c.inHeadBlock)
        .sort((a, b) => a.lineIndex - b.lineIndex)
        .slice(0, 15)
        .map(c => `${c.lineIndex + 1}: ${c.text}`)
        .join('\n');

    // Candidates offered to the LLM. Strong candidates (keyword or
    // headingLikelihood >= 0.3) plus STANDALONE title/author head-zone lines:
    // a real title line like "За пределами алгоритмов." scores only ~0.15
    // (decorative period → sentencePunctuation penalty) and would otherwise be
    // invisible to the LLM, forcing it to anchor the title to a wrong
    // candidate (e.g. the prologue line) and tripping the hallucination guard.
    // standalone keeps long narrative paragraphs out — only title-page-like
    // lines (blank line above AND below) join the payload.
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

    const messages = [
        { role: 'system', content: fillLang(prompt('structure'), language) },
        { role: 'user', content: userPrompt },
    ];

    // Deterministic fallback map — used on AI failure AND as the backbone.
    const fallbackMap = detector.buildDeterministicMap(sourceText);
    const fallbackStructure = {
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

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        // Merge LLM decisions into the deterministic map, then project to the
        // structure contract. sanitizeStructure inside mergeAiDecisions drops
        // unanchorable/hallucinated answers (confidence, anchor, shape checks).
        const map = analyzeStructure(sourceText, result);
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

        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, structure);
        console.log(`[AGENT] Step 0 (structure): title=${structure.title ? `«${structure.title}»` : '✗'}, author=${structure.author ? `«${structure.author}»` : '✗'}, ${structure.segments.length} segments (${structure.segments.map(s => s.type).join(',')})`);
        return structure;
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.error(`[AGENT] Step 0 (structure) FAILED: ${err.message} — using deterministic structure map`);
        return fallbackStructure;
    }
}

module.exports = {
    analyzeBookStructure,
    // AI-merge seam (frozen C17/C18 surface; re-exported so the compatibility
    // barrel and tests reach the whole Structure Analyzer through one module)
    analyzeStructure,
    mergeAiDecisions,
    sanitizeStructure,
    // deterministic detector surface re-exported for host seam callers
    // (bootstrap candidate scan; same objects as the parser adapter module)
    extractCandidates,
    buildDeterministicMap,
    mapToStructureChapters,
};

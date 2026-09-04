// ======================================================
// AI Service — server-side AI API wrapper
// ======================================================
// Used for server-side AI operations (bootstrap refinement, etc.)
// NOT the same as the frontend-facing chat endpoint.
// ======================================================

const config = require('../config/runtime-config');
const { safeFetch } = require('./url-safety');

const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.aicredits.in/v1';

// ======================================================
// LOW-LEVEL AI CALL
// ======================================================
// Transport separation: the provider ({ endpoint, apiKey, model }) is a
// DEPENDENCY passed by the caller (ai-caller / routes). When no workspace
// provider is supplied the call keeps the historical global env behaviour.

async function callAI(messages, options = {}, provider = null) {
    // Local AI Connector branch (LAC §9): the connector transport replaces
    // the HTTP fetch — no server-side endpoint, no apiKey, no SSRF surface.
    // Runs BEFORE the apiKey check: a connector snapshot legitimately has
    // apiKey === null. Fail-closed (AD-12): offline/broken connector throws
    // an explicit sanitized error — never a silent fallback to system AI.
    // No callAI-level retry: cold model loads can legitimately take 30-60 s
    // (§16.2) and a 3× retry of a timeout would triple that load; agent-side
    // STEP_RETRIES still apply above this seam as spec'd (§5).
    if (provider && provider.transport === 'connector') {
        return callAIOverConnector(messages, options, provider);
    }

    // A passed provider (workspace/personal) always wins — the kill switch
    // only governs SYSTEM/provider AI. The env fallback is gated behind the
    // admin kill switch so it can never bypass it.
    let apiKey = provider && provider.apiKey;
    if (!apiKey) {
        const systemAi = require('./system-ai');
        if (await systemAi.isSystemAiEnabled()) {
            apiKey = config.OPENROUTER_API_KEY;
        }
    }
    if (!apiKey) {
        throw new Error('No AI provider configured (system AI disabled or no key configured)');
    }

    const model = options.model
        || (provider && provider.model)
        || config.OPENROUTER_MODEL
        || 'qwen/qwen3.5-122b-a10b';
    const baseUrl = (provider && provider.endpoint) || AI_API_BASE_URL;
    const maxTokens = options.maxTokens || 8192;
    const temperature = options.temperature ?? 0.3;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    headers['HTTP-Referer'] = 'https://animastor.in';
    headers['X-Title'] = 'Animastor';

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await safeFetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                    stream: false,
                }),
                signal: AbortSignal.timeout(options.timeout || 60000),
                // SSRF guard applies to the USER-controlled workspace endpoint;
                // the env fallback is operator-controlled and trusted.
                validatePublic: provider?.source === 'workspace' && !!provider.endpoint,
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[AI-SERVICE] API error (${response.status}): ${errText.substring(0, 500)}`);
                // Do not retry 4xx errors (auth, bad request, rate limit)
                if (response.status >= 400 && response.status < 500) {
                    throw new Error(`AI API error (${response.status}): ${errText.substring(0, 200)}`);
                }
                throw new Error(`AI API server error (${response.status}): ${errText.substring(0, 200)}`);
            }

            const rawText = await response.text();
            if (!rawText || !rawText.trim()) {
                console.error(`[AI-SERVICE] API returned empty body (status ${response.status})`);
                throw new Error(`AI API returned empty response (${response.status})`);
            }
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (parseErr) {
                console.error(`[AI-SERVICE] API returned non-JSON body (${rawText.length} chars): ${rawText.substring(0, 300)}`);
                throw new Error(`AI API returned non-JSON response: ${rawText.substring(0, 100)}`);
            }
            const choice = data.choices?.[0]?.message;
            const content = choice?.content || '';
            console.log(`[AI-SERVICE] Response: finish=${data.choices?.[0]?.finish_reason || 'stop'}, ${content.length} chars, tokens=${data.usage?.total_tokens || '?'}`);
            return {
                content,
                finishReason: data.choices?.[0]?.finish_reason || 'stop',
                usage: data.usage || null,
            };
        } catch (err) {
            lastError = err;
            // Don't retry 4xx (re-throw immediately)
            if (err.message?.startsWith('AI API error (4')) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.warn(`[AI-SERVICE] Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`AI API call failed after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`);
}

/**
 * Local AI Connector transport (LAC §9 — the callAI-shaped seam): routes
 * the completion through shared-pool.runSharedInference — the single
 * reservation-aware entry — which calls ai-connector/transport.connectorChat
 * over the connector's authenticated WS session and, for SHARED snapshots,
 * owns the per-inference slot lifecycle (reserved before the call, released
 * on success/error/timeout/cancel/disconnect via its finally). Only
 * max_tokens/temperature survive the params (Phase-4 contract); sanitizer
 * discipline is enforced connector-side AND cloud-side. Throws sanitized
 * errors only.
 */
async function callAIOverConnector(messages, options, provider) {
    const sharedPool = require('./ai-connector/shared-pool');
    if (!provider.connectorId) {
        throw new Error('Local AI connector is not bound');
    }
    const model = options.model || provider.model || '';
    if (!model) {
        throw new Error('Local AI model is not selected');
    }
    const result = await sharedPool.runSharedInference(provider, {
        model,
        messages,
        params: {
            max_tokens: options.maxTokens || 8192,
            temperature: options.temperature ?? 0.3,
        },
    }, { timeoutMs: options.timeout || 60000, signal: options.signal || undefined });

    if (!result.ok) {
        console.error(`[AI-SERVICE] connector call failed (code=${result.code})`);
        throw new Error(sharedPool.describeSharedError(result.code));
    }
    return {
        content: result.content,
        finishReason: result.finishReason || 'stop',
        usage: result.usage || null,
    };
}

/**
 * STREAMING variant of the connector branch (Phase 2 consumer inference):
 * identical snapshot/params contract, plus per-delta delivery through
 * opts.onDelta and the same shared-slot lifecycle (reserved → streamed →
 * released on the terminal frame). The connector transport switches the
 * frame to params.stream:true; deltas are validated/sanitized cloud-side.
 * @param {Array} messages
 * @param {object} options - { model?, maxTokens?, temperature?, timeout?, signal? }
 * @param {object} provider - connector snapshot (workspace binding or shared)
 * @param {object} sink - { onDelta(delta) } (required)
 */
async function callAIStream(messages, options = {}, provider = null, sink = {}) {
    if (!provider || provider.transport !== 'connector') {
        throw new Error('Streaming AI is only available over a connector transport');
    }
    if (typeof sink.onDelta !== 'function') {
        throw new Error('callAIStream requires an onDelta sink');
    }
    const sharedPool = require('./ai-connector/shared-pool');
    const model = options.model || provider.model || '';
    if (!model) {
        throw new Error('Local AI model is not selected');
    }
    const result = await sharedPool.runSharedInference(provider, {
        model,
        messages,
        params: {
            max_tokens: options.maxTokens || 8192,
            temperature: options.temperature ?? 0.3,
        },
    }, {
        timeoutMs: options.timeout || 60000,
        onDelta: sink.onDelta,
        signal: options.signal || undefined,
    });
    if (!result.ok) {
        console.error(`[AI-SERVICE] connector stream failed (code=${result.code})`);
        throw new Error(sharedPool.describeSharedError(result.code));
    }
    return {
        content: result.content,
        finishReason: result.finishReason || 'stop',
        usage: result.usage || null,
    };
}

// ======================================================
// PARSE AI JSON RESPONSE (handle markdown fences)
// ======================================================

function parseJsonResponse(content) {
    if (!content || !content.trim()) {
        throw new Error('AI response is empty');
    }

    // Strip chain-of-thought reasoning blocks (e.g. <think>...</think>, <reasoning>...</reasoning>)
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '').trim();

    // Try markdown code block first
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : cleaned.trim();

    // Try direct parse
    try {
        return JSON.parse(jsonStr);
    } catch {
        // Try to find JSON object in text — match from first { to last }
        const objMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objMatch) {
            const candidate = objMatch[0];
            try { return JSON.parse(candidate); } catch {}
            // Try to fix truncated JSON: remove trailing incomplete fields
            try {
                const fixed = candidate.replace(/,\s*"[^"]*"\s*:\s*[^{["']*\s*$/, '')
                    .replace(/,\s*"[^"]*"\s*:\s*\{[^}]*$/, '}')
                    .replace(/,\s*"[^"]*"\s*:\s*\[[^\]]*$/, ']');
                return JSON.parse(fixed);
            } catch {}
        }

        console.error(`[AI-SERVICE] Failed to parse response. Content preview: ${content.substring(0, 500)}`);
        throw new Error('Failed to parse AI response as JSON');
    }
}

// ======================================================
// REFINE DRAFT — AI analysis of text for import
// ======================================================
// Sends the first chapter text + candidate data to the AI,
// gets back refined characters, locations, and scene structure.

async function refineDraft(chapterText) {
    const fs = require('fs');
    const path = require('path');

    // Load all example files from ai/examples/ to show the AI correct expected structure
    let examplesBlock = '';
    try {
        const examplesDir = path.join(__dirname, '../../ai/examples');
        if (fs.existsSync(examplesDir)) {
            const allParts = [];
            function walkDir(dir, depth = 0) {
                if (depth > 4) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                entries.sort((a, b) => a.name.localeCompare(b.name));
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walkDir(fullPath, depth + 1);
                    } else if (entry.name.endsWith('.json')) {
                        const relPath = path.relative(examplesDir, fullPath);
                        try {
                            const content = fs.readFileSync(fullPath, 'utf8');
                            const parsed = JSON.parse(content);
                            allParts.push(`### ${relPath}\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``);
                        } catch { }
                    }
                }
            }
            walkDir(examplesDir);
            if (allParts.length > 0) {
                const totalBytes = allParts.reduce((s, p) => s + p.length, 0);
                console.log(`[AI-SERVICE] Loaded ${allParts.length} example files (${totalBytes} chars) into prompt`);
                examplesBlock = `## Reference Examples (correctly structured data)
The following examples show the expected data format. They are REFERENCE EXAMPLES only — do not use their content as the actual source text to analyze.

${allParts.join('\n\n')}`;
            } else {
                console.log('[AI-SERVICE] WARNING: No example files found in ai/examples/');
            }
        }
    } catch (e) {
        console.warn('[AI-SERVICE] Failed to load examples:', e.message);
    }

    const systemPrompt = `You are a literary analysis assistant for Animastor — a visual book platform. Your task is to analyze the provided chapter text and return a structured JSON analysis.

## Core Structure (CRITICAL — understand this hierarchy)

Animastor's data model uses a three-level hierarchy:

### Level 1: Scene — a compact narrative episode
A scene is an episode, NOT a whole chapter. Each scene represents ONE self-contained event with:
- ONE primary location
- ONE continuous time period
- ONE consistent set of participants
- ONE sequential event (no jumps)

Examples of scene boundaries: a character moves to a different location, significant time passes, a new character enters who changes the conversation, a narrative break (---, ***).

A scene should NOT cover large volumes of text. Keep scenes compact. If the chapter covers multiple locations / time jumps / participant changes, split it into separate scenes.

The scene.text stores the COMPLETE verbatim literary text for that episode. It is used for audio narration (TTS).

### Level 2: Unit — ONE complete visual frame
A unit is ONE camera frame within the scene. It is the smallest visual unit — what the viewer sees in a single shot.

Critical rules for units:
- A unit is defined by a VISUAL EVENT, not by text length
- A complete visual frame (e.g., "Two people sitting on a bench talking") can be ONE unit even if it is long
- Do NOT split a single visual scene into fragments by commas, sentences, or character count
- Do NOT split at arbitrary text boundaries — splitting "a tall man in a gray suit...held a hat and looked...at his companion" into separate units is WRONG, because that is ONE visual frame
- Unit.text MUST be taken VERBATIM from the scene's full text
- Unit.text must NOT be rewritten, summarized, or paraphrased
- Accept minor technical cleanup (removing speaker labels like "anna:") but NO rewording

**Quality check**: if you read all unit.text values in sequence, you should get almost exactly the original scene text back. If you get a retelling or summary, the decomposition is wrong.

When in doubt, prefer FEWER units that are complete visual frames over many small fragments that break a single scene.

### Level 3: Image Prompt (unit.image.prompt)
The image prompt describes what is visible in THIS SPECIFIC FRAME — and ONLY this frame.

- It answers: "What should the image show right now?"
- It is NOT a plot summary or narration — be concrete and visual
- It describes camera framing, character position, lighting, environment, mood
- Typically 5-15 words in English (or in the text's original language)
- This is what an image generator uses to draw ONE frame
- Each unit MUST have an image.prompt — it is REQUIRED
- IMPORTANT: Do NOT include character biography, location descriptions, or other entity metadata in the prompt. The system will inject character passports, location data, and narrative context separately. Focus exclusively on the visual composition of this specific frame.
- Example of what NOT to do: "a tall mysterious man in a gray suit, protagonist of the story, who was described earlier as having dark hair" — wrong, because character metadata is system-provided
- Instead: "tall man in gray suit holding a hat, looking at his companion, dim street lighting, rain" — focus on visible elements

### Examples

**Correct — one complete visual frame as one unit:**
Scene text: "Анна и Борис сидели на скамейке возле пруда и обсуждали статью."
Unit 1: text="Анна и Борис сидели на скамейке возле пруда и обсуждали статью." prompt="Two people sitting on a bench near a pond having a discussion, spring evening, cinematic composition"

**Correct — multiple visual events are multiple units:**
Scene text: "Борис подошёл к киоску. Купил воду. Вернулся к скамейке."
Unit 1: text="Борис подошёл к киоску." prompt="Man walking toward a small kiosk"
Unit 2: text="Купил воду." prompt="Man buying a bottle of water at kiosk"
Unit 3: text="Вернулся к скамейке." prompt="Man walking back to bench carrying water"

**Wrong — splitting a single visual frame by text metrics:**
✗ Unit 1: "Высокий человек в сером костюме..." Unit 2: "...держал в руке шляпу..." Unit 3: "...и смотрел на собеседника."
This is ONE visual frame, not three.

## Rules

### Scenes and Units (HIGHEST PRIORITY)
- Identify natural scene boundaries: location changes, time jumps, character entrances/exits, narrative breaks
- Return EVERY scene the text supports — do NOT artificially create a minimum number
- A scene with 2 good scenes is better than forcing 3 with one empty
- Each scene must be a COMPACT EPISODE (one location, one time, one set of participants, one sequential event)
- Each scene.text must contain the COMPLETE verbatim original text of that episode
- Decompose each scene's text into units based on VISUAL EVENTS, not text metrics
- Each unit must have an image.prompt describing the image frame
- Read all unit.text values back: they should reconstruct the scene, not summarize it

### Characters and Locations (SECONDARY PRIORITY)
- Extract real character names from the text. A character is a named person who speaks or is referenced by name.
- Identify locations (places where scenes occur).
- Characters and locations are WORKING DRAFTS. Incomplete entries are acceptable.
- It is better to return 3 well-described, accurate characters than 10 shallow ones.
- If a character's full description appears later in the book, it is OK to leave the description brief.
- Location descriptions can be short — they will be refined during later editing.

### Priority Summary
- FIRST: scene quality (correct boundaries, verbatim text, logical units with visual prompts)
- SECOND: unit quality (visual frame integrity, verbatim text, useful visual prompts)
- THIRD: character accuracy (correct names, plausible roles)
- FOURTH: location completeness

Your primary goal is producing scenes and units that can immediately be used for visual book generation. Entity completeness is secondary.

### Self-Verification (CRITICAL — do this before returning)
Before outputting your response, you MUST verify:
1. Every scene has non-empty "text" (verbatim from source)
2. Every unit has "text" that appears VERBATIM in its parent scene.text (globally unique substring match is fine)
3. Every unit has a **non-empty** "image.prompt" describing the image frame
4. Re-read all unit.text values in order — if they don't reconstruct the scene, you are summarizing instead of extracting. Fix it.
5. No unit splits a visual event by text length, commas, or arbitrary boundaries
6. Characters are real character names from the text (not "Далее", "Кстати", "Тут", "Но", "На" + name fragments)
7. The JSON is valid and complete — not truncated or malformed

If verifying reveals any issues, YOU MUST FIX THEM before returning. Your output must pass ALL checks.

${examplesBlock}

## Output Format
\`\`\`json
{
  "characters": [
    {
      "id": "character_name_snake_case",
      "name": "Full Name (in original language)",
      "role": "protagonist|antagonist|supporting|minor",
      "description": "Brief character description"
    }
  ],
  "locations": [
    {
      "id": "location_name_snake_case",
      "name": "Location Name (in original language)",
      "type": "indoor|outdoor|abstract",
      "description": "Brief location description"
    }
  ],
  "scenes": [
    {
      "title": "Scene Title (in original language)",
      "text": "COMPLETE verbatim scene text from the source — used as audio.full_text. Must not be empty.",
      "type": "narration|dialogue",
      "participants": ["character_id"],
      "units": [
          {
            "text": "Verbatim fragment from scene.text. One COMPLETE visual frame. NOT split by text length. Taken word-for-word from the scene's full text.",
            "type": "perception|narration|dialogue|description|action|transition|performance",
            "image": {
              "shot": "wide|medium|close|detail|environment|reaction",
              "prompt": "REQUIRED. Short visual description of this ONE frame (5-15 words). Focus on what is visible in the image. Do NOT include character bios, location metadata, or plot summary — the system injects those separately."
            }
          }
        ]
      }
    ]
  }
}
\`\`\`
IMPORTANT: scenes must be compact episodes (one location/time/participants). Unit.text is a COMPLETE visual frame, not a text-length fragment. Each unit MUST have image.prompt. When in doubt, prefer FEWER complete visual frames over many fragments. Scenes over entity count: quality scenes and units are the primary goal.`;

    const userPrompt = `Analyze the following text and return a structured analysis.

## Text to Analyze
\`\`\`
${chapterText}
\`\`\`

Return the JSON analysis with characters, locations, and scenes. Identify every natural scene boundary in the text — do not create artificial scene counts. Every scene.text must contain the FULL original verbatim text from the source above for that scene segment. Every unit.text must be a VERBATIM fragment (sentence) taken word-for-word from scene.text — do NOT rewrite, summarize, or paraphrase the text. Each unit must include an image.prompt describing the image frame.

## Self-Verification (REQUIRED before returning)
Before returning your response, verify EVERY requirement below. If ANY requirement is violated, fix it before outputting:

1. Every scene in the "scenes" array has non-empty "text" (verbatim from source)
2. Every unit in every scene has "text" that is a VERBATIM substring of its parent scene.text
3. Every unit has "image.prompt" (a short image description, 5-15 words)
4. Reading all unit.text values in order reconstructs the scene — not a summary or retelling
5. Units are split by VISUAL EVENTS, not by text length, sentences, or commas
6. Characters array is not empty (extract real names from the text)
7. Locations array is not empty (identify places where scenes occur)
8. The output is valid JSON matching the required format

If any check fails, correct the output before returning it. Return ONLY the final valid JSON.`;

    console.log(`[AI-SERVICE] System prompt: ${systemPrompt.length} chars, User prompt: ${userPrompt.length} chars, Total: ${(systemPrompt.length + userPrompt.length)} chars`);
    console.log(`[AI-SERVICE] Examples included: ${examplesBlock.includes('scene.text')}, ${examplesBlock.includes('unit.text')}, ${examplesBlock.includes('image.prompt')}`);

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await callAI([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt + (lastError ? `\n\n## Previous attempt errors\n${lastError}\nPlease fix these issues and return corrected JSON.` : '') },
            ], { timeout: 180000, maxTokens: 32768 });

            const analysis = parseJsonResponse(response.content);
            validateAnalysis(analysis, chapterText);
            return analysis;
        } catch (err) {
            lastError = err.message;
            console.warn(`[AI-SERVICE] Attempt ${attempt + 1} failed: ${err.message}`);
            if (attempt < 2) {
                const delay = 2000 * Math.pow(2, attempt);
                console.log(`[AI-SERVICE] Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`AI analysis failed after 3 attempts: ${lastError || 'unknown error'}`);
}

function validateAnalysis(analysis, chapterText) {
    const errors = [];

    if (!analysis.scenes || analysis.scenes.length === 0) {
        errors.push('No scenes returned — at least 1 scene required');
    }

    for (let si = 0; si < (analysis.scenes || []).length; si++) {
        const s = analysis.scenes[si];
        if (!s.text || !s.text.trim()) {
            errors.push(`Scene ${si + 1}: text is empty`);
        }
        for (let ui = 0; ui < (s.units || []).length; ui++) {
            const u = s.units[ui];
            if (!u.text || !u.text.trim()) {
                errors.push(`Scene ${si + 1}, Unit ${ui + 1}: text is empty`);
            }
            if (!u.image || !u.image.prompt || !u.image.prompt.trim()) {
                errors.push(`Scene ${si + 1}, Unit ${ui + 1}: image.prompt is missing or empty`);
            }
            if (u.text && s.text && !s.text.includes(u.text.trim())) {
                // Unit text matches chapter text but not scene boundaries →
                // the AI split the scene incorrectly. Expand scene.text to include it.
                const chapIdx = chapterText.indexOf(u.text.trim());
                if (chapIdx !== -1) {
                    console.warn(`[AI-SERVICE] Scene ${si + 1}, Unit ${ui + 1}: text not in scene but found in chapter. Fixing scene.text inclusion...`);
                    // Try to expand scene.text to include this unit
                    const unitEnd = chapIdx + u.text.trim().length;
                    const sceneStart = Math.min(chapIdx, chapterText.indexOf(s.text) !== -1 ? chapterText.indexOf(s.text) : 0);
                    const sceneEnd = Math.max(unitEnd, (chapterText.indexOf(s.text) !== -1 ? chapterText.indexOf(s.text) + s.text.length : 0));
                    if (chapterText.substring(sceneStart, sceneEnd).includes(u.text.trim())) {
                        s.text = chapterText.substring(sceneStart, sceneEnd);
                        continue;
                    }
                }
                errors.push(`Scene ${si + 1}, Unit ${ui + 1}: text "${u.text.substring(0, 50)}..." is not a verbatim substring of scene.text`);
            }
        }
    }

    if ((analysis.characters || []).length === 0) {
        errors.push('No characters extracted');
    }
    if ((analysis.locations || []).length === 0) {
        errors.push('No locations extracted');
    }

    if (errors.length > 0) {
        throw new Error(errors.join('; '));
    }
}

// ======================================================
// AI HEALTH CHECK — lightweight ping to see if the LLM API is alive
// ======================================================
// Checks if the AI API key is set and the models endpoint responds.
// Result is cached for 60 seconds to avoid hammering the API on every poll.

const HEALTH_CACHE_TTL_MS = 60_000;
// Keyed per provider: 'global' for the env-based fallback, otherwise
// `${workspaceId}:${keyId}` — one workspace's provider must not poison or
// shadow another workspace's health state.
const _healthCacheMap = new Map();

function _healthCacheKey(provider) {
    if (!provider || !provider.apiKey) return 'global';
    const keyId = String(provider.apiKey).slice(-6);
    return `${provider.workspaceId || 'global'}:${keyId}`;
}

/**
 * Check if the AI API is alive (key configured + LLM can generate).
 * Makes a minimal chat completion with max_tokens=1 to verify both
 * key validity AND available quota (token balance).
 * Caches the result for 60s to avoid hammering the API on every poll.
 * @param {object} [cfg] - optional config object (for OPENROUTER_API_KEY)
 * @param {object} [provider] - resolved workspace provider (transport separation)
 * @returns {Promise<number>} 1 if alive, 0 if not
 */
async function checkAIHealth(cfg, provider = null) {
    // Local AI Connector branch (LAC §9): a connector snapshot has NO apiKey
    // by design — the HTTP probe below would silently answer for the wrong
    // provider (global env key) or report 0 while local inference works.
    // The honest capacity signal is the connector's own liveness (the same
    // registry state the inference fails closed on). A Map lookup — no
    // probe, no token spend, no cache needed.
    if (provider && provider.transport === 'connector') {
        const registry = require('./ai-connector/registry');
        return !!provider.connectorId && registry.isLive(provider.connectorId) ? 1 : 0;
    }

    // Workspace/personal provider keys are always usable; the env fallback is
    // gated behind the admin kill switch (system AI control).
    let apiKey = provider && provider.apiKey;
    if (!apiKey) {
        const systemAi = require('./system-ai');
        if (await systemAi.isSystemAiEnabled()) {
            apiKey = cfg?.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
        }
    }
    if (!apiKey) return 0;

    const cacheKey = _healthCacheKey(provider);
    const cached = _healthCacheMap.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < HEALTH_CACHE_TTL_MS) {
        return cached.alive ? 1 : 0;
    }

    try {
        // Minimal chat completion — verifies key is valid AND quota is available
        const baseUrl = (provider && provider.endpoint) || AI_API_BASE_URL;
        const response = await safeFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: (provider && provider.model) || 'qwen/qwen3-8b',  // cheapest model for health check
                messages: [{ role: 'user', content: 'ok' }],
                max_tokens: 1,
                temperature: 0,
            }),
            signal: AbortSignal.timeout(15_000),
            validatePublic: provider?.source === 'workspace' && !!provider.endpoint,
        });
        _healthCacheMap.set(cacheKey, { alive: response.ok, at: now });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn(`[AI-HEALTH] API returned ${response.status}: ${text.substring(0, 200)}`);
        }
        return response.ok ? 1 : 0;
    } catch (err) {
        console.warn(`[AI-HEALTH] API check failed: ${err.message}`);
        _healthCacheMap.set(cacheKey, { alive: false, at: now });
        return 0;
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    callAI,
    callAIStream,
    parseJsonResponse,
    refineDraft,
    checkAIHealth,
};

// ======================================================
// Snake Guard — fantasy snake_case id detection + chimera resolution
// ======================================================
// Two distinct failure classes are handled here:
//
// 1. FANTASY id — a snake_case token with NO confident relation to the book's
//    registry (characters.json ids + location ids). The model invented a
//    character that does not exist ("zhenshchina_v_budochke"). These are sent
//    to the LLM reassembly step, which restores the natural designation from
//    the source text.
//
// 2. CHIMERA id — a snake_case token that CONFIDENTLY matches a registry id
//    but is not byte-equal: mixed latin+cyrillic script ("mikhail_berлиоз"),
//    wrong transliteration ("ivan_ponerov" vs "ivan_ponyrev", "y"/"iy"
//    variants), trailing underscore ("mihail_bulgakov_"), 1-2 char typos,
//    or a noise suffix ("anna_smirnova_extra"). These are aligned to the
//    CANONICAL registry id deterministically — no LLM call, and the fix always
//    uses the existing id from the registry, never a synthesized variant.
//
// Shared by (ONE source of truth):
//   - pipeline-steps.js  stepRepairFantasyIds (canonicalize → flag → LLM repair)
//   - book/lazy-book/create.js  write barrier (participants / mentions / ids)
//   - scripts/audit-video-actions.js  book audit

const { normalizeForMatch } = require('./character-identity');

// Snake token: a word with ≥1 underscore, latin AND/OR cyrillic letters,
// optional trailing underscores and possessive "'s". Case-insensitive via
// [A-Za-z]. The lookbehind/lookahead use Unicode letter/number classes so
// partial words never match ("the alley" stays clean).
const SNAKE_TOKEN_RE = /(?<![\p{L}\p{N}_])([A-Za-z\u0400-\u04FF][A-Za-z0-9_\u0400-\u04FF]*(?:_[A-Za-z0-9_\u0400-\u04FF]+)+_*)(?:'s)?(?![\p{L}\p{N}_])/gu;

// Whitelist of snake tokens that legitimately appear in AI-written prompts
// WITHOUT being character/location ids: prompt schema field names, shot/camera
// vocabulary, lighting terms, and common object compounds. Extend here, not in
// callers.
const KNOWN_NON_CHARACTER_SNAKE = new Set([
    // prompt / schema field names
    'character_id', 'scene_index', 'unit_index', 'scene_title',
    'estimated_duration_sec', 'video_tokens', 'image_prompt', 'full_text',
    'chapter_id', 'scene_id', 'unit_id', 'book_id', 'audio_text',
    // shot & camera vocabulary
    'close_up', 'medium_shot', 'wide_shot', 'medium_close', 'low_angle',
    'high_angle', 'bird_eye', 'over_the_shoulder', 'long_shot', 'extreme_close',
    'full_body', 'three_quarter', 'side_profile', 'profile_view', 'point_of_view',
    'slow_pan', 'tracking_shot', 'aerial_view', 'establishing_shot',
    'reverse_shot', 'two_shot', 'dutch_angle', 'tilt_shift',
    // lighting & atmosphere
    'golden_hour', 'soft_light', 'warm_light', 'cool_light', 'natural_light',
    'back_light', 'rim_light', 'hard_light', 'candle_light', 'sun_light',
    'moon_light', 'street_light', 'fire_light', 'window_light', 'dappled_light',
    'overcast_sky', 'golden_sunset', 'golden_light', 'dusk_light', 'dawn_light',
    // common object / scene compounds
    'park_bench', 'eye_contact', 'hand_rail', 'street_lamp', 'bus_stop',
    'phone_booth', 'train_station', 'bus_station', 'market_stall', 'food_stall',
    'newspaper_stand', 'garden_bench', 'park_path', 'tree_line', 'city_skyline',
    'dining_table', 'coffee_table', 'writing_desk', 'front_door', 'back_door',
    'side_door', 'shop_window', 'store_front', 'street_corner', 'door_frame',
    'window_sill', 'fire_escape', 'street_sign', 'traffic_light', 'cross_walk',
    'railway_track', 'front_seat', 'back_seat', 'car_seat', 'steering_wheel',
]);

// ── Cross-prompt consistency (generic person references) ─────────────
// image.prompt and video.action describe the SAME unit. When one field names a
// scene participant by character_id and the other replaces them with a generic
// designation ("two citizens", "a man", "the men"), the generic field is
// under-specified — the still frame and the motion would show different people.
// The cross-prompt check flags this so the polish pass can re-anchor the
// under-specified field to the ids named by the other field.
//
// Design rules (conservative):
//   - Group/indefinite person nouns ALWAYS count as generic — they denote a
//     person or people as a collective that could (and per the visuals rules
//     SHOULD) be named by id when the other field does name it.
//   - Pronouns count ONLY when the field carries NO character id at all. A
//     pronoun after a named id ("ivan_ponyrev raises his hand") resolves
//     naturally — the id anchors the clause, that is not anonymization.
//   - Background extras never trigger: the trigger requires the OTHER field to
//     name a participant id that THIS field is missing, and extras are never
//     named by id anywhere.

const GROUP_NOUNS = [
    'the two of them', 'the two men', 'both characters', 'the characters',
    'the two citizens', 'two citizens', 'the citizens', 'a citizen',
    'the two people', 'two people', 'the people', 'people', 'both people',
    'the two men', 'two men', 'the men', 'men', 'a man', 'the man',
    'the two women', 'two women', 'the women', 'women', 'a woman', 'the woman',
    'the two figures', 'two figures', 'both figures', 'the figures',
    'a figure', 'figures', 'the pair', 'a pair', 'both of them',
    'the two strangers', 'two strangers', 'the strangers', 'strangers',
    'a stranger', 'the stranger', 'the two', 'these two',
    'one person', 'a person', 'the person', 'persons',
    'the girl', 'a girl', 'the boy', 'a boy', 'the kid', 'a kid',
    'the old man', 'an old man', 'the old woman', 'an old woman',
    'the elderly man', 'an elderly man', 'the elderly woman', 'an elderly woman',
    'the lady', 'a lady', 'the gentleman', 'a gentleman',
    'a passerby', 'the passerby', 'passersby', 'passers-by', 'the pedestrians',
    'pedestrians', 'a pedestrian', 'pedestrian', 'the crowd', 'a crowd',
    'the crowd of people', 'a crowd of people',
    'a group of people', 'the group of people', 'a group of men', 'the group of men',
    'the group', 'a group',
    'the couple', 'a couple', 'someone', 'somebody', 'anyone', 'anybody',
    'everyone', 'everybody',
    'the other man', 'the second man', 'the third man', 'the other woman', 'the second woman',
    'two companions', 'the two companions', 'the companions', 'companions',
    'the pair of men', 'a pair of men', 'a couple of men',
    'two brothers', 'the two brothers', 'the brothers',
    'two sisters', 'the two sisters', 'the sisters',
    'the children', 'two children', 'a child', 'the child',
    'the kids', 'two kids',
    'the onlookers', 'onlookers', 'the bystanders', 'bystanders',
];

const PRONOUNS = ['he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs'];

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lookbehind/lookahead include underscore so snake tokens never leak fragments
// ("two_people_walk" must not match "people").
const GENERIC_NOUN_RE = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${GROUP_NOUNS.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'gi'
);

function normalizeKnownIds(knownIds) {
    const out = new Set();
    for (const id of (knownIds || [])) {
        if (id) out.add(String(id).toLowerCase());
    }
    return out;
}

/**
 * Which of the candidate ids appear in a text (case-insensitive, word-boundary
 * aware — "mikhail_berlioz's glasses" matches "mikhail_berlioz").
 * @param {string} text
 * @param {Iterable<string>} candidateIds
 * @returns {string[]} matched ids (original casing of the candidates)
 */
function findKnownIdsInText(text, candidateIds) {
    if (!text) return [];
    const out = [];
    for (const id of (candidateIds || [])) {
        if (!id) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(id)}(?![\\p{L}\\p{N}_])`, 'i');
        if (re.test(String(text))) out.push(id);
    }
    return out;
}

/**
 * Generic person references in a field: group/indefinite person nouns always;
 * pronouns only when the field carries NO candidate id (see design rules above).
 * @param {string} text
 * @param {Iterable<string>} knownIds - ids present in the field suppress pronouns
 * @returns {string[]} distinct matched generic terms (original case)
 */
function findGenericPersonTerms(text, knownIds) {
    if (!text) return [];
    const s = String(text);
    const hits = [];
    const seen = new Set();
    for (const m of s.matchAll(GENERIC_NOUN_RE)) {
        const low = m[0].toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        hits.push(m[0]);
    }
    if (findKnownIdsInText(s, knownIds).length === 0) {
        for (const w of PRONOUNS) {
            const m = s.match(new RegExp(`\\b${w}\\b`, 'i'));
            if (m && !seen.has(m[0].toLowerCase())) {
                seen.add(m[0].toLowerCase());
                hits.push(m[0]);
            }
        }
    }
    return hits;
}

/**
 * Participant ids each field of a unit names. Only ids that are BOTH scene
 * participants AND registry ids are candidates (natural designations like
 * "женщина в будочке" can never appear as ids). Shared by findCrossPromptGaps
 * and the pipeline's stillMissingIds — keeps the candidate rule in one place.
 * @param {Object} unit - { image: { prompt }, video: { action } }
 * @param {string[]} participants - scene.participants
 * @param {Iterable<string>} knownIds - registry ids (characters)
 * @returns {{idsInPrompt: string[], idsInAction: string[], candidateIds: string[]}}
 */
function participantFieldIds(unit, participants, knownIds) {
    const known = normalizeKnownIds(knownIds);
    const candidateIds = (participants || []).filter(id => known.has(String(id).toLowerCase()));
    return {
        idsInPrompt: findKnownIdsInText(String(unit?.image?.prompt || ''), candidateIds),
        idsInAction: findKnownIdsInText(String(unit?.video?.action || ''), candidateIds),
        candidateIds,
    };
}

/**
 * Cross-prompt consistency gaps for one unit. ASYMMETRIC by design:
 *
 *   HARD (direction 'prompt') — video IDs ⊆ image IDs. Every participant that
 *   video.action names by id must ALSO be concretely identified in image.prompt:
 *   the still must show the people the motion animates. The check is a PURE
 *   subset rule — no generic term is required to fire: omitting the id is itself
 *   the error (generic_terms is then empty, the hint just names the ids).
 *
 *   SOFT (direction 'action') — image IDs ⊆ video IDs is NOT required: a video
 *   may animate only a subset of the people shown in the still (the rest stay
 *   passive/background, auto-animated by the model). Reported for diagnostics
 *   only — never treated as an error (a generic term is required here so pure
 *   subset differences never produce noise).
 *
 * Only ids that are BOTH scene participants AND registry ids (characters.json)
 * are candidates — a random chimera id can never become the basis for fixing
 * the other prompt.
 *
 * @param {Object} unit - { image: { prompt }, video: { action } }
 * @param {string[]} participants - scene.participants
 * @param {Iterable<string>} knownIds - registry ids (characters)
 * @returns {Array<{direction: 'prompt'|'action', severity: 'hard'|'soft', missing_ids: string[], generic_terms: string[], ids_in_other: string[], ids_in_this: string[]}>}
 */
function findCrossPromptGaps(unit, participants, knownIds) {
    const prompt = String(unit?.image?.prompt || '');
    const action = String(unit?.video?.action || '');
    const { idsInPrompt, idsInAction, candidateIds } = participantFieldIds(unit, participants, knownIds);
    const gaps = [];

    // HARD — image.prompt under-specified: action names participants the prompt
    // does not concretely identify. Pure subset rule — generic term NOT required.
    const promptMissing = idsInAction.filter(id => !idsInPrompt.includes(id));
    if (promptMissing.length > 0) {
        gaps.push({
            direction: 'prompt',
            severity: 'hard',
            missing_ids: promptMissing,
            generic_terms: findGenericPersonTerms(prompt, candidateIds),
            ids_in_other: idsInAction,
            ids_in_this: idsInPrompt,
        });
    }

    // SOFT — video.action names only a subset: prompt shows participants the
    // action does not animate (legit when the rest are passive/background).
    const actionMissing = idsInPrompt.filter(id => !idsInAction.includes(id));
    if (actionMissing.length > 0) {
        const generics = findGenericPersonTerms(action, candidateIds);
        if (generics.length > 0) {
            gaps.push({
                direction: 'action',
                severity: 'soft',
                missing_ids: actionMissing,
                generic_terms: generics,
                ids_in_other: idsInPrompt,
                ids_in_this: idsInAction,
            });
        }
    }
    return gaps;
}

function originalsList(knownIds) {
    return Array.from(knownIds || []).map(id => String(id)).filter(Boolean);
}

/**
 * Extract all snake_case tokens from a text (deduplicated, in matched case).
 * @param {string} text
 * @returns {string[]}
 */
function snakeTokensInText(text) {
    if (!text) return [];
    const tokens = [];
    const seen = new Set();
    for (const m of String(text).matchAll(SNAKE_TOKEN_RE)) {
        const tok = m[1];
        const low = tok.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        tokens.push(tok);
    }
    return tokens;
}

/**
 * True when the token mixes latin and cyrillic letters — the classic
 * "полу-русский / полу-английский" chimera.
 */
function hasMixedScript(token) {
    const s = String(token || '');
    return /[a-z]/i.test(s) && /[\u0400-\u04FF]/.test(s);
}

/** Compact comparable form: lowercase, cyrillic→latin, junk stripped, no spaces. */
function compactNormalizedId(token) {
    return normalizeForMatch(String(token || '')).replace(/\s+/g, '');
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[n];
}

/**
 * Resolve a snake token to the CANONICAL registry id when there is a
 * CONFIDENT match. Never synthesizes a new id — always returns an existing
 * registry id or null.
 *
 * Tiers (strictly decreasing confidence):
 *   1. exact after transliteration/normalization (mixed-script, trailing '_', case)
 *   2. unique fuzzy best within a conservative threshold (typo, y/iy, 1-2 chars)
 *      — skipped when options.fuzzy === false (registry-write paths: a wrong
 *        fuzzy merge there could DROP a genuinely distinct character)
 *   3. token = known id + noise suffix ("anna_smirnova_extra" → "anna_smirnova")
 * When the match is ambiguous (two equidistant candidates) → null: the token
 * is NOT auto-fixed and goes to the LLM reassembly step instead.
 *
 * @param {string} token
 * @param {Iterable<string>} knownIds - registry ids (characters + locations)
 * @param {{fuzzy?: boolean}} [options]
 * @returns {string|null} canonical id
 */
function findCanonicalId(token, knownIds, options = {}) {
    const originals = originalsList(knownIds);
    if (!token || originals.length === 0) return null;
    const low = String(token).toLowerCase();

    // exact byte match → already canonical
    const exact = originals.find(id => id.toLowerCase() === low);
    if (exact) return exact;

    const target = compactNormalizedId(low);

    // Tier 1 — equal after transliteration/normalization
    for (const id of originals) {
        if (compactNormalizedId(id) === target) return id;
    }

    // Tier 2 — unique fuzzy best within a conservative threshold
    if (options.fuzzy !== false) {
        const candidates = [];
        for (const id of originals) {
            const other = compactNormalizedId(id);
            if (!other) continue;
            const maxL = Math.max(target.length, other.length);
            if (maxL < 8) continue; // too short for reliable fuzzy matching
            const d = levenshtein(target, other);
            if (d <= Math.min(3, Math.ceil(maxL * 0.15))) candidates.push({ id, d });
        }
        candidates.sort((a, b) => a.d - b.d || a.id.length - b.id.length);
        if (candidates.length === 1) return candidates[0].id;
        if (candidates.length > 1 && candidates[0].d < candidates[1].d) return candidates[0].id;
    }

    // Tier 3 — token extends a known id with a noise suffix
    const byLength = [...originals].sort((a, b) => b.length - a.length);
    for (const id of byLength) {
        const idLow = id.toLowerCase();
        if (low !== idLow && low.startsWith(idLow + '_')) return id;
    }

    return null;
}

/**
 * Classify a single snake token against the registry.
 * @returns {null|{kind:'known', id}|{kind:'whitelisted'}|{kind:'chimera', canonical}|{kind:'invented'}}
 */
function classifySnakeToken(token, knownIds, options = {}) {
    const ids = normalizeKnownIds(knownIds);
    const whitelist = new Set(
        [...KNOWN_NON_CHARACTER_SNAKE, ...(options.whitelist || [])]
            .map(w => String(w).toLowerCase())
    );
    const low = String(token || '').toLowerCase();
    if (!low) return null;
    if (ids.has(low)) return { kind: 'known' };
    if (whitelist.has(low)) return { kind: 'whitelisted' };
    const canonical = findCanonicalId(token, ids);
    if (canonical && canonical.toLowerCase() !== low) return { kind: 'chimera', canonical };
    return { kind: 'invented' };
}

/**
 * Find snake_case tokens in text that are NOT verified registry ids — i.e.
 * invented ids AND chimeras (the full "unverified" set for the LLM repair step;
 * chimeras are normally auto-fixed by canonicalizeText BEFORE this is called).
 * @param {string} text
 * @param {Iterable<string>} knownIds
 * @param {{whitelist?: Iterable<string>}} [options]
 * @returns {string[]} unique unverified tokens (in matched case)
 */
function findUnverifiedSnakeTokens(text, knownIds, options = {}) {
    const out = [];
    for (const token of snakeTokensInText(text)) {
        const c = classifySnakeToken(token, knownIds, options);
        if (c && (c.kind === 'invented' || c.kind === 'chimera')) out.push(token);
    }
    return out;
}

/**
 * Single-value check — for scene.participants entries and audio.speaker values.
 * @param {*} value
 * @param {Iterable<string>} knownIds
 * @param {object} [options]
 * @returns {boolean} true when the value is an unverified snake_case id
 */
function isFantasySnakeToken(value, knownIds, options = {}) {
    return findUnverifiedSnakeTokens(String(value || ''), knownIds, options).length > 0;
}

/**
 * Deterministically align chimera snake tokens in free text to the canonical
 * registry ids. Known ids and whitelisted technical/object tokens are left
 * untouched; possessive suffixes are preserved ("mikhail_berлиоз's" →
 * "mikhail_berlioz's"). Tokens with NO confident match stay as-is (they are
 * handled later by the LLM repair step).
 * @param {string} text
 * @param {Iterable<string>} knownIds
 * @param {{whitelist?: Iterable<string>}} [options]
 * @returns {string}
 */
function canonicalizeText(text, knownIds, options = {}) {
    if (!text) return text;
    const ids = normalizeKnownIds(knownIds);
    const whitelist = new Set(
        [...KNOWN_NON_CHARACTER_SNAKE, ...(options.whitelist || [])]
            .map(w => String(w).toLowerCase())
    );
    return String(text).replace(SNAKE_TOKEN_RE, (full, token) => {
        const low = token.toLowerCase();
        if (ids.has(low) || whitelist.has(low)) return full;
        const canonical = findCanonicalId(token, ids);
        if (!canonical || canonical.toLowerCase() === low) return full;
        return canonical + full.slice(token.length); // preserve "'s"
    });
}

/**
 * Deterministic last-resort: explode every INVENTED snake token into its
 * readable word form ("kiosk_saleswoman" → "kiosk saleswoman") so a fantasy
 * id can never reach the book even when the LLM reassembly failed. Known ids,
 * whitelisted vocabulary and chimeras (aligned earlier by canonicalizeText)
 * are left untouched. Preserves the trailing "'s" possessive.
 * @param {string} text
 * @param {Iterable<string>} knownIds
 * @param {{whitelist?: Iterable<string>}} [options]
 * @returns {string}
 */
function desnakeifyText(text, knownIds, options = {}) {
    if (!text) return text;
    return String(text).replace(SNAKE_TOKEN_RE, (full, token) => {
        const c = classifySnakeToken(token, knownIds, options);
        if (c && c.kind === 'invented') {
            return token.replace(/_/g, ' ') + full.slice(token.length);
        }
        return full;
    });
}

/**
 * Normalize a MIXED-script id (latin + cyrillic) to a pure latin snake id —
 * "patriarshie_pруды" → "patriarshie_prudy". Pure-latin and pure-cyrillic ids
 * are left untouched (they are internally consistent, not chimeras).
 * @param {string} id
 * @returns {string}
 */
function canonicalizeMixedScriptId(id) {
    const s = String(id || '');
    if (!s || !hasMixedScript(s)) return s;
    return normalizeForMatch(s)
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** Loose "looks like an id" check (letter + underscore) — guards fuzzy calls. */
function isSnakeLike(value) {
    return /[A-Za-z\u0400-\u04FF].*_/.test(String(value || ''));
}

/**
 * Filter a participants list: keep known ids and natural designations
 * ("женщина в будочке"), replace chimeras with the canonical registry id
 * (via onReplace), drop true fantasy ids (via onDrop).
 * @param {string[]} participants
 * @param {Iterable<string>} knownIds
 * @param {{whitelist?: Iterable<string>, onDrop?: (dropped: string) => void, onReplace?: (from: string, to: string) => void}} [options]
 * @returns {string[]}
 */
function sanitizeParticipants(participants, knownIds, options = {}) {
    const ids = normalizeKnownIds(knownIds);
    const onDrop = options.onDrop || null;
    const onReplace = options.onReplace || null;
    const out = [];
    for (const p of (participants || [])) {
        const s = String(p);
        if (!s) continue;
        if (ids.has(s.toLowerCase())) {
            out.push(p);
            continue;
        }
        // chimera (mixed-script / typo / transliteration variant) → canonical id
        if (isSnakeLike(s)) {
            const canonical = findCanonicalId(s, ids, options);
            if (canonical) {
                if (onReplace) onReplace(p, canonical);
                out.push(canonical);
                continue;
            }
        }
        if (isFantasySnakeToken(s, ids, options)) {
            if (onDrop) onDrop(p);
            continue;
        }
        out.push(p);
    }
    return out;
}

module.exports = {
    SNAKE_TOKEN_RE,
    KNOWN_NON_CHARACTER_SNAKE,
    GROUP_NOUNS,
    PRONOUNS,
    snakeTokensInText,
    hasMixedScript,
    findCanonicalId,
    classifySnakeToken,
    findUnverifiedSnakeTokens,
    isFantasySnakeToken,
    canonicalizeText,
    desnakeifyText,
    canonicalizeMixedScriptId,
    isSnakeLike,
    sanitizeParticipants,
    findKnownIdsInText,
    findGenericPersonTerms,
    findCrossPromptGaps,
    participantFieldIds,
};

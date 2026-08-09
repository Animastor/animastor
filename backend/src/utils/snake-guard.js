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

function normalizeKnownIds(knownIds) {
    const out = new Set();
    for (const id of (knownIds || [])) {
        if (id) out.add(String(id).toLowerCase());
    }
    return out;
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
    snakeTokensInText,
    hasMixedScript,
    findCanonicalId,
    classifySnakeToken,
    findUnverifiedSnakeTokens,
    isFantasySnakeToken,
    canonicalizeText,
    canonicalizeMixedScriptId,
    isSnakeLike,
    sanitizeParticipants,
};

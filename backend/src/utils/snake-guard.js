// ======================================================
// Snake Guard — fantasy snake_case id detection
// ======================================================
// A "fantasy snake" is a snake_case token (latin + ≥1 underscore) that LOOKS
// like a character id but is NOT in the book's known ids (characters.json ids
// + location ids). Such tokens are hallucinations: a model invented an id
// instead of using the person's natural designation from the source text
// (e.g. «женщина в будочке» → "zhenshchina_v_budochke").
//
// Shared by (ONE source of truth for "is this snake token a real id?"):
//   - pipeline-steps.js  stepRepairFantasyIds (LLM reassembly trigger)
//   - book/lazy-book/create.js  write barrier (scene.participants filter)
//   - scripts/audit-video-actions.js  book audit
//
// The detection is deliberately CONSERVATIVE: known ids, known locations and a
// whitelist of technical/visual words never flag; only tokens that look like
// invented character ids are reported. A false positive only costs one cheap
// repair call — the repair agent keeps the token when the unit text confirms
// it is an object.

// Snake token: latin word with ≥1 underscore, optional possessive ("'s").
// Case-insensitive so "Mikhail_berlioz" is caught too; ids are lowercase by
// convention but models occasionally capitalize the first letter. The lookbehind
// / lookahead use Unicode letter/number classes so partial words never match
// ("the alley" stays clean).
const SNAKE_TOKEN_RE = /(?<![\p{L}\p{N}_])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?:'s)?(?![\p{L}\p{N}_])/gu;

// Whitelist of snake tokens that legitimately appear in AI-written prompts
// WITHOUT being character/location ids: prompt schema field names, shot/camera
// vocabulary, lighting terms, and common object compounds. A tight list keeps
// the repair pass from firing on healthy books. Extend here, not in callers.
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
 * Find snake_case tokens in text that are NOT verified character/location ids.
 * @param {string} text - prompt / action / participant text to scan
 * @param {Iterable<string>} knownIds - valid ids (characters + locations)
 * @param {{whitelist?: Iterable<string>}} [options] - extra safe tokens
 * @returns {string[]} unique unverified tokens (in matched case)
 */
function findUnverifiedSnakeTokens(text, knownIds, options = {}) {
    const ids = normalizeKnownIds(knownIds);
    const whitelist = new Set(
        [...KNOWN_NON_CHARACTER_SNAKE, ...(options.whitelist || [])]
            .map(w => String(w).toLowerCase())
    );
    const out = [];
    for (const token of snakeTokensInText(text)) {
        const low = token.toLowerCase();
        if (ids.has(low)) continue;
        if (whitelist.has(low)) continue;
        // Skip id-variants: the token is a strict prefix of a real id, or a real
        // id is a strict prefix of the token (truncated / extended spellings of
        // a REAL character — "mikhail_berlio" vs "mikhail_berlioz", or
        // "anna_smirnova_extra" vs "anna_smirnova"). These are not invented
        // characters, so they are not fantasy.
        let variantOfKnown = false;
        for (const id of ids) {
            if ((id.startsWith(low) || low.startsWith(id)) && id !== low) {
                variantOfKnown = true;
                break;
            }
        }
        if (variantOfKnown) continue;
        out.push(token);
    }
    return out;
}

/**
 * Single-value check — for scene.participants entries and audio.speaker values.
 * @param {*} value
 * @param {Iterable<string>} knownIds
 * @param {object} [options]
 * @returns {boolean} true when the value is a fantasy snake_case id
 */
function isFantasySnakeToken(value, knownIds, options = {}) {
    return findUnverifiedSnakeTokens(String(value || ''), knownIds, options).length > 0;
}

/**
 * Filter a participants list: keep known ids and natural designations
 * ("женщина в будочке"), drop fantasy snake_case ids (hallucinated characters).
 * @param {string[]} participants
 * @param {Iterable<string>} knownIds
 * @param {{whitelist?: Iterable<string>, onDrop?: (dropped: string) => void}} [options]
 * @returns {string[]}
 */
function sanitizeParticipants(participants, knownIds, options = {}) {
    const ids = normalizeKnownIds(knownIds);
    const onDrop = options.onDrop || null;
    const out = [];
    for (const p of (participants || [])) {
        const s = String(p);
        if (!s) continue;
        if (ids.has(s.toLowerCase())) {
            out.push(p);
            continue;
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
    findUnverifiedSnakeTokens,
    isFantasySnakeToken,
    sanitizeParticipants,
};

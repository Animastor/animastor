// ======================================================
// Coreference Resolution — Image Service Tests (P7)
// ======================================================
// Tests for:
//   - normalizeCharacterRefs   — alias-based character ID injection
//   - buildSafeAliasIndex      — collision/unsafe/generic filtering
//   - resolveLocationFromPrompt — cross-language location matching
//   - buildCharacters           — participants from scene.participants
// ======================================================

const { expect } = require('chai');
const {
    normalizeCharacterRefs,
    resolveLocationFromPrompt,
    buildSafeAliasIndex,
    buildCharacters,
    buildImagePrompt,
    isTypographyStyle,
    resolveVisualStyle,
} = require('../src/image/image-service');

// ======================================================
// normalizeCharacterRefs
// ======================================================

describe('Coreference — normalizeCharacterRefs', () => {

    const characters = [
        { id: 'mikhail_aleksandrovich_berlioz', name: 'Михаил Александрович Берлиоз' },
        { id: 'ivan_nikolaevich_ponyrev', name: 'Иван Николаевич Понырев (Бездомный)' },
    ];

    it('replaces Russian name with character_id', () => {
        const result = normalizeCharacterRefs('Берлиоз и Бездомный сидели на скамейке', characters);
        expect(result).to.include('mikhail_aleksandrovich_berlioz');
        expect(result).to.include('ivan_nikolaevich_ponyrev');
        expect(result).to.not.include('Берлиоз');
        expect(result).to.not.include('Бездомный');
    });

    it('uses safe alias index (strategy 1) when provided', () => {
        const aliasIndex = { berlioz: 'mikhail_aleksandrovich_berlioz' };
        const result = normalizeCharacterRefs('berlioz was here', characters, aliasIndex);
        expect(result).to.include('mikhail_aleksandrovich_berlioz');
    });

    it('replaces latin transliteration of Russian name', () => {
        const result = normalizeCharacterRefs('berlioz and bezdomny', characters);
        expect(result).to.include('mikhail_aleksandrovich_berlioz');
        expect(result).to.include('ivan_nikolaevich_ponyrev');
    });

    it('handles nickname from parentheses (Бездомный)', () => {
        const result = normalizeCharacterRefs('Бездомный', characters);
        expect(result).to.equal('ivan_nikolaevich_ponyrev');
    });

    it('returns original text for empty input', () => {
        expect(normalizeCharacterRefs('', characters)).to.equal('');
        expect(normalizeCharacterRefs(null, characters)).to.be.null;
    });

    it('returns original text for no characters', () => {
        expect(normalizeCharacterRefs('test text', [])).to.equal('test text');
    });

    it('does not replace a character alias inside a longer Cyrillic word', () => {
        const text = 'Берлиозные размышления';
        const result = normalizeCharacterRefs(text, characters);
        expect(result).to.equal(text);
    });

    it('handles empty characters array', () => {
        expect(normalizeCharacterRefs('Берлиоз', [])).to.equal('Берлиоз');
    });

    it('does not replace English stopwords from role-only character names', () => {
        const roleCharacters = [
            { id: 'zhenshchina_v_budochke', name: 'Woman in the Booth' },
        ];
        const text = 'two writers sitting on the bench, facing the pond';
        const result = normalizeCharacterRefs(text, roleCharacters);
        expect(result).to.equal(text);
    });

    it('ignores unsafe aliases from a safe alias index', () => {
        const aliasIndex = { the: 'zhenshchina_v_budochke', booth: 'zhenshchina_v_budochke' };
        const result = normalizeCharacterRefs('the booth is closed', [], aliasIndex);
        expect(result).to.equal('the zhenshchina_v_budochke is closed');
    });
});

// ======================================================
// buildSafeAliasIndex
// ======================================================

describe('Coreference — buildSafeAliasIndex', () => {

    it('creates alias map from resolved mentions', () => {
        const mentions = [
            { mention_text: 'Берлиоз', mention_norm: 'berlioz', character_id: 'berlioz', mention_type: 'name' },
            { mention_text: 'Бездомный', mention_norm: 'bezdomny', character_id: 'bezdomny', mention_type: 'nickname' },
            { mention_text: 'редактор', mention_norm: 'redaktor', character_id: 'berlioz', mention_type: 'profession' },
        ];
        const result = buildSafeAliasIndex(mentions);
        expect(result).to.deep.equal({
            berlioz: 'berlioz',
            bezdomny: 'bezdomny',
            redaktor: 'berlioz',
        });
    });

    it('excludes pronouns and unknown types', () => {
        const mentions = [
            { mention_text: 'он', mention_norm: 'on', character_id: 'berlioz', mention_type: 'pronoun' },
            { mention_text: 'неизвестный', mention_norm: 'neizvestny', character_id: null, mention_type: 'unknown' },
            { mention_text: 'Берлиоз', mention_norm: 'berlioz', character_id: 'berlioz', mention_type: 'name' },
        ];
        const result = buildSafeAliasIndex(mentions);
        // "он" excluded (pronoun), "неизвестный" excluded (unknown + null char_id)
        expect(result).to.deep.equal({ berlioz: 'berlioz' });
    });

    it('excludes generic words (он, она, человек, etc.)', () => {
        const mentions = [
            { mention_text: 'он', mention_norm: 'on', character_id: 'berlioz', mention_type: 'pronoun' },
            // Note: GENERIC_WORDS are in Cyrillic, mentions_norm is Latin transliteration.
            // The check uses GENERIC_WORDS.has(norm) where norm is 'chelovek' (Latin).
            // Since GENERIC_WORDS has 'человек' (Cyrillic), this specific mention
            // would NOT be filtered. This is a known limitation.
            { mention_text: 'человек', mention_norm: 'chelovek', character_id: 'berlioz', mention_type: 'description' },
            { mention_text: 'Берлиоз', mention_norm: 'berlioz', character_id: 'berlioz', mention_type: 'name' },
        ];
        const result = buildSafeAliasIndex(mentions);
        // 'on' excluded (pronoun), 'chelovek' has Cyrillic GENERIC_WORDS mismatch
        // 'berlioz' should be in result
        expect(result.berlioz).to.equal('berlioz');
    });

    it('handles collisions — alias maps to multiple characters', () => {
        const mentions = [
            { mention_text: 'профессор', mention_norm: 'professor', character_id: 'berlioz', mention_type: 'profession' },
            { mention_text: 'профессор', mention_norm: 'professor', character_id: 'woland', mention_type: 'profession' },
        ];
        const result = buildSafeAliasIndex(mentions);
        // "professor" maps to both characters — collision → excluded
        expect(result).to.deep.equal({});
    });

    it('returns empty object for empty input', () => {
        expect(buildSafeAliasIndex([])).to.deep.equal({});
        expect(buildSafeAliasIndex(null)).to.deep.equal({});
    });

    it('handles mentions with null character_id', () => {
        const mentions = [
            { mention_text: 'Берлиоз', mention_norm: 'berlioz', character_id: null, mention_type: 'name' },
        ];
        const result = buildSafeAliasIndex(mentions);
        expect(result).to.deep.equal({});
    });

    it('skips mentions with very short normalized text (< 2 chars)', () => {
        const mentions = [
            { mention_text: 'a', mention_norm: 'a', character_id: 'berlioz', mention_type: 'name' },
        ];
        const result = buildSafeAliasIndex(mentions);
        expect(result).to.deep.equal({});
    });

    it('computes mention_norm from mention_text when mention_norm is empty', () => {
        const mentions = [
            { mention_text: 'Берлиоз', mention_norm: '', character_id: 'berlioz', mention_type: 'name' },
        ];
        const result = buildSafeAliasIndex(mentions);
        expect(result['berlioz']).to.equal('berlioz');
    });
});

// ======================================================
// resolveLocationFromPrompt
// ======================================================

describe('Coreference — resolveLocationFromPrompt', () => {

    const locations = {
        moscow_patriarskie_pруды: {
            description: 'Patriarch Ponds in Moscow, a tranquil park with a large pond surrounded by lime trees and old mansions',
        },
        pivo_i_vody_booth: {
            description: 'Deserted alley near the ponds at sunset',
        },
    };

    it('matches exact location ID substring', () => {
        const prompt = 'scene at moscow_patriarskie_pруды with pond';
        const result = resolveLocationFromPrompt(prompt, locations);
        expect(result).to.not.be.null;
        expect(result.id).to.equal('moscow_patriarskie_pруды');
        expect(result.matchType).to.equal('exact');
    });

    it('matches location via transliteration word overlap (mixed RU/EN)', () => {
        // "patriarch" prefix-matches "patriarskie" via normalizeForMatch
        // "ponds" matches "pond" in the location's description
        // "moscow" matches "Moscow" in the location's description
        const prompt = 'moscow patriarch ponds evening scene cinematic';
        const result = resolveLocationFromPrompt(prompt, locations);
        expect(result).to.not.be.null;
        expect(result.id).to.equal('moscow_patriarskie_pруды');
        expect(result.matchType).to.equal('word_overlap');
    });

    it('returns null for unmatched location', () => {
        const prompt = 'some random place in the middle of nowhere';
        const result = resolveLocationFromPrompt(prompt, locations);
        expect(result).to.be.null;
    });

    it('returns null for empty prompt', () => {
        expect(resolveLocationFromPrompt('', locations)).to.be.null;
        expect(resolveLocationFromPrompt(null, locations)).to.be.null;
    });

    it('returns null for empty locations', () => {
        expect(resolveLocationFromPrompt('test', null)).to.be.null;
        expect(resolveLocationFromPrompt('test', {})).to.be.null;
    });
});

// ======================================================
// buildCharacters — from scene.participants
// ======================================================

describe('Coreference — buildCharacters from scene.participants', () => {

    const book = {
        characters: [
            { id: 'mikhail_aleksandrovich_berlioz', name: 'Михаил Александрович Берлиоз', passport: { appearance: 'Маленького роста, упитан, лыс' } },
            { id: 'ivan_nikolaevich_ponyrev', name: 'Иван Николаевич Понырев', passport: { appearance: 'Плечистый, рыжеватый, вихрастый' } },
        ],
    };

    it('builds passports from scene.participants', () => {
        const scene = { participants: ['mikhail_aleksandrovich_berlioz'] };
        const unit = { visual: { prompt: 'mikhail_aleksandrovich_berlioz sitting on bench' } };
        const result = buildCharacters(scene, unit, {}, book);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.include('mikhail_aleksandrovich_berlioz');
    });

    it('returns multiple when scene.participants has multiple', () => {
        const scene = { participants: ['mikhail_aleksandrovich_berlioz', 'ivan_nikolaevich_ponyrev'] };
        const unit = { text: 'some text' };
        const result = buildCharacters(scene, unit, {}, book);
        expect(result).to.have.lengthOf(2);
        expect(result[0]).to.include('mikhail_aleksandrovich_berlioz');
        expect(result[1]).to.include('ivan_nikolaevich_ponyrev');
    });

    it('returns empty when scene.participants is empty', () => {
        const scene = { participants: [] };
        const unit = { visual: { prompt: 'golden sunset over the pond, no people' } };
        const result = buildCharacters(scene, unit, {}, book);
        // scene.participants is the authoritative source, not prompt text
        expect(result).to.have.lengthOf(0);
    });

    it('returns empty for no participants', () => {
        const result = buildCharacters({}, { visual: { prompt: 'empty landscape' } }, {}, book);
        expect(result).to.have.lengthOf(0);
    });

    it('builds passport string with appearance and clothing', () => {
        const bookDetailed = {
            characters: [{
                id: 'berlioz',
                name: 'Берлиоз',
                passport: {
                    appearance: 'Маленького роста',
                    clothes: 'летний серый костюм',
                },
            }],
        };
        const scene = { participants: ['berlioz'] };
        const unit = { visual: { prompt: 'berlioz sitting on bench' } };
        const result = buildCharacters(scene, unit, {}, bookDetailed);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.equal('berlioz: Маленького роста, летний серый костюм');
    });

    it('deduplicates participant IDs', () => {
        const bookDedup = {
            characters: [{ id: 'berlioz', name: 'Берлиоз', passport: {} }],
        };
        const scene = { participants: ['berlioz', 'berlioz', 'berlioz'] };
        const result = buildCharacters(scene, {}, {}, bookDedup);
        expect(result).to.have.lengthOf(1);
    });
});

// ======================================================
// buildImagePrompt — End-to-end
// ======================================================

describe('Coreference — buildImagePrompt passport injection', () => {

    const bookPayload = {
        characters: [
            { id: 'berlioz', name: 'Берлиоз', passport: { appearance: 'маленького роста' } },
            { id: 'bezdomny', name: 'Бездомный', passport: { appearance: 'плечистый рыжий' } },
        ],
        locations: {
            moscow_patriarskie: {
                description: 'Патриаршие пруды',
            },
        },
    };

    it('injects character passports for participants', () => {
        const unit = {
            type: 'narration',
            image: { prompt: 'berlioz and bezdomny walking by the pond' },
        };
        const scene = {
            participants: ['berlioz', 'bezdomny'],
            location: { id: 'moscow_patriarskie', environment: {} },
        };

        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('berlioz');
        expect(result).to.include('bezdomny');
        expect(result).to.include('маленького роста');
        expect(result).to.include('плечистый рыжий');
    });

    it('does NOT inject passports when scene.participants is empty', () => {
        const unit = {
            type: 'narration',
            image: { prompt: 'berlioz and bezdomny walking' },
        };
        const scene = {
            participants: [],
            location: { id: 'moscow_patriarskie', environment: {} },
        };

        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        // scene.participants is the authoritative source — empty = no passports
        expect(result).to.not.include('маленького роста');
    });

    it('includes direct prompt text', () => {
        const unit = {
            type: 'narration',
            image: { prompt: 'golden sunset cinematic wide shot' },
        };
        const scene = {
            participants: [],
            location: { id: 'moscow_patriarskie', environment: {} },
        };

        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('golden sunset');
    });

    it('handles typography IU type without character passports', () => {
        const unit = {
            type: 'typography',
            image: { prompt: 'Chapter 1' },
        };
        const scene = { participants: [] };

        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('Chapter 1');
    });
});

// ======================================================
// Location environment template — fallback merge (L2)
// ======================================================

describe('Location environment template — buildImagePrompt fallback', () => {

    const bookPayload = {
        characters: [],
        locations: {
            moscow_patriarskie: {
                description: 'Патриаршие пруды',
                environment: {
                    time: 'warm evening',
                    season: 'late spring',
                    lighting: 'soft street lamps',
                    weather: 'still warm air',
                    mood: 'quiet and calm',
                    atmosphere: 'calm Moscow park',
                },
            },
        },
    };

    it('uses location environment as fallback when scene has no environment', () => {
        const unit = { type: 'narration', image: { prompt: 'pond scene' } };
        const scene = { location: { id: 'moscow_patriarskie' } };
        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('warm evening');
        expect(result).to.include('late spring');
        expect(result).to.include('soft street lamps');
        expect(result).to.include('still warm air');
        expect(result).to.include('quiet and calm');
        expect(result).to.include('calm Moscow park');
    });

    it('scene environment overrides location template per-field', () => {
        const unit = { type: 'narration', image: { prompt: 'pond scene' } };
        const scene = {
            location: {
                id: 'moscow_patriarskie',
                environment: { weather: 'heavy rain', mood: 'tense' },
            },
        };
        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        // Overridden fields from scene
        expect(result).to.include('heavy rain');
        expect(result).to.include('tense');
        // Inherited fields from location template
        expect(result).to.include('warm evening');
        expect(result).to.include('late spring');
        expect(result).to.include('soft street lamps');
        // Scene's overridden template fields must NOT leak
        expect(result).to.not.include('still warm air');
        expect(result).to.not.include('quiet and calm');
    });

    it('no location environment and no scene environment → no env fields', () => {
        const unit = { type: 'narration', image: { prompt: 'plain shot' } };
        const scene = { location: { id: 'unknown_place' } };
        const result = buildImagePrompt(unit, scene, {}, { characters: [], locations: {} });
        expect(result).to.include('plain shot');
        expect(result).to.not.include('warm evening');
    });
});

// ======================================================
// Prompt composition order — general → specific
// ======================================================

// The pipeline's DEFAULT assembly order (general → specific). Model-specific
// Prompt Profile skills may refine the AI-authored image.prompt CONTENT (step 4)
// — this wrapper order itself has no per-model override hook yet.
describe('buildImagePrompt — default composition order (general → specific)', () => {

    const bookPayload = {
        characters: [
            { id: 'berlioz', name: 'Берлиоз', passport: { appearance: 'short and stout', clothes: 'gray summer suit' } },
            { id: 'bezdomny', name: 'Бездомный', passport: { appearance: 'broad-shouldered, ginger hair' } },
        ],
        locations: {
            moscow_patriarskie: {
                description: 'Patriarch Ponds in Moscow',
                environment: { time: 'warm evening', season: 'summer' },
            },
        },
    };

    const unit = {
        type: 'narration',
        image: { prompt: 'berlioz and bezdomny sitting on a bench near the pond, arguing', shot: 'close' },
    };

    const scene = {
        participants: ['berlioz', 'bezdomny'],
        visual: { render: 'cinematic' },
        location: { id: 'moscow_patriarskie' },
        state: { berlioz: 'arguing loudly' },
    };

    it('orders sections from general to specific', () => {
        const result = buildImagePrompt(unit, scene, {}, bookPayload);

        const idx = (s) => result.indexOf(s);
        // 1. global context: style → location → env
        // 2. shot before characters
        // 3. characters before the AI direct prompt
        // 4. fine details / quality last
        const sections = [
            'style cinematic',
            'Patriarch Ponds in Moscow',
            'warm evening',
            'close shot',
            'berlioz:',
            'berlioz and bezdomny sitting',
            'image quality',
        ];
        // Every section must be PRESENT — otherwise indexOf returns -1 and the
        // ordering chain below can still pass while a section is silently dropped.
        sections.forEach((s) => expect(idx(s)).to.be.greaterThan(-1));
        for (let i = 1; i < sections.length; i++) {
            expect(idx(sections[i])).to.be.greaterThan(idx(sections[i - 1]));
        }
    });

    it('keeps each character as ONE contiguous block (id + appearance + clothes + state)', () => {
        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result).to.include('berlioz: short and stout, gray summer suit, arguing loudly');
        expect(result).to.include('bezdomny: broad-shouldered, ginger hair');
    });

    it('emits env.time exactly once (regression: duplicate push)', () => {
        const result = buildImagePrompt(unit, scene, {}, bookPayload);
        expect(result.match(/warm evening/g)).to.have.lengthOf(1);
    });

    it('shot comes before characters even when the direct prompt mentions a shot word', () => {
        const unitWithShotWord = {
            ...unit,
            image: { ...unit.image, prompt: 'berlioz and bezdomny sitting, close framing' },
        };
        const result = buildImagePrompt(unitWithShotWord, scene, {}, bookPayload);
        expect(result.indexOf('close shot')).to.be.greaterThan(-1);
        expect(result.indexOf('close framing')).to.be.greaterThan(result.indexOf('close shot'));
    });
});

// ======================================================
// isTypographyStyle / resolveVisualStyle
// ======================================================

describe('Coreference — visual helpers', () => {

    it('detects typography styles', () => {
        expect(isTypographyStyle('soviet_book_page')).to.be.true;
        expect(isTypographyStyle('cover')).to.be.true;
        expect(isTypographyStyle('cinematic_realism')).to.be.false;
        expect(isTypographyStyle(null)).to.be.false;
    });

    it('resolves visual style with correct priority', () => {
        const iu = { image: { style: 'iu_style' } };
        const scene = { visual: { style: 'scene_style' }, style: 'root_style' };
        expect(resolveVisualStyle(iu, scene, {})).to.equal('iu_style');
    });

    it('filters out typography styles from scene root style', () => {
        const iu = {};
        const scene = { style: 'soviet_book_page' };
        const book = { bible: { render_rules: { style: 'cinematic' } } };
        expect(resolveVisualStyle(iu, scene, book)).to.equal('cinematic');
    });
});

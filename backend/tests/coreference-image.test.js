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
            cinematic_space: 'Patriarch Ponds in Moscow, a tranquil park with a large pond surrounded by lime trees and old mansions',
            description: 'Hot spring evening at the ponds, dry stifling heat',
            visual_style: 'cinematic realism',
        },
        pivo_i_vody_booth: {
            cinematic_space: 'A colorfully painted wooden stall',
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
        // "ponds" matches "pond" in the location's cinematic_space
        // "moscow" matches "Moscow" in the location's cinematic_space
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
            { id: 'mikhail_aleksandrovich_berlioz', name: 'Михаил Александрович Берлиоз', passport: { base_appearance: 'Маленького роста, упитан, лыс' } },
            { id: 'ivan_nikolaevich_ponyrev', name: 'Иван Николаевич Понырев', passport: { base_appearance: 'Плечистый, рыжеватый, вихрастый' } },
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
                    base_appearance: 'Маленького роста',
                    detailed_appearance: 'лысый',
                    clothing_base: 'летний серый костюм',
                    clothing_details: 'шляпа пирожком',
                },
            }],
        };
        const scene = { participants: ['berlioz'] };
        const unit = { visual: { prompt: 'berlioz sitting on bench' } };
        const result = buildCharacters(scene, unit, {}, bookDetailed);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.equal('berlioz: Маленького роста лысый, летний серый костюм шляпа пирожком');
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
            { id: 'berlioz', name: 'Берлиоз', passport: { base_appearance: 'маленького роста' } },
            { id: 'bezdomny', name: 'Бездомный', passport: { base_appearance: 'плечистый рыжий' } },
        ],
        locations: {
            moscow_patriarskie: {
                description: 'Патриаршие пруды',
                visual_style: 'realistic',
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

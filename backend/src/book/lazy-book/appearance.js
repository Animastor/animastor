// ======================================================
// Lazy Book — Appearance Fragmentation
// ======================================================

// Clothing-span matcher used by extractClothing.
// Matches "wearing/dressed in …" phrases plus explicit clothing-item phrases
// (EN + RU).
const CLOTHING_RE = /((?:wearing|dressed in|in a|in an|clad in|adorned in|wore|wears|wearing a|dressed|clothed|attired|outfitted|одет(?:ый|ая|ые)?\s+в|надет(?:а|о|ы)?|облачен(?:а|о|ы)?|носит(?:а|о)?)\s+[^.,;!?]{3,60})|([^.,;!?]{3,60}(?:suit|shirt|coat|dress|hat|jacket|tie|shoes|boots|uniform|robe|cloak|outfit|sweater|vest|hoodie|pants|jeans|skirt|scarf|gloves|belt|cape|gown|tunic|armor|crown|necklace|ring)[^.,;!?]{0,40})|((?:костюм|пиджак|брюк|шляп|кепк|фуражк|рубашк|сорочк|галстук|пальто|плать|ботинк|сапог|халат|куртк|сюртук|жилет|френч|шинел|мундир|плащ|шарф|перчатк|ремень|пояс|кепка|фуражка)[^.,;!?]{0,40})/gi;


function fragmentAppearanceForVideo(appearance, charName) {
    if (!appearance || appearance.length < 5) {
        return `${charName.toLowerCase()} character, distinctive appearance`;
    }

    const sentences = appearance.match(/[^.!?]+[.!?]+/g) || [appearance];

    const fragments = [];

    // BOTH alternatives must be capturing groups: the replacement string is
    // '$1 $2', and a non-capturing second group makes $2 resolve to the literal
    // text "$2" (JS keeps unknown $n as-is) — leaking "$2 stature..." into
    // video_tokens. Group 1 = age phrase, group 2 = build word.
    const ageBuildRe = /(\d+[-\s]year[-\s]old|young|middle[-\s]aged|elderly|old|teen|child|\bkid\b|toddler|infant|adult)|(thin|slim|stocky|muscular|strong|heavy|overweight|obese|frail|petite|broad|wide|narrow|tall|short|average|athletic|lean|buff|chubby|plump|curvy|slender|small|large)/i;
    for (const s of sentences) {
        const match = s.match(ageBuildRe);
        if (match) {
            const frag = s.replace(ageBuildRe, '$1 $2').split(/[.,;]/)[0].trim();
            const clean = frag.replace(/^(his|her|a |the |an )/i, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const faceHairRe = /(?:face|hair|eyes|brow|beard|moustache|mustache|whisker|cheek|chin|jaw|nose|lips|mouth|forehead|skin|complexion|pale|wrinkle|freckle|scar|clean[-\s]shaven|bald|haired|hairstyle|bearded|glasses|spectacles|oculus)/i;
    const faceHairRu = /(?:лиц|волос|глаз|бров|бород|ус|щек|подбород|нос|губ|рот|лоб|кож|морщин|веснуш|шрам|брит|лыс|очк)/i;
    for (const s of sentences) {
        if (faceHairRe.test(s) || faceHairRu.test(s)) {
            const clean = s.replace(/^(his|her|a |the |an |его|ее|его|их|моя|мои|наши)/i, '').trim();
            if (clean.length > 5 && clean.length < 80) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const clothingRe = /(?:wearing|dressed|suit|shirt|coat|dress|hat|jacket|tie|shoes|boots|uniform|robe|cloak|outfit|sweater|vest|hoodie|pants|jeans|skirt|scarf|gloves|belt|cape|gown|tunic|armor|crown|necklace|bracelet|ring|earring|tattoo|piercing)|(?:костюм|пиджак|брюк|шляп|кепк|фуражк|рубашк|сорочк|галстук|пальто|плать|ботинк|сапог|халат|куртк|сюртук|жилет|френч|шинел|мундир|плащ|шарф|перчатк|ремень|пояс)/i;
    for (const s of sentences) {
        if (clothingRe.test(s)) {
            const clean = s.replace(/^(in |wearing |dressed in |a |the |his |her |одет|в |надет|облачен)/i, '').trim();
            if (clean.length > 3 && clean.length < 80) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    const featureRe = /(?:distinctive|unusual|notable|remarkable|striking|peculiar|curious|strange|odd|unique|special|особ|необыч|примечател|выдающ|стран|уникал)/i;
    for (const s of sentences) {
        if (featureRe.test(s)) {
            let clean = s.replace(featureRe, '').replace(/^(his|her|a |the |an |with a |with |has a |имеет|обладает|c |со |сво|его|ее)/i, '').trim();
            clean = clean.replace(/[.,;:!?]+$/, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                break;
            }
        }
    }

    if (fragments.length < 2) {
        const parts = appearance.split(/[,;]/).map(p => p.trim()).filter(p => p.length > 3);
        for (const part of parts) {
            if (/выглядит|кажется|похож|как будто|словно|looks? like|seems|appears|feels|emotion|trembl|тревог|волн|радост|груст|печал|страх|испуг|удивлен/i.test(part)) continue;
            const clean = part.replace(/^(a |the |his |her |an |and |with )/i, '').trim();
            if (clean.length > 5 && clean.length < 60) {
                fragments.push(clean.toLowerCase());
                if (fragments.length >= 4) break;
            }
        }
    }

    const unique = [];
    for (const f of fragments) {
        const isDuplicate = unique.some(u =>
            u.includes(f) || f.includes(u) ||
            u.split(/\s+/).slice(0, 3).join(' ') === f.split(/\s+/).slice(0, 3).join(' ')
        );
        if (!isDuplicate) unique.push(f);
    }

    let result = unique.join(', ');
    if (result.length > 120) {
        result = result.substring(0, 120).replace(/\s+\S*$/, '');
    }

    return result || `${charName.toLowerCase()} character, distinctive appearance`;
}

function extractClothing(appearance) {
    if (!appearance) {
        return {
            clothingBase: 'period-appropriate clothing',
            clothingDetails: 'clothing as described in the narrative',
        };
    }

    const matches = appearance.match(CLOTHING_RE);

    if (matches && matches.length > 0) {
        const cleanMatches = matches
            .map(m => m.replace(/^(in |a |the |his |her |wearing |dressed |clad in|adorned in|wore|wears|одет|в |надет|облачен|на нем|на ней|на нем была|на ней была)/i, '').trim())
            .filter(m => m.length > 3);

        if (cleanMatches.length > 0) {
            return {
                clothingBase: cleanMatches[0].toLowerCase(),
                clothingDetails: cleanMatches.slice(0, 3).join('; ').toLowerCase(),
            };
        }
    }

    const fallbackRe = /(?:в [^.,;!?]{5,60}|[нН]осит [^.,;!?]{5,60}|одет[аоы]? [в] [^.,;!?]{5,60}|wear(?:ing)? [^.,;!?]{5,60}|dressed [^.,;!?]{5,60}|clad [^.,;!?]{5,60})/i;
    const fallbackMatch = appearance.match(fallbackRe);
    if (fallbackMatch) {
        return {
            clothingBase: fallbackMatch[0].trim().toLowerCase(),
            clothingDetails: fallbackMatch[0].trim().toLowerCase(),
        };
    }

    return {
        clothingBase: 'period-appropriate clothing',
        clothingDetails: 'clothing as described in the text',
    };
}

module.exports = {
    fragmentAppearanceForVideo,
    extractClothing,
};

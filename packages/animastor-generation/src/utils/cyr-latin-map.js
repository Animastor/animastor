// ======================================================
// Cyrillic → Latin Transliteration Map — @animastor/generation internal copy
// ======================================================
// PACKAGE-INTERNAL COPY (S-7 — physical package extraction): the pure
// transliteration data + function the prompt-profiles text normalizers need.
// The package must not reach into the host backend/src tree, so this pure
// data lives here.
//
// It is the SAME pure data + pure function, byte-identical to the host leg
// (backend/src/utils/cyr-latin-map.js — itself a byte-parity mirror of the
// canonical @animastor/editor package copy, Phase 4.1) — NOT a second
// implementation. Deep-equal/behavior parity with the host leg is guarded by
// backend/tests/architecture/generation-package-boundary.test.js (G7-M);
// edit the canonical source first, then mirror the change in the same commit.

// ===8<=== canonical source (verbatim, do not edit) ====================
// ======================================================
// Cyrillic → Latin Transliteration Map
// ======================================================
// Canonical single-source map used by entity-id (Editor) and
// image/helpers (prompt normalization). Pure data + one pure
// function — zero host/runtime dependencies.

const CYR_LATIN_MAP = {
    'А':'A','а':'a','Б':'B','б':'b','В':'V','в':'v','Г':'G','г':'g','Д':'D','д':'d',
    'Е':'Ye','е':'e','Ё':'Yo','ё':'yo','Ж':'Zh','ж':'zh','З':'Z','з':'z','И':'I','и':'i',
    'Й':'Y','й':'y','К':'K','к':'k','Л':'L','л':'l','М':'M','м':'m','Н':'N','н':'n',
    'О':'O','о':'o','П':'P','п':'p','Р':'R','р':'r','С':'S','с':'s','Т':'T','т':'t',
    'У':'U','у':'u','Ф':'F','ф':'f','Х':'Kh','х':'kh','Ц':'Ts','ц':'ts','Ч':'Ch','ч':'ch',
    'Ш':'Sh','ш':'sh','Щ':'Shch','щ':'shch','Ъ':'','ъ':'','Ы':'Y','ы':'y','Ь':'','ь':'',
    'Э':'E','э':'e','Ю':'Yu','ю':'yu','Я':'Ya','я':'ya',
};

function cyrToLatin(text) {
    return text.split('').map(ch => CYR_LATIN_MAP[ch] || ch).join('');
}

module.exports = { CYR_LATIN_MAP, cyrToLatin };
// ===8<=== end canonical source ========================================

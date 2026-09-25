// ======================================================
// Cyrillic → Latin Transliteration Map
// ======================================================
// Canonical single-source map used by entity-id (Editor), the Generation
// prompt-profiles text normalizers and the image prompt normalization.
// Pure data + one pure function — zero host/runtime dependencies.
//
// HOME HISTORY: this pure map previously existed in three coordinated
// places (editor package canonical + two byte-parity host/package mirrors).
// The post-reconnaissance adoption (2026-09-25) made Generation the
// canonical home for the dirty-grammar tier and DELETED the host mirror
// (backend/src/utils/cyr-latin-map.js); the Editor package keeps its own
// internal copy by ITS boundary doctrine (the editor package exposes its
// root only and must not gain a generation dependency) — parity between
// the two remaining copies is guarded by
// backend/tests/architecture/generation-package-boundary.test.js (G7-M,
// re-pointed at this file) and editor-package-boundary.test.js (PB5).
// Edit one canonical copy first, mirror in the same commit.

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

// ─────────────────────────────────────────────────────
// Structure id PREVIEW helper (chapter / scene / unit).
//
// The server is the single authority for ids (backend/book/lazy-book/paths.js:
// `prefix + '-' + crypto.randomBytes(4).toString('hex')`). These mirrors exist
// ONLY so the add dialogs can show a readonly id preview; on save the server
// keeps the proposed id when unique and otherwise regenerates it (the dialogs
// never validate uniqueness themselves). This is a trivial random-hex format,
// NOT the cyrToLatin transliteration algorithm — that stays server-only.
// ─────────────────────────────────────────────────────
function generateHexId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}-${hex}`;
}

export const chapterId = (): string => generateHexId('ch');
export const sceneId = (): string => generateHexId('sc');
export const unitId = (): string => generateHexId('iu');
// HOST SHIM — re-export of the @animastor/editor package.
// Legacy path kept for consumers (relocation checklist §2.4).
// The Editor contour physically lives in packages/animastor-editor
// (@animastor/editor) since the Phase 4 physical move
// (docs/architecture/editor-module-extraction-audit.md — Phase 4).

module.exports = require('@animastor/editor');

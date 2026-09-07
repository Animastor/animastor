// ======================================================
// HOST SHIM — re-export of the @animastor/vbook-runtime package
// ======================================================
// The VBook runtime physically lives in packages/animastor-vbook-runtime.
// This one-line shim keeps the legacy `backend/src/book` require path
// working while consumers migrate (relocation checklist §2.4).
// Do NOT add book-domain code here.

module.exports = require('@animastor/vbook-runtime');

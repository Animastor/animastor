// ======================================================
// S-6 PORT: ProfileStore — machine-readable prompt-profile loading
// ======================================================
// Generation Core must not read the host filesystem/backend service layer.
// generation/prompt-profiles/assembly-profile.js (the shared prompt-assembly
// resolver for audio+image+video) consumes THIS port; the host adapter
// binds services/ai-loader.getAssemblyProfile (ai/profiles/**/*.json file
// loading + mtime cache) at the composition root.
//
//   generation/prompt-profiles/assembly-profile.js  (Generation Core)
//       ↓ resolves profiles through
//   generation/ports/profile-store       ← THIS PORT (Generation-owned)
//       ↑ wired by the host
//   services/ai-loader.getAssemblyProfile (host adapter — file loading)
//
// CONTRACT (frozen — 1:1 with the former direct ai-loader call):
//   getAssemblyProfile(name) → profile object | null
//     - name: 'type/profileName' (e.g. 'image/qwen-image')
//     - null when the named profile file does not exist (the resolver's
//       built-in TYPE_DEFAULTS then apply — there is no 'default' profile)
//
// This is the port the S-4 reconnaissance documented as the single
// Generation Core → host edge (§25.5 "ProfileStore"); it closes the last
// services/ require inside the generation/ package seed.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

let impl = null;

/**
 * Wire the host profile-store adapter. Called once by the composition root
 * (backend.cjs) — profile resolution is lazy (call time), but the wiring
 * must happen before any prompt assembly runs.
 * @param {{ getAssemblyProfile: (name: string) => object|null }} adapter
 */
function setProfileStore(adapter) {
    if (!adapter || typeof adapter.getAssemblyProfile !== 'function') {
        throw new Error('profile-store: adapter must implement getAssemblyProfile(name)');
    }
    impl = adapter;
}

/**
 * Resolve the store at CALL time. Fail-fast with a wiring instruction —
 * an unwired port must never be mistaken for "no profiles configured"
 * (that would silently degrade every prompt to the built-in defaults).
 * @param {string} name — 'type/profileName'
 */
function getAssemblyProfile(name) {
    if (!impl || typeof impl.getAssemblyProfile !== 'function') {
        throw new Error(
            'profile-store: not wired — the composition root must call ' +
            'setProfileStore({ getAssemblyProfile }) before prompt assembly runs (S-6)'
        );
    }
    return impl.getAssemblyProfile(name);
}

function isProfileStoreWired() {
    return !!(impl && typeof impl.getAssemblyProfile === 'function');
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetProfileStore() {
    impl = null;
}

module.exports = {
    setProfileStore,
    getAssemblyProfile,
    isProfileStoreWired,
    _resetProfileStore,
};

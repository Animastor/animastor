// ======================================================
// @animastor/generation — PACKAGE ENTRYPOINT (public API)
// ======================================================
// The Generation domain of the Animastor backend, physically extracted from
// the host (backend/src/generation/** — deleted by the extraction commit;
// docs/architecture/generation-module-extraction-reconnaissance.md §29).
//
// The package owns (the S-1…S-6 prepared Generation Core):
//   core/            — the media capability registry (S-2), the default
//                      capability registrations, the pure task-registry
//                      domain (S-4), the pure per-asset FSM contract (S-4),
//                      and the canonical artifact filename grammar (S-4)
//   providers/       — the SINGLE Generation → ComfyUI/GPU provider seam
//                      (S-3): workflow/connector knowledge + Job Protocol v2
//                      dispatch through the DispatchTransport port
//   prompt-profiles/ — the shared prompt-assembly profile resolver and
//                      character-reference/mention normalizers (S-4)
//   ports/           — the frozen S-6 host ports: DispatchTransport,
//                      GenerationConfig, ProfileStore, BookData — the ONLY
//                      way the package reaches the host
//
// The package NEVER requires backend/src/** (G7-B): host-specific concerns
// (Redis/PG clients, runtime-config, filesystem, Express, book model,
// GPU dispatcher, AI loader) are injected through the ports at the
// composition root (backend.cjs / backend/tests/generation-test-bindings.cjs).
//
// PUBLIC SURFACE (frozen — G7-G pins this object):
//   artifactNaming              — canonical artifact filename grammar
//   mediaRegistry               — media capability registry (+ resolvers)
//   bootstrap()                 — eager default media-type registration
//                                 (the S-2 startup registration; the
//                                 registry also self-bootstraps lazily)
//   generationProgress          — pure task-registry domain logic
//   sceneState                  — per-asset FSM contract (states,
//                                 transitions, validation, normalization)
//   comfyuiProvider             — the S-3 provider seam
//   promptProfiles              — { assemblyProfile, characterUtils,
//                                   promptTextUtils }
//   ports                       — { dispatchTransport, generationConfig,
//                                   profileStore, bookData }
//
// LAZY SURFACE: the root module has ZERO top-level requires and ZERO
// side effects at require time (G7-L: the package loads independently of
// any host and of any port wiring — unwired ports fail fast only when
// USED, exactly like the pre-extraction backend/src/generation modules).
// Each property materializes its module on first access.
//
// Deliberately NOT exported (internal namespaces, G7-H): core/*, providers/*,
// prompt-profiles/*, ports/*, utils/* as deep-import paths — the package
// exports map exposes ONLY '.'.

'use strict';

const surface = {
    // ── core domain ─────────────────────────────────────────────────
    artifactNaming: () => require('./core/artifact-naming'),
    mediaRegistry: () => require('./core/media-registry'),
    generationProgress: () => require('./core/generation-progress'),
    sceneState: () => require('./core/scene-state'),

    // ── provider seam (S-3) ─────────────────────────────────────────
    comfyuiProvider: () => require('./providers/comfyui-provider'),

    // ── prompt profiles (S-4) ───────────────────────────────────────
    promptProfiles: () => ({
        assemblyProfile: require('./prompt-profiles/assembly-profile'),
        characterUtils: require('./prompt-profiles/character-utils'),
        promptTextUtils: require('./prompt-profiles/prompt-text-utils'),
    }),

    // ── frozen host ports (S-6) ─────────────────────────────────────
    ports: () => ({
        dispatchTransport: require('./ports/dispatch-transport'),
        generationConfig: require('./ports/generation-config'),
        profileStore: require('./ports/profile-store'),
        bookData: require('./ports/book-data'),
    }),
};

for (const [name, load] of Object.entries(surface)) {
    Object.defineProperty(module.exports, name, {
        enumerable: true,
        configurable: false,
        get() { return load(); },
    });
}

/**
 * Eager default media-type registration (the S-2 startup entry — formerly the
 * composition root loaded core/default-registrations directly; S-7 exposes it
 * through this named entry). Loads core/default-registrations, which reads the
 * GenerationConfig port — the host MUST wire the config port
 * (bindGenerationConfig) BEFORE calling this. The registry also self-bootstraps
 * lazily on first access, but the composition root registers eagerly for
 * deterministic startup.
 */
function bootstrap() {
    require('./core/default-registrations');
}

Object.defineProperty(module.exports, 'bootstrap', {
    enumerable: true,
    configurable: false,
    value: bootstrap,
});

# Changelog

## 0.1.1 (2026-09-26)

The dirty-grammar tier (scene-change → dirty-layer grammar) adopted from the
host post-reconnaissance (`refactor(backend): adopt pure analysis into
packages` 1900d931 + `fix(generation): export dirty grammar dependency graph`
d4894232). Additive release — no existing export, signature, or behavior
changed.

### Features

- New module `src/dirty-grammar/` — the scene-change → dirty-layer grammar:
  the Prompt Dependency Registry (per-layer field lists, cross-layer
  dependencies, character reference detection), the layer→layer dependency
  graph (`computeSceneDirtyLayers`, `getLayerDependencies`,
  `resolveDirtyLayers`, `DEPENDENCY_GRAPH`), scene-hash fingerprinting
  (`computeSceneHash`, `computeBookHash`, `shortHash`, `generateBuildId`),
  speech-estimation (`estimateSpeechDurationSec`), and the canonical
  cyr→latin map (`cyrToLatin`, `CYR_LATIN_MAP`). Pure sync, no I/O.
- New subpath export `@animastor/generation/dirty-grammar` and the
  `dirtyGrammar` tier on the root entrypoint.
- Fix: `src/core/media-registry.js` — corrected the relative require path
  for the registry bootstrap (host-adoption follow-up).

## 0.1.0 (2026-09-11)

First release — the media-generation domain core physically extracted from
the Animastor backend host: media capability registry, generation task
registry, per-asset state FSM contract, canonical artifact filename grammar,
shared prompt-assembly profile resolver, and the single
Generation→ComfyUI/GPU provider seam (Job Protocol v2 dispatch) behind the
four frozen S-6 ports.

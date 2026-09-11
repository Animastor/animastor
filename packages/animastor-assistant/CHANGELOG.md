# Changelog

## 0.1.0

- Initial publishable release of `@animastor/assistant`.
- Chat engine: persona/system prompt assembly, book context (full + compact),
  mode/topic prompts, `edit_book` tool, response parsing and the validated
  JSON-patch pipeline with scene-participants normalization.
- HTTP contour: `/api/v1/ai/*` session CRUD, non-streaming chat and SSE
  streaming (`meta` / `delta` / `done` / `error`).
- Contracts: `AssistantPorts` + chat-session repository interfaces with
  fail-fast assertions.
- Host-agnostic: zero runtime dependencies, no filesystem, no ambient env
  reads; persona content arrives as injected `aiProfile`.

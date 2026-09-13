// @animastor/web-ai-chat public entry point.
//
// Pure AI chat streaming UX helpers — SSE frame mapping, source badge logic,
// error code translation, and cancel detection. Zero host dependencies;
// pure functions and types only.
//
// Host consumers:
//   pages/AiAssistantPage.tsx — sourceBadgeKey, streamErrorKey, isUserCancelled
//
// The package imports nothing but its own internal modules. No host stores,
// no api/client, no i18n, no DOM. The host consumes ONLY through this entry.

export type { AiSource } from './chatStream';
export { sourceBadgeKey, streamErrorKey, isUserCancelled } from './chatStream';

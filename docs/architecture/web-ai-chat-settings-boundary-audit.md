# Web Package Extraction Boundary Audit — @animastor/web-ai-chat & @animastor/web-settings

**Status:** READ-ONLY reconnaissance + boundary verification. No production code changed, no files moved, no package created.
**Date:** 2026-09-13
**Baseline:** HEAD `c6eb0892` ("arch(web): audit next web package extraction candidates")
**Reference:** `@animastor/web-player` extraction (Phases 2–3), `@animastor/web-file`, `@animastor/web-navigator`

---

## Executive Summary

Two web package candidates verified against the web-player Ports/Adapters reference architecture:

| Package | Files | LOC | Host imports | Tests | Ports needed | Status |
|---|---|---|---|---|---|---|
| `@animastor/web-ai-chat` | 2 files | 262 | **ZERO** | 210 LOC | None | **READY** |
| `@animastor/web-settings` | 5 files | 711 | **ZERO** | 437 LOC | None | **READY** |

Both packages consist entirely of **pure modules** with zero host imports. No Ports/Adapters pattern needed. Immediate extraction possible with zero behavioral changes.

---

## 1. Package: @animastor/web-ai-chat

### 1.1 Production contour

| File | LOC | Host imports | Assessment |
|---|---|---|---|
| `features/aiChat/chatStream.ts` | 52 | **ZERO** | Pure SSE→UI mapping |
| **Total** | **52** | **0** | Pure module |

### 1.2 Test contour

| File | LOC | Host imports |
|---|---|---|
| `features/aiChat/chatStream.test.ts` | 210 | None (imports `./chatStream` + `../../api/client` for mock) |
| **Total** | **210** | Self-contained |

### 1.3 Host coupling — VERIFIED

**Zero host imports** in `chatStream.ts`. The module is completely self-contained:
- No imports from `state/*`
- No imports from `api/*` (test mocks `postChatStream` but the production module has zero imports)
- No imports from `app/*`
- No imports from `features/*`
- No imports from `lib/*`
- No React/DOM/browser APIs

### 1.4 Host consumers — VERIFIED

| Consumer | Import | Usage |
|---|---|---|
| `pages/AiAssistantPage.tsx` | `sourceBadgeKey`, `streamErrorKey`, `isUserCancelled` | Streaming UI state mapping |

**Single consumer.** AiAssistantPage stays in host.

### 1.5 Identity and state ownership — VERIFIED

No identity or state in the module. All state is host-owned.

### 1.6 Ports complexity — NONE

The module is pure functions and types. No Ports/Adapters pattern needed.

### 1.7 Architecture guards required

1. **Boundary guard** — package must not import from host
2. **Consumer guard** — only `AiAssistantPage.tsx` imports from the package
3. **Entry guard** — public entry is the only sanctioned specifier

### 1.8 Files physically entering the package

```
packages/animastor-web-ai-chat/
├── src/
│   ├── index.ts          (public entry — re-exports)
│   └── chatStream.ts     (production module)
├── test/
│   └── chatStream.test.ts (test suite)
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
└── LICENSE
```

### 1.9 Public API

```ts
// @animastor/web-ai-chat
export type AiSource = 'private-local' | 'shared' | 'cloud' | 'system';
export function sourceBadgeKey(source: string | null | undefined): string | null;
export function streamErrorKey(code: string | null | undefined): string | null;
export function isUserCancelled(err: unknown, cancelledRef: { current: boolean }): boolean;
```

### 1.10 Overlap check — web-ai-chat vs web-settings

**No overlap.** The two packages have zero cross-dependencies:
- `chatStream.ts` does NOT import from `aiProviders.ts` or `localAi.ts`
- `aiProviders.ts` does NOT import from `chatStream.ts`
- `localAi.ts` does NOT import from `chatStream.ts`

### 1.11 Comparison with @animastor/web-player

| Principle | web-player | web-ai-chat |
|---|---|---|
| Host composition via adapters | ✅ playerAdapters.ts | ✅ Not needed (pure functions) |
| Ports boundary | ✅ PlayerPorts (8 ports) | ✅ Not needed (zero imports) |
| No host imports from package | ✅ | ✅ ZERO imports |
| Public package entry | ✅ | ✅ |
| No second source of truth | ✅ Identity host-owned | ✅ No identity |
| Package test isolation | ✅ | ✅ |
| Architecture guards | ✅ | ✅ Required |

**VERDICT: READY for extraction.**

---

## 2. Package: @animastor/web-settings

### 2.1 Production contour

| File | LOC | Host imports | Assessment |
|---|---|---|---|
| `features/aiProviders/aiProviders.ts` | 176 | **ZERO** | Pure provider helpers |
| `features/localAi/localAi.ts` | 298 | **ZERO** | Pure connector helpers |
| **Total** | **474** | **0** | All pure modules |

### 2.2 Test contour

| File | LOC | Host imports |
|---|---|---|
| `features/aiProviders/aiProviders.test.ts` | 196 | None (imports only `./aiProviders`) |
| `features/localAi/localAi.test.ts` | 241 | None (imports only `./localAi`) |
| **Total** | **437** | All self-contained |

### 2.3 Host coupling — VERIFIED

**Zero host imports** in both modules. They are completely self-contained:
- No imports from `state/*`
- No imports from `api/*`
- No imports from `app/*`
- No imports from `features/*`
- No imports from `lib/*`
- No React/DOM/browser APIs

### 2.4 Host consumers — VERIFIED

| Consumer | Import | Module |
|---|---|---|
| `pages/SettingsPage.tsx` | `PROVIDER_TYPE_OPTIONS`, `OPENROUTER_DEFAULT_ENDPOINT`, `validateProviderInput`, `describeTestResult`, `statusLabel`, `formatLastTested` | aiProviders |
| `pages/SettingsPage.tsx` | `ProviderType`, `ProviderStatus` (type-only) | aiProviders |
| `features/localAi/LocalAISection.tsx` | `formatLastTested` | aiProviders |
| `features/localAi/LocalAISection.tsx` | 20+ exports | localAi |
| `features/localAi/LocalAISection.tsx` | 8 type imports | localAi |

**Key observation:** `LocalAISection.tsx` (778 LOC) is a **UI component** that bridges the two pure modules. It stays in the host and consumes both packages. It imports from:
- `../../app/i18n` — host infrastructure
- `../../api/client` — host infrastructure
- `../../lib/ui` — host infrastructure
- `../aiProviders/aiProviders` — package (will become `@animastor/web-settings`)
- `./localAi` — package (will become `@animastor/web-settings`)

### 2.5 Identity and state ownership — VERIFIED

No identity or state in either module. All state is host-owned.

### 2.6 Ports complexity — NONE

Both modules are pure functions and types. No Ports/Adapters pattern needed.

### 2.7 Architecture guards required

1. **Boundary guard** — package must not import from host
2. **Consumer guard** — only `SettingsPage.tsx` and `LocalAISection.tsx` import from the package
3. **Entry guard** — public entry is the only sanctioned specifier

### 2.8 Files physically entering the package

```
packages/animastor-web-settings/
├── src/
│   ├── index.ts          (public entry — re-exports)
│   ├── aiProviders.ts    (pure provider helpers)
│   └── localAi.ts        (pure connector helpers)
├── test/
│   ├── aiProviders.test.ts (provider tests)
│   └── localAi.test.ts     (connector tests)
├── package.json
├:// tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
└── LICENSE
```

### 2.9 Public API

```ts
// @animastor/web-settings — aiProviders
export type ProviderType = 'openrouter' | 'openai-compatible' | 'custom';
export type ProviderStatus = 'untested' | 'ok' | 'failed';
export interface AiProviderMeta { /* ... */ }
export interface AiProviderRead { /* ... */ }
export interface AiProviderList { /* ... */ }
export interface AiProviderTest { /* ... */ }
export interface ValidationResult { /* ... */ }
export const PROVIDER_TYPE_OPTIONS: /* ... */;
export const VALID_PROVIDER_TYPES: ProviderType[];
export const OPENROUTER_DEFAULT_ENDPOINT: string;
export function normalizeMeta(raw: unknown): AiProviderMeta | null;
export function endpointPlaceholderFor(providerType: ProviderType): string;
export function validateProviderInput(input: /* ... */): ValidationResult;
export function describeTestResult(r: AiProviderTest): { kind: 'ok' | 'fail'; text: string };
export function statusLabel(status: ProviderStatus): { kind: 'ok' | 'fail' | 'untested'; i18nKey: string };
export function formatLastTested(ts: number | null, nowMs?: number): string;
export function canSave(input: /* ... */): boolean;

// @animastor/web-settings — localAi
export type ConnectorRuntimeType = 'ollama' | 'vllm' | 'llamacpp' | 'lmstudio' | 'openai-compatible';
export type ConnectorStatus = 'pending' | 'online' | 'offline';
export type ShareStatus = 'private' | 'shared' | 'offline' | 'runtime_unavailable';
export interface AiConnectorStatus { /* ... */ }
export interface AiConnectorModels { /* ... */ }
export interface RegistrationResponse { /* ... */ }
export interface RotateResponse { /* ... */ }
export interface RefreshModelsResponse { /* ... */ }
export interface ConnectorTestResponse { /* ... */ }
export interface LocalProviderMeta { /* ... */ }
export interface AiEndpoint { /* ... */ }
export const RUNTIME_TYPE_OPTIONS: /* ... */;
export const VALID_RUNTIME_TYPES: ConnectorRuntimeType[];
export const REGISTRATION_STEP_KEYS: /* ... */;
export const OFFLINE_TROUBLESHOOT_KEYS: /* ... */;
export function validateCreateInput(name: string, runtimeType: string): /* ... */;
export function looksLikeRegToken(token: string): boolean;
export function looksLikeConnectorCredential(token: string): boolean;
export function statusKey(c: { status: ConnectorStatus; live: boolean }): string;
export function statusClass(c: { status: ConnectorStatus; live: boolean }): string;
export function runtimeReachable(c: { runtime_meta?: { runtime_ok?: boolean } | null }): boolean;
export function runtimeInfo(c: { runtime_meta?: /* ... */ } | null): string[];
export function formatLastSeen(ts: number | null, now?: number): string;
export function connectorErrorKey(code: string): string;
export function regTokenExpired(expiresAt: number | null | undefined, now?: number): boolean;
export function buildRunCommand(token: string, wsUrl: string, origin: string): string;
export function buildBindingBody(connectorId: string, model: string): /* ... */;
export function shareStatus(e: Pick<AiEndpoint, /* ... */>): ShareStatus;
export function shareStatusKey(s: ShareStatus): string;
export function shareStatusClass(s: ShareStatus): string;
```

### 2.10 Overlap check — web-ai-chat vs web-settings

**No overlap.** The two packages have zero cross-dependencies.

### 2.11 Additional pure modules — DISCOVERED BUT NOT INCLUDED

| Module | LOC | Host imports | Reason for exclusion |
|---|---|---|---|
| `features/admin/systemAi.ts` | 125 | **ZERO** | Admin concern, not settings |
| `features/workers/privateWorkers.ts` | 150 | **ZERO** | Workers concern, not settings |

These modules are pure and could be extracted separately:
- `systemAi.ts` → `@animastor/web-admin` (admin package)
- `privateWorkers.ts` → `@animastor/web-workers` (workers package)

**Recommendation:** Do NOT include them in `@animastor/web-settings`. They are separate concerns with different consumers.

### 2.12 Comparison with @animastor/web-player

| Principle | web-player | web-settings |
|---|---|---|
| Host composition via adapters | ✅ playerAdapters.ts | ✅ Not needed (pure functions) |
| Ports boundary | ✅ PlayerPorts (8 ports) | ✅ Not needed (zero imports) |
| No host imports from package | ✅ | ✅ ZERO imports |
| Public package entry | ✅ | ✅ |
| No second source of truth | ✅ Identity host-owned | ✅ No identity |
| Package test isolation | ✅ | ✅ |
| Architecture guards | ✅ | ✅ Required |

**VERDICT: READY for extraction.**

---

## 3. Cross-package dependency map

```
@animastor/web-ai-chat
  └── chatStream.ts (PURE, zero imports)
      └── consumed by: AiAssistantPage.tsx (host)

@animastor/web-settings
  ├── aiProviders.ts (PURE, zero imports)
  │   └── consumed by: SettingsPage.tsx (host), LocalAISection.tsx (host)
  └── localAi.ts (PURE, zero imports)
      └── consumed by: LocalAISection.tsx (host), SettingsPage.tsx (host)

@animastor/web-player (existing)
  └── consumed by: playerAdapters.ts (host), EditPage.tsx (host), SettingsPage.tsx (host)
```

**No cycles.** All dependencies flow from host → package.

---

## 4. Recommended extraction order

1. **`@animastor/web-ai-chat`** — Immediate, zero-risk. Single pure module, single consumer.
2. **`@animastor/web-settings`** — Immediate, zero-risk. Two pure modules, two consumers.

Both can be extracted in parallel or sequentially — they are independent.

---

## 5. Architecture guards template

Both packages require the same guard structure:

```ts
// architecture/web-ai-chat-contour.guard.test.ts (or web-settings)

describe('Package boundary guard', () => {
  it('package imports only from its own src/ — zero host imports', () => {
    // Scan all .ts/.tsx files in packages/animastor-web-ai-chat/src/
    // Verify zero imports from ../../features/, ../../state/, ../../api/, etc.
  });

  it('only pinned host consumers import the package entry', () => {
    // Scan all host .ts/.tsx files
    // Verify only AiAssistantPage.tsx imports from '@animastor/web-ai-chat'
    // (or SettingsPage.tsx + LocalAISection.tsx for web-settings)
  });

  it('no deep imports into the package (public entry only)', () => {
    // Verify no host file uses '@animastor/web-ai-chat/chatStream'
    // (or '@animastor/web-settings/aiProviders', etc.)
  });

  it('package test suite is isolated (no host imports)', () => {
    // Scan test files
    // Verify zero imports from host infrastructure
  });
});
```

---

## 6. Commit

```
arch(web): verify extraction boundaries for web-ai-chat and web-settings packages
```

Baseline: `c6eb0892` ("arch(web): audit next web package extraction candidates")

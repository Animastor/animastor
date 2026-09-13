# Web Package Extraction Reconnaissance — Next Candidates

**Status:** READ-ONLY reconnaissance. No production code changed, no files moved, no package created.
**Date:** 2026-09-13
**Baseline:** HEAD `71d85aba` ("arch(orchestration): introduce video fsm port")
**Reference:** `@animastor/web-player` extraction (Phases 2–3), `@animastor/web-file`, `@animastor/web-navigator`

## Executive Summary

Three web package candidates assessed against the web-player Ports/Adapters reference architecture:

| Candidate | Boundary | Host coupling | Cycles | Ports complexity | Extraction risk | Approx. scope |
|---|---|---|---|---|---|---|
| `@animastor/web-ai-chat` | Clean (3 pure modules) | Zero (pure) | None | None (no ports needed) | LOW | ~526 LOC + ~647 LOC tests |
| `@animastor/web-editor` | Moderate (3 extractable libs) | Low-Medium (12 host imports in EditPage) | None | Medium (4–5 ports) | MEDIUM | ~785 LOC libs + guards |
| `@animastor/web-generator` | Complex (identity owner) | HIGH (13 host consumers) | None (dissolved) | HIGH (6–8 ports + identity split) | HIGH | ~1323 LOC store + 720 LOC page |

**Recommended extraction order:**
1. `@animastor/web-ai-chat` (immediate, zero-risk)
2. `@animastor/web-editor` (moderate, requires Ports design)
3. `@animastor/web-generator` (requires identity ownership transfer first)

---

## 1. Candidate: animastor-web-ai-chat

### 1.1 Production contour

| File | LOC | Host imports | Assessment |
|---|---|---|---|
| `features/aiChat/chatStream.ts` | 52 | **ZERO** | Pure SSE→UI mapping |
| `features/aiProviders/aiProviders.ts` | 176 | **ZERO** | Pure provider helpers |
| `features/localAi/localAi.ts` | 298 | **ZERO** | Pure connector helpers |
| **Total** | **526** | **0** | All pure modules |

### 1.2 Test contour

| File | LOC | Host imports |
|---|---|---|
| `features/aiChat/chatStream.test.ts` | 210 | None (imports only `./chatStream`) |
| `features/aiProviders/aiProviders.test.ts` | 196 | None (imports only `./aiProviders`) |
| `features/localAi/localAi.test.ts` | 241 | None (imports only `./localAi`) |
| **Total** | **647** | All self-contained |

### 1.3 Host coupling

**Zero host imports** in the three pure modules. The AiAssistantPage (`pages/AiAssistantPage.tsx`, 642 LOC) stays in the host and consumes the package.

AiAssistantPage host imports: `api/client`, `api/models`, `app/i18n`, `app/icons`, `app/titleStore`, `state/generateStore`, `state/positionStore`, `state/resilientReloader`, `state/resourceInvalidations`, `lib/ui`.

### 1.4 Host consumers of the package

- `pages/AiAssistantPage.tsx` — imports `chatStream` (sourceBadgeKey, streamErrorKey, isUserCancelled)
- `pages/SettingsPage.tsx` — imports `aiProviders` and `localAi/LocalAISection`

### 1.5 Identity and state ownership

No identity or state in the pure modules. All state is host-owned.

### 1.6 Ports complexity

**None.** The three modules are pure functions and types. No Ports/Adapters pattern needed. The package can be extracted as-is with zero behavioral changes.

### 1.7 Extraction risk

**LOW.** Pure modules, zero imports, zero identity ownership, self-contained tests. Immediate extraction possible.

### 1.8 Public API

```ts
// @animastor/web-ai-chat
export { sourceBadgeKey, streamErrorKey, isUserCancelled } from './chatStream';
export type { AiSource } from './chatStream';
export { normalizeMeta, validateProviderInput, describeTestResult, statusLabel, formatLastTested, canSave, endpointPlaceholderFor, PROVIDER_TYPE_OPTIONS, VALID_PROVIDER_TYPES, OPENROUTER_DEFAULT_ENDPOINT } from './aiProviders';
export type { ProviderType, ProviderStatus, AiProviderMeta, AiProviderRead, AiProviderList, AiProviderTest, ValidationResult } from './aiProviders';
export { validateCreateInput, looksLikeRegToken, looksLikeConnectorCredential, statusKey, statusClass, runtimeReachable, runtimeInfo, formatLastSeen, connectorErrorKey, regTokenExpired, buildRunCommand, shareStatus, shareStatusKey, shareStatusClass, RUNTIME_TYPE_OPTIONS, VALID_RUNTIME_TYPES, REGISTRATION_STEP_KEYS, OFFLINE_TROUBLESHOOT_KEYS } from './localAi';
export type { ConnectorRuntimeType, ConnectorStatus, AiConnectorStatus, AiConnectorModels, RegistrationResponse, RotateResponse, RefreshModelsResponse, ConnectorTestResponse, LocalProviderMeta, AiEndpoint, ShareStatus } from './localAi';
```

---

## 2. Candidate: animastor-web-editor

### 2.1 Production contour

| File | LOC | Host imports | Assessment |
|---|---|---|---|
| `lib/entityEditor.tsx` | 424 | 3 (`app/i18n`, `app/icons`, `lib/ui`) | UI component library |
| `lib/waveform.tsx` | 326 | 1 (`api/models`) | Canvas audio waveform |
| `lib/idgen.ts` | 35 | **ZERO** (uses `crypto.getRandomValues`) | Pure utility |
| `pages/EditPage.tsx` | 2895 | 12 host modules + `@animastor/web-player` | Page (stays in host) |
| **Extractable total** | **785** | 4 | libs are extractable |

### 2.2 Test contour

No dedicated tests for `entityEditor`, `waveform`, or `idgen`. EditPage has no dedicated test file. Guard tests exist in `architecture/`.

### 2.3 Host coupling

**EditPage** (stays in host):
- `api/client`, `api/models` — HTTP layer
- `app/i18n`, `app/icons` — UI infrastructure
- `app/router`, `app/desktop` — shell
- `state/generateStore` — identity (`bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared`)
- `state/positionStore` — position
- `state/resourceInvalidations` — invalidations
- `state/resilientReloader` — resilience
- `@animastor/web-player` — `seekToPosition`, `invalidateDeletedScene`, `invalidateDeletedChapter`

**entityEditor** (extractable):
- `app/i18n` — translation keys
- `app/icons` — icon components
- `lib/ui` — shared UI components

**waveform** (extractable):
- `api/models` — types only (`WaveformData`)

**idgen** (extractable):
- ZERO imports (pure utility)

### 2.4 Host consumers of the package

- `pages/EditPage.tsx` — imports `entityEditor`, `waveform`, `idgen`
- `api/models.ts` — type-only reference (commented mention of `entityEditor`)
- `app/i18n.ts` — type-only reference (commented mention of `entityEditor`)

### 2.5 Identity and state ownership

No identity in the extractable modules. EditPage reads identity from `generateStore` but does not own it.

### 2.6 Ports complexity

**Medium.** The package needs Ports for:
1. `I18nPort` — translation keys
2. `IconsPort` — icon components
3. `ApiModelsPort` — `WaveformData` type bridge
4. `UiPort` — shared UI components (`Modal`, `toast`)

The page stays in host; the package exports pure UI components and utilities.

### 2.7 Extraction risk

**MEDIUM.** The libs are extractable, but the EditPage coupling to 12 host modules + `@animastor/web-player` means the package boundary is tight. The package would be `@animastor/web-editor-utils` (libs only), not the full editor page.

### 2.8 Existing audit

`docs/architecture/editor-module-extraction-audit.md` (86KB, 2026-09-08) covers the **backend** editor extraction (`@animastor/editor`), not the web editor. The web editor is a separate concern.

### 2.9 Public API

```ts
// @animastor/web-editor-utils
export { EntityEditorDialog, EntityAddButton, EntityDeleteButton, BehaviorAddDialog, DeleteConfirmDialog, StructureAddDialog, ENTITY_SCHEMAS } from './entityEditor';
export type { EntityKind, StructureKind, StructureParentOption } from './entityEditor';
export { Waveform } from './waveform';
export { chapterId, sceneId, unitId } from './idgen';
```

---

## 3. Candidate: animastor-web-generator

### 3.1 Production contour

| File | LOC | Host imports | Assessment |
|---|---|---|---|
| `state/generateStore.ts` | 1323 | 4 (`api/client`, `api/models`, `positionStore`, `app/i18n`) | **THE HOST HUB** |
| `pages/GeneratePage.tsx` | 720 | 10 host modules | Page (stays in host) |
| `pages/AnalysisProgressPanel.tsx` | 191 | 2 (`app/i18n`, `generateStore`) | Page component (stays in host) |
| **Total** | **2234** | 14 unique | Hub is the problem |

### 3.2 Test contour

| File | LOC | Host imports |
|---|---|---|
| `state/generateStore.analysis.test.ts` | 317 | None (imports only `./generateStore`) |

### 3.3 Host coupling — generateStore is imported by 13 host files

| Consumer | Imports used |
|---|---|
| `main.tsx` | `onPlaybackPrepared`, `phase`, `resetGenerationStatus` |
| `app/playerAdapters.ts` | `bookId`, `buildId`, `onPlaybackPrepared` |
| `app/navigatorAdapters.ts` | `bookId`, `buildId` |
| `app/fileAdapters.ts` | `bookId`, `buildId` |
| `app/AppShell.tsx` | `generationStatus`, `phase`, `bookId` |
| `pages/EditPage.tsx` | `bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared` |
| `pages/GeneratePage.tsx` | 20+ exports (full generation API) |
| `pages/AnalysisProgressPanel.tsx` | `bookId` |
| `pages/AiAssistantPage.tsx` | `bookId` |
| `pages/SettingsPage.tsx` | `bookId`, `phase` |
| `architecture/player-contour.guard.test.ts` | Guard assertions |
| `architecture/file-navigator-contour.guard.test.ts` | Guard assertions |
| `app/fileAdapters.test.ts` | Test mock |

### 3.4 Identity and state ownership — CRITICAL

`generateStore.ts` is the **single source of truth** for:
- `bookId` (Signal<string>) — session identity
- `buildId` (Signal<string>) — session identity
- `phase` (Signal<PlayerPhase>) — generation phase
- `errorMessage` (Signal<string | null>) — error state
- `generationStatus` (Signal<GenerationStatus>) — nav icon status
- `onPlaybackPrepared` / `emitPlaybackPrepared` — event bus to player
- `dirtySummary` (Signal<DiffSummary | null>) — editor dirty state
- `startGeneration`, `startVBookGeneration`, `cancelGeneration` — generation actions
- `computeProgressRows` — progress panel logic
- `stashBookSessionForUser` / `restoreStashedBookSessionForUser` — session persistence
- `loadBook` — book loading
- `loadLayerConfig`, `refreshAssetsState` — config management

The player, navigator, and file adapters all read `bookId`/`buildId` from generateStore. Extracting generateStore means moving identity ownership to the package — the same problem the web-player extraction avoided by keeping identity host-owned.

### 3.5 Ports complexity

**HIGH.** If extracted, the package would need:
1. `SessionPort` — identity (bookId, buildId) — but the package OWNS these
2. `PositionPort` — position navigation
3. `HttpPort` — API client
4. `I18nPort` — translation keys
5. `InvalidationsPort` — resource invalidations
6. `ResilientReloadPort` — resilience

But the identity ownership problem is architectural: if the package owns `bookId`/`buildId`, then the host adapters must import them from the package, reversing the current dependency direction. This requires a fundamental identity extraction step FIRST.

### 3.6 Extraction risk

**HIGH.** The identity ownership transfer is a prerequisite. The current architecture has:
- generateStore owns identity → host adapters read it
- player, navigator, file adapters import from generateStore
- 13 host consumers depend on generateStore exports

Extracting this requires:
1. Splitting identity (bookId/buildId) from generation logic
2. Creating an identity package or making identity host-owned
3. Redesigning the adapter wiring

### 3.7 Existing audit

`docs/architecture/generation-module-extraction-reconnaissance.md` (314KB, 2026-09-12) covers the **backend** generation extraction, not the web generation page. The web generation page is a separate concern.

### 3.8 Public API (if extracted)

```ts
// @animastor/web-generator (hypothetical)
export { GeneratePage } from './GeneratePage';
export { AnalysisProgressPanel } from './AnalysisProgressPanel';
// But: identity ownership problem makes this extraction architecturally risky
```

---

## 4. Cross-candidate dependencies

| From | To | Dependency |
|---|---|---|
| EditPage (editor) | generateStore (generator) | `bookId`, `buildId`, `dirtySummary`, `onPlaybackPrepared` |
| AiAssistantPage (ai-chat) | generateStore (generator) | `bookId` |
| GeneratePage (generator) | — | No dependencies on editor or ai-chat |
| entityEditor (editor) | — | No dependencies on generator or ai-chat |
| chatStream (ai-chat) | — | No dependencies on generator or editor |

**No cycles** between candidates. All dependencies flow from pages → state stores.

---

## 5. Hidden boundaries discovered

1. **`lib/idgen.ts`** — Pure utility (zero imports, 35 LOC). Could be shared across packages or extracted as a standalone micro-package.

2. **`lib/ui.tsx`** — Shared UI components (only imports `preact`). Could be extracted as `@animastor/web-ui` shared package.

3. **`features/workers/*`** — Separate feature (5 files, ~1500 LOC total). Could be extracted independently after the three candidates.

4. **`features/admin/systemAi.ts`** — Pure module (zero imports). Could be part of the ai-chat package or standalone.

---

## 6. Architecture principles from @animastor/web-player reference

The web-player extraction established these principles:
- **Host composition via adapters** — `playerAdapters.ts` is the single composition seam
- **Ports boundary** — `PlayerPorts` contract (8 ports: session, generation, position, invalidations, http, shellMode, i18n, icons)
- **No host imports from package** — package imports only Preact types + vendored models
- **Public package entry** — `@animastor/web-player` is the only sanctioned specifier
- **No second source of truth** — identity stays host-owned (generateStore singletons)
- **Package test isolation** — `test/boundary.test.ts` pins package-internal rules
- **Architecture guards** — `architecture/player-contour.guard.test.ts` pins host↔package seam

**Key lesson:** Identity must stay host-owned. The generator extraction violates this principle by making the package the identity owner.

---

## 7. Recommended extraction order

1. **`@animastor/web-ai-chat`** — Immediate, zero-risk. Pure modules, zero host imports, self-contained tests. No Ports needed.

2. **`@animastor/web-editor`** — Moderate. entityEditor/waveform/idgen are extractable with 4 Ports (i18n, icons, api models, ui). EditPage stays in host. Requires Ports design.

3. **`@animastor/web-generator`** — Deferred. Requires identity ownership transfer first. The current architecture has generateStore as the host hub (13 consumers). Extracting it requires splitting identity from generation logic, which is a prerequisite architectural step.

---

## 8. Why animastor-web-ai-chat is the best next extraction target

1. **Zero host imports** — The three modules (`chatStream.ts`, `aiProviders.ts`, `localAi.ts`) are pure functions with zero imports. No Ports needed.

2. **Self-contained tests** — 647 LOC of tests that import only from the modules themselves.

3. **Clean boundary** — No identity ownership, no state management, no side effects.

4. **Immediate extraction** — Can be extracted as `@animastor/web-ai-chat` with zero behavioral changes.

5. **Follows the web-player pattern** — Pure logic extraction first, page stays in host.

6. **Unblocks future work** — The ai-chat package can be consumed by AiAssistantPage and SettingsPage, establishing the Ports pattern for future extractions.

---

## 9. Commit

```
arch(web): audit next web package extraction candidates
```

Baseline: `71d85aba` ("arch(orchestration): introduce video fsm port")

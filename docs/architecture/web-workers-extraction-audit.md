# Web Workers — Package Extraction Audit

**Status:** READ-ONLY audit (no production code changed, no files moved, no packages created)  
**Date:** 2026-09-13  
**Branch:** `c21.4-physically-extract-analysis-from-backend`  
**Baseline commit:** `088d45c7` ("arch(web): audit next extraction candidates")  
**Target package:** `@animastor/web-workers`  
**Target location:** `packages/animastor-web-workers/`

---

## 1. Executive Summary

This audit confirms that `features/workers/` (Private Worker Management) is **READY FOR EXTRACTION** as `@animastor/web-workers` using the Tier A (Ports/Adapters) pattern.

**Key findings:**
- **3,739 LOC** across 6 production files and 4 test files
- **Single consumer** (`SettingsPage.tsx`) — trivial import update
- **Zero session identity** — no `bookId`/`buildId` ownership
- **Clean internal DAG** — no cyclic dependencies
- **6 well-defined host ports** — api, i18n, ui, auth, icons, signals
- **Existing test suite** — 1,110 LOC of tests provide extraction safety net

**Verdict:** Safe to extract with standard Ports/Adapters pattern. No blockers identified.

---

## 2. File Inventory

### 2.1 Production files

| File | LOC | Role |
|---|---|---|
| `privateWorkers.ts` | 150 | Pure helpers, types, validation, status keys |
| `workerSetup.ts` | 543 | Setup Contract client, wizard state machine, pure helpers |
| `sharing.ts` | 280 | Sharing V2 API + pure helpers (mode, expiry, diff) |
| `shareNotifications.ts` | 108 | Notification adapter, badge counters, session-only state |
| `PrivateWorkersSection.tsx` | 990 | Main section component + sub-modals |
| `WorkerSharingUI.tsx` | 557 | SharingModal, SharedWithMeView, CommunityView |
| **TOTAL** | **2,628** | |

### 2.2 Test files

| File | LOC | Coverage |
|---|---|---|
| `privateWorkers.test.ts` | 144 | create-input validation, credential contract, status derivation, last-seen formatting |
| `workerSetup.test.ts` | 554 | Setup Contract client, wizard state machine, Worker Key security invariants |
| `sharing.test.ts` | 288 | pure helpers (mode derivation, expiry, validation, error mapping, diffing) and API layer |
| `shareNotifications.test.ts` | 124 | notice subscription/emission, badge counters, initial-sync rule |
| **TOTAL** | **1,110** | |

### 2.3 Combined total

**3,739 LOC** (2,628 production + 1,110 tests)

---

## 3. Import Graph (Host Dependencies)

### 3.1 Per-file host imports

| File | Host Imports |
|---|---|
| `privateWorkers.ts` | **None** |
| `workerSetup.ts` | `api/client` (`getJson`, `postJson`) |
| `sharing.ts` | `@preact/signals`, `api/client` (`getJson`, `postJson`, `deleteJson`, `deleteJsonBody`, `ApiError`) |
| `shareNotifications.ts` | `@preact/signals` |
| `PrivateWorkersSection.tsx` | `preact/hooks`, `api/client`, `app/i18n`, `app/icons`, `state/authStore`, `lib/ui` |
| `WorkerSharingUI.tsx` | `preact/hooks`, `app/i18n`, `api/client`, `lib/ui` |

### 3.2 Distinct host dependencies

| Dependency | Usage | Port Required |
|---|---|---|
| `api/client` | HTTP methods (`getJson`, `postJson`, `deleteJson`, `deleteJsonBody`) + `ApiError` type | `WorkerApiPort` |
| `app/i18n` | Typed `t()` and `tf()` functions with `StrKey` type | `WorkerI18nPort` |
| `app/icons` | `IconAdd`, `IconReset` components | `WorkerIconsPort` |
| `state/authStore` | `authMe.value.authenticated` (single boolean check) | `WorkerAuthPort` |
| `lib/ui` | `Modal`, `toast` components | `WorkerUiPort` |
| `@preact/signals` | Signal primitives (`signal`, `computed`, `effect`) | Peer dependency |
| `preact/hooks` | `useState`, `useEffect`, `useCallback`, `useMemo` | Peer dependency |

### 3.3 Package imports

**None.** Zero dependency on other `@animastor/web-*` packages.

---

## 4. Consumer Graph

### 4.1 Direct consumers

| Consumer | Import | Line |
|---|---|---|
| `pages/SettingsPage.tsx:14` | `import { PrivateWorkersSection } from '../features/workers/PrivateWorkersSection'` | L14 |

### 4.2 Consumer usage

```typescript
// SettingsPage.tsx:35
if (section === 'private-workers') return <PrivateWorkersSection />;
```

### 4.3 Hidden consumers

**None.** Verified via grep:
- No other files import from `features/workers/`
- No re-exports from barrel files
- No dynamic imports

---

## 5. Internal Dependency Graph

```
privateWorkers.ts (leaf — zero imports)
  ├── workerSetup.ts (imports api/client)
  ├── sharing.ts (imports privateWorkers types + api/client + signals)
  │    └── shareNotifications.ts (imports sharing types + signals)
  ├── WorkerSharingUI.tsx (imports privateWorkers + sharing types)
  └── PrivateWorkersSection.tsx (imports everything above)
```

**DAG verification:** No cycles. All dependencies flow downward. `privateWorkers.ts` is the root leaf with zero imports.

---

## 6. Identity/State Boundary

### 6.1 Session identity ownership

| Signal | Owner | Workers dependency |
|---|---|---|
| `bookId` | `generateStore` (host) | **None** |
| `buildId` | `generateStore` (host) | **None** |
| `phase` | `generateStore` (host) | **None** |
| `errorMessage` | `generateStore` (host) | **None** |

### 6.2 Feature-scoped state (moves with package)

| Signal | File | Purpose |
|---|---|---|
| `shareFeatureEnabled` | `sharing.ts` | Global kill-switch for sharing feature |
| `sharedWithMeCount` | `shareNotifications.ts` | Badge count for shared items |
| `sharedUnreadCount` | `shareNotifications.ts` | Badge count for unread notifications |

### 6.3 Auth boundary

**Single read:** `PrivateWorkersSection.tsx` reads `authMe.value.authenticated` (boolean) to conditionally render "Shared with Me" section.

**Port surface:** `isAuthenticated: () => boolean`

---

## 7. API Boundary

### 7.1 Endpoints consumed

| Endpoint | Method | File |
|---|---|---|
| `/api/v1/workers` | GET | `workerSetup.ts`, `sharing.ts` |
| `/api/v1/workers/:id` | GET | `workerSetup.ts` |
| `/api/v1/workers/:id/setup/start` | POST | `workerSetup.ts` |
| `/api/v1/workers/:id/setup/status` | GET | `workerSetup.ts` |
| `/api/v1/workers/:id/setup/complete` | POST | `workerSetup.ts` |
| `/api/v1/workers/:id/setup/regenerate` | POST | `workerSetup.ts` |
| `/api/v1/private-worker/sharing` | GET | `sharing.ts` |
| `/api/v1/private-worker/sharing/:id` | GET | `sharing.ts` |
| `/api/v1/private-worker/sharing/:id/recipients` | GET | `sharing.ts` |
| `/api/v1/private-worker/sharing/:id/access` | PUT | `sharing.ts` |
| `/api/v1/private-worker/sharing/:id/stop` | POST | `sharing.ts` |
| `/api/v1/private-worker/sharing/:id/notify` | POST | `sharing.ts` |
| `/api/v1/private-worker/sharing/shared-with-me` | GET | `shareNotifications.ts` |
| `/api/v1/private-worker/sharing/unread-count` | GET | `shareNotifications.ts` |
| `/api/v1/users/lookup` | POST | `WorkerSharingUI.tsx` |
| `/api/v1/config` | GET | `sharing.ts` |

### 7.2 API methods used

| Method | Source | Usage |
|---|---|---|
| `getJson<T>(url)` | `api/client` | Read operations |
| `postJson<T>(url, body?)` | `api/client` | Create/update operations |
| `deleteJson<T>(url)` | `api/client` | Delete operations |
| `deleteJsonBody<T>(url, body)` | `api/client` | Delete with body |
| `ApiError` | `api/client` | Error type for catch blocks |

---

## 8. UI Boundary

### 8.1 Components exported

| Component | File | Purpose |
|---|---|---|
| `PrivateWorkersSection` | `PrivateWorkersSection.tsx` | Main section (entry point) |
| `SharingModal` | `WorkerSharingUI.tsx` | Sharing modal dialog |
| `SharedWithMeView` | `WorkerSharingUI.tsx` | "Shared with me" list view |
| `CommunityView` | `WorkerSharingUI.tsx` | Community workers view |

### 8.2 UI primitives used

| Primitive | Source | Usage |
|---|---|---|
| `Modal` | `lib/ui` | Dialog containers |
| `toast` | `lib/ui` | User notifications |
| `IconAdd` | `app/icons` | Add button icon |
| `IconReset` | `app/icons` | Reset button icon |

### 8.3 CSS dependency

**None.** All styling uses inline styles or utility classes. No CSS module imports.

---

## 9. Ports Interface (Proposed)

```typescript
interface WorkerPorts {
  api: WorkerApiPort;
  i18n: WorkerI18nPort;
  ui: WorkerUiPort;
  auth: WorkerAuthPort;
  icons: WorkerIconsPort;
}

interface WorkerApiPort {
  getJson: <T>(url: string) => Promise<T>;
  postJson: <T>(url: string, body?: unknown) => Promise<T>;
  deleteJson: <T>(url: string) => Promise<T>;
  deleteJsonBody: <T>(url: string, body: unknown) => Promise<T>;
  ApiError: typeof ApiError;
}

interface WorkerI18nPort {
  t: (key: StrKey) => string;
  tf: (key: StrKey, params: Record<string, unknown>) => string;
}

interface WorkerUiPort {
  Modal: typeof Modal;
  toast: (message: string, type?: string) => void;
}

interface WorkerAuthPort {
  isAuthenticated: () => boolean;
}

interface WorkerIconsPort {
  IconAdd: typeof IconAdd;
  IconReset: typeof IconReset;
}
```

---

## 10. Proposed Package Structure

```
packages/animastor-web-workers/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Public entry
│   ├── ports.ts                    # WorkerPorts interface
│   ├── privateWorkers.ts           # Pure helpers, types, validation
│   ├── workerSetup.ts              # Setup Contract client, wizard
│   ├── sharing.ts                  # Sharing V2 API + helpers
│   ├── shareNotifications.ts       # Notification adapter
│   ├── PrivateWorkersSection.tsx    # Main section component
│   ├── WorkerSharingUI.tsx          # Sharing UI components
│   └── __tests__/
│       ├── privateWorkers.test.ts
│       ├── workerSetup.test.ts
│       ├── sharing.test.ts
│       └── shareNotifications.test.ts
└── README.md
```

---

## 11. Public API

```typescript
// ports.ts
export type { WorkerPorts, WorkerApiPort, WorkerI18nPort, WorkerUiPort, WorkerAuthPort, WorkerIconsPort };

// PrivateWorkersSection.tsx
export { PrivateWorkersSection };

// WorkerSharingUI.tsx
export { SharingModal, SharedWithMeView, CommunityView };

// privateWorkers.ts (types only — internals)
export type { Worker, WorkerCreateInput, WorkerStatus, SetupState };
```

---

## 12. Dependency Direction

### 12.1 Current

```
HOST (SettingsPage.tsx)
  └── imports PrivateWorkersSection from 'features/workers/PrivateWorkersSection'
```

### 12.2 Post-extraction

```
HOST (SettingsPage.tsx)
  └── imports PrivateWorkersSection from '@animastor/web-workers'

@animastor/web-workers (package)
  └── imports nothing from host (all deps arrive via WorkerPorts)
```

**Direction:** `host → package` (correct)

---

## 13. Test Strategy

### 13.1 Existing tests

All 4 test files (1,110 LOC) are comprehensive and cover:
- Pure helper functions (validation, status derivation, formatting)
- API client interactions (mocked)
- State machine transitions (wizard, sharing modes)
- Badge counter logic
- Error handling

### 13.2 Test migration

Tests move to `src/__tests__/` in the package. Mock `api/client` in test setup.

### 13.3 Architecture guard test

Add a boundary test to verify:
- No direct imports from `api/client`, `app/i18n`, `app/icons`, `state/authStore`, `lib/ui`
- All host deps arrive via Ports

---

## 14. Architecture Guards

### 14.1 Import boundary

```typescript
// packages/animastor-web-workers/src/__tests__/boundary.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

describe('workers package boundary', () => {
  const srcDir = join(__dirname, '..');
  const files = readdirSync(srcDir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));

  it('should not import from host directly', () => {
    const forbidden = [
      /from ['"]\.\.\/api\/client/,
      /from ['"]\.\.\/app\/i18n/,
      /from ['"]\.\.\/app\/icons/,
      /from ['"]\.\.\/state\/authStore/,
      /from ['"]\.\.\/lib\/ui/,
    ];

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      for (const pattern of forbidden) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});
```

### 14.2 Dependency direction guard

```typescript
// Verify package.json has no dependencies on host
describe('package dependencies', () => {
  it('should not depend on host packages', () => {
    const pkg = require('../package.json');
    const hostDeps = Object.keys(pkg.dependencies || {}).filter(
      d => d.startsWith('@animastor/') && d !== '@animastor/web-workers'
    );
    expect(hostDeps).toHaveLength(0);
  });
});
```

---

## 15. Migration Plan

### 15.1 Pre-extraction checklist

- [ ] Verify all tests pass: `npm test`
- [ ] Verify TypeScript compiles: `npm run typecheck`
- [ ] Verify lint passes: `npm run lint`
- [ ] Backup current `features/workers/` directory

### 15.2 Extraction steps

1. **Create package skeleton**
   ```bash
   mkdir -p packages/animastor-web-workers/src/__tests__
   ```

2. **Define Ports interface**
   - Create `src/ports.ts` with `WorkerPorts` and sub-interfaces

3. **Move source files**
   ```bash
   cp frontends/app/src/features/workers/*.ts packages/animastor-web-workers/src/
   cp frontends/app/src/features/workers/*.tsx packages/animastor-web-workers/src/
   ```

4. **Move test files**
   ```bash
   cp frontends/app/src/features/workers/*.test.ts packages/animastor-web-workers/src/__tests__/
   ```

5. **Update imports**
   - Replace direct host imports with Port usage
   - Add Ports parameter to component functions

6. **Create public entry**
   - `src/index.ts` — export public API

7. **Create adapters in host**
   - `frontends/app/src/app/workerAdapters.ts` — wire Ports

8. **Update consumer**
   - `pages/SettingsPage.tsx` — import from `@animastor/web-workers`

9. **Add architecture guard test**
   - Verify boundary constraints

10. **Remove old directory**
    ```bash
    rm -rf frontends/app/src/features/workers/
    ```

### 15.3 Post-extraction verification

- [ ] All tests pass
- [ ] TypeScript compiles
- [ ] Lint passes
- [ ] No imports from `features/workers/` remain
- [ ] Architecture guard test passes

---

## 16. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `authMe` coupling in `PrivateWorkersSection.tsx` | Low | Port: `isAuthenticated: () => boolean` — single boolean check |
| `ApiError` in tests | Low | Vendor `ApiError` type or pass via Port in tests |
| `@preact/signals` in `sharing.ts` / `shareNotifications.ts` | Low | Peer dependency (same as all Tier A packages) |
| Kill-switch signal (`shareFeatureEnabled`) stays in package | Low | Feature-scoped, not session-scoped — safe to own |
| Import path breakage | Low | TypeScript compiler catches all; guard tests verify |
| CSS class coupling | Low | CSS stays in host `base.css`; packages use class names only |
| i18n key drift | Low | Typed key unions in each package; compile-time check |
| Test scaffolding | Low | Mock `api/client` in tests (existing pattern) |

---

## 17. npm Readiness

### 17.1 Package metadata

```json
{
  "name": "@animastor/web-workers",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "preact": ">=10.0.0",
    "@preact/signals": ">=1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

### 17.2 Build configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

---

## 18. Estimated Effort

| Task | Time |
|---|---|
| Create package skeleton | 10 min |
| Define Ports interface | 30 min |
| Move and adapt source files | 1 hour |
| Update imports to use Ports | 1 hour |
| Create host adapters | 30 min |
| Update consumer (SettingsPage) | 10 min |
| Add architecture guard tests | 30 min |
| Verify all tests pass | 20 min |
| **TOTAL** | **~4 hours** |

---

## 19. VERDICT

**`@animastor/web-workers` is READY FOR EXTRACTION.**

All prerequisites are met:
- ✅ Single consumer (`SettingsPage.tsx`)
- ✅ Zero session identity ownership
- ✅ Clean internal DAG (no cycles)
- ✅ 6 well-defined host ports
- ✅ Existing test suite (1,110 LOC)
- ✅ No dependency on Generator or other packages
- ✅ Self-contained vertical slice

**Recommendation:** Proceed with extraction using Tier A (Ports/Adapters) pattern.

---

**Production code:** UNCHANGED. This is an audit-only document.

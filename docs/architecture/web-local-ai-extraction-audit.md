# Web Local AI — Next Physical Extraction Audit

**Status:** READ-ONLY audit (no production code changed, no files moved, no packages created).
**Date:** 2026-09-13
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Baseline commit:** `8e78c2a45721c1cbbb8b732c4f53d9cd012fe3da` ("fix(web): finalize workers package standalone validation")
**Method:** static import-graph tracing over `frontends/app/src/**`, LOC measurement, consumer counting, port surface analysis, cross-checked against the 7 existing extraction patterns (`@animastor/web-player`, `@animastor/web-ai-chat`, `@animastor/web-settings`, `@animastor/web-editor`, `@animastor/web-file`, `@animastor/web-navigator`, `@animastor/web-workers`).
**Scope:** find the NEXT safest physical extraction candidate after the Workers extraction (`b096d2a6`). Generator (`generateStore.ts`) is explicitly excluded by mandate — identity/state boundary not cleaned.

---

## 1. Executive Summary

After 7 physical extractions (player, ai-chat, settings, editor, file, navigator, workers), the remaining web host holds **≈14.9k production LOC**. The next safest extraction candidate is **`features/localAi/` (Local AI Connector UI, 778 LOC)** — `@animastor/web-local-ai`.

**Key findings:**

1. **The previous gap is closed by a new seam.** The `web-next-extraction-reconnaissance.md` audit ranked localAi #2 with the blocker *"needs tests and has heavy API surface"*. Since then, ALL of localAi's domain logic (validation, token rules, status keys, share status, run-command builder, error mapping — 298 LOC) was extracted into `@animastor/web-settings/src/localAi.ts` and is covered there by `test/localAi.test.ts` (241 LOC, 30 tests, all passing). What remains in the host is a single stateless-ish UI component (local `useState` only, zero signals, zero bookId/buildId).
2. **Workers extraction created the full template.** `WorkerPorts` (package-owned i18n key union, structural `ApiError` contract, `Modal`/`toast` UI port) covers 3 of localAi's 4 dependency groups verbatim. `navigator.clipboard` inside a package is already precedented (`PrivateWorkersSection.tsx:373`).
3. **First package→package dependency** (web-local-ai → web-settings) is a clean DAG: web-settings is Tier B pure (`sideEffects: false`, zero peer deps), so no cycle and no forbidden direction (package → host) is introduced. This needs an explicit boundary guard.
4. **Generator is still NOT READY** — `generateStore.ts` (1,323 LOC) is consumed by 13 host files; `authStore` still hardwires `stashBookSessionForUser`/`restoreStashedBookSessionForUser`. No new seam changes this.
5. **Workflows** (896 LOC) and **Admin** (490 LOC) are NEAR READY — both lack tests and need 2+ new port types (navigation/title; auth-subscription).

---

## 2. Current Web Host Map (Post-Workers-Extraction)

### 2.1 Remaining host production inventory

| Area | Files | LOC | Role |
|---|---|---|---|
| `main.tsx` | 1 | 92 | Entry, route registration |
| `api/` | 2 | 1,085 | HTTP client + DTO models |
| `app/` | 12 | ~3,020 | Shell, routing, i18n (1,780), adapters (+ `workerAdapters.ts` 37), icons, theme, titleStore, routeState, desktop |
| `features/` | 3 | 1,076 | admin (125), auth (173), localAi (778) |
| `lib/` | 4 | 895 | ui (125), entityEditor (424), waveform (326), idgen (20) |
| `pages/` | 11 | 6,717 | Edit 2,899 · Settings 964 · Generate 720 · AiAssistant 642 · WorkflowDetails 508 · Admin 365 · WorkflowTypeList 156 · DevView 156 · Workflows 76 · AnalysisProgressPanel 191 · Library 24 |
| `state/` | 6 | 2,072 | generateStore 1,323 · fileStore 363 · resilientReloader 212 · authStore 78 · positionStore 27 · resourceInvalidations 69 |
| **TOTAL** | **~39** | **≈14.9k** | |

### 2.2 Extracted packages (reference)

| Package | Tier | Pattern | Peer deps |
|---|---|---|---|
| `@animastor/web-player` | A (Ports) | `PlayerPorts` + `wirePlaybackCoordination` | preact, @preact/signals |
| `@animastor/web-file` | A | `{ ports }` prop | preact, signals |
| `@animastor/web-navigator` | A | `{ ports }` prop | preact, signals |
| `@animastor/web-editor` | A | `{ ports }` prop | preact, signals |
| `@animastor/web-workers` | A | `WorkerPorts` (i18n key union, structural ApiError) | preact, signals |
| `@animastor/web-ai-chat` | B (pure) | direct import | none |
| `@animastor/web-settings` | B (pure) | direct import | none |

Package→package imports: **none exist yet**. Local AI would be the first (→ web-settings).

---

## 3. Candidate Comparison (Top-3)

### 3.1 Scorecard

| Criterion | **localAi** | **workflows** | **admin** |
|---|---|---|---|
| Production LOC | 778 | 896 (4 files) | 490 (2 files) |
| Existing test LOC | 241 (domain, in web-settings pkg) | 0 | 0 |
| Consumers | 1 (`SettingsPage.tsx:37`) | 1 (`main.tsx`, 4 routes) | 1 (`main.tsx`) |
| Distinct host modules imported | 3 (i18n, api/client, lib/ui) + 1 pure pkg | 7 (api, models, i18n, router, routeState, titleStore, ui) | 3 (api/client, authStore, ui) |
| Session identity (bookId/buildId) | none | none | none |
| Global signals owned | **0** (all local `useState`) | 2 shared routeState signals (`devConnector`, `detailsEditMode`) | 0 (subscribes to `authMe`) |
| Side effects | HTTP, `navigator.clipboard` (precedented) | HTTP | HTTP |
| Persistence | none (creds in transient useState — security invariant) | none | none (one-time API key — security invariant) |
| Ports required | 3 (api, i18n, ui) | 4–5 (api, i18n, ui, navigation, title) + vendored DTO types | 3 + auth (needs subscribe/mutations — new port shape) |
| Port precedent in codebase | 100% (workers template) | partial (nav + title are new port types) | partial (workers used `isAuthenticated()` boolean only) |
| Cyclic risk | none (DAG: host → pkg → web-settings) | none, but routeState signals must move into pkg | none (AuthPort hides generateStore-coupled authStore) |
| **Verdict** | **READY** | **NEAR READY** | **NEAR READY** |

Also-rans (unchanged from previous audit): **UserMenu** (173 LOC, deep authStore coupling — NOT READY), **AiAssistantPage** (642 LOC, imports bookId/position/resourceInvalidations/resilientReloader/postChatStream — NOT READY), **EditPage** (2,899 LOC, deepest generateStore consumer — NOT READY), **LibraryPage** (24 LOC — trivial).

### 3.2 Candidate A — `features/localAi/` (Local AI Connector UI)

- Single file: `LocalAISection.tsx` (778 LOC), single consumer `SettingsPage.tsx` (`section === 'local-ai'`).
- Imports: `preact/hooks` (peer), `app/i18n` (`t`, `tf`, `StrKey`), `api/client` (`getJson`, `postJson`, `putJson`, `deleteJson`, `ApiError`), `lib/ui` (`Modal`, `toast`), `@animastor/web-settings` (17 functions + 11 types — pure).
- State: 100% component-local. No signals. No bookId/buildId. No localStorage — credential material lives only in transient `useState` and is dropped on modal close (pinned security invariant).
- Endpoints (6 roots): `/ai-connector/status`, `/ai-connector/models`, `/ai-connector/registrations`, `/ai-connector/connectors/*` (models/refresh, rotate, delete), `/settings/ai/provider` (GET/PUT/DELETE), `/settings/ai/test`, `/ai-endpoints` (CRUD + share).
- i18n: 77 distinct keys, all already present in host dictionary.
- Clipboard: `navigator.clipboard.writeText` — same as web-workers (`PrivateWorkersSection.tsx:373,508`). Precedented.

### 3.3 Candidate B — Workflow pages

`WorkflowsPage` (76) + `WorkflowTypeListPage` (156) + `WorkflowDetailsPage` (508) + `DeveloperViewPage` (156) = 896 LOC, registered in `main.tsx`. Blockers: 7 host modules incl. `app/router` (`navigate`, `Route` type — needs NavigationPort), `app/titleStore` (`setSecondaryTitle`/`setSecondaryAction` — needs TitlePort consumed also by AppShell toolbar), shared `routeState` signals `devConnector`/`detailsEditMode` (feature-scoped, movable), and vendored DTO types from `api/models` (`ConnectorGroupedResponse`, `ConnectorSummary`, `ConnectorDetail`, `AddConnectorResponse`, `CompatibilityStatus`, `GuideBinding`). Zero tests. Two brand-new port types with no precedent → seam work first.

### 3.4 Candidate C — Admin

`AdminPage.tsx` (365) + `features/admin/systemAi.ts` (125). `systemAi.ts` is pure with zero imports (trivial rider). Blocker: `authStore` (authMe/login/logout/fetchMe + `authMe.subscribe`) — authStore itself hardwires generateStore stash/restore. Extraction needs an AuthPort with **subscription + mutation** semantics — a new port shape beyond workers' `isAuthenticated(): boolean`. Zero tests. Doable after workers' auth-port precedent is extended, but it is net-new seam design.

---

## 4. New Seams Since Previous Audit (Task Item 4)

| New seam | Created by | Effect on candidates |
|---|---|---|
| `@animastor/web-settings/src/localAi.ts` — 298 LOC of localAi domain logic, 30 tests | web-settings physical extraction | **localAi's "needs tests" blocker is closed** — domain logic is already extracted, tested, published-shape. Only the UI component remains in host. |
| `WorkerPorts` pattern: package-owned `WorkerI18nKey` union, structural `WorkerApiError`, `WorkerUiPort` (Modal/toast), `WorkerAuthPort` | workers extraction (`b096d2a6`) | localAi's 3 port types can be copied near-verbatim (add `putJson`). |
| `navigator.clipboard` in package | workers package (validated) | localAi's clipboard copy needs no special treatment. |
| `app/workerAdapters.ts` composition point | workers extraction | Template for `app/localAiAdapters.ts`. |
| auth→generateStore stash/restore unchanged | — | Generator and Admin remain blocked on identity; no new seam. |

**Modules previously considered coupled that are now extractible:** localAi (was #2/"needs tests" → now READY). Workflows and Admin gained only the generic workers precedent; their specific blockers (nav/title ports; auth-subscription port) remain.

---

## 5. Generator Status Check (Excluded by Mandate)

Still **NOT READY**, unchanged:

- `generateStore.ts` (1,323 LOC) consumed by 13 host files (fileAdapters, playerAdapters, navigatorAdapters, AppShell, main.tsx, SettingsPage, AiAssistantPage, GeneratePage, EditPage, AnalysisProgressPanel, authStore, fileStore, resourceInvalidations).
- `bookId`/`buildId` identity, `phase`/`errorMessage` shared-status writes, `onPlaybackPrepared` event bus, auth stash/restore — all still inside the store.
- No Ports interface exists for the Generator contour; progress tracking mutates module-level maps.
- Correctly deferred until a `@animastor/session` identity package exists or the store is split (see `web-next-extraction-reconnaissance.md` §5).

---

## 6. Selected Candidate: `@animastor/web-local-ai` — Physical Extraction Plan

### 6.1 Package identity

- **npm name:** `@animastor/web-local-ai`
- **directory:** `packages/animastor-web-local-ai/`
- **tier:** A (Ports/Adapters), same shape as web-workers
- **peerDependencies:** `preact` only (component uses zero `@preact/signals`)

### 6.2 Production files

| Source (host) | → Target (package) | LOC |
|---|---|---|
| `frontends/app/src/features/localAi/LocalAISection.tsx` | `src/LocalAISection.tsx` | 778 |
| — | `src/ports.ts` (new — `LocalAiPorts` + `LocalAiI18nKey` union, 77 keys) | ~150 |
| — | `src/index.ts` (new — public entry) | ~25 |
| — | `app/localAiAdapters.ts` (host side, new — wires ports) | ~40 |

### 6.3 Test files

| Source | → Target | LOC |
|---|---|---|
| — | `test/boundary.test.ts` (new — clone of web-workers boundary guard) | ~100 |
| — | `test/section.test.ts` (new — render smoke: section renders empty-state without host imports; port fakes) | ~60 |
| *(already in package land)* | `packages/animastor-web-settings/test/localAi.test.ts` — 30 domain tests stay where they are | 241 |

### 6.4 Public API

```typescript
// index.ts
export { LocalAISection } from './LocalAISection';
export type { LocalAiPorts, LocalAiApiPort, LocalAiI18nPort, LocalAiUiPort, LocalAiApiError, LocalAiI18nKey, LocalAiModalProps } from './ports';
```

### 6.5 Ports (necessary host capabilities)

```typescript
// ports.ts — structural types only, zero host imports (WorkerPorts pattern)
export interface LocalAiApiError {
  readonly name: string; readonly message: string;
  readonly status: number; readonly code?: string;
}

export interface LocalAiApiPort {
  getJson: <T>(url: string) => Promise<T>;
  postJson: <T>(url: string, body?: unknown) => Promise<T>;
  putJson: <T>(url: string, body: unknown) => Promise<T>;
  deleteJson: <T>(url: string) => Promise<T>;
  ApiError: new (message: string, status: number, code?: string) => LocalAiApiError;
}

export type LocalAiI18nKey =
  | 'ai_provider_last_tested' | 'ai_provider_model' | 'ai_provider_test'
  | 'ai_provider_test_ok' | 'dialog_cancel' | 'play_loading'
  | 'local_ai_add_hint' | 'local_ai_add_title' | 'local_ai_bind'
  | 'local_ai_binding_active' | 'local_ai_binding_none' | 'local_ai_bound'
  | 'local_ai_bound_badge' | 'local_ai_create' | 'local_ai_credential_warning'
  | 'local_ai_desc' | 'local_ai_empty' | 'local_ai_err_auth'
  | 'local_ai_err_forbidden' | 'local_ai_err_generic' | 'local_ai_err_no_models'
  | 'local_ai_err_not_found' | 'local_ai_err_rate_limited' | 'local_ai_list_title'
  | 'local_ai_model_auto' | 'local_ai_model_pick_hint' | 'local_ai_models_count'
  | 'local_ai_models_disclaimer' | 'local_ai_models_refreshed' | 'local_ai_name_hint'
  | 'local_ai_name_label' | 'local_ai_pending_hint' | 'local_ai_rebind'
  | 'local_ai_refresh_models' | 'local_ai_reg_expired' | 'local_ai_reg_title'
  | 'local_ai_reg_token_label' | 'local_ai_reg_ttl_hint' | 'local_ai_reissue_token'
  | 'local_ai_revoke_confirm' | 'local_ai_revoked' | 'local_ai_revoke_hint'
  | 'local_ai_rotate_hint' | 'local_ai_run_command_label' | 'local_ai_runtime_label'
  | 'local_ai_runtime_ok' | 'local_ai_runtime_unknown' | 'local_ai_setup_intro'
  | 'local_ai_setup_title' | 'local_ai_test_cold_warning' | 'local_ai_test_fail'
  | 'local_ai_title' | 'local_ai_unbind' | 'local_ai_unbound'
  | 'share_ai_concurrency_label' | 'share_ai_create_endpoint'
  | 'share_ai_create_endpoint_hint' | 'share_ai_disabled_notice'
  | 'share_ai_enable_confirm' | 'share_ai_enabled_notice'
  | 'share_ai_endpoint_created' | 'share_ai_endpoint_deleted'
  | 'share_ai_models_label' | 'share_ai_no_endpoint_hint'
  | 'share_ai_share_button' | 'share_ai_title' | 'share_ai_unshare_button'
  | 'worker_copied' | 'worker_copy' | 'worker_copy_failed'
  | 'worker_delete' | 'worker_done' | 'worker_last_seen'
  | 'worker_revoke' | 'worker_rotate' | 'worker_rotate_short'
  | 'worker_trouble_title';

export interface LocalAiI18nPort {
  t: (key: LocalAiI18nKey, fallback?: string) => string;
  tf: (key: LocalAiI18nKey, ...params: unknown[]) => string;
}

export interface LocalAiModalProps {
  title?: string; onClose: () => void;
  footer?: JSX.Element | JSX.Element[];
  children: JSX.Element | JSX.Element[];
}

export interface LocalAiUiPort {
  Modal: (props: LocalAiModalProps) => JSX.Element;
  toast: (message: string, duration?: number) => void;
}

export interface LocalAiPorts {
  api: LocalAiApiPort;
  i18n: LocalAiI18nPort;
  ui: LocalAiUiPort;
}
```

`StrKey` casts inside the component (`t(v.error as StrKey)`) become typed via `LocalAiI18nKey` — the package-owned union, same as `WorkerI18nKey`.

### 6.6 What stays host-owned

- `app/i18n.ts` — full dictionary (all 77 keys remain there; package only owns the key union).
- `api/client.ts` — HTTP implementation, `API_BASE`, real `ApiError`.
- `lib/ui.tsx` — real `Modal`/`toast`.
- `pages/SettingsPage.tsx` — section switch: `if (section === 'local-ai') return <LocalAISection ports={localAiPorts} />;`
- `app/localAiAdapters.ts` — the ONLY host file importing api/client + i18n + ui for this contour (workers pattern).
- `@animastor/web-settings` — unchanged; remains the pure-function dependency target.

### 6.7 Expected dependency direction

```
HOST (SettingsPage.tsx)
  └─composition→ app/localAiAdapters.ts ─implements→ LocalAiPorts
       │
       ▼
@animastor/web-local-ai (package)
  ├─consumes→ LocalAiPorts (structural types only)
  └─imports→ @animastor/web-settings (pure Tier B — FIRST package→package dep)

DAG check: web-settings has zero deps & zero side effects → no cycle possible.
```

Forbidden and guarded: `web-local-ai → host` (never); `web-local-ai → any @animastor/* except web-settings` (never); `web-settings → anything` (never, pinned by its own boundary test).

**Alternative considered:** merge the section into `@animastor/web-settings`. Rejected — web-settings is Tier B pure with zero peer deps and zero Preact; adding a 778-LOC component would change its tier, its peer surface, and its published contract.

### 6.8 Boundary guards

1. `test/boundary.test.ts` (clone of `packages/animastor-web-workers/test/boundary.test.ts`): scan all package `src/` + `test/` files; forbid import specifiers matching `../api/client`, `../../app/i18n`, `../../lib/ui`, `../../state/`, `../../app/`, and any `@animastor/*` other than `@animastor/web-settings`.
2. `package.json` dependency check inside the boundary test: `dependencies` must contain exactly `@animastor/web-settings`; `peerDependencies` exactly `preact`; no other `@animastor/*` entries.
3. Host contour check (add to `frontends/app/src/architecture/` guard suite, same style as `file-navigator-contour.guard.test.ts`): `SettingsPage.tsx` imports `LocalAISection` from `@animastor/web-local-ai`; no file under `frontends/app/src` imports `features/localAi/` anymore; `app/localAiAdapters.ts` is the only host file wiring the ports.

### 6.9 Validation plan

| Step | Command / check | Pass criteria |
|---|---|---|
| Package unit | `cd packages/animastor-web-local-ai && npm test` | boundary + section smoke green |
| Package types | `npm run typecheck` | clean |
| Package build | `npm run build` (tsup) | emits `dist/` |
| Dependency purity | boundary test's package.json assertion | only web-settings dep; preact peer |
| Web-settings regression | `cd packages/animastor-web-settings && npm test` | 57/57 still green (the pure helpers the component consumes) |
| Host typecheck/build | `cd frontends/app && npm run build` (or typecheck) | clean; zero references to `features/localAi` |
| Host contour | `frontends/app` architecture guard tests | pass, incl. new local-ai contour assertions |
| Manual smoke | open `/settings/local-ai` | section renders; create-connector flow reachable; one-time token modal shows and drops credential on close; bind/unbind provider; share endpoint toggle |
| Regression neighbors | `/settings/ai`, `/settings/private-workers` | unaffected (SettingsPage sections render from their own packages) |

### 6.10 Expected commit message

```
arch(web): physically extract local-ai package
```

### 6.11 Estimated effort

~4 hours (1 file move + 3 port substitutions + adapters + guards + validation), matching the workers extraction effort.

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| First package→package dep (→ web-settings) sets precedent | Medium | web-settings is pure/side-effect-free — DAG provable; boundary test pins "web-settings only" |
| `StrKey` casts become `LocalAiI18nKey` casts | Low | compile-time checked; 77-key union enumerated in this audit |
| `putJson` missing from WorkerApiPort template | Low | localAi port adds it; host adapter passes existing `putJson` |
| No component-level tests exist today | Low | domain logic already tested (30 tests in web-settings); component smoke test added in package |
| Credential leakage into package state | Low | invariant preserved: transient `useState` only; pinned in smoke test (modal close clears state) |
| i18n key drift | Low | package-owned union = compile-time break on rename |
| CSS class coupling | Low | classes stay host-owned in `base.css`; package uses class names only (same as workers) |

---

## 8. VERDICT

**Next extraction: `@animastor/web-local-ai` — READY.**

- Single consumer, single file, zero session identity, zero global signals, zero persistence.
- All heavy domain logic already extracted and tested inside `@animastor/web-settings` — the remaining move is a pure UI shell.
- 3 ports, all fully precedented by `WorkerPorts`.
- The only architectural novelty (package→package dep on a pure Tier B package) is a provable DAG and gets its own boundary guard.

**Runners-up:** Workflows (NEAR READY — needs NavigationPort + TitlePort + routeState signal relocation + vendored DTO types + tests), Admin (NEAR READY — needs a subscribe/mutation AuthPort shape that does not exist yet + tests).

**Generator: NOT READY** — unchanged; deferred until identity boundary is addressed.

**Production code: UNCHANGED. This is a reconnaissance/audit-only document.**

# ComfyUI Workflow Connector — Preparation Phase Report

**Date:** 2026-09-07
**Scope:** preparation for physical extraction of `animastor-comfyui-workflow-connector` (narrow core only).
**Basis:** `COMFYUI_WORKFLOW_CONNECTOR_RECONNAISSANCE.md` → `COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md`.
**Verdict:** module is READY for physical extraction without behavior change (details in the readiness doc §9).

---

## 1. Что проверено

- Ядро (`workflow-loader` + `connector-loader` + `entity-schema`, ~1400 LOC): зависимости только `fs/path/crypto`, ноль DB/Redis/business — подтверждено.
- Все 9 host-потребителей ядра перечислены и заморожены гардом (backend.cjs, comfyui-provider, audio×2, image×2, scene-orchestrator, workflow-manager, profile-override).
- Существующие guards: `phase3-provider-gateway.test.js:263,36` (пин require workflow-loader в seam), `phase7-extraction-readiness.test.js:190,307` (delegate/bypass baselines) — привязаны к backend-путям, обновление нужно только ПОСЛЕ extraction; сейчас не тронуты.
- Hardcoded node-id fallbacks `audio/generation.js:492,521-524,543-546` (`wfAudio["108"]`, `["71"]`, `["80"]`, `["74"]`) — зафиксированы как extraction blocker B1 (намеренно не тронуты).

## 2. Что изменено (минимально, без переноса production-файлов)

- `configure({ workflowsDir | connectorsDir, logger })` — dependency injection в обоих loader'ах; env (`WF_DIR`/`CONNECTOR_DIR`) и дефолты сохранены, host startup не изменён.
- Новый `backend/src/workflows/connector-api.js` — facade будущего модуля: `createWorkflowConnector → listWorkflows / getWorkflow / getConnector / validate / build` + typed errors (`WorkflowNotFoundError`, `ConnectorMissingError`, `IncompatibleWorkflowError`, `BuildError`); ComfyUI node-id скрыты, `getConnector` возвращает entity-level view.
- Исправлен `computeWorkflowHash` (прежде хэшировались только top-level ключи — `{"1":{},"2":{}}`; контент узлов не участвовал). Хэши эфемерны (connectors ship `workflowHash: ""`, auto-populate на boot), ничего не персистится → безопасно.
- Экспортирован `validateConnector` (латентный TypeError в путях validate/add у workflow-manager).
- `loadWorkflows()` теперь fresh-load (очищает реестр; не накапливает phantom-записи при смене директории).
- Package-owned тесты: `backend/tests/workflows/connector-core.test.js` (34) + fixtures (hermetic, ноль DB/Redis/GPU Hub).
- Новый architecture guard: `backend/tests/architecture/comfyui-connector-core-boundary.test.js` (CB-T1 core purity + consumer freeze, CB-T2 API скрывает ComfyUI internals).
- `backend/package.json`: скрипт `test:connector-core`.
- Документ: `docs/architecture/COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md` (граница, входы/выходы, dependencies, public API, blockers, migration order из 5 шагов, rollback strategy, тест-план).

## 3. Blockers (для полной версии модуля, НЕ для узкого extraction)

1. **B1** — hardcoded node-id fallbacks в `audio/generation.js` (требует изменения business logic: сделать connectors обязательными).
2. **profile-override** читает connector как settings-store (read-port — follow-up).
3. **`comfyui-provider → gpu-dispatcher`** прямой require (dispatcher injection — вместе с миграцией seam, шаг 3 migration order).
4. **Контракт C12** (media generation provider contract) отсутствует — Phase 12.

## 4. Готовность к physical extraction

**ДА.** Узкий core (trio + connector-api + JSON assets + hash/compat/binding) можно извлекать физически как `animastor-comfyui-workflow-connector` с нулевым изменением поведения. Конкретный план по файлам — `COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md` §6 (5 шагов: package → 9-file import swap → assets → guard updates → удаление шимов).

## 5. Тесты

| Suite | Результат |
|---|---|
| `tests/workflows/connector-core.test.js` (новый, package-owned) | 34/34 |
| `tests/architecture/comfyui-connector-core-boundary.test.js` (новый guard) | 4/4 |
| Полный backend suite (`npm test`) | 357 passing (319 база + 38 новых), 0 failing |
| Architecture suite (`npm run test:arch`) | 323 passing |
| Syntax smoke (`pretest`) | pass |

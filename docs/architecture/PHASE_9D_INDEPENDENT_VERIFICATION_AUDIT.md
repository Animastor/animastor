# PHASE 9D — Independent Verification Audit (physical worker extraction)

**Status:** PASS WITH FINDINGS. Коммит `3fefcbda` действительно работает и не
сломал существующие deployment paths. Архитектура не улучшалась и не
рефакторилась — только независимая проверка фактических результатов.
**Date:** 2026-09-06
**Target:** HEAD `3fefcbda` (Phase 9D — physical worker extraction).
**Baseline сравнения:** `8350d997` (Phase 9C) — для классификации failures как
PRE-EXISTING vs REGRESSION.
**Repo state:** рабочее дерево чистое до и после всех прогонов (незакоммиченных
изменений, необходимых для прохода тестов, нет).

---

## Verdict summary

| Check | Result |
|---|---|
| Full backend test suite | 2795 passing / 6 failing — все 6 PRE-EXISTING (воспроизводятся на `8350d997`) |
| Worker package tests (`worker/tests/run-all.cjs`) | **45 / 45 pass** |
| Architecture tests (включая `phase9d-worker-package.test.js`) | 262 passing / 1 failing (PRE-EXISTING) |
| phase9d suite | **14 / 14 pass** (включая negative control) |
| Protocol parity (`sync-protocol.cjs --check` + ручной byte-diff) | **PASS** |
| Standalone worker (npm pack → clean dir → `node worker.cjs`) | **PASS** (fail-closed + full startup) |
| Deployment compatibility (4 канала) | **PASS** |

---

## 1. Test suite

### 1.1 Backend (полный прогон)

`cd backend && npx mocha --exit 'tests/**/*.test.js'`

- **HEAD `3fefcbda`: 2795 passing / 6 failing.**
- **Parent `8350d997` (9C): 2812 passing / 7 failing** (разница в абсолютных
  числах — в 9D из backend-дерева удалён `worker-bundle-env.test.js`, тесты
  переехали в `worker/tests/`, и добавлена phase9d-серия из 14 тестов).

Все 6 failures на HEAD **классифицированы как PRE-EXISTING / ENVIRONMENT** —
каждый воспроизводится на родительском коммите:

1. `LLM Sharing Phase 1 — Control Plane (SH-AI-1)` — `ai-endpoint-sharing.test.js:688`
   ("expected 1 to equal +0"). Живой Postgres; межпрогонное загрязнение DB-состояния.
2. `LLM Sharing Phase 2 — consumer resolver (SH-AI-3)` — `ai-shared-stream.test.js`.
3. `LLM Sharing Phase 3 — production SSE route` — `ai-shared-stream.test.js:1209`.
4. `architecture: LAC liveness / registry contract` — `phase2-lac-transport-contract.test.js:219`
   (устаревший comment-pin, файл не менялся с Phase 8C).
5. `Worker visibility — /worker/counts acceptance (A vs B)` — 2s mocha timeout;
   **поодиночке файл проходит 23/23** → тайминговый флейк полного прогона.
6. `Share policies — /worker/counts acceptance (D3)` — 2s mocha timeout.

Ни один из этих файлов не изменён коммитами 9C/9D; 9D не трогает их код-пути.

### 1.2 9D-релевантные backend-файлы

`gpu-hub-artifacts`, `installer-cpu`, `installer-phase15`, `installer-resolver`,
`orchestration-stabilization`, `installer-resume`, `installer-engine`,
`installer-security`, `gpu-hub-worker-source`, `installer-setup-contract`,
`private-worker-phase2`: **209 / 209 pass**.

### 1.3 Architecture-серия (включая phase9d)

- Полный `tests/architecture/*.test.js`: 262 passing / 1 failing (тот же LAC
  comment-pin, PRE-EXISTING).
- `phase9d-worker-package.test.js`: **14 / 14 pass** — D1 manifest, D2 surface
  freeze (bundle-директория = ровно runtime-набор), D3 require containment
  (+negative control), D4 byte-parity generated copy, D5 worker.cjs потребляет
  копию, D6 install-manifests несут полный набор, D7 deployment wiring, D8
  negative control parity (tamper → детект, restore → clean).
- Сопряжённые: `phase9c-contracts`, `phase2-job-protocol-v2`, `gpu-hub-contract`:
  57/57 в сумме с phase9d.

### 1.4 Worker package (package-owned, zero-dep)

`cd worker && node tests/run-all.cjs` → **45 pass / 0 fail**:
`worker-env` (5), `worker-cleanup` (11), `worker-cleanup-journal` (15),
`job-protocol` (6), `package` (6), `standalone` (2).

Note: 6-й тест прежнего `backend/tests/worker-bundle-env.test.js` ("manifest file
lists ship the loader") не перенесён 1:1, но его утверждение покрыто phase9d D6
(каждый manifest несёт полный runtime-набор, включая `worker-env.cjs`). Пробела
покрытия нет.

---

## 2. Protocol parity (contracts ↔ worker copy)

- `node worker/tools/sync-protocol.cjs --check` → exit 0.
- Ручной byte-diff: тело после marker `// ===8<=== canonical source (verbatim…)`
  **byte-identical** canonical `contracts/src/job-protocol-v2.js` (длины равны,
  sha256 в header совпадает с фактическим хешем canonical).
- `contracts/` и `gpu-hub/` в коммите 9D **не изменялись**; sha256 canonical
  источника идентичен на 9C и 9D → wire behavior / Job Protocol v2 не тронут.
- `worker.cjs`: `PROTOCOL_VERSION` и `JOB_ID_SPLIT_RE` импортируются из
  `./job-protocol-v2.cjs`; inline-литералов (`const PROTOCOL_VERSION = 2`,
  `/:(iu_image|image|audio|video)$/`) в `worker.cjs` нет; обе точки split
  (`task.assets.images` / `task.assets.image` — именование input-файлов) идут
  через `JOB_ID_SPLIT_RE`. Второй реализации протокола в bundle нет.

---

## 3. Standalone worker (npm pack → clean dir)

- `npm pack --dry-run` / фактический tarball: ровно allowlist-набор файлов —
  `worker.cjs`, `worker-env.cjs`, `worker-cleanup.cjs`,
  `worker-cleanup-journal.cjs`, `job-protocol-v2.cjs`, `.env.example`
  (+ `package.json`, включаемый npm автоматически; `package-lock.json` npm
  исключает из tarball сам). Лишние файлы не захватываются.
- Распаковка в чистую директорию → `node worker.cjs` без credential:
  **exit 1**, fail-closed сообщение (`Worker authentication failed…`,
  `ANIMASTOR_WORKER_TOKEN`), никакой протокольной активности до выхода.
- С `ANIMASTOR_WORKER_TOKEN=wrk.…` + unreachable endpoints
  (`HUB_URL=http://127.0.0.1:1` и т.п.): полный startup — `Worker version: 2.1.0`,
  `Protocol version: 2` (из generated-копии), credential verification warning,
  `Waiting for ComfyUI` (ожидание с backoff). Версия протокола читается из
  копии внутри bundle — self-containment подтверждён.

---

## 4. Deployment compatibility (4 канала)

Ни один production-файл не удалён и не перемещён; `worker/worker/` остался
физическим путём всех каналов:

1. **Hub volume mounts** (`docker-compose.yml`): `./worker/worker/worker.cjs:/app/worker-source/worker.cjs:ro`
   (deprecated single-file) и `./worker/worker:/app/worker-bundle:ro` (canonical
   tar) — на месте.
2. **Install manifests** (`audio/qwen-tts`, `image/qwen-image`, `video/ltx-2.3`):
   `worker_bundle.files` **точно** совпадает с содержимым `worker/worker/`
   (8 файлов), `source.options[].path = "worker/worker/"` (repo fallback) — у всех трёх.
3. **Installer repo fallback** (`backend/src/installer/engine/worker.js`):
   `repoRoot/worker/worker` как первый источник — на месте.
4. **Deprecated worker-source** (`gpu-hub/gpu-hub.js`): `GET /worker-source`
   читает `/app/worker-source/worker.cjs` (read-only mount) — на месте.

---

## 5. Findings

1. **[косметика]** Evidence-строки в install-manifests ссылаются на
   `worker.cjs header: 'Node 20+ with global fetch is assumed'` и
   `(v2.0.0, Node 20+)`, тогда как header теперь `v2.1.0 / Node 18+`.
   Это описательные `notes`/`evidence` внутри JSON — installer-логика их не
   читает, тесты не проверяют, но внутренне противоречат артефакту.
2. **[pre-existing]** 6 падающих тестов полного backend suite — все
   воспроизводятся на `8350d997` (LLM-sharing DB-pollution, LAC comment-pin,
   2× 2s-timeout флейка /worker/counts, проходящие поодиночке). К 9D отношения
   не имеют.
3. **[pre-existing][косметика]** Порт unit-тестов не строго 1:1 (env: 6→5 its),
   пробела покрытия нет — см. §1.4.

---

## 6. Conclusion

Phase 9D работает как заявлено: сгенерированная копия Job Protocol v2
байт-эквивалентна canonical-источнику, worker standalone корректно
fail-closed без credential и полноценно стартует с `Protocol version: 2` из
копии, все четыре deployment-канала не сломаны, wire-контракт не изменён.
Замечания косметические/документационные — блокеров и регрессий нет.

# PHASE 8B — Final Verification Report (commit `1b110a29`)

Дата: 2026-09-05
Проверяемый коммит: `1b110a29` («arch: add phase 8 LAC package preparation (spec, tests, contract sync, MIT license)»)
Цель: Phase 8B Verification Gate для подготовленного `local-ai-connector/`.
Принцип: verification-only задача — НИЧЕГО не рефакторилось и не извлекалось; никаких unrelated fixes.

---

## 1. Команды тестового контура

| Команда | Область |
|---|---|
| `npm test` (из `local-ai-connector/`) | пакетные тесты LAC (`node test/run-all.cjs`) |
| `npx mocha --exit tests/architecture/lac-contract-sync.test.js` | cross-side contract test (из `backend/`) |
| `npm run test:arch` (из `backend/`) | architecture Phase 1–7 + Phase 8 контракт |
| `npm run test:syntax` (из `backend/`) | `bash ../scripts/syntax-smoke.sh` — весь production JS/CJS |
| Полный backend | `mocha --exit $(find tests -name '*.test.js')` — 151+ файл, та же инвокация, что в Phase 7 baseline |
| `npm pack --dry-run` (из `local-ai-connector/`) | содержимое будущего npm-пакета, без публикации |

## 2. Результаты прогонов

| Набор | Результат |
|---|---|
| LAC package tests (`npm test`) | 69 pass / 0 fail |
| Cross-side contract test (`lac-contract-sync.test.js`) | 22 pass / 0 fail |
| Architecture (`test:arch`) | 226 pass / 2 fail (Phase 7 baseline: 204/2; +22 — новый contract suite; те же 2 pre-existing F6/F7) |
| Syntax smoke | PASS — backend/src, gpu-hub, worker и весь `local-ai-connector/` (включая тесты) |
| Полный backend | 2792 pass / 6 fail (Phase 7 baseline: 2769/7; +23 = +22 contract suite + private-worker-visibility прошёл в этот прогон) |

## 3. Автономность LAC-тестов

- Harness (`test/harness.cjs`, `test/run-all.cjs`) использует только node builtins; `node_modules` пакета содержит только `ws`.
- Ни одного require на backend/PG/Redis/Mocha/Chai в `test/`.
- Пакетные тесты исполняются без backend, PostgreSQL и Redis.

## 4. Не-вакуумность cross-side contract test

`backend/tests/architecture/lac-contract-sync.test.js` — не source-only guard:
- требует реальные модули обеих сторон: LAC `lib/*.cjs` + backend routes/transport/repo;
- минт реальные токены (llmc.* / llmcreg.*) и прогоняет hello/авторизацию;
- ассертит deep equality allowlist'ов, limits, error reasons, token grammar и runtime types между LAC и backend.

## 5. Классификация падений полного backend-прогона (6)

Все 6 падений — пред-существующие, идентичны Phase 7 baseline; 0 новых, 0 регрессий от `1b110a29`.

| # | Тест | Причина | Категория |
|---|---|---|---|
| F1 | `ai-endpoint-sharing` — «no policy row is enabled unless the owner explicitly enabled it» | В общей dev-БД остался enabled share-policy вне тестовых воркспейсов → 1 вместо 0 | **Окружение (состояние БД)** (P7 F1) |
| F2 | `ai-shared-inference` — «16b. shared snapshot is safe for health checks» | Устаревший ассерт: тест написан до liveness-ветки `checkAIHealth` (коммит `537fb76a`) | **Устаревший ассерт (дрейф кода)** (P7 F2) |
| F3 | `ai-shared-stream` — «CON1. limit=1: second concurrent request is rejected» | Флаки тайминга: второй запрос иногда успевает занять слот | **Флаки конкурентности** (P7 F3) |
| F4 | `worker-share-policy` — «D3: counted in owner private AND global pool» | Тест ~4.7s при дефолтном mocha-таймауте 2s; не переопределяет `this.timeout()` | **Нет переопределения таймаута** (P7 F4) |
| F5 | `phase2-job-protocol-v2` — «job_id type family is anchored…» | `worker.cjs` заканчивается бутстрапом, `$`-якорь ассерта устарел | **Устаревший ассерт (дрейф кода)** (P7 F6) |
| F6 | `phase2-lac-transport-contract` — «LAC registry is the authoritative WS liveness» | Фраза «is a stale trace» переписана в `shared-pool.js` | **Устаревший ассерт (дрейф кода)** (P7 F7) |

Пройденный в этот прогон P7 F5 (`private-worker-visibility` timeout) — флаки, стабильно проходит в изоляции (23/23). Устаревшие ассерты F2/F5/F6 чинятся отдельно (обновление baseline'ов), не в рамках Phase 8B.

## 6. npm package verification (`npm pack --dry-run`)

- name: `animastor-ai-connector` ✓
- version: `0.1.0` (без bump) ✓
- tarball: НЕ создан (dry-run), архив для проверки не публиковался ✓
- Содержимое (11 файлов): `LICENSE`, `README.md`, `SPEC.md`, `index.cjs`, `lib/chat.cjs`, `lib/config.cjs`, `lib/connector.cjs`, `lib/log.cjs`, `lib/runtime-adapters/index.cjs`, `lib/runtime-adapters/openai-compatible.cjs`, `package.json`
- Отсутствуют: тесты, backend-файлы, docs/dev-артефакты, secrets ✓
- `LICENSE`/`SPEC`/`README` присутствуют ✓
- Dependencies: минимальны — только `ws` (^8.21.3) ✓
- `files` allowlist в package.json: `["index.cjs","lib/","README.md","SPEC.md","LICENSE"]` ✓

## 7. Extraction-readiness checks

- Физического extraction нет: ни `git mv`, ни новых каталогов; рабочее дерево чистое.
- LAC production-код не зависит от backend runtime: в `index.cjs`/`lib/` только относительные require + node builtins + `ws`.
- Пакетные тесты автономны (см. §3).
- `package.json` готов к отдельному npm-пакету: name/files/deps минимальны, версия `0.1.0`.
- `SPEC.md` соответствует фактическому wire protocol:
  - `protocol_version: 1` на обеих сторонах (LAC `lib/connector.cjs`, backend `ai-connector-routes.cjs` `PROTOCOL_VERSION = 1`);
  - token grammar `llmc.*` / `llmcreg.*` идентичен на обеих сторонах;
  - limits / errors / runtime types сверены deep equality в contract test (§4, 22 pass).
- README самодостаточен: ссылка на Animastor monorepo — атрибуция, в README прямо указано «fully self-contained for use and operation»; чтения planning-документа monorepo не требуется.
- Расхождений protocol_version / limits / errors / token grammar / runtime types между LAC и backend нет.

## 8. Guard integrity

- Guards Phase 1–7 не изменялись; production behavior не менялся.
- Запрещённые действия не выполнялись: `git mv`, extraction, npm publish, UI changes, unrelated fixes, version bump — нет.
- Ни один guard не оказался stale из-за подготовки пакета → blockers отсутствуют.

## 9. Состояние git после прогонов

- HEAD: `1b110a29` (проверяемый коммит).
- `git status --short` — пусто: тесты ничего не изменили, working tree чистый, временных артефактов нет.

## 10. Итоговая рекомендация

**Phase 8B: READY.** Коммит `1b110a29` чист: 0 регрессий; LAC-пакет автономен, contract test не-вакуумен, package dry-run корректен, расхождений wire protocol нет. Единственные падения — пред-существующие (окружение / устаревшие ассерты / флаки), к Phase 8B отношения не имеют.

**NEXT STEP:** Phase 8C — физический extraction `local-ai-connector/` в отдельный npm-пакет.
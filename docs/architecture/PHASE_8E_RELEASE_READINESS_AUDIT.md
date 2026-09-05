# PHASE 8E — Release Readiness Audit (commit `4fb4a82c`)

Дата: 2026-09-05
Проверяемый коммит: `4fb4a82c` («arch: add LAC legacy-path guard + Phase 8D post-extraction audit report»)
Цель: определить, готов ли standalone-пакет `ai-connector/` (`animastor-ai-connector@0.1.0`) к реальному npm-релизу.
Принцип: **audit-only** — ничего не публиковано, версия/протокол/CLI не менялись, код не менялся вовсе; все симуляции выполнялись в `/tmp` throwaway-директориях, рабочее дерево оставалось чистым.

---

## 1. Команды тестового контура

| Команда | Область |
|---|---|
| `npm install` / `npm test` (из `ai-connector/`) | пакетные тесты LAC (69 тестов, включая contract) |
| `npm pack --dry-run` (из `ai-connector/`) | содержимое npm-пакета без публикации |
| реальный `npm pack` + установка `.tgz` в чистый проект (`/tmp`) | симуляция npm-релиза |
| `npx animastor-ai-connector --help` (из установленного `.tgz`) | CLI contract после установки |
| `npx mocha --exit tests/architecture/lac-contract-sync.test.js` (из `backend/`) | cross-side contract test |
| `npm run test:arch` / полный backend `mocha --exit $(find tests -name '*.test.js')` | регрессионный контур (baseline Phase 8D) |
| `npm run test:syntax` (из `backend/`) | syntax smoke (включая `ai-connector/lib/**`) |
| статический security-скан | secrets, debug-артефакты, fs/net/shell coupling |

## 2. Package metadata — PASS

- `name: animastor-ai-connector`, `version: 0.1.0` (без bump), `description` соответствует факту.
- `bin.animastor-ai-connector = index.cjs` ✓, shebang присутствует, `require.main` guard ✓.
- `files` allowlist ровно 11 файлов: `index.cjs`, `lib/` (5 файлов), `README.md`, `SPEC.md`, `LICENSE`, `package.json` — тесты, backend-файлы, dev-артефакты в tarball **не попадают**.
- `engines: node >=18` соответствует README (built-in fetch/AbortController).
- `license: MIT` (файл LICENSE в пакете), `repository` (monorepo + `directory: ai-connector`), `bugs` заполнены.
- Dependencies: единственная runtime-dep `ws@^8.21.3`; devDependencies отсутствуют; собственные тесты не являются runtime dependency (`test/run-all.cjs` — только `node:test`-подобный собственный harness).

## 3. Public CLI contract — PASS (README/usage ↔ фактическое поведение)

| Проверка | Результат |
|---|---|
| `--help` / `-h` | stdout, exit 0 ✓ |
| Неверный флаг (`--bogus`), невалидный URL/token/base-url | «Configuration invalid: …» на stderr, exit 2 ✓ |
| `ws://` вне loopback отклоняется; `ws://127.0.0.1` разрешён (dev) ✓ |
| `--base-url` вне loopback без `--allow-lan` отклоняется ✓ |
| `--heartbeat-interval-ms` clamp 250–600000 ✓ |
| Env fallback `ANIMASTOR_CONNECTOR_URL` / `ANIMASTOR_CONNECTOR_TOKEN`; CLI флаги побеждают env ✓ |
| Дефолты: `base-url = http://127.0.0.1:11434`, `runtime-type = openai-compatible` ✓ |
| Токен ни в одной ошибке не эхо-выводится (поведенчески проверено contract-тестом) ✓ |
| SIGINT/SIGTERM → чистый `stop()` + exit 0 ✓ |
| `--log-file` принимается, инертен (in-memory op log) — задокументировано в README и SPEC §16.1 ✓ |

README не обещает поведение, которого нет: все 8 флагов, обе env-переменные, exit-коды 0/2, дефолты и поведение при misconfiguration подтверждены фактическими прогонами установленного пакета.

## 4. Protocol / SPEC contract — PASS

- **Пакетный contract test** (`test/contract.test.cjs`, входит в 69): `protocol_version: 1` в hello, frame-surface, error-allowlist ↔ SPEC §8, limits ↔ chat.cjs LIMITS (64 / 32 KB / 128 KB / 8192 / 1000–180000 / 2 / 60 KB / 100 000), runtime-type allowlist, token grammar, heartbeat clamp, credential-safety behavior — PASS.
- **Cross-side** `lac-contract-sync.test.js`: 22/22 PASS (зеркало лимитов transport.js ↔ пакет, SPEC-документирование кодов ошибок, package.json resolution). Тест не ослаблялся.
- Фактические расхождения SPEC ↔ код не найдены; известные V1-quirks честно задокументированы в SPEC §16 (log-file инертен, heartbeat_interval_ms optional, reserved поля heartbeat).

## 5. Security release check — PASS (статический аудит)

| Проверка | Результат |
|---|---|
| Credentials в логах | отсутствуют: `log.cjs` — строгий allowlist полей; connector логирует только metadata; `llmc.*` раскрывается ровно один раз через `hooks.onCredential` (stdout, guard от повторной печати) |
| Secrets в error messages | отсутствуют: конфиг-ошибки валидируют shape без echo; `chat.error` — только фиксированные sanitized-сообщения |
| Повторная отправка credential после activation | нет: credential идёт только в `hello` (per connect); minted `llmc.*` никогда не ре-отправляется и не логируется |
| Hardcoded secrets | 0 (grep по `lib/`, `index.cjs`) |
| Debug/test backdoors | отсутствуют; тестовые швы `_handleMessage`/`_sendHeartbeat` — library API объекта сессии, недоступны извне процесса |
| Filesystem/DB/network coupling | 0: require только `ws` + `crypto`; нет `fs`, `child_process`, `.listen(`, `createServer`; op log — in-memory ring buffer |
| Неизвестные/некорректные входы | fail-closed: unknown flag → exit 2; malformed JSON / unknown frame type — игнор; hostile поля (url/base_url/tool_calls) дропаются на validation seam; `redirect:'error'`; size-capped reads |
| `--log-file` | соответствует документации (принят, ничего не пишет на диск) |

Новых security-фич не добавлялось.

## 6. Package autonomy + npm simulation — PASS

- Чистая копия пакета **без** `node_modules` в `/tmp`: `npm install` → 1 пакет (`ws`), `npm test` → **69/69**.
- Не требует backend, PG, Redis, файлов корня monorepo, `node_modules` корня.
- Реальный `animastor-ai-connector-0.1.0.tgz` (33.8 kB, 11 файлов) собран в `/tmp` и установлен в чистый npm-проект: установилось ровно 2 пакета (connector + `ws`), bin-симлинк создан.
- `./node_modules/.bin/animastor-ai-connector --help` → usage, exit 0; `npx --no-install animastor-ai-connector --help` → exit 0; `require('animastor-ai-connector')` → API доступен.
- Живой прогон из чистого проекта (несуществующий WS endpoint): корректные metadata-логи, reconnect backoff, exit 2 при bad config.
- В установленном пакете 0 упоминаний путей monorepo/`/home/animastor`.
- `npm publish` НЕ выполнялся.

## 7. Repository boundary — PASS (без новых coupling после 8D)

- Production backend импортирует только собственные `services/ai-connector/*`, routes `ai-connector-routes.cjs`, repo `ai-connector-repo` — внутренности пакета (`ai-connector/lib/*`) в `backend/src` не требуются.
- Backend ↔ LAC связь — только через LAC v1 protocol boundary (`transport.js`).
- Импорты `../../ai-connector/lib/*` остаются **test-only** (8 backend-тестовых файлов) — ожидаемо.
- Guards живы: `dependency-guardrails.test.js` (R3: LAC — только ws+builtins), `lac-legacy-path-guard.test.js` (2/2, non-vacuous), `phase7-extraction-readiness.test.js`, `lac-contract-sync.test.js` — 26/26 при изолированном прогоне.

## 8. Regression suite (baseline Phase 8D)

| Набор | Результат |
|---|---|
| LAC package tests (`npm test`) | **69 pass / 0 fail** |
| Cross-side contract (`lac-contract-sync`) | **22 pass / 0 fail** |
| Architecture (`test:arch`) | **228 pass / 2 fail** (= 8D baseline; те же pre-existing F5/F6) |
| Полный backend | **2796 pass / 4 fail** (8D baseline 2791–2792/6–7 из 2798–2800; флаки F3/F4 в этом прогоне прошли) |
| Syntax smoke | PASS (все production JS/CJS, включая `ai-connector/lib/**`) |

Классификация failures (все — pre-existing, ни одного genuine regression / environment-нового):

| # | Тест | Категория |
|---|---|---|
| F1 | `ai-endpoint-sharing` — «no policy row is enabled unless…» | pre-existing — окружение (состояние dev-БД), P8B F1 |
| F2 | `ai-shared-inference` — «16b. shared snapshot…» | pre-existing — устаревший ассерт, P8B F2 |
| F5 | `phase2-job-protocol-v2` — «job_id type family…» | pre-existing — устаревший `$`-якорь ассерта, P8B F5 |
| F6 | `phase2-lac-transport-contract` — «LAC registry…» | pre-existing — фраза «is a stale trace» перенесена на другую строку комментария, P8B F6 |
| F3/F4 | `ai-shared-stream` CON1 / `worker-share-policy` D3 | pre-existing флаки — в этом прогоне прошли |

Ни один failure не связан с пакетом `ai-connector/` или фазой 8E.

## 9. Release blockers

**BLOCKER'ОВ НЕТ.** Stale-ассерты F1/F2/F5/F6 — backend-тесты вне границы npm-релиза пакета; в рамках Phase 8E не исправлялись (запрещено: unrelated code).

## 10. Guard

Новый architecture guard **не добавлялся**: обнаруженных release-critical boundary, не покрытых существующими тестами, нет (package contract test + lac-contract-sync + dependency-guardrails R3 + legacy-path guard закрывают все границы SPEC↔код, cross-side, deps, legacy-путь).

## 11. Критерий READY

| Условие | Статус |
|---|---|
| Package metadata корректна | PASS (§2) |
| CLI соответствует README/SPEC | PASS (§3) |
| Protocol соответствует SPEC | PASS (§4) |
| Security audit | PASS (§5) |
| Package автономен | PASS (§6) |
| Clean `.tgz` устанавливается в чистый проект | PASS (§6) |
| `--help` работает после установки `.tgz` | PASS (§6) |
| Package tests | PASS (69/69) |
| Contract tests | PASS (8/8 package + 22/22 cross-side) |
| Architecture без новых failures | PASS (228/2, оба старые) |
| Backend без новых regressions | PASS (все 4 pre-existing) |
| npm dry-run | PASS (11 файлов, 33.8 kB) |
| Secrets/dev artifacts | PASS (отсутствуют) |
| `npm publish` | НЕ выполнялся |
| Working tree clean | PASS |

---

**PHASE 8E: READY.** Пакет `animastor-ai-connector@0.1.0` готов к npm-релизу: metadata, CLI, SPEC, security, автономность и clean-install симуляция — PASS; регрессий нет; протокол/CLI/версия не тронуты.

**NEXT STEP:** явная команда владельца на `npm publish` (первый релиз `0.1.0`); технических препятствий нет.

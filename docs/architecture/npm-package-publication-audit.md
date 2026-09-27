# npm Package Publication Audit — `packages/*`

- **Дата аудита:** 2026-09-26
- **Ветка:** `c21.4-physically-extract-analysis-from-backend`
- **HEAD:** `3c3329d30e574024c4606f12614fd6e8a3ff79a7` (2026-09-26 07:22 UTC)
- **Метод:** прямые запросы к npm registry (registry.npmjs.org) для всех 29 пакетов; скачивание и `diff` опубликованных tarball'ов всех 28 опубликованных версий с локальными каталогами (исключая `node_modules`, `package-lock.json`); `git log` по каждому каталогу пакета; `npm pack --dry-run` для неопубликованного пакета; smoke-тесты `npm install` + `require()` по опубликованным tarball'ам (`@animastor/contracts` — 21 export, `@animastor/parser` — 22, `@animastor/vbook-runtime` — 10) и локального `@animastor/url-safety` (8) — все успешны.
- **Это аудит.** Ничего не публиковалось, версии и `package.json` не менялись.

## Сводка

| Категория | Кол-во | Пакеты |
|---|---|---|
| Всего каталогов `packages/*` | 30 | — |
| С `package.json` (публикуемые) | 29 | — |
| NOT_PUBLISHED | 1 | `@animastor/url-safety` |
| CHANGES_NOT_PUBLISHED (+VERSION_NOT_BUMPED) | 4 | `@animastor/generation`, `@animastor/gpu-hub`, `@animastor/parser`, `@animastor/vbook-runtime` |
| METADATA_PROBLEM (код синхронизирован) | 1 | `@animastor/editor` (CHANGELOG — копия CHANGELOG player) |
| UP_TO_DATE без замечаний | 20 | см. таблицу |
| UP_TO_DATE с косметическими замечаниями | 3 | `animastor-ai-connector`, `animastor-comfyui-workflow-connector`, `@animastor/orchestration` |
| PUBLISHED_VERSION_AHEAD / VERSION_BUMPED_NOT_PUBLISHED | 0 | — |
| Не пакет (нет `package.json`) | 1 | `animastor-worker` (ops-скрипты, вне аудита) |

## 0. Фактический стандарт оформления Animastor (выведен из существующих пакетов)

**Node-side `@animastor/*` (CommonJS):**

- `name`: `@animastor/<slug>`, CommonJS, поле `type` отсутствует.
- Точка входа — реальный файл в `src/` (`src/index.js` или `src/index.cjs`), `main` указывает на него; публичный API — `src/index.*` (+ subpath exports для второстепенных ярусов).
- `files`: `["src/", "README.md", "LICENSE", "CHANGELOG.md"]` — **тесты не публикуются** (остаются в репо, запускаются через `npm test`).
- `engines.node`: `>=18` (`@animastor/installer` и `@animastor/auth` — `>=20`).
- `license: "MIT"`, `publishConfig: {"access":"public"}`.
- `repository`: `git+https://github.com/Animastor/animastor.git` + `directory: packages/<dir>`; `bugs`: issues GitHub; `homepage`: tree-ссылка (опционально, у большинства заполнена).
- `scripts`: минимум `test`.
- README + LICENSE — всегда; CHANGELOG — у большинства (5 опубликованных пакетов без него — см. §D).

**Web-пакеты `@animastor/web-*` (13 шт.) — отдельный, внутренне согласованный стандарт:**

- TypeScript, `type: "module"`, сборка tsup → `dist/` (в git не хранится, игнорируется).
- `exports`: `.` с `types`/`import`/`default` + `./package.json`; `main: dist/index.js`.
- `files: ["dist","README.md","LICENSE"]`; `scripts: build, typecheck, test, prepublishOnly`.
- Отклонения от node-стандарта (осознанные): нет `engines`, нет CHANGELOG, CHANGELOG-подобная документация — в README. Между собой оформлены единообразно (одно исключение: `web-book-session` без `bugs`/`homepage`).

**Standalone-коннекторы (2 шт., legacy):** `animastor-ai-connector`, `animastor-comfyui-workflow-connector` — unscoped имена, код в корне (`index.cjs`, `src/`), без `exports`-карты, без `publishConfig`. Опубликованы до введения `@animastor/*`-стандарта.

## 1. Основная таблица

| Package | Local version | npm version | Published? | Local changes? | Documentation | Packaging | Status | Action |
|---|---|---|---|---|---|---|---|---|
| @animastor/ai-agent | 0.1.0 | 0.1.0 | да | нет | R/L/C ✓ | ✓ | UP_TO_DATE | no action required |
| @animastor/ai-analysis | 0.1.0 | 0.1.0 | да | нет | R/L/C ✓ | ✓ | UP_TO_DATE | no action required |
| animastor-ai-connector | 0.1.0 | 0.1.0 | да | только метаданные (`repository.directory` поправлен после публикации; runtime-код идентичен tarball) | R/L ✓, CHANGELOG ✗ | нет `exports`-карты (standalone-стандарт) | UP_TO_DATE | no action required (опционально: CHANGELOG + `exports` в следующем релизе) |
| @animastor/assistant | 0.1.0 | 0.1.0 | да | нет | R/L/C ✓ | ✓ | UP_TO_DATE | no action required |
| @animastor/auth | 0.1.0 | 0.1.0 | да | нет | R/L/C ✓ | ✓ | UP_TO_DATE | no action required |
| animastor-comfyui-workflow-connector | 0.1.0 | 0.1.0 | да | нет (`tests/` не закоммичены, в tarball не попадают) | R/L ✓, CHANGELOG ✗ | нет `exports`-карты (standalone-стандарт) | UP_TO_DATE | no action required (опционально: CHANGELOG, закоммитить tests/) |
| @animastor/contracts | 0.1.1 | 0.1.1 | да | нет | R/L ✓, CHANGELOG ✗ | ✓ | UP_TO_DATE | no action required (опционально: CHANGELOG) |
| @animastor/editor | 0.1.0 | 0.1.0 | да | нет (код идентичен tarball) | R/L ✓, **CHANGELOG — точная копия CHANGELOG `@animastor/player`** | ✓ (но неверный CHANGELOG попал и в опубликованный tarball — npm авто-включает CHANGELOG.md) | METADATA_PROBLEM | fix CHANGELOG → bump patch 0.1.1 → update CHANGELOG → npm publish |
| @animastor/generation | 0.1.0 | 0.1.0 | да | **да: runtime + API** (`src/dirty-grammar/` — 6 новых модулей; `exports["./dirty-grammar"]`; `dirtyGrammar` в index; фикс `media-registry.js`; deps не менялись) | R/L ✓, CHANGELOG ✗ | ✓ | CHANGES_NOT_PUBLISHED + VERSION_NOT_BUMPED | bump (additive API → patch 0.1.1 допустим; консервативно minor 0.2.0) → create CHANGELOG → npm publish |
| @animastor/gpu-hub | 0.1.0 | 0.1.0 | да | **да: runtime** (`gpu-hub.js` — канонический путь installer package.json; `Dockerfile`; `tests/` не закоммичены) | R/L ✓, CHANGELOG ✗ | ✓ | CHANGES_NOT_PUBLISHED + VERSION_NOT_BUMPED | bump patch 0.1.1 → create CHANGELOG → npm publish |
| @animastor/installer | 0.1.0 | 0.1.0 | да | нет (после публикации только docs/metadata-фикс 39d5caed, уже совпадает с tarball; `tests/` не закоммичены) | R/L ✓, CHANGELOG ✗ | ✓ | UP_TO_DATE | no action required |
| @animastor/orchestration | 0.1.1 | 0.1.1 | да | нет | R/L ✓, CHANGELOG ✗ | отклонение: `files` включает `test/` (публикует тесты) | UP_TO_DATE | no action required (опционально: убрать `test/` из `files`, CHANGELOG) |
| @animastor/parser | 0.1.0 | 0.1.0 | да | **да: runtime + API + deps** (+`src/source-coverage.js`, +`src/encoding-detect.js`, 20 новых exports, `exports` +2 subpath, dep +`iconv-lite`) | R/L/C ✓, но CHANGELOG без записи о новых изменениях | ✓ | CHANGES_NOT_PUBLISHED + VERSION_NOT_BUMPED | bump (additive → patch 0.1.1 допустим; minor 0.2.0 консервативнее) → CHANGELOG entry → npm publish |
| @animastor/player | 0.1.0 | 0.1.0 | да | нет | R/L/C ✓ | ✓ | UP_TO_DATE | no action required |
| @animastor/url-safety | 0.1.0 | — | **нет** | н/д | R/L/C ✓ (README, LICENSE, CHANGELOG 0.1.0) | ✓ `npm pack --dry-run`: ровно 5 файлов (CHANGELOG, LICENSE, README, package.json, src/index.cjs); `require()` OK (8 exports) | NOT_PUBLISHED → READY_TO_PUBLISH | first publication → npm publish |
| @animastor/vbook-runtime | 0.1.0 | 0.1.0 | да | **да: runtime + API + deps** (parser-модули удалены из пакета — вынесены в `@animastor/parser`; удалены subpath-exports `./language-detector`, `./lazy-book/parser`; dep `tinyld` → `@animastor/parser: file:../animastor-parser`) | R/L/C ✓, но изменения только в секции **Unreleased** | ✓ (см. замечание про `file:` dep в §D) | CHANGES_NOT_PUBLISHED + VERSION_NOT_BUMPED | bump 0.2.0 (удаление публичных exports = breaking; в 0.x breaking допустим минором) → оформить CHANGELOG 0.2.0 → заменить `file:` на registry-диапазон → npm publish |
| @animastor/web-ai-chat | 0.1.0 | 0.1.0 | да | нет | R/L ✓, CHANGELOG ✗ (стандарт web-*) | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-book-session | 0.1.0 | 0.1.0 | да | нет | R/L ✓, CHANGELOG ✗ | нет `engines`; **нет `bugs`/`homepage`** | UP_TO_DATE | no action required (опционально: добавить bugs/homepage) |
| @animastor/web-editor | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-file | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-generator | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-generator-config | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-generator-sse | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-generator-vbook | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-local-ai | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-navigator | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required (локальный stale-артефакт `animastor-navigator-0.1.0.tgz` git-ignored — не влияет) |
| @animastor/web-player | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-settings | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |
| @animastor/web-workers | 0.1.0 | 0.1.0 | да | нет | R/L ✓ | нет `engines` | UP_TO_DATE | no action required |

Обозначения: R = README, L = LICENSE, C = CHANGELOG.

## 2. Детали «changes after publish» (git-хронология по каждому изменившемуся пакету)

### @animastor/generation (опубликован 2026-09-11 05:42; соответствует коммиту `0e58a434` 2026-09-11 05:34)
- `ebaa9844` 2026-09-11 10:30 — runtime: фикс пути в `src/core/media-registry.js` (1 строка).
- `1900d931` 2026-09-25 20:52 — **публичный API**: `src/dirty-grammar/` (prompt-dependency-registry, dependency-graph, scene-hash, speech-estimation, cyr-latin-map, index), `dirtyGrammar` в `src/index.js`, subpath export `./dirty-grammar`.
- `d4894232` 2026-09-26 00:27 — runtime: фикс в `dirty-grammar/dependency-graph.js` + тесты.
- dependencies: без изменений (`@animastor/contracts ^0.1.0`). README/CHANGELOG: CHANGELOG отсутствует. exports: расширились.
- **Требуемый bump:** additive API → patch `0.1.1` допустим; консервативно minor `0.2.0`.

### @animastor/gpu-hub (опубликован 2026-09-14 02:58; соответствует `904f0ca3` 2026-09-14 02:57)
- `97df4b7d` 2026-09-15 17:39 — runtime: `gpu-hub.js` (резолв канонической версии installer из `packages/animastor-installer/` в dev-окружении) + `Dockerfile`.
- API/exports/dependencies/README: без изменений (CHANGELOG отсутствует).
- **Требуемый bump:** patch `0.1.1`.

### @animastor/parser (опубликован 2026-09-08 07:28; соответствует `9e037a0e` 2026-09-08 07:27)
- `1900d931` 2026-09-25 20:52 — **публичный API + deps**: `src/source-coverage.js` (461 строка), `src/encoding-detect.js` (310 строк), 20 новых exports в `src/index.js`, subpath exports `./source-coverage`, `./encoding-detect`, dependency `iconv-lite ^0.6.3`.
- README/CHANGELOG: CHANGELOG есть, но без записи о новых изменениях. exports: расширились.
- **Требуемый bump:** additive → patch `0.1.1` допустим; minor `0.2.0` консервативнее. Публикуется **до** vbook-runtime (vbook-runtime локально зависит от него через `file:`).

### @animastor/vbook-runtime (опубликован 2026-09-07 16:31; соответствует `2d19d793` 2026-09-07 16:28)
- `1cb87124`, `f0b26560` 2026-09-08 — C13/C14: контракт, seam (additive на тот момент).
- `c8de3b34` 2026-09-08 06:55 — **breaking**: удалены `src/parser-core.js`, `src/language-detector.js`, `src/contracts/parser-contract.js`, `src/contracts/legacy-projection.js`, `src/lazy-book/parser.js` (вынесены в `@animastor/parser`); удалены subpath-exports `./language-detector`, `./lazy-book/parser`; dep `tinyld` → `@animastor/parser: file:../animastor-parser`.
- CHANGELOG: изменения описаны в секции **Unreleased** — при публикации оформить как запись версии.
- **Требуемый bump:** `0.2.0` (удаление публичных exports = breaking; в 0.x минор может быть breaking). Перед публикацией заменить `file:` на registry-диапазон (`^0.2.0` parser).
- **Внимание к диапазонам потребителей:** `@animastor/ai-analysis@0.1.0`, `@animastor/editor@0.1.0`, `@animastor/player@0.1.0` объявляют `@animastor/vbook-runtime: ^0.1.0`, который **не покроет** 0.2.0. После публикации 0.2.0 этим пакетам при следующем релизе нужно поднять диапазон (или публиковать vbook-runtime как 0.1.1, если удалённые subpath-exports считать не breakage — решить явно перед bump).

### animastor-ai-connector (опубликован 2026-09-06 04:28 из до-переезда в `packages/` расположения)
- `9fef24ba` 2026-09-07 06:21 — физический переезд в `packages/animastor-ai-connector/` + добавлены `test/` в репо. `repository.directory` в package.json поправлен (`ai-connector` → `packages/animastor-ai-connector`) — поэтому tarball-package.json отличается от локального. Runtime-код (`index.cjs`, `lib/`) идентичен опубликованному.

## 3. Проверка npm tarball (все 28 опубликованных пакетов)

- Скачан и продиффован каждый опубликованный tarball против локального каталога: **лишних файлов в tarball'ах не обнаружено**; состав соответствует `files` (gpu-hub намеренно публикует `Dockerfile`/`.dockerignore`, ai-connector — `SPEC.md`).
- Диверженции только там, где есть изменения после публикации (§2), плюс: `test/` есть в tarball только у `@animastor/orchestration` (заявлен в `files`); `CHANGELOG.md` авто-включён npm в tarball `@animastor/editor` (с неверным содержимым — см. §D).
- Smoke-тесты установки и `require()`: `@animastor/contracts@0.1.1` (21 export), `@animastor/parser@0.1.0` (22), `@animastor/vbook-runtime@0.1.0` (10) — успешно; локальный `@animastor/url-safety` — успешно (8 exports).
- Stale-артефакты `.tgz` лежат в `packages/animastor-editor/` и `packages/animastor-web-navigator/`, но игнорируются git (`*.tgz`) и в tarball не попадают. В git не tracked ни один `.tgz`.
- `animastor-worker/` — не npm-пакет (нет `package.json`), ops-скрипты; в аудит публикации не входит.

## A. NOT PUBLISHED

1. **@animastor/url-safety@0.1.0** — полностью готов: standard-совместимый package.json (`publishConfig.access: public`, MIT, engines >=18), README/LICENSE/CHANGELOG на месте, `npm pack --dry-run` чистый (5 файлов), `require()` работает. Зависимостей внутри monorepo не имеет, потребителей в `packages/*` пока нет.
   **Действие:** first publication → npm publish.

## B. CHANGED BUT NOT PUBLISHED

1. **@animastor/generation** — runtime + новый публичный ярус dirty-grammar (additive).
   **Действие:** bump (0.1.1 additive / 0.2.0 консервативно) → create CHANGELOG → npm publish.
2. **@animastor/gpu-hub** — runtime-фикс installer-version resolution + Dockerfile.
   **Действие:** bump patch 0.1.1 → create CHANGELOG → npm publish.
3. **@animastor/parser** — runtime + новый публичный API (source-coverage, encoding-detect) + новая dependency iconv-lite.
   **Действие:** bump (0.1.1 additive / 0.2.0 консервативно) → CHANGELOG entry → npm publish. До vbook-runtime.
4. **@animastor/vbook-runtime** — runtime + breaking API-изменения (модули parser вынесены) + deps.
   **Действие:** bump 0.2.0 → оформить CHANGELOG (сейчас Unreleased) → заменить `file:` dep на registry-диапазон → npm publish. После parser.

## C. VERSION / CHANGELOG ISSUES

1. **@animastor/vbook-runtime** — изменения сидят в секции «Unreleased»; нужна явная запись версии при bump (см. B.4 и предупреждение о диапазонах потребителей `^0.1.0`).
2. **@animastor/parser** — CHANGELOG есть, но без записи о новом API; добавить entry в рамках bump.
3. **@animastor/generation**, **@animastor/gpu-hub** — CHANGELOG отсутствует вовсе; создать при bump.
4. Автоматические bump'ы не выполнялись (по условию аудита).

## D. PACKAGING / METADATA ISSUES

1. **@animastor/editor — METADATA_PROBLEM (единственная существенная):** `packages/animastor-editor/CHANGELOG.md` — **байт-в-байт копия CHANGELOG `@animastor/player`** (попала при extraction-коммите `f41f0aad` и с тех пор не менялась). Неверный CHANGELOG уже опубликован в npm tarball (npm авто-включает CHANGELOG.md, хотя его нет в `files`).
   **Действие:** написать настоящий CHANGELOG → bump patch 0.1.1 → npm publish (перепубликация исправит и tarball).
2. **@animastor/vbook-runtime — `file:` dependency:** локально `@animastor/parser: file:../animastor-parser`. Для npm-потребителей такой диапазон неработоспособен; перед публикацией заменить на registry-диапазон.
3. **@animastor/orchestration — `files` включает `test/`** — единственный пакет, публикующий тесты (отклонение от стандарта «тесты не в tarball»). Опционально: убрать `test/` из `files` при следующем релизе.
4. **animastor-ai-connector / animastor-comfyui-workflow-connector — нет `exports`-карты, unscoped имена** — legacy standalone-стандарт, опубликованы до введения `@animastor/*`-стандарта. Переименование сейчас = breaking; опционально добавить `exports` в следующем миноре.
5. **Отсутствующий CHANGELOG у опубликованных пакетов:** `@animastor/contracts`, `@animastor/generation`, `@animastor/gpu-hub`, `animastor-ai-connector`, `animastor-comfyui-workflow-connector`, `@animastor/installer`, `@animastor/orchestration` (+ все 13 web-* по их собственному стандарту). Косметика; заводить при следующих релизах.
6. **Web-пакеты: нет `engines`; `@animastor/web-book-session` без `bugs`/`homepage`** — косметика, внутренне единообразно.
7. **Незакоммиченные `tests/`/`.gitignore`** в рабочих каталогах (assistant, auth, contracts, editor, gpu-hub, installer, parser, player, generation, vbook-runtime, web-*): в tarball не попадают (не входят в `files`), но коммитить по мере работы — иначе аудит git-истории искажается.
8. **Корневой `package.json` не tracked** (untracked в git) — вне области аудита, отмечено для сведения.

## E. FULLY SYNCHRONIZED

Код, версия и npm tarball идентичны, упаковка соответствует стандарту:

`@animastor/ai-agent`, `@animastor/ai-analysis`, `@animastor/assistant`, `@animastor/auth`, `@animastor/contracts`, `@animastor/installer`, `@animastor/player`, все 13 `@animastor/web-*`.

(20 пакетов; `animastor-ai-connector`, `animastor-comfyui-workflow-connector`, `@animastor/orchestration` синхронизированы по коду/версии, но имеют косметические отклонения — см. §D; `@animastor/editor` синхронизирован по коду, но имеет METADATA_PROBLEM.)

## F. RECOMMENDED PUBLICATION ORDER

С учётом внутренних зависимостей (`vbook-runtime` → `parser` локально; `orchestration` → `generation ^0.1.0`; `generation`/`gpu-hub`/`orchestration` → `contracts ^0.1.0`; `ai-analysis`/`editor`/`player` → `vbook-runtime ^0.1.0`):

1. **@animastor/url-safety** — first publication → `npm publish` (независим, готов).
2. **@animastor/parser** — bump → CHANGELOG entry → `npm publish` (до vbook-runtime, который от него зависит).
3. **@animastor/vbook-runtime** — bump 0.2.0 → CHANGELOG → заменить `file:` dep на `^0.2.0` parser → `npm publish`.
4. **@animastor/generation** — bump → create CHANGELOG → `npm publish`. (После bump до 0.2.0 диапазон `@animastor/orchestration` `^0.1.0` перестанет покрывать новую версию — при следующем релизе orchestration поднять диапазон; при patch-публикации 0.1.1 проблемы нет.)
5. **@animastor/gpu-hub** — bump patch 0.1.1 → create CHANGELOG → `npm publish` (независим; в любой момент).
6. **@animastor/editor** — fix CHANGELOG → bump patch 0.1.1 → `npm publish` (независим; в любой момент).
7. Остальные — no action required.

## Примечание о push

Удалённый `origin` — локальный по пути (`/home/animastor/repos/animastor.git`); push выполняется в него.

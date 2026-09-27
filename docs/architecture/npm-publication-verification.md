# npm Publication Verification — ручная публикация подтверждена

- **Дата проверки:** 2026-09-27 (15:30–15:45 UTC)
- **Ветка:** `c21.4-physically-extract-analysis-from-backend`
- **HEAD на момент проверки:** `cf2d5836fa6a545b10ab60aefebf0edce2c93656` (`docs(architecture): fix npm publication order wording`)
- **Подготовка публикации:** `6831a126` (`chore: prepare packages for npm publication`), план — `docs/architecture/npm-package-publication-audit.md` §G
- **Метод:** прямые запросы к npm registry (`curl registry.npmjs.org` + `npm view`); скачивание опубликованных tarball'ов всех шести пакетов; `diff -rq` tarball ↔ `packages/*`; `npm install` в чистых временных директориях (вне монорепо) + `require()` корня и subpath exports; проверка `dist-tags`, дат публикации и shasum-сверка (`npm pack --dry-run --json` ↔ `dist.shasum`); проверка installability предыдущих версий.
- **Ничего не публиковалось и не менялось** — только чтение registry и локальных файлов.

## Итоговая таблица

| Package | Опубликованная версия | npm latest | install | tarball | exports | Расхождения с repository | Статус |
|---|---|---|---|---|---|---|---|
| @animastor/parser | 0.1.1 (2026-09-27 15:29) | 0.1.1 ✓ | OK | ✓ 11 файлов, без лишних | ✓ корень (39) + 5 subpath | **0** (tarball ≡ repo, shasum ✓) | **PASS** |
| @animastor/vbook-runtime | 0.2.0 (2026-09-27 15:32) | 0.2.0 ✓ | OK | ✓ 22 файла, без лишних | ✓ корень (10) + все subpath | **0** (shasum ✓) | **PASS** |
| @animastor/url-safety | 0.1.0 (2026-09-27 15:27) | 0.1.0 ✓ | OK | ✓ 5 файлов | ✓ корень (8) | **0** (shasum ✓) | **PASS** |
| @animastor/generation | 0.1.1 (2026-09-27 15:35) | 0.1.1 ✓ | OK | ✓ 24 файла, без лишних | ✓ корень + `./dirty-grammar` (19) | **0** (shasum ✓) | **PASS** |
| @animastor/gpu-hub | 0.1.1 (2026-09-27 15:34) | 0.1.1 ✓ | OK | ✓ 9 файлов (Dockerfile, .dockerignore — намеренно) | ✓ factory (`gpu-hub.js`) | **0** (shasum ✓) | **PASS** |
| @animastor/editor | 0.1.1 (2026-09-27 15:39) | 0.1.1 ✓ | OK | ✓ 12 файлов, без лишних | ✓ корень (4 factory) | только stale-артефакт `animastor-editor-0.1.0.tgz` в репо (git-ignored, в tarball не попадает); shasum ✓ | **PASS** |

**Итог: 6/6 PASS — ручная публикация успешно подтверждена.** Проблем, требующих новой версии, не обнаружено.

## 1. npm registry

| Package | Существует | Версии на registry | latest | Ожидаемая версия опубликована | metadata (`npm view`) |
|---|---|---|---|---|---|
| @animastor/parser | ✓ | 0.1.0, **0.1.1** | 0.1.1 ✓ | ✓ | ✓ MIT, engines >=18, pubCfg public, main `src/index.js`, deps `tinyld ^1.3.4` + `iconv-lite ^0.6.3` |
| @animastor/vbook-runtime | ✓ | 0.1.0, **0.2.0** | 0.2.0 ✓ | ✓ | ✓ main `src/index.js`, deps `adm-zip ^0.5.10` + `@animastor/parser ^0.1.0` |
| @animastor/url-safety | ✓ | **0.1.0** | 0.1.0 ✓ | ✓ (первая публикация) | ✓ deps отсутствуют (как задумано) |
| @animastor/generation | ✓ | 0.1.0, **0.1.1** | 0.1.1 ✓ | ✓ | ✓ deps `@animastor/contracts ^0.1.0` + `animastor-comfyui-workflow-connector ^0.1.0` |
| @animastor/gpu-hub | ✓ | 0.1.0, **0.1.1** | 0.1.1 ✓ | ✓ | ✓ main `server.js`, deps cors/express/ioredis + contracts |
| @animastor/editor | ✓ | 0.1.0, **0.1.1** | 0.1.1 ✓ | ✓ | ✓ deps `@animastor/vbook-runtime ^0.1.0` |

Примечание: при первом опросе (~15:33 UTC) editor ещё отдавал `latest: 0.1.0` — публикация editor состоялась позже остальных (15:39) и в этот момент не была видна из-за CDN-кэширования registry; повторный опрос подтвердил публикацию и корректный `latest: 0.1.1`. Это наблюдение о задержке распространения, а не дефект публикации.

## 2. Содержимое опубликованных tarball'ов

| Package | src/ | README | LICENSE | CHANGELOG | package.json | Случайные файлы |
|---|---|---|---|---|---|---|
| parser 0.1.1 | ✓ (9 модулей, вкл. `source-coverage.js`, `encoding-detect.js`) | ✓ | ✓ | ✓ (запись 0.1.1) | ✓ | нет |
| vbook-runtime 0.2.0 | ✓ (15 модулей; parser-модулей нет — как задумано) | ✓ | ✓ | ✓ (запись 0.2.0) | ✓ (+`schemas/`) | нет |
| url-safety 0.1.0 | ✓ (`index.cjs`) | ✓ | ✓ | ✓ | ✓ | нет |
| generation 0.1.1 | ✓ (24 файла, вкл. `dirty-grammar/` ×6) | ✓ | ✓ | ✓ (новый) | ✓ | нет |
| gpu-hub 0.1.1 | н/п (root-модули) | ✓ | ✓ | ✓ (новый) | ✓ | нет (`Dockerfile`/`.dockerignore` — намеренный `files`) |
| editor 0.1.1 | ✓ (9 модулей) | ✓ | ✓ | **✓ настоящий CHANGELOG editor** (не копия player) | ✓ | нет |

## 3. Чистая установка и runtime-проверки

Для каждого пакета: `npm install @animastor/<pkg>@<version>` в пустой временной директории вне монорепо — все 6 установились без ошибок.

| Package | require корня | subpath exports | runtime dependencies | `file:` deps |
|---|---|---|---|---|
| parser 0.1.1 | ✓ 39 exports | ✓ `./source-coverage` (13), `./encoding-detect` (4), `./language-detector`, `./contracts/parser-contract`, `./contracts/legacy-projection` | `tinyld`, `iconv-lite` — резолвятся | 0 |
| vbook-runtime 0.2.0 | ✓ 10 exports | ✓ `./book-model.cjs`, `./bundle-validator.cjs`, `./books-root`, `./character-identity`, `./snake-guard`, `./scene-title-utils`, `./lazy-book` (+`paths`, `draft`, `parse`, `create`, `status`, …), `./schemas/*` | `adm-zip`, `@animastor/parser` — резолвятся | **0** |
| url-safety 0.1.0 | ✓ 8 exports (`assertPublicEndpoint`, `safeFetch`, …) | н/п (root-only) | нет | 0 |
| generation 0.1.1 | ✓ (artifactNaming, mediaRegistry, generationProgress, sceneState, comfyuiProvider, promptProfiles, dirtyGrammar, ports, …) | ✓ `./dirty-grammar` (19 exports) | `@animastor/contracts`, `animastor-comfyui-workflow-connector` — резолвятся | 0 |
| gpu-hub 0.1.1 | ✓ factory из `gpu-hub.js` | н/п (root-модули) | cors/express/ioredis/contracts — резолвятся | 0 |
| editor 0.1.1 | ✓ 4 factory (`createEditorModel`, `createEditorRoutes`, `createEntityCrudRoutes`, `createEditorPorts`) | н/п (root-only export map) | `@animastor/vbook-runtime ^0.1.0` — резолвится | 0 |

Сквозной runtime-тест: в чистой среде `vbook-runtime@0.2.0` → `lazy-book.splitIntoChapters()` успешно парсит текст через **registry**-копию `@animastor/parser` (после привязки structure-detector; без привязки — документированный fail-closed).

## 4. Сверка tarball ↔ `packages/*`

`diff -rq` (исключая `node_modules`, `package-lock.json`, `test/`, `.git`):

- **parser, vbook-runtime, url-safety, generation, gpu-hub: 0 расхождений** — содержимое опубликованного tarball совпадает с соответствующим содержимым package directory после исключения `node_modules`, `package-lock.json`, `test/` и `.git`; расхождений в публикуемых файлах не обнаружено.
- **editor:** единственное расхождение — в репозитории лежит локальный stale-артефакт `animastor-editor-0.1.0.tgz` (git-ignored `*.tgz`, в публикации не участвует). Содержимое tarball ≡ репозиторий.
- Шасум-сверка `npm pack --dry-run --json` (локально) ↔ `dist.shasum` (registry): **все 6 совпадают** — `8743ea4b…` (parser), `a40f30f4…` (vbook-runtime), `62614ee7…` (url-safety), `40b8a949…` (generation), `455da631…` (gpu-hub), `fb551048…` (editor).
- **Ожидаемые различия npm metadata:** отсутствуют как проблемы; npm добавляет в published manifest только стандартные вычисляемые поля (`dist`, `_id`, `_npmVersion` и т.п.).
- **Проблемы, требующие новой версии:** не обнаружены.

## 5. @animastor/vbook-runtime@0.2.0 — dependency на parser (специальная проверка)

- Published manifest: `"@animastor/parser": "^0.1.0"` — **registry-диапазон, не `file:`** ✓
- В чистой среде npm установил `@animastor/parser@0.1.1` — версия удовлетворяет диапазону `^0.1.0` ✓ (совместимость с 0.1.0 и 0.1.1 подтверждена практически)
- `adm-zip ^0.5.10` — единственная прочая runtime dependency ✓
- Runtime-require chain vbook-runtime → registry parser работает (§3) ✓

## 6. Целостность предыдущих версий и dist-tags

| Package | Предыдущая версия | Устанавливается | latest → |
|---|---|---|---|
| parser | 0.1.0 | ✓ install OK | 0.1.1 ✓ |
| vbook-runtime | 0.1.0 | ✓ install OK | 0.2.0 ✓ |
| url-safety | — (первая) | н/п | 0.1.0 ✓ |
| generation | 0.1.0 | ✓ install OK | 0.1.1 ✓ |
| gpu-hub | 0.1.0 | ✓ install OK | 0.1.1 ✓ |
| editor | 0.1.0 | ✓ install OK, require OK | 0.1.1 ✓ |

Ни одна предыдущая версия не была перезаписана (npm в принципе не допускает перезапись неизменённых версий); все `latest` dist-tags указывают на ожидаемые новые версии.

## Замечания (не блокирующие)

1. **editor:** stale-артефакт `animastor-editor-0.1.0.tgz` в рабочем каталоге пакета (git-ignored) — можно удалить локально для чистоты; на публикацию не влияет.
2. **editor:** при первом опросе registry (~15:33) версия 0.1.1 ещё не была видна (CDN-кэш; публикация в 15:39) — задержка распространения, финальное состояние корректно.
3. Потребители `@animastor/vbook-runtime ^0.1.0` (`@animastor/ai-analysis@0.1.0`, `@animastor/editor@0.1.0`, `@animastor/player@0.1.0`) продолжают резолвить 0.1.x — установки не сломаны; подъём диапазона при их следующих релизах зафиксирован в `npm-package-publication-audit.md` §G.3.

## Вывод

**Ручная публикация npm-пакетов Animastor успешно подтверждена: 6/6 PASS.**
Все шесть пакетов существуют на npm в ожидаемых версиях, `latest` указывает на них, содержимое tarball'ов совпадает с публикуемым содержимым репозитория (см. §4, shasum-сверка), устанавливаются из registry в чистых средах, их публичные API (корневые exports и subpaths) работают, `file:` dependencies отсутствуют, предыдущие версии не затронуты.

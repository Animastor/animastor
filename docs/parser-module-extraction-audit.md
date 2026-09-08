# Parser Module Extraction Audit — `backend/src/book/lazy-book/parser.js` + `services/structure-detector.js` + `services/txt-importer.js` → `@animastor/parser`

**Status:** READ-ONLY reconnaissance. No production code changed, no refactor performed, no package created. Only this document was added.
**Date:** 2026-09-08
**Baseline:** HEAD `9a794464` + staged VBook runtime move (unpublished, physical relocation landed behind completion checklist).
**Context:** Parser/Import — ranked #2 extraction candidate per `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` §4.7. VBook runtime already extracted (`@animastor/vbook-runtime@0.1.0`, commit `7175099d`); structural decision **"Parser ≠ VBook"** documented in `VBOOK_EXTRACTION_READINESS_AUDIT.md` §2.6 (structure-detector → port, not package). C13 Parser/import contract still **missing** (`MODULAR_PRODUCT_ARCHITECTURE.md` §24, `PLUGIN_EXTENSION_ARCHITECTURE.md`).
**Related:** `VBOOK_EXTRACTION_READINESS_AUDIT.md` (upstream, COMPLETE; §2.6 — detector placement decision C), `MODULAR_PRODUCT_ARCHITECTURE.md` §8/§24 (Parser definition + C13 missing), `MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE.md` §1 (Parser/Import inventory), `PLUGIN_EXTENSION_ARCHITECTURE.md` (parser as planned plugin, C13 prerequisite), `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` (queue order).

---

## Executive summary

Текущий "Парсер" в репозитории — **не один модуль, а три разных слоя, пересекающихся по ответственности**:

| Слой | Файлы | Семантика | Готовность к выделению |
|---|---|---|---|
| **Deterministic parse** | `lazy-book/parser.js` (VBook-runtime, 193 LOC) + `lazy-book/parse.js` (VBook-runtime, 249 LOC) | Разбиение текста на главы/сцены/юниты по детерминированным правилам; инъекция маркеров глав; детекция языка | **Внутри уже извлечённого VBook runtime**. Не является самостоятельным модулем. |
| **Structure detection (deterministic + LLM-merge)** | `services/structure-detector.js` (1231 LOC, pure, 0 requires) | Поиск кандидатов строк, детерминированная карта глав (`buildDeterministicMap`), слияние решений LLM (`mergeAiDecisions`, `analyzeStructure`), санитайзحة структуры | **Технически чистый, но архитектурно принадлежит слою "AI-анализ импорта"**, а не формату. Решение C (оставить в хосте, сделать порт) зафиксировано в VBook аудите §2.6. |
| **TXT import pipeline (orchestration)** | `services/txt-importer.js` (298 LOC) + `services/agent/bootstrap.js` + `services/agent/pipeline-steps.js` + `services/agent/pipeline-runner.js` | Кодирование буфера → создание черновика → AI-анализ структуры/персонажей/локаций → запись структуры книги → lazy-parse остальных окон; потоковый прогресс; Redis-триггеры | **Бизнес-оркестровка импорта.** Зависит от AI-провайдеров, PG (agent_sessions), Redis, lazy-book записи. Не чистый парсер. |

**Главный вывод:** в репозитории **нет единого модуля "Парсер"**, который можно было бы вытащить 1:1. Есть (а) детерминированный парсер текста, уже живущий в VBook runtime; (б) детектор структуры, который чистый, но по решению архитектуры **не должен** уходить в VBook; (в) AI-конвейер импорта, который по определению зависит от внешних провайдеров и БД.

Для извлечения "Parser" как самостоятельного модуля **нужно сначала определить, что в него входит**, и это решение ещё не принято — оно блокировано отсутствием C13 (parser/import contract).

---

## 1. Код, относящийся к parsing

### 1.1 Точки входа (HTTP + импортные)

**Backend-роуты, связанные с parsing/import:**

| Файл | Эндпоинты | Что делает |
|---|---|---|
| `routes/book/parse-routes.cjs` | `POST /book/:id/lazy-parse`, `POST /book/:id/lazy-parse-to`, `POST /book/import-text`, `GET /book/:id/source`, `POST /book/:id/snapshot` | Ленивый парсинг окон; импорт AI-текста (validate + createDraft); сырой source текст; снапшот |
| `routes/book/import-routes.cjs` | `POST /book/import` (unified: vbook or txt), `POST /book/load-vbook`, `POST /book/:id/resume-bootstrap`, `POST /book/import-txt`, `POST /book/:id/bootstrap`, `POST /book/:id/bootstrap-next-window`, `POST /book/:id/trigger-next-window` | Загрузка бандла/текста; deduplicated импорт с собственностью; бутстрап через AI-пайплайн; следующие окна; триггер следующего окна по frontend-логике |
| `routes/book/status-routes.cjs` | `GET /book/:id/generation-state`, `GET /book/:id/status`, `GET /book/:id/source-chapters`, `GET /book/:id/chapters-summary` | Статус импорта; список глав из source; summary распарсенных глав |

**Внутренние точки входа (не HTTP):**
- `services/txt-importer.js` — `decodeTxtBuffer`, `validateAiText`, `importTxtFile`, `importAiText`, `bootstrapImportedText`, `bootstrapNextWindow`, `lazyParseNext`, `lazyParseToPosition`, `getParsedChaptersSummary`
- `services/agent/bootstrap.js` — `bootstrapWithAgent`, `bootstrapNextWindow` (AI-пайплайн импорта, пишет книгу через `lazyBook.createFromAnalysis` / `appendToBook`)
- `packages/animastor-vbook-runtime/src/lazy-book/parse.js` — `lazyParseNextWindow`, `lazyParseChapter` (детерминированный ленивый парсинг глав, пишет файлы глав на диск)

### 1.2 Обработка входных данных

**Иерархия "что есть источник":**

```
.txt файловый буфер  ──▶ encoding-detect.decodeBuffer() ──▶ текст (UTF-8 и др.)
.ai-текст (body JSON) ──▶ validateAiText() ──▶ текст
.vbook бандл (ZIP)    ──▶ book.extractBookBundle() ──▶ файлы бандла
```

- `services/encoding-detect.js` — детекция кодировки `.txt` (iconv-lite, heuristic scoring, русские биграммы, BOM). **Зависит от iconv-lite (npm).** Не чистый "парсер", а декодер.
- `services/txt-importer.js:decodeTxtBuffer` — обёртка над encoding-detect + размер-личмит из `config.TXT_MAX_SIZE`.
- `lazy-book/parser.js:injectChapterMarkers` — инъекция `[ГЛАВА: TITLE]` в текст с верхним регистром без ключевых слов (русская/латинская классика изданий).
- `lazy-book/parser.js:splitIntoChapters` — обёртка над `structureDetector.buildDeterministicMap` → массив глав `{ title, type, label, number, startLine, endLine, startOffset, endOffset, length }`.

### 1.3 Преобразование parsed data в внутренние модели

**Детерминированный путь (VBook runtime):**
```
sourceText
  → splitIntoChapters(text)            → массив глав (структура)
    → splitIntoScenes(chapterText)     → массив сцен (по разделителям ¶¶ / --- / *** / ___)
      → splitIntoUnits(sceneText)      → массив юнитов [{ type, text, participants }]
```

**AI-пайплайн импорта (txt-importer → agent/bootstrap → pipeline-steps):**
```
sourceText
  → extractCandidates(sourceText)            → кандидаты строк (structure-detector)
    → stepAnalyzeStructure(...)               → LLM-структура (title/author/chapters/segments)
      → createFromAnalysis(...)              → книга (персонажи, локации, сцены, метаданные)
        → lazy-parse далее                   → parse.js:lazyParseNextWindow / lazyParseChapter
```

**Важное наблюдение:** `lazyBook.createFromAnalysis` и `lazyBook.appendToBook` — это **запись результата парсинга в модель книги**. Это не "чистый парсер", это импортный оркестратор, пишущий в книжную модель. Отдельного "parser"이 в репозитории нет — есть "import pipeline".

### 1.4 Ошибки / валидация

| Что | Где | Семantics |
|---|---|---|
| Размер файла > `config.TXT_MAX_SIZE` | `txt-importer.validateAiText` | Reject с сообщением |
| Не текст / бинарный | `encoding-detect.decodeBuffer` | Error "File appears to be binary" |
| Не удалось декодировать ни одной кодировкой | `encoding-detect` | Error "Could not decode file..." |
| Пустой текст | `txt-importer.validateAiText` | Reject "No text provided" |
| Пустой результат LLM (0 сцен) | `agent/bootstrap.js` | Throw "AI returned no scenes — cannot create book" |
| Прогресс не продвинулся | `agent/bootstrap.js` | Throw "Scene progress did not advance..." |
| Сдвиг назад (дубликаты сцен) | `bootstrapNextWindow` | Throw "Scene progress went backwards..." |
| Dedup-коллизия (книга захвачена другим workspace) | `import-routes.cjs:resolveOwnedTxtDedup` | Fresh import вместо dedup |
| Валидация структуры LLM | `structure-detector.js:sanitizeStructure` | Drop неанкорированных/галлюцинанных элементов |
| Пост-валидация участков | `source-coverage-audit` (вне parser-слоя) | Report покрытия исходного текста |

### 1.5 Зависимости парсера от других частей монолита

**Прямые requires детерминированного парсера (VBook runtime, сейчас в пакете):**

| Зависимость | Статус | Примечание |
|---|---|---|
| `fs`, `path` | node builtins | I/O файлов глав |
| `./constants` (BookState, SceneStatus, UnitType, DEFAULT_WINDOW_SIZE) | внутри VBook | enum'ы формата |
| `./paths` (getBookDir, getChapterDir, getBookMetaPath, id generators) | внутри VBook | пути + id-грамматика |
| `./language-detector` (detectLanguage) | внутри VBook (реэкспорт) | язык книги |
| `./draft` (loadDraftBook, updateBookState) | внутри VBook | состояние черновика |
| `./chapter-utils` (buildSegmentIntro, buildTypographyPagePrompt) | внутри VBook | типыографические вступительные сцены |

**Структурный детектор (пока в хосте, pure):**

| Зависимость | Статус | Примечание |
|---|---|---|
| НИЧЕГО | pure, 0 requires | Только JS; candidate scoring, keyword matching, LLM merge, санитайз |
| LLM-вызовы | НЕТ — детектор только анализирует + санитайзит результаты | Сам LLM-вызов находится в `pipeline-steps.js:stepAnalyzeStructure` |

**TXT импортный пайплайн (хост):**
| Зависимость | Статус |
|---|---|
| `services/agent-service` + `services/agent/*` | AI-пайплайн импорта |
| `services/workspace-ai-provider` | резолюция провайдера по книге |
| `services/agent-session` | PG `agent_sessions` (createSession, updateSession) |
| `lazy-book` (createFromAnalysis, appendToBook, loadDraftBook) | запись результата в книгу |
| `config/runtime-config` | TXT_MAX_SIZE |
| `services/source-coverage` | coverage проверка |
| `storage/postgres` | agent_sessions, generation-cancel-repo |
| `services/layer-config` | chunk_size из Redis |
| `services/placeholder-audio` | estimateSpeechDurationSec |

---

## 2. Карта зависимостей

### 2.1 Parser → какие модули (изнутри наружу)

```
VBook-runtime детерминированный парсер (parser.js + parse.js)
  ├─ fs/path/crypto (builtins)
  ├─ ./constants, ./paths, ./draft, ./chapter-utils, ./language-detector (внутри VBook)
  ├─ structure-detector (порт, инжектируется через setStructureDetector)  ← НЕ прямой require, порт
  └─ НЕ зависит от: agent, AI-провайдеров, PG, Redis, хост-конфига

Structure-detector (services/structure-detector.js)
  ├─ НИЧЕГО (pure, 0 requires)
  └─ Используется КАК: детерминированная основа + санитайзер LLM-результатов

TXT import pipeline (txt-importer.js + agent/bootstrap.js + pipeline-steps.js)
  ├─ lazy-book (VBook runtime)              → запись структуры книги
  ├─ services/agent-service + agent/*       → AI-пайплайн
  ├─ services/workspace-ai-provider         → провайдер по книге
  ├─ services/agent-session                 → PG agent_sessions
  ├─ storage/postgres                       → канцелляция, dedup-читалки
  ├─ services/layer-config (Redis)          → chunk_size
  ├─ services/source-coverage               → coverage audit
  ├─ config/runtime-config                  → TXT_MAX_SIZE
  └─ encoding-detect (iconv-lite)           → декодирование .txt
```

### 2.2 Какие модули → Parser (внешние потребители)

| Потребитель | Использует | Через что |
|---|---|---|
| `routes/book/parse-routes.cjs` | `txtImporter.lazyParseNext/lazyParseToPosition`, `lazyBook.createDraftBook`, `lazyBook.loadDraftBook`, `taskHandler.saveBookSnapshot` | ctx-инъекция |
| `routes/book/import-routes.cjs` | `lazyBook.createDraftBook`, `lazyBook.loadDraftBook`, `lazyBook.getBookDir/getManifestPath`, `book.extractBookBundle/buildBookFromBundle`, `bookSourceRepo`, `workspaceOwnership` | deps-инъекция |
| `routes/book/status-routes.cjs` | `lazyBook.getBookStatus`, `lazyBook.loadDraftBook`, `lazyBook.splitIntoChapters`, `txtImporter.getParsedChaptersSummary` | ctx-инъекция |
| `services/txt-importer.js` | `lazyBook.*`, `encoding-detect`, `config`, `agent-service`, `agent/bootstrap` | прямые requires |
| `services/agent/bootstrap.js` | `lazyBook.*`, `structure-detector`, `pipeline-steps`, `pipeline-runner`, `agent-session`, `storage/postgres`, `services/layer-config`, `workspace-ai-provider`, `source-coverage` | прямые requires |
| `services/window-generator.cjs` | `txtImporter.bootstrapNextWindow` | deps-инъекция |
| `services/placeholder-audio.js` | `lazyBook.*` (id generators, getChapterDir) | прямые requires |
| `services/source-coverage-audit.js` | `lazyBook.*` | прямые requires |
| `routes/book/generation-routes.cjs` | `txtImporter.bootstrapNextWindow` (косвенно через window-generator?) | deps-инъекция |
| Frontend | не использует parser напрямую — только HTTP-эндпоинты /book/:id/*. | через API |

### 2.3 Shared utilities / types / models

**Уже в VBook runtime (выделен):**
- `lazy-book/parser.js` — детерминированный парсинг (splitIntoChapters, splitIntoScenes, splitIntoUnits, firstMeaningfulChapter, detectLanguage, injectChapterMarkers, set/getStructureDetector)
- `lazy-book/parse.js` — ленивый парсинг окон (lazyParseNextWindow, lazyParseChapter)
- `lazy-book/paths.js` — id generators (chapterId, sceneId, unitId, generateBookId) + path getters
- `lazy-book/constants.js` — BookState, SceneStatus, SourceType, UnitType, DEFAULT_WINDOW_SIZE
- `lazy-book/draft.js` — черновик: createDraftBook, loadDraftBook, updateBookState, SourceType
- `language-detector.js` — detectLanguage (tinyld)
- `character-identity.js` — hasRealAppearance (используется pipeline-steps для voice_generation)
- `snake-guard.js` — normalizeVisualText, findCrossPromptGaps, sanitizeEnvironment (используется pipeline-steps)

**В хосте (не вынесено):**
- `services/structure-detector.js` — детектор структуры (порт, семантически "парсер части", но по решению C — не в VBook)
- `services/encoding-detect.js` — декодер текста (iconv-lite; зависит от npm, зависит от "текст как байты", не от книги)
- `services/txt-importer.js` — оркестратор импорта (не чистый парсер)
- `services/agent/pipeline-steps.js:stepAnalyzeStructure` — LLM-анализ структуры, использует structure-detector

### 2.4 Циклические зависимости

**Нет циклов, вовлекающих parser-слой:**

- VBook runtime (включая parser.js/parse.js) — **в нет SCC** (проверено в VBook аудите §7).
- Structure-detector — pure, **в нет SCC**.
- TXT import pipeline зависит от VBook runtime (lazy-book), agent pipeline, хост-сервисов — **однонаправленно**, не циклически.
- Единственный "интересный" граф: `pipeline-steps.js → structure-detector`, `lazy-book/parser.js → structure-detector (порт)`. Оба направления не цикличны, потому что structure-detector **не зависит ни от чего** из этого списка.

**Потенциальное будущее направление**, о котором нужно помнить: если C13 Parser contract появится и structure-detector станет реализацией `@animastor/parser`, то VBook runtime будет **зависеть от Parser через порт**, а не наоборот. Это уже задумано в VBook аудите §2.6 и не является циклом при правильной реализации (порт = зависимость от абстракции).

### 2.5 Скрытые зависимости

| Скрытая зависимость | Где | Степень | Комментарий |
|---|---|---|---|
| PG `agent_sessions` | `agent/bootstrap.js` (createSession, updateSession, window_data) | **Высокая** | Импортный пайплайн не может работать без PG-таблицы сессий. Это НЕ парсер, это импортная оркестровка. |
| AI-провайдер (workspace-ai-provider) | `agent/bootstrap.js:resolveAIForBook` | **Высокая** | Импорт требует доступного AI. Не парсер. |
| Redis layer-config (chunk_size) | `agent/bootstrap.js:_readChunkSize` | **Средняя** | Бизнес-настройка импорта, не парсинг. |
| BooksDir (filesystem root) | `lazy-book/paths.js` (booksRoot port) | **Средняя** | Уже решено в VBook (booksRoot port). Parser → VBook runtime → booksRoot port. |
| config.TXT_MAX_SIZE | `txt-importer.js:validateAiText` | **Низкая** | Конфиг-значение; может быть параметром импорта или контрактом C13. |
| encoding-detect → iconv-lite | `txt-importer.js:decodeTxtBuffer` | **Низкая-Средняя** | npm-зависимость; если "Parser" будет включать декодирование — это чистая зависимость от iconv-lite, без хост-каплей. |
| S3-style /output dir знание | нет (Parser не знает output dir) | — | Parser не затрагивает. |

**Отсутствие скрытых зависимостей — хороший знак.** Детерминированный парсер (VBook runtime parser.js/parse.js) не зависит ни от AI, ни от PG, ни от Redis, ни от хост-конфига (после booksRoot port). Это многообещающий базис для извлечения модуля, **НО только если граница будет проходить по детерминированному слою**, а не по импортному пайплайну.

---

## 3. Граница будущего модуля

### 3.1 Что должно войти в `@animastor/parser` (версия 1, детерминированный слой)

Если цель — **чистый детерминированный парсер текста в структуру**, граница:

```
@animastor/parser
├── src/
│   ├── index.js                   entry point: parseText(sourceText) → ParserResult
│   ├── parser.js                  ← lazy-book/parser.js (splitIntoChapters, splitIntoScenes,
│   │                               splitIntoUnits, injectChapterMarkers, detectLanguage,
│   │                               set/getStructureDetector port)
│   ├── parse.js                   ← lazy-book/parse.js (lazyParseNextWindow, lazyParseChapter)
│   ├── structure-detector.js      ← services/structure-detector.js (детерминированная основа)
│   ├── encoding-detect.js         ← services/encoding-detect.js (декодер .txt)
│   ├── constants.js               parser-specific enums+constants (новый файл или вынос из VBook)
│   └── types.js                   TypeScript-типы результатов (если TS-экосистема)
```

**Вопрос:** что с `parse.js` (lazyParseNextWindow/lazyParseChapter)? Оно пишет файлы глав на диск (`fs.writeFileSync(...)`). Это I/O, который:
- зависит от booksRoot (уже port в VBook);
- знает layout глав (`chapters/*.json`, `book.json`, `manifest.json`).

**Если Parser владеет I/O книги — он забирает часть ответственности VBook.** Если Parser не владеет I/O — он должен возвращать структуру, а письмо в книгу делать вызывающий код (VBook runtime или импортный пайплайн). Это фундаментальный выбор архитектуры.

### 3.2 Что должно остаться в хосте / VBook / agent domain

| Что | Куда | Почему |
|---|---|---|
| `services/txt-importer.js` (инженерии импорта) | хост (или importer-пакет, отличный от parser) | Это оркестровка: декодирование → создание черновика → AI-пайплайн → запись. Не чистый парсер. |
| `services/agent/bootstrap.js` + `services/agent/pipeline-steps.js` + `services/agent/pipeline-runner.js` | agent domain (host) | AI-анализ; зависит от провайдеров, PG, Redis. Не парсер. |
| `routes/book/parse-routes.cjs`, `routes/book/import-routes.cjs`, `routes/book/status-routes.cjs` | хост (backend routes) | HTTP-слой; зависит от контекста приложения, auth, workspace-ownership. |
| `config.TXT_MAX_SIZE` | либо контракт C13, либо хост-конфиг | Лимит размера; не семантика парсинга. |
| `encoding-detect.js` (iconv-lite) | Падает туда, куда решили поместить декодирование | Если "Parser" импортирует .txt → encoding-detect должен быть в parser. Если parser только работает с уже-текстом → encoding-detect остаётся в importer. |
| `character-identity.js`, `snake-guard.js`, `scene-title-utils.js` | уже в VBook runtime (с определённым кейсом) | Утилиты книги/персонажей, не парсинга text → structure. |
| `lazy-book/appearance.js` | в VBook runtime (или generator domain) | Визуальные свойства персонажей; не парсинг. |
| Book Model (book-model.cjs, bundle-validator.cjs) | в VBook runtime | К canonical book model. |

### 3.3 Интерфейсы / API между Parser и остальным

**Минимальный публичный API Parser (детерминированный слой):**

```typescript
// ParserResult — детерминированный результат парсинга текста
interface ParserResult {
  title: string | null;        // заголовок (детектирован или null)
  author: string | null;       // автор (детектирован или null)
  language: string;            // ISO 639-1 (detectLanguage)
  hasPrologue: boolean;
  hasEpilogue: boolean;
  parts: { name: string; order: number }[];
  chapters: ParserChapter[];
  segments: ParserSegment[];   // детектированная детерминированная карта
}

interface ParserChapter {
  title: string | null;
  type: 'chapter' | 'prologue' | 'epilogue' | 'introduction' | 'afterword' | 'appendix' | 'part';
  label: string | null;        // ключевое слово (Глава/Пролог/...)
  number: number | null;       // номер главы (1-based)
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  length: number;
}

interface ParserSegment {
  type: string;                // chapter / prologue / epilogue / introduction / afterword / appendix / body / poem
  label: string | null;
  title: string | null;
  number: number | null;
  headerLine: string | null;
  startOffset: number;
  endOffset: number;
  source: 'detect' | 'ai';
}
```

**Функции:**

```typescript
// Чистый парсер текста → структура (без I/O книги)
function parseText(sourceText: string): ParserResult;

// Инъекция маркеров глав в текст (для legacy-совместимости)
function injectChapterMarkers(text: string): string;

// Разбиение главы на сцены
function splitIntoScenes(chapterText: string): string[];

// Разбиение сцены на юниты
function splitIntoUnits(sceneText: string): ParserUnit[];

interface ParserUnit {
  type: 'narration' | 'dialogue' | 'typography' | 'perception';
  text: string;
  participants: string[];
}

// Порт детектора структуры (инжектируется, если нужно заменить детерминированную основу)
interface StructureDetector {
  buildDeterministicMap(sourceText: string): StructureMap;
  extractCandidates(sourceText: string): CandidateResult;
  analyzeStructure(sourceText: string, aiResult: object): StructureMap;  // LLM-merge
  sanitizeStructure(aiResult: object, candidates: Candidate[], sourceText: string): object | null;
}

// Типы для порта
interface StructureMap {
  title: { text: string; source: string; candidateId: string } | null;
  author: { text: string; source: string; candidateId: string } | null;
  hasPrologue: boolean;
  hasEpilogue: boolean;
  parts: { name: string; order: number }[];
  segments: StructureSegment[];
}

interface StructureSegment {
  type: string;
  label: string | null;
  title: string | null;
  number: number | null;
  headerLine: string | null;
  startOffset: number;
  endOffset: number;
  source: string;
}
```

**Важный вопрос интерфейса I/O книги:**

Если Parser уходит как самостоятельный модуль, **кто пишет файлы глав на диск?**
- Вариант A: Parser **не пишет** — возвращает структуру, VBook runtime / importer пишет. Parser = pure parsing. **Рекомендуемый.**
- Вариант B: Parser **пишет** — забирает `lazyParseNextWindow`/`lazyParseChapter` с их I/O. Тогда Parser зависит от booksRoot (порт) и знает layout книги. Это сдвигает границу VBook→Parser.

**Рекомендация:** Parser на уровне 1 — pure parsing (текст → структура). I/O и lifecycle книги — в VBook runtime. Это сохраняет "Parser ≠ VBook" чистым и не требует, чтобы Parser знал layout бандла.

### 3.4 Модели данных, которые придётся вынести или сделать shared

| Модель | Где сейчас | Куда для Parser | Примечание |
|---|---|---|---|
| Chapter/Segment types (ParserChapter, ParserSegment, StructureMap) | в parser.js (как shape) + structure-detector.js (как shape) | **Parser module** (новый types.js) | Это именно модели парсера, не книги. |
| Enum'ы BookState, SceneStatus, SourceType, UnitType | VBook runtime constants.js | **НЕ в Parser** — это книжные состояния | Нью-вынос не нужен. |
| ID generators (chapterId, sceneId, unitId, generateBookId) | VBook paths.js | **НЕ в Parser** — это id грамматика формата | Остаются в VBook. |
| BooksRoot / layout книги | VBook (booksRoot port) | **НЕ в Parser** (если Parser pure) | Если Parser будет писать — тогда booksRoot port станет зависимостью Parser, но это отдельное решение. |
| Language detection (detectLanguage) | VBook language-detector (tinyld) | Отдельный вопрос: если Parser владеет detectLanguage — тогда tinyld в Parser. Если нет — VBook. | Дублирование tinyld не проблема (pure lib). |
| encoding-detect (iconv-lite) | хост services/encoding-detect.js | **Если Parser импортирует .txt → в Parser**. Иначе — importer. | Зависит от границы Parser. |

**Главное:** Parser не должен знать Book Model (book.json, manifest.json, characters.json, locations.json, bible.json и т.д.). Parser знает только **текст → структуру текста**. Всё, что связано с "как книга хранится", — за пределами Parser.

---

## 4. Варианты архитектуры

### 4.1 Вариант A: Полностью самостоятельный Parser (детерминированный + structure-detector)

```
@animastor/parser         (L3 — publishable npm package)
├── parser.js             (splitIntoChapters, splitIntoScenes, splitIntoUnits,
│                         injectChapterMarkers, detectLanguage, set/getStructureDetector)
├── parse.js              (опционально — если Parser владеет I/O; иначе удалить из Parser)
├── structure-detector.js (buildDeterministicMap, extractCandidates, analyzeStructure, sanitizeStructure, mapToStructureChapters)
├── encoding-detect.js    (опционально — если Parser владеет декодированием .txt)
├── index.js              (parseText → ParserResult, plus pure helpers)
└── test/
    ├── parser.test.js           (детерминированный парсинг, golden-фиxtures)
    ├── structure-detector.test.js  (перенести с хоста; golden ChapterMap fixtures)
    └── encoding-detect.test.js    (если входит в Parser)
```

**Плюсы:**
- Чистый, самодостаточный модуль, не зависит от VBook runtime (зависит от абстракции structureDetector порта, если использовать).
- Может стать reference implementation для C13 (Parser/import contract).
- Тесты можно запускать standalone без хоста, без PG, без Redis, без AI.

**Минусы:**
- `parse.js` (lazyParseNextWindow/lazyParseChapter) — содержат I/O файлов книги. Если его вынести в Parser — Parser зависит от booksRoot + layout книги, теряя "чистый парсер". Если не выносить — Parser не содержит lazy-parse, это делает VBook runtime.
- structure-detector уже имеет решенное архитектурное placement — "не в VBook, оставить в хосте как порт" (VBook аудит §2.6, решение C). Вынос structure-detector в Parser **отменяет это решение** и требует переосмысления: либо Parser становится тем, куда детектор идёт (новое решение), либо Parser использует детектор через порт (тогда Parser не содержит детектор).
- encoding-detect зависит от iconv-lite — если его вынести в Parser, Parser получает npm-зависимость. Это нормально, но расширяет поверхность.

**Вердикт:** Вариант A целесообразен, **только если Parser = pure детерминированный парсер текста + structure-detector (без I/O книги, без AI-пайплайна, без импортной оркестровки)**. Тогда Parser — это "детерминированная основа импорта", а не "всё, что касается импорта".

### 4.2 Вариант B: Parser core + adapters (порт-ориентированный)

```
@animastor/parser              (L3)
├── core/
│   ├── parser.js              pure text → structure
│   ├── structure-detector.js  детерминированная основа + LLM-санитайз
│   └── types.js               TypeScript-типы
├── adapters/
│   ├── vbook-adapter.js       адаптер для VBook runtime (parserResult → lazyBook-вызовы?)
│   └── import-adapter.js      адаптер для txt-importer (если нужно)
└── index.js                   exports: parseText, injectChapterMarkers, splitIntoScenes,
                              splitIntoUnits, StructureDetector interface
```

Где `structureDetector` порт находится:
- Опция B1: Parser **содержит** реализацию детектора (structure-detector.js внутри Parser). VBook runtime зависит от Parser через порт (setStructureDetector). Это **прямой counteretto решению C** из VBook аудита — требует переделки.
- Опция B2: Parser **экспортирует интерфейс** детектора, но реализация детектора остаётся в хосте (как сейчас), и VBook runtime продолжает использовать хостовый детектор через порт. Parser — это just the pure parsing helpers + types; structure-detector — отдельный модуль, который может или не может стать частью Parser позже, когда C13 появится.

**Рекомендуемый вариант:** B2 сейчас, B1 как часть C13 (когда parser/import contract будет написан и Parser станет официальным модулем с собственным контрактом). Почему:
- Решение C (structure-detector → порт, не в VBook) уже принято и зафиксировано.
- Parser на уровне 1 должен быть минимальным: pure text → structure, без утверждений о том, где живет детектор.
- Когда появится C13, Parser станет тем, куда детектор logично идёт — но это отдельный шаг, а не текущий аудит.

### 4.3 Вариант C: Parser как контракт (C13-first)

Это **не извлечение кода**, а проектирование контракта:

```
C13 Parser/import contract
├── parse(sourceText: string) → ParserResult        (детерминированный)
├── detectStructure(sourceText: string, llmResult?: object) → StructureMap  (детектор + LLM-merge)
├── decodeText(buffer: Buffer) → DecodedText        (encoding-detect abstraction)
├── TYPE DEFINITIONS                                 (ParserResult, ParserChapter, ParserSegment, StructureMap, DecodedText)
└── contract test (pars

er contract sync test)
```

Парсер-реализация (reference implementation) становится частью `@animastor/parser`, когда контракт создан. Пока контракта нет (C13 = missing, `MODULAR_PRODUCT_ARCHITECTURE.md` §24), извлечение Parser в publishable пакет **предвосхищает контракт** и рискует сделать API, который не будет соответствовать контракту, когда он появится.

### 4.4 Сравнение

| Критерий | A (самостоятельный) | B (core + adapters) | C (контракт-first) |
|---|---|---|---|
| Зависимость от VBook runtime | Нет (если Parser pure) | Нет (core), адаптеры могут зависеть | Нет (контракт) |
| Зависимость от детектора | Входит в Parser (B1) или нет (B2) | Зависит от варианта | Зависит от контракта |
| I/O книги | Нет (если pure) | Адаптер решает | Контракт не знает |
| Соответствие решению C | Требует переосмысления | Соответствует (B2) | Не противоречит |
| Готовность сейчас | Частично (parser.js + parse.js уже в VBook, structure-detector в хосте) | Частично | Нет (контракт не написан) |
| Риск превосхищения контракта | Высокий (API может не совпасть с будущим C13) | Средний (core можно согласовать с будущим контрактом) | Низкий (контракт определяет API) |

**Рекомендуемый подход:** вариант B2 + проектирование C13 параллельно. Parser на уровне 1 = pure text→structure helpers + types; детектор остаётся в хосте как порт (по решению C); когда появится C13 — Parser становится publishable модулем с reference implementation детектора внутри.

### 4.5 "Другие варианты"

- **Parser как часть VBook runtime** — отвергнуто решением C (§2.6 VBook аудита): "Parser ≠ VBook".
- **Parser как часть agent domain** — отвергнуто: детерминированный парсинг не зависит от AI, не должен быть частью agent domain.
- **Parser как часть importer** — частично верно для txt-importer (оркестровка), но не для детерминированного парсинга. Импортер может **зависеть** от Parser, но не быть им.

---

## 5. Оценка сложности выделения

### 5.1 Сложность: **Medium**

| Измерение | Оценка | Пояснение |
|---|---|---|
| Техническая чистота детерминированного слоя | **Low** | parser.js + parse.js (VBook runtime) + structure-detector (хост) — чистый JS, 0 хост-зависимостей (кроме порта) |
| Определение границы (что в Parser, что нет) | **Medium** | Нет единого "Parser" в репозитории; нужно решить: включать parse.js (I/O)? включать encoding-detect? включать детектор? |
| Соответствие существующему решению C (детектор → порт) | **Medium** | Parser не может забрать детектор без переосмысления решения C; нужно либо согласовать, либо сделать Parser пользователем порта |
| I/O книги (parse.js lazy-parse) | **Medium** | parse.js пишет файлы глав; если Parser владеет этим — Parser зависит от booksRoot + layout. Если нет — Parser не содержит lazy-parse, это делает VBook runtime. |
| Контракт C13 (parser/import) | **High (блокирует publish)** | Без C13 Parser не может стать publishable L3-модулем по правилам §21/§26 (контракт → пакет). |
| Тесты | **Medium** | Хост-тесты структуры есть (structure-detector.test.js, 72 it-блока); специфичных тестов "Parser" как модуля нет; нужно написать тесты ParserResult/parseText. |
| Зависимости npm | **Low-Medium** | encoding-detect зависит от iconv-lite; если вынести в Parser — зависимость нормальная, но добавляется. |
| Циклы | **Low** | Нет циклов, вовлекающих parser-слой. |
| Breaking changes для хоста | **Medium** | Если Parser заменит прямые requires lazy-book/parser.js в хосте — нужно обновить require'ы. Если оставить shim — behaviour-neutral. |

**Итоговая сложность: Medium.** Не High, потому что детерминированный слой уже чистый и не зависит от хоста. Не Low, потому что граница не определена однозначно, и есть unresolved архитектурное решение (детектор + C13).

### 5.2 Основные технические риски

| Риск | Степень | Комментарий |
|---|---|---|
| Parser забирает parse.js с I/O → зависит от booksRoot + layout книги | **Средний** | Сдвигает ответственность VBook→Parser; противоречит "Parser ≠ VBook" если не осторожно |
| Parser содержит structure-detector, отменяя решение C | **Средний** | Требует ADR; решение C было принято осознанно (Parser ≠ VBook) |
| API Parser не совпадает с будущим C13 | **Высокий (блокирует publish)** | Без контракта Parser's публичный API — превосхищение. Нужен C13-first или C13-parallely. |
| encoding-detect → iconv-lite в Parser | **Низкий-Средний** | Обычная npm-зависимость; не риск, но расширяет поверхность |
| Дублирование типов ParserResult в Parser и в будущих importer-адаптерах | **Низкий** | Решается одним sources-of-truth (Parser types + TS generation) |
| Parser слишком мал → нет смысла в отдельном пакете | **Средний (архитектурный)** | Если Parser = только parseText + splitIntoScenes + splitIntoUnits — это tiny utils, а не модуль. Нужно решить, что делает Parser "модулем" (например, детектор структуры внутри). |

### 5.3 Потенциальные breaking changes

| Где | Что | Бreaking? |
|---|---|---|
| `lazy-book/parser.js` → Parser module | require пути изменятся для хост-потребителей, использующих `require('@animastor/vbook-runtime/lazy-book/parser')` напрямую | **Да**, но VBook runtime уже export'ит parser через exports map; потребители идут через VBook, не напрямую (VB-T4 guard). |
| `services/structure-detector.js` → Parser module | потребители на хосте (pipeline-steps, bootstrap) будут требовать Parser вместо structure-detector | **Да**, если Parser забирает детектор. Если Parser использует детектор через порт — breaking для детектора, но не для потребителей. |
| Parser модуль добавляет новые типы (ParserResult, ParserChapter, ParserSegment) | старый код, использующий "гетеро지니어스ные структуры глав", должен адаптироваться | **ЗАВИСИТ от границ.** Если Parser только чистый парс — потребители могут смотреть на ParserResult; если Parser заменяет структурный детектор — потребители могут использовать ParserResult вместо детектор-вывода. |

### 5.4 Что может неожиданно оказаться связанным с Parser

- **`lazyBook.createFromAnalysis` / `lazyBook.appendToBook`** — это запись результата парсинга в книгу. Если Parser будет "всё, что делает книгу из текста", то он забирает и эти функции, и тогда Parser зависит от lazy-book lifecycle (VBook). Это не чистый парсер.
- **`agent/bootstrap.js`** — это импортный пайплайн с AI. Если Parser будет включать "bootstrap" — он зависит от AI-провайдеров, PG, Redis. Это не парсер.
- **`encoding-detect.js`** — декодирование текста. Если Parser будет "парсер .txt файлов" — он включает encoding-detect. Если Parser — "парсер текста" — encoding-detect остаётся в importer.
- **`config.TXT_MAX_SIZE`** — если Parser будет валидировать размер — он зависит от конфига. Если импортер валидирует — Parser чистый.
- **`source-coverage-audit.js`** — это пост-парсинговый аудит покрытия. Не парсер, но связан с результатами парсинга. Остается в хосте.

**Вывод:** Parser может быть чистым, **только если его граница строго проходит по "текст → структура"**, без I/O книги, без AI, без импортной оркестровки, без конфига. Всё остальное — либо в VBook runtime, либо в importer, либо в agent domain.

---

## 6. Тесты

### 6.1 Существующие тесты, покрывающие Parser-слой

| Тест | Где | Покрывает | Может ли уйти в Parser? |
|---|---|---|---|
| `structure-detector.test.js` | `backend/tests/structure-detector.test.js` | 72 it-блока: детерминированная карта, кандидаты, санитайз, LLM-merge, keyword matching, poster detection, author surname check | **Да, если детектор войдёт в Parser** (B1). Если детектор остаётся в хосте как порт — тест остаётся в хосте как contract-test порта. |
| Хост-тесты, использующие `lazyBook.splitIntoChapters` / `lazyBook.lazyParseNextWindow` / `lazyBook.lazyParseChapter` | разные файлы (entity-crud, status-routes, parse-routes и т.д.) | Функциональное использование детерминированного парсинга в контексте книги | **Нет**, это хост-интеграционные тесты; они могут зависеть от ParserResult через порт, но не должны уходить в Parser. |
| `bundle-validator` тесты (ai-patch-validation.test.js, ai-participants-doctrine.test.js) | хост | Валидация book.json/participants — не парсер | Нет, это валидация книги, не парсера. |
| Архитектурные guard-тесты (VB-T1..T5, phase2/4/6/7) | `backend/tests/architecture/` | Трансграничные invariant | Нет, это guard'ы. |

### 6.2 Чего не хватает перед extraction

1. **Тесты ParserResult / parseText (чистый парсер):**
   - Тесты `parseText(sourceText) → ParserResult` на golden-фичурах (разные языки, стили глав, отсутствие структуры, prologue/epilogue).
   - Тесты `splitIntoScenes(chapterText) → string[]` на разных разделителях (¶¶, ---, ***, ___) и edge-cases (короткие главы, пустые сцены).
   - Тесты `splitIntoUnits(sceneText) → ParserUnit[]` на разных типах сцен (dialogue, narration, typography).
   - Тесты `injectChapterMarkers(text) → string` на ALL-CAPS headings без Глава/Chapter.
   - Тесты `detectLanguage(text) → string` на русском, английском, смешанных, пустых.

2. **Тесты порта structureDetector (если детектор остаётся в хосте):**
   - Contract-test: `realDetector.buildDeterministicMap(sourceText) → ParserResult.segments` через порт Parser.

3. **Тесты encoding-detect (если encoding-detect войдёт в Parser):**
   - Тесты декодирования разных кодировок (UTF-8, Windows-1251, KOI8-R) с golden-бинарниками.

4. **Тесты границ Parser:**
   - Parser не зависит от VBook runtime (кроме порта, если используется) — guard-тест на require-граф.
   - Parser не читает process.env — guard-тест.
   - Parser не знает layout книги / booksRoot (если pure) — guard-тест.

5. **Тесты контракта C13 (после написания контракта):**
   - Parser реализует C13 contract (parse, detectStructure, decodeText) — contract-sync test.

### 6.3 Какие тесты обязательно нужны для безопасного выделения

| Приоритет | Тест | Зачем |
|---|---|---|
| **P0** | Parser unit-тесты (parser.js: splitIntoChapters, splitIntoScenes, splitIntoUnits, detectLanguage, injectChapterMarkers) на golden-фичурах | Гарантия, что детерминированный парсер ведёт себя так же после переноса |
| **P0** | Structure-detector contract-test через порт Parser (если детектор в Parser или через порт) | Не-вакуuous тест, что детектор через порт Parser даёт ожидаемый результат |
| **P1** | Parser guard-тесты (только builtins + iconv-lite, если encoding-detect; нет process.env; нет VBook runtime requires) | Гарантия изоляции Parser |
| **P1** | Encoding-detect тесты (если в Parser) | Гарантия корректного декодирования |
| **P2** | C13 Parser contract test (после написания контракта) | Гарантия, что Parser реализует контракт |

**Оценка объёма тестов:** ~3-5 файлов, ~50-80 assertions для детерминированного слоя (золотые fixture'ы, edge cases, language detection). Structure-detector тесты (72 it-блока) могут быть перенесены или оставлены как contract-test.

---

## 7. Целевая структура будущего репозитория / пакета и минимальный публичный API

### 7.1 Целевая структура (предварительная, на уровне 1 — pure детерминированный парсер)

```
packages/animastor-parser/              (@animastor/parser, L3 — publishable, когда C13 готов)
├── package.json                        имя: @animastor/parser
│                                       version: 0.1.0 (pre-C13)
│                                       description: "Animastor Parser — deterministic text→structure
│                                           parsing + structure detection port (C13 parser/import contract
│                                           reference implementation)"
│                                       main: src/index.js
│                                       exports: { ".": "./src/index.js",
│                                           "./parser": "./src/parser.js",
│                                           "./structure-detector": "./src/structure-detector.js",
│                                           "./types": "./src/types.js" }
│                                       dependencies: { iconv-lite: "^...",
│                                           "@animastor/contracts": "workspace:*" }  ← когда C13 в contracts
│                                       devDependencies: { mocha, chai }
│                                       engines: { node: ">=18" }
│                                       files: ["src/", "schemas/*", "README.md", "LICENSE", "CHANGELOG.md"]
├── src/
│   ├── index.js                        exports: parseText, injectChapterMarkers,
│                                       splitIntoScenes, splitIntoUnits, detectLanguage,
│                                       StructureDetector (interface/policies)
│   ├── parser.js                       ← lazy-book/parser.js (adapted: remove lazyBook I/O?
│                                       или оставить I/O, если Parser владеет parse.js?)
│   ├── structure-detector.js           ← services/structure-detector.js (если в Parser)
│   ├── encoding-detect.js              ← services/encoding-detect.js (если в Parser)
│   ├── types.js                        ParserResult, ParserChapter, ParserSegment, StructureMap,
│                                       DecodedText, StructureDetector interface (TypeScript-дружелюбные)
│   └── constants.js                    parser-specific constants (パーサー固有の定数 — без BookState etc.)
├── schemas/                            C13 parser/import contract schema (когда C13 готов)
│   └── parser-contract.json            или contracts/
├── test/
│   ├── parser.test.js                  unit-тесты parseText, splitIntoScenes, splitIntoUnits,
│                                       detectLanguage, injectChapterMarkers
│   ├── structure-detector.test.js      перенесённые тесты детектора (72 it-блока)
│   ├── encoding-detect.test.js         тесты декодирования (если в Parser)
│   └── contract/
│       └── parser-contract.test.js     contract-sync тест C13 (когда C13 готов)
├── README.md                           responsibility, public API, consuming 예시 (importer, VBook)
├── CHANGELOG.md                        seeded;
└── LICENSE                             MIT
```

**Важное примечание по структуре:** пока C13 не готов, Parser находится на уровне 1 (internal package, workspace only). Публичный npm — только после C13 и contract-тестов (правило §21: "L2 precedes L3").

### 7.2 Минимальный публичный API (уровень 1 — pure детерминированный парсер)

```typescript
// @animastor/parser — public API surface (Pre-C13, pure text → structure)

/**
 * Parse source text into deterministic structure.
 * Pure function: no I/O, no AI, no config.
 */
export function parseText(sourceText: string): ParserResult;

/**
 * Inject [ГЛАВА: TITLE] markers into text for ALL-CAPS headings without
 * chapter keywords (classic Russian/European editions).
 */
export function injectChapterMarkers(text: string): string;

/**
 * Split a chapter's text into scenes by paragraph breaks / scene separators.
 */
export function splitIntoScenes(chapterText: string): string[];

/**
 * Split a scene's text into visual units (narration / dialogue / typography).
 */
export function splitIntoUnits(sceneText: string): ParserUnit[];

/**
 * Detect language of source text (ISO 639-1).
 */
export function detectLanguage(text: string): string;

/**
 * Structure detector interface (порт).
 * If Parser includes the reference implementation — it exposes the interface.
 * If Parser uses a host-provided detector — it consumes the interface.
 */
export interface StructureDetector {
  buildDeterministicMap(sourceText: string): StructureMap;
  extractCandidates(sourceText: string): CandidateResult;
  analyzeStructure(sourceText: string, aiResult: object): StructureMap;
  sanitizeStructure(aiResult: object, candidates: Candidate[], sourceText: string): object | null;
}

/**
 * Types (生産물의 형태)
 */
export interface ParserResult {
  title: string | null;
  author: string | null;
  language: string;
  hasPrologue: boolean;
  hasEpilogue: boolean;
  parts: { name: string; order: number }[];
  chapters: ParserChapter[];
  segments: ParserSegment[];
}

export interface ParserChapter { /* ... */ }
export interface ParserSegment { /* ... */ }
export interface StructureMap { /* ... */ }
export interface CandidateResult { /* ... */ }

// Encoded text result (если encoding-detect в Parser)
export interface DecodedText {
  text: string;
  encoding: string;
  label: string;
  warnings: string[];
}
```

### 7.3 Что Parser НЕ экспортирует (инкапсулировано)

- Не экспортирует функции I/O книги (`lazyParseNextWindow`, `lazyParseChapter`, `fs.writeFileSync` главам).
- Не экспортирует функции AI-пайплайна (`bootstrapWithAgent`, `stepAnalyzeStructure`).
- Не экспортирует функции импортной оркестровки (`decodeTxtBuffer`, `importTxtFile`, `bootstrapImportedText`).
- Не экспортирует функции валидации размера (`validateAiText` с config.TXT_MAX_SIZE).
- Не экспортирует book model типы (BookState, SceneStatus, SourceType, UnitType).
- Не экспортирует id generators (chapterId, sceneId, unitId, generateBookId).
- Не экспортирует book.json/manifest.json layout knowledge.

### 7.4 Что потребители Parser будут делать

- **Importer (txt-importer)** : `decodeTxtBuffer` (в importer) → `parseText(sourceText)` (Parser) → `createDraftBook(...)` + AI pipeline (в importer/agent) → запись книги (VBook runtime).
- **VBook runtime** : `splitIntoChapters` через Parser (если VBook использует Parser как детерминированный парсер) → `lazyParseNextWindow`/`lazyParseChapter` (в VBook) для I/O.
- **Structure detection** : `structureDetector` порт — либо реализация внутри Parser (B1), либо хостовый детектор, инжектированный в Parser (B2).

---

## 8. Дополнительные находки

### 8.1 Parser сегодня — это не "module", а "smeared responsibility"

Репозиторий не имеет единого "Parser" — есть:
- детерминированный парсер текста (уже в VBook runtime),
- детектор структуры (в хосте, чистый, но Placement C),
- AI-конвейер импорта (в хосте, зависит от провайдеров/PG/Redis),
- импортные роуты (в хосте, HTTP-слой),
- декодер текста (в хосте, зависит от iconv-lite).

### 8.2 Решение C из VBook аудита — это архитектурная граница, а не недостаток

Решение "structure-detector → порт, не в VBook" было принято осознанно: "Parser ≠ VBook", "LLM-merge path — импортная доктрина, а не формат". Если Parser (как будущий модуль) включит детектор, это **не нарушает** решение C — это **расширяет** его: Parser становится тем, куда детектор идёт, и VBook runtime зависит от Parser через порт. Но это требует **нового ADR**, а не автоматического следования.

### 8.3 C13 — blocking item для publishable Parser

Parser не может стать L3 publishable пакетом без C13 (parser/import contract), по правилам `MODULAR_PRODUCT_ARCHITECTURE.md` §21/§26: "L2 precedes L3. Nothing is published before its contract is written down and pinned by contract tests". Parser может быть внутренним модулем (L1) без C13, но публичным — только с контрактом.

### 8.4 Parser и VBook runtime — уже есть зависимость через порт

`lazy-book/parser.js:setStructureDetector/getStructureDetector` — это порт. Если Parser будет содержать реализацию детектора, VBook runtime зависит от Parser через этот порт (`require('@animastor/parser/structure-detector')` и `setStructureDetector(realDetector)`). Это **обратная зависимость по сравнению с текущим положением** (сегодня детектор в хосте, VBook runtime через порт получает детектор от хоста). Новая схема: VBook runtime ← Parser (детектор) через порт. Это допустимо, но должно быть осознанно принято.

### 8.5 Parser не должен становиться "всё, что импортирует книгу"

Риск: Parser забрать `txt-importer.js`, `agent/bootstrap.js`, импортные роуты — и стать "monolithic importer module". Это противоречит цели "чёткий API и минимальные зависимости". Parser должен оставаться **чистым парсером текста** (детерминированным + детектором структуры), а импортная оркестровка — в importer (отдельном модуле или хосте).

---

## 9. Итоговый вердикт

`lazy-book/parser.js:setStructureDetector/getStructureDetector` — это порт. Если Parser будет содержать реализацию детектора, VBook runtime зависит от Parser через этот порт (`require('@animastor/parser/structure-detector')` и `setStructureDetector(realDetector)`). Это **обратная зависимость по сравнению с текущим положением** (сегодня детектор в хосте, VBook runtime через порт получает детектор от хоста). Новая схема: VBook runtime ← Parser (детектор) через порт. Это допустимо, но должно быть осознанно принято.

### 8.5 Parser не должен становиться "всё, что импортирует книгу"

Риск: Parser забрать `txt-importer.js`, `agent/bootstrap.js`, импортные роуты — и стать "monolithic importer module". Это противоречит цели "чёткий API и минимальные зависимости". Parser должен оставаться **чистым парсером текста** (детерминированным + детектором структуры), а импортная оркестровка — в importer (отдельном модуле или хосте).

---

## 9. Итоговый вердикт

### Extraction candidate: CONDITIONAL

- **Детерминированный слой (pure text→structure):** YES — можно безопасно выделить.
- **Полный "Parser" (импорт + AI + I/O книги):** NO — не является модулем с минимальными зависимостями.
- **Publishable L3-модуль:** CONDITIONAL — только после C13 (parser/import contract); без контракта — только L1 internal.

| Вопрос | Ответ | Пояснение |
|---|---|---|
| Можно ли выделить парсер как модуль с чётким API? | **Да, для детерминированного слоя** (parseText, splitIntoScenes, splitIntoUnits, detectLanguage, injectChapterMarkers) | Это чистый JS, без хост-зависимостей (кроме порта структуры). |
| Можно ли выделить структурный детектор как часть Parser? | **Условно да** (новое решение, может отменить Placement C) | Если да — Parser становится reference implementation детектора; VBook runtime зависит от Parser через порт. Требует ADR. |
| Можно ли выделить импортную оркестровку (txt-importer, agent bootstrap) как Parser? | **Нет** | Это зависит от AI-провайдеров, PG, Redis, booksRoot. Это не парсер. |
| Можно ли выделить encoding-detect как часть Parser? | **Условно да** (если Parser владеет декодированием .txt) | Зависимость от iconv-lite; нормальная npm-зависимость. Но semantically — это decoder, не parser. |
| Безопасно ли выделить Parser сейчас, без C13? | **Нет (publishable)** | Без контракта Parser не может стать L3. Может быть L1 внутренним модулем, но публичным — только после C13. |
| Parser ≠ VBook — сохраняется ли это условие? | **Да, если Parser pure** | Если Parser владеет I/O книги (parse.js lazy-parse) — условие "Parser ≠ VBook" под вопросом. |

### Граница модуля (рекомендуемая, уровень 1 — pure детерминированный парсер)

**В Parser (чистый парсер текста):**
- `parseText(sourceText) → ParserResult` (splitIntoChapters + detectLanguage + injectChapterMarkers + структурная карта)
- `splitIntoScenes(chapterText) → string[]`
- `splitIntoUnits(sceneText) → ParserUnit[]`
- `injectChapterMarkers(text) → string`
- `detectLanguage(text) → string`
- Параметры типов: `ParserResult`, `ParserChapter`, `ParserSegment`, `StructureMap`, `StructureDetector` (интерфейс)

**Не в Parser (остаётся в VBook / хосте / agent domain):**
- I/O книги (lazyParseNextWindow, lazyParseChapter, fs.writeFileSync глав)
- AI-пайплайн (agent/bootstrap, pipeline-steps, pipeline-runner)
- Импортная оркестровка (txt-importer, decodeTxtBuffer, importTxtFile, bootstrapImportedText)
- Импортные роуты (HTTP-слой)
- Book Model (book-model.cjs, bundle-validator.cjs, book.json/manifest.json layout)
- ID generators (chapterId, sceneId, unitId, generateBookId)
- Config (TXT_MAX_SIZE)
- BooksRoot (порт VBook runtime)

**В Parser опционально (зависит от решения):**
- Structure-detector (детектор структуры) — если решено, что детектор идёт в Parser (новое ADR, может отменить Placement C)
- Encoding-detect (декодер текста) — если Parser владеет декодированием .txt

### Главные зависимости Parser (минимальный случай, pure)

| Зависимость | Тип | Примечание |
|---|---|---|
| `node builtins` (fs, path, crypto, buffers) | builtins | Только если Parser не делает I/O; если Parser pure — только buffers для encoding-detect (Buffer) |
| `iconv-lite` | npm | Только если encoding-detect в Parser |
| `@animastor/contracts` ( будущее ) | workspace/package | Когда C13 готов — типы контракта из contracts |
| Никаких других | — | Parser не зависит от VBook runtime, agent, PG, Redis, хост-конфига |

### Главные риски

| Риск | Степень | Комментарий |
|---|---|---|
| Граница Parser не определена однозначно | **Средний** | Нужно решить: включать parse.js (I/O)? детектор? encoding-detect? Это определяет зависимости. |
| Parser забирает parse.js (I/O книги) | **Средний** | Сдвигает ответственность VBook→Parser; нуждается в ADR. Рекомендуется: Parser pure, I/O в VBook. |
| Parser забирает детектор, отменяя Placement C | **Средний** | Требует ADR; Placement C было принято осознанно. Если Parser становится reference implementation детектора — это естественное развитие, но не автоматически. |
| C13 не написан → Parser не может быть publishable | **Высокий (блокирует L3)** | Нужен C13-first или C13-parallelly. Parser может быть L1 (internal) без C13. |
| API Parser не совпадает с будущим C13 | **Средний** | Parser API — превосхищение, пока C13 не создан. Нужно проектировать API так, чтобы оно ложилось на C13. |
| Parser слишком мал → нет смысла в отдельном пакете | **Средний (архитектурный)** | Если Parser = только parseText + splitIntoScenes + splitIntoUnits — это utils, а не модуль. Для "модульности" Parser должен включать больше (например, детектор структуры, encoding-detect, контракт). |

### Рекомендуемый следующий шаг

**Параллельно, без изменения production-кода:**

1. **Создать ADR "Parser Module — граница и содержание"** (docs/architecture/ADR-parser-module-boundary.md):
   - Что входит в Parser (pure text→structure: parseText, splitIntoScenes, splitIntoUnits, detectLanguage, injectChapterMarkers).
   - Что не входит (I/O книги, AI-пайплайн, импортная оркестровка, book model, id generators, config).
   - Решение про детектор: оставить в хосте как порт (Placement C) или перенести в Parser (новое решение).
   - Решение про encoding-detect: в Parser (если Parser владеет декодированием .txt) или в importer.

2. **Начать проектирование C13 (Parser/import contract)** (`docs/architecture/C13-parser-import-contract.md`, потом в `packages/contracts/`):
   - Формальные типы: ParserResult, ParserChapter, ParserSegment, StructureMap, DecodedText.
   - Функции: parse(sourceText), detectStructure(sourceText, llmResult?), decodeText(buffer).
   - Contract test (reference implementation in Parser, contract-sync test).

3. **Авторизовать тесты Parser (P0):**
   - Parser unit-тесты на golden-фичурах (parser.js: splitIntoChapters, splitIntoScenes, splitIntoUnits, detectLanguage, injectChapterMarkers).
   - Если детектор в Parser — перенести structure-detector.test.js (72 it-блока) как Parser tests.
   - Parser guard-тесты (only builtins + iconv-lite, if encoding-detect; no process.env; no VBook runtime requires).

4. **Параллельно Ongoing:** не менять production-код; не создавать пакет; только документация и тесты.

**После C13 + тесты + ADR:**
- Создать `packages/animastor-parser/` (L1, internal package, workspace only) с содержимым согласно ADR.
- Добавить Parser guard-тесты.
- Запустить architecture suite (npm run test:arch) — проверить, что Parser изолирован.
- Включить Parser как internal dependency в importer / VBook runtime (через порт структуры, если детектор в Parser).
- На уровне 2 → 3: когда C13 published в contracts, Parser становится L3 publishable.

---

## Appendix: проверки, выполненные во время аудита

- Полное чтение `backend/src/book/lazy-book/parser.js` (193 LOC, VBook runtime), `backend/src/book/lazy-book/parse.js` (249 LOC, VBook runtime), `backend/src/services/structure-detector.js` (1231 LOC, pure), `backend/src/services/txt-importer.js` (298 LOC), `backend/src/services/encoding-detect.js` (encoding detection + iconv-lite), `backend/src/routes/book/parse-routes.cjs`, `backend/src/routes/book/import-routes.cjs`, `backend/src/routes/book/status-routes.cjs`, `backend/src/services/agent/bootstrap.js`, `backend/src/services/agent/pipeline-steps.js` (поиск LLM-анализа структуры).
- Полное чтение `packages/animastor-vbook-runtime/src/lazy-book/parser.js`, `packages/animastor-vbook-runtime/src/lazy-book/parse.js`, `packages/animastor-vbook-runtime/src/lazy-book/index.js`, `packages/animastor-vbook-runtime/package.json` (VBook runtime exports, dependencies = adm-zip + tinyld).
- Чтение VBook Extraction Readiness Audit (§2.6 — детектор Placement C; §1 — require-граф VBook; §4.2 — C1 JSON Schema pending; §7 — циклы; §8 — план извлечения) и `VBOOK_RUNTIME_RELOCATION_CHECKLIST.md` (COMPLETE — физическое перемещение landed).
- Чтение `MODULAR_PRODUCT_ARCHITECTURE.md` §8 (Parser/Import definition, Parser ≠ VBook), §24 (C13 = missing), §21/§26 (уровни модульности, graduation checklist: L2 precedes L3).
- Чтение `MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE.md` §1 (Parser/Import inventory: parser.js, parse.js, create.js, structure-detector.js, txt-importer.js, encoding-detect.js, language-detector.js, agent/*).
- Чтение `PLUGIN_EXTENSION_ARCHITECTURE.md` (Parser как планируемый плагин, C13 prerequisite).
- Чтение `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` (очередь модулей, Parser/Import — #2).
- Чтение `docs/editor-module-extraction-audit.md` (формат аудита-образец: READ-ONLY reconnaissance, без изменения production-кода, граница модуля, зависимости, сложность, тесты, целевая структура, краткий итог).
- Поиск тестов: `structure-detector.test.js` (72 it-блоков), `bundle-validator` тесты (ai-patch-validation.test.js, ai-participants-doctrine.test.js), архитектурные guard-тесты (VB-T1..T5, phase2/4/6/7, dependency-guardrails).
- Search по require-графу: `txtImporter` используется в `routes/book/parse-routes.cjs`, `routes/book/import-routes.cjs`, `routes/book/status-routes.cjs`, `routes/book/generation-routes.cjs`, `routes/agent-routes.cjs`, `services/window-generator.cjs`, `backend.cjs`; `lazyBook` используется аналогично; `structure-detector` используется в `pipeline-steps.js:stepAnalyzeStructure` и `bootstrap.js`.

Никакие production-файлы не изменены. Никакие пакеты не созданы. Никакие рефакторинги не выполнены.

---

### Краткий итог

| Вопрос | Ответ |
|---|---|
| Extraction candidate: детерминированный слой | **YES** — pure text→structure, без хост-зависимостей (кроме порта структуры) |
| Extraction candidate: полный "Parser" (импорт + AI + I/O) | **NO** — не модуль с минимальными зависимостями |
| Extraction candidate: publishable L3 | **CONDITIONAL** — только после C13 (parser/import contract); без контракта — L1 internal |
| Complexity | **Medium** — чистый слой = Low; определение границ + C13 + Placement детектора = Medium |
| Предполагаемая граница (рекомендация, уровень 1) | Parser = pure детерминированный парсер текста (parseText, splitIntoScenes, splitIntoUnits, detectLanguage, injectChapterMarkers) + типы (ParserResult, ParserChapter, ParserSegment, StructureMap, StructureDetector). Опционально: структурный детектор + encoding-detect (зависит от ADR). Не в Parser: I/O книги, AI-пайплайн, импортная оркестровка, book model, id generators, config, booksRoot. |
| Главные зависимости (минимальный случай) | node builtins (только buffers, если encoding-detect); iconv-lite (если encoding-detect в Parser); @animastor/contracts (будущее, после C13). Никаких VBook runtime, agent, PG, Redis, хост-конфига. |
| Главные риски | (1) граница не определена однозначно — нужно ADR; (2) C13 не написан — Parser не может быть publishable L3; (3) Parser забирает parse.js (I/O книги) — противоречит "Parser ≠ VBook" если не осторожно; (4) Parser забирает детектор — требует нового ADR (Placement C); (5) API Parser не совпадает с будущим C13 — превосхищение. |
| Рекомендуемый следующий шаг | Создать ADR "Parser Module — граница и содержание" (docs/architecture/ADR-parser-module-boundary.md), начать проектирование C13 (Parser/import contract), авторизовать P0 тесты Parser (golden-фичуры для parseText/splitIntoScenes/splitIntoUnits/detectLanguage/injectChapterMarkers), не менять production-код, не создавать пакет — только документация + тесты. |

---

**Отчёт о проделанной работе:**

Проверено:
- Все parser-с ним связанные файлы: `lazy-book/parser.js`, `lazy-book/parse.js`, `services/structure-detector.js`, `services/txt-importer.js`, `services/encoding-detect.js`, `routes/book/parse-routes.cjs`, `routes/book/import-routes.cjs`, `routes/book/status-routes.cjs`, `services/agent/bootstrap.js`, `services/agent/pipeline-steps.js`, VBook runtime package (`packages/animastor-vbook-runtime/src/lazy-book/*`, `package.json`).
- Зависимости: require-граф, потребители, порты, скрытые зависимости.
- Архитектурные документы: `MODULAR_PRODUCT_ARCHITECTURE.md` (§8 Parser ≠ VBook, §24 C13 = missing), `MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE.md` (§1 Parser/Import inventory), `PLUGIN_EXTENSION_ARCHITECTURE.md` (Parser как планируемый плагин, C13 prerequisite), `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` (очередь модулей, Parser/Import — #2), `VBOOK_EXTRACTION_READINESS_AUDIT.md` (§2.6 Placement C детектора, §1 require-граф, §4.2 C1 JSON Schema pending, §7 циклы, §8 план).
- Тесты: `structure-detector.test.js` (72 it-блока), `bundle-validator` тесты, архитектурные guard-тесты.

Вывод: репозиторий не имеет единого "Parser" — есть детерминированный парсер текста (уже в VBook runtime), структурный детектор (в хосте, чистый, Placement C), AI-конвейер импорта (в хосте, зависит от провайдеров/PG/Redis), импортные роуты (HTTP-слой), декодер текста (в хосте, iconv-lite). Parser можно выделить как модуль только для детерминированного слоя (pure text→structure) — это Low к сложности, но Medium из-за неопределённости границ и отсутствия C13 (блокирует publishable L3).

Результат записан в `docs/parser-module-extraction-audit.md`. Никакие production-файлы не изменены, никакие пакеты не созданы, никакие рефакторинги не выполнены — это архитектурная разведка перед extraction, как и запрошено.

Commit:`parser-extraction-audit`
